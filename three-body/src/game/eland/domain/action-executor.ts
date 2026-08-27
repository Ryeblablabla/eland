import { waterCurrentObservationFactId, type FactPredicate, type Intent, type PrimitiveAction, type RecordUseInputWitnessV1, type VoxelPosition, type WorldRef } from './action';
import { Material, materialDefinition, materialHas, type MaterialId } from './material';
import {
  ageMonths,
  hasHibernationEntryBodyReserve,
  hasHibernationEntryContraindication,
  HIBERNATION_ENTRY_LEGAL_RESERVE,
  HIBERNATION_PREDICTIVE_ENTRY_RESERVE,
  HIBERNATION_RECOVERY_SAFE_RESERVE,
  hibernationPhase,
  inventoryQuantity,
  isAlive,
  isDormantDehydratedHibernating,
  isRecoveringFromDehydratedHibernation,
  sameLocation,
  type ItemStack,
  type PersonState,
} from './person';
import type { ActionFact, DropState, SimulationState } from './model';
import { cellId, cellX, cellY, cellsInRadius, findStandingPath, setVoxel, standingPathMovementCost, standingPathSegmentForTick, surfaceMaterial, voxelAt, type StandingPosition } from '../world/grid';
import { seededFraction } from '../world/generator';
import { communicationById } from './social-facts';
import { remember, rememberAction } from './memory';
import { recordPersonalityEvidence } from './personality';
import { recordActionOutcomeBelief } from './cognition';
import { applyRelationEvidence, relationTo } from './relation';
import { activeReproductionAgreementBetween, agreementAuthorizesTransfer, agreementById, recordAgreementAction, reproductionAttemptedBetweenInMonth } from './agreement';
import { recordCollectiveAction } from './collective';
import { mandateById, mandateSupportsTransfer, recordGovernanceAction } from './governance';
import { permissionAuthorizesTransfer, permissionById, recordPermissionAction } from './permission';
import {
  exertionRuleFor,
  exertionTechniqueId,
  exertionTechniqueSummary,
  exposureRuleFor,
  exposureTechniqueId,
  exposureTechniqueSummary,
  inventoryCombinationFor,
  inventoryCombinationSummary,
  inventoryCombinationTechniqueId,
  inventoryVoxelCombinationOutput,
} from './interaction-rules';
import { rememberMaterialPlace } from './spatial-knowledge';
import { shelterGeometryAt } from './structure';
import { geneticKinshipRisk } from './kinship';
import { recordInteractionFailureKnowledge } from './interaction-knowledge';
import { recordWitnessedDeclarationFulfillment } from './declaration';
import { separationTechniqueId, separationTechniqueSummary, separationToolFits, voxelSeparationRuleFor } from './separation-rules';
import { canAccessContainer, containerById, containerIdAt, containerQuantity, containerRemainingCapacity, GRANARY_CAPACITY, type ContainerState } from './container';
import { compareWorldEventsInCanonicalOrder, worldEventById } from './event-index';
import { animalSpecies, isAnimalAlive } from './animal';
import {
  canPersonCollectProjectMaterialDrop,
  inspectProjectMaterialContributionRequest,
} from './project-material-request';
import { humanReproductionCapacityFactor, HUMAN_SOFT_CARRYING_CAPACITY } from './population-capacity';
import { hasReproductiveRecoveryCondition } from './dependent-care';
import { lifePlanningStage } from './life-stage';
import { intentById, livingPeople, personById, projectById } from './state-index';
import {
  isActionableChaosPrediction,
  personTrustsEraPrediction,
} from './era-prediction';
import { observedHibernationEntryEvidence } from './hibernation-entry';
import { validateWildlifeThreatResponse, wildlifeThreatResponseDiff } from './wildlife-threat';
import { huntingToolBonus, isProductionToolMaterial, productionToolMultiplier } from './production-tool';
import {
  bereavementFor,
  memorialForRemains,
  remainsById,
} from './mortuary';
import {
  movementMetabolicMultiplier,
  reproductiveUpperAgeMonths,
  traitStatesOf,
} from './trait';
import {
  MECHANICAL_POWER_WORLD_VERSION,
  mechanicalPowerFaultObservationFactId,
  mechanicalPowerPlanKey,
  waterCurrentAvailabilityFor,
} from './mechanical-power';
import { addContainerInventory, addDrop, addInventory, removeEmptyStacks } from './actions/inventory';
import {
  bodyOccupies,
  bodyStandsOn,
  clamp,
  distanceToPosition,
  nearbyFacilityMaterial,
  nearbyFacilityMaterialAtCell,
  samePosition,
} from './actions/execution-helpers';
import { executeMechanicalPowerAction } from './actions/mechanical-power-actions';
import {
  executeElectricalPowerAction,
  executeElectricalPowerFaultAttend,
} from './actions/electrical-power-actions';
import { executeMortuary } from './actions/mortuary-actions';
import { rememberMineralDeposit } from './actions/material-observations';
import {
  applyTechniqueLearning,
  validateTechniqueLearningAction,
} from './actions/technique-learning-actions';
import { executeCommunicate } from './actions/communication-actions';
import { executeMeasurementAttend } from './actions/measurement-actions';

export { addDrop, addInventory } from './actions/inventory';

function projectMaterialDeliveryForTransfer(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'transfer' }>,
  atMonth: number,
): DropState['projectMaterialDelivery'] | undefined {
  if (action.to.kind !== 'ground'
    || action.from.kind !== 'person'
    || action.from.personId !== person.id
    || !action.authorizationRef) return undefined;
  for (const project of state.projects) {
    if (project.status !== 'active' || project.ownerId === person.id) continue;
    const request = project.materialContributionRequests?.find((candidate) => (
      candidate.requestEventId === action.authorizationRef
      && candidate.contributorIds.includes(person.id)
      && candidate.materialId === action.materialId
      && candidate.expiresAtMonth >= atMonth
    ));
    const demand = request
      ? project.materialDemands?.find((candidate) => candidate.materialId === request.materialId)
      : undefined;
    if (!request || !demand
      || inspectProjectMaterialContributionRequest(state, project, request, atMonth, demand).status !== 'open') continue;
    return {
      version: 'project-material-delivery-v1',
      projectId: project.id,
      requestEventId: request.requestEventId,
      requesterId: request.requesterId,
      expiresAtMonth: request.expiresAtMonth,
    };
  }
  return undefined;
}

function conditionWorkMultiplier(person: PersonState): number {
  let multiplier = 1;
  if (person.body.hydration < 10) multiplier *= 0.35;
  else if (person.body.hydration < 35) multiplier *= 0.75;
  if (person.body.nutrition < 10) multiplier *= 0.45;
  else if (person.body.nutrition < 35) multiplier *= 0.8;
  if (person.body.hydration >= 60 && person.body.nutrition >= 70) multiplier *= 1.1;
  for (const condition of person.conditions) {
    if (condition.kind === 'cold') multiplier *= [1, 0.85, 0.65, 0.4][condition.stage];
    if (condition.kind === 'heat') multiplier *= [1, 0.9, 0.7, 0.45][condition.stage];
    if (condition.kind === 'wound' || condition.kind === 'illness') multiplier *= [1, 0.88, 0.68, 0.45][condition.stage];
    if (condition.kind === 'aging') multiplier *= [1, 0.95, 0.8, 0.55][condition.stage];
    if (condition.kind === 'pregnancy') multiplier *= condition.stage >= 3 ? 0.65 : 0.88;
    if (condition.kind === 'postpartum-recovery') multiplier *= condition.stage >= 3 ? 0.78 : condition.stage === 2 ? 0.88 : 0.96;
    if (condition.kind === 'restrained') multiplier *= 0.25;
  }
  return Math.max(0.2, Math.min(1.5, multiplier));
}

function canonicalStringIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  const canonical = [...new Set(value as string[])].sort();
  return canonical.length === value.length
    && canonical.every((item, index) => item === value[index])
    ? canonical
    : null;
}

function inputWitnesses(value: unknown): RecordUseInputWitnessV1[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const witnesses: RecordUseInputWitnessV1[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const raw = candidate as Record<string, unknown>;
    const sourceEventIds = canonicalStringIds(raw.sourceEventIds);
    if (raw.version !== 'record-use-input-witness-v1'
      || (raw.role !== 'input' && raw.role !== 'tool')
      || typeof raw.personId !== 'string'
      || typeof raw.stackId !== 'string'
      || !Number.isInteger(raw.materialId)
      || !Number.isInteger(raw.quantity)
      || Number(raw.quantity) < 1
      || !sourceEventIds) return null;
    let genesisEntity: RecordUseInputWitnessV1['genesisEntity'];
    if (raw.genesisEntity !== undefined) {
      if (!raw.genesisEntity || typeof raw.genesisEntity !== 'object') return null;
      const genesis = raw.genesisEntity as Record<string, unknown>;
      if (genesis.kind !== 'founder-ration'
        || typeof genesis.personId !== 'string'
        || typeof genesis.stackId !== 'string'
        || !Number.isInteger(genesis.materialId)) return null;
      genesisEntity = {
        kind: 'founder-ration',
        personId: genesis.personId,
        stackId: genesis.stackId,
        materialId: Number(genesis.materialId) as MaterialId,
      };
    }
    witnesses.push({
      version: 'record-use-input-witness-v1',
      role: raw.role,
      personId: raw.personId,
      stackId: raw.stackId,
      materialId: Number(raw.materialId) as MaterialId,
      quantity: Number(raw.quantity),
      sourceEventIds,
      ...(genesisEntity ? { genesisEntity } : {}),
    });
  }
  const keys = witnesses.map((witness) => `${witness.role}:${witness.stackId}`);
  return new Set(keys).size === keys.length ? witnesses : null;
}

function sameInputWitnesses(
  left: RecordUseInputWitnessV1[],
  right: RecordUseInputWitnessV1[],
): boolean {
  return left.length === right.length && left.every((witness, index) => {
    const other = right[index];
    return witness.version === other.version
      && witness.role === other.role
      && witness.personId === other.personId
      && witness.stackId === other.stackId
      && witness.materialId === other.materialId
      && witness.quantity === other.quantity
      && witness.sourceEventIds.length === other.sourceEventIds.length
      && witness.sourceEventIds.every((sourceEventId, sourceIndex) => sourceEventId === other.sourceEventIds[sourceIndex])
      && witness.genesisEntity?.kind === other.genesisEntity?.kind
      && witness.genesisEntity?.personId === other.genesisEntity?.personId
      && witness.genesisEntity?.stackId === other.genesisEntity?.stackId
      && witness.genesisEntity?.materialId === other.genesisEntity?.materialId;
  });
}

function eventProducesOrTransfersMaterial(event: NonNullable<ReturnType<typeof worldEventById>>, materialId: MaterialId): boolean {
  const listedMaterial = (value: unknown): boolean => Array.isArray(value)
    && value.some((item) => item && typeof item === 'object'
      && Number((item as Record<string, unknown>).materialId) === materialId);
  if (event.kind === 'action') {
    if (event.status !== 'completed') return false;
    if (event.action.kind === 'transfer') return event.action.materialId === materialId
      && Number(event.diff.materialId) === materialId;
    return Number(event.diff.outputMaterialId) === materialId
      || Number(event.diff.materialId) === materialId
      || listedMaterial(event.diff.outputs)
      || listedMaterial(event.diff.products);
  }
  if (event.kind !== 'environment') return false;
  return Number(event.diff.materialId) === materialId
    || Number(event.diff.outputMaterialId) === materialId
    || listedMaterial(event.diff.outputs)
    || listedMaterial(event.diff.products);
}

function canonicalFounderRationWitness(
  person: PersonState,
  witness: RecordUseInputWitnessV1,
): boolean {
  return witness.sourceEventIds.length === 0
    && witness.genesisEntity?.kind === 'founder-ration'
    && person.generation === 0
    && witness.role === 'input'
    && witness.stackId === `stack-${person.id}-ration`
    && witness.materialId === Material.Food
    && witness.genesisEntity.personId === person.id
    && witness.genesisEntity.stackId === witness.stackId
    && witness.genesisEntity.materialId === witness.materialId;
}

function sameReplicationGoal(
  left: FactPredicate,
  right: Extract<FactPredicate, { kind: 'record-replication-receipt' }>,
): boolean {
  return left.kind === 'record-replication-receipt'
    && left.basisKey === right.basisKey
    && left.readerId === right.readerId
    && left.projectId === right.projectId
    && left.recordId === right.recordId
    && left.recordVersion === right.recordVersion
    && left.techniqueId === right.techniqueId
    && left.ruleSignature === right.ruleSignature
    && left.expectedOutputMaterialId === right.expectedOutputMaterialId;
}

