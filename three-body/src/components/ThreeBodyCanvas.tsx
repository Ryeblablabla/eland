import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createDistantSkyLayer } from '@/game/distantSky';
import { makePlanetTextureSet, makeStarSurfaceTexture } from '@/game/proceduralTextures';
import { bakeProceduralGalaxy } from '@/game/proceduralGalaxy';
import {
  DEFAULT_PRESET,
  N_BODIES,
  N_STARS,
  PLANET_IDX,
  PLANET_STYLE,
  PRESETS,
  STAR_STYLES,
  createSystem,
  makeTwin,
  maxRadiusFromCOM,
  maxSeparation,
  placePlanet,
  planetStatus,
  rk4Step,
  stellarFlux,
  totalEnergy,
  type PlanetFate,
  type SimSystem,
} from '@/lib/threebody';
import type { CosmosSnapshot } from '@/game/societyContract';
import { PinchTransitionGesture } from '@/game/pinch-transition-gesture';

export interface SimStats {
  resetToken: number;
  t: number;
  energy: number;
  separation: number | null;
  planetFate: PlanetFate;
  planetDist: number;
  fluxRel: number;      // 恒星光度通量 / 宜居基线（>1.8 酷暑，<0.45 严寒）
  collapsed: 'burned' | 'frozen' | 'extinct' | null; // 文明崩塌待结算
  civilizations: number;
  bodies: number[];     // [x0,y0, x1,y1, x2,y2, 行星x,行星y] 世界坐标快照（画中画用）
  spread: number;       // 恒星离质心最大距离（画中画取景半径）
  cosmosSnapshot: CosmosSnapshot;
}

export type CelestialSelection =
  | { kind: 'star'; index: number }
  | { kind: 'planet' }
  | null;

interface Props {
  running: boolean;
  speed: number;
  trailLength: number;
  showTwin: boolean;
  presetKey: string;
  resetToken: number;
  /** 后端分配的权威文明编号；宇宙层只负责检测下一次重生。 */
  civilizationId?: number;
  restoreSnapshot?: CosmosSnapshot | null;
  targetT?: number; // 权威目标时刻（人间纪年换算）；设置后宇宙向该时刻平滑快进
  skyMode?: 'follow' | 'frozen'; // frozen：完全冻结（人间视角懒加载）
  collapseHold?: boolean;  // 文明毁灭时冻结宇宙，等待结算
  respawnToken?: number;   // 自增 = 结算完毕，新文明启程
  onStats?: (s: SimStats) => void;
  planetFocusEnabled?: boolean;              // 允许向内滚动自动聚焦行星
  onPlanetFocusChange?: (focused: boolean) => void;
  onPlanetDive?: () => void;                 // 聚焦后继续滚轮或双指放大越过阈值 → 请求俯冲进入人间
  exitFocusToken?: number;                   // 自增 = 退出聚焦，相机回星系质心
  selectedCelestial?: CelestialSelection;
  onSelectCelestial?: (selection: CelestialSelection) => void;
}

const DT = 0.001;
const MAX_TRAIL = 4096; // 轨迹缓冲上限（UI 滑杆最大 3000）
const STARFIELD_COUNT = 1500;

function freshUniverseRandomState(): number {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] || 0x6d2b79f5;
}

function nextUniverseRandom(state: { randomState: number }): number {
  let value = state.randomState >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.randomState = value >>> 0 || 0x6d2b79f5;
  return state.randomState / 0x1_0000_0000;
}

// ---------------------------------------------------------------------------
// 纹理工厂（与原 2D 版同款径向渐变，但输出 WebGL 纹理）
// ---------------------------------------------------------------------------

function makeGlowTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  // 中心留空给实体星球表面，外侧才出现柔和日冕。
  grad.addColorStop(0, color + '00');
  grad.addColorStop(0.28, color + '00');
  grad.addColorStop(0.38, color + 'aa');
  grad.addColorStop(0.6, color + '33');
  grad.addColorStop(1, color + '00');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(c);
  // Canvas 颜色来自 CSS 色值，本身已是 sRGB；不标记会被 OutputPass 再提亮一次。
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface DisposableObject {
  isMesh?: boolean;
  isLine?: boolean;
  isPoints?: boolean;
  isSprite?: boolean;
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material & { map?: THREE.Texture | null };
}

function disposeScene(scene: THREE.Scene, composer: EffectComposer, renderer: THREE.WebGLRenderer) {
  scene.traverse((obj) => {
    const d = obj as unknown as DisposableObject;
    d.geometry?.dispose();
    if (d.material) {
      d.material.map?.dispose();
      d.material.dispose();
    }
  });
  composer.dispose();
  renderer.dispose();
}

