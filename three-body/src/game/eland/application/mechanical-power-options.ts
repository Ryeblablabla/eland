import {
  waterCurrentObservationFactId,
  type ActionOption,
  type PrimitiveAction,
  type VoxelPosition,
  type WorldRef,
} from '../domain/action';
import { completedActionFactsForPerson, worldEventById } from '../domain/event-index';
import {
  inventoryCombinationForOutput,
  inventoryCombinationTechniqueId,
  type InventoryCombinationRule,
} from '../domain/interaction-rules';
import {
  MECHANICAL_POWER_ACTION_BASIS_VERSION,
  MECHANICAL_POWER_PLAN_VERSION,
  mechanicalPowerNetworkId,
  mechanicalPowerPlanKey,
  plannedMechanicalPowerComponents,
  resolveWaterCurrentAvailability,
  type MechanicalPowerActionBasis,
  type MechanicalPowerProjectPlan,
  type WaterCurrentSegment,
} from '../domain/mechanical-power';
import { Material, materialDefinition, type MaterialId } from '../domain/material';
import type { ActionFact, SimulationState } from '../domain/model';
import type { ItemStack, PersonState } from '../domain/person';
import type { ProjectReservation, ProjectState } from '../domain/project';
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

export interface MechanicalPowerProjectStep {
  key: string;
  summary: string;
  reason: string;
  action: PrimitiveAction;
  target?: WorldRef;
  sourceFactIds: string[];
  missingMaterialIds: MaterialId[];
  reservations: ProjectReservation[];
  planKnowledgeId?: string;
}

export interface MechanicalPowerProposalCandidate {
  plan: MechanicalPowerProjectPlan;
  planKey: string;
  networkId: string;
  millLaborFact: ActionFact;
  observationFact: ActionFact;
}

function samePosition(left: VoxelPosition, right: VoxelPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function positionKey(position: VoxelPosition): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function actionOrder(left: ActionFact, right: ActionFact): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.id.localeCompare(right.id);
}

function actionAfter(candidate: ActionFact, basis: ActionFact): boolean {
  return actionOrder(candidate, basis) > 0;
}

function projectFacts(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.flatMap((eventId) => {
    const fact = worldEventById(state, eventId);
    return fact?.kind === 'action' ? [fact] : [];
  }).sort(actionOrder);
}

export function ownMillLaborFacts(state: SimulationState, person: PersonState): ActionFact[] {
  return completedActionFactsForPerson(state, person.id).filter((fact) => fact.who === person.id
    && fact.action.kind === 'act'
    && fact.action.operation === 'separate'
    && Number(fact.diff.sourceMaterialId) === Material.CropMature
    && Number(fact.diff.facilityMaterialId) === Material.Mill);
}

export function personalWaterCurrentObservation(
  state: SimulationState,
  person: PersonState,
  segmentId: string,
): ActionFact | null {
  const knowledge = person.knowledge.find((fact) => fact.id === waterCurrentObservationFactId(segmentId)
    && fact.kind === 'observation'
    && fact.confidence >= 55);
  if (!knowledge) return null;
  return knowledge.sourceEventIds.flatMap((eventId) => {
    const fact = worldEventById(state, eventId);
    return fact?.kind === 'action' ? [fact] : [];
  }).filter((fact) => fact.status === 'completed'
    && fact.who === person.id
    && fact.action.kind === 'attend'
    && fact.action.waterCurrentSegmentId === segmentId
    && fact.diff.mechanicalPowerObservation === true
    && fact.diff.waterCurrentSegmentId === segmentId)
    .sort(actionOrder)
    .at(-1) ?? null;
}

function visibleCurrentTargets(
  state: SimulationState,
  visibleCells: ReadonlySet<number>,
): Array<{ segment: WaterCurrentSegment; target: VoxelPosition; capacity: number }> {
  const mechanicalPower = state.world.mechanicalPower;
  if (!mechanicalPower) return [];
  const availability = new Map(resolveWaterCurrentAvailability(state.world.grid, mechanicalPower)
    .filter((candidate) => candidate.available)
    .map((candidate) => [candidate.segmentId, candidate]));
  return mechanicalPower.sources.flatMap((segment) => {
    const current = availability.get(segment.id);
    if (!current) return [];
    const target = segment.requiredWaterVoxels.find((position) => visibleCells.has(cellId(position.x, position.y))
      && voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Water);
    return target ? [{ segment, target, capacity: current.availableCapacity }] : [];
  });
}

export function buildWaterCurrentObservationOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): ActionOption[] {
  const millLabor = ownMillLaborFacts(state, person).at(-1);
  if (!millLabor) return [];
  return visibleCurrentTargets(state, new Set(visibleCells))
    .filter(({ segment }) => !personalWaterCurrentObservation(state, person, segment.id))
    .filter(({ target }) => Math.abs(cellX(person.position.cellId) - target.x)
      + Math.abs(cellY(person.position.cellId) - target.y) <= 7
      && Math.abs(target.z - person.position.z) <= 4 + Math.floor(person.baselineCapacities.perception / 25))
    .sort((left, right) => (
      Math.abs(cellX(person.position.cellId) - left.target.x)
        + Math.abs(cellY(person.position.cellId) - left.target.y)
        - Math.abs(cellX(person.position.cellId) - right.target.x)
        - Math.abs(cellY(person.position.cellId) - right.target.y)
    ) || left.segment.id.localeCompare(right.segment.id))
    .slice(0, 1)
    .map(({ segment, target }) => ({
      id: `observe-water-current:${segment.id}`,
      summary: '观察流水是否能持续推动实体构件',
      reason: '本人曾在磨坊真实处理成熟作物，现在又亲眼看见近处水体保持定向流动',
      goal: { kind: 'knowledge', factId: waterCurrentObservationFactId(segment.id), minConfidence: 55 },
      nextAction: {
        kind: 'attend',
        target: { kind: 'voxel', position: { ...target } },
        waterCurrentSegmentId: segment.id,
      },
      target: { kind: 'voxel', position: { ...target } },
      estimatedDuration: 'one-month',
      sourceFactIds: [millLabor.id],
      domain: 'strategic',
    }));
}

export function mechanicalPowerProposalCandidate(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): MechanicalPowerProposalCandidate | null {
  const millLaborFact = ownMillLaborFacts(state, person).at(-1);
  const mechanicalPower = state.world.mechanicalPower;
  if (!millLaborFact || !mechanicalPower) return null;
  const visible = new Set(visibleCells);
  const proposalMonth = state.clock.elapsedMonths + 1;
  const projectId = `project-${proposalMonth}-${person.id}-mechanical-power-capability`;
  const availableIds = new Set(resolveWaterCurrentAvailability(state.world.grid, mechanicalPower)
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.segmentId));
  const candidates = mechanicalPower.sources.flatMap((segment) => {
    if (!availableIds.has(segment.id)) return [];
    const observationFact = personalWaterCurrentObservation(state, person, segment.id);
    if (!observationFact || !segment.requiredWaterVoxels.some((position) => visible.has(cellId(position.x, position.y)))) return [];
    return segment.requiredWaterVoxels.flatMap((waterPosition) => {
      const wheelPosition = { x: waterPosition.x, y: waterPosition.y, z: waterPosition.z + 1 };
      if (!visible.has(cellId(wheelPosition.x, wheelPosition.y))
        || voxelAt(state.world.grid, wheelPosition.x, wheelPosition.y, wheelPosition.z) !== Material.Air) return [];
      return [
        { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
      ].flatMap(({ dx, dy }) => {
        const shaftPosition = { x: wheelPosition.x + dx, y: wheelPosition.y + dy, z: wheelPosition.z };
        const loadPosition = { x: wheelPosition.x + dx * 2, y: wheelPosition.y + dy * 2, z: wheelPosition.z };
        if ([shaftPosition, loadPosition].some((position) => position.x < 0
          || position.x >= state.world.grid.width
          || position.y < 0
          || position.y >= state.world.grid.depth
          || !visible.has(cellId(position.x, position.y))
          || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Air
          || materialDefinition(voxelAt(state.world.grid, position.x, position.y, position.z - 1)).phase !== 'solid')
          || !approachPosition(state, person, wheelPosition)
          || !approachPosition(state, person, shaftPosition)
          || !approachPosition(state, person, loadPosition)) return [];
        const plan: MechanicalPowerProjectPlan = {
          version: MECHANICAL_POWER_PLAN_VERSION,
          projectId,
          sourceSegmentId: segment.id,
          wheelPosition: { ...wheelPosition },
          shaftPositions: [{ ...shaftPosition }],
          loadPosition: { ...loadPosition },
          sourceKeys: [...segment.sourceKeys],
        };
        return [{
          plan,
          planKey: mechanicalPowerPlanKey(plan),
          networkId: mechanicalPowerNetworkId(plan),
          millLaborFact,
          observationFact,
        }];
      });
    });
  }).sort((left, right) => left.plan.shaftPositions.length - right.plan.shaftPositions.length
    || positionKey(left.plan.loadPosition).localeCompare(positionKey(right.plan.loadPosition))
    || left.plan.sourceSegmentId.localeCompare(right.plan.sourceSegmentId));
  return candidates[0] ?? null;
}

