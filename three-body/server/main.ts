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
import { ElandWorkerClient } from './eland-worker-client';
import { NarrativeEnhancementService } from './narrative-enhancement-service';
import {
  NARRATIVE_ENHANCEMENT_KINDS,
  narrativeEnhancementCounts,
  type NarrativeEnhancementKind,
} from './narrative-enhancements';
import {
  FileRunStore,
  RunAlreadyExistsError,
  RunNotFoundError,
  type PersistedRun,
} from "./run-store";

const HOST = process.env.THREEBODY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.THREEBODY_PORT ?? 3220);
const DATA_DIR = path.resolve(process.env.THREEBODY_DATA_DIR ?? path.join(process.cwd(), "data", "runs"));
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const RULE_PLANNER_MODEL = 'rule-planner-v1';

const store = new FileRunStore(DATA_DIR);
const narrativeEnhancements = new NarrativeEnhancementService(store);
const elandWorker = new ElandWorkerClient();
const runQueues = new Map<string, Promise<unknown>>();
const evolutionJobs = new Map<string, Promise<void>>();

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

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 1) throw new HttpError(400, "months 必须是正整数");
  return Math.floor(number);
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

async function executeLongEvolution(id: string, months: number, initialPath: EvolutionPath): Promise<void> {
  const current = await store.load(id);
  const controller = createSimulation({ state: current.state });
  const endMonth = current.state.clock.elapsedMonths + months;
  let persisted = current.state;
  let path = initialPath;
  let inputTokens = path.checkpoints.at(-1)?.inputTokens ?? 0;
  let outputTokens = path.checkpoints.at(-1)?.outputTokens ?? 0;
  try {
    for (let advanced = 0; advanced < months && persisted.civilization.status === 'running';) {
      const batchMonths = Math.min(12, months - advanced);
      const state = controller.step(batchMonths);
      persisted = state;
      advanced += batchMonths;
      persisted = (await store.save(id, persisted)).state;
      path = evolvePath(persisted, {
        runId: id,
        provider: 'local',
        model: RULE_PLANNER_MODEL,
        fromMonth: initialPath.fromMonth,
        requestedEndMonth: endMonth,
        previous: path,
        checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }),
        status: 'running',
      });
      await store.saveEvolutionPath(id, path);
    }
    const report = buildEvolutionFactsReport(persisted, path);
    await store.saveEvolutionReport(id, report);
    path = evolvePath(persisted, { runId: id, provider: 'local', model: path.model, fromMonth: initialPath.fromMonth, requestedEndMonth: endMonth, previous: path, status: 'completed' });
    await store.saveEvolutionPath(id, path);
  } catch (error) {
    persisted = (await store.save(id, persisted)).state;
    path = evolvePath(persisted, {
      runId: id,
      provider: 'local',
      model: path.model,
      fromMonth: initialPath.fromMonth,
      requestedEndMonth: endMonth,
      previous: path,
      checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }),
      status: 'failed',
      failure: error instanceof Error ? error.message : String(error),
    });
    await store.saveEvolutionPath(id, path);
  }
}

async function evolveRun(id: string, bodyValue: unknown): Promise<unknown> {
  const body = asObject(bodyValue);
  const months = positiveInteger(body.months, 1);
  if (evolutionJobs.has(id)) throw new HttpError(409, `运行 ${id} 正在演化`);
  const current = await store.load(id);
  if (current.state.civilization.status === 'ended') throw new HttpError(409, `运行 ${id} 已经结束`);
  const previous = await store.loadEvolutionPath(id);
  const requestedEndMonth = current.state.clock.elapsedMonths + months;
  const initial = evolvePath(current.state, {
    runId: id,
    provider: 'local',
    model: RULE_PLANNER_MODEL,
    fromMonth: current.state.clock.elapsedMonths,
    requestedEndMonth,
    ...(previous ? { previous } : {}),
    checkpoint: checkpointFor(current.state, {
      inputTokens: previous?.checkpoints.at(-1)?.inputTokens ?? 0,
      outputTokens: previous?.checkpoints.at(-1)?.outputTokens ?? 0,
    }),
    status: 'running',
  });
  await store.saveEvolutionPath(id, initial);
  const job = serialized(id, () => executeLongEvolution(id, months, initial)).then(() => undefined);
  evolutionJobs.set(id, job);
  void job.finally(() => evolutionJobs.delete(id)).catch((error) => console.error(`运行 ${id} 的后台演化任务异常`, error));
  return initial;
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
    sendJson(response, 200, { ok: true, service: "threebody-evolution", dataDirectory: store.dataDirectory() });
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
    sendJson(response, result.status, result.body);
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
    const saved = await serialized(id, () => store.save(id, importedState));
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
    else if (error instanceof RunNotFoundError) sendJson(response, 404, { error: error.message });
    else if (error instanceof RunAlreadyExistsError) sendJson(response, 409, { error: error.message });
    else {
      console.error(error);
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ThreeBody evolution backend: http://${HOST}:${PORT}`);
  console.log(`Persistent runs: ${DATA_DIR}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  void elandWorker.close().finally(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
