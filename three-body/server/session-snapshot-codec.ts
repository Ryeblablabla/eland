import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

const CHUNK_REFERENCE_KEY = '__elandSessionChunkV2';
const BROTLI_OPTIONS = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 3 },
} as const;

interface ChunkReference {
  [CHUNK_REFERENCE_KEY]: number;
}

type UnknownRecord = Record<string, unknown>;

export interface SessionSnapshotParts {
  compressedShell: Buffer;
  chunks: Buffer[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

function chunkReference(index: number): ChunkReference {
  return { [CHUNK_REFERENCE_KEY]: index };
}

function readChunkReference(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const index = value[CHUNK_REFERENCE_KEY];
  return Number.isInteger(index) && Number(index) >= 0 ? index as number : undefined;
}

/**
 * Pull already-compressed monthly checkpoint/delta payloads out of a recovery
 * snapshot. SQLite stores those payloads as independent content-addressed
 * chunks while the surrounding V8 shell keeps Maps, typed arrays and Buffers.
 */
function detachTimelineChunks(value: unknown, chunks: Buffer[]): unknown {
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
          && Buffer.isBuffer(storedValue.data)) {
          const index = chunks.length;
          chunks.push(storedValue.data);
          detachedSnapshots.set(month, { ...storedValue, data: chunkReference(index) });
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

function attachTimelineChunks(value: unknown, chunks: Buffer[]): unknown {
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
          const index = readChunkReference(storedValue.data);
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

/** Encode the independently persistable SQLite shell and timeline chunks. */
export function encodeSessionSnapshotParts<T>(value: T): SessionSnapshotParts {
  const chunks: Buffer[] = [];
  const shell = detachTimelineChunks(value, chunks);
  return {
    compressedShell: brotliCompressSync(serialize(shell), BROTLI_OPTIONS),
    chunks,
  };
}

/** Hydrate a session from its SQLite shell and timeline chunks. */
export function decodeSessionSnapshotParts<T>(parts: SessionSnapshotParts): T {
  const shell = deserialize(brotliDecompressSync(parts.compressedShell)) as unknown;
  return attachTimelineChunks(shell, parts.chunks) as T;
}
