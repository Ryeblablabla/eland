#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3220';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 500;
const GLOBAL_OPTIONS = new Set([
  'base-url',
  'help',
  'output',
  'pretty',
  'request-timeout-ms',
]);
const BOOLEAN_OPTIONS = new Set([
  'all',
  'dispatch',
  'help',
  'include-report',
  'pretty',
  'resume',
  'retry-failed',
  'wait',
]);

const HELP = `ELAND Agent CLI

用法：
  npm run --silent eland -- <command> [subcommand] [arguments] [options]

全局选项：
  --base-url <url>              后端地址，默认 ${DEFAULT_BASE_URL}
  --request-timeout-ms <ms>     单次 HTTP 请求超时，默认 ${DEFAULT_REQUEST_TIMEOUT_MS}
  --output <file>               将 JSON 结果写入文件
  --pretty                      强制格式化 JSON

服务：
  eland doctor

持久化运行：
  eland run list
  eland run create --id <id> --label <label> --seed <seed> --months <n>
  eland run show <id>
  eland run state|export <id>
  eland run replace-state <id> --file <state.json>
  eland run import --file <state.json> [--id <id>] [--label <label>]
  eland run evolve <id> (--months <n> | --to-month <n>) [--wait]
  eland run wait <id> [--include-report]
  eland run path|report <id>

领域检查：
  eland inspect summary <run-id>
  eland inspect person <run-id> <person-id>
  eland inspect project <run-id> <project-id>
  eland inspect events <run-id> [--kind <kind>] [--person-id <id>]
                       [--project-id <id>] [--since-month <n>]
                       [--until-month <n>] [--limit <n> | --all]

实时会话：
  eland session state|history <run-id>
  eland session frame <run-id> --month <n>
  eland session saves <run-id>
  eland session begin <run-id> --creation-id <id> [--world-seed <seed>]
  eland session step <run-id> --body <request.json>
  eland session checkpoint <run-id>
  eland session save <run-id> [--label <label>]
  eland session load <run-id> --save-id <id>
  eland session seek <run-id> --month <n>
  eland session settle|requiem <run-id>
  eland session end <run-id> [--lease-id <id>]

人物：
  eland agent history <run-id> <agent-id> [--month <n>] [--limit <n>]
  eland agent conversation <run-id> <agent-id>
  eland agent say <run-id> <agent-id> --message <text> [--request-kind suggestion]

实验矩阵：
  eland experiment run --prefix <prefix> --seeds <a,b,c> --years <10,20,30>
                       [--concurrency <n>] [--no-wait]
  eland experiment status --prefix <prefix>

非权威叙事增强：
  eland narrative status <run-id>
  eland narrative generate <run-id> [--kinds dialogue,memory,history]
                           [--max-tasks <n>] [--retry-failed] [--no-dispatch]

模型设施：
  eland model settings
  eland model update|endpoint-test|decide --body <request.json>
  eland model endpoint-save --token <tested-token>
  eland model endpoint-delete --id <endpoint-id>

输入 JSON 的选项接受普通路径、@path 或 -（stdin）。
所有成功结果写入 stdout；错误以 JSON 写入 stderr。
`;

class CliError extends Error {
  constructor(message, { exitCode = 2, code = 'CLI_ERROR', details } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

class ApiError extends CliError {
  constructor(status, method, url, body) {
    const message = body && typeof body === 'object' && typeof body.error === 'string'
      ? body.error
      : `HTTP ${status}`;
    super(message, {
      exitCode: status === 404 ? 3 : status === 409 ? 4 : status >= 500 ? 5 : 2,
      code: `HTTP_${status}`,
      details: { status, method, url, body },
    });
    this.status = status;
    this.body = body;
  }
}

function parseArguments(argv) {
  const positionals = [];
  const options = new Map();
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (positionalOnly || !token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    const equalsAt = token.indexOf('=');
    let key = token.slice(2, equalsAt >= 0 ? equalsAt : undefined);
    let value = equalsAt >= 0 ? token.slice(equalsAt + 1) : undefined;
    if (key.startsWith('no-') && equalsAt < 0) {
      key = key.slice(3);
      value = false;
    } else if (value === undefined && BOOLEAN_OPTIONS.has(key)) {
      value = true;
    } else if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError(`选项 --${key} 缺少值`);
      }
      value = next;
      index += 1;
    }
    options.set(key, value);
  }
  return { positionals, options };
}

