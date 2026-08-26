import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  EvolutionMode,
  ModelAuth,
  ModelEndpointDraft,
  ModelEndpointTestResult,
  ModelProtocol,
  ModelPurpose,
  ModelSettingsEndpoint,
  ModelSettingsSnapshot,
  ModelThinking,
  StructuredOutputMode,
} from '@/game/modelSettings';
import type {
  CivilizationIndexHistoryPoint,
  CivilizationIndexView,
  ElandSaveSummary,
  ModernCivilizationAchievementView,
} from '@/game/societyContract';
import { STAR_STYLES } from '@/lib/threebody';
import { civilizationStagePreview } from '@/game/voxelKits';
import {
  EVOLUTION_SPEED_MAX,
  EVOLUTION_SPEED_MIN,
  EVOLUTION_SPEED_STEP,
  type EvolutionSpeed,
} from '@/game/evolutionSpeed';
import { CivilizationStageBuilding } from './CivilizationStageBuilding';
import './ImmersiveInterface.css';

export type ImmersiveOverlayMode = 'menu' | 'saves' | 'new-world' | 'history' | 'model-settings' | 'shortcuts' | 'civilization-ending' | null;
type ActiveImmersiveOverlayMode = Exclude<ImmersiveOverlayMode, null>;
type OverlayTransitionPhase = 'enter' | 'idle' | 'exit';
export type NewWorldStatus = 'idle' | 'starting' | 'error';
export type ModelSettingsStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error';
export type SaveManagerStatus = 'idle' | 'loading' | 'saving' | 'loading-save' | 'saved' | 'error';
export type CivilizationSettlementStatus = 'idle' | 'settling' | 'error';

export interface ImmersiveHistoryEntry {
  id: string;
  month: number;
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  detail?: string;
  actorIds?: string[];
  sourceEventIds?: string[];
  status?: true;
}

interface FigureEightOrbit {
  path: string;
  phasePoints: Array<{ x: number; y: number }>;
}

interface Props {
  mode: ImmersiveOverlayMode;
  civilizationId: number;
  civilizationIndex: CivilizationIndexView | null;
  civilizationIndexHistory: CivilizationIndexHistoryPoint[];
  currentMonth: number;
  history: ImmersiveHistoryEntry[];
  historyTotalCount: number;
  modelSettings: ModelSettingsSnapshot | null;
  modelSettingsStatus: ModelSettingsStatus;
  modelSettingsMessage: string;
  modelEvolutionModeDraft: EvolutionMode;
  modelRouteDraft: Record<ModelPurpose, string>;
  modelSummaryModeDraft: EvolutionMode;
  evolutionSpeed: EvolutionSpeed;
  newWorldSeed: number;
  newWorldStatus: NewWorldStatus;
  saves: ElandSaveSummary[];
  saveStatus: SaveManagerStatus;
  saveMessage: string;
  civilizationSettlementStatus: CivilizationSettlementStatus;
  civilizationSettlementMessage: string;
  onClose: () => void;
  onOpenMenu: () => void;
  onOpenSaves: () => void;
  onOpenNewWorld: () => void;
  onOpenHistory: () => void;
  onOpenModelSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenCivilizationEnding: () => void;
  onCreateSave: (label: string) => void;
  onLoadSave: (saveId: string) => void;
  onEvolutionModeChange: (mode: EvolutionMode) => void;
  onEvolutionSpeedChange: (speed: EvolutionSpeed) => void;
  onModelRouteChange: (purpose: ModelPurpose, endpointId: string) => void;
  onSummaryModeChange: (mode: EvolutionMode) => void;
  onSaveModelSettings: () => void;
  onDeleteModelEndpoint: (id: string) => Promise<ModelSettingsSnapshot>;
  onSaveModelEndpoint: (token: string) => Promise<ModelSettingsSnapshot>;
  onTestModelEndpoint: (draft: ModelEndpointDraft) => Promise<ModelEndpointTestResult>;
  onRefreshSeed: () => void;
  onStartNewWorld: () => void;
  onEndCivilization: () => void;
}

const FIGURE_EIGHT_PERIOD = 6.32591398;
const FIGURE_EIGHT_STEPS = 960;
const ORBIT_DURATION_SECONDS = 9;
const OVERLAY_EXIT_MS = 135;

const MODEL_PURPOSE_LABELS: Record<ModelPurpose, string> = {
  decision: '文明决策',
  interaction: '人物对话',
  narrative: '纪事表述',
  naming: '后代取名',
  strategy: '文明策略',
};

const MODEL_PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'ollama-chat': 'Ollama Chat',
};

const MODEL_AUTH_LABELS: Record<ModelAuth, string> = {
  bearer: 'Bearer Token',
  'x-api-key': 'x-api-key',
  none: '无需认证',
};

interface EndpointEditorView {
  draft: ModelEndpointDraft;
  headerText: string;
  headersChanged: boolean;
}

function endpointEditorView(endpoint?: ModelSettingsEndpoint): EndpointEditorView {
  if (endpoint) {
    return {
      draft: {
        id: endpoint.id,
        originalId: endpoint.id,
        protocol: endpoint.protocol,
        url: endpoint.url,
        model: endpoint.model,
        auth: endpoint.auth,
        timeoutMs: endpoint.timeoutMs,
        ...(endpoint.temperature === undefined ? {} : { temperature: endpoint.temperature }),
        structuredOutput: endpoint.structuredOutput,
        ...(endpoint.thinking === undefined ? {} : { thinking: endpoint.thinking }),
      },
      headerText: '',
      headersChanged: false,
    };
  }
  return {
    draft: {
      id: '',
      protocol: 'openai-chat',
      url: 'https://api.openai.com/v1/chat/completions',
      model: '',
      auth: 'bearer',
      timeoutMs: 90_000,
      structuredOutput: 'prompt',
      thinking: false,
    },
    headerText: '',
    headersChanged: false,
  };
}

