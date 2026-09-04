import { executePrimitiveAction } from '../../domain/action-executor';
import { synchronizeAgreementResponseDeadlineSuspensions } from '../../domain/agreement';
import { PLANNING_TICKS_PER_MONTH } from '../../domain/calendar';
import {
  ORDINARY_DECISION_PERSON_MONTHS,
  ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH,
} from '../../domain/decision-budget';
import {
  chooseDependentCareReflex,
  dependentCareUrgency,
  shouldRemainShelteredForDependent,
} from '../../domain/dependent-care';
import { lifePlanningStage } from '../../domain/life-stage';
import { synchronizeMortuaryPerceptions } from '../../domain/mortuary';
import type {
  AgentDecider,
  Decision,
  DecisionContext,
  Intent,
  PrimitiveAction,
  SimulationState,
  TokenUsage,
  WorldEvent,
} from '../../domain/model';
import {
  advanceBodies,
  advanceSharedRelationshipExperience,
  synchronizeHibernationIntentSuspensions,
} from '../../domain/monthly-processes';
import {
  isAlive,
  isDormantDehydratedHibernating,
  isRecoveringFromDehydratedHibernation,
  type PersonId,
  type PersonState,
} from '../../domain/person';
import { intentById, livingPeople, personById, projectById } from '../../domain/state-index';
import {
  chooseHibernationRecoveryReflex,
  chooseSurvivalReflex,
  shouldRemainSheltered,
  survivalReflexUrgency,
} from '../../domain/survival-reflex';
import { shouldRemainShelteredFromWildlifeThreat } from '../../domain/wildlife-threat';
import { seededFraction } from '../../world/generator';
import { buildDecisionContext } from '../action-options';
import { hasCausalShelterAdaptationNeed } from '../project-options';
import { RulePlanner } from '../rule-planner';
import {
  activeIntent,
  applyDecision,
  continuesSelfCareAfterCaregiverReturn,
  decisionPlanningChannel,
  drainInterruptedIntentReturns,
  executeActiveIntent,
  executeDependentCareReflex,
  executeProtectiveInterruption,
  recordShelterMaintenanceInterruption,
  resolveClearedProtectiveInterruption,
} from './intent-execution';
import { currentRollingLedgers, finishMonth, type PreparedMonth } from './month-boundary';
import type { ObservationProjector } from './observation-projector';
import { clamp } from './state-utils';
import { hasCoLocatedLivingParent, planLocallyForTick } from './tick-planner';
import { refreshPersonMindMarkdown } from '../../domain/person-mind';

export interface ModelAttemptSummary {
  total: number;
  ordinary: number;
  exempt: number;
}

export type TickActorControl =
  | { kind: 'wait'; text?: string }
  | { kind: 'continue-intent' }
  | { kind: 'direct-action'; action: PrimitiveAction; text?: string }
  | { kind: 'decision'; context: DecisionContext; decision: Decision; usedModel?: boolean };

/**
 * Application-layer seam used by limited embodiment. It receives only the
 * current authoritative working state and returns an already validated command
 * for this actor turn. Domain execution still performs its normal final checks.
 */
export type TickActorController = (input: {
  state: SimulationState;
  person: PersonState;
  atMonth: number;
  actionTick: number;
  events: WorldEvent[];
}) => TickActorControl | undefined;

export interface MonthExecution {
  prepared: PreparedMonth;
  usage: TokenUsage;
  attempted: ModelAttemptSummary;
  tickPlanner: AgentDecider;
  projectionCadence: 'monthly' | 'annual';
  observationProjector: ObservationProjector;
  controlledPersonId?: PersonId;
  reviewedPeople: Set<PersonId>;
  ordinaryDeliberationCounts: Map<PersonId, number>;
  ordinaryReplanPermits: Set<PersonId>;
  plannedAtTickOne: Set<PersonId>;
  plannedAtTicks: Map<PersonId, number>;
  participantIds: PersonId[];
  completedTick: number;
  finished: boolean;
}

export interface TickExecutionResult {
  actionTick: number;
  events: WorldEvent[];
  controlRequested: boolean;
  controlApplied: boolean;
}

