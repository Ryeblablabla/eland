import { MATERIAL_PALETTE, Material } from '../eland/domain/material';
import type { ActionVisualView, SocietyAgent, SocietyState, StructureView } from '../societyContract';
import {
  cellsAlongPath,
  landscapeHash,
  RIVERBEND_LOTS,
  RIVERBEND_PATHS,
  RIVERBEND_SEED,
  sampleRiverbendLandform,
} from './riverbendLayout';

const WIDTH = 84;
const HEIGHT = 52;
const COUNT = WIDTH * HEIGHT;
export const STUDY_PLAYBACK_MS = 6000;
export const STUDY_VISITOR_ID = 'riverbend-visitor';
export const STUDY_VISITOR_START = 29 * WIDTH + 41;

export interface RiverbendStudy {
  society: SocietyState;
  groundHeights: readonly number[];
  blockedCells: ReadonlySet<number>;
}

/** A deliberately authored read model, never a live save or simulation frame. */
export function createRiverbendStudy(): RiverbendStudy {
  const palette = MATERIAL_PALETTE.map(({ id, key, name, color, tags }) => ({ id, key, name, color, tags: [...tags] }));
  const world: SocietyState['world'] = {
    width: WIDTH, height: HEIGHT, levels: 12,
    generator: { version: 'riverbend-art-study-v1', seed: RIVERBEND_SEED },
    palette, surface: Array(COUNT).fill(Material.Grass), elevation: Array(COUNT).fill(4),
    columns: Array.from({ length: COUNT }, () => []),
    biomes: Array(COUNT).fill('temperate'),
    activity: {
      traffic: Array(COUNT).fill(0), transfer: Array(COUNT).fill(0),
      action: Array(COUNT).fill(0), attention: Array(COUNT).fill(0),
    },
  };
  const groundHeights = Array<number>(COUNT).fill(5);
  const blockedCells = new Set<number>();
  const surfaceId = new Map(palette.map((material) => [material.key, material.id]));
  const cell = (x: number, y: number) => y * WIDTH + x;
  const setGround = (x: number, y: number, height: number, materialId = Material.Grass as number) => {
    const id = cell(x, y);
    groundHeights[id] = height;
    world.surface[id] = materialId;
    world.elevation[id] = height - 1;
    world.columns[id] = Array.from({ length: height }, (_, z) => z === 0 ? materialId : z === 1 ? Material.Soil : Material.Stone);
  };
  const putFeature = (x: number, y: number, materialId: number, layers = 0) => {
    const id = cell(x, y);
    if (layers > 0) world.columns[id] = [...Array<number>(layers).fill(materialId), ...world.columns[id]];
    else world.columns[id][0] = materialId;
    world.surface[id] = materialId;
    world.elevation[id] = groundHeights[id] - 1 + layers;
    const walkableMaterials: readonly number[] = [Material.PackedSoil, Material.CropMature, Material.CropSprout, Material.Grass];
    if (!walkableMaterials.includes(materialId)) blockedCells.add(id);
  };

  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const sample = sampleRiverbendLandform(RIVERBEND_SEED, x, y);
    const id = cell(x, y);
    setGround(x, y, sample.height, surfaceId.get(sample.surface)!);
    world.biomes![id] = y < 14 ? 'taiga' : x < 27 ? 'birch' : 'temperate';
    if (sample.surface === 'water') { blockedCells.add(id); continue; }
    const groveChance = sample.woodland * (y < 22 ? 0.27 : 0.16);
    if (sample.surface === 'grass' && landscapeHash(RIVERBEND_SEED + 90, x, y) < groveChance) {
      world.columns[id] = [Material.Leaves, Material.Wood, ...world.columns[id]];
      world.elevation[id] += 2;
      world.surface[id] = Material.Leaves;
      blockedCells.add(id);
    } else if (sample.surface === 'grass' && sample.clearing < 0.65
      && landscapeHash(RIVERBEND_SEED + 391, x, y) < sample.woodland * 0.04) {
      putFeature(x, y, Material.BerryBush);
    }
  }

  // Buildings share a continuous village terrace; yards are flattened with their house.
  for (const lot of RIVERBEND_LOTS) {
    for (let y = lot.y - 1; y <= lot.y + lot.depth + 1; y++) {
      for (let x = lot.x - 1; x <= lot.x + lot.width; x++) {
        setGround(x, y, lot.height, Material.Grass);
        blockedCells.delete(cell(x, y));
      }
    }
  }
  const trailCells = new Set(RIVERBEND_PATHS.flatMap((points) => cellsAlongPath(points, WIDTH)));
  // Two working yards make related houses share a place, not a row of isolated lots.
  const yardCells = new Set<number>();
  for (let y = 25; y <= 28; y++) for (let x = 34; x <= 38; x++) {
    if ((x === 34 && y === 28) || (x === 38 && y === 25)) continue;
    setGround(x, y, 5, Material.PackedSoil);
    blockedCells.delete(cell(x, y));
    yardCells.add(cell(x, y));
  }
  for (let y = 25; y <= 28; y++) for (let x = 27; x <= 28; x++) {
    if (x === 27 && y === 28) continue;
    setGround(x, y, 5, Material.PackedSoil);
    blockedCells.delete(cell(x, y));
    yardCells.add(cell(x, y));
  }
  for (const id of trailCells) {
    const x = id % WIDTH, y = Math.floor(id / WIDTH);
    setGround(x, y, groundHeights[id], Material.PackedSoil);
    world.activity.traffic[id] = 34;
    blockedCells.delete(id);
  }

  const structures: StructureView[] = RIVERBEND_LOTS.map((lot) => {
    const occupiedCells: number[] = [];
    const interiorCells: number[] = [];
    for (let y = lot.y; y < lot.y + lot.depth; y++) for (let x = lot.x; x < lot.x + lot.width; x++) {
      const id = cell(x, y);
      occupiedCells.push(id);
      const interior = x > lot.x && x < lot.x + lot.width - 1 && y > lot.y && y < lot.y + lot.depth - 1;
      if (interior) {
        interiorCells.push(id);
        setGround(x, y, lot.height, Material.PackedSoil);
      } else {
        putFeature(x, y, lot.material === 'stone' ? Material.Stone : Material.Plank, 3);
      }
      blockedCells.add(id);
    }
    return {
      id: `study-${lot.id}`, name: lot.name, occupiedCells, interiorCells,
      interiorPositions: interiorCells.map((cellId) => ({ cellId, z: lot.height })),
      componentCount: occupiedCells.length * 4, complete: true,
      effects: { capacity: 6, weatherProtection: 92, thermalInsulation: 80 },
      materialIds: lot.material === 'stone' ? [Material.Stone, Material.Stone, Material.Plank]
        : lot.material === 'wood' ? [Material.Plank, Material.Plank, Material.Wood]
          : [Material.Stone, Material.Plank],
      sourceEventIds: [`study:${lot.id}`],
    };
  });

  // Productive ground and a handful of useful objects make the empty space inhabited.
  const field: number[] = [];
  for (let y = 30; y <= 33; y++) for (let x = 28; x <= 32; x++) {
    setGround(x, y, 4, Material.RichSoil);
    if (x !== 30) putFeature(x, y, y === 33 ? Material.CropSprout : Material.CropMature);
    field.push(cell(x, y));
    blockedCells.delete(cell(x, y));
  }
  const facilities: readonly [number, number, number][] = [
    [34, 26, Material.Workshop], [42, 28, Material.Cistern], [28, 26, Material.Granary],
    [49, 30, Material.Mill], [50, 33, Material.WaterWheel], [36, 23, Material.Fire],
  ];
  for (const [x, y, materialId] of facilities) {
    setGround(x, y, groundHeights[cell(x, y)], materialId === Material.WaterWheel ? Material.Water : Material.PackedSoil);
    putFeature(x, y, materialId, materialId === Material.Fire ? 0 : 1);
  }

  // Remnants are actual exposed stone voxels. A broken wall is not a construction project.
  const ruinSections: readonly [number, number, number][] = [
    [44, 12, 1], [45, 12, 2], [46, 12, 3], [47, 12, 1], [46, 13, 2], [46, 14, 1],
  ];
  for (const [x, y, layers] of ruinSections) {
    setGround(x, y, 7, Material.Grass);
    putFeature(x, y, Material.Stone, layers);
  }
  // The short raised edge retains the common work yard without enclosing every house.
  for (const y of [25, 26]) {
    setGround(33, y, 5, Material.Grass);
    putFeature(33, y, Material.Stone, 1);
  }

  // One mature landmark tree at the near-left edge of the village clearing.
  const oldTree = cell(26, 27);
  setGround(26, 27, 5);
  world.columns[oldTree] = [Material.Leaves, Material.Wood, ...world.columns[oldTree]];
  world.surface[oldTree] = Material.Leaves;
  world.elevation[oldTree] += 2;
  blockedCells.add(oldTree);

  const drop = (id: string, x: number, y: number, materialId: number, quantity: number) => ({
    id: `study-${id}`, cellId: cell(x, y), z: groundHeights[cell(x, y)], materialId,
    name: palette[materialId].name, quantity,
  });
  const society: SocietyState = {
    world, agents: [],
    animals: [
      { id: 'study-deer', name: '林缘的鹿', speciesId: 'deer', cellId: cell(23, 25), z: groundHeights[cell(23, 25)], previousCellId: cell(23, 25), previousZ: groundHeights[cell(23, 25)], health: 100, hunger: 12, sex: 'female', activity: 'graze' },
      { id: 'study-rabbit', name: '草地野兔', speciesId: 'rabbit', cellId: cell(34, 33), z: groundHeights[cell(34, 33)], previousCellId: cell(34, 33), previousZ: groundHeights[cell(34, 33)], health: 100, hunger: 5, activity: 'idle' },
    ],
    drops: [drop('woodpile', 38, 27, Material.Wood, 12), drop('clay-pile', 34, 25, Material.Clay, 6), drop('harvest', 28, 28, Material.Food, 8), drop('rope', 38, 25, Material.Rope, 3)],
    containers: [
      { id: 'study-grain-basket', materialId: Material.Container, name: '收获的谷物', cellId: cell(27, 28), z: groundHeights[cell(27, 28)], capacity: 16, usedCapacity: 11, contents: [{ materialId: Material.Food, name: '谷物', quantity: 11 }] },
    ],
    structures, intents: [],
    regions: [
      { id: 'study-village', kind: 'residential', cells: [...structures.flatMap((s) => s.occupiedCells), ...yardCells], confidence: 1, label: '河湾聚落' },
      { id: 'study-paths', kind: 'trail', cells: [...trailCells], confidence: 1, label: '通向河边的小路' },
      { id: 'study-fields', kind: 'cultivated', cells: field, confidence: 1, label: '坡下的麦田' },
    ],
    observations: {
      civilizationIndex: { formulaVersion: 'art-study', total: 180, calculatedAtMonth: 72, stage: '农耕定居', components: { population: 40, territory: 35, technology: 45, social: 30, history: 30 } },
      practices: [], institutions: [], milestones: [],
    },
    epoch: 'stable', climate: { kind: 'temperate', severity: 0, sinceMonth: 72 },
    weather: { kind: 'clear', intensity: 2, sinceMonth: 72 },
  };
  return { society, groundHeights, blockedCells };
}