export function actionSatisfiesRecordReplicationReceipt(
  state: SimulationState,
  fact: ActionFact,
  goal: Extract<FactPredicate, { kind: 'record-replication-receipt' }>,
): boolean {
  if (fact.status !== 'completed'
    || fact.who !== goal.readerId
    || !fact.intentId
    || fact.action.kind !== 'act'
    || (fact.action.operation !== 'combine'
      && fact.action.operation !== 'exert'
      && fact.action.operation !== 'expose')
    || fact.diff.recordUseReplicationReceipt !== true
    || fact.diff.recordUsePurpose !== 'replicate'
    || fact.diff.recordUseStage !== 'replicate'
    || fact.diff.recordUseBasisKey !== goal.basisKey
    || fact.diff.recordUseReaderId !== goal.readerId
    || fact.diff.recordUseProjectId !== goal.projectId
    || fact.diff.recordUseRecordId !== goal.recordId
    || fact.diff.recordUseRecordVersion !== goal.recordVersion
    || fact.diff.recordUseTechniqueId !== goal.techniqueId
    || fact.diff.recordUseRuleSignature !== goal.ruleSignature
    || Number(fact.diff.recordUseExpectedOutputMaterialId) !== goal.expectedOutputMaterialId
    || Number(fact.diff.outputMaterialId) !== goal.expectedOutputMaterialId
    || fact.diff.techniqueId !== goal.techniqueId
    || fact.diff.sourceEventId !== fact.id) return false;

  const person = personById(state, goal.readerId);
  const intent = intentById(state, fact.intentId);
  const basis = intent?.recordUseBasis;
  const project = projectById(state, goal.projectId);
  const record = state.records.find((candidate) => candidate.id === goal.recordId && candidate.kind === 'technique');
  const reliableTechnique = person?.knowledge.find((knowledge) => knowledge.id === goal.techniqueId
    && knowledge.kind === 'technique'
    && knowledge.confidence >= 55);
  if (!person
    || !intent
    || (intent.status !== 'active' && intent.status !== 'completed')
    || intent.ownerId !== person.id
    || intent.recordUseStage !== 'replicate'
    || basis?.version !== 'record-use-basis-v3'
    || (basis.purpose ?? 'learn') !== 'replicate'
    || !sameReplicationGoal(intent.goal, goal)
    || basis.basisKey !== goal.basisKey
    || basis.readerId !== goal.readerId
    || basis.projectId !== goal.projectId
    || basis.demand.projectId !== goal.projectId
    || basis.recordId !== goal.recordId
    || basis.recordVersion !== goal.recordVersion
    || basis.knowledgeId !== goal.techniqueId
    || basis.techniqueId !== goal.techniqueId
    || basis.ruleSignature !== goal.ruleSignature
    || basis.expectedOutputMaterialId !== goal.expectedOutputMaterialId
    || basis.projectRenewalBasisKey !== fact.diff.recordUseProjectRenewalBasisKey
    || !intent.actionEventIds.includes(fact.id)
    || project?.ownerId !== person.id
    || !project.actionEventIds.includes(fact.id)
    || !record
    || record.authorId === person.id
    || record.authorId !== basis.recordAuthorId
    || record.version !== goal.recordVersion
    || record.knowledgeId !== goal.techniqueId
    || record.codebookId !== basis.codebookId
    || !reliableTechnique) return false;

  const carrierSource = basis.carrierSource;
  const carrierPresent = carrierSource.kind === 'inventory'
    ? person.inventory.some((stack) => stack.id === carrierSource.stackId
      && stack.quantity > 0
      && stack.recordPayloadId === record.id)
    : person.inventory.some((stack) => stack.quantity > 0
      && stack.recordPayloadId === record.id
      && stack.sourceLineageKeys?.includes(`drop:${carrierSource.dropId}`));
  if (!carrierPresent) return false;

  const basisWitnesses = inputWitnesses(basis.inputWitnesses);
  const factWitnesses = inputWitnesses(fact.diff.recordUseInputWitnesses);
  const factInputSources = canonicalStringIds(fact.diff.recordUseInputSourceEventIds);
  const basisInputSources = canonicalStringIds(basis.inputSourceEventIds);
  if (!basisWitnesses || !factWitnesses || !factInputSources || !basisInputSources
    || !sameInputWitnesses(basisWitnesses, factWitnesses)) return false;

  const stackRefs = fact.action.targets.filter((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => (
    target.kind === 'inventory-stack'
  ));
  if (stackRefs.some((ref) => ref.personId !== person.id)) return false;
  const expectedWitnessQuantities = new Map<string, number>();
  for (const ref of stackRefs) {
    const key = `input:${ref.stackId}`;
    expectedWitnessQuantities.set(key, (expectedWitnessQuantities.get(key) ?? 0) + 1);
  }
  const voxelTarget = fact.action.targets.some((target) => target.kind === 'voxel');
  if ((fact.action.operation === 'combine' && !voxelTarget && stackRefs.length < 2)
    || ((fact.action.operation === 'combine' && voxelTarget) || fact.action.operation === 'expose') && stackRefs.length !== 1) return false;
  if (fact.action.operation === 'exert') {
    if (stackRefs.length !== 1 || !fact.action.toolStackId) return false;
    expectedWitnessQuantities.set(`tool:${fact.action.toolStackId}`, 1);
  }
  if (basisWitnesses.length !== expectedWitnessQuantities.size
    || basisWitnesses.some((witness) => (
      witness.personId !== person.id
      || expectedWitnessQuantities.get(`${witness.role}:${witness.stackId}`) !== witness.quantity
    ))) return false;

  const inputMaterials = stackRefs.map((ref) => basisWitnesses.find((witness) => (
    witness.role === 'input' && witness.stackId === ref.stackId
  ))?.materialId);
  if (inputMaterials.some((materialId) => materialId === undefined)) return false;
  if (fact.action.operation === 'combine' && !voxelTarget) {
    const inputMaterialIds = fact.diff.inputMaterialIds;
    if (!Array.isArray(inputMaterialIds)
      || inputMaterialIds.length !== inputMaterials.length
      || inputMaterials.some((materialId, index) => Number(inputMaterialIds[index]) !== materialId)) return false;
  } else if (Number(fact.diff.inputMaterialId) !== inputMaterials[0]) return false;
  if (fact.action.operation === 'exert') {
    const toolWitness = basisWitnesses.find((witness) => witness.role === 'tool');
    if (!toolWitness || Number(fact.diff.toolMaterialId) !== toolWitness.materialId) return false;
  }

  const witnessedSources = [...new Set(basisWitnesses.flatMap((witness) => witness.sourceEventIds))].sort();
  if (witnessedSources.length !== basisInputSources.length
    || witnessedSources.some((sourceEventId, index) => sourceEventId !== basisInputSources[index])
    || witnessedSources.length !== factInputSources.length
    || witnessedSources.some((sourceEventId, index) => sourceEventId !== factInputSources[index])
    || witnessedSources.some((sourceEventId) => !basis.sourceFactIds.includes(sourceEventId))) return false;
  return basisWitnesses.every((witness) => {
    if (witness.sourceEventIds.length === 0) return canonicalFounderRationWitness(person, witness);
    if (witness.genesisEntity !== undefined) return false;
    const sources = witness.sourceEventIds.map((sourceEventId) => worldEventById(state, sourceEventId));
    return sources.every((source) => Boolean(source
      && compareWorldEventsInCanonicalOrder(source, fact) < 0))
      && sources.some((source) => Boolean(source
        && eventProducesOrTransfersMaterial(source, witness.materialId)));
  });
}

export function goalSatisfied(state: SimulationState, person: PersonState, goal: FactPredicate): boolean {
  if (goal.kind === 'body-at-least') return person.body[goal.field] >= goal.value;
  if (goal.kind === 'body-at-most') return (personById(state, goal.personId)?.body[goal.field] ?? Number.POSITIVE_INFINITY) <= goal.value;
  if (goal.kind === 'inventory-at-least') {
    const owner = goal.personId ? personById(state, goal.personId) : person;
    return owner ? inventoryQuantity(owner, goal.materialId) >= goal.quantity : false;
  }
  if (goal.kind === 'record-held') {
    const owner = goal.personId ? personById(state, goal.personId) : person;
    return owner?.inventory.some((stack) => stack.quantity > 0 && stack.recordPayloadId === goal.recordId) ?? false;
  }
  if (goal.kind === 'container-inventory-at-least') {
    const container = containerById(state, goal.containerId);
    return Boolean(container && containerQuantity(container, goal.materialId) >= goal.quantity);
  }
  if (goal.kind === 'at-cell') return person.position.cellId === goal.cellId;
  if (goal.kind === 'sheltered') return Boolean(shelterGeometryAt(state.world.grid, person.position));
  if (goal.kind === 'voxel-is') return voxelAt(state.world.grid, goal.position.x, goal.position.y, goal.position.z) === goal.materialId;
  if (goal.kind === 'knowledge') return (goal.personId ? personById(state, goal.personId) : person)?.knowledge.some((fact) => fact.id === goal.factId && fact.confidence >= (goal.minConfidence ?? 0)) ?? false;
  if (goal.kind === 'record-replication-receipt') {
    const project = projectById(state, goal.projectId);
    const record = state.records.find((candidate) => candidate.id === goal.recordId);
    if (person.id !== goal.readerId
      || project?.ownerId !== goal.readerId
      || record?.version !== goal.recordVersion
      || record.authorId === goal.readerId
      || record.knowledgeId !== goal.techniqueId) return false;
    return project.actionEventIds.some((eventId) => {
      const event = worldEventById(state, eventId);
      return event?.kind === 'action' && actionSatisfiesRecordReplicationReceipt(state, event, goal);
    });
  }
  if (goal.kind === 'near-person') {
    const other = personById(state, goal.personId);
    return Boolean(other && sameLocation(person, other));
  }
  if (goal.kind === 'condition') {
    const matchingCondition = personById(state, goal.personId)
      ?.conditions.find((condition) => condition.kind === goal.condition);
    if (!goal.present) return matchingCondition === undefined;
    return Boolean(matchingCondition && (!goal.phase || hibernationPhase(matchingCondition) === goal.phase));
  }
  if (goal.kind === 'project-completed') return projectById(state, goal.projectId)?.status === 'completed';
  if (goal.kind === 'technique-demonstrated') return projectById(state, goal.projectId)
    ?.techniqueDemonstrations?.some((basis) => basis.requestEventId === goal.requestEventId) ?? false;
  if (goal.kind === 'agreement-fulfilled') return agreementById(state, goal.agreementId)?.status === 'fulfilled';
  if (goal.kind === 'death-mourned') return bereavementFor(person, goal.remainsId)?.lastMournedAtMonth !== undefined;
  if (goal.kind === 'remains-interred') return remainsById(state, goal.remainsId)?.status === 'interred';
  if (goal.kind === 'memorial-marked') return Boolean(memorialForRemains(state, goal.remainsId));
  return Boolean(communicationById(state, goal.representationId));
}

function targetCell(state: SimulationState, target: WorldRef): number | null {
  if (target.kind === 'voxel') return cellId(target.position.x, target.position.y);
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.cellId ?? null;
  if (target.kind === 'container') {
    const container = containerById(state, target.containerId);
    return container ? cellId(container.position.x, container.position.y) : null;
  }
  if (target.kind === 'person') return personById(state, target.personId)?.position.cellId ?? null;
  if (target.kind === 'animal') return state.world.animals.find((animal) => animal.id === target.animalId)?.position.cellId ?? null;
  if (target.kind === 'remains') return remainsById(state, target.remainsId)?.position.cellId ?? null;
  return personById(state, target.personId)?.position.cellId ?? null;
}

function compactTraversedSurface(state: SimulationState, path: StandingPosition[], eventId: string): Array<{ cellId: number; z: number; from: MaterialId; to: MaterialId }> {
  const changes: Array<{ cellId: number; z: number; from: MaterialId; to: MaterialId }> = [];
  state.world.traffic ??= {};
  for (const traversed of path.slice(1)) {
    const trafficKey = `${traversed.cellId}:${traversed.z}`;
    const priorTraffic = state.world.traffic[trafficKey] ?? 0;
    state.world.traffic[trafficKey] = priorTraffic + 1;
    const x = cellX(traversed.cellId);
    const y = cellY(traversed.cellId);
    const supportZ = traversed.z - 1;
    const from = voxelAt(state.world.grid, x, y, supportZ);
    const to = from === Material.Grass && priorTraffic >= 2
      ? Material.Soil
      : from === Material.Soil && priorTraffic >= 6
        ? Material.PackedSoil
        : from;
    if (to === from) continue;
    setVoxel(state.world.grid, x, y, supportZ, to);
    changes.push({ cellId: traversed.cellId, z: supportZ, from, to });
  }
  void eventId;
  return changes;
}

function executeMove(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'move' }>, eventId: string, atMonth: number) {
  if (isDormantDehydratedHibernating(person)) return { status: 'blocked' as const, path: [person.position.cellId], result: '处于低代谢休眠，无法移动', diff: {} };
  if (person.conditions.some((condition) => condition.kind === 'restrained')) return { status: 'blocked' as const, path: [person.position.cellId], result: '身体受到拘束，无法远距离移动', diff: {} };
  const threatValidation = action.wildlifeThreatBasis
    ? action.toZ === undefined
      ? { valid: false as const, reason: '野兽威胁响应缺少精确站立高度' }
      : validateWildlifeThreatResponse(
        state,
        person,
        atMonth,
        { cellId: action.toCellId, z: action.toZ },
        action.wildlifeThreatBasis,
      )
    : null;
  if (threatValidation && !threatValidation.valid) return {
    status: 'blocked' as const,
    path: [person.position.cellId],
    result: threatValidation.reason,
    diff: { wildlifeThreatResponse: true, wildlifeThreatResponseInvalidated: true },
  };
  const fullPath = findStandingPath(state.world.grid, person.position, { cellId: action.toCellId, ...(action.toZ === undefined ? {} : { z: action.toZ }) });
  if (!fullPath.length) return { status: 'blocked' as const, path: [person.position.cellId], result: '目标地表当前不可达', diff: {} };
  // 一个 move 仍沿逐格连续路径执行；低成本道路可在同一规则刻度继续跨过下一条边。
  const segment = standingPathSegmentForTick(state.world.grid, fullPath);
  const from = { cellId: person.position.cellId, z: person.position.z };
  const to = segment.at(-1) ?? from;
  const moved = to.cellId !== from.cellId || to.z !== from.z;
  const movementCost = moved ? standingPathMovementCost(state.world.grid, segment) : 0;
  const spent = movementCost / conditionWorkMultiplier(person);
  person.position.cellId = to.cellId;
  person.position.z = to.z;
  if (moved) person.position.lastPath.push(...segment.slice(1).map((position) => position.cellId));
  const carried = !moved ? [] : livingPeople(state).filter((candidate) =>
    candidate.position.cellId === from.cellId
    && candidate.position.z === from.z
    && candidate.geneticParents.includes(person.id)
    && lifePlanningStage(candidate, atMonth) === 'dependent-child'
    && !isDormantDehydratedHibernating(candidate));
  for (const dependent of carried) {
    dependent.position.cellId = to.cellId;
    dependent.position.z = to.z;
    dependent.position.lastPath.push(...segment.slice(1).map((position) => position.cellId));
  }
  const carriedRemains = moved
    ? (state.world.remains ?? []).filter((remains) => remains.carriedByPersonId === person.id)
    : [];
  for (const remains of carriedRemains) remains.position = { cellId: to.cellId, z: to.z };
  const movementMetabolism = movementMetabolicMultiplier(person);
  person.body.hydration = clamp(person.body.hydration - movementCost * 0.125 * movementMetabolism);
  person.body.nutrition = clamp(person.body.nutrition - movementCost * 0.08 * movementMetabolism);
  const materialChanges = compactTraversedSurface(state, segment, eventId);
  const reached = to.cellId === action.toCellId && (action.toZ === undefined || to.z === action.toZ);
  const threatDiff = action.wildlifeThreatBasis
    ? wildlifeThreatResponseDiff(from, to, action.wildlifeThreatBasis)
    : {};
  return {
    status: reached ? 'completed' as const : 'progressed' as const,
    path: segment.map((position) => position.cellId),
    result: action.wildlifeThreatBasis
      ? action.wildlifeThreatBasis.response === 'shelter-step'
        ? `${person.name}向真实住所移动一步，避开可见野兽威胁`
        : action.wildlifeThreatBasis.response === 'flee-step'
          ? `${person.name}与可见野兽拉开距离`
          : `${person.name}无安全退路，原地警戒野兽`
      : reached ? `沿可容身空间到达格 ${cellX(to.cellId)}, ${cellY(to.cellId)} 的高度 ${to.z}` : `沿可容身空间推进了 ${Math.max(0, segment.length - 1)} 步`,
    diff: {
      spentWork: spent,
      movementCost,
      movementMetabolism,
      verticalPath: segment.map((position) => position.z),
      materialChanges,
      ...threatDiff,
      ...(carried.length ? { carriedPersonIds: carried.map((dependent) => dependent.id) } : {}),
      ...(carriedRemains.length ? { carriedRemainsIds: carriedRemains.map((remains) => remains.id) } : {}),
    },
  };
}

