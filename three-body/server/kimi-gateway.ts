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
  'activePressures 是当前状态正在造成的真实后果；材料 properties 是可观察或已知的同类物质性质，不代表你已经知道隐藏配方。危险状态加重时，应比较能够改变长期暴露的材料试验、建造、移动与合作机会，而不是只重复囤积已经充足的物资。',
  '吃、喝等生存反射和既有意图的日常执行由规则引擎负责。你只选择重要的战略或社会意图，不要输出 continue。',
  '优先处理没有持续目标的人，以及停滞但尚未完成的生产状态目标。普通寒暄、重复邀请和重复提议应低于采集、制作、建造、储藏、试验与履约；近期已经发生过的同类社交不要再次发起。',
  'activeIntent.stateGoalUntilMonth 表示该生产状态需要维持到的复核月份。目标暂时达成时规则引擎会维护它；除非出现紧急危险、履约义务或明显更高价值的机会，不要仅因本月没有新动作而改换目标。',
  '输入中的 options 都已通过引擎的身体、物质、距离、关系事实与权利前提检查；它们是当下可以尝试的可行意图，不是引擎建议。是否愿意做，应由你结合 drives、记忆、关系和风险决定。',
  'position、visiblePeople 和 visibleDrops 中的 z 是双脚或物品所在高度；同一 cellId 但 z 不同不等于近身。建造选项是不同的真实空气体素连接位置，你可以依据“落地、上方、侧面、头顶”等摘要选择空间意图，物理可行性和效果仍由引擎结算。',
  '如果行动选项是同一提议的 accept 与 reject，你必须依据关系、记忆、风险、可履行性和自身倾向选择其中一个，不能 idle。',
  '共同体中的 decision-rule 是成员已接受的选择方法，mandate 是按该方法授予具体人物、具体物质和期限的协调职责；它们不会让组织自动行动，也不转移私人背包。是否提议、接受、交付或分配，仍是每个人自己的决定。',
  '如果所选选项 requiresFollowUp=true，它是一项对话决策：必须增加 utterance，用第一人称写一句实际会说的话，并同时从 followUpOptions 选择 followUpOptionId，表示说完后自己真正要执行的行动。对话与后续行动属于同一个意图。',
  '对话选项若包含 communicatesFactId，表示这次话语会传递自己已经拥有、且有来源的那项认识；utterance 必须忠实表达选项摘要中的认识。听者只会把它当作你的主张，不会因听见一次就自动核验为真。',
  '此时 utterance 必须与 followUpOptionId 一致，清楚表达自己接下来准备做什么；不要只说空泛的关心、讨论或计划。',
  'followUpOptionId 只能引用 followUpOptions 中的 id。不得把自然语言当成已经完成的行动，也不得选择另一个 communicate 作为后续行动。',
  '严格输出一个 JSON 对象，不输出解释。格式只能是以下之一：',
  '{"kind":"start","optionId":"输入中的行动选项id","followUpOptionId":"requiresFollowUp=true 时必填","reason":"简短理由","utterance":"仅社会意图需要的实际话语"}',
  '{"kind":"suspend|resume|abandon","intentId":"输入中的意图id","reason":"简短理由"}',
  '{"kind":"revise","intentId":"当前意图id","optionId":"输入中的行动选项id","followUpOptionId":"requiresFollowUp=true 时必填","reason":"简短理由","utterance":"仅社会意图需要的实际话语"}',
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
  correction?: { invalidContent: string; problem: string },
  conciseRetry = false,
): Promise<{ content: string; usage: TokenUsage }> {
  const config = modelConfiguration(provider);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(context) }];
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    {
      role: 'user',
      content: [
        `上一个决策无效：${correction.problem}。请重新输出合法 JSON。`,
        `合法 optionId 只有：${context.options.map((option) => option.id).join('、') || '无'}`,
        `合法 followUpOptionId 只有：${context.followUpOptions.map((option) => option.id).join('、') || '无'}`,
        ...(context.activeIntent ? [`当前 intentId 是：${context.activeIntent.id}`] : []),
      ].join('\n'),
    },
  );
  if (conciseRetry) messages.push({
    role: 'user',
    content: '上一轮内部推理耗尽额度且没有最终 JSON。不要展开长推理；直接比较合法选项并在 300 字以内输出一个最终 JSON 对象。',
  });
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 1,
      max_tokens: 10_000,
      response_format: { type: 'json_object' },
      messages,
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
  const followUpOptionId = text(raw.followUpOptionId, 100);
  const intentId = text(raw.intentId, 100);
  const utterance = text(raw.utterance, 180);
  const option = context.options.find((item) => item.id === optionId);
  const optionExists = Boolean(option);
  const validFollowUp = context.followUpOptions.some((item) => item.id === followUpOptionId);
  if (option?.requiresFollowUp && !validFollowUp) return null;
  const actualUtterance = option?.requiresFollowUp ? utterance || reason : utterance;
  const activeIntentId = context.activeIntent?.id;
  const suspendedIntentIds = new Set(context.suspendedIntents.map((intent) => intent.id));
  if (kind === 'start') {
    if (optionExists) return { kind, optionId, ...(option?.requiresFollowUp ? { followUpOptionId } : {}), reason, ...(actualUtterance ? { utterance: actualUtterance } : {}) };
    return null;
  }
  if (kind === 'revise' && intentId === activeIntentId && optionExists) return { kind, intentId, optionId, ...(option?.requiresFollowUp ? { followUpOptionId } : {}), reason, ...(actualUtterance ? { utterance: actualUtterance } : {}) };
  if (kind === 'suspend' && intentId === activeIntentId) return { kind, intentId, reason };
  if (kind === 'resume' && suspendedIntentIds.has(intentId)) return { kind, intentId, reason };
  if (kind === 'abandon' && intentId === activeIntentId) return { kind, intentId, reason };
  if (kind === 'idle') return { kind, reason };
  return null;
}

