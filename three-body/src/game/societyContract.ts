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
  /** 可重建的装饰头像；不属于权威人物状态。 */
  portrait?: string;
  title: string;
  cellId: number;
  z: number;
  previousCellId: number;
  lastPath: number[];
  tickPath: number[];
  state: 'active' | 'dehydrated' | 'hibernating' | 'dead';
  /** Read-only disposition of this dead person's authoritative remains. */
  bodyDisposition?: 'exposed' | 'carried' | 'placed' | 'interred';
  doing: string;
  activeIntentId?: string;
  sex: 'female' | 'male';
  lifespanMonths: number;
  generation: number;
  /** 新投影始终提供；可选仅用于读取特质系统上线前的历史帧。 */
  traits?: { id: string; name: string; description: string }[];
  respect: number;
  mind: { want: string; choice: string; ought: string };
  needs: { level: string; label: string; intensity: number; dominant: boolean }[];
  body: { health: number; nutrition: number; hydration: number; ageMonths: number };
  conditions: { id: string; kind: string; label: string; stage: number; sinceMonth: number }[];
  inventory: { id: string; materialId: number; name: string; quantity: number }[];
  /** 该人物对其他人物的有向关系投影；数值与证据均来自权威人物状态。 */
  relations?: {
    personId: string;
    name: string;
    portrait?: string;
    state: 'active' | 'dehydrated' | 'hibernating' | 'dead';
    trust: number;
    bond: number;
    fear: number;
    sourceEventIds: string[];
  }[];
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
  /** 由权威事件字段投影出的地点、路径、对象等行动细节。 */
  detail?: string;
  intentId?: string;
  status?: string;
  usedModel?: boolean;
}

export interface AgentHistoryView {
  agentId: string;
  throughMonth: number;
  events: AgentHistoryItem[];
}

export type AgentConversationStance = 'answer' | 'consider' | 'accept' | 'decline';
export type AgentConversationRequestKind = 'conversation' | 'suggestion';
export type AgentConversationInfluenceStatus =
  | 'none'
  | 'queued'
  | 'deferred'
  | 'applied'
  | 'completed'
  | 'blocked'
  | 'stale'
  | 'pending'
  | 'considered'
  | 'failed';

