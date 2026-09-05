import type { ActionCompletionPolicy, ActionOption, FactPredicate, Intent, PrimitiveAction, RecordUseBasis, RecordUseStage, RelationshipCausalBasis, WorldRef } from './action';
import type { ProjectProposal } from './project';
import { followUpSemanticallyMatches } from './intent-follow-up';
import { actionOptionSemantics } from './action-option-semantics';
import type { MentalPlanTranslation, PlanCompletionAssessment, PlanSuccessCondition } from './mental-act';

function sameRef(left: WorldRef, right: WorldRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'voxel' && right.kind === 'voxel') return left.position.x === right.position.x
    && left.position.y === right.position.y && left.position.z === right.position.z;
  return Object.entries(left).every(([key, value]) => value === (right as unknown as Record<string, unknown>)[key]);
}

/** A satisfied prerequisite cannot stand in for the selected operation's outcome. */
export function completionConditionsCoverAction(
  conditions: readonly PlanSuccessCondition[],
  action: PrimitiveAction,
  ownerId: string,
): boolean {
  const inventoryCovered = (materialId: number, personId = ownerId) => conditions.some((condition) => condition.kind === 'fact'
    && condition.predicate.kind === 'inventory-at-least'
    && condition.predicate.materialId === materialId && (condition.predicate.personId ?? ownerId) === personId);
  const movementCovered = (target: WorldRef, distance: number) => conditions.some((condition) => (
    (condition.kind === 'near-target' || condition.kind === 'reached-target')
      && sameRef(condition.target, target) && condition.maxDistance <= distance
  ));
  if (action.kind === 'move') return conditions.some((condition) => condition.kind === 'fact'
    && condition.predicate.kind === 'at-cell' && condition.predicate.cellId === action.toCellId);
  if (action.kind === 'transfer') return action.to.kind === 'person' && inventoryCovered(action.materialId, action.to.personId);
  if (action.kind === 'talk') return conditions.some((condition) => condition.kind === 'fact'
    && condition.predicate.kind === 'representation-made' && condition.predicate.representationId === action.speakerMeaning.id);
  if (action.kind !== 'world-interact') return false;
  const effects = action.adjudication.effects;
  const materialResults = effects.filter((effect) => !['move-self', 'consume', 'knowledge'].includes(effect.kind));
  if (!materialResults.length) return effects.length > 0
    && effects.every((effect) => effect.kind === 'move-self' && movementCovered(effect.target, effect.withinDistance ?? 2));
  // Travel and input consumption serve these results; a location check alone
  // never covers producing, assembling, changing a body, or a social act.
  return materialResults.every((effect) => {
    if (effect.kind === 'produce') return effect.destination === 'inventory' && inventoryCovered(effect.materialId);
    if (effect.kind === 'assemble' || effect.kind === 'modify-structure') return conditions.some((condition) => (
      condition.kind === 'work-state' && condition.target.kind !== 'produced-work'
        && sameRef(condition.target, effect.target)
    ));
    if (effect.kind === 'replace-voxel') return conditions.some((condition) => condition.kind === 'fact'
      && condition.predicate.kind === 'voxel-is' && condition.predicate.materialId === effect.materialId
      && sameRef({ kind: 'voxel', position: condition.predicate.position }, effect.target));
    if (effect.kind === 'body') return conditions.some((condition) => {
      if (condition.kind !== 'fact') return false;
      const predicate = condition.predicate;
      return effect.delta >= 0 && predicate.kind === 'body-at-least' && predicate.field === effect.field
        && (effect.target?.personId ?? ownerId) === ownerId;
    });
    return false;
  });
}

export function completionConditionsCoverIntent(conditions: readonly PlanSuccessCondition[], intent: Intent): boolean {
  return completionConditionsCoverAction(conditions, intent.completionAction ?? intent.nextAction, intent.ownerId);
}