function fallbackDecision(context: DecisionRequestContext): Decision {
  const option = context.options[0];
  const followUp = option?.requiresFollowUp ? context.followUpOptions[0] : undefined;
  const canUseOption = Boolean(option && (!option.requiresFollowUp || followUp));
  const requiredAction = Boolean(option && /^(accept|reject)-|^(settle-exchange|fulfill-assist|meet-to-assist|join-water-assist|rejoin-companion|rejoin-collective|contribute-mandate|distribute-mandate|use-permission):/.test(option.id));
  const optionFields = option && canUseOption ? {
    optionId: option.id,
    ...(option.requiresFollowUp && followUp ? { followUpOptionId: followUp.id } : {}),
  } : null;
  if (context.activeIntent && requiredAction && optionFields) {
    return { kind: 'revise', intentId: context.activeIntent.id, ...optionFields, reason: '模型连续引用非法选项，改用引擎提供的必须回应或履约选项' };
  }
  if (context.activeIntent) return { kind: 'idle', reason: '模型连续引用非法选项，保留并继续已有意图' };
  if (optionFields) return { kind: 'start', ...optionFields, reason: '模型连续引用非法选项，改用排序后的首个合法状态目标' };
  return { kind: 'idle', reason: '模型连续引用非法选项，当前没有可执行的合法目标' };
}

async function decideOne(context: DecisionRequestContext, apiKey: string, provider: ModelProvider): Promise<{ decision: Decision | null; usage: TokenUsage }> {
  let correction: { invalidContent: string; problem: string } | undefined;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let conciseRetry = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let completion: Awaited<ReturnType<typeof requestKimiDecision>>;
    try {
      completion = await requestKimiDecision(apiKey, provider, context, correction, conciseRetry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = message.includes('finish_reason=length') || message.toLowerCase().includes('timeout') || message.toLowerCase().includes('aborted');
      if (!conciseRetry && retryable) {
        conciseRetry = true;
        continue;
      }
      throw error;
    }
    usage = {
      inputTokens: usage.inputTokens + completion.usage.inputTokens,
      outputTokens: usage.outputTokens + completion.usage.outputTokens,
    };
    let parsed: unknown;
    try {
      parsed = parseJson(completion.content);
    } catch {
      correction = { invalidContent: completion.content, problem: '不是 JSON 对象' };
      continue;
    }
    const decision = normalizeDecision(context, parsed);
    if (decision) return { decision, usage };
    correction = { invalidContent: completion.content, problem: '引用了不存在的 optionId / intentId，或对话选项缺少合法 followUpOptionId' };
  }
  return { decision: fallbackDecision(context), usage };
}

function isContext(value: unknown): value is DecisionRequestContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as DecisionRequestContext;
  return Boolean(context.person?.id && Array.isArray(context.options) && Array.isArray(context.followUpOptions) && Array.isArray(context.visibleDrops));
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
