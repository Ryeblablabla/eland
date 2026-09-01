/**
 * 微缩体素素材库 → 游戏世界装饰层。
 *
 * 约定：1 地图格 = 8 微体素（MICRO = 0.125 世界单位）。素材以 kit 形式生成格内局部坐标，
 * 旧素材通过 2×2×2 微体素 cuboid 保持原有 1/4 格的轮廓；小物件可按 1/8 格精度表达。
 * collectDecor 依据权威 SocietyState（表面材质 / 区域 / 掉落物 / 建筑 / 动物 / 纪元）
 * 把套件放置到世界坐标，供 SocietyScene3D 按材质桶做 InstancedMesh 合批。
 * 纯数据模块，不依赖 three.js。
 */
import type { EraKey, SocietyState } from './societyContract';
import type { PixelWorldView } from './societyContract';
import { biomeAt, treeSpeciesAt, type BiomeKey, type TreeSpeciesKey } from './eland/world/biome';
import {
  WORLD_CELL_HEIGHT,
  resolveVoxelAssetParts,
  type VoxelAssetContext,
  type VoxelAssetKey,
} from './voxel-assets/catalog';
import {
  MICRO,
  hash01,
  jit,
  weatherSwayStrength,
  type DecorBucket,
  type DecorInstance,
} from './voxel-assets/decor-primitives';
import {
  FUNCTIONAL_MODEL_KEYS,
  appendAncientPathCell,
  appendDirtPathCell,
  appendStonePathCell,
  dirtPathConnections,
  dirtPathFilledCorners,
  featureDepth,
} from './voxel-assets/surface-decoration';

export { MICRO_PER_CELL, WORLD_CELL_HEIGHT } from './voxel-assets/catalog';
export { DECOR_BUCKETS, MICRO } from './voxel-assets/decor-primitives';
export type { DecorBucket, DecorInstance } from './voxel-assets/decor-primitives';
export {
  appendAncientPathCell,
  appendDirtPathCell,
  appendMedievalPathCell,
  appendStonePathCell,
  dirtPathConnections,
  dirtPathFilledCorners,
  featureDepth,
  featureUnderlayMaterialId,
} from './voxel-assets/surface-decoration';
export type { DirtPathDirection } from './voxel-assets/surface-decoration';
const LEGACY_VOXEL_MICROS = 2;
const CELL_H = WORLD_CELL_HEIGHT;

/** 动态实体外观使用自身 ID，而不是当前位置，避免移动后毛色跳变。 */
function hashText01(value: string, salt = 0): number {
  let hash = (0x811c9dc5 ^ Math.imul(salt + 1, 0x01000193)) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  return (hash >>> 0) / 0x100000000;
}

/** 套件构建器：ox/oy/oz 为世界落点（地面顶面），k 为整体缩放，rot 为 90° 步进朝向 */
class Kit {
  readonly out: DecorInstance[];
  readonly ox: number; readonly oy: number; readonly oz: number;
  readonly k: number; readonly rot: number;
  readonly entityId: string | undefined;
  constructor(out: DecorInstance[], ox: number, oy: number, oz: number, k = 1, rot = 0, entityId?: string) {
    this.out = out;
    this.ox = ox; this.oy = oy; this.oz = oz;
    this.k = k; this.rot = rot;
    this.entityId = entityId;
  }
  /**
   * 8×8 微体素 cuboid。mx/mz 是水平中心坐标，my 是底部坐标，尺寸以 1/8 格计。
   * 90°/270° 旋转时一并交换 x/z 尺寸，因此可安全使用非等边小构件。
   */
  m(
    b: DecorBucket,
    mx: number,
    my: number,
    mz: number,
    sx: number,
    sy: number,
    sz: number,
    c: number,
    part?: string,
    animation?: DecorInstance['animation'],
  ): void {
    let rx = mx, rz = mz;
    let rsx = sx, rsz = sz;
    if (this.rot === 1) { rx = mz; rz = -mx; }
    else if (this.rot === 2) { rx = -mx; rz = -mz; }
    else if (this.rot === 3) { rx = -mz; rz = mx; }
    if (this.rot === 1 || this.rot === 3) { rsx = sz; rsz = sx; }
    const s = MICRO * this.k;
    const instance: DecorInstance = {
      b,
      x: this.ox + rx * s,
      y: this.oy + (my + sy / 2) * s,
      z: this.oz + rz * s,
      sx: rsx * s,
      sy: sy * s,
      sz: rsz * s,
      c,
    };
    if (part) instance.part = part;
    if (animation) instance.animation = animation;
    if (this.entityId) {
      instance.entityId = this.entityId;
      instance.entityX = this.ox;
      instance.entityY = this.oy;
      instance.entityZ = this.oz;
      instance.entityRotation = this.rot;
    }
    this.out.push(instance);
  }

  /** 旧 1/4 格单元的兼容入口；世界尺寸与升级前一致。 */
  v(b: DecorBucket, x: number, y: number, z: number, c: number, part?: string, animation?: DecorInstance['animation']): void {
    this.m(
      b,
      x * LEGACY_VOXEL_MICROS,
      y * LEGACY_VOXEL_MICROS,
      z * LEGACY_VOXEL_MICROS,
      LEGACY_VOXEL_MICROS,
      LEGACY_VOXEL_MICROS,
      LEGACY_VOXEL_MICROS,
      c,
      part,
      animation,
    );
  }
}

type KitBuilder = (k: Kit, r: number) => void;

/* ------------------------------------------------------------------ */
/* 树木（v 使用兼容的 1/4 格步进，m 使用 1/8 格微体素；0 = 地面）       */
/* ------------------------------------------------------------------ */

function kitOak(k: Kit, r: number): void {
  for (let y = 0; y <= 2; y++) k.v('wood', 0, y, 0, jit(0x6e4f33, r));
  for (let y = 2; y <= 5; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const d = Math.sqrt(x * x + (y - 3.6) * (y - 3.6) * 1.7 + z * z);
    if (d > 2.4 || hash01(x * 31 + y * 7 + z * 13, 5) < 0.15) continue;
    k.v('leaf', x, y, z, jit(0x3f8f3a, hash01(x + z * 9 + y, 1)));
  }
}

function kitSpruce(k: Kit, r: number): void {
  k.v('wood', 0, 0, 0, jit(0x5f422a, r));
  for (let y = 1; y <= 6; y++) {
    const rr = 2.6 - (y - 1) * 0.42;
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
      if (Math.hypot(x, z) > rr + 0.2) continue;
      k.v('leaf', x, y, z, jit(0x2a5a32, hash01(x * 7 + z * 3 + y, 2)));
    }
  }
  k.v('leaf', 0, 7, 0, 0x2a5a32);
}

function kitSnowSpruce(k: Kit, r: number): void {
  k.v('wood', 0, 0, 0, jit(0x5f422a, r));
  for (let y = 1; y <= 6; y++) {
    const rr = 2.6 - (y - 1) * 0.42;
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
      const d = Math.hypot(x, z);
      if (d > rr + 0.2) continue;
      if (d > rr - 0.8) k.v('plaster', x, y, z, jit(0xeef2f6, hash01(x + z, 3))); // 叶缘挂雪
      else k.v('leaf', x, y, z, jit(0x2a4a34, hash01(x * 7 + z * 3 + y, 2)));
    }
  }
  k.v('plaster', 0, 7, 0, 0xeef2f6);
}

function kitBirch(k: Kit, r: number): void {
  for (let y = 0; y <= 3; y++)
    k.v('plaster', 0, y, 0, hash01(y, 8) < 0.2 ? 0x2c2420 : jit(0xe8e4da, r));
  for (let y = 4; y <= 6; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const d = Math.sqrt(x * x + (y - 5) * (y - 5) * 1.5 + z * z);
    if (d > 1.8 || hash01(x * 11 + z * 5 + y, 6) < 0.35) continue;
    k.v('leaf', x, y, z, jit(0x7fb069, hash01(x + y + z, 4)));
  }
}

function kitSakura(k: Kit, r: number): void {
  for (let y = 0; y <= 2; y++) k.v('wood', 0, y, 0, jit(0x5f422a, r));
  for (let y = 2; y <= 5; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const d = Math.sqrt(x * x + (y - 3.6) * (y - 3.6) * 1.6 + z * z);
    if (d > 2.3 || hash01(x * 13 + y * 3 + z * 7, 7) < 0.12) continue;
    k.v('leaf', x, y, z, jit(0xf0a8c0, hash01(x + z * 3 + y, 9)));
  }
  for (let i = 0; i < 4; i++) // 落英
    k.v('leaf', Math.round((r - 0.5) * 4) + i - 2, 0, Math.round((hash01(i, 11) - 0.5) * 4), 0xf0b8cc);
}

function kitPalm(k: Kit, r: number): void {
  for (let y = 0; y <= 3; y++) k.v('wood', y >= 2 ? 1 : 0, y, 0, jit(0xb0925a, r));
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    k.v('leaf', 1 + dx, 4, dz, jit(0x3f9a4a, r));
    k.v('leaf', 1 + dx * 2, 3, dz * 2, jit(0x3f9a4a, hash01(dx + dz, 2)));
    k.v('leaf', 1 + dx * 3, 2, dz * 3, 0x35883e);
  }
  k.v('leaf', 1, 4, 0, 0x3f9a4a);
}

function kitAcacia(k: Kit, r: number): void {
  for (let y = 0; y <= 2; y++) k.v('wood', y >= 2 ? 1 : 0, y, 0, jit(0x7a5a3a, r));
  for (let x = -2; x <= 3; x++) for (let z = -2; z <= 2; z++) {
    if (Math.hypot(x - 0.5, z) > 2.6 || hash01(x * 5 + z, 3) < 0.12) continue;
    k.v('leaf', x, 3, z, jit(0x9aa83f, hash01(x + z, 6)));
  }
  for (let x = -1; x <= 2; x++) for (let z = -1; z <= 1; z++) {
    if (hash01(x + z * 3, 8) < 0.4) continue;
    k.v('leaf', x, 4, z, 0xa8b84a);
  }
}

function kitDead(k: Kit, r: number): void {
  for (let y = 0; y <= 3; y++) k.v('organicDark', 0, y, 0, jit(0x6a5a48, r));
  k.v('organicDark', 1, 2, 0, 0x6a5a48); k.v('organicDark', 2, 3, 0, 0x65553f);
  k.v('organicDark', -1, 3, 0, 0x6a5a48); k.v('organicDark', 0, 3, 1, 0x65553f); k.v('organicDark', 0, 4, 0, 0x65553f);
}

const TREE_KITS: Record<TreeSpeciesKey, KitBuilder> = {
  spruce: kitSpruce,
  oak: kitOak,
  birch: kitBirch,
  cherry: kitSakura,
  acacia: kitAcacia,
  palm: kitPalm,
};

/* ------------------------------------------------------------------ */
/* 地表植被 / 纪元状态                                                  */
/* ------------------------------------------------------------------ */

function kitBush(k: Kit, berry: boolean, wilt = false): void {
  const baseColor = wilt ? (berry ? 0x59623a : 0x657044) : (berry ? 0x376b33 : 0x3f8f3a);
  const tipColor = wilt ? 0x7b7848 : (berry ? 0x3d7838 : 0x4b9a43);
  for (let y = 0; y <= 1; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    if (Math.hypot(x, z) > 1.6 || hash01(x * 3 + z + y, 4) < 0.15) continue;
    k.v('leaf', x, y, z, jit(baseColor, hash01(x + z, 1)));
  }
  // 1/8 格叶尖打破原 1/4 格的方整轮廓，但不改变灌木主体占地。
  const tips = [[-3, 1, 0], [3, 1, 0], [0, 1, -3], [0, 1, 3], [-2, 4, 1], [2, 4, -1]] as const;
  for (const [x, y, z] of tips)
    k.m('leaf', x, y, z, 1, 1, 1, jit(tipColor, hash01(x * 11 + y + z, 21)));
  if (berry) {
    for (const [x, y, z] of [[-2, 3, -2], [1, 4, -2], [3, 2, 1], [-1, 4, 2]] as const)
      k.m('accent', x, y, z, 1, 1, 1, jit(0xc0392b, hash01(x * 13 + y * 7 + z, 22)));
  }
}

function kitWheat(k: Kit, r: number, wilt = false): void {
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    if (hash01(x * 3 + z, 2) < 0.1) continue;
    k.v('thatch', x, 0, z, jit(wilt ? 0x9d8240 : 0xc9a03a, r));
    k.v('thatch', x, 1, z, jit(wilt ? 0xae934b : 0xd8b13a, hash01(x + z, 3)));
  }
}

function kitSprout(k: Kit, r: number, wilt = false): void {
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    k.v('leaf', x, 0, z, jit(wilt ? 0x858250 : 0x77a050, r));
}

function kitScorch(k: Kit, r: number): void {
  k.v('organicDark', 0, 0, 0, 0x26221f); k.v('organicDark', 0, 1, 0, 0x2a2725);
  k.v('organicDark', 1, 0, 1, 0x26221f); k.v('organicDark', -1, 0, -1, 0x2a2725);
  k.v('plaster', -1, 0, 0, 0x5a5855); k.v('plaster', 1, 0, -1, 0x555350);
  if (r < 0.6) k.v('glowRed', 0, 0, 1, 0x8a2a20); // 暗红余烬
}

function kitFire(k: Kit, r: number): void {
  // 1/8 格微体素：石圈、交叉木柴、炭床、内外焰和上浮火星分层表达。
  const stones = [[-3, 0], [-2, -2], [0, -3], [2, -2], [3, 0], [2, 2], [0, 3], [-2, 2]] as const;
  stones.forEach(([x, z], index) => k.m(
    'stone', x, 0, z, 1.6, 1, 1.6,
    jit(index % 2 ? 0x56504a : 0x484541, hash01(index, 31)),
  ));
  k.m('organicDark', 0, 0.7, 0, 6, 1, 1.2, jit(0x3c2d22, r));
  k.m('organicDark', 0, 0.8, 0, 1.2, 1, 6, jit(0x4a3424, hash01(2, 32)));

  for (const [x, z, c] of [[-1.5, -1, 0xb83a24], [1.4, -0.8, 0xe0522f], [-0.8, 1.3, 0xff6a3a], [1.2, 1.2, 0xc43d25]] as const)
    k.m('glowRed', x, 1.3, z, 1.2, 0.8, 1.2, c, 'fire-ember', 'fire');

  k.m('glowRed', 0, 1.4, 0, 3.8, 2.4, 3.6, 0xff5b32, 'fire-core', 'fire');
  k.m('glowWarm', -0.7, 2.8, 0.4, 2.1, 3.2, 2, 0xffa33f, 'fire-mid', 'fire');
  k.m('glowWarm', 0.9, 2.5, -0.5, 1.8, 2.7, 1.8, jit(0xffb44f, r), 'fire-mid', 'fire');
  k.m('glowWarm', 0, 3.1, 0, 1.5, 2.5, 1.5, 0xffd875, 'fire-inner', 'fire');
  k.m('glowRed', -1.2, 4.5, -0.3, 1.2, 3.1, 1.2, 0xff6a34, 'fire-tip', 'fire');
  k.m('glowWarm', 0.8, 4.8, 0.5, 1, 3.5, 1, 0xffbd55, 'fire-tip', 'fire');
  k.m('glowWarm', 0, 5.1, -0.4, 0.8, 2.8, 0.8, 0xffe1a0, 'fire-tip', 'fire');
  k.m('glowRed', -1.8, 6.5, 0.8, 0.65, 0.65, 0.65, 0xff7a3f, 'fire-spark', 'fire');
  k.m('glowWarm', 1.7, 7.2, -0.9, 0.55, 0.55, 0.55, 0xffcf68, 'fire-spark', 'fire');
  k.m('glowRed', 0.5, 8, 1, 0.45, 0.45, 0.45, 0xff6a3a, 'fire-spark', 'fire');
}

function kitSnowdrift(k: Kit, r: number): void {
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    if (Math.hypot(x, z) > 2 || hash01(x + z * 3, 5) < 0.2) continue;
    k.v('plaster', x, 0, z, jit(0xeef2f6, r));
  }
}

function kitIceSpike(k: Kit): void {
  for (const [sx, sz, h] of [[0, 0, 3], [-1, 1, 2], [1, -1, 2]] as const)
    for (let y = 0; y <= h; y++)
      k.v('plaster', sx, y, sz, jit(0xcfe8f4, hash01(sx + sz + y, 7)));
}

/** 只投影为非权威的小型生态细节；落点由种子、地表和邻水/邻树关系确定。 */
function kitGrassTuft(k: Kit, r: number): void {
  for (const [x, z, h] of [[-2, 0, 3], [0, -1, 4], [2, 1, 3], [1, 2, 2]] as const)
    k.m('leaf', x, 0, z, 1, h, 1, jit(0x618d48, hash01(x * 7 + z, 92)));
  if (r > 0.62) k.m('leaf', -1, 0, 2, 1, 2, 1, jit(0x789f53, r));
}

function kitFlowers(k: Kit, r: number): void {
  const colors = [0xf0d96f, 0xe8a7c2, 0xd9e6f2, 0xb8a5e0] as const;
  [[-2, -1], [1, -2], [2, 1], [-1, 2]].forEach(([x, z], index) => {
    k.m('leaf', x, 0, z, 1, 3, 1, jit(0x5b8f43, hash01(index, 93)));
    k.m('accent', x, 3, z, 1.5, 1, 1.5, jit(colors[(index + Math.floor(r * colors.length)) % colors.length], hash01(index, 94)));
  });
}

function kitReeds(k: Kit, r: number): void {
  [[-2, -1, 6], [0, 1, 7], [2, -2, 5], [3, 1, 6], [-3, 2, 4]].forEach(([x, z, h], index) => {
    k.m('leaf', x, 0, z, 1, h, 1, jit(0x6e934b, hash01(index, 95)));
    if (index < 3) k.m('organicDark', x, h, z, 1.2, 2, 1.2, jit(0x765236, r));
  });
}

function kitMushrooms(k: Kit, r: number): void {
  [[-2, 0, 3], [1, -1, 2], [2, 2, 3]].forEach(([x, z, h], index) => {
    k.m('plaster', x, 0, z, 1, h, 1, jit(0xd8c7a8, hash01(index, 96)));
    k.m('accent', x, h, z, 2, 1, 2, jit(index === 0 ? 0xb76745 : 0x9b7650, r));
  });
}

function kitFallenBranch(k: Kit, r: number): void {
  k.m('wood', 0, 0, 0, 7, 1.2, 1.4, jit(0x755036, r));
  k.m('wood', -2, 0.8, 2, 1.2, 1.2, 4, jit(0x68472f, hash01(1, 97)));
  k.m('organicDark', 3.5, 0, 0, 1, 1.5, 1.7, 0x4f3828);
}

function kitDroughtCracks(k: Kit, r: number): void {
  k.m('organicDark', 0, 0, 0, 7, 0.35, 0.45, jit(0x493727, r));
  k.m('organicDark', -1.5, 0, -1.5, 0.45, 0.35, 4, 0x4f3a29);
  k.m('organicDark', 2, 0, 1.4, 0.45, 0.35, 3.5, 0x443326);
  k.m('organicDark', -3, 0, 1.2, 3, 0.35, 0.4, 0x4a3728);
}

/* ------------------------------------------------------------------ */
/* 物资堆（掉落物 / 容器）                                              */
/* ------------------------------------------------------------------ */

function kitWoodpile(k: Kit, r: number): void {
  for (const [y, zs] of [[0, [-1, 0, 1]], [1, [-1, 0]]] as const)
    for (const z of zs) for (let x = -1; x <= 1; x++)
      k.v('wood', x, y, z, Math.abs(x) === 1 ? jit(0xb0925a, r) : jit(0x8a6a48, hash01(x + z + y, 2)));
}

