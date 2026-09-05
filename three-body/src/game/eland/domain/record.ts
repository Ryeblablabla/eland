import type { KnownFact, PersonId } from './person';
import type { ProceduralKnowledge } from './procedural-knowledge';
import type { ActionFact, SimulationState } from './model';
import type { PersonState } from './person';
import { worldEventById } from './event-index';

/** Hearing is a source to consider, not ownership of the speaker's knowledge. */
export function heardKnowledgeFactId(sourceEventId: string, knowledgeId: string): string {
  return `heard-knowledge:${encodeURIComponent(sourceEventId)}:${encodeURIComponent(knowledgeId)}`;
}

/** A changed ability to read permits a new inspection of the same carrier. */
export function recordInspectionFactId(record: Pick<RecordPayload, 'id' | 'version'>, understood: boolean): string {
  return `record-inspection:${record.id}:v${record.version}:${understood ? 'read' : 'unread-signs'}`;
}

export function knownWritingConvention(person: { knowledge: KnownFact[] }, requestedId?: string): KnownFact | undefined {
  // A tentative mapping can be tried. Unknown marks are observation facts,
  // so removing a confidence threshold does not grant an unknown script.
  const conventions = person.knowledge.filter((fact) => fact.kind === 'codebook');
  return requestedId ? conventions.find((fact) => fact.id === requestedId)
    : conventions.at(-1);
}

export function heardKnowledgeSource(
  state: SimulationState,
  person: PersonState,
  sourceEventId: string,
  knowledgeId?: string,
): { event: ActionFact; knowledge: KnownFact } | undefined {
  const event = worldEventById(state, sourceEventId);
  if (event?.kind !== 'action' || event.action.kind !== 'talk' || event.status !== 'completed') return undefined;
  const knowledge = event.diff.offeredKnowledge as KnownFact | undefined;
  const broadcast = event.diff.languageBroadcast as { decodedByPersonIds?: string[] } | undefined;
  if (!knowledge || (knowledgeId && knowledge.id !== knowledgeId)
    || !broadcast?.decodedByPersonIds?.includes(person.id)
    || !person.knowledge.some((fact) => fact.id === heardKnowledgeFactId(event.id, knowledge.id)
      && fact.sourceEventIds.includes(event.id))) return undefined;
  return { event, knowledge };
}

/**
 * Semantic content is independent from its physical carrier. A carrier may be
 * transferred, dropped or inherited without changing the authored payload.
 */
export interface RecordPayload {
  id: string;
  authorId: PersonId;
  knowledgeId: string;
  codebookId: string;
  kind: KnownFact['kind'];
  summary: string;
  /** The writer's uncertainty travels with the account; writing is not verification. */
  confidence?: number;
  version: number;
  createdAtMonth: number;
  sourceEventIds: string[];
  procedural?: ProceduralKnowledge;
}
