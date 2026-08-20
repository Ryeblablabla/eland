import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
  createDefaultSimulationConfig,
  createSimulation,
  type SimulationConfig,
  type SimulationState,
} from "../src/game/eland/simulation";
import { handleDecide } from "./model-decision-gateway";
import {
  EVOLUTION_MODES,
  MODEL_PURPOSES,
  modelEndpointStatus,
  readModelSettings,
  updateModelSettings,
  type EvolutionMode,
  type ModelPurpose,
} from './model-config';
import { buildEvolutionFactsReport, checkpointFor, evolvePath, type EvolutionPath } from './evolution-artifacts';
import {
  assertEvolutionIdentity,
  evolutionExpectedBasisKey,
  EvolutionIdentityConflictError,
  EvolutionRequestValidationError,
  parseEvolutionRunRequest,
  type EvolutionRunRequest,
} from './evolution-request';
import { ElandWorkerClient } from './eland-worker-client';
import { NarrativeEnhancementService } from './narrative-enhancement-service';
import {
  NARRATIVE_ENHANCEMENT_KINDS,
  narrativeEnhancementCounts,
  type NarrativeEnhancementKind,
} from './narrative-enhancements';
import {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
  type PersistedRun,
} from "./run-persistence";
import { SqliteRunStore } from './sqlite-run-store';
import { logPerf, perfElapsed, perfNow } from './perf';

const HOST = process.env.THREEBODY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.THREEBODY_PORT ?? 3220);
const DATA_DIR = path.resolve(process.env.THREEBODY_DATA_DIR ?? path.join(process.cwd(), "data"));
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const RULE_PLANNER_MODEL = 'rule-planner-v1';

