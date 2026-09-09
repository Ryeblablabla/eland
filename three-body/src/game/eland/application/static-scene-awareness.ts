import type { EnvironmentFact, SimulationState, WorldEvent } from '../domain/model';
import { Material } from '../domain/material';
import { isDormantDehydratedHibernating } from '../domain/person';
import { rememberMaterialPlace } from '../domain/spatial-knowledge';
import { livingPeople } from '../domain/state-index';
import { visibleCellsFor } from './action-options';
import { projectVisibleStaticSurfaces } from './visible-static-surfaces';

const positionKey = (position: { x: number; y: number; z: number }) => `${position.x}:${position.y}:${position.z}`;

/** Explicit lifecycle mutation: perceive now, then record an observer-owned
 * source and spatial memory. It teaches no technique and executes no action. */
export function recordVisibleStaticPlaceDiscoveries(
  state: SimulationState,
  atMonth: number,
  planningTick: number,
  currentMonthEvents: readonly WorldEvent[],
): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  // This month's observation facts prevent an unchanged scene from creating
  // new discoveries just because an old memory was evicted by existing limits.
  const seenThisMonth = new Map<string, Map<string, number>>();
  for (const event of currentMonthEvents) {
    if (event.kind !== 'environment' || !event.who || !event.diff.staticPlaceObservation
      || !Array.isArray(event.diff.observations)) continue;
    const seen = seenThisMonth.get(event.who) ?? new Map<string, number>();
    for (const item of event.diff.observations) if (item?.position && typeof item.materialId === 'number') {
      seen.set(positionKey(item.position), item.materialId);
    }
    seenThisMonth.set(event.who, seen);
  }
  for (const person of livingPeople(state)) {
    if (isDormantDehydratedHibernating(person)) continue;
    const seen = new Map(person.knownPlaces.map((place) => [positionKey(place.position), place.materialId]));
    for (const [key, material] of seenThisMonth.get(person.id) ?? []) seen.set(key, material);
    const observations = projectVisibleStaticSurfaces(state, person, visibleCellsFor(person))
      .filter((surface) => surface.materialId !== Material.Air && seen.get(positionKey(surface.position)) !== surface.materialId);
    for (const surface of observations) {
      // Distinct places need distinct evidence: memory compaction treats a
      // shared source event as one experienced fact.
      const event: EnvironmentFact = {
        id: `e-${atMonth}-environment-static-scene-${planningTick}-${person.id}-${positionKey(surface.position)}-${surface.materialId}`,
        kind: 'environment', change: 'material', who: person.id,
        atMonth, planningTick, orderInMonth: currentMonthEvents.length + events.length,
        orderInTick: currentMonthEvents.length + events.length, cellId: person.position.cellId,
        result: `${person.name}看见并记住了${surface.name}（${positionKey(surface.position)}）的位置`,
        diff: { staticPlaceObservation: true, discoveryKind: 'direct-visibility', observations: [surface] },
      };
      // A visible change at this exact position replaces only the current
      // remembered state; the earlier observation fact remains in history.
      person.knownPlaces = person.knownPlaces.filter((place) => positionKey(place.position) !== positionKey(surface.position)
        || place.materialId === surface.materialId);
      rememberMaterialPlace(person, surface.materialId, surface.position, atMonth, event.id);
      events.push(event);
    }
  }
  return events;
}