function kitStonepile(k: Kit, r: number): void {
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    if (hash01(x + z * 3, 4) < 0.15) continue;
    k.v('stone', x, 0, z, jit(0x84888d, hash01(x + z, 5)));
  }
  k.v('stone', 0, 1, 0, jit(0x7d8288, r));
}

/** 矮木筐盛放果实；低轮廓与灌木、人物保持清晰区分。 */
function kitFoodpile(k: Kit, r: number): void {
  // 筐子仍占约 3/4 格，但编条、果实和叶片使用 1/8 格构件。
  k.m('wood', 0, 0, 0, 6, 1, 6, jit(0x8a6a48, r));
  k.m('organicDark', 0, 1, -2.5, 6, 2, 1, jit(0x6e4f33, hash01(1, 15)));
  k.m('organicDark', 0, 1, 2.5, 6, 2, 1, jit(0x6e4f33, hash01(2, 15)));
  k.m('organicDark', -2.5, 1, 0, 1, 2, 4, jit(0x6e4f33, hash01(3, 15)));
  k.m('organicDark', 2.5, 1, 0, 1, 2, 4, jit(0x6e4f33, hash01(4, 15)));
  const produce = [
    [-2, 2, 0, 1, 1, 1, 0xc94f45], [0, 2, -2, 1, 2, 1, 0xd9783d],
    [0, 2, 0, 1, 1, 1, 0xb9413b], [0, 2, 2, 1, 1, 1, 0xd7a444],
    [2, 2, 0, 1, 1, 1, 0xc94f45], [-1, 3, 1, 1, 2, 1, 0xd9783d],
    [1, 3, -1, 1, 1, 1, 0xb9413b],
  ] as const;
  for (const [x, y, z, sx, sy, sz, c] of produce)
    k.m('accent', x, y, z, sx, sy, sz, jit(c, hash01(x * 11 + y * 5 + z, 16)));
  k.m('leaf', 1, 4, 0, 2, 1, 1, jit(0x4f8f3d, r));
  k.m('accent', 4, 0, 2, 1, 1, 1, jit(0xc94f45, hash01(2, 17)));        // 散落果实
}

/** 侧倒麻袋与金色籽粒；籽粒铺地而非堆成竖直包裹。 */
function kitSeedpile(k: Kit, r: number): void {
  k.m('plaster', -2, 0, -1, 5, 2, 4, jit(0xb8a078, hash01(1, 18)));
  k.m('plaster', -3, 2, -1, 3, 2, 3, jit(0xc2aa80, hash01(2, 18)));
  k.m('plaster', 1, 1, -1, 2, 2, 2, jit(0xb8a078, hash01(3, 18)));       // 松开的袋口
  k.m('organicDark', 1, 3, -1, 1, 1, 2, 0x6e4f33);                     // 袋口束绳
  const seeds = [
    [1, 0, 1], [2, 0, -2], [2, 0, 0], [2, 0, 2], [3, 0, -1],
    [3, 0, 1], [4, 0, -2], [4, 0, 0], [4, 0, 2], [5, 0, 1],
    [1, 1, 0], [2, 1, 1],
  ] as const;
  for (const [x, y, z] of seeds)
    k.m('accent', x, y, z, 1, 1, 1, jit(0xb8953f, hash01(x * 13 + y * 5 + z, 19)));
  if (r > 0.55) k.m('accent', 5, 0, -2, 1, 1, 1, jit(0xc3a14d, r));
}

function kitBundle(k: Kit, r: number): void {
  for (let y = 0; y <= 1; y++) for (let x = -1; x <= 0; x++) for (let z = -1; z <= 0; z++)
    k.v('wood', x, y, z, jit(0x8a6a48, hash01(x + z + y, 3)));
  k.v('organicDark', 0, 2, -1, 0x54402a); k.v('organicDark', 0, 2, 0, 0x54402a); // 箱盖沿
  k.v('plaster', 1, 0, 0, jit(0xb09a70, r));                        // 麻布包
}

function kitMeat(k: Kit, r: number): void {
  k.m('plaster', 0, 0, 0, 6, 1, 5, jit(0xb99a76, hash01(1, 101))); // 垫布
  k.m('accent', -1.5, 1, 0, 3, 2, 3, jit(0x9f3f3d, r));
  k.m('accent', 1.5, 1, -0.5, 2.5, 1.5, 2.5, jit(0x7f3132, hash01(2, 101)));
  k.m('plaster', 2.5, 2.1, -0.5, 1.8, 0.5, 0.8, 0xe2d3bd); // 可辨认骨端
}

function kitHide(k: Kit, r: number): void {
  k.m('wood', 0, 0, 0, 7, 1, 6, jit(0x75523a, r));
  for (const [x, z] of [[-3, -2], [3, -2], [-3, 2], [3, 2]] as const)
    k.m('organicDark', x, 0, z, 1.5, 1, 1.5, 0x4d3527);
  k.m('plaster', 0, 1, 0, 4, 0.7, 3, jit(0xb49470, hash01(3, 102)));
}

function kitBonePile(k: Kit, r: number): void {
  k.m('plaster', 0, 0, 0, 7, 1.2, 1.2, jit(0xd1c8ad, r));
  k.m('plaster', 0, 0, 0, 1.2, 1.2, 6, jit(0xc4b99b, hash01(2, 103)));
  for (const [x, z] of [[-3.5, 0], [3.5, 0], [0, -3], [0, 3]] as const)
    k.m('plaster', x, 0.1, z, 1.8, 1.8, 1.8, jit(0xd9d0b6, hash01(x + z, 103)));
}

function kitToolRack(k: Kit, r: number, kind: 'stone' | 'bone' | 'spear'): void {
  k.m('wood', 0, 0, -2, 7, 1, 1, jit(0x6f4b31, r));
  k.m('wood', -2.5, 0, -2, 1, 5, 1, 0x62432d);
  k.m('wood', 2.5, 0, -2, 1, 5, 1, 0x62432d);
  if (kind === 'spear') {
    for (const x of [-2, 0, 2]) {
      k.m('wood', x, 1, 0, 1, 8, 1, jit(0x775136, hash01(x, 104)));
      k.m('stone', x, 9, 0, 2, 2, 1.5, jit(0x85847d, r));
    }
    return;
  }
  const bucket: DecorBucket = kind === 'bone' ? 'plaster' : 'stone';
  const color = kind === 'bone' ? 0xc9c0a5 : 0x7d7a72;
  for (const x of [-2, 0, 2]) {
    k.m('wood', x, 1, 0, 1, 5, 1, 0x775136);
    k.m(bucket, x, 6, 0, 3, 2, 2, jit(color, hash01(x, 105)));
  }
}

function kitTextile(k: Kit, r: number, leather = false): void {
  const color = leather ? 0x6f4c35 : 0xb09b72;
  k.m('plaster', -1.5, 0, 0, 5, 2, 6, jit(color, r));
  k.m('plaster', 1.5, 2, 0, 4, 2, 5, jit(leather ? 0x5c3f2e : 0x8d6f5d, hash01(2, 106)));
  k.m('organicDark', 0, 4, 0, 7, 1, 1, leather ? 0x3f2d24 : 0x80633f);
}

function kitRope(k: Kit, r: number): void {
  for (let ring = 0; ring < 3; ring++) {
    const radius = 2.5 - ring * 0.7;
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * Math.PI * 2;
      k.m('thatch', Math.cos(angle) * radius, ring, Math.sin(angle) * radius, 1.3, 1, 1.3, jit(0xaa8a59, hash01(i + ring * 8, 107)));
    }
  }
  if (r > 0.5) k.m('thatch', 3, 0, 2, 3, 1, 1, 0x967747);
}

function kitTablet(k: Kit, r: number): void {
  for (let i = 0; i < 4; i++) {
    k.m('wood', -1 + i * 0.7, i * 0.8, 0, 5, 0.7, 3.5, jit(0x96683f, hash01(i, 108)));
    for (const z of [-1, 0, 1]) k.m('organicDark', -1 + i * 0.7, i * 0.8 + 0.7, z, 3, 0.25, 0.3, jit(0x4f3929, r));
  }
}

function kitContainer(k: Kit, r: number, fillRatio = 0): void {
  k.m('wood', 0, 0, 0, 7, 1, 7, jit(0x82552f, r));
  for (const [x, z, sx, sz] of [[-3, 0, 1, 6], [3, 0, 1, 6], [0, -3, 6, 1], [0, 3, 6, 1]] as const)
    k.m('wood', x, 1, z, sx, 4, sz, jit(0x94643b, hash01(x + z, 109)));
  if (fillRatio > 0) {
    const fillHeight = Math.max(0.5, Math.min(2.8, fillRatio * 2.8));
    k.m('thatch', 0, 1, 0, 5, fillHeight, 5, jit(0xb79b62, r));
    k.m('wood', 0, 5.1, -2.6, 6, 0.7, 2, 0x604029);
  } else k.m('organicDark', 0, 4.6, 0, 6, 0.7, 6, 0x604029);
}

function kitCookedFood(k: Kit, r: number): void {
  k.m('stone', 0, 0, 0, 7, 1, 6, jit(0x77746e, r));
  for (const [x, z] of [[-2, -1], [0, 1], [2, -1]] as const)
    k.m('accent', x, 1, z, 2.5, 1.5, 2, jit(0xa65a35, hash01(x + z, 110)));
  k.m('leaf', 0, 2.5, 1, 4, 0.5, 2, 0x657e42);
}

function kitHerbs(k: Kit, r: number): void {
  for (const x of [-2, 0, 2]) {
    k.m('leaf', x, 0, 0, 1, 5, 1, jit(0x58814b, hash01(x, 111)));
    k.m('leaf', x - 0.8, 2, 0, 2, 1, 2, jit(0x76965b, r));
  }
  k.m('thatch', 0, 2, 0, 7, 1, 1, 0xb18c59);
}

function kitCharcoal(k: Kit, r: number): void {
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    if (hash01(x * 5 + z, 112) < 0.28) continue;
    k.m('organicDark', x, 0, z, 1.6, 1.4 + hash01(x + z, 113) * 1.8, 1.6, jit(0x30302f, r));
  }
}

/** 低矮、带湿润断面的黏土团块；不再回退成麻布包。 */
function kitClayPile(k: Kit, r: number): void {
  const lumps = [
    [-2.7, 0, -1.4, 3.2, 1.8, 2.7], [0.2, 0, -1.7, 3.7, 2.1, 2.5],
    [2.9, 0, -0.7, 2.4, 1.6, 2.8], [-1.8, 0, 1.6, 3, 1.7, 2.4],
    [1.2, 0, 1.5, 3.8, 2.2, 2.8], [0, 1.35, 0.2, 2.8, 1.55, 2.4],
  ] as const;
  lumps.forEach(([x, y, z, sx, sy, sz], index) => k.m(
    index % 3 === 0 ? 'groundMark' : 'roofTile', x, y, z, sx, sy, sz,
    jit(index % 3 === 0 ? 0x765443 : 0x956852, hash01(index, 320) * 0.72 + r * 0.28),
  ));
  k.m('groundMark', -0.6, 2.7, 0.32, 1.5, 0.12, 0.9, 0xb08369);
}

type OrePileKind = 'copper_ore' | 'tin_ore' | 'iron_ore';

/** 围岩、断面和矿脉共同区分三类权威矿石；低矮轮廓避免被误认成成品金属。 */
function kitOrePile(k: Kit, r: number, kind: OrePileKind): void {
  const profile = {
    copper_ore: { rock: 0x52695f, deep: 0x344a43, vein: 0x6ca17f },
    tin_ore: { rock: 0x737d82, deep: 0x4d565c, vein: 0xb3c0c4 },
    iron_ore: { rock: 0x6f4f42, deep: 0x493a35, vein: 0xa25e3d },
  }[kind];
  const rocks = [
    [-3, 0, -1.6, 2.1, 1.6, 2], [-1, 0, -1.8, 2.6, 1.9, 2.2],
    [1.3, 0, -1.4, 2.1, 1.5, 1.9], [3, 0, -0.8, 1.8, 1.6, 2.2],
    [-2.7, 0, 1.1, 1.9, 1.5, 2.4], [-0.7, 0, 1.3, 2.4, 2, 2.2],
    [1.7, 0, 1.3, 2.3, 1.7, 2.2], [3.2, 0.1, 1.4, 1.6, 1.5, 1.7],
    [-1.7, 1.25, -0.4, 1.9, 1.6, 1.7], [0.3, 1.35, -0.3, 2.2, 2.1, 1.9],
    [1.8, 1.25, 0.2, 1.7, 1.6, 1.7], [-0.3, 2.85, 0.2, 1.4, 1.2, 1.3],
  ] as const;
  rocks.forEach(([x, y, z, sx, sy, sz], index) => k.m(
    index % 3 === 1 ? 'dark' : 'stone', x, y, z, sx, sy, sz,
    jit(index % 3 === 1 ? profile.deep : profile.rock, hash01(index, 321) * 0.65 + r * 0.35),
  ));
  const veins = kind === 'copper_ore'
    ? [[-3, 1.02, -0.56, 1.45], [-0.7, 1.32, 2.44, 1.45], [1.7, 1.18, 2.44, 1.3], [0.3, 3.02, 0.7, 0.78]]
    : kind === 'tin_ore'
      ? [[-3, 1.02, -0.56, 1.35], [-0.7, 1.34, 2.44, 1.55], [1.7, 1.16, 2.44, 1.35], [0.3, 3.02, 0.7, 0.86]]
      : [[-3, 1.02, -0.56, 1.35], [-0.7, 1.32, 2.44, 1.45], [1.7, 1.14, 2.44, 1.4], [0.3, 3.02, 0.7, 0.82]];
  veins.forEach(([x, y, z, sx], index) => k.m(
    'accent', x, y, z, sx, kind === 'iron_ore' ? 0.38 : 0.32, 0.2,
    jit(profile.vein, hash01(index, 322)),
  ));
}

type SmeltingChargeKind = 'copper_charge' | 'tin_charge' | 'iron_charge' | 'steel_charge';

/** 浅耐火料盘中的矿炭混料；它是配料，不冒充矿石或已经冶炼的金属锭。 */
function kitSmeltingCharge(k: Kit, r: number, kind: SmeltingChargeKind): void {
  const color = {
    copper_charge: 0x4c5b4d,
    tin_charge: 0x5e6468,
    iron_charge: 0x4f3d36,
    steel_charge: 0x434647,
  }[kind];
  k.m('roofTile', 0, 0, 0, 8, 1, 6, jit(0x754b3b, r));
  for (const [x, z, sx, sz] of [[-3.5, 0, 1, 5], [3.5, 0, 1, 5], [0, -2.5, 6, 1], [0, 2.5, 6, 1]] as const)
    k.m('roofTile', x, 1, z, sx, 1.4, sz, jit(0x8a5540, hash01(x + z, 323)));
  const pieces = [
    [-2.6, -1.4, 1.5, 1.2], [0, -1.6, 1.7, 1], [2.4, -1.1, 1.4, 1.5],
    [-1.5, 0.5, 1.8, 1.6], [1.1, 0.6, 1.5, 1.7], [-0.2, 1.75, 1.4, 1],
  ] as const;
  pieces.forEach(([x, z, sx, sz], index) => k.m(
    index % 3 === 1 ? 'organicDark' : 'dark', x, 1.1, z, sx, 1 + (index % 2) * 0.55, sz,
    index % 3 === 1 ? jit(0x30302f, r) : jit(color, hash01(index, 324)),
  ));
}

type MetalIngotKind = 'copper' | 'tin' | 'bronze' | 'iron' | 'steel';

/** 缩腰铸锭按错层方向平码；颜色和顶面印记区分各类成品金属。 */
function kitMetalIngotStack(k: Kit, r: number, kind: MetalIngotKind): void {
  const color = {
    copper: 0xb56537,
    tin: 0xaeb8b9,
    bronze: 0xb07936,
    iron: 0x5d6365,
    steel: 0x767e82,
  }[kind];
  const bars = [
    [-2, 0, -1.4, 0], [2, 0, -1.4, 0], [-2, 0, 1.4, 0], [2, 0, 1.4, 0],
    [0, 1.15, -0.75, 1], [0, 1.15, 1.25, 1], [0, 2.3, 0.15, 0],
  ] as const;
  bars.forEach(([x, y, z, cross], index) => {
    const sx = cross ? 2.6 : 3.5;
    const sz = cross ? 3.5 : 2.6;
    k.m('dark', x, y, z, sx, 1.05, sz, jit(color, hash01(index, 325) * 0.7 + r * 0.3));
    k.m('dark', x, y + 1.05, z, sx * 0.72, 0.34, sz * 0.72, jit(color, hash01(index, 326)));
    k.m('groundMark', x, y + 1.39, z, cross ? 1.15 : 0.26, 0.08, cross ? 0.26 : 1.15,
      kind === 'steel' ? 0xc0c8cb : 0x5f4935);
  });
}

/** 多孔、不规则的海绵铁团块，和后续规整锻铁锭保持清晰形态断点。 */
function kitIronBloom(k: Kit, r: number): void {
  const lumps = [
    [-2.1, 0, -1.3, 3.4, 2.4, 3], [1.3, 0, -1.2, 3, 2, 2.7],
    [-0.5, 0.2, 1.5, 3.8, 2.7, 3.1], [2.7, 0.1, 1.5, 2.1, 1.8, 2],
    [0.1, 1.6, 0.1, 2.5, 2.1, 2.4],
  ] as const;
  lumps.forEach(([x, y, z, sx, sy, sz], index) => k.m(
    'dark', x, y, z, sx, sy, sz,
    jit(index % 2 ? 0x4d4945 : 0x6b655e, hash01(index, 327) * 0.7 + r * 0.3),
  ));
  for (const [x, y, z] of [[-2.6, 1.7, -2.82], [-0.2, 3.25, 1.45], [1.7, 1.55, -2.5], [2.95, 1.2, 2.38]] as const)
    k.m('groundMark', x, y, z, 0.42, 0.34, 0.16, 0x282725);
}

/** 烧结砖按层交替方向错缝，稳定缺角只承担视觉辨识。 */
function kitFiredBrickStack(k: Kit, r: number): void {
  for (let layer = 0; layer < 4; layer += 1) {
    const alongX = layer % 2 === 0;
    const count = layer === 3 ? 3 : 4;
    for (let index = 0; index < count; index += 1) {
      const offset = (index - (count - 1) / 2) * 2.05;
      const x = alongX ? offset : index % 2 ? 1.05 : -1.05;
      const z = alongX ? index % 2 ? 1.05 : -1.05 : offset;
      k.m('roofTile', x, layer * 1.05, z, alongX ? 1.86 : 3.9, 0.92, alongX ? 3.9 : 1.86,
        jit(index === count - 1 && layer === 2 ? 0x8b4937 : 0x9f4e34, hash01(index + layer * 7, 328) * 0.7 + r * 0.3));
    }
  }
  k.m('roofTile', 4.7, 0.08, 2.8, 2.9, 0.78, 1.55, jit(0x8f4633, r));
  k.m('groundMark', 5.55, 0.86, 3.38, 0.55, 0.12, 0.2, 0x563329);
}

type ProductionToolKind = 'wood_tool' | 'stone_hoe' | 'bronze_tool' | 'iron_tool';

