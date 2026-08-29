import type { PhysicalStructureIndex, SimulationState } from '../domain/model';
import { committedHistoryView } from '../domain/history';
import {
  copyPhysicalStructures,
  physicalStructureIndexOf,
} from '../domain/physical-structure-index';
import type { ObservationProjector } from '../application/simulation/observation-projector';
import type {
  DeepReadonly,
  SimulationAuthorityState,
  SimulationObservationSnapshot,
  SimulationObservationState,
} from '../application/simulation/observation-state';
import {
  deriveObservations,
  updateDevelopmentObservation,
} from './derived-observations';

/**
 * Convert a recursively read-only value only after structuredClone has severed
 * every reference to the authoritative aggregate. The assertion is confined
 * to this ownership-transfer helper; observers never receive shared writable
 * state through it.
 */
function detachedMutableClone<Value>(value: DeepReadonly<Value>): Value {
  return structuredClone(value) as Value;
}

/** Build an owned aggregate-shaped work model for existing pure observers. */
function observationReadState(snapshot: SimulationObservationSnapshot): SimulationState {
  const authority = detachedMutableClone<SimulationAuthorityState>(snapshot.authority);
  const previous = detachedMutableClone<SimulationObservationState>(
    snapshot.previousObservations,
  );
  return {
    ...authority,
    // physicalStructureIndexOf may refresh this property. Every nested value
    // is already owned by this projection work model.
    world: { ...authority.world },
    civilization: {
      ...authority.civilization,
      stage: previous.stage,
      civilizationIndex: previous.civilizationIndex,
      ...(previous.development === undefined
        ? {}
        : { development: previous.development }),
    },
    derived: previous.derived,
  };
}

/** Projection adapter installed by the outer simulation composition root. */
export const simulationObservationProjector: ObservationProjector = {
  project(snapshot, mode) {
    const historyCursor = snapshot.authority.world.historyCursor;
    if (!historyCursor) {
      throw new Error('观察器输入缺少已提交 history cursor');
    }
    if (historyCursor.hotStartIndex > 0) {
      throw new Error('bounded state 缺少已验证的累计观察器投影，不能按热窗口重算文明观察');
    }
    if (mode === 'structures-only') {
      const physicalStructureIndex = snapshot.authority.world.physicalStructureIndex;
      if (!physicalStructureIndex) {
        throw new Error('观察器输入缺少已提交 physicalStructureIndex');
      }
      const previous = detachedMutableClone<SimulationObservationState>(
        snapshot.previousObservations,
      );
      return Object.freeze({
        kind: 'materialized' as const,
        observations: Object.freeze({
          ...previous,
          derived: {
            ...previous.derived,
            structures: copyPhysicalStructures(
              detachedMutableClone<PhysicalStructureIndex>(physicalStructureIndex),
            ),
          },
        }),
      });
    }
    const state = observationReadState(snapshot);
    if (committedHistoryView(state).hotStartIndex > 0) {
      throw new Error('bounded state 缺少已验证的累计观察器投影，不能按热窗口重算文明观察');
    }
    const physicalStructureIndex = physicalStructureIndexOf(state);
    if (mode === 'full') {
      state.derived = deriveObservations(state, physicalStructureIndex);
    }
    updateDevelopmentObservation(state);
    const observations: SimulationObservationState = structuredClone({
      stage: state.civilization.stage,
      civilizationIndex: state.civilization.civilizationIndex,
      ...(state.civilization.development === undefined
        ? {}
        : { development: state.civilization.development }),
      derived: state.derived,
    });
    return Object.freeze({
      kind: 'materialized',
      observations: Object.freeze(observations),
    });
  },
};
