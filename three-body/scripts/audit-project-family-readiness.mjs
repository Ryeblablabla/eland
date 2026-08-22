#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const AUDIT_VERSION = 'project-family-readiness-audit-v2';
const REPRODUCTION_DECISION_PREFIXES = ['offer-reproduce', 'accept-reproduce', 'reproduce'];
const FAMILY_RELEVANT_FUNCTIONS = new Set([
  'settled-cultivation',
  'reserve-storage',
  'reliable-water',
  'weather-shelter',
  'crop-processing',
]);
const TERMINAL_INTENT_STATUSES = new Set(['completed', 'blocked', 'failed', 'abandoned']);

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const strings = (value) => unique(asArray(value).map(stringValue));
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))].sort();
const rounded = (value) => Math.round(value * 10_000) / 10_000;
const ratio = (numerator, denominator) => denominator > 0 ? rounded(numerator / denominator) : null;

function usage() {
  process.stderr.write(`Audit the authoritative project -> family-readiness BDI path from SQLite.

Usage:
  node scripts/audit-project-family-readiness.mjs --prefix RUN_PREFIX [--out OUTPUT.json]
  node scripts/audit-project-family-readiness.mjs --run-id RUN_ID[,RUN_ID...] [--out OUTPUT.json]
`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === '--prefix') parsed.prefix = value;
    else if (argument === '--run-id') parsed.runIds = unique(value.split(',').map((item) => item.trim()).filter(Boolean));
    else if (argument === '--out') parsed.outputPath = path.resolve(value);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (Boolean(parsed.prefix) === Boolean(parsed.runIds?.length)) {
    throw new Error('Provide exactly one of --prefix or --run-id');
  }
  return parsed;
}

