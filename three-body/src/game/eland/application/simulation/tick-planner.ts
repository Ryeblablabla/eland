import { goalSatisfied } from '../../domain/action-executor';
import { openAgreementCandidatesForPerson } from '../../domain/agreement';
import { ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH } from '../../domain/decision-budget';
import { inheritPlanningEventOverlay, registerPlanningEventOverlay } from '../../domain/event-index';
import { intentReviewAtMonth, isResumableIntent } from '../../domain/intent';
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
import { livingPeople, personById, projectsOwnedBy } from '../../domain/state-index';
import {
  buildDecisionContext,
  cloneMutableProjectsForPlanning,
  projectKnowledgeTeachingOpportunity,
  visibleCellsFor,
} from '../action-options';
import { optionAllowedForLifeStage } from '../age-planning';
import { compileAgreementContinuations } from '../agreement-continuation';
import { hasGroundedConversationResponseOpportunity } from '../conversation-options';
import {
  groundedLifeReviewOpportunity,
  isFulfillmentOption,
  isRequiredSocialOption,
  RulePlanner,
} from '../rule-planner';
import { activeIntent, applyDecision, decisionPlanningChannel } from './intent-execution';
import { actionOptionSemantics } from '../../domain/action-option-semantics';

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
  return livingPeople(state).some((candidate) => person.geneticParents.includes(candidate.id)
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
    decisionMonth: atMonth,
    planningTick: 1,
    options: context.options.filter((option) => optionAllowedForLifeStage(stage, option)),
    followUpOptions: context.followUpOptions.filter((option) => optionAllowedForLifeStage(stage, option)),
  };
}

/** Compile a model/local review against facts already realized earlier this month. */
export function buildCurrentMonthDecisionContext(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  planningTick: number,
  events: WorldEvent[],
): DecisionContext {
  const planningState: SimulationState = {
    ...state,
    world: { ...state.world, past: [...state.world.past, ...events] },
  };
  registerPlanningEventOverlay(planningState, events, state.world.past);
  const planningPerson = personById(planningState, person.id) ?? person;
  const stage = lifePlanningStage(planningPerson, atMonth);
  const context = buildDecisionContext(planningState, planningPerson, atMonth);
  if (!personCanDecide(planningState, planningPerson, atMonth)) return {
    ...context,
    decisionMonth: atMonth,
    planningTick,
    currentMonthEvents: [...events],
    options: [],
    followUpOptions: [],
  };
  return {
    ...context,
    decisionMonth: atMonth,
    planningTick,
    currentMonthEvents: [...events],
    options: context.options.filter((option) => optionAllowedForLifeStage(stage, option)),
    followUpOptions: context.followUpOptions.filter((option) => optionAllowedForLifeStage(stage, option)),
  };
}

export function buildDecisionContexts(
  state: SimulationState,
  atMonth = state.clock.elapsedMonths,
): DecisionContext[] {
  return livingPeople(state).map((person) => buildDecisionContextForPerson(state, person, atMonth));
}

interface CurrentMonthPlanningIndex {
  atMonth: number;
  indexedLength: number;
  lastIndexedEvent?: WorldEvent;
  events: WorldEvent[];
  lifeReviewsByPerson: Map<PersonId, DecisionFact[]>;
  groundedOpeningsByListener: Map<PersonId, ActionFact[]>;
  socialProposalsByAudience: Map<PersonId, ActionFact[]>;
}

const currentMonthPlanningIndexes = new WeakMap<WorldEvent[], CurrentMonthPlanningIndex>();

