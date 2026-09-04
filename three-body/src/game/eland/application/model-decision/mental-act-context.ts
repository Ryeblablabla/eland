import {
  buildCompactDecisionRequestContext,
  type CompactDecisionRequestContext,
} from './compact-context';
import {
  buildCharacterAgendaProbeCandidates,
  type CharacterAgendaProbeCandidates,
  type DecisionProbeHandleMap,
} from './capability-handles';
import type { DecisionRequestContext } from './decision-context';
import { MBTI_PERSONA_PRESETS, type MbtiType } from '../../mbti-persona-presets';
import { materialDefinition, materialHas } from '../../domain/material';
import type { PersonState } from '../../domain/person';

export interface MentalActRequestContext {
  schemaVersion: 'mental-act-context-v5';
  person: Record<string, unknown>;
  situation: Record<string, unknown>;
  origin?: {
    background: string[];
    initialIntention: string;
  };
  mind: {
    activeConcerns: string[];
    recentEvidence: string[];
    learnedConclusions: string[];
    relatedRecall: string[];
  };
  current: Record<string, unknown>;
  recentDialogue: unknown[];
  visible: Record<string, unknown>;
  availableSteps: Array<Record<string, unknown> & { handle: string }>;
  continuations: Array<Record<string, unknown> & { handle: string }>;
  actionSpace: {
    operations: Array<{ kind: 'observe' | 'combine' | 'expose' | 'exert' | 'move'; meaning: string }>;
    heldObjects: Array<Record<string, unknown> & { ref: string }>;
  };
  /**
   * Coarse hints derived solely from the person's own reliable craft
   * knowledge and current inventory ("再取得木材即可制作水轮"). They never
   * name world state the person could not know; they only join two facts the
   * person already owns so a small model does not lose the logistics thread.
   */
  knownCraftHints?: string[];
  personalityPreset?: Record<string, unknown>;
}

export type MindActionPossibilityKind =
  | 'open-world-interaction'
  | 'observe'
  | 'combine'
  | 'expose'
  | 'exert'
  | 'move'
  | 'acquire'
  | 'survive'
  | 'care'
  | 'talk'
  | 'coordinate'
  | 'continue-project'
  | 'produce'
  | 'reproduce'
  | 'mortuary-care'
  | 'known-craft'
  | 'open-craft'
  | 'other';

export interface MindActionPossibility {
  kind: MindActionPossibilityKind;
  description: string;
}

/** Mind sees coarse affordance kinds, never prepared choices or entity handles. */
export interface MindIntentionRequestContext {
  schemaVersion: 'mind-intention-context-v5';
  person: MentalActRequestContext['person'];
  situation: MentalActRequestContext['situation'];
  origin?: NonNullable<MentalActRequestContext['origin']>;
  mind: MentalActRequestContext['mind'];
  current: Record<string, unknown>;
  recentDialogue: MentalActRequestContext['recentDialogue'];
  visible: MentalActRequestContext['visible'];
  actionPossibilities: {
    availableNow: MindActionPossibility[];
    agency: string;
  };
  personalityPreset?: NonNullable<MentalActRequestContext['personalityPreset']>;
}

export type MindIntentionOrientation =
  | 'social'
  | 'inquiry'
  | 'survival'
  | 'construction'
  | 'acquisition'
  | 'exploration'
  | 'rest';

export interface MindIntentionDraft {
  utterance: string;
  delivery: 'whisper' | 'normal' | 'call';
  goal: string;
  /** Subjective direction only; Plan still chooses the concrete executable entry. */
  orientation?: MindIntentionOrientation;
  /** The person decides whether this goal should survive the current turn. */
  horizon?: 'momentary' | 'ongoing';
}

