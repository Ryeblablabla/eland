import { createHash } from 'node:crypto';

import {
  MATERIAL_PALETTE,
  materialDefinition,
  materialHas,
  type MaterialId,
} from '../src/game/eland/domain/material';
import type {
  PhysicalConstructionRecord,
  PhysicalStructure,
  PhysicalStructureIndex,
} from '../src/game/eland/domain/model';
import {
  WORLD_CELL_COUNT,
  WORLD_DEPTH,
  WORLD_LEVELS,
  WORLD_VOXEL_COUNT,
  WORLD_WIDTH,
} from '../src/game/eland/world/grid';
import type {
  PhysicalStructureLedgerAuthority,
  PhysicalStructureLedgerProjectionResult,
  PhysicalStructureLedgerSeal,
} from './physical-structure-ledger-projection';

/**
 * Canonical persistence codec for the exact result produced by the verified
 * physical-structure ledger projection. This module does not publish a
 * continuation or turn a digest into store authority.
 */
export const PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC =
  'eland-physical-structure-ledger-projection-json-v1';
export const PHYSICAL_STRUCTURE_LEDGER_SIDECAR_SCHEMA_VERSION = 1 as const;

/** Decoding may temporarily hold bytes, parsed JSON, and a normalized copy. */
export const MAX_PHYSICAL_STRUCTURE_LEDGER_SIDECAR_STORED_BYTES = 16 * 1_024 * 1_024;
export const MAX_PHYSICAL_STRUCTURE_LEDGER_IDENTIFIER_BYTES = 4_096;
export const MAX_PHYSICAL_STRUCTURE_LEDGER_NAME_BYTES = 16 * 1_024;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const STRUCTURE_ID_PATTERN = /^structure-(\d+):(\d+):(\d+)$/u;
const MATERIAL_IDS = new Set(MATERIAL_PALETTE.map((material) => material.id));
const BUILDING_MATERIAL_COUNT = MATERIAL_PALETTE.filter((material) =>
  material.tags.includes('solid') && material.tags.includes('building')).length;
const MAX_CONSTRUCTION_RECORDS = WORLD_VOXEL_COUNT * BUILDING_MATERIAL_COUNT;

type UnknownRecord = Record<string, unknown>;

export interface PhysicalStructureLedgerSidecarChunk {
  hash: string;
  codec: string;
  /** Stored-byte length. V1 stores canonical UTF-8 JSON directly. */
  rawSize: number;
  data: Buffer | Uint8Array;
}

export interface PhysicalStructureLedgerSidecarContentReferenceV1 {
  kind: 'content-hash';
  codec: typeof PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC;
  hash: string;
}

export interface PhysicalStructureLedgerSidecarBoundaryV1 {
  authority: Readonly<PhysicalStructureLedgerAuthority>;
  target: Readonly<PhysicalStructureLedgerSeal>;
}

export interface PhysicalStructureLedgerSidecarDecodeExpectationV1 {
  /** Must be selected by the owning store, never reconstructed from caller bytes. */
  reference: Readonly<PhysicalStructureLedgerSidecarContentReferenceV1>;
  /** Must come from the same exact root selection as `reference`. */
  boundary: Readonly<PhysicalStructureLedgerSidecarBoundaryV1>;
}

export interface EncodedPhysicalStructureLedgerSidecar {
  chunk: Readonly<PhysicalStructureLedgerSidecarChunk>;
  reference: Readonly<PhysicalStructureLedgerSidecarContentReferenceV1>;
  projection: Readonly<PhysicalStructureLedgerProjectionResult>;
}

const decodedPhysicalStructureLedgerSidecars = new WeakSet<object>();

/** Runtime provenance seam: only the strict store-selected decoder mints it. */
export function assertDecodedPhysicalStructureLedgerSidecar(
  value: unknown,
): asserts value is Readonly<PhysicalStructureLedgerProjectionResult> {
  if (!value || typeof value !== 'object'
    || !decodedPhysicalStructureLedgerSidecars.has(value)) {
    throw new Error('physical ledger sidecar 未经过 strict store-selected decoder');
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
}

function assertExactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length
    || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new Error(`${label} 字段集合无效`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 64 位小写十六进制 SHA-256`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
}

function assertSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 的安全整数`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumBytes = MAX_PHYSICAL_STRUCTURE_LEDGER_IDENTIFIER_BYTES,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(`${label} 超过 ${maximumBytes} 字节上限`);
  }
}

