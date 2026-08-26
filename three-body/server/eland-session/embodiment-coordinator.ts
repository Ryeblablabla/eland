import { createHash } from 'node:crypto';

import { toSocietyState } from '../../src/game/eland/adapter';
import {
  buildPlayerEmbodimentOptions,
  resolvePlayerEmbodimentCommand,
  type PlayerEmbodimentCommandFailure,
} from '../../src/game/eland/application/player-embodiment';
import {
  executePlanningTick,
  finishMonthExecution,
  type MonthExecution,
  type TickExecutionResult,
} from '../../src/game/eland/application/simulation/month-execution';
import type { SimulationState, WorldEvent } from '../../src/game/eland/simulation';
import { PLANNING_TICKS_PER_MONTH } from '../../src/game/eland/domain/calendar';
import { isAlive } from '../../src/game/eland/domain/person';
import { personById } from '../../src/game/eland/domain/state-index';
import type {
  BeginEmbodimentRequest,
  EmbodiedActorView,
  EmbodimentCommand,
  EmbodimentCommandReceipt,
  EmbodimentReleaseResponse,
  EmbodimentStepRequest,
  EmbodimentStepResponse,
  EmbodimentTickEventView,
  EmbodimentView,
  ReleaseEmbodimentRequest,
} from '../../src/game/embodimentContract';
import type { CosmosSnapshot, GameFrame, SkySample } from '../../src/game/societyContract';
import type {
  ActiveEmbodimentSnapshot,
  CompletedEmbodimentSnapshot,
  FrozenEmbodimentDecision,
  StoredEmbodimentCommandReceipt,
} from './recovery';
import { logPerf, perfElapsed, perfNow } from '../perf';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class EmbodimentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbodimentConflictError';
  }
}

export class EmbodimentCommandRejectedError extends Error {
  constructor(readonly failure: PlayerEmbodimentCommandFailure) {
    super(commandFailureMessage(failure));
    this.name = 'EmbodimentCommandRejectedError';
  }
}

export class EmbodimentReplayMismatchError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
    detail?: string,
  ) {
    super(`有限化身暂存月份重放 hash 不一致（expected=${expectedHash}, actual=${actualHash}${detail ? `, ${detail}` : ''}）`);
    this.name = 'EmbodimentReplayMismatchError';
  }
}

export interface EmbodimentExecutionPreparation {
  execution: MonthExecution;
  frozenInitialDecisions: FrozenEmbodimentDecision[];
}

export interface EmbodimentCoordinatorHost {
  authority(): {
    revision: string;
    civilizationId: number;
    branchId: string;
    elapsedMonths: number;
    ended: boolean;
  };
  committedState(): SimulationState | null;
  /**
   * Build an isolated staged month. During restore, the supplied decisions are
   * authoritative replay input and this callback must not invoke a model.
   */
  prepareExecution(input: {
    state: SimulationState;
    actorId: string;
    skySample: SkySample;
    cosmosSnapshot?: CosmosSnapshot;
    frozenInitialDecisions?: FrozenEmbodimentDecision[];
  }): EmbodimentExecutionPreparation;
  /** Adopt and project a fully finished month exactly once. */
  commitMonth(input: {
    state: SimulationState;
    skySample: SkySample;
    cosmosSnapshot?: CosmosSnapshot;
  }): GameFrame | Promise<GameFrame>;
  now?(): number;
}

interface PendingCommand {
  fingerprint: string;
  promise: Promise<EmbodimentStepResponse>;
}

interface PendingRelease {
  fingerprint: string;
  promise: Promise<EmbodimentReleaseResponse>;
}