export default function ThreeBodyCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  // 每轮渲染后同步最新 props 给 RAF 主循环（避免渲染期写 ref）
  useEffect(() => {
    propsRef.current = props;
  });

  const world = useRef<{
    sys: SimSystem;
    twin: SimSystem;
    trails: number[][];
    twinTrails: number[][];
    t: number;
    viewR: number;
    frame: number;
    civilizations: number;
    extinct: boolean; // 星系崩解，文明终结（不再复活）
    pendingCollapse: 'burned' | 'frozen' | 'extinct' | null; // 崩塌待结算（宇宙冻结中）
    seenRespawnToken: number;
    randomState: number;
    respawnSequence: number;
    fluxBase: number; // 宜居基线通量
    planetR: number;
  } | null>(null);

  // 初始化 / 重置
  useEffect(() => {
    const preset = PRESETS.find((p) => p.key === props.presetKey) ?? DEFAULT_PRESET;
    const restored = propsRef.current.restoreSnapshot;
    const canRestore = restored
      && restored.schemaVersion === 1
      && restored.presetKey === preset.key
      && restored.state.length === 16
      && restored.masses.length === 4
      && Number.isInteger(restored.randomState)
      && Number.isInteger(restored.respawnSequence);
    const snapshot = canRestore ? restored : null;
    const random = { randomState: snapshot?.randomState ?? freshUniverseRandomState() };
    const requestedCivilizationId = propsRef.current.civilizationId;
    const authoritativeCivilizationId = typeof requestedCivilizationId === 'number'
      && Number.isInteger(requestedCivilizationId)
      && requestedCivilizationId > 0
      ? requestedCivilizationId
      : 1;
    const sys = snapshot
      ? { state: Float64Array.from(snapshot.state), masses: Float64Array.from(snapshot.masses) }
      : createSystem(preset, () => nextUniverseRandom(random));
    const twin = makeTwin(sys);
    // 宜居基线：行星在初始轨道半径上接收宿主恒星（最大质量）的通量
    const hostMass = Math.max(...preset.masses);
    world.current = {
      sys,
      twin,
      trails: Array.from({ length: N_BODIES }, () => []),
      twinTrails: Array.from({ length: N_BODIES }, () => []),
      t: snapshot?.t ?? 0,
      viewR: snapshot?.viewR ?? 2.2,
      frame: 0,
      civilizations: snapshot?.civilizations ?? authoritativeCivilizationId,
      extinct: snapshot?.extinct ?? false,
      pendingCollapse: snapshot?.pendingCollapse ?? null,
      seenRespawnToken: props.respawnToken ?? 0,
      randomState: random.randomState,
      respawnSequence: snapshot?.respawnSequence ?? 0,
      fluxBase: snapshot?.fluxBase ?? Math.pow(hostMass, 3.5) / (preset.planetR * preset.planetR),
      planetR: snapshot?.planetR ?? preset.planetR,
    };
  }, [props.presetKey, props.resetToken]);

  // 编号由后端的持久化序列分配。Canvas 中的自增只发出“文明更替”信号，
  // 收到新权威帧后必须回写实际编号（其他标签页可能已占用中间号码）。
  useEffect(() => {
    const civilizationId = props.civilizationId;
    if (!world.current
      || typeof civilizationId !== 'number'
      || !Number.isInteger(civilizationId)
      || civilizationId < 1) return;
    world.current.civilizations = civilizationId;
  }, [props.civilizationId]);

  // 主循环（three.js 场景）
  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor('#02030a'); // 与 2D 版边缘底色一致，保持深空近黑

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
    camera.position.set(0, 0, 3);

    // 可交互视角：拖拽旋转 / 滚轮缩放（不平移，永远围绕星系质心）
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    canvas.style.touchAction = 'none';
    // 用户拖拽期间及松手后 4 秒内由用户接管，之后恢复自动取景
    let manualUntil = 0;
    controls.addEventListener('start', () => { manualUntil = Infinity; });
    controls.addEventListener('end', () => { manualUntil = performance.now() + 4000; });

    // ---- 行星聚焦：向内滚动 → 相机自动聚焦行星；继续放大 → 俯冲进入人间 ----
    const focus = {
      active: false,      // 聚焦中
      planetR: 0.05,      // 行星视觉半径（聚焦时从等效像素大小平滑实体化）
      lastWheelIn: -1e9,  // 最近一次"放大"滚轮时间
      diveHold: 0,        // 在阈值内持续停留的时长
      dove: false,        // 已发起俯冲（本次聚焦只触发一次）
      justActivated: false, // 本帧刚进入聚焦（行星半径从等效像素起步）
      seenExitToken: -1,
      screenX: 0, screenY: 0, screenR: 0, hasScreen: false, // 行星屏幕圆（点击/双击命中用）
    };
    const planetVec = new THREE.Vector3();
    const projVec = new THREE.Vector3();
    const originVec = new THREE.Vector3(0, 0, 0);
    const bodyScreens = Array.from({ length: N_BODIES }, () => ({ x: 0, y: 0, r: 0, visible: false }));
    // 调试探针挂载点（window.__tbPlanet / __tbDebug）
    const dbgPlanet = ((window as unknown as { __tbPlanet?: { x: number; y: number } }).__tbPlanet ??=
      { x: 0, y: 0 });
    const dbg = ((window as unknown as { __tbDebug?: Record<string, unknown> }).__tbDebug ??= {});
    const divePinch = new PinchTransitionGesture('zoom-in');
    let canvasDown: { x: number; y: number } | null = null;
    const onFocusPointerDown = (ev: PointerEvent) => { canvasDown = { x: ev.clientX, y: ev.clientY }; };
    const onFocusPointerUp = (ev: PointerEvent) => {
      if (ev.pointerType === 'touch' && divePinch.consumeTapSuppression(ev.pointerId)) {
        canvasDown = null;
        return;
      }
      if (!canvasDown || Math.hypot(ev.clientX - canvasDown.x, ev.clientY - canvasDown.y) >= 5) { canvasDown = null; return; }
      canvasDown = null;
      const p = propsRef.current;
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const hit = bodyScreens
        .map((screen, index) => ({ index, screen, distance: Math.hypot(mx - screen.x, my - screen.y) }))
        .filter(({ screen, distance }) => screen.visible && distance <= screen.r)
        .sort((left, right) => left.distance - right.distance)[0];
      if (!hit) {
        p.onSelectCelestial?.(null);
        return;
      }
      if (hit.index < N_STARS) {
        p.onSelectCelestial?.({ kind: 'star', index: hit.index });
        return;
      }
      p.onSelectCelestial?.({ kind: 'planet' });
      if (p.planetFocusEnabled && !focus.active) {
        focus.active = true;
        focus.dove = false;
        focus.diveHold = 0;
        focus.justActivated = true;
        p.onPlanetFocusChange?.(true);
      }
    };
    const onFocusDblClick = (ev: MouseEvent) => {
      const p = propsRef.current;
      if (!p.planetFocusEnabled || !focus.hasScreen) return;
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const hitPlanet = Math.hypot(mx - focus.screenX, my - focus.screenY) <= Math.max(30, focus.screenR + 8);
      if (hitPlanet) {
        p.onSelectCelestial?.({ kind: 'planet' });
        if (!focus.active) {
          focus.active = true;
          focus.justActivated = true;
          p.onPlanetFocusChange?.(true);
        }
        focus.dove = true;
        focus.diveHold = 0;
        p.onPlanetDive?.();
      } else if (focus.active) {
        focus.active = false;
        focus.dove = false;
        p.onPlanetFocusChange?.(false);
      }
    };
    const onFocusWheel = (ev: WheelEvent) => {
      if (ev.deltaY >= 0) return;
      focus.lastWheelIn = performance.now();
      const p = propsRef.current;
      if (p.planetFocusEnabled && !focus.active) {
        focus.active = true;
        focus.dove = false;
        focus.diveHold = 0;
        focus.justActivated = true;
        p.onPlanetFocusChange?.(true);
      }
    };
    const onDivePinchPointerDown = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      divePinch.pointerDown(ev.pointerId, ev.clientX, ev.clientY);
    };
    const onDivePinchPointerMove = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      const update = divePinch.pointerMove(ev.pointerId, ev.clientX, ev.clientY);
      const p = propsRef.current;
      if (!p.planetFocusEnabled || update.progress <= 0) return;

      focus.lastWheelIn = performance.now();
      if (!focus.active) {
        focus.active = true;
        focus.dove = false;
        focus.diveHold = 0;
        focus.justActivated = true;
        p.onPlanetFocusChange?.(true);
      }
      if (update.triggered && !focus.dove) {
        focus.dove = true;
        focus.diveHold = 0;
        p.onPlanetDive?.();
      }
    };
    const onDivePinchPointerUp = (ev: PointerEvent) => {
      if (ev.pointerType === 'touch') divePinch.pointerUp(ev.pointerId);
    };
    const onDivePinchPointerCancel = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      divePinch.pointerCancel(ev.pointerId);
      divePinch.consumeTapSuppression(ev.pointerId);
      canvasDown = null;
    };
    canvas.addEventListener('pointerdown', onDivePinchPointerDown);
    canvas.addEventListener('pointermove', onDivePinchPointerMove);
    canvas.addEventListener('pointerup', onDivePinchPointerUp);
    canvas.addEventListener('pointercancel', onDivePinchPointerCancel);
    canvas.addEventListener('pointerdown', onFocusPointerDown);
    canvas.addEventListener('pointerup', onFocusPointerUp);
    canvas.addEventListener('dblclick', onFocusDblClick);
    canvas.addEventListener('wheel', onFocusWheel, { passive: true });

    // 后处理：MSAA 渲染目标 + 泛光 + 色彩输出
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(renderer, renderTarget);
    composer.addPass(new RenderPass(scene, camera));
    // 泛光只托起表面最亮的热点，保留清晰星芯，不再用大半径柔光吞掉纹理。
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.48, 0.22, 0.72);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ---- 背景层：一次烘焙的程序化银河 + 清晰星野 ----
    const galaxyTarget = bakeProceduralGalaxy(renderer);
    scene.background = galaxyTarget.texture;
    scene.backgroundIntensity = 0.88;
    scene.backgroundRotation.set(0.08, -0.42, 0.12);
    const distantSky = createDistantSkyLayer({ mode: 'universe', radius: 820, renderOrder: -9 });
    distantSky.group.rotation.copy(scene.backgroundRotation);
    scene.add(distantSky.group);

    const starfieldGeo = new THREE.BufferGeometry();
    {
      const positions = new Float32Array(STARFIELD_COUNT * 3);
      const colors = new Float32Array(STARFIELD_COUNT * 3);
      const cCool = new THREE.Color('#cdd8ff');
      const cWarm = new THREE.Color('#ffe9c9');
      for (let i = 0; i < STARFIELD_COUNT; i++) {
        // 完整球壳均匀分布 × 半径 900~2000（远超最大缩放距离，永不穿出）
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const r = 900 + Math.random() * 1100;
        const s = Math.sqrt(1 - u * u);
        positions[i * 3] = r * s * Math.cos(th);
        positions[i * 3 + 1] = r * s * Math.sin(th);
        positions[i * 3 + 2] = r * u;
        const base = Math.random() < 0.85 ? cCool : cWarm;
        const a = 0.15 + Math.random() * 0.6;
        colors[i * 3] = base.r * a;
        colors[i * 3 + 1] = base.g * a;
        colors[i * 3 + 2] = base.b * a;
      }
      starfieldGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      starfieldGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    const starfield = new THREE.Points(
      starfieldGeo,
      new THREE.PointsMaterial({
        size: 1.5,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    starfield.renderOrder = -8;
    scene.add(starfield);

    // ---- 恒星：等离子表面球芯（缓慢自转）+ 加法混合辉光 ----
    const starCores: THREE.Mesh[] = [];
    const starGlows: THREE.Sprite[] = [];
    const starSpins = [0.09, 0.06, -0.11]; // rad/s：三颗星转速各异，比邻星反向
    for (let i = 0; i < N_STARS; i++) {
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 24),
        new THREE.MeshBasicMaterial({
          map: makeStarSurfaceTexture(STAR_STYLES[i].core, STAR_STYLES[i].glow, 1000 + i * 77),
          // 保留表面明暗层次；最热纹理区域自身即可越过 bloom 阈值。
          color: new THREE.Color(0.92, 0.92, 0.92),
          // 与日冕进入同一透明排序队列，随后用不透明纹理覆盖日冕中心。
          transparent: true,
        }),
      );
      core.renderOrder = 3;
      scene.add(core);
      starCores.push(core);

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: makeGlowTexture(STAR_STYLES[i].glow),
          transparent: true,
          blending: THREE.AdditiveBlending,
          opacity: 0.52,
          depthWrite: false,
          depthTest: false,
        }),
      );
      glow.renderOrder = 2;
      scene.add(glow);
      starGlows.push(glow);
    }

    // ---- 行星：不发光，只反射星光（地球式：受光球芯 + 海面高光 + 独立云层 + 大气边缘光）----
    // 高光参数按"近距离聚焦观看"标定：窄而弱（隔离台实证：大高光团会洗掉昼面）
    const planetTex = makePlanetTextureSet(4242);
    const planetCore = new THREE.Mesh(
      new THREE.SphereGeometry(1, 28, 20),
      new THREE.MeshPhongMaterial({
        map: planetTex.day,
        specularMap: planetTex.spec, // 海面反射星光
        specular: new THREE.Color('#24333b'),
        shininess: 60,
        // 电影化夜面最低可见度：沿用昼面纹理，避免背光相位退化成纯黑圆球。
        emissive: new THREE.Color('#ffffff'),
        emissiveMap: planetTex.day,
        emissiveIntensity: 0.22,
        // 深空幕布也参与渲染排序；放入透明队列，确保地表不会被远景覆盖。
        transparent: true,
      }),
    );
    planetCore.rotation.x = 0.15; // 轻微轴倾
    planetCore.renderOrder = 4;
    scene.add(planetCore);
    // 独立云层：略大一圈、与地表差速自转（薄云，不遮地表）
    const planetClouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 28, 20),
      new THREE.MeshPhongMaterial({
        map: planetTex.clouds,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    );
    planetClouds.rotation.x = 0.15;
    planetClouds.renderOrder = 5;
    scene.add(planetClouds);
    // 大气：菲涅尔 rim，只有轮廓一圈发亮（加法混合，不触发 bloom）；
    // 迎光面亮、背光面暗（uSunDir 每帧指向当前通量最强的恒星）
    const atmosphereMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PLANET_STYLE.glow) },
        uPower: { value: 3.8 }, // 更紧的 rim：放大时不至于糊住昼面
        uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      },
      vertexShader: `
        varying vec3 vNormalW;
        varying vec3 vWorldPos;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uPower;
        uniform vec3 uSunDir;
        varying vec3 vNormalW;
        varying vec3 vWorldPos;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float rim = pow(1.0 - max(dot(viewDir, normalize(vNormalW)), 0.0), uPower);
          float day = max(dot(normalize(vNormalW), uSunDir), 0.0);
          rim *= 0.25 + 0.75 * day;
          gl_FragColor = vec4(uColor * rim, rim);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.14, 32, 24),
      atmosphereMat,
    );
    atmosphere.renderOrder = 6;
    scene.add(atmosphere);
    // 调试探针：图层隔离截图（无头调试脚本用）
    dbg.planetCore = planetCore;
    dbg.planetClouds = planetClouds;
    dbg.atmosphere = atmosphere;

    // ---- 恒星光照：方向实时从恒星指向行星，强度 ∝ 质量^3.5（主序星光度比）----
    const starLights: THREE.DirectionalLight[] = [];
    for (let i = 0; i < N_STARS; i++) {
      const l = new THREE.DirectionalLight(STAR_STYLES[i].core, 1);
      l.target = planetCore;
      scene.add(l);
      starLights.push(l);
    }
    // 冷色弱补光只影响行星/云层等受光材质；恒星使用 MeshBasicMaterial，不会被一并抬亮。
    scene.add(new THREE.AmbientLight('#b8c8d8', 0.42));

    // ---- 孪生系统恒星：空心小圈 ----
    const twinRings: THREE.Mesh[] = [];
    for (let i = 0; i < N_STARS; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 1, 32),
        new THREE.MeshBasicMaterial({
          color: STAR_STYLES[i].glow,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      scene.add(ring);
      twinRings.push(ring);
    }

    // ---- 轨迹：预分配缓冲的 Line，顶点色渐隐（加法混合下黑色即不可见）----
    const makeTrailLine = (hex: string) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      line.renderOrder = 1;
      line.frustumCulled = false; // 缓冲恒定，包围盒无意义
      scene.add(line);
      return { line, color: new THREE.Color(hex) };
    };
    const starTrails = STAR_STYLES.map((s) => makeTrailLine(s.trail));
    const planetTrail = makeTrailLine(PLANET_STYLE.trail);
    const twinTrails = STAR_STYLES.map((s) => makeTrailLine(s.trail));
    const trailLineOf = (i: number) => (i === PLANET_IDX ? planetTrail : starTrails[i]);

    const writeTrail = (
      target: { line: THREE.Line; color: THREE.Color },
      pts: number[],
      alphaScale: number,
    ) => {
      const total = pts.length / 2;
      const n = Math.min(total, MAX_TRAIL);
      const geo = target.line.geometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const col = geo.getAttribute('color') as THREE.BufferAttribute;
      const pa = pos.array as Float32Array;
      const ca = col.array as Float32Array;
      const offset = total - n; // 只取最新 n 点
      const { r, g, b } = target.color;
      for (let i = 0; i < n; i++) {
        pa[i * 3] = pts[(offset + i) * 2];
        pa[i * 3 + 1] = pts[(offset + i) * 2 + 1];
        pa[i * 3 + 2] = 0;
        const a = Math.pow((i + 1) / n, 1.6) * 0.85 * alphaScale;
        ca[i * 3] = r * a;
        ca[i * 3 + 1] = g * a;
        ca[i * 3 + 2] = b * a;
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      geo.setDrawRange(0, n);
    };

    let W = 0, H = 0, dpr = 1;
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      renderer.setPixelRatio(dpr);
      renderer.setSize(W, H, false);
      composer.setPixelRatio(dpr);
      composer.setSize(W, H);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    resize();

    let lastNow = performance.now();
    let raf = 0;

    const tick = () => {
      raf = 0;
      if (document.hidden) return;
      raf = requestAnimationFrame(tick);
      const w = world.current;
      if (!w) return;
      const p = propsRef.current;
      const now = performance.now();
      const frameDt = Math.min((now - lastNow) / 1000, 0.1); // 秒
      lastNow = now;

      // ---- 物理推进：缓动追帧 ----
      // targetT 模式：差距越大追得越快（平滑加速）；可见时追平后转入极慢的环境漂移；
      // 冻结（人间视角懒加载）时静默追帧、跳过渲染
      const frozen = p.skyMode === 'frozen';

      // 结算握手：物理灾变后重置行星；人间自行灭亡时只更替文明
      if ((p.respawnToken ?? 0) !== w.seenRespawnToken) {
        w.seenRespawnToken = p.respawnToken ?? 0;
        if (w.pendingCollapse === 'extinct') return;
        if (w.pendingCollapse) {
          placePlanet(w.sys, w.planetR, () => nextUniverseRandom(w));
          placePlanet(w.twin, w.planetR, () => nextUniverseRandom(w));
          w.respawnSequence += 1;
          w.trails[PLANET_IDX].length = 0;
          w.twinTrails[PLANET_IDX].length = 0;
        }
        w.civilizations++;
        w.pendingCollapse = null;
      }

      if (p.running && !w.pendingCollapse) {
        let steps: number;
        if (p.targetT !== undefined) {
          const gap = p.targetT - w.t;
          const rate = frozen
            ? Math.min(Math.max(gap * 1.2, 0), 1.2)
            : Math.min(Math.max(gap * 0.7, 0.05), 1.6); // t.u./s：追平后 0.05 慢漂
          steps = Math.min(Math.max(0, Math.round(rate * frameDt / DT)), 120);
        } else {
          steps = Math.max(1, Math.round(p.speed * 6));
        }
        for (let k = 0; k < steps; k++) {
          rk4Step(w.sys, DT);
          if (p.showTwin) rk4Step(w.twin, DT);
        }
        w.t += steps * DT;

        // 行星命运检查：焚毁 / 冻结 → 文明毁灭；
        // collapseHold 模式下冻结宇宙等待结算，由 respawnToken 握手复活
        if (!w.extinct) {
          const fate = planetStatus(w.sys).fate;
          if (fate === 'burned' || fate === 'frozen') {
            if (maxRadiusFromCOM(w.sys) > 10) {
              w.extinct = true;
              if (p.collapseHold) w.pendingCollapse = 'extinct';
            } else if (p.collapseHold) {
              w.pendingCollapse = fate;
            } else {
              placePlanet(w.sys, w.planetR, () => nextUniverseRandom(w));
              placePlanet(w.twin, w.planetR, () => nextUniverseRandom(w));
              w.respawnSequence += 1;
              w.civilizations++;
              w.trails[PLANET_IDX].length = 0;
              w.twinTrails[PLANET_IDX].length = 0;
            }
          }
        }

        for (let i = 0; i < N_BODIES; i++) {
          const tr = w.trails[i];
          tr.push(w.sys.state[i * 2], w.sys.state[i * 2 + 1]);
          if (tr.length / 2 > p.trailLength) tr.splice(0, tr.length - p.trailLength * 2);
          if (p.showTwin) {
            const tt = w.twinTrails[i];
            tt.push(w.twin.state[i * 2], w.twin.state[i * 2 + 1]);
            if (tt.length / 2 > p.trailLength) tt.splice(0, tt.length - p.trailLength * 2);
          }
        }
      } else if (w.trails[0].length === 0) {
        for (let i = 0; i < N_BODIES; i++) {
          w.trails[i].push(w.sys.state[i * 2], w.sys.state[i * 2 + 1]);
        }
      }

      // ---- 统计回调（节流）----
      w.frame++;
      if (p.onStats && w.frame % 12 === 0) {
        const ps = planetStatus(w.sys);
        p.onStats({
          resetToken: p.resetToken,
          t: w.t,
          energy: totalEnergy(w.sys),
          separation: p.showTwin ? maxSeparation(w.sys, w.twin) : null,
          planetFate: w.extinct ? 'extinct' : ps.fate,
          planetDist: ps.nearestDist,
          fluxRel: stellarFlux(w.sys) / w.fluxBase,
          collapsed: w.pendingCollapse,
          civilizations: w.civilizations,
          bodies: Array.from(w.sys.state.slice(0, 8)), // x0,y0,x1,y1,x2,y2,px,py
          spread: maxRadiusFromCOM(w.sys),
          cosmosSnapshot: {
            schemaVersion: 1,
            presetKey: p.presetKey,
            state: Array.from(w.sys.state),
            masses: Array.from(w.sys.masses),
            randomState: w.randomState,
            respawnSequence: w.respawnSequence,
            t: w.t,
            viewR: w.viewR,
            civilizations: w.civilizations,
            extinct: w.extinct,
            pendingCollapse: w.pendingCollapse,
            fluxBase: w.fluxBase,
            planetR: w.planetR,
          },
        });
      }

      // 冻结模式：物理与上报照常，渲染整体跳过
      if (frozen) return;

      // ---- 视野自适应（只跟随恒星）----
      const targetR = Math.min(Math.max(maxRadiusFromCOM(w.sys) * 1.3, 1.7), 40);
      w.viewR += (targetR - w.viewR) * 0.03;

      // ---- 相机：可交互视角 + 行星聚焦 ----
      // 聚焦中：轨道中心跟随行星，行星实体化放大，滚轮越过阈值触发俯冲；
      // 手动模式（拖拽中及松手后 4 秒）：OrbitControls 全权接管；
      // 自动模式：约 22° 俯视 + 缓慢漂移，保持 3D 纵深感
      const fit = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, W / H);
      const dist = w.viewR / fit;

      // 退出聚焦握手（演化页返回宇宙时自增 exitFocusToken）
      if ((p.exitFocusToken ?? 0) !== focus.seenExitToken) {
        focus.seenExitToken = p.exitFocusToken ?? 0;
        if (focus.active) {
          focus.active = false;
          focus.dove = false;
          p.onPlanetFocusChange?.(false);
        }
      }

      if (focus.active) {
        // 行星聚焦：目标跟随行星（行星本身在轨道上运动）
        if (focus.justActivated) {
          focus.justActivated = false;
          // 从当前等效像素半径无缝起步（不设下限，避免点击瞬间的尺寸跳变）
          focus.planetR = 2.2 / (Math.min(W, H) / 2 / w.viewR);
        }
        focus.planetR += (0.06 - focus.planetR) * 0.045; // 实体化到固定世界半径（丝滑）
        if (focus.dove) focus.planetR *= 1.045; // 俯冲过场期间行星迎面放大
        controls.minDistance = focus.planetR * 2.2;
        controls.maxDistance = Math.max(dist * 6, 1);
      } else {
        controls.minDistance = dist * 0.25;
        controls.maxDistance = dist * 6;
      }

      if (focus.active) {
        planetVec.set(w.sys.state[PLANET_IDX * 2], w.sys.state[PLANET_IDX * 2 + 1], 0);
        controls.target.lerp(planetVec, 0.14);
        controls.update();
        // 俯冲检测：最近 0.6s 内有放大动作 + 距离进入阈值并停留 0.18s
        const dCam = camera.position.distanceTo(controls.target);
        if (!focus.dove && now - focus.lastWheelIn < 600 && dCam < focus.planetR * 2.7) {
          focus.diveHold += frameDt;
          if (focus.diveHold > 0.18) {
            focus.dove = true;
            p.onPlanetDive?.();
          }
        } else if (dCam >= focus.planetR * 2.7) {
          focus.diveHold = 0;
        }
      } else if (now < manualUntil) {
        controls.update();
      } else {
        const sway = now * 0.00005;
        camera.position.set(
          Math.sin(sway * 2.3) * dist * 0.04,
          -dist * 0.38 + Math.cos(sway * 1.9) * dist * 0.03,
          dist * 0.92,
        );
        if (controls.target.lengthSq() > 1e-8) controls.target.lerp(originVec, 0.1);
        else controls.target.set(0, 0, 0);
        controls.update();
      }

      // 与原 2D 版相同的像素 ↔ 世界单位换算，保持星体在屏幕上等效大小
      const pxPerUnit = Math.min(W, H) / 2 / w.viewR;
      const px2w = (px: number) => px / pxPerUnit;
      distantSky.group.position.copy(camera.position);

      // ---- 轨迹写缓冲 ----
      for (let i = 0; i < N_BODIES; i++) {
        writeTrail(trailLineOf(i), w.trails[i], i === PLANET_IDX ? 0.75 : 1);
      }
      if (p.showTwin) {
        for (let i = 0; i < N_STARS; i++) {
          writeTrail(twinTrails[i], w.twinTrails[i], 0.22);
        }
        for (const t of twinTrails) t.line.visible = true;
      } else {
        for (const t of twinTrails) t.line.visible = false;
      }

      // ---- 孪生系统恒星：空心小圈 ----
      for (let i = 0; i < N_STARS; i++) {
        twinRings[i].visible = p.showTwin;
        if (p.showTwin) {
          twinRings[i].position.set(w.twin.state[i * 2], w.twin.state[i * 2 + 1], 0);
          twinRings[i].scale.setScalar(px2w(4.5));
        }
      }

      // ---- 恒星本体：大小随质量（半径 ∝ 质量^(1/3)），等离子表面自转 + 光晕呼吸 ----
      const s = w.sys.state;
      for (let i = 0; i < N_STARS; i++) {
        const mr = Math.cbrt(w.sys.masses[i]);
        starCores[i].position.set(s[i * 2], s[i * 2 + 1], 0);
        starCores[i].scale.setScalar(px2w(2 + 1.8 * mr));
        starCores[i].rotation.y += starSpins[i] * frameDt;
        starGlows[i].position.set(s[i * 2], s[i * 2 + 1], 0); // 与球芯同心（depthTest 已关，无需偏移）
        // 小而克制的外晕衬托清晰球芯；呼吸只做轻微亮度变化。
        const glowSize = px2w(12 + 9 * mr);
        const breath = 1 + 0.05 * Math.sin(now * 0.0011 * (1 + i * 0.34) + i * 2.1);
        starGlows[i].scale.set(glowSize * breath, glowSize * breath, 1);
        const selected = p.selectedCelestial?.kind === 'star' && p.selectedCelestial.index === i;
        (starGlows[i].material as THREE.SpriteMaterial).opacity =
          0.48 + (selected ? 0.14 : 0) + 0.08 * Math.sin(now * 0.0009 * (1 + i * 0.41) + i * 1.3);
        projVec.copy(starCores[i].position).project(camera);
        bodyScreens[i].x = (projVec.x * 0.5 + 0.5) * W;
        bodyScreens[i].y = (-projVec.y * 0.5 + 0.5) * H;
        bodyScreens[i].r = 22;
        bodyScreens[i].visible = projVec.z >= -1 && projVec.z < 1;
      }

      // ---- 行星本体：反射星光（自转 + 云层差速 + 大气边缘光）----
      // 聚焦时改用实体化世界半径（相机逼近时自然变大）；否则保持等效屏幕大小
      const planetR = focus.active ? focus.planetR : px2w(2.2);
      planetCore.position.set(s[PLANET_IDX * 2], s[PLANET_IDX * 2 + 1], 0);
      planetCore.scale.setScalar(planetR);
      planetCore.rotation.y += 0.18 * frameDt;
      planetClouds.position.copy(planetCore.position);
      planetClouds.scale.setScalar(planetR);
      planetClouds.rotation.y += 0.23 * frameDt;
      atmosphere.position.copy(planetCore.position);
      atmosphere.scale.setScalar(planetR);

      // 行星屏幕坐标（点击聚焦命中判定）
      projVec.set(s[PLANET_IDX * 2], s[PLANET_IDX * 2 + 1], 0).project(camera);
      focus.screenX = (projVec.x * 0.5 + 0.5) * W;
      focus.screenY = (-projVec.y * 0.5 + 0.5) * H;
      focus.screenR = planetR * (H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))))
        / Math.max(0.0001, camera.position.distanceTo(planetCore.position));
      focus.hasScreen = projVec.z >= -1 && projVec.z < 1;
      bodyScreens[PLANET_IDX].x = focus.screenX;
      bodyScreens[PLANET_IDX].y = focus.screenY;
      bodyScreens[PLANET_IDX].r = Math.max(30, focus.screenR + 8);
      bodyScreens[PLANET_IDX].visible = focus.hasScreen;
      // 调试探针：无头截图/e2e 用（每帧两次数值写入，无分配）
      dbgPlanet.x = focus.screenX;
      dbgPlanet.y = focus.screenY;
      // 星光方向与亮度实时跟随：强度 ∝ 光度/距离²（归一到宜居基线 fluxBase）。
      // 恒纪元 ≈1.2；远离转暗（保底 0.05）；近日点增亮但封顶 1.55——
      // 更高会让纹理值越过 1.0 被 sRGB 输出压成白球（纹理"消失"的教训）
      const px = s[PLANET_IDX * 2], py = s[PLANET_IDX * 2 + 1];
      let hostIdx = 0, hostFlux = -1;
      for (let i = 0; i < N_STARS; i++) {
        starLights[i].position.set(s[i * 2], s[i * 2 + 1], 0);
        const d2 = Math.max((s[i * 2] - px) ** 2 + (s[i * 2 + 1] - py) ** 2, 0.0036);
        const flux = Math.pow(w.sys.masses[i], 3.5) / d2 / w.fluxBase;
        starLights[i].intensity = Math.min(Math.max(1.2 * flux, 0.05), 1.55);
        if (flux > hostFlux) { hostFlux = flux; hostIdx = i; }
      }
      atmosphereMat.uniforms.uSunDir.value
        .set(s[hostIdx * 2] - px, s[hostIdx * 2 + 1] - py, 0)
        .normalize();

      composer.render();
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        lastNow = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDivePinchPointerDown);
      canvas.removeEventListener('pointermove', onDivePinchPointerMove);
      canvas.removeEventListener('pointerup', onDivePinchPointerUp);
      canvas.removeEventListener('pointercancel', onDivePinchPointerCancel);
      canvas.removeEventListener('pointerdown', onFocusPointerDown);
      canvas.removeEventListener('pointerup', onFocusPointerUp);
      canvas.removeEventListener('dblclick', onFocusDblClick);
      canvas.removeEventListener('wheel', onFocusWheel);
      controls.dispose();
      scene.background = null;
      distantSky.dispose();
      galaxyTarget.dispose();
      disposeScene(scene, composer, renderer);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
