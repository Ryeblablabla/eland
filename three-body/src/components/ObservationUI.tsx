import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Activity,
  Baby,
  Bandage,
  Droplets,
  Eye,
  Heart,
  Lock,
  Moon,
  Package,
  Shield,
  Skull,
  Snowflake,
  Thermometer,
  Utensils,
  Users,
} from 'lucide-react';
import type { SimStats } from '@/components/ThreeBodyCanvas';
import type { AgentHistoryView, SocietyAgent, SocietyState, StructureView } from '@/game/societyContract';
import { STAR_STYLES } from '@/lib/threebody';
import PersonConversation from './PersonConversation';
import './ObservationUI.css';

export type FocusTarget =
  | { kind: 'agent'; id: string }
  | { kind: 'structure'; id: string }
  | { kind: 'celestial'; body: 'star'; index: number }
  | { kind: 'celestial'; body: 'planet' };

export type AgentSubtab = 'overview' | 'conversation' | 'inventory' | 'history';

export interface ObservationEvent {
  id: string;
  month: number;
  text: string;
  detail?: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  actorIds?: string[];
  sourceEventIds?: string[];
  status?: true;
}

export interface CivilizationEndingView {
  civilizationId: number;
  elapsedMonths: number;
  cause: string;
  summary: string;
}

interface FocusInspectorProps {
  target: FocusTarget | null;
  society: SocietyState | null;
  stats: SimStats | null;
  history: ObservationEvent[];
  runId: string;
  observedBranchId: string;
  observedMonth: number;
  agentHistory: AgentHistoryView | null;
  agentSubtab: AgentSubtab;
  agentHistoryLoading: boolean;
  agentHistoryError: string;
  onClose: () => void;
  onAgentSubtabChange: (subtab: AgentSubtab) => void;
}

interface CivilizationEndingProps {
  ending: CivilizationEndingView;
  onContinue: () => void;
  onOpenHistory: () => void;
}

const FOCUS_EXIT_MS = 135;
const END_EXIT_MS = 240;

const AGENT_SUBTABS: Array<{ key: AgentSubtab; label: string; shortcut?: string }> = [
  { key: 'overview', label: '概况' },
  { key: 'conversation', label: '对话', shortcut: 'C' },
  { key: 'inventory', label: '背包', shortcut: 'B' },
  { key: 'history', label: '行动', shortcut: 'H' },
];

function conciseEndingSummary(ending: CivilizationEndingView): string {
  const terminalLives = ending.summary.match(/^文明最后的\s*(\d+)\s*个生命在第\s*\d+\s*月因.+终止，没有留下生还者。$/u)?.[1];
  return terminalLives ? `最后 ${terminalLives} 人死亡，无人生还。` : ending.summary;
}

