import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Pause, Play, Upload } from 'lucide-react';
import SocietyScene3D, { type SocietyCameraMode } from '../components/SocietyScene3D';
import { toSocietyState } from '../game/eland/adapter';
import { materialDefinition } from '../game/eland/domain/material';
import type { SimulationState, WorldEvent } from '../game/eland/domain/model';
import { playerTextForEvent } from '../game/eland/projection/player-narrative';
import { WORLD_DEPTH, WORLD_LEVELS, WORLD_WIDTH } from '../game/eland/world/grid';
import type { EraKey, SocietyState } from '../game/societyContract';
import { WORLD_CELL_HEIGHT } from '../game/voxelKits';
import './AgentReplay.css';

interface ReplayFrame {
  index: number;
  atMonth: number;
  label: string;
  stateFile: string;
}

interface ReplayManifest {
  version: 'eland-experiment-replay-v1';
  kind: 'controlled' | 'society';
  label: string;
  frames: ReplayFrame[];
}

interface Snapshot {
  state: SimulationState;
  society: SocietyState;
  source: string;
}

interface ReplaySource {
  manifest: ReplayManifest;
  url: string | null;
  single?: Snapshot;
}

const PLAYBACK_MS = 2400;
const BODY_FIELDS = [['health', '健康'], ['hydration', '水分'], ['nutrition', '营养']] as const;
const ACTION_LABELS: Record<string, string> = {
  move: '移动', rest: '休息', wait: '等待', talk: '交谈', transfer: '转移物品',
  exert: '施力', separate: '分离材料', combine: '组合材料', expose: '暴露材料',
  ingest: '摄取食物或水', reproduce: '生育尝试', hunt: '狩猎', dehydrate: '脱水',
  rehydrate: '补水', inter: '安葬', interact: '与环境互动', act: '行动',
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameOriginUrl(value: string, base = window.location.href): string {
  const url = new URL(value, base);
  if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('请选择当前网站内的回放文件。');
  }
  return url.href;
}

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`文件读取失败（${response.status}）。`);
  return response.json();
}

function readManifest(value: unknown): ReplayManifest {
  if (!record(value) || value.version !== 'eland-experiment-replay-v1'
    || !['controlled', 'society'].includes(String(value.kind))
    || typeof value.label !== 'string' || !Array.isArray(value.frames) || !value.frames.length
    || !value.frames.every((frame: unknown) => record(frame)
      && Number.isFinite(frame.index) && Number.isFinite(frame.atMonth)
      && typeof frame.label === 'string' && typeof frame.stateFile === 'string')) {
    throw new Error('这不是可读取的实验回放清单。也可以选择一个 state.json 快照。');
  }
  return value as unknown as ReplayManifest;
}

/** Restore the JSON representation only; never hydrate, tick, or adopt a live session. */
function readSnapshot(value: unknown, source: string, kind: ReplayManifest['kind'] | 'single'): Snapshot {
  if (!record(value) || !record(value.world) || !record(value.world.grid)
    || !record(value.clock) || typeof value.clock.elapsedMonths !== 'number'
    || !Array.isArray(value.people) || !Array.isArray(value.lastStep)) {
    throw new Error('文件中没有完整的世界快照。');
  }
  const grid = value.world.grid;
  if (grid.width !== WORLD_WIDTH || grid.depth !== WORLD_DEPTH || grid.levels !== WORLD_LEVELS) {
    throw new Error('这个快照的地图尺寸与当前查看器不一致。');
  }
  const encoded = grid.voxels;
  if (!Array.isArray(encoded) && !record(encoded)) throw new Error('快照缺少地形数据。');
  const count = WORLD_WIDTH * WORLD_DEPTH * WORLD_LEVELS;
  const voxels = new Uint16Array(count);
  for (let index = 0; index < count; index += 1) {
    const material: unknown = Array.isArray(encoded) ? encoded[index] : encoded[String(index)];
    if (typeof material !== 'number' || !Number.isInteger(material) || material < 0 || material > 65535) {
      throw new Error('快照的地形数据不完整。');
    }
    voxels[index] = material;
  }
  const state = {
    ...value,
    world: { ...value.world, grid: { ...grid, voxels } },
  } as unknown as SimulationState;
  try {
    const projected = toSocietyState(state);
    // Society month frames carry real paths. Only controlled fixtures can have
    // stale placement paths; an unlabelled single file is explicitly static.
    if (kind === 'society') return { state, society: projected, source };
    const society: SocietyState = {
      ...projected,
      agents: projected.agents.map((agent) => ({
        ...agent, previousCellId: agent.cellId, lastPath: [agent.cellId], tickPath: [agent.cellId],
      })),
      animals: projected.animals.map((animal) => ({
        ...animal, previousCellId: animal.cellId, previousZ: animal.z,
        movementPath: [{ cellId: animal.cellId, z: animal.z }],
      })),
    };
    return { state, society, source };
  } catch {
    throw new Error('无法展示这个快照；它可能缺少必要字段或使用了不同版本。');
  }
}

