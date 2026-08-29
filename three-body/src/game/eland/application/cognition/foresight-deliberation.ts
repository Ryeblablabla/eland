import type { ActionOption, PrimitiveAction } from '../../domain/action';
import { actionOptionSemantics } from '../../domain/action-option-semantics';
import type { DecisionContext } from '../../domain/model';
import type { ProjectHypothesisCampaign } from '../../domain/project';
import { projectById } from '../../domain/state-index';
import {
  binaryValueOfInformation,
  evaluateBoundedForesight,
  type BoundedForesightAudit,
  type KnownForesightNode,
  type KnownForesightRoot,
} from './bounded-foresight';
import type { CognitiveFrame, CognitiveOptionAppraisal } from './option-appraisal';
import { currentRecordUseProject } from './record-use-project';

const MAX_FORESIGHT_ADJUSTMENT = 0.08;
const MAX_INFORMATION_ADJUSTMENT = 0.04;
const ACUTE_NEED_THRESHOLD = 0.7;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function executionAction(option: ActionOption): PrimitiveAction {
  return option.completionAction ?? option.nextAction;
}

function utility(appraisal: CognitiveOptionAppraisal): number {
  return clamp((appraisal.motivation - appraisal.aspiration) * 4, -1, 1);
}

function boundedSources(sourceFactIds: readonly string[]): string[] {
  return [...new Set(sourceFactIds.filter((eventId) => eventId.length > 0))].slice(-24);
}

interface HypothesisOutlook {
  campaign: ProjectHypothesisCampaign;
  responseProbability: number;
  sourceFactIds: string[];
}

/**
 * Match only an already active, person-local experiment campaign to the typed
 * primitive action being considered. The campaign records observed attempts;
 * this function deliberately never reads an output material or a world rule.
 */
function hypothesisOutlook(
  context: DecisionContext,
  appraisal: CognitiveOptionAppraisal,
): HypothesisOutlook | undefined {
  const project = appraisal.option.recordUseBasis
    ? currentRecordUseProject(context, appraisal.option)
    : appraisal.option.projectId
      ? projectById(context.state, appraisal.option.projectId)
      : undefined;
  const campaign = project?.hypothesisCampaign;
  if (!campaign || campaign.status !== 'active' || campaign.actorId !== context.person.id) return undefined;
  const activeCandidate = campaign.activeCandidateKey
    ? campaign.candidates.find((candidate) => candidate.key === campaign.activeCandidateKey)
    : undefined;
  if (!activeCandidate) return undefined;
  const action = executionAction(appraisal.option);
  const operationMatches = action.kind === 'act'
    && ((activeCandidate.operation === 'combine-inventory' && action.operation === 'combine')
      || (activeCandidate.operation === 'exert-air' && action.operation === 'exert')
      || (activeCandidate.operation === 'expose-local' && action.operation === 'expose'));
  if (!operationMatches) return undefined;
  const comparableAttempts = campaign.attempts.filter((attempt) => (
    attempt.operation === activeCandidate.operation
    && attempt.questionKind === activeCandidate.questionKind
  ));
  const responses = comparableAttempts.filter((attempt) => attempt.outcome === 'response').length;
  return {
    campaign,
    responseProbability: (responses + 1) / (comparableAttempts.length + 2),
    sourceFactIds: boundedSources([
      ...campaign.sourceFactIds,
      ...activeCandidate.sourceFactIds,
      ...comparableAttempts.flatMap((attempt) => [attempt.eventId, ...attempt.sourceFactIds]),
    ]),
  };
}

function namedRoot(
  appraisal: CognitiveOptionAppraisal,
  alternative: CognitiveOptionAppraisal | undefined,
  outlook: HypothesisOutlook | undefined,
): KnownForesightRoot {
  const currentUtility = utility(appraisal);
  const alternativeUtility = alternative ? utility(alternative) : currentUtility;
  const probability = outlook?.responseProbability ?? appraisal.expectedSuccess;
  const sources = boundedSources([
    ...appraisal.sourceFactIds,
    ...(outlook?.sourceFactIds ?? []),
  ]);
  const positiveContinuation = clamp(
    currentUtility + 0.16 + appraisal.needActivation * 0.14 - appraisal.expectedEffort * 0.08,
    -1,
    1,
  );
  const negativeContinuation = clamp(
    currentUtility - 0.16 - appraisal.expectedEffort * 0.18 - appraisal.expectedHarm * 0.35,
    -1,
    1,
  );
  const response: KnownForesightNode = {
    key: `${appraisal.basisKey}:observable-progress`,
    kind: 'response',
    value: positiveContinuation,
    probability,
    sourceFactIds: sources,
    ...(outlook ? {
      children: [{
        key: `${appraisal.basisKey}:verify-observed-response`,
        kind: 'verification',
        value: clamp(positiveContinuation + appraisal.uncertainty * 0.12, -1, 1),
        sourceFactIds: sources,
      }],
    } : {}),
  };
  const noResponse: KnownForesightNode = {
    key: `${appraisal.basisKey}:no-observable-progress`,
    kind: 'no-response',
    value: negativeContinuation,
    probability: 1 - probability,
    sourceFactIds: sources,
    children: [{
      key: `${appraisal.basisKey}:bounded-replan`,
      kind: 'replan',
      value: alternativeUtility,
      sourceFactIds: boundedSources(alternative?.sourceFactIds ?? sources),
    }],
  };
  return {
    optionId: appraisal.option.id,
    baseMotivation: appraisal.motivation,
    node: {
      key: `${appraisal.basisKey}:current-action`,
      kind: 'current-action',
      value: 0,
      sourceFactIds: sources,
      children: [response, noResponse],
    },
  };
}

