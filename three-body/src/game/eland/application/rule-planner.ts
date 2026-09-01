import { goalSatisfied } from '../domain/action-executor';
import type { ActionOption, FactPredicate, Intent, LifeReviewEvidence } from '../domain/action';
import type { AgentDecider, Decision, DecisionContext } from '../domain/model';
import { ageMonths } from '../domain/person';
import { isResumableIntent } from '../domain/intent';
import { followUpSemanticallyMatches } from '../domain/intent-follow-up';
import { reproductiveResponsibility } from '../domain/dependent-care';
import { personalityScore } from '../domain/personality';
import { planningOverlayEvents } from '../domain/event-index';
import { intentsOwnedBy, projectById } from '../domain/state-index';
import { isObservedEmergencyHibernationOption } from './action-options';
import { perceivedKinshipRisk } from './reproductive-risk';
import { relationTo } from '../domain/relation';
import {
  assessIntentionPersistence,
  carryDecisionDeliberation,
  deliberate,
  rankCognitiveOptionsWithoutForesight,
  type BdiDeliberation,
  type RankedCognitiveAppraisal,
} from './cognition/bdi-deliberation';
import {
  actionOptionSemantics,
  isCommitmentActionOption,
  isModelOwnedVoluntarySocialOption,
  isOpenConversationOption,
  isRequiredResponseOption,
} from '../domain/action-option-semantics';

export interface PlanningMoment {
  atMonth: number;
  planningTick: number;
}

export function withoutModelOwnedVoluntarySocialOptions(context: DecisionContext): DecisionContext {
  return {
    ...context,
    options: context.options.filter((option) => !isModelOwnedVoluntarySocialOption(option)),
    followUpOptions: context.followUpOptions.filter((option) => !isModelOwnedVoluntarySocialOption(option)),
  };
}

export function withoutOpenConversationOptions(context: DecisionContext): DecisionContext {
  return {
    ...context,
    options: context.options.filter((option) => !isOpenConversationOption(option)),
    followUpOptions: context.followUpOptions.filter((option) => !isOpenConversationOption(option)),
  };
}

export interface RulePlannerPolicy {
  deferVoluntarySocialChoicesToModel?: boolean;
}

export function isRequiredSocialOption(option: ActionOption): boolean {
  return isRequiredResponseOption(option);
}

export function isFulfillmentOption(option: ActionOption): boolean {
  return isCommitmentActionOption(option);
}

export function hasRequiredSocialResponse(context: DecisionContext): boolean {
  return context.options.some(isRequiredSocialOption);
}

export function hasFulfillmentOpportunity(context: DecisionContext): boolean {
  return context.options.some(isFulfillmentOption);
}

function isExecutingPriorityObligation(intent: Intent): boolean {
  if (intent.agreementId) return true;
  const action = intent.nextAction.kind === 'talk'
    ? intent.nextAction
    : intent.completionAction?.kind === 'talk'
      ? intent.completionAction
      : undefined;
  if (!action) return false;
  const content = action.speakerMeaning;
  return content.kind === 'accept'
    || content.kind === 'reject'
    || (content.kind === 'claim' && content.conversation?.turn === 'response');
}

export function isStateAchievementGoal(goal: FactPredicate): boolean {
  return goal.kind === 'inventory-at-least'
    || goal.kind === 'container-inventory-at-least'
    || goal.kind === 'at-cell'
    || goal.kind === 'sheltered'
    || goal.kind === 'voxel-is'
    || goal.kind === 'knowledge'
    || goal.kind === 'project-completed';
}

/** @deprecated Goal shape identifies a bounded achievement, never maintenance by itself. */
export const isMaintainableStateGoal = isStateAchievementGoal;

export function isProductionOption(option: ActionOption): boolean {
  return option.domain !== 'social' && isStateAchievementGoal(option.goal);
}

function optionalLifeReviewKind(option: ActionOption): LifeReviewEvidence['optionKind'] | undefined {
  const semantics = actionOptionSemantics(option);
  if (semantics.reproduction?.phase === 'proposal'
    && semantics.reproduction.direction === 'proceed') return 'offer-reproduce';
  const action = option.completionAction ?? option.nextAction;
  if (action.kind === 'talk'
    && (action.speakerMeaning.kind === 'request' || action.speakerMeaning.kind === 'offer')
    && action.speakerMeaning.proposal?.kind === 'companion') return 'offer-companion';
  if (action.kind === 'talk'
    && action.speakerMeaning.kind === 'request'
    && action.speakerMeaning.proposal?.kind === 'assist'
    && action.speakerMeaning.proposal.need === 'company') return 'request-company';
  return undefined;
}

export interface GroundedLifeReviewOpportunity {
  option: ActionOption;
  lifePressure: number;
  projectPressure: number;
  reasons: string[];
  evidence: LifeReviewEvidence;
}

