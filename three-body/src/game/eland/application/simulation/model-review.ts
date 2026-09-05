import { goalSatisfied } from '../../domain/action-executor';
import { composeIntentChoice, isResumableIntent } from '../../domain/intent';
import type {
  Decision,
  DecisionContext,
  SimulationState,
} from '../../domain/model';
import {
  isAlive,
  isDehydratedHibernating,
  type PersonId,
} from '../../domain/person';
import { lifePlanningStage } from '../../domain/life-stage';
import {
  hasFulfillmentOpportunity,
  hasRequiredSocialResponse,
  isFulfillmentOption,
  isRequiredSocialOption,
  isStateAchievementGoal,
} from '../rule-planner';
import { characterAgendaStateOf } from '../../domain/character-agenda';
import { compileOpenConversationOption } from '../conversation-options';
import { agendaMemorySignals } from '../../domain/agent-memory';

export type DecisionBudgetExemption = 'bootstrap' | 'emergency' | 'required-response' | 'fulfillment' | 'agenda-revision';

function personCanDecide(state: SimulationState, context: DecisionContext, atMonth: number): boolean {
  const person = context.person;
  const founderBootstrap = state.clock.elapsedMonths === 0 && atMonth === 1 && person.generation === 0;
  return (founderBootstrap || lifePlanningStage(person, atMonth) !== 'dependent-child')
    && isAlive(person)
    && !isDehydratedHibernating(person);
}

export function decisionUrgency(context: DecisionContext): number {
  const person = context.person;
  return Math.max(100 - person.body.health, 100 - person.body.hydration, 100 - person.body.nutrition);
}

export function hasUnfinishedProductionIntent(context: DecisionContext): boolean {
  return Boolean(context.activeIntent
    && context.activeIntent.domain === 'strategic'
    && isStateAchievementGoal(context.activeIntent.goal)
    && !goalSatisfied(context.state, context.person, context.activeIntent.goal));
}

function isEmergencyDecisionContext(context: DecisionContext): boolean {
  const person = context.person;
  return person.body.health < 35
    || person.body.hydration < 32
    || person.body.nutrition < 34
    || person.conditions.some((condition) => (condition.kind === 'cold'
      || condition.kind === 'heat'
      || condition.kind === 'wound'
      || condition.kind === 'illness') && condition.stage >= 2);
}

function factIdsAfterLastModelDecision(context: DecisionContext): Set<string> {
  let lastDecisionIndex = -1;
  for (let index = context.state.world.past.length - 1; index >= 0; index -= 1) {
    const event = context.state.world.past[index];
    if (event.kind === 'decision' && event.usedModel && event.who === context.person.id) {
      lastDecisionIndex = index;
      break;
    }
  }
  return new Set(context.state.world.past
    .slice(lastDecisionIndex + 1)
    .map((event) => event.id));
}

function includesFreshFact(freshFactIds: ReadonlySet<string>, factIds: readonly string[]): boolean {
  return factIds.some((factId) => freshFactIds.has(factId));
}

/** One unreviewed real outcome earns one model reconsideration. */
export function characterAgendaRevisionDue(context: DecisionContext, atMonth: number): boolean {
  if (context.activeIntent) return false;
  const freshFactIds = factIdsAfterLastModelDecision(context);
  return characterAgendaStateOf(context.person, atMonth).items.some((item) => {
    if (item.status === 'fulfilled' || item.status === 'abandoned' || item.status === 'suspended') return false;
    return item.approaches.some((approach) => {
      const latest = approach.evaluations.at(-1);
      return Boolean(latest
        && (latest.outcome === 'refuted'
          || latest.outcome === 'blocked'
          || (latest.outcome === 'parked' && latest.evidenceFactIds.length > 0))
        && includesFreshFact(freshFactIds, latest.evidenceFactIds));
    });
  });
}

export function decisionBudgetExemption(context: DecisionContext, atMonth: number): DecisionBudgetExemption | null {
  if (isEmergencyDecisionContext(context)) return 'emergency';
  if (hasRequiredSocialResponse(context)) return 'required-response';
  if (hasFulfillmentOpportunity(context)) return 'fulfillment';
  if (characterAgendaRevisionDue(context, atMonth)) return 'agenda-revision';
  // Bootstrap exists to give a founder an initial direction. A restored,
  // fixture-provided, or otherwise already active intention means that
  // direction already exists; opening another bootstrap decision here can
  // replace valid work before its first atomic action is attempted.
  if (atMonth === 1 && context.person.generation === 0 && !context.activeIntent) return 'bootstrap';
  return null;
}

export function lastModelDecisionMonth(state: Pick<SimulationState, 'world'>, personId: PersonId): number | null {
  for (let index = state.world.past.length - 1; index >= 0; index -= 1) {
    const event = state.world.past[index];
    if (event.kind === 'decision' && event.usedModel && !event.planContinuation && event.who === personId) return event.atMonth;
  }
  return null;
}

