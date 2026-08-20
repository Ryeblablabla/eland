import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-state-ownership-test-'));
const controllerBundle = path.join(temporaryDirectory, 'controller.mjs');
const sessionBundle = path.join(temporaryDirectory, 'session.mjs');
const originalWorkingDirectory = process.cwd();
const isolatedEnvironmentNames = [
  'THREEBODY_MODEL_CONFIG',
  'THREEBODY_ENV_FILE',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'THREEBODY_DATA_DIR',
];
const originalEnvironment = new Map(isolatedEnvironmentNames.map((name) => [name, process.env[name]]));

function skyAt(month, fate = 'stable') {
  return {
    fromTime: Math.max(0, month - 1),
    toTime: month,
    fluxMean: 1,
    fluxMin: 1,
    fluxMax: 1,
    nearestStarDistance: 1,
    fate,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

try {
  const esbuild = path.join(projectRoot, 'node_modules/.bin/esbuild');
  execFileSync(esbuild, [
    path.join(projectRoot, 'src/game/eland/application/simulation/controller.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${controllerBundle}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync(esbuild, [
    path.join(projectRoot, 'server/elandSession.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${sessionBundle}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  delete process.env.THREEBODY_MODEL_CONFIG;
  process.env.THREEBODY_ENV_FILE = path.join(temporaryDirectory, 'missing.env');
  delete process.env.KIMI_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  process.env.THREEBODY_DATA_DIR = path.join(temporaryDirectory, 'data');
  process.chdir(temporaryDirectory);

  const { createSimulation } = await import(`${pathToFileURL(controllerBundle).href}?test=${Date.now()}`);
  const { ElandSession } = await import(`${pathToFileURL(sessionBundle).href}?test=${Date.now()}`);

  const publicInput = createSimulation({ seed: 20260820 }).getState();
  const publicController = createSimulation({ state: publicInput });
  assert.notStrictEqual(publicController.ownedState(), publicInput, '普通 createSimulation 必须复制传入状态');
  const publicRead = publicController.getState();
  assert.notStrictEqual(publicRead, publicController.ownedState(), 'getState 必须返回隔离副本');
  publicRead.clock.elapsedMonths = 999;
  assert.equal(publicController.ownedState().clock.elapsedMonths, 0, '修改 getState 结果不得污染 controller');
  publicController.restore(publicInput);
  assert.notStrictEqual(publicController.ownedState(), publicInput, '普通 restore 必须保持 copy-in 语义');

  const transferred = createSimulation({ seed: 20260821 }).getState();
  const ownedController = createSimulation();
  ownedController.adoptOwnedState(transferred);
  assert.strictEqual(ownedController.ownedState(), transferred, 'trusted adopt 必须原地接管状态');
  const legacy = structuredClone(transferred);
  legacy.schemaVersion = 16;
  assert.throws(
    () => ownedController.adoptOwnedState(legacy),
    /schemaVersion 17/,
    'trusted 接管仍必须执行 schema 17 硬切校验',
  );

  const modelGate = deferred();
  const modelEntered = deferred();
  const committedBeforeModel = ownedController.ownedState();
  const asyncStep = ownedController.stepAsyncOwnedWithClimate({
    async decideAll(contexts) {
      modelEntered.resolve();
      await modelGate.promise;
      return contexts.map(() => null);
    },
  }, { epoch: 'chaotic', kind: 'heat', severity: 7 });
  await modelEntered.promise;
  assert.strictEqual(ownedController.ownedState(), committedBeforeModel, '模型等待时 controller 必须继续暴露旧 committed state');
  assert.equal(committedBeforeModel.clock.elapsedMonths, 0, '模型等待时旧月份不得提前推进');
  assert.notEqual(committedBeforeModel.civilization.externalClimate?.kind, 'heat', '下月天象不得提前污染旧 committed state');
  modelGate.resolve();
  const committedAfterModel = await asyncStep;
  assert.notStrictEqual(committedAfterModel, committedBeforeModel, '异步月份只在完成后接管工作副本');
  assert.equal(committedAfterModel.clock.elapsedMonths, 1);
  assert.equal(committedAfterModel.civilization.externalClimate?.kind, 'heat');

  const session = new ElandSession('owned-session', skyAt(0));
  session.begin(17, 20260822, skyAt(0));
  assert.strictEqual(session.controller.ownedState(), session.latestState, 'begin 后 session/controller 必须共享唯一 committed state');

  const recovery = session.recoverySnapshot();
  assert.ok(recovery);
  const recoveredState = recovery.latestState;
  const recoveredAgent = recovery.latestFrame.society.agents[0];
  const activeOwner = recovery.latestState.people[1];
  const activeOwnerView = recovery.latestFrame.society.agents.find((agent) => agent.id === activeOwner.id);
  const activeIntentId = 'legacy-active-intent';
  activeOwner.activeIntentId = activeIntentId;
  recovery.latestState.intents.push({
    id: activeIntentId,
    ownerId: activeOwner.id,
    summary: '旧存档中仍有效的意图',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: activeOwner.position.cellId },
    nextAction: { kind: 'move', toCellId: activeOwner.position.cellId, toZ: activeOwner.position.z },
    status: 'active',
    createdAtMonth: 0,
    lastProgressAtMonth: 0,
    progress: 0,
    sourceDecisionEventId: 'legacy-active-decision',
    actionEventIds: [],
    replanCount: 0,
  });
  recovery.latestFrame = {
    ...recovery.latestFrame,
    society: {
      ...recovery.latestFrame.society,
      agents: recovery.latestFrame.society.agents.map((agent, index) => {
        if (index === 0) return { ...agent, activeIntentId: 'legacy-terminal-intent' };
        if (agent.id === activeOwner.id) return { ...agent, activeIntentId };
        return agent;
      }),
      intents: [
        {
          id: 'legacy-terminal-intent',
          ownerId: recoveredAgent.id,
          summary: '旧存档中的终态意图',
          status: 'completed',
          progress: 1,
          createdAtMonth: 0,
          lastProgressAtMonth: 0,
          actionKind: 'move',
        },
        {
          id: activeIntentId,
          ownerId: activeOwner.id,
          summary: '旧存档中仍有效的意图',
          status: 'active',
          progress: 0,
          createdAtMonth: 0,
          lastProgressAtMonth: 0,
          actionKind: 'move',
        },
      ],
    },
  };
  delete recovery.timelineHeadComplete;
  const restored = ElandSession.restore(recovery);
  assert.strictEqual(restored.latestState, recoveredState, '恢复必须原地接管已验证 snapshot');
  assert.strictEqual(restored.controller.ownedState(), restored.latestState, '恢复空闲期只能保留一份权威状态引用');
  assert.deepEqual(restored.latest().society.intents.map((intent) => intent.id), [activeIntentId],
    '旧存档 head 只应保留权威状态中仍 active 的意图');
  assert.equal(restored.latest().society.agents[0].activeIntentId, undefined,
    '旧存档人物不得保留指向终态意图的 activeIntentId');
  assert.equal(restored.latest().society.agents.find((agent) => agent.id === activeOwnerView.id).activeIntentId,
    activeIntentId, '旧存档人物必须保留真实 activeIntentId');
  assert.equal(restored.branches.get(restored.activeBranchId).snapshots.get(0).kind, 'checkpoint',
    '缺少完整性标记的 legacy head 必须由 latestState 修复');

  restored.latestState.intents = restored.latestState.intents.filter((intent) => intent.id !== activeIntentId);
  restored.latestState.people.find((person) => person.id === activeOwner.id).activeIntentId = undefined;

  const oldCommitted = restored.latestState;
  const sessionGate = deferred();
  const asyncCalled = deferred();
  const originalAsyncStep = restored.controller.stepAsyncOwnedWithClimate.bind(restored.controller);
  restored.controller.stepAsyncOwnedWithClimate = async (...args) => {
    asyncCalled.resolve();
    await sessionGate.promise;
    return originalAsyncStep(...args);
  };
  const agentId = restored.latest().society.agents[0].id;
  restored.pendingPlayerInteractions = () => [{
    id: 'ownership-interaction',
    agentId,
    sourceMonth: 0,
    playerMessage: '检查异步提交边界',
    stance: 'accept',
    choice: {
      optionId: 'ownership-test-option',
      summary: '继续观察',
      choiceKey: 'ownership-test-choice',
      reason: '仅用于状态所有权回归测试',
    },
  }];
  const pendingSessionStep = restored.step({ skySample: skyAt(1, 'chaotic-heat') });
  await asyncCalled.promise;
  assert.strictEqual(restored.latestState, oldCommitted, 'ElandSession 异步等待时必须保留旧 committed state');
  assert.strictEqual(restored.controller.ownedState(), oldCommitted, '工作副本启动前不得切换 controller 所有权');
  assert.notEqual(oldCommitted.civilization.externalClimate?.kind, 'heat', '异步等待时新天象不得污染旧状态');
  sessionGate.resolve();
  const committedFrame = await pendingSessionStep;
  assert.equal(committedFrame.elapsedMonths, 1);
  assert.strictEqual(restored.controller.ownedState(), restored.latestState, '提交后 session/controller 必须重新指向同一状态');
  assert.equal(restored.latestState.clock.elapsedMonths, 1);

  const forkFrame = restored.seek(0);
  assert.ok(forkFrame, 'seek 必须能重建历史分支');
  assert.strictEqual(restored.controller.ownedState(), restored.latestState, 'seek 必须直接转移重建状态所有权');
  assert.equal(restored.latestState.clock.elapsedMonths, 0);

  console.log('session state ownership tests passed');
} finally {
  process.chdir(originalWorkingDirectory);
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
