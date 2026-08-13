/**
 * 人间地图读取模型。
 *
 * 这是应用层给界面的投影，不是领域状态本身。网格、物质、构件、人物位置均来自
 * ELAND 权威世界；界面不得另行生成地点、道路或建筑。
 */

export interface GridLayersView {
  terrainKind: number[];
  elevation: number[];
  fertility: number[];
  waterDepth: number[];
  surfaceCover: number[];
  moisture: number[];
  temperature: number[];
  vegetation: number[];
  fire: number[];
  ice: number[];
}

export interface TraceLayersView {
  traffic: number[];
  rest: number[];
  gathering: number[];
  cultivation: number[];
  care: number[];
  trade: number[];
  burial: number[];
}

export interface PixelWorldView {
  width: 84;
  height: 52;
  generator: { version: string; seed: number };
  cells: GridLayersView;
  traces: TraceLayersView;
}

export interface SocietyAgent {
  id: string;
  name: string;
  title: string;
  cellId: number;
  previousCellId: number;
  lastPath: number[];
  state: 'active' | 'dehydrated' | 'dead';
  doing: string;
  activePlanId?: string;
  sex: 'female' | 'male';
  lifespanMonths: number;
  generation: number;
  respect: number;
  mind: { want: string; choice: string; ought: string };
  needs: { level: string; label: string; intensity: number; dominant: boolean }[];
  body: { health: number; nutrition: number; hydration: number; fatigue: number; ageMonths: number };
}

export interface MatterView {
  id: string;
  kind: string;
  name: string;
  cellId: number;
  quantity: number;
  traits: string[];
}

export interface StructureView {
  id: string;
  name: string;
  occupiedCells: number[];
  interiorCells: number[];
  componentCount: number;
  complete: boolean;
  effects: {
    structuralStability: number;
    weatherProtection: number;
    thermalInsulation: number;
    enclosure: number;
    capacity: number;
  };
  useCount: number;
  sourceEventIds: string[];
}

export interface StructureComponentView {
  id: string;
  structureId: string;
  kind: 'foundation' | 'support' | 'floor' | 'wall' | 'roof' | 'opening';
  cellId: number;
  integrity: number;
}

export interface PlanView {
  id: string;
  ownerId: string;
  objective: string;
  mode: 'explore' | 'travel' | 'gather' | 'carry' | 'build' | 'recover';
  status: 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';
  targetCellId: number;
  progress: number;
  createdAtMonth: number;
  lastProgressAtMonth: number;
}

export interface SocietyState {
  world: PixelWorldView;
  agents: SocietyAgent[];
  matter: MatterView[];
  structures: StructureView[];
  components: StructureComponentView[];
  plans: PlanView[];
  regions: { id: string; kind: 'natural' | 'residential' | 'trail'; cells: number[]; confidence: number; label?: string }[];
  observations: {
    practices: { key: string; label: string; count: number; stability: number }[];
    institutions: { key: string; label: string; note: string }[];
    milestones: { id: string; label: string; note: string }[];
  };
}

export interface SkySample {
  fromTime: number;
  toTime: number;
  fluxMean: number;
  fluxMin: number;
  fluxMax: number;
  nearestStarDistance: number;
  fate: EraKey;
}

export interface GameFrame {
  runId: string;
  branchId: string;
  civilizationId: number;
  elapsedMonths: number;
  calendar: { year: number; month: number; label: string };
  universeTime: number;
  skySample: SkySample;
  society: SocietyState;
  civilizationEnd: { kind: 'destroyed' | 'boundary' | 'milestones'; cause: string; summary: string } | null;
  entries: { text: string; tone: 'plain' | 'good' | 'bad' | 'era'; kind: 'action' | 'decision' | 'epoch' }[];
  speaker: string | null;
}

export type EraKey =
  | 'stable'
  | 'chaotic'
  | 'chaotic-heat'
  | 'chaotic-cold'
  | 'burned'
  | 'frozen'
  | 'extinct';
