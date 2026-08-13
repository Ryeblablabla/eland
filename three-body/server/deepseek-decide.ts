// @ts-nocheck —— 移植自 ELAND demo/app/api/decide/route.ts，保持与上游一致。
import {
  buildDecisionContexts,
  formatTime,
  type Action,
  type Decision,
  type DecisionContext,
  type InteractionIntent,
  type SimulationState,
} from "../src/game/eland/simulation";
import { DEFAULT_MODEL_PROVIDER, normalizeModelProvider, type ModelProvider } from "../src/game/llm";

const MODEL_CONFIG = {
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    maxTokens: 10_000,
  },
  kimi: {
    url: "https://api.kimi.com/coding/v1/chat/completions",
    model: "kimi-k2-0711-preview",
    maxTokens: 10_000,
  },
} as const;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REQUEST_BYTES = 2_000_000;
const MAX_AGENTS = 12;

export interface YearSummaryInput {
  year: number;
  climate: { epoch: string; kind: string; severity: number };
  people: { before: number; after: number; active: number; dehydrated: number; dead: number; changes: string[] };
  tribe: { stageBefore: string; stageAfter: string; integrityBefore: number; integrityAfter: number; changes: string[] };
  facts: string[];
}

const SYSTEM_PROMPT = [
  "你在社会模拟世界 Eland 里扮演一个普通人。你只知道你当前所在地点能看到的人和事，对其他地方一无所知。",
  "根据处境做出一个行动选择，严格输出 JSON，不要输出任何其他文字。",
  "",
  "输出格式：",
  "{",
  '  "action": 以下二选一：',
  '    {"type": "move", "to": "<相邻开放地点的id>"}  —— 移动到相邻地点；',
  '    {"type": "interact", "with": {"kind": "matter"|"agent"|"space", "id": "<物质id 或 人物id 或 当前地点id>"}, "content": "<动作描述，18字以内>", "intent": <结构化改变意图>}；',
  '  "intent" 必须是以下之一：',
  '    {"mode":"take","matterId":"<本地物质id>","quantity":1}',
  '    {"mode":"give","matterId":"<携带物质id>","toAgentId":"<身边人物id>","quantity":1}',
  '    {"mode":"shape","inputIds":["<携带物质id>"],"desiredKind":"<英文短id>","desiredName":"<新物品名>","desiredTraits":["flat"|"sharp"|"building"|"recordable"|"wearable"|"container"|"wheel"|"supportive"|"barrier"]}',
  '    {"mode":"assemble","inputIds":["<携带物质id>"],"siteId":"<当前地点id>","desiredKind":"<英文短id>","desiredName":"<结构名>","purpose":"shelter"|"instrument"|"platform","arrangement":{"support":0到100,"cover":0到100,"boundary":0到100,"opening":0到100}}',
  '    {"mode":"work","siteId":"<当前地点id>","change":"compact"|"clear"|"dig"|"irrigate"|"cultivate"}',
  '    {"mode":"ignite","fuelId":"<本地燃料id>"} —— 携带石制切割工具时可尝试点燃燃料；',
  '    {"mode":"cook","foodId":"<携带的生食id>","fireId":"<本地火种id>"} —— 用同地火种处理食物；',
  '    {"mode":"eat","foodId":"<携带食物id>"} —— 食用持有的食物恢复身体；',
  '    {"mode":"hunt","animalId":"<本地动物id>"} —— 携带工具时尝试捕猎；',
  '    {"mode":"tend","animalId":"<本地动物id>","offeringId":"<携带食物id>"} —— 用一份食物接近和照料动物；',
  '    {"mode":"store","matterId":"<携带食物id>","containerId":"<身边容器id>"}',
  '    {"mode":"perform","form":"image"|"music"|"dance"|"game","partnerId":"<可选：身边人物id>","mediumId":"<描绘时使用的可刻写载体id>"}',
  '    {"mode":"claim","subjectId":"<当前地点或本地物质id>","claim":"<占用理由>"}',
  '    {"mode":"trade","offeredMatterId":"<携带物id>","requestedMatterId":"<对方携带物id>","withAgentId":"<身边人物id>"}',
  '    {"mode":"relocate","to":"<当前地点id>"} —— 已离开旧生活中心时可迁居；',
  '    {"mode":"drink","sourceId":"<本地水源id>"}',
  '    {"mode":"rest","siteId":"<当前地点id>"}',
  '    {"mode":"warm","fireId":"<本地火种id>"}',
  '    {"mode":"bond","toAgentId":"<身边人物id>","gesture":"comfort"|"court"|"care"|"intimate","barrierId":"<intimate 时必须携带的柔性隔离物id>"}',
  '    {"mode":"inspect-body","targetAgentId":"<身边人物id>"} —— 比较眼前人物的疼痛、体温和伤口等身体状态；',
  '    {"mode":"apply-material","matterId":"<携带或本地物质id>","targetAgentId":"<身边人物id>"} —— 尝试把真实材料用于对方身体，具体效果由材料性质和身体状态决定；',
  '    {"mode":"treat","toAgentId":"<身边患病人物id>"} —— 利用同地食物、水或住所改善病情；',
  '    {"mode":"fit-support","matterId":"<携带的身体支撑物id>","targetAgentId":"<身边伤后移动受限人物id>"} —— 把已制成的支撑物适配给伤后人物；',
  '    {"mode":"bury","remainsId":"<本地遗体id>","siteId":"<当前地点id>"} —— 安置遗体并留下纪念标记；',
  '    {"mode":"adapt","change":"dehydrate"} —— 你在乱纪元承受高暴露时可以脱水停止活动；',
  '    {"mode":"adapt","change":"soak","targetAgentId":"<身边已脱水的人物id>"} —— 恒纪元可浸泡唤醒同伴；',
  '    {"mode":"observe","aspect":"sky"|"climate"|"quantity","matterId":"<可选：本地物质id>"} —— 留下一次独立局部观测；',
  '    {"mode":"record","mediumId":"<携带或本地可刻写载体id>","recordKind":"tally"|"chronicle"|"calendar"|"notation"|"model"|"map"|"measure"|"account"|"contract"|"image","sourceEventIds":["<你亲历的事实id>"],"note":"<记录内容>"} —— 把经历外化为可复查记录；',
  '    {"mode":"predict","instrumentId":"<可选：本地模型id>","predictedEpoch":"stable"|"chaotic","predictedClimate":"temperate"|"cold"|"heat"|"fire","dueTick":<未来1至12年>,"sourceEventIds":["<记录或亲历事实id>"]} —— 提出等待未来检验的预测；',
  '    {"mode":"express","toAgentId":"<身边人物id>","speech":"<说的话>","claim":"<可选：你要传授的认识>","sourceEventIds":["<可选：该认识已有的事实来源id>"]}',
  '  "needLevel": "physiological"|"safety"|"belonging"|"esteem"|"selfActualization",',
  '  "needFocus": "<当前主导需要，18字以内>",',
  '  "perception": "<你对眼前现实的认识，30字以内>",',
  '  "choice": "<你因此做出的选择，18字以内>",',
  '  "memoryConsolidation": <仅当记忆片段数超过容量时输出：{"summary":"<把将遗忘片段压缩成一段经验>","lessons":["<最多3条经验>"],"retainFragmentIds":["<想保留的真实片段id>"]}>',
  "}",
  "",
  "规则：目标和输入 id 只能从你看到或携带的数据里选；不能凭空生成物质；加工需要携带切割工具，建设需要刚性/建造材料；先回应当前最迫切的低层需求，低层需求缓解后才把精力投入更高层；你可以自行判断是否用脱水/浸泡应对气候，但这不是强制目标；像一个真实的人那样行事。",
  "时间尺度：一次决策代表这个人物这一年唯一一次被记录的关键行动；不要描述小时、季节轮次或琐碎日程。",
  "连续性：先检查你上一年选择了什么；如果你想理解纪元，可以逐年 observe，再自行决定是否制作载体、record、predict 或搭建模型；记录和预测都必须引用你实际经历或看到的来源。",
  "选择原则：五层需求只提供动机，眼前环境、能力和亲历成败决定实际手段。不要为了达成某个文明里程碑而行动；预测不是目标，也可能失败；不得假装知道未来。",
  "建设原则：聚落没有住所时，先把建材集中到输入给出的住所工地；已有工地就续建，不要在别处另开同类住所。健康稳定的幼儿由日常照看维持，只有身体指标出现实际缺口时，才把年度关键行动用于照料。",
  "记忆原则：你看不到世界完整历史，只能依据当前身体和环境、保留下来的情景记忆与旧经验摘要。记忆超出容量时必须压缩；retainFragmentIds 只能引用输入中的真实片段。推理能力越强，容量越大、摘要可保留的经验越多。",
  "说话方式：perception、choice 和动作描述都用简短、自然的第一人称中文，像人在心里想事情。说眼前具体看见什么、打算做什么；不要使用“事实支持”“继续影响世界”“物质转移”“转由持有”“身体物质”等系统或报告用语。",
].join("\n");

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function carriedMatter(ctx: DecisionContext) {
  return ctx.state.world.matter.filter(
    (item) => item.holder.kind === "agent" && item.holder.id === ctx.agent.id && item.quantity > 0 && item.kind !== "metabolized",
  );
}

