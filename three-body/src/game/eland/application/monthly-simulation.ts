import { CHARACTER_PROFILES, type CharacterProfile } from '../character-profiles';
import {
  createFounderAgeMonths,
  createLifespanMonths,
  deterministicFraction,
} from '../population';
import { MONTHS_PER_YEAR, PLANNING_TICKS_PER_MONTH } from '../domain/calendar';
import {
  availableModelContexts,
  availableModelTokens,
  ORDINARY_DECISION_PERSON_MONTHS,
  rollingDecisionUsage,
} from '../domain/decision-budget';
import { executeIntentAction, executePrimitiveAction, goalSatisfied, addDrop } from '../domain/action-executor';
import {
  advanceBodies,
  advanceEraPredictions,
  advanceSharedRelationshipExperience,
  advanceWorldProcesses,
  initialEraSchedule,
  resolveClimate,
  resolveWeather,
} from '../domain/monthly-processes';
import { Material, materialDefinition, materialHas, type MaterialId } from '../domain/material';
import { isAlive, isDehydratedHibernating, sameLocation, type PersonId, type PersonState } from '../domain/person';
import { consolidatePersonality, createMotiveSensitivity, createPersonality } from '../domain/personality';
import type {
  AgentDecider,
  ActionFact,
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
  InstitutionObservation,
  PracticeObservation,
  SimulationConfig,
  SimulationState,
  TokenUsage,
  WorldEvent,
} from '../domain/model';
import { buildDecisionContext, cloneMutableProjectsForPlanning, recompileNextAction } from './action-options';
import { acceptedExchangeFor, exchangeTermFulfilled } from '../domain/social-facts';
import { maintainMemories, remember } from '../domain/memory';
import { composeIntentChoice } from '../domain/intent';
import { chooseSurvivalReflex, shouldRemainSheltered, survivalReflexUrgency } from '../domain/survival-reflex';
import { chooseDependentCareReflex, dependentCareUrgency, shouldRemainShelteredForDependent } from '../domain/dependent-care';
import { observeCapabilityMilestones } from '../projection/capability-milestones';
import { advanceAgreementLifecycle } from '../domain/agreement';
import { advanceCollectiveLifecycle } from '../domain/collective';
import { advanceGovernanceLifecycle } from '../domain/governance';
import { advancePermissionLifecycle } from '../domain/permission';
import { shelterGeometryAt } from '../domain/structure';
import { compileAgreementContinuations, type AgreementContinuation } from './agreement-continuation';
import type { ActionOption } from '../domain/action';
import {
  groundedLifeReviewOpportunity,
  hasFulfillmentOpportunity,
  hasRequiredSocialResponse,
  isFulfillmentOption,
  isMaintainableStateGoal,
  isProductionOption,
  isRequiredSocialOption,
  RulePlanner,
} from './rule-planner';
import { optionAllowedForLifeStage } from './age-planning';
import { lifePlanningStage } from '../domain/life-stage';
import { FOUNDER_INITIAL_RELATION } from '../domain/relation';
import {
  WORLD_CELL_COUNT,
  cellX,
  cellY,
  hydrateWorld,
  isCellId,
  surfaceMaterial,
  surfaceStandingPosition,
  standingPositions,
  topZ,
  voxelAt,
} from '../world/grid';
import { generateVoxelWorld, seededFraction } from '../world/generator';
import { inferNamingIdentity } from '../naming';
import {
  actionFacts,
  completedConstructionActions,
  primeEventIndex,
  registerPlanningEventOverlay,
  worldEventById,
} from '../domain/event-index';
import { createInitialAnimals } from '../domain/animal';
import { hasGroundedConversationResponseOpportunity } from './conversation-options';
import {
  calculateCivilizationIndex,
  emptyCivilizationIndex,
} from '../domain/civilization-index';
import {
  DEVELOPMENT_ERA_LABELS,
  observeCivilizationDevelopment,
  observeFunctionalBuildings,
} from '../domain/era-progression';
import {
  advanceProjects,
  ensureProject,
  hasCausalShelterAdaptationNeed,
  recordProjectAction,
  synchronizeProject,
} from './project-options';

export * from '../domain/model';
export { MockDecider, RulePlanner } from './rule-planner';

export const MAX_SIMULATION_YEARS = 1_000;
export const MAX_SIMULATION_MONTHS = MAX_SIMULATION_YEARS * MONTHS_PER_YEAR;

function updateDevelopmentObservation(state: SimulationState): void {
  state.civilization.civilizationIndex = calculateCivilizationIndex(state);
  const development = observeCivilizationDevelopment(state, state.civilization.civilizationIndex.total);
  state.civilization.development = development;
  state.civilization.stage = DEVELOPMENT_ERA_LABELS[development.currentEra];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function copyState(input: SimulationState): SimulationState {
  // structuredClone 已经会复制 Uint16Array；过去再调用 copyWorld 会把整张
  // 84×52×12 体素图重复复制一次，每次 getState/step 都产生无意义的额外分配。
  return structuredClone(input);
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

function ensureNamingMetadata(people: PersonState[]): void {
  for (const person of [...people].sort((a, b) => a.generation - b.generation || a.bornAtMonth - b.bornAtMonth || a.id.localeCompare(b.id))) {
    const archived = CHARACTER_PROFILES.find((profile) => profile.id === person.id);
    const father = person.geneticParents
      .map((parentId) => people.find((candidate) => candidate.id === parentId))
      .find((parent): parent is PersonState => parent?.sex === 'male');
    const source = archived ?? father ?? person;
    const identity = inferNamingIdentity(source);
    person.familyName ||= identity.familyName;
    person.namingTradition ??= identity.namingTradition;
  }
}

export function createDefaultSimulationConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    civilizationNo: Math.max(1, Math.round(overrides.civilizationNo ?? 1)),
    climateBias: overrides.climateBias === 'cold' || overrides.climateBias === 'hot' ? overrides.climateBias : 'balanced',
    chaosIntensity: clamp(Math.round(overrides.chaosIntensity ?? 0), 0, 10),
    endpoint: {
      kind: overrides.endpoint?.kind === 'milestones' ? 'milestones' : 'months',
      value: overrides.endpoint?.kind === 'milestones'
        ? Math.max(1, Math.round(overrides.endpoint.value))
        : Math.min(MAX_SIMULATION_MONTHS, Math.max(1, Math.round(overrides.endpoint?.value ?? MAX_SIMULATION_MONTHS))),
    },
    ...(overrides.characterIds?.length ? { characterIds: [...new Set(overrides.characterIds)].slice(0, 10) } : {}),
  };
}

const FOUNDER_COHORT_EVENT_ID = 'e-0-environment-founding-0';

