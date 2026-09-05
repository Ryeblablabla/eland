import type { FactPredicate, WorldRef } from '../../domain/action';
import { MATERIAL_PALETTE } from '../../domain/material';
import type { MentalPlanTranslation, PlanCompletionCheck, PlanSuccessCondition } from '../../domain/mental-act';
import type { DecisionProbeHandleMap } from './capability-handles';
import type { DecisionRequestContext } from './decision-context';

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
      || target.kind === 'container' && item.kind === 'container' && item.containerId === target.containerId)?.handle;
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
      };
    }
    if (condition.kind === 'near-target' || condition.kind === 'reached-target') return { kind: condition.kind, targetHandle: handleFor(condition.target), maxDistance: condition.maxDistance };
    const predicate = condition.predicate;
    if (predicate.kind === 'inventory-at-least') return { kind: predicate.kind, materialKey: materialKey(predicate.materialId), quantity: predicate.quantity };
    if (predicate.kind === 'voxel-is') return { kind: predicate.kind, targetHandle: handleFor({ kind: 'voxel', position: predicate.position }), materialKey: materialKey(predicate.materialId) };
    if (predicate.kind === 'body-at-least' || predicate.kind === 'sheltered') return predicate;
    return { kind: predicate.kind, description: '其他已绑定的现实条件，以真实执行回执中的判定为准' };
  };
  return Object.fromEntries((['step', 'goal'] as const).map((kind) => [kind, {
    description: completion[kind].description,
    conditions: completion[kind].conditions.map(describe),
  }]));
}
