import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Controlled capability probes, never autonomous-society acceptance runs.
const { values } = parseArgs({ options: {
  batch: { type: 'string' }, output: { type: 'string' }, scene: { type: 'string', default: 'cycle' },
  steps: { type: 'string', default: '4' },
  participants: { type: 'string', default: 'actor' },
  context: { type: 'string' },
  runtime: { type: 'string' },
} });
if (!values.batch || !values.output || !['cycle', 'roles', 'meal'].includes(values.scene)) throw new Error('Use --batch <directory> --output <new directory> --scene cycle|roles|meal');
if (!['actor', 'both'].includes(values.participants)) throw new Error('--participants must be actor or both');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
const batch = path.resolve(values.batch), output = path.resolve(values.output);
const steps = Number(values.steps);
if (!Number.isSafeInteger(steps) || steps <= 0) throw new Error('Observation rounds must be a positive integer');
if (existsSync(output)) throw new Error('Keep prior evidence: choose a new output directory');
mkdirSync(batch, { recursive: true }); mkdirSync(output, { recursive: true });
const save = (name, data) => writeFileSync(path.join(output, name), JSON.stringify(data, null, 2));
const harness = readFileSync(fileURLToPath(import.meta.url));
writeFileSync(path.join(output, 'harness.mjs'), harness);
// Historical batch.json files are immutable records of earlier bounded runs.
// Current experiments retain accounting without inheriting their stop gates.
const seriesFile = path.join(batch, 'series.json');
const series = existsSync(seriesFile) ? JSON.parse(readFileSync(seriesFile, 'utf8')) : {
  startedAt: new Date().toISOString(), sent: 0, developmentFixtures: true,
};
const saveSeries = () => writeFileSync(seriesFile, JSON.stringify(series, null, 2));
saveSeries();
const runtime = path.join(output, 'runtime.mjs');
if (values.runtime) copyFileSync(path.resolve(values.runtime), runtime);
else execFileSync(path.join(project, 'node_modules/.bin/esbuild'), [
  '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=material-probe.ts',
  `--outfile=${runtime}`, '--log-level=error',
], { input: `export { createInitialState } from './src/game/eland/simulation';
  export { buildCurrentMonthDecisionContext } from './src/game/eland/application/simulation/tick-planner';
  export { commitDecision, executeActiveIntent } from './src/game/eland/application/simulation/intent-execution';
  export { appendCommittedEvents } from './src/game/eland/domain/history';
  export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
  export { handleDecide } from './server/model-decision-gateway';
  export { resolveModelEndpoint } from './server/model-config';
  export { Material } from './src/game/eland/domain/material';
  export { cellId, setVoxel } from './src/game/eland/world/grid';`, stdio: ['pipe', 'inherit', 'inherit'] });
const api = await import(pathToFileURL(runtime).href);
const endpoint = api.resolveModelEndpoint('decision', 'lan-qwen');
if (endpoint.model !== 'qwen3.5:4b') throw new Error('This batch is pinned to qwen3.5:4b');
const providerFetch = globalThis.fetch;
let sent = 0, currentTurn = 0, currentActorId;
const log = (data) => appendFileSync(path.join(output, 'provider-calls.jsonl'), `${JSON.stringify(data)}\n`);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const request = JSON.parse(init.body);
  if (url !== endpoint.url || request.model !== endpoint.model) throw new Error('Unexpected model endpoint');
  const sequence = ++series.sent; sent++; saveSeries();
  const start = Date.now();
  log({ sequence, turn: currentTurn, actorId: currentActorId, phase: 'started', at: new Date(start).toISOString(), request });
  try {
    const response = await providerFetch(input, init);
    log({ sequence, turn: currentTurn, phase: 'finished', elapsedMs: Date.now() - start,
      status: response.status, response: await response.clone().text() });
    return response;
  } catch (error) {
    log({ sequence, turn: currentTurn, phase: 'failed', elapsedMs: Date.now() - start, error: error.message });
    throw error;
  }
};

