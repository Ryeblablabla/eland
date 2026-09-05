import type { BiologicalSex } from '../population';
import type { NamingTradition } from '../naming';
import type { CharacterAgendaState } from './character-agenda';
import type { MaterialId } from './material';
import type { BereavementState } from './mortuary';
import type { ProjectFunction, ProjectNeed } from './project';
import type { SocialLearningState } from './social-learning';
import type { PersonTraitState } from './trait';
import type { RelationshipEpisode } from './relationship-episode';
import type { PersonOrigin } from './regional-population';
import type { ProceduralKnowledge } from './procedural-knowledge';

export type {
  RelationshipAppraisalMeaning,
  RelationshipEpisode,
  RelationshipEpisodeInput,
  SubjectiveRelationshipAppraisal,
} from './relationship-episode';

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
  /** Portable liquid is physically bound to one carried container stack. */
  containedByStackId?: string;
  recordPayloadId?: string;
}

export interface KnownFact {
  id: string;
  kind: 'observation' | 'technique' | 'claim' | 'codebook';
  summary: string;
  confidence: number;
  learnedAtMonth: number;
  sourceEventIds: string[];
  /** A fallible, sourced method whose objects must be rebound before another attempt. */
  procedural?: ProceduralKnowledge;
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
  /**
   * A few semantically representative relationship facts survive the rolling
   * recent-source window. They prove why a relationship exists; they are not
   * a permanent conversation blacklist or a second relationship score.
   */
  evidenceLedger?: RelationshipEvidenceLedger;
}

export interface RelationshipEvidenceAnchor {
  eventId: string;
  atMonth: number;
  /** Optional bounded semantic lane; a newer fact replaces only the same lane. */
  semanticKey?: string;
}

export interface RelationshipEvidenceLedger {
  version: 'relationship-evidence-ledger-v1';
  /** Any replayable interaction between this exact directed pair. */
  substantive: RelationshipEvidenceAnchor[];
  /** Care, fulfillment, co-parenting, or a meaningful grounded response. */
  directIntimacy: RelationshipEvidenceAnchor[];
  /** A real shared-action or established shared-living month. */
  sharedLife: RelationshipEvidenceAnchor[];
  /** Explicit accept/reject episodes used as decaying preference, never as a legality gate. */
  decisionBoundaries?: RelationshipEvidenceAnchor[];
}

/**
 * A synthetic response tendency attached to a founder prototype. It is a
 * style/attention prior only: it never grants knowledge, history, ability, or
 * a preselected action.
 */
export interface PrototypeReactionPattern {
  id: string;
  cue: string;
  attention: string;
  responseTendency: string;
  speechTendency: string;
  /** Synthetic cadence example, never a quotation or remembered utterance. */
  exampleLine: string;
}

export interface PersonProfile {
  description: string;
  /** Optional for descendants and legacy saves. */
  personalitySummary?: string;
  /** Optional for descendants and legacy saves; founders receive three. */
  reactionPatterns?: PrototypeReactionPattern[];
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
  /**
   * Optional machine-readable interpretation of an experienced action. Free
   * text remains presentation only; decisions learn from this sourced trace.
   */
  causal?: CausalMemoryTrace;
}

export type CognitiveOutcome = 'completed' | 'progressed' | 'blocked' | 'failed';

export interface CausalMemoryTrace {
  /** Stable across transient option and intent ids. */
  basisKey: string;
  actionKind: 'move' | 'transfer' | 'act' | 'attend' | 'world-interact' | 'talk' | 'inscribe';
  operation?: string;
  goalKind?: string;
  outcome: CognitiveOutcome;
  /** -1..1, derived only from the actor's replayable result. */
  valence: number;
  consequenceTags: string[];
}

/** A small Beta outcome model learned only from this person's own actions. */
export interface OutcomeBelief {
  basisKey: string;
  attempts: number;
  completed: number;
  progressed: number;
  blocked: number;
  failed: number;
  /** Beta posterior parameters. They start with a weak, non-certain prior. */
  successAlpha: number;
  successBeta: number;
  /** Running mean of experienced observations in the 0..1 range. */
  expectedEffort: number;
  expectedHarm: number;
  lastUpdatedAtMonth: number;
  sourceEventIds: string[];
}

/** A Beta model for whether an intended state was achieved, separate from action legality. */
export interface GoalOutcomeBelief {
  basisKey: string;
  attempts: number;
  achieved: number;
  attemptedUnmet: number;
  successAlpha: number;
  successBeta: number;
  lastUpdatedAtMonth: number;
  sourceEventIds: string[];
}

/**
 * A person-local observation that their own final project action resolved a
 * concrete need. This is evidence, not a stored happiness or reward score.
 */
export interface NeedResolutionEpisode {
  version: 'need-resolution-episode-v1';
  id: string;
  projectId: string;
  projectNeed: ProjectNeed;
  desiredFunction: ProjectFunction;
  basisKey: string;
  observedAtMonth: number;
  observationKind: 'completion-action';
  triggerFactIds: string[];
  outcomeEventIds: string[];
  sourceFactIds: string[];
}

export interface CognitionState {
  version: 'causal-bdi-v1';
  /** Bounded person-local expectations; never global civilization knowledge. */
  outcomeBeliefs: OutcomeBelief[];
  /** Optional for schema-v17 save compatibility; hydrated without backfilling old outcomes. */
  goalOutcomeBeliefs?: GoalOutcomeBelief[];
  /** Optional for schema-v17 save compatibility; old projects are not inferred retroactively. */
  needResolutionEpisodes?: NeedResolutionEpisode[];
  /**
   * Optional person-local social posterior. Legacy saves start with no social
   * evidence and are never reconstructed from their already-terminal history.
   */
  socialLearning?: SocialLearningState;
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
  profile: PersonProfile;
  /** Physical/social provenance of this person's entry into the simulated map. */
  origin?: PersonOrigin;
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
  /** 出生时一次确定、终身不变，最多三个遗传 / 先民特质加一个随机异变；可选仅用于兼容旧存档与轻量测试夹具。 */
  traits?: PersonTraitState[];
  /** 母脉出生链中，母亲已完成的真实技术教导；首项获得一次 72 置信度加成。 */
  maternalTeachingSourceEventIds?: string[];
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
  /**
   * Directed, person-local interpretations of sourced encounters. Optional
   * while old saves and lightweight fixtures migrate; unlike relation scores,
   * these episodes preserve what an event meant to this particular person.
   */
  relationshipEpisodes?: RelationshipEpisode[];
  memories: MemoryRecord[];
  /**
   * This person's single persisted subjective document. Optional only while
   * schema-v17 saves and small fixtures without the field are being hydrated.
   */
  mindMarkdown?: string;
  /** Sourced, person-local awareness of a death; optional for schema-v17 saves. */
  bereavements?: BereavementState[];
  /** Optional only so old schema-v17 states and small test fixtures can hydrate. */
  cognition?: CognitionState;
  /** Durable concerns above executable Intent episodes; optional for schema-v17 saves. */
  characterAgenda?: CharacterAgendaState;
  activeIntentId?: string;
  /** Last primitive action attempt; observer-only timing, never a planning reward. */
  lastActionAtMonth?: number;
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
