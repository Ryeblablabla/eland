import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';
import { brotliDecompressSync } from 'node:zlib';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-functional-building-index-'));
const bundlePath = path.join(temporaryDirectory, 'functional-building-index.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { observeFunctionalBuildings } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/era-progression.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=functional-building-index-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    cellId,
    createInitialState,
    observeFunctionalBuildings,
    setVoxel,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const facilityDefinitions = new Map([
    [Material.CouncilHearth, { kind: 'core', functionSummary: '为共同议事、共享记忆与早期协调提供固定场所' }],
    [Material.CivicHall, { kind: 'core', functionSummary: '为记录、度量与城邦协调提供固定行政场所' }],
    [Material.KeepCore, { kind: 'core', functionSummary: '为城镇防护、维护与工匠协调提供固定场所' }],
    [Material.Granary, { kind: 'storage', functionSummary: '提供 96 单位公共储量，容量是普通木制容器的四倍' }],
    [Material.Cistern, { kind: 'water', functionSummary: '提供可抵达、可饮用的固定蓄水点' }],
    [Material.Workshop, { kind: 'workshop', functionSummary: '在近身范围内制作非设施物品时额外产出一份' }],
    [Material.Kiln, { kind: 'kiln', functionSummary: '提供铜锡矿炭料和黏土发生高温响应的实体目标' }],
    [Material.Mill, { kind: 'mill', functionSummary: '在近身范围内收获成熟作物时额外得到食物' }],
    [Material.Foundry, { kind: 'foundry', functionSummary: '为青铜铸造和青铜工具批量制作提供实体场所' }],
    [Material.Smithy, { kind: 'smithy', functionSummary: '使铁矿炭料形成海绵铁，并提高铁器制作产量' }],
  ]);

  function legacyObserveFunctionalBuildings(state) {
    const actions = state.world.past.filter((event) => event.kind === 'action');
    const installations = new Map();
    for (const event of actions) {
      if (event.status !== 'completed' || event.action.kind !== 'act' || event.action.operation !== 'combine') continue;
      const materialId = Number(event.diff.outputMaterialId);
      const definition = facilityDefinitions.get(materialId);
      const position = event.diff.position;
      if (!definition || ![position?.x, position?.y, position?.z]
        .every((value) => Number.isInteger(Number(value)))) continue;
      const x = Number(position.x);
      const y = Number(position.y);
      const z = Number(position.z);
      if (voxelAt(state.world.grid, x, y, z) !== materialId) continue;
      const id = `facility:${materialId}:${x}:${y}:${z}`;
      const existing = installations.get(id);
      if (existing) existing.installationEventIds.push(event.id);
      else installations.set(id, {
        event, materialId, definition, x, y, z, installationEventIds: [event.id],
      });
    }
    return [...installations.entries()].map(([id, installation]) => {
      const { materialId, definition, x, y, z, installationEventIds } = installation;
      const installedCell = cellId(x, y);
      const containerId = `container:${x}:${y}:${z}`;
      const installedAtMonth = Math.min(...installationEventIds.map((eventId) => (
        actions.find((event) => event.id === eventId)?.atMonth ?? state.clock.elapsedMonths
      )));
      const installationIds = new Set(installationEventIds);
      const uses = actions.filter((candidate) => candidate.status === 'completed'
        && candidate.atMonth >= installedAtMonth
        && !installationIds.has(candidate.id)
        && (
          Number(candidate.diff.facilityMaterialId) === materialId
          || (definition.kind === 'storage'
            && candidate.action.kind === 'transfer'
            && (candidate.action.from.kind === 'container' || candidate.action.to.kind === 'container')
            && (candidate.action.from.kind === 'container'
              ? candidate.action.from.containerId
              : candidate.action.to.kind === 'container' ? candidate.action.to.containerId : '') === containerId)
          || (definition.kind === 'water'
            && candidate.action.kind === 'act'
            && candidate.action.operation === 'ingest'
            && candidate.action.targets.some((target) => target.kind === 'voxel'
              && target.position.x === x && target.position.y === y && target.position.z === z))
          || (definition.kind === 'core'
            && candidate.action.kind === 'communicate'
            && candidate.cellId === installedCell)
        ));
      return {
        id,
        kind: definition.kind,
        materialId,
        cellId: installedCell,
        z,
        installedAtMonth,
        installationEventIds,
        useEventIds: uses.map((candidate) => candidate.id),
        userIds: [...new Set(uses.map((candidate) => candidate.who))],
        functionSummary: definition.functionSummary,
        active: true,
      };
    });
  }

  function actionFact({
    id, atMonth, who, cell = 0, status = 'completed', action, diff = {}, orderInMonth = 0,
  }) {
    return {
      id,
      kind: 'action',
      atMonth,
      orderInMonth,
      planningTick: 1,
      orderInTick: orderInMonth,
      actionTick: 1,
      who,
      cellId: cell,
      fromCellId: cell,
      toCellId: cell,
      fromZ: 1,
      toZ: 1,
      pathSegment: [cell],
      status,
      result: id,
      action,
      diff,
    };
  }

  const installAction = { kind: 'act', operation: 'combine', targets: [] };
  const genericAction = { kind: 'attend', target: { kind: 'person', personId: 'nobody' } };
  const projectionHash = (projection) => createHash('sha256')
    .update(JSON.stringify(projection))
    .digest('hex');
  const assertExact = (state, label) => {
    const legacy = legacyObserveFunctionalBuildings(state);
    const candidate = observeFunctionalBuildings(state);
    assert.deepEqual(candidate, legacy, `${label}：候选投影必须与旧参考逐字段一致`);
    const legacyHash = projectionHash(legacy);
    const candidateHash = projectionHash(candidate);
    assert.equal(candidateHash, legacyHash, `${label}：完整 JSON SHA-256 必须一致`);
    return { hash: candidateHash, projection: candidate };
  };

  const state = createInitialState(20_260_823, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 12;
  const [ada, bohr, curie] = state.people;
  const workshopA = { x: 10, y: 10, z: 8 };
  const granary = { x: 11, y: 10, z: 8 };
  const workshopB = { x: 12, y: 10, z: 8 };
  const cistern = { x: 13, y: 10, z: 8 };
  const coreA = { x: 14, y: 10, z: 8 };
  const coreB = { x: 14, y: 10, z: 9 };
  const replacedKiln = { x: 15, y: 10, z: 8 };
  for (const [position, materialId] of [
    [workshopA, Material.Workshop],
    [granary, Material.Granary],
    [workshopB, Material.Workshop],
    [cistern, Material.Cistern],
    [coreA, Material.CouncilHearth],
    [coreB, Material.CivicHall],
  ]) setVoxel(state.world.grid, position.x, position.y, position.z, materialId);
  setVoxel(state.world.grid, replacedKiln.x, replacedKiln.y, replacedKiln.z, Material.Air);

  const granaryContainerId = `container:${granary.x}:${granary.y}:${granary.z}`;
  const coreCell = cellId(coreA.x, coreA.y);
  let order = 0;
  const fact = (input) => actionFact({ ...input, orderInMonth: order++ });
  state.world.past = [
    fact({
      id: 'use-before-installation', atMonth: 1, who: ada.id, action: genericAction,
      diff: { facilityMaterialId: Material.Workshop },
    }),
    fact({
      id: 'install-workshop-a', atMonth: 2, who: ada.id, action: installAction,
      diff: { outputMaterialId: Material.Workshop, position: workshopA },
    }),
    fact({
      id: 'install-granary-first', atMonth: 2, who: bohr.id, action: installAction,
      diff: { outputMaterialId: Material.Granary, position: granary },
    }),
    fact({
      id: 'use-only-installed-workshop', atMonth: 2, who: bohr.id, action: genericAction,
      diff: { facilityMaterialId: Material.Workshop },
    }),
    fact({
      id: 'install-workshop-b', atMonth: 3, who: curie.id, action: installAction,
      diff: { outputMaterialId: Material.Workshop, position: workshopB },
    }),
    fact({
      id: 'install-cistern', atMonth: 3, who: ada.id, action: installAction,
      diff: { outputMaterialId: Material.Cistern, position: cistern },
    }),
    fact({
      id: 'install-core-a', atMonth: 3, who: bohr.id, action: installAction,
      diff: { outputMaterialId: Material.CouncilHearth, position: coreA },
    }),
    fact({
      id: 'install-core-b', atMonth: 3, who: curie.id, action: installAction,
      diff: { outputMaterialId: Material.CivicHall, position: coreB },
    }),
    fact({
      id: 'install-replaced-kiln', atMonth: 3, who: ada.id, action: installAction,
      diff: { outputMaterialId: Material.Kiln, position: replacedKiln },
    }),
    fact({
      id: 'install-granary-again', atMonth: 4, who: curie.id, action: installAction,
      diff: { outputMaterialId: Material.Granary, position: granary },
    }),
    fact({
      id: 'use-all-workshops', atMonth: 5, who: curie.id, action: genericAction,
      diff: { facilityMaterialId: Material.Workshop },
    }),
    fact({
      id: 'blocked-workshop-use', atMonth: 5, who: ada.id, status: 'blocked', action: genericAction,
      diff: { facilityMaterialId: Material.Workshop },
    }),
    fact({
      id: 'granary-overlap-once', atMonth: 6, who: bohr.id,
      action: {
        kind: 'transfer', materialId: Material.Food, quantity: 1,
        from: { kind: 'person', personId: bohr.id },
        to: { kind: 'container', containerId: granaryContainerId },
      },
      diff: { facilityMaterialId: Material.Granary },
    }),
    fact({
      id: 'granary-from-container-precedence', atMonth: 7, who: ada.id,
      action: {
        kind: 'transfer', materialId: Material.Food, quantity: 1,
        from: { kind: 'container', containerId: 'container:other' },
        to: { kind: 'container', containerId: granaryContainerId },
      },
    }),
    fact({
      id: 'granary-position-use', atMonth: 8, who: ada.id,
      action: {
        kind: 'transfer', materialId: Material.Food, quantity: 1,
        from: { kind: 'person', personId: ada.id },
        to: { kind: 'container', containerId: granaryContainerId },
      },
    }),
    fact({
      id: 'cistern-overlap-and-duplicate-target', atMonth: 8, who: curie.id,
      action: {
        kind: 'act', operation: 'ingest',
        targets: [
          { kind: 'voxel', position: cistern },
          { kind: 'voxel', position: cistern },
        ],
      },
      diff: { facilityMaterialId: Material.Cistern },
    }),
    fact({
      id: 'core-overlap-and-shared-cell', atMonth: 9, who: ada.id, cell: coreCell,
      action: {
        kind: 'communicate', audience: [bohr.id], channel: 'voice',
        content: { id: 'claim:core', kind: 'claim', summary: '共同议事' },
      },
      diff: { facilityMaterialId: Material.CouncilHearth },
    }),
    fact({
      id: 'core-shared-cell-second-user', atMonth: 10, who: bohr.id, cell: coreCell,
      action: {
        kind: 'communicate', audience: [curie.id], channel: 'voice',
        content: { id: 'claim:core:2', kind: 'claim', summary: '继续议事' },
      },
    }),
  ];

  const directed = assertExact(state, '定向多路径 fixture');
  assert.deepEqual(directed.projection.map((facility) => facility.id), [
    `facility:${Material.Workshop}:${workshopA.x}:${workshopA.y}:${workshopA.z}`,
    `facility:${Material.Granary}:${granary.x}:${granary.y}:${granary.z}`,
    `facility:${Material.Workshop}:${workshopB.x}:${workshopB.y}:${workshopB.z}`,
    `facility:${Material.Cistern}:${cistern.x}:${cistern.y}:${cistern.z}`,
    `facility:${Material.CouncilHearth}:${coreA.x}:${coreA.y}:${coreA.z}`,
    `facility:${Material.CivicHall}:${coreB.x}:${coreB.y}:${coreB.z}`,
  ], '设施必须保持首次合格安装事件的插入顺序，已被替换的陶窑不得出现');
  const projectedGranary = directed.projection[1];
  assert.deepEqual(projectedGranary.installationEventIds, [
    'install-granary-first', 'install-granary-again',
  ]);
  assert.deepEqual(projectedGranary.useEventIds, [
    'granary-overlap-once', 'granary-position-use',
  ], '重叠路径必须去重，双容器转移仍须优先检查 from.containerId');
  assert.deepEqual(projectedGranary.userIds, [bohr.id, ada.id], 'userIds 必须保持首次使用顺序');

  const scaleState = createInitialState(20_260_824, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  scaleState.clock.elapsedMonths = 12;
  const scaleActor = scaleState.people[0];
  const scaleFacts = [];
  let scaleOrder = 0;
  for (let index = 0; index < 96; index += 1) {
    const position = { x: 1 + index % 24, y: 1 + Math.floor(index / 24), z: 10 };
    setVoxel(scaleState.world.grid, position.x, position.y, position.z, Material.Workshop);
    scaleFacts.push(actionFact({
      id: `scale-install-${index}`, atMonth: 1, who: scaleActor.id,
      action: installAction, diff: { outputMaterialId: Material.Workshop, position },
      orderInMonth: scaleOrder++,
    }));
  }
  for (let index = 0; index < 20_000; index += 1) {
    scaleFacts.push(actionFact({
      id: `scale-noise-${index}`, atMonth: 2 + index % 10, who: scaleActor.id,
      action: genericAction, orderInMonth: scaleOrder++,
    }));
  }
  for (let index = 0; index < 240; index += 1) {
    scaleFacts.push(actionFact({
      id: `scale-use-${index}`, atMonth: 3 + index % 9, who: scaleActor.id,
      action: genericAction, diff: { facilityMaterialId: Material.Workshop },
      orderInMonth: scaleOrder++,
    }));
  }
  scaleState.world.past = scaleFacts;
  const scaleExact = assertExact(scaleState, '增长形态 fixture');
  legacyObserveFunctionalBuildings(scaleState);
  observeFunctionalBuildings(scaleState);
  const measure = (project) => {
    const startedAt = performance.now();
    project();
    return performance.now() - startedAt;
  };
  const legacyTimes = [
    measure(() => legacyObserveFunctionalBuildings(scaleState)),
    measure(() => legacyObserveFunctionalBuildings(scaleState)),
    measure(() => legacyObserveFunctionalBuildings(scaleState)),
  ].sort((left, right) => left - right);
  const candidateTimes = [
    measure(() => observeFunctionalBuildings(scaleState)),
    measure(() => observeFunctionalBuildings(scaleState)),
    measure(() => observeFunctionalBuildings(scaleState)),
  ].sort((left, right) => left - right);
  const legacyMedianMs = legacyTimes[1];
  const candidateMedianMs = candidateTimes[1];
  assert.ok(candidateMedianMs < legacyMedianMs * 0.6,
    `增长形态 fixture 候选中位耗时应低于旧参考 60%：legacy=${legacyMedianMs.toFixed(2)}ms candidate=${candidateMedianMs.toFixed(2)}ms`);

  let checkpointProjection = null;
  const checkpointDatabase = process.env.ELAND_FUNCTIONAL_BUILDING_CHECKPOINT_DB;
  const checkpointRunId = process.env.ELAND_FUNCTIONAL_BUILDING_CHECKPOINT_RUN_ID;
  const checkpointMonth = Number(process.env.ELAND_FUNCTIONAL_BUILDING_CHECKPOINT_MONTH);
  if (checkpointDatabase && checkpointRunId && Number.isInteger(checkpointMonth)) {
    const database = new DatabaseSync(checkpointDatabase, { readOnly: true });
    const checkpoint = database.prepare(`
      SELECT state_hash AS stateHash
      FROM run_checkpoints
      WHERE run_id = ? AND month = ?
      ORDER BY revision DESC
      LIMIT 1
    `).get(checkpointRunId, checkpointMonth);
    assert.ok(checkpoint, `缺少 ${checkpointRunId} m${checkpointMonth} checkpoint`);
    const chunkData = (hash) => Buffer.from(database.prepare(
      'SELECT data FROM chunks WHERE hash = ?',
    ).get(hash).data);
    const root = deserialize(chunkData(checkpoint.stateHash));
    const shell = deserialize(brotliDecompressSync(chunkData(root.shellHash)));
    const reversedNodes = [];
    for (let hash = root.historyHeadHash; hash;) {
      const node = deserialize(chunkData(hash));
      reversedNodes.push(node);
      hash = node.parentHash;
    }
    const past = [];
    for (const node of reversedNodes.reverse()) {
      for (const reference of node.segments) {
        past.push(...deserialize(brotliDecompressSync(chunkData(reference.hash))));
      }
    }
    database.close();
    const checkpointState = { ...shell, world: { ...shell.world, past } };
    const exact = assertExact(checkpointState, `${checkpointRunId} m${checkpointMonth}`);
    legacyObserveFunctionalBuildings(checkpointState);
    observeFunctionalBuildings(checkpointState);
    const checkpointLegacyTimes = [];
    const checkpointCandidateTimes = [];
    checkpointLegacyTimes.push(measure(() => legacyObserveFunctionalBuildings(checkpointState)));
    checkpointCandidateTimes.push(measure(() => observeFunctionalBuildings(checkpointState)));
    checkpointCandidateTimes.push(measure(() => observeFunctionalBuildings(checkpointState)));
    checkpointLegacyTimes.push(measure(() => legacyObserveFunctionalBuildings(checkpointState)));
    checkpointLegacyTimes.push(measure(() => legacyObserveFunctionalBuildings(checkpointState)));
    checkpointCandidateTimes.push(measure(() => observeFunctionalBuildings(checkpointState)));
    checkpointLegacyTimes.sort((left, right) => left - right);
    checkpointCandidateTimes.sort((left, right) => left - right);
    const checkpointLegacyMedianMs = checkpointLegacyTimes[1];
    const checkpointCandidateMedianMs = checkpointCandidateTimes[1];
    assert.ok(checkpointCandidateMedianMs < checkpointLegacyMedianMs * 0.6,
      `m${checkpointMonth} 候选中位耗时应低于旧参考 60%：legacy=${checkpointLegacyMedianMs.toFixed(2)}ms candidate=${checkpointCandidateMedianMs.toFixed(2)}ms`);
    checkpointProjection = {
      runId: checkpointRunId,
      month: checkpointMonth,
      events: past.length,
      facilities: exact.projection.length,
      projectionSha256: exact.hash,
      legacyMedianMs: Number(checkpointLegacyMedianMs.toFixed(2)),
      candidateMedianMs: Number(checkpointCandidateMedianMs.toFixed(2)),
      reductionPercent: Number(((1 - checkpointCandidateMedianMs / checkpointLegacyMedianMs) * 100).toFixed(2)),
    };
  }

  console.log(JSON.stringify({
    result: 'functional building projection index tests passed',
    directedProjectionSha256: directed.hash,
    scaleProjectionSha256: scaleExact.hash,
    scaleFixture: {
      actions: scaleFacts.length,
      facilities: scaleExact.projection.length,
      legacyMedianMs: Number(legacyMedianMs.toFixed(2)),
      candidateMedianMs: Number(candidateMedianMs.toFixed(2)),
      reductionPercent: Number(((1 - candidateMedianMs / legacyMedianMs) * 100).toFixed(2)),
    },
    ...(checkpointProjection ? { checkpointProjection } : {}),
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
