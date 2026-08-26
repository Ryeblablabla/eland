import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-bounded-observer-hot-shell-'));

function component(score, weight, prefix) {
  const evidence = {};
  for (let index = 0; index < 5_000; index += 1) {
    evidence[`${prefix}-${String(index).padStart(5, '0')}`] = index / 10;
  }
  return { score, weight, evidence };
}

function exactInput(api) {
  const civilizationIndex = {
    formulaVersion: 'civilization-index-v6',
    total: 73.25,
    calculatedAtMonth: 7_260,
    components: {
      population: component(71, 0.22, 'population'),
      territory: component(72, 0.18, 'territory'),
      technology: component(82, 0.24, 'technology'),
      social: component(67, 0.20, 'social'),
      history: component(70, 0.16, 'history'),
    },
  };
  const derivedPoison = Array.from({ length: 128 }, (_, index) => ({
    id: `poison-${index}`,
    eventIds: Array.from({ length: 32 }, (_unused, eventIndex) => `event-${index}-${eventIndex}`),
    payload: 'x'.repeat(256),
  }));
  return {
    source: {
      stateHash: 'a'.repeat(64),
      revision: 606,
      month: 7_260,
    },
    civilization: {
      number: 141,
      status: 'running',
      stage: '古代文明 / exact observer snapshot',
      epoch: 'stable',
      era: {
        sequence: 57,
        kind: 'stable',
        sinceMonth: 7_240,
        endsAtMonth: 7_280,
        dominantClimate: 'temperate',
      },
      climate: { kind: 'temperate', severity: 1.25, sinceMonth: 7_240 },
      weather: { kind: 'rain', intensity: 0.75, sinceMonth: 7_259 },
      externalClimate: {
        epoch: 'chaotic',
        kind: 'fire',
        severity: 2.5,
        terminalCatastrophe: 'triple-sun-vaporization',
      },
      conditions: {
        civilizationNo: 141,
        climateBias: 'balanced',
        chaosIntensity: 1.2,
        endpoint: { kind: 'months', value: 12_000 },
        characterIds: ['observer-a', 'observer-b'],
      },
      civilizationIndex,
      development: {
        observerVersion: 'material-institution-era-v6',
        currentEra: 'ancient-civilization',
        historicalPeakEra: 'ancient-civilization',
        candidateEra: 'ancient-civilization',
        candidateSinceMonth: 7_200,
        transitionProgress: 1,
        satisfiedGateIds: Array.from({ length: 1_024 }, (_, index) => `gate-${index}`),
        missingGateIds: [],
        supportingEventIds: Array.from({ length: 5_000 }, (_, index) => `support-${index}`),
        materialCapabilities: [],
      },
      outcome: {
        kind: 'boundary',
        cause: 'fixture boundary',
        atMonth: 7_260,
        summary: 'fixture remains running for hot-shell validation',
      },
    },
    derived: {
      practices: structuredClone(derivedPoison),
      institutions: structuredClone(derivedPoison),
      milestones: Array.from({ length: 47 }, (_, index) => ({
        id: `milestone-${index}`,
        evidenceEventIds: Array.from({ length: 256 }, (_unused, evidenceIndex) => (
          `milestone-evidence-${index}-${evidenceIndex}`
        )),
      })),
      regions: structuredClone(derivedPoison),
      structures: structuredClone(derivedPoison),
      functionalBuildings: structuredClone(derivedPoison),
    },
    api,
  };
}

