import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
  createDefaultSimulationConfig,
  createSimulation,
  type SimulationConfig,
  type SimulationState,
} from "../src/game/eland/simulation";
import { normalizeModelProvider } from "../src/game/llm";
import { createServerLlmDecider } from "./backend-decider";
import { loadLlmKey } from "./env";
import { handleDecide, modelConfiguration } from "./kimi-gateway";
import { buildEvolutionFactsReport, checkpointFor, evolvePath, type EvolutionPath } from './evolution-artifacts';
import { handleElandApi } from "./eland-api";
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

const store = new FileRunStore(DATA_DIR);
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
  const apiKey = loadLlmKey('kimi');
  if (!apiKey) throw new Error('未配置 KIMI_API_KEY，真实演化无法开始');
  const current = await store.load(id);
  const controller = createSimulation({ state: current.state });
  const endMonth = current.state.clock.elapsedMonths + months;
  let persisted = current.state;
  let path = initialPath;
  let inputTokens = path.checkpoints.at(-1)?.inputTokens ?? 0;
  let outputTokens = path.checkpoints.at(-1)?.outputTokens ?? 0;
  try {
    for (let index = 0; index < months && persisted.civilization.status === 'running'; index += 1) {
      const state = await controller.stepAsync(createServerLlmDecider(apiKey, 'kimi'));
      persisted = state;
      const ledger = state.decisionBudget.ledgers.at(-1);
      inputTokens += ledger?.inputTokens ?? 0;
      outputTokens += ledger?.outputTokens ?? 0;
      const reachedEnd = index === months - 1 || state.civilization.status === 'ended';
      const checkpointDue = (state.clock.elapsedMonths - initialPath.fromMonth) % 12 === 0;
      if (!checkpointDue && !reachedEnd) continue;
      persisted = (await store.save(id, persisted)).state;
      path = evolvePath(persisted, {
        runId: id,
        model: modelConfiguration('kimi').model,
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
    path = evolvePath(persisted, { runId: id, model: path.model, fromMonth: initialPath.fromMonth, requestedEndMonth: endMonth, previous: path, status: 'completed' });
    await store.saveEvolutionPath(id, path);
  } catch (error) {
    persisted = (await store.save(id, persisted)).state;
    path = evolvePath(persisted, {
      runId: id,
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
  if (!loadLlmKey('kimi')) throw new HttpError(503, '未配置 KIMI_API_KEY，真实演化无法开始');
  if (evolutionJobs.has(id)) throw new HttpError(409, `运行 ${id} 正在演化`);
  const current = await store.load(id);
  if (current.state.civilization.status === 'ended') throw new HttpError(409, `运行 ${id} 已经结束`);
  const previous = await store.loadEvolutionPath(id);
  const requestedEndMonth = current.state.clock.elapsedMonths + months;
  const initial = evolvePath(current.state, {
    runId: id,
    model: modelConfiguration('kimi').model,
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
    const payload = await readJson(request) as { model?: unknown };
    const provider = normalizeModelProvider(payload.model);
    const result = await handleDecide(payload, loadLlmKey(provider), provider);
    sendJson(response, result.status, result.body);
    return;
  }

  if (url.pathname.startsWith("/api/eland/")) {
    const result = await handleElandApi(request.method, url, request.method === "POST" ? await readJson(request) : {});
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

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
