import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Footprints, Mountain, Orbit, PersonStanding, Sun } from 'lucide-react';
import SocietyScene3D, { type HumanSkySnapshot, type SocietyCameraMode } from '../components/SocietyScene3D';
import type { EmbodimentMoveDirection } from '../components/society-scene/EmbodimentCameraController';
import {
  createRiverbendStudy,
  moveStudyVisitor,
  riverbendStudyFrame,
  STUDY_PLAYBACK_MS,
  STUDY_VISITOR_ID,
  STUDY_VISITOR_START,
} from '../game/art-direction/riverbendStudy';
import './RiverbendStudy.css';

type StudyView = 'valley' | 'village' | 'person';

const VIEW_OPTIONS = [
  { id: 'valley', label: '俯瞰河湾', Icon: Mountain },
  { id: 'village', label: '走进村巷', Icon: Footprints },
  { id: 'person', label: '以人之眼', Icon: PersonStanding },
] as const;

const DIRECTION_STEP: Record<EmbodimentMoveDirection, readonly [number, number]> = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
};

/** Self-contained visual study: mounting this page cannot load or mutate a save. */
export default function RiverbendStudy() {
  const [study] = useState(createRiverbendStudy);
  const [chaotic, setChaotic] = useState(false);
  const [view, setView] = useState<StudyView>('valley');
  const [viewRevision, setViewRevision] = useState(0);
  const [beat, setBeat] = useState(0);
  const [visitorCell, setVisitorCell] = useState(STUDY_VISITOR_START);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [heldDirection, setHeldDirection] = useState<EmbodimentMoveDirection | null>(null);
  const lastStepAt = useRef(0);

  useEffect(() => {
    const interval = window.setInterval(() => setBeat((value) => value + 1), STUDY_PLAYBACK_MS);
    return () => window.clearInterval(interval);
  }, []);

  const society = useMemo(() => riverbendStudyFrame(study, beat, chaotic, visitorCell), [study, beat, chaotic, visitorCell]);
  const sky = useMemo<HumanSkySnapshot>(() => chaotic
    ? { t: 0, fluxRel: 2.8, bodies: [90, 125, 140, 50, -30, 150, 0, 0] }
    : { t: 0, fluxRel: 1, bodies: [150, 180, -1100, -1200, -900, -950, 0, 0] }, [chaotic]);

  const cameraMode = useMemo<SocietyCameraMode>(() => view === 'person'
    ? { kind: 'embodiment', agentId: STUDY_VISITOR_ID }
    : {
      kind: 'overview',
      framing: view === 'valley'
        ? { target: [-1, 1.8, -0.5], offset: [29, 28, 33], key: `valley-${viewRevision}` }
        : { target: [-3.5, 1.7, 1.5], offset: [8, 7, 9], key: `village-${viewRevision}` },
    }, [view, viewRevision]);

  const selectView = useCallback((next: StudyView) => {
    if (document.pointerLockElement) void document.exitPointerLock();
    setHeldDirection(null);
    setView(next);
    setViewRevision((value) => value + 1);
  }, []);

  const moveVisitor = useCallback((direction: EmbodimentMoveDirection) => {
    const now = performance.now();
    if (now - lastStepAt.current < 160) return;
    lastStepAt.current = now;
    const [dx, dy] = DIRECTION_STEP[direction];
    setVisitorCell((current) => moveStudyVisitor(study, current, dx, dy));
  }, [study]);

  useEffect(() => {
    if (view !== 'person' || !heldDirection) return;
    const interval = window.setInterval(() => moveVisitor(heldDirection), 180);
    return () => window.clearInterval(interval);
  }, [view, heldDirection, moveVisitor]);

  return (
    <main className={`riverbend-study${chaotic ? ' riverbend-study--chaotic' : ''}`}>
      <div className="riverbend-study__scene" aria-label="可游览的河湾聚落三维场景">
        <SocietyScene3D
          society={society}
          era={chaotic ? 'chaotic' : 'stable'}
          speaker={null}
          sky={sky}
          cameraMode={cameraMode}
          monthPlaybackDurationMs={STUDY_PLAYBACK_MS}
          onEmbodimentMove={moveVisitor}
          onEmbodimentMoveHoldChange={setHeldDirection}
          onEmbodimentPointerLockChange={setPointerLocked}
        />
      </div>
      <div className="riverbend-study__vignette" aria-hidden="true" />

      <header className="riverbend-study__header">
        <a className="riverbend-study__back" href="/" aria-label="回到 ELAND 游戏">
          <ArrowLeft size={15} strokeWidth={1.5} />
          <span>ELAND</span>
        </a>
        <div className="riverbend-study__era-switch" role="group" aria-label="天象">
          <button type="button" aria-pressed={!chaotic} onClick={() => setChaotic(false)}>
            <Sun size={15} strokeWidth={1.5} />恒纪元
          </button>
          <button type="button" aria-pressed={chaotic} onClick={() => setChaotic(true)}>
            <Orbit size={15} strokeWidth={1.5} />乱纪元
          </button>
        </div>
      </header>

      <section className="riverbend-study__title" aria-label="河湾聚落">
        <p className="riverbend-study__eyebrow"><span />地表手记 · 壹</p>
        <h1>河湾有人家</h1>
        <p className="riverbend-study__description">
          {chaotic ? <>第三颗太阳升起。<br />熟悉的屋檐，投下陌生的影子。</> : <>河水绕过石岸，炊烟越过树梢。<br />在这片小小的土地上，生活继续。</>}
        </p>
      </section>

      <aside className="riverbend-study__place" aria-label="场景说明">
        <span className="riverbend-study__place-line" />
        <span>河谷 · 林缘 · 聚落</span>
        <span className="riverbend-study__study-tag">美术样板</span>
      </aside>

      <footer className="riverbend-study__footer">
        <p className="riverbend-study__hint" aria-live="polite">
          {view === 'person'
            ? pointerLocked ? 'WASD 行走 · 移动鼠标环顾 · Esc 松开视角' : 'WASD 行走 · 拖动环顾 · 点击画面锁定视角'
            : '拖动环顾 · 滚轮靠近 · 点击人物停留'}
        </p>
        <nav className="riverbend-study__views" aria-label="游览视角">
          {VIEW_OPTIONS.map(({ id, label, Icon }) => (
            <button type="button" key={id} aria-pressed={view === id} onClick={() => selectView(id)}>
              <Icon size={17} strokeWidth={1.4} />
              <span>{label}</span>
              {view === id && <ArrowUpRight className="riverbend-study__view-arrow" size={13} strokeWidth={1.5} />}
            </button>
          ))}
        </nav>
        {view === 'person' && <div className="riverbend-study__touch-walk" role="group" aria-label="行走方向">
          {(['north', 'west', 'south', 'east'] as const).map((direction) => (
            <button key={direction} type="button" aria-label={{ north: '向北', west: '向西', south: '向南', east: '向东' }[direction]}
              onClick={() => moveVisitor(direction)}>{({ north: '↑', west: '←', south: '↓', east: '→' } as const)[direction]}</button>
          ))}
        </div>}
      </footer>
    </main>
  );
}
