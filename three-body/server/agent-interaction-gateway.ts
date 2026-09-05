import type { DecisionContext } from '../src/game/eland/simulation';
import {
  buildDecisionRequestContext,
  isPlayerInteractionEmergencyContext,
  isFulfillmentOption,
  isRequiredSocialOption,
  validatePlayerInteractionChoice,
} from '../src/game/eland/infrastructure-api';
import { followUpSemanticallyMatches } from '../src/game/eland/domain/intent-follow-up';
import {
  buildCharacterTurnNote,
  buildPersonExperienceLayer,
} from '../src/game/eland/domain/person-soul';
import { animalSpecies } from '../src/game/eland/domain/animal';
import { canAccessContainer, CONTAINER_CAPACITY, containerUsedCapacity } from '../src/game/eland/domain/container';
import { Material, materialDefinition, materialHas } from '../src/game/eland/domain/material';
import { physicalStructuresOf } from '../src/game/eland/domain/physical-structure-index';
import { cellX, cellY, columnMaterials, voxelAt } from '../src/game/eland/world/grid';
import { loadServerEnvValue } from './env';
import { ModelRequestError, requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ModelProtocol, type ResolvedModelEndpoint } from './model-config';
import { buildPersonaFrame, communicationProfile, selectContextualMemories } from './persona-context';
import { INTERACTION_REPLY_SYSTEM_PROMPT_V2 } from './agent-prompt-templates';

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
  /** A choice extracted from this turn's reply and locally validated; not a completed action. */
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
const INTENT_RESULT_KEYS = new Set(['stance', 'guidance', 'reason', 'choice']);
const CHOICE_KEYS = new Set(['optionId', 'followUpOptionId']);

const CONVERSATION_ONLY_REQUEST = /^(?:(?:只|先|现在|认真|简单|如实|直接)\s*)*(?:回答|告诉|说说|讲讲|解释|描述|说明|聊聊|谈谈|想想|回忆|评价|判断|猜猜)/u;
const QUESTION_TERM = /(?:吗|嘛|么|呢|什么|啥|谁|哪|哪里|哪儿|怎么|怎样|为何|为什么|几|多少|何时|什么时候)/u;
const DIRECT_WORLD_ACTION = /^(?:(?:你|我们)\s*)?(?:(?:一起|先|现在|接下来|马上|赶紧|快点|继续|别|不要)\s*)*(?:去|来|找|寻找|拿|取|捡|拾|采|收集|吃|喝|做|制作|造|建|修|烧|点燃|种|砍|挖|搬|放|给|帮助|帮|照顾|休息|睡|脱水|苏醒|加入|接受|拒绝|交换|结伴|生育|教|学习|记录|观察|探索|处理|使用|储存|工作|完成|开始|尝试|离开|回来|跟随|带|穿)(?!什么|啥|哪|哪里|哪儿|怎么|怎样|为何|为什么|过|了|着|得)/u;
const ACTION_PROPOSAL_FRAME = /^(?:我(?:希望|想要|建议|请求|拜托|劝|要求)(?:让|请)?你|我想(?:让|请)你|我(?:觉得|认为)你(?:应该|最好|需要|得)|(?:请|拜托|麻烦|劳烦)(?:你)?|你(?:应该|最好|必须|需要|得)|(?:要不|不如|何不)(?:你)?|(?:你)?(?:要不要|愿不愿意|是否愿意|能不能|可不可以)|让我们|我们一起)\s*(.*)$/u;
const ENGLISH_ACTION_PROPOSAL = /\b(?:please\s+(?!answer|tell|explain|describe|say|talk)|i\s+(?:want|would\s+like|suggest|ask|need)\s+you\s+to|you\s+(?:should|must|need\s+to|had\s+better)|why\s+don['’]?t\s+you|let['’]?s|(?:could|would|will)\s+you\s+(?!answer|tell|explain|describe|say|talk))\b/iu;
const ENGLISH_CONVERSATION_ONLY_REQUEST = /\b(?:answer|tell\s+me|explain|describe|say|talk\s+(?:to\s+me|about))\b/iu;

/**
 * Player speech may only create a durable choice when it contains an explicit
 * request or proposal to act. This intentionally fails closed: questions,
 * greetings and requests for an answer stay inside the player -> person
 * conversation even when the person has an unrelated world proposal pending.
 */
