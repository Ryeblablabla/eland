import { MONTHS_PER_YEAR } from '../../domain/calendar';
import { rollingDecisionUsage } from '../../domain/decision-budget';
import { advanceAgreementLifecycle, synchronizeAgreementResponseDeadlineSuspensions } from '../../domain/agreement';
import { advanceCollectiveLifecycle } from '../../domain/collective';
import { advanceGovernanceLifecycle } from '../../domain/governance';
import { maintainMemories } from '../../domain/memory';
import type {
  BatchDecider,
  DecisionContext,
  DecisionMonthLedger,
  DecisionOpportunityFact,
  EnvironmentFact,
  SimulationState,
  WorldEvent,
} from '../../domain/model';
import {
  advanceEraPredictions,
  advanceHibernationRecoveryPhases,
  advanceWorldProcesses,
  resolveClimate,
  resolveWeather,
} from '../../domain/monthly-processes';
import { advancePermissionLifecycle } from '../../domain/permission';
import { isAlive, isDehydratedHibernating, type PersonId, type PersonState } from '../../domain/person';
import { consolidatePersonality } from '../../domain/personality';
import { deriveObservations, deriveStructures, updateDevelopmentObservation } from '../../projection/derived-observations';
import { seededFraction } from '../../world/generator';
import { advanceProjects } from '../project-options';
import { decisionBudgetExemption, decisionProbability } from './model-review';
import { drainInterruptedIntentReturns } from './intent-execution';
import { copyState } from './state-utils';
import { buildDecisionContexts } from './tick-planner';

export interface PreparedMonth {
  state: SimulationState;
  events: WorldEvent[];
  contexts: DecisionContext[];
  candidates: DecisionContext[];
  naturallyTriggeredPeople: Set<PersonId>;
  livingAgents: number;
  atMonth: number;
}

function stateGoalReviewDue(context: DecisionContext, atMonth: number): boolean {
  return context.activeIntent?.stateGoalUntilMonth !== undefined
    && atMonth > context.activeIntent.stateGoalUntilMonth;
}

export function currentRollingLedgers(state: SimulationState): DecisionMonthLedger[] {
  return rollingDecisionUsage(state.decisionBudget.ledgers, state.clock.elapsedMonths);
}