interface TerminalResult {
  frame: GameFrame;
  completed: CompletedEmbodimentSnapshot;
  releaseId?: string;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function embodimentBeginFingerprint(input: BeginEmbodimentRequest): string {
  return sha256({
    runId: input.runId,
    embodimentId: input.embodimentId,
    agentId: input.agentId,
    expectedAuthorityRevision: input.expectedAuthorityRevision,
    expectedCivilizationId: input.expectedCivilizationId,
    expectedBranchId: input.expectedBranchId,
    expectedElapsedMonths: input.expectedElapsedMonths,
    skySample: input.skySample,
    cosmosSnapshot: input.cosmosSnapshot,
  });
}

export function embodimentCommandFingerprint(input: EmbodimentStepRequest): string {
  return sha256({
    embodimentId: input.embodimentId,
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    expectedTick: input.expectedTick,
    command: input.command,
  });
}

export function embodimentReleaseFingerprint(input: ReleaseEmbodimentRequest): string {
  return sha256({
    embodimentId: input.embodimentId,
    releaseId: input.releaseId,
    expectedRevision: input.expectedRevision,
  });
}

function validId(value: string, maximum = 160): boolean {
  return value.length > 0 && value.length <= maximum && value === value.trim();
}

function commandFailureMessage(failure: PlayerEmbodimentCommandFailure): string {
  if (failure === 'person-unavailable') return '化身人物已经无法执行这个行动';
  if (failure === 'choice-ambiguous') return '这个行动目前对应多个不同选择，请重新查看';
  if (failure === 'option-unavailable') return '这个行动在当前刻度已经不可用';
  if (failure === 'emergency-first') return '身体必须先处理眼前的求生需要';
  if (failure === 'required-response-first') return '人物必须先回应眼前的社会请求';
  if (failure === 'fulfillment-first') return '人物必须先履行已经作出的承诺';
  return '这个行动没有通过当前世界条件复核';
}

function cloneExecution(execution: MonthExecution): MonthExecution {
  // Committed facts are immutable during a staged month. They are also the
  // largest cold member of long-running states, so copying the entire history
  // on every WASD tick only creates allocation pressure. Keep the history array
  // shared while a tick is speculative; detach the array immediately before
  // month finalization, which is the only point that appends to it.
  const committedPast = execution.prepared.state.world.past;
  const prepared = structuredClone({
    ...execution.prepared,
    state: {
      ...execution.prepared.state,
      world: {
        ...execution.prepared.state.world,
        past: [] as WorldEvent[],
      },
    },
  });
  prepared.state.world.past = committedPast;
  return {
    ...execution,
    prepared,
    usage: structuredClone(execution.usage),
    attempted: structuredClone(execution.attempted),
    reviewedPeople: new Set(execution.reviewedPeople),
    plannedAtTickOne: new Set(execution.plannedAtTickOne),
    ordinaryDeliberationCounts: new Map(execution.ordinaryDeliberationCounts),
    ordinaryReplanPermits: new Set(execution.ordinaryReplanPermits),
    participantIds: [...execution.participantIds],
  };
}

function detachPastForFinish(execution: MonthExecution): void {
  // finishMonthExecution appends the current month's events. A shallow array
  // copy is sufficient because already-committed WorldEvent facts are never
  // mutated; current-month events live in execution.prepared.events.
  execution.prepared.state.world.past = [...execution.prepared.state.world.past];
}

function updateCanonicalHash(
  hash: ReturnType<typeof createHash>,
  value: unknown,
  ancestors = new Set<object>(),
): void {
  if (value === null) {
    hash.update('null;');
    return;
  }
  if (value === undefined) {
    hash.update('undefined;');
    return;
  }
  if (typeof value === 'string') {
    hash.update(`string:${JSON.stringify(value)};`);
    return;
  }
  if (typeof value === 'number') {
    hash.update(`number:${Object.is(value, -0) ? '-0' : String(value)};`);
    return;
  }
  if (typeof value === 'boolean') {
    hash.update(value ? 'boolean:1;' : 'boolean:0;');
    return;
  }
  if (typeof value === 'bigint') {
    hash.update(`bigint:${value.toString()};`);
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`暂存状态包含无法 hash 的 ${typeof value}`);
  }
  if (ArrayBuffer.isView(value)) {
    hash.update(`view:${value.constructor.name}:${value.byteLength}:`);
    hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    hash.update(';');
    return;
  }
  if (value instanceof ArrayBuffer) {
    hash.update(`buffer:${value.byteLength}:`);
    hash.update(Buffer.from(value));
    hash.update(';');
    return;
  }
  if (ancestors.has(value)) throw new Error('暂存状态不得包含循环引用');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      hash.update(`array:${value.length}:[`);
      for (const item of value) updateCanonicalHash(hash, item, ancestors);
      hash.update('];');
      return;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    hash.update(`object:${keys.length}:{`);
    for (const key of keys) {
      hash.update(`key:${JSON.stringify(key)}=`);
      updateCanonicalHash(hash, record[key], ancestors);
    }
    hash.update('};');
  } finally {
    ancestors.delete(value);
  }
}

type ExecutionHashMode =
  | 'legacy-with-identity'
  | 'legacy-without-identity'
  | 'migration-equivalence'
  | 'v2'
  | 'v3';