function assertArray(value: unknown, maximumLength: number, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  if (value.length > maximumLength) {
    throw new Error(`${label} 超过 ${maximumLength} 项上限`);
  }
}

function assertMaterialId(value: unknown, label: string): asserts value is MaterialId {
  if (!Number.isInteger(value) || !MATERIAL_IDS.has(Number(value))) {
    throw new Error(`${label} 不是当前 material palette 中的整数 ID`);
  }
}

function normalizeAuthority(value: unknown, label: string): PhysicalStructureLedgerAuthority {
  assertRecord(value, label);
  assertExactKeys(value, ['stateHash'], label);
  assertHash(value.stateHash, `${label}.stateHash`);
  return { stateHash: value.stateHash };
}

function normalizeSeal(value: unknown, label: string): PhysicalStructureLedgerSeal {
  assertRecord(value, label);
  assertExactKeys(value, ['eventCount', 'tailEventId'], label);
  assertSafeIntegerInRange(value.eventCount, 0, Number.MAX_SAFE_INTEGER, `${label}.eventCount`);
  if (value.eventCount === 0) {
    if (value.tailEventId !== null) throw new Error(`${label}.tailEventId 必须为空`);
  } else {
    assertBoundedString(value.tailEventId, `${label}.tailEventId`);
  }
  return { eventCount: value.eventCount, tailEventId: value.tailEventId as string | null };
}

function sameAuthority(
  left: PhysicalStructureLedgerAuthority,
  right: PhysicalStructureLedgerAuthority,
): boolean {
  return left.stateHash === right.stateHash;
}

function sameSeal(left: PhysicalStructureLedgerSeal, right: PhysicalStructureLedgerSeal): boolean {
  return left.eventCount === right.eventCount && left.tailEventId === right.tailEventId;
}

function recordKey(record: Pick<PhysicalConstructionRecord, 'x' | 'y' | 'z' | 'materialId'>): string {
  return `${record.x}:${record.y}:${record.z}:${record.materialId}`;
}

function compareConstructionRecords(
  left: PhysicalConstructionRecord,
  right: PhysicalConstructionRecord,
): number {
  if (left.firstSeenAbsoluteIndex !== right.firstSeenAbsoluteIndex) {
    return left.firstSeenAbsoluteIndex < right.firstSeenAbsoluteIndex ? -1 : 1;
  }
  if (left.latestSourceAbsoluteIndex !== right.latestSourceAbsoluteIndex) {
    return left.latestSourceAbsoluteIndex < right.latestSourceAbsoluteIndex ? -1 : 1;
  }
  return recordKey(left).localeCompare(recordKey(right));
}

