import { Material, materialHas, type MaterialId } from './material';
import type { KnownPlace, PersonState } from './person';

const MAX_KNOWN_PLACES = 24;

function placeId(materialId: MaterialId, position: { x: number; y: number; z: number }): string {
  return `place:${materialId}:${position.x}:${position.y}:${position.z}`;
}

function survivalPriority(materialId: MaterialId): number {
  if (materialId === Material.Water || materialId === Material.Ice) return 5;
  if (materialId === Material.CropMature || materialId === Material.BerryBush) return 4;
  if (materialId === Material.CopperOre || materialId === Material.TinOre || materialId === Material.IronOre) return 3;
  if (materialHas(materialId, 'facility')) return 2;
  if (materialId === Material.Container) return 1;
  return 0;
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
  person.knownPlaces.sort((a, b) => survivalPriority(b.materialId) - survivalPriority(a.materialId)
    || b.lastConfirmedAtMonth - a.lastConfirmedAtMonth
    || a.id.localeCompare(b.id));
  person.knownPlaces = person.knownPlaces.slice(0, MAX_KNOWN_PLACES);
  return person.knownPlaces.find((place) => place.id === id) ?? existing!;
}
