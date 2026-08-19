import type { DecisionContext } from '../domain/model';
import { composeIntentChoice } from '../domain/intent';
import { followUpSemanticallyMatches } from '../domain/intent-follow-up';
import type { IntentChoice } from '../domain/intent';
import type { ActionOption } from '../domain/action';
import {
  isFulfillmentOption,
  isRequiredSocialOption,
} from './rule-planner';

export interface PlayerInteractionChoiceInput {
  optionId: string;
  followUpOptionId?: string;
  /** Stable semantic identity captured when the person made the choice. */
  choiceKey?: string;
}

export type PlayerInteractionChoiceFailure =
  | 'option-unavailable'
  | 'emergency-first'
  | 'required-response-first'
  | 'fulfillment-first'
  | 'follow-up-unavailable'
  | 'choice-ambiguous';

export type PlayerInteractionChoiceValidation =
  | {
      ok: true;
      optionId: string;
      followUpOptionId?: string;
      summary: string;
      choiceKey: string;
    }
  | {
      ok: false;
      failure: PlayerInteractionChoiceFailure;
    };

export function isPlayerInteractionEmergencyContext(context: DecisionContext): boolean {
  const person = context.person;
  if (!person?.body) return false;
  return person.body.health < 35
    || person.body.hydration < 32
    || person.body.nutrition < 34
    || person.conditions.some((condition) => (
      condition.kind === 'cold'
      || condition.kind === 'heat'
      || condition.kind === 'wound'
      || condition.kind === 'illness'
    ) && condition.stage >= 2);
}

/**
 * A player conversation may help a person choose, but it may only bind to the
 * same locally compiled choices as every other decision path. This check is
 * shared by the interaction response and the later month-boundary commit so a
 * model never creates an action or bypasses a required response / obligation.
 */
const EPHEMERAL_KEYS = new Set([
  'id',
  'representationId',
  'expiresAtMonth',
  'validUntilMonth',
  'createdAtMonth',
  'reviewAtMonth',
  'atMonth',
  'predictedStartMonth',
  'pressure',
  'projectPressure',
  'sourceFactIds',
  'sourceEventIds',
  'evidenceEventIds',
  'triggerFactIds',
]);

function stableSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !EPHEMERAL_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableSemanticValue(nested)]));
}

function stableChoiceKey(choice: IntentChoice, selected: ActionOption): string {
  const goal = choice.goal.kind === 'representation-made'
    ? { kind: choice.goal.kind }
    : choice.goal.kind === 'project-completed' && selected.projectProposal
      ? { kind: choice.goal.kind, projectId: 'new-project' }
      : choice.goal;
  return JSON.stringify(stableSemanticValue({
    summary: choice.summary,
    domain: choice.domain,
    goal,
    openingAction: choice.openingAction,
    nextAction: choice.nextAction,
    completionAction: choice.completionAction,
    target: choice.target,
    projectId: selected.projectProposal ? undefined : choice.projectId,
    projectProposal: selected.projectProposal,
    relationshipBasis: choice.relationshipBasis,
    recordUseBasisKey: choice.recordUseBasis?.basisKey,
    recordUseStage: choice.recordUseStage,
  }));
}

function validateExactChoice(
  context: DecisionContext,
  input: PlayerInteractionChoiceInput,
): PlayerInteractionChoiceValidation {
  if (isPlayerInteractionEmergencyContext(context)) {
    return { ok: false, failure: 'emergency-first' };
  }
  const selected = context.options.find((option) => option.id === input.optionId);
  if (!selected) return { ok: false, failure: 'option-unavailable' };

  const required = context.options.filter(isRequiredSocialOption);
  if (required.length && !required.some((option) => option.id === selected.id)) {
    return { ok: false, failure: 'required-response-first' };
  }

  const fulfillment = required.length ? [] : context.options.filter(isFulfillmentOption);
  if (fulfillment.length && !fulfillment.some((option) => option.id === selected.id)) {
    return { ok: false, failure: 'fulfillment-first' };
  }

  const composed = composeIntentChoice(
    context.options,
    context.followUpOptions,
    selected.id,
    input.followUpOptionId,
  );
  if (!composed) return { ok: false, failure: 'follow-up-unavailable' };

  return {
    ok: true,
    optionId: selected.id,
    ...(input.followUpOptionId ? { followUpOptionId: input.followUpOptionId } : {}),
    summary: composed.summary,
    choiceKey: stableChoiceKey(composed, selected),
  };
}

/**
 * Revalidates a choice against a fresh context. Exact IDs are preferred, while
 * the stable semantic key lets month-stamped representation IDs change without
 * turning the same still-legal intention into a false failure.
 */
export function validatePlayerInteractionChoice(
  context: DecisionContext,
  input: PlayerInteractionChoiceInput,
): PlayerInteractionChoiceValidation {
  const exact = validateExactChoice(context, input);
  if (!input.choiceKey) return exact;
  if (exact.ok && exact.choiceKey === input.choiceKey) return exact;

  const matches: Extract<PlayerInteractionChoiceValidation, { ok: true }>[] = [];
  for (const option of context.options) {
    const followUps = option.requiresFollowUp
      ? context.followUpOptions.filter((followUp) => followUpSemanticallyMatches(option, followUp))
      : [undefined];
    for (const followUp of followUps) {
      const candidate = validateExactChoice(context, {
        optionId: option.id,
        ...(followUp ? { followUpOptionId: followUp.id } : {}),
      });
      if (candidate.ok && candidate.choiceKey === input.choiceKey) matches.push(candidate);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ok: false, failure: 'choice-ambiguous' };
  if (context.options.some(isRequiredSocialOption)) {
    return { ok: false, failure: 'required-response-first' };
  }
  if (context.options.some(isFulfillmentOption)) {
    return { ok: false, failure: 'fulfillment-first' };
  }
  return exact.ok ? { ok: false, failure: 'option-unavailable' } : exact;
}
