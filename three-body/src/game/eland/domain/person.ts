import type { BiologicalSex } from '../population';
import type { NamingTradition } from '../naming';
import type { MaterialId } from './material';

export type PersonId = string;
export type ConditionKind = 'cold' | 'heat' | 'wound' | 'illness' | 'aging' | 'pregnancy' | 'postpartum-recovery' | 'restrained' | 'dehydrated-hibernation';
export type HibernationPhase = 'dormant' | 'recovering';

/** A recovered body must be able to enter a new ordinary episode if needed. */
export const HIBERNATION_RECOVERY_SAFE_RESERVE = 45;
/** Executor legality for entering an already-needed hibernation episode. */
export const HIBERNATION_ENTRY_LEGAL_RESERVE = 38;
/** Anticipatory sleep needs more margin because the predicted crisis has not arrived. */
export const HIBERNATION_PREDICTIVE_ENTRY_RESERVE = 45;

export interface ConditionInstance {
  id: string;
  kind: ConditionKind;
  stage: 1 | 2 | 3;
  sinceMonth: number;
  sourceEventIds: string[];
  otherPersonId?: PersonId;
  dueAtMonth?: number;
  endsAtMonth?: number;
  materialStackId?: string;
  /** Pending forecast that made anticipatory hibernation useful. */
  triggerPredictionId?: string;
  /** A prior disputed wake of the same sleep plan; new evidence is required before another. */
  wakeDisputeEventIds?: string[];
  /** Missing on legacy saves means dormant. Only dehydrated-hibernation uses this field. */
  hibernationPhase?: HibernationPhase;
  /** Start of the current stable-era recovery attempt, not the original episode. */
  recoveryStartedAtMonth?: number;
  /** Physical ingest / rehydrate facts produced during the current recovery attempt. */
  recoverySourceEventIds?: string[];
  /** At most one caregiver-assisted recovery drink may be applied in a month. */
  lastRecoveryAssistedAtMonth?: number;
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

export type HexacoTrait =
  | 'honestyHumility'
  | 'emotionality'
  | 'extraversion'
  | 'agreeableness'
  | 'conscientiousness'
  | 'openness';

export interface HexacoVector {
  honestyHumility: number;
  emotionality: number;
  extraversion: number;
  agreeableness: number;
  conscientiousness: number;
  openness: number;
}

export interface PersonalityEvidence {
  id: string;
  trait: HexacoTrait;
  direction: -1 | 1;
  strength: number;
  contextKey: string;
  atMonth: number;
  sourceEventIds: string[];
  consolidatedInto?: string;
}

export interface PersonalityChange {
  id: string;
  trait: HexacoTrait;
  delta: -1 | 1;
  atMonth: number;
  evidenceIds: string[];
  sourceEventIds: string[];
}

export interface PersonalityState {
  /** Seeded or inherited temperament. It is never rewritten by an action. */
  baseline: HexacoVector;
  /** Slow experience-driven offset, capped independently from the baseline. */
  learnedDelta: HexacoVector;
  /** Person-local interpretations of replayable action facts. */
  evidence: PersonalityEvidence[];
  changes: PersonalityChange[];
}

export interface MotiveSensitivity {
  /** Sensitivity to restraint, coercion, denied permission, and lost choice. */
  control: number;
  /** Preference for prestige and visible responsibility; not a moral trait. */
  status: number;
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
  personality: PersonalityState;
  motiveSensitivity: MotiveSensitivity;
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

export function hasHibernationEntryContraindication(person: PersonState): boolean {
  return person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
    || condition.kind === 'pregnancy'
    || ((condition.kind === 'wound' || condition.kind === 'illness') && condition.stage >= 2));
}

export function hasHibernationEntryBodyReserve(
  person: PersonState,
  minimumReserve = HIBERNATION_ENTRY_LEGAL_RESERVE,
): boolean {
  return Math.min(person.body.health, person.body.hydration, person.body.nutrition) >= minimumReserve;
}

export function canEnterDehydratedHibernation(
  person: PersonState,
  minimumReserve = HIBERNATION_ENTRY_LEGAL_RESERVE,
): boolean {
  return !hasHibernationEntryContraindication(person)
    && hasHibernationEntryBodyReserve(person, minimumReserve);
}

export function hibernationPhase(condition: ConditionInstance): HibernationPhase {
  return condition.kind === 'dehydrated-hibernation' && condition.hibernationPhase === 'recovering'
    ? 'recovering'
    : 'dormant';
}

export function isDormantDehydratedHibernating(person: PersonState): boolean {
  return person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
    && hibernationPhase(condition) === 'dormant');
}

export function isRecoveringFromDehydratedHibernation(person: PersonState): boolean {
  return person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
    && hibernationPhase(condition) === 'recovering');
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
