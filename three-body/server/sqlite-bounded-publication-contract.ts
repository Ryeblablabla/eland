import type { CheckpointAccumulatorV1, encodeCheckpointAccumulator } from "./checkpoint-accumulator";
import type {
  encodeObserverCivilizationHistorySidecar,
  ObserverCivilizationHistorySidecarPayloadV1,
} from "./civilization-history-codec";
import type { encodeHistoryRetentionSidecar } from "./history-retention-codec";
import type { HistoryRetentionProjectionResult } from "./history-retention-projection";
import type {
  encodeObserverDerivedHistorySidecar,
  ObserverDerivedHistorySidecarPayloadV1,
} from "./observer-derived-history-codec";
import type { encodePhysicalStructureLedgerSidecar } from "./physical-structure-ledger-codec";
import type { PhysicalStructureLedgerProjectionResult } from "./physical-structure-ledger-projection";
import type { RunSummary } from "./run-persistence";
import type {
  RunStateChunk,
  RunStateRootMetadata,
  VerifiedRunStateShellReuseIdentity,
} from "./run-state-codec";

export interface BoundedPublicationRunRow {
  readonly id: string;
  readonly stateHash: string;
  readonly meta: RunSummary;
}

export interface BoundedPublicationContinuationRow {
  readonly runId: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly rootSchemaVersion: number;
  readonly shellHash: string;
  readonly historyLineageId: string;
  readonly historyHeadHash: string | null;
  readonly eventCount: number;
  readonly tailEventId: string | null;
  readonly tailEventContentHash: string | null;
  readonly hotEventLimit: number;
  readonly bundleSchemaVersion: number;
  readonly bundleHash: string;
  readonly updatedAt: string;
}

export interface BoundedPublicationCheckpointRow {
  readonly runId: string;
  readonly revision: number;
  readonly month: number;
  readonly stateHash: string;
  readonly createdAt: string;
}

export interface BoundedPublicationChunkIdentity {
  readonly hash: string;
  readonly codec: string;
  readonly rawSize: number;
}

export interface BoundedPublicationSourceRecord {
  readonly runId: string;
  readonly generation: number;
  readonly run: BoundedPublicationRunRow;
  readonly continuation: BoundedPublicationContinuationRow;
  readonly root: RunStateChunk;
  readonly artifacts: Readonly<{
    retention: Readonly<HistoryRetentionProjectionResult>;
    physical: Readonly<PhysicalStructureLedgerProjectionResult>;
    derivedObserver: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
    civilizationObserver: Readonly<ObserverCivilizationHistorySidecarPayloadV1>;
    checkpoint: Readonly<CheckpointAccumulatorV1>;
  }>;
}

export interface BoundedPublicationSuccessorRecord {
  readonly sourceToken: object;
  readonly sourceGeneration: number;
  readonly run: BoundedPublicationRunRow;
  readonly root: RunStateChunk;
  readonly parts: readonly RunStateChunk[];
  readonly metadata: Readonly<RunStateRootMetadata>;
  readonly suffixEventCount: number;
  readonly historyTransition: "appended-events" | "same-history-shell";
  readonly shellReuseIdentity?: Readonly<VerifiedRunStateShellReuseIdentity>;
}

export interface BoundedPublicationOwnedSuccessorStage {
  readonly receipt: object;
  readonly sourceToken: object;
  readonly source: BoundedPublicationSourceRecord;
  readonly successor?: BoundedPublicationSuccessorRecord;
}

export interface BoundedPublicationEncodedSidecars {
  readonly retention: ReturnType<typeof encodeHistoryRetentionSidecar>;
  readonly physical: ReturnType<typeof encodePhysicalStructureLedgerSidecar>;
  readonly derivedObserver: ReturnType<typeof encodeObserverDerivedHistorySidecar>;
  readonly civilizationObserver: ReturnType<typeof encodeObserverCivilizationHistorySidecar>;
  readonly checkpoint: ReturnType<typeof encodeCheckpointAccumulator>;
}
