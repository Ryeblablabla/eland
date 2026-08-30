import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ThreeBodyCanvas, { type SimStats } from '@/components/ThreeBodyCanvas';
import SocietyScene3D, {
  type SocietyCameraMode,
  type SocietySceneSelection,
} from '@/components/SocietyScene3D';
import LimitedEmbodimentHud, {
  type EmbodimentFeedbackTone,
} from '@/components/LimitedEmbodimentHud';
import AtmosphereTransition, {
  type AtmosphereTransitionDirection,
} from '@/components/AtmosphereTransition';
import AdaptiveMusic from '@/components/AdaptiveMusic';
import ImmersiveInterface, {
  type CivilizationSettlementStatus,
  type ImmersiveOverlayMode,
  type ModelSettingsStatus,
  type NewWorldStatus,
  type SaveManagerStatus,
} from '@/components/ImmersiveInterface';
import CivilizationRequiem, {
  type CivilizationEndingView,
} from '@/components/CivilizationRequiem';
import {
  FocusInspector,
  type AgentSubtab,
  type FocusTarget,
} from '@/components/ObservationUI';
import {
  createCivilizationCreationId,
  createEmbodimentCommandId,
  createEmbodimentId,
  createEmbodimentReleaseId,
  createWorldSeed,
  ElandBackendUnavailableError,
  ElandSessionMissingError,
  ElandRequestConflictError,
  elandClient,
  getElandRunId,
  type ElandStepResult,
  type Frame,
} from '@/game/elandClient';
import type {
  BeginEmbodimentRequest,
  EmbodimentCommand,
  EmbodimentOptionView,
  EmbodimentTargetView,
  EmbodimentView,
} from '@/game/embodimentContract';
import {
  TransactionalSkySampler,
  type PreparedSkySample,
} from '@/game/eland/transactional-sky-sampler';
import {
  createMonthPlaybackTicket,
  inspectPrefetchedMonth,
  nextModelPlaybackBudgetMs,
  prefetchedMonthDelayMs,
  resolveMonthPlaybackDurationMs,
  type MonthAuthorityHead,
  type MonthPlaybackTicket,
} from '@/game/eland/month-playback-buffer';
import {
  modelSettingsClient,
  type EvolutionMode,
  type ModelEndpointDraft,
  type ModelEndpointTestResult,
  type ModelPurpose,
  type ModelSettingsSnapshot,
} from '@/game/modelSettings';
import type {
  AgentMemoryView,
  CivilizationIndexHistoryPoint,
  CosmosSnapshot,
  ElandSaveSummary,
  EraKey,
  NarrativeEntryView,
  SocietyState,
  SpeechLineView,
} from '@/game/societyContract';
import type { PlanetFate } from '@/lib/threebody';
import { useDocumentVisible } from '@/hooks/use-document-visible';
import {
  DEFAULT_EVOLUTION_SPEED,
  normalizeEvolutionSpeed,
  type EvolutionSpeed,
} from '@/game/evolutionSpeed';

type ViewMode = 'cosmos' | 'society';

type ExperienceMode =
  | { kind: 'observing' }
  | { kind: 'entering-embodiment'; agentId: string }
  | { kind: 'embodied'; view: EmbodimentView }
  | { kind: 'releasing-embodiment'; view: EmbodimentView };

interface EmbodimentPresentationPosition {
  agentId: string;
  cellId: number;
  z: number;
}

interface EvolutionEntry {
  id: string;
  civilizationId: number;
  branchId: string;
  month: number;
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  detail?: string;
  actorIds?: string[];
  sourceEventIds?: string[];
  status?: true;
}

interface MonthPlaybackSlot {
  ticket: MonthPlaybackTicket;
  skyAttempt: PreparedSkySample;
  requestedAtMs: number;
  result: ElandStepResult | null;
  presentationTimer: ReturnType<typeof setTimeout> | null;
}

const TU_PER_MONTH = 0.8 / 12;
const AUTO_STEP_BASE_MS = 4_000;
const MIN_MONTH_PLAYBACK_MS = 500;
const INITIAL_MODEL_PLAYBACK_BUDGET_MS = 10_000;
const EVOLUTION_SPEED_STORAGE_KEY = 'threebody:eland:evolution-speed-multiplier';
const EMPTY_MODEL_ROUTES: Record<ModelPurpose, string> = {
  decision: '', interaction: '', narrative: '', naming: '', strategy: '',
};
const ERA_TEXT: Record<EraKey, { big: string; sub: string; cls: string; glow: string }> = {
  stable: { big: '恒纪元', sub: '三日轨度可测 · 文明复苏', cls: 'text-amber-100', glow: 'rgba(251,191,36,0.25)' },
  chaotic: { big: '乱纪元', sub: '飞星失序 · 脱水！脱水！', cls: 'text-rose-200', glow: 'rgba(244,63,94,0.22)' },
  'chaotic-heat': { big: '酷暑纪元', sub: '烈日炙烤 · 焦土万里', cls: 'text-orange-200', glow: 'rgba(249,115,22,0.28)' },
  'chaotic-cold': { big: '严寒纪元', sub: '飞星远去 · 冰封千里', cls: 'text-sky-200', glow: 'rgba(56,189,248,0.25)' },
  burned: { big: '三日凌空', sub: '烈焰焚世', cls: 'text-orange-200', glow: 'rgba(249,115,22,0.3)' },
  frozen: { big: '长夜', sub: '飞星不动 · 万物冻结', cls: 'text-sky-200', glow: 'rgba(56,189,248,0.25)' },
  extinct: { big: '文明终结', sub: '星系崩解 · 世界不再重启', cls: 'text-purple-200', glow: 'rgba(168,85,247,0.3)' },
};

function isChaoticAnnouncement(era: EraKey): boolean {
  return era === 'chaotic'
    || era === 'chaotic-heat'
    || era === 'chaotic-cold'
    || era === 'burned'
    || era === 'frozen';
}

function eraKeyOf(fate: PlanetFate, fluxRel: number): EraKey {
  if (fate !== 'chaotic') return fate;
  if (fluxRel > 1.8) return 'chaotic-heat';
  if (fluxRel < 0.45) return 'chaotic-cold';
  return 'chaotic';
}

function authoritativeEraKeyOf(society: SocietyState, fallback: EraKey): EraKey {
  if (!society.epoch || !society.climate) return fallback;
  if (society.epoch === 'stable') return 'stable';
  if (society.climate.kind === 'cold') return 'chaotic-cold';
  if (society.climate.kind === 'heat' || society.climate.kind === 'fire') return 'chaotic-heat';
  return 'chaotic';
}

