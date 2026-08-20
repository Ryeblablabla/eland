import type {
  ActionOption,
  Intent,
  PrimitiveAction,
  RecordCarrierSource,
  RecordUseBasisV2,
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
import { cellId, cellX, cellY, voxelAt } from '../world/grid';
import { recompileProjectNextAction } from './project-options';

interface ResolvedTechniqueAction {
  action: Extract<PrimitiveAction, { kind: 'act' }>;
  techniqueId: string;
  expectedOutputMaterialId: MaterialId;
  inputSourceEventIds: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
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
    return {
      action,
      techniqueId: inventoryCombinationTechniqueId(rule),
      expectedOutputMaterialId: rule.output.materialId,
      inputSourceEventIds: unique(stacks.flatMap((stack) => stack?.sourceEventIds ?? [])),
    };
  }

  if (!voxelRef || distanceToPosition(person, voxelRef.position) > 1) return null;
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
    };
  }

  const rule = exposureRuleFor(stack.materialId, targetMaterialId);
  if (!rule) return null;
  return {
    action,
    techniqueId: exposureTechniqueId(rule),
    expectedOutputMaterialId: rule.outputMaterialId,
    inputSourceEventIds: unique(stack.sourceEventIds),
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

function activeOwnedProject(state: SimulationState, reader: PersonState) {
  const activeIntent = state.intents.find((intent) => intent.id === reader.activeIntentId
    && intent.ownerId === reader.id
    && intent.status === 'active'
    && intent.projectId);
  if (!activeIntent?.projectId) return null;
  const project = state.projects.find((candidate) => candidate.id === activeIntent.projectId
    && candidate.ownerId === reader.id
    && candidate.status === 'active');
  return project ? { intent: activeIntent, project } : null;
}

function buildBasis(
  state: SimulationState,
  reader: PersonState,
  record: SimulationState['records'][number],
  action: ResolvedTechniqueAction,
  project: SimulationState['projects'][number],
  carrierSource: RecordCarrierSource,
  carrierSourceEventIds: string[],
): RecordUseBasisV2 {
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
  const inputSourceEventIds = unique(action.inputSourceEventIds);
  const sourceFactIds = unique([
    record.id,
    ...projectSourceEventIds,
    ...recordSourceEventIds,
    ...codebookSourceEventIds,
    ...inputSourceEventIds,
    ...carrierSourceEventIds,
  ]);
  return {
    version: 'record-use-basis-v2',
    basisKey: `record-use:${reader.id}:${project.id}:${record.id}:${action.techniqueId}:${carrierSource.kind}:${carrierSource.kind === 'inventory' ? carrierSource.stackId : carrierSource.dropId}:${carrierSource.kind === 'ground' ? `${carrierSource.cellId}:${carrierSource.z}` : reader.id}:${carrierSource.kind === 'ground'}`,
    projectId: project.id,
    projectOwnerId: project.ownerId,
    readerId: reader.id,
    recordAuthorId: record.authorId,
    demand: { kind: 'project-deficit', projectId: project.id, deficitSourceIds: projectSourceEventIds },
    recordId: record.id,
    knowledgeId: record.knowledgeId,
    codebookId: record.codebookId,
    techniqueId: action.techniqueId,
    ruleSignature: action.techniqueId,
    projectPressure: project.pressure,
    experimentAction: structuredClone(action.action),
    expectedOutputMaterialId: action.expectedOutputMaterialId,
    createdAtMonth: state.clock.elapsedMonths + 1,
    projectSourceEventIds,
    recordSourceEventIds,
    codebookSourceEventIds,
    inputSourceEventIds,
    sourceFactIds,
    carrierSource: structuredClone(carrierSource),
    acquisitionRequired: carrierSource.kind === 'ground',
  };
}

export function buildDemandBoundRecordUseOptions(
  state: SimulationState,
  reader: PersonState,
  visibleDrops: DropState[],
): ActionOption[] {
  if (!isAlive(reader)) return [];
  const anchored = activeOwnedProject(state, reader);
  if (!anchored) return [];
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
    if (!codebook) continue;
    const technique = reader.knowledge.find((fact) => fact.id === record.knowledgeId && fact.kind === 'technique');
    if ((technique?.confidence ?? 0) >= 55) continue;
    const alreadyRead = Boolean(technique?.sourceEventIds.includes(record.id));
    const projectAction = previewProjectAction(
      state,
      reader,
      anchored.project.id,
      record.knowledgeId,
      [record.id, ...record.sourceEventIds],
    );
    const resolved = projectAction ? resolveTechniqueAction(state, reader, projectAction) : null;
    if (!resolved || resolved.techniqueId !== record.knowledgeId) continue;
    const basis = buildBasis(
      state,
      reader,
      record,
      resolved,
      anchored.project,
      source.carrierSource,
      source.sourceEventIds,
    );
    const atGroundSource = source.carrierSource.kind === 'ground'
      && reader.position.cellId === source.carrierSource.cellId
      && reader.position.z === source.carrierSource.z;
    const nextAction: PrimitiveAction = source.carrierSource.kind === 'inventory'
      ? alreadyRead
        ? structuredClone(resolved.action)
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
      id: `use-demand-record:${record.id}:${anchored.project.id}:${source.carrierSource.kind === 'inventory' ? source.carrierSource.stackId : source.carrierSource.dropId}`,
      summary: source.carrierSource.kind === 'ground'
        ? `取得公共记录并亲自复现“${record.summary}”`
        : alreadyRead
          ? `按已读记录复现“${record.summary}”`
          : `阅读记录并亲自复现“${record.summary}”`,
      reason: source.carrierSource.kind === 'ground'
        ? `可见公共记录精确对应“${anchored.project.summary}”当前下一步，且本人已有解码知识和真实核验材料`
        : alreadyRead
          ? `这项暂定知识仍低于可靠阈值，且手头材料正好能推进“${anchored.project.summary}”`
          : `本人持有的实体记录精确对应“${anchored.project.summary}”当前下一步，且真实核验材料已经在手`,
      goal: { kind: 'knowledge', factId: record.knowledgeId, minConfidence: 55 },
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
          ? 'experiment'
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
  const project = state.projects.find((candidate) => candidate.id === basis.projectId
    && candidate.ownerId === person.id
    && candidate.status === 'active');
  const record = state.records.find((candidate) => candidate.id === basis.recordId
    && candidate.kind === 'technique'
    && candidate.knowledgeId === basis.knowledgeId
    && candidate.codebookId === basis.codebookId
    && candidate.authorId !== person.id);
  const codebook = person.knowledge.find((fact) => fact.id === basis.codebookId
    && fact.kind === 'codebook'
    && fact.confidence >= 55);
  if (!project || !record || !codebook) return null;

  const knowledge = person.knowledge.find((fact) => fact.id === basis.knowledgeId && fact.kind === 'technique');
  if ((knowledge?.confidence ?? 0) >= 55) return null;
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

  if (!carrier && basis.version === 'record-use-basis-v2') {
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

  if (!knowledge?.sourceEventIds.includes(record.id)) {
    return { kind: 'attend', target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id } };
  }
  return structuredClone(resolved.action);
}
