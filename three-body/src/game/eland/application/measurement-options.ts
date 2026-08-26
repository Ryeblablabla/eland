import { worldEventById } from '../domain/event-index';
import { Material, materialDefinition, materialHas } from '../domain/material';
import {
  canonicalMeasurementSourceEventIds,
  eventManufacturedMeasurementArtifact,
  eventSupportsMeasurementStackMaterial,
  isMassCalibrationReceipt,
  isMassMeasurementReceipt,
  isSourcedMassMeasurementAction,
  measurementStackReceiptMatchesUse,
  sameMeasurementSourceEventIds,
  sameMeasurementStackIdentity,
  type MeasurementStackUse,
} from '../domain/measurement';
import type { ActionFact, SimulationState, WorldEvent } from '../domain/model';
import type { ItemStack, PersonState } from '../domain/person';
import type {
  MeasurementUncertaintyBasis,
  MeasurementUncertaintySampleBasis,
  PerceivedLoadBand,
  ProjectState,
} from '../domain/project';

export const MEASUREMENT_UNCERTAINTY_BASIS_VERSION = 'measurement-uncertainty-basis-v1' as const;

/**
 * A person can retain hands-on production experience either as a short-lived
 * episode or as the source of a technique they still know. Every candidate
 * event is revalidated below against the actor, material and current entity,
 * so technique provenance does not reveal another person's or a hidden recipe.
 */
function personalProductionExperienceEventIds(person: PersonState): ReadonlySet<string> {
  return new Set([
    ...person.memories.flatMap((memory) => memory.sourceEventIds),
    ...person.knowledge
      .filter((fact) => fact.kind === 'technique')
      .flatMap((fact) => fact.sourceEventIds),
  ]);
}

function perceivedLoadBand(materialId: number, quantity: number): PerceivedLoadBand {
  // Physics remains authoritative, but planning receives only a deliberately
  // broad hand-feel category. No exact mass or ratio is persisted in the basis.
  const load = materialDefinition(materialId).mass * quantity;
  if (load <= 0.5) return 'trace';
  if (load <= 1.5) return 'light';
  if (load <= 4) return 'hand-load';
  return 'burdensome';
}

function isPersonalProductionFact(
  event: WorldEvent | undefined,
  personId: string,
  materialId: number,
  atMonth: number,
): event is ActionFact {
  return Boolean(event
    && event.kind === 'action'
    && event.status === 'completed'
    && event.who === personId
    && event.atMonth <= atMonth
    && event.action.kind === 'act'
    && (event.action.operation === 'combine'
      || event.action.operation === 'exert'
      || event.action.operation === 'expose')
    && eventSupportsMeasurementStackMaterial(event, materialId));
}

function canonicalSample(
  state: SimulationState,
  person: PersonState,
  stack: ItemStack,
  rememberedEventIds: ReadonlySet<string>,
  atMonth: number,
): MeasurementUncertaintySampleBasis | null {
  if (stack.quantity <= 0
    || stack.recordPayloadId
    || stack.sourceEventIds.length === 0
    || stack.sourceEventIds.length > 24
    || new Set(stack.sourceEventIds).size !== stack.sourceEventIds.length) return null;
  const definition = materialDefinition(stack.materialId);
  if (definition.phase !== 'solid'
    || !(definition.mass > 0)
    || materialHas(stack.materialId, 'instrument')
    || materialHas(stack.materialId, 'mass-reference')) return null;
  const sourceEventIds = canonicalMeasurementSourceEventIds(stack.sourceEventIds);
  const sources = sourceEventIds.map((eventId) => worldEventById(state, eventId));
  if (sources.some((event) => !eventSupportsMeasurementStackMaterial(event, stack.materialId))) return null;
  const productionEventIds = sources.flatMap((event) => (
    isPersonalProductionFact(event, person.id, stack.materialId, atMonth)
      && rememberedEventIds.has(event.id) ? [event.id] : []
  ));
  if (!productionEventIds.length) return null;
  return {
    personId: person.id,
    stackId: stack.id,
    materialId: stack.materialId,
    // One current unit remains a concrete use of this source-bound batch while
    // avoiding the fiction that a person already knows the stack's exact mass.
    quantity: 1,
    perceivedLoadBand: perceivedLoadBand(stack.materialId, 1),
    sourceEventIds,
    productionEventIds: canonicalMeasurementSourceEventIds(productionEventIds),
  };
}

