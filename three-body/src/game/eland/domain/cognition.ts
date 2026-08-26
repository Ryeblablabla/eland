import type { FactPredicate, Intent, IntentGoalOutcomeKind, PrimitiveAction } from './action';
import type { ActionFact, SimulationState } from './model';
import type {
  CausalMemoryTrace,
  CognitionState,
  CognitiveOutcome,
  GoalOutcomeBelief,
  NeedResolutionEpisode,
  OutcomeBelief,
  PersonState,
} from './person';
import type { ProjectState } from './project';
import { intentById, personById } from './state-index';

export const COGNITION_VERSION = 'causal-bdi-v1' as const;
const MAX_OUTCOME_BELIEFS = 48;
const MAX_GOAL_OUTCOME_BELIEFS = 48;
const MAX_BELIEF_SOURCES = 24;
const MAX_NEED_RESOLUTION_EPISODES = 24;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function createCognitionState(): CognitionState {
  return {
    version: COGNITION_VERSION,
    outcomeBeliefs: [],
    goalOutcomeBeliefs: [],
    needResolutionEpisodes: [],
  };
}

/** Read-only callers get an empty prior without mutating a legacy state. */
export function cognitionStateOf(person: PersonState): CognitionState {
  if (person.cognition?.version !== COGNITION_VERSION) return createCognitionState();
  return {
    ...person.cognition,
    outcomeBeliefs: person.cognition.outcomeBeliefs ?? [],
    goalOutcomeBeliefs: person.cognition.goalOutcomeBeliefs ?? [],
    needResolutionEpisodes: person.cognition.needResolutionEpisodes ?? [],
  };
}

/** Mutation is reserved for actual experienced outcomes and state hydration. */
export function ensureCognitionState(person: PersonState): CognitionState {
  if (person.cognition?.version !== COGNITION_VERSION) person.cognition = createCognitionState();
  person.cognition.outcomeBeliefs ??= [];
  person.cognition.goalOutcomeBeliefs ??= [];
  person.cognition.needResolutionEpisodes ??= [];
  return person.cognition;
}

function goalFamilyKey(goal?: FactPredicate): string {
  if (!goal) return 'none';
  switch (goal.kind) {
    case 'body-at-least': return `${goal.kind}:${goal.field}`;
    case 'body-at-most': return `${goal.kind}:${goal.field}`;
    case 'inventory-at-least': return `${goal.kind}:material-${goal.materialId}`;
    case 'container-inventory-at-least': return `${goal.kind}:material-${goal.materialId}`;
    case 'record-held': return goal.kind;
    case 'at-cell': return goal.kind;
    case 'sheltered': return goal.kind;
    case 'voxel-is': return `${goal.kind}:material-${goal.materialId}`;
    case 'knowledge': return goal.kind;
    case 'near-person': return goal.kind;
    case 'condition': return `${goal.kind}:${goal.condition}:${goal.present ? 'present' : 'absent'}`;
    case 'project-completed': return goal.kind;
    case 'technique-demonstrated': return goal.kind;
    case 'agreement-fulfilled': return goal.kind;
    case 'death-mourned': return goal.kind;
    case 'remains-interred': return goal.kind;
    case 'memorial-marked': return goal.kind;
    case 'representation-made': return goal.kind;
  }
}

function actionFamilyKey(action: PrimitiveAction): string {
  switch (action.kind) {
    case 'move':
      return 'move';
    case 'transfer':
      return `transfer:material-${action.materialId}:${action.from.kind}->${action.to.kind}:${action.authorizationRef ? 'authorized' : 'unbound'}`;
    case 'act': {
      const targetKinds = [...new Set(action.targets.map((target) => target.kind))].sort().join('+') || 'none';
      return `act:${action.operation}:${targetKinds}${action.mechanicalPowerBasis ? ':mechanical' : ''}`;
    }
    case 'attend':
      return `attend:${action.target.kind}${action.verification ? ':verification' : ''}`;
    case 'communicate': {
      const content = action.content;
      const topic = (content.kind === 'request' || content.kind === 'offer') && content.proposal
        ? `proposal-${content.proposal.kind}`
        : content.kind === 'claim' && content.conversation
          ? `conversation-${content.conversation.topic}`
          : content.kind;
      return `communicate:${topic}:${action.channel}`;
    }
  }
}

