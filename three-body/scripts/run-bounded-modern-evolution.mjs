import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const startedAt = performance.now();
const [
  dataDirectoryInput,
  runId,
  seedInput,
  targetMonthInput,
  hotLimitInput,
  stopModeInput,
] = process.argv.slice(2);
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-modern-evolution-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'runner.mjs');
let store;
let emitted = false;
let ledgerLockPath;

const ERA_LEDGER_SCHEMA = 'eland-era-boundary-ledger-v1';
const ERA_PROOF_SCHEMA = 'eland-era-boundary-proof-pack-v2';
const RUNNER_SUCCESSOR_MANIFEST_SCHEMA = 'eland-bounded-modern-runner-successors-v1';
const runnerSuccessorManifestPath = path.join(
  import.meta.dirname,
  'run-bounded-modern-evolution-successors.json',
);
const ERA_ORDER = [
  'primitive-tribe',
  'agrarian-settlement',
  'ancient-civilization',
  'modern-civilization',
];
const MODERN_GATE_IDS = [
  'power:complete-network-useful-load',
  'measurement:calibrated-comparable-mass',
  'record:independent-experiment-reuse',
];
const LEDGER_HASH_DOMAIN = `${ERA_LEDGER_SCHEMA}\0`;
const PROOF_HASH_DOMAIN = `${ERA_PROOF_SCHEMA}\0`;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

