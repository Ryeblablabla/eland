import {
  type DecisionRequestContext,
  buildDecisionProbeHandleMap,
  type DecisionProbeHandleMap,
  buildMindIntentionRequestContext,
  buildMentalActRequestContext,
  type MindIntentionDraft,
  type MindIntentionOrientation,
  type MindIntentionRequestContext,
  type MentalActRequestContext,
  compileModelPlanCompletion,
  sanitizeBoundPlanCompletion,
  compileMindSpeechIntent,
  describeMindSpeechIntent,
  speechIntentAllowsOption,
} from '../src/game/eland/infrastructure-api';
import { validateActionOptionSemantics } from '../src/game/eland/domain/action-option-semantics';
import { MATERIAL_PALETTE } from '../src/game/eland/domain/material';
import type {
  WorldAdjudicatedInteraction,
  WorldInteractionEffect,
  WorldRef,
} from '../src/game/eland/domain/action';
import type { WorkLayout } from '../src/game/eland/domain/work-layout';
import type {
  CharacterAgendaProbe,
  CharacterAgendaProposal,
  CharacterAgendaUpdate,
} from '../src/game/eland/domain/character-agenda';
import type { Decision, MentalAct, MentalActKind, TokenUsage } from '../src/game/eland/simulation';
import { loadServerEnvValue } from './env';
import { ModelRequestError, requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ResolvedModelEndpoint } from './model-config';
import {
  buildMindIntentionJsonSchema,
  buildModelPlanJsonSchema,
  buildWorldResolutionJsonSchema,
} from './model-decision-json-schema';
import {
  AGENT_PLAN_SYSTEM_PROMPT_V1,
  CHARACTER_AGENDA_EXTENSION_V2,
  DECISION_SYSTEM_PROMPT_V2,
  MIND_INTENTION_SYSTEM_PROMPT_V5,
  PLAN_AGENT_WORLD_VERDICT_V1,
} from './agent-prompt-templates';

const MAX_AGENTS = 12;

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Speech is authoritative language: reject an overlong result instead of storing half a sentence. */
function boundedUtterance(value: unknown, max = 180): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= max ? normalized : '';
}

function parseJson(content: string): unknown {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
}

function decisionTimeout(endpoint: ResolvedModelEndpoint): number {
  const configured = Number(loadServerEnvValue('MODEL_DECISION_TIMEOUT_MS') || Math.min(endpoint.timeoutMs, 12_000));
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(30_000, configured)) : 12_000;
}

function decisionMaxOutputTokens(): number {
  const configured = Number(loadServerEnvValue('MODEL_DECISION_MAX_OUTPUT_TOKENS') || 1_200);
  return Number.isFinite(configured) ? Math.max(128, Math.min(2_400, Math.floor(configured))) : 1_200;
}

function decisionPhaseTemperature(phase: 'mind' | 'plan'): number {
  const raw = loadServerEnvValue(
    phase === 'mind' ? 'MODEL_MIND_TEMPERATURE' : 'MODEL_PLAN_TEMPERATURE',
  ).trim();
  const configured = raw ? Number(raw) : Number.NaN;
  const fallback = phase === 'mind' ? 1 : 0.2;
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(2, configured)
    : fallback;
}

function usesCharacterAgendaProposal(): boolean {
  const configured = loadServerEnvValue('MODEL_CHARACTER_AGENDA_MODE').trim().toLowerCase();
  return configured !== 'off' && configured !== 'disabled' && configured !== 'none';
}

function characterNoteFromRequestContext(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const person = (value as Record<string, unknown>).person;
  if (!person || typeof person !== 'object' || Array.isArray(person)) return undefined;
  const note = (person as Record<string, unknown>).characterNote;
  return note && typeof note === 'object' && !Array.isArray(note) ? note : undefined;
}

function characterNoteMessage(note: unknown, appliesTo: string): ModelMessage | undefined {
  return note ? {
    role: 'user',
    content: JSON.stringify({
      protocol: 'eland-character-note-v1',
      appliesTo,
      characterNote: note,
      instruction: '按临场角色注记控制目标、策略与可选 utterance；示例不是事实，也不要照抄。输出仍严格服从 Mental Act JSON。',
    }),
  } : undefined;
}

export function buildDecisionSystemPrompt(characterAgendaProposal = usesCharacterAgendaProposal()): string {
  return [
    DECISION_SYSTEM_PROMPT_V2,
    ...(characterAgendaProposal ? [CHARACTER_AGENDA_EXTENSION_V2] : []),
  ].join('\n');
}

export interface DecisionModelRequestProtocol {
  requestContext: MentalActRequestContext;
  mindContext: MindIntentionRequestContext;
  handles: DecisionProbeHandleMap;
  characterAgendaProposal: boolean;
}

export function buildDecisionModelRequestProtocol(
  context: DecisionRequestContext,
  options: { characterAgendaProposal?: boolean } = {},
): DecisionModelRequestProtocol {
  const characterAgendaProposal = options.characterAgendaProposal ?? usesCharacterAgendaProposal();
  const handles = buildDecisionProbeHandleMap(context);
  const requestContext = buildMentalActRequestContext(context, handles);
  return {
    requestContext,
    mindContext: buildMindIntentionRequestContext(requestContext),
    handles,
    characterAgendaProposal,
  };
}

interface MindIntentionOutput extends MindIntentionDraft {
  speechIntent: NonNullable<MentalAct['speechIntent']>;
  orientation: MindIntentionOrientation;
  horizon: 'momentary' | 'ongoing';
  evidenceMemoryHandles: string[];
  relationshipAppraisal?: NonNullable<MentalAct['relationshipAppraisal']>;
}

interface ModelPlanOutput {
  steps: string[];
  completion?: NonNullable<MentalAct['plan']>['completion'];
  disposition?: 'act' | 'continue' | 'pause' | 'abandon' | 'stay';
  firstStepHandle?: string;
  continuationHandle?: string;
  resumeIntentHandle?: string;
  abandonIntentHandle?: string;
  groundingFactHandles?: string[];
  experiment?: Record<string, unknown>;
  worldAction?: ModelWorldAction;
  feedback?: ModelPlanFeedback;
  freeExpression?: boolean;
}

interface ModelWorldAction {
  description: string;
  targetHandles: string[];
  expectedResult?: string;
  methodHandle?: string;
}

interface ModelPlanFeedback {
  correction: string;
  adjustment: string;
  sourceMemoryHandles: string[];
  sourceEventIds: string[];
}

interface WorldAdjudicationResolution {
  probe?: CharacterAgendaProbe;
  feedback: string;
}

const RELATIONSHIP_APPRAISAL_MEANINGS = new Set([
  'gratitude', 'care', 'affection', 'attraction', 'respect', 'solidarity', 'obligation',
  'hurt', 'anger', 'fear', 'suspicion', 'jealousy', 'rivalry', 'grief', 'ambivalence', 'uncertainty',
] as const);

function readableAgentAction(step: Record<string, unknown>): string {
  const action = text(step.action, 240);
  const target = record(step.target);
  const targetName = text(target?.name, 80);
  return targetName && targetName !== '当前可见对象' && !action.includes(targetName)
    ? `${action}（对象：${targetName}）`
    : action;
}

function agentTurnRequestContext(protocol: DecisionModelRequestProtocol): Record<string, unknown> {
  const sourceSteps = protocol.requestContext.availableSteps;
  const context = Object.fromEntries(Object.entries(protocol.requestContext).filter(([key]) => (
    key !== 'availableSteps' && key !== 'continuations'
  )));
  const seen = new Set<string>();
  const availableActions = sourceSteps.flatMap((step) => {
    const action = readableAgentAction(step);
    if (!action || seen.has(action)) return [];
    seen.add(action);
    const details = Object.fromEntries(Object.entries(step).filter(([key]) => (
      key !== 'handle' && key !== 'action' && key !== 'target'
    )));
    const target = step.target;
    const targetName = text(record(target)?.name, 80);
    return [{
      action,
      ...details,
      ...(targetName && targetName !== '当前可见对象' ? { target: targetName } : {}),
    }];
  });
  return {
    ...context,
    schemaVersion: 'agent-turn-context-v1',
    availableActions,
  };
}

function agentPlanRequestContext(
  protocol: DecisionModelRequestProtocol,
  intention: MindIntentionOutput,
): Record<string, unknown> {
  const context = agentTurnRequestContext(protocol);
  const availableSteps = protocol.requestContext.availableSteps.map((step) => ({
    ...step,
    action: readableAgentAction(step),
  }));
  return {
    schemaVersion: 'agent-plan-context-v1',
    intention: {
      utterance: intention.utterance,
      delivery: intention.delivery,
      goal: intention.goal,
      orientation: intention.orientation,
      horizon: intention.horizon,
      speechIntent: describeMindSpeechIntent(intention.speechIntent, protocol.handles),
    },
    person: context.person,
    situation: context.situation,
    mind: context.mind,
    current: context.current,
    recentDialogue: context.recentDialogue,
    visible: context.visible,
    availableSteps,
    continuations: protocol.requestContext.continuations,
    actionSpace: context.actionSpace,
    knownMethods: protocol.requestContext.knownMethods ?? [],
    speechReferences: protocol.requestContext.speechReferences ?? [],
    ...planAgentWorldContext(),
  };
}

