import { Material, materialHas, type MaterialId } from '../../domain/material';
import { bestProductionToolStack, productionToolRank } from '../../domain/production-tool';
import type { DropState, SimulationState } from '../../domain/model';
import { ageMonths, inventoryQuantity, isAlive, type PersonState } from '../../domain/person';
import type {
  ProjectFunction,
  ProjectNeed,
  ProjectPressureBasis,
  ProjectProposal,
  ProjectState,
} from '../../domain/project';
import { shelterGeometryAt } from '../../domain/structure';
import { worldEventById } from '../../domain/event-index';
import { inspectProjectMaterialContributionRequest } from '../../domain/project-material-request';
import { inspectProjectKnowledgeRequest } from '../../domain/project-knowledge-request';
import {
  cellX,
  cellY,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
  topPosition,
  voxelAt,
} from '../../world/grid';
import { seededFraction } from '../../world/generator';
import {
  buildProjectPressureBasis,
  projectPressureReasonPresent,
  type ProjectPressureView,
} from '../project-pressure';
import { buildLocalMaterialEvidence } from '../local-material-evidence';
import {
  mechanicalPowerMaintenanceProposalCandidate,
  mechanicalPowerProposalCandidate,
} from '../mechanical-power-options';
import {
  completedFunctionMaterialIds,
  cultivationSurfaceMaterials,
  harvestableSeedSourceMaterials,
  placedFunctionEvidence,
  plantableCultivationMaterials,
  projectCultivationCells,
  verifiedProductionToolFunctions,
} from './project-completion';
import { proposalWithInquiryOpportunityMemory } from './project-inquiry';
import { visibleCellsFor } from './project-perception';
import { knownFacilitySite } from './project-workplace';
import { projectsOwnedBy } from '../../domain/state-index';
function proposal(
  state: SimulationState,
  person: PersonState,
  need: ProjectNeed,
  input: Omit<ProjectProposal, 'id' | 'need' | 'ownerId' | 'createdAtMonth' | 'reviewAtMonth' | 'triggerFactIds' | 'pressure' | 'pressureBasis'>,
  view: ProjectPressureView,
  pressureBasis?: ProjectPressureBasis,
): ProjectProposal {
  const createdAtMonth = state.clock.elapsedMonths + 1;
  const anchoredInput = (input.kind === 'construction' || input.desiredFunction === 'durable-record') && !input.site
    ? { ...input, site: { cellId: person.position.cellId, z: person.position.z } }
    : input;
  const productionToolBaselineRank = verifiedProductionToolFunctions.has(anchoredInput.desiredFunction)
    ? anchoredInput.productionToolBaselineRank
      ?? productionToolRank(bestProductionToolStack(person)?.materialId ?? Material.Air)
    : undefined;
  const reviewMonths = [
    'production-efficiency', 'reserve-security', 'water-security', 'coordination-capacity',
  ].includes(need) ? 23 : [
    'high-heat-capability', 'alloy-capability', 'iron-capability', 'mechanical-power-capability',
  ].includes(need) ? 35 : 11;
  const subject = {
    need,
    beneficiaryIds: anchoredInput.beneficiaryIds,
    createdAtMonth,
    ...(productionToolBaselineRank !== undefined ? { productionToolBaselineRank } : {}),
    ...(anchoredInput.targetKnowledgeId ? { targetKnowledgeId: anchoredInput.targetKnowledgeId } : {}),
    ...(anchoredInput.shelterRequirement ? { shelterRequirement: anchoredInput.shelterRequirement } : {}),
  };
  const basis = pressureBasis ?? buildProjectPressureBasis(state, person, subject, createdAtMonth, view);
  return {
    id: `project-${createdAtMonth}-${person.id}-${need}`,
    need,
    ownerId: person.id,
    createdAtMonth,
    reviewAtMonth: createdAtMonth + reviewMonths,
    ...anchoredInput,
    ...(productionToolBaselineRank !== undefined ? { productionToolBaselineRank } : {}),
    triggerFactIds: [...basis.sourceFactIds],
    pressure: basis.pressure,
    pressureBasis: basis,
  };
}

