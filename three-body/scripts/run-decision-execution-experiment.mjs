import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function integerListArgument(name, fallback) {
  const offset = process.argv.indexOf(name);
  if (offset < 0) return fallback;
  const values = (process.argv[offset + 1] ?? '').split(',').map(Number);
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} requires comma-separated positive integers`);
  }
  return values;
}

const SEEDS = integerListArgument('--seeds', [185, 20260815, 20260816]);
const HORIZON_YEARS = integerListArgument('--years', [10, 30]);
const PROCESS_OPERATIONS = new Set(['combine', 'exert', 'expose']);
const SOURCE_FILES = [
  'scripts/run-decision-execution-experiment.mjs',
  'src/game/eland/application/action-options.ts',
  'src/game/eland/application/project-options.ts',
  'src/game/eland/application/record-use-options.ts',
  'src/game/eland/application/simulation/tick-planner.ts',
  'src/game/eland/application/simulation/month-execution.ts',
  'src/game/eland/application/simulation/intent-execution.ts',
  'src/game/eland/domain/action-executor.ts',
  'src/game/eland/domain/event-index.ts',
  'src/game/eland/domain/interaction-rules.ts',
  'src/game/eland/domain/intent.ts',
  'src/game/eland/domain/decision-budget.ts',
];
const sourceFingerprints = Object.fromEntries(SOURCE_FILES.map((sourcePath) => [
  sourcePath,
  createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
]));

function sourceFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFilesUnder(entryPath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    });
}

const ENGINE_SOURCE_ROOT = 'src/game/eland';
function engineSourceTreeSnapshot() {
  const sourceFiles = sourceFilesUnder(ENGINE_SOURCE_ROOT);
  const hash = createHash('sha256');
  for (const sourcePath of sourceFiles) {
    hash.update(path.relative(ENGINE_SOURCE_ROOT, sourcePath));
    hash.update('\0');
    hash.update(readFileSync(sourcePath));
    hash.update('\0');
  }
  return { typescriptFileCount: sourceFiles.length, sha256: hash.digest('hex') };
}
const engineSourceSnapshotAtStart = engineSourceTreeSnapshot();
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-decision-execution-experiment-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');

function replaceOnce(contents, search, replacement, sourcePath) {
  if (!contents.includes(search)) throw new Error(`baseline transform drifted: ${sourcePath}`);
  return contents.replace(search, replacement);
}

function baselinePlugin() {
  return {
    name: 'decision-execution-v1-baseline',
    setup(buildApi) {
      buildApi.onLoad({ filter: /decision-budget\.ts$/ }, (args) => {
        const contents = replaceOnce(
          readFileSync(args.path, 'utf8'),
          'export const ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH = 2;',
          'export const ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH = 1;',
          args.path,
        );
        return { contents, loader: 'ts' };
      });
      buildApi.onLoad({ filter: /domain\/intent\.ts$/ }, (args) => {
        const contents = replaceOnce(
          readFileSync(args.path, 'utf8'),
          "return intent.lifecycle.completion === 'maintain-state'",
          "return (intent.lifecycle.completion === 'maintain-state' || intent.lifecycle.completion === 'on-achievement')",
          args.path,
        );
        return { contents, loader: 'ts' };
      });
      buildApi.onLoad({ filter: /simulation\/intent-execution\.ts$/ }, (args) => {
        const contents = replaceOnce(
          readFileSync(args.path, 'utf8'),
          "const lifecycleAchievementCompleted = intent.lifecycle?.completion === 'on-achievement'",
          "const lifecycleAchievementCompleted = false",
          args.path,
        );
        return { contents, loader: 'ts' };
      });
    },
  };
}

function outputArgument() {
  const offset = process.argv.indexOf('--out');
  return offset >= 0 ? process.argv[offset + 1] : undefined;
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function isStructuredNoResponseFailure(event) {
  if (event.status !== 'blocked' || event.action.kind !== 'act') return false;
  const materialIds = Array.isArray(event.diff.inputMaterialIds)
    ? event.diff.inputMaterialIds.filter((value) => Number.isInteger(value))
    : [];
  if (event.action.operation === 'combine' && materialIds.length >= 2) return true;
  const inputMaterialId = Number(event.diff.inputMaterialId);
  const targetMaterialId = Number(event.diff.targetMaterialId);
  if (!Number.isInteger(inputMaterialId) || !Number.isInteger(targetMaterialId)) return false;
  if (event.action.operation === 'combine' || event.action.operation === 'expose') return true;
  return event.action.operation === 'exert' && Number.isInteger(Number(event.diff.toolMaterialId));
}

function endpointMaterialTotals(state) {
  const totals = new Map();
  const add = (materialId, quantity) => totals.set(String(materialId), (totals.get(String(materialId)) ?? 0) + quantity);
  for (const person of state.people) for (const stack of person.inventory) add(stack.materialId, stack.quantity);
  for (const drop of state.world.drops) add(drop.materialId, drop.quantity);
  return Object.fromEntries([...totals.entries()].sort(([left], [right]) => Number(left) - Number(right)));
}

async function bundleVariant(name, plugins = []) {
  const outfile = path.join(temporaryDirectory, `${name}.mjs`);
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins,
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?variant=${name}-${Date.now()}`);
}

