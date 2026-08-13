import { CHARACTER_PROFILES, type CharacterProfile } from '../character-profiles';
import {
  createBiologicalSex,
  createFounderAgeMonths,
  createLifespanMonths,
  deterministicFraction,
} from '../population';
import { MONTHS_PER_YEAR, RULE_ACTION_TICKS_PER_MONTH } from '../domain/calendar';
import { availableModelContexts, availableModelTokens, rollingDecisionUsage } from '../domain/decision-budget';
import { executeIntentAction, executePrimitiveAction, goalSatisfied, addDrop } from '../domain/action-executor';
import { advanceBodies, advanceWorldProcesses, resolveClimate } from '../domain/monthly-processes';
import { Material, materialDefinition } from '../domain/material';
import { ageMonths, isAlive, type PersonId, type PersonState } from '../domain/person';
import type {
  AgentDecider,
  BatchDecider,
  ClimateKind,
  Decision,
  DecisionContext,
  DecisionFact,
  DecisionMonthLedger,
  DecisionOpportunityFact,
  DerivedStructure,
  EmergentRegion,
  EnvironmentEventInput,
  EnvironmentFact,
  EpochKind,
  EvolutionReport,
  Intent,
  MilestoneObservation,
  PracticeObservation,
  SimulationConfig,
  SimulationState,
  TokenUsage,
  WorldEvent,
} from '../domain/model';
import { buildDecisionContext, recompileNextAction } from './action-options';
import { acceptedExchangeFor, exchangeTermFulfilled } from '../domain/social-facts';
import { maintainMemories, remember } from '../domain/memory';
import { composeIntentChoice } from '../domain/intent';
import { chooseSurvivalReflex } from '../domain/survival-reflex';
import { chooseDependentCareReflex } from '../domain/dependent-care';
import { observeCoreMilestones } from '../projection/core-milestones';
import { advanceAgreementLifecycle } from '../domain/agreement';
import { compileAgreementContinuations, type AgreementContinuation } from './agreement-continuation';
import {
  WORLD_CELL_COUNT,
  WORLD_LEVELS,
  cellX,
  cellY,
  copyWorld,
  hydrateWorld,
  isCellId,
  surfaceMaterial,
  voxelAt,
} from '../world/grid';
import { generateVoxelWorld, seededFraction } from '../world/generator';

export * from '../domain/model';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function copyState(input: SimulationState): SimulationState {
  const copy = structuredClone(input);
  copy.world.grid = copyWorld(input.world.grid);
  return copy;
}

function chooseProfiles(seed: number, civilizationNo: number, characterIds?: string[]): CharacterProfile[] {
  if (characterIds?.length) {
    const wanted = new Set(characterIds);
    const chosen = CHARACTER_PROFILES.filter((profile) => wanted.has(profile.id));
    if (chosen.length) return chosen.slice(0, 10);
  }
  return [...CHARACTER_PROFILES]
    .sort((a, b) => deterministicFraction(seed + civilizationNo * 991, `profile:${a.id}`) - deterministicFraction(seed + civilizationNo * 991, `profile:${b.id}`))
    .slice(0, 5 + Math.floor(deterministicFraction(seed, `population:${civilizationNo}`) * 4));
}

export function createDefaultSimulationConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    civilizationNo: Math.max(1, Math.round(overrides.civilizationNo ?? 1)),
    climateBias: overrides.climateBias === 'cold' || overrides.climateBias === 'hot' ? overrides.climateBias : 'balanced',
    chaosIntensity: clamp(Math.round(overrides.chaosIntensity ?? 0), 0, 10),
    endpoint: {
      kind: overrides.endpoint?.kind === 'milestones' ? 'milestones' : 'months',
      value: Math.max(1, Math.round(overrides.endpoint?.value ?? 1200)),
    },
    ...(overrides.characterIds?.length ? { characterIds: [...new Set(overrides.characterIds)].slice(0, 10) } : {}),
  };
}

function initialPerson(seed: number, profile: CharacterProfile, spawnCell: number, profiles: CharacterProfile[]): PersonState {
  const founderAge = createFounderAgeMonths(seed, profile.id);
  const capacity = (key: string, floor: number, span: number) => floor + Math.floor(deterministicFraction(seed, `${key}:${profile.id}`) * span);
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    profile: { description: profile.description },
    bornAtMonth: -founderAge,
    lifespanMonths: createLifespanMonths(seed, profile.id, founderAge),
    sex: createBiologicalSex(seed, profile.id),
    geneticParents: [],
    generation: 0,
    position: { cellId: spawnCell, previousCellId: spawnCell, lastPath: [spawnCell], tickPath: [spawnCell] },
    body: { health: 92, hydration: 82, nutrition: 78 },
    baselineCapacities: {
      locomotion: capacity('locomotion', 48, 35),
      manipulation: capacity('manipulation', 45, 35),
      perception: capacity('perception', 42, 40),
      communication: capacity('communication', 42, 40),
      cognition: capacity('cognition', 42, 40),
    },
    driveBias: {
      affiliation: capacity('affiliation', 35, 55),
      autonomy: capacity('autonomy', 35, 55),
      recognition: capacity('recognition', 35, 55),
      inquiryCreation: capacity('inquiry', 35, 55),
    },
    conditions: [],
    inventory: [{ id: `stack-${profile.id}-ration`, materialId: Material.Food, quantity: 2, sourceEventIds: [] }],
    knowledge: [],
    memories: [],
    relations: profiles.filter((other) => other.id !== profile.id).map((other) => ({
      personId: other.id,
      trust: 0,
      bond: 0,
      fear: 0,
      sourceEventIds: [],
    })),
    currentActionText: '观察身边的物质',
    lastDecisionText: '尚未作出关键决定',
  };
}

