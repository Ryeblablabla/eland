import type { ActionOption, Intent, PrimitiveAction } from '../domain/action';
import { Material, materialHas } from '../domain/material';
import type { SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { inventoryVoxelCombinationOutput } from '../domain/interaction-rules';
import { worldEventById } from '../domain/event-index';
import { bodyOccupies } from '../domain/actions/execution-helpers';
import { intentById, intentsOwnedBy } from '../domain/state-index';
import { voxelAt } from '../world/grid';
import {
  isCommitmentActionOption,
  isRequiredResponseOption,
} from '../domain/action-option-semantics';

const FAILURE_MEMORY_PREFIXES = [
  'memory:intent-opening-failed:',
  'memory:intent-review-due:',
  'memory:intent-blocked:',
  'memory:intent-action-failed:',
] as const;

type FailureMemoryPrefix = typeof FAILURE_MEMORY_PREFIXES[number];

function stableSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableSemanticValue(entry)]));
}

function stableSemanticKey(value: unknown): string {
  return JSON.stringify(stableSemanticValue(value));
}

function semanticGoal(goal: ActionOption['goal']): unknown {
  if (goal.kind === 'representation-made') return { kind: goal.kind };
  if (goal.kind === 'knowledge' && goal.factId.startsWith('attempt:')) return {
    kind: goal.kind,
    ...(goal.minConfidence !== undefined ? { minConfidence: goal.minConfidence } : {}),
    ...(goal.personId ? { personId: goal.personId } : {}),
  };
  return structuredClone(goal);
}

function semanticAction(action: PrimitiveAction): unknown {
  if (action.kind !== 'talk') return structuredClone(action);
  const normalized = structuredClone(action) as unknown as Record<string, unknown>;
  const speakerMeaning = normalized.speakerMeaning as Record<string, unknown>;
  delete speakerMeaning.id;
  delete speakerMeaning.summary;
  const proposal = speakerMeaning.proposal as Record<string, unknown> | undefined;
  if (proposal) {
    delete proposal.expiresAtMonth;
    delete proposal.validUntilMonth;
    delete proposal.basis;
  }
  const prediction = speakerMeaning.prediction as Record<string, unknown> | undefined;
  if (prediction) {
    delete prediction.predictedStartMonth;
    delete prediction.expiresAtMonth;
  }
  const conversation = speakerMeaning.conversation as Record<string, unknown> | undefined;
  if (conversation) {
    delete conversation.basisKey;
    delete conversation.referenceEventId;
    delete conversation.sourceFactIds;
  }
  const techniqueDemonstration = speakerMeaning.techniqueDemonstration as Record<string, unknown> | undefined;
  if (techniqueDemonstration) delete techniqueDemonstration.expiresAtMonth;
  const projectContribution = speakerMeaning.projectMaterialContribution as Record<string, unknown> | undefined;
  if (projectContribution) delete projectContribution.expiresAtMonth;
  const projectKnowledgeRequest = speakerMeaning.projectKnowledgeRequest as Record<string, unknown> | undefined;
  if (projectKnowledgeRequest) delete projectKnowledgeRequest.expiresAtMonth;
  return normalized;
}

function semanticRecordUseBasis(basis: ActionOption['recordUseBasis']): unknown {
  if (!basis) return null;
  return {
    version: basis.version,
    basisKey: basis.basisKey,
    projectId: basis.projectId,
    projectOwnerId: basis.projectOwnerId,
    readerId: basis.readerId,
    recordAuthorId: basis.recordAuthorId,
    demand: { kind: basis.demand.kind, projectId: basis.demand.projectId },
    recordId: basis.recordId,
    knowledgeId: basis.knowledgeId,
    codebookId: basis.codebookId,
    techniqueId: basis.techniqueId,
    ruleSignature: basis.ruleSignature,
    expectedOutputMaterialId: basis.expectedOutputMaterialId,
    ...(basis.version !== 'record-use-basis-v3' ? {
      experimentAction: semanticAction(basis.experimentAction),
    } : {}),
    ...(basis.version !== 'record-use-basis-v1' ? {
      carrierSource: structuredClone(basis.carrierSource),
      acquisitionRequired: basis.acquisitionRequired,
    } : {}),
  };
}

function retryBasisForOption(option: ActionOption, openingFailure: boolean): string {
  const shared = {
    action: semanticAction(openingFailure ? option.nextAction : option.completionAction ?? option.nextAction),
    projectId: option.projectId ?? null,
    recordUseBasis: semanticRecordUseBasis(option.recordUseBasis),
    relationshipBasis: option.relationshipBasis?.basisKey ?? null,
  };
  return stableSemanticKey(openingFailure
    ? shared
    : { ...shared, goal: semanticGoal(option.goal) });
}