/**
 * Event/state driven opening for subjective agenda review. Calendar age and a
 * concern's horizon never open this edge by themselves: a concrete outcome,
 * memory, or newly grounded affordance must have appeared after the person's
 * latest model decision.
 */
export function characterAgendaModelReviewDue(
  context: DecisionContext,
  atMonth: number,
): boolean {
  const agenda = characterAgendaStateOf(context.person, atMonth);
  const freshFactIds = factIdsAfterLastModelDecision(context);
  const open = agenda.items.filter((item) => item.status !== 'fulfilled'
    && item.status !== 'abandoned'
    && item.status !== 'suspended');
  if (!context.activeIntent && open.length === 0) return true;
  // Month one is already the founder's bootstrap boundary. If an active
  // intention is present, let it perform at least one real action before a
  // memory-driven agenda review is allowed to replace or revise it.
  if (atMonth === 1 && context.activeIntent) return false;

  // A person may form a new durable concern while still carrying out an
  // existing intent. Only a newly experienced, salient unresolved memory
  // opens this edge; the recorded model decision then consumes the edge, so
  // an old memory cannot create a periodic reflection loop.
  const memorySignals = agendaMemorySignals(context.state, context.person, atMonth);
  const hasFreshUnrepresentedMemory = open.length === 0 && memorySignals.some((memory) => (
    includesFreshFact(freshFactIds, memory.sourceEventIds)
  ));
  if (hasFreshUnrepresentedMemory) return true;

  const locallyAvailableFactIds = [...new Set([
    ...memorySignals.flatMap((memory) => memory.sourceEventIds),
    ...context.options.slice(0, 8).flatMap((option) => option.sourceFactIds),
  ])].filter((factId) => freshFactIds.has(factId));
  const needsFreshReview = open.some((item) => {
    const latestOutcome = item.approaches
      .map((approach) => approach.evaluations.at(-1))
      .filter((evaluation) => evaluation !== undefined)
      .find((evaluation) => includesFreshFact(freshFactIds, evaluation.evidenceFactIds));
    if (latestOutcome) return true;
    if (item.status !== 'incubating' && item.status !== 'blocked' && item.status !== 'suspended') return false;
    const considered = new Set([
      ...item.sourceFactIds,
      ...item.approaches.flatMap((approach) => [
        ...approach.sourceFactIds,
        ...approach.evaluations.flatMap((evaluation) => [
          ...evaluation.basisFactIds,
          ...evaluation.evidenceFactIds,
        ]),
      ]),
    ]);
    return locallyAvailableFactIds.some((factId) => !considered.has(factId));
  });
  if (needsFreshReview) return true;
  return false;
}

function severeExposure(context: DecisionContext): boolean {
  return context.person.conditions.some((condition) => (
    condition.kind === 'cold' || condition.kind === 'heat'
  ) && condition.stage >= 2);
}

export function decisionProbability(state: SimulationState, context: DecisionContext, atMonth: number): { probability: number; reasons: string[] } {
  if (!personCanDecide(state, context, atMonth)) return { probability: 0, reasons: ['当前不能形成自主决定'] };
  if (!context.activeIntent) return { probability: 1, reasons: ['当前没有持续目标，需要形成新的主观方向'] };
  const stalled = atMonth - context.activeIntent.lastProgressAtMonth >= 2;
  if (stalled) return { probability: 1, reasons: ['当前意图连续没有可见进展，需要重新理解或改换办法'] };
  if (severeExposure(context)) return { probability: 1, reasons: ['身体正经历可感知危险，需要重评方向'] };
  if (hasRequiredSocialResponse(context) || hasFulfillmentOpportunity(context)) {
    return { probability: 1, reasons: ['一项真实回应或承诺到达了当前行动边界'] };
  }
  if (characterAgendaModelReviewDue(context, atMonth)) {
    return { probability: 1, reasons: ['长期关切出现了新证据或到了复核时点'] };
  }
  // Calendar cadence opens a chance to think; it does not decide which aim
  // wins. A productive project is still part of a person's life and cannot
  // suppress their monthly consideration of relationships and new ideas.
  return { probability: 1, reasons: ['月度回顾实际结果，决定延续、修订或改变当前安排'] };
}

/**
 * The model owns the subjective MentalAct. Its optional first step is still
 * re-grounded against the latest local world before it can become an Intent.
 */
