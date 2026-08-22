import type { ActionFact, SimulationState } from './model';
import { remember } from './memory';
import { sameLocation } from './person';
import { applyRelationEvidence } from './relation';
import { intentById, personById } from './state-index';

/**
 * A model utterance is not trust evidence by itself. When an audience member
 * later witnesses the speaker complete the concrete follow-up from that same
 * intent, the declaration and action together become directional evidence.
 */
export function recordWitnessedDeclarationFulfillment(state: SimulationState, fact: ActionFact): void {
  if (fact.status !== 'completed' || fact.action.kind === 'communicate' || !fact.intentId) return;
  const intent = intentById(state, fact.intentId);
  if (!intent?.openingActionCompleted
    || intent.declarationFulfilledAtEventId
    || intent.openingAction?.kind !== 'communicate'
    || intent.openingAction.content.kind !== 'claim') return;
  const speaker = personById(state, fact.who);
  if (!speaker) return;
  const witnesses = state.people.filter((person) => intent.openingAction?.kind === 'communicate'
    && intent.openingAction.audience.includes(person.id)
    && sameLocation(person, speaker));
  if (!witnesses.length) return;
  const declarationEventId = intent.actionEventIds[0];
  if (!declarationEventId) return;
  intent.declarationFulfilledAtEventId = fact.id;
  fact.diff = {
    ...fact.diff,
    declarationEventId,
    declarationWitnessedBy: witnesses.map((person) => person.id),
  };
  for (const witness of witnesses) {
    applyRelationEvidence(witness, speaker.id, declarationEventId, {});
    applyRelationEvidence(witness, speaker.id, fact.id, { trust: 4, bond: 1 });
    remember(witness, {
      id: `memory:declaration-fulfilled:${intent.id}:${witness.id}`,
      kind: 'episode',
      summary: `亲眼看见${speaker.name}在说明打算后实际做到：${fact.result}`,
      importance: 72,
      createdAtMonth: fact.atMonth,
      lastRecalledAtMonth: fact.atMonth,
      personIds: [speaker.id],
      sourceEventIds: [declarationEventId, fact.id],
    });
  }
}
