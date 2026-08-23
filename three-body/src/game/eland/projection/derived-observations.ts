import {
  calculateCivilizationIndex,
} from '../domain/civilization-index';
import {
  DEVELOPMENT_ERA_LABELS,
  observeCivilizationDevelopment,
  observeFunctionalBuildings,
} from '../domain/era-progression';
import {
  actionFacts,
  worldEventById,
} from '../domain/event-index';
import { Material } from '../domain/material';
import type {
  EmergentRegion,
  InstitutionObservation,
  PhysicalStructureIndex,
  PracticeObservation,
  SimulationObservations,
  SimulationState,
} from '../domain/model';
import {
  copyPhysicalStructures,
  derivePhysicalStructureIndex,
  derivePhysicalStructures,
} from '../domain/physical-structure-index';
import {
  WORLD_CELL_COUNT,
  surfaceMaterial,
} from '../world/grid';
import { observeCapabilityMilestones } from './capability-milestones';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function updateDevelopmentObservation(state: SimulationState): void {
  state.civilization.civilizationIndex = calculateCivilizationIndex(state);
  const development = observeCivilizationDevelopment(state, state.civilization.civilizationIndex.total);
  state.civilization.development = development;
  state.civilization.stage = DEVELOPMENT_ERA_LABELS[development.currentEra];
}

/**
 * Pure observer projection. The physical structure index is an explicit input,
 * so this projection cannot become the source of gameplay-readable structures.
 */