export function createInitialState(seed = 17, inputConfig: Partial<SimulationConfig> = {}): SimulationState {
  const config = createDefaultSimulationConfig(inputConfig);
  const generated = generateVoxelWorld(seed);
  const profiles = chooseProfiles(seed, config.civilizationNo, config.characterIds);
  const people = profiles.map((profile, index) => initialPerson(seed + config.civilizationNo * 997, profile, generated.spawnCells[index] ?? generated.spawnCells[0], profiles));
  return {
    schemaVersion: 14,
    seed,
    branchId: `root-${seed}-${config.civilizationNo}`,
    clock: { unit: 'month', elapsedMonths: 0, monthsPerYear: MONTHS_PER_YEAR },
    world: { grid: generated.world, drops: generated.drops, past: [] },
    people,
    intents: [],
    agreements: [],
    civilization: {
      number: config.civilizationNo,
      status: 'running',
      stage: '自然群体',
      epoch: 'stable',
      climate: { kind: 'temperate', severity: 1, sinceMonth: 0 },
      conditions: config,
      integrity: 100,
    },
    decisionBudget: { credits: 0, tokensPerContext: 8_000, ledgers: [] },
    derived: { practices: [], institutions: [], milestones: [], regions: [], structures: [] },
    lastStep: [],
  };
}

function personCanDecide(state: SimulationState, person: PersonState): boolean {
  return ageMonths(person, state.clock.elapsedMonths) >= 12 * 12 && isAlive(person);
}

export function buildDecisionContexts(state: SimulationState): DecisionContext[] {
  return state.people.filter(isAlive).map((person) => {
    const context = buildDecisionContext(state, person);
    return personCanDecide(state, person) ? context : { ...context, options: [] };
  });
}

function urgency(context: DecisionContext): number {
  const person = context.person;
  return Math.max(100 - person.body.health, 100 - person.body.hydration, 100 - person.body.nutrition);
}

function hasRequiredSocialResponse(context: DecisionContext): boolean {
  return context.options.some((option) => /^(accept|reject)-(assist|companion|exchange|reproduce):/.test(option.id));
}

function lastModelDecisionMonth(state: SimulationState, personId: PersonId): number | null {
  for (let index = state.world.past.length - 1; index >= 0; index -= 1) {
    const event = state.world.past[index];
    if (event.kind === 'decision' && event.usedModel && event.who === personId) return event.atMonth;
  }
  return null;
}

function unconsideredExposureEscalation(state: SimulationState, person: PersonState): boolean {
  const lastDecision = lastModelDecisionMonth(state, person.id) ?? -1;
  return state.world.past.some((event) => event.kind === 'environment'
    && event.who === person.id
    && event.change === 'condition'
    && (event.diff.condition === 'cold' || event.diff.condition === 'heat')
    && event.diff.exited !== true
    && Number(event.diff.stage) >= 2
    // Body conditions are settled after that month's model decision, so an
    // escalation stamped in the same month has not yet been considered.
    && event.atMonth >= lastDecision);
}

function optionScore(context: DecisionContext, optionId: string): number {
  const option = [...context.options, ...context.followUpOptions].find((candidate) => candidate.id === optionId);
  if (!option) return -999;
  const person = context.person;
  let score = seededFraction(context.state.seed, `option-score:${context.state.clock.elapsedMonths}:${person.id}:${option.id}`) * 8;
  if (option.id.startsWith('drink:')) score += 110 - person.body.hydration;
  if (option.id.startsWith('eat:')) score += 105 - person.body.nutrition;
  if (option.id.startsWith('collect:')) {
    const materialId = option.goal.kind === 'inventory-at-least' ? option.goal.materialId : Material.Air;
    score += materialId === Material.Food ? 72 - person.body.nutrition : materialId === Material.Seed ? 18 : materialId === Material.Wood ? 25 : 10;
  }
  if (option.id.startsWith('harvest:')) score += 66 - person.body.nutrition;
  if (option.id.startsWith('try-combine:')) score += person.driveBias.inquiryCreation * 0.3;
  if (option.id.startsWith('repeat-combine:')) score += 36 + person.driveBias.inquiryCreation * 0.08;
  if (option.id.startsWith('try-inventory-combine:')) score += person.driveBias.inquiryCreation * 0.28;
  if (option.id.startsWith('repeat-inventory-combine:')) score += 32 + person.driveBias.inquiryCreation * 0.08;
  if (option.id.startsWith('build:')) score += 22 + (context.state.civilization.climate.kind === 'cold' || context.state.civilization.climate.kind === 'heat' ? 28 : 0);
  if (option.id.startsWith('share:')) score += person.driveBias.affiliation * 0.45;
  if (option.id.startsWith('care:')) score += 48 + person.driveBias.affiliation * 0.4;
  if (option.id.startsWith('accept-reproduce:')) score += 54 + person.driveBias.affiliation * 0.35;
  if (option.id.startsWith('offer-reproduce:')) score += 26 + person.driveBias.affiliation * 0.25;
  if (option.id.startsWith('reproduce:')) score += 58 + person.driveBias.affiliation * 0.35;
  if (option.id.startsWith('take-without-permission:')) score += person.body.nutrition < 12 ? 95 : 42;
  if (option.id.startsWith('exert-person:')) score += 36;
  if (option.id.startsWith('accept-exchange:')) score += 44;
  if (option.id.startsWith('settle-exchange:')) score += 82;
  if (option.id.startsWith('offer-exchange:')) score += 25;
  if (option.id.startsWith('teach:')) score += 25 + person.driveBias.affiliation * 0.25;
  if (option.id.startsWith('attend:')) score += person.driveBias.inquiryCreation * 0.32;
  if (option.id.startsWith('explore:')) score += person.driveBias.inquiryCreation * 0.18;
  return score;
}

