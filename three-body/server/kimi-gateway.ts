import type { DecisionRequestContext } from '../src/game/eland/kimi-decider';
import type { Decision, TokenUsage } from '../src/game/eland/simulation';
import { DEFAULT_MODEL_PROVIDER, normalizeModelProvider, type ModelProvider } from '../src/game/llm';

const DEFAULT_MODEL_CONFIG = { url: 'https://api.kimi.com/coding/v1/chat/completions', model: 'kimi-for-coding' } as const;
const MAX_AGENTS = 12;

export function modelConfiguration(provider: ModelProvider): { url: string; model: string } {
  void provider;
  return {
    url: process.env.KIMI_API_URL?.trim() || DEFAULT_MODEL_CONFIG.url,
    model: process.env.KIMI_MODEL?.trim() || DEFAULT_MODEL_CONFIG.model,
  };
}

const SYSTEM_PROMPT = [
  '你是物质像素世界中的一个普通人。你只知道输入里的身体、状态、私有背包、当前意图、眼前人物、物质和行动选项。',
  '吃、喝等生存反射和既有意图的日常执行由规则引擎负责。你只选择重要的战略或社会意图，不要输出 continue。',
  '如果行动选项只有同一请求的 accept 与 reject，你必须依据关系、记忆、风险和自身倾向选择其中一个，不能 idle。',
  '如果选择 social 选项，必须增加 utterance，用第一人称写一句实际会说的话；这句话会进入双方记忆并影响以后意图。',
  '严格输出一个 JSON 对象，不输出解释。格式只能是以下之一：',
  '{"kind":"start","optionId":"输入中的行动选项id","reason":"简短理由","utterance":"仅社会意图需要的实际话语"}',
  '{"kind":"suspend|resume|abandon","intentId":"输入中的意图id","reason":"简短理由"}',
  '{"kind":"revise","intentId":"当前意图id","optionId":"输入中的行动选项id","reason":"简短理由","utterance":"仅社会意图需要的实际话语"}',
  '{"kind":"idle","reason":"简短理由"}',
  '只能引用输入 id，不得凭空生成物质、地点或能力。生存反射已经由引擎处理；请比较关系、记忆、承诺、风险和长期收益。',
].join('\n');

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseJson(content: string): unknown {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
}

async function requestKimiDecision(
  apiKey: string,
  provider: ModelProvider,
  context: DecisionRequestContext,
): Promise<{ content: string; usage: TokenUsage }> {
  const config = modelConfiguration(provider);
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 1,
      max_tokens: 10_000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(context) }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(`${provider} 返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const data = await response.json() as {
    choices?: { finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const reasoningLength = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0;
    throw new Error(`${provider} 没有返回最终决策文本（finish_reason=${String(choice?.finish_reason ?? 'unknown')}，reasoning_length=${reasoningLength}）`);
  }
  return {
    content,
    usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
  };
}

function normalizeDecision(context: DecisionRequestContext, input: unknown): Decision | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  const reason = text(raw.reason) || '根据眼前处境重新安排';
  const optionId = text(raw.optionId, 100);
  const intentId = text(raw.intentId, 100);
  const utterance = text(raw.utterance, 180);
  const option = context.options.find((item) => item.id === optionId);
  const optionExists = Boolean(option);
  const actualUtterance = option?.domain === 'social' ? utterance || reason : utterance;
  const activeIntentId = context.activeIntent?.id;
  const suspendedIntentIds = new Set(context.suspendedIntents.map((intent) => intent.id));
  if (kind === 'start') {
    if (optionExists) return { kind, optionId, reason, ...(actualUtterance ? { utterance: actualUtterance } : {}) };
    return null;
  }
  if (kind === 'revise' && intentId === activeIntentId && optionExists) return { kind, intentId, optionId, reason, ...(actualUtterance ? { utterance: actualUtterance } : {}) };
  if (kind === 'suspend' && intentId === activeIntentId) return { kind, intentId, reason };
  if (kind === 'resume' && suspendedIntentIds.has(intentId)) return { kind, intentId, reason };
  if (kind === 'abandon' && intentId === activeIntentId) return { kind, intentId, reason };
  if (kind === 'idle') return { kind, reason };
  return null;
}

async function decideOne(context: DecisionRequestContext, apiKey: string, provider: ModelProvider): Promise<{ decision: Decision | null; usage: TokenUsage }> {
  const completion = await requestKimiDecision(apiKey, provider, context);
  let parsed: unknown;
  try {
    parsed = parseJson(completion.content);
  } catch {
    throw new Error(`Kimi 返回的关键决策不是 JSON：${completion.content.trim().slice(0, 240)}`);
  }
  const decision = normalizeDecision(context, parsed);
  if (!decision) throw new Error(`Kimi 返回了不在可选行动中的决策：${completion.content.trim().slice(0, 240)}`);
  return { decision, usage: completion.usage };
}

function isContext(value: unknown): value is DecisionRequestContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as DecisionRequestContext;
  return Boolean(context.person?.id && Array.isArray(context.options) && Array.isArray(context.visibleDrops));
}

export async function handleDecide(payload: unknown, apiKey: string, requestedProvider: ModelProvider = DEFAULT_MODEL_PROVIDER): Promise<{ status: number; body: unknown }> {
  const provider = normalizeModelProvider(requestedProvider);
  if (!apiKey) return { status: 500, body: { error: '服务端未配置 KIMI_API_KEY' } };
  const input = payload as { contexts?: unknown[] };
  const contexts = Array.isArray(input?.contexts) ? input.contexts.filter(isContext).slice(0, MAX_AGENTS) : [];
  if (!contexts.length) return { status: 400, body: { error: '缺少合法的月度决策上下文' } };
  const results = [];
  for (let index = 0; index < contexts.length; index += 3) {
    results.push(...await Promise.all(contexts.slice(index, index + 3).map((context) => decideOne(context, apiKey, provider))));
  }
  const usage = results.reduce<TokenUsage>((sum, item) => ({
    inputTokens: sum.inputTokens + item.usage.inputTokens,
    outputTokens: sum.outputTokens + item.usage.outputTokens,
  }), { inputTokens: 0, outputTokens: 0 });
  const decisions = results.map((item) => item.decision);
  return { status: 200, body: { provider, model: modelConfiguration(provider).model, decided: decisions.filter(Boolean).length, total: decisions.length, decisions, usage } };
}
