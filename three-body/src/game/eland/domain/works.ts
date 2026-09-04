import type { MaterialId } from './material';
import { materialDefinition, materialHas } from './material';
import type { PersonId } from './person';
import { cellId, cellX, cellY, neighbors4, setVoxel, voxelAt, type VoxelWorld } from '../world/grid';
import { seededFraction } from '../world/generator';

/**
 * Works：人物用自由交互亲手造出的复合实体。
 *
 * 设计边界（与全局架构一致）：
 * - 模型只提议"把哪些真实材料按哪种物理基元排布"，实体是否存在由规则校验；
 * - profile 是组件材料、数量与排布方式的确定性纯函数，不是隐藏的成品配方；
 * - 实体锚定一个真实体素（3D 渲染与体素物理免费获得），身份、来源与状态轨迹
 *   保存在实体上，因而可以被加件、被观察、衰减和塌落；
 * - 时代门槛与项目系统只认既有设施体素；Works 影响生存与社会，不解锁时代。
 */

export const WORK_SCHEMA_VERSION = 'works-v1' as const;

/** 物理形态基元。开放但受控：每个基元只有几何含义，不对应任何成品。 */
export const WORK_ARRANGEMENTS = ['support', 'pile', 'lash', 'form'] as const;
export type WorkArrangement = typeof WORK_ARRANGEMENTS[number];

export const WORK_ARRANGEMENT_NAMES: Record<WorkArrangement, string> = {
  support: '倚靠支立',
  pile: '堆叠',
  lash: '捆扎',
  form: '捏塑',
};

export interface WorkComponent {
  materialId: MaterialId;
  quantity: number;
}

export interface WorkProfile {
  /** 遮蔽贡献：防风防雨能力（0..100）。 */
  cover: number;
  /** 抗形变能力（0..100）。 */
  rigidity: number;
  /** 抗倾倒能力（0..100）。 */
  stability: number;
}

export interface WorkState {
  version: typeof WORK_SCHEMA_VERSION;
  id: string;
  position: { x: number; y: number; z: number };
  arrangement: WorkArrangement;
  components: WorkComponent[];
  /** 结构状态 0..100；低于塌落阈值时解体，组件回落为掉落物。 */
  condition: number;
  profile: WorkProfile;
  /** 锚点体素的材料（实体的物理身体，渲染与体素判定共用）。 */
  anchorMaterialId: MaterialId;
  summary: string;
  builderIds: PersonId[];
  createdAtMonth: number;
  lastTouchedAtMonth: number;
  sourceEventIds: string[];
}

export const WORK_COLLAPSE_CONDITION = 25;
export const WORK_SHELTER_COVER_THRESHOLD = 55;
const MAX_WORKS = 128;
const MAX_WORK_SOURCE_EVENTS = 16;
const MAX_WORK_COMPONENTS = 12;

export function workIdAt(position: { x: number; y: number; z: number }): string {
  return `work:${position.x}:${position.y}:${position.z}`;
}

export function workById(
  world: { works?: WorkState[] },
  id: string,
): WorkState | undefined {
  return world.works?.find((work) => work.id === id);
}

export function workAt(
  world: { works?: WorkState[] },
  position: { x: number; y: number; z: number },
): WorkState | undefined {
  return workById(world, workIdAt(position));
}

export function workCell(work: WorkState): number {
  return cellId(work.position.x, work.position.y);
}

/**
 * profile 是组件与排布的确定性函数：刚性来自固体的硬度，柔性来自纤维，
 * 稳定来自质量。排布方式只改变各项的转化系数，不产生任何新材料或成品。
 */
