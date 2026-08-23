import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-player-narrative-'));
const bundlePath = path.join(temporaryDirectory, 'player-narrative.mjs');
const enhancementBundlePath = path.join(temporaryDirectory, 'narrative-enhancements.mjs');
const projectionBundlePath = path.join(temporaryDirectory, 'society-projection.mjs');
const frameProjectorBundlePath = path.join(temporaryDirectory, 'frame-history-projector.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/projection/player-narrative.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/narrative-enhancements.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${enhancementBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/eland-session/frame-history-projector.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${frameProjectorBundlePath}`,
  ], { stdio: 'pipe' });
  const projectionTestEntry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { toAgentHistory, toSocietyState } from ${JSON.stringify(path.resolve('src/game/eland/adapter.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=society-projection-test-entry.ts', `--outfile=${projectionBundlePath}`,
  ], { input: projectionTestEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { playerTextForEvent, projectPlayerNarrative } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { summarizePlayerNarrativeEntries } = await import(`${pathToFileURL(enhancementBundlePath).href}?test=${Date.now()}`);
  const { projectChronicle, withCivilizationEntries } = await import(`${pathToFileURL(frameProjectorBundlePath).href}?test=${Date.now()}`);
  const { createInitialState, Material, setVoxel, toAgentHistory, toSocietyState } = await import(`${pathToFileURL(projectionBundlePath).href}?test=${Date.now()}`);

  const visualProjectionState = createInitialState(20260822, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const berryGatherer = visualProjectionState.people[0];
  const cropHarvester = visualProjectionState.people[1];
  const blockedGatherer = visualProjectionState.people[2];
  const separateFact = (id, actor, sourceMaterialId, replacementMaterialId, outputs, orderInMonth) => {
    const x = actor.position.cellId % visualProjectionState.world.grid.width;
    const y = Math.floor(actor.position.cellId / visualProjectionState.world.grid.width);
    const z = Math.max(0, actor.position.z - 1);
    setVoxel(visualProjectionState.world.grid, x, y, z, replacementMaterialId);
    return {
      id, kind: 'action', atMonth: visualProjectionState.clock.elapsedMonths, orderInMonth,
      actionTick: orderInMonth, cellId: actor.position.cellId, who: actor.id, cause: 'intent',
      action: {
        kind: 'act', operation: 'separate',
        targets: [{ kind: 'voxel', position: { x, y, z } }], toolStackId: `consumed-tool-${id}`,
      },
      fromCellId: actor.position.cellId, toCellId: actor.position.cellId,
      fromZ: actor.position.z, toZ: actor.position.z, pathSegment: [actor.position.cellId],
      status: 'completed', result: '分离动作已完成',
      diff: { sourceMaterialId, toolMaterialId: Material.StoneHoe, outputs },
    };
  };
  const berryGatherFact = separateFact(
    'visual-berry-gather', berryGatherer, Material.BerryBush, Material.Shrub,
    [{ materialId: Material.Food, quantity: 2 }, { materialId: Material.Seed, quantity: 1 }], 1,
  );
  const cropHarvestFact = separateFact(
    'visual-crop-harvest', cropHarvester, Material.CropMature, Material.ExhaustedSoil,
    [{ materialId: Material.Food, quantity: 5 }, { materialId: Material.Seed, quantity: 2 }], 2,
  );
  const blockedGatherFact = separateFact(
    'visual-blocked-berry-gather', blockedGatherer, Material.BerryBush, Material.CropMature, [], 3,
  );
  blockedGatherFact.status = 'blocked';
  blockedGatherFact.result = '野果丛目前无法徒手分离';
  blockedGatherFact.diff = { materialId: Material.BerryBush };
  berryGatherer.currentActionText = '建立固定耕地';
  cropHarvester.currentActionText = '处理眼前植物';
  blockedGatherer.currentActionText = '处理眼前植物';
  visualProjectionState.world.past.push(berryGatherFact, cropHarvestFact, blockedGatherFact);
  const projectedSociety = toSocietyState(visualProjectionState);
  const berryVisual = projectedSociety.agents.find((agent) => agent.id === berryGatherer.id);
  const cropVisual = projectedSociety.agents.find((agent) => agent.id === cropHarvester.id);
  const blockedVisual = projectedSociety.agents.find((agent) => agent.id === blockedGatherer.id);
  assert.equal(berryVisual?.visualAction?.sourceMaterialId, Material.BerryBush,
    '野果采集后体素即使已经变成灌木，视觉投影仍须读取 ActionFact 源材质');
  assert.equal(berryVisual?.visualAction?.materialId, Material.BerryBush);
  assert.equal(berryVisual?.visualAction?.toolMaterialId, Material.StoneHoe,
    '动作后工具栈不在背包时，视觉投影仍须读取 ActionFact 的工具事实');
  assert.equal(berryVisual?.doing, '采集野果', '有工具的野果采集不能显示为建立耕地');
  assert.equal(cropVisual?.visualAction?.sourceMaterialId, Material.CropMature,
    '收割后体素即使已经变成贫瘠土，视觉投影仍须保留成熟作物来源');
  assert.equal(cropVisual?.doing, '收割成熟作物');
  assert.equal(blockedVisual?.visualAction?.sourceMaterialId, Material.BerryBush,
    '旧受阻事实只有 diff.materialId 时仍须冻结当时来源，不能回读后来变化的体素');
  assert.deepEqual(blockedVisual?.visualAction?.materialIds, [Material.BerryBush]);
  assert.equal(blockedVisual?.doing, '采集野果');
  assert.equal(
    playerTextForEvent(visualProjectionState, berryGatherFact),
    `${berryGatherer.name}采集了野果，得到2份食物和1份种子。`,
  );
  assert.equal(
    playerTextForEvent(visualProjectionState, cropHarvestFact),
    `${cropHarvester.name}收割了成熟作物，得到5份食物和2份种子。`,
  );
  const personalAttackFact = {
    id: 'visual-wolf-attack', kind: 'environment', change: 'animal',
    atMonth: visualProjectionState.clock.elapsedMonths, orderInMonth: 4,
    cellId: berryGatherer.position.cellId, who: berryGatherer.id,
    result: `狼袭击${berryGatherer.name}并造成伤害`,
    diff: {
      process: 'attack-human', animalId: 'animal-wolf-history', animalSpeciesId: 'wolf',
      victimId: berryGatherer.id, damage: 12, healthBefore: 72, healthAfter: 60,
      woundStageBefore: 0, woundStageAfter: 2,
    },
  };
  visualProjectionState.world.past.push(personalAttackFact);
  const personalAttackHistory = toAgentHistory(visualProjectionState, berryGatherer.id)?.events
    .find((event) => event.id === personalAttackFact.id);
  assert.equal(personalAttackHistory?.label, '遭遇野兽袭击', '真实 attack-human 事实必须进入人物历史');
  assert.equal(personalAttackHistory?.summary, `狼袭击了${berryGatherer.name}，使其受伤。`);

  const detailedBodyFact = {
    id: 'visual-detailed-body-change', kind: 'environment', change: 'body',
    atMonth: visualProjectionState.clock.elapsedMonths, orderInMonth: 5,
    cellId: berryGatherer.position.cellId, who: berryGatherer.id,
    result: `${berryGatherer.name}的身体储备发生显著变化`,
    diff: {
      health: 73, hydration: 23.5, nutrition: 46.8, healthDelta: -3,
      bodyBefore: { health: 76, hydration: 27, nutrition: 48 },
      bodyAfter: { health: 73, hydration: 23.5, nutrition: 46.8 },
      bodyCauseCodes: ['dehydration', 'heat-exposure'],
    },
  };
  const legacyBodyFact = {
    id: 'visual-legacy-body-change', kind: 'environment', change: 'body',
    atMonth: visualProjectionState.clock.elapsedMonths, orderInMonth: 6,
    cellId: berryGatherer.position.cellId, who: berryGatherer.id,
    result: `${berryGatherer.name}的身体储备发生显著变化`,
    diff: { health: 71, hydration: 22, nutrition: 41, healthDelta: -2 },
  };
  visualProjectionState.world.past.push(detailedBodyFact, legacyBodyFact);
  const detailedBodyHistory = toAgentHistory(visualProjectionState, berryGatherer.id)?.events
    .find((event) => event.id === detailedBodyFact.id);
  const legacyBodyHistory = toAgentHistory(visualProjectionState, berryGatherer.id)?.events
    .find((event) => event.id === legacyBodyFact.id);
  assert.equal(detailedBodyHistory?.label, '身体恶化');
  assert.equal(
    detailedBodyHistory?.summary,
    `${berryGatherer.name}身体储备下降：健康 76→73，水分 27→23.5，营养 48→46.8；原因：缺水、炎热暴露。`,
    '新身体事实应展示前后数值和权威原因',
  );
  assert.equal(legacyBodyHistory?.label, '身体恶化');
  assert.equal(
    legacyBodyHistory?.summary,
    `${berryGatherer.name}当前身体储备：健康 71，水分 22，营养 41；健康变化 -2；原因：缺水。`,
    '旧存档没有身体前值时仍应展示已有终值和可推断警戒项',
  );

  const state = {
    branchId: 'main',
    clock: { elapsedMonths: 51 },
    world: { past: [] },
    civilization: { number: 141 },
    people: [
      { id: 'galileo', name: '伽利略', sex: 'male', knowledge: [] },
      { id: 'freyja', name: '芙蕾雅', sex: 'female', knowledge: [] },
      { id: 'artemis', name: '阿尔忒弥斯', sex: 'female', knowledge: [] },
    ],
    intents: [
      { id: 'observe-plank', summary: '持续观察木板' },
      { id: 'collect-wood', summary: '取得木材' },
    ],
    projects: [],
    agreements: [],
  };
  const events = [
    {
      id: 'decision-observe', kind: 'decision', atMonth: 51, orderInMonth: 1, cellId: 4,
      who: 'galileo', intentId: 'observe-plank', usedModel: false,
      decision: { kind: 'start', optionId: 'observe', reason: '眼前物质尚未形成可靠认识' },
      result: '决定：持续观察木板',
    },
    {
      id: 'action-observe', kind: 'action', atMonth: 51, orderInMonth: 2, actionTick: 1, cellId: 4,
      who: 'galileo', intentId: 'observe-plank', cause: 'intent', action: { kind: 'attend', target: { kind: 'drop', dropId: 'plank' } },
      fromCellId: 4, toCellId: 4, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '观察并辨认了木板', diff: {},
    },
    {
      id: 'decision-collect', kind: 'decision', atMonth: 51, orderInMonth: 3, cellId: 7,
      who: 'freyja', intentId: 'collect-wood', usedModel: false,
      decision: { kind: 'start', optionId: 'collect', reason: '看见地上的木材' },
      result: '决定：取得木材',
    },
    {
      id: 'action-walk', kind: 'action', atMonth: 51, orderInMonth: 4, actionTick: 1, cellId: 7,
      who: 'freyja', intentId: 'collect-wood', cause: 'intent', action: { kind: 'move', toCellId: 8 },
      fromCellId: 7, toCellId: 8, fromZ: 1, toZ: 1, pathSegment: [8], status: 'completed',
      result: '沿可容身空间到达格 8, 8 的高度 1', diff: {},
    },
    {
      id: 'action-collect', kind: 'action', atMonth: 51, orderInMonth: 5, actionTick: 2, cellId: 8,
      who: 'freyja', intentId: 'collect-wood', cause: 'intent',
      action: { kind: 'transfer', materialId: 13, quantity: 2, from: { kind: 'ground', cellId: 8 }, to: { kind: 'person', personId: 'freyja' } },
      fromCellId: 8, toCellId: 8, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '木材 × 2 改变了持有者', diff: { materialId: 13, quantity: 2, authorized: true },
    },
    {
      id: 'action-eat', kind: 'action', atMonth: 51, orderInMonth: 6, actionTick: 2, cellId: 12,
      who: 'artemis', cause: 'survival-reflex', action: { kind: 'act', operation: 'ingest', targets: [] },
      fromCellId: 12, toCellId: 12, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '摄入了食物', diff: { materialId: 21 },
    },
    {
      id: 'action-talk', kind: 'action', atMonth: 51, orderInMonth: 7, actionTick: 2, cellId: 12,
      who: 'galileo', cause: 'intent',
      action: { kind: 'communicate', audience: ['freyja'], channel: 'voice', content: { id: 'claim-1', kind: 'claim', summary: '我在附近找到了木材。' } },
      fromCellId: 12, toCellId: 12, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '伽利略对芙蕾雅表达：claim', diff: {},
    },
    {
      id: 'action-reproduce-failed', kind: 'action', atMonth: 51, orderInMonth: 8, actionTick: 3, cellId: 12,
      who: 'galileo', cause: 'intent',
      action: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: 'freyja' }] },
      fromCellId: 12, toCellId: 12, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '生殖尝试未进入妊娠', diff: { conceived: false },
    },
  ];
  const originalEvents = structuredClone(events);
  const personalText = events.map((event) => playerTextForEvent(state, event)).join('\n');
  const entries = projectPlayerNarrative(state, events, 8);

  assert.match(personalText, /伽利略仔细观察后，认出了木板。/);
  assert.match(personalText, /芙蕾雅捡起了2份木材。/);
  assert.match(personalText, /阿尔忒弥斯吃下了1份食物。/);
  assert.match(personalText, /伽利略对芙蕾雅说：我在附近找到了木材。/);
  assert.match(personalText, /伽利略和芙蕾雅想要个孩子，但芙蕾雅没有怀上。/);
  assert.deepEqual(entries, [], '赶路、搬运、吃饭、普通对话和失败尝试不得进入文明历史');
  assert.deepEqual(events, originalEvents, '玩家叙事只能投影事件，不能改写权威事实');

  const legacyWeatherWithoutTransitionEvidence = projectPlayerNarrative(state, [{
    id: 'weather-7', kind: 'environment', change: 'weather', atMonth: 7, orderInMonth: 0, cellId: 0,
    result: '本月天气转为晴朗', diff: { kind: 'clear' },
  }], 4);
  assert.deepEqual(
    legacyWeatherWithoutTransitionEvidence,
    [],
    '缺少前态与 episode 来源的旧天气日志不能冒充可证实的天气转换',
  );

  const stormTransition = {
    id: 'weather-storm-8', kind: 'environment', change: 'weather', atMonth: 8, orderInMonth: 0, cellId: 0,
    result: '本月天气转为风暴',
    diff: { kind: 'storm', intensity: 3, previousKind: 'clear', previousIntensity: 1, episodeStarted: true },
  };
  const stormHistory = projectPlayerNarrative(
    { ...state, world: { ...state.world, past: [stormTransition] } },
    [stormTransition],
    4,
  );
  assert.equal(stormHistory[0].text, '天气由晴朗转为风暴。', '真实天气过程转换必须进入自然历史');
  assert.match(stormHistory[0].detail, /强度 1→3/u);
  const initialStorm = {
    ...stormTransition,
    id: 'weather-initial-storm', atMonth: 1,
  };
  assert.equal(
    projectPlayerNarrative(
      { ...state, world: { ...state.world, past: [initialStorm] } },
      [initialStorm],
      4,
    )[0].text,
    '文明开端天气为风暴。',
    '首月天气只能记录文明开端的天气，不能把初始化晴朗写成真实前史',
  );
  const lowImpactRainTransition = {
    ...stormTransition,
    id: 'weather-low-impact-rain',
    diff: { kind: 'rain', intensity: 1, previousKind: 'clear', previousIntensity: 1, episodeStarted: true },
  };
  assert.deepEqual(
    projectPlayerNarrative(
      { ...state, world: { ...state.world, past: [lowImpactRainTransition] } },
      [lowImpactRainTransition],
      4,
    ),
    [],
    '普通低强度降雨与雾气转换不应每几个月刷入文明历史',
  );
  const ordinaryIntensityDrift = {
    ...stormTransition,
    id: 'weather-storm-drift-9', atMonth: 9,
    result: '本月风暴强度升至3',
    diff: { kind: 'storm', intensity: 3, previousIntensity: 2, episodeStarted: false },
  };
  assert.deepEqual(
    projectPlayerNarrative(
      { ...state, world: { ...state.world, past: [ordinaryIntensityDrift] } },
      [ordinaryIntensityDrift],
      4,
    ),
    [],
    '同一天气过程的普通一级强度漂移不应逐次刷入历史',
  );
  const highImpactStorm = {
    ...ordinaryIntensityDrift,
    id: 'weather-storm-severe-10', atMonth: 10,
    result: '本月风暴强度升至2',
    diff: { kind: 'storm', intensity: 2, previousIntensity: 1, episodeStarted: false },
  };
  assert.equal(
    projectPlayerNarrative(
      { ...state, world: { ...state.world, past: [highImpactStorm] } },
      [highImpactStorm],
      4,
    )[0].text,
    '风暴强度升至 2。',
    '天气跨入领域已有的高影响强度时必须形成自然历史转折',
  );
  const originalWeatherFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('自然历史不应调用模型'); };
  try {
    assert.deepEqual(
      await summarizePlayerNarrativeEntries(
        { ...state, world: { ...state.world, past: [stormTransition] } },
        stormHistory,
      ),
      stormHistory,
      '天气转换的规则事实与强度详情必须原样保留',
    );
  } finally {
    globalThis.fetch = originalWeatherFetch;
  }

  const birth = projectPlayerNarrative(state, [{
    id: 'birth-52', kind: 'environment', change: 'body', atMonth: 52, orderInMonth: 9, cellId: 12,
    who: 'freyja', result: '芙蕾雅生下了艾拉', diff: { bornPersonId: 'aila', bornPersonName: '艾拉' },
  }], 4);
  assert.equal(birth.length, 1);
  assert.equal(birth[0].text, '芙蕾雅生下了艾拉。');

  const nonFatalWolfAttack = {
    id: 'wolf-attack-survived', kind: 'environment', change: 'animal', atMonth: 49, orderInMonth: 3, cellId: 4,
    who: 'galileo', result: '狼袭击伽利略并造成伤害',
    diff: {
      process: 'attack-human', animalId: 'wolf-history', animalSpeciesId: 'wolf', victimId: 'galileo', damage: 12,
      healthBefore: 52, healthAfter: 40, woundStageBefore: 0, woundStageAfter: 2,
    },
  };
  const attackEntries = projectPlayerNarrative(
    { ...state, world: { ...state.world, past: [nonFatalWolfAttack] } },
    [nonFatalWolfAttack],
    4,
  );
  assert.equal(attackEntries.length, 1, '真实野兽袭击必须进入文明历史');
  assert.equal(attackEntries[0].text, '狼袭击了伽利略，使其受伤。');
  assert.match(attackEntries[0].detail, /伤害/u);
  assert.match(attackEntries[0].detail, /健康值 52→40/u);

  const fatalWolfAttack = {
    ...nonFatalWolfAttack,
    id: 'wolf-attack-fatal', atMonth: 51, orderInMonth: 20,
    result: '狼袭击伽利略并造成致命伤害',
    diff: { ...nonFatalWolfAttack.diff, healthBefore: 10, healthAfter: 0 },
  };
  const wolfDeath = {
    id: 'death-after-wolf-attack', kind: 'environment', change: 'death', atMonth: 51, orderInMonth: 21, cellId: 4,
    who: 'galileo', result: '伽利略在第 51 月死亡，遗体和私有背包留在原地',
    diff: {
      personId: 'galileo', cause: 'body-failure', healthBeforeDeath: 0,
      sourceEventIds: ['unresolved-condition-evidence', fatalWolfAttack.id],
    },
  };
  const fatalEntries = projectPlayerNarrative(
    { ...state, world: { ...state.world, past: [fatalWolfAttack, wolfDeath] } },
    [fatalWolfAttack, wolfDeath],
    4,
  );
  assert.equal(fatalEntries.length, 1, '同月袭击与其导致的死亡必须合并为一条历史');
  assert.equal(fatalEntries[0].text, '伽利略被狼袭击致死，随身物品留在原地。');
  assert.deepEqual(
    fatalEntries[0].sourceEventIds,
    ['unresolved-condition-evidence', fatalWolfAttack.id, wolfDeath.id],
    '合并后的死亡历史必须保留死亡事实和全部因果来源 ID',
  );
  assert.match(fatalEntries[0].detail, /狼袭击伽利略并造成致命伤害/u);
  assert.match(fatalEntries[0].detail, /健康值 10→0/u);
  const originalCausalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('生死因果纪事不应调用模型'); };
  try {
    assert.deepEqual(
      await summarizePlayerNarrativeEntries(
        { ...state, world: { ...state.world, past: [fatalWolfAttack, wolfDeath] } },
        fatalEntries,
      ),
      fatalEntries,
      '死亡与袭击的规则因果文案必须原样保留，不得交给模型改写',
    );
  } finally {
    globalThis.fetch = originalCausalFetch;
  }

  const crowdedFatalEvents = [fatalWolfAttack, wolfDeath, ...Array.from({ length: 5 }, (_, index) => ({
    id: `crowded-birth-${index}`, kind: 'environment', change: 'body', atMonth: 51, orderInMonth: 22 + index, cellId: 4,
    who: 'freyja', result: `芙蕾雅生下了孩子${index + 1}`,
    diff: { bornPersonId: `crowded-child-${index}`, bornPersonName: `孩子${index + 1}` },
  }))];
  const crowdedFatalEntries = projectPlayerNarrative(
    { ...state, world: { ...state.world, past: crowdedFatalEvents } },
    crowdedFatalEvents,
    4,
  );
  assert.ok(
    crowdedFatalEntries.some((entry) => entry.sourceEventIds.includes(wolfDeath.id)),
    '同月有 5 条以上候选纪事时，死亡仍必须进入有限的文明历史名额',
  );

  const laterDeath = {
    ...wolfDeath,
    id: 'death-after-earlier-wolf-attack', atMonth: 55, orderInMonth: 9,
    result: '伽利略在第 55 月死亡，遗体和私有背包留在原地',
    diff: { ...wolfDeath.diff, healthBeforeDeath: 4, sourceEventIds: [nonFatalWolfAttack.id] },
  };
  const laterDeathEntries = projectPlayerNarrative(
    { ...state, world: { ...state.world, past: [nonFatalWolfAttack, laterDeath] } },
    [laterDeath],
    4,
  );
  assert.equal(
    laterDeathEntries[0].text,
    '伽利略去世了；生前曾遭狼袭击，随身物品留在原地。',
    '袭击后健康值仍大于零时只能保守陈述关联，不能把袭击写成直接死因',
  );
  const refreshedChronicle = projectChronicle([{
    entries: [{
      id: `narrative:${laterDeath.id}`,
      month: laterDeath.atMonth,
      text: '伽利略去世了，随身物品留在原地。',
      detail: laterDeath.result,
      tone: 'bad',
      kind: 'epoch',
      importance: 124,
      sourceEventIds: [laterDeath.id],
      actorIds: ['galileo'],
    }],
  }], {
    ...state,
    lastStep: [laterDeath],
    world: { ...state.world, past: [nonFatalWolfAttack, laterDeath] },
  });
  assert.equal(
    refreshedChronicle[0].text,
    laterDeathEntries[0].text,
    '旧会话中可精确识别的单条死亡纪事应在读取时刷新因果表述',
  );
  assert.deepEqual(refreshedChronicle[0].sourceEventIds, [nonFatalWolfAttack.id, laterDeath.id]);

  const destroyedState = {
    ...state,
    civilization: {
      ...state.civilization,
      status: 'ended',
      outcome: { kind: 'destroyed', cause: '伤病', atMonth: 51, summary: '所有人物死亡，文明毁灭于伤病。' },
    },
    world: { ...state.world, past: [fatalWolfAttack, wolfDeath] },
  };
  const endingEntries = withCivilizationEntries(destroyedState, [fatalWolfAttack, wolfDeath], fatalEntries);
  assert.equal(endingEntries.length, 1, '文明终局必须吸收带袭击证据的个人死亡纪事');
  assert.equal(endingEntries[0].text, '文明毁灭于伤病。');

  const eraTransition = projectPlayerNarrative(state, [{
    id: 'era-53', kind: 'environment', change: 'climate', atMonth: 53, orderInMonth: 1, cellId: 0,
    result: '乱纪元开始；本月地表处于寒冷环境',
    diff: { eraTransition: true, epoch: 'chaotic', kind: 'cold', severity: 6 },
  }, {
    id: 'birth-53', kind: 'environment', change: 'body', atMonth: 53, orderInMonth: 2, cellId: 12,
    who: 'freyja', result: '芙蕾雅生下了艾拉', diff: { bornPersonId: 'aila', bornPersonName: '艾拉' },
  }], 1);
  assert.equal(eraTransition.length, 1);
  assert.equal(eraTransition[0].text, '恒纪元结束，乱纪元开始，地表转为寒冷。', '纪元更迭必须优先于同月其他重大事件');
  const stableEraTransition = projectPlayerNarrative(state, [{
    id: 'era-54', kind: 'environment', change: 'climate', atMonth: 54, orderInMonth: 1, cellId: 0,
    result: '恒纪元开始；本月地表处于温和环境',
    diff: { eraTransition: true, epoch: 'stable', kind: 'temperate', severity: 1 },
  }], 4);
  assert.equal(stableEraTransition[0].text, '乱纪元结束，恒纪元开始，地表恢复温和。');
  const externalEraTransition = {
    id: 'era-external-55', kind: 'environment', change: 'climate', atMonth: 55, orderInMonth: 1, cellId: 0,
    result: '本月地表处于炎热环境',
    diff: {
      epochChanged: true, previousEpoch: 'stable', epoch: 'chaotic',
      climateKindChanged: true, previousKind: 'temperate', kind: 'heat',
      previousSeverity: 1, severity: 7,
    },
  };
  const externalEraHistory = projectPlayerNarrative(
    { ...state, world: { ...state.world, past: [externalEraTransition] } },
    [externalEraTransition],
    4,
  );
  assert.equal(externalEraHistory[0].text, '恒纪元结束，乱纪元开始，地表转为炎热。', '外部天象驱动的纪元转换也必须进入历史');
  const chaoticClimateShift = {
    ...externalEraTransition,
    id: 'climate-shift-56', atMonth: 56,
    result: '本月地表处于寒冷环境',
    diff: {
      previousEpoch: 'chaotic', epoch: 'chaotic',
      climateKindChanged: true, previousKind: 'heat', kind: 'cold',
      previousSeverity: 7, severity: 6,
    },
  };
  const chaoticClimateHistory = projectPlayerNarrative(
    { ...state, world: { ...state.world, past: [chaoticClimateShift] } },
    [chaoticClimateShift],
    4,
  );
  assert.equal(chaoticClimateHistory[0].text, '乱纪元中，地表气候由炎热转为寒冷。');
  const severityOnlyClimate = {
    ...chaoticClimateShift,
    id: 'climate-severity-57', atMonth: 57,
    result: '本月地表处于寒冷环境',
    diff: {
      previousEpoch: 'chaotic', epoch: 'chaotic', previousKind: 'cold', kind: 'cold',
      climateSeverityChanged: true, previousSeverity: 6, severity: 7,
    },
  };
  assert.deepEqual(
    projectPlayerNarrative(
      { ...state, world: { ...state.world, past: [severityOnlyClimate] } },
      [severityOnlyClimate],
      4,
    ),
    [],
    '只有严酷度逐月波动时不应刷入文明历史',
  );
  const initialChaoticClimate = {
    ...externalEraTransition,
    id: 'climate-initial-chaotic', atMonth: 1,
  };
  assert.equal(
    projectPlayerNarrative(
      { ...state, world: { ...state.world, past: [initialChaoticClimate] } },
      [initialChaoticClimate],
      4,
    )[0].text,
    '文明开端处于乱纪元，地表为炎热。',
    '首月天象只能记录文明开端所处纪元，不能虚构一个已经结束的纪元',
  );
  const originalClimateFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('气候自然历史不应调用模型'); };
  try {
    assert.deepEqual(
      await summarizePlayerNarrativeEntries(
        { ...state, world: { ...state.world, past: [chaoticClimateShift] } },
        chaoticClimateHistory,
      ),
      chaoticClimateHistory,
      '气候转换的规则事实与前后态必须原样保留',
    );
  } finally {
    globalThis.fetch = originalClimateFetch;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('纪元更迭不应调用模型'); };
  try {
    assert.deepEqual(
      await summarizePlayerNarrativeEntries(state, eraTransition),
      eraTransition,
      '只有纪元更迭时必须直接使用规则文本，不得请求模型',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const founding = projectPlayerNarrative(state, [{
    id: 'e-0-environment-founding-0', kind: 'environment', change: 'founding', atMonth: 0, orderInMonth: 0, cellId: 4,
    result: '开局先民共同抵达，并已形成基本的相互熟悉', diff: { participantIds: ['galileo', 'freyja', 'artemis'] },
  }], 4);
  assert.equal(founding[0].text, '第 141 号文明在自然地表上开始，3 位先民共同抵达。');
  assert.deepEqual(founding[0].actorIds, ['galileo', 'freyja', 'artemis']);

  const previousHeat = {
    id: 'heat-50', kind: 'environment', change: 'condition', atMonth: 50, orderInMonth: 9, cellId: 4,
    who: 'galileo', result: '伽利略的炎热加重', diff: { condition: 'heat', stage: 3 },
  };
  const repeatedHeat = {
    id: 'heat-51', kind: 'environment', change: 'condition', atMonth: 51, orderInMonth: 9, cellId: 4,
    who: 'galileo', result: '伽利略的炎热加重', diff: { condition: 'heat', stage: 3 },
  };
  assert.deepEqual(
    projectPlayerNarrative({ ...state, world: { past: [previousHeat, repeatedHeat] } }, [repeatedHeat], 4),
    [],
    '旧存档中同人同种状态的同阶段“加重”不应重复记史',
  );
  const unchangedIllness = {
    id: 'illness-51', kind: 'environment', change: 'condition', atMonth: 51, orderInMonth: 10, cellId: 4,
    who: 'galileo', result: '伽利略的疾病加重', diff: { condition: 'illness', fromStage: 2, stage: 2 },
  };
  assert.deepEqual(projectPlayerNarrative(state, [unchangedIllness], 4), [], 'fromStage 与 stage 相同时没有真正的病情升级');
  const previousIllness = {
    ...unchangedIllness, id: 'illness-40', atMonth: 40, diff: { condition: 'illness', stage: 2 },
  };
  const legacyIllness = {
    ...unchangedIllness, id: 'illness-51-legacy', diff: { condition: 'illness', stage: 2 },
  };
  assert.equal(
    projectPlayerNarrative({ ...state, world: { past: [previousIllness, legacyIllness] } }, [legacyIllness], 4).length,
    1,
    '旧存档的疾病事件可能经过治疗后复发，不得只按上一条环境事件去重',
  );
  const worsenedHeat = { ...repeatedHeat, id: 'heat-upgraded-51', diff: { condition: 'heat', fromStage: 2, stage: 3 } };
  assert.equal(projectPlayerNarrative(state, [worsenedHeat], 4)[0].text, '伽利略的炎热加重。', '真正跨阶段的加重必须保留');

  const placedGranary = {
    id: 'place-granary', kind: 'action', atMonth: 51, orderInMonth: 11, actionTick: 4, cellId: 4,
    who: 'galileo', cause: 'intent', action: { kind: 'act', operation: 'combine', targets: [] },
    fromCellId: 4, toCellId: 4, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
    result: '公共谷仓与空气结合为公共谷仓',
    diff: { inputMaterialId: 56, targetMaterialId: 0, outputMaterialId: 56, position: { x: 1, y: 1, z: 1 }, verifiedTechnique: true },
  };
  assert.equal(playerTextForEvent(state, placedGranary), '伽利略安放了公共谷仓。');
  const placedStone = {
    ...placedGranary, id: 'place-stone', result: '石与空气结合为石',
    diff: { inputMaterialId: 1, targetMaterialId: 0, outputMaterialId: 1, position: { x: 2, y: 1, z: 1 }, verifiedTechnique: true },
  };
  assert.equal(playerTextForEvent(state, placedStone), '伽利略把石头放在了搭建处。');
  const verifiedGranaryPlacement = {
    id: 'verify-granary-placement', kind: 'action', atMonth: 51, orderInMonth: 12, actionTick: 5, cellId: 4,
    who: 'galileo', cause: 'intent',
    action: {
      kind: 'attend', target: { kind: 'voxel', position: { x: 1, y: 1, z: 1 } },
      verification: { techniqueId: 'technique:combine:56:0:56', sourceEventId: 'place-granary', expectedMaterialId: 56 },
    },
    fromCellId: 4, toCellId: 4, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
    result: '核验了公共谷仓与空气可结合为公共谷仓',
    diff: { factId: 'technique:combine:56:0:56', verifiedTechnique: true, verifiedSourceEventId: 'place-granary', verifiedMaterialId: 56 },
  };
  assert.equal(
    playerTextForEvent({ ...state, world: { past: [placedGranary, verifiedGranaryPlacement] } }, verifiedGranaryPlacement),
    '伽利略确认公共谷仓可以直接安放。',
  );
  const woodToPlank = {
    ...placedGranary,
    id: 'wood-to-plank',
    result: '木材与空气结合为木板',
    diff: { inputMaterialId: 13, targetMaterialId: 0, outputMaterialId: 19, position: { x: 3, y: 1, z: 1 }, verifiedTechnique: true },
  };
  assert.equal(playerTextForEvent(state, woodToPlank), '伽利略把木材加工成木板，用于搭建。');
  const verifiedWoodToPlank = {
    ...verifiedGranaryPlacement,
    id: 'verify-wood-to-plank',
    action: {
      kind: 'attend', target: { kind: 'voxel', position: { x: 3, y: 1, z: 1 } },
      verification: { techniqueId: 'technique:combine:13:0:19', sourceEventId: 'wood-to-plank', expectedMaterialId: 19 },
    },
    result: '核验了木材与空气可结合为木板',
    diff: { factId: 'technique:combine:13:0:19', verifiedTechnique: true, verifiedSourceEventId: 'wood-to-plank', verifiedMaterialId: 19 },
  };
  assert.equal(
    playerTextForEvent({ ...state, world: { past: [woodToPlank, verifiedWoodToPlank] } }, verifiedWoodToPlank),
    '伽利略确认搭建时可以把木材加工成木板。',
  );

  const projectState = {
    ...state,
    projects: [{
      id: 'project-granary', status: 'completed', completedAtMonth: 51, completionEventIds: ['place-granary'],
      ownerId: 'galileo', contributorIds: ['freyja'], summary: '建立公共谷仓',
    }],
  };
  const projectEntries = projectPlayerNarrative(projectState, [placedGranary], 4);
  assert.equal(projectEntries.length, 1, '同源的项目完成与原子行动只保留项目句');
  assert.equal(projectEntries[0].text, '伽利略、芙蕾雅完成了“建立公共谷仓”。');
  assert.deepEqual(projectEntries[0].sourceEventIds, ['place-granary']);

  const companionState = {
    ...state,
    agreements: [{
      id: 'companion-a', proposal: { kind: 'companion', proposerId: 'galileo', partnerId: 'freyja', expiresAtMonth: 70 },
      proposedAtMonth: 10, acceptedAtMonth: 11, dueAtMonth: 35, coLocatedMonths: 12,
    }, {
      id: 'companion-b', proposal: { kind: 'companion', proposerId: 'freyja', partnerId: 'galileo', expiresAtMonth: 70 },
      proposedAtMonth: 10, acceptedAtMonth: 11, dueAtMonth: 35, coLocatedMonths: 12,
    }],
  };
  const companionEvents = [{
    id: 'companion-fulfilled-a', kind: 'agreement', agreementId: 'companion-a', change: 'fulfilled',
    atMonth: 51, orderInMonth: 12, cellId: 0, partyIds: ['galileo', 'freyja'], result: '双方在约定期内共同停留了 12 个月',
  }, {
    id: 'companion-fulfilled-b', kind: 'agreement', agreementId: 'companion-b', change: 'fulfilled',
    atMonth: 51, orderInMonth: 13, cellId: 0, partyIds: ['freyja', 'galileo'], result: '双方在约定期内共同停留了 12 个月',
  }];
  const originalCompanionEvents = structuredClone(companionEvents);
  const companionEntries = projectPlayerNarrative(companionState, companionEvents, 4);
  assert.equal(companionEntries.length, 1, '同月同参与者的镜像结伴约定应合并');
  assert.equal(companionEntries[0].text, '伽利略和芙蕾雅履行了结伴生活的约定。');
  assert.deepEqual(companionEntries[0].sourceEventIds, ['companion-fulfilled-a', 'companion-fulfilled-b']);
  assert.deepEqual(companionEvents, originalCompanionEvents, '约定归并不得改写事件');
  const separateCompanionState = {
    ...companionState,
    agreements: companionState.agreements.map((agreement, index) => index === 0 ? agreement : {
      ...agreement, proposedAtMonth: 22, acceptedAtMonth: 23, dueAtMonth: 47,
    }),
  };
  assert.equal(
    projectPlayerNarrative(separateCompanionState, companionEvents, 4).length,
    2,
    '同一对人物在不同约定周期形成的结伴事实不得误并',
  );

  const exchangeState = {
    ...state,
    agreements: [{
      id: 'exchange-a', proposal: {
        kind: 'exchange', offererId: 'galileo', partnerId: 'freyja',
        offererMaterialId: 13, offererQuantity: 1, partnerMaterialId: 20, partnerQuantity: 1,
      },
    }, {
      id: 'exchange-b', proposal: {
        kind: 'exchange', offererId: 'freyja', partnerId: 'galileo',
        offererMaterialId: 20, offererQuantity: 1, partnerMaterialId: 13, partnerQuantity: 1,
      },
    }],
  };
  const exchangeEvents = [{
    id: 'exchange-fulfilled-a', kind: 'agreement', agreementId: 'exchange-a', change: 'fulfilled',
    atMonth: 51, orderInMonth: 16, cellId: 0, partyIds: ['galileo', 'freyja'], result: '双方已完成交换',
  }, {
    id: 'exchange-fulfilled-b', kind: 'agreement', agreementId: 'exchange-b', change: 'fulfilled',
    atMonth: 51, orderInMonth: 17, cellId: 0, partyIds: ['freyja', 'galileo'], result: '双方已完成交换',
  }];
  assert.equal(
    projectPlayerNarrative(exchangeState, exchangeEvents, 4).length,
    2,
    '同月反向交换是两份独立协议，不得像结伴关系一样归并',
  );

  const duplicateBirths = [{
    id: 'birth-copy-a', kind: 'environment', change: 'body', atMonth: 51, orderInMonth: 14, cellId: 4,
    who: 'freyja', result: '芙蕾雅生下了艾拉', diff: { bornPersonId: 'aila', bornPersonName: '艾拉' },
  }, {
    id: 'birth-copy-b', kind: 'environment', change: 'body', atMonth: 51, orderInMonth: 15, cellId: 4,
    who: 'freyja', result: '芙蕾雅生下了艾拉', diff: { bornPersonId: 'aila', bornPersonName: '艾拉' },
  }];
  const duplicateBirthEntries = projectPlayerNarrative(state, duplicateBirths, 4);
  assert.equal(duplicateBirthEntries.length, 1, '同月完全相同文案只保留一条');
  assert.deepEqual(duplicateBirthEntries[0].sourceEventIds, ['birth-copy-a', 'birth-copy-b'], '合并后仍保留全部来源事件');
  console.log('player narrative projection ok');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
