import { hasReproductiveRecoveryCondition } from './dependent-care';
import { ageMonths, isAlive, type PersonState } from './person';
import { reproductiveUpperAgeMonths } from './trait';

/** One revocable agreement covers one attempt per month for this window. */
export const REPRODUCTION_CONSENT_WINDOW_MONTHS = 4;

/** Physical possibility is distinct from either person's willingness. */
export function reproductivePairPossible(first: PersonState, second: PersonState, atMonth: number): boolean {
  if (!isAlive(first) || !isAlive(second) || first.id === second.id || first.sex === second.sex) return false;
  const female = first.sex === 'female' ? first : second;
  return ageMonths(first, atMonth) >= 16 * 12
    && ageMonths(second, atMonth) >= 16 * 12
    && ageMonths(female, atMonth) <= reproductiveUpperAgeMonths(female);
}

export function reproductivePairReady(first: PersonState, second: PersonState, atMonth: number): boolean {
  if (!reproductivePairPossible(first, second, atMonth)) return false;
  const female = first.sex === 'female' ? first : second;
  return !hasReproductiveRecoveryCondition(female);
}

/** Resource shortages act through real bodies; world population is not a contraceptive. */
export function conceptionChance(first: PersonState, second: PersonState, atMonth: number): number {
  if (!reproductivePairReady(first, second, atMonth)) return 0;
  const bodilyReserve = Math.min(
    first.body.health, first.body.hydration, first.body.nutrition,
    second.body.health, second.body.hydration, second.body.nutrition,
  );
  return 0.28 * Math.max(0, Math.min(100, bodilyReserve)) / 100;
}
