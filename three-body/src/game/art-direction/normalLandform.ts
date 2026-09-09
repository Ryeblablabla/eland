import { landscapeHash, riverbankRelief } from './riverbendLayout';

interface RiverRow {
  y: number;
  waterX: readonly number[];
}

interface NormalLandformOptions {
  seed: number;
  width: number;
  depth: number;
  course: readonly RiverRow[];
  spawnX: number;
  spawnY: number;
}

const smoothstep = (start: number, end: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
};

function rollingField(seed: number, x: number, y: number, scale: number): number {
  const ix = Math.floor(x / scale), iy = Math.floor(y / scale);
  const tx = smoothstep(0, 1, x / scale - ix), ty = smoothstep(0, 1, y / scale - iy);
  const north = landscapeHash(seed, ix, iy) * (1 - tx) + landscapeHash(seed, ix + 1, iy) * tx;
  const south = landscapeHash(seed, ix, iy + 1) * (1 - tx) + landscapeHash(seed, ix + 1, iy + 1) * tx;
  return north * (1 - ty) + south * ty;
}

/**
 * The normal world uses the study's river shelves on its own authoritative river.
 * Heights are standing levels: the original two water lanes remain exactly at 5
 * (water voxel z=4). Broad terraces leave room to live; the northern ridge reaches 9.
 */
export function normalLandform({ seed, width, depth, course, spawnX, spawnY }: NormalLandformOptions): {
  heights: Uint8Array;
  riverDistances: Uint16Array;
} {
  const count = width * depth;
  const heights = new Uint8Array(count);
  const riverDistances = new Uint16Array(count).fill(65535);
  const queue = new Int32Array(count);
  let read = 0, write = 0;
  for (const row of course) {
    for (const x of row.waterX) {
      const id = row.y * width + x;
      if (riverDistances[id] === 0) continue;
      riverDistances[id] = 0;
      queue[write++] = id;
    }
  }
  // Cardinal distance follows bends without creating jagged row-wise banks.
  while (read < write) {
    const id = queue[read++], x = id % width, y = Math.floor(id / width);
    const distance = riverDistances[id] + 1;
    for (const next of [x > 0 ? id - 1 : -1, x + 1 < width ? id + 1 : -1,
      y > 0 ? id - width : -1, y + 1 < depth ? id + width : -1]) {
      if (next < 0 || riverDistances[next] <= distance) continue;
      riverDistances[next] = distance;
      queue[write++] = next;
    }
  }
  const phase = landscapeHash(seed, 41, 7) * Math.PI * 2;
  for (let y = 0; y < depth; y++) {
    for (let x = 0; x < width; x++) {
      const id = y * width + x, riverDistance = riverDistances[id];
      const shelf = riverbankRelief(Math.max(0, riverDistance - 1), 5, 7, 0.24);
      const upland = smoothstep(5, 17, riverDistance);
      const rolling = (rollingField(seed + 971, x, y, 18) - 0.42) * 1.45;
      const crestY = depth * 0.19 + Math.sin(x * 0.085 + phase) * 3.5;
      const ridge = smoothstep(12, 1.5, Math.abs(y - crestY))
        * (1.5 + rollingField(seed + 131, x, y, 24) * 0.9);
      let height = shelf + (rolling + ridge) * upland;
      // An inhabited shelf has a flat center and a gradual edge, including the walk to water.
      const spawnDistance = Math.abs(x - spawnX) + Math.abs(y - spawnY);
      const clearingCeiling = 5 + Math.max(0, spawnDistance - 4) * 0.25;
      height = Math.min(height, clearingCeiling);
      heights[id] = Math.max(5, Math.min(9, Math.round(height)));
    }
  }
  // Separable distance transform caps every cardinal step to one layer. It only
  // trims an abrupt rise; river height and habitable shelves can never be raised.
  for (let y = 0; y < depth; y++) {
    for (let x = 1; x < width; x++) {
      const id = y * width + x;
      heights[id] = Math.min(heights[id], heights[id - 1] + 1);
    }
    for (let x = width - 2; x >= 0; x--) {
      const id = y * width + x;
      heights[id] = Math.min(heights[id], heights[id + 1] + 1);
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 1; y < depth; y++) {
      const id = y * width + x;
      heights[id] = Math.min(heights[id], heights[id - width] + 1);
    }
    for (let y = depth - 2; y >= 0; y--) {
      const id = y * width + x;
      heights[id] = Math.min(heights[id], heights[id + width] + 1);
    }
  }
  return { heights, riverDistances };
}
