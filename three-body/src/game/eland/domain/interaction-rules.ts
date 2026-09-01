import { Material, materialDefinition, materialHas, type MaterialId } from './material';

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

/** A carried tool acting directly on one visible ground voxel without consuming the tool. */
export interface GroundToolInteractionRule {
  id: string;
  toolMaterialId: MaterialId;
  targetMaterialId: MaterialId;
  outputMaterialId: MaterialId;
}

export interface ExposureRule {
  id: string;
  inputMaterialId: MaterialId;
  targetMaterialId: MaterialId;
  outputMaterialId: MaterialId;
}

export interface InventoryVoxelInteractionRule {
  id: string;
  process: 'sow' | 'retrofit' | 'install';
  inputMaterialId: MaterialId;
  targetMaterialId: MaterialId;
  outputMaterialId: MaterialId;
}

/**
 * A carried material acting on a world location. `Air` is an empty installation
 * slot here, never a material ingredient that a person can combine with.
 */
export function inventoryVoxelInteractionFor(
  inputMaterialId: MaterialId,
  targetMaterialId: MaterialId,
): InventoryVoxelInteractionRule | null {
  if (inputMaterialId === Material.Seed
    && (targetMaterialId === Material.WetSoil
      || targetMaterialId === Material.RichSoil
      || targetMaterialId === Material.ExhaustedSoil)) return {
    id: 'sow-seed',
    process: 'sow',
    inputMaterialId,
    targetMaterialId,
    outputMaterialId: Material.CropSprout,
  };
  if (targetMaterialId === Material.Container && inputMaterialId === Material.Plank) return {
    id: 'retrofit-granary',
    process: 'retrofit',
    inputMaterialId,
    targetMaterialId,
    outputMaterialId: Material.Granary,
  };
  if (targetMaterialId === Material.Container && inputMaterialId === Material.Stone) return {
    id: 'retrofit-cistern',
    process: 'retrofit',
    inputMaterialId,
    targetMaterialId,
    outputMaterialId: Material.Cistern,
  };
  if (targetMaterialId === Material.Air
    && materialHas(inputMaterialId, 'solid')
    && (materialHas(inputMaterialId, 'building') || materialHas(inputMaterialId, 'placeable'))) {
    return {
      id: 'install-in-open-slot',
      process: 'install',
      inputMaterialId,
      targetMaterialId,
      outputMaterialId: inputMaterialId === Material.Wood ? Material.Plank : inputMaterialId,
    };
  }
  return null;
}

/** Compatibility adapter for planning code that only needs the resulting material. */
export function inventoryVoxelCombinationOutput(
  inputMaterialId: MaterialId,
  targetMaterialId: MaterialId,
): MaterialId | null {
  return inventoryVoxelInteractionFor(inputMaterialId, targetMaterialId)?.outputMaterialId ?? null;
}

export function inventoryVoxelInteractionTechniqueId(rule: InventoryVoxelInteractionRule): string {
  return `technique:combine:${rule.inputMaterialId}:${rule.targetMaterialId}:${rule.outputMaterialId}`;
}

export function inventoryVoxelInteractionSummary(rule: InventoryVoxelInteractionRule): string {
  const input = materialDefinition(rule.inputMaterialId).name;
  const target = materialDefinition(rule.targetMaterialId).name;
  const output = materialDefinition(rule.outputMaterialId).name;
  if (rule.process === 'sow') return `把${input}播入${target}可长出${output}`;
  if (rule.process === 'retrofit') return `用${input}改造${target}可做成${output}`;
  if (rule.inputMaterialId === rule.outputMaterialId) return `${input}可安装在有支撑的空位`;
  return `搭建时可把${input}加工并安装为${output}`;
}

