import type { WorldRef } from './action';
import { materialDefinition, type MaterialId } from './material';
import type { ActionFact, SimulationState } from './model';
import type { KnownFact, PersonState } from './person';
import { WORK_ARRANGEMENTS, WORK_ARRANGEMENT_NAMES, type WorkArrangement, type WorkComponent, type WorkProfile } from './works';
import type { WorkLayout, WorkLayoutVoxel } from './work-layout';
import { voxelAt } from '../world/grid';

export interface ProcedureInputRole {
  roleId: string;
  materialId: MaterialId;
  quantity: number;
}

export interface ProcedureContextRole {
  roleId: string;
  kind: WorldRef['kind'];
  materialId?: MaterialId;
  /** Existing material and geometry before a modification, not newly made output. */
  work?: ProcedureWorkState;
}

export interface ProcedureWorkState {
  arrangement: WorkArrangement;
  components: WorkComponent[];
  anchorMaterialId: MaterialId;
  layout: WorkLayout;
  profile: WorkProfile;
}

export type ProcedureOutput =
  | { roleId: string; kind: 'material'; materialId: MaterialId; quantity: number; destination: 'inventory' | 'ground' }
  | (ProcedureWorkState & {
    roleId: string;
    kind: 'work';
    operation: 'create' | 'modify';
    /** A modification requires this existing work in addition to consumed inputs. */
    sourceContextRoleId?: string;
    layoutChange: { removed: WorkLayoutVoxel[]; placed: WorkLayoutVoxel[] };
  });

export interface ProcedureExperience {
  actorId: string;
  eventId: string;
  atMonth: number;
  inputBindings: Array<{ roleId: string; target: WorldRef }>;
  contextBindings: Array<{ roleId: string; target: WorldRef }>;
  outputBindings: Array<{ roleId: string; stackId?: string; dropId?: string; workId?: string }>;
}

/** An experienced way to try something again, never an executable world verdict. */
export interface ProceduralKnowledge {
  version: 'procedural-knowledge-v1';
  /** What the actor actually attempted. Expected success is not a learned law. */
  instruction: string;
  inputs: ProcedureInputRole[];
  contexts: ProcedureContextRole[];
  operations: string[];
  outputs: ProcedureOutput[];
  experiences: ProcedureExperience[];
  transmissionEventIds: string[];
}

const MAX_EXPERIENCES = 12;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function material(value: unknown): value is MaterialId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && materialDefinition(value).id === value;
}

function materialAt(state: SimulationState, target: WorldRef): MaterialId | undefined {
  if (target.kind === 'voxel') return voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z);
  if (target.kind === 'inventory-stack') return state.people.find((person) => person.id === target.personId)
    ?.inventory.find((stack) => stack.id === target.stackId)?.materialId;
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.materialId;
  return undefined;
}

/** Only executor snapshots supply these facts; request prose supplies none. */
function workStateSnapshot(value: unknown): ProcedureWorkState | undefined {
  const snapshot = object(value);
  if (!snapshot || !WORK_ARRANGEMENTS.includes(snapshot.arrangement as WorkArrangement)
    || !Array.isArray(snapshot.components) || !material(snapshot.anchorMaterialId)) return undefined;
  const components = snapshot.components as WorkComponent[];
  const profile = object(snapshot.profile);
  if (components.some((item) => !material(item.materialId) || !positive(item.quantity))
    || !profile || !['cover', 'rigidity', 'stability'].every((key) => typeof profile[key] === 'number' && Number.isFinite(profile[key]))) return undefined;
  const layout = snapshot.layout as WorkLayout | undefined;
  return {
    arrangement: snapshot.arrangement as WorkArrangement,
    components: structuredClone(components).sort((left, right) => left.materialId - right.materialId),
    anchorMaterialId: snapshot.anchorMaterialId,
    layout: structuredClone(layout ?? {
      version: 'work-layout-v1', voxels: [{ offset: { x: 0, y: 0, z: 0 }, materialId: snapshot.anchorMaterialId }],
    }),
    profile: { cover: profile.cover as number, rigidity: profile.rigidity as number, stability: profile.stability as number },
  };
}

function layoutChange(previous: WorkLayout | undefined, current: WorkLayout): { removed: WorkLayoutVoxel[]; placed: WorkLayoutVoxel[] } {
  const key = (voxel: WorkLayoutVoxel): string => `${voxel.offset.x}:${voxel.offset.y}:${voxel.offset.z}:${voxel.materialId}`;
  const before = new Map((previous?.voxels ?? []).map((voxel) => [key(voxel), voxel]));
  const after = new Map(current.voxels.map((voxel) => [key(voxel), voxel]));
  return {
    removed: structuredClone([...before].filter(([id]) => !after.has(id)).map(([, voxel]) => voxel)),
    placed: structuredClone([...after].filter(([id]) => !before.has(id)).map(([, voxel]) => voxel)),
  };
}