/** 同尺度工具架用刀头材质和轮廓表达技术代际，不再回退为箱包。 */
function kitProductionTools(k: Kit, r: number, kind: ProductionToolKind): void {
  k.m('organicDark', 0, 0, -2.4, 8, 1, 1, jit(0x5b3f2b, r));
  for (const x of [-3.2, 3.2]) k.m('organicDark', x, 0, -2.4, 1, 5, 1, 0x5b3f2b);
  const headBucket: DecorBucket = kind === 'wood_tool' ? 'wood' : kind === 'stone_hoe' ? 'stone' : 'dark';
  const headColor = {
    wood_tool: 0x855731,
    stone_hoe: 0x716f67,
    bronze_tool: 0xb98038,
    iron_tool: 0x666c6e,
  }[kind];
  k.m('wood', -2.2, 0.65, 0, 1, 7, 1, jit(0x775136, r));
  k.m(headBucket, -2.2, 7.2, kind === 'stone_hoe' ? 1 : 0,
    kind === 'iron_tool' ? 4 : 3.2, 1.5, kind === 'stone_hoe' ? 2.7 : 1.5, headColor);
  k.m('wood', 1.6, 0.65, 0.2, 1, 6.6, 1, jit(0x775136, hash01(2, 329)));
  if (kind === 'stone_hoe') {
    k.m('stone', 2.55, 6.1, 0.2, 2.8, 1.2, 1.1, headColor);
    k.m('stone', 3.55, 5.35, 0.2, 1, 2.3, 1.1, 0x65635d);
  } else if (kind === 'bronze_tool') {
    k.m('dark', 1.6, 6.45, 0.2, 1.4, 3.2, 1.4, headColor);
    k.m('dark', 3, 7.25, 0.2, 2.4, 0.7, 0.72, 0xc08a43);
  } else if (kind === 'iron_tool') {
    k.m('dark', 1.6, 6.3, 0.2, 5, 1.2, 1.25, headColor);
    k.m('dark', 3.85, 5.75, 0.2, 0.65, 2.2, 1, 0x53585a);
  } else {
    k.m('wood', 1.6, 6.45, 0.2, 3.4, 2, 1.7, headColor);
    k.m('organicDark', 3.15, 6.8, 0.2, 0.55, 1.2, 1.9, 0x5b3f2b);
  }
}

interface PileVisual {
  materialId: number;
  quantity: number;
  build: KitBuilder;
  r: number;
}

interface PileSlot {
  x: number;
  z: number;
  width: number;
  depth: number;
}

function quarterOffsetAt(quadrant: number, jitterSeed: number): { x: number; z: number } {
  const baseX = quadrant % 2 === 0 ? -0.23 : 0.23;
  const baseZ = quadrant < 2 ? -0.23 : 0.23;
  return {
    x: baseX + (hash01(jitterSeed, 61) - 0.5) * 0.06,
    z: baseZ + (hash01(jitterSeed, 62) - 0.5) * 0.06,
  };
}

/** 在格子的四个象限中选一个稳定随机落点，少量抖动避免排列过于整齐。 */
function quarterCellOffset(r: number, jitterSeed: number): { x: number; z: number } {
  return quarterOffsetAt(Math.min(3, Math.floor(r * 4)), jitterSeed);
}

/**
 * 同一站立位置最多展示四个语义堆。槽位彼此不相交；超过四种物资时，前三种
 * 保持自身外形，其余合并为一个通用包裹，避免一个格子重新变成素材陈列台。
 */
function pileSlots(count: number, r: number, jitterSeed: number): PileSlot[] {
  const start = Math.min(3, Math.floor(r * 4));
  const step = hash01(jitterSeed, 63) < 0.5 ? 1 : 3;
  return Array.from({ length: Math.min(4, Math.max(1, count)) }, (_, index) => ({
    ...quarterOffsetAt((start + index * step) % 4, jitterSeed + index * 17),
    width: count <= 1 ? 0.4 : 0.38,
    depth: count <= 1 ? 0.4 : 0.38,
  }));
}

/** 把任意物资素材按真实 AABB 拟合进一个不重叠槽位，并自动选择最合适朝向。 */
function placePileInSlot(
  out: DecorInstance[], visual: PileVisual, slot: PileSlot,
  centerX: number, groundY: number, centerZ: number,
): void {
  let best: { stamp: DecorInstance[]; scale: number; minX: number; maxX: number; minY: number; minZ: number; maxZ: number } | null = null;
  const quantityScale = Math.min(1, 0.72 + Math.log2(Math.max(1, visual.quantity) + 1) * 0.08);
  for (let rot = 0; rot < 4; rot++) {
    const stamp: DecorInstance[] = [];
    visual.build(new Kit(stamp, 0, 0, 0, 1, rot), visual.r);
    if (!stamp.length) continue;
    const minX = Math.min(...stamp.map((inst) => inst.x - inst.sx / 2));
    const maxX = Math.max(...stamp.map((inst) => inst.x + inst.sx / 2));
    const minY = Math.min(...stamp.map((inst) => inst.y - inst.sy / 2));
    const minZ = Math.min(...stamp.map((inst) => inst.z - inst.sz / 2));
    const maxZ = Math.max(...stamp.map((inst) => inst.z + inst.sz / 2));
    const scale = Math.min(
      quantityScale,
      slot.width / Math.max(MICRO, maxX - minX),
      slot.depth / Math.max(MICRO, maxZ - minZ),
    );
    if (!best || scale > best.scale) best = { stamp, scale, minX, maxX, minY, minZ, maxZ };
  }
  if (!best) return;
  const modelCenterX = (best.minX + best.maxX) / 2;
  const modelCenterZ = (best.minZ + best.maxZ) / 2;
  for (const inst of best.stamp) {
    out.push({
      ...inst,
      x: centerX + slot.x + (inst.x - modelCenterX) * best.scale,
      y: groundY + (inst.y - best.minY) * best.scale,
      z: centerZ + slot.z + (inst.z - modelCenterZ) * best.scale,
      sx: inst.sx * best.scale,
      sy: inst.sy * best.scale,
      sz: inst.sz * best.scale,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 建筑印章（按 structure 占地缩放）                                     */
/* ------------------------------------------------------------------ */

export interface CivilizationStagePreview {
  label: string;
  instances: DecorInstance[];
}

function previewBox(
  k: Kit,
  bucket: DecorBucket,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  color: number,
  salt: number,
  shell = false,
): void {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    if (shell && !(x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1)) continue;
    k.v(bucket, x, y, z, jit(color, hash01(x * 31 + y * 17 + z * 13, salt)));
  }
}

/** 文明阶段卡片使用的部落营地：三顶兽皮帐、篝火与图腾。 */
function kitTribalCampPreview(k: Kit, active = true): void {
  for (const [tentX, tentZ] of [[-4, -2], [3, -3], [0, 3]] as const) {
    for (let y = 1; y <= 4; y++) {
      const radius = 2.6 - y * 0.55;
      for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
        const distance = Math.hypot(x, z);
        if (distance > radius + 0.35 || distance < radius - 0.75) continue;
        if (y <= 2 && x === 0 && z >= 1) continue;
        k.v('thatch', tentX + x, y, tentZ + z, jit(0x8a6a48, hash01(x * 17 + y * 7 + z, 141)));
      }
    }
    k.v('organicDark', tentX, 5, tentZ, 0x5f422a);
  }
  for (let index = 0; index < 8; index++) {
    const angle = index * Math.PI / 4;
    k.v('stone', Math.round(Math.cos(angle) * 1.6), 1, Math.round(Math.sin(angle) * 1.6),
      jit(0x7d8288, hash01(index, 142)));
  }
  k.v('wood', 0, 1, 0, 0x5f422a);
  k.v('wood', 1, 1, 0, 0x54402a);
  k.v('wood', 0, 1, 1, 0x5f422a);
  if (active) {
    k.v('glowRed', 0, 1, -1, 0xff6a55, 'fire-core', 'fire');
    k.v('glowWarm', 0, 2, 0, 0xffc37a, 'fire-mid', 'fire');
    k.v('glowWarm', 0, 3, 0, 0xff9a4a, 'fire-tip', 'fire');
    k.v('plaster', 0, 4, 0, 0xb9bec4, 'facility-smoke', 'facility-smoke');
    k.v('plaster', 1, 5, 0, 0xc9ced4, 'facility-smoke', 'facility-smoke');
  } else k.v('organicDark', 0, 1, -1, 0x49372b);
  const totemColors = [0xc0392b, 0xd8a03a, 0x3a7a8c, 0xc0392b, 0xd8a03a];
  for (let y = 1; y <= 5; y++) k.v('accent', 6, y, 3, totemColors[y - 1]);
  k.v('accent', 5, 5, 3, 0x3a7a8c);
  k.v('accent', 7, 5, 3, 0x3a7a8c);
  k.v('organicDark', 6, 6, 3, 0x4e3822);
}

/** 农耕定居阶段的风车磨坊：石基、木身与四叶风车。 */
function kitWindmillPreview(k: Kit): void {
  const layers = [[3.4, 1], [3.2, 2], [3, 3], [2.8, 4], [2.5, 5], [2.3, 6], [2.1, 7]] as const;
  for (const [radius, y] of layers) {
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
      const distance = Math.hypot(x, z);
      if (distance > radius + 0.3 || distance < radius - 0.8) continue;
      if (z >= 2 && x === 0 && y <= 2) continue;
      if (y === 5 && z >= 1 && Math.abs(x) <= 1) {
        k.v('dark', x, y, z, 0x33404e);
        continue;
      }
      const stone = y <= 4;
      k.v(stone ? 'stone' : 'wood', x, y, z,
        jit(stone ? 0x8f8a80 : 0x7a5636, hash01(x * 19 + y * 7 + z, 143)));
    }
  }
  previewBox(k, 'organicDark', 0, 1, 3, 0, 2, 3, 0x4e3822, 144);
  for (const [radius, y] of [[2.9, 8], [1.8, 9], [1, 10]] as const) {
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
      if (Math.hypot(x, z) <= radius) k.v('roofTile', x, y, z, jit(0x4a4038, hash01(x * 11 + y + z, 145)));
    }
  }
  k.v('dark', 0, 7, 4, 0x2e3236);
  for (let index = 1; index <= 4; index++) {
    const end = index === 1 || index === 4;
    const bucket: DecorBucket = end ? 'organicDark' : 'plaster';
    const color = end ? 0x5f422a : 0xd8cfc0;
    k.v(bucket, index, 7 + index, 4, color);
    k.v(bucket, -index, 7 + index, 4, color);
    k.v(bucket, index, 7 - index, 4, color);
    k.v(bucket, -index, 7 - index, 4, color);
    if (index >= 2 && index <= 3) {
      k.v('plaster', index, 6 + index, 4, 0xd8cfc0);
      k.v('plaster', -index, 6 + index, 4, 0xd8cfc0);
      k.v('plaster', index, 8 - index, 4, 0xd8cfc0);
      k.v('plaster', -index, 8 - index, 4, 0xd8cfc0);
    }
  }
}

/** 古代文明阶段的阶梯神庙：台基、正面阶梯、祭坛与方尖碑。 */
function kitTemplePreview(k: Kit, active = true): void {
  for (const [halfWidth, y] of [[6, 1], [5, 2], [4, 3], [3, 4], [2, 5]] as const) {
    for (let x = -halfWidth; x <= halfWidth; x++) for (let z = -halfWidth; z <= halfWidth; z++) {
      const edge = Math.abs(x) === halfWidth || Math.abs(z) === halfWidth;
      k.v('stone', x, y, z, jit(edge ? 0xb09a72 : 0xc9b28a, hash01(x * 23 + y * 5 + z, 146)));
    }
  }
  for (let step = 0; step <= 5; step++) {
    const z = 7 - step;
    const y = step + 1;
    for (let x = -1; x <= 1; x++) k.v('stone', x, y, z, 0xd8c49a);
    k.v('stone', -2, y, z, 0x8a7652);
    k.v('stone', 2, y, z, 0x8a7652);
  }
  for (const x of [-1, 1]) for (const z of [-1, 1]) previewBox(k, 'accent', x, 6, z, x, 7, z, 0xa63a2e, 147);
  previewBox(k, 'stone', -2, 8, -2, 2, 8, 2, 0x8a7652, 148);
  k.v('dark', 0, 9, 0, 0x2e3236);
  if (active) {
    k.v('glowWarm', 0, 10, 0, 0xffc37a, 'fire-mid', 'fire');
    k.v('glowRed', 0, 11, 0, 0xff6a55, 'fire-tip', 'fire');
  }
  for (const x of [-4, 4]) {
    previewBox(k, 'stone', x, 1, 8, x, 4, 8, 0xc9b28a, 149);
    k.v('roofTile', x, 5, 8, 0x8a7652);
  }
}

/** 西方中世纪城堡原型：并入古代文明后的铁器与防御建筑语汇。 */
function kitCastlePreview(k: Kit, active = true): void {
  const width = 7;
  const depth = 5;
  const wallHeight = 4;
  for (const [centerX, centerZ] of [[-width, -depth], [width, -depth], [-width, depth], [width, depth]] as const) {
    previewBox(k, 'stone', centerX - 1, 1, centerZ - 1, centerX + 1, 6, centerZ + 1, 0x8a8d92, 150, true);
    previewBox(k, 'roofTile', centerX - 1, 7, centerZ - 1, centerX + 1, 7, centerZ + 1, 0x4a4f58, 151);
    k.v('roofTile', centerX, 8, centerZ, 0x3a4048);
  }
  for (let x = -width; x <= width; x++) for (let z = -depth; z <= depth; z++) {
    if (!(Math.abs(x) === width || Math.abs(z) === depth)) continue;
    if (z === depth && Math.abs(x) <= 1) {
      for (let y = 1; y <= 3; y++) if ((x + y) % 2 === 0) k.v('dark', x, y, z, 0x2e3236);
      k.v('stone', x, 4, z, 0x8a8d92);
      if (x === 0) k.v('stone', x, 5, z, 0x7d8288);
      continue;
    }
    for (let y = 1; y <= wallHeight; y++) k.v('stone', x, y, z, jit(0x8a8d92, hash01(x * 29 + y + z, 152)));
    if ((x + z) % 2 === 0) k.v('stone', x, wallHeight + 1, z, 0x7d8288);
  }
  previewBox(k, 'stone', -2, 1, -4, 2, 7, 0, 0x8f9298, 153, true);
  previewBox(k, 'organicDark', 0, 1, 0, 0, 2, 0, 0x4e3822, 154);
  k.v('dark', -2, 5, -2, 0x2c3844);
  k.v('dark', 2, 5, -2, 0x2c3844);
  if (active) k.v('glowWarm', 0, 6, -4, 0xffc37a);
  for (let x = -2; x <= 2; x++) for (let z = -4; z <= 0; z++) {
    if ((Math.abs(x) === 2 || z === -4 || z === 0) && (x + z) % 2 === 0) k.v('stone', x, 8, z, 0x7d8288);
  }
  previewBox(k, 'organicDark', 0, 9, -2, 0, 11, -2, 0x4e3822, 155);
  k.v('accent', 1, 11, -2, 0xc0392b);
  k.v('accent', 2, 11, -2, 0xc0392b);
  k.v('accent', 1, 10, -2, 0xa93226);
}

const CIVILIZATION_STAGE_PREVIEWS: Record<string, { label: string; build: (k: Kit) => void }> = {
  '自然群体': { label: '部落营地', build: kitTribalCampPreview },
  '原始部落': { label: '部落营地', build: kitTribalCampPreview },
  '农耕定居': { label: '风车磨坊', build: kitWindmillPreview },
  '古代文明': { label: '阶梯神庙', build: kitTemplePreview },
  '中世纪': { label: '城堡', build: kitCastlePreview },
  // Retired v7 stage labels render with the current highest-stage symbol.
  '现代文明（含信息能力）': { label: '阶梯神庙', build: kitTemplePreview },
};

/**
 * 文明指数卡片的象征性阶段素材。它只读取观察层阶段，不代表世界中已经建成该建筑。
 * 构型与 Knowledge Base 的文明历程素材保持相同的 1/8 格微体素尺度和材质语义。
 */
export function civilizationStagePreview(stage: string): CivilizationStagePreview {
  const definition = CIVILIZATION_STAGE_PREVIEWS[stage] ?? CIVILIZATION_STAGE_PREVIEWS['原始部落'];
  const instances: DecorInstance[] = [];
  definition.build(new Kit(instances, 0, 0, 0, 1, 0));
  return { label: definition.label, instances };
}

type StructureMaterialKind = 'wood' | 'stone' | 'mixed';

interface StructureVisualProfile {
  weatherProtection: number;
  thermalInsulation: number;
  capacity: number;
  hearthActive: boolean;
}

const EMPTY_STRUCTURE_PROFILE: StructureVisualProfile = {
  weatherProtection: 0,
  thermalInsulation: 0,
  capacity: 0,
  hearthActive: false,
};

function structureStoneColor(x: number, y: number, z: number, seed: number): number {
  const moss = hash01(x * 31 + y * 17 + z * 13, 401 + seed) < 0.08;
  return jit(moss ? 0x6f7a5f : 0x8a8d92, hash01(x * 7 + y * 19 + z * 11, 402 + seed));
}

function structureWindow(profile: StructureVisualProfile): { bucket: DecorBucket; color: number } {
  return profile.hearthActive
    ? { bucket: 'glowWarm', color: 0xffc37a }
    : { bucket: 'dark', color: 0x2c3844 };
}

function addStructureChimney(
  k: Kit,
  x: number,
  z: number,
  baseY: number,
  height: number,
  profile: StructureVisualProfile,
): void {
  for (let y = baseY; y < baseY + height; y += 1)
    k.v('stone', x, y, z, structureStoneColor(x, y, z, 409));
  if (!profile.hearthActive) return;
  k.v('plaster', x, baseY + height, z, 0xb9bec4, 'chimney-smoke', 'facility-smoke');
  k.v('plaster', x, baseY + height + 1, z, 0xc9ced4, 'chimney-smoke', 'facility-smoke');
  k.v('plaster', x + 1, baseY + height + 2, z, 0xd5d9de, 'chimney-smoke', 'facility-smoke');
}

function addStructureEffectDetails(k: Kit, profile: StructureVisualProfile, size: 'hut' | 'house' | 'hall'): void {
  const span = size === 'hut' ? 4 : size === 'house' ? 5 : 7;
  const front = size === 'hut' ? 3 : 4;
  if (profile.weatherProtection >= 78) {
    // 高防护来自真实围护拓扑；表现为门前挑檐与承托，而不是额外规则效果。
    k.m('wood', 0, 5, front, span, 1, 2, 0x6a492f);
    k.m('organicDark', -span / 2 + 0.5, 2, front, 1, 5, 1, 0x4d3828);
    k.m('organicDark', span / 2 - 0.5, 2, front, 1, 5, 1, 0x4d3828);
  }
  if (profile.thermalInsulation >= 70) {
    // 高隔热对应真实封闭侧墙；只增加可辨认的木制窗板。
    k.m('wood', -span / 2, 3, 0, 1, 3, 3, 0x785438);
    k.m('organicDark', -span / 2 - 0.1, 4, 0, 1, 1, 4, 0x493629);
  }
  if (profile.capacity >= 3) {
    const benchLength = Math.min(7, 2 + profile.capacity);
    k.m('wood', 0, 0, -front, benchLength, 1, 1, 0x765038);
  }
}

