import { useEffect, useMemo, useRef, useState } from 'react';
import { type EraKey, type SocietyAgent, type SocietyState } from '@/game/societyContract';
import { findArchiveCharacter } from '@/data/characters';
import { drawBird, drawDeer, drawMarker, drawPerson, drawStructure, genWorld, MAP_H, MAP_W, mulberry32, paintWaterFrame, TILE } from '@/game/pixelworld';

interface Props {
  society: SocietyState;
  era: EraKey;
  speaker: string | null;
  focusAgent: SocietyAgent | null;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  seed: number;
}

const ERA_TINT: Record<EraKey, string> = {
  stable: 'rgba(251,191,36,0.05)',
  chaotic: 'rgba(148,120,160,0.10)',
  'chaotic-heat': 'rgba(249,115,22,0.16)',
  'chaotic-cold': 'rgba(56,189,248,0.15)',
  burned: 'rgba(249,115,22,0.22)',
  frozen: 'rgba(56,189,248,0.18)',
  extinct: 'rgba(88,60,140,0.17)',
};

const W = MAP_W * TILE; // 逻辑像素
const H = MAP_H * TILE;

export default function SocietyMap({ society, era, speaker, focusAgent, selectedAgentId, onSelectAgent, seed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const locKey = society.locations.map((l) => l.name).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const world = useMemo(() => genWorld(seed, society.locations), [seed, locKey]);
  const [selectedLoc, setSelectedLoc] = useState<number | null>(null);

  // 人物像素位置（平滑插值）
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const societyRef = useRef(society);
  societyRef.current = society;
  const speakerRef = useRef(speaker);
  speakerRef.current = speaker;
  const selectedRef = useRef(selectedAgentId);
  selectedRef.current = selectedAgentId;
  const eraRef = useRef(era);
  eraRef.current = era;
  // 纪元天气粒子
  const particlesRef = useRef<{ x: number; y: number; vx: number; vy: number; size: number; seed: number }[]>([]);
  // 野生动物（鹿群漫游 + 飞鸟掠过），种子确定
  const crittersRef = useRef<{ deer: { x: number; y: number; tx: number; ty: number }[]; birds: { x: number; y: number; speed: number }[]; nextBird: number }>({ deer: [], birds: [], nextBird: 0 });
  const initialAnimalLocations = society.locations.flatMap((loc, index) => loc.matter.some((matter) => matter.traits.includes('animal') && matter.quantity > 0) ? [index] : []);
  if (crittersRef.current.deer.length === 0 && initialAnimalLocations.length > 0) {
    const rand = mulberry32(seed * 13 + 7);
    const animalCount = Math.min(8, Math.max(1, Math.ceil(society.locations.reduce((sum, loc) => sum + loc.matter.filter((matter) => matter.traits.includes('animal')).reduce((n, matter) => n + matter.quantity, 0), 0) / 3)));
    crittersRef.current.deer = Array.from({ length: animalCount }, (_, index) => {
      const anchor = world.anchors[initialAnimalLocations[index % initialAnimalLocations.length]];
      return {
      x: (anchor.tx + rand() * 3) * TILE, y: (anchor.ty + rand() * 3) * TILE,
      tx: 0, ty: 0,
    }});
    crittersRef.current.deer.forEach((d) => { d.tx = d.x + 40; d.ty = d.y + 20; });
    crittersRef.current.nextBird = 4000 + rand() * 6000;
  }

  // 渲染循环
  useEffect(() => {
    const canvas = canvasRef.current!;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    let raf = 0;
    let lastWater = 0;
    let waterFrame = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const s = societyRef.current;

      // 地形
      g.drawImage(world.terrain, 0, 0);
      // 动态水波（每 480ms 换帧）
      if (now - lastWater > 480) { waterFrame = 1 - waterFrame; lastWater = now; }
      paintWaterFrame(g, world, waterFrame);

      // 地表改变直接来自 ELAND；地点名字不再决定建筑或农田外观。
      s.locations.forEach((loc, i) => {
        const a = world.anchors[i];
        const ax = a.tx * TILE, ay = a.ty * TILE;
        if (loc.terrain.irrigated) {
          g.fillStyle = 'rgba(69,105,48,0.78)';
          for (let row = 0; row < 3; row += 1) g.fillRect(ax - 14, ay + row * 5, 40, 2);
        }
        if (loc.terrain.depth > 0) {
          g.strokeStyle = 'rgba(48,86,110,0.8)';
          g.lineWidth = Math.min(4, 1 + loc.terrain.depth * 0.45);
          g.beginPath(); g.moveTo(ax - 12, ay + 20); g.quadraticCurveTo(ax + 4, ay + 11, ax + 28, ay + 17); g.stroke();
        }
        if (loc.dev === 1) drawMarker(g, ax, ay, now);
        const visibleMatter = loc.matter.filter((matter) => matter.quantity > 0 && !matter.traits.includes('animal')).slice(0, 4);
        visibleMatter.forEach((matter, slot) => {
          g.fillStyle = matter.kind === 'water-source' ? '#4d86ad' : matter.traits.includes('edible') ? '#a6a35e' : matter.traits.includes('fiber') ? '#7c9b66' : matter.traits.includes('rigid') ? '#7b7f88' : '#8a7355';
          g.fillRect(ax - 10 + slot * 5, ay + 25 + (slot % 2) * 2, 3, 3);
        });
      });

      // 路径只由真实通行痕迹绘制。
      for (const route of s.routes) {
        if (route.state === 'unmarked' || route.traffic <= 0) continue;
        const from = world.anchors[route.from], to = world.anchors[route.to];
        if (!from || !to) continue;
        g.strokeStyle = route.state === 'road' ? 'rgba(126,108,78,0.9)' : 'rgba(108,96,72,0.55)';
        g.lineWidth = route.state === 'road' ? 5 : 2;
        g.beginPath(); g.moveTo(from.tx * TILE + 8, from.ty * TILE + 18); g.lineTo(to.tx * TILE + 8, to.ty * TILE + 18); g.stroke();
      }

      // 野生动物
      const critters = crittersRef.current;
      const desiredDeer = Math.min(8, Math.ceil(s.locations.reduce((sum, loc) => sum + loc.matter.filter((matter) => matter.traits.includes('animal')).reduce((n, matter) => n + matter.quantity, 0), 0) / 3));
      if (critters.deer.length > desiredDeer) critters.deer.length = desiredDeer;
      critters.deer.forEach((d, i) => {
        const dx = d.tx - d.x, dy = d.ty - d.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 4) {
          // 动物只在世界状态仍有动物时出现。
          if (Math.random() < 0.004) {
            d.tx = (12 + Math.random() * 14) * TILE;
            d.ty = (12 + Math.random() * 18) * TILE;
          }
        } else {
          d.x += (dx / dist) * 0.35;
          d.y += (dy / dist) * 0.35;
        }
        drawDeer(g, Math.round(d.x), Math.round(d.y), Math.floor(now / 300), dx > 0.5);
        void i;
      });
      // 飞鸟定时掠过
      critters.nextBird -= 16;
      if (critters.nextBird <= 0 && critters.birds.length < 3) {
        critters.birds.push({ x: -20, y: 30 + Math.random() * 140, speed: 1.1 + Math.random() * 0.7 });
        critters.nextBird = 9000 + Math.random() * 12000;
      }
      critters.birds = critters.birds.filter((b) => b.x < W + 30);
      for (const b of critters.birds) {
        b.x += b.speed;
        b.y += Math.sin(now / 600 + b.speed * 10) * 0.2;
        drawBird(g, Math.round(b.x), Math.round(b.y), Math.floor(now / 220));
      }

      // 涌现建筑：人物真实建造的结构（工地 → 实体，名字由建造者自取）
      const perLoc: number[] = [];
      for (const st of s.structures ?? []) {
        const a = world.anchors[Math.min(st.loc, world.anchors.length - 1)];
        const slot = (perLoc[st.loc] = (perLoc[st.loc] ?? 0) + 1) - 1;
        const sx = a.tx * TILE + 40 + (slot % 3) * 20;
        const sy = a.ty * TILE + 4 + Math.floor(slot / 3) * 18;
        drawStructure(g, st, sx, sy, now);
        if (st.complete) {
          g.font = '8px sans-serif';
          g.textAlign = 'center';
          g.fillStyle = 'rgba(220,230,245,0.75)';
          g.fillText(st.name.slice(0, 8), sx + 8, sy + 24);
        }
      }

      // 人物（插值移动）
      s.agents.forEach((a, idx) => {
        if (a.state === 'dead') return; // 逝者不再出现在地图上
        const anchor = world.anchors[Math.min(a.loc, world.anchors.length - 1)];
        const tx = anchor.tx * TILE + 12 + ((idx * 29) % 24);
        const ty = anchor.ty * TILE + 30 + ((idx * 17) % 10);
        let p = posRef.current.get(a.id);
        if (!p) { p = { x: tx, y: ty }; posRef.current.set(a.id, p); }
        const dx = tx - p.x, dy = ty - p.y;
        const moving = Math.abs(dx) + Math.abs(dy) > 1.5;
        p.x += dx * 0.016;
        p.y += dy * 0.016;

        const isSpeaker = speakerRef.current === a.name;
        const isSelected = selectedRef.current === a.id;
        drawPerson(g, Math.round(p.x), Math.round(p.y), {
          moving,
          frame: Math.floor(now / 180),
          dehydrated: a.state === 'dehydrated',
          highlight: isSpeaker ? 'speaker' : isSelected ? 'selected' : 'none',
          robeIdx: idx,
        });
        // 名字（仅发言者/选中者，避免拥挤）
        if (isSpeaker || isSelected) {
          g.font = '9px sans-serif';
          g.textAlign = 'center';
          g.fillStyle = 'rgba(3,5,12,0.7)';
          const wText = g.measureText(a.name).width;
          g.fillRect(p.x - wText / 2 - 3, p.y + 4, wText + 6, 12);
          g.fillStyle = isSpeaker ? '#fcd34d' : '#f0abfc';
          g.fillText(a.name, p.x, p.y + 13);
        }
      });

      // ---- 纪元天气粒子 ----
      const e = eraRef.current;
      const parts = particlesRef.current;
      const targetCount =
        e === 'chaotic-cold' || e === 'frozen' ? 110 :
        e === 'chaotic-heat' || e === 'burned' ? 55 :
        e === 'stable' ? 34 :
        e === 'chaotic' ? 46 : 0;
      while (parts.length < targetCount) {
        parts.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: 0, vy: 0, size: 1, seed: Math.random() * 1000,
        });
      }
      if (parts.length > targetCount) parts.length = targetCount;
      for (const pt of parts) {
        if (e === 'chaotic-cold' || e === 'frozen') {
          // 飘雪
          pt.vy = 0.25 + (pt.seed % 0.35); pt.vx = Math.sin(now / 900 + pt.seed) * 0.25;
          pt.x += pt.vx; pt.y += pt.vy;
          if (pt.y > H) { pt.y = -4; pt.x = Math.random() * W; }
          g.fillStyle = `rgba(226,240,255,${0.35 + (pt.seed % 0.45)})`;
          g.fillRect(pt.x, pt.y, pt.seed % 2 < 1 ? 1 : 2, pt.seed % 2 < 1 ? 1 : 2);
        } else if (e === 'chaotic-heat' || e === 'burned') {
          // 流火余烬
          pt.vy = -(0.2 + (pt.seed % 0.4)); pt.vx = Math.sin(now / 700 + pt.seed) * 0.3;
          pt.x += pt.vx; pt.y += pt.vy;
          if (pt.y < -4) { pt.y = H + 4; pt.x = Math.random() * W; }
          const fl = 0.35 + 0.45 * Math.abs(Math.sin(now / 160 + pt.seed));
          g.fillStyle = `rgba(251,146,60,${fl})`;
          g.fillRect(pt.x, pt.y, 2, 2);
        } else if (e === 'stable') {
          // 恒纪元萤尘
          pt.x += Math.sin(now / 1400 + pt.seed) * 0.18;
          pt.y += Math.cos(now / 1700 + pt.seed) * 0.12;
          if (pt.x < 0) pt.x = W; if (pt.x > W) pt.x = 0;
          if (pt.y < 0) pt.y = H; if (pt.y > H) pt.y = 0;
          const fl = 0.2 + 0.5 * Math.abs(Math.sin(now / 600 + pt.seed));
          g.fillStyle = `rgba(254,240,180,${fl})`;
          g.fillRect(pt.x, pt.y, 1.5, 1.5);
        } else if (e === 'chaotic') {
          // 风沙横掠
          pt.vx = 1.6 + (pt.seed % 1.6); pt.vy = Math.sin(now / 800 + pt.seed) * 0.15;
          pt.x += pt.vx; pt.y += pt.vy;
          if (pt.x > W) { pt.x = -8; pt.y = Math.random() * H; }
          g.fillStyle = 'rgba(190,180,160,0.22)';
          g.fillRect(pt.x, pt.y, 6, 1);
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [world]);

  // 点击命中：人物 > 地标
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    let bestAgent: string | null = null;
    let bestD = 16;
    for (const a of societyRef.current.agents) {
      const p = posRef.current.get(a.id);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; bestAgent = a.id; }
    }
    if (bestAgent) { onSelectAgent(bestAgent === selectedRef.current ? null : bestAgent); setSelectedLoc(null); return; }
    let bestLoc: number | null = null;
    bestD = 34;
    world.anchors.forEach((a, i) => {
      const d = Math.hypot(a.tx * TILE + 24 - x, a.ty * TILE + 20 - y);
      if (d < bestD) { bestD = d; bestLoc = i; }
    });
    setSelectedLoc(bestLoc === selectedLoc ? null : bestLoc);
    if (bestLoc !== null) onSelectAgent(null);
  };

  const locOccupants = selectedLoc !== null ? society.agents.filter((a) => a.loc === selectedLoc) : [];

  return (
    <div className="absolute inset-0 z-10">
      {/* 纪元染色 */}
      <div className="pointer-events-none absolute inset-0 z-20 transition-colors duration-[2000ms]" style={{ background: ERA_TINT[era] }} />

      {/* 像素地图 */}
      <div className="absolute inset-0 overflow-hidden">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          onClick={onCanvasClick}
          className="h-full w-full cursor-pointer"
          style={{ imageRendering: 'pixelated' }}
        />

        {/* 地名标注（DOM 保证文字清晰） */}
        {society.locations.map((loc, i) => {
          const a = world.anchors[i];
          if (!a) return null;
          return (
            <div
              key={loc.name}
              className="pointer-events-none absolute rounded bg-slate-950/55 px-2 py-0.5 text-[10px] tracking-[0.5em] text-slate-300/90 backdrop-blur-sm"
              style={{ left: `${((a.tx * TILE + 24) / W) * 100}%`, top: `${((a.ty * TILE + 46) / H) * 100}%`, transform: 'translateX(-50%)' }}
            >
              {loc.name}
            </div>
          );
        })}

        {/* 地点志弹层 */}
        {selectedLoc !== null && (
          <div className="absolute bottom-3 left-3 z-20 w-64 rounded-xl border border-white/10 bg-slate-950/80 p-4 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <div className="text-xs tracking-[0.4em] text-slate-300">{society.locations[selectedLoc]?.name}</div>
              <button onClick={() => setSelectedLoc(null)} className="text-[10px] text-slate-500 hover:text-slate-300">✕</button>
            </div>
            <div className="mt-3 space-y-1.5">
              <div className="text-[10px] text-slate-500">
                {society.locations[selectedLoc]?.terrain.irrigated ? '已有引水痕迹 · ' : ''}
                压实 {Math.round(society.locations[selectedLoc]?.terrain.compaction ?? 0)} · 清理 {Math.round(society.locations[selectedLoc]?.terrain.cleared ?? 0)}
              </div>
              {(society.locations[selectedLoc]?.matter ?? []).filter((matter) => matter.quantity > 0).slice(0, 5).map((matter) => (
                <div key={`${matter.kind}-${matter.name}`} className="text-[10px] text-slate-500">{matter.name} · {Math.round(matter.quantity)}</div>
              ))}
              {locOccupants.length === 0 && <div className="text-[11px] text-slate-600">此处暂无人烟</div>}
              {locOccupants.map((a) => (
                <button
                  key={a.id}
                  onClick={() => { onSelectAgent(a.id); setSelectedLoc(null); }}
                  className="block w-full text-left text-[11px] tracking-wider text-slate-400 transition-colors hover:text-amber-200"
                >
                  {a.name} · {a.state === 'dehydrated' ? '脱水蛰伏' : a.doing}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 角色卡片：选中才弹出（五层需求 + 实际状态） */}
      {focusAgent && selectedAgentId && (() => {
        const archiveEntry = findArchiveCharacter({ id: focusAgent.id, name: focusAgent.name });
        return (
        <div className="absolute right-6 top-1/2 z-30 w-72 -translate-y-1/2 rounded-2xl border border-white/10 bg-slate-950/80 p-5 shadow-2xl backdrop-blur-md">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              {archiveEntry?.portrait && (
                <img
                  src={archiveEntry.portrait}
                  alt={focusAgent.name}
                  className="h-16 w-12 shrink-0 rounded-lg border border-white/10 object-cover"
                />
              )}
              <div>
                {archiveEntry && (
                  <div className="mb-1 text-[9px] tracking-[0.3em] text-slate-600">{archiveEntry.category} · {archiveEntry.era}</div>
                )}
                <div className="text-2xl font-extralight tracking-[0.2em] text-slate-100">{focusAgent.name}</div>
                <div className="mt-1 text-[10px] tracking-[0.3em] text-slate-500">
                  {focusAgent.state === 'active' ? '在世' : focusAgent.state === 'dehydrated' ? '脱水中' : '已死亡'} · {focusAgent.body ? `${focusAgent.body.ageYears}/${focusAgent.lifespanYears ?? '—'} 岁` : ''} · {focusAgent.sex === 'female' ? '女' : '男'} · {society.locations[focusAgent.loc]?.name}
                </div>
              </div>
            </div>
            <button className="text-[10px] text-slate-500 hover:text-slate-300" onClick={() => onSelectAgent(null)}>✕</button>
          </div>
          {focusAgent.title && <div className="mt-3 text-[11px] leading-relaxed text-slate-400">{focusAgent.title}</div>}

          {/* 马斯洛五层需求 */}
          {focusAgent.needs && (
            <div className="mt-5 space-y-2.5">
              <div className="text-[10px] tracking-[0.4em] text-slate-600">五层需求</div>
              {[...focusAgent.needs].reverse().map((l) => (
                <div key={l.level}>
                  <div className="mb-0.5 flex justify-between text-[10px] tracking-wider">
                    <span className={l.dominant ? 'text-amber-200' : 'text-slate-500'}>{l.label}{l.dominant ? ' · 主导' : ''}</span>
                    <span className="text-slate-600">{Math.round(l.intensity)}</span>
                  </div>
                  <div className="h-[3px] rounded bg-white/5">
                    <div className="h-[3px] rounded transition-all duration-700" style={{ width: `${Math.min(100, l.intensity)}%`, background: l.dominant ? '#fbbf24' : '#475569' }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 实际状态 */}
          <div className="mt-5">
            <div className="mb-2 text-[10px] tracking-[0.4em] text-slate-600">实际状态</div>
            {focusAgent.body && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] tracking-wider text-slate-400">
                <div className="flex justify-between"><span className="text-slate-600">健康</span><span>{Math.round(focusAgent.body.health)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600">营养</span><span>{Math.round(focusAgent.body.nutrition)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600">水分</span><span>{Math.round(focusAgent.body.hydration)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600">疲劳</span><span>{Math.round(focusAgent.body.fatigue)}</span></div>
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-white/5 pt-3 text-[11px] tracking-wider text-slate-400">
              <div className="flex justify-between"><span className="text-slate-600">尊重</span><span>{Math.round(focusAgent.respect ?? 0)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">世代</span><span>第 {focusAgent.generation ?? 0} 代</span></div>
              <div className="col-span-2 flex justify-between"><span className="text-slate-600">预言记录</span><span>{focusAgent.predictionRecord?.correct ?? 0} 中 · {focusAgent.predictionRecord?.failed ?? 0} 失</span></div>
              {focusAgent.pregnant && <div className="col-span-2 text-amber-200/80">妊娠中 · 暂停生产一年 · 安全需求提高</div>}
            </div>
            <div className="mt-3 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-sky-200/80">
              {focusAgent.doing}
            </div>
          </div>
        </div>
        );
      })()}

      {/* 图例（右下角，极简常驻） */}
      <div className="pointer-events-none absolute bottom-3 right-4 z-20 flex items-center gap-4 text-[9px] tracking-widest text-slate-600">
        <span className="flex items-center gap-1.5"><span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-100" /> 在世行走</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-[3px] w-3 rounded bg-amber-800" /> 脱水纤维捆</span>
      </div>
    </div>
  );
}
