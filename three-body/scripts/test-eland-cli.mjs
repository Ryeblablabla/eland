import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectDirectory, 'scripts', 'eland.mjs');
const requests = [];
let evolutionReads = 0;

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(`${JSON.stringify(body)}\n`);
}

const fixtureRun = {
  meta: { id: 'inspect', label: 'inspect', elapsedMonths: 3 },
  state: {
    clock: { elapsedMonths: 3 },
    people: [],
    projects: [{
      id: 'project-1',
      ownerId: 'person-1',
      status: 'active',
      triggerFactIds: ['event-1'],
      actionEventIds: ['event-2'],
      failureEventIds: [],
      completionEventIds: [],
    }],
    world: {
      past: [
        { id: 'event-1', kind: 'environment', atMonth: 1, who: 'person-1' },
        { id: 'event-2', kind: 'action', atMonth: 2, who: 'person-1' },
        { id: 'event-3', kind: 'action', atMonth: 3, who: 'person-2' },
      ],
    },
  },
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const body = request.method === 'POST' || request.method === 'PUT' ? await readJson(request) : undefined;
  requests.push({ method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body });

  if (request.method === 'GET' && url.pathname === '/health') {
    send(response, 200, { ok: true, service: 'fixture', storage: 'sqlite' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/runs') {
    send(response, 201, { meta: { id: body.id, label: body.label } });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/runs/inspect') {
    send(response, 200, fixtureRun);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/runs/evolve/evolve') {
    send(response, 202, { runId: 'evolve', status: 'running', reachedMonth: 0 });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/runs/evolve/evolution') {
    evolutionReads += 1;
    send(response, 200, {
      runId: 'evolve',
      status: evolutionReads >= 2 ? 'completed' : 'running',
      reachedMonth: evolutionReads >= 2 ? 2 : 1,
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/eland/history') {
    send(response, 200, { civilizationId: 1, history: [], branches: [] });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/runs/inspect/enhancements') {
    send(response, 202, { processing: body.dispatch, kinds: body.kinds });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/model-settings') {
    send(response, 200, { evolutionMode: 'local', summaryMode: 'local' });
    return;
  }
  send(response, 404, { error: `fixture route missing: ${request.method} ${url.pathname}` });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

async function runCli(...args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args, '--base-url', baseUrl], {
    cwd: projectDirectory,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

try {
  const health = await runCli('doctor');
  assert.equal(health.ok, true);
  assert.equal(health.baseUrl, baseUrl);

  const created = await runCli(
    'run', 'create',
    '--id', 'cli-test',
    '--label', 'CLI test',
    '--seed', '17',
    '--months', '24',
    '--chaos-intensity', '2',
  );
  assert.equal(created.meta.id, 'cli-test');
  const createRequest = requests.find((item) => item.method === 'POST' && item.pathname === '/api/runs');
  assert.deepEqual(createRequest.body, {
    id: 'cli-test',
    label: 'CLI test',
    seed: 17,
    config: {
      endpoint: { kind: 'months', value: 24 },
      chaosIntensity: 2,
    },
  });

  const evolution = await runCli(
    'run', 'evolve', 'evolve',
    '--months', '2',
    '--wait',
    '--poll-ms', '10',
    '--wait-timeout-ms', '1000',
  );
  assert.equal(evolution.status, 'completed');
  assert.equal(evolution.reachedMonth, 2);

  const events = await runCli('inspect', 'events', 'inspect', '--project-id', 'project-1', '--all');
  assert.equal(events.total, 2);
  assert.deepEqual(events.events.map((event) => event.id), ['event-1', 'event-2']);

  const history = await runCli('session', 'history', 'live-run');
  assert.equal(history.civilizationId, 1);
  const historyRequest = requests.find((item) => item.pathname === '/api/eland/history');
  assert.equal(historyRequest.query.runId, 'live-run');

  const enhancement = await runCli(
    'narrative', 'generate', 'inspect',
    '--kinds', 'history,memory',
    '--max-tasks', '2',
    '--no-dispatch',
  );
  assert.equal(enhancement.processing, false);
  assert.deepEqual(enhancement.kinds, ['history', 'memory']);

  const modelSettings = await runCli('model', 'settings');
  assert.equal(modelSettings.evolutionMode, 'local');

  process.stdout.write('ELAND CLI tests passed\n');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