function sampleOrder(
  left: MeasurementUncertaintySampleBasis,
  right: MeasurementUncertaintySampleBasis,
): number {
  return left.materialId - right.materialId
    || left.stackId.localeCompare(right.stackId)
    || left.quantity - right.quantity;
}

function measurementUncertaintyBasisKey(
  observerId: string,
  samples: readonly MeasurementUncertaintySampleBasis[],
  productionEventIds: readonly string[],
): string {
  const sampleKeys = [...samples].sort(sampleOrder).map((sample) => (
    `${sample.stackId}:${sample.materialId}:${sample.quantity}:${sample.perceivedLoadBand}`
    + `:${canonicalMeasurementSourceEventIds(sample.sourceEventIds).join('.')}`
  ));
  return `${MEASUREMENT_UNCERTAINTY_BASIS_VERSION}|observer=${observerId}`
    + `|samples=${sampleKeys.join(',')}|production=${canonicalMeasurementSourceEventIds(productionEventIds).join('.')}`;
}

function productionMonths(state: SimulationState, eventIds: readonly string[]): number[] {
  return [...new Set(eventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event.atMonth] : [];
  }))].sort((left, right) => left - right);
}

/**
 * Opens only from two current, personally produced entity stacks whose broad
 * hand-feel overlaps after at least three remembered production experiences
 * spanning two months. This is a local uncertainty, not an era unlock.
 */
export function measurementUncertaintyBasisFor(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths + 1,
): MeasurementUncertaintyBasis | null {
  const rememberedEventIds = personalProductionExperienceEventIds(person);
  const samples = person.inventory.flatMap((stack) => {
    const sample = canonicalSample(state, person, stack, rememberedEventIds, atMonth);
    return sample ? [sample] : [];
  }).sort(sampleOrder);
  const candidates: Array<{
    samples: [MeasurementUncertaintySampleBasis, MeasurementUncertaintySampleBasis];
    productionEventIds: string[];
    months: number[];
  }> = [];
  for (let leftIndex = 0; leftIndex < samples.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < samples.length; rightIndex += 1) {
      const left = samples[leftIndex];
      const right = samples[rightIndex];
      if (left.perceivedLoadBand !== right.perceivedLoadBand
        || (left.materialId === right.materialId && left.quantity === right.quantity)) continue;
      const productionEventIds = canonicalMeasurementSourceEventIds([
        ...left.productionEventIds,
        ...right.productionEventIds,
      ]);
      const months = productionMonths(state, productionEventIds);
      if (productionEventIds.length < 3 || months.length < 2) continue;
      candidates.push({ samples: [left, right], productionEventIds, months });
    }
  }
  const selected = candidates.sort((left, right) => (
    right.productionEventIds.length - left.productionEventIds.length
    || right.months.length - left.months.length
    || sampleOrder(left.samples[0], right.samples[0])
    || sampleOrder(left.samples[1], right.samples[1])
  ))[0];
  if (!selected) return null;
  const sourceFactIds = canonicalMeasurementSourceEventIds(
    selected.samples.flatMap((sample) => sample.sourceEventIds),
  );
  return {
    version: MEASUREMENT_UNCERTAINTY_BASIS_VERSION,
    observerId: person.id,
    atMonth,
    uncertaintyKind: 'overlapping-felt-load-bands',
    samples: selected.samples,
    productionEventIds: selected.productionEventIds,
    experiencedMonthCount: selected.months.length,
    sourceFactIds,
    basisKey: measurementUncertaintyBasisKey(person.id, selected.samples, selected.productionEventIds),
  };
}

