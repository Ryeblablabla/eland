#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const PAIR_FIELDS = ['seed', 'years', 'repeat'];
const IGNORED_NUMERIC_FIELDS = new Set(['seed', 'years', 'repeat', 'months']);
const CATEGORICAL_FIELDS = ['status', 'endedEarly', 'outcomeKind'];
const OBSERVER_PREFIXES = ['civilizationIndex', 'civilizationComponents.'];
const METRIC_PRIORITY = [
  'finalPopulation', 'births', 'reproductionOffers', 'reproductionAcceptances',
  'reproductionAttempts', 'reproductionConceptions', 'deaths', 'childDeaths',
  'relationshipProposalOffers', 'relationshipProposalUniqueBases',
  'relationshipProposalRepeatedBases', 'relationshipProposalOffersWithoutBasis',
  'relationshipProposalRepeatedDirectedPairs', 'relationshipProposalMaxPerDirectedPair',
  'childExposureDeaths', 'lifeReviewDecisions', 'projectLifeReviewDecisions',
  'lifeReviewPersonMonths', 'lifeReviewSameMonthDuplicates',
  'lifeReviewUniqueBases', 'lifeReviewRepeatedBases',
  'interruptedIntentChildren', 'interruptLifeReviewChildren',
  'interruptRequiredResponseChildren', 'interruptFulfillmentChildren',
  'interruptChildrenCompleted', 'interruptChildrenBlocked',
  'interruptChildrenFailed', 'interruptChildrenAbandoned',
  'interruptReturnsResumed', 'interruptReturnsParentCompleted',
  'interruptReturnsParentBlocked', 'interruptReturnsParentUnavailable',
  'interruptUnresolvedTerminalChildren', 'interruptChildrenWithProjectId',
  'orphanSuspendedProjectIntents', 'interruptReturnLatencyMeanMonths',
  'interruptReturnLatencyMaxMonths',
  'interruptResumedParentsWithSubsequentAction',
  'interruptResumedParentsWithoutSubsequentAction',
  'interruptImmediateSameProjectReplacements',
  'completedActions', 'actionPersonMonths',
  'projectActionPersonMonths', 'projectActionMonthShare', 'ruleDecisions',
  'modelDecisions', 'inputTokens', 'outputTokens', 'strategicShare',
  'strategicIntents', 'socialIntents', 'communications', 'survivalReflexActions',
  'projectsStarted', 'projectsCompleted', 'projectsBlocked',
  'projectPressureBasisProjects', 'projectPressureBasisCoverage',
  'projectPressureHistoryEntries', 'projectsWithPressureUpdates', 'projectPressureUpdates',
  'projectPressureIncreases', 'projectPressureDecreases', 'projectPressureUnchangedUpdates',
  'projectPressureDuplicateBasisEntries', 'projectPressureUnresolvedSourceFacts',
  'huntingPressureCrossOwnerSources', 'huntingPressureNonThreatAnimalSources',
  'projectPressureChangesWithoutEdgeChange', 'projectPressureObserverMismatches',
  'projectPressureUpdatesThermalSafety', 'projectPressureUpdatesHuntingSafety',
  'projectPressureUpdatesCareCapability', 'projectPressureUpdatesFoodPreparation',
  'projectPressureUpdatesShelterCapacity', 'projectPressureUpdatesKnowledgePreservation',
  'projectProgressEvidenceCount', 'projectProgressProjects',
  'projectLogisticsAdvanceProgress', 'projectMaterialContributionProgress',
  'projectProgressDuplicateEvents', 'projectProgressUnresolvedEvents',
  'projectProgressActorMismatches', 'projectProgressEpisodeMismatches',
  'projectProgressIntentMismatches', 'projectProgressNonAdvancingLogistics',
  'projectProgressEventsAfterTermination', 'projectStagnationBlocksWithRecentProgress',
  'projectTerminalMonthCoverage', 'projectsBlockedAfterLogisticsProgress',
  'projectSearchCampaigns', 'projectsWithSearchCampaigns',
  'searchCampaignActive', 'searchCampaignExhausted', 'searchCampaignSuperseded', 'searchCampaignClosed',
  'searchCampaignAttemptedTargets', 'searchCampaignMaxTargets',
  'searchCampaignEpisodeCoverage', 'searchEpisodesMissingCampaign',
  'searchCampaignRepeatedTargets', 'searchCampaignDuplicateBasis',
  'searchCampaignTargetOutsideArea', 'searchCampaignEpisodeTargetNotAttempted',
  'searchCampaignProjectMismatches', 'searchCampaignOwnerMismatches',
  'searchCampaignActorMismatches', 'searchCampaignMaterialMismatches',
  'searchCampaignUnresolvedSourceFacts',
  'projectLogisticsEpisodes', 'projectLogisticsFulfilled',
  'projectLogisticsExhausted', 'projectSearchEpisodes', 'projectDropEpisodes',
  'projectLogisticsActionEvents',
  'jointProjectsCompleted', 'productionProjectsCompleted',
  'constructionProjectsCompleted', 'totalStructures', 'completedStructures',
  'constructionPlacements', 'containersBuilt', 'standingContainers',
  'containerTransfers', 'storedUnits', 'movementActions', 'movementActionShare',
  'spearsCrafted', 'leatherClothingCrafted', 'herbalMedicineCrafted',
  'cookedFoodProduced', 'recordsCreated', 'functionalInstitutions',
  'animalsHunted', 'animalAttacks', 'wildlifePopulation',
  'predictionAccuracy', 'dehydrationHibernations', 'assistedDependentHibernations', 'throughMonth',
  'initialPopulation',
];

