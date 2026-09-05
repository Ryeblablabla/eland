import type { MaterialId } from './material';
import { materialDefinition, materialHas } from './material';
import type { PersonId } from './person';
import type { EnvironmentFact } from './model';
import { workOccupiedVoxels, type WorkLayout } from './work-layout';
import { cellId, setVoxel, voxelAt, type VoxelWorld } from '../world/grid';
import { seededFraction } from '../world/generator';

/**
 * Works：人物用自由交互亲手造出的复合实体。
 *
 * 设计边界（与全局架构一致）：
 * - 模型只提议"把哪些真实材料按哪种物理基元排布"，实体是否存在由规则校验；
 * - profile 是组件材料、数量与排布方式的确定性纯函数，不是隐藏的成品配方；
 * - 实体锚定一个真实体素（3D 渲染与体素物理免费获得），身份、来源与状态轨迹
 *   保存在实体上，因而可以被加件、被观察、衰减和塌落；
 * - 造物的名字、意图和建造本身都不是功能证据；只有可回放的真实使用
 *   或示范回执，才能让观察器把它当成文明实践。
 */

export const WORK_SCHEMA_VERSION = 'works-v1' as const;
export const WORK_USE_RECEIPT_VERSION = 'work-use-receipt-v1' as const;

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
  /** 材料的遮蔽潜力（0..100）；实际庇护取决于占用体素形成的几何。 */
  cover: number;
  /** 抗形变能力（0..100）。 */
  rigidity: number;
  /** 抗倾倒能力（0..100）。 */
  stability: number;
}

export type WorkUseKind = 'use' | 'demonstration';

/**
 * 一次对造物功能的可回放承认。
 *
 * `functionKey` 是一次已发生行为的开放语义，不是预置设施类型；文明
 * 观察器只计数重复使用、持续存在和人际传播，不会按该字符串解锁能力。
 * `evidencePaths` 指向来源 ActionFact 中真正提交的结果（例如
 * `diff.appliedEffects`），避免把叙事性 result 当成世界变化。
 */
export interface WorkUseReceipt {
  version: typeof WORK_USE_RECEIPT_VERSION;
  id: string;
  workId: string;
  kind: WorkUseKind;
  functionKey: string;
  actorId: PersonId;
  witnessIds: PersonId[];
  atMonth: number;
  sourceEventId: string;
  evidencePaths: string[];
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
  /** Committed material occupancy; absence means only the single anchor voxel. */
  layout?: WorkLayout;
  summary: string;
  builderIds: PersonId[];
  createdAtMonth: number;
  lastTouchedAtMonth: number;
  sourceEventIds: string[];
  /** 只由已提交行为写入；旧存档可没有该折叠。 */
  useReceipts?: WorkUseReceipt[];
}

export const WORK_COLLAPSE_CONDITION = 25;
const MAX_WORK_SOURCE_EVENTS = 16;
const MAX_WORK_USE_RECEIPTS = 96;
const MAX_WORK_USE_WITNESSES = 24;
const MAX_WORK_EVIDENCE_PATHS = 8;

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
  return world.works?.find((work) => workOccupiedVoxels(work).some((voxel) => voxel.position.x === position.x
    && voxel.position.y === position.y && voxel.position.z === position.z));
}

export function workCell(work: WorkState): number {
  return cellId(work.position.x, work.position.y);
}

export type ReplayableWorkUseAction = {
  id: string;
  kind: 'action';
  atMonth: number;
  who: PersonId;
  cellId: number;
  toCellId: number;
  pathSegment: number[];
  status: 'progressed' | 'completed' | 'blocked' | 'failed';
  action: unknown;
  diff: Record<string, unknown>;
};

export interface WorkAdoptionObservation {
  workId: string;
  active: boolean;
  receipts: WorkUseReceipt[];
  userIds: PersonId[];
  witnessIds: PersonId[];
  functionKeys: string[];
  firstUsedAtMonth: number | null;
  lastUsedAtMonth: number | null;
  useSpanMonths: number;
  survivingMonths: number;
}

