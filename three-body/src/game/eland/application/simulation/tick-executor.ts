import { executePrimitiveAction } from '../../domain/action-executor';
import { synchronizeAgreementResponseDeadlineSuspensions } from '../../domain/agreement';
import { PLANNING_TICKS_PER_MONTH } from '../../domain/calendar';
import {
  availableModelContexts,
  availableModelTokens,
  ORDINARY_DECISION_PERSON_MONTHS,
} from '../../domain/decision-budget';
import { chooseDependentCareReflex, dependentCareUrgency, shouldRemainShelteredForDependent } from '../../domain/dependent-care';
import { lifePlanningStage } from '../../domain/life-stage';
import { synchronizeMortuaryPerceptions } from '../../domain/mortuary';
import type {
  AgentDecider,
  BatchDecider,
  Decision,
  DecisionContext,
  SimulationState,
  TokenUsage,
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
} from '../../domain/person';
import { personById } from '../../domain/state-index';
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
import { isProductionOption, RulePlanner } from '../rule-planner';
import {
  activeIntent,
  applyDecision,
  executeActiveIntent,
  executeDependentCareReflex,
  executeProtectiveInterruption,
  recordShelterMaintenanceInterruption,
  resolveInterruptedIntentReturn,
} from './intent-execution';
import {
  decisionBudgetExemption,
  decisionUrgency,
  hasUnfinishedProductionIntent,
  lastModelDecisionMonth,
  validateModelDecision,
} from './model-review';
import { currentRollingLedgers, finishMonth, prepareMonth, type PreparedMonth } from './month-boundary';
import type { ObservationProjector } from './observation-projector';
import { clamp } from './state-utils';
import { hasCoLocatedLivingParent, planLocallyForTick } from './tick-planner';

interface ModelAttemptSummary {
  total: number;
  ordinary: number;
  exempt: number;
}

const authoritativeRulePlanner = new RulePlanner();

