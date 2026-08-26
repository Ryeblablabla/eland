export type MaterialId = number;

export type MaterialTag =
  | 'air'
  | 'solid'
  | 'liquid'
  | 'ground'
  | 'plant'
  | 'edible'
  | 'drinkable'
  | 'seed'
  | 'fiber'
  | 'fuel'
  | 'building'
  | 'placeable'
  | 'tool-material'
  | 'tool'
  | 'flammable'
  | 'hot'
  | 'insulating'
  | 'recordable'
  | 'fertile'
  | 'exhausted'
  | 'ore'
  | 'metal'
  | 'facility'
  | 'storage'
  | 'water-source'
  | 'workstation'
  | 'meeting-place'
  | 'instrument'
  | 'mass-reference'
  | 'electrical-source'
  | 'electrical-conductor'
  | 'electrical-load';

/** Gross morphology available to sight without implying any functional use. */
export type MaterialPerceptualForm =
  | 'flexible-strand'
  | 'flexible-sheet'
  | 'plant-bundle'
  | 'granular-body'
  | 'structural-member'
  | 'shaped-object'
  | 'compact-body';

export interface MaterialDefinition {
  id: MaterialId;
  key: string;
  name: string;
  phase: 'solid' | 'liquid' | 'gas';
  tags: MaterialTag[];
  hardness: number;
  mass: number;
  color: readonly [number, number, number];
  perceptual?: { form: MaterialPerceptualForm };
  consume?: { nutrition?: number; hydration?: number; health?: number };
}

export const Material = {
  Air: 0,
  Stone: 1,
  Soil: 2,
  WetSoil: 3,
  RichSoil: 4,
  ExhaustedSoil: 5,
  Sand: 6,
  Water: 7,
  Grass: 8,
  Shrub: 9,
  BerryBush: 10,
  CropSprout: 11,
  CropMature: 12,
  Wood: 13,
  Leaves: 14,
  PackedSoil: 15,
  Fire: 16,
  Ash: 17,
  Ice: 18,
  Plank: 19,
  Fiber: 20,
  Food: 21,
  Seed: 22,
  Rope: 23,
  StoneTool: 24,
  CookedFood: 25,
  Clothing: 26,
  WoodTablet: 27,
  Container: 28,
  RawMeat: 29,
  Hide: 30,
  Bone: 31,
  Spear: 32,
  LeatherClothing: 33,
  HerbalMedicine: 34,
  Charcoal: 35,
  BoneTool: 36,
  Clay: 37,
  CopperOre: 38,
  TinOre: 39,
  IronOre: 40,
  WoodTool: 41,
  StoneHoe: 42,
  CopperCharge: 43,
  TinCharge: 44,
  IronCharge: 45,
  Copper: 46,
  Tin: 47,
  Bronze: 48,
  IronBloom: 49,
  Iron: 50,
  BronzeTool: 51,
  IronTool: 52,
  FiredBrick: 53,
  CouncilHearth: 54,
  Workshop: 55,
  Granary: 56,
  Cistern: 57,
  Kiln: 58,
  Mill: 59,
  CivicHall: 60,
  Foundry: 61,
  Smithy: 62,
  KeepCore: 63,
  WaterWheel: 64,
  DriveShaft: 65,
  BrokenDriveShaft: 66,
  SteelCharge: 67,
  Steel: 68,
  SteelDriveShaft: 69,
  BeamBalance: 70,
  StandardWeight: 71,
  MechanicalDynamo: 72,
  CopperConductor: 73,
  ResistiveLoad: 74,
  BrokenCopperConductor: 75,
} as const satisfies Record<string, MaterialId>;

