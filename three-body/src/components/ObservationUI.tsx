import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Activity,
  Award,
  Baby,
  Backpack,
  Bandage,
  Brain,
  Droplets,
  Eye,
  Heart,
  Lock,
  MessageCircle,
  Moon,
  Package,
  Shield,
  Skull,
  Snowflake,
  Thermometer,
  UserRound,
  Utensils,
  Users,
  X,
} from 'lucide-react';
import type { AgentMemoryView, SocietyAgent, SocietyState, StructureView } from '@/game/societyContract';
import PersonConversation from './PersonConversation';
import './ObservationUI.css';

export type FocusTarget =
  | { kind: 'agent'; id: string }
  | { kind: 'structure'; id: string };

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

interface FocusInspectorProps {
  target: FocusTarget | null;
  society: SocietyState | null;
  history: ObservationEvent[];
  runId: string;
  observedBranchId: string;
  observedMonth: number;
  agentMemory: AgentMemoryView | null;
  agentSubtab: AgentSubtab;
  agentMemoryLoading: boolean;
  agentMemoryError: string;
  onEnterEmbodiment?: (agentId: string) => void;
  onClose: () => void;
  onAgentSubtabChange: (subtab: AgentSubtab) => void;
}

const FOCUS_EXIT_MS = 135;

