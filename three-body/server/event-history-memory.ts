import type { WorldEvent } from '../src/game/eland/simulation';

function internString(pool: Map<string, string>, value: string): string {
  const existing = pool.get(value);
  if (existing !== undefined) return existing;
  pool.set(value, value);
  return value;
}

/** Share repeated audit strings while preserving every event's exact value. */
export function internEventHistoryAuditStrings(
  events: WorldEvent[],
  pool = new Map<string, string>(),
): Map<string, string> {
  for (const event of events) {
    event.id = internString(pool, event.id);
    if (event.kind !== 'decision') continue;
    event.decision.reason = internString(pool, event.decision.reason);
    if ('optionId' in event.decision) event.decision.optionId = internString(pool, event.decision.optionId);
    if (!event.reproductionEvidence) continue;
    const evidence = event.reproductionEvidence;
    evidence.optionId = 'optionId' in event.decision && event.decision.optionId === evidence.optionId
      ? event.decision.optionId
      : internString(pool, evidence.optionId);
    evidence.sourceFactIds = evidence.sourceFactIds.map((sourceId) => internString(pool, sourceId));
    if (!evidence.familyReadiness) continue;
    evidence.familyReadiness.basisKeys = evidence.familyReadiness.basisKeys
      .map((basisKey) => internString(pool, basisKey));
    evidence.familyReadiness.sourceFactIds = evidence.familyReadiness.sourceFactIds
      .map((sourceId) => internString(pool, sourceId));
  }
  return pool;
}
