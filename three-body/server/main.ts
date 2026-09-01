import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
  EvolutionIdentityConflictError,
  EvolutionRequestValidationError,
} from './evolution-request';
import { ElandWorkerClient } from './eland-worker-client';
import { HttpError } from './http-error';
import { handleModelApi } from './model-api';
import { NarrativeEnhancementService } from './narrative-enhancement-service';
import {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
} from "./run-persistence";
import { RunApi } from './run-api';
import { RunEvolutionService } from './run-evolution-service';
import { executeLongEvolutionInWorker } from './run-evolution-worker-client';
import { SqliteRunStore } from './sqlite-run-store';

const HOST = process.env.THREEBODY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.THREEBODY_PORT ?? 3220);
const DATA_DIR = path.resolve(process.env.THREEBODY_DATA_DIR ?? path.join(process.cwd(), "data"));
const configuredMaxBodyMiB = Number(process.env.ELAND_MAX_HTTP_BODY_MIB ?? 50);
const MAX_BODY_MIB = Number.isInteger(configuredMaxBodyMiB)
  && configuredMaxBodyMiB >= 1
  && configuredMaxBodyMiB <= 512
  ? configuredMaxBodyMiB
  : 50;
const MAX_BODY_BYTES = MAX_BODY_MIB * 1024 * 1024;

const store = new SqliteRunStore(DATA_DIR);
const narrativeEnhancements = new NarrativeEnhancementService(store);
const elandWorker = new ElandWorkerClient();
const runEvolution = new RunEvolutionService(
  store,
  (id, request) => executeLongEvolutionInWorker(store.dataDirectory(), id, request),
);
const runApi = new RunApi(store, runEvolution, narrativeEnhancements);

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
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `请求体超过 ${MAX_BODY_MIB}MiB`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
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

  if (url.pathname === '/api/decide' || url.pathname.startsWith('/api/model-settings')) {
    const readsBody = (url.pathname === '/api/decide' && request.method === 'POST')
      || (url.pathname.startsWith('/api/model-settings') && ['POST', 'PUT', 'DELETE'].includes(request.method ?? ''));
    const result = await handleModelApi(
      request.method,
      url.pathname,
      readsBody ? await readJson(request) : {},
    );
    sendJson(response, result.status, result.body);
    return;
  }

  if (url.pathname.startsWith("/api/eland/")) {
    const result = await elandWorker.handle(request.method, url, request.method === "POST" ? await readJson(request) : {});
    sendEncodedJson(response, result.status, result.body);
    return;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'api' && pathParts[1] === 'runs') {
    const result = await runApi.handle(
      request.method,
      url,
      () => readJson(request),
    );
    sendJson(response, result.status, result.body);
    return;
  }

  throw new HttpError(404, '接口不存在');
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
