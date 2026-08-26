import type { ActionOption, SocialProposal } from '../../domain/action';
import type { PersonState } from '../../domain/person';
import {
  proposalCooperationContext,
  socialCooperationBeliefFor,
  socialDimensionExpectation,
  type CooperationContext,
} from '../../domain/social-learning';
import { actionOptionSemantics } from '../../domain/action-option-semantics';

export interface SocialExpectationAppraisal {
  applicable: boolean;
  context?: CooperationContext;
  targetPersonId?: string;
  response: number;
  willingness: number;
  reliability: number;
  expectation: number;
  /** A bounded soft preference. It is never a legality gate. */
  gate: number;
  reasons: string[];
  sourceFactIds: string[];
}

function executionCommunication(option: ActionOption) {
  const action = option.completionAction ?? option.nextAction;
  return action.kind === 'communicate' ? action : undefined;
}

function proposalForOption(option: ActionOption): SocialProposal | undefined {
  const content = executionCommunication(option)?.content;
  return content && (content.kind === 'request' || content.kind === 'offer')
    ? content.proposal
    : undefined;
}

/**
 * Map typed action payload and typed option semantics to the matching direct-
 * experience belief. Option ids are intentionally absent from this function.
 */
export function cooperationContextForOption(option: ActionOption): CooperationContext | undefined {
  const proposal = proposalForOption(option);
  if (proposal) return proposalCooperationContext(proposal) ?? undefined;
  const semantics = actionOptionSemantics(option);
  const social = semantics.socialContext;
  if (!social) return undefined;
  if (social.cooperationKind === 'assist' && social.assistNeed) return `assist-${social.assistNeed}`;
  if (social.cooperationKind === 'exchange') return 'exchange';
  if (social.cooperationKind === 'companion') return 'shared-living';
  if (social.cooperationKind === 'collective') return 'collective-formation';
  if (social.cooperationKind === 'membership') return 'collective-membership';
  if (social.cooperationKind === 'material-coordination') return social.phase === 'fulfillment'
    ? 'mandate-resource-coordination'
    : 'collective-permission';
  if (social.cooperationKind === 'joint-project') {
    const kind = option.projectProposal?.kind
      ?? (social.projectKind === 'construction' || social.projectKind === 'inquiry' || social.projectKind === 'production'
        ? social.projectKind
        : undefined);
    if (kind) return `joint-project-${kind}`;
  }
  return undefined;
}

function singleCounterpartId(option: ActionOption): string | undefined {
  const semantics = actionOptionSemantics(option);
  const counterparts = semantics.socialContext?.counterpartIds
    .filter((personId) => personId.length > 0);
  if (counterparts?.length === 1) return counterparts[0];
  if (option.target?.kind === 'person') return option.target.personId;
  return undefined;
}

function counterpartIds(option: ActionOption): string[] {
  const typed = actionOptionSemantics(option).socialContext?.counterpartIds
    .filter((personId) => personId.length > 0) ?? [];
  if (typed.length) return [...new Set(typed)].sort();
  return option.target?.kind === 'person' ? [option.target.personId] : [];
}

function optionalSocialInitiation(option: ActionOption): boolean {
  const semantics = actionOptionSemantics(option);
  const social = semantics.socialContext;
  return semantics.obligation === 'optional'
    && !semantics.reproduction
    && social !== undefined
    && (social.phase === 'proposal' || social.phase === 'opening')
    && social.cooperationKind !== 'reproduction';
}