function planAgentWorldContext(): Record<string, unknown> {
  return {
    materialCatalog: MATERIAL_PALETTE.filter((material) => material.id !== 0).map((material) => ({
      key: material.key,
      name: material.name,
    })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeMindIntention(
  input: unknown,
  handles: DecisionProbeHandleMap,
  onInvalid?: (problem: string) => void,
): MindIntentionOutput | undefined {
  const raw = record(input);
  if (!raw) {
    onInvalid?.('Mind 必须返回一个 JSON 对象，包含 utterance、goal、delivery、orientation、horizon');
    return undefined;
  }
  const utterance = boundedUtterance(raw?.utterance);
  const goal = text(raw?.goal, 240);
  const delivery = raw?.delivery === 'whisper' || raw?.delivery === 'normal' || raw?.delivery === 'call'
    ? raw.delivery
    : undefined;
  const orientation = raw?.orientation === 'social'
    || raw?.orientation === 'inquiry'
    || raw?.orientation === 'survival'
    || raw?.orientation === 'construction'
    || raw?.orientation === 'acquisition'
    || raw?.orientation === 'exploration'
    || raw?.orientation === 'rest'
    ? raw.orientation
    : undefined;
  const horizon = raw?.horizon === 'momentary' || raw?.horizon === 'ongoing'
    ? raw.horizon
    : undefined;
  const problems = [
    ...(!utterance ? [`utterance 需要 1–180 字的完整原话，当前长度 ${typeof raw.utterance === 'string' ? raw.utterance.trim().length : 0}`] : []),
    ...(!goal ? ['goal 缺少人物此刻的具体意图'] : []),
    ...(!delivery ? ['delivery 必须是 whisper、normal 或 call'] : []),
    ...(!orientation ? ['orientation 必须是 social、inquiry、survival、construction、acquisition、exploration 或 rest'] : []),
    ...(!horizon ? ['horizon 必须是 momentary 或 ongoing'] : []),
  ];
  if (!utterance || !goal || !delivery || !orientation || !horizon) {
    onInvalid?.(problems.join('；'));
    return undefined;
  }
  const evidenceMemoryHandles = Array.isArray(raw.evidenceMemoryHandles)
    ? [...new Set(raw.evidenceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))]
      .filter((handle) => handles.memories.some((memory) => memory.handle === handle))
      .slice(0, 4)
    : [];
  const relationshipAppraisal = sanitizeMindRelationshipAppraisal(raw.relationshipAppraisal, handles);
  const rawSpeech = record(raw.speechIntent);
  const speechIntent = compileMindSpeechIntent(rawSpeech, handles,
    Boolean(rawSpeech?.referenceId || Array.isArray(rawSpeech?.counterpartIds)));
  // An optional, ungrounded appraisal is omitted. It must neither create a
  // false relationship nor erase the person's independently valid intention.
  return {
    utterance,
    delivery,
    goal,
    speechIntent,
    orientation,
    horizon,
    evidenceMemoryHandles,
    ...(relationshipAppraisal ? { relationshipAppraisal } : {}),
  };
}

function sanitizeRelationshipMeanings(input: unknown): NonNullable<MentalAct['relationshipAppraisal']>['meanings'] | undefined {
  if (!Array.isArray(input)) return undefined;
  const meanings = [...new Set(input.map((value) => text(value, 32)))]
    .filter((value): value is NonNullable<MentalAct['relationshipAppraisal']>['meanings'][number] => (
      RELATIONSHIP_APPRAISAL_MEANINGS.has(value as never)
    ))
    .slice(0, 4);
  return meanings.length > 0 && meanings.length === input.length ? meanings : undefined;
}

function sanitizeMindRelationshipAppraisal(
  input: unknown,
  handles: DecisionProbeHandleMap,
): NonNullable<MentalAct['relationshipAppraisal']> | undefined {
  const raw = record(input);
  const otherPersonHandle = text(raw?.otherPersonHandle, 24);
  const otherPerson = handles.visible.find((item) => (
    item.handle === otherPersonHandle && item.kind === 'person'
  ));
  const otherPersonId = otherPerson?.kind === 'person' ? otherPerson.personId : undefined;
  const sourceMemoryHandles = Array.isArray(raw?.sourceMemoryHandles)
    ? [...new Set(raw.sourceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))].slice(0, 4)
    : [];
  const memories = sourceMemoryHandles.map((handle) => handles.memories.find((memory) => memory.handle === handle));
  const meanings = sanitizeRelationshipMeanings(raw?.meanings);
  const interpretation = text(raw?.interpretation, 320);
  if (!raw || !otherPersonId || !meanings || !interpretation || !sourceMemoryHandles.length
    || memories.some((memory) => !memory)
    || !memories.some((memory) => memory?.personIds?.includes(otherPersonId))) return undefined;
  const unresolvedExpectation = text(raw.unresolvedExpectation, 240);
  const desiredResponse = text(raw.desiredResponse, 240);
  return {
    version: 'mental-relationship-appraisal-v1',
    otherPersonId,
    meanings,
    interpretation,
    ...(unresolvedExpectation ? { unresolvedExpectation } : {}),
    ...(desiredResponse ? { desiredResponse } : {}),
    sourceEventIds: [...new Set(memories.flatMap((memory) => memory!.sourceFactIds))].slice(-24),
  };
}

function sanitizeStagedRelationshipAppraisal(
  input: unknown,
  handles: DecisionProbeHandleMap,
): NonNullable<MentalAct['relationshipAppraisal']> | undefined {
  const raw = record(input);
  const otherPersonId = text(raw?.otherPersonId, 160);
  const visiblePerson = handles.visible.some((item) => item.kind === 'person' && item.personId === otherPersonId);
  const meanings = sanitizeRelationshipMeanings(raw?.meanings);
  const interpretation = text(raw?.interpretation, 320);
  const requestedSources = Array.isArray(raw?.sourceEventIds)
    ? [...new Set(raw.sourceEventIds.map((value) => text(value, 160)).filter(Boolean))].slice(-24)
    : [];
  const allowedSources = new Set(handles.memories
    .filter((memory) => memory.personIds?.includes(otherPersonId))
    .flatMap((memory) => memory.sourceFactIds));
  if (!raw || raw.version !== 'mental-relationship-appraisal-v1' || !visiblePerson
    || !meanings || !interpretation || !requestedSources.length
    || requestedSources.some((sourceId) => !allowedSources.has(sourceId))) return undefined;
  const unresolvedExpectation = text(raw.unresolvedExpectation, 240);
  const desiredResponse = text(raw.desiredResponse, 240);
  return {
    version: 'mental-relationship-appraisal-v1',
    otherPersonId,
    meanings,
    interpretation,
    ...(unresolvedExpectation ? { unresolvedExpectation } : {}),
    ...(desiredResponse ? { desiredResponse } : {}),
    sourceEventIds: requestedSources,
  };
}

function sanitizeMentalPlanTranslation(
  input: unknown,
  handles?: DecisionProbeHandleMap,
): NonNullable<MentalAct['plan']> | undefined {
  const raw = record(input);
  if (!raw || raw.version !== 'mental-plan-translation-v1' || !Array.isArray(raw.steps)) return undefined;
  const steps = raw.steps.map((value) => text(value, 240)).filter(Boolean);
  const disposition = raw.disposition === 'act'
    || raw.disposition === 'continue'
    || raw.disposition === 'pause'
    || raw.disposition === 'abandon'
    || raw.disposition === 'stay'
    ? raw.disposition
    : undefined;
  if (!steps.length || steps.length !== raw.steps.length || !disposition) return undefined;
  const firstStepHandle = text(raw.firstStepHandle, 24);
  const continuationHandle = text(raw.continuationHandle, 24);
  const resumeIntentHandle = text(raw.resumeIntentHandle, 24);
  const abandonIntentHandle = text(raw.abandonIntentHandle, 24);
  if (resumeIntentHandle && handles
    && !handles.suspendedIntents.some((item) => item.handle === resumeIntentHandle && item.resumable)) return undefined;
  if (abandonIntentHandle && handles
    && !handles.suspendedIntents.some((item) => item.handle === abandonIntentHandle)) return undefined;
  if (resumeIntentHandle && abandonIntentHandle) return undefined;
  const worldActionRaw = record(raw.worldAction);
  const description = text(worldActionRaw?.description, 240);
  const expectedResult = text(worldActionRaw?.expectedResult, 180);
  const completion = sanitizeBoundPlanCompletion(raw.completion);
  return {
    version: 'mental-plan-translation-v1',
    steps,
    disposition,
    ...(completion ? { completion } : {}),
    ...(firstStepHandle ? { firstStepHandle } : {}),
    ...(continuationHandle ? { continuationHandle } : {}),
    ...(resumeIntentHandle ? { resumeIntentHandle } : {}),
    ...(abandonIntentHandle ? { abandonIntentHandle } : {}),
    ...(description ? {
      worldAction: {
        description,
        ...(expectedResult ? { expectedResult } : {}),
      },
    } : {}),
  };
}

function selectedOptionForPlan(
  context: DecisionRequestContext,
  plan: ModelPlanOutput,
): DecisionRequestContext['options'][number] | undefined {
  const match = /^o([1-9]\d*)$/u.exec(plan.firstStepHandle ?? '');
  return match ? context.options[Number(match[1]) - 1] : undefined;
}

function selectedSuspendedIntentForHandle(
  context: DecisionRequestContext,
  handle: string | undefined,
  protocol: DecisionModelRequestProtocol,
): DecisionRequestContext['suspendedIntents'][number] | undefined {
  const intentId = protocol.handles.suspendedIntents
    .find((candidate) => candidate.handle === handle)?.intentId;
  return intentId ? context.suspendedIntents.find((intent) => intent.id === intentId) : undefined;
}

function exposedWorldTargets(protocol: DecisionModelRequestProtocol): Array<Record<string, unknown> & { ref: string }> {
  const visible = record(protocol.requestContext.visible);
  return [
    {
      ref: 'self',
      kind: '本人',
      name: text(protocol.requestContext.person.name, 80) || '本人',
    },
    ...protocol.requestContext.actionSpace.heldObjects,
    ...(((visible?.nearbyObjects as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((item) => text(item.ref, 24)) as Array<Record<string, unknown> & { ref: string }>),
    ...(((visible?.surfaces as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((item) => text(item.ref, 24)) as Array<Record<string, unknown> & { ref: string }>),
  ];
}

function worldRefForHandle(handles: DecisionProbeHandleMap, handle: unknown, actorId = ''): WorldRef | undefined {
  const normalized = text(handle, 24);
  if (normalized === 'self' && actorId) return { kind: 'person', personId: actorId };
  if (normalized === 'self') return { kind: 'person', personId: '__self__' };
  const ownStackId = heldStackId(handles, normalized);
  if (ownStackId) {
    return { kind: 'inventory-stack', personId: actorId, stackId: ownStackId };
  }
  const voxel = voxelPosition(handles, normalized);
  if (voxel) return { kind: 'voxel', position: voxel };
  const visible = handles.visible.find((item) => item.handle === normalized);
  if (!visible) return undefined;
  if (visible.kind === 'drop') return { kind: 'drop', dropId: visible.dropId };
  if (visible.kind === 'person') return { kind: 'person', personId: visible.personId };
  if (visible.kind === 'animal') return { kind: 'animal', animalId: visible.animalId };
  if (visible.kind === 'work') return { kind: 'work', workId: visible.workId };
  return { kind: 'container', containerId: visible.containerId };
}

function sanitizeWorldAction(input: unknown, protocol: DecisionModelRequestProtocol): ModelWorldAction | undefined {
  const raw = record(input);
  const description = text(raw?.description, 240);
  const expectedResult = text(raw?.expectedResult, 180);
  const methodHandle = text(raw?.methodHandle, 32);
  if (!raw || !description || !Array.isArray(raw.targetHandles) || raw.targetHandles.length > 8) return undefined;
  const targetHandles = raw.targetHandles.map((value) => text(value, 24));
  if (targetHandles.some((handle) => !handle) || new Set(targetHandles).size !== targetHandles.length) return undefined;
  const exposed = new Set(exposedWorldTargets(protocol).map((item) => text(item.ref, 24)));
  if (targetHandles.some((handle) => !exposed.has(handle) || !worldRefForHandle(protocol.handles, handle))) return undefined;
  return {
    description,
    targetHandles,
    ...(expectedResult ? { expectedResult } : {}),
    ...(methodHandle && protocol.requestContext.knownMethods?.some((method) => method.handle === methodHandle) ? { methodHandle } : {}),
  };
}

function sanitizePlanFeedback(input: unknown, protocol: DecisionModelRequestProtocol): ModelPlanFeedback | undefined {
  const raw = record(input);
  const correction = text(raw?.correction, 240);
  const adjustment = text(raw?.adjustment, 240);
  if (!raw || !correction || !adjustment || !Array.isArray(raw.sourceMemoryHandles)) return undefined;
  const sourceHandles = [...new Set(raw.sourceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))].slice(0, 3);
  const memories = sourceHandles.map((handle) => protocol.handles.memories.find((memory) => memory.handle === handle));
  if (!sourceHandles.length
    || memories.some((memory) => !memory)
    || !memories.some((memory) => memory?.causalOutcome === 'blocked' || memory?.causalOutcome === 'failed')) return undefined;
  return {
    correction,
    adjustment,
    sourceMemoryHandles: sourceHandles,
    sourceEventIds: [...new Set(memories.flatMap((memory) => memory!.sourceFactIds))].slice(-24),
  };
}

function sanitizeModelPlan(
  input: unknown,
  protocol: DecisionModelRequestProtocol,
  context?: DecisionRequestContext,
  readableAction = false,
): ModelPlanOutput | undefined {
  const raw = record(input);
  if (!raw || !Array.isArray(raw.steps)) return undefined;
  const steps = raw.steps.map((value) => text(value, 240)).filter(Boolean);
  if (!steps.length || steps.length !== raw.steps.length) return undefined;
  const completion = (context ? compileModelPlanCompletion(raw.completion, context, protocol.handles) : undefined)
    ?? sanitizeBoundPlanCompletion(raw.completion);
  const knownSteps = new Set(protocol.requestContext.availableSteps.map((step) => step.handle));
  const knownContinuations = new Set(protocol.requestContext.continuations.map((step) => step.handle));
  const knownSuspendedIntents = new Set(protocol.handles.suspendedIntents.map((intent) => intent.handle));
  const knownResumableIntents = new Set(protocol.handles.suspendedIntents
    .filter((intent) => intent.resumable)
    .map((intent) => intent.handle));
  const requestedAction = text(raw.selectedAction, 320);
  const actionMatch = readableAction && requestedAction
    ? protocol.requestContext.availableSteps.find((step) => readableAgentAction(step) === requestedAction)
    : undefined;
  if (readableAction && requestedAction && !actionMatch) return undefined;
  const requestedStepHandle = readableAction
    ? actionMatch?.handle ?? ''
    : text(raw.firstStepHandle, 24);
  const requestedContinuationHandle = text(raw.continuationHandle, 24);
  const firstStepHandle = knownSteps.has(requestedStepHandle) ? requestedStepHandle : '';
  const requestedExpression = firstStepHandle === 'expression';
  const freeExpression = requestedExpression || raw.freeExpression === true;
  const continuationHandle = knownContinuations.has(requestedContinuationHandle)
    ? requestedContinuationHandle
    : '';
  const requestedResumeIntentHandle = text(raw.resumeIntentHandle, 24);
  const resumeIntentHandle = knownResumableIntents.has(requestedResumeIntentHandle)
    ? requestedResumeIntentHandle
    : '';
  if (requestedResumeIntentHandle && !resumeIntentHandle) return undefined;
  const requestedAbandonIntentHandle = text(raw.abandonIntentHandle, 24);
  const abandonIntentHandle = knownSuspendedIntents.has(requestedAbandonIntentHandle)
    ? requestedAbandonIntentHandle
    : '';
  if (requestedAbandonIntentHandle && !abandonIntentHandle) return undefined;
  const selectedStep = protocol.requestContext.availableSteps.find((step) => step.handle === firstStepHandle);
  const groundingFactHandles = Array.isArray(raw.groundingFactHandles)
    ? [...new Set(raw.groundingFactHandles.map((value) => text(value, 24)).filter(Boolean))]
      .filter((handle) => protocol.handles.groundingFacts.some((fact) => fact.handle === handle))
      .slice(0, 3)
    : [];
  const experiment = record(raw.experiment);
  const validExperiment = experiment ? sanitizedProbe(experiment, protocol.handles) : undefined;
  const requestedWorldAction = raw.worldAction !== undefined && raw.worldAction !== null;
  const worldAction = sanitizeWorldAction(raw.worldAction, protocol);
  if (requestedWorldAction && !worldAction && !firstStepHandle && !validExperiment) return undefined;
  if (readableAction && experiment && !validExperiment && !worldAction) return undefined;
  // Plan describes an attempted action.  A separate world-semantics request
  // authors its verdict; accepting an embedded verdict here would let the
  // character's planner decide whether its own idea worked.
  const adjudicatedWorldAction = worldAction && !selectedStep?.communicationKind
    ? worldAction
    : undefined;
  const feedbackInput = record(raw.feedback);
  const requestedFeedback = Boolean(feedbackInput && Object.keys(feedbackInput).length);
  const feedback = sanitizePlanFeedback(raw.feedback, protocol);
  if (requestedFeedback && !feedback) return undefined;
  const rawDisposition = text(raw.disposition, 24);
  const disposition = rawDisposition === 'act'
    || rawDisposition === 'continue'
    || rawDisposition === 'pause'
    || rawDisposition === 'abandon'
    || rawDisposition === 'stay'
    ? rawDisposition
    : undefined;
  if (rawDisposition && !disposition) return undefined;
  if (!disposition) return undefined;
  // A free-form worldAction is the Plan's most specific output. It is still
  // only a request here; the independent resolver authors the result later.
  const effectiveFirstStepHandle = adjudicatedWorldAction || requestedExpression ? '' : firstStepHandle;
  const effectiveExperiment = adjudicatedWorldAction ? undefined : validExperiment;
  const actionCount = Number(Boolean(effectiveFirstStepHandle))
    + Number(Boolean(resumeIntentHandle))
    + Number(Boolean(effectiveExperiment))
    + Number(Boolean(adjudicatedWorldAction));
  const effectiveActionCount = actionCount + Number(requestedExpression);
  const hasAction = effectiveActionCount === 1;
  if (effectiveActionCount > 1) return undefined;
  if (resumeIntentHandle && continuationHandle) return undefined;
  if (abandonIntentHandle && (hasAction || continuationHandle || disposition !== 'abandon')) return undefined;
  if (disposition === 'act' && !hasAction) return undefined;
  if (disposition && disposition !== 'act' && hasAction) return undefined;
  return {
    steps,
    ...(completion ? { completion } : {}),
    ...(disposition ? { disposition: requestedExpression ? 'stay' as const : disposition } : {}),
    ...(freeExpression ? { freeExpression: true } : {}),
    ...(effectiveFirstStepHandle ? { firstStepHandle: effectiveFirstStepHandle } : {}),
    ...(continuationHandle ? { continuationHandle } : {}),
    ...(resumeIntentHandle ? { resumeIntentHandle } : {}),
    ...(abandonIntentHandle ? { abandonIntentHandle } : {}),
    ...(selectedStep?.communicationKind && groundingFactHandles.length ? { groundingFactHandles } : {}),
    ...(!effectiveFirstStepHandle && effectiveExperiment ? { experiment: experiment! } : {}),
    ...(adjudicatedWorldAction ? { worldAction: adjudicatedWorldAction } : {}),
    ...(feedback ? { feedback } : {}),
  };
}

function stagedDecisionOutput(
  intention: MindIntentionOutput,
  plan: ModelPlanOutput | undefined,
  protocol: DecisionModelRequestProtocol,
  context: DecisionRequestContext,
  worldFeedback?: string,
): Record<string, unknown> {
  const selectedStep = plan?.firstStepHandle
    ? protocol.requestContext.availableSteps.find((step) => step.handle === plan.firstStepHandle)
    : undefined;
  const resumedIntent = plan?.resumeIntentHandle
    ? selectedSuspendedIntentForHandle(context, plan.resumeIntentHandle, protocol)
    : undefined;
  const abandonedIntent = plan?.abandonIntentHandle
    ? selectedSuspendedIntentForHandle(context, plan.abandonIntentHandle, protocol)
    : undefined;
  const kind = plan?.freeExpression ? 'pursue' : resumedIntent || plan?.disposition === 'continue'
    ? 'continue'
    : plan?.disposition === 'pause' || plan?.disposition === 'abandon'
      ? 'reconsider'
      : plan?.disposition === 'stay'
        ? 'wait'
        : selectedStep?.communicationKind
    ? 'talk'
    : plan?.experiment || plan?.worldAction
      ? 'investigate'
      : 'pursue';
  const strategy = plan?.freeExpression ? intention.utterance : selectedStep
    ? readableAgentAction(selectedStep)
    : resumedIntent
      ? `恢复此前搁置的事务：${resumedIntent.summary}`
    : abandonedIntent
      ? `不再保留此前搁置的事务：${abandonedIntent.summary}`
    : plan?.experiment
      ? `按自己选定的具体对象进行一次${text(plan.experiment.kind, 24) || '观察'}尝试`
      : plan?.worldAction
        ? plan.worldAction.description
      : plan?.disposition === 'continue'
        ? '继续当前已经开始的工作'
        : plan?.disposition === 'pause'
          ? '暂时搁置当前工作'
          : plan?.disposition === 'abandon'
            ? '不再继续当前工作'
            : worldFeedback
              ? `世界反馈：${worldFeedback}`
              : `此刻不采取行动，保留“${intention.goal}”`;
  const linkedAgendaHandle = plan?.firstStepHandle
    ? (() => {
        const option = selectedOptionForPlan(context, plan);
        const itemId = option?.characterAgendaItemId;
        return itemId ? protocol.handles.agendas.find((agenda) => agenda.itemId === itemId)?.handle : undefined;
      })()
    : undefined;
  return {
    kind,
    utterance: intention.utterance,
    delivery: intention.delivery,
    speechIntent: intention.speechIntent,
    goal: intention.goal,
    orientation: intention.orientation,
    horizon: intention.horizon,
    strategy,
    assumptions: [],
    ...(plan ? {
      plan: {
        version: 'mental-plan-translation-v1',
        steps: [...plan.steps],
        ...(plan.completion ? { completion: structuredClone(plan.completion) } : {}),
        disposition: plan.disposition ?? 'stay',
        ...(plan.firstStepHandle ? { firstStepHandle: plan.firstStepHandle } : {}),
        ...(plan.continuationHandle ? { continuationHandle: plan.continuationHandle } : {}),
        ...(plan.resumeIntentHandle ? { resumeIntentHandle: plan.resumeIntentHandle } : {}),
        ...(plan.abandonIntentHandle ? { abandonIntentHandle: plan.abandonIntentHandle } : {}),
        ...(plan.worldAction ? {
          worldAction: {
            description: plan.worldAction.description,
            ...(plan.worldAction.expectedResult
              ? { expectedResult: plan.worldAction.expectedResult }
              : {}),
          },
        } : {}),
      },
    } : {}),
    ...(intention.evidenceMemoryHandles.length
      ? { evidenceMemoryHandles: intention.evidenceMemoryHandles }
      : {}),
    ...(intention.relationshipAppraisal
      ? { relationshipAppraisal: structuredClone(intention.relationshipAppraisal) }
      : {}),
    ...(plan?.firstStepHandle ? { firstStepHandle: plan.firstStepHandle } : {}),
    ...(plan?.continuationHandle ? { continuationHandle: plan.continuationHandle } : {}),
    ...(plan?.resumeIntentHandle ? { resumeIntentHandle: plan.resumeIntentHandle } : {}),
    ...(plan?.abandonIntentHandle ? { abandonIntentHandle: plan.abandonIntentHandle } : {}),
    ...(plan?.groundingFactHandles ? { groundingFactHandles: plan.groundingFactHandles } : {}),
    ...(plan?.experiment ? { experiment: plan.experiment } : {}),
    ...(plan?.feedback ? { planFeedback: plan.feedback } : {}),
    ...(plan?.disposition ? { intentDisposition: plan.disposition } : {}),
    ...(intention.horizon === 'ongoing' && protocol.characterAgendaProposal && !resumedIntent && !abandonedIntent ? {
      concern: linkedAgendaHandle
        ? { kind: 'revise', agendaHandle: linkedAgendaHandle, importance: 60, horizonMonths: 24 }
        : { kind: 'create', importance: 60, horizonMonths: 24 },
    } : {}),
  };
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.round(value)))
    : fallback;
}

function heldStackId(handles: DecisionProbeHandleMap, handle: unknown): string | undefined {
  const normalized = text(handle, 24);
  return handles.held.find((item) => item.handle === normalized)?.stackId;
}

function voxelPosition(
  handles: DecisionProbeHandleMap,
  handle: unknown,
): { x: number; y: number; z: number } | undefined {
  const normalized = text(handle, 24);
  const position = handles.voxels.find((item) => item.handle === normalized)?.position;
  return position ? { ...position } : undefined;
}

function observationProbe(
  handles: DecisionProbeHandleMap,
  handle: unknown,
): Extract<CharacterAgendaProbe, { kind: 'observe' }> | undefined {
  const normalized = text(handle, 24);
  const ownStackId = heldStackId(handles, normalized);
  if (ownStackId) return { kind: 'observe', target: { kind: 'own-inventory-stack', stackId: ownStackId } };
  const voxel = voxelPosition(handles, normalized);
  if (voxel) return { kind: 'observe', target: { kind: 'voxel', position: voxel } };
  const visible = handles.visible.find((item) => item.handle === normalized);
  if (!visible) return undefined;
  if (visible.kind === 'drop') return { kind: 'observe', target: { kind: 'drop', dropId: visible.dropId } };
  if (visible.kind === 'person') return { kind: 'observe', target: { kind: 'person', personId: visible.personId } };
  if (visible.kind === 'animal') return { kind: 'observe', target: { kind: 'animal', animalId: visible.animalId } };
  if (visible.kind === 'work') return { kind: 'observe', target: { kind: 'work', workId: visible.workId } };
  return { kind: 'observe', target: { kind: 'container', containerId: visible.containerId } };
}

function sanitizedProbe(input: unknown, handles: DecisionProbeHandleMap): CharacterAgendaProbe | undefined {
  const raw = record(input);
  if (!raw) return undefined;
  const kind = text(raw.kind, 24);
  if (kind === 'observe') return observationProbe(handles, raw.targetHandle);
  if (kind === 'combine') {
    const stackHandles = Array.isArray(raw.stackHandles) ? raw.stackHandles : [];
    if (stackHandles.length < 2 || stackHandles.length > 3) return undefined;
    const stackIds = stackHandles.map((handle) => heldStackId(handles, handle));
    if (stackIds.some((stackId) => !stackId) || new Set(stackIds).size !== stackIds.length) return undefined;
    return stackIds.length === 2
      ? { kind: 'combine', ownStackIds: [stackIds[0]!, stackIds[1]!] }
      : { kind: 'combine', ownStackIds: [stackIds[0]!, stackIds[1]!, stackIds[2]!] };
  }
  if (kind === 'expose') {
    const inputStackId = heldStackId(handles, raw.inputHandle);
    const target = voxelPosition(handles, raw.targetHandle);
    return inputStackId && target
      ? { kind: 'expose', inputStackId, target: { kind: 'voxel', position: target } }
      : undefined;
  }
  if (kind === 'exert') {
    const toolStackId = heldStackId(handles, raw.toolHandle);
    const inputStackId = heldStackId(handles, raw.inputHandle);
    const target = voxelPosition(handles, raw.targetHandle);
    return toolStackId && inputStackId && toolStackId !== inputStackId && target
      ? { kind: 'exert', toolStackId, inputStackId, target: { kind: 'voxel', position: target } }
      : undefined;
  }
  if (kind === 'move') {
    const target = voxelPosition(handles, raw.targetHandle);
    return target ? { kind: 'move', target: { kind: 'voxel', position: target } } : undefined;
  }
  return undefined;
}

/**
 * Rebuilds a proposal from an allow-list. Model-supplied facts, recipes,
 * outputs, knowledge and dispositions never survive this boundary.
 */
export function sanitizeCharacterAgendaProposal(
  input: unknown,
  handles: DecisionProbeHandleMap,
): CharacterAgendaProposal | undefined {
  const raw = record(input);
  const approach = record(raw?.approach);
  const aim = text(raw?.aim, 240);
  const theme = text(raw?.theme, 80);
  const summary = text(approach?.summary, 240);
  if (!raw || !approach || !aim || !theme || !summary) return undefined;
  const requestedProbe = Object.prototype.hasOwnProperty.call(approach, 'probe');
  const requestedAgendaHandle = Object.prototype.hasOwnProperty.call(raw, 'agendaHandle');
  const agendaHandle = text(raw.agendaHandle, 24);
  const existingAgenda = handles.agendas.find((item) => item.handle === agendaHandle);
  if (requestedAgendaHandle && !existingAgenda) return undefined;
  const requestedMemoryHandles = Array.isArray(raw.sourceMemoryHandles)
    ? [...new Set(raw.sourceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))].slice(0, 4)
    : [];
  const sourceMemories = requestedMemoryHandles.map((handle) => (
    handles.memories.find((memory) => memory.handle === handle)
  ));
  if (sourceMemories.some((memory) => !memory)) return undefined;
  const probe = sanitizedProbe(approach.probe, handles);
  return {
    ...(existingAgenda ? { basisKey: existingAgenda.basisKey } : {}),
    aim,
    theme,
    importance: boundedNumber(raw.importance, 50, 0, 100),
    horizonMonths: boundedNumber(raw.horizonMonths, 12, 6, 240),
    ...(sourceMemories.length ? {
      sourceFactIds: [...new Set(sourceMemories.flatMap((memory) => memory!.sourceFactIds))].slice(-24),
    } : {}),
    approach: {
      summary,
      disposition: probe?.kind === 'observe'
        ? 'observation-needed'
        : probe
          ? 'bounded-experiment'
          : requestedProbe
            ? 'missing-affordance'
            : 'executable-now',
      ...(probe ? { probe } : {}),
    },
  };
}

/** One-request handles are resolved here; the domain never sees model ids. */
export function sanitizeCharacterAgendaUpdate(
  input: unknown,
  handles: DecisionProbeHandleMap,
): CharacterAgendaUpdate | undefined {
  const raw = record(input);
  const kind = text(raw?.kind, 24);
  if (!raw || (kind !== 'create' && kind !== 'revise' && kind !== 'pause' && kind !== 'abandon')) {
    return undefined;
  }
  const requestedHandle = Object.prototype.hasOwnProperty.call(raw, 'agendaHandle');
  const agendaHandle = text(raw.agendaHandle, 24);
  const existingAgenda = handles.agendas.find((item) => item.handle === agendaHandle);
  if (kind === 'create') {
    if (requestedHandle) return undefined;
    const proposal = sanitizeCharacterAgendaProposal(raw, handles);
    return proposal ? { kind, proposal } : undefined;
  }
  if (!existingAgenda) return undefined;
  if (kind === 'pause' || kind === 'abandon') {
    return {
      kind,
      basisKey: existingAgenda.basisKey,
      reason: text(raw.reason, 180) || (kind === 'pause' ? '暂时搁置这个长期关切' : '不再继续这个长期关切'),
    };
  }
  const proposal = sanitizeCharacterAgendaProposal(raw, handles);
  return proposal ? { kind, proposal } : undefined;
}

const MENTAL_ACT_KINDS = new Set<MentalActKind>([
  'pursue',
  'investigate',
  'talk',
  'reconsider',
  'continue',
  'wait',
]);

function sanitizeMentalAct(
  input: unknown,
  handles: DecisionProbeHandleMap,
): MentalAct | undefined {
  const raw = record(input);
  const kind = text(raw?.kind, 24) as MentalActKind;
  if (!raw || !MENTAL_ACT_KINDS.has(kind)) return undefined;
  const utterance = boundedUtterance(raw.utterance);
  const delivery = raw.delivery === 'whisper' || raw.delivery === 'normal' || raw.delivery === 'call'
    ? raw.delivery
    : undefined;
  if (!utterance || !delivery) return undefined;
  const goal = text(raw.goal, 240)
    || (kind === 'continue' ? '继续当前正在做的事情' : kind === 'wait' ? '暂时不改变方向' : '处理眼前处境');
  const strategy = text(raw.strategy, 320)
    || (kind === 'continue' ? '沿当前意图继续下一步' : kind === 'wait' ? '先等待新的可感知变化' : '先做一项能够观察结果的尝试');
  const assumptions = Array.isArray(raw.assumptions)
    ? [...new Set(raw.assumptions.map((value) => text(value, 180)).filter(Boolean))].slice(0, 4)
    : [];
  const requestedMemoryHandles = Array.isArray(raw.evidenceMemoryHandles)
    ? [...new Set(raw.evidenceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))].slice(0, 4)
    : [];
  const memories = requestedMemoryHandles.map((handle) => handles.memories.find((item) => item.handle === handle));
  if (memories.some((memory) => !memory)) return undefined;
  const expectedObservation = text(raw.expectedObservation, 240);
  const plan = sanitizeMentalPlanTranslation(raw.plan, handles);
  const relationshipAppraisal = sanitizeStagedRelationshipAppraisal(raw.relationshipAppraisal, handles);
  const rawSpeechIntent = record(raw.speechIntent);
  const speechIntent = compileMindSpeechIntent(raw.speechIntent, handles, Boolean(rawSpeechIntent?.referenceId || Array.isArray(rawSpeechIntent?.counterpartIds)));
  const planFeedbackRaw = record(raw.planFeedback);
  const planFeedbackCorrection = text(planFeedbackRaw?.correction, 240);
  const planFeedbackAdjustment = text(planFeedbackRaw?.adjustment, 240);
  const planFeedbackSourceEventIds = Array.isArray(planFeedbackRaw?.sourceEventIds)
    ? [...new Set(planFeedbackRaw.sourceEventIds.map((value) => text(value, 160)).filter(Boolean))].slice(-24)
    : [];
  const planFeedback = planFeedbackCorrection && planFeedbackAdjustment && planFeedbackSourceEventIds.length
    ? {
        correction: planFeedbackCorrection,
        adjustment: planFeedbackAdjustment,
        sourceEventIds: planFeedbackSourceEventIds,
      }
    : undefined;
  const orientation = raw.orientation === 'social'
    || raw.orientation === 'inquiry'
    || raw.orientation === 'survival'
    || raw.orientation === 'construction'
    || raw.orientation === 'acquisition'
    || raw.orientation === 'exploration'
    || raw.orientation === 'rest'
    ? raw.orientation
    : undefined;
  const horizon = raw.horizon === 'momentary' || raw.horizon === 'ongoing'
    ? raw.horizon
    : undefined;
  return {
    version: 'mental-act-v2',
    kind,
    utterance,
    delivery,
    goal,
    speechIntent,
    ...(orientation ? { orientation } : {}),
    ...(horizon ? { horizon } : {}),
    strategy,
    assumptions,
    ...(expectedObservation ? { expectedObservation } : {}),
    ...(plan ? { plan } : {}),
    ...(relationshipAppraisal ? { relationshipAppraisal } : {}),
    ...(planFeedback ? { planFeedback } : {}),
    sourceEventIds: [...new Set(memories.flatMap((memory) => memory!.sourceFactIds))].slice(-24),
  };
}

