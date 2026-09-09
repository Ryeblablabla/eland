import type { NativeOperationDescriptor, NativeOperationRequest } from '../../domain/native-operation';
import type { WorldRef, SourceOperation } from '../../domain/action';
import type { ProjectFunction } from '../../domain/project';
import { MATERIAL_PALETTE, materialDefinition } from '../../domain/material';
import type { DecisionRequestContext } from './decision-context';
import type { DecisionProbeHandleMap } from './capability-handles';
import { deriveWorldTargets, type WorldTargetDerivationContext } from './world-target-derivation';
import { nativeActParameterProblem } from '../../domain/native-act-parameters';
import { WORK_ARRANGEMENTS, type WorkArrangement } from '../../domain/works';
import type { WorkLayout } from '../../domain/work-layout';
import { bindNativeActWire, hasDedicatedNativeActWire, nativeActWireDefinition, projectNativeActWire } from './native-act-wire';

export type NativeReferenceKind = 'project' | 'record' | 'knowledge' | 'technique' | 'agreement' | 'source' | 'stack';
const referenceFields = {
  projectId: 'project', recordId: 'record', knowledgeId: 'knowledge', techniqueId: 'technique', agreementId: 'agreement',
} as const;
const modelReferenceFields = {
  projectHandle: 'projectId', recordHandle: 'recordId', knowledgeHandle: 'knowledgeId',
  techniqueHandle: 'techniqueId', agreementHandle: 'agreementId',
} as const;
const sourceOperations: SourceOperation[] = ['exert', 'separate', 'combine', 'expose', 'ingest', 'reproduce', 'hunt', 'dehydrate', 'rehydrate', 'inter'];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export function nativeOperationIdentity(request: NativeOperationRequest): string {
  const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
      : JSON.stringify(value);
  return stable(request);
}

export function nativeOperationWorldRefs(descriptors: readonly Pick<NativeOperationDescriptor, 'request'>[]): WorldRef[] {
  return descriptors.flatMap(({ request }): WorldRef[] => {
    if (request.kind === 'move') return [request.target];
    if (request.kind === 'observe') return [request.target, ...(request.instrument ? [request.instrument] : [])];
    if (request.kind === 'transfer') return [request.source, request.destination, ...(request.container ? [request.container] : [])];
    if (request.kind === 'assemble') return [request.target, ...request.inputs.map((input) => input.target)];
    if (request.kind === 'act') return [...request.targets, ...(request.tool ? [request.tool] : [])];
    if (request.kind === 'inscribe') return [request.carrier];
    return request.kind === 'project' && request.site ? [{ kind: 'voxel', position: request.site }] : [];
  });
}

export function nativeReferenceEntities(descriptors: readonly NativeOperationDescriptor[]): Array<{ kind: NativeReferenceKind; id: string }> {
  const entries = new Map<string, { kind: NativeReferenceKind; id: string }>();
  const add = (kind: NativeReferenceKind, id: string | undefined): void => {
    if (id) entries.set(`${kind}:${id}`, { kind, id });
  };
  for (const descriptor of descriptors) {
    const request = descriptor.request;
    for (const references of [request.references, request.backgroundReferences]) {
      for (const [field, kind] of Object.entries(referenceFields)) add(kind, references?.[field as keyof typeof referenceFields]);
      for (const id of references?.sourceEventIds ?? []) add('source', id);
    }
    for (const id of descriptor.sourceEventIds) add('source', id);
    if (request.kind === 'project') add('project', request.projectId);
    if (request.kind === 'transfer') add('stack', request.sourceStackId);
    if (request.kind === 'inscribe') {
      add('knowledge', request.knowledgeId);
      add('knowledge', request.codebookId);
    }
  }
  return [...entries.values()];
}