function executeTransfer(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'transfer' }>, atMonth: number, eventId: string) {
  let available = 0;
  let sourceDrop: DropState | undefined;
  let sourcePerson: PersonState | undefined;
  let sourceContainer: ContainerState | undefined;
  let sourceStack: ItemStack | undefined;
  if (action.from.kind === 'ground') {
    const groundCellId = action.from.cellId;
    sourceDrop = state.world.drops.find((drop) => (action.dropId ? drop.id === action.dropId : drop.cellId === groundCellId && drop.materialId === action.materialId));
    const sourceZ = action.from.z ?? sourceDrop?.z;
    if (groundCellId !== person.position.cellId || sourceZ !== person.position.z) return { status: 'blocked' as const, result: '不在地面物品所在位置', diff: {} };
    available = sourceDrop?.quantity ?? 0;
  } else if (action.from.kind === 'person') {
    const sourcePersonId = action.from.personId;
    sourcePerson = personById(state, sourcePersonId);
    if (!sourcePerson || !sameLocation(sourcePerson, person)) return { status: 'blocked' as const, result: '物品持有者不在近身范围', diff: {} };
    sourceStack = sourcePerson.inventory.find((stack) => (action.stackId ? stack.id === action.stackId : stack.materialId === action.materialId));
    available = sourceStack?.quantity ?? 0;
  } else {
    sourceContainer = containerById(state, action.from.containerId);
    if (!sourceContainer || !canAccessContainer(person, sourceContainer)) return { status: 'blocked' as const, result: '不在容器的近身操作范围', diff: {} };
    sourceStack = sourceContainer.inventory.find((stack) => (action.stackId ? stack.id === action.stackId : stack.materialId === action.materialId));
    available = sourceStack?.quantity ?? 0;
  }
  if (available <= 0) return { status: 'blocked' as const, result: '来源中已经没有这种物质', diff: {} };
  if (sourceDrop && !canPersonCollectProjectMaterialDrop(state, person.id, sourceDrop, atMonth)) {
    return {
      status: 'blocked' as const,
      result: '这份地面物料仍在等待原项目请求者查收',
      diff: {
        authorized: false,
        projectMaterialDeliveryRestricted: true,
        projectId: sourceDrop.projectMaterialDelivery?.projectId,
        requestEventId: sourceDrop.projectMaterialDelivery?.requestEventId,
        expiresAtMonth: sourceDrop.projectMaterialDelivery?.expiresAtMonth,
      },
    };
  }
  const estateCareRemains = action.estateCarePersonId
    ? (state.world.remains ?? []).find((remains) => remains.personId === action.estateCarePersonId)
    : undefined;
  if (action.estateCarePersonId
    && (!sourceDrop
      || sourceDrop.estateOfPersonId !== action.estateCarePersonId
      || !estateCareRemains
      || !bereavementFor(person, estateCareRemains.id))) {
    return { status: 'blocked' as const, result: '收拢遗物必须绑定本人知晓的死者与其真实地面遗物', diff: {} };
  }
  let destinationPerson: PersonState | undefined;
  let destinationContainer: ContainerState | undefined;
  if (action.to.kind === 'person') {
    const receiverId = action.to.personId;
    destinationPerson = personById(state, receiverId);
    if (!destinationPerson || !sameLocation(destinationPerson, person)) return { status: 'blocked' as const, result: '接收者不在近身范围', diff: {} };
  } else if (action.to.kind === 'container') {
    destinationContainer = containerById(state, action.to.containerId);
    if (!destinationContainer || !canAccessContainer(person, destinationContainer)) return { status: 'blocked' as const, result: '目标容器不在近身操作范围', diff: {} };
  } else {
    const destinationZ = action.to.z ?? person.position.z;
    if (action.to.cellId !== person.position.cellId || destinationZ !== person.position.z) {
      return { status: 'blocked' as const, result: '只能把物品放到本人当前所在的地面位置', diff: {} };
    }
  }
  const containerCapacity = destinationContainer ? containerRemainingCapacity(destinationContainer) : Number.POSITIVE_INFINITY;
  if (containerCapacity <= 0) return { status: 'blocked' as const, result: '目标容器已经没有可用容量', diff: { containerId: destinationContainer?.id } };
  const quantity = Math.max(1, Math.min(action.quantity, available, containerCapacity));
  const projectMaterialDelivery = projectMaterialDeliveryForTransfer(state, person, action, atMonth);
  const possibleAgreement = action.authorizationRef ? agreementById(state, action.authorizationRef) : undefined;
  const agreementAuthorized = agreementAuthorizesTransfer(possibleAgreement, person.id, action, quantity);
  const possiblePermission = action.authorizationRef ? permissionById(state, action.authorizationRef) : undefined;
  const permissionAuthorized = permissionAuthorizesTransfer(possiblePermission, person.id, action, atMonth, quantity);
  const possibleMandate = action.authorizationRef ? mandateById(state, action.authorizationRef) : undefined;
  const mandateUse = mandateSupportsTransfer(state, possibleMandate, person.id, action, atMonth);
  const mandateAuthorized = Boolean(mandateUse);
  const referencedNorm = agreementAuthorized ? possibleAgreement : permissionAuthorized ? possiblePermission : mandateAuthorized ? possibleMandate : undefined;
  // 容器目前只是空间持有者，不自带所有权；以后由 claim/title 决定规范授权。
  const authorized = action.from.kind === 'ground' || action.from.kind === 'container' || action.from.personId === person.id || agreementAuthorized || permissionAuthorized || mandateAuthorized;
  const witnessedBy = state.people.filter((candidate) => sameLocation(candidate, person)).map((candidate) => candidate.id);
  if (!authorized && sourcePerson && sourcePerson.body.health > 20 && !sourcePerson.conditions.some((condition) => condition.kind === 'restrained')) {
    applyRelationEvidence(sourcePerson, person.id, eventId, { trust: -7, fear: 3 });
    return { status: 'blocked' as const, result: `${sourcePerson.name}阻止了未经授权的取物`, diff: { authorized: false, attempted: true, resistedBy: sourcePerson.id, witnessedBy } };
  }
  if (sourceDrop) sourceDrop.quantity -= quantity;
  if (sourceStack && sourcePerson) {
    sourceStack.quantity -= quantity;
    removeEmptyStacks(sourcePerson);
  }
  if (sourceStack && sourceContainer) {
    sourceStack.quantity -= quantity;
    sourceContainer.inventory = sourceContainer.inventory.filter((stack) => stack.quantity > 0);
    sourceContainer.sourceEventIds = [...new Set([...sourceContainer.sourceEventIds, eventId])].slice(-24);
  }
  if (!authorized && sourcePerson) {
    for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id) && candidate.id !== person.id)) {
      applyRelationEvidence(witness, person.id, eventId, { trust: witness.id === sourcePerson.id ? -12 : -5, fear: witness.id === sourcePerson.id ? 8 : 2 });
    }
  }
  const sourceEventIds = [...new Set([
    ...(sourceDrop?.sourceEventIds ?? []),
    ...(sourceStack?.sourceEventIds ?? []),
    eventId,
  ])];
  const sourceLineageKeys = [...new Set([
    ...(sourceDrop ? [`drop:${sourceDrop.id}`, ...(sourceDrop.sourceLineageKeys ?? [])] : []),
    ...(sourceStack && sourcePerson
      ? [`inventory:${sourcePerson.id}:${sourceStack.id}`, ...(sourceStack.sourceLineageKeys ?? [])]
      : []),
    ...(sourceStack && sourceContainer
      ? [`container:${sourceContainer.id}:${sourceStack.id}`, ...(sourceStack.sourceLineageKeys ?? [])]
      : []),
  ])];
  if (sourceDrop) {
    rememberMineralDeposit(person, sourceDrop.materialId, {
      x: cellX(sourceDrop.cellId),
      y: cellY(sourceDrop.cellId),
      z: sourceDrop.z,
    }, atMonth, eventId);
  }
  if (destinationPerson) {
    addInventory(
      destinationPerson,
      action.materialId,
      quantity,
      sourceEventIds,
      `stack-${destinationPerson.id}-${action.materialId}-${atMonth}`,
      sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId,
      sourceLineageKeys,
    );
    if (destinationPerson.id !== person.id && !referencedNorm) {
      applyRelationEvidence(destinationPerson, person.id, eventId, { trust: authorized ? 3 : -8, bond: authorized ? 2 : -5 });
    }
  } else if (destinationContainer) {
    addContainerInventory(
      destinationContainer,
      action.materialId,
      quantity,
      sourceEventIds,
      `stack-${destinationContainer.id}-${action.materialId}-${atMonth}`,
      sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId,
      sourceLineageKeys,
    );
    destinationContainer.sourceEventIds = [...new Set([...destinationContainer.sourceEventIds, eventId])].slice(-24);
  } else if (action.to.kind === 'ground') {
    addDrop(
      state,
      action.materialId,
      quantity,
      action.to.cellId,
      atMonth,
      sourceEventIds,
      `${person.id}-put`,
      sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId,
      action.to.z ?? person.position.z,
      sourceLineageKeys,
      undefined,
      projectMaterialDelivery,
    );
  }
  state.world.drops = state.world.drops.filter((drop) => drop.quantity > 0);
  return {
    status: 'completed' as const,
    result: `${materialDefinition(action.materialId).name} × ${quantity} ${authorized ? '改变了持有者' : '被未经授权地取走'}`,
    diff: {
      materialId: action.materialId,
      quantity,
      authorized,
      agreementAuthorized,
      permissionAuthorized,
      mandateAuthorized,
      mandateUse,
      from: action.from,
      to: action.to,
      witnessedBy,
      sourceEventIds: sourceEventIds.slice(-24),
      sourceLineageKeys: sourceLineageKeys.slice(-32),
      ...((sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId) ? { recordPayloadId: sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId } : {}),
      ...(sourceDrop?.estateOfPersonId ? { estateOfPersonId: sourceDrop.estateOfPersonId } : {}),
      ...(action.estateCarePersonId ? { estateCare: true, estateCarePersonId: action.estateCarePersonId } : {}),
      ...(projectMaterialDelivery ? { projectMaterialDelivery } : {}),
    },
  };
}

function consumeStack(person: PersonState, stack: ItemStack): { materialId: MaterialId; nutrition: number; hydration: number; health: number } {
  const definition = materialDefinition(stack.materialId);
  stack.quantity -= 1;
  removeEmptyStacks(person);
  const nutrition = definition.consume?.nutrition ?? 0;
  const hydration = definition.consume?.hydration ?? 0;
  const health = definition.consume?.health ?? 0;
  person.body.nutrition = clamp(person.body.nutrition + nutrition);
  person.body.hydration = clamp(person.body.hydration + hydration);
  person.body.health = clamp(person.body.health + health);
  return { materialId: definition.id, nutrition, hydration, health };
}

