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
import { biomeAt, treeSpeciesAt, type BiomeKey, type TreeSpeciesKey } from './eland/world/biome';

export const MICRO_PER_CELL = 8;
export const MICRO = 1 / MICRO_PER_CELL;
const LEGACY_VOXEL_MICROS = 2;
const CELL_H = 0.3; // 与 SocietyScene3D 的 CELL_H 保持一致

export type DecorBucket =
  | 'leaf' | 'wood' | 'organicDark' | 'groundMark' | 'stone' | 'plaster' | 'thatch' | 'roofTile'
  | 'glowWarm' | 'glowRed' | 'accent' | 'dark';
export const DECOR_BUCKETS: DecorBucket[] = [
  'leaf', 'wood', 'organicDark', 'groundMark', 'stone', 'plaster', 'thatch', 'roofTile',
  'glowWarm', 'glowRed', 'accent', 'dark',
];

export interface DecorInstance {
  b: DecorBucket;
  x: number; y: number; z: number;      // 世界坐标（实例中心）
  sx: number; sy: number; sz: number;   // 实例尺寸
  ry?: number;                          // 绕世界 Y 轴旋转（弧度）；用于斜向道路等静态构件
  c: number;                            // 0xRRGGBB
  entityId?: string;                    // 动态实体 id；静态装饰不设置
  entityX?: number; entityY?: number; entityZ?: number; // 动画原点
  part?: string;                        // body / head / tail / leg-N
  animation?: 'fire' | 'wind';          // 无实体 id 的环境循环动画
}

/** 格内确定性强散列 */
function hash01(n: number, salt = 0): number {
  let v = (n ^ 0x811c9dc5 ^ Math.imul(salt + 1, 0x01000193)) >>> 0;
  v ^= v >>> 16; v = Math.imul(v, 0x7feb352d) >>> 0; v ^= v >>> 15;
  return (v >>> 0) / 0x100000000;
}

