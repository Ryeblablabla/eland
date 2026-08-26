import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const [
  action,
  dataDirectoryInput,
  runId,
  revisionInput,
  monthInput,
  stateHash,
  hotLimitInput,
  advanceMonthCountInput,
] = process.argv.slice(2);
const stepActions = new Set(['step', 'annual-step']);
const actions = new Set(['bootstrap', 'refresh', 'advance', ...stepActions]);

if (!actions.has(action)
  || !dataDirectoryInput
  || !runId
  || !revisionInput
  || !monthInput
  || !stateHash) {
  throw new Error(
    '用法: node scripts/run-bounded-continuation-maintenance.mjs '
    + '<bootstrap|refresh|step|annual-step|advance> <absolute-data-dir> <run-id> '
    + '<expected-revision> <expected-month> <expected-state-hash> [hot-event-limit] '
    + '[advance-month-count]',
  );
}

const dataDirectory = path.resolve(dataDirectoryInput);
const databaseFile = path.join(dataDirectory, 'eland.sqlite3');
const expectedRevision = Number(revisionInput);
const expectedMonth = Number(monthInput);
const hotEventLimit = hotLimitInput === undefined ? 4_096 : Number(hotLimitInput);
const advanceMonthCount = advanceMonthCountInput === undefined
  ? undefined
  : Number(advanceMonthCountInput);
assert.equal(path.isAbsolute(dataDirectoryInput), true, 'data dir 必须显式使用绝对路径');
assert.equal(existsSync(databaseFile), true, `数据库不存在: ${databaseFile}`);
assert.equal(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, true);
assert.equal(Number.isSafeInteger(expectedMonth) && expectedMonth >= 0, true);
assert.equal(Number.isSafeInteger(hotEventLimit) && hotEventLimit >= 1, true);
assert.match(stateHash, /^[0-9a-f]{64}$/u);
if (action === 'advance') {
  assert.equal(
    Number.isSafeInteger(advanceMonthCount)
      && advanceMonthCount >= 1
      && advanceMonthCount <= 12,
    true,
    'advance-month-count 必须是 1-12 的显式安全整数',
  );
} else {
  assert.equal(advanceMonthCount, undefined, '只有 advance 接受 advance-month-count');
}
if (action === 'annual-step') {
  assert.equal(
    (expectedMonth + 1) % 12,
    0,
    'annual-step 只允许 expected-month + 1 是 12 的倍数',
  );
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function authoritySnapshot(database) {
  const run = database.prepare(`
    SELECT id, state_hash, revision, elapsed_months, event_count, status
    FROM runs WHERE id = ?
  `).get(runId);
  const continuation = tableExists(database, 'run_continuations')
    ? database.prepare(`
        SELECT run_id, revision, state_hash, event_count, hot_event_limit, bundle_hash
        FROM run_continuations WHERE run_id = ?
      `).get(runId)
    : undefined;
  const checkpoint = run
    ? database.prepare(`
        SELECT run_id, revision, month, state_hash
        FROM run_checkpoints
        WHERE run_id = ? AND revision = ? AND state_hash = ?
      `).get(runId, run.revision, run.state_hash)
    : undefined;
  const checkpointCount = run
    ? Number(database.prepare(`
        SELECT COUNT(*) AS count FROM run_checkpoints WHERE run_id = ?
      `).get(runId).count)
    : 0;
  return {
    schemaVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
    run,
    continuation,
    checkpoint,
    checkpointCount,
  };
}

function assertExpectedSource(snapshot) {
  assert.ok(snapshot.run, `运行不存在: ${runId}`);
  assert.equal(Number(snapshot.run.revision), expectedRevision, 'revision 与显式预期不一致');
  assert.equal(Number(snapshot.run.elapsed_months), expectedMonth, 'month 与显式预期不一致');
  assert.equal(String(snapshot.run.state_hash), stateHash, 'state hash 与显式预期不一致');
  assert.equal(String(snapshot.checkpoint?.run_id ?? ''), runId, '缺少当前 exact checkpoint');
  assert.equal(Number(snapshot.checkpoint?.revision), expectedRevision, 'checkpoint revision 不一致');
  assert.equal(Number(snapshot.checkpoint?.month), expectedMonth, 'checkpoint month 不一致');
  assert.equal(String(snapshot.checkpoint?.state_hash ?? ''), stateHash, 'checkpoint root 不一致');
  if (action === 'bootstrap') assert.equal(snapshot.continuation, undefined, 'bootstrap 目标已经有 continuation');
  else {
    assert.ok(snapshot.continuation, 'step 目标缺少 continuation');
    assert.equal(Number(snapshot.continuation.revision), expectedRevision, 'continuation revision 不一致');
    assert.equal(String(snapshot.continuation.state_hash), stateHash, 'continuation root 不一致');
    assert.equal(
      Number(snapshot.continuation.event_count),
      Number(snapshot.run.event_count),
      'continuation event count 与运行权威不一致',
    );
  }
}

function compactReceipt(receipt) {
  assert.ok(receipt && typeof receipt === 'object', '维护动作未返回 receipt');
  return Object.fromEntries([
    'kind',
    'boundaryKind',
    'persisted',
    'continuationReady',
    'revision',
    'month',
    'stateHash',
    'stage',
  ].filter((key) => Object.hasOwn(receipt, key)).map((key) => [key, receipt[key]]));
}

function readAuthoritySnapshot() {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return authoritySnapshot(database);
  } finally {
    database.close();
  }
}

