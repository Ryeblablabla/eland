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

export interface MentalAct {
  version: 'mental-act-v1';
  kind: MentalActKind;
  /**
   * The person's own first-person wording of this decision. Trisolaran thought
   * is transparent language, so every model-authored turn must expose this
   * line to the world's ordinary distance/noise propagation rule.
   */
  thoughtLine: string;
  goal: string;
  strategy: string;
  assumptions: string[];
  expectedObservation?: string;
  sourceEventIds: string[];
}
