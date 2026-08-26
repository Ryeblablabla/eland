import { COGNITION_VERSION } from '../src/game/eland/domain/cognition';
import { primeEventIndex } from '../src/game/eland/domain/event-index';
import { committedHistoryView } from '../src/game/eland/domain/history';
import {
  MECHANICAL_POWER_WORLD_VERSION,
  migrateMechanicalPowerWorldState,
} from '../src/game/eland/domain/mechanical-power';
import type { SimulationState } from '../src/game/eland/domain/model';
import type { RetainedProjectPressureEvidenceDescriptor } from '../src/game/eland/domain/project-pressure-evidence';
import { rematerializePhysicalStructureIndex } from '../src/game/eland/domain/physical-structure-index';
import { WILDLIFE_ECOLOGY_VERSION } from '../src/game/eland/domain/wildlife-ecology';
import { cloneValidatedSocialLearningState } from '../src/game/eland/application/simulation/social-learning-state';
import { hydrateWorld, voxelWorldRevision } from '../src/game/eland/world/grid';
import {
  beginHistoryRetentionProjection,
  finishHistoryRetentionProjection,
  foldHistoryRetentionSegment,
  type HistoryRetentionProjectionResult,
} from './history-retention-projection';
import {
  assertPhysicalStructureLedgerProjectionMatchesShell,
  decodeBoundedRunStateWithPhysicalProjection,
  type PhysicalStructureLedgerProjectionResult,
} from './physical-structure-ledger-projection';
import {
  installVerifiedHistoryRetentionEvidence,
  projectPressureColdMaterializationOrdinals,
} from './retained-history-evidence';
import {
  decodeSegmentedRunStateBounded,
  materializeVerifiedRunHistoryPinnedEvents,
  parseRunStateRoot,
  snapshotRunStateChunk,
  streamVerifiedRunHistorySegments,
  type RunStateChunk,
  type RunStatePinnedEvent,
} from './run-state-codec';

export interface BoundedSimulationAdoptionReceipt {
  readonly kind: 'bounded-simulation-adoption-receipt-v1';
  /** Deliberately false until every full-history rule/projection is migrated. */
  readonly continuationReady: false;
  readonly stateHash: string;
  readonly eventCount: number;
  readonly hotStartIndex: number;
}

function requiredArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`bounded state 缺少当前字段 ${label}`);
}

function requiredObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`bounded state 缺少当前字段 ${label}`);
  }
}

/**
 * Validate a current, already-normalized shell and install its verified cold
 * evidence without replaying history. This is only a v29 adoption foundation:
 * callers must not step the state until physical structures, observer summaries
 * and remaining full-history rule queries have bounded continuation paths.
 */
