/**
 * Stable capabilities used by ELAND's outer infrastructure adapters.
 *
 * Product/UI callers use `simulation.ts`. Persistence, bounded execution and
 * model gateways sometimes need ports that are intentionally not part of that
 * product API. Keeping those imports here prevents server code from coupling
 * to arbitrary application implementation paths.
 */
export { concludeOwnedCivilization } from './application/civilization-settlement';
export {
  isPlayerInteractionEmergencyContext,
  validatePlayerInteractionChoice,
  type PlayerInteractionChoiceFailure,
} from './application/player-interaction-choice';
export {
  buildPlayerEmbodimentOptions,
  resolvePlayerEmbodimentCommand,
  type PlayerEmbodimentCommandFailure,
} from './application/player-embodiment';
export {
  hasFulfillmentOpportunity,
  isFulfillmentOption,
  isRequiredSocialOption,
} from './application/rule-planner';
export { characterAgendaModelReviewDue } from './application/simulation/model-review';
export {
  type ObservationProjectionMode,
  type ObservationProjector,
} from './application/simulation/observation-projector';
export {
  captureSimulationObservationState,
  deferredSimulationObservationProjection,
  type SimulationObservationSnapshot,
  type SimulationObservationState,
} from './application/simulation/observation-state';
export { cloneValidatedSocialLearningState } from './application/simulation/social-learning-state';
export {
  executePlanningTick,
  finishMonthExecution,
  type ModelAttemptSummary,
  type MonthExecution,
  type TickExecutionResult,
} from './application/simulation/month-execution';
export {
  stepOwnedSimulation as stepOwnedSimulationWithObservationProjector,
} from './application/simulation/tick-executor';
export {
  writeDialogueMemory,
  writePlayerInteractionMemory,
  type DialogueMemoryInput,
  type PlayerInteractionMemoryInput,
} from './domain/agent-memory';
