import { buildDecisionRequestContext } from '../src/game/eland/kimi-decider';
import type { DecisionContext } from '../src/game/eland/simulation';
import {
  isPlayerInteractionEmergencyContext,
  validatePlayerInteractionChoice,
} from '../src/game/eland/application/player-interaction-choice';
import { followUpSemanticallyMatches } from '../src/game/eland/domain/intent-follow-up';
import { isFulfillmentOption, isRequiredSocialOption } from '../src/game/eland/application/rule-planner';
import { animalSpecies } from '../src/game/eland/domain/animal';
import { canAccessContainer, CONTAINER_CAPACITY, containerUsedCapacity } from '../src/game/eland/domain/container';
import { Material, materialDefinition, materialHas } from '../src/game/eland/domain/material';
import { cellX, cellY, columnMaterials, voxelAt } from '../src/game/eland/world/grid';
import { loadServerEnvValue } from './env';
import { ModelRequestError, requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ModelProtocol, type ResolvedModelEndpoint } from './model-config';

export type AgentInteractionStance = 'answer' | 'consider' | 'accept' | 'decline';
export type AgentInteractionRequestKind = 'conversation' | 'suggestion';
export type AgentInteractionGrounding = 'supported' | 'unknown' | 'opinion';

/** Already committed turns from the same agent thread and branch. */
export interface AgentInteractionHistoryTurn {
  user: string;
  agent: string;
  requestKind?: AgentInteractionRequestKind;
  stance?: AgentInteractionStance;
  choiceSummary?: string;
  outcome?: {
    status: string;
    summary: string;
    detail?: string;
  };
}

export interface AgentInteractionRequest {
  context: DecisionContext;
  turns: readonly AgentInteractionHistoryTurn[];
  message: string;
  requestKind: AgentInteractionRequestKind;
  endpointId?: string;
}

