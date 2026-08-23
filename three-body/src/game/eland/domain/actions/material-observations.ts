import type { VoxelPosition } from '../action';
import { Material, materialDefinition, type MaterialId } from '../material';
import type { PersonState } from '../person';
import { rememberMaterialPlace } from '../spatial-knowledge';
import { clamp } from './execution-helpers';

function mineralObservationId(
  materialId: MaterialId,
  position: { x: number; y: number; z: number },
): string {
  return `observation:mineral-deposit:${materialId}:${position.x}:${position.y}:${position.z}`;
}

export function parsedMineralObservation(factId: string): { materialId: MaterialId; position: VoxelPosition } | null {
  const match = factId.match(/^observation:mineral-deposit:(\d+):(\d+):(\d+):(\d+)$/);
  if (!match) return null;
  const [materialId, x, y, z] = match.slice(1).map(Number);
  const mineralIds = new Set<MaterialId>([Material.CopperOre, Material.TinOre, Material.IronOre]);
  if (![materialId, x, y, z].every(Number.isSafeInteger) || !mineralIds.has(materialId)) return null;
  return { materialId, position: { x, y, z } };
}

export function rememberMineralDeposit(
  person: PersonState,
  materialId: MaterialId,
  position: VoxelPosition,
  atMonth: number,
  eventId: string,
): void {
  const mineralIds = new Set<MaterialId>([Material.CopperOre, Material.TinOre, Material.IronOre]);
  if (!mineralIds.has(materialId)) return;
  rememberMaterialPlace(person, materialId, position, atMonth, eventId);
  const factId = mineralObservationId(materialId, position);
  const summary = `在格 ${position.x}, ${position.y} 观察到${materialDefinition(materialId).name}来源`;
  const known = person.knowledge.find((fact) => fact.id === factId);
  if (known) {
    known.confidence = clamp(known.confidence + 12);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({
    id: factId,
    kind: 'observation',
    summary,
    confidence: 64,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
}
