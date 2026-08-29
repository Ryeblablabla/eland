import {
  actionSatisfiesRecordReplicationReceipt,
  executeIntentAction,
  executePrimitiveAction,
  goalSatisfied,
} from '../../domain/action-executor';
import type { ActionOption } from '../../domain/action';
import { agreementById, agreementsForPerson } from '../../domain/agreement';
import { recordIntentGoalOutcome } from '../../domain/cognition';
import {
  clearPlanningEventOverlay,
  registerPlanningEventOverlay,
  retainedColdWorldEventsForLease,
  worldEventById,
} from '../../domain/event-index';
import {
  composeIntentChoice,
  intentMaintainUntilMonth,
  intentReviewAtMonth,
  isResumableIntent,
} from '../../domain/intent';
import { lifePlanningStage } from '../../domain/life-stage';
import { remember } from '../../domain/memory';
import { materialHas } from '../../domain/material';
import type {
  ActionFact,
  Decision,
  DecisionContext,
  DecisionFact,
  Intent,
  SimulationState,
  WorldEvent,
} from '../../domain/model';
import {
  isAlive,
  isRecoveringFromDehydratedHibernation,
  type PersonId,
  type PersonState,
} from '../../domain/person';
import { intentById, intentsOwnedBy, personById, projectById } from '../../domain/state-index';
import { projectIsLedBy } from '../../domain/project-leadership';
import {
  isCurrentlyBodyBlockedPlacement,
  isObservedEmergencyHibernationOption,
  recompileNextAction,
  reproductionIntentAttemptedThisMonth,
} from '../action-options';
import { ordinaryLearningChildActionAllowed } from '../age-planning';
import { compileAgreementContinuations, type AgreementContinuation } from '../agreement-continuation';
import { evaluateCognitiveOption } from '../cognition/option-appraisal';
import { deliberate, takeDecisionDeliberation } from '../cognition/bdi-deliberation';
import {
  ensureProject,
  recordProjectAction,
  synchronizeProject,
} from '../project-options';
import { isFulfillmentOption, isRequiredSocialOption, isStateAchievementGoal } from '../rule-planner';
import { clamp } from './state-utils';
import { actionOptionSemantics, isEdgeActionOption } from '../../domain/action-option-semantics';

const MAX_REPRODUCTION_AUDIT_SOURCE_FACTS = 32;

type IntentIdentityKind = 'ordinary' | 'interrupt' | 'agreement';

/** Reserve one observer-neutral ordinal before the intent enters live state. */
function allocateIntentId(
  state: SimulationState,
  atMonth: number,
  personId: PersonId,
  kind: IntentIdentityKind,
): string {
  const persisted = state.identityCounters?.intentOrdinal;
  const ordinal = typeof persisted === 'number'
    && Number.isSafeInteger(persisted)
    && persisted >= state.intents.length
    ? persisted
    : state.intents.length;
  if (ordinal >= Number.MAX_SAFE_INTEGER) throw new Error('intent identity ordinal exhausted');
  state.identityCounters = { ...state.identityCounters, intentOrdinal: ordinal + 1 };
  const qualifier = kind === 'ordinary' ? '' : `-${kind}`;
  return `intent-${atMonth}-${personId}${qualifier}-${ordinal}`;
}

function reproductionAttemptLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:attempt`;
}

function reproductionConceptionLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:conception`;
}

function reproductionEvidenceFacts(
  state: SimulationState,
  intent: Intent,
  leaseKey: string,
  currentMonthEvents: readonly WorldEvent[],
): readonly WorldEvent[] {
  if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0
    && !worldEventById(state, intent.sourceDecisionEventId)
    && !currentMonthEvents.some((event) => event.id === intent.sourceDecisionEventId)) {
    throw new Error(`reproduction intent ${intent.id} 缺少已验证来源决定事实`);
  }
  return [
    ...retainedColdWorldEventsForLease(state, leaseKey),
    ...state.world.past,
    ...currentMonthEvents,
  ];
}

function boundedAuditSourceFacts(sourceFactIds: readonly string[]): {
  sourceFactCount: number;
  sourceFactIds: string[];
} {
  const unique = [...new Set(sourceFactIds)];
  if (unique.length <= MAX_REPRODUCTION_AUDIT_SOURCE_FACTS) {
    return { sourceFactCount: unique.length, sourceFactIds: unique };
  }
  // Preserve a deterministic sample across the complete evidence set instead
  // of keeping only one late category such as shelter construction.
  const sourceFactIdsSample = Array.from(
    { length: MAX_REPRODUCTION_AUDIT_SOURCE_FACTS },
    (_, index) => unique[Math.round(index * (unique.length - 1) / (MAX_REPRODUCTION_AUDIT_SOURCE_FACTS - 1))],
  );
  return { sourceFactCount: unique.length, sourceFactIds: sourceFactIdsSample };
}

function intentGoalSourceIds(
  state: SimulationState,
  intent: Intent,
  extra: string[] = [],
): string[] {
  const project = intent.projectId ? projectById(state, intent.projectId) : undefined;
  return [...new Set([
    ...extra,
    ...intent.actionEventIds,
    ...(project?.completionEventIds ?? []),
    ...(extra.length || intent.actionEventIds.length || project?.completionEventIds.length
      ? []
      : [intent.sourceDecisionEventId]),
  ])];
}

function reproductionAttemptFactForIntent(
  state: SimulationState,
  intent: Intent,
  atMonth: number,
  currentMonthEvents: WorldEvent[] = [],
): ActionFact | undefined {
  const agreement = intent.agreementId ? agreementById(state, intent.agreementId) : undefined;
  const attemptIds = new Set(agreement?.reproductionAttemptEventIds ?? []);
  return [...reproductionEvidenceFacts(
    state,
    intent,
    reproductionAttemptLeaseKey(intent.id),
    currentMonthEvents,
  )].reverse().find((event): event is ActionFact => (
    event.kind === 'action'
    && event.atMonth === atMonth
    && event.action.kind === 'act'
    && event.action.operation === 'reproduce'
    && (attemptIds.size === 0 || attemptIds.has(event.id))
    && (event.who === intent.ownerId
      || event.action.targets.some((target) => target.kind === 'person' && target.personId === intent.ownerId))
  ));
}

function reproductionConceptionFactForIntent(
  state: SimulationState,
  intent: Intent,
  currentMonthEvents: WorldEvent[] = [],
): ActionFact | undefined {
  const goal = intent.goal;
  if (goal.kind !== 'condition'
    || goal.condition !== 'pregnancy'
    || !goal.present) return undefined;
  const agreement = intent.agreementId ? agreementById(state, intent.agreementId) : undefined;
  const attemptIds = new Set(agreement?.reproductionAttemptEventIds ?? []);
  return [...reproductionEvidenceFacts(
    state,
    intent,
    reproductionConceptionLeaseKey(intent.id),
    currentMonthEvents,
  )].reverse().find((event): event is ActionFact => (
    event.kind === 'action'
    && event.atMonth >= intent.createdAtMonth
    && event.action.kind === 'act'
    && event.action.operation === 'reproduce'
    && event.diff.conceived === true
    && event.diff.femaleId === goal.personId
    && (attemptIds.size === 0 || attemptIds.has(event.id))
  ));
}

function failedActionGoalOutcomeKind(fact: ActionFact): 'attempted-unmet' | 'not-evaluated' {
  return fact.action.kind === 'act'
    && fact.action.operation === 'reproduce'
    && fact.diff.conceived !== false
    ? 'not-evaluated'
    : 'attempted-unmet';
}

function boundedReviewDurationMonths(duration: ActionOption['estimatedDuration'], estimatedMonths?: number): number {
  const base = duration === 'long'
    ? 12
    : estimatedMonths !== undefined && estimatedMonths <= 1
      ? 3
      : duration === 'several-months'
        ? Math.max(6, estimatedMonths ?? 0)
        : duration === 'unknown'
          ? 6
          : Math.max(3, estimatedMonths ?? 0);
  return Math.max(3, Math.min(12, Math.round(base)));
}

