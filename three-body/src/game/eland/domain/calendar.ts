export const MONTHS_PER_YEAR = 12 as const;
/**
 * A month contains a bounded number of schedulable activity episodes. An
 * episode is not an hour or a single footstep: travel, gathering and a brief
 * interaction may each occupy one episode according to their real effort.
 */
export const ACTIVITY_EPISODES_PER_MONTH = 15 as const;
/** @deprecated Use ACTIVITY_EPISODES_PER_MONTH for new time-model code. */
export const PLANNING_TICKS_PER_MONTH = ACTIVITY_EPISODES_PER_MONTH;
/** @deprecated Use PLANNING_TICKS_PER_MONTH. */
export const RULE_ACTION_TICKS_PER_MONTH = PLANNING_TICKS_PER_MONTH;

/**
 * Baseline physical work available to a healthy person during one month.
 * Terrain movement cost uses the same effort unit (ordinary level ground is
 * two units per crossed cell), so a person can normally cover about sixty
 * ground cells in a travel-heavy month while still producing every traversed
 * path cell as replayable evidence.
 */
export const BASE_PERSON_MONTH_WORK_EFFORT = 120 as const;
export const BASE_ACTIVITY_EPISODE_WORK_EFFORT = BASE_PERSON_MONTH_WORK_EFFORT
  / ACTIVITY_EPISODES_PER_MONTH;

export interface PhysicalWorkCapacitySnapshot {
  locomotion: number;
  hydration: number;
  nutrition: number;
  conditions: readonly { kind: string; stage: number }[];
}

/**
 * Converts embodied facts into throughput, not preference. It may change how
 * much of an already chosen path can physically be completed in an episode;
 * it never selects a destination or makes a decision for the person.
 */
export function physicalWorkCapacityMultiplier(snapshot: PhysicalWorkCapacitySnapshot): number {
  const locomotion = Math.max(0, Math.min(100, snapshot.locomotion));
  let multiplier = 0.75 + locomotion / 200;
  if (snapshot.hydration < 10) multiplier *= 0.35;
  else if (snapshot.hydration < 35) multiplier *= 0.75;
  if (snapshot.nutrition < 10) multiplier *= 0.45;
  else if (snapshot.nutrition < 35) multiplier *= 0.8;
  if (snapshot.hydration >= 60 && snapshot.nutrition >= 70) multiplier *= 1.1;
  for (const condition of snapshot.conditions) {
    const stage = Math.max(1, Math.min(3, Math.floor(condition.stage)));
    if (condition.kind === 'cold') multiplier *= [1, 0.85, 0.65, 0.4][stage];
    if (condition.kind === 'heat') multiplier *= [1, 0.9, 0.7, 0.45][stage];
    if (condition.kind === 'wound' || condition.kind === 'illness') multiplier *= [1, 0.88, 0.68, 0.45][stage];
    if (condition.kind === 'aging') multiplier *= [1, 0.95, 0.8, 0.55][stage];
    if (condition.kind === 'pregnancy') multiplier *= stage >= 3 ? 0.65 : 0.88;
    if (condition.kind === 'postpartum-recovery') multiplier *= stage >= 3 ? 0.78 : stage === 2 ? 0.88 : 0.96;
    if (condition.kind === 'restrained') multiplier *= 0.25;
  }
  return Math.max(0.2, Math.min(1.5, multiplier));
}

export interface CalendarDate {
  elapsedMonths: number;
  year: number;
  month: number;
  label: string;
}

export function calendarDate(elapsedMonths: number): CalendarDate {
  const safe = Math.max(0, Math.floor(elapsedMonths));
  const year = safe === 0 ? 1 : Math.floor((safe - 1) / MONTHS_PER_YEAR) + 1;
  const month = safe === 0 ? 1 : (safe - 1) % MONTHS_PER_YEAR + 1;
  return { elapsedMonths: safe, year, month, label: `第 ${year} 年 · ${month} 月` };
}

export function isYearBoundary(elapsedMonths: number): boolean {
  return elapsedMonths > 0 && elapsedMonths % MONTHS_PER_YEAR === 0;
}