export function deriveWorkProfile(
  arrangement: WorkArrangement,
  components: readonly WorkComponent[],
): WorkProfile {
  let rigid = 0;
  let flexible = 0;
  let mass = 0;
  for (const component of components) {
    const definition = materialDefinition(component.materialId);
    const quantity = Math.max(0, Math.min(24, component.quantity));
    if (definition.tags.includes('fiber')) {
      flexible += quantity;
    } else if (definition.phase === 'solid') {
      rigid += quantity * Math.max(1, definition.hardness / 4);
    }
    mass += quantity * Math.max(0.05, definition.mass);
  }
  const clamp100 = (value: number) => Math.min(100, Math.round(value));
  if (arrangement === 'support') {
    return {
      cover: clamp100(rigid * 9 + flexible * 6),
      rigidity: clamp100(rigid * 7 + flexible * 8),
      stability: clamp100(mass * 5 + rigid * 3),
    };
  }
  if (arrangement === 'pile') {
    return {
      cover: clamp100(rigid * 4),
      rigidity: clamp100(rigid * 3),
      stability: clamp100(mass * 8),
    };
  }
  if (arrangement === 'lash') {
    return {
      cover: clamp100(rigid * 6 + flexible * 3),
      rigidity: clamp100(rigid * 5 + flexible * 11),
      stability: clamp100(mass * 3 + rigid * 4),
    };
  }
  return {
    cover: 0,
    rigidity: clamp100(rigid * 6 + mass * 2),
    stability: clamp100(mass * 6),
  };
}

function mergeComponents(
  left: readonly WorkComponent[],
  right: readonly WorkComponent[],
): WorkComponent[] {
  const merged = new Map<MaterialId, number>();
  for (const component of [...left, ...right]) {
    merged.set(component.materialId, Math.min(24, (merged.get(component.materialId) ?? 0) + component.quantity));
  }
  return [...merged]
    .map(([materialId, quantity]) => ({ materialId, quantity }))
    .sort((a, b) => a.materialId - b.materialId)
    .slice(0, MAX_WORK_COMPONENTS);
}

/** 锚点体素材料：数量×硬度最高的组件，即实体"看起来主要是什么"。 */
export function dominantWorkMaterial(components: readonly WorkComponent[]): MaterialId | undefined {
  let best: { materialId: MaterialId; score: number } | undefined;
  for (const component of components) {
    const definition = materialDefinition(component.materialId);
    if (definition.phase !== 'solid') continue;
    const score = component.quantity * Math.max(1, definition.hardness);
    if (!best || score > best.score) best = { materialId: component.materialId, score };
  }
  return best?.materialId;
}

export function createWork(
  input: {
    position: { x: number; y: number; z: number };
    arrangement: WorkArrangement;
    components: readonly WorkComponent[];
    summary: string;
    builderId: PersonId;
    atMonth: number;
    sourceEventId: string;
  },
  existing?: WorkState[],
): WorkState {
  const components = mergeComponents([], input.components);
  return {
    version: WORK_SCHEMA_VERSION,
    id: workIdAt(input.position),
    position: { ...input.position },
    arrangement: input.arrangement,
    components,
    condition: 100,
    profile: deriveWorkProfile(input.arrangement, components),
    anchorMaterialId: dominantWorkMaterial(components) ?? components[0]?.materialId ?? 0,
    summary: input.summary.slice(0, 120),
    builderIds: [input.builderId],
    createdAtMonth: input.atMonth,
    lastTouchedAtMonth: input.atMonth,
    sourceEventIds: [input.sourceEventId],
  };
}

export function modifyWork(
  work: WorkState,
  input: {
    components: readonly WorkComponent[];
    arrangement?: WorkArrangement;
    summary?: string;
    builderId: PersonId;
    atMonth: number;
    sourceEventId: string;
  },
): WorkState {
  const components = mergeComponents(work.components, input.components);
  const arrangement = input.arrangement ?? work.arrangement;
  return {
    ...work,
    arrangement,
    components,
    condition: Math.min(100, work.condition + 8),
    profile: deriveWorkProfile(arrangement, components),
    anchorMaterialId: dominantWorkMaterial(components) ?? work.anchorMaterialId,
    summary: input.summary?.slice(0, 120) ?? work.summary,
    builderIds: work.builderIds.includes(input.builderId)
      ? work.builderIds
      : [...work.builderIds, input.builderId].slice(-6),
    lastTouchedAtMonth: input.atMonth,
    sourceEventIds: [...work.sourceEventIds, input.sourceEventId].slice(-MAX_WORK_SOURCE_EVENTS),
  };
}