export function mechanicalPowerPressureEvidence(
  state: SimulationState,
  person: PersonState,
): { millLaborFactIds: string[]; observationFactIds: string[] } {
  const millLaborFactIds = ownMillLaborFacts(state, person).map((fact) => fact.id);
  const observationFactIds = state.world.mechanicalPower?.sources.flatMap((segment) => {
    const fact = personalWaterCurrentObservation(state, person, segment.id);
    return fact ? [fact.id] : [];
  }) ?? [];
  return { millLaborFactIds, observationFactIds };
}

function reservation(person: PersonState, stack: ItemStack): ProjectReservation[] {
  return [{ personId: person.id, stackId: stack.id, materialId: stack.materialId, quantity: 1 }];
}

function reliableRecipe(person: PersonState, outputMaterialId: MaterialId): InventoryCombinationRule | null {
  const rule = inventoryCombinationForOutput(outputMaterialId);
  if (!rule) return null;
  const techniqueId = inventoryCombinationTechniqueId(rule);
  return person.knowledge.some((fact) => fact.kind === 'technique'
    && fact.id === techniqueId
    && fact.confidence >= 55) ? rule : null;
}

function refsForRecipe(person: PersonState, rule: InventoryCombinationRule): Array<Extract<WorldRef, { kind: 'inventory-stack' }>> | null {
  const refs: Array<Extract<WorldRef, { kind: 'inventory-stack' }>> = [];
  const committed = new Map<string, number>();
  for (const input of rule.inputs) {
    const stack = person.inventory.find((candidate) => candidate.materialId === input.materialId
      && candidate.quantity - (committed.get(candidate.id) ?? 0) >= input.quantity
      && !candidate.recordPayloadId);
    if (!stack) return null;
    committed.set(stack.id, (committed.get(stack.id) ?? 0) + input.quantity);
    for (let count = 0; count < input.quantity; count += 1) {
      refs.push({ kind: 'inventory-stack', personId: person.id, stackId: stack.id });
    }
  }
  return refs;
}

function manufacturedFacts(
  state: SimulationState,
  project: ProjectState,
  outputMaterialId: MaterialId,
  after?: ActionFact,
): ActionFact[] {
  return projectFacts(state, project).filter((fact) => fact.status === 'completed'
    && fact.who === project.ownerId
    && fact.action.kind === 'act'
    && fact.action.operation === 'combine'
    && Number(fact.diff.outputMaterialId) === outputMaterialId
    && typeof fact.diff.outputStackId === 'string'
    && (!after || actionAfter(fact, after)));
}

function verificationFor(
  state: SimulationState,
  project: ProjectState,
  manufacture: ActionFact,
  materialId: MaterialId,
): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && fact.who === project.ownerId
    && fact.action.kind === 'attend'
    && fact.diff.verifiedSourceEventId === manufacture.id
    && Number(fact.diff.verifiedMaterialId) === materialId) ?? null;
}

