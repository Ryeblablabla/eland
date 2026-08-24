import { executeIntentAction, executePrimitiveAction, goalSatisfied } from '../../domain/action-executor';
import type { ActionOption } from '../../domain/action';
import { agreementById, agreementsForPerson } from '../../domain/agreement';
import { recordIntentGoalOutcome } from '../../domain/cognition';
import { clearPlanningEventOverlay, registerPlanningEventOverlay } from '../../domain/event-index';
import { composeIntentChoice, isResumableIntent } from '../../domain/intent';
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
import { recompileNextAction, reproductionIntentAttemptedThisMonth } from '../action-options';
import { ordinaryLearningChildActionAllowed } from '../age-planning';
import { compileAgreementContinuations, type AgreementContinuation } from '../agreement-continuation';
import { evaluateCognitiveOption } from '../cognition/option-appraisal';
import {
  ensureProject,
  recordProjectAction,
  synchronizeProject,
} from '../project-options';
import { isFulfillmentOption, isMaintainableStateGoal, isRequiredSocialOption } from '../rule-planner';
import { clamp } from './state-utils';

const MAX_REPRODUCTION_AUDIT_SOURCE_FACTS = 32;

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
  return [...state.world.past, ...currentMonthEvents].reverse().find((event): event is ActionFact => (
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
  return [...state.world.past, ...currentMonthEvents].reverse().find((event): event is ActionFact => (
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

function stateGoalDurationMonths(duration: ActionOption['estimatedDuration'], estimatedMonths?: number): number {
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
  project: Pick<SimulationState['projects'][number], 'id' | 'ownerId' | 'status'> | undefined,
  personId: PersonId,
  atMonth: number,
): boolean {
  return Boolean(intent.projectId
    && project?.id === intent.projectId
    && project.status === 'active'
    && project.ownerId !== personId
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
    previous.status = 'abandoned';
    recordIntentGoalOutcome(
      state,
      previous,
      'not-evaluated',
      atMonth,
      intentGoalSourceIds(state, previous, [decisionEventId]),
    );
  }
  const plannedDurationMonths = choice.domain === 'strategic'
    && choice.goal.kind !== 'project-completed'
    && isMaintainableStateGoal(choice.goal)
    ? stateGoalDurationMonths(choice.estimatedDuration, choice.estimatedMonths)
    : undefined;
  const intent: Intent = {
    id: `intent-${atMonth}-${person.id}-${state.intents.length}`,
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
      stateGoalUntilMonth: atMonth + plannedDurationMonths - 1,
    } : {}),
    sourceDecisionEventId: decisionEventId,
    ...(sourceAgreement ? { agreementId: sourceAgreement.id } : {}),
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
  const childId = `intent-${atMonth}-${person.id}-interrupt-${state.intents.length}`;
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
  const existing = activeIntent(state, owner);
  const continuingCurrentIntent = existing?.id === currentIntent.id;
  const interrupted = continuingCurrentIntent ? undefined : existing;
  const intent = continuingCurrentIntent ? currentIntent : {
    id: `intent-${atMonth}-${owner.id}-agreement-${state.intents.length}`,
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
    delete intent.lastProcessAttemptAtMonth;
    intent.sourceFactIds = [...new Set([...(intent.sourceFactIds ?? []), ...continuation.sourceFactIds])];
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
): DecisionFact {
  const id = `e-${atMonth}-decision-${person.id}-${planningTick}-${orderInMonth}`;
  let intentId: string | undefined;
  let result = decision.reason;
  let domain: Intent['domain'] | undefined;
  const current = activeIntent(state, person);
  const selectedOption = decision.kind === 'start' || decision.kind === 'revise'
    ? context.options.find((option) => option.id === decision.optionId)
    : undefined;
  const selectedReproductionOption = selectedOption && (
    selectedOption.id.startsWith('offer-reproduce:')
      || selectedOption.id.startsWith('accept-reproduce:')
      || selectedOption.id.startsWith('reject-reproduce:')
      || selectedOption.id.startsWith('reproduce:')
      || selectedOption.id.startsWith('withdraw-reproduce:')
  ) ? selectedOption : undefined;
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
    ...(selectedCognitiveAppraisal ? {
      reproductionEvidence: {
        version: 'family-readiness-v2' as const,
        optionId: selectedCognitiveAppraisal.option.id,
        direction: selectedCognitiveAppraisal.option.id.startsWith('reject-reproduce:')
          || selectedCognitiveAppraisal.option.id.startsWith('withdraw-reproduce:')
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
    usedModel,
    result,
  };
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
  const executeWithCurrentEvidence = <T>(operation: () => T): T => {
    if (!currentMonthEvents.length) return operation();
    const committedPast = state.world.past;
    state.world.past = currentEvidenceHistory(currentMonthEvents, committedPast);
    registerPlanningEventOverlay(state, currentMonthEvents, committedPast);
    try {
      return operation();
    } finally {
      clearPlanningEventOverlay(state);
      state.world.past = committedPast;
    }
  };
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
    if (intent.stateGoalUntilMonth !== undefined && atMonth < intent.stateGoalUntilMonth) {
      const duration = Math.max(1, intent.plannedDurationMonths ?? intent.stateGoalUntilMonth - intent.createdAtMonth + 1);
      intent.progress = Math.max(intent.progress, clamp((atMonth - intent.createdAtMonth + 1) / duration, 0, 0.95));
      intent.lastProgressAtMonth = atMonth;
      person.currentActionText = `维持状态目标至第 ${intent.stateGoalUntilMonth} 月：${intent.summary}`;
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
  if (intent.stateGoalUntilMonth !== undefined && atMonth > intent.stateGoalUntilMonth) {
    intent.status = 'blocked';
    intent.blockedReason = `第 ${intent.stateGoalUntilMonth} 月状态复核时目标仍未满足`;
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
      personIds: intent.target?.kind === 'person' ? [intent.target.personId] : [],
      sourceEventIds: [...intent.actionEventIds],
    });
    delete person.activeIntentId;
    person.currentActionText = `状态目标到期，需要重评：${intent.summary}`;
    return null;
  }
  const next = executeWithCurrentEvidence(() => recompileNextAction(state, person, intent, atMonth));
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
  if (intent.recordUseBasis && intent.recordUseStage) {
    const basis = intent.recordUseBasis;
    const v2GroundSource = basis.version === 'record-use-basis-v2' && basis.carrierSource.kind === 'ground'
      ? basis.carrierSource
      : undefined;
    const completedFrozenAcquisition = Boolean(v2GroundSource
      && fact.status === 'completed'
      && fact.action.kind === 'transfer'
      && fact.action.from.kind === 'ground'
      && fact.action.from.cellId === v2GroundSource.cellId
      && fact.action.from.z === v2GroundSource.z
      && fact.action.dropId === v2GroundSource.dropId
      && fact.action.to.kind === 'person'
      && fact.action.to.personId === basis.readerId
      && fact.diff.recordPayloadId === basis.recordId);
    const stage = basis.version === 'record-use-basis-v1' && intent.recordUseStage === 'share'
      ? 'share'
      : completedFrozenAcquisition
        ? 'acquire'
        : fact.action.kind === 'attend'
          ? 'read'
          : fact.action.kind === 'act'
            ? 'experiment'
            : undefined;
    if (stage) {
      const confidenceAfter = person.knowledge.find((knowledge) => knowledge.id === basis.knowledgeId)?.confidence;
      fact.diff = {
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
        ...(basis.version === 'record-use-basis-v2' ? {
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
        ...(recordUseConfidenceBefore !== undefined
          ? { recordUseKnowledgeConfidenceBefore: recordUseConfidenceBefore }
          : {}),
        ...(confidenceAfter !== undefined
          ? { recordUseKnowledgeConfidenceAfter: confidenceAfter }
          : {}),
      };
      if (basis.version === 'record-use-basis-v2' && fact.status === 'completed') {
        if (stage === 'acquire') intent.recordUseStage = 'read';
        else if (stage === 'read') intent.recordUseStage = 'experiment';
      }
    }
  }
  intent.actionEventIds.push(fact.id);
  if (intent.projectId) recordProjectAction(state, intent.projectId, fact);
  else if (intent.recordUseBasis && fact.diff.recordUseStage === 'experiment') {
    recordProjectAction(state, intent.recordUseBasis.projectId, fact);
  } else if (fact.diff.projectKnowledgeResponse === true
    && typeof fact.diff.projectKnowledgeProjectId === 'string') {
    recordProjectAction(state, fact.diff.projectKnowledgeProjectId, fact);
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
    const stateGoalCompleted = intent.stateGoalUntilMonth !== undefined
      && satisfiedAfterAction
      && atMonth >= intent.stateGoalUntilMonth;
    const ordinaryIntentCompleted = intent.stateGoalUntilMonth === undefined
      && !intent.projectId
      && (representationCompleted || processAttemptCompleted || satisfiedAfterAction);
    if (!currentContinues && (stateGoalCompleted || ordinaryIntentCompleted)) {
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
        satisfiedAfterAction || representationCompleted
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
    const decisionFact = applyDecision(state, person, context, decision, false, atMonth, events.length, actionTick);
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
  }, false, atMonth, events.length, actionTick);
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
