import type { SimulationState } from '../domain/model';
import { derivePhysicalStructureIndex } from '../domain/physical-structure-index';
import type { ObservationProjector } from '../application/simulation/observation-projector';
import {
  deriveObservations,
  updateDevelopmentObservation,
} from './derived-observations';

/** Projection adapter installed by the outer simulation composition root. */
export const simulationObservationProjector: ObservationProjector = {
  project(state: SimulationState, mode: 'development-only' | 'full'): void {
    if (mode === 'full') {
      const physicalStructureIndex = state.world.physicalStructureIndex
        ?? derivePhysicalStructureIndex(state);
      state.derived = deriveObservations(state, physicalStructureIndex);
    }
    updateDevelopmentObservation(state);
  },
};
