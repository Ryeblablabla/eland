import type { PrimitiveAction, WorldRef } from '../../domain/action';
import {
  exposureRuleFor,
  exposureTechniqueId,
  exertionRuleFor,
  exertionTechniqueId,
  inventoryCombinationRules,
  inventoryCombinationTechniqueId,
  type ExertionRule,
  type ExposureRule,
} from '../../domain/interaction-rules';
import { Material, materialDefinition, materialHas, type MaterialId } from '../../domain/material';
import type { DropState, SimulationState } from '../../domain/model';
import type { ItemStack, PersonState } from '../../domain/person';
import type {
  ProjectFunction,
  ProjectHypothesisCandidate,
  ProjectHypothesisQuestionKind,
  ProjectInquiryOpportunityBasis,
  ProjectInquiryOpportunitySource,
  ProjectProposal,
  ProjectState,
} from '../../domain/project';
import { worldEventById } from '../../domain/event-index';
import { projectIsLedBy } from '../../domain/project-leadership';
import { projectsOwnedBy } from '../../domain/state-index';
import { findStandingPath, voxelAt } from '../../world/grid';
import {
  nextProjectHypothesisCandidate,
  type ProjectHypothesisRequest,
} from '../project-hypotheses';
import {
  completedFunctionMaterialIds,
} from './project-completion';
import {
  consumableInventoryQuantity,
  dropStep,
  isConsumableProjectStack,
  materialDemand,
  nearestDrop,
  reservation,
} from './project-material-planning';
import { visibleDropsFor } from './project-perception';
import { localHotTarget } from './project-spatial-planning';
import type { ProjectStep } from './project-step';
export interface ReliableExertionTechnique {
  rule: ExertionRule;
  knowledgeId: string;
  sourceEventIds: string[];
}

export interface ReliableExposureTechnique {
  rule: ExposureRule;
  knowledgeId: string;
  sourceEventIds: string[];
}

export function reliableExertionTechniques(person: PersonState): ReliableExertionTechnique[] {
  return person.knowledge.flatMap((fact) => {
    if (fact.kind !== 'technique' || fact.confidence < 55) return [];
    const match = fact.id.match(/^technique:exert:(\d+):(\d+):(\d+):(\d+)$/);
    if (!match) return [];
    const [toolMaterialId, inputMaterialId, targetMaterialId, outputMaterialId] = match.slice(1).map(Number);
    if (![toolMaterialId, inputMaterialId, targetMaterialId, outputMaterialId].every(Number.isSafeInteger)) return [];
    const rule = exertionRuleFor(toolMaterialId, inputMaterialId, targetMaterialId);
    if (!rule || rule.outputMaterialId !== outputMaterialId || exertionTechniqueId(rule) !== fact.id) return [];
    return [{ rule, knowledgeId: fact.id, sourceEventIds: [...fact.sourceEventIds] }];
  }).sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId));
}

export function reliableExposureTechniques(person: PersonState): ReliableExposureTechnique[] {
  return person.knowledge.flatMap((fact) => {
    if (fact.kind !== 'technique' || fact.confidence < 55) return [];
    const match = fact.id.match(/^technique:expose:(\d+):(\d+):(\d+)$/);
    if (!match) return [];
    const [inputMaterialId, targetMaterialId, outputMaterialId] = match.slice(1).map(Number);
    if (![inputMaterialId, targetMaterialId, outputMaterialId].every(Number.isSafeInteger)) return [];
    const rule = exposureRuleFor(inputMaterialId, targetMaterialId);
    if (!rule || rule.outputMaterialId !== outputMaterialId || exposureTechniqueId(rule) !== fact.id) return [];
    return [{ rule, knowledgeId: fact.id, sourceEventIds: [...fact.sourceEventIds] }];
  }).sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId));
}

