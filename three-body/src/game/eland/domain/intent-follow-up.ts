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
  if (!isGroundedConversationOpening(opening)) return false;
  const openingAction = opening.nextAction;
  const conversation = openingAction.kind === 'communicate' && openingAction.content.kind === 'claim'
    ? openingAction.content.conversation
    : undefined;
  // An ordinary social turn is complete in itself. Treating small talk as a
  // prelude to whichever physical option shares a broad founding source made
  // the rules invent motives the speaker never chose.
  if (conversation && ['open', 'everyday', 'reminiscence', 'playful'].includes(conversation.topic)) return false;
  // A move followed by a communication is still a social action. Looking only
  // at nextAction used to pair one conversation with an unrelated proposal in
  // completionAction (for example, "chat now, propose reproduction later").
  const finalAction = followUp.completionAction ?? followUp.nextAction;
  if (finalAction.kind === 'communicate') return false;
  if (opening.projectId && opening.projectId === followUp.projectId) return true;
  const openingTarget = targetPersonId(opening);
  if (openingTarget && openingTarget === targetPersonId(followUp)) return true;
  const evidence = new Set(opening.sourceFactIds);
  return followUp.sourceFactIds.some((sourceId) => evidence.has(sourceId));
}
