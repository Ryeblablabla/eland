import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-character-agenda-model-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const contextBundlePath = path.join(temporaryDirectory, 'decision-context.mjs');
const gatewayBundlePath = path.join(temporaryDirectory, 'decision-gateway.mjs');
const applicationBundlePath = path.join(temporaryDirectory, 'agenda-application.mjs');

function bundle(source, output) {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    source, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });
}

function personalityScore(request, keys) {
  return keys.reduce((sum, key) => sum + Number(request.person.personality[key] ?? 50), 0) / keys.length;
}

function selectDistinctPersonas(items) {
  const remaining = [...items];
  const take = (score, direction = 'desc') => {
    remaining.sort((left, right) => direction === 'desc'
      ? score(right) - score(left) || left.request.person.id.localeCompare(right.request.person.id)
      : score(left) - score(right) || left.request.person.id.localeCompare(right.request.person.id));
    return remaining.shift();
  };
  return [
    { label: 'open-explorer', item: take((item) => personalityScore(item.request, ['openness'])) },
    { label: 'care-oriented', item: take((item) => personalityScore(item.request, ['emotionality', 'agreeableness'])) },
    { label: 'cautious-pragmatist', item: take((item) => personalityScore(item.request, ['openness']), 'asc') },
  ].filter((entry) => entry.item);
}

function probeKind(proposal) {
  return proposal?.approach?.probe?.kind ?? null;
}

function selectedActionKind(source, decision) {
  if (!decision || (decision.kind !== 'start' && decision.kind !== 'revise')) return null;
  const selected = source.options.find((option) => option.id === decision.optionId);
  if (!selected) return null;
  return selected.nextAction.kind === 'act' ? selected.nextAction.operation : selected.nextAction.kind;
}

try {
  bundle('src/game/eland/simulation.ts', simulationBundlePath);
  bundle('src/game/eland/application/model-decision/index.ts', contextBundlePath);
  bundle('server/model-decision-gateway.ts', gatewayBundlePath);
  bundle('src/game/eland/application/character-agenda.ts', applicationBundlePath);

  const nonce = Date.now();
  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?experiment=${nonce}`);
  const projection = await import(`${pathToFileURL(contextBundlePath).href}?experiment=${nonce}`);
  const gateway = await import(`${pathToFileURL(gatewayBundlePath).href}?experiment=${nonce}`);
  const agenda = await import(`${pathToFileURL(applicationBundlePath).href}?experiment=${nonce}`);

  const targetMonth = Math.max(1, Math.min(24, Number(process.env.EXPERIMENT_MONTH) || 1));
  let state = simulation.createInitialState(20260830, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  while (state.clock.elapsedMonths < targetMonth - 1 && state.civilization.status === 'running') {
    state = simulation.stepSimulation(state);
  }
  const materialOnly = process.env.EXPERIMENT_MATERIAL_ONLY === '1';
  const materialPurposes = new Set(['inquiry', 'resource', 'production', 'project', 'safety']);
  const candidates = simulation.buildDecisionContexts(state, state.clock.elapsedMonths + 1)
    .map((context) => materialOnly ? {
      ...context,
      options: context.options.filter((option) => materialPurposes.has(option.semantics?.purpose)),
    } : context)
    .filter((context) => context.options.length > 0)
    .map((source) => ({ source, request: projection.buildDecisionRequestContext(source) }));
  const requestedSamples = Math.max(1, Math.min(3, Number(process.env.EXPERIMENT_CONTEXT_LIMIT) || 3));
  const selected = selectDistinctPersonas(candidates).slice(0, requestedSamples);
  if (selected.length < requestedSamples) throw new Error(`只找到 ${selected.length} 个可比较人物上下文`);

  process.env.MODEL_CHARACTER_AGENDA_MODE = 'proposal-v1';
  process.env.MODEL_DECISION_CONTEXT_MODE = 'compact';
  process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS = '900';
  const startedAt = performance.now();
  const response = await gateway.handleDecide({ contexts: selected.map((entry) => entry.item.request) }, 'deepseek-v4-flash');
  const latencyMs = Math.round(performance.now() - startedAt);
  if (response.status !== 200) throw new Error(`模型试验失败 ${response.status}: ${JSON.stringify(response.body)}`);
  const body = response.body;
  const decisions = Array.isArray(body.decisions) ? body.decisions : [];

  const samples = selected.map((entry, index) => {
    const { source, request } = entry.item;
    const decision = decisions[index] ?? null;
    const chosen = decision && (decision.kind === 'start' || decision.kind === 'revise')
      ? source.options.find((option) => option.id === decision.optionId)
      : undefined;
    const compiled = decision?.characterAgendaProposal
      ? agenda.compileCharacterAgendaProposal(source, decision.characterAgendaProposal, chosen)
      : null;
    const proposedProbeKind = probeKind(decision?.characterAgendaProposal);
    const chosenActionKind = selectedActionKind(source, decision);
    return {
      persona: entry.label,
      person: {
        id: source.person.id,
        name: source.person.name,
        personality: request.person.personality,
        body: request.person.body,
      },
      legalOptionCount: source.options.length,
      legalOptions: source.options.slice(0, 8).map(({ id, summary }) => ({ id, summary })),
      decision,
      localCompiler: compiled ? {
        disposition: compiled.compilerDisposition,
        groundedProbe: compiled.groundedProbe,
      } : null,
      novelty: {
        proposedProbeKind,
        chosenActionKind,
        differsFromChosenImmediateAction: Boolean(proposedProbeKind && proposedProbeKind !== chosenActionKind),
      },
    };
  });

  const artifact = {
    experiment: 'character-agenda-real-model-preliminary-v1',
    generatedAt: new Date().toISOString(),
    seed: state.seed,
    sourceMonth: state.clock.elapsedMonths + 1,
    materialOnlyShadow: materialOnly,
    endpointId: body.endpointId,
    protocol: body.protocol,
    model: body.model,
    latencyMs,
    total: body.total,
    decided: body.decided,
    usage: body.usage,
    proposalCount: samples.filter((sample) => sample.decision?.characterAgendaProposal).length,
    groundedProposalCount: samples.filter((sample) => sample.localCompiler?.groundedProbe).length,
    novelProbeCount: samples.filter((sample) => sample.novelty.differsFromChosenImmediateAction).length,
    samples,
  };
  const artifactDirectory = path.resolve('data/experiments');
  mkdirSync(artifactDirectory, { recursive: true });
  const artifactPath = path.join(
    artifactDirectory,
    `character-agenda-model-${artifact.generatedAt.replace(/[:.]/gu, '-')}.json`,
  );
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ artifactPath, ...artifact }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
