import { buildDecisionRequestContext } from "../src/game/eland/kimi-decider";
import type { ModelProvider } from "../src/game/llm";
import type { BatchDecider, Decision, DecisionContext } from "../src/game/eland/simulation";
import { handleDecide } from "./kimi-gateway";

export function createServerLlmDecider(apiKey: string, provider: ModelProvider = 'kimi'): BatchDecider {
  let usage = { inputTokens: 0, outputTokens: 0 };
  return {
    async decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]> {
      const result = await handleDecide({
        contexts: contexts.map(buildDecisionRequestContext),
        model: provider,
      }, apiKey, provider);
      if (result.status !== 200) {
        const detail = result.body as { error?: string };
        throw new Error(detail?.error ?? `Kimi 决策失败（${result.status}）`);
      }
      const body = result.body as { decisions?: (Decision | null)[]; usage?: typeof usage };
      if (!Array.isArray(body.decisions) || body.decisions.length !== contexts.length || body.decisions.some((decision) => !decision)) {
        throw new Error("Kimi 没有为全部关键决策上下文返回合法决策");
      }
      usage = body.usage ?? usage;
      return body.decisions;
    },
    takeUsage() {
      const result = usage;
      usage = { inputTokens: 0, outputTokens: 0 };
      return result;
    },
  };
}
