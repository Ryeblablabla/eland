import type { AnimalView } from '@/game/societyContract';

export interface AnimalMotion {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  moving: boolean;
}

/** Follow the committed route, preserving turns and stepping over voxel risers. */
export function sampleAnimalMotion(animal: AnimalView, width: number, progress: number): AnimalMotion {
  const t = Math.max(0, Math.min(1, progress));
  const trace = animal.movementPath;
  const first = trace?.[0], last = trace?.[trace.length - 1];
  const validTrace = first?.cellId === animal.previousCellId && first.z === animal.previousZ
    && last?.cellId === animal.cellId && last.z === animal.z;
  const path = validTrace && trace!.length > 1 ? trace! : null;
  const offset = t * (path ? path.length - 1 : 1);
  const index = path ? Math.min(path.length - 2, Math.floor(offset)) : 0;
  const local = path ? offset - index : t;
  const from = path?.[index] ?? { cellId: animal.previousCellId, z: animal.previousZ };
  const to = path?.[index + 1] ?? { cellId: animal.cellId, z: animal.z };
  const fromX = from.cellId % width, fromZ = Math.floor(from.cellId / width);
  const dx = to.cellId % width - fromX, dz = Math.floor(to.cellId / width) - fromZ;
  const distance = Math.hypot(dx, dz);
  let heightT = local;
  if (distance > 0 && distance <= Math.SQRT2 && from.z !== to.z) {
    // Finish lifting before the leading foot crosses the cell boundary; lower after the
    // trailing foot clears it. Endpoints remain exact, including at the end of a month.
    const up = to.z > from.z;
    const start = up ? 0.1 : 0.7, end = up ? 0.3 : 0.9;
    const u = Math.max(0, Math.min(1, (local - start) / (end - start)));
    heightT = u * u * (3 - 2 * u);
  }
  return {
    x: fromX + dx * local,
    y: from.z + (to.z - from.z) * heightT,
    z: fromZ + dz * local,
    dx, dz,
    moving: distance > 0 || from.z !== to.z,
  };
}