function option(options, key, fallback) {
  return options.has(key) ? options.get(key) : fallback;
}

function stringOption(options, key, fallback) {
  const value = option(options, key, fallback);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new CliError(`--${key} 必须是非空字符串`);
  return value.trim();
}

function numberOption(options, key, fallback, { integer = false, minimum, maximum } = {}) {
  const raw = option(options, key, fallback);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new CliError(`--${key} 必须是${integer ? '整数' : '数字'}`);
  }
  if (minimum !== undefined && value < minimum) throw new CliError(`--${key} 不得小于 ${minimum}`);
  if (maximum !== undefined && value > maximum) throw new CliError(`--${key} 不得大于 ${maximum}`);
  return value;
}

function booleanOption(options, key, fallback = false) {
  const raw = option(options, key, fallback);
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new CliError(`--${key} 必须是布尔值`);
}

function csvStrings(options, key, { required = false } = {}) {
  const raw = stringOption(options, key);
  if (raw === undefined) {
    if (required) throw new CliError(`缺少 --${key}`);
    return undefined;
  }
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new CliError(`--${key} 不能为空`);
  return values;
}

function csvIntegers(options, key, { required = false, minimum } = {}) {
  const values = csvStrings(options, key, { required });
  if (!values) return undefined;
  return values.map((raw) => {
    const value = Number(raw);
    if (!Number.isInteger(value) || (minimum !== undefined && value < minimum)) {
      throw new CliError(`--${key} 必须是逗号分隔的整数${minimum !== undefined ? `，且不得小于 ${minimum}` : ''}`);
    }
    return value;
  });
}

function ensureAllowedOptions(options, allowed) {
  const valid = new Set([...GLOBAL_OPTIONS, ...allowed]);
  for (const key of options.keys()) {
    if (!valid.has(key)) throw new CliError(`未知选项 --${key}`);
  }
}

