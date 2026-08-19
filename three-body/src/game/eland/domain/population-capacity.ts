export const HUMAN_SOFT_CARRYING_CAPACITY = 50;
export const HUMAN_REPRODUCTION_TAPER_START = 48;

/**
 * Conception tapers near the supported population instead of imposing a hard
 * deletion cap. Existing pregnancies may carry the population a little above
 * the target, after which no new conception begins until it falls again.
 */
export function humanReproductionCapacityFactor(livingPopulation: number): number {
  if (livingPopulation < HUMAN_REPRODUCTION_TAPER_START) return 1;
  if (livingPopulation > HUMAN_SOFT_CARRYING_CAPACITY) return 0;
  return (HUMAN_SOFT_CARRYING_CAPACITY + 1 - livingPopulation)
    / (HUMAN_SOFT_CARRYING_CAPACITY + 1 - HUMAN_REPRODUCTION_TAPER_START);
}

/** Above the soft capacity, competition raises the food and water cost of maintaining the settlement. */
export function humanResourceCompetitionMultiplier(livingPopulation: number): number {
  const overshoot = Math.max(0, livingPopulation - HUMAN_SOFT_CARRYING_CAPACITY);
  return 1 + Math.min(1.5, overshoot * 0.08);
}

export const REPRODUCTION_REOFFER_MONTHS_AFTER_CONCEPTION = 12;
export const REPRODUCTION_REOFFER_MONTHS_AFTER_NO_CONCEPTION = 6;

/**
 * One explicit mutual agreement may cover one attempt in each of four
 * consecutive calendar months. Either party can still revoke it before any
 * later attempt, and conception ends the window immediately.
 */
export const REPRODUCTION_CONSENT_WINDOW_MONTHS = 4;
