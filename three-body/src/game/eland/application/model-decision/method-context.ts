import { materialDefinition } from '../../domain/material';
import type { DecisionRequestContext } from './decision-context';
import type { DecisionProbeHandleMap } from './capability-handles';
import type { ProcedureWorkState } from '../../domain/procedural-knowledge';
import type { WorkLayoutVoxel } from '../../domain/work-layout';

const describeVoxel = (voxel: WorkLayoutVoxel) => ({ offset: { ...voxel.offset }, materialKey: materialDefinition(voxel.materialId).key });
const describeWork = (work: ProcedureWorkState) => ({
  arrangement: work.arrangement,
  components: work.components.map((item) => ({ material: materialDefinition(item.materialId).name, materialKey: materialDefinition(item.materialId).key, quantity: item.quantity })),
  layout: work.layout.voxels.map(describeVoxel),
  physicalProfile: { ...work.profile },
  anchorMaterialKey: materialDefinition(work.anchorMaterialId).key,
});

/** Experiences suggest current bindings; they never replay an old verdict. */
export function knownMethodContext(context: DecisionRequestContext, handles: DecisionProbeHandleMap): Array<Record<string, unknown> & { handle: string }> {
  const held = new Map(handles.held.map((item) => [item.stackId, item.handle]));
  const visible = new Map(handles.visible.flatMap((item) => item.kind === 'drop' ? [[item.dropId, item.handle] as const] : []));
  return (context.person.procedures ?? []).map(({ summary, confidence, method }, index) => ({
    handle: `method${index + 1}`,
    summary,
    instruction: method.instruction,
    confidence,
    inputs: method.inputs.map((input) => ({
      role: input.roleId,
      material: materialDefinition(input.materialId).name,
      materialKey: materialDefinition(input.materialId).key,
      quantity: input.quantity,
      currentBindings: [
        ...context.person.inventory.filter((item) => item.materialId === input.materialId && item.quantity >= input.quantity)
          .map((item) => held.get(item.stackId)),
        ...context.visibleDrops.filter((item) => item.name === materialDefinition(input.materialId).name && item.quantity >= input.quantity)
          .map((item) => visible.get(item.id)),
      ].filter(Boolean),
    })),
    environments: method.contexts.map((role) => ({
      role: role.roleId,
      kind: role.kind,
      ...(role.materialId !== undefined ? { material: materialDefinition(role.materialId).name, materialKey: materialDefinition(role.materialId).key } : {}),
      ...(role.work ? {
        existingWorkBeforeOperation: describeWork(role.work),
        currentWorkCandidates: (context.visibleWorks ?? []).flatMap((work) => {
          const ref = handles.visible.find((item) => item.kind === 'work' && item.workId === work.id)?.handle;
          return ref ? [{ ref, name: work.summary, arrangement: work.arrangement,
            components: work.components, layout: work.layout, physicalProfile: work.profile }] : [];
        }),
      } : {}),
    })),
    observedOperations: method.operations,
    observedOutputs: method.outputs.map((output) => output.kind === 'material' ? {
      kind: output.kind, material: materialDefinition(output.materialId).name,
      quantity: output.quantity, destination: output.destination,
    } : {
      kind: output.kind, operation: output.operation,
      ...(output.sourceContextRoleId ? { existingWorkRole: output.sourceContextRoleId } : {}),
      ...describeWork(output),
      layoutChange: { removed: output.layoutChange.removed.map(describeVoxel), placed: output.layoutChange.placed.map(describeVoxel) },
    }),
    recentExperiences: method.experiences.slice(-3).map((experience) => ({
      atMonth: experience.atMonth,
      personallyExperienced: experience.actorId === context.person.id,
      results: experience.outputBindings.map((binding) => ({
        role: binding.roleId,
        ...(binding.workId ? { currentWork: handles.visible.find((item) => item.kind === 'work' && item.workId === binding.workId)?.handle } : {}),
        ...(binding.stackId ? { heldObject: held.get(binding.stackId) } : {}),
        ...(binding.dropId ? { nearbyObject: visible.get(binding.dropId) } : {}),
      })),
    })),
    evidence: 'inputs 仅是本次新消耗，environments 中的 existingWorkBeforeOperation 是原先已有实体及累计材料，observedOutputs 是操作后的完整结果。当前候选供比较与重新绑定，不保证可用或成功；本次仍需选定当前材料、已有物件与环境，并由世界重新执行裁决',
  }));
}