function verifiedManufacture(
  state: SimulationState,
  project: ProjectState,
  materialId: MaterialId,
  after?: ActionFact,
): { manufacture: ActionFact; verification: ActionFact; stack: ItemStack | null } | null {
  for (const manufacture of manufacturedFacts(state, project, materialId, after).reverse()) {
    const verification = verificationFor(state, project, manufacture, materialId);
    if (!verification) continue;
    const stack = state.people.find((candidate) => candidate.id === project.ownerId)?.inventory.find((candidate) => (
      candidate.materialId === materialId
        && candidate.quantity > 0
        && candidate.sourceEventIds.includes(manufacture.id)
    )) ?? null;
    return { manufacture, verification, stack };
  }
  return null;
}

function manufactureStep(
  person: PersonState,
  project: ProjectState,
  materialId: MaterialId,
  label: string,
): MechanicalPowerProjectStep | null {
  const rule = reliableRecipe(person, materialId);
  if (!rule) return null;
  const refs = refsForRecipe(person, rule);
  if (!refs) return null;
  const knowledgeId = inventoryCombinationTechniqueId(rule);
  const knowledge = person.knowledge.find((fact) => fact.id === knowledgeId)!;
  return {
    key: `mechanical-manufacture-${materialId}-${refs.map((ref) => ref.stackId).join('-')}`,
    summary: `按本人已核验的经验制造${label}`,
    reason: '冻结计划只规定物理位置；具体材料配方来自本人已经可靠核验的制作经验',
    action: { kind: 'act', operation: 'combine', targets: refs },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...knowledge.sourceEventIds,
      ...refs.flatMap((ref) => person.inventory.find((stack) => stack.id === ref.stackId)?.sourceEventIds ?? []),
    ])],
    missingMaterialIds: [],
    reservations: refs.flatMap((ref) => {
      const stack = person.inventory.find((candidate) => candidate.id === ref.stackId);
      return stack ? reservation(person, stack) : [];
    }),
    planKnowledgeId: knowledgeId,
  };
}

function mechanicalComponentManufactureStep(
  person: PersonState,
  project: ProjectState,
  materialId: MaterialId,
  label: string,
): MechanicalPowerProjectStep | null {
  const direct = manufactureStep(person, project, materialId, label);
  if (direct || materialId !== Material.DriveShaft) return direct;
  const shaftRecipe = reliableRecipe(person, Material.DriveShaft);
  const bronzeQuantity = shaftRecipe?.inputs.find((input) => input.materialId === Material.Bronze)?.quantity ?? 0;
  const heldBronze = person.inventory
    .filter((stack) => stack.materialId === Material.Bronze && stack.quantity > 0 && !stack.recordPayloadId)
    .reduce((sum, stack) => sum + stack.quantity, 0);
  if (!shaftRecipe || heldBronze >= bronzeQuantity || !reliableRecipe(person, Material.Bronze)) return null;
  return manufactureStep(person, project, Material.Bronze, '传动轴所需的青铜中间料');
}

