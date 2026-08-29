import type { ActionOption, Intent } from '../../domain/action';
import {
  cognitiveOutcomeBasisKey,
  outcomeBeliefFor,
  outcomeBeliefSuccess,
} from '../../domain/cognition';
import type { Decision, DecisionContext } from '../../domain/model';
import { intentReviewAtMonth } from '../../domain/intent';
import { personalityScore } from '../../domain/personality';
import { seededFraction } from '../../world/generator';
import { projectById } from '../../domain/state-index';
import {
  buildCognitiveFrame,
  type CognitiveFrame,
  type CognitiveOptionAppraisal,
} from './option-appraisal';
import {
  compareBoundedForesight,
  type BoundedForesightComparison,
} from './foresight-deliberation';
import { currentRecordUseProject } from './record-use-project';

export interface RankedCognitiveAppraisal extends CognitiveOptionAppraisal {
  /** Tiny deterministic value used only after the causal appraisal. */
  tieBreak: number;
  foresightExpectedValue: number;
  valueOfInformation: number;
  foresightAdjustment: number;
  deliberativeMotivation: number;
  rankScore: number;
}

export interface BdiDeliberation {
  frame: CognitiveFrame;
  ranked: RankedCognitiveAppraisal[];
  foresight: BoundedForesightComparison;
  selected?: RankedCognitiveAppraisal;
  reason: string;
}

interface DecisionDeliberationHandoff {
  personId: string;
  atMonth: number;
  planningTick: number;
  optionId: string;
  deliberation: BdiDeliberation;
}

/**
 * Ephemeral, non-enumerable handoff from the rule planner to decision
 * execution. It is attached to the exact Decision object, never serialized,
 * and consumed before that decision becomes a world fact.
 */
const DECISION_DELIBERATION_HANDOFF = Symbol('decision-deliberation-handoff');
type DecisionWithDeliberation = Decision & {
  [DECISION_DELIBERATION_HANDOFF]?: DecisionDeliberationHandoff;
};

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
  const foresight = compareBoundedForesight(context, frame);
  return rankAppraisals(context, frame, foresight, moment);
}

function noForesightComparison(): BoundedForesightComparison {
  return {
    version: 'bounded-foresight-comparison-v1',
    audit: {
      version: 'bounded-foresight-v1',
      rootCount: 0,
      expandedNodes: 0,
      maxDepth: 0,
      budgetCutoff: false,
      roots: [],
    },
    options: [],
    changedSelection: false,
  };
}

/** Rank an already forced duty or a follow-up without opening a future tree. */
export function rankCognitiveOptionsWithoutForesight(
  context: DecisionContext,
  options: ActionOption[],
  moment: { atMonth: number; planningTick: number },
): RankedCognitiveAppraisal[] {
  const frame = buildCognitiveFrame(context, options, moment);
  return rankAppraisals(context, frame, noForesightComparison(), moment);
}

