import { Material, materialDefinition, type MaterialId } from './material';

export interface InventoryCombinationRule {
  id: string;
  inputs: Array<{ materialId: MaterialId; quantity: number }>;
  output: { materialId: MaterialId; quantity: number };
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
