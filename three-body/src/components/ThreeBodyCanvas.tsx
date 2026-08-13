import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
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
    renderer.setClearColor('#040610');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
    camera.position.set(0, 0, 3);

    // 后处理：MSAA 渲染目标 + 泛光 + 色彩输出
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(renderer, renderTarget);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.0, 0.55, 0.12);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ---- 背景层：深空底色 + 星云 + 星野 ----
    const backdrop = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeBackdropTexture(),
        depthWrite: false,
        depthTest: false,
      }),
    );
    backdrop.renderOrder = -10;
    backdrop.position.set(0, 0, -600);
    backdrop.scale.set(2400, 2400, 1);
    scene.add(backdrop);

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
      s.position.set(x, y, -400);
      s.scale.set(scale, scale, 1);
      s.renderOrder = -9;
      scene.add(s);
      nebulas.push(s);
    };
    addNebula(-260, 200, 900, '#3850b4', 0.1);
    addNebula(280, -230, 820, '#7832a0', 0.08);

    const starfieldGeo = new THREE.BufferGeometry();
    {
      const positions = new Float32Array(STARFIELD_COUNT * 3);
      const colors = new Float32Array(STARFIELD_COUNT * 3);
      const cCool = new THREE.Color('#cdd8ff');
      const cWarm = new THREE.Color('#ffe9c9');
      for (let i = 0; i < STARFIELD_COUNT; i++) {
        // 均匀随机方向 × 半径 380~760 的球壳
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const r = 380 + Math.random() * 380;
        const s = Math.sqrt(1 - u * u);
        positions[i * 3] = r * s * Math.cos(th);
        positions[i * 3 + 1] = r * s * Math.sin(th);
        positions[i * 3 + 2] = -Math.abs(r * u) - 60; // 全部压在轨道平面之后
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

    // ---- 恒星：实体球芯 + 加法混合辉光 ----
    const starCores: THREE.Mesh[] = [];
    const starGlows: THREE.Sprite[] = [];
    for (let i = 0; i < N_STARS; i++) {
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16),
        new THREE.MeshBasicMaterial({ color: STAR_STYLES[i].core }),
      );
      scene.add(core);
      starCores.push(core);

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: makeGlowTexture(STAR_STYLES[i].glow),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      glow.renderOrder = 2;
      scene.add(glow);
      starGlows.push(glow);
    }

    // ---- 行星：青色小球 + 微光 ----
    const planetCore = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: PLANET_STYLE.core }),
    );
    scene.add(planetCore);
    const planetGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(PLANET_STYLE.glow),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    planetGlow.renderOrder = 2;
    scene.add(planetGlow);

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
        });
      }

      // 冻结模式：物理与上报照常，渲染整体跳过
      if (frozen) return;

      // ---- 视野自适应（只跟随恒星）----
      const targetR = Math.min(Math.max(maxRadiusFromCOM(w.sys) * 1.3, 1.7), 40);
      w.viewR += (targetR - w.viewR) * 0.03;

      // ---- 相机：轻微俯视 + 极慢漂移，轨道平面近 XY ----
      const fit = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, W / H);
      const dist = w.viewR / fit;
      const sway = now * 0.00005;
      camera.position.set(
        Math.sin(sway * 2.3) * dist * 0.025,
        -dist * 0.22 + Math.cos(sway * 1.9) * dist * 0.018,
        dist * 0.975,
      );
      camera.lookAt(0, 0, 0);

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

      // ---- 恒星本体：大小随质量（半径 ∝ 质量^(1/3)）----
      const s = w.sys.state;
      for (let i = 0; i < N_STARS; i++) {
        const mr = Math.cbrt(w.sys.masses[i]);
        starCores[i].position.set(s[i * 2], s[i * 2 + 1], 0);
        starCores[i].scale.setScalar(px2w(2 + 1.8 * mr));
        starGlows[i].position.set(s[i * 2], s[i * 2 + 1], 0.01);
        const glowSize = px2w(26 + 24 * mr);
        starGlows[i].scale.set(glowSize, glowSize, 1);
      }

      // ---- 行星本体：青色小点 + 微光 ----
      planetCore.position.set(s[PLANET_IDX * 2], s[PLANET_IDX * 2 + 1], 0);
      planetCore.scale.setScalar(px2w(2.2));
      planetGlow.position.set(s[PLANET_IDX * 2], s[PLANET_IDX * 2 + 1], 0.01);
      const pg = px2w(22);
      planetGlow.scale.set(pg, pg, 1);

      composer.render();
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      disposeScene(scene, composer, renderer);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