function executeIngest(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const target = targets[0];
  if (!target) return { status: 'failed' as const, result: '没有摄入对象', diff: {} };
  if (target.kind === 'inventory-stack') {
    if (target.personId !== person.id) return { status: 'blocked' as const, result: '不能直接摄入他人背包物品', diff: {} };
    const stack = person.inventory.find((candidate) => candidate.id === target.stackId && candidate.quantity > 0);
    if (!stack || (!materialHas(stack.materialId, 'edible') && !materialHas(stack.materialId, 'drinkable'))) return { status: 'blocked' as const, result: '目标当前不可摄入', diff: {} };
    const consumedStackId = stack.id;
    const consumedSourceEventIds = [...stack.sourceEventIds].slice(-24);
    const consumedSourceLineageKeys = [...(stack.sourceLineageKeys ?? [])].slice(-32);
    const consumed = consumeStack(person, stack);
    return {
      status: 'completed' as const,
      result: `摄入了${materialDefinition(consumed.materialId).name}`,
      diff: { ...consumed, consumedStackId, consumedSourceEventIds, consumedSourceLineageKeys },
    };
  }
  if (target.kind === 'voxel') {
    const materialId = voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z);
    if (distanceToPosition(person, target.position) > 1 || !materialHas(materialId, 'drinkable')) return { status: 'blocked' as const, result: '饮用物不在近身范围', diff: {} };
    const consumed = materialDefinition(materialId).consume ?? {};
    person.body.hydration = clamp(person.body.hydration + (consumed.hydration ?? 0));
    person.body.nutrition = clamp(person.body.nutrition + (consumed.nutrition ?? 0));
    person.body.health = clamp(person.body.health + (consumed.health ?? 0));
    rememberMaterialPlace(person, materialId, target.position, atMonth, eventId);
    return { status: 'completed' as const, result: `从地表摄入了${materialDefinition(materialId).name}`, diff: { materialId, ...consumed } };
  }
  return { status: 'blocked' as const, result: '这个对象不能被摄入', diff: {} };
}

function executeSeparate(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const targets = action.targets;
  const target = targets[0];
  if (target?.kind === 'person') {
    const restrainedCandidate = personById(state, target.personId);
    const restrained = restrainedCandidate && sameLocation(restrainedCandidate, person) ? restrainedCandidate : undefined;
    const condition = restrained?.conditions.find((item) => item.kind === 'restrained');
    if (!restrained || !condition) return { status: 'blocked' as const, result: '近身目标身上没有可分离的拘束物质', diff: {} };
    const selfRelease = restrained.id === person.id;
    const chance = selfRelease ? Math.min(0.72, 0.12 + person.baselineCapacities.manipulation / 180) : 1;
    const sample = seededFraction(state.seed, `release-restraint:${atMonth}:${person.id}:${restrained.id}:${condition.id}`);
    if (sample >= chance) return { status: 'progressed' as const, result: `${person.name}尝试分离拘束物质，但这次没有成功`, diff: { restrainedPersonId: restrained.id, released: false, chance, sample } };
    restrained.conditions = restrained.conditions.filter((item) => item.id !== condition.id);
    addInventory(person, Material.Rope, 1, [eventId, ...condition.sourceEventIds], `stack-${person.id}-${Material.Rope}-${atMonth}`);
    return {
      status: 'completed' as const,
      result: `${person.name}从${selfRelease ? '自己' : restrained.name}身上分离出绳`,
      diff: { releasedPersonId: restrained.id, materialId: Material.Rope, sourceConditionId: condition.id },
    };
  }
  if (!target || target.kind !== 'voxel' || distanceToPosition(person, target.position) > 1) return { status: 'blocked' as const, result: '分离目标不在近身范围', diff: {} };
  const { x, y, z } = target.position;
  const materialId = voxelAt(state.world.grid, x, y, z);
  const output: Array<{ materialId: MaterialId; quantity: number }> = [];
  const spilled: Array<{ materialId: MaterialId; quantity: number }> = [];
  const selectedTool = action.toolStackId ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0) : undefined;
  const productionTool = selectedTool && isProductionToolMaterial(selectedTool.materialId) ? selectedTool : undefined;
  let effectiveTool = productionTool;
  const toolMultiplier = productionToolMultiplier(productionTool?.materialId);
  let replacement: MaterialId = Material.Air;
  // A mill processes the crop at its work target. The worker can legally stand
  // on the crop's far side, so body-centered lookup would erase the same real
  // crop-mill contact merely because of approach direction.
  const mill = materialId === Material.CropMature
    ? nearbyFacilityMaterialAtCell(state, cellId(x, y), [Material.Mill])
    : undefined;
  if (materialId === Material.Leaves || materialId === Material.Wood) {
    setVoxel(state.world.grid, x, y, z, Material.Air);
    for (let below = z - 1; below >= 0; below -= 1) {
      if (voxelAt(state.world.grid, x, y, below) !== Material.Wood) continue;
      setVoxel(state.world.grid, x, y, below, Material.Air);
      break;
    }
    output.push(
      { materialId: Material.Wood, quantity: Math.max(3, Math.floor(3 * toolMultiplier)) },
      { materialId: Material.Fiber, quantity: Math.max(1, Math.floor(1.25 * toolMultiplier)) },
    );
  } else if (materialId === Material.CropMature) {
    replacement = Material.ExhaustedSoil;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push(
      { materialId: Material.Food, quantity: Math.max(4, Math.floor(4 * toolMultiplier) + (mill ? 2 : 0)) },
      { materialId: Material.Seed, quantity: Math.max(2, Math.floor(1.5 * toolMultiplier)) },
    );
  } else if (materialId === Material.BerryBush) {
    replacement = Material.Shrub;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push(
      { materialId: Material.Food, quantity: Math.max(3, Math.floor(3 * toolMultiplier)) },
      { materialId: Material.Seed, quantity: Math.max(1, Math.floor(toolMultiplier)) },
    );
  } else if (materialId === Material.Shrub) {
    replacement = Material.Soil;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push({ materialId: Material.Fiber, quantity: Math.max(2, Math.floor(2 * toolMultiplier)) });
  } else {
    const rule = voxelSeparationRuleFor(materialId);
    if (!rule) return { status: 'blocked' as const, result: `${materialDefinition(materialId).name}目前无法徒手分离`, diff: { materialId } };
    if (rule.requiredToolMaterialId !== undefined && (!selectedTool || !separationToolFits(rule, selectedTool.materialId))) return {
      status: 'blocked' as const,
      result: `分离${materialDefinition(materialId).name}需要${materialDefinition(rule.requiredToolMaterialId).name}`,
      diff: { materialId, requiredToolMaterialId: rule.requiredToolMaterialId },
    };
    if (rule.requiredToolMaterialId !== undefined) effectiveTool = selectedTool;
    if (bodyStandsOn(state, target.position)) return { status: 'blocked' as const, result: '这个物质体素正支撑着身体，不能直接分离', diff: { materialId, position: target.position } };
    if (materialId === Material.Container || materialId === Material.Granary) {
      const containerId = containerIdAt(target.position);
      const container = containerById(state, containerId);
      if (container) {
        for (const stack of container.inventory) {
          addDrop(state, stack.materialId, stack.quantity, person.position.cellId, atMonth, [eventId, ...stack.sourceEventIds], `${person.id}-container-spill`, stack.recordPayloadId, person.position.z);
          spilled.push({ materialId: stack.materialId, quantity: stack.quantity });
        }
      }
      state.containers = state.containers.filter((candidate) => candidate.id !== containerId);
    }
    replacement = rule.replacementMaterialId;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push(...rule.outputs);
    const techniqueId = separationTechniqueId(rule);
    const known = person.knowledge.find((fact) => fact.id === techniqueId);
    if (known) {
      known.confidence = clamp(known.confidence + 18);
      known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: techniqueId,
      kind: 'technique',
      summary: separationTechniqueSummary(rule),
      confidence: 46,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
  }
  for (const item of output) addDrop(state, item.materialId, item.quantity, person.position.cellId, atMonth, [eventId], `${person.id}-separate`, undefined, person.position.z);
  return {
    status: 'completed' as const,
    result: `从${materialDefinition(materialId).name}分离出${output.map((item) => `${materialDefinition(item.materialId).name} × ${item.quantity}`).join('、')}`,
    diff: {
      sourceMaterialId: materialId,
      replacementMaterialId: replacement,
      outputs: output,
      productionMultiplier: toolMultiplier,
      ...(mill ? { facilityMaterialId: mill } : {}),
      ...(spilled.length ? { spilled } : {}),
      ...(effectiveTool ? { toolMaterialId: effectiveTool.materialId, toolStackId: effectiveTool.id } : {}),
    },
  };
}

