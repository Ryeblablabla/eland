import {
  materialDefinition,
  type MaterialId,
  type MaterialPerceptualForm,
} from './material';

/** How directly this person has encountered one exact material entity. */
export type MaterialPerceptionAccess = 'visible' | 'held' | 'verified';

export type PerceivedMaterialPhase = 'solid' | 'liquid' | 'gas';
export type PerceivedMaterialLoadBand = 'trace' | 'light' | 'hand-load' | 'burdensome';
export type PerceivedMaterialRigidity = 'pliant' | 'workable' | 'rigid' | 'very-rigid';
export type PerceivedMaterialForm = MaterialPerceptualForm | 'fluid' | 'plume';
export type PerceivedMaterialAppearance =
  | 'metallic'
  | 'mineral'
  | 'organic'
  | 'earthen'
  | 'luminous'
  | 'dark'
  | 'pale'
  | 'warm'
  | 'cool'
  | 'neutral';

/**
 * A person can see phase, gross shape and surface appearance at a distance.
 * Load and rigidity require holding the exact entity or verifying it after a
 * response. This is intentionally coarser than MaterialDefinition and never
 * exposes an interaction rule, output, or recipe identity.
 */
export interface PerceivedMaterialProfile {
  phase: PerceivedMaterialPhase;
  form: PerceivedMaterialForm;
  appearance: PerceivedMaterialAppearance;
  loadBand?: PerceivedMaterialLoadBand;
  rigidity?: PerceivedMaterialRigidity;
}

function perceivedForm(materialId: MaterialId): PerceivedMaterialForm {
  const material = materialDefinition(materialId);
  if (material.phase === 'liquid') return 'fluid';
  if (material.phase === 'gas') return 'plume';
  return material.perceptual?.form ?? 'compact-body';
}

function perceivedAppearance(materialId: MaterialId): PerceivedMaterialAppearance {
  const material = materialDefinition(materialId);
  if (material.tags.includes('metal')) return 'metallic';
  if (material.tags.includes('ore')) return 'mineral';
  if (material.perceptual?.form === 'flexible-strand'
    || material.perceptual?.form === 'flexible-sheet'
    || material.perceptual?.form === 'plant-bundle') return 'organic';
  if (material.perceptual?.form === 'granular-body') return 'earthen';
  const [red, green, blue] = material.color;
  const brightness = (red + green + blue) / 3;
  if (brightness < 72) return 'dark';
  if (brightness > 178) return 'pale';
  if (red > blue * 1.25 && red > green * 1.12) return 'warm';
  if (blue > red * 1.15 || green > red * 1.18) return 'cool';
  return 'neutral';
}

function perceivedLoadBand(materialId: MaterialId): PerceivedMaterialLoadBand {
  const mass = materialDefinition(materialId).mass;
  if (mass <= 0.2) return 'trace';
  if (mass <= 0.8) return 'light';
  if (mass <= 1.8) return 'hand-load';
  return 'burdensome';
}

function perceivedRigidity(materialId: MaterialId): PerceivedMaterialRigidity {
  const hardness = materialDefinition(materialId).hardness;
  if (hardness <= 2) return 'pliant';
  if (hardness <= 4) return 'workable';
  if (hardness <= 7) return 'rigid';
  return 'very-rigid';
}

export function perceiveMaterial(
  materialId: MaterialId,
  access: MaterialPerceptionAccess,
): PerceivedMaterialProfile {
  const profile: PerceivedMaterialProfile = {
    phase: materialDefinition(materialId).phase,
    form: perceivedForm(materialId),
    appearance: perceivedAppearance(materialId),
  };
  if (access === 'visible') return profile;
  return {
    ...profile,
    loadBand: perceivedLoadBand(materialId),
    rigidity: perceivedRigidity(materialId),
  };
}
