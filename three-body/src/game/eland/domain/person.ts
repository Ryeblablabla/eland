import type { BiologicalSex } from '../population';
import type { NamingTradition } from '../naming';
import type { MaterialId } from './material';

export type PersonId = string;
export type ConditionKind = 'cold' | 'heat' | 'wound' | 'illness' | 'aging' | 'pregnancy' | 'restrained' | 'dehydrated-hibernation';

export interface ConditionInstance {
  id: string;
  kind: ConditionKind;
  stage: 1 | 2 | 3;
  sinceMonth: number;
  sourceEventIds: string[];
  otherPersonId?: PersonId;
  dueAtMonth?: number;
  materialStackId?: string;
}

export interface ItemStack {
  id: string;
  materialId: MaterialId;
  quantity: number;
  sourceEventIds: string[];
  /** Exact physical sources this stack descended from across transfers. */
  sourceLineageKeys?: string[];
  recordPayloadId?: string;
}

export interface KnownFact {
  id: string;
  kind: 'observation' | 'technique' | 'claim' | 'codebook';
  summary: string;
  confidence: number;
  learnedAtMonth: number;
  sourceEventIds: string[];
}

export interface KnownPlace {
  id: string;
  materialId: MaterialId;
  position: { x: number; y: number; z: number };
  learnedAtMonth: number;
  lastConfirmedAtMonth: number;
  sourceEventIds: string[];
}

export interface DirectedRelation {
  personId: PersonId;
  trust: number;
  bond: number;
  fear: number;
  sourceEventIds: string[];
}

export type MemoryKind = 'episode' | 'dialogue' | 'commitment' | 'failure' | 'summary';

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  summary: string;
  importance: number;
  createdAtMonth: number;
  lastRecalledAtMonth: number;
  personIds: PersonId[];
  sourceEventIds: string[];
  expiresAtMonth?: number;
}

export interface PersonState {
  id: PersonId;
  name: string;
  color: string;
  profile: { description: string };
  bornAtMonth: number;
  lifespanMonths: number;
  diedAtMonth?: number;
  sex: BiologicalSex;
  /** 父系继承的姓氏与姓名顺序；可选以兼容旧存档。 */
  familyName?: string;
  namingTradition?: NamingTradition;
  geneticParents: PersonId[];
  generation: number;
  /** Accumulated inherited susceptibility. It changes outcomes, not action legality. */
  geneticLoad: number;
  position: {
    cellId: number;
    /** 双脚所在的空气体素高度；cellId 仍是给地图和区域规则使用的水平投影。 */
    z: number;
    previousCellId: number;
    previousZ: number;
    /** 本月实际经过的移动格；用于行动证据。 */
    lastPath: number[];
    /** 月初位置 + 15 个规则行动刻度的位置；用于确定性回放。 */
    tickPath: number[];
  };
  body: { health: number; hydration: number; nutrition: number };
  baselineCapacities: {
    locomotion: number;
    manipulation: number;
    perception: number;
    communication: number;
    cognition: number;
  };
  driveBias: { affiliation: number; autonomy: number; recognition: number; inquiryCreation: number };
  conditions: ConditionInstance[];
  inventory: ItemStack[];
  knowledge: KnownFact[];
  /** 亲眼确认或亲自使用过的有限物质地点；不是全知地图。 */
  knownPlaces: KnownPlace[];
  relations: DirectedRelation[];
  memories: MemoryRecord[];
  activeIntentId?: string;
  currentActionText: string;
  lastDecisionText: string;
}

export function isAlive(person: PersonState): boolean {
  return person.diedAtMonth === undefined && person.body.health > 0;
}

export function isDehydratedHibernating(person: PersonState): boolean {
  return person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation');
}

export function ageMonths(person: PersonState, elapsedMonths: number): number {
  return Math.max(0, elapsedMonths - person.bornAtMonth);
}

/** 能通过一次明确教导可靠掌握技术或符号的最低年龄。 */
export const MIN_TEACHING_AGE_MONTHS = 6 * 12;

export function inventoryQuantity(person: PersonState, materialId: MaterialId): number {
  return person.inventory.reduce((sum, stack) => sum + (stack.materialId === materialId ? stack.quantity : 0), 0);
}

export function sameLocation(first: PersonState, second: PersonState): boolean {
  return first.position.cellId === second.position.cellId && first.position.z === second.position.z;
}
