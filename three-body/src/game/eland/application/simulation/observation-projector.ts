import type { SimulationState } from '../../domain/model';

/**
 * Output port invoked only after authoritative facts and physical indexes have
 * been committed. Implementations live outside application/domain so observer
 * state cannot enter planning or rule evaluation through this dependency.
 */
export interface ObservationProjector {
  project(state: SimulationState, mode: 'development-only' | 'full'): void;
}
