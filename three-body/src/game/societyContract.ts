/**
 * 社会层数据契约 —— 三体游戏"人间地图"消费的极简视图模型。
 *
 * 对接说明（写给 ELAND 社会鱼缸的适配器）：
 *   SocietyState.locations      ← ELAND world.space.locations（含地图坐标）
 *   SocietyState.routes         ← ELAND world.space.routes（traffic 踩出道路）
 *   SocietyAgent.state          ← ELAND agent.body.state（active / dehydrated）
 *   SocietyAgent.doing          ← ELAND agent.limbs.actionText（LLM 决策的当前行动）
 *   SocietyAgent.mind           ← ELAND agent.mind（本我 want / 自我 choice / 超我 ought）
 *   SocietyState.constructions  ← ELAND matter 中的 construction（房屋、金字塔）
 *
 * 时间主权约定：人间纪年（年）是游戏的权威时钟，由 agent 推理节奏驱动；
 * 宇宙天象是该纪年下的确定性采样（种子可复现）。
 */

export interface MapLocation {
  id: string;
  name: string;
  x: number; // 地图百分比坐标
  y: number;
  /** 开发度：0 荒野 / 1 有人烟（工地、火种、刻痕）/ 2 有完工建筑 —— 全部由人物活动驱动 */
  dev?: 0 | 1 | 2;
  terrain: {
    kind: 'soil' | 'grass' | 'stone' | 'water-edge';
    compaction: number;
    cleared: number;
    depth: number;
    irrigated: boolean;
  };
  matter: { kind: string; name: string; quantity: number; traits: string[] }[];
}

export interface RouteState {
  id: string;
  from: number;
  to: number;
  traffic: number; // 通行人次，踩多了成路
  state: 'unmarked' | 'trail' | 'road';
}

export interface SocietyAgent {
  id: string;
  name: string;
  title: string;
  loc: number;
  state: 'active' | 'dehydrated' | 'dead';
  doing: string;
  sex?: 'female' | 'male';
  lifespanYears?: number;
  generation?: number;
  respect?: number;
  predictionRecord?: { correct: number; failed: number };
  pregnant?: boolean;
  mind: { want: string; choice: string; ought: string };
  /** 马斯洛五层需求（ELAND mind.needs.layers 直出） */
  needs?: { level: string; label: string; intensity: number; dominant: boolean }[];
  /** 身体实际状态（ELAND body 直出） */
  body?: { health: number; nutrition: number; hydration: number; fatigue: number; ageYears: number };
}

export interface SocietyState {
  agents: SocietyAgent[];
  routes: RouteState[];
  locations: MapLocation[]; // 动态地点（来自 ELAND world.space.locations）
  /** 涌现建筑：人物活动真实建造的结构（含工地），名字由建造者自取 */
  structures?: {
    id: string;
    name: string;
    loc: number;
    progress: number;   // 0~100
    complete: boolean;
    traits: string[];   // shelter / instrument / flat 等
    composition: Record<string, number>;
    effects?: {
      weatherProtection: number;
      thermalInsulation: number;
      enclosure: number;
      capacity: number;
    };
    useCount: number;
    sourceEventIds: string[];
  }[];
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
  civilizationId: number;
  civilizationYear: number;
  universeTime: number;
  skySample: SkySample;
  society: SocietyState;
  civilizationEnd: {
    kind: 'destroyed' | 'boundary' | 'milestones';
    cause: string;
    summary: string;
  } | null;
  entries: { text: string; tone: 'plain' | 'good' | 'bad' | 'era'; kind: 'action' | 'prediction' | 'epoch' }[];
  speaker: string | null;
}

/** 纪元键：乱纪元按恒星通量细分酷暑/严寒（F/F₀ >1.8 酷暑，<0.45 严寒） */
export type EraKey =
  | 'stable'
  | 'chaotic'        // 温和乱纪元
  | 'chaotic-heat'   // 酷暑乱纪元
  | 'chaotic-cold'   // 严寒乱纪元
  | 'burned'
  | 'frozen'
  | 'extinct';

/** 初始小路网（对应 ELAND 的 neighbors） */
export const INITIAL_ROUTES: [number, number][] = [
  [0, 1], [0, 2], [1, 2], [1, 3], [2, 3], [2, 4], [3, 4],
];
