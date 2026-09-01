import type { MaterialId } from './material';
import type {
  MechanicalPowerActionBasis,
  MechanicalPowerFaultObservationRef,
} from './mechanical-power';
import type {
  ElectricalPowerActionBasis,
  ElectricalPowerFaultObservationRef,
} from './electrical-power';
import type { ConditionKind, HibernationPhase, PersonId } from './person';
import type {
  ProjectFunction,
  ProjectProposal,
  RecurringProjectDutySubject,
} from './project';
import type { WildlifeThreatBasis } from './wildlife-threat';
import type { MortuaryPhase } from './mortuary';
import type { SourcedMassMeasurementAction } from './measurement';
import type { ActionOptionSemanticsV1 } from './action-option-semantics';
import type { ProjectLeadershipSuccessionActionBasis } from './project-leadership';
import type { CharacterAgendaProposal, CharacterAgendaUpdate } from './character-agenda';
import type { MentalAct } from './mental-act';

export interface VoxelPosition { x: number; y: number; z: number }

/**
 * One finite, person-local attempt to find water without reading hidden cells.
 * The candidate area is frozen when the episode opens; walking must not drag
 * the search horizon forward forever.
 */
export interface WaterSearchBasis {
  version: 'bounded-water-search-v1';
  episodeId: string;
  beneficiaryId: PersonId;
  openedAtMonth: number;
  origin: { cellId: number; z: number };
  candidates: Array<{ cellId: number; z: number }>;
  candidateIndex: number;
  /** Only new person-local water evidence may reopen an exhausted episode. */
  evidenceKey: string;
}

/**
 * One locally observed care episode that lets a parent physically transport
 * an infant who is older than the automatic carried-child stage. The basis is
 * revalidated by the move executor; it is not a generic follower flag.
 */
export interface DependentTransportBasis {
  version: 'dependent-transport-v1';
  dependentId: PersonId;
  observedAtMonth: number;
  reason: 'thermal-shelter' | 'hibernation-recovery' | 'hydration-access' | 'food-access';
  conditionIds: string[];
  sourceFactIds: string[];
}

export type WorldRef =
  | { kind: 'voxel'; position: VoxelPosition }
  | { kind: 'drop'; dropId: string }
  | { kind: 'container'; containerId: string }
  | { kind: 'inventory-stack'; personId: PersonId; stackId: string }
  | { kind: 'animal'; animalId: string }
  | { kind: 'remains'; remainsId: string }
  | { kind: 'person'; personId: PersonId };

export type HolderRef =
  | { kind: 'ground'; cellId: number; z?: number }
  | { kind: 'container'; containerId: string }
  | { kind: 'person'; personId: PersonId };

export type SourceOperation = 'exert' | 'separate' | 'combine' | 'expose' | 'ingest' | 'reproduce' | 'hunt' | 'dehydrate' | 'rehydrate' | 'inter';

export type HibernationWakeBasis =
  | 'prediction-invalidated'
  | 'post-chaos-recovery'
  | 'body-emergency'
  | 'disputed-pending-prediction'
  | 'unbound-stable-recovery';

export interface RelationshipCausalBasis {
  version: 'relationship-causal-basis-v1';
  subjectKey: string;
  basisKey: string;
  kind: 'companion' | 'reproduce';
  proposerId: PersonId;
  partnerId: PersonId;
  relationshipKeys: string[];
  bodyKeys: string[];
  sourceFactIds: string[];
}

/**
 * A mutually known, stable place for shared life. It is not another person's
 * live position: members may move independently inside and outside this area.
 */
export interface SharedLivingAnchor {
  version: 'shared-living-anchor-v1';
  cellId: number;
  z: number;
  radius: number;
}

export interface TechniqueDemonstrationRequest {
  projectId: string;
  desiredFunction: ProjectFunction;
  requesterId: PersonId;
  expiresAtMonth: number;
}

/** A bounded request for knowledge of one project component the requester can already name. */
export interface ProjectKnowledgeRequest {
  version: 'project-knowledge-request-v1';
  projectId: string;
  requesterId: PersonId;
  outputMaterialId: MaterialId;
  expiresAtMonth: number;
}

