import type { VoxelPosition } from './action';
import { Material, materialDefinition, materialHas, type MaterialId } from './material';
import type { ActionFact, SimulationState } from './model';
import { actionFacts, compareWorldEventsInCanonicalOrder, environmentFacts } from './event-index';
import { rootedSolidPath } from './solid-support';
import { workAt, type WorkState } from './works';
import { workOccupiedVoxels } from './work-layout';
import { cellId, voxelAt, type VoxelWorld } from '../world/grid';
import { seededFraction } from '../world/generator';

type ThermalWorld = { grid: VoxelWorld; works?: WorkState[] };
export interface RainCover {
  position: VoxelPosition;
  materialId: MaterialId;
  workId?: string;
  workSourceEventIds?: string[];
}
export interface FireProcessEvidence {
  position: VoxelPosition;
  precipitation: boolean;
  naturalBurnoutSample: number;
  naturalBurnout: boolean;
  rainExposed: boolean;
  survived: boolean;
  cover?: RainCover;
}
export interface RainProtectedProcessingEvidence {
  environmentEventId: string;
  fire: FireProcessEvidence;
}

/** Coarse world physics: precipitation falls vertically. A full solid, rooted
 * voxel intercepts it; a leaf canopy, floating patch or nearby structure does
 * not. No facility name, intended function or Work profile is consulted.
 */
export function rainCoverAt(world: ThermalWorld, position: VoxelPosition): RainCover | undefined {
  for (let z = position.z + 1; z < world.grid.levels; z += 1) {
    const materialId = voxelAt(world.grid, position.x, position.y, z);
    if (materialDefinition(materialId).phase !== 'solid'
      || !(materialHas(materialId, 'solid') || materialHas(materialId, 'ground'))) continue;
    const roof = { x: position.x, y: position.y, z };
    if (!rootedSolidPath(world.grid, roof)) continue;
    const claimed = workAt(world, roof);
    const work = claimed && workOccupiedVoxels(claimed).some((part) => part.materialId === materialId
      && part.position.x === roof.x && part.position.y === roof.y && part.position.z === roof.z) ? claimed : undefined;
    return { position: roof, materialId,
      ...(work ? { workId: work.id, workSourceEventIds: [...work.sourceEventIds] } : {}) };
  }
  return undefined;
}

/** One scan per world month includes fires below roofs. Natural burnout keeps
 * the existing seed/key and 0.28 rate; a cover only changes precipitation contact.
 */
export function planFireProcesses(world: ThermalWorld,
  input: { seed: number; atMonth: number; weatherKind: string }): FireProcessEvidence[] {
  const precipitation = ['rain', 'storm', 'snow'].includes(input.weatherKind);
  const results: FireProcessEvidence[] = [];
  const plane = world.grid.width * world.grid.depth;
  for (let index = 0; index < plane * world.grid.levels; index += 1) {
    if (world.grid.voxels[index] !== Material.Fire) continue;
    const cell = index % plane;
    const position = { x: cell % world.grid.width, y: Math.floor(cell / world.grid.width), z: Math.floor(index / plane) };
    const naturalBurnoutSample = seededFraction(input.seed, `world-process:${input.atMonth}:${cell}:${Material.Fire}`);
    const naturalBurnout = naturalBurnoutSample < 0.28;
    const cover = rainCoverAt(world, position);
    const rainExposed = precipitation && !cover;
    results.push({ position, precipitation, naturalBurnoutSample, naturalBurnout, rainExposed,
      survived: !naturalBurnout && !rainExposed, ...(cover ? { cover } : {}) });
  }
  return results;
}

function atPosition(value: unknown, position: VoxelPosition): boolean {
  const candidate = value as VoxelPosition | undefined;
  return candidate?.x === position.x && candidate.y === position.y && candidate.z === position.z;
}

function changesFire(event: ActionFact, position: VoxelPosition): boolean {
  if (!['completed', 'progressed'].includes(event.status)) return false;
  const diff = event.diff;
  if (Array.isArray(diff.materialChanges) && diff.materialChanges.some((change) => change.cellId === cellId(position.x, position.y)
    && change.z === position.z && change.from !== change.to)) return true;
  if (Array.isArray(diff.removedPositions) && diff.removedPositions.some((value) => atPosition(value, position))) return true;
  if (diff.terrainExtraction === true && atPosition(diff.sourceVoxel, position)) return true;
  if (event.action.kind === 'act' && ['combine', 'exert'].includes(event.action.operation)
    && diff.outputLocation !== 'inventory' && typeof diff.outputMaterialId === 'number' && atPosition(diff.position, position)) return true;
  if (event.action.kind === 'act' && event.action.operation === 'separate'
    && event.action.targets.some((target) => target.kind === 'voxel' && atPosition(target.position, position))) return true;
  return Array.isArray(diff.appliedEffects) && diff.appliedEffects.some((effect) => (
    ['consume', 'replace-voxel'].includes(effect.kind) && effect.target?.kind === 'voxel' && atPosition(effect.target.position, position)
  ));
}

/** An actual rain-protection outcome must precede processing. A subsequent
 * mutation of that fire invalidates this causal link, including fire
 * extinguished and later recreated at the same coordinates.
 */
export function rainProtectedProcessingAt(state: SimulationState, position: VoxelPosition,
  atMonth: number): RainProtectedProcessingEvidence | undefined {
  const { world } = state;
  if (voxelAt(world.grid, position.x, position.y, position.z) !== Material.Fire) return undefined;
  // These existing indexes include current planning-overlay facts, and are
  // reconstructible from committed history after a state clone or reload.
  const environments = environmentFacts(state);
  let source: (typeof environments)[number] | undefined;
  let fire: FireProcessEvidence | undefined;
  for (let index = environments.length - 1; index >= 0; index -= 1) {
    const event = environments[index];
    if (event.atMonth < atMonth) break;
    if (event.atMonth !== atMonth) continue;
    const processes = event.diff.fireProcesses as FireProcessEvidence[] | undefined;
    const matched = processes?.find((candidate) => atPosition(candidate.position, position));
    if (matched) { source = event; fire = matched; break; }
  }
  if (!source) return undefined;
  if (!fire?.survived || !fire.precipitation || fire.naturalBurnout || fire.rainExposed || !fire.cover?.workId) return undefined;
  const actions = actionFacts(state);
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const event = actions[index];
    if (event.atMonth < atMonth) break;
    if (compareWorldEventsInCanonicalOrder(event, source) > 0 && changesFire(event, position)) return undefined;
  }
  const current = rainCoverAt(world, position);
  if (!current || current.workId !== fire.cover.workId || current.materialId !== fire.cover.materialId
    || current.position.z !== fire.cover.position.z) return undefined;
  return { environmentEventId: source.id, fire: structuredClone(fire) };
}

/** The processing rule retains the actual ingredients' lineage, not just a
 * recipe/event label. The transformed material gets its own fresh physical form.
 */
export function processingSources(stack: SimulationState['people'][number]['inventory'][number],
  personId: string, eventId: string) {
  return {
    sourceEventIds: [...new Set([...stack.sourceEventIds, eventId])].slice(-24),
    sourceLineageKeys: [...new Set([...(stack.sourceLineageKeys ?? []), `inventory:${personId}:${stack.id}`])].slice(-32),
  };
}
