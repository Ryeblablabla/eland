import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { EvolutionMode, ModelPurpose, ModelSettingsSnapshot } from '@/game/modelSettings';
import type {
  CivilizationIndexHistoryPoint,
  CivilizationIndexView,
  ElandSaveSummary,
} from '@/game/societyContract';
import { STAR_STYLES } from '@/lib/threebody';
import { civilizationStagePreview } from '@/game/voxelKits';
import { CivilizationStageBuilding } from './CivilizationStageBuilding';
import './ImmersiveInterface.css';

export type ImmersiveOverlayMode = 'menu' | 'saves' | 'new-world' | 'history' | 'model-settings' | 'shortcuts' | null;
type ActiveImmersiveOverlayMode = Exclude<ImmersiveOverlayMode, null>;
type OverlayTransitionPhase = 'enter' | 'idle' | 'exit';
export type NewWorldStatus = 'idle' | 'starting' | 'error';
export type ModelSettingsStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error';
export type SaveManagerStatus = 'idle' | 'loading' | 'saving' | 'loading-save' | 'saved' | 'error';

export interface ImmersiveHistoryEntry {
  id: string;
  month: number;
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  detail?: string;
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
  newWorldSeed: number;
  newWorldStatus: NewWorldStatus;
  saves: ElandSaveSummary[];
  saveStatus: SaveManagerStatus;
  saveMessage: string;
  onClose: () => void;
  onOpenSaves: () => void;
  onOpenNewWorld: () => void;
  onOpenHistory: () => void;
  onOpenModelSettings: () => void;
  onOpenShortcuts: () => void;
  onCreateSave: (label: string) => void;
  onLoadSave: (saveId: string) => void;
  onEvolutionModeChange: (mode: EvolutionMode) => void;
  onModelRouteChange: (purpose: ModelPurpose, endpointId: string) => void;
  onSummaryModeChange: (mode: EvolutionMode) => void;
  onSaveModelSettings: () => void;
  onRefreshSeed: () => void;
  onStartNewWorld: () => void;
}

const FIGURE_EIGHT_PERIOD = 6.32591398;
const FIGURE_EIGHT_STEPS = 960;
const ORBIT_DURATION_SECONDS = 9;
const OVERLAY_EXIT_MS = 135;