export function validateModelDecision(
  context: DecisionContext,
  proposed: Decision,
  localDecision?: Decision,
): Decision | null {
  // Social obligations remain facts with deadlines and consequences. They
  // cannot decide whether a person may think, leave, ignore, or attempt an
  // unrelated action; the chosen action is checked against world facts below.
  if (proposed.kind === 'idle') {
    return {
      kind: 'idle',
      reason: proposed.reason,
      ...(proposed.characterAgendaUpdate
        ? { characterAgendaUpdate: structuredClone(proposed.characterAgendaUpdate) }
        : {}),
      ...(proposed.executionProbe
        ? { executionProbe: structuredClone(proposed.executionProbe) }
        : {}),
      ...(proposed.mentalAct ? { mentalAct: structuredClone(proposed.mentalAct) } : {}),
    };
  }
  if (proposed.kind === 'suspend') {
    if (!context.activeIntent || proposed.intentId !== context.activeIntent.id) return null;
    return {
      kind: 'suspend',
      intentId: proposed.intentId,
      reason: proposed.reason,
      ...(proposed.mentalAct ? { mentalAct: structuredClone(proposed.mentalAct) } : {}),
    };
  }
  if (proposed.kind === 'resume') {
    const candidate = context.state.intents.find((intent) => intent.id === proposed.intentId);
    if (candidate?.ownerId !== context.person.id
      || candidate.status !== 'suspended'
      || candidate.suspendedByIntentId
      || candidate.waitingFor === 'world-change') return null;
    return {
      kind: 'resume',
      intentId: candidate.id,
      reason: proposed.reason,
      ...(proposed.mentalAct ? { mentalAct: structuredClone(proposed.mentalAct) } : {}),
    };
  }
  if (proposed.kind === 'abandon') {
    const candidate = context.activeIntent?.id === proposed.intentId
      ? context.activeIntent
      : context.state.intents.find((intent) => intent.id === proposed.intentId);
    if (candidate?.ownerId !== context.person.id
      || candidate.suspendedByIntentId
      || (candidate.status !== 'active' && candidate.status !== 'suspended')) return null;
    return {
      kind: 'abandon',
      intentId: candidate.id,
      reason: proposed.reason,
      ...(proposed.mentalAct ? { mentalAct: structuredClone(proposed.mentalAct) } : {}),
    };
  }
  if (proposed.kind !== 'start' && proposed.kind !== 'revise') return null;
  const selected = context.options.find((option) => option.id === proposed.optionId);
  if (!selected) return null;
  if (!composeIntentChoice(context.options, context.followUpOptions, selected.id, proposed.followUpOptionId)) return null;

  const communication = selected.nextAction.kind === 'talk'
    ? selected.nextAction
    : selected.completionAction?.kind === 'talk'
      ? selected.completionAction
      : null;
  const proposedUtterance = proposed.mentalAct?.utterance.trim();
  const proposedGrounding = proposed.groundingSourceFactIds;
  const compiledOpenConversation = selected.openConversationGrounding
    ? compileOpenConversationOption(context.state, context.person, selected, proposedGrounding ?? [])
    : null;
  if (selected.openConversationGrounding && (!proposedUtterance || !proposedGrounding || !compiledOpenConversation)) {
    return null;
  }
  if (!selected.openConversationGrounding && proposedGrounding !== undefined) return null;

  const shared = {
    optionId: selected.id,
    ...(proposed.followUpOptionId ? { followUpOptionId: proposed.followUpOptionId } : {}),
    reason: proposed.reason,
    ...(proposedUtterance ? { utterance: proposedUtterance } : {}),
    ...(selected.openConversationGrounding ? { groundingSourceFactIds: [...proposedGrounding!] } : {}),
    ...(proposed.sourceInteractionId ? { sourceInteractionId: proposed.sourceInteractionId } : {}),
    ...(proposed.characterAgendaProposal
      ? { characterAgendaProposal: structuredClone(proposed.characterAgendaProposal) }
      : {}),
    ...(proposed.characterAgendaUpdate
      ? { characterAgendaUpdate: structuredClone(proposed.characterAgendaUpdate) }
      : {}),
    ...(proposed.mentalAct ? { mentalAct: structuredClone(proposed.mentalAct) } : {}),
  };
  const active = context.activeIntent;
  if (!active) return { kind: 'start', ...shared };
  if (proposed.kind === 'revise' && proposed.intentId !== active.id) return null;

  const localForSameOption = localDecision?.kind === 'revise' && localDecision.optionId === selected.id
    ? localDecision
    : null;
  const interruptionKind = isRequiredSocialOption(selected)
    ? 'required-response' as const
    : isFulfillmentOption(selected)
      ? 'fulfillment' as const
      : selected.recordUseBasis
        ? 'record-use' as const
        : communication
          ? 'voluntary-conversation' as const
        : localForSameOption?.interruptionKind;
  const survivalHibernationInterruption = localForSameOption?.interruptionKind === 'survival-reflex'
    && selected.nextAction.kind === 'act'
    && selected.nextAction.operation === 'dehydrate';
  const canInterrupt = !proposed.followUpOptionId
    && (isResumableIntent(active) || survivalHibernationInterruption);
  return {
    kind: 'revise',
    intentId: active.id,
    ...shared,
    ...(canInterrupt && interruptionKind ? { mode: 'interrupt' as const, interruptionKind } : {}),
    ...(localForSameOption?.lifeReview ? { lifeReview: structuredClone(localForSameOption.lifeReview) } : {}),
  };
}