export function inventoryVoxelInteractionResult(rule: InventoryVoxelInteractionRule): string {
  const input = materialDefinition(rule.inputMaterialId).name;
  const target = materialDefinition(rule.targetMaterialId).name;
  const output = materialDefinition(rule.outputMaterialId).name;
  if (rule.process === 'sow') return `把${input}播入${target}，长出了${output}`;
  if (rule.process === 'retrofit') return `用${input}改造${target}，做成了${output}`;
  if (rule.inputMaterialId === rule.outputMaterialId) return `把${input}安装在有支撑的空位`;
  return `加工${input}并安装为${output}`;
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
    id: 'prepare-steel-charge',
    inputs: [{ materialId: Material.Iron, quantity: 1 }, { materialId: Material.Charcoal, quantity: 1 }],
    output: { materialId: Material.SteelCharge, quantity: 1 },
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
    id: 'assemble-water-wheel-from-wood',
    inputs: [{ materialId: Material.Wood, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.WaterWheel, quantity: 1 },
  },
  {
    id: 'cast-drive-shaft',
    inputs: [{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.DriveShaft, quantity: 1 },
  },
  {
    id: 'shape-copper-drive-shaft',
    inputs: [{ materialId: Material.Copper, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.DriveShaft, quantity: 1 },
  },
  {
    id: 'forge-iron-drive-shaft',
    inputs: [{ materialId: Material.Iron, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.DriveShaft, quantity: 1 },
  },
  {
    id: 'forge-steel-drive-shaft',
    inputs: [{ materialId: Material.Steel, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }],
    output: { materialId: Material.SteelDriveShaft, quantity: 1 },
  },
  {
    id: 'assemble-beam-balance',
    inputs: [{ materialId: Material.Plank, quantity: 2 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.BeamBalance, quantity: 1 },
  },
  {
    id: 'assemble-beam-balance-from-wood',
    inputs: [{ materialId: Material.Wood, quantity: 2 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.BeamBalance, quantity: 1 },
  },
  {
    id: 'assemble-beam-balance-with-fiber',
    inputs: [{ materialId: Material.Plank, quantity: 2 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.BeamBalance, quantity: 1 },
  },
  {
    id: 'assemble-beam-balance-from-wood-with-fiber',
    inputs: [{ materialId: Material.Wood, quantity: 2 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.BeamBalance, quantity: 1 },
  },
  {
    id: 'shape-standard-weight',
    inputs: [{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.StandardWeight, quantity: 1 },
  },
  {
    id: 'shape-standard-weight-with-fiber',
    inputs: [{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.StandardWeight, quantity: 1 },
  },
  {
    id: 'shape-copper-standard-weight-with-fiber',
    inputs: [{ materialId: Material.Copper, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.StandardWeight, quantity: 1 },
  },
  {
    id: 'shape-iron-standard-weight-with-fiber',
    inputs: [{ materialId: Material.Iron, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }],
    output: { materialId: Material.StandardWeight, quantity: 1 },
  },
  {
    id: 'shape-iron-standard-weight',
    inputs: [{ materialId: Material.Iron, quantity: 1 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.StandardWeight, quantity: 1 },
  },
  {
    id: 'assemble-mechanical-dynamo',
    inputs: [
      { materialId: Material.DriveShaft, quantity: 1 },
      { materialId: Material.Copper, quantity: 1 },
    ],
    output: { materialId: Material.MechanicalDynamo, quantity: 1 },
  },
  {
    id: 'insulate-copper-conductor',
    inputs: [{ materialId: Material.Copper, quantity: 1 }, { materialId: Material.Rope, quantity: 1 }],
    output: { materialId: Material.CopperConductor, quantity: 1 },
  },
  {
    id: 'assemble-resistive-load',
    inputs: [{ materialId: Material.Copper, quantity: 1 }, { materialId: Material.FiredBrick, quantity: 1 }],
    output: { materialId: Material.ResistiveLoad, quantity: 1 },
  },
] as const;

export function inventoryCombinationRules(): readonly InventoryCombinationRule[] {
  return INVENTORY_COMBINATIONS;
}

export function inventoryCombinationsForOutput(materialId: MaterialId): readonly InventoryCombinationRule[] {
  return INVENTORY_COMBINATIONS.filter((rule) => rule.output.materialId === materialId);
}

export function inventoryCombinationForOutput(materialId: MaterialId): InventoryCombinationRule | undefined {
  return inventoryCombinationsForOutput(materialId)[0];
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

const GROUND_TOOL_INTERACTION_RULES: readonly GroundToolInteractionRule[] = [
  {
    id: 'clear-grass-with-stone-field-tool',
    toolMaterialId: Material.StoneHoe,
    targetMaterialId: Material.Grass,
    outputMaterialId: Material.Soil,
  },
  {
    id: 'loosen-soil-with-stone-field-tool',
    toolMaterialId: Material.StoneHoe,
    targetMaterialId: Material.Soil,
    outputMaterialId: Material.ExhaustedSoil,
  },
  {
    id: 'loosen-packed-soil-with-stone-field-tool',
    toolMaterialId: Material.StoneHoe,
    targetMaterialId: Material.PackedSoil,
    outputMaterialId: Material.ExhaustedSoil,
  },
  {
    id: 'clear-grass-with-bronze-field-tool',
    toolMaterialId: Material.BronzeTool,
    targetMaterialId: Material.Grass,
    outputMaterialId: Material.Soil,
  },
  {
    id: 'loosen-soil-with-bronze-field-tool',
    toolMaterialId: Material.BronzeTool,
    targetMaterialId: Material.Soil,
    outputMaterialId: Material.ExhaustedSoil,
  },
  {
    id: 'loosen-packed-soil-with-bronze-field-tool',
    toolMaterialId: Material.BronzeTool,
    targetMaterialId: Material.PackedSoil,
    outputMaterialId: Material.ExhaustedSoil,
  },
  {
    id: 'clear-grass-with-iron-field-tool',
    toolMaterialId: Material.IronTool,
    targetMaterialId: Material.Grass,
    outputMaterialId: Material.Soil,
  },
  {
    id: 'loosen-soil-with-iron-field-tool',
    toolMaterialId: Material.IronTool,
    targetMaterialId: Material.Soil,
    outputMaterialId: Material.ExhaustedSoil,
  },
  {
    id: 'loosen-packed-soil-with-iron-field-tool',
    toolMaterialId: Material.IronTool,
    targetMaterialId: Material.PackedSoil,
    outputMaterialId: Material.ExhaustedSoil,
  },
] as const;

export function exertionRules(): readonly ExertionRule[] {
  return EXERTION_RULES;
}

export function groundToolInteractionRuleFor(
  toolMaterialId: MaterialId,
  targetMaterialId: MaterialId,
): GroundToolInteractionRule | undefined {
  return GROUND_TOOL_INTERACTION_RULES.find((rule) => rule.toolMaterialId === toolMaterialId
    && rule.targetMaterialId === targetMaterialId);
}

export function groundToolInteractionTechniquePrefix(
  toolMaterialId: MaterialId,
  targetMaterialId: MaterialId,
): string {
  return `technique:exert-ground:${toolMaterialId}:${targetMaterialId}:`;
}

export function groundToolInteractionTechniqueId(rule: GroundToolInteractionRule): string {
  return `${groundToolInteractionTechniquePrefix(rule.toolMaterialId, rule.targetMaterialId)}${rule.outputMaterialId}`;
}

export function groundToolInteractionTechniqueSummary(rule: GroundToolInteractionRule): string {
  return `用${materialDefinition(rule.toolMaterialId).name}作用于${materialDefinition(rule.targetMaterialId).name}，可使地表成为${materialDefinition(rule.outputMaterialId).name}`;
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
  {
    id: 'refine-steel-charge-in-smithy',
    inputMaterialId: Material.SteelCharge,
    targetMaterialId: Material.Smithy,
    outputMaterialId: Material.Steel,
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

const inventoryCombinationTechniqueIds = new WeakMap<InventoryCombinationRule, string>();

export function inventoryCombinationTechniqueId(rule: InventoryCombinationRule): string {
  const cached = inventoryCombinationTechniqueIds.get(rule);
  if (cached) return cached;
  const inputKey = [...rule.inputs]
    .sort((a, b) => a.materialId - b.materialId)
    .map((input) => `${input.materialId}x${input.quantity}`)
    .join('+');
  const techniqueId = `technique:combine-inventory:${inputKey}:${rule.output.materialId}`;
  inventoryCombinationTechniqueIds.set(rule, techniqueId);
  return techniqueId;
}

export function inventoryCombinationSummary(rule: InventoryCombinationRule): string {
  const inputs = rule.inputs.map((input) => `${materialDefinition(input.materialId).name}${input.quantity > 1 ? ` × ${input.quantity}` : ''}`).join('与');
  return `用${inputs}可制成${materialDefinition(rule.output.materialId).name}`;
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
    : rule.outputPlacement === 'support' && rule.targetMaterialId === Material.Air
      ? `用${materialDefinition(rule.toolMaterialId).name}加工${materialDefinition(rule.inputMaterialId).name}，可在有承托的位置产生${materialDefinition(rule.outputMaterialId).name}`
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

/** Re-renders legacy stored technique prose from its stable factual ID. */
export function canonicalTechniqueSummary(techniqueId: string): string | undefined {
  const inventory = INVENTORY_COMBINATIONS.find((rule) => inventoryCombinationTechniqueId(rule) === techniqueId);
  if (inventory) return inventoryCombinationSummary(inventory);

  const voxel = techniqueId.match(/^technique:combine:(\d+):(\d+):(\d+)$/u);
  if (voxel) {
    const [, inputMaterialId, targetMaterialId, outputMaterialId] = voxel.map(Number);
    const rule = inventoryVoxelInteractionFor(inputMaterialId, targetMaterialId);
    if (rule?.outputMaterialId === outputMaterialId) return inventoryVoxelInteractionSummary(rule);
  }

  const exertion = techniqueId.match(/^technique:exert:(\d+):(\d+):(\d+):(\d+)$/u);
  if (exertion) {
    const [, toolMaterialId, inputMaterialId, targetMaterialId, outputMaterialId] = exertion.map(Number);
    const rule = exertionRuleFor(toolMaterialId, inputMaterialId, targetMaterialId);
    if (rule?.outputMaterialId === outputMaterialId) return exertionTechniqueSummary(rule);
  }

  const exposure = techniqueId.match(/^technique:expose:(\d+):(\d+):(\d+)$/u);
  if (exposure) {
    const [, inputMaterialId, targetMaterialId, outputMaterialId] = exposure.map(Number);
    const rule = exposureRuleFor(inputMaterialId, targetMaterialId);
    if (rule?.outputMaterialId === outputMaterialId) return exposureTechniqueSummary(rule);
  }
  return undefined;
}
