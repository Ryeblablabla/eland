import type { DecisionRequestContext } from '../src/game/eland/kimi-decider';
import type { Decision, TokenUsage } from '../src/game/eland/simulation';
import { loadServerEnvValue } from './env';
import { ModelRequestError, requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ResolvedModelEndpoint } from './model-config';

const MAX_AGENTS = 12;
const REQUIRED_RESPONSE = /^(?:(?:accept|reject)-(?:assist|companion|exchange|reproduce|collective|membership|permission|decision-rule|mandate):|respond-conversation:)/;
const FULFILLMENT = /^(settle-exchange|fulfill-assist|meet-to-assist|join-water-assist|contribute-mandate|distribute-mandate|use-permission|reproduce):/;

const SYSTEM_PROMPT = [
  '你是物质像素世界中的一个普通人。你只知道输入里的身体、状态、私有背包、当前意图、眼前人物、物质和行动选项。',
  'activePressures 是当前状态正在造成的真实后果；材料 properties 是可观察或已知的同类物质性质，不代表你已经知道隐藏配方。危险状态加重时，应比较能够改变长期暴露的材料试验、建造、移动与合作机会，而不是只重复囤积已经充足的物资。',
  '吃、喝等生存反射和既有意图的日常执行由规则引擎负责。你只选择重要的战略或社会意图，不要输出 continue。',
  '优先处理没有持续目标的人，以及停滞但尚未完成的生产状态目标。普通寒暄、重复邀请和重复提议通常应低于采集、制作、建造、储藏、试验与履约。',
  'activeIntent.stateGoalUntilMonth 表示该生产状态需要维持到的复核月份。目标暂时达成时规则引擎会维护它；除非出现紧急危险、履约义务或明显更高价值的机会，不要仅因本月没有新动作而改换目标。',
  '输入中的 options 都已通过引擎的身体、物质、距离、关系事实与权利前提检查；它们是当下可以尝试的可行意图，不是引擎建议。是否愿意做，应由你结合 HEXACO personality、motiveSensitivity、记忆、关系和风险决定。',
  'person.cognition 是规则引擎从本人可感知压力、有效人格、结构化亲历记忆和个人行动结果后验生成的只读因果 BDI 投影。needs 表示此刻欲望强度，outcomeBeliefs 表示本人过去经验形成的不确定先验，optionAppraisals 用于解释各合法候选如何回应这些需要。',
  'cognition 只帮助比较输入中已经存在的合法 options：不得把它当成新世界事实、隐藏知识或已发生结果，也不得据此创造候选、跳过必须回应与履约、绕过物理或领域合法性。',
  'person.description 只是档案原型与外貌线索，不是人格、技能、知识或历史事实；与结构化 personality 或 soul 冲突时以后两者为准。',
  'option.socialRepetition 若存在，是从本人仍保留的沟通记忆计算出的软成本，不是合法性门禁；缺省表示该选项不是可选社交发起。负分表示本人记得曾向同一受众谈过同一语义主题，而当前没有新的事实依据；上次未回应、拒绝、保留或违约时成本更高。',
  'socialRepetition.hasNewEvidence=true 表示同一主题出现了本人可追溯的新事实，可以重新权衡。与求助、照护或困境直接相关的显著身体危险也可能抵消旧话题成本；无关的危险不能抬高交换、生殖、共同体邀请或预言。',
  '必须回应和履约不携带 socialRepetition，等价于重复成本为 0。不要把 socialRepetition 当成禁止选择：有相关新证据、相关紧迫压力或更高总体价值时仍可重提；没有这些理由时应尊重负分并优先做更有价值的事。',
  'position、visiblePeople 和 visibleDrops 中的 z 是双脚或物品所在高度；同一 cellId 但 z 不同不等于近身。建造选项是不同的真实空气体素连接位置，你可以依据“落地、上方、侧面、头顶”等摘要选择空间意图，物理可行性和效果仍由引擎结算。',
  '如果行动选项是同一提议的 accept 与 reject，你必须依据关系、记忆、风险、可履行性和自身倾向选择其中一个，不能 idle。',
  '共同体中的 decision-rule 是成员已接受的选择方法，mandate 是按该方法授予具体人物、具体物质和期限的协调职责；它们不会让组织自动行动，也不转移私人背包。是否提议、接受、交付或分配，仍是每个人自己的决定。',
  '选项含 communicationKind 时必须增加 utterance，用第一人称自主写一句实际会说的话。option.summary 只是规划标签，不是规则台词，不得照抄；以 option.speechAct 的结构化话题、提议、引用与立场为表达边界。',
  'person.soul 是由长期人格确定性投影出的稳定主观视角，可以参与当前合法 option 的自主权衡与 utterance；从 sceneFacets 中只激活与当前候选和处境最接近的一个侧面，按 styleMatrix 表达，不要把全部人格平均进一句话。Soul 不创造候选、事实、记忆或需要，也不得绕过必须回应、履约和物理合法性。',
  'utterance 还要服从人物的年龄与 communication 能力；孩子或表达能力有限的人应说得更短、更具体，不能照抄 Soul 里的成年书面句式。',
  'utterance 的语气、直接程度和用词应体现有效 HEXACO、motiveSensitivity、听者关系、身体处境与最相关的有来源记忆；这些上下文只能改变表达风格，不能增加新事实或承诺。',
  '如果所选选项 requiresFollowUp=true，它是一项生活对话决策：还必须从 followUpOptions 选择 followUpOptionId，表示说完后自己真正要执行的行动。对话与后续行动属于同一个意图。',
  '对话选项若包含 communicatesFactId，表示这次话语会传递自己已经拥有、且有来源的那项认识；utterance 必须忠实表达 person.knowledge 中同 id 的认识。听者只会把它当作你的主张，不会因听见一次就自动核验为真。',
  '此时 utterance 必须与 followUpOptionId 一致，清楚表达自己接下来准备做什么；不要只说空泛的关心、讨论或计划。',
  'followUpOptionId 只能引用 followUpOptions 中的 id。不得把自然语言当成已经完成的行动，也不得选择另一个 communicate 作为后续行动。',
  '严格输出一个 JSON 对象，不输出解释。格式只能是以下之一：',
  '{"kind":"start","optionId":"输入中的行动选项id","followUpOptionId":"requiresFollowUp=true 时必填","reason":"简短理由","utterance":"仅社会意图需要的实际话语"}',
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

function decisionTimeout(endpoint: ResolvedModelEndpoint): number {
  const configured = Number(loadServerEnvValue('MODEL_DECISION_TIMEOUT_MS') || Math.min(endpoint.timeoutMs, 12_000));
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(30_000, configured)) : 12_000;
}

