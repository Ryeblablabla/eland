import type { DecisionRequestContext } from '../src/game/eland/deepseek-decider';
import type { Decision, TokenUsage } from '../src/game/eland/simulation';
import { DEFAULT_MODEL_PROVIDER, normalizeModelProvider, type ModelProvider } from '../src/game/llm';

const MODEL_CONFIG = {
  deepseek: { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  kimi: { url: 'https://api.kimi.com/coding/v1/chat/completions', model: 'kimi-k2-0711-preview' },
} as const;
const MAX_AGENTS = 12;

const SYSTEM_PROMPT = [
  '你是像素世界中的一个普通人。你只知道输入里的身体、记忆、当前计划、眼前人物、物质和可供性。',
  '这次是一次月度关键决策；日常执行会由规则引擎在后续月份持续推进，不要把长期行动压缩成一个月。',
  '严格输出一个 JSON 对象，不输出解释。格式只能是以下之一：',
  '{"kind":"start","affordanceId":"输入中的可供性id","reason":"简短理由"}',
  '{"kind":"start","exploration":{"direction":"n|e|s|w","distanceBand":"near|far"},"reason":"简短理由"}',
  '{"kind":"continue|suspend|resume|abandon","planId":"输入中的计划id","reason":"简短理由"}',
  '{"kind":"revise","planId":"当前计划id","affordanceId":"输入中的可供性id","reason":"简短理由"}',
  '{"kind":"idle","reason":"简短理由"}',
  '只能引用输入 id，不得凭空生成物质、地点或能力。先照顾迫切的生理和安全需要。',
].join('\n');

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseJson(content: string): unknown {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
}

function normalizeDecision(context: DecisionRequestContext, input: unknown): Decision | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  const reason = text(raw.reason) || '根据眼前处境重新安排';
  const affordanceId = text(raw.affordanceId, 100);
  const planId = text(raw.planId, 100);
  const affordanceExists = context.affordances.some((item) => item.id === affordanceId);
  const activePlanId = context.activePlan?.id;
  const suspendedPlanIds = new Set(context.suspendedPlans.map((plan) => plan.id));
  if (kind === 'start') {
    if (affordanceExists) return { kind, affordanceId, reason };
    const exploration = raw.exploration as Record<string, unknown> | undefined;
    const direction = exploration?.direction;
    const distanceBand = exploration?.distanceBand;
    if ((direction === 'n' || direction === 'e' || direction === 's' || direction === 'w') && (distanceBand === 'near' || distanceBand === 'far')) {
      return { kind, exploration: { direction, distanceBand }, reason };
    }
    return null;
  }
  if (kind === 'continue' && planId === activePlanId) return { kind, planId, reason };
  if (kind === 'revise' && planId === activePlanId && affordanceExists) return { kind, planId, affordanceId, reason };
  if (kind === 'suspend' && planId === activePlanId) return { kind, planId, reason };
  if (kind === 'resume' && suspendedPlanIds.has(planId)) return { kind, planId, reason };
  if (kind === 'abandon' && planId === activePlanId) return { kind, planId, reason };
  if (kind === 'idle') return { kind, reason };
  return null;
}

async function decideOne(context: DecisionRequestContext, apiKey: string, provider: ModelProvider): Promise<{ decision: Decision | null; usage: TokenUsage }> {
  try {
    const config = MODEL_CONFIG[provider];
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.55,
        max_tokens: 500,
        ...(provider === 'kimi' ? { thinking: { type: 'disabled' } } : { response_format: { type: 'json_object' } }),
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(context) }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return { decision: null, usage: { inputTokens: 0, outputTokens: 0 } };
    const data = await response.json() as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    return {
      decision: typeof content === 'string' ? normalizeDecision(context, parseJson(content)) : null,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  } catch {
    return { decision: null, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

function isContext(value: unknown): value is DecisionRequestContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as DecisionRequestContext;
  return Boolean(context.agent?.id && Array.isArray(context.affordances) && Array.isArray(context.visibleMatter));
}

export async function handleDecide(payload: unknown, apiKey: string, requestedProvider: ModelProvider = DEFAULT_MODEL_PROVIDER): Promise<{ status: number; body: unknown }> {
  const provider = normalizeModelProvider(requestedProvider);
  if (!apiKey) return { status: 500, body: { error: `服务端未配置 ${provider === 'kimi' ? 'KIMI_API_KEY' : 'DEEPSEEK_API_KEY'}` } };
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
  return { status: 200, body: { provider, model: MODEL_CONFIG[provider].model, decided: decisions.filter(Boolean).length, total: decisions.length, decisions, usage } };
}
