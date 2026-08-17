import { goalSatisfied } from '../domain/action-executor';
import type { ActionOption, FactPredicate, LifeReviewEvidence } from '../domain/action';
import { Material, materialHas } from '../domain/material';
import type { AgentDecider, Decision, DecisionContext } from '../domain/model';
import { ageMonths } from '../domain/person';
import { seededFraction } from '../world/generator';
import { geneticKinshipRisk, hasLearnedKinshipRisk } from '../domain/kinship';

const REQUIRED_SOCIAL_RESPONSE = /^(?:(?:accept|reject)-(?:assist|companion|exchange|reproduce|collective|membership|permission|decision-rule|mandate):|respond-conversation:)/;
const FULFILLMENT_OPTION = /^(settle-exchange|fulfill-assist|meet-to-assist|join-water-assist|contribute-mandate|distribute-mandate|use-permission|reproduce):/;

export interface PlanningMoment {
  atMonth: number;
  planningTick: number;
}

export function isRequiredSocialOption(option: ActionOption): boolean {
  return REQUIRED_SOCIAL_RESPONSE.test(option.id);
}

export function isFulfillmentOption(option: ActionOption): boolean {
  return FULFILLMENT_OPTION.test(option.id);
}

export function hasRequiredSocialResponse(context: DecisionContext): boolean {
  return context.options.some(isRequiredSocialOption);
}

export function hasFulfillmentOpportunity(context: DecisionContext): boolean {
  return context.options.some(isFulfillmentOption);
}

export function isMaintainableStateGoal(goal: FactPredicate): boolean {
  return goal.kind === 'inventory-at-least'
    || goal.kind === 'container-inventory-at-least'
    || goal.kind === 'at-cell'
    || goal.kind === 'sheltered'
    || goal.kind === 'voxel-is'
    || goal.kind === 'knowledge'
    || goal.kind === 'project-completed';
}

export function isProductionOption(option: ActionOption): boolean {
  return option.domain !== 'social' && isMaintainableStateGoal(option.goal);
}

const OPTIONAL_LIFE_REVIEW = /^(offer-reproduce|offer-companion):/;

export interface GroundedLifeReviewOpportunity {
  option: ActionOption;
  lifePressure: number;
  projectPressure: number;
  reasons: string[];
  evidence: LifeReviewEvidence;
}

function reproductiveWindow(context: DecisionContext, option: ActionOption): { pressure: number; band?: LifeReviewEvidence['femaleAgeBand'] } {
  if (!option.id.startsWith('offer-reproduce:') || option.target?.kind !== 'person') return { pressure: 0 };
  const partnerId = option.target.personId;
  const partner = context.state.people.find((candidate) => candidate.id === partnerId);
  const female = context.person.sex === 'female' ? context.person : partner?.sex === 'female' ? partner : undefined;
  if (!female) return { pressure: 0 };
  const age = ageMonths(female, context.state.clock.elapsedMonths);
  const ageYears = age / 12;
  const band: NonNullable<LifeReviewEvidence['femaleAgeBand']> = ageYears < 30
    ? 'under-30'
    : ageYears < 35
      ? '30-34'
      : ageYears < 38
        ? '35-37'
        : ageYears < 41
          ? '38-40'
          : '41-45';
  const pressure = band === 'under-30'
    ? 0
    : band === '30-34'
      ? 8
      : band === '35-37'
        ? 24
        : band === '38-40'
          ? 40
          : 56;
  return { pressure, band };
}