function normalizeConstructionRecords(
  value: unknown,
  target: PhysicalStructureLedgerSeal,
  constructionEventCount: number,
): PhysicalConstructionRecord[] {
  assertArray(value, MAX_CONSTRUCTION_RECORDS, 'physical ledger index.constructionRecords');
  if (value.length > constructionEventCount) {
    throw new Error('physical ledger constructionRecords 多于 constructionEventCount');
  }
  const records: PhysicalConstructionRecord[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `physical ledger index.constructionRecords[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'x',
      'y',
      'z',
      'materialId',
      'firstSeenAbsoluteIndex',
      'latestSourceAbsoluteIndex',
      'sourceEventId',
    ], label);
    assertSafeIntegerInRange(candidate.x, 0, WORLD_WIDTH - 1, `${label}.x`);
    assertSafeIntegerInRange(candidate.y, 0, WORLD_DEPTH - 1, `${label}.y`);
    assertSafeIntegerInRange(candidate.z, 0, WORLD_LEVELS - 1, `${label}.z`);
    assertMaterialId(candidate.materialId, `${label}.materialId`);
    if (!materialHas(candidate.materialId, 'solid')
      || !materialHas(candidate.materialId, 'building')) {
      throw new Error(`${label}.materialId 不是 solid building material`);
    }
    const maximumOrdinal = target.eventCount - 1;
    assertSafeIntegerInRange(
      candidate.firstSeenAbsoluteIndex,
      0,
      maximumOrdinal,
      `${label}.firstSeenAbsoluteIndex`,
    );
    assertSafeIntegerInRange(
      candidate.latestSourceAbsoluteIndex,
      candidate.firstSeenAbsoluteIndex,
      maximumOrdinal,
      `${label}.latestSourceAbsoluteIndex`,
    );
    assertBoundedString(candidate.sourceEventId, `${label}.sourceEventId`);
    if (candidate.latestSourceAbsoluteIndex === maximumOrdinal
      && candidate.sourceEventId !== target.tailEventId) {
      throw new Error(`${label}.sourceEventId 与 target tailEventId 不一致`);
    }
    const record: PhysicalConstructionRecord = {
      x: candidate.x,
      y: candidate.y,
      z: candidate.z,
      materialId: candidate.materialId,
      firstSeenAbsoluteIndex: candidate.firstSeenAbsoluteIndex,
      latestSourceAbsoluteIndex: candidate.latestSourceAbsoluteIndex,
      sourceEventId: candidate.sourceEventId,
    };
    const key = recordKey(record);
    if (keys.has(key)) throw new Error(`physical ledger construction record ${key} 重复`);
    if (records.length > 0
      && compareConstructionRecords(records[records.length - 1], record) >= 0) {
      throw new Error('physical ledger constructionRecords 未按投影顺序严格排列');
    }
    keys.add(key);
    records.push(record);
  }
  return records;
}

function normalizeUniqueIntegerArray(
  value: unknown,
  maximumValue: number,
  maximumLength: number,
  label: string,
  options: { nonEmpty?: boolean } = {},
): number[] {
  assertArray(value, maximumLength, label);
  if (options.nonEmpty && value.length === 0) throw new Error(`${label} 必须是非空数组`);
  const result: number[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    assertSafeIntegerInRange(item, 0, maximumValue, `${label}[${index}]`);
    if (seen.has(item)) throw new Error(`${label} 包含重复项 ${item}`);
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeInteriorPositions(
  value: unknown,
  occupiedCells: readonly number[],
  label: string,
): Array<{ cellId: number; z: number }> {
  assertArray(value, WORLD_VOXEL_COUNT, label);
  const occupiedOrder = new Map(occupiedCells.map((cellId, index) => [cellId, index]));
  const positions: Array<{ cellId: number; z: number }> = [];
  const seen = new Set<string>();
  let previousCellOrder = -1;
  let previousZ = -1;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const itemLabel = `${label}[${index}]`;
    assertRecord(candidate, itemLabel);
    assertExactKeys(candidate, ['cellId', 'z'], itemLabel);
    assertSafeIntegerInRange(candidate.cellId, 0, WORLD_CELL_COUNT - 1, `${itemLabel}.cellId`);
    assertSafeIntegerInRange(candidate.z, 1, WORLD_LEVELS - 2, `${itemLabel}.z`);
    const cellOrder = occupiedOrder.get(candidate.cellId);
    if (cellOrder === undefined) {
      throw new Error(`${itemLabel}.cellId 不属于 structure.occupiedCells`);
    }
    const key = `${candidate.cellId}:${candidate.z}`;
    if (seen.has(key)) throw new Error(`${label} 包含重复位置 ${key}`);
    if (cellOrder < previousCellOrder
      || (cellOrder === previousCellOrder && candidate.z <= previousZ)) {
      throw new Error(`${label} 未按 occupiedCells 与 z 的投影顺序排列`);
    }
    positions.push({ cellId: candidate.cellId, z: candidate.z });
    seen.add(key);
    previousCellOrder = cellOrder;
    previousZ = candidate.z;
  }
  return positions;
}

function normalizeMaterialIds(value: unknown, label: string): MaterialId[] {
  assertArray(value, MATERIAL_PALETTE.length, label);
  if (value.length === 0) throw new Error(`${label} 必须是非空数组`);
  const result: MaterialId[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const materialId = value[index];
    assertMaterialId(materialId, `${label}[${index}]`);
    if (!materialHas(materialId, 'solid')
      || !materialHas(materialId, 'building')
      || materialHas(materialId, 'placeable')) {
      throw new Error(`${label}[${index}] 不是 structure lane 的非 placeable building material`);
    }
    if (seen.has(materialId)) throw new Error(`${label} 包含重复 materialId ${materialId}`);
    seen.add(materialId);
    result.push(materialId);
  }
  return result;
}

function normalizeSourceEventIds(value: unknown, maximumLength: number, label: string): string[] {
  assertArray(value, maximumLength, label);
  if (value.length === 0) throw new Error(`${label} 必须是非空数组`);
  return value.map((item, index) => {
    assertBoundedString(item, `${label}[${index}]`);
    return item;
  });
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function structureOrigin(value: string, label: string): { x: number; y: number; z: number } {
  const match = STRUCTURE_ID_PATTERN.exec(value);
  if (!match) throw new Error(`${label} 不是 physical projection structure ID`);
  const origin = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
  assertSafeIntegerInRange(origin.x, 0, WORLD_WIDTH - 1, `${label}.x`);
  assertSafeIntegerInRange(origin.y, 0, WORLD_DEPTH - 1, `${label}.y`);
  assertSafeIntegerInRange(origin.z, 0, WORLD_LEVELS - 1, `${label}.z`);
  return origin;
}

function assertStructureSourcesMatchRecords(
  structure: PhysicalStructure,
  records: readonly PhysicalConstructionRecord[],
  label: string,
): number {
  const occupied = new Set(structure.occupiedCells);
  const materials = new Set(structure.materialIds);
  const sourceCounts = new Map<string, number>();
  for (const sourceEventId of structure.sourceEventIds) {
    sourceCounts.set(sourceEventId, (sourceCounts.get(sourceEventId) ?? 0) + 1);
  }
  const matchingRecords = records.filter((record) =>
    occupied.has(record.x + record.y * WORLD_WIDTH)
      && materials.has(record.materialId)
      && sourceCounts.has(record.sourceEventId));
  for (const [sourceEventId, count] of sourceCounts) {
    const available = matchingRecords.filter((record) => record.sourceEventId === sourceEventId).length;
    if (available < count) {
      throw new Error(`${label}.sourceEventIds 的 ${sourceEventId} 缺少对应 construction record`);
    }
  }
  for (const cellId of occupied) {
    if (!matchingRecords.some((record) => record.x + record.y * WORLD_WIDTH === cellId)) {
      throw new Error(`${label}.occupiedCells 的 ${cellId} 缺少来源记录`);
    }
  }
  for (const materialId of materials) {
    if (!matchingRecords.some((record) => record.materialId === materialId)) {
      throw new Error(`${label}.materialIds 的 ${materialId} 缺少来源记录`);
    }
  }
  const origin = structureOrigin(structure.id, `${label}.id`);
  const originRecordIndex = records.findIndex((record) =>
    record.x === origin.x
      && record.y === origin.y
      && record.z === origin.z
      && materials.has(record.materialId)
      && sourceCounts.has(record.sourceEventId));
  if (originRecordIndex < 0) {
    throw new Error(`${label}.id 没有同位置、材料与来源的 construction record`);
  }
  return originRecordIndex;
}

function normalizeStructures(
  value: unknown,
  records: readonly PhysicalConstructionRecord[],
): PhysicalStructure[] {
  assertArray(value, Math.min(WORLD_VOXEL_COUNT, records.length), 'physical ledger index.structures');
  const structures: PhysicalStructure[] = [];
  const ids = new Set<string>();
  let previousOriginRecordIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `physical ledger index.structures[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'id',
      'name',
      'occupiedCells',
      'interiorCells',
      'interiorPositions',
      'materialIds',
      'weatherProtection',
      'thermalInsulation',
      'capacity',
      'complete',
      'sourceEventIds',
    ], label);
    assertBoundedString(candidate.id, `${label}.id`);
    if (ids.has(candidate.id)) throw new Error(`${label}.id 重复`);
    assertBoundedString(candidate.name, `${label}.name`, MAX_PHYSICAL_STRUCTURE_LEDGER_NAME_BYTES);
    const occupiedCells = normalizeUniqueIntegerArray(
      candidate.occupiedCells,
      WORLD_CELL_COUNT - 1,
      WORLD_CELL_COUNT,
      `${label}.occupiedCells`,
      { nonEmpty: true },
    );
    const interiorPositions = normalizeInteriorPositions(
      candidate.interiorPositions,
      occupiedCells,
      `${label}.interiorPositions`,
    );
    const interiorCells = normalizeUniqueIntegerArray(
      candidate.interiorCells,
      WORLD_CELL_COUNT - 1,
      occupiedCells.length,
      `${label}.interiorCells`,
    );
    const expectedInteriorCells = [...new Set(interiorPositions.map((position) => position.cellId))];
    if (!sameNumbers(interiorCells, expectedInteriorCells)) {
      throw new Error(`${label}.interiorCells 与 interiorPositions 不一致`);
    }
    const materialIds = normalizeMaterialIds(candidate.materialIds, `${label}.materialIds`);
    assertSafeIntegerInRange(candidate.weatherProtection, 0, 100, `${label}.weatherProtection`);
    assertSafeIntegerInRange(candidate.thermalInsulation, 0, 100, `${label}.thermalInsulation`);
    assertSafeIntegerInRange(candidate.capacity, 0, WORLD_VOXEL_COUNT, `${label}.capacity`);
    assertBoolean(candidate.complete, `${label}.complete`);
    if (candidate.capacity !== interiorPositions.length
      || candidate.complete !== (interiorPositions.length > 0)) {
      throw new Error(`${label} 的 capacity/complete 与 interiorPositions 不一致`);
    }
    if (candidate.complete) {
      if (candidate.weatherProtection === 0 || candidate.thermalInsulation === 0) {
        throw new Error(`${label} 的完整结构缺少物理防护指标`);
      }
    } else if (candidate.weatherProtection !== 0 || candidate.thermalInsulation !== 0) {
      throw new Error(`${label} 的未完成结构不得声明物理防护指标`);
    }
    const sourceEventIds = normalizeSourceEventIds(
      candidate.sourceEventIds,
      records.length,
      `${label}.sourceEventIds`,
    );
    const expectedName = `${candidate.complete ? '' : '未完成'}${materialIds
      .map((materialId) => materialDefinition(materialId).name).join('、')}${candidate.complete ? '遮蔽结构' : '结构'}`;
    if (candidate.name !== expectedName) throw new Error(`${label}.name 与材料和完整性不一致`);
    const structure: PhysicalStructure = {
      id: candidate.id,
      name: candidate.name,
      occupiedCells,
      interiorCells,
      interiorPositions,
      materialIds,
      weatherProtection: candidate.weatherProtection,
      thermalInsulation: candidate.thermalInsulation,
      capacity: candidate.capacity,
      complete: candidate.complete,
      sourceEventIds,
    };
    const originRecordIndex = assertStructureSourcesMatchRecords(structure, records, label);
    if (originRecordIndex <= previousOriginRecordIndex) {
      throw new Error('physical ledger structures 未按来源 construction record 严格排列');
    }
    structures.push(structure);
    ids.add(structure.id);
    previousOriginRecordIndex = originRecordIndex;
  }
  return structures;
}