function projectHasValidRequestForPerson(
  state: SimulationState,
  project: ProjectState,
  person: PersonState,
  atMonth: number,
): boolean {
  const materialRequest = project.materialContributionRequests?.some((request) => {
    if (!request.contributorIds.includes(person.id)) return false;
    const demand = project.materialDemands?.find((candidate) => candidate.materialId === request.materialId);
    return Boolean(demand && inspectProjectMaterialContributionRequest(
      state,
      project,
      request,
      atMonth,
      demand,
    ).status === 'open');
  });
  const techniqueRequest = project.techniqueDemonstrationRequests?.some((request) => (
    request.teacherIds.includes(person.id)
      && request.expiresAtMonth >= atMonth
      && !project.techniqueDemonstrations?.some((basis) => basis.requestEventId === request.requestEventId)
  ));
  const knowledgeRequest = project.knowledgeRequests?.some((request) => (
    request.listenerIds.includes(person.id)
      && inspectProjectKnowledgeRequest(state, project, request, atMonth) === 'open'
  ));
  return Boolean(materialRequest || techniqueRequest || knowledgeRequest);
}

export function personHasProjectLink(
  state: SimulationState,
  project: ProjectState,
  person: PersonState,
  atMonth: number,
): boolean {
  return project.beneficiaryIds.includes(person.id)
    || project.contributorIds.includes(person.id)
    || projectHasValidRequestForPerson(state, project, person, atMonth);
}

export function visibleConstructionProgress(project: ProjectState, visibleCells: ReadonlySet<number>): boolean {
  return project.kind === 'construction'
    && Boolean(project.site && visibleCells.has(project.site.cellId))
    && project.actionEventIds.length > 0;
}

export function activeProjectOverlapsLocalProposal(
  state: SimulationState,
  project: ProjectState,
  person: PersonState,
  desiredFunction: ProjectFunction,
  beneficiaryIds: string[],
  site: ProjectState['site'],
  targetKnowledgeId: string | undefined,
  visibleCells: ReadonlySet<number>,
  atMonth: number,
): boolean {
  if (project.status !== 'active' || project.desiredFunction !== desiredFunction) return false;
  if (desiredFunction === 'durable-record' && project.targetKnowledgeId !== targetKnowledgeId) return false;
  if (site && project.site) {
    if (desiredFunction === 'settled-cultivation') {
      const distance = Math.abs(cellX(site.cellId) - cellX(project.site.cellId))
        + Math.abs(cellY(site.cellId) - cellY(project.site.cellId));
      if (distance <= 4) return true;
    } else if (project.kind === 'construction' && visibleCells.has(project.site.cellId)) return true;
    else if (project.kind === 'production'
      && site.cellId === project.site.cellId
      && site.z === project.site.z
      && visibleCells.has(project.site.cellId)) return true;
  }
  if (project.beneficiaryIds.some((personId) => beneficiaryIds.includes(personId))) return true;
  if (personHasProjectLink(state, project, person, atMonth)) return true;
  return visibleConstructionProgress(project, visibleCells);
}

interface ShelterAdaptationCandidate {
  beneficiary: PersonState;
  condition: PersonState['conditions'][number] & { kind: 'cold' | 'heat' };
  shelter: NonNullable<ReturnType<typeof shelterGeometryAt>>;
  sourceEventIds: string[];
}

function shelterAdaptationCandidate(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  proposalMonth: number,
): ShelterAdaptationCandidate | undefined {
  return [...new Map([person, ...visiblePeople].map((candidate) => [candidate.id, candidate])).values()]
    .filter((candidate) => candidate.id === person.id
      || (candidate.geneticParents.includes(person.id) && ageMonths(candidate, proposalMonth) < 12 * 12))
    .flatMap((beneficiary) => beneficiary.conditions
      .filter((condition): condition is typeof condition & { kind: 'cold' | 'heat' } => (
        (condition.kind === 'cold' || condition.kind === 'heat') && condition.sourceEventIds.length > 0
      ))
      .flatMap((condition) => {
        const shelter = shelterGeometryAt(state.world.grid, beneficiary.position);
        const sourceEventIds = condition.sourceEventIds.filter((eventId) => {
          const event = worldEventById(state, eventId);
          return event?.kind === 'environment'
            && event.change === 'condition'
            && event.who === beneficiary.id
            && event.cellId === beneficiary.position.cellId
            && event.diff.condition === condition.kind;
        });
        return shelter && shelter.enclosedSides < 3 && sourceEventIds.length
          ? [{ beneficiary, condition, shelter, sourceEventIds }]
          : [];
      }))
    .sort((left, right) => right.condition.stage - left.condition.stage
      || Number(right.beneficiary.id === person.id) - Number(left.beneficiary.id === person.id)
      || left.beneficiary.id.localeCompare(right.beneficiary.id))[0];
}