/** Empty or absent checks remain unknown; performing an action is not proof. */
export function assessPlanCompletion(
  plan: MentalPlanTranslation | undefined,
  satisfies: (condition: PlanSuccessCondition) => boolean,
  previous?: PlanCompletionAssessment,
): PlanCompletionAssessment {
  const satisfiedConditionIds: string[] = [];
  const assess = (scope: 'step' | 'goal'): PlanCompletionAssessment['step'] => {
    const conditions = plan?.completion?.[scope].conditions ?? [];
    if (!conditions.length) return 'unverified';
    const satisfied = conditions.map((condition, index) => {
      const result = satisfies(condition);
      if (result) satisfiedConditionIds.push(`${scope}:${index}`);
      return result;
    });
    return satisfied.every(Boolean) ? 'satisfied' : 'unmet';
  };
  const step = assess('step');
  const goal = assess('goal');
  const before = new Set(previous?.satisfiedConditionIds ?? []);
  const after = new Set(satisfiedConditionIds);
  return {
    step, goal, satisfiedConditionIds,
    ...(plan?.completion ? { checked: structuredClone(plan.completion) } : {}),
    changedConditionIds: previous
      ? [...new Set([...before, ...after])].filter((id) => before.has(id) !== after.has(id))
      : [],
  };
}

export interface IntentChoice {
  summary: string;
  domain: Intent['domain'];
  goal: FactPredicate;
  openingAction?: PrimitiveAction;
  nextAction: PrimitiveAction;
  completionAction?: PrimitiveAction;
  target?: WorldRef;
  estimatedDuration: ActionOption['estimatedDuration'];
  estimatedMonths?: number;
  completionPolicy?: ActionCompletionPolicy;
  sourceFactIds: string[];
  projectId?: string;
  characterAgendaItemId?: string;
  characterAgendaApproachId?: string;
  projectProposal?: ProjectProposal;
  relationshipBasis?: RelationshipCausalBasis;
  recordUseBasis?: RecordUseBasis;
  recordUseStage?: RecordUseStage;
}

/**
 * Long-lived intent chains can be suspended for a short obligation and later
 * resumed without losing their identity or progress.
 */
export function isResumableIntent(
  intent: Pick<Intent,
    | 'lifecycle'
    | 'projectId'
    | 'recordUseBasis'
    | 'returnToIntentId'
    | 'stateGoalUntilMonth'
    | 'characterAgendaItemId'
    | 'plan'>,
): boolean {
  return Boolean(intent.projectId
    || intent.recordUseBasis
    || intent.returnToIntentId
    || intent.lifecycle
    || intent.characterAgendaItemId
    || (intent.plan?.steps.length ?? 0) > 1
    || intent.stateGoalUntilMonth !== undefined);
}

/** New lifecycle wins; stateGoalUntilMonth is a compatibility fallback for old snapshots. */
export function intentReviewAtMonth(
  intent: Pick<Intent, 'lifecycle' | 'stateGoalUntilMonth'>,
): number | undefined {
  return intent.lifecycle?.reviewAtMonth ?? intent.stateGoalUntilMonth;
}

/** Only explicit maintenance, or a legacy state goal without lifecycle, keeps an achieved intent open. */
export function intentMaintainUntilMonth(
  intent: Pick<Intent, 'lifecycle' | 'stateGoalUntilMonth'>,
): number | undefined {
  if (intent.lifecycle) {
    return intent.lifecycle.completion === 'maintain-state'
      ? intent.lifecycle.maintainUntilMonth ?? intent.lifecycle.reviewAtMonth
      : undefined;
  }
  return intent.stateGoalUntilMonth;
}

function compositeDomain(selected: ActionOption, followUp: ActionOption): Intent['domain'] {
  const conversationalOpening = actionOptionSemantics(selected).conversation?.turn === 'opening';
  return conversationalOpening ? followUp.domain ?? 'strategic' : 'social';
}

/**
 * Dialogue is complete on its own. A person may explicitly choose to speak
 * and then perform a physical step; the second step supplies the embodied
 * goal. Legacy required continuations retain their protocol-specific checks.
 */
