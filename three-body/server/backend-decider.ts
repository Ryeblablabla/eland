import { buildDecisionRequestContext } from "../src/game/eland/kimi-decider";
import type { BatchDecider, Decision, DecisionContext } from "../src/game/eland/simulation";
import { followUpSemanticallyMatches } from '../src/game/eland/domain/intent-follow-up';
import {
  validatePlayerInteractionChoice,
  isPlayerInteractionEmergencyContext,
  type PlayerInteractionChoiceFailure,
} from '../src/game/eland/application/player-interaction-choice';
import {
  hasFulfillmentOpportunity,
  isFulfillmentOption,
  isRequiredSocialOption,
} from '../src/game/eland/application/rule-planner';
import { handleDecide } from "./model-decision-gateway";

export interface PendingPlayerInteraction {
  id: string;
  agentId: string;
  sourceMonth: number;
  playerMessage: string;
  stance: 'consider' | 'accept';
  guidance?: string;
  choice: {
    optionId: string;
    followUpOptionId?: string;
    summary: string;
    choiceKey: string;
    reason: string;
  };
}

export interface PlayerInteractionDecisionAttempt {
  interactionId: string;
  agentId: string;
  status: 'ready' | 'blocked';
  proposedKind?: Decision['kind'];
  optionId?: string;
  failure?: PlayerInteractionChoiceFailure;
  detail?: string;
}

export interface ServerLlmDecider extends BatchDecider {
  takeInteractionAttempts(): PlayerInteractionDecisionAttempt[];
}

function blockedChoiceDetail(failure: PlayerInteractionChoiceFailure, summary: string): string {
  if (failure === 'emergency-first') return `我得先让身体脱离眼前的危险，之后再看能不能开始“${summary}”。`;
  if (failure === 'required-response-first') return `眼前有人正等我答复，我没能先开始“${summary}”。`;
  if (failure === 'fulfillment-first') return `我得先履行已经答应的事，没能先开始“${summary}”。`;
  if (failure === 'follow-up-unavailable') return `“${summary}”的后续做法已经不再可行。`;
  if (failure === 'choice-ambiguous') return `眼前出现了几种都像“${summary}”的做法，我没法在不重新决定的情况下替自己挑一个。`;
  return `眼前的条件已经变了，“${summary}”暂时不再是可行的下一步。`;
}

/**
 * The interaction model has already made the person's choice. The month step
 * only revalidates that exact choice against fresh local facts; it never asks a
 * second model to reinterpret free-form guidance.
 */
export function decisionFromPlayerInteraction(
  context: DecisionContext,
  interaction: PendingPlayerInteraction,
): { decision: Decision | null; attempt: PlayerInteractionDecisionAttempt } {
  const validated = validatePlayerInteractionChoice(context, interaction.choice);
  if (!validated.ok) {
    return {
      decision: null,
      attempt: {
        interactionId: interaction.id,
        agentId: context.person.id,
        status: 'blocked',
        optionId: interaction.choice.optionId,
        failure: validated.failure,
        detail: blockedChoiceDetail(validated.failure, interaction.choice.summary),
      },
    };
  }

  const shared = {
    optionId: validated.optionId,
    ...(validated.followUpOptionId ? { followUpOptionId: validated.followUpOptionId } : {}),
    reason: interaction.choice.reason,
    sourceInteractionId: interaction.id,
  };
  const decision: Decision = context.activeIntent
    ? { kind: 'revise', intentId: context.activeIntent.id, ...shared }
    : { kind: 'start', ...shared };
  return {
    decision,
    attempt: {
      interactionId: interaction.id,
      agentId: context.person.id,
      status: 'ready',
      proposedKind: decision.kind,
      optionId: validated.optionId,
    },
  };
}

/**
 * 实时模型只参与真正存在选择空间的关键节点。开局、身体危险和既定履约
 * 保持本地即时处理；必须回应与有多项合法方向的社会/战略转折可以请求模型。
 */
