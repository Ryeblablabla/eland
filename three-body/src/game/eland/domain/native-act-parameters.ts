import type { SourceOperation, WorldRef } from './action';

export type NativeActTargetRole = 'held' | 'voxel' | 'work' | 'container' | 'person' | 'other-person' | 'animal' | 'remains';
export interface NativeActParameterShape {
  targets: ReadonlyArray<{ role: NativeActTargetRole; min: number; max?: number }>;
  tool: 'optional' | 'required' | 'forbidden';
  description: string;
  /** The ordinary atom cannot supply the mechanical/electrical execution basis. */
  requiresBoundCapability?: boolean;
}
const one = (role: NativeActTargetRole) => ({ role, min: 1, max: 1 });
const shape = (roles: NativeActTargetRole[], description: string, tool: NativeActParameterShape['tool'] = 'optional', bound = false): NativeActParameterShape => ({
  targets: roles.map(one), description, tool, ...(bound ? { requiresBoundCapability: true } : {}),
});

/** Parameter roles only. Materials, quantities, distance and consent remain execution facts. */
export const NATIVE_ACT_PARAMETER_SHAPES: Readonly<Record<SourceOperation, readonly NativeActParameterShape[]>> = {
  combine: [
    { targets: [{ role: 'held', min: 2 }], tool: 'optional', description: '至少两份本人持物，可重复同一库存引用表示多份' },
    shape(['held', 'voxel'], '一份本人持物与一个体素'),
    shape(['held', 'person'], '一份本人持物与一个人物，包括本人；用于照护或绳索接触'),
  ],
  separate: [shape(['voxel'], '一个体素，工具可选'), shape(['work'], '拆除一件实际造物并回收现存材料，不是固定或加固'),
    shape(['person'], '一个人物，包括本人身上的拘束物')],
  expose: [shape(['held', 'voxel'], '把一份本人持物置于实际环境中处理，例如接触火源加热或浸水；作用于材料，不是观察或暴露人物身体')],
  exert: [
    shape(['held'], '对唯一一份本人持物徒手弯曲，不使用工具或体素', 'forbidden'),
    shape(['other-person'], '对另一人的身体施力攻击，近身执行会造成伤害，不是请求其帮忙'),
    shape(['voxel'], '一个体素以及本人持有的实际工具', 'required'),
    shape(['held', 'voxel'], '一份本人持物、一个体素以及本人持有的实际工具', 'required'),
    shape(['voxel'], '完整来源绑定的机械或电力工序及其体素', 'optional', true),
    shape(['held', 'voxel'], '完整来源绑定的机械或电力工序及其持物、体素', 'optional', true),
  ],
  ingest: [shape(['held'], '一份本人持物'), shape(['voxel'], '一个地表饮用物体素'),
    shape(['container'], '从实际开放储存空间饮用一份现存水，消耗有限库存'),
    shape(['work'], '从该造物唯一的实际开放储存空腔饮用一份现存水，名称不能生成水')],
  reproduce: [shape(['other-person'], '一个其他参与者')],
  hunt: [shape(['animal'], '一只动物，工具可选')],
  dehydrate: [shape(['person'], '本人或一名受帮助者')],
  rehydrate: [shape(['person'], '本人或一名受帮助者，利用附近水源'), shape(['person', 'held'], '一名受帮助者及本人持有的水')],
  inter: [shape(['remains'], '一具遗体及已绑定的丧葬阶段'),
    shape(['remains', 'voxel'], '一具遗体和地表'), shape(['remains', 'held'], '一具遗体和本人持物'),
    shape(['remains', 'voxel', 'held'], '一具遗体、地表和本人持物')],
};

export function nativeActTargetMatchesRole(role: NativeActTargetRole, target: WorldRef, actorId: string): boolean {
  if (role === 'held') return target.kind === 'inventory-stack' && target.personId === actorId;
  if (role === 'other-person') return target.kind === 'person' && target.personId !== actorId;
  return target.kind === role;
}

export function matchesNativeActTargetShape<T>(
  pattern: NativeActParameterShape,
  targets: readonly T[],
  accepts: (role: NativeActTargetRole, target: T) => boolean,
): boolean {
  return targets.every((target) => pattern.targets.some(({ role }) => accepts(role, target)))
    && pattern.targets.every(({ role, min, max }) => {
      const count = targets.filter((target) => accepts(role, target)).length;
      return count >= min && (max === undefined || count <= max);
    });
}

export function nativeActParameterProblem(
  request: { operation: SourceOperation; targets: readonly WorldRef[]; tool?: WorldRef },
  actorId: string,
  allowBoundCapability = false,
): { message: string; fields: string[] } | undefined {
  if (request.tool && !nativeActTargetMatchesRole('held', request.tool, actorId)) return {
    message: '工具参数需要本人持有的实际物品；人物自身不是库存工具', fields: ['tool'],
  };
  const patterns = NATIVE_ACT_PARAMETER_SHAPES[request.operation].filter((pattern) => !pattern.requiresBoundCapability || allowBoundCapability);
  const matching = patterns.filter((pattern) => matchesNativeActTargetShape(pattern, request.targets,
    (role, target) => nativeActTargetMatchesRole(role, target, actorId)));
  if (matching.some((pattern) => pattern.tool === 'forbidden' ? !request.tool : pattern.tool !== 'required' || request.tool)) return undefined;
  if (matching.some((pattern) => pattern.tool === 'forbidden') && request.tool) return {
    message: '这组单份持物施力参数表示徒手弯曲，需要省略工具；使用工具的加工需明确对应的材料与作用位置', fields: ['tool'],
  };
  return matching.length ? {
    message: '这个普通施力动作还缺少本人实际持有的工具；已有机械或电力工序需要绑定其完整能力依据', fields: ['tool'],
  } : {
    message: `${request.operation}的实际参数组合是：${patterns.map((pattern) => pattern.description).join('；')}。当前对象没有组成该原语，不代表人物已经尝试失败`,
    fields: ['targets'],
  };
}
