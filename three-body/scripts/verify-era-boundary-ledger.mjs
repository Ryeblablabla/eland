import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { brotliDecompressSync } from 'node:zlib';
import { deserialize } from 'node:v8';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const [dataDirectoryInput, runId, ledgerPathInput] = process.argv.slice(2);
const startedAt = performance.now();
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-era-ledger-verify-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'verifier-engine.mjs');
const ERA_LEDGER_SCHEMA = 'eland-era-boundary-ledger-v1';
const ERA_PROOF_SCHEMA_V1 = 'eland-era-boundary-proof-pack-v1';
const ERA_PROOF_SCHEMA = 'eland-era-boundary-proof-pack-v2';
const ERA_PROOF_SCHEMAS = new Set([ERA_PROOF_SCHEMA_V1, ERA_PROOF_SCHEMA]);
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
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
let store;

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
  return sha256Bytes(`${value.schema}\0${canonicalJson(value)}`);
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
  return eventIds.map((eventId) => ({ eventId, ordinal: ordinals.get(eventId) ?? null }));
}

function modernSnapshot(api, opened) {
  const evidence = api.observeModernCivilizationEvidence(opened.state);
  const gates = {
    'power:complete-network-useful-load': evidence.electricalPower !== null,
    'measurement:calibrated-comparable-mass': evidence.comparableMeasurement !== null,
    'record:independent-experiment-reuse': evidence.independentRecordExperiment !== null,
  };
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
  return source ? {
    revision: source.revision,
    month: source.month,
    stateHash: source.stateHash,
  } : null;
}

