import { buildDecisionRequestContext } from "../src/game/eland/kimi-decider";
import type { BatchDecider, Decision, DecisionContext } from "../src/game/eland/simulation";
import { hasFulfillmentOpportunity, hasRequiredSocialResponse } from '../src/game/eland/application/rule-planner';
import { handleDecide } from "./model-decision-gateway";

function isEmergencyContext(context: DecisionContext): boolean {
  const person = context.person;
  return person.body.health < 35
    || person.body.hydration < 32
    || person.body.nutrition < 34
    || person.conditions.some((condition) => (
      condition.kind === 'cold'
      || condition.kind === 'heat'
      || condition.kind === 'wound'
      || condition.kind === 'illness'
    ) && condition.stage >= 2);
}

/**
 * 实时模型只参与真正存在选择空间的关键节点。开局、身体危险和既定履约
 * 保持本地即时处理；必须回应与有多项合法方向的社会/战略转折可以请求模型。
 */
export function isLiveModelDecisionContext(context: DecisionContext, atMonth: number): boolean {
  if (atMonth === 1 && context.person.generation === 0) return false;
  if (isEmergencyContext(context)) return false;
  if (hasRequiredSocialResponse(context)) return true;
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

export function createServerLlmDecider(endpointId?: string): BatchDecider {
  let usage = { inputTokens: 0, outputTokens: 0 };
  let metadata: { endpointId: string; protocol: string; model: string } | null = null;
  return {
    shouldDecide: isLiveModelDecisionContext,
    async decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]> {
      const result = await handleDecide({
        contexts: contexts.map(buildDecisionRequestContext),
        endpoint: endpointId,
      }, endpointId);
      if (result.status !== 200) {
        const detail = result.body as { error?: string };
        throw new Error(detail?.error ?? `模型决策失败（${result.status}）`);
      }
      const body = result.body as {
        decisions?: (Decision | null)[];
        usage?: typeof usage;
        endpointId?: string;
        protocol?: string;
        model?: string;
      };
      if (!Array.isArray(body.decisions) || body.decisions.length !== contexts.length) {
        throw new Error("模型没有返回与关键决策上下文一一对应的结果");
      }
      usage = body.usage ?? usage;
      metadata = body.endpointId && body.protocol && body.model
        ? { endpointId: body.endpointId, protocol: body.protocol, model: body.model }
        : null;
      return body.decisions;
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
  };
}