export class MockDecider implements AgentDecider {
  decide(context: DecisionContext): Decision {
    const active = context.activeIntent;
    const person = context.person;
    const best = [...context.options].sort((a, b) => optionScore(context, b.id) - optionScore(context, a.id) || a.id.localeCompare(b.id))[0];
    const followUp = best?.requiresFollowUp
      ? [...context.followUpOptions].sort((a, b) => optionScore(context, b.id) - optionScore(context, a.id) || a.id.localeCompare(b.id))[0]
      : undefined;
    if (active) {
      const emergency = person.body.hydration < 28 || person.body.nutrition < 28;
      if (emergency && best && (best.id.startsWith('drink:') || best.id.startsWith('eat:') || best.id.includes(`:${Material.Food}`))) {
        return { kind: 'revise', intentId: active.id, optionId: best.id, ...(followUp ? { followUpOptionId: followUp.id } : {}), reason: '身体储备已压过原有长期意图' };
      }
      return best ? { kind: 'revise', intentId: active.id, optionId: best.id, ...(followUp ? { followUpOptionId: followUp.id } : {}), reason: '出现了比当前意图更重要的新机会' } : { kind: 'idle', reason: '已有意图由行动引擎继续推进' };
    }
    return best ? { kind: 'start', optionId: best.id, ...(followUp ? { followUpOptionId: followUp.id } : {}), reason: best.reason } : { kind: 'idle', reason: personCanDecide(context.state, person) ? '眼前没有值得改变安排的新机会' : '当前年龄尚不能独立行动' };
  }
}

function decisionProbability(state: SimulationState, context: DecisionContext): { probability: number; reasons: string[] } {
  const person = context.person;
  const reasons: string[] = [];
  let probability = personCanDecide(state, person) ? 0.045 : 0.01;
  if (!context.activeIntent) { probability += 0.32; reasons.push('没有战略或社会意图'); }
  if (!context.activeIntent && context.options.some((option) => option.domain === 'social')) { probability += 0.16; reasons.push('空闲时出现社会互动机会'); }
  if (context.activeIntent && state.clock.elapsedMonths - context.activeIntent.lastProgressAtMonth >= 2) { probability += 0.35; reasons.push('意图停滞'); }
  if (unconsideredExposureEscalation(state, person)) {
    probability += 0.72;
    reasons.push('寒冷或炎热已经进入新的危险阶段，需要重评长期手段');
  }
  const acceptedExchange = acceptedExchangeFor(state, person.id, state.clock.elapsedMonths);
  if (acceptedExchange && !exchangeTermFulfilled(state, acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : '', person.id)) {
    probability += 0.72;
    reasons.push('已接受的交换等待本人交付');
  }
  if (context.options.some((option) => option.id.startsWith('fulfill-assist:') || option.id.startsWith('meet-to-assist:') || option.id.startsWith('join-water-assist:'))) {
    probability += 0.72;
    reasons.push('已接受的求助等待本人履行');
  }
  if (!reasons.length) reasons.push('每月非零重新考虑概率');
  return { probability: clamp(probability, 0.01, 0.82), reasons };
}

function startIntent(
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
  const previous = activeIntent(state, person);
  if (previous) previous.status = 'abandoned';
  const intent: Intent = {
    id: `intent-${atMonth}-${person.id}-${state.intents.length}`,
    ownerId: person.id,
    summary: choice.summary,
    domain: choice.domain,
    goal: choice.goal,
    ...(choice.openingAction ? { openingAction: choice.openingAction, openingActionCompleted: false } : {}),
    nextAction: choice.nextAction,
    ...(choice.completionAction ? { completionAction: choice.completionAction } : {}),
    ...(choice.target ? { target: choice.target } : {}),
    status: 'active',
    createdAtMonth: atMonth,
    lastProgressAtMonth: atMonth,
    progress: 0,
    sourceDecisionEventId: decisionEventId,
    sourceFactIds: choice.sourceFactIds,
    actionEventIds: [],
    replanCount: 0,
  };
  state.intents.push(intent);
  person.activeIntentId = intent.id;
  return intent;
}

function activeIntent(state: SimulationState, person: PersonState): Intent | undefined {
  return state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active');
}

function installAgreementContinuation(state: SimulationState, currentIntent: Intent, continuation: AgreementContinuation, atMonth: number): Intent | null {
  const owner = state.people.find((person) => person.id === continuation.personId && isAlive(person));
  if (!owner) return null;
  const existing = activeIntent(state, owner);
  const intent = existing?.id === currentIntent.id ? currentIntent : {
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
    sourceFactIds: [...continuation.sourceFactIds],
    actionEventIds: [],
    replanCount: 0,
  };
  if (existing && existing.id !== currentIntent.id) existing.status = 'suspended';
  if (intent === currentIntent) {
    intent.summary = continuation.summary;
    intent.goal = structuredClone(continuation.goal);
    intent.nextAction = structuredClone(continuation.nextAction);
    if (continuation.target) intent.target = structuredClone(continuation.target);
    else delete intent.target;
    delete intent.openingAction;
    delete intent.openingActionCompleted;
    delete intent.completionAction;
    intent.sourceFactIds = [...new Set([...(intent.sourceFactIds ?? []), ...continuation.sourceFactIds])];
    intent.progress = 0.2;
  } else state.intents.push(intent);
  owner.activeIntentId = intent.id;
  return intent;
}

