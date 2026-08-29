import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const workspaceRealPath = realpathSync(workspace);
const EVIDENCE_SCHEMA = 'eland-bounded-horizon-causal-evidence-v1';
const EVIDENCE_HASH_DOMAIN = `${EVIDENCE_SCHEMA}\0`;
const LEDGER_SCHEMA = 'eland-era-boundary-ledger-v1';
const LEDGER_HASH_DOMAIN = `${LEDGER_SCHEMA}\0`;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_LEDGER_BYTES = 32 * 1_024 * 1_024;
const MAX_LEDGER_LINES = 2_048;
const MAX_PROJECT_LIFECYCLES = 16_384;
const MAX_LIFE_EVENTS = 16_384;
const MAX_PROJECT_ACTION_MEMBERSHIPS = 262_144;
const MAX_EMBEDDED_PROJECT_REFERENCE_KEYS = 16_384;
const MAX_REPRESENTATIVE_EVENTS = 24;
const MAX_REFERENCED_EVENT_IDS = 24;
const MAX_WALK_NODES = 256;
const ESBUILD_VERIFIER_ARGUMENTS = Object.freeze([
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--minify',
  '--log-level=error',
]);
const extractorSourcePath = path.resolve(import.meta.filename);
const runStateCodecSourcePath = path.join(workspace, 'server/run-state-codec.ts');
const runContinuationBundleSourcePath = path.join(
  workspace,
  'server/run-continuation-bundle.ts',
);

const [dataDirectoryInput, runId, expectedMonthInput, outputRootInput] = process.argv.slice(2);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceHash(value) {
  return sha256(`${EVIDENCE_HASH_DOMAIN}${canonicalJson(value)}`);
}

function ledgerEntryHash(value) {
  return sha256(`${LEDGER_HASH_DOMAIN}${canonicalJson(value)}`);
}

function recordOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function increment(map, key, amount = 1) {
  const normalized = String(key ?? 'unknown');
  map.set(normalized, (map.get(normalized) ?? 0) + amount);
}

function sortedCountObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function sortedStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWriteNewOrSame(filePath, bytes) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    assert.equal(readFileSync(filePath).equals(bytes), true, `已有证据文件内容冲突: ${filePath}`);
    return false;
  }
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
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function validateArguments() {
  assert.equal(typeof dataDirectoryInput, 'string', '用法: extract <absolute-data-dir> <run-id> <month> <absolute-output-root>');
  assert.equal(typeof outputRootInput, 'string', '缺少 absolute output root');
  assert.equal(path.isAbsolute(dataDirectoryInput), true, 'data directory 必须是绝对路径');
  assert.equal(path.isAbsolute(outputRootInput), true, 'output root 必须是绝对路径');
  assert.equal(RUN_ID_PATTERN.test(runId ?? ''), true, 'run id 无效');
  const expectedMonth = Number(expectedMonthInput);
  assert.equal(Number.isSafeInteger(expectedMonth) && expectedMonth >= 0, true, 'month 必须是非负安全整数');
  const dataDirectory = path.resolve(dataDirectoryInput);
  const outputRoot = path.resolve(outputRootInput);
  const isWithin = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === ''
      || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  assert.equal(isWithin(dataDirectory, outputRoot), false, 'output root 不得位于权威 data directory 内');
  assert.equal(isWithin(outputRoot, dataDirectory), false, '权威 data directory 不得位于 output root 内');
  const databaseFile = path.join(dataDirectory, 'eland.sqlite3');
  assert.equal(existsSync(databaseFile), true, `SQLite 不存在: ${databaseFile}`);
  return { dataDirectory, outputRoot, expectedMonth, databaseFile };
}

function evidenceLockPath(dataDirectory) {
  return path.join(dataDirectory, `.${runId}.era-boundary-ledger-v1.lock`);
}

function acquireEvidenceLease(dataDirectory) {
  const lockPath = evidenceLockPath(dataDirectory);
  const token = randomBytes(24).toString('hex');
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`runner/evidence lock 已存在，拒绝 horizon 取证: ${lockPath}`);
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      kind: 'bounded-horizon-evidence-v1',
      token,
    }));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dataDirectory);
  return Object.freeze({ path: lockPath, token, pid: process.pid });
}

function evidenceLeaseMatches(lease) {
  if (!existsSync(lease.path)) return false;
  try {
    const value = JSON.parse(readFileSync(lease.path, 'utf8'));
    return value.pid === lease.pid
      && value.kind === 'bounded-horizon-evidence-v1'
      && value.token === lease.token;
  } catch {
    return false;
  }
}

function assertEvidenceLease(lease) {
  assert.equal(evidenceLeaseMatches(lease), true, 'evidence lease 内容已被替换或删除');
}

function releaseEvidenceLease(lease) {
  if (!evidenceLeaseMatches(lease)) return false;
  unlinkSync(lease.path);
  fsyncDirectory(path.dirname(lease.path));
  return true;
}

function databaseFileSeal(databaseFile) {
  const stat = statSync(databaseFile);
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function openReadonlyDatabase(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA query_only = ON');
  assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), 3, 'SQLite schema version 必须是 3');
  return database;
}

function authoritySnapshot(database) {
  const row = database.prepare(`
    SELECT runs.id, runs.revision, runs.elapsed_months, runs.state_hash,
           runs.status, runs.living_agents, runs.agent_count, runs.event_count,
           runs.milestone_count, runs.updated_at,
           run_continuations.root_schema_version,
           run_continuations.revision AS continuation_revision,
           run_continuations.state_hash AS continuation_state_hash,
           run_continuations.shell_hash,
           run_continuations.history_lineage_id,
           run_continuations.history_head_hash,
           run_continuations.event_count AS continuation_event_count,
           run_continuations.tail_event_id,
           run_continuations.tail_event_content_hash,
           run_continuations.hot_event_limit,
           run_continuations.bundle_schema_version,
           run_continuations.bundle_hash,
           run_continuations.updated_at AS continuation_updated_at,
           run_checkpoints.created_at AS checkpoint_created_at
    FROM runs
    JOIN run_continuations ON run_continuations.run_id = runs.id
    JOIN run_checkpoints
      ON run_checkpoints.run_id = runs.id
     AND run_checkpoints.revision = runs.revision
     AND run_checkpoints.state_hash = runs.state_hash
    WHERE runs.id = ?
  `).get(runId);
  assert.ok(row, `找不到带 exact checkpoint/continuation 的 run ${runId}`);
  const latestCheckpoint = database.prepare(`
    SELECT revision, month, state_hash
    FROM run_checkpoints
    WHERE run_id = ?
    ORDER BY revision DESC
    LIMIT 1
  `).get(runId);
  assert.ok(latestCheckpoint, `run ${runId} 没有 checkpoint`);
  const snapshot = {
    runId: String(row.id),
    revision: Number(row.revision),
    month: Number(row.elapsed_months),
    stateHash: String(row.state_hash),
    status: String(row.status),
    livingAgents: Number(row.living_agents),
    agentCount: Number(row.agent_count),
    eventCount: Number(row.event_count),
    milestoneCount: Number(row.milestone_count),
    updatedAt: String(row.updated_at),
    rootSchemaVersion: Number(row.root_schema_version),
    shellHash: String(row.shell_hash),
    lineageId: String(row.history_lineage_id),
    historyHeadHash: row.history_head_hash == null ? null : String(row.history_head_hash),
    tailEventId: row.tail_event_id == null ? null : String(row.tail_event_id),
    tailEventContentHash: row.tail_event_content_hash == null
      ? null : String(row.tail_event_content_hash),
    hotEventLimit: Number(row.hot_event_limit),
    bundleSchemaVersion: Number(row.bundle_schema_version),
    bundleHash: String(row.bundle_hash),
    continuationUpdatedAt: String(row.continuation_updated_at),
    checkpointCreatedAt: String(row.checkpoint_created_at),
  };
  assert.equal(Number(row.continuation_revision), snapshot.revision, 'continuation revision 与 run 不一致');
  assert.equal(String(row.continuation_state_hash), snapshot.stateHash, 'continuation state hash 与 run 不一致');
  assert.equal(Number(row.continuation_event_count), snapshot.eventCount, 'continuation event count 与 run 不一致');
  assert.equal(Number(latestCheckpoint.revision), snapshot.revision, 'current run 不是最新 checkpoint revision');
  assert.equal(Number(latestCheckpoint.month), snapshot.month, 'current run 与最新 checkpoint month 不一致');
  assert.equal(String(latestCheckpoint.state_hash), snapshot.stateHash, 'current run 与最新 checkpoint state hash 不一致');
  assert.equal(HASH_PATTERN.test(snapshot.stateHash), true, 'state hash 无效');
  assert.equal(HASH_PATTERN.test(snapshot.shellHash), true, 'shell hash 无效');
  assert.equal(snapshot.historyHeadHash === null || HASH_PATTERN.test(snapshot.historyHeadHash), true, 'history head hash 无效');
  assert.equal(snapshot.tailEventContentHash === null || HASH_PATTERN.test(snapshot.tailEventContentHash), true, 'tail content hash 无效');
  assert.equal(HASH_PATTERN.test(snapshot.bundleHash), true, 'bundle hash 无效');
  return snapshot;
}

