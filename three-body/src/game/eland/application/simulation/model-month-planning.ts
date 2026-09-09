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
  WorldEvent,
} from '../../domain/model';
import { isAlive, type PersonId } from '../../domain/person';
import { intentById, personById } from '../../domain/state-index';
import { worldEventById } from '../../domain/event-index';
import { lifePlanningStage } from '../../domain/life-stage';
import { isDehydratedHibernating } from '../../domain/person';
import { RulePlanner } from '../rule-planner';
import { authoredAttemptReturnsToMind, intentReviewAtMonth } from '../../domain/intent';
import {
  decisionBudgetExemption,
  lastModelDecisionMonth,
  validateModelDecision,
  personCanDecide,
} from './model-review';
import {
  applyPlanningDecisions,
  createMonthExecution,
  executePlanningTick,
  type MonthExecution,
  type TickActorController,
  type TickExecutionResult,
} from './month-execution';
import { currentRollingLedgers, type PreparedMonth } from './month-boundary';
import { buildCurrentMonthDecisionContext } from './tick-planner';
import { planPreflightOutcomeKey } from './plan-progress';
import { acknowledgeLanguageSources, acknowledgeSocialActionSources, unreviewedLanguageSources, unreviewedSocialActionSources } from './cognitive-reception';
import { compilationContinuationContexts } from './compilation-continuation';

/** Recover only the previous month's undelivered terminal outcomes. The
 * original Intent and facts are the durable record; the queue itself is local. */
function pendingPlansAtMonthOpening(prepared: PreparedMonth): {
  intentIds: Set<string>;
  latestMindIds: Map<PersonId, string>;
  stoppedOrigins: Set<string>;
} {
  const past = prepared.state.world.past;
  const outcomes = new Map<string, number>();
  const continuations = new Map<string, number>();
  const latestMindIds = new Map<PersonId, string>();
  const stoppedOrigins = new Set<string>();
  let index = past.length - 1;
  for (; index >= 0 && past[index].atMonth >= prepared.atMonth - 1; index -= 1) {
    const event = past[index];
    if (event.kind === 'decision' && event.usedModel && event.decision.mentalAct && !latestMindIds.has(event.who)) {
      latestMindIds.set(event.who, event.id);
    }
    if (event.kind === 'decision' && event.planContinuation) {
      const source = event.planContinuation.sourceIntentId;
      if (source && !continuations.has(source)) continuations.set(source, index);
      if (['stay', 'pause', 'abandon'].includes(event.planContinuation.plan.disposition)) {
        stoppedOrigins.add(event.planContinuation.sourceDecisionEventId);
      }
    }
    const intentId = event.kind === 'action' || event.kind === 'decision' ? event.intentId : undefined;
    if (intentId && !outcomes.has(intentId)) outcomes.set(intentId, index);
  }
  const intentIds = new Set([...outcomes].filter(([id, outcome]) => outcome > (continuations.get(id) ?? -1))
    .map(([id]) => id));
  const unresolvedOwners = new Set([...intentIds].flatMap((id) => {
    const intent = intentById(prepared.state, id);
    return intent?.plan && !latestMindIds.has(intent.ownerId) ? [intent.ownerId] : [];
  }));
  // Usually the latest Mind is in that month. Older frozen goals need one
  // backward lookup at opening, never a full-history scan on each activity tick.
  for (; index >= 0 && unresolvedOwners.size; index -= 1) {
    const event = past[index];
    if (event.kind !== 'decision' || !event.usedModel || !event.decision.mentalAct || !unresolvedOwners.has(event.who)) continue;
    latestMindIds.set(event.who, event.id);
    unresolvedOwners.delete(event.who);
  }
  return { intentIds, latestMindIds, stoppedOrigins };
}

