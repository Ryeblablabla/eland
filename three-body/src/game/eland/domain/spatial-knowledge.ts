import type { MaterialId } from './material';
import type { KnownPlace, PersonState } from './person';

const MAX_KNOWN_PLACES = 12;

function placeId(materialId: MaterialId, position: { x: number; y: number; z: number }): string {
  return `place:${materialId}:${position.x}:${position.y}:${position.z}`;
}

/** 地点只能来自本人成功的观察或使用，并按最近确认时间保持一个固定预算。 */
export function rememberMaterialPlace(
  person: PersonState,
  materialId: MaterialId,
  position: { x: number; y: number; z: number },
  atMonth: number,
  sourceEventId: string,
): KnownPlace {
  const id = placeId(materialId, position);
  const existing = person.knownPlaces.find((place) => place.id === id);
  if (existing) {
    existing.lastConfirmedAtMonth = atMonth;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, sourceEventId])].slice(-12);
  } else {
    person.knownPlaces.push({
      id,
      materialId,
      position: { ...position },
      learnedAtMonth: atMonth,
      lastConfirmedAtMonth: atMonth,
      sourceEventIds: [sourceEventId],
    });
  }
  person.knownPlaces.sort((a, b) => b.lastConfirmedAtMonth - a.lastConfirmedAtMonth || a.id.localeCompare(b.id));
  person.knownPlaces = person.knownPlaces.slice(0, MAX_KNOWN_PLACES);
  return person.knownPlaces.find((place) => place.id === id) ?? existing!;
}
