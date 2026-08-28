import { Material, materialHas, type MaterialId } from './material';
import {
  actionFacts,
  compareWorldEventsInCanonicalOrder,
  retainedColdWorldEventsForLease,
  worldEventByIdWithRetainedLease,
} from './event-index';
import type {
  ActionFact,
  CivilizationDevelopmentObservation,
  DevelopmentEraKey,
  FunctionalBuildingObservation,
  MaterialCapabilityObservation,
  MaterialCapabilityStage,
  SimulationState,
} from './model';
import {
  isMassCalibrationReceipt,
  isMassMeasurementReceipt,
  isSourcedMassMeasurementAction,
  measurementStackReceiptMatchesUse,
  sameMeasurementSourceEventIds,
  sameMeasurementStackIdentity,
} from './measurement';
import { validateElectricalPowerTopology } from './electrical-power';
import type { MeasurementUncertaintyBasis, ProjectFunction, ProjectState } from './project';
import { livingPeople } from './state-index';
import { actionSatisfiesRecordReplicationReceipt } from './action-executor';
import { cellId, cellsInRadius, voxelAt } from '../world/grid';

export const DEVELOPMENT_OBSERVER_VERSION = 'material-institution-era-v7' as const;

/** Observer-only leases: planners never query these society-level achievements. */
export const MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY =
  'observer:modern-civilization:electrical-useful-load' as const;
export const MODERN_RECORD_EXPERIMENT_LEASE_KEY =
  'observer:modern-civilization:independent-record-experiment' as const;

export function modernElectricalUsefulLoadLeaseKey(networkId: string): string {
  if (typeof networkId !== 'string' || networkId.length === 0) {
    throw new Error('现代文明用电见证缺少 network ID');
  }
  return `${MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY}:${encodeURIComponent(networkId)}`;
}

export function modernElectricalOperationLeaseKey(networkId: string): string {
  if (typeof networkId !== 'string' || networkId.length === 0) {
    throw new Error('现代文明运行见证缺少 network ID');
  }
  return `observer:modern-civilization:electrical-operations:${encodeURIComponent(networkId)}`;
}

export function parseModernElectricalUsefulLoadLeaseKey(leaseKey: string): string | null {
  const prefix = `${MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY}:`;
  if (!leaseKey.startsWith(prefix)) return null;
  try {
    const networkId = decodeURIComponent(leaseKey.slice(prefix.length));
    return networkId.length > 0 ? networkId : null;
  } catch {
    return null;
  }
}

export function modernCompletedMeasurementReceiptLeaseKey(projectId: string): string {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('现代文明测量见证缺少 project ID');
  }
  return `completed-measurement-project:${projectId}:receipt-chain`;
}

const ERA_ORDER: DevelopmentEraKey[] = [
  'primitive-tribe',
  'agrarian-settlement',
  'ancient-civilization',
  'modern-civilization',
];

export const DEVELOPMENT_ERA_LABELS: Record<DevelopmentEraKey, string> = {
  'primitive-tribe': '原始部落',
  'agrarian-settlement': '农耕定居',
  'ancient-civilization': '古代文明',
  'modern-civilization': '现代文明（含信息能力）',
  medieval: '古代文明',
};

