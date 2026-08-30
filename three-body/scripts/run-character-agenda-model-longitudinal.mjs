import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-agenda-model-longitudinal-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const deciderBundlePath = path.join(temporaryDirectory, 'backend-decider.mjs');

function bundle(source, output) {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    source, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });
}

function countBy(values, key) {
  return values.reduce((counts, value) => {
    const label = String(key(value));
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
}

try {
  bundle('src/game/eland/simulation.ts', simulationBundlePath);
  bundle('server/backend-decider.ts', deciderBundlePath);
  const nonce = Date.now();
  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?longitudinal=${nonce}`);
  const backend = await import(`${pathToFileURL(deciderBundlePath).href}?longitudinal=${nonce}`);

  process.env.MODEL_CHARACTER_AGENDA_MODE = 'proposal-v1';
  process.env.MODEL_DECISION_CONTEXT_MODE = 'compact';
  process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS = '900';

  const seed = Number(process.env.EXPERIMENT_SEED) || 20260830;
  const months = Math.max(6, Math.min(1_200, Number(process.env.EXPERIMENT_MONTHS) || 12));
  const endpointId = process.env.EXPERIMENT_ENDPOINT || 'deepseek-v4-flash';
  const explicitOutputPath = process.env.EXPERIMENT_OUTPUT
    ? path.resolve(process.env.EXPERIMENT_OUTPUT)
    : null;
  let state = simulation.createInitialState(seed, {
    endpoint: { kind: 'months', value: months },
    chaosIntensity: 0,
  });
  const monthly = [];
  const agendaEvidenceTimeline = [];
  const totalUsage = {
    providerRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    chargedTokens: 0,
  };

  while (state.civilization.status === 'running' && state.clock.elapsedMonths < months) {
    const startedAt = performance.now();
    state = await simulation.stepSimulationAsync(state, backend.createServerLlmDecider(endpointId));
    const decisions = state.lastStep.filter((event) => event.kind === 'decision');
    const agendaEvidence = decisions.flatMap((event) => (event.characterAgendaEvidence ?? []).map((evidence) => ({
      ...evidence,
      atMonth: event.atMonth,
      personId: event.who,
      usedModel: event.usedModel,
    })));
    agendaEvidenceTimeline.push(...agendaEvidence);
    const modelAgendaEvidence = agendaEvidence.filter((evidence) => evidence.source === 'model-proposal');
    const ledger = state.decisionBudget.ledgers.at(-1);
    totalUsage.providerRequests += ledger?.providerRequests ?? 0;
    totalUsage.inputTokens += ledger?.inputTokens ?? 0;
    totalUsage.outputTokens += ledger?.outputTokens ?? 0;
    totalUsage.cacheHitInputTokens += ledger?.cacheHitInputTokens ?? 0;
    totalUsage.cacheMissInputTokens += ledger?.cacheMissInputTokens ?? 0;
    totalUsage.chargedTokens += ledger?.chargedTokens ?? 0;
    const actions = state.lastStep.filter((event) => event.kind === 'action');
    const projectFacts = state.lastStep.filter((event) => event.kind === 'project');
    const livingPeople = state.people.filter((person) => (
      person.diedAtMonth === undefined && person.body.health > 0
    )).length;
    monthly.push({
      month: state.clock.elapsedMonths,
      latencyMs: Math.round(performance.now() - startedAt),
      currentEra: state.civilization.development?.currentEra ?? 'primitive-tribe',
      historicalPeakEra: state.civilization.development?.historicalPeakEra ?? 'primitive-tribe',
      missingEraGateIds: state.civilization.development?.missingGateIds ?? [],
      livingPeople,
      modelContexts: ledger?.modelContexts ?? 0,
      providerRequests: ledger?.providerRequests ?? 0,
      usedModelDecisions: decisions.filter((event) => event.usedModel).length,
      usedModelSocialDecisions: decisions.filter((event) => event.usedModel && event.domain === 'social').length,
      communicationActions: actions.filter((event) => event.action.kind === 'communicate').length,
      nonCommunicationActions: actions.filter((event) => event.action.kind !== 'communicate').length,
      projectFacts: projectFacts.length,
      agendaEvidence: agendaEvidence.length,
      modelAgendaEvidence: modelAgendaEvidence.length,
      modelAgendaEvidenceOutcomes: countBy(modelAgendaEvidence, (evidence) => evidence.outcome),
      modelAgendaCompilerDispositions: countBy(modelAgendaEvidence, (evidence) => evidence.compilerDisposition),
      agendaEvidenceOutcomes: countBy(agendaEvidence, (evidence) => evidence.outcome),
      agendaCompilerDispositions: countBy(agendaEvidence, (evidence) => evidence.compilerDisposition),
      agendaItems: state.people.reduce((sum, person) => sum + (person.characterAgenda?.items.length ?? 0), 0),
      usage: {
        inputTokens: ledger?.inputTokens ?? 0,
        outputTokens: ledger?.outputTokens ?? 0,
        cacheHitInputTokens: ledger?.cacheHitInputTokens ?? 0,
        cacheMissInputTokens: ledger?.cacheMissInputTokens ?? 0,
      },
    });
    if (state.clock.elapsedMonths % 12 === 0 || state.clock.elapsedMonths === months) {
      process.stderr.write([
        `model-longitudinal seed=${seed}`,
        `month=${state.clock.elapsedMonths}/${months}`,
        `era=${state.civilization.development?.currentEra ?? 'primitive-tribe'}`,
        `living=${livingPeople}`,
        `calls=${totalUsage.providerRequests}`,
      ].join(' ') + '\n');
    }
  }

  const eventsById = new Map(state.world.past.map((event) => [event.id, event]));
  const intentsById = new Map(state.intents.map((intent) => [intent.id, intent]));
  const agendaItems = state.people.flatMap((person) => (person.characterAgenda?.items ?? [])
    .map((item) => ({ personId: person.id, personName: person.name, item })));
  const histories = agendaItems.map(({ personId, personName, item }) => {
    const intents = item.intentIds.map((id) => intentsById.get(id)).filter(Boolean);
    const intentMonths = intents.map((intent) => intent.createdAtMonth);
    const firstIntentMonth = intentMonths.length ? Math.min(...intentMonths) : null;
    const lastIntentMonth = intentMonths.length ? Math.max(...intentMonths) : null;
    const evaluations = item.approaches.flatMap((approach) => approach.evaluations.map((evaluation) => ({
      approachId: approach.id,
      approachSummary: approach.summary,
      ...evaluation,
      evidenceResolved: evaluation.evidenceFactIds.every((id) => eventsById.has(id)),
    })));
    const failedEvaluations = evaluations
      .filter((evaluation) => evaluation.outcome === 'blocked' || evaluation.outcome === 'refuted');
    const laterDifferentApproachIntent = item.approaches.some((approach) => approach.attemptIntentIds.some((id) => {
      const intent = intentsById.get(id);
      return intent && failedEvaluations.some((failure) => (
        approach.id !== failure.approachId && intent.createdAtMonth > failure.atMonth
      ));
    }));
    const modelEvidence = agendaEvidenceTimeline.filter((evidence) => (
      evidence.source === 'model-proposal'
      && evidence.personId === personId
      && evidence.agendaItemId === item.id
    ));
    const modelRevisionAfterFailure = modelEvidence.some((evidence) => evidence.approachId
      && failedEvaluations.some((failure) => (
        evidence.approachId !== failure.approachId && evidence.atMonth > failure.atMonth
      )));
    const executableModelRevisionAfterFailure = modelEvidence.some((evidence) => evidence.approachId
      && evidence.compilerDisposition !== 'deferred-missing-affordance'
      && evidence.compilerDisposition !== 'rejected-authority-claim'
      && failedEvaluations.some((failure) => (
        evidence.approachId !== failure.approachId && evidence.atMonth > failure.atMonth
      )));
    const executedModelRevisionAfterFailure = modelEvidence.some((evidence) => evidence.approachId
      && evidence.compilerDisposition !== 'deferred-missing-affordance'
      && evidence.compilerDisposition !== 'rejected-authority-claim'
      && item.approaches.some((approach) => approach.id === evidence.approachId
        && approach.attemptIntentIds.some((id) => (intentsById.get(id)?.createdAtMonth ?? -1) >= evidence.atMonth))
      && failedEvaluations.some((failure) => (
        evidence.approachId !== failure.approachId && evidence.atMonth > failure.atMonth
      )));
    return {
      id: item.id,
      personId,
      personName,
      aim: item.aim,
      status: item.status,
      origin: item.origin,
      createdAtMonth: item.createdAtMonth,
      lastReviewedAtMonth: item.lastReviewedAtMonth,
      horizonMonths: item.horizonMonths,
      targetAtMonth: item.targetAtMonth,
      sourceFactIds: item.sourceFactIds,
      sourceFacts: item.sourceFactIds.slice(-12).flatMap((sourceFactId) => {
        const event = eventsById.get(sourceFactId);
        if (!event) return [{ id: sourceFactId, missing: true }];
        return [{
          id: event.id,
          atMonth: event.atMonth,
          kind: event.kind,
          summary: 'result' in event && typeof event.result === 'string'
            ? event.result
            : 'summary' in event && typeof event.summary === 'string'
              ? event.summary
              : undefined,
        }];
      }),
      approachCount: item.approaches.length,
      approaches: item.approaches.map((approach) => ({
        id: approach.id,
        summary: approach.summary,
        disposition: approach.disposition,
        probe: approach.probe,
        attemptIntentIds: approach.attemptIntentIds,
        latestOutcome: approach.latestOutcome,
      })),
      intentCount: intents.length,
      firstIntentMonth,
      lastIntentMonth,
      intentSpanMonths: firstIntentMonth === null || lastIntentMonth === null ? 0 : lastIntentMonth - firstIntentMonth,
      evaluations,
      laterDifferentApproachIntent,
      modelEvidenceCount: modelEvidence.length,
      modelEvidenceOutcomes: countBy(modelEvidence, (evidence) => evidence.outcome),
      modelCompilerDispositions: countBy(modelEvidence, (evidence) => evidence.compilerDisposition),
      modelRevisionAfterFailure,
      executableModelRevisionAfterFailure,
      executedModelRevisionAfterFailure,
    };
  });

  const allActions = state.world.past.filter((event) => event.kind === 'action');
  const allDecisions = state.world.past.filter((event) => event.kind === 'decision');
  const communicationActions = allActions.filter((event) => event.action.kind === 'communicate');
  const nonCommunicationActions = allActions.filter((event) => event.action.kind !== 'communicate');
  const development = state.civilization.development;

  const artifact = {
    experiment: 'character-agenda-real-model-longitudinal-v1',
    generatedAt: new Date().toISOString(),
    seed,
    months,
    endpointId,
    elapsedMonths: state.clock.elapsedMonths,
    civilizationStatus: state.civilization.status,
    development: development ? {
      observerVersion: development.observerVersion,
      currentEra: development.currentEra,
      historicalPeakEra: development.historicalPeakEra,
      candidateEra: development.candidateEra,
      satisfiedGateIds: development.satisfiedGateIds,
      missingGateIds: development.missingGateIds,
      materialCapabilities: development.materialCapabilities.map((capability) => ({
        key: capability.key,
        stage: capability.stage,
        successfulBatchCount: capability.successfulBatchEventIds.length,
        producerCount: capability.producerIds.length,
        productionSiteCount: capability.productionSiteMaterialIds.length,
        institutionCount: capability.supportingInstitutionKeys.length,
      })),
    } : null,
    livingPeople: state.people.filter((person) => (
      person.diedAtMonth === undefined && person.body.health > 0
    )).length,
    totalPeople: state.people.length,
    projectStatusCounts: countBy(state.projects, (project) => project.status),
    communicationActions: communicationActions.length,
    nonCommunicationActions: nonCommunicationActions.length,
    communicationActionShare: allActions.length ? communicationActions.length / allActions.length : 0,
    totalDecisions: allDecisions.length,
    totalModelDecisions: allDecisions.filter((event) => event.usedModel).length,
    totalModelSocialDecisions: allDecisions.filter((event) => event.usedModel && event.domain === 'social').length,
    totalUsage,
    totalModelContexts: monthly.reduce((sum, item) => sum + item.modelContexts, 0),
    totalUsedModelDecisions: monthly.reduce((sum, item) => sum + item.usedModelDecisions, 0),
    totalAgendaEvidence: monthly.reduce((sum, item) => sum + item.agendaEvidence, 0),
    totalModelAgendaEvidence: monthly.reduce((sum, item) => sum + item.modelAgendaEvidence, 0),
    agendaItems: histories.length,
    agendaSpanningSixMonths: histories.filter((item) => item.intentSpanMonths >= 6).length,
    agendasWithMultipleApproaches: histories.filter((item) => item.approachCount > 1).length,
    agendasTryingAnotherApproachAfterFailure: histories.filter((item) => item.laterDifferentApproachIntent).length,
    modelTouchedAgendas: histories.filter((item) => item.modelEvidenceCount > 0).length,
    agendasWithModelRevisionAfterFailure: histories.filter((item) => item.modelRevisionAfterFailure).length,
    agendasWithExecutableModelRevisionAfterFailure: histories
      .filter((item) => item.executableModelRevisionAfterFailure).length,
    agendasWithExecutedModelRevisionAfterFailure: histories
      .filter((item) => item.executedModelRevisionAfterFailure).length,
    unresolvedEvaluationEvidence: histories.flatMap((item) => item.evaluations).filter((item) => !item.evidenceResolved).length,
    agendaEvidenceTimeline,
    monthly,
    histories,
  };
  const artifactDirectory = explicitOutputPath
    ? path.dirname(explicitOutputPath)
    : path.resolve('data/experiments');
  mkdirSync(artifactDirectory, { recursive: true });
  const artifactPath = explicitOutputPath ?? path.join(
    artifactDirectory,
    `character-agenda-model-longitudinal-${artifact.generatedAt.replace(/[:.]/gu, '-')}.json`,
  );
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ artifactPath, ...artifact }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
