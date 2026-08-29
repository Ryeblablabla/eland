import type {
  CivilizationDevelopmentObservation,
  CivilizationIndex,
  DecisionAuthorityState,
  PersistedSimulationObservations,
  SimulationState,
} from '../../domain/model';

/**
 * The authoritative portion of schema-17 state. Observer-owned values remain
 * flat in the persisted state, but are deliberately absent from this port.
 */
export type SimulationAuthorityState = DecisionAuthorityState;

type TypedArrayMutationMethod = 'copyWithin' | 'fill' | 'reverse' | 'set' | 'sort';

/** Recursive compile-time read view used at the projector port. */
export type DeepReadonly<Value> =
  Value extends (...args: never[]) => unknown ? Value
    : Value extends ArrayBufferView
      ? Readonly<Omit<Value, TypedArrayMutationMethod>>
      : Value extends readonly (infer Item)[]
        ? readonly DeepReadonly<Item>[]
        : Value extends ReadonlyMap<infer Key, infer Item>
          ? ReadonlyMap<DeepReadonly<Key>, DeepReadonly<Item>>
          : Value extends ReadonlySet<infer Item>
            ? ReadonlySet<DeepReadonly<Item>>
            : Value extends object
              ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
              : Value;

/** Exact observer-owned values as persisted by schema 17. */
export interface SimulationObservationState {
  readonly stage: string;
  readonly civilizationIndex: CivilizationIndex;
  /** Absence is preserved as absence; it is never normalized to `undefined`. */
  readonly development?: CivilizationDevelopmentObservation;
  readonly derived: PersistedSimulationObservations;
}

/**
 * Recursively read-only input to an observation adapter. The authority root
 * and civilization object are detached from SimulationState, so the adapter
 * never receives the aggregate's writable root. Nested values are shared only
 * across this read port. Any adapter that needs a mutable work model must first
 * take an owned deep clone; the production adapter enforces that transfer at
 * its single compatibility boundary.
 */
export interface SimulationObservationSnapshot {
  readonly authority: DeepReadonly<SimulationAuthorityState>;
  readonly previousObservations: DeepReadonly<SimulationObservationState>;
}

export interface SimulationObservationPatch {
  readonly kind: 'materialized';
  readonly observations: DeepReadonly<SimulationObservationState>;
}

export interface DeferredSimulationObservationProjection {
  readonly kind: 'deferred';
  readonly reason: string;
}

export type SimulationObservationProjection =
  | SimulationObservationPatch
  | DeferredSimulationObservationProjection;

function simulationObservationReadView(
  state: SimulationState,
): SimulationObservationState {
  return Object.freeze({
    stage: state.civilization.stage,
    civilizationIndex: state.civilization.civilizationIndex,
    ...(state.civilization.development === undefined
      ? {}
      : { development: state.civilization.development }),
    derived: state.derived,
  });
}

/** Capture an owned observer snapshot for equality checks and patch building. */
export function captureSimulationObservationState(
  state: SimulationState,
): SimulationObservationState {
  return structuredClone(simulationObservationReadView(state));
}

/**
 * The single capture boundary for projection adapters. Runtime-only extension
 * fields on a persisted state are intentionally not spread into authority.
 */
export function captureSimulationObservationSnapshot(
  state: SimulationState,
): SimulationObservationSnapshot {
  const civilization = Object.freeze({
    number: state.civilization.number,
    status: state.civilization.status,
    epoch: state.civilization.epoch,
    era: state.civilization.era,
    climate: state.civilization.climate,
    weather: state.civilization.weather,
    ...(state.civilization.externalClimate === undefined
      ? {}
      : { externalClimate: state.civilization.externalClimate }),
    conditions: state.civilization.conditions,
    ...(state.civilization.outcome === undefined
      ? {}
      : { outcome: state.civilization.outcome }),
  } satisfies SimulationAuthorityState['civilization']);
  const authority = Object.freeze({
    schemaVersion: state.schemaVersion,
    seed: state.seed,
    branchId: state.branchId,
    ...(state.identityCounters === undefined
      ? {}
      : { identityCounters: state.identityCounters }),
    clock: state.clock,
    world: state.world,
    people: state.people,
    intents: state.intents,
    agreements: state.agreements,
    records: state.records,
    collectives: state.collectives,
    permissions: state.permissions,
    containers: state.containers,
    eraPredictions: state.eraPredictions,
    projects: state.projects,
    civilization,
    decisionBudget: state.decisionBudget,
    lastStep: state.lastStep,
  } satisfies SimulationAuthorityState);
  return Object.freeze({
    authority,
    previousObservations: simulationObservationReadView(state),
  });
}

export function materializedSimulationObservationPatch(
  observations: SimulationObservationState,
): SimulationObservationPatch {
  return Object.freeze({
    kind: 'materialized',
    observations: Object.freeze(structuredClone(observations)),
  });
}

export function deferredSimulationObservationProjection(
  reason: string,
): DeferredSimulationObservationProjection {
  return Object.freeze({ kind: 'deferred', reason });
}

/**
 * The only observer-state write boundary. Deferred projections are explicit
 * no-ops; callers decide whether deferral is legal for their use case.
 */
export function applySimulationObservationProjection(
  state: SimulationState,
  projection: SimulationObservationProjection,
): boolean {
  if (projection.kind === 'deferred') return false;
  const observations = structuredClone(
    projection.observations,
  ) as SimulationObservationState;
  state.civilization.stage = observations.stage;
  state.civilization.civilizationIndex = observations.civilizationIndex;
  if (observations.development === undefined) delete state.civilization.development;
  else state.civilization.development = observations.development;
  state.derived = observations.derived;
  return true;
}