function reproductionAttemptBaselineFor(
  agreement: SimulationState['agreements'][number] | undefined,
): Pick<Intent, 'reproductionAttemptEventIdsAtStart'> {
  return agreement?.proposal.kind === 'reproduce'
    ? { reproductionAttemptEventIdsAtStart: [...(agreement.reproductionAttemptEventIds ?? [])] }
    : {};
}

export function bindIntentProjectTarget(
  goal: Intent['goal'],
  linkedProject: Pick<SimulationState['projects'][number], 'id'> | undefined,
): { goal: Intent['goal']; projectId?: string } {
  const reboundGoal = goal.kind === 'project-completed' && linkedProject
    ? { ...goal, projectId: linkedProject.id }
    : goal;
  return {
    goal: structuredClone(reboundGoal),
    ...(linkedProject ? { projectId: linkedProject.id } : {}),
  };
}

export function shouldWaitForSameMonthSharedProject(
  intent: Pick<Intent, 'createdAtMonth' | 'projectId'>,
  project: SimulationState['projects'][number] | undefined,
  personId: PersonId,
  atMonth: number,
): boolean {
  return Boolean(intent.projectId
    && project?.id === intent.projectId
    && project.status === 'active'
    && !projectIsLedBy(project, personId)
    && intent.createdAtMonth === atMonth);
}

