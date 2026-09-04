import type { PersonState } from './person';

/**
 * Meanings are deliberately descriptive rather than ordinal. A person may
 * hold several contradictory meanings about the same encounter; none of
 * them is a relationship score or an automatic permission to act.
 */
export type RelationshipAppraisalMeaning =
  | 'gratitude'
  | 'care'
  | 'affection'
  | 'attraction'
  | 'respect'
  | 'solidarity'
  | 'obligation'
  | 'hurt'
  | 'anger'
  | 'fear'
  | 'suspicion'
  | 'jealousy'
  | 'rivalry'
  | 'grief'
  | 'ambivalence'
  | 'uncertainty';

export interface SubjectiveRelationshipAppraisal {
  /** Several meanings may coexist; order is the observer's emphasis. */
  meanings: RelationshipAppraisalMeaning[];
  /** The observer's own interpretation, not an objective description. */
  interpretation: string;
  /** An unresolved hope, fear, debt, grievance, or question carried forward. */
  unresolvedExpectation?: string;
  /** What the observer currently feels inclined to do; never an action order. */
  desiredResponse?: string;
}

/**
 * A sourced, directed interpretation of a real encounter.
 *
 * `observerId -> otherPersonId` is intentionally asymmetric. Recording one
 * episode changes only the observer's subjective history: it cannot install
 * a reciprocal feeling, consent on the other person's behalf, or mutate the
 * other person's body or relation cache.
 */
export interface RelationshipEpisode {
  version: 'directed-relationship-episode-v1';
  id: string;
  observerId: string;
  otherPersonId: string;
  experiencedAtMonth: number;
  sourceFactIds: string[];
  appraisal: SubjectiveRelationshipAppraisal;
}

export type RelationshipEpisodeInput = Omit<
  RelationshipEpisode,
  'version' | 'observerId'
>;

function nonEmptyText(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isStructurallyValidRelationshipEpisode(
  episode: RelationshipEpisode,
): boolean {
  return episode.version === 'directed-relationship-episode-v1'
    && nonEmptyText(episode.id)
    && nonEmptyText(episode.observerId)
    && nonEmptyText(episode.otherPersonId)
    && episode.observerId !== episode.otherPersonId
    && Number.isSafeInteger(episode.experiencedAtMonth)
    && episode.experiencedAtMonth >= 0
    && episode.sourceFactIds.length > 0
    && episode.sourceFactIds.every(nonEmptyText)
    && episode.appraisal.meanings.length > 0
    && episode.appraisal.meanings.every(nonEmptyText)
    && nonEmptyText(episode.appraisal.interpretation)
    && (episode.appraisal.unresolvedExpectation === undefined
      || nonEmptyText(episode.appraisal.unresolvedExpectation))
    && (episode.appraisal.desiredResponse === undefined
      || nonEmptyText(episode.appraisal.desiredResponse));
}

/**
 * Commit an appraisal only to the observer. Authoritative source existence
 * is resolved later against the world ledger before an episode may ground a
 * decision; this command merely preserves the directed subjective record.
 */
export function recordRelationshipEpisode(
  observer: PersonState,
  input: RelationshipEpisodeInput,
): RelationshipEpisode {
  const episode: RelationshipEpisode = {
    ...structuredClone(input),
    version: 'directed-relationship-episode-v1',
    observerId: observer.id,
    sourceFactIds: [...new Set(input.sourceFactIds)],
    appraisal: {
      ...structuredClone(input.appraisal),
      meanings: [...new Set(input.appraisal.meanings)],
    },
  };
  if (!isStructurallyValidRelationshipEpisode(episode)) {
    throw new Error('relationship episode requires one observer, another person, and sourced subjective meaning');
  }
  const episodes = observer.relationshipEpisodes ?? [];
  if (episodes.some((candidate) => candidate.id === episode.id)) {
    throw new Error(`relationship episode id already exists: ${episode.id}`);
  }
  observer.relationshipEpisodes = [...episodes, episode];
  return episode;
}

export function relationshipEpisodesWith(
  observer: Pick<PersonState, 'id' | 'relationshipEpisodes'>,
  otherPersonId: string,
): RelationshipEpisode[] {
  return (observer.relationshipEpisodes ?? [])
    .filter(isStructurallyValidRelationshipEpisode)
    .filter((episode) => episode.observerId === observer.id
      && episode.otherPersonId === otherPersonId)
    .sort((left, right) => left.experiencedAtMonth - right.experiencedAtMonth
      || left.id.localeCompare(right.id));
}

export function relationshipEpisodeSourceFactIds(
  observer: Pick<PersonState, 'id' | 'relationshipEpisodes'>,
  otherPersonId: string,
): string[] {
  return [...new Set(relationshipEpisodesWith(observer, otherPersonId)
    .flatMap((episode) => episode.sourceFactIds))];
}
