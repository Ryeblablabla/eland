import type { FactPredicate, SocialProposal, WorldRef } from './action';

/**
 * One subjective turn of mind. It can choose a direction and name fallible
 * assumptions, but it never states that a world result has already happened.
 * A local compiler may ground only the next currently available step.
 */
export type MentalActKind =
  | 'pursue'
  | 'investigate'
  | 'talk'
  | 'reconsider'
  | 'continue'
  | 'wait';

export type MentalActOrientation =
  | 'social'
  | 'inquiry'
  | 'survival'
  | 'construction'
  | 'acquisition'
  | 'exploration'
  | 'rest';

/**
 * The durable, model-authored translation of one intention.
 *
 * These are plans, not facts: keeping the complete translation lets a later
 * compiler resume or turn it into a Project instead of throwing every step
 * away after the first primitive action.  World results never belong here.
 */
export interface MentalPlanTranslation {
  version: 'mental-plan-translation-v1';
  steps: string[];
  disposition: 'act' | 'continue' | 'pause' | 'abandon' | 'stay';
  /** Expected facts are checked against actual state, never the plan's prose. */
  completion?: { step: PlanCompletionCheck; goal: PlanCompletionCheck };
  /** Stable request-scoped handle used by Plan; never interpreted as a fact. */
  firstStepHandle?: string;
  continuationHandle?: string;
  /** A request-scoped reference to one of this person's suspended intentions. */
  resumeIntentHandle?: string;
  /** A request-scoped reference to a suspended intention the person gives up. */
  abandonIntentHandle?: string;
  /** A free-form action awaiting an independently authored world resolution. */
  worldAction?: {
    description: string;
    expectedResult?: string;
  };
}

export type MentalRelationshipMeaning =
  | 'gratitude'
  | 'care'
  | 'affection'
  | 'attraction'
  | 'respect'
  | 'solidarity'
  | 'obligation'
  | 'hurt'
  | 'anger'
  | 'fear'
  | 'suspicion'
  | 'jealousy'
  | 'rivalry'
  | 'grief'
  | 'ambivalence'
  | 'uncertainty';

/**
 * A model-authored interpretation of sourced experience. It changes the
 * observer's remembered meaning, never the other person's state or consent.
 */
export interface MentalRelationshipAppraisal {
  version: 'mental-relationship-appraisal-v1';
  otherPersonId: string;
  meanings: MentalRelationshipMeaning[];
  interpretation: string;
  unresolvedExpectation?: string;
  desiredResponse?: string;
  sourceEventIds: string[];
}

export interface MentalAct {
  version: 'mental-act-v2';
  kind: MentalActKind;
  /**
   * The single first-person language wave produced by this decision. A
   * Trisolaran has no private thought channel distinct from speaking.
   */
  utterance: string;
  /** Electromagnetic emission strength; it never selects a receiver. */
  delivery: 'whisper' | 'normal' | 'call';
  /** The person's own declared speech meaning; Plan cannot add a commitment. */
  speechIntent?: MentalSpeechIntent;
  goal: string;
  /** The broad subjective direction chosen before Plan saw executable entries. */
  orientation?: MentalActOrientation;
  /** Whether the person meant this goal to persist beyond the current turn. */
  horizon?: 'momentary' | 'ongoing';
  strategy: string;
  assumptions: string[];
  expectedObservation?: string;
  /** Complete Plan output retained for continuation, audit and Project lift. */
  plan?: MentalPlanTranslation;
  /** Optional subjective meaning formed from one or more real social facts. */
  relationshipAppraisal?: MentalRelationshipAppraisal;
  /** Plan Agent correction grounded in prior experienced failure facts. */
  planFeedback?: {
    correction: string;
    adjustment: string;
    sourceEventIds: string[];
  };
  sourceEventIds: string[];
}

export type MentalSpeechIntent =
  | { kind: 'expression' }
  | { kind: 'proposal'; proposalKind: SocialProposal['kind']; counterpartIds: string[]; commitment: string }
  | { kind: 'accept' | 'reject' | 'end-agreement' | 'revoke-permission' | 'leave-collective' | 'share-knowledge'; referenceId: string }
  | { kind: 'prediction' | 'request-information' };
export type PlanSuccessCondition =
  | { kind: 'fact'; predicate: FactPredicate }
  | { kind: 'near-target'; target: WorldRef; maxDistance: number }
  | { kind: 'reached-target'; target: WorldRef; maxDistance: number }
  | {
      kind: 'work-state';
      target: Extract<WorldRef, { kind: 'voxel' }> | { kind: 'work'; workId: string } | { kind: 'produced-work' };
      minCondition?: number;
      minProfile?: { cover?: number; rigidity?: number; stability?: number };
      components?: Array<{ materialId: number; quantity: number }>;
    };

export interface PlanCompletionCheck {
  description: string;
  conditions: PlanSuccessCondition[];
}

/** An observed arrival within this chosen plan, not a permanent state claim. */
export interface PlanMilestoneReceipt {
  condition: Extract<PlanSuccessCondition, { kind: 'reached-target' }>;
  distance: number;
  sourceEventId: string;
  atMonth: number;
}

export interface PlanCompletionAssessment {
  step: 'satisfied' | 'unmet' | 'unverified';
  goal: 'satisfied' | 'unmet' | 'unverified';
  satisfiedConditionIds: string[];
  changedConditionIds: string[];
  /** Exact checks evaluated for this receipt, even if a later Plan changes steps. */
  checked?: { step: PlanCompletionCheck; goal: PlanCompletionCheck };
}
