import type { ActionCompletionPolicy, ActionOption, FactPredicate, Intent, PrimitiveAction, RecordUseBasis, RecordUseStage, RelationshipCausalBasis, WorldRef } from './action';
import type { ProjectProposal } from './project';
import { followUpSemanticallyMatches } from './intent-follow-up';
import { actionOptionSemantics } from './action-option-semantics';

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
 * A plain dialogue is an opening action, not a terminal goal. The same model
 * decision must pair it with one engine-provided, executable follow-up option.
 */
export function composeIntentChoice(
  options: ActionOption[],
  followUpOptions: ActionOption[],
  optionId: string,
  followUpOptionId?: string,
): IntentChoice | null {
  const selected = options.find((option) => option.id === optionId);
  if (!selected) return null;

  if (!selected.requiresFollowUp) {
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
  if (!followUp || !followUpSemanticallyMatches(selected, followUp)) return null;
  return {
    summary: `${selected.summary}，随后${followUp.summary}`,
    domain: compositeDomain(selected, followUp),
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
    ...(selected.relationshipBasis ? { relationshipBasis: structuredClone(selected.relationshipBasis) } : {}),
    ...(followUp.recordUseBasis
      ? { recordUseBasis: structuredClone(followUp.recordUseBasis) }
      : selected.recordUseBasis
        ? { recordUseBasis: structuredClone(selected.recordUseBasis) }
        : {}),
    ...(followUp.recordUseStage
      ? { recordUseStage: followUp.recordUseStage }
      : selected.recordUseStage
        ? { recordUseStage: selected.recordUseStage }
        : {}),
  };
}