function concernUpdateForMentalAct(
  input: unknown,
  experimentInput: unknown,
  sourceMemoryHandles: unknown,
  mentalAct: MentalAct,
  handles: DecisionProbeHandleMap,
): CharacterAgendaUpdate | undefined {
  const raw = record(input);
  const kind = text(raw?.kind, 24);
  if (!raw || (kind !== 'create' && kind !== 'revise' && kind !== 'pause' && kind !== 'abandon')) {
    return undefined;
  }
  const agendaHandle = text(raw.agendaHandle, 24);
  const existing = handles.agendas.find((item) => item.handle === agendaHandle);
  if (kind === 'pause' || kind === 'abandon') {
    return existing ? {
      kind,
      basisKey: existing.basisKey,
      reason: text(raw.reason, 180) || mentalAct.strategy,
    } : undefined;
  }
  if (kind === 'create' && agendaHandle || kind === 'revise' && !existing) return undefined;
  const proposal = sanitizeCharacterAgendaProposal({
    ...(existing ? { agendaHandle, basisKey: existing.basisKey } : {}),
    aim: mentalAct.goal,
    theme: mentalAct.orientation ?? (mentalAct.kind === 'investigate' ? 'inquiry' : 'personal'),
    importance: boundedNumber(raw.importance, mentalAct.kind === 'investigate' ? 62 : 58, 0, 100),
    horizonMonths: boundedNumber(raw.horizonMonths, 12, 6, 240),
    sourceMemoryHandles,
    approach: {
      summary: mentalAct.plan?.steps.length
        ? mentalAct.plan.steps.join('；然后').slice(0, 240)
        : mentalAct.strategy,
      ...(experimentInput ? { probe: experimentInput } : {}),
    },
  }, handles);
  if (!proposal) return undefined;
  return kind === 'create' ? { kind, proposal } : { kind, proposal };
}

