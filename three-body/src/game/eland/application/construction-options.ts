import type { ActionOption } from '../domain/action';
import { Material, materialDefinition, materialHas, type MaterialId } from '../domain/material';
import { isAlive, type PersonState } from '../domain/person';
import type { SimulationState } from '../domain/model';
import { cellId, cellX, cellY, neighbors4, voxelAt } from '../world/grid';

type CandidateKind = 'grounded' | 'vertical' | 'lateral' | 'overhead';

interface ConnectionCandidate {
  kind: CandidateKind;
  position: { x: number; y: number; z: number };
}

const KIND_ORDER: CandidateKind[] = ['grounded', 'vertical', 'lateral', 'overhead'];

function occupiedByBody(state: SimulationState, position: ConnectionCandidate['position']): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && (candidate.position.z === position.z || candidate.position.z + 1 === position.z));
}

function constructedStructurePositions(state: SimulationState): Set<string> {
  return new Set(state.world.past.flatMap((event) => {
    if (event.kind !== 'action' || event.status !== 'completed' || event.action.kind !== 'act' || event.action.operation !== 'combine') return [];
    const materialId = Number(event.diff.outputMaterialId);
    const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (!materialHas(materialId, 'solid') || !materialHas(materialId, 'building')
      || ![position?.x, position?.y, position?.z].every((value) => Number.isInteger(value))) return [];
    const x = Number(position?.x);
    const y = Number(position?.y);
    const z = Number(position?.z);
    return voxelAt(state.world.grid, x, y, z) === materialId ? [`${x}:${y}:${z}`] : [];
  }));
}

function classifyConnection(state: SimulationState, person: PersonState, position: ConnectionCandidate['position'], constructed: Set<string>): CandidateKind | null {
  if (voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Air || occupiedByBody(state, position)) return null;
  const targetCell = cellId(position.x, position.y);
  const below = voxelAt(state.world.grid, position.x, position.y, position.z - 1);
  const horizontalStructure = neighbors4(targetCell).some((neighbor) => constructed.has(`${cellX(neighbor)}:${cellY(neighbor)}:${position.z}`));
  if (targetCell === person.position.cellId && position.z === person.position.z + 2 && horizontalStructure) return 'overhead';
  if (constructed.has(`${position.x}:${position.y}:${position.z - 1}`)) return 'vertical';
  if (horizontalStructure) return 'lateral';
  if (below !== Material.Air && below !== Material.Water && below !== Material.Fire) return 'grounded';
  return null;
}

function connectionCandidates(state: SimulationState, person: PersonState): ConnectionCandidate[] {
  const cells = [person.position.cellId, ...neighbors4(person.position.cellId)];
  const candidates: ConnectionCandidate[] = [];
  const constructed = constructedStructurePositions(state);
  for (const targetCell of cells) {
    for (let z = Math.max(1, person.position.z - 1); z <= Math.min(state.world.grid.levels - 1, person.position.z + 2); z += 1) {
      const position = { x: cellX(targetCell), y: cellY(targetCell), z };
      const kind = classifyConnection(state, person, position, constructed);
      if (kind) candidates.push({ kind, position });
    }
  }
  const selected: ConnectionCandidate[] = [];
  for (const kind of KIND_ORDER) {
    selected.push(...candidates
      .filter((candidate) => candidate.kind === kind)
      .sort((a, b) => a.position.z - b.position.z || a.position.y - b.position.y || a.position.x - b.position.x)
      .slice(0, kind === 'grounded' ? 2 : 1));
  }
  return selected.slice(0, 5);
}

function connectionSummary(kind: CandidateKind, inputMaterialId: MaterialId): string {
  const material = materialDefinition(inputMaterialId).name;
  if (kind === 'vertical') return `把${material}连接到已有结构上方`;
  if (kind === 'lateral') return `从已有结构向侧面继续连接${material}`;
  if (kind === 'overhead') return `从邻近高处结构向头顶空气延伸${material}`;
  return `把${material}连接到身边有支撑的空气中`;
}

export function buildConstructionOptions(state: SimulationState, person: PersonState): ActionOption[] {
  const materials = person.inventory
    .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'solid') && materialHas(stack.materialId, 'building'))
    .sort((a, b) => b.quantity - a.quantity || a.materialId - b.materialId)
    .slice(0, 2);
  if (!materials.length) return [];
  const candidates = connectionCandidates(state, person);
  return materials.flatMap((stack) => {
    const outputMaterialId = stack.materialId === Material.Wood ? Material.Plank : stack.materialId;
    return candidates.map(({ kind, position }) => ({
      id: `build:${position.x}:${position.y}:${position.z}:${stack.id}`,
      summary: connectionSummary(kind, stack.materialId),
      reason: kind === 'grounded'
        ? '这种固体物质具有建造性质，目标空气下方有实体支撑且没有身体占据'
        : '这种固体物质具有建造性质，目标空气与人物已连接的结构相邻且没有身体占据',
      goal: { kind: 'voxel-is' as const, position, materialId: outputMaterialId },
      nextAction: {
        kind: 'act' as const, operation: 'combine' as const,
        targets: [{ kind: 'inventory-stack' as const, personId: person.id, stackId: stack.id }, { kind: 'voxel' as const, position }],
      },
      target: { kind: 'voxel' as const, position },
      estimatedDuration: 'one-month' as const,
      sourceFactIds: stack.sourceEventIds,
    }));
  });
}
