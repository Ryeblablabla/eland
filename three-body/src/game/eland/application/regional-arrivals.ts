import { CHARACTER_PROFILES } from '../character-profiles';
import { createLifespanMonths, deterministicFraction } from '../population';
import { createCharacterAgendaState } from '../domain/character-agenda';
import { createCognitionState } from '../domain/cognition';
import { appendCommittedEvents, assertCommittedHistoryAppendable } from '../domain/history';
import { Material, materialDefinition } from '../domain/material';
import { remember } from '../domain/memory';
import type { PopulationFact, SimulationState } from '../domain/model';
import { createEmptyPersonMindMarkdown } from '../domain/person-mind';
import type { PersonState } from '../domain/person';
import { advancePhysicalStructureIndex } from '../domain/physical-structure-index';
import {
  createFounderMotiveSensitivity,
  createFounderPersonality,
} from '../domain/personality';
import {
  attachRegionalSourceEvent,
  createRegionalPopulationState,
  dueRegionalJourneys,
  recordRegionalFirstEncounter,
  recordRegionalJourneyArrival,
  regionalSourceCommunityId,
  type RegionalJourney,
  type RegionalTravelerPlan,
} from '../domain/regional-population';
import { livingPeople } from '../domain/state-index';
import {
  applyTraitCapacityModifiers,
  applyTraitLifespanModifier,
  founderTraitsFor,
  grantProphetKnowledge,
  normalizePersonTraits,
  spontaneousPersonTraits,
} from '../domain/trait';
import {
  cellId,
  cellX,
  cellY,
  isCellId,
  isStandingPosition,
  surfaceStandingPosition,
  type VoxelWorld,
} from '../world/grid';

const MAX_SCHEDULED_REGIONAL_JOURNEYS = 16;
export const REGIONAL_ENTRY_CORRIDOR_RADIUS = 4;

function regionalSourceEventId(state: SimulationState, atMonth: number): string {
  return `e-${atMonth}-population-regional-source-${state.seed}-${state.civilization.number}`;
}

/** Exact passable positions on the generated map boundary, in stable order. */
export function regionalBoundaryEntryPositions(world: VoxelWorld): Array<{ cellId: number; z: number }> {
  const boundaryCellIds: number[] = [];
  for (let x = 0; x < world.width; x += 1) {
    boundaryCellIds.push(cellId(x, 0));
    if (world.depth > 1) boundaryCellIds.push(cellId(x, world.depth - 1));
  }
  for (let y = 1; y < world.depth - 1; y += 1) {
    boundaryCellIds.push(cellId(0, y));
    if (world.width > 1) boundaryCellIds.push(cellId(world.width - 1, y));
  }
  return [...new Set(boundaryCellIds)]
    .sort((left, right) => left - right)
    .flatMap((boundaryCellId) => {
      const position = surfaceStandingPosition(world, boundaryCellId);
      return position ? [{ cellId: position.cellId, z: position.z }] : [];
    });
}

function isBoundaryCell(world: VoxelWorld, candidateCellId: number): boolean {
  if (!isCellId(candidateCellId)) return false;
  const x = cellX(candidateCellId);
  const y = cellY(candidateCellId);
  return x === 0 || y === 0 || x === world.width - 1 || y === world.depth - 1;
}

/**
 * The scheduled position identifies a local entry corridor, not a timeless
 * teleport destination. Resolve against the current boundary and defer when
 * that small corridor contains no body-sized standing space.
 */
