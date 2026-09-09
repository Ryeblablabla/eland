import { PLANNING_TICKS_PER_MONTH } from '../../domain/calendar';
import type { AgentDecider, BatchDecider, Decision, SimulationState, TokenUsage } from '../../domain/model';
import type { PersonId } from '../../domain/person';
import { RulePlanner } from '../rule-planner';
import { createMonthExecution, executeRemainingPlanningTicks, finishMonthExecution, type ModelAttemptSummary } from './month-execution';
import { prepareMonth, type PreparedMonth } from './month-boundary';
import type { ObservationProjector } from './observation-projector';
import { createModelMonthPlanningState, executeModelPlanningTick, modelOwnedExecutionPlanner } from './model-month-planning';

const authoritativeRulePlanner = new RulePlanner();

function executePrepared(
  observationProjector: ObservationProjector,
  prepared: PreparedMonth,
  decisions: Map<PersonId, { decision: Decision; usedModel: boolean }>,
  usage: TokenUsage,
  attempted: ModelAttemptSummary,
  tickPlanner: AgentDecider = authoritativeRulePlanner,
  projectionCadence: 'monthly' | 'annual' = 'monthly',
): SimulationState {
  return executeRemainingPlanningTicks(createMonthExecution({
    observationProjector,
    prepared,
    decisions,
    usage,
    attempted,
    tickPlanner,
    projectionCadence,
  }));
}

export function stepSimulation(
  observationProjector: ObservationProjector,
  input: SimulationState,
  decider: AgentDecider = authoritativeRulePlanner,
): SimulationState {
  const prepared = prepareMonth(input);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) decisions.set(context.person.id, { decision: decider.decide(context), usedModel: false });
  return executePrepared(
    observationProjector,
    prepared,
    decisions,
    { inputTokens: 0, outputTokens: 0 },
    { total: 0, ordinary: 0, exempt: 0 },
    decider,
    'monthly',
  );
}

export function stepOwnedSimulation(
  observationProjector: ObservationProjector,
  input: SimulationState,
): SimulationState {
  const prepared = prepareMonth(input, false, false);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) {
    decisions.set(context.person.id, {
      decision: authoritativeRulePlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 }),
      usedModel: false,
    });
  }
  return executePrepared(
    observationProjector,
    prepared,
    decisions,
    { inputTokens: 0, outputTokens: 0 },
    { total: 0, ordinary: 0, exempt: 0 },
    authoritativeRulePlanner,
    'annual',
  );
}

async function executeSimulationAsync(
  observationProjector: ObservationProjector,
  input: SimulationState,
  batch: BatchDecider,
  cloneInput: boolean,
): Promise<SimulationState> {
  const prepared = prepareMonth(input, cloneInput, true, batch.forceReview);
  const execution = createMonthExecution({ observationProjector, prepared, decisions: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 }, attempted: { total: 0, ordinary: 0, exempt: 0 },
    tickPlanner: batch.ownsVoluntarySocialChoices ? modelOwnedExecutionPlanner : authoritativeRulePlanner,
    projectionCadence: 'monthly' });
  const planning = createModelMonthPlanningState();
  while (execution.completedTick < PLANNING_TICKS_PER_MONTH) await executeModelPlanningTick(execution, planning, batch);
  execution.usage = batch.takeUsage?.() ?? { inputTokens: 0, outputTokens: 0 };
  const metadata = batch.takeMetadata?.() ?? null;
  const result = finishMonthExecution(execution);
  const ledger = result.decisionBudget.ledgers.at(-1);
  if (metadata && ledger?.modelContexts) {
    ledger.modelEndpointId = metadata.endpointId;
    ledger.modelProtocol = metadata.protocol;
    ledger.modelName = metadata.model;
    if (metadata.providerRequests !== undefined) ledger.providerRequests = metadata.providerRequests;
  }
  return result;
}

export function stepSimulationAsync(
  observationProjector: ObservationProjector,
  input: SimulationState,
  batch: BatchDecider,
): Promise<SimulationState> {
  return executeSimulationAsync(observationProjector, input, batch, true);
}

/** Trusted controller path: `input` is already an isolated working copy. */
export function stepOwnedSimulationAsync(
  observationProjector: ObservationProjector,
  input: SimulationState,
  batch: BatchDecider,
): Promise<SimulationState> {
  return executeSimulationAsync(observationProjector, input, batch, false);
}