function buildUserPayload(ctx: DecisionContext) {
  const { state, agent } = ctx;
  const here = state.world.space.locations.find((item) => item.id === agent.locationId);
  const reachable = state.world.space.locations.filter(
    (item) => here?.neighbors.includes(item.id) && item.open,
  );
  const memory = agent.mind.cognition.memory;
  const settlementShelter = state.world.matter.find((item) => item.holder.kind === "space" && item.kind === "house" && item.traits.includes("shelter") && item.construction?.complete);
  const shelterProject = state.world.matter
    .filter((item) => item.holder.kind === "space" && item.kind === "house" && item.construction && !item.construction.complete)
    .sort((first, second) => (second.construction?.progress ?? 0) - (first.construction?.progress ?? 0) || first.id.localeCompare(second.id))[0];
  const shelterSiteId = shelterProject?.holder.kind === "space" ? shelterProject.holder.id : "homes";
  const shelterSite = state.world.space.locations.find((item) => item.id === shelterSiteId);

  return {
    时间: formatTime(state.tick),
    你: {
      id: agent.id,
      名字: agent.name,
      人物档案: agent.profile.description,
      五层人格底色: agent.profile.personality,
      所在地点: here ? { id: here.id, 名字: here.name } : agent.locationId,
      能力: { 移动: agent.limbs.abilities.move, 交互: agent.limbs.abilities.interact, 加工: agent.limbs.abilities.craft, 建设: agent.limbs.abilities.build, 观察: agent.limbs.abilities.observe, 推理: agent.limbs.abilities.reason },
      上一年关键行动: agent.limbs.action,
      身体: agent.body,
      社会身份: { 尊重度: agent.standing.respect, 照护信任: agent.standing.careTrust ?? 0, 预言命中: agent.standing.correctPredictions, 预言失败: agent.standing.failedPredictions, 世代: agent.lineage.generation },
    },
    你的五层需求: { 当前主导层: agent.mind.needs.dominantLevel, 当前焦点: agent.mind.needs.focus, 强度: agent.mind.needs.intensity, 五层状态: agent.mind.needs.layers },
    当前纪元与气候: {
      纪元: state.civilization.epoch === "stable" ? "恒纪元" : "乱纪元",
      气候: state.civilization.climate,
      时间尺度: "一刻等于一年；这次只选择年度关键行动",
    },
    聚落住所状态: settlementShelter
      ? { 状态: "已有完整住所", 地点id: settlementShelter.holder.id, 名字: settlementShelter.name }
      : shelterProject
        ? { 状态: "应集中续建同一工地", 地点id: shelterSiteId, 地点名: shelterSite?.name, 结构名: shelterProject.name, 建设: shelterProject.construction }
        : { 状态: "尚无住所，应先在已清理的住处开工", 地点id: "homes", 地点名: shelterSite?.name },
    你可以移动到的相邻地点: reachable.map((item) => ({ id: item.id, 名字: item.name })),
    你在这里看到的物质: ctx.localMatter
      .filter((item) => item.quantity > 0)
      .map((item) => ({ id: item.id, 名字: item.name, 数量: item.quantity, 性质: item.traits, 关联人物id: item.personId })),
    你在这里看到的人: ctx.visibleAgents.map((other) => {
      const relation = agent.relations.find((item) => item.agentId === other.id);
      return { id: other.id, 名字: other.name, 身体状态: other.body.state, 病症: other.body.illness, 伤情: other.body.injury, 不可逆身体衰退: other.body.endOfLife, 妊娠: other.body.pregnancy, 自己愿意照料的子女数与已有出生数: other.body.familyPlanning, 精神状态: other.mind.affect.state, 心理负荷: other.mind.affect.strain, 年龄: other.body.ageYears, 性别: other.body.sex, 尊重度: other.standing.respect, 照护信任: other.standing.careTrust ?? 0, 你们的关系: relation ? `${relation.word}(强度${relation.strength})` : "陌生", 携带物: carriedMatter({ ...ctx, agent: other }).map((item) => ({ id: item.id, 名字: item.name, 性质: item.traits })) };
    }),
    你携带的物品: carriedMatter(ctx).map((item) => ({ id: item.id, 种类: item.kind, 名字: item.name, 数量: item.quantity, 性质: item.traits, 成分: item.composition })),
    当前地形: here?.terrain,
    这里正在形成的结构: state.world.matter
      .filter((item) => item.holder.kind === "space" && item.holder.id === agent.locationId && item.construction)
      .map((item) => ({ id: item.id, 名字: item.name, 性质: item.traits, 建设: item.construction })),
    这里可使用的完整仪器: state.world.matter
      .filter((item) => item.holder.kind === "space" && item.holder.id === agent.locationId && item.construction?.complete && item.traits.includes("instrument"))
      .map((item) => ({ id: item.id, 名字: item.name, 事实来源: item.sourceEventIds })),
    你的情景记忆片段: memory.episodic.map((fragment) => ({ id: fragment.id, 年份: fragment.tick, 记得的内容: fragment.summary, 鲜明度: fragment.salience, 成功: fragment.succeeded, 事实来源: fragment.sourceEventIds })),
    你对更早经历的压缩记忆: memory.summaries.map((summary) => ({ 年份范围: [summary.fromTick, summary.toTick], 概括: summary.summary, 留下的经验: summary.lessons, 尚能追溯的事实: summary.sourceEventIds })),
    记忆状态: { 容量: memory.capacity, 当前片段数: memory.episodic.length, 已遗忘片段数: memory.forgottenCount, 是否需要压缩: memory.episodic.length > memory.capacity },
    你从事实中形成的认识: agent.mind.cognition.knowledge.slice(-6),
    你的待检验猜想: agent.mind.cognition.hypotheses,
    你能读取的外部记录: state.world.matter
      .filter((item) => ((item.holder.kind === "agent" && item.holder.id === agent.id) || (item.holder.kind === "space" && item.holder.id === agent.locationId)) && item.records?.length)
      .map((item) => ({ 载体id: item.id, 名字: item.name, 记录: item.records })),
  };
}