const FATE_LABELS: Record<SimStats['planetFate'], string> = {
  stable: '恒纪元',
  chaotic: '乱纪元',
  burned: '地表焚毁',
  frozen: '地表冻结',
  extinct: '星系崩解',
};

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第${Math.floor((month - 1) / 12) + 1}年 · ${((month - 1) % 12) + 1}月`;
}

function durationLabel(months: number): string {
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  if (years === 0) return `${remainder} 个月`;
  if (remainder === 0) return `${years} 年`;
  return `${years} 年 ${remainder} 个月`;
}

function agentStateLabel(agent: SocietyAgent): string {
  if (agent.state === 'dead') return '已死亡';
  if (agent.state === 'hibernating') return '脱水休眠';
  if (agent.state === 'dehydrated') return '严重缺水';
  return '活动中';
}

function AgentStateGlyph({ state }: { state: SocietyAgent['state'] }) {
  const props = { 'aria-hidden': true, size: 17, strokeWidth: 1.7 } as const;
  if (state === 'dead') return <Skull {...props} />;
  if (state === 'hibernating') return <Moon {...props} />;
  if (state === 'dehydrated') return <Droplets {...props} />;
  return <Activity {...props} />;
}

function ConditionGlyph({ kind }: { kind: string }) {
  const props = { 'aria-hidden': true, size: 15, strokeWidth: 1.7 } as const;
  if (kind === 'cold') return <Snowflake {...props} />;
  if (kind === 'heat') return <Thermometer {...props} />;
  if (kind === 'wound') return <Bandage {...props} />;
  if (kind === 'aging') return <Eye {...props} />;
  if (kind === 'pregnancy') return <Baby {...props} />;
  if (kind === 'restrained') return <Lock {...props} />;
  if (kind === 'dehydrated-hibernation') return <Moon {...props} />;
  return <Shield {...props} />;
}

function vitalityTone(value: number): 'good' | 'warning' | 'danger' {
  if (value < 25) return 'danger';
  if (value < 55) return 'warning';
  return 'good';
}

function ageLabel(months: number): string {
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return remainder ? `${years} 岁 ${remainder} 个月` : `${years} 岁`;
}

type AgentRelation = NonNullable<SocietyAgent['relations']>[number];
type RelationTone = 'close' | 'trusted' | 'guarded' | 'strained' | 'known';

function relationTone(relation: AgentRelation): RelationTone {
  if (relation.fear >= 28 && relation.fear >= Math.max(relation.trust, relation.bond)) return 'guarded';
  if (relation.trust <= -8) return 'strained';
  if (relation.bond >= 14) return 'close';
  if (relation.trust >= 14) return 'trusted';
  return 'known';
}

function relationLabel(tone: RelationTone): string {
  return {
    close: '亲近',
    trusted: '信赖',
    guarded: '戒惧',
    strained: '紧张',
    known: '熟识',
  }[tone];
}

function relationColor(tone: RelationTone): string {
  return {
    close: '#f08ca0',
    trusted: '#66d6c6',
    guarded: '#e8be66',
    strained: '#ff7182',
    known: 'rgba(255, 255, 255, 0.34)',
  }[tone];
}

function relationStrength(relation: AgentRelation): number {
  return Math.min(1, (Math.abs(relation.trust) + Math.abs(relation.bond) + relation.fear) / 90);
}

function compactName(name: string): string {
  return name.length > 6 ? `${name.slice(0, 5)}…` : name;
}

function PersonRelationGraph({ agent }: { agent: SocietyAgent }) {
  const graphId = useId().replace(/:/g, '');
  const relations = [...(agent.relations ?? [])]
    .sort((left, right) => {
      const evidence = Number(right.sourceEventIds.length > 0) - Number(left.sourceEventIds.length > 0);
      return evidence || relationStrength(right) - relationStrength(left) || left.name.localeCompare(right.name);
    })
    .slice(0, 6);
  if (!relations.length) return <p className="person-relations__empty">当前没有可投影的真实关系。</p>;

  const centerX = 180;
  const centerY = 112;
  const radiusX = 132;
  const radiusY = 76;

  return (
    <div className="person-relations" role="img" aria-label={`${agent.name}眼中的人物关系图`}>
      <svg aria-hidden="true" className="person-relations__graph" viewBox="0 0 360 248">
        <defs>
          <clipPath id={`${graphId}-center`}>
            <circle cx={centerX} cy={centerY} r="25" />
          </clipPath>
          {relations.map((relation, index) => {
            const angle = -Math.PI / 2 + (index * Math.PI * 2) / relations.length;
            return (
              <clipPath id={`${graphId}-relation-${index}`} key={relation.personId}>
                <circle
                  cx={centerX + Math.cos(angle) * radiusX}
                  cy={centerY + Math.sin(angle) * radiusY}
                  r="19"
                />
              </clipPath>
            );
          })}
        </defs>
        {relations.map((relation, index) => {
          const angle = -Math.PI / 2 + (index * Math.PI * 2) / relations.length;
          const x = centerX + Math.cos(angle) * radiusX;
          const y = centerY + Math.sin(angle) * radiusY;
          const tone = relationTone(relation);
          const color = relationColor(tone);
          const strength = relationStrength(relation);
          return (
            <g className={`person-relation person-relation--${tone}${relation.state === 'dead' ? ' person-relation--dead' : ''}`} key={relation.personId}>
              <line
                opacity={0.32 + strength * 0.56}
                stroke={color}
                strokeWidth={0.9 + strength * 2.1}
                x1={centerX}
                x2={x}
                y1={centerY}
                y2={y}
              />
              <circle className="person-relation__node-ring" cx={x} cy={y} r="23" stroke={color} />
              <circle className="person-relation__node" cx={x} cy={y} r="19" />
              {relation.portrait ? (
                <image
                  className="person-relation__portrait"
                  clipPath={`url(#${graphId}-relation-${index})`}
                  height="38"
                  href={relation.portrait}
                  preserveAspectRatio="xMidYMid slice"
                  width="38"
                  x={x - 19}
                  y={y - 19}
                />
              ) : (
                <text className="person-relation__initial" x={x} y={y + 4}>{relation.name.slice(0, 1)}</text>
              )}
              <text className="person-relation__name" x={x} y={y + 37}>{compactName(relation.name)}</text>
              <text className="person-relation__kind" fill={color} x={x} y={y + 50}>{relationLabel(tone)}</text>
              <title>{`${relation.name} · ${relationLabel(tone)} · 信任 ${relation.trust} · 亲近 ${relation.bond} · 戒惧 ${relation.fear}`}</title>
            </g>
          );
        })}
        <circle className="person-relations__center-ring" cx={centerX} cy={centerY} r="30" />
        <circle className="person-relations__center" cx={centerX} cy={centerY} r="25" />
        {agent.portrait ? (
          <image
            className={`person-relations__center-portrait${agent.state === 'dead' ? ' person-relations__center-portrait--dead' : ''}`}
            clipPath={`url(#${graphId}-center)`}
            height="50"
            href={agent.portrait}
            preserveAspectRatio="xMidYMid slice"
            width="50"
            x={centerX - 25}
            y={centerY - 25}
          />
        ) : (
          <text className="person-relations__center-initial" x={centerX} y={centerY + 5}>{agent.name.slice(0, 1)}</text>
        )}
        <text className="person-relations__center-name" x={centerX} y={centerY + 43}>{compactName(agent.name)}</text>
      </svg>
      <ul className="observation-sr-only">
        {relations.map((relation) => (
          <li key={relation.personId}>
            {relation.name}，{relationLabel(relationTone(relation))}，信任 {relation.trust}，亲近 {relation.bond}，戒惧 {relation.fear}
          </li>
        ))}
      </ul>
      <div className="person-relations__legend" aria-hidden="true">
        <span><i className="person-relations__legend-dot person-relations__legend-dot--close" />亲近</span>
        <span><i className="person-relations__legend-dot person-relations__legend-dot--trusted" />信赖</span>
        <span><i className="person-relations__legend-dot person-relations__legend-dot--guarded" />戒惧</span>
        <span><i className="person-relations__legend-dot person-relations__legend-dot--strained" />紧张</span>
      </div>
    </div>
  );
}

