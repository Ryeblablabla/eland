import { goalSatisfied } from '../../domain/action-executor';
import { agreementsForPerson } from '../../domain/agreement';
import { registerPlanningEventOverlay } from '../../domain/event-index';
import { lifePlanningStage } from '../../domain/life-stage';
import { Material } from '../../domain/material';
import { strongestBereavementUrgency } from '../../domain/mortuary';
import type {
  ActionFact,
  AgentDecider,
  DecisionContext,
  DecisionFact,
  Intent,
  SimulationState,
  WorldEvent,
} from '../../domain/model';
import {
  isAlive,
  isDehydratedHibernating,
  sameLocation,
  type PersonId,
  type PersonState,
} from '../../domain/person';
import { personById } from '../../domain/state-index';
import {
  buildDecisionContext,
  cloneMutableProjectsForPlanning,
  visibleCellsFor,
} from '../action-options';
import { optionAllowedForLifeStage } from '../age-planning';
import { compileAgreementContinuations } from '../agreement-continuation';
import { hasGroundedConversationResponseOpportunity } from '../conversation-options';
import {
  groundedLifeReviewOpportunity,
  isRequiredSocialOption,
  RulePlanner,
} from '../rule-planner';
import { activeIntent, applyDecision } from './intent-execution';

function personCanDecide(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths,
): boolean {
  const founderBootstrap = state.clock.elapsedMonths === 0 && atMonth === 1 && person.generation === 0;
  return (founderBootstrap || lifePlanningStage(person, atMonth) !== 'dependent-child')
    && isAlive(person)
    && !isDehydratedHibernating(person);
}

export function hasCoLocatedLivingParent(state: SimulationState, person: PersonState): boolean {
  return state.people.some((candidate) => person.geneticParents.includes(candidate.id)
    && isAlive(candidate)
    && sameLocation(candidate, person));
}

export function buildDecisionContextForPerson(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths,
): DecisionContext {
  const context = buildDecisionContext(state, person, atMonth);
  if (!personCanDecide(state, person, atMonth)) return { ...context, options: [], followUpOptions: [] };
  const stage = lifePlanningStage(person, atMonth);
  return {
    ...context,
    options: context.options.filter((option) => optionAllowedForLifeStage(stage, option)),
    followUpOptions: context.followUpOptions.filter((option) => optionAllowedForLifeStage(stage, option)),
  };
}

export function buildDecisionContexts(
  state: SimulationState,
  atMonth = state.clock.elapsedMonths,
): DecisionContext[] {
  return state.people.filter(isAlive).map((person) => buildDecisionContextForPerson(state, person, atMonth));
}

interface CurrentMonthPlanningIndex {
  indexedLength: number;
  lastIndexedEvent?: WorldEvent;
  lifeReviewsByPerson: Map<PersonId, DecisionFact[]>;
  groundedOpeningsByListener: Map<PersonId, ActionFact[]>;
  socialProposalsByAudience: Map<PersonId, ActionFact[]>;
}

const currentMonthPlanningIndexes = new WeakMap<WorldEvent[], CurrentMonthPlanningIndex>();

function currentMonthPlanningIndex(events: WorldEvent[], atMonth: number): CurrentMonthPlanningIndex {
  let index = currentMonthPlanningIndexes.get(events);
  if (!index
    || index.indexedLength > events.length
    || (index.indexedLength > 0 && events[index.indexedLength - 1] !== index.lastIndexedEvent)) {
    index = {
      indexedLength: 0,
      lifeReviewsByPerson: new Map(),
      groundedOpeningsByListener: new Map(),
      socialProposalsByAudience: new Map(),
    };
    currentMonthPlanningIndexes.set(events, index);
  }
  for (let offset = index.indexedLength; offset < events.length; offset += 1) {
    const event = events[offset];
    if (event.atMonth !== atMonth) continue;
    if (event.kind === 'decision'
      && (event.decision.kind === 'start' || event.decision.kind === 'revise')
      && event.decision.lifeReview) {
      const reviews = index.lifeReviewsByPerson.get(event.who) ?? [];
      reviews.push(event);
      index.lifeReviewsByPerson.set(event.who, reviews);
    }
    if (event.kind !== 'action' || event.status !== 'completed' || event.action.kind !== 'communicate') continue;
    const content = event.action.content;
    if (content.kind === 'claim' && content.conversation?.turn === 'opening') {
      const openings = index.groundedOpeningsByListener.get(content.conversation.listenerId) ?? [];
      openings.push(event);
      index.groundedOpeningsByListener.set(content.conversation.listenerId, openings);
    }
    if ((content.kind === 'request' || content.kind === 'offer') && content.proposal) {
      for (const audienceId of event.action.audience) {
        const proposals = index.socialProposalsByAudience.get(audienceId) ?? [];
        proposals.push(event);
        index.socialProposalsByAudience.set(audienceId, proposals);
      }
    }
  }
  index.indexedLength = events.length;
  index.lastIndexedEvent = events.at(-1);
  return index;
}

