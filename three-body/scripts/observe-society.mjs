import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

// A real, isolated observation run through the production long-evolution use
// case. No fixture decisions, desired behaviour scores, or live-save writes.
const { values } = parseArgs({ options: {
  months: { type: 'string', default: '12' },
  seed: { type: 'string', default: '31' },
  output: { type: 'string' },
  resume: { type: 'string' },
  runtime: { type: 'string' },
  mode: { type: 'string', default: 'model' },
  endpoint: { type: 'string' },
} });
const months = Number(values.months);
const seed = Number(values.seed);
if (!Number.isSafeInteger(months) || months < 1 || !Number.isSafeInteger(seed)
  || !['model', 'local'].includes(values.mode)) throw new Error('Use --months <positive integer> --seed <integer> --mode model|local');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
const output = path.resolve(values.output ?? `data/experiments/society-${values.mode}-${seed}-${Date.now()}`);
if (existsSync(path.join(output, 'provenance.json'))) throw new Error('该目录已有试验记录，请使用新的输出目录以保留原始样本');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(tmpdir(), 'eland-observe-society-'));
try {
  const entry = `
    export { createInitialState } from './src/game/eland/simulation';
    export { checkpointFor, evolvePath } from './server/evolution-artifacts';
    export { executeLongEvolutionFromOwnedState } from './server/run-evolution-executor';
    export { resolveEvolutionDecisionRuntime } from './server/evolution-decision-runtime';
    export { resolveModelEndpoint } from './server/model-config';
    export { observeAgency } from './server/evolution-artifacts/agency-observation';
  `;
  const bundled = path.join(temporary, 'observe.mjs');
  const runtimeBundleSource = values.runtime ? path.resolve(values.runtime) : null;
  if (runtimeBundleSource) copyFileSync(runtimeBundleSource, bundled);
  else execFileSync(path.join(project, 'node_modules/.bin/esbuild'), [
      '--bundle', '--format=esm', '--platform=node', '--loader=ts',
      '--sourcefile=observe-entry.ts', `--outfile=${bundled}`, '--log-level=error',
    ], { input: entry, stdio: ['pipe', 'inherit', 'inherit'] });
  // Keep the exact executed code alongside its hash, including failed runs.
  copyFileSync(bundled, path.join(output, 'runtime.mjs'));
  const sourceBundleSha256 = createHash('sha256').update(readFileSync(bundled)).digest('hex');
  const api = await import(pathToFileURL(bundled).href);
  const endpoint = values.mode === 'model' ? api.resolveModelEndpoint('decision', values.endpoint) : undefined;
  const runtime = values.mode === 'local'
    ? { provider: 'local', model: 'rule-planner-v1' }
    : api.resolveEvolutionDecisionRuntime(endpoint.id);
  if (values.mode === 'model' && !runtime.decider) throw new Error('模型观察需要设置中启用模型演化');
  // This experiment pins the selected provider and records only request bodies
  // and response bodies, never authentication headers or endpoint secrets.
  const providerFetch = globalThis.fetch;
  let requestSequence = 0;
  if (endpoint) globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== endpoint.url) throw new Error('本次观察只允许调用选定的模型端点');
    const sequence = ++requestSequence;
    const startedAt = Date.now();
    const request = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    appendFileSync(path.join(output, 'provider-calls.jsonl'), `${JSON.stringify({
      sequence, phase: 'started', at: new Date(startedAt).toISOString(), endpointId: endpoint.id,
      model: request?.model, protocol: endpoint.protocol,
      messageChars: request?.messages?.reduce((total, message) => total + String(message.content ?? '').length, 0),
      request,
    })}\n`);
    try {
      const response = await providerFetch(input, init);
      const responseText = await response.clone().text();
      appendFileSync(path.join(output, 'provider-calls.jsonl'), `${JSON.stringify({
        sequence, phase: 'finished', elapsedMs: Date.now() - startedAt,
        status: response.status, response: responseText,
      })}\n`);
      return response;
    } catch (error) {
      appendFileSync(path.join(output, 'provider-calls.jsonl'), `${JSON.stringify({
        sequence, phase: 'failed', elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      throw error;
    }
  };
  let state = values.resume
    ? JSON.parse(readFileSync(path.resolve(values.resume), 'utf8'))
    : api.createInitialState(seed, { endpoint: { kind: 'months', value: months } });
  const fromMonth = state.clock.elapsedMonths;
  let resumeContinuity;
  if (values.resume) {
    const parentMetadataPath = path.join(path.dirname(path.resolve(values.resume)), 'provenance.json');
    let parentMetadata;
    if (existsSync(parentMetadataPath)) {
      try { parentMetadata = JSON.parse(readFileSync(parentMetadataPath, 'utf8')); } catch { /* Missing audit metadata does not alter the world. */ }
    }
    resumeContinuity = {
      stateSha256BeforeBoundaryExtension: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
      ...(typeof parentMetadata?.sourceBundleSha256 === 'string' ? {
        parentSourceBundleSha256: parentMetadata.sourceBundleSha256,
        sameSourceAsParent: parentMetadata.sourceBundleSha256 === sourceBundleSha256,
        sameProviderAsParent: parentMetadata.provider === runtime.provider && parentMetadata.model === runtime.model
          && parentMetadata.endpointId === endpoint?.id && parentMetadata.endpointUrl === endpoint?.url,
      } : {}),
    };
  }
  if (months <= fromMonth) throw new Error('--months must exceed the saved month');
  // The stopping date is an experiment boundary, never a character objective.
  if (state.civilization.status === 'ended') {
    if (state.civilization.outcome?.kind !== 'boundary') {
      throw new Error('此文明因真实结局结束，不能通过延长观察时间复活');
    }
    state.civilization.status = 'running';
    delete state.civilization.outcome;
  }
  state.civilization.conditions.endpoint = { kind: 'months', value: months };
  let evolution = api.evolvePath(state, {
    runId: path.basename(output), provider: runtime.provider, model: runtime.model,
    fromMonth, requestedEndMonth: months,
    checkpoint: api.checkpointFor(state, { inputTokens: 0, outputTokens: 0 }), status: 'running',
  });
  const saveJson = (name, value) => writeFileSync(path.join(output, name), JSON.stringify(value));
  saveJson('state.json', state);
  saveJson('provenance.json', {
    startedAt: new Date().toISOString(), seed: state.seed, fromMonth, requestedEndMonth: months,
    provider: runtime.provider, model: runtime.model,
    ...(endpoint ? { endpointId: endpoint.id, protocol: endpoint.protocol, endpointUrl: endpoint.url } : {}),
    sourceBundleSha256,
    runtimeBundleSource,
    initialStateSha256: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    resumedFrom: values.resume ? path.resolve(values.resume) : null,
    ...(resumeContinuity ? { resumeContinuity } : {}),
    note: 'Each segment uses one frozen source bundle. Parent hashes identify code/provider changes across resumed histories. Extending the observation boundary adds no materials or character choices. Completing a segment does not establish behavioural acceptance.',
  });
  const replay = { version: 'eland-experiment-replay-v1', kind: 'society',
    label: `文明观察：seed ${state.seed}`, frames: [{ index: fromMonth, atMonth: fromMonth,
      label: `第 ${fromMonth} 月`, stateFile: `month-${fromMonth}.json` }] };
  saveJson(`month-${fromMonth}.json`, state);
  saveJson('replay.json', replay);
  const store = {
    async load() { return { state: JSON.parse(readFileSync(path.join(output, 'state.json'), 'utf8')) }; },
    async save(_id, next) {
      state = next;
      saveJson('state.json', next);
      const month = next.clock.elapsedMonths;
      const stateFile = `month-${month}.json`;
      saveJson(stateFile, next);
      if (!replay.frames.some((frame) => frame.atMonth === month)) replay.frames.push({ index: month,
        atMonth: month, label: `第 ${month} 月`, stateFile });
      saveJson('replay.json', replay);
      const events = next.lastStep;
      const ledger = next.decisionBudget.ledgers.at(-1);
      const diagnostics = runtime.decider?.takeDiagnostics?.() ?? [];
      if (diagnostics.length) appendFileSync(path.join(output, 'model-diagnostics.jsonl'), `${JSON.stringify({
        month: next.clock.elapsedMonths, failures: diagnostics,
      })}\n`);
      process.stdout.write(`${JSON.stringify({
        month: next.clock.elapsedMonths, living: next.people.filter((p) => p.diedAtMonth === undefined && p.body.health > 0).length,
        modelContexts: ledger?.modelContexts, providerRequests: ledger?.providerRequests,
        mindDecisions: events.filter((event) => event.kind === 'decision' && event.usedModel && !event.planContinuation && event.decision.mentalAct).length,
        retainedIntentions: events.filter((event) => event.kind === 'decision' && event.usedModel
          && (event.decision.attention === 'keep-current' || event.decision.authoredAttempt?.intentionSourceDecisionEventId)).length,
        spokenRetentions: events.filter((event) => event.kind === 'decision' && event.usedModel
          && (event.decision.attention === 'keep-current' || event.decision.authoredAttempt?.intentionSourceDecisionEventId)
          && event.decision.declaration).length,
        directAttempts: events.filter((event) => event.kind === 'decision' && event.usedModel
          && event.decision.authoredAttempt?.kind === 'native').length,
        creativeAttempts: events.filter((event) => event.kind === 'decision' && event.usedModel
          && event.decision.authoredAttempt?.kind === 'creative').length,
        planContinuations: events.filter((event) => event.kind === 'decision' && event.usedModel
          && event.planContinuation && !event.decision.authoredAttempt).length,
        modelFailures: diagnostics.length,
        uncompiledAttempts: events.filter((event) => event.kind === 'decision'
          && (event.decision.compilationFailure || event.executionCompilation?.status === 'unresolved')).length,
        actions: events.filter((e) => e.kind === 'action').reduce((counts, e) => {
          counts[e.status] = (counts[e.status] ?? 0) + 1; return counts;
        }, {}), works: next.world.works?.length ?? 0, projects: next.projects.length,
      })}\n`);
    },
    async saveEvolutionPath(_id, next) { evolution = next; saveJson('evolution.json', next); },
    async saveEvolutionReport(_id, report) { saveJson('report.json', report); },
  };
  await api.executeLongEvolutionFromOwnedState(store, evolution.runId, months, evolution, state, runtime);
  const events = state.world.past.filter((event) => event.atMonth > fromMonth);
  saveJson('agency-observation.json', api.observeAgency(state));
  saveJson('behaviour.json', {
    provider: runtime.provider, model: runtime.model, fromMonth, throughMonth: state.clock.elapsedMonths,
    people: state.people.map((person) => ({
      id: person.id, name: person.name, alive: person.diedAtMonth === undefined && person.body.health > 0,
      generation: person.generation, parents: person.geneticParents,
      relations: person.relations, knowledge: person.knowledge,
    })),
    works: state.world.works, agreements: state.agreements, collectives: state.collectives,
    decisions: events.filter((event) => event.kind === 'decision'),
    actions: events.filter((event) => event.kind === 'action').map((event) => ({
      id: event.id, atMonth: event.atMonth, who: event.who, status: event.status,
      cause: event.cause,
      ...(event.intentId ? { intentId: event.intentId } : {}),
      ...(event.decisionSource ? { decisionSource: event.decisionSource } : {}),
      action: event.action, result: event.result, diff: event.diff,
    })),
  });
  process.stdout.write(`${JSON.stringify({ status: evolution.status, output, failure: evolution.failure })}\n`);
  if (evolution.status === 'failed') process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
