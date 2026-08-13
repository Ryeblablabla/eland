// @ts-nocheck —— vendored from ELAND 社会鱼缸 (demo/lib/simulation.ts)，保持与上游一致，便于后续合并更新；类型豁免仅限本文件。
import { CHARACTER_PROFILES, type CharacterProfile } from "./character-profiles";
import {
  ADULT_WORK_AGE,
  ELDER_AGE,
  TRUSTED_PREDICTOR_RESPECT,
  createBiologicalSex,
  createFounderAge,
  createLifespan,
  createNewbornName,
  deterministicFraction,
  isFertileAge,
  predictionRespect,
  type BiologicalSex,
  type LineageState,
  type PregnancyState,
  type SocialStanding,
} from "./population";

export type AgentId = string;
export type LocationId = string;
export type MatterKind = string;
export type MatterTrait =
  | "raw"
  | "edible"
  | "rigid"
  | "cutting"
  | "building"
  | "crafted"
  | "flat"
  | "sharp"
  | "structure"
  | "shelter"
  | "recordable"
  | "instrument"
  | "fuel"
  | "burning"
  | "cooked"
  | "animal"
  | "fiber"
  | "wearable"
  | "container"
  | "wheel"
  | "supportive"
  | "barrier"
  | "domesticated"
  | "stored"
  | "botanical"
  | "remains"
  | "memorial";

export type EpochKind = "stable" | "chaotic";
export type ClimateKind = "temperate" | "cold" | "heat" | "fire";
export type AnnualPhase = "spring" | "summer" | "autumn" | "winter";
export type StartingPoint = "origin" | "shelter" | "roads" | "records" | "models";
export type ClimateBias = "balanced" | "cold" | "hot";
export type DriveKind = "hunger" | "thirst" | "thermal" | "rest" | "safety" | "care" | "affiliation" | "reproduction" | "curiosity" | "mastery" | "play" | "expression" | "status";
export type MaslowNeedLevel = "physiological" | "safety" | "belonging" | "esteem" | "selfActualization";

export interface DriveState {
  kind: DriveKind;
  level: MaslowNeedLevel;
  label: string;
  intensity: number;
  baseline: number;
  reason: string;
}

export interface MaslowNeedLayer {
  level: MaslowNeedLevel;
  label: "生理需求" | "安全需求" | "归属与爱" | "尊重需求" | "自我实现";
  intensity: number;
  activeNeeds: DriveState[];
}

export interface MaslowPersonalityLayer {
  level: MaslowNeedLevel;
  label: MaslowNeedLayer["label"];
  baselineWeight: number;
  evidence: string[];
}

export interface MaslowPersonality {
  dominantLevel: MaslowNeedLevel;
  summary: string;
  layers: MaslowPersonalityLayer[];
}

export interface SimulationConfig {
  civilizationNo: number;
  startingPoint: StartingPoint;
  climateBias: ClimateBias;
  chaosIntensity: number;
  endpoint: { kind: "ticks" | "milestones"; value: number };
  /** 指定入局人物（档案 id）；缺省时按种子从档案池随机抽取 */
  characterIds?: string[];
}

export type MatterHolder =
  | { kind: "space"; id: LocationId }
  | { kind: "agent"; id: AgentId };

export type InteractionIntent =
  | { mode: "take"; matterId: string; quantity?: number }
  | { mode: "give"; matterId: string; toAgentId: AgentId; quantity?: number }
  | {
      mode: "shape";
      inputIds: string[];
      desiredKind: string;
      desiredName: string;
      desiredTraits?: MatterTrait[];
    }
  | {
      mode: "assemble";
      inputIds: string[];
      siteId: LocationId;
      desiredKind: string;
      desiredName: string;
      purpose?: "shelter" | "instrument" | "platform";
      arrangement?: {
        support: number;
        cover: number;
        boundary: number;
        opening: number;
      };
    }
  | { mode: "work"; siteId: LocationId; change: "compact" | "clear" | "dig" | "cultivate" | "irrigate" }
  | { mode: "ignite"; fuelId: string }
  | { mode: "cook"; foodId: string; fireId: string }
  | { mode: "eat"; foodId: string }
  | { mode: "hunt"; animalId: string }
  | { mode: "tend"; animalId: string; offeringId: string }
  | { mode: "store"; matterId: string; containerId: string }
  | { mode: "perform"; form: "image" | "music" | "dance" | "game"; partnerId?: AgentId; mediumId?: string }
  | { mode: "claim"; subjectId: string; claim: string }
  | { mode: "trade"; offeredMatterId: string; requestedMatterId: string; withAgentId: AgentId }
  | { mode: "relocate"; to: LocationId }
  | { mode: "drink"; sourceId: string }
  | { mode: "rest"; siteId: LocationId }
  | { mode: "warm"; fireId: string }
  | { mode: "bond"; toAgentId: AgentId; gesture: "comfort" | "court" | "care" | "intimate"; barrierId?: string }
  | { mode: "inspect-body"; targetAgentId: AgentId }
  | { mode: "apply-material"; matterId: string; targetAgentId: AgentId }
  | { mode: "treat"; toAgentId: AgentId }
  | { mode: "fit-support"; matterId: string; targetAgentId: AgentId }
  | { mode: "bury"; remainsId: string; siteId: LocationId }
  | { mode: "express"; toAgentId: AgentId; speech: string; claim?: string; sourceEventIds?: string[] }
  | { mode: "adapt"; change: "dehydrate" | "soak"; targetAgentId?: AgentId }
  | { mode: "observe"; aspect: "sky" | "climate" | "quantity"; matterId?: string }
  | { mode: "record"; mediumId: string; recordKind: "tally" | "chronicle" | "calendar" | "notation" | "model"; sourceEventIds: string[]; note: string }
  | { mode: "predict"; instrumentId?: string; predictedEpoch: EpochKind; predictedClimate: ClimateKind; dueTick: number; sourceEventIds: string[] };

export type MoveAction = { type: "move"; to: LocationId };
export type InteractAction = {
  type: "interact";
  with: { kind: "matter" | "agent" | "space"; id: string };
  content: string;
  intent?: InteractionIntent;
};
export type Action = MoveAction | InteractAction;

export interface LocationState {
  id: LocationId;
  name: string;
  x: number;
  y: number;
  neighbors: LocationId[];
  open: boolean;
  terrain: { kind: "soil" | "grass" | "stone" | "water-edge"; compaction: number; cleared: number; depth: number; irrigated?: boolean };
  useTraces?: PlaceUseTrace[];
}

export interface PlaceUseTrace {
  kind: "care";
  tick: number;
  actorId: AgentId;
  subjectAgentId: AgentId;
  eventId: string;
  outcome: "improved" | "unchanged" | "worsened" | "observed";
}

export interface RouteState {
  id: string;
  from: LocationId;
  to: LocationId;
  traffic: number;
  state: "unmarked" | "trail" | "road";
  sourceEventIds: string[];
}

export interface MatterState {
  id: string;
  kind: MatterKind;
  name: string;
  holder: MatterHolder;
  quantity: number;
  unitMass: number;
  composition: Record<string, number>;
  traits: MatterTrait[];
  madeBy?: AgentId;
  sourceEventIds?: string[];
  construction?: {
    progress: number;
    requiredMass: number;
    complete: boolean;
    purpose?: "shelter" | "instrument" | "platform";
    arrangement?: { support: number; cover: number; boundary: number; opening: number };
    effects?: {
      structuralStability: number;
      weatherProtection: number;
      thermalInsulation: number;
      enclosure: number;
      capacity: number;
    };
    useEventIds?: string[];
  };
  records?: EvidenceRecord[];
  storedIn?: string;
  personId?: AgentId;
  /** 物质对身体的客观作用；人物只能从使用前后的事实中学习，决策载荷不直接暴露。 */
  bodyEffect?: { fever?: number; woundInfection?: number; strain?: number; toxicity?: number; adaptation?: number };
}

export interface EvidenceRecord {
  id: string;
  kind: "tally" | "chronicle" | "calendar" | "notation" | "model" | "map" | "measure" | "account" | "contract" | "image";
  authorId: AgentId;
  createdTick: number;
  sourceEventIds: string[];
  note: string;
  subjectAgentId?: AgentId;
  episodeKey?: string;
  outcome?: "improved" | "unchanged" | "worsened";
  methodKey?: string;
  comparedMethods?: string[];
  rejectedMethods?: string[];
}

export interface RelationState {
  agentId: AgentId;
  strength: number;
  word: string;
  sourceEventIds: string[];
}

export interface KnowledgeClaim {
  claim: string;
  confidence: number;
  sourceEventIds: string[];
  kind?: "contact-illness-association" | "material-body-effect";
  subjectKind?: string;
  observedEffect?: "beneficial" | "neutral" | "harmful";
}

export interface MemoryFragment {
  id: string;
  tick: number;
  summary: string;
  salience: number;
  sourceEventIds: string[];
  actionKey?: string;
  succeeded?: boolean;
}

export interface MemorySummary {
  id: string;
  fromTick: number;
  toTick: number;
  summary: string;
  lessons: string[];
  sourceEventIds: string[];
}

export interface AgentMemory {
  episodic: MemoryFragment[];
  summaries: MemorySummary[];
  capacity: number;
  forgottenCount: number;
  lastConsolidatedTick: number;
}

export interface MemoryConsolidation {
  summary: string;
  lessons: string[];
  retainFragmentIds: string[];
}

export interface AgentState {
  id: AgentId;
  name: string;
  color: string;
  profile: {
    description: string;
    personality: MaslowPersonality;
  };
  locationId: LocationId;
  mind: {
    needs: { focus: string; intensity: number; dominantLevel: MaslowNeedLevel; drives: DriveState[]; layers: MaslowNeedLayer[] };
    affect: { strain: number; state: "regulated" | "distressed" | "disorganized"; sinceTick?: number; sourceEventIds: string[]; supportEventIds: string[] };
    cognition: {
      perception: string;
      choice: string;
      interpretation: string;
      interpretations: AgentInterpretation[];
      knowledge: KnowledgeClaim[];
      hypotheses: HypothesisState[];
      memory: AgentMemory;
    };
  };
  limbs: {
    action: Action | null;
    actionText: string;
    abilities: { move: number; interact: number; craft: number; build: number; observe: number; reason: number };
  };
  relations: RelationState[];
  lineage: LineageState;
  standing: SocialStanding;
  body: {
    state: "active" | "dehydrated" | "dead";
    hydration: number;
    exposure: number;
    resilience: number;
    nutrition: number;
    health: number;
    fatigue: number;
    temperature: number;
    ageYears: number;
    sex: BiologicalSex;
    lifespanYears: number;
    pregnancy?: PregnancyState;
    familyPlanning?: { desiredChildCount: number; birthCount: number; lastBirthTick?: number; sourceEventIds: string[] };
    illness?: { kind: "fever" | "wound-infection"; course?: "acute" | "persistent"; severity: number; sinceTick: number; sourceEventIds: string[]; contactLinked?: boolean; contactSourceEventIds?: string[]; examinedAtTick?: number; durationYears?: number; persistentSinceTick?: number; lastSupportedTick?: number };
    injury?: { kind: "cut" | "fall" | "animal-bite"; severity: number; bleeding: number; sinceTick: number; sourceEventIds: string[]; examinedAtTick?: number; mobilityLoss?: number; mobilityAtInjury?: number; lastingMobilityLoss?: number; supportId?: string; supportEventIds?: string[]; supportedMoveEventIds?: string[]; assistedYears?: number };
    endOfLife?: { sinceTick: number; dueTick: number; cause: "old-age" | "irreversible-decline"; sourceEventIds: string[]; supportEventIds: string[]; supportAgentIds: AgentId[]; comfortYears: number; lastSupportedTick?: number };
    adaptation?: { materialKind: string; level: number; consecutiveUses: number; lastUseTick: number; sourceEventIds: string[]; withdrawalSinceTick?: number; withdrawalEventIds: string[]; supportEventIds: string[]; supportedYears: number; lastSupportedTick?: number };
    infectionExposure?: { load: number; exposedTick: number; sourceAgentIds: AgentId[]; sourceEventIds: string[] };
    surfaceLoad: number;
    homeLocationId: LocationId;
    dehydrations: number;
    soakings: number;
  };
}

export interface HypothesisState {
  id: string;
  claim: string;
  predictedEpoch: EpochKind;
  predictedClimate: ClimateKind;
  dueTick: number;
  sourceEventIds: string[];
  instrumentId?: string;
  status: "pending" | "confirmed" | "failed";
  resolutionEventId?: string;
  followers?: AgentId[];
  respectAtPrediction?: number;
}

export type WorldEvent = ActionFact | EnvironmentFact;
export interface ActionFact {
  id: string;
  kind: "action";
  tick: number;
  who: AgentId;
  where: LocationId;
  action: Action;
  succeeded: boolean;
  result: string;
  diff: Record<string, unknown>;
  phase?: AnnualPhase;
}
export interface EnvironmentFact {
  id: string;
  kind: "environment";
  tick: number;
  where: LocationId;
  change: "weather" | "resource" | "access" | "epoch" | "survival" | "prediction" | "birth" | "illness" | "injury" | "distress" | "adaptation";
  succeeded: true;
  result: string;
  diff: Record<string, unknown>;
}

export interface AgentInterpretation {
  agentId: AgentId;
  factIds: string[];
  interpretation: string;
}
export interface PracticeObservation {
  key: string;
  label: string;
  count: number;
  agentIds: AgentId[];
  eventIds: string[];
  stability: number;
}
export interface InstitutionObservation {
  key: string;
  label: string;
  evidenceEventIds: string[];
  note: string;
}

export interface MilestoneObservation {
  id: "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15" | "16" | "17" | "18" | "19" | "20" | "21" | "22" | "24" | "25" | "26" | "27" | "28" | "29" | "30" | "31" | "32" | "33" | "34" | "35" | "37" | "38" | "41" | "42" | "44" | "45" | "46" | "48" | "51" | "52" | "53" | "54" | "55" | "58" | "59" | "60" | "101" | "102" | "103" | "104" | "105" | "106" | "108" | "109" | "110" | "111" | "112" | "113" | "116" | "117" | "118" | "119";
  label: string;
  evidenceEventIds: string[];
  note: string;
}

export interface EvolutionIssue {
  id: string;
  severity: "low" | "medium" | "high";
  title: string;
  evidence: string;
}

export interface CivilizationOutcome {
  kind: "destroyed" | "boundary" | "milestones";
  cause: string;
  atTick: number;
  summary: string;
  highlights?: string[];
}

export interface CivilizationState {
  number: number;
  status: "running" | "ended";
  stage: string;
  epoch: EpochKind;
  climate: { kind: ClimateKind; severity: number; sinceTick: number };
  conditions: SimulationConfig;
  startedAtTick: number;
  integrity: number;
  /** 由三体物理层写入的权威天象；缺省时使用独立演化后端自己的气候规则。 */
  externalClimate?: { epoch: EpochKind; kind: ClimateKind; severity: number };
  outcome?: CivilizationOutcome;
}

export interface SimulationLineage {
  kind: "origin" | "accelerated-checkpoint";
  originSeed: number;
  checkpoint: StartingPoint;
  prehistoryConfig: SimulationConfig;
  prehistoryYears: number;
  sourceEventCount: number;
  verifiedFromOrigin: boolean;
  reachedMilestoneIds: MilestoneObservation["id"][];
}

export interface SimulationState {
  schemaVersion: 10;
  timeScale: { unit: "year"; actionsPerAgent: number };
  seed: number;
  tick: number;
  world: {
    time: { present: number; past: WorldEvent[] };
    space: { locations: LocationState[]; routes: RouteState[] };
    matter: MatterState[];
  };
  agents: AgentState[];
  civilization: CivilizationState;
  lineage: SimulationLineage;
  derived: {
    practices: PracticeObservation[];
    institutions: InstitutionObservation[];
    milestones: MilestoneObservation[];
    issues: EvolutionIssue[];
  };
  lastStep: WorldEvent[];
}

export interface DecisionContext {
  state: SimulationState;
  agent: AgentState;
  visibleAgents: AgentState[];
  localMatter: MatterState[];
}
export interface Decision {
  action: Action;
  needLevel: MaslowNeedLevel;
  needFocus: string;
  perception: string;
  choice: string;
  memoryConsolidation?: MemoryConsolidation;
}
export interface AgentDecider { decide(context: DecisionContext): Decision }
export interface BatchDecider { decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]> }

export type EnvironmentEventInput =
  | { kind: "weather"; locationId: LocationId; severity: number; description?: string }
  | { kind: "resource"; locationId: LocationId; resource: MatterKind; delta: number; description?: string }
  | { kind: "access"; locationId: LocationId; open: boolean; description?: string };
export interface AgentExplanation { agentId: AgentId; factId?: string; fact: string; interpretation: string }

export interface EvolutionReport {
  schemaVersion: 10;
  exportedAt: string;
  civilization: CivilizationState;
  finalState: SimulationState;
  checkpoints: SimulationState[];
  review: {
    milestones: MilestoneObservation[];
    issues: EvolutionIssue[];
    actionSuccessRate: number;
    eventCount: number;
  };
}

export interface ArchiveReview {
  runCount: number;
  recurringIssues: Array<{ id: string; title: string; occurrences: number; civilizationNos: number[]; evidence: string }>;
  milestoneFrequency: Array<{ id: MilestoneObservation["id"]; label: string; occurrences: number; rate: number }>;
  predictionAccuracy: number | null;
}

export interface ArchiveRunSummary {
  civilizationNo: number;
  milestones: MilestoneObservation[];
  issues: EvolutionIssue[];
  predictionConfirmed: number;
  predictionResolved: number;
}

export interface OriginReachabilityScenario {
  name: string;
  seed: number;
  config: Omit<Partial<SimulationConfig>, "startingPoint">;
  maximumYears: number;
}

export interface OriginReachabilityReport {
  auditedAt: string;
  targetIds: MilestoneObservation["id"][];
  reachedIds: MilestoneObservation["id"][];
  missingIds: MilestoneObservation["id"][];
  allReachable: boolean;
  evidence: Array<{
    milestoneId: MilestoneObservation["id"];
    label: string;
    scenario: string;
    seed: number;
    reachedAtYear: number;
    evidenceEventIds: string[];
  }>;
  scenarios: Array<{
    name: string;
    seed: number;
    config: SimulationConfig;
    simulatedYears: number;
    reachedIds: MilestoneObservation["id"][];
    outcome?: CivilizationOutcome;
  }>;
}

export const AUDITED_MILESTONE_IDS: MilestoneObservation["id"][] = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
  "21", "22", "24", "25", "26", "27", "28", "29", "30", "31",
  "32", "33", "34", "35", "37", "38", "41", "42", "44", "45",
  "46", "48", "51", "52", "53", "54", "55", "58", "59", "60",
  "101", "102", "103", "104", "105", "106", "108", "109", "110", "111", "112", "113",
  "116", "117", "118", "119",
];

const LOCATIONS: LocationState[] = [
  { id: "homes", name: "林缘缓坡", x: 20, y: 22, neighbors: ["field", "square"], open: true, terrain: { kind: "soil", compaction: 32, cleared: 70, depth: 0 } },
  { id: "field", name: "河湾沃地", x: 49, y: 18, neighbors: ["homes", "workshop", "river"], open: true, terrain: { kind: "soil", compaction: 18, cleared: 82, depth: 0 } },
  { id: "workshop", name: "石脊", x: 76, y: 31, neighbors: ["field", "square"], open: true, terrain: { kind: "stone", compaction: 76, cleared: 90, depth: 0 } },
  { id: "square", name: "开阔地", x: 56, y: 56, neighbors: ["homes", "workshop", "kitchen", "river"], open: true, terrain: { kind: "grass", compaction: 8, cleared: 38, depth: 0 } },
  { id: "kitchen", name: "背风岩地", x: 76, y: 77, neighbors: ["square", "river"], open: true, terrain: { kind: "stone", compaction: 64, cleared: 88, depth: 0 } },
  { id: "river", name: "河岸", x: 25, y: 75, neighbors: ["field", "square", "kitchen"], open: true, terrain: { kind: "water-edge", compaction: 4, cleared: 20, depth: 0 } },
];
// 一次 tick 就是一年；每名可行动人物只做一次年度关键行动。
const ANNUAL_PHASES: AnnualPhase[] = ["spring"];

const MASLOW_PERSONALITY_RULES: Array<{
  level: MaslowNeedLevel;
  label: MaslowNeedLayer["label"];
  keywords: string[];
}> = [
  { level: "physiological", label: "生理需求", keywords: ["食物", "水", "身体", "健康", "休息", "生存", "劳作", "耐劳", "务实", "收获", "野外"] },
  { level: "safety", label: "安全需求", keywords: ["安全", "庇护", "稳定", "秩序", "规则", "谨慎", "克制", "自律", "退路", "加固", "保存", "周到"] },
  { level: "belonging", label: "归属与爱", keywords: ["同伴", "群体", "归属", "亲近", "信赖", "家庭", "互助", "分享", "照料", "倾听", "陪伴", "结交"] },
  { level: "esteem", label: "尊重需求", keywords: ["认可", "尊重", "地位", "证明", "责任", "承担", "带领", "组织", "贡献", "果断", "被看见"] },
  { level: "selfActualization", label: "自我实现", keywords: ["好奇", "试验", "创造", "探索", "理解", "观察", "推理", "记录", "传授", "表达", "想象", "追问", "发现", "新技艺", "成果"] },
];

function seededRandom(seed: number) {
  let value = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function selectCharacterProfiles(seed: number, civilizationNo: number, characterIds?: string[]): CharacterProfile[] {
  // 指定阵容：按档案 id 从抽人池中取人（忽略未知 id），一个都匹配不到再回退随机抽取
  if (characterIds && characterIds.length > 0) {
    const wanted = new Set(characterIds);
    const picked = CHARACTER_PROFILES.filter((profile) => wanted.has(profile.id));
    if (picked.length > 0) return picked;
  }
  const random = seededRandom(seed * 131 + civilizationNo * 977);
  const pool = [...CHARACTER_PROFILES];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  // 三体游戏定制：5~10 人（LLM 决策阶段控制 token 消耗）
  const count = 5 + Math.floor(random() * 6);
  return pool.slice(0, count);
}

function inferMaslowPersonality(description: string): MaslowPersonality {
  const layers = MASLOW_PERSONALITY_RULES.map(({ level, label, keywords }) => {
    const evidence = keywords.filter((keyword) => description.includes(keyword));
    return { level, label, baselineWeight: clamp(28 + evidence.length * 9, 28, 82), evidence };
  });
  const dominant = [...layers].sort((a, b) => b.baselineWeight - a.baselineWeight)[0];
  return {
    dominantLevel: dominant.level,
    summary: `档案描述使${dominant.label}成为长期人格底色；环境中的迫切低层缺口仍可临时改写当前主导层。`,
    layers,
  };
}

function personalityWeight(personality: MaslowPersonality, level: MaslowNeedLevel) {
  return personality.layers.find((layer) => layer.level === level)?.baselineWeight ?? 40;
}

function personalityAdjustedIntensity(agent: AgentState, level: MaslowNeedLevel, situational: number) {
  const baseline = personalityWeight(agent.profile.personality, level);
  return clamp(situational + Math.max(0, baseline - 28) * 0.35);
}

function initialLocation(personality: MaslowPersonality, random: () => number): LocationId {
  const choices: Record<MaslowNeedLevel, LocationId[]> = {
    physiological: ["field", "river", "kitchen"],
    safety: ["homes", "square"],
    belonging: ["square", "homes", "kitchen"],
    esteem: ["workshop", "square"],
    selfActualization: ["workshop", "river", "field"],
  };
  const candidates = choices[personality.dominantLevel];
  return candidates[Math.floor(random() * candidates.length)];
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function clamp(value: number, min = 0, max = 100) { return Math.max(min, Math.min(max, value)) }
function safeText(value: string, fallback: string, max = 28) {
  const cleaned = value.replace(/[<>\n\r]/g, "").trim().slice(0, max);
  return cleaned || fallback;
}

function recordKindLabel(kind: EvidenceRecord["kind"]) {
  return kind === "calendar" ? "历法" : kind === "model" ? "模型" : kind === "tally" ? "计数" : kind === "notation" ? "符号文字" : kind === "map" ? "地图" : kind === "measure" ? "度量" : kind === "account" ? "账目" : kind === "contract" ? "契约" : kind === "image" ? "图像" : "编年记录";
}

export function createDefaultSimulationConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  const endpoint = overrides.endpoint ?? { kind: "ticks", value: 999 };
  const characterIds = Array.isArray(overrides.characterIds)
    ? [...new Set(overrides.characterIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 12)
    : undefined;
  return {
    civilizationNo: Math.max(1, Math.round(overrides.civilizationNo ?? 1)),
    startingPoint: overrides.startingPoint ?? "origin",
    climateBias: overrides.climateBias ?? "balanced",
    chaosIntensity: clamp(Math.round(overrides.chaosIntensity ?? 0), 0, 10),
    endpoint: {
      kind: endpoint.kind === "milestones" ? "milestones" : "ticks",
      value: Math.max(1, Math.round(endpoint.value)),
    },
    ...(characterIds && characterIds.length > 0 ? { characterIds } : {}),
  };
}
function routeId(a: LocationId, b: LocationId) { return [a, b].sort().join("--") }
function createRoutes(locations: LocationState[]): RouteState[] {
  const ids = new Set<string>();
  const routes: RouteState[] = [];
  locations.forEach((location) => location.neighbors.forEach((neighbor) => {
    const id = routeId(location.id, neighbor);
    if (ids.has(id)) return;
    ids.add(id);
    routes.push({ id, from: location.id, to: neighbor, traffic: 0, state: "unmarked", sourceEventIds: [] });
  }));
  return routes;
}
export function formatTime(tick: number) {
  return tick <= 0 ? "文明元年" : `第 ${tick} 年`;
}

function baseMatter(id: string, kind: string, name: string, holder: MatterHolder, quantity: number, unitMass: number, composition: Record<string, number>, traits: MatterTrait[]): MatterState {
  return { id, kind, name, holder, quantity, unitMass, composition, traits };
}

export function createInitialState(seed = 17, inputConfig: Partial<SimulationConfig> = {}): SimulationState {
  const config = createDefaultSimulationConfig(inputConfig);
  const selectedProfiles = selectCharacterProfiles(seed, config.civilizationNo, config.characterIds);
  const random = seededRandom(seed * 193 + config.civilizationNo * 389);
  const agents: AgentState[] = selectedProfiles.map((profile) => {
    const personality = inferMaslowPersonality(profile.description);
    const physiological = personalityWeight(personality, "physiological");
    const safety = personalityWeight(personality, "safety");
    const belonging = personalityWeight(personality, "belonging");
    const esteem = personalityWeight(personality, "esteem");
    const selfActualization = personalityWeight(personality, "selfActualization");
    const locationId = initialLocation(personality, random);
    const founderAge = createFounderAge(seed + config.civilizationNo * 997, profile.id);
    const observe = clamp(Math.round(36 + selfActualization * 0.48 + random() * 12));
    const reason = clamp(Math.round(34 + selfActualization * 0.42 + safety * 0.12 + random() * 10));
    return {
      id: profile.id, name: profile.name, color: profile.color, profile: { description: profile.description, personality }, locationId,
      mind: {
        needs: { focus: personality.summary, intensity: personalityWeight(personality, personality.dominantLevel), dominantLevel: personality.dominantLevel, drives: [], layers: [] },
        affect: { strain: 8, state: "regulated", sourceEventIds: [], supportEventIds: [] },
        cognition: {
          perception: "我只知道眼前地点里发生的事",
          choice: "先看看四周",
          interpretation: "今天还没有足够的事可判断",
          interpretations: [],
          knowledge: [],
          hypotheses: [],
          memory: { episodic: [], summaries: [], capacity: memoryCapacityForReason(reason), forgottenCount: 0, lastConsolidatedTick: 0 },
        },
      },
      limbs: {
        action: null,
        actionText: "观察现在",
        abilities: {
          move: clamp(Math.round(52 + physiological * 0.35 + random() * 15), 60),
          interact: clamp(Math.round(38 + belonging * 0.45 + esteem * 0.1 + random() * 12)),
          craft: clamp(Math.round(34 + selfActualization * 0.48 + random() * 14)),
          build: clamp(Math.round(36 + safety * 0.4 + esteem * 0.12 + random() * 12)),
          observe,
          reason,
        },
      },
      relations: [],
      lineage: { generation: 0 },
      standing: { respect: clamp(Math.round(34 + esteem * 0.35 + random() * 12)), correctPredictions: 0, failedPredictions: 0, careTrust: 0 },
      body: {
        state: "active", hydration: clamp(Math.round(72 + random() * 18)), exposure: 0,
        resilience: clamp(Math.round(38 + physiological * 0.25 + safety * 0.25 + random() * 12)),
        nutrition: clamp(Math.round(70 + random() * 20)), health: clamp(Math.round(82 + random() * 15)),
        fatigue: clamp(Math.round(12 + random() * 20)), temperature: 50, ageYears: founderAge,
        sex: createBiologicalSex(seed + config.civilizationNo * 997, profile.id),
        lifespanYears: createLifespan(seed + config.civilizationNo * 997, profile.id, founderAge),
        surfaceLoad: 0, homeLocationId: locationId, dehydrations: 0, soakings: 0,
        familyPlanning: { desiredChildCount: 1 + Math.floor(deterministicFraction(seed, `desired-children:${profile.id}`) * 3), birthCount: 0, sourceEventIds: [] },
      },
    };
  });
  // 原初聚落至少要有两名能够劳动的先民，避免全员幼童、文明只能空等十余年的开局。
  const minimumAdults = Math.min(2, agents.length);
  const adultCount = agents.filter((agent) => agent.body.ageYears >= ADULT_WORK_AGE).length;
  if (adultCount < minimumAdults) {
    [...agents]
      .filter((agent) => agent.body.ageYears < ADULT_WORK_AGE)
      .sort((first, second) => second.body.ageYears - first.body.ageYears || first.id.localeCompare(second.id))
      .slice(0, minimumAdults - adultCount)
      .forEach((agent) => { agent.body.ageYears = ADULT_WORK_AGE; });
  }
  // 小规模开局至少保留一对未来可育的不同性别先民；选择只看年龄与种子哈希，不解析姓名，也不替人物决定是否结伴。
  const potentialMothers = agents.filter((agent) => agent.body.ageYears <= 42)
    .sort((a, b) => deterministicFraction(seed, `founder-female:${a.id}`) - deterministicFraction(seed, `founder-female:${b.id}`));
  const founderMother = potentialMothers[0];
  const potentialFathers = agents.filter((agent) => agent.id !== founderMother?.id && agent.body.ageYears <= 55)
    .sort((a, b) => deterministicFraction(seed, `founder-male:${a.id}`) - deterministicFraction(seed, `founder-male:${b.id}`));
  if (founderMother && potentialFathers[0]) {
    founderMother.body.sex = "female";
    potentialFathers[0].body.sex = "male";
  }
  agents.forEach((agent, index) => {
    const belonging = personalityWeight(agent.profile.personality, "belonging");
    agent.relations = agents.filter((other) => other.id !== agent.id).map((other, relationIndex) => ({
      agentId: other.id,
      strength: clamp(Math.round(12 + belonging * 0.35 + ((index + relationIndex) * 11) % 18)),
      word: "尚在形成",
      sourceEventIds: [],
    }));
  });
  const provisionedAgent = agents[0];
  const toolAgent = [...agents].sort((a, b) => b.limbs.abilities.craft - a.limbs.abilities.craft)[0];
  const state: SimulationState = {
    schemaVersion: 10,
    timeScale: { unit: "year", actionsPerAgent: ANNUAL_PHASES.length },
    seed,
    tick: 0,
    world: {
      time: { present: 0, past: [] },
      space: { locations: clone(LOCATIONS), routes: createRoutes(LOCATIONS) },
      matter: [
        baseMatter("grain-field", "grain", "谷物", { kind: "space", id: "field" }, 7, 1, { biomass: 1 }, ["raw", "edible"]),
        baseMatter(`grain-${provisionedAgent.id}`, "grain", "谷物", { kind: "agent", id: provisionedAgent.id }, 1, 1, { biomass: 1 }, ["raw", "edible"]),
        baseMatter("crop-field", "standing-crop", "田间谷株", { kind: "space", id: "field" }, 1, 1, { biomass: 1 }, ["raw"]),
        baseMatter("fertility-field", "soil-organic", "土壤中的可用养分", { kind: "space", id: "field" }, 1200, 1, { biomass: 1 }, ["raw"]),
        baseMatter("deer-homes", "deer", "鹿群", { kind: "space", id: "homes" }, 12, 5, { biomass: 4, bone: 1 }, ["animal"]),
        baseMatter("reeds-river", "reeds", "芦苇纤维", { kind: "space", id: "river" }, 30, 1, { fiber: 1 }, ["raw", "fiber"]),
        { ...baseMatter("bitter-herb-river", "bitter-herb", "苦味河草", { kind: "space", id: "river" }, 18, 0.1, { plant: 1 }, ["raw", "botanical"]), bodyEffect: { fever: 1, woundInfection: 0, strain: 0, toxicity: 0.05 } },
        { ...baseMatter("soothing-leaf-field", "soothing-leaf", "芳香叶片", { kind: "space", id: "field" }, 16, 0.08, { plant: 1 }, ["raw", "botanical"]), bodyEffect: { fever: 1, woundInfection: 0, strain: 5, toxicity: 0, adaptation: 0.8 } },
        { ...baseMatter("irritant-root-homes", "irritant-root", "辛烈根茎", { kind: "space", id: "homes" }, 12, 0.12, { plant: 1 }, ["raw", "botanical"]), bodyEffect: { fever: 0, woundInfection: 0, strain: 0, toxicity: 0.35 } },
        baseMatter("clay-square", "clay", "湿黏土", { kind: "space", id: "square" }, 20, 1, { clay: 1 }, ["raw", "recordable"]),
        baseMatter("wood-river", "wood", "原木", { kind: "space", id: "river" }, 10, 1, { wood: 1 }, ["raw", "rigid", "building", "fuel"]),
        baseMatter("stone-river", "stone", "石块", { kind: "space", id: "river" }, 6, 1, { stone: 1 }, ["raw", "rigid", "building"]),
        baseMatter("water-river", "water-source", "流动河水", { kind: "space", id: "river" }, 1, 0, { water: 0 }, ["raw"]),
        baseMatter("meal-kitchen", "meal", "热食", { kind: "space", id: "kitchen" }, 2, 1, { biomass: 1 }, ["crafted", "edible", "cooked"]),
        baseMatter("tool-workshop", "tool", "石制工具", { kind: "space", id: "workshop" }, 1, 1, { stone: 0.7, wood: 0.3 }, ["crafted", "rigid", "cutting", "sharp"]),
        baseMatter(`tool-${toolAgent.id}`, "tool", "石制工具", { kind: "agent", id: toolAgent.id }, 1, 1, { stone: 0.7, wood: 0.3 }, ["crafted", "rigid", "cutting", "sharp"]),
      ],
    },
    agents,
    civilization: {
      number: config.civilizationNo,
      status: "running",
      stage: "生存聚落",
      epoch: "stable",
      climate: { kind: "temperate", severity: 1, sinceTick: 0 },
      conditions: config,
      startedAtTick: 0,
      integrity: 100,
    },
    lineage: {
      kind: "origin",
      originSeed: seed,
      checkpoint: "origin",
      prehistoryConfig: { ...clone(config), startingPoint: "origin" },
      prehistoryYears: 0,
      sourceEventCount: 0,
      verifiedFromOrigin: true,
      reachedMilestoneIds: [],
    },
    derived: { practices: [], institutions: [], milestones: [], issues: [] },
    lastStep: [],
  };
  refreshDrives(state);
  return config.startingPoint === "origin" ? state : seedIntermediateState(state, config.startingPoint);
}

function seedIntermediateState(input: SimulationState, startingPoint: Exclude<StartingPoint, "origin">) {
  let state = clone(input);
  const requestedConditions = clone(state.civilization.conditions);
  const prehistoryConfig: SimulationConfig = {
    ...requestedConditions,
    startingPoint: "origin",
    climateBias: "balanced",
    chaosIntensity: startingPoint === "models" ? 2 : 0,
    endpoint: { kind: "ticks", value: 999 },
  };
  state.civilization.conditions = prehistoryConfig;
  const reached = () => {
    const ids = new Set(state.derived.milestones.map((milestone) => milestone.id));
    if (startingPoint === "shelter") return ids.has("20");
    if (startingPoint === "roads") return ids.has("20") && ids.has("42");
    if (startingPoint === "records") return ids.has("51") && ids.has("52") && ids.has("53");
    return ids.has("24") && ids.has("51") && ids.has("60");
  };
  const maximumPrehistoryYears = startingPoint === "models" ? 180 : startingPoint === "records" ? 120 : 80;
  while (!reached() && state.civilization.status === "running" && state.tick < maximumPrehistoryYears) {
    state = stepSimulation(state);
  }
  if (!reached()) throw new Error(`无法仅凭通用演化规则从原初态生成 ${startingPoint} 检查点`);
  const reachedMilestoneIds = state.derived.milestones.map((milestone) => milestone.id);
  const sourceEventCount = state.world.time.past.length;
  state.civilization.conditions = { ...requestedConditions, startingPoint };
  state.civilization.status = "running";
  delete state.civilization.outcome;
  state.civilization.startedAtTick = state.tick;
  state.lineage = {
    kind: "accelerated-checkpoint",
    originSeed: state.seed,
    checkpoint: startingPoint,
    prehistoryConfig,
    prehistoryYears: state.tick,
    sourceEventCount,
    verifiedFromOrigin: true,
    reachedMilestoneIds,
  };
  const marker: EnvironmentFact = {
    id: `w-${state.tick}-checkpoint`,
    kind: "environment",
    tick: state.tick,
    where: "square",
    change: "survival",
    succeeded: true,
    result: startingPoint === "models" ? "本次演化从已形成住所、道路、文字记录与原始天象模型的模拟中间态开始" : startingPoint === "records" ? "本次演化从已形成住所、道路与早期观测记录的模拟中间态开始" : startingPoint === "roads" ? "本次演化从已形成道路与住所的模拟中间态开始" : "本次演化从已形成住所的模拟中间态开始",
    diff: { simulatedCheckpoint: startingPoint, verifiedFromOrigin: true, prehistoryYears: state.tick, sourceEventCount },
  };
  state.world.time.past.push(marker);
  state.lastStep = [marker];
  state.derived = deriveObservations(state);
  return state;
}

function location(state: SimulationState, id: LocationId) { return state.world.space.locations.find((item) => item.id === id) }
function locationName(state: SimulationState, id: LocationId) { return location(state, id)?.name ?? id }
function matterAt(state: SimulationState, locationId: LocationId) { return state.world.matter.filter((item) => item.holder.kind === "space" && item.holder.id === locationId && item.quantity > 0) }
function carried(state: SimulationState, agentId: AgentId) { return state.world.matter.filter((item) => item.holder.kind === "agent" && item.holder.id === agentId && item.quantity > 0 && item.kind !== "metabolized" && item.kind !== "applied-fiber") }
function carryingMass(state: SimulationState, agentId: AgentId) { return carried(state, agentId).reduce((sum, item) => sum + item.quantity * item.unitMass, 0) }
function hasTrait(state: SimulationState, agentId: AgentId, trait: MatterTrait) { return carried(state, agentId).some((item) => item.traits.includes(trait)) }
function accessibleFactIds(agent: AgentState) {
  return new Set([
    ...agent.mind.cognition.interpretations.flatMap((reading) => reading.factIds),
    ...agent.mind.cognition.knowledge.flatMap((claim) => claim.sourceEventIds),
    ...agent.mind.cognition.memory.episodic.flatMap((fragment) => fragment.sourceEventIds),
    ...agent.mind.cognition.memory.summaries.flatMap((summary) => summary.sourceEventIds),
  ]);
}
function completedSettlementShelter(state: SimulationState) {
  return state.world.matter.find((matter) => matter.holder.kind === "space" && matter.construction?.complete && (matter.construction.effects?.weatherProtection ?? 0) >= 58);
}
function activeShelterProject(state: SimulationState) {
  return state.world.matter
    .filter((matter) => matter.holder.kind === "space" && matter.construction?.purpose === "shelter" && !matter.construction.complete && (location(state, matter.holder.id)?.terrain.cleared ?? 0) >= 25)
    .sort((first, second) => (second.construction?.progress ?? 0) - (first.construction?.progress ?? 0) || (first.sourceEventIds?.[0] ?? first.id).localeCompare(second.sourceEventIds?.[0] ?? second.id))[0];
}
function preferredShelterSiteId(state: SimulationState): LocationId {
  const project = activeShelterProject(state);
  return project?.holder.kind === "space" ? project.holder.id : "homes";
}
function nextLocation(state: SimulationState, agent: AgentState, target: LocationId) {
  const here = location(state, agent.locationId)!;
  if (here.id === target) return target;
  const queue: Array<{ id: LocationId; first: LocationId }> = here.neighbors
    .filter((id) => location(state, id)?.open)
    .map((id) => ({ id, first: id }));
  const visited = new Set<LocationId>([here.id]);
  while (queue.length) {
    const step = queue.shift()!;
    if (visited.has(step.id)) continue;
    visited.add(step.id);
    if (step.id === target) return step.first;
    const node = location(state, step.id);
    node?.neighbors.filter((id) => location(state, id)?.open && !visited.has(id)).forEach((id) => queue.push({ id, first: step.first }));
  }
  return agent.locationId;
}
function totalComposition(items: { matter: MatterState; quantity: number }[]) {
  const composition: Record<string, number> = {};
  for (const { matter, quantity } of items) for (const [substance, amount] of Object.entries(matter.composition)) composition[substance] = (composition[substance] ?? 0) + amount * quantity;
  return composition;
}
function removeMatter(state: SimulationState, matter: MatterState, quantity: number) {
  matter.quantity = Math.max(0, matter.quantity - quantity);
  state.world.matter = state.world.matter.filter((item) => item.quantity > 0 || item.construction);
}
function mergeMatter(state: SimulationState, created: MatterState) {
  const existing = state.world.matter.find((item) => item.kind === created.kind && item.name === created.name && item.holder.kind === created.holder.kind && item.holder.id === created.holder.id && item.storedIn === created.storedIn && item.personId === created.personId && item.traits.join("|") === created.traits.join("|") && !item.construction);
  if (existing) existing.quantity += created.quantity;
  else state.world.matter.push(created);
}
function careOutcomeFromDiff(diff: Record<string, unknown>): PlaceUseTrace["outcome"] | null {
  if (diff.examinedAbnormality === true) return "observed";
  const before = Number(diff.severityBefore ?? diff.illnessBefore ?? diff.strainBefore);
  const after = Number(diff.severityAfter ?? diff.illnessAfter ?? diff.strainAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return after < before ? "improved" : after > before ? "worsened" : "unchanged";
}
function tracePlaceUse(state: SimulationState, fact: ActionFact) {
  if (!fact.succeeded) return;
  const outcome = careOutcomeFromDiff(fact.diff);
  const subjectAgentId = typeof fact.diff.targetAgentId === "string" ? fact.diff.targetAgentId : typeof fact.diff.partnerId === "string" ? fact.diff.partnerId : null;
  if (!outcome || !subjectAgentId) return;
  const place = location(state, fact.where);
  if (!place) return;
  place.useTraces = [...(place.useTraces ?? []), { kind: "care", tick: fact.tick, actorId: fact.who, subjectAgentId, eventId: fact.id, outcome }].slice(-160);
}
function leaveRemains(state: SimulationState, agent: AgentState, sourceEventId: string) {
  if (state.world.matter.some((matter) => matter.personId === agent.id && (matter.traits.includes("remains") || matter.traits.includes("memorial")))) return;
  state.world.matter.push({
    ...baseMatter(`remains-${agent.id}-${sourceEventId}`, "human-remains", `${agent.name}的遗体`, { kind: "space", id: agent.locationId }, 1, 1, { biomass: 0.78, bone: 0.22 }, ["remains"]),
    personId: agent.id,
    sourceEventIds: [sourceEventId],
  });
}
export function memoryCapacityForReason(reason: number) {
  return Math.round(clamp(5 + reason / 9, 9, 17));
}

function memorySalience(fact: WorldEvent) {
  if (fact.kind === "environment") return fact.change === "prediction" || fact.change === "survival" || fact.change === "illness" || fact.change === "injury" ? 96 : fact.change === "epoch" ? 84 : 66;
  if (!fact.succeeded) return 78;
  if (fact.action.type === "move") return 42;
  const mode = fact.action.intent?.mode;
  return mode === "adapt" || mode === "assemble" || mode === "predict" || mode === "record" || mode === "inspect-body" || mode === "apply-material" || mode === "treat" || mode === "fit-support" || mode === "bury" ? 90
    : mode === "observe" ? 82
      : mode === "shape" || mode === "hunt" || mode === "tend" || mode === "trade" || mode === "bond" ? 72
      : 54;
}

function remember(agent: AgentState, reading: AgentInterpretation, fact?: WorldEvent) {
  agent.mind.cognition.interpretation = reading.interpretation;
  agent.mind.cognition.interpretations.push(reading);
  if (!fact) return;
  const fragment: MemoryFragment = {
    id: fact.id,
    tick: fact.tick,
    summary: reading.interpretation,
    salience: memorySalience(fact),
    sourceEventIds: [fact.id],
    ...(fact.kind === "action" ? { actionKey: actionKey(fact.action), succeeded: fact.succeeded } : {}),
  };
  const existing = agent.mind.cognition.memory.episodic.findIndex((item) => item.id === fragment.id);
  if (existing >= 0) agent.mind.cognition.memory.episodic[existing] = fragment;
  else agent.mind.cognition.memory.episodic.push(fragment);
}

function trimMemorySummaries(agent: AgentState) {
  const memory = agent.mind.cognition.memory;
  const summaryLimit = Math.max(2, Math.floor(agent.limbs.abilities.reason / 18));
  if (memory.summaries.length <= summaryLimit) return;
  const overflow = memory.summaries.splice(0, memory.summaries.length - summaryLimit + 1);
  const sourceLimit = Math.max(8, Math.floor(agent.limbs.abilities.reason / 5));
  memory.summaries.unshift({
    id: `memory-${agent.id}-${overflow[0].fromTick}-${overflow.at(-1)!.toTick}`,
    fromTick: overflow[0].fromTick,
    toTick: overflow.at(-1)!.toTick,
    summary: overflow.map((item) => item.summary).join("；").slice(0, 180),
    lessons: [...new Set(overflow.flatMap((item) => item.lessons))].slice(0, Math.max(1, Math.floor(agent.limbs.abilities.reason / 25))),
    sourceEventIds: [...new Set(overflow.flatMap((item) => item.sourceEventIds))].slice(-sourceLimit),
  });
}

function trimSemanticMemory(agent: AgentState) {
  const limit = Math.max(5, Math.floor(agent.limbs.abilities.reason / 8));
  if (agent.mind.cognition.knowledge.length <= limit) return;
  agent.mind.cognition.knowledge = [...agent.mind.cognition.knowledge]
    .sort((a, b) => b.confidence - a.confidence || b.sourceEventIds.length - a.sourceEventIds.length)
    .slice(0, limit);
}

export function applyMemoryConsolidation(agent: AgentState, consolidation: MemoryConsolidation, tick: number) {
  const memory = agent.mind.cognition.memory;
  memory.capacity = memoryCapacityForReason(agent.limbs.abilities.reason);
  if (memory.episodic.length <= memory.capacity) return false;
  const validIds = new Set(memory.episodic.map((fragment) => fragment.id));
  const retainLimit = memory.capacity;
  const requested = consolidation.retainFragmentIds.filter((id) => validIds.has(id)).slice(0, retainLimit);
  const rankedFallback = [...memory.episodic].sort((a, b) => b.salience - a.salience || b.tick - a.tick).map((item) => item.id);
  const retainIds = new Set([...new Set([...requested, ...rankedFallback])].slice(0, retainLimit));
  const forgotten = memory.episodic.filter((fragment) => !retainIds.has(fragment.id));
  if (!forgotten.length) return false;
  const sourceLimit = Math.max(8, Math.floor(agent.limbs.abilities.reason / 5));
  memory.summaries.push({
    id: `memory-${agent.id}-${forgotten[0].tick}-${tick}`,
    fromTick: Math.min(...forgotten.map((fragment) => fragment.tick)),
    toTick: Math.max(...forgotten.map((fragment) => fragment.tick)),
    summary: safeText(consolidation.summary, forgotten.map((fragment) => fragment.summary).join("；"), 180),
    lessons: consolidation.lessons.map((lesson) => safeText(lesson, "", 72)).filter(Boolean).slice(0, Math.max(1, Math.floor(agent.limbs.abilities.reason / 22))),
    sourceEventIds: [...new Set(forgotten.flatMap((fragment) => fragment.sourceEventIds))].slice(-sourceLimit),
  });
  memory.episodic = memory.episodic.filter((fragment) => retainIds.has(fragment.id)).sort((a, b) => a.tick - b.tick);
  const accessibleIds = new Set([...memory.episodic.flatMap((fragment) => fragment.sourceEventIds), ...memory.summaries.flatMap((summary) => summary.sourceEventIds)]);
  agent.mind.cognition.interpretations = agent.mind.cognition.interpretations.filter((reading) => reading.factIds.some((id) => accessibleIds.has(id)));
  memory.forgottenCount += forgotten.length;
  memory.lastConsolidatedTick = tick;
  trimMemorySummaries(agent);
  trimSemanticMemory(agent);
  return true;
}

function consolidateMemoryLocally(agent: AgentState, tick: number) {
  const memory = agent.mind.cognition.memory;
  memory.capacity = memoryCapacityForReason(agent.limbs.abilities.reason);
  if (memory.episodic.length <= memory.capacity) return false;
  const overflow = memory.episodic.length - memory.capacity;
  const forgotten = [...memory.episodic].sort((a, b) => a.salience - b.salience || a.tick - b.tick).slice(0, overflow);
  return applyMemoryConsolidation(agent, {
    summary: forgotten.map((fragment) => fragment.summary).join("；").slice(0, 180),
    lessons: [...new Set(forgotten.map((fragment) => fragment.succeeded === false ? "失败的手段需要重新判断" : fragment.summary))].slice(0, 3),
    retainFragmentIds: memory.episodic.filter((fragment) => !forgotten.some((item) => item.id === fragment.id)).map((fragment) => fragment.id),
  }, tick);
}

function learn(agent: AgentState, claim: string, confidence: number, eventId: string, kind?: KnowledgeClaim["kind"], sourceEventIds: string[] = []) {
  const existing = agent.mind.cognition.knowledge.find((item) => item.claim === claim);
  if (existing) {
    existing.confidence = clamp(Math.max(existing.confidence, confidence) + 4);
    existing.kind ??= kind;
    for (const sourceId of [eventId, ...sourceEventIds]) if (!existing.sourceEventIds.includes(sourceId)) existing.sourceEventIds.push(sourceId);
    return;
  }
  agent.mind.cognition.knowledge.push({ claim, confidence: clamp(confidence), sourceEventIds: [...new Set([eventId, ...sourceEventIds])], ...(kind ? { kind } : {}) });
}

function strengthenRelation(agent: AgentState, other: AgentState, eventId: string, amount: number) {
  for (const [from, to] of [[agent, other], [other, agent]] as const) {
    const relation = from.relations.find((item) => item.agentId === to.id);
    if (!relation) continue;
    relation.strength = clamp(relation.strength + amount);
    relation.word = relation.strength >= 75 ? "彼此信赖" : relation.strength >= 55 ? "经常合作" : "有过共同经历";
    if (!relation.sourceEventIds.includes(eventId)) relation.sourceEventIds.push(eventId);
  }
}

type ConceptionAttempt = {
  conceived: boolean;
  fertile: boolean;
  chanceWithoutBarrier: number;
  chanceWithBarrier: number;
  wouldConceiveWithoutBarrier: boolean;
  preventedByBarrier: boolean;
  motherId?: AgentId;
  fatherId?: AgentId;
};

function tryConceive(state: SimulationState, first: AgentState, second: AgentState, eventId: string, barrierId?: string): ConceptionAttempt {
  const mother = first.body.sex === "female" ? first : second.body.sex === "female" ? second : null;
  const father = first.body.sex === "male" ? first : second.body.sex === "male" ? second : null;
  const empty = { conceived: false, fertile: false, chanceWithoutBarrier: 0, chanceWithBarrier: 0, wouldConceiveWithoutBarrier: false, preventedByBarrier: false };
  if (!mother || !father || mother.body.pregnancy) return empty;
  if (!isFertileAge(mother.body.sex, mother.body.ageYears) || !isFertileAge(father.body.sex, father.body.ageYears)) return empty;
  if (mother.body.health < 65 || mother.body.nutrition < 60 || father.body.health < 55) return empty;
  const relation = mother.relations.find((item) => item.agentId === father.id)?.strength ?? 0;
  if (relation < 45) return empty;
  const chanceWithoutBarrier = Math.min(0.5, 0.2 + Math.max(0, relation - 45) * 0.01);
  const chanceWithBarrier = barrierId ? chanceWithoutBarrier * 0.08 : chanceWithoutBarrier;
  const roll = deterministicFraction(state.seed, `conceive:${state.tick}:${mother.id}:${father.id}`);
  const wouldConceiveWithoutBarrier = roll < chanceWithoutBarrier;
  const conceived = roll < chanceWithBarrier;
  const result: ConceptionAttempt = {
    conceived,
    fertile: true,
    chanceWithoutBarrier,
    chanceWithBarrier,
    wouldConceiveWithoutBarrier,
    preventedByBarrier: Boolean(barrierId && wouldConceiveWithoutBarrier && !conceived),
    motherId: mother.id,
    fatherId: father.id,
  };
  if (!conceived) return result;
  mother.body.pregnancy = { fatherId: father.id, conceivedTick: state.tick + 1, dueTick: state.tick + 2, conceptionEventId: eventId, ...(barrierId ? { barrierId } : {}) };
  mother.limbs.actionText = "妊娠 · 暂停生产一年";
  return result;
}

function createNewborn(state: SimulationState, mother: AgentState, father: AgentState, nextTick: number, birthEventId: string): AgentState {
  const id = `child-${nextTick}-${state.agents.length}`;
  const name = createNewbornName(
    state.seed + state.civilization.number * 997,
    id,
    state.agents.map((agent) => agent.name),
  );
  const personality = inferMaslowPersonality("在父母和聚落照料中成长，重视生存、安全、同伴与学习。");
  const reason = 10;
  return {
    id,
    name,
    color: mother.color,
    profile: { description: `${mother.name}与${father.name}的下一代，由聚落为其取名。`, personality },
    locationId: mother.locationId,
    mind: {
      needs: { focus: "依赖照料与安全环境成长", intensity: 75, dominantLevel: "physiological", drives: [], layers: [] },
      affect: { strain: 5, state: "regulated", sourceEventIds: [], supportEventIds: [] },
      cognition: {
        perception: "尚在认识身边的人与环境", choice: "依赖照料成长", interpretation: "世界从父母与聚落开始",
        interpretations: [], knowledge: [], hypotheses: [],
        memory: { episodic: [], summaries: [], capacity: memoryCapacityForReason(reason), forgottenCount: 0, lastConsolidatedTick: nextTick },
      },
    },
    limbs: { action: null, actionText: "幼年 · 接受照料", abilities: { move: 15, interact: 18, craft: 5, build: 5, observe: 12, reason } },
    relations: state.agents.filter((agent) => agent.body.state !== "dead").map((agent) => ({ agentId: agent.id, strength: agent.id === mother.id || agent.id === father.id ? 78 : 30, word: agent.id === mother.id || agent.id === father.id ? "亲子依恋" : "同处聚落", sourceEventIds: [birthEventId] })),
    lineage: { generation: Math.max(mother.lineage.generation, father.lineage.generation) + 1, motherId: mother.id, fatherId: father.id },
    standing: { respect: 20, correctPredictions: 0, failedPredictions: 0, careTrust: 0 },
    body: {
      state: "active", hydration: 75, exposure: 0, resilience: 24, nutrition: 75, health: 92, fatigue: 35, temperature: 50,
      ageYears: 0, sex: createBiologicalSex(state.seed + state.civilization.number * 997, id), lifespanYears: createLifespan(state.seed + state.civilization.number * 997, id),
      surfaceLoad: 0, homeLocationId: mother.body.homeLocationId, dehydrations: 0, soakings: 0,
      familyPlanning: { desiredChildCount: 1 + Math.floor(deterministicFraction(state.seed, `desired-children:${id}`) * 3), birthCount: 0, sourceEventIds: [birthEventId] },
    },
  };
}

function canProduce(agent: AgentState): boolean {
  return agent.body.state === "active" && agent.body.ageYears >= ADULT_WORK_AGE && !agent.body.pregnancy && !agent.body.endOfLife;
}

function isDependentChild(agent: AgentState): boolean {
  return agent.body.state !== "dead" && agent.lineage.generation > 0 && agent.body.ageYears < ADULT_WORK_AGE;
}

function dependentChildRequiresAttention(agent: AgentState): boolean {
  return isDependentChild(agent) && (
    agent.body.health < 88 || agent.body.nutrition < 68 || agent.body.hydration < 60 ||
    agent.body.fatigue > 65 || agent.body.exposure > 20 || Boolean(agent.body.illness || agent.body.injury)
  );
}

function driveState(state: SimulationState, agent: AgentState): DriveState[] {
  const recentMemory = agent.mind.cognition.memory.episodic;
  const visible = state.agents.filter((other) => other.id !== agent.id && other.locationId === agent.locationId && other.body.state !== "dead");
  const closeRelation = Math.max(0, ...agent.relations.map((relation) => relation.strength));
  const unresolved = agent.mind.cognition.hypotheses.filter((hypothesis) => hypothesis.status === "pending").length;
  const failures = agent.mind.cognition.hypotheses.filter((hypothesis) => hypothesis.status === "failed").length;
  const recentPlay = recentMemory.filter((fragment) => fragment.tick >= state.tick - 3 && fragment.actionKey?.startsWith("interact:perform:")).length;
  const recentMaking = recentMemory.filter((fragment) => fragment.tick >= state.tick - 4 && (fragment.actionKey?.startsWith("interact:shape:") || fragment.actionKey?.startsWith("interact:assemble:"))).length;
  const recentSuccesses = recentMemory.filter((fragment) => fragment.tick >= state.tick - 5 && fragment.succeeded).length;
  const thermalStress = Math.abs(agent.body.temperature - 50) * 2;
  const reproductiveWindow = isFertileAge(agent.body.sex, agent.body.ageYears) && !agent.body.pregnancy && agent.body.health >= 65 && agent.body.nutrition >= 60;
  const hasHomeShelter = state.world.matter.some((matter) => matter.holder.kind === "space" && matter.holder.id === agent.body.homeLocationId && matter.traits.includes("shelter") && matter.construction?.complete);
  const hasSettlementShelter = Boolean(completedSettlementShelter(state));
  const shelterProject = activeShelterProject(state);
  const visibleIll = visible.find((other) => other.body.illness);
  const visibleInjured = visible.find((other) => other.body.injury?.bleeding);
  const visibleDying = visible.find((other) => other.body.endOfLife);
  const visibleDistressed = visible.find((other) => other.mind.affect.state !== "regulated");
  const dependentNeedingCare = visible.find(dependentChildRequiresAttention);
  const healthyDependent = visible.find(isDependentChild);
  const pregnantOther = visible.find((other) => other.body.pregnancy);
  const localRemains = state.world.matter.some((matter) => matter.holder.kind === "space" && matter.holder.id === agent.locationId && matter.traits.includes("remains"));
  const situationalDrives: DriveState[] = [
    { kind: "hunger", level: "physiological", label: "进食", baseline: 12, intensity: clamp(112 - agent.body.nutrition), reason: `营养 ${Math.round(agent.body.nutrition)}` },
    { kind: "thirst", level: "physiological", label: "饮水", baseline: 16, intensity: clamp(118 - agent.body.hydration), reason: `水分 ${Math.round(agent.body.hydration)}` },
    { kind: "thermal", level: "physiological", label: "调节冷热", baseline: 8, intensity: clamp(thermalStress + agent.body.exposure * 0.5), reason: `体温偏离 ${Math.round(agent.body.temperature - 50)}` },
    { kind: "rest", level: "physiological", label: "休息", baseline: 10, intensity: clamp(agent.body.fatigue), reason: `疲劳 ${Math.round(agent.body.fatigue)}` },
    { kind: "safety", level: "safety", label: "保持安全", baseline: 18, intensity: clamp(100 - agent.body.health + agent.body.exposure * 0.7 + Math.max(0, agent.mind.affect.strain - 40) * 0.75 + (state.civilization.epoch === "chaotic" ? 22 : 0) + (hasSettlementShelter ? hasHomeShelter ? 0 : 6 : shelterProject ? 34 : 42) + (agent.body.pregnancy ? 35 : 0) + (agent.body.illness ? 38 + agent.body.illness.severity * 4 : 0) + (agent.body.injury ? 28 + agent.body.injury.bleeding * 8 : 0)), reason: `健康 ${Math.round(agent.body.health)}，暴露 ${Math.round(agent.body.exposure)}，心理负荷 ${Math.round(agent.mind.affect.strain)}，${agent.body.injury?.bleeding ? `伤口仍在出血（${agent.body.injury.bleeding}）` : agent.body.illness ? `正患${agent.body.illness.kind === "fever" ? "热病" : "伤口感染"}` : agent.body.pregnancy ? "正处于妊娠期，需要更安全的环境" : agent.mind.affect.state !== "regulated" ? "思绪与行动已经偏离平常" : hasHomeShelter ? "生活中心有住所" : hasSettlementShelter ? "聚落已有可共同避险的住所" : shelterProject ? `${locationName(state, shelterProject.holder.id)}已有住所工地，需要集中完工` : "聚落尚无任何住所"}` },
    { kind: "care", level: "belonging", label: "照料弱者", baseline: 14, intensity: clamp(visibleInjured ? 98 : visibleIll ? 94 : visibleDying ? 92 : visibleDistressed ? 90 : dependentNeedingCare ? 72 + (dependentNeedingCare.body.health < 75 || dependentNeedingCare.body.nutrition < 55 || dependentNeedingCare.body.hydration < 45 ? 14 : 0) : pregnantOther ? 76 : localRemains ? 82 : visible.some((other) => other.body.health < 60 || other.body.nutrition < 50 || other.body.hydration < 45) ? 78 : healthyDependent ? 28 : 12), reason: visibleInjured ? `${visibleInjured.name}的伤口仍在出血` : visibleIll ? `${visibleIll.name}出现了明确病症` : visibleDying ? `${visibleDying.name}的身体正持续衰退且无法再劳动` : visibleDistressed ? `${visibleDistressed.name}的言行与平常明显不同` : dependentNeedingCare ? `${dependentNeedingCare.name}的营养、水分、健康或疲劳需要实际帮助` : pregnantOther ? `${pregnantOther.name}身体正在孕育后代，需要分担` : localRemains ? "身边有尚未安置的逝者遗体" : visible.some((other) => other.body.health < 60) ? "身边有人身体虚弱" : healthyDependent ? "身边幼儿目前身体稳定，日常照看不必占据年度关键行动" : "身边暂无明显弱者" },
    { kind: "affiliation", level: "belonging", label: "亲近同伴", baseline: 20, intensity: clamp(62 - Math.min(closeRelation, 62) + (visible.length ? 10 : 0)), reason: `最强关系 ${closeRelation}` },
    { kind: "reproduction", level: "belonging", label: "求偶与繁衍", baseline: 16, intensity: reproductiveWindow ? clamp(46 + (agent.body.ageYears % 9) * 4 + closeRelation * 0.3) : 0, reason: reproductiveWindow ? "年龄、健康和营养允许寻求伴侣" : agent.body.pregnancy ? "妊娠期暂停繁殖与劳动" : "年龄或身体条件暂不允许" },
    { kind: "status", level: "esteem", label: "获得承认与控制", baseline: 12, intensity: clamp(52 - closeRelation * 0.25 - recentSuccesses * 3 + Math.max(0, 55 - agent.standing.respect) * 0.35), reason: `群体尊重 ${Math.round(agent.standing.respect)}；${recentSuccesses ? "已有成果仍期待确认" : "近期缺少被确认的成果"}` },
    { kind: "curiosity", level: "selfActualization", label: "探索和求知", baseline: 24, intensity: clamp(34 + agent.limbs.abilities.observe * 0.35 + failures * 10 - unresolved * 5), reason: failures ? `${failures} 个猜想失败，产生疑问` : "仍有未知变化" },
    { kind: "mastery", level: "selfActualization", label: "制作与掌握", baseline: 18, intensity: clamp(30 + agent.limbs.abilities.craft * 0.35 - recentMaking * 12), reason: recentMaking ? "最近已有制作" : "想改变手边材料" },
    { kind: "play", level: "selfActualization", label: "游戏与节奏", baseline: 16, intensity: clamp(46 + (100 - agent.body.fatigue) * 0.18 - recentPlay * 14), reason: recentPlay ? "最近已有娱乐" : "长时间没有娱乐" },
    { kind: "expression", level: "selfActualization", label: "表达与留下痕迹", baseline: 18, intensity: clamp(30 + agent.mind.cognition.knowledge.length * 2), reason: `已有 ${agent.mind.cognition.knowledge.length} 条认识` },
  ];
  return situationalDrives.map((drive) => ({
    ...drive,
    baseline: personalityWeight(agent.profile.personality, drive.level),
    intensity: personalityAdjustedIntensity(agent, drive.level, drive.intensity),
  })).sort((a, b) => b.intensity - a.intensity);
}

function refreshDrives(state: SimulationState) {
  const layerDefinitions: Array<{ level: MaslowNeedLevel; label: MaslowNeedLayer["label"] }> = [
    { level: "physiological", label: "生理需求" },
    { level: "safety", label: "安全需求" },
    { level: "belonging", label: "归属与爱" },
    { level: "esteem", label: "尊重需求" },
    { level: "selfActualization", label: "自我实现" },
  ];
  for (const agent of state.agents) {
    agent.mind.needs.drives = driveState(state, agent);
    agent.mind.needs.layers = layerDefinitions.map(({ level, label }) => {
      const activeNeeds = agent.mind.needs.drives.filter((drive) => drive.level === level);
      return { level, label, intensity: Math.max(0, ...activeNeeds.map((drive) => drive.intensity)), activeNeeds };
    });
    const urgentLowerLayer = agent.mind.needs.layers.find((layer) => layer.intensity >= 58);
    const dominantLayer = urgentLowerLayer ?? [...agent.mind.needs.layers].sort((a, b) => b.intensity - a.intensity)[0];
    const leading = dominantLayer?.activeNeeds[0] ?? agent.mind.needs.drives[0];
    if (leading) {
      agent.mind.needs.focus = leading.label;
      agent.mind.needs.intensity = leading.intensity;
      agent.mind.needs.dominantLevel = leading.level;
    }
  }
}

function knowledgeFromAction(action: Action, outcome: Outcome): string | null {
  if (!outcome.succeeded) return null;
  if (action.type === "move" && (outcome.diff.route === "trail" || outcome.diff.route === "road")) {
    return `重复通行会使地面显出${outcome.diff.route === "road" ? "道路" : "小径"}`;
  }
  if (action.type !== "interact" || !action.intent) return null;
  const intent = action.intent;
  if (intent.mode === "ignite") return "干燥燃料和切割石器可以留下可控制的火种";
  if (intent.mode === "cook") return "食物接近火种后会变成更容易恢复身体的热食";
  if (intent.mode === "eat") return "食用身边的食物可以恢复营养";
  if (intent.mode === "hunt") return "工具、动物与行动能力共同决定捕猎能否取得肉和皮骨";
  if (intent.mode === "tend") return "持续用食物接近动物会改变动物与人群的关系";
  if (intent.mode === "store") return "容器能让当前食物留到以后再用";
  if (intent.mode === "perform") return "共同节奏、形象或游戏能留下可重复的文化形式";
  if (intent.mode === "claim") return "持续使用的地点或物品会引发公开的占用主张";
  if (intent.mode === "trade") return "双方各自放弃一种持有物，可以换得不同的货物";
  if (intent.mode === "relocate") return "人物在可通行的地点之间移动后，能把生活中心迁到新的地方";
  if (intent.mode === "drink") return "靠近真实水源饮水可以恢复身体水分";
  if (intent.mode === "rest") return "停止行动和利用住所可以降低疲劳并恢复健康";
  if (intent.mode === "warm") return "同地火种能使寒冷身体逐渐回温";
  if (intent.mode === "bond") return intent.gesture === "intimate" && outcome.diff.barrierUsed === true
    ? "柔性覆盖物隔开身体表面与液体后，亲密接触仍能维持关系，但受孕机会明显降低"
    : "安慰、照料与求偶会通过双方关系留下累积后果";
  if (intent.mode === "inspect-body") return "比较疼痛、出血、体温与平常状态，可以辨认具体的身体异常";
  if (intent.mode === "apply-material") return outcome.diff.materialBodyEffect === "beneficial"
    ? `${String(outcome.diff.materialName ?? "这种材料")}作用后，眼前的身体异常有所减轻`
    : outcome.diff.materialBodyEffect === "harmful"
      ? `${String(outcome.diff.materialName ?? "这种材料")}作用后，身体状态反而变差`
      : outcome.diff.bleedingAfter !== undefined ? "纤维材料持续压住伤口能减少出血，但不能消除已经发生的损伤" : "材料作用于身体时，效果取决于材料性质和当时的身体状态";
  if (intent.mode === "treat") return "病人的恢复取决于持续照料以及身边真实的食物、水和住所";
  if (intent.mode === "fit-support") return "贴合身体的刚性支撑可以分担负重，并让伤后功能在持续使用中恢复";
  if (intent.mode === "bury") return "妥善安置遗体并留下标记能保存对逝者的共同记忆";
  if (intent.mode === "shape") return `用工具改变材料形态，可以制成“${safeText(intent.desiredName, "新物品")}”`;
  if (intent.mode === "assemble") return `持续把材料接入地点，可以形成“${safeText(intent.desiredName, "结构")}”`;
  if (intent.mode === "work") {
    const result = intent.change === "compact" ? "压实" : intent.change === "clear" ? "清理平整" : intent.change === "dig" ? "挖深" : intent.change === "cultivate" ? "耕作" : "引水";
    return `持续作用于地面，可以使它${result}`;
  }
  if (intent.mode === "observe") return `反复观察${intent.aspect === "sky" ? "天象" : intent.aspect === "climate" ? "气候" : "数量"}能留下可比较的事实`;
  if (intent.mode === "record") return `把多条事实刻写为${recordKindLabel(intent.recordKind)}，可以跨越当下保存证据`;
  return null;
}

export class LegacyMockDecider implements AgentDecider {
  decide({ state, agent, visibleAgents, localMatter }: DecisionContext): Decision {
    const dehydratedOther = visibleAgents.find((other) => other.body.state === "dehydrated");
    if (agent.body.state === "active" && state.civilization.epoch === "stable" && dehydratedOther) {
      return decision(agent, {
        type: "interact", with: { kind: "agent", id: dehydratedOther.id }, content: `浸泡唤醒${dehydratedOther.name}`,
        intent: { mode: "adapt", change: "soak", targetAgentId: dehydratedOther.id },
      }, "让沉睡的同伴重新活动", "环境已经稳定，同伴仍处于脱水", "用水浸泡唤醒同伴");
    }
    if (agent.body.state === "active" && state.civilization.epoch === "chaotic" && state.civilization.climate.severity >= 5 && agent.body.exposure >= 10) {
      return decision(agent, {
        type: "interact", with: { kind: "agent", id: agent.id }, content: "脱水保存身体",
        intent: { mode: "adapt", change: "dehydrate" },
      }, "熬过无法承受的气候", `暴露已达${agent.body.exposure}，环境仍在恶化`, "暂时脱水停止活动");
    }
    const held = carried(state, agent.id);
    const heldFood = held.find((item) => item.traits.includes("edible"));
    const localFood = localMatter.find((item) => item.traits.includes("edible"));
    const otherNeedingFood = visibleAgents.find((other) => other.body.nutrition < 55);
    if (heldFood && otherNeedingFood && agent.body.nutrition >= 45) return decision(agent, {
      type: "interact", with: { kind: "agent", id: otherNeedingFood.id }, content: `把${heldFood.name}分给${otherNeedingFood.name}`,
      intent: { mode: "give", matterId: heldFood.id, toAgentId: otherNeedingFood.id, quantity: 1 },
    }, "不让同伴挨饿", `${otherNeedingFood.name}的营养低于${agent.name}`, "分享一份食物");
    const anyFire = state.world.matter.find((item) => item.traits.includes("burning") && item.holder.kind === "space");
    const heldRawFood = held.find((item) => item.traits.includes("edible") && !item.traits.includes("cooked"));
    if (heldRawFood && anyFire && agent.body.nutrition >= 35 && agent.locationId !== anyFire.holder.id) return decision(agent, {
      type: "move", to: nextLocation(state, agent, anyFire.holder.id),
    }, "让生食先经过火再食用", `已知${locationName(state, anyFire.holder.id)}有火种`, "把生食带到火边");
    if (heldFood && agent.body.nutrition < 60) return decision(agent, {
      type: "interact", with: { kind: "matter", id: heldFood.id }, content: `食用${heldFood.name}`,
      intent: { mode: "eat", foodId: heldFood.id },
    }, "恢复身体需要的营养", `营养只有${agent.body.nutrition}`, "吃掉一份食物");
    if (localFood && (agent.body.nutrition < 68 || (state.tick + agent.name.charCodeAt(0)) % 7 === 0)) return decision(agent, {
      type: "interact", with: { kind: "matter", id: localFood.id }, content: `采集一份${localFood.name}`,
      intent: { mode: "take", matterId: localFood.id, quantity: 1 },
    }, "为未来饥饿准备食物", `这里有可食用的${localFood.name}`, "采集一份食物");
    const localFire = localMatter.find((item) => item.traits.includes("burning"));
    const rawFood = heldRawFood;
    if (localFire && rawFood && agent.limbs.abilities.craft >= 55) return decision(agent, {
      type: "interact", with: { kind: "matter", id: rawFood.id }, content: `用火烹煮${rawFood.name}`,
      intent: { mode: "cook", foodId: rawFood.id, fireId: localFire.id },
    }, "让食物更容易保存身体", "食物和火种都在手边", "把食物做成熟食");
    const localFuel = localMatter.find((item) => item.traits.includes("fuel"));
    if (!state.world.matter.some((item) => item.traits.includes("burning")) && localFuel && hasTrait(state, agent.id, "cutting") && agent.limbs.abilities.craft >= 60) return decision(agent, {
      type: "interact", with: { kind: "matter", id: localFuel.id }, content: "敲击石器点燃干木",
      intent: { mode: "ignite", fuelId: localFuel.id },
    }, "得到可以驱散寒冷并改变食物的热", "干木与石器在同一地点", "尝试保留火种");
    const field = location(state, "field")!;
    const hasIrrigation = state.world.time.past.some((event) => event.kind === "action" && event.succeeded && event.action.type === "interact" && event.action.intent?.mode === "work" && event.action.intent.change === "irrigate");
    if (agent.locationId === "field" && !hasIrrigation && field.terrain.depth >= 2 && agent.limbs.abilities.build >= 60) return decision(agent, {
      type: "interact", with: { kind: "space", id: "field" }, content: "把浅沟引向田地",
      intent: { mode: "work", siteId: "field", change: "irrigate" },
    }, "让作物不只依靠偶然降水", "浅沟已经能连接田地与水源", "继续引水");
    const cultivationCount = state.world.time.past.filter((event) => event.kind === "action" && event.succeeded && event.action.type === "interact" && event.action.intent?.mode === "work" && event.action.intent.change === "cultivate").length;
    if (agent.locationId === "field" && hasIrrigation && cultivationCount < Math.max(8, (state.tick + 1) * 3) && agent.limbs.abilities.build >= 55) return decision(agent, {
      type: "interact", with: { kind: "space", id: "field" }, content: "翻土并照料谷物",
      intent: { mode: "work", siteId: "field", change: "cultivate" },
    }, "让食物在固定土地反复生长", "田地已有水且可以继续耕作", "栽培谷物");
    if (agent.locationId === "field" && !hasIrrigation && field.terrain.depth < 2 && agent.limbs.abilities.build >= 60) return decision(agent, {
      type: "interact", with: { kind: "space", id: "field" }, content: "挖出通向水源的浅沟",
      intent: { mode: "work", siteId: "field", change: "dig" },
    }, "让田地获得更稳定的水", "土地干燥而河岸有水", "开挖浅沟");
    const successfulActions = state.world.time.past.filter((event): event is ActionFact => event.kind === "action" && event.succeeded);
    const modeEvents = (mode: InteractionIntent["mode"]) => successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === mode);
    const localAnimal = localMatter.find((matter) => matter.traits.includes("animal"));
    if (localAnimal && !localAnimal.traits.includes("domesticated") && modeEvents("hunt").length === 0 && hasTrait(state, agent.id, "cutting") && agent.limbs.abilities.craft >= 58) return decision(agent, {
      type: "interact", with: { kind: "matter", id: localAnimal.id }, content: `尝试捕获${localAnimal.name}`,
      intent: { mode: "hunt", animalId: localAnimal.id },
    }, "取得比采集更多的食物和材料", "附近有动物且我带着锋利工具", "跟踪并捕获一只动物");
    if (localAnimal && heldFood && modeEvents("tend").length < 4) return decision(agent, {
      type: "interact", with: { kind: "matter", id: localAnimal.id }, content: `用${heldFood.name}接近${localAnimal.name}`,
      intent: { mode: "tend", animalId: localAnimal.id, offeringId: heldFood.id },
    }, "让动物不再见人就逃", "手里有食物，动物仍在附近", "尝试持续照料它们");
    if (modeEvents("tend").length < 4 && heldFood && !localAnimal) return decision(agent, { type: "move", to: nextLocation(state, agent, "homes") }, "继续接近此前见过的动物", "住处附近有可被食物吸引的动物", "带食物前往动物活动处");
    const rawHide = held.find((matter) => matter.kind === "hide" && matter.traits.includes("fiber"));
    if (rawHide && !state.world.matter.some((matter) => matter.traits.includes("wearable")) && hasTrait(state, agent.id, "cutting")) return decision(agent, {
      type: "interact", with: { kind: "matter", id: rawHide.id }, content: "裁剪并连接兽皮",
      intent: { mode: "shape", inputIds: [rawHide.id], desiredKind: "clothing", desiredName: "兽皮衣", desiredTraits: ["wearable"] },
    }, "遮挡寒冷和擦伤", "兽皮柔韧而工具能裁开它", "制作可以穿戴的兽皮衣");
    const rawFiber = held.find((matter) => matter.traits.includes("fiber") && matter.kind !== "hide");
    if (rawFiber && !state.world.matter.some((matter) => matter.traits.includes("container")) && hasTrait(state, agent.id, "cutting")) return decision(agent, {
      type: "interact", with: { kind: "matter", id: rawFiber.id }, content: "编结纤维形成容器",
      intent: { mode: "shape", inputIds: [rawFiber.id], desiredKind: "basket", desiredName: "编织储物篮", desiredTraits: ["container"] },
    }, "把零散物品留到以后", "纤维可以交错成有边界的空间", "编出一个容器");
    const localFiber = localMatter.find((matter) => matter.traits.includes("fiber") && matter.kind !== "hide");
    if (localFiber && !state.world.matter.some((matter) => matter.traits.includes("container")) && hasTrait(state, agent.id, "cutting")) return decision(agent, {
      type: "interact", with: { kind: "matter", id: localFiber.id }, content: `取一份${localFiber.name}`,
      intent: { mode: "take", matterId: localFiber.id, quantity: 1 },
    }, "制作能储物的容器", "这里有可以编结的纤维", "先取得一份纤维");
    const container = [...held, ...localMatter].find((matter) => matter.traits.includes("container"));
    if (container && heldFood && !heldFood.traits.includes("stored") && modeEvents("store").length < 5) return decision(agent, {
      type: "interact", with: { kind: "matter", id: heldFood.id }, content: `把${heldFood.name}收入${container.name}`,
      intent: { mode: "store", matterId: heldFood.id, containerId: container.id },
    }, "为食物短缺的年份留下一份", "眼前食物有余且已有容器", "储藏一份食物");
    const buildingItem = held.find((item) => item.traits.includes("building") && item.kind !== "tool");
    const rawWood = held.find((item) => item.kind === "wood");
    const house = state.world.matter.find((item) => item.construction?.purpose === "shelter" && item.holder.kind === "space" && item.holder.id === "square");
    const unfinished = !house?.construction?.complete;

    if (unfinished && rawWood && hasTrait(state, agent.id, "cutting") && agent.limbs.abilities.craft >= 60) {
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: rawWood.id }, content: "把原木削成平整木板",
        intent: { mode: "shape", inputIds: [rawWood.id], desiredKind: "plank", desiredName: "木板", desiredTraits: ["flat", "building"] },
      }, "把原木变成更适合搭建的形状", "工具和原木都在手边", "试着削出一块木板");
    }
    if (unfinished && buildingItem && agent.locationId === "square") {
      return decision(agent, {
        type: "interact", with: { kind: "space", id: "square" }, content: "把材料接入正在形成的房屋",
        intent: { mode: "assemble", inputIds: [buildingItem.id], siteId: "square", desiredKind: "house", desiredName: "共同搭建的遮蔽结构", purpose: "shelter", arrangement: { support: 72, cover: 78, boundary: 68, opening: 32 } },
      }, "和别人一起建起能遮蔽风雨的地方", "空地上可以把材料稳定连接起来", "继续搭建房屋");
    }
    if (unfinished && buildingItem) {
      const to = nextLocation(state, agent, "square");
      return decision(agent, { type: "move", to }, "把材料送到共同建设的地方", "材料正在我手里", `前往${locationName(state, to)}`);
    }
    const localWood = localMatter.find((item) => item.kind === "wood");
    const localStone = localMatter.find((item) => item.kind === "stone");
    if (unfinished && (localWood || localStone)) {
      const material = localWood ?? localStone!;
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: material.id }, content: `拿起一份${material.name}`,
        intent: { mode: "take", matterId: material.id, quantity: 1 },
      }, "找到能改变环境的材料", `这里有${material.name}`, `带走一份${material.name}`);
    }
    if (unfinished) {
      const to = nextLocation(state, agent, "river");
      return decision(agent, { type: "move", to }, "寻找适合建造的材料", "河岸可能有木石", `前往${locationName(state, to)}`);
    }

    const rawWheelWood = held.find((matter) => matter.kind === "wood");
    if (rawWheelWood && !state.world.matter.some((matter) => matter.traits.includes("wheel")) && hasTrait(state, agent.id, "cutting")) return decision(agent, {
      type: "interact", with: { kind: "matter", id: rawWheelWood.id }, content: "削出可滚动的圆木轮",
      intent: { mode: "shape", inputIds: [rawWheelWood.id], desiredKind: "wheel", desiredName: "木轮", desiredTraits: ["wheel"] },
    }, "让沉重东西更容易移动", "圆形木件在地面上比拖拽更省力", "制作滚动轮具");
    const ownRelocation = modeEvents("relocate").find((event) => event.who === agent.id);
    if (!ownRelocation && state.tick >= 5 && agent.locationId !== agent.body.homeLocationId && carried(state, agent.id).length >= 1) return decision(agent, {
      type: "interact", with: { kind: "space", id: agent.locationId }, content: "把生活中心迁到这里",
      intent: { mode: "relocate", to: agent.locationId },
    }, "住在更接近当前资源与同伴的地方", "我已经离开原来的生活中心并带着物品", "在这里建立新的日常落脚点");

    const ownCultivation = modeEvents("work").filter((event) => event.who === agent.id && event.action.type === "interact" && event.action.intent?.mode === "work" && event.action.intent.change === "cultivate");
    if (agent.locationId === "field" && ownCultivation.length >= 3 && !modeEvents("claim").some((event) => event.who === agent.id)) return decision(agent, {
      type: "interact", with: { kind: "space", id: "field" }, content: "说明自己长期照料的田地",
      intent: { mode: "claim", subjectId: "field", claim: "这片我持续照料的土地，其收获应先由照料者支配" },
    }, "保住自己反复劳动的成果", "我在同一片田地投入了多年劳动", "向在场者提出使用边界");

    const tradeEvents = modeEvents("trade");
    const tradeable = held.find((matter) => !matter.traits.includes("cutting") && !matter.traits.includes("wearable") && !matter.traits.includes("container") && !matter.traits.includes("wheel") && matter.kind !== "metabolized");
    if (tradeEvents.length < 9 && agent.locationId === "square" && tradeable) {
      const partner = visibleAgents.find((other) => carried(state, other.id).some((matter) => matter.kind !== tradeable.kind && !matter.traits.includes("cutting") && matter.kind !== "metabolized"));
      const requested = partner ? carried(state, partner.id).find((matter) => matter.kind !== tradeable.kind && !matter.traits.includes("cutting") && matter.kind !== "metabolized") : undefined;
      if (partner && requested) return decision(agent, {
        type: "interact", with: { kind: "agent", id: partner.id }, content: `与${partner.name}交换不同物品`,
        intent: { mode: "trade", offeredMatterId: tradeable.id, requestedMatterId: requested.id, withAgentId: partner.id },
      }, "用手里的东西换得自己没有的东西", `${partner.name}在场且持有不同物品`, "提出彼此交付一份货物");
    }
    if (tradeEvents.length < 9 && tradeable && agent.locationId !== "square") return decision(agent, { type: "move", to: nextLocation(state, agent, "square") }, "寻找可能需要这种物品的人", "共同空地容易遇到持有不同东西的人", "把可交换物带去空地");

    const culturalForms = ["music", "dance", "game", "image"] as const;
    const culturalForm = culturalForms[state.agents.findIndex((item) => item.id === agent.id) % culturalForms.length];
    const culturalCount = successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "perform" && event.action.intent.form === culturalForm).length;
    const culturalPartner = visibleAgents[0];
    const localRecordMedium = held.find((matter) => matter.traits.includes("recordable")) ?? localMatter.find((matter) => matter.traits.includes("recordable"));
    if (culturalCount < 4 && (culturalForm === "music" || culturalForm === "image" ? culturalForm === "music" || Boolean(localRecordMedium) : Boolean(culturalPartner))) return decision(agent, {
      type: "interact", with: culturalForm === "image" && localRecordMedium ? { kind: "matter", id: localRecordMedium.id } : culturalPartner ? { kind: "agent", id: culturalPartner.id } : { kind: "space", id: agent.locationId }, content: culturalForm === "music" ? "敲击材料并哼唱节奏" : culturalForm === "image" ? "描画眼前人物与地形" : culturalForm === "dance" ? `与${culturalPartner?.name}随节奏舞动` : `与${culturalPartner?.name}进行规则游戏`,
      intent: { mode: "perform", form: culturalForm, ...(culturalPartner ? { partnerId: culturalPartner.id } : {}), ...(culturalForm === "image" && localRecordMedium ? { mediumId: localRecordMedium.id } : {}) },
    }, "在生存之外重复一种让人投入的形式", culturalPartner ? `${culturalPartner.name}在场，可以一起参与` : "手边材料能发出重复节奏", "试着重复并让别人理解这种形式");

    const heardPhrase = agent.mind.cognition.knowledge.find((claim) => claim.claim.startsWith("听到固定说法："));
    const imitatedPhrase = heardPhrase?.claim.slice("听到固定说法：".length);
    const alreadyRepeated = imitatedPhrase && successfulActions.some((event) => event.who === agent.id && event.action.type === "interact" && event.action.intent?.mode === "express" && event.action.intent.speech === imitatedPhrase);
    if (imitatedPhrase && culturalPartner && !alreadyRepeated) return decision(agent, {
      type: "interact", with: { kind: "agent", id: culturalPartner.id }, content: "重复听来的固定说法",
      intent: { mode: "express", toAgentId: culturalPartner.id, speech: imitatedPhrase },
    }, "用别人能认出的说法让意思更清楚", "我听过这句话，也有人在场", "重复并传开固定说法");

    const ownObservations = state.world.time.past.filter((event): event is ActionFact => event.kind === "action" && event.who === agent.id && event.succeeded && event.action.type === "interact" && event.action.intent?.mode === "observe");
    const recordMedium = held.find((item) => item.traits.includes("recordable")) ?? localMatter.find((item) => item.traits.includes("recordable"));
    const records = state.world.matter.flatMap((matter) => matter.records ?? []);
    const ownRecords = records.filter((record) => record.authorId === agent.id);
    const calendar = records.find((record) => record.kind === "calendar");
    const instrument = [...held, ...localMatter].find((item) => item.traits.includes("instrument") && item.construction?.complete);
    const resolvedHypotheses = agent.mind.cognition.hypotheses.filter((hypothesis) => hypothesis.status !== "pending");
    const failedHypothesis = agent.mind.cognition.hypotheses.find((hypothesis) => hypothesis.status === "failed");
    const pendingHypothesis = agent.mind.cognition.hypotheses.find((hypothesis) => hypothesis.status === "pending");
    const experiencedMoves = successfulActions.filter((event) => event.who === agent.id && event.action.type === "move");
    const experiencedFactIds = accessibleFactIds(agent);
    const experiencedTrades = tradeEvents.filter((event) => event.who === agent.id || experiencedFactIds.has(event.id));
    const experiencedClaims = modeEvents("claim").filter((event) => event.who === agent.id || event.where === agent.locationId);
    const experiencedStores = modeEvents("store").filter((event) => event.who === agent.id || event.where === agent.locationId);
    if (recordMedium && experiencedTrades.length >= 2 && !ownRecords.some((record) => record.kind === "contract")) return decision(agent, {
      type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "把交换约定刻写下来",
      intent: { mode: "record", mediumId: recordMedium.id, recordKind: "contract", sourceEventIds: experiencedTrades.slice(-6).map((event) => event.id), note: "双方交付何物以及彼此承认的交换约定" },
    }, "让已经达成的约定不只依靠记忆", "多次交换表明口头约定可能被忘记", "把交换双方与货物刻在载体上");
    if (recordMedium && experiencedTrades.length >= 3 && !ownRecords.some((record) => record.kind === "measure")) return decision(agent, {
      type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "比较货物份量并留下尺度",
      intent: { mode: "record", mediumId: recordMedium.id, recordKind: "measure", sourceEventIds: experiencedTrades.slice(-6).map((event) => event.id), note: "用同一份量刻痕比较不同货物" },
    }, "减少每次交换时对份量的争执", "不同货物需要可重复比较的共同尺度", "约定并刻下同一份量单位");
    if (recordMedium && experiencedTrades.length + experiencedClaims.length + experiencedStores.length >= 4 && !ownRecords.some((record) => record.kind === "account")) {
      const sources = [...experiencedTrades, ...experiencedClaims, ...experiencedStores].sort((a, b) => a.tick - b.tick).slice(-8).map((event) => event.id);
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "记录货物往来与尚欠份量",
        intent: { mode: "record", mediumId: recordMedium.id, recordKind: "account", sourceEventIds: sources, note: "按人物、货物与份量记下储藏、交换和未结清承诺" },
      }, "知道货物去了哪里以及谁还应回应", "交换与储藏已经多到记忆不可靠", "用固定刻痕整理往来账目");
    }
    if (recordMedium && experiencedMoves.length >= 8 && !ownRecords.some((record) => record.kind === "map")) return decision(agent, {
      type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "把走过的地点与道路画下来",
      intent: { mode: "record", mediumId: recordMedium.id, recordKind: "map", sourceEventIds: experiencedMoves.slice(-12).map((event) => event.id), note: "用相对位置和连接线表示亲自走过的地点" },
    }, "让别人按记录找到自己走过的地方", "多次移动已留下可比较的地点顺序", "把地点和道路画成图");
    const modelMotivation = failedHypothesis ?? resolvedHypotheses[0];
    if (modelMotivation && resolvedHypotheses.length >= 2 && !state.world.matter.some((item) => item.traits.includes("instrument")) && agent.limbs.abilities.build >= 60) {
      const unfinishedModel = state.world.matter.find((item) => item.kind === "sky-model" && item.construction && !item.construction.complete && item.holder.kind === "space");
      const building = held.find((item) => (item.traits.includes("building") || item.traits.includes("rigid")) && !item.traits.includes("cutting") && !item.traits.includes("recordable"));
      const localBuilding = localMatter.find((item) => (item.traits.includes("building") || item.traits.includes("rigid")) && !item.traits.includes("cutting") && !item.traits.includes("recordable"));
      if (unfinishedModel && building) {
        if (agent.locationId !== unfinishedModel.holder.id) {
          const to = nextLocation(state, agent, unfinishedModel.holder.id);
          return decision(agent, { type: "move", to }, "继续改进已有天象模型", `模型留在${locationName(state, unfinishedModel.holder.id)}`, `把材料送往${locationName(state, to)}`);
        }
        return decision(agent, {
          type: "interact", with: { kind: "space", id: unfinishedModel.holder.id }, content: "把材料接入天象模型",
          intent: { mode: "assemble", inputIds: [building.id], siteId: unfinishedModel.holder.id, desiredKind: "sky-model", desiredName: "简易天象模型", purpose: "instrument", arrangement: { support: 65, cover: 20, boundary: 20, opening: 85 } },
        }, "弄清上次预测为何失败", "已有模型还缺少可转动的部件", "继续完善模型");
      }
      if (unfinishedModel && localBuilding) return decision(agent, { type: "interact", with: { kind: "matter", id: localBuilding.id }, content: `拿取${localBuilding.name}改进模型`, intent: { mode: "take", matterId: localBuilding.id, quantity: 1 } }, "检验失败预测的原因", `这里有可用于模型的${localBuilding.name}`, "把材料送回模型");
      if (unfinishedModel) {
        const to = nextLocation(state, agent, "river");
        return decision(agent, { type: "move", to }, "寻找补全模型的材料", `模型留在${locationName(state, unfinishedModel.holder.id)}等待继续搭建`, `前往${locationName(state, to)}`);
      }
      const siteReady = location(state, agent.locationId)?.terrain.cleared >= 25;
      if (building && !siteReady) {
        const to = nextLocation(state, agent, "field");
        return decision(agent, { type: "move", to }, "把模型材料带到平整地点", "这里地面松软，无法承载机械", `前往${locationName(state, to)}`);
      }
      if (building) return decision(agent, {
        type: "interact", with: { kind: "space", id: agent.locationId }, content: "开始搭建天象模型",
        intent: { mode: "assemble", inputIds: [building.id], siteId: agent.locationId, desiredKind: "sky-model", desiredName: "简易天象模型", purpose: "instrument", arrangement: { support: 65, cover: 20, boundary: 20, opening: 85 } },
      }, "弄清上次预测为何失败", "只靠记忆无法解释天体变化", "搭建能反复摆动的模型");
      if (localBuilding) return decision(agent, { type: "interact", with: { kind: "matter", id: localBuilding.id }, content: `拿取${localBuilding.name}改进模型`, intent: { mode: "take", matterId: localBuilding.id, quantity: 1 } }, "检验失败预测的原因", `这里有可用于模型的${localBuilding.name}`, "先取得材料");
      const to = nextLocation(state, agent, "river");
      return decision(agent, { type: "move", to }, "寻找搭建天象模型的材料", "模型需要刚性材料", `前往${locationName(state, to)}`);
    }
    if (recordMedium && instrument && resolvedHypotheses.length >= 2 && agent.limbs.abilities.reason >= 68 && !ownRecords.some((record) => record.kind === "model")) {
      const sources = [...new Set(resolvedHypotheses.flatMap((hypothesis) => [...hypothesis.sourceEventIds, ...(hypothesis.resolutionEventId ? [hypothesis.resolutionEventId] : [])]))].slice(-12);
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "用数与位置记录模型变化",
        intent: { mode: "record", mediumId: recordMedium.id, recordKind: "model", sourceEventIds: sources, note: "用位置、轮次和间隔描述模型与天象" },
      }, "把模型变化变成可比较的关系", "已有机械模型和多次预测结果", "用数与位置记录模型运动");
    }
    if (recordMedium && ownObservations.length >= 3 && agent.limbs.abilities.reason >= 58 && !ownRecords.some((record) => record.kind === "notation")) {
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "用固定符号区别天象",
        intent: { mode: "record", mediumId: recordMedium.id, recordKind: "notation", sourceEventIds: ownObservations.slice(-5).map((event) => event.id), note: "用不同刻号分别表示恒纪元、严寒、酷暑与烈焰" },
      }, "让不同经历拥有稳定标记", "计数刻痕还不能区分事情的种类", "约定可重复辨认的符号");
    }
    const sourcedKnowledge = agent.mind.cognition.knowledge.find((claim) => claim.sourceEventIds.length >= 2 && !claim.claim.includes("告诉我"));
    const listener = visibleAgents.find((other) => !other.mind.cognition.knowledge.some((claim) => claim.claim.includes(`${agent.name}告诉我：${sourcedKnowledge?.claim ?? ""}`)));
    if (sourcedKnowledge && listener && records.some((record) => record.authorId === agent.id) && (state.tick + agent.name.charCodeAt(0)) % 4 === 0) {
      return decision(agent, {
        type: "interact", with: { kind: "agent", id: listener.id }, content: "讲述记录中的往事",
        intent: { mode: "express", toAgentId: listener.id, speech: "这些刻痕记下了我们亲历的变化。", claim: sourcedKnowledge.claim, sourceEventIds: sourcedKnowledge.sourceEventIds },
      }, "让别人记住已经发生的事", `${listener.name}就在身边且我有带来源的记录`, "对照记录讲述往事");
    }
    if (calendar && !pendingHypothesis && (state.tick + agent.name.charCodeAt(0)) % 5 === 0) {
      return decision(agent, {
        type: "interact", with: { kind: "space", id: agent.locationId }, content: "按已有记录预测天象",
        intent: { mode: "predict", instrumentId: instrument?.id, predictedEpoch: state.civilization.epoch, predictedClimate: state.civilization.climate.kind, dueTick: state.tick + 3, sourceEventIds: calendar.sourceEventIds },
      }, "提前知道下一次危险", "已有历法可供推断，但未来仍不确定", "留下一个可被事实检验的预测");
    }
    if (recordMedium && ownObservations.length >= 5 && agent.limbs.abilities.reason >= 60 && !ownRecords.some((record) => record.kind === "calendar")) {
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "整理变化间隔为历法",
        intent: { mode: "record", mediumId: recordMedium.id, recordKind: "calendar", sourceEventIds: ownObservations.slice(-6).map((event) => event.id), note: "比较历次天象与气候的间隔" },
      }, "从反复变化中找出秩序", "已有多次可追溯观测", "把间隔刻成可复查的历法");
    }
    if (recordMedium && ownObservations.length >= 2 && !ownRecords.some((record) => record.kind === "tally")) {
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: recordMedium.id }, content: "刻下观测次数",
        intent: { mode: "record", mediumId: recordMedium.id, recordKind: "tally", sourceEventIds: ownObservations.map((event) => event.id), note: "用刻痕比较观测次数" },
      }, "不让经历随记忆消失", "已有几次彼此不同的观测", "用刻痕留下数量");
    }
    const rawForRecord = held.find((item) => item.kind === "wood" || item.kind === "stone");
    if (!recordMedium && rawForRecord && hasTrait(state, agent.id, "cutting") && agent.limbs.abilities.craft >= 55) {
      return decision(agent, {
        type: "interact", with: { kind: "matter", id: rawForRecord.id }, content: "制作可刻写薄片",
        intent: { mode: "shape", inputIds: [rawForRecord.id], desiredKind: "tablet", desiredName: "刻写薄片", desiredTraits: ["flat", "recordable"] },
      }, "留下不会消失的痕迹", "材料与切割工具都在手", "制作记录载体");
    }
    if (!recordMedium && agent.limbs.abilities.craft >= 55 && hasTrait(state, agent.id, "cutting")) {
      const localRaw = localMatter.find((item) => item.kind === "wood" || item.kind === "stone");
      if (localRaw) return decision(agent, { type: "interact", with: { kind: "matter", id: localRaw.id }, content: `拿起一份${localRaw.name}`, intent: { mode: "take", matterId: localRaw.id, quantity: 1 } }, "寻找能留下刻痕的材料", `这里有${localRaw.name}`, "取一份尝试加工");
    }
    if ((state.tick + agent.name.charCodeAt(0)) % 3 === 0 || ownObservations.length < 2) {
      return decision(agent, {
        type: "interact", with: { kind: "space", id: agent.locationId }, content: "观察此刻天象与气候",
        intent: { mode: "observe", aspect: ownObservations.length % 2 ? "climate" : "sky" },
      }, "辨认危险是否存在规律", "纪元与气候在反复变化", "把此刻作为一次独立观测");
    }

    const other = visibleAgents[0];
    if (other && (state.tick + agent.name.charCodeAt(0)) % 3 === 0) {
      return decision(agent, {
        type: "interact", with: { kind: "agent", id: other.id }, content: "谈论刚刚建成的东西",
        intent: { mode: "express", toAgentId: other.id, speech: "我们把反复的行动变成了新的生活条件。" },
      }, "理解这次共同改变", `我看见${other.name}也在这里`, "和对方交流");
    }
    const destinations: LocationId[] = ["square", "river", "field", "homes"];
    const target = destinations[(state.tick + agent.name.charCodeAt(0)) % destinations.length];
    const to = nextLocation(state, agent, target);
    return decision(agent, { type: "move", to }, "看看世界继续怎样变化", "现在没有紧迫的建设", `前往${locationName(state, to)}`);
  }
}

type MotivatedCandidate = {
  action: Action;
  drives: DriveKind[];
  affordance: number;
  perception: string;
  choice: string;
};

function drivesForAction(action: Action): DriveKind[] {
  if (action.type === "move") return ["curiosity", "safety"];
  const intent = action.intent;
  if (!intent) return ["affiliation"];
  if (intent.mode === "eat" || intent.mode === "cook" || intent.mode === "hunt" || intent.mode === "store" || intent.mode === "work" && intent.change === "cultivate") return ["hunger", "mastery"];
  if (intent.mode === "drink" || intent.mode === "work" && intent.change === "irrigate") return ["thirst", "safety"];
  if (intent.mode === "rest") return ["rest", "safety"];
  if (intent.mode === "warm") return ["thermal", "safety"];
  if (intent.mode === "adapt") return ["safety"];
  if (intent.mode === "inspect-body") return ["care", "curiosity", "safety"];
  if (intent.mode === "apply-material") return ["care", "safety", "mastery"];
  if (intent.mode === "treat") return ["care", "safety"];
  if (intent.mode === "fit-support") return ["care", "safety", "mastery"];
  if (intent.mode === "bury") return ["care", "affiliation", "expression"];
  if (intent.mode === "give" || intent.mode === "bond") return intent.mode === "bond" && (intent.gesture === "court" || intent.gesture === "intimate") ? ["reproduction", "affiliation"] : ["care", "affiliation"];
  if (intent.mode === "perform") return ["play", "expression", "affiliation"];
  if (intent.mode === "express") return ["expression", "affiliation"];
  if (intent.mode === "observe" || intent.mode === "predict") return ["curiosity"];
  if (intent.mode === "record") return intent.recordKind === "account" || intent.recordKind === "contract" ? ["status", "expression"] : ["curiosity", "expression"];
  if (intent.mode === "claim") return ["status", "safety"];
  if (intent.mode === "trade") return ["status", "affiliation", "mastery"];
  if (intent.mode === "tend") return ["care", "mastery"];
  if (intent.mode === "relocate") return ["safety", "curiosity"];
  if (intent.mode === "ignite") return ["thermal", "mastery", "safety"];
  if (intent.mode === "shape" || intent.mode === "assemble") return ["mastery", "status", "safety"];
  return ["mastery"];
}

function candidateScore(state: SimulationState, agent: AgentState, candidate: MotivatedCandidate) {
  const drives = new Map(agent.mind.needs.drives.map((drive) => [drive.kind, drive.intensity]));
  const primaryKind = candidate.drives[0];
  const primary = drives.get(primaryKind) ?? 0;
  const secondary = candidate.drives.slice(1).reduce((sum, kind) => sum + (drives.get(kind) ?? 0) * 0.14, 0);
  const homeostatic = new Set<DriveKind>(["hunger", "thirst", "thermal", "rest", "safety"]);
  const urgency = homeostatic.has(primaryKind) && primary > 58 ? Math.pow(primary - 58, 1.38) * 1.7 : 0;
  const motive = primary + secondary + urgency;
  const levelOrder: MaslowNeedLevel[] = ["physiological", "safety", "belonging", "esteem", "selfActualization"];
  const dominantLayer = agent.mind.needs.layers.find((layer) => layer.level === agent.mind.needs.dominantLevel);
  const candidateLevel = agent.mind.needs.drives.find((drive) => drive.kind === primaryKind)?.level ?? "selfActualization";
  const levelGap = levelOrder.indexOf(candidateLevel) - levelOrder.indexOf(agent.mind.needs.dominantLevel);
  const immediateCare = primaryKind === "care" && (candidate.perception.includes("身体正持续衰退") || candidate.perception.includes("身体已不可逆地衰退"));
  const hierarchyPenalty = dominantLayer && dominantLayer.intensity >= 58 && levelGap > 0 ? (levelGap * 34 + (dominantLayer.intensity - 58) * 0.9) * (immediateCare ? 0.2 : 1) : 0;
  const key = actionKey(candidate.action);
  const history = agent.mind.cognition.memory.episodic.filter((fragment) => fragment.actionKey === key);
  const recent = history.filter((fragment) => fragment.tick >= state.tick - 2);
  const learnedExpectation = history.length ? history.filter((fragment) => fragment.succeeded).length / history.length * 12 : 0;
  const intent = candidate.action.type === "interact" ? candidate.action.intent : undefined;
  const distinguishesDestination = candidate.action.type === "move" && (candidate.perception.includes("记忆") || candidate.perception.includes("经历") || candidate.perception.includes("材料") || candidate.perception.includes("水源") || candidate.perception.includes("食物") || candidate.perception.includes("人群") || candidate.perception.includes("共同"));
  const usingSupport = Boolean(agent.body.injury?.supportId && carried(state, agent.id).some((matter) => matter.id === agent.body.injury?.supportId && matter.traits.includes("supportive")));
  const repetitionPenalty = distinguishesDestination && !usingSupport ? 0 : recent.length * 24;
  const mobilityBurden = candidate.action.type === "move" && usingSupport && (agent.body.injury?.lastingMobilityLoss ?? 0) > 0
    ? (agent.body.injury?.mobilityLoss ?? 0) * ((agent.body.injury?.supportedMoveEventIds?.length ?? 0) > 0 ? 40 : 12)
    : 0;
  const aptitude = intent?.mode === "shape" || intent?.mode === "cook" || intent?.mode === "ignite" || intent?.mode === "hunt"
    ? agent.limbs.abilities.craft * 0.12
    : intent?.mode === "assemble" || intent?.mode === "work"
      ? agent.limbs.abilities.build * 0.12
      : intent?.mode === "observe" || intent?.mode === "record" || intent?.mode === "predict"
      ? (agent.limbs.abilities.observe + agent.limbs.abilities.reason) * 0.07
        : intent?.mode === "inspect-body" || intent?.mode === "apply-material" || intent?.mode === "treat" || intent?.mode === "fit-support" || intent?.mode === "bond" && intent.gesture === "comfort"
          ? (agent.limbs.abilities.observe + agent.limbs.abilities.interact) * 0.05 + (agent.standing.careTrust ?? 0) * 0.25
        : 5;
  const novelty = ((state.seed * 17 + state.tick * 31 + agent.id.charCodeAt(0) * 13 + key.length * 7) % 17) - 8;
  return motive + candidate.affordance + aptitude + learnedExpectation + novelty - repetitionPenalty - hierarchyPenalty - mobilityBurden;
}

class MockDecider implements AgentDecider {
  decide(context: DecisionContext): Decision {
    const { state, agent, visibleAgents, localMatter } = context;
    agent.mind.needs.drives = driveState(state, agent);
    const candidates: MotivatedCandidate[] = [];
    const add = (action: Action, affordance: number, perception: string, choice: string, drives = drivesForAction(action)) => candidates.push({ action, drives, affordance, perception, choice });
    const held = carried(state, agent.id);
    const localFire = localMatter.find((matter) => matter.traits.includes("burning"));
    const food = held.find((matter) => matter.traits.includes("edible"));
    const rawFood = held.find((matter) => matter.traits.includes("edible") && !matter.traits.includes("cooked"));
    const localFood = localMatter.find((matter) => matter.traits.includes("edible") && !matter.traits.includes("stored"));
    const thirsty = agent.mind.needs.drives.find((drive) => drive.kind === "thirst")?.intensity ?? 0;
    const tired = agent.mind.needs.drives.find((drive) => drive.kind === "rest")?.intensity ?? 0;
    const experiencedFactIds = new Set(agent.mind.cognition.interpretations.flatMap((reading) => reading.factIds));
    const experiencedCareFacts = state.world.time.past.filter((event): event is ActionFact => event.kind === "action" && experiencedFactIds.has(event.id) && event.succeeded && (event.diff.examinedAbnormality === true || event.diff.treatedIllness === true || event.diff.botanicalMaterial === true || event.diff.supportedDistress === true || event.diff.stoppedBleeding === true));
    const experiencedCareFactCount = experiencedCareFacts.length;

    const dehydratedOther = visibleAgents.find((other) => other.body.state === "dehydrated");
    if (state.civilization.epoch === "stable" && dehydratedOther && (food || localFood)) add({ type: "interact", with: { kind: "agent", id: dehydratedOther.id }, content: `浸泡并喂养${dehydratedOther.name}`, intent: { mode: "adapt", change: "soak", targetAgentId: dehydratedOther.id } }, 34, "环境恢复稳定，且手边有唤醒后所需食物", "用水浸泡并喂养同伴", ["care", "safety", "hunger"]);
    if (state.civilization.epoch === "chaotic" && state.civilization.climate.severity >= 5 && agent.body.exposure >= 10) add({ type: "interact", with: { kind: "agent", id: agent.id }, content: "脱水保存身体", intent: { mode: "adapt", change: "dehydrate" } }, 38 + agent.body.exposure, `极端气候仍在持续，身体暴露已达 ${Math.round(agent.body.exposure)}`, "暂时脱水停止消耗", ["safety", "thermal", "thirst"]);
    const trustedWarning = agent.mind.cognition.hypotheses.find((hypothesis) => hypothesis.status === "pending" && hypothesis.predictedEpoch === "chaotic" && hypothesis.dueTick <= state.tick + 3);
    if (state.civilization.epoch === "stable" && trustedWarning && agent.standing.respect >= TRUSTED_PREDICTOR_RESPECT) add({ type: "interact", with: { kind: "agent", id: agent.id }, content: "依照自己的预言提前脱水", intent: { mode: "adapt", change: "dehydrate" } }, 46, `我以 ${Math.round(agent.standing.respect)} 点尊重为这次乱纪元预言担保`, "在灾害抵达前脱水", ["safety", "status"]);

    if (agent.locationId === "river") add({ type: "interact", with: { kind: "matter", id: "water-river" }, content: "俯身饮用河水", intent: { mode: "drink", sourceId: "water-river" } }, thirsty > 55 ? 22 : -8, "河水就在眼前，身体可以直接补水", "饮水恢复身体");
    else add({ type: "move", to: nextLocation(state, agent, "river") }, thirsty > 55 ? 18 : -2, "身体缺水，而河岸有持续水源", "向河岸移动", ["thirst"]);
    add({ type: "interact", with: { kind: "space", id: agent.locationId }, content: "停下劳动恢复体力", intent: { mode: "rest", siteId: agent.locationId } }, tired > 60 ? 20 : -14, "疲劳会降低继续行动的能力", "在眼前地点休息", ["rest", "safety"]);
    if (localFire && agent.body.temperature < 46) add({ type: "interact", with: { kind: "matter", id: localFire.id }, content: "靠近火种取暖", intent: { mode: "warm", fireId: localFire.id } }, 24, "体温偏低且火种在旁", "靠火取暖");
    if (food) add({ type: "interact", with: { kind: "matter", id: food.id }, content: `食用${food.name}`, intent: { mode: "eat", foodId: food.id } }, food.traits.includes("cooked") ? 20 : 14, "手里有可食用物", "进食恢复营养");
    if (rawFood && localFire) add({ type: "interact", with: { kind: "matter", id: rawFood.id }, content: `用火处理${rawFood.name}`, intent: { mode: "cook", foodId: rawFood.id, fireId: localFire.id } }, 17, "生食和火种同时在场", "把生食烹熟");
    if (localFood) add({ type: "interact", with: { kind: "matter", id: localFood.id }, content: `采集${localFood.name}`, intent: { mode: "take", matterId: localFood.id, quantity: 1 } }, 16, "眼前有可采集食物", "取得一份食物", ["hunger", "safety"]);
    const foodAvailableHere = Boolean(food || localFood);
    const knownFoodSite = [...new Set(state.world.matter.filter((matter) => matter.holder.kind === "space" && matter.quantity > 0 && matter.traits.includes("edible") && !matter.traits.includes("stored")).map((matter) => matter.holder.id))].sort()[0];
    if (!foodAvailableHere && knownFoodSite && agent.locationId !== knownFoodSite) add({ type: "move", to: nextLocation(state, agent, knownFoodSite) }, 18, `这里没有可见食物，聚落的食物仍在${locationName(state, knownFoodSite)}`, `前往${locationName(state, knownFoodSite)}寻找食物`, ["hunger", "safety"]);
    else if (!foodAvailableHere) for (const neighbor of location(state, agent.locationId)?.neighbors ?? []) add({ type: "move", to: neighbor }, 9, "这里没有可见食物，只能到相邻地点继续寻找", `前往${locationName(state, neighbor)}寻找食物`, ["hunger", "safety"]);
    const irrigated = Boolean(location(state, "field")?.terrain.irrigated);
    if (agent.locationId === "field" && location(state, "field")!.terrain.depth < 2) add({ type: "interact", with: { kind: "space", id: "field" }, content: "为缺粮田地挖浅沟", intent: { mode: "work", siteId: "field", change: "dig" } }, 26, "田地需要更深的沟渠才能引入水源", "为田地开沟", ["hunger", "thirst", "mastery"]);
    if (agent.locationId === "field" && !irrigated && location(state, "field")!.terrain.depth >= 2) add({ type: "interact", with: { kind: "space", id: "field" }, content: "把沟渠接向水源", intent: { mode: "work", siteId: "field", change: "irrigate" } }, 29, "眼前沟渠已足够深，引水能让田地持续产粮", "引水进入田地", ["hunger", "thirst", "mastery"]);
    if (agent.locationId === "field" && irrigated) add({ type: "interact", with: { kind: "space", id: "field" }, content: "翻土照料谷物", intent: { mode: "work", siteId: "field", change: "cultivate" } }, foodAvailableHere ? 10 : 30, "眼前引水田地可以通过劳动把养分转化为食物", "耕作并取得谷物", ["hunger", "mastery"]);

    const localAnimal = localMatter.find((matter) => matter.traits.includes("animal") && matter.quantity > 0);
    const cuttingTool = held.find((matter) => matter.traits.includes("cutting"));
    if (localAnimal && cuttingTool) add({ type: "interact", with: { kind: "matter", id: localAnimal.id }, content: `跟踪并尝试捕获${localAnimal.name}`, intent: { mode: "hunt", animalId: localAnimal.id } }, 9, "动物、工具和行动能力同时在场", "尝试取得食物与皮骨", ["hunger", "mastery"]);
    if (localAnimal && food && !localAnimal.traits.includes("domesticated")) add({ type: "interact", with: { kind: "matter", id: localAnimal.id }, content: `用${food.name}接近${localAnimal.name}`, intent: { mode: "tend", animalId: localAnimal.id, offeringId: food.id } }, 7, "手中食物可能改变动物对人的反应", "尝试持续照料动物", ["care", "mastery"]);

    const localFuel = localMatter.find((matter) => matter.traits.includes("fuel") && matter.quantity > 0);
    if (localFuel && cuttingTool && !localFire) add({ type: "interact", with: { kind: "matter", id: localFuel.id }, content: `用石器敲击${localFuel.name}尝试保留热源`, intent: { mode: "ignite", fuelId: localFuel.id } }, agent.body.temperature < 48 ? 22 : 8, "干燥燃料与锋利石器同时在场", "尝试留下火种");

    const rawHide = held.find((matter) => matter.kind === "hide" && matter.traits.includes("fiber"));
    const rawFiber = held.find((matter) => matter.traits.includes("fiber") && matter.kind !== "hide");
    const rawWood = held.find((matter) => matter.kind === "wood" && matter.traits.includes("raw"));
    const usingSupportWithOthers = Boolean(agent.body.injury?.lastingMobilityLoss && agent.body.injury.supportId && held.some((matter) => matter.id === agent.body.injury?.supportId && matter.traits.includes("supportive")) && visibleAgents.length > 0);
    if (rawHide && cuttingTool) add({ type: "interact", with: { kind: "matter", id: rawHide.id }, content: "裁剪并连接兽皮", intent: { mode: "shape", inputIds: [rawHide.id], desiredKind: "clothing", desiredName: "兽皮衣", desiredTraits: ["wearable"] } }, agent.body.temperature < 48 ? 18 : 5, "兽皮柔韧，工具能够裁开它", "制作可穿戴的遮蔽物", ["thermal", "safety", "mastery"]);
    if (rawFiber && cuttingTool) add({ type: "interact", with: { kind: "matter", id: rawFiber.id }, content: "编结纤维形成容器", intent: { mode: "shape", inputIds: [rawFiber.id], desiredKind: "basket", desiredName: "编织储物篮", desiredTraits: ["container"] } }, 7, "纤维可以交错成有边界的空间", "尝试编出容器", ["safety", "mastery"]);
    if (rawWood && cuttingTool) {
      add({ type: "interact", with: { kind: "matter", id: rawWood.id }, content: "把原木削成平整构件", intent: { mode: "shape", inputIds: [rawWood.id], desiredKind: "plank", desiredName: "木板", desiredTraits: ["flat", "building"] } }, 7, "木材和切割工具都在手边", "加工出便于连接的平整构件");
      if (!held.some((matter) => matter.traits.includes("recordable"))) add({ type: "interact", with: { kind: "matter", id: rawWood.id }, content: "削出能够刻写的薄片", intent: { mode: "shape", inputIds: [rawWood.id], desiredKind: "tablet", desiredName: "刻写薄片", desiredTraits: ["flat", "recordable"] } }, 4, "木料表面能够留下持久刻痕", "制作记录载体", ["expression", "mastery"]);
    }
    const mobilityLimited = visibleAgents.find((other) => other.body.state === "active" && (other.body.injury?.mobilityLoss ?? 0) >= 12 && other.body.injury?.bleeding === 0 && !other.body.injury?.supportId);
    const ownMobilityLimited = (agent.body.injury?.mobilityLoss ?? 0) >= 12 && agent.body.injury?.bleeding === 0 && !agent.body.injury?.supportId ? agent : undefined;
    const supportRecipient = mobilityLimited ?? ownMobilityLimited;
    const heldSupport = held.find((matter) => matter.traits.includes("supportive"));
    const straightRigid = held.find((matter) => (matter.kind === "wood" || matter.kind === "bone") && matter.traits.includes("rigid"));
    if (supportRecipient && heldSupport) add({ type: "interact", with: { kind: "agent", id: supportRecipient.id }, content: `把${heldSupport.name}适配给${supportRecipient.name}`, intent: { mode: "fit-support", matterId: heldSupport.id, targetAgentId: supportRecipient.id } }, 42, `${supportRecipient.name}伤后移动能力明显下降，支撑物可以分担负重`, "试着用支撑物恢复活动", ["care", "safety", "mastery"]);
    if (supportRecipient && straightRigid && cuttingTool && !heldSupport) add({ type: "interact", with: { kind: "matter", id: straightRigid.id }, content: "削整刚性材料形成身体支撑", intent: { mode: "shape", inputIds: [straightRigid.id], desiredKind: "body-support", desiredName: "身体支撑杆", desiredTraits: ["supportive"] } }, 38, `${supportRecipient.name}伤后站立和移动受限，眼前刚性材料可加工成贴合身体的支撑`, "制作可反复使用的支撑物", ["care", "safety", "mastery"]);
    const localSupportMaterial = localMatter.find((matter) => (matter.kind === "wood" || matter.kind === "bone") && matter.traits.includes("rigid"));
    if (supportRecipient && localSupportMaterial && !straightRigid && !heldSupport) add({ type: "interact", with: { kind: "matter", id: localSupportMaterial.id }, content: `取得一份${localSupportMaterial.name}`, intent: { mode: "take", matterId: localSupportMaterial.id, quantity: 1 } }, 34, `${supportRecipient.name}伤后移动受限，眼前刚性材料能分担身体重量`, "取得材料尝试制作支撑", ["care", "safety", "mastery"]);
    if (supportRecipient && !straightRigid && !heldSupport && agent.locationId !== "river") add({ type: "move", to: nextLocation(state, agent, "river") }, 26, `${supportRecipient.name}伤后移动受限，而河岸常有能承担身体重量的木骨`, "寻找可加工的支撑材料", ["care", "safety", "mastery"]);

    const settlementShelter = completedSettlementShelter(state);
    const shelterProject = activeShelterProject(state);
    const shelterSiteId = preferredShelterSiteId(state);
    const unfinishedShelter = shelterProject?.holder.kind === "space" && shelterProject.holder.id === agent.locationId ? shelterProject : undefined;
    const buildingItem = held.find((matter) => matter.traits.includes("building") && matter.kind !== "tool");
    const localBuildingMaterial = localMatter.find((matter) => matter.quantity > 0 && (matter.traits.includes("building") || matter.traits.includes("rigid")) && matter.kind !== "tool" && !matter.traits.includes("burning"));
    if (!settlementShelter && buildingItem) {
      if (agent.locationId === shelterSiteId) {
        add({ type: "interact", with: { kind: "space", id: shelterSiteId }, content: `把${buildingItem.name}接入正在形成的遮蔽结构`, intent: { mode: "assemble", inputIds: [buildingItem.id], siteId: shelterSiteId, desiredKind: "house", desiredName: unfinishedShelter?.name ?? "共同搭建的遮蔽结构", purpose: "shelter", arrangement: { support: 72, cover: 78, boundary: 68, opening: 32 } } }, shelterProject ? 56 : 50, shelterProject ? "聚落已有遮蔽工地，材料应该集中接入同一结构" : "共同生活地点的地面已经清理，可先形成第一处遮蔽", shelterProject ? "继续连接遮蔽结构" : "开始连接遮蔽结构", ["safety", "mastery"]);
      } else {
        add({ type: "move", to: nextLocation(state, agent, shelterSiteId) }, shelterProject ? 50 : 46, shelterProject ? `${locationName(state, shelterSiteId)}已有在建住所，分散开工只会浪费材料` : `${locationName(state, shelterSiteId)}是已清理的共同生活地点`, `把材料带往${locationName(state, shelterSiteId)}`, ["safety", "mastery"]);
      }
    } else if (!settlementShelter && localBuildingMaterial) {
      add({ type: "interact", with: { kind: "matter", id: localBuildingMaterial.id }, content: `取得一份${localBuildingMaterial.name}`, intent: { mode: "take", matterId: localBuildingMaterial.id, quantity: 1 } }, 44, `聚落尚无住所，眼前的${localBuildingMaterial.name}能够承重或连接`, "取得材料用于共同住所", ["safety", "mastery"]);
    } else if (!settlementShelter && agent.locationId !== "river") {
      add({ type: "move", to: nextLocation(state, agent, "river") }, 36, "聚落尚无住所，而河岸有可用于建设的木石", "前往河岸取得建材", ["safety", "mastery"]);
    }

    const heldUseful = held.filter((matter) => matter.kind !== "metabolized" && matter.kind !== "applied-fiber");
    const canCarryLightRecord = carryingMass(state, agent.id) + 0.25 <= 30;
    const alreadyCarriesRecordable = held.some((matter) => matter.traits.includes("recordable"));
    const rememberedCarePlaces = state.world.space.locations.map((place) => {
      const facts = experiencedCareFacts.filter((fact) => fact.where === place.id);
      return { place, facts, actors: new Set(facts.map((fact) => fact.who)), subjects: new Set(facts.map((fact) => String(fact.diff.targetAgentId ?? fact.diff.partnerId ?? "")).filter(Boolean)) };
    }).filter(({ facts, actors, subjects }) => facts.length >= 4 && actors.size >= 2 && subjects.size >= 2).sort((first, second) => second.facts.length - first.facts.length);
    const rememberedCarePlace = rememberedCarePlaces[0];
    const carriedBuildingForCommonUse = held.find((matter) => (matter.traits.includes("building") || matter.traits.includes("rigid")) && matter.kind !== "tool");
    if (settlementShelter && rememberedCarePlace && carriedBuildingForCommonUse && agent.locationId !== rememberedCarePlace.place.id) add({ type: "move", to: nextLocation(state, agent, rememberedCarePlace.place.id) }, 30 + Math.min(12, rememberedCarePlace.facts.length), `我亲历的多次检查和互助集中在${rememberedCarePlace.place.name}，手里的材料可以改善那里共同活动时的遮蔽`, `把材料带回${rememberedCarePlace.place.name}`, ["care", "safety", "mastery"]);
    const localUseful = localMatter.filter((matter) => matter.quantity > 0 && (matter.traits.includes("building") || matter.traits.includes("fiber") || matter.traits.includes("recordable") || matter.kind === "wood" || matter.kind === "stone") && !matter.traits.includes("burning"));
    for (const material of localUseful) {
      if (heldUseful.length >= 5 && !material.traits.includes("recordable")) continue;
      if (material.traits.includes("recordable") && !canCarryLightRecord) continue;
      const preservingExperience = material.traits.includes("recordable") && experiencedCareFactCount >= 4 && !alreadyCarriesRecordable;
      const supportingRememberedPlace = material.traits.includes("building") && Boolean(rememberedCarePlace);
      add({ type: "interact", with: { kind: "matter", id: material.id }, content: `取得一份${material.name}`, intent: { mode: "take", matterId: material.id, quantity: 1 } }, preservingExperience ? 86 : supportingRememberedPlace ? 28 : material.traits.includes("building") ? 14 : 11, `${material.name}就在眼前并且可以被携带${preservingExperience ? "，我有多次值得留下的亲历" : supportingRememberedPlace ? `，我记得${rememberedCarePlace!.place.name}长期有人共同活动` : ""}`, "取一份材料试用", preservingExperience ? ["safety", "care", "expression"] : supportingRememberedPlace ? ["care", "safety", "mastery"] : ["mastery", "safety"]);
    }
    if (!localUseful.length && agent.locationId !== "river" && heldUseful.length < 3) add({ type: "move", to: nextLocation(state, agent, "river") }, 5, "眼前没有可加工的刚性或纤维材料，只记得河岸常能找到天然材料", "去河岸寻找材料", ["mastery", "curiosity"]);

    const rememberedCareHere = rememberedCarePlaces.find(({ place }) => place.id === agent.locationId);
    if (settlementShelter && rememberedCareHere) {
      const heldBuilding = held.find((matter) => (matter.traits.includes("building") || matter.traits.includes("rigid")) && matter.kind !== "tool");
      const unfinishedCommonShelter = localMatter.find((matter) => matter.construction?.purpose === "shelter" && !matter.construction.complete);
      const completeCommonShelter = localMatter.some((matter) => matter.construction?.complete && (matter.construction.effects?.weatherProtection ?? 0) >= 58);
      if (heldBuilding) add({ type: "interact", with: { kind: "space", id: agent.locationId }, content: `把${heldBuilding.name}接入常有人停留的遮蔽处`, intent: { mode: "assemble", inputIds: [heldBuilding.id], siteId: agent.locationId, desiredKind: "house", desiredName: unfinishedCommonShelter?.name ?? "共同搭建的遮蔽结构", purpose: "shelter", arrangement: { support: 72, cover: 78, boundary: 68, opening: 32 } } }, 30 + Math.min(12, rememberedCareHere.facts.length), "我亲历过多人在这里检查、休息和互助，遮蔽能让共同活动少受天气打断", "改善这里的共同遮蔽", ["safety", "care", "mastery"]);
      else if (!completeCommonShelter && agent.locationId !== "river") add({ type: "move", to: nextLocation(state, agent, "river") }, unfinishedCommonShelter ? 28 : 23, `${unfinishedCommonShelter ? "这里已有未完成的遮蔽" : "这里反复有人停留"}，而我记得河岸有可连接的天然材料`, "寻找能改善共同遮蔽的材料", ["safety", "care", "mastery"]);
    }

    const container = [...held, ...localMatter].find((matter) => matter.traits.includes("container"));
    if (container && food && !food.traits.includes("stored")) add({ type: "interact", with: { kind: "matter", id: food.id }, content: `把${food.name}收入${container.name}`, intent: { mode: "store", matterId: food.id, containerId: container.id } }, 7, "食物有余且已有容器", "储存一份食物", ["safety", "hunger"]);

    const dependent = visibleAgents.find((other) => dependentChildRequiresAttention(other) && (other.lineage.motherId === agent.id || other.lineage.fatherId === agent.id || (agent.relations.find((relation) => relation.agentId === other.id)?.strength ?? 0) >= 55));
    if (dependent) add({ type: "interact", with: { kind: "agent", id: dependent.id }, content: `照料年幼的${dependent.name}`, intent: { mode: "bond", toAgentId: dependent.id, gesture: "care" } }, 24, `${dependent.name}当前的营养、水分、健康或疲劳需要实际帮助`, "停下劳动照料幼儿", ["safety", "care", "affiliation"]);
    const pregnant = visibleAgents.find((other) => other.body.state === "active" && other.body.pregnancy);
    if (pregnant) add({ type: "interact", with: { kind: "agent", id: pregnant.id }, content: `替身体不便的${pregnant.name}分担照料`, intent: { mode: "bond", toAgentId: pregnant.id, gesture: "care" } }, 22, `${pregnant.name}身体正在孕育后代且不能照常劳动`, "帮助对方恢复体力与安全感", ["care", "affiliation", "safety"]);
    const withdrawing = visibleAgents.find((other) => other.body.state === "active" && other.body.adaptation?.withdrawalSinceTick !== undefined && other.body.adaptation.lastSupportedTick !== state.tick + 1);
    if (withdrawing) add({ type: "interact", with: { kind: "agent", id: withdrawing.id }, content: `陪伴身体不适的${withdrawing.name}`, intent: { mode: "bond", toAgentId: withdrawing.id, gesture: "care" } }, 44, `${withdrawing.name}停用一种反复作用于身体的材料后出现烦躁、疲惫和身体不适，陪伴与休息不需要再使用该材料`, "留在身边帮助对方熬过不适", ["care", "affiliation", "safety"]);
    const dying = visibleAgents.find((other) => other.body.state === "active" && other.body.endOfLife && other.body.endOfLife.lastSupportedTick !== state.tick + 1);
    if (dying) add({ type: "interact", with: { kind: "agent", id: dying.id }, content: `留在衰弱的${dying.name}身边照料`, intent: { mode: "bond", toAgentId: dying.id, gesture: "care" } }, 88, `${dying.name}的身体正持续衰退、已经不能劳动，但仍能感到饥渴、疲惫与陪伴`, "停下劳动照料并陪伴对方", ["care", "affiliation", "safety"]);
    if (dying && food) add({ type: "interact", with: { kind: "agent", id: dying.id }, content: `把${food.name}分给衰弱的${dying.name}`, intent: { mode: "give", matterId: food.id, toAgentId: dying.id, quantity: 1 } }, 92, `${dying.name}无法再劳动而身体仍需要营养，手中的食物可以直接分给对方`, "把食物送到对方身边", ["care", "hunger", "affiliation"]);
    const rememberedDying = agent.relations
      .filter((relation) => relation.strength >= 28)
      .flatMap((relation) => state.agents.filter((other) => other.id === relation.agentId && other.body.state === "active" && other.body.endOfLife))
      .sort((first, second) => (agent.relations.find((relation) => relation.agentId === second.id)?.strength ?? 0) - (agent.relations.find((relation) => relation.agentId === first.id)?.strength ?? 0))[0];
    if (rememberedDying && rememberedDying.locationId !== agent.locationId) add({ type: "move", to: nextLocation(state, agent, rememberedDying.locationId) }, 82, `我与${rememberedDying.name}有共同经历，记得对方的身体已不可逆地衰退；只有走到身边才能照料`, `前往${locationName(state, rememberedDying.locationId)}陪伴${rememberedDying.name}`, ["care", "affiliation", "safety"]);
    const abnormal = visibleAgents.find((other) => other.body.state === "active" && ((other.body.illness && other.body.illness.examinedAtTick !== state.tick + 1) || (other.body.injury && other.body.injury.examinedAtTick !== state.tick + 1)));
    if (abnormal) add({ type: "interact", with: { kind: "agent", id: abnormal.id }, content: `查看${abnormal.name}的疼痛与身体状态`, intent: { mode: "inspect-body", targetAgentId: abnormal.id } }, 18, `${abnormal.name}的身体状态明显偏离平常`, "靠近比较身体状态", ["care", "curiosity", "safety"]);
    const bleeding = visibleAgents.find((other) => other.body.state === "active" && other.body.injury?.bleeding);
    const fiber = [...held, ...localMatter].find((matter) => matter.traits.includes("fiber"));
    if (bleeding && fiber) add({ type: "interact", with: { kind: "agent", id: bleeding.id }, content: `把${fiber.name}按在${bleeding.name}疼痛处`, intent: { mode: "apply-material", matterId: fiber.id, targetAgentId: bleeding.id } }, 20, `${bleeding.name}疼痛处有液体流失，眼前柔软纤维可以贴在身体表面`, "尝试用手边材料帮助对方", ["care", "safety", "mastery"]);
    const sick = visibleAgents.find((other) => other.body.state === "active" && other.body.illness) ?? (agent.body.illness ? agent : undefined);
    const waterAvailable = agent.locationId === "river" || localMatter.some((matter) => matter.kind === "water-source");
    const shelteredHere = localMatter.some((matter) => matter.traits.includes("shelter") && matter.construction?.complete);
    if (sick && (food || localFood || waterAvailable || shelteredHere)) add({ type: "interact", with: { kind: "agent", id: sick.id }, content: `利用眼前条件照护患病的${sick.name}`, intent: { mode: "treat", toAgentId: sick.id } }, 34 + (sick.body.illness?.severity ?? 0) * 3, `${sick.name}正在患病，而食物、水源或住所中至少有一种就在眼前`, "尝试改善病人的身体状态", ["care", "safety"]);
    const distressed = visibleAgents.find((other) => other.body.state === "active" && other.mind.affect.state !== "regulated");
    if (distressed) {
      add({ type: "interact", with: { kind: "agent", id: distressed.id }, content: `陪伴言行失常的${distressed.name}`, intent: { mode: "bond", toAgentId: distressed.id, gesture: "comfort" } }, 28 + distressed.mind.affect.strain * 0.35, `${distressed.name}的言行与平常明显不同，且仍能听见身边的人`, "留在身边安慰并观察变化", ["care", "affiliation", "safety"]);
      const calmingKnowledge = agent.mind.cognition.knowledge
        .filter((claim) => claim.kind === "material-body-effect" && claim.observedEffect === "beneficial" && claim.subjectKind)
        .sort((first, second) => second.confidence - first.confidence)[0];
      const knownCalmingMaterial = calmingKnowledge
        ? [...held, ...localMatter].find((matter) => matter.kind === calmingKnowledge.subjectKind && matter.traits.includes("botanical"))
        : undefined;
      if (knownCalmingMaterial) add({ type: "interact", with: { kind: "matter", id: knownCalmingMaterial.id }, content: `把曾有改善的${knownCalmingMaterial.name}用于${distressed.name}`, intent: { mode: "apply-material", matterId: knownCalmingMaterial.id, targetAgentId: distressed.id } }, 24 + calmingKnowledge!.confidence * 0.18, `我亲历过${knownCalmingMaterial.name}作用后身体或精神负荷下降`, "按已有经验再次尝试", ["care", "safety", "mastery"]);
    }
    if (sick) {
      const knownMaterialEffects = agent.mind.cognition.knowledge
        .filter((claim) => claim.kind === "material-body-effect" && claim.observedEffect === "beneficial" && claim.subjectKind)
        .sort((first, second) => second.confidence - first.confidence);
      const knownBotanical = knownMaterialEffects.flatMap((claim) => [...held, ...localMatter].filter((matter) => matter.kind === claim.subjectKind && matter.traits.includes("botanical"))).find(Boolean);
      const knownIneffectiveKinds = new Set(agent.mind.cognition.knowledge.filter((claim) => claim.kind === "material-body-effect" && (claim.observedEffect === "neutral" || claim.observedEffect === "harmful") && claim.subjectKind).map((claim) => claim.subjectKind));
      const unexploredBotanical = [...held, ...localMatter].find((matter) => matter.traits.includes("botanical") && !knownIneffectiveKinds.has(matter.kind) && !agent.mind.cognition.knowledge.some((claim) => claim.kind === "material-body-effect" && claim.subjectKind === matter.kind));
      const material = knownBotanical || unexploredBotanical;
      if (material) add({ type: "interact", with: { kind: "matter", id: material.id }, content: `把${material.name}用于${sick.name}`, intent: { mode: "apply-material", matterId: material.id, targetAgentId: sick.id } }, knownBotanical ? 26 : 16, knownBotanical ? `我见过这种材料作用后病情减轻，而${sick.name}现在有相似异常` : `${material.name}是眼前可作用于身体、但后果尚不确定的材料`, knownBotanical ? "依据亲历效果再次使用" : "谨慎尝试并观察前后变化", ["care", "curiosity", "safety"]);
      if (!material && knownIneffectiveKinds.size > 0 && agent.locationId !== "field") add({ type: "move", to: nextLocation(state, agent, "field") }, 22, "我见过身边材料没有改善甚至使身体变差，邻近地点还有性质不同、结果未知的植物", "寻找不同材料再观察结果", ["care", "safety", "curiosity"]);
    }
    const remains = localMatter.find((matter) => matter.traits.includes("remains") && matter.personId);
    if (remains) {
      const deceased = state.agents.find((other) => other.id === remains.personId);
      const relation = deceased ? agent.relations.find((item) => item.agentId === deceased.id) : undefined;
      add({ type: "interact", with: { kind: "matter", id: remains.id }, content: `安置${remains.name}并留下纪念标记`, intent: { mode: "bury", remainsId: remains.id, siteId: agent.locationId } }, 30 + Math.max(0, relation?.strength ?? 0) * 0.15, `${remains.name}仍留在生活空间中${deceased ? `，${deceased.name}与我有共同经历` : ""}`, "妥善安葬并留下可辨认的纪念", ["care", "affiliation", "expression"]);
    }
    const weak = visibleAgents.find((other) => !isDependentChild(other) && (other.body.health < 65 || other.body.hydration < 45 || other.body.nutrition < 50 || other.body.fatigue > 75));
    if (weak) add({ type: "interact", with: { kind: "agent", id: weak.id }, content: `照料${weak.name}`, intent: { mode: "bond", toAgentId: weak.id, gesture: "care" } }, 16, `${weak.name}的身体状态明显较弱`, "停下来照料对方");
    if (weak && food) add({ type: "interact", with: { kind: "agent", id: weak.id }, content: `把${food.name}分给${weak.name}`, intent: { mode: "give", matterId: food.id, toAgentId: weak.id, quantity: 1 } }, 20, `${weak.name}需要食物而我手中有余`, "分享一份食物");
    if (agent.body.surfaceLoad >= 4 && agent.locationId === "river") add({ type: "interact", with: { kind: "matter", id: "water-river" }, content: "用流动河水冲洗身体表面", intent: { mode: "apply-material", matterId: "water-river", targetAgentId: agent.id } }, 12 + agent.body.surfaceLoad * 2, `劳作和接触使身体表面附着量达到 ${Math.round(agent.body.surfaceLoad)}`, "让流动水带走表面附着物", ["safety", "mastery"]);
    const companion = visibleAgents.sort((a, b) => (agent.relations.find((r) => r.agentId === b.id)?.strength ?? 0) - (agent.relations.find((r) => r.agentId === a.id)?.strength ?? 0))[0];
    if (companion) {
      add({ type: "interact", with: { kind: "agent", id: companion.id }, content: `安慰并亲近${companion.name}`, intent: { mode: "bond", toAgentId: companion.id, gesture: "comfort" } }, 12, `${companion.name}就在身边`, "维持彼此关系");
      add({ type: "interact", with: { kind: "agent", id: companion.id }, content: "用固定短句讲述眼前变化", intent: { mode: "express", toAgentId: companion.id, speech: "记住我们眼前发生的变化。" } }, usingSupportWithOthers ? 18 : 6, usingSupportWithOthers ? "身体支撑让我能留在人群中，眼前共同经历仍值得交流" : "共同经历需要可重复的说法", "对同伴表达并观察回应");
      add({ type: "interact", with: { kind: "agent", id: companion.id }, content: "一起进行轮流规则游戏", intent: { mode: "perform", form: "game", partnerId: companion.id } }, usingSupportWithOthers ? 18 : 7, usingSupportWithOthers ? "身体虽仍受限，但支撑物让我能留在同伴身边参与不依赖远行的共同活动" : "有人在场且身体尚能活动", "邀请对方轮流游戏");
      add({ type: "interact", with: { kind: "agent", id: companion.id }, content: "随共同节奏舞动", intent: { mode: "perform", form: "dance", partnerId: companion.id } }, 5, "两人能听见同一节奏", "一起舞动");
      const sourcedKnowledge = agent.mind.cognition.knowledge.find((claim) => claim.sourceEventIds.length > 0 && !claim.claim.includes("告诉我："));
      if (sourcedKnowledge) add({ type: "interact", with: { kind: "agent", id: companion.id }, content: "把亲历所得告诉同伴", intent: { mode: "express", toAgentId: companion.id, speech: "这是我从亲历中学到的。", claim: sourcedKnowledge.claim, sourceEventIds: sourcedKnowledge.sourceEventIds.slice(-6) } }, 7, "眼前有同伴，而我的一种认识仍只属于个人", "讲述带有经历来源的认识", ["expression", "affiliation"]);
    }
    const ownPlan = agent.body.familyPlanning;
    const eligiblePartner = visibleAgents
      .filter((other) => !agent.body.pregnancy && !other.body.pregnancy && agent.body.sex !== other.body.sex && isFertileAge(agent.body.sex, agent.body.ageYears) && isFertileAge(other.body.sex, other.body.ageYears))
      .sort((a, b) => (agent.relations.find((r) => r.agentId === b.id)?.strength ?? 0) - (agent.relations.find((r) => r.agentId === a.id)?.strength ?? 0))[0];
    const partnerPlan = eligiblePartner?.body.familyPlanning;
    const shareBirth = Boolean(eligiblePartner && state.world.time.past.some((event) => event.kind === "environment" && event.change === "birth" && [String(event.diff.motherId), String(event.diff.fatherId)].includes(agent.id) && [String(event.diff.motherId), String(event.diff.fatherId)].includes(eligiblePartner.id)));
    const planReached = Boolean(eligiblePartner && ownPlan && partnerPlan && shareBirth && (ownPlan.birthCount >= ownPlan.desiredChildCount || partnerPlan.birthCount >= partnerPlan.desiredChildCount));
    const relationStrength = eligiblePartner ? agent.relations.find((relation) => relation.agentId === eligiblePartner.id)?.strength ?? 0 : 0;
    const flexibleBarrier = held.find((matter) => matter.traits.includes("barrier"));
    const flexibleRaw = held.find((matter) => matter.traits.includes("fiber") && matter.traits.includes("raw"));
    const localFlexibleRaw = localMatter.find((matter) => matter.traits.includes("fiber") && matter.traits.includes("raw"));
    if (eligiblePartner && !planReached) add({ type: "interact", with: { kind: "agent", id: eligiblePartner.id }, content: `向${eligiblePartner.name}表达亲近`, intent: { mode: "bond", toAgentId: eligiblePartner.id, gesture: "court" } }, 26, "双方年龄与身体条件允许，身边有合适的同伴", "试探对方是否愿意共同养育下一代", ["reproduction", "affiliation"]);
    if (eligiblePartner && planReached && relationStrength >= 38 && flexibleBarrier) add({ type: "interact", with: { kind: "agent", id: eligiblePartner.id }, content: `与${eligiblePartner.name}保持有防护的亲密`, intent: { mode: "bond", toAgentId: eligiblePartner.id, gesture: "intimate", barrierId: flexibleBarrier.id } }, 34, `彼此仍想亲近，但至少一人已有自己愿意照料的子女数量；柔性护套能隔开身体表面与液体`, "在降低妊娠机会的情况下保持亲密", ["affiliation", "reproduction", "care"]);
    const birthPartnerId = ownPlan?.birthCount ? state.world.time.past.filter((event) => event.kind === "environment" && event.change === "birth" && (event.diff.motherId === agent.id || event.diff.fatherId === agent.id)).map((event) => event.diff.motherId === agent.id ? String(event.diff.fatherId) : String(event.diff.motherId)).at(-1) : undefined;
    const birthPartner = birthPartnerId ? state.agents.find((other) => other.id === birthPartnerId && other.body.state === "active") : undefined;
    const ownPreferenceReached = Boolean(ownPlan && ownPlan.birthCount >= ownPlan.desiredChildCount);
    const rememberedPartnerRelation = birthPartner ? agent.relations.find((relation) => relation.agentId === birthPartner.id)?.strength ?? 0 : 0;
    const wantsProtectedIntimacy = Boolean(ownPreferenceReached && birthPartner && rememberedPartnerRelation >= 38 && isFertileAge(agent.body.sex, agent.body.ageYears) && isFertileAge(birthPartner.body.sex, birthPartner.body.ageYears) && agent.body.health >= 55 && birthPartner.body.health >= 55);
    if (wantsProtectedIntimacy && !flexibleBarrier && flexibleRaw) add({ type: "interact", with: { kind: "matter", id: flexibleRaw.id }, content: "把柔性材料编接成贴合护套", intent: { mode: "shape", inputIds: [flexibleRaw.id], desiredKind: "flexible-cover", desiredName: "柔性护套", desiredTraits: ["barrier"] } }, 42, "已有子女需要持续照料，手中柔性材料可以编成隔开身体表面与液体的覆盖物", "制作可重复使用的贴合护套", ["care", "safety", "mastery"]);
    if (wantsProtectedIntimacy && !flexibleBarrier && !flexibleRaw && localFlexibleRaw) add({ type: "interact", with: { kind: "matter", id: localFlexibleRaw.id }, content: `取得一份${localFlexibleRaw.name}`, intent: { mode: "take", matterId: localFlexibleRaw.id, quantity: 1 } }, 38, "柔性材料能够形成贴合身体的隔离层", "取得一份材料尝试编接护套", ["care", "safety", "mastery"]);
    if (wantsProtectedIntimacy && !flexibleBarrier && !flexibleRaw && !localFlexibleRaw && agent.locationId !== "river") add({ type: "move", to: nextLocation(state, agent, "river") }, 32, "已有子女需要长期照料，而河岸常有可编结的柔性材料", "前往河岸寻找可覆盖身体的材料", ["care", "safety", "mastery"]);
    if (wantsProtectedIntimacy && flexibleBarrier && birthPartner && agent.locationId !== birthPartner.locationId) add({ type: "move", to: nextLocation(state, agent, birthPartner.locationId) }, 28, `我记得和${birthPartner.name}共同养育已有子女，手中的覆盖物让我们能继续亲密而降低再次妊娠机会`, `前往${locationName(state, birthPartner.locationId)}与${birthPartner.name}相聚`, ["affiliation", "reproduction", "care"]);

    add({ type: "interact", with: { kind: "space", id: agent.locationId }, content: "观察此刻天象与环境", intent: { mode: "observe", aspect: agent.mind.cognition.interpretations.length % 2 ? "climate" : "sky" } }, 7, "眼前环境仍包含未知变化", "留下这次局部观察");
    add({ type: "interact", with: { kind: "space", id: agent.locationId }, content: "敲击身边材料形成节奏", intent: { mode: "perform", form: "music" } }, 3, "周围材料能发出可重复声音", "尝试组织节奏");
    const medium = [...held, ...localMatter].find((matter) => matter.traits.includes("recordable"));
    if (medium) add({ type: "interact", with: { kind: "matter", id: medium.id }, content: "描绘眼前人物和地形", intent: { mode: "perform", form: "image", mediumId: medium.id } }, 8, "可刻写载体就在身边", "用形状留下所见");

    const episodesBySubject = new Map<string, ActionFact[]>();
    experiencedCareFacts.forEach((fact) => {
      const subject = String(fact.diff.targetAgentId ?? fact.diff.partnerId ?? "");
      if (subject) episodesBySubject.set(subject, [...(episodesBySubject.get(subject) ?? []), fact]);
    });
    const recordableEpisode = [...episodesBySubject.entries()].find(([, facts]) => facts.some((fact) => fact.diff.examinedAbnormality === true) && facts.some((fact) => careOutcomeFromDiff(fact.diff) && careOutcomeFromDiff(fact.diff) !== "observed") && !medium?.records?.some((record) => record.subjectAgentId === facts[0]?.diff.targetAgentId && record.kind === "chronicle"));
    if (medium && recordableEpisode) {
      const [subjectId, facts] = recordableEpisode;
      add({ type: "interact", with: { kind: "matter", id: medium.id }, content: "把一次身体变化的检查、处置和结果相连刻下", intent: { mode: "record", mediumId: medium.id, recordKind: "chronicle", sourceEventIds: facts.map((fact) => fact.id).slice(-8), note: `记录${state.agents.find((other) => other.id === subjectId)?.name ?? "同伴"}身体变化前后的经过` } }, 56, "我的记忆里已有同一人的异常、采取的手段和后来结果，载体可以把它们连在一起", "留下可回看的连续经历", ["safety", "care", "expression"]);
    }
    const materialOutcomeFacts = experiencedCareFacts.filter((fact) => fact.diff.botanicalMaterial === true && typeof fact.diff.appliedMaterial === "string" && ["beneficial", "neutral", "harmful"].includes(String(fact.diff.materialBodyEffect)));
    const experiencedMethods = [...new Set(materialOutcomeFacts.map((fact) => String(fact.diff.appliedMaterial)))];
    const hasContrastingOutcomes = materialOutcomeFacts.some((fact) => fact.diff.materialBodyEffect === "beneficial") && materialOutcomeFacts.some((fact) => fact.diff.materialBodyEffect === "neutral" || fact.diff.materialBodyEffect === "harmful");
    const authoredComparisonRecord = state.world.matter.flatMap((matter) => matter.records ?? []).find((record) => record.authorId === agent.id && (record.comparedMethods?.length ?? 0) >= 2 && (record.rejectedMethods?.length ?? 0) >= 1);
    if (medium && experiencedMethods.length >= 2 && hasContrastingOutcomes && !medium.records?.some((record) => record.authorId === agent.id && (record.comparedMethods?.length ?? 0) >= 2)) {
      const comparisonSources = experiencedMethods.flatMap((method) => materialOutcomeFacts.filter((fact) => fact.diff.appliedMaterial === method).slice(-2)).map((fact) => fact.id);
      add({ type: "interact", with: { kind: "matter", id: medium.id }, content: "把几种材料作用后的不同变化并列刻下", intent: { mode: "record", mediumId: medium.id, recordKind: "chronicle", sourceEventIds: comparisonSources, note: "比较几种材料作用后的不同身体变化" } }, 60, "我亲历过不同材料作用后并不相同的身体结果，并列留痕能避免只凭模糊记忆判断", "把有差异的经历并列记录", ["safety", "care", "expression"]);
    }
    const laterUnresolvedIllness = authoredComparisonRecord && state.tick >= authoredComparisonRecord.createdTick
      ? visibleAgents.find((other) => other.body.state === "active" && other.body.illness) ?? (agent.body.illness ? agent : undefined)
      : undefined;
    if (authoredComparisonRecord && laterUnresolvedIllness) {
      const rejectedKinds = new Set(authoredComparisonRecord.rejectedMethods ?? []);
      const retainedMaterial = [...held, ...localMatter].find((matter) => matter.traits.includes("botanical") && !rejectedKinds.has(matter.kind) && agent.mind.cognition.knowledge.some((claim) => claim.kind === "material-body-effect" && claim.subjectKind === matter.kind && claim.observedEffect === "beneficial"));
      if (retainedMaterial) add({ type: "interact", with: { kind: "matter", id: retainedMaterial.id }, content: `按留下的不同结果把${retainedMaterial.name}用于${laterUnresolvedIllness.name}`, intent: { mode: "apply-material", matterId: retainedMaterial.id, targetAgentId: laterUnresolvedIllness.id } }, 46, `留下的记录显示这种材料曾改善身体，而另一些材料没有改善或使身体变差`, "沿用有改善证据且避开较差结果", ["care", "safety", "mastery"]);
      else if (agent.locationId !== "field") add({ type: "move", to: nextLocation(state, agent, "field") }, 30, "留下的不同结果使我不愿再用较差的材料，田地仍有曾产生改善的另一种植物", "寻找记录中效果较好的材料", ["care", "safety", "mastery"]);
    }
    if (!medium && experiencedCareFacts.length >= 4) {
      const localRecordable = localMatter.find((matter) => matter.traits.includes("recordable"));
      if (!localRecordable && agent.locationId !== "square" && canCarryLightRecord) add({ type: "move", to: nextLocation(state, agent, "square") }, 31, "几次身体变化和处置结果仍只在记忆里，而空地有能留下刻痕的湿黏土", "前往能取得记录载体的地方", ["safety", "care", "expression"]);
    }

    const ownObservationIds = [...new Set(agent.mind.cognition.memory.episodic.filter((fragment) => fragment.succeeded && fragment.actionKey?.startsWith("interact:observe:")).flatMap((fragment) => fragment.sourceEventIds))];
    const existingRecords = medium?.records ?? [];
    if (medium && ownObservationIds.length >= 2 && !existingRecords.some((record) => record.authorId === agent.id && record.kind === "tally")) add({ type: "interact", with: { kind: "matter", id: medium.id }, content: "把几次观察刻成可比较的数量", intent: { mode: "record", mediumId: medium.id, recordKind: "tally", sourceEventIds: ownObservationIds.slice(-6), note: "比较亲历事件发生的次数" } }, 10, "已有多次亲历观察且载体能够留痕", "刻下计数记录", ["curiosity", "expression"]);
    if (medium && ownObservationIds.length >= 5 && !existingRecords.some((record) => record.authorId === agent.id && record.kind === "calendar")) add({ type: "interact", with: { kind: "matter", id: medium.id }, content: "比较天象和气候的时间间隔", intent: { mode: "record", mediumId: medium.id, recordKind: "calendar", sourceEventIds: ownObservationIds.slice(-8), note: "按年份比较天象与气候变化" } }, 12, "多次带年份的观察能够比较间隔", "整理成可复查的历法", ["curiosity", "expression"]);
    if (medium && ownObservationIds.length >= 3 && !existingRecords.some((record) => record.kind === "notation")) add({ type: "interact", with: { kind: "matter", id: medium.id }, content: "用不同刻号区分反复出现的变化", intent: { mode: "record", mediumId: medium.id, recordKind: "notation", sourceEventIds: ownObservationIds.slice(-6), note: "用不同符号区分天象、冷热与纪元" } }, 11, "计数仍不能区分不同种类的亲历变化", "约定稳定的区别符号", ["expression", "curiosity"]);

    const calendarRecord = existingRecords.find((record) => record.kind === "calendar");
    const pendingHypothesis = agent.mind.cognition.hypotheses.some((hypothesis) => hypothesis.status === "pending");
    if (calendarRecord && !pendingHypothesis) {
      const predictsChaos = deterministicFraction(state.seed, `forecast:${state.tick}:${agent.id}`) < 0.45;
      const predictedEpoch: EpochKind = predictsChaos ? "chaotic" : "stable";
      const climateRoll = deterministicFraction(state.seed, `forecast-climate:${state.tick}:${agent.id}`);
      const predictedClimate: ClimateKind = predictedEpoch === "stable" ? "temperate" : climateRoll < 0.45 ? "cold" : climateRoll < 0.9 ? "heat" : "fire";
      add({ type: "interact", with: { kind: "space", id: agent.locationId }, content: `按现有记录预言三年后${predictedEpoch === "chaotic" ? "进入乱纪元" : "仍是恒纪元"}`, intent: { mode: "predict", predictedEpoch, predictedClimate, dueTick: state.tick + 3, sourceEventIds: calendarRecord.sourceEventIds } }, 9, "手边历法留下了几次变化，但未来仍不确定", "提出一个等待事实检验的预测", ["curiosity", "status"]);
    }

    const failedHypothesis = agent.mind.cognition.hypotheses.find((hypothesis) => hypothesis.status === "failed");
    const localUnfinishedModel = localMatter.find((matter) => matter.kind === "sky-model" && matter.construction && !matter.construction.complete);
    const localInstrument = localMatter.find((matter) => matter.kind === "sky-model" && matter.construction?.complete && matter.traits.includes("instrument"));
    if (failedHypothesis && buildingItem && (localUnfinishedModel || !localInstrument)) add({ type: "interact", with: { kind: "space", id: agent.locationId }, content: "把构件接成可转动的天象关系", intent: { mode: "assemble", inputIds: [buildingItem.id], siteId: agent.locationId, desiredKind: "sky-model", desiredName: "简易天象模型", purpose: "instrument", arrangement: { support: 65, cover: 20, boundary: 20, opening: 85 } } }, 22, "预测失败，而手中构件可以把位置关系变成可操作对象", "搭建并调整天象模型", ["curiosity", "mastery"]);
    if (localInstrument && medium && ownObservationIds.length >= 3 && !existingRecords.some((record) => record.kind === "model")) add({ type: "interact", with: { kind: "matter", id: medium.id }, content: "记下模型的位置、数量和转动关系", intent: { mode: "record", mediumId: medium.id, recordKind: "model", sourceEventIds: ownObservationIds.slice(-6), note: "用数量与位置描述天象模型" } }, 16, "完整模型和多次观察可以相互比较", "留下模型的数量关系", ["curiosity", "expression"]);

    const contactAssociation = agent.mind.cognition.knowledge.find((item) => item.kind === "contact-illness-association" && item.confidence >= 52);
    const currentCompanions = visibleAgents.filter((other) => other.body.state !== "dead").length;
    for (const neighbor of location(state, agent.locationId)?.neighbors ?? []) {
      const seeksDistance = Boolean(agent.body.illness && contactAssociation && currentCompanions > 0);
      add({ type: "move", to: neighbor }, seeksDistance ? 18 + currentCompanions * 4 : 0, seeksDistance ? "我在接触病人后发病，而眼前仍有其他人；相邻地点的情况只有走过去才知道" : `${locationName(state, neighbor)}与这里相邻且可以探索`, seeksDistance ? `离开眼前人群，前往${locationName(state, neighbor)}` : `前往${locationName(state, neighbor)}`, seeksDistance ? ["safety", "care"] : ["curiosity", "safety"]);
    }

    const chosen = candidates.map((candidate) => ({ candidate, score: candidateScore(state, agent, candidate) })).sort((a, b) => b.score - a.score)[0].candidate;
    const leadingDrive = agent.mind.needs.drives.find((drive) => chosen.drives.includes(drive.kind)) ?? agent.mind.needs.drives[0];
    return { ...decision(agent, chosen.action, leadingDrive ? `${leadingDrive.label}（${Math.round(leadingDrive.intensity)}）` : "回应眼前需要", `${chosen.perception}；${leadingDrive?.reason ?? ""}`, chosen.choice), needLevel: leadingDrive?.level ?? agent.mind.needs.dominantLevel };
  }
}

function decision(agent: AgentState, action: Action, focus: string, perception: string, choice: string): Decision {
  return { action, needLevel: agent.mind.needs.dominantLevel, needFocus: focus, perception, choice };
}

function actionKey(action: Action) {
  if (action.type === "move") return `move:${action.to}`;
  const intent = action.intent;
  if (!intent) return `interact:${action.content}`;
  if (intent.mode === "shape" || intent.mode === "assemble") return `interact:${intent.mode}:${intent.desiredKind}`;
  if (intent.mode === "work") return `interact:work:${intent.change}`;
  if (intent.mode === "ignite") return "interact:ignite";
  if (intent.mode === "cook") return "interact:cook";
  if (intent.mode === "eat") return "interact:eat";
  if (intent.mode === "hunt") return "interact:hunt";
  if (intent.mode === "tend") return "interact:tend";
  if (intent.mode === "store") return "interact:store";
  if (intent.mode === "perform") return `interact:perform:${intent.form}`;
  if (intent.mode === "claim") return "interact:claim";
  if (intent.mode === "trade") return "interact:trade";
  if (intent.mode === "relocate") return "interact:relocate";
  if (intent.mode === "drink") return "interact:drink";
  if (intent.mode === "rest") return "interact:rest";
  if (intent.mode === "warm") return "interact:warm";
  if (intent.mode === "bond") return `interact:bond:${intent.gesture}`;
  if (intent.mode === "inspect-body") return "interact:inspect-body";
  if (intent.mode === "apply-material") return `interact:apply-material:${intent.matterId}`;
  if (intent.mode === "treat") return "interact:treat";
  if (intent.mode === "fit-support") return "interact:fit-support";
  if (intent.mode === "bury") return "interact:bury";
  if (intent.mode === "adapt") return `interact:adapt:${intent.change}`;
  if (intent.mode === "observe") return `interact:observe:${intent.aspect}`;
  if (intent.mode === "record") return `interact:record:${intent.recordKind}`;
  if (intent.mode === "predict") return "interact:predict";
  return `interact:${intent.mode}`;
}
function actionLabel(action: Action, state: SimulationState) {
  const key = actionKey(action);
  if (action.type === "move") return `反复前往${locationName(state, action.to)}`;
  const intent = action.intent;
  if (intent?.mode === "shape") return `反复制作${intent.desiredName}`;
  if (intent?.mode === "assemble") return `共同搭建${intent.desiredName}`;
  if (intent?.mode === "work") return `反复改造地面（${intent.change}）`;
  if (intent?.mode === "ignite") return "反复维持火种";
  if (intent?.mode === "cook") return "反复烹饪食物";
  if (intent?.mode === "eat") return "反复食用食物";
  if (intent?.mode === "hunt") return "反复捕猎动物";
  if (intent?.mode === "tend") return "反复照料动物";
  if (intent?.mode === "store") return "反复储藏食物";
  if (intent?.mode === "perform") return `反复进行${intent.form === "image" ? "描绘" : intent.form === "music" ? "音乐" : intent.form === "dance" ? "舞蹈" : "游戏"}`;
  if (intent?.mode === "claim") return "反复声明使用边界";
  if (intent?.mode === "trade") return "反复交换货物";
  if (intent?.mode === "relocate") return "迁移生活中心";
  if (intent?.mode === "drink") return "反复饮水";
  if (intent?.mode === "rest") return "反复休息";
  if (intent?.mode === "warm") return "反复取暖";
  if (intent?.mode === "bond") return intent.gesture === "court" ? "反复求偶亲近" : intent.gesture === "intimate" ? "反复维持有防护的亲密" : intent.gesture === "care" ? "反复照料同伴" : "反复安慰同伴";
  if (intent?.mode === "inspect-body") return "反复比较身体状态";
  if (intent?.mode === "apply-material") return "反复把材料用于身体";
  if (intent?.mode === "treat") return "反复照护病人";
  if (intent?.mode === "fit-support") return "反复适配身体支撑";
  if (intent?.mode === "bury") return "安葬并纪念逝者";
  if (intent?.mode === "adapt") return intent.change === "dehydrate" ? "反复在灾害前脱水" : "反复浸泡唤醒同伴";
  if (intent?.mode === "observe") return `反复观察${intent.aspect === "sky" ? "天象" : intent.aspect === "climate" ? "气候" : "数量"}`;
  if (intent?.mode === "record") return `反复留下${recordKindLabel(intent.recordKind)}`;
  if (intent?.mode === "predict") return "反复提出可检验预测";
  if (intent?.mode === "express") return "反复表达与回应";
  if (intent?.mode === "give") return "反复转交物质";
  if (intent?.mode === "take") return "反复收取物质";
  return key.slice(9);
}
function derivedMilestones(state: SimulationState): MilestoneObservation[] {
  const events = state.world.time.past;
  const successfulActions = events.filter((event): event is ActionFact => event.kind === "action" && event.succeeded);
  const environmentFacts = events.filter((event): event is EnvironmentFact => event.kind === "environment");
  const milestones: MilestoneObservation[] = [];
  const add = (id: MilestoneObservation["id"], label: string, evidenceEventIds: string[], note: string) => {
    if (evidenceEventIds.length) milestones.push({ id, label, evidenceEventIds: [...new Set(evidenceEventIds)], note });
  };
  const births = environmentFacts.filter((event) => event.change === "birth");
  add("1", "诞生", births.map((event) => event.id), "新个体必须由实际孕育过程进入世界，出生时间、父母与世代均保存在事实中。" );
  add("2", "繁衍后代", births.filter((event) => typeof event.diff.motherId === "string" && typeof event.diff.fatherId === "string").map((event) => event.id), "亲近行为只提供受孕可能，后代必须经过妊娠并实际出生。" );
  const nurtureGroups = new Map<string, ActionFact[]>();
  successfulActions.filter((event) => event.diff.nurturedChild === true && typeof event.diff.partnerId === "string").forEach((event) => {
    const childId = String(event.diff.partnerId);
    nurtureGroups.set(childId, [...(nurtureGroups.get(childId) ?? []), event]);
  });
  add("3", "养育幼儿", [...nurtureGroups.values()].filter((facts) => facts.length >= 2 && new Set(facts.map((fact) => fact.tick)).size >= 2).flatMap((facts) => facts.map((fact) => fact.id)), "幼儿的依赖状态持续产生照料需要；同一幼儿必须在至少两个年份获得实际照料才算形成养育。" );
  add("4", "结成家庭与亲族", births.filter((event) => Number(event.diff.generation) >= 1).map((event) => event.id), "出生事实把父母与新一代连接为可追溯亲缘，而不是预置家庭标签。" );
  const illnessOnsets = environmentFacts.filter((event) => event.change === "illness" && event.diff.onset === true);
  add("5", "生病", illnessOnsets.map((event) => event.id), "疾病由营养、健康、暴露、年龄与同地接触共同形成概率风险，并作为可见身体状态持续存在。" );
  const treatments = successfulActions.filter((event) => event.diff.treatedIllness === true && Number(event.diff.severityAfter) < Number(event.diff.severityBefore));
  add("6", "医治伤病", treatments.flatMap((event) => [event.id, ...(Array.isArray(event.diff.illnessSourceEventIds) ? event.diff.illnessSourceEventIds.filter((id): id is string => typeof id === "string") : [])]), "人物必须面对实际病人，并利用同地食物、水源或住所使病情强度下降；证据同时引用患病来源与照护行动。" );
  add("7", "照料弱者", successfulActions.filter((event) => event.diff.caredForWeak === true).map((event) => event.id), "人物因眼前他人的身体虚弱或生活依赖而实施照料。" );
  add("8", "衰老", environmentFacts.filter((event) => event.change === "survival" && event.diff.cause === "aging").map((event) => event.id), "个体随时间进入老年，事实独立于后来是否因衰老死亡。" );
  add("9", "死亡", environmentFacts.filter((event) => event.diff.bodyState === "dead" || event.change === "prediction" && event.diff.executed === true).map((event) => event.id), "死亡来自寿命、身体存续失败或群体行为的实际后果。" );
  const memorials = state.world.matter.filter((matter) => matter.traits.includes("memorial") && matter.personId);
  add("10", "埋葬并纪念死者", memorials.flatMap((matter) => matter.sourceEventIds ?? []), "死亡留下带有逝者身份和死亡来源的遗体；在场人物主动将它转化为可辨认纪念处，物质与事实来源保持连续。" );
  const examinations = successfulActions.filter((event) => event.diff.examinedAbnormality === true && Array.isArray(event.diff.sourceEventIds));
  add("101", "识别疼痛与身体异常", examinations.flatMap((event) => [event.id, ...(event.diff.sourceEventIds as unknown[]).filter((id): id is string => typeof id === "string")]), "人物先感知到同伴身体偏离常态，再以检查行动辨认疼痛、体温、伤口、出血或病情；异常来源与检查结果均可追溯。" );
  const bodyCleaningGroups = new Map<string, ActionFact[]>();
  successfulActions.filter((event) => event.diff.cleanedBody === true && Number(event.diff.surfaceLoadAfter) < Number(event.diff.surfaceLoadBefore) && typeof event.diff.targetAgentId === "string").forEach((event) => {
    const targetAgentId = String(event.diff.targetAgentId);
    bodyCleaningGroups.set(targetAgentId, [...(bodyCleaningGroups.get(targetAgentId) ?? []), event]);
  });
  const maintainedCleaning = [...bodyCleaningGroups.values()].filter((facts) => new Set(facts.map((fact) => fact.tick)).size >= 2);
  add("102", "清洁身体并保持卫生", maintainedCleaning.flatMap((facts) => facts.map((event) => event.id)), "日常活动先在身体表面积累附着物；同一人物必须在至少两个不同年份把真实流动水作用于身体并降低附着量，较低附着量同时降低后续感染风险。" );
  const woundApplications = successfulActions.filter((event) => Number(event.diff.bleedingAfter) < Number(event.diff.bleedingBefore) && Array.isArray(event.diff.injurySourceEventIds));
  add("103", "处理伤口并止血", woundApplications.flatMap((event) => [event.id, ...(event.diff.injurySourceEventIds as unknown[]).filter((id): id is string => typeof id === "string")]), "世界只裁决材料性质与身体状态：真实纤维被消耗并作用于实际出血伤口后，液体流失下降；观察器据此前后变化识别伤口处理。" );
  const supportedBirths = births.filter((event) => event.diff.supportedBirth === true && Array.isArray(event.diff.supportEventIds) && (event.diff.supportEventIds as unknown[]).length > 0 && Array.isArray(event.diff.attendantAgentIds) && (event.diff.attendantAgentIds as unknown[]).length > 0);
  add("104", "接生并保护产妇", supportedBirths.flatMap((event) => [event.id, ...(event.diff.supportEventIds as unknown[]).filter((id): id is string => typeof id === "string")]), "妊娠期间的通用照料留下行动者与来源；分娩发生时至少一名实际照料者仍与产妇同地，并降低产妇和新生儿的身体损耗。" );
  const distancingMoves = successfulActions.filter((event) => event.action.type === "move" && event.diff.distancedWhileIll === true && Array.isArray(event.diff.contactKnowledgeSourceEventIds));
  add("105", "认识传染与主动隔离", distancingMoves.flatMap((event) => [event.id, ...(event.diff.contactKnowledgeSourceEventIds as unknown[]).filter((id): id is string => typeof id === "string")]), "人物必须先亲历病人接触与随后发病的关联，形成带来源的个人认识；仍在患病时普通移动确实减少身边接触人数，观察器才识别为主动隔离。" );
  const beneficialBotanicals = successfulActions.filter((event) => event.diff.botanicalMaterial === true && event.diff.materialBodyEffect === "beneficial" && Number(event.diff.illnessAfter) < Number(event.diff.illnessBefore));
  const repeatedBotanicalEffects = new Map<string, ActionFact[]>();
  beneficialBotanicals.forEach((event) => {
    const key = String(event.diff.appliedMaterial ?? "");
    repeatedBotanicalEffects.set(key, [...(repeatedBotanicalEffects.get(key) ?? []), event]);
  });
  const empiricalBotanicalUse = [...repeatedBotanicalEffects.values()].filter((facts) => new Set(facts.map((fact) => fact.who)).size >= 2 || new Set(facts.map((fact) => fact.tick)).size >= 2);
  add("106", "使用草药与经验性药物", empiricalBotanicalUse.flatMap((facts) => facts.flatMap((event) => [event.id, ...(Array.isArray(event.diff.materialSourceEventIds) ? (event.diff.materialSourceEventIds as unknown[]).filter((id): id is string => typeof id === "string") : [])])), "植物只有客观但对人物未知的身体效应；人物经试用观察前后变化并形成有来源经验，同种植物的改善作用至少被跨年重复或由不同人物复现后才识别。" );
  const persistentCareGroups = new Map<string, ActionFact[]>();
  successfulActions.filter((event) => event.diff.treatedIllness === true && event.diff.persistentIllness === true && typeof event.diff.targetAgentId === "string" && Number.isFinite(Number(event.diff.illnessSinceTick))).forEach((event) => {
    const episodeKey = `${String(event.diff.targetAgentId)}:${String(event.diff.illnessKind)}:${Number(event.diff.illnessSinceTick)}`;
    persistentCareGroups.set(episodeKey, [...(persistentCareGroups.get(episodeKey) ?? []), event]);
  });
  const persistentCare = [...persistentCareGroups.values()].filter((facts) => new Set(facts.map((fact) => fact.tick)).size >= 2);
  add("108", "照护慢性病患者", persistentCare.flatMap((facts) => facts.flatMap((event) => [event.id, ...(Array.isArray(event.diff.illnessSourceEventIds) ? (event.diff.illnessSourceEventIds as unknown[]).filter((id): id is string => typeof id === "string") : [])])), "同一人的同一次病程必须至少持续三年，并在成为持续病程后于至少两个不同年份获得真实资源支持；不同疾病发作或同年重复行动不会被合并为慢性照护。" );
  const distressOnsets = environmentFacts.filter((event) => event.change === "distress" && (event.diff.affectStateAfter === "distressed" || event.diff.affectStateAfter === "disorganized"));
  const distressSupportGroups = new Map<string, ActionFact[]>();
  successfulActions.filter((event) => event.diff.supportedDistress === true && Number(event.diff.strainAfter) < Number(event.diff.strainBefore) && typeof event.diff.partnerId === "string").forEach((event) => {
    const targetId = String(event.diff.partnerId);
    distressSupportGroups.set(targetId, [...(distressSupportGroups.get(targetId) ?? []), event]);
  });
  const sustainedDistressSupport = [...distressSupportGroups.entries()].filter(([, facts]) => new Set(facts.map((fact) => fact.tick)).size >= 2);
  add("109", "应对精神痛苦与失序", sustainedDistressSupport.flatMap(([targetId, facts]) => [...distressOnsets.filter((event) => event.diff.agentId === targetId).map((event) => event.id), ...facts.map((event) => event.id)]), "精神负荷由关系损失、灾害、疾病和长期匮乏累积；只有出现可见失序后，同一人跨年至少两次获得实际陪伴且负荷下降，观察器才识别为社会性应对。" );
  const careActions = successfulActions.filter((event) => event.diff.examinedAbnormality === true || event.diff.treatedIllness === true && Number(event.diff.severityAfter) < Number(event.diff.severityBefore) || event.diff.botanicalMaterial === true && event.diff.materialBodyEffect === "beneficial" || event.diff.supportedDistress === true && Number(event.diff.strainAfter) < Number(event.diff.strainBefore));
  const careRoleGroups = new Map<string, ActionFact[]>();
  careActions.forEach((event) => careRoleGroups.set(event.who, [...(careRoleGroups.get(event.who) ?? []), event]));
  const recognizedCareRoles = [...careRoleGroups.values()].filter((facts) => {
    const actor = state.agents.find((agent) => agent.id === facts[0]?.who);
    return (actor?.standing.careTrust ?? 0) >= 10 && new Set(facts.map((fact) => String(fact.diff.targetAgentId ?? fact.diff.partnerId ?? ""))).size >= 3 && new Set(facts.map((fact) => fact.tick)).size >= 3 && facts.filter((fact) => fact.diff.treatedIllness === true || fact.diff.materialBodyEffect === "beneficial" || fact.diff.supportedDistress === true).length >= 3;
  });
  add("110", "发展专业医者角色", recognizedCareRoles.flatMap((facts) => facts.map((event) => event.id)), "角色不是预设职业：同一人物必须跨至少三年为至少三名不同对象反复检查或照护，且多次产生实际改善；由累积照护信任与群体事实事后识别。" );
  const establishedCarePlaces = state.world.space.locations.flatMap((place) => {
    const traces = (place.useTraces ?? []).filter((trace) => trace.kind === "care");
    const shelter = state.world.matter.find((matter) => matter.holder.kind === "space" && matter.holder.id === place.id && matter.traits.includes("shelter") && matter.construction?.complete);
    if (!shelter || traces.length < 10 || new Set(traces.map((trace) => trace.actorId)).size < 3 || new Set(traces.map((trace) => trace.subjectAgentId)).size < 4 || new Set(traces.map((trace) => trace.tick)).size < 5) return [];
    const structureEvents = (shelter.sourceEventIds ?? []).flatMap((id) => successfulActions.filter((event) => event.id === id));
    const completedAt = Math.max(0, ...structureEvents.filter((event) => event.diff.complete === true).map((event) => event.tick));
    const continuedUse = traces.filter((trace) => trace.tick >= completedAt && trace.outcome !== "observed");
    return completedAt > 0 && continuedUse.length >= 3 && new Set(continuedUse.map((trace) => trace.tick)).size >= 2 ? [{ place, shelter, traces, continuedUse }] : [];
  });
  add("111", "建立诊疗场所", establishedCarePlaces.flatMap(({ shelter, traces }) => [...(shelter.sourceEventIds ?? []), ...traces.map((trace) => trace.eventId)]), "场所没有预置用途：同一地点先长期汇聚不同人物的检查与照护，后来形成完整遮蔽，并继续跨年接纳多名照护者和对象，观察器才把稳定空间用途识别为诊疗场所。" );
  const careRecords = state.world.matter.flatMap((matter) => (matter.records ?? []).filter((record) => record.kind === "chronicle" && record.subjectAgentId && record.episodeKey && record.outcome).map((record) => ({ matter, record })));
  const documentedEpisodes = new Map<string, { matter: MatterState; record: EvidenceRecord }>();
  careRecords.forEach((entry) => documentedEpisodes.set(entry.record.episodeKey!, entry));
  const documentedCare = [...documentedEpisodes.values()].filter(({ record }) => {
    const facts = record.sourceEventIds.flatMap((id) => successfulActions.filter((event) => event.id === id));
    return facts.some((event) => event.diff.examinedAbnormality === true) && facts.some((event) => careOutcomeFromDiff(event.diff) && careOutcomeFromDiff(event.diff) !== "observed");
  });
  add("112", "记录病历与治疗结果", documentedCare.length >= 2 && new Set(documentedCare.map(({ record }) => record.subjectAgentId)).size >= 2 ? documentedCare.flatMap(({ matter, record }) => [record.id, ...(matter.sourceEventIds ?? []), ...record.sourceEventIds]) : [], "外部记录必须把同一对象的身体异常、采取的手段和后来结果连成可复查来源链；至少两个不同对象的独立经历被记录，才不是一次随手记述。" );
  const comparativeRecords = state.world.matter.flatMap((matter) => (matter.records ?? []).filter((record) => record.kind === "chronicle").flatMap((record) => {
    const materialFacts = record.sourceEventIds.flatMap((id) => successfulActions.filter((event) => event.id === id && event.diff.botanicalMaterial === true));
    const methods = new Set(materialFacts.map((event) => String(event.diff.appliedMaterial ?? "")));
    const rejected = materialFacts.filter((event) => event.diff.materialBodyEffect === "harmful" || event.diff.materialBodyEffect === "neutral");
    const retained = materialFacts.filter((event) => event.diff.materialBodyEffect === "beneficial");
    if (methods.size < 2 || !rejected.length || !retained.length) return [];
    const rejectedKinds = new Set(rejected.map((event) => String(event.diff.appliedMaterial)));
    const comparisonTick = record.createdTick;
    const authorAccessibleIds = new Set([
      ...successfulActions.filter((event) => event.who === record.authorId).map((event) => event.id),
      ...state.agents.find((agent) => agent.id === record.authorId)?.mind.cognition.knowledge.flatMap((claim) => claim.sourceEventIds) ?? [],
    ]);
    const laterObservedCare = successfulActions.filter((event) => event.tick > comparisonTick && authorAccessibleIds.has(event.id) && event.action.type === "interact" && (event.action.intent?.mode === "treat" || event.action.intent?.mode === "apply-material"));
    const reusedRejected = laterObservedCare.some((event) => event.diff.botanicalMaterial === true && rejectedKinds.has(String(event.diff.appliedMaterial)));
    return !reusedRejected && laterObservedCare.length >= 1 ? [{ matter, record, materialFacts, laterActorCare: laterObservedCare }] : [];
  }));
  add("113", "比较疗法并淘汰无效做法", comparativeRecords.flatMap(({ matter, record, materialFacts, laterActorCare }) => [record.id, ...(matter.sourceEventIds ?? []), ...materialFacts.map((event) => event.id), ...laterActorCare.map((event) => event.id)]), "同一人物须把至少两种材料的不同身体结果并列记录；此后再次面对身体照护时不再复用无效或有害材料，而选择记录中较好或性质不同的手段，才被识别为经验淘汰。" );
  const fittedSupports = successfulActions.filter((event) => event.diff.fittedSupport === true && Number(event.diff.mobilityLossAfter) < Number(event.diff.mobilityLossBefore) && typeof event.diff.targetAgentId === "string");
  const rehabilitated = fittedSupports.flatMap((fit) => {
    const target = state.agents.find((agent) => agent.id === fit.diff.targetAgentId);
    const laterMoves = successfulActions.filter((event) => event.who === fit.diff.targetAgentId && event.tick > fit.tick && event.action.type === "move");
    const support = state.world.matter.find((matter) => matter.id === fit.diff.supportId && matter.holder.kind === "agent" && matter.holder.id === fit.diff.targetAgentId && matter.traits.includes("supportive"));
    const improved = Boolean(target && ((target.body.injury?.assistedYears ?? 0) >= 1 || !target.body.injury) && target.limbs.abilities.move > Number(target.body.injury?.mobilityAtInjury ?? 0) - Number(fit.diff.mobilityLossBefore) / 2);
    return support && laterMoves.length >= 1 && improved ? [{ fit, target, support, laterMoves }] : [];
  });
  add("116", "提供康复与辅助器具", rehabilitated.flatMap(({ fit, support, laterMoves }) => [fit.id, ...(support.sourceEventIds ?? []), ...laterMoves.map((event) => event.id)]), "真实跌伤必须先造成持续移动功能损失；刚性材料经加工成为支撑物并适配给伤者后，功能受限下降，伤者随后重新移动且跨年继续改善，观察器才识别为康复与辅助器具。" );
  const participatoryModes = new Set(["take", "give", "assemble", "work", "perform", "express", "record", "treat", "apply-material", "inspect-body", "bond", "trade", "tend", "shape", "hunt", "cook", "store", "claim"]);
  const enabledParticipation = fittedSupports.flatMap((fit) => {
    const targetAgentId = String(fit.diff.targetAgentId);
    if (fit.who === targetAgentId) return [];
    const movesIntoCompany = successfulActions.filter((event) => event.who === targetAgentId && event.tick > fit.tick && event.action.type === "move" && event.diff.supportInUse === true && event.diff.mobilityLimitedAtAction === true && Number(event.diff.companionsAfter) >= 1);
    const firstArrivalTick = movesIntoCompany.length ? Math.min(...movesIntoCompany.map((event) => event.tick)) : Number.POSITIVE_INFINITY;
    const contributions = successfulActions.filter((event) => event.who === targetAgentId && event.tick >= firstArrivalTick && event.action.type === "interact" && participatoryModes.has(event.action.intent?.mode ?? "") && event.diff.supportInUse === true && event.diff.mobilityLimitedAtAction === true && Number(event.diff.lastingMobilityLossAtAction) > 0 && Number(event.diff.companionsAtAction) >= 1);
    return movesIntoCompany.length && contributions.length ? [{ fit, movesIntoCompany, contributions }] : [];
  });
  add("117", "保障残障者参与生活", enabledParticipation.flatMap(({ fit, movesIntoCompany, contributions }) => [fit.id, ...movesIntoCompany.map((event) => event.id), ...contributions.map((event) => event.id)]), "功能余损必须真实持续存在；他人提供的支撑物让受限者进入有同伴的生活地点后，受限者仍需带着支撑完成采集、分享、劳动、照护、记录或共同文化活动，才由观察器识别为参与生活。" );
  const endOfLifeDeaths = environmentFacts.filter((event) => event.diff.bodyState === "dead" && event.diff.endOfLife === true && Array.isArray(event.diff.endOfLifeSupportEventIds));
  const accompaniedDeaths = endOfLifeDeaths.filter((event) => (event.diff.endOfLifeSupportEventIds as unknown[]).length >= 1 && Number(event.diff.comfortYears) >= 1 && (event.diff.supportAgentIds as unknown[] | undefined)?.length);
  add("119", "提供临终照护", accompaniedDeaths.flatMap((event) => [event.id, ...(event.diff.endOfLifeSourceEventIds as unknown[]).filter((id): id is string => typeof id === "string"), ...(event.diff.endOfLifeSupportEventIds as unknown[]).filter((id): id is string => typeof id === "string")]), "不可逆衰退先让人物退出劳动但继续经历身体不适；同伴必须在这段时期实际给食、照料或陪伴并降低疲惫或精神负荷，死亡仍按原定身体进程发生，才识别为临终照护而不是治愈。" );
  const adaptationRecoveries = environmentFacts.filter((event) => event.change === "adaptation" && event.diff.recoveredWithoutReuse === true && Array.isArray(event.diff.adaptationSourceEventIds) && Array.isArray(event.diff.withdrawalEventIds));
  const supportedAdaptationRecoveries = adaptationRecoveries.filter((event) => (event.diff.adaptationSourceEventIds as unknown[]).length >= 2 && (event.diff.withdrawalEventIds as unknown[]).length >= 1 && (event.diff.supportEventIds as unknown[] | undefined)?.length && Number(event.diff.supportedYears) >= 1);
  add("118", "处理成瘾与依赖", supportedAdaptationRecoveries.flatMap((event) => [event.id, ...(event.diff.adaptationSourceEventIds as unknown[]).filter((id): id is string => typeof id === "string"), ...(event.diff.withdrawalEventIds as unknown[]).filter((id): id is string => typeof id === "string"), ...((event.diff.supportEventIds as unknown[] | undefined) ?? []).filter((id): id is string => typeof id === "string")]), "同种材料必须先跨次作用于同一身体并产生耐受，停用后出现可见戒断；同伴用不含该材料的照料与陪伴帮助其降低适应水平，最终在未复用材料的情况下恢复，才识别为处理依赖。" );
  add("11", "采集食物", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "take" && event.diff.edible === true).map((event) => event.id), "人物因局部需要把空间中的可食物质转为自己持有。" );
  add("12", "捕猎动物", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "hunt").map((event) => event.id), "人物必须在动物所在地点携带工具，猎物被守恒地转化为肉、皮与骨。" );
  add("13", "分享资源", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "give" && event.diff.edible === true).map((event) => event.id), "食物必须由持有者交给同地人物，物质来源保持不变。" );
  add("14", "迁徙远方", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "relocate").map((event) => event.id), "人物先实际抵达新地点，再把自己的生活中心迁过去。" );
  add("15", "应对自然灾害", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "adapt").map((event) => event.id), "人物根据实际环境压力选择了脱水或浸泡。" );
  add("16", "制造工具", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "shape" && event.action.intent.desiredTraits?.some((trait) => trait === "sharp" || trait === "flat")).map((event) => event.id), "新物品必须由真实材料和加工行动形成。" );
  add("17", "掌控火种", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "ignite").map((event) => event.id), "火种只能消耗真实燃料并由工具与能力产生。" );
  add("18", "烹饪食物", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "cook").map((event) => event.id), "熟食由可食原料与同地火种共同转化。" );
  add("19", "制作衣物", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "shape" && event.action.intent.desiredTraits?.includes("wearable")).map((event) => event.id), "衣物由捕猎所得兽皮或纤维经过工具加工形成。" );
  const shelters = state.world.matter.filter((matter) => matter.construction?.complete && matter.traits.includes("shelter"));
  const inhabitedShelters = shelters.filter((matter) => {
    const uses = successfulActions.filter((event) => matter.construction?.useEventIds?.includes(event.id) && event.action.type === "interact" && event.action.intent?.mode === "rest");
    return new Set(uses.map((event) => event.tick)).size >= 2;
  });
  add("20", "建造住所", inhabitedShelters.flatMap((matter) => [...(matter.sourceEventIds ?? []), ...(matter.construction?.useEventIds ?? [])]), "结构必须由真实材料形成、客观降低风雨暴露，并在不同年份被实际用于休息，才由观察者识别为住所。" );
  const coordinated = shelters.flatMap((matter) => matter.sourceEventIds ?? []).filter((eventId, _index, ids) => {
    const actors = new Set(ids.map((id) => successfulActions.find((event) => event.id === id)?.who).filter(Boolean));
    return actors.size >= 2;
  });
  add("22", "协同行动", coordinated, "同一结构留下了多个行动者的事实来源。" );
  add("24", "讲述并传承往事", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "express" && event.diff.sharedSourcedClaim === true).map((event) => event.id), "人物把带有历史来源的认识讲给身边的人，来源链继续保留。" );
  const expressive = successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "express");
  const sharedPhrases = new Map<string, ActionFact[]>();
  expressive.forEach((event) => {
    const phrase = event.action.type === "interact" && event.action.intent?.mode === "express" ? event.action.intent.speech.replace(/[，。！？\s]/g, "").slice(0, 10) : "";
    if (phrase) sharedPhrases.set(phrase, [...(sharedPhrases.get(phrase) ?? []), event]);
  });
  add("21", "创造语言", [...sharedPhrases.values()].filter((facts) => facts.length >= 3 && new Set(facts.map((fact) => fact.who)).size >= 2).flatMap((facts) => facts.map((fact) => fact.id)), "相同短语被不同人物在多次表达中使用，语言由可重复沟通模式事后识别。" );
  const performances = (form: "image" | "music" | "dance" | "game") => successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "perform" && event.action.intent.form === form);
  add("25", "描绘形象", performances("image").map((event) => event.id), "人物必须使用可留下痕迹的物质载体描绘所见。" );
  add("26", "创作音乐与舞蹈", [...performances("music"), ...performances("dance")].map((event) => event.id), "节奏或共同舞动由人物在场行动形成。" );
  add("27", "游戏与竞赛", performances("game").map((event) => event.id), "至少两名在场人物参与同一规则游戏。" );
  const culturalGroups = new Map<string, ActionFact[]>();
  successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "perform").forEach((event) => {
    const key = event.action.type === "interact" && event.action.intent?.mode === "perform" ? event.action.intent.form : "";
    culturalGroups.set(key, [...(culturalGroups.get(key) ?? []), event]);
  });
  add("28", "制定习俗与伦理", [...culturalGroups.values()].filter((facts) => facts.length >= 4 && new Set(facts.flatMap((fact) => [fact.who, typeof fact.diff.partnerId === "string" ? fact.diff.partnerId : ""]).filter(Boolean)).size >= 2).flatMap((facts) => facts.map((fact) => fact.id)), "文化活动被多人反复采用后，才被观察为共同习俗。" );
  const strongRelations = state.agents.flatMap((agent) => agent.relations.filter((relation) => relation.strength >= 75).map((relation) => relation.sourceEventIds));
  add("29", "结成友谊与联盟", strongRelations.flat(), "关系强度只能由分享、交换、游戏与共同经历逐次积累。" );
  const sharedClaims = state.agents.flatMap((agent) => agent.mind.cognition.knowledge).filter((claim) => claim.claim.includes("告诉我："));
  const beliefGroups = new Map<string, KnowledgeClaim[]>();
  sharedClaims.forEach((claim) => {
    const content = claim.claim.split("告诉我：").at(-1) ?? claim.claim;
    beliefGroups.set(content, [...(beliefGroups.get(content) ?? []), claim]);
  });
  add("30", "形成共同信仰", [...beliefGroups.values()].filter((claims) => claims.length >= 3).flatMap((claims) => claims.flatMap((claim) => claim.sourceEventIds)), "同一带来源的解释被至少三人接受时，才视为共同信念。" );
  add("31", "驯化动物", state.world.matter.filter((matter) => matter.traits.includes("domesticated")).flatMap((matter) => matter.sourceEventIds ?? []), "动物需要多名人物连续照料后才会稳定留在人群附近。" );
  const cultivation = successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "work" && event.action.intent.change === "cultivate");
  add("32", "栽培作物", cultivation.map((event) => event.id), "田地在获得水以后，人物通过重复照料维持谷物生长。" );
  const settlementEvidence = cultivation.length >= 4 && shelters.length
    ? [...shelters.flatMap((matter) => matter.sourceEventIds ?? []), ...cultivation.map((event) => event.id)]
    : [];
  add("33", "定居村落", settlementEvidence, "完整住所与连续耕作同时存在，显示人物开始长期依赖固定地点。" );
  add("34", "储藏剩余粮食", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "store").map((event) => event.id), "食物必须由人物实际持有并放入已有容器。" );
  add("35", "管理水源", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "work" && event.action.intent.change === "irrigate").map((event) => event.id), "人物开挖后把水引入田地，空间改变有连续行动来源。" );
  add("37", "划定土地与财产", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "claim").map((event) => event.id), "占用主张必须建立在人物对同一对象的持续使用上。" );
  const specializationGroups = new Map<AgentId, Map<string, ActionFact[]>>();
  successfulActions.forEach((event) => {
    const domain = event.action.type === "move" ? null : event.action.intent?.mode === "cook" || event.action.intent?.mode === "ignite" ? "food-fire" : event.action.intent?.mode === "take" && event.diff.edible === true || event.action.intent?.mode === "give" && event.diff.edible === true || event.action.intent?.mode === "eat" ? "provisioning" : event.action.intent?.mode === "work" && (event.action.intent.change === "cultivate" || event.action.intent.change === "irrigate") ? "farming" : event.action.intent?.mode === "shape" || event.action.intent?.mode === "assemble" ? "craft-building" : event.action.intent?.mode === "observe" || event.action.intent?.mode === "record" || event.action.intent?.mode === "predict" ? "knowledge" : null;
    if (!domain) return;
    const domains = specializationGroups.get(event.who) ?? new Map<string, ActionFact[]>();
    domains.set(domain, [...(domains.get(domain) ?? []), event]);
    specializationGroups.set(event.who, domains);
  });
  const domains = [...new Set([...specializationGroups.values()].flatMap((counts) => [...counts.keys()]))];
  const primaryActors = domains.map((domain) => {
    const ranked = [...specializationGroups.entries()]
      .map(([agentId, counts]) => ({ agentId, events: counts.get(domain) ?? [] }))
      .sort((a, b) => b.events.length - a.events.length);
    return ranked[0]?.events.length >= 3 ? { domain, ...ranked[0] } : null;
  }).filter((item): item is { domain: string; agentId: AgentId; events: ActionFact[] } => Boolean(item));
  const distinctPrimaryActors = new Set(primaryActors.map((assignment) => assignment.agentId));
  add("38", "实行专业分工", distinctPrimaryActors.size >= 3 ? primaryActors.flatMap((assignment) => assignment.events.map((event) => event.id)) : [], "至少三类持续活动各自出现不同的主要承担者，分工由群体行为分布事后派生。" );
  add("41", "利用轮具", state.world.matter.filter((matter) => matter.traits.includes("wheel")).flatMap((matter) => matter.sourceEventIds ?? []), "轮具由真实木料和加工工具制成，不是预置科技。" );
  add("42", "开辟道路", state.world.space.routes.filter((route) => route.state === "road").flatMap((route) => route.sourceEventIds), "道路由重复通行磨出，不是预置建筑。" );
  const records = state.world.matter.flatMap((matter) => matter.records ?? []);
  const recordActionIds = (kind: EvidenceRecord["kind"]) => successfulActions.filter((event) => event.diff.recordKind === kind).map((event) => event.id);
  add("44", "绘制地图", [...records.filter((record) => record.kind === "map").flatMap((record) => record.sourceEventIds), ...recordActionIds("map")], "地图需要引用跨地点移动与道路事实，写入真实载体。" );
  const trades = successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "trade");
  add("45", "交换货物", trades.map((event) => event.id), "交换必须由同地双方同时交出不同持有物。" );
  const marketParticipants = new Set(trades.flatMap((event) => [event.who, typeof event.diff.partnerId === "string" ? event.diff.partnerId : ""]).filter(Boolean));
  add("46", "建立市场", trades.length >= 6 && marketParticipants.size >= 3 && trades.filter((event) => event.where === "square").length >= 6 ? trades.map((event) => event.id) : [], "共同空地出现至少三名参与者的重复交换后，才观察为市场。" );
  add("48", "订立契约", [...records.filter((record) => record.kind === "contract").flatMap((record) => record.sourceEventIds), ...recordActionIds("contract")], "契约是把实际交换或主张写入可复查载体的记录。" );
  add("51", "创造文字", [...records.filter((record) => record.kind === "notation").flatMap((record) => record.sourceEventIds), ...recordActionIds("notation")], "稳定符号必须刻在物质载体上，并由多次不同观测支撑。" );
  add("52", "计算数量", [...records.filter((record) => record.kind === "tally").flatMap((record) => record.sourceEventIds), ...recordActionIds("tally")], "计数必须写在真实载体上并引用亲历事实。" );
  add("53", "制定历法", [...records.filter((record) => record.kind === "calendar").flatMap((record) => record.sourceEventIds), ...recordActionIds("calendar")], "历法由至少四次观测和足够推理能力形成。" );
  add("54", "统一度量", [...records.filter((record) => record.kind === "measure").flatMap((record) => record.sourceEventIds), ...recordActionIds("measure")], "度量记录必须比较多次物质数量或交换事实。" );
  add("55", "记录债务与账目", [...records.filter((record) => record.kind === "account").flatMap((record) => record.sourceEventIds), ...recordActionIds("account")], "账目必须引用已经发生的交换、储藏或财产主张。" );
  add("58", "观察自然现象", successfulActions.filter((event) => event.action.type === "interact" && event.action.intent?.mode === "observe").map((event) => event.id), "天象和气候观察是人物的局部行动，不是全知世界信息。" );
  const resolved = state.agents.flatMap((agent) => agent.mind.cognition.hypotheses).filter((hypothesis) => hypothesis.status !== "pending");
  add("59", "用实验检验猜想", resolved.flatMap((hypothesis) => [...hypothesis.sourceEventIds, ...(hypothesis.resolutionEventId ? [hypothesis.resolutionEventId] : [])]), "预测必须等待截止时刻，并由后来的世界事实判定成败。" );
  add("60", "用数学描述世界", [...records.filter((record) => record.kind === "model").flatMap((record) => record.sourceEventIds), ...recordActionIds("model")], "人物用数量、位置和间隔描述机械模型，记录可被后来者复查。" );
  return milestones;
}

function derivedIssues(state: SimulationState, milestones: MilestoneObservation[]): EvolutionIssue[] {
  const issues: EvolutionIssue[] = [];
  const actions = state.world.time.past.filter((event): event is ActionFact => event.kind === "action");
  const failed = actions.filter((event) => !event.succeeded);
  const living = state.agents.filter((agent) => agent.body.state !== "dead");
  const active = living.filter((agent) => agent.body.state === "active");
  if (actions.length >= 10 && failed.length / actions.length > 0.32) issues.push({ id: "failed-actions", severity: "medium", title: "无效行动偏多", evidence: `${failed.length}/${actions.length} 次行动未改变世界，应检查感知与能力约束是否脱节。` });
  if (state.tick >= 8 && milestones.length === 0) issues.push({ id: "stagnation", severity: "medium", title: "演化停滞", evidence: `运行 ${state.tick} 年仍没有形成可追溯里程碑。` });
  if (living.length && active.length / living.length < 0.5) issues.push({ id: "dehydrated-majority", severity: "high", title: "多数个体仍处于脱水", evidence: `${living.length - active.length}/${living.length} 名幸存者尚未被浸泡唤醒。` });
  if (state.civilization.conditions.chaosIntensity >= 4 && state.tick >= 6 && !milestones.some((item) => item.id === "15")) issues.push({ id: "no-disaster-adaptation", severity: "high", title: "尚未形成灾害适应", evidence: "乱纪元已造成持续暴露，但历史中没有成功的脱水或浸泡事实。" });
  const sharedClaims = state.agents.flatMap((agent) => agent.mind.cognition.knowledge).filter((claim) => claim.claim.includes("告诉我"));
  const privateClaims = state.agents.flatMap((agent) => agent.mind.cognition.knowledge);
  if (privateClaims.length >= 6 && sharedClaims.length === 0) issues.push({ id: "knowledge-islands", severity: "low", title: "知识仍是孤岛", evidence: `已有 ${privateClaims.length} 条个人认识，但尚无带来源的传授事实。` });
  const hypotheses = state.agents.flatMap((agent) => agent.mind.cognition.hypotheses);
  const resolved = hypotheses.filter((hypothesis) => hypothesis.status !== "pending");
  const failedPredictions = resolved.filter((hypothesis) => hypothesis.status === "failed");
  if (resolved.length >= 2 && failedPredictions.length / resolved.length >= 0.5) issues.push({ id: "prediction-failure", severity: "high", title: "天象预测可靠性不足", evidence: `${failedPredictions.length}/${resolved.length} 个到期预测与世界事实不符；应扩展观测或改进模型，而不是把历法当成真理。` });
  const observations = actions.filter((event) => event.succeeded && event.action.type === "interact" && event.action.intent?.mode === "observe");
  const records = state.world.matter.flatMap((matter) => matter.records ?? []);
  if (observations.length >= 6 && records.length === 0) issues.push({ id: "unrecorded-observations", severity: "medium", title: "观测没有形成外部记录", evidence: `已有 ${observations.length} 次自然观察，但没有保存到物质载体，知识仍依赖个人记忆。` });
  return issues;
}

function civilizationStage(state: SimulationState, milestones: MilestoneObservation[]) {
  const ids = new Set(milestones.map((item) => item.id));
  if (ids.has("46") && ids.has("54") && ids.has("55")) return "度量市场文明";
  if (ids.has("60") && ids.has("24")) return "东汉数理文明";
  if (ids.has("59") && state.world.matter.some((matter) => matter.traits.includes("instrument"))) return "诸子机械文明";
  if (ids.has("53") && ids.has("58")) return "战国历法文明";
  if (ids.has("52") && ids.has("58")) return "早期记录文明";
  if (ids.has("38") && ids.has("33")) return "分工定居文明";
  if (ids.has("42") && ids.has("22") && state.derived.institutions.length) return "早期城邦";
  if (ids.has("42")) return "道路聚落";
  if (ids.has("20")) return "定居村落";
  if (ids.has("16")) return "石器聚落";
  return "生存聚落";
}

function deriveObservations(state: SimulationState) {
  const groups = new Map<string, ActionFact[]>();
  for (const event of state.world.time.past) {
    if (event.kind !== "action" || !event.succeeded) continue;
    const key = actionKey(event.action);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const practices = [...groups.entries()].filter(([, facts]) => facts.length >= 2).map(([key, facts]) => {
    const agents = [...new Set(facts.map((event) => event.who))];
    return { key, label: actionLabel(facts[0].action, state), count: facts.length, agentIds: agents, eventIds: facts.map((event) => event.id), stability: Math.min(100, Math.round(facts.length * 12 + agents.length * 14)) };
  }).sort((a, b) => b.count - a.count);
  const institutions = practices.filter((item) => item.count >= 6 && item.agentIds.length >= 3).map((item) => ({ key: item.key, label: `${item.label} · 稳定共同实践`, evidenceEventIds: item.eventIds, note: "这是观察者对重复事实的标记，不是世界写死的规则。" }));
  const milestones = derivedMilestones(state);
  const issues = derivedIssues(state, milestones);
  return { practices, institutions, milestones, issues };
}

function validateInputs(state: SimulationState, agentId: AgentId, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 4);
  const items = unique.map((id) => carried(state, agentId).find((matter) => matter.id === id)).filter((item): item is MatterState => Boolean(item));
  return items.length === unique.length ? items : [];
}
type Outcome = { succeeded: boolean; result: string; diff: Record<string, number | string | boolean> };
function shapeMatter(state: SimulationState, agent: AgentState, intent: Extract<InteractionIntent, { mode: "shape" }>, eventId: string): Outcome {
  const inputs = validateInputs(state, agent.id, intent.inputIds);
  if (!inputs.length) return { succeeded: false, result: "缺少要加工的输入物", diff: {} };
  const tool = carried(state, agent.id).find((item) => item.traits.includes("cutting"));
  const handWeavable = inputs.every((item) => item.traits.includes("fiber")) && Boolean(intent.desiredTraits?.some((trait) => trait === "container" || trait === "wearable" || trait === "barrier"));
  if ((!tool && !handWeavable) || agent.limbs.abilities.craft < 55) return { succeeded: false, result: "现有材料、工具或加工能力不足", diff: {} };
  const portions = inputs.map((matter) => ({ matter, quantity: 1 }));
  const mass = portions.reduce((sum, item) => sum + item.matter.unitMass, 0);
  const composition = totalComposition(portions);
  const inherited = new Set<MatterTrait>(inputs.flatMap((item) => item.traits.filter((trait) => ["rigid", "building", "edible", "fiber"].includes(trait))));
  if (intent.desiredTraits?.includes("recordable")) inherited.delete("building");
  inherited.add("crafted");
  for (const trait of intent.desiredTraits ?? []) if (["flat", "sharp", "building", "recordable", "instrument", "wearable", "container", "wheel", "supportive", "barrier"].includes(trait)) inherited.add(trait);
  if (inherited.has("sharp") && inherited.has("rigid")) inherited.add("cutting");
  inputs.forEach((item) => removeMatter(state, item, 1));
  const kind = safeText(intent.desiredKind, "crafted-object", 30).toLowerCase().replace(/\s+/g, "-");
  const name = safeText(intent.desiredName, "新制物品");
  mergeMatter(state, { id: `${kind}-${eventId}`, kind, name, holder: { kind: "agent", id: agent.id }, quantity: 1, unitMass: mass, composition, traits: [...inherited], madeBy: agent.id, sourceEventIds: [eventId] });
  agent.limbs.abilities.craft = clamp(agent.limbs.abilities.craft + 2);
  return { succeeded: true, result: `${agent.name}把${inputs.map((item) => item.name).join("、")}加工成了“${name}”`, diff: { created: name, mass } };
}
function assembleMatter(state: SimulationState, agent: AgentState, intent: Extract<InteractionIntent, { mode: "assemble" }>, eventId: string): Outcome {
  if (agent.locationId !== intent.siteId || agent.limbs.abilities.build < 50) return { succeeded: false, result: "人物不在建设地点或建设能力不足", diff: {} };
  const site = location(state, intent.siteId);
  if (!site || site.terrain.cleared < 25) return { succeeded: false, result: "地面尚不足以承载结构", diff: {} };
  const inputs = validateInputs(state, agent.id, intent.inputIds).filter((item) => item.traits.includes("building") || item.traits.includes("rigid"));
  if (!inputs.length) return { succeeded: false, result: "缺少可承重或连接的材料", diff: {} };
  const portions = inputs.map((matter) => ({ matter, quantity: 1 }));
  const addedMass = portions.reduce((sum, item) => sum + item.matter.unitMass, 0);
  const desiredKind = safeText(intent.desiredKind, "structure", 30).toLowerCase().replace(/\s+/g, "-");
  const desiredName = safeText(intent.desiredName, "未命名结构");
  const arrangement = {
    support: clamp(intent.arrangement?.support ?? (intent.purpose === "shelter" ? 70 : 55)),
    cover: clamp(intent.arrangement?.cover ?? (intent.purpose === "shelter" ? 75 : 30)),
    boundary: clamp(intent.arrangement?.boundary ?? (intent.purpose === "shelter" ? 65 : 25)),
    opening: clamp(intent.arrangement?.opening ?? (intent.purpose === "shelter" ? 35 : 70)),
  };
  let structure = state.world.matter.find((item) => item.kind === desiredKind && item.holder.kind === "space" && item.holder.id === intent.siteId && item.construction);
  inputs.forEach((item) => removeMatter(state, item, 1));
  if (!structure) {
    structure = { id: `${desiredKind}-${intent.siteId}-${eventId}`, kind: desiredKind, name: desiredName, holder: { kind: "space", id: intent.siteId }, quantity: 1, unitMass: 0, composition: {}, traits: ["structure"], madeBy: agent.id, sourceEventIds: [], construction: { progress: 0, requiredMass: intent.purpose === "shelter" ? 4 : 3, complete: false, purpose: intent.purpose, arrangement, useEventIds: [] } };
    state.world.matter.push(structure);
  }
  structure.construction!.purpose ??= intent.purpose;
  structure.construction!.arrangement ??= arrangement;
  const addition = totalComposition(portions);
  for (const [substance, amount] of Object.entries(addition)) structure.composition[substance] = (structure.composition[substance] ?? 0) + amount;
  structure.unitMass += addedMass;
  structure.construction!.progress += addedMass;
  structure.sourceEventIds!.push(eventId);
  if (structure.construction!.progress >= structure.construction!.requiredMass) {
    structure.construction!.complete = true;
    const layout = structure.construction!.arrangement ?? arrangement;
    const rigidMass = (structure.composition.wood ?? 0) + (structure.composition.stone ?? 0) + (structure.composition.bone ?? 0);
    const fiberMass = structure.composition.fiber ?? 0;
    const structuralStability = clamp(rigidMass * 18 + layout.support * 0.55);
    const weatherProtection = clamp(layout.cover * 0.62 + layout.boundary * 0.28 + Math.min(20, rigidMass * 4 + fiberMass * 3) - Math.max(0, layout.opening - 45) * 0.25);
    const thermalInsulation = clamp(layout.boundary * 0.42 + fiberMass * 9 + (structure.composition.wood ?? 0) * 3 - layout.opening * 0.12);
    const enclosure = clamp(layout.boundary * 0.72 + layout.cover * 0.18 - layout.opening * 0.18);
    structure.construction!.effects = { structuralStability, weatherProtection, thermalInsulation, enclosure, capacity: Math.max(1, Math.floor(structure.unitMass / 2)) };
    if (weatherProtection >= 58 && structuralStability >= 55 && !structure.traits.includes("shelter")) structure.traits.push("shelter");
    if (structure.construction!.purpose === "instrument" && structuralStability >= 45 && !structure.traits.includes("instrument")) structure.traits.push("instrument");
  }
  agent.limbs.abilities.build = clamp(agent.limbs.abilities.build + 2);
  const progress = Math.min(100, Math.round(structure.construction!.progress / structure.construction!.requiredMass * 100));
  const justCompleted = structure.construction!.progress - addedMass < structure.construction!.requiredMass && structure.construction!.complete;
  return {
    succeeded: true,
    result: justCompleted
      ? `${agent.name}接上${inputs.map((item) => item.name).join("、")}，“${structure.name}”终于完工，可以遮风避雨了`
      : structure.construction!.complete
        ? `${agent.name}用${inputs.map((item) => item.name).join("、")}加固了“${structure.name}”`
        : `${agent.name}把${inputs.map((item) => item.name).join("、")}接到“${structure.name}”上，完成了 ${progress}%`,
    diff: { structure: structure.name, progress, complete: structure.construction!.complete, weatherProtection: structure.construction!.effects?.weatherProtection ?? 0 },
  };
}
function interact(state: SimulationState, agent: AgentState, action: InteractAction, eventId: string): Outcome {
  const intent = action.intent;
  if (!intent) return { succeeded: false, result: "交互只有语言描述，没有可裁决的改变意图", diff: {} };
  if (intent.mode === "take") {
    const matter = matterAt(state, agent.locationId).find((item) => item.id === intent.matterId);
    if (!matter) return { succeeded: false, result: "目标物质并不在这里", diff: {} };
    const quantity = Math.max(1, Math.min(matter.quantity, intent.quantity ?? 1));
    const portion = clone(matter);
    const portableUnitMass = matter.traits.includes("recordable") && matter.kind === "clay" ? 0.25 : matter.unitMass;
    const addedMass = portableUnitMass * quantity;
    if (carryingMass(state, agent.id) + addedMass > 30) return { succeeded: false, result: "随身负重已经无法再携带这份材料", diff: {} };
    removeMatter(state, matter, quantity);
    mergeMatter(state, { ...portion, id: `${portion.kind}-${agent.id}-${eventId}`, holder: { kind: "agent", id: agent.id }, quantity, unitMass: portableUnitMass, sourceEventIds: [...(portion.sourceEventIds ?? []), eventId] });
    return { succeeded: true, result: `${agent.name}从${locationName(state, agent.locationId)}拿了${quantity > 1 ? `${quantity}份` : "一份"}${portion.name}`, diff: { transfer: `space:${agent.locationId}→agent:${agent.id}`, quantity, edible: portion.traits.includes("edible") } };
  }
  if (intent.mode === "give") {
    const matter = carried(state, agent.id).find((item) => item.id === intent.matterId);
    const other = state.agents.find((item) => item.id === intent.toAgentId && item.locationId === agent.locationId);
    if (!matter || !other) return { succeeded: false, result: "物质或接收者不在交互范围内", diff: {} };
    const quantity = Math.max(1, Math.min(matter.quantity, intent.quantity ?? 1));
    removeMatter(state, matter, quantity);
    mergeMatter(state, { ...clone(matter), id: `${matter.kind}-${other.id}-${eventId}`, holder: { kind: "agent", id: other.id }, quantity, sourceEventIds: [...(matter.sourceEventIds ?? []), eventId] });
    strengthenRelation(agent, other, eventId, matter.traits.includes("edible") ? 5 : 3);
    const supportedEndOfLife = Boolean(other.body.endOfLife && matter.traits.includes("edible"));
    if (supportedEndOfLife && other.body.endOfLife) {
      other.body.endOfLife.supportEventIds = [...new Set([...other.body.endOfLife.supportEventIds, eventId])];
      other.body.endOfLife.supportAgentIds = [...new Set([...other.body.endOfLife.supportAgentIds, agent.id])];
      if (other.body.endOfLife.lastSupportedTick !== state.tick + 1) other.body.endOfLife.comfortYears += 1;
      other.body.endOfLife.lastSupportedTick = state.tick + 1;
      other.body.nutrition = clamp(other.body.nutrition + 18);
      other.body.fatigue = clamp(other.body.fatigue - 6);
    }
    return { succeeded: true, result: `${agent.name}把${quantity > 1 ? `${quantity}份` : "一份"}${matter.name}${matter.traits.includes("edible") ? "分给了" : "交给了"}${other.name}`, diff: { transfer: `agent:${agent.id}→agent:${other.id}`, quantity, edible: matter.traits.includes("edible"), supportedEndOfLife, targetAgentId: supportedEndOfLife ? other.id : "", endOfLifeSourceEventIds: supportedEndOfLife ? [...(other.body.endOfLife?.sourceEventIds ?? [])] : [], comfortYears: other.body.endOfLife?.comfortYears ?? 0 } };
  }
  if (intent.mode === "ignite") {
    const fuel = matterAt(state, agent.locationId).find((matter) => matter.id === intent.fuelId && matter.traits.includes("fuel"));
    if (!fuel || !hasTrait(state, agent.id, "cutting") || agent.limbs.abilities.craft < 60) return { succeeded: false, result: "缺少同地燃料、石器或点火能力", diff: {} };
    removeMatter(state, fuel, 1);
    mergeMatter(state, { ...clone(fuel), id: `fire-${eventId}`, kind: "fire", name: "火种", holder: { kind: "space", id: agent.locationId }, quantity: 1, traits: ["crafted", "burning"], madeBy: agent.id, sourceEventIds: [...(fuel.sourceEventIds ?? []), eventId] });
    agent.limbs.abilities.craft = clamp(agent.limbs.abilities.craft + 2);
    return { succeeded: true, result: `${agent.name}用石器点燃了${fuel.name}，保住了一簇火`, diff: { fire: true, fuel: fuel.name } };
  }
  if (intent.mode === "cook") {
    const food = carried(state, agent.id).find((matter) => matter.id === intent.foodId && matter.traits.includes("edible") && !matter.traits.includes("cooked"));
    const fire = matterAt(state, agent.locationId).find((matter) => matter.id === intent.fireId && matter.traits.includes("burning"));
    if (!food || !fire || agent.limbs.abilities.craft < 55) return { succeeded: false, result: "食物、火种或烹饪能力不足", diff: {} };
    removeMatter(state, food, 1);
    mergeMatter(state, { ...clone(food), id: `meal-${eventId}`, kind: "meal", name: "热食", holder: { kind: "agent", id: agent.id }, quantity: 1, traits: [...new Set([...food.traits.filter((trait) => trait !== "raw"), "crafted", "cooked"])] as MatterTrait[], madeBy: agent.id, sourceEventIds: [...(food.sourceEventIds ?? []), fire.id, eventId] });
    agent.limbs.abilities.craft = clamp(agent.limbs.abilities.craft + 2);
    return { succeeded: true, result: `${agent.name}借助${fire.name}把${food.name}烹成热食`, diff: { cooked: true, food: food.name, fireId: fire.id } };
  }
  if (intent.mode === "eat") {
    const food = carried(state, agent.id).find((matter) => matter.id === intent.foodId && matter.traits.includes("edible"));
    if (!food) return { succeeded: false, result: "没有可食用的持有物", diff: {} };
    const foodName = food.name;
    const gain = food.traits.includes("cooked") ? 34 : 24;
    agent.body.nutrition = clamp(agent.body.nutrition + gain);
    food.traits = [...new Set([...food.traits.filter((trait) => trait !== "edible"), "crafted"])] as MatterTrait[];
    food.kind = "metabolized";
    food.name = "已吸收的养分";
    food.sourceEventIds = [...(food.sourceEventIds ?? []), eventId];
    return { succeeded: true, result: `${agent.name}吃下了${foodName}，营养恢复到 ${agent.body.nutrition}`, diff: { eaten: true, nutritionGain: gain } };
  }
  if (intent.mode === "hunt") {
    const animal = matterAt(state, agent.locationId).find((matter) => matter.id === intent.animalId && matter.traits.includes("animal") && !matter.traits.includes("domesticated"));
    if (!animal || !hasTrait(state, agent.id, "cutting") || agent.limbs.abilities.craft < 58) return { succeeded: false, result: "缺少可捕猎动物、工具或行动能力", diff: {} };
    removeMatter(state, animal, 1);
    const sourceEventIds = [...(animal.sourceEventIds ?? []), eventId];
    mergeMatter(state, baseMatter(`meat-${eventId}`, "meat", "生肉", { kind: "agent", id: agent.id }, 3, 1, { biomass: 1 }, ["raw", "edible"]));
    mergeMatter(state, { ...baseMatter(`hide-${eventId}`, "hide", "兽皮", { kind: "agent", id: agent.id }, 1, 1, { biomass: 1 }, ["raw", "fiber"]), sourceEventIds });
    mergeMatter(state, { ...baseMatter(`bone-${eventId}`, "bone", "兽骨", { kind: "agent", id: agent.id }, 1, 1, { bone: 1 }, ["raw", "rigid"]), sourceEventIds });
    const meat = carried(state, agent.id).find((matter) => matter.kind === "meat");
    if (meat) meat.sourceEventIds = [...new Set([...(meat.sourceEventIds ?? []), ...sourceEventIds])];
    return { succeeded: true, result: `${agent.name}借助工具捕获一只${animal.name}，得到生肉、兽皮和兽骨`, diff: { hunted: animal.kind, meat: 3, hide: 1, bone: 1 } };
  }
  if (intent.mode === "tend") {
    const animal = matterAt(state, agent.locationId).find((matter) => matter.id === intent.animalId && matter.traits.includes("animal"));
    const offering = carried(state, agent.id).find((matter) => matter.id === intent.offeringId && matter.traits.includes("edible"));
    if (!animal || !offering) return { succeeded: false, result: "动物或可用食物不在身边", diff: {} };
    removeMatter(state, offering, 1);
    mergeMatter(state, { ...clone(offering), id: `animal-feed-${eventId}`, kind: "animal-feed", name: "被动物摄取的食物", holder: { kind: "space", id: agent.locationId }, quantity: 1, traits: ["crafted"], sourceEventIds: [...(offering.sourceEventIds ?? []), eventId] });
    const priorTenders = new Set(state.world.time.past.filter((event): event is ActionFact => event.kind === "action" && event.succeeded && event.action.type === "interact" && event.action.intent?.mode === "tend" && event.action.intent.animalId === animal.id).map((event) => event.who));
    priorTenders.add(agent.id);
    animal.sourceEventIds = [...new Set([...(animal.sourceEventIds ?? []), eventId])];
    if (animal.sourceEventIds.length >= 3 && priorTenders.size >= 2 && !animal.traits.includes("domesticated")) animal.traits.push("domesticated");
    return { succeeded: true, result: `${agent.name}拿${offering.name}喂了${animal.name}${animal.traits.includes("domesticated") ? "，它已经愿意留在人群附近" : ""}`, diff: { tendedAnimal: animal.kind, domesticated: animal.traits.includes("domesticated") } };
  }
  if (intent.mode === "store") {
    const food = carried(state, agent.id).find((matter) => matter.id === intent.matterId && matter.traits.includes("edible") && !matter.traits.includes("stored"));
    const container = [...carried(state, agent.id), ...matterAt(state, agent.locationId)].find((matter) => matter.id === intent.containerId && matter.traits.includes("container"));
    if (!food || !container) return { succeeded: false, result: "缺少未储藏食物或容器", diff: {} };
    removeMatter(state, food, 1);
    mergeMatter(state, { ...clone(food), id: `stored-${food.kind}-${eventId}`, quantity: 1, traits: [...new Set([...food.traits, "stored"])] as MatterTrait[], storedIn: container.id, sourceEventIds: [...(food.sourceEventIds ?? []), eventId] });
    return { succeeded: true, result: `${agent.name}把一份${food.name}收入${container.name}，留作以后使用`, diff: { stored: food.kind, containerId: container.id } };
  }
  if (intent.mode === "perform") {
    const partner = intent.partnerId ? state.agents.find((other) => other.id === intent.partnerId && other.locationId === agent.locationId) : undefined;
    const medium = intent.mediumId ? [...carried(state, agent.id), ...matterAt(state, agent.locationId)].find((matter) => matter.id === intent.mediumId && matter.traits.includes("recordable")) : undefined;
    if ((intent.form === "game" || intent.form === "dance") && !partner) return { succeeded: false, result: "这种活动需要身边另一人参与", diff: {} };
    if (intent.form === "image" && !medium) return { succeeded: false, result: "描绘形象需要可留下痕迹的载体", diff: {} };
    if (medium && intent.form === "image") {
      const record: EvidenceRecord = { id: `r-${state.tick + 1}-${agent.id}-${medium.records?.length ?? 0}`, kind: "image", authorId: agent.id, createdTick: state.tick + 1, sourceEventIds: [eventId], note: `描绘${locationName(state, agent.locationId)}与身边事物的形象` };
      medium.records = [...(medium.records ?? []), record];
      medium.sourceEventIds = [...new Set([...(medium.sourceEventIds ?? []), eventId])];
    }
    if (partner) strengthenRelation(agent, partner, eventId, intent.form === "game" ? 5 : 3);
    const formLabel = intent.form === "image" ? "描绘形象" : intent.form === "music" ? "敲击与哼唱出节奏" : intent.form === "dance" ? `与${partner?.name}按节奏舞动` : `与${partner?.name}进行规则游戏`;
    return { succeeded: true, result: `${agent.name}${formLabel}`, diff: { performance: intent.form, partnerId: partner?.id ?? "", mediumId: medium?.id ?? "" } };
  }
  if (intent.mode === "claim") {
    const localSubject = intent.subjectId === agent.locationId || matterAt(state, agent.locationId).some((matter) => matter.id === intent.subjectId);
    if (!localSubject) return { succeeded: false, result: "无法对远处或不存在的对象提出占用主张", diff: {} };
    return { succeeded: true, result: `${agent.name}当众声称：“${safeText(intent.claim, "我持续照料并使用这里", 72)}”`, diff: { propertyClaim: intent.subjectId, claim: safeText(intent.claim, "持续使用", 72) } };
  }
  if (intent.mode === "trade") {
    const other = state.agents.find((item) => item.id === intent.withAgentId && item.locationId === agent.locationId);
    const offered = carried(state, agent.id).find((matter) => matter.id === intent.offeredMatterId && !matter.traits.includes("cutting"));
    const requested = other ? carried(state, other.id).find((matter) => matter.id === intent.requestedMatterId && !matter.traits.includes("cutting")) : undefined;
    if (!other || !offered || !requested || offered.kind === requested.kind) return { succeeded: false, result: "交换双方或两种不同货物不在同一地点", diff: {} };
    removeMatter(state, offered, 1);
    removeMatter(state, requested, 1);
    mergeMatter(state, { ...clone(offered), id: `${offered.kind}-${other.id}-${eventId}`, holder: { kind: "agent", id: other.id }, quantity: 1, sourceEventIds: [...(offered.sourceEventIds ?? []), eventId] });
    mergeMatter(state, { ...clone(requested), id: `${requested.kind}-${agent.id}-${eventId}`, holder: { kind: "agent", id: agent.id }, quantity: 1, sourceEventIds: [...(requested.sourceEventIds ?? []), eventId] });
    strengthenRelation(agent, other, eventId, 6);
    return { succeeded: true, result: `${agent.name}与${other.name}交换了${offered.name}和${requested.name}`, diff: { trade: true, offered: offered.kind, requested: requested.kind, partnerId: other.id } };
  }
  if (intent.mode === "relocate") {
    if (intent.to !== agent.locationId || intent.to === agent.body.homeLocationId) return { succeeded: false, result: "迁居地点必须是人物已经抵达的新地点", diff: {} };
    const from = agent.body.homeLocationId;
    agent.body.homeLocationId = intent.to;
    return { succeeded: true, result: `${agent.name}把生活中心从${locationName(state, from)}迁到${locationName(state, intent.to)}`, diff: { relocated: true, from, to: intent.to } };
  }
  if (intent.mode === "drink") {
    const source = matterAt(state, agent.locationId).find((matter) => matter.id === intent.sourceId && matter.kind === "water-source");
    if (!source) return { succeeded: false, result: "这里没有可饮用水源", diff: {} };
    const before = agent.body.hydration;
    agent.body.hydration = clamp(agent.body.hydration + 42);
    return { succeeded: true, result: `${agent.name}在水源边饮水，身体水分从 ${Math.round(before)} 恢复到 ${Math.round(agent.body.hydration)}`, diff: { drank: true, hydrationGain: agent.body.hydration - before } };
  }
  if (intent.mode === "rest") {
    if (intent.siteId !== agent.locationId) return { succeeded: false, result: "无法在远处休息", diff: {} };
    const shelter = state.world.matter.find((matter) => matter.holder.kind === "space" && matter.holder.id === agent.locationId && matter.construction?.complete && (matter.construction.effects?.weatherProtection ?? 0) >= 58);
    const sheltered = Boolean(shelter);
    if (shelter?.construction) shelter.construction.useEventIds = [...new Set([...(shelter.construction.useEventIds ?? []), eventId])];
    const recovery = sheltered ? 46 : 28;
    const before = agent.body.fatigue;
    agent.body.fatigue = clamp(agent.body.fatigue - recovery);
    agent.body.health = clamp(agent.body.health + (sheltered ? 4 : 2));
    return { succeeded: true, result: `${agent.name}${sheltered ? `在${shelter!.name}中` : "就地"}休息，疲劳从 ${Math.round(before)} 降到 ${Math.round(agent.body.fatigue)}`, diff: { rested: true, fatigueRecovery: before - agent.body.fatigue, sheltered, shelterId: shelter?.id ?? "" } };
  }
  if (intent.mode === "warm") {
    const fire = matterAt(state, agent.locationId).find((matter) => matter.id === intent.fireId && matter.traits.includes("burning"));
    if (!fire || agent.body.temperature >= 48) return { succeeded: false, result: "没有同地火种或身体并不寒冷", diff: {} };
    const before = agent.body.temperature;
    agent.body.temperature = clamp(agent.body.temperature + 24);
    agent.body.exposure = Math.max(0, agent.body.exposure - 5);
    return { succeeded: true, result: `${agent.name}靠近火种取暖，体温从 ${Math.round(before)} 回升到 ${Math.round(agent.body.temperature)}`, diff: { warmed: true, temperatureGain: agent.body.temperature - before } };
  }
  if (intent.mode === "inspect-body") {
    const target = state.agents.find((item) => item.id === intent.targetAgentId && item.locationId === agent.locationId && item.body.state === "active");
    if (!target || (!target.body.illness && !target.body.injury)) return { succeeded: false, result: "身边没有可辨认的身体异常", diff: {} };
    const signs = [target.body.injury ? `${target.body.injury.kind === "cut" ? "割伤" : target.body.injury.kind === "fall" ? "跌伤" : "咬伤"}、出血 ${target.body.injury.bleeding}` : "", target.body.illness ? `${target.body.illness.kind === "fever" ? "热病" : "伤口感染"}、病情 ${target.body.illness.severity}` : ""].filter(Boolean);
    const sourceEventIds = [...new Set([...(target.body.injury?.sourceEventIds ?? []), ...(target.body.illness?.sourceEventIds ?? [])])];
    if (target.body.injury) target.body.injury.examinedAtTick = state.tick + 1;
    if (target.body.illness) target.body.illness.examinedAtTick = state.tick + 1;
    agent.limbs.abilities.observe = clamp(agent.limbs.abilities.observe + 2);
    return { succeeded: true, result: `${agent.name}比较${target.name}的疼痛、体温和伤口，辨认出${signs.join("并伴有")}`, diff: { examinedAbnormality: true, targetAgentId: target.id, injuryKind: target.body.injury?.kind ?? "", illnessKind: target.body.illness?.kind ?? "", bleeding: target.body.injury?.bleeding ?? 0, severity: target.body.illness?.severity ?? target.body.injury?.severity ?? 0, sourceEventIds } };
  }
  if (intent.mode === "apply-material") {
    const target = state.agents.find((item) => item.id === intent.targetAgentId && item.locationId === agent.locationId && item.body.state === "active");
    const material = [...carried(state, agent.id), ...matterAt(state, agent.locationId)].find((matter) => matter.id === intent.matterId && matter.quantity >= 1);
    if (!target || !material) return { succeeded: false, result: "对象或材料不在身边", diff: {} };
    if (material.kind === "water-source" && target.body.surfaceLoad > 0) {
      const before = target.body.surfaceLoad;
      target.body.surfaceLoad = Math.max(0, target.body.surfaceLoad - 7);
      return { succeeded: true, result: `${agent.name}用${material.name}冲洗${target.id === agent.id ? "自己" : target.name}的身体表面，附着量由 ${Math.round(before)} 降到 ${Math.round(target.body.surfaceLoad)}`, diff: { appliedMaterial: material.kind, targetAgentId: target.id, cleanedBody: true, surfaceLoadBefore: before, surfaceLoadAfter: target.body.surfaceLoad, waterSourceId: material.id } };
    }
    if (material.bodyEffect) {
      const used = clone(material);
      removeMatter(state, material, 1);
      const illnessBefore = target.body.illness?.severity ?? 0;
      const strainBefore = target.mind.affect.strain;
      const healthBefore = target.body.health;
      const priorAdaptation = target.body.adaptation?.materialKind === material.kind ? target.body.adaptation : undefined;
      const tolerance = priorAdaptation?.level ?? 0;
      const effectScale = Math.max(0.2, 1 - tolerance * 0.16);
      const illnessReduction = Math.floor((target.body.illness?.kind === "fever" ? material.bodyEffect.fever ?? 0 : target.body.illness?.kind === "wound-infection" ? material.bodyEffect.woundInfection ?? 0 : 0) * effectScale);
      if (target.body.illness && illnessReduction > 0) {
        const severityFloor = target.body.illness.course === "persistent" ? 1 : 0;
        target.body.illness.severity = Math.max(severityFloor, target.body.illness.severity - illnessReduction);
        target.body.illness.sourceEventIds = [...new Set([...target.body.illness.sourceEventIds, eventId])];
        if (target.body.illness.severity <= 0) delete target.body.illness;
      }
      target.mind.affect.strain = clamp(target.mind.affect.strain - Math.round((material.bodyEffect.strain ?? 0) * effectScale));
      const toxicity = material.bodyEffect.toxicity ?? 0;
      const toxicReaction = toxicity > 0 && deterministicFraction(state.seed, `material-reaction:${eventId}:${target.id}:${material.kind}`) < toxicity;
      if (toxicReaction) {
        target.body.health = clamp(target.body.health - 7);
        target.mind.affect.strain = clamp(target.mind.affect.strain + 5);
      }
      const illnessAfter = target.body.illness?.severity ?? 0;
      const strainAfter = target.mind.affect.strain;
      const healthAfter = target.body.health;
      const beneficial = illnessAfter < illnessBefore || strainAfter < strainBefore;
      const harmful = healthAfter < healthBefore || strainAfter > strainBefore;
      const effect = beneficial && !harmful ? "beneficial" : harmful ? "harmful" : "neutral";
      if ((material.bodyEffect.adaptation ?? 0) > 0) {
        const consecutive = priorAdaptation && state.tick + 1 - priorAdaptation.lastUseTick <= 2 ? priorAdaptation.consecutiveUses + 1 : 1;
        const levelGain = consecutive >= 2 ? material.bodyEffect.adaptation ?? 0 : (material.bodyEffect.adaptation ?? 0) * 0.35;
        target.body.adaptation = {
          materialKind: material.kind,
          level: clamp((priorAdaptation?.level ?? 0) + levelGain, 0, 8),
          consecutiveUses: consecutive,
          lastUseTick: state.tick + 1,
          sourceEventIds: [...new Set([...(priorAdaptation?.sourceEventIds ?? []), eventId])],
          withdrawalEventIds: priorAdaptation?.withdrawalEventIds ?? [],
          supportEventIds: priorAdaptation?.supportEventIds ?? [],
          supportedYears: priorAdaptation?.supportedYears ?? 0,
        };
      }
      mergeMatter(state, { ...used, id: `applied-${target.id}-${eventId}`, kind: "applied-botanical", name: `${target.name}使用后的植物残留`, holder: { kind: "agent", id: target.id }, quantity: 1, traits: ["crafted"], madeBy: agent.id, sourceEventIds: [...(used.sourceEventIds ?? []), eventId], bodyEffect: undefined });
      const claimText = effect === "beneficial" ? `${used.name}作用后${illnessAfter < illnessBefore ? "病情" : "精神负荷"}下降` : effect === "harmful" ? `${used.name}作用后身体状态变差` : `${used.name}作用后没有看见明显改善`;
      learn(agent, claimText, effect === "beneficial" ? 68 : 56, eventId, "material-body-effect", used.sourceEventIds ?? []);
      const learned = agent.mind.cognition.knowledge.find((claim) => claim.claim === claimText);
      if (learned) {
        learned.subjectKind = used.kind;
        learned.observedEffect = effect;
      }
      strengthenRelation(agent, target, eventId, effect === "beneficial" ? 9 : 2);
      if (effect === "beneficial") agent.standing.careTrust = clamp((agent.standing.careTrust ?? 0) + 5);
      return {
        succeeded: true,
        result: `${agent.name}把${used.name}用于${target.name}并观察前后变化；${claimText}`,
        diff: { appliedMaterial: used.kind, materialName: used.name, botanicalMaterial: used.traits.includes("botanical"), targetAgentId: target.id, materialBodyEffect: effect, illnessKind: target.body.illness?.kind ?? "", illnessBefore, illnessAfter, strainBefore, strainAfter, healthBefore, healthAfter, toxicReaction, toleranceBefore: tolerance, toleranceAfter: target.body.adaptation?.materialKind === used.kind ? target.body.adaptation.level : 0, consecutiveUses: target.body.adaptation?.materialKind === used.kind ? target.body.adaptation.consecutiveUses : 0, adaptationPotential: (used.bodyEffect?.adaptation ?? 0) > 0, materialSourceEventIds: used.sourceEventIds ?? [] },
      };
    }
    if (!target.body.injury?.bleeding || !material.traits.includes("fiber")) return { succeeded: false, result: `${material.name}作用于当前身体状态没有产生可见改善`, diff: { appliedMaterial: material.kind, targetAgentId: target.id } };
    const dressing = clone(material);
    removeMatter(state, material, 1);
    const before = target.body.injury.bleeding;
    const reduction = Math.max(1, Math.min(before, 1 + Math.floor(agent.limbs.abilities.interact / 45)));
    const injurySourceEventIds = [...target.body.injury.sourceEventIds];
    target.body.injury.bleeding = Math.max(0, before - reduction);
    target.body.injury.sourceEventIds = [...new Set([...target.body.injury.sourceEventIds, eventId])];
    mergeMatter(state, { ...dressing, id: `applied-${target.id}-${eventId}`, kind: "applied-fiber", name: `${target.name}身体上的纤维`, holder: { kind: "agent", id: target.id }, quantity: 1, traits: ["crafted", "fiber"], madeBy: agent.id, sourceEventIds: [...(dressing.sourceEventIds ?? []), ...injurySourceEventIds, eventId] });
    strengthenRelation(agent, target, eventId, 8);
    return { succeeded: true, result: `${agent.name}把${material.name}按在${target.name}疼痛处，液体流失由 ${before} 降到 ${target.body.injury.bleeding}`, diff: { appliedMaterial: material.kind, targetAgentId: target.id, bleedingBefore: before, bleedingAfter: target.body.injury.bleeding, stoppedBleeding: target.body.injury.bleeding === 0, materialId: dressing.id, injurySourceEventIds } };
  }
  if (intent.mode === "treat") {
    const patient = state.agents.find((item) => item.id === intent.toAgentId && item.locationId === agent.locationId && item.body.state === "active");
    if (!patient?.body.illness) return { succeeded: false, result: "身边没有仍在患病的照护对象", diff: {} };
    const food = [...carried(state, agent.id), ...matterAt(state, agent.locationId)].find((matter) => matter.traits.includes("edible") && matter.quantity >= 1);
    const waterAvailable = agent.locationId === "river" || matterAt(state, agent.locationId).some((matter) => matter.kind === "water-source");
    const sheltered = matterAt(state, agent.locationId).some((matter) => matter.traits.includes("shelter") && matter.construction?.complete);
    if (!food && !waterAvailable && !sheltered) return { succeeded: false, result: "没有食物、水源或住所支撑病人恢复", diff: {} };
    if (food) {
      const nourishment = clone(food);
      removeMatter(state, food, 1);
      mergeMatter(state, {
        ...nourishment,
        id: `patient-nourishment-${patient.id}-${eventId}`,
        kind: "metabolized",
        name: "病中吸收的养分",
        holder: { kind: "agent", id: patient.id },
        quantity: 1,
        traits: ["crafted"],
        sourceEventIds: [...(nourishment.sourceEventIds ?? []), eventId],
      });
      patient.body.nutrition = clamp(patient.body.nutrition + 18);
    }
    if (waterAvailable) patient.body.hydration = clamp(patient.body.hydration + 16);
    const before = patient.body.illness.severity;
    const illnessSourceEventIds = [...patient.body.illness.sourceEventIds];
    const illnessSinceTick = patient.body.illness.sinceTick;
    const illnessDurationYears = patient.body.illness.durationYears ?? Math.max(1, state.tick + 1 - patient.body.illness.sinceTick);
    const persistentIllness = patient.body.illness.course === "persistent" && illnessDurationYears >= 3;
    const improvement = 1 + Number(Boolean(food)) + Number(waterAvailable) + Number(sheltered);
    const severityFloor = patient.body.illness.course === "persistent" ? 1 : 0;
    patient.body.illness.severity = Math.max(severityFloor, before - improvement);
    patient.body.illness.lastSupportedTick = state.tick + 1;
    patient.body.illness.sourceEventIds = [...new Set([...patient.body.illness.sourceEventIds, eventId])];
    patient.body.health = clamp(patient.body.health + improvement * 2);
    patient.body.fatigue = clamp(patient.body.fatigue - improvement * 4);
    const recovered = patient.body.illness.severity <= 0;
    const illnessKind = patient.body.illness.kind;
    if (recovered) delete patient.body.illness;
    strengthenRelation(agent, patient, eventId, 7);
    if (recovered || (patient.body.illness?.severity ?? 0) < before) agent.standing.careTrust = clamp((agent.standing.careTrust ?? 0) + 3);
    return {
      succeeded: true,
      result: `${agent.name}利用${[food ? "食物" : "", waterAvailable ? "水" : "", sheltered ? "住所" : ""].filter(Boolean).join("、")}照护${patient.name}，病情由 ${before} 降到 ${patient.body.illness?.severity ?? 0}${recovered ? "并恢复活动" : patient.body.illness?.course === "persistent" ? "，但基础病程仍在持续" : ""}`,
      diff: { treatedIllness: true, targetAgentId: patient.id, illnessKind, illnessSinceTick, illnessDurationYears, illnessCourse: patient.body.illness?.course ?? "acute", persistentIllness, severityBefore: before, severityAfter: patient.body.illness?.severity ?? 0, recovered, foodCost: food ? 1 : 0, waterAvailable, sheltered, illnessSourceEventIds },
    };
  }
  if (intent.mode === "fit-support") {
    const target = state.agents.find((item) => item.id === intent.targetAgentId && item.locationId === agent.locationId && item.body.state === "active");
    const support = carried(state, agent.id).find((matter) => matter.id === intent.matterId && matter.traits.includes("supportive"));
    if (!target?.body.injury || target.body.injury.bleeding > 0 || (target.body.injury.mobilityLoss ?? 0) < 8 || !support) return { succeeded: false, result: "对象、伤后功能状态或支撑物不满足适配条件", diff: {} };
    const before = target.body.injury.mobilityLoss ?? 0;
    support.holder = { kind: "agent", id: target.id };
    target.body.injury.supportId = support.id;
    target.body.injury.supportEventIds = [...new Set([...(target.body.injury.supportEventIds ?? []), eventId])];
    target.body.injury.mobilityLoss = Math.max(4, before - 6);
    target.limbs.abilities.move = clamp(target.limbs.abilities.move + 4);
    strengthenRelation(agent, target, eventId, 8);
    return { succeeded: true, result: `${agent.name}把${support.name}适配给${target.name}，支撑受伤身体后移动受限由 ${before} 降到 ${target.body.injury.mobilityLoss}`, diff: { fittedSupport: true, supportId: support.id, targetAgentId: target.id, mobilityLossBefore: before, mobilityLossAfter: target.body.injury.mobilityLoss, injurySourceEventIds: [...target.body.injury.sourceEventIds] } };
  }
  if (intent.mode === "bury") {
    if (intent.siteId !== agent.locationId) return { succeeded: false, result: "无法在远处安葬逝者", diff: {} };
    const remains = matterAt(state, agent.locationId).find((matter) => matter.id === intent.remainsId && matter.traits.includes("remains") && matter.personId);
    if (!remains) return { succeeded: false, result: "眼前没有可安置的遗体", diff: {} };
    const deceased = state.agents.find((other) => other.id === remains.personId && other.body.state === "dead");
    if (!deceased) return { succeeded: false, result: "遗体与死亡事实无法对应", diff: {} };
    remains.kind = "grave";
    remains.name = `${deceased.name}的安葬纪念处`;
    remains.traits = [...new Set([...remains.traits.filter((trait) => trait !== "remains"), "memorial"])] as MatterTrait[];
    remains.madeBy = agent.id;
    remains.sourceEventIds = [...new Set([...(remains.sourceEventIds ?? []), eventId])];
    const relation = agent.relations.find((item) => item.agentId === deceased.id);
    if (relation) {
      relation.word = "记得并安葬了逝者";
      relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])];
    }
    return { succeeded: true, result: `${agent.name}妥善安置${deceased.name}的遗体，并留下可辨认的纪念处`, diff: { buried: true, memorialized: true, deceasedAgentId: deceased.id, remainsId: remains.id } };
  }
  if (intent.mode === "bond") {
    const other = state.agents.find((item) => item.id === intent.toAgentId && item.locationId === agent.locationId && item.body.state !== "dead");
    if (!other) return { succeeded: false, result: "想亲近或照料的人不在这里", diff: {} };
    const barrier = intent.gesture === "intimate" && intent.barrierId
      ? carried(state, agent.id).find((matter) => matter.id === intent.barrierId && matter.traits.includes("barrier"))
      : undefined;
    if (intent.gesture === "intimate" && !barrier) return { succeeded: false, result: "没有携带能够形成身体隔离层的柔性覆盖物", diff: {} };
    const wasPregnant = Boolean(other.body.pregnancy);
    const affectBefore = other.mind.affect.strain;
    const wasDistressed = other.mind.affect.state !== "regulated";
    const wasEndOfLife = Boolean(other.body.endOfLife);
    const wasWeak = other.body.health < 65 || other.body.hydration < 45 || other.body.nutrition < 50 || other.body.fatigue > 75 || wasPregnant || wasEndOfLife;
    const dependentChild = isDependentChild(other);
    const kin = other.lineage.motherId === agent.id || other.lineage.fatherId === agent.id;
    const amount = intent.gesture === "court" ? 7 : intent.gesture === "intimate" ? 5 : intent.gesture === "care" ? 6 : 4;
    strengthenRelation(agent, other, eventId, amount);
    let fedDependent = false;
    if (intent.gesture === "care") {
      other.body.health = clamp(other.body.health + 3);
      other.body.fatigue = clamp(other.body.fatigue - 8);
      const food = dependentChild ? carried(state, agent.id).find((matter) => matter.traits.includes("edible")) : undefined;
      if (food) {
        const portion = clone(food);
        removeMatter(state, food, 1);
        mergeMatter(state, {
          ...portion,
          id: `nourishment-${other.id}-${eventId}`,
          kind: "metabolized",
          name: "已吸收的养分",
          holder: { kind: "agent", id: other.id },
          quantity: 1,
          traits: ["crafted"],
          sourceEventIds: [...(portion.sourceEventIds ?? []), eventId],
        });
        other.body.nutrition = clamp(other.body.nutrition + 28);
        fedDependent = true;
      }
      if (other.body.pregnancy) {
        other.body.pregnancy.supportEventIds = [...new Set([...(other.body.pregnancy.supportEventIds ?? []), eventId])];
        other.body.pregnancy.supportAgentIds = [...new Set([...(other.body.pregnancy.supportAgentIds ?? []), agent.id])];
      }
      if (other.body.endOfLife) {
        other.body.endOfLife.supportEventIds = [...new Set([...other.body.endOfLife.supportEventIds, eventId])];
        other.body.endOfLife.supportAgentIds = [...new Set([...other.body.endOfLife.supportAgentIds, agent.id])];
        if (other.body.endOfLife.lastSupportedTick !== state.tick + 1) other.body.endOfLife.comfortYears += 1;
        other.body.endOfLife.lastSupportedTick = state.tick + 1;
        other.mind.affect.strain = clamp(other.mind.affect.strain - 6);
      }
      if (other.body.adaptation?.withdrawalSinceTick !== undefined) {
        other.body.adaptation.supportEventIds = [...new Set([...other.body.adaptation.supportEventIds, eventId])];
        if (other.body.adaptation.lastSupportedTick !== state.tick + 1) other.body.adaptation.supportedYears += 1;
        other.body.adaptation.lastSupportedTick = state.tick + 1;
        other.body.adaptation.level = Math.max(0, other.body.adaptation.level - 0.8);
        other.mind.affect.strain = clamp(other.mind.affect.strain - 5);
        other.body.fatigue = clamp(other.body.fatigue - 5);
      }
    }
    if (intent.gesture === "comfort") {
      const relationStrength = agent.relations.find((relation) => relation.agentId === other.id)?.strength ?? 0;
      const relief = 4 + Math.floor(relationStrength / 25);
      other.mind.affect.strain = clamp(other.mind.affect.strain - relief);
      if (wasDistressed) other.mind.affect.supportEventIds = [...new Set([...other.mind.affect.supportEventIds, eventId])];
      if (wasDistressed && other.mind.affect.strain < affectBefore) agent.standing.careTrust = clamp((agent.standing.careTrust ?? 0) + 2);
    }
    const conception = intent.gesture === "court" || intent.gesture === "intimate"
      ? tryConceive(state, agent, other, eventId, barrier?.id)
      : { conceived: false, fertile: false, chanceWithoutBarrier: 0, chanceWithBarrier: 0, wouldConceiveWithoutBarrier: false, preventedByBarrier: false };
    if (barrier) {
      barrier.sourceEventIds = [...new Set([...(barrier.sourceEventIds ?? []), eventId])];
      for (const person of [agent, other]) {
        person.body.familyPlanning ??= { desiredChildCount: 2, birthCount: 0, sourceEventIds: [] };
        person.body.familyPlanning.sourceEventIds = [...new Set([...person.body.familyPlanning.sourceEventIds, eventId])];
      }
    }
    const result = intent.gesture === "court"
      ? `${agent.name}向${other.name}表达了亲近之意${conception.conceived ? "，两人开始期待下一代" : ""}`
      : intent.gesture === "intimate"
        ? `${agent.name}与${other.name}保持亲密，并用${barrier!.name}隔开身体表面与液体${conception.conceived ? "，但仍发生了妊娠" : ""}`
        : intent.gesture === "care" ? `${agent.name}照料了${other.name}${fedDependent ? "并喂给一份食物" : ""}` : `${agent.name}安慰了${other.name}`;
    return { succeeded: true, result, diff: { bonded: true, gesture: intent.gesture, partnerId: other.id, conceived: conception.conceived, fertileContact: conception.fertile, motherId: conception.motherId ?? "", fatherId: conception.fatherId ?? "", barrierUsed: Boolean(barrier), barrierId: barrier?.id ?? "", chanceWithoutBarrier: conception.chanceWithoutBarrier, chanceWithBarrier: conception.chanceWithBarrier, wouldConceiveWithoutBarrier: conception.wouldConceiveWithoutBarrier, preventedByBarrier: conception.preventedByBarrier, planningPreferenceReached: Boolean(agent.body.familyPlanning && other.body.familyPlanning && (agent.body.familyPlanning.birthCount >= agent.body.familyPlanning.desiredChildCount || other.body.familyPlanning.birthCount >= other.body.familyPlanning.desiredChildCount)), actorBirthCount: agent.body.familyPlanning?.birthCount ?? 0, partnerBirthCount: other.body.familyPlanning?.birthCount ?? 0, targetAgeYears: other.body.ageYears, kin, caredForWeak: intent.gesture === "care" && (wasWeak || dependentChild), caredForPregnancy: intent.gesture === "care" && wasPregnant, caredForEndOfLife: intent.gesture === "care" && wasEndOfLife, supportedWithdrawal: intent.gesture === "care" && other.body.adaptation?.withdrawalSinceTick !== undefined, adaptationSourceEventIds: other.body.adaptation?.sourceEventIds ?? [], withdrawalSourceEventIds: other.body.adaptation?.withdrawalEventIds ?? [], adaptationLevelAfter: other.body.adaptation?.level ?? 0, endOfLifeSourceEventIds: wasEndOfLife ? [...(other.body.endOfLife?.sourceEventIds ?? [])] : [], comfortYears: other.body.endOfLife?.comfortYears ?? 0, nurturedChild: intent.gesture === "care" && dependentChild, fedDependent, supportedDistress: intent.gesture === "comfort" && wasDistressed, strainBefore: affectBefore, strainAfter: other.mind.affect.strain, distressSourceEventIds: wasDistressed ? [...other.mind.affect.sourceEventIds] : [] } };
  }
  if (intent.mode === "shape") return shapeMatter(state, agent, intent, eventId);
  if (intent.mode === "assemble") return assembleMatter(state, agent, intent, eventId);
  if (intent.mode === "work") {
    const site = location(state, intent.siteId);
    if (!site || site.id !== agent.locationId) return { succeeded: false, result: "人物无法作用于远处地面", diff: {} };
    if (intent.change === "compact") site.terrain.compaction = clamp(site.terrain.compaction + 8);
    if (intent.change === "clear") site.terrain.cleared = clamp(site.terrain.cleared + 8);
    if (intent.change === "dig") site.terrain.depth = clamp(site.terrain.depth + 1, 0, 20);
    if (intent.change === "irrigate") {
      if (site.id !== "field" || site.terrain.depth < 2) return { succeeded: false, result: "沟渠尚未挖到足以引水的深度", diff: {} };
      site.terrain.depth = clamp(site.terrain.depth + 1, 0, 20);
      site.terrain.cleared = clamp(site.terrain.cleared + 2);
      site.terrain.irrigated = true;
    }
    if (intent.change === "cultivate") {
      const irrigated = Boolean(site.terrain.irrigated);
      let grain = matterAt(state, site.id).find((matter) => matter.kind === "grain");
      const standingCrop = matterAt(state, site.id).find((matter) => matter.kind === "standing-crop");
      const fertility = matterAt(state, site.id).find((matter) => matter.kind === "soil-organic");
      if (site.id !== "field" || !irrigated || !standingCrop || !fertility) return { succeeded: false, result: "田地还没有水源、谷株或可用养分", diff: {} };
      const harvest = Math.min(3, fertility.quantity);
      if (harvest < 1) return { succeeded: false, result: "土壤中的可用养分已经耗尽", diff: {} };
      removeMatter(state, fertility, harvest);
      if (!grain) {
        grain = baseMatter(`grain-field-${eventId}`, "grain", "谷物", { kind: "space", id: "field" }, 0, 1, { biomass: 1 }, ["raw", "edible"]);
        state.world.matter.push(grain);
      }
      grain.quantity += harvest;
      grain.sourceEventIds = [...(grain.sourceEventIds ?? []), standingCrop.id, eventId];
      site.terrain.cleared = clamp(site.terrain.cleared + 1);
    }
    const result = intent.change === "compact" ? `${agent.name}反复踩压${site.name}的地面，土面更结实了`
      : intent.change === "clear" ? `${agent.name}清理了${site.name}的地面，腾出一块平地`
        : intent.change === "dig" ? `${agent.name}在${site.name}挖沟，沟又深了一些`
          : intent.change === "irrigate" ? `${agent.name}把${site.name}的沟渠接到了水源`
            : `${agent.name}在${site.name}翻土除草，照料了谷物`;
    return { succeeded: true, result, diff: { terrain: intent.change, ...(intent.change === "cultivate" ? { tendedCrop: "谷物", harvest: 3 } : {}) } };
  }
  if (intent.mode === "adapt") {
    if (intent.change === "dehydrate") {
      if (agent.body.state !== "active") return { succeeded: false, result: `${agent.name}当前无法再次脱水`, diff: {} };
      agent.body.state = "dehydrated";
      agent.body.dehydrations += 1;
      agent.body.hydration = 8;
      agent.body.exposure = Math.max(0, agent.body.exposure - 8);
      return { succeeded: true, result: `${agent.name}让身体脱水，蜷缩下来保存体力`, diff: { bodyState: "dehydrated", adaptation: "dehydrate" } };
    }
    const target = state.agents.find((item) => item.id === intent.targetAgentId && item.locationId === agent.locationId);
    if (!target || target.body.state !== "dehydrated") return { succeeded: false, result: "身边没有可被浸泡唤醒的脱水者", diff: {} };
    const recoveryFood = [...carried(state, agent.id), ...matterAt(state, agent.locationId)].find((matter) => matter.traits.includes("edible") && matter.quantity >= 1);
    if (!recoveryFood) return { succeeded: false, result: `${target.name}可以浸泡，但没有粮食支撑复苏，众人只能让其继续脱水`, diff: { shortage: "food" } };
    removeMatter(state, recoveryFood, 1);
    target.body.state = "active";
    target.body.soakings += 1;
    target.body.hydration = 68;
    target.body.exposure = Math.max(0, target.body.exposure - 10);
    target.body.nutrition = clamp(target.body.nutrition + 18);
    return { succeeded: true, result: `${agent.name}消耗一份${recoveryFood.name}并用水浸泡${target.name}，使其结束脱水并重新活动`, diff: { bodyState: "active", targetAgentId: target.id, adaptation: "soak", foodCost: 1 } };
  }
  if (intent.mode === "observe") {
    if (agent.limbs.abilities.observe < 45) return { succeeded: false, result: `${agent.name}尚不能稳定辨认这次变化`, diff: {} };
    const aspect = intent.aspect === "sky" ? "天空明暗与天体位置" : intent.aspect === "climate" ? "体感与周围物质的气候反应" : "眼前可见物质的数量";
    agent.limbs.abilities.observe = clamp(agent.limbs.abilities.observe + 2);
    return {
      succeeded: true,
      result: `${agent.name}观察了${aspect}，记下此时是${state.civilization.epoch === "stable" ? "恒纪元" : "乱纪元"}、${climateLabel(state.civilization.climate.kind)}（强度 ${state.civilization.climate.severity}）`,
      diff: { observation: intent.aspect, epoch: state.civilization.epoch, climate: state.civilization.climate.kind, severity: state.civilization.climate.severity },
    };
  }
  if (intent.mode === "record") {
    const medium = state.world.matter.find((matter) => matter.id === intent.mediumId && matter.traits.includes("recordable") && ((matter.holder.kind === "agent" && matter.holder.id === agent.id) || (matter.holder.kind === "space" && matter.holder.id === agent.locationId)));
    if (!medium) return { succeeded: false, result: "身边没有可刻写的记录载体", diff: {} };
    const experiencedIds = accessibleFactIds(agent);
    const sources = [...new Set(intent.sourceEventIds)].filter((id) => experiencedIds.has(id) && state.world.time.past.some((event) => event.id === id)).slice(0, 12);
    const minimum = intent.recordKind === "calendar" ? 4 : intent.recordKind === "map" ? 6 : intent.recordKind === "notation" || intent.recordKind === "model" || intent.recordKind === "measure" || intent.recordKind === "account" ? 3 : intent.recordKind === "contract" ? 2 : 1;
    const requiredReason = intent.recordKind === "model" ? 68 : intent.recordKind === "calendar" || intent.recordKind === "notation" || intent.recordKind === "map" || intent.recordKind === "measure" || intent.recordKind === "account" || intent.recordKind === "contract" ? 55 : 40;
    const hasInstrument = [...carried(state, agent.id), ...matterAt(state, agent.locationId)].some((matter) => matter.traits.includes("instrument") && matter.construction?.complete);
    if (sources.length < minimum || agent.limbs.abilities.reason < requiredReason || (intent.recordKind === "model" && !hasInstrument)) return { succeeded: false, result: "现有经历、模型或推理能力不足以形成这种记录", diff: {} };
    const record: EvidenceRecord = { id: `r-${state.tick + 1}-${agent.id}-${medium.records?.length ?? 0}`, kind: intent.recordKind, authorId: agent.id, createdTick: state.tick + 1, sourceEventIds: sources, note: safeText(intent.note, "未命名记录", 80) };
    if (intent.recordKind === "chronicle") {
      const actionSources = sources.flatMap((id) => state.world.time.past.filter((event): event is ActionFact => event.id === id && event.kind === "action"));
      const subjects = [...new Set(actionSources.map((event) => typeof event.diff.targetAgentId === "string" ? event.diff.targetAgentId : typeof event.diff.partnerId === "string" ? event.diff.partnerId : "").filter(Boolean))];
      const materialSources = actionSources.filter((event) => event.diff.botanicalMaterial === true && typeof event.diff.appliedMaterial === "string");
      const methods = [...new Set(materialSources.map((event) => String(event.diff.appliedMaterial)))];
      if (methods.length >= 2) {
        record.comparedMethods = methods;
        record.rejectedMethods = [...new Set(materialSources.filter((event) => event.diff.materialBodyEffect === "neutral" || event.diff.materialBodyEffect === "harmful").map((event) => String(event.diff.appliedMaterial)))];
      }
      if (subjects.length === 1) {
        const outcomes = actionSources.map((event) => careOutcomeFromDiff(event.diff)).filter((outcome): outcome is Exclude<PlaceUseTrace["outcome"], "observed"> => Boolean(outcome && outcome !== "observed"));
        const episodeMethods = [...new Set(actionSources.flatMap((event) => {
          if (event.diff.botanicalMaterial === true && typeof event.diff.appliedMaterial === "string") return [`material:${event.diff.appliedMaterial}`];
          if (event.diff.treatedIllness === true) return ["support:food-water-shelter"];
          if (event.diff.supportedDistress === true) return ["support:comfort"];
          return [];
        }))];
        record.subjectAgentId = subjects[0];
        record.episodeKey = `${subjects[0]}:${Math.min(...actionSources.map((event) => event.tick))}`;
        record.outcome = outcomes.includes("improved") ? "improved" : outcomes.includes("worsened") ? "worsened" : "unchanged";
        if (episodeMethods.length === 1) record.methodKey = episodeMethods[0];
      }
    }
    medium.records = [...(medium.records ?? []), record];
    medium.sourceEventIds = [...new Set([...(medium.sourceEventIds ?? []), ...sources, eventId])];
    agent.limbs.abilities.reason = clamp(agent.limbs.abilities.reason + (["calendar", "notation", "model", "map", "measure", "account", "contract"].includes(intent.recordKind) ? 4 : 2));
    return { succeeded: true, result: `${agent.name}在${medium.name}上留下“${record.note}”的${recordKindLabel(record.kind)}记录，引用 ${sources.length} 条亲历事实`, diff: { recordKind: record.kind, recordId: record.id, sourceCount: sources.length } };
  }
  if (intent.mode === "predict") {
    const experiencedIds = accessibleFactIds(agent);
    const records = state.world.matter.flatMap((matter) => matter.records ?? []);
    const recordSources = new Set(records.flatMap((record) => record.sourceEventIds));
    const sources = [...new Set(intent.sourceEventIds)].filter((id) => experiencedIds.has(id) || recordSources.has(id)).slice(0, 12);
    const dueTick = Math.max(state.tick + 1, Math.min(state.tick + 12, Math.round(intent.dueTick)));
    const instrument = intent.instrumentId ? [...carried(state, agent.id), ...matterAt(state, agent.locationId)].find((matter) => matter.id === intent.instrumentId && matter.traits.includes("instrument")) : undefined;
    if (sources.length < 3 || agent.limbs.abilities.reason < 55) return { succeeded: false, result: "证据或推理能力不足以提出可检验预测", diff: {} };
    const hypothesis: HypothesisState = {
      id: `h-${state.tick + 1}-${agent.id}-${agent.mind.cognition.hypotheses.length}`,
      claim: `第${dueTick}年将处于${intent.predictedEpoch === "stable" ? "恒纪元" : "乱纪元"}并出现${climateLabel(intent.predictedClimate)}`,
      predictedEpoch: intent.predictedEpoch, predictedClimate: intent.predictedClimate, dueTick, sourceEventIds: [...sources, eventId], instrumentId: instrument?.id, status: "pending",
      followers: [], respectAtPrediction: agent.standing.respect,
    };
    agent.mind.cognition.hypotheses.push(hypothesis);
    return { succeeded: true, result: `${agent.name}依据 ${sources.length} 条记录${instrument ? `和${instrument.name}` : ""}提出预测：${hypothesis.claim}`, diff: { hypothesisId: hypothesis.id, dueTick, predictedEpoch: hypothesis.predictedEpoch, predictedClimate: hypothesis.predictedClimate } };
  }
  const other = state.agents.find((item) => item.id === intent.toAgentId && item.locationId === agent.locationId);
  if (!other) return { succeeded: false, result: "表达对象不在这里", diff: {} };
  const relation = agent.relations.find((item) => item.agentId === other.id);
  if (relation) {
    relation.word = "有过表达与回应";
    relation.sourceEventIds.push(eventId);
  }
  const ownedSources = new Set(agent.mind.cognition.knowledge.flatMap((item) => item.sourceEventIds));
  const cited = [...new Set(intent.sourceEventIds ?? [])].filter((id) => ownedSources.has(id)).slice(0, 6);
  const claim = intent.claim ? safeText(intent.claim, "", 72) : "";
    if (claim && cited.length) {
    const sharedClaim = `${agent.name}告诉我：${claim}`;
    learn(other, sharedClaim, 42, eventId);
    const received = other.mind.cognition.knowledge.find((item) => item.claim === sharedClaim);
    if (received) for (const sourceId of cited) if (!received.sourceEventIds.includes(sourceId)) received.sourceEventIds.push(sourceId);
    }
  const phrase = safeText(intent.speech, action.content, 80);
  const heardSamePhrase = other.mind.cognition.knowledge.find((item) => item.claim === `听到固定说法：${phrase}`);
  if (heardSamePhrase) {
    heardSamePhrase.confidence = clamp(heardSamePhrase.confidence + 8);
    heardSamePhrase.sourceEventIds.push(eventId);
  } else learn(other, `听到固定说法：${phrase}`, 36, eventId);
  return {
    succeeded: true,
    result: `${agent.name}向${other.name}表达：“${phrase}”`,
    diff: { expressedTo: other.id, sharedSourcedClaim: Boolean(claim && cited.length) },
  };
}

function registerRouteUse(state: SimulationState, from: LocationId, to: LocationId, eventId: string) {
  const route = state.world.space.routes.find((item) => item.id === routeId(from, to));
  if (!route) return null;
  const before = route.state;
  route.traffic += 1;
  route.sourceEventIds.push(eventId);
  route.state = route.traffic >= 8 ? "road" : route.traffic >= 3 ? "trail" : "unmarked";
  return { route, changed: before !== route.state };
}
function executeAction(state: SimulationState, agent: AgentState, decision: Decision, eventIndex: number, phase: AnnualPhase) {
  const action = decision.action;
  const eventId = `e-${state.tick + 1}-${eventIndex}`;
  const where = agent.locationId;
  let outcome: Outcome = { succeeded: false, result: "没有改变", diff: {} };
  if (action.type === "move") {
    const destination = location(state, action.to);
    const here = location(state, agent.locationId)!;
    if (destination?.open && here.neighbors.includes(destination.id) && agent.limbs.abilities.move >= 60) {
      const from = agent.locationId;
      agent.locationId = destination.id;
      const use = registerRouteUse(state, from, destination.id, eventId);
      const terrainChange = use?.changed ? `；反复脚步使这段地面显出${use.route.state === "road" ? "道路" : "小径"}` : "";
      const companionsBefore = state.agents.filter((other) => other.id !== agent.id && other.body.state !== "dead" && other.locationId === from).length;
      const companionsAfter = state.agents.filter((other) => other.id !== agent.id && other.body.state !== "dead" && other.locationId === destination.id).length;
      const contactKnowledge = agent.mind.cognition.knowledge.find((item) => item.kind === "contact-illness-association" && item.confidence >= 52);
      const distancedWhileIll = Boolean(agent.body.illness && contactKnowledge && companionsBefore > 0 && companionsAfter < companionsBefore);
      outcome = { succeeded: true, result: `${agent.name}从${locationName(state, from)}抵达${destination.name}${terrainChange}`, diff: { from, to: destination.id, route: use?.route.state ?? "none", traffic: use?.route.traffic ?? 0, companionsBefore, companionsAfter, distancedWhileIll, contactKnowledgeSourceEventIds: contactKnowledge?.sourceEventIds ?? [] } };
    } else { if (process.env.TB_DEBUG_MOVE) console.error(`MOVE-FAIL who=${agent.id} from=${agent.locationId} to=${action.to} destOpen=${destination?.open} neighbors=${JSON.stringify(here.neighbors)} move=${agent.limbs.abilities.move}`); outcome.result = `${agent.name}未能移动`; }
  } else if (agent.limbs.abilities.interact >= 50) outcome = interact(state, agent, action, eventId);

  const impairment = agent.body.injury;
  if (outcome.succeeded) outcome.diff.companionsAtAction = state.agents.filter((other) => other.id !== agent.id && other.body.state !== "dead" && other.locationId === where).length;
  if (outcome.succeeded && impairment && (impairment.mobilityLoss ?? 0) > 0) {
    outcome.diff.mobilityLimitedAtAction = true;
    outcome.diff.mobilityLossAtAction = impairment.mobilityLoss ?? 0;
    outcome.diff.lastingMobilityLossAtAction = impairment.lastingMobilityLoss ?? 0;
    outcome.diff.supportInUse = Boolean(impairment.supportId && carried(state, agent.id).some((matter) => matter.id === impairment.supportId && matter.traits.includes("supportive")));
    outcome.diff.supportIdAtAction = impairment.supportId ?? "";
    outcome.diff.impairmentSourceEventIds = [...impairment.sourceEventIds];
    if (action.type === "move" && outcome.diff.supportInUse === true) impairment.supportedMoveEventIds = [...new Set([...(impairment.supportedMoveEventIds ?? []), eventId])];
  }

  agent.mind.needs.focus = safeText(decision.needFocus, agent.mind.needs.focus, 48);
  agent.mind.needs.dominantLevel = decision.needLevel;
  agent.mind.cognition.perception = safeText(decision.perception, agent.mind.cognition.perception, 80);
  agent.mind.cognition.choice = safeText(decision.choice, agent.mind.cognition.choice, 48);
  agent.limbs.action = action;
  agent.limbs.actionText = action.type === "move" ? `移动 · ${agent.mind.cognition.choice}` : `交互 · ${action.content}`;
  const intent = action.type === "interact" ? action.intent : undefined;
  const exertion = action.type === "move" ? 6 : intent?.mode === "rest" ? 0 : intent?.mode === "work" || intent?.mode === "assemble" || intent?.mode === "hunt" ? 8 : 3;
  agent.body.fatigue = clamp(agent.body.fatigue + exertion);
  if (outcome.succeeded) {
    const ability = action.type === "move" ? "move" : "interact";
    agent.limbs.abilities[ability] = clamp(agent.limbs.abilities[ability] + 1);
    agent.mind.needs.intensity = clamp(agent.mind.needs.intensity - 3, 20, 100);
  } else agent.mind.needs.intensity = clamp(agent.mind.needs.intensity + 4);
  const perception = agent.mind.cognition.perception.replace(/[。！？；，,\s]+$/u, "");
  const choice = agent.mind.cognition.choice.replace(/[。！？；，,\s]+$/u, "");
  const interpretation = outcome.succeeded ? `${perception}。${choice}。` : `${perception}。原想${choice}，但这次没成，得换个办法。`;
  const fact: ActionFact = { id: eventId, kind: "action", tick: state.tick + 1, phase, who: agent.id, where, action, succeeded: outcome.succeeded, result: outcome.result, diff: outcome.diff };
  tracePlaceUse(state, fact);
  const claim = knowledgeFromAction(action, outcome);
  if (claim) learn(agent, claim, 72, eventId);
  return { fact, interpretation: { agentId: agent.id, factIds: [eventId], interpretation } };
}

function observeAction(state: SimulationState, fact: ActionFact) {
  state.agents.filter((other) => other.id !== fact.who && other.locationId === fact.where).forEach((observer) => {
    const claim = knowledgeFromAction(fact.action, { succeeded: fact.succeeded, result: fact.result, diff: fact.diff });
    remember(observer, {
      agentId: observer.id,
      factIds: [fact.id],
      interpretation: fact.succeeded ? `我看见${fact.result}。${claim ? `看来${claim}。` : "这件事我记下了。"}` : `我看见这次尝试没有成功。`,
    }, fact);
    if (claim) learn(observer, `我亲眼见过：${claim}`, 48, fact.id);
    if (fact.diff.botanicalMaterial === true && typeof fact.diff.appliedMaterial === "string" && (fact.diff.materialBodyEffect === "beneficial" || fact.diff.materialBodyEffect === "neutral" || fact.diff.materialBodyEffect === "harmful")) {
      const observed = observer.mind.cognition.knowledge.find((item) => item.claim === `我亲眼见过：${claim}`);
      if (observed) {
        observed.kind = "material-body-effect";
        observed.subjectKind = String(fact.diff.appliedMaterial);
        observed.observedEffect = fact.diff.materialBodyEffect as "beneficial" | "neutral" | "harmful";
      }
    }
  });
}
function contextFor(state: SimulationState, agent: AgentState): DecisionContext {
  const visibleAgents = state.agents.filter((other) => other.id !== agent.id && other.locationId === agent.locationId);
  const accessibleAgentIds = new Set([agent.id, ...visibleAgents.map((other) => other.id)]);
  const rememberedFactIds = accessibleFactIds(agent);
  const rememberedFacts = state.world.time.past.filter((event) => rememberedFactIds.has(event.id));
  const visibleMatter = state.world.matter.filter((matter) => matter.holder.kind === "space"
    ? matter.holder.id === agent.locationId
    : accessibleAgentIds.has(matter.holder.id));
  const decisionState: SimulationState = {
    ...state,
    world: { ...state.world, time: { present: state.world.time.present, past: rememberedFacts }, matter: visibleMatter },
    agents: [agent, ...visibleAgents],
    derived: { practices: [], institutions: [], milestones: [], issues: [] },
    lastStep: [],
  };
  return { state: decisionState, agent: clone(agent), visibleAgents: clone(visibleAgents), localMatter: clone(matterAt(state, agent.locationId)) };
}
export function buildDecisionContexts(state: SimulationState) { return state.agents.map((agent) => contextFor(state, agent)) }
function climateLabel(kind: ClimateKind) {
  return kind === "cold" ? "严寒" : kind === "heat" ? "酷暑" : kind === "fire" ? "烈焰" : "温和气候";
}

function climateFor(state: SimulationState, tick: number) {
  if (state.civilization.externalClimate) return state.civilization.externalClimate;
  const { chaosIntensity, climateBias } = state.civilization.conditions;
  if (chaosIntensity <= 0) return { epoch: "stable" as const, kind: "temperate" as const, severity: 1 };
  const segment = Math.floor(tick / Math.max(2, 7 - Math.floor(chaosIntensity / 2)));
  const roll = Math.abs((state.seed * 31 + segment * 73 + state.civilization.number * 17) % 100);
  if (roll >= Math.min(88, 24 + chaosIntensity * 7)) return { epoch: "stable" as const, kind: "temperate" as const, severity: 1 };
  const climateRoll = (roll + state.seed + segment * 11) % 10;
  const kind: ClimateKind = climateBias === "cold"
    ? climateRoll < 7 ? "cold" : "heat"
    : climateBias === "hot"
      ? climateRoll < 5 ? "fire" : "heat"
      : climateRoll < 4 ? "cold" : climateRoll < 8 ? "heat" : "fire";
  return { epoch: "chaotic" as const, kind, severity: clamp(2 + Math.floor(chaosIntensity / 2) + (roll % 3), 2, 9) };
}

function advanceEnvironment(state: SimulationState): EnvironmentFact[] {
  const nextTick = state.tick + 1;
  const next = climateFor(state, nextTick);
  const previous = state.civilization.climate;
  const events: EnvironmentFact[] = [];
  const exposureAtYearStart = new Map(state.agents.flatMap((agent) => agent.body.infectionExposure ? [[agent.id, clone(agent.body.infectionExposure)] as const] : []));
  for (const sick of state.agents.filter((agent) => agent.body.state === "active" && agent.body.illness?.kind === "fever")) {
    for (const contact of state.agents.filter((agent) => agent.id !== sick.id && agent.body.state === "active" && !agent.body.illness && agent.locationId === sick.locationId)) {
      const prior = contact.body.infectionExposure;
      contact.body.infectionExposure = {
        load: clamp((prior?.load ?? 0) + 1 + sick.body.illness.severity * 0.5, 0, 8),
        exposedTick: nextTick,
        sourceAgentIds: [...new Set([...(prior?.sourceAgentIds ?? []), sick.id])],
        sourceEventIds: [...new Set([...(prior?.sourceEventIds ?? []), ...sick.body.illness.sourceEventIds.slice(0, 1)])],
      };
    }
  }
  if (state.civilization.epoch !== next.epoch || previous.kind !== next.kind || previous.severity !== next.severity) {
    state.civilization.epoch = next.epoch;
    state.civilization.climate = { kind: next.kind, severity: next.severity, sinceTick: nextTick };
    events.push({
      id: `w-${nextTick}-epoch`, kind: "environment", tick: nextTick, where: "square", change: "epoch", succeeded: true,
      result: next.epoch === "stable" ? "天体运行暂时可测，恒纪元开始" : `天体运行失序，乱纪元带来${climateLabel(next.kind)}（强度 ${next.severity}）`,
      diff: { epoch: next.epoch, climate: next.kind, severity: next.severity },
    });
  }
  if (next.epoch === "chaotic") {
    const completedShelters = state.world.matter.filter((matter) => matter.construction?.complete && matter.traits.includes("shelter")).length;
    const damage = Math.max(0, next.severity * 2 - completedShelters * 2);
    state.civilization.integrity = clamp(state.civilization.integrity - damage);
  } else {
    state.civilization.integrity = clamp(state.civilization.integrity + 2);
  }
  const completedShelterSites = new Set(state.world.matter.filter((matter) => matter.construction?.complete && matter.traits.includes("shelter") && matter.holder.kind === "space").map((matter) => matter.holder.id));
  if (next.epoch === "stable") {
    for (const predictor of state.agents.filter((agent) => agent.body.state === "active" && agent.standing.respect >= TRUSTED_PREDICTOR_RESPECT)) {
      for (const hypothesis of predictor.mind.cognition.hypotheses.filter((item) => item.status === "pending" && item.predictedEpoch === "chaotic" && item.dueTick >= nextTick && item.dueTick <= nextTick + 2)) {
        const newFollowers = state.agents.filter((agent) => {
          if (agent.id === predictor.id || agent.body.state !== "active" || agent.body.pregnancy || (hypothesis.followers ?? []).includes(agent.id)) return false;
          const trustChance = 0.48 + predictor.standing.respect * 0.004;
          return deterministicFraction(state.seed, `follow:${hypothesis.id}:${agent.id}`) < trustChance;
        });
        for (const follower of newFollowers) {
          follower.body.state = "dehydrated";
          follower.body.dehydrations += 1;
          follower.body.hydration = 8;
          follower.limbs.actionText = `听信${predictor.name}预言 · 提前脱水`;
        }
        hypothesis.followers = [...new Set([...(hypothesis.followers ?? []), ...newFollowers.map((agent) => agent.id)])];
        if (newFollowers.length) events.push({
          id: `w-${nextTick}-warning-${predictor.id}-${hypothesis.id}`, kind: "environment", tick: nextTick, where: predictor.locationId, change: "survival", succeeded: true,
          result: `${predictor.name}以 ${Math.round(predictor.standing.respect)} 点尊重警告乱纪元将至，${newFollowers.length} 人相信并提前脱水`,
          diff: { predictorId: predictor.id, followerCount: newFollowers.length, hypothesisId: hypothesis.id, cause: "trusted-prediction" },
        });
      }
    }
  }
  const dehydratedCount = state.agents.filter((agent) => agent.body.state === "dehydrated").length;
  const availableFood = state.world.matter.reduce((sum, matter) => sum + (matter.traits.includes("edible") ? matter.quantity : 0), 0);
  if (next.epoch === "stable" && dehydratedCount > 0 && availableFood < 1) events.push({
    id: `w-${nextTick}-soak-shortage`, kind: "environment", tick: nextTick, where: "homes", change: "survival", succeeded: true,
    result: `恒纪元已经到来，但粮食不足，${dehydratedCount} 名脱水者无法安全复苏`, diff: { dehydratedCount, shortage: "food", cause: "recovery-shortage" },
  });
  const agentsAtYearStart = [...state.agents];
  // 受限者已经抵达有同伴的共同地点时，普通分享、制作、照护和表达应与其他成人一样可选；
  // 支具解决的是移动门槛，不应把人的后续生活机械压成往返移动。
  for (const agent of agentsAtYearStart) {
    const injury = agent.body.injury;
    const supportedImpairment = Boolean(injury?.lastingMobilityLoss && injury.supportId && carried(state, agent.id).some((matter) => matter.id === injury.supportId && matter.traits.includes("supportive")));
    if (!supportedImpairment) continue;
    const companions = state.agents.filter((other) => other.id !== agent.id && other.body.state !== "dead" && other.locationId === agent.locationId).length;
    if (companions > 0 && agent.limbs.action?.type === "move") agent.limbs.action = null;
  }
  const illAtYearStart = new Set(agentsAtYearStart.filter((agent) => agent.body.state === "active" && agent.body.illness).map((agent) => agent.id));
  const deathsLastYearByLocation = new Map<LocationId, EnvironmentFact[]>();
  for (const event of state.world.time.past) if (event.kind === "environment" && event.tick >= state.tick - 1 && (event.diff.bodyState === "dead" || event.change === "prediction" && event.diff.executed === true)) {
    deathsLastYearByLocation.set(event.where, [...(deathsLastYearByLocation.get(event.where) ?? []), event]);
  }
  for (const agent of agentsAtYearStart) {
    if (agent.body.state === "dead") continue;
    agent.body.ageYears += 1;
    const dependentChild = isDependentChild(agent);
    // 一个 tick 只保留一项年度关键选择；日常进食与睡眠已折入较小的年度净消耗，
    // 否则人物会被迫把每个关键选择都用于吃饭或睡觉，其他行为没有演化空间。
    const nutritionCost = agent.body.state === "dehydrated" ? 1 : dependentChild ? agent.body.ageYears < 6 ? 2 : 3 : 3;
    const fatigueCost = agent.body.state === "dehydrated" ? 1 : dependentChild ? 4 : 7;
    agent.body.nutrition = clamp(agent.body.nutrition - nutritionCost);
    agent.body.fatigue = clamp(agent.body.fatigue + fatigueCost);
    // 幼儿不靠自己选择“进食”行动。只要同地有能活动的成人和真实食物，
    // 聚落照料就会自动消耗一份食物，避免他们因没有行动权而机械饿死。
    if (dependentChild && agent.body.state === "active" && agent.body.nutrition <= 66) {
      const caregivers = state.agents
        .filter((candidate) => candidate.id !== agent.id && candidate.body.state === "active" && candidate.body.ageYears >= ADULT_WORK_AGE && candidate.locationId === agent.locationId)
        .sort((first, second) => {
          const firstKin = Number(first.id === agent.lineage.motherId || first.id === agent.lineage.fatherId);
          const secondKin = Number(second.id === agent.lineage.motherId || second.id === agent.lineage.fatherId);
          const firstRelation = first.relations.find((relation) => relation.agentId === agent.id)?.strength ?? 0;
          const secondRelation = second.relations.find((relation) => relation.agentId === agent.id)?.strength ?? 0;
          return secondKin - firstKin || secondRelation - firstRelation;
        });
      const caregiver = caregivers[0];
      const availableFood = caregiver
        ? [...carried(state, caregiver.id), ...matterAt(state, agent.locationId)]
          .filter((matter) => matter.quantity >= 1 && matter.traits.includes("edible"))
          .sort((first, second) => Number(second.traits.includes("cooked")) - Number(first.traits.includes("cooked")))[0]
        : undefined;
      if (caregiver && availableFood) {
        const supportEventId = `w-${nextTick}-child-care-${agent.id}`;
        const foodName = availableFood.name;
        const foodSourceEventIds = availableFood.sourceEventIds ?? [];
        removeMatter(state, availableFood, 1);
        agent.body.nutrition = clamp(agent.body.nutrition + 26);
        agent.body.hydration = clamp(agent.body.hydration + 8);
        agent.body.fatigue = clamp(agent.body.fatigue - 10);
        agent.body.health = clamp(agent.body.health + 2);
        events.push({
          id: supportEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "survival", succeeded: true,
          result: `${caregiver.name}照料年幼的${agent.name}，用一份${foodName}补充成长所需的营养`,
          diff: { agentId: agent.id, caregiverId: caregiver.id, cause: "dependent-child-care", foodName, foodCost: 1, nutrition: agent.body.nutrition, foodSourceEventIds },
        });
      }
    }
    if (agent.body.state === "active" && agent.body.adaptation) {
      const adaptation = agent.body.adaptation;
      const yearsSinceUse = nextTick - adaptation.lastUseTick;
      if (adaptation.level >= 0.8 && yearsSinceUse >= 2 && adaptation.withdrawalSinceTick === undefined) {
        const withdrawalEventId = `w-${nextTick}-withdrawal-${agent.id}`;
        adaptation.withdrawalSinceTick = nextTick;
        adaptation.withdrawalEventIds = [...new Set([...adaptation.withdrawalEventIds, withdrawalEventId])];
        agent.body.fatigue = clamp(agent.body.fatigue + 12);
        agent.mind.affect.strain = clamp(agent.mind.affect.strain + 12);
        events.push({ id: withdrawalEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "adaptation", succeeded: true, result: `${agent.name}在停用此前反复作用于身体的材料后出现烦躁、疲惫和身体不适`, diff: { agentId: agent.id, materialKind: adaptation.materialKind, adaptationLevel: adaptation.level, consecutiveUses: adaptation.consecutiveUses, yearsSinceUse, withdrawal: true, adaptationSourceEventIds: adaptation.sourceEventIds } });
      } else if (adaptation.withdrawalSinceTick !== undefined) {
        const supportedLastYear = adaptation.lastSupportedTick === nextTick - 1;
        adaptation.level = Math.max(0, adaptation.level - (supportedLastYear ? 0.8 : 0.35));
        if (adaptation.level <= 0.15) {
          const recoveryEventId = `w-${nextTick}-adaptation-recovery-${agent.id}`;
          events.push({ id: recoveryEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "adaptation", succeeded: true, result: `${agent.name}在没有再次使用该材料的情况下逐渐恢复，烦躁与身体不适消退`, diff: { agentId: agent.id, materialKind: adaptation.materialKind, recoveredWithoutReuse: true, withdrawalSinceTick: adaptation.withdrawalSinceTick, withdrawalEventIds: adaptation.withdrawalEventIds, supportEventIds: adaptation.supportEventIds, supportedYears: adaptation.supportedYears, adaptationSourceEventIds: adaptation.sourceEventIds } });
          delete agent.body.adaptation;
        }
      }
    }
    if (agent.body.state === "active") {
      const priorMode = agent.limbs.action?.type === "interact" ? agent.limbs.action.intent?.mode : agent.limbs.action?.type;
      const accumulation = priorMode === "hunt" || priorMode === "work" || priorMode === "shape" ? 2.4 : priorMode === "move" ? 1.5 : 0.8;
      agent.body.surfaceLoad = clamp((agent.body.surfaceLoad ?? 0) + accumulation, 0, 20);
      const oldAffectState = agent.mind.affect.state;
      const localDeaths = deathsLastYearByLocation.get(agent.locationId) ?? [];
      const relationLoss = localDeaths.reduce((sum, event) => {
        const deceasedId = String(event.diff.agentId ?? "");
        return sum + Math.max(0, agent.relations.find((relation) => relation.agentId === deceasedId)?.strength ?? 0) * 0.18;
      }, 0);
      const annualStrain = relationLoss
        + (next.epoch === "chaotic" ? next.severity * 1.8 : 0)
        + Math.max(0, 45 - agent.body.health) * 0.08
        + Math.max(0, 40 - agent.body.nutrition) * 0.07
        + (agent.body.illness ? 3 : 0)
        + (agent.standing.failedPredictions > 0 ? 1.5 : 0);
      const recovery = next.epoch === "stable" && agent.body.health > 60 && agent.body.nutrition > 45 ? 4 : 1;
      agent.mind.affect.strain = clamp(agent.mind.affect.strain + annualStrain - recovery);
      agent.mind.affect.state = agent.mind.affect.strain >= 72 ? "disorganized" : agent.mind.affect.strain >= 46 ? "distressed" : "regulated";
      if (agent.mind.affect.state !== oldAffectState) {
        const distressEventId = `w-${nextTick}-distress-${agent.id}-${agent.mind.affect.state}`;
        agent.mind.affect.sinceTick = agent.mind.affect.state === "regulated" ? undefined : nextTick;
        if (agent.mind.affect.state !== "regulated") agent.mind.affect.sourceEventIds = [...new Set([...agent.mind.affect.sourceEventIds, ...localDeaths.map((event) => event.id), distressEventId])];
        events.push({
          id: distressEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "distress", succeeded: true,
          result: agent.mind.affect.state === "regulated" ? `${agent.name}的言行逐渐恢复平稳` : agent.mind.affect.state === "distressed" ? `${agent.name}在损失与长期压力后出现持续惊惧、退缩或失眠` : `${agent.name}的压力继续累积，言行与日常秩序明显失去连贯`,
          diff: { agentId: agent.id, affectStateBefore: oldAffectState, affectStateAfter: agent.mind.affect.state, strain: agent.mind.affect.strain, causeEventIds: localDeaths.map((event) => event.id), relationLoss, climateStress: next.epoch === "chaotic" ? next.severity : 0 },
        });
      }
    }
    if (agent.body.ageYears === ELDER_AGE) events.push({
      id: `w-${nextTick}-aging-${agent.id}`, kind: "environment", tick: nextTick, where: agent.locationId, change: "survival", succeeded: true,
      result: `${agent.name}步入老年，体力恢复和抵御环境的余地开始缩小`, diff: { agentId: agent.id, bodyState: agent.body.state, cause: "aging", ageYears: agent.body.ageYears },
    });
    if (agent.body.endOfLife?.dueTick <= nextTick) {
      const decline = clone(agent.body.endOfLife);
      agent.body.state = "dead";
      delete agent.body.illness;
      delete agent.body.injury;
      delete agent.body.infectionExposure;
      delete agent.body.endOfLife;
      agent.mind.affect.state = "regulated";
      const deathFact: EnvironmentFact = {
        id: `w-${nextTick}-end-of-life-${agent.id}`, kind: "environment", tick: nextTick, where: agent.locationId, change: "survival", succeeded: true,
        result: `${agent.name}在持续衰退后于 ${agent.body.ageYears} 岁走到生命尽头${decline.comfortYears ? `；此前 ${decline.comfortYears} 年有人留在身边照料` : ""}`,
        diff: { agentId: agent.id, bodyState: "dead", cause: decline.cause, ageYears: agent.body.ageYears, endOfLife: true, endOfLifeSourceEventIds: decline.sourceEventIds, endOfLifeSupportEventIds: decline.supportEventIds, supportAgentIds: decline.supportAgentIds, comfortYears: decline.comfortYears },
      };
      events.push(deathFact);
      leaveRemains(state, agent, deathFact.id);
      continue;
    }
    if (agent.body.ageYears >= agent.body.lifespanYears && !agent.body.endOfLife) {
      const declineEventId = `w-${nextTick}-decline-${agent.id}`;
      agent.body.endOfLife = { sinceTick: nextTick, dueTick: nextTick + 5, cause: "old-age", sourceEventIds: [declineEventId], supportEventIds: [], supportAgentIds: [], comfortYears: 0 };
      agent.body.health = Math.min(agent.body.health, 32);
      agent.body.fatigue = Math.max(agent.body.fatigue, 82);
      events.push({
        id: declineEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "survival", succeeded: true,
        result: `${agent.name}的身体出现不可逆的持续衰退，已经无法再劳动，但仍会感到疲惫、不适与身边人的陪伴`,
        diff: { agentId: agent.id, bodyState: agent.body.state, cause: "end-of-life-decline", ageYears: agent.body.ageYears, dueTick: agent.body.endOfLife.dueTick, irreversible: true },
      });
    }
    if (agent.body.endOfLife) {
      agent.body.health = Math.max(8, agent.body.health - 2);
      agent.body.fatigue = Math.max(82, agent.body.fatigue);
      continue;
    }
    if (agent.body.pregnancy?.dueTick <= nextTick) {
      const father = state.agents.find((candidate) => candidate.id === agent.body.pregnancy?.fatherId && candidate.body.state !== "dead");
      if (father) {
        const pregnancy = agent.body.pregnancy;
        const supportEventIds = pregnancy.supportEventIds ?? [];
        const supportAgentIds = pregnancy.supportAgentIds ?? [];
        const attendantsPresent = supportAgentIds.filter((id) => state.agents.some((candidate) => candidate.id === id && candidate.body.state === "active" && candidate.locationId === agent.locationId));
        const birthEventId = `w-${nextTick}-birth-child-${nextTick}-${state.agents.length}`;
        const newborn = createNewborn(state, agent, father, nextTick, birthEventId);
        state.agents.push(newborn);
        for (const parent of [agent, father]) {
          parent.body.familyPlanning ??= { desiredChildCount: 2, birthCount: 0, sourceEventIds: [] };
          parent.body.familyPlanning.birthCount += 1;
          parent.body.familyPlanning.lastBirthTick = nextTick;
          parent.body.familyPlanning.sourceEventIds = [...new Set([...parent.body.familyPlanning.sourceEventIds, birthEventId, ...(pregnancy.conceptionEventId ? [pregnancy.conceptionEventId] : [])])];
        }
        for (const relative of state.agents) {
          if (relative.id === newborn.id || relative.body.state === "dead") continue;
          relative.relations.push({ agentId: newborn.id, strength: relative.id === agent.id || relative.id === father.id ? 78 : 30, word: relative.id === agent.id || relative.id === father.id ? "亲子依恋" : "同处聚落", sourceEventIds: [birthEventId] });
        }
        const unsafeBirth = next.epoch === "chaotic" || !completedShelterSites.has(agent.locationId);
        const supportedBirth = supportEventIds.length > 0 && attendantsPresent.length > 0;
        const motherHealthLoss = unsafeBirth ? supportedBirth ? 6 : 12 : supportedBirth ? 0 : 3;
        const newbornHealthLoss = unsafeBirth ? supportedBirth ? 9 : 18 : supportedBirth ? 0 : 4;
        agent.body.health = clamp(agent.body.health - motherHealthLoss);
        newborn.body.health = clamp(newborn.body.health - newbornHealthLoss);
        events.push({
          id: birthEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "birth", succeeded: true,
          result: `${agent.name}用一年时间孕育并生下${newborn.name}（初始年龄 ${newborn.body.ageYears} 岁）${unsafeBirth ? "；不安全的环境让母子健康受损" : "，聚落迎来新一代"}`,
          diff: { agentId: newborn.id, motherId: agent.id, fatherId: father.id, generation: newborn.lineage.generation, birthAge: newborn.body.ageYears, conceptionEventId: pregnancy.conceptionEventId ?? "", unsafeBirth, supportedBirth, supportEventIds, attendantAgentIds: attendantsPresent, motherHealthLoss, newbornHealthLoss, motherBirthCount: agent.body.familyPlanning.birthCount, fatherBirthCount: father.body.familyPlanning.birthCount },
        });
      }
      delete agent.body.pregnancy;
    }
    if (agent.body.state === "dehydrated") {
      agent.limbs.actionText = "脱水蛰伏 · 不事生产";
      agent.body.exposure = Math.max(0, agent.body.exposure - 1);
      continue;
    }
    if (next.epoch === "stable") {
      agent.body.exposure = Math.max(0, agent.body.exposure - 4);
      agent.body.temperature += (50 - agent.body.temperature) * 0.5;
    } else {
      const shelter = completedShelterSites.has(agent.locationId) ? 5 : 0;
      const resilience = Math.floor(agent.body.resilience / 24);
      const exposure = Math.max(1, next.severity * 2 - shelter - resilience);
      agent.body.exposure = clamp(agent.body.exposure + exposure);
      if (next.kind === "heat" || next.kind === "fire") agent.body.hydration = clamp(agent.body.hydration - next.severity * 2);
      agent.body.temperature = clamp(agent.body.temperature + (next.kind === "cold" ? -next.severity * 4 : next.severity * 4));
      const unprotectedDamage = Math.max(2, next.severity * 2.2 - shelter - resilience * 0.5);
      agent.body.health = clamp(agent.body.health - unprotectedDamage);
    }
    const physiologicalStress = Math.max(0, 35 - agent.body.nutrition) * 0.25 + Math.max(0, 30 - agent.body.hydration) * 0.35 + Math.max(0, agent.body.fatigue - 85) * 0.2 + Math.abs(agent.body.temperature - 50) * 0.08;
    agent.body.health = clamp(agent.body.health - physiologicalStress + (agent.body.nutrition > 60 && agent.body.hydration > 60 && agent.body.fatigue < 55 ? 1 : 0));
    if (agent.body.injury) {
      const injury = agent.body.injury;
      if (injury.mobilityLoss === undefined && injury.kind === "fall" && injury.severity >= 2) {
        injury.mobilityLoss = injury.severity * 7;
        injury.mobilityAtInjury = agent.limbs.abilities.move;
        if (deterministicFraction(state.seed, `lasting-mobility:${injury.sourceEventIds[0] ?? `${injury.sinceTick}:${agent.id}`}`) < 0.42) injury.lastingMobilityLoss = Math.max(3, injury.severity + 1);
      }
      if (injury.bleeding > 0) {
        agent.body.health = clamp(agent.body.health - injury.bleeding * 1.5);
        if (deterministicFraction(state.seed, `clot:${nextTick}:${agent.id}`) < 0.18) injury.bleeding = Math.max(0, injury.bleeding - 1);
      } else {
        const supported = Boolean(injury.supportId && carried(state, agent.id).some((matter) => matter.id === injury.supportId && matter.traits.includes("supportive")));
        const mobilityFloor = injury.lastingMobilityLoss ?? 0;
        if (supported) {
          injury.assistedYears = (injury.assistedYears ?? 0) + 1;
          injury.mobilityLoss = Math.max(mobilityFloor, (injury.mobilityLoss ?? 0) - 4);
          agent.limbs.abilities.move = clamp(agent.limbs.abilities.move + 2);
        } else if ((injury.mobilityLoss ?? 0) > mobilityFloor) injury.mobilityLoss = Math.max(mobilityFloor, (injury.mobilityLoss ?? 0) - 1);
        if ((injury.mobilityLoss ?? 0) <= mobilityFloor) injury.severity = Math.max(0, injury.severity - 1);
      }
      if (injury.severity <= 0 && (injury.mobilityLoss ?? 0) <= 0) delete agent.body.injury;
    } else {
      const priorMode = agent.limbs.action?.type === "interact" ? agent.limbs.action.intent?.mode : agent.limbs.action?.type === "move" ? "move" : undefined;
      const localAnimals = matterAt(state, agent.locationId).some((matter) => matter.traits.includes("animal"));
      const accidentRisk = 0.012
        + Math.max(0, agent.body.fatigue - 65) * 0.0012
        + (priorMode === "hunt" ? 0.16 : priorMode === "shape" || priorMode === "work" ? 0.035 : priorMode === "move" ? 0.012 : 0)
        + (localAnimals ? 0.012 : 0)
        + (next.epoch === "chaotic" ? next.severity * 0.006 : 0);
      if (deterministicFraction(state.seed, `injury:${nextTick}:${agent.id}`) < Math.min(0.45, accidentRisk)) {
        const injuryKind = priorMode === "hunt" && localAnimals ? "animal-bite" as const : priorMode === "shape" ? "cut" as const : "fall" as const;
        const injuryEventId = `w-${nextTick}-injury-${agent.id}`;
        const severity = priorMode === "hunt" || next.epoch === "chaotic" ? 3 : 2;
        const bleeding = injuryKind === "fall" ? 1 : 2;
        const mobilityLoss = injuryKind === "fall" ? severity * 7 : 0;
        const lastingMobilityLoss = mobilityLoss && deterministicFraction(state.seed, `lasting-mobility:${injuryEventId}`) < 0.42 ? Math.max(3, severity + 1) : 0;
        agent.body.injury = { kind: injuryKind, severity, bleeding, sinceTick: nextTick, sourceEventIds: [injuryEventId], ...(mobilityLoss ? { mobilityLoss, mobilityAtInjury: agent.limbs.abilities.move, ...(lastingMobilityLoss ? { lastingMobilityLoss } : {}) } : {}) };
        if (mobilityLoss) agent.limbs.abilities.move = clamp(agent.limbs.abilities.move - Math.ceil(mobilityLoss / 2), 35, 100);
        agent.body.health = clamp(agent.body.health - severity * 2);
        events.push({
          id: injuryEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "injury", succeeded: true,
          result: `${agent.name}在${priorMode === "hunt" ? "接近动物" : priorMode === "shape" ? "使用材料和工具" : priorMode === "work" ? "劳作" : "移动与日常活动"}中${injuryKind === "animal-bite" ? "被咬伤" : injuryKind === "cut" ? "被割伤" : "跌伤"}，疼痛强度 ${severity}、液体流失 ${bleeding}`,
          diff: { agentId: agent.id, injuryKind, severity, bleeding, mobilityLoss, lastingMobilityLoss, mobilityBefore: agent.body.injury.mobilityAtInjury ?? agent.limbs.abilities.move, mobilityAfter: agent.limbs.abilities.move, causeActionMode: priorMode ?? "daily-activity" },
        });
      }
    }
    if (agent.body.illness) {
      const illness = agent.body.illness;
      illness.durationYears = (illness.durationYears ?? Math.max(1, nextTick - illness.sinceTick)) + 1;
      if (illness.course === "persistent" && illness.durationYears >= 3) illness.persistentSinceTick ??= illness.sinceTick;
      const sheltered = completedShelterSites.has(agent.locationId);
      const naturallyRecovering = sheltered && agent.body.nutrition > 60 && agent.body.hydration > 60 && agent.body.health > 45;
      const worsening = agent.body.nutrition < 35 || agent.body.hydration < 35 || agent.body.exposure > 55;
      const severityFloor = illness.course === "persistent" ? 1 : 0;
      illness.severity = clamp(Math.max(severityFloor, illness.severity + (worsening ? 1 : naturallyRecovering ? -1 : 0)), 0, 6);
      agent.body.health = clamp(agent.body.health - illness.severity * 1.0);
      const illnessFact: EnvironmentFact = {
        id: `w-${nextTick}-illness-course-${agent.id}`, kind: "environment", tick: nextTick, where: agent.locationId, change: "illness", succeeded: true,
        result: illness.severity <= 0 ? `${agent.name}依靠充足饮食和住所从${illness.kind === "fever" ? "热病" : "伤口感染"}中自行恢复` : `${agent.name}的${illness.kind === "fever" ? "热病" : "伤口感染"}仍在持续，病情强度为 ${illness.severity}`,
        diff: { agentId: agent.id, illnessKind: illness.kind, illnessCourse: illness.course ?? "acute", illnessSinceTick: illness.sinceTick, durationYears: illness.durationYears, persistent: illness.course === "persistent" && illness.durationYears >= 3, severity: illness.severity, onset: false, naturallyRecovered: illness.severity <= 0, worsening },
      };
      illness.sourceEventIds = [...new Set([...illness.sourceEventIds, illnessFact.id])];
      events.push(illnessFact);
      if (illness.severity <= 0) delete agent.body.illness;
    } else {
      const sickContacts = state.agents.filter((other) => other.id !== agent.id && illAtYearStart.has(other.id) && other.locationId === agent.locationId && other.body.state === "active" && other.body.illness);
      const illContacts = sickContacts.length;
      const exposure = exposureAtYearStart.get(agent.id);
      const risk = 0.018
        + Math.max(0, 70 - agent.body.health) * 0.003
        + Math.max(0, 55 - agent.body.nutrition) * 0.002
        + agent.body.exposure * 0.0015
        + agent.body.surfaceLoad * 0.0025
        + illContacts * 0.02
        + (exposure?.load ?? 0) * 0.028
        + (agent.body.ageYears >= ELDER_AGE ? 0.025 : 0);
      if (deterministicFraction(state.seed, `illness:${nextTick}:${agent.id}`) < Math.min(0.45, risk)) {
      const illnessKind = agent.body.injury || agent.body.exposure > 28 || agent.body.health < 40 ? "wound-infection" as const : "fever" as const;
      const illnessEventId = `w-${nextTick}-illness-onset-${agent.id}`;
      const severity = physiologicalStress > 12 || agent.body.exposure > 45 ? 3 : 2;
        const contactSourceEventIds = [...new Set([...sickContacts.flatMap((other) => other.body.illness?.sourceEventIds ?? []), ...(exposure?.sourceEventIds ?? [])])];
        const contactLinked = illContacts > 0 || Boolean(exposure?.load);
        const persistentRisk = clamp(
          0.04
          + (illnessKind === "wound-infection" ? 0.08 : 0)
          + Math.max(0, 60 - agent.body.resilience) * 0.003
          + Math.max(0, 55 - agent.body.health) * 0.004
          + (agent.body.ageYears >= ELDER_AGE ? 0.12 : 0)
          + (agent.body.ageYears < ADULT_WORK_AGE ? 0.05 : 0),
          0.04,
          0.48,
        );
        const illnessCourse = deterministicFraction(state.seed, `illness-course:${nextTick}:${agent.id}`) < persistentRisk ? "persistent" as const : "acute" as const;
        agent.body.illness = { kind: illnessKind, course: illnessCourse, severity, sinceTick: nextTick, durationYears: 1, sourceEventIds: [illnessEventId], contactLinked, contactSourceEventIds };
        delete agent.body.infectionExposure;
        agent.body.health = clamp(agent.body.health - 3);
        if (illnessKind === "fever") for (const contact of state.agents.filter((other) => other.id !== agent.id && other.body.state === "active" && !other.body.illness && other.locationId === agent.locationId)) {
          const prior = contact.body.infectionExposure;
          contact.body.infectionExposure = {
            load: clamp((prior?.load ?? 0) + 1 + severity * 0.5, 0, 8),
            exposedTick: nextTick,
            sourceAgentIds: [...new Set([...(prior?.sourceAgentIds ?? []), agent.id])],
            sourceEventIds: [...new Set([...(prior?.sourceEventIds ?? []), illnessEventId])],
          };
        }
        events.push({
          id: illnessEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "illness", succeeded: true,
          result: `${agent.name}在${contactLinked ? "此前与病人同处、" : ""}身体消耗与环境暴露后出现${illnessKind === "fever" ? "热病" : "伤口感染"}，病情强度为 ${severity}${illnessCourse === "persistent" ? "，身体恢复倾向显示病程可能持续" : ""}`,
          diff: { agentId: agent.id, illnessKind, illnessCourse, severity, onset: true, illContacts, infectionExposureLoad: exposure?.load ?? 0, contactSourceEventIds, health: agent.body.health, nutrition: agent.body.nutrition, exposure: agent.body.exposure },
        });
      } else if (exposure && agent.body.infectionExposure) {
        agent.body.infectionExposure.load = Math.max(0, agent.body.infectionExposure.load - 0.75);
        if (agent.body.infectionExposure.load <= 0) delete agent.body.infectionExposure;
      }
    }
    if (agent.body.exposure >= 100 || agent.body.hydration <= 0 || agent.body.nutrition <= 0 || agent.body.health <= 0) {
      const lifeFailureCause = agent.body.nutrition <= 0 ? "starvation" : agent.body.illness ? "disease" : next.kind;
      const declineEligible = lifeFailureCause === "disease" && agent.body.ageYears >= ELDER_AGE && agent.body.health <= 0;
      if (declineEligible && !agent.body.endOfLife) {
        const declineEventId = `w-${nextTick}-decline-${agent.id}`;
        agent.body.endOfLife = { sinceTick: nextTick, dueTick: nextTick + 5, cause: "irreversible-decline", sourceEventIds: [...new Set([...(agent.body.illness?.sourceEventIds ?? []), declineEventId])], supportEventIds: [], supportAgentIds: [], comfortYears: 0 };
        agent.body.health = 8;
        agent.body.fatigue = Math.max(agent.body.fatigue, 88);
        events.push({ id: declineEventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "survival", succeeded: true, result: `${agent.name}年老后的病情已经造成不可逆衰退，身体无法再劳动，但仍会感到疲惫、不适与身边人的陪伴`, diff: { agentId: agent.id, bodyState: agent.body.state, cause: "end-of-life-decline", ageYears: agent.body.ageYears, dueTick: agent.body.endOfLife.dueTick, irreversible: true, illnessSourceEventIds: agent.body.illness?.sourceEventIds ?? [] } });
        continue;
      }
      agent.body.state = "dead";
      const cause = lifeFailureCause;
      const deathFact: EnvironmentFact = {
        id: `w-${nextTick}-death-${agent.id}`, kind: "environment", tick: nextTick, where: agent.locationId, change: "survival", succeeded: true,
        result: agent.body.nutrition <= 0 ? `${agent.name}长期没有获得食物，生命活动停止` : cause === "disease" ? `${agent.name}的病情持续恶化，生命活动停止` : `${agent.name}未提前脱水，未能承受${climateLabel(next.kind)}，生命活动停止`,
        diff: { agentId: agent.id, bodyState: "dead", cause },
      };
      events.push(deathFact);
      delete agent.body.illness;
      delete agent.body.injury;
      delete agent.body.infectionExposure;
      agent.mind.affect.state = "regulated";
      leaveRemains(state, agent, deathFact.id);
    }
  }
  for (const agent of state.agents) {
    for (const hypothesis of agent.mind.cognition.hypotheses.filter((item) => item.status === "pending" && item.dueTick <= nextTick)) {
      const confirmed = hypothesis.predictedEpoch === next.epoch && hypothesis.predictedClimate === next.kind;
      hypothesis.status = confirmed ? "confirmed" : "failed";
      agent.standing.respect = predictionRespect(agent.standing.respect, confirmed);
      if (confirmed) agent.standing.correctPredictions += 1;
      else agent.standing.failedPredictions += 1;
      const eventId = `w-${nextTick}-prediction-${agent.id}-${hypothesis.id}`;
      hypothesis.resolutionEventId = eventId;
      const seriousLoss = !confirmed && (hypothesis.followers?.length ?? 0) >= 2;
      const executed = seriousLoss && agent.standing.failedPredictions >= 2 && agent.body.state !== "dead";
      if (executed) {
        agent.body.state = "dead";
        delete agent.body.illness;
        delete agent.body.injury;
        delete agent.body.infectionExposure;
      }
      const result = confirmed
        ? `${agent.name}的预言应验，群体尊重升至 ${Math.round(agent.standing.respect)}：第 ${nextTick} 年为${next.epoch === "stable" ? "恒纪元" : "乱纪元"}、${climateLabel(next.kind)}`
        : `${agent.name}的预言落空，受到唾弃，群体尊重降至 ${Math.round(agent.standing.respect)}${seriousLoss ? `；${hypothesis.followers?.length ?? 0} 人因误信而停产脱水` : ""}${executed ? "，因反复造成严重损失被处死" : ""}`;
      const predictionFact: EnvironmentFact = { id: eventId, kind: "environment", tick: nextTick, where: agent.locationId, change: "prediction", succeeded: true, result, diff: { hypothesisId: hypothesis.id, confirmed, predictedEpoch: hypothesis.predictedEpoch, actualEpoch: next.epoch, predictedClimate: hypothesis.predictedClimate, actualClimate: next.kind, respect: agent.standing.respect, seriousLoss, executed } };
      events.push(predictionFact);
      if (executed) leaveRemains(state, agent, predictionFact.id);
      remember(agent, { agentId: agent.id, factIds: [eventId], interpretation: confirmed ? "这次结果暂时支持我的方法，但不证明未来永远如此" : "这次失败说明旧记录或模型不足，不能把预测当成确定未来" }, predictionFact);
      learn(agent, confirmed ? "有来源的预测可以等待未来事实检验" : "预测失败也能成为改进观测与模型的证据", confirmed ? 68 : 78, eventId);
    }
  }
  return events;
}

function perceiveEnvironmentFacts(state: SimulationState, facts: EnvironmentFact[]) {
  for (const fact of facts) {
    const affectedId = typeof fact.diff.agentId === "string" ? fact.diff.agentId : null;
    for (const witness of state.agents.filter((agent) => agent.body.state !== "dead" && (agent.id === affectedId || agent.locationId === fact.where))) {
      const self = witness.id === affectedId;
      remember(witness, {
        agentId: witness.id,
        factIds: [fact.id],
        interpretation: self ? `我亲身感到：${fact.result}` : `我在眼前看见：${fact.result}`,
      }, fact);
    }
    if (fact.change === "illness" && fact.diff.onset === true && (Number(fact.diff.illContacts) > 0 || Number(fact.diff.infectionExposureLoad) > 0) && affectedId) {
      const affected = state.agents.find((agent) => agent.id === affectedId);
      if (affected) learn(affected, "我曾与病人近距离相处，随后自己也出现了相似病症；继续靠近他人可能带来同样后果", 58, fact.id, "contact-illness-association", Array.isArray(fact.diff.contactSourceEventIds) ? fact.diff.contactSourceEventIds.filter((id): id is string => typeof id === "string") : []);
    }
  }
}

function finishCivilization(state: SimulationState) {
  state.civilization.stage = civilizationStage(state, state.derived.milestones);
  if (state.civilization.status === "ended") return;
  const living = state.agents.filter((agent) => agent.body.state !== "dead");
  let kind: CivilizationOutcome["kind"] | null = null;
  let cause = "";
  if (living.length === 0) {
    kind = "destroyed";
    const deathCauses = state.world.time.past
      .filter((event): event is EnvironmentFact => event.kind === "environment" && event.change === "survival")
      .map((event) => event.diff?.cause)
      .filter((value): value is string => typeof value === "string");
    cause = deathCauses.length > 0 && deathCauses.every((value) => value === "starvation")
      ? "饥荒"
      : "全体成员死亡";
  } else if (state.civilization.integrity <= 0) {
    kind = "destroyed";
    cause = climateLabel(state.civilization.climate.kind);
  } else if (state.civilization.conditions.endpoint.kind === "ticks" && state.tick - state.civilization.startedAtTick >= state.civilization.conditions.endpoint.value) {
    kind = "boundary";
    cause = `到达第 ${state.civilization.conditions.endpoint.value} 年观察边界`;
  } else if (state.civilization.conditions.endpoint.kind === "milestones" && state.derived.milestones.length >= state.civilization.conditions.endpoint.value) {
    kind = "milestones";
    cause = `形成 ${state.derived.milestones.length} 个可追溯里程碑`;
  }
  if (!kind) return;
  const dehydrations = state.agents.reduce((sum, agent) => sum + agent.body.dehydrations, 0);
  const soakings = state.agents.reduce((sum, agent) => sum + agent.body.soakings, 0);
  const resolvedPredictions = state.agents.flatMap((agent) => agent.mind.cognition.hypotheses).filter((hypothesis) => hypothesis.status !== "pending");
  const failedPredictions = resolvedPredictions.filter((hypothesis) => hypothesis.status === "failed").length;
  const highlights: string[] = [];
  if (dehydrations) highlights.push(`${dehydrations} 次脱水让个体在乱纪元停止活动并保存身体`);
  if (soakings) highlights.push(`${soakings} 次浸泡使脱水者在恒纪元重新活动`);
  if (state.derived.milestones.some((milestone) => milestone.id === "53")) highlights.push("历法由连续观测、物质记录与推理形成");
  const model = state.world.matter.find((matter) => matter.traits.includes("instrument") && matter.construction?.complete);
  if (model) highlights.push(`${model.name}由 ${new Set((model.sourceEventIds ?? []).map((id) => state.world.time.past.find((event) => event.id === id && event.kind === "action")?.who).filter(Boolean)).size} 人接入材料完成`);
  if (resolvedPredictions.length) highlights.push(`${failedPredictions}/${resolvedPredictions.length} 个天象预测被后来年份的世界事实否定`);
  state.civilization.status = "ended";
  state.civilization.outcome = {
    kind, cause, atTick: state.tick, highlights,
    summary: `第${state.civilization.number}号文明${kind === "destroyed" ? `毁于${cause}` : `在${cause}时结束观察`}，演化至${state.civilization.stage}；形成${state.derived.milestones.length}个可追溯里程碑，完成${dehydrations}次脱水与${soakings}次浸泡${resolvedPredictions.length ? `，${failedPredictions}/${resolvedPredictions.length} 次天象预测失败` : ""}。`,
  };
}

function finishStep(state: SimulationState, facts: WorldEvent[]) {
  state.tick += 1;
  state.world.time.present = state.tick;
  state.world.time.past.push(...facts);
  refreshDrives(state);
  state.derived = deriveObservations(state);
  state.civilization.stage = civilizationStage(state, state.derived.milestones);
  state.lastStep = facts;
  finishCivilization(state);
  return state;
}
export function stepSimulation(input: SimulationState, decider: AgentDecider = new MockDecider()) {
  if (input.civilization.status === "ended") return clone(input);
  const state = clone(input);
  const environmentFacts = advanceEnvironment(state);
  perceiveEnvironmentFacts(state, environmentFacts);
  const facts: ActionFact[] = [];
  ANNUAL_PHASES.forEach((phase, phaseIndex) => state.agents.forEach((agent, agentIndex) => {
    if (!canProduce(agent)) return;
    const executed = executeAction(state, agent, decider.decide(contextFor(state, agent)), phaseIndex * state.agents.length + agentIndex, phase);
    facts.push(executed.fact);
    remember(agent, executed.interpretation, executed.fact);
    observeAction(state, executed.fact);
  }));
  for (const agent of state.agents) consolidateMemoryLocally(agent, state.tick + 1);
  return finishStep(state, [...environmentFacts, ...facts]);
}
export async function stepSimulationAsync(input: SimulationState, batch: BatchDecider, fallback: AgentDecider = new MockDecider()) {
  if (input.civilization.status === "ended") return clone(input);
  const state = clone(input);
  const environmentFacts = advanceEnvironment(state);
  perceiveEnvironmentFacts(state, environmentFacts);
  const initialContexts = buildDecisionContexts(state);
  // 模型只负责少数人物当年的关键选择，其余人物使用确定性的本地规则。
  // 每年从可行动者中轮换两人，既显著降低 token，也避免总是偏向数组前部的人物。
  const eligibleIndexes = state.agents.flatMap((agent, index) => canProduce(agent) ? [index] : []);
  const modelDecisionIndexes: number[] = [];
  if (eligibleIndexes.length > 0) {
    const decisionCount = Math.min(2, eligibleIndexes.length);
    const offset = (state.tick * decisionCount) % eligibleIndexes.length;
    for (let index = 0; index < decisionCount; index += 1) {
      modelDecisionIndexes.push(eligibleIndexes[(offset + index) % eligibleIndexes.length]);
    }
  }
  const modelContexts = modelDecisionIndexes.map((index) => initialContexts[index]);
  const modelDecisions = await batch.decideAll(modelContexts);
  const decisionsByAgentId = new Map(modelContexts.map((context, index) => [context.agent.id, modelDecisions[index] ?? null]));
  const facts: ActionFact[] = [];
  state.agents.forEach((agent, index) => {
    if (!canProduce(agent)) return;
    const chosen = decisionsByAgentId.get(agent.id) ?? fallback.decide(initialContexts[index]);
    if (chosen.memoryConsolidation) applyMemoryConsolidation(agent, chosen.memoryConsolidation, state.tick + 1);
    else consolidateMemoryLocally(agent, state.tick + 1);
    const executed = executeAction(state, agent, chosen, index, "spring");
    facts.push(executed.fact);
    remember(agent, executed.interpretation, executed.fact);
    observeAction(state, executed.fact);
  });
  return finishStep(state, [...environmentFacts, ...facts]);
}

export function injectEnvironmentEvent(inputState: SimulationState, input: EnvironmentEventInput) {
  const state = clone(inputState);
  const site = location(state, input.locationId);
  let result = input.description ?? "世界发生了一次局部变化";
  const diff: Record<string, number | string | boolean> = {};
  if (input.kind === "resource") {
    let matter = matterAt(state, input.locationId).find((item) => item.kind === input.resource);
    if (!matter) {
      matter = baseMatter(`${input.resource}-${input.locationId}`, input.resource, input.resource, { kind: "space", id: input.locationId }, 0, 1, { [input.resource]: 1 }, ["raw"]);
      state.world.matter.push(matter);
    }
    matter.quantity = Math.max(0, matter.quantity + input.delta);
    diff[input.resource] = input.delta;
    result = input.description ?? `${site?.name ?? input.locationId}的${matter.name}${input.delta >= 0 ? "增加" : "减少"} ${Math.abs(input.delta)}`;
  } else if (input.kind === "access" && site) {
    site.open = input.open;
    diff.open = input.open;
    result = input.description ?? `${site.name}${input.open ? "重新可进入" : "暂时无法进入"}`;
  } else if (input.kind === "weather") {
    diff.severity = input.severity;
    result = input.description ?? `${site?.name ?? input.locationId}出现强度 ${input.severity} 的风雨`;
  }
  const event: EnvironmentFact = { id: `w-${state.tick}-${state.world.time.past.length}`, kind: "environment", tick: state.tick, where: input.locationId, change: input.kind, succeeded: true, result, diff };
  state.world.time.past.push(event);
  state.agents.filter((agent) => agent.locationId === input.locationId).forEach((agent) => remember(agent, { agentId: agent.id, factIds: [event.id], interpretation: `${agent.name}把“${result}”理解为眼前环境已经改变` }, event));
  state.derived = deriveObservations(state);
  state.lastStep = [event];
  return state;
}

export function resetSimulation(seed = 17, config: Partial<SimulationConfig> = {}) { return createInitialState(seed, config) }
export function explainAgent(state: SimulationState, agentId: AgentId, factId?: string): AgentExplanation {
  const agent = state.agents.find((item) => item.id === agentId)!;
  const reading = [...agent.mind.cognition.interpretations].reverse().find((item) => !factId || item.factIds.includes(factId));
  const fact = factId ? state.world.time.past.find((item) => item.id === factId) : reading ? state.world.time.past.find((item) => reading.factIds.includes(item.id)) : undefined;
  return { agentId, factId: fact?.id, fact: fact?.result ?? "尚无属于这个人的历史事实", interpretation: reading?.interpretation ?? (factId ? "这件事没有进入他的局部经验" : agent.mind.cognition.interpretation) };
}

export interface SimulationController {
  getState(): SimulationState;
  step(count?: number): SimulationState;
  stepAsync(batch: BatchDecider, count?: number): Promise<SimulationState>;
  reset(): SimulationState;
  restore(saved: SimulationState): SimulationState;
  setExternalClimate(epoch: EpochKind, kind: ClimateKind, severity: number): SimulationState;
  injectEvent(input: EnvironmentEventInput): SimulationState;
  explain(agentId: AgentId): AgentExplanation;
}
export function createSimulation(options: { seed?: number; decider?: AgentDecider; config?: Partial<SimulationConfig>; state?: SimulationState } = {}): SimulationController {
  let state = options.state ? migrateSimulationState(options.state) : createInitialState(options.seed, options.config);
  let revision = 0;
  return {
    getState: () => clone(state),
    step(count = 1) {
      revision += 1;
      for (let index = 0; index < count; index += 1) state = stepSimulation(state, options.decider);
      return clone(state);
    },
    async stepAsync(batch, count = 1) {
      const startedAt = revision;
      let candidate = clone(state);
      for (let index = 0; index < count; index += 1) candidate = await stepSimulationAsync(candidate, batch, options.decider);
      if (revision === startedAt) { state = candidate; revision += 1; }
      return clone(state);
    },
    reset() { revision += 1; state = resetSimulation(options.seed, state.civilization.conditions); return clone(state) },
    restore(saved) { revision += 1; state = migrateSimulationState(saved); return clone(state) },
    setExternalClimate(epoch, kind, severity) {
      revision += 1;
      state.civilization.externalClimate = { epoch, kind, severity: clamp(severity, 1, 10) };
      return clone(state);
    },
    injectEvent(input) { revision += 1; state = injectEnvironmentEvent(state, input); return clone(state) },
    explain: (agentId) => explainAgent(state, agentId),
  };
}

export function buildEvolutionReport(finalState: SimulationState, checkpoints: SimulationState[] = []): EvolutionReport {
  const actions = finalState.world.time.past.filter((event): event is ActionFact => event.kind === "action");
  const successful = actions.filter((event) => event.succeeded).length;
  return {
    schemaVersion: 10,
    exportedAt: new Date().toISOString(),
    civilization: clone(finalState.civilization),
    finalState: clone(finalState),
    checkpoints: checkpoints.map((checkpoint) => clone(checkpoint)),
    review: {
      milestones: clone(finalState.derived.milestones),
      issues: clone(finalState.derived.issues),
      actionSuccessRate: actions.length ? Math.round(successful / actions.length * 100) : 0,
      eventCount: finalState.world.time.past.length,
    },
  };
}

export function migrateSimulationState(input: SimulationState): SimulationState {
  const state = clone(input) as SimulationState;
  const previousSchemaVersion = Number(input.schemaVersion ?? 0);
  state.schemaVersion = 10;
  state.timeScale = { unit: "year", actionsPerAgent: ANNUAL_PHASES.length };
  state.civilization.integrity ??= 100;
  const originMatter = [
    { ...baseMatter("bitter-herb-river", "bitter-herb", "苦味河草", { kind: "space", id: "river" }, 18, 0.1, { plant: 1 }, ["raw", "botanical"]), bodyEffect: { fever: 1, woundInfection: 0, strain: 0, toxicity: 0.05 } },
    { ...baseMatter("soothing-leaf-field", "soothing-leaf", "芳香叶片", { kind: "space", id: "field" }, 16, 0.08, { plant: 1 }, ["raw", "botanical"]), bodyEffect: { fever: 1, woundInfection: 0, strain: 5, toxicity: 0, adaptation: 0.8 } },
    { ...baseMatter("irritant-root-homes", "irritant-root", "辛烈根茎", { kind: "space", id: "homes" }, 12, 0.12, { plant: 1 }, ["raw", "botanical"]), bodyEffect: { fever: 0, woundInfection: 0, strain: 0, toxicity: 0.35 } },
  ];
  if (previousSchemaVersion < 9) for (const matter of originMatter) if (!state.world.matter.some((existing) => existing.id === matter.id || existing.kind === matter.kind)) state.world.matter.push(matter);
  for (const matter of state.world.matter) {
    if (!matter.construction) continue;
    matter.construction.useEventIds ??= [];
    if (!matter.construction.effects && matter.construction.complete) {
      const legacyShelter = matter.traits.includes("shelter");
      matter.construction.purpose ??= legacyShelter ? "shelter" : matter.traits.includes("instrument") ? "instrument" : "platform";
      matter.construction.arrangement ??= legacyShelter
        ? { support: 72, cover: 78, boundary: 68, opening: 32 }
        : { support: 55, cover: 30, boundary: 25, opening: 70 };
      matter.construction.effects = {
        structuralStability: legacyShelter ? 70 : 50,
        weatherProtection: legacyShelter ? 68 : 25,
        thermalInsulation: legacyShelter ? 55 : 20,
        enclosure: legacyShelter ? 62 : 15,
        capacity: Math.max(1, Math.floor(matter.unitMass / 2)),
      };
    }
  }
  for (const agent of state.agents) {
    agent.profile ??= {
      description: `${agent.name}从既有经历中形成了对生存、安全、联结、尊重与实现的不同关注。`,
      personality: inferMaslowPersonality(`${agent.name}重视生存、安全、同伴、责任与学习。`),
    };
    const legacyMind = agent.mind as unknown as {
      needs?: Partial<AgentState["mind"]["needs"]>;
      affect?: Partial<AgentState["mind"]["affect"]>;
      cognition?: Partial<AgentState["mind"]["cognition"]>;
      id?: { want?: string; pressure?: number; drives?: DriveState[] };
      ego?: Partial<AgentState["mind"]["cognition"]>;
    };
    const legacyCognition = legacyMind.cognition ?? legacyMind.ego ?? {};
    const legacyMemory = legacyCognition.memory as Partial<AgentMemory> | undefined;
    agent.mind = {
      needs: {
        focus: legacyMind.needs?.focus ?? legacyMind.id?.want ?? "先维持身体与眼前生活",
        intensity: legacyMind.needs?.intensity ?? legacyMind.id?.pressure ?? 50,
        dominantLevel: legacyMind.needs?.dominantLevel ?? "physiological",
        drives: legacyMind.needs?.drives ?? legacyMind.id?.drives ?? [],
        layers: legacyMind.needs?.layers ?? [],
      },
      affect: {
        strain: legacyMind.affect?.strain ?? 8,
        state: legacyMind.affect?.state ?? "regulated",
        ...(legacyMind.affect?.sinceTick !== undefined ? { sinceTick: legacyMind.affect.sinceTick } : {}),
        sourceEventIds: legacyMind.affect?.sourceEventIds ?? [],
        supportEventIds: legacyMind.affect?.supportEventIds ?? [],
      },
      cognition: {
        perception: legacyCognition.perception ?? "我只知道眼前地点里发生的事",
        choice: legacyCognition.choice ?? "先观察眼前条件",
        interpretation: legacyCognition.interpretation ?? "还没有足够事实形成判断",
        interpretations: legacyCognition.interpretations ?? [],
        knowledge: legacyCognition.knowledge ?? [],
        hypotheses: legacyCognition.hypotheses ?? [],
        memory: {
          episodic: legacyMemory?.episodic ?? [],
          summaries: legacyMemory?.summaries ?? [],
          capacity: legacyMemory?.capacity ?? memoryCapacityForReason(agent.limbs.abilities.reason ?? 45),
          forgottenCount: legacyMemory?.forgottenCount ?? 0,
          lastConsolidatedTick: legacyMemory?.lastConsolidatedTick ?? 0,
        },
      },
    };
    const abilities = agent.limbs.abilities as AgentState["limbs"]["abilities"] & { observe?: number; reason?: number };
    if (previousSchemaVersion < 10) abilities.move = Math.max(60, abilities.move ?? 60);
    abilities.observe ??= 50;
    abilities.reason ??= 45;
    agent.mind.cognition.memory.capacity = memoryCapacityForReason(abilities.reason);
    if (!legacyMemory) {
      const fragments = agent.mind.cognition.interpretations.slice(-agent.mind.cognition.memory.capacity).flatMap((reading) => {
        const fact = state.world.time.past.find((event) => reading.factIds.includes(event.id));
        return fact ? [{
          id: fact.id,
          tick: fact.tick,
          summary: reading.interpretation,
          salience: memorySalience(fact),
          sourceEventIds: [fact.id],
          ...(fact.kind === "action" ? { actionKey: actionKey(fact.action), succeeded: fact.succeeded } : {}),
        } satisfies MemoryFragment] : [];
      });
      agent.mind.cognition.memory.episodic = fragments;
    }
    agent.body.nutrition ??= 70;
    agent.body.surfaceLoad ??= 0;
    if (agent.body.illness) {
      agent.body.illness.course ??= agent.body.illness.persistentSinceTick !== undefined ? "persistent" : "acute";
      agent.body.illness.durationYears ??= Math.max(1, state.tick - agent.body.illness.sinceTick + 1);
    }
    if (agent.body.pregnancy) {
      agent.body.pregnancy.supportEventIds ??= [];
      agent.body.pregnancy.supportAgentIds ??= [];
    }
    const historicalBirths = state.world.time.past.filter((event) => event.kind === "environment" && event.change === "birth" && (event.diff.motherId === agent.id || event.diff.fatherId === agent.id));
    agent.body.familyPlanning ??= {
      desiredChildCount: 1 + Math.floor(deterministicFraction(state.seed, `desired-children:${agent.id}`) * 3),
      birthCount: historicalBirths.length,
      lastBirthTick: historicalBirths.at(-1)?.tick,
      sourceEventIds: historicalBirths.map((event) => event.id),
    };
    if (agent.body.infectionExposure) {
      agent.body.infectionExposure.sourceAgentIds ??= [];
      agent.body.infectionExposure.sourceEventIds ??= [];
      agent.body.infectionExposure.exposedTick ??= state.tick;
    }
    agent.body.homeLocationId ??= agent.locationId;
    agent.body.health ??= 90;
    agent.body.fatigue ??= 25;
    agent.body.temperature ??= 50;
    agent.body.ageYears ??= 24;
    agent.lineage ??= { generation: 0 };
    agent.standing ??= { respect: 40, correctPredictions: 0, failedPredictions: 0, careTrust: 0 };
    agent.standing.careTrust ??= 0;
    agent.standing.correctPredictions ??= agent.mind.cognition.hypotheses.filter((hypothesis) => hypothesis.status === "confirmed").length;
    agent.standing.failedPredictions ??= agent.mind.cognition.hypotheses.filter((hypothesis) => hypothesis.status === "failed").length;
    agent.body.sex ??= createBiologicalSex(state.seed + state.civilization.number * 997, agent.id);
    agent.body.lifespanYears ??= createLifespan(state.seed + state.civilization.number * 997, agent.id, agent.body.ageYears);
    for (const hypothesis of agent.mind.cognition.hypotheses) {
      hypothesis.followers ??= [];
      hypothesis.respectAtPrediction ??= agent.standing.respect;
    }
  }
  state.lineage ??= {
    kind: state.civilization.conditions.startingPoint === "origin" ? "origin" : "accelerated-checkpoint",
    originSeed: state.seed,
    checkpoint: state.civilization.conditions.startingPoint,
    prehistoryConfig: { ...clone(state.civilization.conditions), startingPoint: "origin" },
    prehistoryYears: state.civilization.startedAtTick,
    sourceEventCount: state.world.time.past.length,
    verifiedFromOrigin: state.civilization.conditions.startingPoint === "origin",
    reachedMilestoneIds: [],
  };
  state.derived = deriveObservations(state);
  refreshDrives(state);
  state.civilization.stage = civilizationStage(state, state.derived.milestones);
  return state;
}

export function buildArchiveReview(reports: EvolutionReport[]): ArchiveReview {
  return buildArchiveReviewFromSummaries(reports.filter((report) => report?.finalState?.civilization && report.review).map((report) => {
    const hypotheses = report.finalState.agents.flatMap((agent) => agent.mind.cognition.hypotheses ?? []).filter((hypothesis) => hypothesis.status !== "pending");
    return { civilizationNo: report.civilization.number, milestones: report.review.milestones, issues: report.review.issues, predictionConfirmed: hypotheses.filter((hypothesis) => hypothesis.status === "confirmed").length, predictionResolved: hypotheses.length };
  }));
}

export function buildArchiveReviewFromSummaries(usable: ArchiveRunSummary[]): ArchiveReview {
  const issueGroups = new Map<string, { title: string; occurrences: number; civilizationNos: Set<number>; evidence: string[] }>();
  const milestoneGroups = new Map<MilestoneObservation["id"], { label: string; runs: Set<number> }>();
  let confirmed = 0;
  let resolved = 0;
  usable.forEach((report, runIndex) => {
    report.issues.forEach((issue) => {
      const group = issueGroups.get(issue.id) ?? { title: issue.title, occurrences: 0, civilizationNos: new Set<number>(), evidence: [] };
      group.occurrences += 1;
      group.civilizationNos.add(report.civilizationNo);
      group.evidence.push(issue.evidence);
      issueGroups.set(issue.id, group);
    });
    report.milestones.forEach((milestone) => {
      const group = milestoneGroups.get(milestone.id) ?? { label: milestone.label, runs: new Set<number>() };
      group.runs.add(runIndex);
      milestoneGroups.set(milestone.id, group);
    });
    resolved += report.predictionResolved;
    confirmed += report.predictionConfirmed;
  });
  return {
    runCount: usable.length,
    recurringIssues: [...issueGroups.entries()].map(([id, group]) => ({ id, title: group.title, occurrences: group.occurrences, civilizationNos: [...group.civilizationNos], evidence: group.evidence.at(-1) ?? "" })).sort((a, b) => b.occurrences - a.occurrences),
    milestoneFrequency: [...milestoneGroups.entries()].map(([id, group]) => ({ id, label: group.label, occurrences: group.runs.size, rate: usable.length ? Math.round(group.runs.size / usable.length * 100) : 0 })).sort((a, b) => b.occurrences - a.occurrences),
    predictionAccuracy: resolved ? Math.round(confirmed / resolved * 100) : null,
  };
}

export function auditOriginReachability(
  scenarios: OriginReachabilityScenario[] = [{
    name: "温和乱纪元中的连续原初演化",
    seed: 1,
    config: { civilizationNo: 1, chaosIntensity: 3, climateBias: "balanced" },
    maximumYears: 70,
  }],
): OriginReachabilityReport {
  const evidence = new Map<MilestoneObservation["id"], OriginReachabilityReport["evidence"][number]>();
  const scenarioResults = scenarios.map((scenario) => {
    const config = createDefaultSimulationConfig({
      ...scenario.config,
      startingPoint: "origin",
      endpoint: { kind: "ticks", value: scenario.maximumYears },
    });
    let state = createInitialState(scenario.seed, config);
    while (state.civilization.status === "running" && state.tick < scenario.maximumYears && evidence.size < AUDITED_MILESTONE_IDS.length) {
      state = stepSimulation(state);
      for (const milestone of state.derived.milestones) {
        if (!AUDITED_MILESTONE_IDS.includes(milestone.id) || evidence.has(milestone.id)) continue;
        evidence.set(milestone.id, {
          milestoneId: milestone.id,
          label: milestone.label,
          scenario: scenario.name,
          seed: scenario.seed,
          reachedAtYear: state.tick,
          evidenceEventIds: clone(milestone.evidenceEventIds),
        });
      }
    }
    return {
      name: scenario.name,
      seed: scenario.seed,
      config,
      simulatedYears: state.tick,
      reachedIds: state.derived.milestones.map((milestone) => milestone.id),
      outcome: clone(state.civilization.outcome),
    };
  });
  const reachedIds = AUDITED_MILESTONE_IDS.filter((id) => evidence.has(id));
  const missingIds = AUDITED_MILESTONE_IDS.filter((id) => !evidence.has(id));
  return {
    auditedAt: new Date().toISOString(),
    targetIds: clone(AUDITED_MILESTONE_IDS),
    reachedIds,
    missingIds,
    allReachable: missingIds.length === 0,
    evidence: reachedIds.map((id) => evidence.get(id)!),
    scenarios: scenarioResults,
  };
}