const authoritativeRulePlanner = new RulePlanner();

export function createMonthExecution(input: {
  observationProjector: ObservationProjector;
  prepared: PreparedMonth;
  decisions: Map<PersonId, { decision: Decision; usedModel: boolean }>;
  usage: TokenUsage;
  attempted: ModelAttemptSummary;
  tickPlanner?: AgentDecider;
  projectionCadence?: 'monthly' | 'annual';
  controlledPersonId?: PersonId;
}): MonthExecution {
  const {
    prepared,
    decisions,
    controlledPersonId,
  } = input;
  const reviewedPeople = new Set<PersonId>();
  const ordinaryDeliberationCounts = new Map<PersonId, number>();
  const ordinaryReplanPermits = new Set<PersonId>();
  const plannedAtTickOne = new Set<PersonId>();
  const plannedAtTicks = new Map<PersonId, number>();
  // `prepareMonth` preserves the old public no-op contract for an authority
  // head that had already ended: no new month, ledger, or history entry exists.
  const alreadyEnded = prepared.state.civilization.status === 'ended'
    && prepared.events.length === 0
    && prepared.atMonth === prepared.state.clock.elapsedMonths;

  if (prepared.state.civilization.status !== 'ended') {
    for (const candidate of prepared.candidates) {
      const person = personById(prepared.state, candidate.person.id);
      if (!person || !isAlive(person) || person.id === controlledPersonId) continue;
      const freshContext = buildDecisionContext(prepared.state, person, prepared.atMonth);
      const picked = decisions.get(person.id);
      if (!picked) continue;
      const pickedDecision = picked.decision;
      const selectedOptionAtDecision = pickedDecision.kind === 'start' || pickedDecision.kind === 'revise'
        ? candidate.options.find((option) => option.id === pickedDecision.optionId)
        : undefined;
      const planningChannel = decisionPlanningChannel(freshContext, picked.decision);
      if (planningChannel === 'ordinary') ordinaryDeliberationCounts.set(person.id, 1);
      if (picked.decision.kind !== 'idle'
        || picked.usedModel
        || Boolean(picked.decision.characterAgendaUpdate)) {
        prepared.events.push(applyDecision(
          prepared.state,
          person,
          freshContext,
          picked.decision,
          picked.usedModel,
          prepared.atMonth,
          prepared.events.length,
          1,
          planningChannel,
          selectedOptionAtDecision,
        ));
      }
      plannedAtTickOne.add(person.id);
      plannedAtTicks.set(person.id, 1);
      reviewedPeople.add(person.id);
    }
  }

  return {
    prepared,
    usage: input.usage,
    attempted: input.attempted,
    tickPlanner: input.tickPlanner ?? authoritativeRulePlanner,
    projectionCadence: input.projectionCadence ?? 'monthly',
    observationProjector: input.observationProjector,
    ...(controlledPersonId ? { controlledPersonId } : {}),
    reviewedPeople,
    ordinaryDeliberationCounts,
    ordinaryReplanPermits,
    plannedAtTickOne,
    plannedAtTicks,
    participantIds: livingPeople(prepared.state).map((person) => person.id),
    completedTick: alreadyEnded ? PLANNING_TICKS_PER_MONTH : 0,
    finished: alreadyEnded,
  };
}

export function applyPlanningDecisions(
  execution: MonthExecution,
  inputs: Array<{ context: DecisionContext; decision: Decision; usedModel: boolean }>,
  planningTick: number,
): void {
  const { state, events, atMonth } = execution.prepared;
  for (const { context, decision, usedModel } of inputs) {
    const person = personById(state, context.person.id);
    if (!person || !isAlive(person) || person.id === execution.controlledPersonId) continue;
    const planningChannel = decisionPlanningChannel(context, decision);
    if (planningChannel === 'ordinary') {
      const count = execution.ordinaryDeliberationCounts.get(person.id) ?? 0;
      execution.ordinaryDeliberationCounts.set(person.id, count + 1);
      execution.ordinaryReplanPermits.delete(person.id);
    }
    if (decision.kind !== 'idle' || usedModel || Boolean(decision.characterAgendaUpdate)) {
      events.push(applyDecision(
        state,
        person,
        context,
        decision,
        usedModel,
        atMonth,
        events.length,
        planningTick,
        planningChannel,
        decision.kind === 'start' || decision.kind === 'revise'
          ? context.options.find((option) => option.id === decision.optionId)
          : undefined,
      ));
    }
    execution.plannedAtTicks.set(person.id, planningTick);
    execution.reviewedPeople.add(person.id);
  }
}