function executionHashPayload(execution: MonthExecution, mode: ExecutionHashMode = 'v3') {
  // The voxel revision is a WeakMap-backed process-local cache identity. A
  // copied/recovered world deliberately starts a new revision sequence, while
  // its voxels and construction facts remain identical. Exclude the derived
  // physical index so recovery verifies authoritative staged facts instead of
  // an unreplayable cache counter.
  const {
    physicalStructureIndex: _physicalStructureIndex,
    // The absolute ledger cursor is derived from the same committed history
    // that is excluded below. Old active-embodiment snapshots predate this
    // field, so including it would make an otherwise identical replay hash
    // incompatible across restore.
    historyCursor: _historyCursor,
    // The committed history is immutable throughout a staged month and is
    // already protected by the recovery root/content store. Restore also adds
    // default tick coordinates to legacy facts, so hashing it here would make
    // a semantically identical committed base look different.
    past: _committedPast,
    ...world
  } = execution.prepared.state.world;
  // Observer projections are rebuilt on controller adoption and must never be
  // an input to domain decisions. Hash only the authoritative staged shell.
  const { derived: _derived, ...stateWithoutDerived } = execution.prepared.state;
  const stateWithoutIdentity = mode === 'legacy-without-identity'
    || mode === 'migration-equivalence' ? (() => {
      // Legacy snapshots written before monotonic identity allocation could not
      // include the compatibility counter synthesized by current restoration.
      const { identityCounters: _identityCounters, ...legacyState } = stateWithoutDerived;
      return legacyState;
    })() : stateWithoutDerived;
  const state = mode === 'v2' || mode === 'v3' || mode === 'migration-equivalence' ? (() => {
    // These fields are projection output. Refreshing them while adopting an
    // otherwise identical committed state must not invalidate a staged month.
    const {
      civilizationIndex: _civilizationIndex,
      development: _development,
      stage: _stage,
      ...civilization
    } = stateWithoutIdentity.civilization;
    return { ...stateWithoutIdentity, civilization };
  })() : stateWithoutIdentity;
  const cadence = mode === 'v3' || mode === 'migration-equivalence' ? {
    ordinaryDeliberationCounts: [...execution.ordinaryDeliberationCounts]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    ordinaryReplanPermits: [...execution.ordinaryReplanPermits].sort(),
  } : {};
  const payload = {
    state: { ...state, world },
    events: execution.prepared.events,
    atMonth: execution.prepared.atMonth,
    livingAgents: execution.prepared.livingAgents,
    candidateCount: execution.prepared.candidates.length,
    reviewedPeople: [...execution.reviewedPeople],
    plannedAtTickOne: [...execution.plannedAtTickOne],
    ...cadence,
    participantIds: execution.participantIds,
    completedTick: execution.completedTick,
    usage: execution.usage,
    attempted: execution.attempted,
  };
  return payload;
}

function canonicalHash(value: unknown): string {
  const hash = createHash('sha256');
  updateCanonicalHash(hash, value);
  return hash.digest('hex');
}

function executionHash(execution: MonthExecution, mode: ExecutionHashMode = 'v3'): string {
  return canonicalHash(executionHashPayload(execution, mode));
}

/** Server-internal compatibility seam for persisted staged-month fixtures. */
export function stagedExecutionHashForRecoveryVersion(
  execution: MonthExecution,
  version: 2 | 3,
): string {
  return executionHash(execution, version === 2 ? 'v2' : 'v3');
}

function migrationPartHashes(
  execution: MonthExecution,
): Record<string, string> {
  const { state, ...executionFields } = executionHashPayload(execution, 'migration-equivalence');
  return Object.fromEntries([
    ...Object.entries(state).map(([key, value]) => [`state.${key}`, canonicalHash(value)]),
    ...Object.entries(executionFields).map(([key, value]) => [`execution.${key}`, canonicalHash(value)]),
  ]);
}

function tickEventView(event: WorldEvent, fallbackOrder: number): EmbodimentTickEventView {
  const planningTick = event.planningTick ?? (event.kind === 'action' ? event.actionTick : 0);
  return {
    id: event.id,
    kind: event.kind,
    planningTick,
    orderInTick: event.orderInTick ?? fallbackOrder,
    summary: event.result,
    ...('who' in event && typeof event.who === 'string' ? { actorId: event.who } : {}),
    ...('cellId' in event && typeof event.cellId === 'number' ? { cellId: event.cellId } : {}),
  };
}

function actorView(
  society: ReturnType<typeof toSocietyState>,
  actorId: string,
): EmbodiedActorView {
  const actor = society.agents.find((candidate) => candidate.id === actorId);
  if (!actor) throw new EmbodimentConflictError('化身人物已经不在当前世界中');
  const intent = actor.activeIntentId
    ? society.intents.find((candidate) => candidate.id === actor.activeIntentId)
    : undefined;
  return {
    id: actor.id,
    name: actor.name,
    title: actor.title,
    cellId: actor.cellId,
    z: actor.z,
    state: actor.state,
    doing: actor.doing,
    body: actor.body,
    conditions: actor.conditions,
    inventory: actor.inventory,
    ...(intent ? { activeIntent: { id: intent.id, summary: intent.summary } } : {}),
  };
}

function validatePreparation(
  preparation: EmbodimentExecutionPreparation,
  committedState: SimulationState,
  actorId: string,
  baseElapsedMonths: number,
): void {
  const execution = preparation.execution;
  if (execution.prepared.state === committedState) {
    throw new Error('有限化身暂存月份不得拥有 committed state 的可变引用');
  }
  if (execution.controlledPersonId !== actorId
    || execution.completedTick !== 0
    || execution.finished
    || execution.prepared.atMonth !== baseElapsedMonths + 1
    || execution.prepared.state.clock.elapsedMonths !== baseElapsedMonths) {
    throw new Error('有限化身暂存月份的基础身份无效');
  }
}

