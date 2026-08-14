import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AgentCard from '@/components/AgentCard';
import type { AgentHistoryItem, EraKey, SocietyAgent, SocietyState } from '@/game/societyContract';
import { cellColor, cellCoordinates, cellLabel, interpolatePath } from '@/game/pixelworld';

interface Props {
  society: SocietyState;
  era: EraKey;
  speaker: string | null;
  focusAgent: SocietyAgent | null;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  agentHistory: AgentHistoryItem[];
  agentHistoryLoading: boolean;
  seed: number;
}

interface CameraState {
  zoom: number;
  panX: number;
  panY: number;
}

interface ViewGeometry {
  width: number;
  height: number;
  cellSize: number;
  originX: number;
  originY: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
  moved: boolean;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const VIEW_PADDING = 24;
const RULE_ACTION_TICKS_PER_MONTH = 15;
const MONTH_PLAYBACK_MS = 3_000;

function viewGeometry(camera: CameraState, viewportWidth: number, viewportHeight: number, worldWidth: number, worldHeight: number): ViewGeometry {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const fitCellSize = Math.max(1, Math.min(
    (width - VIEW_PADDING * 2) / worldWidth,
    (height - VIEW_PADDING * 2) / worldHeight,
  ));
  const cellSize = fitCellSize * camera.zoom;
  return {
    width,
    height,
    cellSize,
    originX: (width - worldWidth * cellSize) / 2 + camera.panX,
    originY: (height - worldHeight * cellSize) / 2 + camera.panY,
  };
}

function clampCamera(camera: CameraState, viewportWidth: number, viewportHeight: number, worldWidth: number, worldHeight: number): CameraState {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom));
  const geometry = viewGeometry({ ...camera, zoom, panX: 0, panY: 0 }, viewportWidth, viewportHeight, worldWidth, worldHeight);
  const maxPanX = Math.max(0, (worldWidth * geometry.cellSize - geometry.width) / 2);
  const maxPanY = Math.max(0, (worldHeight * geometry.cellSize - geometry.height) / 2);
  return {
    zoom,
    panX: Math.max(-maxPanX, Math.min(maxPanX, camera.panX)),
    panY: Math.max(-maxPanY, Math.min(maxPanY, camera.panY)),
  };
}