/** A direct teaching claim tied to one actually received project knowledge request. */
export interface ProjectKnowledgeResponse {
  version: 'project-knowledge-response-v1';
  projectId: string;
  requestEventId: string;
  requesterId: PersonId;
  outputMaterialId: MaterialId;
}

export interface TechniqueDemonstrationRef {
  requestEventId: string;
  projectId: string;
  learnerId: PersonId;
  techniqueId: string;
}

/** A sourced request to bring one concrete missing material to a fixed project site. */
export interface ProjectMaterialContributionRequest {
  version: 'project-material-contribution-request-v1';
  projectId: string;
  requesterId: PersonId;
  materialId: MaterialId;
  quantity: number;
  site: { cellId: number; z: number };
  expiresAtMonth: number;
}

export interface TechniqueImitationRef {
  projectId: string;
  demonstrationEventId: string;
  techniqueId: string;
}

/**
 * The perceived deficit that makes exercising a standing resource permission
 * useful now.  Permission grants legality only; this basis supplies motive.
 */
export interface PermissionUseBasis {
  version: 'permission-use-basis-v1';
  permissionId: string;
  kind: 'personal-reserve' | 'project-demand';
  materialId: MaterialId;
  requiredQuantity: number;
  receiverQuantity: number;
  grantorQuantity: number;
  projectId?: string;
  projectDemandBranchKey?: string;
  sourceFactIds: string[];
  basisKey: string;
}

/** A visible or remembered drinkable source that causally anchors travel. */
export interface WaterAccessBasis {
  version: 'water-access-basis-v1';
  mode: 'visible' | 'remembered';
  materialId: MaterialId;
  waterPosition: VoxelPosition;
  bankPosition: { cellId: number; z: number };
  observedAtMonth: number;
  sourceFactIds: string[];
  basisKey: string;
}

export type GroundedConversationTopic =
  | 'open'
  | 'everyday'
  | 'reminiscence'
  | 'playful'
  | 'care'
  | 'hardship'
  | 'gratitude'
  | 'shared-work'
  | 'failure'
  | 'discovery'
  | 'family'
  | 'loss';

export type GroundedConversationMove =
  | 'acknowledge'
  | 'support'
  | 'question'
  | 'challenge'
  | 'share-fact'
  | 'commit'
  | 'close';

/** A social utterance grounded in replayable life history rather than generic flavor text. */
export interface GroundedConversationRef {
  version: 'grounded-conversation-v1';
  /** Shared live coordination owned by the unified memory store. */
  episodeId?: string;
  basisKey: string;
  topic: GroundedConversationTopic;
  turn: 'opening' | 'response';
  speakerId: PersonId;
  listenerId: PersonId;
  sourceFactIds: string[];
  /** Present only after an open option has been rebound through a validated model decision. */
  openGroundingCompiled?: true;
  referenceEventId?: string;
  stance?: 'supportive' | 'guarded';
  /** What this response actually contributes; old responses hydrate as acknowledgement. */
  move?: GroundedConversationMove;
}

export interface OpenConversationGroundingFact {
  /** Exact replayable fact retained server-side; the model sees only a request handle. */
  sourceFactId: string;
  kind: 'memory' | 'knowledge' | 'relationship';
  summary: string;
  memoryKind?: string;
  knowledgeId?: string;
}

/** Ephemeral option envelope. It is never itself an authoritative claim. */
export interface OpenConversationGroundingEnvelope {
  version: 'open-conversation-grounding-v1';
  listenerId: PersonId;
  fallbackSourceFactIds: string[];
  facts: OpenConversationGroundingFact[];
}