export function isExplicitPlayerActionProposal(message: string): boolean {
  const segments = message.trim().split(/[，,。；;！？!?\n]+/u).map((segment) => segment.trim()).filter(Boolean);
  return segments.some((segment) => {
    if (DIRECT_WORLD_ACTION.test(segment) && !QUESTION_TERM.test(segment)) return true;
    const framed = segment.match(ACTION_PROPOSAL_FRAME);
    if (framed) {
      const proposed = (framed[1] ?? '').trim();
      return Boolean(proposed)
        && !CONVERSATION_ONLY_REQUEST.test(proposed)
        && !QUESTION_TERM.test(proposed);
    }
    return ENGLISH_ACTION_PROPOSAL.test(segment) && !ENGLISH_CONVERSATION_ONLY_REQUEST.test(segment);
  });
}

export function isPlayerIdentityQuestion(message: string): boolean {
  const normalized = message.trim().replace(/\s+/gu, '');
  return /^(?:(?:在你(?:眼里|看来|心里))[,，]?)?我是谁(?:呢|啊|呀|吗)?[?？。！!]*$/u.test(normalized)
    || /^我在你(?:眼里|看来|心里)是谁(?:呢|啊|呀|吗)?[?？。！!]*$/u.test(normalized)
    || /^你(?:觉得|认为|知道|还记得)我是谁(?:呢|啊|呀|吗)?[?？。！!]*$/u.test(normalized);
}

export const AGENT_INTERACTION_SYSTEM_PROMPT = INTERACTION_REPLY_SYSTEM_PROMPT_V2;

