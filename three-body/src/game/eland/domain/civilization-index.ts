import type { ActionFact, CivilizationIndex, SimulationState } from './model';
import { Material } from './material';
import { isAlive } from './person';
import { observeFunctionalBuildings, observeMaterialCapabilities } from './era-progression';
import {
  WORLD_CELL_COUNT,
  cellId,
  isCellId,
  neighbors4,
  voxelAt,
} from '../world/grid';

const WEIGHTS = {
  population: 1,
  territory: 1,
  technology: 1,
  social: 1,
  history: 1,
} as const;

// Experiment toggles. Baseline and candidate builds differ only here; these
// observer flags must never be read by planners or world rules.
const USE_FUNCTIONAL_TERRITORY = true;
const FILTER_SOCIAL_SELF_DYADS = true;
export const CIVILIZATION_INDEX_FORMULA_VERSION = 'open-material-institution-v1';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function rounded(value: number): number {
  return Math.round(clamp(value) * 100) / 100;
}

function roundedOpen(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function saturating(count: number, scale: number): number {
  return 100 * (1 - Math.exp(-Math.max(0, count) / scale));
}

function pairKey(first: string, second: string): string {
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function connectedCellComponents(cells: Set<number>): number[][] {
  const remaining = new Set(cells);
  const result: number[][] = [];
  while (remaining.size) {
    const origin = remaining.values().next().value as number;
    const queue = [origin];
    const component: number[] = [];
    remaining.delete(origin);
    while (queue.length) {
      const current = queue.shift();
      if (current === undefined) break;
      component.push(current);
      for (const neighbor of neighbors4(current)) {
        if (!remaining.delete(neighbor)) continue;
        queue.push(neighbor);
      }
    }
    result.push(component);
  }
  return result;
}

function targetVoxel(event: ActionFact): { x: number; y: number; z: number } | null {
  if (event.action.kind !== 'act') return null;
  const target = event.action.targets.find((candidate) => candidate.kind === 'voxel');
  return target?.kind === 'voxel' ? target.position : null;
}

function eventPosition(event: ActionFact): { x: number; y: number; z: number } | null {
  const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if ([position?.x, position?.y, position?.z].every((value) => Number.isInteger(Number(value)))) {
    return { x: Number(position?.x), y: Number(position?.y), z: Number(position?.z) };
  }
  return targetVoxel(event);
}

function actionCell(event: ActionFact): number | null {
  const position = eventPosition(event);
  if (!position) return isCellId(event.cellId) ? event.cellId : null;
  const result = cellId(position.x, position.y);
  return isCellId(result) ? result : null;
}

function currentHumanModifiedCells(state: SimulationState, actions: ActionFact[]): Set<number> {
  const result = new Set<number>();
  const latestMaterialChange = new Map<string, {
    cell: number;
    z: number;
    to: number;
    action: ActionFact | null;
  }>();
  for (const event of state.world.past) {
    if (!('diff' in event)) continue;
    const changes = Array.isArray(event.diff.materialChanges) ? event.diff.materialChanges : [];
    for (const raw of changes) {
      if (!raw || typeof raw !== 'object') continue;
      const change = raw as { cellId?: unknown; z?: unknown; to?: unknown };
      const changedCell = Number(change.cellId);
      const z = Number(change.z);
      const to = Number(change.to);
      if (!isCellId(changedCell) || !Number.isInteger(z) || !Number.isInteger(to)) continue;
      latestMaterialChange.set(`${changedCell}:${z}`, {
        cell: changedCell,
        z,
        to,
        action: event.kind === 'action' ? event : null,
      });
    }
  }
  for (const change of latestMaterialChange.values()) {
    if (!change.action || (change.action.status !== 'completed' && change.action.status !== 'progressed')) continue;
    const x = change.cell % state.world.grid.width;
    const y = Math.floor(change.cell / state.world.grid.width);
    if (voxelAt(state.world.grid, x, y, change.z) === change.to) result.add(change.cell);
  }
  for (const event of actions) {
    if (event.status !== 'completed' || event.action.kind !== 'act') continue;
    const position = eventPosition(event);
    if (!position) continue;
    const currentMaterial = voxelAt(state.world.grid, position.x, position.y, position.z);
    const expected = event.action.operation === 'separate'
      ? Number(event.diff.replacementMaterialId)
      : event.action.operation === 'combine' ? Number(event.diff.outputMaterialId) : Number.NaN;
    if (Number.isInteger(expected) && currentMaterial === expected) result.add(cellId(position.x, position.y));
  }
  return result;
}

function actionCells(event: ActionFact): number[] {
  const cells = new Set<number>();
  if (isCellId(event.cellId)) cells.add(event.cellId);
  event.pathSegment.filter(isCellId).forEach((cell) => cells.add(cell));
  const target = actionCell(event);
  if (target !== null) cells.add(target);
  return [...cells];
}

function legacyTerritoryObservation(state: SimulationState, actions: ActionFact[]): { score: number; evidence: Record<string, number> } {
  const exploredCells = new Set<number>();
  const modifiedCells = new Set<number>();
  for (const person of state.people) {
    exploredCells.add(person.position.cellId);
    exploredCells.add(person.position.previousCellId);
    for (const place of person.knownPlaces) exploredCells.add(cellId(place.position.x, place.position.y));
  }
  for (const key of Object.keys(state.world.traffic ?? {})) exploredCells.add(Number(key.split(':')[0]));
  for (const event of actions) {
    exploredCells.add(event.cellId);
    event.pathSegment.forEach((cell) => exploredCells.add(cell));
    const changes = Array.isArray(event.diff.materialChanges) ? event.diff.materialChanges : [];
    for (const raw of changes) {
      if (!raw || typeof raw !== 'object') continue;
      const changedCell = Number((raw as { cellId?: unknown }).cellId);
      if (Number.isInteger(changedCell)) modifiedCells.add(changedCell);
    }
    const position = event.diff.position as { x?: unknown; y?: unknown } | undefined;
    if (Number.isInteger(Number(position?.x)) && Number.isInteger(Number(position?.y))) {
      modifiedCells.add(cellId(Number(position?.x), Number(position?.y)));
    }
  }
  state.derived.structures.forEach((structure) => structure.occupiedCells.forEach((cell) => modifiedCells.add(cell)));
  const explorationCoverage = exploredCells.size / WORLD_CELL_COUNT;
  const modificationCoverage = modifiedCells.size / WORLD_CELL_COUNT;
  const explorationScore = clamp(explorationCoverage / 0.35 * 100);
  const modificationScore = clamp(modificationCoverage / 0.05 * 100);
  return {
    score: explorationScore * 0.5 + modificationScore * 0.5,
    evidence: {
      exploredCells: exploredCells.size,
      modifiedCells: modifiedCells.size,
      explorationCoverage: rounded(explorationCoverage * 100),
      modificationCoverage: rounded(modificationCoverage * 100),
    },
  };
}

export function emptyCivilizationIndex(atMonth = 0): CivilizationIndex {
  const component = (weight: number) => ({ score: 0, weight, evidence: {} });
  return {
    formulaVersion: CIVILIZATION_INDEX_FORMULA_VERSION,
    total: 0,
    calculatedAtMonth: atMonth,
    components: {
      population: component(WEIGHTS.population),
      territory: component(WEIGHTS.territory),
      technology: component(WEIGHTS.technology),
      social: component(WEIGHTS.social),
      history: component(WEIGHTS.history),
    },
  };
}

/**
 * Pure observer over authoritative state. It never grants abilities or changes
 * outcomes; every subscore is backed by replayable facts.
 */
export function calculateCivilizationIndex(state: SimulationState): CivilizationIndex {
  const living = state.people.filter(isAlive);

  const actions = state.world.past.filter((event): event is ActionFact => event.kind === 'action');
  const territoryObservation = USE_FUNCTIONAL_TERRITORY ? (() => {
    const livingIds = new Set(living.map((person) => person.id));
  const cognitiveCells = new Set<number>();
  for (const person of living) {
    cognitiveCells.add(person.position.cellId);
    cognitiveCells.add(person.position.previousCellId);
    for (const place of person.knownPlaces) cognitiveCells.add(cellId(place.position.x, place.position.y));
  }
  for (const event of actions) {
    if (!livingIds.has(event.who) || event.status === 'blocked' || event.status === 'failed') continue;
    actionCells(event).forEach((cell) => cognitiveCells.add(cell));
  }

  const functionalStructures = state.derived.structures.filter((structure) => structure.complete
    && structure.capacity > 0
    && (structure.weatherProtection > 0 || structure.thermalInsulation > 0));
  const incompleteStructureCells = new Set(state.derived.structures
    .filter((structure) => !structure.complete)
    .flatMap((structure) => structure.occupiedCells));
  const functionalStructureCells = new Set(functionalStructures.flatMap((structure) => structure.occupiedCells));
  const standingContainers = state.containers.filter((container) => voxelAt(
    state.world.grid, container.position.x, container.position.y, container.position.z,
  ) === Material.Container || voxelAt(
    state.world.grid, container.position.x, container.position.y, container.position.z,
  ) === Material.Granary);
  const standingContainerIds = new Set(standingContainers.map((container) => container.id));
  const containerCellsById = new Map(standingContainers.map((container) => [container.id, cellId(container.position.x, container.position.y)]));
  const cultivatedCells = new Set(state.derived.regions
    .filter((region) => region.kind === 'cultivated')
    .flatMap((region) => region.cells));
  const trailCells = new Set(state.derived.regions
    .filter((region) => region.kind === 'trail')
    .flatMap((region) => region.cells));
  const functionalCells = new Set<number>([
    ...functionalStructureCells,
    ...containerCellsById.values(),
    ...cultivatedCells,
  ]);
  functionalCells.forEach((cell) => cognitiveCells.add(cell));

  const persistentModifiedCells = currentHumanModifiedCells(state, actions);
  state.derived.structures.forEach((structure) => structure.occupiedCells.forEach((cell) => persistentModifiedCells.add(cell)));
  standingContainers.forEach((container) => persistentModifiedCells.add(cellId(container.position.x, container.position.y)));
  cultivatedCells.forEach((cell) => persistentModifiedCells.add(cell));
  const traceCells = new Set([...persistentModifiedCells].filter((cell) => !functionalCells.has(cell) && !incompleteStructureCells.has(cell)));

  const usedContainerIds = new Set<string>();
  for (const event of actions) {
    if (event.status !== 'completed' || event.action.kind !== 'transfer') continue;
    if (event.action.from.kind === 'container' && standingContainerIds.has(event.action.from.containerId)) usedContainerIds.add(event.action.from.containerId);
    if (event.action.to.kind === 'container' && standingContainerIds.has(event.action.to.containerId)) usedContainerIds.add(event.action.to.containerId);
  }
  const storedUnits = standingContainers.reduce((sum, container) => sum
    + container.inventory.reduce((inventorySum, stack) => inventorySum + stack.quantity, 0), 0);
  const shelterCapacity = functionalStructures.reduce((sum, structure) => sum + structure.capacity, 0);
  const shelterProtectionUnits = functionalStructures.reduce((sum, structure) => sum
    + structure.capacity * (structure.weatherProtection + structure.thermalInsulation) / 200, 0);
  const functionalCapacityUnits = shelterCapacity * 1.5
    + shelterProtectionUnits
    + standingContainers.length * 1.5
    + usedContainerIds.size * 1.5
    + Math.min(storedUnits, 48) / 12
    + cultivatedCells.size / 8;

  // A few isolated crop cells are useful capacity, but not yet a functioning
  // settlement. Only a contiguous cultivated patch can anchor a site on its
  // own; complete structures and standing containers always can.
  const cultivatedSiteCells = new Set(connectedCellComponents(cultivatedCells)
    .filter((component) => component.length >= 4)
    .flat());
  const functionalSiteAnchorCells = new Set<number>([
    ...functionalStructureCells,
    ...containerCellsById.values(),
    ...cultivatedSiteCells,
  ]);
  const functionalSiteComponents = connectedCellComponents(functionalSiteAnchorCells);
  const functionalSiteByCell = new Map<number, number>();
  functionalSiteComponents.forEach((component, index) => component.forEach((cell) => functionalSiteByCell.set(cell, index)));
  const eventMonthById = new Map(state.world.past.map((event) => [event.id, event.atMonth]));
  const siteEstablishmentMonths = functionalSiteComponents.map(() => state.clock.elapsedMonths);
  const establishSite = (cell: number, month: number): void => {
    const index = functionalSiteByCell.get(cell);
    if (index !== undefined) siteEstablishmentMonths[index] = Math.min(siteEstablishmentMonths[index], month);
  };
  for (const structure of functionalStructures) {
    const sourceMonths = structure.sourceEventIds.map((id) => eventMonthById.get(id)).filter((month): month is number => month !== undefined);
    if (!sourceMonths.length) continue;
    const establishedAt = Math.max(...sourceMonths);
    structure.occupiedCells.forEach((cell) => establishSite(cell, establishedAt));
  }
  for (const container of standingContainers) establishSite(cellId(container.position.x, container.position.y), container.createdAtMonth);
  for (const region of state.derived.regions) {
    if (region.kind !== 'cultivated') continue;
    region.cells.forEach((cell) => establishSite(cell, region.firstObservedMonth));
  }
  const siteUsageMonths = functionalSiteComponents.map(() => new Set<number>());
  for (const event of actions) {
    if (event.status !== 'completed' || event.action.kind === 'move') continue;
    if (event.action.kind === 'act' && event.action.operation === 'combine'
      && [Material.Plank, Material.Container, Material.CropSprout]
        .some((materialId) => materialId === Number(event.diff.outputMaterialId))) continue;
    const touchedSites = new Set(actionCells(event).flatMap((cell) => {
      const index = functionalSiteByCell.get(cell);
      return index === undefined ? [] : [index];
    }));
    if (event.action.kind === 'transfer') {
      const containerId = event.action.from.kind === 'container' ? event.action.from.containerId
        : event.action.to.kind === 'container' ? event.action.to.containerId : undefined;
      const containerCell = containerId ? containerCellsById.get(containerId) : undefined;
      const containerSite = containerCell === undefined ? undefined : functionalSiteByCell.get(containerCell);
      if (containerSite !== undefined) touchedSites.add(containerSite);
    }
    touchedSites.forEach((index) => {
      if (event.atMonth >= siteEstablishmentMonths[index]) siteUsageMonths[index].add(event.atMonth);
    });
  }
  for (const person of living) {
    const index = functionalSiteByCell.get(person.position.cellId);
    if (index !== undefined) siteUsageMonths[index].add(state.clock.elapsedMonths);
  }
  const sustainedFunctionalSites = functionalSiteComponents.filter((_, index) => {
    const months = [...siteUsageMonths[index]].sort((left, right) => left - right);
    return state.clock.elapsedMonths - siteEstablishmentMonths[index] >= 12
      && months.length >= 2
      && (months.at(-1) ?? 0) - (months[0] ?? 0) >= 6;
  }).length;

  const recentRouteMonths = new Map<number, Set<number>>();
  const routeComponents = connectedCellComponents(trailCells).filter((component) => component.length >= 4);
  const routeByCell = new Map<number, number>();
  routeComponents.forEach((component, index) => component.forEach((cell) => routeByCell.set(cell, index)));
  const routeLinkedSites = routeComponents.map((component) => new Set(component.flatMap((cell) => [cell, ...neighbors4(cell)])
    .flatMap((cell) => {
      const index = functionalSiteByCell.get(cell);
      return index === undefined ? [] : [index];
    })));
  for (const event of actions) {
    if (event.action.kind !== 'move' || event.status === 'blocked' || event.status === 'failed'
      || event.atMonth < state.clock.elapsedMonths - 36) continue;
    const touchedRoutes = new Set(event.pathSegment.flatMap((cell) => {
      const index = routeByCell.get(cell);
      return index === undefined ? [] : [index];
    }));
    touchedRoutes.forEach((index) => {
      const months = recentRouteMonths.get(index) ?? new Set<number>();
      months.add(event.atMonth);
      recentRouteMonths.set(index, months);
    });
  }
  const logisticsRoutes = routeComponents.filter((_, index) => routeLinkedSites[index].size >= 2
    && (recentRouteMonths.get(index)?.size ?? 0) >= 3).length;

  const cognitiveCoverage = cognitiveCells.size / WORLD_CELL_COUNT;
  const cognitiveScore = clamp(cognitiveCoverage / 0.35 * 100);
  const persistentTraceScore = saturating(traceCells.size, 120);
  const constructionProgressScore = saturating(incompleteStructureCells.size, 60);
  const functionalCapacityScore = saturating(functionalCapacityUnits, 20);
  const networkScore = saturating(sustainedFunctionalSites + logisticsRoutes * 2, 14);
  const infrastructureScore = persistentTraceScore * 0.1
    + constructionProgressScore * 0.1
    + functionalCapacityScore * 0.55
    + networkScore * 0.25;
  const rawTerritoryScore = cognitiveScore * 0.55 + infrastructureScore * 0.45;
  const territoryCap = functionalSiteComponents.length === 0 ? 25
    : sustainedFunctionalSites < 2 && logisticsRoutes === 0 ? 55 : 100;
  const functionalTerritoryScore = Math.min(rawTerritoryScore, territoryCap);
  const functionalTerritoryEvidence: Record<string, number> = {
    cognitiveCells: cognitiveCells.size,
    cognitiveCoverage: rounded(cognitiveCoverage * 100),
    persistentModifiedCells: persistentModifiedCells.size,
    traceCells: traceCells.size,
    trailCells: trailCells.size,
    incompleteStructureCells: incompleteStructureCells.size,
    functionalStructureCells: functionalStructureCells.size,
    functionalStructures: functionalStructures.length,
    shelterCapacity,
    standingContainers: standingContainers.length,
    usedContainers: usedContainerIds.size,
    storedUnits,
    cultivatedCells: cultivatedCells.size,
    cultivatedSiteCells: cultivatedSiteCells.size,
    functionalSites: functionalSiteComponents.length,
    sustainedFunctionalSites,
    logisticsRoutes,
    cognitiveScore: rounded(cognitiveScore),
    persistentTraceScore: rounded(persistentTraceScore),
    constructionProgressScore: rounded(constructionProgressScore),
    functionalCapacityScore: rounded(functionalCapacityScore),
    networkScore: rounded(networkScore),
    infrastructureScore: rounded(infrastructureScore),
    rawTerritoryScore: rounded(rawTerritoryScore),
    territoryCap,
  };
    return { score: functionalTerritoryScore, evidence: functionalTerritoryEvidence };
  })() : legacyTerritoryObservation(state, actions);
  const territoryScore = territoryObservation.score;

  const confidentTechniques = new Set(state.people.flatMap((person) => person.knowledge
    .filter((fact) => fact.kind === 'technique' && fact.confidence >= 55)
    .map((fact) => fact.id)));
  for (const record of state.records) {
    if (record.kind === 'technique') confidentTechniques.add(record.knowledgeId);
  }
  const realizedProcesses = new Set<string>();
  for (const event of state.world.past) {
    if (event.kind !== 'action' || event.status !== 'completed' || event.action.kind !== 'act') continue;
    if (!['combine', 'separate', 'exert', 'expose', 'hunt'].includes(event.action.operation)) continue;
    realizedProcesses.add(`${event.action.operation}:${String(event.diff.outputMaterialId ?? event.diff.sourceMaterialId ?? event.diff.animalSpeciesId ?? 'none')}`);
  }
  const adultLiving = living.filter((person) => state.clock.elapsedMonths - person.bornAtMonth >= 12 * 12);
  const techniqueDiffusion = confidentTechniques.size && adultLiving.length
    ? [...confidentTechniques].reduce((sum, techniqueId) => sum
      + adultLiving.filter((person) => person.knowledge.some((fact) => fact.id === techniqueId && fact.confidence >= 55)).length / adultLiving.length, 0)
      / confidentTechniques.size * 100
    : 0;
  const technologyScore = saturating(confidentTechniques.size, 8) * 0.5
    + saturating(realizedProcesses.size, 7) * 0.3
    + techniqueDiffusion * 0.2;

  const historicalPeople = state.people.filter((person) => person.bornAtMonth <= state.clock.elapsedMonths);
  const possibleDyads = Math.max(1, historicalPeople.length * (historicalPeople.length - 1) / 2);
  const relationDyads = new Set<string>();
  for (const person of historicalPeople) {
    for (const relation of person.relations) {
      if (FILTER_SOCIAL_SELF_DYADS && relation.personId === person.id) continue;
      if (!historicalPeople.some((candidate) => candidate.id === relation.personId)) continue;
      if (relation.sourceEventIds.length || Math.abs(relation.trust) + Math.abs(relation.bond) + Math.abs(relation.fear) >= 8) {
        relationDyads.add(pairKey(person.id, relation.personId));
      }
    }
  }
  const interactionDyads = new Set<string>();
  const interactionKinds = new Set<string>();
  for (const event of state.world.past) {
    if (event.kind !== 'action' || event.status !== 'completed') continue;
    if (event.action.kind === 'communicate') {
      const audience = event.action.audience
        .filter((personId) => !FILTER_SOCIAL_SELF_DYADS || personId !== event.who);
      if (audience.length) interactionKinds.add(`communicate:${event.action.content.kind}`);
      const isDirectedCoordination = event.action.audience.length === 1
        || event.action.content.kind === 'request'
        || event.action.content.kind === 'offer'
        || event.action.content.kind === 'accept'
        || event.action.content.kind === 'reject'
        || event.action.content.kind === 'revoke-agreement';
      if (isDirectedCoordination) audience
        .forEach((personId) => interactionDyads.add(pairKey(event.who, personId)));
    } else if (event.action.kind === 'transfer') {
      const other = event.action.from.kind === 'person' && event.action.from.personId !== event.who
        ? event.action.from.personId
        : event.action.to.kind === 'person' && event.action.to.personId !== event.who ? event.action.to.personId : undefined;
      if (other) {
        interactionKinds.add('person-transfer');
        interactionDyads.add(pairKey(event.who, other));
      }
    } else if (event.action.kind === 'act') {
      const people = event.action.targets.flatMap((target) => target.kind === 'person'
        && (!FILTER_SOCIAL_SELF_DYADS || target.personId !== event.who) ? [target.personId] : []);
      if (people.length) interactionKinds.add(`person-act:${event.action.operation}`);
      people.forEach((personId) => interactionDyads.add(pairKey(event.who, personId)));
    }
  }
  const relationCoverage = clamp(relationDyads.size / possibleDyads * 100);
  const interactionCoverage = clamp(interactionDyads.size / possibleDyads * 100);
  const interactionVariety = saturating(interactionKinds.size, 7);
  const fulfilledAgreements = state.agreements.filter((agreement) => agreement.status === 'fulfilled' && agreement.fulfillmentEventIds.length > 0);
  const fulfilledCoordinationAgreements = fulfilledAgreements.filter((agreement) => agreement.proposal.kind !== 'reproduce');
  const completedJointProjects = state.projects.filter((project) => project.status === 'completed'
    && project.contributorIds.length >= 2
    && project.completionEventIds.length > 0);
  const functionalInstitutions = state.derived.institutions.length;
  const activeCollectives = state.collectives.filter((collective) => collective.status === 'active');
  const largestCollectiveSize = activeCollectives.reduce((largest, collective) => Math.max(largest,
    collective.memberships.filter((membership) => membership.status === 'active'
      && state.people.some((person) => person.id === membership.personId && isAlive(person))).length), 0);
  const contributionCounts = new Map<string, number>();
  for (const project of completedJointProjects) for (const personId of project.contributorIds) {
    contributionCounts.set(personId, (contributionCounts.get(personId) ?? 0) + 1);
  }
  const roleHolders = [...contributionCounts.values()].filter((count) => count >= 2).length;
  const institutionalFacts = fulfilledCoordinationAgreements.length
    + completedJointProjects.length * 2
    + functionalInstitutions * 3
    + roleHolders * 2;
  const coordinationScore = saturating(institutionalFacts, 10);
  const rawSocialScore = relationCoverage * 0.25
    + (interactionCoverage * 0.65 + interactionVariety * 0.35) * 0.3
    + coordinationScore * 0.45;
  const socialScore = functionalInstitutions === 0 && completedJointProjects.length === 0
    ? Math.min(rawSocialScore, fulfilledCoordinationAgreements.length ? 55 : 35)
    : functionalInstitutions === 0
      ? Math.min(rawSocialScore, 68)
      : rawSocialScore;

  const taughtFactIds = new Set<string>();
  const turningCategories = new Set<string>();
  const causalEpisodeAnchors = new Set<string>();
  const capabilityIds = new Set<number>();
  let births = 0;
  let deaths = 0;
  let agreementOutcomes = 0;
  let eraTransitions = 0;
  for (const event of state.world.past) {
    if (event.kind === 'action'
      && event.status === 'completed'
      && event.action.kind === 'communicate'
      && event.action.content.kind === 'claim'
      && event.action.content.factId
      && event.action.audience.length > 0) taughtFactIds.add(event.action.content.factId);
    if (event.kind === 'environment' && typeof event.diff.bornPersonId === 'string') {
      births += 1;
      causalEpisodeAnchors.add(event.id);
      turningCategories.add('birth');
    }
    if (event.kind === 'environment' && event.change === 'death') {
      deaths += 1;
      causalEpisodeAnchors.add(event.id);
      turningCategories.add('death');
    }
    if (event.kind === 'environment' && event.diff.eraTransition === true) {
      eraTransitions += 1;
      causalEpisodeAnchors.add(event.id);
      turningCategories.add(`era:${String(event.diff.epoch ?? 'unknown')}`);
    }
    if (event.kind === 'agreement' && (event.change === 'fulfilled' || event.change === 'breached')) {
      agreementOutcomes += 1;
      causalEpisodeAnchors.add(event.id);
      turningCategories.add(`agreement:${event.change}`);
    }
  }
  const eventMonths = new Map(state.world.past.map((event) => [event.id, event.atMonth]));
  state.derived.milestones.forEach((milestone) => {
    if (Number.isInteger(milestone.capabilityId)) capabilityIds.add(Number(milestone.capabilityId));
    const outcomeAnchor = [...milestone.evidenceEventIds]
      .filter((eventId) => eventMonths.has(eventId))
      .sort((first, second) => Number(eventMonths.get(first)) - Number(eventMonths.get(second)) || first.localeCompare(second))
      .at(-1);
    if (outcomeAnchor) causalEpisodeAnchors.add(outcomeAnchor);
    turningCategories.add(milestone.domain
      ? `milestone:${milestone.domain}:${milestone.valence ?? 'ambivalent'}:${milestone.phase ?? 'emergence'}`
      : `legacy-milestone:${milestone.id}`);
  });
  state.projects.filter((project) => project.status === 'completed').forEach((project) => {
    turningCategories.add(`project:${project.need}`);
    const anchor = project.completionEventIds.at(-1) ?? project.actionEventIds.at(-1);
    if (anchor) causalEpisodeAnchors.add(anchor);
  });
  const transmittedTechniques = [...confidentTechniques].filter((techniqueId) => historicalPeople
    .filter((person) => person.knowledge.some((fact) => fact.id === techniqueId && fact.confidence >= 55)).length >= 2).length;
  const crossGenerationKnowledge = [...confidentTechniques].filter((techniqueId) => {
    const holders = historicalPeople.filter((person) => person.knowledge.some((fact) => fact.id === techniqueId && fact.confidence >= 55));
    return holders.some((person) => person.generation === 0) && holders.some((person) => person.generation > 0);
  }).length;
  const completedCausalProjects = state.projects.filter((project) => project.status === 'completed'
    && project.triggerFactIds.length > 0
    && project.completionEventIds.length > 0).length;
  const causalEpisodes = causalEpisodeAnchors.size;
  const episodeScore = saturating(causalEpisodes, 24);
  const turningVariety = saturating(turningCategories.size, 16);
  const transmissionScore = saturating(state.records.length, 6) * 0.4
    + saturating(taughtFactIds.size, 12) * 0.3
    + saturating(transmittedTechniques, 8) * 0.2
    + saturating(crossGenerationKnowledge, 4) * 0.1;
  const rawHistoryScore = episodeScore * 0.4 + turningVariety * 0.25 + transmissionScore * 0.35;
  const historyScore = state.records.length === 0 && transmittedTechniques === 0 && taughtFactIds.size === 0
    ? Math.min(rawHistoryScore, 35)
    : state.records.length === 0
      ? Math.min(rawHistoryScore, 65)
      : crossGenerationKnowledge === 0
        ? Math.min(rawHistoryScore, 70)
        : rawHistoryScore;

  const functionalBuildings = state.derived.functionalBuildings ?? observeFunctionalBuildings(state);
  const materialCapabilities = observeMaterialCapabilities(state);
  const stageFactor = { hypothesis: 0, sample: 0.1, repeatable: 0.35, distributed: 0.7, institutional: 1 } as const;
  const stageRank = { hypothesis: 0, sample: 1, repeatable: 2, distributed: 3, institutional: 4 } as const;
  const materialWeights = { 'processed-wood': 20, 'masonry-stone': 45, bronze: 110, iron: 180 } as const;
  const materialCapabilityPoints = materialCapabilities.reduce((sum, capability) => (
    sum + materialWeights[capability.key] * stageFactor[capability.stage]
  ), 0);
  const generationCount = new Set(historicalPeople.map((person) => person.generation)).size;
  const cultivatedCells = state.derived.regions.find((region) => region.kind === 'cultivated')?.cells.length ?? 0;
  const usedFacilities = functionalBuildings.filter((facility) => facility.useEventIds.length > 0);
  const populationPoints = living.length * 6 + Math.max(0, generationCount - 1) * 8;
  const territoryPoints = territoryScore * 0.35
    + state.derived.structures.filter((structure) => structure.complete).length * 8
    + functionalBuildings.length * 9
    + Math.min(30, cultivatedCells * 0.8);
  const technologyPoints = technologyScore * 0.5
    + materialCapabilityPoints
    + usedFacilities.length * 4;
  const socialPoints = socialScore * 0.5
    + functionalInstitutions * 18
    + usedFacilities.filter((facility) => facility.userIds.length >= 2).length * 6
    + completedJointProjects.length * 2;
  const historyPoints = historyScore * 0.35
    + state.records.length * 8
    + transmittedTechniques * 3
    + crossGenerationKnowledge * 8;

  const components: CivilizationIndex['components'] = {
    population: {
      score: roundedOpen(populationPoints), weight: WEIGHTS.population,
      evidence: { livingPeople: living.length, totalPeople: historicalPeople.length, generations: generationCount },
    },
    territory: {
      score: roundedOpen(territoryPoints), weight: WEIGHTS.territory,
      evidence: {
        ...territoryObservation.evidence,
        functionalBuildings: functionalBuildings.length,
        usedFacilities: usedFacilities.length,
        cultivatedCells,
      },
    },
    technology: {
      score: roundedOpen(technologyPoints), weight: WEIGHTS.technology,
      evidence: {
        confidentTechniques: confidentTechniques.size, realizedProcesses: realizedProcesses.size,
        techniqueDiffusion: rounded(techniqueDiffusion),
        materialCapabilityPoints: roundedOpen(materialCapabilityPoints),
        processedWoodStage: stageRank[materialCapabilities.find((item) => item.key === 'processed-wood')?.stage ?? 'hypothesis'],
        masonryStoneStage: stageRank[materialCapabilities.find((item) => item.key === 'masonry-stone')?.stage ?? 'hypothesis'],
        bronzeStage: stageRank[materialCapabilities.find((item) => item.key === 'bronze')?.stage ?? 'hypothesis'],
        ironStage: stageRank[materialCapabilities.find((item) => item.key === 'iron')?.stage ?? 'hypothesis'],
      },
    },
    social: {
      score: roundedOpen(socialPoints), weight: WEIGHTS.social,
      evidence: {
        relationDyads: relationDyads.size, interactionDyads: interactionDyads.size,
        interactionKinds: interactionKinds.size, institutionalFacts,
        fulfilledAgreements: fulfilledCoordinationAgreements.length,
        fulfilledReproductionAgreements: fulfilledAgreements.length - fulfilledCoordinationAgreements.length,
        completedJointProjects: completedJointProjects.length,
        functionalInstitutions,
        roleHolders,
        activeCollectives: activeCollectives.length,
        largestCollectiveSize,
      },
    },
    history: {
      score: roundedOpen(historyPoints), weight: WEIGHTS.history,
      evidence: {
        causalEpisodes,
        turningCategories: turningCategories.size,
        milestones: state.derived.milestones.length,
        milestoneCapabilities: capabilityIds.size,
        completedCausalProjects,
        births,
        deaths,
        agreementOutcomes,
        eraTransitions,
        recordedKnowledge: state.records.length,
        taughtFacts: taughtFactIds.size,
        transmittedTechniques,
        crossGenerationKnowledge,
      },
    },
  };
  const total = Object.values(components).reduce((sum, component) => sum + component.score * component.weight, 0);
  return {
    formulaVersion: CIVILIZATION_INDEX_FORMULA_VERSION,
    total: roundedOpen(total), calculatedAtMonth: state.clock.elapsedMonths, components,
  };
}

export function civilizationStageFor(index: CivilizationIndex): string {
  if (index.total < 120) return '原始部落';
  if (index.total < 300) return '农耕定居';
  return '古代文明';
}
