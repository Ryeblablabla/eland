import type { BatchDecider, Decision, DecisionContext, TokenUsage } from "../src/game/eland/simulation";
import type { SpeechLineView } from '../src/game/societyContract';
import { isModelOwnedVoluntarySocialOption } from '../src/game/eland/domain/action-option-semantics';
import { intentReviewAtMonth } from '../src/game/eland/domain/intent';
import {
  buildDecisionRequestContext,
  hasFulfillmentOpportunity,
  isPlayerInteractionEmergencyContext,
  isFulfillmentOption,
  isRequiredSocialOption,
  characterAgendaModelReviewDue,
  validatePlayerInteractionChoice,
  type PlayerInteractionChoiceFailure,
} from '../src/game/eland/infrastructure-api';
import { handleContinuePlans, handleDecide } from "./model-decision-gateway";

const MAX_REMOTE_CONTEXTS_PER_REQUEST = 12;

function addTokenUsage(left: TokenUsage, right?: TokenUsage): TokenUsage {
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...((left.cacheHitInputTokens !== undefined || right.cacheHitInputTokens !== undefined)
      ? { cacheHitInputTokens: (left.cacheHitInputTokens ?? 0) + (right.cacheHitInputTokens ?? 0) }
      : {}),
    ...((left.cacheMissInputTokens !== undefined || right.cacheMissInputTokens !== undefined)
      ? { cacheMissInputTokens: (left.cacheMissInputTokens ?? 0) + (right.cacheMissInputTokens ?? 0) }
      : {}),
  };
}

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
  takeDiagnostics(): Array<{ personId: string; reason: string }>;
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
 * The hidden interaction-intent pass has extracted the person's choice from
 * their reply. The month step only revalidates that exact choice against fresh
 * local facts; it never asks another model to decide again.
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
 * 实时模型只参与真正存在主观选择空间的关键节点。身体危险和既定履约
 * 保持本地即时处理；先民也可进入审议，但仍与普通月份共用容量。可选对话
 * 与关系分叉即使只有一项合法行动，也保留“做或不做”的模型选择。
 */
export function isLiveModelDecisionContext(context: DecisionContext, atMonth: number): boolean {
  if (isPlayerInteractionEmergencyContext(context)) return false;
  const required = context.options.filter(isRequiredSocialOption);
  if (required.length) return true;
  if (hasFulfillmentOpportunity(context)) return true;
  const hasDialogueChoice = context.options.some((option) => option.nextAction.kind === 'talk'
    || option.completionAction?.kind === 'talk');
  const active = context.activeIntent;
  const progressAnchor = active
    ? Math.max(active.lastProgressAtMonth, active.lastResumedAtMonth ?? active.lastProgressAtMonth)
    : atMonth;
  const reviewAtMonth = active ? intentReviewAtMonth(active) : undefined;
  const turningPoint = Boolean(active) && (
    reviewAtMonth !== undefined && atMonth > reviewAtMonth
    || atMonth - progressAnchor >= 2
  );
  if (turningPoint || characterAgendaModelReviewDue(context, atMonth)) return true;
  if (context.options.some(isModelOwnedVoluntarySocialOption)) return true;
  // The model owns formation of a new subjective direction. A single current
  // affordance is only a possible first step, not a reason to skip cognition.
  if (!active) return true;
  return hasDialogueChoice;
}