const HELP = `Compare two run_matrix.mjs artifacts by matched seed, years, and repeat.

Usage:
  node compare_matrices.mjs --baseline PATH --candidate PATH [options]

Options:
  --baseline PATH                       Baseline matrix JSON (required)
  --candidate PATH                      Candidate matrix JSON (required)
  --format text|json                    Output format (default: text)
  --out PATH                            Also write the rendered result to PATH
  --same-civilization-index-formula     Assert that both artifacts used the
                                        exact same civilization-index formula
  --help                                Show this help

Civilization-index deltas are quarantined as observer-only evidence unless both
artifacts declare the same formula version or the explicit assertion is given.`;

function parseArgs(argv) {
  const values = {};
  const flags = new Set(['help', 'same-civilization-index-formula']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    if (flags.has(key)) values[key] = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
      values[key] = value;
      index += 1;
    }
  }
  return values;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function describe(values) {
  return {
    count: values.length,
    median: round(median(values)),
    mean: round(mean(values)),
    min: values.length ? round(Math.min(...values)) : null,
    max: values.length ? round(Math.max(...values)) : null,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function equalValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function pairKey(run) {
  return PAIR_FIELDS.map((field) => String(run[field])).join('\u0000');
}

function pairLabel(run) {
  return `seed=${run.seed}, years=${run.years}, repeat=${run.repeat}`;
}

function validateMatrix(matrix, label, path) {
  if (!matrix || typeof matrix !== 'object' || !Array.isArray(matrix.runs)) {
    throw new Error(`${label} ${path} is not a run_matrix.mjs artifact: missing runs array`);
  }
  for (const [index, run] of matrix.runs.entries()) {
    for (const field of PAIR_FIELDS) {
      if (run[field] === undefined || run[field] === null) {
        throw new Error(`${label} run ${index + 1} is missing pairing field ${field}`);
      }
    }
  }
}

function indexRuns(runs, label) {
  const result = new Map();
  for (const run of runs) {
    const key = pairKey(run);
    if (result.has(key)) {
      throw new Error(`${label} contains duplicate pair key: ${pairLabel(run)}`);
    }
    result.set(key, run);
  }
  return result;
}

function flattenLeaves(value, prefix = '', result = new Map()) {
  if (value === null || value === undefined) return result;
  if (Array.isArray(value)) {
    result.set(prefix, { kind: 'array', value });
    return result;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      flattenLeaves(child, path, result);
    }
    return result;
  }
  result.set(prefix, { kind: typeof value, value });
  return result;
}

function numericLeaves(run) {
  const leaves = flattenLeaves(run);
  const result = new Map();
  for (const [path, leaf] of leaves) {
    if (leaf.kind === 'number' && Number.isFinite(leaf.value) && !IGNORED_NUMERIC_FIELDS.has(path)) {
      result.set(path, leaf.value);
    }
  }
  return result;
}

function isObserverMetric(path) {
  return OBSERVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

function sortMetrics(paths) {
  const priority = new Map(METRIC_PRIORITY.map((path, index) => [path, index]));
  return [...paths].sort((left, right) => {
    const leftRank = priority.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = priority.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right, 'en');
  });
}

function formulaVersion(matrix) {
  return matrix.metricVersions?.civilizationIndex
    ?? matrix.experiment?.metricVersions?.civilizationIndex
    ?? matrix.civilizationIndexFormulaVersion
    ?? matrix.experiment?.civilizationIndexFormulaVersion
    ?? null;
}

function formulaComparability(baseline, candidate, assertedSame) {
  const baselineVersion = formulaVersion(baseline);
  const candidateVersion = formulaVersion(candidate);
  if (baselineVersion !== null && candidateVersion !== null) {
    if (String(baselineVersion) === String(candidateVersion)) {
      return {
        status: 'declared-same', baselineVersion, candidateVersion,
        engineAttributionAllowed: true,
        note: 'Both artifacts declare the same civilization-index formula version.',
      };
    }
    return {
      status: 'version-mismatch', baselineVersion, candidateVersion,
      engineAttributionAllowed: false,
      note: 'Formula versions differ; civilization-index deltas are observer-only and cannot demonstrate an engine improvement.',
    };
  }
  if (assertedSame) {
    return {
      status: 'asserted-same', baselineVersion, candidateVersion,
      engineAttributionAllowed: true,
      note: 'The caller explicitly asserted that the exact same civilization-index formula was used.',
    };
  }
  return {
    status: 'unverified', baselineVersion, candidateVersion,
    engineAttributionAllowed: false,
    note: 'Formula provenance is absent or incomplete; civilization-index deltas are shown separately and excluded from engine evidence.',
  };
}

function compareConfiguration(baseline, candidate) {
  const ignored = new Set(['prefix', 'baseUrl', 'seeds', 'years', 'repeats']);
  const left = baseline.experiment ?? {};
  const right = candidate.experiment ?? {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => !ignored.has(key))
    .sort();
  const differences = keys
    .filter((key) => !equalValue(left[key], right[key]))
    .map((key) => ({ field: key, baseline: left[key] ?? null, candidate: right[key] ?? null }));
  return { matched: differences.length === 0, differences };
}

function summarizeMetric(pairs, path) {
  const rows = [];
  for (const pair of pairs) {
    const baseline = pair.baselineNumeric.get(path);
    const candidate = pair.candidateNumeric.get(path);
    if (Number.isFinite(baseline) && Number.isFinite(candidate)) {
      rows.push({ baseline, candidate, difference: candidate - baseline });
    }
  }
  if (!rows.length) return null;
  const baselineValues = rows.map((row) => row.baseline);
  const candidateValues = rows.map((row) => row.candidate);
  const differences = rows.map((row) => row.difference);
  return {
    comparablePairs: rows.length,
    baseline: describe(baselineValues),
    candidate: describe(candidateValues),
    candidateMinusBaseline: {
      medianOfPairedDifferences: round(median(differences)),
      meanOfPairedDifferences: round(mean(differences)),
      differenceOfMedians: round(median(candidateValues) - median(baselineValues)),
      differenceOfMeans: round(mean(candidateValues) - mean(baselineValues)),
      min: round(Math.min(...differences)),
      max: round(Math.max(...differences)),
    },
  };
}

function milestoneSummary(pairs) {
  const ids = new Set();
  for (const pair of pairs) {
    for (const id of pair.baseline.milestoneIds ?? []) ids.add(String(id));
    for (const id of pair.candidate.milestoneIds ?? []) ids.add(String(id));
  }
  return Object.fromEntries([...ids].sort((left, right) => left.localeCompare(right, 'en', { numeric: true })).map((id) => {
    const baselineCount = pairs.filter((pair) => (pair.baseline.milestoneIds ?? []).map(String).includes(id)).length;
    const candidateCount = pairs.filter((pair) => (pair.candidate.milestoneIds ?? []).map(String).includes(id)).length;
    return [id, {
      baselineOccurrences: baselineCount,
      candidateOccurrences: candidateCount,
      baselineRate: pairs.length ? round(baselineCount / pairs.length * 100) : null,
      candidateRate: pairs.length ? round(candidateCount / pairs.length * 100) : null,
      percentagePointDifference: pairs.length ? round((candidateCount - baselineCount) / pairs.length * 100) : null,
    }];
  }));
}

function buildFieldCoverage(pairs) {
  const paths = new Set();
  for (const pair of pairs) {
    for (const path of pair.baselineNumeric.keys()) paths.add(path);
    for (const path of pair.candidateNumeric.keys()) paths.add(path);
  }
  const coverage = [];
  for (const path of sortMetrics(paths)) {
    let baselineNumeric = 0;
    let candidateNumeric = 0;
    let comparablePairs = 0;
    for (const pair of pairs) {
      const hasBaseline = pair.baselineNumeric.has(path);
      const hasCandidate = pair.candidateNumeric.has(path);
      if (hasBaseline) baselineNumeric += 1;
      if (hasCandidate) candidateNumeric += 1;
      if (hasBaseline && hasCandidate) comparablePairs += 1;
    }
    coverage.push({ field: path, baselineNumeric, candidateNumeric, comparablePairs });
  }
  return coverage;
}

function coverageReason(item, totalPairs) {
  if (item.baselineNumeric === 0) return 'missing from every matched baseline run; no zero value is inferred';
  if (item.candidateNumeric === 0) return 'missing from every matched candidate run; no zero value is inferred';
  if (item.comparablePairs < totalPairs) return `partial coverage: comparable in ${item.comparablePairs}/${totalPairs} matched pairs`;
  return null;
}

function buildComparison(baseline, candidate, paths, assertedSame) {
  const baselineIndex = indexRuns(baseline.runs, 'baseline');
  const candidateIndex = indexRuns(candidate.runs, 'candidate');
  const commonKeys = [...baselineIndex.keys()].filter((key) => candidateIndex.has(key));
  const unmatchedBaseline = [...baselineIndex.entries()]
    .filter(([key]) => !candidateIndex.has(key))
    .map(([, run]) => ({ runId: run.runId ?? null, seed: run.seed, years: run.years, repeat: run.repeat }));
  const unmatchedCandidate = [...candidateIndex.entries()]
    .filter(([key]) => !baselineIndex.has(key))
    .map(([, run]) => ({ runId: run.runId ?? null, seed: run.seed, years: run.years, repeat: run.repeat }));
  const pairs = commonKeys.map((key) => {
    const baselineRun = baselineIndex.get(key);
    const candidateRun = candidateIndex.get(key);
    return {
      baseline: baselineRun,
      candidate: candidateRun,
      baselineNumeric: numericLeaves(baselineRun),
      candidateNumeric: numericLeaves(candidateRun),
    };
  }).sort((left, right) => left.baseline.years - right.baseline.years
    || left.baseline.seed - right.baseline.seed
    || left.baseline.repeat - right.baseline.repeat);

  const formula = formulaComparability(baseline, candidate, assertedSame);
  const fieldCoverage = buildFieldCoverage(pairs);
  const incomparableFields = fieldCoverage
    .map((item) => ({ ...item, reason: coverageReason(item, pairs.length) }))
    .filter((item) => item.reason);
  const fullyComparable = fieldCoverage.filter((item) => !coverageReason(item, pairs.length));
  const engineFields = fullyComparable.map((item) => item.field).filter((field) => !isObserverMetric(field));
  const observerFields = fullyComparable.map((item) => item.field).filter(isObserverMetric);
  const years = [...new Set(pairs.map((pair) => pair.baseline.years))].sort((left, right) => left - right);

  const summariesByYears = years.map((year) => {
    const yearPairs = pairs.filter((pair) => pair.baseline.years === year);
    return {
      years: year,
      pairCount: yearPairs.length,
      engineMetrics: Object.fromEntries(engineFields.map((field) => [field, summarizeMetric(yearPairs, field)]).filter(([, value]) => value)),
      observerMetrics: Object.fromEntries(observerFields.map((field) => [field, summarizeMetric(yearPairs, field)]).filter(([, value]) => value)),
      milestoneOccurrence: milestoneSummary(yearPairs),
    };
  });

  const pairResults = pairs.map((pair) => {
    const baselineMilestones = new Set((pair.baseline.milestoneIds ?? []).map(String));
    const candidateMilestones = new Set((pair.candidate.milestoneIds ?? []).map(String));
    const differences = Object.fromEntries(engineFields.map((field) => [
      field,
      round(pair.candidateNumeric.get(field) - pair.baselineNumeric.get(field)),
    ]));
    const observerDifferences = Object.fromEntries(observerFields.map((field) => [
      field,
      round(pair.candidateNumeric.get(field) - pair.baselineNumeric.get(field)),
    ]));
    const categoricalTransitions = Object.fromEntries(CATEGORICAL_FIELDS
      .filter((field) => pair.baseline[field] !== undefined || pair.candidate[field] !== undefined)
      .map((field) => [field, {
        baseline: pair.baseline[field] ?? null,
        candidate: pair.candidate[field] ?? null,
        changed: !equalValue(pair.baseline[field], pair.candidate[field]),
      }]));
    return {
      seed: pair.baseline.seed,
      years: pair.baseline.years,
      repeat: pair.baseline.repeat,
      baselineRunId: pair.baseline.runId ?? null,
      candidateRunId: pair.candidate.runId ?? null,
      differences,
      observerMetricDifferences: observerDifferences,
      categoricalTransitions,
      milestones: {
        added: [...candidateMilestones].filter((id) => !baselineMilestones.has(id)).sort(),
        removed: [...baselineMilestones].filter((id) => !candidateMilestones.has(id)).sort(),
      },
    };
  });

  const configuration = compareConfiguration(baseline, candidate);
  const warnings = [];
  if (!configuration.matched) warnings.push('Experiment configuration fields differ; causal attribution is confounded until those differences are justified.');
  if (unmatchedBaseline.length || unmatchedCandidate.length) warnings.push('Unmatched runs are excluded; do not compare unpaired aggregate rows as an A/B result.');
  if (!formula.engineAttributionAllowed) warnings.push(formula.note);
  if (incomparableFields.length) warnings.push('Missing numeric fields are reported as incomparable and are never coerced to zero.');
  if (pairs.length < 3) warnings.push('Fewer than three matched pairs are available; treat this as a case study rather than ordinary rule-change evidence.');
  if (years.length === 1) warnings.push('Only one horizon is represented; cross-cutting changes should normally include at least two causal horizons.');

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseline: {
      path: paths.baseline,
      prefix: baseline.experiment?.prefix ?? null,
      generatedAt: baseline.generatedAt ?? null,
      runCount: baseline.runs.length,
    },
    candidate: {
      path: paths.candidate,
      prefix: candidate.experiment?.prefix ?? null,
      generatedAt: candidate.generatedAt ?? null,
      runCount: candidate.runs.length,
    },
    pairing: {
      keyFields: PAIR_FIELDS,
      matchedPairs: pairs.length,
      matchedPairsByYears: Object.fromEntries(years.map((year) => [year, pairs.filter((pair) => pair.baseline.years === year).length])),
      unmatchedBaseline,
      unmatchedCandidate,
    },
    configuration,
    civilizationIndexComparability: formula,
    summariesByYears,
    pairs: pairResults,
    incomparableFields,
    warnings,
  };
}