export interface OptionForesightAdjustment {
  optionId: string;
  expectedValue: number;
  valueOfInformation: number;
  changesNextChoiceAfterObservation: boolean;
  adjustment: number;
  sourceFactIds: string[];
}

export interface BoundedForesightComparison {
  version: 'bounded-foresight-comparison-v1';
  audit: BoundedForesightAudit;
  options: OptionForesightAdjustment[];
  baseSelectedOptionId?: string;
  adjustedSelectedOptionId?: string;
  changedSelection: boolean;
}

function selectedOptionId(
  appraisals: readonly CognitiveOptionAppraisal[],
  adjustmentByOption: ReadonlyMap<string, number>,
): string | undefined {
  return [...appraisals]
    .sort((left, right) => (
      right.motivation + (adjustmentByOption.get(right.option.id) ?? 0)
      - left.motivation - (adjustmentByOption.get(left.option.id) ?? 0)
      || left.option.id.localeCompare(right.option.id)
    ))
    .find((appraisal) => (
      appraisal.motivation + (adjustmentByOption.get(appraisal.option.id) ?? 0)
      >= appraisal.aspiration
    ))?.option.id;
}

function isAcuteOption(appraisal: CognitiveOptionAppraisal): boolean {
  const acuteKinds = new Set(['homeostasis', 'safety', 'care']);
  return appraisal.needAlignments.some((alignment) => acuteKinds.has(alignment.kind));
}

/**
 * Compare a bounded set of subjective continuations after cheap one-step BDI
 * appraisal. This is a soft ranking layer only; it cannot add an option or
 * bypass legality, required responses, commitments, or acute survival.
 */
export function compareBoundedForesight(
  context: DecisionContext,
  frame: CognitiveFrame,
): BoundedForesightComparison {
  const ordered = [...frame.appraisals].sort((left, right) => (
    right.motivation - left.motivation || left.option.id.localeCompare(right.option.id)
  ));
  const roots = ordered.map((appraisal) => {
    const alternative = ordered.find((candidate) => candidate.option.id !== appraisal.option.id);
    return namedRoot(appraisal, alternative, hypothesisOutlook(context, appraisal));
  });
  const audit = evaluateBoundedForesight(roots);
  const acuteNeed = frame.needs
    .filter((need) => need.kind === 'homeostasis' || need.kind === 'safety' || need.kind === 'care')
    .reduce((maximum, need) => Math.max(maximum, need.urgency), 0);
  const baseSelectedOptionId = selectedOptionId(frame.appraisals, new Map());
  const adjustments: OptionForesightAdjustment[] = audit.roots.flatMap((rootAudit) => {
    const appraisal = frame.appraisals.find((candidate) => candidate.option.id === rootAudit.optionId);
    if (!appraisal) return [];
    const semantics = actionOptionSemantics(appraisal.option);
    const outlook = hypothesisOutlook(context, appraisal);
    const alternative = ordered.find((candidate) => candidate.option.id !== appraisal.option.id);
    const currentUtility = utility(appraisal);
    const alternativeUtility = alternative ? utility(alternative) : currentUtility;
    const information = outlook
      ? binaryValueOfInformation({
          liveDilemma: Boolean(alternative)
            && appraisal.uncertainty >= 0.25
            && Math.abs(currentUtility - alternativeUtility) <= 0.2,
          hasAlternative: Boolean(alternative),
          responseProbability: outlook.responseProbability,
          responseContinuationValue: clamp(currentUtility + appraisal.uncertainty * 0.36, -1, 1),
          noResponseContinuationValue: clamp(
            currentUtility - appraisal.uncertainty * 0.36 - appraisal.expectedEffort * 0.08,
            -1,
            1,
          ),
          bestAlternativeValue: alternativeUtility,
          currentCommitmentValue: currentUtility,
          relevance: appraisal.uncertainty,
          experimentCost: appraisal.expectedEffort * 0.03 + appraisal.expectedHarm * 0.08,
        })
      : {
          value: 0,
          changesNextChoice: false,
          withoutObservation: currentUtility,
          withObservation: currentUtility,
        };
    let adjustment = clamp(
      rootAudit.expectedValue * MAX_FORESIGHT_ADJUSTMENT,
      -MAX_FORESIGHT_ADJUSTMENT,
      MAX_FORESIGHT_ADJUSTMENT,
    ) + Math.min(MAX_INFORMATION_ADJUSTMENT, information.value * 0.2);
    // Accepted duties keep their existing priority, and acute survival blocks
    // positive imagined value for unrelated options while the crisis is live.
    if (semantics.obligation !== 'optional') adjustment = 0;
    if (acuteNeed >= ACUTE_NEED_THRESHOLD && !isAcuteOption(appraisal)) {
      adjustment = Math.min(0, adjustment);
    }
    return [{
      optionId: appraisal.option.id,
      expectedValue: rootAudit.expectedValue,
      valueOfInformation: information.value,
      changesNextChoiceAfterObservation: information.changesNextChoice,
      adjustment,
      sourceFactIds: boundedSources([
        ...rootAudit.sourceFactIds,
        ...(outlook?.sourceFactIds ?? []),
      ]),
    }];
  });
  const adjustmentByOption = new Map(adjustments.map((item) => [item.optionId, item.adjustment]));
  const adjustedSelectedOptionId = selectedOptionId(frame.appraisals, adjustmentByOption);
  return {
    version: 'bounded-foresight-comparison-v1',
    audit,
    options: adjustments,
    ...(baseSelectedOptionId ? { baseSelectedOptionId } : {}),
    ...(adjustedSelectedOptionId ? { adjustedSelectedOptionId } : {}),
    changedSelection: baseSelectedOptionId !== adjustedSelectedOptionId,
  };
}