function currentSnapshot(api, opened, database, id) {
  const row = database.prepare(`
    SELECT runs.revision, runs.elapsed_months, runs.state_hash, runs.status,
           runs.event_count, run_continuations.shell_hash,
           run_continuations.history_lineage_id,
           run_continuations.history_head_hash, run_continuations.tail_event_id,
           run_continuations.tail_event_content_hash, run_continuations.bundle_hash
    FROM runs
    JOIN run_continuations ON run_continuations.run_id = runs.id
    WHERE runs.id = ?
  `).get(id);
  assert.ok(row, `运行 ${id} 缺少 bounded authority`);
  const cursor = opened.state.world.historyCursor;
  assert.ok(cursor, 'bounded authority 缺少 historyCursor');
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
  const development = exactDevelopment(api, opened.state);
  const index = opened.state.civilization.civilizationIndex;
  const modern = modernSnapshot(api, opened);
  return {
    authority,
    observer: {
      source: observerSourceOf(opened.state),
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

function readVerifiedLedger(filePath) {
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
  const header = lines[0];
  assert.equal(header.type, 'header');
  assert.equal(header.schema, ERA_LEDGER_SCHEMA);
  assert.deepEqual(header.eraOrder, ERA_ORDER);
  assert.equal(lines[1].type, 'bootstrap');
  for (const line of lines.slice(1)) {
    assert.equal(line.authority?.lineageId, header.lineageId, `时代账本 seq ${line.seq} lineage 失配`);
  }
  return lines;
}

function transitionFrom(previousEra, nextEra) {
  const previousRank = ERA_ORDER.indexOf(previousEra);
  const nextRank = ERA_ORDER.indexOf(nextEra);
  assert.notEqual(previousRank, -1);
  assert.notEqual(nextRank, -1);
  if (previousRank === nextRank) return { from: previousEra, to: nextEra, kind: 'same', skipped: [] };
  if (nextRank < previousRank) return { from: previousEra, to: nextEra, kind: 'regression', skipped: [] };
  const skipped = ERA_ORDER.slice(previousRank + 1, nextRank);
  return {
    from: previousEra,
    to: nextEra,
    kind: skipped.length > 0 ? 'skip' : 'advance',
    skipped,
  };
}

function chunkFromPack(pack, role) {
  const encoded = pack.chunks.find((chunk) => chunk.roles.includes(role));
  assert.ok(encoded, `proof pack 缺少 ${role}`);
  return {
    hash: encoded.hash,
    codec: encoded.codec,
    rawSize: encoded.rawSize,
    data: Buffer.from(encoded.data, 'base64'),
  };
}

function decodedShellValue(api, pack, role) {
  const chunk = chunkFromPack(pack, role);
  const compressed = api.verifiedRunStateChunkData(
    chunk,
    api.RUN_STATE_SHELL_PART_CODEC,
    `proof ${role}`,
  );
  return deserialize(brotliDecompressSync(compressed));
}

function assertManifestField(api, pack, rootRole, scope, fieldName, chunkHash) {
  const root = api.parseRunStateRoot(chunkFromPack(pack, `${rootRole}:root`));
  const manifestChunk = chunkFromPack(pack, `${rootRole}:shell-manifest`);
  assert.equal(root.shellHash, manifestChunk.hash);
  const manifest = api.parseRunStateShellManifest(manifestChunk);
  const fields = scope === 'state' ? manifest.fields : manifest.worldFields;
  const field = fields.find((candidate) => candidate.name === fieldName);
  assert.ok(field, `proof ${rootRole} 缺少 ${scope}.${fieldName}`);
  assert.equal(field.kind, 'value');
  assert.equal(field.hash, chunkHash);
  return root;
}

function verifiedProofHistoryCursor(api, pack, rootKey, rootRole, root, bundle) {
  const cursorField = pack.fields[rootKey].find(
    (field) => field.scope === 'world' && field.fieldName === 'historyCursor',
  );
  if (cursorField) {
    const cursor = decodedShellValue(api, pack, `${rootRole}:world.historyCursor`);
    const seal = pack.historyCursorSeals?.[rootKey];
    if (seal) {
      assert.equal(seal.evidence, 'shell-field');
      assert.equal(seal.eventCount, cursor.eventCount);
      assert.equal(seal.tailEventId, cursor.tailEventId);
    }
    return cursor;
  }

  const manifest = api.parseRunStateShellManifest(
    chunkFromPack(pack, `${rootRole}:shell-manifest`),
  );
  assert.equal(
    manifest.worldFields.some((field) => field.name === 'historyCursor'),
    false,
    `proof ${rootRole} manifest 含 cursor 但 fields 未封存`,
  );
  const seal = pack.historyCursorSeals?.[rootKey];
  assert.ok(seal, `proof ${rootRole} 缺少 history cursor seal`);
  assert.equal(seal.evidence, 'root-metadata+continuation-bundle');
  assert.equal(seal.eventCount, root.eventCount);
  assert.equal(seal.tailEventId, bundle.authority.tailEventId);
  return { eventCount: seal.eventCount, tailEventId: seal.tailEventId };
}

function verifyProofPack(api, dataDirectory, expectedRunId, line) {
  assert.ok(line.proof, `seq ${line.seq} 没有 proof reference`);
  assert.equal(ERA_PROOF_SCHEMAS.has(line.proof.schema), true);
  assert.equal(HASH_PATTERN.test(line.proof.hash), true);
  const proofPath = path.resolve(dataDirectory, line.proof.relativePath);
  const relative = path.relative(dataDirectory, proofPath);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, 'proof path 逃逸 data directory');
  assert.equal(existsSync(proofPath), true, `proof pack ${line.proof.hash} 缺失`);
  const rawPack = readFileSync(proofPath, 'utf8');
  const pack = JSON.parse(rawPack);
  assert.equal(rawPack, `${canonicalJson(pack)}\n`, `proof pack ${line.proof.hash} 不是 canonical bytes`);
  assert.equal(pack.schema, line.proof.schema);
  assert.equal(proofPackHash(pack), line.proof.hash, `proof pack ${line.proof.hash} hash 无效`);
  assert.equal(pack.runId, expectedRunId);
  assert.equal(pack.ledgerSeq, line.seq);
  assert.equal(pack.boundaryKind, line.boundaryKind);
  assert.deepEqual(pack.authority, line.authority);
  assert.deepEqual(pack.observer, line.observer);
  assert.deepEqual(pack.modern, line.modern);
  assert.equal(pack.status, line.status);
  assert.deepEqual(pack.outcome, line.outcome);
  assert.equal(pack.limitation, 'observer-field-proof-only-no-full-history-replay');
  for (const encoded of pack.chunks) {
    assert.equal(HASH_PATTERN.test(encoded.hash), true);
    assert.equal(Number.isSafeInteger(encoded.rawSize) && encoded.rawSize >= 0, true);
    assert.equal(Array.isArray(encoded.roles) && encoded.roles.length >= 1, true);
    const chunk = {
      hash: encoded.hash,
      codec: encoded.codec,
      rawSize: encoded.rawSize,
      data: Buffer.from(encoded.data, 'base64'),
    };
    if (encoded.roles.some((role) => role.endsWith(':root'))) api.parseRunStateRoot(chunk);
    else if (encoded.roles.some((role) => role.endsWith(':shell-manifest'))) {
      api.parseRunStateShellManifest(chunk);
    } else if (encoded.roles.includes('continuation-bundle')) {
      api.decodeRunContinuationBundle(chunk);
    } else {
      api.verifiedRunStateChunkData(chunk, api.RUN_STATE_SHELL_PART_CODEC, 'proof shell part');
    }
  }
  for (const [rootKey, rootRole] of [['rootA', 'root-a'], ['rootB', 'root-b']]) {
    for (const field of pack.fields[rootKey]) {
      assertManifestField(api, pack, rootRole, field.scope, field.fieldName, field.chunkHash);
      assert.equal(
        chunkFromPack(pack, `${rootRole}:${field.scope}.${field.fieldName}`).hash,
        field.chunkHash,
      );
    }
  }
  const rootA = api.parseRunStateRoot(chunkFromPack(pack, 'root-a:root'));
  const rootB = api.parseRunStateRoot(chunkFromPack(pack, 'root-b:root'));
  assert.equal(rootB.schemaVersion, 3);
  assert.equal(rootB.shellHash, line.authority.shellHash);
  assert.equal(rootB.lineageId, line.authority.lineageId);
  assert.equal(rootB.historyHeadHash, line.authority.historyHeadHash);
  assert.equal(rootB.eventCount, line.authority.eventCount);
  assert.equal(rootB.tailEventContentHash, line.authority.tailEventContentHash);
  assert.equal(chunkFromPack(pack, 'root-b:root').hash, line.authority.stateHash);
  assert.equal(chunkFromPack(pack, 'root-a:root').hash, line.observer.source.stateHash);
  assert.equal(rootA.lineageId, rootB.lineageId);
  assert.equal(rootA.historyHeadHash, rootB.historyHeadHash);
  assert.equal(rootA.eventCount, rootB.eventCount);
  assert.equal(rootA.tailEventContentHash, rootB.tailEventContentHash);
  const bundle = api.decodeRunContinuationBundle(chunkFromPack(pack, 'continuation-bundle'));
  assert.equal(bundle.authority.revision, line.authority.revision);
  assert.equal(bundle.authority.stateHash, line.authority.stateHash);
  assert.equal(bundle.authority.historyLineageId, line.authority.lineageId);
  assert.equal(bundle.authority.historyHeadHash, line.authority.historyHeadHash);
  assert.equal(bundle.authority.eventCount, line.authority.eventCount);
  assert.equal(bundle.authority.tailEventId, line.authority.tailEventId);
  assert.equal(bundle.authority.tailEventContentHash, line.authority.tailEventContentHash);
  assert.deepEqual(bundle.observerMaterializationSource, line.observer.source);

  const clockB = decodedShellValue(api, pack, 'root-b:state.clock');
  const civilizationB = decodedShellValue(api, pack, 'root-b:state.civilization');
  const basisB = decodedShellValue(api, pack, 'root-b:state.lastMaterializedObserverBasis');
  const clockA = decodedShellValue(api, pack, 'root-a:state.clock');
  const cursorB = verifiedProofHistoryCursor(api, pack, 'rootB', 'root-b', rootB, bundle);
  const cursorA = verifiedProofHistoryCursor(api, pack, 'rootA', 'root-a', rootA, bundle);
  const sealedDevelopment = civilizationB.development ?? basisB.developmentSnapshot;
  assert.ok(sealedDevelopment, 'proof root B 缺少 development stability snapshot');
  assert.equal(clockB.elapsedMonths, line.authority.month);
  assert.equal(civilizationB.status, line.status);
  assert.deepEqual(civilizationB.outcome ?? null, line.outcome);
  assert.equal(normalizeEra(api, sealedDevelopment.currentEra), line.observer.current);
  assert.equal(normalizeEra(api, sealedDevelopment.historicalPeakEra), line.observer.historical);
  assert.equal(normalizeEra(api, sealedDevelopment.candidateEra), line.observer.candidate);
  assert.equal(sealedDevelopment.candidateSinceMonth, line.observer.candidateSinceMonth);
  assert.equal(civilizationB.civilizationIndex?.total, line.observer.index.total);
  assert.deepEqual(basisB.source, line.observer.source);
  assert.equal(cursorB.eventCount, line.authority.eventCount);
  assert.equal(cursorB.tailEventId, line.authority.tailEventId);
  assert.equal(clockA.elapsedMonths, line.observer.source.month);
  assert.equal(cursorA.eventCount, line.authority.eventCount);
  assert.equal(cursorA.tailEventId, line.authority.tailEventId);
  return true;
}

function assertLedgerAgainstCurrent(lines, current) {
  const header = lines[0];
  const latest = lines.at(-1);
  assert.equal(current.authority.lineageId, header.lineageId, 'DB lineage 与时代账本不一致');
  assert.equal(current.authority.revision >= latest.authority.revision, true, '时代账本 revision 超前于 DB');
  assert.equal(current.authority.month >= latest.authority.month, true, '时代账本 month 超前于 DB');
  assert.equal(current.authority.eventCount >= latest.authority.eventCount, true, '时代账本 eventCount 超前于 DB');
  if (current.authority.revision === latest.authority.revision
    || current.authority.month === latest.authority.month) {
    assert.deepEqual(current.authority, latest.authority, '同 revision/month DB authority 与账本失配');
    return { state: 'exact' };
  }
  const coveredBoundaryMonth = lines
    .filter((line) => line.type === 'boundary')
    .reduce((maximum, line) => Math.max(maximum, line.authority.month), lines[1].authority.month);
  const sourceMonth = current.observer.source?.month ?? -1;
  if (sourceMonth > coveredBoundaryMonth && sourceMonth < current.authority.month) {
    throw new Error(`DB 已越过未入账 observer boundary month ${sourceMonth}`);
  }
  const hiddenAnnuals = [];
  for (let month = Math.floor(coveredBoundaryMonth / 12) * 12 + 12;
    month < current.authority.month;
    month += 12) hiddenAnnuals.push(month);
  assert.deepEqual(hiddenAnnuals, [], `DB 已越过未入账 annual boundary ${hiddenAnnuals.join(',')}`);
  if (sourceMonth === current.authority.month && sourceMonth > coveredBoundaryMonth) {
    return { state: 'recoverable-current-boundary' };
  }
  assert.equal(current.status, 'running', 'ended DB 缺少 terminal boundary 入账');
  return { state: 'db-ahead-nonboundary' };
}

function sameCurrentRecord(line, current) {
  return line.authority.revision === current.authority.revision
    && line.authority.month === current.authority.month
    && line.authority.stateHash === current.authority.stateHash;
}

async function run() {
  assert.equal(process.argv.slice(2).length >= 2 && process.argv.slice(2).length <= 3, true,
    '用法: node scripts/verify-era-boundary-ledger.mjs <absolute-data-dir> <run-id> [ledger-path]');
  assert.equal(path.isAbsolute(dataDirectoryInput), true, 'data dir 必须是绝对路径');
  assert.equal(RUN_ID_PATTERN.test(runId ?? ''), true, 'run-id 无效');
  const dataDirectory = path.resolve(dataDirectoryInput);
  const ledgerPath = ledgerPathInput
    ? path.resolve(ledgerPathInput)
    : path.join(dataDirectory, `${runId}.era-boundary-ledger-v1.jsonl`);
  assert.equal(existsSync(ledgerPath), true, `时代账本 ${ledgerPath} 不存在`);
  const lines = readVerifiedLedger(ledgerPath);
  const header = lines[0];
  assert.equal(header.runId, runId);
  assert.equal(header.configHash, sha256Bytes(canonicalJson(header.config)));

  writeFileSync(entryPath, engineEntrySource());
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=error',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: process.env, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  assert.equal(header.observerVersion, api.DEVELOPMENT_OBSERVER_VERSION);
  const sourceHashesCurrent = {
    runner: sha256Bytes(readFileSync(path.join(workspace, 'scripts/run-bounded-modern-evolution.mjs')))
      === header.runnerHash,
    engineBundle: sha256Bytes(readFileSync(bundlePath)) === header.engineBundleHash,
  };

  store = new api.SqliteRunStore(dataDirectory, { readOnly: true });
  const opened = await store.openBoundedEvolutionContinuation(runId);
  assert.equal(opened.state.seed, header.seed, 'DB seed 与账本不一致');
  const database = new DatabaseSync(path.join(dataDirectory, 'eland.sqlite3'), { readOnly: true });
  let current;
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    current = currentSnapshot(api, opened, database, runId);
  } finally {
    database.close();
  }
  const dbRelation = assertLedgerAgainstCurrent(lines, current);

  const records = lines.slice(1);
  const proofStrength = [];
  let previousEra = records[0].observer.current;
  for (let index = 0; index < records.length; index += 1) {
    const line = records[index];
    assert.equal(line.observer.index.semantics, 'observer-only-never-planner-input');
    assert.equal(ERA_ORDER.includes(line.observer.current), true);
    assert.equal(ERA_ORDER.includes(line.observer.historical), true);
    assert.equal(ERA_ORDER.includes(line.observer.candidate), true);
    const expectedTransition = index === 0
      ? { from: line.observer.current, to: line.observer.current, kind: 'same', skipped: [] }
      : transitionFrom(previousEra, line.observer.current);
    assert.deepEqual(line.transition, expectedTransition, `seq ${line.seq} transition 不诚实`);
    previousEra = line.observer.current;
    let strength;
    let limitation = null;
    if (line.proof) verifyProofPack(api, dataDirectory, runId, line);
    if (sameCurrentRecord(line, current)) {
      assert.deepEqual(line.authority, current.authority);
      assert.deepEqual(line.observer, current.observer);
      assert.deepEqual(line.modern, current.modern);
      assert.equal(line.status, current.status);
      assert.deepEqual(line.outcome, current.outcome);
      assert.equal(line.survivingModern, current.survivingModern);
      strength = 'db-live';
    } else if (line.proof) {
      strength = 'proof-pack';
      limitation = line.proof.limitation;
    } else {
      strength = 'append-time-only';
      limitation = 'historical root not live and no compact proof pack; hash chain proves only recorded bytes';
    }
    proofStrength.push({
      seq: line.seq,
      type: line.type,
      month: line.authority.month,
      strength,
      ...(limitation ? { limitation } : {}),
    });
  }

  const observedPath = [];
  for (const record of records) {
    if (observedPath.at(-1) !== record.observer.current) observedPath.push(record.observer.current);
  }
  const skips = records
    .filter((record) => record.transition.kind === 'skip')
    .map((record) => ({
      seq: record.seq,
      month: record.authority.month,
      from: record.transition.from,
      to: record.transition.to,
      skipped: record.transition.skipped,
    }));
  const regressions = records
    .filter((record) => record.transition.kind === 'regression')
    .map((record) => ({
      seq: record.seq,
      month: record.authority.month,
      from: record.transition.from,
      to: record.transition.to,
    }));
  const modernLiveRecord = records.find((record) => (
    record.modern.satisfied && sameCurrentRecord(record, current)
  ));
  const modernEvidenceVerified = Boolean(modernLiveRecord && current.modern.satisfied);
  const terminalRecord = [...records].reverse().find((record) => record.status === 'ended') ?? null;
  const latest = records.at(-1);
  const survivingModern = latest.status === 'running'
    && latest.observer.current === 'modern-civilization'
    && latest.modern.satisfied;
  const strictPathSatisfied = header.coverageCompleteFromMonth0
    && observedPath.length === ERA_ORDER.length
    && observedPath.every((era, index) => era === ERA_ORDER[index])
    && skips.length === 0
    && regressions.length === 0
    && modernEvidenceVerified;
  const result = {
    ok: true,
    schema: ERA_LEDGER_SCHEMA,
    runId,
    ledgerPath,
    ledgerHeadHash: lines.at(-1).hash,
    sourceHashesCurrent,
    dbRelation: dbRelation.state,
    coverage: {
      startMonth: header.coverageStartMonth,
      completeFromMonth0: header.coverageCompleteFromMonth0,
    },
    observedPath,
    skips,
    regressions,
    modernEvidenceVerified,
    terminal: terminalRecord ? {
      month: terminalRecord.authority.month,
      boundaryKind: terminalRecord.boundaryKind,
      outcome: terminalRecord.outcome,
    } : null,
    pathSatisfied: observedPath.includes('modern-civilization') && modernEvidenceVerified,
    strictPathSatisfied,
    survivingModern,
    proofStrength,
    proofLimitation: proofStrength.some((proof) => proof.strength === 'append-time-only')
      ? 'non-transition historical rows without live DB roots are append-time verified, not fully replayable'
      : null,
    totalElapsedMs: Math.round(performance.now() - startedAt),
    maxRss: maxRssBytes(),
  };
  store.close();
  store = undefined;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await run();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    runId: runId ?? null,
    errorName: errorName(error),
    error: errorText(error),
    totalElapsedMs: Math.round(performance.now() - startedAt),
    maxRss: maxRssBytes(),
  })}\n`);
  process.exitCode = 2;
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
