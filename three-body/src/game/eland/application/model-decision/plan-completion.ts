import type { FactPredicate, WorldRef } from '../../domain/action';
import { AGREEMENT_STATUSES, type AgreementStatus } from '../../domain/agreement';
import { MATERIAL_PALETTE } from '../../domain/material';
import type { MentalPlanTranslation, PlanCompletionCheck, PlanSuccessCondition } from '../../domain/mental-act';
import type { DecisionProbeHandleMap } from './capability-handles';
import type { DecisionRequestContext } from './decision-context';
import { cellX, cellY } from '../../world/grid';

type Completion = NonNullable<MentalPlanTranslation['completion']>;
const materialByKey = new Map(MATERIAL_PALETTE.filter((material) => material.id !== 0).map((material) => [material.key, material.id]));
const materialIds = new Set(materialByKey.values());
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const quantity = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const bounded = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

function targetFor(handle: unknown, context: DecisionRequestContext, handles: DecisionProbeHandleMap): WorldRef | undefined {
  if (handle === 'self') return { kind: 'person', personId: context.person.id };
  const voxel = handles.voxels.find((item) => item.handle === handle);
  if (voxel) return { kind: 'voxel', position: { ...voxel.position } };
  const held = handles.held.find((item) => item.handle === handle);
  if (held) return { kind: 'inventory-stack', personId: context.person.id, stackId: held.stackId };
  const visible = handles.visible.find((item) => item.handle === handle);
  if (!visible) return undefined;
  if (visible.kind === 'work') return { kind: 'work', workId: visible.workId };
  if (visible.kind === 'person') return { kind: 'person', personId: visible.personId };
  if (visible.kind === 'drop') return { kind: 'drop', dropId: visible.dropId };
  if (visible.kind === 'animal') return { kind: 'animal', animalId: visible.animalId };
  if (visible.kind === 'remains') return { kind: 'remains', remainsId: visible.remainsId };
  if (visible.kind === 'inventory-stack') return { kind: 'inventory-stack', personId: visible.personId, stackId: visible.stackId };
  return { kind: 'container', containerId: visible.containerId };
}

function physicalRequirements(raw: Record<string, unknown>, keyedMaterials: boolean): Partial<Extract<PlanSuccessCondition, { kind: 'work-state' }>> | undefined {
  if (raw.minCondition !== undefined && !bounded(raw.minCondition)) return undefined;
  const profile = object(raw.minProfile);
  if (Object.entries(profile).some(([key, value]) => !['cover', 'rigidity', 'stability'].includes(key) || !bounded(value))) return undefined;
  const components = Array.isArray(raw.components) ? raw.components.map((value) => {
    const component = object(value);
    return { materialId: keyedMaterials ? materialByKey.get(text(component.materialKey)) : component.materialId, quantity: component.quantity };
  }) : [];
  if (components.some((component) => typeof component.materialId !== 'number'
    || !materialIds.has(component.materialId) || !quantity(component.quantity))) return undefined;
  return {
    ...(bounded(raw.minCondition) ? { minCondition: raw.minCondition } : {}),
    ...(Object.keys(profile).length ? { minProfile: profile as { cover?: number; rigidity?: number; stability?: number } } : {}),
    ...(components.length ? { components: components as Array<{ materialId: number; quantity: number }> } : {}),
  };
}