function normalizeAction(ctx: DecisionContext, raw: unknown): Action | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { type?: unknown; to?: unknown; with?: unknown; content?: unknown; intent?: unknown };
  const { state, agent } = ctx;
  const here = state.world.space.locations.find((item) => item.id === agent.locationId);

  if (candidate.type === "move") {
    const wanted = clip(candidate.to, 40);
    const target = state.world.space.locations.find((item) => item.id === wanted || item.name === wanted);
    if (target && here?.neighbors.includes(target.id) && target.open) {
      return { type: "move", to: target.id };
    }
    return null;
  }

  if (candidate.type === "interact") {
    const ref = candidate.with as { kind?: unknown; id?: unknown } | undefined;
    const kind = ref?.kind;
    const rawId = clip(ref?.id, 40);
    const content = clip(candidate.content, 24) || "打个招呼";

    if (kind === "matter") {
      const matter = [...ctx.localMatter, ...carriedMatter(ctx)].find(
        (item) => item.quantity > 0 && (item.id === rawId || item.kind === rawId || item.name === rawId),
      );
      if (!matter) return null;
      const intent = normalizeIntent(ctx, candidate.intent, { kind: "matter", id: matter.id });
      return intent ? { type: "interact", with: { kind: "matter", id: matter.id }, content, intent } : null;
    }
    if (kind === "agent") {
      const other = rawId === agent.id ? agent : ctx.visibleAgents.find((item) => item.id === rawId || item.name === rawId);
      if (!other) return null;
      const intent = normalizeIntent(ctx, candidate.intent, { kind: "agent", id: other.id });
      return intent ? { type: "interact", with: { kind: "agent", id: other.id }, content, intent } : null;
    }
    if (kind === "space") {
      const intent = normalizeIntent(ctx, candidate.intent, { kind: "space", id: agent.locationId });
      return intent ? { type: "interact", with: { kind: "space", id: agent.locationId }, content, intent } : null;
    }
  }
  return null;
}