function assertCommittedSuccessor(previous, committed, receipt, offset) {
  assert.ok(committed.run);
  assert.ok(committed.continuation);
  assert.ok(committed.checkpoint);
  assert.equal(Number(committed.run.revision), expectedRevision + offset);
  assert.equal(Number(committed.run.elapsed_months), expectedMonth + offset);
  assert.equal(Number(committed.continuation.revision), expectedRevision + offset);
  assert.equal(String(committed.continuation.state_hash), String(committed.run.state_hash));
  assert.equal(
    Number(committed.continuation.event_count),
    Number(committed.run.event_count),
    `第 ${offset} 个月 continuation event count 与运行权威不一致`,
  );
  assert.equal(Number(committed.checkpoint.revision), expectedRevision + offset);
  assert.equal(Number(committed.checkpoint.month), expectedMonth + offset);
  assert.equal(String(committed.checkpoint.state_hash), String(committed.run.state_hash));
  assert.equal(
    committed.checkpointCount,
    previous.checkpointCount + 1,
    `第 ${offset} 个月必须独立新增 exact checkpoint`,
  );
  assert.equal(Number(receipt.revision), expectedRevision + offset);
  assert.equal(Number(receipt.month), expectedMonth + offset);
  assert.equal(String(receipt.stateHash), String(committed.run.state_hash));
  assert.notEqual(
    String(committed.run.state_hash),
    String(previous.run.state_hash),
    `第 ${offset} 个月必须生成新权威 root`,
  );
  const expectedBoundaryKind = (expectedMonth + offset) % 12 === 0
    ? 'annual'
    : undefined;
  if (expectedBoundaryKind) assert.equal(receipt.boundaryKind, expectedBoundaryKind);
  else assert.notEqual(receipt.boundaryKind, 'annual');
}

let preflightDatabase = new DatabaseSync(databaseFile, { readOnly: true });
const before = authoritySnapshot(preflightDatabase);
preflightDatabase.close();
preflightDatabase = undefined;
assert.equal(before.schemaVersion === 2 || before.schemaVersion === 3, true, '只接受 schema 2/3 数据库');
assertExpectedSource(before);

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-maintenance-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'maintenance.mjs');
let store;