function decisionMaxOutputTokens(): number {
  const configured = Number(loadServerEnvValue('MODEL_DECISION_MAX_OUTPUT_TOKENS') || 600);
  return Number.isFinite(configured) ? Math.max(128, Math.min(2_000, Math.floor(configured))) : 600;
}

function isReasoningOnlyOpenAiChatResponse(error: unknown, endpoint: ResolvedModelEndpoint): boolean {
  if (endpoint.protocol !== 'openai-chat'
    || !(error instanceof ModelRequestError)
    || error.code !== 'invalid-response'
    || !error.message.includes('没有返回最终文本')) return false;
  return /finish_reason=(?:length|stop)\b/u.test(error.message)
    && /reasoning_length=[1-9]\d*/u.test(error.message);
}

async function requestModelDecision(
  endpoint: ResolvedModelEndpoint,
  context: DecisionRequestContext,
  correction?: { invalidContent: string; problem: string },
  conciseRetry = false,
): Promise<{ content: string; usage: TokenUsage }> {
  const messages: ModelMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(context) }];
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
    content: '上一轮只返回了内部推理，没有最终 JSON。不要展开长推理；直接比较合法选项并在 300 字以内输出一个最终 JSON 对象。',
  });
  const response = await requestModelText(endpoint, {
    messages,
    temperature: endpoint.temperature ?? 1,
    maxOutputTokens: decisionMaxOutputTokens(),
    jsonObject: true,
    timeoutMs: decisionTimeout(endpoint),
  });
  return { content: response.text, usage: response.usage };
}