function planContinuationContexts(
  prepared: PreparedMonth,
  priorActiveIntentIds: readonly string[],
  tickEvents: readonly WorldEvent[],
  nextTick: number,
  consumedOutcomes: Set<string>,
  stoppedPlans: ReadonlySet<string>,
  reconsideringPeople: ReadonlySet<PersonId>,
  pendingIntentIds: Set<string>,
  openingMindIds: ReadonlyMap<PersonId, string>,
): DecisionContext[] {
  for (const intentId of [
    ...priorActiveIntentIds,
    ...tickEvents.flatMap((event) => event.kind === 'action' && event.intentId ? [event.intentId] : []),
  ]) pendingIntentIds.add(intentId);
  const contexts: DecisionContext[] = [];
  const includedPeople = new Set<PersonId>();
  for (const intentId of pendingIntentIds) {
    const intent = intentById(prepared.state, intentId);
    if (intent?.operationAuthorship === 'mind') { pendingIntentIds.delete(intentId); continue; }
    if (!intent?.plan) { pendingIntentIds.delete(intentId); continue; }
    const terminal = intent.status === 'completed'
      || intent.status === 'blocked'
      || intent.status === 'failed'
      || (intent.status === 'suspended' && intent.waitingFor === 'world-change');
    if (!terminal || ['stay', 'pause', 'abandon'].includes(intent.plan.disposition)) {
      pendingIntentIds.delete(intentId); continue;
    }
    const originId = intent.planSourceDecisionEventId ?? intent.sourceDecisionEventId;
    if (stoppedPlans.has(originId)) { pendingIntentIds.delete(intentId); continue; }
    const latestMind = [...prepared.events].reverse().find((event) => event.kind === 'decision'
      && event.who === intent.ownerId && event.usedModel && event.decision.mentalAct);
    const latestMindId = latestMind?.id ?? openingMindIds.get(intent.ownerId);
    if (latestMindId && latestMindId !== originId) { pendingIntentIds.delete(intentId); continue; }
    const latestOutcome = intent.outcomeReceipts?.at(-1);
    if (intent.planAssessment?.goal === 'satisfied'
      && (intent.planPreflight || latestOutcome?.execution === 'performed')) {
      pendingIntentIds.delete(intentId); continue;
    }
    // Equivalent attempts under unchanged physical premises supply no new
    // planning event. A changed tool, resource, target or world state does.
    const unchangedOutcome = latestOutcome?.attempt && !latestOutcome.attempt.worldChanged
      && !latestOutcome.planAssessment?.changedConditionIds.length;
    const outcomeKey = planPreflightOutcomeKey(intent) ?? (unchangedOutcome
      ? `${intent.ownerId}:${latestOutcome.attempt!.operationKey}:${latestOutcome.attempt!.premiseKey}`
      : `${intent.id}:${intent.status}:${intent.actionEventIds.at(-1) ?? intent.goalOutcome?.resolvedAtMonth ?? ''}`);
    if (consumedOutcomes.has(outcomeKey)) { pendingIntentIds.delete(intentId); continue; }
    const person = personById(prepared.state, intent.ownerId);
    if (!person || !isAlive(person)) { pendingIntentIds.delete(intentId); continue; }
    // Hearing gets the first Mind turn, but it does not consume the completed
    // work's planning outcome. Keep it queued if that Mind retains the goal.
    if (includedPeople.has(intent.ownerId) || reconsideringPeople.has(intent.ownerId)
      || (person.activeIntentId && person.activeIntentId !== intent.id)) continue;
    const origin = prepared.events.find((event) => event.id === originId)
      ?? worldEventById(prepared.state, originId);
    const mentalAct = origin?.kind === 'decision' && origin.usedModel && origin.who === intent.ownerId
      ? origin.decision.mentalAct
      : undefined;
    if (!mentalAct) { pendingIntentIds.delete(intentId); continue; }
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
    pendingIntentIds.delete(intentId);
    includedPeople.add(person.id);
    contexts.push(context);
  }
  return contexts;
}

const authoritativeRulePlanner = new RulePlanner();

/** Local execution can finish a chosen undertaking; it cannot invent a new
 * decision on behalf of a character whose mind is remote. Pending social
 * requests do not grant permission to accept, reject or reopen an obligation.
 * Physical emergencies are handled by the tick executor's embodied reflexes. */