const AGENT_SUBTABS = [
  { key: 'overview', label: '概况', icon: UserRound },
  { key: 'conversation', label: '对话', shortcut: 'C', icon: MessageCircle },
  { key: 'inventory', label: '背包', shortcut: 'B', icon: Backpack },
  { key: 'history', label: '记忆', shortcut: 'H', icon: Brain },
] satisfies Array<{
  key: AgentSubtab;
  label: string;
  shortcut?: string;
  icon: typeof UserRound;
}>;

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第${Math.floor((month - 1) / 12) + 1}年 · ${((month - 1) % 12) + 1}月`;
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
  if (!relations.length) return <p className="person-relations__empty">暂无关系记录</p>;

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

const PERSON_MIND_SECTION_TITLES = ['当前未决', '近期证据', '已学结论'] as const;
const PERSON_MIND_SECTION_ALIASES: Record<string, typeof PERSON_MIND_SECTION_TITLES[number]> = {
  当前未决: '当前未决',
  近期证据: '近期证据',
  已学结论: '已学结论',
  当前关切: '当前未决',
  经历: '近期证据',
  信念: '已学结论',
};

interface PersonMindSection {
  title: typeof PERSON_MIND_SECTION_TITLES[number];
  entries: string[];
}

function parsePersonMindMarkdown(markdown: string): PersonMindSection[] {
  const entriesByTitle = new Map<string, string[]>();
  let currentTitle: string | undefined;
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const heading = /^#\s+(.+)$/u.exec(line)?.[1];
    const normalizedHeading = heading ? PERSON_MIND_SECTION_ALIASES[heading] : undefined;
    if (normalizedHeading) {
      currentTitle = normalizedHeading;
      entriesByTitle.set(currentTitle, []);
      continue;
    }
    if (heading) currentTitle = undefined;
    if (!currentTitle || !line || line === '_无_' || line.startsWith('<!--')) continue;
    const entry = /^-\s+(?:\[[mgd]\d+\]\s*)?(.+)$/u.exec(line)?.[1];
    if (entry) entriesByTitle.get(currentTitle)?.push(entry);
  }
  return PERSON_MIND_SECTION_TITLES.map((title) => ({
    title,
    entries: entriesByTitle.get(title) ?? [],
  }));
}

function PersonMemory({
  agent,
  memory,
  loading,
  error,
}: {
  agent: SocietyAgent;
  memory: AgentMemoryView | null;
  loading: boolean;
  error: string;
}) {
  const sections = useMemo(
    () => parsePersonMindMarkdown(memory?.markdown ?? ''),
    [memory?.markdown],
  );
  const entryCount = sections.reduce((sum, section) => sum + section.entries.length, 0);
  return (
    <section aria-label={`${agent.name}此刻能想起的记忆`} className="person-action-history">
      <div className="person-action-history__heading">
        <h3>心智记忆</h3>
        {!loading && !error && <span>{entryCount} 条</span>}
      </div>
      <p className="person-action-history__detail">这是人物此刻保存下来的记忆文档。经历会模糊或遗忘，想法也不一定等于事实。</p>
      {loading && !memory?.markdown ? (
        <p className="person-action-history__empty">正在回忆…</p>
      ) : error ? (
        <p className="person-action-history__error">{error}</p>
      ) : !memory?.markdown ? (
        <p className="person-action-history__empty">此刻还没有形成记忆文档</p>
      ) : (
        <div className="person-mind-sections">
          {sections.map((section) => (
            <section className="person-mind-section" key={section.title}>
              <h4>{section.title}</h4>
              {section.entries.length ? (
                <ul>
                  {section.entries.map((entry, index) => <li key={`${section.title}-${index}`}>{entry}</li>)}
                </ul>
              ) : (
                <p>暂无</p>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function PersonInventory({ agent }: { agent: SocietyAgent }) {
  const totalQuantity = agent.inventory.reduce((sum, stack) => sum + stack.quantity, 0);
  return (
    <section aria-label={`${agent.name}的背包`} className="person-inventory">
      <div className="person-inventory__heading">
        <h3>背包</h3>
        <span>{agent.inventory.length} 类 · {totalQuantity} 件</span>
      </div>
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
  if (!structure.complete) return `正在形成，已有 ${structure.componentCount} 个构件`;
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
  return [];
}

function targetKey(target: FocusTarget): string {
  return `${target.kind}:${target.id}`;
}

export function FocusInspector({
  target,
  society,
  history,
  runId,
  observedBranchId,
  observedMonth,
  agentMemory,
  agentSubtab,
  agentMemoryLoading,
  agentMemoryError,
  onEnterEmbodiment,
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

  let eyebrow = '对象';
  let name = '未知对象';
  let activity = '没有可读取的当前行为';
  let status = '状态不可用';

  if (agent) {
    eyebrow = '人物';
    name = agent.name;
    activity = agent.activity.reason || agent.doing || activeIntent?.summary || '此刻没有明确行动';
    const activityLabel = agent.activity.kind === 'travelling'
      ? '赶路'
      : agent.activity.kind === 'acting'
        ? '行动中'
        : agent.activity.kind === 'waiting'
          ? '等待'
          : '空闲';
    const activityMonths = Math.max(1, observedMonth - agent.activity.sinceMonth + 1);
    status = `${agentStateLabel(agent)} · ${activityLabel}${activityMonths > 1 ? ` ${activityMonths} 个月` : ''}`;
  } else if (structure) {
    eyebrow = '结构';
    name = structure.name;
    activity = structureActivity(structure);
    status = `${structure.complete ? '完整结构' : '未完成结构'} · 占据 ${structure.occupiedCells.length} 格 · ${structure.componentCount} 个构件`;
  }

  const materialNames = structure?.materialIds
    ?.map((id) => society?.world.palette[id]?.name)
    .filter((value): value is string => Boolean(value)) ?? [];
  const materialSummary = [...materialNames.reduce((counts, material) => {
    counts.set(material, (counts.get(material) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].map(([material, count]) => count > 1 ? `${material} × ${count}` : material).join(' · ');
  const structureEffectText = structure && (
    structure.effects.weatherProtection > 0
    || structure.effects.thermalInsulation > 0
    || structure.effects.capacity > 0
  )
    ? [
        structure.effects.weatherProtection > 0 ? `天气防护 ${Math.round(structure.effects.weatherProtection)}` : '',
        structure.effects.thermalInsulation > 0 ? `隔热 ${Math.round(structure.effects.thermalInsulation)}` : '',
        structure.effects.capacity > 0 ? `容量 ${structure.effects.capacity}` : '',
      ].filter(Boolean).join(' · ')
    : '尚未形成有效防护';
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
      className={`focus-inspector${agent ? ` focus-inspector--person focus-inspector--person-${agentSubtab}` : ''}${structure ? ' focus-inspector--structure' : ''}${closing ? ' focus-inspector--closing' : ''}`}
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
              <div className="person-header__title-row">
                <h2>{name}</h2>
                <div aria-label="当前状态" className="person-header__statuses">
                  <span className={`person-header__state person-header__state--${agent.state}`}>
                    <AgentStateGlyph state={agent.state} />
                    {agentStateLabel(agent)}
                  </span>
                  {agent.conditions.map((condition) => (
                    <span
                      className={`person-header__condition person-header__condition--stage-${condition.stage}`}
                      key={condition.id}
                      title={`${condition.label} · 阶段 ${condition.stage}`}
                    >
                      <ConditionGlyph kind={condition.kind} />
                      {condition.label}
                    </span>
                  ))}
                  {(agent.traits ?? []).map((trait) => (
                    <span className="person-header__trait" key={trait.id} title={trait.description}>
                      {trait.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </header>
        ) : structure ? (
          <header className="structure-inspector__header">
            <div><p className="focus-inspector__eyebrow">{eyebrow}</p><h2>{name}</h2></div>
            <button aria-label="收起结构信息" onClick={onClose} type="button"><X size={17} /></button>
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
              const TabIcon = tab.icon;
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
                  <TabIcon aria-hidden="true" size={18} strokeWidth={1.8} />
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
            <PersonMemory
              agent={agent}
              error={agentMemoryError}
              memory={agentMemory}
              loading={agentMemoryLoading}
            />
          ) : (
          <>
            {agent ? (
              <>
            <div className="person-overview">
              <div className="person-vitals" aria-label="人物状态数值">
                <div
                  aria-label={`健康 ${Math.round(agent.body.health)}`}
                  className={`person-vital person-vital--${vitalityTone(agent.body.health)}`}
                  title="健康"
                >
                  <Heart aria-hidden="true" size={18} strokeWidth={1.8} />
                  <strong>{Math.round(agent.body.health)}</strong>
                </div>
                <div
                  aria-label={`水分 ${Math.round(agent.body.hydration)}`}
                  className={`person-vital person-vital--${vitalityTone(agent.body.hydration)}`}
                  title="水分"
                >
                  <Droplets aria-hidden="true" size={18} strokeWidth={1.8} />
                  <strong>{Math.round(agent.body.hydration)}</strong>
                </div>
                <div
                  aria-label={`营养 ${Math.round(agent.body.nutrition)}`}
                  className={`person-vital person-vital--${vitalityTone(agent.body.nutrition)}`}
                  title="营养"
                >
                  <Utensils aria-hidden="true" size={18} strokeWidth={1.8} />
                  <strong>{Math.round(agent.body.nutrition)}</strong>
                </div>
                <div aria-label={`声望 ${agent.respect}`} className="person-vital person-vital--respect" title="声望">
                  <Award aria-hidden="true" size={18} strokeWidth={1.8} />
                  <strong>{agent.respect}</strong>
                </div>
              </div>
            </div>

            <dl className="focus-inspector__summary focus-inspector__summary--person">
              {activeIntent ? (
                <div>
                  <dt aria-label="长期意图" title="长期意图">
                    <Brain aria-hidden="true" size={18} strokeWidth={1.8} />
                  </dt>
                  <dd>{activeIntent.summary} · {Math.round(activeIntent.progress * 100)}%</dd>
                </div>
              ) : (
                <div>
                  <dt aria-label="内在取向" title="内在取向">
                    <Brain aria-hidden="true" size={18} strokeWidth={1.8} />
                  </dt>
                  <dd>{agent.mind.want}</dd>
                </div>
              )}
            </dl>
              </>
            ) : structure ? (
              <div className="structure-inspector__summary">
                <p>{activity}</p>
                <div aria-label="结构状态">
                  <span>{structure.complete ? '完整' : '形成中'}</span>
                  <span>{structure.occupiedCells.length} 格</span>
                  <span>{structure.componentCount} 个构件</span>
                </div>
              </div>
            ) : (
              <dl className="focus-inspector__summary">
                <div><dt>当前</dt><dd>{activity}</dd></div>
                <div><dt>状态</dt><dd>{status}</dd></div>
                <div>
                  <dt>最近</dt>
                  <dd>{latestEvent ? `${monthLabel(latestEvent.month)} · ${latestEvent.text}` : '暂无关联事件'}</dd>
                </div>
              </dl>
            )}

            {structure && (
              <div className="structure-inspector__details">
                <section><h3>结构效果</h3><p>{structureEffectText}</p></section>
                <section><h3>构件</h3><p>{materialSummary || '暂无材质信息'}</p></section>
                <section><h3>最近记录</h3>{latestEvent ? <p className="focus-inspector__event"><time>{monthLabel(latestEvent.month)}</time>{latestEvent.text}</p> : <p>暂无关联事件</p>}</section>
              </div>
            )}

            {!structure && <div className="focus-inspector__details">
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

            <section>
              <h3>{agent && <Eye aria-hidden="true" size={14} strokeWidth={1.7} />}关联事件</h3>
              {events.length ? events.slice(0, 4).map((event) => (
                <p className="focus-inspector__event" key={event.id}>
                  <time>{monthLabel(event.month)}</time>{event.text}
                </p>
              )) : <p>暂无关联事件</p>}
            </section>
          </div>}
          </>
          )}
        </div>
      </div>

      {!structure && <div className="focus-inspector__actions">
        {agent && agent.state === 'active' && onEnterEmbodiment && (
          <button
            className="observation-button"
            onClick={() => onEnterEmbodiment(agent.id)}
            type="button"
          >
            进入化身
          </button>
        )}
        <button className="observation-button observation-button--outline" onClick={onClose} type="button">
          收起 · Esc
        </button>
      </div>}
    </aside>
  );
}