export function resolveRegionalArrivalEntryPosition(
  world: VoxelWorld,
  planned: Readonly<{ cellId: number; z: number }>,
): { cellId: number; z: number } | null {
  if (isBoundaryCell(world, planned.cellId) && isStandingPosition(world, planned)) {
    return { cellId: planned.cellId, z: planned.z };
  }
  const plannedX = cellX(planned.cellId);
  const plannedY = cellY(planned.cellId);
  return regionalBoundaryEntryPositions(world)
    .filter((position) => (
      Math.abs(cellX(position.cellId) - plannedX)
        + Math.abs(cellY(position.cellId) - plannedY)
    ) <= REGIONAL_ENTRY_CORRIDOR_RADIUS)
    .sort((left, right) => {
      const leftDistance = Math.abs(cellX(left.cellId) - plannedX)
        + Math.abs(cellY(left.cellId) - plannedY);
      const rightDistance = Math.abs(cellX(right.cellId) - plannedX)
        + Math.abs(cellY(right.cellId) - plannedY);
      return leftDistance - rightDistance
        || Math.abs(left.z - planned.z) - Math.abs(right.z - planned.z)
        || left.cellId - right.cellId
        || left.z - right.z;
    })[0] ?? null;
}

function plannedRegionalRoster(
  state: SimulationState,
  sourceEventId: string,
): RegionalTravelerPlan[] {
  const occupiedProfileIds = new Set(state.people.map((person) => person.id));
  const sourceCommunityId = regionalSourceCommunityId(state.seed, state.civilization.number);
  const portableMaterials = [Material.Fiber, Material.Seed, Material.StoneTool, Material.Clothing] as const;
  return CHARACTER_PROFILES
    .filter((profile) => !occupiedProfileIds.has(profile.id))
    .map((profile): RegionalTravelerPlan => {
      const personId = `regional-${state.seed}-${state.civilization.number}-${profile.id}`;
      const traitSeed = state.seed + state.civilization.number * 997;
      const traits = normalizePersonTraits([
        ...founderTraitsFor(profile.id, sourceEventId),
        ...spontaneousPersonTraits(traitSeed, personId, profile.sex).traits,
      ]).map((trait) => ({
        ...trait,
        sourceEventIds: [...new Set([...trait.sourceEventIds, sourceEventId])],
      }));
      const capacity = (key: string, floor: number, span: number) => floor + Math.floor(
        deterministicFraction(state.seed, `regional-capacity:${personId}:${key}`) * span,
      );
      const baselineCapacities = applyTraitCapacityModifiers({
        locomotion: capacity('locomotion', 45, 38),
        manipulation: capacity('manipulation', 43, 38),
        perception: capacity('perception', 42, 40),
        communication: capacity('communication', 42, 40),
        cognition: capacity('cognition', 42, 40),
      }, traits);
      const ageAtArrivalMonths = (18 + Math.floor(
        deterministicFraction(state.seed, `regional-arrival-age:${personId}`) * 24,
      )) * 12;
      const lifespanMonths = applyTraitLifespanModifier(
        createLifespanMonths(state.seed, personId, ageAtArrivalMonths),
        traits,
      );
      const extraMaterialId = portableMaterials[Math.min(
        portableMaterials.length - 1,
        Math.floor(deterministicFraction(state.seed, `regional-carry:${personId}`) * portableMaterials.length),
      )]!;
      const carriedMaterials = [
        { materialId: Material.Food, quantity: 2 },
        { materialId: extraMaterialId, quantity: extraMaterialId === Material.Fiber || extraMaterialId === Material.Seed ? 2 : 1 },
      ].map((material, index) => ({
        id: `regional-carry:${personId}:${index + 1}`,
        ...material,
        lineageKey: `regional-carried:${sourceCommunityId}:${personId}:${index + 1}`,
      }));
      return {
        version: 'regional-traveler-plan-v1',
        personId,
        profileId: profile.id,
        name: profile.name,
        sex: profile.sex,
        color: profile.color,
        familyName: profile.familyName,
        namingTradition: profile.namingTradition,
        profileDescription: profile.description,
        personalitySummary: profile.personalitySummary,
        ageAtArrivalMonths,
        lifespanMonths,
        arrivalBody: {
          health: 76 + Math.floor(deterministicFraction(state.seed, `regional-body:${personId}:health`) * 17),
          hydration: 58 + Math.floor(deterministicFraction(state.seed, `regional-body:${personId}:hydration`) * 21),
          nutrition: 58 + Math.floor(deterministicFraction(state.seed, `regional-body:${personId}:nutrition`) * 21),
        },
        baselineCapacities,
        traits,
        carriedMaterials,
      };
    });
}

