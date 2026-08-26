import type { ActionOption, PrimitiveAction, VoxelPosition } from '../domain/action';
import {
  ELECTRICAL_POWER_ACTION_BASIS_VERSION,
  ELECTRICAL_POWER_LOAD_DEMAND,
  ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
  electricalPowerNetworkId,
  electricalPowerPlanKey,
  parseElectricalPowerLoadTechniqueId,
  validateElectricalPowerTopology,
  type ElectricalPowerNetworkState,
} from '../domain/electrical-power';
import {
  personalMechanicalServiceEventForElectricalPlan,
  reliableElectricalLoadTechniqueKnowledgeEvidence,
  reliableElectricalOperationKnowledgeEvidence,
} from '../domain/actions/electrical-power-actions';
import { Material, materialDefinition, materialHas } from '../domain/material';
import type { SimulationState } from '../domain/model';
import { inventoryQuantity, type PersonState } from '../domain/person';
import type { ProjectState } from '../domain/project';
import {
  cellId,
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  standingPositions,
  voxelAt,
  type StandingPosition,
} from '../world/grid';
import { seededFraction } from '../world/generator';

const MAX_ELECTRICAL_POWER_SERVICE_OPTIONS = 4;
const MAX_ELECTRICAL_POWER_TRIAL_MATERIALS = 4;
const MAX_ELECTRICAL_POWER_SERVICE_SOURCE_FACTS = 12;

function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

function actorOccupiesTarget(person: PersonState, target: VoxelPosition): boolean {
  return person.position.cellId === cellId(target.x, target.y)
    && (person.position.z === target.z || person.position.z + 1 === target.z);
}

function approachPosition(
  state: SimulationState,
  person: PersonState,
  target: VoxelPosition,
): StandingPosition | null {
  const targetCellId = cellId(target.x, target.y);
  return cellsInRadius(targetCellId, 1)
    .flatMap((candidateCellId) => standingPositions(state.world.grid, candidateCellId))
    .filter((position) => position.cellId !== targetCellId)
    .filter((position) => distanceToPosition({ ...person, position: { ...person.position, ...position } }, target) <= 1)
    .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z)[0]?.position ?? null;
}

function completedElectricalProjectForNetwork(
  state: SimulationState,
  network: ElectricalPowerNetworkState,
): ProjectState | null {
  const project = state.projects.find((candidate) => candidate.status === 'completed'
    && candidate.need === 'remote-work-power'
    && candidate.desiredFunction === 'remote-work-power-delivery'
    && candidate.electricalPowerNetworkId === network.id
    && candidate.electricalPowerPlanKey === network.planKey);
  const plan = project?.electricalPowerPlan;
  return project && plan
    && electricalPowerPlanKey(plan) === network.planKey
    && electricalPowerNetworkId(plan) === network.id
    && electricalPowerPlanKey(network.plan) === network.planKey
    ? project
    : null;
}

function boundedSourceFacts(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const bounded: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    bounded.push(value);
    if (bounded.length === MAX_ELECTRICAL_POWER_SERVICE_SOURCE_FACTS) break;
  }
  return bounded;
}

function trialInputStacks(state: SimulationState, person: PersonState) {
  const firstByMaterial = new Map<number, PersonState['inventory'][number]>();
  for (const stack of person.inventory) {
    const material = materialDefinition(stack.materialId);
    if (stack.quantity <= 0 || stack.recordPayloadId || material.phase !== 'solid' || material.mass <= 0) continue;
    const current = firstByMaterial.get(stack.materialId);
    if (!current || stack.id.localeCompare(current.id) < 0) firstByMaterial.set(stack.materialId, stack);
  }
  return [...firstByMaterial.values()]
    .map((stack) => ({
      stack,
      edible: materialHas(stack.materialId, 'edible'),
      rank: seededFraction(state.seed, `electrical-load-local-trial:${person.id}:${stack.materialId}`),
    }))
    .sort((left, right) => (left.edible ? 0 : 1) - (right.edible ? 0 : 1)
      || left.rank - right.rank
      || left.stack.materialId - right.stack.materialId
      || left.stack.id.localeCompare(right.stack.id))
    .slice(0, MAX_ELECTRICAL_POWER_TRIAL_MATERIALS)
    .map((candidate) => candidate.stack);
}

/**
 * Ordinary post-project use. Candidate selection knows only a completed visible
 * network, a reliable operation technique, one personal mechanical service,
 * and a bounded set of carried physical materials. The output response is not
 * present in this planner or in the action basis.
 */
export function buildElectricalPowerServiceOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  atMonth = state.clock.elapsedMonths + 1,
): ActionOption[] {
  const electricalWorld = state.world.electricalPower;
  const operationKnowledge = reliableElectricalOperationKnowledgeEvidence(state, person);
  if (!electricalWorld || !operationKnowledge) return [];
  const visible = new Set(visibleCells);
  const inputs = trialInputStacks(state, person);
  if (!inputs.length) return [];
  const options: ActionOption[] = [];
  const visibleNetworks = electricalWorld.networks
    .filter((network) => visible.has(cellId(network.plan.loadPosition.x, network.plan.loadPosition.y)))
    .sort((left, right) => seededFraction(state.seed, `electrical-service-network:${person.id}:${left.id}`)
      - seededFraction(state.seed, `electrical-service-network:${person.id}:${right.id}`)
      || left.id.localeCompare(right.id));
  for (const network of visibleNetworks) {
    if (options.length >= MAX_ELECTRICAL_POWER_SERVICE_OPTIONS) break;
    const project = completedElectricalProjectForNetwork(state, network);
    if (!project
      || network.fault
      || voxelAt(
        state.world.grid,
        network.plan.loadPosition.x,
        network.plan.loadPosition.y,
        network.plan.loadPosition.z,
      ) !== Material.ResistiveLoad
      || !validateElectricalPowerTopology(state.world.grid, network).valid) continue;
    const serviceEvent = personalMechanicalServiceEventForElectricalPlan(state, person, network.plan);
    if (!serviceEvent) continue;
    const currentConductor = network.components.find((component) => component.role === 'conductor'
      && network.plan.conductorPositions.some((position) => (
        position.x === component.position.x
          && position.y === component.position.y
          && position.z === component.position.z
      )));
    const recoveryRepairEventId = currentConductor?.latestRepairEventId;
    const closeEnough = distanceToPosition(person, network.plan.loadPosition) <= 1
      && !actorOccupiesTarget(person, network.plan.loadPosition);
    const approach = closeEnough ? null : approachPosition(state, person, network.plan.loadPosition);
    if (!closeEnough && !approach) continue;
    for (const input of inputs) {
      if (options.length >= MAX_ELECTRICAL_POWER_SERVICE_OPTIONS) break;
      const knownLoadTechnique = reliableElectricalLoadTechniqueKnowledgeEvidence(
        state,
        person,
        input.materialId,
      );
      const knownLoadResponse = knownLoadTechnique
        ? parseElectricalPowerLoadTechniqueId(knownLoadTechnique.knowledge.id)
        : null;
      const action: Extract<PrimitiveAction, { kind: 'act' }> = {
        kind: 'act',
        operation: 'exert',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: input.id },
          { kind: 'voxel', position: { ...network.plan.loadPosition } },
        ],
        electricalPowerBasis: {
          version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
          mode: 'operate-service',
          planKey: network.planKey,
          networkId: network.id,
          mechanicalServiceEventId: serviceEvent.id,
          requestedPowerUnits: ELECTRICAL_POWER_LOAD_DEMAND,
          operationKnowledgeId: ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
          inputMaterialId: input.materialId,
          ...(recoveryRepairEventId ? { recoveryRepairEventId } : {}),
        },
      };
      options.push({
        id: `operate-completed-electrical-network:${network.id}:${input.id}`,
        summary: knownLoadTechnique
          ? `尝试复现“${knownLoadTechnique.knowledge.summary}”`
          : `尝试让${materialDefinition(input.materialId).name}接触已供电的电阻负载`,
        reason: knownLoadTechnique
          ? '本人可靠记得这项局部负载经验；机械来源、实体链、容量和输入仍须在动作时复核'
          : '本人可靠掌握眼前完成网络的供电操作，也亲自做过其机械来源服务；手中这一种实体材料可以作一次结果未知的局部尝试',
        goal: knownLoadResponse?.inputMaterialId === input.materialId
          ? {
            kind: 'inventory-at-least',
            materialId: knownLoadResponse.outputMaterialId,
            quantity: inventoryQuantity(person, knownLoadResponse.outputMaterialId) + 1,
          }
          : {
            kind: 'knowledge',
            factId: `attempt:electrical-load:${atMonth}:${person.id}:${network.id}:${input.id}`,
          },
        nextAction: closeEnough
          ? action
          : { kind: 'move', toCellId: approach!.cellId, toZ: approach!.z },
        ...(!closeEnough ? { completionAction: action } : {}),
        target: { kind: 'voxel', position: { ...network.plan.loadPosition } },
        estimatedDuration: closeEnough ? 'one-month' : 'several-months',
        sourceFactIds: boundedSourceFacts([
          operationKnowledge.sourceEvent.id,
          serviceEvent.id,
          ...(knownLoadTechnique ? [knownLoadTechnique.sourceEvent.id] : []),
          ...input.sourceEventIds.slice(-4),
          ...project.completionEventIds.slice(-1),
          ...network.installationEventIds.slice(-2),
          ...(recoveryRepairEventId ? [recoveryRepairEventId] : []),
        ]),
        domain: 'strategic',
      });
    }
  }
  return options;
}
