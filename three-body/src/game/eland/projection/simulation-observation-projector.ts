import type { SimulationState } from '../domain/model';
import { committedHistoryView } from '../domain/history';
import { physicalStructureIndexOf } from '../domain/physical-structure-index';
import type { ObservationProjector } from '../application/simulation/observation-projector';
import {
  deriveObservations,
  updateDevelopmentObservation,
} from './derived-observations';

/** Projection adapter installed by the outer simulation composition root. */
export const simulationObservationProjector: ObservationProjector = {
  project(state: SimulationState, mode: 'development-only' | 'full'): void {
    if (committedHistoryView(state).hotStartIndex > 0) {
      throw new Error('bounded state 缺少已验证的累计观察器投影，不能按热窗口重算文明观察');
    }
    if (mode === 'full') {
      const physicalStructureIndex = physicalStructureIndexOf(state);
      state.derived = deriveObservations(state, physicalStructureIndex);
    }
    updateDevelopmentObservation(state);
  },
};
