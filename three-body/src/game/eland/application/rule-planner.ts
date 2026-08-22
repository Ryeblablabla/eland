import { goalSatisfied } from '../domain/action-executor';
import type { ActionOption, FactPredicate, Intent, LifeReviewEvidence } from '../domain/action';
import type { AgentDecider, Decision, DecisionContext } from '../domain/model';
import { ageMonths } from '../domain/person';
import { followUpSemanticallyMatches } from '../domain/intent-follow-up';
import { reproductiveResponsibility } from '../domain/dependent-care';
import { personalityScore } from '../domain/personality';
import { planningOverlayEvents } from '../domain/event-index';
import { intentsOwnedBy, projectById } from '../domain/state-index';
import { isObservedEmergencyHibernationOption } from './action-options';
import { perceivedKinshipRisk } from './reproductive-risk';
import {
  assessIntentionPersistence,
  deliberate,
  rankCognitiveOptions,
  type RankedCognitiveAppraisal,
} from './cognition/bdi-deliberation';

const REQUIRED_SOCIAL_RESPONSE = /^(?:(?:accept|reject)-(?:assist|companion|exchange|reproduce|collective|membership|permission|decision-rule|mandate):|respond-conversation:)/;
const FULFILLMENT_OPTION = /^(settle-exchange|fulfill-assist|meet-to-assist|join-water-assist|return-shared-living|contribute-mandate|distribute-mandate|use-permission|reproduce|withdraw-reproduce):/;

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

function isExecutingPriorityObligation(intent: Intent): boolean {
  if (intent.agreementId) return true;
  const action = intent.nextAction.kind === 'communicate'
    ? intent.nextAction
    : intent.completionAction?.kind === 'communicate'
      ? intent.completionAction
      : undefined;
  if (!action) return false;
  const content = action.content;
  return content.kind === 'accept'
    || content.kind === 'reject'
    || (content.kind === 'claim' && content.conversation?.turn === 'response');
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
  responsibilitySourceEventIds: string[];
  kinshipRiskSourceEventIds: string[];
  femaleAgeBand?: LifeReviewEvidence['femaleAgeBand'];
} {
  const targetId = option.target?.kind === 'person' ? option.target.personId : undefined;
  const partner = targetId ? context.state.people.find((candidate) => candidate.id === targetId) : undefined;
  const relation = targetId ? context.person.relations.find((candidate) => candidate.personId === targetId) : undefined;
  const relationPressure = Math.min(30, Math.max(0, relation?.trust ?? 0) * 0.9 + Math.max(0, relation?.bond ?? 0) * 1.1);
  const socialAttachment = (personalityScore(context.person, 'emotionality') + personalityScore(context.person, 'extraversion')) / 2;
  const affiliationPressure = Math.min(10, Math.max(0, socialAttachment - 45) * 0.2);
  const window = reproductiveWindow(context, option);
  const responsibility = option.id.startsWith('offer-reproduce:')
    ? reproductiveResponsibility(context.state, context.person)
    : undefined;
  const kinshipRisk = option.id.startsWith('offer-reproduce:') && partner
    ? perceivedKinshipRisk(context.state, context.person, partner)
    : undefined;
  const base = option.id.startsWith('offer-reproduce:') ? 36 : 30;
  const reasons: string[] = [];
  if (relationPressure > 0) reasons.push('已有关系证据');
  if (window.pressure > 0) reasons.push('女性生育年龄窗口正在收窄');
  if (affiliationPressure > 0) reasons.push('本人有较强归属倾向');
  if (responsibility?.pressure) reasons.push(...responsibility.reasons);
  if ((kinshipRisk?.cost ?? 0) > 0) reasons.push('本人已有近亲后代风险的有来源认识');
  return {
    pressure: Math.min(140, Math.max(0,
      base + relationPressure + affiliationPressure + window.pressure
        - (responsibility?.pressure ?? 0) * 2
        - (kinshipRisk?.cost ?? 0),
    )),
    reasons,
    relationSourceEventIds: [...new Set(option.relationshipBasis?.relationshipKeys ?? relation?.sourceEventIds ?? [])].sort(),
    responsibilitySourceEventIds: responsibility?.sourceFactIds ?? [],
    kinshipRiskSourceEventIds: kinshipRisk?.sourceFactIds ?? [],
    ...(window.band ? { femaleAgeBand: window.band } : {}),
  };
}

function rankOptions(context: DecisionContext, options: ActionOption[], moment: PlanningMoment): ActionOption[] {
  return rankCognitiveOptions(context, options, moment).map((evaluation) => evaluation.option);
}

