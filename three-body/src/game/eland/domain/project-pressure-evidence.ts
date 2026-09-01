import type { WorldEvent } from './model';
import type { PersonId, PersonState } from './person';

export const PROJECT_PRESSURE_HUNT_FAILURE_LIMIT = 3;
export const PROJECT_PRESSURE_ANIMAL_ATTACK_LIMIT = 2;
export const PROJECT_PRESSURE_DEHYDRATION_LIMIT = 5;
export const PROJECT_PRESSURE_DEVELOPMENT_PROVENANCE_LIMIT = 24;
export const PROJECT_PRESSURE_BODY_WITNESS_LIMIT =
  PROJECT_PRESSURE_HUNT_FAILURE_LIMIT
  + PROJECT_PRESSURE_ANIMAL_ATTACK_LIMIT
  + PROJECT_PRESSURE_DEHYDRATION_LIMIT
  + PROJECT_PRESSURE_DEVELOPMENT_PROVENANCE_LIMIT;

export function rememberedProjectPressureSourceEventIds(person: PersonState): string[] {
  const sourceEventIds = new Set<string>();
  for (const memory of person.memories) {
    for (const eventId of memory.sourceEventIds) sourceEventIds.add(eventId);
  }
  for (const condition of person.conditions) {
    for (const eventId of condition.sourceEventIds) sourceEventIds.add(eventId);
  }
  for (const fact of person.knowledge) {
    for (const eventId of fact.sourceEventIds) sourceEventIds.add(eventId);
  }
  for (const stack of person.inventory) {
    for (const eventId of stack.sourceEventIds) sourceEventIds.add(eventId);
  }
  return [...sourceEventIds].sort();
}

/** Immutable owner/source identity for one synchronous proposal compilation. */
export interface ProjectPressureSourceEventIdSnapshot {
  ownerId: PersonId;
  sourceEventIds: readonly string[];
  snapshotKey: string;
}

export function snapshotRememberedProjectPressureSources(
  person: PersonState,
): ProjectPressureSourceEventIdSnapshot {
  const sourceEventIds = Object.freeze(rememberedProjectPressureSourceEventIds(person));
  return Object.freeze({
    ownerId: person.id,
    sourceEventIds,
    snapshotKey: JSON.stringify([person.id, sourceEventIds]),
  });
}

/**
 * Minimal gameplay-readable projection of one verified event body. Flags may
 * overlap: an animal attack is also development provenance, as is a completed
 * dehydration action.
 */
export interface ProjectPressureEvidenceDescriptor {
  eventId: string;
  atMonth: number;
  orderInMonth: number;
  planningTick: number;
  orderInTick: number;
  huntFailure?: { ownerId: PersonId; animalId: string };
  attackVictimId?: PersonId;
  dehydrateOwnerId?: PersonId;
  developmentEligible: boolean;
}

export interface ProjectPressureEvidenceSelection {
  huntFailures: ProjectPressureEvidenceDescriptor[];
  animalAttacks: ProjectPressureEvidenceDescriptor[];
  dehydrations: ProjectPressureEvidenceDescriptor[];
  developmentProvenance: ProjectPressureEvidenceDescriptor[];
  descriptors: ProjectPressureEvidenceDescriptor[];
}

export function compareProjectPressureEvidenceDescriptors(
  left: ProjectPressureEvidenceDescriptor,
  right: ProjectPressureEvidenceDescriptor,
): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.planningTick - right.planningTick
    || left.orderInTick - right.orderInTick
    || left.eventId.localeCompare(right.eventId);
}

export function projectPressureEvidenceDescriptorFromWorldEvent(
  event: WorldEvent,
): ProjectPressureEvidenceDescriptor {
  const personalHuntFailure = event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'hunt'
    && event.diff.killed !== true;
  const personalAnimalAttack = event.kind === 'environment'
    && event.change === 'animal'
    && event.diff.process === 'attack-human'
    && typeof event.diff.victimId === 'string';
  const personalDehydration = event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'dehydrate';
  return Object.freeze({
    eventId: event.id,
    atMonth: event.atMonth,
    orderInMonth: event.orderInMonth,
    planningTick: event.planningTick ?? 0,
    orderInTick: event.orderInTick ?? 0,
    ...(personalHuntFailure ? {
      huntFailure: Object.freeze({
        ownerId: event.who,
        animalId: typeof event.diff.animalId === 'string' ? event.diff.animalId : 'unknown',
      }),
    } : {}),
    ...(personalAnimalAttack ? { attackVictimId: event.diff.victimId as PersonId } : {}),
    ...(personalDehydration ? { dehydrateOwnerId: event.who } : {}),
    developmentEligible: event.kind === 'environment'
      || (event.kind === 'action' && event.status === 'completed'),
  });
}

function last<T>(values: readonly T[], limit: number): T[] {
  return values.length > limit ? values.slice(-limit) : [...values];
}

/** Shared full/bounded selector over body-free descriptors. */
export function selectProjectPressureEvidenceDescriptors(
  candidates: Iterable<ProjectPressureEvidenceDescriptor>,
  personId: PersonId,
  atMonth: number,
): ProjectPressureEvidenceSelection {
  const ordered = [...new Map([...candidates]
    .filter((descriptor) => descriptor.atMonth <= atMonth)
    .map((descriptor) => [descriptor.eventId, descriptor] as const)).values()]
    .sort(compareProjectPressureEvidenceDescriptors);
  const huntFailureByEdge = new Map<string, ProjectPressureEvidenceDescriptor>();
  for (const descriptor of ordered) {
    if (descriptor.huntFailure?.ownerId !== personId) continue;
    huntFailureByEdge.set(
      `${descriptor.atMonth}:${descriptor.huntFailure.animalId}`,
      descriptor,
    );
  }
  const huntFailures = last(
    [...huntFailureByEdge.values()].sort(compareProjectPressureEvidenceDescriptors),
    PROJECT_PRESSURE_HUNT_FAILURE_LIMIT,
  );
  const animalAttacks = last(
    ordered.filter((descriptor) => descriptor.attackVictimId === personId),
    PROJECT_PRESSURE_ANIMAL_ATTACK_LIMIT,
  );
  const dehydrations = last(
    ordered.filter((descriptor) => descriptor.dehydrateOwnerId === personId),
    PROJECT_PRESSURE_DEHYDRATION_LIMIT,
  );
  const developmentProvenance = last(
    ordered.filter((descriptor) => descriptor.developmentEligible),
    PROJECT_PRESSURE_DEVELOPMENT_PROVENANCE_LIMIT,
  );
  const descriptors = [...new Map([
    ...huntFailures,
    ...animalAttacks,
    ...dehydrations,
    ...developmentProvenance,
  ].map((descriptor) => [descriptor.eventId, descriptor] as const)).values()]
    .sort(compareProjectPressureEvidenceDescriptors);
  if (descriptors.length > PROJECT_PRESSURE_BODY_WITNESS_LIMIT) {
    throw new Error(`project-pressure evidence 超出 ${PROJECT_PRESSURE_BODY_WITNESS_LIMIT} 条上限`);
  }
  return { huntFailures, animalAttacks, dehydrations, developmentProvenance, descriptors };
}