function hasPendingAgreementWork(
  state: SimulationState,
  person: PersonState,
  active: Intent | undefined,
  atMonth: number,
): boolean {
  return agreementsForPerson(state, person.id).some((agreement) => {
    const coveredByActiveIntent = active?.agreementId === agreement.id
      || Boolean(active?.sourceFactIds?.some((factId) => agreement.sourceEventIds.includes(factId)));
    if (agreement.status === 'proposed') {
      return agreement.requiredResponderIds.includes(person.id)
        && !agreement.acceptedByPersonIds.includes(person.id)
        && !agreement.rejectedByPersonIds.includes(person.id)
        && !coveredByActiveIntent;
    }
    if (agreement.status !== 'active'
      || !agreement.partyIds.includes(person.id)
      || agreement.fulfilledByPersonIds.includes(person.id)
      || coveredByActiveIntent) return false;
    return compileAgreementContinuations(state, agreement.id, atMonth)
      .some((continuation) => continuation.personId === person.id);
  });
}

function needsFullPlanningReview(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  planningTick: number,
): boolean {
  const active = activeIntent(state, person);
  if (!active) return true;
  if (hasPendingAgreementWork(state, person, active, atMonth)) return true;
  if (planningTick === 1 && (
    person.body.health < 35
    || person.body.hydration < 28
    || person.body.nutrition < 28
    || strongestBereavementUrgency(state, person, atMonth) >= 0.7
    || person.conditions.some((condition) => (
      condition.kind === 'cold'
      || condition.kind === 'heat'
      || condition.kind === 'wound'
      || condition.kind === 'illness'
    ) && condition.stage >= 2)
  )) return true;
  if (active.stateGoalUntilMonth !== undefined && atMonth > active.stateGoalUntilMonth) return true;
  return atMonth - active.lastProgressAtMonth >= 2
    && !goalSatisfied(state, person, active.goal);
}

/**
 * Option compilation for active projects may lock a logistics route. A life
 * review preview therefore owns a cloned project slice and cannot write into
 * the authoritative project state unless the opportunity is actually chosen.
 */
export function previewGroundedLifeReviewOpportunity(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths,
) {
  const previewState: SimulationState = {
    ...state,
    projects: cloneMutableProjectsForPlanning(state.projects),
  };
  const previewPerson = personById(previewState, person.id);
  if (!previewPerson) return null;
  return groundedLifeReviewOpportunity(buildDecisionContext(previewState, previewPerson, atMonth));
}

function hasPerceivedWrittenRecordCarrier(
  state: SimulationState,
  person: PersonState,
): boolean {
  const hasOwnCarrier = person.inventory.some((stack) => stack.quantity > 0
    && stack.materialId === Material.WoodTablet
    && typeof stack.recordPayloadId === 'string');
  if (hasOwnCarrier) return true;
  const visibleCells = new Set(visibleCellsFor(person));
  const visibleRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return state.world.drops.some((drop) => drop.quantity > 0
    && drop.materialId === Material.WoodTablet
    && typeof drop.recordPayloadId === 'string'
    && visibleCells.has(drop.cellId)
    && Math.abs(drop.z - person.position.z) <= visibleRadius);
}

function previewDemandBoundRecordUseOpportunity(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths,
): boolean {
  const previewState: SimulationState = {
    ...state,
    projects: cloneMutableProjectsForPlanning(state.projects),
  };
  const previewPerson = personById(previewState, person.id);
  return Boolean(previewPerson && buildDecisionContext(previewState, previewPerson, atMonth).options.some((option) => option.recordUseBasis));
}