/**
 * Establish an off-map source and its complete deterministic travel roster.
 * This does not create local people and does not inspect local sex, pregnancy,
 * civilization stage, or any demographic shortage.
 */
export function establishRegionalPopulation(
  state: SimulationState,
  atMonth = state.clock.elapsedMonths,
): PopulationFact | null {
  if (state.civilization.status !== 'running' || state.regionalPopulation) return null;
  const entryPositions = regionalBoundaryEntryPositions(state.world.grid);
  if (!entryPositions.length) throw new Error('当前世界没有可站立的边界入口');
  const sourceEventId = regionalSourceEventId(state, atMonth);
  const regional = createRegionalPopulationState({
    seed: state.seed,
    civilizationNo: state.civilization.number,
    establishedAtMonth: atMonth,
    roster: plannedRegionalRoster(state, sourceEventId),
    entryPositions,
    maximumJourneys: MAX_SCHEDULED_REGIONAL_JOURNEYS,
  });
  attachRegionalSourceEvent(regional, sourceEventId);
  state.regionalPopulation = regional;
  const entryCorridorIds = [...new Set(regional.journeys.map((journey) => journey.entryCorridorId))].sort();
  return {
    id: sourceEventId,
    kind: 'population',
    change: 'regional-source-established',
    atMonth,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    cellId: regional.journeys[0]?.entryPosition.cellId ?? entryPositions[0]!.cellId,
    personIds: [],
    sourceCommunityId: regional.sourceCommunityId,
    sourceEventIds: [],
    result: '地图边界之外存在一个独立的区域人口来源，其旅程已由创世种子确定',
    diff: {
      regionalPopulationVersion: regional.version,
      establishedAtMonth: atMonth,
      plannedJourneyCount: regional.journeys.length,
      entryCorridorIds,
      journeyPlans: regional.journeys.map((journey) => ({
        id: journey.id,
        profileId: journey.profileId,
        personId: journey.traveler.personId,
        departedAtMonth: journey.departedAtMonth,
        expectedArrivalAtMonth: journey.expectedArrivalAtMonth,
        entryCorridorId: journey.entryCorridorId,
        entryPosition: { ...journey.entryPosition },
      })),
    },
  };
}

function boundaryPositionFromValue(
  world: VoxelWorld,
  value: unknown,
): { cellId: number; z: number } | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { cellId?: unknown; z?: unknown };
  const candidateCellId = Number(candidate.cellId);
  const z = Number(candidate.z);
  return Number.isInteger(candidateCellId)
    && Number.isInteger(z)
    && z > 0
    && z + 1 < world.levels
    && isBoundaryCell(world, candidateCellId)
    ? { cellId: candidateCellId, z }
    : null;
}

function sourcePlannedPositions(
  state: SimulationState,
  source: PopulationFact,
): Array<{ cellId: number; z: number }> {
  const fromPlans = (Array.isArray(source.diff.journeyPlans) ? source.diff.journeyPlans : [])
    .flatMap((value) => value && typeof value === 'object'
      ? boundaryPositionFromValue(
        state.world.grid,
        (value as { entryPosition?: unknown }).entryPosition,
      ) ?? []
      : []);
  const fromCorridors = (Array.isArray(source.diff.entryCorridorIds)
    ? source.diff.entryCorridorIds
    : []).flatMap((value) => {
    if (typeof value !== 'string') return [];
    const match = /^world-edge:(\d+):(\d+)$/u.exec(value);
    return match
      ? boundaryPositionFromValue(state.world.grid, {
        cellId: Number(match[1]),
        z: Number(match[2]),
      }) ?? []
      : [];
  });
  return [...new Map([...fromPlans, ...fromCorridors]
    .map((position) => [`${position.cellId}:${position.z}`, position])).values()];
}