export function tentativeTechniqueStep(state: SimulationState, person: PersonState, project: ProjectState): ProjectStep | null {
  const pendingAttempt = [...(project.hypothesisCampaign?.attempts ?? [])].reverse().find((attempt) => (
    attempt.outcome === 'response'
      && !attempt.verifiedEventId
      && attempt.verificationLostAtMonth === undefined
      && attempt.techniqueId
      && attempt.responseRef
  ));
  if (pendingAttempt?.techniqueId && pendingAttempt.responseRef) {
    const responseRef = pendingAttempt.responseRef;
    const target: WorldRef = responseRef.kind === 'inventory-stack'
      ? { kind: 'inventory-stack', personId: person.id, stackId: responseRef.stackId }
      : { kind: 'voxel', position: { ...responseRef.position } };
    const reservations = responseRef.kind === 'inventory-stack'
      ? reservation(person, responseRef.stackId)
      : [];
    return {
      key: `verify-response-${pendingAttempt.eventId}`,
      summary: `核验刚才产生的${materialDefinition(responseRef.materialId).name}`,
      reason: '真实响应先形成暂定经验；只有观察同一响应产生的实体，才能把它作为下一阶段的可靠依据',
      action: {
        kind: 'attend',
        target,
        verification: {
          techniqueId: pendingAttempt.techniqueId,
          sourceEventId: pendingAttempt.eventId,
          expectedMaterialId: responseRef.materialId,
        },
      },
      target,
      sourceFactIds: [...new Set([pendingAttempt.eventId, ...pendingAttempt.sourceFactIds])],
      missingMaterialIds: [],
      reservations,
      planKnowledgeId: pendingAttempt.techniqueId,
    };
  }
  const tentative = person.knowledge.find((fact) => fact.kind === 'technique'
    && fact.confidence < 55
    && !project.techniqueDemonstrations?.some((basis) => basis.techniqueId === fact.id
      && fact.sourceEventIds.includes(basis.demonstrationEventId))
    && fact.sourceEventIds.some((eventId) => project.actionEventIds.includes(eventId)));
  if (!tentative) return null;
  const source = tentative.sourceEventIds.map((eventId) => worldEventById(state, eventId)).find((event) => event?.kind === 'action');
  if (!source || source.kind !== 'action') return null;
  const outputStackId = typeof source.diff.outputStackId === 'string' ? source.diff.outputStackId : undefined;
  const stack = outputStackId ? person.inventory.find((candidate) => candidate.id === outputStackId) : undefined;
  const position = source.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const expectedOutput = Number(source.diff.outputMaterialId);
  const worldOutputStillPresent = [position?.x, position?.y, position?.z].every((value) => Number.isInteger(value))
    && voxelAt(state.world.grid, Number(position?.x), Number(position?.y), Number(position?.z)) === expectedOutput;
  const target: WorldRef | undefined = stack
    ? { kind: 'inventory-stack', personId: person.id, stackId: stack.id }
    : worldOutputStillPresent
      ? { kind: 'voxel', position: { x: Number(position?.x), y: Number(position?.y), z: Number(position?.z) } }
      : undefined;
  if (!target) return null;
  return {
    key: `verify-${tentative.id}`,
    summary: `复查项目试验“${tentative.summary}”`,
    reason: '一次变化只形成暂定经验，项目继续前需要本人观察核验',
    action: { kind: 'attend', target },
    target,
    sourceFactIds: [...tentative.sourceEventIds],
    missingMaterialIds: [],
    reservations: stack ? reservation(person, stack.id) : [],
    planKnowledgeId: tentative.id,
  };
}

export function inventorySourceKey(person: PersonState, stack: ItemStack): string {
  return `inventory:${person.id}:${stack.id}`;
}

function dropSourceKey(drop: DropState): string {
  return `drop:${drop.id}`;
}

export interface CandidateInventorySlot {
  materialId: MaterialId;
  sourceKey?: string;
}

function assignCandidateSource(
  slots: CandidateInventorySlot[],
  materialId: MaterialId | undefined,
  sourceKey: string | undefined,
): void {
  if (materialId === undefined || !sourceKey) return;
  const slot = slots.find((candidate) => candidate.materialId === materialId && candidate.sourceKey === undefined);
  if (slot) slot.sourceKey = sourceKey;
}

function pairSlots(candidate: ProjectHypothesisCandidate): CandidateInventorySlot[] {
  const slots = (candidate.inventoryMaterialIds ?? candidate.materialIds)
    .map((materialId) => ({ materialId }));
  assignCandidateSource(
    slots,
    candidate.toolRoleMaterialId ?? candidate.toolMaterialId,
    candidate.toolSourceKey,
  );
  assignCandidateSource(
    slots,
    candidate.inputRoleMaterialId ?? candidate.inputMaterialId,
    candidate.inputSourceKey,
  );
  return slots;
}

export function stacksForCandidateSlots(
  person: PersonState,
  slots: CandidateInventorySlot[],
  groundedDropSourceKeys: ReadonlySet<string>,
): ItemStack[] | null {
  const selected: Array<ItemStack | undefined> = new Array(slots.length);
  const usedQuantities = new Map<string, number>();
  const available = (stack: ItemStack): boolean => isConsumableProjectStack(stack)
    && stack.quantity > (usedQuantities.get(stack.id) ?? 0);
  const take = (index: number, stack: ItemStack): void => {
    selected[index] = stack;
    usedQuantities.set(stack.id, (usedQuantities.get(stack.id) ?? 0) + 1);
  };

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (!slot.sourceKey) continue;
    const exact = person.inventory.find((stack) => stack.materialId === slot.materialId
      && inventorySourceKey(person, stack) === slot.sourceKey
      && available(stack));
    if (exact) take(index, exact);
  }
  for (let index = 0; index < slots.length; index += 1) {
    if (selected[index]) continue;
    const slot = slots[index];
    if (slot.sourceKey && groundedDropSourceKeys.has(slot.sourceKey)) return null;
    const fallback = person.inventory.find((stack) => stack.materialId === slot.materialId && available(stack));
    if (!fallback) return null;
    take(index, fallback);
  }
  return selected.every((stack): stack is ItemStack => Boolean(stack)) ? selected : null;
}

function refsForPair(
  person: PersonState,
  candidate: ProjectHypothesisCandidate,
  groundedDropSourceKeys: ReadonlySet<string>,
): Extract<WorldRef, { kind: 'inventory-stack' }>[] | null {
  const stacks = stacksForCandidateSlots(person, pairSlots(candidate), groundedDropSourceKeys);
  return stacks?.map((stack) => ({
    kind: 'inventory-stack' as const,
    personId: person.id,
    stackId: stack.id,
  })) ?? null;
}

export function sourceEventIdsForTarget(
  state: SimulationState,
  project: ProjectState,
  position: { x: number; y: number; z: number },
  materialId: MaterialId,
): string[] {
  return project.actionEventIds.filter((eventId) => {
    const event = worldEventById(state, eventId);
    if (event?.kind !== 'action' || event.status !== 'completed') return false;
    const outputPosition = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    return Number(event.diff.outputMaterialId) === materialId
      && outputPosition?.x === position.x
      && outputPosition?.y === position.y
      && outputPosition?.z === position.z;
  });
}