function lifeReviewPressure(context: DecisionContext, option: ActionOption): {
  pressure: number;
  reasons: string[];
  relationSourceEventIds: string[];
  femaleAgeBand?: LifeReviewEvidence['femaleAgeBand'];
} {
  const targetId = option.target?.kind === 'person' ? option.target.personId : undefined;
  const relation = targetId ? context.person.relations.find((candidate) => candidate.personId === targetId) : undefined;
  const relationPressure = Math.min(30, Math.max(0, relation?.trust ?? 0) * 0.9 + Math.max(0, relation?.bond ?? 0) * 1.1);
  const affiliationPressure = Math.min(10, Math.max(0, context.person.driveBias.affiliation - 45) * 0.2);
  const window = reproductiveWindow(context, option);
  const base = option.id.startsWith('offer-reproduce:') ? 36 : 30;
  const reasons: string[] = [];
  if (relationPressure > 0) reasons.push('已有关系证据');
  if (window.pressure > 0) reasons.push('女性生育年龄窗口正在收窄');
  if (affiliationPressure > 0) reasons.push('本人有较强归属倾向');
  return {
    pressure: Math.min(140, base + relationPressure + affiliationPressure + window.pressure),
    reasons,
    relationSourceEventIds: [...new Set(option.relationshipBasis?.relationshipKeys ?? relation?.sourceEventIds ?? [])].sort(),
    ...(window.band ? { femaleAgeBand: window.band } : {}),
  };
}

