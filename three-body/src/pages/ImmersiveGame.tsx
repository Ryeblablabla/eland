import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ThreeBodyCanvas, { type CelestialSelection, type SimStats } from '@/components/ThreeBodyCanvas';
import SocietyScene3D, { type SocietySceneSelection } from '@/components/SocietyScene3D';
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
  createWorldSeed,
  ElandBackendUnavailableError,
  ElandSessionMissingError,
  elandClient,
  getElandRunId,
  type Frame,
} from '@/game/elandClient';
import {
  TransactionalSkySampler,
  type PreparedSkySample,
} from '@/game/eland/transactional-sky-sampler';
import {
  modelSettingsClient,
  type EvolutionMode,
  type ModelEndpointDraft,
  type ModelEndpointTestResult,
  type ModelPurpose,
  type ModelSettingsSnapshot,
} from '@/game/modelSettings';
import type {
  AgentHistoryView,
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

const TU_PER_MONTH = 0.8 / 12;
const AUTO_STEP_BASE_MS = 4_000;
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
  const [focusAgentHistory, setFocusAgentHistory] = useState<AgentHistoryView | null>(null);
  const [focusAgentHistoryLoading, setFocusAgentHistoryLoading] = useState(false);
  const [focusAgentHistoryError, setFocusAgentHistoryError] = useState('');
  const [civilizationEnding, setCivilizationEnding] = useState<CivilizationEndingView | null>(null);
  const [civilizationSettlementStatus, setCivilizationSettlementStatus] = useState<CivilizationSettlementStatus>('idle');
  const [civilizationSettlementMessage, setCivilizationSettlementMessage] = useState('');
  const [evolutionSpeed, setEvolutionSpeed] = useState<EvolutionSpeed>(readEvolutionSpeed);

  const runIdRef = useRef(getElandRunId());
  const startedRef = useRef(false);
  const resumeCheckCompleteRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const sessionStartingRef = useRef(false);
  const hasFrameRef = useRef(false);
  const steppingRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const historySequenceRef = useRef(0);
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
  const eraInitializedRef = useRef(false);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skySamplerRef = useRef(new TransactionalSkySampler());
  const pendingStepSkyRef = useRef<PreparedSkySample | null>(null);
  const collapseHandledRef = useRef(false);
  const replacementRequestedRef = useRef(false);
  const transitionRef = useRef(false);
  const newWorldLaunchingRef = useRef(false);
  const uiPaused = overlayMode !== null || civilizationEnding !== null || atmosphereTransition !== null;

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
    metadata?: Pick<EvolutionEntry, 'actorIds' | 'sourceEventIds'>,
  ) => {
    const id = `${runIdRef.current}:history:${historySequenceRef.current}`;
    historySequenceRef.current += 1;
    setHistoryTotalCount((count) => count + 1);
    setHistory((current) => {
      const events = current.filter((entry) => !entry.status);
      return [...events.slice(-239), {
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
    });
  }, []);

  const showRuntimeStatus = useCallback((text: string) => {
    setHistory((current) => [...current.filter((entry) => !entry.status).slice(-239), {
      id: `${runIdRef.current}:runtime-status`,
      civilizationId: activeCivilizationRef.current,
      branchId: activeBranchRef.current,
      month: monthRef.current,
      text,
      tone: 'plain',
      status: true,
    }]);
  }, []);

  const replaceHistory = useCallback((frame: Frame, entries: NarrativeEntryView[], totalCount: number) => {
    const normalizedTotalCount = Number.isFinite(totalCount)
      ? Math.max(entries.length, Math.floor(totalCount))
      : entries.length;
    historySequenceRef.current = normalizedTotalCount;
    setHistoryTotalCount(normalizedTotalCount);
    setHistory(entries.slice(-240).map((entry) => ({
      id: entry.id,
      civilizationId: frame.civilizationId,
      branchId: frame.branchId,
      month: entry.month,
      text: entry.text,
      tone: entry.tone,
      detail: entry.detail,
      actorIds: entry.actorIds,
      sourceEventIds: entry.sourceEventIds,
    })));
  }, []);

  const applyFrame = useCallback((frame: Frame) => {
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
  }, [pushHistory]);

  const startCivilization = useCallback(async (
    worldSeed = createWorldSeed(),
    resetHistory = false,
  ): Promise<boolean> => {
    const pendingCreation = pendingCreationRef.current?.worldSeed === worldSeed
      ? pendingCreationRef.current
      : { id: createCivilizationCreationId(), worldSeed };
    pendingCreationRef.current = pendingCreation;
    const generation = ++sessionGenerationRef.current;
    sessionStartingRef.current = true;
    sessionReadyRef.current = false;
    activeWorldSeedRef.current = worldSeed;
    if (resetHistory) {
      historySequenceRef.current = 0;
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
  }, [applyFrame, showRuntimeStatus]);

  const restoreLoadedSession = useCallback((
    frame: Frame,
    entries: NarrativeEntryView[],
    historyTotalCount: number,
    indexHistory: CivilizationIndexHistoryPoint[],
  ) => {
    pendingCreationRef.current = null;
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
    eraInitializedRef.current = true;
    setEraKey(frame.skySample.fate);
    applyFrame(frame);
    replaceHistory(frame, entries, historyTotalCount);
    setCivilizationIndexHistory(indexHistory.slice(-2_400));
  }, [applyFrame, replaceHistory, requestUniverseReset]);

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
      }) => {
        if (cancelled || resumeCheckCompleteRef.current) return;
        resumeCheckCompleteRef.current = true;
        if (frame) restoreLoadedSession(
          frame,
          savedHistory,
          savedHistoryTotalCount ?? savedHistory.length,
          savedIndexHistory,
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

  const stepOnce = useCallback(async () => {
    if (steppingRef.current || sessionStartingRef.current) return;
    if (!sessionReadyRef.current) {
      const pendingCreation = pendingCreationRef.current;
      if (resumeCheckCompleteRef.current && (!hasFrameRef.current || pendingCreation)) {
        await startCivilization(pendingCreation?.worldSeed ?? activeWorldSeedRef.current ?? createWorldSeed());
      }
      return;
    }
    const generation = sessionGenerationRef.current;
    steppingRef.current = true;
    let skyAttempt: PreparedSkySample | null = null;
    try {
      const cosmos = statsRef.current?.cosmosSnapshot;
      if (!cosmos) return;
      skyAttempt = pendingStepSkyRef.current ?? skySamplerRef.current.prepare(eraKeyRef.current);
      pendingStepSkyRef.current = skyAttempt;
      const sky = skyAttempt.sample;
      const {
        frame,
        authoritativeHistory,
        authoritativeHistoryTotalCount,
        authoritativeCivilizationIndexHistory,
        skySampleAcknowledged,
      } = await elandClient.stepWithRecovery(runIdRef.current, sky, cosmos);
      if (generation !== sessionGenerationRef.current) {
        skySamplerRef.current.rollback(skyAttempt);
        if (pendingStepSkyRef.current === skyAttempt) pendingStepSkyRef.current = null;
        return;
      }
      if (skySampleAcknowledged) {
        skySamplerRef.current.commit(skyAttempt);
      } else {
        skySamplerRef.current.rollback(skyAttempt);
        if (frame) skySamplerRef.current.restore(frame.skySample);
      }
      if (pendingStepSkyRef.current === skyAttempt) pendingStepSkyRef.current = null;
      if (frame && frame.civilizationId === activeCivilizationRef.current) {
        const advanced = frame.elapsedMonths > monthRef.current;
        if (advanced || authoritativeHistory) applyFrame(frame);
        if (authoritativeHistory && authoritativeHistoryTotalCount !== undefined) {
          replaceHistory(frame, authoritativeHistory, authoritativeHistoryTotalCount);
        }
        if (authoritativeCivilizationIndexHistory) {
          setCivilizationIndexHistory(authoritativeCivilizationIndexHistory.slice(-2_400));
        }
        if (advanced) setUniverseTarget((target) => Math.max(frame.skySample.toTime, target) + TU_PER_MONTH);
      }
    } catch (error) {
      const resultUnknown = error instanceof ElandBackendUnavailableError
        || error instanceof ElandSessionMissingError;
      if (skyAttempt && !resultUnknown) {
        skySamplerRef.current.rollback(skyAttempt);
        if (pendingStepSkyRef.current === skyAttempt) pendingStepSkyRef.current = null;
      }
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
    } finally {
      steppingRef.current = false;
    }
  }, [applyFrame, pushHistory, replaceHistory, showRuntimeStatus, startCivilization]);

  useEffect(() => {
    if (!pageVisible || uiPaused) return;
    const firstStep = setTimeout(() => { void stepOnce(); }, 1_000);
    const interval = setInterval(() => { void stepOnce(); }, AUTO_STEP_BASE_MS / evolutionSpeed);
    return () => {
      clearTimeout(firstStep);
      clearInterval(interval);
    };
  }, [evolutionSpeed, pageVisible, stepOnce, uiPaused]);

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
      setEraKey(nextEra);
      if (eraInitializedRef.current) flashEra(nextEra);
    }
    eraInitializedRef.current = true;

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
    }
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
    sessionReadyRef.current = false;
    steppingRef.current = false;
    replacementRequestedRef.current = false;
    collapseHandledRef.current = false;
    previousCivilizationRef.current = activeCivilizationRef.current;
    eraKeyRef.current = 'stable';
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
  }, [newWorldSeed, requestUniverseReset, startCivilization]);

  const selectSocietyObject = useCallback((selection: SocietySceneSelection) => {
    setFocusAgentSubtab('overview');
    setFocusTarget(selection ? { kind: selection.kind, id: selection.id } : null);
  }, []);

  const selectCelestial = useCallback((selection: CelestialSelection) => {
    setFocusAgentSubtab('overview');
    if (!selection) {
      setFocusTarget(null);
    } else if (selection.kind === 'planet') {
      setFocusTarget({ kind: 'celestial', body: 'planet' });
    } else {
      setFocusTarget({ kind: 'celestial', body: 'star', index: selection.index });
    }
  }, []);

  const closeFocus = useCallback(() => {
    setFocusTarget(null);
    setFocusAgentSubtab('overview');
    setFocusAgentHistoryLoading(false);
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
    setFocusAgentHistory((current) => current?.agentId === agentId ? current : null);
    setFocusAgentHistoryLoading(true);
    setFocusAgentHistoryError('');
    void elandClient.agentHistory(runIdRef.current, agentId, monthRef.current, 160).then((result) => {
      if (cancelled) return;
      setFocusAgentHistory(result);
      setFocusAgentHistoryLoading(false);
    }).catch((error) => {
      if (cancelled) return;
      setFocusAgentHistoryLoading(false);
      setFocusAgentHistoryError(error instanceof Error ? error.message : '个人行动历史读取失败');
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
  }, [requestUniverseReset, startCivilization]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
      if (isEditing && event.key !== 'Escape') return;

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
          running={!uiPaused}
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
          planetFocusEnabled={view === 'cosmos'}
          onPlanetDive={diveToSociety}
          exitFocusToken={exitFocusToken}
          selectedCelestial={focusTarget?.kind === 'celestial'
            ? focusTarget.body === 'planet'
              ? { kind: 'planet' }
              : { kind: 'star', index: focusTarget.index }
            : null}
          onSelectCelestial={selectCelestial}
        />
      </div>

      {view === 'society' && society && (
        <SocietyScene3D
          society={society}
          era={eraKey}
          speaker={speaker}
          speechLines={speechLines}
          sky={statsRef.current ?? undefined}
          selectedObject={focusTarget?.kind === 'agent' || focusTarget?.kind === 'structure'
            ? { kind: focusTarget.kind, id: focusTarget.id }
            : null}
          onSelectObject={selectSocietyObject}
          onZoomOutRequest={riseToCosmos}
        />
      )}

      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{ background: 'radial-gradient(ellipse at center, transparent 48%, rgba(2,3,10,0.72) 100%)' }}
      />

      {announce && (
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

      {!overlayMode && !civilizationEnding && (
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

      {!overlayMode && !civilizationEnding && !focusTarget && (
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
        target={!overlayMode && !civilizationEnding ? focusTarget : null}
        society={society}
        stats={statsRef.current}
        history={history}
        runId={runIdRef.current}
        observedBranchId={activeBranchRef.current}
        observedMonth={monthRef.current}
        agentHistory={focusAgentHistory}
        agentSubtab={focusAgentSubtab}
        agentHistoryLoading={focusAgentHistoryLoading}
        agentHistoryError={focusAgentHistoryError}
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

      <ImmersiveInterface
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
      />

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