/** Persisted v1-v4 snapshots may still contain the former standalone medieval era. */
export function normalizeDevelopmentEra(era: DevelopmentEraKey): DevelopmentEraKey {
  return era === 'medieval' ? 'ancient-civilization' : era;
}

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
  type InstallationBasis = NonNullable<ReturnType<typeof currentInstallation>> & {
    installationEventIds: string[];
    installationIds: Set<string>;
    installedAtMonth: number;
    uses: ActionFact[];
  };
  const installations = new Map<string, InstallationBasis>();
  const firstActionMonthById = new Map<string, number>();
  for (const event of actions) {
    if (!firstActionMonthById.has(event.id)) firstActionMonthById.set(event.id, event.atMonth);
    const installation = currentInstallation(state, event);
    if (!installation) continue;
    const { materialId, x, y, z } = installation;
    const id = `facility:${materialId}:${x}:${y}:${z}`;
    const existing = installations.get(id);
    const installedAtMonth = firstActionMonthById.get(event.id) ?? state.clock.elapsedMonths;
    if (existing) {
      existing.installationEventIds.push(event.id);
      existing.installationIds.add(event.id);
      existing.installedAtMonth = Math.min(existing.installedAtMonth, installedAtMonth);
    } else installations.set(id, {
      ...installation,
      installationEventIds: [event.id],
      installationIds: new Set([event.id]),
      installedAtMonth,
      uses: [],
    });
  }

  const byMaterialId = new Map<MaterialId, InstallationBasis[]>();
  const storageByContainerId = new Map<string, InstallationBasis[]>();
  const waterByPosition = new Map<string, InstallationBasis[]>();
  const coreByCellId = new Map<number, InstallationBasis[]>();
  const append = <Key>(index: Map<Key, InstallationBasis[]>, key: Key, installation: InstallationBasis): void => {
    const indexed = index.get(key) ?? [];
    indexed.push(installation);
    index.set(key, indexed);
  };
  for (const installation of installations.values()) {
    const { materialId, definition, x, y, z } = installation;
    append(byMaterialId, materialId, installation);
    if (definition.kind === 'storage') append(storageByContainerId, `container:${x}:${y}:${z}`, installation);
    if (definition.kind === 'water') append(waterByPosition, `${x}:${y}:${z}`, installation);
    if (definition.kind === 'core') append(coreByCellId, cellId(x, y), installation);
  }

  for (const candidate of actions) {
    if (candidate.status !== 'completed') continue;
    const matching = new Set<InstallationBasis>();
    byMaterialId.get(Number(candidate.diff.facilityMaterialId))?.forEach((installation) => matching.add(installation));
    if (candidate.action.kind === 'transfer') {
      const containerId = candidate.action.from.kind === 'container'
        ? candidate.action.from.containerId
        : candidate.action.to.kind === 'container' ? candidate.action.to.containerId : '';
      storageByContainerId.get(containerId)?.forEach((installation) => matching.add(installation));
    }
    if (candidate.action.kind === 'act' && candidate.action.operation === 'ingest') {
      for (const target of candidate.action.targets) {
        if (target.kind !== 'voxel') continue;
        const { x, y, z } = target.position;
        waterByPosition.get(`${x}:${y}:${z}`)?.forEach((installation) => matching.add(installation));
      }
    }
    if (candidate.action.kind === 'communicate') {
      coreByCellId.get(candidate.cellId)?.forEach((installation) => matching.add(installation));
    }
    for (const installation of matching) {
      if (candidate.atMonth < installation.installedAtMonth
        || installation.installationIds.has(candidate.id)) continue;
      installation.uses.push(candidate);
    }
  }

  return [...installations.entries()].map(([id, installation]) => {
    const {
      materialId, definition, x, y, z, installationEventIds, installedAtMonth, uses,
    } = installation;
    const installedCell = cellId(x, y);
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

const RECURRING_DUTY_CAPABILITY_INSTITUTION_PREFIX = 'recurring-duty-capability' as const;
const LEGACY_RECURRING_DUTY_INSTITUTION_MARKER = ':decision-rule:offer-recurring-duty-rule:' as const;
const BRONZE_RECURRING_DUTIES = new Set<ProjectFunction>([
  'copper-charge',
  'copper-smelting',
  'tin-charge',
  'tin-smelting',
  'bronze-alloying',
  'bronze-tooling',
  'bronze-workshop',
]);
const IRON_RECURRING_DUTIES = new Set<ProjectFunction>([
  'iron-charge',
  'iron-reduction',
  'iron-working',
  'iron-tooling',
  'iron-workshop',
]);

type RecurringDutyCapabilityClass = 'bronze' | 'iron' | 'other';

function recurringDutyCapabilityClass(
  desiredFunction: ProjectFunction,
): RecurringDutyCapabilityClass {
  if (BRONZE_RECURRING_DUTIES.has(desiredFunction)) return 'bronze';
  if (IRON_RECURRING_DUTIES.has(desiredFunction)) return 'iron';
  return 'other';
}

/**
 * Observer-only institution identity. The material class comes from the typed
 * duty subject, never from a collective/rule ID or an era target.
 */
export function recurringDutyCapabilityInstitutionKey(
  collectiveId: string,
  ruleId: string,
  desiredFunction: ProjectFunction,
): string {
  const capability = recurringDutyCapabilityClass(desiredFunction);
  return [
    RECURRING_DUTY_CAPABILITY_INSTITUTION_PREFIX,
    'v1',
    capability,
    desiredFunction,
    encodeURIComponent(collectiveId),
    encodeURIComponent(ruleId),
  ].join(':');
}

function recurringDutyCapabilityFromInstitutionKey(
  institutionKey: string,
): RecurringDutyCapabilityClass | null {
  const segments = institutionKey.split(':');
  if (segments.length !== 6
    || segments[0] !== RECURRING_DUTY_CAPABILITY_INSTITUTION_PREFIX
    || segments[1] !== 'v1'
    || !segments[4]
    || !segments[5]) return null;
  const capability = segments[2];
  const desiredFunction = segments[3] as ProjectFunction;
  if (capability !== recurringDutyCapabilityClass(desiredFunction)) return null;
  return capability === 'bronze' || capability === 'iron' || capability === 'other'
    ? capability
    : null;
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

export interface ExactMaterialCapabilityFacts {
  readonly key: MaterialCapabilityObservation['key'];
  readonly successfulBatchCount: number;
  readonly failedBatchCount: number;
  readonly adoptedActionCount: number;
  readonly firstSuccessfulMonth: number | null;
  readonly lastSuccessfulMonth: number | null;
  readonly producerIds: readonly string[];
  readonly productionSiteMaterialIds: readonly MaterialId[];
  readonly supportingInstitutionKeys: readonly string[];
  /** Bounded witnesses only. Their lengths are never used as exact counts. */
  readonly successfulBatchEventIds: readonly string[];
  readonly failedBatchEventIds: readonly string[];
  readonly adoptedActionEventIds: readonly string[];
}

function exactCapabilityDefinition(key: MaterialCapabilityObservation['key']): CapabilityDefinition {
  const definition = CAPABILITIES.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`未知材料能力 ${key}`);
  return definition;
}

function assertExactCapabilityCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`材料能力 exact ${label} 必须是非负安全整数`);
  }
}