function retryBasisForIntentAction(
  intent: Intent,
  action: PrimitiveAction,
  openingFailure: boolean,
): string {
  const shared = {
    action: semanticAction(action),
    projectId: intent.projectId ?? null,
    recordUseBasis: semanticRecordUseBasis(intent.recordUseBasis),
    relationshipBasis: intent.relationshipBasis?.basisKey ?? null,
  };
  return stableSemanticKey(openingFailure
    ? shared
    // Project recompilation replaces the executable action while the intent's
    // top-level target may still describe an earlier logistics step. The
    // action already carries its actual person/drop/voxel targets, so routing
    // metadata must not make an identical failed action look novel.
    : { ...shared, goal: semanticGoal(intent.goal) });
}

function retryBasisForIntent(intent: Intent, prefix: FailureMemoryPrefix): string {
  const openingFailure = prefix === 'memory:intent-opening-failed:' && Boolean(intent.openingAction);
  return retryBasisForIntentAction(
    intent,
    openingFailure ? intent.openingAction! : intent.completionAction ?? intent.nextAction,
    openingFailure,
  );
}

function parseFailureMemory(
  memory: PersonState['memories'][number],
): { memory: PersonState['memories'][number]; intentId: string; prefix: FailureMemoryPrefix } | null {
  if (memory.kind !== 'failure') return null;
  const prefix = FAILURE_MEMORY_PREFIXES.find((candidate) => memory.id.startsWith(candidate));
  if (!prefix) return null;
  const encodedIntentAndMonth = memory.id.slice(prefix.length);
  const monthSuffix = `:${memory.createdAtMonth}`;
  if (!encodedIntentAndMonth.endsWith(monthSuffix)) return null;
  const intentId = encodedIntentAndMonth.slice(0, -monthSuffix.length);
  return intentId ? { memory, intentId, prefix } : null;
}

interface FailureRetryEntry {
  openingFailure: boolean;
  actionBasis: string;
  basis: string;
  failedAtMonth: number;
  previousSources: ReadonlySet<string>;
}

export interface FailureRetryContext {
  entries: FailureRetryEntry[];
}

function sameSemanticAction(left: PrimitiveAction, right: PrimitiveAction): boolean {
  return stableSemanticKey(semanticAction(left)) === stableSemanticKey(semanticAction(right));
}

function authoritativeFailureRetryEntry(
  state: SimulationState,
  intent: Intent,
  atMonth: number,
): FailureRetryEntry | null {
  if (intent.status !== 'blocked' && intent.status !== 'failed') return null;
  const outcome = intent.goalOutcome;
  const age = outcome ? atMonth - outcome.resolvedAtMonth : Number.POSITIVE_INFINITY;
  if (!outcome || age < 0 || age > 6) return null;
  const outcomeSources = new Set(outcome.sourceEventIds);
  const fact = [...intent.actionEventIds].reverse().flatMap((eventId) => {
    if (!outcomeSources.has(eventId)) return [];
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  }).find((event) => event.who === intent.ownerId
    && (event.intentId === undefined || event.intentId === intent.id)
    && event.atMonth === outcome.resolvedAtMonth
    && (event.status === 'blocked' || event.status === 'failed'));
  if (!fact) return null;
  const openingFailure = Boolean(intent.openingAction
    && !intent.openingActionCompleted
    && sameSemanticAction(intent.openingAction, fact.action));
  return {
    openingFailure,
    actionBasis: stableSemanticKey(semanticAction(fact.action)),
    // The executed ActionFact is authoritative. A project may recompile or
    // rewrite intent routing fields after the attempt, so those fields cannot
    // safely stand in for what actually failed.
    basis: retryBasisForIntentAction(intent, fact.action, openingFailure),
    failedAtMonth: fact.atMonth,
    previousSources: new Set([
      ...(intent.sourceFactIds ?? []),
      ...intent.actionEventIds,
      ...outcome.sourceEventIds,
      fact.id,
    ].filter(Boolean)),
  };
}