function applyDecision(
  state: SimulationState,
  person: PersonState,
  context: DecisionContext,
  decision: Decision,
  usedModel: boolean,
  atMonth: number,
  orderInMonth: number,
): DecisionFact {
  const id = `e-${atMonth}-decision-${person.id}`;
  let intentId: string | undefined;
  let result = decision.reason;
  let domain: Intent['domain'] | undefined;
  const current = activeIntent(state, person);
  if (decision.kind === 'start') {
    const started = startIntent(state, person, context, decision.optionId, decision.followUpOptionId, id, atMonth);
    const spokenAction = started?.openingAction ?? started?.nextAction;
    if (started && decision.utterance && spokenAction?.kind === 'communicate') {
      spokenAction.content.summary = decision.utterance.slice(0, 180);
    }
    intentId = started?.id;
    domain = started?.domain;
    result = started ? `${person.name}决定：${started.summary}` : `${person.name}没有找到该行动机会`;
  } else if (decision.kind === 'revise') {
    const started = startIntent(state, person, context, decision.optionId, decision.followUpOptionId, id, atMonth);
    const spokenAction = started?.openingAction ?? started?.nextAction;
    if (started && decision.utterance && spokenAction?.kind === 'communicate') {
      spokenAction.content.summary = decision.utterance.slice(0, 180);
    }
    intentId = started?.id;
    domain = started?.domain;
    result = started ? `${person.name}改为：${started.summary}` : `${person.name}未能改换目标`;
  } else if (decision.kind === 'suspend' && current?.id === decision.intentId) {
    current.status = 'suspended';
    delete person.activeIntentId;
    intentId = current.id;
    result = `${person.name}暂停：${current.summary}`;
  } else if (decision.kind === 'resume') {
    const resumed = state.intents.find((intent) => intent.id === decision.intentId && intent.ownerId === person.id && intent.status === 'suspended');
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
    result = `${person.name}本月保持空闲：${decision.reason}`;
  }
  person.lastDecisionText = result;
  return { id, kind: 'decision', atMonth, orderInMonth, cellId: person.position.cellId, who: person.id, decision, ...(intentId ? { intentId } : {}), ...(domain ? { domain } : {}), usedModel, result };
}

function executeActiveIntent(state: SimulationState, person: PersonState, atMonth: number, orderInMonth: number, actionTick: number): WorldEvent | null {
  const intent = activeIntent(state, person);
  if (!intent) return null;
  const sourceAgreement = [...state.agreements].reverse().find((agreement) => (intent.sourceFactIds ?? []).some((sourceId) => agreement.sourceEventIds.includes(sourceId)));
  if (sourceAgreement && sourceAgreement.status !== 'proposed' && sourceAgreement.status !== 'active') {
    intent.status = sourceAgreement.status === 'fulfilled' || sourceAgreement.status === 'rejected' ? 'completed' : 'failed';
    intent.progress = sourceAgreement.status === 'fulfilled' || sourceAgreement.status === 'rejected' ? 1 : intent.progress;
    delete person.activeIntentId;
    person.currentActionText = sourceAgreement.status === 'fulfilled' ? `约定已经履行：${intent.summary}` : `约定已经结束：${intent.summary}`;
    return null;
  }
  if (intent.openingAction && !intent.openingActionCompleted) {
    const fact = executePrimitiveAction(state, person, intent.openingAction, atMonth, orderInMonth, { intentId: intent.id, cause: 'intent', actionTick });
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
    intent.status = 'completed';
    intent.progress = 1;
    delete person.activeIntentId;
    person.currentActionText = `已经完成：${intent.summary}`;
    return null;
  }
  const next = recompileNextAction(state, person, intent);
  if (!next) {
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
  const fact = executeIntentAction(state, person, intent, atMonth, orderInMonth, actionTick);
  intent.actionEventIds.push(fact.id);
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
    const processAttemptCompleted = fact.status === 'completed'
      && fact.action.kind === 'act'
      && (fact.action.operation === 'reproduce' || fact.action.operation === 'combine' || fact.action.operation === 'exert' || fact.action.operation === 'expose');
    const acceptedAgreementId = fact.status === 'completed'
      && fact.action.kind === 'communicate'
      && fact.action.content.kind === 'accept'
      ? fact.action.content.referenceId
      : undefined;
    const installed = acceptedAgreementId
      ? compileAgreementContinuations(state, acceptedAgreementId).map((continuation) => installAgreementContinuation(state, intent, continuation, atMonth)).filter(Boolean)
      : [];
    const currentContinues = installed.some((candidate) => candidate?.id === intent.id);
    if (!currentContinues && (representationCompleted || processAttemptCompleted || goalSatisfied(state, person, intent.goal))) {
      intent.status = 'completed';
      intent.progress = 1;
      delete person.activeIntentId;
    } else {
      const compiled = recompileNextAction(state, person, intent);
      if (compiled) intent.nextAction = compiled;
    }
  }
  return fact;
}

function structureComponents(state: SimulationState): Array<{ x: number; y: number; z: number }> {
  const components: Array<{ x: number; y: number; z: number }> = [];
  for (let z = 0; z < WORLD_LEVELS; z += 1) {
    for (let cell = 0; cell < WORLD_CELL_COUNT; cell += 1) {
      if (voxelAt(state.world.grid, cellX(cell), cellY(cell), z) === Material.Plank) components.push({ x: cellX(cell), y: cellY(cell), z });
    }
  }
  return components;
}