export function isLiveModelDecisionContext(context: DecisionContext, atMonth: number): boolean {
  if (atMonth === 1 && context.person.generation === 0) return false;
  if (isPlayerInteractionEmergencyContext(context)) return false;
  const required = context.options.filter(isRequiredSocialOption);
  if (required.length) {
    if (required.length > 1) return true;
    const only = required[0];
    return Boolean(only.requiresFollowUp && context.followUpOptions
      .filter((option) => followUpSemanticallyMatches(only, option)).length > 1);
  }
  if (hasFulfillmentOpportunity(context)) return false;
  if (context.options.length < 2) return false;
  const hasDialogueChoice = context.options.some((option) => option.nextAction.kind === 'communicate'
    || option.completionAction?.kind === 'communicate');
  const active = context.activeIntent;
  const progressAnchor = active
    ? Math.max(active.lastProgressAtMonth, active.lastResumedAtMonth ?? active.lastProgressAtMonth)
    : atMonth;
  const turningPoint = Boolean(active) && (
    active?.stateGoalUntilMonth !== undefined && atMonth > active.stateGoalUntilMonth
    || atMonth - progressAnchor >= 2
  );
  return hasDialogueChoice || turningPoint || !active;
}

export function createServerLlmDecider(
  endpointId?: string,
  options: { interactions?: PendingPlayerInteraction[]; pendingOnly?: boolean } = {},
): ServerLlmDecider {
  let usage = { inputTokens: 0, outputTokens: 0 };
  let metadata: { endpointId: string; protocol: string; model: string } | null = null;
  let interactionAttempts: PlayerInteractionDecisionAttempt[] = [];
  const interactions = new Map<string, PendingPlayerInteraction>();
  for (const interaction of options.interactions ?? []) interactions.set(interaction.agentId, interaction);
  const interactionFor = (context: DecisionContext) => interactions.get(context.person.id);
  const hasActionableInteraction = (context: DecisionContext) => Boolean(interactionFor(context));
  return {
    shouldDecide(context, atMonth) {
      return hasActionableInteraction(context)
        || (!options.pendingOnly && isLiveModelDecisionContext(context, atMonth));
    },
    forceReview(context) {
      return hasActionableInteraction(context);
    },
    isBudgetExempt(context) {
      return hasActionableInteraction(context);
    },
    async decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]> {
      const decisions: (Decision | null)[] = Array.from({ length: contexts.length }, () => null);
      const remoteContexts: Array<{ context: DecisionContext; index: number }> = [];
      let hasDirectInteraction = false;
      contexts.forEach((context, index) => {
        const interaction = interactionFor(context);
        if (!interaction) {
          remoteContexts.push({ context, index });
          return;
        }
        hasDirectInteraction = true;
        const direct = decisionFromPlayerInteraction(context, interaction);
        decisions[index] = direct.decision;
        interactionAttempts.push(direct.attempt);
      });

      if (!remoteContexts.length) return decisions;
      if (!endpointId) return decisions;

      let result: Awaited<ReturnType<typeof handleDecide>>;
      try {
        result = await handleDecide({
          contexts: remoteContexts.map(({ context }) => buildDecisionRequestContext(context)),
          endpoint: endpointId,
        }, endpointId);
      } catch (error) {
        if (hasDirectInteraction) return decisions;
        throw error;
      }
      if (result.status !== 200) {
        const detail = result.body as { error?: string };
        if (hasDirectInteraction) return decisions;
        throw new Error(detail?.error ?? `模型决策失败（${result.status}）`);
      }
      const body = result.body as {
        decisions?: (Decision | null)[];
        usage?: typeof usage;
        endpointId?: string;
        protocol?: string;
        model?: string;
      };
      if (!Array.isArray(body.decisions) || body.decisions.length !== remoteContexts.length) {
        if (hasDirectInteraction) return decisions;
        throw new Error("模型没有返回与关键决策上下文一一对应的结果");
      }
      body.decisions.forEach((decision, resultIndex) => {
        decisions[remoteContexts[resultIndex].index] = decision;
      });
      usage = body.usage ?? usage;
      metadata = body.endpointId && body.protocol && body.model
        ? { endpointId: body.endpointId, protocol: body.protocol, model: body.model }
        : null;
      return decisions;
    },
    takeUsage() {
      const result = usage;
      usage = { inputTokens: 0, outputTokens: 0 };
      return result;
    },
    takeMetadata() {
      const result = metadata;
      metadata = null;
      return result;
    },
    takeInteractionAttempts() {
      const result = interactionAttempts;
      interactionAttempts = [];
      return result;
    },
  };
}