try {
  writeFileSync(
    entryPath,
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};\n`,
  );
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=error',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: process.env, stdio: 'pipe' });
  const { SqliteRunStore } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  store = new SqliteRunStore(dataDirectory);

  let receipt;
  const monthlyReceipts = [];
  if (action === 'bootstrap') {
    receipt = await store.bootstrapBoundedEvolutionContinuation(runId, hotEventLimit);
  } else if (action === 'refresh') {
    receipt = await store.refreshBoundedEvolutionContinuation(runId, hotEventLimit);
    const opened = await store.openBoundedEvolutionContinuation(runId);
    assert.equal(opened.meta.revision, expectedRevision, 'refresh bundle 回读 revision 不一致');
    assert.equal(opened.meta.elapsedMonths, expectedMonth, 'refresh bundle 回读 month 不一致');
    assert.equal(opened.basis.stateHash, stateHash, 'refresh bundle 回读 root 不一致');
    assert.equal(
      opened.basis.history.eventCount,
      Number(before.run.event_count),
      'refresh bundle 回读 event count 不一致',
    );
  } else if (action === 'advance') {
    let committed = before;
    for (let offset = 1; offset <= advanceMonthCount; offset += 1) {
      const targetMonth = expectedMonth + offset;
      const monthReceipt = targetMonth % 12 === 0
        ? await store.publishBoundedObserverBoundaryMonth(
            await store.stageBoundedObserverBoundaryMonth(runId),
          )
        : await store.publishBoundedNonProjectionMonth(
            await store.stageBoundedNonProjectionMonth(runId),
          );
      const next = readAuthoritySnapshot();
      assert.equal(next.schemaVersion, 3, `第 ${offset} 个月后数据库必须是 schema 3`);
      assertCommittedSuccessor(committed, next, monthReceipt, offset);
      monthlyReceipts.push(compactReceipt(monthReceipt));
      committed = next;
      receipt = monthReceipt;
    }
  } else if (action === 'annual-step') {
    receipt = await store.publishBoundedObserverBoundaryMonth(
      await store.stageBoundedObserverBoundaryMonth(runId),
    );
  } else {
    receipt = await store.publishBoundedNonProjectionMonth(
      await store.stageBoundedNonProjectionMonth(runId),
    );
  }
  store.close();
  store = undefined;

  const postflightDatabase = new DatabaseSync(databaseFile, { readOnly: true });
  const after = authoritySnapshot(postflightDatabase);
  postflightDatabase.close();
  assert.equal(after.schemaVersion, 3, '维护后数据库必须是当前 schema 3');
  assert.ok(after.run);
  assert.ok(after.continuation);
  assert.ok(after.checkpoint);
  if (action === 'bootstrap' || action === 'refresh') {
    assert.equal(Number(after.run.revision), expectedRevision);
    assert.equal(Number(after.run.elapsed_months), expectedMonth);
    assert.equal(String(after.run.state_hash), stateHash);
    assert.equal(Number(after.run.event_count), Number(before.run.event_count));
    assert.equal(Number(after.continuation.revision), expectedRevision);
    assert.equal(String(after.continuation.state_hash), stateHash);
    assert.equal(after.checkpointCount, before.checkpointCount);
    if (action === 'refresh') {
      assert.deepEqual(after.run, before.run, 'refresh 不得改写 run authority');
      assert.deepEqual(after.checkpoint, before.checkpoint, 'refresh 不得改写 exact checkpoint');
      assert.equal(Number(after.continuation.hot_event_limit), hotEventLimit);
      assert.equal(receipt.kind, 'bounded-evolution-continuation-refresh-receipt-v1');
    }
  } else {
    const committedMonths = action === 'advance' ? advanceMonthCount : 1;
    assert.equal(Number(after.run.revision), expectedRevision + committedMonths);
    assert.equal(Number(after.run.elapsed_months), expectedMonth + committedMonths);
    assert.notEqual(String(after.run.state_hash), stateHash);
    assert.equal(Number(after.continuation.revision), expectedRevision + committedMonths);
    assert.equal(String(after.continuation.state_hash), String(after.run.state_hash));
    assert.equal(Number(receipt.revision), expectedRevision + committedMonths);
    assert.equal(Number(receipt.month), expectedMonth + committedMonths);
    assert.equal(String(receipt.stateHash), String(after.run.state_hash));
    assert.equal(
      after.checkpointCount,
      before.checkpointCount + committedMonths,
      '每个推进月都必须独立新增 exact checkpoint',
    );
    if (action === 'annual-step') {
      assert.equal(receipt.boundaryKind, 'annual');
      assert.equal(Number(after.run.elapsed_months) % 12, 0);
    }
  }
  assert.equal(
    Number(after.continuation.event_count),
    Number(after.run.event_count),
    'commit 后 continuation event count 与运行权威不一致',
  );
  assert.equal(Number(after.checkpoint.revision), Number(after.run.revision));
  assert.equal(Number(after.checkpoint.month), Number(after.run.elapsed_months));
  assert.equal(String(after.checkpoint.state_hash), String(after.run.state_hash));

  console.log(JSON.stringify({
    ok: true,
    action,
    receipt: compactReceipt(receipt),
    ...(action === 'advance' ? {
      advance: {
        monthCount: advanceMonthCount,
        annualBoundaryCount: monthlyReceipts.filter(
          (monthReceipt) => monthReceipt.boundaryKind === 'annual',
        ).length,
      },
    } : {}),
    before: {
      schemaVersion: before.schemaVersion,
      revision: Number(before.run.revision),
      month: Number(before.run.elapsed_months),
      eventCount: Number(before.run.event_count),
      stateHash: String(before.run.state_hash),
    },
    after: {
      schemaVersion: after.schemaVersion,
      revision: Number(after.run.revision),
      month: Number(after.run.elapsed_months),
      eventCount: Number(after.run.event_count),
      stateHash: String(after.run.state_hash),
      hotEventLimit: Number(after.continuation.hot_event_limit),
      bundleHash: String(after.continuation.bundle_hash),
    },
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  }));
} finally {
  store?.close();
  preflightDatabase?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
