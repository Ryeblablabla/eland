import { BASE_ACTIVITY_EPISODE_WORK_EFFORT, physicalWorkCapacityMultiplier, type PhysicalWorkCapacitySnapshot } from './calendar';
import { Material, materialDefinition, type MaterialId, type MaterialPerceptualForm } from './material';

export const ITEM_MECHANICS_VERSION = 'item-mechanics-v1' as const;

/** Each state describes one material portion, including all of its fragments. */
export interface ItemMechanicalState {
  version: typeof ITEM_MECHANICS_VERSION;
  geometry: { length: number; thickness: number };
  segments: Array<{ massFraction: number; residualBend: number; damage: number }>;
  cumulativeWork: number;
  sourceEventIds: string[];
}

export interface MaterialBendProfile {
  family: string;
  bendStiffness: number;
  yieldBend: number;
  fractureBend: number;
  hardening: number;
  geometry: ItemMechanicalState['geometry'];
}

/**
 * These are game constitutive parameters in normalized load/length/work units,
 * NOT SI constants or measurements of real wood. Hardness is deliberately not
 * used as an elastic modulus. They govern an already chosen physical attempt,
 * never action selection, civilisation rewards or guaranteed craft outputs.
 * One portion has a nominal shape; quantity counts portions, not beam length.
 */
const FAMILIES = {
  wood: { bendStiffness: 16, yieldBend: 0.10, fractureBend: 0.55, hardening: 0.5 },
  mineral: { bendStiffness: 70, yieldBend: 0.018, fractureBend: 0.022, hardening: 0.8 },
  ice: { bendStiffness: 14, yieldBend: 0.025, fractureBend: 0.03, hardening: 0.8 },
  bone: { bendStiffness: 32, yieldBend: 0.06, fractureBend: 0.13, hardening: 0.6 },
  metal: { bendStiffness: 45, yieldBend: 0.035, fractureBend: 0.8, hardening: 0.3 },
  pliable: { bendStiffness: 0.3, yieldBend: 0.03, fractureBend: 0.6, hardening: 0.15 },
  fibre: { bendStiffness: 0.5, yieldBend: 0.65, fractureBend: 1.8, hardening: 0.5 },
} as const;

const GEOMETRIES: Partial<Record<MaterialPerceptualForm, ItemMechanicalState['geometry']>> = {
  'structural-member': { length: 1, thickness: 0.2 },
  'compact-body': { length: 0.5, thickness: 0.4 },
  'shaped-object': { length: 0.7, thickness: 0.25 },
  'flexible-strand': { length: 1, thickness: 0.06 },
  'flexible-sheet': { length: 1, thickness: 0.08 },
};

export function materialBendProfile(materialId: MaterialId): MaterialBendProfile | undefined {
  const material = materialDefinition(materialId);
  if (material.phase !== 'solid') return undefined;
  const family = [Material.Wood, Material.Plank, Material.WoodTablet].some((id) => id === materialId) ? 'wood'
    : material.tags.includes('metal') ? 'metal'
    : materialId === Material.Ice ? 'ice'
    : materialId === Material.Bone ? 'bone'
    : materialId === Material.Stone || materialId === Material.FiredBrick || material.tags.includes('ore') ? 'mineral'
    : [Material.Clay, Material.Food, Material.RawMeat, Material.CookedFood].some((id) => id === materialId) ? 'pliable'
    : [Material.Fiber, Material.Rope, Material.Hide, Material.Leaves, Material.Clothing].some((id) => id === materialId) ? 'fibre'
    : undefined;
  const geometry = GEOMETRIES[material.perceptual?.form ?? 'compact-body'];
  return family && geometry ? { family, ...FAMILIES[family], geometry: { ...geometry } } : undefined;
}

/** Neutral locomotion isolates the existing bodily/condition multipliers. */
export function handBendLoad(snapshot: Omit<PhysicalWorkCapacitySnapshot, 'locomotion'> & { manipulation: number; health: number }): number {
  const healthyBaseline = physicalWorkCapacityMultiplier({ locomotion: 50, hydration: 100, nutrition: 100, conditions: [] });
  const body = physicalWorkCapacityMultiplier({ ...snapshot, locomotion: 50 }) / healthyBaseline;
  return Math.max(0, Math.min(100, snapshot.manipulation)) / 25
    * Math.max(0, Math.min(100, snapshot.health)) / 100 * body;
}

export function initialItemMechanicalState(profile: MaterialBendProfile): ItemMechanicalState {
  return { version: ITEM_MECHANICS_VERSION, geometry: { ...profile.geometry },
    segments: [{ massFraction: 1, residualBend: 0, damage: 0 }], cumulativeWork: 0, sourceEventIds: [] };
}

/** Only enduring physical shape enters premise comparison, not new receipt IDs. */
export function itemMechanicalShape(state: ItemMechanicalState | undefined, materialId?: MaterialId) {
  const profile = materialId === undefined ? undefined : materialBendProfile(materialId);
  const physical = state ?? (profile ? initialItemMechanicalState(profile) : undefined);
  return physical ? { geometry: physical.geometry, segments: physical.segments } : undefined;
}