function explicitInput(exact) {
  return {
    source: exact.source,
    civilization: exact.civilization,
    lastMaterializedMilestoneCount: exact.derived.milestones.length,
  };
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(
    entry,
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-hot-shell.ts'))};\n`,
  );
  const output = path.join(temporaryDirectory, 'fixture.mjs');
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
  const fixture = exactInput(api);
  delete fixture.api;
  const before = structuredClone(fixture);
  const shell = api.materializeBoundedObserverHotShellFromExactObservations(fixture);
  const explicitShell = api.materializeBoundedObserverHotShell(explicitInput(fixture));

  assert.deepEqual(fixture, before, 'materializer must not mutate the exact observer input');
  assert.deepEqual(
    explicitShell,
    shell,
    'opaque-derived primary entry and exact-observations convenience entry must agree',
  );
  assert.doesNotThrow(() => api.assertCanonicalBoundedObserverHotShell(shell));
  assert.doesNotThrow(() => api.assertLastMaterializedObserverBasis(
    shell.lastMaterializedObserverBasis,
  ));
  assert.doesNotThrow(() => api.assertGameplayCivilizationPreserved(
    fixture.civilization,
    shell.civilization,
  ));

  const {
    civilizationIndex: _exactIndex,
    development: _development,
    ...exactGameplayCivilization
  } = fixture.civilization;
  const {
    civilizationIndex: hotIndex,
    ...hotGameplayCivilization
  } = shell.civilization;
  assert.deepEqual(
    hotGameplayCivilization,
    exactGameplayCivilization,
    'all gameplay-owned civilization fields must be preserved exactly',
  );
  assert.equal(Object.hasOwn(shell.civilization, 'development'), false);
  assert.deepEqual(Object.keys(shell.derived).sort(), [
    'institutions', 'milestones', 'practices', 'regions', 'structures',
  ]);
  assert.equal(Object.hasOwn(shell.derived, 'functionalBuildings'), false);
  for (const values of Object.values(shell.derived)) assert.deepEqual(values, []);

  assert.equal(hotIndex.formulaVersion, fixture.civilization.civilizationIndex.formulaVersion);
  assert.equal(hotIndex.total, fixture.civilization.civilizationIndex.total);
  assert.equal(hotIndex.calculatedAtMonth, fixture.civilization.civilizationIndex.calculatedAtMonth);
  for (const key of ['population', 'territory', 'technology', 'social', 'history']) {
    assert.equal(
      hotIndex.components[key].score,
      fixture.civilization.civilizationIndex.components[key].score,
    );
    assert.equal(
      hotIndex.components[key].weight,
      fixture.civilization.civilizationIndex.components[key].weight,
    );
    assert.deepEqual(hotIndex.components[key].evidence, {}, `${key} evidence must be cleared`);
  }

  assert.deepEqual(shell.lastMaterializedObserverBasis, {
    version: 2,
    profile: api.BOUNDED_OBSERVER_HOT_SHELL_PROFILE,
    source: fixture.source,
    milestoneCount: 47,
    stage: fixture.civilization.stage,
    indexSnapshot: hotIndex,
    developmentSnapshot: {
      observerVersion: 'material-institution-era-v6',
      currentEra: 'ancient-civilization',
      historicalPeakEra: 'ancient-civilization',
      candidateEra: 'ancient-civilization',
      candidateSinceMonth: 7_200,
    },
  });
  assert.notEqual(
    shell.lastMaterializedObserverBasis.indexSnapshot,
    shell.civilization.civilizationIndex,
    'basis snapshot must not alias the mutable gameplay hot index',
  );
  assert.ok(Object.isFrozen(shell.lastMaterializedObserverBasis));
  assert.ok(Object.isFrozen(shell.lastMaterializedObserverBasis.indexSnapshot));
  assert.ok(Object.isFrozen(shell.lastMaterializedObserverBasis.developmentSnapshot));

  shell.civilization.conditions.endpoint.value = 12_001;
  shell.civilization.civilizationIndex.components.population.score = 99;
  assert.equal(fixture.civilization.conditions.endpoint.value, 12_000);
  assert.equal(fixture.civilization.civilizationIndex.components.population.score, 71);
  assert.equal(shell.lastMaterializedObserverBasis.indexSnapshot.components.population.score, 71);

  const invalidHash = structuredClone(before);
  invalidHash.source.stateHash = 'A'.repeat(64);
  assert.throws(
    () => api.materializeBoundedObserverHotShell(explicitInput(invalidHash)),
    /小写 SHA-256/u,
  );
  const unsafeRevision = structuredClone(before);
  unsafeRevision.source.revision = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => api.materializeBoundedObserverHotShell(explicitInput(unsafeRevision)),
    /revision.*非负安全整数/u,
  );
  const negativeMonth = structuredClone(before);
  negativeMonth.source.month = -1;
  assert.throws(
    () => api.materializeBoundedObserverHotShell(explicitInput(negativeMonth)),
    /month.*非负安全整数/u,
  );

  const oversizedStage = structuredClone(before);
  oversizedStage.civilization.stage = '界'.repeat(
    Math.floor(api.MAX_BOUNDED_OBSERVER_STAGE_UTF8_BYTES / 3) + 1,
  );
  assert.throws(
    () => api.materializeBoundedObserverHotShell(explicitInput(oversizedStage)),
    /UTF-8 4096 字节硬上限/u,
    'oversized stage must fail closed rather than truncate',
  );
  const malformedUnicode = structuredClone(before);
  malformedUnicode.civilization.stage = '\ud800';
  assert.throws(
    () => api.materializeBoundedObserverHotShell(explicitInput(malformedUnicode)),
    /未配对 UTF-16 surrogate/u,
  );
  const invalidShape = structuredClone(before);
  invalidShape.civilization.forgedObserverReward = 1;
  assert.throws(
    () => api.materializeBoundedObserverHotShell(explicitInput(invalidShape)),
    /未知字段 forgedObserverReward/u,
  );

  const forgedCanonical = structuredClone(api.materializeBoundedObserverHotShell(explicitInput(before)));
  forgedCanonical.derived.functionalBuildings = [];
  assert.throws(
    () => api.assertCanonicalBoundedObserverHotShell(forgedCanonical),
    /未知字段 functionalBuildings/u,
  );
  const mismatchedBasis = structuredClone(api.materializeBoundedObserverHotShell(explicitInput(before)));
  mismatchedBasis.lastMaterializedObserverBasis.stage = 'forged-stage';
  assert.throws(
    () => api.assertCanonicalBoundedObserverHotShell(mismatchedBasis),
    /last-materialized basis 不一致/u,
  );

  const heapLimit = getHeapStatistics().heap_size_limit;
  assert.match(
    process.env.NODE_OPTIONS ?? '',
    /(?:^|\s)--max-old-space-size=256(?:\s|$)/u,
    'fixture must run with a 256MB V8 old-space cap',
  );
  const memory = process.memoryUsage();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    profile: api.BOUNDED_OBSERVER_HOT_SHELL_PROFILE,
    milestoneCount: shell.lastMaterializedObserverBasis.milestoneCount,
    stageUtf8Limit: api.MAX_BOUNDED_OBSERVER_STAGE_UTF8_BYTES,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes: heapLimit,
  })}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
