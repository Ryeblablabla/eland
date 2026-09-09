import type { PrimitiveAction, VoxelPosition } from '../action';
import { Material, materialDefinition, type MaterialId } from '../material';
import type { PersonState } from '../person';
import { cellId, setVoxel, voxelAt } from '../../world/grid';
import { syncWorkVoxelMutation, type WorkMaterialWorld } from '../work-materials';
import { distanceToPosition } from './execution-helpers';
import { addInventory } from './inventory';

/** The existing pliant material band, limited to ground or soft vegetation. */
export function isHandExtractableTerrain(materialId: MaterialId): boolean {
  const material = materialDefinition(materialId);
  return material.phase === 'solid' && material.hardness <= 2
    && (material.tags.includes('ground') || material.tags.includes('plant'));
}

/** Shared by already validated World consumption and native terrain taking. */
export function consumeVoxelPortion(world: WorkMaterialWorld, position: VoxelPosition, eventId?: string, atMonth = 0) {
  const { grid } = world;
  const materialId = voxelAt(grid, position.x, position.y, position.z);
  const workMaterialChange = syncWorkVoxelMutation(world, position, materialId, Material.Air, atMonth, eventId);
  setVoxel(grid, position.x, position.y, position.z, Material.Air);
  return { kind: 'consume' as const, target: { kind: 'voxel' as const, position: { ...position } }, materialId, quantity: 1,
    ...(workMaterialChange ? { workMaterialChange } : {}) };
}

/** One chosen voxel is one portion; extraction does not mix it into another stack's material. */
export function takeSoftVoxelPortion(
  world: WorkMaterialWorld,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'transfer' }>,
  eventId: string,
  atMonth = 0,
) {
  const { grid } = world;
  const position = action.sourceVoxel!;
  if (action.from.kind !== 'ground' || action.from.cellId !== cellId(position.x, position.y)
    || action.from.z !== position.z || action.dropId) return {
    status: 'blocked' as const, result: '本次地表取料的体素来源与转移起点不一致，尚未取料', diff: {},
  };
  if (action.to.kind !== 'person' || action.to.personId !== person.id) return {
    status: 'blocked' as const, result: '地表软料需要先松取到本人手中，再另行放置或交给他人', diff: {},
  };
  const materialId = voxelAt(grid, position.x, position.y, position.z);
  if (materialId === Material.Air) return { status: 'blocked' as const, result: '点名的地表体素已经变空，未取得材料', diff: {} };
  if (materialId !== action.materialId) return {
    status: 'blocked' as const,
    result: `点名地表实际是${materialDefinition(materialId).name}，本次请求${materialDefinition(action.materialId).name}；材料不同，未取料`,
    diff: { sourceVoxel: position, actualMaterialId: materialId, requestedMaterialId: action.materialId },
  };
  if (distanceToPosition(person, position) > 1) return {
    status: 'blocked' as const, result: '点名的地表软料还不在本人近身松取范围，尚未取料', diff: {},
  };
  if (!isHandExtractableTerrain(materialId)) return {
    status: 'blocked' as const, result: `${materialDefinition(materialId).name}不属于可直接用手松取的地表软料，需要合适工具或其它处理`,
    diff: { sourceVoxel: position, sourceMaterialId: materialId },
  };
  const consumed = consumeVoxelPortion(world, position, eventId, atMonth);
  const lineage = `voxel:${position.x}:${position.y}:${position.z}`;
  const component = consumed.workMaterialChange?.component;
  const sourceEventIds = [...new Set([...(component?.sourceEventIds ?? []), eventId])].slice(-24);
  const sourceLineageKeys = [...new Set([...(component?.sourceLineageKeys ?? []), lineage])].slice(-32);
  const stack = addInventory(person, consumed.materialId, 1, sourceEventIds,
    `stack-${person.id}-${consumed.materialId}-${eventId}`, component?.recordPayloadId, sourceLineageKeys, component?.mechanicalState);
  const produced = { kind: 'produce' as const, destination: 'inventory' as const,
    materialId: consumed.materialId, quantity: 1, stackId: stack.id };
  return {
    status: 'completed' as const,
    result: `从点名地表松取了1份${materialDefinition(consumed.materialId).name}，已收入本人库存${action.quantity > 1
      ? `；本次请求${action.quantity}份，该体素只有1份可取` : ''}`,
    diff: { terrainExtraction: true, sourceVoxel: { ...position }, materialId: consumed.materialId,
      quantity: 1, requestedQuantity: action.quantity, availableBefore: 1, availableAfter: 0,
      from: action.from, to: action.to, outputStackId: stack.id, appliedEffects: [consumed, produced],
      sourceEventIds, sourceLineageKeys },
  };
}