export function validateMeasurementUncertaintyBasis(
  state: SimulationState,
  person: PersonState,
  basis: MeasurementUncertaintyBasis,
  requireCurrentMemory: boolean,
  atMonth = state.clock.elapsedMonths + 1,
): boolean {
  if (basis.version !== MEASUREMENT_UNCERTAINTY_BASIS_VERSION
    || basis.observerId !== person.id
    || !Number.isSafeInteger(basis.atMonth)
    || basis.atMonth < 0
    || basis.atMonth > atMonth
    || basis.uncertaintyKind !== 'overlapping-felt-load-bands'
    || !Array.isArray(basis.samples)
    || basis.samples.length !== 2) return false;
  const remembered = personalProductionExperienceEventIds(person);
  const rebuilt = basis.samples.flatMap((sample) => {
    if (sample.personId !== person.id
      || !Number.isSafeInteger(sample.quantity)
      || sample.quantity <= 0
      || sample.sourceEventIds.length === 0
      || sample.sourceEventIds.length > 24
      || new Set(sample.sourceEventIds).size !== sample.sourceEventIds.length) return [];
    const stack = person.inventory.find((candidate) => candidate.id === sample.stackId
      && candidate.materialId === sample.materialId
      && candidate.quantity >= sample.quantity
      && !candidate.recordPayloadId
      && sameMeasurementSourceEventIds(candidate.sourceEventIds, sample.sourceEventIds));
    if (!stack || perceivedLoadBand(stack.materialId, sample.quantity) !== sample.perceivedLoadBand) return [];
    const sources = canonicalMeasurementSourceEventIds(sample.sourceEventIds)
      .map((eventId) => worldEventById(state, eventId));
    if (sources.some((event) => !eventSupportsMeasurementStackMaterial(event, sample.materialId))) return [];
    const productionEventIds = canonicalMeasurementSourceEventIds(sources.flatMap((event) => (
      isPersonalProductionFact(event, person.id, sample.materialId, basis.atMonth) ? [event.id] : []
    )));
    if (!sameMeasurementSourceEventIds(productionEventIds, sample.productionEventIds)
      || requireCurrentMemory && productionEventIds.some((eventId) => !remembered.has(eventId))) return [];
    return [{
      ...sample,
      sourceEventIds: canonicalMeasurementSourceEventIds(sample.sourceEventIds),
      productionEventIds,
    }];
  });
  if (rebuilt.length !== 2
    || rebuilt[0].stackId === rebuilt[1].stackId
    || rebuilt[0].perceivedLoadBand !== rebuilt[1].perceivedLoadBand
    || (rebuilt[0].materialId === rebuilt[1].materialId && rebuilt[0].quantity === rebuilt[1].quantity)) return false;
  const productionEventIds = canonicalMeasurementSourceEventIds(
    rebuilt.flatMap((sample) => sample.productionEventIds),
  );
  const months = productionMonths(state, productionEventIds);
  const sourceFactIds = canonicalMeasurementSourceEventIds(rebuilt.flatMap((sample) => sample.sourceEventIds));
  return productionEventIds.length >= 3
    && months.length >= 2
    && basis.experiencedMonthCount === months.length
    && sameMeasurementSourceEventIds(basis.productionEventIds, productionEventIds)
    && sameMeasurementSourceEventIds(basis.sourceFactIds, sourceFactIds)
    && basis.basisKey === measurementUncertaintyBasisKey(person.id, rebuilt, productionEventIds);
}

export function measurementUncertaintyPressure(
  state: SimulationState,
  basis: MeasurementUncertaintyBasis,
): number {
  const monthCount = productionMonths(state, basis.productionEventIds).length;
  return Math.min(100, 28
    + Math.min(24, Math.max(0, basis.productionEventIds.length - 1) * 6)
    + Math.min(12, Math.max(0, monthCount - 1) * 4));
}