function adoptDecodedBoundedSimulationState(
  state: SimulationState,
  expectedStateHash: string,
  projection: HistoryRetentionProjectionResult,
  decodedColdPins: readonly RunStatePinnedEvent[],
  decodedProjectPressureSources: readonly RunStatePinnedEvent[],
  reusableProjectPressureDescriptors: readonly RetainedProjectPressureEvidenceDescriptor[],
  physicalProjection: PhysicalStructureLedgerProjectionResult,
  physicalAuthority: 'verified-root-stream' | 'store-decoded-sidecar',
): BoundedSimulationAdoptionReceipt {
  if (Number((state as { schemaVersion?: number }).schemaVersion) !== 17) {
    throw new Error('bounded state 只接受当前 schemaVersion 17');
  }
  const history = committedHistoryView(state);
  if (state.world.past.length !== history.hotEventCount) {
    throw new Error('bounded state 必须携带完整连续热窗口');
  }

  requiredArray(state.world.animals, 'world.animals');
  requiredArray(state.world.remains, 'world.remains');
  requiredArray(state.world.memorials, 'world.memorials');
  requiredObject(state.world.traffic, 'world.traffic');
  requiredArray(state.records, 'records');
  requiredArray(state.collectives, 'collectives');
  requiredArray(state.permissions, 'permissions');
  requiredArray(state.containers, 'containers');
  requiredArray(state.eraPredictions, 'eraPredictions');
  requiredArray(state.projects, 'projects');
  requiredArray(state.people, 'people');
  requiredArray(state.agreements, 'agreements');
  requiredArray(state.intents, 'intents');
  requiredArray(state.lastStep, 'lastStep');
  requiredObject(state.civilization.weather, 'civilization.weather');
  requiredObject(state.civilization.civilizationIndex, 'civilization.civilizationIndex');
  requiredObject(state.civilization.era, 'civilization.era');
  requiredObject(state.derived, 'derived');
  for (const field of ['practices', 'institutions', 'milestones', 'regions', 'structures'] as const) {
    requiredArray(state.derived[field], `derived.${field}`);
  }
  if (Object.prototype.hasOwnProperty.call(state.civilization, 'integrity')) {
    throw new Error('bounded state 仍含待迁移的 civilization.integrity');
  }
  const endpoint = state.civilization.conditions.endpoint;
  if (!Number.isInteger(endpoint.value)
    || endpoint.value < 1
    || (endpoint.kind === 'months' && endpoint.value > 12_000)) {
    throw new Error('bounded state 的文明终点尚未规范化');
  }

  if (state.world.mechanicalPower?.version !== MECHANICAL_POWER_WORLD_VERSION) {
    throw new Error('bounded state 的机械动力世界版本不是当前版本');
  }
  // This store-owned adoption path deliberately bypasses the ordinary state
  // lifecycle normalizer. Apply the same current-shell-only v17 migration here
  // before any planner can observe legacy cumulative mechanical event arrays.
  migrateMechanicalPowerWorldState(state.world.mechanicalPower);
  for (const drop of state.world.drops) {
    if (!Number.isInteger(drop.z)) throw new Error(`bounded state 的 drop ${drop.id} 缺少当前 z`);
  }
  for (const animal of state.world.animals) {
    if (animal.ecology?.version !== WILDLIFE_ECOLOGY_VERSION
      || !animal.ecology.currentBehavior
      || !Number.isInteger(animal.ecology.currentBehavior.atMonth)) {
      throw new Error(`bounded state 的动物 ${animal.id} 生态尚未迁移`);
    }
  }
  for (const person of state.people) {
    if (typeof person.familyName !== 'string'
      || person.familyName.length === 0
      || person.namingTradition === undefined
      || !Array.isArray(person.traits)
      || !Array.isArray(person.bereavements)
      || !Array.isArray(person.knownPlaces)
      || !Number.isFinite(person.geneticLoad)
      || person.cognition?.version !== COGNITION_VERSION
      || !Array.isArray(person.cognition.outcomeBeliefs)
      || !Array.isArray(person.cognition.goalOutcomeBeliefs)
      || !Array.isArray(person.cognition.needResolutionEpisodes)
      || !Number.isInteger(person.position.z)
      || !Number.isInteger(person.position.previousZ)
      || !Array.isArray(person.position.lastPath)
      || person.position.lastPath.length === 0
      || !Array.isArray(person.position.tickPath)
      || person.position.tickPath.length === 0) {
      throw new Error(`bounded state 的人物 ${person.id} 尚未完成当前 schema 迁移`);
    }
    const socialLearning = cloneValidatedSocialLearningState(
      person,
      state.people,
      state.clock.elapsedMonths,
    );
    if (socialLearning) person.cognition.socialLearning = socialLearning;
    else delete person.cognition.socialLearning;
  }
  for (const collective of state.collectives) {
    if (!Array.isArray(collective.decisionRules) || !Array.isArray(collective.mandates)) {
      throw new Error(`bounded state 的群体 ${collective.id} 尚未完成当前 schema 迁移`);
    }
  }
  for (const agreement of state.agreements) {
    if (!Array.isArray(agreement.requiredResponderIds)
      || !Array.isArray(agreement.acceptedByPersonIds)
      || !Array.isArray(agreement.rejectedByPersonIds)) {
      throw new Error(`bounded state 的约定 ${agreement.id} 尚未完成当前 schema 迁移`);
    }
  }
  for (const event of state.world.past) {
    if (!Number.isInteger(event.planningTick) || !Number.isInteger(event.orderInTick)) {
      throw new Error(`bounded state 的热事件 ${event.id} 尚未补齐规划序号`);
    }
    if (event.kind === 'action' && (!Number.isInteger(event.fromZ) || !Number.isInteger(event.toZ))) {
      throw new Error(`bounded state 的热行动 ${event.id} 尚未补齐高度`);
    }
  }

  const hydratedGrid = hydrateWorld(state.world.grid);
  if (physicalAuthority === 'verified-root-stream') {
    assertPhysicalStructureLedgerProjectionMatchesShell(state, expectedStateHash, physicalProjection);
  } else {
    // TODO(atomic-continuation-publication): the eventual writer must accept
    // only a physical sidecar encoded from a verified-root-stream projection
    // under the same CAS. A codec-valid shape alone is not that provenance
    // proof. Until that publisher exists, continuationReady remains false and
    // this read seam never reuses persisted `structures`: rematerialization
    // below recomputes topology from authenticated records plus the grid.
    const cursor = state.world.historyCursor;
    if (physicalProjection.schemaVersion !== 1
      || physicalProjection.authority.stateHash !== expectedStateHash
      || physicalProjection.target.eventCount !== history.eventCount
      || physicalProjection.target.tailEventId !== cursor?.tailEventId
      || physicalProjection.index.projectionVersion !== 2
      || physicalProjection.index.appliedHistoryEventCount !== history.eventCount
      || physicalProjection.index.appliedTailEventId !== cursor?.tailEventId
      || physicalProjection.index.calculatedAtMonth !== state.clock.elapsedMonths
      || physicalProjection.index.voxelRevision !== voxelWorldRevision(state.world.grid)) {
      throw new Error('store-decoded physical ledger projection 与当前 shell 封印不一致');
    }
  }
  const physical = physicalProjection.index;
  if (!physical
    || physical.projectionVersion !== 2
    || physical.appliedHistoryEventCount !== history.eventCount
    || physical.appliedTailEventId !== state.world.historyCursor?.tailEventId
    || physical.calculatedAtMonth !== state.clock.elapsedMonths
    || !Number.isSafeInteger(physical.voxelRevision)
    || Number(physical.voxelRevision) < 0
    || !Number.isSafeInteger(physical.constructionEventCount)
    || !Array.isArray(physical.constructionRecords)
    || !Array.isArray(physical.structures)) {
    throw new Error('bounded state 缺少与绝对历史同月封存的物理结构 v2 投影');
  }
  const retainedObjects = new Set(decodedColdPins.map((pin) => pin.event));
  const hotObjects = new Set(state.world.past);
  if (state.lastStep.some((event) => !hotObjects.has(event) && !retainedObjects.has(event))) {
    throw new Error('bounded state 的 lastStep 未绑定到已验证热事实或冷 pin');
  }

  // Hydration plus the explicit current-shell-only mechanical migration above
  // are the only normalizations permitted on this path. An all-hot genesis has
  // no omitted prefix to infer; once hotStartIndex grows above zero, every
  // history-dependent cold fact must still come from verified retention pins.
  state.world.grid = hydratedGrid;
  // Always rebuild topology from authenticated records after hydration. Equal
  // process-local revision numbers must never cause persisted structures to be
  // reused without this explicit materialization.
  state.world.physicalStructureIndex = rematerializePhysicalStructureIndex(state, physical);
  installVerifiedHistoryRetentionEvidence(
    state,
    expectedStateHash,
    projection,
    decodedColdPins,
    decodedProjectPressureSources,
    reusableProjectPressureDescriptors,
  );
  primeEventIndex(state);
  return Object.freeze({
    kind: 'bounded-simulation-adoption-receipt-v1',
    continuationReady: false,
    stateHash: expectedStateHash,
    eventCount: history.eventCount,
    hotStartIndex: history.hotStartIndex,
  });
}

