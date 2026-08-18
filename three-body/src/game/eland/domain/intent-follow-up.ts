import type { ActionOption } from './action';

function targetPersonId(option: ActionOption): string | undefined {
  return option.target?.kind === 'person' ? option.target.personId : undefined;
}

/** Only a grounded conversational opening may borrow a later physical action as its goal. */
export function isGroundedConversationOpening(option: ActionOption): boolean {
  const action = option.nextAction;
  return action.kind === 'communicate'
    && action.content.kind === 'claim'
    && action.content.conversation?.turn === 'opening';
}

/**
 * A follow-up must share a concrete causal subject with the utterance. This
 * prevents a conversation about care, work or discovery from being paired
 * with whichever unrelated action happens to have the highest score.
 */
export function followUpSemanticallyMatches(opening: ActionOption, followUp: ActionOption): boolean {
  if (!isGroundedConversationOpening(opening) || followUp.nextAction.kind === 'communicate') return false;
  if (opening.projectId && opening.projectId === followUp.projectId) return true;
  const openingTarget = targetPersonId(opening);
  if (openingTarget && openingTarget === targetPersonId(followUp)) return true;
  const evidence = new Set(opening.sourceFactIds);
  return followUp.sourceFactIds.some((sourceId) => evidence.has(sourceId));
}