function chooseOption(context: DecisionContext, moment: PlanningMoment): {
  option?: ActionOption;
  followUp?: ActionOption;
  appraisal?: RankedCognitiveAppraisal;
  reason: string;
} {
  const deliberation = deliberate(context, context.options, moment);
  const appraisal = deliberation.selected;
  const option = appraisal?.option;
  const followUp = option?.requiresFollowUp
    ? rankOptions(context, context.followUpOptions.filter((candidate) => followUpSemanticallyMatches(option, candidate)), moment)[0]
    : undefined;
  return { option, followUp, appraisal, reason: deliberation.reason };
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
 * Build sourced evidence for a possible life-review interruption. This helper
 * no longer chooses the option; causal BDI and intention persistence do that.
 * Population and civilization observations are deliberately absent.
 */
export function groundedLifeReviewOpportunity(context: DecisionContext): GroundedLifeReviewOpportunity | null {
  const active = context.activeIntent;
  if (!active?.projectId || urgentReplan(context)) return null;
  const reviewMonth = context.state.clock.elapsedMonths + 1;
  for (const event of planningOverlayEvents(context.state)) {
    if (event.atMonth === reviewMonth
      && event.kind === 'decision'
      && event.who === context.person.id
      && (event.decision.kind === 'start' || event.decision.kind === 'revise')
      && event.decision.lifeReview) return null;
  }
  for (let index = context.state.world.past.length - 1; index >= 0; index -= 1) {
    const event = context.state.world.past[index];
    if (event.atMonth < reviewMonth) break;
    if (event.atMonth === reviewMonth
      && event.kind === 'decision'
      && event.who === context.person.id
      && (event.decision.kind === 'start' || event.decision.kind === 'revise')
      && event.decision.lifeReview) return null;
  }
  const project = projectById(context.state, active.projectId);
  if (project?.status !== 'active') return null;
  const candidates = context.options
    .filter((option) => OPTIONAL_LIFE_REVIEW.test(option.id))
    .flatMap((option) => {
      if (option.target?.kind !== 'person' || !option.relationshipBasis) return [];
      const scored = lifeReviewPressure(context, option);
      const optionKind: LifeReviewEvidence['optionKind'] = option.id.startsWith('offer-reproduce:')
        ? 'offer-reproduce'
        : 'offer-companion';
      const basisKey = option.relationshipBasis.basisKey;
      if (intentsOwnedBy(context.state, context.person.id).some((intent) => intent.ownerId === context.person.id
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
        ...scored.responsibilitySourceEventIds,
        ...scored.kinshipRiskSourceEventIds,
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
    const observedEmergencyHibernation = context.options.find((option) => (
      isObservedEmergencyHibernationOption(context.state, context.person, option)
    ));
    if (observedEmergencyHibernation) {
      return active
        ? {
            kind: 'revise',
            intentId: active.id,
            optionId: observedEmergencyHibernation.id,
            mode: 'interrupt',
            interruptionKind: 'survival-reflex',
            reason: '本人已经感受到乱纪元的严重冷热伤害，先脱水休眠，恢复后再返回未完成的回应或项目',
          }
        : {
            kind: 'start',
            optionId: observedEmergencyHibernation.id,
            reason: observedEmergencyHibernation.reason,
          };
    }
    const required = context.options.filter(isRequiredSocialOption);
    const fulfillment = context.options.filter(isFulfillmentOption);
    const forcedOptions = required.length ? required : fulfillment;
    const forced = rankOptions(context, forcedOptions, moment)[0];
    if (active && forced) {
      if (isExecutingPriorityObligation(active)) {
        return { kind: 'idle', reason: '先完成已经开始的回应或履约；新收到的义务随后仍会保留并依次处理' };
      }
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
    const { option, followUp, appraisal, reason: deliberationReason } = chooseOption(context, moment);
    if (!active) {
      return option
        ? {
            kind: 'start',
            optionId: option.id,
            ...(followUp ? { followUpOptionId: followUp.id } : {}),
            reason: `${option.reason}；${deliberationReason}`,
          }
        : { kind: 'idle', reason: context.options.length ? deliberationReason : '当前没有可执行目标' };
    }

    if (option?.nextAction.kind === 'act' && option.nextAction.operation === 'dehydrate') {
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: option.id,
        mode: 'interrupt',
        interruptionKind: 'survival-reflex',
        reason: '乱纪元的直接生存风险要求暂时进入脱水休眠，恢复后返回原有安排',
      };
    }

    const persistence = assessIntentionPersistence(context, active, appraisal, moment);
    if (persistence.keep || !option || goalSatisfied(context.state, context.person, active.goal)) {
      return { kind: 'idle', reason: persistence.reason };
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
        reason: option.recordUseStage === 'acquire'
          ? '可见公共记录与当前项目的真实技术缺口完全匹配，先亲自取得、读懂并核验，再返回原项目'
          : option.recordUseStage === 'read' || option.recordUseStage === 'experiment' || option.recordUseStage === 'read-experiment'
            ? '本人持有的实体记录与当前项目的真实技术缺口完全匹配，先读懂并用手头材料复现，再返回原项目'
            : '这项旧版记录交付与身边项目的真实技术缺口匹配，短暂完成后继续原安排',
      };
    }

    if (lifeReview?.option.id === option.id) {
      const matchingProjectFollowUps = context.followUpOptions.filter((candidate) => candidate.projectId === active.projectId
        && followUpSemanticallyMatches(lifeReview.option, candidate));
      const lifeReviewFollowUp = lifeReview.option.requiresFollowUp
        ? rankOptions(context, matchingProjectFollowUps, moment)[0]
        : undefined;
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: lifeReview.option.id,
        ...(lifeReviewFollowUp ? { followUpOptionId: lifeReviewFollowUp.id } : {}),
        mode: 'interrupt',
        interruptionKind: 'life-review',
        reason: `${persistence.reason}；生活复核：${lifeReview.reasons.length ? lifeReview.reasons.join('、') : '眼前出现具体生活机会'}；${deliberationReason}`,
        lifeReview: lifeReview.evidence,
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

    return {
      kind: 'revise',
      intentId: active.id,
      optionId: option.id,
      ...(followUp ? { followUpOptionId: followUp.id } : {}),
      reason: `${persistence.reason}；${deliberationReason}`,
    };
  }
}

/** @deprecated Use RulePlanner. Kept for old imports and test fixtures. */
export class MockDecider extends RulePlanner {}