function isTerminalIntent(intent: Intent | undefined): intent is Intent {
  return Boolean(intent && (intent.status === 'completed'
    || intent.status === 'blocked'
    || intent.status === 'failed'
    || intent.status === 'abandoned'
    || (intent.status === 'suspended' && intent.waitingFor === 'world-change')));
}

interface RootIntentTrace {
  id: Intent['id'];
  statusBefore: Intent['status'];
}

function rootIntentForPerson(state: SimulationState, person: PersonState): RootIntentTrace | undefined {
  let current = activeIntent(state, person);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    if (!current.returnToIntentId) return { id: current.id, statusBefore: current.status };
    const parent = intentById(state, current.returnToIntentId);
    if (!parent || parent.ownerId !== person.id) return undefined;
    current = parent;
  }
  return undefined;
}

function continuesShelterAdaptationProject(
  state: SimulationState,
  intent: Intent | undefined,
): boolean {
  const interruptedParent = intent?.returnToIntentId
    ? intentById(state, intent.returnToIntentId)
    : undefined;
  const projectId = intent?.projectId ?? interruptedParent?.projectId;
  const project = projectId ? projectById(state, projectId) : undefined;
  return project?.status === 'active'
    && (project.desiredFunction === 'weather-shelter'
      || Boolean(project.shelterRequirement));
}

/** A sourced self-dehydrate step is itself immediate shelter protection. */
export function continuesImmediateShelterProtection(
  intent: Intent | undefined,
  person: PersonState,
): boolean {
  if (!intent || intent.status !== 'active' || intent.nextAction.kind !== 'act'
    || intent.nextAction.operation !== 'dehydrate') return false;
  return intent.nextAction.targets.some((target) => target.kind === 'person'
    && target.personId === person.id);
}

function grantTerminalReplanPermit(
  execution: MonthExecution,
  person: PersonState,
  rootBeforeStep: RootIntentTrace | undefined,
): void {
  const rootAfterStep = rootBeforeStep
    ? intentById(execution.prepared.state, rootBeforeStep.id)
    : undefined;
  if (!rootBeforeStep
    || (rootBeforeStep.statusBefore !== 'active' && rootBeforeStep.statusBefore !== 'suspended')
    || !isTerminalIntent(rootAfterStep)
    || rootAfterStep.returnToIntentId
    || person.activeIntentId
    || activeIntent(execution.prepared.state, person)) return;
  const ordinaryCount = execution.ordinaryDeliberationCounts.get(person.id) ?? 0;
  if (ordinaryCount < ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH) {
    execution.ordinaryReplanPermits.add(person.id);
  }
}

function executeIntentStep(
  execution: MonthExecution,
  person: PersonState,
  actionTick: number,
  fallbackRoot?: RootIntentTrace,
): WorldEvent | null {
  const { state, events, atMonth } = execution.prepared;
  const rootBeforeStep = rootIntentForPerson(state, person) ?? fallbackRoot;
  const fact = executeActiveIntent(state, person, atMonth, events.length, actionTick, events);
  if (fact) events.push(fact);
  drainInterruptedIntentReturns(state, person, atMonth);
  const spoke = fact?.kind === 'action'
    && fact.status === 'completed'
    && fact.action.kind === 'talk';
  const resumed = spoke ? activeIntent(state, person) : undefined;
  const compatibleBodyAction = resumed?.nextAction.kind !== 'talk'
    && !(resumed?.nextAction.kind === 'act'
      && ['hunt', 'dehydrate', 'rehydrate', 'reproduce'].includes(resumed.nextAction.operation));
  if (spoke && resumed && compatibleBodyAction) {
    const bodyFact = executeActiveIntent(state, person, atMonth, events.length, actionTick, events);
    if (bodyFact) events.push(bodyFact);
    drainInterruptedIntentReturns(state, person, atMonth);
  }
  grantTerminalReplanPermit(execution, person, rootBeforeStep);
  return fact;
}

