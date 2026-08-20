import { animalSpecies, isAnimalAlive } from '../domain/animal';
import { Material, materialHas, type MaterialId } from '../domain/material';
import type { DropState, SimulationState, WorldEvent } from '../domain/model';
import type { PersonState } from '../domain/person';
import { ageMonths, inventoryQuantity, isAlive } from '../domain/person';
import type { ProjectPressureBasis, ProjectProposal } from '../domain/project';
import { shelterGeometryAt } from '../domain/structure';
import { worldEventById, worldEventsByIdsInHistoryOrder } from '../domain/event-index';
import { cellsInRadius } from '../world/grid';
import { personalityScore } from '../domain/personality';
import { buildLocalMaterialEvidence } from './local-material-evidence';
import { mechanicalPowerPressureEvidence } from './mechanical-power-options';

export const PROJECT_PRESSURE_BASIS_VERSION = 'project-pressure-basis-v1' as const;

export type ProjectPressureSubject = Pick<
  ProjectProposal,
  'need' | 'beneficiaryIds' | 'createdAtMonth' | 'targetKnowledgeId' | 'shelterRequirement' | 'pressureBasis'
> & { desiredFunction?: ProjectProposal['desiredFunction'] };

export interface ProjectPressureView {
  visibleCells?: number[];
  visibleDrops?: DropState[];
  visiblePeople?: PersonState[];
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

function rememberedSourceIds(person: PersonState): Set<string> {
  return new Set([
    ...person.memories.flatMap((memory) => memory.sourceEventIds),
    ...person.conditions.flatMap((condition) => condition.sourceEventIds),
    ...person.knowledge.flatMap((fact) => fact.sourceEventIds),
    ...person.inventory.flatMap((stack) => stack.sourceEventIds),
  ]);
}

function priorPersistentEdges(subject: ProjectPressureSubject, prefix: string): string[] {
  return subject.pressureBasis?.edgeKeys.filter((key) => key.startsWith(prefix)) ?? [];
}

function priorPersistentSources(state: SimulationState, subject: ProjectPressureSubject, predicate: (event: WorldEvent) => boolean): string[] {
  return subject.pressureBasis?.sourceFactIds.filter((id) => {
    const event = worldEventById(state, id);
    return Boolean(event && predicate(event));
  }) ?? [];
}

function retainedEvents(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
): WorldEvent[] {
  return worldEventsByIdsInHistoryOrder(state, [
    ...rememberedSourceIds(owner),
    ...(subject.pressureBasis?.sourceFactIds ?? []),
  ]);
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

function huntingBasis(state: SimulationState, owner: PersonState, subject: ProjectPressureSubject, atMonth: number, view: Required<ProjectPressureView>) {
  const failureEdges = new Map<string, string>();
  const attackEdges = new Map<string, string>();
  for (const event of retainedEvents(state, owner, subject)) {
    if (event.atMonth > atMonth) continue;
    if (event.kind === 'action'
      && event.who === owner.id
      && event.action.kind === 'act'
      && event.action.operation === 'hunt'
      && event.diff.killed !== true) {
      const animalId = typeof event.diff.animalId === 'string' ? event.diff.animalId : 'unknown';
      failureEdges.set(`event:hunt-failure:${event.atMonth}:${animalId}`, event.id);
    }
    if (event.kind === 'environment'
      && event.change === 'animal'
      && event.diff.process === 'attack-human'
      && event.diff.victimId === owner.id) {
      attackEdges.set(`event:animal-attack:${event.id}`, event.id);
    }
  }
  for (const key of priorPersistentEdges(subject, 'event:hunt-failure:')) if (!failureEdges.has(key)) failureEdges.set(key, '');
  for (const key of priorPersistentEdges(subject, 'event:animal-attack:')) if (!attackEdges.has(key)) attackEdges.set(key, '');
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
    ...[...failureEdges.values()].filter(Boolean),
    ...[...attackEdges.values()].filter(Boolean),
    ...priorPersistentSources(state, subject, (event) => event.kind === 'action'
      ? event.who === owner.id && event.action.kind === 'act' && event.action.operation === 'hunt'
      : event.kind === 'environment' && event.change === 'animal' && event.diff.victimId === owner.id),
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

function knowledgeBasis(state: SimulationState, owner: PersonState, subject: ProjectPressureSubject, atMonth: number) {
  const target = subject.targetKnowledgeId
    ? owner.knowledge.find((fact) => fact.id === subject.targetKnowledgeId)
    : undefined;
  const disruptions = new Map<string, string>();
  for (const event of retainedEvents(state, owner, subject)) {
    if (event.atMonth > atMonth) continue;
    if (event.kind === 'action'
      && event.who === owner.id
      && event.status === 'completed'
      && event.action.kind === 'act'
      && event.action.operation === 'dehydrate') disruptions.set(`event:personal-dehydration:${event.id}`, event.id);
  }
  for (const key of priorPersistentEdges(subject, 'event:personal-dehydration:')) if (!disruptions.has(key)) disruptions.set(key, '');
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
    ...[...disruptions.values()].filter(Boolean),
    ...priorPersistentSources(state, subject, (event) => event.kind === 'action'
      && event.who === owner.id
      && event.action.kind === 'act'
      && event.action.operation === 'dehydrate'),
  ]);
}

function developmentBasis(
  state: SimulationState,
  owner: PersonState,
  subject: ProjectPressureSubject,
  atMonth: number,
  view: Required<ProjectPressureView>,
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
  const productionTool = hasAccessiblePortable(Material.WoodTool, Material.StoneHoe, Material.BronzeTool, Material.IronTool);
  const pressureFacilities = [...materialEvidence.placedFacilityMaterialIds];
  const completedJointProjects = state.projects.filter((project) => project.status === 'completed'
    && project.contributorIds.includes(owner.id)
    && project.contributorIds.some((personId) => personId !== owner.id));
  const jointPartnerIds = new Set(completedJointProjects.flatMap((project) => (
    project.contributorIds.filter((personId) => personId !== owner.id)
  )));
  const remembered = rememberedSourceIds(owner);
  const sourceFactIds = worldEventsByIdsInHistoryOrder(state, remembered)
    .filter((event) => event.atMonth <= atMonth
      && (event.kind === 'environment'
        || (event.kind === 'action' && event.status === 'completed')))
    .slice(-24)
    .map((event) => event.id);
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

  if (subject.need === 'mechanical-power-capability') {
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
    const productionToolAddressesFunction = productionTool
      && subject.desiredFunction === 'efficient-production';
    return makeBasis(subject, owner, atMonth,
      24 + crowding * 7 + shortage * 10 + hungryPeople * 9 + dependentPeople * 4
        - (productionToolAddressesFunction ? 28 : 0),
      [...commonEdges, `state:production-tool:${productionTool ? 'present' : 'absent'}`],
      [
        ...(crowding >= 2 ? ['visible-population-growth'] : []),
        ...(shortage > 0 ? ['visible-food-pressure'] : []),
        ...(hungryPeople ? ['visible-hunger'] : []),
        ...(dependentPeople ? ['visible-dependent-load'] : []),
        ...(productionTool
          ? [productionToolAddressesFunction ? 'production-tool-present' : 'production-tool-not-sufficient-for-function']
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
): ProjectPressureBasis {
  const view = resolvedView(state, owner, inputView);
  if (subject.need === 'thermal-safety') return thermalBasis(state, owner, subject, atMonth);
  if (subject.need === 'hunting-safety') return huntingBasis(state, owner, subject, atMonth, view);
  if (subject.need === 'care-capability') return careBasis(owner, subject, atMonth, view);
  if (subject.need === 'food-preparation') return foodBasis(owner, subject, atMonth, view);
  if (subject.need === 'shelter-capacity') return shelterBasis(state, owner, subject, atMonth, view);
  if (subject.need === 'knowledge-preservation') return knowledgeBasis(state, owner, subject, atMonth);
  return developmentBasis(state, owner, subject, atMonth, view);
}

export function projectPressureReasonPresent(basis: ProjectPressureBasis, reason: string): boolean {
  return basis.reasonKeys.includes(reason);
}
