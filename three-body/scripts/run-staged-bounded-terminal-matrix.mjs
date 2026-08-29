import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SCHEMA = 'eland-staged-bounded-terminal-matrix-v1';
const SOURCE_SEAL_SCHEMA = 'eland-staged-bounded-terminal-source-seal-v1';
const HORIZONS = Object.freeze([120, 360, 600, 1_200, 12_000]);
const DEFAULT_SEEDS = Object.freeze([185, 20_260_815, 20_260_816]);
const DEFAULT_HOT_EVENT_LIMIT = 2_048;
const MAX_STDOUT_BYTES = 16 * 1_024 * 1_024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,40}$/u;
const workspace = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(workspace, '..');
const orchestratorSourcePath = path.resolve(import.meta.filename);
const defaultRunnerPath = path.join(import.meta.dirname, 'run-bounded-modern-evolution.mjs');
const defaultExtractorPath = path.join(import.meta.dirname, 'extract-bounded-horizon-evidence.mjs');

let activeChild = null;
let atomicWriteSequence = 0;

class ChildFailure extends Error {
  constructor(kind, detail) {
    super(`${kind} child 失败: ${detail}`);
    this.name = 'ChildFailure';
    this.kind = kind;
    this.detail = detail;
  }
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  atomicWriteSequence += 1;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${atomicWriteSequence}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON: ${errorText(error)}`);
  }
}

function parseFlags(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  assert.equal(argv.length % 2, 0, usage());
  const allowed = new Set([
    '--data-root',
    '--evidence-root',
    '--manifest',
    '--prefix',
    '--seeds',
    '--hot-limit',
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert.equal(allowed.has(flag), true, `未知参数 ${flag}\n${usage()}`);
    assert.equal(values.has(flag), false, `参数 ${flag} 重复`);
    assert.equal(typeof value === 'string' && value.length > 0, true, `参数 ${flag} 缺少值`);
    values.set(flag, value);
  }
  for (const required of ['--data-root', '--evidence-root', '--manifest', '--prefix']) {
    assert.equal(values.has(required), true, `缺少 ${required}\n${usage()}`);
  }
  const absolutePath = (flag) => {
    const input = values.get(flag);
    assert.equal(path.isAbsolute(input), true, `${flag} 必须显式使用绝对路径`);
    return path.resolve(input);
  };
  const prefix = values.get('--prefix');
  assert.equal(PREFIX_PATTERN.test(prefix), true, 'prefix 仅支持 1-40 位字母、数字、下划线或连字符');
  const seeds = (values.get('--seeds') ?? DEFAULT_SEEDS.join(','))
    .split(',')
    .map((input) => Number(input));
  assert.equal(seeds.length, 3, '必须严格提供三个 seed');
  assert.equal(new Set(seeds).size, 3, '三个 seed 必须互不相同');
  assert.equal(seeds.every((seed) => Number.isSafeInteger(seed)), true, 'seed 必须是安全整数');
  const hotEventLimit = Number(values.get('--hot-limit') ?? DEFAULT_HOT_EVENT_LIMIT);
  assert.equal(
    Number.isSafeInteger(hotEventLimit) && hotEventLimit >= 1 && hotEventLimit <= 65_536,
    true,
    'hot-limit 必须是 1-65536 的安全整数',
  );
  const dataRoot = absolutePath('--data-root');
  const evidenceRoot = absolutePath('--evidence-root');
  const manifestPath = absolutePath('--manifest');
  assert.notEqual(dataRoot, evidenceRoot, 'data root 与 evidence root 必须不同');
  return {
    help: false,
    dataRoot,
    evidenceRoot,
    manifestPath,
    prefix,
    seeds,
    hotEventLimit,
  };
}

function usage() {
  return [
    '用法: node scripts/run-staged-bounded-terminal-matrix.mjs',
    '  --data-root <absolute-path>',
    '  --evidence-root <absolute-path>',
    '  --manifest <absolute-json-path>',
    '  --prefix <source-variant-prefix>',
    `  [--seeds ${DEFAULT_SEEDS.join(',')}]`,
    `  [--hot-limit ${DEFAULT_HOT_EVENT_LIMIT}]`,
  ].join(' ');
}

function resolveDependencies() {
  const testOverride = (name, fallback) => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    assert.equal(process.env.NODE_ENV, 'test', `${name} 只允许在 NODE_ENV=test 下使用`);
    assert.equal(path.isAbsolute(value), true, `${name} 必须是绝对路径`);
    return path.resolve(value);
  };
  const runnerPath = testOverride('ELAND_STAGED_MATRIX_RUNNER_FOR_TESTS', defaultRunnerPath);
  const extractorPath = testOverride('ELAND_STAGED_MATRIX_EXTRACTOR_FOR_TESTS', defaultExtractorPath);
  assert.equal(existsSync(runnerPath), true, `runner 不存在: ${runnerPath}`);
  assert.equal(existsSync(extractorPath), true, `extractor 不存在: ${extractorPath}`);
  assert.equal(existsSync(orchestratorSourcePath), true, `orchestrator 不存在: ${orchestratorSourcePath}`);
  return { runnerPath, extractorPath };
}

function testStageBudget() {
  const input = process.env.ELAND_STAGED_MATRIX_MAX_COMPLETED_STAGES_FOR_TESTS;
  if (input === undefined) return null;
  assert.equal(process.env.NODE_ENV, 'test', 'stage budget 只允许在 NODE_ENV=test 下使用');
  const value = Number(input);
  assert.equal(Number.isSafeInteger(value) && value >= 1, true, 'test stage budget 必须是正整数');
  return value;
}

function collectTypeScriptFiles(relativeRoot) {
  const absoluteRoot = path.join(workspace, relativeRoot);
  const collected = [];
  const visit = (absoluteDirectory, relativeDirectory) => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(absoluteDirectory, entry.name);
      const relative = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(relative);
    }
  };
  visit(absoluteRoot, relativeRoot);
  return collected;
}

function makeSourceSeal(dependencies) {
  const sourcePaths = [
    ...collectTypeScriptFiles('src/game/eland'),
    ...collectTypeScriptFiles('server'),
  ].sort((left, right) => left.localeCompare(right));
  assert.equal(sourcePaths.length > 0, true, 'source seal 没有找到 engine/server TypeScript 输入');
  const files = sourcePaths.map((relativePath) => {
    const bytes = readFileSync(path.join(workspace, relativePath));
    return { path: relativePath, sha256: sha256(bytes) };
  });
  const engineContentSha256 = sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join(''));
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(GIT_OBJECT_ID_PATTERN.test(gitHead), true, 'git HEAD 不是完整 commit hash');
  const unsigned = {
    schema: SOURCE_SEAL_SCHEMA,
    gitHead,
    engineSource: {
      roots: ['src/game/eland/**/*.ts', 'server/**/*.ts'],
      fileCount: files.length,
      contentSha256: engineContentSha256,
      files,
    },
    scripts: {
      runner: {
        path: dependencies.runnerPath,
        sha256: sha256(readFileSync(dependencies.runnerPath)),
      },
      extractor: {
        path: dependencies.extractorPath,
        sha256: sha256(readFileSync(dependencies.extractorPath)),
      },
      orchestrator: {
        path: orchestratorSourcePath,
        sha256: sha256(readFileSync(orchestratorSourcePath)),
      },
    },
  };
  return { ...unsigned, fingerprint: sha256(`${SOURCE_SEAL_SCHEMA}\0${canonicalJson(unsigned)}`) };
}

function assertCurrentSourceSeal(expected, dependencies, boundary) {
  const actual = makeSourceSeal(dependencies);
  assert.equal(
    actual.fingerprint,
    expected.fingerprint,
    `${boundary} source seal fingerprint 漂移: expected=${expected.fingerprint} actual=${actual.fingerprint}`,
  );
  assert.deepEqual(actual, expected, `${boundary} source seal 内容漂移`);
}

function runIdFor(prefix, seed) {
  const runId = `${prefix}-seed-${seed}`;
  assert.equal(runId.length <= 64, true, `run id 超过 64 位: ${runId}`);
  return runId;
}

function configurationFor(options) {
  return {
    dataRoot: options.dataRoot,
    evidenceRoot: options.evidenceRoot,
    manifestPath: options.manifestPath,
    prefix: options.prefix,
    seeds: [...options.seeds],
    hotEventLimit: options.hotEventLimit,
    horizons: [...HORIZONS],
    endpointMonth: 12_000,
    stopMode: 'target-month',
    seedConcurrency: 1,
    childConcurrency: 1,
  };
}

function newRun(options, seed) {
  const runId = runIdFor(options.prefix, seed);
  return {
    seed,
    runId,
    dataDirectory: path.join(options.dataRoot, runId),
    lineageId: null,
    authority: null,
    terminal: null,
    stages: HORIZONS.map((horizonMonth) => ({
      horizonMonth,
      state: 'pending',
      phase: 'runner',
      attemptCount: 0,
    })),
  };
}

function ensureFreshDataDirectories(runs) {
  for (const run of runs) {
    if (!existsSync(run.dataDirectory)) continue;
    assert.equal(
      readdirSync(run.dataDirectory).length,
      0,
      `新 manifest 拒绝接入已有 seed data directory: ${run.dataDirectory}`,
    );
  }
}

function writeManifest(options, manifest) {
  manifest.updatedAt = now();
  atomicWriteJson(options.manifestPath, manifest);
}

function validateManifestShape(options, manifest) {
  assert.equal(manifest.schema, SCHEMA, 'manifest schema 无效');
  assert.deepEqual(manifest.configuration, configurationFor(options), 'manifest 配置与本次 CLI 不一致');
  assert.equal(['running', 'completed', 'failed'].includes(manifest.status), true, 'manifest status 无效');
  assert.equal(Array.isArray(manifest.runs), true, 'manifest 缺少 runs');
  assert.equal(manifest.runs.length, options.seeds.length, 'manifest seed 数量失配');
  for (let runIndex = 0; runIndex < manifest.runs.length; runIndex += 1) {
    const run = manifest.runs[runIndex];
    const seed = options.seeds[runIndex];
    const runId = runIdFor(options.prefix, seed);
    assert.equal(run.seed, seed, `manifest run ${runIndex} seed 失配`);
    assert.equal(run.runId, runId, `manifest run ${runIndex} runId 失配`);
    assert.equal(run.dataDirectory, path.join(options.dataRoot, runId), `manifest run ${runIndex} data dir 失配`);
    assert.equal(Array.isArray(run.stages), true, `manifest run ${runId} 缺少 stages`);
    assert.deepEqual(run.stages.map((stage) => stage.horizonMonth), HORIZONS, `${runId} horizons 失配`);
    let sawIncomplete = false;
    for (const stage of run.stages) {
      assert.equal(['pending', 'running', 'completed', 'failed'].includes(stage.state), true, 'stage state 无效');
      assert.equal(['runner', 'extractor', 'done'].includes(stage.phase), true, 'stage phase 无效');
      assert.equal(Number.isSafeInteger(stage.attemptCount) && stage.attemptCount >= 0, true);
      if (stage.state === 'completed') {
        assert.equal(stage.phase, 'done', 'completed stage 必须处于 done phase');
        assert.equal(sawIncomplete, false, `${runId} 不得在未完成 stage 后拼接完成结果`);
      } else {
        sawIncomplete = true;
      }
    }
    if (run.lineageId !== null) {
      assert.equal(typeof run.lineageId === 'string' && run.lineageId.length > 0, true, `${runId} lineage 无效`);
    }
    if (run.authority !== null) {
      assert.equal(run.authority.runId, runId, `${runId} authority runId 失配`);
      assert.equal(run.authority.lineageId, run.lineageId, `${runId} authority lineage 失配`);
    }
    if (run.terminal !== null) {
      assert.equal(Number.isSafeInteger(run.terminal.month), true, `${runId} terminal month 无效`);
      assert.equal(run.terminal.evidence?.month, run.terminal.month, `${runId} terminal pack month 失配`);
      assert.equal(run.terminal.evidence?.runId, runId, `${runId} terminal pack runId 失配`);
    }
  }
}

function loadOrCreateManifest(options, dependencies) {
  const configuration = configurationFor(options);
  if (existsSync(options.manifestPath)) {
    const manifest = readJson(options.manifestPath, 'manifest');
    validateManifestShape(options, manifest);
    assertCurrentSourceSeal(manifest.sourceSeal, dependencies, 'resume');
    assert.notEqual(manifest.status, 'failed', 'manifest 已登记 failed；必须诊断后使用新 prefix/manifest');
    return manifest;
  }
  const runs = options.seeds.map((seed) => newRun(options, seed));
  ensureFreshDataDirectories(runs);
  const manifest = {
    schema: SCHEMA,
    status: 'running',
    createdAt: now(),
    updatedAt: now(),
    configuration,
    sourceSeal: makeSourceSeal(dependencies),
    runs,
  };
  writeManifest(options, manifest);
  return manifest;
}

function parseUniqueJson(stdout, kind) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 1, `${kind} stdout 必须且只能包含一个 JSON 结果，实际 ${lines.length} 行`);
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`${kind} stdout 不是 JSON: ${errorText(error)}`);
  }
  assert.equal(value && typeof value === 'object' && !Array.isArray(value), true, `${kind} 结果必须是对象`);
  return value;
}

async function invokeChild(kind, scriptPath, args) {
  assert.equal(activeChild, null, `拒绝并发 child：${activeChild} 尚未退出`);
  activeChild = kind;
  try {
    const receipt = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: workspace,
        env: process.env,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      let overflow = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES && !overflow) {
          overflow = true;
          child.kill('SIGTERM');
        }
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, overflow }));
    });
    if (receipt.overflow) throw new ChildFailure(kind, `stdout 超过 ${MAX_STDOUT_BYTES} bytes`);
    const result = parseUniqueJson(receipt.stdout, kind);
    if (receipt.code !== 0) {
      throw new ChildFailure(
        kind,
        `exit=${receipt.code ?? 'null'} signal=${receipt.signal ?? 'none'} result=${canonicalJson(result)}`,
      );
    }
    return result;
  } finally {
    activeChild = null;
  }
}

async function invokeSealedChild(kind, scriptPath, args, manifest, dependencies) {
  assertCurrentSourceSeal(manifest.sourceSeal, dependencies, `${kind}:before`);
  let result;
  let childError;
  try {
    result = await invokeChild(kind, scriptPath, args);
  } catch (error) {
    childError = error;
  }
  assertCurrentSourceSeal(manifest.sourceSeal, dependencies, `${kind}:after`);
  if (childError) throw childError;
  return result;
}

function previousCompletedMonth(run, stageIndex) {
  if (stageIndex === 0) return 0;
  const previous = run.stages[stageIndex - 1];
  assert.equal(previous.state, 'completed', `${run.runId} 前序 horizon 尚未完成`);
  if (previous.horizonEvidence.status === 'present') return previous.horizonEvidence.month;
  assert.equal(previous.horizonEvidence.status, 'missing');
  assert.ok(run.terminal, `${run.runId} missing horizon 缺少 terminal`);
  return run.terminal.month;
}

function validateRunnerResult(result, run, stage, previousMonth, resumedAttempt) {
  assert.equal(result.ok, true, 'runner 返回 ok=false');
  assert.equal(result.runId, run.runId, 'runner runId 失配');
  assert.equal(result.seed, run.seed, 'runner seed 失配');
  assert.equal(result.targetMonth, stage.horizonMonth, 'runner targetMonth 失配');
  assert.equal(Number.isSafeInteger(result.hotEventLimit), true, 'runner hotLimit 无效');
  assert.equal(result.hotEventLimit, stage.expectedHotEventLimit, 'runner hotLimit 失配');
  assert.equal(result.stopOnModern, false, '权威 terminal audit 禁止 stop-on-modern');
  assert.equal(typeof result.created, 'boolean', 'runner created 必须是 boolean');
  assert.equal(Number.isSafeInteger(result.startMonth), true, 'runner startMonth 无效');
  assert.equal(Number.isSafeInteger(result.reachedMonth), true, 'runner reachedMonth 无效');
  if (!resumedAttempt) {
    assert.equal(result.created, stage.horizonMonth === HORIZONS[0], 'runner created 与首次 lineage 创建语义失配');
    assert.equal(result.startMonth, previousMonth, 'runner startMonth 没有接续前一 authority');
  } else {
    if (stage.horizonMonth !== HORIZONS[0]) assert.equal(result.created, false, '续跑不得创建第二 lineage');
    if (result.created) assert.equal(result.startMonth, 0, '创建 run 必须从 month 0 开始');
    assert.equal(
      result.startMonth >= previousMonth && result.startMonth <= stage.horizonMonth,
      true,
      'resume startMonth 不在已封存 authority 与 target 之间',
    );
  }
  assert.equal(result.reachedMonth >= result.startMonth, true, 'runner reachedMonth 早于 startMonth');
  const terminalMonth = result.reachedTerminalAtMonth;
  if (terminalMonth === null) {
    assert.equal(result.reachedMonth, stage.horizonMonth, '非终局 runner 必须到达 horizon');
    assert.equal(result.terminalKind, null, '非终局 runner 不得报告 terminalKind');
  } else {
    assert.equal(Number.isSafeInteger(terminalMonth), true, 'terminal month 无效');
    assert.equal(terminalMonth >= previousMonth && terminalMonth <= stage.horizonMonth, true, 'terminal month 越界');
    assert.equal(result.reachedMonth, terminalMonth, '提前终局时 reachedMonth 必须等于 terminal month');
    assert.equal(typeof result.terminalKind === 'string' && result.terminalKind.length > 0, true, 'terminal kind 缺失');
  }
  return {
    ok: true,
    runId: result.runId,
    seed: result.seed,
    created: result.created,
    startMonth: result.startMonth,
    targetMonth: result.targetMonth,
    reachedMonth: result.reachedMonth,
    reachedModernAtMonth: result.reachedModernAtMonth ?? null,
    reachedTerminalAtMonth: terminalMonth,
    terminalKind: result.terminalKind,
    stopOnModern: result.stopOnModern,
    hotEventLimit: result.hotEventLimit,
  };
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function evidenceReference(result, pack) {
  return {
    status: 'present',
    runId: result.runId,
    month: result.month,
    packHash: result.packHash,
    packPath: path.resolve(result.packPath),
    authority: {
      runId: result.authority.runId,
      revision: result.authority.revision,
      month: result.authority.month,
      stateHash: result.authority.stateHash ?? null,
      lineageId: result.authority.lineageId,
      eventCount: result.authority.eventCount ?? null,
      hotEventLimit: result.authority.hotEventLimit,
      status: result.authority.status ?? null,
    },
  };
}

function validateExtractorResult(result, run, expectedMonth, options) {
  assert.equal(result.ok, true, 'extractor 返回 ok=false');
  assert.equal(result.runId, run.runId, 'extractor runId 失配');
  assert.equal(result.month, expectedMonth, 'extractor month 失配');
  assert.equal(result.authority?.runId, run.runId, 'extractor authority runId 失配');
  assert.equal(result.authority?.month, expectedMonth, 'extractor authority month 失配');
  assert.equal(result.authority?.hotEventLimit, options.hotEventLimit, 'extractor authority hotLimit 失配');
  assert.equal(typeof result.authority?.lineageId === 'string' && result.authority.lineageId.length > 0, true, 'extractor lineage 缺失');
  if (run.lineageId !== null) {
    assert.equal(result.authority.lineageId, run.lineageId, '同一 seed 的 authority lineage 发生变化');
  }
  assert.equal(typeof result.packPath === 'string' && path.isAbsolute(result.packPath), true, 'pack path 必须是绝对路径');
  const packPath = path.resolve(result.packPath);
  assert.equal(isWithin(options.evidenceRoot, packPath), true, 'pack path 不在 evidence root 内');
  assert.equal(existsSync(packPath), true, `pack 不存在: ${packPath}`);
  assert.equal(HASH_PATTERN.test(result.packHash), true, 'pack hash 无效');
  const pack = readJson(packPath, 'evidence pack');
  assert.deepEqual(pack.authority, result.authority, 'pack authority 与 extractor result 不一致');
  assert.equal(pack.authority.runId, run.runId, 'pack authority runId 失配');
  assert.equal(pack.authority.month, expectedMonth, 'pack authority month 失配');
  assert.equal(pack.authority.lineageId, result.authority.lineageId, 'pack authority lineage 失配');
  assert.equal(pack.authority.hotEventLimit, options.hotEventLimit, 'pack authority hotLimit 失配');
  assert.equal(pack.integrity?.hash, result.packHash, 'pack integrity hash 与 extractor result 失配');
  return evidenceReference(result, pack);
}

function missingHorizon(run, horizonMonth) {
  assert.ok(run.terminal, `${run.runId} missing horizon 缺少 terminal`);
  assert.equal(run.terminal.month < horizonMonth, true, '只有 terminal-before-horizon 才能登记 missing');
  return {
    status: 'missing',
    reason: 'early-ended',
    disposition: 'terminal-before-horizon',
    requestedMonth: horizonMonth,
    terminalMonth: run.terminal.month,
    terminalEvidence: {
      runId: run.runId,
      month: run.terminal.evidence.month,
      packHash: run.terminal.evidence.packHash,
      packPath: run.terminal.evidence.packPath,
    },
  };
}

function authorityFromEvidence(evidence) {
  return { ...evidence.authority };
}

function serializeFailure(error, phase) {
  return {
    at: now(),
    phase,
    errorName: error instanceof Error ? error.name : 'Error',
    error: errorText(error),
    ...(error instanceof ChildFailure ? { childKind: error.kind, childDetail: error.detail } : {}),
  };
}

function markFailed(options, manifest, stage, error) {
  stage.state = 'failed';
  stage.failure = serializeFailure(error, stage.phase);
  manifest.status = 'failed';
  manifest.failure = {
    at: stage.failure.at,
    runId: stage.runId ?? null,
    horizonMonth: stage.horizonMonth,
    ...stage.failure,
  };
  writeManifest(options, manifest);
}

async function processStage(options, dependencies, manifest, run, stage, stageIndex) {
  assertCurrentSourceSeal(
    manifest.sourceSeal,
    dependencies,
    `${run.runId}:month-${stage.horizonMonth}:stage-before`,
  );
  if (run.terminal !== null && run.terminal.month < stage.horizonMonth) {
    stage.state = 'completed';
    stage.phase = 'done';
    stage.horizonEvidence = missingHorizon(run, stage.horizonMonth);
    stage.completedAt = now();
    writeManifest(options, manifest);
    assertCurrentSourceSeal(
      manifest.sourceSeal,
      dependencies,
      `${run.runId}:month-${stage.horizonMonth}:stage-after`,
    );
    return;
  }

  const previousMonth = previousCompletedMonth(run, stageIndex);
  if (stage.phase === 'runner') {
    const resumedAttempt = stage.state === 'running';
    stage.state = 'running';
    stage.attemptCount += 1;
    stage.runId = run.runId;
    stage.expectedHotEventLimit = options.hotEventLimit;
    stage.startedAt ??= now();
    stage.lastAttemptAt = now();
    writeManifest(options, manifest);
    const runnerResult = await invokeSealedChild(
      'runner',
      dependencies.runnerPath,
      [
        run.dataDirectory,
        run.runId,
        String(run.seed),
        String(stage.horizonMonth),
        String(options.hotEventLimit),
      ],
      manifest,
      dependencies,
    );
    stage.runner = validateRunnerResult(runnerResult, run, stage, previousMonth, resumedAttempt);
    stage.extractionMonth = stage.runner.reachedTerminalAtMonth ?? stage.horizonMonth;
    stage.phase = 'extractor';
    stage.runnerCompletedAt = now();
    writeManifest(options, manifest);
  }

  assert.equal(stage.phase, 'extractor', 'stage 必须在 runner 后进入 extractor');
  assert.equal(Number.isSafeInteger(stage.extractionMonth), true, 'stage extraction month 无效');
  const extractorResult = await invokeSealedChild(
    'extractor',
    dependencies.extractorPath,
    [run.dataDirectory, run.runId, String(stage.extractionMonth), options.evidenceRoot],
    manifest,
    dependencies,
  );
  const evidence = validateExtractorResult(extractorResult, run, stage.extractionMonth, options);
  if (run.lineageId === null) run.lineageId = evidence.authority.lineageId;
  assert.equal(evidence.authority.lineageId, run.lineageId, 'evidence authority 没有接续同一 lineage');
  run.authority = authorityFromEvidence(evidence);

  const terminalMonth = stage.runner.reachedTerminalAtMonth;
  if (terminalMonth === null) {
    assert.equal(evidence.month, stage.horizonMonth, '普通 horizon pack month 失配');
    stage.horizonEvidence = evidence;
  } else {
    assert.equal(evidence.month, terminalMonth, 'terminal pack month 失配');
    const terminal = {
      month: terminalMonth,
      kind: stage.runner.terminalKind,
      evidence,
    };
    if (run.terminal !== null) {
      assert.deepEqual(run.terminal, terminal, '同一 lineage 出现冲突 terminal');
    } else {
      run.terminal = terminal;
    }
    stage.terminalEvidence = evidence;
    if (terminalMonth === stage.horizonMonth) {
      stage.horizonEvidence = evidence;
      stage.terminalEvidenceSameAsHorizon = true;
    } else {
      stage.horizonEvidence = missingHorizon(run, stage.horizonMonth);
    }
  }
  stage.state = 'completed';
  stage.phase = 'done';
  stage.completedAt = now();
  writeManifest(options, manifest);
  assertCurrentSourceSeal(
    manifest.sourceSeal,
    dependencies,
    `${run.runId}:month-${stage.horizonMonth}:stage-after`,
  );
}

function allStagesCompleted(manifest) {
  return manifest.runs.every((run) => run.stages.every((stage) => stage.state === 'completed'));
}

function summary(options, manifest, pausedForTest = false) {
  const stages = manifest.runs.flatMap((run) => run.stages);
  return {
    ok: true,
    schema: SCHEMA,
    manifestPath: options.manifestPath,
    status: manifest.status,
    completed: manifest.status === 'completed',
    pausedForTest,
    completedStageCount: stages.filter((stage) => stage.state === 'completed').length,
    totalStageCount: stages.length,
    missingHorizonCount: stages.filter((stage) => stage.horizonEvidence?.status === 'missing').length,
    runs: manifest.runs.map((run) => ({
      seed: run.seed,
      runId: run.runId,
      lineageId: run.lineageId,
      authorityMonth: run.authority?.month ?? null,
      terminalMonth: run.terminal?.month ?? null,
      terminalKind: run.terminal?.kind ?? null,
      completedStageCount: run.stages.filter((stage) => stage.state === 'completed').length,
    })),
  };
}

async function execute(options, dependencies) {
  mkdirSync(options.dataRoot, { recursive: true });
  mkdirSync(options.evidenceRoot, { recursive: true });
  const manifest = loadOrCreateManifest(options, dependencies);
  if (manifest.status === 'completed') return summary(options, manifest);
  const budget = testStageBudget();
  let completedThisInvocation = 0;
  for (const run of manifest.runs) {
    for (let stageIndex = 0; stageIndex < run.stages.length; stageIndex += 1) {
      const stage = run.stages[stageIndex];
      if (stage.state === 'completed') continue;
      assert.notEqual(stage.state, 'failed', 'failed stage 不得自动重试');
      try {
        await processStage(options, dependencies, manifest, run, stage, stageIndex);
      } catch (error) {
        markFailed(options, manifest, stage, error);
        throw error;
      }
      completedThisInvocation += 1;
      if (budget !== null && completedThisInvocation >= budget) {
        return summary(options, manifest, true);
      }
    }
  }
  assert.equal(allStagesCompleted(manifest), true, 'matrix 遍历结束但仍有未完成 stage');
  manifest.status = 'completed';
  manifest.completedAt = now();
  writeManifest(options, manifest);
  return summary(options, manifest);
}

async function main() {
  const options = parseFlags(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await execute(options, resolveDependencies());
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === orchestratorSourcePath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