function verificationStep(
  person: PersonState,
  manufacture: ActionFact,
  materialId: MaterialId,
): MechanicalPowerProjectStep | null {
  const stack = person.inventory.find((candidate) => candidate.materialId === materialId
    && candidate.quantity > 0
    && candidate.sourceEventIds.includes(manufacture.id));
  const rule = inventoryCombinationForOutput(materialId);
  if (!stack || !rule) return null;
  const techniqueId = inventoryCombinationTechniqueId(rule);
  return {
    key: `mechanical-verify-${manufacture.id}-${stack.id}`,
    summary: `核验刚制造的${materialDefinition(materialId).name}`,
    reason: '构件必须由本人对这次真实制造结果作源事件绑定的核验，旧成品不能替代',
    action: {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
      verification: { techniqueId, sourceEventId: manufacture.id, expectedMaterialId: materialId },
    },
    target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
    sourceFactIds: [...new Set([manufacture.id, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack),
    planKnowledgeId: techniqueId,
  };
}

function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

function approachPosition(
  state: SimulationState,
  person: PersonState,
  target: VoxelPosition,
  interactionRange = 1,
): StandingPosition | null {
  const targetCellId = cellId(target.x, target.y);
  const candidates = cellsInRadius(cellId(target.x, target.y), 1)
    .flatMap((candidateCellId) => standingPositions(state.world.grid, candidateCellId))
    .filter((position) => position.cellId !== targetCellId)
    .filter((position) => distanceToPosition({ ...person, position: { ...person.position, ...position } }, target) <= interactionRange)
    .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  return candidates[0]?.position ?? null;
}

function moveOrActStep(
  state: SimulationState,
  person: PersonState,
  target: VoxelPosition,
  key: string,
  summary: string,
  reason: string,
  action: PrimitiveAction,
  sourceFactIds: string[],
  reservations: ProjectReservation[],
  interactionRange = 1,
): MechanicalPowerProjectStep | null {
  const actorOccupiesTarget = person.position.cellId === cellId(target.x, target.y)
    && (person.position.z === target.z || person.position.z + 1 === target.z);
  if (distanceToPosition(person, target) <= interactionRange && !actorOccupiesTarget) return {
    key,
    summary,
    reason,
    action,
    target: { kind: 'voxel', position: { ...target } },
    sourceFactIds: [...new Set(sourceFactIds)],
    missingMaterialIds: [],
    reservations,
  };
  const approach = approachPosition(state, person, target, interactionRange);
  if (!approach) return null;
  return {
    key: `approach-${key}-${approach.cellId}-${approach.z}`,
    summary: `前往冻结的机械构件位置继续${summary}`,
    reason: '构件位置已经在提案时冻结；人物只移动到可达的近身工作位，不改写计划几何',
    action: { kind: 'move', toCellId: approach.cellId, toZ: approach.z },
    target: { kind: 'voxel', position: { ...target } },
    sourceFactIds: [...new Set(sourceFactIds)],
    missingMaterialIds: [],
    reservations,
  };
}

function basisFor(
  project: ProjectState,
  mode: Exclude<MechanicalPowerActionBasis['mode'], 'observe-source'>,
  fields: Record<string, unknown>,
): MechanicalPowerActionBasis {
  const plan = project.mechanicalPowerPlan!;
  return {
    version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
    mode,
    sourceSegmentId: plan.sourceSegmentId,
    sourceKeys: [...plan.sourceKeys],
    projectId: project.id,
    planKey: project.mechanicalPowerPlanKey!,
    networkId: project.mechanicalPowerNetworkId!,
    ...fields,
  } as MechanicalPowerActionBasis;
}

function installedAt(
  state: SimulationState,
  project: ProjectState,
  role: 'converter' | 'connector' | 'load',
  position: VoxelPosition,
): boolean {
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId
    && candidate.planKey === project.mechanicalPowerPlanKey);
  return Boolean(network?.components.some((component) => component.role === role
    && component.projectId === project.id
    && samePosition(component.position, position)));
}

function installStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  role: 'converter' | 'connector' | 'load',
  materialId: MaterialId,
  position: VoxelPosition,
  verified: { manufacture: ActionFact; verification: ActionFact; stack: ItemStack | null } | null,
): MechanicalPowerProjectStep | null {
  const stack = verified?.stack ?? null;
  if (!stack) return null;
  const basis = basisFor(project, 'install', {
    componentRole: role,
    componentMaterialId: materialId,
    componentPosition: { ...position },
  });
  const targets: WorldRef[] = [
    ...(stack ? [{ kind: 'inventory-stack' as const, personId: person.id, stackId: stack.id }] : []),
    { kind: 'voxel', position: { ...position } },
  ];
  return moveOrActStep(
    state,
    person,
    position,
    `mechanical-install-${role}-${positionKey(position)}`,
    `在冻结位置安装${materialDefinition(materialId).name}`,
    '经过本人制造与源事件核验的构件必须落在计划中的精确位置；旧磨坊经验只提供压力，不代替新负载',
    { kind: 'act', operation: 'exert', targets, mechanicalPowerBasis: basis },
    [...project.triggerFactIds, ...(verified ? [verified.manufacture.id, verified.verification.id] : [])],
    reservation(person, stack),
    role === 'converter' ? 2 : 1,
  );
}

