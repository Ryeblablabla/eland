import type { Intent, IntentOutcomeReceipt, PlanPreflightReceipt, PrimitiveAction, WorldRef } from '../../domain/action';
import { goalSatisfied } from '../../domain/action-executor';
import { assessPlanCompletion } from '../../domain/intent';
import type { PlanCompletionAssessment, PlanMilestoneReceipt, PlanSuccessCondition } from '../../domain/mental-act';
import type { ActionFact, DecisionAuthorityState } from '../../domain/model';
import type { PersonState } from '../../domain/person';
import { intentsOwnedBy, personById } from '../../domain/state-index';
import { WORK_COLLAPSE_CONDITION, workAt, workById } from '../../domain/works';
import { workOccupiedVoxels } from '../../domain/work-layout';
import { cellX, cellY, voxelAt } from '../../world/grid';

function targetDistance(state: DecisionAuthorityState, person: PersonState, target: WorldRef): number | undefined {
  const position = refPosition(state, target);
  return position ? Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y)
    + Math.max(0, Math.abs(person.position.z - position.z) - 1) : undefined;
}

function satisfiesCondition(
  state: DecisionAuthorityState,
  person: PersonState,
  intent: Intent,
  condition: PlanSuccessCondition,
): boolean {
  if (condition.kind === 'fact') return goalSatisfied(state, person, condition.predicate);
  if (condition.kind === 'near-target' || condition.kind === 'reached-target') {
    const distance = targetDistance(state, person, condition.target);
    return (distance !== undefined && distance <= condition.maxDistance)
      || (condition.kind === 'reached-target' && (intent.planMilestones ?? [])
        .some((receipt) => sameReachedCondition(receipt.condition, condition)));
  }
  const target = condition.target;
  const work = target.kind === 'work'
    ? workById(state.world, target.workId)
    : target.kind === 'voxel' ? workAt(state.world, target.position) : undefined;
  if (!workPhysicallyExists(state, work)) return false;
  if (condition.minCondition !== undefined && work.condition < condition.minCondition) return false;
  if (condition.minProfile && Object.entries(condition.minProfile).some(([field, value]) => (
    work.profile[field as keyof typeof work.profile] < value
  ))) return false;
  return (condition.components ?? []).every((expected) => work.components
    .filter((component) => component.materialId === expected.materialId)
    .reduce((sum, component) => sum + component.quantity, 0) >= expected.quantity);
}

function workPhysicallyExists(
  state: DecisionAuthorityState,
  work: ReturnType<typeof workById>,
): work is NonNullable<ReturnType<typeof workById>> {
  return Boolean(work && work.condition >= WORK_COLLAPSE_CONDITION
    && voxelAt(state.world.grid, work.position.x, work.position.y, work.position.z) === work.anchorMaterialId);
}

function refPosition(state: DecisionAuthorityState, ref: WorldRef): { x: number; y: number; z: number } | undefined {
  if (ref.kind === 'voxel') return ref.position;
  if ('workId' in ref) {
    const work = workById(state.world, String(ref.workId));
    return workPhysicallyExists(state, work) ? work.position : undefined;
  }
  if (ref.kind === 'inventory-stack') {
    const owner = personById(state, ref.personId);
    if (!owner?.inventory.some((stack) => stack.id === ref.stackId && stack.quantity > 0)) return undefined;
  }
  const position = ref.kind === 'person' || ref.kind === 'inventory-stack'
    ? personById(state, ref.personId)?.position
    : ref.kind === 'drop' ? state.world.drops.find((drop) => drop.id === ref.dropId && drop.quantity > 0)
      : ref.kind === 'animal' ? state.world.animals.find((animal) => animal.id === ref.animalId && animal.diedAtMonth === undefined)?.position
        : ref.kind === 'remains' ? state.world.remains?.find((remains) => remains.id === ref.remainsId)?.position
          : undefined;
  if (ref.kind === 'container') return state.containers.find((container) => container.id === ref.containerId)?.position;
  return position ? { x: cellX(position.cellId), y: cellY(position.cellId), z: position.z } : undefined;
}

export function assessIntentPlan(
  state: DecisionAuthorityState,
  person: PersonState,
  intent: Intent,
  previous?: PlanCompletionAssessment,
): PlanCompletionAssessment {
  return assessPlanCompletion(intent.plan, (condition) => satisfiesCondition(state, person, intent, condition), previous);
}

