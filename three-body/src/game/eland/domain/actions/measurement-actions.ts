import type { PrimitiveAction } from '../action';
import {
  actionFactsForPersonWithRetainedLease,
  compareWorldEventsInCanonicalOrder,
  worldEventById,
} from '../event-index';
import { materialDefinition, materialHas } from '../material';
import {
  MASS_MEASUREMENT_RESOLUTION,
  MASS_MEASUREMENT_UNIT,
  MASS_CALIBRATION_RECEIPT_VERSION,
  MASS_MEASUREMENT_RECEIPT_VERSION,
  canonicalMeasurementSourceEventIds,
  eventManufacturedMeasurementArtifact,
  eventSupportsMeasurementStackMaterial,
  isMassCalibrationReceipt,
  isSourcedMassMeasurementAction,
  measurementStackReceiptMatchesUse,
  sameMeasurementSourceEventIds,
  sameMeasurementStackIdentity,
  type MeasurementStackReceipt,
  type MeasurementStackUse,
} from '../measurement';
import type { ActionFact, SimulationState } from '../model';
import type { ItemStack, PersonState } from '../person';

type AttendAction = Extract<PrimitiveAction, { kind: 'attend' }>;

type MeasurementOutcome = {
  status: 'completed' | 'blocked';
  result: string;
  diff: Record<string, unknown>;
};

type StackValidation =
  | { ok: true; stack: ItemStack; receipt: MeasurementStackReceipt }
  | { ok: false; reason: string };

function validateCurrentStack(
  state: SimulationState,
  person: PersonState,
  use: MeasurementStackUse,
  sourceKind: 'artifact' | 'material',
): StackValidation {
  if (use.personId !== person.id) return { ok: false, reason: '测量装置只能使用本人当前持有的实体栈' };
  const stack = person.inventory.find((candidate) => candidate.id === use.stackId && candidate.quantity > 0);
  if (!stack) return { ok: false, reason: '所指测量物已经不在本人背包中' };
  if (!Number.isSafeInteger(use.quantity) || use.quantity <= 0 || use.quantity > stack.quantity) {
    return { ok: false, reason: '所指测量物数量与本人当前持有量不一致' };
  }
  if (stack.recordPayloadId) return { ok: false, reason: '已经承载记录的实体不能作为普通校准或测量输入' };
  if (!use.sourceEventIds.length
    || !sameMeasurementSourceEventIds(use.sourceEventIds, stack.sourceEventIds)) {
    return { ok: false, reason: '所指测量物没有绑定当前实体栈的完整来源' };
  }
  const sources = canonicalMeasurementSourceEventIds(use.sourceEventIds)
    .map((sourceEventId) => worldEventById(state, sourceEventId));
  if (sources.some((event) => !eventSupportsMeasurementStackMaterial(event, stack.materialId))) {
    return { ok: false, reason: '所指测量物的来源不能解析为同一物质事实' };
  }
  if (sourceKind === 'artifact'
    && !sources.some((event) => eventManufacturedMeasurementArtifact(event, stack.materialId))) {
    return { ok: false, reason: '测量装置或参考物缺少可回放的实体制造来源' };
  }
  return {
    ok: true,
    stack,
    receipt: Object.freeze({
      personId: person.id,
      stackId: stack.id,
      materialId: stack.materialId,
      quantity: use.quantity,
      heldQuantity: stack.quantity,
      sourceEventIds: Object.freeze(canonicalMeasurementSourceEventIds(stack.sourceEventIds)),
    }),
  };
}

function eventPrecedes(left: ActionFact, rightMonth: number): boolean {
  return left.atMonth <= rightMonth;
}

const PERSONAL_MASS_CALIBRATION_LEASE_PREFIX = 'gameplay:personal-mass-calibration:';

export function personalMassCalibrationLeaseKey(personId: string, instrumentStackId: string): string {
  return `${PERSONAL_MASS_CALIBRATION_LEASE_PREFIX}${encodeURIComponent(personId)}:${encodeURIComponent(instrumentStackId)}`;
}

