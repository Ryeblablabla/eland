import type { KnownFact, PersonId } from './person';

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
  version: number;
  createdAtMonth: number;
  sourceEventIds: string[];
}
