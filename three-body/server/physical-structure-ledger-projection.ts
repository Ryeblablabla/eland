import { createHash } from 'node:crypto';
import { deserialize } from 'node:v8';
import { brotliDecompressSync } from 'node:zlib';
import {
  beginPhysicalStructureFold,
  finishPhysicalStructureFold,
  foldPhysicalStructureEvents,
  type PhysicalStructureFold,
} from '../src/game/eland/domain/physical-structure-index';
import type {
  PhysicalStructureIndex,
  SimulationState,
  WorldEvent,
} from '../src/game/eland/domain/model';
import {
  WORLD_DEPTH,
  WORLD_LEVELS,
  WORLD_WIDTH,
  voxelWorldRevision,
  type VoxelWorld,
} from '../src/game/eland/world/grid';
import {
  decodeSegmentedRunStateGameplayBounded,
  decodeSegmentedRunStateBounded,
  parseRunStateShellManifest,
  parseRunStateRoot,
  RUN_STATE_SHELL_PART_CODEC,
  snapshotRunStateChunk,
  streamVerifiedRunHistorySegments,
  streamVerifiedRunHistorySuccessorSegments,
  verifyRunStateSameHistoryShellSuccessor,
  verifiedRunStateChunkData,
  type DecodedBoundedRunState,
  type DecodedBoundedGameplayRunState,
  type RunStateChunk,
  type RunStateBoundedDecodeOptions,
  type RunStateGameplayBoundedDecodeOptions,
  type RunStateRootMetadata,
  type RunStateShellFieldReference,
} from './run-state-codec';
import { assertDecodedPhysicalStructureLedgerSidecar } from './physical-structure-ledger-codec';

export interface PhysicalStructureLedgerAuthority {
  stateHash: string;
}

export interface PhysicalStructureLedgerSeal {
  eventCount: number;
  tailEventId: string | null;
}

/**
 * Immutable, bounded provenance retained for a module-minted projection.
 * Every field is a scalar so keeping a projection alive cannot retain its
 * decoded SimulationState, voxel buffer, or resident history shell.
 */
export interface PhysicalStructureLedgerSourceSeal {
  schemaVersion: 1;
  stateHash: string;
  eventCount: number;
  tailEventId: string | null;
  elapsedMonths: number;
  voxelRevision: number;
  voxelContentHash: string;
}

export interface PhysicalStructureLedgerProjectionResult {
  schemaVersion: 1;
  authority: PhysicalStructureLedgerAuthority;
  target: PhysicalStructureLedgerSeal;
  index: PhysicalStructureIndex;
}

interface PhysicalStructureLedgerProjectionFold {
  status: 'open' | 'discarded' | 'finished';
  authority: PhysicalStructureLedgerAuthority;
  target: PhysicalStructureLedgerSeal;
  state: SimulationState;
  grid: VoxelWorld;
  elapsedMonths: number;
  voxelRevision: number;
  voxelContentHash: string;
  physical: PhysicalStructureFold;
  finishedResult?: PhysicalStructureLedgerProjectionResult;
}

const STATE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const verifiedFolds = new WeakSet<PhysicalStructureLedgerProjectionFold>();
const verifiedProjectionSourceSeals = new WeakMap<
  PhysicalStructureLedgerProjectionResult,
  Readonly<PhysicalStructureLedgerSourceSeal>
>();
// Preserve the public shell-assertion identity contract without retaining the
// state: WeakMap keys and WeakSet members are both non-owning. Successor
// provenance deliberately does not consult this registry after bootstrap.
const verifiedProjectionStateIdentities = new WeakMap<
  SimulationState,
  WeakSet<PhysicalStructureLedgerProjectionResult>
>();

function voxelContentHash(grid: VoxelWorld): string {
  const header = JSON.stringify({
    version: grid.version,
    width: grid.width,
    depth: grid.depth,
    levels: grid.levels,
    generator: grid.generator,
    palette: grid.palette,
  });
  return createHash('sha256')
    .update('eland-physical-voxel-grid-v1\0', 'utf8')
    .update(header, 'utf8')
    .update(Buffer.from(grid.voxels.buffer, grid.voxels.byteOffset, grid.voxels.byteLength))
    .digest('hex');
}

