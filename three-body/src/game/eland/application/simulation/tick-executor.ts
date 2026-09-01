import {
  availableModelContexts,
  availableModelTokens,
  ORDINARY_DECISION_PERSON_MONTHS,
} from '../../domain/decision-budget';
import { PLANNING_TICKS_PER_MONTH } from '../../domain/calendar';
import type {
  AgentDecider,
  BatchDecider,
  Decision,
  DecisionContext,
  SimulationState,
  TokenUsage,
  WorldEvent,
} from '../../domain/model';
import { isAlive, type PersonId } from '../../domain/person';
import { personById } from '../../domain/state-index';
import { isProductionOption, RulePlanner } from '../rule-planner';
import {
  decisionBudgetExemption,
  decisionUrgency,
  hasUnfinishedProductionIntent,
  lastModelDecisionMonth,
  validateModelDecision,
} from './model-review';
import {
  applyPlanningDecisions,
  createMonthExecution,
  executePlanningTick,
  executeRemainingPlanningTicks,
  finishMonthExecution,
  type ModelAttemptSummary,
} from './month-execution';
import { currentRollingLedgers, prepareMonth, type PreparedMonth } from './month-boundary';
import type { ObservationProjector } from './observation-projector';
import { buildCurrentMonthDecisionContext } from './tick-planner';

const authoritativeRulePlanner = new RulePlanner();
const modelOwnedSocialFallbackPlanner = new RulePlanner({
  deferVoluntarySocialChoicesToModel: true,
});
const MAX_MODEL_MENTAL_ACTS_PER_PERSON_MONTH = 2;

function cognitiveTriggerPersonIds(state: SimulationState, events: readonly WorldEvent[]): Set<PersonId> {
  const people = new Set<PersonId>();
  const speakers = new Set(events.flatMap((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'talk'
    ? [event.who]
    : []));
  for (const event of events) {
    if (event.kind !== 'action') continue;
    if (event.action.kind === 'talk' && event.status === 'completed') {
      ((event.diff.understoodByPersonIds as string[] | undefined) ?? []).forEach((personId) => people.add(personId));
      continue;
    }
    if (event.status === 'blocked' || event.status === 'failed') {
      if (!speakers.has(event.who)) people.add(event.who);
      continue;
    }
    if (event.action.kind === 'attend' && event.status === 'completed') {
      if (!speakers.has(event.who)) people.add(event.who);
      continue;
    }
    if (event.action.kind === 'act'
      && ['combine', 'exert', 'expose'].includes(event.action.operation)) {
      if (!speakers.has(event.who)) people.add(event.who);
      continue;
    }
    if (event.status === 'completed'
      && !speakers.has(event.who)
      && !personById(state, event.who)?.activeIntentId) people.add(event.who);
  }
  return people;
}

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
  const modelPersonIds = new Set(modelContexts.map((context) => context.person.id));
  const fallbackFor = (context: DecisionContext): Decision => (
    prepared.naturallyTriggeredPeople.has(context.person.id)
      ? fallbackPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 })
      : { kind: 'idle', reason: '对话中定下的下一步没有通过当前本地条件复核' }
  );
  for (const context of prepared.candidates.filter((candidate) => !modelPersonIds.has(candidate.person.id))) {
    decisions.set(context.person.id, { decision: fallbackFor(context), usedModel: false });
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
    const decision = proposed ? validateModelDecision(context, proposed) : null;
    decisions.set(context.person.id, decision
      ? { decision, usedModel: true }
      : { decision: fallbackFor(context), usedModel: false });
  });
  const execution = createMonthExecution({
    observationProjector,
    prepared,
    decisions,
    usage: { inputTokens: 0, outputTokens: 0 },
    attempted: { total: modelContexts.length, ordinary: ordinaryContexts.length, exempt: exemptContexts.length },
    tickPlanner: fallbackPlanner,
    projectionCadence: 'monthly',
  });
  const modelTurns = new Map<PersonId, number>(modelContexts.map((context) => [context.person.id, 1]));
  while (execution.completedTick < PLANNING_TICKS_PER_MONTH) {
    const tick = executePlanningTick(execution);
    if (tick.actionTick >= PLANNING_TICKS_PER_MONTH
      || !batch.ownsVoluntarySocialChoices) continue;
    const nextTick = tick.actionTick + 1;
    const triggeredContexts = [...cognitiveTriggerPersonIds(prepared.state, tick.events)]
      .filter((personId) => (modelTurns.get(personId) ?? 0) < MAX_MODEL_MENTAL_ACTS_PER_PERSON_MONTH)
      .flatMap((personId) => {
        const person = personById(prepared.state, personId);
        if (!person || !isAlive(person)) return [];
        const context = buildCurrentMonthDecisionContext(
          prepared.state,
          person,
          prepared.atMonth,
          nextTick,
          prepared.events,
        );
        return context.options.length ? [context] : [];
      });
    if (!triggeredContexts.length) continue;
    triggeredContexts.forEach((context) => {
      modelTurns.set(context.person.id, (modelTurns.get(context.person.id) ?? 0) + 1);
    });
    execution.attempted.total += triggeredContexts.length;
    execution.attempted.exempt += triggeredContexts.length;
    let proposed: (Decision | null)[] = [];
    try {
      proposed = await batch.decideAll(triggeredContexts);
    } catch {
      continue;
    }
    const accepted = triggeredContexts.flatMap((context, index) => {
      const decision = proposed[index]
        ? validateModelDecision(context, proposed[index]!)
        : null;
      return decision ? [{ context, decision, usedModel: true }] : [];
    });
    applyPlanningDecisions(execution, accepted, nextTick);
  }
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