function normalizeIntent(
  ctx: DecisionContext,
  raw: unknown,
  target: { kind: "matter" | "agent" | "space"; id: string },
): InteractionIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const mode = value.mode;
  const held = carriedMatter(ctx);
  const heldIds = new Set(held.map((item) => item.id));
  const visibleIds = new Set(ctx.visibleAgents.map((item) => item.id));
  const accessibleMatter = [...ctx.localMatter, ...held];
  const accessibleMatterIds = new Set(accessibleMatter.map((item) => item.id));
  const inputIds = Array.isArray(value.inputIds) ? value.inputIds.map((item) => clip(item, 50)).filter((id) => heldIds.has(id)).slice(0, 4) : [];
  const quantity = Math.max(1, Math.min(3, Number(value.quantity) || 1));
  if (mode === "take" && target.kind === "matter") return { mode, matterId: target.id, quantity };
  if (mode === "give") {
    const matterId = clip(value.matterId, 50);
    const toAgentId = clip(value.toAgentId, 50);
    return heldIds.has(matterId) && visibleIds.has(toAgentId) ? { mode, matterId, toAgentId, quantity } : null;
  }
  if (mode === "shape" && inputIds.length) {
    const traits = Array.isArray(value.desiredTraits) ? value.desiredTraits.filter((item): item is "flat" | "sharp" | "building" | "recordable" | "instrument" | "wearable" | "container" | "wheel" | "supportive" | "barrier" => item === "flat" || item === "sharp" || item === "building" || item === "recordable" || item === "instrument" || item === "wearable" || item === "container" || item === "wheel" || item === "supportive" || item === "barrier") : [];
    return { mode, inputIds, desiredKind: clip(value.desiredKind, 30) || "crafted-object", desiredName: clip(value.desiredName, 28) || "新制物品", desiredTraits: traits };
  }
  if (mode === "assemble" && inputIds.length) {
    const purpose = value.purpose === "shelter" || value.purpose === "instrument" || value.purpose === "platform" ? value.purpose : "platform";
    const rawArrangement = value.arrangement && typeof value.arrangement === "object" ? value.arrangement as Record<string, unknown> : {};
    const part = (key: string, fallback: number) => Math.max(0, Math.min(100, Number(rawArrangement[key]) || fallback));
    return {
      mode,
      inputIds,
      siteId: ctx.agent.locationId,
      desiredKind: clip(value.desiredKind, 30) || "structure",
      desiredName: clip(value.desiredName, 28) || "未命名结构",
      purpose,
      arrangement: { support: part("support", 55), cover: part("cover", 30), boundary: part("boundary", 25), opening: part("opening", 70) },
    };
  }
  if (mode === "work") {
    const change = value.change;
    return change === "compact" || change === "clear" || change === "dig" || change === "irrigate" || change === "cultivate" ? { mode, siteId: ctx.agent.locationId, change } : null;
  }
  if (mode === "ignite") {
    const fuelId = clip(value.fuelId, 50) || target.id;
    const fuel = ctx.localMatter.find((item) => item.id === fuelId && item.traits.includes("fuel"));
    return fuel ? { mode, fuelId: fuel.id } : null;
  }
  if (mode === "cook") {
    const foodId = clip(value.foodId, 50);
    const fireId = clip(value.fireId, 50);
    const food = held.find((item) => item.id === foodId && item.traits.includes("edible") && !item.traits.includes("cooked"));
    const fire = ctx.localMatter.find((item) => item.id === fireId && item.traits.includes("burning"));
    return food && fire ? { mode, foodId: food.id, fireId: fire.id } : null;
  }
  if (mode === "eat") {
    const foodId = clip(value.foodId, 50) || target.id;
    const food = held.find((item) => item.id === foodId && item.traits.includes("edible"));
    return food ? { mode, foodId: food.id } : null;
  }
  if (mode === "hunt") {
    const animalId = clip(value.animalId, 50) || target.id;
    return ctx.localMatter.some((item) => item.id === animalId && item.traits.includes("animal")) ? { mode, animalId } : null;
  }
  if (mode === "tend") {
    const animalId = clip(value.animalId, 50) || target.id;
    const offeringId = clip(value.offeringId, 50);
    return ctx.localMatter.some((item) => item.id === animalId && item.traits.includes("animal")) && held.some((item) => item.id === offeringId && item.traits.includes("edible")) ? { mode, animalId, offeringId } : null;
  }
  if (mode === "store") {
    const matterId = clip(value.matterId, 50);
    const containerId = clip(value.containerId, 50);
    return held.some((item) => item.id === matterId && item.traits.includes("edible")) && accessibleMatter.some((item) => item.id === containerId && item.traits.includes("container")) ? { mode, matterId, containerId } : null;
  }
  if (mode === "perform") {
    const form = value.form;
    const partnerId = clip(value.partnerId, 50);
    const mediumId = clip(value.mediumId, 50);
    return form === "image" || form === "music" || form === "dance" || form === "game" ? { mode, form, ...(visibleIds.has(partnerId) ? { partnerId } : {}), ...(accessibleMatterIds.has(mediumId) ? { mediumId } : {}) } : null;
  }
  if (mode === "claim") {
    const subjectId = clip(value.subjectId, 50) || target.id;
    return subjectId === ctx.agent.locationId || ctx.localMatter.some((item) => item.id === subjectId) ? { mode, subjectId, claim: clip(value.claim, 72) || "我持续照料并使用这里" } : null;
  }
  if (mode === "trade") {
    const offeredMatterId = clip(value.offeredMatterId, 50);
    const requestedMatterId = clip(value.requestedMatterId, 50);
    const withAgentId = clip(value.withAgentId, 50);
    const requestedExists = ctx.state.world.matter.some((item) => item.id === requestedMatterId && item.holder.kind === "agent" && item.holder.id === withAgentId);
    return heldIds.has(offeredMatterId) && visibleIds.has(withAgentId) && requestedExists ? { mode, offeredMatterId, requestedMatterId, withAgentId } : null;
  }
  if (mode === "relocate") return { mode, to: ctx.agent.locationId };
  if (mode === "drink") {
    const sourceId = clip(value.sourceId, 50) || target.id;
    return ctx.localMatter.some((item) => item.id === sourceId && item.kind === "water-source") ? { mode, sourceId } : null;
  }
  if (mode === "rest") return { mode, siteId: ctx.agent.locationId };
  if (mode === "warm") {
    const fireId = clip(value.fireId, 50) || target.id;
    return ctx.localMatter.some((item) => item.id === fireId && item.traits.includes("burning")) ? { mode, fireId } : null;
  }
  if (mode === "bond") {
    const toAgentId = target.kind === "agent" ? target.id : clip(value.toAgentId, 50);
    const gesture = value.gesture;
    const barrierId = clip(value.barrierId, 50);
    const barrier = held.find((item) => item.id === barrierId && item.traits.includes("barrier"));
    return visibleIds.has(toAgentId) && (gesture === "comfort" || gesture === "court" || gesture === "care" || gesture === "intimate") && (gesture !== "intimate" || barrier)
      ? { mode, toAgentId, gesture, ...(gesture === "intimate" ? { barrierId: barrier!.id } : {}) }
      : null;
  }
  if (mode === "inspect-body") {
    const targetAgentId = target.kind === "agent" ? target.id : clip(value.targetAgentId, 50);
    return visibleIds.has(targetAgentId) && ctx.visibleAgents.some((item) => item.id === targetAgentId && item.body.state === "active" && (item.body.illness || item.body.injury)) ? { mode, targetAgentId } : null;
  }
  if (mode === "apply-material") {
    const matterId = clip(value.matterId, 50);
    const targetAgentId = target.kind === "agent" ? target.id : clip(value.targetAgentId, 50);
    return accessibleMatterIds.has(matterId) && visibleIds.has(targetAgentId) ? { mode, matterId, targetAgentId } : null;
  }
  if (mode === "treat") {
    const toAgentId = target.kind === "agent" ? target.id : clip(value.toAgentId, 50);
    return visibleIds.has(toAgentId) && ctx.visibleAgents.some((item) => item.id === toAgentId && item.body.state === "active" && item.body.illness) ? { mode, toAgentId } : null;
  }
  if (mode === "fit-support") {
    const matterId = clip(value.matterId, 50);
    const targetAgentId = target.kind === "agent" ? target.id : clip(value.targetAgentId, 50);
    const support = held.find((item) => item.id === matterId && item.traits.includes("supportive"));
    const recipient = ctx.visibleAgents.find((item) => item.id === targetAgentId && (item.body.injury?.mobilityLoss ?? 0) >= 8 && item.body.injury?.bleeding === 0);
    return support && recipient ? { mode, matterId: support.id, targetAgentId: recipient.id } : null;
  }
  if (mode === "bury") {
    const remainsId = clip(value.remainsId, 50) || target.id;
    return ctx.localMatter.some((item) => item.id === remainsId && item.traits.includes("remains") && item.personId) ? { mode, remainsId, siteId: ctx.agent.locationId } : null;
  }
  if (mode === "adapt") {
    const change = value.change;
    if (change === "dehydrate") return { mode, change };
    const targetAgentId = clip(value.targetAgentId, 50);
    return change === "soak" && visibleIds.has(targetAgentId) ? { mode, change, targetAgentId } : null;
  }
  if (mode === "observe") {
    const aspect = value.aspect;
    const matterId = clip(value.matterId, 50);
    return aspect === "sky" || aspect === "climate" || aspect === "quantity" ? { mode, aspect, ...(matterId && accessibleMatterIds.has(matterId) ? { matterId } : {}) } : null;
  }
  if (mode === "record") {
    const mediumId = clip(value.mediumId, 50);
    const medium = accessibleMatter.find((item) => item.id === mediumId && item.traits.includes("recordable"));
    const recordKind = value.recordKind;
    const experiencedIds = new Set(ctx.agent.mind.cognition.interpretations.flatMap((item) => item.factIds));
    const sourceEventIds = Array.isArray(value.sourceEventIds) ? value.sourceEventIds.map((item) => clip(item, 50)).filter((id) => experiencedIds.has(id)).slice(0, 12) : [];
    return medium && (recordKind === "tally" || recordKind === "chronicle" || recordKind === "calendar" || recordKind === "notation" || recordKind === "model" || recordKind === "map" || recordKind === "measure" || recordKind === "account" || recordKind === "contract" || recordKind === "image") && sourceEventIds.length
      ? { mode, mediumId, recordKind, sourceEventIds, note: clip(value.note, 80) || "未命名记录" }
      : null;
  }
  if (mode === "predict") {
    const predictedEpoch = value.predictedEpoch;
    const predictedClimate = value.predictedClimate;
    const dueTick = Math.max(ctx.state.tick + 1, Math.min(ctx.state.tick + 12, Math.round(Number(value.dueTick) || ctx.state.tick + 1)));
    const instrumentId = clip(value.instrumentId, 50);
    const accessibleSources = new Set([
      ...ctx.agent.mind.cognition.interpretations.flatMap((item) => item.factIds),
      ...accessibleMatter.flatMap((item) => item.records?.flatMap((record) => record.sourceEventIds) ?? []),
    ]);
    const sourceEventIds = Array.isArray(value.sourceEventIds) ? value.sourceEventIds.map((item) => clip(item, 50)).filter((id) => accessibleSources.has(id)).slice(0, 12) : [];
    if ((predictedEpoch === "stable" || predictedEpoch === "chaotic") && (predictedClimate === "temperate" || predictedClimate === "cold" || predictedClimate === "heat" || predictedClimate === "fire") && sourceEventIds.length >= 3) {
      return { mode, predictedEpoch, predictedClimate, dueTick, sourceEventIds, ...(instrumentId && accessibleMatter.find((item) => item.id === instrumentId && item.traits.includes("instrument") && item.construction?.complete) ? { instrumentId } : {}) };
    }
    return null;
  }
  if (mode === "express") {
    const toAgentId = target.kind === "agent" ? target.id : clip(value.toAgentId, 50);
    const knownSources = new Set(ctx.agent.mind.cognition.knowledge.flatMap((item) => item.sourceEventIds));
    const sourceEventIds = Array.isArray(value.sourceEventIds)
      ? value.sourceEventIds.map((item) => clip(item, 50)).filter((id) => knownSources.has(id)).slice(0, 6)
      : [];
    const claim = clip(value.claim, 72);
    return visibleIds.has(toAgentId)
      ? { mode, toAgentId, speech: clip(value.speech, 120) || "我想和你说一件事。", ...(claim && sourceEventIds.length ? { claim, sourceEventIds } : {}) }
      : null;
  }
  return null;
}