function executeActorControl(
  execution: MonthExecution,
  person: PersonState,
  actionTick: number,
  control: TickActorControl,
): void {
  const { state, events, atMonth } = execution.prepared;
  const rootBeforeDecision = rootIntentForPerson(state, person);
  if (control.kind === 'wait') {
    person.currentActionText = control.text ?? '停留原地观察周围';
    return;
  }
  if (control.kind === 'direct-action') {
    const fact = executePrimitiveAction(state, person, control.action, atMonth, events.length, {
      cause: 'player-embodiment',
      actionTick,
    });
    events.push(fact);
    person.currentActionText = fact.result || control.text || '完成本刻行动';
    return;
  }
  if (control.kind === 'decision') {
    const planningChannel = decisionPlanningChannel(control.context, control.decision);
    if (planningChannel === 'ordinary') {
      const ordinaryCount = execution.ordinaryDeliberationCounts.get(person.id) ?? 0;
      execution.ordinaryDeliberationCounts.set(
        person.id,
        Math.min(ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH, ordinaryCount + 1),
      );
      execution.ordinaryReplanPermits.delete(person.id);
    }
    execution.reviewedPeople.add(person.id);
    if (control.decision.kind !== 'idle' || Boolean(control.decision.characterAgendaUpdate)) {
      events.push(applyDecision(
        state,
        person,
        control.context,
        control.decision,
        control.usedModel ?? false,
        atMonth,
        events.length,
        actionTick,
        planningChannel,
      ));
    }
    if (control.decision.kind === 'idle') {
      if (person.lastActionAtMonth !== atMonth) person.currentActionText = control.decision.reason;
      return;
    }
  }
  const fact = executeIntentStep(execution, person, actionTick, rootBeforeDecision);
  if (!fact && control.kind === 'continue-intent') {
    person.currentActionText = '当前意图暂时没有可执行的下一步';
  }
}

