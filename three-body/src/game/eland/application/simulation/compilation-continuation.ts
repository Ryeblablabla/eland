import type { DecisionContext, DecisionFact } from '../../domain/model';
import { isAlive, isDehydratedHibernating, type PersonId } from '../../domain/person';
import { personById } from '../../domain/state-index';
import { worldEventById } from '../../domain/event-index';
import type { PreparedMonth } from './month-boundary';
import { buildCurrentMonthDecisionContext } from './tick-planner';
import { authoredAttemptReturnsToMind } from '../../domain/intent';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A translation failure is new feedback for Plan, without a fictional
 * physical action, placeholder Intent, or another statement from Mind. */
export function compilationContinuationContexts(
  prepared: PreparedMonth,
  nextTick: number,
  consumedProblems: Set<string>,
  stoppedPlans: ReadonlySet<string>,
  excludedPeople: ReadonlySet<PersonId>,
): DecisionContext[] {
  const latest = new Map<PersonId, DecisionFact>();
  for (const event of [...prepared.events].reverse()) {
    if (event.kind !== 'decision' || !event.usedModel || latest.has(event.who)
      || (!event.decision.mentalAct && !event.planContinuation && !event.decision.authoredAttempt)) continue;
    latest.set(event.who, event);
  }
  const contexts: DecisionContext[] = [];
  for (const [personId, failure] of latest) {
    const compilation = failure.executionCompilation;
    if (excludedPeople.has(personId) || compilation?.status !== 'unresolved' || authoredAttemptReturnsToMind(failure.decision)) continue;
    const originId = failure.planContinuation?.sourceDecisionEventId
      ?? failure.decision.authoredAttempt?.intentionSourceDecisionEventId ?? failure.id;
    if (stoppedPlans.has(originId)) continue;
    const origin = prepared.events.find((event) => event.id === originId)
      ?? worldEventById(prepared.state, originId);
    const mentalAct = origin?.kind === 'decision' && origin.usedModel && origin.who === personId
      ? origin.decision.mentalAct : undefined;
    const plan = failure.planContinuation?.plan ?? failure.decision.authoredAttempt?.plan ?? mentalAct?.plan;
    const person = personById(prepared.state, personId);
    if (!mentalAct || !plan || !person || !isAlive(person) || isDehydratedHibernating(person)
      || ['stay', 'pause', 'abandon'].includes(plan.disposition)) continue;
    // Rephrasing the same rejected request is not new execution evidence.
    // New physical outcomes allow a fresh compilation under changed premises.
    const physicalSources = prepared.events.flatMap((event) => {
      if (event.kind !== 'action' || event.who !== personId) return [];
      const attempt = event.diff.attempt as { worldChanged?: boolean } | undefined;
      const assessment = event.diff.planAssessment as { changedConditionIds?: string[] } | undefined;
      return attempt?.worldChanged || assessment?.changedConditionIds?.length ? [event.id] : [];
    });
    const problemKey = stable({ originId, operation: compilation.operation,
      code: compilation.problem?.code, fields: compilation.problem?.fields, physicalSources });
    if (consumedProblems.has(problemKey)) continue;
    const context = buildCurrentMonthDecisionContext(prepared.state, person, prepared.atMonth, nextTick, prepared.events);
    context.continuingPlan = {
      sourceDecisionEventId: originId, compilationFailureEventId: failure.id,
      mentalAct: structuredClone(mentalAct), plan: structuredClone(plan), outcomeReceipts: [],
    };
    consumedProblems.add(problemKey);
    contexts.push(context);
  }
  return contexts;
}
