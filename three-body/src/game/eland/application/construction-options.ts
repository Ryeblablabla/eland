import type { ActionOption } from '../domain/action';
import { Material } from '../domain/material';
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

function classifyConnection(state: SimulationState, person: PersonState, position: ConnectionCandidate['position']): CandidateKind | null {
  if (voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Air || occupiedByBody(state, position)) return null;
  const targetCell = cellId(position.x, position.y);
  const below = voxelAt(state.world.grid, position.x, position.y, position.z - 1);
  const horizontalPlank = neighbors4(targetCell).some((neighbor) => voxelAt(state.world.grid, cellX(neighbor), cellY(neighbor), position.z) === Material.Plank);
  if (targetCell === person.position.cellId && position.z === person.position.z + 2 && horizontalPlank) return 'overhead';
  if (below === Material.Plank) return 'vertical';
  if (horizontalPlank) return 'lateral';
  if (below !== Material.Air && below !== Material.Water && below !== Material.Fire) return 'grounded';
  return null;
}

function connectionCandidates(state: SimulationState, person: PersonState): ConnectionCandidate[] {
  const cells = [person.position.cellId, ...neighbors4(person.position.cellId)];
  const candidates: ConnectionCandidate[] = [];
  for (const targetCell of cells) {
    for (let z = Math.max(1, person.position.z - 1); z <= Math.min(state.world.grid.levels - 1, person.position.z + 2); z += 1) {
      const position = { x: cellX(targetCell), y: cellY(targetCell), z };
      const kind = classifyConnection(state, person, position);
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

function connectionSummary(kind: CandidateKind): string {
  if (kind === 'vertical') return '把木材连接到已有木板上方';
  if (kind === 'lateral') return '从已有木板向侧面继续连接木材';
  if (kind === 'overhead') return '从邻近高处木板向头顶空气延伸木材';
  return '把木材连接到身边有支撑的空气中';
}

export function buildConstructionOptions(state: SimulationState, person: PersonState): ActionOption[] {
  const wood = person.inventory.find((stack) => stack.materialId === Material.Wood && stack.quantity > 0);
  if (!wood) return [];
  return connectionCandidates(state, person).map(({ kind, position }) => ({
    id: `build:${position.x}:${position.y}:${position.z}:${wood.id}`,
    summary: connectionSummary(kind),
    reason: kind === 'grounded'
      ? '目标空气下方有实体支撑，且没有身体占据'
      : '目标空气与已有木板相邻，且没有身体占据',
    goal: { kind: 'voxel-is', position, materialId: Material.Plank },
    nextAction: {
      kind: 'act', operation: 'combine',
      targets: [{ kind: 'inventory-stack', personId: person.id, stackId: wood.id }, { kind: 'voxel', position }],
    },
    target: { kind: 'voxel', position },
    estimatedDuration: 'one-month',
    sourceFactIds: wood.sourceEventIds,
  }));
}
