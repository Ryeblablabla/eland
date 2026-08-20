import type {
  PersonSoul,
  PersonSoulFacetId,
  PersonSoulSceneFacet,
} from '../src/game/eland/domain/person-soul';

export interface ContextualMemoryLike {
  kind: string;
  summary: string;
  importance: number;
  personIds?: readonly string[];
}

export interface CommunicationProfile {
  band: 'very-limited' | 'limited' | 'ordinary' | 'expressive';
  ageBand: 'very-young-child' | 'child' | 'adolescent' | 'adult';
  guidance: string;
}

export interface PersonaFrame {
  version: 'persona-frame-v1';
  activatedFacet: PersonSoulSceneFacet;
  recalledMemorySourceIds: string[];
  presentTension: string;
  relationalStance: string;
  speechMove: string;
  rule: string;
}

const TOPIC_GROUPS = [
  ['水', '喝', '渴', '缺水', '饮水', 'water', 'drink', 'thirst'],
  ['食物', '吃', '饿', '营养', '粮', '果', 'food', 'eat', 'hunger'],
  ['危险', '伤', '病', '死', '猛兽', '攻击', '火', 'danger', 'hurt', 'illness', 'death'],
  ['冷', '热', '天气', '恒纪元', '乱纪元', '气候', 'cold', 'heat', 'weather', 'climate'],
  ['家人', '父', '母', '孩子', '女儿', '儿子', '姐妹', '兄弟', '亲人', 'family', 'parent', 'child'],
  ['答应', '承诺', '约定', '责任', '完成', '工作', '项目', 'promise', 'commitment', 'work'],
  ['帮助', '照顾', '感谢', '信任', '喜欢', '关系', '朋友', 'help', 'care', 'trust', 'friend'],
  ['拒绝', '命令', '控制', '逼', '冲突', '伤害', '不同意', 'refuse', 'control', 'conflict'],
  ['知道', '发现', '学习', '记录', '陌生', '为什么', '怎么', 'knowledge', 'learn', 'discover'],
  ['建造', '住所', '庇护', '房', '储藏', '容器', 'build', 'shelter', 'storage'],
] as const;

const COMMON_BIGRAMS = new Set([
  '什么', '怎么', '为什么', '现在', '这个', '那个', '你是', '我是', '我们', '你们',
  '可以', '是否', '知道', '告诉', '觉得', '认为', '已经', '还是', '没有', '一个',
]);

function normalized(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function topicKeys(value: string): Set<number> {
  const text = normalized(value);
  const result = new Set<number>();
  TOPIC_GROUPS.forEach((terms, index) => {
    if (terms.some((term) => text.includes(term))) result.add(index);
  });
  return result;
}

function meaningfulBigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (const run of normalized(value).match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!COMMON_BIGRAMS.has(bigram)) result.add(bigram);
    }
  }
  for (const token of value.toLocaleLowerCase('zh-CN').match(/[a-z0-9][a-z0-9._+-]{2,}/gu) ?? []) {
    result.add(token);
  }
  return result;
}

function overlapSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function memoryRelevance(
  memory: ContextualMemoryLike,
  queryTopics: Set<number>,
  queryBigrams: Set<string>,
  participantIds: Set<string>,
): number {
  const participantMatch = memory.personIds?.some((personId) => participantIds.has(personId)) ? 70 : 0;
  const memoryTopics = topicKeys(memory.summary);
  let sharedTopics = 0;
  for (const key of queryTopics) if (memoryTopics.has(key)) sharedTopics += 1;
  const sharedBigrams = overlapSize(queryBigrams, meaningfulBigrams(memory.summary));
  return participantMatch + Math.min(54, sharedTopics * 18) + Math.min(30, sharedBigrams * 6);
}

/**
 * Select a small memory packet by current topic and participant before falling
 * back to durable commitments, failures and general salience. The selector is
 * deterministic and never synthesizes or rewrites a memory.
 */
