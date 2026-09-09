import type { Intent, PrimitiveAction, WorldRef } from './action';
import { BASE_ACTIVITY_EPISODE_WORK_EFFORT, physicalWorkCapacityMultiplier } from './calendar';
import { Material, materialDefinition } from './material';
import type { SimulationState } from './model';
import type { PersonState } from './person';
import { productionToolMultiplier } from './production-tool';
import { isStandingPosition, standingPathMovementCost, voxelAt, type StandingPosition, type VoxelWorld } from '../world/grid';

/** Shared by every physical step performed by one actor in this episode. */
export interface ActivityWorkBudget {
  remainingEffort: number;
}

/** Real labour may outlive an episode; material results are committed only at completion. */
export interface ActionWorkProgress {
  basis: string;
  completedWork: number;
  requiredWork: number;
  sourceEventIds: string[];
}

/** Movement belongs to the body's actual unfinished edge, not a thought/Intent identity. */
export interface MovementWorkProgress extends ActionWorkProgress {
  from: StandingPosition;
  to: StandingPosition;
}

export function movementWorkBasis(grid: VoxelWorld, from: StandingPosition, to: StandingPosition): string {
  return JSON.stringify({ moveEdge: [from, to], requiredWork: standingPathMovementCost(grid, [from, to]),
    standable: [isStandingPosition(grid, from), isStandingPosition(grid, to)] });
}

/** Displacement and changed physical premises invalidate credit; changing one's mind does not. */
export function invalidateChangedMovementWork(state: SimulationState): void {
  for (const person of state.people) {
    const progress = person.movementWork;
    if (progress && (person.position.cellId !== progress.from.cellId || person.position.z !== progress.from.z
      || movementWorkBasis(state.world.grid, progress.from, progress.to) !== progress.basis)) delete person.movementWork;
  }
}

export function createActivityWorkBudget(): ActivityWorkBudget {
  return { remainingEffort: BASE_ACTIVITY_EPISODE_WORK_EFFORT };
}

export function actorWorkCapacity(person: PersonState): number {
  return physicalWorkCapacityMultiplier({ locomotion: person.baselineCapacities.locomotion,
    ...person.body, conditions: person.conditions });
}

export function actionWorkKind(action: PrimitiveAction): 'instant' | 'movement' | 'work' {
  return action.kind === 'talk' || action.kind === 'act' && action.operation === 'ingest'
    ? 'instant' : action.kind === 'move' ? 'movement' : 'work';
}

function referencedMaterial(state: SimulationState, person: PersonState, ref: WorldRef) {
  if (ref.kind === 'voxel') {
    const materialId = voxelAt(state.world.grid, ref.position.x, ref.position.y, ref.position.z);
    return { materialId, quantity: 1 };
  }
  if (ref.kind === 'inventory-stack') {
    const owner = ref.personId === person.id ? person : state.people.find((candidate) => candidate.id === ref.personId);
    const stack = owner?.inventory.find((candidate) => candidate.id === ref.stackId && candidate.quantity > 0);
    return stack ? { materialId: stack.materialId, quantity: stack.quantity } : undefined;
  }
  if (ref.kind === 'drop') {
    const drop = state.world.drops.find((candidate) => candidate.id === ref.dropId && candidate.quantity > 0);
    return drop ? { materialId: drop.materialId, quantity: drop.quantity } : undefined;
  }
  return undefined;
}

/**
 * Game-normalized workload, separate from preference and elapsed calendar time.
 * Material handling uses its real mass; separation/combination additionally
 * uses existing hardness and tool throughput. Unspecified complex capabilities
 * retain their prior one-episode workload instead of becoming free.
 */
export function actionWorkQuote(
  state: SimulationState,
  person: PersonState,
  action: PrimitiveAction,
  transferSettlement?: { materialId: number; quantity: number },
) {
  const kind = actionWorkKind(action);
  if (kind === 'instant') return { kind, work: 0, basis: JSON.stringify(action) };
  if (kind === 'movement') return { kind, work: 0, basis: JSON.stringify(action) };
  let work = BASE_ACTIVITY_EPISODE_WORK_EFFORT as number;
  const materials: Array<{ materialId: number; quantity: number }> = [];
  const materialWork = (materialId: number, quantity: number, process: boolean): number => {
    const material = materialDefinition(materialId);
    materials.push({ materialId, quantity });
    return material.mass * quantity * (process ? Math.max(1, material.hardness) : 1);
  };
  // Transfer quantities come from the executor's real source/capacity/contact
  // settlement, including zero-change and actually resisted attempts. Merely
  // requesting a larger quantity does not create additional physical labour.
  if (transferSettlement) work = materialWork(transferSettlement.materialId, transferSettlement.quantity, false);
  else if (action.kind === 'transfer') work = materialWork(action.materialId, 0, false);
  else if (action.kind === 'act' && action.operation === 'separate') {
    const target = action.targets[0];
    const material = target ? referencedMaterial(state, person, target) : undefined;
    if (material && material.materialId !== Material.Air) work = materialWork(material.materialId, 1, true);
  } else if (action.kind === 'act' && ['combine', 'expose'].includes(action.operation)) {
    const inputs = action.targets.filter((target) => target.kind === 'inventory-stack')
      .flatMap((target) => referencedMaterial(state, person, target) ?? []);
    if (inputs.length) work = inputs.reduce((sum, input) => sum + materialWork(input.materialId, 1, true), 0);
  } else if (action.kind === 'world-interact') {
    const inputs = action.adjudication.effects.flatMap((effect) => effect.kind === 'consume'
      ? [{ material: referencedMaterial(state, person, effect.target), quantity: effect.quantity }] : []);
    if (inputs.length && inputs.every((input) => input.material)) work = inputs.reduce((sum, input) =>
      sum + materialWork(input.material!.materialId, input.quantity, true), 0);
  }
  const tool = action.kind === 'act' && action.toolStackId
    ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0) : undefined;
  const throughput = productionToolMultiplier(tool?.materialId);
  return { kind: 'work' as const, work: materials.length ? work / throughput : BASE_ACTIVITY_EPISODE_WORK_EFFORT,
    fixedEpisode: materials.length === 0,
    basis: JSON.stringify({ action, materials, tool: tool ? { id: tool.id, materialId: tool.materialId } : undefined }) };
}

export function workProgressHolder(person: PersonState, intent: Intent | undefined): { actionWork?: ActionWorkProgress } {
  return intent ?? person;
}
