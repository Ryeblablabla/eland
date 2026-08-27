import type { ActionOption, PrimitiveAction } from '../../domain/action';
import {
  cognitiveOutcomeBasisKey,
  goalOutcomeBeliefFor,
  goalOutcomeBeliefSuccess,
  goalOutcomeBeliefUncertainty,
  outcomeBeliefFor,
} from '../../domain/cognition';
import { reproductiveResponsibility } from '../../domain/dependent-care';
import { materialHas } from '../../domain/material';
import type { DecisionContext } from '../../domain/model';
import { personalityScore } from '../../domain/personality';
import {
  bestProductionToolStack,
  productionToolRank,
  recentPersonalProductionLaborEvents,
} from '../../domain/production-tool';
import { assessSocialRepetition } from '../../domain/social-repetition';
import { perceivedKinshipRisk } from '../reproductive-risk';
import {
  deriveNeedAgenda,
  type HomeostasisField,
  type NeedKind,
  type NeedSignal,
  type ReserveResource,
} from './need-agenda';
import { projectById } from '../../domain/state-index';
import { assessFamilyReadiness, type FamilyReadinessAssessment } from './family-readiness';
import { relationTo } from '../../domain/relation';
import { actionOptionSemantics } from '../../domain/action-option-semantics';
import { appraiseSocialExpectation } from './social-expectation';
import { recurringDutyMandateForExistingOption } from '../../domain/governance';

export type CognitiveFactorName =
  | 'need'
  | 'care'
  | 'commitment'
  | 'learning'
  | 'relationship'
  | 'social-expectation'
  | 'family-readiness'
  | 'social-repetition'
  | 'consent'
  | 'feasibility'
  | 'harm';

export interface CognitiveFactor {
  kind: CognitiveFactorName;
  value: number;
  reasons: string[];
  sourceFactIds: string[];
}

export interface NeedAlignment {
  kind: NeedKind;
  resource?: ReserveResource;
  bodyField?: HomeostasisField;
  projectId?: string;
  strength: number;
  reason: string;
}

export interface CognitiveOptionAppraisal {
  option: ActionOption;
  basisKey: string;
  needAlignments: NeedAlignment[];
  addressedNeeds: NeedSignal[];
  needActivation: number;
  generativityUrgency: number;
  expectedSuccess: number;
  uncertainty: number;
  expectedEffort: number;
  expectedHarm: number;
  personalityGate: number;
  memoryGate: number;
  feasibilityGate: number;
  relationshipGate: number;
  socialExpectationGate: number;
  readinessGate: number;
  familyReadiness?: FamilyReadinessAssessment;
  repetitionGate: number;
  ethicalGate: number;
  continuityGate: number;
  motivation: number;
  aspiration: number;
  causalScore: number;
  factors: CognitiveFactor[];
  reasons: string[];
  sourceFactIds: string[];
}