function assertCanonicalVoxelGrid(value: unknown, label: string): asserts value is VoxelWorld {
  if (!value
    || typeof value !== 'object'
    || (value as VoxelWorld).version !== 2
    || (value as VoxelWorld).width !== WORLD_WIDTH
    || (value as VoxelWorld).depth !== WORLD_DEPTH
    || (value as VoxelWorld).levels !== WORLD_LEVELS
    || !((value as VoxelWorld).voxels instanceof Uint16Array)
    || (value as VoxelWorld).voxels.length !== WORLD_WIDTH * WORLD_DEPTH * WORLD_LEVELS) {
    throw new Error(`${label} 不是 canonical world dimensions/voxel grid`);
  }
}

interface ExactPhysicalShellSeal {
  elapsedMonths: number;
  eventCount: number;
  /** Absent for schema-3 compatibility shells written before historyCursor. */
  tailEventId?: string | null;
  voxelContentHash: string;
}

function readExactSchema3ShellValue(
  readChunk: (hash: string) => RunStateChunk,
  fields: readonly RunStateShellFieldReference[],
  fieldName: string,
  label: string,
): unknown {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field || field.kind !== 'value') {
    throw new Error(`${label} 缺少 value 字段 ${fieldName}`);
  }
  const input = readChunk(field.hash);
  if (!input || input.hash !== field.hash) {
    throw new Error(`${label} ${fieldName} 返回的数据块不属于 exact root 引用`);
  }
  const chunk = snapshotRunStateChunk(input);
  const data = verifiedRunStateChunkData(
    chunk,
    RUN_STATE_SHELL_PART_CODEC,
    `${label} ${fieldName}`,
  );
  try {
    return deserialize(brotliDecompressSync(data));
  } catch (error) {
    throw new Error(`${label} ${fieldName} 无法解码`, { cause: error });
  }
}

/**
 * Read only the three bounded scalar/grid values needed to bind a physical
 * projection to an exact schema-3 shell. Schema 2 remains on its legacy full-
 * decode compatibility boundary and returns no additional seal.
 */
function exactPhysicalShellSealFromRoot(
  root: RunStateRootMetadata,
  readChunk: (hash: string) => RunStateChunk,
  label: string,
): ExactPhysicalShellSeal | null {
  if (root.schemaVersion !== 3) return null;
  const manifestInput = readChunk(root.shellHash);
  if (!manifestInput || manifestInput.hash !== root.shellHash) {
    throw new Error(`${label} shell manifest 不属于 exact root 引用`);
  }
  const manifest = parseRunStateShellManifest(snapshotRunStateChunk(manifestInput));
  const clock = readExactSchema3ShellValue(readChunk, manifest.fields, 'clock', label);
  const grid = readExactSchema3ShellValue(readChunk, manifest.worldFields, 'grid', label);
  const cursorField = manifest.worldFields.find((field) => field.name === 'historyCursor');
  const cursor = cursorField === undefined
    ? undefined
    : readExactSchema3ShellValue(
      readChunk,
      manifest.worldFields,
      'historyCursor',
      label,
    );
  if (!clock
    || typeof clock !== 'object'
    || !Number.isSafeInteger((clock as { elapsedMonths?: unknown }).elapsedMonths)
    || Number((clock as { elapsedMonths?: unknown }).elapsedMonths) < 0) {
    throw new Error(`${label} clock.elapsedMonths 无效`);
  }
  assertCanonicalVoxelGrid(grid, `${label} grid`);
  const historyCursor = cursor as {
    version?: unknown;
    eventCount?: unknown;
    tailEventId?: unknown;
  } | null | undefined;
  if (historyCursor !== undefined
    && (!historyCursor
      || typeof historyCursor !== 'object'
      || historyCursor.version !== 1
      || !Number.isSafeInteger(historyCursor.eventCount)
      || Number(historyCursor.eventCount) !== root.eventCount
      || (root.eventCount === 0
        ? historyCursor.tailEventId !== null
        : typeof historyCursor.tailEventId !== 'string' || historyCursor.tailEventId.length === 0))) {
    throw new Error(`${label} historyCursor 与 exact root 不一致`);
  }
  return {
    elapsedMonths: Number((clock as { elapsedMonths: number }).elapsedMonths),
    eventCount: root.eventCount,
    ...(historyCursor === undefined
      ? {}
      : { tailEventId: historyCursor.tailEventId as string | null }),
    voxelContentHash: voxelContentHash(grid),
  };
}

