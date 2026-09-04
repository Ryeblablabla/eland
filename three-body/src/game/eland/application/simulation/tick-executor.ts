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
import { languageInterpreterIds } from '../../domain/language-perception';
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
// A live model owns open-ended social choices, but it never owns the ability
// to act.  This planner keeps required replies, accepted commitments and
// grounded physical work available without inventing optional social speech.
const modelOwnedFallbackPlanner = new RulePlanner({
  deferVoluntarySocialChoicesToModel: true,
});
const MAX_MODEL_MENTAL_ACTS_PER_PERSON_MONTH = 2;

/**
 * A missing model review cannot silently replace work the person already
 * chose. Immediate danger, a required reply and an accepted obligation remain
 * authoritative local interruptions; every other fallback simply lets the
 * current Intent execute below without persisting an idle DecisionFact.
 */
function preserveExistingExecution(
  context: DecisionContext,
  localDecision: Decision,
  atMonth: number,
): Decision {
  if (!context.activeIntent || localDecision.kind === 'idle') return localDecision;
  const exemption = decisionBudgetExemption(context, atMonth);
  if (exemption === 'emergency'
    || exemption === 'required-response'
    || exemption === 'fulfillment') return localDecision;
  return {
    kind: 'idle',
    reason: `继续已有安排：${context.activeIntent.summary}`,
  };
}

function cognitiveTriggerPersonIds(events: readonly WorldEvent[]): Set<PersonId> {
  const people = new Set<PersonId>();
  const speakers = new Set(events.flatMap((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'talk'
    ? [event.who]
    : []));
  for (const event of events) {
    if (event.kind !== 'action') continue;
    if (event.action.kind === 'act'
      && event.action.operation === 'hunt'
      && event.diff.killed === true) {
      people.add(event.who);
      if (Array.isArray(event.diff.witnessedBy)) {
        event.diff.witnessedBy.forEach((personId) => {
          if (typeof personId === 'string') people.add(personId);
        });
      }
    }
    if (event.action.kind === 'talk' && event.status === 'completed') {
      languageInterpreterIds(event.diff, event.action.speakerMeaning.id).forEach((personId) => people.add(personId));
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
    Math.floor(availableModelTokens(rolling, living, prepared.state.decisionBudget.tokensPerContext)
      / prepared.state.decisionBudget.tokensPerContext),
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
    ? modelOwnedFallbackPlanner
    : authoritativeRulePlanner;
  const timedFallbackPlanner = fallbackPlanner as AgentDecider & { decideAt?: RulePlanner['decideAt'] };
  // Freeze the local month-opening choice before the remote request. Model
  // capacity may replace one of these choices, but cannot decide whether the
  // person gets a planning turn at all. A failed/partial/invalid response then
  // remains an infrastructure detail and never becomes an authored idle fact.
  const localReviewDecisions = new Map<PersonId, Decision>(prepared.candidates.map((context) => [
    context.person.id,
    timedFallbackPlanner.decideAt
      ? timedFallbackPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 })
      : fallbackPlanner.decide(context),
  ]));
  const fallbackDecisions = new Map<PersonId, Decision>(prepared.candidates.map((context) => {
    const localDecision = localReviewDecisions.get(context.person.id)!;
    return [context.person.id, preserveExistingExecution(context, localDecision, prepared.atMonth)];
  }));
  const modelPersonIds = new Set(modelContexts.map((context) => context.person.id));
  const fallbackFor = (context: DecisionContext): Decision => fallbackDecisions.get(context.person.id)
    ?? (timedFallbackPlanner.decideAt
      ? timedFallbackPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 })
      : fallbackPlanner.decide(context));
  for (const context of prepared.candidates.filter((candidate) => !modelPersonIds.has(candidate.person.id))) {
    decisions.set(context.person.id, { decision: fallbackFor(context), usedModel: false });
  }
  let modelDecisions: (Decision | null)[] = [];
  try {
    const response = modelContexts.length ? await batch.decideAll(modelContexts) : [];
    modelDecisions = Array.isArray(response) ? response : [];
  } catch {
    // Keep the already computed local choices. Network failure is not a
    // character decision and therefore creates no model-authored idle fact.
    modelDecisions = [];
  }
  modelContexts.forEach((context, index) => {
    const proposed = modelDecisions[index];
    const localDecision = fallbackFor(context);
    const localReviewDecision = localReviewDecisions.get(context.person.id) ?? localDecision;
    let decision: Decision | null = null;
    try {
      decision = proposed ? validateModelDecision(context, proposed, localReviewDecision) : null;
    } catch {
      // Runtime-invalid adapter output follows the same local path as null.
    }
    decisions.set(context.person.id, decision
      ? { decision, usedModel: true }
      : { decision: localDecision, usedModel: false });
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
    const triggeredContexts = [...cognitiveTriggerPersonIds(tick.events)]
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
    const localReviewDecisions = triggeredContexts.map((context) => (
      modelOwnedFallbackPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: nextTick })
    ));
    const localDecisions = triggeredContexts.map((context, index) => (
      preserveExistingExecution(context, localReviewDecisions[index], prepared.atMonth)
    ));
    let proposed: (Decision | null)[] = [];
    try {
      const response = await batch.decideAll(triggeredContexts);
      proposed = Array.isArray(response) ? response : [];
    } catch {
      applyPlanningDecisions(execution, triggeredContexts.map((context, index) => ({
        context,
        decision: localDecisions[index],
        usedModel: false,
      })), nextTick);
      continue;
    }
    const accepted = triggeredContexts.map((context, index) => {
      let decision: Decision | null = null;
      try {
        decision = proposed[index]
          ? validateModelDecision(context, proposed[index]!, localReviewDecisions[index])
          : null;
      } catch {
        // Invalid model output is replaced by the precomputed local decision.
      }
      return decision
        ? { context, decision, usedModel: true }
        : { context, decision: localDecisions[index], usedModel: false };
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