function deriveStructures(state: SimulationState): DerivedStructure[] {
  const all = structureComponents(state);
  const byKey = new Map(all.map((position) => [`${position.x}:${position.y}:${position.z}`, position]));
  const visited = new Set<string>();
  const structures: DerivedStructure[] = [];
  for (const origin of all) {
    const originKey = `${origin.x}:${origin.y}:${origin.z}`;
    if (visited.has(originKey)) continue;
    const queue = [origin];
    const group: typeof all = [];
    visited.add(originKey);
    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      group.push(current);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const key = `${current.x + dx}:${current.y + dy}:${current.z + dz}`;
        const next = byKey.get(key);
        if (next && !visited.has(key)) { visited.add(key); queue.push(next); }
      }
    }
    const occupiedCells = [...new Set(group.map((position) => position.x + position.y * state.world.grid.width))];
    const sourceEventIds = state.world.past.filter((event) => {
      if (event.kind !== 'action' || event.action.kind !== 'act' || event.action.operation !== 'combine' || Number(event.diff.outputMaterialId) !== Material.Plank) return false;
      const position = event.diff.position as { x?: unknown; y?: unknown } | undefined;
      const targetCell = Number(position?.x) + Number(position?.y) * state.world.grid.width;
      return Number.isFinite(targetCell) && occupiedCells.includes(targetCell);
    }).map((event) => event.id);
    const complete = group.length >= 4 && occupiedCells.length >= 3;
    structures.push({
      id: `structure-${originKey}`,
      name: complete ? '木质遮蔽结构' : '未完成木质结构',
      occupiedCells,
      interiorCells: complete ? occupiedCells.slice(0, 1) : [],
      materialIds: [Material.Plank],
      weatherProtection: clamp(group.length * 13),
      thermalInsulation: clamp(group.length * 10),
      capacity: Math.max(1, Math.floor(group.length / 3)),
      complete,
      sourceEventIds,
    });
  }
  return structures;
}

function deriveObservations(state: SimulationState): SimulationState['derived'] {
  const actions = state.world.past.filter((event) => event.kind === 'action');
  const transfers = actions.filter((event) => event.action.kind === 'transfer' && event.status === 'completed');
  const movements = actions.filter((event) => event.action.kind === 'move' && event.pathSegment.length > 1);
  const trailFormation = movements.flatMap((event) => {
    const changes = Array.isArray(event.diff.materialChanges) ? event.diff.materialChanges : [];
    const cells = changes.flatMap((change) => {
      if (!change || typeof change !== 'object') return [];
      const item = change as { cellId?: unknown; to?: unknown };
      return Number(item.to) === Material.PackedSoil && Number.isInteger(Number(item.cellId)) ? [Number(item.cellId)] : [];
    });
    return cells.length ? [{ event, cells }] : [];
  });
  const cultivation = actions.filter((event) => event.action.kind === 'act' && event.action.operation === 'combine' && Number(event.diff.outputMaterialId) === Material.CropSprout);
  const harvests = actions.filter((event) => event.action.kind === 'act' && event.action.operation === 'separate' && Number(event.diff.sourceMaterialId) === Material.CropMature);
  const exchangeOffers = actions.filter((event) => event.status === 'completed' && event.action.kind === 'communicate' && event.action.content.kind === 'offer' && event.action.content.proposal?.kind === 'exchange');
  const exchangeAcceptances = actions.filter((event) => event.status === 'completed' && event.action.kind === 'communicate' && event.action.content.kind === 'accept');
  const exchangeTransfers = transfers.filter((event) => event.action.kind === 'transfer' && event.action.authorizationRef);
  const attended = actions.filter((event) => event.status === 'completed' && event.action.kind === 'attend');
  const taughtTechniques = actions.filter((event) => event.status === 'completed' && event.action.kind === 'communicate' && event.action.content.kind === 'claim' && event.action.content.factId?.startsWith('technique:'));
  const structures = deriveStructures(state);
  const trailCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.PackedSoil);
  const cultivatedCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.CropSprout || surfaceMaterial(state.world.grid, cell) === Material.CropMature || surfaceMaterial(state.world.grid, cell) === Material.ExhaustedSoil);
  const milestones: MilestoneObservation[] = [];
  const foodGathering = transfers.filter((fact) => fact.action.kind === 'transfer' && fact.action.materialId === Material.Food && fact.action.from.kind === 'ground');
  if (foodGathering.length) milestones.push({ id: '11', label: '采集食物', evidenceEventIds: foodGathering.map((fact) => fact.id), note: '人物从具体格子的掉落物取得可食物质。' });
  const shelterEvidence = structures.filter((structure) => structure.complete).flatMap((structure) => structure.sourceEventIds);
  if (shelterEvidence.length) milestones.push({ id: '20', label: '建造住所', evidenceEventIds: shelterEvidence, note: '多个相邻木板体素形成了具有遮蔽效果的空间结构。' });
  if (cultivation.length && harvests.length) milestones.push({ id: '32', label: '种植并收获作物', evidenceEventIds: [...cultivation, ...harvests].map((fact) => fact.id), note: '种子与土壤结合，作物经自然生长后被分离收获。' });
  const formedTrailCells = new Set<number>();
  let roadObservedAtMonth: number | undefined;
  for (const formation of trailFormation) {
    formation.cells.forEach((cell) => formedTrailCells.add(cell));
    if (formedTrailCells.size >= 4 && roadObservedAtMonth === undefined) roadObservedAtMonth = formation.event.atMonth;
  }
  if (roadObservedAtMonth !== undefined) milestones.push({
    id: '42', label: '开辟道路',
    evidenceEventIds: trailFormation.map(({ event }) => event.id),
    observedAtMonth: roadObservedAtMonth,
    note: '重复真实通行先后把至少四个地表格从土压实为夯土。',
  });
  for (const offer of exchangeOffers) {
    if (offer.action.kind !== 'communicate' || offer.action.content.kind !== 'offer') continue;
    const offerId = offer.action.content.id;
    const acceptance = exchangeAcceptances.find((event) => event.action.kind === 'communicate' && event.action.content.kind === 'accept' && event.action.content.referenceId === offerId);
    if (!acceptance) continue;
    if (!milestones.some((milestone) => milestone.id === '48')) milestones.push({ id: '48', label: '订立交换约定', evidenceEventIds: [offer.id, acceptance.id], note: '一方提出结构化交换条款，另一方明确接受。' });
    const deliveries = exchangeTransfers.filter((event) => event.action.kind === 'transfer' && event.action.authorizationRef === offerId);
    const parties = new Set(deliveries.flatMap((event) => event.action.kind === 'transfer' && event.action.from.kind === 'person' ? [event.action.from.personId] : []));
    if (parties.size >= 2 && !milestones.some((milestone) => milestone.id === '45')) milestones.push({ id: '45', label: '交换货物', evidenceEventIds: [offer.id, acceptance.id, ...deliveries.map((event) => event.id)], note: '双方分别履行真实物质转移，交换完成。' });
  }
  if (attended.length) milestones.push({ id: '58', label: '观察自然现象', evidenceEventIds: attended.map((event) => event.id), note: '人物投入时间持续观察物质并形成个人知识。' });
  if (taughtTechniques.length) milestones.push({ id: '134', label: '交换技术知识', evidenceEventIds: taughtTechniques.map((event) => event.id), note: '成功操作形成个人技术知识，并由持有者向身边人传播。' });
  for (const milestone of observeCoreMilestones(state)) {
    if (!milestones.some((existing) => existing.id === milestone.id)) milestones.push(milestone);
  }
  const practices: PracticeObservation[] = [
    transfers.length ? { key: 'transfer', label: '反复转移物质', count: transfers.length, agentIds: [...new Set(transfers.map((event) => event.who))], eventIds: transfers.map((event) => event.id), stability: clamp(transfers.length * 5) } : null,
    movements.length ? { key: 'travel', label: '跨格迁行', count: movements.length, agentIds: [...new Set(movements.map((event) => event.who))], eventIds: movements.map((event) => event.id), stability: clamp(movements.length * 4) } : null,
    cultivation.length ? { key: 'cultivation', label: '种植实践', count: cultivation.length, agentIds: [...new Set(cultivation.map((event) => event.who))], eventIds: cultivation.map((event) => event.id), stability: clamp(cultivation.length * 12) } : null,
  ].filter((item): item is PracticeObservation => Boolean(item));
  const regions: EmergentRegion[] = [];
  const waterCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.Water || surfaceMaterial(state.world.grid, cell) === Material.Ice);
  if (waterCells.length) regions.push({ id: 'natural-water', kind: 'natural', cells: waterCells, confidence: 1, evidenceEventIds: [], firstObservedMonth: 0, lastObservedMonth: state.clock.elapsedMonths, label: '水域' });
  if (trailCells.length) regions.push({ id: 'travel-trail', kind: 'trail', cells: trailCells, confidence: clamp(trailCells.length / 20), evidenceEventIds: trailFormation.map(({ event }) => event.id), firstObservedMonth: trailFormation[0]?.event.atMonth ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '夯土通行带' });
  if (cultivatedCells.length) regions.push({ id: 'cultivated', kind: 'cultivated', cells: cultivatedCells, confidence: clamp(cultivatedCells.length / 12), evidenceEventIds: [...cultivation, ...harvests].map((event) => event.id), firstObservedMonth: cultivation[0]?.atMonth ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '耕作区' });
  for (const structure of structures.filter((item) => item.complete)) regions.push({ id: `residential-${structure.id}`, kind: 'residential', cells: structure.occupiedCells, confidence: structure.weatherProtection / 100, evidenceEventIds: structure.sourceEventIds, firstObservedMonth: state.world.past.find((event) => structure.sourceEventIds.includes(event.id))?.atMonth ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '木质活动区' });
  return { practices, institutions: [], milestones, regions, structures };
}