function executePrepared(
  observationProjector: ObservationProjector,
  prepared: PreparedMonth,
  decisions: Map<PersonId, { decision: Decision; usedModel: boolean }>,
  usage: TokenUsage,
  attempted: ModelAttemptSummary,
  tickPlanner: AgentDecider = authoritativeRulePlanner,
  projectionCadence: 'monthly' | 'annual' = 'monthly',
): SimulationState {
  const { state, events, candidates, livingAgents, atMonth } = prepared;
  if (state.civilization.status === 'ended') return state;
  const reviewedPeople = new Set<PersonId>();
  const plannedAtTickOne = new Set<PersonId>();
  for (const candidate of candidates) {
    const person = personById(state, candidate.person.id);
    if (!person || !isAlive(person)) continue;
    const freshContext = buildDecisionContext(state, person, atMonth);
    const picked = decisions.get(person.id);
    if (!picked || picked.decision.kind === 'idle') continue;
    events.push(applyDecision(state, person, freshContext, picked.decision, picked.usedModel, atMonth, events.length, 1));
    plannedAtTickOne.add(person.id);
    reviewedPeople.add(person.id);
  }
  const participants = state.people.filter(isAlive);
  for (let actionTick = 1; actionTick <= PLANNING_TICKS_PER_MONTH; actionTick += 1) {
    const order = [...participants]
      .filter(isAlive)
      .sort((a, b) => seededFraction(state.seed, `action-order:${state.branchId}:${atMonth}:${actionTick}:${a.id}`) - seededFraction(state.seed, `action-order:${state.branchId}:${atMonth}:${actionTick}:${b.id}`) || a.id.localeCompare(b.id));
    for (const person of order) {
      if (isDormantDehydratedHibernating(person)) {
        person.currentActionText = '处于脱水休眠，以极低代谢等待环境稳定';
        continue;
      }
      if (isRecoveringFromDehydratedHibernation(person)) {
        const recovery = chooseHibernationRecoveryReflex(state, person);
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
      const causalShelterWork = hasCausalShelterAdaptationNeed(state, person);
      const reflex = chooseSurvivalReflex(state, person, { suppressThermalShelter: causalShelterWork });
      const queuedIntent = activeIntent(state, person);
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
        : chooseDependentCareReflex(state, person, { suppressThermalShelter: causalShelterWork });
      const careIsMoreUrgent = Boolean(dependentCare)
        && (!reflex || dependentCareUrgency(state, person) > survivalReflexUrgency(state, person));
      if (careIsMoreUrgent && dependentCare) {
        const fact = executeDependentCareReflex(state, person, dependentCare, atMonth, actionTick, events);
        person.currentActionText = fact.result;
        continue;
      }
      if (reflexDuplicatesQueuedDehydrate) {
        const fact = executeActiveIntent(state, person, atMonth, events.length, actionTick, events);
        if (fact) events.push(fact);
        resolveInterruptedIntentReturn(state, person, atMonth);
        continue;
      }
      if (reflex && !(dependentChild && reflex.kind === 'move' && !reflex.wildlifeThreatBasis)) {
        const fact = executeProtectiveInterruption(state, person, reflex, 'survival-reflex', atMonth, actionTick, events);
        person.currentActionText = fact.result;
        continue;
      }
      if (dependentChild) {
        person.currentActionText = awaitingCaregiver
          ? '留在亲代身边，随照料者取水、觅食或进入住所'
          : '停留原地等待亲代照料，不能独自远行';
        continue;
      }
      if (dependentCare) {
        const fact = executeDependentCareReflex(state, person, dependentCare, atMonth, actionTick, events);
        person.currentActionText = fact.result;
        continue;
      }
      const wildlifeShelter = shouldRemainShelteredFromWildlifeThreat(state, person, atMonth);
      const maintainingShelter = wildlifeShelter
        || shouldRemainSheltered(state, person)
        || shouldRemainShelteredForDependent(state, person);
      if (maintainingShelter && !causalShelterWork) {
        recordShelterMaintenanceInterruption(state, person, atMonth, actionTick, events, wildlifeShelter
          ? { reason: '可见猛兽仍在住所近旁，继续留在真实围护内' }
          : {});
        person.currentActionText = wildlifeShelter ? '留在住所内避开可见猛兽' : '留在住所内维持避护状态';
        continue;
      }
      if (actionTick !== 1 || !plannedAtTickOne.has(person.id)) {
        planLocallyForTick(state, person, atMonth, actionTick, events, tickPlanner, reviewedPeople);
      }
      const fact = executeActiveIntent(state, person, atMonth, events.length, actionTick, events);
      if (fact) events.push(fact);
      resolveInterruptedIntentReturn(state, person, atMonth);
    }
    for (const person of participants) person.position.tickPath.push(person.position.cellId);
  }
  events.push(...advanceBodies(state, atMonth));
  events.push(...synchronizeMortuaryPerceptions(state, atMonth, events.length));
  events.push(...synchronizeHibernationIntentSuspensions(state, atMonth));
  events.push(...synchronizeAgreementResponseDeadlineSuspensions(state, atMonth, events.length, events));
  events.push(...advanceSharedRelationshipExperience(state, events, atMonth));
  const modelContexts = attempted.total;
  const actualTokens = usage.inputTokens + usage.outputTokens;
  const chargedTokens = modelContexts ? Math.max(usage.inputTokens + usage.outputTokens, modelContexts * state.decisionBudget.tokensPerContext) : 0;
  const ordinaryChargedTokens = attempted.ordinary
    ? Math.max(
      Math.ceil(actualTokens * attempted.ordinary / Math.max(1, modelContexts)),
      attempted.ordinary * state.decisionBudget.tokensPerContext,
    )
    : 0;
  state.decisionBudget.ledgers = [...currentRollingLedgers(state), {
    atMonth,
    livingAgents,
    candidates: candidates.length,
    modelContexts,
    ordinaryModelContexts: attempted.ordinary,
    exemptModelContexts: attempted.exempt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    chargedTokens,
    ordinaryChargedTokens,
  }].slice(-24);
  state.decisionBudget.credits = clamp(
    state.decisionBudget.credits + livingAgents / ORDINARY_DECISION_PERSON_MONTHS - attempted.ordinary,
    0,
    Math.max(1, livingAgents),
  );
  return finishMonth(state, events, atMonth, projectionCadence, observationProjector);
}

export function stepSimulation(
  observationProjector: ObservationProjector,
  input: SimulationState,
  decider: AgentDecider = authoritativeRulePlanner,
): SimulationState {
  const prepared = prepareMonth(input);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) decisions.set(context.person.id, { decision: decider.decide(context), usedModel: false });
  return executePrepared(
    observationProjector,
    prepared,
    decisions,
    { inputTokens: 0, outputTokens: 0 },
    { total: 0, ordinary: 0, exempt: 0 },
    decider,
    'monthly',
  );
}

export function stepOwnedSimulation(
  observationProjector: ObservationProjector,
  input: SimulationState,
): SimulationState {
  const prepared = prepareMonth(input, false, false);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) {
    decisions.set(context.person.id, {
      decision: authoritativeRulePlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 }),
      usedModel: false,
    });
  }
  return executePrepared(
    observationProjector,
    prepared,
    decisions,
    { inputTokens: 0, outputTokens: 0 },
    { total: 0, ordinary: 0, exempt: 0 },
    authoritativeRulePlanner,
    'annual',
  );
}

