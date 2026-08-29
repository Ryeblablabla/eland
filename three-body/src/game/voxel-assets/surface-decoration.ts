import type { SocietyState } from '../societyContract';
import { MICRO_PER_CELL } from './catalog';
import { MICRO, hash01, jit, type DecorInstance } from './decor-primitives';
export const FUNCTIONAL_MODEL_KEYS = new Set([
  'council_hearth', 'workshop', 'granary', 'cistern', 'kiln', 'mill',
  'civic_hall', 'foundry', 'smithy', 'keep_core',
  'water_wheel', 'drive_shaft', 'broken_drive_shaft',
  'steel_drive_shaft',
  'mechanical_dynamo', 'copper_conductor', 'broken_copper_conductor', 'resistive_load',
]);

const SURFACE_REPLACEMENT_DECOR = new Set([
  'shrub', 'berry_bush', 'crop_sprout', 'crop_mature', 'packed_soil', 'fire',
  ...FUNCTIONAL_MODEL_KEYS,
]);

/**
 * 真正堆在地面上方的特征物深度：地形柱渲染时应相应缩短。
 * 火堆、灌木、作物和压实路面在领域世界里是替换同层地表，不是额外的一层，
 * 因此不在这里扣高；施工构件则由 constructionCells 明确裁回地面。
 */
export function featureDepth(
  world: SocietyState['world'],
  cellId: number,
  constructionCells?: ReadonlySet<number>,
): number {
  const stack = world.columns[cellId];
  // UI 列只保留非空气材料。若顶层建筑材料与地面之间有空气，用 elevation 找回
  // 被压缩掉的高度；否则地形合批会把悬空屋顶填成一根实心“底座”。
  const missingLevels = Math.max(0, world.elevation[cellId] + 1 - stack.length);
  const top = world.palette[stack[0]];
  let modeledLayers = 0;
  while (modeledLayers < stack.length) {
    const material = world.palette[stack[modeledLayers]];
    if (!material?.key || !FUNCTIONAL_MODEL_KEYS.has(material.key)) break;
    modeledLayers += 1;
  }
  const modeledDepth = modeledLayers > 0 ? missingLevels + modeledLayers : 0;
  const overheadDepth = missingLevels > 0 && top?.tags.includes('solid') && top.tags.includes('building')
    ? missingLevels + 1
    : 0;
  let constructionDepth = 0;
  if (constructionCells?.has(cellId)) {
    let connectedBuildingLayers = 0;
    while (connectedBuildingLayers < stack.length - 1) {
      const material = world.palette[stack[connectedBuildingLayers]];
      if (!material?.tags.includes('solid') || !material.tags.includes('building')) break;
      connectedBuildingLayers += 1;
    }
    constructionDepth = connectedBuildingLayers > 0 ? missingLevels + connectedBuildingLayers : 0;
  }
  let depth = 0;
  while (depth < stack.length - 1) {
    const key = world.palette[stack[depth]]?.key;
    if (key === 'leaves') { depth += 2; continue; }        // 树叶下必有一格木
    break;
  }
  return Math.max(depth, overheadDepth, constructionDepth, modeledDepth);
}

function visibleGroundMaterialId(
  world: SocietyState['world'],
  cellId: number,
  constructionCells?: ReadonlySet<number>,
): number | undefined {
  const stack = world.columns[cellId];
  const key = world.palette[stack[0]]?.key;
  if (key && SURFACE_REPLACEMENT_DECOR.has(key)) return undefined;
  const depth = featureDepth(world, cellId, constructionCells);
  const materialId = stack[Math.min(depth, stack.length - 1)];
  const material = world.palette[materialId];
  return material && (material.tags.includes('ground') || material.key === 'grass') ? materialId : undefined;
}

/**
 * 装饰下方的可见地皮。灌木、作物和道路在模拟中会覆盖原地表，因此优先
 * 用邻格推断连续的草地/沙地/土地外观，而不是把下一层深土直接露出。
 */