function optionScore(context: DecisionContext, option: ActionOption, moment: PlanningMoment): number {
  const person = context.person;
  let score = seededFraction(
    context.state.seed,
    `rule-option:${context.state.branchId}:${moment.atMonth}:${moment.planningTick}:${person.id}:${option.id}`,
  ) * 8;

  if (isRequiredSocialOption(option)) score += 1_000;
  else if (isFulfillmentOption(option)) score += 850;
  else if (isProductionOption(option)) score += 64;
  else if (option.domain === 'strategic') score += 28;
  else score -= 42;

  if (option.projectId) score += 72 + (option.projectPressure ?? 0) * 0.9;
  if (option.projectProposal) score += 18;

  if (option.id.startsWith('drink:')) score += 140 - person.body.hydration;
  if (option.id.startsWith('eat:')) score += 135 - person.body.nutrition;
  if (option.id.startsWith('collect:')) {
    const materialId = option.goal.kind === 'inventory-at-least' ? option.goal.materialId : Material.Air;
    score += materialId === Material.Food
      ? 88 - person.body.nutrition
      : materialId === Material.Wood
        ? 34
        : materialId === Material.Seed
          ? 25
          : 14;
  }
  if (option.id.startsWith('harvest:')) score += 82 - person.body.nutrition;
  if (option.id.startsWith('hunt:')) {
    const predator = option.reason.includes('捕食动物');
    score += (predator ? 72 : 46) + Math.max(0, 68 - person.body.nutrition);
  }
  if (option.id.startsWith('attend-animal:')) score += 26 + person.driveBias.inquiryCreation * 0.25;
  if (option.id.startsWith('try-combine:')) score += person.driveBias.inquiryCreation * 0.3;
  if (option.id.startsWith('repeat-combine:')) score += 42 + person.driveBias.inquiryCreation * 0.08;
  if (option.id.startsWith('try-inventory-combine:')) score += person.driveBias.inquiryCreation * 0.28;
  if (option.id.startsWith('repeat-inventory-combine:')) score += 38 + person.driveBias.inquiryCreation * 0.08;
  if (option.id.startsWith('build:')) score += 34 + (context.state.civilization.climate.kind === 'cold' || context.state.civilization.climate.kind === 'heat' ? 30 : 0);
  if (option.id.startsWith('shelter:')) {
    const stage = person.conditions.find((condition) => condition.kind === 'cold' || condition.kind === 'heat')?.stage ?? 0;
    score += 48 + stage * 28;
  }
  if (option.id.startsWith('store-container:')) score += 26;
  if (option.id.startsWith('retrieve-container:')) {
    const materialId = option.goal.kind === 'inventory-at-least' ? option.goal.materialId : Material.Air;
    score += materialHas(materialId, 'edible') ? 90 - person.body.nutrition : 22;
  }
  if (option.id.startsWith('care:')) score += 68 + person.driveBias.affiliation * 0.35;
  if (option.id.startsWith('predict-era:')) score += 104 + person.baselineCapacities.cognition * 0.28 + person.driveBias.inquiryCreation * 0.16;
  if (option.id.startsWith('dehydrate-chaos:')) score += context.state.civilization.epoch === 'chaotic' ? 260 : 128;
  if (option.id.startsWith('rehydrate:')) score += 210 + person.driveBias.affiliation * 0.25;
  if (option.id.startsWith('offer-reproduce:')) score += 112 + person.driveBias.affiliation * 0.38;
  if (option.id.startsWith('accept-reproduce:')) score += 140 + person.driveBias.affiliation * 0.3;
  if (option.id.startsWith('reproduce:')) score += 180 + person.driveBias.affiliation * 0.3;
  const reproductionOption = option.id.startsWith('offer-reproduce:')
    || option.id.startsWith('accept-reproduce:')
    || option.id.startsWith('reject-reproduce:')
    || option.id.startsWith('reproduce:');
  const targetPersonId = option.target?.kind === 'person' ? option.target.personId : undefined;
  if (reproductionOption && targetPersonId && hasLearnedKinshipRisk(person)) {
    const other = context.state.people.find((candidate) => candidate.id === targetPersonId);
    const risk = other ? geneticKinshipRisk(context.state, person, other) : 0;
    score += option.id.startsWith('reject-reproduce:') ? risk * 260 : -risk * 320;
  }
  if (option.id.startsWith('settle-exchange:')) score += 100;
  if (option.id.startsWith('accept-exchange:')) score += 55;
  if (option.id.startsWith('offer-collective:')) score += 250;
  if (option.id.startsWith('rejoin-project-site:')) score += 160;
  if (option.id.startsWith('offer-decision-rule:')) score += 238;
  if (option.id.startsWith('offer-mandate:')) score += 242;
  if (option.id.startsWith('accept-collective:') && option.target?.kind === 'person') {
    const proposerId = option.target.personId;
    const relation = person.relations.find((candidate) => candidate.personId === proposerId);
    score += (relation?.trust ?? 0) * 4 + (relation?.bond ?? 0) * 2;
  }
  if (option.id.startsWith('reject-collective:') && option.target?.kind === 'person') {
    const proposerId = option.target.personId;
    const relation = person.relations.find((candidate) => candidate.personId === proposerId);
    score += Math.max(0, 8 - (relation?.trust ?? 0)) * 4;
  }
  if (option.id.startsWith('rejoin-collective:')) score += 44;
  if (option.id.startsWith('withdraw-collective:')) score += 72;
  if (option.id.startsWith('take-without-permission:')) score += person.body.nutrition < 12 ? 110 : 28;
  if (option.id.startsWith('exert-person:')) score += person.body.nutrition < 18 ? 26 : -12;
  if (option.id.startsWith('teach:')) {
    const learnerId = option.target?.kind === 'person' ? option.target.personId : undefined;
    const learner = learnerId ? context.state.people.find((candidate) => candidate.id === learnerId) : undefined;
    const teachesCodebook = option.summary.includes('记录刻痕');
    score += (teachesCodebook ? 190 : learner && learner.generation > person.generation ? 175 : 150)
      + person.driveBias.affiliation * 0.18;
  }
  if (option.id.startsWith('conversation:')) {
    score += 126 + person.driveBias.affiliation * 0.22;
  }
  if (option.recordUseBasis) {
    score += (option.recordUseStage === 'read-experiment' ? 250 : 190)
      + option.recordUseBasis.projectPressure * 0.7;
  }
  if (option.id.startsWith('attend:')) score += 18 + person.driveBias.inquiryCreation * 0.28;
  if (option.id.startsWith('explore:')) score += 12 + person.driveBias.inquiryCreation * 0.16;

  score -= (option.estimatedMonths ?? 1) * 1.5;
  score -= (option.risks?.length ?? 0) * 16;
  return score;
}

function rankOptions(context: DecisionContext, options: ActionOption[], moment: PlanningMoment): ActionOption[] {
  return [...options].sort((a, b) => optionScore(context, b, moment) - optionScore(context, a, moment) || a.id.localeCompare(b.id));
}

function chooseOption(context: DecisionContext, moment: PlanningMoment): { option?: ActionOption; followUp?: ActionOption } {
  const option = rankOptions(context, context.options, moment)[0];
  const followUp = option?.requiresFollowUp
    ? rankOptions(context, context.followUpOptions, moment)[0]
    : undefined;
  return { option, followUp };
}

