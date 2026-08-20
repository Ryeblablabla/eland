import { executeIntentAction, executePrimitiveAction, goalSatisfied } from '../../domain/action-executor';
import type { ActionOption } from '../../domain/action';
import { composeIntentChoice } from '../../domain/intent';
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
import { recompileNextAction, reproductionIntentAttemptedThisMonth } from '../action-options';
import { ordinaryLearningChildActionAllowed } from '../age-planning';
import { compileAgreementContinuations, type AgreementContinuation } from '../agreement-continuation';
import {
  ensureProject,
  recordProjectAction,
  synchronizeProject,
} from '../project-options';
import { isMaintainableStateGoal } from '../rule-planner';
import { clamp } from './state-utils';

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
  const choice = composeIntentChoice(context.options, context.followUpOptions, optionId, followUpOptionId);
  if (!choice) return null;
  const linkedProject = choice.projectProposal
    ? ensureProject(state, choice.projectProposal, {
      person,
      visibleCells: context.visibleCells,
      atMonth,
    })
    : choice.projectId
      ? state.projects.find((project) => project.id === choice.projectId && project.status === 'active')
      : undefined;
  if (choice.projectId && !linkedProject) return null;
  const projectTarget = bindIntentProjectTarget(choice.goal, linkedProject);
  const previous = activeIntent(state, person);
  if (previous) previous.status = 'abandoned';
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
  return state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active');
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
    || (!ordinarySurvivalInterruption && !parent.projectId && !parent.returnToIntentId)
    || !selected
    || selected.projectProposal) return null;
  const project = parent.projectId
    ? state.projects.find((candidate) => candidate.id === parent.projectId && candidate.status === 'active')
    : undefined;
  if (parent.projectId && !project) return null;
  const selectedProject = selected.projectId
    ? state.projects.find((candidate) => candidate.id === selected.projectId && candidate.status === 'active')
    : undefined;
  if (selected.projectId && !selectedProject) return null;
  const childId = `intent-${atMonth}-${person.id}-interrupt-${state.intents.length}`;
  const sourceAgreement = [...state.agreements].reverse().find((agreement) => (
    agreement.partyIds.includes(person.id)
    && (agreement.status === 'proposed' || agreement.status === 'active')
    && selected.sourceFactIds.includes(agreement.proposalEventId)
  ));
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
  const child = [...state.intents].reverse().find((intent) => intent.ownerId === person.id
    && intent.returnToIntentId
    && intent.returnOutcome === undefined
    && (intent.status === 'completed' || intent.status === 'blocked' || intent.status === 'failed' || intent.status === 'abandoned'));
  if (!child?.returnToIntentId) return;
  const parent = state.intents.find((intent) => intent.id === child.returnToIntentId && intent.ownerId === person.id);
  const project = parent?.projectId ? state.projects.find((candidate) => candidate.id === parent.projectId) : undefined;
  child.returnResolvedAtMonth = atMonth;
  if (!parent || parent.status !== 'suspended' || (parent.projectId && !project)) {
    child.returnOutcome = 'parent-unavailable';
    return;
  }
  if (project?.status === 'completed') {
    parent.status = 'completed';
    parent.progress = 1;
    delete parent.suspendedByIntentId;
    delete parent.suspendedAtMonth;
    child.returnOutcome = 'parent-completed';
    return;
  }
  if (project?.status === 'blocked') {
    parent.status = 'blocked';
    parent.blockedReason = project.blockedReason ?? '中断期间项目已无法继续';
    delete parent.suspendedByIntentId;
    delete parent.suspendedAtMonth;
    child.returnOutcome = 'parent-blocked';
    return;
  }
  if (project && project.status !== 'active') {
    parent.status = 'abandoned';
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
    const child = [...state.intents].reverse().find((intent) => intent.ownerId === person.id
      && intent.returnToIntentId
      && intent.returnOutcome === undefined
      && (intent.status === 'completed' || intent.status === 'blocked' || intent.status === 'failed' || intent.status === 'abandoned'));
    if (!child) return;
    resolveInterruptedIntentReturn(state, person, atMonth);
    if (child.returnOutcome === undefined) return;
  }
}

