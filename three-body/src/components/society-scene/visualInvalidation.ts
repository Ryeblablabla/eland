import type { EraKey, SocietyState } from '@/game/societyContract';

type Primitive = string | number | boolean | null | undefined;

function cachedObjectPair<T extends object>(
  cache: WeakMap<T, WeakMap<T, boolean>>,
  left: T,
  right: T,
  compare: () => boolean,
): boolean {
  let comparisons = cache.get(left);
  if (!comparisons) {
    comparisons = new WeakMap<T, boolean>();
    cache.set(left, comparisons);
  }
  if (comparisons.has(right)) return comparisons.get(right)!;
  const result = compare();
  comparisons.set(right, result);
  return result;
}

const terrainWorldComparisonCache = new WeakMap<
  SocietyState['world'],
  WeakMap<SocietyState['world'], boolean>
>();
const terrainVisualComparisonCache = new WeakMap<SocietyState, WeakMap<SocietyState, boolean>>();
const activeDecorFacilityCache = new WeakMap<SocietyState, number[]>();

function samePrimitiveArray<T extends Primitive>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameArrayBy<T>(left: readonly T[], right: readonly T[], same: (a: T, b: T) => boolean): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (!same(left[index], right[index])) return false;
  }
  return true;
}

function samePalette(left: SocietyState['world']['palette'], right: SocietyState['world']['palette']): boolean {
  return sameArrayBy(left, right, (a, b) => a.id === b.id
    && a.key === b.key
    && samePrimitiveArray(a.color, b.color)
    && samePrimitiveArray(a.tags, b.tags));
}

/** Exact comparison of the facts consumed by terrainApi; activity/HUD data is intentionally absent. */
function sameTerrainWorld(left: SocietyState['world'], right: SocietyState['world']): boolean {
  if (left === right) return true;
  return cachedObjectPair(terrainWorldComparisonCache, left, right, () => left.width === right.width
    && left.height === right.height
    && left.levels === right.levels
    && left.generator.seed === right.generator.seed
    && left.generator.version === right.generator.version
    && samePalette(left.palette, right.palette)
    && samePrimitiveArray(left.surface, right.surface)
    && samePrimitiveArray(left.elevation, right.elevation)
    && sameArrayBy(left.columns, right.columns, samePrimitiveArray));
}

function sameTerrainStructures(left: SocietyState['structures'], right: SocietyState['structures']): boolean {
  return sameArrayBy(left, right, (a, b) => a.id === b.id
    && a.complete === b.complete
    && samePrimitiveArray(a.occupiedCells, b.occupiedCells)
    && sameArrayBy(a.interiorPositions, b.interiorPositions, (p, q) => p.cellId === q.cellId && p.z === q.z));
}

export function sameTerrainVisuals(left: SocietyState, right: SocietyState): boolean {
  if (left === right) return true;
  return cachedObjectPair(terrainVisualComparisonCache, left, right, () => sameTerrainWorld(left.world, right.world)
    && sameTerrainStructures(left.structures, right.structures));
}

export function sameSelectionVisuals(left: SocietyState, right: SocietyState): boolean {
  // Proxy bounds use exactly the same structure facts as terrain plus column
  // lengths/elevation, all of which are covered by this comparison.
  return sameTerrainVisuals(left, right);
}

function sameDecorStructures(left: SocietyState['structures'], right: SocietyState['structures']): boolean {
  return sameArrayBy(left, right, (a, b) => a.id === b.id
    && a.complete === b.complete
    && a.componentCount === b.componentCount
    && a.effects.weatherProtection === b.effects.weatherProtection
    && a.effects.thermalInsulation === b.effects.thermalInsulation
    && a.effects.capacity === b.effects.capacity
    && samePrimitiveArray(a.occupiedCells, b.occupiedCells)
    && samePrimitiveArray(a.interiorCells, b.interiorCells)
    && sameArrayBy(a.interiorPositions, b.interiorPositions, (p, q) => p.cellId === q.cellId && p.z === q.z)
    && samePrimitiveArray(a.materialIds, b.materialIds));
}

function sameTrailRegions(left: SocietyState['regions'], right: SocietyState['regions']): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  while (true) {
    while (leftIndex < left.length && left[leftIndex].kind !== 'trail') leftIndex++;
    while (rightIndex < right.length && right[rightIndex].kind !== 'trail') rightIndex++;
    const a = left[leftIndex];
    const b = right[rightIndex];
    if (!a || !b) return !a && !b;
    if (a.id !== b.id || !samePrimitiveArray(a.cells, b.cells)) return false;
    leftIndex++;
    rightIndex++;
  }
}

function sameDecorObservations(left: SocietyState['observations'], right: SocietyState['observations']): boolean {
  if (left === right) return true;
  if (left.civilizationIndex?.stage !== right.civilizationIndex?.stage) return false;
  if (!sameArrayBy(left.practices, right.practices, (a, b) => a.key === b.key && a.count === b.count)) return false;
  if (!sameArrayBy(left.institutions, right.institutions, (a, b) => a.key === b.key)) return false;
  return sameArrayBy(left.milestones, right.milestones, (a, b) => a.id === b.id);
}