function normalizeIndex(value: unknown, target: PhysicalStructureLedgerSeal): PhysicalStructureIndex {
  assertRecord(value, 'physical ledger index');
  assertExactKeys(value, [
    'projectionVersion',
    'appliedHistoryEventCount',
    'appliedTailEventId',
    'calculatedAtMonth',
    'voxelRevision',
    'constructionEventCount',
    'constructionRecords',
    'structures',
  ], 'physical ledger index');
  if (value.projectionVersion !== 2) throw new Error('physical ledger index.projectionVersion 必须是 2');
  assertSafeIntegerInRange(
    value.appliedHistoryEventCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'physical ledger index.appliedHistoryEventCount',
  );
  if (value.appliedHistoryEventCount !== target.eventCount
    || value.appliedTailEventId !== target.tailEventId) {
    throw new Error('physical ledger index applied history boundary 与 target 不一致');
  }
  assertSafeIntegerInRange(
    value.calculatedAtMonth,
    0,
    Number.MAX_SAFE_INTEGER,
    'physical ledger index.calculatedAtMonth',
  );
  assertSafeIntegerInRange(
    value.voxelRevision,
    0,
    Number.MAX_SAFE_INTEGER,
    'physical ledger index.voxelRevision',
  );
  assertSafeIntegerInRange(
    value.constructionEventCount,
    0,
    target.eventCount,
    'physical ledger index.constructionEventCount',
  );
  const constructionRecords = normalizeConstructionRecords(
    value.constructionRecords,
    target,
    value.constructionEventCount,
  );
  const structures = normalizeStructures(value.structures, constructionRecords);
  if (target.eventCount === 0
    && (value.constructionEventCount !== 0
      || constructionRecords.length !== 0
      || structures.length !== 0)) {
    throw new Error('genesis physical ledger 不得包含建造投影');
  }
  return {
    projectionVersion: 2,
    appliedHistoryEventCount: target.eventCount,
    appliedTailEventId: target.tailEventId,
    calculatedAtMonth: value.calculatedAtMonth,
    voxelRevision: value.voxelRevision,
    constructionEventCount: value.constructionEventCount,
    constructionRecords,
    structures,
  };
}