export function observeSimulation(
  state: SimulationState,
  physicalStructureIndex: PhysicalStructureIndex,
): SimulationObservations {
  const actions = [...actionFacts(state)];
  const transfers = actions.filter((event) => event.action.kind === 'transfer' && event.status === 'completed');
  const containerTransfers = transfers.filter((event) => event.action.kind === 'transfer'
    && (event.action.from.kind === 'container' || event.action.to.kind === 'container'));
  const movements = actions.filter((event) => event.action.kind === 'move' && event.pathSegment.length > 1);
  const trailFormation = movements.flatMap((event) => {
    const changes = Array.isArray(event.diff.materialChanges) ? event.diff.materialChanges : [];
    const cells = changes.flatMap((change) => {
      if (!change || typeof change !== 'object') return [];
      const item = change as { cellId?: unknown; to?: unknown };
      return Number(item.to) === Material.PackedSoil && Number.isInteger(Number(item.cellId)) ? [Number(item.cellId)] : [];
    });
    return cells.length ? [{ event, cells }] : [];
  });
  const cultivation = actions.filter((event) => event.action.kind === 'act' && event.action.operation === 'combine' && Number(event.diff.outputMaterialId) === Material.CropSprout);
  const harvests = actions.filter((event) => event.action.kind === 'act' && event.action.operation === 'separate' && Number(event.diff.sourceMaterialId) === Material.CropMature);
  const burials = actions.filter((event) => event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'inter'
    && event.diff.remainsInterred === true);
  const structures = physicalStructureIndex.structures;
  const functionalBuildings = observeFunctionalBuildings(state);
  const trailCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.PackedSoil);
  const cultivatedCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.CropSprout || surfaceMaterial(state.world.grid, cell) === Material.CropMature || surfaceMaterial(state.world.grid, cell) === Material.ExhaustedSoil);
  const milestones = observeCapabilityMilestones({
    ...state,
    derived: { ...state.derived, structures },
  });
  const practices: PracticeObservation[] = [
    transfers.length ? { key: 'transfer', label: '反复转移物质', count: transfers.length, agentIds: [...new Set(transfers.map((event) => event.who))], eventIds: transfers.map((event) => event.id), stability: clamp(transfers.length * 5) } : null,
    containerTransfers.length ? { key: 'storage', label: '使用空间容器储藏物质', count: containerTransfers.length, agentIds: [...new Set(containerTransfers.map((event) => event.who))], eventIds: containerTransfers.map((event) => event.id), stability: clamp(containerTransfers.length * 8) } : null,
    movements.length ? { key: 'travel', label: '跨格迁行', count: movements.length, agentIds: [...new Set(movements.map((event) => event.who))], eventIds: movements.map((event) => event.id), stability: clamp(movements.length * 4) } : null,
    cultivation.length ? { key: 'cultivation', label: '种植实践', count: cultivation.length, agentIds: [...new Set(cultivation.map((event) => event.who))], eventIds: cultivation.map((event) => event.id), stability: clamp(cultivation.length * 12) } : null,
    burials.length ? { key: 'mortuary-care', label: '照料并安葬死者', count: burials.length, agentIds: [...new Set(burials.map((event) => event.who))], eventIds: burials.map((event) => event.id), stability: clamp(burials.length * 14) } : null,
  ].filter((item): item is PracticeObservation => Boolean(item));
  const governanceInstitutions: InstitutionObservation[] = state.collectives.flatMap((collective) => collective.decisionRules.flatMap((rule) => {
    const exercisedMandates = collective.mandates.filter((mandate) => mandate.decisionRuleId === rule.id
      && mandate.contributionEventIds.length > 0
      && mandate.distributionEventIds.length > 0);
    if (!exercisedMandates.length) return [];
    return [{
      key: `collective-coordination:${collective.id}:${rule.id}`,
      label: '共同体物质协调职责',
      evidenceEventIds: [...new Set([...rule.sourceEventIds, ...exercisedMandates.flatMap((mandate) => mandate.sourceEventIds)])],
      note: `共同规则至少经过 ${exercisedMandates.length} 次限期授权实践；续任是同一制度的历史，不重复计作新制度。`,
    }];
  }));
  const buildingInstitutions: InstitutionObservation[] = functionalBuildings.flatMap((facility) => {
    const enoughUsers = facility.userIds.length >= 2;
    const evidenceEventIds = [...new Set([...facility.installationEventIds, ...facility.useEventIds])];
    if (!enoughUsers) return [];
    if (facility.kind === 'storage' && facility.useEventIds.length >= 4) return [{
      key: `reserve-management:${facility.id}`,
      label: '公共储备管理',
      evidenceEventIds,
      note: '谷仓经过多人反复存取，储备开始脱离单个背包并形成共同维护实践。',
    }];
    if (facility.kind === 'water' && facility.useEventIds.length >= 3) return [{
      key: `water-maintenance:${facility.id}`,
      label: '公共蓄水维护',
      evidenceEventIds,
      note: '固定蓄水点被多人持续使用，供水成为聚落必须维护的公共能力。',
    }];
    if ((facility.kind === 'workshop' || facility.kind === 'mill') && facility.useEventIds.length >= 6) return [{
      key: `${facility.kind === 'mill' ? 'land-processing' : 'workshop-practice'}:${facility.id}`,
      label: facility.kind === 'mill' ? '定居作物加工' : '固定工坊分工',
      evidenceEventIds,
      note: '多人在固定生产设施附近反复完成工作，个人技巧开始成为可共享的岗位实践。',
    }];
    if (['kiln', 'foundry', 'smithy'].includes(facility.kind) && facility.useEventIds.length >= 6) return [{
      key: `metalwork-standard:${facility.id}`,
      label: '高温材料加工规范',
      evidenceEventIds,
      note: '高温设施由多名生产者反复使用，材料批次、燃料与操作顺序形成可复现规范。',
    }];
    if (facility.kind === 'core' && facility.useEventIds.length >= 4) return [{
      key: `coordination-core:${facility.id}`,
      label: '固定议事与协调场所',
      evidenceEventIds,
      note: '多人在同一核心建筑反复沟通、教导或达成安排，协调不再只依赖偶遇。',
    }];
    return [];
  });
  const apprenticeshipActions = actions.filter((event) => event.status === 'completed'
    && (Array.isArray(event.diff.taughtAudienceIds) && event.diff.taughtAudienceIds.length > 0
      || Boolean(event.diff.techniqueDemonstrationVerified)));
  const apprenticeshipAgents = new Set(apprenticeshipActions.flatMap((event) => [
    event.who,
    ...(Array.isArray(event.diff.taughtAudienceIds) ? event.diff.taughtAudienceIds.map(String) : []),
  ]));
  const apprenticeshipInstitutions: InstitutionObservation[] = apprenticeshipActions.length >= 6 && apprenticeshipAgents.size >= 3
    ? [{
      key: 'apprentice-craft:distributed-teaching',
      label: '跨人技术传习',
      evidenceEventIds: apprenticeshipActions.map((event) => event.id),
      note: '可靠技术被多次明确教导或示范，不再只保存在原生产者身上。',
    }]
    : [];
  const burialActors = new Set(burials.map((event) => event.who));
  const burialMonths = burials.map((event) => event.atMonth);
  const mortuaryInstitutions: InstitutionObservation[] = burials.length >= 3
    && burialActors.size >= 2
    && Math.max(...burialMonths) - Math.min(...burialMonths) >= 12
    ? [{
        key: 'mortuary-care:repeated-interment',
        label: '重复丧葬照料惯例',
        evidenceEventIds: burials.map((event) => event.id),
        note: '至少两人跨一年以上反复完成有死亡来源、挖墓、放置与覆土证据的安葬；这是观察到的惯例，不是人物奖励。',
      }]
    : [];
  const institutions = [...governanceInstitutions, ...buildingInstitutions, ...apprenticeshipInstitutions, ...mortuaryInstitutions];
  const regions: EmergentRegion[] = [];
  const waterCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.Water || surfaceMaterial(state.world.grid, cell) === Material.Ice);
  if (waterCells.length) regions.push({ id: 'natural-water', kind: 'natural', cells: waterCells, confidence: 1, evidenceEventIds: [], firstObservedMonth: 0, lastObservedMonth: state.clock.elapsedMonths, label: '水域' });
  if (trailCells.length) regions.push({ id: 'travel-trail', kind: 'trail', cells: trailCells, confidence: clamp(trailCells.length / 20), evidenceEventIds: trailFormation.map(({ event }) => event.id), firstObservedMonth: trailFormation[0]?.event.atMonth ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '夯土通行带' });
  if (cultivatedCells.length) regions.push({ id: 'cultivated', kind: 'cultivated', cells: cultivatedCells, confidence: clamp(cultivatedCells.length / 12), evidenceEventIds: [...cultivation, ...harvests].map((event) => event.id), firstObservedMonth: cultivation[0]?.atMonth ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '耕作区' });
  for (const structure of structures.filter((item) => item.complete)) regions.push({ id: `residential-${structure.id}`, kind: 'residential', cells: structure.occupiedCells, confidence: structure.weatherProtection / 100, evidenceEventIds: structure.sourceEventIds, firstObservedMonth: structure.sourceEventIds.map((id) => worldEventById(state, id)?.atMonth).find((month) => month !== undefined) ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '建造活动区' });
  return { practices, institutions, milestones, regions, functionalBuildings };
}

/**
 * Preserve the schema-17 `derived.structures` field as a serialized mirror.
 * New gameplay code must not read that observer-shaped compatibility field.
 */
export function withStructureCompatibilityMirror(
  observations: SimulationObservations,
  physicalStructureIndex: PhysicalStructureIndex,
): SimulationState['derived'] {
  return { ...observations, structures: copyPhysicalStructures(physicalStructureIndex) };
}

/** Compatibility API retained for callers that expect the schema-17 shape. */
export function deriveObservations(
  state: SimulationState,
  physicalStructureIndex = derivePhysicalStructureIndex(state),
): SimulationState['derived'] {
  return withStructureCompatibilityMirror(
    observeSimulation(state, physicalStructureIndex),
    physicalStructureIndex,
  );
}

/** @deprecated Import derivePhysicalStructures from domain/physical-structure-index. */
export const deriveStructures = derivePhysicalStructures;