export function nativeWorldRefHandle(ref: WorldRef, handles: DecisionProbeHandleMap): string | undefined {
  if (ref.kind === 'person' && ref.personId === handles.actorId) return 'self';
  if (ref.kind === 'voxel') return handles.voxels.find((item) => item.position.x === ref.position.x
    && item.position.y === ref.position.y && item.position.z === ref.position.z)?.handle;
  if (ref.kind === 'inventory-stack' && ref.personId === handles.actorId) return handles.held.find((item) => item.stackId === ref.stackId)?.handle;
  return handles.visible.find((item) => item.kind === ref.kind
    && (ref.kind === 'person' && item.kind === 'person' && item.personId === ref.personId
      || ref.kind === 'drop' && item.kind === 'drop' && item.dropId === ref.dropId
      || ref.kind === 'animal' && item.kind === 'animal' && item.animalId === ref.animalId
      || ref.kind === 'work' && item.kind === 'work' && item.workId === ref.workId
      || ref.kind === 'container' && item.kind === 'container' && item.containerId === ref.containerId
      || ref.kind === 'inventory-stack' && item.kind === 'inventory-stack' && item.personId === ref.personId && item.stackId === ref.stackId))?.handle;
}

export function nativeWorldRefForHandle(value: unknown, handles: DecisionProbeHandleMap): WorldRef | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'self') return handles.actorId ? { kind: 'person', personId: handles.actorId } : undefined;
  const held = handles.held.find((item) => item.handle === value);
  if (held && handles.actorId) return { kind: 'inventory-stack', personId: handles.actorId, stackId: held.stackId };
  const voxel = handles.voxels.find((item) => item.handle === value);
  if (voxel) return { kind: 'voxel', position: { ...voxel.position } };
  const visible = handles.visible.find((item) => item.handle === value);
  if (!visible) return undefined;
  const { handle: _handle, ...ref } = visible;
  return ref;
}

/** The named method cannot introduce a different entity outside this step. */
export function scopedNativeMethods(
  context: WorldTargetDerivationContext,
  handles: DecisionProbeHandleMap,
  allowedTargetHandles?: readonly string[],
): NonNullable<DecisionProbeHandleMap['nativeMethods']> {
  const actualHandles = handles.actorId ? handles : { ...handles,
    actorId: typeof context.person.id === 'string' ? context.person.id : undefined };
  const allowed = allowedTargetHandles
    ? new Set(deriveWorldTargets(context, actualHandles, allowedTargetHandles).allowedHandles) : undefined;
  return (handles.nativeMethods ?? []).filter((method) => method.request.kind !== 'speech' && nativeOperationWorldRefs([method]).every((target) => {
    const handle = nativeWorldRefHandle(target, actualHandles);
    return handle !== undefined && (!allowed || allowed.has(handle));
  }));
}