export type RepresentationInput =
  | {
      id: string;
      kind: 'claim';
      summary: string;
      factId?: string;
      conversation?: GroundedConversationRef;
      projectKnowledgeResponse?: ProjectKnowledgeResponse;
    }
  | {
      id: string;
      kind: 'prediction';
      summary: string;
      prediction: {
        targetEpoch: 'stable' | 'chaotic';
        predictedStartMonth: number;
        toleranceMonths: number;
        expiresAtMonth: number;
      };
    }
  | {
      id: string;
      kind: 'request';
      summary: string;
      proposal?: SocialProposal;
      techniqueDemonstration?: TechniqueDemonstrationRequest;
      projectMaterialContribution?: ProjectMaterialContributionRequest;
      projectKnowledgeRequest?: ProjectKnowledgeRequest;
    }
  | { id: string; kind: 'offer'; summary: string; proposal?: SocialProposal }
  | { id: string; kind: 'accept'; referenceId: string; summary?: string }
  | { id: string; kind: 'reject'; referenceId: string; summary?: string }
  | { id: string; kind: 'revoke-agreement'; referenceId: string; summary: string }
  | { id: string; kind: 'revoke'; permissionId: string; summary: string }
  | { id: string; kind: 'withdraw'; collectiveId: string; summary: string };

export type SocialProposal =
  | { kind: 'reproduce'; proposerId: PersonId; partnerId: PersonId; expiresAtMonth: number; basis?: RelationshipCausalBasis }
  | { kind: 'assist'; requesterId: PersonId; helperId: PersonId; need: 'water' | 'food' | 'shelter' | 'company'; expiresAtMonth: number }
  | {
      kind: 'companion'; proposerId: PersonId; partnerId: PersonId;
      expiresAtMonth: number; basis?: RelationshipCausalBasis;
      sharedLivingAnchor?: SharedLivingAnchor;
    }
  | { kind: 'collective'; proposerId: PersonId; partnerId: PersonId; purposeSummary: string; expiresAtMonth: number }
  | {
      kind: 'membership'; proposerId: PersonId; partnerId: PersonId;
      collectiveId: string; candidateId: PersonId; requiredApproverIds: PersonId[];
      expiresAtMonth: number;
    }
  | ({
      kind: 'decision-rule'; proposerId: PersonId; partnerId: PersonId;
      collectiveId: string; requiredApproverIds: PersonId[];
      method: 'unanimous';
      mandateDurationMonths: number; expiresAtMonth: number;
    } & (
      | { scope: 'coordinate-material'; materialId: MaterialId }
      | { scope: 'assign-recurring-duty'; projectDuty: RecurringProjectDutySubject }
    ))
  | {
      kind: 'mandate'; proposerId: PersonId; partnerId: PersonId;
      collectiveId: string; decisionRuleId: string; holderId: PersonId;
      requiredApproverIds: PersonId[]; expiresAtMonth: number;
      /** Required only when the governing rule assigns a recurring project duty. */
      projectId?: string;
    }
  | {
      kind: 'permission'; proposerId: PersonId; partnerId: PersonId;
      collectiveId: string; grantorId: PersonId; granteeId: PersonId;
      materialId: MaterialId; maxQuantityPerTransfer: number;
      validUntilMonth: number; expiresAtMonth: number;
    }
  | {
      kind: 'exchange'; offererId: PersonId; partnerId: PersonId;
      offererMaterialId: MaterialId; offererQuantity: number;
      partnerMaterialId: MaterialId; partnerQuantity: number;
      expiresAtMonth: number;
    };

export type DialogueAct = 'request-help' | 'offer-companion' | 'accept' | 'reject' | 'share-observation';