export function registerWork(world: { works?: WorkState[] }, work: WorkState): void {
  world.works ??= [];
  world.works = world.works.filter((existing) => existing.id !== work.id);
  world.works.push(work);
  if (world.works.length > MAX_WORKS) {
    world.works = world.works
      .sort((a, b) => b.lastTouchedAtMonth - a.lastTouchedAtMonth || b.condition - a.condition)
      .slice(0, MAX_WORKS);
  }
}

/**
 * Works 提供的遮蔽：同一格或邻格、高差不超过 1、状态尚可的实体，
 * 取 cover 最高者。避在棚架旁边与躲进棚架下在 v1 一视同仁。
 */
export function workShelterCoverAt(
  world: { grid: VoxelWorld; works?: WorkState[] },
  position: { cellId: number; z: number },
): number {
  if (!world.works?.length) return 0;
  const cells = [position.cellId, ...neighbors4(position.cellId)];
  let best = 0;
  for (const work of world.works) {
    if (work.condition < WORK_COLLAPSE_CONDITION) continue;
    if (!cells.includes(workCell(work))) continue;
    if (Math.abs(work.position.z - position.z) > 1) continue;
    best = Math.max(best, work.profile.cover);
  }
  return best;
}

/**
 * 月度衰减：雨雪加速有机材料老化； condition 归零前塌落为真实掉落物。
 * 返回塌落实体的数量（事件由调用方按既有模式记录）。
 */
export function advanceWorksMonth(
  world: {
    grid: VoxelWorld;
    works?: WorkState[];
    drops: Array<{
      id: string;
      materialId: MaterialId;
      cellId: number;
      z: number;
      quantity: number;
      sourceEventIds: string[];
      createdAtMonth: number;
    }>;
  },
  input: {
    seed: number;
    atMonth: number;
    weatherKind: string;
    makeDropId: (work: WorkState, component: WorkComponent) => string;
  },
): { decayed: number; collapsed: WorkState[] } {
  if (!world.works?.length) return { decayed: 0, collapsed: [] };
  const wet = input.weatherKind === 'rain' || input.weatherKind === 'storm' || input.weatherKind === 'snow';
  const collapsed: WorkState[] = [];
  let decayed = 0;
  const survivors: WorkState[] = [];
  for (const work of world.works) {
    let organic = 0;
    let mineral = 0;
    for (const component of work.components) {
      const definition = materialDefinition(component.materialId);
      if (definition.tags.includes('plant') || definition.tags.includes('fiber')
        || materialHas(component.materialId, 'edible')) organic += component.quantity;
      else mineral += component.quantity;
    }
    const decayRate = (organic * (wet ? 1.6 : 0.7) + mineral * 0.15) / Math.max(1, organic + mineral);
    const jitter = seededFraction(input.seed, `work-decay:${input.atMonth}:${work.id}`) * 0.6;
    const condition = Math.max(0, work.condition - decayRate * (2.2 + jitter));
    if (condition <= WORK_COLLAPSE_CONDITION) {
      collapsed.push({ ...work, condition });
      for (const component of work.components) {
        const quantity = Math.floor(component.quantity / 2);
        if (quantity < 1) continue;
        world.drops.push({
          id: input.makeDropId(work, component),
          materialId: component.materialId,
          cellId: workCell(work),
          z: work.position.z,
          quantity,
          sourceEventIds: [...work.sourceEventIds.slice(-4)],
          createdAtMonth: input.atMonth,
        });
      }
      // 锚点体素随塌落消失，归还为空位，不产生新物质。
      if (voxelAt(world.grid, work.position.x, work.position.y, work.position.z) === work.anchorMaterialId) {
        setVoxel(world.grid, work.position.x, work.position.y, work.position.z, 0);
      }
      continue;
    }
    if (condition !== work.condition) decayed += 1;
    survivors.push({ ...work, condition });
  }
  world.works = survivors;
  return { decayed, collapsed };
}
