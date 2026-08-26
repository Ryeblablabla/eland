export const MAX_LOOKAHEAD_ROOTS = 4;
export const MAX_LOOKAHEAD_DEPTH = 3;
export const MAX_LOOKAHEAD_CHILDREN = 2;
export const MAX_LOOKAHEAD_NODES = 24;

const FUTURE_DISCOUNT = 0.72;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * One consequence the person can currently name. Values are subjective and
 * source-bound; this tree is never an alternate execution engine.
 */
export interface KnownForesightNode {
  key: string;
  kind:
    | 'current-action'
    | 'known-follow-up'
    | 'response'
    | 'no-response'
    | 'verification'
    | 'replan';
  /** Local expected usefulness in the -1..1 range. */
  value: number;
  /** Conditional probability among siblings. Omit for a deterministic step. */
  probability?: number;
  sourceFactIds: string[];
  children?: KnownForesightNode[];
}

export interface KnownForesightRoot {
  optionId: string;
  baseMotivation: number;
  node: KnownForesightNode;
}

export interface BoundedForesightRootAudit {
  optionId: string;
  expectedValue: number;
  expandedNodes: number;
  depth: number;
  budgetCutoff: boolean;
  sourceFactIds: string[];
}

export interface BoundedForesightAudit {
  version: 'bounded-foresight-v1';
  rootCount: number;
  expandedNodes: number;
  maxDepth: number;
  budgetCutoff: boolean;
  roots: BoundedForesightRootAudit[];
}

interface ExpansionBudget {
  remaining: number;
}

interface EvaluatedNode {
  expectedValue: number;
  expandedNodes: number;
  depth: number;
  budgetCutoff: boolean;
  sourceFactIds: string[];
}

function normalizedChildren(node: KnownForesightNode): KnownForesightNode[] {
  return [...(node.children ?? [])]
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, MAX_LOOKAHEAD_CHILDREN);
}

function evaluateNode(
  node: KnownForesightNode,
  depth: number,
  budget: ExpansionBudget,
): EvaluatedNode {
  if (budget.remaining <= 0) return {
    expectedValue: 0,
    expandedNodes: 0,
    depth: Math.max(0, depth - 1),
    budgetCutoff: true,
    sourceFactIds: [],
  };
  budget.remaining -= 1;
  const immediate = clamp(finite(node.value), -1, 1);
  const sources = new Set(node.sourceFactIds);
  if (depth >= MAX_LOOKAHEAD_DEPTH) return {
    expectedValue: immediate,
    expandedNodes: 1,
    depth,
    budgetCutoff: Boolean(node.children?.length),
    sourceFactIds: [...sources].slice(-24),
  };

  const children = normalizedChildren(node);
  if (!children.length) return {
    expectedValue: immediate,
    expandedNodes: 1,
    depth,
    budgetCutoff: false,
    sourceFactIds: [...sources].slice(-24),
  };

  const evaluated = children.map((child) => {
    const result = evaluateNode(child, depth + 1, budget);
    result.sourceFactIds.forEach((eventId) => sources.add(eventId));
    return { child, result };
  });
  const explicitProbabilities = evaluated.map(({ child }) => Math.max(0, finite(child.probability ?? 0)));
  const explicitTotal = explicitProbabilities.reduce((sum, probability) => sum + probability, 0);
  const conditionalValues = evaluated.map(({ result }) => result.expectedValue);
  const continuation = explicitTotal > 0
    ? evaluated.reduce((sum, { result }, index) => (
        sum + result.expectedValue * explicitProbabilities[index]! / explicitTotal
      ), 0)
    : conditionalValues.reduce((sum, value) => sum + value, 0) / Math.max(1, conditionalValues.length);
  return {
    expectedValue: clamp(immediate + FUTURE_DISCOUNT * continuation, -1, 1),
    expandedNodes: 1 + evaluated.reduce((sum, { result }) => sum + result.expandedNodes, 0),
    depth: Math.max(depth, ...evaluated.map(({ result }) => result.depth)),
    budgetCutoff: evaluated.some(({ result }) => result.budgetCutoff),
    sourceFactIds: [...sources].slice(-24),
  };
}

/** Expand only the strongest cheap one-step candidates under one global budget. */
export function evaluateBoundedForesight(
  roots: readonly KnownForesightRoot[],
): BoundedForesightAudit {
  const selected = [...roots]
    .sort((left, right) => right.baseMotivation - left.baseMotivation
      || left.optionId.localeCompare(right.optionId))
    .slice(0, MAX_LOOKAHEAD_ROOTS);
  const budget: ExpansionBudget = { remaining: MAX_LOOKAHEAD_NODES };
  const audits: BoundedForesightRootAudit[] = [];
  for (const root of selected) {
    if (budget.remaining <= 0) break;
    const evaluated = evaluateNode(root.node, 1, budget);
    audits.push({
      optionId: root.optionId,
      expectedValue: evaluated.expectedValue,
      expandedNodes: evaluated.expandedNodes,
      depth: evaluated.depth,
      budgetCutoff: evaluated.budgetCutoff,
      sourceFactIds: evaluated.sourceFactIds,
    });
  }
  const expandedNodes = audits.reduce((sum, audit) => sum + audit.expandedNodes, 0);
  return {
    version: 'bounded-foresight-v1',
    rootCount: audits.length,
    expandedNodes,
    maxDepth: audits.reduce((maximum, audit) => Math.max(maximum, audit.depth), 0),
    budgetCutoff: audits.some((audit) => audit.budgetCutoff)
      || selected.length < roots.length
      || expandedNodes >= MAX_LOOKAHEAD_NODES,
    roots: audits,
  };
}

export interface BinaryInformationValueInput {
  liveDilemma: boolean;
  hasAlternative: boolean;
  responseProbability: number;
  responseContinuationValue: number;
  noResponseContinuationValue: number;
  bestAlternativeValue: number;
  currentCommitmentValue: number;
  relevance: number;
  experimentCost: number;
}

export interface BinaryInformationValue {
  value: number;
  changesNextChoice: boolean;
  withoutObservation: number;
  withObservation: number;
}

/**
 * Information is valuable only when the two observable outcomes would produce
 * different next choices. It cannot receive a generic inquiry bonus.
 */
export function binaryValueOfInformation(
  input: BinaryInformationValueInput,
): BinaryInformationValue {
  const bestAlternative = clamp(finite(input.bestAlternativeValue), -1, 1);
  const current = clamp(finite(input.currentCommitmentValue), -1, 1);
  const response = clamp(finite(input.responseContinuationValue), -1, 1);
  const noResponse = clamp(finite(input.noResponseContinuationValue), -1, 1);
  const probability = clamp(finite(input.responseProbability, 0.5));
  const withoutObservation = Math.max(current, bestAlternative);
  const responseChoosesContinuation = response > bestAlternative;
  const noResponseChoosesContinuation = noResponse > bestAlternative;
  const changesNextChoice = responseChoosesContinuation !== noResponseChoosesContinuation;
  if (!input.liveDilemma || !input.hasAlternative || !changesNextChoice) return {
    value: 0,
    changesNextChoice: false,
    withoutObservation,
    withObservation: withoutObservation,
  };
  const withObservation = probability * Math.max(response, bestAlternative)
    + (1 - probability) * Math.max(noResponse, bestAlternative);
  const gross = Math.max(0, withObservation - withoutObservation) * clamp(input.relevance);
  const value = clamp(gross - Math.max(0, finite(input.experimentCost)), 0, 0.2);
  return { value, changesNextChoice: value > 0, withoutObservation, withObservation };
}