/**
 * Bend the longest connected segment between the two hands, then unload it.
 * A bilinear spring supplies elastic recovery and post-yield deformation.
 * Existing residual bend and damage lower the remaining fracture margin.
 * A central fracture divides that segment, not its conserved material portion.
 */
export function bendMaterialPortion(
  profile: MaterialBendProfile,
  previous: ItemMechanicalState | undefined,
  loadCapacity: number,
  sourceEventId: string,
) {
  const before = structuredClone(previous ?? initialItemMechanicalState(profile));
  const after = structuredClone(before);
  const segmentIndex = before.segments.reduce((longest, segment, index) =>
    segment.massFraction > before.segments[longest].massFraction ? index : longest, 0);
  const segment = before.segments[segmentIndex];
  const length = before.geometry.length * segment.massFraction;
  const stiffness = profile.bendStiffness * (before.geometry.thickness / 0.2) ** 3
    / length ** 3 * (1 - Math.min(1, segment.damage) * 0.5);
  const yieldDisplacement = profile.yieldBend * length;
  const yieldLoad = stiffness * yieldDisplacement;
  const postYieldStiffness = stiffness * profile.hardening;
  const forceAt = (displacement: number) => stiffness * Math.min(displacement, yieldDisplacement)
    + postYieldStiffness * Math.max(0, displacement - yieldDisplacement);
  const workAt = (displacement: number) => {
    const elastic = Math.min(displacement, yieldDisplacement);
    const plastic = Math.max(0, displacement - yieldDisplacement);
    return stiffness * elastic ** 2 / 2 + yieldLoad * plastic + postYieldStiffness * plastic ** 2 / 2;
  };
  const requestedLoad = Math.max(0, loadCapacity);
  const freeDisplacement = requestedLoad <= yieldLoad ? requestedLoad / stiffness
    : yieldDisplacement + (requestedLoad - yieldLoad) / postYieldStiffness;
  const fractureDisplacement = Math.max(0, profile.fractureBend - segment.residualBend) * length;
  // The hands cannot push the segment ends through an unlimited stroke.
  let peakDisplacement = Math.min(freeDisplacement, length * 0.75, fractureDisplacement);
  if (workAt(peakDisplacement) > BASE_ACTIVITY_EPISODE_WORK_EFFORT) {
    let low = 0, high = peakDisplacement;
    for (let step = 0; step < 40; step += 1) {
      const middle = (low + high) / 2;
      if (workAt(middle) <= BASE_ACTIVITY_EPISODE_WORK_EFFORT) low = middle;
      else high = middle;
    }
    peakDisplacement = low;
  }
  const appliedLoad = forceAt(peakDisplacement);
  const elasticRecovery = Math.min(peakDisplacement, appliedLoad / stiffness);
  const residualIncrement = (peakDisplacement - elasticRecovery) / length;
  const residualBend = segment.residualBend + residualIncrement;
  const fractured = peakDisplacement > 0 && peakDisplacement >= fractureDisplacement - 1e-10;
  if (fractured) {
    // Damage at the failed connection is released by separation. Each shorter
    // fragment retains its share of the permanent curvature and material mass.
    after.segments.splice(segmentIndex, 1, ...[0, 1].map(() => ({
      massFraction: segment.massFraction / 2, residualBend: residualBend / 2, damage: 0,
    })));
  } else after.segments[segmentIndex] = { ...segment, residualBend,
    damage: Math.max(segment.damage, Math.min(1, residualBend / profile.fractureBend)) };
  const mechanicalWork = workAt(peakDisplacement);
  after.cumulativeWork += mechanicalWork;
  after.sourceEventIds = [...new Set([...before.sourceEventIds, sourceEventId])].slice(-24);
  return { before, after, family: profile.family, segmentIndex, requestedLoad, appliedLoad, stiffness,
    peakDisplacement, elasticRecovery, residualIncrement, fractured, mechanicalWork,
    units: 'game-normalized-load-length-work' as const };
}

export interface PerceivedMechanicalCondition {
  shape: 'unchanged' | 'bent' | 'fragmented';
  segmentCount: number;
  summary: string;
}

export function perceivedMechanicalCondition(state: ItemMechanicalState | undefined): PerceivedMechanicalCondition | undefined {
  if (!state) return undefined;
  const segmentCount = state.segments.length;
  const bent = state.segments.some((segment) => segment.residualBend > 1e-6);
  return { shape: segmentCount > 1 ? 'fragmented' : bent ? 'bent' : 'unchanged', segmentCount,
    summary: segmentCount > 1 ? `已断成${segmentCount}段，合计仍是原来一份材料${bent ? '，碎段带有残余弯曲' : ''}`
      : bent ? '受力后留下了残余弯曲' : '受力卸载后恢复原形，当前没有残余弯曲' };
}