export function parsePersonalMassCalibrationLeaseKey(
  leaseKey: string,
): { personId: string; instrumentStackId: string } | null {
  if (!leaseKey.startsWith(PERSONAL_MASS_CALIBRATION_LEASE_PREFIX)) return null;
  const suffix = leaseKey.slice(PERSONAL_MASS_CALIBRATION_LEASE_PREFIX.length);
  const separator = suffix.indexOf(':');
  if (separator <= 0 || separator === suffix.length - 1) return null;
  try {
    const personId = decodeURIComponent(suffix.slice(0, separator));
    const instrumentStackId = decodeURIComponent(suffix.slice(separator + 1));
    return personId.length > 0 && instrumentStackId.length > 0
      && personalMassCalibrationLeaseKey(personId, instrumentStackId) === leaseKey
      ? { personId, instrumentStackId }
      : null;
  } catch {
    return null;
  }
}

export function latestPersonalCalibrationFor(
  state: SimulationState,
  personId: string,
  instrument: MeasurementStackReceipt,
): ActionFact | undefined {
  return actionFactsForPersonWithRetainedLease(
    state,
    personId,
    personalMassCalibrationLeaseKey(personId, instrument.stackId),
  ).filter((event) => isValidPersonalMassCalibrationFactForInstrument(event, personId, instrument))
    .sort(compareWorldEventsInCanonicalOrder)
    .at(-1);
}

export function calibrationMatchesAction(event: ActionFact): boolean {
  if (event.status !== 'completed'
    || event.action.kind !== 'attend'
    || !isSourcedMassMeasurementAction(event.action.measurement)
    || event.action.measurement.mode !== 'calibrate-mass'
    || !isMassCalibrationReceipt(event.diff)) return false;
  return event.diff.calibrationEventId === event.id
    && event.diff.calibratedByPersonId === event.who
    && event.diff.calibratedAtMonth === event.atMonth
    && event.action.instrumentStackId === event.action.measurement.instrument.stackId
    && measurementStackReceiptMatchesUse(event.diff.instrument, event.action.measurement.instrument)
    && measurementStackReceiptMatchesUse(event.diff.reference, event.action.measurement.reference)
    && event.action.target.kind === 'inventory-stack'
    && event.action.target.personId === event.who
    && event.action.target.stackId === event.action.measurement.reference.stackId;
}