function executeCommand(
  execution: MonthExecution,
  command: EmbodimentCommand,
): {
  execution: MonthExecution;
  tick: TickExecutionResult;
  cloneMs: number;
  tickMs: number;
  failure?: PlayerEmbodimentCommandFailure;
  remappedOptionId?: string;
} {
  const cloneStartedAt = perfNow();
  const candidate = cloneExecution(execution);
  const cloneMs = perfElapsed(cloneStartedAt);
  let failure: PlayerEmbodimentCommandFailure | undefined;
  let remappedOptionId: string | undefined;
  const tickStartedAt = perfNow();
  const tick = executePlanningTick(candidate, ({ state, person, atMonth }) => {
    const resolution = resolvePlayerEmbodimentCommand(state, person, atMonth, command);
    if (!resolution.ok) {
      failure = resolution.failure;
      return undefined;
    }
    remappedOptionId = resolution.remappedOptionId;
    return resolution.control;
  });
  const tickMs = perfElapsed(tickStartedAt);
  return {
    execution: candidate,
    tick,
    cloneMs,
    tickMs,
    ...(failure ? { failure } : {}),
    ...(remappedOptionId ? { remappedOptionId } : {}),
  };
}

/** Coordinates one staged month. It owns no domain rule and no persistence. */
export class EmbodimentCoordinator {
  private execution: MonthExecution;
  private durable: ActiveEmbodimentSnapshot;
  private status: EmbodimentView['status'] = 'awaiting-command';
  private tickEvents: WorldEvent[] = [];
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private pendingRelease: PendingRelease | null = null;
  private terminal: TerminalResult | null = null;

  private constructor(
    private readonly host: EmbodimentCoordinatorHost,
    snapshot: ActiveEmbodimentSnapshot,
    execution: MonthExecution,
  ) {
    this.durable = snapshot;
    this.execution = execution;
  }

  static begin(
    host: EmbodimentCoordinatorHost,
    input: BeginEmbodimentRequest,
  ): EmbodimentCoordinator {
    const totalStartedAt = perfNow();
    if (!validId(input.embodimentId) || !validId(input.agentId, 320)) {
      throw new EmbodimentConflictError('有限化身标识或人物标识无效');
    }
    const authority = host.authority();
    if (authority.ended) throw new EmbodimentConflictError('已经结束的文明不能进入化身');
    if (input.expectedAuthorityRevision !== authority.revision
      || input.expectedCivilizationId !== authority.civilizationId
      || input.expectedBranchId !== authority.branchId
      || input.expectedElapsedMonths !== authority.elapsedMonths) {
      throw new EmbodimentConflictError('文明已经推进或切换，请按当前状态重新进入化身');
    }
    if (input.cosmosSnapshot && input.cosmosSnapshot.t !== input.skySample.toTime) {
      throw new EmbodimentConflictError('有限化身的宇宙快照与天象时刻不一致');
    }
    const committedState = host.committedState();
    const actor = committedState ? personById(committedState, input.agentId) : undefined;
    if (!committedState || !actor || !isAlive(actor)) {
      throw new EmbodimentConflictError('只能进入当前分支中仍然在世的人物');
    }
    const prepareStartedAt = perfNow();
    const preparation = host.prepareExecution({
      state: committedState,
      actorId: input.agentId,
      skySample: input.skySample,
      ...(input.cosmosSnapshot ? { cosmosSnapshot: input.cosmosSnapshot } : {}),
    });
    const prepareMs = perfElapsed(prepareStartedAt);
    validatePreparation(preparation, committedState, input.agentId, authority.elapsedMonths);
    const now = host.now?.() ?? Date.now();
    const hashStartedAt = perfNow();
    const stagedStateHash = executionHash(preparation.execution);
    const hashMs = perfElapsed(hashStartedAt);
    const durable: ActiveEmbodimentSnapshot = {
      schemaVersion: 1,
      id: input.embodimentId,
      actorId: input.agentId,
      status: 'awaiting-command',
      beginFingerprint: embodimentBeginFingerprint(input),
      baseAuthorityRevision: authority.revision,
      civilizationId: authority.civilizationId,
      branchId: authority.branchId,
      baseElapsedMonths: authority.elapsedMonths,
      atMonth: preparation.execution.prepared.atMonth,
      skySample: structuredClone(input.skySample),
      ...(input.cosmosSnapshot ? { cosmosSnapshot: structuredClone(input.cosmosSnapshot) } : {}),
      completedTick: 0,
      revision: 0,
      frozenInitialDecisions: structuredClone(preparation.frozenInitialDecisions),
      decisionUsage: structuredClone(preparation.execution.usage),
      decisionAttempts: structuredClone(preparation.execution.attempted),
      commands: [],
      stagedStateHashVersion: 3,
      stagedStateHash,
      createdAt: now,
      updatedAt: now,
    };
    logPerf('embodiment-begin-core', {
      embodimentId: input.embodimentId,
      actorId: input.agentId,
      branchId: authority.branchId,
      month: preparation.execution.prepared.atMonth,
      people: preparation.execution.prepared.state.people.length,
      committedEvents: preparation.execution.prepared.state.world.past.length,
      prepareMs,
      hashMs,
      totalMs: perfElapsed(totalStartedAt),
    });
    return new EmbodimentCoordinator(host, durable, preparation.execution);
  }

