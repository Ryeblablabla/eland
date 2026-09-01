import { Material, type MaterialId } from './material';
import {
  actionFactsForPerson,
  compareWorldEventsInCanonicalOrder,
} from './event-index';
import type { ActionFact, DecisionAuthorityState, SimulationState } from './model';
import type { ItemStack, PersonId, PersonState } from './person';

export const RECENT_PERSONAL_PRODUCTION_MONTHS = 12;

/** Production-only capability. Weapons such as Spear are intentionally absent. */
const PRODUCTION_TOOL_SPECS = new Map<MaterialId, { rank: number; multiplier: number }>([
  [Material.WoodTool, { rank: 1, multiplier: 1.4 }],
  [Material.BoneTool, { rank: 1, multiplier: 1.4 }],
  [Material.StoneTool, { rank: 2, multiplier: 1.7 }],
  [Material.StoneHoe, { rank: 3, multiplier: 1.9 }],
  [Material.BronzeTool, { rank: 4, multiplier: 2.5 }],
  [Material.IronTool, { rank: 5, multiplier: 3.1 }],
]);

const HUNTING_TOOL_BONUSES = new Map<MaterialId, number>([
  [Material.BoneTool, 0.11],
  [Material.StoneTool, 0.16],
  [Material.StoneHoe, 0.16],
  [Material.Spear, 0.3],
  [Material.BronzeTool, 0.38],
  [Material.IronTool, 0.48],
]);

export function productionToolRank(materialId: MaterialId): number {
  return PRODUCTION_TOOL_SPECS.get(materialId)?.rank ?? 0;
}

export function productionToolMultiplier(materialId: MaterialId | undefined): number {
  return materialId === undefined ? 1 : PRODUCTION_TOOL_SPECS.get(materialId)?.multiplier ?? 1;
}

export function isProductionToolMaterial(materialId: MaterialId): boolean {
  return productionToolRank(materialId) > 0;
}

export function bestProductionToolStack(person: PersonState): ItemStack | undefined {
  return person.inventory
    .filter((stack) => stack.quantity > 0 && isProductionToolMaterial(stack.materialId))
    .sort((left, right) => productionToolRank(right.materialId) - productionToolRank(left.materialId)
      || left.id.localeCompare(right.id))[0];
}

export function huntingToolBonus(materialId: MaterialId | undefined): number {
  return materialId === undefined ? 0 : HUNTING_TOOL_BONUSES.get(materialId) ?? 0;
}

export function bestHuntingToolStack(person: PersonState): ItemStack | undefined {
  return person.inventory
    .filter((stack) => stack.quantity > 0 && huntingToolBonus(stack.materialId) > 0)
    .sort((left, right) => huntingToolBonus(right.materialId) - huntingToolBonus(left.materialId)
      || left.id.localeCompare(right.id))[0];
}

export function isCompletedPersonalProductionLaborEvent(
  event: SimulationState['world']['past'][number],
  personId: PersonId,
): event is ActionFact {
  if (event.kind !== 'action'
    || event.who !== personId
    || event.status !== 'completed'
    || event.action.kind !== 'act'
    || event.action.operation !== 'separate') return false;
  const outputs = event.diff.outputs;
  return typeof event.diff.sourceMaterialId === 'number'
    && Array.isArray(outputs)
    && outputs.some((output) => Boolean(output)
      && typeof output === 'object'
      && typeof (output as { materialId?: unknown }).materialId === 'number'
      && typeof (output as { quantity?: unknown }).quantity === 'number'
      && Number((output as { quantity: number }).quantity) > 0);
}

/** Replayable evidence that this exact person recently completed material-producing labor. */
export function recentPersonalProductionLaborEvents(
  state: Pick<DecisionAuthorityState, 'clock' | 'world'>,
  personId: PersonId,
  atMonth = state.clock.elapsedMonths,
  maxAgeMonths = RECENT_PERSONAL_PRODUCTION_MONTHS,
): ActionFact[] {
  const earliestMonth = atMonth - maxAgeMonths;
  const latest = actionFactsForPerson(state, personId).filter((event) => event.atMonth >= earliestMonth
    && event.atMonth <= atMonth
    && isCompletedPersonalProductionLaborEvent(event, personId))
    .sort(compareWorldEventsInCanonicalOrder)
    .at(-1);
  return latest ? [latest] : [];
}