export const modelOwnedExecutionPlanner: AgentDecider & { decideAt: RulePlanner['decideAt'] } = {
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
      // Reception, including a decision's original wave, is handled separately
      // and remains pending until offered to the listener's own Mind.
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

/** The body process already identifies meaningful harm. Ordinary metabolic
 * drift is not another thought request; a newly present cause or injury is. */
function bodyChangeSources(
  state: SimulationState,
  events: readonly WorldEvent[],
  planning: ModelMonthPlanningState,
  priorConditions: ReadonlyMap<PersonId, ReadonlyMap<string, number>>,
): Map<PersonId, string[]> {
  const sources = new Map<PersonId, Set<string>>();
  const eventIds = new Set(events.map((event) => event.id));
  const add = (personId: unknown, sourceEventId: string) => {
    if (typeof personId !== 'string' || planning.reviewedBodySources.has(`${personId}:${sourceEventId}`)) return;
    const known = sources.get(personId) ?? new Set<string>();
    known.add(sourceEventId); sources.set(personId, known);
  };
  for (const event of events) {
    if (event.kind === 'environment' && event.change === 'body' && event.who) {
      const causes = new Set((Array.isArray(event.diff.bodyCauseCodes) ? event.diff.bodyCauseCodes : [])
        .filter((cause): cause is string => typeof cause === 'string'
          && !['elapsed-metabolism', 'favorable-recovery', 'dehydrated-hibernation'].includes(cause)));
      const previous = planning.bodyCauseStates.get(event.who) ?? new Set<string>();
      if ([...causes].some((cause) => !previous.has(cause))) add(event.who, event.id);
      // Improvement clears the boundary, so a later genuinely renewed need
      // can be perceived without replaying an old warning forever.
      planning.bodyCauseStates.set(event.who, causes);
      if (!('elapsedDays' in event.diff) && Number(event.diff.healthDelta) < 0) add(event.who, event.id);
    }
    if (event.kind === 'action') {
      if (Number(event.diff.damage) > 0) add(event.diff.victimId, event.id);
      if (Number(event.diff.counterDamage) > 0) add(event.who, event.id);
      for (const settlement of Array.isArray(event.diff.supportSettlements) ? event.diff.supportSettlements : []) {
        if (settlement && typeof settlement === 'object' && Number(settlement.healthDamage) > 0) add(settlement.personId, event.id);
      }
      for (const effect of Array.isArray(event.diff.appliedEffects) ? event.diff.appliedEffects : []) {
        if (effect?.kind === 'body' && effect.field === 'health' && Number(effect.delta) < 0) add(effect.personId, event.id);
      }
    }
  }
  for (const person of state.people) {
    const previous = priorConditions.get(person.id);
    for (const condition of person.conditions) {
      if (previous?.has(condition.id) && previous.get(condition.id)! >= condition.stage) continue;
      for (const sourceEventId of condition.sourceEventIds) if (eventIds.has(sourceEventId)) add(person.id, sourceEventId);
    }
  }
  return new Map([...sources].map(([personId, ids]) => [personId, [...ids]]));
}

function directAttemptReviewInputs(prepared: PreparedMonth, consumed: ReadonlySet<string>): Map<PersonId, {
  keys: string[]; sourceEventIds: string[]; technical: boolean;
}> {
  const result = new Map<PersonId, { keys: string[]; sourceEventIds: string[]; technical: boolean }>();
  const add = (personId: PersonId, key: string, sourceEventId: string, technical: boolean) => {
    if (consumed.has(key)) return;
    const entry = result.get(personId) ?? { keys: [], sourceEventIds: [], technical: false };
    entry.keys.push(key); entry.sourceEventIds.push(sourceEventId); entry.technical ||= technical;
    result.set(personId, entry);
  };
  for (const intent of prepared.state.intents) {
    if (!['completed', 'blocked', 'failed'].includes(intent.status)
      || Math.max(intent.lastProgressAtMonth, intent.goalOutcome?.resolvedAtMonth ?? -1,
        intent.lastProcessAttemptAtMonth ?? -1) < prepared.atMonth) continue;
    const origin = prepared.events.find((event) => event.id === intent.sourceDecisionEventId)
      ?? worldEventById(prepared.state, intent.sourceDecisionEventId);
    if (intent.operationAuthorship !== 'mind' && !(origin?.kind === 'decision' && authoredAttemptReturnsToMind(origin.decision))) continue;
    const source = intent.actionEventIds.at(-1) ?? intent.sourceDecisionEventId;
    add(intent.ownerId, `attempt:${intent.id}:${intent.status}:${source}`, source, !intent.actionEventIds.length);
  }
  for (const event of prepared.events) {
    if (event.kind === 'decision' && event.usedModel && event.executionCompilation?.status === 'unresolved'
      && authoredAttemptReturnsToMind(event.decision)) add(event.who, `compilation:${event.id}`, event.id, true);
  }
  return result;
}

export interface ModelPlanningRequest {
  kind: 'mind' | 'plan';
  planningTick: number;
  contexts: DecisionContext[];
}
export type ModelPlanningCycle = Generator<ModelPlanningRequest, TickExecutionResult, (Decision | null)[]>;
export interface ModelMonthPlanningState {
  initialized: boolean;
  reviewedLanguageSources: Map<PersonId, Set<string>>;
  reviewedSocialSources: Map<PersonId, Set<string>>;
  bodyCauseStates: Map<PersonId, Set<string>>;
  reviewedBodySources: Set<string>;
  consumedPlanOutcomes: Set<string>;
  consumedDirectOutcomes: Set<string>;
  stoppedPlans: Set<string>;
  pendingPlanIntentIds: Set<string>;
  openingMindIds: Map<PersonId, string>;
  queuedDecisionEventCount: number;
}
export function createModelMonthPlanningState(): ModelMonthPlanningState {
  return { initialized: false, reviewedLanguageSources: new Map(), reviewedSocialSources: new Map(),
    bodyCauseStates: new Map(), reviewedBodySources: new Set(),
    consumedPlanOutcomes: new Set(), consumedDirectOutcomes: new Set(), stoppedPlans: new Set(),
    pendingPlanIntentIds: new Set(), openingMindIds: new Map(), queuedDecisionEventCount: 0 };
}

function* initializeModelMonth(
  execution: MonthExecution, planning: ModelMonthPlanningState, batch: BatchDecider,
): Generator<ModelPlanningRequest, void, (Decision | null)[]> {
  const prepared = execution.prepared;
  const candidatesForModels = prepared.candidates.filter((context) => context.person.id !== execution.controlledPersonId);
  const living = prepared.contexts.length;
  const rolling = currentRollingLedgers(prepared.state);
  const eligibleCandidates = batch.shouldDecide
    ? candidatesForModels.filter((context) => batch.shouldDecide?.(context, prepared.atMonth))
    : candidatesForModels;
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
  const localReviewDecisions = new Map<PersonId, Decision>(candidatesForModels.map((context) => [
    context.person.id,
    timedFallbackPlanner.decideAt
      ? timedFallbackPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 })
      : fallbackPlanner.decide(context),
  ]));
  const fallbackDecisions = new Map<PersonId, Decision>(candidatesForModels.map((context) => {
    const localDecision = localReviewDecisions.get(context.person.id)!;
    return [context.person.id, preserveExistingExecution(context, localDecision, prepared.atMonth)];
  }));
  const modelPersonIds = new Set(modelContexts.map((context) => context.person.id));
  const fallbackFor = (context: DecisionContext): Decision => fallbackDecisions.get(context.person.id)
    ?? (timedFallbackPlanner.decideAt
      ? timedFallbackPlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 })
      : fallbackPlanner.decide(context));
  for (const context of candidatesForModels.filter((candidate) => !modelPersonIds.has(candidate.person.id))) {
    if (batch.ownsVoluntarySocialChoices) recordModelReviewAvailability(prepared, context, false);
    decisions.set(context.person.id, { decision: fallbackFor(context), usedModel: false });
  }
  let modelDecisions: (Decision | null)[] = [];
  try {
    const response = modelContexts.length ? yield { kind: 'mind', planningTick: 1, contexts: modelContexts } : [];
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
  Object.assign(execution, createMonthExecution({
    observationProjector: execution.observationProjector,
    prepared,
    decisions,
    usage: { inputTokens: 0, outputTokens: 0 },
    attempted: { total: modelContexts.length, ordinary: ordinaryContexts.length, exempt: exemptContexts.length },
    tickPlanner: fallbackPlanner,
    projectionCadence: 'monthly',
    controlledPersonId: execution.controlledPersonId,
  }));
  const carry = batch.continuePlans ? pendingPlansAtMonthOpening(prepared)
    : { intentIds: new Set<string>(), latestMindIds: new Map<PersonId, string>(), stoppedOrigins: new Set<string>() };
  planning.pendingPlanIntentIds = carry.intentIds;
  planning.openingMindIds = carry.latestMindIds;
  planning.stoppedPlans = carry.stoppedOrigins;
  planning.initialized = true;
}