export function projectNativeOperations(context: DecisionRequestContext, handles: DecisionProbeHandleMap): Array<Record<string, unknown>> {
  const reference = (kind: NativeReferenceKind, id: string | undefined) => id
    ? handles.nativeReferences?.find((item) => item.kind === kind && item.id === id)?.handle : undefined;
  return (context.nativeOperations ?? []).flatMap((descriptor) => {
    const request = descriptor.request;
    const projectReferences = (value: NativeOperationRequest['references']): Record<string, unknown> => {
      const projected: Record<string, unknown> = {};
      for (const [modelField, field] of Object.entries(modelReferenceFields)) {
        const handle = reference(referenceFields[field], value?.[field]);
        if (handle) projected[modelField] = handle;
      }
      const sources = value?.sourceEventIds?.map((id) => reference('source', id)).filter(Boolean);
      if (sources?.length) projected.sourceHandles = sources;
      return projected;
    };
    const methodSources = projectReferences(request.references);
    const backgroundReferences = projectReferences(request.backgroundReferences);
    const projected: Record<string, unknown> = { kind: request.kind === 'move' ? 'walk-to' : request.kind,
      ...(Object.keys(backgroundReferences).length ? { backgroundReferences } : {}) };
    const bind = (field: string, target: WorldRef | undefined) => {
      if (target) projected[field] = nativeWorldRefHandle(target, handles);
    };
    if (request.kind === 'move' || request.kind === 'observe') bind('targetHandle', request.target);
    if (request.kind === 'move' && request.withinDistance !== undefined) projected.withinDistance = request.withinDistance;
    if (request.kind === 'observe') bind('instrumentHandle', request.instrument);
    if (request.kind === 'transfer') {
      bind('sourceHandle', request.source); bind('destinationHandle', request.destination); bind('containerHandle', request.container);
      projected.quantity = request.quantity;
      if (request.materialId !== undefined) projected.materialKey = materialDefinition(request.materialId).key;
      if (request.sourceStackId) projected.sourceStackHandle = reference('stack', request.sourceStackId);
    }
    if (request.kind === 'assemble') {
      bind('targetHandle', request.target);
      projected.inputs = request.inputs.map((input) => ({ targetHandle: nativeWorldRefHandle(input.target, handles), quantity: input.quantity }));
      if (request.arrangement) projected.arrangement = request.arrangement;
      if (request.summary) projected.summary = request.summary;
      if (request.layout) projected.layout = request.layout.voxels.map((voxel) => ({ offset: { ...voxel.offset },
        materialKey: materialDefinition(voxel.materialId).key }));
    }
    if (request.kind === 'act') {
      const named = projectNativeActWire(request, handles.actorId ?? context.person.id, (target) => nativeWorldRefHandle(target, handles));
      if (named) Object.assign(projected, named);
      else {
        if (hasDedicatedNativeActWire(request.operation)) return [];
        projected.operation = request.operation;
        projected.targetHandles = request.targets.map((target) => nativeWorldRefHandle(target, handles));
        bind('toolHandle', request.tool);
      }
    }
    if (request.kind === 'inscribe') {
      bind('carrierHandle', request.carrier);
      if (request.knowledgeId) projected.knowledgeHandle = reference('knowledge', request.knowledgeId);
      if (request.codebookId) projected.codebookHandle = reference('knowledge', request.codebookId);
      if (request.text) projected.text = request.text;
    }
    if (request.kind === 'project') {
      if (request.projectId) projected.projectHandle = reference('project', request.projectId);
      if (request.site) bind('siteHandle', { kind: 'voxel', position: request.site });
    }
    const method = handles.nativeMethods?.find((method) => nativeOperationIdentity(method.request)
      === nativeOperationIdentity({ ...request, ...(descriptor.methodKey ? { methodKey: descriptor.methodKey } : {}) }));
    if (!method && typeof projected.kind === 'string' && projected.kind.startsWith('method-')) return [];
    return [{
      request: method ? { kind: 'use-method', methodHandle: method.handle } : projected,
      ...(method ? { methodHandle: method.handle, methodParameters: projected, methodSources } : {}),
      summary: method ? descriptor.summary : nativeActWireDefinition(projected.kind)?.meaning ?? descriptor.summary,
      reason: descriptor.reason,
      ...(request.goal ? { localGoal: structuredClone(request.goal) } : {}),
      sourceHandles: descriptor.sourceEventIds.map((id) => reference('source', id)).filter(Boolean),
    }];
  });
}

export interface NativeObservationInstrumentBinding { targetHandle: string; instrumentHandle: string }

/** Only already described calibration/measurement capabilities supply an
 * instrument role; merely carrying an object does not make it an instrument. */
export function nativeObservationInstrumentBindings(
  context: { nativeOperations?: readonly unknown[]; person?: { id?: unknown } },
  handles: DecisionProbeHandleMap,
): NativeObservationInstrumentBinding[] {
  const actorId = handles.actorId ?? (typeof context.person?.id === 'string' ? context.person.id : undefined);
  const actualHandles = actorId === handles.actorId ? handles : { ...handles, actorId };
  const bindings = new Map<string, NativeObservationInstrumentBinding>();
  for (const value of context.nativeOperations ?? []) {
    const request = object(object(value).request);
    if (request.kind !== 'observe') continue;
    const targetHandle = typeof request.targetHandle === 'string' ? request.targetHandle
      : request.target && typeof request.target === 'object' ? nativeWorldRefHandle(request.target as WorldRef, actualHandles) : undefined;
    const instrumentHandle = typeof request.instrumentHandle === 'string' ? request.instrumentHandle
      : request.instrument && typeof request.instrument === 'object' ? nativeWorldRefHandle(request.instrument as WorldRef, actualHandles) : undefined;
    if (!targetHandle || !instrumentHandle || !nativeWorldRefForHandle(targetHandle, actualHandles)
      || !handles.held.some((held) => held.handle === instrumentHandle)) continue;
    bindings.set(`${targetHandle}:${instrumentHandle}`, { targetHandle, instrumentHandle });
  }
  return [...bindings.values()];
}