function assertExactPhysicalShellSealMatchesState(
  exact: ExactPhysicalShellSeal | null,
  state: SimulationState,
  label: string,
): void {
  if (!exact) return;
  const stateTarget = shellSeal(state);
  assertCanonicalVoxelGrid(state.world.grid, `${label} state grid`);
  if (exact.elapsedMonths !== state.clock.elapsedMonths
    || exact.eventCount !== stateTarget.eventCount
    || (exact.tailEventId !== undefined && exact.tailEventId !== stateTarget.tailEventId)
    || exact.voxelContentHash !== voxelContentHash(state.world.grid)) {
    throw new Error(`${label} state/history/grid 与 exact root shell 不一致`);
  }
}

function shellSeal(state: SimulationState): PhysicalStructureLedgerSeal {
  const cursor = state.world.historyCursor;
  if (!cursor
    || cursor.version !== 1
    || !Number.isSafeInteger(cursor.eventCount)
    || cursor.eventCount < 0
    || !Number.isSafeInteger(cursor.hotStartIndex)
    || cursor.hotStartIndex < 0
    || cursor.hotStartIndex > cursor.eventCount
    || cursor.eventCount - cursor.hotStartIndex !== state.world.past.length
    || (cursor.eventCount === 0
      ? cursor.tailEventId !== null
      : typeof cursor.tailEventId !== 'string' || cursor.tailEventId.length === 0)
    || (state.world.past.length > 0 && state.world.past.at(-1)?.id !== cursor.tailEventId)) {
    throw new Error('physical ledger projection shell 的绝对 history cursor 无效');
  }
  return { eventCount: cursor.eventCount, tailEventId: cursor.tailEventId };
}

function discard(fold: PhysicalStructureLedgerProjectionFold): void {
  fold.status = 'discarded';
  fold.physical.recordsByPositionAndMaterial.clear();
  delete fold.finishedResult;
}

function beginPhysicalStructureLedgerProjection(
  state: SimulationState,
  authority: PhysicalStructureLedgerAuthority,
  previous?: PhysicalStructureIndex,
): PhysicalStructureLedgerProjectionFold {
  if (!STATE_HASH_PATTERN.test(authority.stateHash)) {
    throw new Error('physical ledger projection 权威 stateHash 无效');
  }
  assertCanonicalVoxelGrid(state.world.grid, 'physical ledger projection');
  const grid = state.world.grid;
  return {
    status: 'open',
    authority: { stateHash: authority.stateHash },
    target: shellSeal(state),
    state,
    grid,
    elapsedMonths: state.clock.elapsedMonths,
    voxelRevision: voxelWorldRevision(grid),
    voxelContentHash: voxelContentHash(grid),
    physical: beginPhysicalStructureFold(grid, previous),
  };
}

function foldPhysicalStructureLedgerSegment(
  fold: PhysicalStructureLedgerProjectionFold,
  events: readonly WorldEvent[],
  startAbsoluteIndex: number,
): PhysicalStructureLedgerProjectionFold {
  if (fold.status !== 'open') throw new Error(`physical ledger projection 已${fold.status === 'finished' ? '完成' : '作废'}`);
  try {
    foldPhysicalStructureEvents(fold.physical, events, startAbsoluteIndex);
    return fold;
  } catch (error) {
    discard(fold);
    throw error;
  }
}