function reproductiveWindow(context: DecisionContext, option: ActionOption): { pressure: number; band?: LifeReviewEvidence['femaleAgeBand'] } {
  if (actionOptionSemantics(option).reproduction?.phase !== 'proposal'
    || option.target?.kind !== 'person') return { pressure: 0 };
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
  const relation = targetId ? relationTo(context.person, targetId) : undefined;
  const relationPressure = Math.min(30, Math.max(0, relation?.trust ?? 0) * 0.9 + Math.max(0, relation?.bond ?? 0) * 1.1);
  const socialAttachment = (personalityScore(context.person, 'emotionality') + personalityScore(context.person, 'extraversion')) / 2;
  const affiliationPressure = Math.min(10, Math.max(0, socialAttachment - 45) * 0.2);
  const window = reproductiveWindow(context, option);
  const reproductionProposal = actionOptionSemantics(option).reproduction?.phase === 'proposal';
  const responsibility = reproductionProposal
    ? reproductiveResponsibility(context.state, context.person)
    : undefined;
  const kinshipRisk = reproductionProposal && partner
    ? perceivedKinshipRisk(context.state, context.person, partner)
    : undefined;
  const base = reproductionProposal ? 36 : 30;
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

function rankOptionsWithoutForesight(context: DecisionContext, options: ActionOption[], moment: PlanningMoment): ActionOption[] {
  return rankCognitiveOptionsWithoutForesight(context, options, moment).map((evaluation) => evaluation.option);
}

function chooseOption(context: DecisionContext, moment: PlanningMoment): {
  option?: ActionOption;
  followUp?: ActionOption;
  appraisal?: RankedCognitiveAppraisal;
  deliberation: BdiDeliberation;
  reason: string;
} {
  const deliberation = deliberate(context, context.options, moment);
  const appraisal = deliberation.selected;
  const option = appraisal?.option;
  const followUp = option?.requiresFollowUp
    ? rankOptionsWithoutForesight(context, context.followUpOptions.filter((candidate) => followUpSemanticallyMatches(option, candidate)), moment)[0]
    : undefined;
  return { option, followUp, appraisal, deliberation, reason: deliberation.reason };
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
    .filter((option) => Boolean(optionalLifeReviewKind(option)))
    .flatMap((option) => {
      if (option.target?.kind !== 'person' || !option.relationshipBasis) return [];
      const scored = lifeReviewPressure(context, option);
      const optionKind = optionalLifeReviewKind(option)!;
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
  readonly defersVoluntarySocialChoicesToModel: boolean;

  constructor(policy: RulePlannerPolicy = {}) {
    this.defersVoluntarySocialChoicesToModel = policy.deferVoluntarySocialChoicesToModel === true;
  }

  decide(context: DecisionContext): Decision {
    return this.decideAt(context, {
      atMonth: context.state.clock.elapsedMonths + 1,
      planningTick: 1,
    });
  }

  decideAt(context: DecisionContext, moment: PlanningMoment): Decision {
    context = withoutOpenConversationOptions(context);
    if (this.defersVoluntarySocialChoicesToModel) {
      context = withoutModelOwnedVoluntarySocialOptions(context);
    }
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
    const forced = rankOptionsWithoutForesight(context, forcedOptions, moment)[0];
    if (forced) {
      const reason = required.length ? '先完成必须由本人作出的回应' : '先履行已经生效的承诺或职责';
      if (!active) return { kind: 'start', optionId: forced.id, reason };
      if (isExecutingPriorityObligation(active)) {
        return { kind: 'idle', reason: '先完成已经开始的回应或履约' };
      }
      return {
        kind: 'revise',
        intentId: active.id,
        optionId: forced.id,
        ...(isResumableIntent(active) ? {
          mode: 'interrupt' as const,
          interruptionKind: required.length ? 'required-response' as const : 'fulfillment' as const,
        } : {}),
        reason,
      };
    }

    const {
      option,
      followUp,
      appraisal,
      deliberation,
      reason: deliberationReason,
    } = chooseOption(context, moment);
    const withDeliberation = <T extends Decision>(decision: T): T => carryDecisionDeliberation(
      decision,
      context,
      moment,
      deliberation,
    );
    if (!active) {
      return option
        ? withDeliberation({
            kind: 'start',
            optionId: option.id,
            ...(followUp ? { followUpOptionId: followUp.id } : {}),
            reason: `${option.reason}；${deliberationReason}`,
          })
        : { kind: 'idle', reason: context.options.length ? deliberationReason : '当前没有可执行目标' };
    }

    const persistence = assessIntentionPersistence(context, active, appraisal, moment);
    if (persistence.keep || !option || goalSatisfied(context.state, context.person, active.goal)) {
      return { kind: 'idle', reason: persistence.reason };
    }
    const action = option.completionAction ?? option.nextAction;
    const interruptionKind = option.nextAction.kind === 'act' && option.nextAction.operation === 'dehydrate'
      ? 'survival-reflex' as const
      : option.recordUseBasis
        ? 'record-use' as const
        : action.kind === 'talk'
          ? 'voluntary-conversation' as const
          : undefined;
    return withDeliberation({
      kind: 'revise',
      intentId: active.id,
      optionId: option.id,
      ...(followUp ? { followUpOptionId: followUp.id } : {}),
      ...(interruptionKind && isResumableIntent(active) ? {
        mode: 'interrupt' as const,
        interruptionKind,
      } : {}),
      reason: `${persistence.reason}；${deliberationReason}`,
    });
  }
}

/** @deprecated Use RulePlanner. Kept for old imports and test fixtures. */
export class MockDecider extends RulePlanner {}