function kitHut(
  k: Kit,
  material: StructureMaterialKind = 'mixed',
  profile = EMPTY_STRUCTURE_PROFILE,
  seed = 0,
): void {
  const window = structureWindow(profile);
  for (let y = 0; y <= 1; y++) for (let x = -2; x <= 1; x++) for (let z = -2; z <= 1; z++) {
    const edge = x === -2 || x === 1 || z === -2 || z === 1;
    if (!edge) continue;
    if (z === 1 && x === 0 && y === 0) continue;                 // 门洞
    if (z === 1 && x === -1 && y === 1) {
      k.v(window.bucket, x, y, z, window.color);
      continue;
    }
    const corner = (x === -2 || x === 1) && (z === -2 || z === 1);
    if (material === 'stone') k.v('stone', x, y, z, structureStoneColor(x, y, z, 420 + Math.floor(seed * 31)));
    else if (material === 'wood') {
      const color = corner ? 0x5a3d26 : y % 2 === 0 ? 0x7a5636 : 0x6b4a2e;
      k.v('wood', x, y, z, jit(color, hash01(x + z * 7 + y, 421)));
    } else k.v(corner ? 'organicDark' : 'plaster', x, y, z,
      corner ? 0x6b4a2e : jit(0xb59a70, hash01(x + z * 7 + y, 422)));
  }
  k.v('wood', 0, 0, 1, 0x5f422a);                               // 门
  if (material === 'wood') {
    k.v('wood', -1, 0, 2, 0x7a5636);
    k.v('wood', 0, 0, 2, 0x7a5636);                              // 小门廊
  } else if (material === 'stone') k.v('stone', 0, 0, 2, 0x777872); // 门槛石
  const roofBucket: DecorBucket = material === 'mixed' ? 'thatch' : 'roofTile';
  const roofColor = material === 'stone' ? 0x4a4f58 : material === 'wood' ? 0x5a4030 : 0xd8b968;
  for (let l = 0; l < 3; l++) for (let x = -3 + l; x <= 2 - l; x++) for (let z = -3 + l; z <= 2 - l; z++)
    k.v(roofBucket, x, 2 + l, z, jit(roofColor, hash01(x * 3 + z + l, 423))); // 树皮瓦/石板/茅草顶
  addStructureEffectDetails(k, profile, 'hut');
}

function kitHouse(
  k: Kit,
  material: StructureMaterialKind = 'mixed',
  profile = EMPTY_STRUCTURE_PROFILE,
  seed = 0,
): void {
  const window = structureWindow(profile);
  if (material === 'wood') {
    // 素材库木屋：逐层圆木、门廊、山墙木瓦和石烟囱。
    const x0 = -4, x1 = 3, z0 = -3, z1 = 2;
    for (let y = 0; y <= 2; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const edge = x === x0 || x === x1 || z === z0 || z === z1;
      if (!edge) continue;
      if (z === z1 && x === 0 && y <= 1) continue;
      if (z === z1 && (x === -2 || x === 2) && y === 1) {
        k.v(window.bucket, x, y, z, window.color);
        continue;
      }
      if (z === z0 && x === -1 && y === 1) {
        k.v('dark', x, y, z, 0x3a2f26);
        continue;
      }
      const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
      const color = corner ? 0x5a3d26 : y % 2 === 0 ? 0x7a5636 : 0x6b4a2e;
      k.v('wood', x, y, z, jit(color, hash01(x * 11 + z * 5 + y, 430 + Math.floor(seed * 17))));
    }
    k.v('wood', 0, 0, z1, 0x4e3822); k.v('wood', 0, 1, z1, 0x4e3822);
    for (let x = -1; x <= 1; x += 1) k.v('wood', x, 0, z1 + 1, jit(0x7a5636, hash01(x, 431)));
    addStructureChimney(k, 2, -1, 3, 5, profile);
    for (let layer = 0; layer < 4; layer += 1) {
      const minZ = z0 - 1 + layer, maxZ = z1 + 1 - layer;
      for (let x = x0 - 1; x <= x1 + 1; x += 1) for (let z = minZ; z <= maxZ; z += 1) {
        if (x === 2 && z === -1) continue;
        k.v('roofTile', x, 3 + layer, z, jit(0x5a4030, hash01(x * 7 + z + layer, 432)));
      }
    }
    for (let x = x0 - 1; x <= x1 + 1; x += 1) k.v('organicDark', x, 7, 0, 0x4e3822);
  } else if (material === 'stone') {
    // 素材库石屋：厚重乱石墙、稀疏苔痕、窄窗和四坡石板顶。
    const x0 = -3, x1 = 3, z0 = -3, z1 = 2;
    for (let y = 0; y <= 3; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const edge = x === x0 || x === x1 || z === z0 || z === z1;
      if (!edge) continue;
      if (z === z1 && x === 0 && y <= 2) continue;
      if ((x === x0 || x === x1) && z === 0 && (y === 1 || y === 2)) {
        k.v(x === x1 ? window.bucket : 'dark', x, y, z, x === x1 ? window.color : 0x2c3844);
        continue;
      }
      if (z === z1 && (x === -2 || x === 2) && y === 2) {
        k.v(x === -2 ? window.bucket : 'dark', x, y, z, x === -2 ? window.color : 0x2c3844);
        continue;
      }
      k.v('stone', x, y, z, structureStoneColor(x, y, z, 440 + Math.floor(seed * 23)));
    }
    k.v('wood', 0, 0, z1, 0x5f422a); k.v('wood', 0, 1, z1, 0x5f422a);
    k.v('stone', 0, 0, z1 + 1, 0x777872);
    for (let layer = 0; layer < 4; layer += 1) {
      const minX = x0 - 1 + layer, maxX = x1 + 1 - layer;
      const minZ = z0 - 1 + layer, maxZ = z1 + 1 - layer;
      for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1)
        k.v('roofTile', x, 4 + layer, z, jit(0x4a4f58, hash01(x * 5 + z * 3 + layer, 441)));
    }
  } else {
    // 混合材质保留木骨架与灰泥填充，和纯木、纯石住所形成第三种轮廓。
    for (let y = 0; y <= 2; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
      const edge = x === -2 || x === 2 || z === -2 || z === 2;
      if (!edge) continue;
      if (z === 2 && x === 0 && y <= 1) continue;
      if (z === 2 && x === -1 && y === 1) {
        k.v(window.bucket, x, y, z, window.color);
        continue;
      }
      const corner = (x === -2 || x === 2) && (z === -2 || z === 2);
      const beam = corner || y === 0 || y === 2 || ((z === -2 || z === 2) && x % 2 === 0);
      k.v(beam ? 'organicDark' : 'plaster', x, y, z,
        beam ? 0x4a3626 : jit(0xe8e2d4, hash01(x + z + y, 450)));
    }
    k.v('wood', 0, 0, 2, 0x5f422a); k.v('wood', 0, 1, 2, 0x5f422a);
    for (let layer = 0; layer < 3; layer += 1) for (let x = -3; x <= 3; x += 1)
      for (let z = -3 + layer; z <= 2 - layer; z += 1)
        k.v('roofTile', x, 3 + layer, z, jit(0x7a4a3a, hash01(x + z + layer, 451)));
  }
  addStructureEffectDetails(k, profile, 'house');
}

/**
 * 农耕定居时代住宅：与素材网站同构的宽体木骨灰泥房、高坡茅草顶、门廊和侧棚。
 * 轮廓由文明观察阶段选择，窗光、炊烟和基础材质仍读取真实结构事实。
 */
function kitAgrarianHouse(
  k: Kit,
  material: StructureMaterialKind,
  profile: StructureVisualProfile,
  seed = 0,
): void {
  const window = structureWindow(profile);
  const x0 = -6, x1 = 5, z0 = -4, z1 = 3, height = 6;
  const color = (hex: number, x: number, y: number, z: number, salt: number): number =>
    jit(hex, hash01(x * 31 + y * 17 + z * 13 + Math.floor(seed * 97), salt));
  const foundationBucket: DecorBucket = material === 'wood' ? 'organicDark' : 'stone';
  const foundationColor = material === 'wood' ? 0x543a28 : 0x817b70;

  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    if (x === x0 || x === x1 || z === z0 || z === z1)
      k.v(foundationBucket, x, 0, z, color(foundationColor, x, 0, z, 471));
  }

  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = 1; y <= height; y++) {
    const edge = x === x0 || x === x1 || z === z0 || z === z1;
    if (!edge) continue;
    const front = z === z1;
    const side = x === x0 || x === x1;
    const door = front && (x === -1 || x === 0) && y <= 3;
    const frontWindow = front && (x === -4 || x === 3) && (y === 2 || y === 3);
    const sideWindow = side && (z === -1 || z === 1) && (y === 2 || y === 3);
    if (door || frontWindow || sideWindow) continue;
    const post = ((x === x0 || x === x1) && (z === z0 || z === z1))
      || (front && [-6, -3, 2, 5].includes(x))
      || (z === z0 && [-6, -3, 0, 3, 5].includes(x));
    const beam = y === 1 || y === height;
    if (material === 'stone' && !post && !beam)
      k.v('stone', x, y, z, structureStoneColor(x, y, z, 472 + Math.floor(seed * 19)));
    else k.v(post || beam ? 'organicDark' : 'plaster', x, y, z,
      color(post || beam ? 0x5b402b : 0xc7b58f, x, y, z, 473));
  }

  for (let x = -1; x <= 0; x++) for (let y = 1; y <= 3; y++)
    k.v('organicDark', x, y, z1, color(0x4e3822, x, y, z1, 474));
  for (let x = x0; x <= x1; x++) k.v('organicDark', x, height - 1, z1, color(0x62462f, x, height, z1, 475));
  for (const x of [-4, 3]) for (const y of [2, 3]) k.v(window.bucket, x, y, z1, window.color);
  for (const x of [x0, x1]) for (const z of [-1, 1]) for (const y of [2, 3])
    k.v('dark', x, y, z, 0x2c3844);

  for (let x = -2; x <= 1; x++) for (let z = z1 + 1; z <= z1 + 2; z++)
    k.v('stone', x, 0, z, color(0x8a857b, x, 0, z, 476));
  for (let y = 1; y <= 4; y++) {
    k.v('wood', -2, y, z1 + 2, color(0x68482e, -2, y, z1 + 2, 477));
    k.v('wood', 1, y, z1 + 2, color(0x68482e, 1, y, z1 + 2, 477));
  }
  for (let x = -3; x <= 2; x++) for (let z = z1; z <= z1 + 3; z++)
    k.v('thatch', x, 5, z, color(0xc99f4e, x, 5, z, 478));

  const shedX0 = x1 + 1, shedX1 = x1 + 4, shedZ0 = -2, shedZ1 = 2;
  for (let x = shedX0; x <= shedX1; x++) for (let z = shedZ0; z <= shedZ1; z++) for (let y = 0; y <= 2; y++) {
    const edge = x === shedX0 || x === shedX1 || z === shedZ0 || z === shedZ1;
    if (!edge || (z === shedZ1 && x >= shedX0 + 1 && x <= shedX1 - 1 && y <= 1)) continue;
    const frame = x === shedX0 || x === shedX1 || ((z === shedZ0 || z === shedZ1) && y === 2);
    k.v(frame ? 'organicDark' : 'wood', x, y, z,
      color(frame ? 0x543a28 : 0x82603c, x, y, z, 479));
  }
  for (let layer = 0; layer < 3; layer++) {
    for (let x = shedX0 - 1 + layer; x <= shedX1 + 1 - layer; x++)
      for (let z = shedZ0 - 1 + layer; z <= shedZ1 + 1 - layer; z++)
        k.v('thatch', x, 3 + layer, z, color(0xb98d43, x, 3 + layer, z, 480));
  }
  for (let x = shedX0 + 1; x <= shedX1; x++)
    k.v('wood', x, 0, shedZ0 + 1, color(0x91683d, x, 0, shedZ0 + 1, 481));

  addStructureChimney(k, 3, -1, height + 1, 5, profile);
  for (let layer = 0; layer < 5; layer++) {
    const minZ = z0 - 1 + layer;
    const maxZ = z1 + 1 - layer;
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = minZ; z <= maxZ; z++) {
      if (x === 3 && z === -1) continue;
      k.v('thatch', x, height + 1 + layer, z, color(0xd0aa58, x, height + 1 + layer, z, 482));
    }
  }
  for (let x = x0 - 1; x <= x1 + 1; x++)
    for (const z of [-1, 0]) k.v('organicDark', x, height + 5, z, color(0x5b402b, x, height + 5, z, 483));
  addStructureEffectDetails(k, profile, 'hall');
}

/** 古代文明住宅：台基、红柱、槛窗、斗拱与翘角灰瓦顶。 */
function kitAncientHouse(
  k: Kit,
  material: StructureMaterialKind,
  profile: StructureVisualProfile,
  seed = 0,
): void {
  const x0 = -4, x1 = 4, z0 = -3, z1 = 3;
  const window = structureWindow(profile);
  const color = (hex: number, x: number, y: number, z: number, salt: number): number =>
    jit(hex, hash01(x * 29 + y * 19 + z * 11 + Math.floor(seed * 101), salt));
  const foundationBucket: DecorBucket = material === 'wood' ? 'organicDark' : 'stone';
  const foundationColor = material === 'wood' ? 0x5a4430 : 0x92979d;

  for (let x = x0 - 2; x <= x1 + 2; x++) for (let z = z0 - 2; z <= z1 + 2; z++)
    k.v(foundationBucket, x, 0, z, color(
      x === x0 - 2 || x === x1 + 2 || z === z0 - 2 || z === z1 + 2 ? foundationColor : 0xa2a7ac,
      x, 0, z, 491,
    ));
  for (let x = -1; x <= 1; x++) k.v('stone', x, 0, z1 + 3, color(0x8b9096, x, 0, z1 + 3, 492));

  const isColumn = (x: number, z: number): boolean => (
    ((z === z0 || z === z1) && (x - x0) % 2 === 0 && x !== 0)
    || ((x === x0 || x === x1) && (z - z0) % 2 === 0)
  );
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = 1; y <= 4; y++) {
    const edge = x === x0 || x === x1 || z === z0 || z === z1;
    if (!edge) continue;
    if (z === z1 && (x === -1 || x === 0)) continue;
    if (isColumn(x, z)) {
      k.v('accent', x, y, z, color(0xa63a2e, x, y, z, 493));
      continue;
    }
    if ((z === z0 || z === z1) && (y === 2 || y === 3) && x % 2 !== 0) {
      k.v(window.bucket, x, y, z, window.color);
      continue;
    }
    const lower = y === 1;
    if (material === 'stone' && !lower) k.v('stone', x, y, z, structureStoneColor(x, y, z, 494));
    else k.v(lower ? 'wood' : 'plaster', x, y, z,
      color(lower ? 0x7a5a3a : 0xefe9dc, x, y, z, 495));
  }
  for (let x = -1; x <= 0; x++) for (let y = 1; y <= 3; y++)
    k.v('organicDark', x, y, z1, color(0x6e2a20, x, y, z1, 496));
  for (const x of [-1, 0]) k.v(window.bucket, x, 4, z1, window.color);

  for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
    if (x === x0 - 1 || x === x1 + 1 || z === z0 - 1 || z === z1 + 1)
      k.v('organicDark', x, 5, z, color(0x4e3822, x, 5, z, 497));
  }
  const roofLayers = [[6, 5, 6], [5, 4, 7], [4, 3, 8], [2, 1, 9]] as const;
  for (const [halfX, halfZ, y] of roofLayers) {
    for (let x = -halfX; x <= halfX; x++) for (let z = -halfZ; z <= halfZ; z++) {
      const edge = x === -halfX || x === halfX || z === -halfZ || z === halfZ;
      k.v('roofTile', x, y, z, color(edge ? 0x464c54 : 0x5a6068, x, y, z, 498));
    }
    if (halfX >= 5) for (const sideX of [-1, 1]) for (const sideZ of [-1, 1])
      k.v('roofTile', sideX * halfX, y + 1, sideZ * halfZ, color(0x464c54, sideX, y, sideZ, 499));
  }
  for (let x = -2; x <= 2; x++) k.v('roofTile', x, 10, 0, color(0x3a4048, x, 10, 0, 500));
  k.v('roofTile', -2, 11, 0, 0x33383f); k.v('roofTile', 2, 11, 0, 0x33383f);
  for (const x of [-3, 3]) for (const z of [z0 - 2, z1 + 2])
    k.v('glowRed', x, 5, z, 0xff6a55);
}

/** 古代文明的西方中世纪风住宅：下层石墙、外挑木骨上层、陡坡瓦顶与穿顶烟囱。 */
function kitMedievalHouse(
  k: Kit,
  material: StructureMaterialKind,
  profile: StructureVisualProfile,
  seed = 0,
): void {
  const x0 = -4, x1 = 4, z0 = -3, z1 = 3;
  const window = structureWindow(profile);
  const color = (hex: number, x: number, y: number, z: number, salt: number): number =>
    jit(hex, hash01(x * 37 + y * 13 + z * 23 + Math.floor(seed * 107), salt));
  const lowerBucket: DecorBucket = material === 'wood' ? 'wood' : 'stone';
  const lowerColor = material === 'wood' ? 0x765033 : 0x9a958c;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = 0; y <= 2; y++) {
    const edge = x === x0 || x === x1 || z === z0 || z === z1;
    if (!edge) continue;
    if (z === z1 && x === 0 && y <= 1) continue;
    if (z === z1 && (x === -2 || x === 2) && y === 1) continue;
    k.v(lowerBucket, x, y, z, lowerBucket === 'stone'
      ? structureStoneColor(x, y, z, 501 + Math.floor(seed * 31))
      : color(lowerColor, x, y, z, 501));
  }
  for (let y = 0; y <= 1; y++) k.v('wood', 0, y, z1, color(0x5f422a, 0, y, z1, 502));
  k.v('dark', -2, 1, z1, 0x33404e); k.v(window.bucket, 2, 1, z1, window.color);

  const upperX0 = -5, upperX1 = 5, upperZ0 = -4, upperZ1 = 4;
  for (let x = upperX0; x <= upperX1; x++) for (let z = upperZ0; z <= upperZ1; z++) for (let y = 3; y <= 5; y++) {
    const edge = x === upperX0 || x === upperX1 || z === upperZ0 || z === upperZ1;
    if (!edge) continue;
    const windowOpening = (z === upperZ1 || z === upperZ0) && [-2, 0, 2].includes(x) && y === 4;
    if (windowOpening) continue;
    const corner = (x === upperX0 || x === upperX1) && (z === upperZ0 || z === upperZ1);
    const beam = y === 3 || y === 5;
    const stud = (z === upperZ0 || z === upperZ1) && (x + upperX0) % 2 === 0;
    k.v(corner || beam || stud ? 'organicDark' : 'plaster', x, y, z,
      color(corner || beam || stud ? 0x4a3626 : 0xe8e2d4, x, y, z, 503));
  }
  k.v(window.bucket, 0, 4, upperZ1, window.color);
  for (const x of [-2, 2]) k.v('dark', x, 4, upperZ1, 0x33404e);
  for (const x of [-2, 0, 2]) k.v('dark', x, 4, upperZ0, 0x33404e);

  addStructureChimney(k, 4, -1, 6, 5, profile);
  for (let layer = 0; layer < 5; layer++) {
    const minZ = upperZ0 - 1 + layer;
    const maxZ = upperZ1 + 1 - layer;
    for (let x = upperX0 - 1; x <= upperX1 + 1; x++) for (let z = minZ; z <= maxZ; z++) {
      if (x === 4 && z === -1) continue;
      k.v('roofTile', x, 6 + layer, z, color(0x7a4a3a, x, 6 + layer, z, 504));
    }
  }
  for (let x = upperX0 - 1; x <= upperX1 + 1; x++)
    k.v('roofTile', x, 11, 0, color(0x5e382c, x, 11, 0, 505));
}