const walkRoute = cellsAlongPath([[34, 29], [38, 29], [42, 30], [45, 31]], WIDTH);

function studyAgent(
  study: RiverbendStudy, id: string, name: string, cellId: number,
  doing: string, action?: ActionVisualView, sex: SocietyAgent['sex'] = 'female',
): SocietyAgent {
  return {
    id, name, title: doing, cellId, z: study.groundHeights[cellId], previousCellId: cellId,
    lastPath: [cellId], tickPath: [], state: 'active', doing,
    activity: { kind: action ? 'acting' : 'idle', reason: doing, sinceMonth: 72 },
    sex, lifespanMonths: 900, generation: 2, respect: 50,
    mind: { want: '', choice: '', ought: '' }, needs: [],
    body: { health: 100, nutrition: 85, hydration: 88, ageMonths: 340 },
    conditions: [], inventory: [],
    visualAction: action ? { ...action, sourceEventId: `study:${id}:${action.actionKind}`, sourceCellId: cellId, sourceZ: study.groundHeights[cellId] } : undefined,
  };
}

/** Repeatable small scenes of daily life, wholly separate from authoritative playback. */
export function riverbendStudyFrame(
  study: RiverbendStudy, beat: number, chaotic: boolean, visitorCellId = STUDY_VISITOR_START,
): SocietyState {
  const reverse = beat % 2 === 1;
  const route = reverse ? [...walkRoute].reverse() : walkRoute;
  const walker = studyAgent(study, 'study-walker', '阿禾', route[route.length - 1], '穿过村巷', { actionKind: 'move' });
  walker.previousCellId = route[0];
  walker.lastPath = route;
  walker.activity.kind = 'travelling';
  const carrier = studyAgent(study, 'study-carrier', '朔', 28 * WIDTH + 37, '搬运木料', { actionKind: 'transfer', materialId: Material.Wood, targetKind: 'drop', targetCellId: 27 * WIDTH + 38 }, 'male');
  carrier.inventory = [{ id: 'study-carried-timber', materialId: Material.Wood, name: '木料', quantity: 3 }];
  const carpenter = studyAgent(study, 'study-carpenter', '岑', 26 * WIDTH + 35, '修整木器', { actionKind: 'act', operation: 'combine', materialId: Material.Plank, targetKind: 'work', targetCellId: 26 * WIDTH + 34, toolMaterialId: Material.StoneTool }, 'male');
  const farmer = studyAgent(study, 'study-farmer', '麦', 32 * WIDTH + 30, '收割麦穗', { actionKind: 'act', operation: 'separate', materialId: Material.CropMature, sourceMaterialId: Material.CropMature, targetKind: 'voxel', targetCellId: 32 * WIDTH + 31, toolMaterialId: Material.StoneHoe });
  const keeper = studyAgent(study, 'study-keeper', '照', 25 * WIDTH + 36, '照料炉火', { actionKind: 'act', operation: 'expose', materialId: Material.Wood, targetKind: 'voxel', targetCellId: 23 * WIDTH + 36 });
  const visitor = studyAgent(study, STUDY_VISITOR_ID, '旅人', visitorCellId, '停留在河湾');
  return {
    ...study.society, agents: [visitor, walker, carrier, carpenter, farmer, keeper],
    epoch: chaotic ? 'chaotic' : 'stable',
    climate: { kind: chaotic ? 'heat' : 'temperate', severity: chaotic ? 2 : 0, sinceMonth: 72 },
    weather: { kind: 'clear', intensity: chaotic ? 4 : 2, sinceMonth: 72 },
  };
}

export function moveStudyVisitor(study: RiverbendStudy, fromCell: number, dx: number, dy: number): number {
  const x = fromCell % WIDTH + dx, y = Math.floor(fromCell / WIDTH) + dy;
  if (x < 1 || y < 1 || x >= WIDTH - 1 || y >= HEIGHT - 1) return fromCell;
  const target = y * WIDTH + x;
  if (study.blockedCells.has(target) || Math.abs(study.groundHeights[target] - study.groundHeights[fromCell]) > 1) return fromCell;
  return target;
}