function assertCanonicalUniqueValues(
  values: readonly (string | number)[],
  label: string,
): void {
  if (new Set(values).size !== values.length
    || values.some((value) => typeof value === 'string' && value.length === 0)) {
    throw new Error(`材料能力 exact ${label} 必须 canonical 且不可重复`);
  }
}

/** Shared full/bounded reducer. Only exact counters and identities affect the stage. */
export function materialCapabilityObservationFromExactFacts(
  facts: Readonly<ExactMaterialCapabilityFacts>,
): MaterialCapabilityObservation {
  const definition = exactCapabilityDefinition(facts.key);
  assertExactCapabilityCount(facts.successfulBatchCount, `${facts.key}.successfulBatchCount`);
  assertExactCapabilityCount(facts.failedBatchCount, `${facts.key}.failedBatchCount`);
  assertExactCapabilityCount(facts.adoptedActionCount, `${facts.key}.adoptedActionCount`);
  assertCanonicalUniqueValues(facts.producerIds, `${facts.key}.producerIds`);
  assertCanonicalUniqueValues(facts.productionSiteMaterialIds, `${facts.key}.productionSiteMaterialIds`);
  assertCanonicalUniqueValues(facts.supportingInstitutionKeys, `${facts.key}.supportingInstitutionKeys`);
  const span = facts.firstSuccessfulMonth === null || facts.lastSuccessfulMonth === null
    ? 0
    : facts.lastSuccessfulMonth - facts.firstSuccessfulMonth + 1;
  if ((facts.successfulBatchCount === 0) !== (span === 0)
    || span < 0
    || (facts.successfulBatchCount > 0
      && (!Number.isSafeInteger(facts.firstSuccessfulMonth)
        || !Number.isSafeInteger(facts.lastSuccessfulMonth)
        || Number(facts.firstSuccessfulMonth) < 0
        || Number(facts.lastSuccessfulMonth) < 0))) {
    throw new Error(`材料能力 exact ${facts.key} 的 batch month span 无效`);
  }
  let stage: MaterialCapabilityStage = 'hypothesis';
  if (facts.successfulBatchCount >= 1) stage = 'sample';
  if (facts.successfulBatchCount >= definition.repeatableBatches
    && span >= definition.repeatableSpan) stage = 'repeatable';
  if (stage === 'repeatable'
    && facts.producerIds.length >= definition.distributedProducers
    && facts.adoptedActionCount >= definition.distributedUses
    && facts.productionSiteMaterialIds.length >= 1) stage = 'distributed';
  if (stage === 'distributed' && facts.supportingInstitutionKeys.length >= 1) {
    stage = 'institutional';
  }
  return {
    key: facts.key,
    stage,
    successfulBatchEventIds: [...facts.successfulBatchEventIds],
    failedBatchEventIds: [...facts.failedBatchEventIds],
    producerIds: [...facts.producerIds],
    adoptedActionEventIds: [...facts.adoptedActionEventIds],
    productionSiteMaterialIds: [...facts.productionSiteMaterialIds],
    supportingInstitutionKeys: [...facts.supportingInstitutionKeys],
  };
}

/** Institution matching is part of the capability formula and is shared by both observers. */
export function supportingMaterialCapabilityInstitutionKeys(
  key: MaterialCapabilityObservation['key'],
  institutionKeys: readonly string[],
): string[] {
  const fragments = exactCapabilityDefinition(key).institutionFragments;
  return institutionKeys.filter((institutionKey) => (
    institutionKey.startsWith(`${RECURRING_DUTY_CAPABILITY_INSTITUTION_PREFIX}:`)
      ? recurringDutyCapabilityFromInstitutionKey(institutionKey) === key
      : institutionKey.startsWith('collective-coordination:')
          && institutionKey.includes(LEGACY_RECURRING_DUTY_INSTITUTION_MARKER)
        ? false
        : fragments.some((fragment) => institutionKey.includes(fragment))
  ));
}

export function materialCapabilityAtLeast(
  capability: MaterialCapabilityObservation | undefined,
  stage: MaterialCapabilityStage,
): boolean {
  return Boolean(capability && STAGE_ORDER.indexOf(capability.stage) >= STAGE_ORDER.indexOf(stage));
}

/**
 * Era observation follows demonstrated capability rather than requiring a
 * civilization to replay one fixed material chronology. Institutional iron
 * is stronger evidence for the ancient metalworking dimension than
 * institutional bronze.
 */
export function ancientMetalworkingCapabilitySatisfied(
  capabilities: MaterialCapabilityObservation[],
): boolean {
  const capability = (key: MaterialCapabilityObservation['key']) => (
    capabilities.find((candidate) => candidate.key === key)
  );
  return materialCapabilityAtLeast(capability('bronze'), 'institutional')
    || materialCapabilityAtLeast(capability('iron'), 'institutional');
}

/**
 * The ancient metalworking facility gate accepts either the bronze casting
 * path or a demonstrated higher-tier ironworking path. The iron alternative
 * remains coupled to institutional capability, so merely installing or using
 * a smithy cannot skip the underlying production, adoption and transmission
 * evidence.
 */
