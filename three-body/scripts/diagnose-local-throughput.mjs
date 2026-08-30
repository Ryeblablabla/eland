import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-local-throughput-'));
const baselineRoot = path.join(temporaryDirectory, 'baseline');
const archivePath = path.join(temporaryDirectory, 'baseline.tar');
const baselineBundlePath = path.join(temporaryDirectory, 'baseline.mjs');
const candidateBundlePath = path.join(temporaryDirectory, 'candidate.mjs');
const seed = Number(process.env.EXPERIMENT_SEED) || 20260815;
const months = Math.max(1, Math.min(120, Number(process.env.EXPERIMENT_MONTHS) || 24));
const currentOnly = process.env.EXPERIMENT_CURRENT_ONLY === '1';

function bundle(source, output) {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    source, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });
}

function countBy(items, key) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const value = String(key(item));
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function topCounts(items, key, limit = 16) {
  return Object.entries(countBy(items, key))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function summarize(state) {
  const events = state.world.past;
  const actions = events.filter((event) => event.kind === 'action');
  const decisions = events.filter((event) => event.kind === 'decision');
  const survivalActions = actions.filter((event) => event.cause === 'survival-reflex');
  const actionById = new Map(actions.map((event) => [event.id, event]));
  const terminalIntents = state.intents.filter((intent) => (
    intent.status === 'completed' || intent.status === 'blocked'
      || intent.status === 'failed' || intent.status === 'abandoned'
  ));
  const zeroActionTerminalIntents = terminalIntents.filter((intent) => intent.actionEventIds.length === 0);
  const survivalInterruptionIntents = state.intents.filter((intent) => intent.interruptionKind === 'survival-reflex');
  const survivalInterruptionActions = survivalInterruptionIntents.flatMap((intent) => (
    intent.actionEventIds.map((eventId) => actionById.get(eventId)).filter(Boolean)
  ));
  const actionPersonMonths = new Set(actions.map((event) => `${event.atMonth}:${event.who}`));
  const livingPersonMonths = Array.from({ length: state.clock.elapsedMonths }, (_, index) => index + 1)
    .reduce((sum, month) => sum + state.people.filter((person) => (
      person.bornAtMonth < month
      && (person.diedAtMonth === undefined || person.diedAtMonth >= month)
    )).length, 0);
  return {
    elapsedMonths: state.clock.elapsedMonths,
    livingPeople: state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0).length,
    peopleTotal: state.people.length,
    livingPersonMonths,
    actionPersonMonths: actionPersonMonths.size,
    actionPersonMonthShare: livingPersonMonths ? actionPersonMonths.size / livingPersonMonths : 0,
    actions: actions.length,
    decisions: decisions.length,
    actionsByKind: countBy(actions, (event) => event.action.kind),
    actionsByOperation: countBy(actions, (event) => event.action.kind === 'act'
      ? `act:${event.action.operation}`
      : event.action.kind === 'communicate'
        ? `communicate:${event.action.content.kind}`
        : event.action.kind),
    actionsByStatus: countBy(actions, (event) => event.status),
    actionsByCause: countBy(actions, (event) => event.cause),
    actionsByActor: countBy(actions, (event) => event.who),
    decisionsByActor: countBy(decisions, (event) => event.who),
    actionsByPlanningTick: countBy(actions, (event) => event.planningTick ?? event.actionTick ?? 0),
    decisionsByKind: countBy(decisions, (event) => event.decision.kind),
    startDecisionsWithoutIntentId: decisions.filter((event) => event.decision.kind === 'start' && !event.intentId).length,
    topDecisionOptionPrefixes: topCounts(
      decisions.filter((event) => event.decision.kind === 'start' || event.decision.kind === 'revise'),
      (event) => String(event.decision.optionId).split(':').slice(0, 2).join(':'),
      20,
    ),
    intentsByStatus: countBy(state.intents, (intent) => intent.status),
    intentsByGoal: countBy(state.intents, (intent) => intent.goal.kind),
    intentsByGoalOutcome: countBy(state.intents, (intent) => intent.goalOutcome?.kind ?? 'missing'),
    zeroActionTerminalIntents: zeroActionTerminalIntents.length,
    zeroActionTerminalIntentsByGoalAndStatus: countBy(
      zeroActionTerminalIntents,
      (intent) => `${intent.goal.kind}:${intent.status}:${intent.goalOutcome?.kind ?? 'missing'}`,
    ),
    topZeroActionTerminalIntentSummaries: topCounts(
      zeroActionTerminalIntents,
      (intent) => intent.summary,
      16,
    ),
    survivalInterruptionIntents: survivalInterruptionIntents.length,
    survivalInterruptionActions: survivalInterruptionActions.length,
    survivalInterruptionActionsByOperation: countBy(
      survivalInterruptionActions,
      (event) => event.action.kind === 'act' ? `act:${event.action.operation}` : event.action.kind,
    ),
    survivalInterruptionActionsByActor: countBy(survivalInterruptionActions, (event) => event.who),
    allSurvivalActionsByActor: countBy(survivalActions, (event) => event.who),
    allSurvivalActionsByOperation: countBy(
      survivalActions,
      (event) => event.action.kind === 'act' ? `act:${event.action.operation}` : event.action.kind,
    ),
    waterSearchEpisodes: [...new Set(survivalActions.flatMap((event) => event.action.kind === 'move'
      ? [event.action.waterSearchBasis?.episodeId].filter(Boolean)
      : []))].length,
    wildlifeResponsesByActorAndKind: countBy(
      survivalInterruptionActions.filter((event) => event.action.kind === 'move' && event.action.wildlifeThreatBasis),
      (event) => `${event.who}:${event.action.wildlifeThreatBasis.response}`,
    ),
    wildlifeThreatIds: countBy(
      survivalInterruptionActions.flatMap((event) => event.action.kind === 'move'
        ? event.action.wildlifeThreatBasis?.threats ?? []
        : []),
      (threat) => threat.animalId,
    ),
    survivalInterruptionTrace: survivalInterruptionIntents.slice(0, 160).map((intent) => {
      const event = intent.actionEventIds.map((eventId) => actionById.get(eventId)).find(Boolean);
      const parent = intent.returnToIntentId
        ? state.intents.find((candidate) => candidate.id === intent.returnToIntentId)
        : undefined;
      return {
        month: event?.atMonth ?? intent.createdAtMonth,
        planningTick: event?.planningTick ?? null,
        actorId: intent.ownerId,
        fromCellId: event?.fromCellId ?? null,
        toCellId: event?.toCellId ?? null,
        requestedCellId: event?.action.kind === 'move' ? event.action.toCellId : null,
        result: event?.result ?? null,
        parentSummary: parent?.summary ?? null,
        parentProjectId: parent?.projectId ?? null,
      };
    }),
    topSurvivalInterruptionResults: topCounts(survivalInterruptionActions, (event) => event.result, 12),
    topBlockedIntentReasons: topCounts(
      state.intents.filter((intent) => intent.status === 'blocked' || intent.status === 'failed'),
      (intent) => intent.blockedReason ?? '(none)',
    ),
    blockedIntentTrace: state.intents
      .filter((intent) => intent.status === 'blocked' || intent.status === 'failed')
      .slice(-80)
      .map((intent) => ({
        ownerId: intent.ownerId,
        summary: intent.summary,
        projectId: intent.projectId ?? null,
        goal: intent.goal,
        action: intent.nextAction,
        blockedReason: intent.blockedReason ?? null,
        actionFacts: intent.actionEventIds.map((eventId) => actionById.get(eventId)).filter(Boolean).map((event) => ({
          atMonth: event.atMonth,
          status: event.status,
          result: event.result,
          diff: event.diff,
        })),
      })),
    topCompletedIntentSummaries: topCounts(
      state.intents.filter((intent) => intent.status === 'completed'),
      (intent) => intent.summary,
      12,
    ),
    waitingIntents: state.intents.filter((intent) => intent.waitingFor === 'world-change').length,
    projectsByStatus: countBy(state.projects, (project) => project.status),
    projectsByFunctionAndStatus: countBy(
      state.projects,
      (project) => `${project.desiredFunction}:${project.status}`,
    ),
    projectsAtEnd: state.projects.map((project) => ({
      id: project.id,
      ownerId: project.ownerId,
      desiredFunction: project.desiredFunction,
      status: project.status,
      progress: project.progress,
      reviewAtMonth: project.reviewAtMonth,
      blockedReason: project.blockedReason ?? null,
      actionCount: project.actionEventIds.length,
      lastProgressAtMonth: project.lastProgressAtMonth,
      activeLogisticsEpisodes: (project.logisticsEpisodes ?? []).filter((episode) => episode.status === 'active').map((episode) => ({
        id: episode.id,
        kind: episode.kind,
        actorId: episode.actorId,
        materialIds: episode.materialIds,
        target: episode.target,
      })),
      searchCampaigns: (project.searchCampaigns ?? []).map((campaign) => ({
        id: campaign.id,
        status: campaign.status,
        materialIds: campaign.materialIds,
        attemptedTargets: campaign.attemptedTargetKeys.length,
        totalTargets: campaign.cellIds.length,
      })),
      hypothesisCampaign: project.hypothesisCampaign ? {
        id: project.hypothesisCampaign.id,
        status: project.hypothesisCampaign.status,
        attemptCount: project.hypothesisCampaign.attempts.length,
      } : null,
    })),
    topActionResults: topCounts(actions, (event) => event.result, 16),
    peopleAtEnd: state.people.map((person) => {
      const active = person.activeIntentId
        ? state.intents.find((intent) => intent.id === person.activeIntentId)
        : undefined;
      const personActions = actions.filter((event) => event.who === person.id);
      return {
        id: person.id,
        alive: person.diedAtMonth === undefined && person.body.health > 0,
        body: person.body,
        activeIntentId: person.activeIntentId ?? null,
        activeIntentStatus: active?.status ?? null,
        activeIntentSummary: active?.summary ?? null,
        currentActionText: person.currentActionText,
        lastActionMonth: personActions.at(-1)?.atMonth ?? null,
        actionCount: personActions.length,
        decisionCount: decisions.filter((event) => event.who === person.id).length,
      };
    }),
    perMonth: Array.from({ length: state.clock.elapsedMonths }, (_, index) => index + 1).map((month) => ({
      month,
      actions: actions.filter((event) => event.atMonth === month).length,
      decisions: decisions.filter((event) => event.atMonth === month).length,
      actors: new Set(actions.filter((event) => event.atMonth === month).map((event) => event.who)).size,
      decisionActors: new Set(decisions.filter((event) => event.atMonth === month).map((event) => event.who)).size,
    })),
  };
}

