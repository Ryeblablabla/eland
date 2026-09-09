import type { ActionOption, FactPredicate, HolderRef, PrimitiveAction, WorldInteractionEffect, WorldRef } from '../domain/action';
import type { DecisionAuthorityState, DecisionContext } from '../domain/model';
import type { MentalAct } from '../domain/mental-act';
import type {
  NativeOperationCompilation, NativeOperationDescriptor, NativeOperationReferences, NativeOperationRequest,
} from '../domain/native-operation';
import { nativeMethodKey } from '../domain/native-operation';
import { classifyActionOption } from '../domain/action-option-semantics';
import { Material, materialDefinition } from '../domain/material';
import { inventoryQuantity, isAlive, type PersonState } from '../domain/person';
import { cellId, cellX, cellY, cellsInRadius, findStandingPath, isStandingPosition, standingPositions, surfaceMaterial, surfaceStandingPosition, topPosition, voxelAt, type StandingPosition } from '../world/grid';
import { worldInteractionApproachPosition } from '../domain/action-executor';
import { physicalRendezvous, positionsCanTouch } from '../domain/social-space';
import { animalSpecies, isAnimalAlive } from '../domain/animal';
import { compileNativeSpeechOperation } from './native-speech';
import { nativeActParameterProblem } from '../domain/native-act-parameters';
import { knownProjectCapabilities } from './known-project-capabilities';
import { WORK_ARRANGEMENTS } from '../domain/works';
import { canAccessContainer, canAccessContainerFrom, containerById, containerForWork, type ContainerState } from '../domain/container';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

const equal = (first: unknown, second: unknown) => canonical(first) === canonical(second);
const ownStack = (context: DecisionContext, stackId: string): WorldRef => ({
  kind: 'inventory-stack', personId: context.person.id, stackId,
});

function holderRef(context: DecisionContext, holder: HolderRef, action?: Extract<PrimitiveAction, { kind: 'transfer' }>): WorldRef {
  if (holder.kind === 'person') return action?.stackId && action.from === holder
    ? { kind: 'inventory-stack', personId: holder.personId, stackId: action.stackId }
    : { kind: 'person', personId: holder.personId };
  if (holder.kind === 'container') return { kind: 'container', containerId: holder.containerId };
  if (action?.sourceVoxel && action.from === holder) return { kind: 'voxel', position: { ...action.sourceVoxel } };
  if (action?.dropId && action.from === holder) return { kind: 'drop', dropId: action.dropId };
  return { kind: 'voxel', position: { x: cellX(holder.cellId), y: cellY(holder.cellId),
    z: holder.z ?? surfaceStandingPosition(context.state.world.grid, holder.cellId)?.z ?? context.person.position.z } };
}

function primitiveRequest(context: DecisionContext, action: PrimitiveAction): NativeOperationRequest | undefined {
  if (action.kind === 'move') return { kind: 'move', withinDistance: 0, target: { kind: 'voxel', position: {
    x: cellX(action.toCellId), y: cellY(action.toCellId),
    z: action.toZ ?? surfaceStandingPosition(context.state.world.grid, action.toCellId)?.z ?? context.person.position.z,
  } } };
  if (action.kind === 'attend') {
    const instrumentStackId = action.measurement?.instrument.stackId ?? action.instrumentStackId;
    return { kind: 'observe', target: structuredClone(action.target),
      ...(instrumentStackId ? { instrument: ownStack(context, instrumentStackId) } : {}) };
  }
  if (action.kind === 'transfer') return {
    kind: 'transfer', source: holderRef(context, action.from, action), destination: holderRef(context, action.to),
    materialId: action.materialId, quantity: action.quantity,
    ...(action.from.kind === 'container' && action.stackId ? { sourceStackId: action.stackId } : {}),
    ...(action.containerStackId ? { container: ownStack(context, action.containerStackId) } : {}),
  };
  if (action.kind === 'act') return { kind: 'act', operation: action.operation, targets: structuredClone(action.targets),
    ...(action.toolStackId ? { tool: ownStack(context, action.toolStackId) } : {}) };
  if (action.kind === 'inscribe') return { kind: 'inscribe', carrier: ownStack(context, action.carrierStackId),
    ...(action.inscriptionMeaning.factId ? { knowledgeId: action.inscriptionMeaning.factId } : {}),
    ...(action.codebookId ? { codebookId: action.codebookId } : {}),
    text: action.inscriptionMeaning.summary,
  };
  return undefined; // Speech belongs to the frozen Mind; open effects have their own executor.
}

function optionReferences(option: ActionOption): NativeOperationReferences {
  const action = option.completionAction ?? option.nextAction;
  const record = option.recordUseBasis;
  const projectId = option.projectId ?? option.projectProposal?.id ?? record?.projectId;
  const knowledgeId = record?.knowledgeId ?? option.projectProposal?.targetKnowledgeId
    ?? (action.kind === 'attend' ? action.learning?.factId : undefined)
    ?? (action.kind === 'inscribe' ? action.inscriptionMeaning.factId : undefined);
  const techniqueId = record?.techniqueId
    ?? (action.kind === 'attend' ? action.verification?.techniqueId : undefined)
    ?? (action.kind === 'act' ? action.techniqueDemonstration?.techniqueId ?? action.techniqueImitation?.techniqueId : undefined);
  const agreementId = action.kind === 'act' || action.kind === 'transfer' ? action.authorizationRef : undefined;
  return {
    ...(projectId ? { projectId } : {}), ...(record?.recordId ? { recordId: record.recordId } : {}),
    ...(knowledgeId ? { knowledgeId } : {}), ...(techniqueId ? { techniqueId } : {}),
    ...(agreementId ? { agreementId } : {}), sourceEventIds: [...new Set(option.sourceFactIds)].sort(),
  };
}

interface Candidate { option: ActionOption; descriptor: NativeOperationDescriptor }

