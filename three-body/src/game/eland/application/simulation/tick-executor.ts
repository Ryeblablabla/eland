import {
  availableModelContexts,
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
import { intentById, personById } from '../../domain/state-index';
import { worldEventById } from '../../domain/event-index';
import { languageInterpreterIds } from '../../domain/language-perception';
import { RulePlanner } from '../rule-planner';
import { intentReviewAtMonth } from '../../domain/intent';
import {
  decisionBudgetExemption,
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
import { planPreflightOutcomeKey } from './plan-progress';

function planContinuationContexts(
  prepared: PreparedMonth,
  priorActiveIntentIds: readonly string[],
  tickEvents: readonly WorldEvent[],
  nextTick: number,
  consumedOutcomes: Set<string>,
  stoppedPlans: ReadonlySet<string>,
): DecisionContext[] {
  const candidateIds = new Set([
    ...priorActiveIntentIds,
    ...tickEvents.flatMap((event) => event.kind === 'action' && event.intentId ? [event.intentId] : []),
  ]);
  const contexts: DecisionContext[] = [];
  const includedPeople = new Set<PersonId>();
  for (const intentId of candidateIds) {
    const intent = intentById(prepared.state, intentId);
    if (!intent?.plan || includedPeople.has(intent.ownerId)) continue;
    const terminal = intent.status === 'completed'
      || intent.status === 'blocked'
      || intent.status === 'failed'
      || (intent.status === 'suspended' && intent.waitingFor === 'world-change');
    if (!terminal || ['stay', 'pause', 'abandon'].includes(intent.plan.disposition)) continue;
    const originId = intent.planSourceDecisionEventId ?? intent.sourceDecisionEventId;
    if (stoppedPlans.has(originId)) continue;
    const latestOutcome = intent.outcomeReceipts?.at(-1);
    if (intent.planAssessment?.goal === 'satisfied'
      && (intent.planPreflight || latestOutcome?.execution === 'performed')) continue;
    // Equivalent attempts under unchanged physical premises supply no new
    // planning event. A changed tool, resource, target or world state does.
    const unchangedOutcome = latestOutcome?.attempt && !latestOutcome.attempt.worldChanged
      && !latestOutcome.planAssessment?.changedConditionIds.length;
    const outcomeKey = planPreflightOutcomeKey(intent) ?? (unchangedOutcome
      ? `${intent.ownerId}:${latestOutcome.attempt!.operationKey}:${latestOutcome.attempt!.premiseKey}`
      : `${intent.id}:${intent.status}:${intent.actionEventIds.at(-1) ?? intent.goalOutcome?.resolvedAtMonth ?? ''}`);
    if (consumedOutcomes.has(outcomeKey)) continue;
    const person = personById(prepared.state, intent.ownerId);
    if (!person || !isAlive(person) || (person.activeIntentId && person.activeIntentId !== intent.id)) continue;
    const origin = prepared.events.find((event) => event.id === originId)
      ?? worldEventById(prepared.state, originId);
    const mentalAct = origin?.kind === 'decision' && origin.usedModel && origin.who === intent.ownerId
      ? origin.decision.mentalAct
      : undefined;
    if (!mentalAct) continue;
    const context = buildCurrentMonthDecisionContext(
      prepared.state, person, prepared.atMonth, nextTick, prepared.events,
    );
    context.continuingPlan = {
      sourceIntentId: intent.id,
      sourceDecisionEventId: originId,
      mentalAct: structuredClone(mentalAct),
      // Natural-language steps need not map one-to-one to primitive actions.
      // Plan must reconcile the actual receipts, not have its steps deleted
      // according to an engine guess about sentence granularity.
      plan: structuredClone(intent.plan),
      outcomeReceipts: structuredClone(intent.outcomeReceipts ?? []),
      ...(intent.planAssessment ? { completionAssessment: structuredClone(intent.planAssessment) } : {}),
      ...(intent.planMilestones?.length ? { milestones: structuredClone(intent.planMilestones) } : {}),
      ...(intent.planPreflight ? { preflightReceipt: structuredClone(intent.planPreflight) } : {}),
    };
    consumedOutcomes.add(outcomeKey);
    includedPeople.add(person.id);
    contexts.push(context);
  }
  return contexts;
}

const authoritativeRulePlanner = new RulePlanner();
const MAX_MODEL_MENTAL_ACTS_PER_PERSON_MONTH = 2;

/** Local execution can finish a chosen undertaking; it cannot invent a new
 * decision on behalf of a character whose mind is remote. Pending social
 * requests do not grant permission to accept, reject or reopen an obligation.
 * Physical emergencies are handled by the tick executor's embodied reflexes. */
const modelOwnedExecutionPlanner: AgentDecider & { decideAt: RulePlanner['decideAt'] } = {
  defersVoluntarySocialChoicesToModel: true,
  decide(context) {
    return this.decideAt(context, {
      atMonth: context.decisionMonth ?? context.state.clock.elapsedMonths + 1,
      planningTick: context.planningTick ?? 1,
    });
  },
  decideAt(context) {
    return {
      kind: 'idle',
      reason: context.activeIntent
        ? `继续已有安排：${context.activeIntent.summary}`
        : '当前行动已经结束，尚未形成下一项安排',
    };
  },
};

function recordModelReviewAvailability(
  prepared: PreparedMonth,
  context: DecisionContext,
  available: boolean,
): void {
  const opportunity = prepared.events.find((event) => event.kind === 'decision-opportunity'
    && event.who === context.person.id);
  if (!opportunity || opportunity.kind !== 'decision-opportunity') return;
  const reason = '模型复核尚未返回有效决定；只执行既定行动，不代替本人形成新选择';
  if (available) {
    if (opportunity.reasons.includes(reason)) {
      opportunity.reasons = opportunity.reasons.filter((candidate) => candidate !== reason);
      opportunity.result = `${context.person.name}的模型复核已返回有效决定`;
    }
    return;
  }
  if (!opportunity.reasons.includes(reason)) opportunity.reasons.push(reason);
  opportunity.result = `${context.person.name}的模型复核待返回，已有行动仍可执行`;
}

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
  const reviewAtMonth = intentReviewAtMonth(context.activeIntent);
  if ((reviewAtMonth !== undefined && atMonth > reviewAtMonth)
    || atMonth - context.activeIntent.lastProgressAtMonth >= 2) return localDecision;
  return {
    kind: 'idle',
    reason: `继续已有安排：${context.activeIntent.summary}`,
  };
}

function cognitiveTriggerPersonIds(state: SimulationState, events: readonly WorldEvent[]): Set<PersonId> {
  const people = new Set<PersonId>();
  const speakers = new Set(events.flatMap((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'talk'
    ? [event.who]
    : []));
  for (const event of events) {
    if (event.kind !== 'action') continue;
    const intent = event.intentId ? state.intents.find((candidate) => candidate.id === event.intentId) : undefined;
    const receipt = intent?.outcomeReceipts?.at(-1);
    if (receipt?.attempt?.repetition === 'unchanged-retry'
      && !receipt.attempt.worldChanged && receipt.evidence === 'none'
      && !receipt.planAssessment?.changedConditionIds.length) continue;
    if (intent?.status === 'completed' && (intent.plan?.steps.length ?? 0) > 1) {
      people.add(event.who);
    }
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
    if (event.action.kind === 'attend' && event.status === 'completed'
      && intent?.outcomeReceipts?.at(-1)?.evidence !== 'none') {
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
  );
  // Token usage remains audited, but a guessed token cost must not silently
  // erase somebody's monthly mind turn when Mind + Plan cost more than the
  // estimate. Context capacity already bounds the number of remote turns.
  // Remote capacity is infrastructure. Give the longest-unreviewed person
  // their turn without rewarding construction or suppressing social aims.
  const rank = (contexts: DecisionContext[]) => [...contexts]
    .sort((a, b) => (
      (lastModelDecisionMonth(prepared.state, a.person.id) ?? -1)
      - (lastModelDecisionMonth(prepared.state, b.person.id) ?? -1)
      || a.person.id.localeCompare(b.person.id)
    ));
  const ordinaryContexts = rank(ordinaryCandidates).slice(0, ordinaryCapacity);
  const modelContexts = rank([...exemptContexts, ...ordinaryContexts]);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  const fallbackPlanner = batch.ownsVoluntarySocialChoices
    ? modelOwnedExecutionPlanner
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
    if (batch.ownsVoluntarySocialChoices) recordModelReviewAvailability(prepared, context, false);
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
    if (batch.ownsVoluntarySocialChoices) recordModelReviewAvailability(prepared, context, Boolean(decision));
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
  const consumedPlanOutcomes = new Set<string>();
  const stoppedPlans = new Set<string>();
  while (execution.completedTick < PLANNING_TICKS_PER_MONTH) {
    const priorActiveIntentIds = batch.continuePlans
      ? prepared.state.people.flatMap((person) => person.activeIntentId ? [person.activeIntentId] : [])
      : [];
    const tick = executePlanningTick(execution);
    if (tick.actionTick >= PLANNING_TICKS_PER_MONTH
      || !batch.ownsVoluntarySocialChoices) continue;
    const nextTick = tick.actionTick + 1;
    const planContexts = batch.continuePlans
      ? planContinuationContexts(prepared, priorActiveIntentIds, tick.events, nextTick, consumedPlanOutcomes, stoppedPlans)
      : [];
    const planPeople = new Set(planContexts.map((context) => context.person.id));
    if (planContexts.length && batch.continuePlans) {
      execution.attempted.total += planContexts.length;
      execution.attempted.exempt += planContexts.length;
      let translations: (Decision | null)[] = [];
      try {
        const response = await batch.continuePlans(planContexts);
        translations = Array.isArray(response) ? response : [];
      } catch {
        // A failed translator leaves the existing intention intact. It never
        // turns into a fresh Mind decision or invented local social response.
      }
      const acceptedPlans = planContexts.flatMap((context, index) => {
        const proposed = translations[index];
        const plan = proposed?.mentalAct?.plan;
        const originId = context.continuingPlan!.sourceDecisionEventId;
        const stopsPlan = Boolean(plan && ['stay', 'pause', 'abandon'].includes(plan.disposition));
        let decision: Decision | null = null;
        try {
          decision = proposed ? validateModelDecision(context, proposed) : null;
        } catch {
          // Invalid translation is infrastructure feedback, not consent.
        }
        recordModelReviewAvailability(prepared, context, Boolean(decision));
        if (!decision) return [];
        if (stopsPlan) {
          stoppedPlans.add(originId);
          decision = { kind: 'idle', reason: decision.reason,
            ...(decision.mentalAct ? { mentalAct: decision.mentalAct } : {}) };
        }
        return [{ context, decision, usedModel: true }];
      });
      applyPlanningDecisions(execution, acceptedPlans, nextTick);
    }
    const triggeredContexts = [...cognitiveTriggerPersonIds(prepared.state, tick.events)]
      .filter((personId) => !planPeople.has(personId))
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
      modelOwnedExecutionPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: nextTick })
    ));
    const localDecisions = triggeredContexts.map((context, index) => (
      preserveExistingExecution(context, localReviewDecisions[index], prepared.atMonth)
    ));
    let proposed: (Decision | null)[] = [];
    try {
      const response = await batch.decideAll(triggeredContexts);
      proposed = Array.isArray(response) ? response : [];
    } catch {
      triggeredContexts.forEach((context) => recordModelReviewAvailability(prepared, context, false));
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
      recordModelReviewAvailability(prepared, context, Boolean(decision));
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