function faultFact(state: SimulationState, project: ProjectState): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'progressed'
    && fact.who === project.ownerId
    && fact.diff.mechanicalPowerFault === true
    && fact.diff.networkId === project.mechanicalPowerNetworkId) ?? null;
}

function repairFact(state: SimulationState, project: ProjectState, fault: ActionFact): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && actionAfter(fact, fault)
    && fact.who === project.ownerId
    && fact.diff.mechanicalPowerRepair === true
    && fact.diff.faultEventId === fault.id
    && fact.diff.networkId === project.mechanicalPowerNetworkId) ?? null;
}

function operationFact(state: SimulationState, project: ProjectState, after: ActionFact): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && actionAfter(fact, after)
    && fact.who === project.ownerId
    && fact.diff.mechanicalPowerOperation === true
    && fact.diff.networkId === project.mechanicalPowerNetworkId
    && Number(fact.diff.inputMaterialId) === Material.Seed
    && Number(fact.diff.outputMaterialId) === Material.Food) ?? null;
}

function operateStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerProjectStep | null {
  const plan = project.mechanicalPowerPlan!;
  const input = person.inventory.find((stack) => stack.materialId === Material.Seed
    && stack.quantity > 0
    && !stack.recordPayloadId);
  if (!input) return null;
  const basis = basisFor(project, 'operate', {
    inputMaterialId: Material.Seed,
    outputMaterialId: Material.Food,
  });
  return moveOrActStep(
    state,
    person,
    plan.loadPosition,
    `mechanical-operate-${input.id}`,
    '让流水经水轮与传动轴驱动磨坊处理种子',
    '输入、流量、拓扑与故障状态都将在扣除种子前由领域执行器实时复核',
    {
      kind: 'act', operation: 'exert',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: { ...plan.loadPosition } },
      ],
      mechanicalPowerBasis: basis,
    },
    [...project.triggerFactIds, ...input.sourceEventIds],
    reservation(person, input),
  );
}

function repairStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  fault: ActionFact,
  replacement: { manufacture: ActionFact; verification: ActionFact; stack: ItemStack | null },
): MechanicalPowerProjectStep | null {
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId);
  const faultState = network?.fault;
  const tool = person.inventory.find((stack) => stack.materialId === Material.BronzeTool
    && stack.quantity > 0
    && !stack.recordPayloadId);
  if (!faultState || faultState.faultEventId !== fault.id || !replacement.stack || !tool) return null;
  const basis = basisFor(project, 'repair', {
    faultEventId: fault.id,
    replacementMaterialId: Material.DriveShaft,
    toolMaterialId: Material.BronzeTool,
  });
  return moveOrActStep(
    state,
    person,
    faultState.componentPosition,
    `mechanical-repair-${fault.id}-${replacement.stack.id}-${tool.id}`,
    '用新传动轴和青铜工具修复试运转故障',
    '替换构件必须在故障之后真实制造并核验，工具与故障体素也必须仍然存在',
    {
      kind: 'act', operation: 'exert', toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: replacement.stack.id },
        { kind: 'voxel', position: { ...faultState.componentPosition } },
      ],
      mechanicalPowerBasis: basis,
    },
    [fault.id, replacement.manufacture.id, replacement.verification.id, ...tool.sourceEventIds],
    [...reservation(person, replacement.stack), ...reservation(person, tool)],
  );
}

function planContractValid(project: ProjectState): boolean {
  const plan = project.mechanicalPowerPlan;
  return project.desiredFunction === 'water-powered-crop-processing'
    && Boolean(plan
      && plan.version === MECHANICAL_POWER_PLAN_VERSION
      && plan.projectId === project.id
      && project.mechanicalPowerPlanKey === mechanicalPowerPlanKey(plan)
      && project.mechanicalPowerNetworkId === mechanicalPowerNetworkId(plan));
}

