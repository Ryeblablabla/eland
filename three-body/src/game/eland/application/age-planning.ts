import type { ActionOption } from '../domain/action';
import type { LifePlanningStage } from '../domain/life-stage';

const CHILD_SIMPLE_OPTION_PREFIXES = [
  'collect:',
  'eat:',
  'drink:',
  'harvest:',
  'separate:wood:',
  'share:',
  'care:',
  'shelter:',
  'attend:',
  'attend-animal:',
  'verify-technique:',
  'follow-parent:',
] as const;

const ADOLESCENT_RESTRICTED_PREFIXES = [
  'predict-era:',
  'offer-reproduce:',
  'accept-reproduce:',
  'reject-reproduce:',
  'reproduce:',
  'offer-collective:',
  'accept-collective:',
  'reject-collective:',
  'offer-membership:',
  'accept-membership:',
  'reject-membership:',
  'offer-decision-rule:',
  'accept-decision-rule:',
  'reject-decision-rule:',
  'offer-mandate:',
  'accept-mandate:',
  'reject-mandate:',
  'offer-permission:',
  'accept-permission:',
  'reject-permission:',
  'contribute-mandate:',
  'distribute-mandate:',
  'use-permission:',
  'withdraw-collective:',
] as const;

export function optionAllowedForLifeStage(stage: LifePlanningStage, option: ActionOption): boolean {
  if (stage === 'adult') return true;
  if (stage === 'dependent-child') return false;
  if (stage === 'learning-child') {
    if (option.projectId || option.projectProposal || option.domain === 'social' || option.relationshipBasis) return false;
    return CHILD_SIMPLE_OPTION_PREFIXES.some((prefix) => option.id.startsWith(prefix));
  }
  if (option.projectProposal) return false;
  if (option.relationshipBasis?.kind === 'reproduce') return false;
  return !ADOLESCENT_RESTRICTED_PREFIXES.some((prefix) => option.id.startsWith(prefix));
}