function parseHeaderText(value: string): Record<string, string> {
  return Object.fromEntries(value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf(':');
    if (separator <= 0 || !line.slice(separator + 1).trim()) throw new Error(`自定义请求头格式错误：${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

const CIVILIZATION_INDEX_COMPONENTS: Array<{
  key: keyof CivilizationIndexView['components'];
  label: string;
  color: string;
}> = [
  { key: 'population', label: '人口', color: '#75d8c9' },
  { key: 'territory', label: '疆域与设施', color: '#7fa6f6' },
  { key: 'technology', label: '科技', color: '#e8be66' },
  { key: 'social', label: '社会', color: '#f08ca0' },
  { key: 'history', label: '历史传承', color: '#b69bf7' },
];

function derivative(state: Float64Array, out: Float64Array): void {
  for (let body = 0; body < 3; body += 1) {
    out[body * 2] = state[6 + body * 2];
    out[body * 2 + 1] = state[6 + body * 2 + 1];
    let ax = 0;
    let ay = 0;
    const x = state[body * 2];
    const y = state[body * 2 + 1];
    for (let other = 0; other < 3; other += 1) {
      if (other === body) continue;
      const dx = state[other * 2] - x;
      const dy = state[other * 2 + 1] - y;
      const distanceSq = dx * dx + dy * dy;
      const inverseCube = 1 / (distanceSq * Math.sqrt(distanceSq));
      ax += dx * inverseCube;
      ay += dy * inverseCube;
    }
    out[6 + body * 2] = ax;
    out[6 + body * 2 + 1] = ay;
  }
}

function integrateFigureEight(): FigureEightOrbit {
  const state = new Float64Array([
    -0.97000436, 0.24308753,
    0.97000436, -0.24308753,
    0, 0,
    0.466203685, 0.43236573,
    0.466203685, 0.43236573,
    -0.93240737, -0.86473146,
  ]);
  const dt = FIGURE_EIGHT_PERIOD / FIGURE_EIGHT_STEPS;
  const k1 = new Float64Array(12);
  const k2 = new Float64Array(12);
  const k3 = new Float64Array(12);
  const k4 = new Float64Array(12);
  const temporary = new Float64Array(12);
  const points: Array<{ x: number; y: number }> = [];

  for (let step = 0; step <= FIGURE_EIGHT_STEPS; step += 1) {
    points.push({ x: state[0], y: state[1] });
    if (step === FIGURE_EIGHT_STEPS) break;
    derivative(state, k1);
    for (let i = 0; i < 12; i += 1) temporary[i] = state[i] + (dt / 2) * k1[i];
    derivative(temporary, k2);
    for (let i = 0; i < 12; i += 1) temporary[i] = state[i] + (dt / 2) * k2[i];
    derivative(temporary, k3);
    for (let i = 0; i < 12; i += 1) temporary[i] = state[i] + dt * k3[i];
    derivative(temporary, k4);
    for (let i = 0; i < 12; i += 1) {
      state[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    }
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const scale = Math.min(560 / (maxX - minX), 216 / (maxY - minY));
  const centerX = 360;
  const centerY = 148;
  const normalized = points.map((point) => ({
    x: centerX + point.x * scale,
    y: centerY - point.y * scale,
  }));
  const path = normalized
    .filter((_, index) => index % 2 === 0 || index === normalized.length - 1)
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
  const phasePoints = [0, 1 / 3, 2 / 3].map((phase) => normalized[Math.floor(phase * FIGURE_EIGHT_STEPS)]);
  return { path, phasePoints };
}

const FIGURE_EIGHT = integrateFigureEight();

function FigureEightGateway({ busy }: { busy: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`figure-eight ${busy ? 'figure-eight--busy' : ''}`}
      viewBox="0 0 720 296"
    >
      <path className="figure-eight__trail" d={FIGURE_EIGHT.path} />
      <g className="figure-eight__moving-stars">
        {STAR_STYLES.map((star, index) => (
          <g key={star.name} style={{ color: star.glow }}>
            <circle r="17" fill={star.glow} opacity="0.2" />
            <circle r="6.5" fill={star.core} stroke={star.glow} strokeWidth="1.5" />
            <animateMotion
              begin={`${-(index * ORBIT_DURATION_SECONDS) / 3}s`}
              dur={`${ORBIT_DURATION_SECONDS}s`}
              path={FIGURE_EIGHT.path}
              repeatCount="indefinite"
            />
          </g>
        ))}
      </g>
      <g className="figure-eight__static-stars">
        {STAR_STYLES.map((star, index) => {
          const point = FIGURE_EIGHT.phasePoints[index];
          return (
            <g key={star.name} style={{ color: star.glow }} transform={`translate(${point.x} ${point.y})`}>
              <circle r="17" fill={star.glow} opacity="0.2" />
              <circle r="6.5" fill={star.core} stroke={star.glow} strokeWidth="1.5" />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第${Math.floor((month - 1) / 12) + 1}年 · ${((month - 1) % 12) + 1}月`;
}

function indexPointLabel(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function niceChartCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const rough = value * 1.12;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function ModernCivilizationAchievement({
  achievement,
}: {
  achievement: ModernCivilizationAchievementView;
}) {
  const statusLabel = achievement.status === 'candidate'
    ? '现代事实已汇合'
    : achievement.status === 'historical-achievement'
      ? '历史最高成就'
      : '现代文明已达成';
  const disclosureLabel = achievement.status === 'candidate'
    ? `${achievement.observedFactCount} / ${achievement.requiredFactCount} 项`
    : achievement.status === 'historical-achievement'
      ? '曾达成'
      : '已达成';
  return (
    <details className="civilization-index__achievement">
      <summary aria-label={`展开现代文明成就，${statusLabel}`}>
        <span>
          <small>现代文明成就</small>
          <strong>{statusLabel}</strong>
        </span>
        <span className="civilization-index__achievement-disclosure">
          {disclosureLabel}
          <ChevronRight aria-hidden="true" size={14} strokeWidth={1.7} />
        </span>
      </summary>
      <div className="civilization-index__achievement-body">
        <p>这不是待办清单，而是这支文明已经留下的事实。</p>
        <ul aria-label="现代文明历史事实">
          {achievement.facts.map((fact) => (
            <li className={fact.observed ? 'is-observed' : undefined} key={fact.key}>
              <i aria-hidden="true">{fact.observed ? '✓' : '·'}</i>
              <span>{fact.label}</span>
              <small>{fact.observed ? '已见证' : '本次观察未保留'}</small>
            </li>
          ))}
        </ul>
        <div className="civilization-index__achievement-progress">
          <span>事实闭环</span>
          <strong>{achievement.observedFactCount} / {achievement.requiredFactCount} 项</strong>
          <span
            aria-label={`现代文明事实闭环 ${achievement.observedFactCount} / ${achievement.requiredFactCount} 项`}
            aria-valuemax={achievement.requiredFactCount}
            aria-valuemin={0}
            aria-valuenow={achievement.observedFactCount}
            className="civilization-index__achievement-track"
            role="progressbar"
          >
            <i style={{ width: `${achievement.progress * 100}%` }} />
          </span>
        </div>
      </div>
    </details>
  );
}

function CivilizationIndexChart({
  index,
  history,
}: {
  index: CivilizationIndexView | null;
  history: CivilizationIndexHistoryPoint[];
}) {
  const [hoveredMonth, setHoveredMonth] = useState<number | null>(null);
  const points = useMemo(() => {
    if (!index) return [];
    const byMonth = new Map<number, CivilizationIndexHistoryPoint>();
    for (const point of history) {
      if (point.formulaVersion !== index.formulaVersion
        || !Number.isFinite(point.total)
        || !Number.isInteger(point.calculatedAtMonth)) continue;
      byMonth.set(point.calculatedAtMonth, point);
    }
    byMonth.set(index.calculatedAtMonth, {
      formulaVersion: index.formulaVersion,
      total: index.total,
      calculatedAtMonth: index.calculatedAtMonth,
      stage: index.stage,
    });
    return [...byMonth.values()].sort((left, right) => left.calculatedAtMonth - right.calculatedAtMonth);
  }, [history, index]);

  if (!index) {
    return (
      <aside className="civilization-index civilization-index--empty" aria-label="文明指数尚不可用">
        <p>文明指数</p>
        <span>暂不可用</span>
      </aside>
    );
  }
  const items = CIVILIZATION_INDEX_COMPONENTS.map((component) => ({
    ...component,
    points: Math.max(0, index.components[component.key]),
  }));
  const componentTotal = items.reduce((sum, item) => sum + item.points, 0);
  const stagePreview = civilizationStagePreview(index.stage);
  const chart = {
    left: 18,
    right: 322,
    top: 92,
    bottom: 220,
  };
  const firstMonth = points[0]?.calculatedAtMonth ?? index.calculatedAtMonth;
  const lastMonth = points.at(-1)?.calculatedAtMonth ?? index.calculatedAtMonth;
  const monthSpan = Math.max(1, lastMonth - firstMonth);
  const yMax = niceChartCeiling(Math.max(index.total, ...points.map((point) => point.total)));
  const chartPoints = points.map((point) => ({
    ...point,
    x: firstMonth === lastMonth
      ? (chart.left + chart.right) / 2
      : chart.left + (point.calculatedAtMonth - firstMonth) / monthSpan * (chart.right - chart.left),
    y: chart.bottom - Math.max(0, point.total) / yMax * (chart.bottom - chart.top),
  }));
  const linePath = chartPoints.map((point, position) => (
    `${position === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`
  )).join(' ');
  const areaPath = chartPoints.length > 1
    ? `${linePath} L${chartPoints.at(-1)!.x.toFixed(2)},${chart.bottom} L${chartPoints[0].x.toFixed(2)},${chart.bottom} Z`
    : '';
  const hoveredPoint = hoveredMonth === null
    ? null
    : chartPoints.find((point) => point.calculatedAtMonth === hoveredMonth) ?? null;
  const latestPoint = chartPoints.at(-1) ?? null;
  let yearAgoPoint: (typeof chartPoints)[number] | null = null;
  for (let position = chartPoints.length - 1; position >= 0; position -= 1) {
    if (chartPoints[position].calculatedAtMonth <= index.calculatedAtMonth - 12) {
      yearAgoPoint = chartPoints[position];
      break;
    }
  }
  const yearChange = yearAgoPoint ? index.total - yearAgoPoint.total : null;

  const selectNearestPoint = (svgX: number) => {
    if (!chartPoints.length) return;
    const targetMonth = firstMonth + Math.max(0, Math.min(1,
      (svgX - chart.left) / (chart.right - chart.left))) * monthSpan;
    let nearest = chartPoints[0];
    for (const point of chartPoints) {
      if (Math.abs(point.calculatedAtMonth - targetMonth)
        < Math.abs(nearest.calculatedAtMonth - targetMonth)) nearest = point;
    }
    setHoveredMonth(nearest.calculatedAtMonth);
  };

  const moveSelection = (direction: -1 | 1) => {
    if (!chartPoints.length) return;
    const currentPosition = hoveredMonth === null
      ? chartPoints.length - 1
      : Math.max(0, chartPoints.findIndex((point) => point.calculatedAtMonth === hoveredMonth));
    const nextPosition = Math.max(0, Math.min(chartPoints.length - 1, currentPosition + direction));
    setHoveredMonth(chartPoints[nextPosition].calculatedAtMonth);
  };

  return (
    <aside className="civilization-index" aria-label={`文明指数 ${indexPointLabel(index.total)}，阶段 ${index.stage}`}>
      <header>
        <div>
          <p>文明指数</p>
          <h2>{index.stage}</h2>
        </div>
      </header>
      <div className="civilization-index__body">
        <div
          aria-label={`文明指数总计 ${indexPointLabel(index.total)}；${items.map((item) => `${item.label} ${indexPointLabel(item.points)}`).join('，')}`}
          className="civilization-index__hero"
          role="group"
        >
          <CivilizationStageBuilding stage={index.stage} />
          <div className="civilization-index__total">
            <span>CI</span>
            <strong>{indexPointLabel(index.total)}</strong>
            <small>
              {stagePreview.label}
              {yearChange !== null && (
                <em className={yearChange >= 0 ? 'is-up' : 'is-down'}>
                  近一年 {yearChange >= 0 ? '+' : ''}{indexPointLabel(yearChange)}
                </em>
              )}
            </small>
          </div>
          <svg
            aria-label={`文明指数从${monthLabel(firstMonth)}到${monthLabel(lastMonth)}的逐月折线图，当前 ${indexPointLabel(index.total)}`}
            className="civilization-index__timeline"
            onBlur={() => setHoveredMonth(null)}
            onFocus={() => setHoveredMonth(latestPoint?.calculatedAtMonth ?? null)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                moveSelection(event.key === 'ArrowLeft' ? -1 : 1);
              }
            }}
            onPointerLeave={() => setHoveredMonth(null)}
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              selectNearestPoint((event.clientX - bounds.left) / bounds.width * 340);
            }}
            role="img"
            tabIndex={0}
            viewBox="0 0 340 250"
          >
            <defs>
              <linearGradient id="civilization-index-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#75d8c9" stopOpacity="0.24" />
                <stop offset="1" stopColor="#75d8c9" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[1, 0.5, 0].map((ratio) => {
              const y = chart.bottom - ratio * (chart.bottom - chart.top);
              return (
                <g className="civilization-index__grid" key={ratio}>
                  <line x1={chart.left} x2={chart.right} y1={y} y2={y} />
                  <text x={chart.right} y={y - 4}>{indexPointLabel(yMax * ratio)}</text>
                </g>
              );
            })}
            {areaPath && <path className="civilization-index__area" d={areaPath} />}
            {linePath && <path className="civilization-index__line" d={linePath} />}
            {latestPoint && (
              <circle className="civilization-index__latest" cx={latestPoint.x} cy={latestPoint.y} r="3.5" />
            )}
            {hoveredPoint && (
              <g className="civilization-index__hover">
                <line x1={hoveredPoint.x} x2={hoveredPoint.x} y1={chart.top} y2={chart.bottom} />
                <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="4" />
                <g transform={`translate(${Math.max(6, Math.min(236, hoveredPoint.x - 49))} ${Math.max(96, hoveredPoint.y - 42)})`}>
                  <rect height="34" rx="6" width="98" />
                  <text x="8" y="14">{monthLabel(hoveredPoint.calculatedAtMonth)}</text>
                  <text className="civilization-index__hover-value" x="8" y="27">CI {indexPointLabel(hoveredPoint.total)}</text>
                </g>
              </g>
            )}
            {chartPoints.length < 2 && (
              <text className="civilization-index__waiting" x="170" y="158">继续演化后形成趋势</text>
            )}
            <g className="civilization-index__x-axis">
              <text x={chart.left} y="239">{monthLabel(firstMonth)}</text>
              {firstMonth !== lastMonth && <text textAnchor="end" x={chart.right} y="239">{monthLabel(lastMonth)}</text>}
            </g>
          </svg>
        </div>
        <dl className="civilization-index__legend">
          {items.map((item) => {
            const share = componentTotal > 0 ? item.points / componentTotal * 100 : 0;
            return (
              <div key={item.key}>
                <dt><i style={{ background: item.color }} />{item.label}</dt>
                <dd>
                  <span><i style={{ background: item.color, width: `${share}%` }} /></span>
                  <strong>{indexPointLabel(item.points)}</strong>
                </dd>
              </div>
            );
          })}
        </dl>
        {index.modernAchievement && (
          <ModernCivilizationAchievement achievement={index.modernAchievement} />
        )}
      </div>
    </aside>
  );
}