function normalizeProjection(value: unknown): PhysicalStructureLedgerProjectionResult {
  assertRecord(value, 'physical ledger projection');
  assertExactKeys(value, ['schemaVersion', 'authority', 'target', 'index'], 'physical ledger projection');
  if (value.schemaVersion !== PHYSICAL_STRUCTURE_LEDGER_SIDECAR_SCHEMA_VERSION) {
    throw new Error('physical ledger projection.schemaVersion 无效');
  }
  const authority = normalizeAuthority(value.authority, 'physical ledger projection.authority');
  const target = normalizeSeal(value.target, 'physical ledger projection.target');
  return {
    schemaVersion: PHYSICAL_STRUCTURE_LEDGER_SIDECAR_SCHEMA_VERSION,
    authority,
    target,
    index: normalizeIndex(value.index, target),
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function canonicalBytes(projection: PhysicalStructureLedgerProjectionResult): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(projection)), 'utf8');
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as UnknownRecord)) deepFreeze(child, visited);
  return Object.freeze(value);
}

export function hashPhysicalStructureLedgerStoredContent(codec: string, data: Uint8Array): string {
  return createHash('sha256').update(codec).update('\0').update(data).digest('hex');
}

function ownedChunk(
  hash: string,
  codec: string,
  rawSize: number,
  data: Buffer | Uint8Array,
): Readonly<PhysicalStructureLedgerSidecarChunk> {
  assertHash(hash, 'physical ledger sidecar chunk.hash');
  if (codec !== PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC) {
    throw new Error('physical ledger sidecar chunk.codec 无效');
  }
  assertSafeIntegerInRange(
    rawSize,
    1,
    Number.MAX_SAFE_INTEGER,
    'physical ledger sidecar chunk.rawSize',
  );
  if (rawSize > MAX_PHYSICAL_STRUCTURE_LEDGER_SIDECAR_STORED_BYTES) {
    throw new Error(
      `physical ledger sidecar 存储内容超过硬上限 ${MAX_PHYSICAL_STRUCTURE_LEDGER_SIDECAR_STORED_BYTES}`,
    );
  }
  if (!(Buffer.isBuffer(data) || data instanceof Uint8Array)) {
    throw new Error('physical ledger sidecar chunk.data 必须是字节数组');
  }
  if (data.byteLength !== rawSize) throw new Error('physical ledger sidecar chunk 长度与记录不一致');
  const ownedData = Buffer.from(data);
  return Object.freeze({
    hash,
    codec,
    rawSize,
    get data(): Buffer { return Buffer.from(ownedData); },
  });
}

