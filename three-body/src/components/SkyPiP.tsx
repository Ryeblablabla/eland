import { useEffect, useRef } from 'react';
import type { SimStats } from '@/components/ThreeBodyCanvas';
import { PLANET_STYLE, STAR_STYLES } from '@/lib/threebody';
import type { EraKey } from '@/game/societyContract';

interface Props {
  stats: SimStats;
  era: EraKey;
  onOpen?: () => void; // 点击画中画切回宇宙视角
  className?: string;
}

/** 天象注记：与 Game 页纪元文案同源（飞星 = 恒星的天球视运动） */
const SKY_NOTE: Record<EraKey, { text: string; color: string }> = {
  stable: { text: '三日轨度可测 · 恒纪元', color: '#a7f3d0' },
  chaotic: { text: '飞星失序 · 乱纪元', color: '#fcd34d' },
  'chaotic-heat': { text: '飞星聚日 · 酷暑', color: '#fdba74' },
  'chaotic-cold': { text: '飞星远去 · 严寒', color: '#7dd3fc' },
  burned: { text: '三日凌空 · 焚世', color: '#fb923c' },
  frozen: { text: '飞星不动 · 长夜', color: '#7dd3fc' },
  extinct: { text: '星系崩解 · 终结', color: '#c4b5fd' },
};

const W = 208;
const H = 148;
const CX = W / 2;
const CY = 66; // 画布天体区中心（底部留给通量条）

/**
 * 三星画中画：演化页角落常驻的天象小视口。
 * 位置来自主宇宙的权威状态快照（SimStats.bodies，约 5Hz），本地插值平滑。
 */
export default function SkyPiP({ stats, era, onOpen, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef(stats);
  // 每轮渲染后同步最新快照给 RAF 循环（避免渲染期写 ref）
  useEffect(() => {
    statsRef.current = stats;
  });
  // 渲染用的平滑状态（向最新快照缓动）
  const smooth = useRef<{ bodies: number[]; spread: number }>({ bodies: [], spread: 2.2 });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = statsRef.current;
      const sm = smooth.current;
      // 快照到达时初始化，之后每帧缓动追齐
      if (sm.bodies.length !== 8 && s.bodies.length === 8) {
        sm.bodies = [...s.bodies];
        sm.spread = s.spread;
      }
      if (s.bodies.length === 8) {
        for (let i = 0; i < 8; i++) sm.bodies[i] += (s.bodies[i] - sm.bodies[i]) * 0.14;
        // 取景半径包住最远的行星（被甩出去时仍能看见）
        const planetR = Math.hypot(s.bodies[6], s.bodies[7]);
        const target = Math.max(s.spread * 1.25, planetR * 1.15, 1.2);
        sm.spread += (target - sm.spread) * 0.06;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      if (sm.bodies.length === 8) {
        const k = (Math.min(W, CY * 2) / 2 - 10) / sm.spread;
        const toScreen = (i: number): [number, number] => [
          CX + sm.bodies[i * 2] * k,
          CY + sm.bodies[i * 2 + 1] * k,
        ];
        // 行星 → 最近恒星连线（飞星关系的直观读数）
        const [px, py] = toScreen(3);
        let nearest = 0;
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
          const [sx, sy] = toScreen(i);
          const d = Math.hypot(sx - px, sy - py);
          if (d < best) { best = d; nearest = i; }
        }
        const [nx, ny] = toScreen(nearest);
        ctx.strokeStyle = 'rgba(148,163,184,0.28)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        ctx.setLineDash([]);

        // 恒星（辉光用 shadowBlur 近似，小画布开销可忽略）
        for (let i = 0; i < 3; i++) {
          const [sx, sy] = toScreen(i);
          ctx.save();
          ctx.shadowColor = STAR_STYLES[i].glow;
          ctx.shadowBlur = 10;
          ctx.fillStyle = STAR_STYLES[i].core;
          ctx.beginPath();
          ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        // 行星
        ctx.save();
        ctx.shadowColor = PLANET_STYLE.glow;
        ctx.shadowBlur = 6;
        ctx.fillStyle = PLANET_STYLE.core;
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 天体名标注
        const STAR_TAG = ['α A', 'α B', 'Proxima'];
        ctx.font = '8px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < 3; i++) {
          const [sx, sy] = toScreen(i);
          ctx.fillStyle = 'rgba(226,232,240,0.55)';
          ctx.fillText(STAR_TAG[i], sx + 5.5, sy);
        }
        ctx.fillStyle = 'rgba(217,255,242,0.5)';
        ctx.fillText('三体星', px + 4.5, py - 5);
      }

      // 底部：日照通量条（0~3× 宜居基线）
      const flux = Math.min(s.fluxRel, 3);
      ctx.fillStyle = 'rgba(148,163,184,0.16)';
      ctx.fillRect(12, H - 22, W - 24, 3);
      const hue = s.fluxRel > 1.8 ? '#fb923c' : s.fluxRel < 0.45 ? '#7dd3fc' : '#a7f3d0';
      ctx.fillStyle = hue;
      ctx.fillRect(12, H - 22, ((W - 24) * flux) / 3, 3);
      // 宜居带刻度（1× 基线）
      ctx.fillStyle = 'rgba(226,232,240,0.5)';
      ctx.fillRect(12 + (W - 24) / 3, H - 24, 1, 7);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const note = SKY_NOTE[era];

  return (
    <button
      onClick={onOpen}
      title="天象 · 点击查看宇宙"
      className={`group block border border-white/10 bg-slate-950/75 p-3 pb-2 text-left backdrop-blur-md transition-colors hover:border-amber-200/40 ${className ?? ''}`}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] tracking-[0.4em] text-slate-500">天 象</span>
        <span className="text-[9px] tracking-[0.15em]" style={{ color: note.color }}>{note.text}</span>
      </div>
      <canvas ref={canvasRef} style={{ width: W, height: H }} className="mt-1 block" />
      <div className="flex items-baseline justify-between text-[9px] tracking-[0.15em] text-slate-500">
        <span>日照 ×{stats.fluxRel.toFixed(2)}</span>
        <span>近日 {stats.planetDist.toFixed(2)}</span>
        <span className="text-slate-600 transition-colors group-hover:text-amber-200/80">仰望宇宙 ↑</span>
      </div>
    </button>
  );
}
