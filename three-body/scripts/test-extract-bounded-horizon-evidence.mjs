import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EVIDENCE_SCHEMA = 'eland-bounded-horizon-causal-evidence-v1';
const EVIDENCE_HASH_DOMAIN = `${EVIDENCE_SCHEMA}\0`;
const [dataDirectoryInput, runId, monthInput, outputRootInput] = process.argv.slice(2);

assert.equal(typeof dataDirectoryInput, 'string', '用法: test-extract <absolute-data-dir> <run-id> <month> [absolute-output-root]');
assert.equal(typeof runId, 'string');
const month = Number(monthInput);
assert.equal(Number.isSafeInteger(month) && month >= 0, true);

const dataDirectory = path.resolve(dataDirectoryInput);
const databaseFile = path.join(dataDirectory, 'eland.sqlite3');
const ledgerFile = path.join(dataDirectory, `${runId}.era-boundary-ledger-v1.jsonl`);
assert.equal(existsSync(databaseFile), true);
assert.equal(existsSync(ledgerFile), true);
const ownedOutput = outputRootInput === undefined;
const outputRoot = outputRootInput
  ? path.resolve(outputRootInput)
  : mkdtempSync(path.join(tmpdir(), 'eland-horizon-evidence-fixture-'));
const extractor = path.join(import.meta.dirname, 'extract-bounded-horizon-evidence.mjs');
const workspace = path.resolve(import.meta.dirname, '..');
const lockFile = path.join(dataDirectory, `.${runId}.era-boundary-ledger-v1.lock`);
const {
  createHistoryReducer,
  exactProjectActionEventIds,
} = await import(pathToFileURL(extractor).href);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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

function sumCounts(value) {
  assert.equal(value && typeof value === 'object' && !Array.isArray(value), true);
  return Object.values(value).reduce((sum, count) => {
    assert.equal(Number.isSafeInteger(count) && count >= 0, true, `无效 count: ${count}`);
    return sum + count;
  }, 0);
}

function sumNestedCounts(value) {
  assert.equal(value && typeof value === 'object' && !Array.isArray(value), true);
  return Object.values(value).reduce((sum, counts) => sum + sumCounts(counts), 0);
}

function assertBoundedWitness(witness, label) {
  assert.equal(typeof witness.eventId === 'string' && witness.eventId.length > 0, true, `${label} eventId 无效`);
  assert.equal(Number.isSafeInteger(witness.ordinal) && witness.ordinal >= 0, true, `${label} ordinal 无效`);
  assert.equal(Number.isSafeInteger(witness.atMonth) && witness.atMonth >= 0, true, `${label} month 无效`);
  assert.equal(Number.isSafeInteger(witness.orderInMonth) && witness.orderInMonth >= 0, true, `${label} order 无效`);
  assert.equal(['first', 'last', 'first-and-last'].includes(witness.boundary), true, `${label} boundary 无效`);
  if (witness.result !== null) {
    assert.match(witness.result.sha256, /^[0-9a-f]{64}$/u, `${label} result hash 无效`);
    assert.equal(Number.isSafeInteger(witness.result.byteLength) && witness.result.byteLength >= 0, true);
    assert.equal(Buffer.byteLength(witness.result.text, 'utf8') <= 512, true, `${label} result 摘要越界`);
    assert.equal(typeof witness.result.truncated, 'boolean');
  }
  if (witness.status === 'blocked') assert.notEqual(witness.blockedReason, null, `${label} 缺 blocked reason`);
}

function assertFirstLastWitnesses(witnesses, actionCount, label) {
  assert.equal(Array.isArray(witnesses), true, `${label} witnesses 不是数组`);
  assert.equal(witnesses.length <= 2, true, `${label} witnesses 超过 2`);
  assert.equal(witnesses.length === 0, actionCount === 0, `${label} witness/action 空值关系失配`);
  for (const witness of witnesses) assertBoundedWitness(witness, label);
  if (witnesses.length === 1) assert.equal(witnesses[0].boundary, 'first-and-last');
  if (witnesses.length === 2) {
    assert.equal(witnesses[0].boundary, 'first');
    assert.equal(witnesses[1].boundary, 'last');
    assert.ok(witnesses[0].ordinal < witnesses[1].ordinal, `${label} first/last 顺序无效`);
  }
}