/**
 * Encode a completely validated projection into owned canonical bytes. The
 * returned digest is a content reference candidate, not an authority token.
 */
export function encodePhysicalStructureLedgerSidecar(
  input: unknown,
): Readonly<EncodedPhysicalStructureLedgerSidecar> {
  const projection = deepFreeze(normalizeProjection(input));
  const data = canonicalBytes(projection);
  if (data.byteLength > MAX_PHYSICAL_STRUCTURE_LEDGER_SIDECAR_STORED_BYTES) {
    throw new Error(
      `physical ledger sidecar 存储内容超过硬上限 ${MAX_PHYSICAL_STRUCTURE_LEDGER_SIDECAR_STORED_BYTES}`,
    );
  }
  const hash = hashPhysicalStructureLedgerStoredContent(
    PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
    data,
  );
  const chunk = ownedChunk(
    hash,
    PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
    data.byteLength,
    data,
  );
  const reference = Object.freeze({
    kind: 'content-hash' as const,
    codec: PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
    hash,
  });
  return Object.freeze({ chunk, reference, projection });
}

function normalizeBoundary(value: unknown): PhysicalStructureLedgerSidecarBoundaryV1 {
  assertRecord(value, 'physical ledger sidecar expected boundary');
  assertExactKeys(value, ['authority', 'target'], 'physical ledger sidecar expected boundary');
  return {
    authority: normalizeAuthority(
      value.authority,
      'physical ledger sidecar expected boundary.authority',
    ),
    target: normalizeSeal(value.target, 'physical ledger sidecar expected boundary.target'),
  };
}

