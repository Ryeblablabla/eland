import type { MentalSpeechIntent } from '../../domain/mental-act';
import type { DecisionRequestContext } from './decision-context';
import type { DecisionProbeHandleMap } from './capability-handles';

export const SPEECH_PROPOSAL_KINDS = ['reproduce', 'assist', 'companion', 'collective', 'membership', 'decision-rule', 'mandate', 'permission', 'exchange'] as const;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const referenceKinds = {
  accept: 'agreement', reject: 'agreement', 'end-agreement': 'agreement',
  'revoke-permission': 'permission', 'leave-collective': 'collective', 'share-knowledge': 'knowledge',
} as const;

/** Optional malformed speech metadata cannot erase a person's ordinary expression. */
export function compileMindSpeechIntent(input: unknown, handles: DecisionProbeHandleMap, bound = false): MentalSpeechIntent {
  const raw = object(input);
  if (raw.kind === 'proposal' && SPEECH_PROPOSAL_KINDS.includes(raw.proposalKind as never)) {
    const requested = Array.isArray(bound ? raw.counterpartIds : raw.counterpartHandles)
      ? (bound ? raw.counterpartIds : raw.counterpartHandles) as unknown[] : [];
    const counterparts = requested.map((value) => handles.visible.find((person) => person.kind === 'person'
      && (bound ? person.personId === value : person.handle === value)));
    const commitment = string(raw.commitment).slice(0, 240);
    if (commitment && counterparts.length && counterparts.every((item) => item?.kind === 'person')) return {
      kind: 'proposal', proposalKind: raw.proposalKind as typeof SPEECH_PROPOSAL_KINDS[number],
      counterpartIds: [...new Set(counterparts.map((item) => item!.kind === 'person' ? item!.personId : ''))], commitment,
    };
  }
  const referenceKind = referenceKinds[raw.kind as keyof typeof referenceKinds];
  if (referenceKind) {
    const reference = handles.speechReferences?.find((item) => item.kind === referenceKind
      && (bound ? item.id === raw.referenceId : item.handle === raw.referenceHandle));
    if (reference) return { kind: raw.kind as keyof typeof referenceKinds, referenceId: reference.id };
  }
  if (raw.kind === 'prediction' || raw.kind === 'request-information') return { kind: raw.kind };
  return { kind: 'expression' };
}

/** Compare model-authored meaning and exact references, never words or goal categories. */
export function speechIntentAllowsOption(intent: MentalSpeechIntent | undefined, option: DecisionRequestContext['options'][number]): boolean {
  const meaning = option.communicationMeaning;
  if (!meaning) return true;
  const speech = intent ?? { kind: 'expression' as const };
  if (meaning.kind === 'claim') return !meaning.factId
    || speech.kind === 'share-knowledge' && speech.referenceId === meaning.factId;
  if (meaning.kind === 'prediction') return speech.kind === 'prediction';
  if ((meaning.kind === 'offer' || meaning.kind === 'request') && meaning.proposal) {
    const counterpartIds = option.semantics.socialContext?.counterpartIds
      ?? (option.target?.kind === 'person' ? [option.target.personId] : []);
    return speech.kind === 'proposal' && speech.proposalKind === meaning.proposal.kind
      && counterpartIds.length > 0 && counterpartIds.length === speech.counterpartIds.length
      && counterpartIds.every((id) => speech.counterpartIds.includes(id));
  }
  if (meaning.kind === 'request') return speech.kind === 'request-information';
  if (meaning.kind === 'accept' || meaning.kind === 'reject') return speech.kind === meaning.kind && speech.referenceId === meaning.referenceId;
  if (meaning.kind === 'revoke-agreement') return speech.kind === 'end-agreement' && speech.referenceId === meaning.referenceId;
  if (meaning.kind === 'revoke') return speech.kind === 'revoke-permission' && speech.referenceId === meaning.permissionId;
  if (meaning.kind === 'withdraw') return speech.kind === 'leave-collective' && speech.referenceId === meaning.collectiveId;
  return false;
}

export function describeMindSpeechIntent(intent: MentalSpeechIntent, handles: DecisionProbeHandleMap): unknown {
  if (intent.kind === 'proposal') return {
    kind: intent.kind, proposalKind: intent.proposalKind, commitment: intent.commitment,
    counterpartHandles: intent.counterpartIds.map((id) => handles.visible.find((item) => item.kind === 'person' && item.personId === id)?.handle),
  };
  if ('referenceId' in intent) return {
    kind: intent.kind, referenceHandle: handles.speechReferences?.find((item) => item.id === intent.referenceId)?.handle,
  };
  return intent;
}