function requiresCompleteMethod(option: ActionOption): boolean {
  if (option.completionAction || option.completionPolicy || option.requiresFollowUp
    || option.projectId || option.projectProposal || option.recordUseBasis || option.recordUseStage
    || option.relationshipBasis || option.openConversationGrounding) return true;
  const action = option.nextAction;
  const ordinaryKeys: Partial<Record<PrimitiveAction['kind'], readonly string[]>> = {
    move: ['kind', 'toCellId', 'toZ'],
    attend: ['kind', 'target'],
    transfer: ['kind', 'from', 'to', 'materialId', 'quantity', 'dropId', 'stackId', 'containerStackId'],
    act: ['kind', 'operation', 'targets', 'toolStackId'],
    inscribe: ['kind', 'carrierStackId', 'inscriptionMeaning', 'codebookId'],
  };
  const allowed = ordinaryKeys[action.kind];
  if (!allowed || Object.entries(action).some(([key, value]) => value !== undefined && !allowed.includes(key))) return true;
  return action.kind === 'inscribe' && (action.inscriptionMeaning.kind !== 'claim'
    || Object.keys(action.inscriptionMeaning).some((key) => !['kind', 'id', 'summary', 'factId'].includes(key)));
}

function candidates(context: DecisionContext): Candidate[] {
  const result: Candidate[] = [];
  const scoped = knownProjectCapabilities(context);
  for (const option of [...scoped.options, ...scoped.followUpOptions]) {
    if (option.nextAction.kind === 'talk' || option.completionAction?.kind === 'talk') continue;
    const references = optionReferences(option);
    const methodKey = nativeMethodKey(optionIdentity(option));
    const requiresMethod = requiresCompleteMethod(option);
    const requests = [option.nextAction, ...(option.completionAction ? [option.completionAction] : [])]
      .flatMap((action) => { const request = primitiveRequest(context, action); return request ? [request] : []; });
    const project = option.projectProposal ?? context.state.projects.find((entry) => entry.id === option.projectId);
    if (project) requests.push({ kind: 'project', projectId: project.id, desiredFunction: project.desiredFunction,
      ...(project.site ? { site: { x: cellX(project.site.cellId), y: cellY(project.site.cellId), z: project.site.z } } : {}) });
    for (const request of requests) {
      const movementGoal: FactPredicate | undefined = request.kind === 'move' && request.target.kind === 'voxel'
        ? { kind: 'at-cell', cellId: cellId(request.target.position.x, request.target.position.y), z: request.target.position.z }
        : undefined;
      result.push({ option, descriptor: {
        methodKey, requiresMethod,
        request: { ...request, references, goal: movementGoal ?? structuredClone(option.goal) },
        summary: request.kind === 'move' && !requiresMethod ? simpleOperationSummary(context, request, option.nextAction) : option.summary,
        reason: option.reason, sourceEventIds: [...option.sourceFactIds],
      } });
    }
  }
  return result;
}

/** Semantic descriptions retain source identity but expose no local option ids. */
export function describeNativeOperations(context: DecisionContext): NativeOperationDescriptor[] {
  return [...new Map(candidates(context).map(({ descriptor }) => [canonical({ request: descriptor.request, methodKey: descriptor.methodKey }), descriptor])).values()];
}

function referencesMatch(request: NativeOperationReferences | undefined, actual: NativeOperationReferences): boolean {
  if (!request) return true;
  return Object.entries(request).every(([key, value]) => key === 'sourceEventIds'
    ? (value as string[]).every((id) => actual.sourceEventIds?.includes(id))
    : value === undefined || value === actual[key as keyof NativeOperationReferences]);
}

function matches(request: NativeOperationRequest, descriptor: NativeOperationDescriptor): boolean {
  const candidate = descriptor.request;
  if (request.methodKey !== undefined && request.methodKey !== descriptor.methodKey) return false;
  if (request.kind !== candidate.kind || !referencesMatch(request.references, candidate.references ?? {})) return false;
  if (request.kind === 'observe' && candidate.kind === 'observe'
    && Boolean(request.instrument) !== Boolean(candidate.instrument)) return false;
  return Object.entries(request).every(([key, value]) => {
    if (key === 'references' || key === 'backgroundReferences' || key === 'perceptionOnly' || key === 'methodKey' || value === undefined) return true;
    const actual = (candidate as unknown as Record<string, unknown>)[key];
    if (key === 'targets' && Array.isArray(value) && Array.isArray(actual)) {
      return equal(value.map(canonical).sort(), actual.map(canonical).sort());
    }
    return equal(value, actual);
  });
}

function optionIdentity(option: ActionOption): string {
  const { id: _id, summary: _summary, reason: _reason, risks: _risks, projectPressure: _pressure, ...meaning } = option;
  return canonical({ ...meaning, requiresFollowUp: meaning.requiresFollowUp === true ? true : undefined,
    sourceFactIds: [...meaning.sourceFactIds].sort() });
}

function referencePosition(context: Pick<DecisionContext, 'state' | 'person'>, ref: WorldRef): { cellId: number; z: number } | undefined {
  if (ref.kind === 'voxel') return { cellId: cellId(ref.position.x, ref.position.y), z: ref.position.z };
  if (ref.kind === 'person' || ref.kind === 'inventory-stack') {
    const person = context.state.people.find((person) => person.id === ref.personId);
    if (ref.kind === 'inventory-stack' && !person?.inventory.some((stack) => stack.id === ref.stackId && stack.quantity > 0)) return undefined;
    return person?.position;
  }
  if (ref.kind === 'drop') return context.state.world.drops.find((drop) => drop.id === ref.dropId && drop.quantity > 0);
  if (ref.kind === 'animal') return context.state.world.animals.find((animal) => animal.id === ref.animalId)?.position;
  if (ref.kind === 'remains') return context.state.world.remains?.find((remains) => remains.id === ref.remainsId)?.position;
  const position = ref.kind === 'work' ? context.state.world.works?.find((work) => work.id === ref.workId)?.position
    : context.state.containers.find((container) => container.id === ref.containerId)?.position;
  return position ? { cellId: cellId(position.x, position.y), z: position.z } : undefined;
}

function occupiesEntityContactPose(state: DecisionAuthorityState, actor: PersonState, position: StandingPosition): boolean {
  const atPose = (body: StandingPosition) => body.cellId === position.cellId && body.z === position.z;
  return state.people.some((other) => other.id !== actor.id && isAlive(other) && atPose(other.position))
    || state.world.animals.some((animal) => isAnimalAlive(animal) && atPose(animal.position))
    || (state.world.remains ?? []).some((remains) => remains.carriedByPersonId !== actor.id && atPose(remains.position));
}