export function expandDecisionModelOutput(
  context: DecisionRequestContext,
  input: unknown,
  protocol: Pick<DecisionModelRequestProtocol, 'requestContext' | 'handles' | 'characterAgendaProposal'>,
): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = { ...(input as Record<string, unknown>) };
  const mentalAct = sanitizeMentalAct(raw, protocol.handles);
  if (!mentalAct) return null;
  raw.mentalAct = mentalAct;
  delete raw.utterance;
  delete raw.delivery;
  const requestedStep = Object.prototype.hasOwnProperty.call(raw, 'firstStepHandle');
  const requestedContinuation = Object.prototype.hasOwnProperty.call(raw, 'continuationHandle');
  const requestedResume = Object.prototype.hasOwnProperty.call(raw, 'resumeIntentHandle');
  const requestedAbandon = Object.prototype.hasOwnProperty.call(raw, 'abandonIntentHandle');
  const stepHandle = text(raw.firstStepHandle, 24);
  const continuationHandle = text(raw.continuationHandle, 24);
  const resumeIntentHandle = text(raw.resumeIntentHandle, 24);
  const abandonIntentHandle = text(raw.abandonIntentHandle, 24);
  const exposedSteps = new Set(protocol.requestContext.availableSteps.map((step) => step.handle));
  const exposedContinuations = new Set(protocol.requestContext.continuations.map((step) => step.handle));
  const exposedSuspendedIntents = new Set(protocol.handles.suspendedIntents.map((intent) => intent.handle));
  const exposedResumableIntents = new Set(protocol.handles.suspendedIntents
    .filter((intent) => intent.resumable)
    .map((intent) => intent.handle));
  if ((requestedStep && !exposedSteps.has(stepHandle))
    || (requestedContinuation && !exposedContinuations.has(continuationHandle))
    || (requestedResume && !exposedResumableIntents.has(resumeIntentHandle))
    || (requestedAbandon && !exposedSuspendedIntents.has(abandonIntentHandle))) return null;
  const optionIndex = /^o([1-9]\d*)$/u.exec(stepHandle);
  const continuationIndex = /^([fo])([1-9]\d*)$/u.exec(continuationHandle);
  const optionId = optionIndex ? context.options[Number(optionIndex[1]) - 1]?.id : undefined;
  const followUpOptionId = continuationIndex
    ? (continuationIndex[1] === 'f' ? context.followUpOptions : context.options)[Number(continuationIndex[2]) - 1]?.id
    : undefined;
  const resumeIntentId = protocol.handles.suspendedIntents
    .find((intent) => intent.handle === resumeIntentHandle)?.intentId;
  const abandonIntentId = protocol.handles.suspendedIntents
    .find((intent) => intent.handle === abandonIntentHandle)?.intentId;
  if (requestedStep && !optionId) return null;
  if (requestedContinuation && !followUpOptionId) return null;
  if (requestedResume && !resumeIntentId) return null;
  if (requestedAbandon && !abandonIntentId) return null;
  if (optionId) raw.optionId = optionId;
  else delete raw.optionId;
  if (followUpOptionId) raw.followUpOptionId = followUpOptionId;
  else delete raw.followUpOptionId;
  if (resumeIntentId) raw.resumeIntentId = resumeIntentId;
  else delete raw.resumeIntentId;
  if (abandonIntentId) raw.abandonIntentId = abandonIntentId;
  else delete raw.abandonIntentId;
  delete raw.resumeIntentHandle;
  delete raw.abandonIntentHandle;
  const selectedOptionId = text(raw.optionId, 512);
  const selectedOption = context.options.find((option) => option.id === selectedOptionId);
  const requestedGrounding = Object.prototype.hasOwnProperty.call(raw, 'groundingFactHandles');
  const groundingHandles = Array.isArray(raw.groundingFactHandles)
    ? raw.groundingFactHandles.map((handle) => text(handle, 24))
    : [];
  if (selectedOption?.openConversationGrounding) {
    const uniqueHandles = [...new Set(groundingHandles)];
    const resolved = uniqueHandles.map((handle) => protocol.handles.groundingFacts.find((fact) => (
      fact.handle === handle && fact.optionId === selectedOption.id
    )));
    raw.groundingSourceFactIds = (!requestedGrounding || Array.isArray(raw.groundingFactHandles))
      && groundingHandles.length <= 3
      && groundingHandles.every(Boolean)
      && resolved.every(Boolean)
      ? resolved.map((fact) => fact!.sourceFactId)
      : null;
  } else if (requestedGrounding) {
    raw.groundingSourceFactIds = null;
  }
  delete raw.characterAgendaUpdate;
  delete raw.characterAgendaProposal;
  if (protocol.characterAgendaProposal) {
    const update = concernUpdateForMentalAct(
      raw.concern,
      raw.experiment,
      raw.evidenceMemoryHandles,
      mentalAct,
      protocol.handles,
    );
    if (update) {
      raw.characterAgendaUpdate = update;
    } else delete raw.characterAgendaUpdate;
  } else {
    delete raw.characterAgendaUpdate;
  }
  delete raw.concern;
  delete raw.experiment;
  delete raw.memoryConsolidation;
  return raw;
}