export function executePlanningTick(
  execution: MonthExecution,
  actorController?: TickActorController,
): TickExecutionResult {
  if (execution.finished) throw new Error('月份已经完成，不能继续执行规划刻度');
  const actionTick = execution.completedTick + 1;
  if (actionTick > PLANNING_TICKS_PER_MONTH) throw new Error('月份已经执行完 15 个规划刻度');
  const { state, events, atMonth } = execution.prepared;
  const eventStart = events.length;
  let controlRequested = false;
  let controlApplied = false;

  if (state.civilization.status !== 'ended') {
    const order = execution.participantIds
      .map((personId) => personById(state, personId))
      .filter((person): person is PersonState => Boolean(person && isAlive(person)))
      .sort((a, b) => seededFraction(state.seed, `action-order:${state.branchId}:${atMonth}:${actionTick}:${a.id}`)
        - seededFraction(state.seed, `action-order:${state.branchId}:${atMonth}:${actionTick}:${b.id}`)
        || a.id.localeCompare(b.id));

    for (const person of order) {
      if (isDormantDehydratedHibernating(person)) {
        person.currentActionText = '处于脱水休眠，以极低代谢等待环境稳定';
        continue;
      }
      if (isRecoveringFromDehydratedHibernation(person)) {
        const recovery = chooseHibernationRecoveryReflex(state, person, events);
        if (recovery) {
          const fact = executePrimitiveAction(state, person, recovery, atMonth, events.length, {
            cause: 'survival-reflex',
            actionTick,
          });
          events.push(fact);
          person.currentActionText = fact.result;
        } else {
          person.currentActionText = '处于休眠恢复期，只等待或寻找真实水与食物';
        }
        continue;
      }
      const queuedIntent = activeIntent(state, person);
      // A contributor may be executing another person's shelter project. That
      // exact intent is itself causal adaptation work even though the helper
      // does not own the Project aggregate. Without this check, each outward
      // construction step loses the owner-only predicate and immediately
      // triggers a retreat to the old shelter on the next planning tick.
      const continuesShelterProject = continuesShelterAdaptationProject(state, queuedIntent);
      const perceivesShelterAdaptation = hasCausalShelterAdaptationNeed(state, person);
      const causalShelterWork = continuesShelterProject
        || (!queuedIntent && perceivesShelterAdaptation);
      const reflex = chooseSurvivalReflex(state, person, {
        suppressThermalShelter: causalShelterWork,
        currentMonthEvents: events,
      });
      const queuedDehydrateTarget = queuedIntent?.nextAction.kind === 'act'
        && queuedIntent.nextAction.operation === 'dehydrate'
        ? queuedIntent.nextAction.targets.find((target) => target.kind === 'person')
        : undefined;
      const reflexDehydrateTarget = reflex?.kind === 'act' && reflex.operation === 'dehydrate'
        ? reflex.targets.find((target) => target.kind === 'person')
        : undefined;
      const reflexDuplicatesQueuedDehydrate = queuedDehydrateTarget?.kind === 'person'
        && queuedDehydrateTarget.personId === person.id
        && reflexDehydrateTarget?.kind === 'person'
        && reflexDehydrateTarget.personId === queuedDehydrateTarget.personId;
      const dependentChild = lifePlanningStage(person, atMonth) === 'dependent-child';
      const awaitingCaregiver = dependentChild && hasCoLocatedLivingParent(state, person);
      const dependentCare = dependentChild
        ? null
        : chooseDependentCareReflex(state, person, {
            suppressThermalShelter: causalShelterWork,
            currentMonthEvents: events,
          });
      if (!reflex) resolveClearedProtectiveInterruption(
        state,
        person,
        'survival-reflex',
        atMonth,
      );
      if (!dependentCare) resolveClearedProtectiveInterruption(
        state,
        person,
        'dependent-care',
        atMonth,
      );
      const wildlifeShelter = shouldRemainShelteredFromWildlifeThreat(state, person, atMonth, events);
      const selfShelterMaintenance = shouldRemainSheltered(state, person, reflex);
      const dependentShelterMaintenance = shouldRemainShelteredForDependent(state, person);
      const maintainingShelter = wildlifeShelter
        || selfShelterMaintenance
        || dependentShelterMaintenance;
      // Reaching shelter can clear the primitive move reflex while the causal
      // danger is still active. Treat that maintenance state as an ongoing
      // self-protection response when comparing it with care urgency; otherwise
      // a milder child need pulls the caregiver out and the same thermal reflex
      // sends them straight back on the next tick.
      const hasActiveSelfProtection = Boolean(reflex)
        || wildlifeShelter
        || selfShelterMaintenance;
      const careIsMoreUrgent = Boolean(dependentCare)
        && (!hasActiveSelfProtection
          || dependentCareUrgency(state, person) > survivalReflexUrgency(state, person));
      if (careIsMoreUrgent && dependentCare) {
        const rootBeforeInterruption = rootIntentForPerson(state, person);
        const fact = executeDependentCareReflex(state, person, dependentCare, atMonth, actionTick, events);
        person.currentActionText = fact.result;
        drainInterruptedIntentReturns(state, person, atMonth);
        grantTerminalReplanPermit(execution, person, rootBeforeInterruption);
        continue;
      }
      if (selfShelterMaintenance
        && !causalShelterWork
        && reflex?.kind === 'move'
        && !reflex.wildlifeThreatBasis) {
        // The body thresholds inside shouldRemainSheltered already decide
        // whether thirst or hunger is urgent enough to leave. When they are
        // not, a second ordinary survival move must not outrank the existing
        // real shelter and bounce the person across its doorway every tick.
        // Non-movement emergency acts, wildlife responses and genuinely more
        // urgent dependent care retain their normal paths above/below.
        const rootBeforeInterruption = rootIntentForPerson(state, person);
        recordShelterMaintenanceInterruption(state, person, atMonth, actionTick, events);
        person.currentActionText = '留在住所内维持避护状态';
        drainInterruptedIntentReturns(state, person, atMonth);
        grantTerminalReplanPermit(execution, person, rootBeforeInterruption);
        continue;
      }
      if (reflexDuplicatesQueuedDehydrate) {
        executeIntentStep(execution, person, actionTick);
        continue;
      }
      const resumesSelfCareBeforeAnotherCaregiverTrip = reflex?.kind === 'move'
        && Boolean(reflex.caregiverRef)
        && continuesSelfCareAfterCaregiverReturn(state, person, queuedIntent, atMonth);
      if (resumesSelfCareBeforeAnotherCaregiverTrip) {
        executeIntentStep(execution, person, actionTick);
        continue;
      }
      if (reflex && !(dependentChild && reflex.kind === 'move' && !reflex.wildlifeThreatBasis)) {
        const repeatedWildlifeHold = reflex.kind === 'move'
          && reflex.wildlifeThreatBasis?.response === 'hold'
          && events.some((event) => event.kind === 'action'
            && event.atMonth === atMonth
            && event.who === person.id
            && event.action.kind === 'move'
            && event.action.wildlifeThreatBasis?.basisKey === reflex.wildlifeThreatBasis?.basisKey);
        if (repeatedWildlifeHold) {
          person.currentActionText = '无安全退路，继续警戒同一可见野兽威胁';
          continue;
        }
        const rootBeforeInterruption = rootIntentForPerson(state, person);
        const fact = executeProtectiveInterruption(state, person, reflex, 'survival-reflex', atMonth, actionTick, events);
        person.currentActionText = fact.result;
        drainInterruptedIntentReturns(state, person, atMonth);
        grantTerminalReplanPermit(execution, person, rootBeforeInterruption);
        continue;
      }
      if (dependentChild) {
        person.currentActionText = awaitingCaregiver
          ? '留在亲代身边，随照料者取水、觅食或进入住所'
          : '停留原地等待亲代照料，不能独自远行';
        continue;
      }
      if (wildlifeShelter || (maintainingShelter && !causalShelterWork)) {
        const rootBeforeInterruption = rootIntentForPerson(state, person);
        recordShelterMaintenanceInterruption(state, person, atMonth, actionTick, events, wildlifeShelter
          ? { reason: '可见猛兽仍在住所近旁，继续留在真实围护内' }
          : {});
        person.currentActionText = wildlifeShelter ? '留在住所内避开可见猛兽' : '留在住所内维持避护状态';
        drainInterruptedIntentReturns(state, person, atMonth);
        grantTerminalReplanPermit(execution, person, rootBeforeInterruption);
        continue;
      }
      if (dependentCare) {
        const rootBeforeInterruption = rootIntentForPerson(state, person);
        const fact = executeDependentCareReflex(state, person, dependentCare, atMonth, actionTick, events);
        person.currentActionText = fact.result;
        drainInterruptedIntentReturns(state, person, atMonth);
        grantTerminalReplanPermit(execution, person, rootBeforeInterruption);
        continue;
      }
      if (person.id === execution.controlledPersonId && actorController) {
        controlRequested = true;
        const control = actorController({ state, person, atMonth, actionTick, events });
        if (control) {
          controlApplied = true;
          executeActorControl(execution, person, actionTick, control);
          continue;
        }
      }

      const rootBeforePlanning = rootIntentForPerson(state, person);
      if (execution.plannedAtTicks.get(person.id) !== actionTick) {
        planLocallyForTick(
          state,
          person,
          atMonth,
          actionTick,
          events,
          execution.tickPlanner,
          execution.reviewedPeople,
          execution,
        );
      }
      // Perceiving that the current shelter is inadequate allows deliberation,
      // not arbitrary departure. Only a shelter project actually selected by
      // that deliberation may spend this protected tick outside; an unrelated
      // intent remains queued until the thermal/wildlife maintenance state
      // clears naturally.
      if (maintainingShelter
        && perceivesShelterAdaptation
        && !continuesShelterAdaptationProject(state, activeIntent(state, person))
        && !continuesImmediateShelterProtection(activeIntent(state, person), person)) {
        const rootBeforeInterruption = rootIntentForPerson(state, person);
        recordShelterMaintenanceInterruption(state, person, atMonth, actionTick, events, wildlifeShelter
          ? { reason: '可见猛兽仍在住所近旁，继续留在真实围护内' }
          : {});
        person.currentActionText = wildlifeShelter ? '留在住所内避开可见猛兽' : '留在住所内维持避护状态';
        drainInterruptedIntentReturns(state, person, atMonth);
        grantTerminalReplanPermit(execution, person, rootBeforeInterruption);
        continue;
      }
      executeIntentStep(execution, person, actionTick, rootBeforePlanning);
    }
  }

  for (const personId of execution.participantIds) {
    const person = personById(state, personId);
    if (person) person.position.tickPath.push(person.position.cellId);
  }
  execution.completedTick = actionTick;
  return {
    actionTick,
    events: events.slice(eventStart),
    controlRequested,
    controlApplied,
  };
}