/** Plan receives one frozen intention and chooses how it enters the existing executor. */
export interface ModelPlanRequestContext {
  schemaVersion: 'model-plan-context-v1';
  intention: MindIntentionDraft;
  mind: MentalActRequestContext['mind'];
  current: MentalActRequestContext['current'];
  recentDialogue: MentalActRequestContext['recentDialogue'];
  visible: MentalActRequestContext['visible'];
  availableSteps: MentalActRequestContext['availableSteps'];
  continuations: MentalActRequestContext['continuations'];
  actionSpace: MentalActRequestContext['actionSpace'];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function uniqueText(values: Array<string | undefined>, limit: number): string[] {
  return [...new Set(values.map((value) => value?.replace(/\s+/gu, ' ').trim()).filter(Boolean) as string[])]
    .slice(0, limit);
}

function lifeStage(ageMonths: number): string {
  if (ageMonths < 12) return '需要照料的婴幼儿';
  if (ageMonths < 12 * 12) return '正在学习的儿童';
  if (ageMonths < 16 * 12) return '能够参加部分工作的少年';
  return '成年';
}

function reserveState(value: number, kind: 'health' | 'hydration' | 'nutrition'): string {
  if (kind === 'health') {
    if (value < 25) return '生命状态危险';
    if (value < 45) return '身体明显受损';
    if (value < 75) return '身体有些虚弱';
    return '身体健康';
  }
  if (kind === 'hydration') {
    if (value < 28) return '严重缺水，需要立即处理';
    if (value < 45) return '明显口渴';
    if (value < 58) return '有些口渴';
    return '当前不缺水';
  }
  if (value < 28) return '严重饥饿，需要立即处理';
  if (value < 45) return '明显饥饿';
  if (value < 52) return '有些饥饿';
  return '当前不饥饿';
}

function physicalState(value: unknown): string {
  const person = object(value);
  const nestedBody = object(person.body);
  const body = Object.keys(nestedBody).length ? nestedBody : person;
  const conditions = rows(person.conditions).map((conditionValue) => {
    const condition = object(conditionValue);
    const kind = stringValue(condition.kind);
    const stage = numberValue(condition.stage);
    return kind ? `${kind}${stage > 0 ? `（程度 ${stage}）` : ''}` : undefined;
  });
  return uniqueText([
    reserveState(numberValue(body.health), 'health'),
    reserveState(numberValue(body.hydration), 'hydration'),
    reserveState(numberValue(body.nutrition), 'nutrition'),
    conditions.length ? `身体状况：${conditions.filter(Boolean).join('、')}` : undefined,
  ], 4).join('；');
}

const CAPABILITY_NAMES: Record<string, string> = {
  locomotion: '移动',
  manipulation: '动手操作',
  perception: '观察',
  communication: '交流',
  cognition: '思考',
};

function capabilityBand(value: number): string {
  if (value < 35) return '很受限';
  if (value < 50) return '较弱';
  if (value < 70) return '普通';
  if (value < 85) return '良好';
  return '很强';
}

function capabilitySummary(value: unknown): string[] {
  const capacities = object(value);
  return Object.entries(CAPABILITY_NAMES).flatMap(([key, name]) => (
    typeof capacities[key] === 'number'
      ? [`${name}能力${capabilityBand(numberValue(capacities[key]))}`]
      : []
  ));
}

function semanticCharacter(value: unknown): string[] {
  const person = object(value);
  const soul = object(person.soul);
  const note = object(person.characterNote);
  const facet = object(note.activeFacet);
  const reaction = object(note.activeReaction);
  return uniqueText([
    stringValue(soul.innerVoice),
    stringValue(facet.attention),
    stringValue(facet.innerTension),
    stringValue(reaction.responseTendency),
    stringValue(note.responseShape),
  ], 4);
}

function semanticPersonalityPreset(value: unknown): Record<string, unknown> | undefined {
  const person = object(value);
  const personalityType = stringValue(person.personalityType) as MbtiType;
  const personalityPreset = MBTI_PERSONA_PRESETS[personalityType];
  if (!personalityPreset) return undefined;
  return {
    type: personalityPreset.type,
    name: personalityPreset.name,
    summary: personalityPreset.summary,
    attention: personalityPreset.attention,
    innerTension: personalityPreset.innerTension,
    responseTendency: personalityPreset.responseTendency,
    speechTendency: personalityPreset.speechTendency,
  };
}

function semanticPerson(value: unknown): Record<string, unknown> {
  const person = object(value);
  return {
    id: stringValue(person.id),
    name: stringValue(person.name),
    lifeStage: lifeStage(numberValue(person.ageMonths)),
    physicalState: physicalState(person),
    capabilities: capabilitySummary(person.capacities),
    character: semanticCharacter(person),
  };
}

const FOUNDER_INITIAL_INTENTIONS: Record<string, string> = {
  'danger-and-loss': '先确认自己和身边的人在陌生环境中是否安稳',
  'autonomy-and-proposals': '先看清周围处境，决定一件自己真正愿意开始的事',
  'trust-and-closeness': '先了解共同抵达的人，判断自己愿意与谁建立联系',
  'commitment-and-work': '先找出一件值得自己承担并持续推进的事',
  'uncertainty-and-change': '先从眼前陌生事物中找出一个值得弄清的问题',
};

function founderInitialIntention(person: Record<string, unknown>): string {
  const note = object(person.characterNote);
  const reactionId = stringValue(object(note.activeReaction).id);
  if (/care|sensitivity/u.test(reactionId)) return '先了解身边的人是否安稳，留意自己愿意提供的真实帮助';
  if (/sociability|restraint|relationship/u.test(reactionId)) return '先了解共同抵达的人，判断自己愿意与谁建立联系';
  if (/autonomy|assertiveness|principle|proposal/u.test(reactionId)) {
    return '先看清周围处境，决定一件符合自己判断并愿意承担的事';
  }
  if (/duty|practicality|resilience|setback/u.test(reactionId)) {
    return '先找出一件值得自己承担并持续推进的事';
  }
  if (/inquiry|imagination|adaptation|caution/u.test(reactionId)) {
    return '先从眼前陌生事物中找出一个值得弄清的问题';
  }
  const activeFacet = object(note.activeFacet);
  return FOUNDER_INITIAL_INTENTIONS[stringValue(activeFacet.id)]
    ?? '先根据自己的性格和眼前处境，形成一件真正想维持、改变或弄清的事';
}

function semanticFounderOrigin(
  personValue: unknown,
  situationValue: unknown,
  heldObjects: MentalActRequestContext['actionSpace']['heldObjects'],
): MentalActRequestContext['origin'] {
  const situation = object(situationValue);
  if (numberValue(situation.month) !== 1) return undefined;
  const person = object(personValue);
  const initialIntention = founderInitialIntention(person);
  const carried = heldObjects.map((item) => {
    const quantity = numberValue(item.quantity);
    const name = stringValue(item.name) || '随身物品';
    return `${quantity > 0 ? `${quantity} 份` : ''}${name}`;
  }).filter(Boolean);
  return {
    background: [
      '你与周围的先民刚在这片自然地表共同开始生活，彼此只有共同抵达带来的基本熟悉。',
      carried.length ? `你随身带着 ${carried.join('、')}。` : '你没有随身物资。',
      '你们还没有形成持续工作、约定或共同体；眼前世界仍然陌生，未知结果只能通过亲身经历确认。',
    ],
    initialIntention,
  };
}

interface MindSections {
  activeConcerns: string[];
  recentEvidence: string[];
  learnedConclusions: string[];
  relatedRecall: string[];
}

const MIND_SECTION_KEYS: Record<string, keyof MindSections> = {
  当前未决: 'activeConcerns',
  近期证据: 'recentEvidence',
  已学结论: 'learnedConclusions',
  当前相关回忆: 'relatedRecall',
  // Old snapshots remain readable, but old deliberation sections are ignored.
  当前关切: 'activeConcerns',
  经历: 'recentEvidence',
  信念: 'learnedConclusions',
};

/** Keep request handles, discard compiler metadata, and bound every memory lane. */
function semanticMind(value: unknown): MindSections {
  const result: MindSections = {
    activeConcerns: [],
    recentEvidence: [],
    learnedConclusions: [],
    relatedRecall: [],
  };
  if (typeof value !== 'string') return result;
  let section: keyof MindSections | undefined;
  const limits: Record<keyof MindSections, number> = {
    activeConcerns: 3,
    recentEvidence: 6,
    learnedConclusions: 8,
    relatedRecall: 4,
  };
  const seen = new Map<keyof MindSections, Set<string>>(
    (Object.keys(result) as Array<keyof MindSections>).map((key) => [key, new Set<string>()]),
  );
  for (const sourceLine of value.split('\n')) {
    const heading = /^#\s+(.+)$/u.exec(sourceLine.trim());
    if (heading) {
      section = MIND_SECTION_KEYS[heading[1].trim()];
      continue;
    }
    if (!section || result[section].length >= limits[section]) continue;
    const item = /^-\s+(.+)$/u.exec(sourceLine.trim())?.[1]
      ?.replace(/^\[m(\d+)\]\s+/u, (_match, raw: string) => Number(raw) <= 20 ? `[m${raw}] ` : '')
      .replace(/^\[g(\d+)\]\s+/u, (_match, raw: string) => Number(raw) <= 3 ? `[g${raw}] ` : '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 240);
    if (!item) continue;
    const content = item
      .replace(/^\[[gm]\d+\]\s*/u, '')
      .replace(/[（(][^）)]*[）)]/gu, '')
      .replace(section === 'activeConcerns' ? /^(?:确认|弄清|验证|继续)/u : /$^/u, '')
      .replace(/[\s，。；：、？！“”‘’"']/gu, '')
      .toLowerCase();
    if (!content || seen.get(section)!.has(content)) continue;
    seen.get(section)!.add(content);
    result[section].push(item);
  }
  return result;
}

const CLIMATE_NAMES: Record<string, string> = {
  temperate: '温和气候',
  cold: '严寒气候',
  heat: '酷热气候',
  fire: '烈焰环境',
};

const WEATHER_NAMES: Record<string, string> = {
  clear: '晴朗',
  rain: '下雨',
  storm: '风暴',
  drought: '干旱',
  snow: '降雪',
};

function semanticSituation(value: unknown): Record<string, unknown> {
  const situation = object(value);
  const climate = object(situation.climate);
  const weather = object(situation.weather);
  const month = numberValue(situation.month);
  const tick = numberValue(situation.planningTick);
  const intensity = numberValue(weather.intensity);
  const climateName = CLIMATE_NAMES[stringValue(climate.kind)] ?? (stringValue(climate.kind) || '气候未知');
  const weatherName = WEATHER_NAMES[stringValue(weather.kind)] ?? (stringValue(weather.kind) || '天气未知');
  const pressures = rows(situation.activePressures).flatMap((pressureValue) => {
    const pressure = object(pressureValue);
    const consequences = rows(pressure.consequences).map(stringValue).filter(Boolean);
    const kind = stringValue(pressure.kind);
    return kind ? [`${kind}${consequences.length ? `：${consequences.join('、')}` : ''}`] : [];
  });
  return {
    time: `第 ${month} 月${tick > 0 ? `，本月第 ${tick} 个规划时刻` : ''}`,
    era: situation.epoch === 'chaotic' ? '乱纪元' : '恒纪元',
    environment: `${climateName}；${weatherName}${intensity >= 3 ? '，影响强烈' : intensity >= 2 ? '，影响明显' : '，影响轻微'}`,
    urgentPressures: pressures.length ? pressures : ['没有正在伤害身体的紧迫压力'],
  };
}

const AGREEMENT_KINDS: Record<string, string> = {
  assist: '协助约定',
  exchange: '交换约定',
  jointProject: '共同项目约定',
  reproduce: '生育约定',
  companion: '陪伴约定',
};

const AGREEMENT_STATUS: Record<string, string> = {
  proposed: '等待回应',
  active: '已经生效',
  fulfilled: '已经履行',
  breached: '已经违约',
  rejected: '已经拒绝',
  withdrawn: '已经撤回',
  expired: '已经过期',
};

function progressSummary(value: unknown): string {
  const progress = numberValue(value);
  if (progress <= 0) return '尚未开始';
  if (progress < 0.5) return '已经开始，但还在前半段';
  if (progress < 1) return '已经推进过半';
  return '已经完成';
}

function semanticCurrent(value: unknown): Record<string, unknown> {
  const current = object(value);
  const activeIntent = object(current.activeIntent);
  const activeProject = object(current.activeProject);
  const materialPlan = object(activeProject.materialPlan);
  const agreements = rows(current.agreements).map((agreementValue) => {
    const agreement = object(agreementValue);
    const kind = AGREEMENT_KINDS[stringValue(agreement.kind)] ?? (stringValue(agreement.kind) || '约定');
    const state = AGREEMENT_STATUS[stringValue(agreement.status)] ?? (stringValue(agreement.status) || '状态未知');
    const ownState = agreement.requiresOwnResponse
      ? '现在需要本人回应'
      : agreement.fulfilledBySelf
        ? '本人已经完成自己的部分'
        : agreement.acceptedBySelf
          ? '本人已经接受，但还没有完成自己的部分'
          : '本人尚未接受';
    return {
      kind,
      state,
      ownState,
      ...(typeof agreement.dueAtMonth === 'number' ? { due: `第 ${agreement.dueAtMonth} 月` } : {}),
    };
  });
  const collectives = rows(current.collectives).map((collectiveValue) => {
    const collective = object(collectiveValue);
    return {
      purpose: stringValue(collective.purposeSummary),
      state: stringValue(collective.status),
      members: numberValue(collective.activeMemberCount),
    };
  });
  return {
    ...(stringValue(activeIntent.summary) ? {
      activeWork: {
        summary: stringValue(activeIntent.summary),
        progress: progressSummary(activeIntent.progress),
        nextStepType: stringValue(activeIntent.nextActionKind),
      },
    } : {}),
    ...(stringValue(activeProject.summary) ? {
      activeProject: {
        summary: stringValue(activeProject.summary),
        need: stringValue(activeProject.need),
        state: stringValue(activeProject.status),
        contributors: numberValue(activeProject.contributorCount),
        materialSituation: materialPlan.status === 'verified'
          ? `材料方案已经验证${rows(materialPlan.missingMaterials).length ? `，仍缺少${rows(materialPlan.missingMaterials).map((item) => stringValue(object(item).name)).filter(Boolean).join('、')}` : ''}`
          : materialPlan.status === 'unresolved'
            ? '材料方案仍不清楚，需要观察或提出实验'
            : undefined,
      },
    } : {}),
    suspendedWork: rows(current.suspendedIntents).slice(0, 2).map((intentValue) => stringValue(object(intentValue).summary)).filter(Boolean),
    agreements,
    collectives,
  };
}

function semanticMindCurrent(
  value: unknown,
  availableSteps: MentalActRequestContext['availableSteps'],
): Record<string, unknown> {
  const current = object(value);
  const activeWork = object(current.activeWork);
  const pressingMatters = availableSteps
    .filter((step) => stringValue(step.priority) !== '可以选择')
    .filter((step, index, all) => all.findIndex((candidate) => (
      stringValue(candidate.action) === stringValue(step.action)
    )) === index)
    .slice(0, 3)
    .map((step) => ({
      matter: stringValue(step.action),
      situation: stringValue(step.priority),
      purpose: stringValue(step.purpose),
    }));
  return {
    ...(stringValue(activeWork.summary) ? { ongoingCommitment: stringValue(activeWork.summary) } : {}),
    ...(pressingMatters.length ? { pressingMatters } : {}),
    agreements: rows(current.agreements),
    collectives: rows(current.collectives),
  };
}

const PROPERTY_NAMES: Record<string, string> = {
  solid: '固体',
  liquid: '液体',
  gas: '气体',
  plume: '气团',
  fluid: '可流动',
  'compact-body': '块状',
  'structural-member': '长条结构',
  'shaped-object': '已经成形',
  'flexible-strand': '柔软纤维状',
  'flexible-sheet': '柔软片状',
  'plant-bundle': '植物束状',
  'granular-body': '颗粒状',
  warm: '暖色外观',
  cool: '冷色外观',
  dark: '颜色较深',
  pale: '颜色较浅',
  mineral: '矿物外观',
  organic: '有机物外观',
  earthen: '土质外观',
  neutral: '中性外观',
  trace: '极轻',
  light: '轻便',
  'hand-load': '可以手持搬运',
  burdensome: '沉重',
  pliant: '柔软',
  workable: '可以加工',
  rigid: '坚硬',
  'very-rigid': '非常坚硬',
};

function perceivedAs(value: unknown): string {
  return uniqueText(rows(value).map((property) => (
    PROPERTY_NAMES[stringValue(property)] ?? stringValue(property)
  )), 5).join('、');
}

const SPECIES_NAMES: Record<string, string> = {
  deer: '鹿',
  rabbit: '兔',
  wolf: '狼',
};

function relationSummary(person: Record<string, unknown> | undefined): string | undefined {
  if (!person) return undefined;
  const fear = numberValue(person.fear);
  const trust = numberValue(person.trust);
  const bond = numberValue(person.bond);
  if (fear >= 45) return '本人明显害怕这个人';
  if (bond >= 45) return '关系亲近';
  if (trust >= 25) return '比较信任';
  if (trust >= 12 || bond >= 12) return '彼此熟悉';
  return '关系普通';
}

function semanticVisible(
  compactVisibleValue: unknown,
  candidates: CharacterAgendaProbeCandidates,
  openWorldFacts: NonNullable<DecisionRequestContext['visibleOpenWorldFacts']>,
  works: NonNullable<DecisionRequestContext['visibleWorks']> = [],
): Record<string, unknown> {
  const compactVisible = object(compactVisibleValue);
  const peopleByHandle = new Map(rows(compactVisible.people).flatMap((personValue) => {
    const person = object(personValue);
    const handle = stringValue(person.handle);
    return handle ? [[handle, person] as const] : [];
  }));
  const nearbyObjects = candidates.visible.map((candidate) => {
    const item = object(candidate);
    const handle = stringValue(item.handle);
    const kind = stringValue(item.kind);
    if (kind === 'person') {
      const detail = peopleByHandle.get(handle);
      return {
        ref: handle,
        kind: '人物',
        name: stringValue(item.name),
        lifeStage: lifeStage(numberValue(item.ageMonths)),
        ...(relationSummary(detail) ? { relation: relationSummary(detail) } : {}),
        ...(detail ? { physicalState: physicalState(detail) } : {}),
      };
    }
    if (kind === 'animal') {
      const trust = numberValue(item.bondTrust);
      return {
        ref: handle,
        kind: '动物',
        name: SPECIES_NAMES[stringValue(item.speciesId)] ?? stringValue(item.speciesId),
        ...(trust >= 45 ? { disposition: '对你放松，不再躲避' } : trust > 0 ? { disposition: '对你仍有戒备' } : {}),
      };
    }
    if (kind === 'drop') return {
      ref: handle,
      kind: '地面物品',
      name: stringValue(item.name),
      perceivedAs: perceivedAs(item.properties),
      quantity: numberValue(item.quantity),
    };
    return {
      ref: handle,
      kind: '容器',
      capacityState: numberValue(item.usedCapacity) >= numberValue(item.capacity) ? '已经装满' : '还有空间',
    };
  }).filter((candidate, index, all) => all.findIndex((other) => (
    other.ref === candidate.ref
      || candidate.kind === '地面物品'
        && other.kind === candidate.kind
        && other.name === candidate.name
        && other.perceivedAs === candidate.perceivedAs
  )) === index);
  const surfaces = candidates.voxels.map((item) => ({
    ref: item.handle,
    name: item.name,
    perceivedAs: perceivedAs(item.properties),
  })).filter((candidate, index, all) => all.findIndex((other) => (
    other.name === candidate.name && other.perceivedAs === candidate.perceivedAs
  )) === index);
  const heldPossessions = [...candidates.held.reduce((grouped, item) => {
    const perceived = perceivedAs(item.properties);
    const key = `${item.name}\u0000${perceived}`;
    const current = grouped.get(key);
    grouped.set(key, {
      name: item.name,
      perceivedAs: perceived,
      quantity: (current?.quantity ?? 0) + item.quantity,
    });
    return grouped;
  }, new Map<string, { name: string; perceivedAs: string; quantity: number }>()).values()];
  return {
    // Mind receives a complete, identity-free overview. Exact request-scoped
    // refs stay in Plan.actionSpace, where a concrete action is chosen.
    heldPossessions,
    nearbyObjects,
    surfaces,
    ...(openWorldFacts.length ? {
      openWorldChanges: openWorldFacts.map((fact) => (
        fact.stateKey && fact.stateValue
          ? `第 ${fact.atMonth} 月：${fact.stateKey}=${fact.stateValue}；${fact.summary}`
          : `第 ${fact.atMonth} 月：${fact.summary}`
      )),
    } : {}),
    ...(works.length ? {
      personMadeWorks: works.map((work) => (
        `${work.summary}（${work.components.map((component) => `${component.name}×${component.quantity}`).join('、')}；${work.builders.join('、')}所建；目前${work.condition}）`
      )),
    } : {}),
  };
}

const PURPOSE_NAMES: Record<string, string> = {
  homeostasis: '照顾自身生存状态',
  safety: '处理安全问题',
  resource: '取得资源',
  care: '照顾他人',
  inquiry: '观察或验证问题',
  project: '推进项目',
  conversation: '与人交谈',
  reproduction: '处理生育关系',
  'social-coordination': '协调共同事务',
  'mortuary-care': '处理遗体与悼念',
  'spatial-comfort': '改善所处位置',
  movement: '移动',
  production: '进行生产',
  other: '处理其他事情',
};

function durationSummary(value: unknown): string | undefined {
  const months = numberValue(value);
  if (!months) return undefined;
  if (months <= 1) return '大约一个月';
  return `大约 ${Math.round(months)} 个月`;
}

function outcomeSummary(value: unknown): string[] {
  const outcomes = object(value);
  const similar = object(outcomes.similarAction);
  const goal = object(outcomes.intendedGoal);
  const result: string[] = [];
  const attempts = numberValue(similar.attempts);
  if (attempts > 0) {
    result.push(`类似行动亲历 ${attempts} 次：完成 ${numberValue(similar.completed)} 次，有进展 ${numberValue(similar.progressed)} 次，受阻 ${numberValue(similar.blocked)} 次，失败 ${numberValue(similar.failed)} 次`);
  }
  const goalAttempts = numberValue(goal.attempts);
  if (goalAttempts > 0) {
    result.push(`类似目标亲历 ${goalAttempts} 次：达成 ${numberValue(goal.achieved)} 次，尝试后未达成 ${numberValue(goal.attemptedUnmet)} 次`);
  }
  return result;
}

function stepPriority(value: unknown): string {
  const obligation = stringValue(object(value).obligation);
  if (obligation === 'required-response') return '必须先回应';
  if (obligation === 'commitment-action') return '必须先履行';
  return '可以选择';
}

function orderedModelSteps(options: Array<Record<string, unknown> & { id: string }>) {
  const required = options.filter((option) => stringValue(object(option.semantics).obligation) !== 'optional');
  const requiredIds = new Set(required.map((option) => option.id));
  const optional = options.filter((option) => !requiredIds.has(option.id));
  return [
    ...required,
    ...optional,
  ];
}

function isCompilerSelectedOpenTrial(
  context: DecisionRequestContext,
  step: Record<string, unknown> & { id: string },
): boolean {
  const index = /^o([1-9]\d*)$/u.exec(step.id);
  const option = index ? context.options[Number(index[1]) - 1] : undefined;
  if (!option || option.semantics.obligation !== 'optional') return false;
  return option.id.includes(':hypothesis-')
    || /^(?:try-inventory-combine|try-combine|try-exert|try-expose):/u.test(option.id);
}

function semanticStep(
  value: Record<string, unknown> & { id: string },
  objectNames: ReadonlyMap<string, string>,
): Record<string, unknown> & { handle: string } {
  const semantics = object(value.semantics);
  const target = object(value.target);
  const targetHandle = stringValue(target.handle);
  const pastExperience = outcomeSummary(value.experiencedOutcomes);
  const duration = durationSummary(value.estimatedMonths);
  return {
    handle: value.id,
    action: stringValue(value.summary),
    priority: stepPriority(semantics),
    purpose: PURPOSE_NAMES[stringValue(semantics.purpose)] ?? stringValue(semantics.purpose),
    ...(duration ? { duration } : {}),
    ...(targetHandle ? { target: { ref: targetHandle, name: objectNames.get(targetHandle) ?? '当前可见对象' } } : {}),
    ...(rows(value.risks).length ? { risks: rows(value.risks).map(stringValue).filter(Boolean).slice(0, 2) } : {}),
    ...(pastExperience.length ? { pastExperience } : {}),
    ...(stringValue(value.agendaHandle) ? { concernHandle: stringValue(value.agendaHandle) } : {}),
    ...(value.requiresFollowUp ? { requiresContinuation: true } : {}),
    ...(stringValue(value.communicationKind) ? { communicationKind: stringValue(value.communicationKind) } : {}),
    ...(value.speechAct ? { socialMeaning: value.speechAct } : {}),
    ...(rows(value.groundingFacts).length ? { groundingFacts: value.groundingFacts } : {}),
  };
}

function semanticContinuation(
  value: Record<string, unknown> & { id: string },
  objectNames: ReadonlyMap<string, string>,
): Record<string, unknown> & { handle: string } {
  const target = object(value.target);
  const targetHandle = stringValue(target.handle);
  const duration = durationSummary(value.estimatedMonths);
  return {
    handle: value.id,
    action: stringValue(value.summary),
    purpose: PURPOSE_NAMES[stringValue(value.purpose)] ?? stringValue(value.purpose),
    ...(duration ? { duration } : {}),
    ...(targetHandle ? { target: { ref: targetHandle, name: objectNames.get(targetHandle) ?? '当前可见对象' } } : {}),
  };
}

function semanticRecentDialogue(value: unknown): unknown[] {
  return rows(value).slice(0, 2).map((lineValue) => {
    const line = object(lineValue);
    return {
      when: `第 ${numberValue(line.month)} 月`,
      speaker: stringValue(line.speaker),
      text: stringValue(line.text),
      evidenceBoundary: '这里只证明这句话被听见；句中的提议、打算和自述不证明任何行动已经发生',
    };
  });
}

function semanticActionSpace(candidates: CharacterAgendaProbeCandidates): MentalActRequestContext['actionSpace'] {
  const heldObjects = candidates.held.map((item) => ({
    ref: item.handle,
    name: item.name,
    perceivedAs: perceivedAs(item.properties),
    quantity: item.quantity,
  }));
  const operations: MentalActRequestContext['actionSpace']['operations'] = [];
  if (heldObjects.length || candidates.visible.length || candidates.voxels.length) {
    operations.push({ kind: 'observe', meaning: '仔细观察一个本人持有或当前可见的对象' });
  }
  if (heldObjects.length >= 2) {
    operations.push({ kind: 'combine', meaning: '把两到三件本人持有的物品直接结合并观察结果' });
  }
  if (heldObjects.length && candidates.voxels.length) {
    operations.push({ kind: 'expose', meaning: '让一件本人持有的物品接触一个当前可见的环境或设施' });
  }
  if (heldObjects.length >= 2 && candidates.voxels.length) {
    operations.push({ kind: 'exert', meaning: '用一件本人持有的工具，对另一件物品和当前可见对象施力' });
  }
  if (candidates.voxels.length) {
    operations.push({ kind: 'move', meaning: '走向一个当前看得见且可以抵达的地表位置，可用于探索、漫游或寻找他人' });
  }
  return {
    operations,
    heldObjects,
  };
}

const MIND_STEP_POSSIBILITIES: Record<string, MindActionPossibility> = {
  '照顾自身生存状态': { kind: 'survive', description: '处理本人当前已经出现的饮水、进食或身体需要' },
  '处理安全问题': { kind: 'survive', description: '应对眼前已经存在的环境或野兽危险' },
  '取得资源': { kind: 'acquire', description: '取得至少一种当前可达或已有明确来源的资源' },
  '照顾他人': { kind: 'care', description: '对当前确实需要帮助的人采取已有现实依据的照护' },
  '观察或验证问题': { kind: 'observe', description: '观察一个当前持有或眼前可见的具体对象' },
  '推进项目': { kind: 'continue-project', description: '继续一个当前已经存在并有现实下一步的项目' },
  '与人交谈': { kind: 'talk', description: '与当前附近的人交谈，或回应实际听见的话' },
  '协调共同事务': { kind: 'coordinate', description: '围绕已有共同事务提出、回应或履行协调行为' },
  '进行生产': { kind: 'produce', description: '进行一种当前已经具备材料与操作条件的生产行为' },
  '改善所处位置': { kind: 'move', description: '移动到当前可达的位置以改善空间处境' },
  '移动': { kind: 'move', description: '移动到当前看得见且可以抵达的位置' },
  '处理生育关系': { kind: 'reproduce', description: '处理当前具备现实对象和条件的生育关系' },
  '处理遗体与悼念': { kind: 'mortuary-care', description: '处理当前可感知的遗体或悼念事项' },
  '处理其他事情': { kind: 'other', description: '处理一个已经存在明确现实入口的其他事项' },
};

const MIND_OPERATION_POSSIBILITIES: Record<
  MentalActRequestContext['actionSpace']['operations'][number]['kind'],
  MindActionPossibility
> = {
  observe: { kind: 'observe', description: '仔细观察一个本人持有或当前可见的具体对象' },
  combine: { kind: 'combine', description: '把本人持有的两到三件具体物品直接结合并观察结果' },
  expose: { kind: 'expose', description: '让一件本人持有的物品接触当前可见的环境或设施' },
  exert: { kind: 'exert', description: '用一件本人持有的物品，对另一件持有物和可见对象施力' },
  move: { kind: 'move', description: '走向一个当前看得见且可以抵达的地表位置' },
};

const MAX_KNOWN_CRAFT_HINTS = 3;
const RELIABLE_TECHNIQUE_CONFIDENCE = 60;

function parseCombineTechniqueInputs(id: string): { inputs: Map<number, number>; outputMaterialId: number } | null {
  const match = id.match(/^technique:combine-inventory:((?:\d+x\d+)(?:\+\d+x\d+)*):(\d+)$/);
  if (!match) return null;
  const outputMaterialId = Number(match[2]);
  if (!Number.isSafeInteger(outputMaterialId)) return null;
  const inputs = new Map<number, number>();
  for (const part of match[1].split('+')) {
    const piece = part.match(/^(\d+)x(\d+)$/);
    if (!piece) return null;
    inputs.set(Number(piece[1]), (inputs.get(Number(piece[1])) ?? 0) + Number(piece[2]));
  }
  return inputs.size ? { inputs, outputMaterialId } : null;
}

/**
 * Joins two facts the person already owns — a reliable recipe and their own
 * backpack — into a coarse logistics hint. Hidden world state (remote drops,
 * other people's stock, recipe outcomes) never enters these hints.
 */
function knownCraftHints(person: PersonState): string[] {
  const held = new Map<number, number>();
  for (const stack of person.inventory) {
    held.set(stack.materialId, (held.get(stack.materialId) ?? 0) + stack.quantity);
  }
  const hints: string[] = [];
  for (const fact of person.knowledge) {
    if (hints.length >= MAX_KNOWN_CRAFT_HINTS) break;
    if (fact.kind !== 'technique' || (fact.confidence ?? 0) < RELIABLE_TECHNIQUE_CONFIDENCE) continue;
    const parsed = parseCombineTechniqueInputs(fact.id);
    if (!parsed) continue;
    const outputName = materialDefinition(parsed.outputMaterialId).name;
    if (materialHas(parsed.outputMaterialId, 'facility')) continue;
    const missing = [...parsed.inputs]
      .filter(([materialId, quantity]) => (held.get(materialId) ?? 0) < quantity)
      .map(([materialId]) => materialDefinition(materialId).name);
    if (missing.length === 0) {
      hints.push(`手头材料已经齐备，可以按本人掌握的经验制作${outputName}`);
    } else if (missing.length < parsed.inputs.size) {
      hints.push(`本人已掌握制作${outputName}的经验，再取得${missing.join('、')}即可动手`);
    }
  }
  return hints;
}

function mindActionPossibilities(
  context: MentalActRequestContext,
): MindIntentionRequestContext['actionPossibilities'] {
  const availableNow: MindActionPossibility[] = [];
  const seen = new Set<MindActionPossibilityKind>();
  const add = (possibility: MindActionPossibility | undefined): void => {
    if (!possibility || seen.has(possibility.kind)) return;
    seen.add(possibility.kind);
    availableNow.push(possibility);
  };
  for (const step of context.availableSteps) add(MIND_STEP_POSSIBILITIES[stringValue(step.purpose)]);
  for (const operation of context.actionSpace.operations) add(MIND_OPERATION_POSSIBILITIES[operation.kind]);
  for (const hint of context.knownCraftHints ?? []) {
    availableNow.push({ kind: 'known-craft', description: hint });
  }
  // 开放造物：手中握着可组合的实料时，"把它做成一件东西"是人物此刻
  // 真实拥有的可能性——不需要配方，结果由世界按材料与形态裁决。
  const heldMaterials = context.actionSpace.heldObjects.length;
  const hasPair = heldMaterials >= 2
    || context.actionSpace.heldObjects.some((item) => numberValue(item.quantity) >= 2);
  if (hasPair) {
    availableNow.push({
      kind: 'open-craft',
      description: '把手中已有的实料亲手做成一件能长久存在的具体造物（棚、堆、捆、坯、器）',
    });
  }
  add({
    kind: 'open-world-interaction',
    description: '亲自尝试一个当下可实施但固定动作表未覆盖的具体交互，由世界返回实际结果',
  });
  return {
    availableNow,
    agency: '这些只是此刻大致可落地的动作类型，不是任务或推荐顺序；也可以停留、搁置问题或暂时不采取行动',
  };
}

/**
 * Convert authoritative state into a short semantic brief. Exact thresholds,
 * scores, coordinates and duplicated compiler structures stay local; request
 * handles remain so a model proposal can still be grounded deterministically.
 */
export function buildMentalActRequestContext(
  context: DecisionRequestContext,
  handles: DecisionProbeHandleMap,
): MentalActRequestContext {
  const compact: CompactDecisionRequestContext = buildCompactDecisionRequestContext(context, handles);
  const person = object(compact.person);
  const candidates = buildCharacterAgendaProbeCandidates(context, handles);
  const objectNames = new Map<string, string>();
  for (const item of candidates.held) objectNames.set(item.handle, item.name);
  for (const item of candidates.visible) {
    const row = object(item);
    const name = stringValue(row.name) || SPECIES_NAMES[stringValue(row.speciesId)];
    if (name) objectNames.set(item.handle, name);
  }
  for (const item of candidates.voxels) objectNames.set(item.handle, item.name);
  // An unknown trial is authored by the person through actionSpace. Showing a
  // compiler-picked material pair as an available action lets Plan select that
  // pair while describing a different experiment in prose.
  const selectedSteps = orderedModelSteps(compact.options)
    .filter((step) => !isCompilerSelectedOpenTrial(context, step));
  const actionSpace = semanticActionSpace(candidates);
  const origin = semanticFounderOrigin(person, compact.situation, actionSpace.heldObjects);
  const personalityPreset = semanticPersonalityPreset(person);
  const nearbyPeople = context.visiblePeople.filter((candidate) => candidate.id !== context.person.id);
  const sheltered = compact.situation.sheltered === true;
  return {
    schemaVersion: 'mental-act-context-v5',
    person: semanticPerson(person),
    situation: {
      ...semanticSituation(compact.situation),
      socialSituation: nearbyPeople.length
        ? `附近有${nearbyPeople.map((candidate) => candidate.name).join('、')}`
        : '附近没有其他人，目前独处',
      livingSituation: sheltered
        ? '目前身处可进入并能遮蔽天气的住所内'
        : '目前没有身处任何住所内',
    },
    ...(origin ? { origin } : {}),
    mind: semanticMind(person.mindMarkdown),
    current: semanticCurrent(compact.commitments),
    recentDialogue: semanticRecentDialogue(compact.recentDialogue),
    visible: semanticVisible(compact.visible, candidates, context.visibleOpenWorldFacts ?? [], context.visibleWorks ?? []),
    availableSteps: selectedSteps.map((step) => semanticStep(step, objectNames)),
    continuations: compact.followUpOptions.map((step) => semanticContinuation(step, objectNames)),
    actionSpace,
    ...(knownCraftHints(context.person).length ? { knownCraftHints: knownCraftHints(context.person) } : {}),
    ...(personalityPreset ? { personalityPreset } : {}),
  };
}

export function buildMindIntentionRequestContext(
  context: MentalActRequestContext,
): MindIntentionRequestContext {
  return {
    schemaVersion: 'mind-intention-context-v5',
    person: context.person,
    situation: context.situation,
    ...(context.origin ? { origin: context.origin } : {}),
    mind: context.mind,
    current: semanticMindCurrent(context.current, context.availableSteps),
    recentDialogue: context.recentDialogue,
    visible: context.visible,
    actionPossibilities: mindActionPossibilities(context),
    ...(context.personalityPreset ? { personalityPreset: context.personalityPreset } : {}),
  };
}

export function buildModelPlanRequestContext(
  context: MentalActRequestContext,
  intention: MindIntentionDraft,
): ModelPlanRequestContext {
  return {
    schemaVersion: 'model-plan-context-v1',
    intention: {
      utterance: intention.utterance,
      delivery: intention.delivery,
      goal: intention.goal,
      ...(intention.orientation ? { orientation: intention.orientation } : {}),
      ...(intention.horizon ? { horizon: intention.horizon } : {}),
    },
    mind: context.mind,
    current: context.current,
    recentDialogue: context.recentDialogue,
    visible: context.visible,
    availableSteps: context.availableSteps,
    continuations: context.continuations,
    actionSpace: context.actionSpace,
  };
}
