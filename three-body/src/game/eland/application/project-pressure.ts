import { animalSpecies, isAnimalAlive } from '../domain/animal';
import { Material, materialHas, type MaterialId } from '../domain/material';
import type { DropState, SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { ageMonths, inventoryQuantity, isAlive } from '../domain/person';
import type { ProjectPressureBasis, ProjectProposal } from '../domain/project';
import { shelterGeometryAt } from '../domain/structure';
import {
  projectPressureEvidenceDescriptorCandidatesForPerson,
  projectPressureEvidenceResolutionSnapshotIsCurrent,
  snapshotProjectPressureEvidenceResolution,
  type ProjectPressureEvidenceResolutionSnapshot,
  worldEventsByIdsInHistoryOrder,
} from '../domain/event-index';
import {
  projectPressureEvidenceDescriptorFromWorldEvent,
  selectProjectPressureEvidenceDescriptors,
  snapshotRememberedProjectPressureSources,
  type ProjectPressureEvidenceDescriptor,
  type ProjectPressureEvidenceSelection,
  type ProjectPressureSourceEventIdSnapshot,
} from '../domain/project-pressure-evidence';
import { cellsInRadius } from '../world/grid';
import { personalityScore } from '../domain/personality';
import { productionToolRank } from '../domain/production-tool';
import { buildLocalMaterialEvidence } from './local-material-evidence';
import {
  mechanicalPowerMaintenancePressureEvidence,
  mechanicalPowerPressureEvidence,
  validateMechanicalReliabilityBasis,
} from './mechanical-power-options';
import {
  measurementUncertaintyPressure,
  validateMeasurementUncertaintyBasis,
} from './measurement-options';
import {
  remoteWorkPowerPressure,
  validateRemoteWorkPowerTransmissionBasis,
} from './electrical-power-options';
import {
  electricalPowerMaintenancePressure,
  validateElectricalPowerMaintenanceBasis,
} from './electrical-power-maintenance-options';

export const PROJECT_PRESSURE_BASIS_VERSION = 'project-pressure-basis-v1' as const;

export type ProjectPressureSubject = Pick<
  ProjectProposal,
  'need' | 'beneficiaryIds' | 'createdAtMonth' | 'targetKnowledgeId' | 'shelterRequirement' | 'pressureBasis'
    | 'mechanicalReliabilityBasis'
    | 'electricalPowerMaintenanceBasis'
    | 'measurementUncertaintyBasis'
    | 'remoteWorkPowerBasis'
    | 'productionToolBaselineRank'
> & { desiredFunction?: ProjectProposal['desiredFunction'] };

export interface ProjectPressureView {
  visibleCells?: number[];
  visibleDrops?: DropState[];
  visiblePeople?: PersonState[];
}

export interface ProjectPressureCompilationDiagnostics {
  rememberedSourceSnapshotBuilds: number;
  rememberedCandidateResolutions: number;
  rememberedSelections: number;
}

/** Cache owned by exactly one synchronous proposal compilation. */
export interface ProjectPressureCompilationContext {
  readonly ownerId: PersonState['id'];
  readonly atMonth: number;
  readonly sourceSnapshot: ProjectPressureSourceEventIdSnapshot;
  readonly resolutionSnapshot: ProjectPressureEvidenceResolutionSnapshot;
  readonly rememberedCandidates: readonly ProjectPressureEvidenceDescriptor[];
  readonly rememberedSelection: ProjectPressureEvidenceSelection;
  readonly stateIdentity: SimulationState;
  readonly ownerIdentity: PersonState;
}

export function createProjectPressureCompilationDiagnostics(): ProjectPressureCompilationDiagnostics {
  return {
    rememberedSourceSnapshotBuilds: 0,
    rememberedCandidateResolutions: 0,
    rememberedSelections: 0,
  };
}

export function createProjectPressureCompilationContext(
  state: SimulationState,
  owner: PersonState,
  atMonth: number,
  diagnostics?: ProjectPressureCompilationDiagnostics,
): ProjectPressureCompilationContext {
  if (diagnostics) diagnostics.rememberedSourceSnapshotBuilds += 1;
  const sourceSnapshot = snapshotRememberedProjectPressureSources(owner);
  const resolutionSnapshot = snapshotProjectPressureEvidenceResolution(state);
  if (diagnostics) diagnostics.rememberedCandidateResolutions += 1;
  const rememberedCandidates = [...projectPressureEvidenceDescriptorCandidatesForPerson(
    state,
    owner,
    sourceSnapshot,
  )];
  if (diagnostics) diagnostics.rememberedSelections += 1;
  const rememberedSelection = selectProjectPressureEvidenceDescriptors(
    rememberedCandidates,
    owner.id,
    atMonth,
  );
  Object.freeze(rememberedCandidates);
  Object.freeze(rememberedSelection.huntFailures);
  Object.freeze(rememberedSelection.animalAttacks);
  Object.freeze(rememberedSelection.dehydrations);
  Object.freeze(rememberedSelection.developmentProvenance);
  Object.freeze(rememberedSelection.descriptors);
  Object.freeze(rememberedSelection);
  return Object.freeze({
    ownerId: owner.id,
    atMonth,
    sourceSnapshot,
    resolutionSnapshot,
    rememberedCandidates,
    rememberedSelection,
    stateIdentity: state,
    ownerIdentity: owner,
  });
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function makeBasis(
  subject: ProjectPressureSubject,
  owner: PersonState,
  atMonth: number,
  pressure: number,
  edgeKeys: Iterable<string>,
  reasonKeys: Iterable<string>,
  sourceFactIds: Iterable<string>,
): ProjectPressureBasis {
  const edges = unique(edgeKeys);
  const reasons = unique(reasonKeys);
  const sources = unique(sourceFactIds);
  const normalizedPressure = Math.round(clamp(pressure) * 100) / 100;
  return {
    version: PROJECT_PRESSURE_BASIS_VERSION,
    need: subject.need,
    observerId: owner.id,
    atMonth,
    pressure: normalizedPressure,
    edgeKeys: edges,
    reasonKeys: reasons,
    sourceFactIds: sources,
    basisKey: `${PROJECT_PRESSURE_BASIS_VERSION}|need=${subject.need}|observer=${owner.id}|edges=${edges.join(',')}`,
  };
}

function defaultView(state: SimulationState, owner: PersonState): Required<ProjectPressureView> {
  const visibleCells = cellsInRadius(owner.position.cellId, 4 + Math.floor(owner.baselineCapacities.perception / 25));
  const visible = new Set(visibleCells);
  return {
    visibleCells,
    visibleDrops: state.world.drops.filter((drop) => drop.quantity > 0 && visible.has(drop.cellId)),
    visiblePeople: state.people.filter((person) => isAlive(person) && visible.has(person.position.cellId)),
  };
}

function resolvedView(state: SimulationState, owner: PersonState, input: ProjectPressureView): Required<ProjectPressureView> {
  const fallback = defaultView(state, owner);
  return {
    visibleCells: input.visibleCells ?? fallback.visibleCells,
    visibleDrops: input.visibleDrops ?? fallback.visibleDrops,
    visiblePeople: input.visiblePeople ?? fallback.visiblePeople,
  };
}

function resolvedProjectPressureCompilationContext(
  state: SimulationState,
  owner: PersonState,
  atMonth: number,
  input?: ProjectPressureCompilationContext,
): ProjectPressureCompilationContext {
  if (!input) return createProjectPressureCompilationContext(state, owner, atMonth);
  if (input.stateIdentity !== state
    || input.ownerIdentity !== owner
    || input.ownerId !== owner.id
    || input.sourceSnapshot.ownerId !== owner.id
    || input.atMonth !== atMonth
    || !projectPressureEvidenceResolutionSnapshotIsCurrent(state, input.resolutionSnapshot)) {
    throw new Error('project-pressure compilation context 与当前人物/月/state 不匹配');
  }
  return input;
}

function projectPressureEvidence(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
  inputContext?: ProjectPressureCompilationContext,
): ProjectPressureEvidenceSelection {
  const context = resolvedProjectPressureCompilationContext(
    state,
    owner,
    atMonth,
    inputContext,
  );
  const activeSourceFactIds = subject.pressureBasis?.sourceFactIds ?? [];
  if (activeSourceFactIds.length === 0) return context.rememberedSelection;
  // An active project's prior basis is an independent exact retention anchor;
  // do not require it to be reclassified as remembered person-local evidence.
  const activeBasis = worldEventsByIdsInHistoryOrder(
    state,
    activeSourceFactIds,
  ).map(projectPressureEvidenceDescriptorFromWorldEvent);
  return selectProjectPressureEvidenceDescriptors(
    [...context.rememberedCandidates, ...activeBasis],
    owner.id,
    atMonth,
  );
}

function thermalBasis(state: SimulationState, owner: PersonState, subject: ProjectPressureSubject, atMonth: number) {
  const cold = owner.conditions.find((condition) => condition.kind === 'cold');
  const insulated = owner.inventory.some((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'insulating'));
  const climateCold = state.civilization.climate.kind === 'cold' && state.civilization.climate.severity >= 3;
  const edgeKeys = [
    `state:cold:${cold?.stage ?? 'none'}`,
    `state:climate:${state.civilization.epoch}:${state.civilization.climate.kind}:${state.civilization.climate.severity}`,
    `state:insulation:${insulated ? 'present' : 'absent'}`,
  ];
  const reasons = [
    ...(cold ? ['personal-cold-condition'] : []),
    ...(climateCold ? ['current-cold-climate'] : []),
    ...(insulated ? ['insulation-acquired'] : []),
  ];
  const pressure = insulated ? 0 : cold
    ? 45 + cold.stage * 15
    : climateCold ? 45 + state.civilization.climate.severity * 15 : 18;
  return makeBasis(subject, owner, atMonth, pressure, edgeKeys, reasons, cold?.sourceEventIds ?? []);
}

function huntingBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
  view: Required<ProjectPressureView>,
  context?: ProjectPressureCompilationContext,
) {
  const failureEdges = new Map<string, string>();
  const attackEdges = new Map<string, string>();
  const witnesses = projectPressureEvidence(state, owner, subject, atMonth, context);
  for (const event of witnesses.huntFailures) {
    failureEdges.set(
      `event:hunt-failure:${event.atMonth}:${event.huntFailure!.animalId}`,
      event.eventId,
    );
  }
  for (const event of witnesses.animalAttacks) {
    attackEdges.set(`event:animal-attack:${event.eventId}`, event.eventId);
  }
  const visible = new Set(view.visibleCells);
  const threats = state.world.animals.filter((animal) => isAnimalAlive(animal)
    && visible.has(animal.position.cellId)
    && animalSpecies(animal.speciesId).aggression > 0);
  const spear = inventoryQuantity(owner, Material.Spear) > 0;
  const edgeKeys = [
    ...failureEdges.keys(),
    ...attackEdges.keys(),
    ...threats.map((animal) => `state:visible-threat:${animal.id}:${animal.speciesId}`),
    `state:spear:${spear ? 'present' : 'absent'}`,
  ];
  const reasons = [
    ...(failureEdges.size ? ['own-hunt-failure'] : []),
    ...(attackEdges.size ? ['personal-animal-attack'] : []),
    ...(threats.length ? ['visible-aggressive-animal'] : []),
    ...(spear ? ['spear-acquired'] : []),
  ];
  const pressure = spear ? 0 : 38
    + Math.min(30, failureEdges.size * 10)
    + Math.min(36, attackEdges.size * 18)
    + Math.min(24, threats.length * 12);
  return makeBasis(subject, owner, atMonth, pressure, edgeKeys, reasons, [
    ...failureEdges.values(),
    ...attackEdges.values(),
  ]);
}

function careBasis(owner: PersonState, subject: ProjectPressureSubject, atMonth: number, view: Required<ProjectPressureView>) {
  const visibleById = new Map(view.visiblePeople.map((person) => [person.id, person]));
  if (!visibleById.has(owner.id)) visibleById.set(owner.id, owner);
  const observed = subject.beneficiaryIds.flatMap((personId) => {
    const person = visibleById.get(personId);
    if (!person) return [];
    const conditions = person.conditions.filter((condition) => condition.kind === 'wound' || condition.kind === 'illness');
    return [{ person, conditions }];
  });
  const conditions = observed.flatMap(({ person, conditions: current }) => current.map((condition) => ({ person, condition })));
  const maxStage = conditions.length ? Math.max(...conditions.map(({ condition }) => condition.stage)) : 0;
  const anyVisible = observed.length > 0;
  const pressure = maxStage > 0
    ? 42 + maxStage * 18
      + (personalityScore(owner, 'emotionality') + personalityScore(owner, 'agreeableness')) * 0.06
    : anyVisible ? 18 : subject.pressureBasis?.pressure ?? 32;
  return makeBasis(subject, owner, atMonth, pressure, [
    ...subject.beneficiaryIds.map((id) => `state:beneficiary-visible:${id}:${visibleById.has(id) ? 'yes' : 'no'}`),
    ...conditions.map(({ person, condition }) => `state:condition:${person.id}:${condition.kind}:${condition.stage}`),
    ...(anyVisible && !conditions.length ? ['state:care-condition:none'] : []),
  ], [
    ...(conditions.length ? ['visible-beneficiary-condition'] : []),
    ...(anyVisible && !conditions.length ? ['visible-beneficiary-recovered'] : []),
    ...(!anyVisible ? ['beneficiary-not-currently-visible'] : []),
  ], conditions.flatMap(({ condition }) => condition.sourceEventIds));
}

function nutritionBand(nutrition: number): 'critical' | 'low' | 'moderate' | 'stable' {
  if (nutrition < 25) return 'critical';
  if (nutrition < 45) return 'low';
  if (nutrition < 65) return 'moderate';
  return 'stable';
}

function quantityBand(quantity: number): 'none' | 'small' | 'medium' | 'large' {
  if (quantity <= 0) return 'none';
  if (quantity <= 2) return 'small';
  if (quantity <= 5) return 'medium';
  return 'large';
}

function foodBasis(owner: PersonState, subject: ProjectPressureSubject, atMonth: number, view: Required<ProjectPressureView>) {
  const stacks = owner.inventory.filter((stack) => stack.materialId === Material.RawMeat && stack.quantity > 0);
  const drops = view.visibleDrops.filter((drop) => drop.materialId === Material.RawMeat && drop.quantity > 0);
  const cooked = owner.inventory.filter((stack) => stack.materialId === Material.CookedFood && stack.quantity > 0);
  const rawQuantity = stacks.reduce((sum, stack) => sum + stack.quantity, 0) + drops.reduce((sum, drop) => sum + drop.quantity, 0);
  const nutrition = nutritionBand(owner.body.nutrition);
  const nutritionPressure = nutrition === 'critical' ? 36 : nutrition === 'low' ? 24 : nutrition === 'moderate' ? 12 : 0;
  const rawBand = quantityBand(rawQuantity);
  const rawPressure = rawBand === 'large' ? 18 : rawBand === 'medium' ? 10 : rawBand === 'small' ? 4 : 0;
  return makeBasis(subject, owner, atMonth, cooked.length ? 0 : rawQuantity > 0 ? 35 + nutritionPressure + rawPressure : 18, [
    `state:nutrition:${nutrition}`,
    `state:raw-meat:${rawBand}`,
    `state:cooked-food:${cooked.length ? 'present' : 'absent'}`,
    ...stacks.map((stack) => `state:raw-stack:${stack.id}:present`),
    ...drops.map((drop) => `state:visible-raw-drop:${drop.id}:present`),
  ], [
    ...(rawQuantity > 0 ? ['raw-meat-available'] : ['raw-meat-exhausted']),
    ...(cooked.length ? ['cooked-food-acquired'] : []),
    ...(nutrition !== 'stable' ? [`nutrition-${nutrition}`] : []),
  ], [
    ...stacks.flatMap((stack) => stack.sourceEventIds),
    ...drops.flatMap((drop) => drop.sourceEventIds),
    ...cooked.flatMap((stack) => stack.sourceEventIds),
  ]);
}

function shelterBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
  view: Required<ProjectPressureView>,
) {
  const visibleById = new Map(view.visiblePeople.map((person) => [person.id, person]));
  if (!visibleById.has(owner.id)) visibleById.set(owner.id, owner);
  const beneficiaryId = subject.shelterRequirement?.beneficiaryId ?? subject.beneficiaryIds[0] ?? owner.id;
  const beneficiary = visibleById.get(beneficiaryId);
  const exposure = beneficiary?.conditions.find((condition) => (
    condition.kind === 'cold' || condition.kind === 'heat'
  ) && (!subject.shelterRequirement || condition.kind === subject.shelterRequirement.exposureKind));
  const shelter = beneficiary ? shelterGeometryAt(state.world.grid, beneficiary.position) : null;
  const sheltered = subject.shelterRequirement ? true : Boolean(shelter);
  const rememberedExposure = Boolean(subject.shelterRequirement?.sourceEventIds.length);
  const severeWeather = state.civilization.weather.kind === 'storm' && state.civilization.weather.intensity >= 2;
  const severeClimate = state.civilization.climate.kind === 'fire'
    || ((state.civilization.climate.kind === 'cold' || state.civilization.climate.kind === 'heat') && state.civilization.climate.severity >= 3);
  const severity = exposure?.stage ?? (severeClimate ? state.civilization.climate.severity : severeWeather ? state.civilization.weather.intensity : 0);
  const pressure = subject.shelterRequirement
    ? 48 + Math.max(1, exposure?.stage ?? 1) * 14
    : sheltered ? 0 : severity > 0 ? 48 + severity * 16 : 20;
  return makeBasis(subject, owner, atMonth, pressure, [
    `state:beneficiary-visible:${beneficiaryId}:${beneficiary ? 'yes' : 'no'}`,
    `state:exposure:${beneficiaryId}:${exposure?.kind ?? subject.shelterRequirement?.exposureKind ?? 'none'}:${exposure?.stage ?? (rememberedExposure ? 'remembered' : 0)}`,
    `state:sheltered:${sheltered ? 'yes' : 'no'}`,
    ...(shelter ? [`state:shelter-geometry:${shelter.enclosedSides}:${shelter.weatherProtection}:${shelter.thermalInsulation}`] : []),
    ...(subject.shelterRequirement ? [
      `state:shelter-baseline:${subject.shelterRequirement.baselineEnclosedSides}:${subject.shelterRequirement.baselineWeatherProtection}:${subject.shelterRequirement.baselineThermalInsulation}`,
      `state:shelter-target-sides:${subject.shelterRequirement.minimumEnclosedSides}`,
    ] : []),
    `state:weather:${state.civilization.weather.kind}:${state.civilization.weather.intensity}`,
    `state:climate:${state.civilization.epoch}:${state.civilization.climate.kind}:${state.civilization.climate.severity}`,
  ], [
    ...(exposure ? [beneficiaryId === owner.id ? 'personal-exposure-condition' : 'visible-dependent-exposure-condition'] : []),
    ...(subject.shelterRequirement ? ['shelter-insufficient-despite-enclosure'] : []),
    ...(!exposure && rememberedExposure ? ['remembered-shelter-exposure'] : []),
    ...(severeWeather ? ['current-severe-weather'] : []),
    ...(severeClimate ? ['current-severe-climate'] : []),
    ...(sheltered ? ['functional-shelter-entered'] : []),
  ], [...(exposure?.sourceEventIds ?? []), ...(subject.shelterRequirement?.sourceEventIds ?? [])]);
}