export function featureUnderlayMaterialId(
  world: SocietyState['world'],
  cellId: number,
  constructionCells?: ReadonlySet<number>,
): number | undefined {
  const stack = world.columns[cellId];
  const key = world.palette[stack[0]]?.key;
  const feature = featureDepth(world, cellId, constructionCells);
  if (!key || !SURFACE_REPLACEMENT_DECOR.has(key)) {
    return feature > 0 ? visibleGroundMaterialId(world, cellId, constructionCells) : undefined;
  }

  if (FUNCTIONAL_MODEL_KEYS.has(key)) {
    // 功能设施是权威体素的具象替身。优先保留它正下方的真实地表/水面，
    // 尤其不能让架在河流上方的水轮把水面误画成邻近草地。
    const below = world.palette[stack[1]];
    if (below && (below.tags.includes('ground') || below.tags.includes('liquid') || below.key === 'grass')) return below.id;
  }

  const x0 = cellId % world.width;
  const y0 = Math.floor(cellId / world.width);
  const scores = new Map<number, number>();
  for (let radius = 1; radius <= 3; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const dx = radius - Math.abs(dy);
      for (const nx of dx === 0 ? [x0] : [x0 - dx, x0 + dx]) {
        const ny = y0 + dy;
        if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) continue;
        const candidate = visibleGroundMaterialId(world, ny * world.width + nx, constructionCells);
        if (candidate === undefined) continue;
        scores.set(candidate, (scores.get(candidate) ?? 0) + 1 / radius);
      }
    }
  }
  let inferred: number | undefined;
  let bestScore = -1;
  for (const [materialId, score] of scores) {
    if (score > bestScore) {
      inferred = materialId;
      bestScore = score;
    }
  }
  return inferred ?? stack[Math.min(1, stack.length - 1)];
}

export interface DirtPathDirection {
  dx: -1 | 0 | 1;
  dz: -1 | 0 | 1;
}

const DIRT_PATH_DIRECTIONS: readonly DirtPathDirection[] = [
  { dx: 0, dz: -1 },
  { dx: 1, dz: -1 },
  { dx: 1, dz: 0 },
  { dx: 1, dz: 1 },
  { dx: 0, dz: 1 },
  { dx: -1, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: -1, dz: -1 },
];

/**
 * 从权威道路格推导该格的视觉连接。
 *
 * 对角格只有在两侧正交格都不是道路时才单独连接；阶梯状道路交给正交拐角平滑，避免同一
 * 个弯道又画直角、又叠一条对角捷径。高度差超过一层的相邻格也不会在表现层凭空连起来。
 */
export function dirtPathConnections(
  trailCells: ReadonlySet<number>,
  width: number,
  height: number,
  elevation: ArrayLike<number>,
  id: number,
): DirtPathDirection[] {
  if (id < 0 || id >= width * height || !trailCells.has(id)) return [];
  const x = id % width;
  const z = Math.floor(id / width);
  const baseElevation = elevation[id];
  const connected: DirtPathDirection[] = [];
  for (const direction of DIRT_PATH_DIRECTIONS) {
    const nx = x + direction.dx;
    const nz = z + direction.dz;
    if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
    const neighborId = nz * width + nx;
    if (!trailCells.has(neighborId) || Math.abs(elevation[neighborId] - baseElevation) > 1) continue;
    if (direction.dx !== 0 && direction.dz !== 0) {
      const besideX = z * width + nx;
      const besideZ = nz * width + x;
      if (trailCells.has(besideX) || trailCells.has(besideZ)) continue;
    }
    connected.push(direction);
  }
  return connected;
}

/**
 * 找出一个夯土格可以安全填满的内侧角。
 *
 * 只有同一高度的 2×2 权威 PackedSoil 格才会合并共享角：这会消除四段窄路围出的规则草洞，
 * 但不会跨进仍然属于草地、农田或庭院的真实中心格，也不会把坡面抹成悬空土块。
 */
