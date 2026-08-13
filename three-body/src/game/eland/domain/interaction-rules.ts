import { Material, materialDefinition, type MaterialId } from './material';

export interface InventoryCombinationRule {
  id: string;
  inputs: Array<{ materialId: MaterialId; quantity: number }>;
  output: { materialId: MaterialId; quantity: number };
}

export interface ExertionRule {
  id: string;
  toolMaterialId: MaterialId;
  inputMaterialId: MaterialId;
  targetMaterialId: MaterialId;
  outputMaterialId: MaterialId;
}

export interface ExposureRule {
  id: string;
  inputMaterialId: MaterialId;
  targetMaterialId: MaterialId;
  outputMaterialId: MaterialId;
}

const INVENTORY_COMBINATIONS: readonly InventoryCombinationRule[] = [
  {
    id: 'twist-fiber',
    inputs: [{ materialId: Material.Fiber, quantity: 2 }],
    output: { materialId: Material.Rope, quantity: 1 },
  },
  {
    id: 'haft-stone',
    inputs: [{ materialId: Material.Stone, quantity: 1 }, { materialId: Material.Wood, quantity: 1 }],
    output: { materialId: Material.StoneTool, quantity: 1 },
  },
] as const;

const EXERTION_RULES: readonly ExertionRule[] = [
  {
    id: 'friction-ignition',
    toolMaterialId: Material.StoneTool,
    inputMaterialId: Material.Fiber,
    targetMaterialId: Material.Air,
    outputMaterialId: Material.Fire,
  },
] as const;

const EXPOSURE_RULES: readonly ExposureRule[] = [
  {
    id: 'cook-food',
    inputMaterialId: Material.Food,
    targetMaterialId: Material.Fire,
    outputMaterialId: Material.CookedFood,
  },
] as const;

function counts(materialIds: MaterialId[]): Map<MaterialId, number> {
  const result = new Map<MaterialId, number>();
  for (const materialId of materialIds) result.set(materialId, (result.get(materialId) ?? 0) + 1);
  return result;
}

export function inventoryCombinationFor(materialIds: MaterialId[]): InventoryCombinationRule | undefined {
  const actual = counts(materialIds);
  return INVENTORY_COMBINATIONS.find((rule) => rule.inputs.length === actual.size
    && rule.inputs.every((input) => actual.get(input.materialId) === input.quantity));
}

export function inventoryCombinationTechniqueId(rule: InventoryCombinationRule): string {
  const inputKey = [...rule.inputs]
    .sort((a, b) => a.materialId - b.materialId)
    .map((input) => `${input.materialId}x${input.quantity}`)
    .join('+');
  return `technique:combine-inventory:${inputKey}:${rule.output.materialId}`;
}

export function inventoryCombinationSummary(rule: InventoryCombinationRule): string {
  const inputs = rule.inputs.map((input) => `${materialDefinition(input.materialId).name}${input.quantity > 1 ? ` × ${input.quantity}` : ''}`).join('与');
  return `${inputs}可结合为${materialDefinition(rule.output.materialId).name}`;
}

export function exertionRuleFor(toolMaterialId: MaterialId, inputMaterialId: MaterialId, targetMaterialId: MaterialId): ExertionRule | undefined {
  return EXERTION_RULES.find((rule) => rule.toolMaterialId === toolMaterialId
    && rule.inputMaterialId === inputMaterialId
    && rule.targetMaterialId === targetMaterialId);
}

export function exertionTechniqueId(rule: ExertionRule): string {
  return `technique:exert:${rule.toolMaterialId}:${rule.inputMaterialId}:${rule.targetMaterialId}:${rule.outputMaterialId}`;
}

export function exertionTechniqueSummary(rule: ExertionRule): string {
  return `用${materialDefinition(rule.toolMaterialId).name}向${materialDefinition(rule.inputMaterialId).name}施力，可使${materialDefinition(rule.targetMaterialId).name}转化为${materialDefinition(rule.outputMaterialId).name}`;
}

export function exposureRuleFor(inputMaterialId: MaterialId, targetMaterialId: MaterialId): ExposureRule | undefined {
  return EXPOSURE_RULES.find((rule) => rule.inputMaterialId === inputMaterialId && rule.targetMaterialId === targetMaterialId);
}

export function exposureTechniqueId(rule: ExposureRule): string {
  return `technique:expose:${rule.inputMaterialId}:${rule.targetMaterialId}:${rule.outputMaterialId}`;
}

export function exposureTechniqueSummary(rule: ExposureRule): string {
  return `让${materialDefinition(rule.inputMaterialId).name}暴露于${materialDefinition(rule.targetMaterialId).name}，可得到${materialDefinition(rule.outputMaterialId).name}`;
}
