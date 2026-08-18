import { ageMonths, type PersonState } from './person';

export const DEPENDENT_CHILD_MAX_MONTHS = 1 * 12;
export const LEARNING_CHILD_MAX_MONTHS = 12 * 12;
export const ADOLESCENT_MAX_MONTHS = 16 * 12;

export type LifePlanningStage = 'dependent-child' | 'learning-child' | 'adolescent-worker' | 'adult';

export function lifePlanningStageForAge(age: number): LifePlanningStage {
  if (age < DEPENDENT_CHILD_MAX_MONTHS) return 'dependent-child';
  if (age < LEARNING_CHILD_MAX_MONTHS) return 'learning-child';
  if (age < ADOLESCENT_MAX_MONTHS) return 'adolescent-worker';
  return 'adult';
}

export function lifePlanningStage(person: PersonState, atMonth: number): LifePlanningStage {
  return lifePlanningStageForAge(ageMonths(person, atMonth));
}