function formatNumber(value, signed = false) {
  if (value === null || value === undefined) return 'n/a';
  const formatted = Number.isInteger(value) ? String(value) : String(round(value));
  return signed && value > 0 ? `+${formatted}` : formatted;
}

function renderMetric(field, summary) {
  const delta = summary.candidateMinusBaseline;
  return `  ${field}: B med/mean ${formatNumber(summary.baseline.median)}/${formatNumber(summary.baseline.mean)}; C ${formatNumber(summary.candidate.median)}/${formatNumber(summary.candidate.mean)}; paired Δ med/mean ${formatNumber(delta.medianOfPairedDifferences, true)}/${formatNumber(delta.meanOfPairedDifferences, true)} (${summary.comparablePairs} pairs)`;
}

function renderText(result) {
  const lines = [
    'Paired evolution matrix comparison',
    `Baseline: ${result.baseline.prefix ?? '(unnamed)'} (${result.baseline.runCount} runs)`,
    `Candidate: ${result.candidate.prefix ?? '(unnamed)'} (${result.candidate.runCount} runs)`,
    `Matched by seed+years+repeat: ${result.pairing.matchedPairs}; unmatched B/C: ${result.pairing.unmatchedBaseline.length}/${result.pairing.unmatchedCandidate.length}`,
    `Configuration: ${result.configuration.matched ? 'matched' : 'DIFFERENT'}`,
    `Civilization index: ${result.civilizationIndexComparability.status}; ${result.civilizationIndexComparability.note}`,
  ];

  for (const summary of result.summariesByYears) {
    lines.push('', `${summary.years} years (${summary.pairCount} matched pairs)`, 'Engine-comparable numeric metrics:');
    for (const [field, metric] of Object.entries(summary.engineMetrics)) lines.push(renderMetric(field, metric));
    lines.push('Observer metrics (descriptive; attribution follows formula status above):');
    for (const [field, metric] of Object.entries(summary.observerMetrics)) lines.push(renderMetric(field, metric));
  }

  lines.push('', 'Per-pair candidate-minus-baseline differences:');
  for (const pair of result.pairs) {
    const engine = Object.entries(pair.differences).map(([field, value]) => `${field}=${formatNumber(value, true)}`).join(', ');
    const observer = Object.entries(pair.observerMetricDifferences).map(([field, value]) => `${field}=${formatNumber(value, true)}`).join(', ');
    const milestones = `milestones +[${pair.milestones.added.join(',')}] -[${pair.milestones.removed.join(',')}]`;
    lines.push(`  seed=${pair.seed} years=${pair.years} repeat=${pair.repeat}: ${engine}`);
    if (observer) lines.push(`    observer-only: ${observer}`);
    lines.push(`    ${milestones}`);
  }

  if (result.incomparableFields.length) {
    lines.push('', 'Incomparable or partially comparable numeric fields:');
    for (const item of result.incomparableFields) lines.push(`  ${item.field}: ${item.reason}`);
  }
  if (result.configuration.differences.length) {
    lines.push('', 'Configuration differences:');
    for (const item of result.configuration.differences) lines.push(`  ${item.field}: B=${JSON.stringify(item.baseline)} C=${JSON.stringify(item.candidate)}`);
  }
  if (result.warnings.length) {
    lines.push('', 'Warnings:');
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (!args.baseline || !args.candidate) throw new Error('--baseline and --candidate are required');
  const format = args.format ?? 'text';
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
  const baselinePath = resolve(String(args.baseline));
  const candidatePath = resolve(String(args.candidate));
  const [baseline, candidate] = await Promise.all([
    readFile(baselinePath, 'utf8').then(JSON.parse),
    readFile(candidatePath, 'utf8').then(JSON.parse),
  ]);
  validateMatrix(baseline, 'baseline', baselinePath);
  validateMatrix(candidate, 'candidate', candidatePath);
  const result = buildComparison(
    baseline,
    candidate,
    { baseline: baselinePath, candidate: candidatePath },
    Boolean(args['same-civilization-index-formula']),
  );
  const output = format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderText(result);
  if (args.out) {
    const outputPath = resolve(String(args.out));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, 'utf8');
  }
  process.stdout.write(output);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
