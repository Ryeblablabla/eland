import type { MaterialId } from './material';
import type { ConditionKind, PersonId } from './person';

export interface VoxelPosition { x: number; y: number; z: number }

export type WorldRef =
  | { kind: 'voxel'; position: VoxelPosition }
  | { kind: 'drop'; dropId: string }
  | { kind: 'inventory-stack'; personId: PersonId; stackId: string }
  | { kind: 'person'; personId: PersonId };

export type HolderRef =
  | { kind: 'ground'; cellId: number }
  | { kind: 'person'; personId: PersonId };

export type SourceOperation = 'exert' | 'separate' | 'combine' | 'expose' | 'ingest' | 'reproduce';

export type RepresentationInput =
  | { id: string; kind: 'claim'; summary: string; factId?: string }
  | { id: string; kind: 'request'; summary: string; proposal?: SocialProposal }
  | { id: string; kind: 'offer'; summary: string; proposal?: SocialProposal }
  | { id: string; kind: 'accept'; referenceId: string; summary?: string }
  | { id: string; kind: 'reject'; referenceId: string; summary?: string }
  | { id: string; kind: 'revoke'; permissionId: string; summary: string }
  | { id: string; kind: 'withdraw'; collectiveId: string; summary: string };

export type SocialProposal =
  | { kind: 'reproduce'; proposerId: PersonId; partnerId: PersonId; expiresAtMonth: number }
  | { kind: 'assist'; requesterId: PersonId; helperId: PersonId; need: 'water' | 'food' | 'shelter' | 'company'; expiresAtMonth: number }
  | { kind: 'companion'; proposerId: PersonId; partnerId: PersonId; expiresAtMonth: number }
  | { kind: 'collective'; proposerId: PersonId; partnerId: PersonId; purposeSummary: string; expiresAtMonth: number }
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
  | { kind: 'move'; toCellId: number }
  | { kind: 'transfer'; materialId: MaterialId; quantity: number; from: HolderRef; to: HolderRef; dropId?: string; stackId?: string; authorizationRef?: string }
  | { kind: 'act'; operation: SourceOperation; targets: WorldRef[]; toolStackId?: string }
  | { kind: 'attend'; target: WorldRef; instrumentStackId?: string }
  | { kind: 'communicate'; content: RepresentationInput; audience: PersonId[]; channel: 'voice' | 'gesture' | 'record'; carrierStackId?: string };

export type FactPredicate =
  | { kind: 'body-at-least'; field: 'health' | 'hydration' | 'nutrition'; value: number }
  | { kind: 'body-at-most'; personId: PersonId; field: 'health' | 'hydration' | 'nutrition'; value: number }
  | { kind: 'inventory-at-least'; materialId: MaterialId; quantity: number; personId?: PersonId }
  | { kind: 'at-cell'; cellId: number }
  | { kind: 'voxel-is'; position: VoxelPosition; materialId: MaterialId }
  | { kind: 'knowledge'; factId: string; minConfidence?: number; personId?: PersonId }
  | { kind: 'near-person'; personId: PersonId }
  | { kind: 'condition'; personId: PersonId; condition: ConditionKind; present: boolean }
  | { kind: 'representation-made'; representationId: string };

export type IntentStatus = 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';

export interface Intent {
  id: string;
  ownerId: PersonId;
  summary: string;
  domain: 'strategic' | 'social';
  goal: FactPredicate;
  openingAction?: PrimitiveAction;
  openingActionCompleted?: boolean;
  nextAction: PrimitiveAction;
  completionAction?: PrimitiveAction;
  target?: WorldRef;
  status: IntentStatus;
  createdAtMonth: number;
  lastProgressAtMonth: number;
  progress: number;
  sourceDecisionEventId: string;
  agreementId?: string;
  sourceFactIds?: string[];
  actionEventIds: string[];
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
  sourceFactIds: string[];
  requiresFollowUp?: boolean;
  domain?: 'strategic' | 'social';
  estimatedMonths?: number;
  risks?: string[];
}

export type IntentDecision =
  | { kind: 'start'; optionId: string; followUpOptionId?: string; reason: string; utterance?: string }
  | { kind: 'revise'; intentId: string; optionId: string; followUpOptionId?: string; reason: string; utterance?: string }
  | { kind: 'suspend'; intentId: string; reason: string }
  | { kind: 'resume'; intentId: string; reason: string }
  | { kind: 'abandon'; intentId: string; reason: string }
  | { kind: 'idle'; reason: string };
