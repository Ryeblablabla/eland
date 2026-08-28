import { isDeepStrictEqual } from 'node:util';

import { committedHistoryView } from '../src/game/eland/domain/history';
import { Material, type MaterialId } from '../src/game/eland/domain/material';
import { mandateWasExercised } from '../src/game/eland/domain/governance';
import { recurringDutyCapabilityInstitutionKey } from '../src/game/eland/domain/era-progression';
import type {
  EmergentRegion,
  FunctionalBuildingObservation,
  InstitutionObservation,
  PracticeObservation,
  SimulationState,
  WorldEvent,
} from '../src/game/eland/domain/model';
import {
  copyPhysicalStructures,
  rematerializePhysicalStructureIndex,
} from '../src/game/eland/domain/physical-structure-index';
import {
  WORLD_CELL_COUNT,
  WORLD_DEPTH,
  WORLD_LEVELS,
  WORLD_WIDTH,
  cellX,
  cellY,
  surfaceMaterial,
  voxelAt,
  voxelWorldRevision,
} from '../src/game/eland/world/grid';
import {
  assertDecodedObserverDerivedHistorySidecar,
  encodeObserverDerivedHistorySidecar,
  type ObserverDerivedHistoryCanonicalDemandV1,
  type ObserverDerivedHistorySidecarPayloadV1,
} from './observer-derived-history-codec';
import {
  OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS,
  OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT,
  OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT,
  finishObserverDerivedHistoryProjection,
  foldVerifiedObserverDerivedHistorySegment,
  resumeObserverDerivedHistoryProjection,
  type ObserverDerivedHistoryProjection,
  type ObserverDerivedHistoryTarget,
  type ObserverFunctionalBuildingHistory,
  type ObserverMaterialCapabilityHistory,
} from './observer-derived-history-projection';

/**
 * Post-fact server adapter only. Domain/application code must never import this
 * module: none of these summaries authorise actions or reward an era.
 */
export const BOUNDED_OBSERVER_DERIVED_SUBSET_DEFINITION =
  'bounded-observer-derived-subset-v1' as const;
export const BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_OBSERVATION_VERSION =
  'bounded-functional-building-observation-v1' as const;
export const BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_EVIDENCE_SEMANTICS =
  'bounded-witnesses-with-exact-counts-v1' as const;
export const MAX_BOUNDED_OBSERVER_SUFFIX_EVENTS = 65_536;
export const MAX_BOUNDED_OBSERVER_SUFFIX_BYTES = 32 * 1_024 * 1_024;
export const MAX_BOUNDED_OBSERVER_SHELL_INSTITUTION_ITEMS = 65_536;

const PRACTICE_DEFINITIONS = {
  transfer: { label: '反复转移物质', stabilityFactor: 5 },
  storage: { label: '使用空间容器储藏物质', stabilityFactor: 8 },
  travel: { label: '跨格迁行', stabilityFactor: 4 },
  cultivation: { label: '种植实践', stabilityFactor: 12 },
  'mortuary-care': { label: '照料并安葬死者', stabilityFactor: 14 },
} as const;