export function selectContextualMemories<T extends ContextualMemoryLike>(
  memories: readonly T[],
  options: { query: string; participantIds?: readonly string[]; maximum?: number },
): T[] {
  const maximum = Math.max(1, Math.min(8, options.maximum ?? 6));
  const queryTopics = topicKeys(options.query);
  const queryBigrams = meaningfulBigrams(options.query);
  const participantIds = new Set(options.participantIds ?? []);
  const ranked = memories.map((memory, index) => {
    const relevance = memoryRelevance(memory, queryTopics, queryBigrams, participantIds);
    const durability = memory.kind === 'commitment' ? 24 : memory.kind === 'failure' ? 15 : memory.kind === 'summary' ? 4 : 0;
    return { memory, index, relevance, score: relevance + memory.importance + durability };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: typeof ranked = [];
  const used = new Set<T>();
  const add = (candidate: (typeof ranked)[number] | undefined) => {
    if (!candidate || used.has(candidate.memory) || selected.length >= maximum) return;
    used.add(candidate.memory);
    selected.push(candidate);
  };

  ranked.filter((candidate) => candidate.relevance > 0).slice(0, 3).forEach(add);
  add(ranked.find((candidate) => candidate.memory.kind === 'commitment'));
  add(ranked.find((candidate) => candidate.memory.kind === 'failure'));
  ranked.forEach(add);
  return selected.slice(0, maximum).map((candidate) => candidate.memory);
}

export function communicationProfile(capacity: number, ageMonths: number): CommunicationProfile {
  const ageBand = ageMonths < 48
    ? 'very-young-child'
    : ageMonths < 132 ? 'child' : ageMonths < 216 ? 'adolescent' : 'adult';
  const band = capacity < 30
    ? 'very-limited'
    : capacity < 45 ? 'limited' : capacity < 70 ? 'ordinary' : 'expressive';
  const ageGuidance = ageBand === 'very-young-child'
    ? '使用很短、具体、贴近眼前感受的句子'
    : ageBand === 'child'
      ? '使用儿童能够自然说出的具体句式，不写成年人的抽象自我分析'
      : ageBand === 'adolescent'
        ? '可以表达判断和矛盾，但少用成熟的概念化总结'
        : '可以按本人能力完整表达，但不写成说明书';
  const capacityGuidance = band === 'very-limited'
    ? '一次只表达一个核心意思，允许不完整句和停顿'
    : band === 'limited'
      ? '句子偏短，只给最必要的理由'
      : band === 'ordinary'
        ? '自然回应，可展开一个具体理由或一段亲历'
        : '可以更精确地组织措辞，但仍保持当面说话感';
  return { band, ageBand, guidance: `${ageGuidance}；${capacityGuidance}` };
}

function facetById(soul: PersonSoul, id: PersonSoulFacetId): PersonSoulSceneFacet {
  return soul.sceneFacets.find((facet) => facet.id === id) ?? soul.sceneFacets[0]!;
}

function chooseFacetId(input: {
  message: string;
  actionChoiceRequested: boolean;
  body?: { health?: number; hydration?: number; nutrition?: number };
  conditions?: readonly { kind: string; stage: number }[];
  hasCurrentCommitment: boolean;
  playerIdentityQuestion: boolean;
}): PersonSoulFacetId {
  const text = normalized(input.message);
  const acuteBody = [input.body?.health, input.body?.hydration, input.body?.nutrition]
    .some((value) => typeof value === 'number' && value < 35);
  const acuteCondition = input.conditions?.some((condition) => condition.stage >= 2) ?? false;
  if (acuteBody || acuteCondition || /危险|受伤|病|害怕|怕|死|猛兽|攻击|冷|热|danger|hurt|afraid|death/iu.test(text)) {
    return 'danger-and-loss';
  }
  if (input.actionChoiceRequested || /建议|请求|命令|应该|必须|愿不愿意|答应|拒绝|交换|控制|逼|suggest|request|must|should|refuse/iu.test(text)) {
    return 'autonomy-and-proposals';
  }
  if (input.playerIdentityQuestion || /信任|喜欢|讨厌|朋友|家人|亲人|感谢|关系|记得我|trust|friend|family|thank/iu.test(text)) {
    return 'trust-and-closeness';
  }
  if (/不知道|是什么|为什么|怎么|如何|发现|学习|陌生|试试|unknown|why|how|learn|discover/iu.test(text)) {
    return 'uncertainty-and-change';
  }
  if (input.hasCurrentCommitment || /承诺|答应|完成|继续|工作|计划|责任|项目|promise|finish|work|plan/iu.test(text)) {
    return 'commitment-and-work';
  }
  return 'trust-and-closeness';
}

export function buildPersonaFrame(input: {
  soul: PersonSoul;
  message: string;
  actionChoiceRequested: boolean;
  choiceEnabled: boolean;
  playerIdentityQuestion: boolean;
  body?: { health?: number; hydration?: number; nutrition?: number };
  conditions?: readonly { kind: string; stage: number }[];
  hasCurrentCommitment: boolean;
  recalledMemorySourceIds: string[];
}): PersonaFrame {
  const facet = facetById(input.soul, chooseFacetId(input));
  const presentTension = input.actionChoiceRequested
    ? input.choiceEnabled
      ? '认真回应主的提议，同时保留本人在当前合法方向中的独立判断，不提前宣称结果'
      : '可以表达态度，但眼下不能把话变成新的行动承诺'
    : input.hasCurrentCommitment
      ? '回答主正在问的事，同时不让尚未完成的责任和眼前话题互相冒充'
      : facet.innerTension;
  return {
    version: 'persona-frame-v1',
    activatedFacet: facet,
    recalledMemorySourceIds: input.recalledMemorySourceIds,
    presentTension,
    relationalStance: '主是当前必须回应的对话对象；这不自动等于信任、亲近、服从、耐心解释或接受建议',
    speechMove: facet.speechTendency,
    rule: '只激活这一人格侧面；相关记忆可以改变态度和措辞，但不能创造新事实、关系、能力或承诺',
  };
}
