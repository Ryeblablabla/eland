import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-project-segments-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };

function storedChunk(codec, data) {
  return Object.freeze({
    hash: createHash('sha256').update(codec).update('\0').update(data).digest('hex'),
    codec,
    rawSize: data.byteLength,
    data: Buffer.from(data),
  });
}

function compressedChunk(codec, value) {
  return storedChunk(codec, brotliCompressSync(serialize(value), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 },
  }));
}

function addSnapshot(chunks, snapshot) {
  for (const chunk of [snapshot.root, ...snapshot.parts]) {
    const existing = chunks.get(chunk.hash);
    if (existing) assert.deepEqual(existing.data, chunk.data, 'content hash collision');
    else chunks.set(chunk.hash, chunk);
  }
}

function reader(chunks) {
  return (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };
}

function project(index, ownerId) {
  const id = `project-segment-${String(index).padStart(3, '0')}`;
  return {
    id,
    kind: 'construction',
    need: 'production-efficiency',
    desiredFunction: 'efficient-production',
    summary: `unique project payload ${index}`,
    ownerId,
    beneficiaryIds: [],
    triggerFactIds: [`trigger:${id}`],
    pressure: index + 1,
    createdAtMonth: index,
    reviewAtMonth: index + 12,
    status: 'active',
    lastProgressAtMonth: index,
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [ownerId],
    actionEventIds: [`action:${id}`],
    failureEventIds: [],
    completionEventIds: [],
  };
}

function event(index) {
  return {
    id: `project-segment-event-${String(index).padStart(3, '0')}`,
    kind: 'environment',
    atMonth: 0,
    orderInMonth: index,
    cellId: index % 4,
    change: 'material',
    result: `unique event payload ${index}`,
    diff: { fixture: 'project-segment-bound', index },
  };
}