const DECOR_FUNCTIONAL_MODEL_KEYS = new Set([
  'council_hearth', 'workshop', 'granary', 'cistern', 'kiln', 'mill',
  'civic_hall', 'foundry', 'smithy', 'keep_core',
  'water_wheel', 'drive_shaft', 'broken_drive_shaft', 'steel_drive_shaft',
  'mechanical_dynamo', 'copper_conductor', 'broken_copper_conductor', 'resistive_load',
]);

/**
 * collectDecor only consumes agent state to decide which authoritative
 * facilities are active. Comparing that projection (instead of whole agents)
 * lets ordinary walking update figures without rebuilding every decor batch.
 */
function activeDecorFacilityCells(society: SocietyState): number[] {
  const cached = activeDecorFacilityCache.get(society);
  if (cached) return cached;
  const { world } = society;
  const cellsByMaterial = new Map<number, number[]>();
  const functionalCells = new Set<number>();
  for (let cellId = 0; cellId < world.surface.length; cellId++) {
    const materialId = world.surface[cellId];
    if (!DECOR_FUNCTIONAL_MODEL_KEYS.has(world.palette[materialId]?.key ?? '')) continue;
    functionalCells.add(cellId);
    const cells = cellsByMaterial.get(materialId);
    if (cells) cells.push(cellId);
    else cellsByMaterial.set(materialId, [cellId]);
  }
  const result = new Set<number>();
  const distance = (left: number, right: number): number => Math.abs(left % world.width - right % world.width)
    + Math.abs(Math.floor(left / world.width) - Math.floor(right / world.width));
  for (const agent of society.agents) {
    const action = agent.visualAction;
    if (!action?.sourceEventId) continue;
    const anchor = action.targetCellId ?? action.sourceCellId ?? agent.cellId;
    if (functionalCells.has(anchor)) result.add(anchor);
    if (action.facilityMaterialId !== undefined) {
      let nearestCell: number | undefined;
      let nearestDistance = 3;
      for (const cellId of cellsByMaterial.get(action.facilityMaterialId) ?? []) {
        const candidateDistance = distance(anchor, cellId);
        if (candidateDistance > 2
          || candidateDistance > nearestDistance
          || (candidateDistance === nearestDistance && nearestCell !== undefined && cellId >= nearestCell)) continue;
        nearestCell = cellId;
        nearestDistance = candidateDistance;
      }
      if (nearestCell !== undefined) result.add(nearestCell);
    }
    if (action.mechanicalPowerOperation) {
      for (const cellId of action.linkedFacilityCellIds ?? []) {
        const key = world.palette[world.surface[cellId]]?.key;
        if (key === 'mill' || key === 'water_wheel' || key === 'drive_shaft' || key === 'steel_drive_shaft') result.add(cellId);
      }
    }
  }
  for (const network of society.electricalPower?.networks ?? []) {
    if (network.activity?.kind !== 'operation' || !network.activity.delivered) continue;
    for (const component of network.components) result.add(component.cellId);
  }
  const cells = [...result].sort((a, b) => a - b);
  activeDecorFacilityCache.set(society, cells);
  return cells;
}

export function sameDecorVisuals(left: SocietyState, leftEra: EraKey, right: SocietyState, rightEra: EraKey): boolean {
  if (leftEra !== rightEra
    || left.weather?.kind !== right.weather?.kind
    || !sameTerrainWorld(left.world, right.world)
    || !samePrimitiveArray(left.world.biomes, right.world.biomes)
    || !sameDecorStructures(left.structures, right.structures)
    || !sameArrayBy(left.electricalPower?.networks ?? [], right.electricalPower?.networks ?? [], (a, b) => a.id === b.id
      && sameArrayBy(a.planPath, b.planPath, (p, q) => p.cellId === q.cellId && p.z === q.z)
      && sameArrayBy(a.components, b.components, (p, q) => p.role === q.role
        && p.materialId === q.materialId && p.cellId === q.cellId && p.z === q.z)
      && a.fault?.cellId === b.fault?.cellId && a.fault?.z === b.fault?.z
      && a.fault?.atMonth === b.fault?.atMonth && a.fault?.sourceEventId === b.fault?.sourceEventId
      && a.activity?.kind === b.activity?.kind && a.activity?.sourceEventId === b.activity?.sourceEventId
      && a.activity?.delivered === b.activity?.delivered)
    || !sameTrailRegions(left.regions, right.regions)
    || !sameDecorObservations(left.observations, right.observations)) return false;
  if (!sameArrayBy(left.drops, right.drops, (a, b) => a.id === b.id
    && a.materialId === b.materialId && a.cellId === b.cellId && a.z === b.z && a.quantity === b.quantity)) return false;
  if (!sameArrayBy(left.containers, right.containers, (a, b) => a.id === b.id
    && a.materialId === b.materialId && a.cellId === b.cellId && a.z === b.z
    && a.capacity === b.capacity && a.usedCapacity === b.usedCapacity)) return false;
  if (!sameArrayBy(left.graves ?? [], right.graves ?? [], (a, b) => a.id === b.id
    && a.cellId === b.cellId && a.z === b.z && a.marked === b.marked
    && a.markerMaterialId === b.markerMaterialId)) return false;
  if (!sameArrayBy(left.animals, right.animals, (a, b) => a.id === b.id
    && a.speciesId === b.speciesId && a.sex === b.sex && a.ageBand === b.ageBand
    && a.cellId === b.cellId && a.z === b.z)) return false;
  return samePrimitiveArray(activeDecorFacilityCells(left), activeDecorFacilityCells(right));
}