function maxRssBytes() {
  return process.resourceUsage().maxRSS * 1_024;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error) {
  return error instanceof Error ? error.name : 'Error';
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function ledgerEntryHash(value) {
  return sha256Bytes(`${LEDGER_HASH_DOMAIN}${canonicalJson(value)}`);
}

function proofPackHash(value) {
  return sha256Bytes(`${PROOF_HASH_DOMAIN}${canonicalJson(value)}`);
}

function runnerSuccessorEntryHash(value) {
  return sha256Bytes(`${RUNNER_SUCCESSOR_MANIFEST_SCHEMA}\0${canonicalJson(value)}`);
}

function readRunnerSuccessorManifest() {
  const manifest = JSON.parse(readFileSync(runnerSuccessorManifestPath, 'utf8'));
  assert.equal(manifest.schema, RUNNER_SUCCESSOR_MANIFEST_SCHEMA, 'runner successor manifest schema 无效');
  assert.equal(Array.isArray(manifest.successors), true, 'runner successor manifest 缺少 successors');
  const seenFromHashes = new Set();
  for (const successor of manifest.successors) {
    assert.equal(HASH_PATTERN.test(successor.fromRunnerHash), true, 'runner successor from hash 无效');
    assert.equal(HASH_PATTERN.test(successor.toRunnerHash), true, 'runner successor to hash 无效');
    assert.notEqual(successor.fromRunnerHash, successor.toRunnerHash, 'runner successor 不得自循环');
    assert.equal(typeof successor.policy === 'string' && successor.policy.length > 0, true);
    assert.equal(typeof successor.reason === 'string' && successor.reason.length > 0, true);
    assert.equal(seenFromHashes.has(successor.fromRunnerHash), false, 'runner successor from hash 重复');
    seenFromHashes.add(successor.fromRunnerHash);
  }
  return manifest.successors;
}

function activeLedgerRunnerHash(lines) {
  let active = lines[0].runnerHash;
  for (const line of lines.slice(1)) {
    if (line.type !== 'runner-successor') continue;
    assert.equal(line.runnerSuccessor?.fromRunnerHash, active, `runner successor seq ${line.seq} 链断裂`);
    assert.equal(HASH_PATTERN.test(line.runnerSuccessor.toRunnerHash), true);
    active = line.runnerSuccessor.toRunnerHash;
  }
  return active;
}

function validateRunnerSuccessorChain(lines, manifest) {
  let active = lines[0].runnerHash;
  for (const line of lines.slice(1)) {
    if (line.type !== 'runner-successor') continue;
    const recorded = line.runnerSuccessor;
    assert.equal(recorded?.fromRunnerHash, active, `runner successor seq ${line.seq} 链断裂`);
    const known = manifest.find((candidate) => (
      candidate.fromRunnerHash === recorded.fromRunnerHash
      && candidate.toRunnerHash === recorded.toRunnerHash
    ));
    assert.ok(known, `runner successor seq ${line.seq} 未在 manifest 注册`);
    assert.deepEqual(recorded, {
      ...known,
      manifestEntryHash: runnerSuccessorEntryHash(known),
    }, `runner successor seq ${line.seq} 与 manifest 不一致`);
    active = recorded.toRunnerHash;
  }
  return active;
}

function withLedgerHash(value) {
  return Object.freeze({ ...value, hash: ledgerEntryHash(value) });
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWriteNewFile(filePath, bytes) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function appendDurableJsonLine(filePath, value) {
  const descriptor = openSync(filePath, 'a', 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function acquireLedgerLock(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const descriptor = openSync(filePath, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let stalePid = null;
  try {
    stalePid = Number(JSON.parse(readFileSync(filePath, 'utf8')).pid);
  } catch {
    // An unreadable lock is intentionally not guessed away.
  }
  if (Number.isSafeInteger(stalePid) && stalePid > 0) {
    try {
      process.kill(stalePid, 0);
      throw new Error(`时代账本已有活跃 runner lock pid=${stalePid}`);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    unlinkSync(filePath);
    fsyncDirectory(path.dirname(filePath));
    return acquireLedgerLock(filePath);
  }
  throw new Error(`时代账本 lock ${filePath} 无法验证为陈旧锁`);
}

function releaseLedgerLock() {
  if (!ledgerLockPath || !existsSync(ledgerLockPath)) return;
  unlinkSync(ledgerLockPath);
  fsyncDirectory(path.dirname(ledgerLockPath));
  ledgerLockPath = undefined;
}

function ledgerPaths(dataDirectory, id) {
  return {
    ledger: path.join(dataDirectory, `${id}.era-boundary-ledger-v1.jsonl`),
    proofDirectory: path.join(dataDirectory, `${id}.era-boundary-proofs-v1`),
    lock: path.join(dataDirectory, `.${id}.era-boundary-ledger-v1.lock`),
  };
}

function engineEntrySource() {
  return [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { DEVELOPMENT_OBSERVER_VERSION, normalizeDevelopmentEra, observeModernCivilizationEvidence } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/era-progression.ts'))};`,
    `export { parseRunStateRoot, parseRunStateShellManifest, verifiedRunStateChunkData, RUN_STATE_ROOT_CODEC, RUN_STATE_SHELL_MANIFEST_CODEC, RUN_STATE_SHELL_PART_CODEC } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { decodeRunContinuationBundle, RUN_CONTINUATION_BUNDLE_CODEC } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
  ].join('\n');
}

function normalizeEra(api, value) {
  if (typeof value !== 'string') return 'primitive-tribe';
  const normalized = api.normalizeDevelopmentEra(value);
  assert.equal(ERA_ORDER.includes(normalized), true, `未知时代键 ${value}`);
  return normalized;
}

function exactDevelopment(api, state) {
  const basis = state.lastMaterializedObserverBasis;
  const development = state.civilization.development
    ?? (basis?.version === 2 ? basis.developmentSnapshot : null);
  return {
    observerVersion: development?.observerVersion ?? api.DEVELOPMENT_OBSERVER_VERSION,
    current: normalizeEra(api, development?.currentEra ?? 'primitive-tribe'),
    historical: normalizeEra(api, development?.historicalPeakEra ?? 'primitive-tribe'),
    candidate: normalizeEra(api, development?.candidateEra ?? 'primitive-tribe'),
    candidateSinceMonth: development?.candidateSinceMonth ?? state.clock.elapsedMonths,
    transitionProgress: development?.transitionProgress ?? null,
    satisfiedGateIds: [...(development?.satisfiedGateIds ?? [])],
    missingGateIds: [...(development?.missingGateIds ?? [])],
  };
}

function eventOrdinals(opened, eventIds) {
  const ordinals = new Map();
  const hotStartIndex = opened.state.world.historyCursor?.hotStartIndex
    ?? Math.max(0, opened.meta.eventCount - opened.state.world.past.length);
  opened.state.world.past.forEach((event, index) => {
    if (!ordinals.has(event.id)) ordinals.set(event.id, hotStartIndex + index);
  });
  for (const pinned of opened.pinnedEvents) {
    if (!ordinals.has(pinned.event.id)) ordinals.set(pinned.event.id, pinned.absoluteIndex);
  }
  return eventIds.map((eventId) => ({
    eventId,
    ordinal: ordinals.get(eventId) ?? null,
  }));
}

function modernLedgerSnapshot(api, opened) {
  const evidence = api.observeModernCivilizationEvidence(opened.state);
  const gates = {
    'power:complete-network-useful-load': evidence.electricalPower !== null,
    'measurement:calibrated-comparable-mass': evidence.comparableMeasurement !== null,
    'record:independent-experiment-reuse': evidence.independentRecordExperiment !== null,
  };
  assert.deepEqual(Object.keys(gates), MODERN_GATE_IDS);
  return {
    satisfied: evidence.satisfied,
    gateIds: MODERN_GATE_IDS.map((id) => ({ id, satisfied: gates[id] })),
    witnesses: {
      electricalPower: evidence.electricalPower,
      comparableMeasurement: evidence.comparableMeasurement,
      independentRecordExperiment: evidence.independentRecordExperiment,
    },
    witnessOrdinals: eventOrdinals(opened, evidence.supportingEventIds),
    supportingEventIds: [...evidence.supportingEventIds],
  };
}

function observerSourceOf(state) {
  const source = state.lastMaterializedObserverBasis?.source;
  if (!source) return null;
  assert.equal(HASH_PATTERN.test(source.stateHash), true, 'observer source root A hash 无效');
  assert.equal(Number.isSafeInteger(source.revision) && source.revision >= 1, true);
  assert.equal(Number.isSafeInteger(source.month) && source.month >= 0, true);
  return {
    revision: source.revision,
    month: source.month,
    stateHash: source.stateHash,
  };
}

function readChunk(database, hash, label) {
  const row = database.prepare(
    'SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?',
  ).get(hash);
  assert.ok(row, `${label} ${hash} 不在 SQLite chunk ledger`);
  const chunk = {
    hash: String(row.hash),
    codec: String(row.codec),
    rawSize: Number(row.raw_size),
    data: Buffer.from(row.data),
  };
  assert.equal(chunk.hash, hash, `${label} chunk hash 回读失配`);
  return chunk;
}

function authorityDatabaseSnapshot(api, dataDirectory, id, opened, requireBoundarySource) {
  const database = new DatabaseSync(path.join(dataDirectory, 'eland.sqlite3'), { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const row = database.prepare(`
      SELECT runs.revision, runs.elapsed_months, runs.state_hash, runs.status,
             runs.event_count, run_continuations.shell_hash,
             run_continuations.history_lineage_id,
             run_continuations.history_head_hash,
             run_continuations.tail_event_id,
             run_continuations.tail_event_content_hash,
             run_continuations.bundle_hash
      FROM runs
      JOIN run_continuations ON run_continuations.run_id = runs.id
      WHERE runs.id = ?
    `).get(id);
    assert.ok(row, `时代账本无法回读运行 ${id} authority`);
    const cursor = opened.state.world.historyCursor;
    assert.ok(cursor, '时代账本只接受带 historyCursor 的 bounded state');
    const authority = {
      revision: opened.meta.revision,
      month: opened.meta.elapsedMonths,
      stateHash: opened.basis.stateHash,
      shellHash: String(row.shell_hash),
      lineageId: opened.basis.history.lineageId,
      historyHeadHash: opened.basis.history.historyHeadHash,
      eventCount: opened.basis.history.eventCount,
      tailEventId: cursor.tailEventId,
      tailEventContentHash: opened.basis.history.tailEventContentHash,
      bundleHash: String(row.bundle_hash),
    };
    assert.equal(opened.basis.runId, id);
    assert.equal(opened.meta.eventCount, authority.eventCount);
    assert.equal(cursor.eventCount, authority.eventCount);
    assert.equal(opened.state.clock.elapsedMonths, authority.month);
    assert.equal(Number(row.revision), authority.revision);
    assert.equal(Number(row.elapsed_months), authority.month);
    assert.equal(String(row.state_hash), authority.stateHash);
    assert.equal(String(row.status), opened.meta.status);
    assert.equal(Number(row.event_count), authority.eventCount);
    assert.equal(String(row.history_lineage_id), authority.lineageId);
    assert.equal(row.history_head_hash == null ? null : String(row.history_head_hash), authority.historyHeadHash);
    assert.equal(row.tail_event_id == null ? null : String(row.tail_event_id), authority.tailEventId);
    assert.equal(
      row.tail_event_content_hash == null ? null : String(row.tail_event_content_hash),
      authority.tailEventContentHash,
    );
    const rootBChunk = readChunk(database, authority.stateHash, 'authority root B');
    const rootB = api.parseRunStateRoot(rootBChunk);
    assert.equal(rootB.shellHash, authority.shellHash);
    assert.equal(rootB.lineageId, authority.lineageId);
    assert.equal(rootB.historyHeadHash, authority.historyHeadHash);
    assert.equal(rootB.eventCount, authority.eventCount);
    assert.equal(rootB.tailEventContentHash, authority.tailEventContentHash);

    const observerSource = observerSourceOf(opened.state);
    if (requireBoundarySource) {
      assert.ok(observerSource, 'observer boundary 缺少 private fact root A source');
      assert.equal(observerSource.revision, authority.revision);
      assert.equal(observerSource.month, authority.month);
      assert.notEqual(observerSource.stateHash, authority.stateHash);
    }
    let rootA = null;
    if (observerSource) {
      const rootAChunk = readChunk(database, observerSource.stateHash, 'observer source root A');
      rootA = api.parseRunStateRoot(rootAChunk);
      assert.equal(observerSource.revision <= authority.revision, true);
      assert.equal(observerSource.month <= authority.month, true);
      assert.equal(rootA.lineageId, authority.lineageId);
      assert.equal(rootA.eventCount <= authority.eventCount, true);
      const sourceIsCurrentRevision = observerSource.revision === authority.revision;
      const sourceIsCurrentMonth = observerSource.month === authority.month;
      assert.equal(
        sourceIsCurrentRevision,
        sourceIsCurrentMonth,
        'observer source revision/month 只能同时等于当前 authority',
      );
      if (requireBoundarySource || sourceIsCurrentRevision) {
        assert.equal(rootA.historyHeadHash, authority.historyHeadHash);
        assert.equal(rootA.eventCount, authority.eventCount);
        assert.equal(rootA.tailEventContentHash, authority.tailEventContentHash);
      }
    }
    return { authority, observerSource, rootB, rootA };
  } finally {
    database.close();
  }
}

function readVerifiedLedger(filePath) {
  assert.equal(existsSync(filePath), true, `时代账本 ${filePath} 不存在`);
  const raw = readFileSync(filePath, 'utf8');
  assert.equal(raw.endsWith('\n'), true, '时代账本末行未完成耐久追加');
  const lines = raw.trimEnd().split('\n').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`时代账本第 ${index + 1} 行不是 JSON`, { cause: error });
    }
  });
  assert.ok(lines.length >= 2, '时代账本必须包含 header 与 bootstrap');
  let previousHash = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    assert.equal(line.seq, index, `时代账本 seq ${line.seq} 不连续`);
    assert.equal(line.prevHash, previousHash, `时代账本 seq ${line.seq} prevHash 失配`);
    assert.equal(HASH_PATTERN.test(line.hash), true, `时代账本 seq ${line.seq} hash 无效`);
    const { hash, ...unhashed } = line;
    assert.equal(hash, ledgerEntryHash(unhashed), `时代账本 seq ${line.seq} hash 验证失败`);
    previousHash = hash;
  }
  assert.equal(lines[0].type, 'header');
  assert.equal(lines[0].schema, ERA_LEDGER_SCHEMA);
  assert.deepEqual(lines[0].eraOrder, ERA_ORDER);
  assert.equal(lines[1].type, 'bootstrap');
  for (const line of lines.slice(1)) {
    assert.equal(line.authority?.lineageId, lines[0].lineageId, `时代账本 seq ${line.seq} lineage 失配`);
  }
  return lines;
}

function transitionFrom(previousEra, nextEra) {
  const previousRank = ERA_ORDER.indexOf(previousEra);
  const nextRank = ERA_ORDER.indexOf(nextEra);
  assert.notEqual(previousRank, -1);
  assert.notEqual(nextRank, -1);
  if (nextRank === previousRank) {
    return { from: previousEra, to: nextEra, kind: 'same', skipped: [] };
  }
  if (nextRank < previousRank) {
    return { from: previousEra, to: nextEra, kind: 'regression', skipped: [] };
  }
  const skipped = ERA_ORDER.slice(previousRank + 1, nextRank);
  return {
    from: previousEra,
    to: nextEra,
    kind: skipped.length > 0 ? 'skip' : 'advance',
    skipped,
  };
}

function selectedProofFields(api, database, rootHash, rootRole) {
  const rootChunk = readChunk(database, rootHash, `${rootRole} root`);
  const root = api.parseRunStateRoot(rootChunk);
  assert.equal(root.schemaVersion, 3, `${rootRole} proof 只接受 schema3 root`);
  const manifestChunk = readChunk(database, root.shellHash, `${rootRole} shell manifest`);
  const manifest = api.parseRunStateShellManifest(manifestChunk);
  const required = [
    ['state', 'clock'],
    ['state', 'civilization'],
    ['state', 'lastMaterializedObserverBasis'],
  ];
  const cursorField = manifest.worldFields.find((candidate) => candidate.name === 'historyCursor');
  if (cursorField) required.push(['world', 'historyCursor']);
  const chunks = [
    { role: `${rootRole}:root`, ...rootChunk, data: rootChunk.data.toString('base64') },
    {
      role: `${rootRole}:shell-manifest`,
      ...manifestChunk,
      data: manifestChunk.data.toString('base64'),
    },
  ];
  const fields = [];
  for (const [scope, fieldName] of required) {
    const references = scope === 'state' ? manifest.fields : manifest.worldFields;
    const field = references.find((candidate) => candidate.name === fieldName);
    assert.ok(field, `${rootRole} shell 缺少 ${scope}.${fieldName}`);
    assert.equal(field.kind, 'value', `${rootRole} ${scope}.${fieldName} 不是 value chunk`);
    const chunk = readChunk(database, field.hash, `${rootRole} ${scope}.${fieldName}`);
    api.verifiedRunStateChunkData(
      chunk,
      api.RUN_STATE_SHELL_PART_CODEC,
      `${rootRole} ${scope}.${fieldName}`,
    );
    fields.push({ scope, fieldName, chunkHash: chunk.hash });
    chunks.push({
      role: `${rootRole}:${scope}.${fieldName}`,
      ...chunk,
      data: chunk.data.toString('base64'),
    });
  }
  return { root, manifest, fields, chunks, hasHistoryCursor: cursorField !== undefined };
}

function writeTransitionProofPack(api, paths, id, record, snapshot, dataDirectory) {
  assert.ok(snapshot.observerSource, 'transition proof 缺少 observer root A');
  const database = new DatabaseSync(path.join(dataDirectory, 'eland.sqlite3'), { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const rootB = selectedProofFields(
      api,
      database,
      snapshot.authority.stateHash,
      'root-b',
    );
    const rootA = selectedProofFields(
      api,
      database,
      snapshot.observerSource.stateHash,
      'root-a',
    );
    const bundleChunk = readChunk(
      database,
      snapshot.authority.bundleHash,
      'continuation bundle',
    );
    const bundle = api.decodeRunContinuationBundle(bundleChunk);
    assert.equal(bundle.authority.runId, id);
    assert.equal(bundle.authority.revision, snapshot.authority.revision);
    assert.equal(bundle.authority.stateHash, snapshot.authority.stateHash);
    assert.equal(bundle.authority.historyLineageId, snapshot.authority.lineageId);
    assert.equal(bundle.authority.historyHeadHash, snapshot.authority.historyHeadHash);
    assert.equal(bundle.authority.eventCount, snapshot.authority.eventCount);
    assert.equal(bundle.authority.tailEventId, snapshot.authority.tailEventId);
    assert.equal(bundle.authority.tailEventContentHash, snapshot.authority.tailEventContentHash);
    assert.deepEqual(bundle.observerMaterializationSource, snapshot.observerSource);
    const historyCursorSeals = {
      rootA: {
        evidence: rootA.hasHistoryCursor
          ? 'shell-field'
          : 'root-metadata+continuation-bundle',
        eventCount: rootA.root.eventCount,
        tailEventId: bundle.authority.tailEventId,
      },
      rootB: {
        evidence: rootB.hasHistoryCursor
          ? 'shell-field'
          : 'root-metadata+continuation-bundle',
        eventCount: rootB.root.eventCount,
        tailEventId: bundle.authority.tailEventId,
      },
    };
    const chunksByHash = new Map();
    for (const chunk of [
      ...rootB.chunks,
      ...rootA.chunks,
      {
        role: 'continuation-bundle',
        ...bundleChunk,
        data: bundleChunk.data.toString('base64'),
      },
    ]) {
      const existing = chunksByHash.get(chunk.hash);
      if (existing) {
        existing.roles.push(chunk.role);
      } else {
        const { role, ...content } = chunk;
        chunksByHash.set(chunk.hash, { ...content, roles: [role] });
      }
    }
    const pack = {
      schema: ERA_PROOF_SCHEMA,
      runId: id,
      ledgerSeq: record.seq,
      boundaryKind: record.boundaryKind,
      authority: record.authority,
      observer: record.observer,
      modern: record.modern,
      status: record.status,
      outcome: record.outcome,
      fields: {
        rootA: rootA.fields,
        rootB: rootB.fields,
      },
      historyCursorSeals,
      chunks: [...chunksByHash.values()].sort((left, right) => left.hash.localeCompare(right.hash)),
      limitation: 'observer-field-proof-only-no-full-history-replay',
    };
    const hash = proofPackHash(pack);
    const proofPath = path.join(paths.proofDirectory, `${hash}.json`);
    const bytes = Buffer.from(`${canonicalJson(pack)}\n`);
    if (existsSync(proofPath)) {
      assert.equal(readFileSync(proofPath).equals(bytes), true, `proof pack ${hash} 内容冲突`);
    } else {
      atomicWriteNewFile(proofPath, bytes);
    }
    return {
      schema: ERA_PROOF_SCHEMA,
      hash,
      relativePath: path.relative(dataDirectory, proofPath),
      strength: 'observer-field-proof-only',
      limitation: pack.limitation,
    };
  } finally {
    database.close();
  }
}

function makeLedgerObservation(api, opened, snapshot) {
  const development = exactDevelopment(api, opened.state);
  const modern = modernLedgerSnapshot(api, opened);
  const index = opened.state.civilization.civilizationIndex;
  return {
    authority: snapshot.authority,
    observer: {
      source: snapshot.observerSource,
      observerVersion: development.observerVersion,
      current: development.current,
      historical: development.historical,
      candidate: development.candidate,
      candidateSinceMonth: development.candidateSinceMonth,
      transitionProgress: development.transitionProgress,
      satisfiedGateIds: development.satisfiedGateIds,
      missingGateIds: development.missingGateIds,
      index: {
        semantics: 'observer-only-never-planner-input',
        formulaVersion: index.formulaVersion ?? null,
        calculatedAtMonth: index.calculatedAtMonth,
        total: index.total,
      },
    },
    modern,
    status: opened.state.civilization.status,
    outcome: opened.state.civilization.outcome ?? null,
    survivingModern: development.current === 'modern-civilization'
      && modern.satisfied
      && opened.state.civilization.status === 'running',
  };
}

function makeHeader(api, id, seed, config, sourceHashes, snapshot) {
  const headerWithoutHash = {
    type: 'header',
    seq: 0,
    schema: ERA_LEDGER_SCHEMA,
    runId: id,
    seed,
    eraOrder: ERA_ORDER,
    pathSemantics: {
      skipPolicy: 'record-do-not-block-or-backfill',
      strictPathRequiresEveryEra: true,
      informationEra: 'merged-into-modern-civilization',
      medievalEra: 'merged-into-ancient-civilization',
    },
    observerVersion: api.DEVELOPMENT_OBSERVER_VERSION,
    engineBundleHash: sourceHashes.engineBundleHash,
    runnerHash: sourceHashes.runnerHash,
    runtime: {
      node: process.version,
    },
    config,
    configHash: sha256Bytes(canonicalJson(config)),
    lineageId: snapshot.authority.lineageId,
    coverageStartMonth: snapshot.authority.month,
    coverageCompleteFromMonth0: snapshot.authority.month === 0,
    prevHash: null,
  };
  return withLedgerHash(headerWithoutHash);
}

function appendBootstrap(api, paths, header, opened, snapshot) {
  const observation = makeLedgerObservation(api, opened, snapshot);
  const bootstrap = withLedgerHash({
    type: 'bootstrap',
    seq: 1,
    boundaryKind: 'bootstrap',
    recoveredAfterPublication: false,
    ...observation,
    transition: {
      from: observation.observer.current,
      to: observation.observer.current,
      kind: 'same',
      skipped: [],
    },
    proof: null,
    proofPolicy: 'append-time-db-verified',
    prevHash: header.hash,
  });
  atomicWriteNewFile(paths.ledger, Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(bootstrap)}\n`));
  return [header, bootstrap];
}

function appendRunnerSuccessorRecord(api, paths, lines, opened, snapshot, successor) {
  const previous = lines.at(-1);
  const observation = makeLedgerObservation(api, opened, snapshot);
  const record = withLedgerHash({
    type: 'runner-successor',
    seq: lines.length,
    boundaryKind: 'runner-successor',
    recoveredAfterPublication: false,
    runnerSuccessor: {
      ...successor,
      manifestEntryHash: runnerSuccessorEntryHash(successor),
    },
    ...observation,
    transition: transitionFrom(previous.observer.current, observation.observer.current),
    proof: null,
    proofPolicy: 'append-time-db-verified',
    prevHash: previous.hash,
  });
  appendDurableJsonLine(paths.ledger, record);
  lines.push(record);
  return record;
}

function appendBoundaryRecord(
  api,
  paths,
  lines,
  opened,
  snapshot,
  boundaryKind,
  recoveredAfterPublication,
  dataDirectory,
) {
  assert.equal(['annual', 'extinction', 'months-endpoint'].includes(boundaryKind), true);
  const previous = lines.at(-1);
  const observation = makeLedgerObservation(api, opened, snapshot);
  const transition = transitionFrom(previous.observer.current, observation.observer.current);
  const base = {
    type: 'boundary',
    seq: lines.length,
    boundaryKind,
    recoveredAfterPublication,
    ...observation,
    transition,
    proof: null,
    proofPolicy: 'append-time-db-verified',
    prevHash: previous.hash,
  };
  const needsProof = transition.kind !== 'same'
    || observation.status === 'ended';
  let record = withLedgerHash(base);
  if (needsProof) {
    const proof = writeTransitionProofPack(
      api,
      paths,
      runId,
      record,
      snapshot,
      dataDirectory,
    );
    record = withLedgerHash({ ...base, proof });
  }
  appendDurableJsonLine(paths.ledger, record);
  lines.push(record);
  return record;
}

function stableLedgerConfig(initialOpened, hotEventLimit, stopOnModern) {
  return {
    authoritativeEndpoint: structuredClone(initialOpened.state.civilization.conditions.endpoint),
    hotEventLimit,
    stopMode: stopOnModern ? 'stop-on-modern' : 'target-month',
  };
}

function validateHeader(lines, api, id, seed, config, sourceHashes) {
  const header = lines[0];
  assert.equal(header.runId, id, '时代账本 runId 与参数不一致');
  assert.equal(header.seed, seed, '时代账本 seed 与参数不一致');
  assert.deepEqual(header.config, config, '时代账本 config 与当前运行不一致');
  assert.equal(header.configHash, sha256Bytes(canonicalJson(config)), '时代账本 configHash 无效');
  assert.equal(header.observerVersion, api.DEVELOPMENT_OBSERVER_VERSION, '时代 observer version 漂移');
  assert.equal(
    header.engineBundleHash,
    sourceHashes.engineBundleHash,
    'engine bundle hash 漂移，必须使用新 run prefix',
  );
  const manifest = readRunnerSuccessorManifest();
  const activeRunnerHash = validateRunnerSuccessorChain(lines, manifest);
  if (activeRunnerHash === sourceHashes.runnerHash) return null;
  const successor = manifest.find((candidate) => (
    candidate.fromRunnerHash === activeRunnerHash
    && candidate.toRunnerHash === sourceHashes.runnerHash
  ));
  assert.ok(successor, 'runner source hash 漂移，必须使用新 run prefix');
  return successor;
}

function lastBoundaryMonth(lines) {
  return lines
    .filter((line) => line.type === 'boundary')
    .reduce((maximum, line) => Math.max(maximum, line.authority.month), lines[1].authority.month);
}

function scheduledAnnualsStrictlyBetween(startMonth, endMonth) {
  const months = [];
  for (let month = Math.floor(startMonth / 12) * 12 + 12; month < endMonth; month += 12) {
    months.push(month);
  }
  return months;
}

function boundaryKindFromOpened(opened) {
  const terminal = persistedTerminalKind(opened.state);
  if (terminal === 'extinction' || terminal === 'months-endpoint') return terminal;
  if (opened.meta.elapsedMonths % 12 === 0) return 'annual';
  throw new Error(`当前 month ${opened.meta.elapsedMonths} 不是可恢复 observer boundary`);
}

function assertLedgerContinuation(lines, opened, snapshot) {
  const header = lines[0];
  const latest = lines.at(-1);
  assert.equal(snapshot.authority.lineageId, header.lineageId, '运行 history lineage 与时代账本不一致');
  assert.equal(snapshot.authority.revision >= latest.authority.revision, true, '时代账本 revision 超前于 DB');
  assert.equal(snapshot.authority.month >= latest.authority.month, true, '时代账本 month 超前于 DB');
  assert.equal(snapshot.authority.eventCount >= latest.authority.eventCount, true, '时代账本 eventCount 超前于 DB');
  if (snapshot.authority.revision === latest.authority.revision
    || snapshot.authority.month === latest.authority.month) {
    assert.equal(snapshot.authority.revision, latest.authority.revision, '同月 revision 失配');
    assert.equal(snapshot.authority.month, latest.authority.month, '同 revision month 失配');
    assert.equal(snapshot.authority.stateHash, latest.authority.stateHash, '同 revision stateHash 失配');
    const coveredBoundaryMonth = lastBoundaryMonth(lines);
    const sourceMonth = snapshot.observerSource?.month ?? -1;
    return {
      recoverableBoundary: latest.type === 'runner-successor'
        && sourceMonth === snapshot.authority.month
        && sourceMonth > coveredBoundaryMonth,
    };
  }
  const sourceMonth = snapshot.observerSource?.month ?? -1;
  const coveredBoundaryMonth = lastBoundaryMonth(lines);
  if (sourceMonth > coveredBoundaryMonth && sourceMonth < snapshot.authority.month) {
    throw new Error(`DB 已越过未入账 observer boundary month ${sourceMonth}`);
  }
  if (sourceMonth === snapshot.authority.month && sourceMonth > coveredBoundaryMonth) {
    const hiddenAnnuals = scheduledAnnualsStrictlyBetween(coveredBoundaryMonth, sourceMonth);
    assert.deepEqual(hiddenAnnuals, [], `DB 跨过多个未知 observer boundary ${hiddenAnnuals.join(',')}`);
    return { recoverableBoundary: true };
  }
  const hiddenAnnuals = scheduledAnnualsStrictlyBetween(coveredBoundaryMonth, snapshot.authority.month);
  assert.deepEqual(hiddenAnnuals, [], `DB 已越过未入账 annual boundary ${hiddenAnnuals.join(',')}`);
  assert.equal(opened.state.civilization.status, 'running', 'ended DB 缺少 terminal boundary 入账');
  return { recoverableBoundary: false };
}

function initializeOrResumeLedger(
  api,
  paths,
  opened,
  id,
  seed,
  config,
  sourceHashes,
  dataDirectory,
) {
  const snapshot = authorityDatabaseSnapshot(api, dataDirectory, id, opened, false);
  if (!existsSync(paths.ledger)) {
    const header = makeHeader(api, id, seed, config, sourceHashes, snapshot);
    return appendBootstrap(api, paths, header, opened, snapshot);
  }
  const lines = readVerifiedLedger(paths.ledger);
  const pendingRunnerSuccessor = validateHeader(lines, api, id, seed, config, sourceHashes);
  const continuation = assertLedgerContinuation(lines, opened, snapshot);
  if (pendingRunnerSuccessor) {
    appendRunnerSuccessorRecord(
      api,
      paths,
      lines,
      opened,
      snapshot,
      pendingRunnerSuccessor,
    );
  }
  if (continuation.recoverableBoundary) {
    appendBoundaryRecord(
      api,
      paths,
      lines,
      opened,
      snapshot,
      boundaryKindFromOpened(opened),
      true,
      dataDirectory,
    );
  }
  return lines;
}

function assertCurrentSourceHashes(lines, bundlePath) {
  const header = lines[0];
  const currentRunnerHash = sha256Bytes(readFileSync(import.meta.filename));
  const currentBundleHash = sha256Bytes(readFileSync(bundlePath));
  assert.equal(
    currentRunnerHash,
    activeLedgerRunnerHash(lines),
    'runner source 在 staging 前漂移，必须使用新 run prefix',
  );
  assert.equal(currentBundleHash, header.engineBundleHash, 'engine bundle 在 staging 前漂移');
}

function emit(result) {
  assert.equal(emitted, false, 'stdout 结果只能输出一次');
  emitted = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function validateArguments() {
  assert.equal(
    process.argv.slice(2).length >= 4 && process.argv.slice(2).length <= 6,
    true,
    '用法: node scripts/run-bounded-modern-evolution.mjs '
      + '<absolute-data-dir> <run-id> <seed> <target-month> '
      + '[hot-limit=2048] [stop-on-modern]',
  );
  assert.equal(path.isAbsolute(dataDirectoryInput), true, 'data dir 必须显式使用绝对路径');
  assert.equal(RUN_ID_PATTERN.test(runId ?? ''), true, 'run-id 仅支持 1-64 位字母、数字、下划线或连字符');
  const seed = Number(seedInput);
  const targetMonth = Number(targetMonthInput);
  const hotEventLimit = hotLimitInput === undefined ? 2_048 : Number(hotLimitInput);
  assert.equal(
    stopModeInput === undefined || stopModeInput === 'stop-on-modern',
    true,
    '可选停止模式只能是 stop-on-modern',
  );
  assert.equal(Number.isSafeInteger(seed), true, 'seed 必须是安全整数');
  assert.equal(
    Number.isSafeInteger(targetMonth) && targetMonth >= 1 && targetMonth <= 12_000,
    true,
    'target-month 必须是 1-12000 的安全整数',
  );
  assert.equal(
    Number.isSafeInteger(hotEventLimit) && hotEventLimit >= 1 && hotEventLimit <= 65_536,
    true,
    'hot-limit 必须是 1-65536 的安全整数',
  );
  return {
    dataDirectory: path.resolve(dataDirectoryInput),
    seed,
    targetMonth,
    hotEventLimit,
    stopOnModern: stopModeInput === 'stop-on-modern',
  };
}

function compactDevelopment(state) {
  const basis = state.lastMaterializedObserverBasis;
  const development = state.civilization.development
    ?? (basis?.version === 2 ? basis.developmentSnapshot : null);
  return {
    observerVersion: development?.observerVersion ?? null,
    current: development?.currentEra ?? null,
    historical: development?.historicalPeakEra ?? null,
    candidate: development?.candidateEra ?? null,
  };
}

function developmentSnapshot(state) {
  const basis = state.lastMaterializedObserverBasis;
  return state.civilization.development
    ?? (basis?.version === 2 ? basis.developmentSnapshot : null);
}

function modernAchievement(api, state) {
  const development = developmentSnapshot(state);
  const eraReached = development?.currentEra === 'modern-civilization'
    || development?.historicalPeakEra === 'modern-civilization';
  const evidence = api.observeModernCivilizationEvidence(state);
  return { achieved: Boolean(eraReached && evidence.satisfied), evidence };
}

function persistedTerminalKind(state) {
  if (state.civilization.status !== 'ended') return null;
  if (state.civilization.outcome?.kind === 'destroyed') return 'extinction';
  if (state.civilization.outcome?.kind === 'boundary') return 'months-endpoint';
  if (state.civilization.outcome?.kind === 'milestones') return 'milestones-endpoint';
  return 'ended';
}

function compactCounts(opened) {
  return {
    month: opened.meta.elapsedMonths,
    revision: opened.meta.revision,
    eventCount: opened.meta.eventCount,
    living: opened.meta.livingAgents,
    agentCount: opened.meta.agentCount,
    people: opened.state.people.length,
    records: opened.state.records.length,
    projects: opened.state.projects.length,
    hotEvents: opened.state.world.past.length,
    status: opened.meta.status,
  };
}

async function openOrBootstrapExisting(api, id, expectedSeed, hotEventLimit) {
  try {
    const opened = await store.openBoundedEvolutionContinuation(id);
    assert.equal(opened.state.seed, expectedSeed, `运行 ${id} 的 seed 与参数不一致`);
    return opened;
  } catch (error) {
    if (!/没有已持久化的 bounded continuation/u.test(errorText(error))) throw error;
    // A legacy run without a continuation must be decoded once to validate the
    // seed before the runner is allowed to add continuation authority.
    const loaded = await store.load(id);
    assert.equal(loaded.state.seed, expectedSeed, `运行 ${id} 的 seed 与参数不一致`);
    await store.bootstrapBoundedEvolutionContinuation(id, hotEventLimit);
    const opened = await store.openBoundedEvolutionContinuation(id);
    assert.equal(opened.state.seed, expectedSeed, `运行 ${id} 的 seed 与参数不一致`);
    return opened;
  }
}

async function annualProgress(month, receipt) {
  const summary = (await store.list()).find((candidate) => candidate.id === runId);
  if (!summary) throw new Error(`年度进度回读不到运行 ${runId}`);
  const progress = {
    month,
    revision: summary.revision,
    eventCount: summary.eventCount,
    living: summary.livingAgents,
    agentCount: summary.agentCount,
    stage: receipt.stage,
    elapsedMs: Math.round(performance.now() - startedAt),
    maxRss: maxRssBytes(),
  };
  process.stderr.write(`${JSON.stringify(progress)}\n`);
}

async function run() {
  const {
    dataDirectory,
    seed,
    targetMonth,
    hotEventLimit,
    stopOnModern,
  } = validateArguments();
  const paths = ledgerPaths(dataDirectory, runId);
  mkdirSync(dataDirectory, { recursive: true });
  acquireLedgerLock(paths.lock);
  ledgerLockPath = paths.lock;
  writeFileSync(entryPath, engineEntrySource());
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=error',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: process.env, stdio: 'pipe' });
  const sourceHashes = {
    engineBundleHash: sha256Bytes(readFileSync(bundlePath)),
    runnerHash: sha256Bytes(readFileSync(import.meta.filename)),
  };
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  store = new api.SqliteRunStore(dataDirectory);

  const existingSummary = (await store.list()).find((candidate) => candidate.id === runId);
  let created = false;
  let initialOpened;
  if (existingSummary) {
    initialOpened = await openOrBootstrapExisting(api, runId, seed, hotEventLimit);
  } else {
    const state = api.createInitialState(seed, {
      civilizationNo: 1,
      climateBias: 'balanced',
      chaosIntensity: 0,
      endpoint: { kind: 'months', value: 12_000 },
    });
    await store.create({ id: runId, label: runId, state });
    await store.bootstrapBoundedEvolutionContinuation(runId, hotEventLimit);
    initialOpened = await store.openBoundedEvolutionContinuation(runId);
    created = true;
  }

  const startMonth = initialOpened.meta.elapsedMonths;
  const endpoint = structuredClone(initialOpened.state.civilization.conditions.endpoint);
  const ledgerConfig = stableLedgerConfig(initialOpened, hotEventLimit, stopOnModern);
  const ledgerLines = initializeOrResumeLedger(
    api,
    paths,
    initialOpened,
    runId,
    seed,
    ledgerConfig,
    sourceHashes,
    dataDirectory,
  );
  const initialModern = modernAchievement(api, initialOpened.state);
  const initialTerminalKind = persistedTerminalKind(initialOpened.state);
  const initialTerminalMonth = initialTerminalKind === null
    ? null
    : initialOpened.state.civilization.outcome?.atMonth ?? startMonth;
  assert.equal(initialOpened.state.seed, seed, `运行 ${runId} 的 seed 与参数不一致`);
  assert.equal(
    targetMonth >= startMonth,
    true,
    `target-month ${targetMonth} 不能早于当前月 ${startMonth}`,
  );
  initialOpened = undefined;

  let currentMonth = startMonth;
  let stopped = null;
  let reachedModernAtMonth = initialModern.achieved
    ? startMonth
    : null;
  let reachedTerminalAtMonth = initialTerminalMonth;
  let terminalKind = initialTerminalKind;
  if (reachedTerminalAtMonth !== null) currentMonth = targetMonth;
  if (stopOnModern && reachedModernAtMonth !== null) currentMonth = targetMonth;
  while (currentMonth < targetMonth) {
    const nextMonth = currentMonth + 1;
    try {
      assertCurrentSourceHashes(ledgerLines, bundlePath);
      const scheduledBoundary = nextMonth % 12 === 0
        || (endpoint.kind === 'months' && nextMonth === endpoint.value);
      let receipt;
      if (scheduledBoundary) {
        receipt = await store.publishBoundedObserverBoundaryMonth(
          await store.stageBoundedObserverBoundaryMonth(runId),
        );
      } else {
        try {
          receipt = await store.publishBoundedNonProjectionMonth(
            await store.stageBoundedNonProjectionMonth(runId),
          );
        } catch (error) {
          if (errorName(error) !== 'BoundedNonProjectionTerminalBoundaryRequiredError') {
            throw error;
          }
          receipt = await store.publishBoundedObserverBoundaryMonth(
            await store.stageBoundedTerminalMonth(runId),
          );
        }
      }
      assert.equal(receipt.month, nextMonth, 'bounded publication 没有提交预期月份');
      currentMonth = nextMonth;
      if (receipt.boundaryKind) {
        if (process.env.NODE_ENV === 'test'
          && process.env.ELAND_ERA_LEDGER_FAIL_AFTER_BOUNDARY_COMMIT_FOR_TESTS === '1') {
          throw new Error('fixture injected crash after boundary DB commit before ledger append');
        }
        let boundaryOpened = await store.openBoundedEvolutionContinuation(runId);
        assert.equal(receipt.revision, boundaryOpened.meta.revision, 'receipt/opened revision 失配');
        assert.equal(receipt.month, boundaryOpened.meta.elapsedMonths, 'receipt/opened month 失配');
        assert.equal(receipt.stateHash, boundaryOpened.basis.stateHash, 'receipt/opened stateHash 失配');
        assert.equal(receipt.status, boundaryOpened.meta.status, 'receipt/opened status 失配');
        const boundarySnapshot = authorityDatabaseSnapshot(
          api,
          dataDirectory,
          runId,
          boundaryOpened,
          true,
        );
        const boundaryRecord = appendBoundaryRecord(
          api,
          paths,
          ledgerLines,
          boundaryOpened,
          boundarySnapshot,
          receipt.boundaryKind,
          false,
          dataDirectory,
        );
        const boundaryModernAchieved = boundaryRecord.observer.current === 'modern-civilization'
          && boundaryRecord.modern.satisfied;
        if (boundaryModernAchieved && reachedModernAtMonth === null) {
          reachedModernAtMonth = currentMonth;
        }
        boundaryOpened = undefined;
        if (currentMonth % 12 === 0) await annualProgress(currentMonth, receipt);
        if (receipt.boundaryKind === 'extinction'
          || receipt.boundaryKind === 'months-endpoint') {
          reachedTerminalAtMonth = currentMonth;
          terminalKind = receipt.boundaryKind;
          break;
        }
        if (stopOnModern && reachedModernAtMonth === currentMonth) break;
      }
    } catch (error) {
      stopped = {
        earliestMonth: nextMonth,
        errorName: errorName(error),
        error: errorText(error),
        publicationUnsupported: /暂不支持|拒绝 staging|不再运行|extinction|endpoint/u.test(
          errorText(error),
        ),
      };
      break;
    }
  }

  const finalOpened = await store.openBoundedEvolutionContinuation(runId);
  assert.equal(finalOpened.state.seed, seed, `运行 ${runId} 的最终 seed 与参数不一致`);
  const finalModern = modernAchievement(api, finalOpened.state);
  const evidence = finalModern.evidence;
  if (finalModern.achieved && reachedModernAtMonth === null) {
    reachedModernAtMonth = finalOpened.meta.elapsedMonths;
  }
  const finalTerminalKind = persistedTerminalKind(finalOpened.state);
  if (finalTerminalKind !== null) {
    terminalKind = finalTerminalKind;
    reachedTerminalAtMonth = finalOpened.state.civilization.outcome?.atMonth
      ?? finalOpened.meta.elapsedMonths;
  }
  const result = {
    ok: stopped === null && (
      finalOpened.meta.elapsedMonths === targetMonth
      || reachedTerminalAtMonth !== null
      || (stopOnModern && reachedModernAtMonth !== null)
    ),
    runId,
    seed,
    created,
    startMonth,
    targetMonth,
    reachedMonth: finalOpened.meta.elapsedMonths,
    reachedModernAtMonth,
    reachedTerminalAtMonth,
    terminalKind,
    outcome: finalOpened.state.civilization.outcome ?? null,
    stopOnModern,
    hotEventLimit,
    ...(stopped ? { stopped } : {}),
    stage: finalOpened.state.civilization.stage,
    development: compactDevelopment(finalOpened.state),
    modernEvidence: evidence,
    eraBoundaryLedger: {
      path: paths.ledger,
      proofDirectory: paths.proofDirectory,
      entries: ledgerLines.length,
      headHash: ledgerLines.at(-1)?.hash ?? null,
    },
    counts: compactCounts(finalOpened),
    totalElapsedMs: Math.round(performance.now() - startedAt),
    maxRss: maxRssBytes(),
  };
  store.close();
  store = undefined;
  releaseLedgerLock();
  emit(result);
  if (!result.ok) process.exitCode = 2;
}

try {
  await run();
} catch (error) {
  emit({
    ok: false,
    runId: runId ?? null,
    errorName: errorName(error),
    error: errorText(error),
    totalElapsedMs: Math.round(performance.now() - startedAt),
    maxRss: maxRssBytes(),
  });
  process.exitCode = 1;
} finally {
  store?.close();
  releaseLedgerLock();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