/**
 * Commit only after the outer verified-ledger stream has resolved. Until this
 * call, all decoded segment effects remain isolated in the staged fold.
 */
function frozenPhysicalIndex(index: PhysicalStructureIndex): PhysicalStructureIndex {
  const constructionRecords = index.constructionRecords?.map((record) => Object.freeze({ ...record }));
  if (constructionRecords) Object.freeze(constructionRecords);
  const structures = index.structures.map((structure) => Object.freeze({
    ...structure,
    occupiedCells: Object.freeze([...structure.occupiedCells]),
    interiorCells: Object.freeze([...structure.interiorCells]),
    interiorPositions: Object.freeze(structure.interiorPositions.map((position) => Object.freeze({ ...position }))),
    materialIds: Object.freeze([...structure.materialIds]),
    sourceEventIds: Object.freeze([...structure.sourceEventIds]),
  }));
  Object.freeze(structures);
  return Object.freeze({
    ...index,
    ...(constructionRecords ? { constructionRecords } : {}),
    structures,
  }) as unknown as PhysicalStructureIndex;
}

function exactEnumerableValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null
    || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => exactEnumerableValueEquals(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && exactEnumerableValueEquals(leftRecord[key], rightRecord[key]));
}

function verifiedProjectionSourceSeal(
  projection: PhysicalStructureLedgerProjectionResult,
): Readonly<PhysicalStructureLedgerSourceSeal> {
  const seal = verifiedProjectionSourceSeals.get(projection);
  if (!seal) {
    throw new Error('physical ledger projection 未经本模块验证，canonical sidecar 不能充当 provenance');
  }
  if (projection.schemaVersion !== 1
    || projection.authority.stateHash !== seal.stateHash
    || projection.target.eventCount !== seal.eventCount
    || projection.target.tailEventId !== seal.tailEventId
    || projection.index.projectionVersion !== 2
    || projection.index.appliedHistoryEventCount !== seal.eventCount
    || projection.index.appliedTailEventId !== seal.tailEventId
    || projection.index.calculatedAtMonth !== seal.elapsedMonths
    || projection.index.voxelRevision !== seal.voxelRevision) {
    throw new Error('physical ledger projection 与私有 source seal 不一致');
  }
  return seal;
}

/**
 * Return the scalar-only provenance retained for a verified projection. This
 * is an inspection/cache seam, not a minting seam: decoded or cloned
 * projections have no private entry and fail closed.
 */
export function physicalStructureLedgerProjectionSourceSeal(
  projection: PhysicalStructureLedgerProjectionResult,
): Readonly<PhysicalStructureLedgerSourceSeal> {
  return verifiedProjectionSourceSeal(projection);
}

