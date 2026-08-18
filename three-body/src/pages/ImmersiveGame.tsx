import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ThreeBodyCanvas, { type CelestialSelection, type SimStats } from '@/components/ThreeBodyCanvas';
import SocietyScene3D, { type SocietySceneSelection } from '@/components/SocietyScene3D';
import AdaptiveMusic from '@/components/AdaptiveMusic';
import ImmersiveInterface, {
  type ImmersiveOverlayMode,
  type ModelSettingsStatus,
  type NewWorldStatus,
} from '@/components/ImmersiveInterface';
import {
  CivilizationEnding,
  FocusInspector,
  type CivilizationEndingView,
  type FocusTarget,
} from '@/components/ObservationUI';
import {
  createWorldSeed,
  ElandBackendUnavailableError,
  ElandSessionMissingError,
  elandClient,
  getElandRunId,
  type Frame,
} from '@/game/elandClient';
import {
  modelSettingsClient,
  type EvolutionMode,
  type ModelPurpose,
  type ModelSettingsSnapshot,
} from '@/game/modelSettings';
import type { AgentHistoryView, EraKey, SocietyState, SkySample } from '@/game/societyContract';
import type { PlanetFate } from '@/lib/threebody';
import { useDocumentVisible } from '@/hooks/use-document-visible';

type ViewMode = 'cosmos' | 'society';

interface EvolutionEntry {
  id: string;
  month: number;
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  detail?: string;
  actorIds?: string[];
  sourceEventIds?: string[];
  status?: true;
}

const TU_PER_MONTH = 0.8 / 12;
const AUTO_STEP_MS = 4_000;
const EMPTY_MODEL_ROUTES: Record<ModelPurpose, string> = { decision: '', narrative: '', strategy: '' };

const ERA_TEXT: Record<EraKey, { big: string; sub: string; cls: string; glow: string }> = {
  stable: { big: '恒纪元', sub: '三日轨度可测 · 文明复苏', cls: 'text-amber-100', glow: 'rgba(251,191,36,0.25)' },
  chaotic: { big: '乱纪元', sub: '飞星失序 · 脱水！脱水！', cls: 'text-rose-200', glow: 'rgba(244,63,94,0.22)' },
  'chaotic-heat': { big: '酷暑纪元', sub: '烈日炙烤 · 焦土万里', cls: 'text-orange-200', glow: 'rgba(249,115,22,0.28)' },
  'chaotic-cold': { big: '严寒纪元', sub: '飞星远去 · 冰封千里', cls: 'text-sky-200', glow: 'rgba(56,189,248,0.25)' },
  burned: { big: '三日凌空', sub: '烈焰焚世', cls: 'text-orange-200', glow: 'rgba(249,115,22,0.3)' },
  frozen: { big: '长夜', sub: '飞星不动 · 万物冻结', cls: 'text-sky-200', glow: 'rgba(56,189,248,0.25)' },
  extinct: { big: '文明终结', sub: '星系崩解 · 世界不再重启', cls: 'text-purple-200', glow: 'rgba(168,85,247,0.3)' },
};

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