export interface CognitiveFrame {
  architecture: 'causal-bdi-v1';
  planningMonth: number;
  planningTick: number;
  needs: NeedSignal[];
  appraisals: CognitiveOptionAppraisal[];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function union(values: number[]): number {
  return 1 - values.reduce((remaining, value) => remaining * (1 - clamp(value)), 1);
}

function geometricMean(values: number[]): number {
  if (!values.length) return 1;
  return Math.exp(values.reduce((sum, value) => sum + Math.log(Math.max(0.05, value)), 0) / values.length);
}

function trait(context: DecisionContext, key: Parameters<typeof personalityScore>[1]): number {
  return personalityScore(context.person, key) / 100;
}

function traitGate(value: number, amplitude = 0.35, direction: 1 | -1 = 1): number {
  return clamp(1 + direction * (value - 0.5) * amplitude * 2, 0.45, 1.55);
}

function communicationAction(option: ActionOption): Extract<PrimitiveAction, { kind: 'communicate' }> | undefined {
  return option.nextAction.kind === 'communicate'
    ? option.nextAction
    : option.completionAction?.kind === 'communicate'
      ? option.completionAction
      : undefined;
}

function reproductionDirection(option: ActionOption): 'proceed' | 'refuse' | undefined {
  return actionOptionSemantics(option).reproduction?.direction;
}

function isSuccubusReproductionOption(option: ActionOption): boolean {
  return actionOptionSemantics(option).reproduction?.mode === 'unilateral-trait';
}

function mergeAlignments(items: NeedAlignment[]): NeedAlignment[] {
  const byKind = new Map<string, NeedAlignment>();
  for (const item of items) {
    const key = `${item.kind}:${item.resource ?? ''}:${item.bodyField ?? ''}:${item.projectId ?? ''}`;
    const current = byKind.get(key);
    if (!current || item.strength > current.strength) byKind.set(key, item);
  }
  return [...byKind.values()].sort((left, right) => right.strength - left.strength || left.kind.localeCompare(right.kind));
}

function projectNeedKind(need: string | undefined): NeedKind {
  if (need === 'thermal-safety' || need === 'hunting-safety' || need === 'shelter-capacity') return 'safety';
  if (need === 'care-capability') return 'care';
  if (need === 'reserve-security' || need === 'water-security' || need === 'food-preparation') return 'reserve';
  if (need === 'coordination-capacity') return 'belonging';
  if (need === 'knowledge-preservation') return 'inquiry';
  return 'capability';
}

function projectReserveResource(need: string | undefined): ReserveResource | undefined {
  if (need === 'water-security') return 'water';
  if (need === 'reserve-security' || need === 'food-preparation') return 'food';
  return undefined;
}

function optionNeedAlignments(context: DecisionContext, option: ActionOption, atMonth: number): NeedAlignment[] {
  const result: NeedAlignment[] = [];
  const add = (
    kind: NeedKind,
    strength: number,
    reason: string,
    resource?: ReserveResource,
    projectId?: string,
    bodyField?: HomeostasisField,
  ) => result.push({
    kind,
    strength: clamp(strength),
    reason,
    ...(resource ? { resource } : {}),
    ...(bodyField ? { bodyField } : {}),
    ...(projectId ? { projectId } : {}),
  });
  const goal = option.goal;
  const semantics = actionOptionSemantics(option);
  const returnsToSharedLiving = semantics.obligation === 'commitment-action'
    && semantics.socialContext?.cooperationKind === 'companion'
    && semantics.socialContext.phase === 'continuation';
  const targetPersonId = option.target?.kind === 'person' ? option.target.personId : undefined;
  const caresForOther = Boolean(targetPersonId && targetPersonId !== context.person.id)
    && (goal.kind === 'body-at-least' || goal.kind === 'body-at-most' || goal.kind === 'condition');

  if (caresForOther) add('care', 1, '候选会直接改变眼前他人的身体处境');
  else if (goal.kind === 'body-at-least') {
    add('homeostasis', 1, '候选直接恢复本人的身体储备', undefined, undefined, goal.field);
  }
  if (goal.kind === 'sheltered' || (goal.kind === 'condition' && goal.personId === context.person.id)) {
    add('safety', 1, '候选改变本人当前暴露或危险状态');
  }
  if (goal.kind === 'inventory-at-least') {
    const edible = materialHas(goal.materialId, 'edible');
    const drinkable = materialHas(goal.materialId, 'drinkable');
    const carriesEdible = context.person.inventory.some((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
    const carriesDrinkable = context.person.inventory.some((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'drinkable'));
    if (edible) add('reserve', 0.9, '候选增加可携带的食物缓冲', 'food');
    if (drinkable) add('reserve', 0.9, '候选增加可携带的饮水缓冲', 'water');
    if (edible && !carriesEdible && context.person.body.nutrition < 55) {
      add('homeostasis', 0.85, '本人没有可摄入食物，当前营养缺口使取得食物具有即时价值', undefined, undefined, 'nutrition');
    }
    if (drinkable && !carriesDrinkable && context.person.body.hydration < 55) {
      add('homeostasis', 0.85, '本人没有可饮用水，当前水分缺口使取得饮水具有即时价值', undefined, undefined, 'hydration');
    }
    const desiredRank = productionToolRank(goal.materialId);
    const currentRank = productionToolRank(bestProductionToolStack(context.person)?.materialId ?? 0);
    if (desiredRank > currentRank) {
      const groundedLabor = recentPersonalProductionLaborEvents(context.state, context.person.id, atMonth)
        .filter((event) => option.sourceFactIds.includes(event.id));
      if (groundedLabor.length) add('capability', clamp((desiredRank - currentRank) / 3 + 0.45), '本人近期劳动说明更好的工具能改变结果');
    }
  }
  if (goal.kind === 'container-inventory-at-least') {
    if (materialHas(goal.materialId, 'edible')) add('reserve', 1, '候选建立或使用真实食物储备能力', 'food');
    if (materialHas(goal.materialId, 'drinkable')) add('reserve', 1, '候选建立或使用真实饮水储备能力', 'water');
  }
  if (goal.kind === 'knowledge' || option.nextAction.kind === 'attend' || option.recordUseBasis) {
    add('inquiry', option.projectId || option.recordUseBasis ? 1 : 0.7, '候选回应一个有来源的观察或知识缺口');
  }
  if (goal.kind === 'project-completed' || option.projectId || option.projectProposal) {
    add('commitment', option.projectId ? 1 : 0.72, option.projectId ? '候选推进一个已存在项目' : '候选可建立有复核点的持续项目');
    const project = option.projectProposal ?? (option.projectId ? projectById(context.state, option.projectId) : undefined);
    const recurringDutyMandate = recurringDutyMandateForExistingOption(
      context.state,
      context.person.id,
      option,
      atMonth,
    );
    if (recurringDutyMandate && project) {
      add(
        'commitment',
        1,
        '候选是本人已接受的限期共同职责中、原本就存在的合法项目步骤',
        undefined,
        project.id,
      );
    }
    add(
      projectNeedKind(project?.need),
      clamp((option.projectPressure ?? project?.pressure ?? 35) / 70),
      `项目回应${project?.need ?? '局部能力缺口'}`,
      projectReserveResource(project?.need),
      project?.id,
    );
  }
  if (goal.kind === 'near-person') add('belonging', 0.65, '候选接近一个当前可感知的人');
  if (semantics.purpose === 'spatial-comfort') add('spatial-comfort', 1, '候选会减少本人直接感受到的同格拥挤');
  if (goal.kind === 'representation-made') add('belonging', 0.55, '候选形成一次有来源的社会表达');
  if (goal.kind === 'death-mourned') add('bereavement', 0.82, '候选让本人对一项有来源的死亡作出悼念回应');
  if (goal.kind === 'remains-interred') add('bereavement', 1, '候选用实体行动照料本人知晓的遗体');
  if (goal.kind === 'memorial-marked') add('bereavement', 0.58, '候选在真实安葬和材料基础上留下墓记');
  if (semantics.purpose === 'mortuary-care' && goal.kind === 'inventory-at-least') {
    add('bereavement', 0.7, '候选收拢本人知晓的死者遗物');
  }
  if (returnsToSharedLiving) {
    add('commitment', 1, '候选返回协议中的固定共同生活地点，履行已到维护时点的长期承诺');
  }
  if (option.nextAction.kind === 'move' && option.sourceFactIds.length && !option.projectId && !returnsToSharedLiving) {
    add('inquiry', 0.35, '移动目标来自当前可追溯线索');
  }

  const communication = communicationAction(option);
  if (communication) {
    const content = communication.content;
    if (content.kind === 'accept' || content.kind === 'reject' || content.kind === 'revoke-agreement'
      || content.kind === 'revoke' || content.kind === 'withdraw') add('autonomy', 1, '候选是本人对具体关系或协议的表态');
    if ((content.kind === 'request' || content.kind === 'offer') && content.proposal?.kind === 'assist') {
      const requesterIsSelf = content.proposal.requesterId === context.person.id;
      if (!requesterIsSelf) add('care', 0.9, '候选回应他人的一项具体求助');
      else if (content.proposal.need === 'company') add('belonging', 0.9, '候选请求眼前的人陪伴自己');
      else if (content.proposal.need === 'water') add('homeostasis', 0.9, '候选请求帮助补水', undefined, undefined, 'hydration');
      else if (content.proposal.need === 'food') add('homeostasis', 0.9, '候选请求帮助取得食物', undefined, undefined, 'nutrition');
      else add('safety', 0.9, '候选请求帮助取得遮蔽');
    }
    if ((content.kind === 'request' || content.kind === 'offer') && content.proposal
      && ['companion', 'reproduce', 'collective', 'membership'].includes(content.proposal.kind)) {
      add('belonging', 0.9, '候选会改变一项具体社会关系');
    }
    if (content.kind === 'request' && (content.techniqueDemonstration
      || content.projectMaterialContribution
      || content.projectKnowledgeRequest)) {
      add('commitment', 0.9, '沟通直接服务于一个真实项目缺口');
      add('capability', 0.75, '候选寻求材料或技术能力');
    }
  }
  if (reproductionDirection(option) === 'proceed') {
    add('generativity', 1, isSuccubusReproductionOption(option)
      ? '魅魔特质把同地成年异性转化为一次由本人单方授权的生殖机会'
      : '候选把当前资源、照护和关系条件转化为一次可撤回的家庭选择');
  }
  return mergeAlignments(result);
}

function personalityCongruence(context: DecisionContext, alignments: NeedAlignment[]): number {
  const kinds = new Set(alignments.map((alignment) => alignment.kind));
  const gates: number[] = [];
  if (kinds.has('care')) gates.push(geometricMean([
    traitGate(trait(context, 'agreeableness')),
    traitGate(trait(context, 'emotionality')),
  ]));
  if (kinds.has('bereavement')) gates.push(geometricMean([
    traitGate(trait(context, 'emotionality'), 0.42),
    traitGate(trait(context, 'agreeableness'), 0.34),
    traitGate(trait(context, 'conscientiousness'), 0.24),
  ]));
  if (kinds.has('commitment')) gates.push(traitGate(trait(context, 'conscientiousness'), 0.42));
  if (kinds.has('inquiry')) gates.push(traitGate(trait(context, 'openness'), 0.5));
  if (kinds.has('capability')) gates.push(geometricMean([
    traitGate(trait(context, 'openness'), 0.32),
    traitGate(trait(context, 'conscientiousness'), 0.32),
  ]));
  if (kinds.has('belonging')) gates.push(geometricMean([
    traitGate(trait(context, 'extraversion'), 0.42),
    traitGate(trait(context, 'agreeableness'), 0.25),
  ]));
  if (kinds.has('safety')) gates.push(traitGate(trait(context, 'emotionality'), 0.22));
  return geometricMean(gates);
}

function memoryAppraisal(context: DecisionContext, option: ActionOption, basisKey: string, atMonth: number): {
  gate: number;
  value: number;
  sourceFactIds: string[];
  reason?: string;
} {
  const matchingBasis = context.person.memories.filter((memory) => memory.causal?.basisKey === basisKey);
  const targetPersonId = optionTargetPersonId(context, option);
  const targetSpecific = targetPersonId
    ? matchingBasis.filter((memory) => memory.personIds.includes(targetPersonId))
    : [];
  // A result involving one person must not silently become evidence about
  // everybody else. Target-free memories remain transferable motor/technical
  // experience, while exact interpersonal episodes take precedence.
  const related = targetSpecific.length
    ? targetSpecific
    : targetPersonId
      ? matchingBasis.filter((memory) => memory.personIds.length === 0)
      : matchingBasis;
  if (!related.length) return { gate: 1, value: 0, sourceFactIds: [] };
  let weighted = 0;
  let totalWeight = 0;
  for (const memory of related) {
    const age = Math.max(0, atMonth - memory.createdAtMonth);
    const weight = clamp(memory.importance / 100) * Math.exp(-age / 24);
    weighted += (memory.causal?.valence ?? 0) * weight;
    totalWeight += weight;
  }
  const value = totalWeight ? clamp(weighted / totalWeight, -1, 1) : 0;
  return {
    gate: clamp(Math.exp(value * 0.48), 0.55, 1.62),
    value,
    sourceFactIds: [...new Set(related.flatMap((memory) => memory.sourceEventIds))].slice(-24),
    reason: value >= 0
      ? targetPersonId ? '本人记得与这个人进行相似行动曾带来进展' : '本人记得相似行动曾带来进展'
      : targetPersonId ? '本人记得与这个人进行相似行动曾受阻或造成损失' : '本人记得相似行动曾受阻或造成损失',
  };
}

function optionTargetPersonId(context: DecisionContext, option: ActionOption): string | undefined {
  if (option.target?.kind === 'person') return option.target.personId;
  const communication = communicationAction(option);
  const listener = communication?.audience.find((personId) => personId !== context.person.id);
  if (listener) return listener;
  if (option.nextAction.kind === 'transfer') {
    if (option.nextAction.from.kind === 'person' && option.nextAction.from.personId !== context.person.id) return option.nextAction.from.personId;
    if (option.nextAction.to.kind === 'person' && option.nextAction.to.personId !== context.person.id) return option.nextAction.to.personId;
  }
  return undefined;
}

function relationshipAppraisal(context: DecisionContext, option: ActionOption): {
  gate: number;
  consentValue: number;
  consentDiagnostic: number;
  reasons: string[];
  sourceFactIds: string[];
} {
  if (isSuccubusReproductionOption(option)) return {
    gate: 1,
    consentValue: 1,
    consentDiagnostic: 0,
    reasons: ['魅魔的单方授权不读取目标人物关系分数，也不要求双方协议'],
    sourceFactIds: [...option.sourceFactIds],
  };
  const targetId = optionTargetPersonId(context, option);
  const relation = targetId ? relationTo(context.person, targetId) : undefined;
  const communication = communicationAction(option);
  const content = communication?.content;
  const proceeds = content?.kind === 'offer' || content?.kind === 'accept'
    || (option.nextAction.kind === 'act' && option.nextAction.operation === 'reproduce');
  const refuses = content?.kind === 'reject' || content?.kind === 'revoke-agreement'
    || content?.kind === 'revoke' || content?.kind === 'withdraw';
  const reproduction = Boolean(actionOptionSemantics(option).reproduction)
    || ((content?.kind === 'offer') && content.proposal?.kind === 'reproduce');
  let preference = ((relation?.trust ?? 0) + (relation?.bond ?? 0) - Math.max(0, relation?.fear ?? 0) * 1.25) / 65;
  const reasons: string[] = [];
  const sourceFactIds = new Set(relation?.sourceEventIds ?? []);
  if (targetId) reasons.push('本人依据与目标人物的信任、羁绊和恐惧预期社会后果');
  if (reproduction) {
    const relationalSafety = (
      (relation?.trust ?? 0) * 0.52
      + (relation?.bond ?? 0) * 0.48
      - Math.max(0, relation?.fear ?? 0) * 0.9
      - 32
    ) / 32;
    const personalApproach = (
      (personalityScore(context.person, 'extraversion') - 50) * 0.22
      + (personalityScore(context.person, 'agreeableness') - 50) * 0.12
      + (personalityScore(context.person, 'openness') - 50) * 0.08
      + (personalityScore(context.person, 'emotionality') - 50) * 0.06
      - (personalityScore(context.person, 'conscientiousness') - 50) * 0.1
    ) / 50;
    preference = relationalSafety + personalApproach;
    reasons.push('关系强度、恐惧和本人的人格连续改变同意倾向，但不构成固定准入分数');
    const responsibility = reproductiveResponsibility(context.state, context.person);
    preference -= responsibility.pressure / 28;
    responsibility.sourceFactIds.forEach((id) => sourceFactIds.add(id));
    reasons.push(...responsibility.reasons);
    const target = targetId ? context.state.people.find((candidate) => candidate.id === targetId) : undefined;
    if (target) {
      const risk = perceivedKinshipRisk(context.state, context.person, target);
      preference -= risk.cost / 42;
      risk.sourceFactIds.forEach((id) => sourceFactIds.add(id));
      if (risk.cost > 0) reasons.push(`本人以置信度 ${Math.round(risk.knowledgeConfidence)} 把已学习到的亲缘后果风险计入预期`);
    }
  }
  const boundedPreference = Math.tanh(preference);
  const direction = proceeds ? 1 : refuses ? -1 : 0;
  return {
    gate: direction ? clamp(Math.exp(direction * boundedPreference * 0.55), 0.48, 1.72) : clamp(1 + boundedPreference * 0.22, 0.72, 1.28),
    consentValue: direction * boundedPreference,
    // Keep the diagnostic projection linear so reports can show exactly how
    // much a learned risk changed the expectation. The planner itself uses
    // the bounded multiplicative gate above and never adds this number.
    consentDiagnostic: direction * preference * 42,
    reasons,
    sourceFactIds: [...sourceFactIds],
  };
}

function familyReadinessAppraisal(
  context: DecisionContext,
  option: ActionOption,
  atMonth: number,
): { gate: number; reasons: string[]; sourceFactIds: string[]; assessment?: FamilyReadinessAssessment } {
  const direction = reproductionDirection(option);
  if (!direction) return { gate: 1, reasons: [], sourceFactIds: [] };
  if (isSuccubusReproductionOption(option)) return {
    gate: 1,
    reasons: ['魅魔的单方生殖不以食物、水源、住所或照护余量作为准入门槛'],
    sourceFactIds: [...option.sourceFactIds],
  };
  const assessment = assessFamilyReadiness(context, atMonth);
  const gate = direction === 'proceed'
    ? clamp(Math.exp((assessment.readiness - 0.65) * 1.1), 0.48, 1.35)
    : clamp(Math.exp((0.55 - assessment.readiness) * 0.55), 0.75, 1.35);
  return {
    gate,
    reasons: [
      `本人以当前可感知事实评估家庭准备度为 ${Math.round(assessment.readiness * 100)}%`,
      ...assessment.reasons,
    ],
    sourceFactIds: assessment.sourceFactIds,
    assessment,
  };
}

function ethicalAppraisal(context: DecisionContext, option: ActionOption, needs: NeedSignal[]): {
  gate: number;
  value: number;
  reason?: string;
  sourceFactIds: string[];
} {
  const action = option.nextAction;
  const unauthorized = action.kind === 'transfer'
    && action.from.kind === 'person'
    && action.from.personId !== context.person.id
    && !action.authorizationRef;
  const interpersonalHarm = action.kind === 'act' && action.operation === 'exert'
    && action.targets.some((target) => target.kind === 'person');
  const restraint = option.goal.kind === 'condition' && option.goal.condition === 'restrained' && option.goal.present;
  const hunting = action.kind === 'act' && action.operation === 'hunt';
  if (!unauthorized && !interpersonalHarm && !restraint && !hunting) return { gate: 1, value: 0, sourceFactIds: [] };
  const acute = Math.max(...needs.filter((need) => need.kind === 'homeostasis' || need.kind === 'safety').map((need) => need.urgency), 0);
  const resistance = unauthorized
    ? (trait(context, 'honestyHumility') + trait(context, 'conscientiousness')) / 2
    : hunting
      ? trait(context, 'emotionality')
      : (trait(context, 'honestyHumility') + trait(context, 'agreeableness') + trait(context, 'conscientiousness') + trait(context, 'emotionality')) / 4;
  const opposition = (resistance - 0.5) * 1.25 * (1 - acute * 0.72);
  return {
    gate: clamp(Math.exp(-opposition), 0.35, 1.9),
    value: -opposition,
    reason: acute > 0.65 ? '严重求生压力部分压低了本人对伤害风险的抑制' : '人格调节本人对占取、杀伤或强制后果的接受度',
    sourceFactIds: context.person.personality.changes.slice(-6).flatMap((change) => change.sourceEventIds),
  };
}

function feasibilityAppraisal(context: DecisionContext, option: ActionOption, expectedEffort: number, expectedHarm: number): number {
  const duration = option.estimatedMonths
    ?? (option.estimatedDuration === 'one-month' ? 1 : option.estimatedDuration === 'several-months' ? 4 : option.estimatedDuration === 'long' ? 9 : 6);
  const cognitionCapacity = context.person.baselineCapacities?.cognition ?? 50;
  const horizon = 2 + cognitionCapacity / 24 + trait(context, 'conscientiousness') * 3;
  const durationGate = 1 / (1 + duration / Math.max(1, horizon));
  const statedRisk = 1 - Math.exp(-(option.risks?.length ?? 0) / 2);
  const riskExposure = union([statedRisk, expectedHarm]);
  const riskAversion = 0.3 + trait(context, 'emotionality') * 0.45 + trait(context, 'conscientiousness') * 0.15;
  const riskGate = clamp(1 - riskExposure * riskAversion * 0.72, 0.22, 1);
  const effortGate = clamp(1 - expectedEffort * 0.45, 0.45, 1);
  return geometricMean([durationGate, riskGate, effortGate]);
}

function continuityAppraisal(context: DecisionContext, option: ActionOption): number {
  const active = context.activeIntent;
  if (!active) return 1;
  const sameProject = Boolean(active.projectId && option.projectId === active.projectId);
  const sameGoal = active.goal.kind === option.goal.kind;
  if (!sameProject && !sameGoal) return 1;
  return 1.15 + trait(context, 'conscientiousness') * 0.32 + active.progress * 0.18;
}

function factor(
  kind: CognitiveFactorName,
  value: number,
  reasons: string[],
  sourceFactIds: string[] = [],
): CognitiveFactor {
  return { kind, value, reasons, sourceFactIds: [...new Set(sourceFactIds)].slice(-24) };
}

export function evaluateCognitiveOption(
  context: DecisionContext,
  option: ActionOption,
  moment: { atMonth: number; planningTick: number },
  agenda = deriveNeedAgenda(context, moment.atMonth),
): CognitiveOptionAppraisal {
  const alignments = optionNeedAlignments(context, option, moment.atMonth);
  const needForAlignment = (alignment: NeedAlignment): NeedSignal | undefined => agenda
    .filter((need) => need.kind === alignment.kind
      && (alignment.resource ? need.resource === alignment.resource : need.resource === undefined)
      && (alignment.bodyField ? need.bodyField === alignment.bodyField : need.bodyField === undefined)
      && (alignment.projectId ? need.projectId === alignment.projectId : need.projectId === undefined))
    .sort((left, right) => right.urgency - left.urgency || left.key.localeCompare(right.key))[0];
  const positiveReproduction = reproductionDirection(option) === 'proceed';
  const motivatingAlignments = positiveReproduction
    ? alignments.filter((alignment) => alignment.kind === 'generativity')
    : alignments;
  const addressedNeeds = [...new Map(motivatingAlignments.flatMap((alignment) => {
    const need = needForAlignment(alignment);
    return need ? [[need.key, need] as const] : [];
  })).values()];
  const dynamicNeedActivation = union(motivatingAlignments.map((alignment) => (
    (needForAlignment(alignment)?.urgency ?? 0) * alignment.strength
  )));
  // Source facts justify why an option exists; they are not a need by
  // themselves. Turning every sourced observation into generic motivation
  // makes a stream of fresh conversations crowd out slower needs such as
  // generativity. Projects, social contact, inquiry, care and withdrawal all
  // already receive pressure from their corresponding sourced need signals.
  const needActivation = dynamicNeedActivation;
  const generativityUrgency = Math.max(...addressedNeeds
    .filter((need) => need.kind === 'generativity')
    .map((need) => need.urgency), 0);
  const basisKey = cognitiveOutcomeBasisKey(option.nextAction, option.goal);
  const goalBasisKey = cognitiveOutcomeBasisKey(option.completionAction ?? option.nextAction, option.goal);
  const actionBelief = outcomeBeliefFor(context.person, basisKey);
  const goalBelief = goalOutcomeBeliefFor(context.person, goalBasisKey);
  const expectedSuccess = goalOutcomeBeliefSuccess(goalBelief);
  const uncertainty = goalOutcomeBeliefUncertainty(goalBelief);
  const learnedGate = clamp(
    0.65 + expectedSuccess * 0.7 + (trait(context, 'openness') - 0.5) * uncertainty * 0.18,
    0.38,
    1.42,
  );
  const memory = memoryAppraisal(context, option, basisKey, moment.atMonth);
  const personalityGate = personalityCongruence(context, alignments);
  const relationship = relationshipAppraisal(context, option);
  const socialExpectation = appraiseSocialExpectation(context.person, option, moment.atMonth);
  const readiness = familyReadinessAppraisal(context, option, moment.atMonth);
  const repetition = assessSocialRepetition(context.state, context.person, option);
  const repetitionGate = repetition.subjectKey
    ? clamp(Math.exp(Math.tanh(repetition.score / 55) * 1.15), 0.28, 2.9)
    : 1;
  const ethical = ethicalAppraisal(context, option, agenda);
  const expectedEffort = actionBelief?.expectedEffort ?? 0.18;
  const expectedHarm = actionBelief?.expectedHarm ?? 0;
  const feasibilityGate = feasibilityAppraisal(context, option, expectedEffort, expectedHarm);
  const continuityGate = continuityAppraisal(context, option);
  const motivation = needActivation
    * personalityGate
    * learnedGate
    * memory.gate
    * feasibilityGate
    * relationship.gate
    * socialExpectation.gate
    * readiness.gate
    * repetitionGate
    * ethical.gate
    * continuityGate;
  const aspiration = 0.095 + (context.person.baselineCapacities?.cognition ?? 50) / 2_500;
  const causalScore = (motivation - aspiration) * 100;
  const activationFor = (kind: NeedKind) => {
    return Math.max(...alignments.filter((candidate) => candidate.kind === kind).map((alignment) => (
      (needForAlignment(alignment)?.urgency ?? 0) * alignment.strength
    )), 0);
  };
  const carePersonality = geometricMean([
    traitGate(trait(context, 'agreeableness')),
    traitGate(trait(context, 'emotionality')),
  ]);
  const learningPersonality = traitGate(trait(context, 'openness'), 0.5);
  const commitmentPersonality = traitGate(trait(context, 'conscientiousness'), 0.42);
  const socialPersonality = geometricMean([
    traitGate(trait(context, 'extraversion'), 0.42),
    traitGate(trait(context, 'agreeableness'), 0.25),
  ]);
  const factors = [
    factor('need', needActivation * 100, motivatingAlignments.map((alignment) => alignment.reason), addressedNeeds.flatMap((need) => need.sourceFactIds)),
    factor('care', Math.max(activationFor('care'), activationFor('bereavement')) * carePersonality * 100, ['情绪性与宜人性门控有来源的照护与悲恸需要'], addressedNeeds.filter((need) => need.kind === 'care' || need.kind === 'bereavement').flatMap((need) => need.sourceFactIds)),
    factor('commitment', activationFor('commitment') * commitmentPersonality * continuityGate * 100, ['尽责性、真实进度与本人已接受的有限职责门控意图持续'], [
      ...(context.activeIntent?.sourceFactIds ?? option.sourceFactIds),
      ...addressedNeeds.filter((need) => need.kind === 'commitment').flatMap((need) => need.sourceFactIds),
    ]),
    factor('learning', union([activationFor('inquiry'), activationFor('capability')]) * learningPersonality * 100, ['开放性调节对未知结果的探索，而不创造知识'], addressedNeeds.filter((need) => need.kind === 'inquiry' || need.kind === 'capability').flatMap((need) => need.sourceFactIds)),
    factor('relationship', activationFor('belonging') * socialPersonality * 100 + (relationship.gate - 1) * 40, relationship.reasons, relationship.sourceFactIds),
    factor('social-expectation', (socialExpectation.gate - 1) * 100, socialExpectation.reasons, socialExpectation.sourceFactIds),
    factor('family-readiness', (readiness.gate - 1) * 100, readiness.reasons, readiness.sourceFactIds),
    factor('social-repetition', repetition.score, repetition.reasons, repetition.sourceFactIds),
    factor('consent', relationship.consentDiagnostic, relationship.reasons, relationship.sourceFactIds),
    factor('feasibility', (feasibilityGate - 0.5) * 100, ['预计时长、本人经验中的努力和伤害共同约束可行性'], actionBelief?.sourceEventIds ?? option.sourceFactIds),
    factor('harm', ethical.value * 100, ethical.reason ? [ethical.reason] : [], ethical.sourceFactIds),
  ];
  const strongestNeeds = [...addressedNeeds].sort((left, right) => right.urgency - left.urgency).slice(0, 2);
  const reasons = [
    ...strongestNeeds.flatMap((need) => need.reasons.slice(0, 1)),
    ...(goalBelief ? [`本人对相似目标的达成预期为 ${Math.round(expectedSuccess * 100)}%（${goalBelief.attempts} 次亲历）`] : ['本人尚无相似目标结果，使用保守先验']),
    ...(memory.reason ? [memory.reason] : []),
    ...relationship.reasons.slice(0, 1),
    ...socialExpectation.reasons.slice(0, 1),
    ...readiness.reasons.slice(0, 1),
    ...(repetition.subjectKey ? repetition.reasons.slice(0, 1) : []),
    ...(ethical.reason ? [ethical.reason] : []),
  ];
  return {
    option,
    basisKey,
    needAlignments: alignments,
    addressedNeeds: strongestNeeds,
    needActivation,
    generativityUrgency,
    expectedSuccess,
    uncertainty,
    expectedEffort,
    expectedHarm,
    personalityGate,
    memoryGate: memory.gate,
    feasibilityGate,
    relationshipGate: relationship.gate,
    socialExpectationGate: socialExpectation.gate,
    readinessGate: readiness.gate,
    ...(readiness.assessment ? { familyReadiness: readiness.assessment } : {}),
    repetitionGate,
    ethicalGate: ethical.gate,
    continuityGate,
    motivation,
    aspiration,
    causalScore,
    factors,
    reasons: [...new Set(reasons)],
    sourceFactIds: [...new Set([
      ...option.sourceFactIds,
      ...strongestNeeds.flatMap((need) => need.sourceFactIds),
      ...(actionBelief?.sourceEventIds ?? []),
      ...(goalBelief?.sourceEventIds ?? []),
      ...memory.sourceFactIds,
      ...relationship.sourceFactIds,
      ...socialExpectation.sourceFactIds,
      ...readiness.sourceFactIds,
      ...repetition.sourceFactIds,
      ...ethical.sourceFactIds,
    ])].slice(-32),
  };
}

export function buildCognitiveFrame(
  context: DecisionContext,
  options: ActionOption[],
  moment: { atMonth: number; planningTick: number },
): CognitiveFrame {
  const needs = deriveNeedAgenda(context, moment.atMonth);
  return {
    architecture: 'causal-bdi-v1',
    planningMonth: moment.atMonth,
    planningTick: moment.planningTick,
    needs,
    appraisals: options.map((option) => evaluateCognitiveOption(context, option, moment, needs)),
  };
}
