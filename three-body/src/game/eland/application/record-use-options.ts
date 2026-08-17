import type {
  ActionOption,
  Intent,
  PrimitiveAction,
  RecordUseBasis,
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
import type { SimulationState } from '../domain/model';
import { isAlive, sameLocation, type PersonState } from '../domain/person';
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
    people: structuredClone(state.people),
    projects: structuredClone(state.projects),
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
): RecordUseBasis {
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
  ]);
  return {
    version: 'record-use-basis-v1',
    basisKey: `record-use:${reader.id}:${project.id}:${record.id}:${action.techniqueId}`,
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
  };
}

export function buildDemandBoundRecordUseOptions(
  state: SimulationState,
  actor: PersonState,
  visiblePeople: PersonState[],
): ActionOption[] {
  const carriers = actor.inventory.filter((stack) => stack.quantity > 0
    && stack.materialId === Material.WoodTablet
    && typeof stack.recordPayloadId === 'string');
  if (!carriers.length) return [];
  const readers = [actor, ...visiblePeople]
    .filter((candidate, index, all) => isAlive(candidate)
      && all.findIndex((other) => other.id === candidate.id) === index);
  const options: ActionOption[] = [];

  for (const carrier of carriers) {
    const record = state.records.find((candidate) => candidate.id === carrier.recordPayloadId && candidate.kind === 'technique');
    if (!record) continue;
    for (const reader of readers) {
      if (reader.id === record.authorId) continue;
      const anchored = activeOwnedProject(state, reader);
      if (!anchored) continue;
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
      const basis = buildBasis(state, reader, record, resolved, anchored.project);
      const sourceFactIds = unique([
        record.id,
        ...basis.projectSourceEventIds,
        ...basis.recordSourceEventIds,
        ...basis.codebookSourceEventIds,
        ...basis.inputSourceEventIds,
        ...carrier.sourceEventIds,
      ]);

      if (reader.id === actor.id) {
        options.push({
          id: `use-demand-record:${record.id}:${anchored.project.id}`,
          summary: alreadyRead
            ? `按已读记录复现“${record.summary}”`
            : `阅读记录并亲自复现“${record.summary}”`,
          reason: alreadyRead
            ? `这项暂定知识仍低于可靠阈值，且手头材料正好能推进“${anchored.project.summary}”`
            : `实体记录精确对应“${anchored.project.summary}”当前下一步，且真实核验材料已经在手`,
          goal: { kind: 'knowledge', factId: record.knowledgeId, minConfidence: 55 },
          nextAction: alreadyRead
            ? structuredClone(resolved.action)
            : { kind: 'attend', target: { kind: 'inventory-stack', personId: reader.id, stackId: carrier.id } },
          target: { kind: 'inventory-stack', personId: reader.id, stackId: carrier.id },
          estimatedDuration: 'one-month',
          sourceFactIds,
          domain: 'strategic',
          recordUseBasis: basis,
          recordUseStage: 'read-experiment',
        });
      } else if (!alreadyRead
        && sameLocation(actor, reader)
        && !reader.inventory.some((stack) => stack.quantity > 0 && stack.recordPayloadId === record.id)) {
        options.push({
          id: `share-demand-record:${record.id}:${reader.id}:${anchored.project.id}`,
          summary: `把能解除项目技术缺口的记录板交给${reader.name}`,
          reason: `${reader.name}正在推进“${anchored.project.summary}”，这块实体记录与其下一项真实材料操作完全匹配`,
          goal: { kind: 'record-held', recordId: record.id, personId: reader.id },
          nextAction: {
            kind: 'transfer',
            materialId: Material.WoodTablet,
            quantity: 1,
            from: { kind: 'person', personId: actor.id },
            to: { kind: 'person', personId: reader.id },
            stackId: carrier.id,
          },
          target: { kind: 'person', personId: reader.id },
          estimatedDuration: 'one-month',
          sourceFactIds,
          domain: 'social',
          recordUseBasis: basis,
          recordUseStage: 'share',
        });
      }
    }
  }

  return [...new Map(options.map((option) => [option.id, option])).values()];
}

export function recompileRecordUseNextAction(
  state: SimulationState,
  person: PersonState,
  intent: Intent,
): PrimitiveAction | null {
  const basis = intent.recordUseBasis;
  if (!basis || intent.recordUseStage !== 'read-experiment' || basis.readerId !== person.id) return null;
  const project = state.projects.find((candidate) => candidate.id === basis.projectId
    && candidate.ownerId === person.id
    && candidate.status === 'active');
  const record = state.records.find((candidate) => candidate.id === basis.recordId
    && candidate.kind === 'technique'
    && candidate.knowledgeId === basis.knowledgeId
    && candidate.codebookId === basis.codebookId
    && candidate.authorId !== person.id);
  const carrier = person.inventory.find((stack) => stack.quantity > 0 && stack.recordPayloadId === basis.recordId);
  const codebook = person.knowledge.find((fact) => fact.id === basis.codebookId
    && fact.kind === 'codebook'
    && fact.confidence >= 55);
  if (!project || !record || !carrier || !codebook) return null;

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

  if (!knowledge?.sourceEventIds.includes(record.id)) {
    return { kind: 'attend', target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id } };
  }
  return structuredClone(resolved.action);
}