function readChunk(database, hash, label) {
  assert.equal(HASH_PATTERN.test(hash), true, `${label} hash 无效`);
  const row = database.prepare(
    'SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?',
  ).get(hash);
  assert.ok(row, `${label} ${hash} 不在 chunk ledger`);
  const data = Buffer.from(row.data);
  const chunk = {
    hash: String(row.hash),
    codec: String(row.codec),
    rawSize: Number(row.raw_size),
    data,
  };
  assert.equal(chunk.hash, hash, `${label} chunk hash 失配`);
  assert.equal(chunk.rawSize, data.byteLength, `${label} stored size 失配`);
  return chunk;
}

function engineEntrySource() {
  return [
    `export { parseRunStateRoot, parseRunStateShellManifest, streamVerifiedRunHistorySegments, streamVerifiedSchema3RunStateShell } from ${JSON.stringify(runStateCodecSourcePath)};`,
    `export { decodeRunContinuationBundle } from ${JSON.stringify(runContinuationBundleSourcePath)};`,
  ].join('\n');
}

function workspaceRelativeSource(absolutePath) {
  const relative = path.relative(workspaceRealPath, absolutePath);
  assert.equal(
    relative !== ''
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative),
    true,
    `verifier bundle 引用了 workspace 外源码: ${absolutePath}`,
  );
  return relative.split(path.sep).join('/');
}

function verifierBundleInputs(metafile, entryPath) {
  const inputs = recordOf(metafile)?.inputs;
  assert.ok(recordOf(inputs), 'esbuild metafile 缺少 inputs');
  const normalized = [];
  const canonicalEntryPath = realpathSync(entryPath);
  for (const [inputName, detailsValue] of Object.entries(inputs)) {
    const absolutePath = realpathSync(path.resolve(workspace, inputName));
    const details = recordOf(detailsValue);
    assert.ok(details, `esbuild input ${inputName} 元数据无效`);
    const bytes = safeInteger(details.bytes);
    assert.equal(bytes !== null && bytes >= 0, true, `esbuild input ${inputName} bytes 无效`);
    const generatedEntry = absolutePath === canonicalEntryPath;
    const source = generatedEntry
      ? 'generated:codec-entry.ts'
      : workspaceRelativeSource(absolutePath);
    normalized.push({
      source,
      bytes,
      sha256: generatedEntry
        ? sha256(Buffer.from(engineEntrySource(), 'utf8'))
        : sha256(readFileSync(absolutePath)),
    });
  }
  normalized.sort((left, right) => left.source.localeCompare(right.source));
  assert.equal(
    normalized.filter((input) => input.source === 'generated:codec-entry.ts').length,
    1,
    'esbuild input closure 必须且只能包含一个 generated codec entry',
  );
  return normalized;
}

function verifierSourceSeal() {
  return {
    extractorSourceSha256: sha256(readFileSync(extractorSourcePath)),
    codecEntrySourceSha256: sha256(Buffer.from(engineEntrySource(), 'utf8')),
    runStateCodecSourceSha256: sha256(readFileSync(runStateCodecSourcePath)),
    runContinuationBundleSourceSha256: sha256(readFileSync(runContinuationBundleSourcePath)),
  };
}