function executeInventoryCombine(state: SimulationState, person: PersonState, stackRefs: Extract<WorldRef, { kind: 'inventory-stack' }>[], atMonth: number, eventId: string) {
  if (stackRefs.length < 2 || stackRefs.some((ref) => ref.personId !== person.id)) return null;
  const requestedByStack = new Map<string, number>();
  for (const ref of stackRefs) requestedByStack.set(ref.stackId, (requestedByStack.get(ref.stackId) ?? 0) + 1);
  const stacks = stackRefs.map((ref) => person.inventory.find((stack) => stack.id === ref.stackId));
  if (stacks.some((stack) => !stack)) return { status: 'blocked' as const, result: '背包中的结合材料已经不存在', diff: {} };
  for (const [stackId, quantity] of requestedByStack) {
    if ((person.inventory.find((stack) => stack.id === stackId)?.quantity ?? 0) < quantity) return { status: 'blocked' as const, result: '背包中的结合材料数量不足', diff: {} };
  }
  const materialIds = stacks.map((stack) => stack?.materialId ?? Material.Air);
  const rule = inventoryCombinationFor(materialIds);
  if (!rule) return { status: 'blocked' as const, result: '这些随身物质当前没有可发生的结合规则', diff: { inputMaterialIds: materialIds } };
  for (const [stackId, quantity] of requestedByStack) {
    const stack = person.inventory.find((candidate) => candidate.id === stackId);
    if (stack) stack.quantity -= quantity;
  }
  removeEmptyStacks(person);
  const facilityMaterialId = nearbyFacilityMaterial(state, person, rule.output.materialId === Material.IronTool
    ? [Material.Smithy]
    : rule.output.materialId === Material.BronzeTool
      ? [Material.Foundry, Material.Workshop]
      : [Material.Workshop]);
  const exactMechanicalComponent = rule.output.materialId === Material.WaterWheel
    || rule.output.materialId === Material.DriveShaft
    || rule.output.materialId === Material.SteelDriveShaft
    || rule.output.materialId === Material.Mill
    || rule.output.materialId === Material.MechanicalDynamo
    || rule.output.materialId === Material.CopperConductor
    || rule.output.materialId === Material.ResistiveLoad;
  const facilityBonus = facilityMaterialId
    && !materialHas(rule.output.materialId, 'facility')
    && !exactMechanicalComponent ? 1 : 0;
  const outputQuantity = rule.output.quantity + facilityBonus;
  const outputStack = exactMechanicalComponent
    ? {
      id: `stack-${person.id}-${rule.output.materialId}-${eventId}`,
      materialId: rule.output.materialId,
      quantity: outputQuantity,
      sourceEventIds: [eventId],
    }
    : addInventory(person, rule.output.materialId, outputQuantity, [eventId], `stack-${person.id}-${rule.output.materialId}-${atMonth}`);
  if (exactMechanicalComponent) person.inventory.push(outputStack);
  const techniqueId = inventoryCombinationTechniqueId(rule);
  const known = person.knowledge.find((fact) => fact.id === techniqueId);
  if (known) {
    known.confidence = clamp(known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({ id: techniqueId, kind: 'technique', summary: inventoryCombinationSummary(rule), confidence: 46, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  return {
    status: 'completed' as const,
    result: `${materialIds.map((id) => materialDefinition(id).name).join('与')}结合为${materialDefinition(rule.output.materialId).name}`,
    diff: {
      techniqueId,
      inputMaterialIds: materialIds,
      outputMaterialId: rule.output.materialId,
      outputQuantity,
      baseOutputQuantity: rule.output.quantity,
      ...(facilityMaterialId ? { facilityMaterialId, facilityBonus } : {}),
      outputStackId: outputStack.id,
      sourceEventId: eventId,
    },
  };
}

function executeCombine(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const stackRefs = targets.filter((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const stackRef = stackRefs[0];
  const voxelRef = targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  const personRef = targets.find((target): target is Extract<WorldRef, { kind: 'person' }> => target.kind === 'person');
  if (!voxelRef && !personRef) {
    const outcome = executeInventoryCombine(state, person, stackRefs, atMonth, eventId);
    if (outcome) return outcome;
  }
  if (stackRef && personRef && stackRef.personId === person.id) {
    const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
    const receiverCandidate = personById(state, personRef.personId);
    const receiver = receiverCandidate && sameLocation(receiverCandidate, person) ? receiverCandidate : undefined;
    if (!stack || !receiver) return { status: 'blocked' as const, result: '照护材料或伤者不在近身范围', diff: {} };
    if (stack.materialId === Material.Rope && receiver.id !== person.id) {
      const woundStage = receiver.conditions.find((item) => item.kind === 'wound')?.stage ?? 0;
      if (receiver.conditions.some((item) => item.kind === 'restrained')) return { status: 'blocked' as const, result: `${receiver.name}已经受到绳的拘束`, diff: {} };
      if (receiver.body.health > 20 && woundStage < 3) return { status: 'blocked' as const, result: `${receiver.name}仍能抵抗，绳没有形成持续拘束`, diff: { resistedBy: receiver.id } };
      stack.quantity -= 1;
      removeEmptyStacks(person);
      const condition = { id: `condition-restrained-${receiver.id}-${atMonth}`, kind: 'restrained' as const, stage: 2 as const, sinceMonth: atMonth, sourceEventIds: [eventId], otherPersonId: person.id, materialStackId: stack.id };
      receiver.conditions.push(condition);
      const witnessedBy = state.people.filter((candidate) => sameLocation(candidate, person) && candidate.id !== person.id).map((candidate) => candidate.id);
      for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id))) {
        applyRelationEvidence(witness, person.id, eventId, { trust: witness.id === receiver.id ? -20 : -8, fear: witness.id === receiver.id ? 20 : 8 });
      }
      return {
        status: 'completed' as const,
        result: `${person.name}用绳使${receiver.name}受到持续拘束`,
        diff: { restrainedPersonId: receiver.id, conditionId: condition.id, materialId: Material.Rope, witnessedBy },
      };
    }
    const condition = receiver.conditions.find((item) => item.kind === 'wound' || item.kind === 'illness');
    if ((stack.materialId !== Material.Fiber && stack.materialId !== Material.HerbalMedicine) || !condition) return { status: 'blocked' as const, result: '当前材料不能作用于这个身体状态', diff: {} };
    stack.quantity -= 1;
    removeEmptyStacks(person);
    const priorStage = condition.stage;
    if (condition.stage > 1) condition.stage = (condition.stage - 1) as 1 | 2;
    else receiver.conditions = receiver.conditions.filter((item) => item.id !== condition.id);
    receiver.body.health = clamp(receiver.body.health + (stack.materialId === Material.HerbalMedicine ? 9 : 3));
    applyRelationEvidence(receiver, person.id, eventId, { trust: 7, bond: 5 });
    return { status: 'completed' as const, result: `${person.name}用${materialDefinition(stack.materialId).name}照护${receiver.name}的${condition.kind === 'wound' ? '伤口' : '疾病'}`, diff: { caredPersonId: receiver.id, condition: condition.kind, careMaterialId: stack.materialId, fromStage: priorStage, toStage: receiver.conditions.find((item) => item.id === condition.id)?.stage ?? 0, health: receiver.body.health, atMonth } };
  }
  if (!stackRef || !voxelRef || stackRef.personId !== person.id || distanceToPosition(person, voxelRef.position) > 1) return { status: 'blocked' as const, result: '结合材料或目标不在近身范围', diff: {} };
  const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
  if (!stack) return { status: 'blocked' as const, result: '背包中的材料已经不存在', diff: {} };
  const current = voxelAt(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z);
  const output = inventoryVoxelCombinationOutput(stack.materialId, current);
  if (output === null) return { status: 'blocked' as const, result: '这些物质当前没有可发生的结合规则', diff: { inputMaterialId: stack.materialId, targetMaterialId: current } };
  if (materialHas(output, 'solid') && bodyOccupies(state, voxelRef.position)) return { status: 'blocked' as const, result: '目标空气体素正被身体占据，不能放入固体物质', diff: { outputMaterialId: output, position: voxelRef.position } };
  stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z, output);
  rememberMaterialPlace(person, output, voxelRef.position, atMonth, eventId);
  let containerId: string | undefined;
  if (output === Material.Container || output === Material.Granary) {
    containerId = containerIdAt(voxelRef.position);
    const existingContainer = state.containers.find((candidate) => candidate.id === containerId);
    if (existingContainer && output === Material.Granary) {
      existingContainer.capacity = GRANARY_CAPACITY;
      existingContainer.sourceEventIds = [...new Set([...existingContainer.sourceEventIds, eventId])].slice(-24);
    } else {
      state.containers = state.containers.filter((candidate) => candidate.id !== containerId);
      state.containers.push({
        id: containerId,
        position: { ...voxelRef.position },
        inventory: [],
        createdAtMonth: atMonth,
        sourceEventIds: [eventId],
        ...(output === Material.Granary ? { capacity: GRANARY_CAPACITY } : {}),
      });
    }
  } else if (output === Material.Cistern && current === Material.Container) {
    state.containers = state.containers.filter((candidate) => candidate.id !== containerIdAt(voxelRef.position));
  }
  const techniqueId = `technique:combine:${stack.materialId}:${current}:${output}`;
  const knownTechnique = person.knowledge.find((fact) => fact.id === techniqueId);
  if (knownTechnique) {
    knownTechnique.confidence = clamp(knownTechnique.confidence + 18);
    knownTechnique.sourceEventIds = [...new Set([...knownTechnique.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({
    id: techniqueId,
    kind: 'technique',
    summary: `${materialDefinition(stack.materialId).name}与${materialDefinition(current).name}可结合为${materialDefinition(output).name}`,
    confidence: 46,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
  return {
    status: 'completed' as const,
    result: `${materialDefinition(stack.materialId).name}与${materialDefinition(current).name}结合为${materialDefinition(output).name}`,
    diff: { techniqueId, inputMaterialId: stack.materialId, targetMaterialId: current, outputMaterialId: output, position: voxelRef.position, sourceEventId: eventId, ...(containerId ? { containerId } : {}) },
  };
}

function executeExert(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const stackRef = action.targets.find((item): item is Extract<WorldRef, { kind: 'inventory-stack' }> => item.kind === 'inventory-stack');
  const voxelRef = action.targets.find((item): item is Extract<WorldRef, { kind: 'voxel' }> => item.kind === 'voxel');
  if (stackRef && voxelRef) {
    const stack = stackRef.personId === person.id ? person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0) : undefined;
    const tool = action.toolStackId ? person.inventory.find((candidate) => candidate.id === action.toolStackId && candidate.quantity > 0) : undefined;
    if (!stack || !tool || distanceToPosition(person, voxelRef.position) > 1) return { status: 'blocked' as const, result: '施力所需的工具、材料或目标不在近身范围', diff: {} };
    if (voxelRef.position.z < 0 || voxelRef.position.z >= state.world.grid.levels) return { status: 'blocked' as const, result: '施力目标不在世界范围内', diff: {} };
    const targetMaterialId = voxelAt(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z);
    const rule = exertionRuleFor(tool.materialId, stack.materialId, targetMaterialId);
    if (!rule) return { status: 'blocked' as const, result: '这些物质当前没有可发生的施力响应', diff: { toolMaterialId: tool.materialId, inputMaterialId: stack.materialId, targetMaterialId } };
    const outputPosition = rule.outputLocation === 'world' && rule.outputPlacement === 'support'
      ? { ...voxelRef.position, z: voxelRef.position.z - 1 }
      : voxelRef.position;
    if (rule.outputLocation === 'world' && rule.outputPlacement === 'support'
      && materialDefinition(voxelAt(
        state.world.grid,
        outputPosition.x,
        outputPosition.y,
        outputPosition.z,
      )).phase !== 'solid') {
      return { status: 'blocked' as const, result: '产物需要稳定的承托表面', diff: { outputMaterialId: rule.outputMaterialId, position: outputPosition } };
    }
    stack.quantity -= 1;
    removeEmptyStacks(person);
    const outputStack = rule.outputLocation === 'inventory'
      ? addInventory(person, rule.outputMaterialId, 1, [eventId], `stack-${person.id}-${rule.outputMaterialId}-${atMonth}`)
      : undefined;
    if (rule.outputLocation === 'world') setVoxel(state.world.grid, outputPosition.x, outputPosition.y, outputPosition.z, rule.outputMaterialId);
    const techniqueId = exertionTechniqueId(rule);
    const knownTechnique = person.knowledge.find((fact) => fact.id === techniqueId);
    if (knownTechnique) {
      knownTechnique.confidence = clamp(knownTechnique.confidence + 18);
      knownTechnique.sourceEventIds = [...new Set([...knownTechnique.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: techniqueId,
      kind: 'technique',
      summary: exertionTechniqueSummary(rule),
      confidence: 46,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
    return {
      status: 'completed' as const,
      result: `${materialDefinition(tool.materialId).name}向${materialDefinition(stack.materialId).name}施力后产生${materialDefinition(rule.outputMaterialId).name}`,
      diff: {
        techniqueId,
        toolMaterialId: tool.materialId,
        inputMaterialId: stack.materialId,
        targetMaterialId,
        outputMaterialId: rule.outputMaterialId,
        outputLocation: rule.outputLocation,
        ...(outputStack ? { outputStackId: outputStack.id } : {}),
        position: outputPosition,
        ...(rule.outputLocation === 'world' && rule.outputPlacement === 'support'
          ? { targetPosition: voxelRef.position }
          : {}),
        sourceEventId: eventId,
      },
    };
  }
  const target = action.targets.find((item): item is Extract<WorldRef, { kind: 'person' }> => item.kind === 'person');
  const victim = target ? personById(state, target.personId) : undefined;
  if (!victim || victim.id === person.id || !sameLocation(victim, person)) return { status: 'blocked' as const, result: '受力目标不在近身范围', diff: {} };
  const damage = Math.max(3, Math.round(person.baselineCapacities.manipulation / 12));
  victim.body.health = clamp(victim.body.health - damage);
  const wound = victim.conditions.find((condition) => condition.kind === 'wound');
  if (wound) {
    wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
    wound.sourceEventIds.push(eventId);
  } else {
    victim.conditions.push({ id: `condition-wound-${victim.id}-${atMonth}`, kind: 'wound', stage: damage >= 7 ? 2 : 1, sinceMonth: atMonth, sourceEventIds: [eventId], otherPersonId: person.id });
  }
  const witnessedBy = state.people.filter((candidate) => sameLocation(candidate, person) && candidate.id !== person.id).map((candidate) => candidate.id);
  for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id))) {
    applyRelationEvidence(witness, person.id, eventId, { trust: witness.id === victim.id ? -14 : -6, fear: witness.id === victim.id ? 12 : 5 });
  }
  return { status: 'completed' as const, result: `${person.name}对${victim.name}施力并造成伤害`, diff: { victimId: victim.id, damage, health: victim.body.health, witnessedBy } };
}

function executeReproduce(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const target = action.targets.find((item): item is Extract<WorldRef, { kind: 'person' }> => item.kind === 'person');
  const other = target ? personById(state, target.personId) : undefined;
  if (!other || other.id === person.id || !sameLocation(other, person)) return { status: 'blocked' as const, result: '另一参与者不在近身范围', diff: {} };
  const consent = action.authorizationRef
    ? activeReproductionAgreementBetween(state, person.id, other.id, atMonth, action.authorizationRef)
    : undefined;
  const succubusTrait = person.sex === 'female'
    ? traitStatesOf(person).find((trait) => trait.id === 'succubus')
    : undefined;
  const unilateralTraitAuthorization = !consent && Boolean(succubusTrait);
  if (!consent && !unilateralTraitAuthorization) {
    return { status: 'blocked' as const, result: '没有有效的双方生殖协议或魅魔单方授权，生殖过程不发生', diff: { consent: false } };
  }
  if (reproductionAttemptedBetweenInMonth(state, person.id, other.id, atMonth)) {
    return {
      status: 'blocked' as const,
      result: '本月这两人之间已经完成过一次生殖尝试',
      diff: {
        consent: true,
        attemptedThisMonth: true,
        ...(consent
          ? { mutualConsent: true, authorizationMode: 'agreement', agreementId: consent.id }
          : { mutualConsent: false, authorizationMode: 'succubus-unilateral', consentingPersonIds: [person.id], traitId: 'succubus' }),
      },
    };
  }
  const female = person.sex === 'female' ? person : other.sex === 'female' ? other : null;
  const male = person.sex === 'male' ? person : other.sex === 'male' ? other : null;
  const age = (candidate: PersonState) => atMonth - candidate.bornAtMonth;
  const relationshipSnapshot = [person, other].map((observer) => {
    const observedId = observer.id === person.id ? other.id : person.id;
    const relation = relationTo(observer, observedId);
    return {
      observerId: observer.id,
      otherPersonId: observedId,
      trust: relation?.trust ?? 0,
      bond: relation?.bond ?? 0,
      fear: relation?.fear ?? 0,
      sourceEventIds: [...(relation?.sourceEventIds ?? [])],
    };
  });
  const consentDiff = consent
    ? {
        consent: true,
        mutualConsent: true,
        authorizationMode: 'agreement',
        agreementId: consent.id,
        relationshipSnapshot,
      }
    : {
        consent: true,
        mutualConsent: false,
        authorizationMode: 'succubus-unilateral',
        consentingPersonIds: [person.id],
        nonConsentingPersonId: other.id,
        traitId: 'succubus',
        traitSourceEventIds: [...(succubusTrait?.sourceEventIds ?? [])],
        relationshipSnapshot,
      };
  if (!female || !male
    || age(female) < 16 * 12
    || age(male) < 16 * 12
    || (!unilateralTraitAuthorization && age(female) > reproductiveUpperAgeMonths(female))
    || (unilateralTraitAuthorization
      ? female.conditions.some((condition) => condition.kind === 'pregnancy')
      : hasReproductiveRecoveryCondition(female))
    || (!unilateralTraitAuthorization && Math.min(
      female.body.health, female.body.hydration, female.body.nutrition,
      male.body.health, male.body.hydration, male.body.nutrition,
    ) < 55)) {
    return { status: 'blocked' as const, result: '当前身体条件不能开始妊娠过程', diff: consentDiff };
  }
  const livingPopulation = livingPeople(state).length;
  const capacityFactor = humanReproductionCapacityFactor(livingPopulation);
  const chance = 0.28 * Math.min(female.body.health, female.body.nutrition, female.body.hydration) / 100 * capacityFactor;
  const sampleKey = `reproduce:${eventId}:${atMonth}:${female.id}:${male.id}`;
  const sample = seededFraction(state.seed, sampleKey);
  const kinshipRisk = geneticKinshipRisk(state, female, male);
  const capacityDiff = { livingPopulation, softCarryingCapacity: HUMAN_SOFT_CARRYING_CAPACITY, capacityFactor };
  if (sample >= chance) return { status: 'completed' as const, result: '生殖过程发生，但本次没有进入妊娠', diff: { conceived: false, chance, sample, sampleKey, kinshipRisk, ...capacityDiff, ...consentDiff } };
  female.conditions.push({
    id: `condition-pregnancy-${female.id}-${atMonth}`,
    kind: 'pregnancy', stage: 1, sinceMonth: atMonth, dueAtMonth: atMonth + 9,
    sourceEventIds: consent
      ? [consent.proposalEventId, ...(consent.responseEventId ? [consent.responseEventId] : []), eventId]
      : [...new Set([...(succubusTrait?.sourceEventIds ?? []), eventId])],
    otherPersonId: male.id,
  });
  return { status: 'completed' as const, result: `${female.name}进入妊娠过程`, diff: { conceived: true, femaleId: female.id, maleId: male.id, dueAtMonth: atMonth + 9, chance, sample, sampleKey, kinshipRisk, ...capacityDiff, ...consentDiff } };
}

function executeDehydrate(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const target = action.targets.find((candidate): candidate is Extract<WorldRef, { kind: 'person' }> => candidate.kind === 'person');
  const sleeperCandidate = target ? personById(state, target.personId) : undefined;
  const sleeper = sleeperCandidate && isAlive(sleeperCandidate) ? sleeperCandidate : undefined;
  if (!sleeper || !sameLocation(sleeper, person)) return { status: 'blocked' as const, result: '需要近身才能进入脱水休眠', diff: {} };
  const assistedDependent = sleeper.id !== person.id;
  if (assistedDependent && (!sleeper.geneticParents.includes(person.id) || ageMonths(sleeper, atMonth) >= 12 * 12)) {
    return { status: 'blocked' as const, result: '只能辅助同地、未满十二岁的亲生受抚养者脱水', diff: {} };
  }
  if (sleeper.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')) return {
    status: 'completed' as const,
    result: `${sleeper.name}已处于脱水休眠`,
    diff: { alreadyHibernating: true, dehydratedPersonId: sleeper.id },
  };
  if (hasHibernationEntryContraindication(sleeper)) {
    return { status: 'blocked' as const, result: '妊娠、重伤或重病让脱水休眠过程过于危险', diff: {} };
  }
  const requiredEntryReserve = action.hibernationPredictionId
    ? HIBERNATION_PREDICTIVE_ENTRY_RESERVE
    : HIBERNATION_ENTRY_LEGAL_RESERVE;
  if (!hasHibernationEntryBodyReserve(sleeper, requiredEntryReserve)) {
    return { status: 'blocked' as const, result: '当前身体储备不足以安全进入脱水休眠', diff: {} };
  }
  const triggerPrediction = action.hibernationPredictionId
    ? state.eraPredictions.find((prediction) => prediction.id === action.hibernationPredictionId)
    : undefined;
  if (action.hibernationPredictionId && (!triggerPrediction
    || !isActionableChaosPrediction(triggerPrediction, atMonth)
    || !personTrustsEraPrediction(state, sleeper, triggerPrediction))) {
    return { status: 'blocked' as const, result: '支撑脱水休眠的预言已经失效或不被本人相信', diff: {} };
  }
  const wakeDisputeEventIds = triggerPrediction
    ? sleeper.memories
      .filter((memory) => memory.id.startsWith(`memory:hibernation-wake-dispute:${triggerPrediction.id}:${sleeper.id}:`))
      .flatMap((memory) => memory.sourceEventIds)
    : [];
  const providedHibernationEvidenceIds = new Set(action.hibernationEvidenceEventIds ?? []);
  const hibernationEvidenceEventIds = triggerPrediction
    ? []
    : observedHibernationEntryEvidence(state, sleeper)
      .filter((sourceEventId) => providedHibernationEvidenceIds.has(sourceEventId));
  if (!triggerPrediction && hibernationEvidenceEventIds.length === 0) {
    return {
      status: 'blocked' as const,
      result: '已发生的乱纪元脱水休眠需要本人当前严重冷热暴露的可解析事实',
      diff: {},
    };
  }
  sleeper.conditions.push({
    id: `condition-dehydrated-hibernation-${sleeper.id}-${atMonth}`,
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: atMonth,
    hibernationPhase: 'dormant',
    sourceEventIds: [...new Set([...hibernationEvidenceEventIds, eventId])],
    ...(triggerPrediction ? { triggerPredictionId: triggerPrediction.id } : {}),
    ...(wakeDisputeEventIds.length ? { wakeDisputeEventIds: [...new Set(wakeDisputeEventIds)] } : {}),
  });
  sleeper.body.hydration = clamp(sleeper.body.hydration - 8);
  return {
    status: 'completed' as const,
    result: assistedDependent
      ? `${person.name}近身辅助${sleeper.name}进入脱水休眠，以低代谢等待乱纪元过去`
      : `${person.name}主动进入脱水休眠，以低代谢等待乱纪元过去`,
    diff: {
      condition: 'dehydrated-hibernation', entered: true, epoch: state.civilization.epoch,
      dehydratedPersonId: sleeper.id,
      ...(hibernationEvidenceEventIds.length ? { hibernationEvidenceEventIds } : {}),
      ...(triggerPrediction ? { hibernationPredictionId: triggerPrediction.id } : {}),
      ...(wakeDisputeEventIds.length ? { wakeDisputeEventIds: [...new Set(wakeDisputeEventIds)] } : {}),
      ...(assistedDependent ? { assistedByPersonId: person.id, assistedDependentId: sleeper.id } : {}),
    },
  };
}

function executeRehydrate(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const target = action.targets.find((candidate): candidate is Extract<WorldRef, { kind: 'person' }> => candidate.kind === 'person');
  const sleeper = target ? personById(state, target.personId) : undefined;
  if (!sleeper || !sameLocation(sleeper, person)) return { status: 'blocked' as const, result: '需要近身才能让脱水休眠者重新水化', diff: {} };
  const condition = sleeper.conditions.find((candidate) => candidate.kind === 'dehydrated-hibernation');
  if (!condition) return { status: 'blocked' as const, result: '对方没有处于脱水休眠', diff: {} };
  const phase = hibernationPhase(condition);
  const assistedDependentRecovery = phase === 'recovering'
    && isAlive(sleeper)
    && state.civilization.epoch === 'stable'
    && sleeper.geneticParents.includes(person.id)
    && lifePlanningStage(sleeper, atMonth) === 'dependent-child'
    && sleeper.body.hydration < HIBERNATION_RECOVERY_SAFE_RESERVE
    && condition.lastRecoveryAssistedAtMonth !== atMonth;
  if (phase !== 'dormant' && !assistedDependentRecovery) return {
    status: 'blocked' as const,
    result: phase === 'recovering'
      ? '对方的恢复阶段不允许本次重新水化'
      : '对方已经转入恢复阶段，不能重复重新水化',
    diff: {
      hibernationConditionId: condition.id,
      hibernationPhase: phase,
      duplicateRehydrationBlocked: true,
    },
  };
  const waterNearby = cellsInRadius(person.position.cellId, 2).some((cell) => {
    const material = surfaceMaterial(state.world.grid, cell);
    return materialHas(material, 'drinkable');
  });
  if (!waterNearby) return { status: 'blocked' as const, result: '附近没有可用水或冰，无法完成重新水化', diff: {} };
  if (assistedDependentRecovery) {
    condition.lastRecoveryAssistedAtMonth = atMonth;
    condition.recoverySourceEventIds = [...new Set([...(condition.recoverySourceEventIds ?? []), eventId])].slice(-24);
    sleeper.body.hydration = clamp(sleeper.body.hydration + 18);
    return {
      status: 'completed' as const,
      result: `${person.name}用附近的真实水源继续帮助${sleeper.name}恢复`,
      diff: {
        rehydratedPersonId: sleeper.id,
        assistedDependentId: sleeper.id,
        assistedByPersonId: person.id,
        waterNearby: true,
        atMonth,
        hibernationRecoverySource: true,
        hibernationConditionId: condition.id,
        hibernationPhase: 'recovering',
        exited: false,
        recoverySourceEventIds: [...condition.recoverySourceEventIds],
        lastRecoveryAssistedAtMonth: atMonth,
      },
    };
  }
  const triggerPrediction = condition.triggerPredictionId
    ? state.eraPredictions.find((prediction) => prediction.id === condition.triggerPredictionId)
    : undefined;
  const predictionStillPending = Boolean(triggerPrediction
    && triggerPrediction.status === 'pending'
    && atMonth <= triggerPrediction.expiresAtMonth);
  const bodyEmergency = sleeper.body.health < 35
    || sleeper.body.hydration < 28
    || sleeper.body.nutrition < 28;
  if (state.civilization.epoch !== 'stable' && !bodyEmergency) {
    return { status: 'blocked' as const, result: '乱纪元仍在持续，缺少足以打断休眠的新证据', diff: {} };
  }
  if (predictionStillPending && !bodyEmergency
    && personTrustsEraPrediction(state, person, triggerPrediction!)) {
    return { status: 'blocked' as const, result: '本人也认可这项临近乱纪元预言，不应提前打断休眠', diff: {} };
  }
  if (predictionStillPending && !bodyEmergency && (condition.wakeDisputeEventIds?.length ?? 0) > 0) {
    return { status: 'blocked' as const, result: '这项休眠计划已被质疑并重新执行，缺少再次唤醒的新证据', diff: {} };
  }
  const wakeBasis = bodyEmergency
    ? 'body-emergency' as const
    : predictionStillPending
      ? 'disputed-pending-prediction' as const
      : triggerPrediction?.status === 'incorrect'
        ? 'prediction-invalidated' as const
        : triggerPrediction?.status === 'correct'
          ? 'post-chaos-recovery' as const
          : 'unbound-stable-recovery' as const;
  condition.hibernationPhase = 'recovering';
  condition.recoveryStartedAtMonth ??= atMonth;
  condition.recoverySourceEventIds = [...new Set([...(condition.recoverySourceEventIds ?? []), eventId])].slice(-24);
  sleeper.body.hydration = clamp(sleeper.body.hydration + 18);
  if (person.id !== sleeper.id) {
    if (wakeBasis === 'disputed-pending-prediction' && triggerPrediction) {
      const memoryId = `memory:hibernation-wake-dispute:${triggerPrediction.id}:${sleeper.id}:${person.id}`;
      remember(sleeper, {
        id: memoryId,
        kind: 'episode',
        summary: `${person.name}不认可仍待验证的纪元预言，提前打断了自己的休眠计划`,
        importance: 78,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [person.id, triggerPrediction.predictorId],
        sourceEventIds: [eventId],
        expiresAtMonth: triggerPrediction.expiresAtMonth,
      });
      remember(person, {
        id: `${memoryId}:helper`,
        kind: 'episode',
        summary: `自己不认可仍待验证的纪元预言，提前唤醒了${sleeper.name}`,
        importance: 70,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [sleeper.id, triggerPrediction.predictorId],
        sourceEventIds: [eventId],
        expiresAtMonth: triggerPrediction.expiresAtMonth,
      });
    } else {
      applyRelationEvidence(sleeper, person.id, eventId, { trust: 4, bond: 2 });
      applyRelationEvidence(person, sleeper.id, eventId, { trust: 2, bond: 1 });
      remember(sleeper, {
        id: `memory:hibernation-wake-help:${eventId}:${sleeper.id}`,
        kind: 'episode',
        summary: `${person.name}依据新的环境或身体事实帮助自己安全结束休眠`,
        importance: 72,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [person.id],
        sourceEventIds: [eventId],
      });
    }
  }
  return {
    status: 'completed' as const,
    result: `${person.name}用真实水源使${sleeper.name}转入受限恢复`,
    diff: {
      rehydratedPersonId: sleeper.id,
      waterNearby: true,
      atMonth,
      rehydrationBasis: wakeBasis,
      hibernationConditionId: condition.id,
      hibernationPhase: 'recovering',
      exited: false,
      recoverySourceEventIds: [...condition.recoverySourceEventIds],
      ...(triggerPrediction ? { hibernationPredictionId: triggerPrediction.id } : {}),
    },
  };
}

function executeHunt(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const target = action.targets.find((candidate): candidate is Extract<WorldRef, { kind: 'animal' }> => candidate.kind === 'animal');
  const animal = target ? state.world.animals.find((candidate) => candidate.id === target.animalId) : undefined;
  if (!animal || !isAnimalAlive(animal)) return { status: 'blocked' as const, result: '捕猎目标已经不在', diff: {} };
  if (animal.position.cellId !== person.position.cellId || animal.position.z !== person.position.z) {
    return { status: 'blocked' as const, result: '动物不在近身范围', diff: { animalId: animal.id } };
  }
  const species = animalSpecies(animal.speciesId);
  const tool = action.toolStackId ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0) : undefined;
  const toolBonus = huntingToolBonus(tool?.materialId);
  const toolDiff = {
    toolBonus,
    ...(tool ? { toolMaterialId: tool.materialId, toolStackId: tool.id } : {}),
  };
  const chance = Math.max(0.08, Math.min(0.9,
    0.12 + person.baselineCapacities.perception / 360 + person.baselineCapacities.manipulation / 420 + toolBonus - species.evasion / 220,
  ));
  const sample = seededFraction(state.seed, `human-hunt:${atMonth}:${person.id}:${animal.id}:${eventId}`);
  if (sample >= chance) {
    const counterChance = species.aggression / 150 * (1 - Math.min(0.45, toolBonus * 0.65));
    if (species.aggression > 0 && seededFraction(state.seed, `hunt-counter:${atMonth}:${person.id}:${animal.id}`) < counterChance) {
      const damage = Math.max(1, Math.round((4 + Math.floor(species.aggression / 16))
        * (1 - Math.min(0.35, toolBonus * 0.55))));
      person.body.health = clamp(person.body.health - damage);
      const wound = person.conditions.find((condition) => condition.kind === 'wound');
      if (wound) {
        wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
        wound.sourceEventIds.push(eventId);
      } else person.conditions.push({ id: `condition-wound-hunt-${person.id}-${atMonth}`, kind: 'wound', stage: 1, sinceMonth: atMonth, sourceEventIds: [eventId] });
      return {
        status: 'progressed' as const,
        result: `${person.name}捕猎${species.name}失败并被反击`,
        diff: {
          animalId: animal.id, animalSpeciesId: animal.speciesId, success: false,
          chance, sample, counterChance, counterDamage: damage, ...toolDiff,
        },
      };
    }
    return {
      status: 'progressed' as const,
      result: `${person.name}没有捕到${species.name}`,
      diff: { animalId: animal.id, animalSpeciesId: animal.speciesId, success: false, chance, sample, ...toolDiff },
    };
  }
  const damage = Math.round(26 + person.baselineCapacities.manipulation * 0.42 + toolBonus * 90);
  animal.health = Math.max(0, animal.health - damage);
  if (animal.health > 0) return {
    status: 'progressed' as const,
    result: `${person.name}击伤了${species.name}，但它仍然存活`,
    diff: {
      animalId: animal.id, animalSpeciesId: animal.speciesId, success: true, killed: false,
      damage, health: animal.health, chance, sample, ...toolDiff,
    },
  };
  animal.diedAtMonth = atMonth;
  const products = species.products.flatMap((product) => {
    const span = Math.max(0, product.maxQuantity - product.minQuantity);
    const quantity = product.minQuantity + Math.floor(seededFraction(state.seed, `human-hunt-product:${animal.id}:${atMonth}:${product.materialId}`) * (span + 1));
    if (quantity <= 0) return [];
    addDrop(state, product.materialId, quantity, animal.position.cellId, atMonth, [eventId], `${animal.id}-hunted`, undefined, animal.position.z);
    return [{ materialId: product.materialId, quantity }];
  });
  const techniqueId = `technique:hunt:${animal.speciesId}:${tool?.materialId ?? 'hand'}`;
  const known = person.knowledge.find((fact) => fact.id === techniqueId);
  if (known) {
    known.confidence = clamp(known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({
    id: techniqueId,
    kind: 'technique',
    summary: `用${tool ? materialDefinition(tool.materialId).name : '徒手'}捕猎${species.name}`,
    confidence: 46,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
  return {
    status: 'completed' as const,
    result: `${person.name}捕获了${species.name}，尸体留下${products.map((product) => `${materialDefinition(product.materialId).name} × ${product.quantity}`).join('、')}`,
    diff: {
      animalId: animal.id, animalSpeciesId: animal.speciesId, success: true, killed: true,
      damage, products, outputMaterialId: Material.RawMeat,
      ...toolDiff,
    },
  };
}

function executeExpose(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const stackRef = targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const voxelRef = targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  if (!stackRef || stackRef.personId !== person.id || !voxelRef || distanceToPosition(person, voxelRef.position) > 1) return { status: 'blocked' as const, result: '暴露材料或目标不在近身范围', diff: {} };
  const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
  if (!stack) return { status: 'blocked' as const, result: '背包中的暴露材料已经不存在', diff: {} };
  const targetMaterialId = voxelAt(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z);
  const rule = exposureRuleFor(stack.materialId, targetMaterialId);
  if (!rule) return { status: 'blocked' as const, result: '这些物质当前没有可发生的暴露响应', diff: { inputMaterialId: stack.materialId, targetMaterialId } };
  stack.quantity -= 1;
  removeEmptyStacks(person);
  const outputStack = addInventory(person, rule.outputMaterialId, 1, [eventId], `stack-${person.id}-${rule.outputMaterialId}-${atMonth}`);
  const techniqueId = exposureTechniqueId(rule);
  const known = person.knowledge.find((fact) => fact.id === techniqueId);
  if (known) {
    known.confidence = clamp(known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({ id: techniqueId, kind: 'technique', summary: exposureTechniqueSummary(rule), confidence: 46, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  return {
    status: 'completed' as const,
    result: `${materialDefinition(stack.materialId).name}暴露于${materialDefinition(targetMaterialId).name}后成为${materialDefinition(rule.outputMaterialId).name}`,
    diff: {
      techniqueId,
      inputMaterialId: stack.materialId,
      targetMaterialId,
      outputMaterialId: rule.outputMaterialId,
      outputStackId: outputStack.id,
      position: voxelRef.position,
      sourceEventId: eventId,
      ...(materialHas(targetMaterialId, 'facility') ? { facilityMaterialId: targetMaterialId } : {}),
    },
  };
}

function executeAct(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  actionTick: number,
  eventId: string,
) {
  if (action.operation === 'inter') return executeMortuary(state, person, action, atMonth, eventId);
  if (action.electricalPowerBasis) {
    return executeElectricalPowerAction(state, person, action, atMonth, actionTick, eventId);
  }
  if (action.mechanicalPowerBasis) return executeMechanicalPowerAction(state, person, action, atMonth, eventId);
  if (action.operation === 'combine' || action.operation === 'exert' || action.operation === 'expose') {
    const protectedCarrier = action.targets.flatMap((target) => {
      if (target.kind !== 'inventory-stack' || target.personId !== person.id) return [];
      const stack = person.inventory.find((candidate) => candidate.id === target.stackId && candidate.quantity > 0);
      return stack?.recordPayloadId ? [stack] : [];
    })[0];
    if (protectedCarrier?.recordPayloadId) return {
      status: 'blocked' as const,
      result: '已经承载记录的物质不能作为普通加工输入；需要另行定义明确的擦除或回收动作',
      diff: { stackId: protectedCarrier.id, recordPayloadId: protectedCarrier.recordPayloadId },
    };
  }
  if (action.operation === 'ingest') return executeIngest(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'separate') return executeSeparate(state, person, action, atMonth, eventId);
  if (action.operation === 'combine') return executeCombine(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'exert') return executeExert(state, person, action, atMonth, eventId);
  if (action.operation === 'reproduce') return executeReproduce(state, person, action, atMonth, eventId);
  if (action.operation === 'expose') return executeExpose(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'dehydrate') return executeDehydrate(state, person, action, atMonth, eventId);
  if (action.operation === 'rehydrate') return executeRehydrate(state, person, action, atMonth, eventId);
  if (action.operation === 'hunt') return executeHunt(state, person, action, atMonth, eventId);
  const fire = action.targets.find((target) => target.kind === 'voxel' && voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.Fire);
  const water = action.targets.find((target) => target.kind === 'voxel' && voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.Water);
  if (fire && water && fire.kind === 'voxel') {
    setVoxel(state.world.grid, fire.position.x, fire.position.y, fire.position.z, Material.Ash);
    return { status: 'completed' as const, result: '水使火物质转化为灰', diff: { extinguished: fire.position } };
  }
  return { status: 'blocked' as const, result: '当前暴露组合没有产生变化', diff: {} };
}

function executeAttend(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'attend' }>,
  atMonth: number,
  eventId: string,
  intentId?: string,
) {
  const cell = targetCell(state, action.target);
  if (cell === null || Math.abs(cellX(cell) - cellX(person.position.cellId)) + Math.abs(cellY(cell) - cellY(person.position.cellId)) > 7) return { status: 'blocked' as const, result: '观察目标超出感知范围', diff: {} };
  const measurement = executeMeasurementAttend(state, person, action, atMonth, eventId);
  if (measurement) return measurement;
  const electricalFault = executeElectricalPowerFaultAttend(state, person, action, atMonth, eventId);
  if (electricalFault) return electricalFault;
  if (action.waterCurrentSegmentId) {
    const mechanicalPower = state.world.mechanicalPower;
    const segment = mechanicalPower?.version === MECHANICAL_POWER_WORLD_VERSION
      ? mechanicalPower.sources.find((candidate) => candidate.id === action.waterCurrentSegmentId)
      : undefined;
    const position = action.target.kind === 'voxel' ? action.target.position : undefined;
    if (!segment || !position || !segment.requiredWaterVoxels.some((candidate) => samePosition(candidate, position))) {
      return { status: 'blocked' as const, result: '观察目标不是所指水流边的实体水体', diff: {} };
    }
    const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
    if (Math.abs(position.z - person.position.z) > perceptionRadius) {
      return { status: 'blocked' as const, result: '所指水流在垂直方向超出本人感知范围', diff: {} };
    }
    const availability = waterCurrentAvailabilityFor(state.world.grid, mechanicalPower, segment.id);
    if (!availability.available
      || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Water) {
      return { status: 'blocked' as const, result: '所指水流当前没有可感知的有效流动', diff: {} };
    }
    const factId = waterCurrentObservationFactId(segment.id);
    const summary = '观察到这段流水当前能持续向下游传递动力';
    const existing = person.knowledge.find((fact) => fact.id === factId && fact.kind === 'observation');
    if (existing) {
      existing.confidence = clamp(Math.max(existing.confidence, 58) + 12);
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: factId,
      kind: 'observation',
      summary,
      confidence: 68,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
    return {
      status: 'completed' as const,
      result: summary,
      diff: {
        factId,
        mechanicalPowerObservation: true,
        waterCurrentSegmentId: segment.id,
        availableCapacity: availability.availableCapacity,
        supportingSegmentIds: [...availability.supportingSegmentIds],
        sourceKeys: [...segment.sourceKeys],
        observedPosition: { ...position },
      },
    };
  }
  if (action.mechanicalPowerFaultObservation) {
    const ref = action.mechanicalPowerFaultObservation;
    const installationProject = projectById(state, ref.installationProjectId);
    const plan = installationProject?.mechanicalPowerPlan;
    const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === ref.networkId
      && candidate.planKey === ref.planKey
      && candidate.installationProjectId === ref.installationProjectId);
    const fault = network?.fault;
    const position = action.target.kind === 'voxel' ? action.target.position : undefined;
    const faultEvent = fault ? worldEventById(state, fault.faultEventId) : undefined;
    const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
    if (ref.version !== 'mechanical-power-fault-observation-v1'
      || installationProject?.status !== 'completed'
      || installationProject.desiredFunction !== 'water-powered-crop-processing'
      || !plan
      || plan.projectId !== installationProject.id
      || installationProject.mechanicalPowerPlanKey !== mechanicalPowerPlanKey(plan)
      || installationProject.mechanicalPowerNetworkId !== ref.networkId
      || !network
      || !fault
      || fault.faultEventId !== ref.faultEventId
      || fault.kind !== 'worn-drive-shaft'
      || faultEvent?.kind !== 'action'
      || faultEvent.diff.mechanicalPowerFault !== true
      || faultEvent.diff.networkId !== network.id
      || !position
      || !samePosition(position, fault.componentPosition)
      || distanceToPosition(person, position) > perceptionRadius
      || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.BrokenDriveShaft) {
      return { status: 'blocked' as const, result: '眼前实体断轴与所指完成网络的当前磨损故障不一致', diff: {} };
    }
    const factId = mechanicalPowerFaultObservationFactId(network.id, fault.faultEventId);
    const summary = '观察并诊断出负载磨损导致传动轴断裂，网络因此停转';
    const existing = person.knowledge.find((fact) => fact.id === factId && fact.kind === 'observation');
    if (existing) {
      existing.confidence = clamp(Math.max(existing.confidence, 60) + 10);
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, fault.faultEventId, eventId])].slice(-24);
    } else person.knowledge.push({
      id: factId,
      kind: 'observation',
      summary,
      confidence: 68,
      learnedAtMonth: atMonth,
      sourceEventIds: [fault.faultEventId, eventId],
    });
    return {
      status: 'completed' as const,
      result: summary,
      diff: {
        factId,
        mechanicalPowerFaultDiagnosis: true,
        installationProjectId: installationProject.id,
        networkId: network.id,
        planKey: network.planKey,
        faultEventId: fault.faultEventId,
        faultKind: fault.kind,
        componentPosition: { ...fault.componentPosition },
      },
    };
  }
  let factId = `target:${JSON.stringify(action.target)}`;
  let summary = '持续观察了一个对象';
  if (action.target.kind === 'animal') {
    const animalId = action.target.animalId;
    const animal = state.world.animals.find((candidate) => candidate.id === animalId && isAnimalAlive(candidate));
    if (!animal) return { status: 'blocked' as const, result: '要观察的动物已经不在', diff: {} };
    factId = `animal:${animal.speciesId}`;
    summary = `观察并辨认了${animalSpecies(animal.speciesId).name}的行为`;
  }
  if (action.target.kind === 'inventory-stack' && action.target.personId === person.id) {
    const attendedStackId = action.target.stackId;
    const stack = person.inventory.find((candidate) => candidate.id === attendedStackId);
    if (!stack) return { status: 'blocked' as const, result: '观察对象已经不在背包中', diff: {} };
    const record = stack.recordPayloadId ? state.records.find((candidate) => candidate.id === stack.recordPayloadId) : undefined;
    if (record) {
      let codebook = person.knowledge.find((fact) => fact.id === record.codebookId
        && fact.kind === 'codebook'
        && fact.confidence >= 55);
      let selfDecodedCodebook = false;
      const recordUseIntent = intentId ? intentById(state, intentId) : undefined;
      const selfDecodeBasis = recordUseIntent?.status === 'active'
        && (recordUseIntent.recordUseBasis?.version === 'record-use-basis-v2'
          || recordUseIntent.recordUseBasis?.version === 'record-use-basis-v3')
        && recordUseIntent.recordUseBasis.readerId === person.id
        && recordUseIntent.recordUseBasis.recordId === record.id
        && recordUseIntent.recordUseBasis.knowledgeId === record.knowledgeId
        && recordUseIntent.recordUseBasis.codebookId === record.codebookId
        ? recordUseIntent.recordUseBasis
        : undefined;
      if (!codebook
        && selfDecodeBasis
        && record.kind === 'technique'
        && record.authorId !== person.id) {
        const existingCodebook = person.knowledge.find((fact) => fact.id === record.codebookId);
        if (!existingCodebook) {
          person.knowledge.push({
            id: record.codebookId,
            kind: 'codebook',
            summary: `能辨认“${record.summary}”所用实体刻痕的符号约定`,
            confidence: 58,
            learnedAtMonth: atMonth,
            sourceEventIds: [...new Set([record.id, ...record.sourceEventIds, eventId])].slice(-24),
          });
          codebook = person.knowledge.at(-1);
          selfDecodedCodebook = true;
        } else if (existingCodebook.kind === 'codebook') {
          existingCodebook.confidence = Math.max(existingCodebook.confidence, 58);
          existingCodebook.sourceEventIds = [...new Set([
            ...existingCodebook.sourceEventIds,
            record.id,
            ...record.sourceEventIds,
            eventId,
          ])].slice(-24);
          codebook = existingCodebook;
          selfDecodedCodebook = true;
        }
      }
      if (!codebook) return {
        status: 'completed' as const,
        result: '看见木制记录板上的规则刻痕，但还不知道这些符号表示什么',
        diff: { recordPayloadId: record.id, understood: false },
      };
      const known = person.knowledge.find((fact) => fact.id === record.knowledgeId);
      const preservesReliableTechnique = selfDecodeBasis?.version === 'record-use-basis-v3'
        && selfDecodeBasis.purpose === 'replicate'
        && known?.kind === 'technique'
        && known.confidence >= 55;
      if (known) {
        known.confidence = known.kind === 'technique'
          ? preservesReliableTechnique
            ? known.confidence
            : Math.min(54, Math.max(46, known.confidence + 8))
          : clamp(known.confidence + 8);
        known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId, record.id])].slice(-24);
      } else person.knowledge.push({
        id: record.knowledgeId,
        kind: record.kind === 'technique' ? 'technique' : 'claim',
        summary: record.summary,
        confidence: record.kind === 'technique' ? 46 : 52,
        learnedAtMonth: atMonth,
        sourceEventIds: [record.id, eventId],
      });
      return {
        status: 'completed' as const,
        result: `${selfDecodedCodebook ? '辨认刻痕并' : ''}阅读木制记录板：${record.summary}`,
        diff: {
          recordPayloadId: record.id,
          learnedFactId: record.knowledgeId,
          understood: true,
          ...(selfDecodedCodebook ? {
            selfDecodedCodebook: true,
            learnedCodebookId: codebook.id,
            learnedCodebookConfidence: codebook.confidence,
          } : {}),
        },
      };
    }
    const requestedVerification = action.verification;
    const sourceBoundTechnique = requestedVerification
      ? person.knowledge.find((fact) => fact.id === requestedVerification.techniqueId
        && fact.kind === 'technique'
        && fact.sourceEventIds.includes(requestedVerification.sourceEventId))
      : undefined;
    if (requestedVerification
      && sourceBoundTechnique
      && stack.materialId === requestedVerification.expectedMaterialId
      && stack.sourceEventIds.includes(requestedVerification.sourceEventId)) {
      sourceBoundTechnique.confidence = clamp(Math.max(sourceBoundTechnique.confidence, 46) + 22);
      sourceBoundTechnique.sourceEventIds = [...new Set([
        ...sourceBoundTechnique.sourceEventIds,
        eventId,
      ])].slice(-24);
      return {
        status: 'completed' as const,
        result: `核验了${sourceBoundTechnique.summary}`,
        diff: {
          factId: sourceBoundTechnique.id,
          verifiedTechnique: true,
          verifiedSourceEventId: requestedVerification.sourceEventId,
          verifiedMaterialId: stack.materialId,
          verifiedStackId: stack.id,
        },
      };
    }
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = worldEventById(state, sourceId);
      return source?.kind === 'action'
        && source.action.kind === 'act'
        && (source.action.operation === 'combine' || source.action.operation === 'exert' || source.action.operation === 'expose')
        && source.diff.outputStackId === stack.id
        && Number(source.diff.outputMaterialId) === stack.materialId;
    }));
    if (tentativeTechnique) {
      tentativeTechnique.confidence = clamp(tentativeTechnique.confidence + 22);
      tentativeTechnique.sourceEventIds = [...new Set([...tentativeTechnique.sourceEventIds, eventId])].slice(-24);
      return { status: 'completed' as const, result: `核验了${tentativeTechnique.summary}`, diff: { factId: tentativeTechnique.id, verifiedTechnique: true } };
    }
    factId = `material:${stack.materialId}`;
    summary = `观察并辨认了${materialDefinition(stack.materialId).name}`;
  }
  if (action.target.kind === 'voxel') {
    const attendedPosition = action.target.position;
    const materialId = voxelAt(state.world.grid, attendedPosition.x, attendedPosition.y, attendedPosition.z);
    if (materialId !== Material.Air) rememberMaterialPlace(person, materialId, attendedPosition, atMonth, eventId);
    const requestedVerification = action.verification;
    const sourceBoundTechnique = requestedVerification
      ? person.knowledge.find((fact) => fact.id === requestedVerification.techniqueId
        && fact.kind === 'technique'
        && fact.sourceEventIds.includes(requestedVerification.sourceEventId))
      : undefined;
    if (requestedVerification
      && sourceBoundTechnique
      && materialId === requestedVerification.expectedMaterialId) {
      sourceBoundTechnique.confidence = clamp(Math.max(sourceBoundTechnique.confidence, 46) + 22);
      sourceBoundTechnique.sourceEventIds = [...new Set([
        ...sourceBoundTechnique.sourceEventIds,
        eventId,
      ])].slice(-24);
      return {
        status: 'completed' as const,
        result: `核验了${sourceBoundTechnique.summary}`,
        diff: {
          factId: sourceBoundTechnique.id,
          verifiedTechnique: true,
          verifiedSourceEventId: requestedVerification.sourceEventId,
          verifiedMaterialId: materialId,
          verifiedPosition: { ...attendedPosition },
        },
      };
    }
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = worldEventById(state, sourceId);
      if (source?.kind !== 'action' || source.action.kind !== 'act' || !['combine', 'exert', 'expose'].includes(source.action.operation)) return false;
      const position = source.diff.position as VoxelPosition | undefined;
      return position?.x === attendedPosition.x
        && position.y === attendedPosition.y
        && position.z === attendedPosition.z
        && Number(source.diff.outputMaterialId) === materialId;
    }));
    if (tentativeTechnique) {
      tentativeTechnique.confidence = clamp(tentativeTechnique.confidence + 22);
      tentativeTechnique.sourceEventIds = [...new Set([...tentativeTechnique.sourceEventIds, eventId])].slice(-24);
      return { status: 'completed' as const, result: `核验了${tentativeTechnique.summary}`, diff: { factId: tentativeTechnique.id, verifiedTechnique: true } };
    }
    factId = `material:${materialId}`;
    summary = `观察并辨认了${materialDefinition(materialId).name}`;
  }
  const existing = person.knowledge.find((fact) => fact.id === factId);
  if (existing) {
    existing.confidence = clamp(existing.confidence + 12);
    existing.sourceEventIds.push(eventId);
  } else {
    person.knowledge.push({ id: factId, kind: 'observation', summary, confidence: 58, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  }
  return { status: 'completed' as const, result: summary, diff: { factId } };
}

export function executeIntentAction(
  state: SimulationState,
  person: PersonState,
  intent: Intent,
  atMonth: number,
  orderInMonth: number,
  actionTick: number,
): ActionFact {
  return executePrimitiveAction(state, person, intent.nextAction, atMonth, orderInMonth, { intentId: intent.id, cause: 'intent', actionTick });
}

function hibernationRecoveryActionAllowed(
  state: SimulationState,
  person: PersonState,
  action: PrimitiveAction,
  atMonth: number,
): boolean {
  if (lifePlanningStage(person, atMonth) === 'dependent-child') {
    return action.kind === 'move' && Boolean(action.wildlifeThreatBasis)
      || action.kind === 'act'
      && action.operation === 'ingest'
      && action.targets.some((target) => target.kind === 'inventory-stack' && target.personId === person.id);
  }
  if (action.kind === 'move') return true;
  if (action.kind === 'transfer') {
    return action.to.kind === 'person'
      && action.to.personId === person.id
      && (materialHas(action.materialId, 'edible') || materialHas(action.materialId, 'drinkable'));
  }
  if (action.kind !== 'act') return false;
  if (action.operation === 'ingest') return true;
  if (action.operation !== 'separate') return false;
  return action.targets.some((target) => target.kind === 'voxel'
    && (voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.BerryBush
      || voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.CropMature));
}

export function executePrimitiveAction(
  state: SimulationState,
  person: PersonState,
  action: PrimitiveAction,
  atMonth: number,
  orderInMonth: number,
  meta: { intentId?: string; cause: ActionFact['cause']; actionTick: number },
): ActionFact {
  const eventId = `e-${atMonth}-action-${person.id}-${orderInMonth}`;
  const fromCellId = person.position.cellId;
  const fromZ = person.position.z;
  const blockedByHibernationRecovery = isRecoveringFromDehydratedHibernation(person)
    && !hibernationRecoveryActionAllowed(state, person, action, atMonth);
  const techniqueLearning = action.kind === 'act'
    ? validateTechniqueLearningAction(state, person, action, atMonth)
    : { kind: 'none' as const };
  const outcome = blockedByHibernationRecovery
    ? { status: 'blocked' as const, result: '休眠恢复完成前只能取水、取食或进行必要移动', diff: { hibernationRecoveryRestricted: true } }
    : techniqueLearning.kind === 'blocked'
    ? { status: 'blocked' as const, result: techniqueLearning.reason, diff: {} }
    : action.kind === 'move'
      ? executeMove(state, person, action, eventId, atMonth)
      : action.kind === 'transfer'
        ? executeTransfer(state, person, action, atMonth, eventId)
        : action.kind === 'act'
          ? executeAct(state, person, action, atMonth, meta.actionTick, eventId)
          : action.kind === 'attend'
            ? executeAttend(state, person, action, atMonth, eventId, meta.intentId)
            : executeCommunicate(state, person, action, atMonth, eventId);
  if (outcome.status === 'completed'
    && action.kind === 'act'
    && action.operation === 'ingest'
    && isRecoveringFromDehydratedHibernation(person)) {
    const episode = person.conditions.find((condition) => condition.kind === 'dehydrated-hibernation'
      && hibernationPhase(condition) === 'recovering');
    if (episode) {
      episode.recoverySourceEventIds = [...new Set([...(episode.recoverySourceEventIds ?? []), eventId])].slice(-24);
      Object.assign(outcome.diff, {
        hibernationRecoverySource: true,
        hibernationConditionId: episode.id,
        hibernationPhase: 'recovering',
      });
    }
  }
  applyTechniqueLearning(techniqueLearning, outcome, eventId, atMonth);
  const pathSegment = 'path' in outcome ? outcome.path : [fromCellId];
  const fact: ActionFact = {
    id: eventId,
    kind: 'action',
    actionTick: meta.actionTick,
    atMonth,
    orderInMonth,
    cellId: person.position.cellId,
    who: person.id,
    ...(meta.intentId ? { intentId: meta.intentId } : {}),
    cause: meta.cause,
    action,
    fromCellId,
    toCellId: person.position.cellId,
    fromZ,
    toZ: person.position.z,
    pathSegment,
    status: outcome.status,
    result: outcome.result,
    diff: outcome.diff,
  };
  recordAgreementAction(state, fact);
  recordCollectiveAction(state, fact);
  recordGovernanceAction(state, fact);
  recordPermissionAction(state, fact);
  recordInteractionFailureKnowledge(state, fact);
  recordWitnessedDeclarationFulfillment(state, fact);
  rememberAction(state, fact);
  recordPersonalityEvidence(state, fact);
  recordActionOutcomeBelief(state, fact);
  return fact;
}