/**
 * A semantic learning key deliberately omits option, intent, person, cell and
 * project ids. Experience can therefore transfer to a genuinely similar act
 * without leaking hidden targets or treating a new runtime id as new evidence.
 */
export function cognitiveOutcomeBasisKey(action: PrimitiveAction, goal?: FactPredicate): string {
  return `${COGNITION_VERSION}|${actionFamilyKey(action)}|goal=${goalFamilyKey(goal)}`;
}

export function actionFactOutcomeBasisKey(state: SimulationState, fact: ActionFact): string {
  const intent = fact.intentId ? intentById(state, fact.intentId) : undefined;
  return cognitiveOutcomeBasisKey(fact.action, intent?.goal);
}

function outcomeEvidence(fact: ActionFact): {
  outcome: CognitiveOutcome;
  alpha: number;
  beta: number;
  valence: number;
} {
  if (fact.status === 'completed') return { outcome: 'completed', alpha: 1, beta: 0, valence: 1 };
  if (fact.status === 'failed') return { outcome: 'failed', alpha: 0, beta: 1.25, valence: -1 };
  if (fact.status === 'blocked') return { outcome: 'blocked', alpha: 0, beta: 1, valence: -0.72 };
  const explicitFailure = fact.diff.success === false || fact.diff.killed === false;
  return explicitFailure
    ? { outcome: 'progressed', alpha: 0.1, beta: 0.9, valence: -0.55 }
    : { outcome: 'progressed', alpha: 0.58, beta: 0.42, valence: 0.32 };
}

function experiencedEffort(fact: ActionFact): number {
  const pathEffort = fact.action.kind === 'move' && Number.isFinite(Number(fact.diff.movementCost))
    ? Math.max(0, finite(fact.diff.movementCost)) / 2
    : Math.max(0, fact.pathSegment.length - 1);
  const work = Math.max(0, finite(fact.diff.spentWork));
  return clamp(1 - Math.exp(-(pathEffort + work / 25) / 4));
}

function experiencedHarm(fact: ActionFact): number {
  const direct = Math.max(
    0,
    finite(fact.diff.counterDamage),
    finite(fact.diff.selfDamage),
    fact.diff.victimId === fact.who ? finite(fact.diff.damage) : 0,
  );
  return clamp(1 - Math.exp(-direct / 18));
}

function freshBelief(basisKey: string, atMonth: number): OutcomeBelief {
  return {
    basisKey,
    attempts: 0,
    completed: 0,
    progressed: 0,
    blocked: 0,
    failed: 0,
    successAlpha: 2,
    successBeta: 2,
    expectedEffort: 0,
    expectedHarm: 0,
    lastUpdatedAtMonth: atMonth,
    sourceEventIds: [],
  };
}

export function outcomeBeliefFor(person: PersonState, basisKey: string): OutcomeBelief | undefined {
  return cognitionStateOf(person).outcomeBeliefs.find((belief) => belief.basisKey === basisKey);
}

export function outcomeBeliefSuccess(belief?: OutcomeBelief): number {
  if (!belief) return 0.5;
  return belief.successAlpha / Math.max(0.0001, belief.successAlpha + belief.successBeta);
}

export function outcomeBeliefUncertainty(belief?: OutcomeBelief): number {
  if (!belief) return 1;
  const alpha = belief.successAlpha;
  const beta = belief.successBeta;
  const total = alpha + beta;
  const variance = alpha * beta / Math.max(0.0001, total * total * (total + 1));
  // The prior Beta(2,2) is the reference uncertainty of 1.
  return clamp(Math.sqrt(variance) / Math.sqrt(0.05));
}

function freshGoalOutcomeBelief(basisKey: string, atMonth: number): GoalOutcomeBelief {
  return {
    basisKey,
    attempts: 0,
    achieved: 0,
    attemptedUnmet: 0,
    successAlpha: 2,
    successBeta: 2,
    lastUpdatedAtMonth: atMonth,
    sourceEventIds: [],
  };
}