async function loadCodecApi(temporaryDirectory, sourceSeal) {
  const entryPath = path.join(temporaryDirectory, 'entry.ts');
  const bundlePath = path.join(temporaryDirectory, 'codec.mjs');
  const metafilePath = path.join(temporaryDirectory, 'codec-meta.json');
  const entrySource = engineEntrySource();
  assert.equal(
    sha256(Buffer.from(entrySource, 'utf8')),
    sourceSeal.codecEntrySourceSha256,
    'codec entry source 在封印后发生变化',
  );
  writeFileSync(entryPath, entrySource, { flag: 'wx', mode: 0o600 });
  const esbuild = process.env.ELAND_ESBUILD_BIN
    ? path.resolve(process.env.ELAND_ESBUILD_BIN)
    : path.join(workspace, 'node_modules/.bin/esbuild');
  assert.equal(existsSync(esbuild), true, `esbuild 不存在: ${esbuild}`);
  const esbuildVersion = execFileSync(esbuild, ['--version'], {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.ok(esbuildVersion.length > 0, 'esbuild version 为空');
  execFileSync(esbuild, [
    entryPath,
    ...ESBUILD_VERIFIER_ARGUMENTS,
    `--metafile=${metafilePath}`,
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: process.env, stdio: 'pipe' });
  const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  const provenance = Object.freeze({
    ...sourceSeal,
    esbuildVersion,
    esbuildArguments: ESBUILD_VERIFIER_ARGUMENTS,
    esbuildInputs: verifierBundleInputs(metafile, entryPath),
    esbuildBundleSha256: sha256(readFileSync(bundlePath)),
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  return { api, bundlePath, entryPath, provenance };
}

function assertVerifierProvenanceStable(verifier) {
  assert.deepEqual(
    verifierSourceSeal(),
    {
      extractorSourceSha256: verifier.provenance.extractorSourceSha256,
      codecEntrySourceSha256: verifier.provenance.codecEntrySourceSha256,
      runStateCodecSourceSha256: verifier.provenance.runStateCodecSourceSha256,
      runContinuationBundleSourceSha256: verifier.provenance.runContinuationBundleSourceSha256,
    },
    '取证期间 verifier source 发生变化',
  );
  assert.equal(
    sha256(readFileSync(verifier.entryPath)),
    verifier.provenance.codecEntrySourceSha256,
    '取证期间生成的 codec entry 发生变化',
  );
  assert.equal(
    sha256(readFileSync(verifier.bundlePath)),
    verifier.provenance.esbuildBundleSha256,
    '取证期间 esbuild verifier bundle 发生变化',
  );
  assert.deepEqual(
    verifier.provenance.esbuildArguments,
    ESBUILD_VERIFIER_ARGUMENTS,
    '取证期间 esbuild verifier arguments 发生变化',
  );
  for (const input of verifier.provenance.esbuildInputs) {
    const bytes = input.source === 'generated:codec-entry.ts'
      ? readFileSync(verifier.entryPath)
      : readFileSync(path.join(workspace, input.source));
    assert.equal(sha256(bytes), input.sha256, `取证期间 verifier input ${input.source} 发生变化`);
  }
}

function assertBundleMatchesAuthority(bundle, authority) {
  const expected = {
    runId: authority.runId,
    revision: authority.revision,
    stateHash: authority.stateHash,
    rootSchemaVersion: authority.rootSchemaVersion,
    shellHash: authority.shellHash,
    historyLineageId: authority.lineageId,
    historyHeadHash: authority.historyHeadHash,
    eventCount: authority.eventCount,
    tailEventId: authority.tailEventId,
    tailEventContentHash: authority.tailEventContentHash,
  };
  assert.deepEqual(bundle.authority, expected, 'continuation bundle authority 与 current run 不一致');
  assert.equal(bundle.hotEventLimit, authority.hotEventLimit, 'continuation hot limit 失配');
  assert.equal(bundle.hotStartIndex, Math.max(0, authority.eventCount - authority.hotEventLimit));
}

function readVerifiedLedger(dataDirectory, authority) {
  const ledgerPath = path.join(dataDirectory, `${runId}.era-boundary-ledger-v1.jsonl`);
  assert.equal(existsSync(ledgerPath), true, `缺少时代账本: ${ledgerPath}`);
  const raw = readFileSync(ledgerPath);
  assert.equal(raw.byteLength <= MAX_LEDGER_BYTES, true, `时代账本超过 ${MAX_LEDGER_BYTES} bytes`);
  const text = raw.toString('utf8');
  assert.equal(text.endsWith('\n'), true, '时代账本末行未完成耐久追加');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length >= 2 && lines.length <= MAX_LEDGER_LINES, true, '时代账本行数越界');
  const records = lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`时代账本第 ${index + 1} 行不是 JSON`, { cause: error });
    }
    assert.equal(record.seq, index, `时代账本 seq ${record.seq} 不连续`);
    return record;
  });
  let previousHash = null;
  for (const record of records) {
    assert.equal(record.prevHash, previousHash, `时代账本 seq ${record.seq} prevHash 失配`);
    assert.equal(HASH_PATTERN.test(record.hash), true, `时代账本 seq ${record.seq} hash 无效`);
    const { hash, ...unhashed } = record;
    assert.equal(hash, ledgerEntryHash(unhashed), `时代账本 seq ${record.seq} hash 验证失败`);
    previousHash = hash;
  }
  const header = records[0];
  assert.equal(header.type, 'header');
  assert.equal(header.schema, LEDGER_SCHEMA);
  assert.equal(header.runId, runId);
  assert.equal(header.lineageId, authority.lineageId, '账本 lineage 与 current run 不一致');
  assert.equal(header.coverageStartMonth, 0, 'horizon 矩阵账本必须从 genesis month 0 覆盖');
  assert.equal(header.coverageCompleteFromMonth0, true, 'horizon 矩阵账本必须声明 genesis 完整覆盖');
  assert.equal(HASH_PATTERN.test(header.engineBundleHash), true, '账本 engine bundle hash 无效');
  assert.equal(HASH_PATTERN.test(header.runnerHash), true, '账本 runner hash 无效');
  assert.equal(header.configHash, sha256(canonicalJson(header.config)), '账本 config hash 无效');
  assert.deepEqual(header.config?.authoritativeEndpoint, { kind: 'months', value: 12_000 });
  assert.equal(header.config?.stopMode, 'target-month', 'horizon 证据拒绝 stop-on-modern');
  for (const record of records.slice(1)) {
    assert.equal(record.authority?.lineageId, authority.lineageId, `时代账本 seq ${record.seq} lineage 失配`);
  }
  const matches = records.slice(1).filter((record) => (
    record.authority?.revision === authority.revision
    && record.authority?.month === authority.month
    && record.authority?.stateHash === authority.stateHash
    && record.authority?.shellHash === authority.shellHash
    && record.authority?.lineageId === authority.lineageId
    && record.authority?.historyHeadHash === authority.historyHeadHash
    && record.authority?.eventCount === authority.eventCount
    && record.authority?.tailEventId === authority.tailEventId
    && record.authority?.tailEventContentHash === authority.tailEventContentHash
    && record.authority?.bundleHash === authority.bundleHash
  ));
  assert.ok(matches.length > 0, '时代账本没有 exact current authority 记录');
  const exact = [...matches].reverse().find((record) => record.type === 'boundary') ?? matches.at(-1);
  return {
    path: ledgerPath,
    contentHash: sha256(raw),
    header,
    headHash: records.at(-1).hash,
    lineCount: records.length,
    matchingSeqs: matches.map((record) => record.seq),
    exact,
  };
}

function semanticWalk(value, visit) {
  const stack = [{ key: '', value }];
  const seen = new WeakSet();
  let visited = 0;
  while (stack.length > 0 && visited < MAX_WALK_NODES) {
    const current = stack.pop();
    visited += 1;
    visit(current.key, current.value);
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ key: current.key, value: current.value[index] });
      }
      continue;
    }
    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      stack.push({ key: entries[index][0], value: entries[index][1] });
    }
  }
}

function embeddedProjectIdsOf(event) {
  const projectIds = new Set();
  semanticWalk([event.action, event.diff], (key, value) => {
    const normalized = key.toLowerCase();
    if (normalized.endsWith('projectid') && typeof value === 'string') projectIds.add(value);
    if (normalized.endsWith('projectids') && Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') projectIds.add(item);
    }
  });
  return sortedStrings(projectIds);
}

function eventReferencesOf(event) {
  const references = new Set();
  semanticWalk([event.action, event.diff], (key, value) => {
    const normalized = key.toLowerCase();
    if ((normalized.endsWith('eventid') || normalized.endsWith('factid'))
      && typeof value === 'string') references.add(value);
    if ((normalized.endsWith('eventids') || normalized.endsWith('factids'))
      && Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') references.add(item);
    }
  });
  return [...references].slice(0, MAX_REFERENCED_EVENT_IDS);
}

function semanticTagsOf(event) {
  const tags = new Set();
  semanticWalk([event.action, event.diff], (key, value) => {
    const candidates = [key, typeof value === 'string' ? value : ''];
    for (const candidate of candidates) {
      const text = candidate.toLowerCase();
      if (text.includes('mechanical')) tags.add('mechanical');
      if (text.includes('electrical')) tags.add('electrical');
      if (text.includes('measurement') || text.includes('calibrat') || text.includes('mass')) tags.add('measurement');
      if (text.includes('record') || text.includes('codebook')) tags.add('record');
    }
  });
  const action = recordOf(event.action);
  if (action?.kind === 'communicate' && action.channel === 'record') tags.add('record');
  return tags;
}

function representativeEvent(event, ordinal, owningProjectIds, embeddedProjectIds) {
  const action = recordOf(event.action);
  return {
    eventId: event.id,
    ordinal,
    atMonth: event.atMonth,
    orderInMonth: event.orderInMonth,
    planningTick: safeInteger(event.planningTick) ?? 0,
    orderInTick: safeInteger(event.orderInTick) ?? 0,
    kind: event.kind,
    who: stringValue(event.who),
    status: stringValue(event.status),
    actionKind: stringValue(action?.kind),
    operation: action?.kind === 'act' ? stringValue(action.operation) : stringValue(action?.kind),
    intentId: stringValue(event.intentId),
    owningProjectIds,
    embeddedProjectIds,
    referencedEventIds: eventReferencesOf(event),
  };
}

function pushBounded(array, value) {
  array.push(value);
  if (array.length > MAX_REPRESENTATIVE_EVENTS) array.shift();
}

export function exactProjectActionEventIds(projectId, values) {
  assert.equal(Array.isArray(values), true, `project ${projectId} 缺少 actionEventIds`);
  const uniqueActionEventIds = new Set();
  for (const value of values) {
    const eventId = stringValue(value);
    assert.ok(eventId, `project ${projectId} actionEventIds 含无效 ID`);
    assert.equal(Buffer.byteLength(eventId, 'utf8') <= 4_096, true, 'action event id 超过 4096 bytes');
    assert.equal(
      uniqueActionEventIds.has(eventId),
      false,
      `project ${projectId} actionEventIds 含重复 ID: ${eventId}`,
    );
    uniqueActionEventIds.add(eventId);
  }
  return uniqueActionEventIds;
}