export function startIntent(
  state: SimulationState,
  person: PersonState,
  context: DecisionContext,
  optionId: string,
  followUpOptionId: string | undefined,
  decisionEventId: string,
  atMonth: number,
): Intent | null {
  const selectedOption = context.options.find((option) => option.id === optionId);
  const followUpOption = followUpOptionId
    ? context.followUpOptions.find((option) => option.id === followUpOptionId)
    : undefined;
  const choice = composeIntentChoice(context.options, context.followUpOptions, optionId, followUpOptionId);
  if (!choice) return null;
  const obligationOption = [selectedOption, followUpOption].find((option) => option
    && (isFulfillmentOption(option) || isRequiredSocialOption(option)));
  const sourceAgreement = obligationOption
    ? sourceAgreementForIntent(state, person.id, obligationOption.sourceFactIds)
    : undefined;
  const linkedProject = choice.projectProposal
    ? ensureProject(state, choice.projectProposal, {
      person,
      visibleCells: context.visibleCells,
      atMonth,
    })
    : choice.projectId
      ? projectById(state, choice.projectId)
      : undefined;
  if (choice.projectId && linkedProject?.status !== 'active') return null;
  const projectTarget = bindIntentProjectTarget(choice.goal, linkedProject);
  const previous = activeIntent(state, person);
  if (previous) {
    const previousReviewAtMonth = intentReviewAtMonth(previous);
    const overdueAndUnmet = previousReviewAtMonth !== undefined
      && atMonth > previousReviewAtMonth
      && !goalSatisfied(state, person, previous.goal);
    if (overdueAndUnmet) {
      previous.status = 'blocked';
      previous.blockedReason = `第 ${previousReviewAtMonth} 月状态复核时目标仍未满足`;
      previous.replanCount += 1;
      recordIntentGoalOutcome(
        state,
        previous,
        'attempted-unmet',
        atMonth,
        intentGoalSourceIds(state, previous, [decisionEventId]),
      );
      remember(person, {
        id: `memory:intent-review-due:${previous.id}:${atMonth}`,
        kind: 'failure', summary: `${previous.summary}需要重新安排：${previous.blockedReason}`, importance: 72,
        createdAtMonth: atMonth, lastRecalledAtMonth: atMonth,
        expiresAtMonth: atMonth + 6,
        personIds: previous.target?.kind === 'person' ? [previous.target.personId] : [],
        sourceEventIds: [...previous.actionEventIds],
      });
    } else {
      previous.status = 'abandoned';
      recordIntentGoalOutcome(
        state,
        previous,
        'not-evaluated',
        atMonth,
        intentGoalSourceIds(state, previous, [decisionEventId]),
      );
    }
  }
  const boundedStateAchievement = choice.domain === 'strategic'
    && choice.goal.kind !== 'project-completed'
    && isStateAchievementGoal(choice.goal);
  const plannedDurationMonths = choice.completionPolicy
    ? Math.max(1, Math.min(120, Math.round(choice.completionPolicy.durationMonths)))
    : boundedStateAchievement
      ? boundedReviewDurationMonths(choice.estimatedDuration, choice.estimatedMonths)
      : undefined;
  const lifecycle = plannedDurationMonths !== undefined
    ? {
        version: 'intent-lifecycle-v1' as const,
        completion: choice.completionPolicy?.kind ?? 'on-achievement' as const,
        reviewAtMonth: atMonth + plannedDurationMonths - 1,
        ...(choice.completionPolicy?.kind === 'maintain-state'
          ? { maintainUntilMonth: atMonth + plannedDurationMonths - 1 }
          : {}),
      }
    : undefined;
  const intent: Intent = {
    id: allocateIntentId(state, atMonth, person.id, 'ordinary'),
    ownerId: person.id,
    summary: choice.summary,
    domain: choice.domain,
    ...projectTarget,
    ...(choice.openingAction ? { openingAction: choice.openingAction, openingActionCompleted: false } : {}),
    nextAction: choice.nextAction,
    ...(choice.completionAction ? { completionAction: choice.completionAction } : {}),
    ...(choice.target ? { target: choice.target } : {}),
    status: 'active',
    createdAtMonth: atMonth,
    lastProgressAtMonth: atMonth,
    progress: 0,
    ...(plannedDurationMonths !== undefined ? {
      plannedDurationMonths,
    } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    sourceDecisionEventId: decisionEventId,
    ...(sourceAgreement ? { agreementId: sourceAgreement.id } : {}),
    ...reproductionAttemptBaselineFor(sourceAgreement),
    ...(choice.relationshipBasis ? { relationshipBasis: structuredClone(choice.relationshipBasis) } : {}),
    ...(choice.recordUseBasis ? { recordUseBasis: structuredClone(choice.recordUseBasis) } : {}),
    ...(choice.recordUseStage ? { recordUseStage: choice.recordUseStage } : {}),
    sourceFactIds: choice.sourceFactIds,
    actionEventIds: [],
    replanCount: 0,
  };
  state.intents.push(intent);
  person.activeIntentId = intent.id;
  return intent;
}

export function activeIntent(state: SimulationState, person: PersonState): Intent | undefined {
  if (!person.activeIntentId) return undefined;
  const intent = intentById(state, person.activeIntentId);
  return intent?.status === 'active' ? intent : undefined;
}

function sourceAgreementForIntent(
  state: SimulationState,
  personId: PersonId,
  sourceFactIds: readonly string[],
) {
  return [...agreementsForPerson(state, personId)].reverse().find((agreement) => (
    agreement.partyIds.includes(personId)
    && (agreement.status === 'proposed' || agreement.status === 'active')
    && sourceFactIds.includes(agreement.proposalEventId)
  ));
}

interface CurrentEvidenceHistory {
  committedPast: WorldEvent[];
  committedEventCount: number;
  evidenceHistory: WorldEvent[];
  indexedEventCount: number;
}

const currentEvidenceHistories = new WeakMap<WorldEvent[], CurrentEvidenceHistory>();

/** Keep one full-history view per month and append only newly produced facts. */
function currentEvidenceHistory(currentMonthEvents: WorldEvent[], committedPast: WorldEvent[]): WorldEvent[] {
  let current = currentEvidenceHistories.get(currentMonthEvents);
  if (!current
    || current.committedPast !== committedPast
    || current.committedEventCount !== committedPast.length
    || current.indexedEventCount > currentMonthEvents.length) {
    current = {
      committedPast,
      committedEventCount: committedPast.length,
      evidenceHistory: [...committedPast],
      indexedEventCount: 0,
    };
    currentEvidenceHistories.set(currentMonthEvents, current);
  }
  if (current.indexedEventCount < currentMonthEvents.length) {
    current.evidenceHistory.push(...currentMonthEvents.slice(current.indexedEventCount));
    current.indexedEventCount = currentMonthEvents.length;
  }
  return current.evidenceHistory;
}

export function startInterruptIntent(
  state: SimulationState,
  person: PersonState,
  context: DecisionContext,
  optionId: string,
  decisionEventId: string,
  atMonth: number,
  interruptionKind: NonNullable<Intent['interruptionKind']>,
): Intent | null {
  const parent = activeIntent(state, person);
  const selected = context.options.find((option) => option.id === optionId);
  const ordinarySurvivalInterruption = interruptionKind === 'survival-reflex';
  if (!parent
    || (!ordinarySurvivalInterruption && !isResumableIntent(parent))
    || !selected
    || selected.projectProposal) return null;
  const project = parent.projectId
    ? projectById(state, parent.projectId)
    : undefined;
  if (parent.projectId && project?.status !== 'active') return null;
  const selectedProject = selected.projectId
    ? projectById(state, selected.projectId)
    : undefined;
  if (selected.projectId && selectedProject?.status !== 'active') return null;
  const childId = allocateIntentId(state, atMonth, person.id, 'interrupt');
  const sourceAgreement = sourceAgreementForIntent(state, person.id, selected.sourceFactIds);
  const child: Intent = {
    id: childId,
    ownerId: person.id,
    summary: selected.summary,
    domain: selected.domain ?? 'social',
    goal: structuredClone(selected.goal),
    nextAction: structuredClone(selected.nextAction),
    ...(selected.completionAction ? { completionAction: structuredClone(selected.completionAction) } : {}),
    ...(selected.target ? { target: structuredClone(selected.target) } : {}),
    status: 'active',
    createdAtMonth: atMonth,
    lastProgressAtMonth: atMonth,
    progress: 0,
    sourceDecisionEventId: decisionEventId,
    ...(selectedProject ? { projectId: selectedProject.id } : {}),
    ...(sourceAgreement ? { agreementId: sourceAgreement.id } : {}),
    ...reproductionAttemptBaselineFor(sourceAgreement),
    ...(selected.relationshipBasis ? { relationshipBasis: structuredClone(selected.relationshipBasis) } : {}),
    ...(selected.recordUseBasis ? { recordUseBasis: structuredClone(selected.recordUseBasis) } : {}),
    ...(selected.recordUseStage ? { recordUseStage: selected.recordUseStage } : {}),
    returnToIntentId: parent.id,
    interruptionKind,
    sourceFactIds: [...selected.sourceFactIds],
    actionEventIds: [],
    replanCount: 0,
  };
  parent.status = 'suspended';
  parent.suspendedByIntentId = child.id;
  parent.suspendedAtMonth = atMonth;
  state.intents.push(child);
  person.activeIntentId = child.id;
  return child;
}

export function resolveInterruptedIntentReturn(state: SimulationState, person: PersonState, atMonth: number): void {
  if (person.activeIntentId) return;
  const child = [...intentsOwnedBy(state, person.id)].reverse().find((intent) => intent.returnToIntentId
    && intent.returnOutcome === undefined
    && (intent.status === 'completed' || intent.status === 'blocked' || intent.status === 'failed' || intent.status === 'abandoned'));
  if (!child?.returnToIntentId) return;
  const parent = intentById(state, child.returnToIntentId);
  const project = parent?.projectId ? projectById(state, parent.projectId) : undefined;
  if (parent?.ownerId !== person.id) {
    child.returnResolvedAtMonth = atMonth;
    child.returnOutcome = 'parent-unavailable';
    return;
  }
  child.returnResolvedAtMonth = atMonth;
  if (!parent || parent.status !== 'suspended' || (parent.projectId && !project)) {
    child.returnOutcome = 'parent-unavailable';
    return;
  }
  if (project?.status === 'completed') {
    parent.status = 'completed';
    parent.progress = 1;
    recordIntentGoalOutcome(
      state,
      parent,
      'achieved',
      atMonth,
      intentGoalSourceIds(state, parent, project.completionEventIds),
    );
    delete parent.suspendedByIntentId;
    delete parent.suspendedAtMonth;
    child.returnOutcome = 'parent-completed';
    return;
  }
  if (project?.status === 'blocked') {
    parent.status = 'blocked';
    parent.blockedReason = project.blockedReason ?? '中断期间项目已无法继续';
    recordIntentGoalOutcome(
      state,
      parent,
      'attempted-unmet',
      atMonth,
      intentGoalSourceIds(state, parent, project.failureEventIds),
    );
    delete parent.suspendedByIntentId;
    delete parent.suspendedAtMonth;
    child.returnOutcome = 'parent-blocked';
    return;
  }
  if (project && project.status !== 'active') {
    parent.status = 'abandoned';
    recordIntentGoalOutcome(
      state,
      parent,
      'not-evaluated',
      atMonth,
      intentGoalSourceIds(state, parent),
    );
    delete parent.suspendedByIntentId;
    delete parent.suspendedAtMonth;
    child.returnOutcome = 'parent-unavailable';
    return;
  }
  parent.status = 'active';
  parent.lastResumedAtMonth = atMonth;
  delete parent.suspendedByIntentId;
  delete parent.suspendedAtMonth;
  person.activeIntentId = parent.id;
  person.currentActionText = `中断事项结束，恢复：${parent.summary}`;
  child.returnOutcome = 'resumed';
}

export function drainInterruptedIntentReturns(state: SimulationState, person: PersonState, atMonth: number): void {
  for (let index = 0; index < state.intents.length && !person.activeIntentId; index += 1) {
    const child = [...intentsOwnedBy(state, person.id)].reverse().find((intent) => intent.returnToIntentId
      && intent.returnOutcome === undefined
      && (intent.status === 'completed' || intent.status === 'blocked' || intent.status === 'failed' || intent.status === 'abandoned'));
    if (!child) return;
    resolveInterruptedIntentReturn(state, person, atMonth);
    if (child.returnOutcome === undefined) return;
  }
}

export function installAgreementContinuation(state: SimulationState, currentIntent: Intent, continuation: AgreementContinuation, atMonth: number): Intent | null {
  const owner = personById(state, continuation.personId);
  if (!owner || !isAlive(owner)) return null;
  const continuationAgreement = agreementById(state, continuation.agreementId);
  const existing = activeIntent(state, owner);
  const continuingCurrentIntent = existing?.id === currentIntent.id;
  const interrupted = continuingCurrentIntent ? undefined : existing;
  const intent = continuingCurrentIntent ? currentIntent : {
    id: allocateIntentId(state, atMonth, owner.id, 'agreement'),
    ownerId: owner.id,
    summary: continuation.summary,
    domain: 'social' as const,
    goal: structuredClone(continuation.goal),
    nextAction: structuredClone(continuation.nextAction),
    ...(continuation.target ? { target: structuredClone(continuation.target) } : {}),
    status: 'active' as const,
    createdAtMonth: atMonth,
    lastProgressAtMonth: atMonth,
    progress: 0.2,
    sourceDecisionEventId: currentIntent.sourceDecisionEventId,
    agreementId: continuation.agreementId,
    ...reproductionAttemptBaselineFor(continuationAgreement),
    ...(interrupted ? {
      returnToIntentId: interrupted.id,
      interruptionKind: 'fulfillment' as const,
    } : {}),
    sourceFactIds: [...continuation.sourceFactIds],
    actionEventIds: [],
    replanCount: 0,
  };
  if (interrupted) {
    interrupted.status = 'suspended';
    interrupted.suspendedByIntentId = intent.id;
    interrupted.suspendedAtMonth = atMonth;
  }
  if (intent === currentIntent) {
    intent.summary = continuation.summary;
    intent.goal = structuredClone(continuation.goal);
    intent.nextAction = structuredClone(continuation.nextAction);
    if (continuation.target) intent.target = structuredClone(continuation.target);
    else delete intent.target;
    delete intent.openingAction;
    delete intent.openingActionCompleted;
    delete intent.completionAction;
    delete intent.plannedDurationMonths;
    delete intent.stateGoalUntilMonth;
    delete intent.lifecycle;
    delete intent.lastProcessAttemptAtMonth;
    intent.sourceFactIds = [...new Set([...(intent.sourceFactIds ?? []), ...continuation.sourceFactIds])];
    if (intent.agreementId !== continuation.agreementId
      || intent.reproductionAttemptEventIdsAtStart === undefined) {
      const baseline = reproductionAttemptBaselineFor(continuationAgreement)
        .reproductionAttemptEventIdsAtStart;
      if (baseline) intent.reproductionAttemptEventIdsAtStart = baseline;
      else delete intent.reproductionAttemptEventIdsAtStart;
    }
    intent.agreementId = continuation.agreementId;
    intent.progress = 0.2;
  } else state.intents.push(intent);
  owner.activeIntentId = intent.id;
  return intent;
}

export function applyDecision(
  state: SimulationState,
  person: PersonState,
  context: DecisionContext,
  decision: Decision,
  usedModel: boolean,
  atMonth: number,
  orderInMonth: number,
  planningTick: number,
  planningChannel: NonNullable<DecisionFact['planningChannel']> = 'ordinary',
): DecisionFact {
  const id = `e-${atMonth}-decision-${person.id}-${planningTick}-${orderInMonth}`;
  let intentId: string | undefined;
  let result = decision.reason;
  let domain: Intent['domain'] | undefined;
  const current = activeIntent(state, person);
  const selectedOption = decision.kind === 'start' || decision.kind === 'revise'
    ? context.options.find((option) => option.id === decision.optionId)
    : undefined;
  const selectedReproductionOption = selectedOption
    && actionOptionSemantics(selectedOption).reproduction
    ? selectedOption
    : undefined;
  const selectionTimeDeliberation = selectedOption
    ? takeDecisionDeliberation(decision, person.id, { atMonth, planningTick })
    : undefined;
  const selectedForesightDeliberation = selectedOption
    && actionOptionSemantics(selectedOption).obligation === 'optional'
    ? selectionTimeDeliberation ?? deliberate(context, context.options, { atMonth, planningTick })
    : undefined;
  const selectedForesight = selectedForesightDeliberation?.foresight.options
    .find((item) => item.optionId === selectedOption?.id);
  const selectedCognitiveAppraisal = selectedReproductionOption
    ? evaluateCognitiveOption(context, selectedReproductionOption, { atMonth, planningTick })
    : undefined;
  const selectedCognitiveSources = selectedCognitiveAppraisal?.sourceFactIds ?? [];
  const attachLifeReview = (intent: Intent | null): void => {
    if (!intent || (decision.kind !== 'start' && decision.kind !== 'revise')) return;
    intent.sourceFactIds = [...new Set([...(intent.sourceFactIds ?? []), ...selectedCognitiveSources])];
    if (!decision.lifeReview) return;
    intent.lifeReview = structuredClone(decision.lifeReview);
    intent.sourceFactIds = [...new Set([...(intent.sourceFactIds ?? []), ...decision.lifeReview.sourceFactIds])];
  };
  if (decision.kind === 'start') {
    const started = startIntent(state, person, context, decision.optionId, decision.followUpOptionId, id, atMonth);
    attachLifeReview(started);
    intentId = started?.id;
    domain = started?.domain;
    result = started ? `${person.name}决定：${started.summary}` : `${person.name}没有找到该行动机会`;
  } else if (decision.kind === 'revise') {
    const started = decision.mode === 'interrupt' && decision.interruptionKind
      ? startInterruptIntent(state, person, context, decision.optionId, id, atMonth, decision.interruptionKind)
      : startIntent(state, person, context, decision.optionId, decision.followUpOptionId, id, atMonth);
    attachLifeReview(started);
    intentId = started?.id;
    domain = started?.domain;
    result = started
      ? decision.mode === 'interrupt'
        ? `${person.name}暂时处理：${started.summary}`
        : `${person.name}改为：${started.summary}`
      : `${person.name}未能改换目标`;
  } else if (decision.kind === 'suspend' && current?.id === decision.intentId) {
    current.status = 'suspended';
    delete person.activeIntentId;
    intentId = current.id;
    result = `${person.name}暂停：${current.summary}`;
  } else if (decision.kind === 'resume') {
    const candidate = intentById(state, decision.intentId);
    const resumed = candidate?.ownerId === person.id
      && candidate.status === 'suspended'
      && !candidate.suspendedByIntentId
      ? candidate
      : undefined;
    if (resumed) {
      if (current) current.status = 'suspended';
      resumed.status = 'active';
      person.activeIntentId = resumed.id;
      intentId = resumed.id;
      result = `${person.name}恢复：${resumed.summary}`;
    }
  } else if (decision.kind === 'abandon' && current?.id === decision.intentId) {
    current.status = 'abandoned';
    recordIntentGoalOutcome(
      state,
      current,
      'not-evaluated',
      atMonth,
      intentGoalSourceIds(state, current, [id]),
    );
    delete person.activeIntentId;
    intentId = current.id;
    result = `${person.name}放弃：${current.summary}`;
  } else if (decision.kind === 'idle') {
    result = `${person.name}在规划刻度 ${planningTick} 不改变当前安排：${decision.reason}`;
  }
  person.lastDecisionText = result;
  return {
    id,
    kind: 'decision',
    atMonth,
    orderInMonth,
    planningTick,
    orderInTick: 0,
    cellId: person.position.cellId,
    who: person.id,
    decision,
    ...(intentId ? { intentId } : {}),
    ...(domain ? { domain } : {}),
    planningChannel,
    ...(selectedCognitiveAppraisal ? {
      reproductionEvidence: {
        version: 'family-readiness-v2' as const,
        optionId: selectedCognitiveAppraisal.option.id,
        direction: actionOptionSemantics(selectedCognitiveAppraisal.option).reproduction?.direction === 'refuse'
          ? 'withdraw' as const
          : 'proceed' as const,
        generativityUrgency: selectedCognitiveAppraisal.generativityUrgency,
        needActivation: selectedCognitiveAppraisal.needActivation,
        motivation: selectedCognitiveAppraisal.motivation,
        aspiration: selectedCognitiveAppraisal.aspiration,
        relationshipGate: selectedCognitiveAppraisal.relationshipGate,
        readinessGate: selectedCognitiveAppraisal.readinessGate,
        ...(selectedCognitiveAppraisal.familyReadiness ? {
          familyReadiness: {
            readiness: selectedCognitiveAppraisal.familyReadiness.readiness,
            food: selectedCognitiveAppraisal.familyReadiness.food,
            water: selectedCognitiveAppraisal.familyReadiness.water,
            shelter: selectedCognitiveAppraisal.familyReadiness.shelter,
            careCapacity: selectedCognitiveAppraisal.familyReadiness.careCapacity,
            climateSafety: selectedCognitiveAppraisal.familyReadiness.climateSafety,
            basisKeys: [...selectedCognitiveAppraisal.familyReadiness.basisKeys],
            ...boundedAuditSourceFacts(selectedCognitiveAppraisal.familyReadiness.sourceFactIds),
          },
        } : {}),
        sourceFactIds: [...selectedCognitiveAppraisal.sourceFactIds],
      },
    } : {}),
    ...(selectedOption && selectedForesightDeliberation ? {
      foresightEvidence: {
        version: 'bounded-foresight-decision-v1' as const,
        selectedOptionId: selectedOption.id,
        selectedWasExpanded: Boolean(selectedForesight),
        changedLocalSelection: selectedForesightDeliberation.foresight.changedSelection,
        selectedMatchesAdjustedChoice: selectedForesightDeliberation.foresight.adjustedSelectedOptionId
          === selectedOption.id,
        rootCount: selectedForesightDeliberation.foresight.audit.rootCount,
        expandedNodes: selectedForesightDeliberation.foresight.audit.expandedNodes,
        maxDepth: selectedForesightDeliberation.foresight.audit.maxDepth,
        budgetCutoff: selectedForesightDeliberation.foresight.audit.budgetCutoff,
        expectedValue: selectedForesight?.expectedValue ?? 0,
        valueOfInformation: selectedForesight?.valueOfInformation ?? 0,
        adjustment: selectedForesight?.adjustment ?? 0,
        ...boundedAuditSourceFacts(selectedForesight?.sourceFactIds ?? []),
      },
    } : {}),
    usedModel,
    result,
  };
}

/** Classify the chosen decision, not the observer metric that happened to wake the planner. */
export function decisionPlanningChannel(
  context: DecisionContext,
  decision: Decision,
): NonNullable<DecisionFact['planningChannel']> {
  const isEdgeOption = (option: ActionOption): boolean => Boolean(
    isEdgeActionOption(option)
    || isObservedEmergencyHibernationOption(context.state, context.person, option)
  );
  if (decision.kind === 'idle') return context.options.some(isEdgeOption) ? 'edge' : 'ordinary';
  if (decision.kind !== 'start' && decision.kind !== 'revise') return 'ordinary';
  if (decision.kind === 'revise' && decision.mode === 'interrupt') return 'edge';
  const selected = context.options.find((option) => option.id === decision.optionId);
  if (!selected) return 'ordinary';
  if (decision.lifeReview
    || isEdgeOption(selected)) return 'edge';
  return 'ordinary';
}

export function executeActiveIntent(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  orderInMonth: number,
  actionTick: number,
  currentMonthEvents: WorldEvent[] = [],
): WorldEvent | null {
  const intent = activeIntent(state, person);
  if (!intent) return null;
  const executeWithEvidence = <T>(events: WorldEvent[], operation: () => T): T => {
    if (!events.length) return operation();
    const committedPast = state.world.past;
    state.world.past = currentEvidenceHistory(events, committedPast);
    registerPlanningEventOverlay(state, events, committedPast);
    try {
      return operation();
    } finally {
      clearPlanningEventOverlay(state);
      state.world.past = committedPast;
    }
  };
  const executeWithCurrentEvidence = <T>(operation: () => T): T => (
    executeWithEvidence(currentMonthEvents, operation)
  );
  const project = intent.projectId ? projectById(state, intent.projectId) : undefined;
  if (project) executeWithCurrentEvidence(() => synchronizeProject(state, project, atMonth));
  if (project && project.status === 'blocked') {
    intent.status = 'blocked';
    intent.blockedReason = project.blockedReason ?? '持续项目已经无法推进';
    recordIntentGoalOutcome(
      state,
      intent,
      'attempted-unmet',
      atMonth,
      intentGoalSourceIds(state, intent, project.failureEventIds),
    );
    delete person.activeIntentId;
    person.currentActionText = `项目需要重评：${intent.summary}`;
    return null;
  }
  const sourceAgreement = intent.agreementId ? agreementById(state, intent.agreementId) : undefined;
  if (sourceAgreement && sourceAgreement.status !== 'proposed' && sourceAgreement.status !== 'active') {
    intent.status = sourceAgreement.status === 'fulfilled' || sourceAgreement.status === 'rejected' ? 'completed' : 'failed';
    intent.progress = sourceAgreement.status === 'fulfilled' || sourceAgreement.status === 'rejected' ? 1 : intent.progress;
    const terminalGoalAchieved = goalSatisfied(state, person, intent.goal);
    const terminalConceptionFact = terminalGoalAchieved
      ? reproductionConceptionFactForIntent(state, intent, currentMonthEvents)
      : undefined;
    const reproductionGoal = intent.goal.kind === 'condition'
      && intent.goal.condition === 'pregnancy'
      && intent.goal.present;
    const terminalAttemptSources = [
      ...sourceAgreement.fulfillmentEventIds,
      ...(sourceAgreement.reproductionAttemptEventIds ?? []),
      ...(sourceAgreement.responseEventId ? [sourceAgreement.responseEventId] : []),
      ...(terminalConceptionFact ? [terminalConceptionFact.id] : []),
    ];
    recordIntentGoalOutcome(
      state,
      intent,
      terminalGoalAchieved && (!reproductionGoal || terminalConceptionFact)
        ? 'achieved'
        : sourceAgreement.reproductionAttemptEventIds?.length
          ? 'attempted-unmet'
          : 'not-evaluated',
      atMonth,
      intentGoalSourceIds(state, intent, terminalAttemptSources),
      terminalConceptionFact?.action ?? intent.completionAction ?? intent.nextAction,
    );
    delete person.activeIntentId;
    person.currentActionText = sourceAgreement.status === 'fulfilled' ? `约定已经履行：${intent.summary}` : `约定已经结束：${intent.summary}`;
    return null;
  }
  if (lifePlanningStage(person, atMonth) === 'learning-child'
    && !ordinaryLearningChildActionAllowed(state, person, intent.nextAction)) {
    intent.status = 'abandoned';
    intent.blockedReason = '普通任务的下一步已经越出当前可见亲代的本地照护半径';
    recordIntentGoalOutcome(
      state,
      intent,
      'not-evaluated',
      atMonth,
      intentGoalSourceIds(state, intent),
    );
    delete person.activeIntentId;
    person.currentActionText = '停止继续远离当前可见的亲代照护范围';
    return null;
  }
  const alreadyAttemptedReproductionThisMonth = intent.lastReproductionAttemptAtMonth === atMonth;
  if (alreadyAttemptedReproductionThisMonth || (!intent.projectId && intent.lastProcessAttemptAtMonth === atMonth)) return null;
  if (intent.openingAction && !intent.openingActionCompleted) {
    const fact = executeWithCurrentEvidence(() => executePrimitiveAction(
      state,
      person,
      intent.openingAction!,
      atMonth,
      orderInMonth,
      { intentId: intent.id, cause: 'intent', actionTick },
    ));
    intent.actionEventIds.push(fact.id);
    person.currentActionText = fact.result;
    if (fact.status === 'blocked' || fact.status === 'failed') {
      intent.status = fact.status === 'failed' ? 'failed' : 'blocked';
      intent.blockedReason = fact.result;
      recordIntentGoalOutcome(state, intent, failedActionGoalOutcomeKind(fact), atMonth, [fact.id], fact.action);
      intent.replanCount += 1;
      remember(person, {
        id: `memory:intent-opening-failed:${intent.id}:${atMonth}`,
        kind: 'failure', summary: `${intent.summary}失败：${fact.result}`, importance: 78,
        createdAtMonth: atMonth, lastRecalledAtMonth: atMonth,
        expiresAtMonth: atMonth + 6,
        personIds: intent.openingAction.kind === 'communicate' ? intent.openingAction.audience : [],
        sourceEventIds: [fact.id],
      });
      delete person.activeIntentId;
    } else {
      intent.openingActionCompleted = true;
      intent.lastProgressAtMonth = atMonth;
      intent.progress = 0.16;
    }
    return fact;
  }
  if (goalSatisfied(state, person, intent.goal)) {
    const maintainUntilMonth = intentMaintainUntilMonth(intent);
    if (maintainUntilMonth !== undefined && atMonth < maintainUntilMonth) {
      const duration = Math.max(1, intent.plannedDurationMonths ?? maintainUntilMonth - intent.createdAtMonth + 1);
      intent.progress = Math.max(intent.progress, clamp((atMonth - intent.createdAtMonth + 1) / duration, 0, 0.95));
      intent.lastProgressAtMonth = atMonth;
      person.currentActionText = `维持状态目标至第 ${maintainUntilMonth} 月：${intent.summary}`;
      return null;
    }
    intent.status = 'completed';
    intent.progress = 1;
    const conceptionFact = reproductionConceptionFactForIntent(state, intent, currentMonthEvents);
    const reproductionGoal = intent.goal.kind === 'condition'
      && intent.goal.condition === 'pregnancy'
      && intent.goal.present;
    recordIntentGoalOutcome(
      state,
      intent,
      !reproductionGoal || conceptionFact ? 'achieved' : 'not-evaluated',
      atMonth,
      intentGoalSourceIds(state, intent, conceptionFact ? [conceptionFact.id] : []),
      conceptionFact?.action ?? intent.completionAction ?? intent.nextAction,
    );
    delete person.activeIntentId;
    person.currentActionText = `已经完成：${intent.summary}`;
    return null;
  }
  const reviewAtMonth = intentReviewAtMonth(intent);
  if (reviewAtMonth !== undefined && atMonth > reviewAtMonth) {
    intent.status = 'blocked';
    intent.blockedReason = `第 ${reviewAtMonth} 月状态复核时目标仍未满足`;
    recordIntentGoalOutcome(
      state,
      intent,
      'attempted-unmet',
      atMonth,
      intentGoalSourceIds(state, intent),
    );
    intent.replanCount += 1;
    remember(person, {
      id: `memory:intent-review-due:${intent.id}:${atMonth}`,
      kind: 'failure', summary: `${intent.summary}需要重新安排：${intent.blockedReason}`, importance: 72,
      createdAtMonth: atMonth, lastRecalledAtMonth: atMonth,
      expiresAtMonth: atMonth + 6,
      personIds: intent.target?.kind === 'person' ? [intent.target.personId] : [],
      sourceEventIds: [...intent.actionEventIds],
    });
    delete person.activeIntentId;
    person.currentActionText = `状态目标到期，需要重评：${intent.summary}`;
    return null;
  }
  const next = executeWithCurrentEvidence(() => recompileNextAction(state, person, intent, atMonth));
  if (next && isCurrentlyBodyBlockedPlacement(state, person, next)) {
    // Project options expose one current atom at a time. A distant construction
    // combine or mechanical/electrical installation can therefore become
    // visible only after its movement/logistics prefix finishes. Treat a body
    // occupying that exact otherwise-air destination as a temporary
    // present-tense wait, not as an ActionFact failure or a reason to abandon
    // the whole project. The same action is recompiled next tick and becomes
    // eligible as soon as the body leaves.
    intent.nextAction = next;
    person.currentActionText = `等待目标体素空出：${intent.summary}`;
    return null;
  }
  if (!next) {
    const sharedFacilityProducedThisMonth = Boolean(project && currentMonthEvents.some((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.atMonth === atMonth
      && project.actionEventIds.includes(event.id)
      && materialHas(Number(event.diff.outputMaterialId), 'facility')
      && !event.diff.position));
    if (shouldWaitForSameMonthSharedProject(intent, project, person.id, atMonth)
      || sharedFacilityProducedThisMonth) {
      person.currentActionText = `等待项目本月已有步骤先完成：${intent.summary}`;
      return null;
    }
    if (reproductionIntentAttemptedThisMonth(state, person, intent, atMonth)) {
      // A reproduction window can give both parties a grounded option before
      // either one acts. Once the first party commits the joint process, the
      // mirror intent is satisfied for this month without fabricating a second
      // (blocked) ActionFact. The still-active agreement can expose a fresh
      // choice next month if conception did not occur.
      intent.status = 'completed';
      intent.progress = 1;
      intent.lastReproductionAttemptAtMonth = atMonth;
      const attemptFact = reproductionAttemptFactForIntent(state, intent, atMonth, currentMonthEvents);
      recordIntentGoalOutcome(
        state,
        intent,
        attemptFact?.diff.conceived === true ? 'achieved' : 'attempted-unmet',
        atMonth,
        intentGoalSourceIds(state, intent, attemptFact ? [attemptFact.id] : []),
        attemptFact?.action ?? intent.completionAction ?? intent.nextAction,
      );
      delete person.activeIntentId;
      person.currentActionText = `双方本月已经完成一次生殖尝试，等待下月重新评估：${intent.summary}`;
      return null;
    }
    intent.status = 'blocked';
    intent.blockedReason = '目标未满足，但无法编译出下一原子动作';
    recordIntentGoalOutcome(
      state,
      intent,
      'attempted-unmet',
      atMonth,
      intentGoalSourceIds(state, intent),
    );
    intent.replanCount += 1;
    remember(person, {
      id: `memory:intent-blocked:${intent.id}:${atMonth}`,
      kind: 'failure', summary: `${intent.summary}失败：${intent.blockedReason}`, importance: 76,
      createdAtMonth: atMonth, lastRecalledAtMonth: atMonth,
      expiresAtMonth: atMonth + 6,
      personIds: intent.target?.kind === 'person' ? [intent.target.personId] : [],
      sourceEventIds: [...intent.actionEventIds],
    });
    delete person.activeIntentId;
    return null;
  }
  intent.nextAction = next;
  const recordUseConfidenceBefore = intent.recordUseBasis
    ? person.knowledge.find((knowledge) => knowledge.id === intent.recordUseBasis?.knowledgeId)?.confidence
    : undefined;
  const fact = executeWithCurrentEvidence(() => executeIntentAction(state, person, intent, atMonth, orderInMonth, actionTick));
  let recordReplicationReceiptCompleted = false;
  let recordReplicationReceiptCandidate = false;
  if (intent.recordUseBasis && intent.recordUseStage) {
    const basis = intent.recordUseBasis;
    const physicalGroundSource = basis.version !== 'record-use-basis-v1'
      && basis.carrierSource.kind === 'ground'
      ? basis.carrierSource
      : undefined;
    const completedFrozenAcquisition = Boolean(physicalGroundSource
      && fact.status === 'completed'
      && fact.action.kind === 'transfer'
      && fact.action.from.kind === 'ground'
      && fact.action.from.cellId === physicalGroundSource.cellId
      && fact.action.from.z === physicalGroundSource.z
      && fact.action.dropId === physicalGroundSource.dropId
      && fact.action.to.kind === 'person'
      && fact.action.to.personId === basis.readerId
      && fact.diff.recordPayloadId === basis.recordId);
    const stage = basis.version === 'record-use-basis-v1' && intent.recordUseStage === 'share'
      ? 'share'
      : basis.version === 'record-use-basis-v1' && intent.recordUseStage === 'read-experiment'
        ? fact.action.kind === 'attend'
          ? 'read'
          : fact.action.kind === 'act'
            ? 'experiment'
            : undefined
      : completedFrozenAcquisition
        ? 'acquire'
        : intent.recordUseStage === 'read' && fact.action.kind === 'attend'
          ? 'read'
          : intent.recordUseStage === 'replicate' && fact.action.kind === 'act'
            ? 'replicate'
          : intent.recordUseStage === 'experiment' && fact.action.kind === 'act'
            ? 'experiment'
            : undefined;
    if (stage) {
      const confidenceAfter = person.knowledge.find((knowledge) => knowledge.id === basis.knowledgeId)?.confidence;
      const recordUseDiff = {
        ...fact.diff,
        recordUseBasisKey: basis.basisKey,
        recordUseStage: stage,
        recordUseProjectId: basis.projectId,
        recordUseRecordId: basis.recordId,
        recordUseKnowledgeId: basis.knowledgeId,
        recordUseTechniqueId: basis.techniqueId,
        recordUseRuleSignature: basis.ruleSignature,
        recordUseReaderId: basis.readerId,
        recordUseRecordAuthorId: basis.recordAuthorId,
        recordUseBasisCreatedAtMonth: basis.createdAtMonth,
        recordUseSourceFactIds: [...basis.sourceFactIds],
        ...(basis.version !== 'record-use-basis-v1' ? {
          recordUseAcquisitionRequired: basis.acquisitionRequired,
          recordUseCarrierSourceKind: basis.carrierSource.kind,
          recordUseCarrierSourceId: basis.carrierSource.kind === 'ground'
            ? basis.carrierSource.dropId
            : basis.carrierSource.stackId,
          ...(basis.carrierSource.kind === 'ground' ? {
            recordUseCarrierSourceCellId: basis.carrierSource.cellId,
            recordUseCarrierSourceZ: basis.carrierSource.z,
          } : {
            recordUseCarrierSourcePersonId: basis.carrierSource.personId,
          }),
        } : {}),
        ...(basis.expectedOutputMaterialId !== undefined
          ? { recordUseExpectedOutputMaterialId: basis.expectedOutputMaterialId }
          : {}),
        ...(basis.version === 'record-use-basis-v3' ? {
          recordUsePurpose: basis.purpose ?? 'learn',
          ...(basis.recordVersion !== undefined ? { recordUseRecordVersion: basis.recordVersion } : {}),
          ...(basis.projectRenewalBasisKey
            ? { recordUseProjectRenewalBasisKey: basis.projectRenewalBasisKey }
            : {}),
          recordUseInputSourceEventIds: [...basis.inputSourceEventIds],
          recordUseInputWitnesses: structuredClone(basis.inputWitnesses ?? []),
        } : {}),
        ...(recordUseConfidenceBefore !== undefined
          ? { recordUseKnowledgeConfidenceBefore: recordUseConfidenceBefore }
          : {}),
        ...(confidenceAfter !== undefined
          ? { recordUseKnowledgeConfidenceAfter: confidenceAfter }
          : {}),
      };
      if (basis.version === 'record-use-basis-v3'
        && basis.purpose === 'replicate'
        && stage === 'replicate'
        && intent.goal.kind === 'record-replication-receipt') {
        const candidateFact: ActionFact = {
          ...fact,
          diff: { ...recordUseDiff, recordUseReplicationReceipt: true },
        };
        fact.diff = candidateFact.diff;
        recordReplicationReceiptCandidate = true;
      } else fact.diff = recordUseDiff;
      if (basis.version !== 'record-use-basis-v1' && fact.status === 'completed') {
        if (stage === 'acquire') intent.recordUseStage = 'read';
        else if (stage === 'read' && fact.diff.understood === true) {
          intent.recordUseStage = basis.version === 'record-use-basis-v3'
            ? 'prepare-experiment'
            : 'experiment';
        }
      }
    } else if (basis.version === 'record-use-basis-v3'
      && intent.recordUseStage === 'prepare-experiment') {
      fact.diff = {
        ...fact.diff,
        recordUsePreparation: true,
        recordUsePreparationProjectId: basis.projectId,
        recordUsePreparationKnowledgeId: basis.knowledgeId,
      };
    }
  }
  intent.actionEventIds.push(fact.id);
  // The produced fact is not appended by the month controller until this call
  // returns. Project synchronization still needs to validate that exact fact
  // now so completion and interruption return semantics settle in one tick.
  executeWithEvidence([...currentMonthEvents, fact], () => {
    if (intent.projectId) recordProjectAction(state, intent.projectId, fact);
    else if (fact.diff.projectLeadershipSuccession === true
      && typeof fact.diff.projectLeadershipProjectId === 'string') {
      recordProjectAction(state, fact.diff.projectLeadershipProjectId, fact);
    } else if (intent.recordUseBasis && (fact.diff.recordUseStage === 'experiment'
      || fact.diff.recordUseStage === 'replicate'
      || fact.diff.recordUsePreparation === true)) {
      recordProjectAction(state, intent.recordUseBasis.projectId, fact);
    } else if (fact.diff.projectKnowledgeResponse === true
      && typeof fact.diff.projectKnowledgeProjectId === 'string') {
      recordProjectAction(state, fact.diff.projectKnowledgeProjectId, fact);
    }
  });
  if (recordReplicationReceiptCandidate && intent.goal.kind === 'record-replication-receipt') {
    const receiptGoal = intent.goal;
    recordReplicationReceiptCompleted = executeWithCurrentEvidence(() => (
      actionSatisfiesRecordReplicationReceipt(state, fact, receiptGoal)
    ));
    if (!recordReplicationReceiptCompleted) delete fact.diff.recordUseReplicationReceipt;
  }
  if (fact.action.kind === 'act' && fact.action.operation === 'reproduce') intent.lastReproductionAttemptAtMonth = atMonth;
  person.currentActionText = fact.result;
  if (fact.status === 'blocked' || fact.status === 'failed') {
    intent.status = fact.status === 'failed' ? 'failed' : 'blocked';
    intent.blockedReason = fact.result;
    recordIntentGoalOutcome(state, intent, failedActionGoalOutcomeKind(fact), atMonth, [fact.id], fact.action);
    intent.replanCount += 1;
    remember(person, {
      id: `memory:intent-action-failed:${intent.id}:${atMonth}`,
      kind: 'failure', summary: `${intent.summary}失败：${fact.result}`, importance: 78,
      createdAtMonth: atMonth, lastRecalledAtMonth: atMonth,
      expiresAtMonth: atMonth + 6,
      personIds: intent.target?.kind === 'person' ? [intent.target.personId] : [],
      sourceEventIds: [fact.id],
    });
    delete person.activeIntentId;
  } else {
    intent.lastProgressAtMonth = atMonth;
    intent.progress = clamp(intent.progress + (fact.status === 'completed' ? 0.32 : 0.16), 0, 0.95);
    const representationCompleted = intent.goal.kind === 'representation-made'
      && fact.action.kind === 'communicate'
      && fact.action.content.id === intent.goal.representationId
      && fact.status === 'completed';
    const reproductionAttempted = fact.action.kind === 'act' && fact.action.operation === 'reproduce';
    const processAttemptCompleted = fact.status === 'completed'
      && fact.action.kind === 'act'
      && (reproductionAttempted || fact.action.operation === 'combine' || fact.action.operation === 'exert' || fact.action.operation === 'expose');
    if (processAttemptCompleted) intent.lastProcessAttemptAtMonth = atMonth;
    const acceptedAgreementId = fact.status === 'completed'
      && fact.action.kind === 'communicate'
      && fact.action.content.kind === 'accept'
      ? fact.action.content.referenceId
      : undefined;
    const installed = acceptedAgreementId
      ? compileAgreementContinuations(state, acceptedAgreementId, atMonth).map((continuation) => installAgreementContinuation(state, intent, continuation, atMonth)).filter(Boolean)
      : [];
    const currentContinues = installed.some((candidate) => candidate?.id === intent.id);
    const satisfiedAfterAction = goalSatisfied(state, person, intent.goal);
    const maintainUntilMonth = intentMaintainUntilMonth(intent);
    const maintainedStateCompleted = maintainUntilMonth !== undefined
      && satisfiedAfterAction
      && atMonth >= maintainUntilMonth;
    const recordUseProcessCompleted = !intent.recordUseBasis
      || fact.diff.recordUseStage === 'experiment'
      || recordReplicationReceiptCompleted;
    const lifecycleAchievementCompleted = intent.lifecycle?.completion === 'on-achievement'
      && (representationCompleted
        || (processAttemptCompleted && recordUseProcessCompleted)
        || satisfiedAfterAction);
    const ordinaryIntentCompleted = !intent.lifecycle
      && intent.stateGoalUntilMonth === undefined
      && !intent.projectId
      && (representationCompleted
        || (processAttemptCompleted && recordUseProcessCompleted)
        || satisfiedAfterAction);
    if (!currentContinues && (maintainedStateCompleted || lifecycleAchievementCompleted || ordinaryIntentCompleted)) {
      intent.status = 'completed';
      intent.progress = 1;
      const conceptionFact = satisfiedAfterAction
        ? reproductionConceptionFactForIntent(state, intent, [...currentMonthEvents, fact])
        : undefined;
      const reproductionGoal = intent.goal.kind === 'condition'
        && intent.goal.condition === 'pregnancy'
        && intent.goal.present;
      recordIntentGoalOutcome(
        state,
        intent,
        satisfiedAfterAction || representationCompleted || recordReplicationReceiptCompleted
          ? !reproductionGoal || conceptionFact
            ? 'achieved'
            : 'not-evaluated'
          : 'attempted-unmet',
        atMonth,
        [...new Set([fact.id, ...(conceptionFact ? [conceptionFact.id] : [])])],
        conceptionFact?.action ?? fact.action,
      );
      delete person.activeIntentId;
    } else {
      const compiled = executeWithCurrentEvidence(() => recompileNextAction(state, person, intent, atMonth));
      if (compiled) intent.nextAction = compiled;
    }
  }
  return fact;
}

function protectiveGoal(person: PersonState, action: ActionOption['nextAction']): ActionOption['goal'] {
  if (action.kind === 'move') return { kind: 'at-cell', cellId: action.toCellId };
  if (action.kind === 'act' && (action.operation === 'dehydrate' || action.operation === 'rehydrate')) {
    const target = action.targets.find((candidate) => candidate.kind === 'person');
    if (target?.kind === 'person') return {
      kind: 'condition',
      personId: target.personId,
      condition: 'dehydrated-hibernation',
      present: true,
      phase: action.operation === 'dehydrate' ? 'dormant' : 'recovering',
    };
  }
  if (action.kind === 'act' && action.operation === 'ingest') {
    const hydration = action.targets.some((target) => target.kind === 'voxel');
    return {
      kind: 'body-at-least',
      field: hydration ? 'hydration' : 'nutrition',
      value: Math.min(100, (hydration ? person.body.hydration : person.body.nutrition) + 1),
    };
  }
  if (action.kind === 'transfer' && action.to.kind === 'person') return { kind: 'near-person', personId: action.to.personId };
  return { kind: 'at-cell', cellId: person.position.cellId };
}

export function executeProtectiveInterruption(
  state: SimulationState,
  person: PersonState,
  action: ActionOption['nextAction'],
  kind: 'survival-reflex' | 'dependent-care',
  atMonth: number,
  actionTick: number,
  events: WorldEvent[],
): ActionFact {
  const parent = activeIntent(state, person);
  const mayInterrupt = Boolean(parent && isResumableIntent(parent));
  let child: Intent | undefined;
  if (parent && mayInterrupt) {
    const option: ActionOption = {
      id: `${kind}:${atMonth}:${actionTick}:${person.id}`,
      summary: kind === 'dependent-care' ? '先处理身边未成年人的紧急照护' : '先处理本人迫近的生存危险',
      reason: kind === 'dependent-care' ? '未成年人的风险高于本人当前风险' : '本人当前生存风险最高',
      goal: protectiveGoal(person, action),
      nextAction: structuredClone(action),
      estimatedDuration: 'one-month',
      sourceFactIds: person.conditions.flatMap((condition) => condition.sourceEventIds),
      domain: 'strategic',
    };
    const context: DecisionContext = {
      state,
      person,
      visibleCells: [],
      visiblePeople: [],
      visibleDrops: [],
      visibleAnimals: [],
      options: [option],
      followUpOptions: [],
      activeIntent: parent,
    };
    const decision: Decision = {
      kind: 'revise',
      intentId: parent.id,
      optionId: option.id,
      mode: 'interrupt',
      interruptionKind: kind,
      reason: option.reason,
    };
    const decisionFact = applyDecision(state, person, context, decision, false, atMonth, events.length, actionTick, 'edge');
    events.push(decisionFact);
    child = activeIntent(state, person);
  }
  const fact = executePrimitiveAction(state, person, action, atMonth, events.length, {
    ...(child ? { intentId: child.id } : {}),
    cause: 'survival-reflex',
    actionTick,
  });
  if (child && child.interruptionKind === kind) {
    child.actionEventIds.push(fact.id);
    child.status = fact.status === 'failed' ? 'failed' : fact.status === 'blocked' ? 'blocked' : 'completed';
    child.progress = child.status === 'completed' ? 1 : child.progress;
    recordIntentGoalOutcome(
      state,
      child,
      child.status === 'completed' && goalSatisfied(state, person, child.goal) ? 'achieved' : 'attempted-unmet',
      atMonth,
      [fact.id],
      fact.action,
    );
    if (child.status !== 'completed') child.blockedReason = fact.result;
    delete person.activeIntentId;
  }
  events.push(fact);
  if (child) resolveInterruptedIntentReturn(state, person, atMonth);
  return fact;
}

export function executeDependentCareReflex(
  state: SimulationState,
  person: PersonState,
  action: ActionOption['nextAction'],
  atMonth: number,
  actionTick: number,
  events: WorldEvent[],
): ActionFact {
  const recoveryTarget = action.kind === 'act' && action.operation === 'rehydrate'
    ? action.targets.find((target) => target.kind === 'person')
    : undefined;
  const rehydratedDependent = recoveryTarget?.kind === 'person'
    ? state.people.find((candidate) => candidate.id === recoveryTarget.personId
      && isRecoveringFromDehydratedHibernation(candidate))
    : undefined;
  if (!rehydratedDependent) {
    return executeProtectiveInterruption(state, person, action, 'dependent-care', atMonth, actionTick, events);
  }
  const fact = executePrimitiveAction(state, person, action, atMonth, events.length, {
    cause: 'survival-reflex',
    actionTick,
  });
  events.push(fact);
  return fact;
}

export function recordShelterMaintenanceInterruption(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  actionTick: number,
  events: WorldEvent[],
  detail: { reason?: string; sourceFactIds?: string[] } = {},
): void {
  const parent = activeIntent(state, person);
  if (!parent || !isResumableIntent(parent)) return;
  const option: ActionOption = {
    id: `shelter-maintenance:${atMonth}:${actionTick}:${person.id}`,
    summary: '留在真实住所内维持避护',
    reason: detail.reason ?? '当前冷热压力仍要求维持避护状态',
    goal: { kind: 'sheltered' },
    nextAction: { kind: 'move', toCellId: person.position.cellId, toZ: person.position.z },
    estimatedDuration: 'one-month',
    sourceFactIds: detail.sourceFactIds ?? person.conditions.flatMap((condition) => condition.sourceEventIds),
    domain: 'strategic',
  };
  const context: DecisionContext = {
    state,
    person,
    visibleCells: [],
    visiblePeople: [],
    visibleDrops: [],
    visibleAnimals: [],
    options: [option],
    followUpOptions: [],
    activeIntent: parent,
  };
  const decisionFact = applyDecision(state, person, context, {
    kind: 'revise',
    intentId: parent.id,
    optionId: option.id,
    mode: 'interrupt',
    interruptionKind: 'shelter-maintenance',
    reason: option.reason,
  }, false, atMonth, events.length, actionTick, 'edge');
  events.push(decisionFact);
  const child = activeIntent(state, person);
  if (!child || child.interruptionKind !== 'shelter-maintenance') return;
  child.status = 'completed';
  child.progress = 1;
  recordIntentGoalOutcome(
    state,
    child,
    goalSatisfied(state, person, child.goal) ? 'achieved' : 'attempted-unmet',
    atMonth,
    [decisionFact.id],
  );
  delete person.activeIntentId;
  resolveInterruptedIntentReturn(state, person, atMonth);
}
