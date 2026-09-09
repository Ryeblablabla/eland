import type { PrimitiveAction } from '../action';
import { Material, materialDefinition } from '../material';
import type { SimulationState } from '../model';
import type { PersonState } from '../person';
import { workAt, workById, type WorkComponent } from '../works';
import { workOccupiedVoxels } from '../work-layout';
import { reconcileWorkMaterials, syncWorkVoxelMutation, workComponentSources, workMaterialAt } from '../work-materials';
import { setVoxel } from '../../world/grid';
import { distanceToPosition } from './execution-helpers';
import { addDrop } from './inventory';

/** Artificial matter is recovered from its actual aggregate, before any
 * natural-tree/mineral recipe can inspect the same material id.
 */
export function executeWorkRecovery(state: SimulationState, person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const target = action.targets[0];
  const claimed = target?.kind === 'work' ? workById(state.world, target.workId)
    : target?.kind === 'voxel' ? workAt(state.world, target.position) : undefined;
  if (!claimed) return target?.kind === 'work'
    ? { status: 'blocked' as const, result: '点名的造物已经不在，未回收到材料', diff: {} } : null;
  const positions = target.kind === 'voxel' ? [target.position] : workOccupiedVoxels(claimed).map((voxel) => voxel.position);
  if (positions.some((position) => distanceToPosition(person, position) > 1)) return {
    status: 'blocked' as const, result: '待拆构件未全部在近身范围，需要靠近或逐个拆取，尚未回收', diff: { workId: claimed.id },
  };
  const work = reconcileWorkMaterials(state.world, claimed, atMonth, eventId);
  if (!work) return { status: 'blocked' as const, result: '造物原有的实体构件已经消失，未回收不存在的材料', diff: { workId: claimed.id } };
  let components: WorkComponent[];
  let change;
  if (target.kind === 'voxel') {
    const source = workMaterialAt(state.world, target.position);
    if (!source) return { status: 'blocked' as const, result: '点名位置已不是该造物的实际构件，未回收', diff: { workId: work.id } };
    change = syncWorkVoxelMutation(state.world, target.position, source.component.materialId, Material.Air, atMonth, eventId);
    setVoxel(state.world.grid, target.position.x, target.position.y, target.position.z, Material.Air);
    components = change?.component ? [change.component] : [];
  } else {
    components = work.components.map((part) => ({ ...structuredClone(part), ...workComponentSources(work, part, eventId) }));
    for (const voxel of workOccupiedVoxels(work)) setVoxel(state.world.grid, voxel.position.x, voxel.position.y, voxel.position.z, Material.Air);
    state.world.works = state.world.works?.filter((candidate) => candidate.id !== work.id);
  }
  const outputs = components.map((part, index) => {
    const drop = addDrop(state, part.materialId, part.quantity, person.position.cellId, atMonth,
      part.sourceEventIds ?? [eventId], `${person.id}-work-recovery-${index}`, part.recordPayloadId,
      person.position.z, part.sourceLineageKeys ?? [], undefined, undefined, part.mechanicalState);
    return { ...part, dropId: drop.id };
  });
  return { status: 'completed' as const,
    result: `从造物实际构件回收${outputs.map((part) => `${materialDefinition(part.materialId).name}${part.quantity}份`).join('、')}，材料已放在身旁`,
    diff: { workRecovery: true, workId: work.id, outputs, wholeWork: target.kind === 'work',
      ...(change ? { workMaterialChanges: [change] } : {}), removedPositions: positions },
  };
}
