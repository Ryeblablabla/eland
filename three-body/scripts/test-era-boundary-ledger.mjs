import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-era-boundary-ledger-'));
const dataDirectory = path.join(temporaryDirectory, 'data');
const runnerPath = path.join(workspace, 'scripts/run-bounded-modern-evolution.mjs');
const verifierPath = path.join(workspace, 'scripts/verify-era-boundary-ledger.mjs');
const driftRunnerPath = path.join(workspace, `scripts/.era-ledger-drift-${process.pid}.mjs`);
const LEDGER_HASH_DOMAIN = 'eland-era-boundary-ledger-v1\0';
const results = [];

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

function ledgerHash(value) {
  return createHash('sha256')
    .update(`${LEDGER_HASH_DOMAIN}${JSON.stringify(canonicalValue(value))}`)
    .digest('hex');
}

function invokeRunner({
  id,
  seed,
  targetMonth = 12,
  hotLimit = 256,
  runner = runnerPath,
  env = {},
}) {
  const child = spawnSync(process.execPath, [
    runner,
    dataDirectory,
    id,
    String(seed),
    String(targetMonth),
    String(hotLimit),
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=512',
      ...env,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ok(child.stdout.trim(), `${id} runner 没有 JSON stdout: ${child.stderr}`);
  const result = JSON.parse(child.stdout.trim());
  results.push(result);
  return { child, result };
}

function invokeVerifier(id) {
  const child = spawnSync(process.execPath, [verifierPath, dataDirectory, id], {
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ok(child.stdout.trim(), `${id} verifier 没有 JSON stdout: ${child.stderr}`);
  const result = JSON.parse(child.stdout.trim());
  results.push(result);
  return { child, result };
}

function ledgerPath(id) {
  return path.join(dataDirectory, `${id}.era-boundary-ledger-v1.jsonl`);
}

function readLedger(id) {
  return readFileSync(ledgerPath(id), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
}

try {
  const annual = invokeRunner({ id: 'ledger-annual', seed: 94_201 });
  assert.equal(annual.child.status, 0, `${annual.child.stderr}\n${annual.child.stdout}`);
  assert.equal(annual.result.ok, true);
  assert.equal(annual.result.reachedMonth, 12);
  assert.equal(annual.result.eraBoundaryLedger.entries, 3);
  const annualLines = readLedger('ledger-annual');
  assert.deepEqual(annualLines.map((line) => line.type), ['header', 'bootstrap', 'boundary']);
  assert.equal(annualLines[2].boundaryKind, 'annual');
  assert.equal(annualLines[2].authority.month, 12);

  const resumed = invokeRunner({ id: 'ledger-annual', seed: 94_201 });
  assert.equal(resumed.child.status, 0, `${resumed.child.stderr}\n${resumed.child.stdout}`);
  assert.equal(resumed.result.startMonth, 12);
  assert.equal(resumed.result.eraBoundaryLedger.entries, 3, 'resume 不得重复追加 annual');
  assert.equal(readLedger('ledger-annual').length, 3);
  const verifiedAnnual = invokeVerifier('ledger-annual');
  assert.equal(verifiedAnnual.child.status, 0, verifiedAnnual.child.stdout);
  assert.equal(verifiedAnnual.result.ok, true);
  assert.equal(verifiedAnnual.result.dbRelation, 'exact');
  assert.deepEqual(verifiedAnnual.result.observedPath, ['primitive-tribe']);
  assert.equal(verifiedAnnual.result.proofStrength.at(-1).strength, 'db-live');

  const crashed = invokeRunner({
    id: 'ledger-recovery',
    seed: 94_202,
    env: {
      NODE_ENV: 'test',
      ELAND_ERA_LEDGER_FAIL_AFTER_BOUNDARY_COMMIT_FOR_TESTS: '1',
    },
  });
  assert.equal(crashed.child.status, 2, crashed.child.stderr);
  assert.equal(crashed.result.ok, false);
  assert.equal(crashed.result.reachedMonth, 12);
  assert.match(crashed.result.stopped?.error ?? '', /after boundary DB commit/u);
  assert.equal(readLedger('ledger-recovery').length, 2);
  const recovered = invokeRunner({ id: 'ledger-recovery', seed: 94_202 });
  assert.equal(recovered.child.status, 0, `${recovered.child.stderr}\n${recovered.child.stdout}`);
  const recoveredLines = readLedger('ledger-recovery');
  assert.equal(recoveredLines.length, 3);
  assert.equal(recoveredLines[2].recoveredAfterPublication, true);
  assert.equal(recoveredLines[2].authority.month, 12);

  const originalLedger = readFileSync(ledgerPath('ledger-annual'));
  const tamperedLines = readLedger('ledger-annual');
  tamperedLines.at(-1).status = 'tampered';
  writeFileSync(ledgerPath('ledger-annual'), `${tamperedLines.map(JSON.stringify).join('\n')}\n`);
  const tampered = invokeVerifier('ledger-annual');
  assert.equal(tampered.child.status, 2, tampered.child.stdout);
  assert.equal(tampered.result.ok, false);
  assert.match(tampered.result.error, /hash 验证失败/u);
  writeFileSync(ledgerPath('ledger-annual'), originalLedger);

  const forgedLineage = readLedger('ledger-annual');
  const last = forgedLineage.at(-1);
  last.authority.lineageId = '00000000-0000-0000-0000-000000000000';
  const { hash: _oldHash, ...unhashed } = last;
  last.hash = ledgerHash(unhashed);
  writeFileSync(ledgerPath('ledger-annual'), `${forgedLineage.map(JSON.stringify).join('\n')}\n`);
  const lineageRejected = invokeRunner({ id: 'ledger-annual', seed: 94_201 });
  assert.equal(lineageRejected.child.status, 1, lineageRejected.child.stdout);
  assert.equal(lineageRejected.result.ok, false);
  assert.match(lineageRejected.result.error, /lineage 失配/u);
  writeFileSync(ledgerPath('ledger-annual'), originalLedger);

  writeFileSync(
    driftRunnerPath,
    `${readFileSync(runnerPath, 'utf8')}\n// fixture source drift\n`,
  );
  const sourceDrift = invokeRunner({
    id: 'ledger-annual',
    seed: 94_201,
    runner: driftRunnerPath,
  });
  assert.equal(sourceDrift.child.status, 1, sourceDrift.child.stdout);
  assert.equal(sourceDrift.result.ok, false);
  assert.match(sourceDrift.result.error, /runner source hash 漂移/u);
  assert.equal(readLedger('ledger-annual').length, 3);

  const configDrift = invokeRunner({ id: 'ledger-annual', seed: 94_201, hotLimit: 257 });
  assert.equal(configDrift.child.status, 1, configDrift.child.stdout);
  assert.equal(configDrift.result.ok, false);
  assert.match(configDrift.result.error, /config 与当前运行不一致/u);

  const maxRss = Math.max(process.resourceUsage().maxRSS * 1_024, ...results.map(
    (result) => Number(result.maxRss ?? 0),
  ));
  assert.equal(maxRss <= 384 * 1_024 * 1_024, true, `ledger fixture RSS ${maxRss} 超过 384MiB`);
  console.log(JSON.stringify({
    ok: true,
    annual: { entries: annualLines.length, resumedEntries: readLedger('ledger-annual').length },
    recovery: { committedMonth: crashed.result.reachedMonth, recovered: recoveredLines[2].recoveredAfterPublication },
    rejected: ['hash tamper', 'internally rehashed lineage mismatch', 'runner source drift', 'config drift'],
    maxRss,
  }));
} finally {
  if (existsSafe(driftRunnerPath)) unlinkSync(driftRunnerPath);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function existsSafe(filePath) {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}