export function prepareMonth(
  input: SimulationState,
  cloneInput = true,
  collectEnhancementCandidates = true,
  forceReview?: BatchDecider['forceReview'],
): PreparedMonth {
  const state = cloneInput ? copyState(input) : input;
  const naturallyTriggeredPeople = new Set<PersonId>();
  if (state.civilization.status === 'ended') return {
    state,
    events: [],
    contexts: [],
    candidates: [],
    naturallyTriggeredPeople,
    livingAgents: state.people.filter(isAlive).length,
    atMonth: state.clock.elapsedMonths,
  };
  const atMonth = state.clock.elapsedMonths + 1;
  for (const person of state.people.filter(isAlive)) {
    person.position.previousCellId = person.position.cellId;
    person.position.previousZ = person.position.z;
    person.position.lastPath = [person.position.cellId];
    person.position.tickPath = [person.position.cellId];
  }
  const climateEvents = resolveClimate(state, atMonth);
  const eraTransition = climateEvents.some((candidate) => candidate.diff.eraTransition === true);
  const hibernationPhaseEvents = advanceHibernationRecoveryPhases(state, atMonth);
  const events: WorldEvent[] = [
    ...climateEvents,
    ...hibernationPhaseEvents,
    ...advanceEraPredictions(state, atMonth, eraTransition),
    ...resolveWeather(state, atMonth),
    ...advanceWorldProcesses(state, atMonth),
  ];
  events.push(...synchronizeAgreementResponseDeadlineSuspensions(state, atMonth, events.length, events));
  events.push(...advanceAgreementLifecycle(state, atMonth, events.length));
  events.push(...advancePermissionLifecycle(state, atMonth, events.length));
  maintainMemories(state, atMonth);
  const exitedHibernationPersonIds = new Set(hibernationPhaseEvents
    .filter((event) => event.diff.exited === true)
    .map((event) => event.who));
  for (const person of state.people.filter((candidate) => isAlive(candidate)
    && exitedHibernationPersonIds.has(candidate.id))) {
    drainInterruptedIntentReturns(state, person, atMonth);
  }
  const livingAgents = state.people.filter(isAlive).length;
  if (!collectEnhancementCandidates) {
    return {
      state,
      events,
      contexts: [],
      candidates: [],
      naturallyTriggeredPeople,
      livingAgents,
      atMonth,
    };
  }
  const contexts = buildDecisionContexts(state, atMonth);
  const candidates: DecisionContext[] = [];
  for (const context of contexts) {
    const { probability, reasons } = decisionProbability(state, context, atMonth);
    const sample = seededFraction(state.seed, `decision:${state.branchId}:${atMonth}:${context.person.id}`);
    const exemption = decisionBudgetExemption(context, atMonth);
    const interactionReview = Boolean(forceReview?.(context, atMonth));
    const reviewDue = stateGoalReviewDue(context, atMonth);
    if (exemption === 'bootstrap') reasons.push('开局批量初始决策');
    else if (exemption === 'emergency') reasons.push('紧急状态需要立即重评');
    else if (exemption === 'required-response') reasons.push('必须回应一项社会请求');
    else if (exemption === 'fulfillment') reasons.push('已有承诺或职责等待履行');
    if (interactionReview) reasons.push('本人准备落实对话中已经定下的下一步');
    if (reviewDue) reasons.push('持续状态目标到达复核月份');
    const naturallyMeaningful = !context.activeIntent
      || exemption !== null
      || reviewDue
      || (context.activeIntent && atMonth - context.activeIntent.lastProgressAtMonth >= 2);
    const naturallyTriggered = naturallyMeaningful && (exemption !== null || reviewDue || sample < probability);
    const triggered = interactionReview || naturallyTriggered;
    const opportunity: DecisionOpportunityFact = {
      id: `e-${atMonth}-opportunity-${context.person.id}`,
      kind: 'decision-opportunity', atMonth, orderInMonth: events.length, planningTick: 0, orderInTick: events.length,
      who: context.person.id, cellId: context.person.position.cellId,
      probability, sample, triggered, reasons,
      result: triggered
        ? interactionReview
          ? `${context.person.name}本月准备落实对话中定下的下一步`
          : exemption === 'bootstrap'
          ? `${context.person.name}获得开局初始决策`
          : exemption === 'required-response'
            ? `${context.person.name}本月必须回应一项社会请求`
            : `${context.person.name}本月重新考虑下一步`
        : `${context.person.name}本月延续已有意图`,
    };
    events.push(opportunity);
    if (triggered) {
      candidates.push(context);
      if (naturallyTriggered) naturallyTriggeredPeople.add(context.person.id);
    }
  }
  return { state, events, contexts, candidates, naturallyTriggeredPeople, livingAgents, atMonth };
}

function observedCapabilityCount(state: SimulationState): number {
  return new Set(state.derived.milestones.map((milestone) => (
    Number.isInteger(milestone.capabilityId) ? `capability:${milestone.capabilityId}` : `legacy:${milestone.id}`
  ))).size;
}

/**
 * 只从末月已经提交的身体、状态和气候事实归纳文明毁灭原因。
 * 这是结局投影，不参与人物选择，也不改变任何生存结算。
 */