type ReachedCondition = Extract<PlanSuccessCondition, { kind: 'reached-target' }>;
type ObservedArrival = Pick<PlanMilestoneReceipt, 'condition' | 'distance'>;

function sameReachedCondition(left: ReachedCondition, right: ReachedCondition): boolean {
  return left.maxDistance === right.maxDistance
    && JSON.stringify(canonical(left.target)) === JSON.stringify(canonical(right.target));
}

/** Only explicit arrival milestones survive; all present-tense checks stay live. */
function observedPlanArrivals(state: DecisionAuthorityState, person: PersonState, intent?: Intent): ObservedArrival[] {
  const completion = intent?.plan?.completion;
  if (!completion) return [];
  const observations: ObservedArrival[] = [];
  for (const condition of [...completion.step.conditions, ...completion.goal.conditions]) {
    if (condition.kind !== 'reached-target') continue;
    const distance = targetDistance(state, person, condition.target);
    if (distance !== undefined && distance <= condition.maxDistance
      && !observations.some((entry) => sameReachedCondition(entry.condition, condition))) {
      observations.push({ condition: structuredClone(condition), distance });
    }
  }
  return observations;
}

function appendPlanArrivals(intent: Intent, observations: ObservedArrival[], sourceEventId: string, atMonth: number): void {
  for (const observed of observations) {
    if ((intent.planMilestones ?? []).some((entry) => sameReachedCondition(entry.condition, observed.condition))) continue;
    (intent.planMilestones ??= []).push({ ...structuredClone(observed), sourceEventId, atMonth });
  }
}

/** A newly selected plan may already begin at its chosen destination. */
export function recordObservedPlanMilestones(
  state: DecisionAuthorityState,
  person: PersonState,
  intent: Intent,
  sourceEventId: string,
  atMonth: number,
): void {
  appendPlanArrivals(intent, observedPlanArrivals(state, person, intent), sourceEventId, atMonth);
}

/** Resolve a newly built thing from the actual receipt, never its description or moving surface. */
export function bindProducedPlanWork(state: DecisionAuthorityState, intent: Intent, fact: ActionFact): void {
  if (!intent.plan?.completion || !Array.isArray(fact.diff.appliedEffects)) return;
  const workIds = fact.diff.appliedEffects.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const effect = value as Record<string, unknown>;
    return (effect.kind === 'assemble' || effect.kind === 'modify-structure')
      && typeof effect.workId === 'string' && workById(state.world, effect.workId) ? [effect.workId] : [];
  });
  if (!workIds.length) return;
  for (const check of [intent.plan.completion.step, intent.plan.completion.goal]) {
    for (const condition of check.conditions) {
      if (condition.kind === 'work-state' && condition.target.kind === 'produced-work') {
        condition.target = { kind: 'work', workId: workIds[0] };
      }
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
}

function fingerprint(value: unknown): string {
  const input = JSON.stringify(canonical(value));
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  return `${input.length}:${(hash >>> 0).toString(16)}`;
}

export function recordPlanPreflight(
  intent: Intent,
  reason: PlanPreflightReceipt['reason'],
  conditions: PlanSuccessCondition[],
  assessment: PlanCompletionAssessment,
  atMonth: number,
): void {
  intent.planPreflight = {
    atMonth, sourceDecisionEventId: intent.sourceDecisionEventId, reason,
    summary: `执行前已核对所需成果，跳过本次操作；本次没有执行${intent.summary}`,
    conditionKey: fingerprint(conditions),
    checkedConditions: structuredClone(conditions),
    planAssessment: structuredClone(assessment),
    selectedAction: structuredClone(intent.completionAction ?? intent.nextAction),
  };
}

/** Equivalent already-achieved results are one planning input, even after retranslation. */
export function planPreflightOutcomeKey(intent: Intent): string | undefined {
  return intent.planPreflight
    ? `${intent.ownerId}:${intent.planSourceDecisionEventId ?? intent.sourceDecisionEventId}:preflight:${intent.planPreflight.conditionKey}`
    : undefined;
}

function refsFor(action: PrimitiveAction): WorldRef[] {
  if (action.kind === 'world-interact') return [...new Map([
    ...action.adjudication.targets,
    ...action.adjudication.effects.flatMap((effect) => 'target' in effect && effect.target ? [effect.target] : []),
  ].map((target) => [JSON.stringify(canonical(target)), target])).values()];
  if (action.kind === 'attend') return [action.target];
  if (action.kind === 'act') return action.targets;
  return [];
}

function operationFor(action: PrimitiveAction): unknown {
  if (action.kind === 'world-interact') return {
    kind: action.kind,
    targets: [...action.adjudication.targets].sort((left, right) => JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right)))),
    effects: action.adjudication.effects.filter((effect) => effect.kind !== 'knowledge').map((effect) => {
      const { summary: _prose, ...physicalEffect } = effect as typeof effect & { summary?: string };
      return physicalEffect;
    }),
  };
  if (action.kind === 'move') return { kind: action.kind, toCellId: action.toCellId, toZ: action.toZ };
  if (action.kind === 'act') return { kind: action.kind, operation: action.operation, targets: action.targets, toolStackId: action.toolStackId };
  return action;
}