function refsForExertCandidate(
  person: PersonState,
  candidate: ProjectHypothesisCandidate,
  groundedDropSourceKeys: ReadonlySet<string>,
): { toolStackId: string; inputRef: Extract<WorldRef, { kind: 'inventory-stack' }> } | null {
  const toolMaterialId = candidate.toolMaterialId ?? candidate.materialIds[0];
  const inputMaterialId = candidate.inputMaterialId ?? candidate.materialIds[1];
  const stacks = stacksForCandidateSlots(person, [
    { materialId: toolMaterialId, ...(candidate.toolSourceKey ? { sourceKey: candidate.toolSourceKey } : {}) },
    { materialId: inputMaterialId, ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}) },
  ], groundedDropSourceKeys);
  if (!stacks) return null;
  return {
    toolStackId: stacks[0].id,
    inputRef: { kind: 'inventory-stack', personId: person.id, stackId: stacks[1].id },
  };
}

function inventorySlotsForCandidate(candidate: ProjectHypothesisCandidate): CandidateInventorySlot[] {
  if (candidate.operation === 'combine-inventory') return pairSlots(candidate);
  if (candidate.operation === 'exert-air') return [
    {
      materialId: candidate.toolMaterialId ?? candidate.materialIds[0],
      ...(candidate.toolSourceKey ? { sourceKey: candidate.toolSourceKey } : {}),
    },
    {
      materialId: candidate.inputMaterialId ?? candidate.materialIds[1],
      ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}),
    },
  ];
  return [{
    materialId: candidate.inputMaterialId ?? candidate.materialIds[0],
    ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}),
  }];
}

function projectRetrievedDrop(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  dropId: string,
): boolean {
  return project.actionEventIds.some((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action'
      && event.status === 'completed'
      && event.who === person.id
      && event.action.kind === 'transfer'
      && event.action.from.kind === 'ground'
      && event.action.to.kind === 'person'
      && event.action.to.personId === person.id
      && event.action.dropId === dropId;
  });
}

function groundedDropSourceKeysForCandidate(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  candidate: ProjectHypothesisCandidate,
  reachableDrops: DropState[],
): Set<string> {
  const candidateKeys = new Set(inventorySlotsForCandidate(candidate)
    .map((slot) => slot.sourceKey)
    .filter((sourceKey): sourceKey is string => Boolean(sourceKey)));
  return new Set(reachableDrops
    .filter((drop) => candidateKeys.has(dropSourceKey(drop))
      && !projectRetrievedDrop(state, person, project, drop.id))
    .map(dropSourceKey));
}

function groundedCandidateDrop(
  candidate: ProjectHypothesisCandidate,
  reachableDrops: DropState[],
  groundedDropSourceKeys: ReadonlySet<string>,
): { drop: DropState; quantity: number } | null {
  for (const drop of reachableDrops) {
    const sourceKey = dropSourceKey(drop);
    if (!groundedDropSourceKeys.has(sourceKey)) continue;
    const quantity = inventorySlotsForCandidate(candidate).filter((slot) => slot.sourceKey === sourceKey).length;
    if (quantity > 0) return { drop, quantity };
  }
  return null;
}

function combineCandidateDescription(candidate: ProjectHypothesisCandidate): string {
  const counts = new Map<MaterialId, number>();
  for (const materialId of candidate.inventoryMaterialIds ?? candidate.materialIds) {
    counts.set(materialId, (counts.get(materialId) ?? 0) + 1);
  }
  return [...counts]
    .map(([materialId, quantity]) => `${quantity > 1 ? `${quantity}份` : ''}${materialDefinition(materialId).name}`)
    .join('与');
}