function normalizeDecision(context: DecisionRequestContext, input: unknown): Decision | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const rawKind = text(raw.kind, 100);
  const reason = text(raw.reason) || '根据眼前处境重新安排';
  const optionId = text(raw.optionId, 100);
  const followUpOptionId = text(raw.followUpOptionId, 100);
  const intentId = text(raw.intentId, 100);
  const utterance = text(raw.utterance, 180);
  const option = context.options.find((item) => item.id === optionId);
  const requiredOptions = context.options.filter((item) => REQUIRED_RESPONSE.test(item.id));
  const fulfillmentOptions = context.options.filter((item) => FULFILLMENT.test(item.id));
  const optionAllowed = Boolean(option)
    && (!requiredOptions.length || requiredOptions.some((item) => item.id === optionId))
    && (requiredOptions.length > 0 || !fulfillmentOptions.length || fulfillmentOptions.some((item) => item.id === optionId));
  const validFollowUp = context.followUpOptions.some((item) => item.id === followUpOptionId);
  if (option?.requiresFollowUp && !validFollowUp) return null;
  // 选择仍可在缺少 utterance 时成立；真正执行说话时，台词旁车会单独
  // 请求表达模型。不要把用于解释选择的 reason 冒充人物实际说的话。
  const actualUtterance = utterance;
  const activeIntentId = context.activeIntent?.id;
  // 部分本地模型会把被选中的 optionId 放进 kind。只有它与当前合法
  // optionId 完全相等时才做无歧义归一化，不能由任意自然语言推断行动。
  const kind = rawKind === optionId && optionAllowed
    ? activeIntentId ? 'revise' : 'start'
    : rawKind;
  const normalizedIntentId = kind === 'revise' && !intentId ? activeIntentId : intentId;
  if (kind === 'start' && !activeIntentId && optionAllowed) {
    return { kind, optionId, ...(option?.requiresFollowUp ? { followUpOptionId } : {}), reason, ...(actualUtterance ? { utterance: actualUtterance } : {}) };
  }
  if (kind === 'revise' && normalizedIntentId === activeIntentId && optionAllowed && activeIntentId) {
    return { kind, intentId: activeIntentId, optionId, ...(option?.requiresFollowUp ? { followUpOptionId } : {}), reason, ...(actualUtterance ? { utterance: actualUtterance } : {}) };
  }
  if (kind === 'idle' && !requiredOptions.length && !fulfillmentOptions.length) return { kind, reason };
  return null;
}

async function decideOne(context: DecisionRequestContext, endpoint: ResolvedModelEndpoint): Promise<{ decision: Decision | null; usage: TokenUsage }> {
  let correction: { invalidContent: string; problem: string } | undefined;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let conciseRetry = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let completion: Awaited<ReturnType<typeof requestModelDecision>>;
    try {
      completion = await requestModelDecision(endpoint, context, correction, conciseRetry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isReasoningOnlyOpenAiChatResponse(error, endpoint)
        || message.includes('finish_reason=length')
        || message.toLowerCase().includes('timeout')
        || message.toLowerCase().includes('aborted');
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
    if (loadServerEnvValue('MODEL_DECISION_DEBUG') === '1') {
      console.warn(`模型端点 ${endpoint.id} 的决策未通过结构校验：${completion.content.slice(0, 500)}`);
    }
    correction = { invalidContent: completion.content, problem: '没有选择当前意图允许的合法 optionId，必须回应时选择了 idle，或对话缺少合法 followUpOptionId' };
  }
  return { decision: null, usage };
}

function isContext(value: unknown): value is DecisionRequestContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as DecisionRequestContext;
  return Boolean(context.person?.id && Array.isArray(context.options) && Array.isArray(context.followUpOptions) && Array.isArray(context.visibleDrops));
}

export async function handleDecide(payload: unknown, requestedEndpoint?: string): Promise<{ status: number; body: unknown }> {
  let endpoint: ResolvedModelEndpoint;
  try {
    endpoint = resolveModelEndpoint('decision', requestedEndpoint);
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  if (endpoint.auth !== 'none' && !endpoint.apiKey) {
    return { status: 500, body: { error: `模型端点 ${endpoint.id} 缺少 ${endpoint.apiKeyEnv ?? 'API Key'}` } };
  }
  const input = payload as { contexts?: unknown[] };
  const contexts = Array.isArray(input?.contexts) ? input.contexts.filter(isContext).slice(0, MAX_AGENTS) : [];
  if (!contexts.length) return { status: 400, body: { error: '缺少合法的月度决策上下文' } };
  const results = [];
  for (let index = 0; index < contexts.length; index += 3) {
    results.push(...await Promise.all(contexts.slice(index, index + 3).map((context) => decideOne(context, endpoint))));
  }
  const usage = results.reduce<TokenUsage>((sum, item) => ({
    inputTokens: sum.inputTokens + item.usage.inputTokens,
    outputTokens: sum.outputTokens + item.usage.outputTokens,
  }), { inputTokens: 0, outputTokens: 0 });
  const decisions = results.map((item) => item.decision);
  return {
    status: 200,
    body: {
      provider: endpoint.id,
      endpointId: endpoint.id,
      protocol: endpoint.protocol,
      model: endpoint.model,
      decided: decisions.filter(Boolean).length,
      total: decisions.length,
      decisions,
      usage,
    },
  };
}