export function dirtPathFilledCorners(
  packedSoilCells: ReadonlySet<number>,
  width: number,
  height: number,
  elevation: ArrayLike<number>,
  id: number,
): DirtPathDirection[] {
  if (id < 0 || id >= width * height || !packedSoilCells.has(id)) return [];
  const x = id % width;
  const z = Math.floor(id / width);
  const baseElevation = elevation[id];
  const filled: DirtPathDirection[] = [];

  for (const direction of DIRT_PATH_DIRECTIONS) {
    if (direction.dx === 0 || direction.dz === 0) continue;
    const nx = x + direction.dx;
    const nz = z + direction.dz;
    if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
    const besideX = z * width + nx;
    const besideZ = nz * width + x;
    const diagonal = nz * width + nx;
    const block = [id, besideX, besideZ, diagonal];
    if (block.every((cellId) => packedSoilCells.has(cellId) && elevation[cellId] === baseElevation)) {
      filled.push(direction);
    }
  }

  return filled;
}

interface DirtPathPoint { x: number; z: number }

function distanceToDirtPathSegment(point: DirtPathPoint, from: DirtPathPoint, to: DirtPathPoint): number {
  const lineX = to.x - from.x;
  const lineZ = to.z - from.z;
  const lengthSquared = lineX * lineX + lineZ * lineZ;
  if (lengthSquared < 0.000001) return Math.hypot(point.x - from.x, point.z - from.z);
  const t = Math.max(0, Math.min(1,
    ((point.x - from.x) * lineX + (point.z - from.z) * lineZ) / lengthSquared,
  ));
  return Math.hypot(point.x - (from.x + lineX * t), point.z - (from.z + lineZ * t));
}

function pathCenterGeometry(
  connections: readonly DirtPathDirection[],
  r: number,
): { centerLines: DirtPathPoint[][]; junction: boolean } {
  const edge = (direction: DirtPathDirection): DirtPathPoint => ({
    x: direction.dx * 0.53,
    z: direction.dz * 0.53,
  });
  const centerLines: DirtPathPoint[][] = [];
  let junction = false;

  if (connections.length === 0) {
    const direction = DIRT_PATH_DIRECTIONS[Math.floor(r * 4) * 2];
    centerLines.push([
      { x: direction.dx * -0.27, z: direction.dz * -0.27 },
      { x: direction.dx * 0.27, z: direction.dz * 0.27 },
    ]);
  } else if (connections.length === 1) {
    const direction = connections[0];
    centerLines.push([
      { x: direction.dx * -0.16, z: direction.dz * -0.16 },
      edge(direction),
    ]);
  } else if (connections.length === 2) {
    const [a, b] = connections;
    const opposite = a.dx === -b.dx && a.dz === -b.dz;
    if (opposite) centerLines.push([edge(a), edge(b)]);
    else {
      const start = edge(a);
      const end = edge(b);
      const curve: DirtPathPoint[] = [];
      for (let step = 0; step <= 8; step++) {
        const t = step / 8;
        const oneMinusT = 1 - t;
        curve.push({
          x: oneMinusT * oneMinusT * start.x + t * t * end.x,
          z: oneMinusT * oneMinusT * start.z + t * t * end.z,
        });
      }
      centerLines.push(curve);
    }
  } else {
    junction = true;
    connections.forEach((direction) => centerLines.push([{ x: 0, z: 0 }, edge(direction)]));
  }

  return { centerLines, junction };
}

/**
 * 向一个道路格追加 8×8 微体素夯土带。
 *
 * 素材库和生产场景都以“一地图格八微体素”为基准：方向决定格内中心线，微体素只负责
 * 把中心线栅格化为连续泥面。这样斜路仍保留体素阶梯感，不再出现旋转薄片的接缝和板材感。
 */