export function ancientMetalworkingFacilitySatisfied(
  capabilities: MaterialCapabilityObservation[],
  facilities: FunctionalBuildingObservation[],
): boolean {
  const activeUsed = (materialId: MaterialId, minimumUses: number) => facilities.some((facility) => (
    facility.materialId === materialId
      && facility.active
      && facility.useEventIds.length >= minimumUses
  ));
  const bronze = capabilities.find((candidate) => candidate.key === 'bronze');
  const iron = capabilities.find((candidate) => candidate.key === 'iron');
  return (materialCapabilityAtLeast(bronze, 'institutional') && activeUsed(Material.Foundry, 3))
    || (materialCapabilityAtLeast(iron, 'institutional') && activeUsed(Material.Smithy, 4));
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
    const supportingInstitutionKeys = supportingMaterialCapabilityInstitutionKeys(
      definition.key,
      institutions.map((institution) => institution.key),
    );
    const months = [...new Set(batches.map((event) => event.atMonth))].sort((left, right) => left - right);
    const producers = [...new Set(batches.map((event) => event.who))];
    return materialCapabilityObservationFromExactFacts({
      key: definition.key,
      successfulBatchCount: batches.length,
      failedBatchCount: failures.length,
      adoptedActionCount: adopted.length,
      firstSuccessfulMonth: months[0] ?? null,
      lastSuccessfulMonth: months.at(-1) ?? null,
      producerIds: producers,
      productionSiteMaterialIds: sites,
      supportingInstitutionKeys,
      successfulBatchEventIds: batches.map((event) => event.id),
      failedBatchEventIds: failures.map((event) => event.id),
      adoptedActionEventIds: adopted.map((event) => event.id),
    });
  });
}

function eraRank(era: DevelopmentEraKey): number {
  return ERA_ORDER.indexOf(normalizeDevelopmentEra(era));
}

function nextEra(era: DevelopmentEraKey): DevelopmentEraKey | null {
  return ERA_ORDER[eraRank(normalizeDevelopmentEra(era)) + 1] ?? null;
}

export type EraGateResults = Partial<Record<DevelopmentEraKey, readonly (readonly [string, unknown])[]>>;

export interface CivilizationDevelopmentFacilityFacts {
  readonly materialId: MaterialId;
  readonly active: boolean;
  /** Exact folded use count; never a bounded witness-array length. */
  readonly useCount: number;
}

export interface CivilizationDevelopmentGateFacts {
  /** `true` means certified current-root index floor >= 120 (or exact full index >= 120). */
  readonly indexAtLeast120Proven: boolean;
  readonly materialCapabilities: readonly MaterialCapabilityObservation[];
  readonly settledCultivationEstablished: boolean;
  readonly storedFoodUnits: number;
  readonly facilities: readonly CivilizationDevelopmentFacilityFacts[];
  readonly functionalInstitutionCount: number;
  readonly modern: Readonly<{
    electricalPower: boolean;
    comparableMeasurement: boolean;
    independentRecordExperiment: boolean;
  }>;
}

/** One gate grammar shared by the full replay observer and bounded exact-fact adapter. */
export function civilizationDevelopmentGateState(
  facts: Readonly<CivilizationDevelopmentGateFacts>,
): EraGateResults {
  const capability = (key: MaterialCapabilityObservation['key']) => (
    facts.materialCapabilities.find((candidate) => candidate.key === key)
  );
  const activeUsed = (materialId: MaterialId, minimumUses = 1) => facts.facilities.some((facility) => (
    facility.materialId === materialId && facility.active && facility.useCount >= minimumUses
  ));
  return {
    'agrarian-settlement': [
      ['index:120', facts.indexAtLeast120Proven],
      ['material:masonry-stone:distributed', materialCapabilityAtLeast(capability('masonry-stone'), 'distributed')],
      ['food:settled-cultivation-cycle', facts.settledCultivationEstablished],
      ['food:stored-units:10', facts.storedFoodUnits >= 10],
      ['facility:granary-used', activeUsed(Material.Granary, 2)],
      ['facility:early-core-used', activeUsed(Material.CouncilHearth, 1)],
      ['institution:early-functional:1', facts.functionalInstitutionCount >= 1],
    ],
    'ancient-civilization': [
      ['material:bronze-or-iron:institutional', ancientMetalworkingCapabilitySatisfied([
        ...facts.materialCapabilities,
      ])],
    ],
    'modern-civilization': [
      ['power:complete-network-useful-load', facts.modern.electricalPower],
      ['measurement:calibrated-comparable-mass', facts.modern.comparableMeasurement],
      ['record:independent-experiment-reuse', facts.modern.independentRecordExperiment],
    ],
  };
}

export const DEVELOPMENT_ERA_STABILITY_MONTHS: Readonly<Record<DevelopmentEraKey, number>> = Object.freeze({
  'primitive-tribe': 0,
  'agrarian-settlement': 12,
  'ancient-civilization': 0,
  'modern-civilization': 0,
  medieval: 0,
});

export interface CivilizationDevelopmentStabilityBasis {
  readonly observerVersion: CivilizationDevelopmentObservation['observerVersion'] | null;
  readonly currentEra: DevelopmentEraKey;
  readonly historicalPeakEra: DevelopmentEraKey;
  readonly candidateEra: DevelopmentEraKey;
  readonly candidateSinceMonth: number;
}