function urgentReplan(context: DecisionContext): boolean {
  const person = context.person;
  return person.body.health < 35
    || person.body.hydration < 28
    || person.body.nutrition < 28
    || person.conditions.some((condition) => (
      condition.kind === 'cold'
      || condition.kind === 'heat'
      || condition.kind === 'wound'
      || condition.kind === 'illness'
    ) && condition.stage >= 2);
}

/**
 * A progressing project may be reviewed only when a concrete, locally compiled
 * relationship option exists and its person-level pressure exceeds that
 * project's own stored pressure. Population and civilization observations are
 * deliberately absent from this comparison.
 */
export function groundedLifeReviewOpportunity(context: DecisionContext): GroundedLifeReviewOpportunity | null {
  const active = context.activeIntent;
  if (!active?.projectId || urgentReplan(context)) return null;
  const reviewMonth = context.state.clock.elapsedMonths + 1;
  for (let index = context.state.world.past.length - 1; index >= 0; index -= 1) {
    const event = context.state.world.past[index];
    if (event.atMonth < reviewMonth) break;
    if (event.atMonth === reviewMonth
      && event.kind === 'decision'
      && event.who === context.person.id
      && (event.decision.kind === 'start' || event.decision.kind === 'revise')
      && event.decision.lifeReview) return null;
  }
  const project = context.state.projects.find((candidate) => candidate.id === active.projectId && candidate.status === 'active');
  if (!project) return null;
  const candidates = context.options
    .filter((option) => OPTIONAL_LIFE_REVIEW.test(option.id))
    .flatMap((option) => {
      if (option.target?.kind !== 'person' || !option.relationshipBasis) return [];
      const scored = lifeReviewPressure(context, option);
      const optionKind: LifeReviewEvidence['optionKind'] = option.id.startsWith('offer-reproduce:')
        ? 'offer-reproduce'
        : 'offer-companion';
      const basisKey = option.relationshipBasis.basisKey;
      if (context.state.intents.some((intent) => intent.ownerId === context.person.id
        && (intent.lifeReview?.relationshipBasis?.basisKey === basisKey
          || intent.lifeReview?.basisKey === basisKey
          || intent.relationshipBasis?.basisKey === basisKey))) return [];
      const projectSourceEventIds = [...new Set([
        ...project.triggerFactIds,
        ...(project.pressureBasis?.sourceFactIds ?? []),
      ])].sort();
      const sourceFactIds = [...new Set([
        ...option.sourceFactIds,
        ...scored.relationSourceEventIds,
        ...projectSourceEventIds,
      ])];
      const evidence: LifeReviewEvidence = {
        version: 'causal-edge-v2',
        basisKey,
        optionKind,
        targetPersonId: option.target.personId,
        projectId: project.id,
        relationSourceEventIds: scored.relationSourceEventIds,
        projectSourceEventIds,
        sourceFactIds,
        ...(scored.femaleAgeBand ? { femaleAgeBand: scored.femaleAgeBand } : {}),
        lifePressure: Math.round(scored.pressure * 100) / 100,
        projectPressure: project.pressure,
        relationshipBasis: structuredClone(option.relationshipBasis),
      };
      return [{ option, ...scored, evidence }];
    })
    .sort((left, right) => right.pressure - left.pressure || left.option.id.localeCompare(right.option.id));
  const best = candidates[0];
  if (!best || best.pressure < project.pressure + 10) return null;
  return {
    option: best.option,
    lifePressure: Math.round(best.pressure * 100) / 100,
    projectPressure: project.pressure,
    reasons: best.reasons,
    evidence: best.evidence,
  };
}

/**
 * The authoritative, deterministic person planner. It is deliberately local:
 * it only ranks affordances already produced from facts visible to the person.
 */
export class RulePlanner implements AgentDecider {
  decide(context: DecisionContext): Decision {
    return this.decideAt(context, {
      atMonth: context.state.clock.elapsedMonths + 1,
      planningTick: 1,
    });
  }

