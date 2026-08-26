import type { SimulationState } from '../src/game/eland/domain/model';
import {
  WORLD_CELL_COUNT,
  cellsInRadius,
} from '../src/game/eland/world/grid';
import {
  assertDecodedObserverDerivedHistorySidecar,
  type ObserverDerivedHistoryCanonicalDemandV1,
  type ObserverDerivedHistorySidecarPayloadV1,
} from './observer-derived-history-codec';
import {
  assertPhysicalStructureLedgerProjectionMatchesShell,
  type PhysicalStructureLedgerProjectionResult,
} from './physical-structure-ledger-projection';

/**
 * Demand collector for the exact-root derived-observer successor. It is kept
 * server-side because these leases are replay requirements, never facts that
 * people may perceive or use to choose an action.
 */
export const OBSERVER_DERIVED_HISTORY_SHELL_DEMAND_DEFINITION =
  'observer-derived-history-shell-demand-v1' as const;

export interface ObserverDerivedHistoryShellDemandInput {
  /** Strict-decoded previous sidecar; only its finite retained set is carried. */
  readonly previous: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
  /** The exact bounded shell returned alongside `physicalProjection`. */
  readonly nextState: SimulationState;
  readonly nextStateHash: string;
  /** Runtime identity minted by the physical exact-root projection module. */
  readonly physicalProjection: PhysicalStructureLedgerProjectionResult;
}

export interface ObserverDerivedHistoryGenesisDemandInput {
  /** The exact bounded shell returned alongside `physicalProjection`. */
  readonly state: SimulationState;
  readonly stateHash: string;
  /** Runtime identity minted by the physical exact-root projection module. */
  readonly physicalProjection: PhysicalStructureLedgerProjectionResult;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function completedCultivationDemand(state: SimulationState) {
  return state.projects.flatMap((project) => {
    if (project.status !== 'completed'
      || project.desiredFunction !== 'settled-cultivation'
      || project.completionEventIds.length === 0
      || !project.site) return [];
    if (!Number.isSafeInteger(project.completedAtMonth)
      || Number(project.completedAtMonth) < 0) {
      throw new Error(`completed settled-cultivation project ${project.id} 缺少完成月份`);
    }
    if (!Number.isSafeInteger(project.site.cellId)
      || project.site.cellId < 0
      || project.site.cellId >= WORLD_CELL_COUNT) {
      throw new Error(`settled-cultivation project ${project.id} 的 site 无效`);
    }
    const actionEventIds = uniqueStrings(project.actionEventIds)
      .sort((left, right) => left.localeCompare(right));
    const actionIds = new Set(actionEventIds);
    return [{
      projectId: project.id,
      completedAtMonth: Number(project.completedAtMonth),
      siteCellIds: cellsInRadius(project.site.cellId, 2)
        .sort((left, right) => left - right),
      actionEventIds,
      // Existing observer semantics only considers completion facts that are
      // also project actions. Preserve completion order because it is semantic.
      completionEventIds: uniqueStrings(project.completionEventIds)
        .filter((eventId) => actionIds.has(eventId)),
    }];
  }).sort((left, right) => left.completedAtMonth - right.completedAtMonth
    || left.projectId.localeCompare(right.projectId));
}

function currentFutureEventIds(
  state: SimulationState,
  physicalProjection: PhysicalStructureLedgerProjectionResult,
): string[] {
  const constructionRecords = physicalProjection.index.constructionRecords;
  if (!constructionRecords) {
    throw new Error('observer derived history demand 缺少 physical construction records');
  }
  const representedPhysicalSources = new Set(
    physicalProjection.index.structures.flatMap((structure) => structure.sourceEventIds),
  );
  const incompletePhysicalSources = physicalProjection.index.structures
    .filter((structure) => !structure.complete)
    .flatMap((structure) => structure.sourceEventIds);
  // A construction fact can remain outside every currently connected
  // structure, then become residential evidence when a later placement joins
  // the component. Keep those finite ledger records in the future closure
  // before the observer first demands the completed structure.
  const ungroupedPhysicalSources = constructionRecords
    .filter((record) => !representedPhysicalSources.has(record.sourceEventId))
    .map((record) => record.sourceEventId);
  const activeCultivationSources = state.projects
    .filter((project) => project.status === 'active'
      && project.desiredFunction === 'settled-cultivation')
    .flatMap((project) => [
      ...project.actionEventIds,
      ...project.completionEventIds,
    ]);
  return uniqueStrings([
    ...incompletePhysicalSources,
    ...ungroupedPhysicalSources,
    ...activeCultivationSources,
  ]).sort((left, right) => left.localeCompare(right));
}

/**
 * Compute successor demand from the current bounded shell and an exact-root
 * physical authority. Callers cannot inject a demand object into the successor.
 *
 * The previous retained set is deliberately carried unchanged. This keeps the
 * store-decoded finite lease stable without unioning arbitrary historical pins.
 * Future IDs are recomputed solely from live incomplete structures and active
 * settled-cultivation projects, so ended obligations do not accumulate.
 */
export function collectObserverDerivedHistoryDemandFromVerifiedShell(
  input: Readonly<ObserverDerivedHistoryShellDemandInput>,
): Readonly<ObserverDerivedHistoryCanonicalDemandV1> {
  assertDecodedObserverDerivedHistorySidecar(input.previous);
  return collectObserverDerivedHistoryDemand(
    input.nextState,
    input.nextStateHash,
    input.physicalProjection,
    input.previous.sourceDemand.retainedEventIds,
  );
}

function collectObserverDerivedHistoryDemand(
  state: SimulationState,
  stateHash: string,
  physicalProjection: PhysicalStructureLedgerProjectionResult,
  retainedEventIds: readonly string[],
): Readonly<ObserverDerivedHistoryCanonicalDemandV1> {
  assertPhysicalStructureLedgerProjectionMatchesShell(
    state,
    stateHash,
    physicalProjection,
  );

  const demand: ObserverDerivedHistoryCanonicalDemandV1 = {
    settledCultivationProjects: completedCultivationDemand(state),
    residentialStructures: physicalProjection.index.structures
      .filter((structure) => structure.complete)
      .map((structure) => ({
        structureId: structure.id,
        // Physical projection order is semantic: residential materialization
        // selects the first source whose exact historical fact resolves.
        sourceEventIds: uniqueStrings(structure.sourceEventIds),
      }))
      .sort((left, right) => left.structureId.localeCompare(right.structureId)),
    retainedEventIds: [...retainedEventIds],
    futureEventIds: currentFutureEventIds(state, physicalProjection),
  };
  return deepFreeze(demand);
}

/**
 * Build the initial demand closure for a run that has no persisted observer
 * continuation yet. The current shell and physical projection are joined by
 * the physical module's process-local exact-root provenance; callers cannot
 * inject historical retained IDs at genesis. Every other selector is shared
 * with the ordinary exact-successor collector above.
 */
export function collectObserverDerivedHistoryGenesisDemandFromVerifiedShell(
  input: Readonly<ObserverDerivedHistoryGenesisDemandInput>,
): Readonly<ObserverDerivedHistoryCanonicalDemandV1> {
  return collectObserverDerivedHistoryDemand(
    input.state,
    input.stateHash,
    input.physicalProjection,
    [],
  );
}