function initialPerson(seed: number, profile: CharacterProfile, spawnCell: number, spawnZ: number, profiles: CharacterProfile[]): PersonState {
  const founderAge = createFounderAgeMonths(seed, profile.id);
  const capacity = (key: string, floor: number, span: number) => floor + Math.floor(deterministicFraction(seed, `${key}:${profile.id}`) * span);
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    profile: { description: profile.description },
    bornAtMonth: -founderAge,
    lifespanMonths: createLifespanMonths(seed, profile.id, founderAge),
    sex: profile.sex,
    familyName: profile.familyName,
    namingTradition: profile.namingTradition,
    geneticParents: [],
    generation: 0,
    geneticLoad: 0,
    position: { cellId: spawnCell, z: spawnZ, previousCellId: spawnCell, previousZ: spawnZ, lastPath: [spawnCell], tickPath: [spawnCell] },
    body: { health: 92, hydration: 82, nutrition: 78 },
    baselineCapacities: {
      locomotion: capacity('locomotion', 48, 35),
      manipulation: capacity('manipulation', 45, 35),
      perception: capacity('perception', 42, 40),
      communication: capacity('communication', 42, 40),
      cognition: capacity('cognition', 42, 40),
    },
    personality: createPersonality(seed, profile.id),
    motiveSensitivity: createMotiveSensitivity(seed, profile.id),
    conditions: [],
    inventory: [{ id: `stack-${profile.id}-ration`, materialId: Material.Food, quantity: 2, sourceEventIds: [] }],
    knowledge: [],
    knownPlaces: [],
    memories: [],
    relations: profiles.filter((other) => other.id !== profile.id).map((other) => ({
      personId: other.id,
      trust: FOUNDER_INITIAL_RELATION,
      bond: FOUNDER_INITIAL_RELATION,
      fear: 0,
      sourceEventIds: [FOUNDER_COHORT_EVENT_ID],
    })),
    currentActionText: '观察身边的物质',
    lastDecisionText: '尚未作出关键决定',
  };
}

export function createInitialState(seed = 17, inputConfig: Partial<SimulationConfig> = {}): SimulationState {
  const config = createDefaultSimulationConfig(inputConfig);
  const generated = generateVoxelWorld(seed);
  const profiles = chooseProfiles(seed, config.civilizationNo, config.characterIds);
  const people = profiles.map((profile, index) => {
    const spawnCell = generated.spawnCells[index] ?? generated.spawnCells[0];
    const spawnZ = surfaceStandingPosition(generated.world, spawnCell)?.z ?? Math.min(generated.world.levels - 2, Math.max(1, topZ(generated.world, spawnCell) + 1));
    return initialPerson(seed + config.civilizationNo * 997, profile, spawnCell, spawnZ, profiles);
  });
  const foundingFact: EnvironmentFact = {
    id: FOUNDER_COHORT_EVENT_ID,
    kind: 'environment',
    atMonth: 0,
    orderInMonth: 0,
    cellId: people[0]?.position.cellId ?? 0,
    change: 'founding',
    result: '开局先民共同抵达，并已形成基本的相互熟悉',
    diff: { participantIds: people.map((person) => person.id) },
  };
  const state: SimulationState = {
    schemaVersion: 17,
    seed,
    branchId: `root-${seed}-${config.civilizationNo}`,
    clock: { unit: 'month', elapsedMonths: 0, monthsPerYear: MONTHS_PER_YEAR },
    world: {
      grid: generated.world,
      drops: generated.drops,
      animals: createInitialAnimals(seed, generated.world, generated.spawnCells.slice(0, people.length)),
      past: [foundingFact],
      traffic: {},
    },
    people,
    intents: [],
    agreements: [],
    records: [],
    collectives: [],
    permissions: [],
    containers: [],
    eraPredictions: [],
    projects: [],
    civilization: {
      number: config.civilizationNo,
      status: 'running',
      stage: '自然群体',
      epoch: 'stable',
      era: initialEraSchedule(seed, config.chaosIntensity),
      climate: { kind: 'temperate', severity: 1, sinceMonth: 0 },
      weather: { kind: 'clear', intensity: 1, sinceMonth: 0 },
      conditions: config,
      civilizationIndex: emptyCivilizationIndex(),
    },
    decisionBudget: { credits: 0, tokensPerContext: 8_000, ledgers: [] },
    derived: { practices: [], institutions: [], milestones: [], regions: [], structures: [] },
    lastStep: [],
  };
  updateDevelopmentObservation(state);
  return state;
}

function personCanDecide(state: SimulationState, person: PersonState): boolean {
  const founderBootstrap = state.clock.elapsedMonths === 0 && person.generation === 0;
  return (founderBootstrap || lifePlanningStage(person, state.clock.elapsedMonths) !== 'dependent-child')
    && isAlive(person)
    && !isDehydratedHibernating(person);
}

function hasCoLocatedLivingParent(state: SimulationState, person: PersonState): boolean {
  return state.people.some((candidate) => person.geneticParents.includes(candidate.id)
    && isAlive(candidate)
    && sameLocation(candidate, person));
}

export function buildDecisionContexts(state: SimulationState): DecisionContext[] {
  return state.people.filter(isAlive).map((person) => {
    const context = buildDecisionContext(state, person);
    if (!personCanDecide(state, person)) return { ...context, options: [], followUpOptions: [] };
    const stage = lifePlanningStage(person, state.clock.elapsedMonths);
    return {
      ...context,
      options: context.options.filter((option) => optionAllowedForLifeStage(stage, option)),
      followUpOptions: context.followUpOptions.filter((option) => optionAllowedForLifeStage(stage, option)),
    };
  });
}

function urgency(context: DecisionContext): number {
  const person = context.person;
  return Math.max(100 - person.body.health, 100 - person.body.hydration, 100 - person.body.nutrition);
}

function hasUnfinishedProductionIntent(context: DecisionContext): boolean {
  return Boolean(context.activeIntent
    && context.activeIntent.domain === 'strategic'
    && isMaintainableStateGoal(context.activeIntent.goal)
    && !goalSatisfied(context.state, context.person, context.activeIntent.goal));
}

function stateGoalReviewDue(context: DecisionContext, atMonth: number): boolean {
  return context.activeIntent?.stateGoalUntilMonth !== undefined
    && atMonth > context.activeIntent.stateGoalUntilMonth;
}

function isEmergencyDecisionContext(context: DecisionContext): boolean {
  const person = context.person;
  return person.body.health < 35
    || person.body.hydration < 32
    || person.body.nutrition < 34
    || person.conditions.some((condition) => (condition.kind === 'cold'
      || condition.kind === 'heat'
      || condition.kind === 'wound'
      || condition.kind === 'illness') && condition.stage >= 2);
}

