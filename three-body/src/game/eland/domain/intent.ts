import type { ActionOption, FactPredicate, Intent, PrimitiveAction, WorldRef } from './action';

export interface IntentChoice {
  summary: string;
  domain: Intent['domain'];
  goal: FactPredicate;
  openingAction?: PrimitiveAction;
  nextAction: PrimitiveAction;
  completionAction?: PrimitiveAction;
  target?: WorldRef;
  sourceFactIds: string[];
}

function compositeDomain(selected: ActionOption, followUp: ActionOption): Intent['domain'] {
  const action = selected.nextAction;
  const plainConversation = action.kind === 'communicate'
    && action.content.kind === 'claim'
    && !action.content.factId;
  return plainConversation ? followUp.domain ?? 'strategic' : 'social';
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
      sourceFactIds: [...selected.sourceFactIds],
    };
  }

  const followUp = followUpOptions.find((option) => option.id === followUpOptionId);
  if (!followUp || selected.nextAction.kind !== 'communicate' || followUp.nextAction.kind === 'communicate') return null;
  return {
    summary: `${selected.summary}，随后${followUp.summary}`,
    domain: compositeDomain(selected, followUp),
    goal: structuredClone(followUp.goal),
    openingAction: structuredClone(selected.nextAction),
    nextAction: structuredClone(followUp.nextAction),
    ...(followUp.completionAction ? { completionAction: structuredClone(followUp.completionAction) } : {}),
    ...(followUp.target ? { target: structuredClone(followUp.target) } : {}),
    sourceFactIds: [...new Set([...selected.sourceFactIds, ...followUp.sourceFactIds])],
  };
}