export function goalOutcomeBeliefFor(person: PersonState, basisKey: string): GoalOutcomeBelief | undefined {
  return cognitionStateOf(person).goalOutcomeBeliefs?.find((belief) => belief.basisKey === basisKey);
}

export function goalOutcomeBeliefSuccess(belief?: GoalOutcomeBelief): number {
  if (!belief) return 0.5;
  return belief.successAlpha / Math.max(0.0001, belief.successAlpha + belief.successBeta);
}

export function goalOutcomeBeliefUncertainty(belief?: GoalOutcomeBelief): number {
  if (!belief) return 1;
  const alpha = belief.successAlpha;
  const beta = belief.successBeta;
  const total = alpha + beta;
  const variance = alpha * beta / Math.max(0.0001, total * total * (total + 1));
  return clamp(Math.sqrt(variance) / Math.sqrt(0.05));
}

/**
 * Resolve an intent's desired state independently from whether its last atom
 * executed legally. A completed reproduction attempt can therefore remain an
 * unmet pregnancy goal without changing ActionFact semantics.
 */
export function recordIntentGoalOutcome(
  state: SimulationState,
  intent: Intent,
  kind: IntentGoalOutcomeKind,
  atMonth: number,
  sourceEventIds: string[],
  action: PrimitiveAction = intent.completionAction ?? intent.nextAction,
): void {
  if (intent.goalOutcome && intent.goalOutcome.kind !== 'not-evaluated') return;
  const basisKey = cognitiveOutcomeBasisKey(action, intent.goal);
  const sources = [...new Set(sourceEventIds)].slice(-MAX_BELIEF_SOURCES);
  intent.goalOutcome = {
    version: 'intent-goal-outcome-v1',
    kind,
    basisKey,
    resolvedAtMonth: atMonth,
    sourceEventIds: sources,
  };
  if (kind === 'not-evaluated') return;
  const person = personById(state, intent.ownerId);
  if (!person) return;
  const cognition = ensureCognitionState(person);
  let belief = cognition.goalOutcomeBeliefs?.find((candidate) => candidate.basisKey === basisKey);
  if (!belief) {
    belief = freshGoalOutcomeBelief(basisKey, atMonth);
    cognition.goalOutcomeBeliefs?.push(belief);
  }
  belief.attempts += 1;
  if (kind === 'achieved') {
    belief.achieved += 1;
    belief.successAlpha += 1;
  } else {
    belief.attemptedUnmet += 1;
    belief.successBeta += 1;
  }
  belief.lastUpdatedAtMonth = atMonth;
  belief.sourceEventIds = [...new Set([...belief.sourceEventIds, ...sources])].slice(-MAX_BELIEF_SOURCES);
  cognition.goalOutcomeBeliefs = cognition.goalOutcomeBeliefs
    ?.sort((left, right) => right.lastUpdatedAtMonth - left.lastUpdatedAtMonth
      || right.attempts - left.attempts
      || left.basisKey.localeCompare(right.basisKey))
    .slice(0, MAX_GOAL_OUTCOME_BELIEFS);
}

/** Record only the person who produced the final functional project evidence. */
export function recordProjectNeedResolution(
  person: PersonState,
  project: Pick<ProjectState, 'id' | 'need' | 'desiredFunction' | 'triggerFactIds' | 'completionEventIds'>,
  atMonth: number,
): NeedResolutionEpisode | undefined {
  if (!project.completionEventIds.length) return undefined;
  const cognition = ensureCognitionState(person);
  const existing = cognition.needResolutionEpisodes?.find((episode) => episode.projectId === project.id);
  if (existing) return existing;
  const triggerFactIds = [...new Set(project.triggerFactIds)];
  const outcomeEventIds = [...new Set(project.completionEventIds)];
  const episode: NeedResolutionEpisode = {
    version: 'need-resolution-episode-v1',
    id: `need-resolution:${project.id}:${person.id}`,
    projectId: project.id,
    projectNeed: project.need,
    desiredFunction: project.desiredFunction,
    basisKey: `need-resolution:${project.need}:${project.desiredFunction}`,
    observedAtMonth: atMonth,
    observationKind: 'completion-action',
    triggerFactIds,
    outcomeEventIds,
    sourceFactIds: [...new Set([...triggerFactIds, ...outcomeEventIds])],
  };
  cognition.needResolutionEpisodes = [...(cognition.needResolutionEpisodes ?? []), episode]
    .sort((left, right) => left.observedAtMonth - right.observedAtMonth || left.id.localeCompare(right.id))
    .slice(-MAX_NEED_RESOLUTION_EPISODES);
  return episode;
}