export function hypothesisStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  request: ProjectHypothesisRequest = { operation: 'combine-inventory' },
  targetPosition?: { x: number; y: number; z: number },
): ProjectStep | null {
  // A hypothesis campaign is one person's bounded, source-grounded inquiry,
  // not a public recipe hidden inside the project shell. Collaborators may
  // contribute requested materials, demonstrations and known techniques, but
  // they cannot silently execute a candidate compiled from the leader's
  // subjective evidence. A real leadership transition closes the old campaign
  // before a successor can open a new one.
  if (!projectIsLedBy(project, person.id)) return null;
  const reachableDrops = visibleDrops.filter((drop) => !drop.recordPayloadId
    && findStandingPath(
      state.world.grid,
      person.position,
      { cellId: drop.cellId, z: drop.z },
    ).length > 0);
  const purpose = project.summary;
  const candidate = nextProjectHypothesisCandidate(
    state.seed,
    state.clock.elapsedMonths + 1,
    person,
    project,
    reachableDrops,
    request,
  );
  if (!candidate) return null;
  const pair = candidate.materialIds;
  const groundedDropSourceKeys = groundedDropSourceKeysForCandidate(
    state,
    person,
    project,
    candidate,
    reachableDrops,
  );
  if (candidate.operation === 'combine-inventory') {
    const refs = refsForPair(person, candidate, groundedDropSourceKeys);
    if (refs) return {
      key: `hypothesis-${candidate.key}`,
      summary: `试验${combineCandidateDescription(candidate)}，观察它是否能为“${purpose}”提供证据`,
      reason: candidate.questionKind === 'assemble-balanced-suspension'
        ? '比较困境使人物尝试两件相同的刚性构件和一个柔性悬挂件；它们是否真的组成可用装置仍由世界响应决定'
        : candidate.questionKind === 'shape-repeatable-reference'
          ? '为了让比较结果可以重复，人物尝试给一个硬质稳定实体加上可识别的柔性标记；它是否可用仍未知'
          : candidate.reasonKeys.includes('verified-response-material')
            ? '本人刚核验了一种真实物质变化；把新物质放进下一次有限试验，观察它是否带来新的响应'
            : '当前困境与本人已经接触到的物质性质形成一个有限的局部假设；世界是否响应仍未知',
      action: { kind: 'act', operation: 'combine', targets: refs },
      sourceFactIds: [...candidate.sourceFactIds],
      missingMaterialIds: [],
      reservations: refs.flatMap((ref) => reservation(person, ref.stackId)),
    };
  }
  if (candidate.operation === 'exert-air' && targetPosition) {
    const exert = refsForExertCandidate(person, candidate, groundedDropSourceKeys);
    if (exert) return {
      key: `hypothesis-${candidate.key}`,
      summary: `尝试用${materialDefinition(candidate.toolMaterialId ?? pair[0]).name}向${materialDefinition(candidate.inputMaterialId ?? pair[1]).name}施力，观察它是否能为“${purpose}”提供证据`,
      reason: '已持有的硬物、可触及材料和眼前受支撑的空位形成局部施力假设；结果仍由真实物质响应裁决',
      action: {
        kind: 'act',
        operation: 'exert',
        toolStackId: exert.toolStackId,
        targets: [exert.inputRef, { kind: 'voxel', position: targetPosition }],
      },
      target: { kind: 'voxel', position: targetPosition },
      sourceFactIds: [...candidate.sourceFactIds],
      missingMaterialIds: [],
      reservations: [
        ...reservation(person, exert.toolStackId),
        ...reservation(person, exert.inputRef.stackId),
      ],
    };
  }
  if (candidate.operation === 'expose-local' && targetPosition) {
    const inputMaterialId = candidate.inputMaterialId ?? pair[0];
    const input = stacksForCandidateSlots(person, [{
      materialId: inputMaterialId,
      ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}),
    }], groundedDropSourceKeys)?.[0];
    if (input) return {
      key: `hypothesis-${candidate.key}`,
      summary: `让${materialDefinition(inputMaterialId).name}接触眼前的${materialDefinition(candidate.targetMaterialId ?? pair[1]).name}，观察它是否能为“${purpose}”提供证据`,
      reason: '这个热源已经真实存在于近旁；人物只试验手中物质与它接触后的可观察变化，不预知产物',
      action: {
        kind: 'act',
        operation: 'expose',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: input.id },
          { kind: 'voxel', position: targetPosition },
        ],
      },
      target: { kind: 'voxel', position: targetPosition },
      sourceFactIds: [...candidate.sourceFactIds],
      missingMaterialIds: [],
      reservations: reservation(person, input.id),
    };
  }
  const exactDrop = groundedCandidateDrop(candidate, reachableDrops, groundedDropSourceKeys);
  if (exactDrop) {
    const demand = materialDemand(
      person,
      exactDrop.drop.materialId,
      consumableInventoryQuantity(person, exactDrop.drop.materialId) + exactDrop.quantity,
      `hypothesis-source:${candidate.operation}:${candidate.key}:${exactDrop.drop.id}`,
      candidate.sourceFactIds,
    );
    const step = dropStep(person, exactDrop.drop, purpose, demand);
    if (step) return { ...step, missingMaterialIds: [exactDrop.drop.materialId] };
  }
  const quantities = new Map<MaterialId, number>();
  if (candidate.operation === 'combine-inventory') {
    (candidate.inventoryMaterialIds ?? pair).forEach((materialId) => (
      quantities.set(materialId, (quantities.get(materialId) ?? 0) + 1)
    ));
  } else {
    const inputMaterialId = candidate.inputMaterialId ?? pair[candidate.operation === 'exert-air' ? 1 : 0];
    quantities.set(inputMaterialId, 1);
  }
  const missing = [...quantities]
    .filter(([materialId, quantity]) => consumableInventoryQuantity(person, materialId) < quantity)
    .map(([materialId]) => materialId);
  const drop = nearestDrop(state, person, reachableDrops, missing);
  if (!drop) return null;
  const demand = materialDemand(
    person,
    drop.materialId,
    quantities.get(drop.materialId) ?? 1,
    `hypothesis:${candidate.operation}:${candidate.key}:${drop.materialId}`,
    candidate.sourceFactIds,
  );
  const step = dropStep(person, drop, purpose, demand);
  return step ? { ...step, missingMaterialIds: missing } : null;
}

export function blankRecordCarrier(person: PersonState): ItemStack | undefined {
  return person.inventory.find((stack) => stack.quantity > 0
    && !stack.recordPayloadId
    && materialHas(stack.materialId, 'recordable'));
}