export function mechanicalPowerProjectStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerProjectStep | null {
  if (project.ownerId !== person.id || !planContractValid(project)) return null;
  const plan = project.mechanicalPowerPlan!;
  for (const materialId of [Material.Mill, Material.WaterWheel, Material.DriveShaft]) {
    const unverified = manufacturedFacts(state, project, materialId).reverse().find((manufacture) => (
      !verificationFor(state, project, manufacture, materialId)
        && person.inventory.some((stack) => stack.materialId === materialId
          && stack.quantity > 0
          && stack.sourceEventIds.includes(manufacture.id))
    ));
    if (unverified) return verificationStep(person, unverified, materialId);
  }
  if (!installedAt(state, project, 'load', plan.loadPosition)) {
    const loadManufactures = manufacturedFacts(state, project, Material.Mill);
    const load = verifiedManufacture(state, project, Material.Mill);
    if (!loadManufactures.length) return manufactureStep(person, project, Material.Mill, '水力磨坊负载');
    if (!load?.stack) return manufactureStep(person, project, Material.Mill, '水力磨坊负载');
    return installStep(state, person, project, 'load', Material.Mill, plan.loadPosition, load);
  }

  for (const shaftPosition of plan.shaftPositions) {
    if (installedAt(state, project, 'connector', shaftPosition)) continue;
    const shaftManufactures = manufacturedFacts(state, project, Material.DriveShaft);
    const shaft = verifiedManufacture(state, project, Material.DriveShaft);
    if (!shaftManufactures.length || !shaft?.stack) return mechanicalComponentManufactureStep(
      person, project, Material.DriveShaft, '传动轴',
    );
    return installStep(state, person, project, 'connector', Material.DriveShaft, shaftPosition, shaft);
  }
  if (!installedAt(state, project, 'converter', plan.wheelPosition)) {
    const wheelManufactures = manufacturedFacts(state, project, Material.WaterWheel);
    const wheel = verifiedManufacture(state, project, Material.WaterWheel);
    if (!wheelManufactures.length) return manufactureStep(person, project, Material.WaterWheel, '水轮');
    if (!wheel?.stack) return manufactureStep(person, project, Material.WaterWheel, '水轮');
    return installStep(state, person, project, 'converter', Material.WaterWheel, plan.wheelPosition, wheel);
  }

  const fault = faultFact(state, project);
  if (!fault) return operateStep(state, person, project);
  const repair = repairFact(state, project, fault);
  if (repair) return operationFact(state, project, repair) ? null : operateStep(state, person, project);

  const replacementManufactures = manufacturedFacts(state, project, Material.DriveShaft, fault);
  const replacement = verifiedManufacture(state, project, Material.DriveShaft, fault);
  if (!replacementManufactures.length) return mechanicalComponentManufactureStep(
    person, project, Material.DriveShaft, '替换传动轴',
  );
  if (!replacement?.stack) return mechanicalComponentManufactureStep(
    person, project, Material.DriveShaft, '替换传动轴',
  );
  return repairStep(state, person, project, fault, replacement);
}