/** A reachable contact pose for interaction, distinct from entering an exact voxel. */
function reachableContactPosition(
  state: DecisionAuthorityState,
  person: PersonState,
  target: WorldRef,
  center: StandingPosition,
): StandingPosition | null {
  if (target.kind === 'person' || target.kind === 'inventory-stack') {
    const holder = state.people.find((other) => other.id === target.personId);
    const meeting = holder ? physicalRendezvous(state, person, holder)?.position : undefined;
    if (meeting && (!occupiesEntityContactPose(state, person, meeting)
      || meeting.cellId === person.position.cellId && meeting.z === person.position.z)) return meeting;
  }
  const contactFrom = (position: StandingPosition) => {
    if (!isStandingPosition(state.world.grid, position)) return false;
    if (target.kind === 'work' || target.kind === 'container') {
      // The named solid itself is the contact surface. The shared World
      // approach metric permits a hand to touch its face without entering it.
      return Math.abs(cellX(position.cellId) - cellX(center.cellId))
        + Math.abs(cellY(position.cellId) - cellY(center.cellId))
        + Math.max(0, Math.abs(position.z - center.z) - 1) <= 1;
    }
    return positionsCanTouch(state.world.grid, position, center);
  };
  if (contactFrom(person.position)) return { cellId: person.position.cellId, z: person.position.z };
  const proposed = worldInteractionApproachPosition(state, person, target, center, 1);
  if (!proposed) return null;
  if (contactFrom(proposed) && !occupiesEntityContactPose(state, person, proposed)) return proposed;
  // The nearest generic pose may be above a closed floor. Try only the same
  // bounded contact ring, retaining both body clearance and actual walking paths.
  return cellsInRadius(center.cellId, 1).flatMap((id) => standingPositions(state.world.grid, id))
    .filter((position) => contactFrom(position) && !occupiesEntityContactPose(state, person, position))
    .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length
      || left.position.cellId - right.position.cellId || left.position.z - right.position.z)[0]?.position ?? null;
}

/** Resolve a named destination to an actual occupiable pose using existing spatial rules. */
export function resolveNativeMovePosition(
  state: DecisionAuthorityState,
  person: PersonState,
  request: Extract<NativeOperationRequest, { kind: 'move' }>,
): StandingPosition | null {
  const target = request.target;
  const position = referencePosition({ state, person }, target);
  if (!position) return null;
  const material = target.kind === 'voxel' ? voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) : undefined;
  const withinDistance = request.withinDistance ?? (material === Material.Air ? 0 : 1);
  if (!Number.isFinite(withinDistance) || withinDistance < 0) return null;
  if (withinDistance === 0) {
    const exact = { cellId: position.cellId,
      z: position.z + (material !== undefined && materialDefinition(material).phase === 'solid' ? 1 : 0) };
    const occupied = state.people.some((other) => other.id !== person.id && isAlive(other)
      && other.position.cellId === exact.cellId && other.position.z === exact.z);
    const standable = isStandingPosition(state.world.grid, exact);
    if (target.kind === 'voxel') return !occupied && standable
      && findStandingPath(state.world.grid, person.position, exact).length ? exact : null;
    const entityOccupied = occupiesEntityContactPose(state, person, exact);
    if (!entityOccupied && standable) return findStandingPath(state.world.grid, person.position, exact).length ? exact : null;
    return reachableContactPosition(state, person, target, exact);
  }
  if ((target.kind === 'person' || target.kind === 'inventory-stack') && withinDistance === 1) {
    const other = state.people.find((other) => other.id === target.personId);
    return other ? physicalRendezvous(state, person, other)?.position ?? null : null;
  }
  const distance = Math.abs(cellX(person.position.cellId) - cellX(position.cellId))
    + Math.abs(cellY(person.position.cellId) - cellY(position.cellId))
    + Math.max(0, Math.abs(person.position.z - position.z) - 1);
  if (distance <= withinDistance && isStandingPosition(state.world.grid, person.position)) {
    return { cellId: person.position.cellId, z: person.position.z };
  }
  return worldInteractionApproachPosition(state, person, target, undefined, withinDistance);
}

/** Compilation feedback describes currently visible constraints, not a lived failed walk. */
function nativeMoveBlockedReason(
  context: DecisionContext,
  request: Extract<NativeOperationRequest, { kind: 'move' }>,
): string {
  const generic = '目前没有找到满足指定距离的真实落脚位置或通路；本次移动尚未开始';
  const center = referencePosition(context, request.target);
  if (!center || !context.visibleCells.includes(center.cellId)) return generic;
  const targetVisible = request.target.kind === 'voxel'
    || request.target.kind === 'drop' && context.visibleDrops.some((drop) => request.target.kind === 'drop' && drop.id === request.target.dropId)
    || (request.target.kind === 'person' || request.target.kind === 'inventory-stack')
      && context.visiblePeople.some((person) => (request.target.kind === 'person' || request.target.kind === 'inventory-stack') && person.id === request.target.personId);
  if (!targetVisible) return generic;
  const grid = context.state.world.grid;
  if (request.target.kind === 'voxel') {
    const materialId = voxelAt(grid, request.target.position.x, request.target.position.y, request.target.position.z);
    const distance = request.withinDistance ?? (materialId === Material.Air ? 0 : 1);
    if (distance === 0) {
      const exact = { cellId: center.cellId, z: center.z + (materialDefinition(materialId).phase === 'solid' ? 1 : 0) };
      const occupant = context.state.people.find((person) => person.id !== context.person.id && isAlive(person)
        && context.visiblePeople.some((visible) => visible.id === person.id)
        && person.position.cellId === exact.cellId && person.position.z === exact.z);
      if (occupant) {
        const contact = reachableContactPosition(context.state, context.person, { kind: 'person', personId: occupant.id }, exact);
        const contactDescription = contact
          ? contact.cellId === context.person.position.cellId && contact.z === context.person.position.z
            ? '本人已经处于可与其接触的位置'
            : '存在可达的相邻接触位置'
          : '当前也未找到可达的相邻接触位置';
        return `指定落脚格（${cellX(exact.cellId)},${cellY(exact.cellId)},${exact.z}）当前由${occupant.name}占据；${contactDescription}。本次请求是精确进入该格，未改为接近对方，移动尚未开始`;
      }
    }
  }
  // Use visible top surfaces only: a visible column does not reveal buried
  // layers or the hidden trunk underneath a canopy.
  const nearby = cellsInRadius(center.cellId, 1)
    .filter((id) => id !== center.cellId && context.visibleCells.includes(id))
    .flatMap((id) => {
      const materialId = surfaceMaterial(grid, id), position = topPosition(grid, id);
      if (materialId === Material.Air
        || materialDefinition(materialId).phase === 'solid' && position.z < center.z) return [];
      return [`（${position.x},${position.y},${position.z}）为${materialDefinition(materialId).name}`];
    });
  return nearby.length
    ? `${generic}。目标邻近的当前可见表面：${nearby.join('；')}`
    : generic;
}