function reliableTechniqueFacts(
  person: PersonState,
  desiredFunction: ProjectFunction,
): PersonState['knowledge'] {
  const outputs = new Map<string, MaterialId>([
    ...inventoryCombinationRules().map((rule) => [inventoryCombinationTechniqueId(rule), rule.output.materialId] as const),
    ...reliableExertionTechniques(person).map((technique) => [technique.knowledgeId, technique.rule.outputMaterialId] as const),
    ...reliableExposureTechniques(person).map((technique) => [technique.knowledgeId, technique.rule.outputMaterialId] as const),
  ]);
  const supportsFunction = (materialId: MaterialId): boolean => {
    if (desiredFunction === 'insulation') return materialHas(materialId, 'insulating');
    if (desiredFunction === 'safer-hunting') return materialHas(materialId, 'tool');
    if (desiredFunction === 'healing') return (materialDefinition(materialId).consume?.health ?? 0) > 0;
    if (desiredFunction === 'prepared-food') return materialId === Material.CookedFood || materialHas(materialId, 'hot');
    if (desiredFunction === 'durable-record') return materialHas(materialId, 'recordable');
    return completedFunctionMaterialIds({ desiredFunction }).includes(materialId);
  };
  return person.knowledge.filter((fact) => fact.kind === 'technique'
    && fact.confidence >= 55
    && outputs.has(fact.id)
    && supportsFunction(outputs.get(fact.id)!));
}

/**
 * Builds only positive, person-local opportunity evidence. A no-response fact
 * can remove a candidate elsewhere, but cannot make a later project look new.
 */
export function buildProjectInquiryOpportunityBasis(
  state: SimulationState,
  person: PersonState,
  desiredFunction: ProjectFunction,
  visibleDrops: DropState[] = visibleDropsFor(state, person),
  atMonth = state.clock.elapsedMonths + 1,
): ProjectInquiryOpportunityBasis {
  const materialSources = new Map<MaterialId, Array<{ sourceKeys: string[]; sourceFactIds: string[] }>>();
  const addMaterialSource = (
    materialId: MaterialId,
    sourceKey: string,
    sourceLineageKeys: string[],
    sourceFactIds: string[],
  ): void => {
    const sources = materialSources.get(materialId) ?? [];
    const sourceKeys = [...new Set([sourceKey, ...sourceLineageKeys])];
    if (!sources.some((source) => source.sourceKeys.some((key) => sourceKeys.includes(key)))) {
      sources.push({ sourceKeys, sourceFactIds: [...new Set(sourceFactIds)] });
      materialSources.set(materialId, sources);
    }
  };
  for (const stack of [...person.inventory].filter((item) => item.quantity > 0 && !item.recordPayloadId)
    .sort((left, right) => left.materialId - right.materialId || left.id.localeCompare(right.id))) {
    addMaterialSource(
      stack.materialId,
      inventorySourceKey(person, stack),
      stack.sourceLineageKeys ?? [],
      stack.sourceEventIds,
    );
  }
  for (const drop of [...visibleDrops].filter((item) => item.quantity > 0 && !item.recordPayloadId)
    .sort((left, right) => left.materialId - right.materialId || left.id.localeCompare(right.id))) {
    addMaterialSource(
      drop.materialId,
      dropSourceKey(drop),
      drop.sourceLineageKeys ?? [],
      drop.sourceEventIds,
    );
  }
  const techniques = reliableTechniqueFacts(person, desiredFunction);
  const verifiedAttempts = state.projects
    .filter((project) => project.ownerId === person.id && project.desiredFunction === desiredFunction)
    .flatMap((project) => project.hypothesisCampaign?.attempts ?? [])
    .filter((attempt) => attempt.outcome === 'response'
      && Boolean(attempt.verifiedEventId)
      && Boolean(attempt.responseRef)
      && verifiedResponseEntityStillPresent(state, person, attempt.responseRef));
  const hotTarget = ['prepared-food', 'brick-firing', 'copper-smelting', 'tin-smelting', 'iron-reduction'].includes(desiredFunction)
    ? localHotTarget(state, person)
    : null;
  const targetSourceKeys = hotTarget
    ? [`voxel:${hotTarget.position.x}:${hotTarget.position.y}:${hotTarget.position.z}:${hotTarget.materialId}`]
    : [];
  const readyCarrier = desiredFunction === 'durable-record' ? blankRecordCarrier(person) : undefined;
  const readyCarrierSourceKey = readyCarrier ? inventorySourceKey(person, readyCarrier) : undefined;
  const materialIds = [...materialSources.keys()].sort((left, right) => left - right);
  const techniqueIds = [...new Set(techniques.map((fact) => fact.id))].sort();
  const verifiedResponseEventIds = [...new Set(verifiedAttempts
    .map((attempt) => attempt.verifiedEventId)
    .filter((eventId): eventId is string => Boolean(eventId)))].sort();
  const opportunityKeys = [
    ...materialIds.map((materialId) => `material:${materialId}`),
    ...techniqueIds.map((techniqueId) => `knowledge:${techniqueId}`),
    ...targetSourceKeys.map((sourceKey) => `target:${sourceKey}`),
    ...(readyCarrierSourceKey ? [`ready-record-carrier:${readyCarrierSourceKey}`] : []),
    ...verifiedResponseEventIds.map((eventId) => `response:${eventId}`),
  ].sort();
  const opportunitySources: ProjectInquiryOpportunitySource[] = [
    ...[...materialSources].flatMap(([materialId, sources]) => sources.map((source) => ({
      opportunityKey: `material:${materialId}`,
      kind: 'material' as const,
      materialId,
      sourceKeys: [...source.sourceKeys],
      sourceFactIds: [...source.sourceFactIds],
    }))),
    ...techniques.map((fact) => ({
      opportunityKey: `knowledge:${fact.id}`,
      kind: 'knowledge' as const,
      sourceKeys: [`knowledge:${fact.id}`],
      sourceFactIds: [...fact.sourceEventIds],
    })),
    ...targetSourceKeys.map((sourceKey) => ({
      opportunityKey: `target:${sourceKey}`,
      kind: 'target' as const,
      ...(hotTarget ? { materialId: hotTarget.materialId } : {}),
      sourceKeys: [sourceKey],
      sourceFactIds: [],
    })),
    ...(readyCarrier && readyCarrierSourceKey ? [{
      opportunityKey: `ready-record-carrier:${readyCarrierSourceKey}`,
      kind: 'ready-record-carrier' as const,
      materialId: readyCarrier.materialId,
      sourceKeys: [readyCarrierSourceKey],
      sourceFactIds: [...readyCarrier.sourceEventIds],
    }] : []),
    ...verifiedAttempts.flatMap((attempt) => {
      if (!attempt.verifiedEventId || !attempt.responseRef) return [];
      const sourceKey = attempt.responseRef.kind === 'inventory-stack'
        ? `inventory:${person.id}:${attempt.responseRef.stackId}`
        : `voxel:${attempt.responseRef.position.x}:${attempt.responseRef.position.y}:${attempt.responseRef.position.z}:${attempt.responseRef.materialId}`;
      return [{
        opportunityKey: `response:${attempt.verifiedEventId}`,
        kind: 'verified-response' as const,
        materialId: attempt.responseRef.materialId,
        sourceKeys: [sourceKey],
        sourceFactIds: [attempt.eventId, attempt.verifiedEventId],
      }];
    }),
  ].sort((left, right) => left.opportunityKey.localeCompare(right.opportunityKey));
  return {
    version: 'project-inquiry-opportunity-basis-v1',
    actorId: person.id,
    desiredFunction,
    atMonth,
    materialIds,
    techniqueIds,
    targetSourceKeys,
    verifiedResponseEventIds,
    opportunityKeys,
    opportunitySources,
    sourceFactIds: [...new Set(opportunitySources.flatMap((source) => source.sourceFactIds))],
    sourceKeys: [...new Set(opportunitySources.flatMap((source) => source.sourceKeys))],
    basisKey: `${person.id}:${desiredFunction}:${opportunityKeys.join('|')}`,
    inheritedProjectIds: [],
    renewalKeys: [],
  };
}

