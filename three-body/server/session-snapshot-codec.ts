import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { WorldEvent } from '../src/game/eland/simulation';
import { internEventHistoryAuditStrings } from './event-history-memory';

export const SESSION_TIMELINE_CHUNK_REFERENCE_KEY = '__elandSessionChunkV2' as const;
const SHA256_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const BROTLI_OPTIONS = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 3 },
} as const;

interface ShellChunkIndexReference {
  [SESSION_TIMELINE_CHUNK_REFERENCE_KEY]: number;
}

/** Lightweight in-memory handle for a compressed timeline BLOB in SQLite. */
export interface SessionTimelineChunkReference {
  readonly [SESSION_TIMELINE_CHUNK_REFERENCE_KEY]: string;
}

export type SessionTimelineChunkData = Buffer | SessionTimelineChunkReference;
export type SessionTimelineChunkResolver = (reference: SessionTimelineChunkReference) => Buffer;

type UnknownRecord = Record<string, unknown>;

export interface SessionSnapshotParts {
  compressedShell: Buffer;
  chunks: SessionTimelineChunkData[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

function shellChunkIndexReference(index: number): ShellChunkIndexReference {
  return { [SESSION_TIMELINE_CHUNK_REFERENCE_KEY]: index };
}

function readShellChunkIndexReference(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const index = value[SESSION_TIMELINE_CHUNK_REFERENCE_KEY];
  return Number.isInteger(index) && Number(index) >= 0 ? index as number : undefined;
}

export function createSessionTimelineChunkReference(hash: string): SessionTimelineChunkReference {
  if (!SHA256_HASH_PATTERN.test(hash)) throw new Error(`会话时间线数据块 hash 无效：${hash}`);
  return { [SESSION_TIMELINE_CHUNK_REFERENCE_KEY]: hash };
}

export function isSessionTimelineChunkReference(
  value: unknown,
): value is SessionTimelineChunkReference {
  if (!isRecord(value)) return false;
  const hash = value[SESSION_TIMELINE_CHUNK_REFERENCE_KEY];
  return typeof hash === 'string' && SHA256_HASH_PATTERN.test(hash);
}

export function resolveSessionTimelineChunk(
  data: SessionTimelineChunkData,
  resolver: SessionTimelineChunkResolver,
): Buffer {
  return Buffer.isBuffer(data) ? data : resolver(data);
}

/**
 * Pull compressed monthly checkpoint/delta payloads out of a recovery shell.
 * Existing SQLite references remain references, so re-saving a restored
 * session does not read or hash its history again.
 */
function detachTimelineChunks(value: unknown, chunks: SessionTimelineChunkData[]): unknown {
  if (!isRecord(value)) return value;

  const branches = value.branches;
  if (branches instanceof Map) {
    const detachedBranches = new Map<unknown, unknown>();
    for (const [branchId, timelineValue] of branches.entries()) {
      if (!isRecord(timelineValue) || !(timelineValue.snapshots instanceof Map)) {
        detachedBranches.set(branchId, timelineValue);
        continue;
      }
      const detachedSnapshots = new Map<unknown, unknown>();
      for (const [month, storedValue] of timelineValue.snapshots.entries()) {
        if (isRecord(storedValue)
          && (storedValue.kind === 'checkpoint' || storedValue.kind === 'delta')
          && (Buffer.isBuffer(storedValue.data)
            || isSessionTimelineChunkReference(storedValue.data))) {
          const index = chunks.length;
          chunks.push(storedValue.data);
          detachedSnapshots.set(month, {
            ...storedValue,
            data: shellChunkIndexReference(index),
          });
        } else {
          detachedSnapshots.set(month, storedValue);
        }
      }
      detachedBranches.set(branchId, { ...timelineValue, snapshots: detachedSnapshots });
    }
    return { ...value, branches: detachedBranches };
  }

  // Managed live snapshots and manual saves both wrap recovery state in session.
  if ('session' in value) return { ...value, session: detachTimelineChunks(value.session, chunks) };
  return value;
}

function attachTimelineChunks(value: unknown, chunks: SessionTimelineChunkData[]): unknown {
  if (!isRecord(value)) return value;

  const branches = value.branches;
  if (branches instanceof Map) {
    const attachedBranches = new Map<unknown, unknown>();
    for (const [branchId, timelineValue] of branches.entries()) {
      if (!isRecord(timelineValue) || !(timelineValue.snapshots instanceof Map)) {
        attachedBranches.set(branchId, timelineValue);
        continue;
      }
      const attachedSnapshots = new Map<unknown, unknown>();
      for (const [month, storedValue] of timelineValue.snapshots.entries()) {
        if (isRecord(storedValue)) {
          const index = readShellChunkIndexReference(storedValue.data);
          if (index !== undefined) {
            const chunk = chunks[index];
            if (!chunk) throw new Error(`会话快照引用了不存在的数据块 ${index}`);
            attachedSnapshots.set(month, { ...storedValue, data: chunk });
            continue;
          }
        }
        attachedSnapshots.set(month, storedValue);
      }
      attachedBranches.set(branchId, { ...timelineValue, snapshots: attachedSnapshots });
    }
    return { ...value, branches: attachedBranches };
  }

  if ('session' in value) return { ...value, session: attachTimelineChunks(value.session, chunks) };
  return value;
}

interface TimelineChunkLocation {
  snapshots: Map<unknown, unknown>;
  month: unknown;
  storedValue: UnknownRecord;
  data: SessionTimelineChunkData;
}

function timelineChunkLocations(value: unknown): TimelineChunkLocation[] {
  if (!isRecord(value)) return [];
  if ('session' in value) return timelineChunkLocations(value.session);
  if (!(value.branches instanceof Map)) return [];

  const locations: TimelineChunkLocation[] = [];
  for (const timelineValue of value.branches.values()) {
    if (!isRecord(timelineValue) || !(timelineValue.snapshots instanceof Map)) continue;
    for (const [month, storedValue] of timelineValue.snapshots.entries()) {
      if (!isRecord(storedValue)
        || (storedValue.kind !== 'checkpoint' && storedValue.kind !== 'delta')
        || (!Buffer.isBuffer(storedValue.data)
          && !isSessionTimelineChunkReference(storedValue.data))) continue;
      locations.push({
        snapshots: timelineValue.snapshots,
        month,
        storedValue,
        data: storedValue.data,
      });
    }
  }
  return locations;
}

/**
 * After a successful SQLite transaction, release persisted timeline Buffers
 * from the live branch maps without changing their ordering or semantics.
 */
export function replaceSessionTimelineChunksWithReferences(
  value: unknown,
  hashes: readonly string[],
): void {
  const locations = timelineChunkLocations(value);
  if (locations.length !== hashes.length) {
    throw new Error(`会话时间线数据块数量不一致：${locations.length} != ${hashes.length}`);
  }
  const references = hashes.map(createSessionTimelineChunkReference);
  locations.forEach((location, index) => {
    if (isSessionTimelineChunkReference(location.data)) {
      if (location.data[SESSION_TIMELINE_CHUNK_REFERENCE_KEY]
        !== references[index][SESSION_TIMELINE_CHUNK_REFERENCE_KEY]) {
        throw new Error(`会话时间线引用顺序不一致：${index}`);
      }
    }
  });
  locations.forEach((location, index) => {
    if (isSessionTimelineChunkReference(location.data)) return;
    const reference = references[index];
    location.snapshots.set(location.month, { ...location.storedValue, data: reference });
  });
}

/** Encode the independently persistable SQLite shell and timeline chunks. */
export function encodeSessionSnapshotParts<T>(value: T): SessionSnapshotParts {
  const chunks: SessionTimelineChunkData[] = [];
  const shell = detachTimelineChunks(value, chunks);
  return {
    compressedShell: brotliCompressSync(serialize(shell), BROTLI_OPTIONS),
    chunks,
  };
}

/** Hydrate a shell with either eager Buffers (legacy/tests) or lazy hash references. */
export function decodeSessionSnapshotParts<T>(parts: SessionSnapshotParts): T {
  const shell = deserialize(brotliDecompressSync(parts.compressedShell)) as unknown;
  const hydrated = attachTimelineChunks(shell, parts.chunks);
  if (isRecord(hydrated)) {
    const session = isRecord(hydrated.session) ? hydrated.session : hydrated;
    const latestState = isRecord(session.latestState) ? session.latestState : undefined;
    const world = latestState && isRecord(latestState.world) ? latestState.world : undefined;
    if (world && Array.isArray(world.past)) {
      internEventHistoryAuditStrings(world.past as WorldEvent[]);
    }
  }
  return hydrated as T;
}
