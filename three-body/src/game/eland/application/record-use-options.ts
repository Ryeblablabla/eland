import type {
  ActionOption,
  Intent,
  PrimitiveAction,
  RecordCarrierSource,
  RecordUseInputWitnessV1,
  RecordUseBasisV3,
  VoxelPosition,
  WorldRef,
} from '../domain/action';
import {
  exertionRuleFor,
  exertionTechniqueId,
  exposureRuleFor,
  exposureTechniqueId,
  inventoryCombinationFor,
  inventoryCombinationTechniqueId,
} from '../domain/interaction-rules';
import { Material, materialHas, type MaterialId } from '../domain/material';
import type { DropState, SimulationState } from '../domain/model';
import { isAlive, type PersonState } from '../domain/person';
import { inspectProjectKnowledgeRequest } from '../domain/project-knowledge-request';
import { techniqueOutputMaterialId } from '../domain/technique-demonstration';
import { inheritPlanningEventOverlay, worldEventById } from '../domain/event-index';
import { goalSatisfied } from '../domain/action-executor';
import { cellId, cellX, cellY, voxelAt } from '../world/grid';
import { previewOwnedProjectStep, recompileProjectNextAction } from './project-options';
import { projectById, projectsLedBy } from '../domain/state-index';
import { projectIsLedBy } from '../domain/project-leadership';
import type { ProjectStep } from './projects/project-step';

interface ResolvedTechniqueAction {
  action: Extract<PrimitiveAction, { kind: 'act' }>;
  techniqueId: string;
  expectedOutputMaterialId: MaterialId;
  inputSourceEventIds: string[];
  inputWitnesses: RecordUseInputWitnessV1[];
}

type RecordUsePurpose = NonNullable<RecordUseBasisV3['purpose']>;

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function stableBasisPart(value: string): string {
  return encodeURIComponent(value);
}

function projectRenewalBasisKey(project: SimulationState['projects'][number]): string {
  const inquiry = project.inquiryOpportunityBasis;
  const renewalEvidence = inquiry
    ? [
        `opening=${stableBasisPart(inquiry.basisKey)}`,
        `renewals=${unique(inquiry.renewalKeys).map(stableBasisPart).join(',')}`,
        `sources=${unique(inquiry.sourceFactIds).map(stableBasisPart).join(',')}`,
        `source-keys=${unique(inquiry.sourceKeys).map(stableBasisPart).join(',')}`,
      ].join(':')
    : `triggers=${unique(project.triggerFactIds).map(stableBasisPart).join(',')}`;
  return `project-opening:function=${stableBasisPart(project.desiredFunction)}:evidence=${renewalEvidence}`;
}

function recordUsePurpose(basis: RecordUseBasisV3): RecordUsePurpose {
  return basis.purpose ?? 'learn';
}

function replicationGoal(basis: RecordUseBasisV3): Extract<ActionOption['goal'], { kind: 'record-replication-receipt' }> | null {
  if (recordUsePurpose(basis) !== 'replicate'
    || basis.recordVersion === undefined
    || basis.expectedOutputMaterialId === undefined) return null;
  return {
    kind: 'record-replication-receipt',
    basisKey: basis.basisKey,
    readerId: basis.readerId,
    projectId: basis.projectId,
    recordId: basis.recordId,
    recordVersion: basis.recordVersion,
    techniqueId: basis.techniqueId,
    ruleSignature: basis.ruleSignature,
    expectedOutputMaterialId: basis.expectedOutputMaterialId,
  };
}

function recordUseBasisUnavailable(
  state: SimulationState,
  reader: PersonState,
  basisKey: string,
  atMonth: number,
): boolean {
  return state.intents.some((intent) => {
    if (intent.ownerId !== reader.id
      || intent.recordUseBasis?.version !== 'record-use-basis-v3'
      || recordUsePurpose(intent.recordUseBasis) !== 'replicate'
      || intent.recordUseBasis.basisKey !== basisKey) return false;
    if (intent.status === 'active' || intent.status === 'suspended') return true;
    if (intent.status === 'completed') return intent.goal.kind === 'record-replication-receipt'
      && intent.goal.basisKey === basisKey
      && intent.goalOutcome?.kind === 'achieved';
    if (intent.status !== 'blocked' && intent.status !== 'failed') return false;
    const resolvedAtMonth = intent.goalOutcome?.resolvedAtMonth ?? intent.lastProgressAtMonth;
    return resolvedAtMonth <= atMonth && atMonth - resolvedAtMonth <= 6;
  });
}