function failedInquiryProjects(
  state: SimulationState,
  person: PersonState,
  desiredFunction: ProjectFunction,
): ProjectState[] {
  return projectsOwnedBy(state, person.id).filter((project) => project.ownerId === person.id
    && project.desiredFunction === desiredFunction
    && project.status === 'blocked'
    && (Boolean(project.hypothesisCampaign?.attempts.length)
      || project.searchCampaigns?.some((campaign) => campaign.status === 'exhausted')));
}

function exhaustedSearchCampaigns(project: ProjectState) {
  return (project.searchCampaigns ?? []).filter((campaign) => campaign.status === 'exhausted');
}

function sourceAlreadyExplored(
  source: ProjectInquiryOpportunitySource,
  priorSources: ProjectInquiryOpportunitySource[],
): boolean {
  return priorSources.some((prior) => prior.kind === 'material'
    && prior.materialId === source.materialId
    && (prior.sourceKeys.some((key) => source.sourceKeys.includes(key))
      || (source.sourceFactIds.length > 0
        && prior.sourceFactIds.some((eventId) => source.sourceFactIds.includes(eventId)))));
}

function sourceAlreadySearched(
  source: ProjectInquiryOpportunitySource,
  prior: ProjectState[],
): boolean {
  if (source.materialId === undefined || source.sourceFactIds.length === 0) return false;
  const sourceFactIds = new Set(source.sourceFactIds);
  return prior.some((project) => exhaustedSearchCampaigns(project).some((campaign) => (
    campaign.materialIds.includes(source.materialId!)
      && campaign.sourceFactIds.some((eventId) => sourceFactIds.has(eventId))
  )));
}

function exactSearchRenewalEvidence(
  basis: ProjectInquiryOpportunityBasis,
  prior: ProjectState[],
): { opportunityKeys: string[]; opportunitySources: ProjectInquiryOpportunitySource[] } {
  const searchedMaterialIds = new Set(prior
    .flatMap(exhaustedSearchCampaigns)
    .flatMap((campaign) => campaign.materialIds));
  const priorSources = prior.flatMap((project) => {
    const stored = project.terminalInquiryOpportunityBasis ?? project.inquiryOpportunityBasis;
    return stored?.opportunitySources ?? [];
  });
  const sources = basis.opportunitySources.flatMap((source) => {
    if (source.kind !== 'material'
      || source.materialId === undefined
      || !searchedMaterialIds.has(source.materialId)
      || sourceAlreadyExplored(source, priorSources)
      || sourceAlreadySearched(source, prior)) return [];
    const exactSourceKey = source.sourceKeys[0];
    if (!exactSourceKey) return [];
    return [{
      ...source,
      opportunityKey: `search-source:${source.materialId}:${exactSourceKey}`,
    }];
  });
  return {
    opportunityKeys: sources.map((source) => source.opportunityKey).sort(),
    opportunitySources: sources.sort((left, right) => left.opportunityKey.localeCompare(right.opportunityKey)),
  };
}