export type PrimitiveAction =
  | {
      kind: 'move';
      toCellId: number;
      toZ?: number;
      /** Visible biological caregiver chosen as the causal target of a child's crisis rendezvous. */
      caregiverRef?: PersonId;
      /** Exact current local threat and the one-step refuge response validated by the domain. */
      wildlifeThreatBasis?: WildlifeThreatBasis;
      /** Frozen finite frontier for a locally grounded water-search episode. */
      waterSearchBasis?: WaterSearchBasis;
      /** Exact perceived water source that remains stable while travelling. */
      waterAccessBasis?: WaterAccessBasis;
      /** Exact co-located infant and current crisis that authorize physical transport. */
      dependentTransportBasis?: DependentTransportBasis;
    }
  | {
      kind: 'transfer';
      materialId: MaterialId;
      quantity: number;
      from: HolderRef;
      to: HolderRef;
      dropId?: string;
      stackId?: string;
      /** Required when collecting a liquid voxel into one carried container. */
      containerStackId?: string;
      authorizationRef?: string;
      /** Required when legality comes from a standing ResourcePermission. */
      permissionUseBasis?: PermissionUseBasis;
      /** Present only when the actor knows this exact ground drop is a deceased person's estate. */
      estateCarePersonId?: PersonId;
    }
  | {
      kind: 'act';
      operation: SourceOperation;
      targets: WorldRef[];
      /** Exact source -> converter -> connector -> load basis for generic mechanical acts. */
      mechanicalPowerBasis?: MechanicalPowerActionBasis;
      /** Exact commissioned mechanical source -> dynamo -> conductor -> load basis. */
      electricalPowerBasis?: ElectricalPowerActionBasis;
      /** Required by actions whose legality comes from one concrete agreement. */
      authorizationRef?: string;
      toolStackId?: string;
      techniqueDemonstration?: TechniqueDemonstrationRef;
      techniqueImitation?: TechniqueImitationRef;
      hibernationPredictionId?: string;
      /** Local exposure facts that made a failed shelter hibernation response actionable. */
      hibernationEvidenceEventIds?: string[];
      hibernationWakeBasis?: HibernationWakeBasis;
      /** Physical phase of a sourced mortuary act; only valid with operation=inter. */
      mortuaryPhase?: MortuaryPhase;
    }
  | {
      kind: 'attend';
      target: WorldRef;
      /** A calibrated, source-bound use of one physical measuring apparatus. */
      measurement?: SourcedMassMeasurementAction;
      instrumentStackId?: string;
      /** A visible current segment selected for source-bound observation. */
      waterCurrentSegmentId?: string;
      /** A visible broken component selected for source-bound personal diagnosis. */
      mechanicalPowerFaultObservation?: MechanicalPowerFaultObservationRef;
      /** A visible current open circuit selected for source-bound personal diagnosis. */
      electricalPowerFaultObservation?: ElectricalPowerFaultObservationRef;
      /** A sourced, voluntary inspection of one bounded project vacancy. */
      projectLeadershipSuccession?: ProjectLeadershipSuccessionActionBasis;
      /** Optional source-bound verification compiled from an authoritative material response. */
      verification?: {
        techniqueId: string;
        sourceEventId: string;
        expectedMaterialId: MaterialId;
      };
    }
  | {
      /** Physical vocalization. Meaning is the speaker's private reading, not a property of the sound. */
      kind: 'talk';
      speakerMeaning: RepresentationInput;
    }
  | {
      /** Material inscription is not airborne speech and therefore has no acoustic audience. */
      kind: 'inscribe';
      inscriptionMeaning: Extract<RepresentationInput, { kind: 'claim' }>;
      carrierStackId: string;
    };

export function waterCurrentObservationFactId(segmentId: string): string {
  return `observation:water-current:${segmentId}`;
}

interface RecordUseBasisFields {
  basisKey: string;
  projectId: string;
  projectOwnerId: PersonId;
  readerId: PersonId;
  recordAuthorId: PersonId;
  demand: { kind: 'project-deficit'; projectId: string; deficitSourceIds: string[] };
  recordId: string;
  knowledgeId: string;
  codebookId: string;
  techniqueId: string;
  ruleSignature: string;
  projectPressure: number;
  expectedOutputMaterialId?: MaterialId;
  createdAtMonth: number;
  projectSourceEventIds: string[];
  recordSourceEventIds: string[];
  codebookSourceEventIds: string[];
  inputSourceEventIds: string[];
  sourceFactIds: string[];
}

interface FrozenRecordUseBasisFields extends RecordUseBasisFields {
  /** Legacy v1/v2 episodes froze the final physical action before reading. */
  experimentAction: PrimitiveAction;
}

/** Legacy carrier handoff basis kept readable for persisted v1 intents. */
export interface RecordUseBasisV1 extends FrozenRecordUseBasisFields {
  version: 'record-use-basis-v1';
}

