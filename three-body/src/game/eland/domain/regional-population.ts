import { deterministicFraction } from '../population';
import type { BiologicalSex } from '../population';
import type { NamingTradition } from '../naming';
import type { MaterialId } from './material';
import type { PersonTraitState } from './trait';

export const REGIONAL_POPULATION_VERSION = 'regional-population-v1' as const;
export const REGIONAL_JOURNEY_VERSION = 'regional-journey-v1' as const;

export interface PersonOrigin {
  version: 'person-origin-v1';
  kind: 'founding' | 'birth' | 'regional-arrival';
  enteredAtMonth: number;
  summary: string;
  sourceEventIds: string[];
  sourceCommunityId?: string;
  journeyId?: string;
}

export interface RegionalCarriedMaterialPlan {
  id: string;
  materialId: MaterialId;
  quantity: number;
  lineageKey: string;
}

/**
 * Off-map roster data fixed when the regional source is established.  It is
 * intentionally not a PersonState: people outside the map have no local body,
 * relationships, intentions, or model turns yet.
 */
export interface RegionalTravelerPlan {
  version: 'regional-traveler-plan-v1';
  personId: string;
  profileId: string;
  name: string;
  sex: BiologicalSex;
  color: string;
  familyName: string;
  namingTradition: NamingTradition;
  profileDescription: string;
  personalitySummary: string;
  ageAtArrivalMonths: number;
  lifespanMonths: number;
  arrivalBody: { health: number; hydration: number; nutrition: number };
  baselineCapacities: {
    locomotion: number;
    manipulation: number;
    perception: number;
    communication: number;
    cognition: number;
  };
  traits: PersonTraitState[];
  carriedMaterials: RegionalCarriedMaterialPlan[];
}

export interface RegionalJourney {
  version: typeof REGIONAL_JOURNEY_VERSION;
  id: string;
  profileId: string;
  traveler: RegionalTravelerPlan;
  sourceCommunityId: string;
  departedAtMonth: number;
  expectedArrivalAtMonth: number;
  entryCorridorId: string;
  entryPosition: { cellId: number; z: number };
  status: 'approaching' | 'arrived';
  sourceEventIds: string[];
  arrivalEventId?: string;
}

export interface RegionalPopulationState {
  version: typeof REGIONAL_POPULATION_VERSION;
  sourceCommunityId: string;
  establishedAtMonth: number;
  sourceEventId?: string;
  journeys: RegionalJourney[];
  /** Canonical person-id pairs whose first visible encounter is already factual. */
  encounteredPairKeys: string[];
}

export function regionalSourceCommunityId(seed: number, civilizationNo: number): string {
  return `regional-community:${seed}:${civilizationNo}`;
}

export function createRegionalPopulationState(input: {
  seed: number;
  civilizationNo: number;
  establishedAtMonth: number;
  roster: readonly RegionalTravelerPlan[];
  entryPositions: readonly { cellId: number; z: number }[];
  maximumJourneys?: number;
}): RegionalPopulationState {
  if (!input.entryPositions.length) throw new Error('区域人口需要至少一个真实边界入口');
  const sourceCommunityId = regionalSourceCommunityId(input.seed, input.civilizationNo);
  const rosterByPersonId = new Map(input.roster.map((traveler) => [traveler.personId, traveler]));
  const orderedRoster = [...rosterByPersonId.values()]
    .sort((left, right) => deterministicFraction(input.seed, `regional-order:${left.personId}`)
      - deterministicFraction(input.seed, `regional-order:${right.personId}`)
      || left.personId.localeCompare(right.personId))
    .slice(0, Math.max(0, Math.floor(input.maximumJourneys ?? 16)));
  let arrivalCursor = input.establishedAtMonth;
  const journeys = orderedRoster.map((traveler, index): RegionalJourney => {
    const profileId = traveler.profileId;
    const gap = index === 0
      ? 12 + Math.floor(deterministicFraction(input.seed, `regional-first-gap:${profileId}`) * 18)
      : 18 + Math.floor(deterministicFraction(input.seed, `regional-gap:${profileId}`) * 43);
    arrivalCursor += gap;
    const travelMonths = 4 + Math.floor(deterministicFraction(input.seed, `regional-travel:${profileId}`) * 9);
    const entryIndex = Math.floor(
      deterministicFraction(input.seed, `regional-entry:${profileId}`) * input.entryPositions.length,
    );
    const entryPosition = input.entryPositions[Math.min(input.entryPositions.length - 1, entryIndex)]!;
    return {
      version: REGIONAL_JOURNEY_VERSION,
      id: `regional-journey:${input.seed}:${input.civilizationNo}:${index + 1}:${profileId}`,
      profileId,
      traveler: structuredClone(traveler),
      sourceCommunityId,
      departedAtMonth: arrivalCursor - travelMonths,
      expectedArrivalAtMonth: arrivalCursor,
      entryCorridorId: `world-edge:${entryPosition.cellId}:${entryPosition.z}`,
      entryPosition: { ...entryPosition },
      status: 'approaching',
      sourceEventIds: [],
    };
  });
  return {
    version: REGIONAL_POPULATION_VERSION,
    sourceCommunityId,
    establishedAtMonth: input.establishedAtMonth,
    journeys,
    encounteredPairKeys: [],
  };
}

export function attachRegionalSourceEvent(
  regional: RegionalPopulationState,
  sourceEventId: string,
): void {
  if (!sourceEventId.trim()) throw new Error('区域人口来源事件不能为空');
  regional.sourceEventId = sourceEventId;
  for (const journey of regional.journeys) {
    journey.sourceEventIds = [...new Set([...journey.sourceEventIds, sourceEventId])];
    journey.traveler.traits = journey.traveler.traits.map((trait) => ({
      ...trait,
      sourceEventIds: [...new Set([...trait.sourceEventIds, sourceEventId])],
    }));
  }
}

export function dueRegionalJourneys(
  regional: RegionalPopulationState,
  atMonth: number,
): RegionalJourney[] {
  if (!regional.sourceEventId) return [];
  return regional.journeys
    .filter((journey) => journey.status === 'approaching'
      && journey.expectedArrivalAtMonth <= atMonth
      && journey.sourceEventIds.includes(regional.sourceEventId!))
    .sort((left, right) => left.expectedArrivalAtMonth - right.expectedArrivalAtMonth
      || left.id.localeCompare(right.id));
}

export function recordRegionalJourneyArrival(
  regional: RegionalPopulationState,
  journeyId: string,
  arrivalEventId: string,
): RegionalJourney {
  const journey = regional.journeys.find((candidate) => candidate.id === journeyId);
  if (!journey || journey.status !== 'approaching' || !regional.sourceEventId) {
    throw new Error('区域旅程不存在、已结束或尚无真实来源');
  }
  journey.status = 'arrived';
  journey.arrivalEventId = arrivalEventId;
  journey.sourceEventIds = [...new Set([...journey.sourceEventIds, arrivalEventId])];
  return journey;
}

export function recordRegionalFirstEncounter(
  regional: RegionalPopulationState,
  pairKey: string,
): void {
  if (!pairKey.trim()) throw new Error('区域首次相遇需要人物对键');
  if (!regional.encounteredPairKeys.includes(pairKey)) {
    regional.encounteredPairKeys.push(pairKey);
    regional.encounteredPairKeys.sort();
  }
}