async function executeSimulationAsync(
  observationProjector: ObservationProjector,
  input: SimulationState,
  batch: BatchDecider,
  cloneInput: boolean,
): Promise<SimulationState> {
  const prepared = prepareMonth(input, cloneInput, true, batch.forceReview);
  const living = prepared.contexts.length;
  const rolling = currentRollingLedgers(prepared.state);
  const eligibleCandidates = batch.shouldDecide
    ? prepared.candidates.filter((context) => batch.shouldDecide?.(context, prepared.atMonth))
    : prepared.candidates;
  const isExempt = (context: DecisionContext) => decisionBudgetExemption(context, prepared.atMonth) !== null
    || Boolean(batch.isBudgetExempt?.(context, prepared.atMonth));
  const exemptContexts = eligibleCandidates.filter(isExempt);
  const ordinaryCandidates = eligibleCandidates.filter((context) => !isExempt(context));
  const ordinaryCapacity = Math.min(
    ordinaryCandidates.length,
    Math.floor(prepared.state.decisionBudget.credits + living / ORDINARY_DECISION_PERSON_MONTHS),
    availableModelContexts(rolling, living),
    Math.floor(availableModelTokens(rolling, living, prepared.state.decisionBudget.tokensPerContext) / prepared.state.decisionBudget.tokensPerContext),
  );
  const importance = (context: DecisionContext) => {
    const exemption = decisionBudgetExemption(context, prepared.atMonth);
    const interactionReview = Boolean(batch.forceReview?.(context, prepared.atMonth));
    let score = interactionReview
      ? 2_800
      : exemption === 'bootstrap'
      ? 3_000
      : exemption === 'emergency'
        ? 2_900
        : exemption === 'required-response'
          ? 2_700
          : exemption === 'fulfillment'
            ? 2_500
            : !context.activeIntent
              ? 1_800 + (context.options.some(isProductionOption) ? 240 : 0)
              : hasUnfinishedProductionIntent(context)
                ? 1_700
                : context.activeIntent.domain === 'strategic'
                  ? 900
                  : 350;
    const lastDecisionMonth = lastModelDecisionMonth(prepared.state, context.person.id);
    if (lastDecisionMonth !== null && exemption === null) {
      const monthsSince = prepared.atMonth - lastDecisionMonth;
      score -= Math.max(0, 6 - monthsSince) * 60;
    }
    return score;
  };
  const rank = (contexts: DecisionContext[]) => [...contexts]
    .sort((a, b) => importance(b) - importance(a) || decisionUrgency(b) - decisionUrgency(a) || a.person.id.localeCompare(b.person.id));
  const ordinaryContexts = rank(ordinaryCandidates).slice(0, ordinaryCapacity);
  const modelContexts = rank([...exemptContexts, ...ordinaryContexts]);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) {
    const naturalFallback = prepared.naturallyTriggeredPeople.has(context.person.id);
    decisions.set(context.person.id, {
      decision: naturalFallback
        ? authoritativeRulePlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 })
        : { kind: 'idle', reason: '对话中定下的下一步没有通过当前本地条件复核' },
      usedModel: false,
    });
  }
  let modelDecisions: (Decision | null)[] = [];
  try {
    modelDecisions = modelContexts.length ? await batch.decideAll(modelContexts) : [];
  } catch {
    // The transitional foreground model path may fail, but the authoritative
    // rule plan above still commits the month.
    modelDecisions = [];
  }
  modelContexts.forEach((context, index) => {
    const proposed = modelDecisions[index];
    const localDecision = decisions.get(context.person.id)?.decision;
    const decision = proposed && localDecision ? validateModelDecision(context, proposed, localDecision) : null;
    if (decision) decisions.set(context.person.id, { decision, usedModel: true });
  });
  const metadata = batch.takeMetadata?.() ?? null;
  const result = executePrepared(
    observationProjector,
    prepared,
    decisions,
    batch.takeUsage?.() ?? { inputTokens: 0, outputTokens: 0 },
    { total: modelContexts.length, ordinary: ordinaryContexts.length, exempt: exemptContexts.length },
    authoritativeRulePlanner,
    'monthly',
  );
  const ledger = result.decisionBudget.ledgers.at(-1);
  if (metadata && ledger?.modelContexts) {
    ledger.modelEndpointId = metadata.endpointId;
    ledger.modelProtocol = metadata.protocol;
    ledger.modelName = metadata.model;
  }
  return result;
}

export function stepSimulationAsync(
  observationProjector: ObservationProjector,
  input: SimulationState,
  batch: BatchDecider,
): Promise<SimulationState> {
  return executeSimulationAsync(observationProjector, input, batch, true);
}

/** Trusted controller path: `input` is already an isolated working copy. */
export function stepOwnedSimulationAsync(
  observationProjector: ObservationProjector,
  input: SimulationState,
  batch: BatchDecider,
): Promise<SimulationState> {
  return executeSimulationAsync(observationProjector, input, batch, false);
}