type DecisionBudgetExemption = 'bootstrap' | 'emergency' | 'required-response' | 'fulfillment';

function decisionBudgetExemption(context: DecisionContext, atMonth: number): DecisionBudgetExemption | null {
  if (atMonth === 1 && context.person.generation === 0) return 'bootstrap';
  if (isEmergencyDecisionContext(context)) return 'emergency';
  if (hasRequiredSocialResponse(context)) return 'required-response';
  if (hasFulfillmentOpportunity(context)) return 'fulfillment';
  return null;
}

function lastModelDecisionMonth(state: SimulationState, personId: PersonId): number | null {
  for (let index = state.world.past.length - 1; index >= 0; index -= 1) {
    const event = state.world.past[index];
    if (event.kind === 'decision' && event.usedModel && event.who === personId) return event.atMonth;
  }
  return null;
}

function severeExposure(context: DecisionContext): boolean {
  return context.person.conditions.some((condition) => (
    condition.kind === 'cold' || condition.kind === 'heat'
  ) && condition.stage >= 2);
}

function decisionProbability(state: SimulationState, context: DecisionContext): { probability: number; reasons: string[] } {
  const person = context.person;
  const reasons: string[] = [];
  let probability = personCanDecide(state, person) ? 0.045 : 0.01;
  if (!context.activeIntent) {
    probability += 0.44;
    reasons.push('当前没有持续目标');
    if (context.options.some(isProductionOption)) {
      probability += 0.16;
      reasons.push('空闲时存在可执行的生产或探索机会');
    }
  }
  if (context.activeIntent && state.clock.elapsedMonths - context.activeIntent.lastProgressAtMonth >= 2) {
    probability += hasUnfinishedProductionIntent(context) ? 0.48 : 0.22;
    reasons.push(hasUnfinishedProductionIntent(context) ? '未完成的生产目标已经停滞' : '意图停滞');
  }
  if (severeExposure(context)) {
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
  const linkedProject = choice.projectProposal
    ? ensureProject(state, choice.projectProposal)
    : choice.projectId
      ? state.projects.find((project) => project.id === choice.projectId && project.status === 'active')
      : undefined;
  if (choice.projectId && !linkedProject) return null;
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
    goal: choice.goal,
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
    ...(linkedProject ? { projectId: linkedProject.id } : {}),
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

function activeIntent(state: SimulationState, person: PersonState): Intent | undefined {
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
  if (!parent || (!parent.projectId && !parent.returnToIntentId) || !selected || selected.projectProposal) return null;
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
    agreementId: continuation.agreementId,
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

function applyDecision(
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
    const spokenAction = [started?.openingAction, started?.nextAction, started?.completionAction]
      .find((action) => action?.kind === 'communicate');
    if (started && decision.utterance && spokenAction?.kind === 'communicate') {
      spokenAction.content.summary = decision.utterance.slice(0, 180);
    }
    intentId = started?.id;
    domain = started?.domain;
    result = started ? `${person.name}决定：${started.summary}` : `${person.name}没有找到该行动机会`;
  } else if (decision.kind === 'revise') {
    const started = decision.mode === 'interrupt' && decision.interruptionKind
      ? startInterruptIntent(state, person, context, decision.optionId, id, atMonth, decision.interruptionKind)
      : startIntent(state, person, context, decision.optionId, decision.followUpOptionId, id, atMonth);
    attachLifeReview(started);
    const spokenAction = [started?.openingAction, started?.nextAction, started?.completionAction]
      .find((action) => action?.kind === 'communicate');
    if (started && decision.utterance && spokenAction?.kind === 'communicate') {
      spokenAction.content.summary = decision.utterance.slice(0, 180);
    }
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

function executeActiveIntent(
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
  if (project) synchronizeProject(state, project, atMonth);
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
  const recordUseConfidenceBefore = intent.recordUseBasis
    ? person.knowledge.find((knowledge) => knowledge.id === intent.recordUseBasis?.knowledgeId)?.confidence
    : undefined;
  const fact = executeWithCurrentEvidence(() => executeIntentAction(state, person, intent, atMonth, orderInMonth, actionTick));
  if (intent.recordUseBasis && intent.recordUseStage) {
    const basis = intent.recordUseBasis;
    const stage = intent.recordUseStage === 'share'
      ? 'share'
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
      ? compileAgreementContinuations(state, acceptedAgreementId).map((continuation) => installAgreementContinuation(state, intent, continuation, atMonth)).filter(Boolean)
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
      const compiled = recompileNextAction(state, person, intent);
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
      present: action.operation === 'dehydrate',
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

function executeProtectiveInterruption(
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

function recordShelterMaintenanceInterruption(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  actionTick: number,
  events: WorldEvent[],
): void {
  const parent = activeIntent(state, person);
  if (!parent || (!parent.projectId && !parent.returnToIntentId)) return;
  const option: ActionOption = {
    id: `shelter-maintenance:${atMonth}:${actionTick}:${person.id}`,
    summary: '留在真实住所内维持避护',
    reason: '当前冷热压力仍要求维持避护状态',
    goal: { kind: 'sheltered' },
    nextAction: { kind: 'move', toCellId: person.position.cellId, toZ: person.position.z },
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

function structureComponents(state: SimulationState): Array<{ x: number; y: number; z: number; materialId: MaterialId; sourceEventId: string }> {
  const byPosition = new Map<string, { x: number; y: number; z: number; materialId: MaterialId; sourceEventId: string }>();
  for (const event of completedConstructionActions(state)) {
    const materialId = Number(event.diff.outputMaterialId);
    const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (!materialHas(materialId, 'solid') || !materialHas(materialId, 'building')
      || ![position?.x, position?.y, position?.z].every((value) => Number.isInteger(value))) continue;
    const component = { x: Number(position?.x), y: Number(position?.y), z: Number(position?.z), materialId, sourceEventId: event.id };
    if (voxelAt(state.world.grid, component.x, component.y, component.z) !== materialId) continue;
    byPosition.set(`${component.x}:${component.y}:${component.z}`, component);
  }
  return [...byPosition.values()];
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
    const sourceEventIds = group.map((component) => component.sourceEventId);
    const groupKeys = new Set(group.map((position) => `${position.x}:${position.y}:${position.z}`));
    const interiorPositions = occupiedCells.flatMap((cell) => standingPositions(state.world.grid, cell))
      .flatMap((position) => {
        const geometry = shelterGeometryAt(state.world.grid, position);
        if (!geometry) return [];
        const overheadKey = `${cellX(position.cellId)}:${cellY(position.cellId)}:${position.z + 2}`;
        return groupKeys.has(overheadKey) ? [geometry] : [];
      });
    const complete = interiorPositions.length > 0;
    const weatherProtection = interiorPositions.length
      ? Math.round(interiorPositions.reduce((sum, interior) => sum + interior.weatherProtection, 0) / interiorPositions.length)
      : 0;
    const thermalInsulation = interiorPositions.length
      ? Math.round(interiorPositions.reduce((sum, interior) => sum + interior.thermalInsulation, 0) / interiorPositions.length)
      : 0;
    const materialIds = [...new Set(group.map((component) => component.materialId))];
    const materialLabel = materialIds.map((materialId) => materialDefinition(materialId).name).join('、');
    structures.push({
      id: `structure-${originKey}`,
      name: complete ? `${materialLabel}遮蔽结构` : `未完成${materialLabel}结构`,
      occupiedCells,
      interiorCells: [...new Set(interiorPositions.map((interior) => interior.position.cellId))],
      interiorPositions: interiorPositions.map((interior) => interior.position),
      materialIds,
      weatherProtection,
      thermalInsulation,
      capacity: interiorPositions.length,
      complete,
      sourceEventIds,
    });
  }
  return structures;
}

function deriveObservations(state: SimulationState): SimulationState['derived'] {
  const actions = [...actionFacts(state)];
  const transfers = actions.filter((event) => event.action.kind === 'transfer' && event.status === 'completed');
  const containerTransfers = transfers.filter((event) => event.action.kind === 'transfer'
    && (event.action.from.kind === 'container' || event.action.to.kind === 'container'));
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
  const structures = deriveStructures(state);
  const functionalBuildings = observeFunctionalBuildings(state);
  const trailCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.PackedSoil);
  const cultivatedCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.CropSprout || surfaceMaterial(state.world.grid, cell) === Material.CropMature || surfaceMaterial(state.world.grid, cell) === Material.ExhaustedSoil);
  const milestones = observeCapabilityMilestones({
    ...state,
    derived: { ...state.derived, structures },
  });
  const practices: PracticeObservation[] = [
    transfers.length ? { key: 'transfer', label: '反复转移物质', count: transfers.length, agentIds: [...new Set(transfers.map((event) => event.who))], eventIds: transfers.map((event) => event.id), stability: clamp(transfers.length * 5) } : null,
    containerTransfers.length ? { key: 'storage', label: '使用空间容器储藏物质', count: containerTransfers.length, agentIds: [...new Set(containerTransfers.map((event) => event.who))], eventIds: containerTransfers.map((event) => event.id), stability: clamp(containerTransfers.length * 8) } : null,
    movements.length ? { key: 'travel', label: '跨格迁行', count: movements.length, agentIds: [...new Set(movements.map((event) => event.who))], eventIds: movements.map((event) => event.id), stability: clamp(movements.length * 4) } : null,
    cultivation.length ? { key: 'cultivation', label: '种植实践', count: cultivation.length, agentIds: [...new Set(cultivation.map((event) => event.who))], eventIds: cultivation.map((event) => event.id), stability: clamp(cultivation.length * 12) } : null,
  ].filter((item): item is PracticeObservation => Boolean(item));
  const governanceInstitutions: InstitutionObservation[] = state.collectives.flatMap((collective) => collective.decisionRules.flatMap((rule) => {
    const exercisedMandates = collective.mandates.filter((mandate) => mandate.decisionRuleId === rule.id
      && mandate.contributionEventIds.length > 0
      && mandate.distributionEventIds.length > 0);
    if (!exercisedMandates.length) return [];
    return [{
      key: `collective-coordination:${collective.id}:${rule.id}`,
      label: '共同体物质协调职责',
      evidenceEventIds: [...new Set([...rule.sourceEventIds, ...exercisedMandates.flatMap((mandate) => mandate.sourceEventIds)])],
      note: `共同规则至少经过 ${exercisedMandates.length} 次限期授权实践；续任是同一制度的历史，不重复计作新制度。`,
    }];
  }));
  const buildingInstitutions: InstitutionObservation[] = functionalBuildings.flatMap((facility) => {
    const enoughUsers = facility.userIds.length >= 2;
    const evidenceEventIds = [...new Set([...facility.installationEventIds, ...facility.useEventIds])];
    if (!enoughUsers) return [];
    if (facility.kind === 'storage' && facility.useEventIds.length >= 4) return [{
      key: `reserve-management:${facility.id}`,
      label: '公共储备管理',
      evidenceEventIds,
      note: '谷仓经过多人反复存取，储备开始脱离单个背包并形成共同维护实践。',
    }];
    if (facility.kind === 'water' && facility.useEventIds.length >= 3) return [{
      key: `water-maintenance:${facility.id}`,
      label: '公共蓄水维护',
      evidenceEventIds,
      note: '固定蓄水点被多人持续使用，供水成为聚落必须维护的公共能力。',
    }];
    if ((facility.kind === 'workshop' || facility.kind === 'mill') && facility.useEventIds.length >= 6) return [{
      key: `${facility.kind === 'mill' ? 'land-processing' : 'workshop-practice'}:${facility.id}`,
      label: facility.kind === 'mill' ? '定居作物加工' : '固定工坊分工',
      evidenceEventIds,
      note: '多人在固定生产设施附近反复完成工作，个人技巧开始成为可共享的岗位实践。',
    }];
    if (['kiln', 'foundry', 'smithy'].includes(facility.kind) && facility.useEventIds.length >= 6) return [{
      key: `metalwork-standard:${facility.id}`,
      label: '高温材料加工规范',
      evidenceEventIds,
      note: '高温设施由多名生产者反复使用，材料批次、燃料与操作顺序形成可复现规范。',
    }];
    if (facility.kind === 'core' && facility.useEventIds.length >= 4) return [{
      key: `coordination-core:${facility.id}`,
      label: '固定议事与协调场所',
      evidenceEventIds,
      note: '多人在同一核心建筑反复沟通、教导或达成安排，协调不再只依赖偶遇。',
    }];
    return [];
  });
  const apprenticeshipActions = actions.filter((event) => event.status === 'completed'
    && (Array.isArray(event.diff.taughtAudienceIds) && event.diff.taughtAudienceIds.length > 0
      || Boolean(event.diff.techniqueDemonstrationVerified)));
  const apprenticeshipAgents = new Set(apprenticeshipActions.flatMap((event) => [
    event.who,
    ...(Array.isArray(event.diff.taughtAudienceIds) ? event.diff.taughtAudienceIds.map(String) : []),
  ]));
  const apprenticeshipInstitutions: InstitutionObservation[] = apprenticeshipActions.length >= 6 && apprenticeshipAgents.size >= 3
    ? [{
      key: 'apprentice-craft:distributed-teaching',
      label: '跨人技术传习',
      evidenceEventIds: apprenticeshipActions.map((event) => event.id),
      note: '可靠技术被多次明确教导或示范，不再只保存在原生产者身上。',
    }]
    : [];
  const institutions = [...governanceInstitutions, ...buildingInstitutions, ...apprenticeshipInstitutions];
  const regions: EmergentRegion[] = [];
  const waterCells = Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => cell).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.Water || surfaceMaterial(state.world.grid, cell) === Material.Ice);
  if (waterCells.length) regions.push({ id: 'natural-water', kind: 'natural', cells: waterCells, confidence: 1, evidenceEventIds: [], firstObservedMonth: 0, lastObservedMonth: state.clock.elapsedMonths, label: '水域' });
  if (trailCells.length) regions.push({ id: 'travel-trail', kind: 'trail', cells: trailCells, confidence: clamp(trailCells.length / 20), evidenceEventIds: trailFormation.map(({ event }) => event.id), firstObservedMonth: trailFormation[0]?.event.atMonth ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '夯土通行带' });
  if (cultivatedCells.length) regions.push({ id: 'cultivated', kind: 'cultivated', cells: cultivatedCells, confidence: clamp(cultivatedCells.length / 12), evidenceEventIds: [...cultivation, ...harvests].map((event) => event.id), firstObservedMonth: cultivation[0]?.atMonth ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '耕作区' });
  for (const structure of structures.filter((item) => item.complete)) regions.push({ id: `residential-${structure.id}`, kind: 'residential', cells: structure.occupiedCells, confidence: structure.weatherProtection / 100, evidenceEventIds: structure.sourceEventIds, firstObservedMonth: structure.sourceEventIds.map((id) => worldEventById(state, id)?.atMonth).find((month) => month !== undefined) ?? state.clock.elapsedMonths, lastObservedMonth: state.clock.elapsedMonths, label: '建造活动区' });
  return { practices, institutions, milestones, regions, structures, functionalBuildings };
}

function currentRollingLedgers(state: SimulationState): DecisionMonthLedger[] {
  return rollingDecisionUsage(state.decisionBudget.ledgers, state.clock.elapsedMonths);
}

function prepareMonth(input: SimulationState, cloneInput = true, collectEnhancementCandidates = true) {
  const state = cloneInput ? copyState(input) : input;
  if (state.civilization.status === 'ended') return { state, events: [] as WorldEvent[], contexts: [] as DecisionContext[], candidates: [] as DecisionContext[], livingAgents: state.people.filter(isAlive).length, atMonth: state.clock.elapsedMonths };
  const atMonth = state.clock.elapsedMonths + 1;
  for (const person of state.people.filter(isAlive)) {
    person.position.previousCellId = person.position.cellId;
    person.position.previousZ = person.position.z;
    person.position.lastPath = [person.position.cellId];
    person.position.tickPath = [person.position.cellId];
  }
  const climateEvents = resolveClimate(state, atMonth);
  const eraTransition = climateEvents.some((candidate) => candidate.diff.eraTransition === true);
  const events: WorldEvent[] = [
    ...climateEvents,
    ...advanceEraPredictions(state, atMonth, eraTransition),
    ...resolveWeather(state, atMonth),
    ...advanceWorldProcesses(state, atMonth),
  ];
  events.push(...advanceAgreementLifecycle(state, atMonth, events.length));
  events.push(...advancePermissionLifecycle(state, atMonth, events.length));
  maintainMemories(state, atMonth);
  const livingAgents = state.people.filter(isAlive).length;
  if (!collectEnhancementCandidates) {
    return { state, events, contexts: [] as DecisionContext[], candidates: [] as DecisionContext[], livingAgents, atMonth };
  }
  const contexts = buildDecisionContexts(state);
  const candidates: DecisionContext[] = [];
  for (const context of contexts) {
    const { probability, reasons } = decisionProbability(state, context);
    const sample = seededFraction(state.seed, `decision:${state.branchId}:${atMonth}:${context.person.id}`);
    const exemption = decisionBudgetExemption(context, atMonth);
    const reviewDue = stateGoalReviewDue(context, atMonth);
    if (exemption === 'bootstrap') reasons.push('开局批量初始决策');
    else if (exemption === 'emergency') reasons.push('紧急状态需要立即重评');
    else if (exemption === 'required-response') reasons.push('必须回应一项社会请求');
    else if (exemption === 'fulfillment') reasons.push('已有承诺或职责等待履行');
    if (reviewDue) reasons.push('持续状态目标到达复核月份');
    const meaningful = !context.activeIntent
      || exemption !== null
      || reviewDue
      || (context.activeIntent && state.clock.elapsedMonths - context.activeIntent.lastProgressAtMonth >= 2);
    const triggered = meaningful && (exemption !== null || reviewDue || sample < probability);
    const opportunity: DecisionOpportunityFact = {
      id: `e-${atMonth}-opportunity-${context.person.id}`,
      kind: 'decision-opportunity', atMonth, orderInMonth: events.length, planningTick: 0, orderInTick: events.length,
      who: context.person.id, cellId: context.person.position.cellId,
      probability, sample, triggered, reasons,
      result: triggered
        ? exemption === 'bootstrap'
          ? `${context.person.name}获得开局初始决策`
          : exemption === 'required-response'
            ? `${context.person.name}本月必须回应一项社会请求`
            : `${context.person.name}本月重新考虑下一步`
        : `${context.person.name}本月延续已有意图`,
    };
    events.push(opportunity);
    if (triggered) candidates.push(context);
  }
  return { state, events, contexts, candidates, livingAgents, atMonth };
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

function finishMonth(state: SimulationState, events: WorldEvent[], atMonth: number, projectionCadence: 'monthly' | 'annual'): SimulationState {
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
  const endpointReached = state.civilization.conditions.endpoint.kind === 'months'
    && atMonth >= state.civilization.conditions.endpoint.value;
  const fullProjection = projectionCadence === 'monthly'
    || state.civilization.conditions.endpoint.kind === 'milestones'
    || atMonth % MONTHS_PER_YEAR === 0
    || endpointReached
    || living.length === 0;
  state.derived = fullProjection
    ? deriveObservations(state)
    : { ...state.derived, structures: deriveStructures(state) };
  if (fullProjection) {
    updateDevelopmentObservation(state);
  }
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

interface ModelAttemptSummary {
  total: number;
  ordinary: number;
  exempt: number;
}

const authoritativeRulePlanner = new RulePlanner();

function hasPendingAgreementWork(state: SimulationState, person: PersonState, active: Intent | undefined): boolean {
  return state.agreements.some((agreement) => {
    const coveredByActiveIntent = active?.agreementId === agreement.id
      || Boolean(active?.sourceFactIds?.some((factId) => agreement.sourceEventIds.includes(factId)));
    if (agreement.status === 'proposed') {
      return agreement.requiredResponderIds.includes(person.id)
        && !agreement.acceptedByPersonIds.includes(person.id)
        && !agreement.rejectedByPersonIds.includes(person.id)
        && !coveredByActiveIntent;
    }
    const hasContinuation = compileAgreementContinuations(state, agreement.id)
      .some((continuation) => continuation.personId === person.id);
    if (agreement.status === 'active'
      && agreement.proposal.kind === 'reproduce'
      && agreement.partyIds.includes(person.id)) return true;
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
  if (hasPendingAgreementWork(state, person, active)) return true;
  if (planningTick === 1 && (
    person.body.health < 35
    || person.body.hydration < 28
    || person.body.nutrition < 28
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
) {
  const previewState: SimulationState = {
    ...state,
    projects: cloneMutableProjectsForPlanning(state.projects),
  };
  const previewPerson = previewState.people.find((candidate) => candidate.id === person.id);
  if (!previewPerson) return null;
  return groundedLifeReviewOpportunity(buildDecisionContext(previewState, previewPerson));
}

function previewDemandBoundRecordUseOpportunity(state: SimulationState, person: PersonState): boolean {
  const previewState: SimulationState = {
    ...state,
    projects: cloneMutableProjectsForPlanning(state.projects),
  };
  const previewPerson = previewState.people.find((candidate) => candidate.id === person.id);
  return Boolean(previewPerson && buildDecisionContext(previewState, previewPerson).options.some((option) => option.recordUseBasis));
}

function planLocallyForTick(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  planningTick: number,
  events: WorldEvent[],
  planner: AgentDecider,
  reviewedPeople: Set<PersonId>,
): void {
  if (!personCanDecide(state, person)) return;
  const fullReview = needsFullPlanningReview(state, person, atMonth, planningTick);
  const current = activeIntent(state, person);
  const checkLifeOpportunity = planningTick === 1 && Boolean(current?.projectId);
  const holdsRecordCarrier = person.inventory.some((stack) => stack.quantity > 0
    && stack.materialId === Material.WoodTablet
    && typeof stack.recordPayloadId === 'string');
  const checkRecordUseOpportunity = Boolean(current?.projectId)
    && !current?.recordUseBasis
    && holdsRecordCarrier;
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
  const planningEvidence = [...lifeReviewEvents, ...currentMonthGroundedOpenings];
  const planningState = planningEvidence.length ? { ...state } : state;
  if (planningState !== state) registerPlanningEventOverlay(planningState, planningEvidence);
  const planningPerson = planningState.people.find((candidate) => candidate.id === person.id) ?? person;
  const hasCurrentMonthOpening = currentMonthGroundedOpenings.length > 0;
  let compiledContext: DecisionContext | undefined;
  const contextForPlanning = (): DecisionContext => compiledContext ??= buildDecisionContext(planningState, planningPerson);
  const checkGroundedConversationResponse = hasCurrentMonthOpening
    ? contextForPlanning().options.some((option) => option.id.startsWith('respond-conversation:'))
    : hasGroundedConversationResponseOpportunity(state, person);
  const alreadyReviewed = reviewedPeople.has(person.id);
  if (alreadyReviewed && !checkTechniqueRequest && !checkGroundedConversationResponse) return;
  if (!fullReview && !checkLifeOpportunity && !checkRecordUseOpportunity && !checkTechniqueRequest && !checkGroundedConversationResponse) return;
  if (!fullReview) {
    const hasLifeOpportunity = !alreadyReviewed && checkLifeOpportunity
      && !lifeReviewEvents.length
      && Boolean(previewGroundedLifeReviewOpportunity(state, person));
    const hasRecordUseOpportunity = checkRecordUseOpportunity
      && previewDemandBoundRecordUseOpportunity(state, person);
    const hasTechniqueDemonstration = checkTechniqueRequest
      && contextForPlanning().options
        .some((option) => option.id.startsWith('demonstrate-technique:'));
    if (!hasLifeOpportunity && !hasRecordUseOpportunity && !hasTechniqueDemonstration && !checkGroundedConversationResponse) return;
  }
  // Current-month requests are persisted on their project immediately; the
  // event itself joins world.past at month end. Life-review evidence remains
  // person-local while the addressed teacher can respond on the next tick.
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

function executePrepared(
  prepared: ReturnType<typeof prepareMonth>,
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
    const person = state.people.find((item) => item.id === candidate.person.id);
    if (!person || !isAlive(person)) continue;
    const freshContext = buildDecisionContext(state, person);
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
      if (isDehydratedHibernating(person)) {
        person.currentActionText = '处于脱水休眠，以极低代谢等待环境稳定';
        continue;
      }
      const causalShelterWork = hasCausalShelterAdaptationNeed(state, person);
      const reflex = chooseSurvivalReflex(state, person, { suppressThermalShelter: causalShelterWork });
      const dependentChild = lifePlanningStage(person, state.clock.elapsedMonths) === 'dependent-child';
      const awaitingCaregiver = dependentChild && hasCoLocatedLivingParent(state, person);
      const dependentCare = dependentChild
        ? null
        : chooseDependentCareReflex(state, person, { suppressThermalShelter: causalShelterWork });
      const careIsMoreUrgent = Boolean(dependentCare)
        && (!reflex || dependentCareUrgency(state, person) > survivalReflexUrgency(person));
      if (careIsMoreUrgent && dependentCare) {
        const fact = executeProtectiveInterruption(state, person, dependentCare, 'dependent-care', atMonth, actionTick, events);
        person.currentActionText = fact.result;
        continue;
      }
      if (reflex && !(dependentChild && reflex.kind === 'move')) {
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
        const fact = executeProtectiveInterruption(state, person, dependentCare, 'dependent-care', atMonth, actionTick, events);
        person.currentActionText = fact.result;
        continue;
      }
      const maintainingShelter = shouldRemainSheltered(state, person)
        || shouldRemainShelteredForDependent(state, person);
      if (maintainingShelter && !causalShelterWork) {
        recordShelterMaintenanceInterruption(state, person, atMonth, actionTick, events);
        person.currentActionText = '留在住所内维持避护状态';
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
  return finishMonth(state, events, atMonth, projectionCadence);
}

export function stepSimulation(input: SimulationState, decider: AgentDecider = authoritativeRulePlanner): SimulationState {
  const prepared = prepareMonth(input);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) decisions.set(context.person.id, { decision: decider.decide(context), usedModel: false });
  return executePrepared(prepared, decisions, { inputTokens: 0, outputTokens: 0 }, { total: 0, ordinary: 0, exempt: 0 }, decider);
}

/**
 * 模型只能在本地已编译的候选中选择。这里再次使用完整领域上下文校验，
 * 因而协议层只检查 ID 仍不足以让建议进入权威意图。
 */
function validateModelDecision(
  context: DecisionContext,
  proposed: Decision,
  localDecision: Decision,
): Decision | null {
  const required = context.options.filter(isRequiredSocialOption);
  const fulfillment = context.options.filter(isFulfillmentOption);
  if (proposed.kind === 'idle') {
    return required.length || fulfillment.length ? null : proposed;
  }
  if (proposed.kind !== 'start' && proposed.kind !== 'revise') return null;
  const selected = context.options.find((option) => option.id === proposed.optionId);
  if (!selected) return null;
  if (required.length && !required.some((option) => option.id === selected.id)) return null;
  if (!required.length && fulfillment.length && !fulfillment.some((option) => option.id === selected.id)) return null;
  if (!composeIntentChoice(context.options, context.followUpOptions, selected.id, proposed.followUpOptionId)) return null;

  const communication = selected.nextAction.kind === 'communicate'
    ? selected.nextAction
    : selected.completionAction?.kind === 'communicate'
      ? selected.completionAction
      : null;
  const proposedUtterance = proposed.utterance?.trim();
  const contradictoryStructuredReply = Boolean(proposedUtterance && communication) && (
    communication?.content.kind === 'accept'
      ? /拒绝|不同意|不愿意|不接受|[?？]/u.test(proposedUtterance ?? '')
      : communication?.content.kind === 'reject'
        ? /同意|接受|愿意|成交/u.test(proposedUtterance ?? '')
        : false
  );

  const shared = {
    optionId: selected.id,
    ...(proposed.followUpOptionId ? { followUpOptionId: proposed.followUpOptionId } : {}),
    reason: proposed.reason,
    ...(proposedUtterance && !contradictoryStructuredReply ? { utterance: proposedUtterance } : {}),
  };
  const active = context.activeIntent;
  if (!active) return { kind: 'start', ...shared };
  if (proposed.kind === 'revise' && proposed.intentId !== active.id) return null;

  const localForSameOption = localDecision.kind === 'revise' && localDecision.optionId === selected.id
    ? localDecision
    : null;
  const interruptionKind = required.length
    ? 'required-response' as const
    : fulfillment.length
      ? 'fulfillment' as const
      : selected.recordUseBasis
        ? 'record-use' as const
        : localForSameOption?.interruptionKind;
  const canInterrupt = Boolean(active.projectId || active.returnToIntentId);
  return {
    kind: 'revise',
    intentId: active.id,
    ...shared,
    ...(canInterrupt && interruptionKind ? { mode: 'interrupt' as const, interruptionKind } : {}),
    ...(localForSameOption?.lifeReview ? { lifeReview: structuredClone(localForSameOption.lifeReview) } : {}),
  };
}

function stepOwnedSimulation(input: SimulationState): SimulationState {
  const prepared = prepareMonth(input, false, false);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) {
    decisions.set(context.person.id, {
      decision: authoritativeRulePlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 }),
      usedModel: false,
    });
  }
  return executePrepared(
    prepared,
    decisions,
    { inputTokens: 0, outputTokens: 0 },
    { total: 0, ordinary: 0, exempt: 0 },
    authoritativeRulePlanner,
    'annual',
  );
}

export async function stepSimulationAsync(input: SimulationState, batch: BatchDecider): Promise<SimulationState> {
  const prepared = prepareMonth(input);
  const living = prepared.contexts.length;
  const rolling = currentRollingLedgers(prepared.state);
  const eligibleCandidates = batch.shouldDecide
    ? prepared.candidates.filter((context) => batch.shouldDecide?.(context, prepared.atMonth))
    : prepared.candidates;
  const exemptContexts = eligibleCandidates.filter((context) => decisionBudgetExemption(context, prepared.atMonth) !== null);
  const ordinaryCandidates = eligibleCandidates.filter((context) => decisionBudgetExemption(context, prepared.atMonth) === null);
  const ordinaryCapacity = Math.min(
    ordinaryCandidates.length,
    Math.floor(prepared.state.decisionBudget.credits + living / ORDINARY_DECISION_PERSON_MONTHS),
    availableModelContexts(rolling, living),
    Math.floor(availableModelTokens(rolling, living, prepared.state.decisionBudget.tokensPerContext) / prepared.state.decisionBudget.tokensPerContext),
  );
  const importance = (context: DecisionContext) => {
    const exemption = decisionBudgetExemption(context, prepared.atMonth);
    let score = exemption === 'bootstrap'
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
      const monthsSince = prepared.state.clock.elapsedMonths - lastDecisionMonth;
      score -= Math.max(0, 6 - monthsSince) * 60;
    }
    return score;
  };
  const rank = (contexts: DecisionContext[]) => [...contexts]
    .sort((a, b) => importance(b) - importance(a) || urgency(b) - urgency(a) || a.person.id.localeCompare(b.person.id));
  const ordinaryContexts = rank(ordinaryCandidates).slice(0, ordinaryCapacity);
  const modelContexts = rank([...exemptContexts, ...ordinaryContexts]);
  const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) {
    decisions.set(context.person.id, {
      decision: authoritativeRulePlanner.decideAt(context, { atMonth: prepared.atMonth, planningTick: 1 }),
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
    prepared,
    decisions,
    batch.takeUsage?.() ?? { inputTokens: 0, outputTokens: 0 },
    { total: modelContexts.length, ordinary: ordinaryContexts.length, exempt: exemptContexts.length },
  );
  const ledger = result.decisionBudget.ledgers.at(-1);
  if (metadata && ledger?.modelContexts) {
    ledger.modelEndpointId = metadata.endpointId;
    ledger.modelProtocol = metadata.protocol;
    ledger.modelName = metadata.model;
  }
  return result;
}

export function restoreSimulationState(input: SimulationState): SimulationState {
  const version = Number((input as { schemaVersion?: number }).schemaVersion);
  if (version !== 17) throw new Error('当前开发版本只接受 schemaVersion 17；请新建文明运行');
  const state = structuredClone(input);
  state.schemaVersion = 17;
  if (state.civilization.conditions.endpoint.kind === 'months') {
    state.civilization.conditions.endpoint.value = Math.min(
      MAX_SIMULATION_MONTHS,
      Math.max(1, Math.round(state.civilization.conditions.endpoint.value)),
    );
  }
  state.world.animals ??= [];
  state.civilization.weather ??= { kind: 'clear', intensity: 1, sinceMonth: state.clock.elapsedMonths };
  state.civilization.civilizationIndex ??= emptyCivilizationIndex(state.clock.elapsedMonths);
  delete (state.civilization as SimulationState['civilization'] & { integrity?: number }).integrity;
  state.records ??= [];
  state.collectives ??= [];
  state.permissions ??= [];
  state.containers ??= [];
  state.eraPredictions ??= [];
  state.projects ??= [];
  state.civilization.era ??= initialEraSchedule(state.seed, state.civilization.conditions.chaosIntensity);
  if (!state.world.traffic) {
    state.world.traffic = {};
    for (const event of state.world.past) {
      if (event.kind !== 'action') continue;
      const verticalPath = Array.isArray(event.diff.verticalPath) ? event.diff.verticalPath : [];
      event.pathSegment.slice(1).forEach((cellId, index) => {
        const z = Number(verticalPath[index + 1] ?? event.toZ);
        const key = `${cellId}:${z}`;
        state.world.traffic![key] = (state.world.traffic![key] ?? 0) + 1;
      });
    }
  }
  for (const agreement of state.agreements) {
    agreement.requiredResponderIds ??= [agreement.responderId];
    agreement.acceptedByPersonIds ??= agreement.status === 'proposed'
      ? [agreement.proposerId]
      : agreement.status === 'rejected'
        ? [agreement.proposerId]
        : [...agreement.partyIds];
    agreement.rejectedByPersonIds ??= agreement.status === 'rejected' ? [agreement.responderId] : [];
  }
  state.world.grid = hydrateWorld(input.world.grid);
  ensureNamingMetadata(state.people);
  for (const drop of state.world.drops) {
    drop.z = Number.isInteger(drop.z) ? drop.z : surfaceStandingPosition(state.world.grid, drop.cellId)?.z ?? 1;
  }
  for (const person of state.people) {
    person.knownPlaces ??= [];
    person.geneticLoad = Number.isFinite(person.geneticLoad) ? clamp(person.geneticLoad, 0, 1) : 0;
    const start = person.position.previousCellId ?? person.position.cellId;
    const migratedPosition = surfaceStandingPosition(state.world.grid, person.position.cellId);
    person.position.z = Number.isInteger(person.position.z) ? person.position.z : migratedPosition?.z ?? Math.min(state.world.grid.levels - 2, Math.max(1, topZ(state.world.grid, person.position.cellId) + 1));
    person.position.previousZ = Number.isInteger(person.position.previousZ) ? person.position.previousZ : person.position.z;
    person.position.lastPath = person.position.lastPath?.length ? person.position.lastPath : [start, person.position.cellId];
    person.position.tickPath = person.position.tickPath?.length
      ? person.position.tickPath
      : Array.from({ length: PLANNING_TICKS_PER_MONTH + 1 }, (_, index) => index === PLANNING_TICKS_PER_MONTH ? person.position.cellId : start);
  }
  for (const collective of state.collectives) {
    collective.decisionRules ??= [];
    collective.mandates ??= [];
  }
  for (const event of state.world.past) {
    event.planningTick ??= event.kind === 'action' ? event.actionTick : 0;
    event.orderInTick ??= event.orderInMonth;
    if (event.kind !== 'action') continue;
    event.fromZ = Number.isInteger(event.fromZ)
      ? event.fromZ
      : surfaceStandingPosition(state.world.grid, event.fromCellId)?.z ?? 1;
    event.toZ = Number.isInteger(event.toZ)
      ? event.toZ
      : surfaceStandingPosition(state.world.grid, event.toCellId)?.z ?? event.fromZ;
  }
  for (const intent of state.intents) {
    if (intent.agreementId) continue;
    const agreement = state.agreements.find((candidate) => candidate.status === 'active'
      && (intent.sourceFactIds ?? []).includes(candidate.proposalEventId)
      && Boolean(candidate.responseEventId && (intent.sourceFactIds ?? []).includes(candidate.responseEventId)));
    if (agreement) intent.agreementId = agreement.id;
  }
  state.derived = deriveObservations(state);
  updateDevelopmentObservation(state);
  primeEventIndex(state);
  return state;
}

export interface SimulationController {
  getState(): SimulationState;
  step(count?: number): SimulationState;
  /** Trusted session path: advances and returns the owned state without a second full-history clone. */
  stepOwned(count?: number): SimulationState;
  stepAsync(batch: BatchDecider, count?: number): Promise<SimulationState>;
  stepAsyncOwned(batch: BatchDecider, count?: number): Promise<SimulationState>;
  reset(): SimulationState;
  restore(saved: SimulationState): void;
  setExternalClimate(epoch: EpochKind, kind: ClimateKind, severity: number): void;
  injectEvent(input: EnvironmentEventInput): SimulationState;
}

export function createSimulation(options: { seed?: number; config?: Partial<SimulationConfig>; state?: SimulationState } = {}): SimulationController {
  let state = options.state ? restoreSimulationState(options.state) : createInitialState(options.seed, options.config);
  return {
    getState: () => copyState(state),
    step(count = 1) {
      for (let index = 0; index < count; index += 1) state = stepOwnedSimulation(state);
      return copyState(state);
    },
    stepOwned(count = 1) {
      for (let index = 0; index < count; index += 1) state = stepOwnedSimulation(state);
      return state;
    },
    async stepAsync(batch, count = 1) {
      for (let index = 0; index < count; index += 1) state = await stepSimulationAsync(state, batch);
      return copyState(state);
    },
    async stepAsyncOwned(batch, count = 1) {
      for (let index = 0; index < count; index += 1) state = await stepSimulationAsync(state, batch);
      return state;
    },
    reset() {
      state = createInitialState(options.seed ?? state.seed, state.civilization.conditions);
      return copyState(state);
    },
    restore(saved) {
      state = restoreSimulationState(saved);
    },
    setExternalClimate(epoch, kind, severity) {
      state.civilization.externalClimate = { epoch, kind, severity: clamp(severity, 1, 10) };
    },
    injectEvent(input) {
      if (!isCellId(input.cellId)) throw new Error('环境事件 cellId 无效');
      const atMonth = state.clock.elapsedMonths;
      const event: EnvironmentFact = {
        id: `e-${atMonth}-injected-${state.world.past.length}`,
        kind: 'environment', atMonth, orderInMonth: 0, planningTick: 0, orderInTick: 0, cellId: input.cellId,
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
    schemaVersion: 17,
    exportedAt: new Date().toISOString(),
    civilization: structuredClone(finalState.civilization),
    finalState: copyState(finalState),
    checkpoints: checkpoints.map(copyState),
    review: { milestones: structuredClone(finalState.derived.milestones), eventCount: finalState.world.past.length },
  };
}