export interface CivilizationDevelopmentStabilityReduction {
  readonly currentEra: DevelopmentEraKey;
  readonly historicalPeakEra: DevelopmentEraKey;
  readonly candidateEra: DevelopmentEraKey;
  readonly candidateSinceMonth: number;
  readonly targetEra: DevelopmentEraKey | null;
  readonly upward: boolean;
  readonly requiredStableMonths: number;
  readonly stableMonths: number;
}

/** Shared stage reducer; it observes facts and never imposes era sequence prerequisites. */
export function reduceCivilizationDevelopmentStability(
  atMonth: number,
  candidateEraInput: DevelopmentEraKey,
  previous: Readonly<CivilizationDevelopmentStabilityBasis>,
): CivilizationDevelopmentStabilityReduction {
  const candidateEra = normalizeDevelopmentEra(candidateEraInput);
  const previousCurrent = normalizeDevelopmentEra(previous.currentEra);
  const previousCandidate = normalizeDevelopmentEra(previous.candidateEra);
  const previousHistoricalPeak = normalizeDevelopmentEra(previous.historicalPeakEra);
  const candidateSinceMonth = previous.observerVersion === DEVELOPMENT_OBSERVER_VERSION
    && previousCandidate === candidateEra
    ? previous.candidateSinceMonth
    : atMonth;
  const upward = eraRank(candidateEra) > eraRank(previousCurrent);
  const requiredStableMonths = DEVELOPMENT_ERA_STABILITY_MONTHS[candidateEra];
  const stableMonths = Math.max(0, atMonth - candidateSinceMonth);
  const currentEra = upward && stableMonths < requiredStableMonths
    ? previousCurrent
    : candidateEra;
  const historicalPeakEra = eraRank(currentEra) > eraRank(previousHistoricalPeak)
    ? currentEra
    : previousHistoricalPeak;
  return {
    currentEra,
    historicalPeakEra,
    candidateEra,
    candidateSinceMonth,
    targetEra: upward ? candidateEra : nextEra(currentEra),
    upward,
    requiredStableMonths,
    stableMonths,
  };
}

/**
 * Development eras are observations of fact bundles, not steps that society
 * must execute in order. Select the highest independently satisfied bundle so
 * a complete higher-era history is not hidden by a missing lower-era trace.
 */