function formatSeed(seed: number): string {
  return `0x${seed.toString(16).padStart(8, '0').toUpperCase()}`;
}

function formatSaveTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface ModeSegmentedControlProps {
  ariaLabelledBy: string;
  disabled: boolean;
  modelDisabled: boolean;
  onChange: (mode: EvolutionMode) => void;
  value: EvolutionMode;
}

function ModeSegmentedControl({
  ariaLabelledBy,
  disabled,
  modelDisabled,
  onChange,
  value,
}: ModeSegmentedControlProps) {
  const selectFromKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: EvolutionMode = event.key === 'ArrowLeft' || event.key === 'Home' ? 'local' : 'model';
    if (disabled || (next === 'model' && modelDisabled)) return;
    onChange(next);
    const track = event.currentTarget.parentElement;
    requestAnimationFrame(() => track?.querySelector<HTMLButtonElement>(`button[data-value="${next}"]`)?.focus());
  };

  return (
    <div aria-labelledby={ariaLabelledBy} className="model-segmented" role="radiogroup">
      {(['local', 'model'] as const).map((mode) => {
        const optionDisabled = disabled || (mode === 'model' && modelDisabled);
        return (
          <button
            aria-checked={value === mode}
            aria-disabled={optionDisabled}
            className={value === mode ? 'is-selected' : undefined}
            data-value={mode}
            disabled={optionDisabled}
            key={mode}
            onClick={() => onChange(mode)}
            onKeyDown={selectFromKey}
            role="radio"
            tabIndex={!optionDisabled && (value === mode || (value === 'model' && modelDisabled && mode === 'local')) ? 0 : -1}
            type="button"
          >
            {mode === 'local' ? '本地' : '模型'}
          </button>
        );
      })}
    </div>
  );
}