/** Only one actor's acquisition or delivery; this does not compose a theft and a gift. */
export function nativeTransferPreparationKind(
  person: PersonState,
  transfer: Extract<PrimitiveAction, { kind: 'transfer' }>,
): 'acquire' | 'deliver' | undefined {
  if (transfer.from.kind === 'ground' && (transfer.dropId || transfer.sourceVoxel)
    && transfer.to.kind === 'person' && transfer.to.personId === person.id) return 'acquire';
  if (transfer.from.kind === 'container' && transfer.to.kind === 'person' && transfer.to.personId === person.id) return 'acquire';
  if (transfer.from.kind === 'person' && transfer.from.personId === person.id
    && (transfer.to.kind === 'ground' || transfer.to.kind === 'container'
      || transfer.to.kind === 'person' && transfer.to.personId !== person.id)) return 'deliver';
  return undefined;
}

function storageApproach(state: DecisionAuthorityState, person: PersonState, container: ContainerState): StandingPosition | null {
  if (canAccessContainer(person, container)) return { cellId: person.position.cellId, z: person.position.z };
  return cellsInRadius(cellId(container.position.x, container.position.y), 1)
    .flatMap((id) => standingPositions(state.world.grid, id))
    .filter((position) => canAccessContainerFrom(position, container) && !occupiesEntityContactPose(state, person, position))
    .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
    .filter((candidate) => candidate.path.length)
    .sort((a, b) => a.path.length - b.path.length || a.position.cellId - b.position.cellId || a.position.z - b.position.z)[0]?.position ?? null;
}

/** Preserve the chosen material transfer while compiling its current physical approach. */
export function resolveNativeTransferAction(
  state: DecisionAuthorityState,
  person: PersonState,
  transfer: Extract<PrimitiveAction, { kind: 'transfer' }>,
): PrimitiveAction | null {
  const preparation = nativeTransferPreparationKind(person, transfer);
  if (!preparation) return structuredClone(transfer);
  if (preparation === 'deliver') {
    const stack = person.inventory.find((candidate) => candidate.id === transfer.stackId
      && candidate.materialId === transfer.materialId && candidate.quantity >= transfer.quantity);
    if (!stack) return null;
    if (transfer.to.kind === 'container') {
      const container = containerById(state, transfer.to.containerId);
      const position = container ? storageApproach(state, person, container) : null;
      return !position ? null : position.cellId === person.position.cellId && position.z === person.position.z
        ? structuredClone(transfer) : { kind: 'move', toCellId: position.cellId, toZ: position.z };
    }
    const recipientId = transfer.to.kind === 'person' ? transfer.to.personId : undefined;
    const recipient = recipientId ? state.people.find((candidate) => candidate.id === recipientId && isAlive(candidate)) : undefined;
    const destination = transfer.to.kind === 'ground' ? transfer.to : recipient?.position;
    if (!destination || destination.z === undefined) return null;
    const center = { cellId: destination.cellId, z: destination.z };
    if (transfer.to.kind === 'ground'
      && (voxelAt(state.world.grid, cellX(destination.cellId), cellY(destination.cellId), destination.z) !== Material.Air
        || materialDefinition(voxelAt(state.world.grid, cellX(destination.cellId), cellY(destination.cellId), destination.z - 1)).phase !== 'solid')) return null;
    if (positionsCanTouch(state.world.grid, person.position, center)) return structuredClone(transfer);
    const target: WorldRef = recipient ? { kind: 'person', personId: recipient.id }
      : { kind: 'voxel', position: { x: cellX(destination.cellId), y: cellY(destination.cellId), z: destination.z } };
    const position = reachableContactPosition(state, person, target, center);
    return position ? { kind: 'move', toCellId: position.cellId, toZ: position.z } : null;
  }
  if (transfer.from.kind === 'container') {
    const container = containerById(state, transfer.from.containerId);
    const stack = container?.inventory.find((candidate) => candidate.id === transfer.stackId
      && candidate.materialId === transfer.materialId && candidate.quantity > 0);
    const position = container && stack ? storageApproach(state, person, container) : null;
    return !position ? null : position.cellId === person.position.cellId && position.z === person.position.z
      ? structuredClone(transfer) : { kind: 'move', toCellId: position.cellId, toZ: position.z };
  }
  if (transfer.sourceVoxel) {
    const source = transfer.sourceVoxel;
    const current = voxelAt(state.world.grid, source.x, source.y, source.z);
    if (current === Material.Air || current !== transfer.materialId) return null;
    const position = resolveNativeMovePosition(state, person, {
      kind: 'move', target: { kind: 'voxel', position: source }, withinDistance: 1,
    });
    if (!position) return null;
    return position.cellId === person.position.cellId && position.z === person.position.z
      ? structuredClone(transfer) : { kind: 'move', toCellId: position.cellId, toZ: position.z };
  }
  if (!transfer.dropId) return structuredClone(transfer);
  const drop = state.world.drops.find((candidate) => candidate.id === transfer.dropId
    && candidate.materialId === transfer.materialId && candidate.quantity > 0);
  if (!drop) return null;
  // Identity, quantity, material and destination stay fixed. Only the current
  // position of this same physical source is refreshed.
  const currentTransfer = { ...structuredClone(transfer), from: { kind: 'ground' as const, cellId: drop.cellId, z: drop.z } };
  if (positionsCanTouch(state.world.grid, person.position, drop)) return currentTransfer;
  const position = reachableContactPosition(state, person, { kind: 'drop', dropId: drop.id }, drop);
  return position ? { kind: 'move', toCellId: position.cellId, toZ: position.z } : null;
}

