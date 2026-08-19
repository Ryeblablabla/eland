import type { ActionOption } from '../domain/action';
import { materialHas } from '../domain/material';
import type { DecisionContext } from '../domain/model';
import { inventoryQuantity } from '../domain/person';
import { geneticKinshipRisk, hasLearnedKinshipRisk } from '../domain/kinship';
import { cellX, cellY } from '../world/grid';
import { seededFraction } from '../world/generator';
import { reproductiveResponsibility } from '../domain/dependent-care';
import { personalityBias, personalityEvidenceSourceIds } from '../domain/personality';
import { REPRODUCTION_RELATION_THRESHOLD } from '../domain/relation';
import { assessSocialRepetition } from '../domain/social-repetition';

export interface DecisionFactorVote {
  tree: 'need' | 'care' | 'commitment' | 'learning' | 'relationship' | 'social-repetition' | 'consent' | 'feasibility' | 'harm';
  score: number;
  reasons: string[];
  sourceFactIds: string[];
}

export interface DecisionFactorEvaluation {
  option: ActionOption;
  causalScore: number;
  score: number;
  votes: DecisionFactorVote[];
  /** Stable noise below one point: it may break a tie, never create a motive. */
  tieBreak: number;
}

export interface DecisionFactorMoment {
  atMonth: number;
  planningTick: number;
}

function vote(
  tree: DecisionFactorVote['tree'],
  score: number,
  reasons: string[],
  sourceFactIds: string[] = [],
): DecisionFactorVote {
  return { tree, score, reasons, sourceFactIds: [...new Set(sourceFactIds)] };
}

function needVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  const person = context.person;
  const goal = option.goal;
  let score = 0;
  const reasons: string[] = [];
  if (goal.kind === 'body-at-least') {
    const current = person.body[goal.field];
    const deficit = Math.max(0, goal.value - current);
    const danger = Math.max(0, 58 - current);
    score += deficit * 1.1 + danger * 1.8;
    reasons.push(`${goal.field}缺口 ${Math.round(deficit)}`);
  } else if (goal.kind === 'inventory-at-least') {
    const owner = goal.personId
      ? context.state.people.find((candidate) => candidate.id === goal.personId)
      : person;
    const deficit = Math.max(0, goal.quantity - (owner ? inventoryQuantity(owner, goal.materialId) : 0));
    score += deficit * (materialHas(goal.materialId, 'edible') && person.body.nutrition < 55 ? 24 : 7);
    if (deficit > 0) reasons.push(`可见物资缺口 ${deficit}`);
  } else if (goal.kind === 'sheltered') {
    const thermal = person.conditions
      .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
      .reduce((maximum, condition) => Math.max(maximum, condition.stage), 0);
    score += thermal * 46 + (context.state.civilization.climate.severity >= 3 ? 18 : 0);
    if (score > 0) reasons.push('本人正承受可感知的环境压力');
  } else if (goal.kind === 'condition' && goal.personId === person.id) {
    if (goal.condition === 'pregnancy') return vote('need', 0, ['妊娠不是需要被填补的身体缺口'], option.sourceFactIds);
    const present = person.conditions.some((condition) => condition.kind === goal.condition);
    score += present === goal.present ? -10 : 42;
    reasons.push('改变本人当前身体状态');
  } else if (goal.kind === 'at-cell') {
    const distance = Math.abs(cellX(goal.cellId) - cellX(person.position.cellId))
      + Math.abs(cellY(goal.cellId) - cellY(person.position.cellId));
    score += option.projectId ? Math.max(4, 18 - distance) : 0;
    if (option.projectId) reasons.push('移动服务于已承诺项目');
  }
  return vote('need', score, reasons, option.sourceFactIds);
}

function careVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  const targetId = option.target?.kind === 'person'
    ? option.target.personId
    : option.goal.kind === 'condition' || option.goal.kind === 'body-at-most'
      ? option.goal.personId
      : option.nextAction.kind === 'transfer' && option.nextAction.to.kind === 'person'
        ? option.nextAction.to.personId
        : undefined;
  if (!targetId || targetId === context.person.id) return vote('care', 0, []);
  const target = context.visiblePeople.find((candidate) => candidate.id === targetId);
  if (!target) return vote('care', -28, ['目标人物不在当前可感知范围']);
  const relation = context.person.relations.find((candidate) => candidate.personId === targetId);
  const bodilyDanger = Math.max(0, 55 - target.body.health)
    + Math.max(0, 50 - target.body.hydration)
    + Math.max(0, 45 - target.body.nutrition);
  const kin = target.geneticParents.includes(context.person.id) || context.person.geneticParents.includes(target.id);
  const personality = personalityBias(context.person, 'emotionality', 0.13, 7)
    + personalityBias(context.person, 'agreeableness', 0.13, 7);
  const score = bodilyDanger * 1.35
    + Math.max(0, relation?.bond ?? 0) * 0.45
    + Math.max(0, relation?.trust ?? 0) * 0.25
    + (kin ? 22 : 0)
    + personality;
  return vote(
    'care',
    score,
    [bodilyDanger > 0 ? '眼前人物存在身体风险' : '眼前关系提供照护动机', '情绪性与宜人性调节照护意愿'],
    [...(relation?.sourceEventIds ?? []), ...personalityEvidenceSourceIds(context.person, ['emotionality', 'agreeableness'])],
  );
}

function commitmentVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  const active = context.activeIntent;
  const conscientiousness = personalityBias(context.person, 'conscientiousness', 0.16, 8);
  const authorizedTransfer = option.nextAction.kind === 'transfer' && Boolean(option.nextAction.authorizationRef);
  const honesty = authorizedTransfer ? personalityBias(context.person, 'honestyHumility', 0.1, 5) : 0;
  const personalitySources = personalityEvidenceSourceIds(context.person, ['conscientiousness', 'honestyHumility']);
  if (option.projectId) {
    const continuity = active?.projectId === option.projectId ? 38 : 0;
    return vote(
      'commitment',
      34 + continuity + Math.max(0, option.projectPressure ?? 0) * 0.8 + conscientiousness + honesty,
      [continuity ? '继续本人已经承诺的项目' : '推进一个已有来源与复核点的项目', '尽责性调节持续投入与履约'],
      [...option.sourceFactIds, ...personalitySources],
    );
  }
  if (option.projectProposal) {
    return vote(
      'commitment',
      10 + Math.max(0, option.projectPressure ?? 0) * 0.55 + conscientiousness,
      ['候选包含明确需求、步骤与复核期限', '尽责性调节开始长期工作的意愿'],
      [...option.sourceFactIds, ...personalitySources],
    );
  }
  if (authorizedTransfer) return vote(
    'commitment',
    conscientiousness + honesty,
    ['尽责性与诚实—谦逊调节已授权交付'],
    [...option.sourceFactIds, ...personalitySources],
  );
  return vote('commitment', 0, []);
}

function learningVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  const learning = option.goal.kind === 'knowledge'
    || option.nextAction.kind === 'attend'
    || Boolean(option.recordUseBasis);
  if (!learning) return vote('learning', 0, []);
  const grounded = option.sourceFactIds.length > 0 || Boolean(option.projectId || option.recordUseBasis);
  const openness = personalityBias(context.person, 'openness', 0.28, 14);
  return vote(
    'learning',
    (grounded ? 22 : 6) + openness + (option.recordUseBasis ? option.recordUseBasis.projectPressure * 0.7 : 0),
    [grounded ? '学习回应可追溯观察或项目缺口' : '直接观察当前可见对象', '开放性调节探索与试验意愿'],
    [...option.sourceFactIds, ...personalityEvidenceSourceIds(context.person, ['openness'])],
  );
}

function relationshipVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  if (option.domain !== 'social' && !option.relationshipBasis) return vote('relationship', 0, []);
  const targetId = option.target?.kind === 'person' ? option.target.personId : undefined;
  const relation = targetId ? context.person.relations.find((candidate) => candidate.personId === targetId) : undefined;
  const sourceIds = [...new Set([
    ...option.sourceFactIds,
    ...(option.relationshipBasis?.sourceFactIds ?? []),
    ...(relation?.sourceEventIds ?? []),
  ])];
  const sourced = sourceIds.length > 0;
  const trust = Math.max(-12, Math.min(28, relation?.trust ?? 0));
  const bond = Math.max(-12, Math.min(28, relation?.bond ?? 0));
  const fear = Math.max(0, relation?.fear ?? 0);
  const action = option.nextAction.kind === 'communicate' ? option.nextAction : option.completionAction?.kind === 'communicate' ? option.completionAction : undefined;
  const initiating = action && (action.content.kind === 'claim'
    || action.content.kind === 'prediction'
    || action.content.kind === 'request'
    || action.content.kind === 'offer');
  const extraversion = initiating ? personalityBias(context.person, 'extraversion', 0.18, 9) : 0;
  const agreeableness = personalityBias(context.person, 'agreeableness', 0.1, 5);
  const score = (sourced ? 10 : -12)
    + trust * 0.7
    + bond * 0.8
    - fear * 0.65
    + extraversion
    + agreeableness;
  return vote(
    'relationship',
    score,
    [sourced ? '社会行动有关系或事件来源' : '缺少可追溯的社会契机', '外向性与宜人性调节社会接近方式'],
    [...sourceIds, ...personalityEvidenceSourceIds(context.person, ['extraversion', 'agreeableness'])],
  );
}

function socialRepetitionVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  const assessment = assessSocialRepetition(context.state, context.person, option);
  return vote('social-repetition', assessment.score, assessment.reasons, assessment.sourceFactIds);
}

function consentVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  const action = option.nextAction.kind === 'communicate'
    ? option.nextAction
    : option.completionAction?.kind === 'communicate'
      ? option.completionAction
      : undefined;
  const response = action?.content;
  const referencedAgreementId = response && (response.kind === 'accept' || response.kind === 'reject' || response.kind === 'revoke-agreement')
    ? response.referenceId
    : undefined;
  const agreement = referencedAgreementId
    ? context.state.agreements.find((candidate) => candidate.id === referencedAgreementId
      || candidate.proposalEventId === referencedAgreementId)
    : option.id.startsWith('reproduce:') || option.id.startsWith('withdraw-reproduce:')
      ? [...context.state.agreements].reverse().find((candidate) => candidate.status === 'active'
        && candidate.proposal.kind === 'reproduce'
        && candidate.partyIds.includes(context.person.id)
        && (!option.target || option.target.kind !== 'person' || candidate.partyIds.includes(option.target.personId)))
      : undefined;
  const offeredReproduction = response?.kind === 'offer' && response.proposal?.kind === 'reproduce';
  const reproductionDecision = offeredReproduction
    || agreement?.proposal.kind === 'reproduce'
    || option.id.startsWith('reproduce:')
    || option.id.startsWith('withdraw-reproduce:');
  if (!reproductionDecision && (!response || (response.kind !== 'accept' && response.kind !== 'reject'))) return vote('consent', 0, []);
  if (!agreement && !offeredReproduction) return vote('consent', -24, ['回应所引用的协议已经不可解析']);
  const otherId = agreement?.partyIds.find((personId) => personId !== context.person.id);
  const resolvedOtherId = otherId ?? (option.target?.kind === 'person' ? option.target.personId : undefined);
  const other = resolvedOtherId ? context.state.people.find((candidate) => candidate.id === resolvedOtherId) : undefined;
  const relation = resolvedOtherId ? context.person.relations.find((candidate) => candidate.personId === resolvedOtherId) : undefined;
  let acceptValue = reproductionDecision
    ? 12
      + Math.max(0, Math.min(20, (relation?.trust ?? 0) - REPRODUCTION_RELATION_THRESHOLD)) * 0.45
      + Math.max(0, Math.min(20, (relation?.bond ?? 0) - REPRODUCTION_RELATION_THRESHOLD)) * 0.45
      - Math.max(0, relation?.fear ?? 0) * 1.1
      + personalityBias(context.person, 'agreeableness', 0.08, 4)
    : Math.max(-20, Math.min(30, relation?.trust ?? 0)) * 1.2
      + Math.max(-20, Math.min(30, relation?.bond ?? 0)) * 1.1
      - Math.max(0, relation?.fear ?? 0) * 1.1
      + personalityBias(context.person, 'agreeableness', 0.08, 4);
  const reasons = ['按本人已知关系评估一项待回应协议', '宜人性只小幅调节合作倾向，不替代同意'];
  const sourceFactIds = new Set(agreement?.sourceEventIds ?? option.sourceFactIds);
  personalityEvidenceSourceIds(context.person, ['agreeableness']).forEach((eventId) => sourceFactIds.add(eventId));
  if (reproductionDecision) {
    const responsibility = reproductiveResponsibility(context.state, context.person);
    acceptValue -= responsibility.pressure * 2;
    responsibility.sourceFactIds.forEach((eventId) => sourceFactIds.add(eventId));
    reasons.push(...responsibility.reasons);
  }
  if (reproductionDecision && other && hasLearnedKinshipRisk(context.person)) {
    const risk = geneticKinshipRisk(context.state, context.person, other);
    acceptValue -= risk * 180;
    reasons.push('本人已从后果中学到亲缘繁衍风险');
  }
  const proceeds = offeredReproduction
    || response?.kind === 'accept'
    || option.id.startsWith('reproduce:');
  const score = proceeds ? acceptValue : -acceptValue;
  return vote('consent', score, reasons, [...sourceFactIds]);
}