function bindResolvedInputs(basis: RecordUseBasisV3, resolved: ResolvedTechniqueAction): void {
  basis.inputSourceEventIds = unique(resolved.inputSourceEventIds);
  basis.inputWitnesses = structuredClone(resolved.inputWitnesses);
  basis.sourceFactIds = unique([...basis.sourceFactIds, ...basis.inputSourceEventIds]);
}

function inputWitnessForStack(
  person: PersonState,
  stack: PersonState['inventory'][number],
  role: RecordUseInputWitnessV1['role'],
  quantity: number,
): RecordUseInputWitnessV1 {
  const sourceEventIds = unique(stack.sourceEventIds);
  const isFounderRation = sourceEventIds.length === 0
    && person.generation === 0
    && stack.id === `stack-${person.id}-ration`
    && stack.materialId === Material.Food;
  return {
    version: 'record-use-input-witness-v1',
    role,
    personId: person.id,
    stackId: stack.id,
    materialId: stack.materialId,
    quantity,
    sourceEventIds,
    ...(isFounderRation ? {
      genesisEntity: {
        kind: 'founder-ration' as const,
        personId: person.id,
        stackId: stack.id,
        materialId: stack.materialId,
      },
    } : {}),
  };
}

function inputWitnessesAuditable(
  state: SimulationState,
  person: PersonState,
  witnesses: RecordUseInputWitnessV1[],
): boolean {
  return witnesses.length > 0 && witnesses.every((witness) => {
    if (witness.personId !== person.id || witness.quantity < 1 || !Number.isInteger(witness.quantity)) return false;
    if (witness.sourceEventIds.length > 0) {
      return witness.genesisEntity === undefined
        && witness.sourceEventIds.every((sourceEventId) => Boolean(worldEventById(state, sourceEventId)));
    }
    return witness.genesisEntity?.kind === 'founder-ration'
      && person.generation === 0
      && witness.stackId === `stack-${person.id}-ration`
      && witness.materialId === Material.Food
      && witness.genesisEntity.personId === person.id
      && witness.genesisEntity.stackId === witness.stackId
      && witness.genesisEntity.materialId === witness.materialId;
  });
}

function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

function bodyOccupies(state: SimulationState, position: VoxelPosition): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && (candidate.position.z === position.z || candidate.position.z + 1 === position.z));
}

function inventoryStack(
  person: PersonState,
  ref: Extract<WorldRef, { kind: 'inventory-stack' }>,
) {
  if (ref.personId !== person.id) return undefined;
  return person.inventory.find((stack) => stack.id === ref.stackId && stack.quantity > 0);
}

function inventoryRefsExecutable(
  person: PersonState,
  refs: Array<Extract<WorldRef, { kind: 'inventory-stack' }>>,
): boolean {
  const requested = new Map<string, number>();
  for (const ref of refs) {
    if (ref.personId !== person.id) return false;
    requested.set(ref.stackId, (requested.get(ref.stackId) ?? 0) + 1);
  }
  return [...requested].every(([stackId, quantity]) => (
    person.inventory.find((stack) => stack.id === stackId)?.quantity ?? 0
  ) >= quantity);
}