export function appendDirtPathCell(
  out: DecorInstance[], centerX: number, groundY: number, centerZ: number,
  connections: readonly DirtPathDirection[], r: number,
  filledCorners: readonly DirtPathDirection[] = [],
): void {
  const seed = Math.floor(r * 0x7fffffff);
  const { centerLines, junction } = pathCenterGeometry(connections, r);

  const roadMicros: DirtPathPoint[] = [];
  for (let microZ = 0; microZ < MICRO_PER_CELL; microZ++) {
    for (let microX = 0; microX < MICRO_PER_CELL; microX++) {
      const local: DirtPathPoint = {
        x: (microX + 0.5) * MICRO - 0.5,
        z: (microZ + 0.5) * MICRO - 0.5,
      };
      let distance = Number.POSITIVE_INFINITY;
      for (const line of centerLines) {
        for (let pointIndex = 1; pointIndex < line.length; pointIndex++) {
          distance = Math.min(distance, distanceToDirtPathSegment(local, line[pointIndex - 1], line[pointIndex]));
        }
      }
      const microId = microZ * MICRO_PER_CELL + microX;
      const edgeNoise = (hash01(seed ^ microId, 121) - 0.5) * 0.07;
      const insideRibbon = distance <= 0.215 + edgeNoise;
      const insideJunction = junction
        && Math.hypot(local.x, local.z) <= 0.29 + edgeNoise;
      const insideFilledCorner = filledCorners.some((corner) =>
        corner.dx !== 0 && corner.dz !== 0
        && local.x * corner.dx > 0.25 && local.z * corner.dz > 0.25);
      if (!insideRibbon && !insideJunction && !insideFilledCorner) continue;
      roadMicros.push(local);
      const tone = 0.39 + hash01(seed ^ microId, 122) * 0.22;
      const scuffed = hash01(seed ^ microId, 123) > 0.93;
      out.push({
        b: 'groundMark',
        x: centerX + local.x,
        y: groundY + 0.002,
        z: centerZ + local.z,
        sx: MICRO + 0.002,
        sy: 0.004,
        sz: MICRO + 0.002,
        c: scuffed ? jit(0x705439, tone) : jit(0x806143, tone),
        visualLayer: 'settlement-era',
      });
    }
  }

  // 从真实生成的泥面微体素中选落点，避免碎石落在草地；只提供轮廓，不形成可通行高度。
  const pebbleRoll = hash01(seed, 124);
  const pebbleCount = pebbleRoll > 0.62 ? 1 + (pebbleRoll > 0.9 ? 1 : 0) : 0;
  for (let pebble = 0; pebble < pebbleCount && roadMicros.length > 0; pebble++) {
    const local = roadMicros[Math.floor(hash01(seed + pebble, 125) * roadMicros.length)];
    const sx = 0.06 + hash01(seed + pebble, 126) * 0.035;
    const sy = 0.026 + hash01(seed + pebble, 127) * 0.018;
    const sz = 0.055 + hash01(seed + pebble, 128) * 0.035;
    out.push({
      b: 'stone',
      x: centerX + local.x + (hash01(seed + pebble, 129) - 0.5) * 0.025,
      y: groundY + 0.004 + sy * 0.5,
      z: centerZ + local.z + (hash01(seed + pebble, 130) - 0.5) * 0.025,
      sx, sy, sz,
      c: jit(0x8d8980, 0.35 + hash01(seed + pebble, 131) * 0.3),
      visualLayer: 'settlement-era',
    });
  }
}

type PavedPathStyle = 'agrarian-stone' | 'ancient-brick' | 'medieval-cobble';

interface PavedPathProfile {
  width: number;
  junctionRadius: number;
  edgeThreshold: number;
  center: number;
  alternate: number;
  curb: number;
  moss: number;
  mossChance: number;
  inset: number;
  height: number;
}

const PAVED_PATH_PROFILE: Record<PavedPathStyle, PavedPathProfile> = {
  'agrarian-stone': {
    width: 0.305, junctionRadius: 0.36, edgeThreshold: 0.225,
    center: 0x978f82, alternate: 0xa49b8d, curb: 0x7c756b, moss: 0x657052,
    mossChance: 0.045, inset: 0.006, height: 0.014,
  },
  'ancient-brick': {
    width: 0.34, junctionRadius: 0.39, edgeThreshold: 0.27,
    center: 0xa9825d, alternate: 0xbd9569, curb: 0x796756, moss: 0x6f795d,
    mossChance: 0.035, inset: 0.011, height: 0.027,
  },
  'medieval-cobble': {
    width: 0.325, junctionRadius: 0.38, edgeThreshold: 0.25,
    center: 0x85817a, alternate: 0x6f6c66, curb: 0x5f5d58, moss: 0x63705b,
    mossChance: 0.085, inset: 0.017, height: 0.034,
  },
};

