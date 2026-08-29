import type {
  SimulationObservationProjection,
  SimulationObservationSnapshot,
} from './observation-state';

export type ObservationProjectionMode =
  | 'structures-only'
  | 'development-only'
  | 'full';

/**
 * Output port invoked only after authoritative facts and physical indexes have
 * been committed. Implementations live outside application/domain so observer
 * state cannot enter planning or rule evaluation through this dependency.
 */
export interface ObservationProjector {
  project(
    snapshot: SimulationObservationSnapshot,
    mode: ObservationProjectionMode,
  ): SimulationObservationProjection;
}
