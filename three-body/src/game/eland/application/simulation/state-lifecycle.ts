import { CHARACTER_PROFILES, type CharacterProfile } from '../../character-profiles';
import {
  createFounderAgeMonths,
  createLifespanMonths,
  deterministicFraction,
} from '../../population';
import { MONTHS_PER_YEAR, PLANNING_TICKS_PER_MONTH } from '../../domain/calendar';
import { createInitialAnimals } from '../../domain/animal';
import { emptyCivilizationIndex } from '../../domain/civilization-index';
import { createCognitionState, ensureCognitionState } from '../../domain/cognition';
import { primeEventIndex, worldEventById } from '../../domain/event-index';
import { historyEventCount, initializeHistoryCursorFromFullHistory } from '../../domain/history';
import { Material } from '../../domain/material';
import {
  MECHANICAL_POWER_WORLD_VERSION,
  emptyMechanicalPowerWorldState,
  migrateMechanicalPowerWorldState,
} from '../../domain/mechanical-power';
import { initialEraSchedule } from '../../domain/monthly-processes';
import {
  copyPhysicalStructures,
  derivePhysicalStructureIndex,
} from '../../domain/physical-structure-index';
import type {
  EnvironmentFact,
  EvolutionReport,
  SimulationConfig,
  SimulationState,
} from '../../domain/model';
import type { PersonState } from '../../domain/person';
import { createMotiveSensitivity, createPersonality } from '../../domain/personality';
import { FOUNDER_INITIAL_RELATION } from '../../domain/relation';
import {
  applyTraitCapacityModifiers,
  applyTraitLifespanModifier,
  founderTraitsFor,
  grantProphetKnowledge,
  inheritPersonTraits,
  normalizePersonTraits,
  traitDefinition,
} from '../../domain/trait';
import { normalizeAnimalEcologies } from '../../domain/wildlife-ecology';
import { inferNamingIdentity } from '../../naming';
import {
  hydrateWorld,
  surfaceStandingPosition,
  topZ,
} from '../../world/grid';
import {
  CURRENT_WORLD_GENERATOR_VERSION,
  generateVoxelWorld,
  mechanicalPowerWorldForSeed,
} from '../../world/generator';
import type { ObservationProjector } from './observation-projector';
import { cloneValidatedSocialLearningState } from './social-learning-state';
import { clamp, copyState } from './state-utils';

export const MAX_SIMULATION_YEARS = 1_000;
export const MAX_SIMULATION_MONTHS = MAX_SIMULATION_YEARS * MONTHS_PER_YEAR;
const MIN_FOUNDER_COUNT = 5;
const MAX_FOUNDER_COUNT = 12;

function chooseProfiles(seed: number, civilizationNo: number, characterIds?: string[]): CharacterProfile[] {
  if (characterIds?.length) {
    const wanted = new Set(characterIds);
    const chosen = CHARACTER_PROFILES.filter((profile) => wanted.has(profile.id));
    if (chosen.length) return chosen.slice(0, MAX_FOUNDER_COUNT);
  }
  return [...CHARACTER_PROFILES]
    .sort((a, b) => deterministicFraction(seed + civilizationNo * 991, `profile:${a.id}`) - deterministicFraction(seed + civilizationNo * 991, `profile:${b.id}`))
    .slice(0, MIN_FOUNDER_COUNT + Math.floor(
      deterministicFraction(seed, `population:${civilizationNo}`)
      * (MAX_FOUNDER_COUNT - MIN_FOUNDER_COUNT + 1),
    ));
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
    ...(overrides.characterIds?.length ? { characterIds: [...new Set(overrides.characterIds)].slice(0, MAX_FOUNDER_COUNT) } : {}),
  };
}