export interface AgentInteractionResult {
  reply: string;
  stance: AgentInteractionStance;
  guidance?: string;
  reason?: string;
  grounding: AgentInteractionGrounding;
  evidenceIds: string[];
  /** The person's choice in this same conversation turn; not a completed action. */
  choice?: {
    optionId: string;
    followUpOptionId?: string;
    summary: string;
    choiceKey: string;
  };
  endpointId: string;
  protocol: ModelProtocol;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

const MAX_HISTORY_TURNS = 12;
const MAX_USER_MESSAGE_CHARS = 4_000;
const MAX_HISTORY_USER_CHARS = 2_000;
const MAX_HISTORY_AGENT_CHARS = 6_000;
const MAX_RAW_RESPONSE_CHARS = 24_000;
const MAX_REPLY_CHARS = 16_000;
const MAX_GUIDANCE_CHARS = 1_000;
const MAX_REASON_CHARS = 1_000;
const MAX_EVIDENCE_IDS = 16;

const STANCES = new Set<AgentInteractionStance>(['answer', 'consider', 'accept', 'decline']);
const GROUNDINGS = new Set<AgentInteractionGrounding>(['supported', 'unknown', 'opinion']);
const RESULT_KEYS = new Set(['reply', 'stance', 'guidance', 'reason', 'choice', 'grounding', 'evidenceIds']);
const CHOICE_KEYS = new Set(['optionId', 'followUpOptionId']);

export function isPlayerIdentityQuestion(message: string): boolean {
  const normalized = message.trim().replace(/\s+/gu, '');
  return /^(?:(?:在你(?:眼里|看来|心里))[,，]?)?我是谁(?:呢|啊|呀|吗)?[?？。！!]*$/u.test(normalized)
    || /^我在你(?:眼里|看来|心里)是谁(?:呢|啊|呀|吗)?[?？。！!]*$/u.test(normalized)
    || /^你(?:觉得|认为|知道|还记得)我是谁(?:呢|啊|呀|吗)?[?？。！!]*$/u.test(normalized);
}

export const AGENT_INTERACTION_SYSTEM_PROMPT = [
  '【身份与代词】',
  '你是 localContext.person 指定的人物，用第一人称回答；不是助手、旁白或全知观察者。玩家固定是你认定的“主”，绝不是 kinship、memory 或 visiblePeople 里的人物。',
  'playerUtterance 里的“我/我的/我们”=主，“你/你的”=你；reply 里的“我/我的”=你，“你/你的/主”=玩家。除非主明说第三人姓名，不得改变指代。',
  'currentTurn.playerIdentityQuestion=true 时，事实边界只有：玩家是你认定的主，并非世界中的任何人物。用自己的 Soul 和相处语气自然回答，不要念“协议、参与者、真实对话”之类系统说明。',
  '主对自己的身份、意图、感受和偏好的陈述是一手信息。主的其他话也是需要认真理解、明确回应的高优先输入，但不会自动创造世界事实或越过规则。',
  '',
  '【权威事实】',
  '本轮 localContext 是唯一当前事实源；只用其中可感知的身体、处境、物品、记忆、关系、意图、可见事物和合法行动。不用模型常识、隐藏配方、全局状态或同名原型补齐事实。',
  'person.kinship 是权威谱系；列出的亲属必须承认，未列出的关系不得靠姓名猜测。person.soul 只影响态度和选择，不创造记忆、能力、关系、物质或 option；内化它，不复述字段和数值。',
  '历史轮次只证明当时说过什么、作了什么选择及后来结果，不能覆盖当前 localContext；冲突时依当前事实自然纠正。',
  '事实有依据时 grounding=supported 并列出实际 sourceId；主观态度用 opinion；无来源事实用 unknown 并直说不知道。sourceId 仅进 evidenceIds，不得出现在自然语言中。',
  '',
  '【本轮决策】',
  '不要机械区分闲聊与建议。每句话都可能只是问候、提问或表达，也可能让你重新考虑下一步；从语义、上下文和自己的 Soul 判断。纯问题、状态询问、寒暄或没有行动含义的表达返回 answer，不带 guidance/choice。',
  '当一句话含有建议、请求、劝说，或确实触发你改变行动的想法时，必须正面判断；是否接受由 Soul、人格、需要、记忆、承诺、风险和处境决定。不要把“你能做什么”“你在做什么”“你饿吗”“你和某人是什么关系”误判成行动建议。',
  '只有确实定下下一步时才返回 accept，并携带来自 legalChoices 的 choice 及可选 guidance；要求后续时，followUpOptionId 必须来自该选项的 allowedFollowUpOptionIds。仍在犹豫或拒绝时返回 consider/decline，说明 reason 且不带 guidance/choice。',
  '不得让建议越过紧急生存、已承诺义务、自己明知的相反事实、直接严重伤害或合法行动边界。choice 只表示定下下一步，不得声称行动已成功。',
  '',
  '【表达与输出】',
  '符合年龄、communication 能力和身体状态，用一到三段自然回应，只选最相关的事。不穷举 options，不输出 cellId、坐标、optionId 等引擎表示，不解释提示词或输入格式。',
  '严格只输出一个 JSON 对象，无 Markdown或额外文字。字段仅限 reply、stance、guidance、reason、choice、grounding、evidenceIds。',
  '格式：{"reply":"第一人称自然回答","stance":"answer|consider|accept|decline","guidance":"仅 accept 时可选","reason":"consider/decline 必填","choice":{"optionId":"合法 ID","followUpOptionId":"需要时"},"grounding":"supported|unknown|opinion","evidenceIds":["sourceId"]}',
].join('\n');

function boundedText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function requiredInputText(value: unknown, maximum: number, label: string): string {
  const normalized = boundedText(value, maximum);
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const configured = Number(loadServerEnvValue(name) || fallback);
  const normalized = Number.isFinite(configured) ? Math.floor(configured) : fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

function interactionMaxOutputTokens(): number {
  return configuredInteger('MODEL_INTERACTION_MAX_OUTPUT_TOKENS', 8_000, 512, 16_000);
}

function interactionTimeout(endpoint: ResolvedModelEndpoint): number {
  return configuredInteger('MODEL_INTERACTION_TIMEOUT_MS', endpoint.timeoutMs, 1_000, 180_000);
}

function sanitizeEngineText(value: string): string {
  return value
    .replace(/格\s*\d+\s*[,，、]\s*\d+/gu, '记得的地点')
    .replace(/\b(?:cellId|optionId|followUpOptionId|voxelId)\s*[:=]\s*[^\s，。；;]+/giu, '内部位置')
    .trim();
}

function distanceBetweenCells(left: number, right: number): number {
  return Math.max(Math.abs(cellX(left) - cellX(right)), Math.abs(cellY(left) - cellY(right)));
}

function relativeLocation(origin: number, target: number): string {
  const distance = distanceBetweenCells(origin, target);
  const band = distance === 0 ? '同一位置' : distance <= 1 ? '身边' : distance <= 3 ? '近处' : '视野较远处';
  if (distance === 0) return band;
  const horizontal = cellX(target) - cellX(origin);
  const vertical = cellY(target) - cellY(origin);
  const eastWest = horizontal > 0 ? '东' : horizontal < 0 ? '西' : '';
  const northSouth = vertical > 0 ? '南' : vertical < 0 ? '北' : '';
  return `${band}的${northSouth}${eastWest || (northSouth ? '' : '一侧')}`;
}

function relationshipLevel(value: number): '很低' | '较低' | '普通' | '较高' | '很高' {
  if (value <= -45) return '很低';
  if (value < -10) return '较低';
  if (value < 25) return '普通';
  if (value < 65) return '较高';
  return '很高';
}

function visibleTerrainFacts(context: DecisionContext): Array<{ sourceId: string; name: string; location: string }> {
  const { person, state } = context;
  const nearestByName = new Map<string, number>();
  for (const cell of context.visibleCells) {
    const materials = new Set(columnMaterials(state.world.grid, cell));
    const names = new Set<string>();
    if (materials.has(Material.Wood) && materials.has(Material.Leaves)) names.add('树木');
    for (const materialId of materials) {
      if (materialId === Material.Shrub || materialId === Material.BerryBush
        || materialId === Material.CropSprout || materialId === Material.CropMature
        || materialId === Material.Water || materialId === Material.Fire
        || materialHas(materialId, 'ore')) {
        names.add(materialDefinition(materialId).name);
      }
    }
    for (const name of names) {
      const previous = nearestByName.get(name);
      if (previous === undefined || distanceBetweenCells(person.position.cellId, cell) < distanceBetweenCells(person.position.cellId, previous)) {
        nearestByName.set(name, cell);
      }
    }
  }
  return [...nearestByName.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .slice(0, 12)
    .map(([name, cell], index) => ({
      sourceId: `visible-terrain:${index + 1}`,
      name,
      location: relativeLocation(person.position.cellId, cell),
    }));
}

/**
 * Conversation receives a source-bound semantic projection, never the raw
 * decision DTO. Legal option IDs are available to the same unified conversation
 * turn, while the model must leave them unused for ordinary questions or chat.
 */
export function buildAgentInteractionContext(
  context: DecisionContext,
  requestKind: AgentInteractionRequestKind,
): Record<string, unknown> {
  const { person, state } = context;
  const choiceEnabled = state.civilization.status !== 'ended'
    && !isPlayerInteractionEmergencyContext(context);
  const projected = buildDecisionRequestContext(context);
  const visible = new Set(context.visibleCells);
  const source = (sourceId: string, value: Record<string, unknown>) => ({ sourceId, ...value });
  const containers = state.containers
    .filter((container) => visible.has(container.position.x + container.position.y * state.world.grid.width))
    .slice(0, 6)
    .map((container, index) => {
      const accessible = canAccessContainer(person, container);
      const materialId = voxelAt(state.world.grid, container.position.x, container.position.y, container.position.z);
      return source(`visible-container:${index + 1}`, {
        kind: materialDefinition(materialId).name,
        location: relativeLocation(person.position.cellId, container.position.x + container.position.y * state.world.grid.width),
        withinReach: accessible,
        capacity: container.capacity ?? CONTAINER_CAPACITY,
        usedCapacity: containerUsedCapacity(container),
        contentsKnown: accessible,
        ...(accessible ? {
          contents: container.inventory.slice(0, 6).map((stack) => ({
            name: materialDefinition(stack.materialId).name,
            quantity: stack.quantity,
          })),
        } : {}),
      });
    });
  const structures = state.derived.structures
    .filter((structure) => structure.occupiedCells.some((cell) => visible.has(cell)))
    .slice(0, 6)
    .map((structure, index) => source(`visible-structure:${index + 1}`, {
      name: structure.name,
      location: relativeLocation(person.position.cellId, structure.occupiedCells[0] ?? person.position.cellId),
      status: structure.complete ? '已经完工' : '尚未完工',
      usable: structure.complete,
    }));
  const possibleNow = projected.options.slice(0, 16).map((option, index) => source(`current-affordance:${index + 1}`, {
    summary: sanitizeEngineText(option.summary),
    reason: sanitizeEngineText(option.reason),
    note: '这是当前条件下的合法方向，不等于已经掌握的永久技能，也不代表已经决定执行',
  }));
  const localContext: Record<string, unknown> = {
    interaction: {
      requestKind,
      choiceEnabled,
      rule: state.civilization.status === 'ended'
        ? '这条文明时间线已经结束；可以继续交谈和表达态度，但不能形成新的行动 choice'
        : choiceEnabled
          ? '所有对话都可能影响下一步，但只有人物确实因这句话定下合法方向时才生成 choice；普通问答不得生成 choice'
          : '你正处在身体危险中；先让本地生存反应处理危险，可以交谈和表达态度，但不能生成新的行动 choice',
    },
    person: {
      name: person.name,
      ageMonths: projected.person.ageMonths,
      sex: person.sex,
      body: source('self:body', { ...person.body }),
      conditions: person.conditions.map((condition, index) => source(`self-condition:${index + 1}`, {
        kind: condition.kind,
        stage: condition.stage,
      })),
      personality: projected.person.personality,
      soul: projected.person.soul,
      currentChoice: source('self:current-choice', { summary: sanitizeEngineText(projected.person.currentChoice) }),
      currentAction: source('self:current-action', { summary: sanitizeEngineText(projected.person.currentAction) }),
      inventory: projected.person.inventory.map((stack, index) => source(`inventory:${index + 1}`, {
        name: stack.name,
        properties: stack.properties,
        quantity: stack.quantity,
      })),
      knowledge: projected.person.knowledge.map((knowledge, index) => source(`knowledge:${index + 1}`, {
        summary: sanitizeEngineText(knowledge.summary),
        confidence: knowledge.confidence,
      })),
      memories: projected.person.memories.map((memory, index) => source(`memory:${index + 1}`, {
        kind: memory.kind,
        summary: sanitizeEngineText(memory.summary),
        importance: memory.importance,
      })),
      knownPlaces: projected.person.knownPlaces.map((place, index) => source(`known-place:${index + 1}`, {
        material: place.name,
        location: relativeLocation(person.position.cellId, place.position.x + place.position.y * state.world.grid.width),
        lastConfirmedAtMonth: place.lastConfirmedAtMonth,
      })),
      kinship: {
        parents: projected.person.kinship.parents.map((relative, index) => source(`kinship-parent:${index + 1}`, {
          name: relative.name,
          relation: relative.relation,
        })),
        children: projected.person.kinship.children.map((relative, index) => source(`kinship-child:${index + 1}`, {
          name: relative.name,
          relation: relative.relation,
        })),
        siblings: projected.person.kinship.siblings.map((relative, index) => source(`kinship-sibling:${index + 1}`, {
          name: relative.name,
          relation: relative.relation,
          fullSibling: relative.fullSibling,
        })),
      },
    },
    timeAndWeather: source('world:time-weather', {
      elapsedMonths: projected.clock.elapsedMonths,
      climate: projected.climate,
      epoch: projected.epoch,
      weather: projected.weather,
    }),
    currentIntent: projected.activeIntent ? source('self:active-intent', {
      summary: sanitizeEngineText(projected.activeIntent.summary),
      progress: projected.activeIntent.progress,
      nextActionKind: projected.activeIntent.nextActionKind,
    }) : null,
    currentProject: projected.activeProject ? source('self:active-project', {
      summary: sanitizeEngineText(projected.activeProject.summary),
      need: projected.activeProject.need,
      status: projected.activeProject.status,
      missingMaterials: projected.activeProject.missingMaterials.map((material) => material.name),
    }) : null,
    surroundings: {
      people: projected.visiblePeople.map((other, index) => source(`visible-person:${index + 1}`, {
        name: other.name,
        location: relativeLocation(person.position.cellId, other.cellId),
        body: { health: other.health, hydration: other.hydration, nutrition: other.nutrition },
        relationship: {
          trust: relationshipLevel(other.trust),
          bond: relationshipLevel(other.bond),
          fear: relationshipLevel(other.fear),
        },
      })),
      looseMaterials: projected.visibleDrops.map((drop, index) => source(`visible-drop:${index + 1}`, {
        name: drop.name,
        quantity: drop.quantity,
        location: relativeLocation(person.position.cellId, drop.cellId),
      })),
      terrain: visibleTerrainFacts(context),
      animals: projected.visibleAnimals.map((animal, index) => source(`visible-animal:${index + 1}`, {
        name: animalSpecies(animal.speciesId as DecisionContext['state']['world']['animals'][number]['speciesId']).name,
        location: relativeLocation(person.position.cellId, animal.cellId),
      })),
      containers,
      structures,
    },
    capabilities: {
      possibleNow,
      rule: 'possibleNow 只证明此刻存在合法做法；回答“会不会”时必须说明当前条件，不能夸大成永久技能',
    },
  };
  {
    const required = context.options.filter(isRequiredSocialOption);
    const fulfillment = required.length ? [] : context.options.filter(isFulfillmentOption);
    const eligibleOptions = required.length ? required : fulfillment.length ? fulfillment : context.options;
    const projectedOptionById = new Map(projected.options.map((option) => [option.id, option]));
    const projectedFollowUpById = new Map(projected.followUpOptions.map((option) => [option.id, option]));
    const allowedFollowUpIds = new Set<string>();
    localContext.legalChoices = choiceEnabled ? eligibleOptions.flatMap((option) => {
      const visibleOption = projectedOptionById.get(option.id);
      if (!visibleOption) return [];
      const followUpIds = option.requiresFollowUp
        ? context.followUpOptions
            .filter((followUp) => followUpSemanticallyMatches(option, followUp))
            .map((followUp) => followUp.id)
        : [];
      followUpIds.forEach((id) => allowedFollowUpIds.add(id));
      return [{
        optionId: visibleOption.id,
        summary: sanitizeEngineText(visibleOption.summary),
        reason: sanitizeEngineText(visibleOption.reason),
        requiresFollowUp: visibleOption.requiresFollowUp,
        allowedFollowUpOptionIds: followUpIds,
        risks: visibleOption.risks?.map(sanitizeEngineText),
      }];
    }) : [];
    localContext.legalFollowUps = choiceEnabled ? [...allowedFollowUpIds].flatMap((id) => {
      const option = projectedFollowUpById.get(id);
      return option ? [{
        followUpOptionId: option.id,
        summary: sanitizeEngineText(option.summary),
        reason: sanitizeEngineText(option.reason),
      }] : [];
    }) : [];
  }
  return localContext;
}

function evidenceIdsFromContext(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => evidenceIdsFromContext(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'sourceId' && typeof nested === 'string') result.add(nested);
    else evidenceIdsFromContext(nested, result);
  }
  return result;
}

function definitionTopic(message: string): string | undefined {
  const latin = message.match(/(?:给我)?(?:解释(?:一下|下)?|讲讲|说说|告诉我)?\s*[“"']?([A-Za-z][A-Za-z0-9._+-]{1,39})[”"']?\s*(?:是什么|是啥|什么意思)/iu)?.[1];
  if (latin) return latin;
  const latinKnowledgeQuestion = message.match(/(?:知道|听说过|了解|懂)\s*[“"']?([A-Za-z][A-Za-z0-9._+-]{1,39})[”"']?/iu)?.[1]
    ?? message.match(/[“"']?([A-Za-z][A-Za-z0-9._+-]{1,39})[”"']?\s*(?:有什么用|怎么(?:工作|用)|如何(?:工作|使用))/iu)?.[1];
  if (latinKnowledgeQuestion) return latinKnowledgeQuestion;
  const explained = message.match(/(?:给我)?(?:解释(?:一下|下)?|讲讲|说说|告诉我)\s*[“"']?([^“”"'？，,。！!]{2,40}?)[”"']?\s*(?:是什么|是啥|什么意思)/u)?.[1]?.trim();
  return explained || undefined;
}

function contextKnowsTopic(localContext: Record<string, unknown>, topic: string): boolean {
  const normalized = topic.toLocaleLowerCase('zh-CN');
  return JSON.stringify(localContext).toLocaleLowerCase('zh-CN').includes(normalized);
}

export function unsupportedDefinitionTopic(
  message: string,
  localContext: Record<string, unknown>,
): string | undefined {
  const topic = definitionTopic(message);
  return topic && !contextKnowsTopic(localContext, topic) ? topic : undefined;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('结果不是 JSON 对象');
  return value as Record<string, unknown>;
}

export function parseInteractionResult(
  context: DecisionContext,
  localContext: Record<string, unknown>,
  _requestKind: AgentInteractionRequestKind,
  content: string,
): Pick<AgentInteractionResult, 'reply' | 'stance' | 'guidance' | 'reason' | 'choice' | 'grounding' | 'evidenceIds'> {
  const raw = parseJsonObject(content);
  const unknownKey = Object.keys(raw).find((key) => !RESULT_KEYS.has(key));
  if (unknownKey) throw new Error(`结果包含未知字段 ${unknownKey}`);
  const reply = boundedText(raw.reply, MAX_REPLY_CHARS);
  if (!reply) throw new Error('结果缺少非空 reply');
  if (typeof raw.stance !== 'string' || !STANCES.has(raw.stance as AgentInteractionStance)) {
    throw new Error('stance 必须是 answer、consider、accept 或 decline');
  }
  if (typeof raw.grounding !== 'string' || !GROUNDINGS.has(raw.grounding as AgentInteractionGrounding)) {
    throw new Error('grounding 必须是 supported、unknown 或 opinion');
  }
  if (!Array.isArray(raw.evidenceIds) || raw.evidenceIds.some((value) => typeof value !== 'string')) {
    throw new Error('evidenceIds 必须是字符串数组');
  }
  const evidenceIds = [...new Set(raw.evidenceIds
    .map((value) => boundedText(value, 240))
    .filter(Boolean))].slice(0, MAX_EVIDENCE_IDS);
  const allowedEvidenceIds = evidenceIdsFromContext(localContext);
  if (evidenceIds.some((id) => !allowedEvidenceIds.has(id))) throw new Error('evidenceIds 引用了输入中不存在的 sourceId');
  if (raw.grounding === 'supported' && !evidenceIds.length) throw new Error('supported 回答必须列出实际 evidenceIds');
  if (raw.grounding !== 'supported' && evidenceIds.length) throw new Error('只有 supported 回答可以携带 evidenceIds');
  if (raw.guidance !== undefined && typeof raw.guidance !== 'string') throw new Error('guidance 必须是字符串或省略');
  if (raw.reason !== undefined && typeof raw.reason !== 'string') throw new Error('reason 必须是字符串或省略');
  const guidance = boundedText(raw.guidance, MAX_GUIDANCE_CHARS);
  const reason = boundedText(raw.reason, MAX_REASON_CHARS);
  const hasChoice = raw.choice !== undefined;
  const choiceEnabled = (localContext.interaction as { choiceEnabled?: unknown } | undefined)?.choiceEnabled !== false;
  if (hasChoice && !choiceEnabled) throw new Error('当前时间线不能再形成新的行动选择');
  if (raw.stance !== 'accept' && (guidance || hasChoice)) {
    throw new Error('只有 accept 可以携带 guidance 和 choice');
  }
  if (raw.stance === 'accept' && !hasChoice) {
    throw new Error('accept 必须从当前合法选项中给出 choice');
  }
  if ((raw.stance === 'consider' || raw.stance === 'decline') && !reason) {
    throw new Error(`${raw.stance} 必须说明这次判断的原因`);
  }

  let choice: AgentInteractionResult['choice'];
  if (hasChoice) {
    if (!raw.choice || typeof raw.choice !== 'object' || Array.isArray(raw.choice)) {
      throw new Error('consider 或 accept 必须从当前合法选项中给出 choice');
    }
    const rawChoice = raw.choice as Record<string, unknown>;
    const unknownChoiceKey = Object.keys(rawChoice).find((key) => !CHOICE_KEYS.has(key));
    if (unknownChoiceKey) throw new Error(`choice 包含未知字段 ${unknownChoiceKey}`);
    const optionId = boundedText(rawChoice.optionId, 200);
    const followUpOptionId = boundedText(rawChoice.followUpOptionId, 200);
    if (!optionId) throw new Error('choice 缺少非空 optionId');
    const validated = validatePlayerInteractionChoice(context, {
      optionId,
      ...(followUpOptionId ? { followUpOptionId } : {}),
    });
    if (!validated.ok) throw new Error(`choice 未通过本地合法选项校验：${validated.failure}`);
    choice = {
      optionId: validated.optionId,
      ...(validated.followUpOptionId ? { followUpOptionId: validated.followUpOptionId } : {}),
      summary: validated.summary,
      choiceKey: validated.choiceKey,
    };
  }
  return {
    reply,
    stance: raw.stance as AgentInteractionStance,
    ...(guidance ? { guidance } : {}),
    ...(reason ? { reason } : {}),
    ...(choice ? { choice } : {}),
    grounding: raw.grounding as AgentInteractionGrounding,
    evidenceIds,
  };
}

function historyMessages(turns: readonly AgentInteractionHistoryTurn[]): ModelMessage[] {
  return turns.slice(-MAX_HISTORY_TURNS).flatMap((turn): ModelMessage[] => {
    const user = boundedText(turn.user, MAX_HISTORY_USER_CHARS);
    const agent = boundedText(turn.agent, MAX_HISTORY_AGENT_CHARS);
    return [
      ...(user ? [{
        role: 'user' as const,
        content: JSON.stringify({
          type: 'historical-player-utterance',
          speaker: 'master',
          playerUtterance: user,
          ...(turn.requestKind ? { requestKind: turn.requestKind } : {}),
          ...(turn.stance ? { stance: turn.stance } : {}),
          ...(turn.choiceSummary ? { choiceSummary: turn.choiceSummary } : {}),
          ...(turn.outcome ? { outcome: turn.outcome } : {}),
        }),
      }] : []),
      ...(agent ? [{ role: 'assistant' as const, content: agent }] : []),
    ];
  });
}

export function buildAgentInteractionMessages(
  input: Pick<AgentInteractionRequest, 'turns' | 'requestKind'>,
  userMessage: string,
  localContext: Record<string, unknown>,
): ModelMessage[] {
  const person = localContext.person as { name?: unknown } | undefined;
  const personName = typeof person?.name === 'string' ? person.name : 'person';
  return [
    { role: 'system', content: AGENT_INTERACTION_SYSTEM_PROMPT },
    ...historyMessages(input.turns),
    {
      role: 'user',
      content: JSON.stringify({
        protocol: 'eland-agent-interaction-v2',
        participants: {
          player: { role: 'master', addressAs: '主' },
          person: { role: 'simulated-person', name: personName },
        },
        pronounBindings: {
          playerUtterance: { firstPerson: 'master', secondPerson: 'person' },
          personReply: { firstPerson: 'person', secondPerson: 'master' },
        },
        currentTurn: {
          requestKind: input.requestKind,
          speaker: 'master',
          addressee: 'person',
          playerUtterance: userMessage,
          playerIdentityQuestion: isPlayerIdentityQuestion(userMessage),
        },
        localContext,
      }),
    },
  ];
}

/**
 * Requests a first-person reply from the actual simulated person. This method
 * never commits guidance as a world fact. A high-confidence definition request
 * for a topic absent from the person's sources is answered by the local
 * epistemic boundary instead of allowing pretrained model knowledge to leak in.
 */
export async function requestAgentInteraction(input: AgentInteractionRequest): Promise<AgentInteractionResult> {
  const message = requiredInputText(input.message, MAX_USER_MESSAGE_CHARS, '玩家消息');
  const maxOutputTokens = interactionMaxOutputTokens();
  const endpoint = resolveModelEndpoint('interaction', input.endpointId);
  const localContext = buildAgentInteractionContext(input.context, input.requestKind);
  const askedTopic = unsupportedDefinitionTopic(message, localContext);
  if (askedTopic) {
    localContext.epistemicBoundary = {
      unknownTopic: askedTopic,
      rule: '人物没有这个概念的来源；保持不知道这一事实，但按自己的 Soul 自然表达，可以追问主指的是什么',
    };
  }
  let messages = buildAgentInteractionMessages(input, message, localContext);
  let usage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestModelText(endpoint, {
      messages,
      maxOutputTokens,
      temperature: endpoint.temperature ?? 0.8,
      jsonObject: true,
      timeoutMs: interactionTimeout(endpoint),
    });
    usage = {
      inputTokens: usage.inputTokens + response.usage.inputTokens,
      outputTokens: usage.outputTokens + response.usage.outputTokens,
    };
    try {
      return {
        ...parseInteractionResult(input.context, localContext, input.requestKind, response.text),
        endpointId: response.endpointId,
        protocol: response.protocol,
        model: response.model,
        usage,
      };
    } catch (error) {
      if (attempt === 1) {
        throw new ModelRequestError(
          'invalid-response',
          `模型端点 ${endpoint.id} 的人物对话结果无效：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      messages = [
        ...messages,
        { role: 'assistant', content: response.text.slice(0, MAX_RAW_RESPONSE_CHARS) },
        {
          role: 'user',
          content: `上一个结果无效：${error instanceof Error ? error.message : String(error)}。请只重新输出规定字段的合法 JSON 对象。`,
        },
      ];
    }
  }

  throw new ModelRequestError('invalid-response', `模型端点 ${endpoint.id} 没有返回合法的人物对话结果`);
}