function validSourcedArtifactStack(
  state: SimulationState,
  person: PersonState,
  materialId: number,
): ItemStack | undefined {
  return person.inventory.filter((stack) => stack.materialId === materialId
    && stack.quantity > 0
    && !stack.recordPayloadId
    && stack.sourceEventIds.length > 0
    && stack.sourceEventIds.length <= 24
    && new Set(stack.sourceEventIds).size === stack.sourceEventIds.length)
    .sort((left, right) => left.id.localeCompare(right.id))
    .find((stack) => {
      const sources = stack.sourceEventIds.map((eventId) => worldEventById(state, eventId));
      return sources.every((event) => eventSupportsMeasurementStackMaterial(event, materialId))
        && sources.some((event) => eventManufacturedMeasurementArtifact(event, materialId));
    });
}

export function currentMassMeasurementInstrument(
  state: SimulationState,
  person: PersonState,
): ItemStack | undefined {
  return validSourcedArtifactStack(state, person, Material.BeamBalance);
}

export function currentMassMeasurementReference(
  state: SimulationState,
  person: PersonState,
): ItemStack | undefined {
  return validSourcedArtifactStack(state, person, Material.StandardWeight);
}

export function currentMeasurementBasisSubject(
  person: PersonState,
  basis: MeasurementUncertaintyBasis,
): { stack: ItemStack; quantity: number } | undefined {
  return basis.samples.flatMap((sample) => {
    const stack = person.inventory.find((candidate) => candidate.id === sample.stackId
      && candidate.materialId === sample.materialId
      && candidate.quantity >= sample.quantity
      && !candidate.recordPayloadId
      && sameMeasurementSourceEventIds(candidate.sourceEventIds, sample.sourceEventIds));
    return stack ? [{ stack, quantity: sample.quantity }] : [];
  })[0];
}

export function measurementStackUse(
  person: PersonState,
  stack: ItemStack,
  quantity: number,
): MeasurementStackUse {
  return {
    personId: person.id,
    stackId: stack.id,
    quantity,
    sourceEventIds: canonicalMeasurementSourceEventIds(stack.sourceEventIds),
  };
}

function validArtifactReceiptSources(state: SimulationState, receipt: {
  materialId: number;
  sourceEventIds: readonly string[];
}): boolean {
  const sources = receipt.sourceEventIds.map((eventId) => worldEventById(state, eventId));
  return sources.length > 0
    && sources.every((event) => eventSupportsMeasurementStackMaterial(event, receipt.materialId))
    && sources.some((event) => eventManufacturedMeasurementArtifact(event, receipt.materialId));
}

function calibrationFactMatches(fact: ActionFact): boolean {
  if (fact.status !== 'completed'
    || fact.action.kind !== 'attend'
    || !isSourcedMassMeasurementAction(fact.action.measurement)
    || fact.action.measurement.mode !== 'calibrate-mass'
    || !isMassCalibrationReceipt(fact.diff)) return false;
  return fact.diff.calibrationEventId === fact.id
    && fact.diff.calibratedByPersonId === fact.who
    && fact.diff.calibratedAtMonth === fact.atMonth
    && fact.action.instrumentStackId === fact.action.measurement.instrument.stackId
    && fact.action.target.kind === 'inventory-stack'
    && fact.action.target.personId === fact.who
    && fact.action.target.stackId === fact.action.measurement.reference.stackId
    && measurementStackReceiptMatchesUse(fact.diff.instrument, fact.action.measurement.instrument)
    && measurementStackReceiptMatchesUse(fact.diff.reference, fact.action.measurement.reference);
}