function modelCondition(input: unknown, context: DecisionRequestContext, handles: DecisionProbeHandleMap): PlanSuccessCondition | undefined {
  const raw = object(input);
  const materialId = materialByKey.get(text(raw.materialKey));
  const target = targetFor(raw.targetHandle, context, handles);
  if (raw.kind === 'agreement-status' || raw.kind === 'agreement-response-recorded') {
    const reference = [...(handles.speechReferences ?? []), ...(handles.nativeReferences ?? [])]
      .find((entry) => entry.kind === 'agreement' && entry.handle === raw.agreementHandle);
    const agreementId = reference?.id;
    if (!agreementId || !context.agreements.some((agreement) => agreement.id === agreementId)) return undefined;
    if (raw.kind === 'agreement-status' && (AGREEMENT_STATUSES as readonly string[]).includes(text(raw.status))) {
      return { kind: 'fact', predicate: { kind: 'agreement-status', agreementId, status: raw.status as AgreementStatus } };
    }
    const person = targetFor(raw.personHandle, context, handles);
    if (raw.kind === 'agreement-response-recorded' && person?.kind === 'person'
      && (raw.response === 'accepted' || raw.response === 'rejected')) return {
      kind: 'fact', predicate: { kind: 'agreement-response-recorded', agreementId, personId: person.personId, response: raw.response },
    };
    return undefined;
  }
  if (raw.kind === 'inventory-at-least' && materialId !== undefined && quantity(raw.quantity)) {
    return { kind: 'fact', predicate: { kind: 'inventory-at-least', materialId, quantity: raw.quantity } };
  }
  if (raw.kind === 'voxel-is' && target?.kind === 'voxel' && materialId !== undefined) {
    return { kind: 'fact', predicate: { kind: 'voxel-is', position: target.position, materialId } };
  }
  if (raw.kind === 'body-at-least' && ['health', 'hydration', 'nutrition'].includes(text(raw.field)) && bounded(raw.value)) {
    return { kind: 'fact', predicate: { kind: 'body-at-least', field: raw.field as 'health' | 'hydration' | 'nutrition', value: raw.value } };
  }
  if (raw.kind === 'sheltered') return { kind: 'fact', predicate: { kind: 'sheltered' } };
  if ((raw.kind === 'near-target' || raw.kind === 'reached-target') && target && bounded(raw.maxDistance)) return { kind: raw.kind, target, maxDistance: raw.maxDistance };
  if (raw.kind === 'work-state') {
    const workTarget = raw.targetHandle === 'produced-work' ? { kind: 'produced-work' as const } : target;
    const requirements = physicalRequirements(raw, true);
    if (!workTarget || !['produced-work', 'work', 'voxel'].includes(workTarget.kind) || !requirements) return undefined;
    return { kind: 'work-state', target: workTarget as Extract<PlanSuccessCondition, { kind: 'work-state' }>['target'], ...requirements };
  }
  return undefined;
}

/** Model-owned success criteria become predicates; they never mutate or declare world success. */
export function compileModelPlanCompletion(input: unknown, context: DecisionRequestContext, handles: DecisionProbeHandleMap): Completion | undefined {
  const raw = object(input);
  const check = (value: unknown): PlanCompletionCheck | undefined => {
    const source = object(value);
    const description = text(source.description).slice(0, 240);
    if (!description || !Array.isArray(source.conditions)) return undefined;
    const conditions = source.conditions.map((condition) => modelCondition(condition, context, handles));
    return conditions.every((condition): condition is PlanSuccessCondition => Boolean(condition)) ? { description, conditions } : undefined;
  };
  const step = check(raw.step);
  const goal = check(raw.goal);
  return step && goal ? { step, goal } : undefined;
}