export function nativeTransferBlockedReason(
  state: DecisionAuthorityState,
  person: PersonState,
  transfer: Extract<PrimitiveAction, { kind: 'transfer' }>,
): string {
  if (nativeTransferPreparationKind(person, transfer) === 'deliver') {
    const stack = person.inventory.find((candidate) => candidate.id === transfer.stackId);
    if (!stack || stack.materialId !== transfer.materialId || stack.quantity < transfer.quantity) {
      return '点名的本人库存已不存在、材料改变或数量不足；尚未交付，不改用其他库存';
    }
    if (transfer.to.kind === 'person') {
      const recipientId = transfer.to.personId;
      return state.people.some((candidate) => candidate.id === recipientId && isAlive(candidate))
        ? '材料仍由本人持有，但目前没有通往所选接收者的可达接触位置；尚未交付'
        : '所选接收者已经不存在或不再存活；材料仍由本人持有，尚未交付';
    }
    if (transfer.to.kind === 'container') return '材料仍由本人持有，但所选储存空间已失去围护或没有可达接触位置；尚未交付';
    return '材料仍由本人持有，但所选存放位置当前没有受支撑的空位或可达接触位置；尚未交付';
  }
  if (transfer.from.kind === 'container') return '所选储存空间、点名的内容物或可达接触位置已不具备，尚未取出；不改用其他来源';
  if (transfer.sourceVoxel) {
    const source = transfer.sourceVoxel;
    const current = voxelAt(state.world.grid, source.x, source.y, source.z);
    return current !== Material.Air && current === transfer.materialId
      ? '所选地表体素仍在，但目前没有通往其近身松取范围的可达位置'
      : '所选地表体素已变空或已不是原来点名的材料，无法继续这次取料';
  }
  const sourceRemains = state.world.drops.some((drop) => drop.id === transfer.dropId
    && drop.materialId === transfer.materialId && drop.quantity > 0);
  return sourceRemains
    ? '所选地面物资仍在，但目前没有通往其近身取物范围的可达接触位置'
    : '所选地面物资已经不存在、已耗尽或已不是原材料，无法继续取得这份物资';
}

function referencedMaterial(context: DecisionContext, ref: WorldRef): number | undefined {
  if (ref.kind === 'inventory-stack') return context.state.people.find((person) => person.id === ref.personId)
    ?.inventory.find((stack) => stack.id === ref.stackId)?.materialId;
  if (ref.kind === 'drop') return context.state.world.drops.find((drop) => drop.id === ref.dropId)?.materialId;
  if (ref.kind === 'voxel') return voxelAt(context.state.world.grid, ref.position.x, ref.position.y, ref.position.z);
  if (ref.kind === 'container' || ref.kind === 'work') {
    const storage = ref.kind === 'work' ? containerForWork(context.state, ref.workId) : containerById(context.state, ref.containerId);
    if (!storage || !context.visibleCells.includes(cellId(storage.position.x, storage.position.y))) return undefined;
    const materials = [...new Set(storage.inventory.filter((stack) => stack.quantity > 0).map((stack) => stack.materialId))];
    return materials.length === 1 ? materials[0] : undefined;
  }
  return undefined;
}

function operationRefs(request: NativeOperationRequest): WorldRef[] {
  if (request.kind === 'move' || request.kind === 'observe') return [request.target,
    ...(request.kind === 'observe' && request.instrument ? [request.instrument] : [])];
  if (request.kind === 'transfer') return [request.source, request.destination, ...(request.container ? [request.container] : [])];
  if (request.kind === 'assemble') return [request.target, ...request.inputs.map((input) => input.target)];
  if (request.kind === 'act') return [...request.targets, ...(request.tool ? [request.tool] : [])];
  if (request.kind === 'inscribe') return [request.carrier];
  return [];
}

function observationGoal(context: DecisionContext, target: WorldRef): FactPredicate {
  const material = referencedMaterial(context, target);
  const animal = target.kind === 'animal' ? context.state.world.animals.find((animal) => animal.id === target.animalId) : undefined;
  return { kind: 'knowledge', factId: target.kind === 'work' ? `observation:work:${target.workId}`
    : animal ? `animal:${animal.speciesId}`
      : material !== undefined && target.kind !== 'drop'
        && !(target.kind === 'inventory-stack' && target.personId !== context.person.id)
        ? `material:${material}` : `target:${JSON.stringify(target)}` };
}

/** An association can explain a choice; only known, existing facts support its execution. */
function knownExistingSourceIds(context: DecisionContext, requested: readonly string[]): string[] {
  const known = new Set([
    ...context.person.knowledge.flatMap((fact) => fact.sourceEventIds),
    ...context.person.memories.flatMap((memory) => memory.sourceEventIds),
    ...context.person.knownPlaces.flatMap((place) => place.sourceEventIds),
    ...context.person.relations.flatMap((relation) => relation.sourceEventIds),
    ...context.options.flatMap((option) => option.sourceFactIds),
    ...context.followUpOptions.flatMap((option) => option.sourceFactIds),
    ...(context.activeIntent?.sourceFactIds ?? []),
  ]);
  const existing = new Set([...context.state.world.past, ...(context.currentMonthEvents ?? [])].map((event) => event.id));
  return [...new Set(requested)].filter((id) => known.has(id) && existing.has(id));
}

/** Visible names describe only the chosen atom; a larger Plan is not a receipt for this work. */
function perceivedRefName(context: DecisionContext, ref: WorldRef): string {
  if (ref.kind === 'person') return ref.personId === context.person.id ? '自己'
    : context.visiblePeople.find((person) => person.id === ref.personId)?.name ?? '先前见过的人';
  if (ref.kind === 'inventory-stack') {
    const holder = ref.personId === context.person.id ? context.person
      : context.visiblePeople.find((person) => person.id === ref.personId);
    const visible = holder && (holder.id === context.person.id
      || positionsCanTouch(context.state.world.grid, context.person.position, holder.position));
    const stack = visible ? holder.inventory.find((stack) => stack.id === ref.stackId) : undefined;
    return stack ? `${holder!.id === context.person.id ? '随身' : `${holder!.name}持有`}的${materialDefinition(stack.materialId).name}`
      : '先前看到的物品';
  }
  if (ref.kind === 'drop') {
    const drop = context.visibleDrops.find((drop) => drop.id === ref.dropId);
    return drop ? `地面${materialDefinition(drop.materialId).name}` : '先前看到的地面物品';
  }
  if (ref.kind === 'voxel') {
    if (!context.visibleCells.includes(cellId(ref.position.x, ref.position.y))) return '先前选定的位置';
    const material = referencedMaterial(context, ref);
    return material === undefined || material === Material.Air ? '选定的空位' : `${materialDefinition(material).name}所在的位置`;
  }
  if (ref.kind === 'work') {
    const work = context.state.world.works?.find((work) => work.id === ref.workId);
    return work && context.visibleCells.includes(cellId(work.position.x, work.position.y)) ? work.summary : '先前看到的造物';
  }
  if (ref.kind === 'animal') {
    const animal = context.visibleAnimals.find((animal) => animal.id === ref.animalId);
    return animal ? animalSpecies(animal.speciesId).name : '先前看到的动物';
  }
  return ref.kind === 'container' ? '容器' : '遗体';
}