export function createHistoryReducer(
  witnessIds,
  owningProjectsByActionEventId,
  expectedProjectActionMembershipCount,
) {
  const eventKinds = new Map();
  const environmentChanges = new Map();
  const agreementChanges = new Map();
  const permissionChanges = new Map();
  const actionStatuses = new Map();
  const actionOperations = new Map();
  const actionStatusOperations = new Map();
  const owningProjectCounts = new Map();
  const embeddedProjectReferenceCounts = new Map();
  const birthEvents = [];
  const deathEvents = [];
  const representatives = {
    mechanical: [],
    electrical: [],
    measurement: [],
    record: [],
  };
  const witnessed = new Map();
  const resolvedProjectActionEventIds = new Set();
  let firstEventId = null;
  let lastEventId = null;
  let actionWithIntent = 0;
  let actionWithoutIntent = 0;
  let actionWithOwningProject = 0;
  let actionWithoutOwningProject = 0;
  let owningProjectRelationshipCount = 0;
  let actionWithEmbeddedProjectReference = 0;
  let actionWithoutEmbeddedProjectReference = 0;
  let embeddedProjectReferenceRelationshipCount = 0;
  let modelDecisionCount = 0;

  function visit(events, position) {
    for (let offset = 0; offset < events.length; offset += 1) {
      const event = events[offset];
      const ordinal = position.startEventIndex + offset;
      if (firstEventId === null) firstEventId = event.id;
      lastEventId = event.id;
      increment(eventKinds, event.kind);
      if (witnessIds.has(event.id)) witnessed.set(event.id, ordinal);
      const owningProjectIds = owningProjectsByActionEventId.get(event.id) ?? [];
      if (owningProjectIds.length > 0) {
        assert.equal(
          resolvedProjectActionEventIds.has(event.id),
          false,
          `project.actionEventIds 引用的 event id 在权威历史重复: ${event.id}`,
        );
        assert.equal(
          event.kind,
          'action',
          `project.actionEventIds 引用的 ${event.id} 不是 action fact`,
        );
        resolvedProjectActionEventIds.add(event.id);
        owningProjectRelationshipCount += owningProjectIds.length;
      }
      if (event.kind === 'environment') {
        increment(environmentChanges, event.change);
        if (typeof event.diff?.bornPersonId === 'string') {
          assert.equal(birthEvents.length < MAX_LIFE_EVENTS, true, 'birth events 超过硬上限');
          birthEvents.push({
            eventId: event.id,
            ordinal,
            atMonth: event.atMonth,
            childId: event.diff.bornPersonId,
            motherId: stringValue(event.who),
            fatherId: stringValue(event.diff.fatherId),
          });
        }
        if (event.change === 'death') {
          assert.equal(deathEvents.length < MAX_LIFE_EVENTS, true, 'death events 超过硬上限');
          deathEvents.push({
            eventId: event.id,
            ordinal,
            atMonth: event.atMonth,
            personId: stringValue(event.diff?.personId) ?? stringValue(event.who),
            cause: stringValue(event.diff?.cause) ?? 'unknown',
            ageMonths: safeInteger(event.diff?.ageMonths),
          });
        }
        continue;
      }
      if (event.kind === 'agreement') {
        increment(agreementChanges, event.change);
        continue;
      }
      if (event.kind === 'permission') {
        increment(permissionChanges, event.change);
        continue;
      }
      if (event.kind === 'decision') {
        if (event.usedModel === true) modelDecisionCount += 1;
        continue;
      }
      if (event.kind !== 'action') continue;
      const action = recordOf(event.action);
      const operation = action?.kind === 'act'
        ? stringValue(action.operation) ?? 'act:unknown'
        : stringValue(action?.kind) ?? 'unknown';
      const status = stringValue(event.status) ?? 'unknown';
      increment(actionStatuses, status);
      increment(actionOperations, operation);
      increment(actionStatusOperations, `${status}\0${operation}`);
      if (typeof event.intentId === 'string') actionWithIntent += 1;
      else actionWithoutIntent += 1;
      if (owningProjectIds.length > 0) {
        actionWithOwningProject += 1;
        for (const projectId of owningProjectIds) increment(owningProjectCounts, projectId);
      } else actionWithoutOwningProject += 1;
      const embeddedProjectIds = embeddedProjectIdsOf(event);
      if (embeddedProjectIds.length > 0) {
        actionWithEmbeddedProjectReference += 1;
        embeddedProjectReferenceRelationshipCount += embeddedProjectIds.length;
        for (const projectId of embeddedProjectIds) {
          increment(embeddedProjectReferenceCounts, projectId);
          assert.equal(
            embeddedProjectReferenceCounts.size <= MAX_EMBEDDED_PROJECT_REFERENCE_KEYS,
            true,
            'embedded project reference keys 超过硬上限',
          );
        }
      } else actionWithoutEmbeddedProjectReference += 1;
      const tags = semanticTagsOf(event);
      for (const tag of tags) {
        pushBounded(
          representatives[tag],
          representativeEvent(event, ordinal, owningProjectIds, embeddedProjectIds),
        );
      }
    }
  }

  function finish(cursor) {
    const unresolvedProjectActionEventIds = [...owningProjectsByActionEventId.keys()]
      .filter((eventId) => !resolvedProjectActionEventIds.has(eventId))
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(
      unresolvedProjectActionEventIds,
      [],
      '存在未在完整权威历史中解析的 project.actionEventIds',
    );
    assert.equal(
      owningProjectRelationshipCount,
      expectedProjectActionMembershipCount,
      '权威 project/action relationship 数与 exact shell membership 不一致',
    );
    const byStatusAndOperation = {};
    for (const [compound, count] of [...actionStatusOperations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) {
      const [status, operation] = compound.split('\0');
      byStatusAndOperation[status] ??= {};
      byStatusAndOperation[status][operation] = count;
    }
    const deathCauses = new Map();
    for (const death of deathEvents) increment(deathCauses, death.cause);
    return {
      cursor,
      firstEventId,
      lastEventId,
      eventCountsByKind: sortedCountObject(eventKinds),
      environmentCountsByChange: sortedCountObject(environmentChanges),
      agreementCountsByChange: sortedCountObject(agreementChanges),
      permissionCountsByChange: sortedCountObject(permissionChanges),
      modelDecisionCount,
      actions: {
        byStatus: sortedCountObject(actionStatuses),
        byOperation: sortedCountObject(actionOperations),
        byStatusAndOperation,
        attribution: {
          intent: {
            withIntentId: actionWithIntent,
            withoutIntentId: actionWithoutIntent,
          },
          owningProjects: {
            source: 'exact-shell-project.actionEventIds-joined-to-full-authoritative-history',
            withOwningProject: actionWithOwningProject,
            withoutOwningProject: actionWithoutOwningProject,
            relationshipCount: owningProjectRelationshipCount,
            uniqueActionEventIdCount: resolvedProjectActionEventIds.size,
            unresolvedEventIdCount: unresolvedProjectActionEventIds.length,
            byOwningProjectId: sortedCountObject(owningProjectCounts),
          },
          embeddedProjectReferences: {
            source: 'bounded-semantic-scan-of-action-payload-not-authoritative-membership',
            withEmbeddedProjectReference: actionWithEmbeddedProjectReference,
            withoutEmbeddedProjectReference: actionWithoutEmbeddedProjectReference,
            relationshipCount: embeddedProjectReferenceRelationshipCount,
            byReferencedProjectId: sortedCountObject(embeddedProjectReferenceCounts),
          },
        },
      },
      births: {
        count: birthEvents.length,
        events: birthEvents,
      },
      deaths: {
        count: deathEvents.length,
        byCause: sortedCountObject(deathCauses),
        events: deathEvents,
      },
      representativeChains: representatives,
      witnessOrdinals: Object.fromEntries([...witnessed.entries()]
        .sort(([left], [right]) => left.localeCompare(right))),
    };
  }
  return { visit, finish };
}

function createShellReducer() {
  const people = {
    total: 0,
    living: 0,
    dead: 0,
    bySex: new Map(),
    byGeneration: new Map(),
    activeConditions: new Map(),
    inventoryStacks: 0,
    inventoryUnits: 0,
    knowledgeFacts: 0,
    relations: 0,
    memories: 0,
    earliestBirthMonth: null,
    latestBirthMonth: null,
    earliestDeathMonth: null,
    latestDeathMonth: null,
  };
  const projectCounts = {
    byStatus: new Map(),
    byKind: new Map(),
    byNeed: new Map(),
    byFunction: new Map(),
  };
  const projectLifecycles = [];
  const seenProjectIds = new Set();
  const owningProjectsByActionEventId = new Map();
  const intentStatuses = new Map();
  const agreementStatuses = new Map();
  const agreementKinds = new Map();
  const recordKinds = new Map();
  const recordVersions = new Map();
  const collectiveStatuses = new Map();
  const permissionStatuses = new Map();
  const containerMaterials = new Map();
  const arrayLengths = {};
  let seed = null;
  let branchId = null;
  let clock = null;
  let civilization = null;
  let derived = null;
  let historyCursor = null;
  let mechanicalPower = null;
  let electricalPower = null;
  let physicalStructureIndex = null;
  let totalCollectiveMemberships = 0;
  let totalDecisionRules = 0;
  let totalMandates = 0;
  let recordCount = 0;
  let agreementCount = 0;
  let intentCount = 0;
  let permissionCount = 0;
  let containerCount = 0;
  let projectActionMembershipCount = 0;
  let rawProjectActionReferenceCount = 0;
  let duplicateWithinProjectActionReferenceCount = 0;

  function visitField(position) {
    if (position.kind === 'array') arrayLengths[`${position.scope}.${position.fieldName}`] = position.fieldLength;
  }

  function visitValue(value, position) {
    if (position.scope === 'state') {
      if (position.fieldName === 'seed') seed = value;
      else if (position.fieldName === 'branchId') branchId = value;
      else if (position.fieldName === 'clock') clock = value;
      else if (position.fieldName === 'civilization') civilization = value;
      else if (position.fieldName === 'derived') derived = value;
      return;
    }
    if (position.fieldName === 'historyCursor') historyCursor = value;
    else if (position.fieldName === 'mechanicalPower') mechanicalPower = value;
    else if (position.fieldName === 'electricalPower') electricalPower = value;
    else if (position.fieldName === 'physicalStructureIndex') physicalStructureIndex = value;
  }

  function summarizePerson(value) {
    const person = recordOf(value);
    assert.ok(person, 'people shell item 必须是对象');
    people.total += 1;
    const body = recordOf(person.body);
    const alive = person.diedAtMonth === undefined && finiteNumber(body?.health) > 0;
    if (alive) people.living += 1;
    else people.dead += 1;
    increment(people.bySex, stringValue(person.sex) ?? 'unknown');
    increment(people.byGeneration, safeInteger(person.generation) ?? 'unknown');
    for (const condition of Array.isArray(person.conditions) ? person.conditions : []) {
      increment(people.activeConditions, stringValue(recordOf(condition)?.kind) ?? 'unknown');
    }
    const inventory = Array.isArray(person.inventory) ? person.inventory : [];
    people.inventoryStacks += inventory.length;
    for (const stack of inventory) people.inventoryUnits += finiteNumber(recordOf(stack)?.quantity) ?? 0;
    people.knowledgeFacts += Array.isArray(person.knowledge) ? person.knowledge.length : 0;
    people.relations += Array.isArray(person.relations) ? person.relations.length : 0;
    people.memories += Array.isArray(person.memories) ? person.memories.length : 0;
    const born = safeInteger(person.bornAtMonth);
    if (born !== null) {
      people.earliestBirthMonth = people.earliestBirthMonth === null ? born : Math.min(people.earliestBirthMonth, born);
      people.latestBirthMonth = people.latestBirthMonth === null ? born : Math.max(people.latestBirthMonth, born);
    }
    const died = safeInteger(person.diedAtMonth);
    if (died !== null) {
      people.earliestDeathMonth = people.earliestDeathMonth === null ? died : Math.min(people.earliestDeathMonth, died);
      people.latestDeathMonth = people.latestDeathMonth === null ? died : Math.max(people.latestDeathMonth, died);
    }
  }

  function summarizeProject(value) {
    const project = recordOf(value);
    assert.ok(project, 'projects shell item 必须是对象');
    assert.equal(projectLifecycles.length < MAX_PROJECT_LIFECYCLES, true, 'project lifecycles 超过硬上限');
    const projectId = stringValue(project.id);
    assert.ok(projectId, 'project.id 必须是非空字符串');
    assert.equal(Buffer.byteLength(projectId, 'utf8') <= 4_096, true, 'project.id 超过 4096 bytes');
    assert.equal(seenProjectIds.has(projectId), false, `exact shell project id 重复: ${projectId}`);
    seenProjectIds.add(projectId);
    const uniqueActionEventIds = exactProjectActionEventIds(projectId, project.actionEventIds);
    rawProjectActionReferenceCount += project.actionEventIds.length;
    duplicateWithinProjectActionReferenceCount += project.actionEventIds.length - uniqueActionEventIds.size;
    for (const eventId of uniqueActionEventIds) {
      const owners = owningProjectsByActionEventId.get(eventId) ?? new Set();
      owners.add(projectId);
      owningProjectsByActionEventId.set(eventId, owners);
      projectActionMembershipCount += 1;
      assert.equal(
        projectActionMembershipCount <= MAX_PROJECT_ACTION_MEMBERSHIPS,
        true,
        `project/action memberships 超过硬上限 ${MAX_PROJECT_ACTION_MEMBERSHIPS}`,
      );
    }
    const status = stringValue(project.status) ?? 'unknown';
    const kind = stringValue(project.kind) ?? 'unknown';
    const need = stringValue(project.need) ?? 'unknown';
    const desiredFunction = stringValue(project.desiredFunction) ?? 'unknown';
    increment(projectCounts.byStatus, status);
    increment(projectCounts.byKind, kind);
    increment(projectCounts.byNeed, need);
    increment(projectCounts.byFunction, desiredFunction);
    projectLifecycles.push({
      projectId,
      ownerId: stringValue(project.ownerId),
      status,
      kind,
      need,
      desiredFunction,
      createdAtMonth: safeInteger(project.createdAtMonth),
      lastProgressAtMonth: safeInteger(project.lastProgressAtMonth),
      completedAtMonth: safeInteger(project.completedAtMonth),
      blockedAtMonth: safeInteger(project.blockedAtMonth),
      abandonedAtMonth: safeInteger(project.abandonedAtMonth),
      contributorCount: Array.isArray(project.contributorIds) ? project.contributorIds.length : 0,
      actionEventCount: project.actionEventIds.length,
      uniqueActionEventCount: uniqueActionEventIds.size,
      failureEventCount: Array.isArray(project.failureEventIds) ? project.failureEventIds.length : 0,
      completionEventCount: Array.isArray(project.completionEventIds) ? project.completionEventIds.length : 0,
    });
  }

  function visitArraySegment(items, position) {
    if (position.scope !== 'state') return;
    if (position.fieldName === 'people') {
      for (const item of items) summarizePerson(item);
    } else if (position.fieldName === 'projects') {
      for (const item of items) summarizeProject(item);
    } else if (position.fieldName === 'intents') {
      intentCount += items.length;
      for (const item of items) increment(intentStatuses, stringValue(recordOf(item)?.status) ?? 'unknown');
    } else if (position.fieldName === 'agreements') {
      agreementCount += items.length;
      for (const item of items) {
        const agreement = recordOf(item);
        increment(agreementStatuses, stringValue(agreement?.status) ?? 'unknown');
        increment(agreementKinds, stringValue(recordOf(agreement?.proposal)?.kind) ?? 'unknown');
      }
    } else if (position.fieldName === 'records') {
      recordCount += items.length;
      for (const item of items) {
        const record = recordOf(item);
        increment(recordKinds, stringValue(record?.kind) ?? 'unknown');
        increment(recordVersions, safeInteger(record?.version) ?? 'unknown');
      }
    } else if (position.fieldName === 'collectives') {
      for (const item of items) {
        const collective = recordOf(item);
        increment(collectiveStatuses, stringValue(collective?.status) ?? 'unknown');
        totalCollectiveMemberships += Array.isArray(collective?.memberships) ? collective.memberships.length : 0;
        totalDecisionRules += Array.isArray(collective?.decisionRules) ? collective.decisionRules.length : 0;
        totalMandates += Array.isArray(collective?.mandates) ? collective.mandates.length : 0;
      }
    } else if (position.fieldName === 'permissions') {
      permissionCount += items.length;
      for (const item of items) increment(permissionStatuses, stringValue(recordOf(item)?.status) ?? 'unknown');
    } else if (position.fieldName === 'containers') {
      containerCount += items.length;
      for (const item of items) {
        const container = recordOf(item);
        for (const stack of Array.isArray(container?.inventory) ? container.inventory : []) {
          increment(containerMaterials, safeInteger(recordOf(stack)?.materialId) ?? 'unknown', finiteNumber(recordOf(stack)?.quantity) ?? 0);
        }
      }
    }
  }

  function summarizePower(value, kind) {
    const world = recordOf(value);
    const networks = Array.isArray(world?.networks) ? world.networks : [];
    const sources = Array.isArray(world?.sources) ? world.sources : [];
    let components = 0;
    let operations = 0;
    let faults = 0;
    let repairs = 0;
    let activeFaults = 0;
    const networkSummaries = [];
    for (const rawNetwork of networks) {
      const network = recordOf(rawNetwork);
      components += Array.isArray(network?.components) ? network.components.length : 0;
      operations += safeInteger(network?.operationCount) ?? 0;
      faults += safeInteger(network?.faultCount) ?? 0;
      repairs += safeInteger(network?.repairCount) ?? 0;
      if (network?.fault) activeFaults += 1;
      networkSummaries.push({
        id: stringValue(network?.id),
        installationProjectId: stringValue(network?.installationProjectId),
        componentCount: Array.isArray(network?.components) ? network.components.length : 0,
        operationCount: safeInteger(network?.operationCount) ?? 0,
        faultCount: safeInteger(network?.faultCount) ?? 0,
        repairCount: safeInteger(network?.repairCount) ?? 0,
        hasActiveFault: Boolean(network?.fault),
      });
    }
    networkSummaries.sort((left, right) => (left.id ?? '').localeCompare(right.id ?? ''));
    return {
      kind,
      version: stringValue(world?.version),
      sourceCount: sources.length,
      networkCount: networks.length,
      componentCount: components,
      operationCount: operations,
      faultCount: faults,
      repairCount: repairs,
      activeFaultCount: activeFaults,
      networks: networkSummaries,
    };
  }

  function finish(receipt) {
    const civilizationRecord = recordOf(civilization) ?? {};
    const development = recordOf(civilizationRecord.development);
    const index = recordOf(civilizationRecord.civilizationIndex);
    const conditions = recordOf(civilizationRecord.conditions);
    const derivedRecord = recordOf(derived) ?? {};
    const functionalBuildings = Array.isArray(derivedRecord.functionalBuildings)
      ? derivedRecord.functionalBuildings : [];
    const buildingKinds = new Map();
    for (const building of functionalBuildings) {
      increment(buildingKinds, stringValue(recordOf(building)?.kind) ?? 'unknown');
    }
    const observerInstitutions = Array.isArray(derivedRecord.institutions)
      ? derivedRecord.institutions : [];
    const structures = Array.isArray(recordOf(physicalStructureIndex)?.structures)
      ? recordOf(physicalStructureIndex).structures : [];
    const completeStructures = structures.filter((structure) => recordOf(structure)?.complete === true).length;
    projectLifecycles.sort((left, right) => (
      (left.createdAtMonth ?? -1) - (right.createdAtMonth ?? -1)
      || left.projectId.localeCompare(right.projectId)
    ));
    const canonicalOwnership = new Map([...owningProjectsByActionEventId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([eventId, ownerIds]) => [
        eventId,
        [...ownerIds].sort((left, right) => left.localeCompare(right)),
      ]));
    const evidence = {
      receipt,
      arrayLengths: Object.fromEntries(Object.entries(arrayLengths).sort(([left], [right]) => left.localeCompare(right))),
      seed,
      branchId,
      clock,
      historyCursor,
      people: {
        ...people,
        bySex: sortedCountObject(people.bySex),
        byGeneration: sortedCountObject(people.byGeneration),
        activeConditions: sortedCountObject(people.activeConditions),
      },
      projects: {
        count: projectLifecycles.length,
        rawActionEventReferenceCount: rawProjectActionReferenceCount,
        duplicateWithinProjectActionReferenceCount,
        actionEventMembershipCount: projectActionMembershipCount,
        uniqueActionEventIdCount: canonicalOwnership.size,
        byStatus: sortedCountObject(projectCounts.byStatus),
        byKind: sortedCountObject(projectCounts.byKind),
        byNeed: sortedCountObject(projectCounts.byNeed),
        byFunction: sortedCountObject(projectCounts.byFunction),
        lifecycles: projectLifecycles,
      },
      intents: { count: intentCount, byStatus: sortedCountObject(intentStatuses) },
      agreements: {
        count: agreementCount,
        byStatus: sortedCountObject(agreementStatuses),
        byProposalKind: sortedCountObject(agreementKinds),
      },
      records: {
        count: recordCount,
        byKind: sortedCountObject(recordKinds),
        byVersion: sortedCountObject(recordVersions),
      },
      institutions: {
        collectiveCount: arrayLengths['state.collectives'] ?? 0,
        collectivesByStatus: sortedCountObject(collectiveStatuses),
        membershipCount: totalCollectiveMemberships,
        decisionRuleCount: totalDecisionRules,
        mandateCount: totalMandates,
        observerInstitutionCount: observerInstitutions.length,
      },
      permissions: { count: permissionCount, byStatus: sortedCountObject(permissionStatuses) },
      containers: {
        count: containerCount,
        inventoryUnitsByMaterialId: sortedCountObject(containerMaterials),
      },
      facilities: {
        functionalBuildingCount: functionalBuildings.length,
        byKind: sortedCountObject(buildingKinds),
        physicalStructureCount: structures.length,
        completePhysicalStructureCount: completeStructures,
      },
      mechanicalPower: summarizePower(mechanicalPower, 'mechanical'),
      electricalPower: summarizePower(electricalPower, 'electrical'),
      civilization: {
        number: safeInteger(civilizationRecord.number),
        status: stringValue(civilizationRecord.status),
        stage: stringValue(civilizationRecord.stage),
        epoch: stringValue(civilizationRecord.epoch),
        outcome: civilizationRecord.outcome ?? null,
        endpoint: recordOf(conditions?.endpoint),
        development: development ? {
          observerVersion: stringValue(development.observerVersion),
          currentEra: stringValue(development.currentEra),
          historicalPeakEra: stringValue(development.historicalPeakEra),
          candidateEra: stringValue(development.candidateEra),
          candidateSinceMonth: safeInteger(development.candidateSinceMonth),
          transitionProgress: finiteNumber(development.transitionProgress),
          satisfiedGateIds: sortedStrings(stringArray(development.satisfiedGateIds)),
          missingGateIds: sortedStrings(stringArray(development.missingGateIds)),
          supportingEventIds: sortedStrings(stringArray(development.supportingEventIds)),
        } : null,
        civilizationIndex: index ? {
          semantics: 'observer-only-never-planner-input',
          formulaVersion: stringValue(index.formulaVersion),
          calculatedAtMonth: safeInteger(index.calculatedAtMonth),
          total: finiteNumber(index.total),
        } : null,
      },
    };
    return {
      evidence,
      owningProjectsByActionEventId: canonicalOwnership,
      projectActionMembershipCount,
    };
  }
  return { visitField, visitValue, visitArraySegment, finish };
}

function ledgerEvidence(ledger) {
  const exact = ledger.exact;
  return {
    schema: ledger.header.schema,
    contentHash: ledger.contentHash,
    lineCount: ledger.lineCount,
    headHash: ledger.headHash,
    matchingSeqs: ledger.matchingSeqs,
    selectedSeq: exact.seq,
    boundaryKind: exact.boundaryKind ?? exact.type,
    source: {
      seed: ledger.header.seed,
      engineBundleHash: ledger.header.engineBundleHash,
      runnerHash: ledger.header.runnerHash,
      configHash: ledger.header.configHash,
      config: ledger.header.config,
      pathSemantics: ledger.header.pathSemantics ?? null,
    },
    observer: exact.observer ?? null,
    modern: exact.modern ?? null,
    status: exact.status ?? null,
    outcome: exact.outcome ?? null,
    performance: {
      elapsedMs: finiteNumber(exact.elapsedMs) ?? finiteNumber(exact.performance?.elapsedMs),
      maxRssBytes: finiteNumber(exact.maxRssBytes) ?? finiteNumber(exact.performance?.maxRssBytes),
      rssBytes: finiteNumber(exact.rss) ?? finiteNumber(exact.performance?.rssBytes),
      provenance: 'ledger-only-null-when-not-recorded',
    },
  };
}

function witnessIdsFromLedger(ledger) {
  const modern = recordOf(ledger.exact.modern);
  return new Set([
    ...stringArray(modern?.supportingEventIds),
    ...(Array.isArray(modern?.witnessOrdinals)
      ? modern.witnessOrdinals.map((item) => stringValue(recordOf(item)?.eventId)).filter(Boolean)
      : []),
  ]);
}

function verifyWitnessOrdinals(ledger, history) {
  const modern = recordOf(ledger.exact.modern);
  for (const item of Array.isArray(modern?.witnessOrdinals) ? modern.witnessOrdinals : []) {
    const witness = recordOf(item);
    const eventId = stringValue(witness?.eventId);
    assert.ok(eventId, 'modern witness 缺少 eventId');
    assert.equal(history.witnessOrdinals[eventId], witness.ordinal, `modern witness ${eventId} ordinal 失配`);
  }
  for (const eventId of stringArray(modern?.supportingEventIds)) {
    assert.equal(Number.isSafeInteger(history.witnessOrdinals[eventId]), true, `modern supporting event ${eventId} 不在权威历史`);
  }
}

function stageChunkFactory(stagingDirectory) {
  const chunks = new Map();
  return {
    stage(chunk, role) {
      const storedBytesHash = sha256(chunk.data);
      const existing = chunks.get(chunk.hash);
      if (existing) {
        assert.equal(existing.codec, chunk.codec, `chunk ${chunk.hash} codec 冲突`);
        assert.equal(existing.rawSize, chunk.rawSize, `chunk ${chunk.hash} size 冲突`);
        assert.equal(existing.storedBytesHash, storedBytesHash, `chunk ${chunk.hash} bytes 冲突`);
        existing.roles.add(role);
        return;
      }
      const stagedPath = path.join(stagingDirectory, chunk.hash);
      writeFileSync(stagedPath, chunk.data, { flag: 'wx', mode: 0o600 });
      chunks.set(chunk.hash, {
        hash: chunk.hash,
        codec: chunk.codec,
        rawSize: chunk.rawSize,
        storedBytesHash,
        stagedPath,
        roles: new Set([role]),
      });
    },
    receipts() {
      return [...chunks.values()].map((chunk) => ({
        hash: chunk.hash,
        codec: chunk.codec,
        rawSize: chunk.rawSize,
        storedBytesSha256: chunk.storedBytesHash,
        roles: [...chunk.roles].sort(),
      })).sort((left, right) => left.hash.localeCompare(right.hash));
    },
    install(outputRoot) {
      const chunkDirectory = path.join(outputRoot, 'chunks');
      mkdirSync(chunkDirectory, { recursive: true });
      for (const chunk of [...chunks.values()].sort((left, right) => left.hash.localeCompare(right.hash))) {
        const destination = path.join(chunkDirectory, chunk.hash);
        if (existsSync(destination)) {
          assert.equal(sha256(readFileSync(destination)), chunk.storedBytesHash, `共享 evidence chunk ${chunk.hash} 内容冲突`);
          continue;
        }
        const temporaryPath = path.join(chunkDirectory, `.${chunk.hash}.${process.pid}.tmp`);
        copyFileSync(chunk.stagedPath, temporaryPath);
        const descriptor = openSync(temporaryPath, 'r');
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        renameSync(temporaryPath, destination);
        fsyncDirectory(chunkDirectory);
      }
    },
  };
}

function exactAuthorityForPack(authority) {
  return {
    runId: authority.runId,
    revision: authority.revision,
    month: authority.month,
    stateHash: authority.stateHash,
    shellHash: authority.shellHash,
    rootSchemaVersion: authority.rootSchemaVersion,
    lineageId: authority.lineageId,
    historyHeadHash: authority.historyHeadHash,
    eventCount: authority.eventCount,
    tailEventId: authority.tailEventId,
    tailEventContentHash: authority.tailEventContentHash,
    bundleSchemaVersion: authority.bundleSchemaVersion,
    bundleHash: authority.bundleHash,
    hotEventLimit: authority.hotEventLimit,
    status: authority.status,
    livingAgents: authority.livingAgents,
    agentCount: authority.agentCount,
    milestoneCount: authority.milestoneCount,
  };
}

async function run() {
  const { dataDirectory, outputRoot, expectedMonth, databaseFile } = validateArguments();
  const evidenceLease = acquireEvidenceLease(dataDirectory);
  let temporaryDirectory = null;
  let stagingDirectory = null;
  let result = null;
  try {
    assertEvidenceLease(evidenceLease);
    const sourceSeal = verifierSourceSeal();
    const databaseSealBefore = databaseFileSeal(databaseFile);
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-horizon-evidence-'));
    mkdirSync(outputRoot, { recursive: true });
    stagingDirectory = mkdtempSync(path.join(outputRoot, '.staging-'));
    const verifier = await loadCodecApi(temporaryDirectory, sourceSeal);
    const { api } = verifier;
    const stager = stageChunkFactory(stagingDirectory);
    const database = openReadonlyDatabase(databaseFile);
    let authority;
    let root;
    let bundle;
    let ledger;
    let history;
    let shell;
    let manifest;
    try {
      authority = authoritySnapshot(database);
      assert.equal(authority.month, expectedMonth, `run 当前 month=${authority.month}，不是 expected month=${expectedMonth}`);
      assert.equal(authority.rootSchemaVersion, 3, 'horizon evidence v1 只接受 schema3 exact root');
      const rootChunk = readChunk(database, authority.stateHash, 'current root');
      stager.stage(rootChunk, 'current-root');
      root = api.parseRunStateRoot(rootChunk);
      assert.deepEqual(root, {
        schemaVersion: authority.rootSchemaVersion,
        shellHash: authority.shellHash,
        historyHeadHash: authority.historyHeadHash,
        lineageId: authority.lineageId,
        eventCount: authority.eventCount,
        tailEventContentHash: authority.tailEventContentHash,
      }, 'root metadata 与 current authority 不一致');
      const bundleChunk = readChunk(database, authority.bundleHash, 'continuation bundle');
      stager.stage(bundleChunk, 'continuation-bundle');
      bundle = api.decodeRunContinuationBundle(bundleChunk);
      assertBundleMatchesAuthority(bundle, authority);
      ledger = readVerifiedLedger(dataDirectory, authority);

      const manifestChunk = readChunk(database, authority.shellHash, 'shell manifest');
      stager.stage(manifestChunk, 'shell-manifest');
      manifest = api.parseRunStateShellManifest(manifestChunk);
      const shellReducer = createShellReducer();
      const receipt = await api.streamVerifiedSchema3RunStateShell(
        rootChunk,
        (hash) => {
          const chunk = readChunk(database, hash, hash === authority.shellHash ? 'shell manifest' : 'shell part');
          stager.stage(chunk, hash === authority.shellHash ? 'shell-manifest' : 'shell-part');
          return chunk;
        },
        {
          visitField: shellReducer.visitField,
          visitValue: shellReducer.visitValue,
          visitArraySegment: shellReducer.visitArraySegment,
        },
      );
      const shellResult = shellReducer.finish(receipt);
      shell = shellResult.evidence;
      assert.equal(shell.seed, ledger.header.seed, 'shell seed 与时代账本不一致');
      assert.equal(shell.clock?.elapsedMonths, authority.month, 'shell clock 与 authority month 不一致');
      if (shell.historyCursor !== null) {
        assert.equal(shell.historyCursor?.eventCount, authority.eventCount, 'shell historyCursor eventCount 失配');
        assert.equal(shell.historyCursor?.tailEventId, authority.tailEventId, 'shell historyCursor tailEventId 失配');
      }
      assert.equal(shell.people.total, authority.agentCount, 'shell people total 与 run summary 不一致');
      assert.equal(shell.people.living, authority.livingAgents, 'shell living people 与 run summary 不一致');

      const witnessIds = witnessIdsFromLedger(ledger);
      const historyReducer = createHistoryReducer(
        witnessIds,
        shellResult.owningProjectsByActionEventId,
        shellResult.projectActionMembershipCount,
      );
      const cursor = await api.streamVerifiedRunHistorySegments(
        root,
        (hash) => readChunk(database, hash, 'history stream'),
        historyReducer.visit,
      );
      history = historyReducer.finish(cursor);
      assert.equal(history.firstEventId === null, authority.eventCount === 0, 'history first event 边界无效');
      assert.equal(history.lastEventId, authority.tailEventId, 'history tail event id 与 continuation 不一致');
      assert.deepEqual(cursor, {
        lineageId: authority.lineageId,
        historyHeadHash: authority.historyHeadHash,
        eventCount: authority.eventCount,
        tailEventContentHash: authority.tailEventContentHash,
      }, 'verified history cursor 与 authority 不一致');
      verifyWitnessOrdinals(ledger, history);
    } finally {
      database.close();
    }

    assertEvidenceLease(evidenceLease);
    const ledgerHashAfter = sha256(readFileSync(ledger.path));
    assert.equal(ledgerHashAfter, ledger.contentHash, '流式读取期间时代账本发生变化');
    const verificationDatabase = openReadonlyDatabase(databaseFile);
    let authorityAfter;
    try {
      authorityAfter = authoritySnapshot(verificationDatabase);
      const rootAfter = api.parseRunStateRoot(readChunk(
        verificationDatabase,
        authority.stateHash,
        'final current root',
      ));
      assert.deepEqual(rootAfter, root, '流式读取期间 current root bytes 发生变化');
      const bundleAfter = api.decodeRunContinuationBundle(readChunk(
        verificationDatabase,
        authority.bundleHash,
        'final continuation bundle',
      ));
      assert.deepEqual(bundleAfter, bundle, '流式读取期间 continuation bundle bytes 发生变化');
    } finally {
      verificationDatabase.close();
    }
    assert.deepEqual(authorityAfter, authority, '流式读取期间 current run authority 发生变化');
    assert.deepEqual(databaseFileSeal(databaseFile), databaseSealBefore, '流式读取期间 SQLite 文件发生变化');
    assertEvidenceLease(evidenceLease);

    const shellReferences = [
      ...manifest.fields.map((field) => ({ scope: 'state', ...field })),
      ...manifest.worldFields.map((field) => ({ scope: 'world', ...field })),
    ];
    const content = {
      schema: EVIDENCE_SCHEMA,
      semantics: {
        authority: 'read-only-exact-current-root-under-shared-runner-evidence-lease',
        observer: 'downstream-evidence-only-never-planner-input',
        history: 'complete-authoritative-ledger-streamed-without-copying-history-chunks',
        shell: 'exact-current-root-manifest-and-every-visited-part-preserved',
        limits: {
          ledgerBytes: MAX_LEDGER_BYTES,
          ledgerLines: MAX_LEDGER_LINES,
          projectLifecycles: MAX_PROJECT_LIFECYCLES,
          lifeEventsPerKind: MAX_LIFE_EVENTS,
          projectActionMemberships: MAX_PROJECT_ACTION_MEMBERSHIPS,
          embeddedProjectReferenceKeys: MAX_EMBEDDED_PROJECT_REFERENCE_KEYS,
          representativeEventsPerCategory: MAX_REPRESENTATIVE_EVENTS,
          referencedEventIdsPerRepresentative: MAX_REFERENCED_EVENT_IDS,
        },
      },
      verifierProvenance: verifier.provenance,
      authority: exactAuthorityForPack(authority),
      continuation: {
        schemaVersion: bundle.schemaVersion,
        historyMode: bundle.historyMode,
        hotStartIndex: bundle.hotStartIndex,
        coldPinCount: bundle.coldPins.length,
        sidecars: bundle.sidecars,
        observerMaterializationSource: bundle.observerMaterializationSource ?? null,
      },
      ledger: ledgerEvidence(ledger),
      history,
      shell: {
        receipt: shell.receipt,
        fieldReferences: shellReferences,
        preservedChunks: stager.receipts(),
        summary: Object.fromEntries(Object.entries(shell).filter(([key]) => key !== 'receipt')),
      },
    };
    const hash = evidenceHash(content);
    const pack = {
      ...content,
      integrity: {
        algorithm: 'sha256',
        domain: EVIDENCE_HASH_DOMAIN,
        hash,
        scope: 'canonical-pack-without-integrity-field',
      },
    };
    assertVerifierProvenanceStable(verifier);
    assertEvidenceLease(evidenceLease);
    stager.install(outputRoot);
    const packPath = path.join(
      outputRoot,
      'packs',
      runId,
      `month-${String(expectedMonth).padStart(5, '0')}-${hash}.json`,
    );
    atomicWriteNewOrSame(packPath, Buffer.from(`${canonicalJson(pack)}\n`));
    assertEvidenceLease(evidenceLease);
    result = {
      ok: true,
      schema: EVIDENCE_SCHEMA,
      runId,
      month: expectedMonth,
      authority: exactAuthorityForPack(authority),
      packHash: hash,
      packPath,
      preservedChunkCount: stager.receipts().length,
    };
  } finally {
    try {
      if (stagingDirectory !== null) rmSync(stagingDirectory, { recursive: true, force: true });
      if (temporaryDirectory !== null) rmSync(temporaryDirectory, { recursive: true, force: true });
    } finally {
      assert.equal(
        releaseEvidenceLease(evidenceLease),
        true,
        'evidence lease 已被替换或删除，拒绝释放非自身 lock',
      );
    }
  }
  assert.ok(result, 'horizon evidence 未生成结果');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === extractorSourcePath) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
