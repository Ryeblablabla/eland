/**
 * One subjective turn of mind. It can choose a direction and name fallible
 * assumptions, but it never states that a world result has already happened.
 * A local compiler may ground only the next currently available step.
 */
export type MentalActKind =
  | 'pursue'
  | 'investigate'
  | 'talk'
  | 'reconsider'
  | 'continue'
  | 'wait';

export type MentalActOrientation =
  | 'social'
  | 'inquiry'
  | 'survival'
  | 'construction'
  | 'acquisition'
  | 'exploration'
  | 'rest';

export interface MentalAct {
  version: 'mental-act-v2';
  kind: MentalActKind;
  /**
   * The single first-person language wave produced by this decision. A
   * Trisolaran has no private thought channel distinct from speaking.
   */
  utterance: string;
  /** Electromagnetic emission strength; it never selects a receiver. */
  delivery: 'whisper' | 'normal' | 'call';
  goal: string;
  /** The broad subjective direction chosen before Plan saw executable entries. */
  orientation?: MentalActOrientation;
  /** Whether the person meant this goal to persist beyond the current turn. */
  horizon?: 'momentary' | 'ongoing';
  strategy: string;
  assumptions: string[];
  expectedObservation?: string;
  /** Plan Agent correction grounded in prior experienced failure facts. */
  planFeedback?: {
    correction: string;
    adjustment: string;
    sourceEventIds: string[];
  };
  sourceEventIds: string[];
}
