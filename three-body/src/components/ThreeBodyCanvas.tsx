import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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

export interface SimStats {
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
}

interface Props {
  running: boolean;
  speed: number;
  trailLength: number;
  showTwin: boolean;
  presetKey: string;
  resetToken: number;
  targetT?: number; // 权威目标时刻（人间纪年换算）；设置后宇宙向该时刻平滑快进
  skyMode?: 'follow' | 'frozen'; // frozen：完全冻结（人间视角懒加载）
  collapseHold?: boolean;  // 文明毁灭时冻结宇宙，等待结算
  respawnToken?: number;   // 自增 = 结算完毕，新文明启程
  onStats?: (s: SimStats) => void;
  planetFocusEnabled?: boolean;              // 允许点击行星进入聚焦（演化页传）
  onPlanetFocusChange?: (focused: boolean) => void;
  onPlanetDive?: () => void;                 // 聚焦后继续滚轮放大越过阈值 → 请求俯冲进入人间
  exitFocusToken?: number;                   // 自增 = 退出聚焦，相机回星系质心
}

const DT = 0.001;
const MAX_TRAIL = 4096; // 轨迹缓冲上限（UI 滑杆最大 3000）
const STARFIELD_COUNT = 1500;

// ---------------------------------------------------------------------------
// 纹理工厂（与原 2D 版同款径向渐变，但输出 WebGL 纹理）
// ---------------------------------------------------------------------------

function makeGlowTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(0.18, color + 'cc');
  grad.addColorStop(0.45, color + '44');
  grad.addColorStop(1, color + '00');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** 白色径向渐变，配合 SpriteMaterial 的 color/opacity 调色 */
function makeRadialTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/** 深空底色渐变（与原 2D 背景一致：中心 #0a0e1f → 边缘 #02030a） */
function makeBackdropTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 384);
  grad.addColorStop(0, '#0a0e1f');
  grad.addColorStop(0.55, '#060812');
  grad.addColorStop(1, '#02030a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// 程序化表面纹理：周期化值噪声 + 分形叠加（fbm），零外部资源
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface NoiseGrid { g: Float64Array; w: number; h: number }

function makeNoiseGrids(octaves: number[], rng: () => number): NoiseGrid[] {
  return octaves.map((n) => {
    const g = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) g[i] = rng();
    return { g, w: n, h: n };
  });
}

/** 双线性 + smoothstep 采样；x 方向周期（球面纹理横向无缝），y 方向钳制 */
function sampleGrid({ g, w, h }: NoiseGrid, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % w) + w) % w, x1 = (x0 + 1) % w;
  const y0 = Math.min(Math.max(yi, 0), h - 1), y1 = Math.min(y0 + 1, h - 1);
  const a = g[y0 * w + x0], b = g[y0 * w + x1];
  const c2 = g[y1 * w + x0], d = g[y1 * w + x1];
  const top = a + (b - a) * sx, bot = c2 + (d - c2) * sx;
  return top + (bot - top) * sy;
}

/** 分形叠加：x,y ∈ [0,1) 归一化坐标，输出 [0,1] */
function fbm(grids: NoiseGrid[], x: number, y: number): number {
  let v = 0, amp = 0.5, tot = 0;
  for (const grid of grids) {
    v += sampleGrid(grid, x * grid.w, y * grid.h) * amp;
    tot += amp;
    amp *= 0.5;
  }
  return v / tot;
}