/** The exact physical carrier perceived by the reader when a record-use chain starts. */
export type RecordCarrierSource =
  | { kind: 'inventory'; personId: PersonId; stackId: string }
  | { kind: 'ground'; dropId: string; cellId: number; z: number };

/** Exact pre-action inventory evidence frozen for one record-bound replication. */
export interface RecordUseInputWitnessV1 {
  version: 'record-use-input-witness-v1';
  role: 'input' | 'tool';
  personId: PersonId;
  stackId: string;
  materialId: MaterialId;
  quantity: number;
  sourceEventIds: string[];
  /** Genesis inventory has no producing event; only the canonical founder ration may use this witness. */
  genesisEntity?: {
    kind: 'founder-ration';
    personId: PersonId;
    stackId: string;
    materialId: MaterialId;
  };
}

/** Reader-owned record-use basis. A ground source must be acquired before it can be read. */
export interface RecordUseBasisV2 extends FrozenRecordUseBasisFields {
  version: 'record-use-basis-v2';
  carrierSource: RecordCarrierSource;
  acquisitionRequired: boolean;
}

/**
 * Project-bound record use. The final experiment is deliberately not stored:
 * each tick recompiles the owned active project and binds current physical
 * inputs only after ordinary preparation has made the exact technique legal.
 */
export interface RecordUseBasisV3 extends RecordUseBasisFields {
  version: 'record-use-basis-v3';
  carrierSource: RecordCarrierSource;
  acquisitionRequired: boolean;
  expectedOutputMaterialId: MaterialId;
  /** Missing on persisted v3 episodes means the original low-confidence learning path. */
  purpose?: 'learn' | 'replicate';
  /** Replication binds to the authored payload version, not a replaceable physical carrier. */
  recordVersion?: number;
  /** Stable opening/renewal evidence for the active project; it excludes mutable progress arrays. */
  projectRenewalBasisKey?: string;
  /** Optional only so persisted v3 learning episodes remain readable. New replication binds every input. */
  inputWitnesses?: RecordUseInputWitnessV1[];
}

export type RecordUseBasis = RecordUseBasisV1 | RecordUseBasisV2 | RecordUseBasisV3;

/** `share` and `read-experiment` remain for persisted v1 intents. */
export type RecordUseStage = 'share'
  | 'read-experiment'
  | 'acquire'
  | 'read'
  | 'prepare-experiment'
  | 'experiment'
  | 'replicate';

export type FactPredicate =
  | { kind: 'body-at-least'; field: 'health' | 'hydration' | 'nutrition'; value: number }
  | { kind: 'body-at-most'; personId: PersonId; field: 'health' | 'hydration' | 'nutrition'; value: number }
  | { kind: 'inventory-at-least'; materialId: MaterialId; quantity: number; personId?: PersonId }
  | { kind: 'record-held'; recordId: string; personId?: PersonId }
  | { kind: 'container-inventory-at-least'; containerId: string; materialId: MaterialId; quantity: number }
  | { kind: 'at-cell'; cellId: number }
  | { kind: 'sheltered' }
  | { kind: 'voxel-is'; position: VoxelPosition; materialId: MaterialId }
  | { kind: 'knowledge'; factId: string; minConfidence?: number; personId?: PersonId }
  | {
      kind: 'record-replication-receipt';
      basisKey: string;
      readerId: PersonId;
      projectId: string;
      recordId: string;
      recordVersion: number;
      techniqueId: string;
      ruleSignature: string;
      expectedOutputMaterialId: MaterialId;
    }
  | { kind: 'near-person'; personId: PersonId }
  | { kind: 'condition'; personId: PersonId; condition: ConditionKind; present: boolean; phase?: HibernationPhase }
  | { kind: 'project-completed'; projectId: string }
  | { kind: 'technique-demonstrated'; projectId: string; requestEventId: string }
  | { kind: 'agreement-fulfilled'; agreementId: string }
  | { kind: 'agreement-contribution-recorded'; agreementId: string; personId: PersonId }
  | { kind: 'death-mourned'; remainsId: string }
  | { kind: 'remains-interred'; remainsId: string }
  | { kind: 'memorial-marked'; remainsId: string }
  | { kind: 'representation-made'; representationId: string };