  static restore(
    host: EmbodimentCoordinatorHost,
    snapshotInput: ActiveEmbodimentSnapshot,
    legacyCommittedState?: SimulationState,
  ): EmbodimentCoordinator {
    const snapshot = structuredClone(snapshotInput);
    if (!SHA256_PATTERN.test(snapshot.stagedStateHash)) {
      throw new Error('有限化身暂存状态 hash 无效');
    }
    const authority = host.authority();
    const committedState = host.committedState();
    if (!committedState
      || authority.civilizationId !== snapshot.civilizationId
      || authority.branchId !== snapshot.branchId
      || authority.elapsedMonths !== snapshot.baseElapsedMonths) {
      throw new Error('有限化身暂存月份不属于当前 committed authority');
    }

    const replayAgainst = (baseState: SimulationState): {
      execution: MonthExecution;
      receipts: StoredEmbodimentCommandReceipt[];
    } => {
      const preparation = host.prepareExecution({
        state: baseState,
        actorId: snapshot.actorId,
        skySample: snapshot.skySample,
        ...(snapshot.cosmosSnapshot ? { cosmosSnapshot: snapshot.cosmosSnapshot } : {}),
        frozenInitialDecisions: structuredClone(snapshot.frozenInitialDecisions),
      });
      validatePreparation(preparation, baseState, snapshot.actorId, snapshot.baseElapsedMonths);
      // The host can deterministically rebuild rule decisions, but model usage
      // is accounting input rather than a consequence of those decisions.
      let execution: MonthExecution = {
        ...preparation.execution,
        usage: structuredClone(snapshot.decisionUsage),
        attempted: structuredClone(snapshot.decisionAttempts),
      };
      const receipts: StoredEmbodimentCommandReceipt[] = [];
      for (const stored of snapshot.commands) {
        const replay = executeCommand(execution, stored.receipt.command);
        if (replay.tick.controlRequested && replay.failure) {
          throw new Error(`有限化身命令 ${stored.receipt.commandId} 无法确定性重放`);
        }
        execution = replay.execution;
        const generatedReceipt: EmbodimentCommandReceipt = {
          commandId: stored.receipt.commandId,
          embodimentId: snapshot.id,
          command: structuredClone(stored.receipt.command),
          actionTick: replay.tick.actionTick,
          revision: receipts.length + 1,
          completedTick: replay.tick.actionTick,
          controlApplied: replay.tick.controlApplied,
          ...(replay.remappedOptionId ? { remappedOptionId: replay.remappedOptionId } : {}),
        };
        if (generatedReceipt.actionTick !== stored.receipt.actionTick
          || generatedReceipt.revision !== stored.receipt.revision
          || generatedReceipt.controlApplied !== stored.receipt.controlApplied
          || generatedReceipt.remappedOptionId !== stored.receipt.remappedOptionId) {
          throw new Error(`有限化身命令 ${stored.receipt.commandId} 的重放收据不一致`);
        }
        receipts.push({ fingerprint: stored.fingerprint, receipt: generatedReceipt });
      }
      if (execution.completedTick !== snapshot.completedTick
        || receipts.length !== snapshot.commands.length) {
        throw new Error('有限化身暂存月份重放进度不一致');
      }
      return { execution, receipts };
    };

    // Verify and release the legacy execution before building the current one.
    // Long-running worlds are large enough that retaining both staged copies at
    // once can exceed the worker heap during an otherwise valid recovery.
    const legacyVerification = snapshot.stagedStateHashVersion === undefined ? (() => {
      if (!legacyCommittedState) throw new Error('有限化身旧版暂存月份缺少原始 committed state');
      const legacyReplay = replayAgainst(legacyCommittedState);
      const legacyStateHash = executionHash(
        legacyReplay.execution,
        legacyCommittedState.identityCounters === undefined
          ? 'legacy-without-identity'
          : 'legacy-with-identity',
      );
      if (legacyStateHash !== snapshot.stagedStateHash) {
        throw new EmbodimentReplayMismatchError(snapshot.stagedStateHash, legacyStateHash);
      }
      const partHashes = migrationPartHashes(legacyReplay.execution);
      return { meaningHash: canonicalHash(partHashes), partHashes };
    })() : null;

    // Current snapshots replay from the adopted committed state. After exact
    // legacy verification, the current replay may differ only in newly
    // synthesized identity counters and observer-owned civilization fields.
    // Exact v2 verification deliberately uses the pre-cadence payload; every
    // successful restore is then migrated to the cadence-aware v3 payload.
    const currentReplay = replayAgainst(committedState);
    const currentStateHashV3 = executionHash(currentReplay.execution, 'v3');
    if (snapshot.stagedStateHashVersion === 2) {
      const currentStateHashV2 = executionHash(currentReplay.execution, 'v2');
      if (currentStateHashV2 !== snapshot.stagedStateHash) {
        throw new EmbodimentReplayMismatchError(snapshot.stagedStateHash, currentStateHashV2);
      }
    } else if (snapshot.stagedStateHashVersion === 3) {
      if (currentStateHashV3 !== snapshot.stagedStateHash) {
        throw new EmbodimentReplayMismatchError(snapshot.stagedStateHash, currentStateHashV3);
      }
    } else {
      const currentPartHashes = migrationPartHashes(currentReplay.execution);
      const currentMeaningHash = canonicalHash(currentPartHashes);
      if (legacyVerification?.meaningHash !== currentMeaningHash) {
        const differingParts = Object.keys(legacyVerification!.partHashes)
          .filter((key) => legacyVerification!.partHashes[key] !== currentPartHashes[key]);
        throw new EmbodimentReplayMismatchError(
          legacyVerification!.meaningHash,
          currentMeaningHash,
          `parts=${differingParts.join('|')}`,
        );
      }
    }
    const restored = new EmbodimentCoordinator(host, {
      ...snapshot,
      commands: currentReplay.receipts,
      // A strictly verified legacy replay migrates to the independently rebuilt
      // current execution, not merely to a new label on the legacy execution.
      stagedStateHashVersion: 3,
      stagedStateHash: currentStateHashV3,
      // Runtime authority revisions rotate on process/session restore. The
      // original value remains in beginFingerprint and persisted audit data;
      // new views derive their revision from host.authority().
      baseAuthorityRevision: authority.revision,
    }, currentReplay.execution);
    return restored;
  }