/** Shared scheduling cycle. Provider I/O is driven outside the synchronous
 * generator, so an adopted response can be replayed without another request. */
export function* modelPlanningTick(
  execution: MonthExecution, planning: ModelMonthPlanningState, batch: BatchDecider,
  actorController?: TickActorController,
  releasedPersonId?: PersonId,
): ModelPlanningCycle {
  if (!planning.initialized) yield* initializeModelMonth(execution, planning, batch);
  const prepared = execution.prepared;
  const { reviewedLanguageSources, reviewedSocialSources, consumedPlanOutcomes, consumedDirectOutcomes,
    stoppedPlans, pendingPlanIntentIds } = planning;
  const carry = { latestMindIds: planning.openingMindIds };
  const dispatchPlans = function* (planContexts: DecisionContext[], nextTick: number): Generator<ModelPlanningRequest, void, (Decision | null)[]> {
    if (!planContexts.length || !batch.continuePlans) return;
    execution.attempted.total += planContexts.length;
    execution.attempted.exempt += planContexts.length;
    let translations: (Decision | null)[] = [];
    try {
      const response = yield { kind: 'plan', planningTick: nextTick, contexts: planContexts };
      translations = Array.isArray(response) ? response : [];
    } catch {
      // The outcome was offered once; a failed translator invents no choice.
    }
    const acceptedPlans = planContexts.flatMap((context, index) => {
      const proposed = translations[index];
      const plan = proposed?.mentalAct?.plan;
      const originId = context.continuingPlan!.sourceDecisionEventId;
      const stopsPlan = Boolean(plan && ['stay', 'pause', 'abandon'].includes(plan.disposition));
      let decision: Decision | null = null;
      try { decision = proposed ? validateModelDecision(context, proposed) : null; } catch { /* Invalid translation is not consent. */ }
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
  };
  if (releasedPersonId && execution.completedTick > 0) {
    const person = personById(prepared.state, releasedPersonId);
    if (person && isAlive(person) && !isDehydratedHibernating(person)
      && lifePlanningStage(person, prepared.atMonth) !== 'dependent-child') {
      const nextTick = execution.completedTick + 1;
      const context = buildCurrentMonthDecisionContext(prepared.state, person, prepared.atMonth, nextTick, prepared.events);
      execution.attempted.total++; execution.attempted.exempt++;
      let proposed: (Decision | null)[] = [];
      try { proposed = yield { kind: 'mind', planningTick: nextTick, contexts: [context] }; } catch { /* Retain work if unavailable. */ }
      let accepted: Decision | null = null;
      try { accepted = proposed[0] ? validateModelDecision(context, proposed[0]) : null; } catch { /* Invalid is not a new choice. */ }
      applyPlanningDecisions(execution, [{ context, decision: accepted ?? modelOwnedExecutionPlanner.decide(context), usedModel: Boolean(accepted) }], nextTick);
    }
  }
  // Declaration actions commit between body ticks. Their completed speech
  // intents therefore never appear in the next tick's active-intent list.
  if (batch.continuePlans) {
    for (const event of prepared.events.slice(planning.queuedDecisionEventCount)) {
      if (event.kind === 'action' && event.cause === 'decision-language' && event.intentId) {
        pendingPlanIntentIds.add(event.intentId);
      }
    }
  }
  planning.queuedDecisionEventCount = prepared.events.length;
  const priorActiveIntentIds = batch.continuePlans
    ? prepared.state.people.flatMap((person) => person.activeIntentId ? [person.activeIntentId] : [])
    : [];
  const priorConditions = new Map(prepared.state.people.map((person) => [person.id,
    new Map(person.conditions.map((condition) => [condition.id, condition.stage]))]));
  const tick = executePlanningTick(execution, actorController);
  if (tick.actionTick >= PLANNING_TICKS_PER_MONTH
    || !batch.ownsVoluntarySocialChoices) return tick;
  const nextTick = tick.actionTick + 1;
  const heardSources = unreviewedLanguageSources(prepared.events, reviewedLanguageSources);
  const socialSources = unreviewedSocialActionSources(prepared.state, prepared.events, reviewedSocialSources);
  const directReviews = directAttemptReviewInputs(prepared, consumedDirectOutcomes);
  const bodySources = bodyChangeSources(prepared.state, tick.events, planning, priorConditions);
  const reconsideringPeople = new Set([...heardSources.keys(), ...socialSources.keys(), ...directReviews.keys(), ...bodySources.keys()]);
  if (execution.controlledPersonId) reconsideringPeople.add(execution.controlledPersonId);
  const planContexts = batch.continuePlans
    ? planContinuationContexts(prepared, priorActiveIntentIds, tick.events, nextTick, consumedPlanOutcomes, stoppedPlans, reconsideringPeople, pendingPlanIntentIds, carry.latestMindIds)
    : [];
  if (batch.continuePlans) planContexts.push(...compilationContinuationContexts(
    prepared, nextTick, consumedPlanOutcomes, stoppedPlans,
    new Set([...reconsideringPeople, ...planContexts.map((context) => context.person.id)]),
  ));
  const planPeople = new Set(planContexts.map((context) => context.person.id));
  yield* dispatchPlans(planContexts, nextTick);
  const triggeredContexts = [...new Set([
    ...reconsideringPeople,
    ...cognitiveTriggerPersonIds(prepared.state, tick.events),
  ])]
    .filter((personId) => personId !== execution.controlledPersonId && !planPeople.has(personId))
    .flatMap((personId) => {
      const person = personById(prepared.state, personId);
      if (!person || !isAlive(person) || isDehydratedHibernating(person)) return [];
      const context = buildCurrentMonthDecisionContext(
        prepared.state,
        person,
        prepared.atMonth,
        nextTick,
        prepared.events,
      );
      if (!personCanDecide(prepared.state, context, prepared.atMonth)) return [];
      const sourceEventIds = [...new Set([...(heardSources.get(personId) ?? []), ...(socialSources.get(personId) ?? []),
        ...(bodySources.get(personId) ?? []),
        ...(directReviews.get(personId)?.sourceEventIds ?? []),
        ...tick.events.flatMap((event) => (
        event.kind === 'action' && event.who === personId ? [event.id] : []
      ))])];
      context.reconsideration = {
        reason: socialSources.has(personId) || bodySources.has(personId) ? 'experienced-outcome' : heardSources.has(personId) ? 'heard-language'
          : directReviews.get(personId)?.technical ? 'compilation-feedback' : 'experienced-outcome', sourceEventIds,
      };
      return [context];
    });
  if (!triggeredContexts.length) return tick;
  triggeredContexts.forEach((context) => {
    // An unavailable model does not make the same reception a fresh event
    // on every activity tick. Its source remains in personal memory.
    acknowledgeLanguageSources(reviewedLanguageSources, context.person.id, heardSources.get(context.person.id) ?? []);
    acknowledgeSocialActionSources(reviewedSocialSources, context.person.id, socialSources.get(context.person.id) ?? []);
    for (const sourceId of bodySources.get(context.person.id) ?? []) planning.reviewedBodySources.add(`${context.person.id}:${sourceId}`);
    for (const key of directReviews.get(context.person.id)?.keys ?? []) consumedDirectOutcomes.add(key);
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
    const response = yield { kind: 'mind', planningTick: nextTick, contexts: triggeredContexts };
    proposed = Array.isArray(response) ? response : [];
  } catch {
    triggeredContexts.forEach((context) => recordModelReviewAvailability(prepared, context, false));
    applyPlanningDecisions(execution, triggeredContexts.map((context, index) => ({
      context,
      decision: localDecisions[index],
      usedModel: false,
    })), nextTick);
    return tick;
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
  const keepingPeople = new Set(accepted.filter(({ decision, usedModel }) => usedModel
    && decision.kind === 'idle' && decision.attention === 'keep-current').map(({ context }) => context.person.id));
  if (batch.continuePlans && keepingPeople.size) {
    const excluded = new Set(prepared.state.people.filter((person) => !keepingPeople.has(person.id)).map((person) => person.id));
    // New speech may continue every tick. Once this Mind explicitly keeps
    // its undertaking, deliver the saved work outcome now; later speech is
    // still queued for its next independent reception turn.
    yield* dispatchPlans(planContinuationContexts(prepared, [], [], nextTick,
      consumedPlanOutcomes, stoppedPlans, excluded, pendingPlanIntentIds, carry.latestMindIds), nextTick);
  }
  return tick;
}

export async function executeModelPlanningTick(
  execution: MonthExecution, planning: ModelMonthPlanningState, batch: BatchDecider,
  actorController?: TickActorController, releasedPersonId?: PersonId,
): Promise<TickExecutionResult> {
  const cycle = modelPlanningTick(execution, planning, batch, actorController, releasedPersonId);
  let next = cycle.next();
  while (!next.done) {
    const request = next.value;
    try {
      const decisions = request.kind === 'plan'
        ? await batch.continuePlans!(request.contexts) : await batch.decideAll(request.contexts);
      next = cycle.next(Array.isArray(decisions) ? decisions : []);
    } catch (error) { next = cycle.throw(error); }
  }
  return next.value;
}