export default function ImmersiveGame() {
  const pageVisible = useDocumentVisible();
  const [society, setSociety] = useState<SocietyState | null>(null);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('cosmos');
  const [eraKey, setEraKey] = useState<EraKey>('stable');
  const [announce, setAnnounce] = useState<{ era: EraKey; key: number } | null>(null);
  const [history, setHistory] = useState<EvolutionEntry[]>([]);
  const [cover, setCover] = useState(false);
  const [universeTarget, setUniverseTarget] = useState(0);
  const [universeResetToken, setUniverseResetToken] = useState(0);
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
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [focusHistoryOpen, setFocusHistoryOpen] = useState(false);
  const [focusInventoryOpen, setFocusInventoryOpen] = useState(false);
  const [focusAgentHistory, setFocusAgentHistory] = useState<AgentHistoryView | null>(null);
  const [focusAgentHistoryLoading, setFocusAgentHistoryLoading] = useState(false);
  const [focusAgentHistoryError, setFocusAgentHistoryError] = useState('');
  const [civilizationEnding, setCivilizationEnding] = useState<CivilizationEndingView | null>(null);

  const runIdRef = useRef(getElandRunId());
  const startedRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const sessionStartingRef = useRef(false);
  const hasFrameRef = useRef(false);
  const steppingRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const historySequenceRef = useRef(0);
  const activeCivilizationRef = useRef(1);
  const activeWorldSeedRef = useRef<number | null>(null);
  const monthRef = useRef(0);
  const statsRef = useRef<SimStats | null>(null);
  const previousCivilizationRef = useRef(1);
  const eraKeyRef = useRef<EraKey>('stable');
  const eraInitializedRef = useRef(false);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSkyTimeRef = useRef(0);
  const fluxRangeRef = useRef({ min: 1, max: 1, sum: 0, count: 0 });
  const collapseHandledRef = useRef(false);
  const replacementRequestedRef = useRef(false);
  const transitionRef = useRef(false);
  const transitionTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const newWorldLaunchingRef = useRef(false);
  const uiPaused = overlayMode !== null || civilizationEnding !== null;

  useEffect(() => {
    const endSession = () => { void elandClient.end(runIdRef.current); };
    window.addEventListener('pagehide', endSession);
    return () => window.removeEventListener('pagehide', endSession);
  }, []);

  const after = useCallback((delay: number, action: () => void) => {
    transitionTimersRef.current.push(setTimeout(action, delay));
  }, []);

  useEffect(() => () => {
    for (const timer of transitionTimersRef.current) clearTimeout(timer);
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
    setHistory((current) => {
      const events = current.filter((entry) => !entry.status);
      return [...events.slice(-239), {
        id,
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
      month: monthRef.current,
      text,
      tone: 'plain',
      status: true,
    }]);
  }, []);

  const sampleSky = useCallback((): SkySample => {
    const current = statsRef.current;
    const range = fluxRangeRef.current;
    const flux = current?.fluxRel ?? 1;
    const toTime = current?.t ?? lastSkyTimeRef.current;
    const sample: SkySample = {
      fromTime: lastSkyTimeRef.current,
      toTime,
      fluxMean: range.count ? range.sum / range.count : flux,
      fluxMin: range.count ? range.min : flux,
      fluxMax: range.count ? range.max : flux,
      nearestStarDistance: current?.planetDist ?? 1,
      fate: current ? eraKeyOf(current.planetFate, current.fluxRel) : eraKeyRef.current,
    };
    lastSkyTimeRef.current = toTime;
    fluxRangeRef.current = { min: flux, max: flux, sum: 0, count: 0 };
    return sample;
  }, []);

  const applyFrame = useCallback((frame: Frame) => {
    hasFrameRef.current = true;
    activeCivilizationRef.current = frame.civilizationId;
    activeWorldSeedRef.current = frame.society.world.generator.seed;
    monthRef.current = frame.elapsedMonths;
    setSociety(frame.society);
    setSpeaker(frame.speaker);
    for (const entry of frame.entries) {
      pushHistory(entry.month, entry.text, entry.tone, entry.detail, {
        actorIds: entry.actorIds,
        sourceEventIds: entry.sourceEventIds,
      });
    }

    if (frame.civilizationEnd?.kind === 'destroyed' && !replacementRequestedRef.current) {
      replacementRequestedRef.current = true;
      sessionReadyRef.current = false;
      setFocusTarget(null);
      setFocusHistoryOpen(false);
      setFocusInventoryOpen(false);
      setCivilizationEnding({
        civilizationId: frame.civilizationId,
        elapsedMonths: frame.elapsedMonths,
        cause: frame.civilizationEnd.cause,
        summary: frame.civilizationEnd.summary,
      });
      pushHistory(
        frame.elapsedMonths,
        `第 ${frame.civilizationId} 号文明毁灭于${frame.civilizationEnd.cause}`,
        'bad',
        frame.civilizationEnd.summary,
      );
    }
  }, [pushHistory]);

  const startCivilization = useCallback(async (
    civilizationId: number,
    worldSeed = createWorldSeed(),
    resetHistory = false,
  ): Promise<boolean> => {
    const generation = ++sessionGenerationRef.current;
    sessionStartingRef.current = true;
    sessionReadyRef.current = false;
    activeCivilizationRef.current = civilizationId;
    activeWorldSeedRef.current = worldSeed;
    if (resetHistory) setHistory([]);
    showRuntimeStatus(monthRef.current > 0 ? '演化后端正在恢复连接' : '本地演化正在开始');
    const sky = sampleSky();
    try {
      const frame = await elandClient.begin(runIdRef.current, civilizationId, sky, undefined, worldSeed);
      if (generation !== sessionGenerationRef.current || frame.civilizationId !== civilizationId) return false;
      applyFrame(frame);
      replacementRequestedRef.current = false;
      sessionReadyRef.current = true;
      setUniverseTarget((target) => Math.max(sky.toTime, target) + TU_PER_MONTH);
      pushHistory(frame.elapsedMonths, `第 ${civilizationId} 号文明在自然地表上开始，${frame.society.agents.length} 位先民登场`, 'era');
      return true;
    } catch (error) {
      if (generation !== sessionGenerationRef.current) return false;
      showRuntimeStatus(error instanceof ElandBackendUnavailableError
        ? '后端正在更新，演化会自动重连'
        : error instanceof Error ? error.message : '本地演化会话启动失败');
      return false;
    } finally {
      if (generation === sessionGenerationRef.current) sessionStartingRef.current = false;
    }
  }, [applyFrame, pushHistory, sampleSky, showRuntimeStatus]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startCivilization(1);
  }, [startCivilization]);

  const stepOnce = useCallback(async () => {
    if (steppingRef.current || sessionStartingRef.current) return;
    if (!sessionReadyRef.current) {
      if (!hasFrameRef.current) {
        await startCivilization(activeCivilizationRef.current, activeWorldSeedRef.current ?? createWorldSeed());
      }
      return;
    }
    const generation = sessionGenerationRef.current;
    steppingRef.current = true;
    try {
      const sky = sampleSky();
      const frame = await elandClient.step(runIdRef.current, sky);
      if (generation === sessionGenerationRef.current
        && frame
        && frame.civilizationId === activeCivilizationRef.current
        && frame.elapsedMonths > monthRef.current) {
        applyFrame(frame);
        setUniverseTarget((target) => Math.max(sky.toTime, target) + TU_PER_MONTH);
      }
    } catch (error) {
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
  }, [applyFrame, pushHistory, sampleSky, showRuntimeStatus, startCivilization]);

  useEffect(() => {
    if (!pageVisible || uiPaused) return;
    const firstStep = setTimeout(() => { void stepOnce(); }, 1_000);
    const interval = setInterval(() => { void stepOnce(); }, AUTO_STEP_MS);
    return () => {
      clearTimeout(firstStep);
      clearInterval(interval);
    };
  }, [pageVisible, stepOnce, uiPaused]);

  const onStats = useCallback((stats: SimStats) => {
    statsRef.current = stats;
    const range = fluxRangeRef.current;
    range.min = range.count ? Math.min(range.min, stats.fluxRel) : stats.fluxRel;
    range.max = range.count ? Math.max(range.max, stats.fluxRel) : stats.fluxRel;
    range.sum += stats.fluxRel;
    range.count += 1;

    const nextEra = eraKeyOf(stats.planetFate, stats.fluxRel);
    if (nextEra !== eraKeyRef.current) {
      eraKeyRef.current = nextEra;
      setEraKey(nextEra);
      if (eraInitializedRef.current) flashEra(nextEra);
    }
    eraInitializedRef.current = true;

    if (stats.collapsed) {
      if (collapseHandledRef.current) return;
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
      void startCivilization(stats.civilizations);
    }
  }, [flashEra, startCivilization, stepOnce]);

  const diveToSociety = useCallback(() => {
    if (!society || transitionRef.current) return;
    transitionRef.current = true;
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setCover(true);
    after(320, () => {
      setView('society');
      after(160, () => {
        setCover(false);
        transitionRef.current = false;
      });
    });
  }, [after, society]);

  const riseToCosmos = useCallback(() => {
    if (transitionRef.current) return;
    transitionRef.current = true;
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setCover(true);
    after(320, () => {
      setView('cosmos');
      setExitFocusToken((token) => token + 1);
      after(160, () => {
        setCover(false);
        transitionRef.current = false;
      });
    });
  }, [after]);

  const closeOverlay = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setOverlayMode(null);
  }, []);

  const openMenu = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setOverlayMode('menu');
  }, []);

  const openNewWorld = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setNewWorldSeed(createWorldSeed());
    setNewWorldStatus('idle');
    setOverlayMode('new-world');
  }, []);

  const openHistory = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setOverlayMode('history');
  }, []);

  const openModelSettings = useCallback(() => {
    if (newWorldLaunchingRef.current) return;
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
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
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setOverlayMode('shortcuts');
  }, []);

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
      setModelSettingsMessage(`已保存：${settings.evolutionMode === 'model' ? '模型演进' : '本地演进'}，${settings.summaryMode === 'model' ? '模型总结' : '本地总结'}；从下一个月起生效。`);
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
    previousCivilizationRef.current = 1;
    eraKeyRef.current = 'stable';
    eraInitializedRef.current = false;
    activeCivilizationRef.current = 1;
    activeWorldSeedRef.current = newWorldSeed;
    hasFrameRef.current = false;
    monthRef.current = 0;
    statsRef.current = null;
    lastSkyTimeRef.current = 0;
    fluxRangeRef.current = { min: 1, max: 1, sum: 0, count: 0 };
    transitionRef.current = false;
    for (const timer of transitionTimersRef.current) clearTimeout(timer);
    transitionTimersRef.current = [];
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    announceTimerRef.current = null;
    setAnnounce(null);
    setCover(false);
    setView('cosmos');
    setSociety(null);
    setSpeaker(null);
    setEraKey('stable');
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setCivilizationEnding(null);
    setUniverseTarget(0);
    setUniverseResetToken((token) => token + 1);
    setExitFocusToken((token) => token + 1);

    const started = await startCivilization(1, newWorldSeed, true);
    newWorldLaunchingRef.current = false;
    if (started) {
      setNewWorldStatus('idle');
      setOverlayMode(null);
    } else {
      setNewWorldStatus('error');
    }
  }, [newWorldSeed, startCivilization]);

  const selectSocietyObject = useCallback((selection: SocietySceneSelection) => {
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setFocusTarget(selection ? { kind: selection.kind, id: selection.id } : null);
  }, []);

  const selectCelestial = useCallback((selection: CelestialSelection) => {
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
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
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setFocusAgentHistoryLoading(false);
  }, []);

  const toggleFocusAgentHistory = useCallback(() => {
    if (focusTarget?.kind !== 'agent') return;
    setFocusInventoryOpen(false);
    setFocusHistoryOpen((current) => !current);
  }, [focusTarget]);

  const toggleFocusAgentInventory = useCallback(() => {
    if (focusTarget?.kind !== 'agent') return;
    setFocusHistoryOpen(false);
    setFocusInventoryOpen((current) => !current);
  }, [focusTarget]);

  useEffect(() => {
    if (!focusHistoryOpen || focusTarget?.kind !== 'agent') return;
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
  }, [focusHistoryOpen, focusTarget, society]);

  const observeNextCivilization = useCallback(() => {
    const systemExtinct = statsRef.current?.collapsed === 'extinct';
    setCivilizationEnding(null);
    setOverlayMode(null);
    setFocusTarget(null);
    setFocusHistoryOpen(false);
    setFocusInventoryOpen(false);
    setAnnounce(null);
    setView('cosmos');
    setExitFocusToken((token) => token + 1);
    if (systemExtinct) {
      const nextSeed = createWorldSeed();
      previousCivilizationRef.current = 1;
      collapseHandledRef.current = false;
      replacementRequestedRef.current = false;
      hasFrameRef.current = false;
      monthRef.current = 0;
      statsRef.current = null;
      lastSkyTimeRef.current = 0;
      fluxRangeRef.current = { min: 1, max: 1, sum: 0, count: 0 };
      setUniverseTarget(0);
      setUniverseResetToken((token) => token + 1);
      void startCivilization(1, nextSeed);
      return;
    }
    setRespawnToken((token) => token + 1);
  }, [startCivilization]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
        if (overlayMode) closeOverlay();
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
      month: 0,
      text: `本地演化进行中，当前 ${society.agents.length} 位先民`,
      tone: 'era',
      status: true,
    } : {
      id: 'runtime-starting-status',
      month: 0,
      text: '本地演化正在开始',
      tone: 'plain',
      status: true,
    };
    return [status];
  }, [history, society]);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#02030a] text-slate-200">
      <AdaptiveMusic audible={pageVisible} era={eraKey} view={view} />
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
            className={`text-[clamp(4rem,12vw,11rem)] font-extralight leading-none tracking-[0.35em] ${ERA_TEXT[announce.era].cls}`}
            style={{ textShadow: '0 0 80px currentColor' }}
          >
            {ERA_TEXT[announce.era].big}
          </div>
          <div className="mt-8 text-sm tracking-[0.6em] text-slate-300/80">
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
        agentHistory={focusAgentHistory}
        agentHistoryOpen={focusHistoryOpen}
        agentInventoryOpen={focusInventoryOpen}
        agentHistoryLoading={focusAgentHistoryLoading}
        agentHistoryError={focusAgentHistoryError}
        onClose={closeFocus}
        onToggleAgentHistory={toggleFocusAgentHistory}
        onToggleAgentInventory={toggleFocusAgentInventory}
      />

      <div
        className="pointer-events-none absolute inset-0 z-[60] bg-[#02030a] transition-opacity duration-300"
        style={{ opacity: cover ? 1 : 0 }}
      />

      <ImmersiveInterface
        mode={overlayMode}
        civilizationId={activeCivilizationRef.current}
        civilizationIndex={society?.observations.civilizationIndex ?? null}
        currentMonth={monthRef.current}
        history={history}
        modelEvolutionModeDraft={modelEvolutionModeDraft}
        modelRouteDraft={modelRouteDraft}
        modelSummaryModeDraft={modelSummaryModeDraft}
        modelSettings={modelSettings}
        modelSettingsMessage={modelSettingsMessage}
        modelSettingsStatus={modelSettingsStatus}
        newWorldSeed={newWorldSeed}
        newWorldStatus={newWorldStatus}
        onClose={closeOverlay}
        onOpenHistory={openHistory}
        onOpenModelSettings={openModelSettings}
        onOpenNewWorld={openNewWorld}
        onOpenShortcuts={openShortcuts}
        onEvolutionModeChange={changeEvolutionMode}
        onModelRouteChange={changeModelRoute}
        onSummaryModeChange={changeSummaryMode}
        onRefreshSeed={refreshNewWorldSeed}
        onSaveModelSettings={() => { void saveModelSettings(); }}
        onStartNewWorld={() => { void launchNewWorld(); }}
      />

      {civilizationEnding && !overlayMode && (
        <CivilizationEnding
          ending={civilizationEnding}
          onContinue={observeNextCivilization}
          onOpenHistory={openHistory}
        />
      )}
    </main>
  );
}
