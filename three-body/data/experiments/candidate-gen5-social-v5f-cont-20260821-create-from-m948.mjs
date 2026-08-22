import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';

import { build } from 'esbuild';
import {
  openSqliteRunReader,
  PROJECT_DIRECTORY,
  RUN_DATA_DIRECTORY,
} from '/tmp/eland-gen3-candidate.1ejlGu/three-body/scripts/sqlite-run-reader.mjs';

const SOURCE_ID = 'candidate-gen5-social-v5f-20260821-s20260815-y100-r1';
const TARGET_ID = 'candidate-gen5-social-v5f-cont-20260821-s20260815-m948-y200-r1';
const TARGET_LABEL = 'candidate-gen5-social-v5f-cont-20260821 seed=20260815 from=948 through=2400';
const SOURCE_MONTH = 948;
const SOURCE_ENDPOINT = 1200;
const TARGET_ENDPOINT = 2400;

function semanticHash(state) {
  return createHash('sha256').update(serialize(state)).digest('hex');
}

const reader = await openSqliteRunReader();
let source;
try {
  const metadata = await reader.store.list();
  assert.equal(metadata.some((run) => run.id === TARGET_ID), false, `target already exists: ${TARGET_ID}`);
  source = await reader.store.load(SOURCE_ID);
} finally {
  await reader.close();
}

assert.equal(
  await realpath(PROJECT_DIRECTORY),
  await realpath('/tmp/eland-gen3-candidate.1ejlGu/three-body'),
);
assert.equal(source.state.clock.elapsedMonths, SOURCE_MONTH);
assert.equal(source.state.civilization.status, 'running');
assert.deepEqual(source.state.civilization.conditions.endpoint, { kind: 'months', value: SOURCE_ENDPOINT });

const sourceSemanticHash = semanticHash(source.state);
source.state.civilization.conditions.endpoint = { kind: 'months', value: TARGET_ENDPOINT };
const expectedTargetSemanticHash = semanticHash(source.state);

const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'eland-continuation-create-'));
const bundlePath = path.join(bundleDirectory, 'sqlite-run-store.mjs');
let store;
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
  store = new module.SqliteRunStore(RUN_DATA_DIRECTORY);

  // SqliteRunStore.create repeats this absence check inside its own transaction.
  assert.equal((await store.list()).some((run) => run.id === TARGET_ID), false, `target appeared before create: ${TARGET_ID}`);
  const created = await store.create({ id: TARGET_ID, label: TARGET_LABEL, state: source.state });
  const loaded = await store.load(TARGET_ID);

  assert.equal(created.meta.id, TARGET_ID);
  assert.equal(loaded.meta.elapsedMonths, SOURCE_MONTH);
  assert.equal(loaded.state.seed, source.state.seed);
  assert.equal(loaded.state.people.length, source.state.people.length);
  assert.equal(loaded.state.world.past.length, source.state.world.past.length);
  assert.deepEqual(loaded.state.civilization.conditions.endpoint, { kind: 'months', value: TARGET_ENDPOINT });

  const targetSemanticHash = semanticHash(loaded.state);
  assert.equal(targetSemanticHash, expectedTargetSemanticHash, 'imported target differs from endpoint-adjusted source');

  loaded.state.civilization.conditions.endpoint = { kind: 'months', value: SOURCE_ENDPOINT };
  source.state.civilization.conditions.endpoint = { kind: 'months', value: SOURCE_ENDPOINT };
  assert.equal(isDeepStrictEqual(loaded.state, source.state), true, 'source and target differ outside endpoint');
  const targetWithSourceEndpointSemanticHash = semanticHash(loaded.state);
  assert.equal(targetWithSourceEndpointSemanticHash, sourceSemanticHash, 'source and endpoint-normalized target hash differ');

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
    sourceSemanticHash,
    expectedTargetSemanticHash,
    targetSemanticHash,
    targetWithSourceEndpointSemanticHash,
    onlyEndpointDiffers: true,
  }, null, 2)}\n`);
} finally {
  store?.close();
  await rm(bundleDirectory, { recursive: true, force: true });
}