function run(api) {
  let state = api.createInitialState(seed, { endpoint: { kind: 'months', value: months } });
  while (state.civilization.status === 'running' && state.clock.elapsedMonths < months) {
    state = api.stepSimulation(state);
  }
  return summarize(state);
}

try {
  if (currentOnly) {
    bundle('src/game/eland/simulation.ts', candidateBundlePath);
    const candidate = await import(`${pathToFileURL(candidateBundlePath).href}?throughput=${Date.now()}`);
    process.stdout.write(`${JSON.stringify({
      experiment: 'local-throughput-diagnostic-v1', seed, months,
      candidate: run(candidate),
    }, null, 2)}\n`);
    process.exitCode = 0;
  } else {
  mkdirSync(baselineRoot, { recursive: true });
  writeFileSync(archivePath, execFileSync('git', ['archive', '--format=tar', 'HEAD:three-body'], {
    cwd: path.resolve('..'),
    maxBuffer: 256 * 1024 * 1024,
  }));
  execFileSync('tar', ['-xf', archivePath, '-C', baselineRoot]);
  bundle(path.join(baselineRoot, 'src/game/eland/simulation.ts'), baselineBundlePath);
  bundle('src/game/eland/simulation.ts', candidateBundlePath);
  const nonce = Date.now();
  const baseline = await import(`${pathToFileURL(baselineBundlePath).href}?throughput=${nonce}`);
  const candidate = await import(`${pathToFileURL(candidateBundlePath).href}?throughput=${nonce}`);
  process.stdout.write(`${JSON.stringify({
    experiment: 'local-throughput-diagnostic-v1', seed, months,
    baseline: run(baseline),
    candidate: run(candidate),
  }, null, 2)}\n`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