function field(manifest, name) {
  const found = manifest.fields.find((candidate) => candidate.name === name);
  assert.ok(found, `manifest must contain state.${name}`);
  assert.equal(found.kind, 'array', `state.${name} must be an array field`);
  return found;
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { createSimulation } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
  ].join('\n'));
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const state = api.createSimulation({
    seed: 93_131,
    config: {
      endpoint: { kind: 'months', value: 1_200 },
      chaosIntensity: 0,
      characterIds: ['galileo', 'freyja', 'newton'],
    },
  }).getState();
  const ownerId = state.people[0].id;
  state.projects = Array.from({ length: 130 }, (_, index) => project(index, ownerId));
  const events = Array.from({ length: 130 }, (_, index) => event(index));
  state.world.past = events;
  state.world.historyCursor = {
    version: 1,
    eventCount: events.length,
    hotStartIndex: 0,
    tailEventId: events.at(-1).id,
  };
  state.lastStep = [...events];

  const expectedProjects = structuredClone(state.projects);
  const expectedLastStep = structuredClone(state.lastStep);
  const snapshot = await api.encodeSegmentedRunState(state, { mode: 'replace' });
  const chunks = new Map();
  addSnapshot(chunks, snapshot);
  const manifestChunk = chunks.get(snapshot.metadata.shellHash);
  const manifest = api.parseRunStateShellManifest(manifestChunk);
  const projectField = field(manifest, 'projects');
  const lastStepField = field(manifest, 'lastStep');

  assert.equal(projectField.length, 130);
  assert.equal(projectField.segments.length, 130,
    'new writer must isolate every project in one segment');
  assert.deepEqual(projectField.segments.map(({ itemCount }) => itemCount),
    Array(130).fill(1));
  assert.equal(new Set(projectField.segments.map(({ hash }) => hash)).size, 130,
    'fixture projects must remain content-distinct for reuse assertions');
  assert.deepEqual(lastStepField.segments.map(({ itemCount }) => itemCount), [64, 64, 2],
    'non-project arrays must keep the established 64-item layout');

  const full = await api.decodeSegmentedRunState(snapshot.root, reader(chunks));
  assert.deepEqual(full.state.projects, expectedProjects,
    'full decode must preserve project order and semantics');
  assert.deepEqual(full.state.lastStep, expectedLastStep,
    'full decode must preserve the comparison array order and semantics');

  const bounded = await api.decodeSegmentedRunStateGameplayBounded(
    snapshot.root,
    reader(chunks),
    {
      hotEventLimit: events.length,
      observerAuthority: {
        stateHash: snapshot.root.hash,
        revision: 1,
        month: state.clock.elapsedMonths,
        lastMaterializedMilestoneCount: state.derived.milestones.length,
      },
    },
  );
  assert.deepEqual(bounded.state.projects, expectedProjects,
    'bounded gameplay decode must preserve active project order and semantics');
  assert.deepEqual(bounded.state.lastStep, expectedLastStep,
    'bounded gameplay decode must preserve the comparison array semantics');

  // Rebuild a schema-3 root exactly as the previous writer laid projects out:
  // complete 64-item prefix segments followed by one 1..64-item tail segment.
  const legacyProjectChunks = [];
  const legacyProjectReferences = [];
  for (let offset = 0; offset < expectedProjects.length; offset += 64) {
    const values = expectedProjects.slice(offset, offset + 64);
    const chunk = compressedChunk(api.RUN_STATE_SHELL_PART_CODEC, values);
    legacyProjectChunks.push(chunk);
    legacyProjectReferences.push({ hash: chunk.hash, itemCount: values.length });
    chunks.set(chunk.hash, chunk);
  }
  const legacyManifest = structuredClone(manifest);
  const legacyProjectField = field(legacyManifest, 'projects');
  legacyProjectField.segments = legacyProjectReferences;
  const legacyManifestChunk = storedChunk(
    api.RUN_STATE_SHELL_MANIFEST_CODEC,
    serialize(legacyManifest),
  );
  const legacyRootMetadata = {
    ...snapshot.metadata,
    shellHash: legacyManifestChunk.hash,
  };
  const legacyRoot = storedChunk(api.RUN_STATE_ROOT_CODEC, serialize(legacyRootMetadata));
  chunks.set(legacyManifestChunk.hash, legacyManifestChunk);
  chunks.set(legacyRoot.hash, legacyRoot);

  const parsedLegacyManifest = api.parseRunStateShellManifest(legacyManifestChunk);
  assert.deepEqual(field(parsedLegacyManifest, 'projects').segments.map(({ itemCount }) => itemCount),
    [64, 64, 2], 'reader must continue accepting the old project manifest layout');
  const legacyFull = await api.decodeSegmentedRunState(legacyRoot, reader(chunks));
  assert.deepEqual(legacyFull.state.projects, expectedProjects,
    'legacy 64-item project segments must remain readable in order');
  const legacyBounded = await api.decodeSegmentedRunStateGameplayBounded(
    legacyRoot,
    reader(chunks),
    {
      hotEventLimit: events.length,
      observerAuthority: {
        stateHash: legacyRoot.hash,
        revision: 1,
        month: state.clock.elapsedMonths,
        lastMaterializedMilestoneCount: state.derived.milestones.length,
      },
    },
  );
  assert.deepEqual(legacyBounded.state.projects, expectedProjects,
    'bounded gameplay decode must also preserve legacy project segments');

  const wrongTotalManifest = structuredClone(legacyManifest);
  field(wrongTotalManifest, 'projects').length = expectedProjects.length - 1;
  const wrongTotalManifestChunk = storedChunk(
    api.RUN_STATE_SHELL_MANIFEST_CODEC,
    serialize(wrongTotalManifest),
  );
  assert.throws(
    () => api.parseRunStateShellManifest(wrongTotalManifestChunk),
    /manifest 内容无效/u,
    'manifest itemCount sum must exactly equal its declared field length',
  );

  state.projects[73] = {
    ...state.projects[73],
    summary: 'the only changed project payload',
  };
  const changed = await api.encodeSegmentedRunState(state, { mode: 'replace' });
  const changedChunks = new Map(chunks);
  addSnapshot(changedChunks, changed);
  const changedManifest = api.parseRunStateShellManifest(
    changedChunks.get(changed.metadata.shellHash),
  );
  const changedProjectField = field(changedManifest, 'projects');
  const reusedProjectChunkCount = projectField.segments.reduce(
    (count, reference, index) => count
      + Number(reference.hash === changedProjectField.segments[index].hash),
    0,
  );
  assert.equal(reusedProjectChunkCount, 129,
    'changing one unique project must reuse every other project chunk');
  assert.notEqual(projectField.segments[73].hash, changedProjectField.segments[73].hash);

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes < 256 * 1_024 * 1_024,
    `project segment fixture RSS ${maxRssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({
    ok: true,
    projectCount: projectField.length,
    newProjectSegmentCount: projectField.segments.length,
    legacyProjectSegmentItemCounts: legacyProjectReferences.map(({ itemCount }) => itemCount),
    comparisonArrayItemCounts: lastStepField.segments.map(({ itemCount }) => itemCount),
    reusedProjectChunkCount,
    fullAndBoundedSemanticParity: 'new-and-legacy',
    maxRssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