/**
 * Install gameplay-facing evidence from sidecars that an owning store has
 * already decoded against one exact root/bundle/checkpoint snapshot. This
 * helper cannot mint store authority: it only validates the decoded shell join
 * and installs retention facts plus rematerialized physical topology.
 * Observer projections and checkpoint accumulators deliberately have no
 * parameter here, so they cannot become planner-readable state by accident.
 */
export function adoptStoreDecodedBoundedSimulationState(
  state: SimulationState,
  expectedStateHash: string,
  projection: HistoryRetentionProjectionResult,
  decodedColdPins: readonly RunStatePinnedEvent[],
  decodedProjectPressureSources: readonly RunStatePinnedEvent[],
  reusableProjectPressureDescriptors: readonly RetainedProjectPressureEvidenceDescriptor[],
  physicalProjection: PhysicalStructureLedgerProjectionResult,
): BoundedSimulationAdoptionReceipt {
  return adoptDecodedBoundedSimulationState(
    state,
    expectedStateHash,
    projection,
    decodedColdPins,
    decodedProjectPressureSources,
    reusableProjectPressureDescriptors,
    physicalProjection,
    'store-decoded-sidecar',
  );
}

export interface BoundedSimulationAdoptionOptions {
  hotEventLimit: number;
}

/**
 * Closed exact-root adoption boundary. Shell decode, retention projection,
 * pin decode and physical projection all happen internally; external callers
 * receive only an opaque non-continuation receipt and cannot mix artifacts
 * from another state root.
 */