function restoreJourneyPlansFromSource(
  regional: NonNullable<SimulationState['regionalPopulation']>,
  source: PopulationFact,
  world: VoxelWorld,
): void {
  if (!Array.isArray(source.diff.journeyPlans)) return;
  for (const value of source.diff.journeyPlans) {
    if (!value || typeof value !== 'object') continue;
    const plan = value as Record<string, unknown>;
    const journey = regional.journeys.find((candidate) => (
      typeof plan.id === 'string' && candidate.id === plan.id
    ) || (
      typeof plan.personId === 'string' && candidate.traveler.personId === plan.personId
    ));
    if (!journey) continue;
    const departedAtMonth = Number(plan.departedAtMonth);
    const expectedArrivalAtMonth = Number(plan.expectedArrivalAtMonth);
    if (Number.isSafeInteger(departedAtMonth)
      && Number.isSafeInteger(expectedArrivalAtMonth)
      && expectedArrivalAtMonth > departedAtMonth) {
      journey.departedAtMonth = departedAtMonth;
      journey.expectedArrivalAtMonth = expectedArrivalAtMonth;
    }
    const entryPosition = boundaryPositionFromValue(world, plan.entryPosition);
    if (entryPosition) journey.entryPosition = entryPosition;
    if (typeof plan.entryCorridorId === 'string' && plan.entryCorridorId.length > 0) {
      journey.entryCorridorId = plan.entryCorridorId;
    }
  }
}

/**
 * Rebuild the optional regional fold from its authoritative population facts.
 * No event or person is created here: arrived journeys and encounter pairs are
 * merely recognized so a restored run cannot repeat them later.
 */
export function restoreRegionalPopulationFromHistory(
  state: SimulationState,
): NonNullable<SimulationState['regionalPopulation']> | null {
  if (state.regionalPopulation) return state.regionalPopulation;
  const expectedCommunityId = regionalSourceCommunityId(
    state.seed,
    state.civilization.number,
  );
  const sources = state.world.past.filter((event): event is PopulationFact => (
    event.kind === 'population' && event.change === 'regional-source-established'
  ));
  const source = sources.find((event) => event.sourceCommunityId === expectedCommunityId)
    ?? sources[0];
  if (!source) return null;
  const entryPositions = sourcePlannedPositions(state, source);
  const currentBoundaryPositions = entryPositions.length
    ? entryPositions
    : regionalBoundaryEntryPositions(state.world.grid);
  if (!currentBoundaryPositions.length) return null;
  const plannedJourneyCount = Number(source.diff.plannedJourneyCount);
  const maximumJourneys = Number.isSafeInteger(plannedJourneyCount)
    ? Math.max(0, Math.min(MAX_SCHEDULED_REGIONAL_JOURNEYS, plannedJourneyCount))
    : MAX_SCHEDULED_REGIONAL_JOURNEYS;
  const regional = createRegionalPopulationState({
    seed: state.seed,
    civilizationNo: state.civilization.number,
    establishedAtMonth: source.atMonth,
    roster: plannedRegionalRoster(state, source.id),
    entryPositions: currentBoundaryPositions,
    maximumJourneys,
  });
  regional.sourceCommunityId = source.sourceCommunityId ?? regional.sourceCommunityId;
  for (const journey of regional.journeys) {
    journey.sourceCommunityId = regional.sourceCommunityId;
  }
  attachRegionalSourceEvent(regional, source.id);
  restoreJourneyPlansFromSource(regional, source, state.world.grid);

  const arrivals = state.world.past.filter((event): event is PopulationFact => (
    event.kind === 'population'
      && event.change === 'regional-arrival'
      && (event.sourceEventIds.includes(source.id)
        || event.sourceCommunityId === regional.sourceCommunityId)
  ));
  for (const arrival of arrivals) {
    const personId = typeof arrival.diff.personId === 'string'
      ? arrival.diff.personId
      : arrival.personIds[0];
    const journey = regional.journeys.find((candidate) => (
      candidate.id === arrival.journeyId
        || candidate.traveler.personId === personId
    ));
    if (!journey || journey.status === 'arrived') continue;
    const plannedEntryPosition = boundaryPositionFromValue(
      state.world.grid,
      arrival.diff.plannedEntryPosition ?? arrival.diff.entryPosition,
    );
    if (plannedEntryPosition) {
      journey.entryPosition = plannedEntryPosition;
      journey.entryCorridorId = typeof arrival.diff.entryCorridorId === 'string'
        ? arrival.diff.entryCorridorId
        : journey.entryCorridorId;
    }
    recordRegionalJourneyArrival(regional, journey.id, arrival.id);
  }
  const existingIds = new Set(state.people.map((person) => person.id));
  const unrecognizedCollision = regional.journeys.find((journey) => (
    journey.status === 'approaching' && existingIds.has(journey.traveler.personId)
  ));
  if (unrecognizedCollision) {
    throw new Error(`区域人物 ${unrecognizedCollision.traveler.personId} 已存在，但历史缺少对应抵达事实`);
  }
  regional.encounteredPairKeys = [...new Set(state.world.past.flatMap((event) => (
    event.kind === 'population'
      && event.change === 'first-encounter'
      && event.personIds.length === 2
      ? [personPairKey(event.personIds[0]!, event.personIds[1]!)]
      : []
  )))].sort();
  return regional;
}

