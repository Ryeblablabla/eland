import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-emergent-era-observer-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');

try {
  writeFileSync(entryPath, `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export {
      DEVELOPMENT_ERA_LABELS,
      civilizationDevelopmentEvidenceState,
      highestSatisfiedDevelopmentEra,
      normalizeDevelopmentEra,
      observeAdoptedWorkPractices,
      reduceCivilizationDevelopmentStability,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/era-progression.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
  `);
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const observer = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    DEVELOPMENT_ERA_LABELS,
    Material,
    civilizationDevelopmentEvidenceState,
    createInitialState,
    highestSatisfiedDevelopmentEra,
    normalizeDevelopmentEra,
    observeAdoptedWorkPractices,
    reduceCivilizationDevelopmentStability,
  } = observer;

  assert.equal(normalizeDevelopmentEra('modern-civilization'), 'modern-civilization');
  assert.equal(DEVELOPMENT_ERA_LABELS['modern-civilization'], '现代文明');

  const capability = (key, stage = 'hypothesis') => ({
    key,
    stage,
    successfulBatchEventIds: [],
    failedBatchEventIds: [],
    producerIds: [],
    adoptedActionEventIds: [],
    productionSiteMaterialIds: [],
    supportingInstitutionKeys: [],
  });
  const hypotheses = [
    capability('processed-wood'),
    capability('masonry-stone'),
    capability('bronze'),
    capability('iron'),
  ];
  const modernGates = civilizationDevelopmentEvidenceState({
    materialCapabilities: hypotheses,
    settledCultivationEstablished: false,
    storedFoodUnits: 0,
    facilities: [],
    functionalInstitutionCount: 0,
    modernElectricalPowerObserved: true,
    modernComparableMeasurementObserved: true,
    modernIndependentRecordReuseObserved: true,
  });
  assert.equal(highestSatisfiedDevelopmentEra(modernGates), 'modern-civilization',
    '完整的现代能力证据应被观察为真实最高阶段');
  assert.equal(reduceCivilizationDevelopmentStability(60, 'modern-civilization', {
    observerVersion: null,
    currentEra: 'ancient-civilization',
    historicalPeakEra: 'ancient-civilization',
    candidateEra: 'ancient-civilization',
    candidateSinceMonth: 48,
  }).currentEra, 'modern-civilization');

  const state = createInitialState(20260904, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 3;
  const workId = 'work:1:1:1';
  const [firstActor, secondActor] = state.people;
  assert.ok(firstActor && secondActor);
  const work = {
    version: 'works-v1',
    id: workId,
    position: { x: 1, y: 1, z: 1 },
    arrangement: 'support',
    components: [{ materialId: Material.Wood, quantity: 4 }],
    condition: 100,
    profile: { cover: 60, rigidity: 50, stability: 55 },
    anchorMaterialId: Material.Wood,
    // Deliberately false semantics: neither this text nor functionKey may
    // fabricate electrical capability.
    summary: '自动电力站与现代实验室',
    builderIds: [firstActor.id],
    createdAtMonth: 0,
    lastTouchedAtMonth: 0,
    sourceEventIds: ['build-work'],
    useReceipts: [],
  };
  const makeUse = (id, atMonth, actorId, witnessIds = []) => ({
    id,
    kind: 'action',
    atMonth,
    orderInMonth: 1,
    actionTick: atMonth,
    cellId: 1,
    fromCellId: 1,
    toCellId: 1,
    fromZ: 1,
    toZ: 1,
    pathSegment: [1],
    who: actorId,
    cause: 'intent',
    status: 'completed',
    action: {
      kind: 'act',
      operation: 'combine',
      targets: [{ kind: 'voxel', position: { x: 1, y: 1, z: 1 } }],
      method: '在造物上实际处理材料',
    },
    result: '已提交材料变化',
    diff: {
      workId,
      outputMaterialId: Material.Plank,
      witnessIds,
    },
  });
  const uses = [
    makeUse('work-use-1', 1, firstActor.id, [secondActor.id]),
    makeUse('work-use-2', 2, secondActor.id),
    makeUse('work-use-3', 3, firstActor.id),
  ];
  work.useReceipts = uses.map((event, index) => ({
    version: 'work-use-receipt-v1',
    id: `receipt-${index}`,
    workId,
    kind: index === 0 ? 'demonstration' : 'use',
    // Deliberately claims power; structured source events only contain a
    // material transformation and must win over this open vocabulary.
    functionKey: 'powered-service',
    actorId: event.who,
    witnessIds: event.diff.witnessIds,
    atMonth: event.atMonth,
    sourceEventId: event.id,
    evidencePaths: ['diff.outputMaterialId'],
  }));
  state.world.works = [work];
  state.world.past.push(...uses);

  const [observedWork] = observeAdoptedWorkPractices(state);
  assert.deepEqual(observedWork.constructionEventIds, ['build-work']);
  assert.deepEqual(observedWork.useEventIds, uses.map((event) => event.id));
  assert.equal(observedWork.capabilities.find((item) => item.key === 'material-transformation')?.established, true,
    '真实使用、多人采用、示范和持续跨度应形成开放造物能力证据');
  assert.equal(observedWork.capabilities.some((item) => item.key === 'powered-service'), false,
    '造物 summary/functionKey 不得伪造功能证据');
  assert.equal(observedWork.useEventIds.includes('build-work'), false,
    '建造与使用必须是两类证据');

  const emergentAgrarianGates = civilizationDevelopmentEvidenceState({
    materialCapabilities: hypotheses,
    settledCultivationEstablished: true,
    storedFoodUnits: 12,
    facilities: [],
    adoptedWorks: [observedWork],
    functionalInstitutionCount: 0,
  });
  assert.equal(highestSatisfiedDevelopmentEra(emergentAgrarianGates), 'agrarian-settlement',
    '无预置设施名的功能实践也能支撑定居阶段观察');

  const emergentAncientGates = civilizationDevelopmentEvidenceState({
    materialCapabilities: hypotheses.map((item) => item.key === 'bronze'
      ? capability('bronze', 'repeatable')
      : item),
    settledCultivationEstablished: false,
    storedFoodUnits: 0,
    facilities: [],
    adoptedWorks: [observedWork],
    functionalInstitutionCount: 0,
  });
  assert.equal(highestSatisfiedDevelopmentEra(emergentAncientGates), 'ancient-civilization',
    '可回放的青铜生产与开放工场采用可以替代唯一铸造设施名称');

  process.stdout.write('Emergent era observer tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