function resolveTechniqueAction(
  state: SimulationState,
  person: PersonState,
  action: PrimitiveAction,
): ResolvedTechniqueAction | null {
  if (action.kind !== 'act' || !['combine', 'exert', 'expose'].includes(action.operation)) return null;
  const stackRefs = action.targets.filter((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => (
    target.kind === 'inventory-stack'
  ));
  const voxelRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  if (!inventoryRefsExecutable(person, stackRefs)) return null;

  if (action.operation === 'combine' && !voxelRef) {
    if (stackRefs.length < 2) return null;
    const stacks = stackRefs.map((ref) => inventoryStack(person, ref));
    if (stacks.some((stack) => !stack)) return null;
    const rule = inventoryCombinationFor(stacks.map((stack) => stack?.materialId ?? Material.Air));
    if (!rule) return null;
    const requested = new Map<string, number>();
    for (const ref of stackRefs) requested.set(ref.stackId, (requested.get(ref.stackId) ?? 0) + 1);
    const inputWitnesses = [...requested].map(([stackId, quantity]) => {
      const stack = person.inventory.find((candidate) => candidate.id === stackId)!;
      return inputWitnessForStack(person, stack, 'input', quantity);
    }).sort((left, right) => left.stackId.localeCompare(right.stackId));
    return {
      action,
      techniqueId: inventoryCombinationTechniqueId(rule),
      expectedOutputMaterialId: rule.output.materialId,
      inputSourceEventIds: unique(stacks.flatMap((stack) => stack?.sourceEventIds ?? [])),
      inputWitnesses,
    };
  }

  if (!voxelRef || stackRefs.length !== 1 || distanceToPosition(person, voxelRef.position) > 1) return null;
  const stackRef = stackRefs[0];
  const stack = stackRef ? inventoryStack(person, stackRef) : undefined;
  if (!stack) return null;
  const targetMaterialId = voxelAt(
    state.world.grid,
    voxelRef.position.x,
    voxelRef.position.y,
    voxelRef.position.z,
  );

  if (action.operation === 'combine') {
    let outputMaterialId: MaterialId | null = null;
    const fertileSoils = new Set<MaterialId>([Material.WetSoil, Material.RichSoil, Material.ExhaustedSoil]);
    if (stack.materialId === Material.Seed && fertileSoils.has(targetMaterialId)) {
      outputMaterialId = Material.CropSprout;
    }
    if (targetMaterialId === Material.Air
      && materialHas(stack.materialId, 'solid')
      && (materialHas(stack.materialId, 'building') || materialHas(stack.materialId, 'placeable'))) {
      outputMaterialId = stack.materialId === Material.Wood ? Material.Plank : stack.materialId;
    }
    if (outputMaterialId === null
      || (materialHas(outputMaterialId, 'solid') && bodyOccupies(state, voxelRef.position))) return null;
    return {
      action,
      techniqueId: `technique:combine:${stack.materialId}:${targetMaterialId}:${outputMaterialId}`,
      expectedOutputMaterialId: outputMaterialId,
      inputSourceEventIds: unique(stack.sourceEventIds),
      inputWitnesses: [inputWitnessForStack(person, stack, 'input', 1)],
    };
  }

  if (action.operation === 'exert') {
    const tool = action.toolStackId
      ? person.inventory.find((candidate) => candidate.id === action.toolStackId && candidate.quantity > 0)
      : undefined;
    if (!tool) return null;
    const rule = exertionRuleFor(tool.materialId, stack.materialId, targetMaterialId);
    if (!rule) return null;
    return {
      action,
      techniqueId: exertionTechniqueId(rule),
      expectedOutputMaterialId: rule.outputMaterialId,
      inputSourceEventIds: unique([...tool.sourceEventIds, ...stack.sourceEventIds]),
      inputWitnesses: [
        inputWitnessForStack(person, stack, 'input', 1),
        inputWitnessForStack(person, tool, 'tool', 1),
      ].sort((left, right) => left.role.localeCompare(right.role) || left.stackId.localeCompare(right.stackId)),
    };
  }

  const rule = exposureRuleFor(stack.materialId, targetMaterialId);
  if (!rule) return null;
  return {
    action,
    techniqueId: exposureTechniqueId(rule),
    expectedOutputMaterialId: rule.outputMaterialId,
    inputSourceEventIds: unique(stack.sourceEventIds),
    inputWitnesses: [inputWitnessForStack(person, stack, 'input', 1)],
  };
}

function previewProjectAction(
  state: SimulationState,
  reader: PersonState,
  projectId: string,
  reliableTechniqueId?: string,
  sourceEventIds: string[] = [],
): PrimitiveAction | null {
  const previewState: SimulationState = {
    ...state,
    people: state.people.map((person) => person.id === reader.id ? structuredClone(person) : person),
    projects: state.projects.map((project) => project.status === 'active' ? structuredClone(project) : project),
  };
  inheritPlanningEventOverlay(state, previewState);
  const previewReader = previewState.people.find((candidate) => candidate.id === reader.id);
  if (previewReader && reliableTechniqueId) {
    const existing = previewReader.knowledge.find((fact) => fact.id === reliableTechniqueId && fact.kind === 'technique');
    if (existing) {
      existing.confidence = Math.max(55, existing.confidence);
      existing.sourceEventIds = unique([...existing.sourceEventIds, ...sourceEventIds]);
    } else previewReader.knowledge.push({
      id: reliableTechniqueId,
      kind: 'technique',
      summary: '从实体记录中待核验的技术线索',
      confidence: 55,
      learnedAtMonth: state.clock.elapsedMonths + 1,
      sourceEventIds: unique(sourceEventIds),
    });
  }
  return previewReader ? recompileProjectNextAction(previewState, previewReader, projectId) : null;
}

function previewProjectStepWithRecordKnowledge(
  state: SimulationState,
  reader: PersonState,
  projectId: string,
  knowledgeId: string,
  sourceEventIds: string[],
): ProjectStep | null {
  const planningReader = structuredClone(reader);
  const existing = planningReader.knowledge.find((fact) => fact.id === knowledgeId);
  if (existing && existing.kind !== 'technique') return null;
  if (existing) {
    existing.confidence = Math.max(55, existing.confidence);
    existing.sourceEventIds = unique([...existing.sourceEventIds, ...sourceEventIds]);
  } else planningReader.knowledge.push({
    id: knowledgeId,
    kind: 'technique',
    summary: '从实体记录中待核验的项目技术线索',
    confidence: 55,
    learnedAtMonth: state.clock.elapsedMonths + 1,
    sourceEventIds: unique(sourceEventIds),
  });
  return previewOwnedProjectStep(state, planningReader, projectId);
}

function activeLedProjects(state: SimulationState, reader: PersonState) {
  return projectsLedBy(state, reader.id)
    .filter((project) => project.status === 'active')
    .sort((left, right) => right.pressure - left.pressure
      || left.createdAtMonth - right.createdAtMonth
      || left.id.localeCompare(right.id));
}

function hasOpenMatchingKnowledgeRequest(
  state: SimulationState,
  project: SimulationState['projects'][number],
  outputMaterialId: MaterialId,
): boolean {
  return Boolean(project.knowledgeRequests?.some((request) => (
    request.outputMaterialId === outputMaterialId
    && inspectProjectKnowledgeRequest(
      state,
      project,
      request,
      state.clock.elapsedMonths + 1,
    ) === 'open'
  )));
}

function buildBasis(
  state: SimulationState,
  reader: PersonState,
  record: SimulationState['records'][number],
  project: SimulationState['projects'][number],
  purpose: RecordUsePurpose,
  expectedOutputMaterialId: MaterialId,
  carrierSource: RecordCarrierSource,
  carrierSourceEventIds: string[],
): RecordUseBasisV3 {
  const codebook = reader.knowledge.find((fact) => fact.id === record.codebookId
    && fact.kind === 'codebook'
    && fact.confidence >= 55);
  const projectSourceEventIds = unique([
    ...project.triggerFactIds,
    ...project.failureEventIds,
    ...project.actionEventIds,
    ...(project.pressureBasis?.sourceFactIds ?? []),
  ]);
  const recordSourceEventIds = unique(record.sourceEventIds);
  const codebookSourceEventIds = unique(codebook?.sourceEventIds ?? []);
  const inputSourceEventIds: string[] = [];
  const sourceFactIds = unique([
    record.id,
    ...projectSourceEventIds,
    ...recordSourceEventIds,
    ...codebookSourceEventIds,
    ...inputSourceEventIds,
    ...carrierSourceEventIds,
  ]);
  const renewalBasisKey = projectRenewalBasisKey(project);
  const ruleSignature = record.knowledgeId;
  const basisKey = purpose === 'replicate'
    ? [
        'record-use:replicate',
        stableBasisPart(reader.id),
        stableBasisPart(renewalBasisKey),
        stableBasisPart(record.id),
        `v${record.version}`,
        stableBasisPart(ruleSignature),
      ].join(':')
    : `record-use:${reader.id}:${project.id}:${record.id}:${record.knowledgeId}:${carrierSource.kind}:${carrierSource.kind === 'inventory' ? carrierSource.stackId : carrierSource.dropId}:${carrierSource.kind === 'ground' ? `${carrierSource.cellId}:${carrierSource.z}` : reader.id}:${carrierSource.kind === 'ground'}`;
  return {
    version: 'record-use-basis-v3',
    basisKey,
    projectId: project.id,
    projectOwnerId: project.ownerId,
    readerId: reader.id,
    recordAuthorId: record.authorId,
    demand: { kind: 'project-deficit', projectId: project.id, deficitSourceIds: projectSourceEventIds },
    recordId: record.id,
    knowledgeId: record.knowledgeId,
    codebookId: record.codebookId,
    techniqueId: record.knowledgeId,
    ruleSignature,
    projectPressure: project.pressure,
    expectedOutputMaterialId,
    createdAtMonth: state.clock.elapsedMonths + 1,
    projectSourceEventIds,
    recordSourceEventIds,
    codebookSourceEventIds,
    inputSourceEventIds,
    sourceFactIds,
    carrierSource: structuredClone(carrierSource),
    acquisitionRequired: carrierSource.kind === 'ground',
    purpose,
    recordVersion: record.version,
    projectRenewalBasisKey: renewalBasisKey,
    inputWitnesses: [],
  };
}

export function buildDemandBoundRecordUseOptions(
  state: SimulationState,
  reader: PersonState,
  visibleDrops: DropState[],
): ActionOption[] {
  if (!isAlive(reader)) return [];
  const ledProjects = activeLedProjects(state, reader);
  if (!ledProjects.length) return [];
  const sources = [
    ...reader.inventory
      .filter((stack) => stack.quantity > 0
        && stack.materialId === Material.WoodTablet
        && typeof stack.recordPayloadId === 'string')
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((stack) => ({
        recordPayloadId: stack.recordPayloadId!,
        carrierSource: { kind: 'inventory', personId: reader.id, stackId: stack.id } as const,
        sourceEventIds: stack.sourceEventIds,
      })),
    ...visibleDrops
      .filter((drop) => drop.quantity > 0
        && drop.materialId === Material.WoodTablet
        && typeof drop.recordPayloadId === 'string')
      .sort((left, right) => (
        distanceToPosition(reader, { x: cellX(left.cellId), y: cellY(left.cellId), z: left.z })
        - distanceToPosition(reader, { x: cellX(right.cellId), y: cellY(right.cellId), z: right.z })
        || left.id.localeCompare(right.id)
      ))
      .map((drop) => ({
        recordPayloadId: drop.recordPayloadId!,
        carrierSource: { kind: 'ground', dropId: drop.id, cellId: drop.cellId, z: drop.z } as const,
        sourceEventIds: drop.sourceEventIds,
      })),
  ];
  if (!sources.length) return [];
  const options: ActionOption[] = [];
  const consideredRecordIds = new Set<string>();

  for (const source of sources) {
    if (consideredRecordIds.has(source.recordPayloadId)) continue;
    consideredRecordIds.add(source.recordPayloadId);
    const record = state.records.find((candidate) => candidate.id === source.recordPayloadId && candidate.kind === 'technique');
    if (!record) continue;
    if (reader.id === record.authorId) continue;
    const codebook = reader.knowledge.find((fact) => fact.id === record.codebookId
      && fact.kind === 'codebook'
      && fact.confidence >= 55);
    const technique = reader.knowledge.find((fact) => fact.id === record.knowledgeId && fact.kind === 'technique');
    const purpose: RecordUsePurpose = (technique?.confidence ?? 0) >= 55 ? 'replicate' : 'learn';
    const alreadyRead = Boolean(technique?.sourceEventIds.includes(record.id));
    const expectedOutputMaterialId = techniqueOutputMaterialId(record.knowledgeId);
    if (expectedOutputMaterialId === undefined) continue;
    const matches = ledProjects.flatMap((project) => {
      const step = previewProjectStepWithRecordKnowledge(
        state,
        reader,
        project.id,
        record.knowledgeId,
        [record.id, ...record.sourceEventIds],
      );
      if (!step || step.planKnowledgeId !== record.knowledgeId) return [];
      const resolved = resolveTechniqueAction(state, reader, step.action);
      const experimentReady = Boolean(resolved
        && resolved.techniqueId === record.knowledgeId
        && resolved.expectedOutputMaterialId === expectedOutputMaterialId
        && inputWitnessesAuditable(state, reader, resolved.inputWitnesses));
      return [{
        project,
        step,
        experimentReady,
        hasOpenRequest: hasOpenMatchingKnowledgeRequest(state, project, expectedOutputMaterialId),
      }];
    }).sort((left, right) => Number(right.hasOpenRequest) - Number(left.hasOpenRequest)
      || right.project.pressure - left.project.pressure
      || left.project.createdAtMonth - right.project.createdAtMonth
      || left.project.id.localeCompare(right.project.id));
    const matched = matches[0];
    if (!matched) continue;
    const basis = buildBasis(
      state,
      reader,
      record,
      matched.project,
      purpose,
      expectedOutputMaterialId,
      source.carrierSource,
      source.sourceEventIds,
    );
    const goal = purpose === 'replicate'
      ? replicationGoal(basis)
      : { kind: 'knowledge' as const, factId: record.knowledgeId, minConfidence: 55 };
    if (!goal) continue;
    const optionMonth = state.clock.elapsedMonths + 1;
    if (purpose === 'replicate'
      && (goalSatisfied(state, reader, goal)
        || recordUseBasisUnavailable(state, reader, basis.basisKey, optionMonth))) continue;
    const atGroundSource = source.carrierSource.kind === 'ground'
      && reader.position.cellId === source.carrierSource.cellId
      && reader.position.z === source.carrierSource.z;
    const nextAction: PrimitiveAction = source.carrierSource.kind === 'inventory'
      ? alreadyRead
        ? structuredClone(matched.step.action)
        : { kind: 'attend', target: { kind: 'inventory-stack', personId: reader.id, stackId: source.carrierSource.stackId } }
      : atGroundSource
        ? {
          kind: 'transfer',
          materialId: Material.WoodTablet,
          quantity: 1,
          from: { kind: 'ground', cellId: source.carrierSource.cellId, z: source.carrierSource.z },
          to: { kind: 'person', personId: reader.id },
          dropId: source.carrierSource.dropId,
        }
        : { kind: 'move', toCellId: source.carrierSource.cellId, toZ: source.carrierSource.z };
    options.push({
      id: `use-demand-record:${record.id}:${matched.project.id}:${source.carrierSource.kind === 'inventory' ? source.carrierSource.stackId : source.carrierSource.dropId}`,
      summary: source.carrierSource.kind === 'ground'
        ? purpose === 'replicate'
          ? `取得异人记录并独立复现“${record.summary}”`
          : `取得公共记录并亲自复现“${record.summary}”`
        : alreadyRead
          ? purpose === 'replicate'
            ? `按异人记录独立复现“${record.summary}”`
            : `按已读记录复现“${record.summary}”`
          : `${codebook ? '阅读' : '辨认并阅读'}${purpose === 'replicate' ? '异人' : ''}记录，再亲自复现“${record.summary}”`,
      reason: source.carrierSource.kind === 'ground'
        ? purpose === 'replicate'
          ? `可见异人记录精确对应“${matched.project.summary}”即将使用的本人已知技术；先取得、${codebook ? '读懂' : '辨认刻痕'}，再按普通项目步骤做一次来源独立的实体复现`
          : `可见公共记录精确对应“${matched.project.summary}”的当前知识缺口；本人可先取得、${codebook ? '读懂' : '辨认刻痕'}，再按普通项目步骤准备核验材料`
        : alreadyRead
          ? purpose === 'replicate'
            ? `异人记录与“${matched.project.summary}”即将使用的本人已知技术一致；按普通物流准备真实输入并留下来源绑定的复现结果`
            : `这项暂定知识仍低于可靠阈值，并精确控制“${matched.project.summary}”当前步骤；先准备缺失材料再亲自核验`
          : purpose === 'replicate'
            ? `本人持有的异人实体记录对应“${matched.project.summary}”即将使用的同一技术；先阅读该具体版本，再以真实材料独立复现`
            : `本人持有的实体记录精确对应“${matched.project.summary}”当前知识缺口，${codebook ? '可以先阅读' : '可先观察实体刻痕并辨认'}，不要求核验材料已经齐备`,
      goal,
      nextAction,
      target: source.carrierSource.kind === 'inventory'
        ? { kind: 'inventory-stack', personId: reader.id, stackId: source.carrierSource.stackId }
        : { kind: 'drop', dropId: source.carrierSource.dropId },
      estimatedDuration: 'several-months',
      sourceFactIds: [...basis.sourceFactIds],
      domain: 'strategic',
      recordUseBasis: basis,
      recordUseStage: source.carrierSource.kind === 'ground'
        ? 'acquire'
        : alreadyRead
          ? matched.experimentReady
            ? purpose === 'replicate' ? 'replicate' : 'experiment'
            : 'prepare-experiment'
          : 'read',
    });
  }

  return [...new Map(options.map((option) => [option.id, option])).values()];
}

export function recompileRecordUseNextAction(
  state: SimulationState,
  person: PersonState,
  intent: Intent,
): PrimitiveAction | null {
  const basis = intent.recordUseBasis;
  if (!basis) return null;
  if (basis.version === 'record-use-basis-v1' && intent.recordUseStage === 'share') {
    const shareAction = intent.nextAction;
    if (shareAction.kind !== 'transfer'
      || shareAction.from.kind !== 'person'
      || shareAction.from.personId !== person.id) return null;
    const carrier = person.inventory.find((stack) => stack.id === shareAction.stackId
      && stack.quantity > 0
      && stack.recordPayloadId === basis.recordId);
    return carrier ? structuredClone(shareAction) : null;
  }
  if (basis.readerId !== person.id) return null;
  if (basis.version === 'record-use-basis-v1' && intent.recordUseStage !== 'read-experiment') return null;
  const projectCandidate = projectById(state, basis.projectId);
  const project = projectCandidate && projectIsLedBy(projectCandidate, person.id) && projectCandidate.status === 'active'
    ? projectCandidate
    : undefined;
  const record = state.records.find((candidate) => candidate.id === basis.recordId
    && candidate.kind === 'technique'
    && candidate.knowledgeId === basis.knowledgeId
    && candidate.codebookId === basis.codebookId
    && candidate.authorId !== person.id);
  const codebook = person.knowledge.find((fact) => fact.id === basis.codebookId
    && fact.kind === 'codebook'
    && fact.confidence >= 55);
  if (!project || !record) return null;

  const knowledge = person.knowledge.find((fact) => fact.id === basis.knowledgeId && fact.kind === 'technique');
  const purpose = basis.version === 'record-use-basis-v3' ? recordUsePurpose(basis) : 'learn';
  if (purpose === 'replicate') {
    if (basis.version !== 'record-use-basis-v3') return null;
    const goal = replicationGoal(basis);
    if (!goal
      || (knowledge?.confidence ?? 0) < 55
      || basis.recordVersion !== record.version
      || basis.ruleSignature !== record.knowledgeId
      || basis.projectRenewalBasisKey !== projectRenewalBasisKey(project)
      || goalSatisfied(state, person, goal)) return null;
  } else if ((knowledge?.confidence ?? 0) >= 55) return null;

  let carrier: PersonState['inventory'][number] | undefined;
  if (basis.version === 'record-use-basis-v1') {
    carrier = person.inventory.find((stack) => stack.quantity > 0 && stack.recordPayloadId === basis.recordId);
  } else if (basis.carrierSource.kind === 'inventory') {
    const sourceStackId = basis.carrierSource.stackId;
    carrier = person.inventory.find((stack) => stack.id === sourceStackId
      && stack.quantity > 0
      && stack.recordPayloadId === basis.recordId);
  } else {
    const sourceDropId = basis.carrierSource.dropId;
    carrier = person.inventory.find((stack) => stack.quantity > 0
      && stack.recordPayloadId === basis.recordId
      && stack.sourceLineageKeys?.includes(`drop:${sourceDropId}`));
  }

  if (!carrier && basis.version !== 'record-use-basis-v1') {
    if (!basis.acquisitionRequired || basis.carrierSource.kind !== 'ground') return null;
    const groundSource = basis.carrierSource;
    const source = state.world.drops.find((drop) => drop.id === groundSource.dropId
      && drop.quantity > 0
      && drop.materialId === Material.WoodTablet
      && drop.recordPayloadId === basis.recordId
      && drop.cellId === groundSource.cellId
      && drop.z === groundSource.z);
    if (!source) return null;
    if (person.position.cellId !== source.cellId || person.position.z !== source.z) {
      return { kind: 'move', toCellId: source.cellId, toZ: source.z };
    }
    return {
      kind: 'transfer',
      materialId: Material.WoodTablet,
      quantity: 1,
      from: { kind: 'ground', cellId: source.cellId, z: source.z },
      to: { kind: 'person', personId: person.id },
      dropId: source.id,
    };
  }
  if (!carrier) return null;

  if (basis.version === 'record-use-basis-v3') {
    if (intent.recordUseStage === 'acquire') intent.recordUseStage = 'read';
    if (intent.recordUseStage === 'read') {
      if (!codebook || !knowledge?.sourceEventIds.includes(record.id)) {
        return { kind: 'attend', target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id } };
      }
      intent.recordUseStage = 'prepare-experiment';
    }
    if (!codebook || !knowledge?.sourceEventIds.includes(record.id)) {
      intent.recordUseStage = 'read';
      return { kind: 'attend', target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id } };
    }
    if (intent.recordUseStage !== 'prepare-experiment'
      && intent.recordUseStage !== 'experiment'
      && intent.recordUseStage !== 'replicate') return null;
    const step = previewProjectStepWithRecordKnowledge(
      state,
      person,
      project.id,
      record.knowledgeId,
      [record.id, ...record.sourceEventIds],
    );
    if (!step || step.planKnowledgeId !== record.knowledgeId) return null;
    const resolved = resolveTechniqueAction(state, person, step.action);
    if (resolved
      && resolved.techniqueId === basis.techniqueId
      && resolved.techniqueId === record.knowledgeId
      && resolved.expectedOutputMaterialId === basis.expectedOutputMaterialId) {
      if (purpose === 'replicate' && !inputWitnessesAuditable(state, person, resolved.inputWitnesses)) return null;
      bindResolvedInputs(basis, resolved);
      intent.recordUseStage = purpose === 'replicate' ? 'replicate' : 'experiment';
      return structuredClone(resolved.action);
    }
    intent.recordUseStage = 'prepare-experiment';
    return structuredClone(step.action);
  }

  const currentProjectAction = previewProjectAction(
    state,
    person,
    project.id,
    record.knowledgeId,
    [record.id, ...record.sourceEventIds],
  );
  const resolved = currentProjectAction ? resolveTechniqueAction(state, person, currentProjectAction) : null;
  if (!resolved
    || resolved.techniqueId !== basis.techniqueId
    || resolved.techniqueId !== record.knowledgeId
    || resolved.expectedOutputMaterialId !== basis.expectedOutputMaterialId) return null;
  if (!codebook || !knowledge?.sourceEventIds.includes(record.id)) {
    return { kind: 'attend', target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id } };
  }
  return structuredClone(resolved.action);
}