interface PavedPathMicroCell {
  microX: number;
  microZ: number;
  local: DirtPathPoint;
  distance: number;
  insideFilledCorner: boolean;
  insideJunction: boolean;
  tangentX: number;
  tangentZ: number;
}

/**
 * 农耕石板使用顺着道路方向铺设的短条旗石，而不是每个微体素各画一块方砖。
 * 石板压进夯土表层，窄缝直接露出下方真实路面；苔痕只沿少量石缝生长，不替换整块石板。
 */
function appendAgrarianFlagstones(
  out: DecorInstance[], centerX: number, groundY: number, centerZ: number,
  cells: readonly (PavedPathMicroCell | undefined)[], seed: number, profile: PavedPathProfile,
): void {
  const claimed = new Set<number>();

  for (let microZ = 0; microZ < MICRO_PER_CELL; microZ++) {
    for (let microX = 0; microX < MICRO_PER_CELL; microX++) {
      const microId = microZ * MICRO_PER_CELL + microX;
      const cell = cells[microId];
      if (!cell || claimed.has(microId)) continue;

      const horizontal = Math.abs(cell.tangentX) > Math.abs(cell.tangentZ)
        || (Math.abs(cell.tangentX) === Math.abs(cell.tangentZ) && hash01(seed ^ microId, 229) > 0.5);
      const curb = !cell.insideFilledCorner && !cell.insideJunction && cell.distance > profile.edgeThreshold;
      const lengthRoll = hash01(seed ^ microId, 230);
      const desiredLength = lengthRoll > 0.88 ? 3 : lengthRoll > 0.16 ? 2 : 1;
      const members = [cell];
      claimed.add(microId);

      for (let step = 1; step < desiredLength; step++) {
        const nextX = microX + (horizontal ? step : 0);
        const nextZ = microZ + (horizontal ? 0 : step);
        if (nextX >= MICRO_PER_CELL || nextZ >= MICRO_PER_CELL) break;
        const nextId = nextZ * MICRO_PER_CELL + nextX;
        const next = cells[nextId];
        if (!next || claimed.has(nextId)) break;
        const nextHorizontal = Math.abs(next.tangentX) > Math.abs(next.tangentZ)
          || (Math.abs(next.tangentX) === Math.abs(next.tangentZ) && horizontal);
        const nextCurb = !next.insideFilledCorner && !next.insideJunction && next.distance > profile.edgeThreshold;
        if (nextHorizontal !== horizontal || nextCurb !== curb) break;
        members.push(next);
        claimed.add(nextId);
      }

      if (hash01(seed ^ microId, 238) > 0.76) {
        const crossMembers: PavedPathMicroCell[] = [];
        for (const member of members) {
          const nextX = member.microX + (horizontal ? 0 : 1);
          const nextZ = member.microZ + (horizontal ? 1 : 0);
          if (nextX >= MICRO_PER_CELL || nextZ >= MICRO_PER_CELL) {
            crossMembers.length = 0;
            break;
          }
          const nextId = nextZ * MICRO_PER_CELL + nextX;
          const next = cells[nextId];
          if (!next || claimed.has(nextId)) {
            crossMembers.length = 0;
            break;
          }
          const nextHorizontal = Math.abs(next.tangentX) > Math.abs(next.tangentZ)
            || (Math.abs(next.tangentX) === Math.abs(next.tangentZ) && horizontal);
          const nextCurb = !next.insideFilledCorner && !next.insideJunction
            && next.distance > profile.edgeThreshold;
          if (nextHorizontal !== horizontal || nextCurb !== curb) {
            crossMembers.length = 0;
            break;
          }
          crossMembers.push(next);
        }
        for (const next of crossMembers) {
          members.push(next);
          claimed.add(next.microZ * MICRO_PER_CELL + next.microX);
        }
      }

      const minX = Math.min(...members.map((member) => member.local.x));
      const maxX = Math.max(...members.map((member) => member.local.x));
      const minZ = Math.min(...members.map((member) => member.local.z));
      const maxZ = Math.max(...members.map((member) => member.local.z));
      const slabCenterX = (minX + maxX) / 2;
      const slabCenterZ = (minZ + maxZ) / 2;
      const slabWidthX = maxX - minX + MICRO;
      const slabWidthZ = maxZ - minZ + MICRO;
      const tileSeed = seed ^ microId ^ members.length * 0x45d9f3b;
      const slabHeight = profile.height + hash01(tileSeed, 231) * 0.006;
      const baseColor = curb
        ? profile.curb
        : hash01(tileSeed, 232) > 0.53 ? profile.alternate : profile.center;
      const jitterAcross = (hash01(tileSeed, 233) - 0.5) * 0.005;
      const x = centerX + slabCenterX + (horizontal ? 0 : jitterAcross);
      const z = centerZ + slabCenterZ + (horizontal ? jitterAcross : 0);
      const sx = slabWidthX - profile.inset * (horizontal ? 0.8 : 1.15);
      const sz = slabWidthZ - profile.inset * (horizontal ? 1.15 : 0.8);

      out.push({
        b: 'stone',
        x,
        y: groundY + 0.001 + slabHeight / 2,
        z,
        sx,
        sy: slabHeight,
        sz,
        c: jit(baseColor, 0.4 + hash01(tileSeed, 234) * 0.24),
        visualLayer: 'settlement-era',
      });

      if (!curb && hash01(tileSeed, 235) > 1 - profile.mossChance) {
        const seamSign = hash01(tileSeed, 236) > 0.5 ? 1 : -1;
        out.push({
          b: 'groundMark',
          x: x + (horizontal ? seamSign * (sx / 2 - 0.008) : 0),
          y: groundY + 0.002 + slabHeight,
          z: z + (horizontal ? 0 : seamSign * (sz / 2 - 0.008)),
          sx: horizontal ? 0.016 : Math.max(MICRO * 0.42, sx * 0.56),
          sy: 0.002,
          sz: horizontal ? Math.max(MICRO * 0.42, sz * 0.56) : 0.016,
          c: jit(profile.moss, 0.42 + hash01(tileSeed, 237) * 0.18),
          visualLayer: 'settlement-era',
        });
      }
    }
  }
}