function kitHall(
  k: Kit,
  material: StructureMaterialKind = 'stone',
  profile = EMPTY_STRUCTURE_PROFILE,
  seed = 0,
): void {
  const window = structureWindow(profile);
  for (let y = 0; y <= 3; y++) for (let x = -3; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const edge = x === -3 || x === 2 || z === -2 || z === 2;
    if (!edge) continue;
    if (z === 2 && x === 0 && y <= 1) continue;
    if ((z === 2 || z === -2) && y === 2 && x % 2 === 0) {
      k.v(window.bucket, x, y, z, window.color);
      continue;
    }
    const corner = (x === -3 || x === 2) && (z === -2 || z === 2);
    if (material === 'stone') k.v('stone', x, y, z, structureStoneColor(x, y, z, 460 + Math.floor(seed * 29)));
    else if (material === 'wood') {
      const color = corner ? 0x5a3d26 : y % 2 === 0 ? 0x8f633d : 0x765033;
      k.v('wood', x, y, z, jit(color, hash01(x * 3 + z + y, 461)));
    } else {
      const beam = corner || y === 0 || y === 3 || ((z === -2 || z === 2) && x % 2 === 0);
      k.v(beam ? 'organicDark' : 'plaster', x, y, z,
        beam ? 0x4a3626 : jit(0xd9d1c1, hash01(x * 3 + z + y, 462)));
    }
  }
  k.v('wood', 0, 0, 2, 0x4e3822); k.v('wood', 0, 1, 2, 0x4e3822);
  if (material === 'stone') {
    for (const x of [-3, 2]) for (const z of [-2, 2]) k.v('stone', x, 0, z, 0x73736f); // 厚墙扶壁
  } else if (material === 'wood') {
    for (let x = -2; x <= 1; x += 1) k.v('wood', x, 0, 3, jit(0x7a5636, hash01(x, 463))); // 长门廊
    addStructureChimney(k, 2, -1, 4, 4, profile);
  }
  const roofBucket: DecorBucket = material === 'wood' ? 'thatch' : 'roofTile';
  const roofColor = material === 'wood' ? 0x9d743f : material === 'stone' ? 0x4a4f58 : 0x6f4437;
  for (let l = 0; l < 3; l++) for (let x = -4 + l; x <= 3 - l; x++) for (let z = -3 + l; z <= 2 - l; z++)
    k.v(roofBucket, x, 4 + l, z, jit(roofColor, hash01(x + z + l, 464)));
  addStructureEffectDetails(k, profile, 'hall');
}

type ConstructionMaterialKind = 'wood' | 'stone';

/**
 * 未完成住所的施工印章。它不伪造一栋完成房屋，只把权威构件数量翻译为
 * 可辨认的备料、地梁、立柱和局部墙面，避免施工期退化成整格实心柱。
 */
function kitConstructionSite(k: Kit, r: number, material: ConstructionMaterialKind, componentCount: number): void {
  const structuralBucket: DecorBucket = material === 'stone' ? 'stone' : 'wood';
  const primary = material === 'stone' ? 0x85827c : 0x9b6f41;
  const secondary = material === 'stone' ? 0x6f6c66 : 0x765033;

  // 已运到现场的材料与两处基脚；一块权威构件也不会再显示成整格墙柱。
  k.m(structuralBucket, -2.4, 0, -2.3, 2, 1, 2, jit(primary, r));
  k.m(structuralBucket, 2.2, 0, 2.1, 2, 1, 2, jit(secondary, hash01(componentCount, 71)));
  k.m('wood', 2.7, 0, -2.2, 3, 1, 1, jit(0x7d5838, r));

  if (componentCount < 2) return;

  // 第二步开始形成地梁与立柱，轮廓保持通透，明确表达“正在施工”。
  k.m(structuralBucket, 0, 0, -3, 6, 1, 1, jit(primary, hash01(componentCount, 72)));
  k.m(structuralBucket, -3, 0, 0, 1, 1, 6, jit(primary, hash01(componentCount, 73)));
  k.m('wood', -2.6, 1, -2.6, 1, 5, 1, jit(0x765033, r));
  k.m('wood', 2.6, 1, -2.6, 1, 5, 1, jit(0x765033, hash01(componentCount, 74)));
  k.m('wood', 0, 5.4, -2.6, 6, 1, 1, jit(0x68462e, hash01(componentCount, 75)));

  if (componentCount < 3) return;

  // 较长时间仍未闭合的结构增加局部墙面和另一侧脚手架，但保留明显缺口。
  for (let x = -1; x <= 1; x += 1) {
    k.m(structuralBucket, x * 1.6, 1, -2.7, 1, 3, 1, jit(primary, hash01(x + componentCount, 76)));
  }
  k.m('wood', -2.6, 1, 2.5, 1, 4, 1, jit(0x765033, hash01(componentCount, 77)));
  k.m('wood', -2.6, 4.5, 0, 1, 1, 5, jit(0x68462e, hash01(componentCount, 78)));

  if (componentCount < 5) return;

  // 更高进度只补齐另一侧立柱与屋架，仍保留敞开的墙面和裸露脚手架。
  k.m('wood', 2.6, 1, 2.5, 1, 5, 1, jit(0x765033, hash01(componentCount, 79)));
  k.m('wood', 0, 5.5, 2.5, 6, 1, 1, jit(0x68462e, hash01(componentCount, 80)));
  k.m('wood', 0, 7, 0, 1, 1, 7, jit(0x68462e, hash01(componentCount, 81)));
  for (const x of [-2, 0, 2]) {
    k.m('wood', x, 6, 0, 1, 1, 7, jit(0x765033, hash01(x + componentCount, 82)));
  }

  if (componentCount < 8) return;

  // 接近完成时出现局部屋面，但绝不闭合成可入住的完成建筑。
  for (let z = -2; z <= 0; z += 1) {
    k.m(material === 'stone' ? 'roofTile' : 'thatch', -1.7, 7.5 + (z + 2) * 0.45, z, 4, 1, 1,
      jit(material === 'stone' ? 0x686b70 : 0xb99255, hash01(z + componentCount, 83)));
  }
}

interface FacilityVisualState {
  active: boolean;
  fillRatio: number;
}

type ElectricalNetworkDecorView = NonNullable<SocietyState['electricalPower']>['networks'][number];
type ElectricalComponentDecorView = ElectricalNetworkDecorView['components'][number];

/**
 * 钢制传动轴的标准接口沿 Kit 的局部 X 轴；rot=1/3 时由 Kit 统一转为世界 Z 轴。
 * 只有已提交机械作业把该格标记 active 后，钢轴、飞轮和联轴节才复用真实机械转动。
 */
function kitSteelDriveShaft(k: Kit, r: number, state: FacilityVisualState): void {
  const animation = state.active ? 'wheel-spin' as const : undefined;
  for (const x of [-4.5, 4.5]) {
    k.m('stone', x, 0, 0, 2.2, 2, 4.2, jit(0x716e68, hash01(x, 331)));
    k.m('dark', x, 2, 0, 1.6, 2.5, 2.2, jit(0x444b4e, r));
  }
  k.m('dark', 0, 3.48, 0, 11.5, 1.05, 1.05, jit(0x767e82, r), 'steel-shaft', animation);
  for (const x of [-3.4, 3.4])
    k.m('dark', x, 3.25, 0, 1.1, 1.5, 1.5, 0x596064, 'steel-shaft-collar', animation);
  k.m('dark', 6, 3.12, 0, 1.8, 1.75, 1.75, 0x8a9397, 'steel-shaft-coupling', animation);
  k.m('dark', 6, 4.87, 0, 0.32, 0.55, 0.32, 0x303638, 'steel-shaft-pin', animation);
  for (let index = 0; index < 12; index += 1) {
    const angle = index * Math.PI / 6;
    k.m('dark', -1.4, 3.5 + Math.cos(angle) * 2.65, Math.sin(angle) * 2.65,
      1, 1, 1, jit(0x555d60, hash01(index, 332)), 'steel-shaft-flywheel', animation);
  }
  k.m('dark', -1.4, 1.3, 0, 0.7, 5.4, 0.7, 0x596064, 'steel-shaft-spoke', animation);
  k.m('dark', -1.4, 3.65, -2.2, 0.7, 0.7, 4.4, 0x596064, 'steel-shaft-spoke', animation);
}

/** 等臂秤保持中性静态读数；装饰层不根据随机数制造称量结果。 */
function kitBeamBalance(k: Kit, r: number): void {
  k.m('organicDark', 0, 0, 0, 9, 1.1, 5.5, 0x563c2a);
  k.m('wood', 0, 1.1, 0, 6.8, 0.65, 3.7, jit(0x88603a, r));
  k.m('organicDark', 0, 1.75, 0, 1.25, 6.2, 1.25, 0x67482f);
  k.m('dark', 0, 7.95, 0, 1.25, 1, 2.1, 0x8e6f43);
  k.m('wood', 0, 8.4, 0, 12.2, 0.72, 0.72, jit(0x92704a, r));
  k.m('dark', 0, 7.75, 0.52, 0.34, 1.35, 0.34, 0x555a5d);
  for (const x of [-5.4, 5.4]) {
    k.m('dark', x, 7.15, 0, 0.24, 2.45, 0.24, 0x6a6d6e);
    k.m('dark', x, 5, 0, 3.8, 0.35, 3.4, 0x777a7b);
    k.m('dark', x, 5.35, 0, 3, 0.22, 2.6, 0x9b8768);
  }
  k.m('accent', 0, 6.3, 0.78, 0.28, 1.65, 0.24, 0xad7042);
}

/** 不同尺寸、带吊环和稳定刻痕的标准秤砣组。 */
function kitStandardWeights(k: Kit, r: number): void {
  const specs = [[-2.6, 3.4, 2.3], [1, 2.8, 1.9], [3.7, 2, 1.4]] as const;
  specs.forEach(([x, width, height], index) => {
    k.m('dark', x, 0, 0, width, 0.65, width, 0x5f6364);
    k.m('dark', x, 0.65, 0, width * 0.78, height, width * 0.78,
      jit(0x686c6d, hash01(index, 333) * 0.7 + r * 0.3));
    k.m('dark', x, 0.65 + height, 0, width * 0.42, 0.45, width * 0.42, 0x858b8d);
    k.m('dark', x - 0.36, 1 + height, 0, 0.28, 0.95, 0.34, 0x4e5253);
    k.m('dark', x + 0.36, 1 + height, 0, 0.28, 0.95, 0.34, 0x4e5253);
    k.m('dark', x, 1.78 + height, 0, 1, 0.25, 0.34, 0x4e5253);
    for (let tick = 0; tick <= index; tick += 1)
      k.m('groundMark', x - 0.28 + tick * 0.28, 0.74 + height, width * 0.4 + 0.04,
        0.14, 0.1, 0.08, 0xd4c49f);
  });
}

/** 局部 X 轴左端接机械轴，右上双端子接首段导体；只有真实供电事实才转动、发光。 */
function kitMechanicalDynamo(k: Kit, r: number, state?: FacilityVisualState): void {
  const active = state?.active === true;
  const animation = active ? 'wheel-spin' as const : undefined;
  k.m('dark', 0, 0, 0, 10, 1, 6.5, 0x42494c);
  for (const x of [-3.6, 3.6]) k.m('dark', x, 1, 0, 1, 5.5, 5.4, jit(0x535c60, hash01(x, 334)));
  k.m('dark', 0, 1.25, 0, 6.7, 4.9, 4.8, jit(0x596a70, r));
  for (const x of [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5])
    k.m(active ? 'glowWarm' : 'dark', x, 1.62, 2.48, 0.56, 4, 0.28,
      jit(active ? 0xf0a44f : 0xc26e3f, hash01(Math.round(x * 10), 335)));
  k.m('dark', 0, 3.15, 0, 12, 0.85, 0.85, 0x3f474a, 'dynamo-rotor', animation);
  for (let index = 0; index < 12; index += 1) {
    const angle = index * Math.PI / 6;
    k.m('dark', -5.2, 3.15 + Math.cos(angle) * 2.2, Math.sin(angle) * 2.2,
      0.75, 0.78, 0.78, 0x596164, 'dynamo-rotor', animation);
  }
  for (const z of [-1.35, 1.35]) {
    k.m('plaster', 2.9, 6.15, z, 1, 0.85, 1, 0xd2c7ad);
    k.m(active ? 'glowWarm' : 'dark', 2.9, 7, z, 0.42, 0.65, 0.42,
      active ? 0xffc165 : 0xb96a3c);
  }
}

/**
 * 一段直线绝缘铜导体，局部 X 轴是连接方向；rot=1/3 时沿世界 Z 轴。
 * 转角和竖直段必须由权威电力计划另行选择，不能在这里从地表相邻随机猜测。
 */
function kitCopperConductor(k: Kit, r: number, broken: boolean, active = false): void {
  if (broken) {
    k.m('dark', -3.85, 3.45, 0, 5.2, 0.5, 0.5, jit(0x76513d, r));
    k.m('dark', 3.85, 3.45, 0, 5.2, 0.5, 0.5, jit(0x76513d, hash01(1, 336)));
    k.m('organicDark', -3.1, 3.25, 0, 3.9, 0.92, 0.92, 0x3f3935);
    k.m('organicDark', 3.1, 3.25, 0, 3.9, 0.92, 0.92, 0x3f3935);
    k.m('groundMark', -0.62, 3.1, 0, 0.48, 0.58, 0.72, 0x242322);
    k.m('groundMark', 0.62, 3.1, 0, 0.48, 0.58, 0.72, 0x242322);
  } else {
    k.m(active ? 'glowWarm' : 'dark', 0, 3.45, 0, 13, 0.5, 0.5,
      jit(active ? 0xf0a04f : 0xb56037, r));
    k.m('organicDark', 0, 3.25, 0, 9.8, 0.92, 0.92, 0x584b43);
  }
  for (const x of [-5.3, 0, 5.3]) {
    k.m('stone', x, 0, 0, 2.2, 0.72, 3.1, jit(0x77746e, hash01(Math.round(x * 10), 337)));
    k.m('plaster', x, 0.72, 0, 1.45, 2.15, 1.45, 0xd7cdb7);
    k.m('dark', x, 2.87, 0, 0.52, 0.72, 0.52, 0x55595b);
  }
  for (const x of [-6.75, 6.75]) k.m(active && !broken ? 'glowWarm' : 'dark', x, 3.1, 0, 1.2, 1.15, 1.15,
    active && !broken ? 0xffbb62 : 0xc37543);
}

type ElectricalPlanDirection = 'east' | 'west' | 'north' | 'south' | 'up' | 'down';

/** 按冻结计划的前后节点生成直线、转角与竖直段；每个方向只延伸到本体素边界。 */
function kitPlannedCopperConductor(
  k: Kit,
  r: number,
  broken: boolean,
  active: boolean,
  directions: readonly ElectricalPlanDirection[],
  faultNow: boolean,
): void {
  k.m('stone', 0, 0, 0, 2.7, 0.72, 3.2, jit(0x77746e, r));
  k.m('plaster', 0, 0.72, 0, 1.6, 2.15, 1.6, 0xd7cdb7);
  k.m('dark', 0, 2.87, 0, 0.58, 0.62, 0.58, 0x55595b);
  const wireBucket: DecorBucket = active && !broken ? 'glowWarm' : 'dark';
  const wireColor = active && !broken ? 0xffb45a : broken ? 0x6f4938 : 0xb56037;
  const appendHorizontal = (axis: 'x' | 'z', sign: -1 | 1) => {
    const length = broken ? 3.1 : 4.45;
    const center = sign * (broken ? 2.75 : 2.15);
    k.m('organicDark', axis === 'x' ? center : 0, 3.17, axis === 'z' ? center : 0,
      axis === 'x' ? length : 0.94, 0.92, axis === 'z' ? length : 0.94, 0x584b43);
    k.m(wireBucket, axis === 'x' ? center : 0, 3.45, axis === 'z' ? center : 0,
      axis === 'x' ? length : 0.5, 0.5, axis === 'z' ? length : 0.5, jit(wireColor, r));
  };
  const appendVertical = (up: boolean) => {
    const bottom = broken ? (up ? 4.4 : -0.5) : (up ? 3.3 : -0.75);
    const length = broken ? 3.45 : 4.35;
    k.m('organicDark', 0, bottom, 0, 0.94, length, 0.94, 0x584b43);
    k.m(wireBucket, 0, bottom, 0, 0.5, length, 0.5, jit(wireColor, r));
  };
  const resolved = directions.length ? [...new Set(directions)] : ['east', 'west'] as ElectricalPlanDirection[];
  for (const direction of resolved) {
    if (direction === 'east') appendHorizontal('x', 1);
    else if (direction === 'west') appendHorizontal('x', -1);
    else if (direction === 'south') appendHorizontal('z', 1);
    else if (direction === 'north') appendHorizontal('z', -1);
    else appendVertical(direction === 'up');
  }
  if (!broken) {
    k.m(wireBucket, 0, 3.18, 0, 1.05, 1.05, 1.05, wireColor);
  } else {
    for (const direction of resolved.slice(0, 2)) {
      const x = direction === 'east' ? 0.72 : direction === 'west' ? -0.72 : 0;
      const z = direction === 'south' ? 0.72 : direction === 'north' ? -0.72 : 0;
      const y = direction === 'up' ? 4.08 : direction === 'down' ? 2.55 : 3.18;
      k.m('groundMark', x, y, z, 0.48, 0.58, 0.48, 0x242322);
    }
  }
  if (faultNow) {
    k.m('glowWarm', -0.3, 3.72, 0.1, 0.24, 0.24, 0.24, 0xffc25f, 'fire-spark', 'fire');
    k.m('glowWarm', 0.34, 3.45, -0.18, 0.18, 0.18, 0.18, 0xff8a3d, 'fire-spark', 'fire');
  }
}

/** 耐火砖基座和蛇形电阻带；只有真实交付电能的当前事实才升为暖色。 */
function kitResistiveLoad(k: Kit, r: number, state?: FacilityVisualState): void {
  const active = state?.active === true;
  k.m('stone', 0, 0, 0, 9.5, 1, 5, jit(0x69655e, r));
  for (const x of [-3.6, 3.6]) {
    k.m('dark', x, 1, 0, 0.75, 6, 0.75, 0x4f5557);
    k.m('plaster', x, 6.9, 0, 1.25, 0.9, 1.25, 0xd4cab4);
    k.m('dark', x, 7.8, 0, 0.42, 0.8, 0.42, 0xad6a3e);
  }
  k.m('dark', 0, 6, 0, 7.5, 0.65, 0.65, 0x555b5e);
  const points = [[-3.1, 5.4], [2.6, 4.55], [-2.6, 3.7], [2.6, 2.85], [-3.1, 2]] as const;
  points.forEach(([x, y], index) => k.m(active ? 'glowWarm' : 'dark', x, y, 2.55,
    index % 2 ? 5.4 : 5, 0.34, 0.3, active ? 0xffa74e : 0xc18a50));
  for (let index = 0; index < points.length - 1; index += 1) {
    const x = points[index][0] > 0 ? 2.6 : -2.6;
    k.m(active ? 'glowWarm' : 'dark', x, points[index + 1][1] + 0.28, 2.55,
      0.34, 0.92, 0.3, active ? 0xff9647 : 0xaa7544);
  }
  k.m('roofTile', 0, 1.1, -1.7, 6.8, 3.6, 1.1, 0x895142);
}

