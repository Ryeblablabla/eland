/** 应用层给 UI 的读取模型；不复制领域规则。 */
import type { BiomeKey } from './eland/world/biome';

export interface MaterialView {
  id: number;
  key: string;
  name: string;
  color: readonly [number, number, number];
  tags: string[];
}

export interface ActivityLayersView {
  traffic: number[];
  transfer: number[];
  action: number[];
  attention: number[];
}

export interface PixelWorldView {
  width: 84;
  height: 52;
  levels: 12;
  generator: { version: string; seed: number };
  palette: MaterialView[];
  surface: number[];
  elevation: number[];
  columns: number[][];
  /** 由世界种子和坐标确定性派生；可选以兼容旧快照和轻量测试 mock。 */
  biomes?: BiomeKey[];
  activity: ActivityLayersView;
}

export interface SocietyAgent {
  id: string;
  name: string;
  title: string;
  cellId: number;
  z: number;
  previousCellId: number;
  lastPath: number[];
  tickPath: number[];
  state: 'active' | 'dehydrated' | 'hibernating' | 'dead';
  doing: string;
  activeIntentId?: string;
  sex: 'female' | 'male';
  lifespanMonths: number;
  generation: number;
  respect: number;
  mind: { want: string; choice: string; ought: string };
  needs: { level: string; label: string; intensity: number; dominant: boolean }[];
  body: { health: number; nutrition: number; hydration: number; ageMonths: number };
  conditions: { id: string; kind: string; label: string; stage: number; sinceMonth: number }[];
  inventory: { id: string; materialId: number; name: string; quantity: number }[];
  /** 最近一次真实执行的原语，供场景做只读视觉投影；缺失时才回退到 active intent。 */
  visualAction?: ActionVisualView;
}

export interface AgentHistoryItem {
  id: string;
  month: number;
  orderInMonth: number;
  actionTick?: number;
  cellId: number;
  kind: 'decision' | 'action' | 'continuation' | 'life';
  label: string;
  summary: string;
  intentId?: string;
  status?: string;
  usedModel?: boolean;
}

export interface AgentHistoryView {
  agentId: string;
  throughMonth: number;
  events: AgentHistoryItem[];
}

export interface DropView {
  id: string;
  materialId: number;
  name: string;
  cellId: number;
  z: number;
  quantity: number;
}

export interface AnimalView {
  id: string;
  speciesId: 'deer' | 'rabbit' | 'boar' | 'wolf';
  name: string;
  cellId: number;
  z: number;
  previousCellId: number;
  previousZ: number;
  health: number;
  hunger: number;
  sex?: 'female' | 'male';
  ageMonths?: number;
  ageBand?: 'juvenile' | 'adult' | 'elder';
  activity?: 'idle' | 'walk' | 'graze' | 'feed' | 'chase' | 'flee' | 'attack' | 'injured' | 'birth' | 'dead';
}

export interface ContainerView {
  id: string;
  materialId: number;
  name: string;
  cellId: number;
  z: number;
  capacity: number;
  usedCapacity: number;
  contents: { materialId: number; name: string; quantity: number }[];
}

export interface StructureView {
  id: string;
  name: string;
  occupiedCells: number[];
  interiorCells: number[];
  interiorPositions: Array<{ cellId: number; z: number }>;
  componentCount: number;
  complete: boolean;
  effects: { weatherProtection: number; thermalInsulation: number; capacity: number };
  sourceEventIds: string[];
  /** 权威构件材质；用于完成建筑的材质变体，而不是从建筑名称猜测。 */
  materialIds?: number[];
}

export interface ActionVisualView {
  actionKind: 'move' | 'transfer' | 'act' | 'attend' | 'communicate';
  operation?: 'exert' | 'separate' | 'combine' | 'expose' | 'ingest' | 'reproduce' | 'hunt' | 'dehydrate' | 'rehydrate';
  targetKind?: 'voxel' | 'drop' | 'container' | 'inventory-stack' | 'animal' | 'person';
  targetPersonId?: string;
  targetAnimalId?: string;
  materialId?: number;
  materialIds?: number[];
  toolMaterialId?: number;
  channel?: 'voice' | 'gesture' | 'record';
  communicationKind?: 'claim' | 'prediction' | 'request' | 'offer' | 'accept' | 'reject' | 'revoke' | 'withdraw';
}

export interface IntentView extends ActionVisualView {
  id: string;
  ownerId: string;
  summary: string;
  status: 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';
  progress: number;
  createdAtMonth: number;
  lastProgressAtMonth: number;
}

export interface SocietyState {
  world: PixelWorldView;
  agents: SocietyAgent[];
  animals: AnimalView[];
  drops: DropView[];
  containers: ContainerView[];
  structures: StructureView[];
  intents: IntentView[];
  regions: { id: string; kind: 'natural' | 'residential' | 'trail' | 'cultivated'; cells: number[]; confidence: number; label?: string }[];
  observations: {
    practices: { key: string; label: string; count: number; stability: number }[];
    institutions: { key: string; label: string; note: string }[];
    milestones: Array<{
      id: string;
      label: string;
      note: string;
      capabilityId?: number;
      catalogKind?: 'map' | 'world-specific';
      mapLabel?: string;
      domain?: string;
      valence?: 'constructive' | 'harmful' | 'ambivalent';
      phase?: 'emergence' | 'practice' | 'stable' | 'decline' | 'collapse' | 'recovery' | 'harm' | 'response';
      observedAtMonth?: number;
      participantIds?: string[];
      affectedPersonIds?: string[];
      occurrenceCount?: number;
    }>;
  };
  /** 当前规则结算出的天气；可选以兼容旧快照。 */
  weather?: { kind: 'clear' | 'rain' | 'storm' | 'drought' | 'snow' | 'fog'; intensity: number; sinceMonth: number };
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
  entries: NarrativeEntryView[];
  speaker: string | null;
}

export interface NarrativeEntryView {
  id: string;
  month: number;
  text: string;
  detail: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  kind: 'action' | 'decision' | 'epoch';
  importance: number;
  sourceEventIds: string[];
  actorIds: string[];
  intentId?: string;
}

export type EraKey =
  | 'stable'
  | 'chaotic'
  | 'chaotic-heat'
  | 'chaotic-cold'
  | 'burned'
  | 'frozen'
  | 'extinct';