export type IntentStatus = 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';
export type IntentInterruptionKind = 'life-review'
  | 'required-response'
  | 'fulfillment'
  | 'record-use'
  | 'survival-reflex'
  | 'dependent-care'
  | 'shelter-maintenance'
  | 'voluntary-conversation';
export type IntentReturnOutcome = 'resumed' | 'parent-completed' | 'parent-blocked' | 'parent-unavailable';

export interface LifeReviewEvidence {
  version: 'causal-edge-v1' | 'causal-edge-v2';
  basisKey: string;
  optionKind: 'offer-reproduce' | 'offer-companion' | 'request-company';
  targetPersonId: PersonId;
  projectId: string;
  relationSourceEventIds: string[];
  projectSourceEventIds: string[];
  sourceFactIds: string[];
  femaleAgeBand?: 'under-30' | '30-34' | '35-37' | '38-40' | '41-45';
  lifePressure: number;
  projectPressure: number;
  relationshipBasis?: RelationshipCausalBasis;
}

export type IntentGoalOutcomeKind = 'achieved' | 'attempted-unmet' | 'not-evaluated';

/** Lifecycle completion and goal achievement are deliberately distinct. */
export interface IntentGoalOutcome {
  version: 'intent-goal-outcome-v1';
  kind: IntentGoalOutcomeKind;
  basisKey: string;
  resolvedAtMonth: number;
  sourceEventIds: string[];
}

/** Relative policy declared by an executable option. Absence means complete on achievement. */
export interface ActionCompletionPolicy {
  kind: 'maintain-state';
  durationMonths: number;
}

/** Absolute, replayable lifecycle installed when an option becomes an intent. */
export interface IntentLifecycle {
  version: 'intent-lifecycle-v1';
  completion: 'on-achievement' | 'maintain-state';
  reviewAtMonth: number;
  maintainUntilMonth?: number;
}

export interface Intent {
  id: string;
  ownerId: PersonId;
  summary: string;
  domain: 'strategic' | 'social';
  goal: FactPredicate;
  openingAction?: PrimitiveAction;
  openingActionCompleted?: boolean;
  declarationFulfilledAtEventId?: string;
  nextAction: PrimitiveAction;
  completionAction?: PrimitiveAction;
  target?: WorldRef;
  status: IntentStatus;
  createdAtMonth: number;
  lastProgressAtMonth: number;
  progress: number;
  /** Expected horizon for bounded review; it is not by itself a maintenance lock. */
  plannedDurationMonths?: number;
  /** New intents use lifecycle. Kept only so old snapshots retain their former maintenance semantics. */
  stateGoalUntilMonth?: number;
  lifecycle?: IntentLifecycle;
  sourceDecisionEventId: string;
  projectId?: string;
  /** Durable concern that this executable episode is currently serving. */
  characterAgendaItemId?: string;
  /** Fallible means within the durable concern; its failure does not erase the agenda item. */
  characterAgendaApproachId?: string;
  agreementId?: string;
  /** Agreement attempts that already existed before this intent bound to it. */
  reproductionAttemptEventIdsAtStart?: string[];
  relationshipBasis?: RelationshipCausalBasis;
  recordUseBasis?: RecordUseBasis;
  recordUseStage?: RecordUseStage;
  /** Child intents return to this exact parent instead of replacing it. */
  returnToIntentId?: string;
  interruptionKind?: IntentInterruptionKind;
  returnOutcome?: IntentReturnOutcome;
  returnResolvedAtMonth?: number;
  /** Present only while this parent is suspended by its current child. */
  suspendedByIntentId?: string;
  suspendedAtMonth?: number;
  /** The executable episode yielded because its project needs an external world change. */
  waitingFor?: 'world-change';
  /** A project parent paused for one continuous dehydrated-hibernation episode. */
  suspendedForHibernationConditionId?: string;
  lastResumedAtMonth?: number;
  /** Exact month this intent chain was released by a safe hibernation exit. */
  lastHibernationResumedAtMonth?: number;
  /** Structured local evidence for an edge-triggered interruption of a project. */
  lifeReview?: LifeReviewEvidence;
  lastReproductionAttemptAtMonth?: number;
  lastProcessAttemptAtMonth?: number;
  sourceFactIds?: string[];
  actionEventIds: string[];
  /** Optional for old states; never inferred from a legacy completed status. */
  goalOutcome?: IntentGoalOutcome;
  blockedReason?: string;
  replanCount: number;
}

