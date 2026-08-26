import type { MaterialId } from './material';
import type { WorldEvent } from './model';
import type { PersonId } from './person';

export const SOURCED_MASS_MEASUREMENT_ACTION_VERSION = 'sourced-mass-measurement-action-v1' as const;
export const MASS_CALIBRATION_RECEIPT_VERSION = 'mass-calibration-receipt-v1' as const;
export const MASS_MEASUREMENT_RECEIPT_VERSION = 'mass-measurement-receipt-v1' as const;
export const MASS_MEASUREMENT_RESOLUTION = 0.5;
export const MASS_MEASUREMENT_UNIT = 'calibrated-reference-load' as const;

/**
 * A use of a concrete inventory stack. The action freezes the complete retained
 * source set instead of naming an interchangeable material type.
 */
export interface MeasurementStackUse {
  personId: PersonId;
  stackId: string;
  quantity: number;
  sourceEventIds: string[];
}

export type SourcedMassMeasurementAction =
  | {
      version: typeof SOURCED_MASS_MEASUREMENT_ACTION_VERSION;
      mode: 'calibrate-mass';
      instrument: MeasurementStackUse;
      reference: MeasurementStackUse;
    }
  | {
      version: typeof SOURCED_MASS_MEASUREMENT_ACTION_VERSION;
      mode: 'measure-mass';
      instrument: MeasurementStackUse;
      subject: MeasurementStackUse;
      calibrationEventId: string;
    };

export interface MeasurementStackReceipt {
  personId: PersonId;
  stackId: string;
  materialId: MaterialId;
  /** Quantity actually used by this action. */
  quantity: number;
  /** Quantity observed in the stack when the action was committed. */
  heldQuantity: number;
  sourceEventIds: readonly string[];
}

export interface MassCalibrationReceipt {
  version: typeof MASS_CALIBRATION_RECEIPT_VERSION;
  receiptKind: 'mass-calibration';
  calibrationEventId: string;
  calibratedByPersonId: PersonId;
  calibratedAtMonth: number;
  dimension: 'mass';
  unit: typeof MASS_MEASUREMENT_UNIT;
  resolution: typeof MASS_MEASUREMENT_RESOLUTION;
  instrument: MeasurementStackReceipt;
  reference: MeasurementStackReceipt;
}