function inventoryOf(person: PersonState) {
  return person.inventory.filter((stack) => stack.quantity > 0)
    .map((stack) => ({ id: stack.id, materialId: stack.materialId, quantity: stack.quantity }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function surroundingVoxels(state: DecisionAuthorityState, x: number, y: number, z: number): number[] {
  const voxels: number[] = [];
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
    for (let dz = -1; dz <= 2; dz += 1) voxels.push(voxelAt(state.world.grid, x + dx, y + dy, z + dz));
  }
  return voxels;
}

function targetSnapshot(state: DecisionAuthorityState, ref: WorldRef): unknown {
  if (ref.kind === 'voxel') return {
    ref, materialId: voxelAt(state.world.grid, ref.position.x, ref.position.y, ref.position.z),
    neighborhood: surroundingVoxels(state, ref.position.x, ref.position.y, ref.position.z),
    work: physicalWorkSnapshot(state, workAt(state.world, ref.position)),
  };
  if ('workId' in ref) return { ref, work: physicalWorkSnapshot(state, workById(state.world, String(ref.workId))) };
  if (ref.kind === 'person') {
    const person = personById(state, ref.personId);
    return { ref, position: person ? { cellId: person.position.cellId, z: person.position.z } : null, alive: person?.diedAtMonth === undefined };
  }
  if (ref.kind === 'inventory-stack') {
    const stack = personById(state, ref.personId)?.inventory.find((candidate) => candidate.id === ref.stackId);
    return { ref, materialId: stack?.materialId, quantity: stack?.quantity ?? 0 };
  }
  if (ref.kind === 'drop') {
    const drop = state.world.drops.find((candidate) => candidate.id === ref.dropId);
    return { ref, materialId: drop?.materialId, quantity: drop?.quantity ?? 0, cellId: drop?.cellId, z: drop?.z };
  }
  if (ref.kind === 'animal') {
    const animal = state.world.animals.find((candidate) => candidate.id === ref.animalId);
    return { ref, position: animal?.position, alive: animal?.diedAtMonth === undefined };
  }
  return { ref };
}

function physicalWorkSnapshot(state: DecisionAuthorityState, work: ReturnType<typeof workById>) {
  return work ? { id: work.id, position: work.position, arrangement: work.arrangement,
    condition: work.condition, components: work.components, profile: work.profile,
    layout: work.layout,
    occupiedVoxels: workOccupiedVoxels(work).map((part) => ({ ...part,
      actualMaterialId: voxelAt(state.world.grid, part.position.x, part.position.y, part.position.z),
    })),
  } : null;
}

export interface PlanAttemptSnapshot {
  operationKey: string;
  premiseKey: string;
  observedArrivals?: ObservedArrival[];
}

/** Only causal inputs count as changed premises; paraphrases and new event IDs do not. */
export function capturePlanAttempt(state: DecisionAuthorityState, person: PersonState, action: PrimitiveAction, intent?: Intent): PlanAttemptSnapshot {
  const resourceAction = action.kind === 'transfer' || action.kind === 'act'
    || (action.kind === 'world-interact' && action.adjudication.effects.some((effect) => (
      ['consume', 'produce', 'relocate', 'assemble', 'modify-structure'].includes(effect.kind)
    )));
  const bodyAction = action.kind === 'act' || (action.kind === 'world-interact'
    && action.adjudication.effects.some((effect) => effect.kind === 'body'));
  const position = { cellId: person.position.cellId, z: person.position.z };
  return {
    ...(intent ? { observedArrivals: observedPlanArrivals(state, person, intent) } : {}),
    operationKey: fingerprint(operationFor(action)),
    premiseKey: fingerprint({
      position,
      neighborhood: surroundingVoxels(state, cellX(position.cellId), cellY(position.cellId), position.z),
      ...(resourceAction ? { inventory: inventoryOf(person) } : {}),
      ...(resourceAction ? {
        localMaterials: state.world.drops.filter((drop) => drop.quantity > 0
          && Math.abs(cellX(drop.cellId) - cellX(position.cellId)) <= 1
          && Math.abs(cellY(drop.cellId) - cellY(position.cellId)) <= 1)
          .map(({ id, materialId, quantity, cellId, z }) => ({ id, materialId, quantity, cellId, z }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        localWorks: (state.world.works ?? []).filter((work) => Math.abs(work.position.x - cellX(position.cellId)) <= 2
          && Math.abs(work.position.y - cellY(position.cellId)) <= 2)
          .map((work) => physicalWorkSnapshot(state, work)),
      } : {}),
      ...(bodyAction ? { body: person.body, conditions: person.conditions.map(({ kind, stage }) => ({ kind, stage })) } : {}),
      targets: refsFor(action).map((target) => targetSnapshot(state, target)),
      ...(action.kind === 'move' ? { destination: surroundingVoxels(state, cellX(action.toCellId), cellY(action.toCellId), action.toZ ?? person.position.z) } : {}),
    }),
  };
}

function priorPlanAttempt(state: DecisionAuthorityState, person: PersonState, snapshot: PlanAttemptSnapshot): IntentOutcomeReceipt | undefined {
  for (const intent of [...intentsOwnedBy(state, person.id)].reverse()) {
    const receipt = [...(intent.outcomeReceipts ?? [])].reverse().find((candidate) => candidate.attempt?.operationKey === snapshot.operationKey);
    if (receipt) return receipt;
  }
  return undefined;
}

export function attachPlanAttemptReceipt(
  state: DecisionAuthorityState,
  person: PersonState,
  intent: Intent,
  fact: ActionFact,
  receipt: IntentOutcomeReceipt,
  before: PlanAttemptSnapshot,
  assessmentBefore: PlanCompletionAssessment,
): void {
  const previous = priorPlanAttempt(state, person, before);
  const after = capturePlanAttempt(state, person, fact.action, intent);
  appendPlanArrivals(intent, [...(before.observedArrivals ?? []), ...(after.observedArrivals ?? [])], fact.id, fact.atMonth);
  bindProducedPlanWork(state, intent, fact);
  receipt.planAssessment = assessIntentPlan(state, person, intent, assessmentBefore);
  intent.planAssessment = structuredClone(receipt.planAssessment);
  receipt.attempt = {
    operationKey: before.operationKey,
    premiseKey: before.premiseKey,
    worldChanged: before.premiseKey !== after.premiseKey,
    repetition: !previous ? 'new'
      : previous.attempt?.premiseKey !== before.premiseKey ? 'changed-premises'
        : previous.attempt.worldChanged || before.premiseKey !== after.premiseKey ? 'new' : 'unchanged-retry',
    ...(previous ? { previousEventId: previous.actionEventId } : {}),
  };
  if (receipt.planAssessment.goal === 'satisfied') receipt.goalProgress = 'achieved';
  else if (receipt.planAssessment.changedConditionIds.length) {
    const satisfiedBefore = new Set(assessmentBefore.satisfiedConditionIds);
    receipt.goalProgress = receipt.planAssessment.satisfiedConditionIds.some((id) => !satisfiedBefore.has(id))
      ? 'advanced' : 'regressed';
  }
  const newMilestones = intent.planMilestones?.filter((milestone) => milestone.sourceEventId === fact.id);
  if (newMilestones?.length) {
    receipt.planMilestones = structuredClone(newMilestones);
    fact.diff.planMilestones = structuredClone(newMilestones);
  }
  if (!receipt.attempt.worldChanged && fact.action.kind === 'world-interact') {
    // A fresh sentence about an unchanged scene is not new observed evidence.
    receipt.evidence = receipt.planAssessment.changedConditionIds.length ? 'confirming' : 'none';
  }
  fact.diff.planAssessment = structuredClone(receipt.planAssessment);
  fact.diff.attempt = structuredClone(receipt.attempt);
  // Keep the executor's actual reason (occupied position, missing material,
  // absent route, etc.). The structured assessment adds context without
  // replacing the very evidence that the next Plan needs to change its means.
}