export function buildFailureRetryContext(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
): FailureRetryContext {
  const recent = person.memories.flatMap((memory) => {
    const age = atMonth - memory.createdAtMonth;
    if (memory.kind !== 'failure' || age < 0 || age > 6) return [];
    const parsed = parseFailureMemory(memory);
    return parsed ? [parsed] : [];
  });
  const entriesByKey = new Map<string, FailureRetryEntry>();
  const addEntry = (entry: FailureRetryEntry) => {
    const key = `${entry.openingFailure ? 'opening' : 'regular'}\u0000${entry.failedAtMonth}\u0000${entry.basis}`;
    const existing = entriesByKey.get(key);
    entriesByKey.set(key, existing ? {
      ...entry,
      previousSources: new Set([...existing.previousSources, ...entry.previousSources]),
    } : entry);
  };
  const authoritativeIntentFailures = new Set<string>();
  for (const intent of intentsOwnedBy(state, person.id)) {
    const entry = authoritativeFailureRetryEntry(state, intent, atMonth);
    if (!entry) continue;
    addEntry(entry);
    authoritativeIntentFailures.add(`${intent.id}\u0000${entry.failedAtMonth}`);
  }
  for (const item of recent) {
    const intent = intentById(state, item.intentId);
    if (!intent || intent.ownerId !== person.id) continue;
    const openingFailure = item.prefix === 'memory:intent-opening-failed:' && Boolean(intent.openingAction);
    const failedAction = openingFailure
      ? intent.openingAction!
      : intent.completionAction ?? intent.nextAction;
    // New states retain an exact ActionFact link on the terminal intent. Use
    // bounded memory only as a compatibility fallback for older snapshots and
    // review/compile failures that did not execute an action.
    if (authoritativeIntentFailures.has(`${intent.id}\u0000${item.memory.createdAtMonth}`)) continue;
    addEntry({
      openingFailure,
      actionBasis: stableSemanticKey(semanticAction(failedAction)),
      basis: retryBasisForIntent(intent, item.prefix),
      failedAtMonth: item.memory.createdAtMonth,
      previousSources: new Set([
        ...(intent.sourceFactIds ?? []),
        ...intent.actionEventIds,
        ...item.memory.sourceEventIds,
      ].filter(Boolean)),
    });
  }
  return { entries: [...entriesByKey.values()] };
}

export function isFailureRetryCoolingDown(
  state: SimulationState,
  person: PersonState,
  option: ActionOption,
  atMonth: number,
  prepared = buildFailureRetryContext(state, person, atMonth),
): boolean {
  if (isRequiredResponseOption(option) || isCommitmentActionOption(option)) return false;
  let regularBasis: string | undefined;
  let openingBasis: string | undefined;
  let regularActionBasis: string | undefined;
  let openingActionBasis: string | undefined;
  return prepared.entries.some((entry) => {
    const optionActionBasis = entry.openingFailure
      ? openingActionBasis ??= stableSemanticKey(semanticAction(option.nextAction))
      : regularActionBasis ??= stableSemanticKey(semanticAction(option.completionAction ?? option.nextAction));
    // A root failure may grant one more ordinary deliberation in the same
    // month, but the already committed ActionFact is present-tense physical
    // evidence. The exact same action is not newly plausible merely because a
    // different goal or project now asks for it. A changed action remains
    // eligible, while later months return to the full causal basis below.
    if (atMonth === entry.failedAtMonth && optionActionBasis === entry.actionBasis) return true;
    const optionBasis = entry.openingFailure
      ? openingBasis ??= retryBasisForOption(option, true)
      : regularBasis ??= retryBasisForOption(option, false);
    if (optionBasis !== entry.basis) return false;
    return !option.sourceFactIds.some((sourceId) => Boolean(sourceId) && !entry.previousSources.has(sourceId));
  });
}

function sameVoxelPosition(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

export function isCurrentlyBodyBlockedPlacement(
  state: SimulationState,
  person: PersonState,
  action: PrimitiveAction,
): boolean {
  if (action.kind !== 'act') return false;
  const installationPosition = action.mechanicalPowerBasis?.mode === 'install'
    ? action.mechanicalPowerBasis.componentPosition
    : action.electricalPowerBasis?.mode === 'install'
      ? action.electricalPowerBasis.componentPosition
      : null;
  if (installationPosition) {
    const exactVoxelTarget = action.targets.some((target) => target.kind === 'voxel'
      && sameVoxelPosition(target.position, installationPosition));
    return exactVoxelTarget
      && voxelAt(state.world.grid, installationPosition.x, installationPosition.y, installationPosition.z) === Material.Air
      && bodyOccupies(state, installationPosition);
  }
  if (action.operation !== 'combine') return false;
  const stackRef = action.targets.find((target) => target.kind === 'inventory-stack'
    && target.personId === person.id);
  const voxelRef = action.targets.find((target) => target.kind === 'voxel');
  if (!stackRef || stackRef.kind !== 'inventory-stack' || !voxelRef || voxelRef.kind !== 'voxel') return false;
  const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
  if (!stack) return false;
  const targetMaterialId = voxelAt(
    state.world.grid,
    voxelRef.position.x,
    voxelRef.position.y,
    voxelRef.position.z,
  );
  const outputMaterialId = inventoryVoxelCombinationOutput(stack.materialId, targetMaterialId);
  return outputMaterialId !== null
    && materialHas(outputMaterialId, 'solid')
    && bodyOccupies(state, voxelRef.position);
}

export function optionHasCurrentlyBodyBlockedPlacement(
  state: SimulationState,
  person: PersonState,
  option: Pick<ActionOption, 'nextAction' | 'completionAction'>,
): boolean {
  return isCurrentlyBodyBlockedPlacement(state, person, option.nextAction)
    || Boolean(option.completionAction
      && isCurrentlyBodyBlockedPlacement(state, person, option.completionAction));
}
