import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { build } from 'esbuild';
import {
  openSqliteRunReader,
  PROJECT_DIRECTORY,
  RUN_DATA_DIRECTORY,
} from '/tmp/eland-gen5-v6.txS4lV/three-body/scripts/sqlite-run-reader.mjs';

const SOURCE_ID = 'candidate-gen5-social-v5f-20260821-s20260815-y100-r1';
const TARGET_ID = 'candidate-gen5-social-v6b-cont-20260821-s20260815-m948-y200-r1';
const TARGET_LABEL = 'candidate-gen5-social-v6b-cont-20260821 seed=20260815 from=948 through=2400';
const SOURCE_MONTH = 948;
const SOURCE_ENDPOINT = 1200;
const TARGET_ENDPOINT = 2400;
const NORMALIZATION_MANIFEST = '/Users/wangyu.rye/Desktop/eland/three-body/data/experiments/candidate-gen5-social-v5f-cont-20260821-s20260815-m948-y200-r1-continuation-manifest.json';

function leafDifferences(source, target) {
  const differences = [];
  const walk = (left, right, currentPath) => {
    if (isDeepStrictEqual(left, right)) return;
    if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
      differences.push({ path: currentPath, kind: 'binary', source: left?.byteLength, target: right?.byteLength });
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) differences.push({ path: `${currentPath}.length`, kind: 'value', source: left.length, target: right.length });
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        if (index >= left.length) differences.push({ path: `${currentPath}[${index}]`, kind: 'added', target: right[index] });
        else if (index >= right.length) differences.push({ path: `${currentPath}[${index}]`, kind: 'missing', source: left[index] });
        else walk(left[index], right[index], `${currentPath}[${index}]`);
      }
      return;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const childPath = currentPath ? `${currentPath}.${key}` : key;
        if (!Object.hasOwn(left, key)) differences.push({ path: childPath, kind: 'added', target: right[key] });
        else if (!Object.hasOwn(right, key)) differences.push({ path: childPath, kind: 'missing', source: left[key] });
        else walk(left[key], right[key], childPath);
      }
      return;
    }
    differences.push({ path: currentPath, kind: 'value', source: left, target: right });
  };
  walk(source, target, '');
  return differences;
}

const normalizationManifest = JSON.parse(await readFile(NORMALIZATION_MANIFEST, 'utf8'));
const allowedBackfills = new Map(normalizationManifest.stateDifferenceAudit.historicalIntentAgreementIdBackfills.map((item) => [
  item.path,
  { agreementId: item.agreementId, status: item.status },
]));
assert.equal(allowedBackfills.size, 27);

const reader = await openSqliteRunReader();
let source;
try {
  assert.equal((await reader.store.list()).some((run) => run.id === TARGET_ID), false, `target already exists: ${TARGET_ID}`);
  source = await reader.store.load(SOURCE_ID);
} finally {
  await reader.close();
}

assert.equal(await realpath(PROJECT_DIRECTORY), await realpath('/tmp/eland-gen5-v6.txS4lV/three-body'));
assert.equal(source.state.clock.elapsedMonths, SOURCE_MONTH);
assert.equal(source.state.civilization.status, 'running');
assert.deepEqual(source.state.civilization.conditions.endpoint, { kind: 'months', value: SOURCE_ENDPOINT });

const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'eland-v6b-continuation-create-'));
const scratchDirectory = await mkdtemp(path.join(tmpdir(), 'eland-v6b-continuation-preflight-'));
const bundlePath = path.join(bundleDirectory, 'sqlite-run-store.mjs');
let scratchStore;
let authorityStore;
try {
  await build({
    entryPoints: [path.join(PROJECT_DIRECTORY, 'server', 'sqlite-run-store.ts')],
    outfile: bundlePath,
    absWorkingDir: PROJECT_DIRECTORY,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent',
  });
  const module = await import(`${pathToFileURL(bundlePath).href}?create=${Date.now()}`);

  const scratchInput = structuredClone(source.state);
  scratchInput.civilization.conditions.endpoint = { kind: 'months', value: TARGET_ENDPOINT };
  scratchStore = new module.SqliteRunStore(scratchDirectory);
  await scratchStore.create({ id: 'v6b-continuation-preflight', label: 'v6b continuation preflight', state: scratchInput });
  const scratch = await scratchStore.load('v6b-continuation-preflight');

  scratch.state.civilization.conditions.endpoint = { kind: 'months', value: SOURCE_ENDPOINT };
  const differences = leafDifferences(source.state, scratch.state);
  assert.equal(differences.length, 27, `unexpected V6b create normalization difference count: ${differences.length}`);
  for (const difference of differences) {
    const allowed = allowedBackfills.get(difference.path);
    assert.ok(allowed, `unexpected V6b create normalization path: ${difference.path}`);
    assert.equal(difference.kind, 'added', `unexpected difference kind at ${difference.path}`);
    assert.equal(difference.target, allowed.agreementId, `unexpected agreementId at ${difference.path}`);
    const index = Number(difference.path.match(/^intents\[(\d+)\]\.agreementId$/)?.[1]);
    assert.equal(source.state.intents[index].status, allowed.status, `unexpected intent status at ${difference.path}`);
    assert.notEqual(source.state.intents[index].status, 'active', `active intent changed at ${difference.path}`);
  }
  scratch.state.civilization.conditions.endpoint = { kind: 'months', value: TARGET_ENDPOINT };

  authorityStore = new module.SqliteRunStore(RUN_DATA_DIRECTORY);
  assert.equal((await authorityStore.list()).some((run) => run.id === TARGET_ID), false, `target appeared before create: ${TARGET_ID}`);
  source.state.civilization.conditions.endpoint = { kind: 'months', value: TARGET_ENDPOINT };
  const created = await authorityStore.create({ id: TARGET_ID, label: TARGET_LABEL, state: source.state });
  const loaded = await authorityStore.load(TARGET_ID);

  assert.equal(created.meta.id, TARGET_ID);
  assert.equal(loaded.meta.elapsedMonths, SOURCE_MONTH);
  assert.equal(loaded.state.seed, 20260815);
  assert.equal(loaded.state.people.length, 51);
  assert.equal(loaded.state.world.past.length, 89827);
  assert.deepEqual(loaded.state.civilization.conditions.endpoint, { kind: 'months', value: TARGET_ENDPOINT });
  assert.equal(isDeepStrictEqual(loaded.state, scratch.state), true, 'authority target differs from preflighted official create result');

  process.stdout.write(`${JSON.stringify({
    sourceId: SOURCE_ID,
    targetId: TARGET_ID,
    targetLabel: TARGET_LABEL,
    dataDirectory: RUN_DATA_DIRECTORY,
    elapsedMonths: loaded.meta.elapsedMonths,
    seed: loaded.state.seed,
    civilizationNo: loaded.state.civilization.number,
    status: loaded.state.civilization.status,
    people: loaded.state.people.length,
    livingAgents: loaded.meta.livingAgents,
    events: loaded.state.world.past.length,
    sourceEndpoint: SOURCE_ENDPOINT,
    targetEndpoint: TARGET_ENDPOINT,
    historicalProvenanceNormalizations: differences.length,
    activeIntentNormalizations: 0,
    otherDifferences: 0,
  }, null, 2)}\n`);
} finally {
  scratchStore?.close();
  authorityStore?.close();
  await rm(scratchDirectory, { recursive: true, force: true });
  await rm(bundleDirectory, { recursive: true, force: true });
}