function signature(procedure: Pick<ProceduralKnowledge, 'inputs' | 'contexts' | 'operations' | 'outputs'>): string {
  const source = JSON.stringify(procedure);
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `technique:experienced:${hash.toString(16)}`;
}

/** Merge shared accounts without changing the owner of any actual experience. */
export function transmittedProcedure(
  incoming: ProceduralKnowledge,
  transmissionEventId: string,
  previous?: ProceduralKnowledge,
): ProceduralKnowledge {
  const experiences = new Map((previous?.experiences ?? []).map((experience) => [experience.eventId, experience]));
  for (const experience of incoming.experiences) experiences.set(experience.eventId, experience);
  return {
    ...structuredClone(incoming),
    experiences: structuredClone([...experiences.values()].slice(-MAX_EXPERIENCES)),
    transmissionEventIds: [...new Set([
      ...(previous?.transmissionEventIds ?? []), ...incoming.transmissionEventIds, transmissionEventId,
    ])].slice(-24),
  };
}

/**
 * Called after physical execution. Capture consumed inputs and actual products;
 * observation prose, social assertions, approach movement and mere relocation
 * cannot create a manufacturing method. Reuse must bind fresh objects and run
 * the normal Plan/world execution path; this payload contains no verdict.
 */
export function recordExperiencedProcedure(
  state: SimulationState,
  person: PersonState,
  fact: ActionFact,
): KnownFact | undefined {
  if (fact.who !== person.id || fact.status !== 'completed' || fact.action.kind !== 'world-interact'
    || !Array.isArray(fact.diff.appliedEffects)) return undefined;
  const effects: Record<string, unknown>[] = fact.diff.appliedEffects.flatMap((value) => {
    const effect = object(value);
    return effect ? [effect] : [];
  });
  const sourceTargets = new Map(fact.action.adjudication.targets.map((target) => [JSON.stringify(target), target]));
  const inputs: ProcedureInputRole[] = [];
  const inputBindings: ProcedureExperience['inputBindings'] = [];
  for (const effect of effects) {
    if (effect.kind !== 'consume' || !material(effect.materialId) || !positive(effect.quantity)) continue;
    const target = sourceTargets.get(JSON.stringify(effect.target));
    if (!target) continue;
    const roleId = `input${inputs.length + 1}`;
    inputs.push({ roleId, materialId: effect.materialId, quantity: effect.quantity });
    inputBindings.push({ roleId, target: structuredClone(target) });
  }
  const consumedTargets = new Set(inputBindings.map((binding) => JSON.stringify(binding.target)));
  const contexts: ProcedureContextRole[] = [];
  const contextBindings: ProcedureExperience['contextBindings'] = [];
  for (const target of fact.action.adjudication.targets) {
    if (consumedTargets.has(JSON.stringify(target)) || ['person', 'animal', 'remains'].includes(target.kind)) continue;
    const roleId = `context${contexts.length + 1}`;
    // Construction changes its site. The current anchor material cannot be
    // retroactively treated as an input precondition of the observed method.
    const materialId = target.kind === 'inventory-stack' || target.kind === 'drop'
      ? materialAt(state, target) : undefined;
    contexts.push({ roleId, kind: target.kind, ...(materialId !== undefined ? { materialId } : {}) });
    contextBindings.push({ roleId, target: structuredClone(target) });
  }
  const outputs: ProcedureOutput[] = [];
  const outputBindings: ProcedureExperience['outputBindings'] = [];
  for (const effect of effects) {
    const roleId = `output${outputs.length + 1}`;
    if (effect.kind === 'produce' && material(effect.materialId) && positive(effect.quantity)) {
      const stack = typeof effect.stackId === 'string'
        ? person.inventory.find((candidate) => candidate.id === effect.stackId) : undefined;
      const drop = typeof effect.dropId === 'string'
        ? state.world.drops.find((candidate) => candidate.id === effect.dropId) : undefined;
      const product = stack ?? drop;
      if (!product || product.materialId !== effect.materialId || product.quantity < effect.quantity) continue;
      outputs.push({ roleId, kind: 'material', materialId: effect.materialId, quantity: effect.quantity,
        destination: stack ? 'inventory' : 'ground' });
      outputBindings.push({ roleId, ...(stack ? { stackId: stack.id } : { dropId: drop!.id }) });
    } else if ((effect.kind === 'assemble' || effect.kind === 'modify-structure') && typeof effect.workId === 'string') {
      const work = state.world.works?.find((candidate) => candidate.id === effect.workId
        && candidate.sourceEventIds.includes(fact.id));
      const after = workStateSnapshot(effect);
      if (!work || !after) continue;
      const before = effect.kind === 'modify-structure' ? workStateSnapshot(effect.previousWork) : undefined;
      // Missing history must never teach that incremental inputs created the
      // entire cumulative work. Pure rearrangement is learned without new input.
      if (effect.kind === 'modify-structure' && !before) continue;
      if (!inputs.length && (!before || JSON.stringify(before) === JSON.stringify(after))) continue;
      let sourceContextRoleId: string | undefined;
      if (before) {
        const target = sourceTargets.get(JSON.stringify(effect.target));
        if (!target) continue;
        let context = contextBindings.flatMap((binding) => {
          if (JSON.stringify(binding.target) !== JSON.stringify(target)) return [];
          const role = contexts.find((candidate) => candidate.roleId === binding.roleId)!;
          return !role.work || JSON.stringify(role.work) === JSON.stringify(before) ? [role] : [];
        })[0];
        if (!context) {
          const contextRoleId = `context${contexts.length + 1}`;
          context = { roleId: contextRoleId, kind: target.kind };
          contexts.push(context);
          contextBindings.push({ roleId: contextRoleId, target: structuredClone(target) });
        }
        context.work = before;
        sourceContextRoleId = context.roleId;
      }
      outputs.push({
        roleId, kind: 'work', ...after, operation: before ? 'modify' : 'create',
        ...(sourceContextRoleId ? { sourceContextRoleId } : {}),
        layoutChange: layoutChange(before?.layout, after.layout),
      });
      outputBindings.push({ roleId, workId: work.id });
    }
  }
  if (!outputs.length) return undefined;
  // Picking a stone up is possession transfer, not discovering how to make stone.
  if (outputs.every((output) => output.kind === 'material')) {
    if (!inputs.length) return undefined;
    const balance = new Map<MaterialId, number>();
    for (const input of inputs) balance.set(input.materialId, (balance.get(input.materialId) ?? 0) + input.quantity);
    for (const output of outputs) if (output.kind === 'material') {
      balance.set(output.materialId, (balance.get(output.materialId) ?? 0) - output.quantity);
    }
    if ([...balance.values()].every((quantity) => quantity === 0)) return undefined;
  }

  const operations = effects.flatMap((effect) => typeof effect.kind === 'string'
    && ['consume', 'produce', 'assemble', 'modify-structure', 'replace-voxel'].includes(effect.kind) ? [effect.kind] : []);
  const id = signature({ inputs, contexts, operations, outputs });
  const existing = person.knowledge.find((knowledge) => knowledge.id === id && knowledge.kind === 'technique');
  if (existing?.procedural?.experiences.some((experience) => experience.eventId === fact.id)) return existing;
  const experience: ProcedureExperience = {
    actorId: person.id, eventId: fact.id, atMonth: fact.atMonth, inputBindings, contextBindings, outputBindings,
  };
  const procedural: ProceduralKnowledge = {
    version: 'procedural-knowledge-v1',
    instruction: fact.action.adjudication.request,
    inputs, contexts, operations, outputs,
    experiences: [...(existing?.procedural?.experiences ?? []), experience].slice(-MAX_EXPERIENCES),
    transmissionEventIds: [...(existing?.procedural?.transmissionEventIds ?? [])],
  };
  const outputDescription = outputs.map((output) => output.kind === 'material'
    ? `${output.quantity}份${materialDefinition(output.materialId).name}`
    : `${output.operation === 'modify' ? '将已有造物改成' : '做出'}${WORK_ARRANGEMENT_NAMES[output.arrangement]}的组合物（${output.layout.voxels.length}个实际材料位置）`).join('、');
  const inputDescription = inputs.length
    ? `投入${inputs.map((input) => `${input.quantity}份${materialDefinition(input.materialId).name}`).join('、')}`
    : '重排已有材料';
  const existingDescription = contexts.filter((context) => context.work).map((context) =>
    `${context.roleId}已有${context.work!.components.map((component) => `${component.quantity}份${materialDefinition(component.materialId).name}`).join('、')}`).join('；');
  const summary = `${existingDescription ? `在${existingDescription}的基础上，` : ''}${inputDescription}，得到${outputDescription}的亲历方法`;
  const known: KnownFact = existing ?? {
    id, kind: 'technique', summary, confidence: 68, learnedAtMonth: fact.atMonth, sourceEventIds: [],
  };
  // A reader's tentative account now has one personally executed instance.
  // Confidence describes that observation; it never authorizes another run.
  known.confidence = Math.max(known.confidence, 68);
  known.procedural = procedural;
  known.sourceEventIds = [...new Set([...known.sourceEventIds, fact.id])].slice(-24);
  if (!existing) person.knowledge.push(known);
  fact.diff.experiencedProcedureId = id;
  return known;
}