function isReasoningOnlyOpenAiChatResponse(error: unknown, endpoint: ResolvedModelEndpoint): boolean {
  if (endpoint.protocol !== 'openai-chat'
    || !(error instanceof ModelRequestError)
    || error.code !== 'invalid-response'
    || !error.message.includes('没有返回最终文本')) return false;
  return /finish_reason=(?:length|stop)\b/u.test(error.message)
    && /reasoning_length=[1-9]\d*/u.test(error.message);
}

async function requestMindIntention(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  correction?: { invalidContent: string; problem: string },
  conciseRetry = false,
): Promise<{ content: string; usage: TokenUsage }> {
  const messages: ModelMessage[] = [
    { role: 'system', content: MIND_INTENTION_SYSTEM_PROMPT_V5 },
    { role: 'user', content: JSON.stringify(protocol.mindContext) },
  ];
  const noteMessage = characterNoteMessage(characterNoteFromRequestContext(protocol.mindContext), 'next-intention');
  if (noteMessage) messages.push(noteMessage);
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    {
      role: 'user',
      content: `上一个 Mind intention 协议无效：${correction.problem}。请只修正意图 JSON，不要规划动作。`,
    },
  );
  if (conciseRetry) messages.push({
    role: 'user',
    content: '上一轮只返回了内部推理，没有最终 JSON。直接输出一个 Mind intention JSON。',
  });
  const response = await requestModelText(endpoint, {
    messages,
    temperature: decisionPhaseTemperature('mind'),
    maxOutputTokens: decisionMaxOutputTokens(),
    jsonObject: true,
    jsonSchema: buildMindIntentionJsonSchema(protocol),
    timeoutMs: decisionTimeout(endpoint),
  });
  return { content: response.text, usage: response.usage };
}

async function requestModelPlan(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  intention: MindIntentionOutput,
  correction?: { invalidContent: string; problem: string },
): Promise<{ content: string; usage: TokenUsage }> {
  const context = agentPlanRequestContext(protocol, intention);
  const messages: ModelMessage[] = [
    { role: 'system', content: AGENT_PLAN_SYSTEM_PROMPT_V1 },
    { role: 'user', content: JSON.stringify(context) },
  ];
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    {
      role: 'user',
      content: [
        `上一个 Plan 协议无效：${correction.problem}。请只修正规划 JSON，不要改写 intention。`,
        '既有入口不能表达具体做法时，使用 worldAction 描述当前可尝试的第一步；缺少配方或固定动词不是停留的原因。',
      ].join('\n'),
    },
  );
  const response = await requestModelText(endpoint, {
    messages,
    temperature: decisionPhaseTemperature('plan'),
    maxOutputTokens: decisionMaxOutputTokens(),
    jsonObject: true,
    jsonSchema: buildModelPlanJsonSchema(protocol),
    timeoutMs: decisionTimeout(endpoint),
  });
  return { content: response.text, usage: response.usage };
}