export async function adoptBoundedSimulationState(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  options: BoundedSimulationAdoptionOptions,
): Promise<BoundedSimulationAdoptionReceipt> {
  const rootSnapshot = snapshotRunStateChunk(rootChunk);
  const root = parseRunStateRoot(rootSnapshot);
  if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error('bounded adoption 只接受稳定尾校验的 schema 2/3 run root');
  }
  if (!options || !Number.isSafeInteger(options.hotEventLimit) || options.hotEventLimit < 0) {
    throw new Error('bounded adoption 的 hotEventLimit 必须是非负安全整数');
  }

  const initial = await decodeSegmentedRunStateBounded(
    rootSnapshot,
    readChunk,
    { hotEventLimit: options.hotEventLimit },
  );
  const retentionFold = beginHistoryRetentionProjection(
    initial.state,
    { stateHash: rootSnapshot.hash },
  );
  await streamVerifiedRunHistorySegments(root, readChunk, (events, position) => {
    foldHistoryRetentionSegment(retentionFold, events, position.startEventIndex);
  });
  const retentionProjection = finishHistoryRetentionProjection(retentionFold);

  const decoded = await decodeBoundedRunStateWithPhysicalProjection(
    rootSnapshot,
    readChunk,
    {
      hotEventLimit: options.hotEventLimit,
      pinnedEventIndexes: retentionProjection.pins.map((pin) => pin.absoluteIndex),
    },
  );
  const projectPressureSources = materializeVerifiedRunHistoryPinnedEvents(
    root,
    readChunk,
    projectPressureColdMaterializationOrdinals(
      decoded.state,
      retentionProjection,
      decoded.pinnedEvents,
    ),
  );
  return adoptDecodedBoundedSimulationState(
    decoded.state,
    rootSnapshot.hash,
    retentionProjection,
    decoded.pinnedEvents,
    projectPressureSources,
    [],
    decoded.physicalProjection,
    'verified-root-stream',
  );
}