export interface ActionOption {
  id: string;
  summary: string;
  reason: string;
  goal: FactPredicate;
  nextAction: PrimitiveAction;
  completionAction?: PrimitiveAction;
  target?: WorldRef;
  estimatedDuration: 'one-month' | 'several-months' | 'long' | 'unknown';
  /** Only real waiting/maintenance behavior opts in; ordinary achievements omit this field. */
  completionPolicy?: ActionCompletionPolicy;
  sourceFactIds: string[];
  /** Server-only source allow-list for an open conversation option. */
  openConversationGrounding?: OpenConversationGroundingEnvelope;
  requiresFollowUp?: boolean;
  domain?: 'strategic' | 'social';
  estimatedMonths?: number;
  risks?: string[];
  projectId?: string;
  /** Optional link for an option compiled from a durable character agenda. */
  characterAgendaItemId?: string;
  characterAgendaApproachId?: string;
  projectProposal?: ProjectProposal;
  relationshipBasis?: RelationshipCausalBasis;
  recordUseBasis?: RecordUseBasis;
  recordUseStage?: RecordUseStage;
  /** Local pressure, not civilization score. Used only to compare executable options. */
  projectPressure?: number;
  /**
   * Planner-facing meaning. Authoritative decision contexts always carry v1;
   * omission remains type-readable only for pre-classification builders and
   * narrow legacy test fixtures.
   */
  semantics?: ActionOptionSemanticsV1;
}

export type IntentDecision =
  | {
      kind: 'start'; optionId: string; followUpOptionId?: string; reason: string;
      utterance?: string; lifeReview?: LifeReviewEvidence;
      /** Resolved server-side source ids selected through request-scoped handles. */
      groundingSourceFactIds?: string[];
      /** Optional imaginative concern/approach; local rules ground it before persistence. */
      characterAgendaProposal?: CharacterAgendaProposal;
      /** Subjective agenda change; it never authorizes or reports a world action. */
      characterAgendaUpdate?: CharacterAgendaUpdate;
      /** Model-authored subjective direction; the option is only its compiled next step. */
      mentalAct?: MentalAct;
      /** Server-owned link to a player conversation that requested this model review. */
      sourceInteractionId?: string;
    }
  | {
      kind: 'revise'; intentId: string; optionId: string; followUpOptionId?: string;
      reason: string; utterance?: string; lifeReview?: LifeReviewEvidence;
      /** Resolved server-side source ids selected through request-scoped handles. */
      groundingSourceFactIds?: string[];
      mode?: 'replace' | 'interrupt'; interruptionKind?: IntentInterruptionKind;
      /** Optional imaginative concern/approach; local rules ground it before persistence. */
      characterAgendaProposal?: CharacterAgendaProposal;
      /** Subjective agenda change; it never authorizes or reports a world action. */
      characterAgendaUpdate?: CharacterAgendaUpdate;
      mentalAct?: MentalAct;
      /** Server-owned link to a player conversation that requested this model review. */
      sourceInteractionId?: string;
    }
  | { kind: 'suspend'; intentId: string; reason: string }
  | { kind: 'resume'; intentId: string; reason: string }
  | { kind: 'abandon'; intentId: string; reason: string }
  | {
      kind: 'idle'; reason: string;
      /** Allows reflection to change a durable concern without inventing an executable option. */
      characterAgendaUpdate?: CharacterAgendaUpdate;
      mentalAct?: MentalAct;
    };