function assertPowerBasisCounts(basis, label) {
  assert.equal(Number.isSafeInteger(basis.total) && basis.total >= 0, true, `${label} total missing`);
  assert.equal(sumCounts(basis.byMode), basis.total, `${label} mode total 失配`);
  assert.equal(sumCounts(basis.byStatus), basis.total, `${label} status total 失配`);
  assert.equal(sumNestedCounts(basis.byModeAndStatus), basis.total, `${label} mode/status total 失配`);
  assert.equal(basis.withOutcomeFlags + basis.withoutOutcomeFlags, basis.total, `${label} flag presence 失配`);
  assert.equal(sumCounts(basis.byOutcomeFlag), basis.outcomeFlagRelationshipCount, `${label} flag total 失配`);
  assert.equal(
    sumNestedCounts(basis.byModeAndOutcomeFlag),
    basis.outcomeFlagRelationshipCount,
    `${label} mode/flag total 失配`,
  );
}

function assertExactProjectCounts(funnel, shellLifecycles, label, hasPowerPhase) {
  const projects = Object.entries(funnel.byProjectId);
  assert.equal(projects.length, funnel.projectCount, `${label} project count 失配`);
  assert.equal(sumCounts(funnel.projectCountByDesiredFunction), funnel.projectCount, `${label} function project count 失配`);
  assert.equal(sumCounts(funnel.actionCountByDesiredFunction), funnel.actionMembershipCount, `${label} function action count 失配`);
  assert.equal(sumCounts(funnel.byActionStatus), funnel.actionMembershipCount, `${label} status count 失配`);
  assert.equal(sumCounts(funnel.byOperation), funnel.actionMembershipCount, `${label} operation count 失配`);
  if (hasPowerPhase) assert.equal(sumCounts(funnel.byPowerPhase), funnel.actionMembershipCount, `${label} phase count 失配`);
  assert.equal(sumCounts(funnel.blocked.byReasonSha256), funnel.blocked.actionMembershipCount, `${label} blocked count 失配`);
  assert.ok(funnel.uniqueActionEventIdCount <= funnel.actionMembershipCount, `${label} unique actions 越界`);
  let projectActionTotal = 0;
  let projectBlockedTotal = 0;
  for (const [projectId, project] of projects) {
    projectActionTotal += project.actionCount;
    projectBlockedTotal += project.blocked.count;
    assert.equal(sumCounts(project.byActionStatus), project.actionCount, `${label}/${projectId} status count 失配`);
    assert.equal(sumCounts(project.byOperation), project.actionCount, `${label}/${projectId} operation count 失配`);
    if (hasPowerPhase) assert.equal(sumCounts(project.byPowerPhase), project.actionCount, `${label}/${projectId} phase count 失配`);
    assert.equal(sumCounts(project.blocked.byReasonSha256), project.blocked.count, `${label}/${projectId} blocked count 失配`);
    assertFirstLastWitnesses(project.witnesses, project.actionCount, `${label}/${projectId}`);
    const shellProject = shellLifecycles.find((candidate) => candidate.projectId === projectId);
    assert.ok(shellProject, `${label}/${projectId} 不在 exact shell lifecycle`);
    assert.equal(project.desiredFunction, shellProject.desiredFunction);
    assert.equal(project.need, shellProject.need);
    assert.equal(project.status, shellProject.status);
    assert.equal(funnel.desiredFunctions.includes(project.desiredFunction), true);
  }
  assert.equal(projectActionTotal, funnel.actionMembershipCount, `${label} project action 汇总失配`);
  assert.equal(projectBlockedTotal, funnel.blocked.actionMembershipCount, `${label} project blocked 汇总失配`);
}

function fileSeal(filePath) {
  const stat = statSync(filePath);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function invokeRaw() {
  return spawnSync(process.execPath, [
    extractor,
    dataDirectory,
    runId,
    String(month),
    outputRoot,
  ], {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1_024 * 1_024,
  });
}

function invoke() {
  const result = invokeRaw();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'extractor stdout 必须只有一行 JSON');
  return JSON.parse(lines[0]);
}