function currentMonthPlanningIndex(events: WorldEvent[], atMonth: number): CurrentMonthPlanningIndex {
  let index = currentMonthPlanningIndexes.get(events);
  if (!index
    || index.atMonth !== atMonth
    || index.indexedLength > events.length
    || (index.indexedLength > 0 && events[index.indexedLength - 1] !== index.lastIndexedEvent)) {
    index = {
      atMonth,
      indexedLength: 0,
      events: [],
      lifeReviewsByPerson: new Map(),
      groundedOpeningsByListener: new Map(),
      socialProposalsByAudience: new Map(),
    };
    currentMonthPlanningIndexes.set(events, index);
  }
  for (let offset = index.indexedLength; offset < events.length; offset += 1) {
    const event = events[offset];
    if (event.atMonth !== atMonth) continue;
    index.events.push(event);
    if (event.kind === 'decision'
      && (event.decision.kind === 'start' || event.decision.kind === 'revise')
      && event.decision.lifeReview) {
      const reviews = index.lifeReviewsByPerson.get(event.who) ?? [];
      reviews.push(event);
      index.lifeReviewsByPerson.set(event.who, reviews);
    }
    if (event.kind !== 'action' || event.status !== 'completed' || event.action.kind !== 'talk') continue;
    const content = event.action.speakerMeaning;
    if (content.kind === 'claim' && content.conversation?.turn === 'opening') {
      const openings = index.groundedOpeningsByListener.get(content.conversation.listenerId) ?? [];
      openings.push(event);
      index.groundedOpeningsByListener.set(content.conversation.listenerId, openings);
    }
    if ((content.kind === 'request' || content.kind === 'offer') && content.proposal) {
      for (const audienceId of ((event.diff.understoodByPersonIds as string[] | undefined) ?? [])) {
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

export interface LocalDeliberationCadence {
  ordinaryDeliberationCounts: Map<PersonId, number>;
  ordinaryReplanPermits: Set<PersonId>;
}

const fallbackCadences = new WeakMap<Set<PersonId>, LocalDeliberationCadence>();

/**
 * Direct diagnostic callers historically passed only reviewedPeople. Keep a
 * process-local cadence for them; authoritative month execution always owns
 * and passes the explicit replay/hash state.
 */
function localDeliberationCadence(
  reviewedPeople: Set<PersonId>,
  provided?: LocalDeliberationCadence,
): LocalDeliberationCadence {
  if (provided) return provided;
  let cadence = fallbackCadences.get(reviewedPeople);
  if (!cadence) {
    cadence = {
      ordinaryDeliberationCounts: new Map(),
      ordinaryReplanPermits: new Set(),
    };
    fallbackCadences.set(reviewedPeople, cadence);
  }
  return cadence;
}

export function hasPendingAgreementWork(
  state: SimulationState,
  person: PersonState,
  active: Intent | undefined,
  atMonth: number,
): boolean {
  return openAgreementCandidatesForPerson(state, person.id).some((agreement) => {
    const status = agreement.status;
    const coveredByActiveIntent = active?.agreementId === agreement.id
      || Boolean(active?.sourceFactIds?.some((factId) => agreement.sourceEventIds.includes(factId)));
    if (status === 'proposed') {
      return agreement.requiredResponderIds.includes(person.id)
        && !agreement.acceptedByPersonIds.includes(person.id)
        && !agreement.rejectedByPersonIds.includes(person.id)
        && !coveredByActiveIntent;
    }
    if (status !== 'active'
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
  const reviewAtMonth = intentReviewAtMonth(active);
  if (reviewAtMonth !== undefined && atMonth > reviewAtMonth) return true;
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
  inheritPlanningEventOverlay(state, previewState);
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
  inheritPlanningEventOverlay(state, previewState);
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
  cadenceInput?: LocalDeliberationCadence,
): void {
  if (!personCanDecide(state, person, atMonth)) return;
  const cadence = localDeliberationCadence(reviewedPeople, cadenceInput);
  if (!cadenceInput
    && reviewedPeople.has(person.id)
    && !cadence.ordinaryDeliberationCounts.has(person.id)) {
    const priorDecisionFacts = events.filter((event): event is DecisionFact => event.kind === 'decision'
      && event.atMonth === atMonth
      && event.who === person.id);
    if (!priorDecisionFacts.length || priorDecisionFacts.some((event) => event.planningChannel !== 'edge')) {
      cadence.ordinaryDeliberationCounts.set(person.id, 1);
    }
  }
  const fullReview = needsFullPlanningReview(state, person, atMonth, planningTick);
  const current = activeIntent(state, person);
  const ordinaryCount = cadence.ordinaryDeliberationCounts.get(person.id) ?? 0;
  const hasOrdinaryPermit = cadence.ordinaryReplanPermits.has(person.id);
  const firstOrdinaryReviewDue = ordinaryCount === 0 && fullReview;
  const terminalOrdinaryReplanDue = !current
    && hasOrdinaryPermit
    && ordinaryCount < ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH;
  const checkLifeOpportunity = planningTick === 1 && Boolean(current?.projectId);
  const recordUsePreflight = !current?.recordUseBasis
    && projectsOwnedBy(state, person.id).some((project) => project.status === 'active')
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
  const checkProjectKnowledgeRequest = Boolean(projectKnowledgeTeachingOpportunity(state, person, atMonth));
  const currentMonthGroundedOpenings = planningIndex.groundedOpeningsByListener.get(person.id) ?? [];
  const currentMonthSocialProposals = planningIndex.socialProposalsByAudience.get(person.id) ?? [];
  const planningEvidence = planningIndex.events;
  const planningContext = planningEvidence.length
    ? buildCurrentMonthDecisionContext(state, person, atMonth, planningTick, planningEvidence)
    : undefined;
  const hasCurrentMonthOpening = currentMonthGroundedOpenings.length > 0;
  const localOwnsVoluntarySocialChoices = planner.defersVoluntarySocialChoicesToModel !== true;
  let compiledContext: DecisionContext | undefined;
  const contextForPlanning = (): DecisionContext => compiledContext ??= planningContext
    ?? buildDecisionContext(state, person, atMonth);
  const checkGroundedConversationResponse = localOwnsVoluntarySocialChoices
    && (!current || isResumableIntent(current))
    && (hasCurrentMonthOpening
      ? contextForPlanning().options.some((option) => (
          actionOptionSemantics(option).socialContext?.cooperationKind === 'conversation'
            && actionOptionSemantics(option).socialContext?.phase === 'response'
        ))
      : hasGroundedConversationResponseOpportunity(state, person, atMonth));
  const checkCurrentMonthRequiredResponse = currentMonthSocialProposals.length > 0
    && contextForPlanning().options.some(isRequiredSocialOption);
  const checkPendingAgreementWork = hasPendingAgreementWork(state, person, current, atMonth);
  const alreadyReviewed = reviewedPeople.has(person.id);
  const hasLifeOpportunity = !alreadyReviewed && checkLifeOpportunity
    && !lifeReviewEvents.length
    && Boolean(previewGroundedLifeReviewOpportunity(state, person, atMonth));
  const recordUseOpportunity = hasRecordUseOpportunity();
  const hasTechniqueDemonstration = checkTechniqueRequest
    && contextForPlanning().options
      .some((option) => actionOptionSemantics(option).edgeTrigger === 'technique-demonstration');
  const hasProjectKnowledgeResponse = checkProjectKnowledgeRequest
    && contextForPlanning().options.some((option) => (
      actionOptionSemantics(option).edgeTrigger === 'project-knowledge-response'
    ));
  const hasPendingAgreementOption = checkPendingAgreementWork
    && contextForPlanning().options.some((option) => isRequiredSocialOption(option) || isFulfillmentOption(option));
  const ordinaryReviewDue = firstOrdinaryReviewDue || terminalOrdinaryReplanDue;
  const edgeReviewDue = hasLifeOpportunity
    || recordUseOpportunity
    || hasTechniqueDemonstration
    || hasProjectKnowledgeResponse
    || checkGroundedConversationResponse
    || checkCurrentMonthRequiredResponse
    || hasPendingAgreementOption;
  if (!ordinaryReviewDue && !edgeReviewDue) return;
  // Current-month requests and social proposals mutate their authoritative
  // project/agreement immediately, while their action facts join world.past at
  // month end. The overlay makes those facts resolvable on the next tick.
  const context = contextForPlanning();
  const timedPlanner = planner as AgentDecider & { decideAt?: RulePlanner['decideAt'] };
  const decision = timedPlanner.decideAt
    ? timedPlanner.decideAt(context, { atMonth, planningTick })
    : planner.decide(context);
  const planningChannel = decisionPlanningChannel(context, decision);
  if (planningChannel === 'ordinary') {
    const latestCount = cadence.ordinaryDeliberationCounts.get(person.id) ?? 0;
    const canSpendFirst = latestCount === 0;
    const canSpendTerminalReplan = !activeIntent(state, person)
      && cadence.ordinaryReplanPermits.has(person.id)
      && latestCount < ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH;
    if (!canSpendFirst && !canSpendTerminalReplan) return;
    if (cadence.ordinaryReplanPermits.has(person.id)) cadence.ordinaryReplanPermits.delete(person.id);
    cadence.ordinaryDeliberationCounts.set(person.id, latestCount + 1);
  }
  reviewedPeople.add(person.id);
  // Stable plans and genuinely empty affordance sets do not produce repetitive
  // "continue living" facts. The active intent is simply executed below.
  if (decision.kind === 'idle' && !decision.characterAgendaUpdate) {
    person.currentActionText = decision.reason;
    return;
  }
  events.push(applyDecision(
    state,
    person,
    context,
    decision,
    false,
    atMonth,
    events.length,
    planningTick,
    planningChannel,
  ));
}