function crossesMajorEraBoundary(previous: EraKey, next: EraKey): boolean {
  return (previous === 'stable') !== (next === 'stable');
}

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第${Math.floor((month - 1) / 12) + 1}年 · ${((month - 1) % 12) + 1}月`;
}

function readEvolutionSpeed(): EvolutionSpeed {
  if (typeof window === 'undefined') return DEFAULT_EVOLUTION_SPEED;
  try {
    const stored = window.localStorage.getItem(EVOLUTION_SPEED_STORAGE_KEY);
    return stored === null ? DEFAULT_EVOLUTION_SPEED : normalizeEvolutionSpeed(Number(stored));
  } catch {
    return DEFAULT_EVOLUTION_SPEED;
  }
}

function storeEvolutionSpeed(speed: EvolutionSpeed): void {
  try {
    window.localStorage.setItem(EVOLUTION_SPEED_STORAGE_KEY, String(speed));
  } catch {
    // 浏览器禁用本地存储时仍保留当前标签页内的速度选择。
  }
}

function sameEmbodimentCommand(left: EmbodimentCommand, right: EmbodimentCommand): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'wait' || right.kind === 'wait') return true;
  return left.optionId === right.optionId
    && left.choiceKey === right.choiceKey
    && left.followUpOptionId === right.followUpOptionId;
}

function presentationPositionOf(view: EmbodimentView): EmbodimentPresentationPosition {
  return {
    agentId: view.actorId,
    cellId: view.actor.cellId,
    z: view.actor.z,
  };
}

function monthAuthorityHeadOf(frame: Frame): MonthAuthorityHead {
  return {
    runId: frame.runId,
    authorityRevision: frame.authorityRevision,
    civilizationId: frame.civilizationId,
    branchId: frame.branchId,
    elapsedMonths: frame.elapsedMonths,
  };
}

export default function ImmersiveGame() {
  const pageVisible = useDocumentVisible();
  const [society, setSociety] = useState<SocietyState | null>(null);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [speechLines, setSpeechLines] = useState<SpeechLineView[]>([]);
  const [view, setView] = useState<ViewMode>('cosmos');
  const [eraKey, setEraKey] = useState<EraKey>('stable');
  const [announce, setAnnounce] = useState<{ era: EraKey; key: number } | null>(null);
  const [history, setHistory] = useState<EvolutionEntry[]>([]);
  const [historyTotalCount, setHistoryTotalCount] = useState(0);
  const [civilizationIndexHistory, setCivilizationIndexHistory] = useState<CivilizationIndexHistoryPoint[]>([]);
  const [atmosphereTransition, setAtmosphereTransition] = useState<AtmosphereTransitionDirection | null>(null);
  const [universeTarget, setUniverseTarget] = useState(0);
  const [universeResetToken, setUniverseResetToken] = useState(0);
  const [restoreSnapshot, setRestoreSnapshot] = useState<CosmosSnapshot | null>(null);
  const [respawnToken, setRespawnToken] = useState(0);
  const [exitFocusToken, setExitFocusToken] = useState(0);
  const [overlayMode, setOverlayMode] = useState<ImmersiveOverlayMode>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettingsSnapshot | null>(null);
  const [modelSettingsStatus, setModelSettingsStatus] = useState<ModelSettingsStatus>('idle');
  const [modelSettingsMessage, setModelSettingsMessage] = useState('');
  const [modelEvolutionModeDraft, setModelEvolutionModeDraft] = useState<EvolutionMode>('local');
  const [modelSummaryModeDraft, setModelSummaryModeDraft] = useState<EvolutionMode>('local');
  const [modelRouteDraft, setModelRouteDraft] = useState<Record<ModelPurpose, string>>(EMPTY_MODEL_ROUTES);
  const [newWorldSeed, setNewWorldSeed] = useState(createWorldSeed);
  const [newWorldStatus, setNewWorldStatus] = useState<NewWorldStatus>('idle');
  const [saves, setSaves] = useState<ElandSaveSummary[]>([]);
  const [saveManagerStatus, setSaveManagerStatus] = useState<SaveManagerStatus>('idle');
  const [saveManagerMessage, setSaveManagerMessage] = useState('');
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [focusAgentSubtab, setFocusAgentSubtab] = useState<AgentSubtab>('overview');
  const [focusAgentMemory, setFocusAgentMemory] = useState<AgentMemoryView | null>(null);
  const [focusAgentMemoryLoading, setFocusAgentMemoryLoading] = useState(false);
  const [focusAgentMemoryError, setFocusAgentMemoryError] = useState('');
  const [civilizationEnding, setCivilizationEnding] = useState<CivilizationEndingView | null>(null);
  const [civilizationSettlementStatus, setCivilizationSettlementStatus] = useState<CivilizationSettlementStatus>('idle');
  const [civilizationSettlementMessage, setCivilizationSettlementMessage] = useState('');
  const [evolutionSpeed, setEvolutionSpeed] = useState<EvolutionSpeed>(readEvolutionSpeed);
  const [modelPlaybackBudgetMs, setModelPlaybackBudgetMs] = useState(INITIAL_MODEL_PLAYBACK_BUDGET_MS);
  const modelEvolutionActive = modelSettings?.evolutionMode === 'model'
    || modelEvolutionModeDraft === 'model';
  const monthPlaybackDurationMs = resolveMonthPlaybackDurationMs(
    AUTO_STEP_BASE_MS,
    evolutionSpeed,
    MIN_MONTH_PLAYBACK_MS,
    speechLines.map((line) => line.text),
    modelEvolutionActive ? modelPlaybackBudgetMs : 0,
  );
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>({ kind: 'observing' });
  const [embodimentTarget, setEmbodimentTarget] = useState<EmbodimentTargetView | null>(null);
  const [previewEmbodimentOption, setPreviewEmbodimentOption] = useState<EmbodimentOptionView | null>(null);
  const [embodimentCommandPending, setEmbodimentCommandPending] = useState(false);
  const [embodimentCameraSettled, setEmbodimentCameraSettled] = useState(true);
  const [embodimentPointerLocked, setEmbodimentPointerLocked] = useState(false);
  const [embodimentFeedback, setEmbodimentFeedbackValue] = useState('');
  const [embodimentFeedbackTone, setEmbodimentFeedbackTone] = useState<EmbodimentFeedbackTone>('progress');
  const [embodimentPresentationPosition, setEmbodimentPresentationPosition] = useState<EmbodimentPresentationPosition | null>(null);

  const runIdRef = useRef(getElandRunId());
  const startedRef = useRef(false);
  const resumeCheckCompleteRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const sessionStartingRef = useRef(false);
  const hasFrameRef = useRef(false);
  const latestFrameRef = useRef<Frame | null>(null);
  const steppingRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const visibleFrameStartedAtRef = useRef(0);
  const monthPlaybackSlotRef = useRef<MonthPlaybackSlot | null>(null);
  const nextMonthRequestAtRef = useRef(0);
  const historySequenceRef = useRef(0);
  const historyRef = useRef<EvolutionEntry[]>([]);
  const historyTotalCountRef = useRef(0);
  const activeCivilizationRef = useRef(0);
  const activeBranchRef = useRef('');
  const activeWorldSeedRef = useRef<number | null>(null);
  const pendingCreationRef = useRef<{ id: string; worldSeed: number } | null>(null);
  const monthRef = useRef(0);
  const statsRef = useRef<SimStats | null>(null);
  const previousCivilizationRef = useRef(1);
  const canvasCivilizationSyncRef = useRef(false);
  const expectedUniverseResetTokenRef = useRef(0);
  const eraKeyRef = useRef<EraKey>('stable');
  const presentedEraKeyRef = useRef<EraKey>('stable');
  const eraInitializedRef = useRef(false);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skySamplerRef = useRef(new TransactionalSkySampler());
  const pendingStepSkyRef = useRef<PreparedSkySample | null>(null);
  const embodimentSkyAttemptRef = useRef<PreparedSkySample | null>(null);
  const pendingEmbodimentBeginRef = useRef<{
    input: BeginEmbodimentRequest;
    skyAttempt: PreparedSkySample;
  } | null>(null);
  const embodimentBeginInFlightRef = useRef(false);
  const pendingEmbodimentCommandRef = useRef<{
    embodimentId: string;
    commandId: string;
    expectedRevision: number;
    expectedTick: number;
    command: EmbodimentCommand;
  } | null>(null);
  const pendingEmbodimentReleaseRef = useRef<{
    embodimentId: string;
    releaseId: string;
    expectedRevision: number;
  } | null>(null);
  const embodimentMutationInFlightRef = useRef(false);
  const bufferedEmbodimentMoveRef = useRef<'north' | 'south' | 'east' | 'west' | null>(null);
  const heldEmbodimentMoveRef = useRef<'north' | 'south' | 'east' | 'west' | null>(null);
  const queuedEmbodimentReleaseRef = useRef(false);
  const moveEmbodimentRef = useRef<((direction: 'north' | 'south' | 'east' | 'west') => void) | null>(null);
  const releaseEmbodimentRef = useRef<(() => Promise<void>) | null>(null);
  const collapseHandledRef = useRef(false);
  const replacementRequestedRef = useRef(false);
  const transitionRef = useRef(false);
  const newWorldLaunchingRef = useRef(false);
  const uiPaused = overlayMode !== null || civilizationEnding !== null || atmosphereTransition !== null;
  const worldAdvancePaused = uiPaused || experienceMode.kind !== 'observing';
  const experienceModeRef = useRef(experienceMode);
  const worldAdvancePausedRef = useRef(worldAdvancePaused);
  experienceModeRef.current = experienceMode;
  worldAdvancePausedRef.current = worldAdvancePaused;
  const setEmbodimentFeedback = useCallback((message: string, tone: EmbodimentFeedbackTone = 'error') => {
    setEmbodimentFeedbackValue(message);
    setEmbodimentFeedbackTone(tone);
  }, []);

  const clearMonthPlaybackBuffer = useCallback(() => {
    const slot = monthPlaybackSlotRef.current;
    if (slot?.presentationTimer) clearTimeout(slot.presentationTimer);
    const skyAttempt = slot?.skyAttempt ?? pendingStepSkyRef.current;
    if (skyAttempt) skySamplerRef.current.rollback(skyAttempt);
    monthPlaybackSlotRef.current = null;
    pendingStepSkyRef.current = null;
    steppingRef.current = false;
    nextMonthRequestAtRef.current = 0;
  }, []);

  useEffect(() => () => clearMonthPlaybackBuffer(), [clearMonthPlaybackBuffer]);

  useEffect(() => {
    const checkpointSession = () => { void elandClient.checkpoint(runIdRef.current); };
    window.addEventListener('pagehide', checkpointSession);
    return () => window.removeEventListener('pagehide', checkpointSession);
  }, []);

  const requestUniverseReset = useCallback(() => {
    const next = expectedUniverseResetTokenRef.current + 1;
    expectedUniverseResetTokenRef.current = next;
    setUniverseResetToken(next);
  }, []);

  useEffect(() => () => {
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
  }, []);

  const flashEra = useCallback((era: EraKey) => {
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    setAnnounce({ era, key: Date.now() });
    announceTimerRef.current = setTimeout(() => {
      setAnnounce(null);
      announceTimerRef.current = null;
    }, 3_400);
  }, []);

  const pushHistory = useCallback((
    month: number,
    text: string,
    tone: EvolutionEntry['tone'] = 'plain',
    detail?: string,
    metadata?: Pick<EvolutionEntry, 'actorIds' | 'sourceEventIds'> & { id?: string },
  ) => {
    const id = metadata?.id ?? `${runIdRef.current}:history:${historySequenceRef.current++}`;
    const sources = new Set(metadata?.sourceEventIds ?? []);
    const events = historyRef.current.filter((entry) => !entry.status);
    const superseded = events.filter((entry) => entry.id === id || (
      sources.size > 0
        && Boolean(entry.sourceEventIds?.length)
        && entry.sourceEventIds?.every((sourceEventId) => sources.has(sourceEventId)) === true
    ));
    const next = [...events.filter((entry) => !superseded.includes(entry)).slice(-239), {
      id,
      civilizationId: activeCivilizationRef.current,
      branchId: activeBranchRef.current,
      month,
      text,
      tone,
      ...(detail ? { detail } : {}),
      ...(metadata?.actorIds?.length ? { actorIds: metadata.actorIds } : {}),
      ...(metadata?.sourceEventIds?.length ? { sourceEventIds: metadata.sourceEventIds } : {}),
    }];
    historyRef.current = next;
    historyTotalCountRef.current = Math.max(
      next.length,
      historyTotalCountRef.current + 1 - superseded.length,
    );
    setHistoryTotalCount(historyTotalCountRef.current);
    setHistory(next);
  }, []);

  const showRuntimeStatus = useCallback((text: string) => {
    const next = [...historyRef.current.filter((entry) => !entry.status).slice(-239), {
      id: `${runIdRef.current}:runtime-status`,
      civilizationId: activeCivilizationRef.current,
      branchId: activeBranchRef.current,
      month: monthRef.current,
      text,
      tone: 'plain',
      status: true,
    } satisfies EvolutionEntry];
    historyRef.current = next;
    setHistory(next);
  }, []);

  const replaceHistory = useCallback((frame: Frame, entries: NarrativeEntryView[], totalCount: number) => {
    const normalizedTotalCount = Number.isFinite(totalCount)
      ? Math.max(entries.length, Math.floor(totalCount))
      : entries.length;
    historySequenceRef.current = normalizedTotalCount;
    historyTotalCountRef.current = normalizedTotalCount;
    setHistoryTotalCount(normalizedTotalCount);
    const next = entries.slice(-240).map((entry) => ({
      id: entry.id,
      civilizationId: frame.civilizationId,
      branchId: frame.branchId,
      month: entry.month,
      text: entry.text,
      tone: entry.tone,
      detail: entry.detail,
      actorIds: entry.actorIds,
      sourceEventIds: entry.sourceEventIds,
    }));
    historyRef.current = next;
    setHistory(next);
  }, []);

  const applyFrame = useCallback((frame: Frame) => {
    const previousFrame = latestFrameRef.current;
    if (!previousFrame
      || previousFrame.authorityRevision !== frame.authorityRevision
      || previousFrame.civilizationId !== frame.civilizationId
      || previousFrame.branchId !== frame.branchId
      || previousFrame.elapsedMonths !== frame.elapsedMonths) {
      visibleFrameStartedAtRef.current = performance.now();
    }
    latestFrameRef.current = frame;
    hasFrameRef.current = true;
    const civilizationChanged = activeCivilizationRef.current !== frame.civilizationId;
    const branchChanged = Boolean(activeBranchRef.current) && activeBranchRef.current !== frame.branchId;
    if (civilizationChanged) {
      canvasCivilizationSyncRef.current = true;
    }
    previousCivilizationRef.current = frame.civilizationId;
    activeCivilizationRef.current = frame.civilizationId;
    activeBranchRef.current = frame.branchId;
    activeWorldSeedRef.current = frame.society.world.generator.seed;
    monthRef.current = frame.elapsedMonths;
    setSociety(frame.society);
    const presentedEra = authoritativeEraKeyOf(frame.society, frame.skySample.fate);
    const previousPresentedEra = presentedEraKeyRef.current;
    presentedEraKeyRef.current = presentedEra;
    setEraKey(presentedEra);
    if (eraInitializedRef.current && crossesMajorEraBoundary(previousPresentedEra, presentedEra)) {
      flashEra(presentedEra);
    }
    eraInitializedRef.current = true;
    setSpeaker(frame.speaker);
    setSpeechLines(frame.speechLines ?? []);
    const observedIndex = frame.society.observations.civilizationIndex;
    if (observedIndex) {
      const point: CivilizationIndexHistoryPoint = {
        formulaVersion: observedIndex.formulaVersion,
        total: observedIndex.total,
        calculatedAtMonth: observedIndex.calculatedAtMonth,
        stage: observedIndex.stage,
      };
      setCivilizationIndexHistory((current) => {
        const base = civilizationChanged ? [] : current;
        const beforeCurrentMonth = base.filter((item) => item.calculatedAtMonth < point.calculatedAtMonth);
        return [...beforeCurrentMonth, point].slice(-2_400);
      });
    } else if (civilizationChanged || branchChanged) {
      setCivilizationIndexHistory([]);
    }
    for (const entry of frame.entries) {
      pushHistory(entry.month, entry.text, entry.tone, entry.detail, {
        id: entry.id,
        actorIds: entry.actorIds,
        sourceEventIds: entry.sourceEventIds,
      });
    }

    if (frame.civilizationEnd) sessionReadyRef.current = false;
    if (frame.civilizationEnd && !replacementRequestedRef.current) {
      replacementRequestedRef.current = true;
      setFocusTarget(null);
      setFocusAgentSubtab('overview');
      setCivilizationEnding({
        civilizationId: frame.civilizationId,
        branchId: frame.branchId,
        elapsedMonths: frame.elapsedMonths,
        kind: frame.civilizationEnd.kind,
        cause: frame.civilizationEnd.cause,
        summary: frame.civilizationEnd.summary,
      });
    }
  }, [flashEra, pushHistory]);

  const startCivilization = useCallback(async (
    worldSeed = createWorldSeed(),
    resetHistory = false,
  ): Promise<boolean> => {
    const pendingCreation = pendingCreationRef.current?.worldSeed === worldSeed
      ? pendingCreationRef.current
      : { id: createCivilizationCreationId(), worldSeed };
    pendingCreationRef.current = pendingCreation;
    const generation = ++sessionGenerationRef.current;
    clearMonthPlaybackBuffer();
    sessionStartingRef.current = true;
    sessionReadyRef.current = false;
    activeWorldSeedRef.current = worldSeed;
    if (resetHistory) {
      historySequenceRef.current = 0;
      historyRef.current = [];
      historyTotalCountRef.current = 0;
      setHistoryTotalCount(0);
      setHistory([]);
      setCivilizationIndexHistory([]);
    }
    showRuntimeStatus(monthRef.current > 0 ? '演化后端正在恢复连接' : '本地演化正在开始');
    const skyAttempt = skySamplerRef.current.prepare(eraKeyRef.current);
    const sky = skyAttempt.sample;
    try {
      const frame = await elandClient.begin(
        runIdRef.current,
        pendingCreation.id,
        sky,
        undefined,
        worldSeed,
        statsRef.current?.cosmosSnapshot,
      );
      if (generation !== sessionGenerationRef.current) {
        skySamplerRef.current.rollback(skyAttempt);
        return false;
      }
      skySamplerRef.current.commit(skyAttempt);
      if (pendingCreationRef.current?.id === pendingCreation.id) pendingCreationRef.current = null;
      applyFrame(frame);
      replacementRequestedRef.current = false;
      sessionReadyRef.current = true;
      setUniverseTarget((target) => Math.max(sky.toTime, target) + TU_PER_MONTH);
      return true;
    } catch (error) {
      skySamplerRef.current.rollback(skyAttempt);
      if (generation !== sessionGenerationRef.current) return false;
      showRuntimeStatus(error instanceof ElandBackendUnavailableError
        ? '后端正在更新，演化会自动重连'
        : error instanceof Error ? error.message : '本地演化会话启动失败');
      return false;
    } finally {
      if (generation === sessionGenerationRef.current) sessionStartingRef.current = false;
    }
  }, [applyFrame, clearMonthPlaybackBuffer, showRuntimeStatus]);

  const restoreLoadedSession = useCallback((
    frame: Frame,
    entries: NarrativeEntryView[],
    historyTotalCount: number,
    indexHistory: CivilizationIndexHistoryPoint[],
    embodiment?: EmbodimentView | null,
  ) => {
    pendingCreationRef.current = null;
    clearMonthPlaybackBuffer();
    sessionGenerationRef.current += 1;
    sessionStartingRef.current = false;
    steppingRef.current = false;
    sessionReadyRef.current = true;
    hasFrameRef.current = true;
    replacementRequestedRef.current = false;
    collapseHandledRef.current = Boolean(frame.cosmosSnapshot?.pendingCollapse);
    canvasCivilizationSyncRef.current = true;
    previousCivilizationRef.current = frame.civilizationId;
    activeCivilizationRef.current = frame.civilizationId;
    activeBranchRef.current = frame.branchId;
    activeWorldSeedRef.current = frame.society.world.generator.seed;
    monthRef.current = frame.elapsedMonths;
    pendingStepSkyRef.current = null;
    embodimentSkyAttemptRef.current = null;
    pendingEmbodimentBeginRef.current = null;
    embodimentBeginInFlightRef.current = false;
    pendingEmbodimentCommandRef.current = null;
    pendingEmbodimentReleaseRef.current = null;
    embodimentMutationInFlightRef.current = false;
    bufferedEmbodimentMoveRef.current = null;
    heldEmbodimentMoveRef.current = null;
    queuedEmbodimentReleaseRef.current = false;
    setEmbodimentCommandPending(false);
    setEmbodimentPresentationPosition(null);
    setEmbodimentTarget(null);
    setPreviewEmbodimentOption(null);
    setEmbodimentPointerLocked(false);
    skySamplerRef.current.restore(frame.skySample);
    statsRef.current = null;
    transitionRef.current = false;
    setAtmosphereTransition(null);
    setView('cosmos');
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setCivilizationEnding(null);
    setRestoreSnapshot(frame.cosmosSnapshot ?? null);
    setUniverseTarget(frame.cosmosSnapshot?.t ?? frame.universeTime);
    requestUniverseReset();
    setExitFocusToken((token) => token + 1);
    eraKeyRef.current = frame.skySample.fate;
    const restoredEra = authoritativeEraKeyOf(frame.society, frame.skySample.fate);
    presentedEraKeyRef.current = restoredEra;
    eraInitializedRef.current = true;
    setEraKey(restoredEra);
    applyFrame(frame);
    replaceHistory(frame, entries, historyTotalCount);
    setCivilizationIndexHistory(indexHistory.slice(-2_400));
    if (embodiment) {
      const embodied = { kind: 'embodied', view: embodiment } as const;
      experienceModeRef.current = embodied;
      worldAdvancePausedRef.current = true;
      setExperienceMode(embodied);
      setSociety(embodiment.society);
      setView('society');
      setEmbodimentPresentationPosition(presentationPositionOf(embodiment));
      setEmbodimentCameraSettled(true);
      setEmbodimentFeedback('已恢复上次未完成的化身月份', 'success');
    } else {
      experienceModeRef.current = { kind: 'observing' };
      setExperienceMode({ kind: 'observing' });
    }
  }, [applyFrame, clearMonthPlaybackBuffer, replaceHistory, requestUniverseReset, setEmbodimentFeedback]);

  const finishEmbodiment = useCallback((frame: Frame) => {
    const skyAttempt = embodimentSkyAttemptRef.current;
    if (skyAttempt) skySamplerRef.current.commit(skyAttempt);
    else skySamplerRef.current.restore(frame.skySample);
    embodimentSkyAttemptRef.current = null;
    pendingEmbodimentBeginRef.current = null;
    embodimentBeginInFlightRef.current = false;
    pendingEmbodimentCommandRef.current = null;
    pendingEmbodimentReleaseRef.current = null;
    embodimentMutationInFlightRef.current = false;
    bufferedEmbodimentMoveRef.current = null;
    heldEmbodimentMoveRef.current = null;
    queuedEmbodimentReleaseRef.current = false;
    setEmbodimentCommandPending(false);
    setEmbodimentPresentationPosition(null);
    setEmbodimentCameraSettled(true);
    setEmbodimentTarget(null);
    setPreviewEmbodimentOption(null);
    setEmbodimentPointerLocked(false);
    setEmbodimentFeedback('');
    experienceModeRef.current = { kind: 'observing' };
    worldAdvancePausedRef.current = uiPaused;
    setExperienceMode({ kind: 'observing' });
    eraKeyRef.current = frame.skySample.fate;
    applyFrame(frame);
    setUniverseTarget((target) => Math.max(frame.skySample.toTime, target) + TU_PER_MONTH);
  }, [applyFrame, setEmbodimentFeedback, uiPaused]);

  const enterEmbodiment = useCallback(async (agentId: string) => {
    const currentMode = experienceModeRef.current;
    if (currentMode.kind === 'observing') heldEmbodimentMoveRef.current = null;
    let pending = pendingEmbodimentBeginRef.current;
    const retryingUnknownResult = currentMode.kind === 'entering-embodiment'
      && pending?.input.agentId === agentId;
    const continuingQueuedEntry = currentMode.kind === 'entering-embodiment'
      && currentMode.agentId === agentId
      && !pending;
    if (embodimentBeginInFlightRef.current
      || (!retryingUnknownResult && !continuingQueuedEntry && currentMode.kind !== 'observing')) return;
    if (!retryingUnknownResult && (steppingRef.current || sessionStartingRef.current)) {
      const queuedEntering = { kind: 'entering-embodiment', agentId } as const;
      experienceModeRef.current = queuedEntering;
      worldAdvancePausedRef.current = true;
      setExperienceMode(queuedEntering);
      setFocusTarget(null);
      setFocusAgentSubtab('overview');
      setEmbodimentCommandPending(true);
      setEmbodimentFeedback('正在等待当前权威月份收束，随后自动接管身体', 'progress');
      const deadline = performance.now() + 15_000;
      while (steppingRef.current || sessionStartingRef.current) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
        const mode = experienceModeRef.current;
        if (mode.kind !== 'entering-embodiment' || mode.agentId !== agentId) return;
        if (performance.now() >= deadline) {
          setEmbodimentCommandPending(false);
          setEmbodimentFeedback('当前月份仍未收束；世界保持暂停，可以重试同一次进入', 'blocked');
          return;
        }
      }
    }
    if (!pending) {
      clearMonthPlaybackBuffer();
      const frame = latestFrameRef.current;
      const cosmos = statsRef.current?.cosmosSnapshot;
      if (!frame || !cosmos) {
        setEmbodimentFeedback('当前天象还没有准备好，请稍后再试', 'blocked');
        return;
      }
      const skyAttempt = skySamplerRef.current.prepare(eraKeyRef.current);
      pending = {
        input: {
          runId: runIdRef.current,
          embodimentId: createEmbodimentId(),
          agentId,
          expectedAuthorityRevision: frame.authorityRevision,
          expectedCivilizationId: frame.civilizationId,
          expectedBranchId: frame.branchId,
          expectedElapsedMonths: frame.elapsedMonths,
          skySample: skyAttempt.sample,
          cosmosSnapshot: cosmos,
        },
        skyAttempt,
      };
      pendingEmbodimentBeginRef.current = pending;
    }
    const entering = { kind: 'entering-embodiment', agentId } as const;
    experienceModeRef.current = entering;
    worldAdvancePausedRef.current = true;
    setExperienceMode(entering);
    const provisionalActor = latestFrameRef.current?.society.agents.find((agent) => agent.id === agentId);
    if (provisionalActor) {
      setEmbodimentPresentationPosition({
        agentId,
        cellId: provisionalActor.cellId,
        z: provisionalActor.z,
      });
    }
    setView('society');
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    queuedEmbodimentReleaseRef.current = false;
    setEmbodimentCommandPending(true);
    setEmbodimentFeedback(
      retryingUnknownResult ? '正在用同一请求确认进入结果' : '正在接管身体；现在可以转头观察',
      'progress',
    );
    embodimentBeginInFlightRef.current = true;
    try {
      const { embodiment } = await elandClient.beginEmbodiment(pending.input);
      pendingEmbodimentBeginRef.current = null;
      embodimentSkyAttemptRef.current = pending.skyAttempt;
      const embodied = { kind: 'embodied', view: embodiment } as const;
      experienceModeRef.current = embodied;
      setExperienceMode(embodied);
      setSociety(embodiment.society);
      setView('society');
      setEmbodimentPresentationPosition(presentationPositionOf(embodiment));
      setEmbodimentCommandPending(false);
      setEmbodimentTarget(null);
      setEmbodimentCameraSettled(!provisionalActor
        || (provisionalActor.cellId === embodiment.actor.cellId && provisionalActor.z === embodiment.actor.z));
      setEmbodimentFeedback('');
      const heldDirection = heldEmbodimentMoveRef.current;
      if (heldDirection) queueMicrotask(() => moveEmbodimentRef.current?.(heldDirection));
    } catch (error) {
      let reconciled: EmbodimentView | null | undefined;
      let absenceConfirmed = false;
      try {
        const state = await elandClient.embodimentState(runIdRef.current);
        reconciled = state.embodiment;
        absenceConfirmed = state.embodiment === null;
      } catch (stateError) {
        if (stateError instanceof ElandSessionMissingError) {
          absenceConfirmed = true;
        } else if (error instanceof ElandRequestConflictError) {
          reconciled = error.embodiment;
          absenceConfirmed = !error.embodiment;
        }
      }

      if (reconciled) {
        pendingEmbodimentBeginRef.current = null;
        if (reconciled.id === pending.input.embodimentId) {
          embodimentSkyAttemptRef.current = pending.skyAttempt;
        } else {
          skySamplerRef.current.rollback(pending.skyAttempt);
          embodimentSkyAttemptRef.current = null;
        }
        const embodied = { kind: 'embodied', view: reconciled } as const;
        experienceModeRef.current = embodied;
        setExperienceMode(embodied);
        setSociety(reconciled.society);
        setView('society');
        setEmbodimentPresentationPosition(presentationPositionOf(reconciled));
        setEmbodimentCommandPending(false);
        setEmbodimentTarget(null);
        setEmbodimentCameraSettled(!provisionalActor
          || (provisionalActor.cellId === reconciled.actor.cellId && provisionalActor.z === reconciled.actor.z));
        setEmbodimentFeedback(reconciled.id === pending.input.embodimentId
          ? '已确认进入结果'
          : '已接回服务端现有的化身月份', 'success');
        const heldDirection = heldEmbodimentMoveRef.current;
        if (heldDirection) queueMicrotask(() => moveEmbodimentRef.current?.(heldDirection));
      } else if (absenceConfirmed) {
        skySamplerRef.current.rollback(pending.skyAttempt);
        pendingEmbodimentBeginRef.current = null;
        experienceModeRef.current = { kind: 'observing' };
        worldAdvancePausedRef.current = uiPaused;
        setExperienceMode({ kind: 'observing' });
        setEmbodimentPresentationPosition(null);
        setEmbodimentCommandPending(false);
        setEmbodimentFeedback(error instanceof Error ? error.message : '无法进入这个人物');
      } else {
        setEmbodimentFeedback('进入结果尚未确认；世界保持暂停，请重试同一次进入');
      }
    } finally {
      embodimentBeginInFlightRef.current = false;
      if (experienceModeRef.current.kind === 'entering-embodiment') {
        setEmbodimentCommandPending(false);
      }
    }
  }, [clearMonthPlaybackBuffer, setEmbodimentFeedback, uiPaused]);

  const chooseEmbodimentOption = useCallback(async (option: EmbodimentOptionView) => {
    const mode = experienceModeRef.current;
    if (mode.kind !== 'embodied' || embodimentMutationInFlightRef.current) return;
    if (pendingEmbodimentReleaseRef.current) {
      setEmbodimentFeedback('交还结果尚未确认，请再次按 Tab 重试交还', 'blocked');
      return;
    }
    const command: EmbodimentCommand = option.source === 'wait'
      ? { kind: 'wait' }
      : { kind: 'choose-option', optionId: option.optionId, choiceKey: option.choiceKey };
    const expectedTick = mode.view.nextTick ?? mode.view.completedTick + 1;
    let pendingRequest = pendingEmbodimentCommandRef.current;
    if (pendingRequest && (pendingRequest.embodimentId !== mode.view.id
      || pendingRequest.expectedRevision !== mode.view.revision
      || pendingRequest.expectedTick !== expectedTick)) {
      pendingEmbodimentCommandRef.current = null;
      pendingRequest = null;
    }
    if (queuedEmbodimentReleaseRef.current && !pendingRequest) {
      setEmbodimentFeedback('当前刻确认后会交还身体，不再接受新的行动', 'progress');
      return;
    }
    if (pendingRequest && !sameEmbodimentCommand(pendingRequest.command, command)) {
      setEmbodimentFeedback('上一行动结果尚未确认；请再次选择原行动重试，不能改发另一行动', 'blocked');
      return;
    }
    const request = pendingRequest ?? {
      embodimentId: mode.view.id,
      commandId: createEmbodimentCommandId(),
      expectedRevision: mode.view.revision,
      expectedTick,
      command,
    };
    pendingEmbodimentCommandRef.current = request;
    embodimentMutationInFlightRef.current = true;
    const authoritativePosition = presentationPositionOf(mode.view);
    const predictedMove = option.category === 'move' && option.target?.kind === 'standing-position'
      ? option.target
      : null;
    if (predictedMove) {
      // This position is presentation-only. The command below still references
      // the server-issued option and the next command is always resolved from
      // the latest authoritative EmbodimentView.
      setEmbodimentPresentationPosition({
        agentId: mode.view.actorId,
        cellId: predictedMove.cellId,
        z: predictedMove.z,
      });
      setEmbodimentCameraSettled(false);
    }
    setEmbodimentCommandPending(true);
    setEmbodimentFeedback(
      predictedMove ? '正在迈步；世界将确认这一刻' : '本刻人物与世界正在同时行动',
      'progress',
    );
    let drainBufferedMove = false;
    try {
      const result = await elandClient.stepEmbodiment({ runId: runIdRef.current, ...request });
      pendingEmbodimentCommandRef.current = null;
      setEmbodimentCommandPending(false);
      drainBufferedMove = true;
      if ('committedFrame' in result) {
        finishEmbodiment(result.committedFrame);
        return;
      }
      const embodied = { kind: 'embodied', view: result.embodiment } as const;
      experienceModeRef.current = embodied;
      setExperienceMode(embodied);
      setSociety(result.embodiment.society);
      const nextAuthoritativePosition = presentationPositionOf(result.embodiment);
      const authorityMovedUnexpectedly = nextAuthoritativePosition.cellId !== authoritativePosition.cellId
        || nextAuthoritativePosition.z !== authoritativePosition.z;
      setEmbodimentPresentationPosition(nextAuthoritativePosition);
      if (predictedMove) {
        const predictionConfirmed = result.embodiment.actor.cellId === predictedMove.cellId
          && result.embodiment.actor.z === predictedMove.z;
        if (!predictionConfirmed) {
          setEmbodimentCameraSettled(false);
          bufferedEmbodimentMoveRef.current = null;
          drainBufferedMove = false;
        }
      } else if (authorityMovedUnexpectedly) {
        setEmbodimentCameraSettled(false);
        bufferedEmbodimentMoveRef.current = null;
        drainBufferedMove = false;
      }
      const controlledEvent = [...result.embodiment.tickEvents]
        .reverse()
        .find((event) => event.actorId === result.embodiment.actorId);
      setEmbodimentFeedback(
        result.receipt.controlApplied
          ? controlledEvent?.summary ?? result.embodiment.tickEvents.at(-1)?.summary ?? '本刻行动已完成'
          : controlledEvent?.summary ?? result.embodiment.tickEvents.at(-1)?.summary ?? '本刻由身体或规则接管',
        result.receipt.controlApplied ? 'success' : 'blocked',
      );
      if (!predictedMove && !authorityMovedUnexpectedly) setEmbodimentCameraSettled(true);
    } catch (error) {
      setEmbodimentCommandPending(false);
      let correctionMatchesPrediction = false;
      let needsCameraCorrection = Boolean(predictedMove);
      if (error instanceof ElandRequestConflictError) {
        pendingEmbodimentCommandRef.current = null;
        if (error.embodiment) {
          drainBufferedMove = true;
          const embodied = { kind: 'embodied', view: error.embodiment } as const;
          experienceModeRef.current = embodied;
          setExperienceMode(embodied);
          setSociety(error.embodiment.society);
          const reconciledPosition = presentationPositionOf(error.embodiment);
          setEmbodimentPresentationPosition(reconciledPosition);
          if (predictedMove) {
            correctionMatchesPrediction = error.embodiment.actor.cellId === predictedMove.cellId
              && error.embodiment.actor.z === predictedMove.z;
            needsCameraCorrection = !correctionMatchesPrediction;
          } else {
            needsCameraCorrection = reconciledPosition.cellId !== authoritativePosition.cellId
              || reconciledPosition.z !== authoritativePosition.z;
          }
          if (needsCameraCorrection) {
            bufferedEmbodimentMoveRef.current = null;
            drainBufferedMove = false;
          }
        } else if (predictedMove) {
          setEmbodimentPresentationPosition(authoritativePosition);
          bufferedEmbodimentMoveRef.current = null;
        }
      } else {
        // An unknown network result may only be retried with the same command
        // id. Return the camera to the last confirmed actor position while the
        // world remains paused for reconciliation.
        if (predictedMove) setEmbodimentPresentationPosition(authoritativePosition);
        bufferedEmbodimentMoveRef.current = null;
      }
      if (needsCameraCorrection) setEmbodimentCameraSettled(false);
      else if (!predictedMove) setEmbodimentCameraSettled(true);
      setEmbodimentFeedback(
        queuedEmbodimentReleaseRef.current && pendingEmbodimentCommandRef.current
          ? '行动结果尚未确认；请再次输入原行动，确认后会自动交还身体'
          : error instanceof Error ? error.message : '化身行动失败',
        queuedEmbodimentReleaseRef.current ? 'blocked' : 'error',
      );
    } finally {
      embodimentMutationInFlightRef.current = false;
      const canReleaseNow = queuedEmbodimentReleaseRef.current
        && !pendingEmbodimentCommandRef.current
        && experienceModeRef.current.kind === 'embodied';
      if (canReleaseNow) {
        queuedEmbodimentReleaseRef.current = false;
        heldEmbodimentMoveRef.current = null;
        bufferedEmbodimentMoveRef.current = null;
        queueMicrotask(() => { void releaseEmbodimentRef.current?.(); });
      } else if (drainBufferedMove && !queuedEmbodimentReleaseRef.current) {
        const nextDirection = bufferedEmbodimentMoveRef.current ?? heldEmbodimentMoveRef.current;
        bufferedEmbodimentMoveRef.current = null;
        if (nextDirection) queueMicrotask(() => moveEmbodimentRef.current?.(nextDirection));
      }
    }
  }, [finishEmbodiment, setEmbodimentFeedback]);

  const moveEmbodiment = useCallback((direction: 'north' | 'south' | 'east' | 'west') => {
    const mode = experienceModeRef.current;
    if (mode.kind !== 'embodied'
      || (queuedEmbodimentReleaseRef.current && !pendingEmbodimentCommandRef.current)) return;
    if (embodimentMutationInFlightRef.current) {
      bufferedEmbodimentMoveRef.current = direction;
      setEmbodimentFeedback('已记住下一步方向；当前刻确认后继续', 'progress');
      return;
    }
    const width = mode.view.society.world.width;
    const delta = { north: -width, south: width, west: -1, east: 1 }[direction];
    const destination = mode.view.actor.cellId + delta;
    const option = mode.view.options.find((candidate) => candidate.category === 'move'
      && candidate.target?.kind === 'standing-position'
      && candidate.target.cellId === destination);
    if (!option) {
      setEmbodimentFeedback('这个方向没有可站立的相邻位置', 'blocked');
      return;
    }
    void chooseEmbodimentOption(option);
  }, [chooseEmbodimentOption, setEmbodimentFeedback]);
  moveEmbodimentRef.current = moveEmbodiment;

  const holdEmbodimentMove = useCallback((direction: 'north' | 'south' | 'east' | 'west' | null) => {
    const mode = experienceModeRef.current;
    heldEmbodimentMoveRef.current = (mode.kind === 'embodied' || mode.kind === 'entering-embodiment')
      && !queuedEmbodimentReleaseRef.current
      ? direction
      : null;
  }, []);

  const releaseEmbodiment = useCallback(async () => {
    const mode = experienceModeRef.current;
    if (mode.kind !== 'embodied') return;
    heldEmbodimentMoveRef.current = null;
    bufferedEmbodimentMoveRef.current = null;
    if (embodimentMutationInFlightRef.current) {
      queuedEmbodimentReleaseRef.current = true;
      if (document.pointerLockElement) document.exitPointerLock();
      setEmbodimentFeedback('已请求交还；当前刻确认后立即退出第一人称', 'progress');
      return;
    }
    if (pendingEmbodimentCommandRef.current) {
      setEmbodimentFeedback('上一行动结果尚未确认，请先再次选择原行动重试', 'blocked');
      return;
    }
    queuedEmbodimentReleaseRef.current = false;
    const request = pendingEmbodimentReleaseRef.current ?? {
      embodimentId: mode.view.id,
      releaseId: createEmbodimentReleaseId(),
      expectedRevision: mode.view.revision,
    };
    pendingEmbodimentReleaseRef.current = request;
    embodimentMutationInFlightRef.current = true;
    const releasing = { kind: 'releasing-embodiment', view: mode.view } as const;
    experienceModeRef.current = releasing;
    setExperienceMode(releasing);
    setEmbodimentPresentationPosition(null);
    setEmbodimentCameraSettled(true);
    setEmbodimentPointerLocked(false);
    setEmbodimentTarget(null);
    setPreviewEmbodimentOption(null);
    setEmbodimentCommandPending(true);
    setEmbodimentFeedback('视角已交还；世界正在后台完成本月剩余刻度', 'progress');
    try {
      const result = await elandClient.releaseEmbodiment({ runId: runIdRef.current, ...request });
      finishEmbodiment(result.committedFrame);
    } catch (error) {
      setEmbodimentCommandPending(false);
      const current = experienceModeRef.current;
      const view = error instanceof ElandRequestConflictError && error.embodiment
        ? error.embodiment
        : current.kind === 'releasing-embodiment' ? current.view : mode.view;
      if (error instanceof ElandRequestConflictError) pendingEmbodimentReleaseRef.current = null;
      const embodied = { kind: 'embodied', view } as const;
      experienceModeRef.current = embodied;
      setExperienceMode(embodied);
      setSociety(view.society);
      setView('society');
      setEmbodimentPresentationPosition(presentationPositionOf(view));
      setEmbodimentCameraSettled(true);
      setEmbodimentFeedback(error instanceof Error ? error.message : '交还自主失败');
    } finally {
      embodimentMutationInFlightRef.current = false;
    }
  }, [finishEmbodiment, setEmbodimentFeedback]);
  releaseEmbodimentRef.current = releaseEmbodiment;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    showRuntimeStatus('正在读取本地文明进度');
    const resume = () => {
      if (cancelled || resumeCheckCompleteRef.current) return;
      void elandClient.state(runIdRef.current).then(({
        frame,
        history: savedHistory,
        historyTotalCount: savedHistoryTotalCount,
        civilizationIndexHistory: savedIndexHistory,
        embodiment,
      }) => {
        if (cancelled || resumeCheckCompleteRef.current) return;
        resumeCheckCompleteRef.current = true;
        if (frame) restoreLoadedSession(
          frame,
          savedHistory,
          savedHistoryTotalCount ?? savedHistory.length,
          savedIndexHistory,
          embodiment,
        );
        else void startCivilization();
      }).catch((error) => {
        if (cancelled || resumeCheckCompleteRef.current) return;
        if (error instanceof ElandSessionMissingError) {
          resumeCheckCompleteRef.current = true;
          void startCivilization();
          return;
        }
        showRuntimeStatus('后端正在更新，会自动重连原文明');
        retryTimer = setTimeout(resume, 2_000);
      });
    };
    resume();
    return () => {
      cancelled = true;
      startedRef.current = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [restoreLoadedSession, showRuntimeStatus, startCivilization]);

  const presentPrefetchedMonth = useCallback((slot: MonthPlaybackSlot) => {
    if (monthPlaybackSlotRef.current !== slot || !slot.result) return;
    if (slot.presentationTimer) clearTimeout(slot.presentationTimer);
    slot.presentationTimer = null;
    const result = slot.result;
    const frame = result.frame;
    const verdict = inspectPrefetchedMonth(
      slot.ticket,
      sessionGenerationRef.current,
      latestFrameRef.current ? monthAuthorityHeadOf(latestFrameRef.current) : null,
      frame ? monthAuthorityHeadOf(frame) : null,
      result.skySampleAcknowledged,
    );
    monthPlaybackSlotRef.current = null;
    steppingRef.current = false;
    if (verdict !== 'accepted' || !frame) {
      nextMonthRequestAtRef.current = performance.now() + Math.min(2_000, slot.ticket.playbackDurationMs);
      return;
    }

    nextMonthRequestAtRef.current = 0;
    applyFrame(frame);
    if (result.authoritativeHistory && result.authoritativeHistoryTotalCount !== undefined) {
      replaceHistory(frame, result.authoritativeHistory, result.authoritativeHistoryTotalCount);
    }
    if (result.authoritativeCivilizationIndexHistory) {
      setCivilizationIndexHistory(result.authoritativeCivilizationIndexHistory.slice(-2_400));
    }
    setUniverseTarget((target) => Math.max(frame.skySample.toTime, target) + TU_PER_MONTH);
  }, [applyFrame, replaceHistory]);

  const stepOnce = useCallback(async () => {
    if (worldAdvancePausedRef.current || steppingRef.current || sessionStartingRef.current) return;
    if (performance.now() < nextMonthRequestAtRef.current) return;
    if (!sessionReadyRef.current) {
      const pendingCreation = pendingCreationRef.current;
      if (resumeCheckCompleteRef.current && (!hasFrameRef.current || pendingCreation)) {
        await startCivilization(pendingCreation?.worldSeed ?? activeWorldSeedRef.current ?? createWorldSeed());
      }
      return;
    }
    const baseFrame = latestFrameRef.current;
    const cosmos = statsRef.current?.cosmosSnapshot;
    if (!baseFrame || !cosmos) return;

    const generation = sessionGenerationRef.current;
    const skyAttempt = pendingStepSkyRef.current ?? skySamplerRef.current.prepare(eraKeyRef.current);
    pendingStepSkyRef.current = skyAttempt;
    const requestedAtMs = performance.now();
    const slot: MonthPlaybackSlot = {
      ticket: createMonthPlaybackTicket(
        generation,
        monthAuthorityHeadOf(baseFrame),
        visibleFrameStartedAtRef.current || performance.now(),
        monthPlaybackDurationMs,
      ),
      skyAttempt,
      requestedAtMs,
      result: null,
      presentationTimer: null,
    };
    monthPlaybackSlotRef.current = slot;
    steppingRef.current = true;
    try {
      const result = await elandClient.stepWithRecovery(
        runIdRef.current,
        skyAttempt.sample,
        cosmos,
      );
      if (modelEvolutionActive) {
        const observedRequestMs = performance.now() - slot.requestedAtMs;
        setModelPlaybackBudgetMs((current) => nextModelPlaybackBudgetMs(current, observedRequestMs));
      }
      if (monthPlaybackSlotRef.current !== slot) return;
      const frame = result.frame;
      const verdict = inspectPrefetchedMonth(
        slot.ticket,
        sessionGenerationRef.current,
        latestFrameRef.current ? monthAuthorityHeadOf(latestFrameRef.current) : null,
        frame ? monthAuthorityHeadOf(frame) : null,
        result.skySampleAcknowledged,
      );
      if (verdict !== 'accepted' || !frame) {
        skySamplerRef.current.rollback(skyAttempt);
        if (frame && verdict === 'unacknowledged-sky'
          && frame.authorityRevision === baseFrame.authorityRevision
          && frame.civilizationId === baseFrame.civilizationId
          && frame.branchId === baseFrame.branchId
          && frame.elapsedMonths === baseFrame.elapsedMonths) {
          skySamplerRef.current.restore(frame.skySample);
        }
        if (pendingStepSkyRef.current === skyAttempt) pendingStepSkyRef.current = null;
        monthPlaybackSlotRef.current = null;
        steppingRef.current = false;
        nextMonthRequestAtRef.current = performance.now() + Math.min(2_000, monthPlaybackDurationMs);
        return;
      }
      if (!skySamplerRef.current.commit(skyAttempt)) {
        if (pendingStepSkyRef.current === skyAttempt) pendingStepSkyRef.current = null;
        monthPlaybackSlotRef.current = null;
        steppingRef.current = false;
        nextMonthRequestAtRef.current = performance.now() + Math.min(2_000, monthPlaybackDurationMs);
        return;
      }
      if (pendingStepSkyRef.current === skyAttempt) pendingStepSkyRef.current = null;
      slot.result = result;
      const delayMs = prefetchedMonthDelayMs(slot.ticket, performance.now());
      if (delayMs <= 0) {
        presentPrefetchedMonth(slot);
      } else {
        slot.presentationTimer = setTimeout(() => presentPrefetchedMonth(slot), delayMs);
      }
    } catch (error) {
      if (monthPlaybackSlotRef.current !== slot) return;
      const resultUnknown = error instanceof ElandBackendUnavailableError
        || error instanceof ElandSessionMissingError;
      if (!resultUnknown) {
        skySamplerRef.current.rollback(skyAttempt);
        if (pendingStepSkyRef.current === skyAttempt) pendingStepSkyRef.current = null;
      }
      monthPlaybackSlotRef.current = null;
      steppingRef.current = false;
      nextMonthRequestAtRef.current = performance.now() + Math.min(2_000, monthPlaybackDurationMs);
      if (generation === sessionGenerationRef.current) {
        if (error instanceof ElandSessionMissingError) {
          showRuntimeStatus('正在等待原演化会话恢复；不会自动创建新文明');
          return;
        }
        if (error instanceof ElandBackendUnavailableError) {
          showRuntimeStatus('后端正在更新，当前画面会保留并自动重连');
          return;
        }
        pushHistory(monthRef.current, error instanceof Error ? error.message : '本地规则演化失败', 'bad');
      }
    }
  }, [modelEvolutionActive, monthPlaybackDurationMs, presentPrefetchedMonth, pushHistory, showRuntimeStatus, startCivilization]);

  useEffect(() => {
    if (!pageVisible || worldAdvancePaused) return;
    const firstStep = setTimeout(() => { void stepOnce(); }, 0);
    const interval = setInterval(() => { void stepOnce(); }, monthPlaybackDurationMs);
    return () => {
      clearTimeout(firstStep);
      clearInterval(interval);
    };
  }, [monthPlaybackDurationMs, pageVisible, society, stepOnce, worldAdvancePaused]);

  const onStats = useCallback((stats: SimStats) => {
    // “重新开始”会先重置 ThreeBodyCanvas，再创建新的权威会话。重置提交前，
    // 旧宇宙仍可能回传一帧；不能让那一帧按旧文明编号再启动一次 begin，
    // 否则 sessionGeneration 会前移，让已经成功的新世界请求被误判为失败。
    if (newWorldLaunchingRef.current) return;
    if (stats.resetToken !== expectedUniverseResetTokenRef.current) return;
    if (canvasCivilizationSyncRef.current) {
      if (stats.civilizations === activeCivilizationRef.current) {
        canvasCivilizationSyncRef.current = false;
      } else {
        return;
      }
    }
    statsRef.current = stats;
    skySamplerRef.current.observe({
      time: stats.t,
      flux: stats.fluxRel,
      nearestStarDistance: stats.planetDist,
      fate: eraKeyOf(stats.planetFate, stats.fluxRel),
    });

    const nextEra = eraKeyOf(stats.planetFate, stats.fluxRel);
    if (nextEra !== eraKeyRef.current) {
      eraKeyRef.current = nextEra;
      if (nextEra === 'burned' || nextEra === 'frozen' || nextEra === 'extinct') {
        presentedEraKeyRef.current = nextEra;
        setEraKey(nextEra);
        if (eraInitializedRef.current) flashEra(nextEra);
      }
    }

    if (stats.collapsed) {
      if (collapseHandledRef.current) return;
      if (sessionStartingRef.current) return;
      collapseHandledRef.current = true;
      // 宇宙冻结在真实灾变状态，先把末月天象交给后端结算；
      // 只有用户在终局页选择下一文明后才执行 respawn 握手。
      void stepOnce();
      return;
    }

    collapseHandledRef.current = false;
    if (stats.civilizations !== previousCivilizationRef.current) {
      previousCivilizationRef.current = stats.civilizations;
      replacementRequestedRef.current = false;
      void startCivilization(createWorldSeed(), true);
      return;
    }
    // The first usable cosmos snapshot may arrive after a frame was applied.
    // Start that frame's single prefetch immediately; steppingRef keeps this
    // render-loop callback from creating parallel requests.
    void stepOnce();
  }, [flashEra, startCivilization, stepOnce]);

  const diveToSociety = useCallback(() => {
    if (!society || transitionRef.current) return;
    transitionRef.current = true;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setAtmosphereTransition('dive');
  }, [society]);

  const riseToCosmos = useCallback(() => {
    if (transitionRef.current) return;
    transitionRef.current = true;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setAtmosphereTransition('rise');
  }, []);

  const switchSceneBehindAtmosphere = useCallback((direction: AtmosphereTransitionDirection) => {
    if (direction === 'dive') {
      setView('society');
    } else {
      setView('cosmos');
      setExitFocusToken((token) => token + 1);
    }
  }, []);

  const finishAtmosphereTransition = useCallback((direction: AtmosphereTransitionDirection) => {
    setAtmosphereTransition((current) => current === direction ? null : current);
    transitionRef.current = false;
  }, []);

  const closeOverlay = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setOverlayMode(null);
  }, []);

  const openMenu = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setOverlayMode('menu');
  }, []);

  const openNewWorld = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setNewWorldSeed(createWorldSeed());
    setNewWorldStatus('idle');
    setOverlayMode('new-world');
  }, []);

  const openHistory = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setOverlayMode('history');
  }, []);

  const openSaves = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setOverlayMode('saves');
    setSaveManagerStatus('loading');
    setSaveManagerMessage('');
    void elandClient.saves(runIdRef.current).then(({ saves: loadedSaves }) => {
      setSaves(loadedSaves);
      setSaveManagerStatus('idle');
    }).catch((error) => {
      setSaveManagerStatus('error');
      setSaveManagerMessage(error instanceof Error ? error.message : '文明档案读取失败');
    });
  }, []);

  const createSave = useCallback(async (label: string) => {
    if (saveManagerStatus === 'saving' || saveManagerStatus === 'loading-save') return;
    setSaveManagerStatus('saving');
    setSaveManagerMessage('');
    try {
      const { save } = await elandClient.save(runIdRef.current, label);
      setSaves((current) => [save, ...current.filter((item) => item.id !== save.id)]);
      setSaveManagerStatus('saved');
      setSaveManagerMessage(`已保存「${save.label}」`);
    } catch (error) {
      setSaveManagerStatus('error');
      setSaveManagerMessage(error instanceof Error ? error.message : '当前文明保存失败');
    }
  }, [saveManagerStatus]);

  const loadSave = useCallback(async (saveId: string) => {
    if (saveManagerStatus === 'saving' || saveManagerStatus === 'loading-save') return;
    const target = saves.find((save) => save.id === saveId);
    if (!window.confirm(`读取「${target?.label ?? '这份存档'}」？当前未保存的进度会被替换。`)) return;
    setSaveManagerStatus('loading-save');
    setSaveManagerMessage('');
    try {
      const loaded = await elandClient.loadSave(runIdRef.current, saveId);
      restoreLoadedSession(
        loaded.frame,
        loaded.history,
        loaded.historyTotalCount ?? loaded.history.length,
        loaded.civilizationIndexHistory,
      );
      setSaveManagerStatus('idle');
      setSaveManagerMessage('');
      setOverlayMode(null);
    } catch (error) {
      setSaveManagerStatus('error');
      setSaveManagerMessage(error instanceof Error ? error.message : '文明档案读取失败');
    }
  }, [restoreLoadedSession, saveManagerStatus, saves]);

  const openModelSettings = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setOverlayMode('model-settings');
    setModelSettingsStatus('loading');
    setModelSettingsMessage('');
    void modelSettingsClient.read().then((settings) => {
      setModelSettings(settings);
      setModelEvolutionModeDraft(settings.evolutionMode);
      setModelSummaryModeDraft(settings.summaryMode);
      setModelRouteDraft(settings.routes);
      setModelSettingsStatus('idle');
    }).catch((error) => {
      setModelSettings(null);
      setModelSettingsStatus('error');
      setModelSettingsMessage(error instanceof Error ? error.message : '模型设置读取失败');
    });
  }, []);

  const openShortcuts = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setOverlayMode('shortcuts');
  }, []);

  const openCivilizationEnding = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setCivilizationSettlementStatus('idle');
    setCivilizationSettlementMessage('');
    setOverlayMode('civilization-ending');
  }, []);

  const endCivilization = useCallback(async () => {
    if (civilizationSettlementStatus === 'settling') return;
    setCivilizationSettlementStatus('settling');
    setCivilizationSettlementMessage('正在冻结当前权威历史…');
    try {
      const frame = await elandClient.settleCivilization(runIdRef.current);
      applyFrame(frame);
      setCivilizationSettlementStatus('idle');
      setCivilizationSettlementMessage('');
      setOverlayMode(null);
    } catch (error) {
      setCivilizationSettlementStatus('error');
      setCivilizationSettlementMessage(error instanceof Error ? error.message : '文明结算失败，请重试');
    }
  }, [applyFrame, civilizationSettlementStatus]);

  const loadCivilizationRequiem = useCallback(() => {
    if (!civilizationEnding) return Promise.reject(new Error('当前没有已结算的文明'));
    return elandClient.civilizationRequiem(runIdRef.current, {
      civilizationId: civilizationEnding.civilizationId,
      branchId: civilizationEnding.branchId,
      endedAtMonth: civilizationEnding.elapsedMonths,
    }, { timeoutMs: 60_000 });
  }, [civilizationEnding]);

  const applyModelSettingsSnapshot = useCallback((settings: ModelSettingsSnapshot) => {
    setModelSettings(settings);
    setModelEvolutionModeDraft(settings.evolutionMode);
    setModelSummaryModeDraft(settings.summaryMode);
    setModelRouteDraft(settings.routes);
    setModelSettingsStatus('idle');
    setModelSettingsMessage('');
  }, []);

  const testModelEndpoint = useCallback((draft: ModelEndpointDraft): Promise<ModelEndpointTestResult> => (
    modelSettingsClient.testEndpoint(draft)
  ), []);

  const saveModelEndpoint = useCallback(async (token: string) => {
    const settings = await modelSettingsClient.saveEndpoint(token);
    applyModelSettingsSnapshot(settings);
    return settings;
  }, [applyModelSettingsSnapshot]);

  const deleteModelEndpoint = useCallback(async (id: string) => {
    const settings = await modelSettingsClient.deleteEndpoint(id);
    applyModelSettingsSnapshot(settings);
    return settings;
  }, [applyModelSettingsSnapshot]);

  const changeModelRoute = useCallback((purpose: ModelPurpose, endpointId: string) => {
    setModelRouteDraft((current) => ({ ...current, [purpose]: endpointId }));
    setModelSettingsStatus('idle');
    setModelSettingsMessage('');
  }, []);

  const changeEvolutionMode = useCallback((mode: EvolutionMode) => {
    setModelEvolutionModeDraft(mode);
    setModelSettingsStatus('idle');
    setModelSettingsMessage('');
  }, []);

  const changeEvolutionSpeed = useCallback((speed: EvolutionSpeed) => {
    const normalized = normalizeEvolutionSpeed(speed);
    setEvolutionSpeed(normalized);
    storeEvolutionSpeed(normalized);
  }, []);

  const changeSummaryMode = useCallback((mode: EvolutionMode) => {
    setModelSummaryModeDraft(mode);
    setModelSettingsStatus('idle');
    setModelSettingsMessage('');
  }, []);

  const saveModelSettings = useCallback(async () => {
    if (!modelSettings?.editable || modelSettingsStatus === 'saving') return;
    setModelSettingsStatus('saving');
    setModelSettingsMessage('');
    try {
      const settings = await modelSettingsClient.update(modelRouteDraft, modelEvolutionModeDraft, modelSummaryModeDraft);
      setModelSettings(settings);
      setModelEvolutionModeDraft(settings.evolutionMode);
      setModelSummaryModeDraft(settings.summaryMode);
      setModelRouteDraft(settings.routes);
      setModelSettingsStatus('saved');
      setModelSettingsMessage('已保存');
    } catch (error) {
      setModelSettingsStatus('error');
      setModelSettingsMessage(error instanceof Error ? error.message : '模型路由保存失败');
    }
  }, [modelEvolutionModeDraft, modelRouteDraft, modelSettings?.editable, modelSettingsStatus, modelSummaryModeDraft]);

  const refreshNewWorldSeed = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setNewWorldSeed(createWorldSeed());
    setNewWorldStatus('idle');
  }, []);

  const launchNewWorld = useCallback(async () => {
    if (newWorldLaunchingRef.current) return;
    newWorldLaunchingRef.current = true;
    setNewWorldStatus('starting');
    clearMonthPlaybackBuffer();
    sessionReadyRef.current = false;
    steppingRef.current = false;
    replacementRequestedRef.current = false;
    collapseHandledRef.current = false;
    previousCivilizationRef.current = activeCivilizationRef.current;
    eraKeyRef.current = 'stable';
    presentedEraKeyRef.current = 'stable';
    eraInitializedRef.current = false;
    activeBranchRef.current = '';
    activeWorldSeedRef.current = newWorldSeed;
    hasFrameRef.current = false;
    monthRef.current = 0;
    statsRef.current = null;
    resumeCheckCompleteRef.current = true;
    pendingStepSkyRef.current = null;
    skySamplerRef.current.reset();
    transitionRef.current = false;
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    announceTimerRef.current = null;
    setAnnounce(null);
    setAtmosphereTransition(null);
    setView('cosmos');
    setSociety(null);
    setCivilizationIndexHistory([]);
    setSpeaker(null);
    setSpeechLines([]);
    setEraKey('stable');
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setCivilizationEnding(null);
    setUniverseTarget(0);
    setRestoreSnapshot(null);
    requestUniverseReset();
    setExitFocusToken((token) => token + 1);

    const started = await startCivilization(newWorldSeed, true);
    newWorldLaunchingRef.current = false;
    if (started) {
      setNewWorldStatus('idle');
      setOverlayMode(null);
    } else {
      setNewWorldStatus('error');
    }
  }, [clearMonthPlaybackBuffer, newWorldSeed, requestUniverseReset, startCivilization]);

  const selectSocietyObject = useCallback((selection: SocietySceneSelection) => {
    setFocusAgentSubtab('overview');
    setFocusTarget(selection ? { kind: selection.kind, id: selection.id } : null);
  }, []);

  const closeFocus = useCallback(() => {
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setFocusAgentMemoryLoading(false);
  }, []);

  const changeFocusAgentSubtab = useCallback((subtab: AgentSubtab) => {
    if (focusTarget?.kind !== 'agent') return;
    setFocusAgentSubtab(subtab);
  }, [focusTarget]);

  const openFocusAgentConversation = useCallback(() => {
    if (focusTarget?.kind !== 'agent') return;
    setFocusAgentSubtab('conversation');
  }, [focusTarget]);

  const toggleFocusAgentHistory = useCallback(() => {
    if (focusTarget?.kind !== 'agent') return;
    setFocusAgentSubtab((current) => current === 'history' ? 'overview' : 'history');
  }, [focusTarget]);

  const toggleFocusAgentInventory = useCallback(() => {
    if (focusTarget?.kind !== 'agent') return;
    setFocusAgentSubtab((current) => current === 'inventory' ? 'overview' : 'inventory');
  }, [focusTarget]);

  useEffect(() => {
    if (focusAgentSubtab !== 'history' || focusTarget?.kind !== 'agent') return;
    let cancelled = false;
    const agentId = focusTarget.id;
    setFocusAgentMemory((current) => current?.agentId === agentId ? current : null);
    setFocusAgentMemoryLoading(true);
    setFocusAgentMemoryError('');
    void elandClient.agentMemory(runIdRef.current, agentId, monthRef.current, 32).then((result) => {
      if (cancelled) return;
      setFocusAgentMemory(result);
      setFocusAgentMemoryLoading(false);
    }).catch((error) => {
      if (cancelled) return;
      setFocusAgentMemoryLoading(false);
      setFocusAgentMemoryError(error instanceof Error ? error.message : '人物记忆读取失败');
    });
    return () => { cancelled = true; };
  }, [focusAgentSubtab, focusTarget, society]);

  const observeNextCivilization = useCallback(() => {
    const systemExtinct = statsRef.current?.collapsed === 'extinct';
    setCivilizationEnding(null);
    setOverlayMode(null);
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setAnnounce(null);
    transitionRef.current = false;
    setAtmosphereTransition(null);
    setView('cosmos');
    setExitFocusToken((token) => token + 1);
    if (systemExtinct) {
      const nextSeed = createWorldSeed();
      clearMonthPlaybackBuffer();
      previousCivilizationRef.current = activeCivilizationRef.current;
      collapseHandledRef.current = false;
      replacementRequestedRef.current = false;
      hasFrameRef.current = false;
      monthRef.current = 0;
      statsRef.current = null;
      pendingStepSkyRef.current = null;
      skySamplerRef.current.reset();
      setUniverseTarget(0);
      requestUniverseReset();
      setRestoreSnapshot(null);
      void startCivilization(nextSeed, true);
      return;
    }
    setRespawnToken((token) => token + 1);
  }, [clearMonthPlaybackBuffer, requestUniverseReset, startCivilization]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
      if (isEditing && event.key !== 'Escape') return;

      if (experienceModeRef.current.kind !== 'observing') {
        // PointerLockControls owns Escape. The embodiment HUD/scene own
        // Tab/E/F/WASD; observation menus must not react to those keys.
        if (event.key === 'Escape'
          || event.code === 'Tab'
          || event.code === 'KeyE'
          || event.code === 'KeyF'
          || event.code === 'KeyW'
          || event.code === 'KeyA'
          || event.code === 'KeyS'
          || event.code === 'KeyD') event.preventDefault();
        return;
      }

      if (civilizationEnding) {
        if (event.key === 'Escape' && overlayMode) {
          event.preventDefault();
          closeOverlay();
          return;
        }
        if (event.key.toLowerCase() === 'h') {
          event.preventDefault();
          if (overlayMode === 'history') closeOverlay();
          else openHistory();
          return;
        }
        event.preventDefault();
        return;
      }

      const commandKey = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (commandKey) {
        event.preventDefault();
        if (overlayMode === 'menu') closeOverlay();
        else openMenu();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (overlayMode && overlayMode !== 'menu' && overlayMode !== 'history') openMenu();
        else if (overlayMode) closeOverlay();
        else if (focusTarget) closeFocus();
        else openMenu();
        return;
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        openNewWorld();
        return;
      }
      if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        if (focusTarget?.kind === 'agent' && !overlayMode) toggleFocusAgentHistory();
        else if (overlayMode === 'history') closeOverlay();
        else openHistory();
        return;
      }
      if (event.key.toLowerCase() === 'b' && focusTarget?.kind === 'agent' && !overlayMode) {
        event.preventDefault();
        toggleFocusAgentInventory();
        return;
      }
      if (event.key.toLowerCase() === 'c' && focusTarget?.kind === 'agent' && !overlayMode) {
        event.preventDefault();
        openFocusAgentConversation();
        return;
      }
      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        if (overlayMode === 'model-settings') closeOverlay();
        else openModelSettings();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        if (overlayMode === 'shortcuts') closeOverlay();
        else openShortcuts();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    civilizationEnding,
    closeFocus,
    closeOverlay,
    focusTarget,
    openHistory,
    openFocusAgentConversation,
    openMenu,
    openModelSettings,
    openNewWorld,
    openShortcuts,
    overlayMode,
    toggleFocusAgentHistory,
    toggleFocusAgentInventory,
  ]);

  useEffect(() => {
    if (!focusTarget || !society) return;
    if (focusTarget.kind === 'agent' && !society.agents.some((agent) => agent.id === focusTarget.id)) closeFocus();
    if (focusTarget.kind === 'structure' && !society.structures.some((structure) => structure.id === focusTarget.id)) closeFocus();
  }, [closeFocus, focusTarget, society]);

  const visibleHistory = useMemo(() => {
    if (history.length) return history.slice(-5);
    const status: EvolutionEntry = society ? {
      id: 'runtime-active-status',
      civilizationId: activeCivilizationRef.current,
      branchId: activeBranchRef.current,
      month: 0,
      text: `本地演化进行中，当前 ${society.agents.length} 位先民`,
      tone: 'era',
      status: true,
    } : {
      id: 'runtime-starting-status',
      civilizationId: activeCivilizationRef.current,
      branchId: activeBranchRef.current,
      month: 0,
      text: '本地演化正在开始',
      tone: 'plain',
      status: true,
    };
    return [status];
  }, [history, society]);
  const activeEmbodimentView = experienceMode.kind === 'embodied' ? experienceMode.view : null;
  const activeEmbodimentAgentId = experienceMode.kind === 'entering-embodiment'
    ? experienceMode.agentId
    : activeEmbodimentView?.actorId ?? null;
  const embodimentCameraMode = useMemo<SocietyCameraMode>(() => {
    if (!activeEmbodimentAgentId) return { kind: 'overview' };
    const presentationPosition = embodimentPresentationPosition?.agentId === activeEmbodimentAgentId
      ? {
          cellId: embodimentPresentationPosition.cellId,
          z: embodimentPresentationPosition.z,
        }
      : undefined;
    return {
      kind: 'embodiment',
      agentId: activeEmbodimentAgentId,
      ...(presentationPosition ? { presentationPosition } : {}),
    };
  }, [activeEmbodimentAgentId, embodimentPresentationPosition]);
  const embodimentTargets = useMemo(() => activeEmbodimentView?.options.flatMap((option) => (
    option.target ? [option.target] : []
  )), [activeEmbodimentView]);
  const embodimentExperienceActive = experienceMode.kind !== 'observing';

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#02030a] text-slate-200">
      <AdaptiveMusic audible={pageVisible} ducked={Boolean(civilizationEnding)} era={eraKey} view={view} />
      <style>{`
        @keyframes era-flash {
          0% { opacity: 0; letter-spacing: 0.1em; transform: scale(0.96); filter: blur(6px); }
          18% { opacity: 1; filter: blur(0); }
          78% { opacity: 1; }
          100% { opacity: 0; letter-spacing: 0.9em; transform: scale(1.04); filter: blur(3px); }
        }
      `}</style>

      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{ opacity: view === 'cosmos' ? 1 : 0, pointerEvents: view === 'cosmos' ? 'auto' : 'none' }}
      >
        <ThreeBodyCanvas
          running={!worldAdvancePaused}
          speed={3}
          trailLength={2200}
          showTwin={false}
          presetKey="chaos"
          resetToken={universeResetToken}
          civilizationId={activeCivilizationRef.current > 0 ? activeCivilizationRef.current : undefined}
          restoreSnapshot={restoreSnapshot}
          targetT={universeTarget}
          skyMode={view === 'society' ? 'frozen' : 'follow'}
          collapseHold
          respawnToken={respawnToken}
          onStats={onStats}
          planetFocusEnabled={view === 'cosmos' && !embodimentExperienceActive}
          onPlanetDive={diveToSociety}
          exitFocusToken={exitFocusToken}
        />
      </div>

      {view === 'society' && society && (
        <SocietyScene3D
          society={society}
          era={eraKey}
          speaker={speaker}
          monthPlaybackDurationMs={monthPlaybackDurationMs}
          speechLines={speechLines}
          sky={statsRef.current ?? undefined}
          selectedObject={!embodimentExperienceActive
            && (focusTarget?.kind === 'agent' || focusTarget?.kind === 'structure')
            ? { kind: focusTarget.kind, id: focusTarget.id }
            : null}
          onSelectObject={embodimentExperienceActive ? undefined : selectSocietyObject}
          onZoomOutRequest={embodimentExperienceActive ? undefined : riseToCosmos}
          cameraMode={embodimentCameraMode}
          embodimentTargets={embodimentTargets}
          previewEmbodimentOption={previewEmbodimentOption}
          onEmbodimentMove={moveEmbodiment}
          onEmbodimentMoveHoldChange={holdEmbodimentMove}
          onEmbodimentTargetChange={setEmbodimentTarget}
          onEmbodimentPointerLockChange={setEmbodimentPointerLocked}
          onEmbodimentCameraSettled={() => setEmbodimentCameraSettled(true)}
        />
      )}

      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{ background: 'radial-gradient(ellipse at center, transparent 48%, rgba(2,3,10,0.72) 100%)' }}
      />

      {activeEmbodimentView && (
        <LimitedEmbodimentHud
          busy={embodimentCommandPending || !embodimentCameraSettled}
          feedback={embodimentFeedback}
          feedbackTone={embodimentFeedbackTone}
          onChooseOption={(option) => { void chooseEmbodimentOption(option); }}
          onPreviewOptionChange={setPreviewEmbodimentOption}
          onRelease={() => { void releaseEmbodiment(); }}
          pointerLocked={embodimentPointerLocked}
          target={embodimentTarget}
          view={activeEmbodimentView}
        />
      )}

      {experienceMode.kind === 'entering-embodiment' && (
        <div className="pointer-events-none absolute inset-x-0 top-5 z-[110] flex justify-center px-4">
          <div className="pointer-events-auto grid justify-items-center gap-1.5 rounded-xl border border-emerald-100/20 bg-slate-950/75 px-5 py-3 text-center shadow-2xl backdrop-blur-md">
            <p className="m-0 text-sm text-slate-100">{embodimentFeedback || '正在接管身体'}</p>
            <small className="text-[11px] text-slate-400">准备完成前可以转头观察，行动暂不可用</small>
            {!embodimentCommandPending && (
              <button
                className="mt-1 rounded-md border border-emerald-100/25 bg-emerald-950/60 px-3 py-1.5 text-xs text-emerald-50"
                onClick={() => { void enterEmbodiment(experienceMode.agentId); }}
                type="button"
              >
                重试同一次进入
              </button>
            )}
          </div>
        </div>
      )}

      {experienceMode.kind === 'releasing-embodiment' && (
        <div className="pointer-events-none absolute inset-x-0 top-5 z-[110] flex justify-center px-4">
          <div
            aria-live="polite"
            className="rounded-xl border border-slate-100/15 bg-slate-950/70 px-5 py-3 text-center text-sm text-slate-200 shadow-2xl backdrop-blur-md"
          >
            {embodimentFeedback || '视角已交还；世界正在后台收束本月'}
          </div>
        </div>
      )}

      {announce && !embodimentExperienceActive && (
        <div
          key={announce.key}
          className="pointer-events-none absolute inset-0 z-[80] flex flex-col items-center justify-center"
          style={{
            animation: 'era-flash 3.4s ease-out forwards',
            background: `radial-gradient(ellipse at center, ${ERA_TEXT[announce.era].glow}, transparent 65%)`,
          }}
        >
          <div
            className={`era-announcement__title text-[clamp(4rem,12vw,11rem)] leading-none ${ERA_TEXT[announce.era].cls} ${isChaoticAnnouncement(announce.era) ? 'era-announcement__title--chaotic' : ''}`}
            data-text={ERA_TEXT[announce.era].big}
            style={{ textShadow: '0 0 80px currentColor' }}
          >
            {ERA_TEXT[announce.era].big}
          </div>
          <div className={`era-announcement__subtitle mt-8 text-sm text-slate-300/80 ${isChaoticAnnouncement(announce.era) ? 'era-announcement__subtitle--chaotic' : ''}`}>
            {ERA_TEXT[announce.era].sub}
          </div>
        </div>
      )}

      {!embodimentExperienceActive && !overlayMode && !civilizationEnding && (
        <div className="ambient-history" aria-live="polite" aria-relevant="additions text">
          <div className="ambient-history__list">
            {visibleHistory.map((entry, index) => (
              <div
                className={`ambient-history__entry ambient-history__entry--${entry.tone}`}
                key={entry.id}
                style={{ opacity: 0.4 + ((index + 1) / visibleHistory.length) * 0.6 }}
                title={entry.detail}
              >
                {!entry.status && <span className="ambient-history__time">{monthLabel(entry.month)}</span>}
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {!embodimentExperienceActive && !overlayMode && !civilizationEnding && !focusTarget && (
        <button
          aria-label="打开观测菜单"
          className="immersive-touch-trigger"
          onClick={openMenu}
          type="button"
        >
          菜单
        </button>
      )}

      <FocusInspector
        target={!embodimentExperienceActive && !overlayMode && !civilizationEnding ? focusTarget : null}
        society={society}
        history={history}
        runId={runIdRef.current}
        observedBranchId={activeBranchRef.current}
        observedMonth={monthRef.current}
        agentMemory={focusAgentMemory}
        agentSubtab={focusAgentSubtab}
        agentMemoryLoading={focusAgentMemoryLoading}
        agentMemoryError={focusAgentMemoryError}
        onEnterEmbodiment={enterEmbodiment}
        onClose={closeFocus}
        onAgentSubtabChange={changeFocusAgentSubtab}
      />

      {atmosphereTransition && (
        <AtmosphereTransition
          direction={atmosphereTransition}
          onComplete={finishAtmosphereTransition}
          onOpaque={switchSceneBehindAtmosphere}
        />
      )}

      {!embodimentExperienceActive && <ImmersiveInterface
        mode={overlayMode}
        civilizationId={activeCivilizationRef.current}
        civilizationIndex={society?.observations.civilizationIndex ?? null}
        civilizationIndexHistory={civilizationIndexHistory}
        currentMonth={monthRef.current}
        history={history}
        historyTotalCount={historyTotalCount}
        modelEvolutionModeDraft={modelEvolutionModeDraft}
        modelRouteDraft={modelRouteDraft}
        modelSummaryModeDraft={modelSummaryModeDraft}
        evolutionSpeed={evolutionSpeed}
        modelSettings={modelSettings}
        modelSettingsMessage={modelSettingsMessage}
        modelSettingsStatus={modelSettingsStatus}
        newWorldSeed={newWorldSeed}
        newWorldStatus={newWorldStatus}
        saves={saves}
        saveStatus={saveManagerStatus}
        saveMessage={saveManagerMessage}
        civilizationSettlementStatus={civilizationSettlementStatus}
        civilizationSettlementMessage={civilizationSettlementMessage}
        onClose={closeOverlay}
        onCreateSave={(label) => { void createSave(label); }}
        onLoadSave={(saveId) => { void loadSave(saveId); }}
        onOpenMenu={openMenu}
        onOpenHistory={openHistory}
        onOpenModelSettings={openModelSettings}
        onOpenNewWorld={openNewWorld}
        onOpenSaves={openSaves}
        onOpenShortcuts={openShortcuts}
        onOpenCivilizationEnding={openCivilizationEnding}
        onEvolutionModeChange={changeEvolutionMode}
        onEvolutionSpeedChange={changeEvolutionSpeed}
        onModelRouteChange={changeModelRoute}
        onSummaryModeChange={changeSummaryMode}
        onRefreshSeed={refreshNewWorldSeed}
        onSaveModelSettings={() => { void saveModelSettings(); }}
        onDeleteModelEndpoint={deleteModelEndpoint}
        onSaveModelEndpoint={saveModelEndpoint}
        onStartNewWorld={() => { void launchNewWorld(); }}
        onEndCivilization={() => { void endCivilization(); }}
        onTestModelEndpoint={testModelEndpoint}
      />}

      {civilizationEnding && !overlayMode && (
        <CivilizationRequiem
          ending={civilizationEnding}
          loadRequiem={loadCivilizationRequiem}
          onContinue={observeNextCivilization}
          onOpenHistory={openHistory}
        />
      )}
    </main>
  );
}