export function installAgreementContinuation(state: SimulationState, currentIntent: Intent, continuation: AgreementContinuation, atMonth: number): Intent | null {
  const owner = state.people.find((person) => person.id === continuation.personId && isAlive(person));
  if (!owner) return null;
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
  const attachLifeReview = (intent: Intent | null): void => {
    if (!intent || (decision.kind !== 'start' && decision.kind !== 'revise') || !decision.lifeReview) return;
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
    const resumed = state.intents.find((intent) => intent.id === decision.intentId
      && intent.ownerId === person.id
      && intent.status === 'suspended'
      && !intent.suspendedByIntentId);
    if (resumed) {
      if (current) current.status = 'suspended';
      resumed.status = 'active';
      person.activeIntentId = resumed.id;
      intentId = resumed.id;
      result = `${person.name}恢复：${resumed.summary}`;
    }
  } else if (decision.kind === 'abandon' && current?.id === decision.intentId) {
    current.status = 'abandoned';
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
    state.world.past = [...committedPast, ...currentMonthEvents];
    try {
      return operation();
    } finally {
      state.world.past = committedPast;
    }
  };
  const project = intent.projectId ? state.projects.find((candidate) => candidate.id === intent.projectId) : undefined;
  if (project) executeWithCurrentEvidence(() => synchronizeProject(state, project, atMonth));
  if (project && project.status === 'blocked') {
    intent.status = 'blocked';
    intent.blockedReason = project.blockedReason ?? '持续项目已经无法推进';
    delete person.activeIntentId;
    person.currentActionText = `项目需要重评：${intent.summary}`;
    return null;
  }
  const sourceAgreement = intent.agreementId ? state.agreements.find((agreement) => agreement.id === intent.agreementId) : undefined;
  if (sourceAgreement && sourceAgreement.status !== 'proposed' && sourceAgreement.status !== 'active') {
    intent.status = sourceAgreement.status === 'fulfilled' || sourceAgreement.status === 'rejected' ? 'completed' : 'failed';
    intent.progress = sourceAgreement.status === 'fulfilled' || sourceAgreement.status === 'rejected' ? 1 : intent.progress;
    delete person.activeIntentId;
    person.currentActionText = sourceAgreement.status === 'fulfilled' ? `约定已经履行：${intent.summary}` : `约定已经结束：${intent.summary}`;
    return null;
  }
  if (lifePlanningStage(person, atMonth) === 'learning-child'
    && !ordinaryLearningChildActionAllowed(state, person, intent.nextAction)) {
    intent.status = 'abandoned';
    intent.blockedReason = '普通任务的下一步已经越出当前可见亲代的本地照护半径';
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
    delete person.activeIntentId;
    person.currentActionText = `已经完成：${intent.summary}`;
    return null;
  }
  if (intent.stateGoalUntilMonth !== undefined && atMonth > intent.stateGoalUntilMonth) {
    intent.status = 'blocked';
    intent.blockedReason = `第 ${intent.stateGoalUntilMonth} 月状态复核时目标仍未满足`;
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
      delete person.activeIntentId;
      person.currentActionText = `双方本月已经完成一次生殖尝试，等待下月重新评估：${intent.summary}`;
      return null;
    }
    intent.status = 'blocked';
    intent.blockedReason = '目标未满足，但无法编译出下一原子动作';
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
  }
  if (fact.action.kind === 'act' && fact.action.operation === 'reproduce') intent.lastReproductionAttemptAtMonth = atMonth;
  person.currentActionText = fact.result;
  if (fact.status === 'blocked' || fact.status === 'failed') {
    intent.status = fact.status === 'failed' ? 'failed' : 'blocked';
    intent.blockedReason = fact.result;
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
  const mayInterrupt = Boolean(parent && (parent.projectId || parent.returnToIntentId));
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
  if (!parent || (!parent.projectId && !parent.returnToIntentId)) return;
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
  delete person.activeIntentId;
  resolveInterruptedIntentReturn(state, person, atMonth);
}