/** Validate the already bound IR passing between the local adapters. */
export function sanitizeBoundPlanCompletion(input: unknown): Completion | undefined {
  const validTarget = (value: unknown): boolean => {
    const target = object(value);
    if (target.kind === 'produced-work') return true;
    if (target.kind === 'voxel') return ['x', 'y', 'z'].every((key) => Number.isInteger(object(target.position)[key]));
    return target.kind === 'work' ? Boolean(text(target.workId))
      : target.kind === 'person' ? Boolean(text(target.personId))
        : target.kind === 'drop' ? Boolean(text(target.dropId))
          : target.kind === 'animal' ? Boolean(text(target.animalId))
            : target.kind === 'container' ? Boolean(text(target.containerId))
              : target.kind === 'inventory-stack' && Boolean(text(target.personId) && text(target.stackId));
  };
  const condition = (value: unknown): PlanSuccessCondition | undefined => {
    const raw = object(value);
    if ((raw.kind === 'near-target' || raw.kind === 'reached-target') && validTarget(raw.target) && object(raw.target).kind !== 'produced-work' && bounded(raw.maxDistance)) {
      return structuredClone(raw) as unknown as PlanSuccessCondition;
    }
    if (raw.kind === 'work-state' && validTarget(raw.target)
      && ['work', 'voxel', 'produced-work'].includes(text(object(raw.target).kind)) && physicalRequirements(raw, false)) {
      return structuredClone(raw) as unknown as PlanSuccessCondition;
    }
    const predicate = object(raw.predicate);
    if (raw.kind !== 'fact') return undefined;
    const valid = predicate.kind === 'sheltered'
      || predicate.kind === 'agreement-status' && Boolean(text(predicate.agreementId))
        && (AGREEMENT_STATUSES as readonly string[]).includes(text(predicate.status))
      || predicate.kind === 'agreement-response-recorded' && Boolean(text(predicate.agreementId) && text(predicate.personId))
        && ['accepted', 'rejected'].includes(text(predicate.response))
      || predicate.kind === 'inventory-at-least' && typeof predicate.materialId === 'number' && materialIds.has(predicate.materialId) && quantity(predicate.quantity)
      || predicate.kind === 'body-at-least' && ['health', 'hydration', 'nutrition'].includes(text(predicate.field)) && bounded(predicate.value)
      || predicate.kind === 'voxel-is' && typeof predicate.materialId === 'number' && materialIds.has(predicate.materialId)
        && validTarget({ kind: 'voxel', position: predicate.position });
    return valid ? { kind: 'fact', predicate: structuredClone(predicate) as unknown as FactPredicate } : undefined;
  };
  const check = (value: unknown): PlanCompletionCheck | undefined => {
    const raw = object(value);
    const description = text(raw.description).slice(0, 240);
    if (!description || !Array.isArray(raw.conditions)) return undefined;
    const conditions = raw.conditions.map(condition);
    return conditions.every((value): value is PlanSuccessCondition => Boolean(value)) ? { description, conditions } : undefined;
  };
  const raw = object(input);
  const step = check(raw.step);
  const goal = check(raw.goal);
  return step && goal ? { step, goal } : undefined;
}