export function isValidPersonalMassCalibrationFactForInstrument(
  event: ActionFact,
  personId: string,
  instrument: MeasurementStackReceipt,
): boolean {
  return event.who === personId
    && calibrationMatchesAction(event)
    && isMassCalibrationReceipt(event.diff)
    && sameMeasurementStackIdentity(event.diff.instrument, instrument);
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function executeMeasurementAttend(
  state: SimulationState,
  person: PersonState,
  action: AttendAction,
  atMonth: number,
  eventId: string,
): MeasurementOutcome | null {
  if (!action.measurement) {
    return action.instrumentStackId
      ? { status: 'blocked', result: '仪器观察必须提交来源绑定的校准或测量动作', diff: {} }
      : null;
  }
  if (!isSourcedMassMeasurementAction(action.measurement)) {
    return { status: 'blocked', result: '测量动作结构或来源字段无效', diff: {} };
  }
  if (action.instrumentStackId !== action.measurement.instrument.stackId) {
    return { status: 'blocked', result: '测量动作引用的仪器实体不一致', diff: {} };
  }

  const instrument = validateCurrentStack(state, person, action.measurement.instrument, 'artifact');
  if (!instrument.ok) return { status: 'blocked', result: instrument.reason, diff: {} };
  if (instrument.receipt.quantity !== 1 || !materialHas(instrument.stack.materialId, 'instrument')) {
    return { status: 'blocked', result: '所指实体不是可用的单件质量测量仪器', diff: {} };
  }

  if (action.measurement.mode === 'calibrate-mass') {
    if (action.target.kind !== 'inventory-stack'
      || action.target.personId !== person.id
      || action.target.stackId !== action.measurement.reference.stackId) {
      return { status: 'blocked', result: '校准目标必须是本人当前持有的所指参考物', diff: {} };
    }
    if (action.measurement.reference.stackId === action.measurement.instrument.stackId) {
      return { status: 'blocked', result: '测量仪器不能同时冒充校准参考物', diff: {} };
    }
    const reference = validateCurrentStack(state, person, action.measurement.reference, 'artifact');
    if (!reference.ok) return { status: 'blocked', result: reference.reason, diff: {} };
    if (!materialHas(reference.stack.materialId, 'mass-reference')
      || materialDefinition(reference.stack.materialId).mass <= 0) {
      return { status: 'blocked', result: '所指实体不是可复核的质量参考物', diff: {} };
    }
    const receipt = Object.freeze({
      version: MASS_CALIBRATION_RECEIPT_VERSION,
      receiptKind: 'mass-calibration' as const,
      calibrationEventId: eventId,
      calibratedByPersonId: person.id,
      calibratedAtMonth: atMonth,
      dimension: 'mass' as const,
      unit: MASS_MEASUREMENT_UNIT,
      resolution: MASS_MEASUREMENT_RESOLUTION,
      instrument: instrument.receipt,
      reference: reference.receipt,
    });
    return {
      status: 'completed',
      result: `用有来源的参考物校准了${materialDefinition(instrument.stack.materialId).name}`,
      diff: receipt,
    };
  }

  if (action.target.kind !== 'inventory-stack'
    || action.target.personId !== person.id
    || action.target.stackId !== action.measurement.subject.stackId) {
    return { status: 'blocked', result: '被测目标必须是本人当前持有的所指实体栈', diff: {} };
  }
  if (action.measurement.subject.stackId === action.measurement.instrument.stackId) {
    return { status: 'blocked', result: '测量仪器不能称量自身', diff: {} };
  }
  const subject = validateCurrentStack(state, person, action.measurement.subject, 'material');
  if (!subject.ok) return { status: 'blocked', result: subject.reason, diff: {} };
  if (materialDefinition(subject.stack.materialId).mass <= 0) {
    return { status: 'blocked', result: '当前实体没有可由此装置比较的正质量', diff: {} };
  }

  const calibration = worldEventById(state, action.measurement.calibrationEventId);
  if (!calibration
    || calibration.kind !== 'action'
    || calibration.who !== person.id
    || !eventPrecedes(calibration, atMonth)
    || !calibrationMatchesAction(calibration)
    || !isMassCalibrationReceipt(calibration.diff)
    || !sameMeasurementStackIdentity(calibration.diff.instrument, instrument.receipt)) {
    return { status: 'blocked', result: '测量缺少同一人物对同一实体仪器的可回放校准事实', diff: {} };
  }
  const latestCalibration = latestPersonalCalibrationFor(state, person.id, instrument.receipt);
  if (!latestCalibration || latestCalibration.id !== calibration.id) {
    return { status: 'blocked', result: '所指校准已经被同一实体仪器的较新校准取代', diff: {} };
  }
  const calibrationSources = [calibration.diff.instrument, calibration.diff.reference];
  if (calibrationSources.some((receipt) => receipt.sourceEventIds.some((sourceEventId) => (
    !eventSupportsMeasurementStackMaterial(worldEventById(state, sourceEventId), receipt.materialId)
  )))) {
    return { status: 'blocked', result: '校准事实的仪器或参考物来源已经无法解析', diff: {} };
  }

  const referenceLoad = materialDefinition(calibration.diff.reference.materialId).mass
    * calibration.diff.reference.quantity;
  if (!(referenceLoad > 0)) return { status: 'blocked', result: '校准参考物不能形成正质量基准', diff: {} };
  const subjectLoad = materialDefinition(subject.stack.materialId).mass * subject.receipt.quantity;
  const relativeLoad = subjectLoad / referenceLoad;
  const center = Math.round(relativeLoad / MASS_MEASUREMENT_RESOLUTION) * MASS_MEASUREMENT_RESOLUTION;
  const interval = Object.freeze({
    lowerInclusive: rounded(Math.max(0, center - MASS_MEASUREMENT_RESOLUTION / 2)),
    upperInclusive: rounded(center + MASS_MEASUREMENT_RESOLUTION / 2),
  });
  const receipt = Object.freeze({
    version: MASS_MEASUREMENT_RECEIPT_VERSION,
    receiptKind: 'mass-measurement' as const,
    measurementEventId: eventId,
    measuredByPersonId: person.id,
    measuredAtMonth: atMonth,
    dimension: 'mass' as const,
    unit: MASS_MEASUREMENT_UNIT,
    resolution: MASS_MEASUREMENT_RESOLUTION,
    interval,
    instrument: instrument.receipt,
    subject: subject.receipt,
    reference: Object.freeze({
      ...calibration.diff.reference,
      sourceEventIds: Object.freeze([...calibration.diff.reference.sourceEventIds]),
    }),
    calibrationEventId: calibration.id,
  });
  return {
    status: 'completed',
    result: `测得${materialDefinition(subject.stack.materialId).name}约为参考载荷的 ${interval.lowerInclusive}–${interval.upperInclusive} 倍`,
    diff: receipt,
  };
}
