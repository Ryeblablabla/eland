import { Material, materialDefinition, materialHas, type MaterialId } from './material';

export interface VoxelSeparationRule {
  id: string;
  inputMaterialId: MaterialId;
  requiredToolMaterialId?: MaterialId;
  replacementMaterialId: MaterialId;
  outputs: Array<{ materialId: MaterialId; quantity: number }>;
}

const VOXEL_SEPARATION_RULES: readonly VoxelSeparationRule[] = [
  {
    id: 'split-stone-with-stone-tool',
    inputMaterialId: Material.Stone,
    requiredToolMaterialId: Material.StoneTool,
    replacementMaterialId: Material.Air,
    outputs: [{ materialId: Material.Stone, quantity: 1 }],
  },
  {
    id: 'recover-plank',
    inputMaterialId: Material.Plank,
    replacementMaterialId: Material.Air,
    outputs: [{ materialId: Material.Plank, quantity: 1 }],
  },
  {
    id: 'recover-container',
    inputMaterialId: Material.Container,
    replacementMaterialId: Material.Air,
    outputs: [{ materialId: Material.Container, quantity: 1 }],
  },
] as const;

export function voxelSeparationRuleFor(materialId: MaterialId): VoxelSeparationRule | undefined {
  return VOXEL_SEPARATION_RULES.find((rule) => rule.inputMaterialId === materialId);
}

export function separationToolFits(rule: VoxelSeparationRule, materialId: MaterialId): boolean {
  if (rule.requiredToolMaterialId === undefined) return true;
  if (materialId === rule.requiredToolMaterialId) return true;
  return materialHas(materialId, 'tool')
    && materialDefinition(materialId).hardness >= materialDefinition(rule.requiredToolMaterialId).hardness;
}

export function separationTechniqueId(rule: VoxelSeparationRule): string {
  return `technique:separate:${rule.requiredToolMaterialId ?? 'hand'}:${rule.inputMaterialId}:${rule.outputs.map((output) => output.materialId).join('+')}`;
}

export function separationTechniqueSummary(rule: VoxelSeparationRule): string {
  const input = materialDefinition(rule.inputMaterialId).name;
  const tool = rule.requiredToolMaterialId ? `用${materialDefinition(rule.requiredToolMaterialId).name}` : '徒手';
  const outputs = rule.outputs.map((output) => `${materialDefinition(output.materialId).name}${output.quantity > 1 ? ` × ${output.quantity}` : ''}`).join('、');
  return `${tool}分离${input}，可得到${outputs}`;
}