function exploredOpportunityKeys(project: ProjectState): string[] {
  const stored = project.terminalInquiryOpportunityBasis ?? project.inquiryOpportunityBasis;
  if (stored) return [...stored.opportunityKeys];
  return [
    ...(project.hypothesisCampaign?.observedMaterialIds ?? []).map((materialId) => `material:${materialId}`),
    ...(project.hypothesisCampaign?.attempts ?? []).flatMap((attempt) => attempt.verifiedEventId
      ? [`response:${attempt.verifiedEventId}`]
      : []),
    ...(project.planKnowledgeId ? [`knowledge:${project.planKnowledgeId}`] : []),
  ];
}

export function proposalWithInquiryOpportunityMemory(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  candidate: ProjectProposal,
): ProjectProposal | null {
  const basis = buildProjectInquiryOpportunityBasis(
    state,
    person,
    candidate.desiredFunction,
    visibleDrops,
    candidate.createdAtMonth,
  );
  const failed = failedInquiryProjects(state, person, candidate.desiredFunction);
  const searchPrior = failed.filter((project) => exhaustedSearchCampaigns(project).length > 0);
  const hypothesisPrior = failed.filter((project) => Boolean(project.hypothesisCampaign?.attempts.length));
  const prior = [...new Map([...searchPrior, ...hypothesisPrior]
    .map((project) => [project.id, project])).values()];
  if (!prior.length) return candidate.kind === 'construction' ? candidate : {
    ...candidate,
    inquiryOpportunityBasis: basis,
  };
  const explored = new Set(prior.flatMap(exploredOpportunityKeys));
  const hypothesisRenewalKeys = hypothesisPrior.length > 0
    ? basis.opportunityKeys.filter((key) => !explored.has(key))
    : [];
  const searchRenewal = exactSearchRenewalEvidence(basis, searchPrior);
  const reliablePlanRenewalKeys = searchPrior.length > 0
    ? basis.opportunitySources
      .filter((source) => source.kind === 'knowledge' && !explored.has(source.opportunityKey))
      .map((source) => source.opportunityKey)
    : [];
  const renewalKeys = [...new Set([
    ...hypothesisRenewalKeys,
    ...searchRenewal.opportunityKeys,
    ...reliablePlanRenewalKeys,
  ])].sort();
  if (renewalKeys.length === 0) return null;
  return {
    ...candidate,
    inquiryOpportunityBasis: {
      ...basis,
      opportunityKeys: [...new Set([...basis.opportunityKeys, ...searchRenewal.opportunityKeys])].sort(),
      opportunitySources: [...basis.opportunitySources, ...searchRenewal.opportunitySources],
      inheritedProjectIds: prior.map((project) => project.id).sort(),
      renewalKeys,
    },
  };
}

export function freezeTerminalInquiryOpportunityBasis(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  atMonth: number,
): void {
  if ((!project.hypothesisCampaign?.attempts.length && exhaustedSearchCampaigns(project).length === 0)
    || project.terminalInquiryOpportunityBasis) return;
  const current = buildProjectInquiryOpportunityBasis(
    state,
    person,
    project.desiredFunction,
    visibleDropsFor(state, person),
    atMonth,
  );
  const opening = project.inquiryOpportunityBasis;
  const planKnowledge = project.planKnowledgeId
    ? person.knowledge.find((fact) => fact.id === project.planKnowledgeId)
    : undefined;
  const planOpportunityKey = project.planKnowledgeId ? `knowledge:${project.planKnowledgeId}` : undefined;
  const planOpportunitySource: ProjectInquiryOpportunitySource | undefined = planOpportunityKey ? {
    opportunityKey: planOpportunityKey,
    kind: 'knowledge',
    sourceKeys: [planOpportunityKey],
    sourceFactIds: [...new Set([
      ...(planKnowledge?.sourceEventIds ?? []),
      ...exhaustedSearchCampaigns(project)
        .filter((campaign) => campaign.planKnowledgeId === project.planKnowledgeId)
        .flatMap((campaign) => campaign.sourceFactIds),
    ])],
  } : undefined;
  const materialIds = [...new Set([...(opening?.materialIds ?? []), ...current.materialIds])]
    .sort((left, right) => left - right);
  const techniqueIds = [...new Set([
    ...(opening?.techniqueIds ?? []),
    ...current.techniqueIds,
    ...(project.planKnowledgeId ? [project.planKnowledgeId] : []),
  ])].sort();
  const targetSourceKeys = [...new Set([...(opening?.targetSourceKeys ?? []), ...current.targetSourceKeys])].sort();
  const verifiedResponseEventIds = [...new Set([
    ...(opening?.verifiedResponseEventIds ?? []),
    ...current.verifiedResponseEventIds,
  ])].sort();
  const opportunityKeys = [...new Set([
    ...(opening?.opportunityKeys ?? []),
    ...current.opportunityKeys,
    ...(planOpportunityKey ? [planOpportunityKey] : []),
  ])].sort();
  const opportunitySources = [
    ...(opening?.opportunitySources ?? []),
    ...current.opportunitySources,
    ...(planOpportunitySource ? [planOpportunitySource] : []),
  ]
    .filter((source, index, all) => all.findIndex((candidate) => candidate.opportunityKey === source.opportunityKey
      && candidate.kind === source.kind
      && candidate.sourceKeys.join('|') === source.sourceKeys.join('|')) === index)
    .sort((left, right) => left.opportunityKey.localeCompare(right.opportunityKey)
      || left.sourceKeys.join('|').localeCompare(right.sourceKeys.join('|')));
  project.terminalInquiryOpportunityBasis = {
    ...current,
    materialIds,
    techniqueIds,
    targetSourceKeys,
    verifiedResponseEventIds,
    opportunityKeys,
    opportunitySources,
    sourceFactIds: [...new Set([
      ...opportunitySources.flatMap((source) => source.sourceFactIds),
      ...exhaustedSearchCampaigns(project).flatMap((campaign) => campaign.sourceFactIds),
    ])],
    sourceKeys: [...new Set(opportunitySources.flatMap((source) => source.sourceKeys))],
    basisKey: `${person.id}:${project.desiredFunction}:${opportunityKeys.join('|')}`,
    inheritedProjectIds: [...(opening?.inheritedProjectIds ?? [])],
    renewalKeys: [...(opening?.renewalKeys ?? [])],
  };
}