export function shelterAdaptationProposal(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  pressureView: ProjectPressureView,
): ProjectProposal | null {
  const adaptation = shelterAdaptationCandidate(state, person, visiblePeople, state.clock.elapsedMonths + 1);
  if (!adaptation) return null;
  return proposal(state, person, 'shelter-capacity', {
    kind: 'construction', desiredFunction: 'weather-shelter',
    summary: `补强${adaptation.beneficiary.name}仍受到${adaptation.condition.kind === 'cold' ? '寒冷' : '炎热'}伤害的住所`,
    beneficiaryIds: [adaptation.beneficiary.id],
    site: { ...adaptation.shelter.position },
    shelterRequirement: {
      exposureKind: adaptation.condition.kind,
      beneficiaryId: adaptation.beneficiary.id,
      baselineEnclosedSides: adaptation.shelter.enclosedSides,
      baselineOpenSides: adaptation.shelter.openSides,
      baselineWeatherProtection: adaptation.shelter.weatherProtection,
      baselineThermalInsulation: adaptation.shelter.thermalInsulation,
      minimumEnclosedSides: 3,
      sourceEventIds: [...adaptation.sourceEventIds],
    },
  }, pressureView);
}

/**
 * A person sheltering from an exposure still needs one planning tick in which
 * to perceive that the current enclosure failed. This predicate is read-only:
 * it opens planning but neither creates a project nor changes the body.
 */
export function hasCausalShelterAdaptationNeed(state: SimulationState, person: PersonState): boolean {
  const activeProjects = projectsOwnedBy(state, person.id).filter((project) => project.status === 'active');
  if (activeProjects.some((project) => project.shelterRequirement)) return true;
  if (activeProjects.length) return false;
  const visibleCells = visibleCellsFor(person);
  const visible = new Set(visibleCells);
  const visiblePeople = state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId));
  return Boolean(shelterAdaptationCandidate(state, person, visiblePeople, state.clock.elapsedMonths + 1));
}

function hasLocallyVisibleShelter(state: SimulationState, visible: ReadonlySet<number>): boolean {
  return [...visible].some((cell) => neighbors4(cell).every((neighbor) => visible.has(neighbor))
    && standingPositions(state.world.grid, cell)
      .some((position) => Boolean(shelterGeometryAt(state.world.grid, position))));
}

