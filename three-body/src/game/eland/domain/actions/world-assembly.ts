import type { WorldAdjudicatedInteraction, WorldRef } from '../action';
import { Material, type MaterialId } from '../material';
import type { SimulationState } from '../model';
import type { PersonState } from '../person';
import type { WorkComponent } from '../works';
import { voxelAt } from '../../world/grid';

/** Snapshot the real inputs before an interaction consumes or moves them. */
export function prepareWorldAssembly(
  state: SimulationState,
  person: PersonState,
  verdict: WorldAdjudicatedInteraction,
): { ok: true; components: WorkComponent[] } | { ok: false; reason: string } {
  const allocations = new Map<string, { available: number; allocated: number }>();
  const components: WorkComponent[] = [];
  const materialAt = (target: WorldRef): { materialId: MaterialId; quantity: number } | undefined => {
    if (target.kind === 'inventory-stack') {
      return target.personId === person.id
        ? person.inventory.find((stack) => stack.id === target.stackId)
        : undefined;
    }
    if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId);
    if (target.kind === 'voxel') {
      const materialId = voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z);
      return materialId !== Material.Air ? { materialId, quantity: 1 } : undefined;
    }
    return undefined;
  };
  for (const effect of verdict.effects) {
    if (effect.kind !== 'consume' && effect.kind !== 'relocate') continue;
    const source = materialAt(effect.target);
    if (!source) return { ok: false, reason: '点名的投入材料已经不存在，需要重新取材' };
    const key = JSON.stringify(effect.target);
    const allocation = allocations.get(key) ?? { available: source.quantity, allocated: 0 };
    allocation.allocated += effect.quantity;
    allocations.set(key, allocation);
    if (allocation.allocated > allocation.available) {
      return { ok: false, reason: '同一份材料被重复分配；需要减少本次用量或先取得余下材料' };
    }
    if (effect.kind === 'consume') components.push({ materialId: source.materialId, quantity: effect.quantity });
  }
  const assemblies = verdict.effects.filter((effect) => effect.kind === 'assemble' || effect.kind === 'modify-structure');
  if (assemblies.length && components.length && verdict.effects.some((effect) => effect.kind === 'produce')) {
    return { ok: false, reason: '同一批投入不能同时变成背包产物和造物组件；先加工材料，再将加工后的实体装配' };
  }
  if (assemblies.length > 1 && components.length) {
    return { ok: false, reason: '这批投入尚未分配到各个造物；先完成其中一个，再用剩余材料继续搭建' };
  }
  return { ok: true, components };
}