function kitCouncilHearth(k: Kit, r: number, state: FacilityVisualState): void {
  const ring = [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]] as const;
  ring.forEach(([x, z], index) => k.m('stone', x, 0, z, 2, 1, 2, jit(0x746b5f, hash01(index, 231))));
  k.m('wood', 0, 0, -4, 6, 1, 1, jit(0x765038, r));
  k.m('wood', -4, 0, 1, 1, 1, 5, jit(0x765038, hash01(1, 232)));
  k.m('wood', 4, 0, 1, 1, 1, 5, jit(0x765038, hash01(2, 232)));
  if (state.active) {
    k.m('glowRed', 0, 0.4, 0, 2, 2, 2, 0xe55b35, 'fire-core', 'fire');
    k.m('glowWarm', 0.4, 2, 0, 1, 4, 1, 0xffa33f, 'fire-mid', 'fire');
    k.m('glowWarm', -0.25, 5, 0.15, 1, 2, 1, 0xffd27a, 'fire-tip', 'fire');
  } else k.m('organicDark', 0, 0.2, 0, 2, 1, 2, 0x49372b);
}

function kitWorkshop(k: Kit, r: number, state: FacilityVisualState, hot: 'none' | 'bronze' | 'iron' = 'none'): void {
  for (const [x, z] of [[-3, -2], [3, -2], [-3, 2], [3, 2]] as const)
    k.m('organicDark', x, 0, z, 1, 6, 1, jit(0x54402a, r));
  k.m('wood', 0, 6, 0, 9, 1, 7, jit(0x6e4f33, r));
  k.m('organicDark', 0, 6.7, -3, 9, 1, 1, 0x4e3822);
  k.m('wood', -2.5, 0.8, 0.7, 3, 2, 3, jit(0x8a6a48, r));
  k.m('dark', -0.8, 2.5, 0.5, 3, 1, 2, hot === 'bronze' ? 0xa36c38 : 0x454a50);
  k.m('stone', 2.2, 0, -1.8, 3, 3, 3, jit(hot === 'none' ? 0x7d8288 : 0x845747, r));
  if (state.active) {
    k.m('glowRed', 1.6, 0.7, -2.2, 2, 2, 1, 0xf05232, 'fire-core', 'fire');
    k.m('glowWarm', 2.1, 2.1, -1.9, 1, 2, 1, 0xffa33f, 'fire-mid', 'fire');
    if (hot !== 'none') {
      k.m('plaster', 2.4, 6.8, -1.8, 2, 2, 2, 0xa6a39e, 'facility-smoke', 'facility-smoke');
      k.m('plaster', 3.1, 8.8, -1.7, 2, 2, 2, 0xc1bdb6, 'facility-smoke', 'facility-smoke');
    }
  }
}

function kitGranary(k: Kit, r: number, state: FacilityVisualState): void {
  for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const)
    k.m('organicDark', x, 0, z, 1, 3, 1, jit(0x54402a, r));
  k.m('wood', 0, 3, 0, 7, 1, 5, jit(0x8a6a48, r));
  for (const x of [-3, 3]) k.m('wood', x, 4, 0, 1, 5, 5, jit(0xa8815a, hash01(x, 241)));
  k.m('wood', 0, 4, -2, 5, 5, 1, jit(0xa8815a, r));
  k.m('wood', 0, 6, 2, 5, 1, 1, jit(0xa8815a, hash01(2, 241)));
  k.m('organicDark', 0, 4, 2.2, 2, 2, 1, 0x54402a);
  // 素材原型的高脚木梯；它只解释如何抵达仓门，不形成新的可通行规则。
  k.m('organicDark', -0.9, 0, 3, 1, 4, 1, 0x68472f);
  k.m('organicDark', 0.9, 0, 3, 1, 4, 1, 0x68472f);
  for (const y of [0.6, 1.7, 2.8]) k.m('wood', 0, y, 3, 3, 0.5, 1, jit(0x8a6a48, hash01(y * 10, 242)));
  for (let layer = 0; layer < 3; layer += 1)
    k.m('thatch', 0, 9 + layer, 0, 9 - layer * 2, 1, 7 - layer * 2, jit(0xd0ae63, hash01(layer, 243)));
  const visibleStores = Math.min(4, Math.ceil(state.fillRatio * 4));
  for (let index = 0; index < visibleStores; index += 1) {
    const x = index % 2 === 0 ? -1.1 : 1.1;
    const y = index < 2 ? 4.2 : 5.5;
    k.m('thatch', x, y, 2.55, 2, 1, 1, jit(0xc2a46b, hash01(index, 244)));
  }
  if (state.active) k.m('glowWarm', -2.6, 5.5, 0, 1, 2, 1, 0xffc37a);
}

function kitCistern(k: Kit, r: number, state: FacilityVisualState): void {
  const ring = [[-3, -1], [-3, 1], [3, -1], [3, 1], [-1, -3], [1, -3], [-1, 3], [1, 3]] as const;
  ring.forEach(([x, z], index) => k.m('stone', x, 0, z, 2, 2, 2, jit(0x84888d, hash01(index, 251))));
  k.m('accent', 0, 0.4, 0, 4, 1, 4, 0x1c5d7e);
  k.m('organicDark', -3, 2, 0, 1, 6, 1, 0x54402a);
  k.m('organicDark', 3, 2, 0, 1, 6, 1, 0x54402a);
  k.m('wood', 0, 7, 0, 7, 1, 1, jit(0x7a5636, r));
  k.m('wood', 0, 3.5, 0, 1, 6, 1, 0xa8905a, 'well-bucket', state.active ? 'facility-lift' : undefined);
  k.m('organicDark', 0, 1.6, 0, 2, 2, 2, 0x54402a, 'well-bucket', state.active ? 'facility-lift' : undefined);
}

function kitKiln(k: Kit, r: number, state: FacilityVisualState): void {
  for (let y = 0; y < 5; y += 1) {
    const radius = Math.max(1, 3 - Math.floor(y / 2));
    for (let x = -radius; x <= radius; x += 1) for (let z = -radius; z <= radius; z += 1) {
      const shell = Math.max(Math.abs(x), Math.abs(z)) === radius;
      if (!shell || (z === -radius && Math.abs(x) <= 1 && y < 3)) continue;
      k.m('roofTile', x, y, z, 1, 1, 1, jit(0x9b513b, hash01(x * 17 + z * 5 + y, 261)));
    }
  }
  k.m('stone', 0, 0, 0, 9, 1, 8, jit(0x756e64, r));
  if (state.active) {
    k.m('glowRed', 0, 0.8, -3.2, 2, 2, 1, 0xe55532, 'fire-core', 'fire');
    k.m('glowWarm', 0, 2.4, -2.6, 1, 2, 1, 0xffa33f, 'fire-mid', 'fire');
    k.m('plaster', 1.3, 5.5, 0.3, 2, 2, 2, 0xaaa49b, 'facility-smoke', 'facility-smoke');
    k.m('plaster', 2.1, 7.5, 0.5, 2, 2, 2, 0xc2bdb4, 'facility-smoke', 'facility-smoke');
  } else k.m('organicDark', 0, 0.8, -3.2, 2, 1, 1, 0x49372b);
}

function kitMill(k: Kit, r: number, state: FacilityVisualState): void {
  for (let y = 0; y < 2; y += 1) for (let x = -3; x <= 3; x += 1) for (let z = -3; z <= 3; z += 1) {
    if (Math.hypot(x, z) <= 3.2) k.m('stone', x, y, z, 1, 1, 1, jit(0x858078, hash01(x * 7 + z * 3 + y, 271)));
  }
  k.m('organicDark', 0, 2, 0, 1, 5, 1, 0x5a402d);
  k.m('wood', 2, 6, 0, 5, 1, 1, jit(0x7b5638, r), 'mill-arm', state.active ? 'mill-turn' : undefined);
  k.m('wood', 4.5, 5.4, 0, 1, 3, 1, 0x69472e, 'mill-arm', state.active ? 'mill-turn' : undefined);
  if (state.active) k.m('accent', 0, 2.2, -2, 1, 1, 1, 0xc6a15b);
}

function kitCivicCore(k: Kit, r: number, state: FacilityVisualState, keep = false): void {
  const material: DecorBucket = keep ? 'stone' : 'roofTile';
  const base = keep ? 0x66696c : 0xa96945;
  k.m('stone', 0, 0, 0, 9, 1, 9, jit(0x817b72, r));
  for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const)
    k.m(material, x, 1, z, 2, keep ? 8 : 6, 2, jit(base, hash01(x + z, 281)));
  k.m(material, 0, keep ? 8 : 6, 0, 9, 1, 9, jit(base, r));
  k.m('wood', 0, 1, 0, 6, 1, 2, jit(0x765038, r));
  if (state.active) {
    k.m('glowWarm', -2, 3, -3.4, 1, 2, 1, 0xffc37a);
    k.m('glowWarm', 2, 3, -3.4, 1, 2, 1, 0xffc37a);
  }
}

function kitWaterWheel(k: Kit, r: number, state: FacilityVisualState): void {
  const animation = state.active ? 'wheel-spin' as const : undefined;
  for (const x of [-2, 2]) k.m('stone', x, 0, 0, 2, 4, 2, jit(0x77746e, hash01(x, 290)));
  for (let index = 0; index < 12; index += 1) {
    const angle = index * Math.PI / 6;
    const y = 4 + Math.sin(angle) * 3.2;
    const z = Math.cos(angle) * 3.2;
    k.m('wood', 0, y, z, 2, 1.5, 1.5, jit(0x7e5734, hash01(index, 291)), 'wheel-rim', animation);
  }
  k.m('wood', 0, 3.5, 0, 2, 1, 7, jit(0x93653d, r), 'wheel-blade', animation);
  k.m('wood', 0, 0.5, 0, 2, 7, 1, jit(0x93653d, hash01(1, 292)), 'wheel-blade', animation);
  k.m('dark', 0, 3.4, 0, 4, 2, 2, 0xa16f32, 'wheel-hub', animation);
}

function kitDriveShaft(k: Kit, r: number, broken: boolean): void {
  if (broken) {
    k.m('dark', -2.5, 1.2, -0.7, 3, 1, 1, jit(0x684e32, r));
    k.m('dark', 2.5, 0.4, 0.7, 3, 1, 1, jit(0x684e32, hash01(1, 301)));
    k.m('organicDark', 0, 0, 0, 2, 1, 2, 0x3f3328);
    return;
  }
  k.m('dark', 0, 2.5, 0, 8, 1.4, 1.4, jit(0xa16f32, r));
  for (const x of [-3, 3]) k.m('stone', x, 0, 0, 1, 4, 3, jit(0x77746e, hash01(x, 302)));
}

function facilityBuilderFor(key: string, state: FacilityVisualState): KitBuilder | undefined {
  if (key === 'steel_drive_shaft') return (k, r) => kitSteelDriveShaft(k, r, state);
  if (key === 'mechanical_dynamo') return kitMechanicalDynamo;
  if (key === 'copper_conductor') return (k, r) => kitCopperConductor(k, r, false);
  if (key === 'broken_copper_conductor') return (k, r) => kitCopperConductor(k, r, true);
  if (key === 'resistive_load') return kitResistiveLoad;
  if (key === 'council_hearth') return (k, r) => kitCouncilHearth(k, r, state);
  if (key === 'workshop') return (k, r) => kitWorkshop(k, r, state);
  if (key === 'granary') return (k, r) => kitGranary(k, r, state);
  if (key === 'cistern') return (k, r) => kitCistern(k, r, state);
  if (key === 'kiln') return (k, r) => kitKiln(k, r, state);
  if (key === 'mill') return (k, r) => kitMill(k, r, state);
  if (key === 'civic_hall') return (k, r) => kitCivicCore(k, r, state);
  if (key === 'foundry') return (k, r) => kitWorkshop(k, r, state, 'bronze');
  if (key === 'smithy') return (k, r) => kitWorkshop(k, r, state, 'iron');
  if (key === 'keep_core') return (k, r) => kitCivicCore(k, r, state, true);
  if (key === 'water_wheel') return (k, r) => kitWaterWheel(k, r, state);
  if (key === 'drive_shaft') return (k, r) => kitDriveShaft(k, r, false);
  if (key === 'broken_drive_shaft') return (k, r) => kitDriveShaft(k, r, true);
  return undefined;
}

interface StructureBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * 结构的可视矩形只能来自 authoritative occupiedCells。
 * 常规矩形占地直接全量使用；L 形等稀疏占地选择靠近整体中心的最长连续行/列，
 * 避免屋顶跨过未属于该结构的格子。
 */
function structureBounds(cellIds: number[], worldWidth: number): StructureBounds {
  const points = [...new Set(cellIds)].map((id) => ({ x: id % worldWidth, y: Math.floor(id / worldWidth) }));
  const minX = Math.min(...points.map(({ x }) => x));
  const maxX = Math.max(...points.map(({ x }) => x));
  const minY = Math.min(...points.map(({ y }) => y));
  const maxY = Math.max(...points.map(({ y }) => y));
  const occupied = new Set(points.map(({ x, y }) => `${x}:${y}`));
  const rectangleArea = (maxX - minX + 1) * (maxY - minY + 1);
  if (rectangleArea === occupied.size) return { minX, maxX, minY, maxY };

  const centroidX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const centroidY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const candidates: StructureBounds[] = [];
  const addRuns = (values: number[], fixed: number, horizontal: boolean) => {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    let start = sorted[0], previous = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const value = sorted[i];
      if (value === previous + 1) { previous = value; continue; }
      candidates.push(horizontal
        ? { minX: start, maxX: previous, minY: fixed, maxY: fixed }
        : { minX: fixed, maxX: fixed, minY: start, maxY: previous });
      start = value;
      previous = value;
    }
  };
  for (const y of [...new Set(points.map((point) => point.y))])
    addRuns(points.filter((point) => point.y === y).map((point) => point.x), y, true);
  for (const x of [...new Set(points.map((point) => point.x))])
    addRuns(points.filter((point) => point.x === x).map((point) => point.y), x, false);

  return candidates.sort((a, b) => {
    const areaA = (a.maxX - a.minX + 1) * (a.maxY - a.minY + 1);
    const areaB = (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1);
    if (areaA !== areaB) return areaB - areaA;
    const distanceA = Math.hypot((a.minX + a.maxX) / 2 - centroidX, (a.minY + a.maxY) / 2 - centroidY);
    const distanceB = Math.hypot((b.minX + b.maxX) / 2 - centroidX, (b.minY + b.maxY) / 2 - centroidY);
    return distanceA - distanceB;
  })[0];
}

/** 房屋串联记录：完工住宅的占地、屋顶高与地面高，供相邻检测与连廊生成。 */
interface HouseStampRecord {
  bounds: StructureBounds;
  topY: number;
  groundY: number;
  material: StructureMaterialKind;
}

/** 将房屋印章居中拟合进权威占地；已完工建筑可用少量挑檐扩展视觉轮廓，不额外生成地基。
 *  返回放置后的世界包围盒（顶部高度供连廊檐口对齐），空印章返回 null。 */
function placeStructureStamp(
  out: DecorInstance[], build: KitBuilder, bounds: StructureBounds,
  worldWidth: number, worldHeight: number, groundY: number, rot: number, r: number,
  decorativeOverhang = 0,
): { topY: number } | null {
  const stamp: DecorInstance[] = [];
  build(new Kit(stamp, 0, 0, 0, 1, rot), r);
  if (!stamp.length) return null;
  const minX = Math.min(...stamp.map((inst) => inst.x - inst.sx / 2));
  const maxX = Math.max(...stamp.map((inst) => inst.x + inst.sx / 2));
  const minY = Math.min(...stamp.map((inst) => inst.y - inst.sy / 2));
  const minZ = Math.min(...stamp.map((inst) => inst.z - inst.sz / 2));
  const maxZ = Math.max(...stamp.map((inst) => inst.z + inst.sz / 2));
  const modelCenterX = (minX + maxX) / 2;
  const modelCenterZ = (minZ + maxZ) / 2;
  const targetCenterX = (bounds.minX + bounds.maxX + 1) / 2 - worldWidth / 2;
  const targetCenterZ = (bounds.minY + bounds.maxY + 1) / 2 - worldHeight / 2;
  const gap = 0.1;
  const targetWidth = bounds.maxX - bounds.minX + 1 + decorativeOverhang * 2 - gap * 2;
  const targetDepth = bounds.maxY - bounds.minY + 1 + decorativeOverhang * 2 - gap * 2;
  const scaleX = targetWidth / (maxX - minX);
  const scaleZ = targetDepth / (maxZ - minZ);
  // 水平可按真实矩形成为长屋；高度跟随较窄方向等比收缩，避免小占地房屋被拉成塔楼。
  // 仍限制为最多原始高度，较大的权威占地只会让住宅变宽、不会凭空增加楼层。
  const scaleY = Math.min(1, scaleX, scaleZ);
  let topY = groundY;
  for (const inst of stamp) {
    const placedY = groundY + (inst.y - minY) * scaleY;
    out.push({
      ...inst,
      x: targetCenterX + (inst.x - modelCenterX) * scaleX,
      y: placedY,
      z: targetCenterZ + (inst.z - modelCenterZ) * scaleZ,
      sx: inst.sx * scaleX,
      sy: inst.sy * scaleY,
      sz: inst.sz * scaleZ,
    });
    topY = Math.max(topY, placedY + (inst.sy * scaleY) / 2);
  }
  return { topY };
}

/**
 * 房屋串联连廊：两栋直接相邻（占地边线相贴）的完工住宅之间生成门槛压条、
 * 端柱与共用檐口，把两家的材质在视觉上连成一体——与道路八向邻接同源的装饰层读法，
 * 只读取已完工结构事实，不改变通行、领域状态或观察器。
 */
function emitHouseLink(
  out: DecorInstance[],
  A: HouseStampRecord,
  B: HouseStampRecord,
  axis: 'x' | 'z',
  overlapMin: number,
  overlapMax: number,
  w: PixelWorldView,
): void {
  const along = axis === 'z'; // 纵向接缝（A 左 B 右），连廊沿 z 延伸
  const seamPos = along ? A.bounds.maxX + 1 - w.width / 2 : A.bounds.maxY + 1 - w.height / 2;
  const spanStart = overlapMin - (along ? w.height / 2 : w.width / 2);
  const spanLen = overlapMax - overlapMin + 1;
  const spanCenter = spanStart + spanLen / 2;
  const groundY = Math.min(A.groundY, B.groundY);
  const eaveY = Math.min(A.topY, B.topY) - 0.42;
  const stoneBoth = A.material === 'stone' && B.material === 'stone';
  const wallBucket: DecorBucket = stoneBoth ? 'stone' : 'wood';
  const wallColor = stoneBoth ? 0x777872 : 0x6b4a2e;
  const postColor = stoneBoth ? 0x5f5f5a : 0x4e3822;
  const roofColor = stoneBoth ? 0x5a5560 : 0x5a4030;
  // 门槛压条：两家之间一条连续的地面连接带
  out.push({
    b: wallBucket,
    x: along ? seamPos : spanCenter,
    y: groundY + 0.06,
    z: along ? spanCenter : seamPos,
    sx: along ? 0.9 : spanLen,
    sy: 0.12,
    sz: along ? spanLen : 0.9,
    c: wallColor,
  });
  // 端柱：连廊两端的支撑，视觉上把檐口"挂"在两栋房子之间
  for (const end of [spanStart + 0.15, spanStart + spanLen - 0.15]) {
    out.push({
      b: 'wood',
      x: along ? seamPos : end,
      y: groundY + 1.05,
      z: along ? end : seamPos,
      sx: 0.22,
      sy: 2.1,
      sz: 0.22,
      c: postColor,
    });
  }
  // 共用檐口：把两家的屋顶下沿连成一条，与道路接缝同理读作"连在一起"
  out.push({
    b: 'roofTile',
    x: along ? seamPos : spanCenter,
    y: eaveY,
    z: along ? spanCenter : seamPos,
    sx: along ? 1.15 : spanLen + 0.4,
    sy: 0.24,
    sz: along ? spanLen + 0.4 : 1.15,
    c: roofColor,
  });
}

