import type { PrimitiveAction } from '../action';
import { materialDefinition } from '../material';
import { bendMaterialPortion, handBendLoad, materialBendProfile, perceivedMechanicalCondition } from '../material-mechanics';
import type { PersonState } from '../person';
import { boundedItemSourceEventIds } from './inventory';

/** The unary held/no-tool exert atom means bending one held material portion. */
export function executeHeldBend(
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const target = action.targets[0];
  if (action.operation !== 'exert' || action.targets.length !== 1 || action.toolStackId
    || target?.kind !== 'inventory-stack' || target.personId !== person.id) return {
    status: 'blocked' as const, result: '徒手弯曲需要点名一份本人持物，不使用工具或地表代替', diff: {},
  };
  const stack = person.inventory.find((candidate) => candidate.id === target.stackId && candidate.quantity > 0);
  if (!stack) return { status: 'blocked' as const, result: '点名的本人持物已经不存在或已耗尽，未开始弯曲', diff: {} };
  const material = materialDefinition(stack.materialId);
  const profile = materialBendProfile(stack.materialId);
  if (!profile) return { status: 'blocked' as const,
    result: `${material.name}目前没有可用于这次徒手弯曲的连续物体形态或力学参数，未执行弯曲`,
    diff: { heldBendUnsupported: true, stackId: stack.id, materialId: stack.materialId } };
  const load = handBendLoad({ manipulation: person.baselineCapacities.manipulation,
    ...person.body, conditions: person.conditions });
  if (load <= 0) return { status: 'blocked' as const, result: '本人当前不能向这份物品施加载荷，未开始弯曲', diff: {} };
  const response = bendMaterialPortion(profile, stack.mechanicalState, load, eventId);
  let affected = stack;
  if (stack.quantity > 1) {
    stack.quantity -= 1;
    affected = { ...structuredClone(stack), id: `stack-bent-${eventId}`, quantity: 1 };
    person.inventory.push(affected);
  }
  affected.mechanicalState = response.after;
  affected.sourceEventIds = boundedItemSourceEventIds([...affected.sourceEventIds, eventId]);
  affected.sourceLineageKeys = [...new Set([...(affected.sourceLineageKeys ?? []), `inventory:${person.id}:${target.stackId}`])].slice(-32);
  const condition = perceivedMechanicalCondition(response.after)!;
  const visiblyBent = response.peakDisplacement
    / (response.before.geometry.length * response.before.segments[response.segmentIndex].massFraction) >= 0.02;
  const movement = response.fractured ? '受力的部分发生断裂'
    : visiblyBent ? response.residualIncrement > 1e-6 ? '受力时弯曲，放松后只恢复了一部分' : '受力时弯曲，放松后恢复原形'
      : '感觉到物品抵抗弯曲，没有看出明显形变';
  const result = `本人用双手弯曲这一份${material.name}，${movement}；${condition.summary}`;
  const factId = `observation:held-bend:${affected.id}`;
  const known = person.knowledge.find((fact) => fact.id === factId);
  if (known) {
    known.summary = result;
    known.sourceEventIds = boundedItemSourceEventIds([...known.sourceEventIds, eventId]);
  } else person.knowledge.push({ id: factId, kind: 'observation', summary: result, confidence: 68,
    learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  // This is one ordinary act episode. The response records mechanical work;
  // it does not independently debit the monthly body/effort budget again.
  return { status: 'completed' as const, result, diff: {
    heldBend: true, factId, materialId: stack.materialId, inputStackId: target.stackId,
    affectedStackId: affected.id, affectedQuantity: 1, materialPortionsBefore: 1, materialPortionsAfter: 1,
    materialMassBefore: material.mass, materialMassAfter: material.mass,
    mechanicalResponse: response, mechanicalCondition: condition, sourceEventIds: [eventId],
  } };
}