/** Fill explicit origins for restored people without creating anybody. */
export function ensureExistingPersonOrigins(state: SimulationState): void {
  const founding = state.world.past.find((event) => event.kind === 'environment'
    && event.change === 'founding');
  for (const person of state.people) {
    if (person.origin) continue;
    const arrival = state.world.past.find((event): event is PopulationFact => event.kind === 'population'
      && event.change === 'regional-arrival'
      && event.personIds.includes(person.id));
    if (arrival) {
      person.origin = {
        version: 'person-origin-v1',
        kind: 'regional-arrival',
        enteredAtMonth: arrival.atMonth,
        summary: arrival.result,
        sourceEventIds: [...new Set([...arrival.sourceEventIds, arrival.id])],
        ...(arrival.sourceCommunityId ? { sourceCommunityId: arrival.sourceCommunityId } : {}),
        ...(arrival.journeyId ? { journeyId: arrival.journeyId } : {}),
      };
      continue;
    }
    const birth = state.world.past.find((event) => event.kind === 'environment'
      && event.change === 'body'
      && event.diff.bornPersonId === person.id);
    if (birth) {
      person.origin = {
        version: 'person-origin-v1',
        kind: 'birth',
        enteredAtMonth: birth.atMonth,
        summary: birth.result,
        sourceEventIds: [birth.id],
      };
      continue;
    }
    person.origin = {
      version: 'person-origin-v1',
      kind: 'founding',
      enteredAtMonth: founding?.atMonth ?? 0,
      summary: founding?.result ?? '该人物属于已恢复文明的初始在地人口',
      sourceEventIds: founding ? [founding.id] : [],
    };
  }
}