export function finishMonthExecution(execution: MonthExecution): SimulationState {
  if (execution.finished) return execution.prepared.state;
  if (execution.completedTick !== PLANNING_TICKS_PER_MONTH) {
    throw new Error(`月份只完成 ${execution.completedTick}/${PLANNING_TICKS_PER_MONTH} 个规划刻度`);
  }
  const { state, events, candidates, livingAgents, atMonth } = execution.prepared;
  events.push(...advanceBodies(state, atMonth));
  events.push(...synchronizeMortuaryPerceptions(state, atMonth, events.length));
  events.push(...synchronizeHibernationIntentSuspensions(state, atMonth));
  events.push(...synchronizeAgreementResponseDeadlineSuspensions(state, atMonth, events.length, events));
  events.push(...advanceSharedRelationshipExperience(state, events, atMonth));

  const modelContexts = execution.attempted.total;
  const actualTokens = execution.usage.inputTokens + execution.usage.outputTokens;
  const chargedTokens = modelContexts
    ? Math.max(actualTokens, modelContexts * state.decisionBudget.tokensPerContext)
    : 0;
  const ordinaryChargedTokens = execution.attempted.ordinary
    ? Math.max(
        Math.ceil(actualTokens * execution.attempted.ordinary / Math.max(1, modelContexts)),
        execution.attempted.ordinary * state.decisionBudget.tokensPerContext,
      )
    : 0;
  state.decisionBudget.ledgers = [...currentRollingLedgers(state), {
    atMonth,
    livingAgents,
    candidates: candidates.length,
    modelContexts,
    ordinaryModelContexts: execution.attempted.ordinary,
    exemptModelContexts: execution.attempted.exempt,
    inputTokens: execution.usage.inputTokens,
    outputTokens: execution.usage.outputTokens,
    ...(execution.usage.cacheHitInputTokens !== undefined
      ? { cacheHitInputTokens: execution.usage.cacheHitInputTokens }
      : {}),
    ...(execution.usage.cacheMissInputTokens !== undefined
      ? { cacheMissInputTokens: execution.usage.cacheMissInputTokens }
      : {}),
    chargedTokens,
    ordinaryChargedTokens,
  }].slice(-24);
  state.decisionBudget.credits = clamp(
    state.decisionBudget.credits + livingAgents / ORDINARY_DECISION_PERSON_MONTHS - execution.attempted.ordinary,
    0,
    Math.max(1, livingAgents),
  );
  execution.finished = true;
  const finishedState = finishMonth(
    state,
    events,
    atMonth,
    execution.projectionCadence,
    execution.observationProjector,
  );
  for (const person of finishedState.people) {
    refreshPersonMindMarkdown(finishedState, person, atMonth);
  }
  return finishedState;
}

export function executeRemainingPlanningTicks(
  execution: MonthExecution,
  actorController?: TickActorController,
): SimulationState {
  while (execution.completedTick < PLANNING_TICKS_PER_MONTH) {
    executePlanningTick(execution, actorController);
  }
  return finishMonthExecution(execution);
}