function worldResolutionRequestContext(
  protocol: DecisionModelRequestProtocol,
  worldAction: ModelWorldAction,
): Record<string, unknown> {
  return {
    schemaVersion: 'world-semantics-context-v1',
    actor: protocol.requestContext.person,
    situation: protocol.requestContext.situation,
    visible: protocol.requestContext.visible,
    actionSpace: protocol.requestContext.actionSpace,
    worldAction,
    ...(worldAction.methodHandle ? { referencedMethod: protocol.requestContext.knownMethods?.find((method) => method.handle === worldAction.methodHandle) } : {}),
    executionEvidence: {
      ...(protocol.requestContext.current.planContinuation ? { planContinuation: protocol.requestContext.current.planContinuation } : {}),
      recentWork: protocol.requestContext.current.recentlyFinishedWork,
    },
    ...(protocol.requestContext.current.planContinuation ? {
      executionMode: 'continue-existing-plan-without-new-speech',
    } : {}),
    ...planAgentWorldContext(),
  };
}

async function requestWorldResolution(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  worldAction: ModelWorldAction,
  correction?: { invalidContent: string; problem: string },
): Promise<{ content: string; usage: TokenUsage }> {
  const messages: ModelMessage[] = [
    { role: 'system', content: PLAN_AGENT_WORLD_VERDICT_V1 },
    { role: 'user', content: JSON.stringify(worldResolutionRequestContext(protocol, worldAction)) },
  ];
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    {
      role: 'user',
      content: `上一个世界结算协议无效：${correction.problem}。保持人物动作不变，只修正实际结果与 effects。`,
    },
  );
  const response = await requestModelText(endpoint, {
    messages,
    temperature: 0,
    maxOutputTokens: decisionMaxOutputTokens(),
    jsonObject: true,
    jsonSchema: buildWorldResolutionJsonSchema(protocol, worldAction),
    timeoutMs: decisionTimeout(endpoint),
  });
  return { content: response.text, usage: response.usage };
}

async function resolveWorldAction(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  worldAction: ModelWorldAction | undefined,
): Promise<{ resolution?: WorldAdjudicationResolution; usage: TokenUsage; providerRequests: number; failure?: string }> {
  if (!worldAction) return {
    usage: { inputTokens: 0, outputTokens: 0 },
    providerRequests: 0,
  };
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  let correction: { invalidContent: string; problem: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    providerRequests += 1;
    let response: Awaited<ReturnType<typeof requestWorldResolution>>;
    try {
      response = await requestWorldResolution(endpoint, protocol, worldAction, correction);
    } catch (error) {
      return { usage, providerRequests, failure: error instanceof Error ? error.message : String(error) };
    }
    usage = addUsage(usage, response.usage);
    let parsed: unknown;
    try {
      parsed = parseJson(response.content);
    } catch {
      correction = { invalidContent: response.content, problem: '不是 JSON 对象' };
      continue;
    }
    let problem = '世界变化无法编译，请依据 effect schema 绑定动作中的真实对象';
    const resolution = sanitizePlanAgentWorldVerdict(parsed, worldAction, protocol, (reason) => { problem = reason; });
    if (resolution) return { resolution, usage, providerRequests };
    correction = {
      invalidContent: response.content,
      problem,
    };
  }
  return { usage, providerRequests, failure: correction?.problem };
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    && value >= minimum && value <= maximum
    ? value
    : undefined;
}