function regionalArrivalPerson(
  state: SimulationState,
  journey: RegionalJourney,
  entryPosition: Readonly<{ cellId: number; z: number }>,
  atMonth: number,
  eventId: string,
): PersonState {
  const plan = journey.traveler;
  const profile = CHARACTER_PROFILES.find((candidate) => candidate.id === plan.profileId);
  if (!profile) throw new Error(`区域旅行者档案不存在: ${plan.profileId}`);
  const originSourceEventIds = [...new Set([...journey.sourceEventIds, eventId])];
  const traits = plan.traits.map((trait) => ({
    ...structuredClone(trait),
    sourceEventIds: [...new Set([...trait.sourceEventIds, ...originSourceEventIds])],
  }));
  const person: PersonState = {
    id: plan.personId,
    name: plan.name,
    color: plan.color,
    profile: {
      description: plan.profileDescription,
      personalitySummary: plan.personalitySummary,
      reactionPatterns: structuredClone(profile.reactionPatterns),
    },
    origin: {
      version: 'person-origin-v1',
      kind: 'regional-arrival',
      enteredAtMonth: atMonth,
      summary: `${plan.name}经由${journey.entryCorridorId}从地图外的区域社群抵达`,
      sourceEventIds: originSourceEventIds,
      sourceCommunityId: journey.sourceCommunityId,
      journeyId: journey.id,
    },
    bornAtMonth: journey.expectedArrivalAtMonth - plan.ageAtArrivalMonths,
    lifespanMonths: plan.lifespanMonths,
    sex: plan.sex,
    familyName: plan.familyName,
    namingTradition: plan.namingTradition,
    geneticParents: [],
    generation: 0,
    geneticLoad: 0,
    traits,
    position: {
      cellId: entryPosition.cellId,
      z: entryPosition.z,
      previousCellId: entryPosition.cellId,
      previousZ: entryPosition.z,
      lastPath: [entryPosition.cellId],
      tickPath: [entryPosition.cellId],
    },
    body: { ...plan.arrivalBody },
    baselineCapacities: { ...plan.baselineCapacities },
    personality: createFounderPersonality(state.seed, plan.personId, profile.personalityPrior),
    motiveSensitivity: createFounderMotiveSensitivity(state.seed, plan.personId, profile.motivePrior),
    cognition: createCognitionState(),
    characterAgenda: createCharacterAgendaState(),
    conditions: [],
    inventory: plan.carriedMaterials.map((carried) => ({
      id: `stack-${plan.personId}-arrival-${carried.id}`,
      materialId: carried.materialId,
      quantity: carried.quantity,
      sourceEventIds: originSourceEventIds,
      sourceLineageKeys: [carried.lineageKey],
    })),
    knowledge: [],
    knownPlaces: [],
    memories: [],
    mindMarkdown: createEmptyPersonMindMarkdown(plan.personId, atMonth),
    relations: [],
    bereavements: [],
    currentActionText: '刚从地图边界抵达，本月尚未参与当地行动',
    lastDecisionText: '抵达后尚未开始下一月的决策',
  };
  grantProphetKnowledge(person, atMonth, eventId);
  return person;
}

function arrivalFact(
  journey: RegionalJourney,
  person: PersonState,
  entryPosition: Readonly<{ cellId: number; z: number }>,
  atMonth: number,
  orderInMonth: number,
): PopulationFact {
  const eventId = `e-${atMonth}-population-regional-arrival-${journey.id}`;
  return {
    id: eventId,
    kind: 'population',
    change: 'regional-arrival',
    atMonth,
    orderInMonth,
    planningTick: 0,
    orderInTick: orderInMonth,
    cellId: entryPosition.cellId,
    personIds: [person.id],
    sourceCommunityId: journey.sourceCommunityId,
    journeyId: journey.id,
    sourceEventIds: [...journey.sourceEventIds],
    result: `${person.name}在第 ${atMonth} 月经过边界旅程抵达地图（原预计第 ${journey.expectedArrivalAtMonth} 月）`,
    diff: {
      profileId: journey.profileId,
      personId: person.id,
      departedAtMonth: journey.departedAtMonth,
      expectedArrivalAtMonth: journey.expectedArrivalAtMonth,
      arrivedAtMonth: atMonth,
      entryCorridorId: journey.entryCorridorId,
      plannedEntryPosition: { ...journey.entryPosition },
      entryPosition: { ...entryPosition },
      traits: person.traits?.map((trait) => ({
        id: trait.id,
        origin: trait.origin,
        sourceEventIds: [...trait.sourceEventIds],
      })) ?? [],
      carriedMaterials: person.inventory.map((stack) => ({
        stackId: stack.id,
        materialId: stack.materialId,
        materialName: materialDefinition(stack.materialId).name,
        quantity: stack.quantity,
        sourceLineageKeys: [...(stack.sourceLineageKeys ?? [])],
      })),
      origin: structuredClone(person.origin),
    },
  };
}