function simpleOperationSummary(context: DecisionContext, request: NativeOperationRequest, action: PrimitiveAction): string {
  const name = (ref: WorldRef) => perceivedRefName(context, ref);
  if (request.kind === 'move') return `${request.withinDistance === 0 ? '到达' : '靠近'}${name(request.target)}`;
  if (request.kind === 'observe') return `${request.instrument ? `用${name(request.instrument)}` : ''}观察${name(request.target)}`;
  if (request.kind === 'assemble') return request.summary?.trim()
    || (request.target.kind === 'work' ? `重新排布${name(request.target)}` : '用本人投入的材料进行摆放组装');
  if (request.kind === 'transfer' && action.kind === 'transfer') return action.sourceVoxel
    && action.to.kind === 'person' && action.to.personId === context.person.id
    ? `尝试从点名地表松取${request.quantity}份${materialDefinition(action.materialId).name}，收入本人库存`
    : `尝试将${request.quantity}份${materialDefinition(action.materialId).name}从${name(request.source)}转移到${name(request.destination)}`;
  if (request.kind === 'inscribe') return `在${name(request.carrier)}上记录已知内容`;
  if (request.kind !== 'act') return '执行本次操作';
  if (request.operation === 'exert' && request.targets.length === 1
    && request.targets[0].kind === 'inventory-stack' && request.targets[0].personId === context.person.id && !request.tool) {
    return `徒手弯曲一份${name(request.targets[0])}`;
  }
  const objects = request.targets.map(name).join('与');
  const verbs = { separate: '分离', combine: '尝试结合', expose: '尝试接触', exert: '尝试施力于',
    ingest: '摄入', reproduce: '尝试与之生育：', hunt: '尝试猎取', dehydrate: '尝试使其脱水休眠：',
    rehydrate: '尝试复水：', inter: '安置' };
  return `${request.tool ? `用${name(request.tool)}` : ''}${verbs[request.operation]}${objects || '本人'}`;
}