  id(): string {
    return this.durable.id;
  }

  actorId(): string {
    return this.durable.actorId;
  }

  isMutating(): boolean {
    return !this.terminal && this.status !== 'awaiting-command';
  }

  isComplete(): boolean {
    return this.terminal !== null;
  }

  matchesBegin(input: BeginEmbodimentRequest): boolean {
    return input.embodimentId === this.durable.id
      && embodimentBeginFingerprint(input) === this.durable.beginFingerprint;
  }

  snapshot(): ActiveEmbodimentSnapshot {
    return structuredClone(this.durable);
  }

  completedSnapshot(): CompletedEmbodimentSnapshot | null {
    return this.terminal ? structuredClone(this.terminal.completed) : null;
  }

  view(): EmbodimentView {
    const totalStartedAt = perfNow();
    const state = this.execution.prepared.state;
    const person = personById(state, this.durable.actorId);
    const projectionStartedAt = perfNow();
    const society = toSocietyState(state);
    const projectionMs = perfElapsed(projectionStartedAt);
    const optionsStartedAt = perfNow();
    const options = this.status === 'awaiting-command' && person && isAlive(person)
      ? buildPlayerEmbodimentOptions(state, person, this.durable.atMonth)
      : [];
    const optionsMs = perfElapsed(optionsStartedAt);
    const authority = this.host.authority();
    const view: EmbodimentView = {
      id: this.durable.id,
      actorId: this.durable.actorId,
      status: this.status,
      authorityRevision: authority.revision,
      civilizationId: this.durable.civilizationId,
      branchId: this.durable.branchId,
      baseElapsedMonths: this.durable.baseElapsedMonths,
      atMonth: this.durable.atMonth,
      completedTick: this.execution.completedTick,
      ...(this.execution.completedTick < PLANNING_TICKS_PER_MONTH
        ? { nextTick: this.execution.completedTick + 1 }
        : {}),
      revision: this.durable.revision,
      society,
      actor: actorView(society, this.durable.actorId),
      options,
      tickEvents: this.tickEvents.map(tickEventView),
    };
    logPerf('embodiment-view', {
      embodimentId: this.durable.id,
      actorId: this.durable.actorId,
      branchId: this.durable.branchId,
      month: this.durable.atMonth,
      tick: this.execution.completedTick,
      revision: this.durable.revision,
      status: this.status,
      people: state.people.length,
      options: options.length,
      projectionMs,
      optionsMs,
      totalMs: perfElapsed(totalStartedAt),
    });
    return view;
  }