export function planLocallyForTick(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  planningTick: number,
  events: WorldEvent[],
  planner: AgentDecider,
  reviewedPeople: Set<PersonId>,
): void {
  if (!personCanDecide(state, person, atMonth)) return;
  const fullReview = needsFullPlanningReview(state, person, atMonth, planningTick);
  const current = activeIntent(state, person);
  const checkLifeOpportunity = planningTick === 1 && Boolean(current?.projectId);
  const recordUsePreflight = Boolean(current?.projectId)
    && !current?.recordUseBasis
    && hasPerceivedWrittenRecordCarrier(state, person);
  let cachedRecordUseOpportunity: boolean | undefined;
  const hasRecordUseOpportunity = (): boolean => {
    if (!recordUsePreflight) return false;
    if (cachedRecordUseOpportunity === undefined) {
      cachedRecordUseOpportunity = previewDemandBoundRecordUseOpportunity(state, person, atMonth);
    }
    return cachedRecordUseOpportunity;
  };
  const planningIndex = currentMonthPlanningIndex(events, atMonth);
  const lifeReviewEvents = planningIndex.lifeReviewsByPerson.get(person.id) ?? [];
  const checkTechniqueRequest = state.projects.some((project) => project.status === 'active'
    && project.techniqueDemonstrationRequests?.some((request) => request.teacherIds.includes(person.id)
      && request.expiresAtMonth >= atMonth
      && !project.techniqueDemonstrations?.some((basis) => basis.requestEventId === request.requestEventId)));
  const currentMonthGroundedOpenings = planningIndex.groundedOpeningsByListener.get(person.id) ?? [];
  const currentMonthSocialProposals = planningIndex.socialProposalsByAudience.get(person.id) ?? [];
  const planningEvidence = [
    ...lifeReviewEvents,
    ...currentMonthGroundedOpenings,
    ...currentMonthSocialProposals,
  ];
  const planningState = planningEvidence.length ? { ...state } : state;
  if (planningState !== state) registerPlanningEventOverlay(planningState, planningEvidence);
  const planningPerson = personById(planningState, person.id) ?? person;
  const hasCurrentMonthOpening = currentMonthGroundedOpenings.length > 0;
  let compiledContext: DecisionContext | undefined;
  const contextForPlanning = (): DecisionContext => compiledContext ??= buildDecisionContext(planningState, planningPerson, atMonth);
  const checkGroundedConversationResponse = hasCurrentMonthOpening
    ? contextForPlanning().options.some((option) => option.id.startsWith('respond-conversation:'))
    : hasGroundedConversationResponseOpportunity(state, person, atMonth);
  const checkCurrentMonthRequiredResponse = currentMonthSocialProposals.length > 0
    && contextForPlanning().options.some(isRequiredSocialOption);
  const alreadyReviewed = reviewedPeople.has(person.id);
  if (alreadyReviewed
    && !hasRecordUseOpportunity()
    && !checkTechniqueRequest
    && !checkGroundedConversationResponse
    && !checkCurrentMonthRequiredResponse) return;
  if (!fullReview
    && !checkLifeOpportunity
    && !recordUsePreflight
    && !checkTechniqueRequest
    && !checkGroundedConversationResponse
    && !checkCurrentMonthRequiredResponse) return;
  if (!fullReview) {
    const hasLifeOpportunity = !alreadyReviewed && checkLifeOpportunity
      && !lifeReviewEvents.length
      && Boolean(previewGroundedLifeReviewOpportunity(state, person, atMonth));
    const recordUseOpportunity = hasRecordUseOpportunity();
    const hasTechniqueDemonstration = checkTechniqueRequest
      && contextForPlanning().options
        .some((option) => option.id.startsWith('demonstrate-technique:'));
    if (!hasLifeOpportunity
      && !recordUseOpportunity
      && !hasTechniqueDemonstration
      && !checkGroundedConversationResponse
      && !checkCurrentMonthRequiredResponse) return;
  }
  // Current-month requests and social proposals mutate their authoritative
  // project/agreement immediately, while their action facts join world.past at
  // month end. The overlay makes those facts resolvable on the next tick.
  const context = contextForPlanning();
  const timedPlanner = planner as AgentDecider & { decideAt?: RulePlanner['decideAt'] };
  const decision = timedPlanner.decideAt
    ? timedPlanner.decideAt(context, { atMonth, planningTick })
    : planner.decide(context);
  reviewedPeople.add(person.id);
  // Stable plans and genuinely empty affordance sets do not produce repetitive
  // "continue living" facts. The active intent is simply executed below.
  if (decision.kind === 'idle') return;
  events.push(applyDecision(state, person, context, decision, false, atMonth, events.length, planningTick));
}