function feasibilityVote(option: ActionOption): DecisionFactorVote {
  const durationCost = option.estimatedMonths
    ?? (option.estimatedDuration === 'one-month' ? 1 : option.estimatedDuration === 'several-months' ? 4 : option.estimatedDuration === 'long' ? 9 : 6);
  const evidence = Math.min(14, option.sourceFactIds.length * 2);
  const score = evidence - durationCost * 1.8 - (option.risks?.length ?? 0) * 12;
  return vote('feasibility', score, [option.sourceFactIds.length ? '候选由本地事实编译' : '候选只依赖眼前可操作对象'], option.sourceFactIds);
}

function harmVote(context: DecisionContext, option: ActionOption): DecisionFactorVote {
  const action = option.nextAction;
  const desperate = context.person.body.nutrition < 22 || context.person.body.health < 25;
  const unauthorizedTaking = action.kind === 'transfer'
    && action.from.kind === 'person'
    && action.from.personId !== context.person.id
    && !action.authorizationRef;
  const interpersonalExertion = action.kind === 'act'
    && action.operation === 'exert'
    && action.targets.some((target) => target.kind === 'person');
  const restraint = option.goal.kind === 'condition' && option.goal.condition === 'restrained' && option.goal.present;
  const hunting = action.kind === 'act' && action.operation === 'hunt';
  if (!unauthorizedTaking && !interpersonalExertion && !restraint && !hunting) return vote('harm', 0, []);
  const honesty = personalityBias(context.person, 'honestyHumility', 0.28, 14);
  const agreeableness = personalityBias(context.person, 'agreeableness', 0.26, 13);
  const conscientiousness = personalityBias(context.person, 'conscientiousness', 0.16, 8);
  const emotionality = personalityBias(context.person, 'emotionality', 0.12, 6);
  const sourceIds = [...option.sourceFactIds, ...personalityEvidenceSourceIds(
    context.person,
    unauthorizedTaking ? ['honestyHumility', 'conscientiousness'] : hunting ? ['emotionality'] : ['honestyHumility', 'agreeableness', 'conscientiousness', 'emotionality'],
  )];
  if (unauthorizedTaking) return vote(
    'harm',
    (desperate ? -8 : -34) - honesty - conscientiousness,
    [desperate ? '严重生存压力降低了未授权取物的抑制' : '未授权取物缺少足以抵消关系与后果风险的压力', '诚实—谦逊与尽责性调节占取和冲动'],
    sourceIds,
  );
  if (hunting) return vote(
    'harm',
    (desperate ? 14 : -8) - emotionality,
    [desperate ? '严重生存压力提高捕猎价值' : '捕猎承担受伤和杀伤风险', '情绪性调节对身体危险的回避'],
    sourceIds,
  );
  const base = restraint ? (desperate ? -14 : -58) : (desperate ? -18 : -72);
  return vote(
    'harm',
    base - honesty - agreeableness - conscientiousness - emotionality,
    [desperate ? '严重生存压力降低了人际伤害抑制' : '人际伤害缺少足以抵消风险的压力', '诚实—谦逊、宜人性、尽责性与情绪性共同调节伤害选择'],
    sourceIds,
  );
}

export function evaluateDecisionOption(
  context: DecisionContext,
  option: ActionOption,
  moment: DecisionFactorMoment,
): DecisionFactorEvaluation {
  const votes = [
    needVote(context, option),
    careVote(context, option),
    commitmentVote(context, option),
    learningVote(context, option),
    relationshipVote(context, option),
    socialRepetitionVote(context, option),
    consentVote(context, option),
    feasibilityVote(option),
    harmVote(context, option),
  ];
  const causalScore = votes.reduce((total, item) => total + item.score, 0);
  const tieBreak = seededFraction(
    context.state.seed,
    `decision-factor-tie:${context.state.branchId}:${moment.atMonth}:${moment.planningTick}:${context.person.id}:${option.id}`,
  ) * 0.75;
  return { option, votes, tieBreak, causalScore, score: causalScore + tieBreak };
}

export function rankByDecisionFactorForest(
  context: DecisionContext,
  options: ActionOption[],
  moment: DecisionFactorMoment,
): DecisionFactorEvaluation[] {
  return options
    .map((option) => evaluateDecisionOption(context, option, moment))
    .sort((left, right) => right.score - left.score || left.option.id.localeCompare(right.option.id));
}