const MODEL_PURPOSE_LABELS: Record<ModelPurpose, { title: string; description: string }> = {
  decision: { title: '人物决策与台词', description: '关键转折可重选；每次真实口头沟通都优先用同一端点表达' },
  interaction: { title: '主动人物对话', description: '按需让人物本人回应并形成待规则复核的建议；始终使用模型，不受演进模式开关影响' },
  narrative: { title: '叙事总结', description: '当前月事实总结与非权威叙事增强' },
  strategy: { title: '策略', description: '未来文明策略任务的扩展位' },
};

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
        <span>观察器正在等待权威状态。</span>
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
        <span>观察层</span>
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
      </div>
      <p className="civilization-index__note" title={`公式 ${index.formulaVersion}`}>
        {points.length} 个已提交月份 · 计算至 {monthLabel(index.calculatedAtMonth)} · 开放累计，不封顶 100
      </p>
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
  newWorldSeed,
  newWorldStatus,
  saves,
  saveStatus,
  saveMessage,
  onClose,
  onOpenSaves,
  onOpenNewWorld,
  onOpenHistory,
  onOpenModelSettings,
  onOpenShortcuts,
  onCreateSave,
  onLoadSave,
  onEvolutionModeChange,
  onModelRouteChange,
  onSummaryModeChange,
  onSaveModelSettings,
  onRefreshSeed,
  onStartNewWorld,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasOpenRef = useRef(false);
  const [renderedMode, setRenderedMode] = useState<ActiveImmersiveOverlayMode | null>(mode);
  const [transitionPhase, setTransitionPhase] = useState<OverlayTransitionPhase>(mode ? 'enter' : 'idle');
  const [saveLabel, setSaveLabel] = useState('');

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

  const visibleHistory = useMemo(() => history.filter((entry) => !entry.status).slice().reverse(), [history]);
  const historyCountLabel = historyTotalCount > visibleHistory.length
    ? `最近 ${visibleHistory.length} 条记录 · 更早记录已省略`
    : `共 ${visibleHistory.length} 条记录`;
  if (!renderedMode) return null;

  const titleId = `immersive-${renderedMode}-title`;
  const decisionEndpoint = modelSettings?.endpoints.find((endpoint) => endpoint.id === modelRouteDraft.decision);
  const interactionEndpoint = modelSettings?.endpoints.find((endpoint) => endpoint.id === modelRouteDraft.interaction);
  const narrativeEndpoint = modelSettings?.endpoints.find((endpoint) => endpoint.id === modelRouteDraft.narrative);
  const modelEvolutionAvailable = Boolean(decisionEndpoint?.configured);
  const modelSummaryAvailable = Boolean(narrativeEndpoint?.configured);
  const settingsDirty = Boolean(modelSettings && (
    modelSettings.evolutionMode !== modelEvolutionModeDraft
    || modelSettings.summaryMode !== modelSummaryModeDraft
    || modelSettings.purposes.some((purpose) => modelSettings.routes[purpose] !== modelRouteDraft[purpose])
  ));
  const activeModelUses = [
    { label: '按需人物对话', endpoint: interactionEndpoint },
    ...(modelEvolutionModeDraft === 'model' ? [{ label: '人物决策与台词', endpoint: decisionEndpoint }] : []),
    ...(modelSummaryModeDraft === 'model' ? [{ label: '纪事总结', endpoint: narrativeEndpoint }] : []),
  ];
  const modeSummary = `${modelEvolutionModeDraft === 'model' ? '模型演进' : '本地演进'} · ${modelSummaryModeDraft === 'model' ? '模型总结' : '本地总结'} · 对话按需模型`;
  const savesBusy = saveStatus === 'loading' || saveStatus === 'saving' || saveStatus === 'loading-save';
  const civilizationLabel = civilizationId > 0 ? `第 ${civilizationId} 号文明` : '文明编号待分配';
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
          <p className="immersive-eyebrow">{civilizationLabel} · {monthLabel(currentMonth)}</p>
          <h1 id={titleId}>观测</h1>
          <nav aria-label="观测命令" className="immersive-menu__actions">
            <button data-autofocus onClick={onClose} type="button">
              <span>继续</span><kbd>Esc</kbd>
            </button>
            <button onClick={onOpenSaves} type="button">
              <span>文明档案</span>
            </button>
            <button onClick={onOpenNewWorld} type="button">
              <span>新文明</span><kbd>N</kbd>
            </button>
            <button onClick={onOpenHistory} type="button">
              <span>文明历史</span><kbd>H</kbd>
            </button>
            <button onClick={onOpenModelSettings} type="button">
              <span>模型设置</span><kbd>M</kbd>
            </button>
            <button onClick={onOpenShortcuts} type="button">
              <span>按键</span><kbd>?</kbd>
            </button>
          </nav>
        </div>
      )}

      {renderedMode === 'saves' && (
        <section aria-busy={savesBusy} className="save-manager">
          <header>
            <p className="immersive-eyebrow">权威状态 · 本地档案</p>
            <h1 id={titleId}>文明档案</h1>
            <p>保存当前文明的世界、历史与活动分支；载入后从记录的月份继续。</p>
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
              <span>新建存档</span>
              <small>名称可留空</small>
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
            {saveMessage || (saveStatus === 'loading' ? '正在读取文明档案…' : '存档保存在本机演化服务中。')}
          </div>

          <div className="save-manager__list" tabIndex={0}>
            {saveStatus === 'loading' && saves.length === 0 ? (
              <p className="save-manager__empty">正在读取文明档案…</p>
            ) : saves.length === 0 ? (
              <p className="save-manager__empty">还没有存档。为当前文明留下第一份档案吧。</p>
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
                          <span aria-hidden="true"> · </span>
                          第 {save.elapsedMonths} 月
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
            <button className="immersive-text-action save-manager__cancel" onClick={onClose} type="button">取消 · Esc</button>
          </footer>
        </section>
      )}

      {renderedMode === 'new-world' && (
        <div aria-busy={newWorldStatus === 'starting'} className="new-world">
          <p className="immersive-eyebrow">等质量三体 · 八字形周期解</p>
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
          <p className="immersive-hint">Enter 开始 · Esc 返回</p>
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
                return (
                  <article className={`history-entry history-entry--${entry.tone}`} key={entry.id} title={entry.detail}>
                    <time aria-hidden={sameMonthAsPrevious || undefined}>{sameMonthAsPrevious ? '' : label}</time>
                    <div>
                      {sameMonthAsPrevious && <span className="sr-only">{label}：</span>}
                      <p>{entry.text}</p>
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
        <section className="model-settings" data-autofocus tabIndex={-1}>
          <header>
            <p className="immersive-eyebrow">{settingsDirty ? '待保存' : '当前配置'} · {modeSummary}</p>
            <h1 id={titleId}>模型设置</h1>
            <p>分别控制人物决策、真实口头台词与纪事总结；主动人物对话始终按需走模型。</p>
          </header>

          {modelSettingsStatus === 'loading' && (
            <p className="model-settings__loading" aria-live="polite">正在读取模型路由……</p>
          )}

          {modelSettingsStatus !== 'loading' && modelSettings && (
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
                      <strong>主动人物对话</strong>
                      <small>只在你发送消息时调用 interaction 路由；回复和影响判断不使用本地模板。</small>
                    </span>
                    <span aria-label="主动人物对话始终使用模型">
                      <strong>按需模型</strong>
                      <small>不受开关影响</small>
                    </span>
                  </div>
                  <div className="model-settings__mode-row">
                    <span>
                      <strong id="evolution-mode-label">人物决策与说话</strong>
                      <small>{modelEvolutionModeDraft === 'model'
                        ? '模型参与关键选择，并为每次真实口头沟通生成台词；本地规则始终裁决事实。'
                        : '仅使用确定性规则选择人物行动与生成台词。'}</small>
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
                      <strong id="summary-mode-label">纪事总结</strong>
                      <small>{modelSummaryModeDraft === 'model'
                        ? '模型压缩已发生的本月事实，失败时保留规则纪事。'
                        : '直接采用规则投影的事实纪事。'}</small>
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

                <section aria-label="当前参与的模型" className="model-settings__active">
                  <span>当前参与</span>
                  <div>
                    {activeModelUses.length === 0 ? (
                      <p>
                        <strong>仅本地规则</strong>
                        <small>当前月不会请求模型</small>
                      </p>
                    ) : activeModelUses.map(({ label, endpoint }) => (
                      <p key={label}>
                        <strong>{label}</strong>
                        <small>{endpoint ? `${endpoint.id} · ${endpoint.model}` : '模型端点不可用'}</small>
                      </p>
                    ))}
                  </div>
                </section>

                <details className="model-settings__advanced">
                  <summary>
                    <span>高级设置</span>
                    <small>端点路由与连接状态</small>
                  </summary>
                  <div className="model-settings__advanced-body">
                    <div className="model-settings__routes">
                      {modelSettings.purposes.map((purpose) => {
                        const labelId = `model-purpose-${purpose}-label`;
                        const descriptionId = `model-purpose-${purpose}-description`;
                        return (
                          <div className="model-field" key={purpose}>
                            <span id={labelId}>{MODEL_PURPOSE_LABELS[purpose].title}</span>
                            <span>
                              <Select
                                disabled={!modelSettings.editable || modelSettingsStatus === 'saving'}
                                onValueChange={(endpointId) => onModelRouteChange(purpose, endpointId)}
                                value={modelRouteDraft[purpose]}
                              >
                                <SelectTrigger
                                  aria-describedby={descriptionId}
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
                                  {modelSettings.endpoints.map((endpoint) => (
                                    <SelectItem className="model-select__item" key={endpoint.id} value={endpoint.id}>
                                      {endpoint.id} · {endpoint.model}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <small id={descriptionId}>{MODEL_PURPOSE_LABELS[purpose].description}</small>
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="model-settings__endpoints" aria-label="模型端点状态">
                      {modelSettings.endpoints.map((endpoint) => (
                        <div key={endpoint.id}>
                          <span aria-hidden="true" className={endpoint.configured ? 'is-ready' : 'is-missing'} />
                          <p>
                            <strong>{endpoint.id}</strong>
                            <small>{endpoint.model} · {endpoint.protocol} · {endpointHost(endpoint.url)}</small>
                          </p>
                          <em>{endpoint.configured ? '已配置' : endpoint.issue}</em>
                        </div>
                      ))}
                    </div>

                    <div className="model-settings__source">
                      <span>{modelSettings.configFile ?? '旧 Kimi 环境配置'}</span>
                      {!modelSettings.editable && <small>设置 THREEBODY_MODEL_CONFIG 后可在这里切换路由</small>}
                    </div>
                  </div>
                </details>
              </div>

              <div className="model-settings__actions">
                <div className="model-settings__feedback" aria-live="polite">
                  {modelSettingsMessage || '人物对话路由从下一条消息生效；演进与总结从下个月生效。'}
                </div>
                <div className="model-settings__action-buttons">
                  <button className="immersive-button immersive-button--secondary immersive-button--32" onClick={onClose} type="button">取消</button>
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
              <button className="immersive-text-action" onClick={onClose} type="button">合上 · Esc</button>
            </div>
          )}
        </section>
      )}

      {renderedMode === 'shortcuts' && (
        <section className="shortcut-view">
          <p className="immersive-eyebrow">不打断世界的操作方式</p>
          <h1 id={titleId}>按键</h1>
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
          <button className="immersive-text-action" data-autofocus onClick={onClose} type="button">合上 · Esc</button>
        </section>
      )}
    </div>
  );
}