export const MATERIAL_PALETTE: readonly MaterialDefinition[] = [
  { id: Material.Air, key: 'air', name: '空气', phase: 'gas', tags: ['air'], hardness: 0, mass: 0, color: [13, 20, 24] },
  { id: Material.Stone, key: 'stone', name: '石', phase: 'solid', tags: ['solid', 'ground', 'building', 'tool-material'], hardness: 8, mass: 2.4, color: [111, 108, 102], perceptual: { form: 'compact-body' } },
  { id: Material.Soil, key: 'soil', name: '土', phase: 'solid', tags: ['solid', 'ground'], hardness: 2, mass: 1.5, color: [105, 78, 53] },
  { id: Material.WetSoil, key: 'wet_soil', name: '湿土', phase: 'solid', tags: ['solid', 'ground', 'fertile'], hardness: 2, mass: 1.7, color: [96, 82, 63] },
  { id: Material.RichSoil, key: 'rich_soil', name: '沃土', phase: 'solid', tags: ['solid', 'ground', 'fertile'], hardness: 2, mass: 1.5, color: [90, 77, 55] },
  { id: Material.ExhaustedSoil, key: 'exhausted_soil', name: '贫瘠土', phase: 'solid', tags: ['solid', 'ground', 'exhausted'], hardness: 2, mass: 1.4, color: [122, 91, 59] },
  { id: Material.Sand, key: 'sand', name: '沙', phase: 'solid', tags: ['solid', 'ground'], hardness: 1, mass: 1.4, color: [164, 142, 91] },
  { id: Material.Water, key: 'water', name: '水', phase: 'liquid', tags: ['liquid', 'drinkable'], hardness: 0, mass: 1, color: [28, 91, 126], consume: { hydration: 58 } },
  { id: Material.Grass, key: 'grass', name: '草', phase: 'solid', tags: ['plant'], hardness: 1, mass: 0.2, color: [76, 106, 58], perceptual: { form: 'plant-bundle' } },
  { id: Material.Shrub, key: 'shrub', name: '灌木', phase: 'solid', tags: ['plant', 'flammable'], hardness: 1, mass: 0.5, color: [52, 91, 45], perceptual: { form: 'plant-bundle' } },
  { id: Material.BerryBush, key: 'berry_bush', name: '结果灌木', phase: 'solid', tags: ['plant', 'flammable'], hardness: 1, mass: 0.6, color: [55, 103, 51], perceptual: { form: 'plant-bundle' } },
  { id: Material.CropSprout, key: 'crop_sprout', name: '作物幼苗', phase: 'solid', tags: ['plant'], hardness: 1, mass: 0.2, color: [119, 137, 62], perceptual: { form: 'plant-bundle' } },
  { id: Material.CropMature, key: 'crop_mature', name: '成熟作物', phase: 'solid', tags: ['plant'], hardness: 1, mass: 0.7, color: [183, 157, 63], perceptual: { form: 'plant-bundle' } },
  { id: Material.Wood, key: 'wood', name: '木材', phase: 'solid', tags: ['solid', 'fuel', 'building', 'tool-material', 'flammable'], hardness: 4, mass: 1, color: [91, 61, 38], perceptual: { form: 'structural-member' } },
  { id: Material.Leaves, key: 'leaves', name: '树叶', phase: 'solid', tags: ['plant', 'flammable'], hardness: 1, mass: 0.2, color: [44, 78, 42], perceptual: { form: 'flexible-sheet' } },
  { id: Material.PackedSoil, key: 'packed_soil', name: '夯土', phase: 'solid', tags: ['solid', 'ground'], hardness: 3, mass: 1.7, color: [123, 101, 71] },
  { id: Material.Fire, key: 'fire', name: '火', phase: 'gas', tags: ['hot'], hardness: 0, mass: 0, color: [224, 94, 42] },
  { id: Material.Ash, key: 'ash', name: '灰', phase: 'solid', tags: ['ground'], hardness: 1, mass: 0.2, color: [93, 91, 87] },
  { id: Material.Ice, key: 'ice', name: '冰', phase: 'solid', tags: ['solid', 'ground', 'drinkable'], hardness: 3, mass: 0.9, color: [153, 202, 221], consume: { hydration: 34 } },
  { id: Material.Plank, key: 'plank', name: '木板', phase: 'solid', tags: ['solid', 'building', 'fuel', 'flammable'], hardness: 4, mass: 0.7, color: [155, 111, 65], perceptual: { form: 'structural-member' } },
  { id: Material.Fiber, key: 'fiber', name: '纤维', phase: 'solid', tags: ['fiber', 'flammable'], hardness: 1, mass: 0.1, color: [173, 158, 116], perceptual: { form: 'flexible-strand' } },
  { id: Material.Food, key: 'food', name: '食物', phase: 'solid', tags: ['edible'], hardness: 1, mass: 0.2, color: [190, 76, 80], consume: { nutrition: 48, hydration: 4 } },
  { id: Material.Seed, key: 'seed', name: '种子', phase: 'solid', tags: ['seed'], hardness: 1, mass: 0.03, color: [163, 132, 68] },
  { id: Material.Rope, key: 'rope', name: '绳', phase: 'solid', tags: ['fiber', 'building', 'flammable'], hardness: 2, mass: 0.25, color: [167, 139, 91], perceptual: { form: 'flexible-strand' } },
  { id: Material.StoneTool, key: 'stone_tool', name: '石制工具', phase: 'solid', tags: ['solid', 'tool'], hardness: 7, mass: 1.1, color: [122, 119, 109] },
  { id: Material.CookedFood, key: 'cooked_food', name: '熟食', phase: 'solid', tags: ['edible'], hardness: 1, mass: 0.2, color: [174, 91, 49], consume: { nutrition: 60, hydration: 3, health: 2 } },
  { id: Material.Clothing, key: 'clothing', name: '衣物', phase: 'solid', tags: ['insulating'], hardness: 1, mass: 0.6, color: [123, 91, 73] },
  { id: Material.WoodTablet, key: 'wood_tablet', name: '木制记录板', phase: 'solid', tags: ['solid', 'recordable', 'flammable'], hardness: 3, mass: 0.35, color: [137, 96, 57] },
  { id: Material.Container, key: 'container', name: '木制容器', phase: 'solid', tags: ['solid', 'placeable', 'flammable'], hardness: 4, mass: 1.4, color: [119, 80, 45] },
  { id: Material.RawMeat, key: 'raw_meat', name: '生肉', phase: 'solid', tags: ['edible'], hardness: 1, mass: 0.35, color: [151, 56, 52], consume: { nutrition: 24, health: -3 } },
  { id: Material.Hide, key: 'hide', name: '兽皮', phase: 'solid', tags: ['fiber', 'insulating'], hardness: 2, mass: 0.8, color: [111, 78, 54], perceptual: { form: 'flexible-sheet' } },
  { id: Material.Bone, key: 'bone', name: '骨', phase: 'solid', tags: ['solid', 'tool-material'], hardness: 5, mass: 0.45, color: [205, 197, 169] },
  { id: Material.Spear, key: 'spear', name: '石刃长矛', phase: 'solid', tags: ['solid', 'tool'], hardness: 7, mass: 1.5, color: [116, 91, 62] },
  { id: Material.LeatherClothing, key: 'leather_clothing', name: '兽皮衣', phase: 'solid', tags: ['insulating'], hardness: 3, mass: 1.1, color: [92, 63, 45] },
  { id: Material.HerbalMedicine, key: 'herbal_medicine', name: '草药', phase: 'solid', tags: ['edible'], hardness: 1, mass: 0.12, color: [88, 125, 71], consume: { nutrition: 2, health: 12 } },
  { id: Material.Charcoal, key: 'charcoal', name: '木炭', phase: 'solid', tags: ['solid', 'fuel'], hardness: 2, mass: 0.35, color: [48, 47, 45] },
  { id: Material.BoneTool, key: 'bone_tool', name: '骨制工具', phase: 'solid', tags: ['solid', 'tool'], hardness: 5, mass: 0.55, color: [194, 185, 154] },
  { id: Material.Clay, key: 'clay', name: '黏土', phase: 'solid', tags: ['solid', 'ground'], hardness: 2, mass: 1.5, color: [151, 91, 64] },
  { id: Material.CopperOre, key: 'copper_ore', name: '铜矿石', phase: 'solid', tags: ['solid', 'ore', 'tool-material'], hardness: 6, mass: 2.3, color: [92, 125, 105] },
  { id: Material.TinOre, key: 'tin_ore', name: '锡矿石', phase: 'solid', tags: ['solid', 'ore', 'tool-material'], hardness: 6, mass: 2.2, color: [126, 138, 145] },
  { id: Material.IronOre, key: 'iron_ore', name: '铁矿石', phase: 'solid', tags: ['solid', 'ore', 'tool-material'], hardness: 7, mass: 2.7, color: [111, 79, 66] },
  { id: Material.WoodTool, key: 'wood_tool', name: '木制生产工具', phase: 'solid', tags: ['solid', 'tool'], hardness: 4, mass: 0.8, color: [133, 88, 48] },
  { id: Material.StoneHoe, key: 'stone_hoe', name: '石锄与石镰', phase: 'solid', tags: ['solid', 'tool'], hardness: 7, mass: 1.4, color: [113, 111, 103] },
  { id: Material.CopperCharge, key: 'copper_charge', name: '铜矿炭料', phase: 'solid', tags: ['solid', 'ore'], hardness: 4, mass: 1.7, color: [76, 91, 77] },
  { id: Material.TinCharge, key: 'tin_charge', name: '锡矿炭料', phase: 'solid', tags: ['solid', 'ore'], hardness: 4, mass: 1.6, color: [94, 100, 104] },
  { id: Material.IronCharge, key: 'iron_charge', name: '铁矿炭料', phase: 'solid', tags: ['solid', 'ore'], hardness: 5, mass: 1.9, color: [79, 61, 54] },
  { id: Material.Copper, key: 'copper', name: '铜', phase: 'solid', tags: ['solid', 'metal', 'tool-material'], hardness: 5, mass: 2.1, color: [181, 101, 55] },
  { id: Material.Tin, key: 'tin', name: '锡', phase: 'solid', tags: ['solid', 'metal', 'tool-material'], hardness: 4, mass: 1.8, color: [174, 184, 185] },
  { id: Material.Bronze, key: 'bronze', name: '青铜', phase: 'solid', tags: ['solid', 'metal', 'building', 'tool-material'], hardness: 8, mass: 2.2, color: [176, 121, 54] },
  { id: Material.IronBloom, key: 'iron_bloom', name: '海绵铁', phase: 'solid', tags: ['solid', 'metal', 'tool-material'], hardness: 7, mass: 2.3, color: [91, 85, 79] },
  { id: Material.Iron, key: 'iron', name: '锻铁', phase: 'solid', tags: ['solid', 'metal', 'building', 'tool-material'], hardness: 9, mass: 2.5, color: [93, 99, 101] },
  { id: Material.BronzeTool, key: 'bronze_tool', name: '青铜生产工具', phase: 'solid', tags: ['solid', 'tool', 'metal'], hardness: 8, mass: 1.2, color: [185, 128, 56] },
  { id: Material.IronTool, key: 'iron_tool', name: '铁制生产工具', phase: 'solid', tags: ['solid', 'tool', 'metal'], hardness: 9, mass: 1.3, color: [102, 108, 110] },
  { id: Material.FiredBrick, key: 'fired_brick', name: '烧结砖', phase: 'solid', tags: ['solid', 'building'], hardness: 6, mass: 1.4, color: [159, 78, 52], perceptual: { form: 'structural-member' } },
  { id: Material.CouncilHearth, key: 'council_hearth', name: '议事火塘', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'meeting-place', 'insulating'], hardness: 5, mass: 2.1, color: [134, 76, 43] },
  { id: Material.Workshop, key: 'workshop', name: '工具棚', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'workstation'], hardness: 6, mass: 2.2, color: [126, 91, 56] },
  { id: Material.Granary, key: 'granary', name: '公共谷仓', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'storage'], hardness: 6, mass: 2.6, color: [157, 118, 60] },
  { id: Material.Cistern, key: 'cistern', name: '蓄水井', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'water-source', 'drinkable'], hardness: 7, mass: 3, color: [80, 126, 144], consume: { hydration: 54 } },
  { id: Material.Kiln, key: 'kiln', name: '陶窑', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'workstation', 'hot'], hardness: 7, mass: 3.2, color: [143, 73, 49] },
  { id: Material.Mill, key: 'mill', name: '磨坊', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'workstation'], hardness: 7, mass: 3.3, color: [132, 121, 92] },
  { id: Material.CivicHall, key: 'civic_hall', name: '城邦议政厅核心', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'meeting-place', 'insulating'], hardness: 8, mass: 3.5, color: [169, 105, 69] },
  { id: Material.Foundry, key: 'foundry', name: '青铜铸造作坊', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'workstation', 'hot'], hardness: 8, mass: 3.8, color: [154, 91, 45] },
  { id: Material.Smithy, key: 'smithy', name: '铁匠铺锻炉', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'workstation', 'hot'], hardness: 9, mass: 4, color: [88, 78, 72] },
  { id: Material.KeepCore, key: 'keep_core', name: '城堡议事核心', phase: 'solid', tags: ['solid', 'building', 'placeable', 'facility', 'meeting-place', 'insulating'], hardness: 9, mass: 4.2, color: [89, 91, 92] },
  { id: Material.WaterWheel, key: 'water_wheel', name: '水轮', phase: 'solid', tags: ['solid', 'building', 'placeable'], hardness: 5, mass: 2.2, color: [126, 87, 48] },
  { id: Material.DriveShaft, key: 'drive_shaft', name: '金属传动轴', phase: 'solid', tags: ['solid', 'building', 'placeable', 'metal'], hardness: 8, mass: 1.8, color: [161, 111, 50] },
  { id: Material.BrokenDriveShaft, key: 'broken_drive_shaft', name: '断裂的传动轴', phase: 'solid', tags: ['solid', 'placeable', 'metal'], hardness: 5, mass: 1.7, color: [104, 78, 50] },
  { id: Material.SteelCharge, key: 'steel_charge', name: '炼钢料', phase: 'solid', tags: ['solid'], hardness: 7, mass: 2.4, color: [67, 70, 71] },
  { id: Material.Steel, key: 'steel', name: '钢', phase: 'solid', tags: ['solid', 'metal', 'building', 'tool-material'], hardness: 10, mass: 2.5, color: [111, 119, 123] },
  { id: Material.SteelDriveShaft, key: 'steel_drive_shaft', name: '钢制传动轴', phase: 'solid', tags: ['solid', 'building', 'placeable', 'metal'], hardness: 10, mass: 1.9, color: [118, 126, 130] },
  { id: Material.BeamBalance, key: 'beam_balance', name: '等臂秤', phase: 'solid', tags: ['solid', 'tool', 'instrument'], hardness: 6, mass: 1.1, color: [146, 111, 67] },
  { id: Material.StandardWeight, key: 'standard_weight', name: '标准秤砣', phase: 'solid', tags: ['solid', 'metal', 'mass-reference'], hardness: 9, mass: 1, color: [103, 106, 107] },
  { id: Material.MechanicalDynamo, key: 'mechanical_dynamo', name: '机械发电机', phase: 'solid', tags: ['solid', 'placeable', 'metal', 'electrical-source'], hardness: 9, mass: 3.2, color: [87, 103, 108] },
  { id: Material.CopperConductor, key: 'copper_conductor', name: '绝缘铜导体', phase: 'solid', tags: ['solid', 'placeable', 'metal', 'electrical-conductor'], hardness: 5, mass: 0.8, color: [181, 96, 55] },
  { id: Material.ResistiveLoad, key: 'resistive_load', name: '电阻负载', phase: 'solid', tags: ['solid', 'placeable', 'metal', 'electrical-load'], hardness: 8, mass: 2.1, color: [177, 133, 72] },
  { id: Material.BrokenCopperConductor, key: 'broken_copper_conductor', name: '熔断的铜导体', phase: 'solid', tags: ['solid', 'placeable', 'metal'], hardness: 3, mass: 0.7, color: [77, 62, 54] },
];

const BY_ID = new Map(MATERIAL_PALETTE.map((material) => [material.id, material]));

export function materialDefinition(id: MaterialId): MaterialDefinition {
  return BY_ID.get(id) ?? MATERIAL_PALETTE[Material.Air];
}

export function materialHas(id: MaterialId, tag: MaterialTag): boolean {
  return materialDefinition(id).tags.includes(tag);
}