export function composeIntentChoice(
  options: ActionOption[],
  followUpOptions: ActionOption[],
  optionId: string,
  followUpOptionId?: string,
): IntentChoice | null {
  const selected = options.find((option) => option.id === optionId);
  if (!selected) return null;

  if (!selected.requiresFollowUp && followUpOptionId === undefined) {
    return {
      summary: selected.summary,
      domain: selected.domain ?? 'strategic',
      goal: structuredClone(selected.goal),
      nextAction: structuredClone(selected.nextAction),
      ...(selected.completionAction ? { completionAction: structuredClone(selected.completionAction) } : {}),
      ...(selected.target ? { target: structuredClone(selected.target) } : {}),
      estimatedDuration: selected.estimatedDuration,
      ...(selected.estimatedMonths !== undefined ? { estimatedMonths: selected.estimatedMonths } : {}),
      ...(selected.completionPolicy ? { completionPolicy: structuredClone(selected.completionPolicy) } : {}),
      sourceFactIds: [...selected.sourceFactIds],
      ...(selected.projectId ? { projectId: selected.projectId } : {}),
      ...(selected.characterAgendaItemId ? { characterAgendaItemId: selected.characterAgendaItemId } : {}),
      ...(selected.characterAgendaApproachId ? { characterAgendaApproachId: selected.characterAgendaApproachId } : {}),
      ...(selected.projectProposal ? { projectProposal: structuredClone(selected.projectProposal) } : {}),
      ...(selected.relationshipBasis ? { relationshipBasis: structuredClone(selected.relationshipBasis) } : {}),
      ...(selected.recordUseBasis ? { recordUseBasis: structuredClone(selected.recordUseBasis) } : {}),
      ...(selected.recordUseStage ? { recordUseStage: selected.recordUseStage } : {}),
    };
  }

  const followUp = followUpOptions.find((option) => option.id === followUpOptionId);
  if (!followUp) return null;
  const explicitlyChosenChain = !selected.requiresFollowUp;
  if (explicitlyChosenChain) {
    // This is the speaker's own next step, never an inferred response or a
    // second speech act hidden behind a movement prefix. Its physical and
    // permission requirements are revalidated by the normal action executor.
    if (selected.nextAction.kind !== 'talk'
      || selected.completionAction
      || followUp.requiresFollowUp
      || followUp.nextAction.kind === 'talk'
      || followUp.completionAction?.kind === 'talk') return null;
  } else if (!followUpSemanticallyMatches(selected, followUp)) return null;
  return {
    summary: `${selected.summary}，随后${followUp.summary}`,
    domain: explicitlyChosenChain ? followUp.domain ?? 'strategic' : compositeDomain(selected, followUp),
    goal: structuredClone(followUp.goal),
    openingAction: structuredClone(selected.nextAction),
    nextAction: structuredClone(followUp.nextAction),
    ...(followUp.completionAction ? { completionAction: structuredClone(followUp.completionAction) } : {}),
    ...(followUp.target ? { target: structuredClone(followUp.target) } : {}),
    estimatedDuration: followUp.estimatedDuration,
    ...(followUp.estimatedMonths !== undefined ? { estimatedMonths: followUp.estimatedMonths } : {}),
    ...(followUp.completionPolicy ? { completionPolicy: structuredClone(followUp.completionPolicy) } : {}),
    sourceFactIds: [...new Set([...selected.sourceFactIds, ...followUp.sourceFactIds])],
    ...(followUp.projectId ? { projectId: followUp.projectId } : {}),
    ...(followUp.characterAgendaItemId ? { characterAgendaItemId: followUp.characterAgendaItemId } : {}),
    ...(followUp.characterAgendaApproachId ? { characterAgendaApproachId: followUp.characterAgendaApproachId } : {}),
    ...(followUp.projectProposal ? { projectProposal: structuredClone(followUp.projectProposal) } : {}),
    ...(explicitlyChosenChain
      ? followUp.relationshipBasis ? { relationshipBasis: structuredClone(followUp.relationshipBasis) } : {}
      : selected.relationshipBasis ? { relationshipBasis: structuredClone(selected.relationshipBasis) } : {}),
    ...(followUp.recordUseBasis
      ? { recordUseBasis: structuredClone(followUp.recordUseBasis) }
      : !explicitlyChosenChain && selected.recordUseBasis
        ? { recordUseBasis: structuredClone(selected.recordUseBasis) }
        : {}),
    ...(followUp.recordUseStage
      ? { recordUseStage: followUp.recordUseStage }
      : !explicitlyChosenChain && selected.recordUseStage
        ? { recordUseStage: selected.recordUseStage }
        : {}),
  };
}
