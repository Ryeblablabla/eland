/**
 * ELAND composition root.
 *
 * Application services depend only on the ObservationProjector port. This
 * outer module wires the projection adapter while preserving the established
 * public simulation API.
 */
import type {
  AgentDecider,
  BatchDecider,
  SimulationConfig,
  SimulationState,
} from './domain/model';
import {
  adoptSimulationState as adoptApplicationState,
  createInitialState as createApplicationInitialState,
  resetSimulation as resetApplicationSimulation,
  restoreSimulationState as restoreApplicationState,
} from './application/simulation/state-lifecycle';
import {
  createSimulation as createApplicationSimulation,
  createSimulationFromOwnedState as createApplicationSimulationFromOwnedState,
  type SimulationOptions,
} from './application/simulation/controller';
import {
  stepOwnedSimulation as stepOwnedApplicationSimulation,
  stepOwnedSimulationAsync as stepOwnedApplicationSimulationAsync,
  stepSimulation as stepApplicationSimulation,
  stepSimulationAsync as stepApplicationSimulationAsync,
} from './application/simulation/tick-executor';
import { simulationObservationProjector } from './projection/simulation-observation-projector';

export * from './domain/model';
export { MockDecider, RulePlanner } from './application/rule-planner';
export {
  MAX_SIMULATION_MONTHS,
  MAX_SIMULATION_YEARS,
  buildEvolutionReport,
  createDefaultSimulationConfig,
} from './application/simulation/state-lifecycle';
export {
  bindIntentProjectTarget,
  executeActiveIntent,
  installAgreementContinuation,
  resolveInterruptedIntentReturn,
  shouldWaitForSameMonthSharedProject,
  startIntent,
  startInterruptIntent,
} from './application/simulation/intent-execution';
export {
  buildDecisionContextForPerson,
  buildDecisionContexts,
  previewGroundedLifeReviewOpportunity,
} from './application/simulation/tick-planner';
export type {
  ExternalClimateInput,
  SimulationController,
  SimulationOptions,
} from './application/simulation/controller';

export function createInitialState(
  seed = 17,
  inputConfig: Partial<SimulationConfig> = {},
): SimulationState {
  return createApplicationInitialState(simulationObservationProjector, seed, inputConfig);
}

export function adoptSimulationState(input: SimulationState): SimulationState {
  return adoptApplicationState(simulationObservationProjector, input);
}

export function restoreSimulationState(input: SimulationState): SimulationState {
  return restoreApplicationState(simulationObservationProjector, input);
}

export function resetSimulation(
  seed = 17,
  config: Partial<SimulationConfig> = {},
): SimulationState {
  return resetApplicationSimulation(simulationObservationProjector, seed, config);
}

export function stepSimulation(
  input: SimulationState,
  decider?: AgentDecider,
): SimulationState {
  return stepApplicationSimulation(simulationObservationProjector, input, decider);
}

export function stepOwnedSimulation(input: SimulationState): SimulationState {
  return stepOwnedApplicationSimulation(simulationObservationProjector, input);
}

export function stepSimulationAsync(
  input: SimulationState,
  batch: BatchDecider,
): Promise<SimulationState> {
  return stepApplicationSimulationAsync(simulationObservationProjector, input, batch);
}

export function stepOwnedSimulationAsync(
  input: SimulationState,
  batch: BatchDecider,
): Promise<SimulationState> {
  return stepOwnedApplicationSimulationAsync(simulationObservationProjector, input, batch);
}

export function createSimulation(options: SimulationOptions = {}) {
  return createApplicationSimulation(simulationObservationProjector, options);
}

export function createSimulationFromOwnedState(state: SimulationState) {
  return createApplicationSimulationFromOwnedState(simulationObservationProjector, state);
}