function ageBand(person: PersonState, atMonth: number): 'under-40' | '40-49' | '50-59' | '60-plus' {
  const years = ageMonths(person, atMonth) / 12;
  if (years < 40) return 'under-40';
  if (years < 50) return '40-49';
  if (years < 60) return '50-59';
  return '60-plus';
}

function knowledgeBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
  context?: ProjectPressureCompilationContext,
) {
  const target = subject.targetKnowledgeId
    ? owner.knowledge.find((fact) => fact.id === subject.targetKnowledgeId)
    : undefined;
  const disruptions = new Map<string, string>();
  for (const event of projectPressureEvidence(state, owner, subject, atMonth, context).dehydrations) {
    disruptions.set(`event:personal-dehydration:${event.eventId}`, event.eventId);
  }
  const band = ageBand(owner, atMonth);
  const agePressure = band === '60-plus' ? 24 : band === '50-59' ? 16 : band === '40-49' ? 8 : 0;
  const continuity = band !== 'under-40' || disruptions.size >= 1;
  const confidenceBand = !target ? 'missing' : target.confidence >= 82 ? 'high' : target.confidence >= 68 ? 'mature' : 'tentative';
  return makeBasis(subject, owner, atMonth, target && continuity
    ? 38 + agePressure + Math.min(20, disruptions.size * 4)
    : 18, [
    `state:age-band:${band}`,
    `state:knowledge:${target?.id ?? 'missing'}:${confidenceBand}`,
    ...disruptions.keys(),
  ], [
    ...(target ? ['mature-personal-technique'] : ['target-knowledge-missing']),
    ...(band !== 'under-40' ? [`age-band-${band}`] : []),
    ...(disruptions.size ? ['personal-memory-disruption'] : []),
  ], [
    ...(target?.sourceEventIds ?? []),
    ...disruptions.values(),
  ]);
}

function measurementComparisonBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
) {
  const uncertainty = subject.measurementUncertaintyBasis;
  const valid = Boolean(uncertainty
    && subject.desiredFunction === 'comparable-mass-measurement'
    && validateMeasurementUncertaintyBasis(
      state,
      owner,
      uncertainty,
      !subject.pressureBasis,
      atMonth,
    ));
  const samples = valid ? uncertainty!.samples : [];
  return makeBasis(
    subject,
    owner,
    atMonth,
    valid ? measurementUncertaintyPressure(state, uncertainty!) : 0,
    [
      `project:function:${subject.desiredFunction ?? 'unspecified'}`,
      `state:measurement-comparison-basis:${valid ? uncertainty!.basisKey : 'invalid'}`,
      ...samples.map((sample) => (
        `state:felt-load:${sample.stackId}:${sample.materialId}:${sample.quantity}:${sample.perceivedLoadBand}`
      )),
      `state:remembered-production-experiences:${valid ? uncertainty!.productionEventIds.length : 0}`,
      `state:experienced-production-months:${valid ? uncertainty!.experiencedMonthCount : 0}`,
    ],
    valid
      ? ['overlapping-felt-load-bands', 'repeated-personal-production-memory', 'current-sourced-comparison-entities']
      : ['measurement-uncertainty-evidence-invalid'],
    valid ? uncertainty!.sourceFactIds : [],
  );
}

function remoteWorkPowerBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
) {
  const transmission = subject.remoteWorkPowerBasis;
  const valid = Boolean(transmission
    && subject.desiredFunction === 'remote-work-power-delivery'
    && validateRemoteWorkPowerTransmissionBasis(
      state,
      owner,
      transmission,
      !subject.pressureBasis,
    ));
  const basis = makeBasis(
    subject,
    owner,
    atMonth,
    valid ? remoteWorkPowerPressure(transmission!) : 0,
    [
      `project:function:${subject.desiredFunction ?? 'unspecified'}`,
      `state:remote-work-power-basis:${valid ? transmission!.basisKey : 'invalid'}`,
      `state:personal-mechanical-services:${valid ? transmission!.mechanicalServiceEventIds.length : 0}`,
      `state:fixed-route-travel-legs:${valid ? transmission!.travelEventIds.length : 0}`,
      `state:fixed-route-distance:${valid ? transmission!.routeDistance : 0}`,
    ],
    valid
      ? ['repeated-personal-mechanical-service', 'repeated-fixed-route-burden', 'current-mechanical-source']
      : ['remote-work-power-evidence-invalid'],
    valid ? transmission!.sourceFactIds : [],
  );
  if (valid) basis.sourceFactIds = [...transmission!.sourceFactIds];
  return basis;
}

function developmentBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
  view: Required<ProjectPressureView>,
  inputContext?: ProjectPressureCompilationContext,
) {
  // The caller passes other visible people; the observer is still part of the
  // local resource and body pressure. Omitting the owner made development
  // pressure appear only after somebody else entered view.
  const visiblePeople = [
    owner,
    ...view.visiblePeople.filter((person) => person.id !== owner.id && isAlive(person)),
  ];
  const visiblePopulation = visiblePeople.length;
  const foodIds = new Set<MaterialId>([Material.Food, Material.CookedFood, Material.RawMeat]);
  const visibleFood = view.visibleDrops
    .filter((drop) => foodIds.has(drop.materialId))
    .reduce((sum, drop) => sum + drop.quantity, 0)
    + visiblePeople.reduce((sum, person) => sum + person.inventory
      .filter((stack) => foodIds.has(stack.materialId))
      .reduce((held, stack) => held + stack.quantity, 0), 0);
  const foodPerPerson = visibleFood / visiblePopulation;
  const hungryPeople = visiblePeople.filter((person) => person.body.nutrition < 45).length;
  const dehydratedPeople = visiblePeople.filter((person) => person.body.hydration < 45).length;
  const dependentPeople = visiblePeople.filter((person) => ageMonths(person, atMonth) < 16 * 12).length;
  const materialEvidence = buildLocalMaterialEvidence(state, owner, {
    visibleCells: view.visibleCells,
    visibleDrops: view.visibleDrops,
    visiblePeople,
  });
  const hasObserved = (...materialIds: MaterialId[]) => materialIds.some((materialId) => (
    materialEvidence.observedMaterialIds.has(materialId)
  ));
  const hasAccessiblePortable = (...materialIds: MaterialId[]) => materialIds.some((materialId) => (
    materialEvidence.accessiblePortableMaterialIds.has(materialId)
  ));
  const hasPlacedFacility = (...materialIds: MaterialId[]) => materialIds.some((materialId) => (
    materialEvidence.placedFacilityMaterialIds.has(materialId)
  ));
  const observedProductionToolRank = [...materialEvidence.accessiblePortableMaterialIds]
    .reduce((highest, materialId) => Math.max(highest, productionToolRank(materialId)), 0);
  const currentProductionToolRank = subject.desiredFunction === 'efficient-production'
    && typeof subject.productionToolBaselineRank === 'number'
    && Number.isFinite(subject.productionToolBaselineRank)
    ? Math.max(0, Math.floor(subject.productionToolBaselineRank))
    : observedProductionToolRank;
  const efficientProductionTargetRank = productionToolRank(Material.StoneHoe);
  const productionTool = currentProductionToolRank > 0;
  const pressureFacilities = [...materialEvidence.placedFacilityMaterialIds];
  const completedJointProjects = state.projects.filter((project) => project.status === 'completed'
    && project.contributorIds.includes(owner.id)
    && project.contributorIds.some((personId) => personId !== owner.id));
  const jointPartnerIds = new Set(completedJointProjects.flatMap((project) => (
    project.contributorIds.filter((personId) => personId !== owner.id)
  )));
  const sourceFactIds = resolvedProjectPressureCompilationContext(
    state,
    owner,
    atMonth,
    inputContext,
  ).rememberedSelection.developmentProvenance.map((event) => event.eventId);
  const commonEdges = [
    `project:function:${subject.desiredFunction ?? 'unspecified'}`,
    `state:visible-population:${visiblePopulation}`,
    `state:visible-food-per-person:${Math.round(foodPerPerson * 10) / 10}`,
    `state:hungry-people:${hungryPeople}`,
    `state:dehydrated-people:${dehydratedPeople}`,
    `state:dependent-people:${dependentPeople}`,
    `state:weather:${state.civilization.weather.kind}:${state.civilization.weather.intensity}`,
    `state:climate:${state.civilization.climate.kind}:${state.civilization.climate.severity}`,
    `state:visible-facilities:${pressureFacilities.sort((a, b) => a - b).join('.') || 'none'}`,
  ];

  if (subject.need === 'equipment-reliability') {
    if (subject.desiredFunction === 'restore-electrical-power-delivery') {
      const maintenance = subject.electricalPowerMaintenanceBasis;
      const valid = Boolean(maintenance
        && validateElectricalPowerMaintenanceBasis(state, owner, maintenance));
      return makeBasis(subject, owner, atMonth,
        valid ? electricalPowerMaintenancePressure(maintenance!) : 0,
        [
          `state:current-electrical-fault:${valid ? maintenance!.faultEventId : 'none'}`,
          `state:personal-electrical-diagnosis:${valid ? maintenance!.diagnosisEventId : 'none'}`,
          `project:function:${subject.desiredFunction}`,
        ],
        valid
          ? ['current-electrical-open-circuit', 'personal-electrical-fault-diagnosis']
          : ['electrical-maintenance-evidence-invalid'],
        valid ? maintenance!.sourceFactIds : []);
    }
    const reliability = subject.mechanicalReliabilityBasis;
    const valid = Boolean(reliability
      && subject.desiredFunction === 'durable-power-transmission'
      && validateMechanicalReliabilityBasis(state, owner, reliability, !subject.pressureBasis));
    const faults = valid ? reliability!.faults : [];
    const loadProofCount = faults.reduce((sum, fault) => sum + fault.loadedOperationEventIds.length, 0);
    return makeBasis(subject, owner, atMonth,
      valid ? 24 + faults.length * 24 + Math.min(24, loadProofCount * 4) : 0,
      [
        `state:repeated-worn-shaft-network:${valid ? reliability!.networkId : 'none'}`,
        `state:personal-worn-shaft-faults:${faults.map((fault) => fault.faultEventId).join('.') || 'none'}`,
        `state:personally-diagnosed-faults:${faults.map((fault) => fault.diagnosisEventId).join('.') || 'none'}`,
        `state:loaded-service-proof-count:${loadProofCount}`,
        `project:function:${subject.desiredFunction ?? 'unspecified'}`,
      ],
      valid
        ? ['same-network-repeated-worn-shaft', 'personal-fault-diagnoses', 'loaded-service-proof']
        : ['repeated-worn-shaft-evidence-invalid'],
      valid ? reliability!.sourceFactIds : []);
  }

  if (subject.need === 'mechanical-power-capability') {
    if (subject.desiredFunction === 'restore-water-powered-crop-processing') {
      const evidence = mechanicalPowerMaintenancePressureEvidence(state, owner);
      return makeBasis(subject, owner, atMonth,
        12 + (evidence.faultEventIds.length ? 38 : 0) + (evidence.diagnosisFactIds.length ? 48 : 0),
        [
          `state:experienced-mechanical-fault:${evidence.faultEventIds.join('.') || 'none'}`,
          `state:personal-mechanical-diagnosis:${evidence.diagnosisFactIds.join('.') || 'none'}`,
          `project:function:${subject.desiredFunction}`,
        ],
        [
          ...(evidence.faultEventIds.length ? ['experienced-mechanical-fault'] : ['experienced-mechanical-fault-missing']),
          ...(evidence.diagnosisFactIds.length ? ['personal-mechanical-diagnosis'] : ['personal-mechanical-diagnosis-missing']),
        ],
        evidence.sourceFactIds);
    }
    const evidence = mechanicalPowerPressureEvidence(state, owner);
    const millLaborFactIds = evidence.millLaborFactIds.slice(-3);
    const observationFactIds = evidence.observationFactIds.slice(-3);
    return makeBasis(subject, owner, atMonth,
      12 + (millLaborFactIds.length ? 34 : 0) + (observationFactIds.length ? 42 : 0),
      [
        `state:own-mill-labor:${millLaborFactIds.join('.') || 'none'}`,
        `state:personal-water-current-observation:${observationFactIds.join('.') || 'none'}`,
        `project:function:${subject.desiredFunction ?? 'unspecified'}`,
      ],
      [
        ...(millLaborFactIds.length ? ['own-mill-labor'] : ['own-mill-labor-missing']),
        ...(observationFactIds.length ? ['personal-water-current-observation'] : ['personal-water-current-observation-missing']),
      ],
      [...millLaborFactIds, ...observationFactIds]);
  }

  if (subject.need === 'production-efficiency') {
    const crowding = Math.max(0, visiblePopulation - 3);
    const shortage = Math.max(0, 2.5 - foodPerPerson);
    const productionToolAddressesFunction = currentProductionToolRank >= efficientProductionTargetRank
      && subject.desiredFunction === 'efficient-production';
    const upgradeGap = subject.desiredFunction === 'efficient-production'
      ? Math.max(0, efficientProductionTargetRank - currentProductionToolRank)
      : 0;
    const partialToolRelief = subject.desiredFunction === 'efficient-production'
      ? Math.min(10, currentProductionToolRank * 5)
      : 0;
    return makeBasis(subject, owner, atMonth,
      24 + crowding * 7 + shortage * 10 + hungryPeople * 9 + dependentPeople * 4
        - (productionToolAddressesFunction ? 28 : partialToolRelief),
      [
        ...commonEdges,
        `state:production-tool:${productionTool ? 'present' : 'absent'}`,
        `state:production-tool-rank:${currentProductionToolRank}`,
        `state:production-tool-target-rank:${efficientProductionTargetRank}`,
        `state:production-tool-upgrade-gap:${upgradeGap}`,
      ],
      [
        ...(crowding >= 2 ? ['visible-population-growth'] : []),
        ...(shortage > 0 ? ['visible-food-pressure'] : []),
        ...(hungryPeople ? ['visible-hunger'] : []),
        ...(dependentPeople ? ['visible-dependent-load'] : []),
        ...(productionTool
          ? [productionToolAddressesFunction ? 'production-tool-sufficient-rank' : 'production-tool-upgrade-needed']
          : ['production-tool-absent']),
      ], sourceFactIds);
  }
  if (subject.need === 'reserve-security') {
    const hasGranary = hasPlacedFacility(Material.Granary);
    const weatherRisk = state.civilization.weather.kind === 'storm' || state.civilization.climate.severity >= 3;
    const visibleReserveSurplus = Math.max(0, visibleFood - visiblePopulation * 2);
    return makeBasis(subject, owner, atMonth,
      18 + Math.min(30, visibleReserveSurplus * 6) + Math.max(0, visiblePopulation - 4) * 4
        + dependentPeople * 3 + (weatherRisk ? 18 : 0) - (hasGranary ? 35 : 0),
      [...commonEdges, `state:visible-reserve-surplus:${visibleReserveSurplus}`, `state:granary:${hasGranary ? 'present' : 'absent'}`],
      [
        ...(visibleReserveSurplus > 0 ? ['visible-storable-surplus'] : []),
        ...(dependentPeople ? ['visible-dependent-load'] : []),
        ...(weatherRisk ? ['external-environment-risk'] : []),
        ...(hasGranary ? ['granary-present'] : ['granary-absent']),
      ], sourceFactIds);
  }
  if (subject.need === 'water-security') {
    const hasCistern = hasPlacedFacility(Material.Cistern);
    const heatRisk = state.civilization.climate.kind === 'heat' || state.civilization.climate.kind === 'fire';
    return makeBasis(subject, owner, atMonth,
      18 + dehydratedPeople * 18 + (heatRisk ? 26 : 0) + Math.max(0, visiblePopulation - 5) * 4 - (hasCistern ? 40 : 0),
      [...commonEdges, `state:cistern:${hasCistern ? 'present' : 'absent'}`],
      [
        ...(dehydratedPeople ? ['visible-dehydration'] : []),
        ...(heatRisk ? ['external-heat-or-fire-pressure'] : []),
        ...(hasCistern ? ['cistern-present'] : ['cistern-absent']),
      ], sourceFactIds);
  }
  if (subject.need === 'coordination-capacity') {
    const hasCore = hasPlacedFacility(Material.CouncilHearth, Material.CivicHall, Material.KeepCore);
    const jointProjectPressure = Math.min(2, completedJointProjects.length) * 12;
    const jointPartnerPressure = Math.min(2, jointPartnerIds.size) * 4;
    return makeBasis(subject, owner, atMonth,
      18 + Math.max(0, visiblePopulation - 3) * 8 + jointProjectPressure + jointPartnerPressure - (hasCore ? 32 : 0),
      [
        ...commonEdges,
        `state:completed-joint-projects:${completedJointProjects.length}`,
        `state:joint-project-partners:${jointPartnerIds.size}`,
        `state:coordination-core:${hasCore ? 'present' : 'absent'}`,
      ],
      [
        ...(visiblePopulation >= 5 ? ['visible-coordination-load'] : []),
        ...(completedJointProjects.length ? ['joint-project-experience'] : []),
        ...(completedJointProjects.length >= 2 ? ['repeated-joint-projects'] : []),
        ...(hasCore ? ['coordination-core-present'] : ['coordination-core-absent']),
      ], sourceFactIds);
  }
  if (subject.need === 'high-heat-capability') {
    const hasFeedstock = hasObserved(Material.Clay, Material.CopperOre, Material.TinOre, Material.IronOre);
    const hasKiln = hasPlacedFacility(Material.Kiln, Material.Foundry, Material.Smithy);
    return makeBasis(subject, owner, atMonth,
      22 + (hasFeedstock ? 40 : 0) + Math.max(0, visiblePopulation - 5) * 4 - (hasKiln ? 28 : 0),
      [...commonEdges, `state:heat-feedstock:${hasFeedstock ? 'present' : 'absent'}`, `state:high-heat-site:${hasKiln ? 'present' : 'absent'}`],
      [
        ...(hasFeedstock ? ['visible-heat-feedstock'] : []),
        ...(hasKiln ? ['high-heat-site-present'] : ['high-heat-site-absent']),
      ], sourceFactIds);
  }
  if (subject.need === 'alloy-capability') {
    const copperEvidence = hasObserved(Material.CopperOre, Material.CopperCharge, Material.Copper);
    const tinEvidence = hasObserved(Material.TinOre, Material.TinCharge, Material.Tin);
    const bronzeMaterial = hasObserved(Material.Bronze);
    const bronzeTool = hasAccessiblePortable(Material.BronzeTool);
    const bronzeEvidence = bronzeMaterial || bronzeTool;
    if (subject.desiredFunction === 'bronze-tooling') {
      return makeBasis(subject, owner, atMonth,
        20 + (bronzeMaterial ? 28 : 0) + Math.max(0, visiblePopulation - 4) * 4 - (bronzeTool ? 36 : 0),
        [...commonEdges, `state:bronze-material:${bronzeMaterial}`, `state:bronze-tool:${bronzeTool}`],
        [
          ...(bronzeMaterial ? ['bronze-ready-for-tooling'] : ['bronze-material-missing']),
          ...(bronzeTool ? ['bronze-tool-present'] : ['bronze-tool-absent']),
        ], sourceFactIds);
    }
    if (subject.desiredFunction === 'bronze-workshop') {
      const foundry = hasPlacedFacility(Material.Foundry);
      return makeBasis(subject, owner, atMonth,
        20 + (bronzeMaterial ? 28 : 0) + Math.max(0, visiblePopulation - 5) * 3 - (foundry ? 36 : 0),
        [...commonEdges, `state:bronze-material:${bronzeMaterial}`, `state:foundry:${foundry}`],
        [
          ...(bronzeMaterial ? ['bronze-ready-for-workshop'] : ['bronze-material-missing']),
          ...(foundry ? ['foundry-present'] : ['foundry-absent']),
        ], sourceFactIds);
    }
    return makeBasis(subject, owner, atMonth,
      20 + (copperEvidence ? 24 : 0) + (tinEvidence ? 24 : 0) + Math.max(0, visiblePopulation - 6) * 3 - (bronzeEvidence ? 26 : 0),
      [...commonEdges, `state:copper-evidence:${copperEvidence}`, `state:tin-evidence:${tinEvidence}`, `state:bronze-evidence:${bronzeEvidence}`],
      [
        ...(copperEvidence ? ['visible-copper-chain'] : []),
        ...(tinEvidence ? ['visible-tin-chain'] : []),
        ...(bronzeEvidence ? ['bronze-produced'] : ['bronze-not-yet-produced']),
      ], sourceFactIds);
  }
  const ironEvidence = hasObserved(Material.IronOre, Material.IronCharge, Material.IronBloom, Material.Iron, Material.IronTool);
  const smithy = hasPlacedFacility(Material.Smithy);
  return makeBasis(subject, owner, atMonth,
    18 + (ironEvidence ? 44 : 0) + Math.max(0, visiblePopulation - 7) * 4 - (smithy ? 18 : 0),
    [...commonEdges, `state:iron-evidence:${ironEvidence}`, `state:smithy:${smithy ? 'present' : 'absent'}`],
    [
      ...(ironEvidence ? ['visible-iron-chain'] : []),
      ...(smithy ? ['smithy-present'] : ['smithy-absent']),
    ], sourceFactIds);
}