if (values.context) {
  const source = path.resolve(values.context);
  const context = JSON.parse(readFileSync(source, 'utf8'));
  currentTurn = 1; currentActorId = context.person.id;
  save('input-context.json', context);
  save('provenance.json', { startedAt: new Date().toISOString(), mode: 'recorded-context-replay',
    source, sourceContextSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    harnessSha256: createHash('sha256').update(harness).digest('hex'),
    sourceBundleSha256: createHash('sha256').update(readFileSync(runtime)).digest('hex'),
    endpointId: endpoint.id, model: endpoint.model, protocol: endpoint.protocol,
    note: 'Same recorded situation, current interface and model. This probe assesses interpretation only; it does not execute a new history or establish autonomous behavior.' });
  try {
    const result = await api.handleDecide({ contexts: [context] }, endpoint.id);
    save('gateway.json', result);
    console.log(JSON.stringify({ sent, decisions: result.body.decisions, failures: result.body.failures }));
  } finally {
    globalThis.fetch = providerFetch;
    save('completion.json', { endedAt: new Date().toISOString(), status: 'completed',
      executed: false, sent, totalSeriesSent: series.sent });
  }
} else {
const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
const actor = state.people[0], partner = state.people[1];
for (let x = 7; x <= 19; x++) for (let y = 7; y <= 19; y++) {
  for (let z = 0; z < state.world.grid.levels; z++) api.setVoxel(state.world.grid, x, y, z,
    z === 0 ? api.Material.Stone : api.Material.Air);
}
actor.position = { ...actor.position, cellId: api.cellId(12, 12), z: 1 };
partner.position = { ...partner.position, cellId: api.cellId(13, 12), z: 1 };
actor.inventory = [{ id: 'fixture-wood', materialId: api.Material.Wood, quantity: 2, sourceEventIds: ['fixture-material-source'] }];
partner.inventory = [];
actor.knowledge = []; actor.memories = []; actor.conditions = [];
actor.body = { ...actor.body, health: 100, hydration: 100, nutrition: 100 };
state.world.drops = []; state.world.animals = [];
state.civilization.climate = { ...state.civilization.climate, kind: 'temperate', severity: 0 };
state.civilization.weather = { ...state.civilization.weather, kind: 'clear', intensity: 0 };
const goal = values.scene === 'cycle'
  ? '利用我现有的材料，让自己能站得更高；亲自站上去检查，之后取回还能使用的材料。'
  : values.scene === 'meal' ? '把手里的生肉处理成适宜食用的食物，并让饥饿的同伴吃到。'
  : `我想请${partner.name}去取眼前的木材，自己留在这里观察${partner.name}和材料的变化。对方还没有答应或开始。`;
if (values.scene === 'meal') {
  actor.inventory = [{ id: 'fixture-raw-meat', materialId: api.Material.RawMeat, quantity: 2,
    sourceEventIds: ['fixture-food-source'] }];
  partner.body.nutrition = 24;
  api.setVoxel(state.world.grid, 12, 13, 1, api.Material.Fire);
}
if (values.scene === 'roles') {
  actor.inventory = [];
  state.world.drops.push({ id: 'fixture-ground-wood', materialId: api.Material.Wood, quantity: 2,
    cellId: api.cellId(14, 12), z: 1, createdAtMonth: 0, sourceEventIds: ['fixture-material-source'] });
}
save('initial-state.json', state);
save('provenance.json', { startedAt: new Date().toISOString(), scene: values.scene,
  developmentFixture: true, goal, observationRounds: steps, participants: values.participants,
  decisionOrder: values.participants === 'both' ? [actor.id, partner.id] : [actor.id],
  harnessSha256: createHash('sha256').update(harness).digest('hex'),
  sourceBundleSha256: createHash('sha256').update(readFileSync(runtime)).digest('hex'),
  initialStateSha256: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
  model: endpoint.model, endpointId: endpoint.id, protocol: endpoint.protocol,
  note: 'Initial bodies/materials and a first-turn concern are specified development inputs. No fixture Decision claims model authorship. Later choices, declarations and physical outcomes use production code. This is not an autonomous society run.' });
const turns = [];
const events = [];
const participants = values.participants === 'both' ? [actor, partner] : [actor];
const replay = { version: 'eland-experiment-replay-v1', kind: 'controlled',
  label: `受控能力场景：${values.scene}`, frames: [] };
const captureFrame = (index, label) => {
  const snapshot = structuredClone(state);
  api.appendCommittedEvents(snapshot, events);
  const stateFile = `frame-${index}.json`;
  save(stateFile, snapshot);
  replay.frames.push({ index, atMonth: 1, label, stateFile });
  save('replay.json', replay);
};
captureFrame(0, '初始状态');
let tick = 0;
let stopReason = 'step-limit';
try {
  for (let turn = 1; turn <= steps * participants.length; turn++) {
    currentTurn = turn;
    const person = participants[(turn - 1) % participants.length];
    currentActorId = person.id;
    const firstEvent = events.length;
    if (person.activeIntentId) {
      for (let bodyTick = 0; bodyTick < 12 && person.activeIntentId; bodyTick++) {
        const action = api.executeActiveIntent(state, person, 1, events.length, ++tick, events);
        if (!action) break;
        events.push(action);
        if (['blocked', 'failed'].includes(action.status)) break;
      }
      if (person.activeIntentId) {
        turns.push({ turn, actorId: person.id, sent, bodyContinuation: true, events: events.slice(firstEvent) });
        state.lastStep = [...events]; save('state.json', state); save('turns.json', turns);
        captureFrame(turn, `${person.name}继续既有工作`);
        continue; // Keep real work; the other participant still gets a turn.
      }
    }
    const context = api.buildCurrentMonthDecisionContext(state, person, 1, ++tick, events);
    const request = api.buildDecisionRequestContext(context);
    if (turn === 1) request.person.mindMarkdown = `# 当前关切\n- ${goal}\n${request.person.mindMarkdown ?? ''}`;
    save(`turn-${turn}-context.json`, request);
    const response = await api.handleDecide({ contexts: [request] }, endpoint.id);
    save(`turn-${turn}-gateway.json`, response);
    const choice = response.body.decisions?.[0];
    const record = { turn, actorId: person.id, sent, failures: response.body.failures, choice, events: [] };
    turns.push(record);
    if (choice) {
      const decision = api.commitDecision(state, person, context, choice, true, 1, events, tick);
      record.executionCompilation = decision.executionCompilation;
      for (let bodyTick = 0; bodyTick < 12 && person.activeIntentId; bodyTick++) {
        const action = api.executeActiveIntent(state, person, 1, events.length, ++tick, events);
        if (!action) break;
        events.push(action);
        if (['blocked', 'failed'].includes(action.status)) break;
      }
      record.events = events.slice(firstEvent);
      state.lastStep = [...events];
    }
    save('state.json', state); save('turns.json', turns);
    captureFrame(turn, `${person.name}的本次选择与结果`);
    console.log(JSON.stringify({ turn, actor: person.name, sent, newGoal: choice?.mentalAct?.goal,
      attempt: choice?.authoredAttempt?.kind, native: choice?.nativeOperation?.kind,
      failures: response.body.failures, compile: record.executionCompilation?.status,
      actions: record.events.filter((event) => event.kind === 'action').map((event) => ({ kind: event.action.kind,
        status: event.status, result: event.result })), works: state.world.works?.length ?? 0 }));
    if (person.activeIntentId && participants.length === 1) { stopReason = 'body-work-paused'; break; }
  }
} finally {
  globalThis.fetch = providerFetch;
  if (new Set(events.map((event) => event.id)).size !== events.length) throw new Error('Probe event IDs must remain unique across turns');
  api.appendCommittedEvents(state, events);
  if (stopReason === 'step-limit' && participants.some((person) => person.activeIntentId)) stopReason = 'body-work-paused';
  save('state.json', state); save('turns.json', turns);
  save('completion.json', { endedAt: new Date().toISOString(), sent, totalSeriesSent: series.sent,
    status: stopReason === 'step-limit' ? 'completed' : stopReason,
    unfinishedIntentIds: participants.flatMap((person) => person.activeIntentId ? [person.activeIntentId] : []), turns: turns.length,
    note: 'Terminal probe status is not task/goal success.' });
}
}