export interface MassMeasurementReceipt {
  version: typeof MASS_MEASUREMENT_RECEIPT_VERSION;
  receiptKind: 'mass-measurement';
  measurementEventId: string;
  measuredByPersonId: PersonId;
  measuredAtMonth: number;
  dimension: 'mass';
  unit: typeof MASS_MEASUREMENT_UNIT;
  resolution: typeof MASS_MEASUREMENT_RESOLUTION;
  interval: {
    lowerInclusive: number;
    upperInclusive: number;
  };
  instrument: MeasurementStackReceipt;
  subject: MeasurementStackReceipt;
  reference: MeasurementStackReceipt;
  calibrationEventId: string;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function uniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 24
    && value.every((item) => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

export function canonicalMeasurementSourceEventIds(sourceEventIds: readonly string[]): string[] {
  return [...new Set(sourceEventIds)].sort((left, right) => left.localeCompare(right));
}

export function sameMeasurementSourceEventIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const leftCanonical = canonicalMeasurementSourceEventIds(left);
  const rightCanonical = canonicalMeasurementSourceEventIds(right);
  return leftCanonical.every((eventId, index) => eventId === rightCanonical[index]);
}

export function isMeasurementStackUse(value: unknown): value is MeasurementStackUse {
  const record = objectRecord(value);
  return Boolean(record
    && typeof record.personId === 'string'
    && record.personId.length > 0
    && typeof record.stackId === 'string'
    && record.stackId.length > 0
    && Number.isSafeInteger(record.quantity)
    && Number(record.quantity) > 0
    && uniqueStrings(record.sourceEventIds));
}

export function isSourcedMassMeasurementAction(value: unknown): value is SourcedMassMeasurementAction {
  const record = objectRecord(value);
  if (!record
    || record.version !== SOURCED_MASS_MEASUREMENT_ACTION_VERSION
    || !isMeasurementStackUse(record.instrument)) return false;
  if (record.mode === 'calibrate-mass') return isMeasurementStackUse(record.reference);
  return record.mode === 'measure-mass'
    && isMeasurementStackUse(record.subject)
    && typeof record.calibrationEventId === 'string'
    && record.calibrationEventId.length > 0;
}

function isMeasurementStackReceipt(value: unknown): value is MeasurementStackReceipt {
  const record = objectRecord(value);
  return Boolean(record
    && typeof record.personId === 'string'
    && record.personId.length > 0
    && typeof record.stackId === 'string'
    && record.stackId.length > 0
    && Number.isSafeInteger(record.materialId)
    && Number(record.materialId) >= 0
    && Number.isSafeInteger(record.quantity)
    && Number(record.quantity) > 0
    && Number.isSafeInteger(record.heldQuantity)
    && Number(record.heldQuantity) >= Number(record.quantity)
    && uniqueStrings(record.sourceEventIds));
}

export function isMassCalibrationReceipt(value: unknown): value is MassCalibrationReceipt {
  const record = objectRecord(value);
  return Boolean(record
    && record.version === MASS_CALIBRATION_RECEIPT_VERSION
    && record.receiptKind === 'mass-calibration'
    && typeof record.calibrationEventId === 'string'
    && record.calibrationEventId.length > 0
    && typeof record.calibratedByPersonId === 'string'
    && record.calibratedByPersonId.length > 0
    && Number.isSafeInteger(record.calibratedAtMonth)
    && Number(record.calibratedAtMonth) >= 0
    && record.dimension === 'mass'
    && record.unit === MASS_MEASUREMENT_UNIT
    && record.resolution === MASS_MEASUREMENT_RESOLUTION
    && isMeasurementStackReceipt(record.instrument)
    && isMeasurementStackReceipt(record.reference));
}

export function isMassMeasurementReceipt(value: unknown): value is MassMeasurementReceipt {
  const record = objectRecord(value);
  const interval = objectRecord(record?.interval);
  return Boolean(record
    && record.version === MASS_MEASUREMENT_RECEIPT_VERSION
    && record.receiptKind === 'mass-measurement'
    && typeof record.measurementEventId === 'string'
    && record.measurementEventId.length > 0
    && typeof record.measuredByPersonId === 'string'
    && record.measuredByPersonId.length > 0
    && Number.isSafeInteger(record.measuredAtMonth)
    && Number(record.measuredAtMonth) >= 0
    && record.dimension === 'mass'
    && record.unit === MASS_MEASUREMENT_UNIT
    && record.resolution === MASS_MEASUREMENT_RESOLUTION
    && interval
    && typeof interval.lowerInclusive === 'number'
    && Number.isFinite(interval.lowerInclusive)
    && Number(interval.lowerInclusive) >= 0
    && typeof interval.upperInclusive === 'number'
    && Number.isFinite(interval.upperInclusive)
    && Number(interval.upperInclusive) > Number(interval.lowerInclusive)
    && Number(interval.upperInclusive) - Number(interval.lowerInclusive) <= MASS_MEASUREMENT_RESOLUTION + Number.EPSILON
    && isMeasurementStackReceipt(record.instrument)
    && isMeasurementStackReceipt(record.subject)
    && isMeasurementStackReceipt(record.reference)
    && typeof record.calibrationEventId === 'string'
    && record.calibrationEventId.length > 0);
}

export function measurementStackReceiptMatchesUse(
  receipt: MeasurementStackReceipt,
  use: MeasurementStackUse,
): boolean {
  return receipt.personId === use.personId
    && receipt.stackId === use.stackId
    && receipt.quantity === use.quantity
    && receipt.heldQuantity >= receipt.quantity
    && sameMeasurementSourceEventIds(receipt.sourceEventIds, use.sourceEventIds);
}

export function sameMeasurementStackIdentity(
  left: MeasurementStackReceipt,
  right: MeasurementStackReceipt,
): boolean {
  return left.personId === right.personId
    && left.stackId === right.stackId
    && left.materialId === right.materialId
    && left.quantity === right.quantity
    && sameMeasurementSourceEventIds(left.sourceEventIds, right.sourceEventIds);
}

/**
 * A receipt source must itself be a replayable fact about this material. Merely
 * placing an arbitrary, resolvable event ID in a stack is not provenance.
 */
export function eventSupportsMeasurementStackMaterial(
  event: WorldEvent | undefined,
  materialId: MaterialId,
): boolean {
  if (!event) return false;
  if (event.kind === 'action') {
    if (event.status !== 'completed') return false;
    if (event.action.kind === 'transfer') {
      return event.action.materialId === materialId && Number(event.diff.quantity) > 0;
    }
    if (Number(event.diff.outputMaterialId) === materialId) return true;
    if (Array.isArray(event.diff.outputs)) return event.diff.outputs.some((output) => {
      const record = objectRecord(output);
      return Number(record?.materialId) === materialId && Number(record?.quantity) > 0;
    });
    return false;
  }
  if (event.kind !== 'environment' || (event.change !== 'material' && event.change !== 'resource')) return false;
  return Number(event.diff.materialId) === materialId
    || Number(event.diff.outputMaterialId) === materialId;
}

/** Instrument and reference artifacts need a physical production fact, not just a transfer. */
export function eventManufacturedMeasurementArtifact(
  event: WorldEvent | undefined,
  materialId: MaterialId,
): boolean {
  return Boolean(event
    && event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'act'
    && (event.action.operation === 'combine'
      || event.action.operation === 'exert'
      || event.action.operation === 'expose')
    && Number(event.diff.outputMaterialId) === materialId);
}