export function buildProjectPressureBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
  inputView: ProjectPressureView = {},
  compilationContext?: ProjectPressureCompilationContext,
): ProjectPressureBasis {
  if (subject.need === 'remote-work-power') {
    return remoteWorkPowerBasis(state, owner, subject, atMonth);
  }
  const view = resolvedView(state, owner, inputView);
  if (subject.need === 'thermal-safety') return thermalBasis(state, owner, subject, atMonth);
  if (subject.need === 'hunting-safety') {
    return huntingBasis(state, owner, subject, atMonth, view, compilationContext);
  }
  if (subject.need === 'care-capability') return careBasis(owner, subject, atMonth, view);
  if (subject.need === 'food-preparation') return foodBasis(owner, subject, atMonth, view);
  if (subject.need === 'shelter-capacity') return shelterBasis(state, owner, subject, atMonth, view);
  if (subject.need === 'knowledge-preservation') {
    return knowledgeBasis(state, owner, subject, atMonth, compilationContext);
  }
  if (subject.need === 'measurement-uncertainty') {
    return measurementComparisonBasis(state, owner, subject, atMonth);
  }
  return developmentBasis(state, owner, subject, atMonth, view, compilationContext);
}

export function projectPressureReasonPresent(basis: ProjectPressureBasis, reason: string): boolean {
  return basis.reasonKeys.includes(reason);
}