/** 颜色亮度抖动 */
function jit(hex: number, r: number): number {
  const f = 0.9 + r * 0.2;
  const cr = Math.min(255, ((hex >> 16) & 255) * f);
  const cg = Math.min(255, ((hex >> 8) & 255) * f);
  const cb = Math.min(255, (hex & 255) * f);
  return (Math.round(cr) << 16) | (Math.round(cg) << 8) | Math.round(cb);
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

function kitContainer(k: Kit, r: number): void {
  k.m('wood', 0, 0, 0, 7, 1, 7, jit(0x82552f, r));
  for (const [x, z, sx, sz] of [[-3, 0, 1, 6], [3, 0, 1, 6], [0, -3, 6, 1], [0, 3, 6, 1]] as const)
    k.m('wood', x, 1, z, sx, 4, sz, jit(0x94643b, hash01(x + z, 109)));
  k.m('organicDark', 0, 4.6, 0, 6, 0.7, 6, 0x604029);
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
function kitTribalCampPreview(k: Kit): void {
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
  k.v('glowRed', 0, 1, -1, 0xff6a55);
  k.v('glowWarm', 0, 2, 0, 0xffc37a);
  k.v('glowWarm', 0, 3, 0, 0xff9a4a);
  k.v('plaster', 0, 4, 0, 0xb9bec4);
  k.v('plaster', 1, 5, 0, 0xc9ced4);
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
function kitTemplePreview(k: Kit): void {
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
  k.v('glowWarm', 0, 10, 0, 0xffc37a);
  k.v('glowRed', 0, 11, 0, 0xff6a55);
  for (const x of [-4, 4]) {
    previewBox(k, 'stone', x, 1, 8, x, 4, 8, 0xc9b28a, 149);
    k.v('roofTile', x, 5, 8, 0x8a7652);
  }
}

/** 中世纪阶段的城堡：城墙、四座角楼、城门与主堡。 */
function kitCastlePreview(k: Kit): void {
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
  k.v('glowWarm', 0, 6, -4, 0xffc37a);
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

function kitHut(k: Kit, material: StructureMaterialKind = 'mixed'): void {
  const wallBucket: DecorBucket = material === 'stone' ? 'stone' : material === 'wood' ? 'wood' : 'plaster';
  const wallColor = material === 'stone' ? 0x8a8984 : material === 'wood' ? 0x9b6f41 : 0xb59a70;
  for (let y = 0; y <= 1; y++) for (let x = -2; x <= 1; x++) for (let z = -2; z <= 1; z++) {
    const edge = x === -2 || x === 1 || z === -2 || z === 1;
    if (!edge) continue;
    if (z === 1 && x === 0 && y === 0) continue;                 // 门洞
    k.v(wallBucket, x, y, z, jit(wallColor, hash01(x + z * 7 + y, 3)));
  }
  k.v('wood', 0, 0, 1, 0x5f422a);                               // 门
  for (let l = 0; l < 3; l++) for (let x = -3 + l; x <= 2 - l; x++) for (let z = -3 + l; z <= 2 - l; z++)
    k.v(material === 'stone' ? 'roofTile' : 'thatch', x, 2 + l, z,
      jit(material === 'stone' ? 0x5f646a : 0xd8b968, hash01(x * 3 + z + l, 4))); // 茅草/石板顶
}

function kitHouse(k: Kit, material: StructureMaterialKind = 'mixed'): void {
  const wallBucket: DecorBucket = material === 'stone' ? 'stone' : material === 'wood' ? 'wood' : 'plaster';
  const wallColor = material === 'stone' ? 0x999994 : material === 'wood' ? 0xa47645 : 0xe8e2d4;
  for (let y = 0; y <= 2; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const edge = x === -2 || x === 2 || z === -2 || z === 2;
    if (!edge) continue;
    if (z === 2 && x === 0 && y <= 1) continue;                  // 门洞
    const beam = (x === -2 || x === 2) && (z === -2 || z === 2);
    if (z === 2 && x === -1 && y === 1) { k.v('glowWarm', x, y, z, 0xffc37a); continue; }
    k.v(beam ? 'organicDark' : wallBucket, x, y, z, beam ? 0x4a3626 : jit(wallColor, hash01(x + z + y, 2)));
  }
  k.v('wood', 0, 0, 2, 0x5f422a); k.v('wood', 0, 1, 2, 0x5f422a);
  for (let l = 0; l < 3; l++) for (let x = -3; x <= 3; x++) for (let z = -3 + l; z <= 2 - l; z++)
    k.v('roofTile', x, 3 + l, z, jit(0x7a4a3a, hash01(x + z + l, 6))); // 坡屋顶
}

function kitHall(k: Kit, material: StructureMaterialKind = 'stone'): void {
  const wallBucket: DecorBucket = material === 'wood' ? 'wood' : 'stone';
  const wallColor = material === 'wood' ? 0x8f633d : 0x8a8d92;
  for (let y = 0; y <= 3; y++) for (let x = -3; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const edge = x === -3 || x === 2 || z === -2 || z === 2;
    if (!edge) continue;
    if (z === 2 && x === 0 && y <= 1) continue;
    if ((z === 2 || z === -2) && y === 2 && x % 2 === 0) { k.v('glowWarm', x, y, z, 0xffc37a); continue; }
    k.v(wallBucket, x, y, z, jit(wallColor, hash01(x * 3 + z + y, 4)));
  }
  k.v('wood', 0, 0, 2, 0x4e3822); k.v('wood', 0, 1, 2, 0x4e3822);
  for (let l = 0; l < 3; l++) for (let x = -4 + l; x <= 3 - l; x++) for (let z = -3 + l; z <= 2 - l; z++)
    k.v(material === 'wood' ? 'thatch' : 'roofTile', x, 4 + l, z,
      jit(material === 'wood' ? 0x9d743f : 0x4a4f58, hash01(x + z + l, 8)));
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

/** 将房屋印章居中拟合进权威占地，四周预留缝隙，不额外生成地基。 */
function placeStructureStamp(
  out: DecorInstance[], build: KitBuilder, bounds: StructureBounds,
  worldWidth: number, worldHeight: number, groundY: number, rot: number, r: number,
): void {
  const stamp: DecorInstance[] = [];
  build(new Kit(stamp, 0, 0, 0, 1, rot), r);
  if (!stamp.length) return;
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
  const targetWidth = bounds.maxX - bounds.minX + 1 - gap * 2;
  const targetDepth = bounds.maxY - bounds.minY + 1 - gap * 2;
  const scaleX = targetWidth / (maxX - minX);
  const scaleZ = targetDepth / (maxZ - minZ);
  // 水平可按真实矩形成为长屋；高度仅适度收缩，不再随占地无限放大。
  const scaleY = Math.max(0.72, Math.min(1, Math.min(scaleX, scaleZ)));
  for (const inst of stamp) {
    out.push({
      ...inst,
      x: targetCenterX + (inst.x - modelCenterX) * scaleX,
      y: groundY + (inst.y - minY) * scaleY,
      z: targetCenterZ + (inst.z - modelCenterZ) * scaleZ,
      sx: inst.sx * scaleX,
      sy: inst.sy * scaleY,
      sz: inst.sz * scaleZ,
    });
  }
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

function kitRabbit(k: Kit, r: number): void {
  k.v('plaster', 0, 0, 0, jit(0xc9bfa8, r), 'body'); k.v('plaster', 1, 0, 0, jit(0xc9bfa8, r), 'body');
  k.v('plaster', 0, 1, 0, 0xbfb59e, 'body');
  k.v('plaster', 1, 1, 0, 0xc9bfa8, 'head');                              // 头
  k.v('plaster', 1, 2, 0, 0xc9bfa8, 'head'); k.v('plaster', 1, 2, 1, 0xbfb59e, 'head'); // 长耳
  k.v('plaster', -1, 0, 0, 0xe8e4da, 'tail');                             // 尾
}

function kitBoar(k: Kit, r: number, sex: 'female' | 'male' = 'male', juvenile = false): void {
  for (let x = -1; x <= 1; x++) for (let z = 0; z <= 1; z++) k.v('organicDark', x, 1, z, jit(0x4a3a2c, r), 'body');
  const boarLegs = [[-1, 0], [-1, 1], [1, 0], [1, 1]] as const;
  boarLegs.forEach(([lx, lz], index) => k.v('organicDark', lx, 0, lz, 0x3a2e22, `leg-${index}`));
  for (let x = -1; x <= 1; x++) k.v('organicDark', x, 2, 0, 0x3a2e22, 'body'); // 鬃毛
  k.v('organicDark', 2, 1, 0, 0x4a3a2c, 'head');                      // 头
  k.m('organicDark', 6, 2, 0, 2.4, 2, 3, jit(0x5b4636, r), 'head'); // 吻部
  if (sex === 'male' && !juvenile) {
    k.m('plaster', 6.5, 2, -2, 1, 2, 1, 0xd8cfc0, 'head');
    k.m('plaster', 6.5, 2, 2, 1, 2, 1, 0xd8cfc0, 'head');
  }
}

function kitWolf(k: Kit, r: number): void {
  for (let x = -1; x <= 1; x++) for (let z = 0; z <= 1; z++) k.v('stone', x, 1, z, jit(0x7d8288, r), 'body');
  const wolfLegs = [[-1, 0], [-1, 1], [1, 0], [1, 1]] as const;
  wolfLegs.forEach(([lx, lz], index) => k.v('organicDark', lx, 0, lz, 0x4a4f58, `leg-${index}`));
  k.v('stone', 2, 1, 0, 0x7d8288, 'head'); k.v('stone', 2, 2, 0, 0x84888d, 'head'); // 头
  k.v('organicDark', 2, 3, 0, 0x4a4f58, 'head');                      // 耳
  k.v('stone', -2, 2, 0, 0x7d8288, 'tail');                          // 尾
}

/* ------------------------------------------------------------------ */
/* 世界扫描                                                             */
/* ------------------------------------------------------------------ */

const SURFACE_REPLACEMENT_DECOR = new Set([
  'shrub', 'berry_bush', 'crop_sprout', 'crop_mature', 'packed_soil', 'fire',
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
  return Math.max(depth, overheadDepth, constructionDepth);
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

/**
 * 向一个道路格追加 8×8 微体素夯土带。
 *
 * 素材库和生产场景都以“一地图格八微体素”为基准：方向决定格内中心线，微体素只负责
 * 把中心线栅格化为连续泥面。这样斜路仍保留体素阶梯感，不再出现旋转薄片的接缝和板材感。
 */
export function appendDirtPathCell(
  out: DecorInstance[], centerX: number, groundY: number, centerZ: number,
  connections: readonly DirtPathDirection[], r: number,
): void {
  const seed = Math.floor(r * 0x7fffffff);
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
    if (opposite) {
      centerLines.push([edge(a), edge(b)]);
    } else {
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
      if (!insideRibbon && !insideJunction) continue;
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
    });
  }
}

/** 扫描权威状态，产出全部装饰实例（每月状态刷新时调用一次） */
export function collectDecor(society: SocietyState, era: EraKey): DecorInstance[] {
  const w = society.world;
  const out: DecorInstance[] = [];
  const cold = era === 'frozen' || era === 'chaotic-cold' || society.weather?.kind === 'snow';
  const scorched = era === 'burned' || era === 'extinct';
  const COUNT = w.width * w.height;
  const constructionCells = new Set(society.structures.flatMap((structure) => structure.occupiedCells));
  const storm = society.weather?.kind === 'storm';
  const drought = society.weather?.kind === 'drought';

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
    const markWind = (start: number) => {
      if (!storm) return;
      for (let index = start; index < out.length; index++) {
        if (out[index].b === 'leaf' || out[index].b === 'wood') out[index].animation = 'wind';
      }
    };
    const kit = (build: KitBuilder) => {
      const start = out.length;
      build(new Kit(out, wx, gt, wz, 1, Math.floor(r * 4)), r);
      markWind(start);
    };
    const smallOffset = quarterCellOffset(hash01(id ^ w.generator.seed, 78), id ^ w.generator.seed);
    const smallKit = (build: KitBuilder, scale = 0.46) => {
      const start = out.length;
      build(new Kit(out, wx + smallOffset.x, gt, wz + smallOffset.z, scale, Math.floor(r * 4)), r);
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
      default:
        break;
    }
  }

  // 泥土小径直接绑定权威 PackedSoil 地表；trail 区域仅用于兼容旧投影和历史存档。
  const trailCells = new Set(society.regions.filter((region) => region.kind === 'trail').flatMap((region) => region.cells));
  for (let id = 0; id < COUNT; id++) if (w.palette[w.surface[id]]?.key === 'packed_soil') trailCells.add(id);
  for (const id of trailCells) {
    if (id < 0 || id >= COUNT) continue;
    const x = id % w.width, y = Math.floor(id / w.width);
    const connections = dirtPathConnections(trailCells, w.width, w.height, w.elevation, id);
    const depth = featureDepth(w, id, constructionCells);
    const groundY = (w.elevation[id] - depth + 1) * CELL_H;
    appendDirtPathCell(
      out,
      x - w.width / 2 + 0.5,
      groundY,
      y - w.height / 2 + 0.5,
      connections,
      hash01(id ^ w.generator.seed, 5),
    );
  }

  // 掉落物 / 容器 → 同格聚合物资堆
  const pileFor = (materialKey: string | undefined): KitBuilder =>
    materialKey === 'wood' || materialKey === 'plank' ? kitWoodpile
      : materialKey === 'stone' ? kitStonepile
        : materialKey === 'food' ? kitFoodpile
          : materialKey === 'seed' ? kitSeedpile
            : materialKey === 'raw_meat' ? kitMeat
              : materialKey === 'hide' ? kitHide
                : materialKey === 'bone' ? kitBonePile
                  : materialKey === 'stone_tool' ? (k, r) => kitToolRack(k, r, 'stone')
                    : materialKey === 'bone_tool' ? (k, r) => kitToolRack(k, r, 'bone')
                      : materialKey === 'spear' ? (k, r) => kitToolRack(k, r, 'spear')
                        : materialKey === 'fiber' || materialKey === 'clothing' ? (k, r) => kitTextile(k, r)
                          : materialKey === 'leather_clothing' ? (k, r) => kitTextile(k, r, true)
                            : materialKey === 'rope' ? kitRope
                              : materialKey === 'wood_tablet' ? kitTablet
                                : materialKey === 'container' ? kitContainer
                                  : materialKey === 'cooked_food' ? kitCookedFood
                                    : materialKey === 'herbal_medicine' ? kitHerbs
                                      : materialKey === 'charcoal' ? kitCharcoal : kitBundle;

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
    pileGroup(c.cellId, c.z).containers.push({
      materialId: c.materialId,
      quantity: Math.max(1, c.usedCapacity),
      build: kitContainer,
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
  for (const st of society.structures) {
    if (!st.occupiedCells.length) continue;
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
      continue;
    }
    // interiorPositions.z 是真实可站立空间的脚底高度，也是房屋应贴合的地面。
    // 不再使用最高施工体素 elevation，否则房屋会被架到屋顶上，形成假底座。
    const groundY = Math.min(...st.interiorPositions.map((position) => position.z)) * CELL_H;
    const materialKeys = (st.materialIds ?? []).map((materialId) => w.palette[materialId]?.key);
    const stoneCount = materialKeys.filter((key) => key === 'stone').length;
    const woodCount = materialKeys.filter((key) => key === 'wood' || key === 'plank').length;
    const material: StructureMaterialKind = stoneCount > woodCount ? 'stone' : woodCount > stoneCount ? 'wood' : 'mixed';
    const build: KitBuilder = cells <= 1
      ? (k) => kitHut(k, material)
      : cells <= 4 ? (k) => kitHouse(k, material) : (k) => kitHall(k, material);
    const r = hash01(st.occupiedCells[0], 13);
    const width = bounds.maxX - bounds.minX + 1;
    const depth = bounds.maxY - bounds.minY + 1;
    const flip = r < 0.5 ? 0 : 2;
    const rot = ((depth > width ? 1 : 0) + flip) % 4;
    placeStructureStamp(out, build, bounds, w.width, w.height, groundY, rot, r);
  }

  // 动物
  for (const a of society.animals) {
    const x = a.cellId % w.width, y = Math.floor(a.cellId / w.width);
    const juvenile = a.ageBand === 'juvenile';
    const scale = juvenile ? 0.16 : a.ageBand === 'elder' ? 0.23 : 0.25;
    const build: KitBuilder = a.speciesId === 'deer'
      ? (k, r) => kitDeer(k, r, a.sex ?? 'male', juvenile)
      : a.speciesId === 'rabbit' ? kitRabbit
        : a.speciesId === 'boar' ? (k, r) => kitBoar(k, r, a.sex ?? 'male', juvenile) : kitWolf;
    build(new Kit(out, x - w.width / 2 + 0.5, a.z * CELL_H, y - w.height / 2 + 0.5,
      scale, 0, a.id), hash01(a.cellId, 15));
  }

  return out;
}