function currentRollingLedgers(state: SimulationState): DecisionMonthLedger[] {
  return rollingDecisionUsage(state.decisionBudget.ledgers, state.clock.elapsedMonths);
}

function prepareMonth(input: SimulationState) {
  const state = copyState(input);
  if (state.civilization.status === 'ended') return { state, events: [] as WorldEvent[], contexts: [] as DecisionContext[], candidates: [] as DecisionContext[], atMonth: state.clock.elapsedMonths };
  const atMonth = state.clock.elapsedMonths + 1;
  for (const person of state.people.filter(isAlive)) {
    person.position.previousCellId = person.position.cellId;
    person.position.lastPath = [person.position.cellId];
    person.position.tickPath = [person.position.cellId];
  }
  const events: WorldEvent[] = [...resolveClimate(state, atMonth), ...advanceWorldProcesses(state, atMonth)];
  events.push(...advanceAgreementLifecycle(state, atMonth, events.length));
  maintainMemories(state, atMonth);
  const contexts = buildDecisionContexts(state);
  const candidates: DecisionContext[] = [];
  for (const context of contexts) {
    const { probability, reasons } = decisionProbability(state, context);
    const sample = seededFraction(state.seed, `decision:${state.branchId}:${atMonth}:${context.person.id}`);
    const requiredSocialResponse = hasRequiredSocialResponse(context);
    const exposureEscalated = unconsideredExposureEscalation(state, context.person);
    const meaningful = !context.activeIntent
      || requiredSocialResponse
      || exposureEscalated
      || (context.activeIntent && state.clock.elapsedMonths - context.activeIntent.lastProgressAtMonth >= 2);
    const triggered = meaningful && (requiredSocialResponse || exposureEscalated || sample < probability);
    const opportunity: DecisionOpportunityFact = {
      id: `e-${atMonth}-opportunity-${context.person.id}`,
      kind: 'decision-opportunity', atMonth, orderInMonth: events.length,
      who: context.person.id, cellId: context.person.position.cellId,
      probability, sample, triggered, reasons,
      result: triggered
        ? requiredSocialResponse ? `${context.person.name}本月必须回应一项社会请求` : `${context.person.name}本月重新考虑下一步`
        : `${context.person.name}本月延续已有意图`,
    };
    events.push(opportunity);
    if (triggered) candidates.push(context);
  }
  return { state, events, contexts, candidates, atMonth };
}