function normalizedUniqueStrings(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function meaningfulEvidence(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function physicalActionUseEvidencePaths(event: ReplayableWorkUseAction): string[] {
  const action = event.action as { kind?: string } | undefined;
  if (action?.kind === 'world-interact') {
    return (Array.isArray(event.diff.appliedEffects) ? event.diff.appliedEffects : []).flatMap((value, index) => {
      if (!value || typeof value !== 'object') return [];
      const effect = value as { kind?: string; delta?: number };
      const physical = ['produce', 'relocate', 'replace-voxel'].includes(effect.kind ?? '')
        || (effect.kind === 'body' && typeof effect.delta === 'number' && effect.delta !== 0);
      return physical ? [`diff.appliedEffects.${index}`] : [];
    });
  }
  if (action?.kind !== 'act' && action?.kind !== 'transfer') return [];
  return ['outputStackId', 'outputDropId', 'outputMaterialId', 'quantity', 'healthDelta', 'hydrationDelta', 'nutritionDelta', 'electricalPowerDelivered', 'mechanicalPowerOperation']
    .filter((key) => meaningfulEvidence(event.diff[key]) && event.diff[key] !== false && event.diff[key] !== 0)
    .map((key) => `diff.${key}`);
}

/**
 * 把已提交的行为挂到造物上。这个函数不接受“成功了”之类自由断言：
 * 调用方必须指出事件里哪些结构化字段承载了实际结果。
 */
export function recordWorkUse(
  world: { works?: WorkState[] },
  input: {
    workId: string;
    kind: WorkUseKind;
    functionKey: string;
    actorId: PersonId;
    witnessIds?: readonly PersonId[];
    atMonth: number;
    sourceEventId: string;
    evidencePaths: readonly string[];
  },
): WorkUseReceipt {
  const work = workById(world, input.workId);
  if (!work) throw new Error(`造物 ${input.workId} 不存在，不能记录使用`);
  const functionKey = input.functionKey.trim().slice(0, 120);
  const evidencePaths = normalizedUniqueStrings(input.evidencePaths, MAX_WORK_EVIDENCE_PATHS);
  const witnessIds = normalizedUniqueStrings(input.witnessIds ?? [], MAX_WORK_USE_WITNESSES);
  if (!functionKey || !input.sourceEventId.trim() || !evidencePaths.length) {
    throw new Error('造物使用回执必须指向具体功能、来源事件和实际结果字段');
  }
  if (!Number.isSafeInteger(input.atMonth) || input.atMonth < work.createdAtMonth) {
    throw new Error('造物使用回执的月份早于它的建造时间');
  }
  if (input.kind === 'demonstration' && !witnessIds.length) {
    throw new Error('示范回执必须有至少一名见证者');
  }
  const id = `work-use:${work.id}:${encodeURIComponent(input.sourceEventId)}:${input.kind}`;
  const receipt: WorkUseReceipt = {
    version: WORK_USE_RECEIPT_VERSION,
    id,
    workId: work.id,
    kind: input.kind,
    functionKey,
    actorId: input.actorId,
    witnessIds,
    atMonth: input.atMonth,
    sourceEventId: input.sourceEventId,
    evidencePaths,
  };
  work.useReceipts = [...(work.useReceipts ?? []).filter((existing) => (
    existing.id !== id && existing.sourceEventId !== input.sourceEventId
  )), receipt]
    .sort((left, right) => left.atMonth - right.atMonth || left.id.localeCompare(right.id))
    .slice(-MAX_WORK_USE_RECEIPTS);
  return receipt;
}

function shelterUseEvidence(event: EnvironmentFact): { workIds: string[] } | undefined {
  const use = event.diff.shelterUse as Record<string, unknown> | undefined;
  if (event.change !== 'body' || !event.who || !use || !Array.isArray(use.workIds)) return undefined;
  const reduced = (typeof use.coldLoadWithoutShelter === 'number' && typeof use.coldLoad === 'number'
      && use.coldLoadWithoutShelter > use.coldLoad)
    || (typeof use.heatLoadWithoutShelter === 'number' && typeof use.heatLoad === 'number'
      && use.heatLoadWithoutShelter > use.heatLoad);
  return reduced ? { workIds: use.workIds.filter((id): id is string => typeof id === 'string') } : undefined;
}

/** Physical exposure settlement supplies the receipt, independently of anyone's claim. */
export function recordWorkShelterUse(
  world: { works?: WorkState[] },
  event: EnvironmentFact,
): WorkUseReceipt[] {
  const use = shelterUseEvidence(event);
  if (!use || !event.who) return [];
  return use.workIds.flatMap((workId) => workById(world, workId) ? [recordWorkUse(world, {
    workId, kind: 'use', functionKey: 'thermal-protection', actorId: event.who!,
    atMonth: event.atMonth, sourceEventId: event.id, evidencePaths: ['diff.shelterUse'],
  })] : []);
}

/**
 * 从权威事件回放造物的采用情况。失败行为、建造行为本身、纯文本断言、
 * 无法在来源事件中核对的见证者，都不会被算成使用或传播。
 */
export function observeWorkAdoption(
  work: WorkState,
  events: readonly (ReplayableWorkUseAction | EnvironmentFact)[],
  atMonth: number,
): WorkAdoptionObservation {
  const byId = new Map(events.map((event) => [event.id, event]));
  const receipts = (work.useReceipts ?? []).flatMap((receipt) => {
    const event = byId.get(receipt.sourceEventId);
    if (receipt.version !== WORK_USE_RECEIPT_VERSION
      || receipt.workId !== work.id
      || !event
      || event.who !== receipt.actorId
      || event.atMonth !== receipt.atMonth
      || event.atMonth < work.createdAtMonth) return [];
    if (event.kind === 'environment') {
      const use = shelterUseEvidence(event);
      return use?.workIds.includes(work.id) && receipt.functionKey === 'thermal-protection'
        && receipt.evidencePaths.includes('diff.shelterUse') ? [{ ...receipt, witnessIds: [] }] : [];
    }
    // Existing ActionFact receipts from earlier versions used co-occurrence,
    // references or proximity as evidence. They do not prove causal use and
    // must not survive replay merely because the cached receipt still exists.
    return [];
  });
  const months = receipts.map((receipt) => receipt.atMonth).sort((left, right) => left - right);
  return {
    workId: work.id,
    active: work.condition > WORK_COLLAPSE_CONDITION,
    receipts,
    userIds: [...new Set(receipts.map((receipt) => receipt.actorId))],
    witnessIds: [...new Set(receipts.flatMap((receipt) => receipt.witnessIds))],
    functionKeys: [...new Set(receipts.map((receipt) => receipt.functionKey))],
    firstUsedAtMonth: months[0] ?? null,
    lastUsedAtMonth: months.at(-1) ?? null,
    useSpanMonths: months.length ? (months.at(-1) ?? months[0]) - months[0] + 1 : 0,
    survivingMonths: Math.max(0, atMonth - work.createdAtMonth + 1),
  };
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
    merged.set(component.materialId, (merged.get(component.materialId) ?? 0) + component.quantity);
  }
  return [...merged]
    .map(([materialId, quantity]) => ({ materialId, quantity }))
    .sort((a, b) => a.materialId - b.materialId);
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
    layout?: WorkLayout;
  },
): WorkState {
  const components = mergeComponents([], input.components);
  return {
    version: WORK_SCHEMA_VERSION,
    id: `work:${input.sourceEventId}`,
    position: { ...input.position },
    arrangement: input.arrangement,
    components,
    condition: 100,
    profile: deriveWorkProfile(input.arrangement, components),
    anchorMaterialId: input.layout?.voxels.find((voxel) => voxel.offset.x === 0 && voxel.offset.y === 0 && voxel.offset.z === 0)?.materialId
      ?? dominantWorkMaterial(components) ?? components[0]?.materialId ?? 0,
    ...(input.layout ? { layout: structuredClone(input.layout) } : {}),
    summary: input.summary.slice(0, 120),
    builderIds: [input.builderId],
    createdAtMonth: input.atMonth,
    lastTouchedAtMonth: input.atMonth,
    sourceEventIds: [input.sourceEventId],
    useReceipts: [],
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
    layout?: WorkLayout;
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
    anchorMaterialId: (input.layout ?? work.layout)?.voxels.find((voxel) => voxel.offset.x === 0 && voxel.offset.y === 0 && voxel.offset.z === 0)?.materialId
      ?? work.anchorMaterialId,
    ...(input.layout ? { layout: structuredClone(input.layout) } : {}),
    summary: input.summary?.slice(0, 120) ?? work.summary,
    builderIds: work.builderIds.includes(input.builderId)
      ? work.builderIds
      : [...work.builderIds, input.builderId],
    lastTouchedAtMonth: input.atMonth,
    sourceEventIds: [...work.sourceEventIds, input.sourceEventId].slice(-MAX_WORK_SOURCE_EVENTS),
  };
}

export function registerWork(world: { works?: WorkState[] }, work: WorkState): void {
  world.works ??= [];
  world.works = world.works.filter((existing) => existing.id !== work.id
    && (existing.position.x !== work.position.x || existing.position.y !== work.position.y
      || existing.position.z !== work.position.z));
  world.works.push(work);
  // Living physical entities are world state, not an LRU cache. Only actual
  // dismantling or collapse may remove a work or its invested components.
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
    const intact = voxelAt(world.grid, work.position.x, work.position.y, work.position.z) === work.anchorMaterialId;
    const condition = intact ? Math.max(0, work.condition - decayRate * (2.2 + jitter)) : 0;
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
      for (const voxel of workOccupiedVoxels(work)) {
        if (voxelAt(world.grid, voxel.position.x, voxel.position.y, voxel.position.z) === voxel.materialId) {
          setVoxel(world.grid, voxel.position.x, voxel.position.y, voxel.position.z, 0);
        }
      }
      continue;
    }
    if (condition !== work.condition) decayed += 1;
    survivors.push({ ...work, condition });
  }
  world.works = survivors;
  return { decayed, collapsed };
}