const store = new SqliteRunStore(DATA_DIR);
const narrativeEnhancements = new NarrativeEnhancementService(store);
const elandWorker = new ElandWorkerClient();
const runQueues = new Map<string, Promise<unknown>>();
interface EvolutionJob {
  token: symbol;
  requestedEndMonth?: number;
  ensureBasisKey?: string;
  ready: Promise<EvolutionPath>;
  promise?: Promise<void>;
}
const evolutionJobs = new Map<string, EvolutionJob>();

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", process.env.THREEBODY_CORS_ORIGIN ?? "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("cache-control", "no-store");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function sendEncodedJson(response: ServerResponse, status: number, body: ArrayBuffer): void {
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(Buffer.from(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "请求体超过 50MB");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function stateFrom(value: unknown): SimulationState {
  const object = asObject(value);
  const candidate = object.state ?? object.finalState ?? (object.run as Record<string, unknown> | undefined)?.state ?? value;
  if (!candidate || typeof candidate !== "object" || !Array.isArray((candidate as SimulationState).people) || !(candidate as SimulationState).world) {
    throw new HttpError(400, "没有找到可导入的 SimulationState");
  }
  try {
    return createSimulation({ state: candidate as SimulationState }).getState();
  } catch (error) {
    throw new HttpError(400, `状态导入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function responseRun(run: PersistedRun, includeState = true): unknown {
  return includeState ? run : { meta: run.meta };
}

function narrativeKinds(value: unknown): NarrativeEnhancementKind[] {
  if (value === undefined) return [...NARRATIVE_ENHANCEMENT_KINDS];
  if (!Array.isArray(value)) throw new HttpError(400, 'kinds 必须是 dialogue、memory、history 的数组');
  const allowed = new Set<string>(NARRATIVE_ENHANCEMENT_KINDS);
  const kinds = [...new Set(value.filter((kind): kind is NarrativeEnhancementKind => typeof kind === 'string' && allowed.has(kind)))];
  if (!kinds.length || kinds.length !== value.length) throw new HttpError(400, 'kinds 只能包含 dialogue、memory、history');
  return kinds;
}

function enhancementTaskLimit(value: unknown): number {
  const number = Number(value ?? 6);
  if (!Number.isInteger(number) || number < 0 || number > 24) throw new HttpError(400, 'maxTasks 必须是 0-24 的整数');
  return number;
}

function modelRoutes(value: unknown): Record<ModelPurpose, string> {
  const input = asObject(value);
  return Object.fromEntries(MODEL_PURPOSES.map((purpose) => {
    const endpointId = input[purpose];
    if (typeof endpointId !== 'string' || !endpointId.trim()) {
      throw new HttpError(400, `routes.${purpose} 必须是模型端点 ID`);
    }
    return [purpose, endpointId.trim()];
  })) as Record<ModelPurpose, string>;
}

function modelUseMode(value: unknown, field: 'evolutionMode' | 'summaryMode'): EvolutionMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !EVOLUTION_MODES.includes(value as EvolutionMode)) {
    throw new HttpError(400, `${field} 必须是 local 或 model`);
  }
  return value as EvolutionMode;
}

async function serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = runQueues.get(id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  runQueues.set(id, current);
  try {
    return await current;
  } finally {
    if (runQueues.get(id) === current) runQueues.delete(id);
  }
}

async function createRun(bodyValue: unknown, imported: boolean): Promise<PersistedRun> {
  const body = asObject(bodyValue);
  let state: SimulationState;
  if (imported || body.state || body.finalState || body.run) {
    state = stateFrom(body);
  } else {
    const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : 17;
    const config = createDefaultSimulationConfig((body.config ?? {}) as Partial<SimulationConfig>);
    state = createSimulation({ seed, config }).getState();
  }
  return store.create({
    id: typeof body.id === "string" ? body.id : undefined,
    label: typeof body.label === "string" ? body.label : undefined,
    state,
  });
}

async function completeEvolution(
  id: string,
  state: SimulationState,
  previous: EvolutionPath,
  requestedEndMonth: number,
): Promise<EvolutionPath> {
  const running = evolvePath(state, {
    runId: id,
    provider: 'local',
    model: previous.model,
    fromMonth: previous.fromMonth,
    requestedEndMonth,
    previous,
    checkpoint: checkpointFor(state, {
      inputTokens: previous.checkpoints.at(-1)?.inputTokens ?? 0,
      outputTokens: previous.checkpoints.at(-1)?.outputTokens ?? 0,
    }, previous.checkpoints.at(-1)),
    status: 'running',
  });
  const report = buildEvolutionFactsReport(state, running);
  await store.saveEvolutionReport(id, report);
  const completed = evolvePath(state, {
    runId: id,
    provider: 'local',
    model: running.model,
    fromMonth: running.fromMonth,
    requestedEndMonth,
    previous: running,
    status: 'completed',
  });
  await store.saveEvolutionPath(id, completed);
  return completed;
}

async function executeLongEvolution(id: string, requestedEndMonth: number, initialPath: EvolutionPath): Promise<void> {
  const current = await store.load(id);
  const controller = createSimulation({ state: current.state });
  let persisted = current.state;
  let path = initialPath;
  const inputTokens = path.checkpoints.at(-1)?.inputTokens ?? 0;
  const outputTokens = path.checkpoints.at(-1)?.outputTokens ?? 0;
  try {
    while (persisted.clock.elapsedMonths < requestedEndMonth && persisted.civilization.status === 'running') {
      const batchMonths = Math.min(12, requestedEndMonth - persisted.clock.elapsedMonths);
      const batchStartedAt = perfNow();
      const simulationStartedAt = perfNow();
      const state = controller.step(batchMonths);
      const simulationMs = perfElapsed(simulationStartedAt);
      if (state.clock.elapsedMonths <= persisted.clock.elapsedMonths && state.civilization.status === 'running') {
        throw new Error(`演化未向前推进：仍在第 ${state.clock.elapsedMonths} 月`);
      }
      persisted = state;
      const persistenceStartedAt = perfNow();
      persisted = (await store.save(id, persisted, undefined, { historyMode: 'append' })).state;
      path = evolvePath(persisted, {
        runId: id,
        provider: 'local',
        model: RULE_PLANNER_MODEL,
        fromMonth: initialPath.fromMonth,
        requestedEndMonth,
        previous: path,
        checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }, path.checkpoints.at(-1)),
        status: 'running',
      });
      await store.saveEvolutionPath(id, path);
      logPerf('long-evolution-batch', {
        runId: id,
        throughMonth: persisted.clock.elapsedMonths,
        batchMonths,
        people: persisted.people.length,
        totalEvents: persisted.world.past.length,
        simulationMs,
        persistenceMs: perfElapsed(persistenceStartedAt),
        totalMs: perfElapsed(batchStartedAt),
      });
    }
    await completeEvolution(id, persisted, path, requestedEndMonth);
  } catch (error) {
    persisted = (await store.save(id, persisted, undefined, { historyMode: 'append' })).state;
    path = evolvePath(persisted, {
      runId: id,
      provider: 'local',
      model: path.model,
      fromMonth: initialPath.fromMonth,
      requestedEndMonth,
      previous: path,
      checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }, path.checkpoints.at(-1)),
      status: 'failed',
      failure: error instanceof Error ? error.message : String(error),
    });
    await store.saveEvolutionPath(id, path);
  }
}

function releaseEvolutionJob(id: string, job: EvolutionJob): void {
  if (evolutionJobs.get(id)?.token === job.token) evolutionJobs.delete(id);
}

function observeEvolutionJob(id: string, job: EvolutionJob, promise: Promise<void>): void {
  void promise.then(
    () => releaseEvolutionJob(id, job),
    (error) => {
      releaseEvolutionJob(id, job);
      console.error(`运行 ${id} 的后台演化任务异常`, error);
    },
  );
}

async function initializeEvolutionJob(
  id: string,
  request: EvolutionRunRequest,
  job: EvolutionJob,
): Promise<EvolutionPath> {
  return serialized(id, async () => {
    const current = await store.load(id);
    const previous = await store.loadEvolutionPath(id);
    const requestedEndMonth = request.kind === 'ensure-through'
      ? request.requestedEndMonth
      : current.state.clock.elapsedMonths + request.months;
    job.requestedEndMonth = requestedEndMonth;
    if (request.kind === 'ensure-through') assertEvolutionIdentity(current, previous, request);
    else if (current.state.civilization.status === 'ended') throw new HttpError(409, `运行 ${id} 已经结束`);

    if (request.kind === 'ensure-through' && previous?.status === 'failed') {
      releaseEvolutionJob(id, job);
      return previous;
    }

    if (request.kind === 'ensure-through'
      && previous?.status === 'completed'
      && (current.state.civilization.status === 'ended' || current.state.clock.elapsedMonths >= requestedEndMonth)) {
      releaseEvolutionJob(id, job);
      return previous;
    }

    const fromMonth = previous?.fromMonth
      ?? (request.kind === 'ensure-through' ? request.expected.fromMonth : current.state.clock.elapsedMonths);
    const initial = evolvePath(current.state, {
      runId: id,
      provider: 'local',
      model: previous?.model ?? RULE_PLANNER_MODEL,
      fromMonth,
      requestedEndMonth,
      ...(previous ? { previous } : {}),
      checkpoint: checkpointFor(current.state, {
        inputTokens: previous?.checkpoints.at(-1)?.inputTokens ?? 0,
        outputTokens: previous?.checkpoints.at(-1)?.outputTokens ?? 0,
      }, previous?.checkpoints.at(-1)),
      status: 'running',
    });
    await store.saveEvolutionPath(id, initial);

    if (current.state.civilization.status === 'ended' || current.state.clock.elapsedMonths >= requestedEndMonth) {
      const completed = await completeEvolution(id, current.state, initial, requestedEndMonth);
      releaseEvolutionJob(id, job);
      return completed;
    }

    const promise = serialized(id, () => executeLongEvolution(id, requestedEndMonth, initial)).then(() => undefined);
    job.promise = promise;
    observeEvolutionJob(id, job, promise);
    return initial;
  });
}

async function acknowledgeActiveEvolution(
  id: string,
  request: EvolutionRunRequest,
  active: EvolutionJob,
): Promise<EvolutionPath> {
  if (request.kind === 'legacy') throw new HttpError(409, `运行 ${id} 正在演化`);
  if (active.requestedEndMonth !== request.requestedEndMonth) {
    throw new HttpError(409, `运行 ${id} 正在演化到第 ${active.requestedEndMonth ?? '?'} 月`);
  }
  if (active.ensureBasisKey !== evolutionExpectedBasisKey(request.expected)) {
    throw new HttpError(409, `运行 ${id} 正在使用不同的身份基线`);
  }
  const ready = await active.ready;
  const path = await store.loadEvolutionPath(id);
  return path ?? ready;
}

async function evolveRun(id: string, bodyValue: unknown): Promise<EvolutionPath> {
  const request = parseEvolutionRunRequest(bodyValue);
  const active = evolutionJobs.get(id);
  if (active) return acknowledgeActiveEvolution(id, request, active);

  const job = {
    token: Symbol(id),
    ...(request.kind === 'ensure-through' ? {
      requestedEndMonth: request.requestedEndMonth,
      ensureBasisKey: evolutionExpectedBasisKey(request.expected),
    } : {}),
  } as EvolutionJob;
  evolutionJobs.set(id, job);
  job.ready = Promise.resolve().then(() => initializeEvolutionJob(id, request, job));
  try {
    return await job.ready;
  } catch (error) {
    releaseEvolutionJob(id, job);
    throw error;
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "OPTIONS") {
    setCommonHeaders(response);
    response.statusCode = 204;
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "threebody-evolution",
      storage: "sqlite",
      dataDirectory: store.dataDirectory(),
      databaseFile: store.filePath(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/decide") {
    const payload = await readJson(request) as { endpoint?: unknown; model?: unknown };
    const requestedEndpoint = typeof payload.endpoint === 'string'
      ? payload.endpoint
      : typeof payload.model === 'string' ? payload.model : undefined;
    const result = await handleDecide(payload, requestedEndpoint);
    sendJson(response, result.status, result.body);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/model-settings') {
    sendJson(response, 200, readModelSettings());
    return;
  }

  if (request.method === 'PUT' && url.pathname === '/api/model-settings') {
    const body = asObject(await readJson(request));
    try {
      sendJson(response, 200, updateModelSettings(
        modelRoutes(body.routes),
        modelUseMode(body.evolutionMode, 'evolutionMode'),
        modelUseMode(body.summaryMode, 'summaryMode'),
      ));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (url.pathname.startsWith("/api/eland/")) {
    const result = await elandWorker.handle(request.method, url, request.method === "POST" ? await readJson(request) : {});
    sendEncodedJson(response, result.status, result.body);
    return;
  }

  if (parts[0] !== "api" || parts[1] !== "runs") throw new HttpError(404, "接口不存在");

  if (request.method === "GET" && parts.length === 2) {
    sendJson(response, 200, { runs: await store.list() });
    return;
  }

  if (request.method === "POST" && parts.length === 2) {
    sendJson(response, 201, responseRun(await createRun(await readJson(request), false)));
    return;
  }

  if (request.method === "POST" && parts[2] === "import" && parts.length === 3) {
    sendJson(response, 201, responseRun(await createRun(await readJson(request), true)));
    return;
  }

  const id = decodeURIComponent(parts[2] ?? "");
  if (!id) throw new HttpError(404, "接口不存在");

  if (request.method === "GET" && parts.length === 3) {
    sendJson(response, 200, await store.load(id));
    return;
  }

  if (request.method === "GET" && parts[3] === "state" && parts.length === 4) {
    sendJson(response, 200, (await store.load(id)).state);
    return;
  }

  if (request.method === "PUT" && parts[3] === "state" && parts.length === 4) {
    const importedState = stateFrom(await readJson(request));
    const saved = await serialized(id, () => store.save(id, importedState, undefined, { historyMode: 'replace' }));
    sendJson(response, 200, saved);
    return;
  }

  if (request.method === "POST" && parts[3] === "evolve" && parts.length === 4) {
    sendJson(response, 202, await evolveRun(id, await readJson(request)));
    return;
  }

  if (request.method === "GET" && parts[3] === "evolution" && parts.length === 4) {
    const evolution = await store.loadEvolutionPath(id);
    if (!evolution) throw new HttpError(404, `运行 ${id} 尚无演化路径`);
    sendJson(response, 200, evolution);
    return;
  }

  if (request.method === "GET" && parts[3] === "report" && parts.length === 4) {
    const report = await store.loadEvolutionReport(id);
    if (!report) throw new HttpError(404, `运行 ${id} 尚无演化报告`);
    sendJson(response, 200, report);
    return;
  }

  if (request.method === 'GET' && parts[3] === 'enhancements' && parts.length === 4) {
    const artifact = await narrativeEnhancements.load(id);
    if (!artifact) throw new HttpError(404, `运行 ${id} 尚无叙事增强旁车`);
    const modelEndpoint = modelEndpointStatus('narrative');
    sendJson(response, 200, {
      artifact,
      counts: narrativeEnhancementCounts(artifact),
      processing: narrativeEnhancements.isProcessing(id),
      providerConfigured: modelEndpoint.configured,
      modelEndpoint,
      authoritativeStateChanged: false,
    });
    return;
  }

  if (request.method === 'POST' && parts[3] === 'enhancements' && parts.length === 4) {
    const body = asObject(await readJson(request));
    const result = await narrativeEnhancements.trigger(id, {
      kinds: narrativeKinds(body.kinds),
      maxNewTasks: enhancementTaskLimit(body.maxTasks),
      retryFailed: body.retryFailed === true,
      dispatch: body.dispatch !== false,
    });
    sendJson(response, 202, { ...result, authoritativeStateChanged: false });
    return;
  }

  throw new HttpError(404, "接口不存在");
}

const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    if (error instanceof HttpError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof EvolutionRequestValidationError) sendJson(response, 400, { error: error.message });
    else if (error instanceof EvolutionIdentityConflictError) sendJson(response, 409, { error: error.message });
    else if (error instanceof RunNotFoundError) sendJson(response, 404, { error: error.message });
    else if (error instanceof RunAlreadyExistsError) sendJson(response, 409, { error: error.message });
    else if (error instanceof RunWriteConflictError) sendJson(response, 409, { error: error.message });
    else {
      console.error(error);
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ThreeBody evolution backend: http://${HOST}:${PORT}`);
  console.log(`Persistent database: ${store.filePath()}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  void elandWorker.close().finally(() => {
    store.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