/** Rebind persisted criteria to this request's visible handles without moving their targets. */
export function describeModelPlanCompletion(completion: Completion | undefined, context: DecisionRequestContext, handles: DecisionProbeHandleMap): unknown {
  if (!completion) return undefined;
  const materialKey = (id: number) => MATERIAL_PALETTE.find((material) => material.id === id)?.key;
  const handleFor = (target: WorldRef | { kind: 'produced-work' }): string | undefined => {
    if (target.kind === 'produced-work') return 'produced-work';
    if (target.kind === 'person' && target.personId === context.person.id) return 'self';
    if (target.kind === 'voxel') return handles.voxels.find((item) => item.position.x === target.position.x
      && item.position.y === target.position.y && item.position.z === target.position.z)?.handle;
    if (target.kind === 'inventory-stack' && target.personId === context.person.id) return handles.held.find((item) => item.stackId === target.stackId)?.handle;
    return handles.visible.find((item) => target.kind === 'work' && item.kind === 'work' && item.workId === target.workId
      || target.kind === 'person' && item.kind === 'person' && item.personId === target.personId
      || target.kind === 'drop' && item.kind === 'drop' && item.dropId === target.dropId
      || target.kind === 'animal' && item.kind === 'animal' && item.animalId === target.animalId
      || target.kind === 'remains' && item.kind === 'remains' && item.remainsId === target.remainsId
      || target.kind === 'inventory-stack' && item.kind === 'inventory-stack'
        && item.personId === target.personId && item.stackId === target.stackId
      || target.kind === 'container' && item.kind === 'container' && item.containerId === target.containerId)?.handle;
  };
  const targetDescription = (target: WorldRef | { kind: 'produced-work' }, field = 'targetHandle'): Record<string, unknown> => {
    const handle = handleFor(target);
    return handle ? { [field]: handle } : { [`${field}Visibility`]: '先前指定的对象在本轮没有可解析引用，不能改绑为其他对象或推断其状态' };
  };
  const ownerDescription = (personId = context.person.id) => targetDescription({ kind: 'person', personId }, 'ownerHandle');
  const referenceDescription = (kind: string, id: string, field = `${kind}Handle`): Record<string, unknown> => {
    const handle = handles.nativeReferences?.find((reference) => reference.kind === kind && reference.id === id)?.handle
      ?? handles.speechReferences?.find((reference) => reference.kind === kind && reference.id === id)?.handle;
    return handle ? { [field]: handle } : { [`${field}Visibility`]: '本轮没有可解析的原事项引用，具体含义或内容未知' };
  };
  const describe = (condition: PlanSuccessCondition): unknown => {
    if (condition.kind === 'work-state') {
      const targetHandle = handleFor(condition.target);
      return {
        kind: condition.kind,
        ...(targetHandle ? { targetHandle } : { targetVisibility: '先前绑定对象当前不可见；这不证明对象已消失' }),
        ...(condition.minCondition !== undefined ? { minCondition: condition.minCondition } : {}),
        ...(condition.minProfile ? { minProfile: condition.minProfile } : {}),
        ...(condition.components ? { components: condition.components.map((item) => ({ materialKey: materialKey(item.materialId), quantity: item.quantity })) } : {}),
        meaning: '该实体实际存在且满足所列材料、磨损或结构属性；没有声明的功能不能由名称或这些属性自动推出',
      };
    }
    if (condition.kind === 'near-target' || condition.kind === 'reached-target') return {
      kind: condition.kind, ...targetDescription(condition.target), maxDistance: condition.maxDistance,
      meaning: condition.kind === 'near-target'
        ? '本人当前与对象的剩余间隔满足要求，只证明位置关系'
        : '本计划内本人曾到达指定间隔范围，只证明到访，不证明之后的观察、发言或实际创造',
    };
    const predicate = condition.predicate;
    if (predicate.kind === 'inventory-at-least') return { kind: predicate.kind, ...ownerDescription(predicate.personId),
      materialKey: materialKey(predicate.materialId), quantity: predicate.quantity,
      meaning: '指定持有人实际拥有至少这些材料；附近可见物不算持有，也不说明他人持物' };
    if (predicate.kind === 'voxel-is') return { kind: predicate.kind,
      ...targetDescription({ kind: 'voxel', position: predicate.position }), materialKey: materialKey(predicate.materialId),
      meaning: '指定精确体素实际是该材料，不说明整个设施的几何或功能' };
    if (predicate.kind === 'body-at-least') return { ...predicate, ...ownerDescription(), meaning: '本人当前身体指标达到该值' };
    if (predicate.kind === 'body-at-most') return { kind: predicate.kind, ...ownerDescription(predicate.personId),
      field: predicate.field, value: predicate.value, meaning: '指定人物当前身体指标不高于该值' };
    if (predicate.kind === 'sheltered') return { kind: predicate.kind, ...ownerDescription(),
      meaning: '本人当前身体位置确有可用遮蔽；不证明本人创建了住所、其他人受保护或双方达成共识' };
    if (predicate.kind === 'knowledge') return { kind: predicate.kind, ...ownerDescription(predicate.personId),
      ...referenceDescription('knowledge', predicate.factId), minConfidence: predicate.minConfidence ?? 0,
      meaning: '指定人物持有这条知识记录且置信程度满足要求；不直接证明记录内容真实或外部目标已实现' };
    if (predicate.kind === 'record-held') return { kind: predicate.kind, ...ownerDescription(predicate.personId),
      ...referenceDescription('record', predicate.recordId), meaning: '指定人物实际持有承载该记录的载体，不证明已阅读理解' };
    if (predicate.kind === 'container-inventory-at-least') return { kind: predicate.kind,
      ...targetDescription({ kind: 'container', containerId: predicate.containerId }, 'containerHandle'),
      materialKey: materialKey(predicate.materialId), quantity: predicate.quantity, meaning: '指定容器内实际存有这些材料' };
    if (predicate.kind === 'at-cell') return { kind: predicate.kind, ...ownerDescription(),
      position: { x: cellX(predicate.cellId), y: cellY(predicate.cellId), ...(predicate.z !== undefined ? { z: predicate.z } : {}) },
      meaning: '本人站在指定平面格，只有明确给出z才同时要求高度；不证明后续工作发生' };
    if (predicate.kind === 'near-person') return { kind: predicate.kind,
      ...targetDescription({ kind: 'person', personId: predicate.personId }), meaning: '本人与指定人物达到近身范围，不证明交流或同意' };
    if (predicate.kind === 'condition') return { kind: predicate.kind, ...ownerDescription(predicate.personId),
      condition: predicate.condition, present: predicate.present, ...(predicate.phase ? { phase: predicate.phase } : {}),
      meaning: '指定人物当前的身体状态存在或不存在；给出phase时还要匹配阶段' };
    if (predicate.kind === 'project-completed') return { kind: predicate.kind,
      ...referenceDescription('project', predicate.projectId), meaning: '指定实际项目按自身完成条件结束，不代表其他项目或整段文明已经完成' };
    if (predicate.kind === 'technique-demonstrated') return { kind: predicate.kind,
      ...referenceDescription('project', predicate.projectId), ...referenceDescription('source', predicate.requestEventId, 'requestHandle'),
      meaning: '指定项目已出现针对这次真实请求的技术演示，不等于听者已掌握或跨代传承' };
    if (predicate.kind === 'agreement-status') return {
      kind: predicate.kind, ...referenceDescription('agreement', predicate.agreementId), status: predicate.status,
      meaning: '该真实协议当前处于指定状态；靠近、提议或曾有人回应都不能替代其当前状态，也不证明实际履约',
    };
    if (predicate.kind === 'agreement-response-recorded') return {
      kind: predicate.kind, ...referenceDescription('agreement', predicate.agreementId),
      ...targetDescription({ kind: 'person', personId: predicate.personId }, 'personHandle'), response: predicate.response,
      meaning: '该当事人对这份协议已有明确接受或拒绝记录；历史接受不等于协议目前有效、获得永久授权或已实际履约',
    };
    if (predicate.kind === 'agreement-fulfilled' || predicate.kind === 'agreement-contribution-recorded') return {
      kind: predicate.kind, ...referenceDescription('agreement', predicate.agreementId),
      ...(predicate.kind === 'agreement-contribution-recorded' ? ownerDescription(predicate.personId) : {}),
      meaning: predicate.kind === 'agreement-fulfilled' ? '指定协议已有实际履行结果，不是只有提议或接近当事人'
        : '指定当事人的协议贡献已被实际记录，不证明其他人已完成其部分',
    };
    if (predicate.kind === 'death-mourned' || predicate.kind === 'remains-interred' || predicate.kind === 'memorial-marked') return {
      kind: predicate.kind, ...targetDescription({ kind: 'remains', remainsId: predicate.remainsId }),
      meaning: predicate.kind === 'death-mourned' ? '对这具遗体的悼念行为已被实际记录'
        : predicate.kind === 'remains-interred' ? '这具遗体已实际安葬' : '这具遗体已有实际纪念标记',
    };
    if (predicate.kind === 'record-replication-receipt') return { kind: predicate.kind, ...ownerDescription(predicate.readerId),
      ...referenceDescription('project', predicate.projectId), ...referenceDescription('record', predicate.recordId),
      ...referenceDescription('technique', predicate.techniqueId), recordVersion: predicate.recordVersion,
      outputMaterialKey: materialKey(predicate.expectedOutputMaterialId),
      meaning: '读者基于指定版本的他人记录完成了该项目的实际复现，并有领域回执；拿到或阅读记录本身不足以满足',
    };
    if (predicate.kind === 'representation-made') return { kind: predicate.kind,
      ...referenceDescription('agreement', predicate.representationId, 'statementHandle'),
      meaning: '指定表示已经实际作出，不证明他人同意、理解或履行；引用不可解析时具体表示含义未知',
    };
    return { kind: (predicate as FactPredicate).kind, meaning: '本轮尚不能明确解释的已绑定条件，语义覆盖程度保持未验证' };
  };
  return Object.fromEntries((['step', 'goal'] as const).map((kind) => [kind, {
    description: completion[kind].description,
    conditions: completion[kind].conditions.map(describe),
    ...(completion[kind].meaningReview ? { meaningReview: structuredClone(completion[kind].meaningReview) } : {}),
  }]));
}