function personPairKey(firstId: string, secondId: string): string {
  return [firstId, secondId].sort().join('|');
}

function mutuallyVisible(first: PersonState, second: PersonState): boolean {
  const firstRadius = 4 + Math.floor(first.baselineCapacities.perception / 25);
  const secondRadius = 4 + Math.floor(second.baselineCapacities.perception / 25);
  const horizontalDistance = Math.abs(cellX(first.position.cellId) - cellX(second.position.cellId))
    + Math.abs(cellY(first.position.cellId) - cellY(second.position.cellId));
  const verticalDistance = Math.abs(first.position.z - second.position.z);
  return horizontalDistance <= Math.min(firstRadius, secondRadius)
    && verticalDistance <= Math.min(firstRadius, secondRadius);
}

function firstEncounterFacts(
  encounteredPairKeys: readonly string[],
  people: readonly PersonState[],
  atMonth: number,
  firstOrderInMonth: number,
): PopulationFact[] {
  const alreadyEncountered = new Set(encounteredPairKeys);
  const facts: PopulationFact[] = [];
  const living = people.filter((person) => person.diedAtMonth === undefined || person.diedAtMonth > atMonth)
    .sort((left, right) => left.id.localeCompare(right.id));
  const regionalPeople = living.filter((person) => person.origin?.kind === 'regional-arrival');
  for (const first of regionalPeople) {
    for (const second of living) {
      if (first.id === second.id) continue;
      const pairKey = personPairKey(first.id, second.id);
      if (alreadyEncountered.has(pairKey) || !mutuallyVisible(first, second)) continue;
      alreadyEncountered.add(pairKey);
      const sourceEventIds = [...new Set([
        ...(first.origin?.sourceEventIds ?? []),
        ...(second.origin?.sourceEventIds ?? []),
      ])];
      const orderInMonth = firstOrderInMonth + facts.length;
      facts.push({
        id: `e-${atMonth}-population-first-encounter-${first.id}-${second.id}`,
        kind: 'population',
        change: 'first-encounter',
        atMonth,
        orderInMonth,
        planningTick: 0,
        orderInTick: orderInMonth,
        cellId: first.origin?.kind === 'regional-arrival' ? first.position.cellId : second.position.cellId,
        personIds: [first.id, second.id],
        sourceEventIds,
        result: `${first.name}与${second.name}第一次在彼此可见的距离内相遇`,
        diff: {
          mutuallyVisible: true,
          firstPosition: { cellId: first.position.cellId, z: first.position.z },
          secondPosition: { cellId: second.position.cellId, z: second.position.z },
        },
      });
    }
  }
  return facts;
}

function rememberArrival(person: PersonState, fact: PopulationFact): void {
  remember(person, {
    id: `memory:${fact.id}:${person.id}`,
    kind: 'episode',
    summary: `自己经历边界旅程后抵达了这片地图，随身带着${person.inventory.map((stack) => `${materialDefinition(stack.materialId).name}×${stack.quantity}`).join('、')}`,
    importance: 72,
    createdAtMonth: fact.atMonth,
    lastRecalledAtMonth: fact.atMonth,
    personIds: [],
    sourceEventIds: [fact.id],
  });
}