function PersonActionHistory({
  agent,
  history,
  loading,
  error,
}: {
  agent: SocietyAgent;
  history: AgentHistoryView | null;
  loading: boolean;
  error: string;
}) {
  const events = [...(history?.events ?? [])].reverse();
  return (
    <section aria-label={`${agent.name}的行动历史`} className="person-action-history">
      <div className="person-action-history__heading">
        <h3>行动历史</h3>
        {!loading && !error && <span>{events.length} 条</span>}
      </div>
      {loading && events.length === 0 ? (
        <p className="person-action-history__empty">正在读取真实行动记录…</p>
      ) : error ? (
        <p className="person-action-history__error">{error}</p>
      ) : events.length === 0 ? (
        <p className="person-action-history__empty">这个人物还没有可读取的行动记录。</p>
      ) : (
        <ol className="person-action-history__list">
          {events.map((event) => (
            <li className={`person-action-history__item person-action-history__item--${event.kind}`} key={event.id}>
              <div className="person-action-history__meta">
                <time>{monthLabel(event.month)}</time>
                {event.actionTick !== undefined && <span>第 {event.actionTick} 刻</span>}
              </div>
              <strong>{event.label}</strong>
              <p>{event.summary}</p>
              {event.detail && <p className="person-action-history__detail">{event.detail}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PersonInventory({ agent }: { agent: SocietyAgent }) {
  const totalQuantity = agent.inventory.reduce((sum, stack) => sum + stack.quantity, 0);
  return (
    <section aria-label={`${agent.name}的背包`} className="person-inventory">
      <div className="person-inventory__heading">
        <div>
          <p>私人持有</p>
          <h3>背包</h3>
        </div>
        <span>{agent.inventory.length} 类 · {totalQuantity} 件</span>
      </div>
      <p className="person-inventory__note">物品来自当前权威演进状态；给予、丢下或取走都会发生真实转移。</p>
      {agent.inventory.length ? (
        <ul className="person-inventory__list">
          {agent.inventory.map((stack) => (
            <li key={stack.id}>
              <span className="person-inventory__glyph" aria-hidden="true"><Package size={18} strokeWidth={1.5} /></span>
              <span className="person-inventory__name">{stack.name}</span>
              <span className="person-inventory__quantity">× {stack.quantity}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="person-inventory__empty">
          <Package aria-hidden="true" size={28} strokeWidth={1.3} />
          <p>背包是空的</p>
        </div>
      )}
    </section>
  );
}

function structureActivity(structure: StructureView): string {
  if (!structure.complete) return `正在形成，已有 ${structure.componentCount} 个权威构件`;
  const effects: string[] = [];
  if (structure.effects.weatherProtection > 0) effects.push('遮蔽天气');
  if (structure.effects.thermalInsulation > 0) effects.push('缓冲温差');
  if (structure.effects.capacity > 0) effects.push(`容纳 ${structure.effects.capacity} 人`);
  return effects.length ? effects.join(' · ') : '结构已经完成';
}

function relatedEvents(target: FocusTarget, society: SocietyState | null, history: ObservationEvent[]): ObservationEvent[] {
  const events = history.filter((entry) => !entry.status).slice().reverse();
  if (target.kind === 'agent') {
    return events.filter((entry) => entry.actorIds?.includes(target.id));
  }
  if (target.kind === 'structure') {
    const structure = society?.structures.find((item) => item.id === target.id);
    const sources = new Set(structure?.sourceEventIds ?? []);
    return events.filter((entry) => entry.sourceEventIds?.some((id) => sources.has(id)));
  }
  const eraEvents = events.filter((entry) => entry.tone === 'era');
  return eraEvents.length ? eraEvents : events;
}

function targetKey(target: FocusTarget): string {
  if (target.kind === 'celestial') return target.body === 'planet' ? 'celestial:planet' : `celestial:star:${target.index}`;
  return `${target.kind}:${target.id}`;
}

export function FocusInspector({
  target,
  society,
  stats,
  history,
  runId,
  observedBranchId,
  observedMonth,
  agentHistory,
  agentSubtab,
  agentHistoryLoading,
  agentHistoryError,
  onClose,
  onAgentSubtabChange,
}: FocusInspectorProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const personTabsId = useId().replace(/:/g, '');
  const [renderedTarget, setRenderedTarget] = useState<FocusTarget | null>(target);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (target) {
      const frame = requestAnimationFrame(() => {
        setRenderedTarget(target);
        setClosing(false);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!renderedTarget) return;
    const frame = requestAnimationFrame(() => setClosing(true));
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timerRef.current = setTimeout(() => {
      setRenderedTarget(null);
      setClosing(false);
      timerRef.current = null;
    }, reduceMotion ? 0 : FOCUS_EXIT_MS);
    return () => cancelAnimationFrame(frame);
  }, [target, renderedTarget]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const events = useMemo(
    () => renderedTarget ? relatedEvents(renderedTarget, society, history) : [],
    [history, renderedTarget, society],
  );

  if (!renderedTarget) return null;

  const agent = renderedTarget.kind === 'agent'
    ? society?.agents.find((item) => item.id === renderedTarget.id)
    : undefined;
  const structure = renderedTarget.kind === 'structure'
    ? society?.structures.find((item) => item.id === renderedTarget.id)
    : undefined;
  const latestEvent = events[0];
  const activeIntent = agent
    ? society?.intents.find((intent) => intent.ownerId === agent.id && intent.status === 'active')
    : undefined;

  let eyebrow = '天体';
  let name = '未知对象';
  let activity = '没有可读取的当前行为';
  let status = '状态不可用';

  if (agent) {
    eyebrow = '人物';
    name = agent.name;
    activity = agent.doing || activeIntent?.summary || '此刻没有明确行动';
    status = agentStateLabel(agent);
  } else if (structure) {
    eyebrow = '结构';
    name = structure.name;
    activity = structureActivity(structure);
    status = `${structure.complete ? '完整结构' : '未完成结构'} · 占据 ${structure.occupiedCells.length} 格 · ${structure.componentCount} 个构件`;
  } else if (renderedTarget.kind === 'celestial' && renderedTarget.body === 'star') {
    const star = STAR_STYLES[renderedTarget.index];
    name = star?.name ?? `恒星 ${renderedTarget.index + 1}`;
    activity = '在三星引力系统中围绕共同质心运行';
    status = stats ? `当前星系尺度 ${stats.spread.toFixed(2)} · 总能量 ${stats.energy.toFixed(4)}` : '等待轨道状态';
  } else if (renderedTarget.kind === 'celestial') {
    name = '文明行星';
    activity = '承受三星引力与辐照，地表文明随月度规则演化';
    status = stats
      ? `${FATE_LABELS[stats.planetFate]} · 相对辐照 ${stats.fluxRel.toFixed(2)} · 最近恒星 ${stats.planetDist.toFixed(2)}`
      : '等待行星状态';
  }

  const materialNames = structure?.materialIds
    ?.map((id) => society?.world.palette[id]?.name)
    .filter((value): value is string => Boolean(value)) ?? [];
  const celestialOffset = renderedTarget.kind === 'celestial'
    ? renderedTarget.body === 'planet' ? 6 : renderedTarget.index * 2
    : -1;
  const celestialPosition = stats && celestialOffset >= 0
    ? { x: stats.bodies[celestialOffset], y: stats.bodies[celestialOffset + 1] }
    : null;
  const onPersonTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
    if (currentIndex < 0) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    const nextSubtab = next?.dataset.agentSubtab as AgentSubtab | undefined;
    if (!next || !nextSubtab) return;
    onAgentSubtabChange(nextSubtab);
    next.focus();
  };
  return (
    <aside
      aria-label={`${name}聚焦信息`}
      className={`focus-inspector${agent ? ` focus-inspector--person focus-inspector--person-${agentSubtab}` : ''}${closing ? ' focus-inspector--closing' : ''}`}
      key={targetKey(renderedTarget)}
    >
      <div className="focus-inspector__scroll">
        {agent ? (
          <header className="person-header">
            <div className={`person-header__portrait person-header__portrait--${agent.state}`}>
              {agent.portrait ? (
                <img alt={`${agent.name}的头像`} draggable={false} src={agent.portrait} />
              ) : (
                <span aria-hidden="true">{agent.name.slice(0, 1)}</span>
              )}
            </div>
            <div className="person-header__identity">
              <p className="focus-inspector__eyebrow">{eyebrow} · 第 {agent.generation} 代 · {ageLabel(agent.body.ageMonths)}</p>
              <h2>{name}</h2>
            </div>
          </header>
        ) : (
          <>
            <p className="focus-inspector__eyebrow">{eyebrow}</p>
            <h2>{name}</h2>
          </>
        )}

        {agent && (
          <div
            aria-label={`${agent.name}人物信息`}
            className="person-tabs"
            onKeyDown={onPersonTabsKeyDown}
            role="tablist"
          >
            {AGENT_SUBTABS.map((tab) => {
              const selected = agentSubtab === tab.key;
              return (
                <button
                  aria-controls={`${personTabsId}-${tab.key}-panel`}
                  aria-selected={selected}
                  className={selected ? 'is-selected' : ''}
                  data-agent-subtab={tab.key}
                  id={`${personTabsId}-${tab.key}-tab`}
                  key={tab.key}
                  onClick={() => onAgentSubtabChange(tab.key)}
                  role="tab"
                  tabIndex={selected ? 0 : -1}
                  type="button"
                >
                  <span>{tab.label}</span>
                  {tab.shortcut && <kbd>{tab.shortcut}</kbd>}
                </button>
              );
            })}
          </div>
        )}

        <div
          aria-labelledby={agent ? `${personTabsId}-${agentSubtab}-tab` : undefined}
          className={agent ? `person-tabpanel person-tabpanel--${agentSubtab}` : undefined}
          id={agent ? `${personTabsId}-${agentSubtab}-panel` : undefined}
          role={agent ? 'tabpanel' : undefined}
          tabIndex={agent ? 0 : undefined}
        >
          {agentSubtab === 'inventory' && agent ? (
            <PersonInventory agent={agent} />
          ) : agentSubtab === 'conversation' && agent ? (
            <PersonConversation
              agent={agent}
              key={JSON.stringify([runId, observedBranchId, agent.id])}
              observedBranchId={observedBranchId}
              observedMonth={observedMonth}
              onShowHistory={() => {
                onAgentSubtabChange('history');
                requestAnimationFrame(() => document.getElementById(`${personTabsId}-history-tab`)?.focus());
              }}
              runId={runId}
            />
          ) : agentSubtab === 'history' && agent ? (
            <PersonActionHistory
              agent={agent}
              error={agentHistoryError}
              history={agentHistory}
              loading={agentHistoryLoading}
            />
          ) : (
          <>
            {agent ? (
              <>
            <div className="person-overview">
              <div className={`person-overview__state person-overview__state--${agent.state}`}>
                <AgentStateGlyph state={agent.state} />
                <span>{agentStateLabel(agent)}</span>
                <span className="person-overview__respect">声望 {agent.respect}</span>
              </div>
              <div className="person-vitals" aria-label="身体状态">
                <div className={`person-vital person-vital--${vitalityTone(agent.body.health)}`} title="健康">
                  <Heart aria-hidden="true" size={16} strokeWidth={1.7} />
                  <span>健康</span><strong>{Math.round(agent.body.health)}</strong>
                </div>
                <div className={`person-vital person-vital--${vitalityTone(agent.body.hydration)}`} title="水分">
                  <Droplets aria-hidden="true" size={16} strokeWidth={1.7} />
                  <span>水分</span><strong>{Math.round(agent.body.hydration)}</strong>
                </div>
                <div className={`person-vital person-vital--${vitalityTone(agent.body.nutrition)}`} title="营养">
                  <Utensils aria-hidden="true" size={16} strokeWidth={1.7} />
                  <span>营养</span><strong>{Math.round(agent.body.nutrition)}</strong>
                </div>
              </div>
              {agent.conditions.length > 0 && (
                <div className="person-conditions" aria-label="当前身体状况">
                  {agent.conditions.map((condition) => {
                    return (
                      <span className={`person-condition person-condition--stage-${condition.stage}`} key={condition.id} title={`${condition.label} · 阶段 ${condition.stage}`}>
                        <ConditionGlyph kind={condition.kind} />
                        {condition.label}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            <dl className="focus-inspector__summary focus-inspector__summary--person">
              {activeIntent ? (
                <div>
                  <dt>长期意图</dt>
                  <dd>{activeIntent.summary} · {Math.round(activeIntent.progress * 100)}%</dd>
                </div>
              ) : (
                <div><dt>内在取向</dt><dd>{agent.mind.want}</dd></div>
              )}
            </dl>
              </>
            ) : (
              <dl className="focus-inspector__summary">
                <div><dt>当前</dt><dd>{activity}</dd></div>
                <div><dt>状态</dt><dd>{status}</dd></div>
                <div>
                  <dt>最近</dt>
                  <dd>{latestEvent ? `${monthLabel(latestEvent.month)} · ${latestEvent.text}` : '尚无可关联的真实事件'}</dd>
                </div>
              </dl>
            )}

            <div className="focus-inspector__details">
            {agent && (
              <>
                <section className="person-relations-section">
                  <h3><Users aria-hidden="true" size={14} strokeWidth={1.7} />{agent.sex === 'female' ? '她' : '他'}眼中的关系</h3>
                  <PersonRelationGraph agent={agent} />
                </section>
                <section>
                  <h3><Package aria-hidden="true" size={14} strokeWidth={1.7} />随身物</h3>
                  <p>{agent.inventory.length ? agent.inventory.map((item) => `${item.name} × ${item.quantity}`).join(' · ') : '空'}</p>
                </section>
              </>
            )}

            {structure && (
              <>
                <section>
                  <h3>结构效果</h3>
                  <p>天气防护 {Math.round(structure.effects.weatherProtection)} · 隔热 {Math.round(structure.effects.thermalInsulation)} · 容量 {structure.effects.capacity}</p>
                </section>
                <section>
                  <h3>权威构件</h3>
                  <p>{materialNames.length ? materialNames.join('、') : '当前投影没有材质名称'} · 来源事件 {structure.sourceEventIds.length} 条</p>
                </section>
              </>
            )}

            {renderedTarget.kind === 'celestial' && (
              <section>
                <h3>轨道观测</h3>
                <p>{celestialPosition ? `坐标 ${celestialPosition.x.toFixed(3)}, ${celestialPosition.y.toFixed(3)}` : '等待坐标'}</p>
                {stats && <p>系统尺度 {stats.spread.toFixed(3)} · 行星辐照 {stats.fluxRel.toFixed(3)}</p>}
              </section>
            )}

            <section>
              <h3>{agent && <Eye aria-hidden="true" size={14} strokeWidth={1.7} />}关联事件</h3>
              {events.length ? events.slice(0, 4).map((event) => (
                <p className="focus-inspector__event" key={event.id}>
                  <time>{monthLabel(event.month)}</time>{event.text}
                </p>
              )) : <p>尚无可关联的事件。</p>}
            </section>
          </div>
          </>
          )}
        </div>
      </div>

      <div className="focus-inspector__actions">
        <button className="observation-button observation-button--outline" onClick={onClose} type="button">
          收起 · Esc
        </button>
      </div>
    </aside>
  );
}

export function CivilizationEnding({ ending, onContinue, onOpenHistory }: CivilizationEndingProps) {
  const continueRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    continueRef.current?.focus({ preventScroll: true });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timerRef.current = setTimeout(onContinue, reduceMotion ? 0 : END_EXIT_MS);
  };

  return (
    <section
      aria-labelledby="civilization-ending-title"
      aria-modal="true"
      className={`civilization-ending${leaving ? ' civilization-ending--leaving' : ''}`}
      role="dialog"
    >
      <div className="civilization-ending__content">
        <p className="civilization-ending__eyebrow">第 {ending.civilizationId} 号文明</p>
        <h1 id="civilization-ending-title">毁灭于{ending.cause}</h1>
        <p className="civilization-ending__duration">延续 {durationLabel(ending.elapsedMonths)}</p>
        <p className="civilization-ending__summary">{conciseEndingSummary(ending)}</p>
        <div className="civilization-ending__actions">
          <button
            className="observation-button observation-button--large observation-button--secondary"
            disabled={leaving}
            onClick={onOpenHistory}
            type="button"
          >
            查看历史
          </button>
          <button
            ref={continueRef}
            className="observation-button observation-button--large observation-button--primary"
            disabled={leaving}
            onClick={leave}
            type="button"
          >
            {leaving ? '正在远离' : '观察下一文明'}
          </button>
        </div>
      </div>
    </section>
  );
}