const FOUNDER_COHORT_EVENT_ID = 'e-0-environment-founding-0';
const LEGACY_REQUIRED_SOCIAL_OPTION = /^(?:(?:accept|reject)-(?:assist|companion|exchange|reproduce|collective|membership|permission|decision-rule|mandate):|respond-conversation:)/;
const LEGACY_FULFILLMENT_OPTION = /^(?:settle-exchange|fulfill-assist|meet-to-assist|join-water-assist|return-shared-living|contribute-mandate|distribute-mandate|use-permission|reproduce|withdraw-reproduce):/;

function legacyDecisionCreatedObligationIntent(
  state: SimulationState,
  intent: SimulationState['intents'][number],
): boolean {
  const source = worldEventById(state, intent.sourceDecisionEventId);
  if (source?.kind !== 'decision'
    || source.intentId !== intent.id
    || source.who !== intent.ownerId
    || (source.decision.kind !== 'start' && source.decision.kind !== 'revise')) return false;
  return [source.decision.optionId, source.decision.followUpOptionId]
    .filter((optionId): optionId is string => typeof optionId === 'string')
    .some((optionId) => LEGACY_REQUIRED_SOCIAL_OPTION.test(optionId)
      || LEGACY_FULFILLMENT_OPTION.test(optionId));
}

function initialPerson(seed: number, profile: CharacterProfile, spawnCell: number, spawnZ: number, profiles: CharacterProfile[]): PersonState {
  const founderAge = createFounderAgeMonths(seed, profile.id);
  const capacity = (key: string, floor: number, span: number) => floor + Math.floor(deterministicFraction(seed, `${key}:${profile.id}`) * span);
  const traits = founderTraitsFor(profile.id, FOUNDER_COHORT_EVENT_ID);
  const person: PersonState = {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    profile: { description: profile.description },
    bornAtMonth: -founderAge,
    lifespanMonths: applyTraitLifespanModifier(createLifespanMonths(seed, profile.id, founderAge), traits),
    sex: profile.sex,
    familyName: profile.familyName,
    namingTradition: profile.namingTradition,
    geneticParents: [],
    generation: 0,
    geneticLoad: 0,
    traits,
    position: { cellId: spawnCell, z: spawnZ, previousCellId: spawnCell, previousZ: spawnZ, lastPath: [spawnCell], tickPath: [spawnCell] },
    body: { health: 92, hydration: 82, nutrition: 78 },
    baselineCapacities: applyTraitCapacityModifiers({
      locomotion: capacity('locomotion', 48, 35),
      manipulation: capacity('manipulation', 45, 35),
      perception: capacity('perception', 42, 40),
      communication: capacity('communication', 42, 40),
      cognition: capacity('cognition', 42, 40),
    }, traits),
    personality: createPersonality(seed, profile.id),
    cognition: createCognitionState(),
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
    bereavements: [],
    currentActionText: '观察身边的物质',
    lastDecisionText: '尚未作出关键决定',
  };
  grantProphetKnowledge(person, 0, FOUNDER_COHORT_EVENT_ID);
  return person;
}

