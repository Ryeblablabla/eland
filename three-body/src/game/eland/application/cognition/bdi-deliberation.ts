import type { ActionOption, Intent } from '../../domain/action';
import {
  cognitiveOutcomeBasisKey,
  outcomeBeliefFor,
  outcomeBeliefSuccess,
} from '../../domain/cognition';
import type { DecisionContext } from '../../domain/model';
import { personalityScore } from '../../domain/personality';
import { seededFraction } from '../../world/generator';
import { projectById } from '../../domain/state-index';
import {
  buildCognitiveFrame,
  type CognitiveFrame,
  type CognitiveOptionAppraisal,
} from './option-appraisal';

export interface RankedCognitiveAppraisal extends CognitiveOptionAppraisal {
  /** Tiny deterministic value used only after the causal appraisal. */
  tieBreak: number;
  rankScore: number;
}

export interface BdiDeliberation {
  frame: CognitiveFrame;
  ranked: RankedCognitiveAppraisal[];
  selected?: RankedCognitiveAppraisal;
  reason: string;
}

export interface IntentionPersistenceAssessment {
  keep: boolean;
  commitment: number;
  challengerStrength: number;
  acuteNeed: number;
  stagnation: number;
  reason: string;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function saturating(value: number, scale: number): number {
  const positive = Math.max(0, value);
  return positive / Math.max(0.0001, positive + scale);
}

function trait(context: DecisionContext, key: Parameters<typeof personalityScore>[1]): number {
  return personalityScore(context.person, key) / 100;
}

export function rankCognitiveOptions(
  context: DecisionContext,
  options: ActionOption[],
  moment: { atMonth: number; planningTick: number },
): RankedCognitiveAppraisal[] {
  const frame = buildCognitiveFrame(context, options, moment);
  return frame.appraisals
    .map((appraisal): RankedCognitiveAppraisal => {
      const tieBreak = seededFraction(
        context.state.seed,
        `causal-bdi-tie:${context.state.branchId}:${moment.atMonth}:${moment.planningTick}:${context.person.id}:${appraisal.basisKey}:${appraisal.option.id}`,
      ) * 0.0001;
      return { ...appraisal, tieBreak, rankScore: appraisal.motivation + tieBreak };
    })
    .sort((left, right) => right.rankScore - left.rankScore || left.option.id.localeCompare(right.option.id));
}

export function deliberate(
  context: DecisionContext,
  options: ActionOption[],
  moment: { atMonth: number; planningTick: number },
): BdiDeliberation {
  const frame = buildCognitiveFrame(context, options, moment);
  const ranked = frame.appraisals
    .map((appraisal): RankedCognitiveAppraisal => {
      const tieBreak = seededFraction(
        context.state.seed,
        `causal-bdi-tie:${context.state.branchId}:${moment.atMonth}:${moment.planningTick}:${context.person.id}:${appraisal.basisKey}:${appraisal.option.id}`,
      ) * 0.0001;
      return { ...appraisal, tieBreak, rankScore: appraisal.motivation + tieBreak };
    })
    .sort((left, right) => right.rankScore - left.rankScore || left.option.id.localeCompare(right.option.id));
  const selected = ranked.find((appraisal) => appraisal.motivation >= appraisal.aspiration);
  const dominant = frame.needs[0];
  return {
    frame,
    ranked,
    ...(selected ? { selected } : {}),
    reason: selected
      ? `${dominant ? `当前最强需要是${dominant.kind}` : '当前出现有来源的机会'}；${selected.reasons.slice(0, 2).join('；')}`
      : options.length
        ? '现有候选都没有跨过本人的当前行动阈值'
        : '当前没有合法候选',
  };
}

function sameIntention(active: Intent, challenger?: CognitiveOptionAppraisal): boolean {
  if (!challenger) return false;
  if (active.projectId && challenger.option.projectId === active.projectId) return true;
  return active.goal.kind === challenger.option.goal.kind
    && active.nextAction.kind === challenger.option.nextAction.kind;
}

/**
 * BDI intention inertia. A current intention is not rescored from scratch on
 * every tick; only an acute need, objective expiry, or sufficiently strong and
 * different challenger can replace it.
 */
export function assessIntentionPersistence(
  context: DecisionContext,
  active: Intent,
  challenger: CognitiveOptionAppraisal | undefined,
  moment: { atMonth: number; planningTick: number },
): IntentionPersistenceAssessment {
  if (sameIntention(active, challenger)) return {
    keep: true,
    commitment: 1,
    challengerStrength: challenger?.motivation ?? 0,
    acuteNeed: 0,
    stagnation: 0,
    reason: '当前最佳步骤仍属于同一长期意图，继续执行而不重建意图',
  };
  const project = active.projectId
    ? projectById(context.state, active.projectId)
    : undefined;
  const belief = outcomeBeliefFor(context.person, cognitiveOutcomeBasisKey(active.nextAction, active.goal));
  const successExpectation = outcomeBeliefSuccess(belief);
  const progressAnchor = Math.max(active.lastProgressAtMonth, active.lastResumedAtMonth ?? active.lastProgressAtMonth);
  const stalledMonths = Math.max(0, moment.atMonth - progressAnchor);
  const stagnation = saturating(stalledMonths, 3);
  const commitment = clamp(
    0.2
      + trait(context, 'conscientiousness') * 0.25
      + active.progress * 0.2
      + (project?.pressure ?? 0) / 400
      + successExpectation * 0.12
      - stagnation * 0.38,
  );
  const frame = buildCognitiveFrame(context, challenger ? [challenger.option] : [], moment);
  const acuteNeed = frame.needs
    .filter((need) => need.kind === 'homeostasis' || need.kind === 'safety' || need.kind === 'care' || need.kind === 'bereavement')
    .reduce((maximum, need) => Math.max(maximum, need.urgency), 0);
  const challengerStrength = challenger?.motivation ?? 0;
  const overdue = active.stateGoalUntilMonth !== undefined && moment.atMonth > active.stateGoalUntilMonth;
  const switchingMargin = 0.07
    + trait(context, 'conscientiousness') * 0.12
    - trait(context, 'openness') * 0.045;
  const acuteOverride = acuteNeed >= 0.7 && challengerStrength >= (challenger?.aspiration ?? 0);
  const stalledOverride = stagnation >= 0.5 && challengerStrength >= (challenger?.aspiration ?? 1);
  const strongerAlternative = challengerStrength > commitment + switchingMargin;
  const keep = !overdue && !acuteOverride && !stalledOverride && !strongerAlternative;
  return {
    keep,
    commitment,
    challengerStrength,
    acuteNeed,
    stagnation,
    reason: overdue
      ? '长期状态的复核期限已过'
      : acuteOverride
        ? '新的身体、安全、照护或强烈悲恸需要已经压过当前意图'
        : stalledOverride
          ? '当前意图持续缺少进展，而另一合法方案跨过行动阈值'
          : strongerAlternative
            ? '另一项有来源的需要明显强于当前承诺'
            : '当前意图的进度、人格承诺和经验预期仍足以维持投入',
  };
}