function finishPhysicalStructureLedgerProjection(
  fold: PhysicalStructureLedgerProjectionFold,
  expectedShellIndex?: PhysicalStructureIndex,
): PhysicalStructureLedgerProjectionResult {
  if (fold.status === 'discarded') throw new Error('physical ledger projection 已作废');
  if (fold.finishedResult) return fold.finishedResult;
  if (!verifiedFolds.has(fold)) {
    throw new Error('physical ledger projection 尚未通过权威 run root 的完整流式校验');
  }
  try {
    const currentTarget = shellSeal(fold.state);
    if (currentTarget.eventCount !== fold.target.eventCount
      || currentTarget.tailEventId !== fold.target.tailEventId) {
      throw new Error('physical ledger projection shell 在折叠期间发生变化');
    }
    if (fold.state.world.grid !== fold.grid
      || fold.state.clock.elapsedMonths !== fold.elapsedMonths
      || voxelWorldRevision(fold.state.world.grid) !== fold.voxelRevision
      || voxelContentHash(fold.state.world.grid) !== fold.voxelContentHash) {
      throw new Error('physical ledger projection 的体素 shell 在折叠期间发生变化');
    }
    const index = finishPhysicalStructureFold(fold.state, fold.physical);
    if (expectedShellIndex !== undefined
      && (fold.state.world.physicalStructureIndex !== expectedShellIndex
        || !exactEnumerableValueEquals(index, expectedShellIndex))) {
      throw new Error('physical ledger successor 与 next state 的 physicalStructureIndex 不一致');
    }
    const result: PhysicalStructureLedgerProjectionResult = Object.freeze({
      schemaVersion: 1,
      authority: Object.freeze({ ...fold.authority }),
      target: Object.freeze({ ...fold.target }),
      index: frozenPhysicalIndex(index),
    });
    fold.status = 'finished';
    fold.finishedResult = result;
    verifiedProjectionSourceSeals.set(result, Object.freeze({
      schemaVersion: 1,
      stateHash: fold.authority.stateHash,
      eventCount: fold.target.eventCount,
      tailEventId: fold.target.tailEventId,
      elapsedMonths: fold.elapsedMonths,
      voxelRevision: fold.voxelRevision,
      voxelContentHash: fold.voxelContentHash,
    }));
    let stateProjections = verifiedProjectionStateIdentities.get(fold.state);
    if (!stateProjections) {
      stateProjections = new WeakSet<PhysicalStructureLedgerProjectionResult>();
      verifiedProjectionStateIdentities.set(fold.state, stateProjections);
    }
    stateProjections.add(result);
    return result;
  } catch (error) {
    discard(fold);
    throw error;
  }
}

function assertStablePhysicalRoot(
  rootChunk: RunStateChunk,
  label: string,
) {
  const root = parseRunStateRoot(rootChunk);
  if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error(`${label} 只接受稳定尾校验的 schema 2/3 run root`);
  }
  return root;
}

/**
 * Closed authority boundary: parse the exact root chunk, stream and verify its
 * complete ledger, and only then make the staged physical fold finishable.
 */
async function projectPhysicalStructuresFromVerifiedRunRoot(
  state: SimulationState,
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
): Promise<PhysicalStructureLedgerProjectionResult> {
  const root = assertStablePhysicalRoot(rootChunk, 'physical ledger projection');
  assertExactPhysicalShellSealMatchesState(
    exactPhysicalShellSealFromRoot(root, readChunk, 'physical ledger projection exact root'),
    state,
    'physical ledger projection',
  );
  const fold = beginPhysicalStructureLedgerProjection(state, { stateHash: rootChunk.hash });
  if (fold.target.eventCount !== root.eventCount) {
    discard(fold);
    throw new Error('physical ledger projection shell 与 run root 事件总数不一致');
  }
  try {
    const verifiedCursor = await streamVerifiedRunHistorySegments(
      root,
      readChunk,
      (events, position) => {
        foldPhysicalStructureLedgerSegment(fold, events, position.startEventIndex);
      },
    );
    if (verifiedCursor.eventCount !== fold.target.eventCount) {
      throw new Error('physical ledger projection 已验证 cursor 与 shell 不一致');
    }
    verifiedFolds.add(fold);
    return finishPhysicalStructureLedgerProjection(fold);
  } catch (error) {
    if (fold.status !== 'discarded') discard(fold);
    throw error;
  }
}

/**
 * Re-establish the private continuation brand after a process restart. Store
 * selection is proven by the strict sidecar decoder; physical/history parity
 * is independently proven by one complete exact-root stream. The decoded
 * object itself is never branded or returned as continuation authority.
 *
 * This full scan is a bootstrap-only boundary. Once returned, the new module-
 * branded projection can advance through successor folds without rescanning
 * its historical prefix.
 */
