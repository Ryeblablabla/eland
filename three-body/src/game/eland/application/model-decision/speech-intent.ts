import { compileMindPredictionTerms, compileMindProposalTerms } from './social-proposal';
import type { MentalSpeechIntent } from '../../domain/mental-act';
import type { DecisionRequestContext } from './decision-context';
import type { DecisionProbeHandleMap } from './capability-handles';

export const SPEECH_PROPOSAL_KINDS = ['reproduce', 'assist', 'joint-action', 'companion', 'collective', 'membership', 'decision-rule', 'mandate', 'permission', 'exchange'] as const;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const sameTerms = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const referenceKinds = {
  accept: 'agreement', reject: 'agreement', 'end-agreement': 'agreement',
  'revoke-permission': 'permission', 'leave-collective': 'collective', 'share-knowledge': 'knowledge',
} as const;

/** Optional malformed speech metadata cannot erase a person's ordinary expression. */
export function compileMindSpeechIntent(input: unknown, handles: DecisionProbeHandleMap, bound = false, actorId = handles.actorId ?? '', spokenUtterance?: string): MentalSpeechIntent {
  const raw = object(input);
  if (raw.kind === 'proposal' && SPEECH_PROPOSAL_KINDS.includes(raw.proposalKind as never)) {
    const requested = Array.isArray(bound ? raw.counterpartIds : raw.counterpartHandles)
      ? (bound ? raw.counterpartIds : raw.counterpartHandles) as unknown[] : [];
    const counterpartIds = bound
      ? requested.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      : requested.flatMap((value) => {
          const person = handles.visible.find((item) => item.kind === 'person' && item.handle === value);
          return person?.kind === 'person' ? [person.personId] : [];
        });
    const jointAction = raw.proposalKind === 'joint-action';
    const declaredTerms = object(bound ? raw.proposal : raw.terms);
    const jointSummary = jointAction
      ? string(spokenUtterance) || string(declaredTerms.summary) || (!bound ? string(raw.summary) : '') : '';
    const commitment = jointAction ? jointSummary || string(raw.commitment) : string(raw.commitment).slice(0, 240);
    if ((commitment || jointAction) && counterpartIds.length && counterpartIds.length === requested.length) {
      const proposalKind = raw.proposalKind as typeof SPEECH_PROPOSAL_KINDS[number];
      const compiled = bound && !raw.proposal && !jointAction
        ? { proposal: undefined, problems: Array.isArray(raw.compilationProblems)
          ? raw.compilationProblems.map(string).filter(Boolean) : ['terms'] }
        : compileMindProposalTerms(jointAction ? { ...declaredTerms, ...(jointSummary ? { summary: jointSummary } : {}) }
          : bound ? raw.proposal : raw.terms, proposalKind, counterpartIds, handles, actorId, bound);
      return { kind: 'proposal', proposalKind, counterpartIds: [...new Set(counterpartIds)], commitment,
        ...(compiled.proposal ? { proposal: compiled.proposal } : {}),
        ...(compiled.problems.length ? { compilationProblems: compiled.problems } : {}) };
    }
  }
  const referenceKind = referenceKinds[raw.kind as keyof typeof referenceKinds];
  if (referenceKind) {
    if (bound && string(raw.referenceId)) return { kind: raw.kind as keyof typeof referenceKinds, referenceId: string(raw.referenceId) };
    const reference = handles.speechReferences?.find((item) => item.kind === referenceKind
      && (bound ? item.id === raw.referenceId : item.handle === raw.referenceHandle));
    if (reference) return { kind: raw.kind as keyof typeof referenceKinds, referenceId: reference.id };
  }
  if (raw.kind === 'prediction') {
    const compiled = compileMindPredictionTerms(raw.prediction ?? raw.terms);
    return { kind: 'prediction', ...(compiled.prediction ? { prediction: compiled.prediction } : {}),
      ...(compiled.problems.length ? { compilationProblems: compiled.problems } : {}) };
  }
  if (raw.kind === 'request-information') return { kind: raw.kind };
  return { kind: 'expression' };
}

/** Compare model-authored meaning and exact references, never words or goal categories. */
export function speechIntentAllowsOption(intent: MentalSpeechIntent | undefined, option: DecisionRequestContext['options'][number]): boolean {
  const meaning = option.communicationMeaning;
  if (!meaning) return true;
  const speech = intent ?? { kind: 'expression' as const };
  if (meaning.kind === 'claim') return !meaning.factId
    || speech.kind === 'share-knowledge' && speech.referenceId === meaning.factId;
  if (meaning.kind === 'prediction') return speech.kind === 'prediction' && sameTerms(speech.prediction, meaning.prediction);
  if ((meaning.kind === 'offer' || meaning.kind === 'request') && meaning.proposal) {
    const counterpartIds = option.semantics.socialContext?.counterpartIds
      ?? (option.target?.kind === 'person' ? [option.target.personId] : []);
    return speech.kind === 'proposal' && speech.proposalKind === meaning.proposal.kind
      && Boolean(speech.proposal) && sameTerms(speech.proposal, meaning.proposal)
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
    ...(intent.proposal ? { proposal: intent.proposal } : {}),
    ...(intent.compilationProblems?.length ? { missingTerms: intent.compilationProblems } : {}),
    counterpartHandles: intent.counterpartIds.map((id) => handles.visible.find((item) => item.kind === 'person' && item.personId === id)?.handle),
  };
  if ('referenceId' in intent) return {
    kind: intent.kind, referenceHandle: handles.speechReferences?.find((item) => item.id === intent.referenceId)?.handle,
  };
  return intent;
}
