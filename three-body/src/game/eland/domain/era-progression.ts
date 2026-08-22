import { Material, materialHas, type MaterialId } from './material';
import type {
  ActionFact,
  CivilizationDevelopmentObservation,
  DevelopmentEraKey,
  FunctionalBuildingObservation,
  MaterialCapabilityObservation,
  MaterialCapabilityStage,
  SimulationState,
} from './model';
import { isAlive } from './person';
import { cellId, cellsInRadius, voxelAt } from '../world/grid';

export const DEVELOPMENT_OBSERVER_VERSION = 'material-institution-era-v2' as const;

const ERA_ORDER: DevelopmentEraKey[] = [
  'primitive-tribe',
  'agrarian-settlement',
  'ancient-civilization',
  'medieval',
];

export const DEVELOPMENT_ERA_LABELS: Record<DevelopmentEraKey, string> = {
  'primitive-tribe': '原始部落',
  'agrarian-settlement': '农耕定居',
  'ancient-civilization': '古代文明',
  medieval: '中世纪',
};

const FACILITIES: ReadonlyMap<MaterialId, {
  kind: FunctionalBuildingObservation['kind'];
  functionSummary: string;
}> = new Map([
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

function actionFacts(state: SimulationState): ActionFact[] {
  return state.world.past.filter((event): event is ActionFact => event.kind === 'action');
}

function eventOutputIds(event: ActionFact): MaterialId[] {
  const direct = Number(event.diff.outputMaterialId);
  const outputs = Array.isArray(event.diff.outputs)
    ? event.diff.outputs.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const materialId = Number((raw as { materialId?: unknown }).materialId);
      return Number.isInteger(materialId) ? [materialId] : [];
    })
    : [];
  return [...new Set([...(Number.isInteger(direct) ? [direct] : []), ...outputs])];
}

function currentInstallation(state: SimulationState, event: ActionFact) {
  if (event.status !== 'completed' || event.action.kind !== 'act' || event.action.operation !== 'combine') return null;
  const materialId = Number(event.diff.outputMaterialId);
  const definition = FACILITIES.get(materialId);
  const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (!definition || ![position?.x, position?.y, position?.z].every((value) => Number.isInteger(Number(value)))) return null;
  const x = Number(position?.x);
  const y = Number(position?.y);
  const z = Number(position?.z);
  if (voxelAt(state.world.grid, x, y, z) !== materialId) return null;
  return { event, materialId, definition, x, y, z };
}

