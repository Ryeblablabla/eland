import {
  buildCompactDecisionRequestContext,
  type CompactDecisionRequestContext,
} from './compact-context';
import {
  buildCharacterAgendaProbeCandidates,
  type CharacterAgendaProbeCandidates,
  type DecisionProbeHandleMap,
} from './capability-handles';
import { MATERIAL_QUANTITY_SEMANTICS, type DecisionRequestContext } from './decision-context';
import { MBTI_PERSONA_PRESETS, type MbtiType } from '../../domain/mbti-persona-presets';
import { materialDefinition, materialHas } from '../../domain/material';
import { cellId, cellX, cellY } from '../../world/grid';
import { describeModelPlanCompletion } from './plan-completion';
import { knownMethodContext } from './method-context';
import { projectNativeOperations } from './native-operation-context';
import { NATIVE_ACT_WIRE_DEFINITIONS, nativeActWireDefinition, type NativeActWireKind } from './native-act-wire';

export interface MentalActRequestContext {
  schemaVersion: 'mental-act-context-v5';
  person: Record<string, unknown>;
  situation: Record<string, unknown>;
  origin?: {
    background: string[];
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
    operations: Array<{ kind: 'observe' | 'combine' | 'assemble' | 'expose' | 'move' | NativeActWireKind; meaning: string }>;
    heldObjects: Array<Record<string, unknown> & { ref: string }>;
  };
  /**
   * Coarse hints derived solely from the person's own reliable craft
   * knowledge and current inventory ("再取得木材即可制作水轮"). They never
   * name world state the person could not know; they only join two facts the
   * person already owns so a small model does not lose the logistics thread.
   */
  knownCraftHints?: string[];
  knownMethods?: Array<Record<string, unknown> & { handle: string }>;
  speechReferences?: Array<Record<string, unknown> & { ref: string }>;
  personalityPreset?: Record<string, unknown>;
  nativeOperations?: Array<Record<string, unknown>>;
  nativeReferences?: Array<Record<string, unknown>>;
  knownProjects?: Array<Record<string, unknown>>;
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
  | 'conflict'
  | 'talk'
  | 'coordinate'
  | 'continue-project'
  | 'produce'
  | 'reproduce'
  | 'mortuary-care'
  | 'resume-work'
  | 'known-craft'
  | 'open-craft'
  | 'other';

export interface MindActionPossibility {
  kind: MindActionPossibilityKind;
  description: string;
}

interface MindActionPossibilities {
  availableNow: MindActionPossibility[];
  agency: string;
}

/** The person chooses an activity from experienced facts, without engine menus. */
export interface MindIntentionRequestContext {
  schemaVersion: 'mind-intention-context-v7';
  person: MentalActRequestContext['person'];
  situation: MentalActRequestContext['situation'];
  origin?: NonNullable<MentalActRequestContext['origin']>;
  mind: MentalActRequestContext['mind'];
  current: Record<string, unknown>;
  recentDialogue: MentalActRequestContext['recentDialogue'];
  visible: MentalActRequestContext['visible'];
  speechReferences?: MentalActRequestContext['speechReferences'];
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
  nextAttempt?: string;
  attempt?: import('../../domain/mental-act').MentalAct['attempt'];
  speechIntent?: import('../../domain/mental-act').MentalSpeechIntent;
  /** Subjective direction; the selected operation has its own explicit source. */
  orientation?: MindIntentionOrientation;
  /** The person decides whether this goal should survive the current turn. */
  horizon?: 'momentary' | 'ongoing';
}

/** Plan receives one frozen intention and chooses how it enters the existing executor. */
export interface ModelPlanRequestContext {
  schemaVersion: 'model-plan-context-v1';
  intention: MindIntentionDraft;
  declaration: {
    delivery: 'with-this-decision' | 'already-delivered';
    meaning: string;
  };
  person: MentalActRequestContext['person'];
  situation: MentalActRequestContext['situation'];
  mind: MentalActRequestContext['mind'];
  current: MentalActRequestContext['current'];
  recentDialogue: MentalActRequestContext['recentDialogue'];
  visible: MentalActRequestContext['visible'];
  capabilities: MindActionPossibilities;
  knownProjects: NonNullable<MentalActRequestContext['knownProjects']>;
  knownMethods: NonNullable<MentalActRequestContext['knownMethods']>;
  speechReferences: NonNullable<MentalActRequestContext['speechReferences']>;
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
  return uniqueText([
    stringValue(soul.innerVoice),
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
    innerTension: personalityPreset.innerTension,
    speechTendency: personalityPreset.speechTendency,
  };
}

function semanticPerson(value: unknown): Record<string, unknown> {
  const person = object(value);
  const position = object(person.position);
  const relationshipHistory = rows(person.relationshipEpisodes).map((episodeValue) => {
    const episode = object(episodeValue);
    return {
      with: stringValue(episode.otherPersonName),
      when: `第 ${numberValue(episode.experiencedAtMonth)} 月`,
      meanings: rows(episode.meanings).map(stringValue).filter(Boolean),
      interpretation: stringValue(episode.interpretation),
      ...(stringValue(episode.unresolvedExpectation)
        ? { unresolvedExpectation: stringValue(episode.unresolvedExpectation) }
        : {}),
      ...(stringValue(episode.desiredResponse)
        ? { desiredResponse: stringValue(episode.desiredResponse) }
        : {}),
    };
  }).filter((episode) => episode.with && episode.interpretation);
  return {
    id: stringValue(person.id),
    name: stringValue(person.name),
    position: { ...position, ...(typeof position.cellId === 'number'
      ? { x: cellX(position.cellId), y: cellY(position.cellId) } : {}) },
    lifeStage: lifeStage(numberValue(person.ageMonths)),
    physicalState: physicalState(person),
    capabilities: capabilitySummary(person.capacities),
    character: semanticCharacter(person),
    ...(relationshipHistory.length ? { subjectiveRelationshipHistory: relationshipHistory } : {}),
  };
}

function semanticFounderOrigin(
  situationValue: unknown,
): MentalActRequestContext['origin'] {
  const situation = object(situationValue);
  if (numberValue(situation.month) !== 1) return undefined;
  return {
    background: [
      '你与周围的先民刚在这片自然地表共同开始生活，彼此只有共同抵达带来的基本熟悉。',
    ],
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
    decisionInterval: '本月生活的方向与眼前下一步；短动作完成后可以在同月继续决策，月份不是一次观察或一句话的持续时间',
    era: situation.epoch === 'chaotic' ? '乱纪元' : '恒纪元',
    environment: `${climateName}；${weatherName}${intensity >= 3 ? '，影响强烈' : intensity >= 2 ? '，影响明显' : '，影响轻微'}`,
    urgentPressures: pressures,
  };
}

const AGREEMENT_KINDS: Record<string, string> = {
  'joint-action': '临时共同事项',
  assist: '协助约定',
  exchange: '交换约定',
  jointProject: '共同项目约定',
  reproduce: '生育约定',
  companion: '陪伴约定',
  collective: '共同体约定',
  membership: '成员接纳约定',
  permission: '资源许可约定',
  'decision-rule': '共同决策规则提议',
  mandate: '有限任期候选授权',
};

const AGREEMENT_STATUS: Record<string, string> = {
  proposed: '等待回应',
  active: '已经生效',
  fulfilled: '已经履行',
  breached: '已经违约',
  rejected: '已经拒绝',
  withdrawn: '已经撤回',
  expired: '已经过期',
  cancelled: '已经取消',
};

function progressSummary(value: unknown): string {
  const progress = numberValue(value);
  if (progress <= 0) return '尚未开始';
  if (progress < 0.5) return '已经开始，但还在前半段';
  if (progress < 1) return '已经推进过半';
  return '已经完成';
}

/** Refer to the already-retained evidence only when it is exactly the same text.
 * A lossy heard utterance is never completed with the author's full wording. */
function singleSourceAgreementProposal(agreement: DecisionRequestContext['agreements'][number]): Record<string, unknown> {
  const proposal = { ...agreement.proposal };
  const matchingSource = typeof proposal.summary === 'string' && proposal.summary.length
    ? agreement.sourceFacts.find((source) => source.eventId === agreement.proposalEventId
      && source.utterance === proposal.summary) : undefined;
  if (matchingSource) {
    delete proposal.summary;
    proposal.summarySourceEventId = matchingSource.eventId;
  }
  return proposal;
}

function semanticCurrent(value: unknown, atMonth: number): Record<string, unknown> {
  const current = object(value);
  const activeIntent = object(current.activeIntent);
  const activePlan = object(activeIntent.plan);
  const activeProject = object(current.activeProject);
  const materialPlan = object(activeProject.materialPlan);
  const agreements = rows(current.agreements).map((agreementValue) => {
    const agreement = object(agreementValue);
    const jointAction = agreement.kind === 'joint-action';
    const hasReplyDeadline = typeof agreement.acceptByMonth === 'number' && Number.isFinite(agreement.acceptByMonth);
    const ownState = agreement.requiresOwnResponse && agreement.status === 'proposed'
      && !agreement.acceptedBySelf && !agreement.rejectedBySelf
      ? jointAction ? '本人尚未回应这次邀请' : '对方在等待本人的答复'
      : agreement.fulfilledBySelf
        ? '本人已经完成自己的部分'
        : agreement.rejectedBySelf
          ? '本人已经明确反对'
        : agreement.acceptedBySelf
          ? jointAction ? '本人已明确接受本次邀请' : '本人已经接受，但还没有完成自己的部分'
          : '本人尚未接受';
    return {
      ref: stringValue(agreement.ref),
      // The complete matter and its heard source live once in speechReferences.
      ownState,
      elapsedMonths: Math.max(0, atMonth - numberValue(agreement.proposedAtMonth)),
      ...(jointAction ? {
        participantCount: numberValue(agreement.electorateCount),
        acceptedCount: numberValue(agreement.supportCount),
        rejectedCount: numberValue(agreement.oppositionCount),
      } : {
        electorate: numberValue(agreement.electorateCount),
        support: numberValue(agreement.supportCount),
        opposition: numberValue(agreement.oppositionCount),
      }),
      ...(!jointAction && typeof agreement.dueAtMonth === 'number' ? { due: `第 ${agreement.dueAtMonth} 月` } : {}),
      ...(agreement.status === 'proposed' || agreement.status === 'active' ? {
        consequence: jointAction
          ? `每位受邀者自行决定是否回应，未回应不表示同意，也不妨碍各自行动。${hasReplyDeadline
            ? '待回应的邀请只按提议者明确声明的回应期限判断是否过期。'
            : '未指定回应期限，不会因时间流逝自动过期。'}没有默认履约期限或自动违约；没有共同成果判据时，接受或一次动作不会自动标记事项完成。发起人可以撤回邀请，已接受者可以明确结束这份约定。`
          : '可以自行决定是否回应或履行；未回应可能使提议逾期，接受后未履行可能留下违约事实，对方会独立理解这些经历',
      } : {}),
    };
  });
  const collectives = rows(current.collectives).map((collectiveValue) => {
    const collective = object(collectiveValue);
    const rules = rows(collective.decisionRules).map((ruleValue) => {
      const rule = object(ruleValue);
      return {
        method: rule.method === 'majority-vote' ? '多数表决' : '全体同意',
        scope: rule.scope === 'coordinate-material' ? '协调具体物资' : '指定反复项目职责承担者',
      };
    });
    return {
      purpose: stringValue(collective.purposeSummary),
      state: stringValue(collective.status),
      members: numberValue(collective.activeMemberCount),
      rules,
      ownMandates: rows(collective.ownMandates),
    };
  });
  return {
    recentExperiences: rows(current.recentExperiences),
    concernHistory: rows(current.characterAgenda).map((value) => {
      const concern = object(value);
      return {
        aim: stringValue(concern.aim),
        since: `第 ${numberValue(concern.createdAtMonth)} 月`,
        elapsedMonths: Math.max(0, atMonth - numberValue(concern.createdAtMonth)),
        lastReviewed: `第 ${numberValue(concern.lastReviewedAtMonth)} 月`,
        status: stringValue(concern.status),
        approaches: rows(concern.approaches).map((value) => {
          const approach = object(value);
          return {
            method: stringValue(approach.summary),
            evaluationCount: numberValue(approach.evaluationCount),
            recentFeedback: rows(approach.recentEvaluations),
          };
        }),
      };
    }),
    recentlyFinishedWork: rows(current.recentCompletedWork).map((value) => {
      const work = object(value);
      return {
        summary: stringValue(work.summary),
        status: stringValue(work.status),
        when: `第 ${numberValue(work.atMonth)} 月`,
        ...(work.plan ? { authoredPlan: rows(object(work.plan).steps).map(stringValue).filter(Boolean) } : {}),
        recentOutcomes: rows(work.recentOutcomes),
        ...(stringValue(work.preflightResult) ? { preflightResult: stringValue(work.preflightResult) } : {}),
        interpretation: '这次操作已结束，是否实际发生及其结果以回执为准；下一步由本人结合当前目标决定',
      };
    }),
    ...(stringValue(activeIntent.summary) ? {
      activeWork: {
        summary: stringValue(activeIntent.summary),
        progress: progressSummary(activeIntent.progress),
        nextStepType: stringValue(activeIntent.nextActionKind),
        ...(rows(activePlan.steps).length ? {
          authoredPlan: rows(activePlan.steps).map(stringValue).filter(Boolean),
        } : {}),
        ...(rows(activeIntent.recentOutcomes).length ? {
          recentOutcomes: rows(activeIntent.recentOutcomes).map((outcomeValue) => {
            const outcome = object(outcomeValue);
            return {
              when: `第 ${numberValue(outcome.atMonth)} 月`,
              ...(stringValue(outcome.sourceEventId) ? { sourceEventId: stringValue(outcome.sourceEventId) } : {}),
              action: stringValue(outcome.execution),
              goal: stringValue(outcome.goalProgress),
              evidence: stringValue(outcome.evidence),
              actualResult: stringValue(outcome.actualResult),
              operation: stringValue(outcome.operation),
              overallGoalAssessment: stringValue(outcome.overallGoalAssessment),
            };
          }),
        } : {}),
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
    suspendedWork: rows(current.suspendedIntents).flatMap((intentValue) => {
      const intent = object(intentValue);
      const handle = stringValue(intent.handle);
      const summary = stringValue(intent.summary);
      if (!summary) return [];
      const plan = object(intent.plan);
      return [{
        ...(handle ? { handle } : {}),
        summary,
        progress: progressSummary(intent.progress),
        nextStepType: stringValue(intent.nextActionKind),
        since: `第 ${numberValue(intent.createdAtMonth)} 月`,
        lastProgress: `第 ${numberValue(intent.lastProgressAtMonth)} 月`,
        ...(intent.waitingFor === 'world-change' ? { state: '正在等待真实世界变化' } : {}),
        ...(rows(plan.steps).length ? {
          authoredPlan: rows(plan.steps).map(stringValue).filter(Boolean),
        } : {}),
        ...(rows(intent.recentOutcomes).length ? {
          recentOutcomes: rows(intent.recentOutcomes).map((outcomeValue) => {
            const outcome = object(outcomeValue);
            return {
              when: `第 ${numberValue(outcome.atMonth)} 月`,
              ...(stringValue(outcome.sourceEventId) ? { sourceEventId: stringValue(outcome.sourceEventId) } : {}),
              action: stringValue(outcome.execution),
              goal: stringValue(outcome.goalProgress),
              evidence: stringValue(outcome.evidence),
              actualResult: stringValue(outcome.actualResult),
              operation: stringValue(outcome.operation),
            };
          }),
        } : {}),
      }];
    }),
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
  const pendingDecisionId = stringValue(object(current.pendingStep).eventId);
  const pendingFailure = pendingDecisionId ? rows(current.compilationFeedback).map(object)
    .find((feedback) => feedback.eventId === pendingDecisionId && feedback.status === 'unresolved') : undefined;
  // A compiler's sufficiency judgment is not something the actor perceived.
  // Give Mind the attempted operation and its actual receipt; Plan retains the
  // separate checks and review prose for correcting its executable translation.
  const experiencedOutcomes = (value: unknown) => rows(value).map((value) => {
    const outcome = object(value);
    return {
      when: stringValue(outcome.when) || `第 ${numberValue(outcome.atMonth)} 月`,
      ...(stringValue(outcome.sourceEventId) ? { sourceEventId: stringValue(outcome.sourceEventId) } : {}),
      execution: stringValue(outcome.execution) || stringValue(outcome.action),
      ...(stringValue(outcome.operation) ? { operation: stringValue(outcome.operation) } : {}),
      ...(stringValue(outcome.actualResult) ? { actualResult: stringValue(outcome.actualResult) } : {}),
    };
  });
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
    recentExperiences: rows(current.recentExperiences),
    ...(current.reconsideration ? { reconsideration: current.reconsideration } : {}),
    ...(current.currentIntention ? { currentIntention: current.currentIntention } : {}),
    ...(current.pendingStep ? { pendingStep: current.pendingStep } : {}),
    ...(pendingFailure ? { attemptFeedback: {
      sourceDecisionEventId: pendingDecisionId,
      message: stringValue(pendingFailure.message),
      ...(Array.isArray(pendingFailure.fields) ? { fields: pendingFailure.fields } : {}),
      interpretation: '这是所选操作尚未开始的编译反馈，不是本人亲历或已验证的世界结论',
    } } : {}),
    ...(stringValue(activeWork.summary) ? {
      ongoingActivity: stringValue(activeWork.summary),
      authoredPlan: rows(activeWork.authoredPlan),
      recentOutcomes: experiencedOutcomes(activeWork.recentOutcomes),
    } : {}),
    recentlyFinishedWork: rows(current.recentlyFinishedWork).map((value) => {
      const work = object(value);
      return { ...work, recentOutcomes: experiencedOutcomes(work.recentOutcomes) };
    }),
    concernHistory: rows(current.concernHistory),
    ...(pressingMatters.length ? { pressingMatters } : {}),
    suspendedWork: rows(current.suspendedWork).map((workValue) => {
      const { handle: _planOnlyHandle, ...work } = object(workValue);
      return { ...work, recentOutcomes: experiencedOutcomes(work.recentOutcomes) };
    }),
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

function authoredRelationshipInterpretations(context: DecisionRequestContext, handles: DecisionProbeHandleMap) {
  const result = new Map<string, Record<string, unknown>>();
  // The request already contains the observer's sourced episodes, newest
  // first. Scores do not author feelings, and one person's view is not mutual.
  for (const episode of context.person.relationshipEpisodes) {
    if (!episode.interpretation.trim() || episode.sourceCount <= 0) continue;
    const handle = handles.visible.find((item) => item.kind === 'person' && item.personId === episode.otherPersonId)?.handle;
    if (!handle || result.has(handle)) continue;
    result.set(handle, {
      perspective: '本人对既往经历的理解，不代表对方的感受',
      interpretation: episode.interpretation,
      atMonth: episode.experiencedAtMonth,
      sourceCount: episode.sourceCount,
    });
  }
  return result;
}

function semanticVisible(
  compactVisibleValue: unknown,
  candidates: CharacterAgendaProbeCandidates,
  actorPosition: DecisionRequestContext['person']['position'],
  openWorldFacts: NonNullable<DecisionRequestContext['visibleOpenWorldFacts']>,
  works: NonNullable<DecisionRequestContext['visibleWorks']> = [],
  materialQuantity = MATERIAL_QUANTITY_SEMANTICS,
  relationships = new Map<string, Record<string, unknown>>(),
): Record<string, unknown> {
  const compactVisible = object(compactVisibleValue);
  const spatialFacts = (value: unknown): Record<string, unknown> => {
    const item = object(value);
    const location = item.position ? object(item.position) : item;
    const targetCell = typeof location.cellId === 'number'
      ? location.cellId
      : typeof location.x === 'number' && typeof location.y === 'number'
        ? cellId(location.x, location.y)
        : undefined;
    if (targetCell === undefined || typeof location.z !== 'number') return {};
    const x = cellX(targetCell);
    const y = cellY(targetCell);
    const dx = x - cellX(actorPosition.cellId);
    const dy = y - cellY(actorPosition.cellId);
    return {
      position: { cellId: targetCell, x, y, z: location.z },
      relativePosition: { dx, dy, dz: location.z - actorPosition.z, horizontalDistance: Math.abs(dx) + Math.abs(dy) },
    };
  };
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
        ...spatialFacts(item),
        kind: '人物',
        name: stringValue(item.name),
        lifeStage: lifeStage(numberValue(item.ageMonths)),
        ...(relationships.has(handle) ? { relation: relationships.get(handle) } : {}),
        ...(detail ? { physicalState: physicalState(detail) } : {}),
      };
    }
    if (kind === 'animal') {
      const trust = numberValue(item.bondTrust);
      return {
        ref: handle,
        ...spatialFacts(item),
        kind: '动物',
        name: SPECIES_NAMES[stringValue(item.speciesId)] ?? stringValue(item.speciesId),
        ...(trust >= 45 ? { disposition: '对你放松，不再躲避' } : trust > 0 ? { disposition: '对你仍有戒备' } : {}),
      };
    }
    if (kind === 'drop') return {
      ref: handle,
      ...spatialFacts(item),
      kind: '地面物品',
      name: stringValue(item.name),
      perceivedAs: perceivedAs(item.properties),
      quantity: numberValue(item.quantity),
      ...(item.mechanicalCondition ? { mechanicalCondition: item.mechanicalCondition } : {}),
      ...(item.knownDelivery ? { knownDelivery: item.knownDelivery,
        deliveryMeaning: '本人知道这批物资曾为此事项交付；这是用途与关系事实，不是无法触碰或取走的物理门禁' } : {}),
    };
    if (kind === 'inventory-stack') return {
      ref: handle,
      ...spatialFacts(item),
      kind: '他人持物',
      name: stringValue(item.name),
      owner: { ref: stringValue(item.ownerHandle), name: stringValue(item.ownerName) },
      perceivedAs: perceivedAs(item.properties),
      quantity: numberValue(item.quantity),
      ...(item.mechanicalCondition ? { mechanicalCondition: item.mechanicalCondition } : {}),
      possession: '当前由对方持有；是否能够移交或取走由实际转移动作及对方反应结算',
    };
    if (kind === 'remains') return {
      ref: handle, ...spatialFacts(item), kind: '人的遗体', state: stringValue(item.status),
    };
    if (kind === 'work') return {
      ref: handle,
      ...spatialFacts(item),
      kind: '造物',
      name: stringValue(item.summary),
      arrangement: stringValue(item.arrangement),
      condition: stringValue(item.condition),
      remainingCondition: numberValue(item.conditionValue),
      // Internal material/arrangement scores are not an observed load test.
      // Show the actual materials, geometry, wear and use evidence instead.
      components: rows(item.components),
      layout: rows(item.layout),
      createdAtMonth: numberValue(item.createdAtMonth),
      lastModifiedAtMonth: numberValue(item.lastTouchedAtMonth),
      recentUse: rows(item.recentUse),
    };
    return {
      ref: handle,
      ...spatialFacts(item),
      kind: '容器',
      capacityState: numberValue(item.usedCapacity) >= numberValue(item.capacity) ? '已经装满' : '还有空间',
    };
  });
  const surfaces = candidates.voxels.map((item) => ({
    ref: item.handle,
    ...spatialFacts(item),
    name: item.name,
    perceivedAs: perceivedAs(item.properties),
  }));
  const heldPossessions = candidates.held.map((item) => ({
    ref: item.handle,
    name: item.name,
    perceivedAs: perceivedAs(item.properties),
    quantity: item.quantity,
    ...(item.mechanicalCondition ? { mechanicalCondition: item.mechanicalCondition } : {}),
  }));
  return {
    // Keep each real stack's reference shared with actionSpace.heldObjects;
    // equal names and appearances do not make different possessions identical.
    materialQuantity,
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
    ...(works.length ? { personMadeWorks: nearbyObjects.filter((item) => item.kind === '造物') } : {}),
  };
}

const PURPOSE_NAMES: Record<string, string> = {
  homeostasis: '照顾自身生存状态',
  safety: '处理安全问题',
  resource: '取得资源',
  care: '照顾他人',
  conflict: '处理人际冲突',
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
  if (obligation === 'required-response') return '有人在等待答复，可自行决定是否回应';
  if (obligation === 'commitment-action') return '与本人已接受的承诺有关，可自行决定是否履行并承担后果';
  return '可以选择';
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

function semanticRecentDialogue(value: unknown, context: DecisionRequestContext, handles: DecisionProbeHandleMap): unknown[] {
  const referencesBySource = new Map<string, Set<string>>();
  for (const agreement of context.agreements) {
    const reference = handles.speechReferences?.find((item) => item.kind === 'agreement' && item.id === agreement.id);
    if (!reference) continue;
    for (const fact of agreement.sourceFacts) {
      for (const source of [fact.eventId, fact.languageSourceEventId].filter((id): id is string => Boolean(id))) {
        const refs = referencesBySource.get(source) ?? new Set<string>();
        refs.add(reference.handle);
        referencesBySource.set(source, refs);
      }
    }
  }
  return rows(value).map((lineValue) => {
    const line = object(lineValue);
    const declarationReferences = referencesBySource.get(stringValue(line.sourceEventId));
    return {
      when: `第 ${numberValue(line.month)} 月${typeof line.planningTick === 'number' ? `，本月第 ${line.planningTick} 个规划时刻` : ''}`,
      speaker: stringValue(line.speaker),
      text: stringValue(line.text),
      sourceEventId: stringValue(line.sourceEventId),
      ...(declarationReferences?.size ? { declarationReferences: [...declarationReferences] } : {}),
      ...(line.currentInput === true ? { currentInput: true } : {}),
      evidenceBoundary: '这里只证明这句话被听见；句中的提议、打算和自述不证明任何行动已经发生',
    };
  });
}

function semanticActionSpace(candidates: CharacterAgendaProbeCandidates, hasVisibleWork: boolean, hasOtherPerson: boolean): MentalActRequestContext['actionSpace'] {
  const heldObjects = candidates.held.map((item) => ({
    ref: item.handle,
    name: item.name,
    perceivedAs: perceivedAs(item.properties),
    quantity: item.quantity,
    ...(item.mechanicalCondition ? { mechanicalCondition: item.mechanicalCondition } : {}),
  }));
  const operations: MentalActRequestContext['actionSpace']['operations'] = [];
  if (heldObjects.length || candidates.visible.length || candidates.voxels.length) {
    operations.push({ kind: 'observe', meaning: '仔细观察一个本人持有或当前可见的对象' });
  }
  if (heldObjects.length >= 2) {
    operations.push({ kind: 'combine', meaning: '把两到三件本人持有的物品直接结合并观察结果' });
  }
  if (heldObjects.length && candidates.voxels.length || hasVisibleWork) {
    operations.push({ kind: 'assemble', meaning: '选择本人投入的材料份数与实际位置排布成实体；也可用空新增投入重排已有造物。用途来自实际形态和使用' });
  }
  if (heldObjects.length && candidates.voxels.length) {
    operations.push({ kind: 'expose', meaning: '让一件本人持有的物品接触一个当前可见的环境或设施' });
  }
  for (const definition of NATIVE_ACT_WIRE_DEFINITIONS) {
    const available = definition.parameters.every((parameter) => parameter.optional
      || (parameter.role === 'held' ? heldObjects.length > 0
        : parameter.role === 'voxel' ? candidates.voxels.length > 0
          : parameter.role === 'work' ? hasVisibleWork
            : parameter.role === 'other-person' ? hasOtherPerson : parameter.role === 'person'));
    if (available) operations.push({ kind: definition.kind, meaning: definition.meaning });
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
  '处理人际冲突': { kind: 'conflict', description: '对眼前的人试图强取、约束或施力；对方可以抵抗，行为会留下伤害与社会后果' },
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
  assemble: { kind: 'open-world-interaction', description: '按实际位置排布本人材料，或重排已有造物' },
  'dismantle-work': { kind: 'acquire', description: nativeActWireDefinition('dismantle-work')!.meaning },
  'separate-terrain': { kind: 'acquire', description: nativeActWireDefinition('separate-terrain')!.meaning },
  'release-restraint': { kind: 'care', description: nativeActWireDefinition('release-restraint')!.meaning },
  expose: { kind: 'expose', description: '让一件本人持有的物品接触当前可见的环境或设施' },
  'strike-person': { kind: 'conflict', description: nativeActWireDefinition('strike-person')!.meaning },
  'bend-held-material': { kind: 'exert', description: nativeActWireDefinition('bend-held-material')!.meaning },
  'work-material-with-tool': { kind: 'exert', description: nativeActWireDefinition('work-material-with-tool')!.meaning },
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
function knownCraftHints(person: Pick<DecisionRequestContext['person'], 'inventory' | 'knowledge'>): string[] {
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
): MindActionPossibilities {
  const availableNow: MindActionPossibility[] = [];
  const seen = new Set<MindActionPossibilityKind>();
  const add = (possibility: MindActionPossibility | undefined): void => {
    if (!possibility || seen.has(possibility.kind)) return;
    seen.add(possibility.kind);
    availableNow.push(possibility);
  };
  for (const step of context.availableSteps) add(MIND_STEP_POSSIBILITIES[stringValue(step.purpose)]);
  for (const operation of context.actionSpace.operations) add(MIND_OPERATION_POSSIBILITIES[operation.kind]);
  if (rows(object(context.current).suspendedWork).length) {
    add({
      kind: 'resume-work',
      description: '恢复一项本人此前主动搁置、现在仍未结束的事务',
    });
  }
  for (const hint of context.knownCraftHints ?? []) {
    availableNow.push({ kind: 'known-craft', description: hint });
  }
  // 开放造物：手中握着可组合的实料时，"把它做成一件东西"是人物此刻
  // 真实拥有的可能性——不需要配方，结果由世界按材料与形态裁决。
  if (context.actionSpace.heldObjects.length) {
    availableNow.push({
      kind: 'open-craft',
      description: '尝试塑形、连接或重新安排真实材料，形成自己设想的物件；结果取决于材料、做法和环境',
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
  const selectedSteps = compact.options
    .filter((step) => !isCompilerSelectedOpenTrial(context, step));
  const availableSteps = selectedSteps.map((step) => semanticStep(step, objectNames));
  const followUpIds = new Set(context.followUpOptions.map((option) => option.id));
  const optionByHandle = new Map(context.options.map((option, index) => [`o${index + 1}`, option]));
  const explicitPhysicalContinuations = availableSteps.filter((step) => {
    const option = optionByHandle.get(step.handle);
    return option && followUpIds.has(option.id) && !option.communicationKind;
  });
  const actionSpace = semanticActionSpace(candidates, Boolean(context.visibleWorks?.length),
    context.visiblePeople.some((person) => person.id !== context.person.id));
  const origin = semanticFounderOrigin(compact.situation);
  const personalityPreset = semanticPersonalityPreset(person);
  const nearbyPeople = context.visiblePeople.filter((candidate) => candidate.id !== context.person.id);
  const sheltered = compact.situation.sheltered === true;
  const workCompletions = [
    ...(context.activeIntent?.plan?.completion ? [{ source: 'active-work', summary: context.activeIntent.summary,
      completion: context.activeIntent.plan.completion }] : []),
    ...(context.recentCompletedWork ?? []).flatMap((work) => work.plan?.completion ? [{
      source: 'finished-step', summary: work.summary, completion: work.plan.completion,
    }] : []),
  ];
  const recentCompletionReviews = (workCompletions.length ? workCompletions
    : context.person.recentMentalActs.flatMap((act) => act.plan?.completion ? [{
        source: 'prior-intention', summary: act.goal, completion: act.plan.completion,
      }] : [])).slice(0, 4).map((item) => ({
        source: item.source, summary: item.summary,
        completion: describeModelPlanCompletion(item.completion, context, handles),
      }));
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
    current: {
      ...semanticCurrent(compact.commitments, context.clock.elapsedMonths),
      ...(context.currentIntention ? { currentIntention: {
        sourceDecisionEventId: context.currentIntention.sourceDecisionEventId,
        goal: context.currentIntention.mentalAct.goal,
        ...(context.currentIntention.mentalAct.orientation ? { orientation: context.currentIntention.mentalAct.orientation } : {}),
        ...(context.currentIntention.mentalAct.horizon ? { horizon: context.currentIntention.mentalAct.horizon } : {}),
      } } : {}),
      ...(recentCompletionReviews.length ? { recentCompletionReviews } : {}),
      ...(context.recentCompilationFeedback?.length ? { compilationFeedback: context.recentCompilationFeedback } : {}),
      ...(context.pendingExecutionStep ? { pendingStep: {
        eventId: context.pendingExecutionStep.eventId,
        description: context.pendingExecutionStep.description,
        status: '此前选择的这一步尚未开始',
      } } : {}),
      ...(context.reconsideration ? {
        reconsideration: {
          ...context.reconsideration,
          occasion: context.reconsideration.reason === 'heard-language'
            ? '刚听见新的语言，可以结合本人实际听到的内容重新考虑当前打算'
            : stringValue(context.reconsideration.reason) === 'compilation-feedback'
              ? '此前选择的这一步尚未开始，可以保留原目标并重新选择当前尝试'
            : '刚经历了新的实际结果，可以据此重新考虑当前打算',
          agency: '本人可以继续自己的事、回应或保持沉默；这次输入只提供思考机会，不替本人作选择',
        },
      } : {}),
      ...(context.continuingPlan ? {
        planContinuation: {
          initialAttemptPerformed: context.continuingPlan.initialAttemptPerformed,
          ...(context.continuingPlan.compilationFailureEventId ? {
            uncompiledStep: {
              feedbackEventId: context.continuingPlan.compilationFailureEventId,
              description: context.continuingPlan.plan.currentStep?.description ?? context.continuingPlan.plan.steps[0],
              interpretation: '这一步还没有编译成物理动作；根据本次具体编译反馈调整参数或分解手段，保留本人原目标。没有新增发言或已经执行的动作。',
            },
          } : {}),
          authoredPlan: context.continuingPlan.plan.steps,
          completion: describeModelPlanCompletion(context.continuingPlan.plan.completion, context, handles),
          ...(context.continuingPlan.preflightReceipt ? {
            preflight: {
              atMonth: context.continuingPlan.preflightReceipt.atMonth,
              result: context.continuingPlan.preflightReceipt.summary,
              executed: false,
              skippedOperation: context.continuingPlan.preflightReceipt.selectedAction.kind,
              alreadySatisfied: describeModelPlanCompletion({
                step: { description: '执行前已存在的结果', conditions: context.continuingPlan.preflightReceipt.checkedConditions },
                goal: { description: '这不代表执行了原计划中的其余步骤', conditions: [] },
              }, context, handles),
              guidance: '依据已经存在的结果继续下一项未完成工作；不要把本次跳过理解成又执行了一遍',
            },
          } : {}),
          reachedMilestones: (context.continuingPlan.milestones ?? []).map((milestone) => ({
            atMonth: milestone.atMonth,
            actualDistance: milestone.distance,
            criterion: describeModelPlanCompletion({
              step: { description: '本计划亲历到达', conditions: [milestone.condition] },
              goal: { description: '本计划亲历到达', conditions: [milestone.condition] },
            }, context, handles),
          })),
          ...(context.continuingPlan.completionAssessment ? { completionAssessment: context.continuingPlan.completionAssessment } : {}),
          recentOutcomes: context.continuingPlan.outcomeReceipts.slice(-4).map(({ atMonth, execution, goalProgress, evidence, planAssessment, attempt }) => ({
            atMonth, execution, goalProgress, evidence,
            ...(planAssessment ? { planAssessment } : {}),
            ...(attempt ? { attempt } : {}),
          })),
          recentResults: context.continuingPlan.recentResults,
          recentActions: context.continuingPlan.recentActions,
          resultScope: 'localGoalProgress 只说明具体动作的局部目标；总目标只看 overallGoalAssessment。观察材料完成不证明交谈、合作或其它总目标已经推进；unverified 表示没有足够条件证明完成',
          recentEffects: context.continuingPlan.recentEffects,
          language: '这是已形成意图的执行续编；原话已经发出，不再发言，也不产生新的同意、承诺或关系解读',
        },
      } : {}),
    },
    recentDialogue: semanticRecentDialogue(compact.recentDialogue, context, handles),
    visible: semanticVisible(compact.visible, candidates, context.person.position, context.visibleOpenWorldFacts ?? [], context.visibleWorks ?? [], context.materialQuantity,
      authoredRelationshipInterpretations(context, handles)),
    availableSteps,
    continuations: [
      ...compact.followUpOptions.map((step) => semanticContinuation(step, objectNames)),
      ...explicitPhysicalContinuations,
    ],
    actionSpace,
    knownMethods: knownMethodContext(context, handles),
    nativeOperations: projectNativeOperations(context, handles),
    nativeReferences: (handles.nativeReferences ?? []).map((reference) => {
      const fact = context.nativeReferenceFacts?.find((fact) => fact.kind === reference.kind && fact.id === reference.id);
      return { ref: reference.handle, kind: reference.kind, ...(fact ? { summary: fact.summary, atMonth: fact.atMonth } : {}) };
    }),
    knownProjects: (context.knownProjects ?? []).map((project) => ({
      ref: handles.speechReferences?.find((reference) => reference.kind === 'project' && reference.id === project.id)?.handle,
      summary: project.summary, state: project.status, desiredFunction: project.desiredFunction,
    })),
    speechReferences: (handles.speechReferences ?? []).map((reference) => {
      if (reference.kind === 'agreement') {
        const agreement = context.agreements.find((item) => item.id === reference.id)!;
        return { ref: reference.handle, kind: reference.kind, agreementKind: agreement.kind,
          agreementLabel: AGREEMENT_KINDS[agreement.kind] ?? agreement.kind,
          proposer: agreement.proposer, parties: agreement.parties, proposal: singleSourceAgreementProposal(agreement),
          proposalEventId: agreement.proposalEventId, sourceFacts: agreement.sourceFacts,
          state: AGREEMENT_STATUS[agreement.status] ?? agreement.status, proposedAtMonth: agreement.proposedAtMonth,
          ...(typeof agreement.acceptByMonth === 'number' && Number.isFinite(agreement.acceptByMonth)
            ? { acceptByMonth: agreement.acceptByMonth } : {}),
          replyDeadline: typeof agreement.acceptByMonth === 'number' && Number.isFinite(agreement.acceptByMonth)
            ? `第 ${agreement.acceptByMonth} 月` : '未指定',
          ...(agreement.acceptedAtMonth !== undefined ? { acceptedAtMonth: agreement.acceptedAtMonth } : {}),
          awaitingReplies: agreement.pendingResponderNames, acceptedBySelf: agreement.acceptedByPersonIds.includes(context.person.id),
          rejectedBySelf: agreement.rejectedByPersonIds.includes(context.person.id),
          meaning: 'proposal 与原话记录对方提出的事项；等待回应时仍未成立为双方承诺，是否接受、拒绝或不回应由本人决定' };
      }
      if (reference.kind === 'knowledge') {
        const knowledge = context.person.knowledge.find((item) => item.id === reference.id);
        return { ref: reference.handle, kind: reference.kind, summary: knowledge?.summary,
          knowledgeKind: knowledge?.kind, learnedAtMonth: knowledge?.learnedAtMonth };
      }
      if (reference.kind === 'collective') return { ref: reference.handle, kind: reference.kind,
        purpose: context.collectives.find((item) => item.id === reference.id)?.purposeSummary };
      if (reference.kind === 'project') {
        const project = context.knownProjects?.find((item) => item.id === reference.id);
        return { ref: reference.handle, kind: reference.kind, summary: project?.summary, state: project?.status, desiredFunction: project?.desiredFunction };
      }
      if (reference.kind === 'decision-rule') {
        const rule = context.collectives.flatMap((item) => item.decisionRules).find((item) => item.id === reference.id);
        return { ref: reference.handle, kind: reference.kind, method: rule?.method, scope: rule?.scope,
          ...(rule?.projectDuty ? { projectDuty: rule.projectDuty } : {}) };
      }
      const permission = context.permissions.find((item) => item.id === reference.id)!;
      return { ref: reference.handle, kind: reference.kind, material: materialDefinition(permission.materialId).name,
        validUntilMonth: permission.validUntilMonth, state: permission.status };
    }),
    ...(knownCraftHints(context.person).length ? { knownCraftHints: knownCraftHints(context.person) } : {}),
    ...(personalityPreset ? { personalityPreset } : {}),
  };
}

export function buildMindIntentionRequestContext(
  context: MentalActRequestContext,
): MindIntentionRequestContext {
  const current = semanticMindCurrent(context.current, []);
  const activity = stringValue(current.ongoingActivity);
  const retain = (keys: string[]) => Object.fromEntries(keys.flatMap((key) => current[key] === undefined ? [] : [[key, current[key]]]));
  const feedback = object(current.attemptFeedback);
  const experienceSourceIds = new Set(rows(current.recentExperiences).map((value) => stringValue(object(value).sourceEventId)));
  return {
    schemaVersion: 'mind-intention-context-v7',
    person: context.person,
    situation: context.situation,
    ...(context.origin ? { origin: context.origin } : {}),
    mind: context.mind,
    current: {
      ...retain(['currentIntention', 'reconsideration', 'pendingStep', 'recentExperiences', 'agreements', 'collectives']),
      ...(rows(current.recentOutcomes).some((outcome) => !experienceSourceIds.has(stringValue(object(outcome).sourceEventId)))
        ? { recentOutcomes: rows(current.recentOutcomes).filter((outcome) => !experienceSourceIds.has(stringValue(object(outcome).sourceEventId))) } : {}),
      bodyActivity: { hasCurrentWork: Boolean(activity), ...(activity ? { description: activity } : {}) },
      ...(feedback.sourceDecisionEventId ? { attemptFeedback: {
        sourceDecisionEventId: feedback.sourceDecisionEventId, message: feedback.message, interpretation: feedback.interpretation,
      } } : {}),
      recentlyFinishedWork: rows(current.recentlyFinishedWork).flatMap((value) => {
        const work = object(value);
        const unseenOutcomes = rows(work.recentOutcomes).filter((outcome) => !experienceSourceIds.has(stringValue(object(outcome).sourceEventId)));
        if (experienceSourceIds.size && !unseenOutcomes.length && !work.preflightResult) return [];
        return [{ ...Object.fromEntries(['summary', 'status', 'when', 'preflightResult']
          .flatMap((key) => work[key] === undefined ? [] : [[key, work[key]]])), recentOutcomes: unseenOutcomes }];
      }),
      concernHistory: rows(current.concernHistory).map((value) => {
        const concern = object(value);
        return {
          ...Object.fromEntries(['aim', 'since', 'elapsedMonths', 'lastReviewed', 'status']
            .flatMap((key) => concern[key] === undefined ? [] : [[key, concern[key]]])),
          recentFeedback: rows(concern.approaches).flatMap((approach) => rows(object(approach).recentFeedback)),
        };
      }),
    },
    recentDialogue: context.recentDialogue,
    visible: context.visible,
    speechReferences: context.speechReferences,
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
      goal: intention.goal,
      ...(intention.nextAttempt ? { nextAttempt: intention.nextAttempt } : {}),
      ...(intention.attempt ? { attempt: structuredClone(intention.attempt) } : {}),
      utterance: intention.utterance,
      delivery: intention.delivery,
      ...(intention.orientation ? { orientation: intention.orientation } : {}),
      ...(intention.horizon ? { horizon: intention.horizon } : {}),
      ...(intention.speechIntent ? { speechIntent: intention.speechIntent } : {}),
    },
    declaration: {
      delivery: object(context.current).planContinuation ? 'already-delivered' : 'with-this-decision',
      meaning: '原话及本人声明的语言含义由同一语言事件提交；Plan 只安排此外的实际行动或等待，不重说原话。发出邀请不代表他人已经同意。',
    },
    person: Object.fromEntries(Object.entries(context.person).filter(([key]) => key !== 'character')),
    situation: context.situation,
    mind: context.mind,
    current: context.current,
    recentDialogue: context.recentDialogue,
    visible: context.visible,
    capabilities: mindActionPossibilities(context),
    knownProjects: context.knownProjects ?? [],
    knownMethods: context.knownMethods ?? [],
    speechReferences: context.speechReferences ?? [],
    actionSpace: context.actionSpace,
  };
}

function nativeCapabilityBrief(context: MentalActRequestContext) {
  const sourceByRef = new Map((context.speechReferences ?? []).map((source) => [source.ref, source]));
  const nativeReferences = (context.nativeReferences ?? []).map((reference) => {
    const source = sourceByRef.get(stringValue(reference.ref));
    // Handles shared with the language domain must not lose their known content
    // merely because they did not originate in an executable method descriptor.
    const proposal = object(source?.proposal);
    const sourceFact = rows(source?.sourceFacts).map(object)
      .find((fact) => fact.eventId === proposal.summarySourceEventId);
    const summary = stringValue(source?.summary) || stringValue(proposal.summary)
      || stringValue(sourceFact?.utterance) || stringValue(reference.summary);
    return { ...reference,
      ...(summary ? { summary } : {}),
      ...(source?.knowledgeKind ? { knowledgeKind: source.knowledgeKind } : {}),
      ...(typeof source?.learnedAtMonth === 'number' ? { learnedAtMonth: source.learnedAtMonth } : {}),
      ...(source?.state ? { state: source.state } : {}),
    };
  });
  const nativeOperations = (context.nativeOperations ?? []).map((descriptor) => {
    const { reason: _proposedReason, localGoal: _localGoal, sourceHandles, ...operation } = descriptor;
    const boundSources = object(operation.methodSources).sourceHandles;
    const duplicateSources = JSON.stringify(sourceHandles) === JSON.stringify(boundSources);
    return { ...operation, ...(!duplicateSources && sourceHandles ? { sourceHandles } : {}) };
  });
  return { nativeOperations, nativeReferences };
}

/** Fresh creative compilation receives only the selected activity and grounded inputs. */
export function buildWorldAttemptRequestContext(
  context: MentalActRequestContext,
  intention: MindIntentionDraft,
): Record<string, unknown> {
  if (!intention.nextAttempt?.trim()) throw new Error('当前尝试编译需要本人已选择的creative原句，不能从整体目标推断另一个动作');
  const current = context.current;
  const outcomes = [
    ...rows(object(current.activeWork).recentOutcomes),
    ...rows(current.recentlyFinishedWork).flatMap((work) => rows(object(work).recentOutcomes)),
  ].map(object).filter((outcome) => stringValue(outcome.sourceEventId) && stringValue(outcome.actualResult));
  const recentActions = [...new Map(outcomes.map((outcome) => [stringValue(outcome.sourceEventId), {
    sourceEventId: stringValue(outcome.sourceEventId),
    execution: stringValue(outcome.execution) || stringValue(outcome.action),
    operation: stringValue(outcome.operation),
    actualResult: stringValue(outcome.actualResult),
    ...(typeof outcome.atMonth === 'number' ? { atMonth: outcome.atMonth }
      : stringValue(outcome.when) ? { when: stringValue(outcome.when) } : {}),
  }])).values()];
  const experiences = rows(current.recentExperiences).map(object);
  const experienceSourceIds = new Set(experiences.map((entry) => stringValue(entry.sourceEventId)));
  const knownActions = [
    ...recentActions.filter((entry) => !experienceSourceIds.has(entry.sourceEventId)),
    ...experiences,
  ].sort((left, right) => numberValue(object(left).atMonth) - numberValue(object(right).atMonth)
    || numberValue(object(left).orderInMonth) - numberValue(object(right).orderInMonth));
  const capabilities = nativeCapabilityBrief(context);
  const boundMethods = capabilities.nativeOperations.filter((descriptor) =>
    object(object(descriptor).request).kind === 'use-method');
  return {
    schemaVersion: 'world-attempt-context-v1',
    actor: Object.fromEntries(['id', 'name', 'position', 'lifeStage', 'physicalState', 'capabilities']
      .flatMap((key) => context.person[key] === undefined ? [] : [[key, context.person[key]]])),
    selectedAttempt: intention.nextAttempt,
    situation: { time: context.situation.time, environment: context.situation.environment },
    background: {
      goal: intention.goal,
      interpretation: '目标只解释本次尝试的用途，不扩张selectedAttempt中本人选择的贡献，也不提供额外任务。',
    },
    declaration: intention.utterance.trim()
      ? { status: 'selected-words', meaning: '本人已选好原话，将随本次决定独立提交；不重写或重复发言。' }
      : { status: 'not-selected', meaning: '本轮尚未选定原话，没有话语事件。若本次意向包含当前要表达的意思，可用speechHandoff转交言语编译。' },
    visible: context.visible,
    // Primitive parameters are authored from selectedAttempt against the API.
    // Candidate actions from the local planner are alternative choices, not
    // evidence of what this person selected. Only capabilities that carry a
    // complete bound method, including instruments, need this table.
    boundMethods,
    nativeReferences: capabilities.nativeReferences,
    knownProjects: context.knownProjects ?? [],
    knownMethods: context.knownMethods ?? [],
    // Mind has already considered older compilation feedback when choosing
    // this attempt. Corrections to this exact request arrive separately.
    current: { recentActions: knownActions },
  };
}

/** The world compiler implements the actor's choice; it does not deliberate again. */
export function buildWorldPlanRequestContext(
  context: MentalActRequestContext,
  intention: MindIntentionDraft,
): Record<string, unknown> {
  const current = context.current;
  return {
    schemaVersion: 'world-plan-context-v1',
    actor: Object.fromEntries(Object.entries(context.person).filter(([key]) => key !== 'character')),
    situation: context.situation,
    intention: {
      goal: intention.goal,
      ...(intention.nextAttempt ? { nextAttempt: intention.nextAttempt } : {}),
      // Bound identity is retained here; the server maps it to current public handles.
      ...(intention.attempt ? { attempt: structuredClone(intention.attempt),
        initialAttemptPerformed: object(current.planContinuation).initialAttemptPerformed === true } : {}),
      ...(intention.orientation ? { orientation: intention.orientation } : {}),
      ...(intention.horizon ? { horizon: intention.horizon } : {}),
    },
    declaration: {
      delivery: current.planContinuation ? 'already-delivered' : 'with-this-decision',
      utterance: intention.utterance,
      ...(intention.speechIntent ? { speechIntent: intention.speechIntent } : {}),
      meaning: '本人这句话由决定独立提交，不是待做的身体步骤；邀请或希望不表示他人已经同意或执行。',
    },
    visible: context.visible,
    actionSpace: context.actionSpace,
    ...nativeCapabilityBrief(context),
    knownProjects: context.knownProjects ?? [],
    knownMethods: context.knownMethods ?? [],
    current: Object.fromEntries([
      'activeWork', 'pendingStep', 'suspendedWork', 'recentlyFinishedWork',
      'planContinuation', 'recentCompletionReviews', 'compilationFeedback',
    ].flatMap((key) => current[key] === undefined ? [] : [[key, current[key]]])),
    ...(current.planContinuation ? { executionMode: 'continue-existing-plan-without-new-speech' } : {}),
    interpretation: 'intention是本人已选方向；current中的计划与判据是可错的设想，实际结果由回执说明。本次直接编译本人贡献，不代其他人行动，也不因没有预制名称就换成本人没选的目标。',
  };
}