function compileSimpleOperation(context: DecisionContext, request: NativeOperationRequest, id: string): NativeOperationCompilation {
  const refs = operationRefs(request);
  const missing = refs.filter((ref) => !referencePosition(context, ref));
  if (missing.length) return { ok: false, problem: { code: 'unknown-reference',
    message: `点名的实体已经不存在：${missing.map((ref) => canonical(ref)).join('；')}`, fields: ['target/source/destination'] } };
  const references = request.references;
  if (request.kind === 'project') return { ok: false, problem: {
    code: 'missing-evidence', message: '当前没有与这些项目、记录或技术来源相符的可执行过程；需要核对具体来源及尚缺的材料或步骤',
    fields: ['references'],
  } };
  let action: PrimitiveAction;
  let completionAction: PrimitiveAction | undefined;
  let goal: FactPredicate = request.goal ?? { kind: 'knowledge', factId: `attempt:${id}` };
  let target: WorldRef | undefined;
  let contactTranslation = false;
  if (request.kind === 'move') {
    const position = resolveNativeMovePosition(context.state, context.person, request);
    if (!position) return { ok: false, problem: { code: 'missing-evidence',
      message: nativeMoveBlockedReason(context, request), fields: ['target', 'withinDistance'] } };
    action = { kind: 'move', toCellId: position.cellId, toZ: position.z };
    const requestedCenter = referencePosition(context, request.target)!;
    contactTranslation = request.withinDistance === 0 && request.target.kind !== 'voxel'
      && (position.cellId !== requestedCenter.cellId || position.z !== requestedCenter.z);
    goal = request.goal ?? { kind: 'at-cell', cellId: position.cellId, z: position.z };
    target = request.target;
  } else if (request.kind === 'assemble') {
    if (!Array.isArray(request.inputs) || request.inputs.some((input) => input.target.kind !== 'inventory-stack'
      || input.target.personId !== context.person.id || !Number.isSafeInteger(input.quantity) || input.quantity <= 0)
      || request.arrangement !== undefined && !WORK_ARRANGEMENTS.includes(request.arrangement)
      || request.target.kind === 'voxel' && (!request.inputs.length || !request.arrangement)
      || request.target.kind === 'work' && !request.inputs.length && !request.layout && !request.arrangement) return {
      ok: false, problem: { code: 'invalid-operation', message: '新组装需要本人实际持物、正整数用量与排布方式；原造物可用空投入明确重排布局或方式',
        fields: ['inputs', 'arrangement', 'layout'] },
    };
    const requestedByStack = new Map<string, number>();
    for (const input of request.inputs) {
      if (input.target.kind !== 'inventory-stack') continue; // Validated above.
      requestedByStack.set(input.target.stackId, (requestedByStack.get(input.target.stackId) ?? 0) + input.quantity);
    }
    for (const [stackId, quantity] of requestedByStack) {
      const stack = context.person.inventory.find((candidate) => candidate.id === stackId);
      const available = Math.max(0, stack?.quantity ?? 0);
      if (quantity > available) return { ok: false, problem: {
        code: 'missing-evidence', fields: ['inputs'],
        message: `本次为本人持物${stack ? materialDefinition(stack.materialId).name : stackId}累计安排${quantity}份，当前实际只有${available}份，尚缺${quantity - available}份；本次组装尚未编译`,
      } };
    }
    const effects: WorldInteractionEffect[] = request.inputs.map((input) => ({ kind: 'consume',
      target: structuredClone(input.target), quantity: input.quantity }));
    if (request.target.kind === 'voxel') effects.push({ kind: 'assemble', target: structuredClone(request.target),
      arrangement: request.arrangement!, summary: request.summary?.trim() || '摆放的材料',
      ...(request.layout ? { layout: structuredClone(request.layout) } : {}) });
    else effects.push({ kind: 'modify-structure', target: structuredClone(request.target),
      ...(request.arrangement ? { arrangement: request.arrangement } : {}),
      ...(request.summary?.trim() ? { summary: request.summary.trim() } : {}),
      ...(request.layout ? { layout: structuredClone(request.layout) } : {}) });
    const description = request.summary?.trim() || (request.target.kind === 'work' ? '重新排布已有造物的实际材料' : '摆放组装本人投入的实际材料');
    action = { kind: 'world-interact', adjudication: { version: 'world-adjudicated-interaction-v1',
      request: description, targets: structuredClone(refs), status: 'completed', result: `尝试${description}`, effects } };
    target = request.target;
  } else if (request.kind === 'observe') {
    if (request.instrument) return { ok: false, problem: { code: 'missing-evidence',
      message: '当前没有与这件仪器及观察对象对应的完整校准或测量步骤；肉眼观察请省略仪器字段', fields: ['instrument'] } };
    action = { kind: 'attend', target: request.target };
    goal = request.goal ?? observationGoal(context, request.target);
    target = request.target;
  } else if (request.kind === 'transfer') {
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) return { ok: false, problem: {
      code: 'invalid-operation', message: '取放物品需要正整数数量', fields: ['quantity'],
    } };
    const materialId = request.materialId ?? referencedMaterial(context, request.source);
    if (materialId === undefined) return { ok: false, problem: { code: 'missing-evidence',
      message: '该持有者包含多种材料，需要指明实际物品或材料', fields: ['source', 'materialId'] } };
    const asHolder = (ref: WorldRef, source: boolean): HolderRef | undefined => {
      if (ref.kind === 'person' || ref.kind === 'inventory-stack') return { kind: 'person', personId: ref.personId };
      if (ref.kind === 'container') return { kind: 'container', containerId: ref.containerId };
      if (ref.kind === 'work') {
        const storage = containerForWork(context.state, ref.workId);
        return storage ? { kind: 'container', containerId: storage.id } : undefined;
      }
      if (ref.kind === 'drop' || ref.kind === 'voxel') {
        const position = referencePosition(context, ref)!;
        return { kind: 'ground', cellId: position.cellId, z: position.z + (!source && ref.kind === 'voxel'
          && referencedMaterial(context, ref) !== Material.Air ? 1 : 0) };
      }
      return undefined;
    };
    const from = asHolder(request.source, true);
    const to = asHolder(request.destination, false);
    if (!from || !to) return { ok: false, problem: { code: 'invalid-operation', message: '取放的两端必须是实际物品持有者、地面位置或已形成的储存空腔；多个独立空腔须点明其中一个', fields: ['source', 'destination'] } };
    if (request.container && (request.container.kind !== 'inventory-stack' || request.container.personId !== context.person.id)) return {
      ok: false, problem: { code: 'invalid-operation', message: '装取液体需要点名本人持有的容器', fields: ['container'] },
    };
    action = { kind: 'transfer', from, to, quantity: request.quantity, materialId,
      ...(request.source.kind === 'voxel' && materialId !== Material.Water ? { sourceVoxel: { ...request.source.position } } : {}),
      ...(request.source.kind === 'inventory-stack' ? { stackId: request.source.stackId } : {}),
      ...(request.source.kind === 'container' && request.sourceStackId ? { stackId: request.sourceStackId } : {}),
      ...(request.source.kind === 'drop' ? { dropId: request.source.dropId } : {}),
      ...(request.container?.kind === 'inventory-stack' ? { containerStackId: request.container.stackId } : {}) };
    if (!request.goal && to.kind === 'person') {
      const receiver = context.state.people.find((person) => person.id === to.personId)!;
      goal = { kind: 'inventory-at-least', materialId, quantity: inventoryQuantity(receiver, materialId) + request.quantity,
        ...(receiver.id !== context.person.id ? { personId: receiver.id } : {}) };
    }
    target = request.source;
    if (nativeTransferPreparationKind(context.person, action)) {
      if (from.kind === 'person' && from.personId === context.person.id && !action.stackId) {
        action.stackId = context.person.inventory.find((stack) => stack.materialId === materialId && stack.quantity > 0)?.id;
      }
      if (from.kind === 'container') {
        action.stackId = request.sourceStackId ?? containerById(context.state, from.containerId)?.inventory
          .find((stack) => stack.materialId === materialId && stack.quantity > 0)?.id;
      }
      completionAction = structuredClone(action);
    }
  } else if (request.kind === 'act') {
    const problem = nativeActParameterProblem(request, context.person.id);
    if (problem) return { ok: false, problem: { code: 'invalid-operation', ...problem } };
    action = { kind: 'act', operation: request.operation, targets: structuredClone(request.targets),
      ...(request.tool?.kind === 'inventory-stack' ? { toolStackId: request.tool.stackId } : {}) };
    target = request.targets[0];
  } else if (request.kind === 'inscribe') {
    const fact = context.person.knowledge.find((fact) => fact.id === request.knowledgeId);
    if (!fact || request.carrier.kind !== 'inventory-stack' || request.carrier.personId !== context.person.id) return {
      ok: false, problem: { code: 'missing-evidence', message: '书写需要本人已知的具体内容与持有的实际载体', fields: ['knowledgeId', 'carrier'] },
    };
    action = { kind: 'inscribe', carrierStackId: request.carrier.stackId,
      inscriptionMeaning: { kind: 'claim', id: `native-inscription:${id}`, factId: fact.id, summary: request.text ?? fact.summary },
      ...(request.codebookId ? { codebookId: request.codebookId } : {}) };
    goal = request.goal ?? { kind: 'representation-made', representationId: action.inscriptionMeaning.id };
    target = request.carrier;
  } else return { ok: false, problem: { code: 'invalid-operation', message: '缺少可编译的具体物理操作', fields: ['kind'] } };
  const nextAction = completionAction?.kind === 'transfer'
    ? resolveNativeTransferAction(context.state, context.person, completionAction) : action;
  if (!nextAction && completionAction?.kind === 'transfer') return { ok: false, problem: {
    code: 'missing-evidence', message: nativeTransferBlockedReason(context.state, context.person, completionAction), fields: ['source', 'destination'],
  } };
  const backgroundFields = Object.entries(request.backgroundReferences ?? {}).filter(([, value]) => value !== undefined)
    .map(([key]) => `backgroundReferences.${key}`);
  if (request.kind === 'move') backgroundFields.push(...Object.entries(references ?? {})
    .filter(([, value]) => value !== undefined).map(([key]) => `executionBasis.${key}`));
  return { ok: true, ...(contactTranslation || backgroundFields.length ? { feedback: {
    code: contactTranslation ? 'spatial-translation' as const : 'context-association' as const,
    message: contactTranslation
      ? `移动已编译，等待实际执行。目标实体中心不能容纳身体，已转译为实际可接触的落脚位置；原始距离0请求仍保留，未据此声明中心条件已满足${backgroundFields.length ? '。附带引用仅作意图背景，不授予知识、同意或项目进度' : ''}`
      : `${request.kind === 'move' ? '移动' : '本次操作'}已编译，等待实际执行。背景引用仅保留本人已知的事实或事项，不选择高级过程，不授予知识、授权或项目进度；实际结果由后续动作报告`,
    fields: [...(contactTranslation ? ['target', 'withinDistance'] : []), ...backgroundFields],
  } } : {}), option: classifyActionOption({
    id, summary: simpleOperationSummary(context, request, action),
    reason: '人物已选定具体操作与实际对象，结果由原生执行器核验', goal,
    nextAction: nextAction ?? action,
    ...(completionAction ? { completionAction } : {}),
    nativeOperation: structuredClone(request),
    ...(target ? { target: structuredClone(target) } : {}), estimatedDuration: 'one-month',
    sourceFactIds: knownExistingSourceIds(context, [...(references?.sourceEventIds ?? []),
      ...(request.backgroundReferences?.sourceEventIds ?? [])]), domain: 'strategic',
  }) };
}