function destructionOutcome(
  state: SimulationState,
  atMonth: number,
  events: WorldEvent[],
): { cause: string; summary: string } {
  const terminalPeople = state.people.filter((person) => person.diedAtMonth === atMonth);
  const observedPeople = terminalPeople.length ? terminalPeople : state.people;
  const conditionStage = (person: PersonState, kind: string) =>
    person.conditions.find((condition) => condition.kind === kind)?.stage ?? 0;
  const count = (predicate: (person: PersonState) => boolean) => observedPeople.filter(predicate).length;
  const deathFacts = events.filter((event): event is EnvironmentFact =>
    event.kind === 'environment' && event.change === 'death');
  const agingTerminalDeaths = deathFacts.filter((event) => event.diff.cause === 'aging-terminal').length;

  const candidates = [
    {
      cause: '烈焰',
      score: state.civilization.climate.kind === 'fire'
        ? count((person) => conditionStage(person, 'heat') >= 2) * 4
        : 0,
    },
    {
      cause: '酷暑',
      score: state.civilization.climate.kind === 'heat'
        ? count((person) => conditionStage(person, 'heat') >= 3) * 3
        : 0,
    },
    {
      cause: '严寒',
      score: state.civilization.climate.kind === 'cold'
        ? count((person) => conditionStage(person, 'cold') >= 3) * 3
        : 0,
    },
    { cause: '缺水', score: count((person) => person.body.hydration < 10) * 2 },
    { cause: '饥荒', score: count((person) => person.body.nutrition < 10) * 2 },
    { cause: '疾病', score: count((person) => conditionStage(person, 'illness') >= 2) * 2 },
    { cause: '伤病', score: count((person) => conditionStage(person, 'wound') >= 2) * 2 },
    { cause: '衰老', score: agingTerminalDeaths * 2 },
  ].sort((left, right) => right.score - left.score);
  const cause = candidates[0]?.score > 0 ? candidates[0].cause : '身体衰竭';
  const lastLives = Math.max(1, terminalPeople.length);
  return {
    cause,
    summary: `文明最后的 ${lastLives} 个生命在第 ${atMonth} 月因${cause}终止，没有留下生还者。`,
  };
}

export function finishMonth(
  state: SimulationState,
  events: WorldEvent[],
  atMonth: number,
  projectionCadence: 'monthly' | 'annual',
): SimulationState {
  const orderByTick = new Map<number, number>();
  events.forEach((event, index) => {
    const planningTick = event.planningTick ?? (event.kind === 'action' ? event.actionTick : 0);
    const orderInTick = orderByTick.get(planningTick) ?? 0;
    event.orderInMonth = index;
    event.planningTick = planningTick;
    event.orderInTick = orderInTick;
    orderByTick.set(planningTick, orderInTick + 1);
  });
  state.clock.elapsedMonths = atMonth;
  state.world.past.push(...events);
  consolidatePersonality(state, atMonth);
  advanceProjects(state, atMonth);
  advanceCollectiveLifecycle(state, atMonth);
  advanceGovernanceLifecycle(state, atMonth);
  state.lastStep = events;
  state.world.drops = state.world.drops.filter((drop) => drop.quantity > 0);
  const living = state.people.filter(isAlive);
  const allLivingHibernating = living.length > 0 && living.every(isDehydratedHibernating);
  const endpointReached = state.civilization.conditions.endpoint.kind === 'months'
    && atMonth >= state.civilization.conditions.endpoint.value;
  const fullProjection = projectionCadence === 'monthly'
    || state.civilization.conditions.endpoint.kind === 'milestones'
    || atMonth % MONTHS_PER_YEAR === 0
    || endpointReached
    || living.length === 0
    || allLivingHibernating;
  state.derived = fullProjection
    ? deriveObservations(state)
    : { ...state.derived, structures: deriveStructures(state) };
  if (fullProjection) updateDevelopmentObservation(state);
  if (!living.length) {
    const ending = destructionOutcome(state, atMonth, events);
    state.civilization.status = 'ended';
    state.civilization.outcome = { kind: 'destroyed', ...ending, atMonth };
  } else if (state.civilization.conditions.endpoint.kind === 'months' && atMonth >= state.civilization.conditions.endpoint.value) {
    state.civilization.status = 'ended';
    state.civilization.outcome = { kind: 'boundary', cause: '达到模拟月数', atMonth, summary: `文明演化至第 ${atMonth} 月。` };
  } else if (state.civilization.conditions.endpoint.kind === 'milestones'
    && observedCapabilityCount(state) >= state.civilization.conditions.endpoint.value) {
    const capabilities = observedCapabilityCount(state);
    state.civilization.status = 'ended';
    state.civilization.outcome = {
      kind: 'milestones', cause: '达到能力坐标数量', atMonth,
      summary: `文明观察到 ${capabilities} 个不同能力坐标、${state.derived.milestones.length} 个阶段或复杂性里程碑。`,
    };
  }
  return state;
}