export function appraiseSocialExpectation(
  person: PersonState,
  option: ActionOption,
  atMonth: number,
): SocialExpectationAppraisal {
  if (!optionalSocialInitiation(option)) return {
    applicable: false,
    response: 0.5,
    willingness: 0.5,
    reliability: 0.5,
    expectation: 0.5,
    gate: 1,
    reasons: [],
    sourceFactIds: [],
  };
  const context = cooperationContextForOption(option);
  const targets = counterpartIds(option);
  if (!context || !targets.length) return {
    applicable: false,
    response: 0.5,
    willingness: 0.5,
    reliability: 0.5,
    expectation: 0.5,
    gate: 1,
    reasons: [],
    sourceFactIds: [],
  };
  const beliefs = targets.map((targetPersonId) => socialCooperationBeliefFor(person, targetPersonId, context));
  const mean = (dimension: 'response' | 'willingness' | 'reliability') => beliefs.reduce(
    (total, belief) => total + socialDimensionExpectation(belief, dimension, atMonth),
    0,
  ) / targets.length;
  const response = mean('response');
  const willingness = mean('willingness');
  const reliability = mean('reliability');
  // Getting an answer matters first, willingness matters next, and later
  // reliability matters only after a proposal is accepted. All three remain
  // separate evidence dimensions in the underlying belief.
  const expectation = response * 0.45 + willingness * 0.35 + reliability * 0.2;
  return {
    applicable: true,
    context,
    ...(targets.length === 1 ? { targetPersonId: targets[0] } : {}),
    response,
    willingness,
    reliability,
    expectation,
    gate: Math.max(0.82, Math.min(1.18, 1 + (expectation - 0.5) * 0.72)),
    reasons: beliefs.some(Boolean)
      ? [`本人只依据与这些人在“${context}”情境中的亲历，分别估计回应、意愿与履约可能`]
      : [`本人在“${context}”情境中尚无亲历，保持中性的弱先验`],
    sourceFactIds: [...new Set(beliefs.flatMap((belief) => belief?.sourceEventIds ?? []))],
  };
}

function rotationOffset(personId: string, context: CooperationContext, atMonth: number, size: number): number {
  let hash = 2166136261;
  for (const character of `${personId}\u0000${context}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash + Math.max(0, Math.floor(atMonth))) % size;
}

/**
 * Bound optional social attention after all legal options have been built.
 * For each typed context, two candidates exploit direct experience and one
 * rotates through the remainder. Required responses and commitments bypass
 * this attention policy and remain fully available.
 */
export function applyContextualSocialAttention(
  person: PersonState,
  options: ActionOption[],
  atMonth: number,
): ActionOption[] {
  const grouped = new Map<CooperationContext, Map<string, ActionOption[]>>();
  for (const option of options) {
    if (!optionalSocialInitiation(option)) continue;
    const context = cooperationContextForOption(option);
    const targetPersonId = singleCounterpartId(option);
    if (!context || !targetPersonId) continue;
    const byTarget = grouped.get(context) ?? new Map<string, ActionOption[]>();
    const targetOptions = byTarget.get(targetPersonId) ?? [];
    targetOptions.push(option);
    byTarget.set(targetPersonId, targetOptions);
    grouped.set(context, byTarget);
  }

  const retained = new Set<ActionOption>();
  for (const [context, byTarget] of grouped) {
    if (byTarget.size <= 2) {
      for (const targetOptions of byTarget.values()) targetOptions.forEach((option) => retained.add(option));
      continue;
    }
    const ranked = [...byTarget].map(([targetPersonId, targetOptions]) => ({
      targetPersonId,
      targetOptions,
      expectation: appraiseSocialExpectation(person, targetOptions[0]!, atMonth).expectation,
    })).sort((left, right) => right.expectation - left.expectation
      || left.targetPersonId.localeCompare(right.targetPersonId));
    const selected = ranked.slice(0, 2);
    const exploration = ranked.slice(2).sort((left, right) => left.targetPersonId.localeCompare(right.targetPersonId));
    selected.push(exploration[rotationOffset(person.id, context, atMonth, exploration.length)]!);
    for (const candidate of selected) candidate.targetOptions.forEach((option) => retained.add(option));
  }

  return options.filter((option) => {
    if (!optionalSocialInitiation(option)) return true;
    const context = cooperationContextForOption(option);
    const targetPersonId = singleCounterpartId(option);
    return !context || !targetPersonId || retained.has(option);
  });
}