/** Converts an independent world-semantics verdict into server-owned refs and a bounded mutation IR. */
export function sanitizePlanAgentWorldVerdict(
  input: unknown,
  worldActionInput: unknown,
  protocol: DecisionModelRequestProtocol,
  onInvalid?: (problem: string) => void,
): WorldAdjudicationResolution | undefined {
  const invalid = (problem: string): undefined => {
    onInvalid?.(problem);
    return undefined;
  };
  const worldAction = sanitizeWorldAction(worldActionInput, protocol);
  const raw = record(input);
  const status = raw?.status === 'completed' || raw?.status === 'blocked' || raw?.status === 'failed'
    ? raw.status
    : undefined;
  const result = text(raw?.result, 320);
  const rawEffects = Array.isArray(raw?.effects)
    ? raw.effects
    : raw?.effects === undefined || raw?.effects === null
      ? []
      : undefined;
  if (!worldAction || !raw || !status || !result || !rawEffects || rawEffects.length > 8) return invalid('需要 status、具体 result 与最多 8 项 effects；动作目标必须来自人物选中的 ref');
  if (status === 'blocked' && rawEffects.length) return invalid('blocked 表示没有开始，因此 effects 应为空；如果已经操作并发生变化，应结算 completed 或 failed');
  const feedbackRaw = record(raw.feedback);
  const feedbackCorrection = text(feedbackRaw?.correction, 240);
  const feedbackAdjustment = text(feedbackRaw?.adjustment, 240);
  if (status !== 'completed' && (!feedbackCorrection || !feedbackAdjustment)) {
    return invalid('blocked/failed 必须说明具体缺失条件 feedback.correction 和可改变的做法 feedback.adjustment；不能把协议错误说成人物失败');
  }
  const actorId = text(protocol.requestContext.person.id, 120);
  const requestedHandles = new Set(worldAction.targetHandles);
  const targets = worldAction.targetHandles.map((handle) => worldRefForHandle(protocol.handles, handle, actorId));
  if (targets.some((target) => !target)) return invalid('动作引用的对象不存在，请使用本次 worldAction.targetHandles');
  const materialByKey = new Map(MATERIAL_PALETTE.map((material) => [material.key, material]));
  const effects: WorldInteractionEffect[] = [];
  for (const value of rawEffects) {
    const effect = record(value);
    const kind = text(effect?.kind, 32);
    if (!effect) return invalid('每项 effect 必须是结构化对象');
    if (kind === 'knowledge') {
      const summary = text(effect.summary, 240);
      if (!summary) return invalid('knowledge.summary 需要本次亲历的具体观察');
      effects.push({ kind, summary });
      continue;
    }
    if (kind === 'world-state') {
      const summary = text(effect.summary, 240);
      const targetHandle = text(effect.targetHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      const stateKey = text(effect.stateKey, 64);
      const stateValue = text(effect.stateValue, 160);
      if (!summary || !target || !stateKey || !stateValue) return invalid('world-state 需要已点名 targetHandle、stateKey、stateValue 和 summary');
      effects.push({ kind, summary, target, stateKey, stateValue });
      continue;
    }
    if (kind === 'consume') {
      const targetHandle = text(effect.targetHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      const quantity = boundedInteger(effect.quantity, 1, 8);
      if (!target || quantity === undefined
        || !['inventory-stack', 'drop', 'voxel'].includes(target.kind)) return invalid('consume 只能消耗已点名的背包、地面物料或体素，quantity 为 1–8 整数');
      effects.push({ kind, target, quantity });
      continue;
    }
    if (kind === 'produce') {
      const material = materialByKey.get(text(effect.materialKey, 80));
      const quantity = boundedInteger(effect.quantity, 1, 8);
      const destination = effect.destination === 'inventory' || effect.destination === 'ground'
        ? effect.destination
        : undefined;
      if (!material || material.id === 0 || quantity === undefined || !destination) return invalid('produce 需要目录中 materialKey、1–8 的 quantity 和 inventory/ground 目的地；自命名复合造物请用 assemble');
      effects.push({ kind, materialId: material.id, quantity, destination });
      continue;
    }
    if (kind === 'relocate') {
      const targetHandle = text(effect.targetHandle, 24);
      const destinationHandle = text(effect.destinationHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      const destination = requestedHandles.has(destinationHandle)
        ? worldRefForHandle(protocol.handles, destinationHandle, actorId)
        : undefined;
      const quantity = boundedInteger(effect.quantity, 1, 8);
      if (!target || !['drop', 'inventory-stack'].includes(target.kind)
        || destination?.kind !== 'voxel' || quantity === undefined) return invalid('relocate 的 targetHandle 必须是已点名背包/地面物，destinationHandle 必须是已点名地表，quantity 为 1–8');
      effects.push({
        kind,
        target: target as Extract<WorldRef, { kind: 'drop' | 'inventory-stack' }>,
        destination,
        quantity,
      });
      continue;
    }
    if (kind === 'replace-voxel' || kind === 'move-self') {
      const targetHandle = text(effect.targetHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      if (!target) return invalid(`${kind}.targetHandle 必须是人物已点名的真实对象 ref`);
      if (kind === 'move-self') {
        const withinDistance = effect.withinDistance;
        if (withinDistance !== undefined && (typeof withinDistance !== 'number' || !Number.isFinite(withinDistance) || withinDistance < 0)) {
          return invalid('move-self.withinDistance 必须是非负实际距离');
        }
        effects.push({ kind, target, ...(withinDistance !== undefined ? { withinDistance: withinDistance as number } : {}) });
      }
      else {
        if (target.kind !== 'voxel') return invalid('replace-voxel.targetHandle 必须是已点名地表；靠近人物或物品用 move-self');
        const material = materialByKey.get(text(effect.materialKey, 80));
        if (!material || material.id === 0) return invalid('replace-voxel.materialKey 必须来自材料目录；新复合设施使用 assemble');
        effects.push({ kind, target, materialId: material.id });
      }
      continue;
    }
    if (kind === 'assemble' || kind === 'modify-structure') {
      const targetHandle = text(effect.targetHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      const arrangement = effect.arrangement === 'support' || effect.arrangement === 'pile' || effect.arrangement === 'lash' || effect.arrangement === 'form'
        ? effect.arrangement
        : undefined;
      const summary = text(effect.summary, 160);
      if (!target || (kind === 'assemble' ? target.kind !== 'voxel' : target.kind !== 'voxel' && target.kind !== 'work')) {
        return invalid(`${kind}.targetHandle 需要已点名的位置；修改已有造物优先使用其 w 引用`);
      }
      if (kind === 'assemble' && (!arrangement || !summary)) return invalid('assemble 需要 arrangement=support/pile/lash/form 和具体造物 summary');
      let layout: WorkLayout | undefined;
      if (effect.layout !== undefined) {
        if (!Array.isArray(effect.layout) || !effect.layout.length) return invalid(`${kind}.layout 需要非空完整体素布局`);
        const voxels = effect.layout.map((value) => {
          const voxel = record(value);
          const offset = record(voxel?.offset);
          const material = materialByKey.get(text(voxel?.materialKey, 80));
          return offset && ['x', 'y', 'z'].every((key) => Number.isSafeInteger(offset[key]))
            && material && material.id !== 0 && material.phase === 'solid'
            ? { offset: { x: offset.x as number, y: offset.y as number, z: offset.z as number }, materialId: material.id }
            : undefined;
        });
        if (!voxels.every((voxel): voxel is NonNullable<typeof voxel> => Boolean(voxel))) {
          return invalid(`${kind}.layout 每格需要整数 offset:{x,y,z} 与材料目录中的固体 materialKey`);
        }
        layout = { version: 'work-layout-v1', voxels };
      }
      effects.push({
        kind,
        target,
        ...(arrangement ? { arrangement } : {}),
        ...(summary ? { summary } : {}),
        ...(layout ? { layout } : {}),
      } as WorldInteractionEffect);
      continue;
    }
    if (kind === 'bond-animal') {
      const targetHandle = text(effect.targetHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      const summary = text(effect.summary, 160);
      if (!target || target.kind !== 'animal' || !summary) return invalid('bond-animal 需要已点名动物 targetHandle 和本次接触 summary');
      effects.push({ kind, target, summary });
      continue;
    }
    if (kind === 'body') {
      const targetHandle = text(effect.targetHandle, 24);
      const target = targetHandle === 'self'
        ? undefined
        : requestedHandles.has(targetHandle)
          ? worldRefForHandle(protocol.handles, targetHandle, actorId)
          : undefined;
      const field = effect.field === 'health' || effect.field === 'hydration' || effect.field === 'nutrition'
        ? effect.field
        : undefined;
      const delta = boundedInteger(effect.delta, -25, 25);
      if ((targetHandle !== 'self' && target?.kind !== 'person') || !field || delta === undefined) return invalid('body 只支持 self/已点名人物的 health/hydration/nutrition，delta 为 -25–25 整数');
      effects.push({ kind, ...(target?.kind === 'person' ? { target } : {}), field, delta });
      continue;
    }
    return invalid(`未知 effect.kind=${kind}；请用 schema 中的物理原语组合表达，造物使用 assemble/modify-structure`);
  }
  // A semantic resolver may describe a transformation, but it cannot summon
  // authoritative material.  Every produced lot must consume a named input in
  // the same local action; known recipe executors remain the richer path.
  if (effects.some((effect) => effect.kind === 'produce')
    && !effects.some((effect) => effect.kind === 'consume')) return invalid('produce 需要同次 consume 真实输入；若只是搬动原物，应使用 relocate');
  const adjudication: WorldAdjudicatedInteraction = {
    version: 'world-adjudicated-interaction-v1',
    request: worldAction.description,
    ...(worldAction.expectedResult ? { expectedResult: worldAction.expectedResult } : {}),
    targets: targets as WorldRef[],
    status,
    result,
    ...(feedbackCorrection && feedbackAdjustment ? {
      feedback: { correction: feedbackCorrection, adjustment: feedbackAdjustment },
    } : {}),
    effects,
  };
  return {
    probe: { kind: 'world-interaction', adjudication },
    feedback: result,
  };
}

function normalizeDecision(context: DecisionRequestContext, input: unknown): Decision | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const mentalAct = record(raw.mentalAct) as unknown as MentalAct | null;
  if (!mentalAct
    || mentalAct.version !== 'mental-act-v2'
    || !MENTAL_ACT_KINDS.has(mentalAct.kind)
    || !boundedUtterance(mentalAct.utterance)
    || (mentalAct.delivery !== 'whisper' && mentalAct.delivery !== 'normal' && mentalAct.delivery !== 'call')) return null;
  const reason = text(raw.reason) || mentalAct.strategy;
  const optionId = text(raw.optionId, 512);
  const followUpOptionId = text(raw.followUpOptionId, 512);
  const resumeIntentId = text(raw.resumeIntentId, 512);
  const abandonIntentId = text(raw.abandonIntentId, 512);
  const characterAgendaProposal = record(raw.characterAgendaProposal)
    ? raw.characterAgendaProposal as unknown as CharacterAgendaProposal
    : undefined;
  const characterAgendaUpdate = record(raw.characterAgendaUpdate)
    ? raw.characterAgendaUpdate as unknown as CharacterAgendaUpdate
    : undefined;
  const option = context.options.find((item) => item.id === optionId);
  const openConversation = option?.openConversationGrounding;
  const groundingSourceFactIds = Array.isArray(raw.groundingSourceFactIds)
    && raw.groundingSourceFactIds.length <= 3
    && raw.groundingSourceFactIds.every((sourceFactId) => typeof sourceFactId === 'string' && sourceFactId.length > 0)
    ? [...new Set(raw.groundingSourceFactIds as string[])]
    : undefined;
  if (openConversation && (!mentalAct.utterance || !groundingSourceFactIds)) return null;
  if (!openConversation && Object.prototype.hasOwnProperty.call(raw, 'groundingSourceFactIds')) return null;
  const validFollowUp = context.followUpOptions.some((item) => item.id === followUpOptionId);
  if (option?.requiresFollowUp && !validFollowUp) return null;
  if ((mentalAct.kind === 'continue' || mentalAct.kind === 'wait') && option) return null;
  const communication = option?.communicationKind !== undefined;
  if (mentalAct.kind === 'talk' && (!option || !communication)) return null;
  if (communication && mentalAct.kind !== 'talk') return null;
  const activeIntentId = context.activeIntent?.id;
  const intentDisposition = text(raw.intentDisposition, 24);
  if (abandonIntentId && intentDisposition !== 'abandon') return null;
  if (intentDisposition === 'pause' || intentDisposition === 'stay') {
    return activeIntentId ? {
      kind: 'suspend',
      intentId: activeIntentId,
      reason,
      mentalAct,
    } : {
      kind: 'idle',
      reason,
      mentalAct,
      ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    };
  }
  if (intentDisposition === 'abandon') {
    if (abandonIntentId) {
      const suspended = context.suspendedIntents.some((intent) => intent.id === abandonIntentId);
      if (!suspended || option) return null;
      return {
        kind: 'abandon',
        intentId: abandonIntentId,
        reason,
        mentalAct,
      };
    }
    return activeIntentId ? {
      kind: 'abandon',
      intentId: activeIntentId,
      reason,
      mentalAct,
    } : {
      kind: 'idle',
      reason,
      mentalAct,
      ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    };
  }
  const resumable = context.suspendedIntents.some((intent) => intent.id === resumeIntentId);
  if (resumeIntentId) {
    if (!resumable || option || intentDisposition !== 'act') return null;
    return {
      kind: 'resume',
      intentId: resumeIntentId,
      reason,
      mentalAct,
    };
  }
  if (!option) {
    if (mentalAct.kind === 'talk') return null;
    return {
      kind: 'idle',
      reason,
      mentalAct,
      ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    };
  }
  if (!activeIntentId) {
    return {
      kind: 'start',
      optionId,
      ...(followUpOptionId ? { followUpOptionId } : {}),
      reason,
      ...(openConversation ? { groundingSourceFactIds } : {}),
      ...(characterAgendaProposal ? { characterAgendaProposal } : {}),
      ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
      mentalAct,
    };
  }
  return {
    kind: 'revise',
    intentId: activeIntentId,
    optionId,
    ...(followUpOptionId ? { followUpOptionId } : {}),
    reason,
    ...(openConversation ? { groundingSourceFactIds } : {}),
    ...(characterAgendaProposal ? { characterAgendaProposal } : {}),
    ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    ...(communication && !followUpOptionId ? {
      mode: 'interrupt' as const,
      interruptionKind: option.semantics.obligation === 'required-response'
        ? 'required-response' as const
        : 'voluntary-conversation' as const,
    } : {}),
    mentalAct,
  };
}

export function normalizeDecisionModelOutput(
  context: DecisionRequestContext,
  input: unknown,
  protocol: Pick<DecisionModelRequestProtocol, 'requestContext' | 'handles' | 'characterAgendaProposal'>,
): Decision | null {
  return normalizeDecision(context, expandDecisionModelOutput(context, input, protocol));
}

/** Pure Mind → Plan → Execution adapter used by runtime and focused contract tests. */
export function normalizeMindPlanModelOutput(
  context: DecisionRequestContext,
  mindInput: unknown,
  planInput: unknown,
  protocol: DecisionModelRequestProtocol,
  worldResolution?: WorldAdjudicationResolution,
): Decision | null {
  const intention = sanitizeMindIntention(mindInput, protocol.handles);
  if (!intention) return null;
  const plan = sanitizeModelPlan(planInput, protocol, context);
  if (!plan) return null;
  if (plan.worldAction && !worldResolution?.probe) return null;
  const option = selectedOptionForPlan(context, plan);
  let executionPlan = plan;
  if (option && !speechIntentAllowsOption(intention.speechIntent, option)) {
    // The language wave already carries Mind's exact expression. An unrelated
    // social menu entry cannot silently turn it into an agreement or consent.
    // Keep an explicitly chosen bodily follow-up, without a second LLM call.
    const physicalContinuation = plan.continuationHandle?.startsWith('o')
      ? protocol.requestContext.continuations.find((step) => step.handle === plan.continuationHandle)
      : undefined;
    const continuationOption = physicalContinuation
      ? context.options[Number(physicalContinuation.handle.slice(1)) - 1] : undefined;
    executionPlan = {
      steps: plan.steps,
      ...(plan.completion ? { completion: plan.completion } : {}),
      ...(plan.feedback ? { feedback: plan.feedback } : {}),
      ...(continuationOption && !continuationOption.communicationKind && !continuationOption.communicationMeaning
        ? { disposition: 'act' as const, firstStepHandle: physicalContinuation!.handle }
        : { disposition: 'stay' as const, freeExpression: true }),
    };
  }
  const effectiveWorldResolution = worldResolution?.probe?.kind === 'world-interaction' && executionPlan.completion
    ? {
        ...worldResolution,
        probe: {
          ...worldResolution.probe,
          adjudication: {
            ...worldResolution.probe.adjudication,
            effects: worldResolution.probe.adjudication.effects.map((effect) => {
              if (effect.kind !== 'move-self') return effect;
              const sameTarget = (target: WorldRef): boolean => target.kind === effect.target.kind
                && JSON.stringify(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)))
                  === JSON.stringify(Object.entries(effect.target).sort(([a], [b]) => a.localeCompare(b)));
              const distances = [...executionPlan.completion!.step.conditions, ...executionPlan.completion!.goal.conditions]
                .flatMap((condition) => (condition.kind === 'near-target' || condition.kind === 'reached-target')
                  && sameTarget(condition.target) ? [condition.maxDistance] : []);
              return distances.length ? { ...effect, withinDistance: Math.min(effect.withinDistance ?? Infinity, ...distances) } : effect;
            }),
          },
        },
      }
    : worldResolution;
  const decision = normalizeDecisionModelOutput(
    context,
    stagedDecisionOutput(
      intention,
      executionPlan,
      protocol,
      context,
      effectiveWorldResolution?.feedback,
    ),
    protocol,
  );
  const executionProbe = executionPlan.worldAction
    ? effectiveWorldResolution?.probe
    : executionPlan.experiment
      ? sanitizedProbe(executionPlan.experiment, protocol.handles)
      : undefined;
  return executionProbe && decision?.kind === 'idle'
    ? { ...decision, executionProbe }
    : decision;
}

/** Continuation changes only the implementation of an already authored intention. */
export function normalizeContinuingPlanModelOutput(
  context: DecisionRequestContext,
  planInput: unknown,
  protocol: DecisionModelRequestProtocol,
  worldResolution?: WorldAdjudicationResolution,
): Decision | null {
  const frozen = context.continuingPlan?.mentalAct;
  if (!frozen) return null;
  const decision = normalizeMindPlanModelOutput(context, {
    ...frozen,
    relationshipAppraisal: undefined,
    evidenceMemoryHandles: [],
  }, planInput, protocol, worldResolution);
  if (!decision?.mentalAct) return decision;
  if (decision.mentalAct.kind === 'talk') return null;
  if (decision.kind === 'resume' && !context.suspendedIntents.some((intent) => (
    intent.id === decision.intentId && intent.requiresNewSpeech === false
      && intent.planSourceDecisionEventId === context.continuingPlan?.sourceDecisionEventId
  ))) return null;
  return {
    ...decision,
    mentalAct: {
      ...decision.mentalAct,
      utterance: frozen.utterance,
      delivery: frozen.delivery,
      goal: frozen.goal,
      assumptions: [...frozen.assumptions],
      sourceEventIds: [...frozen.sourceEventIds],
    },
  };
}

interface DecisionResult {
  decision: Decision | null;
  usage: TokenUsage;
  providerRequests: number;
  /** Infrastructure diagnosis, never a character belief or chosen inactivity. */
  failure?: string;
}

interface MindResult {
  intention?: MindIntentionOutput;
  usage: TokenUsage;
  providerRequests: number;
  failure?: string;
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...((left.cacheHitInputTokens !== undefined || right.cacheHitInputTokens !== undefined)
      ? { cacheHitInputTokens: (left.cacheHitInputTokens ?? 0) + (right.cacheHitInputTokens ?? 0) }
      : {}),
    ...((left.cacheMissInputTokens !== undefined || right.cacheMissInputTokens !== undefined)
      ? { cacheMissInputTokens: (left.cacheMissInputTokens ?? 0) + (right.cacheMissInputTokens ?? 0) }
      : {}),
  };
}

async function decideMind(
  protocol: DecisionModelRequestProtocol,
  endpoint: ResolvedModelEndpoint,
): Promise<MindResult> {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  let intention: MindIntentionOutput | undefined;
  let mindCorrection: { invalidContent: string; problem: string } | undefined;
  let conciseRetry = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let completion: Awaited<ReturnType<typeof requestMindIntention>>;
    try {
      providerRequests += 1;
      completion = await requestMindIntention(endpoint, protocol, mindCorrection, conciseRetry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isReasoningOnlyOpenAiChatResponse(error, endpoint)
        || message.includes('finish_reason=length')
        || message.toLowerCase().includes('timeout')
        || message.toLowerCase().includes('aborted');
      if (!conciseRetry && retryable) {
        conciseRetry = true;
        continue;
      }
      return { usage, providerRequests, failure: message };
    }
    usage = addUsage(usage, completion.usage);
    let parsed: unknown;
    try {
      parsed = parseJson(completion.content);
    } catch {
      mindCorrection = { invalidContent: completion.content, problem: '不是 JSON 对象' };
      continue;
    }
    let problem = '';
    intention = sanitizeMindIntention(parsed, protocol.handles, (detail) => { problem = detail; });
    if (intention) break;
    mindCorrection = { invalidContent: completion.content, problem };
  }
  return {
    intention, usage, providerRequests,
    ...(!intention && mindCorrection ? { failure: mindCorrection.problem } : {}),
  };
}

async function decideOne(
  inputContext: DecisionRequestContext,
  endpoint: ResolvedModelEndpoint,
  continuationOnly = false,
): Promise<DecisionResult> {
  const context = continuationOnly ? {
    ...inputContext,
    options: inputContext.options.filter((option) => !option.communicationKind && !option.communicationMeaning),
    suspendedIntents: inputContext.suspendedIntents.filter((intent) => intent.requiresNewSpeech === false
      && intent.planSourceDecisionEventId === inputContext.continuingPlan?.sourceDecisionEventId),
  } : inputContext;
  const protocol = buildDecisionModelRequestProtocol(context,
    continuationOnly ? { characterAgendaProposal: false } : {});
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  try {
  const frozen = context.continuingPlan?.mentalAct;
  const mind: MindResult = continuationOnly
    ? {
        intention: frozen ? sanitizeMindIntention({
          ...frozen, relationshipAppraisal: undefined, evidenceMemoryHandles: [],
        }, protocol.handles) : undefined,
        usage: { inputTokens: 0, outputTokens: 0 },
        providerRequests: 0,
        ...(!frozen ? { failure: 'Plan 续编缺少已形成的原始人物意图' } : {}),
      }
    : await decideMind(protocol, endpoint);
  usage = mind.usage;
  providerRequests = mind.providerRequests;
  if (!mind.intention) return { decision: null, usage, providerRequests, failure: mind.failure ?? 'Mind 未返回可解析的本人意图' };
  let correction: { invalidContent: string; problem: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    providerRequests += 1;
    const completion = await requestModelPlan(endpoint, protocol, mind.intention, correction);
    usage = addUsage(usage, completion.usage);
    let parsed: unknown;
    try {
      parsed = parseJson(completion.content);
    } catch {
      correction = { invalidContent: completion.content, problem: '不是 JSON 对象' };
      continue;
    }
    const plan = sanitizeModelPlan(parsed, protocol, context);
    if (!plan) {
      correction = { invalidContent: completion.content, problem: '缺少合法的简短计划或行动引用' };
      continue;
    }
    const world = await resolveWorldAction(endpoint, protocol, plan.worldAction);
    usage = addUsage(usage, world.usage);
    providerRequests += world.providerRequests;
    if (plan.worldAction && !world.resolution) {
      correction = { invalidContent: completion.content, problem: `世界尚未将动作编译为可执行效果：${world.failure ?? '未返回实际变化'}；请拆出可实际完成的第一步并保留原目标` };
      continue;
    }
    const decision = continuationOnly
      ? normalizeContinuingPlanModelOutput(context, plan, protocol, world.resolution)
      : normalizeMindPlanModelOutput(context, mind.intention, plan, protocol, world.resolution);
    if (decision) {
      return {
        decision,
        usage,
        providerRequests,
      };
    }
    correction = { invalidContent: completion.content, problem: '所选行动不能由当前世界执行' };
  }
  return {
    decision: null,
    usage,
    providerRequests,
    failure: correction?.problem ?? 'Plan 尚未编译成可执行动作',
  };
  } catch (error) {
    return {
      decision: null, usage, providerRequests,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Every person gets the same complete translation/repair path, even in a batch. */
async function decideBatch(
  contexts: DecisionRequestContext[],
  endpoint: ResolvedModelEndpoint,
  continuationOnly = false,
): Promise<DecisionResult[]> {
  const results = new Array<DecisionResult>(contexts.length);
  let next = 0;
  // This bounds provider concurrency, not who is allowed to think or act.
  await Promise.all(Array.from({ length: Math.min(3, contexts.length) }, async () => {
    while (next < contexts.length) {
      const index = next++;
      results[index] = await decideOne(contexts[index], endpoint, continuationOnly);
    }
  }));
  return results;
}

function isContext(value: unknown): value is DecisionRequestContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as DecisionRequestContext;
  return Boolean(context.person?.id
    && Array.isArray(context.options)
    && context.options.every((option) => {
      if (!option || typeof option !== 'object' || typeof option.id !== 'string') return false;
      try {
        validateActionOptionSemantics(option.semantics);
        return true;
      } catch {
        return false;
      }
    })
    && Array.isArray(context.followUpOptions)
    && Array.isArray(context.visibleDrops));
}

async function handleDecisions(
  payload: unknown,
  requestedEndpoint?: string,
  continuationOnly = false,
): Promise<{ status: number; body: unknown }> {
  let endpoint: ResolvedModelEndpoint;
  try {
    endpoint = resolveModelEndpoint('decision', requestedEndpoint);
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  if (endpoint.auth !== 'none' && !endpoint.apiKey) {
    return { status: 500, body: { error: `模型端点 ${endpoint.id} 缺少 ${endpoint.apiKeyEnv ?? 'API Key'}` } };
  }
  const input = payload as { contexts?: unknown[] };
  const contexts = Array.isArray(input?.contexts) ? input.contexts.filter(isContext).slice(0, MAX_AGENTS) : [];
  if (!contexts.length) return { status: 400, body: { error: '缺少合法的月度决策上下文' } };
  const results = contexts.length === 1
    ? [await decideOne(contexts[0], endpoint, continuationOnly)]
    : await decideBatch(contexts, endpoint, continuationOnly);
  const usage = results.reduce<TokenUsage>((sum, item) => ({
    inputTokens: sum.inputTokens + item.usage.inputTokens,
    outputTokens: sum.outputTokens + item.usage.outputTokens,
    ...((sum.cacheHitInputTokens !== undefined || item.usage.cacheHitInputTokens !== undefined)
      ? { cacheHitInputTokens: (sum.cacheHitInputTokens ?? 0) + (item.usage.cacheHitInputTokens ?? 0) }
      : {}),
    ...((sum.cacheMissInputTokens !== undefined || item.usage.cacheMissInputTokens !== undefined)
      ? { cacheMissInputTokens: (sum.cacheMissInputTokens ?? 0) + (item.usage.cacheMissInputTokens ?? 0) }
      : {}),
  }), { inputTokens: 0, outputTokens: 0 });
  const providerRequests = results.reduce((sum, item) => sum + item.providerRequests, 0);
  const decisions = results.map((item) => item.decision);
  return {
    status: 200,
    body: {
      provider: endpoint.id,
      endpointId: endpoint.id,
      protocol: endpoint.protocol,
      model: endpoint.model,
      decided: decisions.filter(Boolean).length,
      total: decisions.length,
      decisions,
      failures: results.flatMap((result, index) => result.failure
        ? [{ personId: contexts[index].person.id, reason: result.failure }]
        : []),
      usage,
      providerRequests,
    },
  };
}

export async function handleDecide(payload: unknown, requestedEndpoint?: string): Promise<{ status: number; body: unknown }> {
  return handleDecisions(payload, requestedEndpoint);
}

export async function handleContinuePlans(payload: unknown, requestedEndpoint?: string): Promise<{ status: number; body: unknown }> {
  return handleDecisions(payload, requestedEndpoint, true);
}