export function mechanicalPowerMissingMaterials(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MaterialId[] {
  if (!planContractValid(project)) return [];
  const plan = project.mechanicalPowerPlan!;
  const missingForRecipe = (materialId: MaterialId): MaterialId[] => {
    const rule = reliableRecipe(person, materialId);
    if (!rule) return [];
    return rule.inputs.filter((input) => person.inventory
      .filter((stack) => stack.materialId === input.materialId && stack.quantity > 0 && !stack.recordPayloadId)
      .reduce((sum, stack) => sum + stack.quantity, 0) < input.quantity)
      .map((input) => input.materialId);
  };
  const missingForMechanicalComponent = (materialId: MaterialId): MaterialId[] => {
    const direct = missingForRecipe(materialId);
    if (materialId !== Material.DriveShaft || !direct.includes(Material.Bronze)) return direct;
    const withoutBronze = direct.filter((candidate) => candidate !== Material.Bronze);
    const bronzeRecipe = reliableRecipe(person, Material.Bronze);
    return [...new Set([
      ...withoutBronze,
      ...(bronzeRecipe ? missingForRecipe(Material.Bronze) : []),
    ])];
  };
  if (!installedAt(state, project, 'load', plan.loadPosition)) {
    if (!manufacturedFacts(state, project, Material.Mill).length) return missingForRecipe(Material.Mill);
    if (!verifiedManufacture(state, project, Material.Mill)) return [];
    return verifiedManufacture(state, project, Material.Mill)?.stack ? [] : missingForRecipe(Material.Mill);
  }
  if (plan.shaftPositions.some((position) => !installedAt(state, project, 'connector', position))) {
    const shaft = verifiedManufacture(state, project, Material.DriveShaft);
    return shaft?.stack ? [] : manufacturedFacts(state, project, Material.DriveShaft).length
      ? []
      : missingForMechanicalComponent(Material.DriveShaft);
  }
  if (!installedAt(state, project, 'converter', plan.wheelPosition)) {
    if (!manufacturedFacts(state, project, Material.WaterWheel).length) return missingForRecipe(Material.WaterWheel);
    if (!verifiedManufacture(state, project, Material.WaterWheel)) return [];
    return verifiedManufacture(state, project, Material.WaterWheel)?.stack ? [] : missingForRecipe(Material.WaterWheel);
  }
  const fault = faultFact(state, project);
  if (!fault) return person.inventory.some((stack) => stack.materialId === Material.Seed && stack.quantity > 0)
    ? [] : [Material.Seed];
  if (repairFact(state, project, fault)) return operationFact(state, project, repairFact(state, project, fault)!)
    || person.inventory.some((stack) => stack.materialId === Material.Seed && stack.quantity > 0)
    ? [] : [Material.Seed];
  const replacement = verifiedManufacture(state, project, Material.DriveShaft, fault);
  if (!replacement?.stack) {
    return manufacturedFacts(state, project, Material.DriveShaft, fault).length
      ? []
      : missingForMechanicalComponent(Material.DriveShaft);
  }
  return person.inventory.some((stack) => stack.materialId === Material.BronzeTool && stack.quantity > 0)
    ? [] : [Material.BronzeTool];
}

export function mechanicalPowerCompletionEvidence(
  state: SimulationState,
  project: ProjectState,
): string[] {
  if (!planContractValid(project)) return [];
  const plan = project.mechanicalPowerPlan!;
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId
    && candidate.planKey === project.mechanicalPowerPlanKey
    && candidate.installationProjectId === project.id
    && candidate.sourceSegmentId === plan.sourceSegmentId);
  if (!network || network.fault || network.condition < 100) return [];
  const allInstalled = plannedMechanicalPowerComponents(plan).every((planned) => network.components.some((component) => (
    component.role === planned.role
      && component.materialId === planned.materialId
      && component.projectId === project.id
      && samePosition(component.position, planned.position)
  )));
  if (!allInstalled) return [];
  const actions = projectFacts(state, project);
  const componentProvenanceComplete = plannedMechanicalPowerComponents(plan).every((planned) => {
    const component = network.components.find((candidate) => candidate.role === planned.role
      && candidate.materialId === planned.materialId
      && samePosition(candidate.position, planned.position));
    if (!component) return false;
    const manufacture = actions.find((fact) => component.sourceEventIds.includes(fact.id)
      && fact.status === 'completed'
      && fact.who === project.ownerId
      && fact.action.kind === 'act'
      && fact.action.operation === 'combine'
      && Number(fact.diff.outputMaterialId) === planned.materialId);
    return Boolean(manufacture && actions.some((fact) => component.sourceEventIds.includes(fact.id)
      && fact.status === 'completed'
      && fact.who === project.ownerId
      && fact.action.kind === 'attend'
      && fact.diff.verifiedSourceEventId === manufacture.id
      && Number(fact.diff.verifiedMaterialId) === planned.materialId));
  });
  if (!componentProvenanceComplete) return [];
  const fault = faultFact(state, project);
  if (!fault) return [];
  const repair = repairFact(state, project, fault);
  if (!repair) return [];
  const operation = operationFact(state, project, repair);
  if (!operation) return [];
  const projectIds = new Set(project.actionEventIds);
  const installationIds = network.installationEventIds.filter((id) => projectIds.has(id));
  if (installationIds.length !== plannedMechanicalPowerComponents(plan).length
    || !network.faultEventIds.includes(fault.id)
    || !network.repairEventIds.includes(repair.id)
    || !network.operationEventIds.includes(operation.id)) return [];
  return [...new Set([...installationIds, fault.id, repair.id, operation.id])];
}