export async function bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
  decodedSidecar: Readonly<PhysicalStructureLedgerProjectionResult>,
  previousState: SimulationState,
  previousRootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
): Promise<PhysicalStructureLedgerProjectionResult> {
  assertDecodedPhysicalStructureLedgerSidecar(decodedSidecar);
  const previousRootChunk = snapshotRunStateChunk(previousRootChunkInput);
  const previousRoot = assertStablePhysicalRoot(
    previousRootChunk,
    'physical ledger bootstrap source',
  );
  const stateTarget = shellSeal(previousState);
  if (decodedSidecar.authority.stateHash !== previousRootChunk.hash
    || decodedSidecar.target.eventCount !== previousRoot.eventCount
    || decodedSidecar.target.eventCount !== stateTarget.eventCount
    || decodedSidecar.target.tailEventId !== stateTarget.tailEventId) {
    throw new Error('physical ledger bootstrap sidecar/state 与 exact previous root boundary 不一致');
  }
  const verified = await projectPhysicalStructuresFromVerifiedRunRoot(
    previousState,
    previousRootChunk,
    readChunk,
  );
  if (!exactEnumerableValueEquals(decodedSidecar, verified)) {
    throw new Error('physical ledger bootstrap strict-decoded sidecar 与 exact-root 全量投影不一致');
  }
  // `verified` is a fresh result already registered with a scalar-only source
  // seal; never let the decoded sidecar object inherit that private brand.
  return verified;
}

/**
 * Advance a module-verified physical authority across one exact schema-2/3
 * history successor. A decoded/canonical sidecar is intentionally insufficient:
 * `previous` must retain the private identity issued by this module after a
 * physical/history join, not store selection: the owning store must still pass
 * `nextState` and `nextRootChunkInput` from the same private staging/CAS scope.
 */
export async function projectPhysicalStructureLedgerFromVerifiedSuccessor(
  previous: PhysicalStructureLedgerProjectionResult,
  previousRootChunkInput: RunStateChunk,
  nextState: SimulationState,
  nextRootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
): Promise<PhysicalStructureLedgerProjectionResult> {
  const previousSeal = verifiedProjectionSourceSeal(previous);
  const previousRootChunk = snapshotRunStateChunk(previousRootChunkInput);
  const nextRootChunk = snapshotRunStateChunk(nextRootChunkInput);
  const previousRoot = assertStablePhysicalRoot(previousRootChunk, 'physical ledger successor source');
  const nextRoot = assertStablePhysicalRoot(nextRootChunk, 'physical ledger successor target');
  // The sealed SHA-256 root already commits the previous shell/grid. Avoid
  // reopening that grid every month; only the unbranded next state needs the
  // narrow exact-shell comparison below.
  if (previousRootChunk.hash !== previousSeal.stateHash) {
    throw new Error('physical ledger projection 不属于当前权威 state root');
  }
  if (previousRoot.eventCount !== previousSeal.eventCount) {
    throw new Error('physical ledger successor source projection 与 previous root 事件边界不一致');
  }
  const nextTarget = shellSeal(nextState);
  if (nextRoot.eventCount !== nextTarget.eventCount) {
    throw new Error('physical ledger successor next state 与 next root 事件总数不一致');
  }
  const expectedShellIndex = nextState.world.physicalStructureIndex;
  if (!expectedShellIndex) {
    throw new Error('physical ledger successor next state 缺少权威 physicalStructureIndex');
  }
  const fold = beginPhysicalStructureLedgerProjection(
    nextState,
    { stateHash: nextRootChunk.hash },
    previous.index,
  );
  if (fold.physical.appliedHistoryEventCount !== previous.target.eventCount
    || fold.physical.appliedTailEventId !== previous.target.tailEventId) {
    discard(fold);
    throw new Error('physical ledger successor source construction records 与 source seal 不一致');
  }
  try {
    const successor = nextTarget.eventCount === previous.target.eventCount
      ? verifyRunStateSameHistoryShellSuccessor(previousRootChunk, nextRootChunk)
      : await streamVerifiedRunHistorySuccessorSegments(
        previousRootChunk,
        nextRootChunk,
        readChunk,
        (events, position) => {
          foldPhysicalStructureLedgerSegment(fold, events, position.startEventIndex);
        },
      );
    if (successor.previousRootHash !== previous.authority.stateHash
      || successor.nextRootHash !== nextRootChunk.hash
      || successor.previous.lineageId !== previousRoot.lineageId
      || successor.previous.historyHeadHash !== previousRoot.historyHeadHash
      || successor.previous.eventCount !== previous.target.eventCount
      || successor.previous.tailEventContentHash !== previousRoot.tailEventContentHash
      || successor.next.lineageId !== nextRoot.lineageId
      || successor.next.historyHeadHash !== nextRoot.historyHeadHash
      || successor.next.eventCount !== nextTarget.eventCount
      || successor.next.tailEventContentHash !== nextRoot.tailEventContentHash
      || successor.suffixEventCount !== nextTarget.eventCount - previous.target.eventCount) {
      throw new Error('physical ledger successor receipt 与 exact roots/shell 不一致');
    }
    // Preserve history/lineage failure ordering, then bind the caller-owned
    // next grid and clock to the already verified exact schema-3 target shell.
    assertExactPhysicalShellSealMatchesState(
      exactPhysicalShellSealFromRoot(
        nextRoot,
        readChunk,
        'physical ledger successor target exact root',
      ),
      nextState,
      'physical ledger successor target',
    );
    verifiedFolds.add(fold);
    return finishPhysicalStructureLedgerProjection(fold, expectedShellIndex);
  } catch (error) {
    if (fold.status !== 'discarded') discard(fold);
    throw error;
  }
}