function summarizeRun(api, seed, years) {
  const months = years * 12;
  let state = api.createInitialState(seed, { endpoint: { kind: 'months', value: months } });
  const metrics = {
    committedMonths: 0,
    livingPersonMonths: 0,
    decisions: 0,
    ordinaryDecisions: 0,
    edgeDecisions: 0,
    ordinaryFollowupDecisions: 0,
    ordinaryIdleDecisions: 0,
    actions: 0,
    completedActions: 0,
    processActions: 0,
    satisfiedActiveIntentPersonMonths: 0,
    explicitMaintenancePersonMonths: 0,
    sameMonthRepeatedProcessGroups: 0,
    sameMonthExactRepeatedProcessGroups: 0,
    sameMonthExactRepeatedProcessOccurrences: 0,
    sameMonthExactRepeatedProcessDifferentIntentGroups: 0,
    sameMonthFailedExactRepeatedProcessGroups: 0,
    rollingSixMonthFailedExactProcessDifferentIntentOccurrences: 0,
    rollingSixMonthStructuredNoResponseConfirmations: 0,
    rollingSixMonthOtherFailedExactProcessDifferentIntentOccurrences: 0,
    moveActions: 0,
    completedMoveActions: 0,
    movementReversals: 0,
    movementReversalsSameIntent: 0,
    movementReversalsDifferentIntent: 0,
    movementReversalsWithoutIntent: 0,
    movementReversalsDifferentIntentBothOrdinary: 0,
    movementReversalsDifferentIntentInvolvingEdge: 0,
    movementReversalsDifferentIntentChannelUnknown: 0,
    movementReversalsSameProject: 0,
    movementReversalsAcrossProjects: 0,
    movementReversalsWithoutProject: 0,
    socialProposalActions: 0,
    socialProposalResponses: 0,
    sameMonthRepeatedSocialProposalGroups: 0,
    modelDecisions: 0,
    maxOrdinaryDecisionFactsPerPersonMonth: 0,
  };
  const exactRepeatedProcessSamples = [];
  const rollingSixMonthFailedExactProcessSamples = [];
  const movementReversalSamples = [];
  const recentFailedProcessFactsByKey = new Map();
  const intentsById = new Map();
  const decisionsById = new Map();
  let indexedIntentCount = 0;
  while (state.civilization.status !== 'ended' && state.clock.elapsedMonths < months) {
    const nextMonth = state.clock.elapsedMonths + 1;
    const previousHistoryLength = state.world.past.length;
    metrics.livingPersonMonths += state.people.filter((person) => person.diedAtMonth === undefined).length;
    state = api.stepSimulation(state);
    for (; indexedIntentCount < state.intents.length; indexedIntentCount += 1) {
      const intent = state.intents[indexedIntentCount];
      intentsById.set(intent.id, intent);
    }
    metrics.committedMonths = state.clock.elapsedMonths;
    const monthEvents = state.world.past.slice(previousHistoryLength)
      .filter((event) => event.atMonth === nextMonth);
    const decisions = monthEvents.filter((event) => event.kind === 'decision');
    for (const decision of decisions) decisionsById.set(decision.id, decision);
    const actions = monthEvents.filter((event) => event.kind === 'action');
    const ordinary = decisions.filter((event) => event.planningChannel !== 'edge');
    metrics.decisions += decisions.length;
    metrics.ordinaryDecisions += ordinary.length;
    metrics.edgeDecisions += decisions.length - ordinary.length;
    metrics.ordinaryIdleDecisions += ordinary.filter((event) => event.decision.kind === 'idle').length;
    metrics.actions += actions.length;
    metrics.completedActions += actions.filter((event) => event.status === 'completed').length;
    metrics.modelDecisions += decisions.filter((event) => event.usedModel).length;
    for (const count of countBy(ordinary, (event) => event.who).values()) {
      metrics.ordinaryFollowupDecisions += Math.max(0, count - 1);
      metrics.maxOrdinaryDecisionFactsPerPersonMonth = Math.max(
        metrics.maxOrdinaryDecisionFactsPerPersonMonth,
        count,
      );
    }
    const processFacts = actions.filter((event) => event.action.kind === 'act'
      && PROCESS_OPERATIONS.has(event.action.operation));
    metrics.processActions += processFacts.length;
    for (const count of countBy(processFacts, (event) => `${event.who}:${event.action.operation}`).values()) {
      if (count > 1) metrics.sameMonthRepeatedProcessGroups += 1;
    }
    for (const facts of groupBy(processFacts, (event) => `${event.who}:${JSON.stringify(event.action)}`).values()) {
      if (facts.length <= 1) continue;
      metrics.sameMonthExactRepeatedProcessGroups += 1;
      metrics.sameMonthExactRepeatedProcessOccurrences += facts.length - 1;
      const intentIds = [...new Set(facts.map((event) => event.intentId ?? null))];
      const differentIntent = intentIds.length > 1 || intentIds[0] === null;
      const failedOnly = facts.every((event) => event.status === 'blocked' || event.status === 'failed');
      if (differentIntent) metrics.sameMonthExactRepeatedProcessDifferentIntentGroups += 1;
      if (differentIntent && failedOnly) metrics.sameMonthFailedExactRepeatedProcessGroups += 1;
      if (exactRepeatedProcessSamples.length < 24) {
        const actorDecisions = decisions.filter((event) => event.who === facts[0].who);
        exactRepeatedProcessSamples.push({
          atMonth: nextMonth,
          actorId: facts[0].who,
          action: facts[0].action,
          occurrences: facts.map((event) => ({
            id: event.id,
            planningTick: event.planningTick,
            status: event.status,
            intentId: event.intentId ?? null,
            result: event.result,
          })),
          ordinaryDecisionCount: actorDecisions.filter((event) => event.planningChannel !== 'edge').length,
          intentIds,
          differentIntent,
          failedOnly,
        });
      }
    }
    for (const fact of processFacts.filter((event) => (event.status === 'blocked' || event.status === 'failed')
      && typeof event.intentId === 'string')) {
      const key = `${fact.who}:${JSON.stringify(fact.action)}`;
      const recent = (recentFailedProcessFactsByKey.get(key) ?? [])
        .filter((previous) => fact.atMonth - previous.atMonth <= 6);
      const predecessor = [...recent].reverse().find((previous) => previous.intentId !== fact.intentId);
      if (predecessor) {
        metrics.rollingSixMonthFailedExactProcessDifferentIntentOccurrences += 1;
        const structuredNoResponseConfirmation = isStructuredNoResponseFailure(predecessor)
          && isStructuredNoResponseFailure(fact);
        if (structuredNoResponseConfirmation) metrics.rollingSixMonthStructuredNoResponseConfirmations += 1;
        else metrics.rollingSixMonthOtherFailedExactProcessDifferentIntentOccurrences += 1;
        if (rollingSixMonthFailedExactProcessSamples.length < 24) {
          rollingSixMonthFailedExactProcessSamples.push({
            actorId: fact.who,
            action: fact.action,
            monthGap: fact.atMonth - predecessor.atMonth,
            classification: structuredNoResponseConfirmation ? 'structured-no-response-confirmation' : 'other',
            previous: {
              id: predecessor.id,
              atMonth: predecessor.atMonth,
              intentId: predecessor.intentId,
              status: predecessor.status,
              result: predecessor.result,
            },
            retry: {
              id: fact.id,
              atMonth: fact.atMonth,
              intentId: fact.intentId,
              status: fact.status,
              result: fact.result,
            },
          });
        }
      }
      recent.push(fact);
      recentFailedProcessFactsByKey.set(key, recent);
    }
    const socialProposals = actions.filter((event) => event.action.kind === 'communicate'
      && (event.action.content.kind === 'request' || event.action.content.kind === 'offer')
      && Boolean(event.action.content.proposal));
    metrics.socialProposalActions += socialProposals.length;
    metrics.socialProposalResponses += actions.filter((event) => event.action.kind === 'communicate'
      && (event.action.content.kind === 'accept' || event.action.content.kind === 'reject')).length;
    for (const count of countBy(socialProposals, (event) => {
      const proposal = event.action.kind === 'communicate'
        && (event.action.content.kind === 'request' || event.action.content.kind === 'offer')
        ? event.action.content.proposal
        : undefined;
      return `${event.who}:${proposal?.kind ?? 'none'}:${[...event.action.audience].sort().join(',')}`;
    }).values()) {
      if (count > 1) metrics.sameMonthRepeatedSocialProposalGroups += 1;
    }
    const movesByPerson = new Map();
    for (const event of actions) {
      if (event.action.kind !== 'move') continue;
      metrics.moveActions += 1;
      if (event.status === 'completed') metrics.completedMoveActions += 1;
      const moves = movesByPerson.get(event.who) ?? [];
      moves.push(event);
      movesByPerson.set(event.who, moves);
    }
    for (const moves of movesByPerson.values()) {
      for (let index = 1; index < moves.length; index += 1) {
        if (moves[index - 1].fromCellId === moves[index].toCellId
          && moves[index - 1].toCellId === moves[index].fromCellId) {
          metrics.movementReversals += 1;
          const previous = moves[index - 1];
          const reversal = moves[index];
          const previousIntent = typeof previous.intentId === 'string'
            ? intentsById.get(previous.intentId)
            : undefined;
          const reversalIntent = typeof reversal.intentId === 'string'
            ? intentsById.get(reversal.intentId)
            : undefined;
          const previousDecision = previousIntent
            ? decisionsById.get(previousIntent.sourceDecisionEventId)
            : undefined;
          const reversalDecision = reversalIntent
            ? decisionsById.get(reversalIntent.sourceDecisionEventId)
            : undefined;
          const previousPlanningChannel = previousDecision
            ? previousDecision.planningChannel ?? 'ordinary'
            : undefined;
          const reversalPlanningChannel = reversalDecision
            ? reversalDecision.planningChannel ?? 'ordinary'
            : undefined;
          if (!previousIntent || !reversalIntent) metrics.movementReversalsWithoutIntent += 1;
          else if (previousIntent.id === reversalIntent.id) metrics.movementReversalsSameIntent += 1;
          else {
            metrics.movementReversalsDifferentIntent += 1;
            if (!previousPlanningChannel || !reversalPlanningChannel) {
              metrics.movementReversalsDifferentIntentChannelUnknown += 1;
            } else if (previousPlanningChannel === 'edge' || reversalPlanningChannel === 'edge') {
              metrics.movementReversalsDifferentIntentInvolvingEdge += 1;
            } else metrics.movementReversalsDifferentIntentBothOrdinary += 1;
          }
          const previousProjectId = previousIntent?.projectId;
          const reversalProjectId = reversalIntent?.projectId;
          if (!previousProjectId && !reversalProjectId) metrics.movementReversalsWithoutProject += 1;
          else if (previousProjectId && previousProjectId === reversalProjectId) {
            metrics.movementReversalsSameProject += 1;
          } else metrics.movementReversalsAcrossProjects += 1;
          if (movementReversalSamples.length < 24) movementReversalSamples.push({
            atMonth: nextMonth,
            actorId: reversal.who,
            classification: {
              intent: !previousIntent || !reversalIntent
                ? 'without-intent'
                : previousIntent.id === reversalIntent.id ? 'same-intent' : 'different-intent',
              project: !previousProjectId && !reversalProjectId
                ? 'without-project'
                : previousProjectId === reversalProjectId ? 'same-project' : 'across-projects',
            },
            previous: {
              id: previous.id,
              planningTick: previous.planningTick,
              fromCellId: previous.fromCellId,
              toCellId: previous.toCellId,
              intentId: previous.intentId ?? null,
              intentSummary: previousIntent?.summary ?? null,
              projectId: previousProjectId ?? null,
              planningChannel: previousPlanningChannel ?? null,
            },
            reversal: {
              id: reversal.id,
              planningTick: reversal.planningTick,
              fromCellId: reversal.fromCellId,
              toCellId: reversal.toCellId,
              intentId: reversal.intentId ?? null,
              intentSummary: reversalIntent?.summary ?? null,
              projectId: reversalProjectId ?? null,
              planningChannel: reversalPlanningChannel ?? null,
            },
          });
        }
      }
    }
    const activeIntents = new Map(state.intents
      .filter((intent) => intent.status === 'active')
      .map((intent) => [intent.id, intent]));
    for (const person of state.people) {
      const intent = person.activeIntentId
        ? activeIntents.get(person.activeIntentId)
        : undefined;
      if (!intent) continue;
      if (api.goalSatisfied(state, person, intent.goal)) metrics.satisfiedActiveIntentPersonMonths += 1;
      if (intent.lifecycle?.completion === 'maintain-state') metrics.explicitMaintenancePersonMonths += 1;
    }
  }
  const goalOutcomes = { achieved: 0, 'attempted-unmet': 0, 'not-evaluated': 0, missing: 0 };
  for (const intent of state.intents) {
    const key = intent.goalOutcome?.kind ?? 'missing';
    goalOutcomes[key] += 1;
  }
  return {
    seed,
    years,
    endpoint: {
      elapsedMonths: state.clock.elapsedMonths,
      civilizationStatus: state.civilization.status,
      livingPeople: state.people.filter((person) => person.diedAtMonth === undefined).length,
      totalPeople: state.people.length,
      activeIntents: state.intents.filter((intent) => intent.status === 'active').length,
      completedIntents: state.intents.filter((intent) => intent.status === 'completed').length,
      blockedIntents: state.intents.filter((intent) => intent.status === 'blocked').length,
      completedProjects: state.projects.filter((project) => project.status === 'completed').length,
      blockedProjects: state.projects.filter((project) => project.status === 'blocked').length,
      totalAgreements: state.agreements.length,
      proposedAgreements: state.agreements.filter((agreement) => agreement.status === 'proposed').length,
      activeAgreements: state.agreements.filter((agreement) => agreement.status === 'active').length,
      fulfilledAgreements: state.agreements.filter((agreement) => agreement.status === 'fulfilled').length,
      rejectedAgreements: state.agreements.filter((agreement) => agreement.status === 'rejected').length,
      expiredAgreements: state.agreements.filter((agreement) => agreement.status === 'expired').length,
      materialTotals: endpointMaterialTotals(state),
    },
    metrics,
    goalOutcomes,
    diagnostics: {
      exactRepeatedProcessSamples,
      rollingSixMonthFailedExactProcessSamples,
      movementReversalSamples,
    },
  };
}

