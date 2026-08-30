import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-project-world-wait-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { createMonthExecution, executePlanningTick } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/simulation/month-execution.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-world-wait-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    createMonthExecution,
    executePlanningTick,
    instantiateProject,
    setVoxel,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(26083041, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  const actor = state.people[0];
  assert.ok(actor);
  state.people = [actor];
  state.intents = [];
  state.projects = [];
  state.world.drops = [];
  const center = cellId(42, 26);
  for (const localCell of cellsInRadius(center, 3)) {
    for (let z = 0; z < state.world.grid.levels; z += 1) {
      setVoxel(
        state.world.grid,
        cellX(localCell),
        cellY(localCell),
        z,
        z === 0 ? Material.PackedSoil : Material.Air,
      );
    }
  }
  setVoxel(state.world.grid, cellX(center), cellY(center), 0, Material.CropSprout);
  actor.position = {
    cellId: center,
    z: 1,
    previousCellId: center,
    previousZ: 1,
    lastPath: [],
    tickPath: [center],
  };
  actor.body = { health: 100, hydration: 100, nutrition: 100 };
  actor.conditions = [];
  actor.inventory = [{
    id: 'waiting-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['source:waiting-seed'],
  }];
  actor.memories = [];

  const project = instantiateProject({
    id: 'project-world-growth-wait',
    kind: 'production',
    need: 'production-efficiency',
    desiredFunction: 'settled-cultivation',
    summary: '等待固定耕地中的作物长成',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: ['pressure:project-world-growth-wait'],
    pressure: 80,
    createdAtMonth: 0,
    reviewAtMonth: 120,
    site: { cellId: center, z: 0 },
  });
  state.projects = [project];
  const intent = {
    id: 'intent-project-world-growth-wait',
    ownerId: actor.id,
    summary: '继续固定耕作项目',
    domain: 'strategic',
    goal: { kind: 'project-completed', projectId: project.id },
    nextAction: { kind: 'move', toCellId: center, toZ: 1 },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0.45,
    sourceDecisionEventId: 'decision-project-world-growth-wait',
    projectId: project.id,
    sourceFactIds: [...project.triggerFactIds],
    actionEventIds: [],
    replanCount: 0,
  };
  state.intents = [intent];
  actor.activeIntentId = intent.id;
  const failureMemoryCount = actor.memories.filter((memory) => memory.kind === 'failure').length;
  const prepared = {
    state,
    events: [],
    contexts: [],
    candidates: [],
    naturallyTriggeredPeople: new Set(),
    livingAgents: 1,
    atMonth: 1,
  };
  const execution = createMonthExecution({
    observationProjector: { project() { throw new Error('single tick test must not project'); } },
    prepared,
    decisions: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    attempted: { total: 0, ordinary: 0, exempt: 0 },
  });
  execution.reviewedPeople.add(actor.id);
  execution.ordinaryDeliberationCounts.set(actor.id, 1);
  const tick = executePlanningTick(execution);

  assert.equal(tick.events.filter((event) => event.kind === 'action').length, 0,
    '真实自然生长等待不得伪造 ActionFact');
  assert.equal(intent.status, 'suspended', '自然生长等待应让出当前执行焦点而不是把项目判失败');
  assert.equal(intent.waitingFor, 'world-change', '等待必须保留可审计的外部世界变化原因');
  assert.equal(actor.activeIntentId, undefined, '等待世界变化时人物应能改做其他有用工作');
  assert.equal(intent.goalOutcome, undefined, '未发生目标尝试时不得写入 0 次达成的目标后验');
  assert.equal(actor.memories.filter((memory) => memory.kind === 'failure').length, failureMemoryCount,
    '合法等待不得制造失败记忆供模型反复围绕假失败提案');
  assert.equal(execution.ordinaryReplanPermits.has(actor.id), true,
    '让出等待项目后，本月必须保留一次有界普通重规划机会');

  process.stdout.write('project world wait tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
