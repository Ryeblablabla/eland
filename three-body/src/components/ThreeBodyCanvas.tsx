import { useEffect, useRef } from 'react';
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
const TRAIL_CHUNKS = 26;

function makeGlowSprite(color: string): HTMLCanvasElement {
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
  return c;
}

export default function ThreeBodyCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

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
    sprites: HTMLCanvasElement[];
    planetSprite: HTMLCanvasElement;
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
      sprites: STAR_STYLES.map((s) => makeGlowSprite(s.glow)),
      planetSprite: makeGlowSprite(PLANET_STYLE.glow),
    };
  }, [props.presetKey, props.resetToken]);

  // 主循环
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let W = 0, H = 0, dpr = 1;
    let bg: HTMLCanvasElement | null = null;

    const rebuildBg = () => {
      bg = document.createElement('canvas');
      bg.width = Math.max(1, W * dpr);
      bg.height = Math.max(1, H * dpr);
      const g = bg.getContext('2d')!;
      g.scale(dpr, dpr);
      const base = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
      base.addColorStop(0, '#0a0e1f');
      base.addColorStop(0.55, '#060812');
      base.addColorStop(1, '#02030a');
      g.fillStyle = base;
      g.fillRect(0, 0, W, H);
      const nebula = (x: number, y: number, r: number, color: string) => {
        const n = g.createRadialGradient(x, y, 0, x, y, r);
        n.addColorStop(0, color);
        n.addColorStop(1, 'transparent');
        g.fillStyle = n;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      };
      nebula(W * 0.22, H * 0.28, Math.min(W, H) * 0.5, 'rgba(56,80,180,0.10)');
      nebula(W * 0.8, H * 0.72, Math.min(W, H) * 0.45, 'rgba(120,50,160,0.08)');
      for (let i = 0; i < 320; i++) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        const r = Math.random() * 1.1 + 0.2;
        g.globalAlpha = 0.15 + Math.random() * 0.6;
        g.fillStyle = Math.random() < 0.85 ? '#cdd8ff' : '#ffe9c9';
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    };

    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      canvas.width = Math.max(1, W * dpr);
      canvas.height = Math.max(1, H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      rebuildBg();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    resize();

    const drawTrail = (pts: number[], color: string, alphaScale: number, width = 1.3) => {
      const n = pts.length / 2;
      if (n < 2) return;
      const chunk = Math.max(2, Math.ceil(n / TRAIL_CHUNKS));
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      let c = 0;
      for (let start = 0; start < n - 1; start += chunk - 1) {
        const end = Math.min(n - 1, start + chunk - 1);
        const a = Math.pow((c + 1) / TRAIL_CHUNKS, 1.6) * 0.85 * alphaScale;
        ctx.strokeStyle = color;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.moveTo(pts[start * 2], pts[start * 2 + 1]);
        for (let i = start + 1; i <= end; i++) {
          ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
        }
        ctx.stroke();
        c++;
      }
      ctx.globalAlpha = 1;
    };

    let lastNow = performance.now();

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

      // ---- 渲染 ----
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (bg) ctx.drawImage(bg, 0, 0, W, H);
      else { ctx.fillStyle = '#05070f'; ctx.fillRect(0, 0, W, H); }

      const scale = Math.min(W, H) / 2 / w.viewR;
      const toScreen = (x: number, y: number): [number, number] => [
        W / 2 + x * scale,
        H / 2 + y * scale,
      ];

      const project = (pts: number[]) => {
        const out = new Array<number>(pts.length);
        for (let i = 0; i < pts.length; i += 2) {
          out[i] = W / 2 + pts[i] * scale;
          out[i + 1] = H / 2 + pts[i + 1] * scale;
        }
        return out;
      };

      // 孪生系统轨迹（暗）
      if (p.showTwin) {
        for (let i = 0; i < N_STARS; i++) {
          drawTrail(project(w.twinTrails[i]), STAR_STYLES[i].trail, 0.22);
        }
      }
      // 行星轨迹
      drawTrail(project(w.trails[PLANET_IDX]), PLANET_STYLE.trail, 0.75, 1);
      // 恒星轨迹
      for (let i = 0; i < N_STARS; i++) {
        drawTrail(project(w.trails[i]), STAR_STYLES[i].trail, 1);
      }

      // 孪生系统恒星：空心小圈
      if (p.showTwin) {
        for (let i = 0; i < N_STARS; i++) {
          const [sx, sy] = toScreen(w.twin.state[i * 2], w.twin.state[i * 2 + 1]);
          ctx.strokeStyle = STAR_STYLES[i].glow;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // 恒星本体：大小随质量（半径 ∝ 质量^(1/3)）
      for (let i = 0; i < N_STARS; i++) {
        const [sx, sy] = toScreen(w.sys.state[i * 2], w.sys.state[i * 2 + 1]);
        const mr = Math.cbrt(w.sys.masses[i]);
        const glowSize = 26 + 24 * mr;
        ctx.drawImage(w.sprites[i], sx - glowSize / 2, sy - glowSize / 2, glowSize, glowSize);
        ctx.fillStyle = STAR_STYLES[i].core;
        ctx.beginPath();
        ctx.arc(sx, sy, 2 + 1.8 * mr, 0, Math.PI * 2);
        ctx.fill();
      }

      // 行星本体：青色小点 + 微光
      {
        const [sx, sy] = toScreen(
          w.sys.state[PLANET_IDX * 2],
          w.sys.state[PLANET_IDX * 2 + 1],
        );
        ctx.drawImage(w.planetSprite, sx - 11, sy - 11, 22, 22);
        ctx.fillStyle = PLANET_STYLE.core;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
