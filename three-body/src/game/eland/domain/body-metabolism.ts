import { isDormantDehydratedHibernating, type PersonState } from './person';
import { Material } from './material';
import type { SimulationState } from './model';
import { cellX, cellY, cellsInRadius, voxelAt } from '../world/grid';
import { coldHarmMultiplier, heatHydrationMultiplier, nutritionMetabolicMultiplier } from './trait';

/** Game-scale reserves and portions, not a medical model or an action policy. */
export const BODY_DAYS_PER_MONTH = 30;
export const BASE_DAILY_HYDRATION_COST = 58 / 3;
export const BASE_DAILY_NUTRITION_COST = 48 / 7;

export interface BodyMetabolismEnvironment {
  droughtIntensity: number;
  fireProtected: boolean;
  severeChaoticClimate: boolean;
}

export function bodyMetabolismEnvironmentAt(state: SimulationState, person: PersonState): BodyMetabolismEnvironment {
  const fireProtected = cellsInRadius(person.position.cellId, 2).some((cell) => {
    for (let z = Math.max(0, person.position.z - 2); z <= Math.min(state.world.grid.levels - 1, person.position.z + 2); z += 1) {
      if (voxelAt(state.world.grid, cellX(cell), cellY(cell), z) === Material.Fire) return true;
    }
    return false;
  });
  return {
    droughtIntensity: state.civilization.weather.kind === 'drought' ? state.civilization.weather.intensity : 0,
    fireProtected,
    severeChaoticClimate: state.civilization.epoch === 'chaotic' && state.civilization.climate.severity >= 8,
  };
}

function clampReserve(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Integrate time below each reserve threshold, including a mid-interval crossing. */
function shortageDamage(reserve: number, dailyCost: number, days: number, severeDailyDamage: number): number {
  const daysBelow = (threshold: number): number => Math.max(0, days - Math.max(0, (reserve - threshold) / dailyCost));
  return daysBelow(25) * 2 + daysBelow(10) * (severeDailyDamage - 2);
}

/** Current daily costs derived from the actual body and environment. */
export function bodyMetabolismRates(person: PersonState, environment: BodyMetabolismEnvironment) {
  const stage = (kind: PersonState['conditions'][number]['kind']): number => person.conditions
    .find((condition) => condition.kind === kind)?.stage ?? 0;
  const dormant = isDormantDehydratedHibernating(person);
  const heat = stage('heat');
  const cold = Math.max(0, stage('cold') - (environment.fireProtected ? 2 : 0));
  const illness = stage('illness');
  const pregnancy = stage('pregnancy');
  const postpartum = stage('postpartum-recovery');

  // Preserve the old modifiers as ratios of their old base, so all awake
  // costs now share the same explicit day/portion scale.
  const heatHydrationExtra = (heat ? 1.35 * ([1, 1.3, 1.7, 2.2][heat] - 1) : 0)
    + environment.droughtIntensity * 0.18;
  const coldNutritionExtra = cold ? 1.25 * ([1, 1.25, 1.5, 1.8][cold] - 1) * coldHarmMultiplier(person) : 0;
  const hydrationPerDay = dormant ? 0.35 / BODY_DAYS_PER_MONTH
    : BASE_DAILY_HYDRATION_COST * (1.35 + heatHydrationExtra * heatHydrationMultiplier(person)
      + illness * 0.35 + pregnancy * 0.22 + postpartum * 0.12) / 1.35;
  const nutritionPerDay = (dormant ? 0.3 / BODY_DAYS_PER_MONTH
    : BASE_DAILY_NUTRITION_COST * (1.25 + coldNutritionExtra
      + illness * 0.38 + pregnancy * 0.28 + postpartum * 0.18) / 1.25)
    * nutritionMetabolicMultiplier(person);
  return { dormant, hydrationPerDay, nutritionPerDay };
}

/**
 * Consume the elapsed fraction of a month. This changes no action, goal,
 * inventory, condition phase or lifecycle date. Death is settled by the
 * existing world body process after it records this physical cause.
 */
export function settleBodyMetabolism(
  person: PersonState,
  elapsedDays: number,
  environment: BodyMetabolismEnvironment,
) {
  const bodyBefore = { ...person.body };
  const { dormant, hydrationPerDay, nutritionPerDay } = bodyMetabolismRates(person, environment);
  const hydrationCost = hydrationPerDay * elapsedDays;
  const nutritionCost = nutritionPerDay * elapsedDays;
  const hydrationShortageDamage = dormant ? 0 : shortageDamage(bodyBefore.hydration, hydrationPerDay, elapsedDays, 7);
  const nutritionShortageDamage = dormant ? 0 : shortageDamage(bodyBefore.nutrition, nutritionPerDay, elapsedDays, 6);
  const dormantHealthCost = dormant
    ? (0.25 + (environment.severeChaoticClimate ? 0.15 : 0)) * elapsedDays / BODY_DAYS_PER_MONTH : 0;
  person.body.hydration = clampReserve(bodyBefore.hydration - hydrationCost);
  person.body.nutrition = clampReserve(bodyBefore.nutrition - nutritionCost);
  person.body.health = clampReserve(bodyBefore.health - hydrationShortageDamage - nutritionShortageDamage - dormantHealthCost);

  return {
    elapsedDays,
    metabolicProfile: dormant ? 'dormant' as const : 'awake' as const,
    hydrationCost, nutritionCost, hydrationShortageDamage, nutritionShortageDamage, dormantHealthCost,
    bodyBefore,
    bodyAfter: { ...person.body },
    healthDelta: person.body.health - bodyBefore.health,
    hydrationDelta: person.body.hydration - bodyBefore.hydration,
    nutritionDelta: person.body.nutrition - bodyBefore.nutrition,
    bodyCauseCodes: [
      'elapsed-metabolism',
      ...(hydrationShortageDamage > 0 ? ['dehydration'] : []),
      ...(nutritionShortageDamage > 0 ? ['malnutrition'] : []),
      ...(dormant ? ['dehydrated-hibernation'] : []),
    ],
  };
}