function eventsOf(state: SimulationState): WorldEvent[] {
  return [...new Map([...state.world.past, ...state.lastStep].map((event) => [event.id, event])).values()];
}

function eventLabel(event: WorldEvent): string {
  if (event.kind === 'action') {
    const action = event.action;
    return ACTION_LABELS[action.kind === 'act' ? action.operation : action.kind] ?? '行动';
  }
  if (event.kind === 'decision') return '作出选择';
  if (event.kind === 'environment') return ({ body: '身体变化', death: '死亡', founding: '初始状态', resource: '资源变化' } as Record<string, string>)[event.change] ?? '环境变化';
  return '事实记录';
}

function eventMoment(event: WorldEvent): string {
  const tick = event.kind === 'action' ? event.actionTick : event.planningTick;
  return `第 ${event.atMonth} 月${tick ? ` · 活动 ${tick}` : ''}`;
}

function eraOf(state: SimulationState): EraKey {
  const { climate, epoch } = state.civilization;
  if (climate.kind === 'fire') return 'burned';
  if (climate.kind === 'heat') return 'chaotic-heat';
  if (climate.kind === 'cold') return 'chaotic-cold';
  return epoch;
}

function numberLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A local observer: this page only reads files and renders their recorded state. */
export default function AgentReplay() {
  const initialSource = new URL(window.location.href).searchParams.get('source') ?? '';
  const [sourceInput, setSourceInput] = useState(initialSource);
  const [requestedSource, setRequestedSource] = useState(initialSource);
  const [sourceLoadKey, setSourceLoadKey] = useState(0);
  const [replay, setReplay] = useState<ReplaySource | null>(null);
  const [framePosition, setFramePosition] = useState(0);
  const [loaded, setLoaded] = useState<{ current: Snapshot; previous?: Snapshot; position: number } | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [nearPerson, setNearPerson] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cache = useRef(new Map<string, Snapshot>());
  const sourceRevision = useRef(0);

  useEffect(() => {
    if (!requestedSource) return;
    const controller = new AbortController();
    const revision = ++sourceRevision.current;
    setLoading(true);
    setPlaying(false);
    setError('');
    setReplay(null);
    setLoaded(null);
    cache.current.clear();
    void (async () => {
      try {
        const url = sameOriginUrl(requestedSource);
        const manifest = readManifest(await readJson(url, controller.signal));
        if (revision !== sourceRevision.current || controller.signal.aborted) return;
        setFramePosition(0);
        setReplay({ manifest, url });
      } catch (cause) {
        if (revision === sourceRevision.current && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '回放读取失败。');
          setLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [requestedSource, sourceLoadKey]);

  useEffect(() => {
    if (!replay) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setEventId(null);
    setPersonId(null);
    const load = async (position: number): Promise<Snapshot> => {
      if (replay.single) return replay.single;
      const url = sameOriginUrl(replay.manifest.frames[position].stateFile, replay.url!);
      const cached = cache.current.get(url);
      if (cached) return cached;
      const snapshot = readSnapshot(await readJson(url, controller.signal), url, replay.manifest.kind);
      if (!controller.signal.aborted) cache.current.set(url, snapshot);
      return snapshot;
    };
    void (async () => {
      try {
        const [current, previous] = await Promise.all([
          load(framePosition), framePosition > 0 ? load(framePosition - 1) : Promise.resolve(undefined),
        ]);
        if (!controller.signal.aborted) setLoaded({ current, previous, position: framePosition });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '快照读取失败。');
          setPlaying(false);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [replay, framePosition]);

  useEffect(() => {
    if (!playing || loading || !loaded || !replay) return;
    if (framePosition >= replay.manifest.frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setFramePosition((position) => position + 1), PLAYBACK_MS);
    return () => window.clearTimeout(timer);
  }, [playing, loading, loaded, replay, framePosition]);

  const events = useMemo(() => {
    if (!loaded) return [];
    const previousIds = loaded.previous ? new Set(eventsOf(loaded.previous.state).map((event) => event.id)) : null;
    const current = previousIds ? eventsOf(loaded.current.state).filter((event) => !previousIds.has(event.id)) : loaded.current.state.lastStep;
    return current.filter((event) => event.kind !== 'decision-opportunity');
  }, [loaded]);
  const defaultEvent = [...events].reverse().find((event) => event.kind === 'action') ?? events.at(-1);
  const selectedEvent = events.find((event) => event.id === eventId) ?? defaultEvent;
  const state = loaded?.current.state;
  const decisionTrace = useMemo(() => {
    if (!state || !selectedEvent) return undefined;
    const facts = eventsOf(state);
    const executionId = selectedEvent.kind === 'action' ? selectedEvent.decisionSource?.executionDecisionEventId : undefined;
    const source = selectedEvent.kind === 'decision' ? selectedEvent : facts.find((event) => event.id === executionId);
    if (source?.kind !== 'decision') return undefined;
    const intentionId = selectedEvent.kind === 'action' ? selectedEvent.decisionSource?.intentionDecisionEventId
      : source.decision.authoredAttempt?.intentionSourceDecisionEventId;
    const origin = intentionId ? facts.find((event) => event.id === intentionId) : source;
    const goal = origin?.kind === 'decision' ? origin.decision.mentalAct?.goal : undefined;
    return { source, goal, attempt: source.decision.reason };
  }, [state, selectedEvent]);
  const actorId = selectedEvent && 'who' in selectedEvent ? selectedEvent.who : undefined;
  const person = state?.people.find((candidate) => candidate.id === (personId ?? actorId)) ?? state?.people[0];
  const previousPerson = loaded?.previous?.state.people.find((candidate) => candidate.id === person?.id);
  const frame = replay?.manifest.frames[loaded?.position ?? framePosition];
  const isSingle = Boolean(replay?.single);
  const controlled = replay?.manifest.kind === 'controlled' && !isSingle;
  const cameraMode = useMemo<SocietyCameraMode>(() => nearPerson && person && state ? {
    kind: 'overview',
    framing: {
      target: [
        person.position.cellId % state.world.grid.width - state.world.grid.width / 2 + 0.5,
        person.position.z * WORLD_CELL_HEIGHT + 0.5,
        Math.floor(person.position.cellId / state.world.grid.width) - state.world.grid.depth / 2 + 0.5,
      ],
      offset: [11, 10, 12],
    },
  } : { kind: 'overview', framing: { target: [0, 1.5, 0], offset: [90, 80, 90] } }, [nearPerson, person, state]);
  const resultText = useMemo(() => {
    if (!state || !selectedEvent) return '';
    try { return playerTextForEvent(state, selectedEvent) || selectedEvent.result; }
    catch { return selectedEvent.result; }
  }, [state, selectedEvent]);

  async function openSnapshot(file: File) {
    const revision = ++sourceRevision.current;
    setRequestedSource('');
    setPlaying(false);
    setLoading(true);
    setError('');
    setReplay(null);
    setLoaded(null);
    cache.current.clear();
    try {
      const snapshot = readSnapshot(JSON.parse(await file.text()), file.name, 'single');
      if (revision !== sourceRevision.current) return;
      setFramePosition(0);
      setReplay({
        url: null, single: snapshot,
        manifest: { version: 'eland-experiment-replay-v1', kind: 'society', label: file.name,
          frames: [{ index: 0, atMonth: snapshot.state.clock.elapsedMonths, label: '单个终态快照（静态）', stateFile: file.name }] },
      });
    } catch (cause) {
      if (revision === sourceRevision.current) {
        setError(cause instanceof Error ? cause.message : '快照读取失败。');
        setLoading(false);
      }
    }
  }

  function goTo(position: number) {
    setPlaying(false);
    setFramePosition(position);
  }

  return (
    <main className="agent-replay">
      <header className="agent-replay__header">
        <a href="/" className="agent-replay__home"><ArrowLeft size={15} /> ELAND</a>
        <span className="agent-replay__tag">实验回放 · 只读</span>
        <form className="agent-replay__source" onSubmit={(event) => { event.preventDefault(); setRequestedSource(sourceInput.trim()); setSourceLoadKey((key) => key + 1); }}>
          <input aria-label="回放清单地址" value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} placeholder="回放清单地址" />
          <button type="submit" disabled={!sourceInput.trim()}>打开回放</button>
        </form>
        <label className="agent-replay__upload"><Upload size={14} /> 选择快照
          <input type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void openSnapshot(file);
            event.target.value = '';
          }} />
        </label>
      </header>

      <section className="agent-replay__scene" aria-label="已记录世界的三维快照">
        {loaded && <SocietyScene3D society={loaded.current.society} era={eraOf(loaded.current.state)} speaker={null}
          monthPlaybackDurationMs={PLAYBACK_MS} cameraMode={cameraMode} selectedAgentId={person?.id} onSelectAgent={setPersonId} />}
        {!loaded && <div className="agent-replay__empty">
          <p>{loading ? '正在读取快照…' : '打开一段已记录的实验'}</p>
          {!loading && <span>使用回放清单逐帧查看，或选择一个 state.json 查看终态。</span>}
        </div>}
        {loaded && <>
          <button type="button" className="agent-replay__camera" onClick={() => setNearPerson((value) => !value)}>{nearPerson ? '查看全景' : '回到人物附近'}</button>
          <p className="agent-replay__scene-hint">{loading ? '正在读取快照…' : `${controlled || isSingle ? '静态快照位置' : '当月记录轨迹'} · 拖动环顾 · 滚轮靠近 · 点击人物查看`}</p>
        </>}
      </section>

      <aside className="agent-replay__panel">
        <p className="agent-replay__eyebrow">{isSingle ? '单个快照' : controlled ? '受控条件实验' : '社会实验记录'}</p>
        <h1>{replay?.manifest.label ?? '实验观察窗'}</h1>
        <p className="agent-replay__notice">{isSingle
          ? '仅展示这一个文件的静态终态；此前经过与自主程度无法由单个快照确定。'
          : controlled ? '人物、资源或行动条件经过人为设定。这里展示受控回合的结果，不能据此认定文明已自主发展。'
            : '逐帧查看已保存的世界与行动事实；这些记录本身不代表自主文明实验成功。'}</p>
        {error && <p className="agent-replay__error" role="alert">{error}</p>}
        {state && frame && <>
          <div className="agent-replay__time">
            <strong>{isSingle ? '终态' : controlled ? `受控步骤 ${frame.index}` : `第 ${frame.atMonth} 月`}</strong>
            <span>世界时钟：已过 {state.clock.elapsedMonths} 个月</span>
            {controlled && <span>记录的回合月份：{frame.atMonth}（步骤不等于月推进）</span>}
          </div>
          <h2>{frame.label}</h2>
          <label className="agent-replay__field">
            <span>{loaded?.previous ? '本帧新增事实' : '快照内最近记录'} · {events.length} 条</span>
            <select value={selectedEvent?.id ?? ''} disabled={!events.length} onChange={(event) => { setEventId(event.target.value); setPersonId(null); }}>
              {!events.length && <option value="">没有记录</option>}
              {events.map((event, index) => <option key={event.id} value={event.id}>{index + 1}. {event.planningTick || (event.kind === 'action' && event.actionTick) ? `活动 ${event.kind === 'action' ? event.actionTick : event.planningTick} · ` : ''}{eventLabel(event)}{'who' in event && event.who ? ` · ${state.people.find((candidate) => candidate.id === event.who)?.name ?? event.who}` : ''}</option>)}
            </select>
          </label>
          {decisionTrace && <article className="agent-replay__choice">
            <small>{decisionTrace.source.usedModel ? '当时的打算' : '行动缘由'} · {eventMoment(decisionTrace.source)}</small>
            {decisionTrace.goal && decisionTrace.goal !== decisionTrace.attempt && <p className="agent-replay__aim">{decisionTrace.goal}</p>}
            <p>{decisionTrace.attempt}</p>
            {selectedEvent?.id !== decisionTrace.source.id && events.some((event) => event.id === decisionTrace.source.id)
              && <button type="button" onClick={() => { setEventId(decisionTrace.source.id); setPersonId(null); }}>查看这次决定</button>}
          </article>}
          <article className="agent-replay__fact" aria-live="polite">
            {selectedEvent ? <>
              <div><strong>{actorId ? state.people.find((candidate) => candidate.id === actorId)?.name ?? actorId : '世界'}</strong><span>{eventLabel(selectedEvent)}</span></div>
              <small>{eventMoment(selectedEvent)}{selectedEvent.kind === 'action'
                ? ` · ${{ intent: '按本人安排', 'survival-reflex': '身体反应', 'player-embodiment': '玩家操作', 'decision-language': '说出的原话' }[selectedEvent.cause]}` : ''}</small>
              <p>{resultText}</p>
              {selectedEvent.kind === 'action' && <small>{({ completed: '已完成', progressed: '有进展', blocked: '受阻', failed: '失败' })[selectedEvent.status]}</small>}
            </> : <p>这一帧没有可展示的行动事实。</p>}
          </article>
          <label className="agent-replay__field"><span>查看人物</span>
            <select value={person?.id ?? ''} onChange={(event) => setPersonId(event.target.value)} disabled={!state.people.length}>
              {!state.people.length && <option value="">没有人物</option>}
              {state.people.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.diedAtMonth !== undefined ? ' · 已逝' : ''}</option>)}
            </select>
          </label>
          {person && <>
            <dl className="agent-replay__body">{BODY_FIELDS.map(([key, label]) => {
              const delta = previousPerson ? person.body[key] - previousPerson.body[key] : null;
              return <div key={key}><dt>{label}</dt><dd>{numberLabel(person.body[key])}{delta !== null && delta !== 0 && <small>{delta > 0 ? '+' : ''}{numberLabel(delta)}</small>}</dd></div>;
            })}</dl>
            <p className="agent-replay__muted">身体与物品为本帧终态。{previousPerson ? '变化值相对于上一帧，不归因于某一条行动。' : ''}</p>
            <h3>随身物品</h3>
            {person.inventory.length ? <ul className="agent-replay__inventory">{person.inventory.map((stack) => <li key={stack.id}><span>{materialDefinition(stack.materialId).name}</span><span>× {numberLabel(stack.quantity)}</span></li>)}</ul> : <p className="agent-replay__muted">没有随身物品。</p>}
          </>}
          <details className="agent-replay__original"><summary>查看原始事实与来源</summary>
            <p>月份保留原始值。{controlled || isSingle
              ? '人物固定在该帧记录的位置，不补绘帧间移动。'
              : '人物和动物沿快照内记录的当月轨迹播放，面板数值为该月终态。'}地形仅作显示转换，此页不会推进或保存世界。</p>
            <pre>{JSON.stringify({
              manifest: replay?.url ?? '本地单文件', snapshot: loaded?.current.source,
              kind: isSingle ? 'single-snapshot / unknown autonomy' : replay?.manifest.kind,
              frame, clock: state.clock, event: selectedEvent ?? null,
              person: person ? { id: person.id, body: person.body, position: person.position, inventory: person.inventory, conditions: person.conditions } : null,
              previousBody: previousPerson?.body ?? null,
            }, null, 2)}</pre>
          </details>
        </>}
      </aside>

      <footer className="agent-replay__controls">
        <button type="button" aria-label="上一帧" disabled={!replay || loading || framePosition === 0} onClick={() => goTo(framePosition - 1)}><ChevronLeft size={18} /></button>
        <button type="button" aria-label={playing ? '暂停' : '播放'} disabled={!replay || loading || replay.manifest.frames.length < 2} onClick={() => {
          if (!playing && replay && framePosition === replay.manifest.frames.length - 1) setFramePosition(0);
          setPlaying((value) => !value);
        }}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
        <button type="button" aria-label="下一帧" disabled={!replay || loading || framePosition >= replay.manifest.frames.length - 1} onClick={() => goTo(framePosition + 1)}><ChevronRight size={18} /></button>
        <input type="range" aria-label="回放帧" min={0} max={Math.max(0, (replay?.manifest.frames.length ?? 1) - 1)} value={framePosition} disabled={!replay || loading || isSingle} onChange={(event) => goTo(Number(event.target.value))} />
        <span>{replay ? `${framePosition + 1} / ${replay.manifest.frames.length}` : '0 / 0'} 帧</span>
      </footer>
    </main>
  );
}