export function activeHypothesisCandidate(project: ProjectState): ProjectHypothesisCandidate | undefined {
  const activeKey = project.hypothesisCampaign?.activeCandidateKey;
  return activeKey
    ? project.hypothesisCampaign?.candidates.find((candidate) => candidate.key === activeKey)
    : undefined;
}

function actionInventorySourceKeys(person: PersonState, action: PrimitiveAction): string[] {
  const stackIds: string[] = [];
  if (action.kind === 'act') {
    stackIds.push(...action.targets.flatMap((target) => target.kind === 'inventory-stack'
      && target.personId === person.id ? [target.stackId] : []));
    if (action.toolStackId) stackIds.push(action.toolStackId);
  } else if (action.kind === 'attend' && action.target.kind === 'inventory-stack'
    && action.target.personId === person.id) {
    stackIds.push(action.target.stackId);
    if (action.instrumentStackId) stackIds.push(action.instrumentStackId);
  } else if (action.kind === 'inscribe') {
    stackIds.push(action.carrierStackId);
  } else if (action.kind === 'transfer' && action.stackId) {
    stackIds.push(action.stackId);
  }
  return [...new Set(stackIds.map((stackId) => `inventory:${person.id}:${stackId}`))];
}

export function openingStepUsesRenewalCommitment(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  step: ProjectStep,
): boolean {
  const basis = project.inquiryOpportunityBasis;
  if (!basis?.renewalKeys.length) return true;
  const renewalKeys = new Set(basis.renewalKeys);
  const sources = (basis.opportunitySources ?? []).filter((source) => renewalKeys.has(source.opportunityKey));
  if (!sources.length) return false;
  const active = activeHypothesisCandidate(project);
  const activeUsesRenewal = active?.reasonKeys.includes('cross-project-renewal-opportunity') ?? false;
  const inventorySourceKeys = actionInventorySourceKeys(person, step.action);
  const stepSourceKeys = new Set([
    ...inventorySourceKeys,
    ...(step.target?.kind === 'drop' ? [`drop:${step.target.dropId}`] : []),
    ...(step.target?.kind === 'inventory-stack'
      ? [`inventory:${step.target.personId}:${step.target.stackId}`]
      : []),
    ...(step.target?.kind === 'voxel'
      ? [`voxel:${step.target.position.x}:${step.target.position.y}:${step.target.position.z}:${voxelAt(
          state.world.grid,
          step.target.position.x,
          step.target.position.y,
          step.target.position.z,
        )}`]
      : []),
  ]);
  return sources.some((source) => {
    if (source.kind === 'material' && source.materialId !== undefined) {
      const prefix = `search-source:${source.materialId}:`;
      if (source.opportunityKey.startsWith(prefix)) {
        const exactSourceKey = source.opportunityKey.slice(prefix.length);
        return (exactSourceKey.startsWith('inventory:') || exactSourceKey.startsWith('drop:'))
          && stepSourceKeys.has(exactSourceKey);
      }
    }
    if (activeUsesRenewal) return true;
    if (source.kind === 'knowledge') return step.planKnowledgeId === source.opportunityKey.slice('knowledge:'.length);
    if (source.kind === 'verified-response') return source.sourceFactIds.some((eventId) => step.sourceFactIds.includes(eventId))
      && source.sourceKeys.some((sourceKey) => stepSourceKeys.has(sourceKey));
    return source.sourceKeys.some((sourceKey) => stepSourceKeys.has(sourceKey));
  });
}

function verifiedResponseEntityStillPresent(
  state: SimulationState,
  person: PersonState,
  responseRef: NonNullable<ProjectState['hypothesisCampaign']>['attempts'][number]['responseRef'],
): boolean {
  if (!responseRef) return false;
  if (responseRef.kind === 'inventory-stack') {
    return person.inventory.some((stack) => stack.id === responseRef.stackId
      && stack.materialId === responseRef.materialId
      && stack.quantity > 0);
  }
  return voxelAt(
    state.world.grid,
    responseRef.position.x,
    responseRef.position.y,
    responseRef.position.z,
  ) === responseRef.materialId;
}

export function questionAllowsAnotherExert(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  questionKind: ProjectHypothesisQuestionKind,
): boolean {
  const attempts = project.hypothesisCampaign?.attempts ?? [];
  let latestQuestionIndex = -1;
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index].questionKind === questionKind) latestQuestionIndex = index;
  }
  if (latestQuestionIndex < 0) return true;
  return attempts.slice(latestQuestionIndex).some((attempt) => attempt.outcome === 'response'
    && Boolean(attempt.verifiedEventId)
    && Boolean(attempt.responseRef)
    && verifiedResponseEntityStillPresent(state, person, attempt.responseRef));
}
