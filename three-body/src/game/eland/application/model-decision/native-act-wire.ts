import type { WorldRef } from '../../domain/action';
import type { NativeOperationRequest } from '../../domain/native-operation';
import { nativeActParameterProblem, nativeActTargetMatchesRole, type NativeActTargetRole } from '../../domain/native-act-parameters';

interface WireParameter {
  field: string;
  role: NativeActTargetRole;
  slot: 'target' | 'tool';
  optional?: boolean;
  description: string;
}
export type NativeActWireKind = 'strike-person' | 'bend-held-material' | 'work-material-with-tool'
  | 'dismantle-work' | 'separate-terrain' | 'release-restraint';

interface NativeActWireDefinition {
  kind: NativeActWireKind;
  operation: 'exert' | 'separate';
  meaning: string;
  parameters: readonly WireParameter[];
}

/** One semantic contract for schemas, descriptions and argument binding. */
export const NATIVE_ACT_WIRE_DEFINITIONS: readonly NativeActWireDefinition[] = [
  { kind: 'strike-person', operation: 'exert', meaning: '对另一人的身体施力攻击，近身执行会造成伤害；不是发出请求或请对方帮忙',
    parameters: [{ field: 'personHandle', role: 'other-person', slot: 'target', description: '承受身体攻击的另一人' }] },
  { kind: 'bend-held-material', operation: 'exert', meaning: '本人徒手弯曲一份持有材料，观察其受力响应',
    parameters: [{ field: 'materialHandle', role: 'held', slot: 'target', description: '本人手中实际被弯曲的一份材料' }] },
  { kind: 'work-material-with-tool', operation: 'exert', meaning: '用本人实际工具加工材料或地表，结果由材质响应决定', parameters: [
    { field: 'toolHandle', role: 'held', slot: 'tool', description: '本人持有并用来做功的工具' },
    { field: 'inputHandle', role: 'held', slot: 'target', optional: true, description: '可选的本人持有加工输入；省略时直接作用于地表' },
    { field: 'surfaceHandle', role: 'voxel', slot: 'target', description: '工具实际作用的地表或环境体素' },
  ] },
  { kind: 'dismantle-work', operation: 'separate', meaning: '拆除一件已有造物并回收其实际剩余材料；不是固定或加固造物',
    parameters: [{ field: 'workHandle', role: 'work', slot: 'target', description: '被拆除回收的真实造物' }] },
  { kind: 'separate-terrain', operation: 'separate', meaning: '分离或采集一个地表体素中的物质，按真实材质与工具结算', parameters: [
    { field: 'surfaceHandle', role: 'voxel', slot: 'target', description: '被分离或采集的实际地表体素' },
    { field: 'toolHandle', role: 'held', slot: 'tool', optional: true, description: '本次实际使用的本人持有工具' },
  ] },
  { kind: 'release-restraint', operation: 'separate', meaning: '解除本人或另一人身上的实际拘束物，不拆取建筑材料',
    parameters: [{ field: 'personHandle', role: 'person', slot: 'target', description: '身上拘束物被解除的人，包括本人self' }] },
];

export function hasDedicatedNativeActWire(operation: unknown): operation is 'exert' | 'separate' {
  return operation === 'exert' || operation === 'separate';
}

export function nativeActWireDefinition(kind: unknown): NativeActWireDefinition | undefined {
  return NATIVE_ACT_WIRE_DEFINITIONS.find((definition) => definition.kind === kind);
}

export function bindNativeActWire(
  raw: Record<string, unknown>, actorId: string, resolve: (value: unknown) => WorldRef | undefined,
): Extract<NativeOperationRequest, { kind: 'act' }> | undefined {
  const definition = nativeActWireDefinition(raw.kind);
  if (!definition || Object.keys(raw).some((key) => !['kind', 'backgroundReferences', ...definition.parameters.map((parameter) => parameter.field)].includes(key))) return undefined;
  const targets: WorldRef[] = [];
  let tool: WorldRef | undefined;
  for (const parameter of definition.parameters) {
    if (raw[parameter.field] === undefined && parameter.optional) continue;
    const ref = resolve(raw[parameter.field]);
    if (!ref || !nativeActTargetMatchesRole(parameter.role, ref, actorId)) return undefined;
    if (parameter.slot === 'tool') tool = ref;
    else targets.push(ref);
  }
  const request = { kind: 'act' as const, operation: definition.operation, targets, ...(tool ? { tool } : {}) };
  return nativeActParameterProblem(request, actorId) ? undefined : request;
}

export function projectNativeActWire(
  request: Extract<NativeOperationRequest, { kind: 'act' }>, actorId: string,
  handleFor: (ref: WorldRef) => string | undefined,
): Record<string, unknown> | undefined {
  for (const definition of NATIVE_ACT_WIRE_DEFINITIONS.filter((entry) => entry.operation === request.operation)) {
    if (request.tool && !definition.parameters.some((parameter) => parameter.slot === 'tool')) continue;
    const unused = new Set(request.targets.map((_, index) => index));
    const projected: Record<string, unknown> = { kind: definition.kind };
    let valid = true;
    for (const parameter of definition.parameters) {
      const index = parameter.slot === 'target' ? [...unused].find((index) => nativeActTargetMatchesRole(parameter.role, request.targets[index], actorId)) : undefined;
      const ref = parameter.slot === 'tool' ? request.tool : index === undefined ? undefined : request.targets[index];
      if (!ref && parameter.optional) continue;
      const handle = ref && nativeActTargetMatchesRole(parameter.role, ref, actorId) ? handleFor(ref) : undefined;
      if (!handle) { valid = false; break; }
      projected[parameter.field] = handle;
      if (index !== undefined) unused.delete(index);
    }
    if (valid && !unused.size) return projected;
  }
  // A complete method may carry additional real tool/target parameters. Keep
  // every parameter visible without pretending it is a different ordinary act.
  if (hasDedicatedNativeActWire(request.operation)) {
    const subjects = request.targets.map((ref) => ({ role: ref.kind === 'inventory-stack' ? 'held-material' : ref.kind, handle: handleFor(ref) }));
    const toolHandle = request.tool ? handleFor(request.tool) : undefined;
    if (subjects.some((subject) => !subject.handle) || request.tool && !toolHandle) return undefined;
    const hasPerson = request.targets.some((ref) => ref.kind === 'person');
    const hasWork = request.targets.some((ref) => ref.kind === 'work');
    const kind = request.operation === 'exert' ? hasPerson ? 'method-body-force' : 'method-material-operation'
      : hasWork ? 'method-dismantling' : hasPerson ? 'method-restraint-release' : 'method-terrain-separation';
    const meaning = request.operation === 'exert' ? hasPerson ? '完整方法中的身体施力攻击' : '完整方法中的物件或地表做功'
      : hasWork ? '完整方法中的造物拆取回收' : hasPerson ? '完整方法中的人身拘束解除' : '完整方法中的地表分离';
    return { kind, meaning: `${meaning}；这些参数仅供核对，使用use-method调用`, subjects,
      ...(toolHandle ? { toolHandle } : {}) };
  }
  return undefined;
}