function normalizeDecision(ctx: DecisionContext, parsed: unknown): Decision | null {
  const raw = parsed as Record<string, unknown> | null;
  const action = normalizeAction(ctx, raw?.action);
  if (!action) return null;
  const consolidation = raw?.memoryConsolidation && typeof raw.memoryConsolidation === "object" ? raw.memoryConsolidation as Record<string, unknown> : null;
  const memoryIds = new Set(ctx.agent.mind.cognition.memory.episodic.map((fragment) => fragment.id));
  const retainFragmentIds = Array.isArray(consolidation?.retainFragmentIds) ? consolidation.retainFragmentIds.map((item) => clip(item, 50)).filter((id) => memoryIds.has(id)).slice(0, ctx.agent.mind.cognition.memory.capacity) : [];
  return {
    action,
    needLevel: raw?.needLevel === "physiological" || raw?.needLevel === "safety" || raw?.needLevel === "belonging" || raw?.needLevel === "esteem" || raw?.needLevel === "selfActualization" ? raw.needLevel : ctx.agent.mind.needs.dominantLevel,
    needFocus: clip(raw?.needFocus, 30) || ctx.agent.mind.needs.focus,
    perception: clip(raw?.perception, 60) || "我观察着眼前的一切",
    choice: clip(raw?.choice, 30) || "按当前主导需求行事",
    ...(consolidation && ctx.agent.mind.cognition.memory.episodic.length > ctx.agent.mind.cognition.memory.capacity ? { memoryConsolidation: { summary: clip(consolidation.summary, 180), lessons: Array.isArray(consolidation.lessons) ? consolidation.lessons.map((item) => clip(item, 72)).filter(Boolean).slice(0, 3) : [], retainFragmentIds } } : {}),
  };
}

function extractJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(stripped);
}

async function decideOne(ctx: DecisionContext, apiKey: string, provider: ModelProvider): Promise<Decision | null> {
  try {
    const config = MODEL_CONFIG[provider];
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: provider === "kimi" ? 0.6 : 0.8,
        max_tokens: config.maxTokens,
        ...(provider === "kimi" ? { thinking: { type: "disabled" } } : {}),
        ...(provider === "deepseek" ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(buildUserPayload(ctx)) },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return normalizeDecision(ctx, extractJson(content));
  } catch {
    return null;
  }
}

/** 用一个小请求把当年事实压成一条史册年报；失败时由会话层生成本地摘要。 */
export async function summarizeYearWithModel(input: YearSummaryInput, apiKey: string, requestedProvider: ModelProvider = DEFAULT_MODEL_PROVIDER): Promise<string | null> {
  const provider = normalizeModelProvider(requestedProvider);
  if (!apiKey) return null;
  try {
    const config = MODEL_CONFIG[provider];
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: provider === "kimi" ? 0.6 : 0.35,
        max_tokens: 10_000,
        ...(provider === "kimi" ? { thinking: { type: "disabled" } } : {}),
        messages: [
          {
            role: "system",
            content: "你是部落史官。只根据输入事实写两句简短的中文年度纪事，同时概括最重要的人物变化与部落整体变化。不要逐人罗列，不要使用标题、项目符号或空泛评价，不得补写输入中没有的事实，不必解释或计算字数。只输出正文。",
          },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const summary = content
      .trim()
      .replace(/^```(?:text|markdown)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .replace(/^[“\"']|[”\"']$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    return summary || null;
  } catch {
    return null;
  }
}

/** 平台无关的决策处理器：返回 { status, body }，由宿主服务器映射为 HTTP 响应 */
export async function handleDecide(payload: any, apiKey: string, requestedProvider: ModelProvider = DEFAULT_MODEL_PROVIDER): Promise<{ status: number; body: unknown }> {
  const provider = normalizeModelProvider(requestedProvider);
  if (!apiKey) {
    return { status: 500, body: { error: `服务端未配置 ${provider === "kimi" ? "KIMI_API_KEY" : "DEEPSEEK_API_KEY"}` } };
  }
  const requestedContexts = Array.isArray(payload?.contexts)
    ? payload.contexts.slice(0, MAX_AGENTS).flatMap((item: any) => {
        const state = item.state;
        if (!state || !Array.isArray(state.agents) || !Array.isArray(state.world?.space?.locations) || !Array.isArray(state.world?.matter) || !Array.isArray(state.world?.time?.past)) return [];
        const context = buildDecisionContexts(state).find((candidate) => candidate.agent.id === item.agentId);
        return context ? [context] : [];
      })
    : payload?.state && Array.isArray(payload.state.agents) && payload.state.agents.length <= MAX_AGENTS
      ? buildDecisionContexts(payload.state)
      : [];
  if (!requestedContexts.length) {
    return { status: 400, body: { error: "缺少合法的 state" } };
  }
  const decisions: (Decision | null)[] = [];
  for (let index = 0; index < requestedContexts.length; index += 3) {
    decisions.push(...await Promise.all(requestedContexts.slice(index, index + 3).map((ctx) => ctx.agent.body.state === "active" ? decideOne(ctx, apiKey, provider) : Promise.resolve(null))));
  }
  return { status: 200, body: { provider, model: MODEL_CONFIG[provider].model, decided: decisions.filter(Boolean).length, total: requestedContexts.length, decisions } };
}
