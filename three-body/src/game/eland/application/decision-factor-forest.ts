import type { ActionOption } from '../domain/action';
import type { DecisionContext } from '../domain/model';
import { seededFraction } from '../world/generator';
import {
  evaluateCognitiveOption,
  type CognitiveFactorName,
  type CognitiveOptionAppraisal,
} from './cognition/option-appraisal';

/**
 * Compatibility projection for reports and older focused tests.
 *
 * The planner no longer adds nine global scores. Each value below is a
 * diagnostic view of causal-BDI appraisal; `causalScore` is the distance from
 * this person's current aspiration threshold.
 */
export interface DecisionFactorVote {
  tree: CognitiveFactorName;
  score: number;
  reasons: string[];
  sourceFactIds: string[];
}

export interface DecisionFactorEvaluation {
  option: ActionOption;
  causalScore: number;
  score: number;
  votes: DecisionFactorVote[];
  tieBreak: number;
  appraisal: CognitiveOptionAppraisal;
}

export interface DecisionFactorMoment {
  atMonth: number;
  planningTick: number;
}

export function evaluateDecisionOption(
  context: DecisionContext,
  option: ActionOption,
  moment: DecisionFactorMoment,
): DecisionFactorEvaluation {
  const appraisal = evaluateCognitiveOption(context, option, moment);
  const votes = appraisal.factors.map((item): DecisionFactorVote => ({
    tree: item.kind,
    score: item.value,
    reasons: item.reasons,
    sourceFactIds: item.sourceFactIds,
  }));
  const tieBreak = seededFraction(
    context.state.seed,
    `causal-bdi-compat-tie:${context.state.branchId}:${moment.atMonth}:${moment.planningTick}:${context.person.id}:${option.id}`,
  ) * 0.01;
  return {
    option,
    votes,
    tieBreak,
    causalScore: appraisal.causalScore,
    score: appraisal.causalScore + tieBreak,
    appraisal,
  };
}

/** @deprecated Prefer rankCognitiveOptions/deliberate from cognition/bdi-deliberation. */
export function rankByDecisionFactorForest(
  context: DecisionContext,
  options: ActionOption[],
  moment: DecisionFactorMoment,
): DecisionFactorEvaluation[] {
  return options
    .map((option) => evaluateDecisionOption(context, option, moment))
    .sort((left, right) => right.score - left.score || left.option.id.localeCompare(right.option.id));
}