/** 两栋完工住宅的串联检测：正交边线相贴且重叠至少一格。 */
function collectHouseLinks(
  out: DecorInstance[],
  houses: readonly HouseStampRecord[],
  w: PixelWorldView,
): void {
  const linkStart = out.length;
  for (let a = 0; a < houses.length; a++) {
    for (let b = a + 1; b < houses.length; b++) {
      const A = houses[a];
      const B = houses[b];
      // 纵向接缝：一家在左一家在右
      if (A.bounds.maxX + 1 === B.bounds.minX || B.bounds.maxX + 1 === A.bounds.minX) {
        const left = A.bounds.maxX < B.bounds.minX ? A : B;
        const right = left === A ? B : A;
        const overlapMin = Math.max(left.bounds.minY, right.bounds.minY);
        const overlapMax = Math.min(left.bounds.maxY, right.bounds.maxY);
        if (overlapMax >= overlapMin) emitHouseLink(out, left, right, 'z', overlapMin, overlapMax, w);
      }
      // 横向接缝：一家在上一家在下
      if (A.bounds.maxY + 1 === B.bounds.minY || B.bounds.maxY + 1 === A.bounds.minY) {
        const up = A.bounds.maxY < B.bounds.minY ? A : B;
        const down = up === A ? B : A;
        const overlapMin = Math.max(up.bounds.minX, down.bounds.minX);
        const overlapMax = Math.min(up.bounds.maxX, down.bounds.maxX);
        if (overlapMax >= overlapMin) emitHouseLink(out, up, down, 'x', overlapMin, overlapMax, w);
      }
    }
  }
  if (out.length > linkStart) markSettlementEraLayer(out, linkStart);
}

/* ------------------------------------------------------------------ */
/* 动物（对应 domain/animal 的物种）                                     */
/* ------------------------------------------------------------------ */

function kitDeer(k: Kit, r: number, sex: 'female' | 'male' = 'male', juvenile = false): void {
  const fur = jit(0x8a6a48, r);
  k.m('wood', -1, 4, 0, 7, 4, 4, fur, 'body');                         // 长躯干
  k.m('wood', 3.5, 6, 0, 2, 5, 3, fur, 'head');                       // 抬起的颈部
  k.m('wood', 5.5, 9, 0, 4, 4, 4, jit(0x847052, r), 'head');          // 方头
  k.m('wood', 8, 9.5, 0, 2, 2, 3, jit(0x9a7852, r), 'head');         // 口鼻
  k.m('organicDark', 9, 10, 0, 1, 1, 2, 0x3d3024, 'head');           // 鼻头

  const deerLegs = [[-3, -1.4], [-3, 1.4], [1.5, -1.4], [1.5, 1.4]] as const;
  deerLegs.forEach(([x, z], index) => {
    k.m('wood', x, 2, z, 1.5, 3, 1.5, fur, `leg-${index}`);            // 小腿
    k.m('organicDark', x, 1, z, 1.5, 1, 1.5, 0x4a3828, `leg-${index}`); // 深色蹄
  });
  for (const z of [-2.5, 2.5] as const) {
    const side = z < 0 ? -1 : 1;
    k.m('wood', 4.7, 11.7, z, 1.5, 1.5, 1.5, 0x9a7852, 'head');      // 耳朵
    k.m('organicDark', 6.5, 11.2, side * 2.05, 1, 1, 0.6, 0x171411, 'head'); // 双眼
    if (sex === 'male' && !juvenile) {
      k.m('organicDark', 4.5, 13, side * 1.5, 1, 4, 1, 0x54402a, 'head'); // 成年雄鹿角
      k.m('organicDark', 2.8, 16, side * 1.5, 4, 1, 1, 0x54402a, 'head');
      k.m('organicDark', 1.5, 16, side * 1.5, 1, 2.5, 1, 0x54402a, 'head');
      k.m('organicDark', 3.5, 16, side * 1.5, 1, 2, 1, 0x5f472f, 'head');
    }
  }
  k.m('plaster', -5, 6, 0, 2, 2.5, 2, 0xe8e4da, 'tail');             // 白色短尾
  k.m('plaster', -0.5, 4, 0, 4, 1, 3, 0xd8cfbd, 'body');             // 腹部浅毛
}