/** Engine bookkeeping that leaves the actor in place is not an experience. */
export function isMeaningfulCognitiveOutcome(fact: ActionFact): boolean {
  return fact.action.kind !== 'move'
    || fact.fromCellId !== fact.toCellId
    || fact.fromZ !== fact.toZ;
}

/** Learn only after the domain has produced a real, replayable action fact. */
export function recordActionOutcomeBelief(state: SimulationState, fact: ActionFact): void {
  if (!isMeaningfulCognitiveOutcome(fact)) return;
  const person = personById(state, fact.who);
  if (!person) return;
  const cognition = ensureCognitionState(person);
  const basisKey = actionFactOutcomeBasisKey(state, fact);
  let belief = cognition.outcomeBeliefs.find((candidate) => candidate.basisKey === basisKey);
  if (!belief) {
    belief = freshBelief(basisKey, fact.atMonth);
    cognition.outcomeBeliefs.push(belief);
  }
  const evidence = outcomeEvidence(fact);
  belief.attempts += 1;
  belief[evidence.outcome] += 1;
  belief.successAlpha += evidence.alpha;
  belief.successBeta += evidence.beta;
  const oldWeight = Math.max(0, belief.attempts - 1);
  belief.expectedEffort = (belief.expectedEffort * oldWeight + experiencedEffort(fact)) / belief.attempts;
  belief.expectedHarm = (belief.expectedHarm * oldWeight + experiencedHarm(fact)) / belief.attempts;
  belief.lastUpdatedAtMonth = fact.atMonth;
  belief.sourceEventIds = [...new Set([...belief.sourceEventIds, fact.id])].slice(-MAX_BELIEF_SOURCES);
  cognition.outcomeBeliefs = cognition.outcomeBeliefs
    .sort((left, right) => right.lastUpdatedAtMonth - left.lastUpdatedAtMonth
      || right.attempts - left.attempts
      || left.basisKey.localeCompare(right.basisKey))
    .slice(0, MAX_OUTCOME_BELIEFS);
}

export function causalMemoryTraceForAction(state: SimulationState, fact: ActionFact): CausalMemoryTrace {
  const evidence = outcomeEvidence(fact);
  const intent = fact.intentId ? intentById(state, fact.intentId) : undefined;
  const consequenceTags = new Set<string>([evidence.outcome]);
  const explicitGoalUnmet = fact.action.kind === 'act'
    && fact.action.operation === 'reproduce'
    && fact.diff.conceived === false;
  if (explicitGoalUnmet) consequenceTags.add('goal-unmet');
  if (fact.action.kind === 'communicate') consequenceTags.add('social');
  if (fact.action.kind === 'transfer') consequenceTags.add('resource-transfer');
  if (intent?.projectId) consequenceTags.add('project');
  if (finite(fact.diff.outputQuantity) > 0 || finite(fact.diff.outputMaterialId) > 0 || finite(fact.diff.harvested) > 0) {
    consequenceTags.add('material-output');
  }
  if (experiencedHarm(fact) > 0) consequenceTags.add('self-harm');
  const operation = fact.action.kind === 'act'
    ? fact.action.operation
    : fact.action.kind === 'communicate'
      ? fact.action.content.kind
      : undefined;
  return {
    basisKey: cognitiveOutcomeBasisKey(fact.action, intent?.goal),
    actionKind: fact.action.kind,
    ...(operation ? { operation } : {}),
    ...(intent ? { goalKind: intent.goal.kind } : {}),
    outcome: evidence.outcome,
    // Completing the biological process is valid action experience, but a
    // non-conception must not become a positive memory of achieving pregnancy.
    valence: explicitGoalUnmet ? 0 : evidence.valence,
    consequenceTags: [...consequenceTags].sort(),
  };
}