function eventOrder(left, right) {
  return (integerValue(left?.atMonth) ?? 0) - (integerValue(right?.atMonth) ?? 0)
    || (integerValue(left?.orderInMonth) ?? 0) - (integerValue(right?.orderInMonth) ?? 0)
    || (integerValue(left?.planningTick) ?? 0) - (integerValue(right?.planningTick) ?? 0)
    || String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

function sameStrings(left, right) {
  const normalizedLeft = unique(left);
  const normalizedRight = unique(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function eventRef(event) {
  if (!event) return null;
  const action = asObject(event.action);
  const diff = asObject(event.diff) ?? {};
  return {
    eventId: stringValue(event.id),
    kind: stringValue(event.kind),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    planningTick: integerValue(event.planningTick),
    who: stringValue(event.who),
    intentId: stringValue(event.intentId),
    status: stringValue(event.status),
    actionKind: stringValue(action?.kind),
    operation: stringValue(action?.operation),
    conceived: typeof diff.conceived === 'boolean' ? diff.conceived : null,
  };
}

function reproductionDecisionType(optionId) {
  const normalized = stringValue(optionId);
  if (!normalized) return null;
  return REPRODUCTION_DECISION_PREFIXES.find((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}:`)
  )) ?? null;
}

function isReproductionAction(event) {
  const action = asObject(event?.action);
  return event?.kind === 'action' && action?.kind === 'act' && action.operation === 'reproduce';
}

function emptyOutcomeCounts() {
  return { achieved: 0, 'attempted-unmet': 0, 'not-evaluated': 0 };
}

function emptyDecisionCounts() {
  return { 'offer-reproduce': 0, 'accept-reproduce': 0, reproduce: 0 };
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
  return target;
}

function projectEpisodeAudit(state, eventById) {
  const projectById = new Map(asArray(state.projects).flatMap((project) => (
    stringValue(project.id) ? [[project.id, project]] : []
  )));
  const episodes = [];
  const unresolvedSourceFacts = [];
  const mismatches = [];

  for (const person of asArray(state.people)) {
    for (const episode of asArray(person.cognition?.needResolutionEpisodes)) {
      const episodeId = stringValue(episode.id) ?? '(missing-episode-id)';
      const projectId = stringValue(episode.projectId);
      const project = projectId ? projectById.get(projectId) : undefined;
      const triggerFactIds = strings(episode.triggerFactIds);
      const outcomeEventIds = strings(episode.outcomeEventIds);
      const sourceFactIds = strings(episode.sourceFactIds);
      const expectedSourceFactIds = unique([...triggerFactIds, ...outcomeEventIds]);
      const issueCodes = [];

      const fieldsByMissingEventId = new Map();
      for (const [field, ids] of [
        ['triggerFactIds', triggerFactIds],
        ['outcomeEventIds', outcomeEventIds],
        ['sourceFactIds', sourceFactIds],
      ]) {
        for (const eventId of ids) {
          if (eventById.has(eventId)) continue;
          const fields = fieldsByMissingEventId.get(eventId) ?? [];
          fields.push(field);
          fieldsByMissingEventId.set(eventId, fields);
        }
      }
      for (const [eventId, fields] of fieldsByMissingEventId) {
        unresolvedSourceFacts.push({ personId: person.id, episodeId, eventId, fields: unique(fields) });
      }
      if (fieldsByMissingEventId.size) issueCodes.push('unresolved-source-fact');
      if (episode.version !== 'need-resolution-episode-v1') issueCodes.push('episode-version-mismatch');
      if (episode.observationKind !== 'completion-action') issueCodes.push('observation-kind-mismatch');
      if (!project) issueCodes.push('project-missing');
      if (project && project.status !== 'completed') issueCodes.push('project-not-completed');
      if (project && project.need !== episode.projectNeed) issueCodes.push('project-need-mismatch');
      if (project && project.desiredFunction !== episode.desiredFunction) issueCodes.push('project-function-mismatch');
      if (project && !sameStrings(project.completionEventIds, outcomeEventIds)) {
        issueCodes.push('project-completion-events-mismatch');
      }
      if (project && !sameStrings(project.triggerFactIds, triggerFactIds)) {
        issueCodes.push('project-trigger-facts-mismatch');
      }
      if (!sameStrings(sourceFactIds, expectedSourceFactIds)) issueCodes.push('episode-source-union-mismatch');
      if (episode.basisKey !== `need-resolution:${episode.projectNeed}:${episode.desiredFunction}`) {
        issueCodes.push('basis-key-mismatch');
      }
      if (!outcomeEventIds.length) issueCodes.push('completion-action-missing');

      const resolvedOutcomes = outcomeEventIds.map((eventId) => eventById.get(eventId)).filter(Boolean).sort(eventOrder);
      const completionAction = resolvedOutcomes.at(-1);
      if (completionAction && (completionAction.kind !== 'action' || !asObject(completionAction.action))) {
        issueCodes.push('completion-evidence-not-action');
      }
      if (completionAction?.kind === 'action' && completionAction.status !== 'completed') {
        issueCodes.push('completion-action-status-mismatch');
      }
      if (completionAction?.kind === 'action' && completionAction.who !== person.id) {
        issueCodes.push('completion-action-actor-mismatch');
      }
      const observedAtMonth = integerValue(episode.observedAtMonth);
      if (project && observedAtMonth !== integerValue(project.completedAtMonth)) {
        issueCodes.push('completion-month-mismatch');
      }

      const descriptor = {
        personId: person.id,
        episode,
        episodeId,
        project,
        triggerFactIds,
        outcomeEventIds,
        sourceFactIds,
        completionAction,
        issueCodes: unique(issueCodes),
      };
      episodes.push(descriptor);
      if (issueCodes.length) {
        mismatches.push({
          personId: person.id,
          episodeId,
          projectId,
          issueCodes: unique(issueCodes),
          completionAction: eventRef(completionAction),
        });
      }
    }
  }

  return {
    episodes,
    summary: {
      needResolutionEpisodes: episodes.length,
      holders: new Set(episodes.map((entry) => entry.personId)).size,
      validEpisodes: episodes.filter((entry) => entry.issueCodes.length === 0).length,
      unresolvedSourceFacts: unresolvedSourceFacts.length,
      mismatches: mismatches.length,
      integrityRatio: ratio(episodes.filter((entry) => entry.issueCodes.length === 0).length, episodes.length),
    },
    unresolvedSourceFacts,
    mismatches,
  };
}

function goalOutcomeAudit(state, eventById) {
  const counts = emptyOutcomeCounts();
  const reproductionCounts = emptyOutcomeCounts();
  const unresolvedSourceFacts = [];
  const sourceMismatches = [];
  const reproductionSemanticMismatches = [];
  let intentsWithoutGoalOutcome = 0;
  let terminalIntentsWithoutGoalOutcome = 0;
  let sourceReferences = 0;
  let resolvedSourceReferences = 0;

  for (const intent of asArray(state.intents)) {
    const outcome = asObject(intent.goalOutcome);
    if (!outcome) {
      intentsWithoutGoalOutcome += 1;
      if (TERMINAL_INTENT_STATUSES.has(intent.status)) terminalIntentsWithoutGoalOutcome += 1;
      continue;
    }
    const kind = stringValue(outcome.kind);
    if (Object.hasOwn(counts, kind)) counts[kind] += 1;
    const sourceEventIds = strings(outcome.sourceEventIds);
    sourceReferences += sourceEventIds.length;
    const resolvedSources = [];
    for (const eventId of sourceEventIds) {
      const event = eventById.get(eventId);
      if (event) {
        resolvedSourceReferences += 1;
        resolvedSources.push(event);
      } else unresolvedSourceFacts.push({ intentId: intent.id, eventId });
    }
    if (!sourceEventIds.length || resolvedSources.length !== sourceEventIds.length) {
      sourceMismatches.push({
        intentId: intent.id,
        goalOutcomeKind: kind,
        issueCodes: unique([
          ...(!sourceEventIds.length ? ['goal-outcome-source-missing'] : []),
          ...(resolvedSources.length !== sourceEventIds.length ? ['goal-outcome-source-unresolved'] : []),
        ]),
        sourceEventIds,
      });
    }

    const goal = asObject(intent.goal);
    const basisKey = stringValue(outcome.basisKey) ?? '';
    const pregnancyCondition = goal?.kind === 'condition'
      && goal.condition === 'pregnancy'
      && goal.present === true;
    const reproductionGoalOutcome = basisKey.includes('act:reproduce') && pregnancyCondition;
    if (!reproductionGoalOutcome) continue;
    if (Object.hasOwn(reproductionCounts, kind)) reproductionCounts[kind] += 1;

    const semanticIssueCodes = [];
    if (kind === 'attempted-unmet') {
      if (!basisKey.includes('goal=condition:pregnancy:present')) semanticIssueCodes.push('pregnancy-basis-key-mismatch');
      const reproductionSources = resolvedSources.filter(isReproductionAction);
      if (!reproductionSources.length
        || reproductionSources.some((event) => asObject(event.diff)?.conceived !== false)) {
        semanticIssueCodes.push('attempted-unmet-without-exact-non-conception-source');
      }
    } else if (kind === 'achieved') {
      if (!basisKey.includes('goal=condition:pregnancy:present')) semanticIssueCodes.push('pregnancy-basis-key-mismatch');
      const hasConception = resolvedSources.some((event) => (
        isReproductionAction(event) && asObject(event.diff)?.conceived === true
      ));
      if (!hasConception) semanticIssueCodes.push('achieved-without-conception-source');
    }
    if (semanticIssueCodes.length) {
      reproductionSemanticMismatches.push({
        intentId: intent.id,
        ownerId: intent.ownerId,
        goalOutcomeKind: kind,
        issueCodes: unique(semanticIssueCodes),
        sources: resolvedSources.map(eventRef),
        unresolvedSourceEventIds: sourceEventIds.filter((eventId) => !eventById.has(eventId)),
      });
    }
  }

  const reproductionEvaluated = reproductionCounts.achieved + reproductionCounts['attempted-unmet'];
  return {
    summary: {
      counts,
      intentsWithoutGoalOutcome,
      terminalIntentsWithoutGoalOutcome,
      sourceReferences,
      resolvedSourceReferences,
      unresolvedSourceFacts: unresolvedSourceFacts.length,
      sourceMismatches: sourceMismatches.length,
      sourceResolutionRatio: ratio(resolvedSourceReferences, sourceReferences),
      reproduction: {
        counts: reproductionCounts,
        evaluated: reproductionEvaluated,
        semanticMismatches: reproductionSemanticMismatches.length,
        semanticIntegrityRatio: ratio(
          reproductionEvaluated - reproductionSemanticMismatches.filter((entry) => (
            entry.goalOutcomeKind === 'achieved' || entry.goalOutcomeKind === 'attempted-unmet'
          )).length,
          reproductionEvaluated,
        ),
      },
    },
    unresolvedSourceFacts,
    sourceMismatches,
    reproductionSemanticMismatches,
  };
}

function postResolutionReproductionAudit(state, events, episodeDescriptors) {
  const intentById = new Map(asArray(state.intents).flatMap((intent) => (
    stringValue(intent.id) ? [[intent.id, intent]] : []
  )));
  const episodesByPerson = new Map();
  const familyRelevantEpisodes = episodeDescriptors.filter((descriptor) => (
    FAMILY_RELEVANT_FUNCTIONS.has(descriptor.episode.desiredFunction)
  ));
  for (const descriptor of familyRelevantEpisodes) {
    if (!descriptor.completionAction) continue;
    const entries = episodesByPerson.get(descriptor.personId) ?? [];
    entries.push(descriptor);
    episodesByPerson.set(descriptor.personId, entries);
  }
  for (const entries of episodesByPerson.values()) {
    entries.sort((left, right) => eventOrder(left.completionAction, right.completionAction)
      || left.episodeId.localeCompare(right.episodeId));
  }

  const decisions = [];
  const episodeStats = new Map(familyRelevantEpisodes.map((descriptor) => [descriptor.episodeId, {
    personId: descriptor.personId,
    episodeId: descriptor.episodeId,
    projectId: descriptor.project?.id ?? stringValue(descriptor.episode.projectId),
    desiredFunction: descriptor.episode.desiredFunction,
    decisions: 0,
    sourcedDecisions: 0,
    decisionsByType: emptyDecisionCounts(),
    linkedDecisionsByType: emptyDecisionCounts(),
  }]));

  for (const event of events) {
    if (event.kind !== 'decision') continue;
    const decision = asObject(event.decision);
    if (decision?.kind !== 'start' && decision?.kind !== 'revise') continue;
    const decisionType = reproductionDecisionType(decision.optionId);
    if (!decisionType) continue;
    const candidates = (episodesByPerson.get(event.who) ?? []).filter((descriptor) => {
      const observedAtMonth = integerValue(descriptor.episode.observedAtMonth);
      return observedAtMonth !== null
        && eventOrder(descriptor.completionAction, event) < 0
        && event.atMonth - observedAtMonth >= 0
        && event.atMonth - observedAtMonth <= 12;
    });
    const episode = candidates.at(-1);
    if (!episode) continue;

    const intent = stringValue(event.intentId) ? intentById.get(event.intentId) : undefined;
    const intentSourceFactIds = strings(intent?.sourceFactIds);
    const episodeSourceFactIds = unique([
      ...episode.triggerFactIds,
      ...episode.outcomeEventIds,
      ...episode.sourceFactIds,
    ]);
    const episodeSourceSet = new Set(episodeSourceFactIds);
    const linkedSourceFactIds = intentSourceFactIds.filter((eventId) => episodeSourceSet.has(eventId));
    const linked = linkedSourceFactIds.length > 0;
    const stats = episodeStats.get(episode.episodeId);
    stats.decisions += 1;
    stats.decisionsByType[decisionType] += 1;
    if (linked) {
      stats.sourcedDecisions += 1;
      stats.linkedDecisionsByType[decisionType] += 1;
    }
    decisions.push({
      decisionEventId: event.id,
      atMonth: event.atMonth,
      personId: event.who,
      optionType: decisionType,
      optionId: decision.optionId,
      intentId: stringValue(event.intentId),
      episodeId: episode.episodeId,
      projectId: episode.project?.id ?? stringValue(episode.episode.projectId),
      monthsAfterResolution: event.atMonth - episode.episode.observedAtMonth,
      intentResolved: Boolean(intent),
      linked,
      linkedSourceFactIds,
    });
  }

  const stats = [...episodeStats.values()];
  const decisionsByType = emptyDecisionCounts();
  const linkedDecisionsByType = emptyDecisionCounts();
  for (const entry of stats) {
    mergeCounts(decisionsByType, entry.decisionsByType);
    mergeCounts(linkedDecisionsByType, entry.linkedDecisionsByType);
  }
  const sourcedDecisions = decisions.filter((decision) => decision.linked).length;
  return {
    summary: {
      windowMonths: 12,
      eligibleEpisodes: stats.length,
      reproductionDecisions: decisions.length,
      sourcedReproductionDecisions: sourcedDecisions,
      sourceLinkRatio: ratio(sourcedDecisions, decisions.length),
      decisionsByType,
      linkedDecisionsByType,
      episodesWithAnyReproductionDecision: stats.filter((entry) => entry.decisions > 0).length,
      episodesWithSourcedReproductionDecision: stats.filter((entry) => entry.sourcedDecisions > 0).length,
      episodeDecisionRatio: ratio(stats.filter((entry) => entry.decisions > 0).length, stats.length),
      episodeSourcedDecisionRatio: ratio(stats.filter((entry) => entry.sourcedDecisions > 0).length, stats.length),
    },
    episodeStats: stats.filter((entry) => entry.decisions > 0),
    attributedDecisions: decisions,
  };
}

function auditRun(persisted) {
  const { meta, state } = persisted;
  const events = [...asArray(state.world?.past)].sort(eventOrder);
  const eventById = new Map(events.flatMap((event) => stringValue(event.id) ? [[event.id, event]] : []));
  const episodeAudit = projectEpisodeAudit(state, eventById);
  const outcomeAudit = goalOutcomeAudit(state, eventById);
  const decisionAudit = postResolutionReproductionAudit(state, events, episodeAudit.episodes);
  return {
    runId: meta.id,
    seed: integerValue(state.seed),
    elapsedMonths: integerValue(state.clock?.elapsedMonths),
    status: meta.status ?? state.civilization?.status ?? null,
    needResolutionAudit: {
      ...episodeAudit.summary,
      unresolvedSourceFacts: episodeAudit.unresolvedSourceFacts,
      mismatches: episodeAudit.mismatches,
    },
    goalOutcomeAudit: {
      ...outcomeAudit.summary,
      unresolvedSourceFacts: outcomeAudit.unresolvedSourceFacts,
      sourceMismatches: outcomeAudit.sourceMismatches,
      reproductionSemanticMismatches: outcomeAudit.reproductionSemanticMismatches,
    },
    postResolutionReproduction: decisionAudit,
  };
}

function aggregate(runs) {
  const counts = emptyOutcomeCounts();
  const reproductionCounts = emptyOutcomeCounts();
  const decisionsByType = emptyDecisionCounts();
  const linkedDecisionsByType = emptyDecisionCounts();
  const sums = {
    needResolutionEpisodes: 0,
    holders: 0,
    validEpisodes: 0,
    episodeUnresolvedSourceFacts: 0,
    episodeMismatches: 0,
    intentsWithoutGoalOutcome: 0,
    terminalIntentsWithoutGoalOutcome: 0,
    goalOutcomeSourceReferences: 0,
    resolvedGoalOutcomeSourceReferences: 0,
    goalOutcomeUnresolvedSourceFacts: 0,
    goalOutcomeSourceMismatches: 0,
    reproductionSemanticMismatches: 0,
    reproductionDecisions: 0,
    sourcedReproductionDecisions: 0,
    episodesWithAnyReproductionDecision: 0,
    episodesWithSourcedReproductionDecision: 0,
    familyRelevantNeedResolutionEpisodes: 0,
  };
  for (const run of runs) {
    const episode = run.needResolutionAudit;
    const goal = run.goalOutcomeAudit;
    const decisions = run.postResolutionReproduction.summary;
    sums.needResolutionEpisodes += episode.needResolutionEpisodes;
    sums.holders += episode.holders;
    sums.validEpisodes += episode.validEpisodes;
    sums.episodeUnresolvedSourceFacts += episode.unresolvedSourceFacts.length;
    sums.episodeMismatches += episode.mismatches.length;
    sums.intentsWithoutGoalOutcome += goal.intentsWithoutGoalOutcome;
    sums.terminalIntentsWithoutGoalOutcome += goal.terminalIntentsWithoutGoalOutcome;
    sums.goalOutcomeSourceReferences += goal.sourceReferences;
    sums.resolvedGoalOutcomeSourceReferences += goal.resolvedSourceReferences;
    sums.goalOutcomeUnresolvedSourceFacts += goal.unresolvedSourceFacts.length;
    sums.goalOutcomeSourceMismatches += goal.sourceMismatches.length;
    sums.reproductionSemanticMismatches += goal.reproduction.semanticMismatches;
    sums.reproductionDecisions += decisions.reproductionDecisions;
    sums.sourcedReproductionDecisions += decisions.sourcedReproductionDecisions;
    sums.episodesWithAnyReproductionDecision += decisions.episodesWithAnyReproductionDecision;
    sums.episodesWithSourcedReproductionDecision += decisions.episodesWithSourcedReproductionDecision;
    sums.familyRelevantNeedResolutionEpisodes += decisions.eligibleEpisodes;
    mergeCounts(counts, goal.counts);
    mergeCounts(reproductionCounts, goal.reproduction.counts);
    mergeCounts(decisionsByType, decisions.decisionsByType);
    mergeCounts(linkedDecisionsByType, decisions.linkedDecisionsByType);
  }
  const evaluatedReproductionOutcomes = reproductionCounts.achieved + reproductionCounts['attempted-unmet'];
  return {
    runs: runs.length,
    sums: {
      ...sums,
      goalOutcomes: counts,
      reproductionGoalOutcomes: reproductionCounts,
      reproductionDecisionsByType: decisionsByType,
      linkedReproductionDecisionsByType: linkedDecisionsByType,
    },
    ratios: {
      episodeIntegrity: ratio(sums.validEpisodes, sums.needResolutionEpisodes),
      goalOutcomeSourceResolution: ratio(
        sums.resolvedGoalOutcomeSourceReferences,
        sums.goalOutcomeSourceReferences,
      ),
      reproductionGoalSemanticIntegrity: ratio(
        evaluatedReproductionOutcomes - sums.reproductionSemanticMismatches,
        evaluatedReproductionOutcomes,
      ),
      reproductionDecisionSourceLink: ratio(
        sums.sourcedReproductionDecisions,
        sums.reproductionDecisions,
      ),
      episodesWithAnyReproductionDecision: ratio(
        sums.episodesWithAnyReproductionDecision,
        sums.familyRelevantNeedResolutionEpisodes,
      ),
      episodesWithSourcedReproductionDecision: ratio(
        sums.episodesWithSourcedReproductionDecision,
        sums.familyRelevantNeedResolutionEpisodes,
      ),
    },
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    throw error;
  }
  if (args.help) {
    usage();
    return;
  }

  const reader = await openSqliteRunReader();
  try {
    const metadata = await reader.store.list();
    const runIds = args.prefix
      ? metadata.filter((meta) => meta.id.startsWith(args.prefix)).map((meta) => meta.id).sort()
      : args.runIds;
    if (!runIds.length) throw new Error(`No runs matched ${args.prefix ? `prefix ${args.prefix}` : 'the supplied run IDs'}`);
    const runs = [];
    for (const runId of runIds) runs.push(auditRun(await reader.store.load(runId)));
    const result = {
      schemaVersion: 1,
      auditVersion: AUDIT_VERSION,
      generatedAt: new Date().toISOString(),
      source: {
        authority: 'Terminal SimulationState loaded from the existing SQLite database through sqlite-run-reader.mjs in read-only mode; no run is advanced or mutated.',
        dataDirectory: reader.store.dataDirectory(),
        databaseFile: reader.store.filePath(),
        selector: args.prefix ? { prefix: args.prefix } : { runIds },
      },
      method: {
        ordering: 'Events are ordered only by atMonth, orderInMonth, planningTick, then id.',
        projectResolution: 'Each person-local needResolutionEpisode must resolve to one completed project with matching need/function and exact trigger/completion sources; its latest completion ActionFact must be completed by that person.',
        goalOutcome: 'Intent lifecycle completion is audited separately from goal achievement. Reproduction attempted-unmet requires only conceived=false reproduce sources; achieved requires at least one conceived=true reproduce source, including a partner action for mirror intents.',
        postResolutionWindow: 'Each reproduction DecisionFact is attributed once to the same person\'s most recent earlier family-relevant need-resolution episode within 12 months. Family-relevant functions exactly match the authoritative readiness rule: settled-cultivation, reserve-storage, reliable-water, weather-shelter, and crop-processing. A sourced link exists only when that decision\'s persisted intent.sourceFactIds directly intersects the episode trigger/outcome/source fact IDs.',
        evidencePolicy: 'Only structured state fields and state.world.past references are causal evidence; result/reason/summary text and observer projections are ignored.',
      },
      aggregate: aggregate(runs),
      runs,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (args.outputPath) await writeFile(args.outputPath, serialized, 'utf8');
    else process.stdout.write(serialized);
  } finally {
    await reader.close();
  }
}

await main();