function rememberFirstEncounter(state: SimulationState, fact: PopulationFact): void {
  if (fact.personIds.length !== 2) return;
  const [firstId, secondId] = fact.personIds;
  const first = state.people.find((person) => person.id === firstId);
  const second = state.people.find((person) => person.id === secondId);
  if (!first || !second) return;
  for (const [observer, other] of [[first, second], [second, first]] as const) {
    remember(observer, {
      id: `memory:${fact.id}:${observer.id}`,
      kind: 'episode',
      summary: `第一次亲眼见到${other.name}；此时只知道对方存在，尚未形成信任或羁绊判断`,
      importance: 64,
      createdAtMonth: fact.atMonth,
      lastRecalledAtMonth: fact.atMonth,
      personIds: [other.id],
      sourceEventIds: [fact.id],
    });
  }
}

/**
 * Commit arrivals only after the normal month has resolved and only while the
 * civilization remains running. New people therefore cannot act or receive a
 * model turn in their arrival month.
 */
export function commitRegionalPopulationMonthEnd(
  state: SimulationState,
  atMonth = state.clock.elapsedMonths,
): PopulationFact[] {
  if (state.civilization.status !== 'running' || atMonth !== state.clock.elapsedMonths) return [];
  const regional = state.regionalPopulation;
  if (!regional?.sourceEventId) return [];
  assertCommittedHistoryAppendable(state);
  const historyCursor = state.world.historyCursor;
  if (!historyCursor) throw new Error('区域人口提交需要已初始化的权威历史游标');
  const due = dueRegionalJourneys(regional, atMonth);
  const existingIds = new Set(state.people.map((person) => person.id));
  const resolvable = due.flatMap((journey) => {
    if (existingIds.has(journey.traveler.personId)) {
      throw new Error(`区域旅行者 id 已在地图人口中: ${journey.traveler.personId}`);
    }
    const entryPosition = resolveRegionalArrivalEntryPosition(
      state.world.grid,
      journey.entryPosition,
    );
    return entryPosition ? [{ journey, entryPosition }] : [];
  });
  for (const { journey } of resolvable) {
    existingIds.add(journey.traveler.personId);
  }
  const currentMonthEvents = state.world.past.filter((event) => event.atMonth === atMonth);
  const firstOrderInMonth = currentMonthEvents.reduce(
    (maximum, event) => Math.max(maximum, event.orderInMonth + 1),
    0,
  );
  const arrivals = resolvable.map(({ journey, entryPosition }, index) => {
    const eventId = `e-${atMonth}-population-regional-arrival-${journey.id}`;
    const person = regionalArrivalPerson(state, journey, entryPosition, atMonth, eventId);
    return {
      journey,
      person,
      fact: arrivalFact(journey, person, entryPosition, atMonth, firstOrderInMonth + index),
    };
  });
  const prospectivePeople = [...livingPeople(state), ...arrivals.map((arrival) => arrival.person)];
  const encounters = firstEncounterFacts(
    regional.encounteredPairKeys,
    prospectivePeople,
    atMonth,
    firstOrderInMonth + arrivals.length,
  );
  const facts = [...arrivals.map((arrival) => arrival.fact), ...encounters];
  if (!facts.length) return [];

  for (const arrival of arrivals) {
    recordRegionalJourneyArrival(regional, arrival.journey.id, arrival.fact.id);
    state.people.push(arrival.person);
  }
  for (const encounter of encounters) {
    recordRegionalFirstEncounter(
      regional,
      personPairKey(encounter.personIds[0]!, encounter.personIds[1]!),
    );
  }
  const previousStructureIndex = state.world.physicalStructureIndex;
  const previousHistorySeal = {
    eventCount: historyCursor.eventCount,
    tailEventId: historyCursor.tailEventId,
  };
  appendCommittedEvents(state, facts);
  if (previousStructureIndex?.projectionVersion === 2) {
    const structureIndex = advancePhysicalStructureIndex(
      state,
      previousStructureIndex,
      facts,
      previousHistorySeal,
    );
    state.world.physicalStructureIndex = structureIndex;
  }
  state.lastStep = [...state.lastStep, ...facts];
  for (const arrival of arrivals) rememberArrival(arrival.person, arrival.fact);
  for (const encounter of encounters) rememberFirstEncounter(state, encounter);
  return facts;
}
