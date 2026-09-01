/**
 * Limited-embodiment transport and read-model contract.
 *
 * These structures describe commands and projections only. They do not grant
 * the browser authority to mutate a person, inventory, structure or voxel.
 */
import type {
  CosmosSnapshot,
  GameFrame,
  SkySample,
  SocietyAgent,
  SocietyState,
} from './societyContract';

export const EMBODIMENT_TICKS_PER_MONTH = 15 as const;

export type EmbodimentCommand =
  | { kind: 'wait' }
  | {
      kind: 'choose-option';
      optionId: string;
      choiceKey: string;
      followUpOptionId?: string;
    };

export type EmbodimentTargetView =
  | {
      kind: 'person';
      personId: string;
      cellId: number;
      z: number;
    }
  | {
      kind: 'structure';
      structureId: string;
      cellId?: number;
      z?: number;
    }
  | {
      kind: 'standing-position';
      cellId: number;
      z: number;
    }
  | {
      kind: 'voxel';
      cellId: number;
      z: number;
      materialId?: number;
    }
  | {
      kind: 'drop';
      dropId: string;
      cellId: number;
      z: number;
    }
  | {
      kind: 'container';
      containerId: string;
      cellId: number;
      z: number;
    }
  | {
      kind: 'animal';
      animalId: string;
      cellId: number;
      z: number;
    }
  | {
      kind: 'remains';
      remainsId: string;
      cellId: number;
      z: number;
    };

export type EmbodimentOptionCategory =
  | 'move'
  | 'build'
  | 'transfer'
  | 'attend'
  | 'talk'
  | 'survival'
  | 'project'
  | 'wait';

export interface EmbodimentOptionView {
  optionId: string;
  choiceKey: string;
  /** Where the application-layer option came from; not a domain permission. */
  source: 'wait' | 'continue-intent' | 'primitive-action' | 'decision';
  category: EmbodimentOptionCategory;
  label: string;
  reason?: string;
  tickCost: 1;
  target?: EmbodimentTargetView;
  materialCost?: Array<{ materialId: number; quantity: number }>;
  risks?: string[];
  primary: boolean;
}

export interface EmbodiedActorView {
  id: string;
  name: string;
  title: string;
  cellId: number;
  z: number;
  state: SocietyAgent['state'];
  doing: string;
  body: SocietyAgent['body'];
  conditions: SocietyAgent['conditions'];
  inventory: SocietyAgent['inventory'];
  activeIntent?: { id: string; summary: string };
}

export interface EmbodimentTickEventView {
  id: string;
  kind: string;
  planningTick: number;
  orderInTick: number;
  summary: string;
  actorId?: string;
  cellId?: number;
}

export type EmbodimentRuntimeStatus =
  | 'awaiting-command'
  | 'executing-tick'
  | 'releasing'
  | 'finalizing';

export interface EmbodimentView {
  id: string;
  actorId: string;
  status: EmbodimentRuntimeStatus;
  authorityRevision: string;
  civilizationId: number;
  branchId: string;
  baseElapsedMonths: number;
  atMonth: number;
  completedTick: number;
  nextTick?: number;
  revision: number;
  society: SocietyState;
  actor: EmbodiedActorView;
  options: EmbodimentOptionView[];
  tickEvents: EmbodimentTickEventView[];
}

export interface BeginEmbodimentRequest {
  runId: string;
  embodimentId: string;
  agentId: string;
  expectedAuthorityRevision: string;
  expectedCivilizationId: number;
  expectedBranchId: string;
  expectedElapsedMonths: number;
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
}

export interface EmbodimentStepRequest {
  runId: string;
  embodimentId: string;
  commandId: string;
  expectedRevision: number;
  expectedTick: number;
  command: EmbodimentCommand;
}

export interface ReleaseEmbodimentRequest {
  runId: string;
  embodimentId: string;
  releaseId: string;
  expectedRevision: number;
}

export interface EmbodimentCommandReceipt {
  commandId: string;
  embodimentId: string;
  command: EmbodimentCommand;
  actionTick: number;
  revision: number;
  completedTick: number;
  controlApplied: boolean;
  remappedOptionId?: string;
}

export interface EmbodimentReleaseReceipt {
  releaseId: string;
  embodimentId: string;
  revision: number;
  releasedAfterTick: number;
  committedElapsedMonths: number;
}

export type EmbodimentStepResponse =
  | {
      receipt: EmbodimentCommandReceipt;
      embodiment: EmbodimentView;
    }
  | {
      receipt: EmbodimentCommandReceipt;
      committedFrame: GameFrame;
    };

export interface EmbodimentReleaseResponse {
  receipt: EmbodimentReleaseReceipt;
  committedFrame: GameFrame;
}
