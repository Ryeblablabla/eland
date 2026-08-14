/** 应用层给 UI 的读取模型；不复制领域规则。 */

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
  state: 'active' | 'dehydrated' | 'dead';
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

export interface ContainerView {
  id: string;
  materialId: number;
  name: string;
  cellId: number;
  z: number;
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
}

export interface IntentView {
  id: string;
  ownerId: string;
  summary: string;
  actionKind: 'move' | 'transfer' | 'act' | 'attend' | 'communicate';
  status: 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';
  progress: number;
  createdAtMonth: number;
  lastProgressAtMonth: number;
}

export interface SocietyState {
  world: PixelWorldView;
  agents: SocietyAgent[];
  drops: DropView[];
  containers: ContainerView[];
  structures: StructureView[];
  intents: IntentView[];
  regions: { id: string; kind: 'natural' | 'residential' | 'trail' | 'cultivated'; cells: number[]; confidence: number; label?: string }[];
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