function normalizeDecodeExpectation(value: unknown): PhysicalStructureLedgerSidecarDecodeExpectationV1 {
  assertRecord(value, 'physical ledger sidecar decode expectation');
  assertExactKeys(value, ['reference', 'boundary'], 'physical ledger sidecar decode expectation');
  assertRecord(value.reference, 'physical ledger sidecar expected reference');
  assertExactKeys(
    value.reference,
    ['kind', 'codec', 'hash'],
    'physical ledger sidecar expected reference',
  );
  if (value.reference.kind !== 'content-hash') {
    throw new Error('physical ledger sidecar 只接受 store-selected content-hash 引用');
  }
  if (value.reference.codec !== PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC) {
    throw new Error('physical ledger sidecar expected reference.codec 无效');
  }
  assertHash(value.reference.hash, 'physical ledger sidecar expected reference.hash');
  return {
    reference: {
      kind: 'content-hash',
      codec: PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
      hash: value.reference.hash,
    },
    boundary: normalizeBoundary(value.boundary),
  };
}

/**
 * Decode only bytes bound to the content reference and exact projection
 * authority/target selected by the owning store. A caller-computed digest is
 * never sufficient to select this expectation.
 */
export function decodePhysicalStructureLedgerSidecar(
  chunk: PhysicalStructureLedgerSidecarChunk,
  expectedInput: unknown,
): Readonly<PhysicalStructureLedgerProjectionResult> {
  const expected = normalizeDecodeExpectation(expectedInput);
  if (!chunk || typeof chunk !== 'object') throw new Error('physical ledger sidecar chunk 必须是对象');
  if (chunk.codec !== expected.reference.codec || chunk.hash !== expected.reference.hash) {
    throw new Error('physical ledger sidecar chunk 不属于 store-selected content reference');
  }
  const snapshot = ownedChunk(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
  const data = Buffer.from(snapshot.data);
  if (hashPhysicalStructureLedgerStoredContent(snapshot.codec, data) !== snapshot.hash) {
    throw new Error(`physical ledger sidecar chunk ${snapshot.hash} 的 SHA-256 校验失败`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`physical ledger sidecar chunk ${snapshot.hash} 无法解析`, { cause: error });
  }
  const projection = normalizeProjection(parsed);
  if (!data.equals(canonicalBytes(projection))) {
    throw new Error('physical ledger sidecar payload 不是 canonical UTF-8 JSON 编码');
  }
  if (!sameAuthority(projection.authority, expected.boundary.authority)
    || !sameSeal(projection.target, expected.boundary.target)) {
    throw new Error('physical ledger sidecar payload 与 expected authority/target boundary 不一致');
  }
  const decoded = deepFreeze(projection);
  decodedPhysicalStructureLedgerSidecars.add(decoded);
  return decoded;
}

/** Take an owned byte snapshot before a future store authority flow awaits. */
export function snapshotPhysicalStructureLedgerSidecarChunk(
  chunk: PhysicalStructureLedgerSidecarChunk,
): Readonly<PhysicalStructureLedgerSidecarChunk> {
  if (!chunk || typeof chunk !== 'object') throw new Error('physical ledger sidecar chunk 必须是对象');
  return ownedChunk(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
}