export function createInitialState(
  observationProjector: ObservationProjector,
  seed = 17,
  inputConfig: Partial<SimulationConfig> = {},
): SimulationState {
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
    diff: {
      participantIds: people.map((person) => person.id),
      traitsByPersonId: Object.fromEntries(people
        .filter((person) => person.traits?.length)
        .map((person) => [person.id, person.traits!.map((trait) => ({ id: trait.id, name: traitDefinition(trait.id).name }))])),
    },
  };
  const state: SimulationState = {
    schemaVersion: 17,
    seed,
    branchId: `root-${seed}-${config.civilizationNo}`,
    identityCounters: { intentOrdinal: 0 },
    clock: { unit: 'month', elapsedMonths: 0, monthsPerYear: MONTHS_PER_YEAR },
    world: {
      grid: generated.world,
      drops: generated.drops,
      animals: createInitialAnimals(seed, generated.world, generated.spawnCells.slice(0, people.length)),
      remains: [],
      memorials: [],
      past: [foundingFact],
      historyCursor: {
        version: 1,
        eventCount: 1,
        hotStartIndex: 0,
        tailEventId: foundingFact.id,
      },
      traffic: {},
      mechanicalPower: generated.mechanicalPower,
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
  const physicalStructureIndex = derivePhysicalStructureIndex(state);
  state.world.physicalStructureIndex = physicalStructureIndex;
  state.derived.structures = copyPhysicalStructures(physicalStructureIndex);
  observationProjector.project(state, 'development-only');
  return state;
}

/**
 * Normalize a state whose ownership has been transferred to the simulation.
 *
 * This is a trusted infrastructure path: callers must stop using `input` as an
 * independently mutable snapshot after the call. Public restore paths use
 * `restoreSimulationState`, which preserves their copy-in isolation.
 */
export function adoptSimulationState(
  observationProjector: ObservationProjector,
  input: SimulationState,
): SimulationState {
  const version = Number((input as { schemaVersion?: number }).schemaVersion);
  if (version !== 17) throw new Error('当前开发版本只接受 schemaVersion 17；请新建文明运行');
  const state = input;
  state.schemaVersion = 17;
  if (state.civilization.conditions.endpoint.kind === 'months') {
    state.civilization.conditions.endpoint.value = Math.min(
      MAX_SIMULATION_MONTHS,
      Math.max(1, Math.round(state.civilization.conditions.endpoint.value)),
    );
  }
  state.world.animals ??= [];
  state.world.remains ??= [];
  state.world.memorials ??= [];
  normalizeAnimalEcologies(state.world.animals);
  state.civilization.weather ??= { kind: 'clear', intensity: 1, sinceMonth: state.clock.elapsedMonths };
  state.civilization.civilizationIndex ??= emptyCivilizationIndex(state.clock.elapsedMonths);
  delete (state.civilization as SimulationState['civilization'] & { integrity?: number }).integrity;
  state.records ??= [];
  state.collectives ??= [];
  state.permissions ??= [];
  state.containers ??= [];
  state.eraPredictions ??= [];
  state.projects ??= [];
  const persistedIntentOrdinal = state.identityCounters?.intentOrdinal;
  const compatibleIntentOrdinal = typeof persistedIntentOrdinal === 'number'
    && Number.isSafeInteger(persistedIntentOrdinal)
    && persistedIntentOrdinal >= 0
    ? persistedIntentOrdinal
    : state.intents.length;
  state.identityCounters = {
    ...state.identityCounters,
    intentOrdinal: Math.max(state.intents.length, compatibleIntentOrdinal),
  };
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
  state.world.grid = hydrateWorld(state.world.grid);
  if (state.world.mechanicalPower?.version !== MECHANICAL_POWER_WORLD_VERSION) {
    state.world.mechanicalPower = state.world.grid.generator.version === CURRENT_WORLD_GENERATOR_VERSION
      ? mechanicalPowerWorldForSeed(state.world.grid.generator.seed)
      : emptyMechanicalPowerWorldState();
  } else migrateMechanicalPowerWorldState(state.world.mechanicalPower);
  ensureNamingMetadata(state.people);
  for (const drop of state.world.drops) {
    drop.z = Number.isInteger(drop.z) ? drop.z : surfaceStandingPosition(state.world.grid, drop.cellId)?.z ?? 1;
  }
  for (const person of [...state.people].sort((left, right) => left.generation - right.generation || left.bornAtMonth - right.bornAtMonth || left.id.localeCompare(right.id))) {
    if (!person.traits) {
      const birthFact = state.world.past.find((candidate) => candidate.kind === 'environment'
        && candidate.change === 'body'
        && candidate.diff.bornPersonId === person.id);
      const sourceEventId = birthFact?.id ?? FOUNDER_COHORT_EVENT_ID;
      const mother = person.geneticParents
        .map((parentId) => state.people.find((candidate) => candidate.id === parentId))
        .find((parent): parent is PersonState => parent?.sex === 'female');
      const father = person.geneticParents
        .map((parentId) => state.people.find((candidate) => candidate.id === parentId))
        .find((parent): parent is PersonState => parent?.sex === 'male');
      person.traits = person.generation === 0 || !mother
        ? founderTraitsFor(person.id, sourceEventId)
        : inheritPersonTraits(state.seed, person.id, mother, father).traits.map((trait) => ({ ...trait, sourceEventIds: [sourceEventId] }));
      person.lifespanMonths = applyTraitLifespanModifier(person.lifespanMonths, person.traits);
      person.baselineCapacities = applyTraitCapacityModifiers(person.baselineCapacities, person.traits);
      grantProphetKnowledge(person, person.bornAtMonth, sourceEventId);
    } else person.traits = normalizePersonTraits(person.traits);
    const socialLearning = cloneValidatedSocialLearningState(
      person,
      state.people,
      state.clock.elapsedMonths,
    );
    const cognition = ensureCognitionState(person);
    if (socialLearning) cognition.socialLearning = socialLearning;
    else delete cognition.socialLearning;
    person.bereavements ??= [];
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
  initializeHistoryCursorFromFullHistory(state);
  // Legacy intents may lack agreementId. Resolve their two source facts through
  // an active-agreement index instead of scanning every agreement per intent.
  const activeAgreementsByProposalEventId = new Map<string, typeof state.agreements>();
  for (const agreement of state.agreements) {
    if (agreement.status !== 'active' || !agreement.responseEventId) continue;
    const agreements = activeAgreementsByProposalEventId.get(agreement.proposalEventId) ?? [];
    agreements.push(agreement);
    activeAgreementsByProposalEventId.set(agreement.proposalEventId, agreements);
  }
  for (const intent of state.intents) {
    // Completed historical intents may accumulate the same proposal/response
    // evidence through later decisions without ever having been an obligation.
    // Only a still-executable intent whose own decision selected an obligation
    // option may migrate. Generic source facts are shared by unrelated plans
    // and cannot prove agreement ownership by themselves.
    if (intent.agreementId
      || (intent.status !== 'active' && intent.status !== 'suspended')
      || !legacyDecisionCreatedObligationIntent(state, intent)) continue;
    const sourceFactIds = intent.sourceFactIds ?? [];
    let agreement: SimulationState['agreements'][number] | undefined;
    for (const sourceFactId of sourceFactIds) {
      agreement = activeAgreementsByProposalEventId.get(sourceFactId)
        ?.find((candidate) => candidate.responseEventId !== undefined
          && sourceFactIds.includes(candidate.responseEventId));
      if (agreement) break;
    }
    if (agreement) intent.agreementId = agreement.id;
  }
  const physicalStructureIndex = derivePhysicalStructureIndex(state);
  state.world.physicalStructureIndex = physicalStructureIndex;
  state.derived = { ...state.derived, structures: copyPhysicalStructures(physicalStructureIndex) };
  observationProjector.project(state, 'full');
  primeEventIndex(state);
  return state;
}

export function restoreSimulationState(
  observationProjector: ObservationProjector,
  input: SimulationState,
): SimulationState {
  return adoptSimulationState(observationProjector, structuredClone(input));
}

export function resetSimulation(
  observationProjector: ObservationProjector,
  seed = 17,
  config: Partial<SimulationConfig> = {},
): SimulationState {
  return createInitialState(observationProjector, seed, config);
}

export function buildEvolutionReport(finalState: SimulationState, checkpoints: SimulationState[] = []): EvolutionReport {
  return {
    schemaVersion: 17,
    exportedAt: new Date().toISOString(),
    civilization: structuredClone(finalState.civilization),
    finalState: copyState(finalState),
    checkpoints: checkpoints.map(copyState),
    review: { milestones: structuredClone(finalState.derived.milestones), eventCount: historyEventCount(finalState) },
  };
}