interface EvolutionSpeedSliderProps {
  ariaLabelledBy: string;
  onChange: (speed: EvolutionSpeed) => void;
  value: EvolutionSpeed;
}

function evolutionSpeedLabel(value: EvolutionSpeed): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function EvolutionSpeedSlider({
  ariaLabelledBy,
  onChange,
  value,
}: EvolutionSpeedSliderProps) {
  const progress = ((value - EVOLUTION_SPEED_MIN) / (EVOLUTION_SPEED_MAX - EVOLUTION_SPEED_MIN)) * 100;
  const label = evolutionSpeedLabel(value);

  return (
    <div className="evolution-speed-slider">
      <input
        aria-labelledby={ariaLabelledBy}
        aria-valuetext={`${label} 倍`}
        id="evolution-speed"
        max={EVOLUTION_SPEED_MAX}
        min={EVOLUTION_SPEED_MIN}
        onChange={(event) => onChange(Number(event.target.value))}
        step={EVOLUTION_SPEED_STEP}
        style={{ '--evolution-speed-progress': `${progress}%` } as CSSProperties}
        type="range"
        value={value}
      />
      <output htmlFor="evolution-speed">{label}×</output>
    </div>
  );
}

export default function ImmersiveInterface({
  mode,
  civilizationId,
  civilizationIndex,
  civilizationIndexHistory,
  currentMonth,
  history,
  historyTotalCount,
  modelSettings,
  modelSettingsStatus,
  modelSettingsMessage,
  modelEvolutionModeDraft,
  modelRouteDraft,
  modelSummaryModeDraft,
  evolutionSpeed,
  newWorldSeed,
  newWorldStatus,
  saves,
  saveStatus,
  saveMessage,
  civilizationSettlementStatus,
  civilizationSettlementMessage,
  onClose,
  onOpenMenu,
  onOpenSaves,
  onOpenNewWorld,
  onOpenHistory,
  onOpenModelSettings,
  onOpenShortcuts,
  onOpenCivilizationEnding,
  onCreateSave,
  onLoadSave,
  onEvolutionModeChange,
  onEvolutionSpeedChange,
  onModelRouteChange,
  onSummaryModeChange,
  onSaveModelSettings,
  onDeleteModelEndpoint,
  onSaveModelEndpoint,
  onRefreshSeed,
  onStartNewWorld,
  onEndCivilization,
  onTestModelEndpoint,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasOpenRef = useRef(false);
  const [renderedMode, setRenderedMode] = useState<ActiveImmersiveOverlayMode | null>(mode);
  const [transitionPhase, setTransitionPhase] = useState<OverlayTransitionPhase>(mode ? 'enter' : 'idle');
  const [saveLabel, setSaveLabel] = useState('');
  const [endpointEditor, setEndpointEditor] = useState<EndpointEditorView | null>(null);
  const [endpointTest, setEndpointTest] = useState<ModelEndpointTestResult | null>(null);
  const [endpointEditorStatus, setEndpointEditorStatus] = useState<'idle' | 'testing' | 'saving' | 'deleting' | 'error'>('idle');
  const [endpointEditorMessage, setEndpointEditorMessage] = useState('');

  useEffect(() => {
    if (mode === renderedMode) return;
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);

    if (renderedMode) {
      setTransitionPhase('exit');
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      transitionTimerRef.current = setTimeout(() => {
        setRenderedMode(mode);
        setTransitionPhase(mode ? 'enter' : 'idle');
        transitionTimerRef.current = null;
      }, reduceMotion ? 0 : OVERLAY_EXIT_MS);
      return;
    }

    if (mode) {
      setRenderedMode(mode);
      setTransitionPhase('enter');
    }
  }, [mode, renderedMode]);

  useEffect(() => () => {
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
  }, []);

  useEffect(() => {
    if (mode && !wasOpenRef.current) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      wasOpenRef.current = true;
    }
    if (!mode && !renderedMode && wasOpenRef.current) {
      previousFocusRef.current?.focus({ preventScroll: true });
      wasOpenRef.current = false;
    }
  }, [mode, renderedMode]);

  useEffect(() => {
    if (!renderedMode || transitionPhase === 'exit') return;
    const frame = requestAnimationFrame(() => {
      overlayRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [renderedMode, transitionPhase]);

  useEffect(() => {
    if (mode === 'model-settings') return;
    setEndpointEditor(null);
    setEndpointTest(null);
    setEndpointEditorStatus('idle');
    setEndpointEditorMessage('');
  }, [mode]);

  const visibleHistory = useMemo(() => history.filter((entry) => !entry.status).slice().reverse(), [history]);
  const historyCountLabel = historyTotalCount > visibleHistory.length
    ? `最近 ${visibleHistory.length} 条记录 · 更早记录已省略`
    : `共 ${visibleHistory.length} 条记录`;
  if (!renderedMode) return null;

  const titleId = `immersive-${renderedMode}-title`;
  const decisionEndpoint = modelSettings?.endpoints.find((endpoint) => endpoint.id === modelRouteDraft.decision);
  const interactionEndpoint = modelSettings?.endpoints.find((endpoint) => endpoint.id === modelRouteDraft.interaction);
  const narrativeEndpoint = modelSettings?.endpoints.find((endpoint) => endpoint.id === modelRouteDraft.narrative);
  const modelEvolutionAvailable = Boolean(decisionEndpoint?.configured && decisionEndpoint.verified);
  const modelSummaryAvailable = Boolean(narrativeEndpoint?.configured && narrativeEndpoint.verified);
  const settingsDirty = Boolean(modelSettings && (
    modelSettings.evolutionMode !== modelEvolutionModeDraft
    || modelSettings.summaryMode !== modelSummaryModeDraft
    || modelSettings.purposes.some((purpose) => modelSettings.routes[purpose] !== modelRouteDraft[purpose])
  ));
  const savesBusy = saveStatus === 'loading' || saveStatus === 'saving' || saveStatus === 'loading-save';
  const civilizationLabel = civilizationId > 0 ? `第 ${civilizationId} 号文明` : '文明编号待分配';
  const editEndpoint = (endpoint?: ModelSettingsEndpoint) => {
    setEndpointEditor(endpointEditorView(endpoint));
    setEndpointTest(null);
    setEndpointEditorStatus('idle');
    setEndpointEditorMessage('');
  };
  const changeEndpointDraft = (patch: Partial<ModelEndpointDraft>) => {
    setEndpointEditor((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
    setEndpointTest(null);
    setEndpointEditorStatus('idle');
    setEndpointEditorMessage('');
  };
  const testedEndpointDraft = (): ModelEndpointDraft => {
    if (!endpointEditor) throw new Error('端点编辑器未打开');
    return {
      ...endpointEditor.draft,
      ...(endpointEditor.headersChanged ? { headers: parseHeaderText(endpointEditor.headerText) } : {}),
    };
  };
  const testEndpoint = async () => {
    setEndpointEditorStatus('testing');
    setEndpointEditorMessage('正在发起真实生成请求…');
    setEndpointTest(null);
    try {
      const result = await onTestModelEndpoint(testedEndpointDraft());
      setEndpointTest(result);
      setEndpointEditorStatus('idle');
      setEndpointEditorMessage(`连接成功 · ${result.latencyMs} ms · 返回「${result.preview}」`);
    } catch (error) {
      setEndpointEditorStatus('error');
      setEndpointEditorMessage(error instanceof Error ? error.message : '连接测试失败');
    }
  };
  const saveEndpoint = async () => {
    if (!endpointTest) return;
    setEndpointEditorStatus('saving');
    setEndpointEditorMessage('正在保存已验证端点…');
    try {
      await onSaveModelEndpoint(endpointTest.token);
      setEndpointEditor(null);
      setEndpointTest(null);
      setEndpointEditorStatus('idle');
      setEndpointEditorMessage('');
    } catch (error) {
      setEndpointEditorStatus('error');
      setEndpointEditorMessage(error instanceof Error ? error.message : '端点保存失败');
    }
  };
  const removeEndpoint = async () => {
    const id = endpointEditor?.draft.originalId;
    if (!id || !window.confirm(`删除模型端点「${id}」？`)) return;
    setEndpointEditorStatus('deleting');
    setEndpointEditorMessage('');
    try {
      await onDeleteModelEndpoint(id);
      setEndpointEditor(null);
      setEndpointEditorStatus('idle');
    } catch (error) {
      setEndpointEditorStatus('error');
      setEndpointEditorMessage(error instanceof Error ? error.message : '端点删除失败');
    }
  };
  return (
    <div
      ref={overlayRef}
      aria-labelledby={titleId}
      aria-modal="true"
      className={`immersive-overlay immersive-overlay--${renderedMode} immersive-overlay--${transitionPhase}${!mode ? ' immersive-overlay--closing' : ''}`}
      role="dialog"
    >
      {renderedMode === 'menu' && (
        <div className="immersive-menu">
          <header className="utility-header">
            <div>
              <p className="immersive-eyebrow">{civilizationLabel} · {monthLabel(currentMonth)}</p>
              <h1 id={titleId}>观测与设置</h1>
            </div>
            <button aria-label="返回世界" className="utility-icon-button" onClick={onClose} type="button"><X size={18} /></button>
          </header>
          <nav aria-label="观测命令" className="immersive-menu__actions">
            <p>文明</p>
            <div>
              <button data-autofocus onClick={onOpenSaves} type="button"><span>文明档案<small>保存与读取当前文明</small></span><ChevronRight size={17} /></button>
              <button onClick={onOpenHistory} type="button"><span>文明历史<small>查看文明留下的事实记录</small></span><kbd>H</kbd></button>
              <div className="immersive-menu__setting">
                <span>
                  <strong id="evolution-speed-label">演化速度</strong>
                  <small>0.5–10× · 本机推进频率</small>
                </span>
                <EvolutionSpeedSlider
                  ariaLabelledBy="evolution-speed-label"
                  onChange={onEvolutionSpeedChange}
                  value={evolutionSpeed}
                />
              </div>
              <button onClick={onOpenCivilizationEnding} type="button"><span>文明终章<small>让 AI 编排终章或结束当前文明</small></span><ChevronRight size={17} /></button>
            </div>
            <p>系统</p>
            <div>
              <button onClick={onOpenModelSettings} type="button"><span>模型设置<small>演进方式、端点与用途路由</small></span><kbd>M</kbd></button>
              <button onClick={onOpenShortcuts} type="button"><span>按键<small>查看观察与移动操作</small></span><kbd>?</kbd></button>
            </div>
            <button className="immersive-menu__new-world" onClick={onOpenNewWorld} type="button"><span>建立新文明</span><kbd>N</kbd></button>
          </nav>
          <footer><button className="immersive-text-action" onClick={onClose} type="button">继续观察 · Esc</button></footer>
        </div>
      )}

      {renderedMode === 'saves' && (
        <section aria-busy={savesBusy} className="save-manager">
          <header className="utility-header">
            <div><p className="immersive-eyebrow">文明</p><h1 id={titleId}>文明档案</h1></div>
            <button aria-label="返回观测与设置" className="utility-icon-button" onClick={onOpenMenu} type="button"><X size={18} /></button>
          </header>

          <form
            className="save-manager__create"
            onSubmit={(event) => {
              event.preventDefault();
              if (savesBusy) return;
              onCreateSave(saveLabel.trim());
            }}
          >
            <label htmlFor="eland-save-label">
              <span>存档名称</span>
              <small>可选</small>
            </label>
            <div>
              <input
                autoComplete="off"
                data-autofocus
                disabled={savesBusy}
                id="eland-save-label"
                maxLength={64}
                onChange={(event) => setSaveLabel(event.target.value)}
                placeholder={`${civilizationLabel} · ${monthLabel(currentMonth)}`}
                type="text"
                value={saveLabel}
              />
              <button
                className="immersive-button immersive-button--primary immersive-button--44"
                disabled={savesBusy}
                type="submit"
              >
                {saveStatus === 'saving' ? '保存中…' : '保存当前文明'}
              </button>
            </div>
          </form>

          <div
            aria-live={saveStatus === 'error' ? 'assertive' : 'polite'}
            className={`save-manager__feedback${saveStatus === 'error' ? ' save-manager__feedback--error' : ''}`}
            role={saveStatus === 'error' ? 'alert' : 'status'}
          >
            {saveMessage}
          </div>

          <div className="save-manager__list" tabIndex={0}>
            {saveStatus === 'loading' && saves.length === 0 ? (
              <p className="save-manager__empty">正在读取文明档案…</p>
            ) : saves.length === 0 ? (
              <p className="save-manager__empty">暂无存档</p>
            ) : (
              <ol>
                {saves.map((save) => (
                  <li key={save.id}>
                    <article className="save-card">
                      <div className="save-card__main">
                        <div className="save-card__title">
                          <h2>{save.label}</h2>
                          {save.ended && <span>已终结</span>}
                        </div>
                        <p>
                          第 {save.civilizationId} 号文明
                          <span aria-hidden="true"> · </span>
                          {save.calendarLabel}
                        </p>
                        <dl>
                          <div><dt>人口</dt><dd>{save.livingPeople} 人</dd></div>
                          <div><dt>阶段</dt><dd>{save.stage}</dd></div>
                        </dl>
                      </div>
                      <div className="save-card__actions">
                        <time dateTime={save.updatedAt}>{formatSaveTime(save.updatedAt)}</time>
                        <button
                          className="immersive-button immersive-button--secondary immersive-button--44"
                          disabled={savesBusy}
                          onClick={() => onLoadSave(save.id)}
                          type="button"
                        >
                          {saveStatus === 'loading-save' ? '载入中…' : '载入'}
                        </button>
                      </div>
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <footer>
            <button className="immersive-text-action save-manager__cancel" onClick={onOpenMenu} type="button">返回 · Esc</button>
          </footer>
        </section>
      )}

      {renderedMode === 'new-world' && (
        <div aria-busy={newWorldStatus === 'starting'} className="new-world">
          <h1 id={titleId}>新文明</h1>
          <FigureEightGateway busy={newWorldStatus === 'starting'} />
          <div className="new-world__status" aria-live="polite">
            <span>世界种子 · {formatSeed(newWorldSeed)}</span>
            {newWorldStatus === 'starting' && <strong>正在求解初始条件……</strong>}
            {newWorldStatus === 'error' && <strong className="new-world__error">初始条件未能建立，请重试</strong>}
          </div>
          <div className="new-world__actions">
            <button
              className="immersive-button immersive-button--secondary immersive-button--32"
              disabled={newWorldStatus === 'starting'}
              onClick={onRefreshSeed}
              type="button"
            >
              重取种子
            </button>
            <button
              className="immersive-button immersive-button--primary immersive-button--44"
              data-autofocus
              disabled={newWorldStatus === 'starting'}
              onClick={onStartNewWorld}
              type="button"
            >
              {newWorldStatus === 'error' ? '重新开始' : newWorldStatus === 'starting' ? '正在建立' : '开始演化'}
            </button>
          </div>
        </div>
      )}

      {renderedMode === 'history' && (
        <section className="history-view">
          <div className="history-view__main">
            <header>
              <p className="immersive-eyebrow">{civilizationLabel}</p>
              <h1 id={titleId}>文明历史</h1>
              <p>{monthLabel(currentMonth)} · {historyCountLabel}</p>
            </header>
            <div className="history-view__list" tabIndex={0}>
              {visibleHistory.length === 0 ? (
                <p className="history-view__empty">文明还没有留下记录。</p>
              ) : visibleHistory.map((entry, index) => {
                const sameMonthAsPrevious = visibleHistory[index - 1]?.month === entry.month;
                const label = monthLabel(entry.month);
                const detail = entry.detail?.trim();
                const evidenceCount = entry.sourceEventIds?.length ?? 0;
                const actorCount = entry.actorIds?.length ?? 0;
                const canExpand = Boolean(detail || evidenceCount || actorCount);
                return (
                  <article className={`history-entry history-entry--${entry.tone}`} key={entry.id}>
                    <time aria-hidden={sameMonthAsPrevious || undefined}>{sameMonthAsPrevious ? '' : label}</time>
                    <div>
                      {sameMonthAsPrevious && <span className="sr-only">{label}：</span>}
                      {canExpand ? (
                        <details className="history-entry__details">
                          <summary className="history-entry__summary">
                            <span className="history-entry__text">{entry.text}</span>
                            <span className="history-entry__disclosure" aria-hidden="true">
                              {evidenceCount > 0 ? `${evidenceCount} 条证据` : '详情'}
                              <ChevronRight size={14} strokeWidth={1.7} />
                            </span>
                          </summary>
                          <div className="history-entry__expanded">
                            {detail && <p>{detail}</p>}
                            <p className="history-entry__source">
                              {evidenceCount > 0 ? `来源：关联 ${evidenceCount} 条模拟事件` : '来源：历史投影说明'}
                              {actorCount > 0 ? ` · 涉及 ${actorCount} 人` : ''}
                            </p>
                          </div>
                        </details>
                      ) : (
                        <p>{entry.text}</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            <button className="immersive-text-action" data-autofocus onClick={onClose} type="button">合上 · Esc</button>
          </div>
          <CivilizationIndexChart history={civilizationIndexHistory} index={civilizationIndex} />
        </section>
      )}

      {renderedMode === 'model-settings' && (
        <section className={`model-settings${endpointEditor ? ' model-settings--editing' : ''}`} data-autofocus tabIndex={-1}>
          <header className="utility-header model-settings__header">
            <button
              aria-label={endpointEditor ? '返回模型设置' : '返回观测与设置'}
              className="utility-icon-button"
              onClick={() => endpointEditor ? setEndpointEditor(null) : onOpenMenu()}
              type="button"
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <p className="immersive-eyebrow">系统 · {endpointEditor ? '端点编辑' : settingsDirty ? '有未保存改动' : '当前配置'}</p>
              <h1 id={titleId}>{endpointEditor ? endpointEditor.draft.originalId ? '编辑模型端点' : '添加模型端点' : '模型设置'}</h1>
            </div>
          </header>

          {modelSettingsStatus === 'loading' && (
            <p className="model-settings__loading" aria-live="polite">正在读取模型路由……</p>
          )}

          {modelSettingsStatus !== 'loading' && modelSettings && endpointEditor && (
            <form
              className="model-endpoint-editor"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                setEndpointEditor(null);
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void (endpointTest ? saveEndpoint() : testEndpoint());
              }}
            >
              <div className="model-endpoint-editor__body">
                <div className="model-endpoint-editor__grid">
                  <label>
                    <span>端点名称</span>
                    <input
                      autoComplete="off"
                      disabled={endpointEditorStatus === 'testing' || endpointEditorStatus === 'saving'}
                      onChange={(event) => changeEndpointDraft({ id: event.target.value })}
                      placeholder="例如：主模型"
                      required
                      value={endpointEditor.draft.id}
                    />
                  </label>
                  <label>
                    <span>协议</span>
                    <select
                      disabled={endpointEditorStatus === 'testing' || endpointEditorStatus === 'saving'}
                      onChange={(event) => changeEndpointDraft({ protocol: event.target.value as ModelProtocol })}
                      value={endpointEditor.draft.protocol}
                    >
                      {Object.entries(MODEL_PROTOCOL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className="model-endpoint-editor__wide">
                    <span>请求 URL</span>
                    <input
                      autoCapitalize="none"
                      autoComplete="url"
                      disabled={endpointEditorStatus === 'testing' || endpointEditorStatus === 'saving'}
                      onChange={(event) => changeEndpointDraft({ url: event.target.value })}
                      placeholder="https://…"
                      required
                      spellCheck={false}
                      type="url"
                      value={endpointEditor.draft.url}
                    />
                  </label>
                  <label>
                    <span>模型名称</span>
                    <input
                      autoComplete="off"
                      disabled={endpointEditorStatus === 'testing' || endpointEditorStatus === 'saving'}
                      onChange={(event) => changeEndpointDraft({ model: event.target.value })}
                      placeholder="provider-model-name"
                      required
                      spellCheck={false}
                      value={endpointEditor.draft.model}
                    />
                  </label>
                  <label>
                    <span>认证方式</span>
                    <select
                      disabled={endpointEditorStatus === 'testing' || endpointEditorStatus === 'saving'}
                      onChange={(event) => changeEndpointDraft({ auth: event.target.value as ModelAuth })}
                      value={endpointEditor.draft.auth}
                    >
                      {Object.entries(MODEL_AUTH_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  {endpointEditor.draft.auth !== 'none' && (
                    <label className="model-endpoint-editor__wide">
                      <span>API Key</span>
                      <input
                        autoComplete="off"
                        disabled={endpointEditorStatus === 'testing' || endpointEditorStatus === 'saving'}
                        onChange={(event) => changeEndpointDraft({ apiKey: event.target.value })}
                        placeholder={endpointEditor.draft.originalId ? '已配置；留空保持不变' : '仅写入本机配置，保存后不再显示'}
                        type="password"
                        value={endpointEditor.draft.apiKey ?? ''}
                      />
                    </label>
                  )}
                </div>

                <details className="model-endpoint-editor__advanced">
                  <summary>高级兼容选项</summary>
                  <div className="model-endpoint-editor__grid">
                    <label>
                      <span>结构化输出</span>
                      <select
                        onChange={(event) => changeEndpointDraft({ structuredOutput: event.target.value as StructuredOutputMode })}
                        value={endpointEditor.draft.structuredOutput ?? 'prompt'}
                      >
                        <option value="prompt">提示词约束</option>
                        <option value="native-json">原生 JSON</option>
                      </select>
                    </label>
                    <label>
                      <span>思考模式</span>
                      <select
                        onChange={(event) => changeEndpointDraft({ thinking: event.target.value === 'false' ? false : event.target.value as ModelThinking })}
                        value={String(endpointEditor.draft.thinking ?? false)}
                      >
                        <option value="false">关闭</option>
                        <option value="low">低</option>
                        <option value="medium">中</option>
                        <option value="high">高</option>
                        <option value="max">最高</option>
                      </select>
                    </label>
                    <label>
                      <span>温度</span>
                      <input
                        max="2"
                        min="0"
                        onChange={(event) => changeEndpointDraft({ temperature: event.target.value === '' ? undefined : Number(event.target.value) })}
                        placeholder="由用途决定"
                        step="0.1"
                        type="number"
                        value={endpointEditor.draft.temperature ?? ''}
                      />
                    </label>
                    <label>
                      <span>超时（秒）</span>
                      <input
                        max="300"
                        min="1"
                        onChange={(event) => changeEndpointDraft({ timeoutMs: Number(event.target.value) * 1_000 })}
                        type="number"
                        value={Math.round((endpointEditor.draft.timeoutMs ?? 90_000) / 1_000)}
                      />
                    </label>
                    <label className="model-endpoint-editor__wide">
                      <span>自定义请求头</span>
                      <textarea
                        onChange={(event) => {
                          setEndpointEditor((current) => current ? { ...current, headerText: event.target.value, headersChanged: true } : current);
                          setEndpointTest(null);
                          setEndpointEditorStatus('idle');
                          setEndpointEditorMessage('');
                        }}
                        placeholder={endpointEditor.draft.originalId && modelSettings.endpoints.find((item) => item.id === endpointEditor.draft.originalId)?.headerNames.length
                          ? `已配置请求头；留空保持不变。替换时每行填写 Header: value`
                          : '每行填写 Header: value'}
                        rows={3}
                        value={endpointEditor.headerText}
                      />
                    </label>
                  </div>
                </details>
              </div>

              <footer className="model-settings__actions model-endpoint-editor__actions">
                <div aria-live="polite" className={`model-settings__feedback${endpointEditorStatus === 'error' ? ' is-error' : ''}${endpointTest ? ' is-success' : ''}`}>
                  {endpointTest && <Check aria-hidden="true" size={15} />}{endpointEditorMessage || '保存前必须通过一次真实生成测试'}
                </div>
                <div className="model-settings__action-buttons">
                  {endpointEditor.draft.originalId && (
                    <button
                      aria-label="删除端点"
                      className="immersive-button immersive-button--danger immersive-button--32"
                      disabled={endpointEditorStatus === 'deleting' || endpointEditorStatus === 'saving'}
                      onClick={() => { void removeEndpoint(); }}
                      type="button"
                    ><Trash2 size={16} />删除</button>
                  )}
                  <button
                    className="immersive-button immersive-button--secondary immersive-button--32"
                    disabled={endpointEditorStatus === 'testing' || endpointEditorStatus === 'saving'}
                    onClick={() => { void testEndpoint(); }}
                    type="button"
                  >{endpointEditorStatus === 'testing' ? '测试中…' : endpointTest ? '重新测试' : '测试连接'}</button>
                  <button
                    className="immersive-button immersive-button--primary immersive-button--32"
                    disabled={!endpointTest || endpointEditorStatus === 'saving'}
                    type="submit"
                  >{endpointEditorStatus === 'saving' ? '保存中…' : '保存并接入'}</button>
                </div>
              </footer>
            </form>
          )}

          {modelSettingsStatus !== 'loading' && modelSettings && !endpointEditor && (
            <form
              className="model-settings__form"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveModelSettings();
              }}
            >
              <div className="model-settings__body">
                <section aria-label="演进与总结方式" className="model-settings__mode-list">
                  <div className="model-settings__mode-row">
                    <span>
                      <strong id="evolution-mode-label">文明演进</strong>
                      <small>人物仍只提出建议，规则层验证后才会提交结果</small>
                    </span>
                    <ModeSegmentedControl
                      ariaLabelledBy="evolution-mode-label"
                      disabled={!modelSettings.editable || modelSettingsStatus === 'saving'}
                      modelDisabled={!modelEvolutionAvailable}
                      onChange={onEvolutionModeChange}
                      value={modelEvolutionModeDraft}
                    />
                  </div>
                  <div className="model-settings__mode-row">
                    <span>
                      <strong id="summary-mode-label">纪事表述</strong>
                      <small>只改变事实如何被写出，不改动文明历史</small>
                    </span>
                    <ModeSegmentedControl
                      ariaLabelledBy="summary-mode-label"
                      disabled={!modelSettings.editable || modelSettingsStatus === 'saving'}
                      modelDisabled={!modelSummaryAvailable}
                      onChange={onSummaryModeChange}
                      value={modelSummaryModeDraft}
                    />
                  </div>
                </section>

                <section aria-label="人物对话状态" className="model-settings__active">
                  <span>人物对话</span>
                  <p><strong>按需模型</strong><small>{interactionEndpoint ? `${interactionEndpoint.id} · ${interactionEndpoint.model}` : '尚无可用端点'}</small></p>
                </section>

                <details className="model-settings__advanced">
                  <summary>
                    <span>端点与用途路由</span>
                  </summary>
                  <div className="model-settings__advanced-body">
                    <section className="model-settings__endpoint-section">
                      <header><div><strong>模型端点</strong><small>密钥保存后只显示配置状态</small></div><button className="immersive-button immersive-button--secondary immersive-button--32" onClick={() => editEndpoint()} type="button"><Plus size={15} />添加</button></header>
                      <div className="model-settings__endpoints" aria-label="模型端点状态">
                        {modelSettings.endpoints.map((endpoint) => (
                          <button key={endpoint.id} onClick={() => editEndpoint(endpoint)} type="button">
                            <span aria-hidden="true" className={endpoint.configured && endpoint.verified ? 'is-ready' : 'is-missing'} />
                            <p><strong>{endpoint.id}</strong><small>{endpoint.model} · {MODEL_PROTOCOL_LABELS[endpoint.protocol]} · {endpointHost(endpoint.url)}</small></p>
                            <em>{endpoint.configured && endpoint.verified ? '已验证' : endpoint.issue ?? '需要测试'}</em>
                            <Pencil aria-hidden="true" size={15} />
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="model-settings__route-section">
                      <header><strong>用途路由</strong><small>{modelSettings.endpoints.length <= 1 ? '当前只有一个端点，所有用途自动使用它' : '分别指定不同用途使用的端点'}</small></header>
                    {modelSettings.endpoints.length > 1 ? (
                      <div className="model-settings__routes">
                        {modelSettings.purposes.map((purpose) => {
                        const labelId = `model-purpose-${purpose}-label`;
                        return (
                          <div className="model-field" key={purpose}>
                            <span id={labelId}>{MODEL_PURPOSE_LABELS[purpose]}</span>
                            <span>
                              <Select
                                disabled={!modelSettings.editable || modelSettingsStatus === 'saving'}
                                onValueChange={(endpointId) => onModelRouteChange(purpose, endpointId)}
                                value={modelRouteDraft[purpose]}
                              >
                                <SelectTrigger
                                  aria-labelledby={labelId}
                                  className="model-select__trigger"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent
                                  align="start"
                                  className="model-select__content"
                                  position="popper"
                                  sideOffset={4}
                                >
                                  {modelSettings.endpoints.filter((endpoint) => endpoint.configured && endpoint.verified).map((endpoint) => (
                                    <SelectItem className="model-select__item" key={endpoint.id} value={endpoint.id}>
                                      {endpoint.id} · {endpoint.model}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </span>
                          </div>
                        );
                        })}
                      </div>
                    ) : <p className="model-settings__single-route">{modelSettings.endpoints[0]?.id ?? '尚无端点'}</p>}
                    </section>

                    <div className="model-settings__source">
                      <span>安装级配置 · {modelSettings.configFile ?? '旧 Kimi 环境配置'} · 不写入文明存档</span>
                    </div>
                  </div>
                </details>
              </div>

              <div className="model-settings__actions">
                <div className="model-settings__feedback" aria-live="polite">
                  {modelSettingsMessage}
                </div>
                <div className="model-settings__action-buttons">
                  <button className="immersive-button immersive-button--secondary immersive-button--32" onClick={onOpenMenu} type="button">返回</button>
                  <button
                    className="immersive-button immersive-button--primary immersive-button--32"
                    disabled={!modelSettings.editable || modelSettingsStatus === 'saving' || !settingsDirty}
                    type="submit"
                  >
                    {modelSettingsStatus === 'saving' ? '保存中' : settingsDirty ? '保存' : '已同步'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {modelSettingsStatus === 'error' && !modelSettings && (
            <div className="model-settings__failure" aria-live="assertive">
              <p>{modelSettingsMessage || '模型设置读取失败。'}</p>
              <button className="immersive-text-action" onClick={onOpenMenu} type="button">返回 · Esc</button>
            </div>
          )}
        </section>
      )}

      {renderedMode === 'shortcuts' && (
        <section className="shortcut-view">
          <header className="utility-header"><div><p className="immersive-eyebrow">系统</p><h1 id={titleId}>按键</h1></div><button aria-label="返回观测与设置" className="utility-icon-button" onClick={onOpenMenu} type="button"><X size={18} /></button></header>
          <dl>
            <div><dt><kbd>Esc</kbd></dt><dd>观测菜单／返回世界</dd></div>
            <div><dt><kbd>⌘K</kbd></dt><dd>打开所有命令</dd></div>
            <div><dt><kbd>N</kbd></dt><dd>建立新文明</dd></div>
            <div><dt><kbd>C</kbd></dt><dd>人物聚焦时打开对话</dd></div>
            <div><dt><kbd>B</kbd></dt><dd>人物聚焦时打开或合上背包</dd></div>
            <div><dt><kbd>H</kbd></dt><dd>人物聚焦时查看个人行动史，否则查看文明历史</dd></div>
            <div><dt><kbd>M</kbd></dt><dd>打开模型设置</dd></div>
            <div><dt><kbd>W A S D</kbd></dt><dd>在人间移动观察点</dd></div>
            <div><dt><kbd>↑ ↓</kbd></dt><dd>靠近或离开世界</dd></div>
          </dl>
          <button className="immersive-text-action" data-autofocus onClick={onOpenMenu} type="button">返回 · Esc</button>
        </section>
      )}

      {renderedMode === 'civilization-ending' && (
        <section aria-busy={civilizationSettlementStatus === 'settling'} className="civilization-ending-settings">
          <header className="utility-header">
            <button
              aria-label="返回观测与设置"
              className="utility-icon-button"
              onClick={onOpenMenu}
              type="button"
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <p className="immersive-eyebrow">文明 · {civilizationLabel}</p>
              <h1 id={titleId}>文明终章</h1>
            </div>
          </header>

          <div className="civilization-ending-settings__body">
            <div className="civilization-ending-settings__intro">
              <p>自然终结与手动结算共用同一套终章。它只读取已经发生的权威历史；模型不可用时，本地诗仍会完成演出。</p>
            </div>
            <section className="civilization-ending-settings__orchestration">
              <div><span>事实来源</span><strong>当前文明的权威历史</strong></div>
              <div><span>诗风选择</span><strong>由 AI 根据文明一生自决</strong></div>
              <div><span>演出形式</span><strong>单轴诗幕 · 逐句浮现</strong></div>
              <p>AI 只在四言重章、田园纪事、诗史长歌、古代名录史诗、鲁拜短章与自由诗名录之间判断；玩家不预设这段文明该被怎样书写。</p>
            </section>
          </div>

          <footer className="civilization-ending-settings__footer">
            <div aria-live={civilizationSettlementStatus === 'error' ? 'assertive' : 'polite'} role={civilizationSettlementStatus === 'error' ? 'alert' : 'status'}>
              <strong>结束文明不会伪造死亡</strong>
              <span>{civilizationSettlementMessage || '它会冻结当前权威历史，随后立即进入统一终章演出。'}</span>
            </div>
            <button
              className="immersive-button immersive-button--44 civilization-ending-settings__end"
              data-autofocus
              disabled={civilizationSettlementStatus === 'settling'}
              onClick={onEndCivilization}
              type="button"
            >
              {civilizationSettlementStatus === 'settling' ? '正在结算…' : '结束'}
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