function finishMonth(state: SimulationState, events: WorldEvent[], atMonth: number): SimulationState {
  events.forEach((event, index) => { event.orderInMonth = index; });
  state.clock.elapsedMonths = atMonth;
  state.world.past.push(...events);
  state.lastStep = events;
  state.world.drops = state.world.drops.filter((drop) => drop.quantity > 0);
  state.derived = deriveObservations(state);
  const living = state.people.filter(isAlive);
  state.civilization.integrity = living.length ? clamp(living.reduce((sum, person) => sum + person.body.health, 0) / living.length) : 0;
  state.civilization.stage = state.derived.milestones.some((milestone) => milestone.id === '32') ? '定居耕作群体' : state.derived.milestones.some((milestone) => milestone.id === '20') ? '物质建造群体' : '自然群体';
  if (!living.length) {
    state.civilization.status = 'ended';
    state.civilization.outcome = { kind: 'destroyed', cause: '全员死亡', atMonth, summary: '文明没有留下仍在世的人。' };
  } else if (state.civilization.conditions.endpoint.kind === 'months' && atMonth >= state.civilization.conditions.endpoint.value) {
    state.civilization.status = 'ended';
    state.civilization.outcome = { kind: 'boundary', cause: '达到模拟月数', atMonth, summary: `文明演化至第 ${atMonth} 月。` };
  } else if (state.civilization.conditions.endpoint.kind === 'milestones' && state.derived.milestones.length >= state.civilization.conditions.endpoint.value) {
    state.civilization.status = 'ended';
    state.civilization.outcome = { kind: 'milestones', cause: '达到里程碑数量', atMonth, summary: `文明观察到 ${state.derived.milestones.length} 项里程碑。` };
  }
  return state;
}

function executePrepared(
  prepared: ReturnType<typeof prepareMonth>,
  decisions: Map<PersonId, { decision: Decision; usedModel: boolean }>,
  usage: TokenUsage,
  attemptedModelContexts: number,
): SimulationState {
  const { state, events, contexts, candidates, atMonth } = prepared;
  if (state.civilization.status === 'ended') return state;
  for (const candidate of candidates) {
    const person = state.people.find((item) => item.id === candidate.person.id);
    if (!person || !isAlive(person)) continue;
    const freshContext = buildDecisionContext(state, person);
    const picked = decisions.get(person.id);
    if (!picked) continue;
    events.push(applyDecision(state, person, freshContext, picked.decision, picked.usedModel, atMonth, events.length));
  }
  const participants = state.people.filter(isAlive);
  for (let actionTick = 1; actionTick <= RULE_ACTION_TICKS_PER_MONTH; actionTick += 1) {
    const order = [...participants]
      .filter(isAlive)
      .sort((a, b) => seededFraction(state.seed, `action-order:${state.branchId}:${atMonth}:${actionTick}:${a.id}`) - seededFraction(state.seed, `action-order:${state.branchId}:${atMonth}:${actionTick}:${b.id}`) || a.id.localeCompare(b.id));
    for (const person of order) {
      const reflex = chooseSurvivalReflex(state, person);
      if (reflex) {
        const fact = executePrimitiveAction(state, person, reflex, atMonth, events.length, { cause: 'survival-reflex', actionTick });
        person.currentActionText = fact.result;
        events.push(fact);
        continue;
      }
      const dependentCare = chooseDependentCareReflex(state, person);
      if (dependentCare) {
        const fact = executePrimitiveAction(state, person, dependentCare, atMonth, events.length, { cause: 'survival-reflex', actionTick });
        person.currentActionText = fact.result;
        events.push(fact);
        continue;
      }
      const fact = executeActiveIntent(state, person, atMonth, events.length, actionTick);
      if (fact) events.push(fact);
    }
    for (const person of participants) person.position.tickPath.push(person.position.cellId);
  }
  events.push(...advanceBodies(state, atMonth));
  const modelContexts = attemptedModelContexts;
  const chargedTokens = modelContexts ? Math.max(usage.inputTokens + usage.outputTokens, modelContexts * state.decisionBudget.tokensPerContext) : 0;
  state.decisionBudget.ledgers = [...currentRollingLedgers(state), {
    atMonth,
    livingAgents: contexts.length,
    candidates: candidates.length,
    modelContexts,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    chargedTokens,
  }].slice(-24);
  state.decisionBudget.credits = clamp(state.decisionBudget.credits + contexts.length / 12 - modelContexts, 0, Math.max(1, contexts.length));
  return finishMonth(state, events, atMonth);
}

export function stepSimulation(input: SimulationState, decider: AgentDecider = new MockDecider()): SimulationState {
  const prepared = prepareMonth(input);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) decisions.set(context.person.id, { decision: decider.decide(context), usedModel: false });
  return executePrepared(prepared, decisions, { inputTokens: 0, outputTokens: 0 }, 0);
}

