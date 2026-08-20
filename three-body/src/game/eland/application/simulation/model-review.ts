import { goalSatisfied } from '../../domain/action-executor';
import { composeIntentChoice } from '../../domain/intent';
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
  isMaintainableStateGoal,
  isProductionOption,
  isRequiredSocialOption,
} from '../rule-planner';
import { clamp } from './state-utils';

export type DecisionBudgetExemption = 'bootstrap' | 'emergency' | 'required-response' | 'fulfillment';

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
    && isMaintainableStateGoal(context.activeIntent.goal)
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

export function decisionBudgetExemption(context: DecisionContext, atMonth: number): DecisionBudgetExemption | null {
  if (atMonth === 1 && context.person.generation === 0) return 'bootstrap';
  if (isEmergencyDecisionContext(context)) return 'emergency';
  if (hasRequiredSocialResponse(context)) return 'required-response';
  if (hasFulfillmentOpportunity(context)) return 'fulfillment';
  return null;
}

export function lastModelDecisionMonth(state: SimulationState, personId: PersonId): number | null {
  for (let index = state.world.past.length - 1; index >= 0; index -= 1) {
    const event = state.world.past[index];
    if (event.kind === 'decision' && event.usedModel && event.who === personId) return event.atMonth;
  }
  return null;
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
  if (context.options.some((option) => option.id.startsWith('fulfill-assist:') || option.id.startsWith('meet-to-assist:') || option.id.startsWith('join-water-assist:'))) {
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
    return required.length || fulfillment.length ? null : proposed;
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
    ...(proposed.sourceInteractionId ? { sourceInteractionId: proposed.sourceInteractionId } : {}),
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
        : localForSameOption?.interruptionKind;
  const survivalHibernationInterruption = localForSameOption?.interruptionKind === 'survival-reflex'
    && selected.nextAction.kind === 'act'
    && selected.nextAction.operation === 'dehydrate';
  const canInterrupt = Boolean(active.projectId || active.returnToIntentId || survivalHibernationInterruption);
  return {
    kind: 'revise',
    intentId: active.id,
    ...shared,
    ...(canInterrupt && interruptionKind ? { mode: 'interrupt' as const, interruptionKind } : {}),
    ...(localForSameOption?.lifeReview ? { lifeReview: structuredClone(localForSameOption.lifeReview) } : {}),
  };
}
