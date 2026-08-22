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
  outputLocation: 'world' | 'inventory';
  outputPlacement?: 'target' | 'support';
}

export interface ExposureRule {
  id: string;
  inputMaterialId: MaterialId;
  targetMaterialId: MaterialId;
  outputMaterialId: MaterialId;
}

const INVENTORY_COMBINATIONS: readonly InventoryCombinationRule[] = [
  {
    id: 'shape-plank',
    inputs: [{ materialId: Material.Wood, quantity: 2 }],
    output: { materialId: Material.Plank, quantity: 2 },
  },
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
  {
    id: 'bind-clothing',
    inputs: [{ materialId: Material.Rope, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.Clothing, quantity: 1 },
  },
  {
    id: 'join-plank-container',
    inputs: [{ materialId: Material.Plank, quantity: 2 }],
    output: { materialId: Material.Container, quantity: 1 },
  },
  {
    id: 'haft-spear',
    inputs: [{ materialId: Material.StoneTool, quantity: 1 }, { materialId: Material.Wood, quantity: 1 }],
    output: { materialId: Material.Spear, quantity: 1 },
  },
  {
    id: 'sew-hide-clothing',
    inputs: [{ materialId: Material.Hide, quantity: 1 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.LeatherClothing, quantity: 1 },
  },
  {
    id: 'shape-bone-tool',
    inputs: [{ materialId: Material.Bone, quantity: 1 }, { materialId: Material.Stone, quantity: 1 }],
    output: { materialId: Material.BoneTool, quantity: 1 },
  },
  {
    id: 'bind-herbal-medicine',
    inputs: [{ materialId: Material.Leaves, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.HerbalMedicine, quantity: 1 },
  },
  {
    id: 'shape-wood-production-tool',
    inputs: [{ materialId: Material.Wood, quantity: 1 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.WoodTool, quantity: 1 },
  },
  {
    id: 'haft-stone-field-tool',
    inputs: [{ materialId: Material.StoneTool, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.StoneHoe, quantity: 1 },
  },
  {
    id: 'assemble-council-hearth',
    inputs: [{ materialId: Material.Plank, quantity: 1 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.CouncilHearth, quantity: 1 },
  },
  {
    id: 'assemble-workshop',
    inputs: [{ materialId: Material.Plank, quantity: 1 }, { materialId: Material.WoodTablet, quantity: 1 }],
    output: { materialId: Material.Workshop, quantity: 1 },
  },
  {
    id: 'assemble-granary',
    inputs: [{ materialId: Material.Container, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.Granary, quantity: 1 },
  },
  {
    id: 'line-cistern',
    inputs: [{ materialId: Material.Container, quantity: 1 }, { materialId: Material.Stone, quantity: 1 }],
    output: { materialId: Material.Cistern, quantity: 1 },
  },
  {
    id: 'build-kiln',
    inputs: [{ materialId: Material.Clay, quantity: 1 }, { materialId: Material.Stone, quantity: 1 }],
    output: { materialId: Material.Kiln, quantity: 1 },
  },
  {
    id: 'build-mill',
    inputs: [{ materialId: Material.Stone, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.Mill, quantity: 1 },
  },
  {
    id: 'prepare-copper-charge',
    inputs: [{ materialId: Material.CopperOre, quantity: 1 }, { materialId: Material.Charcoal, quantity: 1 }],
    output: { materialId: Material.CopperCharge, quantity: 1 },
  },
  {
    id: 'prepare-tin-charge',
    inputs: [{ materialId: Material.TinOre, quantity: 1 }, { materialId: Material.Charcoal, quantity: 1 }],
    output: { materialId: Material.TinCharge, quantity: 1 },
  },
  {
    id: 'prepare-iron-charge',
    inputs: [{ materialId: Material.IronOre, quantity: 1 }, { materialId: Material.Charcoal, quantity: 1 }],
    output: { materialId: Material.IronCharge, quantity: 1 },
  },
  {
    id: 'alloy-bronze',
    inputs: [{ materialId: Material.Copper, quantity: 1 }, { materialId: Material.Tin, quantity: 1 }],
    output: { materialId: Material.Bronze, quantity: 1 },
  },
  {
    id: 'cast-bronze-tool',
    inputs: [{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.Wood, quantity: 1 }],
    output: { materialId: Material.BronzeTool, quantity: 1 },
  },
  {
    id: 'assemble-civic-hall-core',
    inputs: [{ materialId: Material.FiredBrick, quantity: 1 }, { materialId: Material.WoodTablet, quantity: 1 }],
    output: { materialId: Material.CivicHall, quantity: 1 },
  },
  {
    id: 'build-foundry',
    inputs: [{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.Stone, quantity: 1 }],
    output: { materialId: Material.Foundry, quantity: 1 },
  },
  {
    id: 'build-smithy',
    inputs: [{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.FiredBrick, quantity: 1 }],
    output: { materialId: Material.Smithy, quantity: 1 },
  },
  {
    id: 'consolidate-iron-bloom',
    inputs: [{ materialId: Material.IronBloom, quantity: 1 }, { materialId: Material.Charcoal, quantity: 1 }],
    output: { materialId: Material.Iron, quantity: 1 },
  },
  {
    id: 'forge-iron-tool',
    inputs: [{ materialId: Material.Iron, quantity: 1 }, { materialId: Material.Wood, quantity: 1 }],
    output: { materialId: Material.IronTool, quantity: 1 },
  },
  {
    id: 'assemble-keep-core',
    inputs: [{ materialId: Material.Iron, quantity: 1 }, { materialId: Material.FiredBrick, quantity: 1 }],
    output: { materialId: Material.KeepCore, quantity: 1 },
  },
  {
    id: 'assemble-water-wheel',
    inputs: [{ materialId: Material.Plank, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.WaterWheel, quantity: 1 },
  },
  {
    id: 'cast-drive-shaft',
    inputs: [{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.DriveShaft, quantity: 1 },
  },
] as const;

export function inventoryCombinationRules(): readonly InventoryCombinationRule[] {
  return INVENTORY_COMBINATIONS;
}

export function inventoryCombinationForOutput(materialId: MaterialId): InventoryCombinationRule | undefined {
  return INVENTORY_COMBINATIONS.find((rule) => rule.output.materialId === materialId);
}

const EXERTION_RULES: readonly ExertionRule[] = [
  {
    id: 'friction-ignition',
    toolMaterialId: Material.StoneTool,
    inputMaterialId: Material.Fiber,
    targetMaterialId: Material.Air,
    outputMaterialId: Material.Fire,
    outputLocation: 'world',
    outputPlacement: 'support',
  },
  {
    id: 'carve-record-tablet',
    toolMaterialId: Material.StoneTool,
    inputMaterialId: Material.Wood,
    targetMaterialId: Material.Air,
    outputMaterialId: Material.WoodTablet,
    outputLocation: 'inventory',
  },
] as const;

export function exertionRules(): readonly ExertionRule[] {
  return EXERTION_RULES;
}

const EXPOSURE_RULES: readonly ExposureRule[] = [
  {
    id: 'cook-food',
    inputMaterialId: Material.Food,
    targetMaterialId: Material.Fire,
    outputMaterialId: Material.CookedFood,
  },
  {
    id: 'cook-raw-meat',
    inputMaterialId: Material.RawMeat,
    targetMaterialId: Material.Fire,
    outputMaterialId: Material.CookedFood,
  },
  {
    id: 'char-wood',
    inputMaterialId: Material.Wood,
    targetMaterialId: Material.Fire,
    outputMaterialId: Material.Charcoal,
  },
  {
    id: 'char-wood-in-kiln',
    inputMaterialId: Material.Wood,
    targetMaterialId: Material.Kiln,
    outputMaterialId: Material.Charcoal,
  },
  {
    id: 'char-wood-in-foundry',
    inputMaterialId: Material.Wood,
    targetMaterialId: Material.Foundry,
    outputMaterialId: Material.Charcoal,
  },
  {
    id: 'fire-clay-brick',
    inputMaterialId: Material.Clay,
    targetMaterialId: Material.Fire,
    outputMaterialId: Material.FiredBrick,
  },
  {
    id: 'smelt-copper-charge',
    inputMaterialId: Material.CopperCharge,
    targetMaterialId: Material.Kiln,
    outputMaterialId: Material.Copper,
  },
  {
    id: 'smelt-tin-charge',
    inputMaterialId: Material.TinCharge,
    targetMaterialId: Material.Kiln,
    outputMaterialId: Material.Tin,
  },
  {
    id: 'fire-clay-brick-in-kiln',
    inputMaterialId: Material.Clay,
    targetMaterialId: Material.Kiln,
    outputMaterialId: Material.FiredBrick,
  },
  {
    id: 'smelt-copper-charge-in-foundry',
    inputMaterialId: Material.CopperCharge,
    targetMaterialId: Material.Foundry,
    outputMaterialId: Material.Copper,
  },
  {
    id: 'smelt-tin-charge-in-foundry',
    inputMaterialId: Material.TinCharge,
    targetMaterialId: Material.Foundry,
    outputMaterialId: Material.Tin,
  },
  {
    id: 'smelt-iron-charge',
    inputMaterialId: Material.IronCharge,
    targetMaterialId: Material.Smithy,
    outputMaterialId: Material.IronBloom,
  },
] as const;

export function exposureRules(): readonly ExposureRule[] {
  return EXPOSURE_RULES;
}

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
  return rule.outputLocation === 'inventory'
    ? `用${materialDefinition(rule.toolMaterialId).name}向${materialDefinition(rule.inputMaterialId).name}施力，可得到${materialDefinition(rule.outputMaterialId).name}`
    : rule.outputPlacement === 'support'
      ? `用${materialDefinition(rule.toolMaterialId).name}向${materialDefinition(rule.inputMaterialId).name}施力，可在${materialDefinition(rule.targetMaterialId).name}的承托表面产生${materialDefinition(rule.outputMaterialId).name}`
      : `用${materialDefinition(rule.toolMaterialId).name}向${materialDefinition(rule.inputMaterialId).name}施力，可使${materialDefinition(rule.targetMaterialId).name}转化为${materialDefinition(rule.outputMaterialId).name}`;
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
