import type { ActionOption, FactPredicate, Intent, PrimitiveAction, RecordUseBasis, RecordUseStage, RelationshipCausalBasis, WorldRef } from './action';
import type { ProjectProposal } from './project';
import { followUpSemanticallyMatches } from './intent-follow-up';

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
  sourceFactIds: string[];
  projectId?: string;
  projectProposal?: ProjectProposal;
  relationshipBasis?: RelationshipCausalBasis;
  recordUseBasis?: RecordUseBasis;
  recordUseStage?: RecordUseStage;
}

function compositeDomain(selected: ActionOption, followUp: ActionOption): Intent['domain'] {
  const action = selected.nextAction;
  const conversationalOpening = (selected.id.startsWith('talk:') || selected.id.startsWith('conversation:'))
    && action.kind === 'communicate'
    && action.content.kind === 'claim'
    && (!action.content.conversation || action.content.conversation.turn === 'opening');
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
      sourceFactIds: [...selected.sourceFactIds],
      ...(selected.projectId ? { projectId: selected.projectId } : {}),
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
    sourceFactIds: [...new Set([...selected.sourceFactIds, ...followUp.sourceFactIds])],
    ...(followUp.projectId ? { projectId: followUp.projectId } : {}),
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