  step(input: EmbodimentStepRequest): Promise<EmbodimentStepResponse> {
    if (!validId(input.commandId)) {
      return Promise.reject(new EmbodimentConflictError('commandId 无效'));
    }
    const fingerprint = embodimentCommandFingerprint(input);
    const completed = this.durable.commands.find((stored) => stored.receipt.commandId === input.commandId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        return Promise.reject(new EmbodimentConflictError('commandId 已用于不同的化身行动'));
      }
      if (this.terminal) {
        return Promise.resolve({ receipt: completed.receipt, committedFrame: this.terminal.frame });
      }
      return Promise.resolve({ receipt: completed.receipt, embodiment: this.view() });
    }
    const pending = this.pendingCommands.get(input.commandId);
    if (pending) {
      return pending.fingerprint === fingerprint
        ? pending.promise
        : Promise.reject(new EmbodimentConflictError('commandId 正在用于不同的化身行动'));
    }
    if (this.terminal) return Promise.reject(new EmbodimentConflictError('这个化身月份已经提交'));
    if (this.pendingRelease) return Promise.reject(new EmbodimentConflictError('正在交还人物自主权'));
    if (this.pendingCommands.size > 0) {
      return Promise.reject(new EmbodimentConflictError('当前刻度仍在执行'));
    }
    if (input.embodimentId !== this.durable.id) {
      return Promise.reject(new EmbodimentConflictError('化身标识已经改变'));
    }
    if (input.expectedRevision !== this.durable.revision
      || input.expectedTick !== this.execution.completedTick + 1) {
      return Promise.reject(new EmbodimentConflictError('化身刻度已经推进，请按当前状态重新行动'));
    }
    const promise = this.executeStep(input, fingerprint).finally(() => {
      const registered = this.pendingCommands.get(input.commandId);
      if (registered?.promise === promise) this.pendingCommands.delete(input.commandId);
    });
    this.pendingCommands.set(input.commandId, { fingerprint, promise });
    return promise;
  }

  private async executeStep(
    input: EmbodimentStepRequest,
    fingerprint: string,
  ): Promise<EmbodimentStepResponse> {
    const totalStartedAt = perfNow();
    let cloneMs = 0;
    let tickMs = 0;
    let hashMs = 0;
    let viewMs = 0;
    let finishMs = 0;
    let commitMs = 0;
    let outcome = 'failed';
    this.status = 'executing-tick';
    try {
      const result = executeCommand(this.execution, input.command);
      cloneMs = result.cloneMs;
      tickMs = result.tickMs;
      if (result.tick.controlRequested && result.failure) {
        outcome = 'rejected';
        throw new EmbodimentCommandRejectedError(result.failure);
      }
      const revision = this.durable.revision + 1;
      const receipt: EmbodimentCommandReceipt = {
        commandId: input.commandId,
        embodimentId: this.durable.id,
        command: structuredClone(input.command),
        actionTick: result.tick.actionTick,
        revision,
        completedTick: result.tick.actionTick,
        controlApplied: result.tick.controlApplied,
        ...(result.remappedOptionId ? { remappedOptionId: result.remappedOptionId } : {}),
      };
      const now = this.host.now?.() ?? Date.now();
      const stored = { fingerprint, receipt } satisfies StoredEmbodimentCommandReceipt;
      this.tickEvents = result.tick.events;

      if (result.execution.completedTick < PLANNING_TICKS_PER_MONTH) {
        const hashStartedAt = perfNow();
        const stagedStateHash = executionHash(result.execution);
        hashMs = perfElapsed(hashStartedAt);
        this.execution = result.execution;
        this.durable = {
          ...this.durable,
          completedTick: result.execution.completedTick,
          revision,
          commands: [...this.durable.commands, stored],
          stagedStateHash,
          updatedAt: now,
        };
        this.status = 'awaiting-command';
        const viewStartedAt = perfNow();
        const embodiment = this.view();
        viewMs = perfElapsed(viewStartedAt);
        outcome = 'awaiting-command';
        return { receipt, embodiment };
      }

      this.status = 'finalizing';
      // This is the only transition that appends to world.past. Detaching here
      // preserves rollback if finalization or commit fails.
      detachPastForFinish(result.execution);
      const finishStartedAt = perfNow();
      const state = finishMonthExecution(result.execution);
      finishMs = perfElapsed(finishStartedAt);
      const commitStartedAt = perfNow();
      let frame: GameFrame;
      try {
        frame = await this.host.commitMonth({
          state,
          skySample: this.durable.skySample,
          ...(this.durable.cosmosSnapshot ? { cosmosSnapshot: this.durable.cosmosSnapshot } : {}),
        });
      } finally {
        commitMs = perfElapsed(commitStartedAt);
      }
      this.execution = result.execution;
      this.durable = {
        ...this.durable,
        completedTick: result.execution.completedTick,
        revision,
        commands: [...this.durable.commands, stored],
        updatedAt: now,
      };
      // No staged hash is recomputed here: the staged authority has already
      // become a committed month and recovery persists the completed receipt,
      // not this now-terminal ActiveEmbodimentSnapshot.
      const completed: CompletedEmbodimentSnapshot = {
        schemaVersion: 1,
        id: this.durable.id,
        beginFingerprint: this.durable.beginFingerprint,
        civilizationId: this.durable.civilizationId,
        branchId: this.durable.branchId,
        baseElapsedMonths: this.durable.baseElapsedMonths,
        committedElapsedMonths: frame.elapsedMonths,
        commandReceipts: structuredClone(this.durable.commands),
        completedAt: now,
      };
      this.terminal = { frame, completed };
      outcome = 'committed';
      return { receipt, committedFrame: frame };
    } finally {
      if (!this.terminal) this.status = 'awaiting-command';
      logPerf('embodiment-step-core', {
        embodimentId: this.durable.id,
        commandId: input.commandId,
        actorId: this.durable.actorId,
        branchId: this.durable.branchId,
        month: this.durable.atMonth,
        expectedTick: input.expectedTick,
        completedTick: this.execution.completedTick,
        commandKind: input.command.kind,
        outcome,
        cloneMs,
        tickMs,
        cloneTickMs: Math.round((cloneMs + tickMs) * 100) / 100,
        hashMs,
        viewMs,
        finishMs,
        commitMs,
        totalMs: perfElapsed(totalStartedAt),
      });
    }
  }

  release(input: ReleaseEmbodimentRequest): Promise<EmbodimentReleaseResponse> {
    if (!validId(input.releaseId)) {
      return Promise.reject(new EmbodimentConflictError('releaseId 无效'));
    }
    const fingerprint = embodimentReleaseFingerprint(input);
    if (this.terminal?.releaseId === input.releaseId && this.terminal.completed.release) {
      return this.terminal.completed.release.fingerprint === fingerprint
        ? Promise.resolve({
            receipt: this.terminal.completed.release.receipt,
            committedFrame: this.terminal.frame,
          })
        : Promise.reject(new EmbodimentConflictError('releaseId 已用于不同的交还请求'));
    }
    if (this.pendingRelease) {
      return this.pendingRelease.fingerprint === fingerprint
        ? this.pendingRelease.promise
        : Promise.reject(new EmbodimentConflictError('另一个交还请求正在执行'));
    }
    if (this.terminal) return Promise.reject(new EmbodimentConflictError('这个化身月份已经提交'));
    if (this.pendingCommands.size > 0) return Promise.reject(new EmbodimentConflictError('当前刻度仍在执行'));
    if (input.embodimentId !== this.durable.id) {
      return Promise.reject(new EmbodimentConflictError('化身标识已经改变'));
    }
    if (input.expectedRevision !== this.durable.revision) {
      return Promise.reject(new EmbodimentConflictError('化身修订已经变化，请按当前状态重新交还'));
    }
    const promise = this.executeRelease(input, fingerprint).finally(() => {
      if (this.pendingRelease?.promise === promise) this.pendingRelease = null;
    });
    this.pendingRelease = { fingerprint, promise };
    return promise;
  }

  private async executeRelease(
    input: ReleaseEmbodimentRequest,
    fingerprint: string,
  ): Promise<EmbodimentReleaseResponse> {
    const totalStartedAt = perfNow();
    const releasedAfterTick = this.execution.completedTick;
    let cloneMs = 0;
    let tickMs = 0;
    let finishMs = 0;
    let commitMs = 0;
    let autonomousTicks = 0;
    let outcome = 'failed';
    this.status = 'releasing';
    try {
      const cloneStartedAt = perfNow();
      const candidate = cloneExecution(this.execution);
      cloneMs = perfElapsed(cloneStartedAt);
      let lastTickEvents: WorldEvent[] = [];
      const tickStartedAt = perfNow();
      while (candidate.completedTick < PLANNING_TICKS_PER_MONTH) {
        lastTickEvents = executePlanningTick(candidate).events;
        autonomousTicks += 1;
      }
      tickMs = perfElapsed(tickStartedAt);
      this.status = 'finalizing';
      detachPastForFinish(candidate);
      const finishStartedAt = perfNow();
      const state = finishMonthExecution(candidate);
      finishMs = perfElapsed(finishStartedAt);
      const commitStartedAt = perfNow();
      let frame: GameFrame;
      try {
        frame = await this.host.commitMonth({
          state,
          skySample: this.durable.skySample,
          ...(this.durable.cosmosSnapshot ? { cosmosSnapshot: this.durable.cosmosSnapshot } : {}),
        });
      } finally {
        commitMs = perfElapsed(commitStartedAt);
      }
      const now = this.host.now?.() ?? Date.now();
      const receipt = {
        releaseId: input.releaseId,
        embodimentId: this.durable.id,
        revision: this.durable.revision + 1,
        releasedAfterTick,
        committedElapsedMonths: frame.elapsedMonths,
      } as const;
      this.execution = candidate;
      this.tickEvents = lastTickEvents;
      const completed: CompletedEmbodimentSnapshot = {
        schemaVersion: 1,
        id: this.durable.id,
        beginFingerprint: this.durable.beginFingerprint,
        civilizationId: this.durable.civilizationId,
        branchId: this.durable.branchId,
        baseElapsedMonths: this.durable.baseElapsedMonths,
        committedElapsedMonths: frame.elapsedMonths,
        commandReceipts: structuredClone(this.durable.commands),
        release: { fingerprint, receipt },
        completedAt: now,
      };
      this.terminal = { frame, completed, releaseId: input.releaseId };
      outcome = 'committed';
      return { receipt, committedFrame: frame };
    } finally {
      if (!this.terminal) this.status = 'awaiting-command';
      logPerf('embodiment-release-core', {
        embodimentId: this.durable.id,
        releaseId: input.releaseId,
        actorId: this.durable.actorId,
        branchId: this.durable.branchId,
        month: this.durable.atMonth,
        releasedAfterTick,
        autonomousTicks,
        outcome,
        cloneMs,
        tickMs,
        cloneTickMs: Math.round((cloneMs + tickMs) * 100) / 100,
        hashMs: 0,
        viewMs: 0,
        finishMs,
        commitMs,
        totalMs: perfElapsed(totalStartedAt),
      });
    }
  }
}
