import type { ActionOption, PrimitiveAction } from '../domain/action';
import type { LifePlanningStage } from '../domain/life-stage';
import type { SimulationState } from '../domain/model';
import { isAlive, type PersonState } from '../domain/person';
import { cellsInRadius } from '../world/grid';
import { actionOptionSemantics } from '../domain/action-option-semantics';

export function optionAllowedForLifeStage(stage: LifePlanningStage, option: ActionOption): boolean {
  if (stage === 'adult') return true;
  if (stage === 'dependent-child') return false;
  const minimum = actionOptionSemantics(option).minimumLifeStage;
  if (stage === 'learning-child') {
    return minimum === 'learning-child';
  }
  if (option.projectProposal) return false;
  return minimum !== 'adult';
}

function learningChildVisibleParents(state: SimulationState, child: PersonState): PersonState[] {
  const radius = 4 + Math.floor(child.baselineCapacities.perception / 25);
  const visible = new Set(cellsInRadius(child.position.cellId, radius));
  return state.people.filter((candidate) => child.geneticParents.includes(candidate.id)
    && isAlive(candidate)
    && visible.has(candidate.position.cellId)
    && Math.abs(candidate.position.z - child.position.z) <= radius);
}

/**
 * Simple childhood work remains autonomous, but an ordinary move may not roll
 * from one locally visible object to the next until the child has silently
 * crossed the map. Only currently visible parent positions define this care
 * radius; survival reflexes do not pass through this filter.
 */
export function ordinaryLearningChildActionAllowed(
  state: SimulationState,
  child: PersonState,
  action: PrimitiveAction,
): boolean {
  if (action.kind !== 'move') return true;
  const parents = learningChildVisibleParents(state, child);
  if (!parents.length) return false;
  const radius = 4 + Math.floor(child.baselineCapacities.perception / 25);
  return parents.some((parent) => cellsInRadius(parent.position.cellId, radius).includes(action.toCellId));
}

export function optionAllowedForLearningChildCareRadius(
  state: SimulationState,
  child: PersonState,
  option: ActionOption,
): boolean {
  return ordinaryLearningChildActionAllowed(state, child, option.nextAction);
}
