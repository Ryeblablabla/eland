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
import { actionOptionSemantics } from '../../domain/action-option-semantics';
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

/** One objective refutation earns one bounded model reconsideration. */
export function characterAgendaRevisionDue(context: DecisionContext, atMonth: number): boolean {
  if (context.activeIntent) return false;
  return characterAgendaStateOf(context.person, atMonth).items.some((item) => {
    if (item.status === 'fulfilled' || item.status === 'abandoned' || item.status === 'suspended') return false;
    return item.approaches.some((approach) => {
      const latest = approach.evaluations.at(-1);
      return Boolean(latest
        && (latest.outcome === 'refuted'
          || latest.outcome === 'blocked'
          || (latest.outcome === 'parked' && latest.evidenceFactIds.length > 0))
        // Cooldown belongs to this factual result. An unrelated dialogue or
        // social model decision must not keep postponing reconsideration.
        && atMonth - latest.atMonth >= CHARACTER_AGENDA_MODEL_REVIEW_COOLDOWN_MONTHS
        && latest.atMonth >= item.lastReviewedAtMonth);
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
    if (event.kind === 'decision' && event.usedModel && event.who === personId) return event.atMonth;
  }
  return null;
}

const CHARACTER_AGENDA_MODEL_REVIEW_COOLDOWN_MONTHS = 3;

/**
 * Event/state driven opening for subjective agenda review. This is deliberately
 * independent of the number of executable options, but has a per-person
 * cooldown so an affordance gap cannot create a monthly request loop.
 */
export function characterAgendaModelReviewDue(
  context: DecisionContext,
  atMonth: number,
): boolean {
  const lastModelMonth = lastModelDecisionMonth(context.state, context.person.id);
  if (lastModelMonth !== null && atMonth - lastModelMonth < CHARACTER_AGENDA_MODEL_REVIEW_COOLDOWN_MONTHS) {
    return false;
  }
  const agenda = characterAgendaStateOf(context.person, atMonth);
  const open = agenda.items.filter((item) => item.status !== 'fulfilled' && item.status !== 'abandoned');
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
  const firstReviewBaseline = context.activeIntent?.createdAtMonth ?? atMonth;
  const hasFreshUnrepresentedMemory = open.length === 0 && memorySignals.some((memory) => (
    lastModelMonth === null
      ? memory.lastExperiencedAtMonth > firstReviewBaseline
      : memory.lastExperiencedAtMonth >= lastModelMonth
  ));
  if (hasFreshUnrepresentedMemory) return true;

  const locallyAvailableFactIds = new Set([
    ...memorySignals.flatMap((memory) => memory.sourceEventIds),
    ...context.options.slice(0, 8).flatMap((option) => option.sourceFactIds),
  ]);
  const needsFreshReview = open.some((item) => {
    if (item.targetAtMonth <= atMonth && item.lastReviewedAtMonth < atMonth) return true;
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
    return [...locallyAvailableFactIds].some((factId) => !considered.has(factId));
  });
  if (needsFreshReview) return true;
  if (!context.activeIntent && open.length > 0) {
    const lastSubjectiveReview = Math.max(...open.map((item) => item.lastReviewedAtMonth));
    return atMonth - lastSubjectiveReview >= 6;
  }
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
  const socialOpening = context.options.some((option) => (
    option.domain === 'social'
    && actionOptionSemantics(option).obligation === 'optional'
  ));
  return socialOpening
    ? { probability: 0.55, reasons: ['眼前出现了自主交流或协商机会'] }
    : { probability: 0.08, reasons: ['稳定意图仍允许偶尔重新思考'] };
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
  const required = context.options.filter(isRequiredSocialOption);
  const fulfillment = context.options.filter(isFulfillmentOption);
  if (proposed.kind === 'idle') {
    return required.length || fulfillment.length
      ? null
      : {
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
  if (proposed.kind === 'suspend' || proposed.kind === 'abandon') {
    if (required.length || fulfillment.length) return null;
    if (!context.activeIntent || proposed.intentId !== context.activeIntent.id) return null;
    return {
      kind: proposed.kind,
      intentId: proposed.intentId,
      reason: proposed.reason,
      ...(proposed.mentalAct ? { mentalAct: structuredClone(proposed.mentalAct) } : {}),
    };
  }
  if (proposed.kind !== 'start' && proposed.kind !== 'revise') return null;
  const selected = context.options.find((option) => option.id === proposed.optionId);
  if (!selected) return null;
  if (required.length && !required.some((option) => option.id === selected.id)) return null;
  if (!required.length && fulfillment.length && !fulfillment.some((option) => option.id === selected.id)) return null;
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
  const contradictoryStructuredReply = Boolean(proposedUtterance && communication) && (
    communication?.speakerMeaning.kind === 'accept'
      ? /拒绝|不同意|不愿意|不接受|[?？]/u.test(proposedUtterance ?? '')
      : communication?.speakerMeaning.kind === 'reject'
        ? /同意|接受|愿意|成交/u.test(proposedUtterance ?? '')
        : false
  );

  const shared = {
    optionId: selected.id,
    ...(proposed.followUpOptionId ? { followUpOptionId: proposed.followUpOptionId } : {}),
    reason: proposed.reason,
    ...(proposedUtterance && !contradictoryStructuredReply ? { utterance: proposedUtterance } : {}),
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
  const interruptionKind = required.length
    ? 'required-response' as const
    : fulfillment.length
      ? 'fulfillment' as const
      : selected.recordUseBasis
        ? 'record-use' as const
        : communication
          ? 'voluntary-conversation' as const
        : localForSameOption?.interruptionKind;
  const survivalHibernationInterruption = localForSameOption?.interruptionKind === 'survival-reflex'
    && selected.nextAction.kind === 'act'
    && selected.nextAction.operation === 'dehydrate';
  const canInterrupt = isResumableIntent(active) || survivalHibernationInterruption;
  return {
    kind: 'revise',
    intentId: active.id,
    ...shared,
    ...(canInterrupt && interruptionKind ? { mode: 'interrupt' as const, interruptionKind } : {}),
    ...(localForSameOption?.lifeReview ? { lifeReview: structuredClone(localForSameOption.lifeReview) } : {}),
  };
}
