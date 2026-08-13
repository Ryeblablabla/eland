import { useEffect, useMemo, useRef, useState } from 'react';
import type { EraKey, SocietyAgent, SocietyState } from '@/game/societyContract';
import { cellColor, cellCoordinates, cellLabel, interpolatePath } from '@/game/pixelworld';

interface Props {
  society: SocietyState;
  era: EraKey;
  speaker: string | null;
  focusAgent: SocietyAgent | null;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  seed: number;
}

const COMPONENT_COLOR: Record<string, string> = {
  foundation: '#80684f',
  support: '#c3955a',
  floor: '#9c784e',
  wall: '#b48658',
  opening: '#161718',
  roof: '#754d3d',
};

export default function SocietyMap({ society, era, speaker, focusAgent, selectedAgentId, onSelectAgent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationStart = useRef(performance.now());
  const [selectedCell, setSelectedCell] = useState<number | null>(focusAgent?.cellId ?? null);
  const world = society.world;

  useEffect(() => { animationStart.current = performance.now(); }, [society]);
  useEffect(() => { if (focusAgent) setSelectedCell(focusAgent.cellId); }, [focusAgent?.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const scale = 12;
    canvas.width = world.width * scale;
    canvas.height = world.height * scale;
    context.imageSmoothingEnabled = false;
    let frame = 0;
    let handle = 0;
    const draw = (now: number) => {
      const motion = Math.min(1, (now - animationStart.current) / 1_800);
      context.fillStyle = '#10151a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (let cellId = 0; cellId < world.width * world.height; cellId += 1) {
        const { x, y } = cellCoordinates(cellId, world.width);
        const color = cellColor(world, cellId);
        context.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
        context.fillRect(x * scale, y * scale, scale, scale);
        const traffic = world.traces.traffic[cellId];
        if (traffic >= 3) {
          context.fillStyle = `rgba(194,166,118,${Math.min(0.62, traffic / 28)})`;
          context.fillRect(x * scale + 3, y * scale + 5, scale - 6, scale - 7);
        }
        if (world.traces.gathering[cellId] > 0) {
          context.fillStyle = 'rgba(214,225,166,0.6)';
          context.fillRect(x * scale + 1, y * scale + 1, 2, 2);
        }
      }

      for (const matter of society.matter) {
        if (matter.quantity <= 0) continue;
        const { x, y } = cellCoordinates(matter.cellId, world.width);
        context.fillStyle = matter.kind === 'berries' ? '#d7616c' : matter.kind === 'wood' ? '#5b3926' : matter.kind === 'stone' ? '#b5b1a7' : '#9c6948';
        context.fillRect(x * scale + 4, y * scale + 4, 4, 4);
      }

      for (const component of society.components) {
        const { x, y } = cellCoordinates(component.cellId, world.width);
        context.fillStyle = COMPONENT_COLOR[component.kind] ?? '#d1a66d';
        const inset = component.kind === 'roof' ? 1 : component.kind === 'support' ? 4 : 2;
        context.fillRect(x * scale + inset, y * scale + inset, scale - inset * 2, scale - inset * 2);
      }

      for (const agent of society.agents) {
        const path = agent.lastPath.length ? agent.lastPath : [agent.cellId];
        const point = interpolatePath(path, world.width, motion);
        const x = (point.x + 0.5) * scale;
        const y = (point.y + 0.5) * scale;
        context.beginPath();
        context.fillStyle = agent.state === 'dead' ? '#424852' : agent.id === selectedAgentId ? '#fde68a' : agent.name === speaker ? '#fbbf24' : '#f2efe6';
        context.arc(x, y, agent.id === selectedAgentId ? 4.2 : 3.2, 0, Math.PI * 2);
        context.fill();
        if (agent.state !== 'dead') {
          context.fillStyle = '#111827';
          context.fillRect(x - 1, y - 1, 2, 2);
        }
      }

      if (selectedCell !== null) {
        const { x, y } = cellCoordinates(selectedCell, world.width);
        context.strokeStyle = '#fde68a';
        context.lineWidth = 1.5;
        context.strokeRect(x * scale + 0.75, y * scale + 0.75, scale - 1.5, scale - 1.5);
      }
      frame += 1;
      if (motion < 1 || frame % 20 === 0) handle = requestAnimationFrame(draw);
      else handle = requestAnimationFrame(draw);
    };
    handle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(handle);
  }, [society, selectedAgentId, selectedCell, speaker, world]);

  const cellMatter = useMemo(() => selectedCell === null ? [] : society.matter.filter((matter) => matter.cellId === selectedCell), [selectedCell, society.matter]);
  const cellStructures = useMemo(() => selectedCell === null ? [] : society.structures.filter((structure) => structure.occupiedCells.includes(selectedCell)), [selectedCell, society.structures]);
  const cellAgents = useMemo(() => selectedCell === null ? [] : society.agents.filter((agent) => agent.cellId === selectedCell), [selectedCell, society.agents]);
  const activePlan = focusAgent?.activePlanId ? society.plans.find((plan) => plan.id === focusAgent.activePlanId) : undefined;

  const pickCell = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / rect.width * world.width);
    const y = Math.floor((event.clientY - rect.top) / rect.height * world.height);
    const cellId = y * world.width + x;
    setSelectedCell(cellId);
    const agent = society.agents.find((item) => item.cellId === cellId);
    if (agent) onSelectAgent(agent.id);
  };

  return (
    <div className="absolute inset-0 z-[5] bg-[#071013]/95">
      <div className="absolute inset-0 flex items-center justify-center p-10 pr-[340px]">
        <canvas
          ref={canvasRef}
          onClick={pickCell}
          className="max-h-full max-w-full cursor-crosshair border border-white/10 shadow-[0_0_80px_rgba(4,10,12,0.9)]"
          style={{ imageRendering: 'pixelated', aspectRatio: `${world.width}/${world.height}` }}
        />
      </div>

      <div className="absolute left-10 top-8 text-[10px] tracking-[0.45em] text-slate-300/70">
        权威地表 · {world.width} × {world.height} · {era === 'stable' ? '恒纪元' : '乱纪元'}
      </div>

      <aside className="absolute bottom-6 right-6 top-6 w-[300px] overflow-y-auto border border-white/10 bg-slate-950/80 p-5 backdrop-blur-md">
        <div className="text-[10px] tracking-[0.4em] text-amber-100/70">CELL INSPECTOR</div>
        {selectedCell === null ? <p className="mt-6 text-xs text-slate-500">点击任意像素查看真实格状态。</p> : (
          <>
            <div className="mt-4 text-lg tracking-[0.2em] text-slate-100">{cellLabel(selectedCell, world.width)}</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <span>高度 {world.cells.elevation[selectedCell]}</span>
              <span>肥力 {world.cells.fertility[selectedCell]}</span>
              <span>水深 {world.cells.waterDepth[selectedCell]}</span>
              <span>植被 {world.cells.vegetation[selectedCell]}</span>
              <span>通行 {world.traces.traffic[selectedCell]}</span>
              <span>休息 {world.traces.rest[selectedCell]}</span>
            </div>
            <div className="mt-5 space-y-2">
              {cellAgents.map((agent) => (
                <button key={agent.id} onClick={() => onSelectAgent(agent.id)} className="block w-full border-l border-white/10 pl-3 text-left text-xs text-slate-300">
                  {agent.name} · {agent.doing}
                </button>
              ))}
              {cellMatter.map((matter) => (
                <button key={matter.id} className="block w-full border-l border-white/10 pl-3 text-left text-xs text-slate-300">
                  {matter.name} × {matter.quantity}
                </button>
              ))}
              {cellStructures.map((structure) => <div key={structure.id} className="border-l border-amber-200/30 pl-3 text-xs text-amber-100/80">{structure.name} · {structure.componentCount}/7 构件 · 防护 {Math.round(structure.effects.weatherProtection)}</div>)}
              {!cellAgents.length && !cellMatter.length && !cellStructures.length && <div className="text-xs text-slate-600">这格尚无人物、物质或构件。</div>}
            </div>
          </>
        )}

        {focusAgent && (
          <div className="mt-8 border-t border-white/10 pt-5">
            <div className="text-sm tracking-[0.25em] text-slate-100">{focusAgent.name}</div>
            <div className="mt-2 text-xs leading-5 text-slate-400">{focusAgent.doing}</div>
            <div className="mt-3 text-[11px] text-slate-500">水分 {Math.round(focusAgent.body.hydration)} · 营养 {Math.round(focusAgent.body.nutrition)} · 疲劳 {Math.round(focusAgent.body.fatigue)}</div>
            {activePlan && <div className="mt-4 border border-white/10 p-3 text-[11px] leading-5 text-slate-300"><div className="text-amber-100/80">长期计划 · {activePlan.mode}</div><div>{activePlan.objective}</div><div className="text-slate-500">进度 {Math.round(activePlan.progress)}% · 始于第 {activePlan.createdAtMonth} 月</div></div>}
          </div>
        )}
      </aside>
    </div>
  );
}