function kitCatalogAnimal(
  k: Kit,
  key: VoxelAssetKey,
  r: number,
  context: VoxelAssetContext = {},
): void {
  for (const cuboid of resolveVoxelAssetParts(key, context, r)) {
    k.m(
      cuboid.bucket,
      cuboid.position[0],
      cuboid.position[1],
      cuboid.position[2],
      cuboid.size[0],
      cuboid.size[1],
      cuboid.size[2],
      cuboid.color,
      cuboid.part,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 世界扫描                                                             */
/* ------------------------------------------------------------------ */


export type SettlementVisualStage = 'primitive' | 'agrarian' | 'ancient';

export function settlementVisualStage(stage: string | undefined): SettlementVisualStage {
  if (stage === '农耕定居') return 'agrarian';
  if (stage === '古代文明' || stage === '中世纪' || stage === '现代文明（含信息能力）') return 'ancient';
  return 'primitive';
}

export type AncientHouseVisualStyle = 'chinese' | 'western-medieval';

/** Stable decoration-only choice; it never changes the authoritative shelter. */
export function ancientHouseVisualStyle(structureCellId: number, worldSeed: number): AncientHouseVisualStyle {
  return hash01(structureCellId ^ worldSeed, 211) < 0.5 ? 'chinese' : 'western-medieval';
}

export function usesAgrarianSettlementDecor(stage: string | undefined): boolean {
  return settlementVisualStage(stage) !== 'primitive';
}

export type SettlementWonderKind = 'tribal-camp' | 'windmill' | 'stepped-temple' | 'castle';

export interface SettlementWonderProjection {
  kind: SettlementWonderKind;
  label: '部落营地' | '风车磨坊' | '阶梯神庙' | '城堡';
  anchorCellId: number;
  anchorMaterialKey: 'council_hearth' | 'mill' | 'civic_hall' | 'keep_core';
  evidenceKeys: string[];
}

interface WonderCandidate extends SettlementWonderProjection {
  priority: number;
}

function facilityInstitutionAnchors(
  society: SocietyState,
  institutionPrefix: 'coordination-core' | 'land-processing',
  materialKey: SettlementWonderProjection['anchorMaterialKey'],
): Array<{ cellId: number; evidenceKey: string }> {
  const { world } = society;
  const materialId = world.palette.find((material) => material.key === materialKey)?.id;
  if (materialId === undefined) return [];
  const marker = `${institutionPrefix}:facility:${materialId}:`;
  return society.observations.institutions.flatMap((institution) => {
    if (!institution.key.startsWith(marker)) return [];
    const coordinates = institution.key.slice(marker.length).split(':').map(Number);
    if (coordinates.length < 2 || !coordinates.slice(0, 2).every(Number.isInteger)) return [];
    const [x, y] = coordinates;
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) return [];
    const cellId = y * world.width + x;
    // 制度证据可以保留历史，但奇观外观只能锚定当前仍真实存在的设施。
    if (world.surface[cellId] !== materialId) return [];
    return [{ cellId, evidenceKey: institution.key }];
  });
}

function wonderAnchorScore(society: SocietyState, anchorCellId: number): number {
  const { world } = society;
  const distance = (cellId: number): number => Math.abs(cellId % world.width - anchorCellId % world.width)
    + Math.abs(Math.floor(cellId / world.width) - Math.floor(anchorCellId / world.width));
  const nearbyCompletedStructures = society.structures.filter((structure) => (
    structure.complete && structure.occupiedCells.some((cellId) => distance(cellId) <= 7)
  )).length;
  const nearbyFacilities = world.surface.filter((materialId, cellId) => (
    distance(cellId) <= 5
      && world.palette[materialId]?.tags.includes('facility')
  )).length;
  return nearbyCompletedStructures * 4 + nearbyFacilities * 2;
}

function strongestWonderAnchor(
  society: SocietyState,
  anchors: Array<{ cellId: number; evidenceKey: string }>,
): { cellId: number; evidenceKey: string } | undefined {
  return [...anchors].sort((left, right) => (
    wonderAnchorScore(society, right.cellId) - wonderAnchorScore(society, left.cellId)
      || left.cellId - right.cellId
  ))[0];
}

/**
 * 从权威设施与已形成制度中选择一个主奇观外观。时代只控制视觉语汇，不能单独生成奇观；
 * 返回值不写回领域状态，也不进入文明指数或人物可感知事实。
 */
export function settlementWonderProjection(society: SocietyState): SettlementWonderProjection | null {
  const stage = settlementVisualStage(society.observations.civilizationIndex?.stage);
  const culturalMemoryEvidence = society.observations.practices.some((practice) => (
    practice.key === 'mortuary-care' && practice.count >= 2
  )) || society.observations.milestones.some((milestone) => (
    milestone.id.includes('physical-record')
      || milestone.id.includes('burial-memorial')
      || milestone.id.includes('prediction-practice')
  ));
  const jointWorkEvidence = society.observations.milestones.some((milestone) => (
    milestone.id.includes('joint-project')
  ));
  const candidates: WonderCandidate[] = [];
  const addCandidate = (
    kind: SettlementWonderKind,
    label: SettlementWonderProjection['label'],
    anchorMaterialKey: SettlementWonderProjection['anchorMaterialKey'],
    priority: number,
    anchors: Array<{ cellId: number; evidenceKey: string }>,
    extraEvidenceKeys: string[] = [],
  ) => {
    const anchor = strongestWonderAnchor(society, anchors);
    if (!anchor) return;
    candidates.push({
      kind,
      label,
      anchorCellId: anchor.cellId,
      anchorMaterialKey,
      priority,
      evidenceKeys: [anchor.evidenceKey, ...extraEvidenceKeys].sort(),
    });
  };

  if (stage === 'ancient') addCandidate(
    'castle',
    '城堡',
    'keep_core',
    4,
    facilityInstitutionAnchors(society, 'coordination-core', 'keep_core'),
  );
  if (stage === 'ancient' && culturalMemoryEvidence) addCandidate(
    'stepped-temple',
    '阶梯神庙',
    'civic_hall',
    3,
    facilityInstitutionAnchors(society, 'coordination-core', 'civic_hall'),
    society.observations.milestones.filter((milestone) => (
      milestone.id.includes('physical-record')
        || milestone.id.includes('burial-memorial')
        || milestone.id.includes('prediction-practice')
    )).map((milestone) => milestone.id),
  );
  if (stage !== 'primitive') addCandidate(
    'windmill',
    '风车磨坊',
    'mill',
    2,
    facilityInstitutionAnchors(society, 'land-processing', 'mill'),
  );
  if (jointWorkEvidence) addCandidate(
    'tribal-camp',
    '部落营地',
    'council_hearth',
    1,
    facilityInstitutionAnchors(society, 'coordination-core', 'council_hearth'),
  );

  const selected = candidates.sort((left, right) => right.priority - left.priority
    || wonderAnchorScore(society, right.anchorCellId) - wonderAnchorScore(society, left.anchorCellId)
    || left.anchorCellId - right.anchorCellId)[0];
  if (!selected) return null;
  return {
    kind: selected.kind,
    label: selected.label,
    anchorCellId: selected.anchorCellId,
    anchorMaterialKey: selected.anchorMaterialKey,
    evidenceKeys: selected.evidenceKeys,
  };
}

function wonderBuilderFor(kind: SettlementWonderKind, active: boolean): KitBuilder {
  if (kind === 'tribal-camp') return (k) => kitTribalCampPreview(k, active);
  if (kind === 'windmill') return (k) => kitWindmillPreview(k);
  if (kind === 'stepped-temple') return (k) => kitTemplePreview(k, active);
  return (k) => kitCastlePreview(k, active);
}

function wonderScale(kind: SettlementWonderKind): number {
  if (kind === 'tribal-camp') return 1.12;
  if (kind === 'windmill') return 1.22;
  if (kind === 'stepped-temple') return 1.36;
  return 1.3;
}

function markSettlementEraLayer(out: DecorInstance[], start: number): void {
  for (let index = start; index < out.length; index++) out[index].visualLayer = 'settlement-era';
}

/** 扫描权威状态，产出全部装饰实例（每月状态刷新时调用一次） */
export function collectDecor(society: SocietyState, era: EraKey): DecorInstance[] {
  const w = society.world;
  const out: DecorInstance[] = [];
  const settlementStage = settlementVisualStage(society.observations.civilizationIndex?.stage);
  const wonder = settlementWonderProjection(society);
  const cold = era === 'frozen' || era === 'chaotic-cold' || society.weather?.kind === 'snow';
  const scorched = era === 'burned' || era === 'extinct';
  const COUNT = w.width * w.height;
  // 结构投影会把谷仓、窑炉等固体设施也识别成 structure；这些格子已有专用设施模型，
  // 不能再叠一层通用房屋或施工架，否则会在视觉上显得又大又密。
  const renderedStructures = society.structures.filter((structure) => (
    !(structure.materialIds ?? []).some((materialId) => (
      FUNCTIONAL_MODEL_KEYS.has(w.palette[materialId]?.key ?? '')
    ))
  ));
  const constructionCells = new Set(renderedStructures.flatMap((structure) => structure.occupiedCells));
  const drought = society.weather?.kind === 'drought';
  const facilityCellsByMaterial = new Map<number, number[]>();
  const functionalCells = new Set<number>();
  for (let id = 0; id < COUNT; id += 1) {
    const materialId = w.surface[id];
    if (!FUNCTIONAL_MODEL_KEYS.has(w.palette[materialId]?.key ?? '')) continue;
    functionalCells.add(id);
    const cells = facilityCellsByMaterial.get(materialId);
    if (cells) cells.push(id); else facilityCellsByMaterial.set(materialId, [id]);
  }
  const cellDistance = (left: number, right: number): number => Math.abs(left % w.width - right % w.width)
    + Math.abs(Math.floor(left / w.width) - Math.floor(right / w.width));
  const activeFacilityCells = new Set<number>();
  for (const agent of society.agents) {
    const action = agent.visualAction;
    if (!action?.sourceEventId) continue;
    const anchor = action.targetCellId ?? action.sourceCellId ?? agent.cellId;
    if (functionalCells.has(anchor)) activeFacilityCells.add(anchor);
    if (action.facilityMaterialId !== undefined) {
      const nearest = (facilityCellsByMaterial.get(action.facilityMaterialId) ?? [])
        .map((cellId) => ({ cellId, distance: cellDistance(anchor, cellId) }))
        .filter(({ distance }) => distance <= 2)
        .sort((left, right) => left.distance - right.distance || left.cellId - right.cellId)[0];
      if (nearest) activeFacilityCells.add(nearest.cellId);
    }
    if (action.mechanicalPowerOperation) {
      // 动力作业只点亮该 ActionFact 所属权威网络的已安装构件，不从邻接猜网络身份。
      for (const cellId of action.linkedFacilityCellIds ?? []) {
        const key = w.palette[w.surface[cellId]]?.key;
        if (key === 'mill' || key === 'water_wheel' || key === 'drive_shaft' || key === 'steel_drive_shaft') {
          activeFacilityCells.add(cellId);
        }
      }
    }
  }
  const electricalComponentAt = new Map<string, {
    network: ElectricalNetworkDecorView;
    component: ElectricalComponentDecorView;
  }>();
  const activeElectricalNetworkIds = new Set<string>();
  const faultNowElectricalNetworkIds = new Set<string>();
  for (const network of society.electricalPower?.networks ?? []) {
    if (network.activity?.kind === 'operation' && network.activity.delivered) {
      activeElectricalNetworkIds.add(network.id);
    } else if (network.activity?.kind === 'fault') {
      faultNowElectricalNetworkIds.add(network.id);
    }
    for (const component of network.components) {
      electricalComponentAt.set(`${component.cellId}:${component.z}`, { network, component });
    }
  }
  const containerByCell = new Map(society.containers.map((container) => [container.cellId, container]));
  const facilityRotationFor = (cellId: number): number => {
    const x = cellId % w.width;
    const y = Math.floor(cellId / w.width);
    const mechanicalAt = (nx: number, ny: number): boolean => {
      if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) return false;
      const key = w.palette[w.surface[ny * w.width + nx]]?.key;
      return key === 'water_wheel' || key === 'drive_shaft' || key === 'steel_drive_shaft'
        || key === 'mill' || key === 'broken_drive_shaft';
    };
    return mechanicalAt(x, y - 1) || mechanicalAt(x, y + 1) ? 1 : 0;
  };

  // 水面集合（判断近水树种）
  const water = new Set<number>();
  const treeCells = new Set<number>();
  for (let id = 0; id < COUNT; id++)
    if (w.palette[w.surface[id]]?.key === 'water') water.add(id);
    else if (w.palette[w.surface[id]]?.key === 'leaves' || w.palette[w.surface[id]]?.key === 'wood') treeCells.add(id);
  const nearWater = (id: number): boolean => {
    const x = id % w.width, y = Math.floor(id / w.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
      if (water.has(ny * w.width + nx)) return true;
    }
    return false;
  };
  const nearTree = (id: number): boolean => {
    const x = id % w.width, y = Math.floor(id / w.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w.width && ny < w.height && treeCells.has(ny * w.width + nx)) return true;
    }
    return false;
  };

  for (let id = 0; id < COUNT; id++) {
    const key = w.palette[w.surface[id]]?.key;
    const x = id % w.width, y = Math.floor(id / w.width);
    const wx = x - w.width / 2 + 0.5, wz = y - w.height / 2 + 0.5;
    const r = hash01(id ^ Math.imul(w.generator.seed, 0x45d9f3b), 77);
    const gt = (w.elevation[id] - featureDepth(w, id, constructionCells) + 1) * CELL_H;
    // 树冠摇摆旗标：不再只在风暴天——摆动强度由权威天气映射（风暴>雨>旱>雪>晴）超过阈值即标记。
    const swayStrength = weatherSwayStrength(society.weather);
    const markWind = (start: number) => {
      if (swayStrength < 0.24) return;
      for (let index = start; index < out.length; index++) {
        if (out[index].b === 'leaf' || out[index].b === 'wood') out[index].animation = 'wind';
      }
    };
    // 同种天然素材的尺度抖动：树高、灌木大小按格子确定性变化，配合既有 90° 旋转去除克隆感。
    const kit = (build: KitBuilder) => {
      const start = out.length;
      const scaleJitter = 0.9 + hash01(id ^ w.generator.seed, 79) * 0.22;
      build(new Kit(out, wx, gt, wz, scaleJitter, Math.floor(r * 4)), r);
      markWind(start);
    };
    const smallOffset = quarterCellOffset(hash01(id ^ w.generator.seed, 78), id ^ w.generator.seed);
    const smallKit = (build: KitBuilder, scale = 0.46) => {
      const start = out.length;
      const jitteredScale = scale * (0.86 + hash01(id ^ w.generator.seed, 80) * 0.32);
      build(new Kit(out, wx + smallOffset.x, gt, wz + smallOffset.z, jitteredScale, Math.floor(r * 4)), r);
      markWind(start);
    };

    switch (key) {
      case 'leaves': case 'wood': {
        const biome: BiomeKey = w.biomes?.[id] ?? biomeAt(w.generator.seed, x, y);
        let species: TreeSpeciesKey = treeSpeciesAt(w.generator.seed, x, y);
        // 河岸只在当地气候允许时调整树种，避免把整条河边机械地刷成同一种树。
        if (nearWater(id)) {
          if (biome === 'tropical') species = r < 0.72 ? 'palm' : 'acacia';
          else if (biome === 'savanna' && r < 0.24) species = 'palm';
          else if ((biome === 'taiga' || biome === 'birch') && r < 0.42) species = 'birch';
        }

        const treeKit = cold && species === 'spruce' ? kitSnowSpruce : TREE_KITS[species];
        kit(scorched ? kitDead : treeKit);
        break;
      }
      case 'berry_bush': smallKit((k) => kitBush(k, true, drought)); break;
      case 'shrub': smallKit((k) => kitBush(k, false, drought)); break;
      case 'crop_mature': smallKit((k, random) => kitWheat(k, random, drought)); break;
      case 'crop_sprout': smallKit((k, random) => kitSprout(k, random, drought)); break;
      case 'ash': smallKit(kitScorch); break;
      case 'fire': smallKit(kitFire, 0.52); break;
      case 'ice':
        if (r < 0.15) smallKit(kitIceSpike, 0.52);
        break;
      case 'grass': {
        const biome: BiomeKey = w.biomes?.[id] ?? biomeAt(w.generator.seed, x, y);
        if (cold && r < 0.12) smallKit(kitSnowdrift, 0.4);
        else if (nearWater(id) && r < 0.18) smallKit(kitReeds, 0.34);
        else if (nearTree(id) && r < 0.055) smallKit(kitFallenBranch, 0.36);
        else if ((biome === 'temperate' || biome === 'birch') && r > 0.93) smallKit(kitFlowers, 0.34);
        else if (r > 0.72 && r < 0.80) smallKit(kitGrassTuft, 0.3);
        break;
      }
      case 'wet_soil': case 'rich_soil':
        if (nearWater(id) && r < 0.12) smallKit(kitReeds, 0.32);
        else if (nearTree(id) && r > 0.92) smallKit(kitMushrooms, 0.3);
        break;
      case 'soil': case 'exhausted_soil': case 'packed_soil':
        if (drought && r < 0.22) smallKit(kitDroughtCracks, 0.46);
        break;
      default: {
        // 已安装电力构件按精确 cellId:z 和冻结计划另行生成，避免二维 surface 丢失竖直段与转角。
        if (electricalComponentAt.has(`${id}:${w.elevation[id]}`)) break;
        const container = containerByCell.get(id);
        const facilityState: FacilityVisualState = {
          active: activeFacilityCells.has(id),
          fillRatio: container ? Math.min(1, container.usedCapacity / Math.max(1, container.capacity)) : 0,
        };
        const wonderAtCell = wonder?.anchorCellId === id && wonder.anchorMaterialKey === key;
        const build = wonderAtCell
          ? wonderBuilderFor(wonder.kind, facilityState.active)
          : key ? facilityBuilderFor(key, facilityState) : undefined;
        if (build) {
          const start = out.length;
          const rot = wonderAtCell
            ? Math.floor(r * 4)
            : key === 'water_wheel' || key === 'drive_shaft' || key === 'steel_drive_shaft'
              || key === 'broken_drive_shaft'
            ? facilityRotationFor(id)
            : Math.floor(r * 4);
          const scale = wonderAtCell ? wonderScale(wonder.kind) : key === 'granary' ? 0.72 : 1;
          const entityId = wonderAtCell ? `wonder:${wonder.kind}:${id}` : `facility:${id}`;
          build(new Kit(out, wx, gt, wz, scale, rot, entityId), r);
          markWind(start);
          if (wonderAtCell) markSettlementEraLayer(out, start);
        }
        break;
      }
    }
  }

  const electricalDirection = (
    from: { cellId: number; z: number },
    to: { cellId: number; z: number },
  ): ElectricalPlanDirection | undefined => {
    if (to.z === from.z + 1 && to.cellId === from.cellId) return 'up';
    if (to.z === from.z - 1 && to.cellId === from.cellId) return 'down';
    const fromX = from.cellId % w.width;
    const fromY = Math.floor(from.cellId / w.width);
    const toX = to.cellId % w.width;
    const toY = Math.floor(to.cellId / w.width);
    if (to.z !== from.z) return undefined;
    if (toX === fromX + 1 && toY === fromY) return 'east';
    if (toX === fromX - 1 && toY === fromY) return 'west';
    if (toY === fromY + 1 && toX === fromX) return 'south';
    if (toY === fromY - 1 && toX === fromX) return 'north';
    return undefined;
  };
  const rotationToward = (direction: ElectricalPlanDirection | undefined, fallback: number): number => {
    if (direction === 'east') return 0;
    if (direction === 'west') return 2;
    if (direction === 'north') return 1;
    if (direction === 'south') return 3;
    return fallback;
  };

  // 只绘制账本与精确 voxel 一致的已安装构件；planPath 仅提供端口方向，不补画计划余段。
  for (const network of society.electricalPower?.networks ?? []) {
    const active = activeElectricalNetworkIds.has(network.id);
    for (const component of network.components) {
      const materialKey = w.palette[component.materialId]?.key;
      if (materialKey !== 'mechanical_dynamo'
        && materialKey !== 'copper_conductor'
        && materialKey !== 'broken_copper_conductor'
        && materialKey !== 'resistive_load') continue;
      const pathIndex = network.planPath.findIndex((position) => (
        position.cellId === component.cellId && position.z === component.z
      ));
      if (pathIndex < 0) continue;
      const current = network.planPath[pathIndex];
      const neighbors = [network.planPath[pathIndex - 1], network.planPath[pathIndex + 1]]
        .filter((position): position is { cellId: number; z: number } => Boolean(position));
      const directions = neighbors
        .map((neighbor) => electricalDirection(current, neighbor))
        .filter((direction): direction is ElectricalPlanDirection => direction !== undefined);
      const x = component.cellId % w.width;
      const y = Math.floor(component.cellId / w.width);
      const wx = x - w.width / 2 + 0.5;
      const wz = y - w.height / 2 + 0.5;
      const r = hash01(component.cellId ^ Math.imul(component.z + 1, 0x45d9f3b), 338);
      const entityId = `electrical:${network.id}:${component.cellId}:${component.z}`;
      const state: FacilityVisualState = { active, fillRatio: 0 };
      if (component.role === 'conductor') {
        const faultNow = materialKey === 'broken_copper_conductor'
          && faultNowElectricalNetworkIds.has(network.id)
          && network.fault?.cellId === component.cellId
          && network.fault.z === component.z;
        kitPlannedCopperConductor(
          new Kit(out, wx, component.z * CELL_H, wz, 1, 0, entityId),
          r,
          materialKey === 'broken_copper_conductor',
          active,
          directions,
          faultNow,
        );
        continue;
      }
      const outward = component.role === 'source' ? directions.at(-1) : directions[0];
      const rot = rotationToward(outward, Math.floor(r * 4));
      const kit = new Kit(out, wx, component.z * CELL_H, wz, 1, rot, entityId);
      if (component.role === 'source') kitMechanicalDynamo(kit, r, state);
      else kitResistiveLoad(kit, r, state);
    }
  }

  // 泥土小径直接绑定权威 PackedSoil 地表；trail 区域仅用于兼容旧投影和历史存档。
  const packedSoilCells = new Set<number>();
  for (let id = 0; id < COUNT; id++) if (w.palette[w.surface[id]]?.key === 'packed_soil') packedSoilCells.add(id);
  const mergeablePackedSoilCells = new Set(Array.from(packedSoilCells)
    .filter((id) => !constructionCells.has(id)));
  const trailCells = new Set(society.regions.filter((region) => region.kind === 'trail').flatMap((region) => region.cells));
  packedSoilCells.forEach((id) => trailCells.add(id));
  for (const id of trailCells) {
    if (id < 0 || id >= COUNT) continue;
    const x = id % w.width, y = Math.floor(id / w.width);
    const connections = dirtPathConnections(trailCells, w.width, w.height, w.elevation, id);
    const filledCorners = dirtPathFilledCorners(mergeablePackedSoilCells, w.width, w.height, w.elevation, id);
    const depth = featureDepth(w, id, constructionCells);
    const groundY = (w.elevation[id] - depth + 1) * CELL_H;
    const appendPath = settlementStage === 'ancient'
      ? appendAncientPathCell
      : settlementStage === 'agrarian'
        ? appendStonePathCell
        : appendDirtPathCell;
    appendPath(out, x - w.width / 2 + 0.5, groundY, y - w.height / 2 + 0.5,
      connections, hash01(id ^ w.generator.seed, 5), filledCorners);
  }

  // 墓葬只由权威 interred 遗体投影。土冢是同一安葬事实的稳定视觉细节；
  // 竖立墓记必须另外存在已经消耗真实材料创建的 marker。
  for (const grave of society.graves ?? []) {
    const x = grave.cellId % w.width;
    const y = Math.floor(grave.cellId / w.width);
    const centerX = x - w.width / 2 + 0.5;
    const centerZ = y - w.height / 2 + 0.5;
    const groundY = grave.z * CELL_H;
    const turn = hash01(grave.cellId ^ w.generator.seed, 207) < 0.5 ? 0 : Math.PI / 2;
    out.push({
      b: 'groundMark', x: centerX, y: groundY + 0.012, z: centerZ,
      sx: 0.54, sy: 0.025, sz: 0.78, ry: turn, c: 0x705947,
    });
    out.push({
      b: 'stone', x: centerX, y: groundY + 0.038, z: centerZ,
      sx: 0.44, sy: 0.055, sz: 0.66, ry: turn, c: 0x847766,
    });
    if (grave.marked) {
      const markerColor = grave.markerMaterialId === undefined
        ? 0x896039
        : (() => {
            const color = w.palette[grave.markerMaterialId]?.color ?? [137, 96, 57];
            return (color[0] << 16) | (color[1] << 8) | color[2];
          })();
      const headZ = centerZ - (turn === 0 ? 0.27 : 0);
      const headX = centerX - (turn === 0 ? 0 : 0.27);
      out.push({
        b: 'wood', x: headX, y: groundY + 0.23, z: headZ,
        sx: turn === 0 ? 0.34 : 0.075, sy: 0.44, sz: turn === 0 ? 0.075 : 0.34,
        c: markerColor,
      });
    }
  }

  // 掉落物 / 容器 → 同格聚合物资堆
  const pileFor = (materialKey: string | undefined): KitBuilder => {
    switch (materialKey) {
      case 'wood': case 'plank': return kitWoodpile;
      case 'stone': return kitStonepile;
      case 'food': return kitFoodpile;
      case 'seed': return kitSeedpile;
      case 'raw_meat': return kitMeat;
      case 'hide': return kitHide;
      case 'bone': return kitBonePile;
      case 'stone_tool': return (k, r) => kitToolRack(k, r, 'stone');
      case 'bone_tool': return (k, r) => kitToolRack(k, r, 'bone');
      case 'spear': return (k, r) => kitToolRack(k, r, 'spear');
      case 'fiber': case 'clothing': return (k, r) => kitTextile(k, r);
      case 'leather_clothing': return (k, r) => kitTextile(k, r, true);
      case 'rope': return kitRope;
      case 'wood_tablet': return kitTablet;
      case 'container': return kitContainer;
      case 'cooked_food': return kitCookedFood;
      case 'herbal_medicine': return kitHerbs;
      case 'charcoal': return kitCharcoal;
      case 'clay': return kitClayPile;
      case 'copper_ore': case 'tin_ore': case 'iron_ore':
        return (k, r) => kitOrePile(k, r, materialKey);
      case 'copper_charge': case 'tin_charge': case 'iron_charge': case 'steel_charge':
        return (k, r) => kitSmeltingCharge(k, r, materialKey);
      case 'copper': case 'tin': case 'bronze': case 'iron': case 'steel':
        return (k, r) => kitMetalIngotStack(k, r, materialKey);
      case 'iron_bloom': return kitIronBloom;
      case 'fired_brick': return kitFiredBrickStack;
      case 'wood_tool': case 'stone_hoe': case 'bronze_tool': case 'iron_tool':
        return (k, r) => kitProductionTools(k, r, materialKey);
      case 'steel_drive_shaft':
        return (k, r) => kitSteelDriveShaft(k, r, { active: false, fillRatio: 0 });
      case 'beam_balance': return kitBeamBalance;
      case 'standard_weight': return kitStandardWeights;
      case 'mechanical_dynamo': return kitMechanicalDynamo;
      case 'copper_conductor': return (k, r) => kitCopperConductor(k, r, false);
      case 'broken_copper_conductor': return (k, r) => kitCopperConductor(k, r, true);
      case 'resistive_load': return kitResistiveLoad;
      default: return kitBundle;
    }
  };

  const pileGroups = new Map<string, {
    cellId: number;
    z: number;
    byMaterial: Map<number, PileVisual>;
    containers: PileVisual[];
  }>();
  const pileGroup = (cellId: number, z: number) => {
    const key = `${cellId}:${z}`;
    let group = pileGroups.get(key);
    if (!group) {
      group = { cellId, z, byMaterial: new Map(), containers: [] };
      pileGroups.set(key, group);
    }
    return group;
  };
  for (const drop of society.drops) {
    const group = pileGroup(drop.cellId, drop.z);
    const existing = group.byMaterial.get(drop.materialId);
    if (existing) existing.quantity += drop.quantity;
    else group.byMaterial.set(drop.materialId, {
      materialId: drop.materialId,
      quantity: drop.quantity,
      build: pileFor(w.palette[drop.materialId]?.key),
      r: hash01(drop.cellId, 10 + drop.materialId),
    });
  }
  for (const c of society.containers) {
    if (w.palette[c.materialId]?.key === 'granary') continue;
    pileGroup(c.cellId, c.z).containers.push({
      materialId: c.materialId,
      quantity: Math.max(1, c.usedCapacity),
      build: (k, r) => kitContainer(k, r, Math.min(1, c.usedCapacity / Math.max(1, c.capacity))),
      r: hash01(c.cellId, 11),
    });
  }
  for (const group of pileGroups.values()) {
    const materialPiles = [...group.byMaterial.values()]
      .sort((a, b) => b.quantity - a.quantity || a.materialId - b.materialId);
    let visuals = [...group.containers, ...materialPiles];
    if (visuals.length > 4) {
      const kept = visuals.slice(0, 3);
      const overflow = visuals.slice(3);
      kept.push({
        materialId: -1,
        quantity: overflow.reduce((sum, visual) => sum + visual.quantity, 0),
        build: kitBundle,
        r: hash01(group.cellId, 41),
      });
      visuals = kept;
    }
    const pileR = hash01(group.cellId ^ Math.imul(w.generator.seed, 0x27d4eb2d), 52 + group.z);
    const slots = pileSlots(visuals.length, pileR, group.cellId ^ w.generator.seed);
    const x = group.cellId % w.width;
    const y = Math.floor(group.cellId / w.width);
    const centerX = x - w.width / 2 + 0.5;
    const centerZ = y - w.height / 2 + 0.5;
    visuals.forEach((visual, index) => {
      placePileInSlot(out, visual, slots[index], centerX, group.z * CELL_H, centerZ);
    });
  }

  // 建筑 → 文明印章（规模决定形制）
  const completedHouses: HouseStampRecord[] = [];
  for (const st of renderedStructures) {
    if (!st.occupiedCells.length) continue;
    const settlementStart = out.length;
    const cells = st.occupiedCells.length;
    const bounds = structureBounds(st.occupiedCells, w.width);
    if (!st.complete || !st.interiorPositions.length) {
      const groundZ = Math.min(...st.occupiedCells.map((cellId) => (
        w.elevation[cellId] - featureDepth(w, cellId, constructionCells) + 1
      )));
      let stoneComponents = 0;
      let woodComponents = 0;
      for (const cellId of st.occupiedCells) {
        const material = w.palette[w.columns[cellId].find((materialId) => {
          const candidate = w.palette[materialId];
          return candidate?.tags.includes('solid') && candidate.tags.includes('building');
        }) ?? -1];
        if (material?.key === 'stone') stoneComponents += 1;
        else if (material?.key === 'wood' || material?.key === 'plank') woodComponents += 1;
      }
      const material: ConstructionMaterialKind = stoneComponents > woodComponents ? 'stone' : 'wood';
      const build: KitBuilder = (kit, random) => kitConstructionSite(kit, random, material, st.componentCount);
      placeStructureStamp(
        out,
        build,
        bounds,
        w.width,
        w.height,
        groundZ * CELL_H,
        hash01(st.occupiedCells[0], 91) < 0.5 ? 0 : 2,
        hash01(st.occupiedCells[0], 13),
      );
      markSettlementEraLayer(out, settlementStart);
      continue;
    }
    // interiorPositions.z 是真实可站立空间的脚底高度，也是房屋应贴合的地面。
    // 不再使用最高施工体素 elevation，否则房屋会被架到屋顶上，形成假底座。
    const groundY = Math.min(...st.interiorPositions.map((position) => position.z)) * CELL_H;
    const materialKeys = (st.materialIds ?? []).map((materialId) => w.palette[materialId]?.key);
    const stoneCount = materialKeys.filter((key) => key === 'stone').length;
    const woodCount = materialKeys.filter((key) => key === 'wood' || key === 'plank').length;
    const material: StructureMaterialKind = stoneCount > woodCount ? 'stone' : woodCount > stoneCount ? 'wood' : 'mixed';
    const structureCells = new Set([...st.occupiedCells, ...st.interiorCells]);
    const hearthActive = [...structureCells].some((cellId) => (
      w.columns[cellId]?.some((materialId) => w.palette[materialId]?.key === 'fire')
    ));
    const profile: StructureVisualProfile = { ...st.effects, hearthActive };
    const usableScale = Math.max(cells, st.effects.capacity);
    const anchorCellId = Math.min(...st.occupiedCells);
    const ancientStyle = ancientHouseVisualStyle(anchorCellId, w.generator.seed);
    const build: KitBuilder = settlementStage === 'ancient'
      ? ancientStyle === 'western-medieval'
        ? (k, random) => kitMedievalHouse(k, material, profile, random)
        : (k, random) => kitAncientHouse(k, material, profile, random)
      : settlementStage === 'agrarian'
        ? (k, random) => kitAgrarianHouse(k, material, profile, random)
        : usableScale <= 1
          ? (k, random) => kitHut(k, material, profile, random)
          : usableScale <= 4
            ? (k, random) => kitHouse(k, material, profile, random)
            : (k, random) => kitHall(k, material, profile, random);
    const r = hash01(anchorCellId, 13);
    const width = bounds.maxX - bounds.minX + 1;
    const depth = bounds.maxY - bounds.minY + 1;
    const flip = r < 0.5 ? 0 : 2;
    const rot = ((depth > width ? 1 : 0) + flip) % 4;
    const placed = placeStructureStamp(out, build, bounds, w.width, w.height, groundY, rot, r, 0.16);
    if (placed) completedHouses.push({ bounds, topY: placed.topY, groundY, material });
    markSettlementEraLayer(out, settlementStart);
  }
  // 房屋串联：直接相邻的完工住宅生成共用檐廊，材质在装饰层连为一体。
  collectHouseLinks(out, completedHouses, w);

  // 动物
  for (const a of society.animals) {
    const x = a.cellId % w.width, y = Math.floor(a.cellId / w.width);
    const juvenile = a.ageBand === 'juvenile';
    const scale = juvenile ? 0.16 : a.ageBand === 'elder' ? 0.23 : 0.25;
    const speciesId = a.speciesId;
    const build: KitBuilder = speciesId === 'deer'
      ? (k, r) => kitDeer(k, r, a.sex ?? 'male', juvenile)
      : (k, r) => kitCatalogAnimal(k, speciesId, r, {
        sex: a.sex ?? 'male',
        ageBand: a.ageBand ?? 'adult',
      });
    build(new Kit(out, x - w.width / 2 + 0.5, a.z * CELL_H, y - w.height / 2 + 0.5,
      scale, 0, a.id), hashText01(a.id, 15));
  }

  return out;
}
