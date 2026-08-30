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
import { acceptedExchangeFor, exchangeTermFulfilled } from '../../domain/social-facts';
import {
  hasFulfillmentOpportunity,
  hasRequiredSocialResponse,
  isFulfillmentOption,
  isProductionOption,
  isRequiredSocialOption,
  isStateAchievementGoal,
} from '../rule-planner';
import { clamp } from './state-utils';
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
  const person = context.person;
  const reasons: string[] = [];
  let probability = personCanDecide(state, context, atMonth) ? 0.045 : 0.01;
  if (!context.activeIntent) {
    probability += 0.44;
    reasons.push('当前没有持续目标');
    if (context.options.some(isProductionOption)) {
      probability += 0.16;
      reasons.push('空闲时存在可执行的生产或探索机会');
    }
  }
  if (context.activeIntent && atMonth - context.activeIntent.lastProgressAtMonth >= 2) {
    probability += hasUnfinishedProductionIntent(context) ? 0.48 : 0.22;
    reasons.push(hasUnfinishedProductionIntent(context) ? '未完成的生产目标已经停滞' : '意图停滞');
  }
  if (severeExposure(context)) {
    probability += 0.72;
    reasons.push('寒冷或炎热已经进入新的危险阶段，需要重评长期手段');
  }
  const acceptedExchange = acceptedExchangeFor(state, person.id, atMonth);
  if (acceptedExchange && !exchangeTermFulfilled(state, acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : '', person.id)) {
    probability += 0.72;
    reasons.push('已接受的交换等待本人交付');
  }
  if (context.options.some((option) => isFulfillmentOption(option)
    && actionOptionSemantics(option).socialContext?.cooperationKind === 'assist')) {
    probability += 0.72;
    reasons.push('已接受的求助等待本人履行');
  }
  if (!reasons.length) reasons.push('每月非零重新考虑概率');
  return { probability: clamp(probability, 0.01, 0.82), reasons };
}

/**
 * 模型只能在本地已编译的候选中选择。这里再次使用完整领域上下文校验，
 * 因而协议层只检查 ID 仍不足以让建议进入权威意图。
 */
export function validateModelDecision(
  context: DecisionContext,
  proposed: Decision,
  localDecision: Decision,
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
          ...(proposed.memoryConsolidation
            ? { memoryConsolidation: structuredClone(proposed.memoryConsolidation) }
            : {}),
        };
  }
  if (proposed.kind !== 'start' && proposed.kind !== 'revise') return null;
  const selected = context.options.find((option) => option.id === proposed.optionId);
  if (!selected) return null;
  if (required.length && !required.some((option) => option.id === selected.id)) return null;
  if (!required.length && fulfillment.length && !fulfillment.some((option) => option.id === selected.id)) return null;
  if (!composeIntentChoice(context.options, context.followUpOptions, selected.id, proposed.followUpOptionId)) return null;

  const communication = selected.nextAction.kind === 'communicate'
    ? selected.nextAction
    : selected.completionAction?.kind === 'communicate'
      ? selected.completionAction
      : null;
  const proposedUtterance = proposed.utterance?.trim();
  const proposedGrounding = proposed.groundingSourceFactIds;
  const compiledOpenConversation = selected.openConversationGrounding
    ? compileOpenConversationOption(selected, proposedGrounding ?? [])
    : null;
  if (selected.openConversationGrounding && (!proposedUtterance || !proposedGrounding || !compiledOpenConversation)) {
    return null;
  }
  if (!selected.openConversationGrounding && proposedGrounding !== undefined) return null;
  const contradictoryStructuredReply = Boolean(proposedUtterance && communication) && (
    communication?.content.kind === 'accept'
      ? /拒绝|不同意|不愿意|不接受|[?？]/u.test(proposedUtterance ?? '')
      : communication?.content.kind === 'reject'
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
    ...(proposed.memoryConsolidation
      ? { memoryConsolidation: structuredClone(proposed.memoryConsolidation) }
      : {}),
  };
  const active = context.activeIntent;
  if (!active) return { kind: 'start', ...shared };
  if (proposed.kind === 'revise' && proposed.intentId !== active.id) return null;

  const localForSameOption = localDecision.kind === 'revise' && localDecision.optionId === selected.id
    ? localDecision
    : null;
  const interruptionKind = required.length
    ? 'required-response' as const
    : fulfillment.length
      ? 'fulfillment' as const
      : selected.recordUseBasis
        ? 'record-use' as const
        : communication?.content.kind === 'claim' && communication.content.conversation
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