  decideAt(context: DecisionContext, moment: PlanningMoment): Decision {
    const active = context.activeIntent;
    const required = context.options.filter(isRequiredSocialOption);
    const fulfillment = context.options.filter(isFulfillmentOption);
    const forcedOptions = required.length ? required : fulfillment;
    const forced = rankOptions(context, forcedOptions, moment)[0];
    if (active && forced) {
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: forced.id,
        ...(active.projectId || active.returnToIntentId ? {
          mode: 'interrupt' as const,
          interruptionKind: required.length ? 'required-response' as const : 'fulfillment' as const,
        } : {}),
        reason: required.length ? '先完成必须由本人作出的回应' : '先履行已经生效的承诺或职责',
      };
    }

    const lifeReview = active ? groundedLifeReviewOpportunity(context) : null;
    if (active && lifeReview) {
      const matchingProjectFollowUps = context.followUpOptions.filter((option) => option.projectId === active.projectId);
      const followUp = lifeReview.option.requiresFollowUp
        ? rankOptions(context, matchingProjectFollowUps.length ? matchingProjectFollowUps : context.followUpOptions, moment)[0]
        : undefined;
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: lifeReview.option.id,
        ...(followUp ? { followUpOptionId: followUp.id } : {}),
        mode: 'interrupt',
        interruptionKind: 'life-review',
        reason: `生活复核：${lifeReview.reasons.length ? lifeReview.reasons.join('、') : '眼前出现具体生活机会'}；生活压力 ${lifeReview.lifePressure} 超过项目压力 ${lifeReview.projectPressure}`,
        lifeReview: lifeReview.evidence,
      };
    }

    const { option, followUp } = chooseOption(context, moment);
    if (!active) {
      return option
        ? {
            kind: 'start',
            optionId: option.id,
            ...(followUp ? { followUpOptionId: followUp.id } : {}),
            reason: option.reason,
          }
        : { kind: 'idle', reason: context.options.length ? '当前合法目标都没有正向价值' : '当前没有可执行目标' };
    }

    if (option?.recordUseBasis
      && !active.recordUseBasis
      && (active.projectId || active.returnToIntentId)) {
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: option.id,
        mode: 'interrupt',
        interruptionKind: 'record-use',
        reason: option.recordUseStage === 'read-experiment'
          ? '实体记录与当前项目的真实技术缺口完全匹配，先读懂并用手头材料复现，再返回原项目'
          : '这块实体记录正好能解除身边项目的真实技术缺口，短暂交付后继续原安排',
      };
    }

    if (option?.id.startsWith('offer-collective:') && option.sourceFactIds.length > 0) {
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: option.id,
        ...(followUp ? { followUpOptionId: followUp.id } : {}),
        reason: '与共同项目协作者重逢，出现了把已完成合作延续为成员关系的具体机会',
      };
    }

    const overdue = active.stateGoalUntilMonth !== undefined
      && moment.atMonth > active.stateGoalUntilMonth
      && !goalSatisfied(context.state, context.person, active.goal);
    // Time spent suspended by an explicit child intent is not project
    // stagnation. Give the restored parent a chance to recompile and act
    // before an ordinary revise may replace it.
    const progressAnchorMonth = Math.max(active.lastProgressAtMonth, active.lastResumedAtMonth ?? active.lastProgressAtMonth);
    const stalled = moment.atMonth - progressAnchorMonth >= 2
      && !goalSatisfied(context.state, context.person, active.goal);
    if ((urgentReplan(context) || overdue || stalled) && option) {
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: option.id,
        ...(followUp ? { followUpOptionId: followUp.id } : {}),
        reason: urgentReplan(context)
          ? '身体或环境危险需要立即改变执行焦点'
          : overdue
            ? '长期状态目标到期仍未满足，改用当前最佳可执行目标'
            : '原目标持续没有进展，改用当前最佳可执行目标',
      };
    }
    return { kind: 'idle', reason: '现有长期意图仍可继续，不做无意义改换' };
  }
}

/** @deprecated Use RulePlanner. Kept for old imports and test fixtures. */
export class MockDecider extends RulePlanner {}