export function createServerLlmDecider(
  endpointId?: string,
  options: {
    interactions?: PendingPlayerInteraction[];
    pendingOnly?: boolean;
    /** Branch-local lines restored from already committed frames. */
    priorSpeechLines?: readonly SpeechLineView[];
  } = {},
): ServerLlmDecider {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let metadata: { endpointId: string; protocol: string; model: string; providerRequests?: number } | null = null;
  let interactionAttempts: PlayerInteractionDecisionAttempt[] = [];
  let diagnostics: Array<{ personId: string; reason: string }> = [];
  const interactions = new Map<string, PendingPlayerInteraction>();
  for (const interaction of options.interactions ?? []) interactions.set(interaction.agentId, interaction);
  const interactionFor = (context: DecisionContext) => interactions.get(context.person.id);
  const hasActionableInteraction = (context: DecisionContext) => Boolean(interactionFor(context));
  return {
    // A pending player interaction without a configured evolution endpoint is
    // still an offline/rule month; only a real model route takes ownership.
    ownsVoluntarySocialChoices: Boolean(endpointId),
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
        interactions.delete(context.person.id);
      });

      if (!remoteContexts.length) return decisions;
      if (!endpointId) return decisions;

      const projectedContexts = remoteContexts.map(({ context }) => buildDecisionRequestContext(context, {
        committedSpeechLines: options.priorSpeechLines,
      }));
      const remoteDecisions: (Decision | null)[] = [];
      let remoteUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let remoteMetadata: typeof metadata = null;
      let providerRequests = 0;
      for (let start = 0; start < projectedContexts.length; start += MAX_REMOTE_CONTEXTS_PER_REQUEST) {
        const chunk = projectedContexts.slice(start, start + MAX_REMOTE_CONTEXTS_PER_REQUEST);
        let result: Awaited<ReturnType<typeof handleDecide>>;
        try {
          result = await handleDecide({ contexts: chunk, endpoint: endpointId }, endpointId);
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
          usage?: TokenUsage;
          endpointId?: string;
          protocol?: string;
          model?: string;
          providerRequests?: number;
          failures?: Array<{ personId: string; reason: string }>;
        };
        if (!Array.isArray(body.decisions) || body.decisions.length !== chunk.length) {
          if (hasDirectInteraction) return decisions;
          throw new Error("模型没有返回与关键决策上下文一一对应的结果");
        }
        remoteDecisions.push(...body.decisions);
        if (body.failures?.length) diagnostics = [...diagnostics, ...body.failures].slice(-128);
        remoteUsage = addTokenUsage(remoteUsage, body.usage);
        providerRequests += body.providerRequests ?? 1;
        if (body.endpointId && body.protocol && body.model) {
          remoteMetadata = { endpointId: body.endpointId, protocol: body.protocol, model: body.model, providerRequests };
        }
      }
      remoteDecisions.forEach((decision, resultIndex) => {
        decisions[remoteContexts[resultIndex].index] = decision;
      });
      usage = addTokenUsage(usage, remoteUsage);
      metadata = remoteMetadata
        ? {
            ...remoteMetadata,
            providerRequests: (metadata?.providerRequests ?? 0) + providerRequests,
          }
        : metadata;
      return decisions;
    },
    async continuePlans(contexts: DecisionContext[]): Promise<(Decision | null)[]> {
      const decisions: (Decision | null)[] = contexts.map(() => null);
      if (!endpointId || options.pendingOnly) return decisions;
      // A continuation executes the existing intention. New language and new
      // consent need a Mind turn; physically fulfilling an agreement does not.
      const requiresNewSpeech = (option: DecisionContext['options'][number]) => (
        option.nextAction.kind === 'talk' || option.completionAction?.kind === 'talk'
      );
      const projected = contexts.flatMap((context, index) => context.continuingPlan ? [{
        index,
        context: buildDecisionRequestContext({
          ...context,
          options: context.options.filter((option) => !requiresNewSpeech(option)),
          followUpOptions: context.followUpOptions.filter((option) => !requiresNewSpeech(option)),
        }, { committedSpeechLines: options.priorSpeechLines }),
      }] : []);
      for (let start = 0; start < projected.length; start += MAX_REMOTE_CONTEXTS_PER_REQUEST) {
        const chunk = projected.slice(start, start + MAX_REMOTE_CONTEXTS_PER_REQUEST);
        const response = await handleContinuePlans({ contexts: chunk.map((item) => item.context) }, endpointId);
        if (response.status !== 200) {
          const detail = response.body as { error?: string };
          throw new Error(detail.error ?? `计划续编失败（${response.status}）`);
        }
        const body = response.body as {
          decisions?: (Decision | null)[];
          usage?: TokenUsage;
          endpointId?: string;
          protocol?: string;
          model?: string;
          providerRequests?: number;
          failures?: Array<{ personId: string; reason: string }>;
        };
        usage = addTokenUsage(usage, body.usage);
        if (body.failures?.length) diagnostics = [...diagnostics, ...body.failures].slice(-128);
        if (body.endpointId && body.protocol && body.model) {
          metadata = {
            endpointId: body.endpointId,
            protocol: body.protocol,
            model: body.model,
            providerRequests: (metadata?.providerRequests ?? 0) + (body.providerRequests ?? 0),
          };
        }
        if (!Array.isArray(body.decisions) || body.decisions.length !== chunk.length) {
          throw new Error('Plan 没有返回与续编上下文一一对应的结果');
        }
        body.decisions.forEach((decision, index) => { decisions[chunk[index].index] = decision; });
      }
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
    takeDiagnostics() {
      const result = diagnostics;
      diagnostics = [];
      return result;
    },
  };
}
