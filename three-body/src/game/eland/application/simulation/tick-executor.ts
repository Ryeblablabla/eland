import {
  availableModelContexts,
  availableModelTokens,
  ORDINARY_DECISION_PERSON_MONTHS,
} from '../../domain/decision-budget';
import type {
  AgentDecider,
  BatchDecider,
  Decision,
  DecisionContext,
  SimulationState,
  TokenUsage,
} from '../../domain/model';
import type { PersonId } from '../../domain/person';
import { isProductionOption, RulePlanner } from '../rule-planner';
import {
  decisionBudgetExemption,
  decisionUrgency,
  hasUnfinishedProductionIntent,
  lastModelDecisionMonth,
  validateModelDecision,
} from './model-review';
import {
  createMonthExecution,
  executeRemainingPlanningTicks,
  type ModelAttemptSummary,
} from './month-execution';
import { currentRollingLedgers, prepareMonth, type PreparedMonth } from './month-boundary';
import type { ObservationProjector } from './observation-projector';

const authoritativeRulePlanner = new RulePlanner();
const modelOwnedSocialFallbackPlanner = new RulePlanner({
  deferVoluntarySocialChoicesToModel: true,
});

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
  const living = prepared.contexts.length;
  const rolling = currentRollingLedgers(prepared.state);
  const eligibleCandidates = batch.shouldDecide
    ? prepared.candidates.filter((context) => batch.shouldDecide?.(context, prepared.atMonth))
    : prepared.candidates;
  const isExempt = (context: DecisionContext) => {
    const exemption = decisionBudgetExemption(context, prepared.atMonth);
    // Bootstrap still guarantees a first local plan, but it is not an
    // unbounded remote-call exemption: founders compete for ordinary monthly
    // model capacity like everyone else.
    return (exemption !== null && exemption !== 'bootstrap')
      || Boolean(batch.isBudgetExempt?.(context, prepared.atMonth));
  };
  const exemptContexts = eligibleCandidates.filter(isExempt);
  const ordinaryCandidates = eligibleCandidates.filter((context) => !isExempt(context));
  const ordinaryCapacity = Math.min(
    ordinaryCandidates.length,
    Math.floor(prepared.state.decisionBudget.credits + living / ORDINARY_DECISION_PERSON_MONTHS),
    availableModelContexts(rolling, living),
    Math.floor(availableModelTokens(rolling, living, prepared.state.decisionBudget.tokensPerContext) / prepared.state.decisionBudget.tokensPerContext),
  );
  const importance = (context: DecisionContext) => {
    const exemption = decisionBudgetExemption(context, prepared.atMonth);
    const interactionReview = Boolean(batch.forceReview?.(context, prepared.atMonth));
    let score = interactionReview
      ? 2_800
      : exemption === 'bootstrap'
      ? 3_000
      : exemption === 'emergency'
        ? 2_900
        : exemption === 'required-response'
          ? 2_700
      : exemption === 'fulfillment'
            ? 2_500
            : exemption === 'agenda-revision'
              ? 2_400
            : !context.activeIntent
              ? 1_800 + (context.options.some(isProductionOption) ? 240 : 0)
              : hasUnfinishedProductionIntent(context)
                ? 1_700
                : context.activeIntent.domain === 'strategic'
                  ? 900
                  : 350;
    const lastDecisionMonth = lastModelDecisionMonth(prepared.state, context.person.id);
    if (lastDecisionMonth !== null && exemption === null) {
      const monthsSince = prepared.atMonth - lastDecisionMonth;
      score -= Math.max(0, 6 - monthsSince) * 60;
    }
    return score;
  };
  const rank = (contexts: DecisionContext[]) => [...contexts]
    .sort((a, b) => importance(b) - importance(a) || decisionUrgency(b) - decisionUrgency(a) || a.person.id.localeCompare(b.person.id));
  const ordinaryContexts = rank(ordinaryCandidates).slice(0, ordinaryCapacity);
  const modelContexts = rank([...exemptContexts, ...ordinaryContexts]);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  const fallbackPlanner = batch.ownsVoluntarySocialChoices
    ? modelOwnedSocialFallbackPlanner
    : authoritativeRulePlanner;
  for (const context of prepared.candidates) {
    const naturalFallback = prepared.naturallyTriggeredPeople.has(context.person.id);
    decisions.set(context.person.id, {
      decision: naturalFallback
        ? fallbackPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 })
        : { kind: 'idle', reason: '对话中定下的下一步没有通过当前本地条件复核' },
      usedModel: false,
    });
  }
  let modelDecisions: (Decision | null)[] = [];
  try {
    modelDecisions = modelContexts.length ? await batch.decideAll(modelContexts) : [];
  } catch {
    // The transitional foreground model path may fail, but the authoritative
    // rule plan above still commits the month.
    modelDecisions = [];
  }
  modelContexts.forEach((context, index) => {
    const proposed = modelDecisions[index];
    const localDecision = decisions.get(context.person.id)?.decision;
    const decision = proposed && localDecision ? validateModelDecision(context, proposed, localDecision) : null;
    if (decision) decisions.set(context.person.id, { decision, usedModel: true });
  });
  const metadata = batch.takeMetadata?.() ?? null;
  const result = executePrepared(
    observationProjector,
    prepared,
    decisions,
    batch.takeUsage?.() ?? { inputTokens: 0, outputTokens: 0 },
    { total: modelContexts.length, ordinary: ordinaryContexts.length, exempt: exemptContexts.length },
    fallbackPlanner,
    'monthly',
  );
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
