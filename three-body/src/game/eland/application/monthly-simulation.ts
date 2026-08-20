/**
 * Stable public facade for the rule-first monthly simulation.
 *
 * Internal orchestration lives under application/simulation so callers do not
 * depend on month-boundary, tick-planning, execution, or controller details.
 */
export * from '../domain/model';
export { MockDecider, RulePlanner } from './rule-planner';
export {
  MAX_SIMULATION_MONTHS,
  MAX_SIMULATION_YEARS,
  buildEvolutionReport,
  createDefaultSimulationConfig,
  createInitialState,
  resetSimulation,
  restoreSimulationState,
} from './simulation/state-lifecycle';
export {
  bindIntentProjectTarget,
  executeActiveIntent,
  installAgreementContinuation,
  resolveInterruptedIntentReturn,
  shouldWaitForSameMonthSharedProject,
  startIntent,
  startInterruptIntent,
} from './simulation/intent-execution';
export {
  buildDecisionContextForPerson,
  buildDecisionContexts,
  previewGroundedLifeReviewOpportunity,
} from './simulation/tick-planner';
export {
  stepSimulation,
  stepSimulationAsync,
} from './simulation/tick-executor';
export {
  createSimulation,
  type SimulationController,
} from './simulation/controller';
