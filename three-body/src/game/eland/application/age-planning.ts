import type { ActionOption } from '../domain/action';
import type { LifePlanningStage } from '../domain/life-stage';
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