function actionEvent(id) {
  return {
    id,
    kind: 'action',
    atMonth: 0,
    orderInMonth: 0,
    status: 'completed',
    action: { kind: 'act', operation: 'fixture-operation' },
    diff: {},
  };
}

const fixtureProjectMetadata = new Map([[
  'fixture-project',
  { desiredFunction: 'water-powered-crop-processing', need: 'capability', status: 'active' },
]]);

assert.throws(
  () => exactProjectActionEventIds('fixture-project', ['fixture-action', 'fixture-action']),
  /actionEventIds 含重复 ID/u,
  '同一 project.actionEventIds 重复必须 fail-closed',
);
{
  const reducer = createHistoryReducer(
    new Set(),
    new Map([['fixture-action', ['fixture-project']]]),
    1,
    fixtureProjectMetadata,
  );
  assert.throws(
    () => reducer.visit([{ id: 'fixture-action', kind: 'environment', atMonth: 0 }], { startEventIndex: 0 }),
    /不是 action fact/u,
    'project.actionEventIds 指向非 action 必须 fail-closed',
  );
}
{
  const reducer = createHistoryReducer(
    new Set(),
    new Map([['missing-action', ['fixture-project']]]),
    1,
    fixtureProjectMetadata,
  );
  assert.throws(
    () => reducer.finish({}),
    /未在完整权威历史中解析/u,
    '未解析 project.actionEventIds 必须 fail-closed',
  );
}
{
  const reducer = createHistoryReducer(
    new Set(),
    new Map([['fixture-action', ['fixture-project']]]),
    1,
    fixtureProjectMetadata,
  );
  assert.throws(
    () => reducer.visit(
      [actionEvent('fixture-action'), actionEvent('fixture-action')],
      { startEventIndex: 0 },
    ),
    /权威历史重复/u,
    '同一归属 action id 在完整历史重复必须 fail-closed',
  );
}

const databaseBefore = fileSeal(databaseFile);
const ledgerBefore = sha256(readFileSync(ledgerFile));
const fixtureLockContents = JSON.stringify({
  pid: process.pid,
  startedAt: 'fixture-existing-lock',
  kind: 'fixture',
  token: 'fixture-owned-lock-token',
});