/** 恒星表面：等离子颗粒（暗部 = 星光色压暗，亮斑 = 星芯色） */
function makeStarSurfaceTexture(coreHex: string, glowHex: string, seed: number): THREE.CanvasTexture {
  const S = 256;
  const rng = mulberry32(seed);
  const grids = makeNoiseGrids([4, 8, 16, 32], rng);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const dark = new THREE.Color(glowHex).multiplyScalar(0.32);
  const mid = new THREE.Color(glowHex);
  const hot = new THREE.Color(coreHex);
  const tmp = new THREE.Color();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let n = fbm(grids, x / S, y / S);
      n = Math.min(Math.max((n - 0.32) * 2.1, 0), 1); // 对比度曲线，拉出颗粒感
      if (n < 0.55) tmp.copy(dark).lerp(mid, n / 0.55);
      else tmp.copy(mid).lerp(hot, (n - 0.55) / 0.45);
      const i = (y * S + x) * 4;
      img.data[i] = Math.round(tmp.r * 255);
      img.data[i + 1] = Math.round(tmp.g * 255);
      img.data[i + 2] = Math.round(tmp.b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 三体星表面组：日间海陆（无云）+ 高光掩码（海面反光）+ 独立云层 */
function makePlanetTextureSet(seed: number): {
  day: THREE.CanvasTexture;
  spec: THREE.CanvasTexture;
  clouds: THREE.CanvasTexture;
} {
  const W = 256, H = 128;
  const rng = mulberry32(seed);
  const grids = makeNoiseGrids([4, 8, 16, 32], rng);
  const cloudGrids = makeNoiseGrids([3, 6, 12], rng);
  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  };
  const dayC = makeCanvas(), specC = makeCanvas(), cloudC = makeCanvas();
  const dayCtx = dayC.getContext('2d')!;
  const specCtx = specC.getContext('2d')!;
  const cloudCtx = cloudC.getContext('2d')!;
  const dayImg = dayCtx.createImageData(W, H);
  const specImg = specCtx.createImageData(W, H);
  const cloudImg = cloudCtx.createImageData(W, H);
  const deep = new THREE.Color('#0a2f3c');
  const shallow = new THREE.Color('#17606d');
  const landLow = new THREE.Color('#3d6b4c');
  const landHigh = new THREE.Color('#97875a');
  const ice = new THREE.Color('#ddf3ee');
  const tmp = new THREE.Color();
  for (let y = 0; y < H; y++) {
    const lat = Math.abs(y / H - 0.5) * 2; // 0 赤道 → 1 极
    for (let x = 0; x < W; x++) {
      const n = fbm(grids, x / W, y / H);
      const isIce = lat > 0.82 - n * 0.1;
      const isWater = !isIce && n < 0.53;
      if (isIce) tmp.copy(ice);
      else if (n < 0.47) tmp.copy(deep).lerp(shallow, Math.max(0, (n - 0.36) / 0.11));
      else if (n < 0.53) tmp.copy(shallow);
      else if (n < 0.62) tmp.copy(landLow).lerp(landHigh, (n - 0.53) / 0.09);
      else tmp.copy(landHigh);
      const i = (y * W + x) * 4;
      dayImg.data[i] = Math.round(tmp.r * 255);
      dayImg.data[i + 1] = Math.round(tmp.g * 255);
      dayImg.data[i + 2] = Math.round(tmp.b * 255);
      dayImg.data[i + 3] = 255;
      // 高光掩码：海面强反光，冰面弱反光，陆地几乎无
      const sp = isWater ? 232 : isIce ? 74 : 18;
      specImg.data[i] = specImg.data[i + 1] = specImg.data[i + 2] = sp;
      specImg.data[i + 3] = 255;
      // 云层：横向条带，独立成层（不烤进日间纹理）
      const cl = fbm(cloudGrids, x / W, (y / H) * 0.35);
      const ca = cl > 0.56 ? Math.min((cl - 0.56) * 3.4, 0.92) : 0;
      cloudImg.data[i] = cloudImg.data[i + 1] = cloudImg.data[i + 2] = 255;
      cloudImg.data[i + 3] = Math.round(ca * 255);
    }
  }
  dayCtx.putImageData(dayImg, 0, 0);
  specCtx.putImageData(specImg, 0, 0);
  cloudCtx.putImageData(cloudImg, 0, 0);
  const toTex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { day: toTex(dayC, true), spec: toTex(specC, false), clouds: toTex(cloudC, true) };
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
    fluxBase: number; // 宜居基线通量
    planetR: number;
  } | null>(null);

  // 初始化 / 重置
  useEffect(() => {
    const preset = PRESETS.find((p) => p.key === props.presetKey) ?? DEFAULT_PRESET;
    const sys = createSystem(preset);
    const twin = makeTwin(sys);
    // 宜居基线：行星在初始轨道半径上接收宿主恒星（最大质量）的通量
    const hostMass = Math.max(...preset.masses);
    world.current = {
      sys,
      twin,
      trails: Array.from({ length: N_BODIES }, () => []),
      twinTrails: Array.from({ length: N_BODIES }, () => []),
      t: 0,
      viewR: 2.2,
      frame: 0,
      civilizations: 1, // 第 1 号文明启程
      extinct: false,
      pendingCollapse: null,
      seenRespawnToken: props.respawnToken ?? 0,
      fluxBase: Math.pow(hostMass, 3.5) / (preset.planetR * preset.planetR),
      planetR: preset.planetR,
    };
  }, [props.presetKey, props.resetToken]);

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

    // ---- 行星聚焦（演化页启用）：点击行星 → 相机环绕行星；继续滚轮放大 → 俯冲进入人间 ----
    const focus = {
      active: false,      // 聚焦中
      planetR: 0.05,      // 行星视觉半径（聚焦时从等效像素大小平滑实体化）
      lastWheelIn: -1e9,  // 最近一次"放大"滚轮时间
      diveHold: 0,        // 在阈值内持续停留的时长
      dove: false,        // 已发起俯冲（本次聚焦只触发一次）
      justActivated: false, // 本帧刚进入聚焦（行星半径从等效像素起步）
      seenExitToken: -1,
      screenX: 0, screenY: 0, hasScreen: false, // 行星屏幕坐标（点击命中用）
    };
    const planetVec = new THREE.Vector3();
    const projVec = new THREE.Vector3();
    const originVec = new THREE.Vector3(0, 0, 0);
    let canvasDown: { x: number; y: number } | null = null;
    const onFocusPointerDown = (ev: PointerEvent) => { canvasDown = { x: ev.clientX, y: ev.clientY }; };
    const onFocusPointerUp = (ev: PointerEvent) => {
      if (!canvasDown || Math.hypot(ev.clientX - canvasDown.x, ev.clientY - canvasDown.y) >= 5) { canvasDown = null; return; }
      canvasDown = null;
      const p = propsRef.current;
      if (!p.planetFocusEnabled || focus.active || !focus.hasScreen) return;
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      if (Math.hypot(mx - focus.screenX, my - focus.screenY) < 30) {
        focus.active = true;
        focus.dove = false;
        focus.diveHold = 0;
        focus.justActivated = true;
        p.onPlanetFocusChange?.(true);
      }
    };
    const onFocusDblClick = () => {
      if (focus.active) {
        focus.active = false;
        focus.dove = false;
        propsRef.current.onPlanetFocusChange?.(false);
      }
    };
    const onFocusWheel = (ev: WheelEvent) => { if (ev.deltaY < 0) focus.lastWheelIn = performance.now(); };
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
    // 泛光：阈值拉高到 0.55，只有真正高亮的星芯参与，避免辉光溢出洗亮背景
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.45, 0.55);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ---- 背景层：深空底色 + 星云 + 星野 ----
    // 幕布与星云挂在相机局部坐标（天穹行为）：相机无论转到哪一面，
    // 它们都跟在视野最深处，正/背面观感一致
    const backdrop = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeBackdropTexture(),
        depthWrite: false,
        depthTest: false,
      }),
    );
    backdrop.renderOrder = -10;
    backdrop.position.set(0, 0, -1000); // 相机局部：永远在最远处
    backdrop.scale.set(2600, 2600, 1);
    camera.add(backdrop);
    scene.add(camera); // 相机的子节点需要随相机一起入场景才渲染

    const radialTex = makeRadialTexture();
    const nebulas: THREE.Sprite[] = [];
    const addNebula = (x: number, y: number, scale: number, color: string, opacity: number) => {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: radialTex,
          color,
          opacity,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      s.position.set(x, y, -950); // 相机局部：贴在视野边缘的远景
      s.scale.set(scale, scale, 1);
      s.renderOrder = -9;
      camera.add(s);
      nebulas.push(s);
    };
    // 星云：调暗调小，只作远处若隐若现的底色，不再洗亮整屏
    addNebula(-420, 320, 950, '#2c3f8f', 0.05);
    addNebula(460, -360, 880, '#5e2880', 0.04);

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
          color: new THREE.Color(1.35, 1.35, 1.35), // HDR 提亮：纹理亮斑越过 bloom 阈值
        }),
      );
      scene.add(core);
      starCores.push(core);

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: makeGlowTexture(STAR_STYLES[i].glow),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false, // 永远叠在球芯之上：可旋转相机下不存在被球芯遮挡的"日食"
        }),
      );
      glow.renderOrder = 2;
      scene.add(glow);
      starGlows.push(glow);
    }

    // ---- 行星：不发光，只反射星光（地球式：受光球芯 + 海面高光 + 独立云层 + 大气边缘光）----
    const planetTex = makePlanetTextureSet(4242);
    const planetCore = new THREE.Mesh(
      new THREE.SphereGeometry(1, 28, 20),
      new THREE.MeshPhongMaterial({
        map: planetTex.day,
        specularMap: planetTex.spec, // 海面反射星光
        specular: new THREE.Color('#7d99a6'),
        shininess: 24,
      }),
    );
    planetCore.rotation.x = 0.15; // 轻微轴倾
    scene.add(planetCore);
    // 独立云层：略大一圈、与地表差速自转
    const planetClouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 28, 20),
      new THREE.MeshPhongMaterial({
        map: planetTex.clouds,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    );
    planetClouds.rotation.x = 0.15;
    scene.add(planetClouds);
    // 大气：菲涅尔 rim，只有轮廓一圈发亮（加法混合，不触发 bloom）；
    // 迎光面亮、背光面暗（uSunDir 每帧指向当前通量最强的恒星）
    const atmosphereMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PLANET_STYLE.glow) },
        uPower: { value: 3.2 },
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
    scene.add(atmosphere);

    // ---- 恒星光照：方向实时从恒星指向行星，强度 ∝ 质量^3.5（主序星光度比）----
    const starLights: THREE.DirectionalLight[] = [];
    for (let i = 0; i < N_STARS; i++) {
      const l = new THREE.DirectionalLight(STAR_STYLES[i].core, 1);
      l.target = planetCore;
      scene.add(l);
      starLights.push(l);
    }
    scene.add(new THREE.AmbientLight('#16202e', 0.6)); // 极暗环境光：夜面不死黑

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
          placePlanet(w.sys, w.planetR);
          placePlanet(w.twin, w.planetR);
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
              placePlanet(w.sys, w.planetR);
              placePlanet(w.twin, w.planetR);
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
          focus.planetR = Math.max(0.02, 2.2 / (Math.min(W, H) / 2 / w.viewR)); // 从等效像素半径起步
        }
        focus.planetR += (0.06 - focus.planetR) * 0.06; // 实体化到固定世界半径
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
        // 辉光收敛（原 26+24·∛m 叠 bloom 会让 α A 白成一团）+ 呼吸脉动（相位/频率各异）
        const glowSize = px2w(16 + 13 * mr);
        const breath = 1 + 0.05 * Math.sin(now * 0.0011 * (1 + i * 0.34) + i * 2.1);
        starGlows[i].scale.set(glowSize * breath, glowSize * breath, 1);
        (starGlows[i].material as THREE.SpriteMaterial).opacity =
          0.88 + 0.12 * Math.sin(now * 0.0009 * (1 + i * 0.41) + i * 1.3);
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
      focus.hasScreen = projVec.z < 1;
      atmosphere.scale.setScalar(px2w(2.2));
      // 星光方向与亮度实时跟随：强度 ∝ 光度/距离²（归一到宜居基线 fluxBase）。
      // 恒纪元 ≈1.2 常亮；乱纪元远离时转暗（保底 0.05 不失读），三日凌空时
      // 迎光面真实过曝（封顶 3.5，刻意保留"被炙烤"的泛光）；大气 rim 指向主恒星
      const px = s[PLANET_IDX * 2], py = s[PLANET_IDX * 2 + 1];
      let hostIdx = 0, hostFlux = -1;
      for (let i = 0; i < N_STARS; i++) {
        starLights[i].position.set(s[i * 2], s[i * 2 + 1], 0);
        const d2 = Math.max((s[i * 2] - px) ** 2 + (s[i * 2 + 1] - py) ** 2, 0.0036);
        const flux = Math.pow(w.sys.masses[i], 3.5) / d2 / w.fluxBase;
        starLights[i].intensity = Math.min(Math.max(1.2 * flux, 0.05), 3.5);
        if (flux > hostFlux) { hostFlux = flux; hostIdx = i; }
      }
      atmosphereMat.uniforms.uSunDir.value
        .set(s[hostIdx * 2] - px, s[hostIdx * 2 + 1] - py, 0)
        .normalize();

      composer.render();
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onFocusPointerDown);
      canvas.removeEventListener('pointerup', onFocusPointerUp);
      canvas.removeEventListener('dblclick', onFocusDblClick);
      canvas.removeEventListener('wheel', onFocusWheel);
      controls.dispose();
      disposeScene(scene, composer, renderer);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