function rankAppraisals(
  context: DecisionContext,
  frame: CognitiveFrame,
  foresight: BoundedForesightComparison,
  moment: { atMonth: number; planningTick: number },
): RankedCognitiveAppraisal[] {
  const foresightByOption = new Map(foresight.options.map((item) => [item.optionId, item]));
  return frame.appraisals
    .map((appraisal): RankedCognitiveAppraisal => {
      const tieBreak = seededFraction(
        context.state.seed,
        `causal-bdi-tie:${context.state.branchId}:${moment.atMonth}:${moment.planningTick}:${context.person.id}:${appraisal.basisKey}:${appraisal.option.id}`,
      ) * 0.0001;
      const bounded = foresightByOption.get(appraisal.option.id);
      const foresightAdjustment = bounded?.adjustment ?? 0;
      const deliberativeMotivation = appraisal.motivation + foresightAdjustment;
      return {
        ...appraisal,
        tieBreak,
        foresightExpectedValue: bounded?.expectedValue ?? 0,
        valueOfInformation: bounded?.valueOfInformation ?? 0,
        foresightAdjustment,
        deliberativeMotivation,
        rankScore: deliberativeMotivation + tieBreak,
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore || left.option.id.localeCompare(right.option.id));
}

export function deliberate(
  context: DecisionContext,
  options: ActionOption[],
  moment: { atMonth: number; planningTick: number },
): BdiDeliberation {
  const frame = buildCognitiveFrame(context, options, moment);
  const foresight = compareBoundedForesight(context, frame);
  const ranked = rankAppraisals(context, frame, foresight, moment);
  const selected = ranked.find((appraisal) => appraisal.deliberativeMotivation >= appraisal.aspiration);
  const dominant = frame.needs[0];
  return {
    frame,
    ranked,
    foresight,
    ...(selected ? { selected } : {}),
    reason: selected
      ? `${dominant ? `当前最强需要是${dominant.kind}` : '当前出现有来源的机会'}；${selected.reasons.slice(0, 2).join('；')}`
      : options.length
        ? '现有候选都没有跨过本人的当前行动阈值'
        : '当前没有合法候选',
  };
}

/**
 * Carry the exact selection-time deliberation into applyDecision without
 * adding it to the persisted Decision schema.
 */
export function carryDecisionDeliberation<T extends Decision>(
  decision: T,
  context: DecisionContext,
  moment: { atMonth: number; planningTick: number },
  deliberation: BdiDeliberation,
): T {
  if (decision.kind !== 'start' && decision.kind !== 'revise') return decision;
  if (deliberation.selected?.option.id !== decision.optionId) return decision;
  Object.defineProperty(decision, DECISION_DELIBERATION_HANDOFF, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: {
      personId: context.person.id,
      atMonth: moment.atMonth,
      planningTick: moment.planningTick,
      optionId: decision.optionId,
      deliberation,
    } satisfies DecisionDeliberationHandoff,
  });
  return decision;
}

/** Consume the transient handoff before the Decision object enters history. */
export function takeDecisionDeliberation(
  decision: Decision,
  personId: string,
  moment: { atMonth: number; planningTick: number },
): BdiDeliberation | undefined {
  const tagged = decision as DecisionWithDeliberation;
  const handoff = tagged[DECISION_DELIBERATION_HANDOFF];
  if (handoff) delete tagged[DECISION_DELIBERATION_HANDOFF];
  if (!handoff
    || (decision.kind !== 'start' && decision.kind !== 'revise')
    || handoff.personId !== personId
    || handoff.atMonth !== moment.atMonth
    || handoff.planningTick !== moment.planningTick
    || handoff.optionId !== decision.optionId) return undefined;
  return handoff.deliberation;
}

function sameIntention(
  context: DecisionContext,
  active: Intent,
  challenger?: CognitiveOptionAppraisal,
): boolean {
  if (!challenger) return false;
  const challengerProjectId = challenger.option.recordUseBasis
    ? currentRecordUseProject(context, challenger.option)?.id
    : challenger.option.projectId;
  if (active.projectId && challengerProjectId === active.projectId) return true;
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
  if (sameIntention(context, active, challenger)) return {
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
  const challengerStrength = challenger
    ? (challenger as Partial<RankedCognitiveAppraisal>).deliberativeMotivation ?? challenger.motivation
    : 0;
  const reviewAtMonth = intentReviewAtMonth(active);
  const overdue = reviewAtMonth !== undefined && moment.atMonth > reviewAtMonth;
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
      ? '当前意图的有界复核期限已过'
      : acuteOverride
        ? '新的身体、安全、照护或强烈悲恸需要已经压过当前意图'
        : stalledOverride
          ? '当前意图持续缺少进展，而另一合法方案跨过行动阈值'
          : strongerAlternative
            ? '另一项有来源的需要明显强于当前承诺'
            : '当前意图的进度、人格承诺和经验预期仍足以维持投入',
  };
}