export interface AgentConversationTurn {
  id: string;
  clientMessageId: string;
  agentId: string;
  branchId: string;
  requestedAtMonth: number;
  completedAtMonth: number;
  userMessage: string;
  agentReply: string;
  requestKind: AgentConversationRequestKind;
  stance: AgentConversationStance;
  /** 人物愿意在未来合法决策中重新考虑的稳定方向；不是已完成行动。 */
  guidance?: string;
  reason?: string;
  grounding?: 'supported' | 'unknown' | 'opinion';
  evidenceIds?: string[];
  /** 从人物本轮回复中提取并通过校验的合法方向；尚不等于行动已经发生。 */
  choice?: {
    optionId: string;
    followUpOptionId?: string;
    summary: string;
    choiceKey: string;
    reason: string;
  };
  influenceStatus: AgentConversationInfluenceStatus;
  influenceOutcome?: {
    atMonth: number;
    summary: string;
    detail?: string;
    decisionEventId?: string;
    intentId?: string;
    actionEventIds?: string[];
  };
  model: {
    endpointId: string;
    protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'ollama-chat';
    model: string;
  };
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentConversationView {
  agentId: string;
  branchId: string;
  throughMonth: number;
  model: {
    configured: boolean;
    endpointId?: string;
    model?: string;
    issue?: string;
  };
  turns: AgentConversationTurn[];
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

export interface GraveView {
  id: string;
  remainsId: string;
  personId: string;
  personName: string;
  cellId: number;
  /** Top of the restored grave surface, in standing-height coordinates. */
  z: number;
  marked: boolean;
  markerMaterialId?: number;
  inscription?: string;
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
  /** 仅真实 ActionFact 投影携带；意图预览没有来源事件，装饰层不得把它当成已发生动作。 */
  sourceEventId?: string;
  sourceOrderInMonth?: number;
  sourceCellId?: number;
  sourceZ?: number;
  targetCellId?: number;
  targetZ?: number;
  /** 领域后果明确记录的设施材质；位置仍由真实动作落点与附近同材质设施共同解析。 */
  facilityMaterialId?: number;
  mechanicalPowerOperation?: boolean;
  linkedFacilityCellIds?: number[];
  operation?: 'exert' | 'separate' | 'combine' | 'expose' | 'ingest' | 'reproduce' | 'hunt' | 'dehydrate' | 'rehydrate' | 'inter';
  mortuaryPhase?: 'mourn' | 'lift' | 'prepare-grave' | 'place-in-grave' | 'cover-grave' | 'mark';
  targetKind?: 'voxel' | 'drop' | 'container' | 'inventory-stack' | 'animal' | 'remains' | 'person';
  targetPersonId?: string;
  targetAnimalId?: string;
  /** 已完成分离动作的权威来源材质；动作后目标体素可能已经改变。 */
  sourceMaterialId?: number;
  materialId?: number;
  materialIds?: number[];
  toolMaterialId?: number;
  channel?: 'voice' | 'gesture' | 'record';
  communicationKind?: 'claim' | 'prediction' | 'request' | 'offer' | 'accept' | 'reject' | 'revoke-agreement' | 'revoke' | 'withdraw';
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

/** 文明观察器给 UI 的只读快照；各分项是对总指数的实际点数贡献。 */
export interface CivilizationIndexView {
  formulaVersion: string;
  total: number;
  calculatedAtMonth: number;
  stage: string;
  components: {
    population: number;
    territory: number;
    technology: number;
    social: number;
    history: number;
  };
}

/** 已提交月份的只读文明指数投影，用于展示当前分支的时间趋势。 */
export interface CivilizationIndexHistoryPoint {
  formulaVersion: string;
  total: number;
  calculatedAtMonth: number;
  stage: string;
}

export interface SocietyState {
  world: PixelWorldView;
  agents: SocietyAgent[];
  animals: AnimalView[];
  drops: DropView[];
  containers: ContainerView[];
  graves?: GraveView[];
  structures: StructureView[];
  intents: IntentView[];
  regions: { id: string; kind: 'natural' | 'residential' | 'trail' | 'cultivated'; cells: number[]; confidence: number; label?: string }[];
  observations: {
    civilizationIndex?: CivilizationIndexView;
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

/** 可恢复的三体宇宙物理快照；轨迹属于装饰层，不进入存档。 */
export interface CosmosSnapshot {
  schemaVersion: 1;
  presetKey: string;
  state: number[];
  masses: number[];
  /** 宇宙专用可序列化随机状态；保证读档后的下一次行星重生仍走同一路径。 */
  randomState: number;
  respawnSequence: number;
  t: number;
  viewR: number;
  civilizations: number;
  extinct: boolean;
  pendingCollapse: 'burned' | 'frozen' | 'extinct' | null;
  fluxBase: number;
  planetR: number;
}

export interface GameFrame {
  runId: string;
  /** Opaque lifetime of the server-side authority instance; not a domain fact. */
  authorityRevision: string;
  branchId: string;
  civilizationId: number;
  elapsedMonths: number;
  calendar: { year: number; month: number; label: string };
  universeTime: number;
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
  society: SocietyState;
  civilizationEnd: { kind: 'destroyed' | 'boundary' | 'milestones' | 'concluded'; cause: string; summary: string } | null;
  entries: NarrativeEntryView[];
  /**
   * 已发生沟通的表层台词。它绑定权威 ActionFact，但只用于表现，
   * 不参与知识、关系、记忆或后续规划；可选以兼容旧实时快照。
   */
  speechLines?: SpeechLineView[];
  speaker: string | null;
}

export type SpeechCommunicationKind = 'claim' | 'prediction' | 'request' | 'offer' | 'accept' | 'reject' | 'revoke-agreement' | 'revoke' | 'withdraw';

/**
 * 规则动作授权给表达模型的话语行为。这里保存结构化语义，不保存可直接
 * 显示的规则台词；details 只包含 RepresentationInput 中除 id / summary 外
 * 的领域字段。
 */
export interface SpeechActView {
  version: 'speech-act-v1';
  kind: SpeechCommunicationKind;
  subject?: string;
  details?: Record<string, unknown>;
}

export interface SpeechLineView {
  id: string;
  authority: 'projection-only';
  sourceEventId: string;
  sourceFactIds: string[];
  month: number;
  planningTick: number;
  speakerId: string;
  speakerName: string;
  audienceIds: string[];
  audienceNames: string[];
  channel: 'voice';
  communicationKind: SpeechCommunicationKind;
  speechAct: SpeechActView;
  text: string;
  /** 可见台词只允许来自模型；旧快照中的 rule 来源由渲染层忽略。 */
  source: 'decision-model' | 'speech-model';
  endpointId?: string;
  model?: string;
}

/** 玩家手动存档的轻量索引；权威会话快照只保存在后端。 */
export interface ElandSaveSummary {
  schemaVersion: 1;
  stateSchemaVersion: 17;
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  sourceRunId: string;
  civilizationId: number;
  branchId: string;
  elapsedMonths: number;
  calendarLabel: string;
  worldSeed: number;
  livingPeople: number;
  stage: string;
  ended: boolean;
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