export function deriveProjectProposals(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  visibleDrops: DropState[],
  visiblePeople: PersonState[],
): ProjectProposal[] {
  if (projectsOwnedBy(state, person.id).some((project) => project.status === 'active')) return [];
  const visible = new Set(visibleCells);
  const pressureView: ProjectPressureView = { visibleCells, visibleDrops, visiblePeople };
  const proposals: ProjectProposal[] = [];
  const cold = person.conditions.find((condition) => condition.kind === 'cold');
  const climateCold = state.civilization.climate.kind === 'cold' && state.civilization.climate.severity >= 3;
  const hasInsulation = person.inventory.some((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'insulating'));
  if ((cold || climateCold) && !hasInsulation) proposals.push(proposal(state, person, 'thermal-safety', {
    kind: 'production', desiredFunction: 'insulation', summary: '减少反复寒冷造成的身体损耗',
    beneficiaryIds: [person.id],
  }, pressureView));

  const proposalMonth = state.clock.elapsedMonths + 1;
  const huntingSubject = { need: 'hunting-safety' as const, beneficiaryIds: [person.id], createdAtMonth: proposalMonth };
  const huntingBasis = buildProjectPressureBasis(state, person, huntingSubject, proposalMonth, pressureView);
  const ownHuntFailure = projectPressureReasonPresent(huntingBasis, 'own-hunt-failure');
  const personalAttack = projectPressureReasonPresent(huntingBasis, 'personal-animal-attack');
  const visibleThreat = projectPressureReasonPresent(huntingBasis, 'visible-aggressive-animal');
  if ((ownHuntFailure || personalAttack || visibleThreat) && inventoryQuantity(person, Material.Spear) === 0) proposals.push(proposal(state, person, 'hunting-safety', {
    kind: ownHuntFailure || personalAttack ? 'production' : 'inquiry', desiredFunction: 'safer-hunting', summary: '降低下一次捕猎或应对猛兽的受伤风险',
    beneficiaryIds: [person.id],
  }, pressureView, huntingBasis));

  const injured = [person, ...visiblePeople]
    .filter((candidate) => candidate.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'))
    .sort((a, b) => a.body.health - b.body.health)[0];
  if (injured && inventoryQuantity(person, Material.HerbalMedicine) === 0) {
    proposals.push(proposal(state, person, 'care-capability', {
      kind: 'inquiry', desiredFunction: 'healing', summary: `为${injured.name}寻找比临时包扎更有效的照护材料`,
      beneficiaryIds: [injured.id],
    }, pressureView));
  }

  const rawMeat = inventoryQuantity(person, Material.RawMeat) + visibleDrops.filter((drop) => drop.materialId === Material.RawMeat).reduce((sum, drop) => sum + drop.quantity, 0);
  if (rawMeat > 0 && inventoryQuantity(person, Material.CookedFood) === 0) proposals.push(proposal(state, person, 'food-preparation', {
    kind: 'inquiry', desiredFunction: 'prepared-food', summary: '把容易伤身的生肉变成更可靠的食物',
    beneficiaryIds: [person.id],
  }, pressureView));

  const exposed = person.conditions.find((condition) => condition.kind === 'cold' || condition.kind === 'heat');
  const severeWeather = (state.civilization.weather.kind === 'storm' && state.civilization.weather.intensity >= 2)
    || state.civilization.climate.kind === 'fire'
    || ((state.civilization.climate.kind === 'cold' || state.civilization.climate.kind === 'heat') && state.civilization.climate.severity >= 3);
  const ownShelter = shelterGeometryAt(state.world.grid, person.position);
  const sheltered = Boolean(ownShelter);
  const adaptation = shelterAdaptationProposal(state, person, visiblePeople, pressureView);
  if (adaptation) proposals.push(adaptation);
  const visibleCompleteShelter = hasLocallyVisibleShelter(state, visible);
  if (!adaptation && (exposed || severeWeather) && !sheltered && !visibleCompleteShelter) proposals.push(proposal(state, person, 'shelter-capacity', {
    kind: 'construction', desiredFunction: 'weather-shelter', summary: '把同一处材料连接成能进入并遮蔽天气的住所',
    beneficiaryIds: [person.id],
    site: { cellId: person.position.cellId, z: person.position.z },
  }, pressureView));

  const authoredRecords = state.records.filter((record) => record.authorId === person.id);
  const durableKnowledge = person.knowledge
    .filter((fact) => fact.kind === 'technique'
      && fact.confidence >= 68
      && fact.sourceEventIds.length >= 2
      && !authoredRecords.some((record) => record.knowledgeId === fact.id))
    .sort((a, b) => b.confidence - a.confidence
      || b.sourceEventIds.length - a.sourceEventIds.length
      || a.id.localeCompare(b.id))[0];
  const knowledgeSubject = {
    need: 'knowledge-preservation' as const,
    beneficiaryIds: [person.id],
    createdAtMonth: proposalMonth,
    ...(durableKnowledge ? { targetKnowledgeId: durableKnowledge.id } : {}),
  };
  const knowledgeBasis = buildProjectPressureBasis(state, person, knowledgeSubject, proposalMonth, pressureView);
  const continuityPressure = knowledgeBasis.reasonKeys.some((reason) => reason.startsWith('age-band-'))
    || projectPressureReasonPresent(knowledgeBasis, 'personal-memory-disruption');
  if (continuityPressure && durableKnowledge && authoredRecords.length < 1) proposals.push(proposal(state, person, 'knowledge-preservation', {
    kind: 'inquiry', desiredFunction: 'durable-record',
    summary: `让“${durableKnowledge.summary}”在个人记忆中断后仍可留下`,
    beneficiaryIds: [person.id],
    targetKnowledgeId: durableKnowledge.id,
  }, pressureView, knowledgeBasis));

  const maintenanceCandidate = mechanicalPowerMaintenanceProposalCandidate(state, person, visibleCells);
  if (maintenanceCandidate && !projectsOwnedBy(state, person.id).some((project) => (
    project.status === 'active' || project.status === 'completed'
  ) && project.desiredFunction === 'restore-water-powered-crop-processing'
    && project.mechanicalPowerNetworkId === maintenanceCandidate.network.id
    && project.mechanicalPowerFaultEventId === maintenanceCandidate.faultEvent.id)) {
    const subject = {
      need: 'mechanical-power-capability' as const,
      desiredFunction: 'restore-water-powered-crop-processing' as const,
      beneficiaryIds: [person.id],
      createdAtMonth: proposalMonth,
    };
    const basis = buildProjectPressureBasis(state, person, subject, proposalMonth, pressureView);
    if (basis.pressure >= 42) proposals.push(proposal(state, person, 'mechanical-power-capability', {
      kind: 'production',
      desiredFunction: 'restore-water-powered-crop-processing',
      summary: '诊断停转机械网络并用故障后新制备件恢复真实负载作业',
      beneficiaryIds: [person.id],
      site: {
        cellId: maintenanceCandidate.contributionSite.cellId,
        z: maintenanceCandidate.contributionSite.z,
      },
      mechanicalPowerPlan: structuredClone(maintenanceCandidate.plan),
      mechanicalPowerPlanKey: maintenanceCandidate.planKey,
      mechanicalPowerNetworkId: maintenanceCandidate.network.id,
      mechanicalPowerFaultEventId: maintenanceCandidate.faultEvent.id,
    }, pressureView, {
      ...basis,
      sourceFactIds: [...new Set([
        maintenanceCandidate.faultEvent.id,
        ...maintenanceCandidate.diagnosisSourceEventIds,
      ])],
    }));
  }

  if (!projectsOwnedBy(state, person.id).some((project) => project.ownerId === person.id
    && project.status === 'completed'
    && project.desiredFunction === 'water-powered-crop-processing')) {
    const mechanicalCandidate = mechanicalPowerProposalCandidate(state, person, visibleCells);
    if (mechanicalCandidate) {
      const subject = {
        need: 'mechanical-power-capability' as const,
        desiredFunction: 'water-powered-crop-processing' as const,
        beneficiaryIds: [person.id],
        createdAtMonth: proposalMonth,
      };
      const basis = buildProjectPressureBasis(state, person, subject, proposalMonth, pressureView);
      if (basis.pressure >= 42) proposals.push(proposal(state, person, 'mechanical-power-capability', {
        kind: 'production',
        desiredFunction: 'water-powered-crop-processing',
        summary: '在本人观察的流水旁，以三处可见、可达且有承托的空位试建最短动力磨坊',
        beneficiaryIds: [person.id],
        site: {
          cellId: mechanicalCandidate.contributionSite.cellId,
          z: mechanicalCandidate.contributionSite.z,
        },
        mechanicalPowerPlan: structuredClone(mechanicalCandidate.plan),
        mechanicalPowerPlanKey: mechanicalCandidate.planKey,
        mechanicalPowerNetworkId: mechanicalCandidate.networkId,
      }, pressureView, {
        ...basis,
        sourceFactIds: [mechanicalCandidate.millLaborFact.id, mechanicalCandidate.observationFact.id],
      }));
    }
  }

  const materialEvidence = buildLocalMaterialEvidence(state, person, { visibleCells, visibleDrops, visiblePeople });
  const hasObserved = (...materialIds: MaterialId[]) => materialIds.some((materialId) => (
    materialEvidence.observedMaterialIds.has(materialId)
  ));
  const hasOwn = (...materialIds: MaterialId[]) => materialIds.some((materialId) => inventoryQuantity(person, materialId) > 0);
  const ownsAll = (...materialIds: MaterialId[]) => materialIds.every((materialId) => inventoryQuantity(person, materialId) > 0);
  const hasFacility = (...materialIds: MaterialId[]) => materialIds.some((materialId) => (
    materialHas(materialId, 'facility') && materialEvidence.placedFacilityMaterialIds.has(materialId)
  ));
  const hasLinkedCompletedFacility = (...materialIds: MaterialId[]) => {
    const wanted = new Set(materialIds);
    return state.projects.some((project) => project.status === 'completed'
      && (project.ownerId === person.id
        || project.beneficiaryIds.includes(person.id)
        || project.contributorIds.includes(person.id))
      && completedFunctionMaterialIds(project).some((materialId) => wanted.has(materialId))
      && placedFunctionEvidence(state, project).length > 0);
  };
  const completedJointProjects = state.projects.filter((project) => project.status === 'completed'
    && project.contributorIds.includes(person.id)
    && project.contributorIds.some((personId) => personId !== person.id));
  const pushDevelopmentProposal = (
    need: ProjectNeed,
    desiredFunction: ProjectFunction,
    summary: string,
    ready: boolean,
    kind: ProjectProposal['kind'] = 'production',
    site?: ProjectState['site'],
  ) => {
    if (!ready) return;
    const proposalSite = site ?? (kind === 'construction'
      ? { cellId: person.position.cellId, z: person.position.z }
      : undefined);
    const beneficiaryIds = kind === 'construction' || need === 'alloy-capability'
      ? [...new Set(visiblePeople.map((candidate) => candidate.id).concat(person.id))]
      : [person.id];
    const completedOutputStillUsable = completedFunctionMaterialIds({ desiredFunction })
      .some((materialId) => materialHas(materialId, 'facility')
        ? materialEvidence.placedFacilityMaterialIds.has(materialId)
        : materialEvidence.accessiblePortableMaterialIds.has(materialId));
    if (need === 'alloy-capability'
      && completedOutputStillUsable
      && state.projects.some((project) => project.status === 'completed'
        && project.desiredFunction === desiredFunction)) return;
    const duplicateActiveProject = state.projects.some((project) => activeProjectOverlapsLocalProposal(
      state,
      project,
      person,
      desiredFunction,
      beneficiaryIds,
      proposalSite,
      undefined,
      visible,
      proposalMonth,
    ));
    if (duplicateActiveProject) return;
    const productionToolBaselineRank = verifiedProductionToolFunctions.has(desiredFunction)
      ? productionToolRank(bestProductionToolStack(person)?.materialId ?? Material.Air)
      : undefined;
    const subject = {
      need,
      desiredFunction,
      beneficiaryIds,
      createdAtMonth: proposalMonth,
      ...(productionToolBaselineRank !== undefined ? { productionToolBaselineRank } : {}),
    };
    const basis = buildProjectPressureBasis(state, person, subject, proposalMonth, pressureView);
    if (basis.pressure < 42) return;
    proposals.push(proposal(state, person, need, {
      kind,
      desiredFunction,
      summary,
      beneficiaryIds,
      ...(productionToolBaselineRank !== undefined ? { productionToolBaselineRank } : {}),
      ...(proposalSite ? { site: { ...proposalSite } } : {}),
    }, pressureView, basis));
  };

  const accessibleProductionToolRank = [...materialEvidence.accessiblePortableMaterialIds]
    .reduce((highest, materialId) => Math.max(highest, productionToolRank(materialId)), 0);
  const hasProductionTool = accessibleProductionToolRank > 0;
  const efficientProductionTargetRank = productionToolRank(Material.StoneHoe);
  const cultivationSite = visibleCells
    .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId))
      || plantableCultivationMaterials.has(surfaceMaterial(state.world.grid, cellId)))
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
      established: cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId)),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => Number(right.established) - Number(left.established)
      || left.path.length - right.path.length
      || left.cellId - right.cellId)[0];
  const hasAccessibleSeedSource = hasOwn(Material.Seed)
    || visibleDrops.some((drop) => drop.materialId === Material.Seed && drop.quantity > 0)
    || visibleCells.some((cellId) => harvestableSeedSourceMaterials
      .has(surfaceMaterial(state.world.grid, cellId)))
    || person.knownPlaces.some((place) => harvestableSeedSourceMaterials.has(place.materialId)
      && voxelAt(state.world.grid, place.position.x, place.position.y, place.position.z) === place.materialId);
  const accessibleStorableUnits = [
    ...person.inventory.filter((stack) => stack.quantity > 0
      && (materialHas(stack.materialId, 'edible') || materialHas(stack.materialId, 'seed'))),
    ...visibleDrops.filter((drop) => drop.quantity > 0
      && (materialHas(drop.materialId, 'edible') || materialHas(drop.materialId, 'seed'))),
  ].reduce((sum, stack) => sum + stack.quantity, 0);
  const reserveWeatherRisk = state.civilization.weather.kind === 'storm'
    || state.civilization.climate.severity >= 3;
  const cultivationCellCount = cultivationSite
    ? projectCultivationCells({ site: { cellId: cultivationSite.cellId, z: cultivationSite.position.z } })
      .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId))).length
    : 0;
  pushDevelopmentProposal(
    'production-efficiency',
    'efficient-production',
    '用专门工具缓解本人反复感知到的食物与采集压力',
    accessibleProductionToolRank < efficientProductionTargetRank
      && hasObserved(Material.Leaves, Material.Shrub, Material.Wood, Material.Fiber, Material.Rope, Material.Plank),
  );
  pushDevelopmentProposal(
    'production-efficiency',
    'workshop-production',
    '建立固定工坊，把个人手艺变成可重复的生产能力',
    hasProductionTool && !hasFacility(Material.Workshop)
      && hasObserved(Material.Leaves, Material.Wood, Material.Plank, Material.WoodTablet),
    'construction',
  );
  pushDevelopmentProposal(
    'reserve-security',
    'reserve-storage',
    '建立公共谷仓，保存眼前余粮并应对坏天气造成的储备波动',
    (accessibleStorableUnits >= 2 || reserveWeatherRisk)
      && !hasFacility(Material.Granary)
      // Beneficiary/contributor links already prevent parallel active projects.
      // A completed link likewise suppresses only a duplicate proposal: it does
      // not reveal remote inventory or grant remote container access.
      && !hasLinkedCompletedFacility(Material.Granary)
      && hasObserved(Material.Leaves, Material.Wood, Material.Plank, Material.Container),
    'construction',
  );
  pushDevelopmentProposal(
    'water-security',
    'reliable-water',
    '修建蓄水设施，降低本人感知到的干热与缺水风险',
    !hasFacility(Material.Cistern)
      && hasObserved(Material.Stone)
      && hasObserved(Material.Leaves, Material.Wood, Material.Plank, Material.Container),
    'construction',
  );
  pushDevelopmentProposal(
    'production-efficiency',
    'settled-cultivation',
    '建立固定耕地，以播种、成熟、收获和留种循环缓解本人感知到的食物压力',
    Boolean(cultivationSite)
      && hasAccessibleSeedSource
      && cultivationCellCount < 6,
    'production',
    cultivationSite ? { cellId: cultivationSite.cellId, z: cultivationSite.position.z } : undefined,
  );
  pushDevelopmentProposal(
    'production-efficiency',
    'crop-processing',
    '建立石磨，提高定居作物的收获效率',
    hasObserved(Material.CropMature, Material.Seed) && !hasFacility(Material.Mill)
      && hasObserved(Material.Stone) && hasObserved(Material.Leaves, Material.Wood, Material.Plank),
    'construction',
  );
  pushDevelopmentProposal(
    'coordination-capacity',
    'community-coordination',
    '把已经发生的共同项目、分配与记忆安置到固定议事场所',
    completedJointProjects.length > 0
      && !hasFacility(Material.CouncilHearth, Material.CivicHall, Material.KeepCore)
      && hasObserved(Material.Leaves, Material.Shrub, Material.Wood, Material.Fiber, Material.Plank, Material.Rope),
    'construction',
  );

  pushDevelopmentProposal(
    'high-heat-capability',
    'high-heat-processing',
    '用黏土和石料建立窑炉，获得比露天火堆更稳定的高温',
    hasObserved(Material.Clay) && hasObserved(Material.Stone)
      && !hasFacility(Material.Kiln, Material.Foundry, Material.Smithy),
    'construction',
  );
  const metallurgySite = knownFacilitySite(state, person);
  pushDevelopmentProposal(
    'high-heat-capability',
    'brick-firing',
    '在固定窑炉中反复烧制砖料，为更复杂建筑准备耐火材料',
    Boolean(metallurgySite && hasOwn(Material.Clay) && hasFacility(Material.Kiln, Material.Foundry)),
    'production',
    metallurgySite,
  );
  pushDevelopmentProposal('alloy-capability', 'copper-charge', '在固定窑炉汇合铜矿与木炭，配成可冶炼的铜料',
    Boolean(metallurgySite && hasObserved(Material.CopperOre)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'copper-smelting', '在固定高温设施中从铜料得到金属铜',
    Boolean(metallurgySite && hasObserved(Material.CopperCharge)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'tin-charge', '在固定窑炉汇合锡矿与木炭，配成可冶炼的锡料',
    Boolean(metallurgySite && hasObserved(Material.TinOre)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'tin-smelting', '在固定高温设施中从锡料得到金属锡',
    Boolean(metallurgySite && hasObserved(Material.TinCharge)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'bronze-alloying', '在固定工地汇合铜锡并反复校验比例，得到可用青铜',
    Boolean(metallurgySite && hasObserved(Material.Copper) && hasObserved(Material.Tin)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'bronze-tooling', '在固定工地把青铜变成能显著提高生产效率的专门工具',
    Boolean(metallurgySite && hasObserved(Material.Bronze) && hasObserved(Material.Wood)), 'production', metallurgySite);
  pushDevelopmentProposal(
    'alloy-capability',
    'bronze-workshop',
    '建立铸造场，把偶然的青铜样品变成可分工复现的生产能力',
    Boolean(metallurgySite && hasObserved(Material.Bronze) && hasObserved(Material.Stone) && !hasFacility(Material.Foundry)),
    'construction',
    metallurgySite,
  );
  pushDevelopmentProposal(
    'coordination-capacity',
    'civic-coordination',
    '建立公共厅堂，让记录、度量与分配成为稳定制度',
    hasObserved(Material.Bronze, Material.BronzeTool)
      && hasObserved(Material.FiredBrick)
      && (hasObserved(Material.WoodTablet)
        || (hasObserved(Material.StoneTool) && hasObserved(Material.Wood)))
      && !hasFacility(Material.CivicHall, Material.KeepCore),
    'construction',
  );

  pushDevelopmentProposal(
    'iron-capability',
    'iron-workshop',
    '建立铁匠铺，以青铜经验和耐火砖跨过铁器高温门槛',
    hasObserved(Material.Bronze, Material.BronzeTool) && hasObserved(Material.FiredBrick)
      && !hasFacility(Material.Smithy),
    'construction',
  );
  const smithySite = knownFacilitySite(state, person, [Material.Smithy]);
  pushDevelopmentProposal('iron-capability', 'iron-charge', '把铁矿与木炭配成可还原的铁料',
    Boolean(smithySite && hasObserved(Material.IronOre) && hasObserved(Material.Charcoal)),
    'production', smithySite);
  pushDevelopmentProposal('iron-capability', 'iron-reduction', '在铁匠铺中把铁料还原成海绵铁',
    Boolean(smithySite && hasObserved(Material.IronCharge)), 'production', smithySite);
  pushDevelopmentProposal('iron-capability', 'iron-working', '反复加热和锤炼海绵铁，得到可用铁料',
    Boolean(smithySite && hasObserved(Material.IronBloom) && hasObserved(Material.Charcoal)),
    'production', smithySite);
  pushDevelopmentProposal('iron-capability', 'iron-tooling', '锻造铁制生产工具，缓解更大人口的持续资源压力',
    Boolean(smithySite && hasObserved(Material.Iron) && hasObserved(Material.Wood)),
    'production', smithySite);
  pushDevelopmentProposal(
    'coordination-capacity',
    'fortified-coordination',
    '建立城堡核心，组织城镇防护、维护与跨工种协作',
    hasObserved(Material.IronTool) && ownsAll(Material.Iron, Material.FiredBrick) && !hasFacility(Material.KeepCore),
    'construction',
  );

  return proposals.flatMap((candidate) => {
    const grounded = proposalWithInquiryOpportunityMemory(state, person, visibleDrops, candidate);
    return grounded ? [grounded] : [];
  }).sort((a, b) => b.pressure - a.pressure
    || seededFraction(state.seed, `project-proposal:${state.clock.elapsedMonths}:${person.id}:${a.need}`)
      - seededFraction(state.seed, `project-proposal:${state.clock.elapsedMonths}:${person.id}:${b.need}`));
}