function numericDelta(candidate, baseline) {
  const delta = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === 'number' && typeof baseline[key] === 'number') delta[key] = value - baseline[key];
  }
  return delta;
}

try {
  writeFileSync(entryPath, `
    export { createInitialState, stepSimulation } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { goalSatisfied } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
  `, 'utf8');
  const [baselineApi, candidateApi] = await Promise.all([
    bundleVariant('baseline', [baselinePlugin()]),
    bundleVariant('candidate'),
  ]);
  const engineSourceSnapshotAfterBundle = engineSourceTreeSnapshot();
  if (engineSourceSnapshotAfterBundle.sha256 !== engineSourceSnapshotAtStart.sha256
    || engineSourceSnapshotAfterBundle.typescriptFileCount !== engineSourceSnapshotAtStart.typescriptFileCount) {
    throw new Error('engine source tree changed while experiment variants were being bundled');
  }
  const pairs = [];
  const outputPath = path.resolve(outputArgument()
    ?? 'data/experiments/decision-execution-v13-matched-final-20260826.json');
  const reportFor = (status, currentEngineSourceSnapshot = engineSourceTreeSnapshot()) => ({
    schemaVersion: 'decision-execution-matched-experiment-v4',
    generatedAt: new Date().toISOString(),
    status,
    interpretationStatus: status === 'complete'
      ? 'unreviewed-execution-complete'
      : status === 'aborted'
        ? 'aborted-diagnostic-only: engine source tree changed after bundle; do not use completed pairs as source-freeze evidence'
        : 'running-unreviewed',
    authority: 'offline matched-seed diagnostic; not runtime state',
    hypothesisArtifact: 'decision-execution-v1-hypothesis-20260826.json',
    sourceFingerprints,
    engineSourceSnapshot: {
      root: ENGINE_SOURCE_ROOT,
      typescriptFileCount: engineSourceSnapshotAtStart.typescriptFileCount,
      currentTypescriptFileCount: currentEngineSourceSnapshot.typescriptFileCount,
      sha256: engineSourceSnapshotAtStart.sha256,
      currentSha256: currentEngineSourceSnapshot.sha256,
      stable: currentEngineSourceSnapshot.sha256 === engineSourceSnapshotAtStart.sha256
        && currentEngineSourceSnapshot.typescriptFileCount === engineSourceSnapshotAtStart.typescriptFileCount,
    },
    matrix: { seeds: SEEDS, years: HORIZON_YEARS, modelPolicy: 'offline-local-rules-only' },
    baselineTransform: {
      ordinaryLocalDeliberationsPerPersonMonth: 1,
      boundedStateAchievements: 'legacy-maintain-until-review',
      note: 'Built from the same frozen dirty source snapshot as candidate; in-memory ablation limits ordinary cadence to one deliberation and restores implicit maintenance for bounded state achievements. Shared correctness fixes such as full current-month evidence overlay remain in both variants.',
    },
    candidate: {
      ordinaryLocalDeliberationsPerPersonMonth: 2,
      boundedStateAchievements: 'on-achievement; explicit maintenance only',
      cadence: 'explicit MonthExecution counts plus terminal root permit; edge channel independent',
      sameMonthFailureRetry: 'terminal intents recover the actual failed ActionFact from committed history or the current-month overlay; bounded memory is only a compatibility fallback; the exact executed action remains cooled for its failure month even if a new goal or project asks for it, while later months use the full causal basis and fresh-source rule',
      currentAffordance: 'an option is omitted when either its nextAction or already-declared completionAction would place a solid or install a mechanical/electrical component into an otherwise-air, currently body-occupied voxel; the domain executor still revalidates occupancy at commit',
      recompiledPlacementWait: 'if a project exposes construction or mechanical/electrical placement only after its movement/logistics prefix, active-intent recompilation waits without emitting a failed ActionFact while that exact otherwise-air destination remains body-occupied and retries naturally after it clears',
      nestedPlanningEvidence: 'project, record-use, and life-review preview clones inherit the source planning overlay, so the option action and commit-time recompilation see the same current-month facts',
    },
    pairs,
  });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  for (const years of HORIZON_YEARS) {
    for (const seed of SEEDS) {
      const baseline = summarizeRun(baselineApi, seed, years);
      const candidate = summarizeRun(candidateApi, seed, years);
      pairs.push({
        seed,
        years,
        baseline,
        candidate,
        delta: {
          metrics: numericDelta(candidate.metrics, baseline.metrics),
          endpoint: numericDelta(candidate.endpoint, baseline.endpoint),
          goalOutcomes: numericDelta(candidate.goalOutcomes, baseline.goalOutcomes),
        },
      });
      const currentEngineSourceSnapshot = engineSourceTreeSnapshot();
      if (currentEngineSourceSnapshot.sha256 !== engineSourceSnapshotAtStart.sha256
        || currentEngineSourceSnapshot.typescriptFileCount !== engineSourceSnapshotAtStart.typescriptFileCount) {
        writeFileSync(outputPath, `${JSON.stringify(reportFor('aborted', currentEngineSourceSnapshot), null, 2)}\n`, 'utf8');
        throw new Error('engine source tree changed during experiment execution');
      }
      writeFileSync(outputPath, `${JSON.stringify(reportFor('running', currentEngineSourceSnapshot), null, 2)}\n`, 'utf8');
      process.stderr.write(`paired seed=${seed} years=${years} done\n`);
    }
  }
  const finalEngineSourceSnapshot = engineSourceTreeSnapshot();
  if (finalEngineSourceSnapshot.sha256 !== engineSourceSnapshotAtStart.sha256
    || finalEngineSourceSnapshot.typescriptFileCount !== engineSourceSnapshotAtStart.typescriptFileCount) {
    writeFileSync(outputPath, `${JSON.stringify(reportFor('aborted', finalEngineSourceSnapshot), null, 2)}\n`, 'utf8');
    throw new Error('engine source tree changed before experiment completion');
  }
  writeFileSync(outputPath, `${JSON.stringify(reportFor('complete', finalEngineSourceSnapshot), null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, pairs: pairs.length })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
