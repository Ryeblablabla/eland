import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ThreeBodyCanvas, { type SimStats } from '@/components/ThreeBodyCanvas';
import SocietyScene3D from '@/components/SocietyScene3D';
import { createWorldSeed, ElandSessionMissingError, elandClient, getElandRunId, type Frame } from '@/game/elandClient';
import type { EraKey, SocietyState, SkySample } from '@/game/societyContract';
import type { PlanetFate } from '@/lib/threebody';
import { useDocumentVisible } from '@/hooks/use-document-visible';

type ViewMode = 'cosmos' | 'society';

interface EvolutionEntry {
  id: string;
  month: number;
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  detail?: string;
  status?: true;
}

const TU_PER_MONTH = 0.8 / 12;
const AUTO_STEP_MS = 4_000;

const ERA_TEXT: Record<EraKey, { big: string; sub: string; cls: string; glow: string }> = {
  stable: { big: '恒纪元', sub: '三日轨度可测 · 文明复苏', cls: 'text-amber-100', glow: 'rgba(251,191,36,0.25)' },
  chaotic: { big: '乱纪元', sub: '飞星失序 · 脱水！脱水！', cls: 'text-rose-200', glow: 'rgba(244,63,94,0.22)' },
  'chaotic-heat': { big: '酷暑纪元', sub: '烈日炙烤 · 焦土万里', cls: 'text-orange-200', glow: 'rgba(249,115,22,0.28)' },
  'chaotic-cold': { big: '严寒纪元', sub: '飞星远去 · 冰封千里', cls: 'text-sky-200', glow: 'rgba(56,189,248,0.25)' },
  burned: { big: '三日凌空', sub: '烈焰焚世', cls: 'text-orange-200', glow: 'rgba(249,115,22,0.3)' },
  frozen: { big: '长夜', sub: '飞星不动 · 万物冻结', cls: 'text-sky-200', glow: 'rgba(56,189,248,0.25)' },
  extinct: { big: '文明终结', sub: '星系崩解 · 世界不再重启', cls: 'text-purple-200', glow: 'rgba(168,85,247,0.3)' },
};

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第${Math.floor((month - 1) / 12) + 1}年·${((month - 1) % 12) + 1}月`;
}

function eraKeyOf(fate: PlanetFate, fluxRel: number): EraKey {
  if (fate !== 'chaotic') return fate;
  if (fluxRel > 1.8) return 'chaotic-heat';
  if (fluxRel < 0.45) return 'chaotic-cold';
  return 'chaotic';
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

  const runIdRef = useRef(getElandRunId());
  const startedRef = useRef(false);
  const sessionReadyRef = useRef(false);
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

  const pushHistory = useCallback((month: number, text: string, tone: EvolutionEntry['tone'] = 'plain', detail?: string) => {
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
      }];
    });
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
    activeCivilizationRef.current = frame.civilizationId;
    activeWorldSeedRef.current = frame.society.world.generator.seed;
    monthRef.current = frame.elapsedMonths;
    setSociety(frame.society);
    setSpeaker(frame.speaker);
    for (const entry of frame.entries) pushHistory(entry.month, entry.text, entry.tone, entry.detail);

    const populationEnded = frame.society.agents.length > 0
      && frame.society.agents.every((agent) => agent.state === 'dead');
    if (frame.civilizationEnd?.kind === 'destroyed' && populationEnded && !replacementRequestedRef.current) {
      replacementRequestedRef.current = true;
      sessionReadyRef.current = false;
      setRespawnToken((token) => token + 1);
    }
  }, [pushHistory]);

  const startCivilization = useCallback((civilizationId: number, worldSeed = createWorldSeed()) => {
    const generation = ++sessionGenerationRef.current;
    const statusId = `${runIdRef.current}:starting:${generation}`;
    sessionReadyRef.current = false;
    activeCivilizationRef.current = civilizationId;
    activeWorldSeedRef.current = worldSeed;
    setHistory((current) => {
      const events = current.filter((entry) => !entry.status);
      return [...events.slice(-239), {
        id: statusId,
        month: 0,
        text: '本地演化正在开始',
        tone: 'plain',
        status: true,
      }];
    });
    const sky = sampleSky();
    void elandClient.begin(runIdRef.current, civilizationId, sky, undefined, worldSeed).then((frame) => {
      if (generation !== sessionGenerationRef.current || frame.civilizationId !== civilizationId) return;
      applyFrame(frame);
      replacementRequestedRef.current = false;
      sessionReadyRef.current = true;
      setUniverseTarget((target) => Math.max(sky.toTime, target) + TU_PER_MONTH);
      pushHistory(frame.elapsedMonths, `第 ${civilizationId} 号文明在自然地表上开始，${frame.society.agents.length} 位先民登场`, 'era');
    }).catch((error) => {
      if (generation !== sessionGenerationRef.current) return;
      pushHistory(monthRef.current, error instanceof Error ? error.message : '本地演化会话启动失败', 'bad');
    });
  }, [applyFrame, pushHistory, sampleSky]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startCivilization(1);
  }, [startCivilization]);

  const stepOnce = useCallback(async () => {
    if (!sessionReadyRef.current || steppingRef.current) return;
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
          sessionReadyRef.current = false;
          startCivilization(activeCivilizationRef.current, activeWorldSeedRef.current ?? createWorldSeed());
          return;
        }
        pushHistory(monthRef.current, error instanceof Error ? error.message : '本地规则演化失败', 'bad');
      }
    } finally {
      steppingRef.current = false;
    }
  }, [applyFrame, pushHistory, sampleSky, startCivilization]);

  useEffect(() => {
    if (!pageVisible) return;
    const firstStep = setTimeout(() => { void stepOnce(); }, 1_000);
    const interval = setInterval(() => { void stepOnce(); }, AUTO_STEP_MS);
    return () => {
      clearTimeout(firstStep);
      clearInterval(interval);
    };
  }, [pageVisible, stepOnce]);

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
      sessionReadyRef.current = false;
      if (stats.collapsed === 'extinct') {
        previousCivilizationRef.current = 1;
        setUniverseResetToken((token) => token + 1);
        startCivilization(1);
      } else {
        replacementRequestedRef.current = true;
        setRespawnToken((token) => token + 1);
      }
      return;
    }

    collapseHandledRef.current = false;
    if (stats.civilizations !== previousCivilizationRef.current) {
      previousCivilizationRef.current = stats.civilizations;
      replacementRequestedRef.current = false;
      startCivilization(stats.civilizations);
    }
  }, [flashEra, startCivilization]);

  const diveToSociety = useCallback(() => {
    if (!society || transitionRef.current) return;
    transitionRef.current = true;
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
          running
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
        />
      </div>

      {view === 'society' && society && (
        <SocietyScene3D
          society={society}
          era={eraKey}
          speaker={speaker}
          sky={statsRef.current ?? undefined}
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

      <div
        className="pointer-events-none absolute bottom-0 left-0 z-[70] w-[min(680px,82vw)] px-8 pb-7 pt-20"
        style={{ background: 'radial-gradient(ellipse at 8% 100%, rgba(1,3,9,0.82) 0%, rgba(1,3,9,0.46) 42%, transparent 76%)' }}
      >
        <div className="space-y-1.5">
          {visibleHistory.map((entry, index) => (
            <div
              key={entry.id}
              title={entry.detail}
              className="text-[13px] leading-[1.55] tracking-[0.055em] sm:text-[14px]"
              style={{
                opacity: 0.52 + (0.48 * (index + 1)) / Math.max(1, visibleHistory.length),
                color: entry.tone === 'good' ? '#bbf7d0'
                  : entry.tone === 'bad' ? '#fecdd3'
                    : entry.tone === 'era' ? '#fef3c7' : '#e2e8f0',
                textShadow: '0 1px 2px rgba(0,0,0,1), 0 3px 14px rgba(0,0,0,0.98), 0 0 26px rgba(0,0,0,0.72)',
              }}
            >
              {!entry.status && (
                <span className="mr-3 text-[11px] text-slate-300/75">{monthLabel(entry.month)}</span>
              )}
              {entry.text}
            </div>
          ))}
        </div>
      </div>

      <div
        className="pointer-events-none absolute inset-0 z-[60] bg-[#02030a] transition-opacity duration-300"
        style={{ opacity: cover ? 1 : 0 }}
      />
    </main>
  );
}