export function highestSatisfiedDevelopmentEra(gates: EraGateResults): DevelopmentEraKey {
  let candidateEra: DevelopmentEraKey = 'primitive-tribe';
  for (const era of ERA_ORDER.slice(1)) {
    const eraGates = gates[era];
    if (eraGates?.every(([, satisfied]) => Boolean(satisfied))) candidateEra = era;
  }
  return candidateEra;
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

export interface ModernCivilizationEvidence {
  electricalPower: {
    networkId: string;
    operationCount: number;
    installationEventIds: string[];
    operationEventIds: string[];
    usefulLoadEventId: string;
  } | null;
  comparableMeasurement: {
    projectId: string;
    calibrationEventId: string;
    measurementEventId: string;
  } | null;
  independentRecordExperiment: {
    eventId: string;
    projectId: string;
    recordId: string;
    knowledgeId: string;
    readerId: string;
    recordAuthorId: string;
  } | null;
  supportingEventIds: string[];
  satisfied: boolean;
}

function modernCivilizationActionFacts(state: SimulationState): ActionFact[] {
  const merged = new Map<string, ActionFact>();
  const retain = (event: unknown): void => {
    if (event
      && typeof event === 'object'
      && (event as { kind?: unknown }).kind === 'action') {
      const action = event as ActionFact;
      merged.set(action.id, action);
    }
  };
  for (const event of actionFacts(state)) retain(event);
  // Keep the former global key readable for any already encoded v7 sidecar,
  // while new projections retain one latest useful load per concrete network.
  const observerLeaseKeys = [
    MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY,
    ...((state.world.electricalPower?.networks ?? []).flatMap((network) => [
      modernElectricalUsefulLoadLeaseKey(network.id),
      modernElectricalOperationLeaseKey(network.id),
    ])),
    MODERN_RECORD_EXPERIMENT_LEASE_KEY,
  ];
  for (const leaseKey of observerLeaseKeys) {
    for (const event of retainedColdWorldEventsForLease(state, leaseKey)) retain(event);
  }
  for (const project of state.projects) {
    if (project.status !== 'completed'
      || project.desiredFunction !== 'comparable-mass-measurement') continue;
    const leaseKey = modernCompletedMeasurementReceiptLeaseKey(project.id);
    for (const eventId of project.completionEventIds) {
      retain(worldEventByIdWithRetainedLease(state, eventId, leaseKey));
    }
  }
  return [...merged.values()].sort(compareWorldEventsInCanonicalOrder);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isModernElectricalOperationFact(
  event: ActionFact,
  networkId: string,
): boolean {
  return event.status === 'completed'
    && event.action.kind === 'act'
    && event.diff.electricalPowerOperation === true
    && event.diff.electricalPowerDelivered === true
    && event.diff.electricalNetworkId === networkId;
}

export function isModernElectricalUsefulLoadFact(
  event: ActionFact,
  networkId: string,
): boolean {
  return isModernElectricalOperationFact(event, networkId)
    && event.diff.electricalPowerUsefulLoad === true;
}

type ModernRecordValidationShell = Pick<SimulationState, 'people' | 'projects' | 'records'>;

/** Validate one completed demand-bound experiment without exposing it to planning. */
export function isIndependentRecordExperimentFact(
  state: ModernRecordValidationShell,
  event: ActionFact,
): boolean {
  if (event.status !== 'completed'
    || event.action.kind !== 'act'
    || event.diff.recordUseStage !== 'experiment'
    || !nonEmptyString(event.diff.recordUseProjectId)
    || !nonEmptyString(event.diff.recordUseRecordId)
    || !nonEmptyString(event.diff.recordUseKnowledgeId)
    || !nonEmptyString(event.diff.recordUseTechniqueId)
    || event.diff.recordUseTechniqueId !== event.diff.recordUseKnowledgeId
    || !nonEmptyString(event.diff.recordUseReaderId)
    || event.diff.recordUseReaderId !== event.who
    || !nonEmptyString(event.diff.recordUseRecordAuthorId)
    || event.diff.recordUseRecordAuthorId === event.diff.recordUseReaderId
    || !Number.isSafeInteger(event.diff.recordUseExpectedOutputMaterialId)
    || event.diff.outputMaterialId !== event.diff.recordUseExpectedOutputMaterialId
    || !Number.isFinite(event.diff.recordUseKnowledgeConfidenceBefore)
    || !Number.isFinite(event.diff.recordUseKnowledgeConfidenceAfter)
    || Number(event.diff.recordUseKnowledgeConfidenceBefore) >= 55
    || Number(event.diff.recordUseKnowledgeConfidenceAfter) < 55
    || Number(event.diff.recordUseKnowledgeConfidenceAfter)
      <= Number(event.diff.recordUseKnowledgeConfidenceBefore)) return false;
  const readerId = event.diff.recordUseReaderId;
  const authorId = event.diff.recordUseRecordAuthorId;
  const project = state.projects.find((candidate) => candidate.id === event.diff.recordUseProjectId
    && candidate.ownerId === readerId
    && (candidate.status === 'active' || candidate.status === 'completed')
    && candidate.actionEventIds.includes(event.id));
  const record = state.records.find((candidate) => candidate.id === event.diff.recordUseRecordId
    && candidate.kind === 'technique'
    && candidate.knowledgeId === event.diff.recordUseKnowledgeId
    && candidate.authorId === authorId);
  const reader = state.people.find((candidate) => candidate.id === readerId);
  const author = state.people.find((candidate) => candidate.id === authorId);
  if (!project || !record || !reader || !author) return false;
  const knowledge = reader.knowledge.find((candidate) => candidate.id === record.knowledgeId
    && candidate.kind === 'technique'
    && candidate.confidence >= Number(event.diff.recordUseKnowledgeConfidenceAfter)
    && candidate.sourceEventIds.includes(event.id));
  const codebook = reader.knowledge.find((candidate) => candidate.id === record.codebookId
    && candidate.kind === 'codebook'
    && candidate.confidence >= 55);
  return Boolean(knowledge && codebook);
}

function recordReplicationGoalForFact(
  state: SimulationState,
  event: ActionFact,
) {
  if (!event.intentId) return null;
  const intent = state.intents.find((candidate) => candidate.id === event.intentId);
  return intent?.goal.kind === 'record-replication-receipt' ? intent.goal : null;
}

/**
 * A reliable reader may reproduce an authored technique without gaining more
 * confidence. This path replays the complete source-bound receipt instead of
 * trusting the event's boolean marker or an observer-era field.
 */
export function isIndependentRecordReplicationReceiptFact(
  state: SimulationState,
  event: ActionFact,
): boolean {
  const goal = recordReplicationGoalForFact(state, event);
  return Boolean(goal && actionSatisfiesRecordReplicationReceipt(state, event, goal));
}

/** Both historical learning experiments and verified replications satisfy the same observer gate. */
export function isIndependentRecordReuseFact(
  state: SimulationState,
  event: ActionFact,
): boolean {
  return isIndependentRecordExperimentFact(state, event)
    || isIndependentRecordReplicationReceiptFact(state, event);
}

/**
 * Full and bounded observers retain the same first canonical witness. The
 * gate is existential; choosing one deterministic fact keeps its cold lease
 * bounded without changing the threshold.
 */
export function firstIndependentRecordReuseFact(state: SimulationState): ActionFact | null {
  const actions = modernCivilizationActionFacts(state);
  for (const event of actions) {
    if (event && isIndependentRecordReuseFact(state, event)) return event;
  }
  return null;
}

function completedMassCalibrationFact(event: ActionFact): boolean {
  if (event.status !== 'completed'
    || event.action.kind !== 'attend'
    || !isSourcedMassMeasurementAction(event.action.measurement)
    || event.action.measurement.mode !== 'calibrate-mass'
    || !isMassCalibrationReceipt(event.diff)) return false;
  return event.diff.calibrationEventId === event.id
    && event.diff.calibratedByPersonId === event.who
    && event.diff.calibratedAtMonth === event.atMonth
    && event.action.instrumentStackId === event.action.measurement.instrument.stackId
    && measurementStackReceiptMatchesUse(event.diff.instrument, event.action.measurement.instrument)
    && measurementStackReceiptMatchesUse(event.diff.reference, event.action.measurement.reference)
    && event.action.target.kind === 'inventory-stack'
    && event.action.target.personId === event.who
    && event.action.target.stackId === event.action.measurement.reference.stackId;
}

function completedMassMeasurementFact(event: ActionFact): boolean {
  if (event.status !== 'completed'
    || event.action.kind !== 'attend'
    || !isSourcedMassMeasurementAction(event.action.measurement)
    || event.action.measurement.mode !== 'measure-mass'
    || !isMassMeasurementReceipt(event.diff)) return false;
  return event.diff.measurementEventId === event.id
    && event.diff.measuredByPersonId === event.who
    && event.diff.measuredAtMonth === event.atMonth
    && event.action.instrumentStackId === event.action.measurement.instrument.stackId
    && measurementStackReceiptMatchesUse(event.diff.instrument, event.action.measurement.instrument)
    && measurementStackReceiptMatchesUse(event.diff.subject, event.action.measurement.subject)
    && event.action.target.kind === 'inventory-stack'
    && event.action.target.personId === event.who
    && event.action.target.stackId === event.action.measurement.subject.stackId;
}

function measurementBasisSupportsSubject(
  basis: MeasurementUncertaintyBasis,
  measurement: ActionFact,
): boolean {
  if (!isMassMeasurementReceipt(measurement.diff)
    || !Array.isArray(basis.samples)
    || basis.samples.length !== 2) return false;
  const receipt = measurement.diff;
  return basis.samples.some((sample) => nonEmptyString(sample.personId)
    && nonEmptyString(sample.stackId)
    && Number.isSafeInteger(sample.materialId)
    && Number.isSafeInteger(sample.quantity)
    && sample.quantity > 0
    && Array.isArray(sample.sourceEventIds)
    && sample.sourceEventIds.every(nonEmptyString)
    && sample.personId === measurement.who
    && sample.stackId === receipt.subject.stackId
    && sample.materialId === receipt.subject.materialId
    && sample.quantity === receipt.subject.quantity
    && sameMeasurementSourceEventIds(sample.sourceEventIds, receipt.subject.sourceEventIds));
}

function completedMeasurementProjectEvidence(
  project: ProjectState,
  actionsById: ReadonlyMap<string, ActionFact>,
): ModernCivilizationEvidence['comparableMeasurement'] {
  const basis = project.measurementUncertaintyBasis;
  if (project.status !== 'completed'
    || project.desiredFunction !== 'comparable-mass-measurement'
    || basis?.version !== 'measurement-uncertainty-basis-v1') return null;
  const completionIds = new Set(project.completionEventIds);
  const completionFacts = project.completionEventIds
    .flatMap((eventId) => {
      const event = actionsById.get(eventId);
      return event ? [event] : [];
    })
    .sort(compareWorldEventsInCanonicalOrder);
  for (const measurement of [...completionFacts].reverse()) {
    if (measurement.who !== project.ownerId
      || !completedMassMeasurementFact(measurement)
      || !isMassMeasurementReceipt(measurement.diff)
      || !measurementBasisSupportsSubject(basis, measurement)) continue;
    const calibration = actionsById.get(measurement.diff.calibrationEventId);
    if (!calibration
      || !completionIds.has(calibration.id)
      || calibration.who !== project.ownerId
      || !completedMassCalibrationFact(calibration)
      || !isMassCalibrationReceipt(calibration.diff)
      || measurement.action.kind !== 'attend'
      || !isSourcedMassMeasurementAction(measurement.action.measurement)
      || measurement.action.measurement.mode !== 'measure-mass'
      || measurement.action.measurement.calibrationEventId !== calibration.id
      || compareWorldEventsInCanonicalOrder(calibration, measurement) >= 0
      || !sameMeasurementStackIdentity(calibration.diff.instrument, measurement.diff.instrument)
      || !sameMeasurementStackIdentity(calibration.diff.reference, measurement.diff.reference)) continue;
    return {
      projectId: project.id,
      calibrationEventId: calibration.id,
      measurementEventId: measurement.id,
    };
  }
  return null;
}

/**
 * Small replay observer for the merged modern era. It reads only committed
 * world/project facts and never exposes an era label or score to planners.
 */
export function observeModernCivilizationEvidence(state: SimulationState): ModernCivilizationEvidence {
  const actions = modernCivilizationActionFacts(state);
  const actionsById = new Map(actions.map((event) => [event.id, event]));

  let electricalPower: ModernCivilizationEvidence['electricalPower'] = null;
  for (const network of state.world.electricalPower?.networks ?? []) {
    if (!Number.isSafeInteger(network.operationCount)
      || network.operationCount < 1
      || !validateElectricalPowerTopology(state.world.grid, network).valid) continue;
    const operations = [...new Set(network.recentOperationEventIds)]
      .flatMap((eventId) => {
        const event = actionsById.get(eventId);
        return event && isModernElectricalOperationFact(event, network.id) ? [event] : [];
      });
    if (operations.length < 1) continue;
    const usefulLoad = actions.find((event) => isModernElectricalUsefulLoadFact(event, network.id));
    if (!usefulLoad) continue;
    electricalPower = {
      networkId: network.id,
      operationCount: network.operationCount,
      installationEventIds: [...new Set(network.installationEventIds
        .filter((eventId) => nonEmptyString(eventId) && actionsById.has(eventId)))],
      operationEventIds: operations.map((event) => event.id),
      usefulLoadEventId: usefulLoad.id,
    };
    break;
  }

  const comparableMeasurement = [...state.projects]
    .sort((left, right) => (left.completedAtMonth ?? Number.MAX_SAFE_INTEGER)
      - (right.completedAtMonth ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id))
    .map((project) => completedMeasurementProjectEvidence(project, actionsById))
    .find((evidence) => evidence !== null) ?? null;

  const recordExperiment = firstIndependentRecordReuseFact(state);
  const replicationGoal = recordExperiment
    ? recordReplicationGoalForFact(state, recordExperiment)
    : null;
  const replicatedRecord = replicationGoal
    ? state.records.find((record) => record.id === replicationGoal.recordId)
    : null;
  const independentRecordExperiment = recordExperiment ? {
    eventId: recordExperiment.id,
    projectId: replicationGoal?.projectId ?? String(recordExperiment.diff.recordUseProjectId),
    recordId: replicationGoal?.recordId ?? String(recordExperiment.diff.recordUseRecordId),
    knowledgeId: replicationGoal?.techniqueId ?? String(recordExperiment.diff.recordUseKnowledgeId),
    readerId: replicationGoal?.readerId ?? String(recordExperiment.diff.recordUseReaderId),
    recordAuthorId: replicatedRecord?.authorId ?? String(recordExperiment.diff.recordUseRecordAuthorId),
  } : null;

  const supportingEventIds = [...new Set([
    ...(electricalPower ? [
      ...electricalPower.installationEventIds,
      ...electricalPower.operationEventIds,
      electricalPower.usefulLoadEventId,
    ] : []),
    ...(comparableMeasurement
      ? [comparableMeasurement.calibrationEventId, comparableMeasurement.measurementEventId]
      : []),
    ...(independentRecordExperiment ? [independentRecordExperiment.eventId] : []),
  ])];
  return {
    electricalPower,
    comparableMeasurement,
    independentRecordExperiment,
    supportingEventIds,
    satisfied: electricalPower !== null
      && comparableMeasurement !== null
      && independentRecordExperiment !== null,
  };
}

function eraGateState(
  state: SimulationState,
  indexTotal: number,
  capabilities: MaterialCapabilityObservation[],
  facilities: FunctionalBuildingObservation[],
  modernEvidence: ModernCivilizationEvidence,
) {
  const establishedCultivation = establishedCultivationEvidence(state);
  const storedFood = state.containers.reduce((sum, container) => sum + container.inventory.reduce((inner, stack) => (
    materialHas(stack.materialId, 'edible') ? inner + stack.quantity : inner
  ), 0), 0);
  return civilizationDevelopmentGateState({
    indexAtLeast120Proven: indexTotal >= 120,
    materialCapabilities: capabilities,
    settledCultivationEstablished: establishedCultivation !== null,
    storedFoodUnits: storedFood,
    facilities: facilities.map((facility) => ({
      materialId: facility.materialId,
      active: facility.active,
      useCount: facility.useEventIds.length,
    })),
    functionalInstitutionCount: state.derived.institutions.length,
    modern: {
      electricalPower: modernEvidence.electricalPower !== null,
      comparableMeasurement: modernEvidence.comparableMeasurement !== null,
      independentRecordExperiment: modernEvidence.independentRecordExperiment !== null,
    },
  });
}

export function observeCivilizationDevelopment(
  state: SimulationState,
  indexTotal: number,
): CivilizationDevelopmentObservation {
  const facilities = observeFunctionalBuildings(state);
  const materialCapabilities = observeMaterialCapabilities(state);
  const establishedCultivation = establishedCultivationEvidence(state);
  const modernEvidence = observeModernCivilizationEvidence(state);
  const gates = eraGateState(state, indexTotal, materialCapabilities, facilities, modernEvidence);
  const candidateEra = highestSatisfiedDevelopmentEra(gates);
  const previous = state.civilization.development;
  const stability = reduceCivilizationDevelopmentStability(
    state.clock.elapsedMonths,
    candidateEra,
    {
      observerVersion: previous?.observerVersion ?? null,
      currentEra: previous?.currentEra ?? 'primitive-tribe',
      historicalPeakEra: previous?.historicalPeakEra ?? 'primitive-tribe',
      candidateEra: previous?.candidateEra ?? 'primitive-tribe',
      candidateSinceMonth: previous?.candidateSinceMonth ?? state.clock.elapsedMonths,
    },
  );
  const {
    currentEra,
    historicalPeakEra,
    candidateSinceMonth,
    targetEra,
    upward,
    requiredStableMonths,
    stableMonths,
  } = stability;
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
    ...modernEvidence.supportingEventIds,
  ])];
  const gateProgress = targetGates.length ? satisfiedGateIds.length / targetGates.length : 1;
  const stabilityProgress = upward && requiredStableMonths > 0
    ? Math.min(1, stableMonths / requiredStableMonths)
    : 1;
  return {
    observerVersion: DEVELOPMENT_OBSERVER_VERSION,
    currentEra,
    historicalPeakEra,
    candidateEra: stability.candidateEra,
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
  const living = livingPeople(state);
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
