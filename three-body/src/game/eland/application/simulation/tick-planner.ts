import { goalSatisfied } from '../../domain/action-executor';
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

function hasPendingAgreementWork(
  state: SimulationState,
  person: PersonState,
  active: Intent | undefined,
  atMonth: number,
): boolean {
  return state.agreements.some((agreement) => {
    const coveredByActiveIntent = active?.agreementId === agreement.id
      || Boolean(active?.sourceFactIds?.some((factId) => agreement.sourceEventIds.includes(factId)));
    if (agreement.status === 'proposed') {
      return agreement.requiredResponderIds.includes(person.id)
        && !agreement.acceptedByPersonIds.includes(person.id)
        && !agreement.rejectedByPersonIds.includes(person.id)
        && !coveredByActiveIntent;
    }
    const hasContinuation = compileAgreementContinuations(state, agreement.id, atMonth)
      .some((continuation) => continuation.personId === person.id);
    return agreement.status === 'active'
      && agreement.partyIds.includes(person.id)
      && !agreement.fulfilledByPersonIds.includes(person.id)
      && hasContinuation
      && !coveredByActiveIntent;
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
  const previewPerson = previewState.people.find((candidate) => candidate.id === person.id);
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
  const previewPerson = previewState.people.find((candidate) => candidate.id === person.id);
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
  const lifeReviewEvents = events.filter((event): event is DecisionFact => event.kind === 'decision'
    && event.atMonth === atMonth
    && event.who === person.id
    && (event.decision.kind === 'start' || event.decision.kind === 'revise')
    && Boolean(event.decision.lifeReview));
  const checkTechniqueRequest = state.projects.some((project) => project.status === 'active'
    && project.techniqueDemonstrationRequests?.some((request) => request.teacherIds.includes(person.id)
      && request.expiresAtMonth >= atMonth
      && !project.techniqueDemonstrations?.some((basis) => basis.requestEventId === request.requestEventId)));
  const currentMonthGroundedOpenings = events.filter((event): event is ActionFact => event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'communicate'
    && event.action.content.kind === 'claim'
    && event.action.content.conversation?.turn === 'opening'
    && event.action.content.conversation.listenerId === person.id);
  const currentMonthSocialProposals = events.filter((event): event is ActionFact => event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'communicate'
    && (event.action.content.kind === 'request' || event.action.content.kind === 'offer')
    && Boolean(event.action.content.proposal)
    && event.action.audience.includes(person.id));
  const planningEvidence = [
    ...lifeReviewEvents,
    ...currentMonthGroundedOpenings,
    ...currentMonthSocialProposals,
  ];
  const planningState = planningEvidence.length ? { ...state } : state;
  if (planningState !== state) registerPlanningEventOverlay(planningState, planningEvidence);
  const planningPerson = planningState.people.find((candidate) => candidate.id === person.id) ?? person;
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