/** 铺装道路的共用八向蒙版；各阶段在同一真实路网轮廓中安排自己的铺装构型。 */
function appendPavedPathCell(
  out: DecorInstance[], centerX: number, groundY: number, centerZ: number,
  connections: readonly DirtPathDirection[], r: number,
  filledCorners: readonly DirtPathDirection[], style: PavedPathStyle,
): void {
  const seed = Math.floor(r * 0x7fffffff);
  const { centerLines, junction } = pathCenterGeometry(connections, r);
  const profile = PAVED_PATH_PROFILE[style];
  const cells: Array<PavedPathMicroCell | undefined> = new Array(MICRO_PER_CELL * MICRO_PER_CELL);
  for (let microZ = 0; microZ < MICRO_PER_CELL; microZ++) {
    for (let microX = 0; microX < MICRO_PER_CELL; microX++) {
      const local: DirtPathPoint = {
        x: (microX + 0.5) * MICRO - 0.5,
        z: (microZ + 0.5) * MICRO - 0.5,
      };
      let distance = Number.POSITIVE_INFINITY;
      let tangentX = 1;
      let tangentZ = 0;
      for (const line of centerLines) {
        for (let pointIndex = 1; pointIndex < line.length; pointIndex++) {
          const segmentDistance = distanceToDirtPathSegment(local, line[pointIndex - 1], line[pointIndex]);
          if (segmentDistance < distance) {
            distance = segmentDistance;
            tangentX = line[pointIndex].x - line[pointIndex - 1].x;
            tangentZ = line[pointIndex].z - line[pointIndex - 1].z;
          }
        }
      }
      const microId = microZ * MICRO_PER_CELL + microX;
      const edgeNoise = (hash01(seed ^ microId, 221) - 0.5) * 0.025;
      const insideRibbon = distance <= profile.width + edgeNoise;
      const insideJunction = junction && Math.hypot(local.x, local.z) <= profile.junctionRadius + edgeNoise;
      const insideFilledCorner = filledCorners.some((corner) =>
        corner.dx !== 0 && corner.dz !== 0
        && local.x * corner.dx > 0.18 && local.z * corner.dz > 0.18);
      if (!insideRibbon && !insideJunction && !insideFilledCorner) continue;

      cells[microId] = {
        microX, microZ, local, distance, insideFilledCorner, insideJunction, tangentX, tangentZ,
      };
    }
  }

  if (style === 'agrarian-stone') {
    appendAgrarianFlagstones(out, centerX, groundY, centerZ, cells, seed, profile);
    return;
  }

  for (const cell of cells) {
    if (!cell) continue;
    const { microX, microZ, local, distance, insideFilledCorner, insideJunction } = cell;
    const microId = microZ * MICRO_PER_CELL + microX;
    const moss = hash01(seed ^ microId, 222) > 1 - profile.mossChance;
    const curb = !insideFilledCorner && !insideJunction && distance > profile.edgeThreshold;
    const alternating = style === 'ancient-brick'
      ? (microX + Math.floor(microZ / 2)) % 2 === 0
      : hash01(seed ^ microId, 226) > 0.55;
    const baseColor = moss ? profile.moss : curb ? profile.curb : alternating ? profile.alternate : profile.center;
    const slabInset = profile.inset + hash01(seed ^ microId, 223) * (style === 'medieval-cobble' ? 0.009 : 0.004);
    const slabHeight = profile.height + hash01(seed ^ microId, 224) * (style === 'medieval-cobble' ? 0.014 : 0.007);
    const jitterX = style === 'medieval-cobble' ? (hash01(seed ^ microId, 227) - 0.5) * 0.014 : 0;
    const jitterZ = style === 'medieval-cobble' ? (hash01(seed ^ microId, 228) - 0.5) * 0.014 : 0;
    out.push({
      b: moss ? 'groundMark' : 'stone',
      x: centerX + local.x + jitterX,
      y: groundY + 0.003 + slabHeight / 2,
      z: centerZ + local.z + jitterZ,
      sx: MICRO - slabInset * (style === 'ancient-brick' ? 0.65 : 1),
      sy: slabHeight,
      sz: MICRO - slabInset * (style === 'ancient-brick' ? 1.35 : 1),
      c: jit(baseColor, 0.36 + hash01(seed ^ microId, 225) * 0.3),
      visualLayer: 'settlement-era',
    });
  }
}

/** 农耕定居的切石板路。 */
export function appendStonePathCell(
  out: DecorInstance[], centerX: number, groundY: number, centerZ: number,
  connections: readonly DirtPathDirection[], r: number,
  filledCorners: readonly DirtPathDirection[] = [],
): void {
  appendPavedPathCell(out, centerX, groundY, centerZ, connections, r, filledCorners, 'agrarian-stone');
}

/** 古代文明的青灰砖石大道。 */
export function appendAncientPathCell(
  out: DecorInstance[], centerX: number, groundY: number, centerZ: number,
  connections: readonly DirtPathDirection[], r: number,
  filledCorners: readonly DirtPathDirection[] = [],
): void {
  appendPavedPathCell(out, centerX, groundY, centerZ, connections, r, filledCorners, 'ancient-brick');
}

/** 西方中世纪风的高低错落鹅卵石路原型。 */
export function appendMedievalPathCell(
  out: DecorInstance[], centerX: number, groundY: number, centerZ: number,
  connections: readonly DirtPathDirection[], r: number,
  filledCorners: readonly DirtPathDirection[] = [],
): void {
  appendPavedPathCell(out, centerX, groundY, centerZ, connections, r, filledCorners, 'medieval-cobble');
}
