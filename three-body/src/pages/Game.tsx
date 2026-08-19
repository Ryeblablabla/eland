import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ThreeBodyCanvas, { type SimStats } from '@/components/ThreeBodyCanvas';
import SocietyMap from '@/components/SocietyMap';
import SocietyScene3D from '@/components/SocietyScene3D';
import SkyPiP from '@/components/SkyPiP';
import CharacterArchive from '@/components/CharacterArchive';
import {
  createCivilizationCreationId,
  createWorldSeed,
  ElandSessionMissingError,
  elandClient,
  getElandRunId,
  type Frame,
} from '@/game/elandClient';
import type { AgentHistoryItem, EraKey, SocietyState } from '@/game/societyContract';
import type { SkySample } from '@/game/societyContract';
import { CHARACTERS } from '@/data/characters';
import type { PlanetFate } from '@/lib/threebody';
import { useDocumentVisible } from '@/hooks/use-document-visible';

// ---------------------------------------------------------------------------
// 纪元文案（乱纪元按真实恒星通量细分酷暑/严寒）
// ---------------------------------------------------------------------------

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

const NUMERALS = ['零','一','二','三','四','五','六','七','八','九'];
function toChineseNum(n: number): string {
  if (n < 10) return NUMERALS[n];
  if (n < 20) return '十' + (n % 10 ? NUMERALS[n % 10] : '');
  if (n < 100) return NUMERALS[Math.floor(n / 10)] + '十' + (n % 10 ? NUMERALS[n % 10] : '');
  return String(n);
}

function monthLabel(elapsedMonths: number): string {
  if (elapsedMonths <= 0) return '第 1 年 · 1 月 · 月初';
  return `第 ${Math.floor((elapsedMonths - 1) / 12) + 1} 年 · ${(elapsedMonths - 1) % 12 + 1} 月`;
}

interface ChronicleEntry {
  id: number;
  civ: number;
  month: number;
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
}

let entrySeq = 0;

type ViewMode = 'cosmos' | 'society';

const TU_PER_MONTH = 0.8 / 12;
const SETTLEMENT_MIN_MS = 6500;

// ---------------------------------------------------------------------------
// 文明结算幕
// ---------------------------------------------------------------------------

interface Settlement {
  fate: 'burned' | 'frozen' | 'extinct' | 'depopulated';
  civ: number;
  months: number;
  eras: number;
}

const COLLAPSE_TEXT = {
  burned: '三日凌空 · 焚于烈焰',
  frozen: '长夜冻结 · 文明入殓',
  extinct: '星系崩解 · 文明终结',
  depopulated: '全员死亡 · 文明断绝',
} as const;

