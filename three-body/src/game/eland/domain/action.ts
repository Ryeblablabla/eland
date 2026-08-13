import type { MaterialId } from './material';
import type { PersonId } from './person';

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
  | { id: string; kind: 'accept'; referenceId: string }
  | { id: string; kind: 'reject'; referenceId: string };

export type SocialProposal =
  | { kind: 'reproduce'; proposerId: PersonId; partnerId: PersonId; expiresAtMonth: number }
  | {
      kind: 'exchange'; offererId: PersonId; partnerId: PersonId;
      offererMaterialId: MaterialId; offererQuantity: number;
      partnerMaterialId: MaterialId; partnerQuantity: number;
      expiresAtMonth: number;
    };

export type PrimitiveAction =
  | { kind: 'move'; toCellId: number }
  | { kind: 'transfer'; materialId: MaterialId; quantity: number; from: HolderRef; to: HolderRef; dropId?: string; stackId?: string; authorizationRef?: string }
  | { kind: 'act'; operation: SourceOperation; targets: WorldRef[]; toolStackId?: string }
  | { kind: 'attend'; target: WorldRef; instrumentStackId?: string }
  | { kind: 'communicate'; content: RepresentationInput; audience: PersonId[]; channel: 'voice' | 'gesture' | 'record' };

export type FactPredicate =
  | { kind: 'body-at-least'; field: 'health' | 'hydration' | 'nutrition'; value: number }
  | { kind: 'body-at-most'; personId: PersonId; field: 'health' | 'hydration' | 'nutrition'; value: number }
  | { kind: 'inventory-at-least'; materialId: MaterialId; quantity: number; personId?: PersonId }
  | { kind: 'at-cell'; cellId: number }
  | { kind: 'voxel-is'; position: VoxelPosition; materialId: MaterialId }
  | { kind: 'knowledge'; factId: string; personId?: PersonId }
  | { kind: 'condition'; personId: PersonId; condition: 'cold' | 'heat' | 'wound' | 'illness' | 'pregnancy' | 'restrained'; present: boolean }
  | { kind: 'representation-made'; representationId: string };

export type IntentStatus = 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';

export interface Intent {
  id: string;
  ownerId: PersonId;
  summary: string;
  goal: FactPredicate;
  nextAction: PrimitiveAction;
  target?: WorldRef;
  status: IntentStatus;
  createdAtMonth: number;
  lastProgressAtMonth: number;
  progress: number;
  sourceDecisionEventId: string;
  sourceFactIds?: string[];
  actionEventIds: string[];
  blockedReason?: string;
}

export interface ActionOption {
  id: string;
  summary: string;
  reason: string;
  goal: FactPredicate;
  nextAction: PrimitiveAction;
  target?: WorldRef;
  estimatedDuration: 'one-month' | 'several-months' | 'long' | 'unknown';
  sourceFactIds: string[];
}

export type IntentDecision =
  | { kind: 'start'; optionId: string; reason: string }
  | { kind: 'continue'; intentId: string; reason: string }
  | { kind: 'revise'; intentId: string; optionId: string; reason: string }
  | { kind: 'suspend'; intentId: string; reason: string }
  | { kind: 'resume'; intentId: string; reason: string }
  | { kind: 'abandon'; intentId: string; reason: string }
  | { kind: 'idle'; reason: string };