/** Resolve semantics against complete capabilities, preserving their domain-owned evidence. */
export function compileNativeOperation(
  context: DecisionContext,
  request: NativeOperationRequest,
  id: string,
  frozenMentalAct?: MentalAct,
): NativeOperationCompilation {
  if (request.perceptionOnly && request.kind !== 'observe' && request.kind !== 'move') return { ok: false, problem: {
    code: 'invalid-operation', message: `本轮只选择了观察；${request.kind}不是观察或靠近动作，不能据此开始实体操作`, fields: ['kind'],
  } };
  if (request.kind === 'speech') return frozenMentalAct ? compileNativeSpeechOperation(context, frozenMentalAct, id)
    : { ok: false, problem: { code: 'missing-evidence', message: '表达必须来自本人本轮已经形成的语言及含义', fields: ['mentalAct'] } };
  // A move never starts a project, learning chain or social protocol just
  // because an option happens to share its destination and background refs.
  if (request.kind === 'move' && request.methodKey === undefined) return compileSimpleOperation(context, request, id);
  const explicitBasis = request.references && Object.values(request.references)
    .some((value) => Array.isArray(value) ? value.length > 0 : value !== undefined);
  if (request.kind !== 'project' && !explicitBasis && request.methodKey === undefined) return compileSimpleOperation(context, request, id);
  const matching = candidates(context).filter((candidate) => matches(request, candidate.descriptor));
  const distinct = [...new Map(matching.map((candidate) => [optionIdentity(candidate.option), candidate])).values()];
  if (distinct.length === 1) {
    const option = structuredClone(distinct[0].option);
    if (request.perceptionOnly && request.kind === 'observe') {
      if (option.nextAction.kind !== 'attend') return { ok: false, problem: {
        code: 'missing-evidence',
        message: `所选执行依据当前需要先执行${option.nextAction.kind}，尚无可直接运行的观察原子；本轮观察不能替代或自动执行该前置动作`,
        fields: ['executionBasis'],
      } };
      const action = option.nextAction;
      return { ok: true, option: classifyActionOption({
        id, summary: simpleOperationSummary(context, request, action),
        reason: '仅复用所选执行依据当前的真实观察动作',
        goal: action.learning?.factId ? { kind: 'knowledge', factId: action.learning.factId } : observationGoal(context, request.target),
        nextAction: action, target: structuredClone(request.target), nativeOperation: structuredClone(request),
        sourceFactIds: [...new Set([...option.sourceFactIds,
          ...knownExistingSourceIds(context, request.backgroundReferences?.sourceEventIds ?? [])])],
        estimatedDuration: 'one-month', domain: 'strategic',
      }) };
    }
    if (request.kind === 'transfer' && option.nextAction.kind === 'transfer'
      && nativeTransferPreparationKind(context.person, option.nextAction) && !requiresCompleteMethod(option)) {
      option.nativeOperation = structuredClone(request);
      option.completionAction = structuredClone(option.nextAction);
      const completion = option.completionAction;
      if (option.completionAction.from.kind === 'person' && option.completionAction.from.personId === context.person.id
        && !option.completionAction.stackId) {
        option.completionAction.stackId = context.person.inventory.find((stack) => stack.materialId === completion.materialId && stack.quantity > 0)?.id;
      }
      if (completion.from.kind === 'container' && !completion.stackId) {
        completion.stackId = containerById(context.state, completion.from.containerId)?.inventory
          .find((stack) => stack.materialId === completion.materialId && stack.quantity > 0)?.id;
      }
      const next = resolveNativeTransferAction(context.state, context.person, option.completionAction);
      if (!next) return { ok: false, problem: {
        code: 'missing-evidence', message: nativeTransferBlockedReason(context.state, context.person, option.completionAction), fields: ['source', 'destination'],
      } };
      option.nextAction = next;
    }
    option.sourceFactIds = [...new Set([...option.sourceFactIds,
      ...knownExistingSourceIds(context, request.backgroundReferences?.sourceEventIds ?? [])])];
    return { ok: true, option };
  }
  if (distinct.length > 1) return { ok: false, problem: {
    code: 'ambiguous-operation', message: '这些操作指向相同动作，但其项目、知识来源、目标或后续过程不同；需要点明此次使用的具体来源与目标',
    fields: ['executionBasis', 'goal'], candidates: distinct.map((candidate) => candidate.descriptor),
  } };
  return { ok: false, problem: {
    code: 'missing-evidence', message: request.methodKey !== undefined
      ? '所选完整方法已不在当前可执行能力中，或实际对象与参数已经不匹配；不能改用另一条相似过程'
      : '当前没有与所选执行依据相符的完整方法或过程；背景事实请放入backgroundReferences，普通原语不需要executionBasis',
    fields: [request.methodKey !== undefined ? 'methodHandle' : 'executionBasis'],
  } };
}