/** Resolve semantic operation arguments only; the application compiler owns feasibility and outcomes. */
export function compileModelNativeOperation(
  input: unknown,
  context: WorldTargetDerivationContext & { nativeOperations?: readonly unknown[]; knownProjects?: readonly unknown[] },
  handles: DecisionProbeHandleMap,
  allowedTargetHandles?: readonly string[],
  onInvalid?: (message: string) => void,
): NativeOperationRequest | undefined {
  const raw = object(input);
  if (raw.methodKey !== undefined) { onInvalid?.('methodKey由服务端绑定，模型只选择本轮展示的methodHandle'); return undefined; }
  if (raw.executionBasis !== undefined || raw.references !== undefined) {
    onInvalid?.('普通原语只接受backgroundReferences；复用已展示的完整方法请使用use-method和methodHandle，不拼接执行来源');
    return undefined;
  }
  if (raw.kind === 'use-method') {
    if (Object.keys(raw).some((key) => !['kind', 'methodHandle'].includes(key))) {
      onInvalid?.('use-method只选择methodHandle，参数和执行来源已由本轮真实方法绑定');
      return undefined;
    }
    const method = scopedNativeMethods(context, handles, allowedTargetHandles)
      .find((method) => method.handle === raw.methodHandle);
    if (!method) {
      onInvalid?.('该方法未在本轮展示，或其实际作用对象不属于当前步骤；不能借方法引入别的目标');
      return undefined;
    }
    return structuredClone(method.request);
  }
  const actorId = handles.actorId ?? (typeof context.person.id === 'string' ? context.person.id : undefined);
  const actualHandles = actorId === handles.actorId ? handles : { ...handles, actorId };
  const allowed = allowedTargetHandles ? new Set(deriveWorldTargets(context, actualHandles, allowedTargetHandles).allowedHandles) : undefined;
  const entity = (value: unknown): WorldRef | undefined => typeof value === 'string'
    && (!allowed || allowed.has(value)) ? nativeWorldRefForHandle(value, actualHandles) : undefined;
  const heldObject = (value: unknown): Extract<WorldRef, { kind: 'inventory-stack' }> | undefined => {
    const ref = entity(value);
    return ref?.kind === 'inventory-stack' && ref.personId === actorId ? ref : undefined;
  };
  const refId = (kind: NativeReferenceKind, handle: unknown): string | undefined => typeof handle === 'string'
    ? handles.nativeReferences?.find((item) => item.kind === kind && item.handle === handle)?.id : undefined;
  const bindReferences = (value: unknown): NonNullable<NativeOperationRequest['references']> | undefined => {
    const rawReferences = object(value);
    const references: NonNullable<NativeOperationRequest['references']> = {};
    for (const [modelField, field] of Object.entries(modelReferenceFields)) {
      if (rawReferences[modelField] === undefined) continue;
      const id = refId(referenceFields[field], rawReferences[modelField]);
      if (!id) return undefined;
      references[field] = id;
    }
    if (rawReferences.sourceHandles !== undefined) {
      if (!Array.isArray(rawReferences.sourceHandles)) return undefined;
      const ids = rawReferences.sourceHandles.map((handle) => refId('source', handle));
      if (ids.some((id) => !id)) return undefined;
      references.sourceEventIds = ids as string[];
    }
    return references;
  };
  const backgroundReferences = bindReferences(raw.backgroundReferences);
  if (!backgroundReferences) return undefined;
  const basis = { ...(Object.keys(backgroundReferences).length ? { backgroundReferences } : {}) };
  const namedAct = nativeActWireDefinition(raw.kind);
  if (namedAct) {
    const request = bindNativeActWire(raw, actorId ?? '', entity);
    if (!request) onInvalid?.(`${namedAct.kind}需要明确的参数角色：${namedAct.meaning}`);
    return request ? { ...basis, ...request } : undefined;
  }
  if (raw.kind === 'speech') return Object.keys(raw).length === 1 ? { kind: 'speech' } : undefined;
  const walking = raw.kind === 'approach' || raw.kind === 'walk-to' || raw.kind === 'move';
  if (walking || raw.kind === 'observe') {
    const target = entity(raw.targetHandle);
    if (!target) return undefined;
    if (walking) {
      if (target.kind === 'inventory-stack' && target.personId === actorId
        && allowedTargetHandles && !allowedTargetHandles.includes(String(raw.targetHandle))) {
        onInvalid?.('本人持物可用作本步材料或工具；移动仍应指向本人已选实体或明确位置，不把隐含材料当成新的移动目的地');
        return undefined;
      }
      if (target.kind === 'voxel' && allowedTargetHandles && !allowedTargetHandles.includes(String(raw.targetHandle))) {
        onInvalid?.('这个位置引用是为实体派生的定位锚点；移动靠近人物或物品请直接使用其实体引用，只有Plan明确点名的体素才作为精确落脚目标');
        return undefined;
      }
      if (raw.kind === 'approach') {
        if (raw.withinDistance !== undefined) return undefined;
        return { ...basis, kind: 'move', target, withinDistance: 1 };
      }
      if (raw.withinDistance !== undefined && (typeof raw.withinDistance !== 'number' || !Number.isFinite(raw.withinDistance) || raw.withinDistance < 0)) return undefined;
      return { ...basis, kind: 'move', target, ...(typeof raw.withinDistance === 'number' ? { withinDistance: raw.withinDistance } : {}) };
    }
    if (raw.instrumentHandle !== undefined) {
      onInvalid?.('仪器观察调用本轮展示的use-method；普通observe只观察指定对象，不重填完整测量方法的仪器参数');
      return undefined;
    }
    return { ...basis, kind: 'observe', target };
  }
  if (raw.kind === 'assemble') {
    const target = entity(raw.targetHandle);
    if (!target || !['voxel', 'work'].includes(target.kind) || !Array.isArray(raw.inputs)) return undefined;
    const inputs = raw.inputs.map((value) => {
      const input = object(value);
      const target = heldObject(input.targetHandle);
      return target && Number.isSafeInteger(input.quantity) && Number(input.quantity) > 0
        ? { target, quantity: Number(input.quantity) } : undefined;
    });
    if (inputs.some((input) => !input)) return undefined;
    const arrangement = WORK_ARRANGEMENTS.includes(raw.arrangement as WorkArrangement) ? raw.arrangement as WorkArrangement : undefined;
    if (raw.arrangement !== undefined && !arrangement || target.kind === 'voxel' && (!inputs.length || !arrangement)) return undefined;
    let layout: WorkLayout | undefined;
    if (raw.layout !== undefined) {
      if (!Array.isArray(raw.layout) || !raw.layout.length) return undefined;
      const voxels = raw.layout.map((value) => {
        const entry = object(value), offset = object(entry.offset);
        const material = MATERIAL_PALETTE.find((material) => material.key === entry.materialKey && material.phase === 'solid');
        return material && ['x', 'y', 'z'].every((key) => Number.isSafeInteger(offset[key]))
          ? { offset: { x: Number(offset.x), y: Number(offset.y), z: Number(offset.z) }, materialId: material.id } : undefined;
      });
      if (voxels.some((voxel) => !voxel)) return undefined;
      layout = { version: 'work-layout-v1', voxels: voxels as WorkLayout['voxels'] };
    }
    if (target.kind === 'work' && !inputs.length && !layout && !arrangement) return undefined;
    if (raw.summary !== undefined && (typeof raw.summary !== 'string' || !raw.summary.trim() || raw.summary.length > 160)) return undefined;
    return { ...basis, kind: 'assemble', target: target as Extract<WorldRef, { kind: 'voxel' | 'work' }>,
      inputs: inputs as Extract<NativeOperationRequest, { kind: 'assemble' }>['inputs'],
      ...(arrangement ? { arrangement } : {}), ...(layout ? { layout } : {}),
      ...(typeof raw.summary === 'string' ? { summary: raw.summary.trim() } : {}) };
  }
  if (raw.kind === 'transfer') {
    const source = entity(raw.sourceHandle), destination = entity(raw.destinationHandle);
    const container = raw.containerHandle === undefined ? undefined : heldObject(raw.containerHandle);
    const material = raw.materialKey === undefined ? undefined : MATERIAL_PALETTE.find((item) => item.key === raw.materialKey && item.id !== 0);
    const sourceStackId = raw.sourceStackHandle === undefined ? undefined : refId('stack', raw.sourceStackHandle);
    if (!source || !destination || !Number.isSafeInteger(raw.quantity) || Number(raw.quantity) < 1
      || raw.containerHandle !== undefined && !container || raw.materialKey !== undefined && !material
      || raw.sourceStackHandle !== undefined && !sourceStackId) return undefined;
    return { ...basis, kind: 'transfer', source, destination, quantity: Number(raw.quantity),
      ...(container ? { container } : {}), ...(material ? { materialId: material.id } : {}), ...(sourceStackId ? { sourceStackId } : {}) };
  }
  if (raw.kind === 'act') {
    if (hasDedicatedNativeActWire(raw.operation)) {
      onInvalid?.('exert/separate不再使用泛用act/targetHandles；选择明确的身体攻击、持物弯曲、工具加工、拆取造物、地表分离或解除拘束入口');
      return undefined;
    }
    if (!sourceOperations.includes(raw.operation as SourceOperation) || !Array.isArray(raw.targetHandles)) return undefined;
    const targets = raw.targetHandles.map(entity);
    const tool = raw.toolHandle === undefined ? undefined : heldObject(raw.toolHandle);
    if (targets.some((target) => !target) || raw.toolHandle !== undefined && !tool) return undefined;
    const request = { ...basis, kind: 'act' as const, operation: raw.operation as SourceOperation,
      targets: targets as WorldRef[], ...(tool ? { tool } : {}) };
    if (nativeActParameterProblem(request, actorId ?? '')) return undefined;
    return request;
  }
  if (raw.kind === 'inscribe') {
    const carrier = heldObject(raw.carrierHandle);
    const knowledgeId = raw.knowledgeHandle === undefined ? undefined : refId('knowledge', raw.knowledgeHandle);
    const codebookId = raw.codebookHandle === undefined ? undefined : refId('knowledge', raw.codebookHandle);
    if (!carrier || raw.knowledgeHandle !== undefined && !knowledgeId || raw.codebookHandle !== undefined && !codebookId) return undefined;
    return { ...basis, kind: 'inscribe', carrier, ...(knowledgeId ? { knowledgeId } : {}), ...(codebookId ? { codebookId } : {}),
      ...(typeof raw.text === 'string' && raw.text.trim() ? { text: raw.text.trim() } : {}) };
  }
  if (raw.kind === 'project') {
    const projectId = refId('project', raw.projectHandle);
    const site = raw.siteHandle === undefined ? undefined : entity(raw.siteHandle);
    if (raw.projectHandle !== undefined && !projectId || raw.siteHandle !== undefined && site?.kind !== 'voxel') return undefined;
    const known = context.knownProjects?.map(object).find((project) => project.status !== 'proposed'
      && (project.id === projectId || project.ref === raw.projectHandle));
    if (context.knownProjects && (!projectId || typeof raw.projectHandle !== 'string' || !known
      || raw.desiredFunction !== undefined && raw.desiredFunction !== known.desiredFunction)) {
      onInvalid?.('project只接续本人已知且真实存在的项目，必须引用该项目；新创造请在本次计划中说明做法并使用实际物理操作或开放effects');
      return undefined;
    }
    return { ...basis, kind: 'project', ...(projectId ? { projectId } : {}),
      ...(typeof known?.desiredFunction === 'string' ? { desiredFunction: known.desiredFunction as ProjectFunction }
        : typeof raw.desiredFunction === 'string' ? { desiredFunction: raw.desiredFunction as ProjectFunction } : {}),
      ...(site?.kind === 'voxel' ? { site: site.position } : {}) };
  }
  return undefined;
}
