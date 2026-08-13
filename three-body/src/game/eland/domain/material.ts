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
  | 'tool-material'
  | 'tool'
  | 'flammable'
  | 'hot'
  | 'fertile'
  | 'exhausted';

export interface MaterialDefinition {
  id: MaterialId;
  key: string;
  name: string;
  phase: 'solid' | 'liquid' | 'gas';
  tags: MaterialTag[];
  hardness: number;
  mass: number;
  color: readonly [number, number, number];
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
} as const satisfies Record<string, MaterialId>;

export const MATERIAL_PALETTE: readonly MaterialDefinition[] = [
  { id: Material.Air, key: 'air', name: '空气', phase: 'gas', tags: ['air'], hardness: 0, mass: 0, color: [13, 20, 24] },
  { id: Material.Stone, key: 'stone', name: '石', phase: 'solid', tags: ['solid', 'ground', 'building', 'tool-material'], hardness: 8, mass: 2.4, color: [111, 108, 102] },
  { id: Material.Soil, key: 'soil', name: '土', phase: 'solid', tags: ['solid', 'ground'], hardness: 2, mass: 1.5, color: [105, 78, 53] },
  { id: Material.WetSoil, key: 'wet_soil', name: '湿土', phase: 'solid', tags: ['solid', 'ground', 'fertile'], hardness: 2, mass: 1.7, color: [82, 68, 50] },
  { id: Material.RichSoil, key: 'rich_soil', name: '沃土', phase: 'solid', tags: ['solid', 'ground', 'fertile'], hardness: 2, mass: 1.5, color: [72, 62, 41] },
  { id: Material.ExhaustedSoil, key: 'exhausted_soil', name: '贫瘠土', phase: 'solid', tags: ['solid', 'ground', 'exhausted'], hardness: 2, mass: 1.4, color: [122, 91, 59] },
  { id: Material.Sand, key: 'sand', name: '沙', phase: 'solid', tags: ['solid', 'ground'], hardness: 1, mass: 1.4, color: [164, 142, 91] },
  { id: Material.Water, key: 'water', name: '水', phase: 'liquid', tags: ['liquid', 'drinkable'], hardness: 0, mass: 1, color: [28, 91, 126], consume: { hydration: 58 } },
  { id: Material.Grass, key: 'grass', name: '草', phase: 'solid', tags: ['plant'], hardness: 1, mass: 0.2, color: [77, 111, 55] },
  { id: Material.Shrub, key: 'shrub', name: '灌木', phase: 'solid', tags: ['plant', 'flammable'], hardness: 1, mass: 0.5, color: [52, 91, 45] },
  { id: Material.BerryBush, key: 'berry_bush', name: '结果灌木', phase: 'solid', tags: ['plant', 'flammable'], hardness: 1, mass: 0.6, color: [55, 103, 51] },
  { id: Material.CropSprout, key: 'crop_sprout', name: '作物幼苗', phase: 'solid', tags: ['plant'], hardness: 1, mass: 0.2, color: [119, 137, 62] },
  { id: Material.CropMature, key: 'crop_mature', name: '成熟作物', phase: 'solid', tags: ['plant'], hardness: 1, mass: 0.7, color: [183, 157, 63] },
  { id: Material.Wood, key: 'wood', name: '木材', phase: 'solid', tags: ['solid', 'fuel', 'building', 'tool-material', 'flammable'], hardness: 4, mass: 1, color: [91, 61, 38] },
  { id: Material.Leaves, key: 'leaves', name: '树叶', phase: 'solid', tags: ['plant', 'flammable'], hardness: 1, mass: 0.2, color: [44, 78, 42] },
  { id: Material.PackedSoil, key: 'packed_soil', name: '夯土', phase: 'solid', tags: ['solid', 'ground'], hardness: 3, mass: 1.7, color: [123, 101, 71] },
  { id: Material.Fire, key: 'fire', name: '火', phase: 'gas', tags: ['hot'], hardness: 0, mass: 0, color: [224, 94, 42] },
  { id: Material.Ash, key: 'ash', name: '灰', phase: 'solid', tags: ['ground'], hardness: 1, mass: 0.2, color: [93, 91, 87] },
  { id: Material.Ice, key: 'ice', name: '冰', phase: 'solid', tags: ['solid', 'ground'], hardness: 3, mass: 0.9, color: [153, 202, 221] },
  { id: Material.Plank, key: 'plank', name: '木板', phase: 'solid', tags: ['solid', 'building', 'fuel', 'flammable'], hardness: 4, mass: 0.7, color: [155, 111, 65] },
  { id: Material.Fiber, key: 'fiber', name: '纤维', phase: 'solid', tags: ['fiber', 'flammable'], hardness: 1, mass: 0.1, color: [173, 158, 116] },
  { id: Material.Food, key: 'food', name: '食物', phase: 'solid', tags: ['edible'], hardness: 1, mass: 0.2, color: [190, 76, 80], consume: { nutrition: 48, hydration: 4 } },
  { id: Material.Seed, key: 'seed', name: '种子', phase: 'solid', tags: ['seed'], hardness: 1, mass: 0.03, color: [163, 132, 68] },
  { id: Material.Rope, key: 'rope', name: '绳', phase: 'solid', tags: ['fiber', 'building', 'flammable'], hardness: 2, mass: 0.25, color: [167, 139, 91] },
  { id: Material.StoneTool, key: 'stone_tool', name: '石制工具', phase: 'solid', tags: ['solid', 'tool'], hardness: 7, mass: 1.1, color: [122, 119, 109] },
];

const BY_ID = new Map(MATERIAL_PALETTE.map((material) => [material.id, material]));

export function materialDefinition(id: MaterialId): MaterialDefinition {
  return BY_ID.get(id) ?? MATERIAL_PALETTE[Material.Air];
}

export function materialHas(id: MaterialId, tag: MaterialTag): boolean {
  return materialDefinition(id).tags.includes(tag);
}