function SettlementOverlay({ s, entries, onContinue }: { s: Settlement; entries: ChronicleEntry[]; onContinue: () => void }) {
  const [shown, setShown] = useState(0);
  const [minimumTimePassed, setMinimumTimePassed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      setShown((n) => {
        if (n >= entries.length) { clearInterval(t); return n; }
        return n + 1;
      });
    }, 620);
    const unlock = setTimeout(() => setMinimumTimePassed(true), SETTLEMENT_MIN_MS);
    return () => {
      clearInterval(t);
      clearTimeout(unlock);
    };
  }, [entries.length]);
  const done = shown >= entries.length;
  const canContinue = done && minimumTimePassed;
  const continueWhenReady = () => {
    if (canContinue) onContinue();
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#030409]/95 px-8">
      <div className="text-[11px] tracking-[0.6em] text-slate-600">SETTLEMENT · 文明结算</div>
      <div className="mt-6 text-6xl font-extralight tracking-[0.25em] text-slate-100">
        第{toChineseNum(s.civ)}号文明
      </div>
      <div className="mt-4 text-sm tracking-[0.5em] text-rose-300/80">{COLLAPSE_TEXT[s.fate]}</div>

      <div className="mt-8 flex items-center gap-8 text-[11px] tracking-[0.3em] text-slate-500">
        <span>历时 <span className="text-slate-300">{s.months}</span> 月</span>
        <span className="text-slate-700">|</span>
        <span>改元 <span className="text-slate-300">{s.eras}</span> 次</span>
      </div>

      <div className="mt-3 h-px w-72 bg-gradient-to-r from-transparent via-slate-500/40 to-transparent" />

      <div className="mt-6 flex h-[30vh] w-[560px] flex-col justify-end space-y-2 overflow-hidden">
        {entries.slice(0, shown).map((e) => (
          <div key={e.id} className="text-[12px] leading-relaxed tracking-wider"
               style={{
                 animation: 'rise-in 0.7s ease-out',
                 color: e.tone === 'good' ? '#a7f3d0' : e.tone === 'bad' ? '#fda4af' : e.tone === 'era' ? '#fde68a' : '#7d8aa0',
               }}>
            <span className="mr-3 text-[10px] text-slate-600">{e.month === 0 ? '月初' : `第${e.month}月`}</span>
            {e.text}
          </div>
        ))}
        {entries.length === 0 && <div className="text-center text-xs text-slate-700">这个文明短到来不及留下记载</div>}
      </div>

      <button
        onClick={continueWhenReady}
        disabled={!canContinue}
        aria-disabled={!canContinue}
        className={`mt-10 border px-10 py-3 text-sm tracking-[0.6em] transition-all duration-1000 ${
          canContinue
            ? 'border-amber-200/60 text-amber-200 hover:bg-amber-200/10'
            : 'cursor-not-allowed border-slate-700 text-slate-600'
        }`}
        style={canContinue ? { animation: 'pulse 2s ease-in-out infinite' } : undefined}
      >
        {canContinue ? (s.fate === 'extinct' ? '重 启 宇 宙' : '新 文 明 启 程') : '结 算 中 …'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

export default function Game() {
  const pageVisible = useDocumentVisible();
  // ?autoenter=1：跳过开场黑场直接入局（无头浏览器截图调试 / 自动化用）
  const [entered, setEntered] = useState(() => new URLSearchParams(window.location.search).has('autoenter'));
  const [stats, setStats] = useState<SimStats | null>(null);
  const [announce, setAnnounce] = useState<{ era: EraKey; key: number } | null>(null);
  const [chronicle, setChronicle] = useState<ChronicleEntry[]>([]);
  const [society, setSociety] = useState<SocietyState | null>(null);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('cosmos');
  const [showHistory, setShowHistory] = useState(false);
  const [elapsedMonths, setElapsedMonths] = useState(0);
  const [eraKey, setEraKey] = useState<EraKey>('stable');
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [respawnToken, setRespawnToken] = useState(0);
  const [universeToken, setUniverseToken] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentHistory, setAgentHistory] = useState<AgentHistoryItem[]>([]);
  const [agentHistoryLoading, setAgentHistoryLoading] = useState(false);
  const [playing, setPlaying] = useState(false);   // 后端自动演化开关（默认暂停）
  const [thinking, setThinking] = useState(false);
  const [evolutionError, setEvolutionError] = useState<string | null>(null);
  const [replayMonth, setReplayMonth] = useState<number | null>(null); // 回放模式
  const [historyList, setHistoryList] = useState<{ month: number; label: string; summary: string }[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [roster, setRoster] = useState<string[]>([]); // 指定开局阵容（档案 id）；空 = 随机抽取
  const [mapMode, setMapMode] = useState<'2d' | '3d'>('3d'); // 演化页视图：立体沙盘（默认）/ 平面地图
  const [cover, setCover] = useState(false);              // 宇宙 ⇄ 人间 过场幕布
  const [planetFocused, setPlanetFocused] = useState(false); // 宇宙相机聚焦行星中
  const [exitFocusToken, setExitFocusToken] = useState(0);   // 自增 → 宇宙相机退出聚焦
  const transitioningRef = useRef(false);
  const transitionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const after = useCallback((ms: number, fn: () => void) => {
    transitionTimers.current.push(setTimeout(fn, ms));
  }, []);
  useEffect(() => () => {
    for (const t of transitionTimers.current) clearTimeout(t);
  }, []);

  /** 俯冲进入人间：幕布淡入 → 切视图（沙盘自带太空入场动画）→ 幕布淡出 */
  const diveToSociety = useCallback(() => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    setCover(true);
    after(380, () => {
      setView('society');
      setMapMode('3d');
      after(140, () => {
        setCover(false);
        transitioningRef.current = false;
      });
    });
  }, [after]);

  /** 升起返回宇宙：幕布淡入 → 切视图并退出行星聚焦 → 幕布淡出 */
  const riseToCosmos = useCallback(() => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    setCover(true);
    after(380, () => {
      setView('cosmos');
      setExitFocusToken((t) => t + 1);
      setPlanetFocused(false);
      after(140, () => {
        setCover(false);
        transitioningRef.current = false;
      });
    });
  }, [after]);

  const prev = useRef<{ civ: number }>({ civ: 1 });
  const eraMachine = useRef<{ era: EraKey | null; candidate: EraKey | null; sinceT: number }>({
    era: null, candidate: null, sinceT: 0,
  });
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eraKeyRef = useRef<EraKey>('stable');
  const monthRef = useRef(0);
  const clockPaused = useRef(false);
  const settlementRef = useRef(false);
  const civStats = useRef({ startMonth: 0, eras: 0 });
  const rosterRef = useRef<string[]>([]);
  const runIdRef = useRef(getElandRunId());
  const activeCivilizationRef = useRef(1);
  const activeWorldSeedRef = useRef<number | null>(null);
  const pendingCreationRef = useRef<{ id: string; worldSeed: number } | null>(null);
  const civilizationRequestGenerationRef = useRef(0);
  const canvasCivilizationSyncRef = useRef(false);
  const statsRef = useRef<SimStats | null>(null);
  const lastSkyTimeRef = useRef(0);
  const fluxRangeRef = useRef({ min: 1, max: 1, sum: 0, count: 0 });
  const [universeTarget, setUniverseTarget] = useState(0);

  useEffect(() => {
    const checkpointSession = () => { void elandClient.checkpoint(runIdRef.current); };
    window.addEventListener('pagehide', checkpointSession);
    return () => window.removeEventListener('pagehide', checkpointSession);
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

  const pushEntry = useCallback((civ: number, month: number, text: string, tone: ChronicleEntry['tone'] = 'plain') => {
    setChronicle((c) => [...c.slice(-1199), { id: entrySeq++, civ, month, text, tone }]);
  }, []);

  const flash = useCallback((era: EraKey) => {
    if (announceTimer.current) clearTimeout(announceTimer.current);
    setAnnounce({ era, key: Date.now() });
    announceTimer.current = setTimeout(() => setAnnounce(null), 3400);
  }, []);

  /** 应用后端来的一帧（新纪年） */
  const applyFrame = useCallback((frame: Frame) => {
    if (activeCivilizationRef.current !== frame.civilizationId) {
      canvasCivilizationSyncRef.current = true;
    }
    activeCivilizationRef.current = frame.civilizationId;
    prev.current.civ = frame.civilizationId;
    activeWorldSeedRef.current = frame.society.world.generator.seed;
    monthRef.current = frame.elapsedMonths;
    setElapsedMonths(frame.elapsedMonths);
    setSociety(frame.society);
    setSpeaker(frame.speaker);
    for (const e of frame.entries) {
      pushEntry(frame.civilizationId, frame.elapsedMonths, e.text, e.tone);
    }

    const populationExtinct = frame.society.agents.length > 0
      && frame.society.agents.every((agent) => agent.state === 'dead');
    if (frame.civilizationEnd?.kind === 'destroyed' && populationExtinct && !settlementRef.current) {
      settlementRef.current = true;
      clockPaused.current = true;
      setPlaying(false);
      const cs = civStats.current;
      setSettlement({
        fate: 'depopulated',
        civ: frame.civilizationId,
        months: frame.elapsedMonths - cs.startMonth,
        eras: cs.eras,
      });
    }
  }, [pushEntry]);

  /** 启动一个 ELAND 文明（后端会话）；有选定阵容时按阵容入局 */
  const startCivilization = useCallback((worldSeed = createWorldSeed()) => {
    const pendingCreation = pendingCreationRef.current?.worldSeed === worldSeed
      ? pendingCreationRef.current
      : { id: createCivilizationCreationId(), worldSeed };
    pendingCreationRef.current = pendingCreation;
    const generation = ++civilizationRequestGenerationRef.current;
    const picked = rosterRef.current;
    const sky = sampleSky();
    activeWorldSeedRef.current = worldSeed;
    void elandClient.begin(
      runIdRef.current,
      pendingCreation.id,
      sky,
      picked.length > 0 ? picked : undefined,
      worldSeed,
    ).then((frame) => {
      if (generation !== civilizationRequestGenerationRef.current) return;
      if (pendingCreationRef.current?.id === pendingCreation.id) pendingCreationRef.current = null;
      applyFrame(frame);
      setSelectedAgentId(null);
      setUniverseTarget((target) => Math.max(sky.toTime, target) + TU_PER_MONTH);
    }).catch(() => undefined);
  }, [applyFrame, sampleSky]);

  const toggleRosterPick = useCallback((id: string) => {
    setRoster((current) => {
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length >= 8
          ? current
          : [...current, id];
      rosterRef.current = next;
      return next;
    });
  }, []);

  const clearRoster = useCallback(() => {
    rosterRef.current = [];
    setRoster([]);
  }, []);

  /** 以当前阵容建立下一个文明并重开宇宙。 */
  const restartWithRoster = useCallback(() => {
    setShowArchive(false);
    setReplayMonth(null);
    setSettlement(null);
    settlementRef.current = false;
    clockPaused.current = false;
    monthRef.current = 0;
    setElapsedMonths(0);
    setChronicle([]);
    eraMachine.current = { era: null, candidate: null, sinceT: 0 };
    prev.current = { civ: activeCivilizationRef.current };
    civStats.current = { startMonth: 0, eras: 0 };
    startCivilization();
    setUniverseToken((t) => t + 1);
  }, [startCivilization]);

  const onStats = useCallback(
    (s: SimStats) => {
      statsRef.current = s;
      if (canvasCivilizationSyncRef.current) {
        if (s.civilizations === activeCivilizationRef.current) {
          canvasCivilizationSyncRef.current = false;
        } else {
          return;
        }
      }
      const range = fluxRangeRef.current;
      range.min = range.count ? Math.min(range.min, s.fluxRel) : s.fluxRel;
      range.max = range.count ? Math.max(range.max, s.fluxRel) : s.fluxRel;
      range.sum += s.fluxRel;
      range.count += 1;
      setStats(s);
      const p = prev.current;
      const em = eraMachine.current;
      const month = monthRef.current;

      // 文明崩塌 → 停后端演化，冻结时钟，弹结算幕
      if (s.collapsed && !settlementRef.current) {
        settlementRef.current = true;
        clockPaused.current = true;
        setPlaying(false);
        const cs = civStats.current;
        setSettlement({
          fate: s.collapsed,
          civ: s.civilizations,
          months: month,
          eras: cs.eras,
        });
        return;
      }

      // 文明更替 → 后端启动新文明
      if (s.civilizations !== p.civ) {
        if (s.civilizations > p.civ) startCivilization();
        civStats.current = { startMonth: 0, eras: 0 };
        p.civ = s.civilizations;
      }

      // 纪元判定（带气候 + 时间迟滞）
      const raw = eraKeyOf(s.planetFate, s.fluxRel);
      const commit = (k: EraKey, silent: boolean) => {
        em.era = k; em.candidate = null;
        eraKeyRef.current = k;
        setEraKey(k);
        if (!silent) {
          civStats.current.eras += 1;
          flash(k);
        }
      };
      if (raw === 'extinct') {
        if (em.era !== 'extinct') commit('extinct', false);
      } else if (em.era === null) {
        commit(raw, true);
      } else if (raw !== em.era) {
        if (em.candidate === raw) {
          if (s.t - em.sinceT >= 0.16) commit(raw, false);
        } else {
          em.candidate = raw; em.sinceT = s.t;
        }
      } else {
        em.candidate = null;
      }
    },
    [flash, startCivilization],
  );

  useEffect(() => {
    if (entered) startCivilization();
  }, [entered, startCivilization]);

  useEffect(() => () => { if (announceTimer.current) clearTimeout(announceTimer.current); }, []);

  // ------------------------------------------------------------------
  // 演化控制（后端驱动）
  // ------------------------------------------------------------------

  const stepOnce = useCallback(async () => {
    if (thinking || settlementRef.current) return;
    setThinking(true);
    setEvolutionError(null);
    try {
      const sky = sampleSky();
      const frame = await elandClient.step(runIdRef.current, sky);
      if (frame && frame.civilizationId === activeCivilizationRef.current && frame.elapsedMonths > monthRef.current) {
        applyFrame(frame);
        setUniverseTarget((target) => Math.max(sky.toTime, target) + TU_PER_MONTH);
      }
    } catch (error) {
      if (error instanceof ElandSessionMissingError) {
        startCivilization(activeWorldSeedRef.current ?? createWorldSeed());
        return;
      }
      setPlaying(false);
      setEvolutionError(error instanceof Error ? error.message : '本地规则演化失败，已停在最近完成的月份');
    } finally {
      setThinking(false);
    }
  }, [thinking, applyFrame, sampleSky, startCivilization]);

  useEffect(() => {
    if (!entered || !playing || replayMonth !== null || !pageVisible) return;
    const timer = setInterval(() => { void stepOnce(); }, 5000);
    return () => clearInterval(timer);
  }, [entered, pageVisible, playing, replayMonth, stepOnce]);

  const togglePlay = useCallback(() => {
    const next = !playing;
    setPlaying(next);
  }, [playing]);

  const openReplay = useCallback(() => {
    void elandClient.history(runIdRef.current).then(({ history }) => {
      if (history.length === 0) return;
      setHistoryList(history);
      setPlaying(false);
      setReplayMonth(history[0].month);
      const frame = history[0];
      void elandClient.frameAt(runIdRef.current, frame.month).then((f) => f && setSociety(f.society));
    }).catch(() => undefined);
  }, []);

  const seekReplay = useCallback((month: number) => {
    setReplayMonth(month);
    void elandClient.frameAt(runIdRef.current, month).then((f) => f && setSociety(f.society));
  }, []);

  const exitReplay = useCallback(() => {
    setReplayMonth(null);
    void elandClient.state(runIdRef.current).then(({ frame }) => {
      if (frame) { setSociety(frame.society); monthRef.current = frame.elapsedMonths; setElapsedMonths(frame.elapsedMonths); }
    }).catch(() => undefined);
  }, []);

  const reEvolveFrom = useCallback((month: number) => {
    void elandClient.seek(runIdRef.current, month).then((frame) => {
      if (!frame) return;
      // 截断本地史册中该月之后的本文明记录
      setChronicle((c) => c.filter((e) => !(e.civ === frame.civilizationId && e.month > month)));
      monthRef.current = month;
      setElapsedMonths(month);
      setSociety(frame.society);
      setReplayMonth(null);
      pushEntry(frame.civilizationId, month, `—— 时光回溯至第 ${month} 月，演化从此分岔 ——`, 'era');
    }).catch(() => undefined);
  }, [pushEntry]);

  const continueGame = useCallback(() => {
    if (!settlement) return;
    const isExtinct = settlement.fate === 'extinct';
    setSettlement(null);
    settlementRef.current = false;
    clockPaused.current = false;
    if (isExtinct) {
      monthRef.current = 0;
      setElapsedMonths(0);
      setChronicle([]);
      eraMachine.current = { era: null, candidate: null, sinceT: 0 };
      prev.current = { civ: activeCivilizationRef.current };
      civStats.current = { startMonth: 0, eras: 0 };
      startCivilization();
      setUniverseToken((t) => t + 1);
    } else {
      setRespawnToken((t) => t + 1);
    }
  }, [settlement, startCivilization]);

  const visibleChronicle = useMemo(() => chronicle.slice(-5), [chronicle]);
  const era = ERA_TEXT[eraKey];
  const archiveById = useMemo(() => new Map(CHARACTERS.map((c) => [c.id, c])), []);
  const focusAgent = useMemo(() => {
    if (!society) return null;
    return society.agents.find((a) => a.id === selectedAgentId)
      ?? society.agents.find((a) => a.name === speaker)
      ?? society.agents.find((a) => a.state === 'active')
      ?? society.agents[0]
      ?? null;
  }, [society, speaker, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId || !society?.agents.some((agent) => agent.id === selectedAgentId)) {
      setAgentHistory([]);
      setAgentHistoryLoading(false);
      return;
    }
    let active = true;
    setAgentHistoryLoading(true);
    const viewedMonth = replayMonth ?? elapsedMonths;
    void elandClient.agentHistory(runIdRef.current, selectedAgentId, viewedMonth).then((result) => {
      if (active) setAgentHistory(result?.events ?? []);
    }).catch(() => {
      if (active) setAgentHistory([]);
    }).finally(() => {
      if (active) setAgentHistoryLoading(false);
    });
    return () => { active = false; };
  }, [elapsedMonths, replayMonth, selectedAgentId, society]);

  const settlementEntries = useMemo(
    () => (settlement ? chronicle.filter((e) => e.civ === settlement.civ).slice(-24) : []),
    [settlement, chronicle],
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#04050c] font-serif text-slate-200">
      <style>{`
        @keyframes era-flash {
          0% { opacity: 0; letter-spacing: 0.1em; transform: scale(0.96); filter: blur(6px); }
          18% { opacity: 1; filter: blur(0); }
          78% { opacity: 1; }
          100% { opacity: 0; letter-spacing: 0.9em; transform: scale(1.04); filter: blur(3px); }
        }
        @keyframes rise-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        @keyframes flicker { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.72; transform: scale(0.88); } }
        @keyframes agent-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        @keyframes smoke { 0% { transform: translate(-50%, 0); opacity: 0.5; } 100% { transform: translate(-30%, -28px); opacity: 0; } }
        @keyframes firefly { 0%,100% { transform: translate(0,0); opacity: 0.2; } 25% { opacity: 0.9; } 50% { transform: translate(9px,-11px); opacity: 0.3; } 75% { opacity: 0.8; } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
      `}</style>

      {/* 宇宙背景 */}
      <div className="absolute inset-0 transition-opacity duration-1000" style={{ opacity: view === 'society' ? 0.22 : 1 }}>
        <ThreeBodyCanvas
          running={entered && !clockPaused.current}
          speed={3}
          trailLength={2200}
          showTwin={false}
          presetKey="chaos"
          resetToken={universeToken}
          civilizationId={activeCivilizationRef.current}
          targetT={universeTarget}
          skyMode={view === 'society' || replayMonth !== null ? 'frozen' : 'follow'}
          collapseHold
          respawnToken={respawnToken}
          onStats={onStats}
          planetFocusEnabled={entered && view === 'cosmos' && replayMonth === null}
          onPlanetFocusChange={setPlanetFocused}
          onPlanetDive={diveToSociety}
          exitFocusToken={exitFocusToken}
        />
      </div>

      {/* 电影暗角 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at center, transparent 42%, rgba(2,3,10,0.75) 100%)' }}
      />

      {/* 人间地图页：立体沙盘（默认）/ 平面地图 */}
      {view === 'society' && society && stats && (
        mapMode === '3d' ? (
          <SocietyScene3D
            society={society}
            era={eraKey}
            speaker={speaker}
            sky={stats}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
            onZoomOutRequest={riseToCosmos}
          />
        ) : (
          <SocietyMap
            society={society}
            era={eraKey}
            speaker={speaker}
            focusAgent={focusAgent}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
            agentHistory={agentHistory}
            agentHistoryLoading={agentHistoryLoading}
            seed={(stats.civilizations * 7919) % 100000}
          />
        )
      )}

      {/* 天象画中画：演化页抬头见天；点击切回宇宙视角 */}
      {view === 'society' && stats && (
        <SkyPiP
          stats={stats}
          era={eraKey}
          onOpen={() => setView('cosmos')}
          className="absolute bottom-24 right-[356px] z-10"
        />
      )}

      {/* 纪元巨字宣告 */}
      {announce && (
        <div
          key={announce.key}
          className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center"
          style={{ animation: 'era-flash 3.4s ease-out forwards', background: `radial-gradient(ellipse at center, ${ERA_TEXT[announce.era].glow}, transparent 65%)` }}
        >
          <div className={`text-[11rem] font-extralight leading-none tracking-[0.35em] ${ERA_TEXT[announce.era].cls}`}
               style={{ textShadow: '0 0 80px currentColor' }}>
            {ERA_TEXT[announce.era].big}
          </div>
          <div className="mt-8 text-sm tracking-[0.6em] text-slate-300/80">{ERA_TEXT[announce.era].sub}</div>
        </div>
      )}

      {/* 文明编号（左上，仅宇宙视角） */}
      {view === 'cosmos' && (
      <div className="pointer-events-none absolute left-10 top-10 z-10 select-none">
        <div className="text-[11px] tracking-[0.5em] text-slate-500">THREE-BODY · 文明游戏</div>
        <div className="mt-3 text-5xl font-extralight tracking-[0.2em] text-slate-100/90">
          第{toChineseNum(stats?.civilizations ?? 1)}号文明
        </div>
        <div className="mt-3 h-px w-40 bg-gradient-to-r from-slate-400/40 to-transparent" />
        <div className="mt-3 flex items-baseline gap-4 text-xs tracking-[0.3em] text-slate-400">
          <span>{monthLabel(elapsedMonths)}</span>
          {thinking && <span className="animate-pulse text-slate-500">推演中…</span>}
          {!announce && <span className={era.cls}>{era.big}</span>}
          {society && (
            <span className="text-slate-500">
              在册 {society.agents.filter((a) => a.state === 'active').length}/{society.agents.length} 人
            </span>
          )}
        </div>
      </div>
      )}

      {/* 人物名册（右侧竖排，宇宙模式） */}
      {view === 'cosmos' && !showHistory && society && (
        <div className="absolute right-8 top-1/2 z-10 max-h-[70vh] -translate-y-1/2 overflow-hidden text-right">
          <div className="mb-3 text-[10px] tracking-[0.4em] text-slate-600">入局者 · {society.agents.length} 人</div>
          <div className="space-y-1.5">
            {society.agents.map((a) => {
              const entry = archiveById.get(a.id);
              return (
                <div
                  key={a.id}
                  className={`flex cursor-pointer items-center justify-end gap-2.5 text-xs tracking-[0.25em] transition-all duration-700 ${
                    speaker === a.name ? 'text-amber-200' : a.state === 'dead' ? 'text-slate-700 line-through' : 'text-slate-500/60'
                  }`}
                  style={speaker === a.name ? { textShadow: '0 0 18px rgba(251,191,36,0.6)' } : undefined}
                  onClick={() => setSelectedAgentId(selectedAgentId === a.id ? null : a.id)}
                >
                  <span>{a.name}</span>
                  {entry?.portrait && (
                    <img
                      src={entry.portrait}
                      alt={a.name}
                      loading="lazy"
                      className={`h-6 w-6 rounded-full border border-white/15 object-cover ${a.state === 'dead' ? 'opacity-40 grayscale' : ''}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 编年史 ticker */}
      {!showHistory && (
        <div
          className="pointer-events-none absolute left-10 z-10 space-y-2 transition-all duration-700"
          style={{ bottom: view === 'society' ? '1.2vh' : '9vh', width: view === 'society' ? '44vw' : '520px' }}
        >
          {visibleChronicle.map((e, i) => (
            <div
              key={e.id}
              className="text-[13px] leading-relaxed tracking-wider"
              style={{
                animation: 'rise-in 0.8s ease-out',
                opacity: 0.35 + (0.65 * (i + 1)) / visibleChronicle.length,
                color:
                  e.tone === 'good' ? '#a7f3d0' :
                  e.tone === 'bad' ? '#fda4af' :
                  e.tone === 'era' ? '#fde68a' : '#94a3b8',
              }}
            >
              <span className="mr-3 text-[11px] text-slate-600">{e.month === 0 ? '月初' : `第${e.month}月`}</span>
              {e.text}
            </div>
          ))}
        </div>
      )}

      {/* 史册长卷 */}
      {showHistory && (
        <div className="absolute bottom-0 right-0 top-0 z-20 flex w-[420px] flex-col border-l border-white/5 bg-[#04050c]/85 backdrop-blur-md">
          <div className="flex items-center justify-between px-6 py-5">
            <div className="text-xs tracking-[0.5em] text-slate-400">史册 · 文明编年</div>
            <button onClick={() => setShowHistory(false)} className="text-xs tracking-[0.3em] text-slate-500 hover:text-slate-300">合上 ✕</button>
          </div>
          <div className="flex-1 space-y-2.5 overflow-y-auto px-6 pb-8">
            {chronicle.length === 0 && <div className="text-xs text-slate-600">尚无记载。世界刚刚开始。</div>}
            {[...chronicle].reverse().map((e) => (
              <div key={e.id} className="text-[12px] leading-relaxed tracking-wider"
                style={{ color: e.tone === 'good' ? '#a7f3d0' : e.tone === 'bad' ? '#fda4af' : e.tone === 'era' ? '#fde68a' : '#94a3b8' }}>
                <span className="mr-2 text-[10px] text-slate-600">文明{toChineseNum(e.civ)} · {e.month === 0 ? '月初' : `第${e.month}月`}</span>
                {e.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部中央：视角 / 史册 / 演化控制 */}
      {entered && replayMonth === null && (
        <div
          className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-4 whitespace-nowrap text-[11px] tracking-[0.32em] text-slate-500"
          style={view === 'society' ? { left: '39%' } : undefined}
        >
          <button onClick={() => setView(view === 'cosmos' ? 'society' : 'cosmos')} className="transition-colors hover:text-amber-200">
            {view === 'cosmos' ? '俯 瞰 · 人 间 ↓' : '仰 望 · 宇 宙 ↑'}
          </button>
          <span className="text-slate-700">·</span>
          <button onClick={() => setShowHistory(!showHistory)} className="transition-colors hover:text-amber-200">
            {showHistory ? '掩 卷' : '翻 开 史 册'}
          </button>
          <span className="text-slate-700">·</span>
          <button onClick={stepOnce} disabled={thinking} className={`transition-colors ${thinking ? 'text-slate-700' : 'hover:text-amber-200'}`}>
            {thinking ? '推 演 中 …' : '单 步 ⊲'}
          </button>
          <span className="text-slate-700">·</span>
          <button onClick={togglePlay} className={`transition-colors ${playing ? 'text-amber-200' : 'hover:text-amber-200'}`}>
            {playing ? '暂 停 ‖' : '演 化 ▶'}
          </button>
          <span className="text-slate-700">·</span>
          <div className="tracking-[0.18em] text-slate-600" title="每月由本地规则规划器执行 15 个规划刻度">本 地 规 则 · 流 畅 演 化</div>
          <span className="text-slate-700">·</span>
          <button onClick={() => setShowArchive(true)} className="transition-colors hover:text-amber-200" title="浏览人物档案并指定开局阵容">
            人 物 档 案{roster.length > 0 ? ` · ${roster.length}` : ''}
          </button>
          <span className="text-slate-700">·</span>
          <button onClick={openReplay} className="transition-colors hover:text-amber-200">
            回 放 ↺
          </button>
          {view === 'society' && (
            <>
              <span className="text-slate-700">·</span>
              <button onClick={() => setMapMode((m) => (m === '3d' ? '2d' : '3d'))} className="transition-colors hover:text-amber-200">
                {mapMode === '3d' ? '平 面 图 ▦' : '立 体 沙 盘 ▧'}
              </button>
            </>
          )}
        </div>
      )}

      {entered && evolutionError && replayMonth === null && (
        <div className="absolute bottom-16 left-1/2 z-30 -translate-x-1/2 border border-rose-300/20 bg-slate-950/90 px-4 py-2 text-[11px] tracking-wider text-rose-200/80 backdrop-blur-md">
          演化已暂停 · {evolutionError}
        </div>
      )}

      {/* 回放控制条（纯记录回放，零 LLM 消耗） */}
      {replayMonth !== null && (
        <div className="absolute bottom-5 left-1/2 z-30 flex w-[560px] -translate-x-1/2 items-center gap-4 rounded-full border border-white/10 bg-slate-950/80 px-6 py-3 backdrop-blur-md">
          <span className="whitespace-nowrap text-[10px] tracking-[0.3em] text-amber-200/80">回放 · 第 {replayMonth} 月</span>
          <input
            type="range"
            min={historyList[0]?.month ?? 0}
            max={historyList.at(-1)?.month ?? 0}
            value={replayMonth}
            onChange={(e) => seekReplay(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/10 accent-amber-300"
          />
          <button onClick={() => reEvolveFrom(replayMonth)} className="whitespace-nowrap text-[10px] tracking-[0.2em] text-slate-400 transition-colors hover:text-amber-200">
            从此月重新演化
          </button>
          <button onClick={exitReplay} className="whitespace-nowrap text-[10px] tracking-[0.2em] text-slate-500 transition-colors hover:text-slate-300">
            退出 ✕
          </button>
        </div>
      )}

      {/* 行星聚焦提示（宇宙视角） */}
      {view === 'cosmos' && planetFocused && !cover && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-10 -translate-x-1/2 animate-pulse text-[11px] tracking-[0.3em] text-teal-200/80">
          双击行星直接进入人间 · 继续滚轮也可俯冲 · 双击空白处离开行星
        </div>
      )}

      {/* 宇宙 ⇄ 人间 过场幕布 */}
      <div
        className="pointer-events-none absolute inset-0 z-[60] bg-[#04050c] transition-opacity duration-300"
        style={{ opacity: cover ? 1 : 0 }}
      />

      {/* 人物档案 · 原型库与阵容选择 */}
      {showArchive && (
        <CharacterArchive
          roster={roster}
          inGameIds={new Set(society?.agents.map((a) => a.id) ?? [])}
          onToggle={toggleRosterPick}
          onClear={clearRoster}
          onRestart={restartWithRoster}
          onClose={() => setShowArchive(false)}
        />
      )}

      {/* 文明结算幕 */}
      {settlement && (
        <SettlementOverlay key={`${settlement.civ}-${settlement.fate}`} s={settlement} entries={settlementEntries} onContinue={continueGame} />
      )}

      {/* 开场黑场 */}
      {!entered && (
        <div
          className="absolute inset-0 z-40 flex cursor-pointer flex-col items-center justify-center bg-[#04050c]"
          onClick={() => setEntered(true)}
        >
          <div className="text-[10rem] font-extralight leading-none tracking-[0.3em] text-slate-100"
               style={{ writingMode: 'vertical-rl', textShadow: '0 0 60px rgba(148,163,184,0.4)' }}>
            三體
          </div>
          <div className="mt-12 text-xs tracking-[0.8em] text-slate-500">文 明 游 戏 · 原 型</div>
          <div className="mt-20 animate-pulse text-sm tracking-[0.5em] text-slate-400">点 击 进 入</div>
        </div>
      )}
    </div>
  );
}