const FUNCTIONAL_BUILDING_PRESENTATIONS: ReadonlyMap<MaterialId, Readonly<{
  kind: FunctionalBuildingObservation['kind'];
  functionSummary: string;
}>> = new Map([
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

type MaterialCapabilityFacts = Readonly<Record<
  keyof ObserverDerivedHistoryProjection['materialCapabilities'],
  Readonly<ObserverMaterialCapabilityHistory>
>>;

/**
 * Display/read-model shape written to state.derived.functionalBuildings.
 * Counts are exact for the folded history. The legacy *EventIds arrays are
 * deliberately only bounded witnesses, which is stated on every standalone
 * observation so a consumer cannot honestly treat their lengths as totals.
 */
export interface BoundedObserverFunctionalBuildingObservation
  extends FunctionalBuildingObservation {
  readonly observationVersion: typeof BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_OBSERVATION_VERSION;
  readonly evidenceSemantics: typeof BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_EVIDENCE_SEMANTICS;
  readonly installationCount: number;
  readonly useCount: number;
}

export interface BoundedObserverDerivedSubsetMaterialization {
  readonly kind: typeof BOUNDED_OBSERVER_DERIVED_SUBSET_DEFINITION;
  readonly target: Readonly<ObserverDerivedHistoryTarget>;
  readonly continuationReady: false;
  /** The source artifact remains non-ready; this adapter never removes its gaps. */
  readonly projectionGaps: readonly string[];
  readonly evidenceSemantics: 'bounded-witnesses-with-exact-counts-v1';
  readonly practices: readonly PracticeObservation[];
  readonly institutions: readonly InstitutionObservation[];
  readonly regions: readonly EmergentRegion[];
  readonly structures: SimulationState['derived']['structures'];
  /** Exact counts plus bounded witnesses and current-grid activity. */
  readonly functionalBuildings: readonly Readonly<BoundedObserverFunctionalBuildingObservation>[];
  /** Exact bounded-history counters; a later civilization observer may consume a persisted sidecar, not state.derived. */
  readonly materialCapabilities: MaterialCapabilityFacts;
}

export interface AdvancedBoundedObserverDerivedSubset {
  readonly kind: 'advanced-bounded-observer-derived-subset-v1';
  readonly continuationReady: false;
  readonly projection: Readonly<ObserverDerivedHistoryProjection>;
  readonly sidecar: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
  readonly materialization: Readonly<BoundedObserverDerivedSubsetMaterialization>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameTarget(left: ObserverDerivedHistoryTarget, right: ObserverDerivedHistoryTarget): boolean {
  return left.stateHash === right.stateHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId;
}

function assertKnownProjectionGaps(projection: ObserverDerivedHistoryProjection): void {
  if (projection.continuationGaps.length !== OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS.length
    || projection.continuationGaps.some(
      (gap, index) => gap !== OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS[index],
    )) {
    throw new Error('bounded observer materializer 拒绝缺失、重复或未知 projection gap');
  }
}

function assertShellTarget(state: SimulationState, target: ObserverDerivedHistoryTarget): void {
  const history = committedHistoryView(state);
  if (history.events.length !== history.hotEventCount
    || history.eventCount !== target.eventCount
    || state.world.historyCursor?.tailEventId !== target.tailEventId) {
    throw new Error('bounded observer materializer 的 shell 与 exact target cursor 不一致');
  }
  const grid = state.world.grid;
  if (grid.width !== WORLD_WIDTH
    || grid.depth !== WORLD_DEPTH
    || grid.levels !== WORLD_LEVELS
    || grid.voxels.length !== WORLD_CELL_COUNT * WORLD_LEVELS) {
    throw new Error('bounded observer materializer 的 current grid 尺寸无效');
  }
}

function assertAndRematerializePhysicalTopology(
  state: SimulationState,
  target: ObserverDerivedHistoryTarget,
) {
  const physical = state.world.physicalStructureIndex;
  if (!physical
    || physical.projectionVersion !== 2
    || physical.appliedHistoryEventCount !== target.eventCount
    || physical.appliedTailEventId !== target.tailEventId
    || physical.calculatedAtMonth !== state.clock.elapsedMonths
    || physical.voxelRevision !== voxelWorldRevision(state.world.grid)) {
    throw new Error('bounded observer materializer 的 physical topology 与 current grid/target 不一致');
  }
  const rematerialized = rematerializePhysicalStructureIndex(state, physical);
  if (!isDeepStrictEqual(physical.structures, rematerialized.structures)) {
    throw new Error('bounded observer materializer 检出 current-grid/physical structure mismatch');
  }
  return rematerialized;
}

function evidenceIds(
  evidence: readonly { eventId: string }[],
): string[] {
  if (evidence.length > OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT) {
    throw new Error('bounded observer materializer evidence 超出 projection 上限');
  }
  return evidence.map((item) => item.eventId);
}

function uniqueBoundedEvidence(values: readonly string[]): string[] {
  if (values.length > MAX_BOUNDED_OBSERVER_SHELL_INSTITUTION_ITEMS) {
    throw new Error('bounded observer materializer shell institution evidence 超出上限');
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length > OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT) result.shift();
  }
  return result;
}

function materializePractices(projection: ObserverDerivedHistoryProjection): PracticeObservation[] {
  return Object.entries(PRACTICE_DEFINITIONS).flatMap(([key, definition]) => {
    const history = projection.practices[key as keyof typeof PRACTICE_DEFINITIONS];
    if (history.count === 0) return [];
    return [{
      key,
      label: definition.label,
      count: history.count,
      agentIds: [...history.agentIds],
      eventIds: evidenceIds(history.evidence),
      stability: Math.max(0, Math.min(100, history.count * definition.stabilityFactor)),
    }];
  });
}

function activeFunctionalBuildings(
  state: SimulationState,
  projection: ObserverDerivedHistoryProjection,
) {
  return projection.functionalBuildings.map((facility) => {
    const x = cellX(facility.cellId);
    const y = cellY(facility.cellId);
    const active = voxelAt(state.world.grid, x, y, facility.z) === facility.materialId;
    return {
      ...facility,
      installationEvidence: facility.installationEvidence.map((item) => ({ ...item })),
      userIds: [...facility.userIds],
      useEvidence: facility.useEvidence.map((item) => ({ ...item })),
      active,
    };
  });
}

function materializeFunctionalBuildingObservations(
  facilities: readonly (Readonly<ObserverFunctionalBuildingHistory> & { readonly active: boolean })[],
): BoundedObserverFunctionalBuildingObservation[] {
  return facilities.map((facility) => {
    const presentation = FUNCTIONAL_BUILDING_PRESENTATIONS.get(facility.materialId);
    if (!presentation || presentation.kind !== facility.kind) {
      throw new Error(`bounded observer materializer 设施 ${facility.id} 的物质/类型无展示契约`);
    }
    return {
      id: facility.id,
      kind: facility.kind,
      materialId: facility.materialId,
      cellId: facility.cellId,
      z: facility.z,
      installedAtMonth: facility.installedAtMonth,
      installationEventIds: evidenceIds(facility.installationEvidence),
      useEventIds: evidenceIds(facility.useEvidence),
      userIds: [...facility.userIds],
      functionSummary: presentation.functionSummary,
      active: facility.active,
      observationVersion: BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_OBSERVATION_VERSION,
      evidenceSemantics: BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_EVIDENCE_SEMANTICS,
      installationCount: facility.installationCount,
      useCount: facility.useCount,
    } satisfies BoundedObserverFunctionalBuildingObservation;
  });
}

function materializeInstitutions(
  state: SimulationState,
  projection: ObserverDerivedHistoryProjection,
  facilities: ReturnType<typeof activeFunctionalBuildings>,
): InstitutionObservation[] {
  let shellItems = state.collectives.length;
  const governance = state.collectives.flatMap((collective) => {
    shellItems += collective.decisionRules.length + collective.mandates.length;
    if (shellItems > MAX_BOUNDED_OBSERVER_SHELL_INSTITUTION_ITEMS) {
      throw new Error('bounded observer materializer collective shell 超出上限');
    }
    return collective.decisionRules.flatMap((rule) => {
      const exercised = collective.mandates.filter((mandate) => mandate.decisionRuleId === rule.id
        && mandateWasExercised(mandate));
      if (exercised.length === 0) return [];
      return [{
        key: rule.scope === 'assign-recurring-duty'
          ? recurringDutyCapabilityInstitutionKey(
            collective.id,
            rule.id,
            rule.projectDuty.desiredFunction,
          )
          : `collective-coordination:${collective.id}:${rule.id}`,
        label: rule.scope === 'coordinate-material' ? '共同体物质协调职责' : '共同体反复项目职责',
        evidenceEventIds: uniqueBoundedEvidence([
          ...rule.sourceEventIds,
          ...exercised.flatMap((mandate) => mandate.sourceEventIds),
        ]),
        note: `共同规则至少经过 ${exercised.length} 次限期授权实践；续任是同一制度的历史，不重复计作新制度。`,
      }];
    });
  });
  const building = facilities.filter((facility) => facility.active && facility.userIds.length >= 2)
    .flatMap((facility): InstitutionObservation[] => {
      const ids = [...new Set([
        ...evidenceIds(facility.installationEvidence),
        ...evidenceIds(facility.useEvidence),
      ])];
      if (facility.kind === 'storage' && facility.useCount >= 4) return [{
        key: `reserve-management:${facility.id}`, label: '公共储备管理', evidenceEventIds: ids,
        note: '谷仓经过多人反复存取，储备开始脱离单个背包并形成共同维护实践。',
      }];
      if (facility.kind === 'water' && facility.useCount >= 3) return [{
        key: `water-maintenance:${facility.id}`, label: '公共蓄水维护', evidenceEventIds: ids,
        note: '固定蓄水点被多人持续使用，供水成为聚落必须维护的公共能力。',
      }];
      if ((facility.kind === 'workshop' || facility.kind === 'mill') && facility.useCount >= 6) return [{
        key: `${facility.kind === 'mill' ? 'land-processing' : 'workshop-practice'}:${facility.id}`,
        label: facility.kind === 'mill' ? '定居作物加工' : '固定工坊分工', evidenceEventIds: ids,
        note: '多人在固定生产设施附近反复完成工作，个人技巧开始成为可共享的岗位实践。',
      }];
      if (['kiln', 'foundry', 'smithy'].includes(facility.kind) && facility.useCount >= 6) return [{
        key: `metalwork-standard:${facility.id}`, label: '高温材料加工规范', evidenceEventIds: ids,
        note: '高温设施由多名生产者反复使用，材料批次、燃料与操作顺序形成可复现规范。',
      }];
      if (facility.kind === 'core' && facility.useCount >= 4) return [{
        key: `coordination-core:${facility.id}`, label: '固定议事与协调场所', evidenceEventIds: ids,
        note: '多人在同一核心建筑反复沟通、教导或达成安排，协调不再只依赖偶遇。',
      }];
      return [];
    });
  const teaching = projection.institutions.distributedTeaching.institutionThresholdSatisfied ? [{
    key: 'apprentice-craft:distributed-teaching', label: '跨人技术传习',
    evidenceEventIds: evidenceIds(projection.institutions.distributedTeaching.evidence),
    note: '可靠技术被多次明确教导或示范，不再只保存在原生产者身上。',
  }] : [];
  const burial = projection.institutions.repeatedInterment.institutionThresholdSatisfied ? [{
    key: 'mortuary-care:repeated-interment', label: '重复丧葬照料惯例',
    evidenceEventIds: evidenceIds(projection.institutions.repeatedInterment.evidence),
    note: '至少两人跨一年以上反复完成有死亡来源、挖墓、放置与覆土证据的安葬；这是观察到的惯例，不是人物奖励。',
  }] : [];
  return [...governance, ...building, ...teaching, ...burial];
}

function assertResidentialDemandClosed(
  sourceDemand: ObserverDerivedHistoryCanonicalDemandV1,
  projection: ObserverDerivedHistoryProjection,
  structures: SimulationState['derived']['structures'],
): void {
  const complete = structures.filter((structure) => structure.complete)
    .sort((left, right) => left.id.localeCompare(right.id));
  const demanded = [...sourceDemand.residentialStructures]
    .sort((left, right) => left.structureId.localeCompare(right.structureId));
  if (complete.length !== demanded.length
    || complete.some((structure, index) => structure.id !== demanded[index]?.structureId
      || !isDeepStrictEqual(structure.sourceEventIds, demanded[index]?.sourceEventIds))) {
    throw new Error('bounded observer materializer 的 residential demand 未精确覆盖当前物理住所');
  }
  if (projection.regions.residential.length !== demanded.length) {
    throw new Error('bounded observer materializer 的 residential projection 未闭合');
  }
}

function materializeRegions(
  state: SimulationState,
  projection: ObserverDerivedHistoryProjection,
  structures: SimulationState['derived']['structures'],
): EmergentRegion[] {
  const water: number[] = [];
  const trail: number[] = [];
  const cultivated: number[] = [];
  for (let cell = 0; cell < WORLD_CELL_COUNT; cell += 1) {
    const material = surfaceMaterial(state.world.grid, cell);
    if (material === Material.Water || material === Material.Ice) water.push(cell);
    if (material === Material.PackedSoil) trail.push(cell);
    if (material === Material.CropSprout
      || material === Material.CropMature
      || material === Material.ExhaustedSoil) cultivated.push(cell);
  }
  const regions: EmergentRegion[] = [];
  if (water.length) regions.push({
    id: 'natural-water', kind: 'natural', cells: water, confidence: 1,
    evidenceEventIds: [], firstObservedMonth: 0, lastObservedMonth: state.clock.elapsedMonths,
    label: '水域',
  });
  if (trail.length) regions.push({
    id: 'travel-trail', kind: 'trail', cells: trail,
    confidence: Math.max(0, Math.min(100, trail.length / 20)),
    evidenceEventIds: evidenceIds(projection.regions.trail.evidence),
    firstObservedMonth: projection.regions.trail.firstObservedMonth ?? state.clock.elapsedMonths,
    lastObservedMonth: state.clock.elapsedMonths, label: '夯土通行带',
  });
  if (cultivated.length) regions.push({
    id: 'cultivated', kind: 'cultivated', cells: cultivated,
    confidence: Math.max(0, Math.min(100, cultivated.length / 12)),
    evidenceEventIds: evidenceIds(projection.regions.cultivated.evidence),
    firstObservedMonth: projection.regions.cultivated.firstObservedMonth ?? state.clock.elapsedMonths,
    lastObservedMonth: state.clock.elapsedMonths, label: '耕作区',
  });
  const residentialById = new Map(projection.regions.residential.map((region) => [region.structureId, region]));
  for (const structure of structures.filter((item) => item.complete)) {
    const history = residentialById.get(structure.id);
    if (!history) throw new Error(`bounded observer materializer 缺少住所 ${structure.id} 历史`);
    regions.push({
      id: `residential-${structure.id}`, kind: 'residential', cells: [...structure.occupiedCells],
      confidence: structure.weatherProtection / 100,
      evidenceEventIds: history.sourceEvidence ? [history.sourceEvidence.eventId] : [],
      firstObservedMonth: history.firstObservedMonth ?? state.clock.elapsedMonths,
      lastObservedMonth: state.clock.elapsedMonths, label: '建造活动区',
    });
  }
  return regions;
}

function cloneCapabilities(
  projection: ObserverDerivedHistoryProjection,
): MaterialCapabilityFacts {
  return clone(projection.materialCapabilities) as MaterialCapabilityFacts;
}

function materializeVerifiedSubset(
  state: SimulationState,
  sourceDemand: ObserverDerivedHistoryCanonicalDemandV1,
  projection: ObserverDerivedHistoryProjection,
  exactTarget: ObserverDerivedHistoryTarget,
): Readonly<BoundedObserverDerivedSubsetMaterialization> {
  if (!sameTarget(projection.target, exactTarget)
    || projection.reducedThrough.eventCount !== exactTarget.eventCount
    || projection.reducedThrough.tailEventId !== exactTarget.tailEventId) {
    throw new Error('bounded observer materializer 收到 stale projection target');
  }
  assertKnownProjectionGaps(projection);
  assertShellTarget(state, exactTarget);
  const physical = assertAndRematerializePhysicalTopology(state, exactTarget);
  const structures = copyPhysicalStructures(physical);
  assertResidentialDemandClosed(sourceDemand, projection, structures);
  const facilities = activeFunctionalBuildings(state, projection);
  if (facilities.length > OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT) {
    throw new Error('bounded observer materializer facilities 超出上限');
  }
  const functionalBuildings = materializeFunctionalBuildingObservations(facilities);
  const practices = materializePractices(projection);
  const institutions = materializeInstitutions(state, projection, facilities);
  const regions = materializeRegions(state, projection, structures);

  // One owned replacement preserves observer fields owned by other sidecars.
  state.derived = {
    ...state.derived,
    practices: clone(practices),
    institutions: clone(institutions),
    regions: clone(regions),
    structures: clone(structures),
    functionalBuildings: clone(functionalBuildings),
  };

  return deepFreeze({
    kind: BOUNDED_OBSERVER_DERIVED_SUBSET_DEFINITION,
    target: { ...exactTarget },
    continuationReady: false,
    projectionGaps: [...projection.continuationGaps],
    evidenceSemantics: 'bounded-witnesses-with-exact-counts-v1',
    practices: clone(practices),
    institutions: clone(institutions),
    regions: clone(regions),
    structures: clone(structures),
    functionalBuildings: clone(functionalBuildings),
    materialCapabilities: cloneCapabilities(projection),
  });
}

/** Materialize the honest subset from a strictly decoded, exact-target sidecar. */
export function materializeDecodedBoundedObserverDerivedSubset(
  state: SimulationState,
  decoded: Readonly<ObserverDerivedHistorySidecarPayloadV1>,
  exactTarget: Readonly<ObserverDerivedHistoryTarget>,
): Readonly<BoundedObserverDerivedSubsetMaterialization> {
  assertDecodedObserverDerivedHistorySidecar(decoded);
  return materializeVerifiedSubset(state, decoded.sourceDemand, decoded.projection, exactTarget);
}

/**
 * Resume from one decoded prefix, fold one caller-supplied suffix only after it
 * is matched to the current authoritative hot window, then materialize the
 * same subset at the exact successor target.
 */
export function advanceBoundedObserverDerivedSubset(
  state: SimulationState,
  decodedPrevious: Readonly<ObserverDerivedHistorySidecarPayloadV1>,
  previousTarget: Readonly<ObserverDerivedHistoryTarget>,
  nextTarget: Readonly<ObserverDerivedHistoryTarget>,
  suffix: readonly WorldEvent[],
  nextSourceDemand: Readonly<ObserverDerivedHistoryCanonicalDemandV1>,
): Readonly<AdvancedBoundedObserverDerivedSubset> {
  assertDecodedObserverDerivedHistorySidecar(decodedPrevious);
  if (!sameTarget(decodedPrevious.projection.target, previousTarget)) {
    throw new Error('bounded observer incremental previous target 已过期');
  }
  if (!Number.isSafeInteger(suffix.length)
    || suffix.length > MAX_BOUNDED_OBSERVER_SUFFIX_EVENTS
    || previousTarget.eventCount + suffix.length !== nextTarget.eventCount) {
    throw new Error('bounded observer incremental suffix 数量或 cursor 不连续');
  }
  assertShellTarget(state, nextTarget);
  const history = committedHistoryView(state);
  const authoritative: WorldEvent[] = [];
  for (let offset = 0; offset < suffix.length; offset += 1) {
    const event = history.atAbsoluteIndex(previousTarget.eventCount + offset);
    if (!event || !isDeepStrictEqual(event, suffix[offset])) {
      throw new Error(`bounded observer incremental suffix ${offset} 未绑定到权威热事实`);
    }
    authoritative.push(event);
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(authoritative), 'utf8');
  if (serializedBytes > MAX_BOUNDED_OBSERVER_SUFFIX_BYTES) {
    throw new Error('bounded observer incremental suffix 超出 byte 上限');
  }
  const ownedSuffix = clone(authoritative);
  const fold = resumeObserverDerivedHistoryProjection(
    decodedPrevious.projection,
    nextTarget,
    nextSourceDemand,
  );
  foldVerifiedObserverDerivedHistorySegment(fold, ownedSuffix, previousTarget.eventCount);
  const projection = finishObserverDerivedHistoryProjection(fold);
  const encoded = encodeObserverDerivedHistorySidecar({
    sourceDemand: nextSourceDemand,
    projection,
  });
  const materialization = materializeVerifiedSubset(
    state,
    encoded.sidecar.sourceDemand,
    encoded.sidecar.projection,
    nextTarget,
  );
  return deepFreeze({
    kind: 'advanced-bounded-observer-derived-subset-v1',
    continuationReady: false,
    projection: encoded.sidecar.projection,
    sidecar: encoded.sidecar,
    materialization,
  });
}