export function observeFunctionalBuildings(state: SimulationState): FunctionalBuildingObservation[] {
  const actions = actionFacts(state);
  const installations = new Map<string, NonNullable<ReturnType<typeof currentInstallation>> & { installationEventIds: string[] }>();
  for (const event of actions) {
    const installation = currentInstallation(state, event);
    if (!installation) continue;
    const { materialId, x, y, z } = installation;
    const id = `facility:${materialId}:${x}:${y}:${z}`;
    const existing = installations.get(id);
    if (existing) existing.installationEventIds.push(event.id);
    else installations.set(id, { ...installation, installationEventIds: [event.id] });
  }
  return [...installations.entries()].map(([id, installation]) => {
    const { materialId, definition, x, y, z, installationEventIds } = installation;
    const installedCell = cellId(x, y);
    const containerId = `container:${x}:${y}:${z}`;
    const installedAtMonth = Math.min(...installationEventIds.map((eventId) => actions.find((event) => event.id === eventId)?.atMonth ?? state.clock.elapsedMonths));
    const installationIds = new Set(installationEventIds);
    const uses = actions.filter((candidate) => candidate.status === 'completed'
      && candidate.atMonth >= installedAtMonth
      && !installationIds.has(candidate.id)
      && (
        Number(candidate.diff.facilityMaterialId) === materialId
        || (definition.kind === 'storage'
          && candidate.action.kind === 'transfer'
          && (candidate.action.from.kind === 'container' || candidate.action.to.kind === 'container')
          && (candidate.action.from.kind === 'container' ? candidate.action.from.containerId : candidate.action.to.kind === 'container' ? candidate.action.to.containerId : '') === containerId)
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
    } satisfies FunctionalBuildingObservation;
  });
}

interface CapabilityDefinition {
  key: MaterialCapabilityObservation['key'];
  products: MaterialId[];
  tools: MaterialId[];
  sites: MaterialId[];
  repeatableBatches: number;
  repeatableSpan: number;
  distributedProducers: number;
  distributedUses: number;
  institutionFragments: string[];
}

const CAPABILITIES: CapabilityDefinition[] = [
  {
    key: 'processed-wood',
    products: [Material.Plank, Material.WoodTool, Material.CouncilHearth, Material.Workshop, Material.Granary],
    tools: [Material.WoodTool],
    sites: [Material.CouncilHearth, Material.Workshop, Material.Granary],
    repeatableBatches: 3,
    repeatableSpan: 3,
    distributedProducers: 1,
    distributedUses: 8,
    institutionFragments: ['reserve', 'workshop', 'coordination'],
  },
  {
    key: 'masonry-stone',
    products: [Material.StoneTool, Material.StoneHoe, Material.Cistern, Material.Kiln, Material.Mill, Material.FiredBrick],
    tools: [Material.StoneTool, Material.StoneHoe],
    sites: [Material.Cistern, Material.Kiln, Material.Mill],
    repeatableBatches: 6,
    repeatableSpan: 6,
    distributedProducers: 2,
    distributedUses: 16,
    institutionFragments: ['reserve', 'water', 'workshop', 'land'],
  },
  {
    key: 'bronze',
    products: [Material.Copper, Material.Tin, Material.Bronze, Material.BronzeTool, Material.Foundry, Material.CivicHall],
    tools: [Material.BronzeTool],
    sites: [Material.Kiln, Material.Foundry, Material.CivicHall],
    repeatableBatches: 8,
    repeatableSpan: 12,
    distributedProducers: 2,
    distributedUses: 20,
    institutionFragments: ['metalwork', 'workshop', 'exchange', 'measure', 'apprentice'],
  },
  {
    key: 'iron',
    products: [Material.IronBloom, Material.Iron, Material.IronTool, Material.Smithy, Material.KeepCore],
    tools: [Material.IronTool],
    sites: [Material.Smithy, Material.KeepCore],
    repeatableBatches: 10,
    repeatableSpan: 18,
    distributedProducers: 2,
    distributedUses: 28,
    institutionFragments: ['metalwork', 'workshop', 'fuel', 'maintenance', 'apprentice'],
  },
];

const STAGE_ORDER: MaterialCapabilityStage[] = ['hypothesis', 'sample', 'repeatable', 'distributed', 'institutional'];

export function materialCapabilityAtLeast(
  capability: MaterialCapabilityObservation | undefined,
  stage: MaterialCapabilityStage,
): boolean {
  return Boolean(capability && STAGE_ORDER.indexOf(capability.stage) >= STAGE_ORDER.indexOf(stage));
}

export function observeMaterialCapabilities(state: SimulationState): MaterialCapabilityObservation[] {
  const actions = actionFacts(state);
  const institutions = state.derived.institutions ?? [];
  return CAPABILITIES.map((definition) => {
    const productSet = new Set(definition.products);
    const toolSet = new Set(definition.tools);
    const siteSet = new Set(definition.sites);
    const batches = actions.filter((event) => event.status === 'completed'
      && eventOutputIds(event).some((materialId) => productSet.has(materialId)));
    const failures = actions.filter((event) => event.status === 'blocked'
      && (eventOutputIds(event).some((materialId) => productSet.has(materialId))
        || (Array.isArray(event.diff.inputMaterialIds)
          && event.diff.inputMaterialIds.some((materialId) => productSet.has(Number(materialId))))));
    const adopted = actions.filter((event) => event.status === 'completed'
      && toolSet.has(Number(event.diff.toolMaterialId)));
    const sites = [...new Set(actions.flatMap((event) => {
      const facility = Number(event.diff.facilityMaterialId);
      const output = Number(event.diff.outputMaterialId);
      return [facility, output].filter((materialId) => siteSet.has(materialId));
    }))];
    const supportingInstitutionKeys = institutions
      .filter((institution) => definition.institutionFragments.some((fragment) => institution.key.includes(fragment)))
      .map((institution) => institution.key);
    const months = [...new Set(batches.map((event) => event.atMonth))].sort((left, right) => left - right);
    const span = months.length ? (months.at(-1) ?? 0) - months[0] + 1 : 0;
    const producers = [...new Set(batches.map((event) => event.who))];
    let stage: MaterialCapabilityStage = failures.length ? 'hypothesis' : 'hypothesis';
    if (batches.length >= 1) stage = 'sample';
    if (batches.length >= definition.repeatableBatches && span >= definition.repeatableSpan) stage = 'repeatable';
    if (stage === 'repeatable'
      && producers.length >= definition.distributedProducers
      && adopted.length >= definition.distributedUses
      && sites.length >= 1) stage = 'distributed';
    if (stage === 'distributed' && supportingInstitutionKeys.length >= 1) stage = 'institutional';
    return {
      key: definition.key,
      stage,
      successfulBatchEventIds: batches.map((event) => event.id),
      failedBatchEventIds: failures.map((event) => event.id),
      producerIds: producers,
      adoptedActionEventIds: adopted.map((event) => event.id),
      productionSiteMaterialIds: sites,
      supportingInstitutionKeys,
    };
  });
}

function eraRank(era: DevelopmentEraKey): number {
  return ERA_ORDER.indexOf(era);
}

function nextEra(era: DevelopmentEraKey): DevelopmentEraKey | null {
  return ERA_ORDER[eraRank(era) + 1] ?? null;
}

interface EstablishedCultivationEvidence {
  projectId: string;
  plantingEventIds: string[];
  harvestEventIds: string[];
}

/**
 * Retain cultivation as a learned production capability after harvested plots
 * recover to ordinary wet soil. A qualifying cycle must still be replayable
 * inside one completed settled-cultivation project; unrelated scattering never
 * becomes an era gate merely by accumulating action counts.
 */
function establishedCultivationEvidence(state: SimulationState): EstablishedCultivationEvidence | null {
  const factsById = new Map(actionFacts(state).map((event) => [event.id, event]));
  const projects = state.projects
    .filter((project) => project.status === 'completed'
      && project.desiredFunction === 'settled-cultivation'
      && project.completionEventIds.length > 0)
    .sort((left, right) => (left.completedAtMonth ?? Number.MAX_SAFE_INTEGER)
      - (right.completedAtMonth ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id));
  for (const project of projects) {
    if (!project.site) continue;
    const projectCells = new Set(cellsInRadius(project.site.cellId, 2));
    const projectActionIds = new Set(project.actionEventIds);
    const facts = [...new Set(project.completionEventIds)]
      .filter((eventId) => projectActionIds.has(eventId))
      .map((eventId) => factsById.get(eventId))
      .filter((event): event is ActionFact => event !== undefined);
    const plantingByPosition = new Map<string, ActionFact>();
    for (const event of facts) {
      if (event.status !== 'completed'
        || event.action.kind !== 'act'
        || event.action.operation !== 'combine'
        || Number(event.diff.outputMaterialId) !== Material.CropSprout) continue;
      const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
      if (![position?.x, position?.y, position?.z].every((value) => Number.isInteger(Number(value)))) continue;
      const x = Number(position?.x);
      const y = Number(position?.y);
      const z = Number(position?.z);
      if (!projectCells.has(cellId(x, y))) continue;
      const positionKey = `${x}:${y}:${z}`;
      if (!plantingByPosition.has(positionKey)) plantingByPosition.set(positionKey, event);
    }
    const harvests = facts.filter((event) => {
      if (event.status !== 'completed'
        || event.action.kind !== 'act'
        || event.action.operation !== 'separate'
        || Number(event.diff.sourceMaterialId) !== Material.CropMature) return false;
      const target = event.action.targets.find((candidate) => candidate.kind === 'voxel');
      if (!target) return false;
      const { x, y, z } = target.position;
      return projectCells.has(cellId(x, y)) && plantingByPosition.has(`${x}:${y}:${z}`);
    });
    if (plantingByPosition.size < 6 || harvests.length < 2) continue;
    return {
      projectId: project.id,
      plantingEventIds: [...plantingByPosition.values()].map((event) => event.id),
      harvestEventIds: harvests.map((event) => event.id),
    };
  }
  return null;
}

function eraGateState(
  state: SimulationState,
  indexTotal: number,
  capabilities: MaterialCapabilityObservation[],
  facilities: FunctionalBuildingObservation[],
) {
  const establishedCultivation = establishedCultivationEvidence(state);
  const storedFood = state.containers.reduce((sum, container) => sum + container.inventory.reduce((inner, stack) => (
    materialHas(stack.materialId, 'edible') ? inner + stack.quantity : inner
  ), 0), 0);
  const institutions = state.derived.institutions.length;
  const records = state.records.length;
  const capability = (key: MaterialCapabilityObservation['key']) => capabilities.find((candidate) => candidate.key === key);
  const activeUsed = (materialId: MaterialId, minimumUses = 1) => facilities.some((facility) => facility.materialId === materialId
    && facility.active && facility.useEventIds.length >= minimumUses);
  const crossGenerationTechniques = new Set(state.people.flatMap((person) => person.knowledge
    .filter((fact) => fact.kind === 'technique' && fact.confidence >= 55)
    .map((fact) => fact.id))).size && state.people.some((person) => person.generation > 0
      && person.knowledge.some((fact) => fact.kind === 'technique' && fact.confidence >= 55));
  return {
    'agrarian-settlement': [
      ['index:120', indexTotal >= 120],
      ['material:masonry-stone:distributed', materialCapabilityAtLeast(capability('masonry-stone'), 'distributed')],
      ['food:settled-cultivation-cycle', establishedCultivation !== null],
      ['food:stored-units:10', storedFood >= 10],
      ['facility:granary-used', activeUsed(Material.Granary, 2)],
      ['facility:early-core-used', activeUsed(Material.CouncilHearth, 1)],
      ['institution:early-functional:1', institutions >= 1],
    ],
    'ancient-civilization': [
      ['index:300', indexTotal >= 300],
      ['material:bronze:institutional', materialCapabilityAtLeast(capability('bronze'), 'institutional')],
      ['facility:foundry-used', activeUsed(Material.Foundry, 3)],
      ['facility:civic-hall-used', activeUsed(Material.CivicHall, 2)],
      ['institution:functional:2', institutions >= 2],
      ['history:records:2', records >= 2],
    ],
    medieval: [
      ['index:520', indexTotal >= 520],
      ['material:iron:institutional', materialCapabilityAtLeast(capability('iron'), 'institutional')],
      ['facility:smithy-used', activeUsed(Material.Smithy, 4)],
      ['facility:keep-core-used', activeUsed(Material.KeepCore, 2)],
      ['institution:functional:3', institutions >= 3],
      ['history:cross-generation-technique', crossGenerationTechniques],
    ],
  } as const;
}

export function observeCivilizationDevelopment(
  state: SimulationState,
  indexTotal: number,
): CivilizationDevelopmentObservation {
  const facilities = observeFunctionalBuildings(state);
  const materialCapabilities = observeMaterialCapabilities(state);
  const establishedCultivation = establishedCultivationEvidence(state);
  const gates = eraGateState(state, indexTotal, materialCapabilities, facilities);
  let candidateEra: DevelopmentEraKey = 'primitive-tribe';
  for (const era of ERA_ORDER.slice(1)) {
    const eraGates = gates[era as keyof typeof gates];
    if (!eraGates?.every(([, satisfied]) => satisfied)) break;
    candidateEra = era;
  }
  const previous = state.civilization.development;
  const previousCurrent = previous?.currentEra ?? 'primitive-tribe';
  const candidateSinceMonth = previous?.observerVersion === DEVELOPMENT_OBSERVER_VERSION
    && previous.candidateEra === candidateEra
    ? previous.candidateSinceMonth
    : state.clock.elapsedMonths;
  const upward = eraRank(candidateEra) > eraRank(previousCurrent);
  const requiredStableMonths = eraRank(candidateEra) >= eraRank('ancient-civilization') ? 24 : 12;
  const stableMonths = Math.max(0, state.clock.elapsedMonths - candidateSinceMonth);
  const currentEra = upward && stableMonths < requiredStableMonths ? previousCurrent : candidateEra;
  const historicalPeakEra = eraRank(currentEra) > eraRank(previous?.historicalPeakEra ?? 'primitive-tribe')
    ? currentEra
    : previous?.historicalPeakEra ?? 'primitive-tribe';
  const targetEra = upward ? candidateEra : nextEra(currentEra);
  const targetGates = targetEra && targetEra !== 'primitive-tribe'
    ? gates[targetEra as keyof typeof gates] ?? []
    : [];
  const satisfiedGateIds = targetGates.filter(([, satisfied]) => satisfied).map(([id]) => id);
  const missingGateIds = targetGates.filter(([, satisfied]) => !satisfied).map(([id]) => id);
  const supportingEventIds = [...new Set([
    ...materialCapabilities.flatMap((capability) => capability.successfulBatchEventIds),
    ...facilities.flatMap((facility) => [...facility.installationEventIds, ...facility.useEventIds]),
    ...(establishedCultivation
      ? [...establishedCultivation.plantingEventIds, ...establishedCultivation.harvestEventIds]
      : []),
    ...state.derived.institutions.flatMap((institution) => institution.evidenceEventIds),
  ])];
  const gateProgress = targetGates.length ? satisfiedGateIds.length / targetGates.length : 1;
  const stabilityProgress = upward ? Math.min(1, stableMonths / requiredStableMonths) : 1;
  return {
    observerVersion: DEVELOPMENT_OBSERVER_VERSION,
    currentEra,
    historicalPeakEra,
    candidateEra,
    candidateSinceMonth,
    transitionProgress: Math.round(gateProgress * stabilityProgress * 100) / 100,
    satisfiedGateIds,
    missingGateIds,
    supportingEventIds,
    materialCapabilities,
  };
}

export function livingPopulationPressure(state: SimulationState): {
  living: number;
  dependents: number;
  edibleUnits: number;
  storedEdibleUnits: number;
  pressure: number;
} {
  const living = state.people.filter(isAlive);
  const dependents = living.filter((person) => state.clock.elapsedMonths - person.bornAtMonth < 12 * 12).length;
  const edibleUnits = living.reduce((sum, person) => sum + person.inventory.reduce((inner, stack) => (
    materialHas(stack.materialId, 'edible') ? inner + stack.quantity : inner
  ), 0), 0);
  const storedEdibleUnits = state.containers.reduce((sum, container) => sum + container.inventory.reduce((inner, stack) => (
    materialHas(stack.materialId, 'edible') ? inner + stack.quantity : inner
  ), 0), 0);
  const demandUnits = living.length * 2 + dependents * 2;
  const available = edibleUnits + storedEdibleUnits * 0.75;
  return {
    living: living.length,
    dependents,
    edibleUnits,
    storedEdibleUnits,
    pressure: Math.max(0, Math.min(100, 28 + living.length * 3 + dependents * 5 + Math.max(0, demandUnits - available) * 4)),
  };
}