export async function stepSimulationAsync(input: SimulationState, batch: BatchDecider): Promise<SimulationState> {
  const prepared = prepareMonth(input);
  const living = prepared.contexts.length;
  const rolling = currentRollingLedgers(prepared.state);
  const requiredContexts = prepared.candidates.filter(hasRequiredSocialResponse).length;
  const ordinaryCapacity = Math.min(
    prepared.candidates.length,
    Math.floor(prepared.state.decisionBudget.credits + living / 12),
    availableModelContexts(rolling, living),
    Math.floor(availableModelTokens(rolling, living, prepared.state.decisionBudget.tokensPerContext) / prepared.state.decisionBudget.tokensPerContext),
  );
  const maxContexts = Math.min(
    prepared.candidates.length,
    Math.max(requiredContexts, ordinaryCapacity),
  );
  const importance = (context: DecisionContext) => {
    let score = hasRequiredSocialResponse(context)
      ? 2_000
      : unconsideredExposureEscalation(prepared.state, context.person)
        ? 1_500
      : context.options.some((option) => option.id.startsWith('fulfill-assist:') || option.id.startsWith('meet-to-assist:') || option.id.startsWith('join-water-assist:') || option.id.startsWith('rejoin-companion:'))
        ? 1_200
        : context.options.some((option) => option.domain === 'social')
          ? 700
          : !context.activeIntent ? 500 : 300;
    const lastDecisionMonth = lastModelDecisionMonth(prepared.state, context.person.id);
    if (lastDecisionMonth !== null) {
      const monthsSince = prepared.state.clock.elapsedMonths - lastDecisionMonth;
      score -= Math.max(0, 12 - monthsSince) * 80;
    }
    return score;
  };
  const ranked = [...prepared.candidates].sort((a, b) => importance(b) - importance(a) || urgency(b) - urgency(a) || a.person.id.localeCompare(b.person.id));
  const modelContexts = ranked.slice(0, maxContexts);
  const modelDecisions = modelContexts.length ? await batch.decideAll(modelContexts) : [];
  if (modelDecisions.length !== modelContexts.length || modelDecisions.some((decision) => !decision)) throw new Error('Kimi 未返回完整的关键决策，本月没有提交');
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  modelContexts.forEach((context, index) => {
    const decision = modelDecisions[index];
    if (decision) decisions.set(context.person.id, { decision, usedModel: true });
  });
  return executePrepared(prepared, decisions, batch.takeUsage?.() ?? { inputTokens: 0, outputTokens: 0 }, modelContexts.length);
}

export function migrateSimulationState(input: SimulationState): SimulationState {
  if (Number((input as { schemaVersion?: number }).schemaVersion) !== 14) throw new Error('schemaVersion 13 及更早存档不支持继续演化；请建立新的协议事实文明');
  const state = structuredClone(input);
  state.world.grid = hydrateWorld(input.world.grid);
  for (const person of state.people) {
    const start = person.position.previousCellId ?? person.position.cellId;
    person.position.lastPath = person.position.lastPath?.length ? person.position.lastPath : [start, person.position.cellId];
    person.position.tickPath = person.position.tickPath?.length
      ? person.position.tickPath
      : Array.from({ length: RULE_ACTION_TICKS_PER_MONTH + 1 }, (_, index) => index === RULE_ACTION_TICKS_PER_MONTH ? person.position.cellId : start);
  }
  return state;
}

export interface SimulationController {
  getState(): SimulationState;
  stepAsync(batch: BatchDecider, count?: number): Promise<SimulationState>;
  reset(): SimulationState;
  restore(saved: SimulationState): SimulationState;
  setExternalClimate(epoch: EpochKind, kind: ClimateKind, severity: number): SimulationState;
  injectEvent(input: EnvironmentEventInput): SimulationState;
}

export function createSimulation(options: { seed?: number; config?: Partial<SimulationConfig>; state?: SimulationState } = {}): SimulationController {
  let state = options.state ? migrateSimulationState(options.state) : createInitialState(options.seed, options.config);
  return {
    getState: () => copyState(state),
    async stepAsync(batch, count = 1) {
      for (let index = 0; index < count; index += 1) state = await stepSimulationAsync(state, batch);
      return copyState(state);
    },
    reset() {
      state = createInitialState(options.seed ?? state.seed, state.civilization.conditions);
      return copyState(state);
    },
    restore(saved) {
      state = migrateSimulationState(saved);
      return copyState(state);
    },
    setExternalClimate(epoch, kind, severity) {
      state.civilization.externalClimate = { epoch, kind, severity: clamp(severity, 1, 10) };
      return copyState(state);
    },
    injectEvent(input) {
      if (!isCellId(input.cellId)) throw new Error('环境事件 cellId 无效');
      const atMonth = state.clock.elapsedMonths;
      const event: EnvironmentFact = {
        id: `e-${atMonth}-injected-${state.world.past.length}`,
        kind: 'environment', atMonth, orderInMonth: 0, cellId: input.cellId,
        change: input.kind,
        result: input.description ?? `格子 ${input.cellId} 的环境发生变化`,
        diff: { severity: input.severity ?? 0, resource: input.resource ?? '', delta: input.delta ?? 0 },
      };
      if (input.kind === 'resource' && (input.delta ?? 0) > 0) {
        const normalized = input.resource?.toLowerCase();
        const materialId = normalized?.includes('wood') || normalized?.includes('木') ? Material.Wood
          : normalized?.includes('seed') || normalized?.includes('种') ? Material.Seed
            : normalized?.includes('stone') || normalized?.includes('石') ? Material.Stone : Material.Food;
        addDrop(state, materialId, Math.round(input.delta ?? 1), input.cellId, atMonth, [event.id], 'injected');
        event.result = `格 ${cellX(input.cellId)}, ${cellY(input.cellId)} 出现${materialDefinition(materialId).name}`;
      }
      state.world.past.push(event);
      state.lastStep = [event];
      return copyState(state);
    },
  };
}

export function resetSimulation(seed = 17, config: Partial<SimulationConfig> = {}): SimulationState {
  return createInitialState(seed, config);
}

export function buildEvolutionReport(finalState: SimulationState, checkpoints: SimulationState[] = []): EvolutionReport {
  return {
    schemaVersion: 14,
    exportedAt: new Date().toISOString(),
    civilization: structuredClone(finalState.civilization),
    finalState: copyState(finalState),
    checkpoints: checkpoints.map(copyState),
    review: { milestones: structuredClone(finalState.derived.milestones), eventCount: finalState.world.past.length },
  };
}