function positional(positionals, index, label) {
  const value = positionals[index];
  if (!value) throw new CliError(`缺少${label}`);
  return value;
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonInput(reference, label) {
  if (!reference) throw new CliError(`缺少 ${label}`);
  const path = reference.startsWith('@') ? reference.slice(1) : reference;
  const text = path === '-' ? await stdinText() : await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function createClient(options) {
  const baseUrl = stringOption(options, 'base-url', process.env.ELAND_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
  const timeoutMs = numberOption(options, 'request-timeout-ms', DEFAULT_REQUEST_TIMEOUT_MS, { integer: true, minimum: 1 });
  return {
    baseUrl,
    async request(path, { method = 'GET', body, query } = {}) {
      const url = new URL(`${baseUrl}${path}`);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new CliError(`无法访问 ELAND 后端 ${baseUrl}：${error instanceof Error ? error.message : String(error)}`, {
          exitCode: 5,
          code: 'BACKEND_UNAVAILABLE',
          details: { baseUrl, method, path },
        });
      }
      const text = await response.text();
      let result = null;
      if (text) {
        try {
          result = JSON.parse(text);
        } catch {
          throw new CliError(`后端返回了非 JSON 响应（HTTP ${response.status}）`, {
            exitCode: 5,
            code: 'INVALID_BACKEND_RESPONSE',
            details: { method, url: url.href, body: text.slice(0, 1_000) },
          });
        }
      }
      if (!response.ok) throw new ApiError(response.status, method, url.href, result);
      return result;
    },
  };
}

function runPath(id, suffix = '') {
  return `/api/runs/${encodeURIComponent(id)}${suffix}`;
}

function sessionQuery(runId, extra = {}) {
  return { runId, ...extra };
}

async function optionalEvolutionPath(client, id) {
  try {
    return await client.request(runPath(id, '/evolution'));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function waitForEvolution(client, id, options) {
  const timeoutMs = numberOption(options, 'wait-timeout-ms', DEFAULT_WAIT_TIMEOUT_MS, { integer: true, minimum: 1 });
  const pollMs = numberOption(options, 'poll-ms', DEFAULT_POLL_MS, { integer: true, minimum: 10 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const evolution = await client.request(runPath(id, '/evolution'));
    if (evolution?.status === 'completed') {
      if (!booleanOption(options, 'include-report', false)) return evolution;
      const report = await client.request(runPath(id, '/report'));
      return { evolution, report };
    }
    if (evolution?.status === 'failed') {
      throw new CliError(evolution.failure ?? `运行 ${id} 演化失败`, {
        exitCode: 10,
        code: 'EVOLUTION_FAILED',
        details: evolution,
      });
    }
    if (Date.now() >= deadline) {
      throw new CliError(`等待运行 ${id} 超时，当前已到第 ${evolution?.reachedMonth ?? '?'} 月`, {
        exitCode: 6,
        code: 'WAIT_TIMEOUT',
        details: evolution,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function expectedIdentity(run, path, requestedEndMonth) {
  const label = run?.meta?.label;
  const state = run?.state;
  const conditions = state?.civilization?.conditions;
  if (!label) throw new CliError('绝对月份推进要求运行具有非空 label；请创建带 label 的运行或提供 --expected');
  if (conditions?.endpoint?.kind !== 'months' || conditions.endpoint.value !== requestedEndMonth) {
    throw new CliError(`运行 endpoint 必须是 months:${requestedEndMonth}，实际为 ${JSON.stringify(conditions?.endpoint)}`);
  }
  return {
    label,
    seed: state.seed,
    civilizationNo: state.civilization.number,
    chaosIntensity: conditions.chaosIntensity,
    climateBias: conditions.climateBias,
    endpoint: { kind: 'months', value: requestedEndMonth },
    fromMonth: path?.fromMonth ?? state.clock.elapsedMonths,
  };
}

async function doctor(client) {
  const health = await client.request('/health');
  return { ...health, baseUrl: client.baseUrl };
}

async function runCommand(client, positionals, options) {
  const action = positional(positionals, 1, ' run 子命令');
  if (action === 'list') {
    ensureAllowedOptions(options, []);
    return client.request('/api/runs');
  }
  if (action === 'create') {
    ensureAllowedOptions(options, ['body', 'character-ids', 'chaos-intensity', 'civilization-no', 'climate-bias', 'config', 'id', 'label', 'months', 'seed']);
    const requestBody = options.has('body')
      ? await readJsonInput(stringOption(options, 'body'), '--body')
      : {};
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) throw new CliError('创建请求必须是 JSON 对象');
    const config = options.has('config')
      ? await readJsonInput(stringOption(options, 'config'), '--config')
      : { ...(requestBody.config ?? {}) };
    const id = stringOption(options, 'id');
    const label = stringOption(options, 'label');
    const seed = numberOption(options, 'seed', undefined, { integer: true });
    const months = numberOption(options, 'months', undefined, { integer: true, minimum: 1 });
    const civilizationNo = numberOption(options, 'civilization-no', undefined, { integer: true, minimum: 1 });
    const chaosIntensity = numberOption(options, 'chaos-intensity', undefined, { integer: true, minimum: 0, maximum: 10 });
    const climateBias = stringOption(options, 'climate-bias');
    if (climateBias && !['balanced', 'cold', 'hot'].includes(climateBias)) throw new CliError('--climate-bias 必须是 balanced、cold 或 hot');
    const characterIds = csvStrings(options, 'character-ids');
    if (id) requestBody.id = id;
    if (label) requestBody.label = label;
    if (seed !== undefined) requestBody.seed = seed;
    if (months !== undefined) config.endpoint = { kind: 'months', value: months };
    if (civilizationNo !== undefined) config.civilizationNo = civilizationNo;
    if (chaosIntensity !== undefined) config.chaosIntensity = chaosIntensity;
    if (climateBias) config.climateBias = climateBias;
    if (characterIds) config.characterIds = characterIds;
    if (Object.keys(config).length) requestBody.config = config;
    return client.request('/api/runs', { method: 'POST', body: requestBody });
  }
  if (action === 'import') {
    ensureAllowedOptions(options, ['file', 'id', 'label']);
    const requestBody = await readJsonInput(stringOption(options, 'file'), '--file');
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) throw new CliError('导入文件必须是 JSON 对象');
    const id = stringOption(options, 'id');
    const label = stringOption(options, 'label');
    if (id) requestBody.id = id;
    if (label) requestBody.label = label;
    return client.request('/api/runs/import', { method: 'POST', body: requestBody });
  }

  const id = positional(positionals, 2, ' run ID');
  if (action === 'show') {
    ensureAllowedOptions(options, []);
    const run = await client.request(runPath(id));
    return { meta: run.meta };
  }
  if (action === 'state' || action === 'export') {
    ensureAllowedOptions(options, []);
    return client.request(runPath(id, '/state'));
  }
  if (action === 'replace-state') {
    ensureAllowedOptions(options, ['file']);
    const state = await readJsonInput(stringOption(options, 'file'), '--file');
    return client.request(runPath(id, '/state'), { method: 'PUT', body: state });
  }
  if (action === 'path') {
    ensureAllowedOptions(options, []);
    return client.request(runPath(id, '/evolution'));
  }
  if (action === 'report') {
    ensureAllowedOptions(options, []);
    return client.request(runPath(id, '/report'));
  }
  if (action === 'wait') {
    ensureAllowedOptions(options, ['include-report', 'poll-ms', 'wait-timeout-ms']);
    return waitForEvolution(client, id, options);
  }
  if (action === 'evolve') {
    ensureAllowedOptions(options, ['expected', 'include-report', 'months', 'poll-ms', 'to-month', 'wait', 'wait-timeout-ms']);
    const months = numberOption(options, 'months', undefined, { integer: true, minimum: 1 });
    const requestedEndMonth = numberOption(options, 'to-month', undefined, { integer: true, minimum: 1 });
    if ((months === undefined) === (requestedEndMonth === undefined)) {
      throw new CliError('run evolve 必须且只能提供 --months 或 --to-month');
    }
    let body;
    if (months !== undefined) {
      body = { months };
    } else {
      const expected = options.has('expected')
        ? await readJsonInput(stringOption(options, 'expected'), '--expected')
        : expectedIdentity(
          await client.request(runPath(id)),
          await optionalEvolutionPath(client, id),
          requestedEndMonth,
        );
      body = { requestedEndMonth, expected };
    }
    const evolution = await client.request(runPath(id, '/evolve'), { method: 'POST', body });
    return booleanOption(options, 'wait', false) ? waitForEvolution(client, id, options) : evolution;
  }
  throw new CliError(`未知 run 子命令：${action}`);
}

function eventMentions(event, id) {
  const visit = (value) => {
    if (value === id) return true;
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === 'object') return Object.values(value).some(visit);
    return false;
  };
  return visit(event);
}

function projectEventIds(project) {
  const ids = new Set([
    ...(project.triggerFactIds ?? []),
    ...(project.actionEventIds ?? []),
    ...(project.failureEventIds ?? []),
    ...(project.completionEventIds ?? []),
    ...(project.progressEvidence ?? []).map((item) => item.eventId),
  ]);
  return ids;
}

function stateSummary(run) {
  const state = run.state;
  const living = state.people.filter((person) => person.diedAtMonth === undefined && person.body?.health > 0).length;
  const projectStatuses = Object.create(null);
  for (const project of state.projects) projectStatuses[project.status] = (projectStatuses[project.status] ?? 0) + 1;
  return {
    meta: run.meta,
    seed: state.seed,
    branchId: state.branchId,
    elapsedMonths: state.clock.elapsedMonths,
    civilization: state.civilization,
    population: { living, total: state.people.length },
    projects: { total: state.projects.length, byStatus: projectStatuses },
    events: { total: state.world.past.length, lastStep: state.lastStep.length },
    derived: {
      practices: state.derived.practices.length,
      institutions: state.derived.institutions.length,
      milestones: state.derived.milestones,
      structures: state.derived.structures.length,
    },
  };
}

async function inspectCommand(client, positionals, options) {
  const kind = positional(positionals, 1, ' inspect 子命令');
  const runId = positional(positionals, 2, ' run ID');
  const run = await client.request(runPath(runId));
  const state = run.state;
  if (kind === 'summary') {
    ensureAllowedOptions(options, []);
    return stateSummary(run);
  }
  if (kind === 'person') {
    ensureAllowedOptions(options, []);
    const personId = positional(positionals, 3, ' person ID');
    const person = state.people.find((candidate) => candidate.id === personId);
    if (!person) throw new CliError(`运行 ${runId} 中没有人物 ${personId}`, { exitCode: 3, code: 'PERSON_NOT_FOUND' });
    return {
      runId,
      atMonth: state.clock.elapsedMonths,
      person,
      activeIntent: state.intents.find((intent) => intent.id === person.activeIntentId) ?? null,
      ownedProjects: state.projects.filter((project) => project.ownerId === personId),
      recentEvents: state.world.past.filter((event) => eventMentions(event, personId)).slice(-100),
    };
  }
  if (kind === 'project') {
    ensureAllowedOptions(options, []);
    const projectId = positional(positionals, 3, ' project ID');
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new CliError(`运行 ${runId} 中没有项目 ${projectId}`, { exitCode: 3, code: 'PROJECT_NOT_FOUND' });
    const eventIds = projectEventIds(project);
    return {
      runId,
      atMonth: state.clock.elapsedMonths,
      project,
      events: state.world.past.filter((event) => eventIds.has(event.id)),
    };
  }
  if (kind === 'events') {
    ensureAllowedOptions(options, ['all', 'kind', 'limit', 'person-id', 'project-id', 'since-month', 'until-month']);
    const eventKind = stringOption(options, 'kind');
    const personId = stringOption(options, 'person-id');
    const projectId = stringOption(options, 'project-id');
    const sinceMonth = numberOption(options, 'since-month', undefined, { integer: true, minimum: 0 });
    const untilMonth = numberOption(options, 'until-month', undefined, { integer: true, minimum: 0 });
    const limit = numberOption(options, 'limit', 100, { integer: true, minimum: 1 });
    let allowedEventIds;
    if (projectId) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new CliError(`运行 ${runId} 中没有项目 ${projectId}`, { exitCode: 3, code: 'PROJECT_NOT_FOUND' });
      allowedEventIds = projectEventIds(project);
    }
    const matches = state.world.past.filter((event) => (!eventKind || event.kind === eventKind)
      && (!personId || eventMentions(event, personId))
      && (!allowedEventIds || allowedEventIds.has(event.id))
      && (sinceMonth === undefined || event.atMonth >= sinceMonth)
      && (untilMonth === undefined || event.atMonth <= untilMonth));
    const events = booleanOption(options, 'all', false) ? matches : matches.slice(-limit);
    return { runId, total: matches.length, returned: events.length, events };
  }
  throw new CliError(`未知 inspect 子命令：${kind}`);
}

async function sessionCommand(client, positionals, options) {
  const action = positional(positionals, 1, ' session 子命令');
  const runId = positional(positionals, 2, ' run ID');
  if (action === 'state' || action === 'history' || action === 'saves') {
    ensureAllowedOptions(options, []);
    return client.request(`/api/eland/${action}`, { query: sessionQuery(runId) });
  }
  if (action === 'frame') {
    ensureAllowedOptions(options, ['month']);
    const month = numberOption(options, 'month', undefined, { integer: true, minimum: 0 });
    if (month === undefined) throw new CliError('session frame 缺少 --month');
    return client.request('/api/eland/frame', { query: sessionQuery(runId, { month }) });
  }
  if (action === 'begin') {
    ensureAllowedOptions(options, ['body', 'character-ids', 'creation-id', 'lease-id', 'world-seed']);
    const body = options.has('body') ? await readJsonInput(stringOption(options, 'body'), '--body') : {};
    body.runId = runId;
    body.creationId = stringOption(options, 'creation-id', body.creationId);
    if (!body.creationId) throw new CliError('session begin 缺少 --creation-id');
    const worldSeed = numberOption(options, 'world-seed', undefined, { integer: true, minimum: 1, maximum: 0xffff_ffff });
    const characterIds = csvStrings(options, 'character-ids');
    const leaseId = stringOption(options, 'lease-id');
    if (worldSeed !== undefined) body.worldSeed = worldSeed;
    if (characterIds) body.characterIds = characterIds;
    if (leaseId) body.leaseId = leaseId;
    return client.request('/api/eland/begin', { method: 'POST', body });
  }
  if (action === 'step') {
    ensureAllowedOptions(options, ['body']);
    const body = await readJsonInput(stringOption(options, 'body'), '--body');
    body.runId = runId;
    return client.request('/api/eland/step', { method: 'POST', body });
  }
  if (action === 'checkpoint') {
    ensureAllowedOptions(options, []);
    return client.request('/api/eland/checkpoint', { method: 'POST', body: { runId } });
  }
  if (action === 'save') {
    ensureAllowedOptions(options, ['label']);
    return client.request('/api/eland/save', { method: 'POST', body: { runId, label: stringOption(options, 'label') } });
  }
  if (action === 'load') {
    ensureAllowedOptions(options, ['lease-id', 'save-id']);
    const saveId = stringOption(options, 'save-id');
    if (!saveId) throw new CliError('session load 缺少 --save-id');
    return client.request('/api/eland/load', { method: 'POST', body: { runId, saveId, leaseId: stringOption(options, 'lease-id') } });
  }
  if (action === 'seek') {
    ensureAllowedOptions(options, ['month']);
    const month = numberOption(options, 'month', undefined, { integer: true, minimum: 0 });
    if (month === undefined) throw new CliError('session seek 缺少 --month');
    return client.request('/api/eland/seek', { method: 'POST', body: { runId, month } });
  }
  if (action === 'settle' || action === 'requiem') {
    ensureAllowedOptions(options, []);
    const state = await client.request('/api/eland/state', { query: sessionQuery(runId) });
    const frame = state?.frame;
    if (!frame) throw new CliError(`实时会话 ${runId} 没有权威帧`, { exitCode: 4, code: 'SESSION_HAS_NO_FRAME' });
    const body = action === 'settle'
      ? {
          runId,
          expectedCivilizationId: frame.civilizationId,
          expectedBranchId: frame.branchId,
          expectedElapsedMonths: frame.elapsedMonths,
        }
      : {
          runId,
          expectedCivilizationId: frame.civilizationId,
          expectedBranchId: frame.branchId,
          expectedEndedAtMonth: frame.elapsedMonths,
        };
    return client.request(`/api/eland/${action === 'settle' ? 'settle-civilization' : 'civilization-requiem'}`, {
      method: 'POST',
      body,
    });
  }
  if (action === 'end') {
    ensureAllowedOptions(options, ['lease-id']);
    return client.request('/api/eland/end', { method: 'POST', body: { runId, leaseId: stringOption(options, 'lease-id') } });
  }
  throw new CliError(`未知 session 子命令：${action}`);
}

async function agentCommand(client, positionals, options) {
  const action = positional(positionals, 1, ' agent 子命令');
  const runId = positional(positionals, 2, ' run ID');
  const agentId = positional(positionals, 3, ' agent ID');
  if (action === 'history') {
    ensureAllowedOptions(options, ['limit', 'month']);
    return client.request('/api/eland/agent-history', {
      query: sessionQuery(runId, {
        agentId,
        month: numberOption(options, 'month', undefined, { integer: true, minimum: 0 }),
        limit: numberOption(options, 'limit', undefined, { integer: true, minimum: 1 }),
      }),
    });
  }
  if (action === 'conversation') {
    ensureAllowedOptions(options, []);
    return client.request('/api/eland/agent-conversation', { query: sessionQuery(runId, { agentId }) });
  }
  if (action === 'say') {
    ensureAllowedOptions(options, ['client-message-id', 'message', 'observed-branch-id', 'request-kind']);
    const message = stringOption(options, 'message');
    if (!message) throw new CliError('agent say 缺少 --message');
    const requestKind = stringOption(options, 'request-kind', 'conversation');
    if (!['conversation', 'suggestion'].includes(requestKind)) throw new CliError('--request-kind 必须是 conversation 或 suggestion');
    return client.request('/api/eland/agent-conversation', {
      method: 'POST',
      body: {
        runId,
        agentId,
        message,
        requestKind,
        clientMessageId: stringOption(options, 'client-message-id', `cli-${randomUUID()}`),
        observedBranchId: stringOption(options, 'observed-branch-id'),
      },
    });
  }
  throw new CliError(`未知 agent 子命令：${action}`);
}

function matrixRunId(prefix, seed, years) {
  const id = `${prefix}-s${seed}-y${years}`.replace(/[^a-zA-Z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!id || id.length > 64) throw new CliError(`实验 run ID 无效或超过 64 字符：${id}`);
  return id;
}

async function mapLimit(values, concurrency, task) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function experimentCase(client, spec, options, wait) {
  const id = matrixRunId(spec.prefix, spec.seed, spec.years);
  const label = id;
  const endpoint = { kind: 'months', value: spec.months };
  let created = false;
  try {
    await client.request('/api/runs', {
      method: 'POST',
      body: {
        id,
        label,
        seed: spec.seed,
        config: {
          civilizationNo: spec.civilizationNo,
          chaosIntensity: spec.chaosIntensity,
          climateBias: spec.climateBias,
          endpoint,
        },
      },
    });
    created = true;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409 && spec.resume)) throw error;
  }
  const evolution = await client.request(runPath(id, '/evolve'), {
    method: 'POST',
    body: {
      requestedEndMonth: spec.months,
      expected: {
        label,
        seed: spec.seed,
        civilizationNo: spec.civilizationNo,
        chaosIntensity: spec.chaosIntensity,
        climateBias: spec.climateBias,
        endpoint,
        fromMonth: 0,
      },
    },
  });
  const terminal = wait ? await waitForEvolution(client, id, options) : evolution;
  return { id, seed: spec.seed, years: spec.years, months: spec.months, created, evolution: terminal };
}

async function experimentCommand(client, positionals, options) {
  const action = positional(positionals, 1, ' experiment 子命令');
  if (action === 'status') {
    ensureAllowedOptions(options, ['prefix']);
    const prefix = stringOption(options, 'prefix');
    if (!prefix) throw new CliError('experiment status 缺少 --prefix');
    const listed = await client.request('/api/runs');
    const runs = listed.runs.filter((run) => run.id.startsWith(prefix));
    const entries = await mapLimit(runs, 4, async (run) => ({
      run,
      evolution: await optionalEvolutionPath(client, run.id),
    }));
    return { prefix, count: entries.length, runs: entries };
  }
  if (action !== 'run') throw new CliError(`未知 experiment 子命令：${action}`);
  ensureAllowedOptions(options, [
    'chaos-intensity', 'civilization-no', 'climate-bias', 'concurrency', 'include-report',
    'poll-ms', 'prefix', 'resume', 'seeds', 'wait', 'wait-timeout-ms', 'years',
  ]);
  const prefix = stringOption(options, 'prefix');
  if (!prefix) throw new CliError('experiment run 缺少 --prefix');
  const seeds = csvIntegers(options, 'seeds', { required: true });
  const years = csvIntegers(options, 'years', { required: true, minimum: 1 });
  const civilizationNo = numberOption(options, 'civilization-no', 1, { integer: true, minimum: 1 });
  const chaosIntensity = numberOption(options, 'chaos-intensity', 0, { integer: true, minimum: 0, maximum: 10 });
  const climateBias = stringOption(options, 'climate-bias', 'balanced');
  if (!['balanced', 'cold', 'hot'].includes(climateBias)) throw new CliError('--climate-bias 必须是 balanced、cold 或 hot');
  const concurrency = numberOption(options, 'concurrency', 1, { integer: true, minimum: 1, maximum: 8 });
  const wait = booleanOption(options, 'wait', true);
  const resume = booleanOption(options, 'resume', true);
  const cases = years.flatMap((year) => seeds.map((seed) => ({
    prefix,
    seed,
    years: year,
    months: year * 12,
    civilizationNo,
    chaosIntensity,
    climateBias,
    resume,
  })));
  const startedAt = new Date().toISOString();
  const results = await mapLimit(cases, concurrency, async (spec) => {
    try {
      return { ok: true, ...(await experimentCase(client, spec, options, wait)) };
    } catch (error) {
      return {
        ok: false,
        id: matrixRunId(spec.prefix, spec.seed, spec.years),
        seed: spec.seed,
        years: spec.years,
        error: errorPayload(error).error,
      };
    }
  });
  if (results.some((result) => !result.ok)) process.exitCode = 10;
  return {
    schemaVersion: 1,
    prefix,
    startedAt,
    finishedAt: new Date().toISOString(),
    wait,
    concurrency,
    matrix: { seeds, years, civilizationNo, chaosIntensity, climateBias },
    cases: results,
  };
}

async function narrativeCommand(client, positionals, options) {
  const action = positional(positionals, 1, ' narrative 子命令');
  const runId = positional(positionals, 2, ' run ID');
  if (action === 'status') {
    ensureAllowedOptions(options, []);
    return client.request(runPath(runId, '/enhancements'));
  }
  if (action === 'generate') {
    ensureAllowedOptions(options, ['dispatch', 'kinds', 'max-tasks', 'retry-failed']);
    const kinds = csvStrings(options, 'kinds');
    if (kinds && kinds.some((kind) => !['dialogue', 'memory', 'history'].includes(kind))) {
      throw new CliError('--kinds 只能包含 dialogue、memory、history');
    }
    return client.request(runPath(runId, '/enhancements'), {
      method: 'POST',
      body: {
        ...(kinds ? { kinds } : {}),
        maxTasks: numberOption(options, 'max-tasks', 6, { integer: true, minimum: 0, maximum: 24 }),
        retryFailed: booleanOption(options, 'retry-failed', false),
        dispatch: booleanOption(options, 'dispatch', true),
      },
    });
  }
  throw new CliError(`未知 narrative 子命令：${action}`);
}

async function modelCommand(client, positionals, options) {
  const action = positional(positionals, 1, ' model 子命令');
  if (action === 'settings') {
    ensureAllowedOptions(options, []);
    return client.request('/api/model-settings');
  }
  if (action === 'update' || action === 'endpoint-test' || action === 'decide') {
    ensureAllowedOptions(options, ['body']);
    const body = await readJsonInput(stringOption(options, 'body'), '--body');
    if (action === 'update') return client.request('/api/model-settings', { method: 'PUT', body });
    if (action === 'endpoint-test') return client.request('/api/model-settings/endpoints/test', { method: 'POST', body });
    return client.request('/api/decide', { method: 'POST', body });
  }
  if (action === 'endpoint-save') {
    ensureAllowedOptions(options, ['token']);
    const token = stringOption(options, 'token');
    if (!token) throw new CliError('model endpoint-save 缺少 --token');
    return client.request('/api/model-settings/endpoints', { method: 'PUT', body: { token } });
  }
  if (action === 'endpoint-delete') {
    ensureAllowedOptions(options, ['id']);
    const id = stringOption(options, 'id');
    if (!id) throw new CliError('model endpoint-delete 缺少 --id');
    return client.request('/api/model-settings/endpoints', { method: 'DELETE', body: { id } });
  }
  throw new CliError(`未知 model 子命令：${action}`);
}

async function dispatch(parsed) {
  const { positionals, options } = parsed;
  if (booleanOption(options, 'help', false) || !positionals.length || positionals[0] === 'help') {
    process.stdout.write(HELP);
    return undefined;
  }
  const client = createClient(options);
  const command = positionals[0];
  if (command === 'doctor') {
    ensureAllowedOptions(options, []);
    return doctor(client);
  }
  if (command === 'run') return runCommand(client, positionals, options);
  if (command === 'inspect') return inspectCommand(client, positionals, options);
  if (command === 'session') return sessionCommand(client, positionals, options);
  if (command === 'agent') return agentCommand(client, positionals, options);
  if (command === 'experiment') return experimentCommand(client, positionals, options);
  if (command === 'narrative') return narrativeCommand(client, positionals, options);
  if (command === 'model') return modelCommand(client, positionals, options);
  throw new CliError(`未知命令：${command}`);
}

function jsonText(value, pretty) {
  return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
}

async function writeResult(value, options) {
  const pretty = booleanOption(options, 'pretty', process.stdout.isTTY);
  const text = jsonText(value, pretty);
  const output = stringOption(options, 'output');
  if (output) await writeFile(output, text, 'utf8');
  else process.stdout.write(text);
}

function errorPayload(error) {
  const known = error instanceof CliError;
  return {
    ok: false,
    error: {
      code: known ? error.code : 'UNEXPECTED_ERROR',
      message: error instanceof Error ? error.message : String(error),
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  };
}

const parsed = parseArguments(process.argv.slice(2));
try {
  const result = await dispatch(parsed);
  if (result !== undefined) await writeResult(result, parsed.options);
} catch (error) {
  process.stderr.write(jsonText(errorPayload(error), true));
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
}
