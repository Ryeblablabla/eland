import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildDecisionRequestState } from "../src/game/eland/deepseek-decider";
import { DEFAULT_MODEL_PROVIDER, normalizeModelProvider, type ModelProvider } from "../src/game/llm";
import type { BatchDecider, Decision, DecisionContext } from "../src/game/eland/simulation";
import { handleDecide } from "./deepseek-decide";

function keyFromEnvFile(text: string): string {
  const line = text.split("\n").find((item) => item.trim().startsWith("DEEPSEEK_API_KEY="));
  return line ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : "";
}

export async function loadDeepSeekKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const envPath = process.env.THREEBODY_ENV_FILE
    ? path.resolve(process.env.THREEBODY_ENV_FILE)
    : path.resolve(process.cwd(), "../demo/.env.local");
  try {
    return keyFromEnvFile(await readFile(envPath, "utf8"));
  } catch {
    return "";
  }
}

export function createServerLlmDecider(apiKey: string, requestedProvider: ModelProvider = DEFAULT_MODEL_PROVIDER): BatchDecider {
  const provider = normalizeModelProvider(requestedProvider);
  return {
    async decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]> {
      const result = await handleDecide({
        contexts: contexts.map((context) => ({
          agentId: context.agent.id,
          state: buildDecisionRequestState(context.state),
        })),
        model: provider,
      }, apiKey, provider);
      if (result.status !== 200) {
        const detail = result.body as { error?: string };
        throw new Error(detail?.error ?? `DeepSeek 决策失败（${result.status}）`);
      }
      const body = result.body as { decisions?: (Decision | null)[] };
      if (!Array.isArray(body.decisions)) throw new Error("DeepSeek 决策返回格式异常");
      return body.decisions;
    },
  };
}

export function createServerDeepSeekDecider(apiKey: string): BatchDecider {
  return createServerLlmDecider(apiKey, "deepseek");
}