export interface DecodedBoundedRunStateWithPhysicalProjection extends DecodedBoundedRunState {
  physicalProjection: PhysicalStructureLedgerProjectionResult;
}

export interface DecodedBoundedGameplayRunStateWithPhysicalProjection
  extends DecodedBoundedGameplayRunState {
  physicalProjection: PhysicalStructureLedgerProjectionResult;
}

/**
 * Decode the shell and physical projection inside one exact-root boundary, so
 * callers cannot pair a verified ledger with a shell from another root.
 */
export async function decodeBoundedRunStateWithPhysicalProjection(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  options: RunStateBoundedDecodeOptions,
): Promise<DecodedBoundedRunStateWithPhysicalProjection> {
  const rootSnapshot = snapshotRunStateChunk(rootChunk);
  const decoded = await decodeSegmentedRunStateBounded(rootSnapshot, readChunk, options);
  const physicalProjection = await projectPhysicalStructuresFromVerifiedRunRoot(
    decoded.state,
    rootSnapshot,
    readChunk,
  );
  return { ...decoded, physicalProjection };
}

/** Closed gameplay-shell counterpart used by continuation bootstrap/open. */
export async function decodeBoundedGameplayRunStateWithPhysicalProjection(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  options: RunStateGameplayBoundedDecodeOptions,
): Promise<DecodedBoundedGameplayRunStateWithPhysicalProjection> {
  const rootSnapshot = snapshotRunStateChunk(rootChunk);
  const decoded = await decodeSegmentedRunStateGameplayBounded(
    rootSnapshot,
    readChunk,
    options,
  );
  const physicalProjection = await projectPhysicalStructuresFromVerifiedRunRoot(
    decoded.state,
    rootSnapshot,
    readChunk,
  );
  return { ...decoded, physicalProjection };
}

export function assertPhysicalStructureLedgerProjectionMatchesShell(
  state: SimulationState,
  expectedStateHash: string,
  projection: PhysicalStructureLedgerProjectionResult,
): void {
  if (!verifiedProjectionStateIdentities.get(state)?.has(projection)
    || projection.schemaVersion !== 1
    || !STATE_HASH_PATTERN.test(expectedStateHash)
    || projection.authority.stateHash !== expectedStateHash) {
    throw new Error('physical ledger projection 不属于当前权威 state root');
  }
  const seal = verifiedProjectionSourceSeal(projection);
  const current = shellSeal(state);
  if (seal.eventCount !== current.eventCount
    || seal.tailEventId !== current.tailEventId
    || seal.elapsedMonths !== state.clock.elapsedMonths
    || seal.voxelRevision !== voxelWorldRevision(state.world.grid)
    || seal.voxelContentHash !== voxelContentHash(state.world.grid)) {
    throw new Error('physical ledger projection 与当前 shell 封印不一致');
  }
}