try {
  assert.equal(existsSync(lockFile), false, `frozen fixture 已有 runner/evidence lock: ${lockFile}`);
  writeFileSync(lockFile, fixtureLockContents, { flag: 'wx', mode: 0o600 });
  const blocked = invokeRaw();
  assert.notEqual(blocked.status, 0, '现存 runner/evidence lock 必须拒绝 extractor');
  assert.match(blocked.stderr, /runner\/evidence lock 已存在/u);
  assert.equal(readFileSync(lockFile, 'utf8'), fixtureLockContents, 'extractor 不得删除他人 lock');
  unlinkSync(lockFile);

  const first = invoke();
  assert.equal(existsSync(lockFile), false, '首次 extractor 完成后残留 runner/evidence lock');
  const second = invoke();
  assert.equal(existsSync(lockFile), false, '第二次 extractor 完成后残留 runner/evidence lock');
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, '同一 frozen authority 重跑必须逐字指向同一 pack');
  assert.equal(first.month, month);
  assert.equal(first.runId, runId);
  assert.equal(existsSync(first.packPath), true);

  const bytes = readFileSync(first.packPath);
  assert.equal(bytes.at(-1), 10, 'pack 必须以单个换行结尾');
  const pack = JSON.parse(bytes.toString('utf8'));
  assert.equal(pack.schema, EVIDENCE_SCHEMA);
  assert.equal(pack.integrity?.domain, EVIDENCE_HASH_DOMAIN);
  const { integrity, ...content } = pack;
  assert.equal(
    sha256(`${EVIDENCE_HASH_DOMAIN}${canonicalJson(content)}`),
    integrity.hash,
    'pack canonical hash 失配',
  );
  assert.equal(integrity.hash, first.packHash);
  assert.equal(bytes.toString('utf8'), `${canonicalJson(pack)}\n`, 'pack 不是 canonical JSON');
  assert.equal(pack.authority.month, month);
  assert.equal(pack.authority.runId, runId);
  assert.equal(pack.history.cursor.eventCount, pack.authority.eventCount);
  assert.equal(pack.history.lastEventId, pack.authority.tailEventId);
  assert.equal(pack.shell.receipt.rootHash, pack.authority.stateHash);
  assert.equal(pack.shell.receipt.manifestHash, pack.authority.shellHash);
  assert.equal(pack.shell.summary.clock.elapsedMonths, month);
  assert.equal(pack.shell.summary.people.total, pack.authority.agentCount);
  assert.equal(pack.shell.summary.people.living, pack.authority.livingAgents);

  const projectSummary = pack.shell.summary.projects;
  const shellMembershipCount = projectSummary.lifecycles.reduce(
    (sum, project) => sum + project.uniqueActionEventCount,
    0,
  );
  assert.equal(projectSummary.actionEventMembershipCount, shellMembershipCount);
  assert.equal(projectSummary.duplicateWithinProjectActionReferenceCount, 0);
  const owningProjects = pack.history.actions.attribution.owningProjects;
  const embeddedReferences = pack.history.actions.attribution.embeddedProjectReferences;
  assert.equal(owningProjects.relationshipCount, shellMembershipCount);
  assert.equal(owningProjects.uniqueActionEventIdCount, projectSummary.uniqueActionEventIdCount);
  assert.equal(owningProjects.unresolvedEventIdCount, 0);
  assert.equal(
    Object.values(owningProjects.byOwningProjectId).reduce((sum, count) => sum + count, 0),
    shellMembershipCount,
  );
  assert.ok(
    owningProjects.relationshipCount > embeddedReferences.relationshipCount * 2,
    '权威 shell/history project attribution 应显著覆盖 payload embedded references',
  );
  for (const events of Object.values(pack.history.representativeChains)) {
    for (const event of events) {
      assert.equal(Array.isArray(event.owningProjectIds), true);
      assert.equal(Array.isArray(event.embeddedProjectIds), true);
    }
  }

  const causalFunnel = pack.history.modernPrerequisiteCausalFunnel;
  assert.equal(causalFunnel?.semantics?.authority,
    'full-authoritative-history-stream-not-representative-samples-or-observer-index');
  assert.equal(causalFunnel?.semantics?.projectOwnership,
    'exact-shell-project.actionEventIds-joined-through-shell-project-metadata');
  assert.equal(Number.isSafeInteger(causalFunnel?.countBounds?.causalFacts), true);
  assert.equal(Number.isSafeInteger(causalFunnel?.countBounds?.causalCountUniqueKeys), true);
  assert.ok(
    causalFunnel.countBounds.usedUniqueCountKeys <= causalFunnel.countBounds.causalCountUniqueKeys,
    'causal count unique key budget 越界',
  );
  assertPowerBasisCounts(causalFunnel.mechanical.basisActions, 'mechanical basis');
  assertPowerBasisCounts(causalFunnel.electrical.basisActions, 'electrical basis');
  assertExactProjectCounts(
    causalFunnel.mechanical.exactOwningProjects,
    projectSummary.lifecycles,
    'mechanical projects',
    true,
  );
  assertExactProjectCounts(
    causalFunnel.electrical.exactOwningProjects,
    projectSummary.lifecycles,
    'electrical projects',
    true,
  );
  assertExactProjectCounts(
    causalFunnel.recordUse.exactDurableRecordOwningProjects,
    projectSummary.lifecycles,
    'durable-record projects',
    false,
  );
  assert.ok(
    causalFunnel.mechanical.exactOwningProjects.actionMembershipCount > 0,
    '冻结 m1200 必须存在 exact owning mechanical project actions',
  );
  assert.equal(
    Number.isSafeInteger(causalFunnel.electrical.basisActions.total),
    true,
    'electrical basis total 即使为 0 也必须显式存在',
  );
  assert.equal(
    Number.isSafeInteger(causalFunnel.electrical.exactOwningProjects.actionMembershipCount),
    true,
    'electrical project action total 即使为 0 也必须显式存在',
  );

  const recordUse = causalFunnel.recordUse.markedActions;
  assert.equal(sumCounts(recordUse.byStage), recordUse.eventCount, 'record-use stage total 失配');
  assert.equal(sumCounts(recordUse.byStatus), recordUse.eventCount, 'record-use status total 失配');
  assert.equal(sumCounts(recordUse.byPurpose), recordUse.eventCount, 'record-use purpose total 失配');
  assert.equal(sumCounts(recordUse.byProjectId), recordUse.eventCount, 'record-use project total 失配');
  assert.equal(sumCounts(recordUse.byRecordId), recordUse.eventCount, 'record-use record total 失配');
  assert.equal(sumCounts(recordUse.byReaderId), recordUse.eventCount, 'record-use reader total 失配');
  assert.equal(sumCounts(recordUse.byReaderSource), recordUse.eventCount, 'record-use reader source total 失配');
  assert.equal(
    recordUse.explicitStageFieldCount
      + recordUse.preparationFieldCount
      + recordUse.replicationReceiptFieldCount,
    recordUse.markerFieldRelationshipCount,
    'record-use marker field total 失配',
  );
  assert.equal(sumCounts(recordUse.byMarkerValue), recordUse.markerFieldRelationshipCount,
    'record-use marker value total 失配');
  const validRecordStages = new Set([
    'share',
    'read-experiment',
    'acquire',
    'read',
    'prepare-experiment',
    'experiment',
    'replicate',
  ]);
  for (const [stage, count] of Object.entries(recordUse.byStage)) {
    assert.equal(validRecordStages.has(stage), true, `冻结 m1200 出现非法 record-use stage: ${stage}`);
    const witnesses = recordUse.witnessesByStage[stage];
    assertFirstLastWitnesses(witnesses, count, `record-use/${stage}`);
  }
  assert.deepEqual(
    Object.keys(recordUse.witnessesByStage).sort(),
    Object.keys(recordUse.byStage).sort(),
    'record-use stage witness keys 失配',
  );
  assert.ok(
    recordUse.preparationTrueCount <= (recordUse.byStage['prepare-experiment'] ?? 0),
    'record-use preparation 未归入 prepare-experiment',
  );
  assert.ok(
    recordUse.replicationReceiptTrueCount <= (recordUse.byStage.replicate ?? 0),
    'record-use replication receipt 未归入 replicate',
  );

  const provenance = pack.verifierProvenance;
  assert.equal(provenance.extractorSourceSha256, sha256(readFileSync(extractor)));
  assert.equal(
    provenance.runStateCodecSourceSha256,
    sha256(readFileSync(path.join(workspace, 'server/run-state-codec.ts'))),
  );
  assert.equal(
    provenance.runContinuationBundleSourceSha256,
    sha256(readFileSync(path.join(workspace, 'server/run-continuation-bundle.ts'))),
  );
  const codecEntrySource = [
    `export { parseRunStateRoot, parseRunStateShellManifest, streamVerifiedRunHistorySegments, streamVerifiedSchema3RunStateShell } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { decodeRunContinuationBundle } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
  ].join('\n');
  assert.equal(provenance.codecEntrySourceSha256, sha256(Buffer.from(codecEntrySource, 'utf8')));
  assert.match(provenance.esbuildBundleSha256, /^[0-9a-f]{64}$/u);
  assert.equal(typeof provenance.esbuildVersion === 'string' && provenance.esbuildVersion.length > 0, true);
  assert.deepEqual(provenance.esbuildArguments, [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--minify',
    '--log-level=error',
  ]);
  assert.equal(Array.isArray(provenance.esbuildInputs), true);
  assert.ok(provenance.esbuildInputs.length >= 6, 'verifier provenance 缺少传递源码输入');
  const expectedVerifierSources = [
    'generated:codec-entry.ts',
    'server/bounded-gameplay-shell.ts',
    'server/bounded-observer-hot-shell.ts',
    'server/run-continuation-bundle.ts',
    'server/run-state-codec.ts',
    'src/game/eland/domain/person.ts',
    'server/event-history-memory.ts',
  ];
  for (const source of expectedVerifierSources) {
    assert.equal(
      provenance.esbuildInputs.some((input) => input.source === source),
      true,
      `verifier provenance 缺少 ${source}`,
    );
  }
  for (const input of provenance.esbuildInputs) {
    const sourceBytes = input.source === 'generated:codec-entry.ts'
      ? Buffer.from(codecEntrySource, 'utf8')
      : readFileSync(path.join(workspace, input.source));
    assert.equal(input.bytes, sourceBytes.byteLength, `verifier input ${input.source} bytes 失配`);
    assert.equal(input.sha256, sha256(sourceBytes), `verifier input ${input.source} hash 失配`);
  }
  const rebuildDirectory = mkdtempSync(path.join(tmpdir(), 'eland-verifier-rebuild-'));
  try {
    const rebuildEntry = path.join(rebuildDirectory, 'entry.ts');
    const rebuildBundle = path.join(rebuildDirectory, 'codec.mjs');
    writeFileSync(rebuildEntry, codecEntrySource, { flag: 'wx', mode: 0o600 });
    const esbuild = process.env.ELAND_ESBUILD_BIN
      ? path.resolve(process.env.ELAND_ESBUILD_BIN)
      : path.join(workspace, 'node_modules/.bin/esbuild');
    execFileSync(esbuild, [
      rebuildEntry,
      ...provenance.esbuildArguments,
      `--outfile=${rebuildBundle}`,
    ], { cwd: workspace, env: process.env, stdio: 'pipe' });
    assert.equal(
      sha256(readFileSync(rebuildBundle)),
      provenance.esbuildBundleSha256,
      '按记录参数与完整输入重建的 verifier bundle hash 失配',
    );
  } finally {
    rmSync(rebuildDirectory, { recursive: true, force: true });
  }

  const chunks = pack.shell.preservedChunks;
  assert.equal(Array.isArray(chunks) && chunks.length === first.preservedChunkCount, true);
  assert.equal(chunks.some((chunk) => chunk.roles.includes('current-root')), true);
  assert.equal(chunks.some((chunk) => chunk.roles.includes('continuation-bundle')), true);
  assert.equal(chunks.some((chunk) => chunk.roles.includes('shell-manifest')), true);
  assert.equal(chunks.some((chunk) => chunk.roles.includes('shell-part')), true);
  for (const chunk of chunks) {
    assert.equal(
      chunk.roles.every((role) => [
        'current-root',
        'continuation-bundle',
        'shell-manifest',
        'shell-part',
      ].includes(role)),
      true,
      `证据包错误保存了非 shell/history chunk role: ${chunk.roles.join(',')}`,
    );
    const chunkPath = path.join(outputRoot, 'chunks', chunk.hash);
    assert.equal(existsSync(chunkPath), true);
    assert.equal(sha256(readFileSync(chunkPath)), chunk.storedBytesSha256);
  }

  assert.deepEqual(fileSeal(databaseFile), databaseBefore, 'fixture 改动了 SQLite');
  assert.equal(sha256(readFileSync(ledgerFile)), ledgerBefore, 'fixture 改动了时代账本');
  assert.equal(existsSync(lockFile), false, 'fixture 结束时残留 runner/evidence lock');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId,
    month,
    packHash: first.packHash,
    packBytes: bytes.byteLength,
    preservedChunkCount: chunks.length,
    causalFunnel: {
      mechanicalBasisActions: causalFunnel.mechanical.basisActions.total,
      mechanicalProjectActions: causalFunnel.mechanical.exactOwningProjects.actionMembershipCount,
      electricalBasisActions: causalFunnel.electrical.basisActions.total,
      electricalProjectActions: causalFunnel.electrical.exactOwningProjects.actionMembershipCount,
      recordUseEvents: recordUse.eventCount,
      recordUseByStage: recordUse.byStage,
      durableRecordProjectActions:
        causalFunnel.recordUse.exactDurableRecordOwningProjects.actionMembershipCount,
    },
  })}\n`);
} finally {
  if (existsSync(lockFile) && readFileSync(lockFile, 'utf8') === fixtureLockContents) {
    unlinkSync(lockFile);
  }
  if (ownedOutput) rmSync(outputRoot, { recursive: true, force: true });
}