export default function SocietyMap({ society, era, speaker, focusAgent, selectedAgentId, onSelectAgent, agentHistory, agentHistoryLoading }: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationStart = useRef(performance.now());
  const cameraRef = useRef<CameraState>({ zoom: 1, panX: 0, panY: 0 });
  const dragRef = useRef<DragState | null>(null);
  const [camera, setCamera] = useState<CameraState>(cameraRef.current);
  const [dragging, setDragging] = useState(false);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [selectedCell, setSelectedCell] = useState<number | null>(focusAgent?.cellId ?? null);
  const world = society.world;

  useEffect(() => { animationStart.current = performance.now(); }, [society]);
  useEffect(() => { if (focusAgent) setSelectedCell(focusAgent.cellId); }, [focusAgent?.cellId]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const next = clampCamera(cameraRef.current, viewport.clientWidth, viewport.clientHeight, world.width, world.height);
      cameraRef.current = next;
      setCamera(next);
      setViewportRevision((revision) => revision + 1);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [world.height, world.width]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    canvas.width = Math.max(1, Math.round(viewportWidth * pixelRatio));
    canvas.height = Math.max(1, Math.round(viewportHeight * pixelRatio));
    context.imageSmoothingEnabled = false;
    let frame = 0;
    let handle = 0;
    const draw = (now: number) => {
      const geometry = viewGeometry(camera, viewportWidth, viewportHeight, world.width, world.height);
      const scale = geometry.cellSize;
      const motion = Math.min(1, (now - animationStart.current) / MONTH_PLAYBACK_MS);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.fillStyle = '#10151a';
      context.fillRect(0, 0, viewportWidth, viewportHeight);
      context.save();
      context.translate(geometry.originX, geometry.originY);
      for (let cellId = 0; cellId < world.width * world.height; cellId += 1) {
        const { x, y } = cellCoordinates(cellId, world.width);
        const color = cellColor(world, cellId);
        context.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
        context.fillRect(x * scale, y * scale, scale, scale);
        const traffic = world.activity.traffic[cellId];
        if (traffic >= 3) {
          context.fillStyle = `rgba(194,166,118,${Math.min(0.62, traffic / 28)})`;
          context.fillRect(x * scale + scale * 0.3, y * scale + scale * 0.42, scale * 0.4, scale * 0.25);
        }
        if (world.activity.transfer[cellId] > 0) {
          context.fillStyle = 'rgba(214,225,166,0.6)';
          context.fillRect(x * scale + scale * 0.12, y * scale + scale * 0.12, Math.max(2, scale * 0.16), Math.max(2, scale * 0.16));
        }
      }

      for (const drop of society.drops) {
        if (drop.quantity <= 0) continue;
        const { x, y } = cellCoordinates(drop.cellId, world.width);
        const material = world.palette[drop.materialId];
        const [r, g, b] = material?.color ?? [156, 105, 72];
        context.fillStyle = `rgb(${r},${g},${b})`;
        context.fillRect(x * scale + scale * 0.33, y * scale + scale * 0.33, scale * 0.34, scale * 0.34);
      }

      for (const agent of society.agents) {
        const path = agent.tickPath.length === RULE_ACTION_TICKS_PER_MONTH + 1 ? agent.tickPath : agent.lastPath.length ? agent.lastPath : [agent.cellId];
        const point = interpolatePath(path, world.width, motion);
        const x = (point.x + 0.5) * scale;
        const y = (point.y + 0.5) * scale;
        context.beginPath();
        context.fillStyle = agent.state === 'dead' ? '#424852' : agent.id === selectedAgentId ? '#fde68a' : agent.name === speaker ? '#fbbf24' : '#f2efe6';
        const radius = Math.max(3, Math.min(agent.id === selectedAgentId ? scale * 0.36 : scale * 0.27, 10));
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        if (agent.state !== 'dead') {
          context.fillStyle = '#111827';
          const eye = Math.max(2, Math.min(4, scale * 0.14));
          context.fillRect(x - eye / 2, y - eye / 2, eye, eye);
        }
      }

      if (selectedCell !== null) {
        const { x, y } = cellCoordinates(selectedCell, world.width);
        context.strokeStyle = '#fde68a';
        context.lineWidth = Math.max(1.5, Math.min(3, scale * 0.08));
        const inset = context.lineWidth / 2;
        context.strokeRect(x * scale + inset, y * scale + inset, scale - context.lineWidth, scale - context.lineWidth);
      }
      context.restore();
      context.fillStyle = 'rgba(9, 14, 19, 0.74)';
      context.fillRect(14, 14, 112, 28);
      context.fillStyle = '#d8e0e8';
      context.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textBaseline = 'middle';
      context.fillText(`规则刻度 ${Math.min(RULE_ACTION_TICKS_PER_MONTH, Math.max(1, Math.ceil(motion * RULE_ACTION_TICKS_PER_MONTH)))}/15`, 24, 28);
      frame += 1;
      if (motion < 1 || frame % 20 === 0) handle = requestAnimationFrame(draw);
      else handle = requestAnimationFrame(draw);
    };
    handle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(handle);
  }, [camera, society, selectedAgentId, selectedCell, speaker, viewportRevision, world]);

  const cellDrops = useMemo(() => selectedCell === null ? [] : society.drops.filter((drop) => drop.cellId === selectedCell), [selectedCell, society.drops]);
  const cellStructures = useMemo(() => selectedCell === null ? [] : society.structures.filter((structure) => structure.occupiedCells.includes(selectedCell)), [selectedCell, society.structures]);
  const cellAgents = useMemo(() => selectedCell === null ? [] : society.agents.filter((agent) => agent.cellId === selectedCell), [selectedCell, society.agents]);

  const commitCamera = useCallback((next: CameraState) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const clamped = clampCamera(next, viewport.clientWidth, viewport.clientHeight, world.width, world.height);
    cameraRef.current = clamped;
    setCamera(clamped);
  }, [world.height, world.width]);

  const zoomAt = useCallback((requestedZoom: number, anchorX?: number, anchorY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const current = cameraRef.current;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requestedZoom));
    const geometry = viewGeometry(current, viewport.clientWidth, viewport.clientHeight, world.width, world.height);
    const x = anchorX ?? geometry.width / 2;
    const y = anchorY ?? geometry.height / 2;
    const worldX = (x - geometry.originX) / geometry.cellSize;
    const worldY = (y - geometry.originY) / geometry.cellSize;
    const nextCellSize = geometry.cellSize / current.zoom * nextZoom;
    commitCamera({
      zoom: nextZoom,
      panX: x - worldX * nextCellSize - (geometry.width - world.width * nextCellSize) / 2,
      panY: y - worldY * nextCellSize - (geometry.height - world.height * nextCellSize) / 2,
    });
  }, [commitCamera, world.height, world.width]);

  const pickCell = useCallback((clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const geometry = viewGeometry(cameraRef.current, rect.width, rect.height, world.width, world.height);
    const x = Math.floor((clientX - rect.left - geometry.originX) / geometry.cellSize);
    const y = Math.floor((clientY - rect.top - geometry.originY) / geometry.cellSize);
    if (x < 0 || x >= world.width || y < 0 || y >= world.height) return;
    const cellId = y * world.width + x;
    setSelectedCell(cellId);
    const agent = society.agents.find((item) => item.cellId === cellId);
    onSelectAgent(agent?.id ?? null);
  }, [onSelectAgent, society.agents, world.height, world.width]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: cameraRef.current.panX,
      startPanY: cameraRef.current.panY,
      moved: false,
    };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) >= 4) drag.moved = true;
    if (drag.moved) commitCamera({ zoom: cameraRef.current.zoom, panX: drag.startPanX + dx, panY: drag.startPanY + dy });
  };

  const finishPointer = (event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && !drag.moved) pickCell(event.clientX, event.clientY);
    dragRef.current = null;
    setDragging(false);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(cameraRef.current.zoom * factor, event.clientX - rect.left, event.clientY - rect.top);
  };

  return (
    <div className="absolute inset-0 z-[5] bg-[#071013]/95">
      <div
        ref={viewportRef}
        className="absolute bottom-20 left-10 right-[340px] top-16 overflow-hidden border border-white/10 bg-[#10151a] shadow-[0_0_80px_rgba(4,10,12,0.9)]"
      >
        <canvas
          ref={canvasRef}
          aria-label="像素世界地图，可拖拽平移并滚轮缩放"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finishPointer(event)}
          onPointerCancel={(event) => finishPointer(event, true)}
          onWheel={onWheel}
          className={`absolute inset-0 h-full w-full ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ imageRendering: 'pixelated', touchAction: 'none' }}
        />

        <div className="pointer-events-none absolute bottom-3 left-3 text-[9px] tracking-[0.2em] text-slate-300/50">
          拖拽移动 · 滚轮缩放 · 点击选格
        </div>

        <div className="absolute right-3 top-3 flex items-center border border-white/10 bg-slate-950/75 text-[10px] text-slate-300 backdrop-blur-md">
          <button aria-label="缩小地图" onClick={() => zoomAt(cameraRef.current.zoom / 1.5)} className="h-8 w-9 border-r border-white/10 text-base hover:bg-white/10">−</button>
          <button aria-label="复位地图视角" onClick={() => commitCamera({ zoom: 1, panX: 0, panY: 0 })} className="h-8 min-w-16 px-3 tabular-nums hover:bg-white/10">{Math.round(camera.zoom * 100)}%</button>
          <button aria-label="放大地图" onClick={() => zoomAt(cameraRef.current.zoom * 1.5)} className="h-8 w-9 border-l border-white/10 text-base hover:bg-white/10">＋</button>
        </div>
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
              <span>最高层 {world.elevation[selectedCell]}</span>
              <span>层数 {world.columns[selectedCell].length}</span>
            </div>
            <div className="mt-4 border-y border-white/10 py-3">
              <div className="mb-2 text-[9px] tracking-[0.22em] text-slate-600">物质柱 · 自上而下</div>
              <div className="space-y-1 text-xs text-slate-300">{world.columns[selectedCell].map((materialId, index) => {
                const material = world.palette[materialId];
                return <div key={`${materialId}-${index}`} className="flex items-center justify-between"><span>{index === 0 ? '表面' : `下层 ${index}`} · {material?.name ?? '未知物质'}</span><span className="text-slate-700">#{materialId}</span></div>;
              })}</div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-600">
              <span>近 史通行 {world.activity.traffic[selectedCell]}</span>
              <span>转移 {world.activity.transfer[selectedCell]}</span>
              <span>作用 {world.activity.action[selectedCell]}</span>
              <span>观察 {world.activity.attention[selectedCell]}</span>
            </div>
            <div className="mt-5 space-y-2">
              {cellAgents.map((agent) => (
                <button key={agent.id} onClick={() => onSelectAgent(agent.id)} className="block w-full border-l border-white/10 pl-3 text-left text-xs text-slate-300">
                  {agent.name} · 高度 {agent.z} · {agent.doing}
                </button>
              ))}
              {cellDrops.map((drop) => (
                <button key={drop.id} className="block w-full border-l border-white/10 pl-3 text-left text-xs text-slate-300">
                  高度 {drop.z} 的物品 · {drop.name} × {drop.quantity}
                </button>
              ))}
              {cellStructures.map((structure) => <div key={structure.id} className="border-l border-amber-200/30 pl-3 text-xs text-amber-100/80">{structure.name} · 内部高度 {structure.interiorPositions.filter((position) => position.cellId === selectedCell).map((position) => position.z).join('、') || '无'} · 防护 {Math.round(structure.effects.weatherProtection)}</div>)}
              {!cellAgents.length && !cellDrops.length && !cellStructures.length && <div className="text-xs text-slate-600">这格只有物质柱，没有地面实体。</div>}
            </div>
          </>
        )}

      </aside>

      {selectedAgentId && focusAgent?.id === selectedAgentId && (
        <AgentCard
          key={focusAgent.id}
          agent={focusAgent}
          intents={society.intents}
          history={agentHistory}
          historyLoading={agentHistoryLoading}
          worldWidth={world.width}
          onClose={() => onSelectAgent(null)}
        />
      )}
    </div>
  );
}
