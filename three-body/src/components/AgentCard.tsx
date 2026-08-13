import { useMemo, useRef, useState } from 'react';
import { findArchiveCharacter } from '@/data/characters';
import type { AgentHistoryItem, PlanView, SocietyAgent } from '@/game/societyContract';

interface Props {
  agent: SocietyAgent;
  plans: PlanView[];
  history: AgentHistoryItem[];
  historyLoading: boolean;
  worldWidth: number;
  onClose: () => void;
}

type CardTab = 'status' | 'needs' | 'history';

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

const TAB_LABELS: Array<{ id: CardTab; label: string }> = [
  { id: 'status', label: '状态' },
  { id: 'needs', label: '需求' },
  { id: 'history', label: '经历' },
];

const HISTORY_COLORS: Record<AgentHistoryItem['kind'], string> = {
  decision: 'border-amber-300/50 text-amber-100',
  action: 'border-emerald-300/35 text-emerald-100/90',
  continuation: 'border-slate-500/35 text-slate-300',
  life: 'border-rose-300/45 text-rose-100',
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第 ${Math.floor((month - 1) / 12) + 1} 年 · ${((month - 1) % 12) + 1} 月`;
}

function Meter({ label, value, inverse = false }: { label: string; value: number; inverse?: boolean }) {
  const normalized = clamp(Math.round(value), 0, 100);
  const danger = inverse ? normalized >= 72 : normalized <= 28;
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] text-slate-400"><span>{label}</span><span className="tabular-nums">{normalized}</span></div>
      <div className="h-1 overflow-hidden bg-white/10">
        <div className={`h-full ${danger ? 'bg-rose-300/80' : 'bg-amber-100/65'}`} style={{ width: `${normalized}%` }} />
      </div>
    </div>
  );
}

export default function AgentCard({ agent, plans, history, historyLoading, worldWidth, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [tab, setTab] = useState<CardTab>('status');
  const [position, setPosition] = useState({ x: 72, y: 94 });
  const archive = useMemo(() => findArchiveCharacter({ id: agent.id, name: agent.name }), [agent.id, agent.name]);
  const activePlan = agent.activePlanId ? plans.find((plan) => plan.id === agent.activePlanId) : undefined;
  const reversedHistory = useMemo(() => [...history].reverse(), [history]);

  const moveCard = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    const card = cardRef.current;
    if (!drag || !card) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    setPosition({
      x: clamp(drag.originX + clientX - drag.startX, 16, Math.max(16, window.innerWidth - width - 16)),
      y: clamp(drag.originY + clientY - drag.startY, 16, Math.max(16, window.innerHeight - height - 76)),
    });
  };

  return (
    <div
      ref={cardRef}
      className="absolute z-[18] flex h-[520px] w-[380px] flex-col overflow-hidden border border-amber-100/20 bg-[#080d12]/95 shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-xl"
      style={{ left: position.x, top: position.y }}
      aria-label={`${agent.name}人物卡`}
    >
      <div
        className="flex cursor-grab select-none items-center gap-3 border-b border-white/10 px-4 py-3 active:cursor-grabbing"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y };
        }}
        onPointerMove={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) moveCard(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
        }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        {archive?.portrait ? (
          <img src={archive.portrait} alt="" draggable={false} className="pointer-events-none h-12 w-10 border border-white/10 object-cover" />
        ) : (
          <div className="flex h-12 w-10 items-center justify-center border border-white/10 text-lg text-slate-500">{agent.name.slice(0, 1)}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base tracking-[0.22em] text-slate-100">{agent.name}</div>
          <div className="mt-1 truncate text-[10px] tracking-[0.14em] text-slate-500">{agent.generation === 0 ? '初代' : `第 ${agent.generation} 代`} · {agent.state === 'dead' ? '已故' : agent.state === 'dehydrated' ? '脱水' : '存活'} · 格 {agent.cellId % worldWidth}, {Math.floor(agent.cellId / worldWidth)}</div>
        </div>
        <button
          aria-label="关闭人物卡"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          className="self-start px-2 py-1 text-xs text-slate-500 hover:text-slate-100"
        >✕</button>
      </div>

      <div role="tablist" aria-label="人物卡片页面" className="grid grid-cols-3 border-b border-white/10">
        {TAB_LABELS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`py-2.5 text-[10px] tracking-[0.32em] transition-colors ${tab === item.id ? 'bg-amber-100/10 text-amber-100' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'status' && (
          <div className="space-y-5">
            <div>
              <div className="text-[10px] tracking-[0.32em] text-slate-500">此刻正在</div>
              <div className="mt-2 text-sm leading-6 text-slate-200">{agent.doing}</div>
              <div className="mt-2 text-xs leading-5 text-slate-500">{agent.title}</div>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-white/10 py-4">
              <Meter label="健康" value={agent.body.health} />
              <Meter label="水分" value={agent.body.hydration} />
              <Meter label="营养" value={agent.body.nutrition} />
              <Meter label="疲劳" value={agent.body.fatigue} inverse />
            </div>

            <div className="space-y-3 text-xs leading-5">
              <div><span className="mr-3 text-slate-600">想要</span><span className="text-slate-300">{agent.mind.want}</span></div>
              <div><span className="mr-3 text-slate-600">选择</span><span className="text-slate-300">{agent.mind.choice}</span></div>
              <div><span className="mr-3 text-slate-600">理解</span><span className="text-slate-300">{agent.mind.ought}</span></div>
            </div>

            {activePlan ? (
              <div className="border border-amber-100/15 bg-amber-50/[0.03] p-4 text-xs leading-5 text-slate-300">
                <div className="mb-2 flex items-center justify-between text-[10px] tracking-[0.2em] text-amber-100/75">
                  <span>长期计划 · {activePlan.mode}</span><span>{Math.round(activePlan.progress)}%</span>
                </div>
                <div>{activePlan.objective}</div>
                <div className="mt-2 text-[10px] text-slate-600">始于第 {activePlan.createdAtMonth} 月 · 最近推进第 {activePlan.lastProgressAtMonth} 月</div>
              </div>
            ) : <div className="text-xs text-slate-600">当前没有长期计划。</div>}
          </div>
        )}

        {tab === 'needs' && (
          <div>
            <div className="mb-5 text-xs leading-5 text-slate-500">需求不是固定人格标签；强度随身体、环境与经历逐月变化。</div>
            <div className="space-y-4">
              {agent.needs.map((need) => (
                <div key={need.level} className={`border-l-2 pl-3 ${need.dominant ? 'border-amber-200' : 'border-white/10'}`}>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className={need.dominant ? 'text-amber-100' : 'text-slate-300'}>{need.label}</span>
                    <span className="flex items-center gap-2 text-[10px] tabular-nums text-slate-500">{need.dominant && <span className="text-amber-200/70">当前主导</span>}{Math.round(need.intensity)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden bg-white/10">
                    <div className={need.dominant ? 'h-full bg-amber-200/80' : 'h-full bg-slate-400/45'} style={{ width: `${clamp(need.intensity, 0, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'history' && (
          <div>
            <div className="mb-4 flex items-center justify-between text-[10px] tracking-[0.18em] text-slate-600">
              <span>个人行为时间线</span><span>{history.length} 条</span>
            </div>
            {historyLoading ? <div className="py-10 text-center text-xs text-slate-600">正在翻阅个人经历…</div>
              : reversedHistory.length === 0 ? <div className="py-10 text-center text-xs text-slate-600">此刻尚无月度行为记录。</div>
                : <div className="space-y-3">
                  {reversedHistory.map((event) => (
                    <div key={event.id} className={`border-l-2 bg-white/[0.025] py-2 pl-3 pr-2 ${HISTORY_COLORS[event.kind]}`}>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="tracking-[0.16em]">{event.label}{event.usedModel ? ' · AI' : ''}</span>
                        <span className="text-slate-600">{monthLabel(event.month)}</span>
                      </div>
                      <div className="mt-1.5 text-xs leading-5 text-slate-300">{event.summary}</div>
                      <div className="mt-1 text-[9px] text-slate-700">格 {event.cellId % worldWidth}, {Math.floor(event.cellId / worldWidth)}</div>
                    </div>
                  ))}
                </div>}
          </div>
        )}
      </div>
    </div>
  );
}