export const AGENT_INTERACTION_INTENT_SYSTEM_PROMPT = [
  '你是 ELAND 的隐藏意图解析器，不向玩家说话，也不续写或改写人物回复。',
  '只判断 agentReply 已经明确表达的态度，不能替人物补出没有说过的承诺，不能从其他人物的未决提议生成无关意图。',
  'currentTurn.actionChoiceRequested=false 时必须返回 answer；普通问答中提到愿望、当前计划或能力不等于新承诺。',
  '只有 actionChoiceRequested=true、choiceEnabled=true，且 agentReply 明确接受了主的请求并唯一对应 legalChoices 中一项时，才能返回 accept + choice。',
  'agentReply 明确表示尚未决定时返回 consider，明确拒绝时返回 decline；二者必须用 reason 简述回复里已经表达的理由，不带 choice 或 guidance。其余情况返回 answer。',
  'accept 的 optionId 必须来自 legalChoices；需要后续动作时 followUpOptionId 必须来自该项 allowedFollowUpOptionIds。choice 只是待本地验证的候选，不表示行动已发生。',
  '严格只输出一个 JSON 对象，无 Markdown 或额外文字。字段仅限 stance、guidance、reason、choice。',
  '格式：{"stance":"answer|consider|accept|decline","guidance":"仅 accept 时可选","reason":"consider/decline 必填","choice":{"optionId":"合法 ID","followUpOptionId":"需要时"}}',
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
  playerMessage: string,
): Record<string, unknown> {
  const { person, state } = context;
  const actionChoiceRequested = isExplicitPlayerActionProposal(playerMessage);
  const choiceEnabled = actionChoiceRequested
    && state.civilization.status !== 'ended'
    && !isPlayerInteractionEmergencyContext(context);
  const projected = buildDecisionRequestContext(context);
  const visible = new Set(context.visibleCells);
  const source = <T extends Record<string, unknown>>(sourceId: string, value: T): T & { sourceId: string } => ({
    sourceId,
    ...value,
  });
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
  const structures = physicalStructuresOf(state)
    .filter((structure) => structure.occupiedCells.some((cell) => visible.has(cell)))
    .slice(0, 6)
    .map((structure, index) => source(`visible-structure:${index + 1}`, {
      name: structure.name,
      location: relativeLocation(person.position.cellId, structure.occupiedCells[0] ?? person.position.cellId),
      status: structure.complete ? '已经完工' : '尚未完工',
      usable: structure.complete,
    }));
  const worldResponseOptionIds = new Set(context.options.filter(isRequiredSocialOption).map((option) => option.id));
  const possibleNow = projected.options
    .filter((option) => !worldResponseOptionIds.has(option.id))
    .slice(0, 16)
    .map((option, index) => source(`current-affordance:${index + 1}`, {
      summary: sanitizeEngineText(option.summary),
      reason: sanitizeEngineText(option.reason),
      note: '这是当前条件下的合法方向，不等于已经掌握的永久技能，也不代表已经决定执行',
    }));
  const peopleById = new Map(state.people.map((candidate) => [candidate.id, candidate]));
  const mentionedPersonIds = state.people
    .filter((candidate) => candidate.id !== person.id && playerMessage.includes(candidate.name))
    .map((candidate) => candidate.id);
  const memoryCandidates = projected.person.memories.map((memory, index) => source(`memory:${index + 1}`, {
    kind: memory.lane,
    summary: sanitizeEngineText(memory.exactUtterance ?? memory.gist),
    importance: memory.salience,
    precision: memory.precision,
    confidence: memory.confidence,
    unresolved: memory.unresolved,
    personIds: memory.personIds,
    participants: memory.personIds.flatMap((personId) => {
      const participant = peopleById.get(personId);
      return participant ? [participant.name] : [];
    }),
  }));
  const selectedMemories = selectContextualMemories(memoryCandidates, {
    query: playerMessage,
    participantIds: mentionedPersonIds,
    maximum: 6,
  });
  const memoryBySourceId = new Map(memoryCandidates.map((memory, index) => [
    memory.sourceId,
    projected.person.memories[index],
  ]));
  const selectedExperienceMemories = selectedMemories.flatMap((memory) => {
    const sourceMemory = memoryBySourceId.get(memory.sourceId);
    return sourceMemory ? [sourceMemory] : [];
  });
  const experience = buildPersonExperienceLayer(person, selectedExperienceMemories, mentionedPersonIds);
  const playerIdentityQuestion = isPlayerIdentityQuestion(playerMessage);
  const hasCurrentCommitment = Boolean(projected.activeIntent || projected.activeProject
    || projected.agreements.some((agreement) => agreement.status === 'active' || agreement.status === 'proposed'));
  const personaFrame = buildPersonaFrame({
    soul: projected.person.soul,
    experience,
    message: playerMessage,
    actionChoiceRequested,
    choiceEnabled,
    playerIdentityQuestion,
    body: person.body,
    conditions: person.conditions,
    hasCurrentCommitment,
    recalledMemorySourceIds: selectedMemories.map((memory) => memory.sourceId as string),
  });
  const characterNote = buildCharacterTurnNote(
    projected.person.soul,
    experience,
    personaFrame.activatedFacet.id,
  );
  const localContext: Record<string, unknown> = {
    interaction: {
      requestKind,
      actionChoiceRequested,
      choiceEnabled,
      rule: state.civilization.status === 'ended'
        ? '这条文明时间线已经结束；可以继续交谈和表达态度，但不要承诺新的行动'
        : !actionChoiceRequested
          ? '本轮玩家没有明确提出行动；只回答 playerUtterance，不得借机回应其他人物的未决提议'
        : choiceEnabled
          ? '玩家明确提出了行动；按人物真实判断在自然回复中清楚表达接受、犹豫或拒绝，只有 legalChoices 中确有对应方向时才能承诺'
          : '你正处在身体危险中；先让本地生存反应处理危险，可以交谈和表达态度，但不要承诺新的行动',
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
      soul: {
        version: projected.person.soul.version,
        authority: projected.person.soul.authority,
        signature: projected.person.soul.signature,
        innerVoice: projected.person.soul.innerVoice,
        ...(projected.person.soul.prototype ? {
          prototypeSummary: projected.person.soul.prototype.personalitySummary,
        } : {}),
      },
      experience,
      personaFrame,
      characterNote,
      communication: communicationProfile(projected.person.capacities.communication, projected.person.ageMonths),
      traits: projected.person.traits.map((trait, index) => source(`self-trait:${index + 1}`, {
        name: trait.name,
        description: trait.description,
      })),
      currentChoice: source('self:current-choice', { summary: sanitizeEngineText(projected.person.currentChoice) }),
      currentAction: source('self:current-action', { summary: sanitizeEngineText(projected.person.currentAction) }),
      inventory: projected.person.inventory.map((stack, index) => source(`inventory:${index + 1}`, {
        name: stack.name,
        properties: stack.properties,
        perception: stack.perception,
        quantity: stack.quantity,
      })),
      knowledge: projected.person.knowledge.map((knowledge, index) => source(`knowledge:${index + 1}`, {
        summary: sanitizeEngineText(knowledge.summary),
        confidence: knowledge.confidence,
      })),
      memories: selectedMemories.map(({ personIds: _personIds, ...memory }) => memory),
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
      materialPlan: projected.activeProject.materialPlan.status === 'verified'
        ? {
            status: 'verified',
            desiredFunction: projected.activeProject.materialPlan.desiredFunction,
            missingMaterials: projected.activeProject.materialPlan.missingMaterials.map((material) => material.name),
            provenanceKind: projected.activeProject.materialPlan.provenance.kind,
          }
        : {
            status: 'unresolved',
            question: projected.activeProject.materialPlan.question,
          },
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
        perception: drop.perception,
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
      rule: 'possibleNow 只证明此刻存在合法做法；不含必须另行回应的世界内提议。回答“会不会”时必须说明当前条件，不能夸大成永久技能',
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

export function parseInteractionReply(
  localContext: Record<string, unknown>,
  content: string,
): Pick<AgentInteractionResult, 'reply' | 'grounding' | 'evidenceIds'> {
  const raw = parseJsonObject(content);
  const reply = boundedText(raw.reply, MAX_REPLY_CHARS);
  if (!reply) throw new Error('结果缺少非空 reply');
  if (/<(?:SELF|P\d+)_(?:NAME|ID)>|\bP\d+\b/u.test(reply)) {
    throw new Error('回复不得暴露旧姓名占位符');
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
  const unknownTopic = (localContext.epistemicBoundary as { unknownTopic?: unknown } | undefined)?.unknownTopic;
  if (typeof unknownTopic === 'string' && raw.grounding !== 'unknown') {
    throw new Error('没有知识来源的定义问题只能如实回答不知道');
  }
  return {
    reply,
    grounding: raw.grounding as AgentInteractionGrounding,
    evidenceIds,
  };
}

export function parseInteractionIntent(
  context: DecisionContext,
  localContext: Record<string, unknown>,
  content: string,
): Pick<AgentInteractionResult, 'stance' | 'guidance' | 'reason' | 'choice'> {
  const raw = parseJsonObject(content);
  const unknownKey = Object.keys(raw).find((key) => !INTENT_RESULT_KEYS.has(key));
  if (unknownKey) throw new Error(`意图结果包含未知字段 ${unknownKey}`);
  if (typeof raw.stance !== 'string' || !STANCES.has(raw.stance as AgentInteractionStance)) {
    throw new Error('stance 必须是 answer、consider、accept 或 decline');
  }
  if (raw.guidance !== undefined && typeof raw.guidance !== 'string') throw new Error('guidance 必须是字符串或省略');
  if (raw.reason !== undefined && typeof raw.reason !== 'string') throw new Error('reason 必须是字符串或省略');
  const guidance = boundedText(raw.guidance, MAX_GUIDANCE_CHARS);
  const reason = boundedText(raw.reason, MAX_REASON_CHARS);
  const hasChoice = raw.choice !== undefined;
  const actionChoiceRequested = (localContext.interaction as { actionChoiceRequested?: unknown } | undefined)
    ?.actionChoiceRequested === true;
  if (!actionChoiceRequested && (raw.stance !== 'answer' || guidance || reason || hasChoice)) {
    throw new Error('本轮玩家没有明确提出行动，不能形成新的对话意图');
  }
  const choiceEnabled = (localContext.interaction as { choiceEnabled?: unknown } | undefined)?.choiceEnabled === true;
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
    stance: raw.stance as AgentInteractionStance,
    ...(guidance ? { guidance } : {}),
    ...(reason ? { reason } : {}),
    ...(choice ? { choice } : {}),
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
  const characterNote = person && typeof person === 'object'
    ? (person as Record<string, unknown>).characterNote
    : undefined;
  return [
    { role: 'system', content: AGENT_INTERACTION_SYSTEM_PROMPT },
    ...historyMessages(input.turns),
    {
      role: 'user',
      content: JSON.stringify({
        protocol: 'eland-agent-interaction-reply-v1',
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
          replyTo: 'currentTurn.playerUtterance',
          playerUtterance: userMessage,
          playerIdentityQuestion: isPlayerIdentityQuestion(userMessage),
          actionChoiceRequested: (localContext.interaction as { actionChoiceRequested?: unknown } | undefined)
            ?.actionChoiceRequested === true,
        },
        localContext,
      }),
    },
    ...(characterNote ? [{
      role: 'user' as const,
      content: JSON.stringify({
        protocol: 'eland-character-note-v1',
        appliesTo: 'next-person-reply',
        characterNote,
        instruction: '按这张临场角色注记控制节奏和态度，直接回复上一条 currentTurn；输出格式仍服从 Player Conversation Contract。',
      }),
    }] : []),
  ];
}

export function buildAgentInteractionIntentMessages(
  userMessage: string,
  agentReply: string,
  localContext: Record<string, unknown>,
): ModelMessage[] {
  const interaction = localContext.interaction as {
    actionChoiceRequested?: unknown;
    choiceEnabled?: unknown;
  } | undefined;
  return [
    { role: 'system', content: AGENT_INTERACTION_INTENT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        protocol: 'eland-agent-interaction-intent-v1',
        currentTurn: {
          playerUtterance: userMessage,
          agentReply,
          actionChoiceRequested: interaction?.actionChoiceRequested === true,
          choiceEnabled: interaction?.choiceEnabled === true,
        },
        legalChoices: Array.isArray(localContext.legalChoices) ? localContext.legalChoices : [],
        legalFollowUps: Array.isArray(localContext.legalFollowUps) ? localContext.legalFollowUps : [],
      }),
    },
  ];
}

/**
 * Requests a first-person reply first, then privately extracts any explicit
 * commitment from that exact reply. A failed intent pass never discards the
 * visible reply; any extracted choice is still revalidated by local rules.
 */
export async function requestAgentInteraction(input: AgentInteractionRequest): Promise<AgentInteractionResult> {
  const message = requiredInputText(input.message, MAX_USER_MESSAGE_CHARS, '玩家消息');
  const maxOutputTokens = interactionMaxOutputTokens();
  const endpoint = resolveModelEndpoint('interaction', input.endpointId);
  const localContext = buildAgentInteractionContext(input.context, input.requestKind, message);
  const askedTopic = unsupportedDefinitionTopic(message, localContext);
  if (askedTopic) {
    localContext.epistemicBoundary = {
      unknownTopic: askedTopic,
      rule: '人物没有这个概念的来源；保持不知道这一事实，但按自己的 Soul 自然表达，可以追问主指的是什么',
    };
  }
  let messages = buildAgentInteractionMessages(input, message, localContext);
  let usage = { inputTokens: 0, outputTokens: 0 };
  let replyResult: Pick<AgentInteractionResult, 'reply' | 'grounding' | 'evidenceIds'> | undefined;
  let replyModel: Pick<AgentInteractionResult, 'endpointId' | 'protocol' | 'model'> | undefined;

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
      replyResult = parseInteractionReply(localContext, response.text);
      replyModel = {
        endpointId: response.endpointId,
        protocol: response.protocol,
        model: response.model,
      };
      break;
    } catch (error) {
      if (attempt === 1) {
        throw new ModelRequestError(
          'invalid-response',
          `模型端点 ${endpoint.id} 的人物回复无效：${error instanceof Error ? error.message : String(error)}`,
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

  if (!replyResult || !replyModel) {
    throw new ModelRequestError('invalid-response', `模型端点 ${endpoint.id} 没有返回合法的人物回复`);
  }

  let intentResult: Pick<AgentInteractionResult, 'stance' | 'guidance' | 'reason' | 'choice'> = {
    stance: 'answer',
  };
  const actionChoiceRequested = (localContext.interaction as { actionChoiceRequested?: unknown } | undefined)
    ?.actionChoiceRequested === true;
  if (actionChoiceRequested) {
    try {
      const intentResponse = await requestModelText(endpoint, {
        messages: buildAgentInteractionIntentMessages(message, replyResult.reply, localContext),
        maxOutputTokens: Math.min(maxOutputTokens, 1_000),
        temperature: 0,
        jsonObject: true,
        timeoutMs: interactionTimeout(endpoint),
      });
      usage = {
        inputTokens: usage.inputTokens + intentResponse.usage.inputTokens,
        outputTokens: usage.outputTokens + intentResponse.usage.outputTokens,
      };
      intentResult = parseInteractionIntent(input.context, localContext, intentResponse.text);
    } catch (error) {
      console.warn(
        `模型端点 ${endpoint.id} 的隐藏人物意图未能解析；保留角色回复且不形成行动：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    ...replyResult,
    ...intentResult,
    ...replyModel,
    usage,
  };
}