function actionFactOrder(left: ActionFact, right: ActionFact): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || (left.planningTick ?? 0) - (right.planningTick ?? 0)
    || (left.orderInTick ?? 0) - (right.orderInTick ?? 0)
    || left.id.localeCompare(right.id);
}

/** A project closes only on its own typed calibration -> measurement chain. */
export function massMeasurementProjectCompletionEvidence(
  state: SimulationState,
  project: ProjectState,
): string[] {
  if (project.desiredFunction !== 'comparable-mass-measurement'
    || !project.measurementUncertaintyBasis
    || project.measurementUncertaintyBasis.version !== MEASUREMENT_UNCERTAINTY_BASIS_VERSION) return [];
  const projectActionIds = new Set(project.actionEventIds);
  const facts = project.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
  for (const measurement of [...facts].reverse()) {
    if (measurement.status !== 'completed'
      || measurement.who !== project.ownerId
      || measurement.action.kind !== 'attend'
      || !isSourcedMassMeasurementAction(measurement.action.measurement)
      || measurement.action.measurement.mode !== 'measure-mass'
      || !isMassMeasurementReceipt(measurement.diff)
      || measurement.diff.measurementEventId !== measurement.id
      || measurement.diff.measuredByPersonId !== measurement.who
      || measurement.diff.measuredAtMonth !== measurement.atMonth
      || measurement.action.instrumentStackId !== measurement.action.measurement.instrument.stackId
      || measurement.action.target.kind !== 'inventory-stack'
      || measurement.action.target.personId !== measurement.who
      || measurement.action.target.stackId !== measurement.action.measurement.subject.stackId
      || !measurementStackReceiptMatchesUse(
        measurement.diff.instrument,
        measurement.action.measurement.instrument,
      )
      || !measurementStackReceiptMatchesUse(
        measurement.diff.subject,
        measurement.action.measurement.subject,
      )) continue;
    const measurementReceipt = measurement.diff;
    const calibration = worldEventById(state, measurementReceipt.calibrationEventId);
    if (!calibration
      || calibration.kind !== 'action'
      || !projectActionIds.has(calibration.id)
      || calibration.who !== project.ownerId
      || !calibrationFactMatches(calibration)
      || !isMassCalibrationReceipt(calibration.diff)
      || calibration.id !== measurement.action.measurement.calibrationEventId
      || actionFactOrder(calibration, measurement) >= 0
      || !sameMeasurementStackIdentity(calibration.diff.instrument, measurementReceipt.instrument)
      || !sameMeasurementStackIdentity(calibration.diff.reference, measurementReceipt.reference)
      || measurementReceipt.instrument.materialId !== Material.BeamBalance
      || measurementReceipt.reference.materialId !== Material.StandardWeight
      || !validArtifactReceiptSources(state, measurementReceipt.instrument)
      || !validArtifactReceiptSources(state, measurementReceipt.reference)) continue;
    const subjectMatchesBasis = project.measurementUncertaintyBasis.samples.some((sample) => (
      sample.personId === measurement.who
      && sample.stackId === measurementReceipt.subject.stackId
      && sample.materialId === measurementReceipt.subject.materialId
      && sample.quantity === measurementReceipt.subject.quantity
      && sameMeasurementSourceEventIds(sample.sourceEventIds, measurementReceipt.subject.sourceEventIds)
    ));
    if (!subjectMatchesBasis
      || measurementReceipt.subject.sourceEventIds.some((eventId) => (
        !eventSupportsMeasurementStackMaterial(
          worldEventById(state, eventId),
          measurementReceipt.subject.materialId,
        )
      ))) continue;
    return canonicalMeasurementSourceEventIds([
      ...project.measurementUncertaintyBasis.sourceFactIds,
      ...measurementReceipt.instrument.sourceEventIds,
      ...measurementReceipt.reference.sourceEventIds,
      ...measurementReceipt.subject.sourceEventIds,
      calibration.id,
      measurement.id,
    ]);
  }
  return [];
}
