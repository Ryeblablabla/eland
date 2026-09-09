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
  describeModelPlanCompletion,
  sanitizeBoundPlanCompletion,
  compileMindSpeechIntent,
  describeMindSpeechIntent,
  compileModelNativeOperation,
  buildWorldPlanRequestContext,
  buildWorldAttemptRequestContext,
  deriveWorldTargets,
  type WorldTargetDerivationContext,
  type WorldTargetDerivation,
} from '../src/game/eland/infrastructure-api';
import { validateActionOptionSemantics } from '../src/game/eland/domain/action-option-semantics';
import { MATERIAL_PALETTE } from '../src/game/eland/domain/material';
import type {
  WorldAdjudicatedInteraction,
  WorldInteractionEffect,
  WorldRef,
} from '../src/game/eland/domain/action';
import type { NativeOperationRequest } from '../src/game/eland/domain/native-operation';
import { nativeActWireDefinition } from '../src/game/eland/application/model-decision/native-act-wire';
import type { PlanCompletionCheck } from '../src/game/eland/domain/mental-act';
import type { WorkLayout } from '../src/game/eland/domain/work-layout';
import type {
  CharacterAgendaProbe,
  CharacterAgendaProposal,
  CharacterAgendaUpdate,
} from '../src/game/eland/domain/character-agenda';
import type { Decision, MentalAct, MentalActKind, TokenUsage } from '../src/game/eland/simulation';
import { loadServerEnvValue } from './env';
import { ModelRequestError, requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ModelThinking, type ResolvedModelEndpoint } from './model-config';
import {
  buildMindIntentionJsonSchema,
  buildWorldPlanJsonSchema,
  buildWorldAttemptJsonSchema,
  buildWorldSpeechJsonSchema,
  type WorldPlanAttemptConstraint,
} from './model-decision-json-schema';
import {
  WORLD_PLAN_SYSTEM_PROMPT_V1,
  WORLD_ATTEMPT_SYSTEM_PROMPT_V1,
  WORLD_SPEECH_SYSTEM_PROMPT_V1,
  CHARACTER_AGENDA_EXTENSION_V2,
  DECISION_SYSTEM_PROMPT_V2,
  MIND_INTENTION_SYSTEM_PROMPT_V5,
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
  const configured = Number(loadServerEnvValue('MODEL_DECISION_TIMEOUT_MS') || endpoint.timeoutMs);
  const timeoutMs = Number.isFinite(configured) ? configured : endpoint.timeoutMs;
  return Math.max(1_000, Math.min(300_000, timeoutMs));
}

function decisionMaxOutputTokens(endpoint: ResolvedModelEndpoint): number {
  const thinking = endpoint.thinking === true || typeof endpoint.thinking === 'string';
  const fallback = endpoint.protocol === 'ollama-chat' && thinking ? 6_000 : 1_200;
  const configured = Number(loadServerEnvValue('MODEL_DECISION_MAX_OUTPUT_TOKENS') || fallback);
  return Number.isFinite(configured) ? Math.max(128, Math.min(16_384, Math.floor(configured))) : fallback;
}

/** Request-local settings only: routing, model identity and saved endpoint
 * configuration remain unchanged. Missing overrides inherit the endpoint. */
function decisionPhaseEndpoint(endpoint: ResolvedModelEndpoint, phase: 'mind' | 'world'): ResolvedModelEndpoint {
  const variable = phase === 'mind' ? 'MODEL_MIND_THINKING' : 'MODEL_WORLD_THINKING';
  const raw = loadServerEnvValue(variable).trim().toLowerCase();
  if (!raw) return endpoint;
  const thinking: ModelThinking | undefined = raw === 'true' ? true : raw === 'false' ? false
    : raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max' ? raw : undefined;
  if (thinking === undefined) throw new Error(`${variable}需要true、false、low、medium、high或max；未设置时继承端点配置`);
  return { ...endpoint, thinking };
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
  /** Public projection used to derive positions and already-visible parts. */
  targetContext?: WorldTargetDerivationContext;
  /** Server-owned restriction while the actor's initial attempt is still pending. */
  actorAttempt?: WorldPlanAttemptConstraint;
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
    targetContext: context,
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
  disposition: 'act' | 'continue' | 'pause' | 'abandon' | 'stay';
  currentStep?: ModelWorldAction;
  resumeIntentHandle?: string;
  abandonIntentHandle?: string;
  feedback?: ModelPlanFeedback;
}

interface ModelWorldAction {
  kind?: 'speech' | 'physical';
  description: string;
  targetHandles: string[];
  expectedResult?: string;
  methodHandle?: string;
  projectHandle?: string;
}

interface ModelPlanFeedback {
  correction: string;
  adjustment: string;
  sourceMemoryHandles: string[];
  sourceEventIds: string[];
}

interface WorldAdjudicationResolution {
  nativeOperation?: NativeOperationRequest;
  probe?: CharacterAgendaProbe;
  feedback: string;
  completionReview?: Partial<Record<'step' | 'goal', NonNullable<PlanCompletionCheck['meaningReview']>>>;
  targetDerivations?: WorldTargetDerivation['derived'];
}

const RELATIONSHIP_APPRAISAL_MEANINGS = new Set([
  'gratitude', 'care', 'affection', 'attraction', 'respect', 'solidarity', 'obligation',
  'hurt', 'anger', 'fear', 'suspicion', 'jealousy', 'rivalry', 'grief', 'ambivalence', 'uncertainty',
] as const);


function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

type MindDeclarationOutput = Pick<MindIntentionOutput,
  'utterance' | 'delivery' | 'speechIntent' | 'evidenceMemoryHandles' | 'relationshipAppraisal'>;

function sanitizeMindDeclaration(
  input: unknown,
  handles: DecisionProbeHandleMap,
  onInvalid?: (problem: string) => void,
): MindDeclarationOutput | undefined {
  const raw = record(input);
  if (!raw) { onInvalid?.('本人声明必须包含 utterance、delivery、speechIntent'); return undefined; }
  const utterance = boundedUtterance(raw.utterance);
  const delivery = raw.delivery === 'whisper' || raw.delivery === 'normal' || raw.delivery === 'call' ? raw.delivery : undefined;
  if (!utterance || !delivery) {
    onInvalid?.(!utterance ? 'utterance 需要 1–180 字的完整新原话' : 'delivery 必须是 whisper、normal 或 call');
    return undefined;
  }
  const evidenceMemoryHandles = Array.isArray(raw.evidenceMemoryHandles)
    ? [...new Set(raw.evidenceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))]
      .filter((handle) => handles.memories.some((memory) => memory.handle === handle)).slice(0, 4) : [];
  const relationshipAppraisal = sanitizeMindRelationshipAppraisal(raw.relationshipAppraisal, handles);
  const rawSpeech = record(raw.speechIntent);
  const speechIntent = compileMindSpeechIntent(rawSpeech, handles,
    Boolean(rawSpeech?.referenceId || Array.isArray(rawSpeech?.counterpartIds)), handles.actorId, utterance);
  return { utterance, delivery, speechIntent, evidenceMemoryHandles,
    ...(relationshipAppraisal ? { relationshipAppraisal } : {}) };
}

/** Keeping the arrangement can be silent or include new words, never a new goal. */
export function normalizeRetainedDeclarationModelOutput(
  input: unknown,
  protocol: Pick<DecisionModelRequestProtocol, 'handles'>,
  onInvalid?: (problem: string) => void,
): Decision | null {
  const raw = record(input);
  if (raw?.attention !== 'keep-current') return null;
  if (Object.keys(raw).some((key) => !['attention', 'declaration'].includes(key))) {
    onInvalid?.('keep-current 仅包含 attention 和可选 declaration；新目标使用独立的新意图分支'); return null;
  }
  const reason = '继续原有安排';
  if (raw.declaration === undefined) return { kind: 'idle', attention: 'keep-current', reason };
  const proposed = record(raw.declaration);
  if (!proposed || Object.keys(proposed).some((key) => ![
    'utterance', 'delivery', 'speechIntent', 'evidenceMemoryHandles', 'relationshipAppraisal',
  ].includes(key))) { onInvalid?.('declaration 仅表达本次新话、本人语义和真实依据，不填写目标或计划'); return null; }
  const declaration = sanitizeMindDeclaration(proposed, protocol.handles, onInvalid);
  if (!declaration) return null;
  const { evidenceMemoryHandles, ...language } = declaration;
  return { kind: 'idle', attention: 'keep-current', reason, declaration: {
    ...language, sourceEventIds: [...new Set(evidenceMemoryHandles.flatMap((handle) =>
      protocol.handles.memories.find((memory) => memory.handle === handle)?.sourceFactIds ?? []))],
  } };
}

function sanitizeMindIntention(
  input: unknown,
  handles: DecisionProbeHandleMap,
  onInvalid?: (problem: string) => void,
): MindIntentionOutput | undefined {
  const raw = record(input);
  if (!raw || raw.attention !== undefined) {
    onInvalid?.('新意图需要goal、orientation、horizon；declaration独立可选，保留安排使用keep-current分支');
    return undefined;
  }
  // A purpose can change without a new language wave. Explicit declarations
  // are validated separately and still require their actual nonempty words.
  const declaration: MindDeclarationOutput | undefined = raw.utterance === undefined || raw.utterance === ''
    ? { utterance: '', delivery: 'normal', speechIntent: { kind: 'expression' }, evidenceMemoryHandles: [] }
    : sanitizeMindDeclaration(raw, handles, onInvalid);
  if (!declaration) return undefined;
  const goal = text(raw.goal, 240);
  const orientation = raw.orientation === 'social' || raw.orientation === 'inquiry' || raw.orientation === 'survival'
    || raw.orientation === 'construction' || raw.orientation === 'acquisition' || raw.orientation === 'exploration'
    || raw.orientation === 'rest' ? raw.orientation : undefined;
  const horizon = raw.horizon === 'momentary' || raw.horizon === 'ongoing' ? raw.horizon : undefined;
  if (!goal || !orientation || !horizon) {
    onInvalid?.([
      ...(!goal ? ['goal 缺少人物此刻的具体意图'] : []),
      ...(!orientation ? ['orientation 必须是 social、inquiry、survival、construction、acquisition、exploration 或 rest'] : []),
      ...(!horizon ? ['horizon 必须是 momentary 或 ongoing'] : []),
    ].join('；'));
    return undefined;
  }
  const nextAttempt = text(raw.nextAttempt, 480);
  const attempt = sanitizeBoundAttempt(raw.attempt);
  if (raw.attempt !== undefined && !attempt) { onInvalid?.('已绑定的本人尝试需要真实对象与合法模式'); return undefined; }
  return { ...declaration, goal, orientation, horizon, ...(nextAttempt ? { nextAttempt } : {}), ...(attempt ? { attempt } : {}) };
}

function sanitizeBoundAttempt(input: unknown): MentalAct['attempt'] {
  const value = record(input);
  if (!value || !['observe', 'act', 'wait'].includes(String(value.mode)) || !Array.isArray(value.targets)) return undefined;
  const targets = value.targets.map((input): WorldRef | undefined => {
    const target = record(input);
    if (!target) return undefined;
    if (target.kind === 'voxel') {
      const position = record(target.position);
      return position && ['x', 'y', 'z'].every((key) => Number.isSafeInteger(position[key]))
        ? { kind: 'voxel', position: { x: Number(position.x), y: Number(position.y), z: Number(position.z) } } : undefined;
    }
    if (target.kind === 'inventory-stack' && text(target.personId, 240) && text(target.stackId, 240)) {
      return { kind: 'inventory-stack', personId: String(target.personId), stackId: String(target.stackId) };
    }
    const idField = ({ person: 'personId', drop: 'dropId', animal: 'animalId', work: 'workId', container: 'containerId', remains: 'remainsId' } as Record<string, string>)[String(target.kind)];
    return idField && text(target[idField], 240)
      ? { kind: target.kind, [idField]: target[idField] } as WorldRef : undefined;
  });
  if (targets.some((target) => !target)) return undefined;
  return { mode: value.mode as NonNullable<MentalAct['attempt']>['mode'], targets: targets as WorldRef[] };
}

interface MindDeltaChoice {
  decision?: Decision;
  intention?: MindIntentionOutput;
  speech?: { description: string; intention?: MindIntentionOutput;
    frozenWords?: Pick<MindDeclarationOutput, 'utterance' | 'delivery'> };
  /** A new attempt can continue a real purpose without declaring that purpose anew. */
  retainedGoal?: { sourceDecisionEventId?: string; declaration?: NonNullable<Decision['declaration']> };
}

function speechChoiceDecision(
  choice: NonNullable<MindDeltaChoice['speech']>,
  protocol: DecisionModelRequestProtocol,
  declaration?: NonNullable<Decision['declaration']>,
  failure?: string,
): Decision {
  const mentalAct = choice.intention ? { ...mindMentalAct(choice.intention, protocol),
    ...(declaration ?? {}),
  } : undefined;
  const characterAgendaUpdate = mentalAct && choice.intention?.horizon === 'ongoing' && protocol.characterAgendaProposal
    ? concernUpdateForMentalAct({ kind: 'create' }, undefined, choice.intention.evidenceMemoryHandles, mentalAct, protocol.handles)
    : undefined;
  return { kind: 'idle', reason: choice.description,
    ...(mentalAct ? { mentalAct } : { attention: 'keep-current' as const, ...(declaration ? { declaration } : {}) }),
    ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    ...(failure ? { compilationFailure: { code: 'invalid-operation' as const, message: failure, fields: ['world-speech'] } } : {}),
  };
}

function mindMentalAct(intention: MindIntentionOutput, protocol: DecisionModelRequestProtocol,
  kind: 'pursue' | 'wait' = 'pursue'): MentalAct {
  return {
    version: 'mental-act-v2', kind,
    utterance: intention.utterance, delivery: intention.delivery, speechIntent: intention.speechIntent,
    goal: intention.goal, orientation: intention.orientation, horizon: intention.horizon,
    ...(intention.nextAttempt ? { nextAttempt: intention.nextAttempt } : {}),
    strategy: intention.nextAttempt ?? intention.goal, assumptions: [],
    sourceEventIds: [...new Set(intention.evidenceMemoryHandles.flatMap((handle) =>
      protocol.handles.memories.find((memory) => memory.handle === handle)?.sourceFactIds ?? []))],
    ...(intention.relationshipAppraisal ? { relationshipAppraisal: structuredClone(intention.relationshipAppraisal) } : {}),
  };
}

/** Mind chooses its purpose, activity and optional words. Physical and social
 * protocol binding belongs to the world compilers, not this choice format. */
function sanitizeMindDelta(
  input: unknown,
  context: DecisionRequestContext,
  protocol: DecisionModelRequestProtocol,
  onInvalid: (problem: string) => void,
): MindDeltaChoice | undefined {
  const raw = record(input);
  if (!raw || Object.keys(raw).some((key) => ![
    'intentionChange', 'declaration', 'attempt', 'evidenceMemoryHandles', 'relationshipAppraisal',
  ].includes(key))) {
    onInvalid('Mind只选择目标、当前安排、可选原话和本人依据/关系理解，不填写操作或社会协议API');
    return undefined;
  }
  const attempt = record(raw.attempt);
  if (!attempt || !['creative', 'speak', 'continue', 'wait'].includes(String(attempt.kind))
    || Object.keys(attempt).some((key) => !['kind', ...(attempt.kind === 'creative' || attempt.kind === 'speak' ? ['description'] : [])].includes(key))) {
    onInvalid('attempt必须选择creative、speak、continue或wait；具体尝试/说话需description'); return undefined;
  }
  const description = attempt.kind === 'creative' || attempt.kind === 'speak' ? text(attempt.description, 480) : undefined;
  if ((attempt.kind === 'creative' || attempt.kind === 'speak') && !description) {
    onInvalid('creative或speak需要本人已选的具体活动或说话意思description'); return undefined;
  }
  const evidenceMemoryHandles = Array.isArray(raw.evidenceMemoryHandles)
    ? [...new Set(raw.evidenceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))]
      .filter((handle) => protocol.handles.memories.some((memory) => memory.handle === handle)).slice(0, 4) : [];
  const relationshipAppraisal = sanitizeMindRelationshipAppraisal(raw.relationshipAppraisal, protocol.handles);
  if (raw.relationshipAppraisal !== undefined && !relationshipAppraisal) {
    onInvalid('本人关系理解需要可辨认的对方与实际相关记忆，不能由世界补写'); return undefined;
  }
  const reflection = { evidenceMemoryHandles, ...(relationshipAppraisal ? { relationshipAppraisal } : {}) };
  const privateDeclaration: NonNullable<Decision['declaration']> | undefined = evidenceMemoryHandles.length || relationshipAppraisal ? {
    utterance: '', delivery: 'normal',
    sourceEventIds: [...new Set(evidenceMemoryHandles.flatMap((handle) =>
      protocol.handles.memories.find((memory) => memory.handle === handle)?.sourceFactIds ?? []))],
    ...(relationshipAppraisal ? { relationshipAppraisal } : {}),
  } : undefined;
  let frozenWords: NonNullable<MindDeltaChoice['speech']>['frozenWords'];
  if (raw.declaration !== undefined) {
    const words = record(raw.declaration);
    if (!words || Object.keys(words).some((key) => !['utterance', 'delivery'].includes(key))
      || typeof words.utterance !== 'string' || !words.utterance.trim() || words.utterance.length > 180
      || !['whisper', 'normal', 'call'].includes(String(words.delivery))) {
      onInvalid('declaration只包含完整utterance与delivery；语义和协议引用由世界编译'); return undefined;
    }
    frozenWords = { utterance: words.utterance, delivery: words.delivery as MindDeclarationOutput['delivery'] };
  }
  let intention: MindIntentionOutput | undefined;
  if (raw.intentionChange !== undefined) {
    const change = record(raw.intentionChange);
    if (!change || Object.keys(change).some((key) => !['goal', 'orientation', 'horizon'].includes(key))) {
      onInvalid('intentionChange只写goal、orientation、horizon，不包含言语或操作参数'); return undefined;
    }
    const chosen = sanitizeMindIntention({ ...change, ...(description ? { nextAttempt: description } : {}) }, protocol.handles, onInvalid);
    if (!chosen) return undefined;
    intention = { ...chosen, ...reflection };
  }
  const speech: MindDeltaChoice['speech'] = frozenWords || attempt.kind === 'speak' ? {
    description: attempt.kind === 'speak' ? description! : frozenWords!.utterance,
    ...(frozenWords ? { frozenWords } : {}), ...(intention ? { intention } : {}),
  } : undefined;
  const speechChoice = speech ? { speech } : {};
  const origin = intention ? undefined : context.currentIntention;
  if (attempt.kind === 'creative') {
    const frozen = origin?.mentalAct;
    return { intention: intention ?? {
      utterance: '', delivery: 'normal', speechIntent: { kind: 'expression' },
      goal: frozen?.goal ?? description!, nextAttempt: description!,
      orientation: frozen?.orientation ?? 'inquiry', horizon: frozen?.horizon ?? 'momentary',
      ...reflection,
    }, ...(!intention ? { retainedGoal: {
      ...(origin ? { sourceDecisionEventId: origin.sourceDecisionEventId } : {}),
      ...(privateDeclaration ? { declaration: privateDeclaration } : {}),
    } } : {}), ...speechChoice };
  }
  const mentalAct = intention ? mindMentalAct(intention, protocol, attempt.kind === 'wait' ? 'wait' : 'pursue') : undefined;
  const characterAgendaUpdate = mentalAct && intention?.horizon === 'ongoing' && protocol.characterAgendaProposal
    ? concernUpdateForMentalAct({ kind: 'create' }, undefined, intention.evidenceMemoryHandles, mentalAct, protocol.handles)
    : undefined;
  const fields = {
    ...(mentalAct ? { mentalAct } : privateDeclaration ? { declaration: privateDeclaration } : {}),
    ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
  };
  if (attempt.kind === 'speak') return { decision: {
    kind: 'idle', attention: 'keep-current', reason: description!, ...fields,
  }, ...speechChoice };
  if (attempt.kind === 'continue') return { decision: {
    kind: 'idle', attention: 'keep-current', reason: '本人选择保持当前身体工作或空闲', ...fields,
  }, ...speechChoice };
  const authoredAttempt: NonNullable<Decision['authoredAttempt']> = {
    kind: 'wait', ...(origin ? { intentionSourceDecisionEventId: origin.sourceDecisionEventId } : {}),
  };
  return { decision: context.activeIntent
    ? { kind: 'suspend', intentId: context.activeIntent.id, reason: '本人选择暂时停下', authoredAttempt, ...fields }
    : { kind: 'idle', reason: '本人选择等待', authoredAttempt, ...fields }, ...speechChoice };
}

/** Public seam for the real actor delta contract; creative choices are translated by decideOne. */
export function normalizeMindDeltaModelOutput(context: DecisionRequestContext, input: unknown,
  protocol: DecisionModelRequestProtocol): Decision | null {
  return sanitizeMindDelta(input, context, protocol, () => {})?.decision ?? null;
}

function preserveAttemptAuthorship(decision: Decision, retainedGoal: MindDeltaChoice['retainedGoal']): Decision {
  if (!retainedGoal) return { ...decision, authoredAttempt: { kind: 'creative' } };
  const { mentalAct, ...withoutNewMind } = decision;
  // This world translation is another step under the original personal goal,
  // not another declaration of that goal and not a replay of its old words.
  if ('characterAgendaUpdate' in withoutNewMind) delete withoutNewMind.characterAgendaUpdate;
  return { ...withoutNewMind,
    authoredAttempt: { kind: 'creative',
      ...(retainedGoal.sourceDecisionEventId ? { intentionSourceDecisionEventId: retainedGoal.sourceDecisionEventId } : {}),
      ...(mentalAct?.plan ? { plan: structuredClone(mentalAct.plan) } : {}),
    },
    ...(retainedGoal.declaration ? { declaration: structuredClone(retainedGoal.declaration) } : {}),
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
  if (visible.kind === 'remains') return { kind: 'remains', remainsId: visible.remainsId };
  if (visible.kind === 'work') return { kind: 'work', workId: visible.workId };
  if (visible.kind === 'inventory-stack') return { kind: 'inventory-stack', personId: visible.personId, stackId: visible.stackId };
  return { kind: 'container', containerId: visible.containerId };
}

function describeActorAttempt(protocol: DecisionModelRequestProtocol, intention: Pick<MindIntentionOutput, 'attempt'>): WorldPlanAttemptConstraint | undefined {
  if (!intention.attempt) return undefined;
  const key = (target: WorldRef) => JSON.stringify(target,
    ['kind', 'personId', 'stackId', 'dropId', 'animalId', 'workId', 'containerId', 'remainsId', 'position', 'x', 'y', 'z']);
  const handlesByIdentity = new Map(exposedWorldTargets(protocol).flatMap(({ ref }) => {
    const target = worldRefForHandle(protocol.handles, ref, protocol.handles.actorId);
    return target ? [[key(target), ref] as const] : [];
  }));
  const mapped = intention.attempt.targets.map((target) => handlesByIdentity.get(key(target)));
  return { mode: intention.attempt.mode, hasExplicitFocus: intention.attempt.targets.length > 0,
    targetHandles: [...new Set(mapped.filter((handle): handle is string => Boolean(handle)))],
    unavailableTargetCount: mapped.filter((handle) => !handle).length };
}

function activeActorAttempt(protocol: DecisionModelRequestProtocol, intention: Pick<MindIntentionOutput, 'attempt'>): WorldPlanAttemptConstraint | undefined {
  return record(protocol.requestContext.current.planContinuation)?.initialAttemptPerformed === true
    ? undefined : describeActorAttempt(protocol, intention);
}

function sanitizeWorldAction(input: unknown, protocol: DecisionModelRequestProtocol): ModelWorldAction | undefined {
  const raw = record(input);
  const description = text(raw?.description, 240);
  const kind = raw?.kind;
  const expectedResult = text(raw?.expectedResult, 180);
  const methodHandle = text(raw?.methodHandle, 32);
  const projectHandle = text(raw?.projectHandle, 32);
  if (!raw || !description || !Array.isArray(raw.targetHandles)) return undefined;
  if (kind !== undefined && kind !== 'speech' && kind !== 'physical') return undefined;
  const requestedTargets = raw.targetHandles.map((value) => text(value, 24));
  if (requestedTargets.some((handle) => !handle)) return undefined;
  // A step names a set of objects, not material quantities. Repeating one
  // valid reference cannot erase the choice; native act inputs keep their
  // separate multiplicity (e.g. two portions from the same material stack).
  const targetHandles = [...new Set(requestedTargets)];
  const exposed = new Set(exposedWorldTargets(protocol).map((item) => text(item.ref, 24)));
  if (targetHandles.some((handle) => !exposed.has(handle) || !worldRefForHandle(protocol.handles, handle))) return undefined;
  const attempt = protocol.actorAttempt;
  if (attempt?.mode === 'wait' || attempt?.hasExplicitFocus && !attempt.targetHandles.length) return undefined;
  if (attempt?.hasExplicitFocus) {
    const allowed = new Set(deriveWorldTargets(protocol.targetContext ?? protocol.requestContext, protocol.handles, attempt.targetHandles).allowedHandles);
    if (targetHandles.some((handle) => !allowed.has(handle))) return undefined;
  }
  if (projectHandle && !protocol.handles.nativeReferences?.some((item) => item.kind === 'project' && item.handle === projectHandle)) return undefined;
  return {
    ...(kind === 'speech' || kind === 'physical' ? { kind } : {}),
    description,
    targetHandles,
    ...(expectedResult ? { expectedResult } : {}),
    ...(methodHandle && protocol.requestContext.knownMethods?.some((method) => method.handle === methodHandle) ? { methodHandle } : {}),
    ...(projectHandle ? { projectHandle } : {}),
  };
}

function sanitizePlanFeedback(input: unknown, protocol: DecisionModelRequestProtocol): ModelPlanFeedback | undefined {
  const raw = record(input);
  const correction = text(raw?.correction, 240);
  const adjustment = text(raw?.adjustment, 240);
  if (!raw || !correction || !adjustment) return undefined;
  const sourceHandles = [...new Set((Array.isArray(raw.sourceMemoryHandles) ? raw.sourceMemoryHandles : [])
    .map((value) => text(value, 24)).filter(Boolean))].slice(0, 3);
  const memories = sourceHandles.map((handle) => protocol.handles.memories.find((memory) => memory.handle === handle));
  const compilationSources = new Set((Array.isArray(protocol.requestContext.current.compilationFeedback)
    ? protocol.requestContext.current.compilationFeedback : []).flatMap((value) => {
    const entry = record(value);
    return typeof entry?.eventId === 'string' ? [entry.eventId] : [];
  }));
  const sourceCompilationIds = [...new Set((Array.isArray(raw.sourceCompilationEventIds) ? raw.sourceCompilationEventIds : [])
    .map((value) => text(value, 180)).filter(Boolean))];
  if (memories.some((memory) => !memory) || sourceCompilationIds.some((id) => !compilationSources.has(id))) return undefined;
  if (!sourceCompilationIds.length && !memories.some((memory) => memory?.causalOutcome === 'blocked' || memory?.causalOutcome === 'failed'
    || memory?.sourceFactIds.some((id) => compilationSources.has(id)))) return undefined;
  return {
    correction,
    adjustment,
    sourceMemoryHandles: sourceHandles,
    sourceEventIds: [...new Set([...memories.flatMap((memory) => memory!.sourceFactIds), ...sourceCompilationIds])].slice(-24),
  };
}

function sanitizeModelPlan(
  input: unknown,
  protocol: DecisionModelRequestProtocol,
  intentionGoal: string,
  context?: DecisionRequestContext,
): ModelPlanOutput | undefined {
  const raw = record(input);
  if (!raw || !Array.isArray(raw.steps)) return undefined;
  const steps = raw.steps.map((value) => text(value, 240)).filter(Boolean);
  if (!steps.length || steps.length !== raw.steps.length) return undefined;
  const disposition = raw.disposition;
  if (!['act', 'continue', 'pause', 'abandon', 'stay'].includes(String(disposition))) return undefined;
  // The model describes one step. Numeric menu choices no longer compile it.
  if (['firstStepHandle', 'continuationHandle', 'experiment', 'worldAction'].some((field) => raw[field] !== undefined)) return undefined;
  const currentStep = raw.currentStep === undefined ? undefined : sanitizeWorldAction(raw.currentStep, protocol);
  if (raw.currentStep !== undefined && (!currentStep?.kind
    || (context?.continuingPlan && currentStep.kind === 'speech'))) return undefined;
  const resumeIntentHandle = text(raw.resumeIntentHandle, 24);
  const abandonIntentHandle = text(raw.abandonIntentHandle, 24);
  if (resumeIntentHandle && !protocol.handles.suspendedIntents.some((intent) => intent.handle === resumeIntentHandle && intent.resumable)) return undefined;
  if (abandonIntentHandle && !protocol.handles.suspendedIntents.some((intent) => intent.handle === abandonIntentHandle)) return undefined;
  if (disposition === 'act' ? Number(Boolean(currentStep)) + Number(Boolean(resumeIntentHandle)) !== 1
    : Boolean(currentStep || resumeIntentHandle)) return undefined;
  if (abandonIntentHandle && disposition !== 'abandon') return undefined;
  if (protocol.actorAttempt && (protocol.actorAttempt.mode === 'wait'
    || protocol.actorAttempt.hasExplicitFocus && !protocol.actorAttempt.targetHandles.length) && disposition === 'act') return undefined;
  if (protocol.actorAttempt?.mode === 'observe' && resumeIntentHandle) return undefined;
  const completion = (context ? compileModelPlanCompletion(raw.completion, context, protocol.handles) : undefined)
    ?? sanitizeBoundPlanCompletion(raw.completion);
  // Plan proposes evidence for the frozen aim, not a replacement aim. Bind
  // this before World sees the checks; the provider's raw output stays intact.
  if (completion) completion.goal.description = intentionGoal;
  const feedback = sanitizePlanFeedback(raw.feedback, protocol);
  // Optional explanation cannot erase a well-formed current step. Only
  // grounded feedback is retained as evidence; the action remains testable.
  return {
    steps, disposition: disposition as ModelPlanOutput['disposition'],
    ...(completion ? { completion } : {}), ...(currentStep ? { currentStep } : {}),
    ...(resumeIntentHandle ? { resumeIntentHandle } : {}),
    ...(abandonIntentHandle ? { abandonIntentHandle } : {}), ...(feedback ? { feedback } : {}),
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
  if (visible.kind === 'remains') return { kind: 'observe', target: { kind: 'remains', remainsId: visible.remainsId } };
  if (visible.kind === 'work') return { kind: 'observe', target: { kind: 'work', workId: visible.workId } };
  if (visible.kind === 'inventory-stack') return undefined;
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
    ...(text(raw.nextAttempt, 480) ? { nextAttempt: text(raw.nextAttempt, 480) } : {}),
    ...(sanitizeBoundAttempt(raw.attempt) ? { attempt: sanitizeBoundAttempt(raw.attempt) } : {}),
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
      content: `上一个 Mind intention 协议无效：${correction.problem}。请修正本次选择的 JSON，用具体自然语言说明尝试，或明确continue/wait；不填写引擎参数。`,
    },
  );
  if (conciseRetry) messages.push({
    role: 'user',
    content: '上一轮只返回了内部推理，没有最终 JSON。直接输出一个 Mind intention JSON。',
  });
  const phaseEndpoint = decisionPhaseEndpoint(endpoint, 'mind');
  const response = await requestModelText(phaseEndpoint, {
    messages,
    temperature: decisionPhaseTemperature('mind'),
    maxOutputTokens: decisionMaxOutputTokens(phaseEndpoint),
    jsonObject: true,
    jsonSchema: buildMindIntentionJsonSchema(protocol),
    timeoutMs: decisionTimeout(phaseEndpoint),
  });
  return { content: response.text, usage: response.usage };
}

async function requestWorldPlan(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  intention: MindIntentionOutput,
  correction?: { invalidContent: string; problem: string },
  retainedGoal?: MindDeltaChoice['retainedGoal'],
): Promise<{ content: string; usage: TokenUsage }> {
  const context = { ...buildWorldPlanRequestContext(protocol.requestContext, intention), ...planAgentWorldContext() };
  if (retainedGoal) context.declaration = retainedGoal.declaration ? {
    ...record(context.declaration), delivery: 'with-this-decision',
    meaning: '本轮新原话独立提交，当前创造尝试保留原目标',
  } : {
    delivery: 'none', meaning: '本轮只选择新的创造尝试，没有新原话；不产生或重播任何声明。',
  };
  protocol.actorAttempt = activeActorAttempt(protocol, intention);
  const attempt = describeActorAttempt(protocol, intention);
  if (attempt) context.intention = { ...record(context.intention), attempt };
  const describedSpeech = retainedGoal && !retainedGoal.declaration ? null
    : record(describeMindSpeechIntent(intention.speechIntent, protocol.handles));
  if (describedSpeech) {
    const speechIntent = { ...describedSpeech };
    if (speechIntent.commitment === intention.utterance) delete speechIntent.commitment;
    const proposal = record(speechIntent.proposal);
    if (proposal?.summary === intention.utterance) {
      const { summary: _sameUtterance, ...terms } = proposal;
      speechIntent.proposal = terms;
    }
    context.declaration = { ...record(context.declaration), speechIntent };
  }
  const messages: ModelMessage[] = [
    { role: 'system', content: WORLD_PLAN_SYSTEM_PROMPT_V1 },
    { role: 'user', content: JSON.stringify(context) },
  ];
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    { role: 'user', content: `上一个 WorldPlan 输出无法绑定：${correction.problem}。保持本人冻结的 goal 和 nextAttempt 及当前真实事实，只修正 plan/resolution 的格式、对象或具体做法；不产生新的本人意图或语言。` },
  );
  const phaseEndpoint = decisionPhaseEndpoint(endpoint, 'world');
  const response = await requestModelText(phaseEndpoint, {
    messages, temperature: decisionPhaseTemperature('plan'),
    maxOutputTokens: Math.min(16_384, decisionMaxOutputTokens(phaseEndpoint) * 2),
    jsonObject: true, jsonSchema: buildWorldPlanJsonSchema(protocol, protocol.actorAttempt), timeoutMs: decisionTimeout(phaseEndpoint),
  });
  return { content: response.text, usage: response.usage };
}

/** Translate only the actor's selected attempt. Deliberation and speech stay
 * with Mind; the compiler receives neither a new plan to author nor words to
 * turn into someone else's physical contribution.
 */
async function requestWorldAttempt(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  intention: MindIntentionOutput,
  correction?: { invalidContent: string; problem: string },
  selectedSpeech?: MindDeltaChoice['speech'],
): Promise<{ content: string; usage: TokenUsage }> {
  const context = { ...buildWorldAttemptRequestContext(protocol.requestContext, intention), ...planAgentWorldContext() };
  if (selectedSpeech) context.declaration = { status: selectedSpeech.frozenWords ? 'selected-words' : 'selected-meaning',
    meaning: '本人已经选定本轮语言，由独立的言语路径编译；不重复发言，也不将言语编译问题变成身体动作。' };
  const messages: ModelMessage[] = [
    { role: 'system', content: WORLD_ATTEMPT_SYSTEM_PROMPT_V1 },
    { role: 'user', content: JSON.stringify(context) },
  ];
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    { role: 'user', content: `当前操作尚未绑定：${correction.problem}。只修正已选尝试的参数或引用；若尚不能表达，返回uncompiled原因，不另定目标、安排他人行动或声明成功。` },
  );
  const phaseEndpoint = decisionPhaseEndpoint(endpoint, 'world');
  const response = await requestModelText(phaseEndpoint, {
    messages, temperature: decisionPhaseTemperature('plan'), maxOutputTokens: decisionMaxOutputTokens(phaseEndpoint),
    jsonObject: true, jsonSchema: buildWorldAttemptJsonSchema(protocol), timeoutMs: decisionTimeout(phaseEndpoint),
  });
  return { content: response.text, usage: response.usage };
}

async function requestWorldSpeech(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  choice: NonNullable<MindDeltaChoice['speech']>,
  correction?: { invalidContent: string; problem: string },
): Promise<{ content: string; usage: TokenUsage }> {
  const mind = protocol.mindContext;
  const context = {
    schemaVersion: 'world-speech-context-v2',
    actor: { id: mind.person.id, name: mind.person.name },
    selectedSpeech: choice.description,
    ...(choice.frozenWords ? { frozenUtterance: choice.frozenWords.utterance, frozenDelivery: choice.frozenWords.delivery } : {}),
    situation: { time: mind.situation.time, socialSituation: mind.situation.socialSituation },
    visible: mind.visible,
    speechReferences: mind.speechReferences ?? [],
    recentDialogue: mind.recentDialogue,
    current: { agreements: mind.current.agreements ?? [], recentExperiences: mind.current.recentExperiences ?? [] },
  };
  const messages: ModelMessage[] = [
    { role: 'system', content: WORLD_SPEECH_SYSTEM_PROMPT_V1 },
    { role: 'user', content: JSON.stringify(context) },
  ];
  if (correction) messages.push({ role: 'assistant', content: correction.invalidContent },
    { role: 'user', content: `言语编译尚未形成可提交原话：${correction.problem}。只修正本人selectedSpeech的表达和引用；缺少交易条款可以原样提问，不新增承诺、他人回应或物理操作。` });
  const phaseEndpoint = decisionPhaseEndpoint(endpoint, 'world');
  const response = await requestModelText(phaseEndpoint, {
    messages, temperature: decisionPhaseTemperature('plan'), maxOutputTokens: decisionMaxOutputTokens(phaseEndpoint),
    jsonObject: true, jsonSchema: buildWorldSpeechJsonSchema(protocol, Boolean(choice.frozenWords)), timeoutMs: decisionTimeout(phaseEndpoint),
  });
  return { content: response.text, usage: response.usage };
}

function normalizeWorldSpeechOutput(
  choice: NonNullable<MindDeltaChoice['speech']>, input: unknown,
  protocol: DecisionModelRequestProtocol, onInvalid: (problem: string) => void,
): Decision | undefined {
  const raw = record(input);
  if (!raw || Object.keys(raw).length !== 1) { onInvalid('只返回本轮言语编译字段或uncompiled，不附加身体操作或新目标'); return undefined; }
  if (raw.uncompiled !== undefined) {
    const issue = record(raw.uncompiled), reason = text(issue?.reason, 480);
    if (!issue || !reason || Object.keys(issue).some((key) => key !== 'reason')) {
      onInvalid('未编译反馈需要具体reason'); return undefined;
    }
    return speechChoiceDecision(choice, protocol, undefined, reason);
  }
  const declared = choice.frozenWords
    ? raw.speechIntent && record(raw.speechIntent) ? { ...choice.frozenWords, speechIntent: raw.speechIntent } : undefined
    : record(raw.declaration);
  if (!declared || !record(declared.speechIntent)
    || Object.keys(declared).some((key) => !['utterance', 'delivery', 'speechIntent'].includes(key))) {
    onInvalid(choice.frozenWords ? '原话与delivery已冻结，只返回speechIntent；不返回或改写declaration'
      : 'declaration需要本人utterance、delivery和speechIntent，不编写关系感受或其它字段'); return undefined;
  }
  const normalized = normalizeRetainedDeclarationModelOutput({ attention: 'keep-current', declaration: declared }, protocol, onInvalid);
  if (!normalized?.declaration || normalized.declaration.speechIntent?.kind !== record(declared.speechIntent)?.kind) {
    onInvalid('原话选择的言语含义或实际引用尚未绑定，不改成另一种言语行为'); return undefined;
  }
  const declaration = { ...normalized.declaration, ...(choice.frozenWords ?? {}) };
  return speechChoiceDecision(choice, protocol, declaration);
}

async function resolveWorldSpeech(
  endpoint: ResolvedModelEndpoint, protocol: DecisionModelRequestProtocol,
  choice: NonNullable<MindDeltaChoice['speech']>,
): Promise<DecisionResult> {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  let correction: { invalidContent: string; problem: string } | undefined;
  let failure = '本人已选的说话意向尚未编译';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      providerRequests++;
      const completion = await requestWorldSpeech(endpoint, protocol, choice, correction);
      usage = addUsage(usage, completion.usage);
      let raw: unknown;
      try { raw = parseJson(completion.content); } catch { raw = undefined; }
      const decision = normalizeWorldSpeechOutput(choice, raw, protocol, (detail) => { failure = detail; });
      if (decision) {
        const problem = decision.kind === 'idle' ? decision.compilationFailure?.message : undefined;
        return { decision, usage, providerRequests, ...(problem ? { failure: problem } : {}) };
      }
      correction = { invalidContent: completion.content, problem: failure };
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  return { decision: speechChoiceDecision(choice, protocol, undefined, failure), usage, providerRequests, failure };
}

/** Merge an independently compiled utterance without replacing body control,
 * the durable goal or the actor's privately authored relationship appraisal. */
function attachIndependentSpeech(
  decision: Decision,
  choice: NonNullable<MindDeltaChoice['speech']>,
  spoken: DecisionResult,
): { decision: Decision; failure?: string } {
  const language = spoken.decision?.mentalAct ?? spoken.decision?.declaration;
  if (language?.utterance.trim()) {
    const own = decision.mentalAct ?? decision.declaration;
    const declaration: NonNullable<Decision['declaration']> = {
      utterance: language.utterance, delivery: language.delivery, speechIntent: language.speechIntent,
      sourceEventIds: [...new Set([...(own?.sourceEventIds ?? []), ...language.sourceEventIds])],
      ...(own?.relationshipAppraisal ? { relationshipAppraisal: own.relationshipAppraisal } : {}),
    };
    return { decision: decision.mentalAct ? { ...decision, mentalAct: { ...decision.mentalAct, ...declaration } }
      : { ...decision, declaration }, ...(spoken.failure ? { failure: spoken.failure } : {}) };
  }
  const selected = choice.frozenWords
    ? `本轮冻结原话尚未发出：${JSON.stringify(choice.frozenWords)}`
    : `本轮已选说话意思尚未发出：${choice.description}`;
  const failure = `${selected}；言语编译：${spoken.failure ?? '未形成可提交的语义'}`;
  const retained = { ...decision, reason: `${decision.reason}；${failure}` };
  // A speech diagnostic must never suppress an already compiled body probe.
  if (retained.kind === 'idle' && !retained.nativeOperation && !retained.executionProbe && !retained.compilationFailure) {
    retained.compilationFailure = { code: 'invalid-operation', message: failure, fields: ['world-speech'] };
  }
  return { decision: retained, failure };
}

function worldAttemptParts(input: unknown): { body: unknown; speechHandoff: boolean } | undefined {
  const raw = record(input);
  if (!raw || raw.speechHandoff !== undefined && raw.speechHandoff !== true) return undefined;
  const { speechHandoff, ...body } = raw;
  return { body: speechHandoff === true && Object.keys(body).length === 0 ? { effects: [] } : body,
    speechHandoff: speechHandoff === true };
}

function planAgentWorldContext(): Record<string, unknown> {
  return { materialCatalog: MATERIAL_PALETTE.filter((material) => material.id !== 0)
    .map((material) => ({ key: material.key, name: material.name })) };
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function worldCompletionReview(input: unknown): WorldAdjudicationResolution['completionReview'] {
  const raw = record(input);
  if (!raw) return undefined;
  const review: NonNullable<WorldAdjudicationResolution['completionReview']> = {};
  for (const scope of ['step', 'goal'] as const) {
    const value = record(raw[scope]);
    const reason = text(value?.reason, 320);
    const sufficiency = value?.sufficiency;
    if (reason && (sufficiency === 'sufficient' || sufficiency === 'insufficient' || sufficiency === 'unverified')) {
      review[scope] = { sufficiency, reason };
    }
  }
  return Object.keys(review).length ? review : undefined;
}

function referencedWorldHandles(value: unknown): string[] {
  const raw = record(value);
  if (!raw) return [];
  return [...new Set([
    ...['targetHandle', 'sourceHandle', 'destinationHandle', 'toolHandle', 'instrumentHandle', 'containerHandle', 'carrierHandle', 'siteHandle',
      ...(nativeActWireDefinition(raw.kind)?.parameters.map((parameter) => parameter.field) ?? [])]
      .flatMap((key) => typeof raw[key] === 'string' ? [raw[key] as string] : []),
    ...(Array.isArray(raw.targetHandles) ? raw.targetHandles.filter((handle): handle is string => typeof handle === 'string') : []),
  ])];
}

/** Bind a fallible world-compiler proposal to server-owned refs and the mutation IR. */
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
  const completionReview = worldCompletionReview(raw?.completionReview);
  const operationTargets = worldAction?.targetHandles;
  const targetBindings = worldAction ? deriveWorldTargets(protocol.targetContext ?? protocol.requestContext,
    protocol.handles, operationTargets ?? []) : undefined;
  if (worldAction && raw?.nativeOperation !== undefined) {
    if (raw.effects !== undefined) return invalid('原生操作与开放物理效果不能同时执行，请编译当前真实一步');
    let nativeProblem: string | undefined;
    let nativeOperation = compileModelNativeOperation(raw.nativeOperation, protocol.targetContext ?? protocol.requestContext,
      protocol.handles, operationTargets, (problem) => { nativeProblem = problem; });
    if (!nativeOperation) return invalid(nativeProblem ?? '原生操作的类型、对象或来源引用无法绑定本轮实际内容');
    if (protocol.actorAttempt?.mode === 'observe') {
      if (nativeOperation.kind !== 'observe' && nativeOperation.kind !== 'move') return invalid('本人选择的是感知；当前只能观察或走近所选观察对象，不能移交、施力或启动另一物理工序');
      nativeOperation = { ...nativeOperation, perceptionOnly: true };
    }
    if (worldAction.kind === 'speech' && nativeOperation.kind !== 'speech') return invalid('本人本步选择的是发言，应执行冻结原话，不能改成本人拿取或其他身体动作');
    if (worldAction.kind === 'physical' && nativeOperation.kind === 'speech') return invalid('本人本步选择的是身体操作，World不能替他新增语言选择');
    return { nativeOperation, feedback: '当前一步已绑定为原生操作，实际结果尚待执行',
      targetDerivations: targetBindings!.derived.filter((entry) => referencedWorldHandles(raw.nativeOperation).includes(entry.handle)),
      ...(completionReview ? { completionReview } : {}) };
  }
  if (protocol.actorAttempt?.mode === 'observe') return invalid('本人的感知尝试使用observe或必要的walk-to准备，不用开放effects改动物资或状态');
  if (worldAction?.kind === 'speech') return invalid('本人已选定发言，这一步应编译为 nativeOperation.kind=speech');
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
  const requestedHandles = new Set(targetBindings!.allowedHandles);
  const usedHandles = [...new Set(rawEffects.flatMap(referencedWorldHandles))].filter((handle) => requestedHandles.has(handle));
  const targets = (usedHandles.length ? usedHandles : worldAction.targetHandles)
    .map((handle) => worldRefForHandle(protocol.handles, handle, actorId));
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
      if (target.kind === 'inventory-stack' && target.personId !== actorId) return invalid('对方持物须先通过 transfer 实际取得；consume 不能直接消耗他人持物');
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
    if (kind === 'transfer' || kind === 'relocate') {
      const targetHandle = text(effect.targetHandle, 24);
      const destinationHandle = text(effect.destinationHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      const destination = requestedHandles.has(destinationHandle)
        ? worldRefForHandle(protocol.handles, destinationHandle, actorId)
        : undefined;
      const quantity = boundedInteger(effect.quantity, 1, kind === 'transfer' ? Number.MAX_SAFE_INTEGER : 8);
      if (kind === 'transfer') {
        if (!target || !['drop', 'inventory-stack'].includes(target.kind)
          || !destination || !['person', 'voxel'].includes(destination.kind)
          || quantity === undefined) return invalid('transfer 需要已点名的持物/地面物 targetHandle、人物或地表 destinationHandle，以及正整数 quantity；真实转移和抵抗由执行器结算');
        effects.push({
          kind,
          target: target as Extract<WorldRef, { kind: 'drop' | 'inventory-stack' }>,
          destination: destination as Extract<WorldRef, { kind: 'person' | 'voxel' }>,
          quantity,
        });
        continue;
      }
      if (!target || !['drop', 'inventory-stack'].includes(target.kind)
        || destination?.kind !== 'voxel' || quantity === undefined) return invalid('relocate 的 targetHandle 必须是已点名背包/地面物，destinationHandle 必须是已点名地表，quantity 为 1–8');
      if (target.kind === 'inventory-stack' && target.personId !== actorId) return invalid('移动对方持物须通过 transfer 的实际转移与抵抗结算，不能用 relocate 跳过');
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
    targetDerivations: targetBindings!.derived.filter((entry) => usedHandles.includes(entry.handle)),
    ...(completionReview ? { completionReview } : {}),
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

/** A current physical attempt has its own result, not authority to finish or
 * rewrite the actor's durable purpose. No synthetic Plan is needed to store it.
 */
export function normalizeWorldAttemptModelOutput(
  context: DecisionRequestContext,
  mindInput: unknown,
  input: unknown,
  protocol: DecisionModelRequestProtocol,
  onInvalid?: (problem: string) => void,
): Decision | null {
  const invalid = (problem: string): null => { onInvalid?.(problem); return null; };
  const intention = sanitizeMindIntention(mindInput, protocol.handles);
  if (!intention?.nextAttempt) return invalid('缺少本人已经选定的当前尝试，不能从长期目标另造一步');
  const raw = record(input);
  if (!raw || Object.keys(raw).length !== 1) return invalid('只返回nativeOperation、effects或uncompiled中的一种，不返回计划、语言或目标完成判据');
  const mentalAct = mindMentalAct(intention, protocol);
  const characterAgendaUpdate = intention.horizon === 'ongoing' && protocol.characterAgendaProposal
    ? concernUpdateForMentalAct({ kind: 'create' }, undefined, intention.evidenceMemoryHandles, mentalAct, protocol.handles)
    : undefined;
  const decision: Decision = { kind: 'idle', reason: intention.nextAttempt, mentalAct,
    authoredAttempt: { kind: 'creative' }, ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}) };
  if (raw.uncompiled !== undefined) {
    const issue = record(raw.uncompiled);
    const reason = text(issue?.reason, 480);
    if (!issue || !reason || Object.keys(issue).some((key) => key !== 'reason')) return invalid('uncompiled需要具体的reason，不生成未执行的身体事件');
    return { ...decision, compilationFailure: { code: 'invalid-operation', message: reason, fields: ['world-attempt'] } };
  }
  if (raw.nativeOperation !== undefined) {
    let problem = '当前操作未能绑定到本人实际可用的对象或参数';
    const nativeOperation = compileModelNativeOperation(raw.nativeOperation,
      protocol.targetContext ?? protocol.requestContext, protocol.handles, undefined,
      (detail) => { problem = detail; });
    if (!nativeOperation || nativeOperation.kind === 'speech') return invalid(nativeOperation?.kind === 'speech'
      ? '原话已经独立处理，世界编译不新增语言选择' : problem);
    return { ...decision, nativeOperation };
  }
  if (!Array.isArray(raw.effects)) return invalid('effects需要效果数组；尚不能表达时返回uncompiled原因');
  if (!raw.effects.length) return decision; // No additional body step, never a fabricated success fact.
  const referencedHandles = [...new Set(raw.effects.flatMap(referencedWorldHandles))];
  const resolution = sanitizePlanAgentWorldVerdict({ effects: raw.effects,
    status: 'completed', result: '已绑定本人的当前尝试，实际后果由执行器结算',
  }, { kind: 'physical', description: intention.nextAttempt, targetHandles: referencedHandles }, protocol, onInvalid);
  if (resolution?.probe?.kind === 'world-interaction') resolution.probe.adjudication.request = intention.nextAttempt;
  return resolution?.probe ? { ...decision, executionProbe: resolution.probe } : null;
}

/** A semantic current step is compiled separately, never selected by an option number. */
export function normalizeMindPlanModelOutput(
  context: DecisionRequestContext,
  mindInput: unknown,
  planInput: unknown,
  protocol: DecisionModelRequestProtocol,
  worldResolution?: WorldAdjudicationResolution,
): Decision | null {
  const intention = sanitizeMindIntention(mindInput, protocol.handles);
  if (!intention) return null;
  protocol = { ...protocol, actorAttempt: activeActorAttempt(protocol, intention) };
  const plan = sanitizeModelPlan(planInput, protocol, intention.goal, context);
  if (!intention || !plan) return null;
  if (plan.currentStep && !worldResolution?.probe && !worldResolution?.nativeOperation) return null;
  if (worldResolution?.nativeOperation?.kind === 'speech' && context.continuingPlan) return null;
  if (plan.currentStep?.kind === 'speech' && worldResolution?.nativeOperation?.kind !== 'speech') return null;
  if (plan.currentStep?.kind === 'physical' && worldResolution?.nativeOperation?.kind === 'speech') return null;
  if (protocol.actorAttempt?.mode === 'observe' && plan.currentStep
    && (!worldResolution?.nativeOperation || !['observe', 'move'].includes(worldResolution.nativeOperation.kind))) return null;
  // The world compiler proposes criteria and assesses their meaning in the
  // same call. This is a fallible interpretation of the frozen actor goal.
  // Missing interpretation keeps success unknown and never cancels the action.
  const checks = plan.completion ?? {
    step: { description: plan.currentStep?.description ?? plan.steps[0], conditions: [] },
    goal: { description: intention.goal, conditions: [] },
  };
  plan.completion = Object.fromEntries((['step', 'goal'] as const).map((scope) => [scope, {
    ...checks[scope],
    ...(scope === 'goal' ? { description: intention.goal } : {}),
    meaningReview: checks[scope].conditions.length && worldResolution?.completionReview?.[scope]
      ? worldResolution.completionReview[scope]
      : { sufficiency: 'unverified', reason: checks[scope].conditions.length
        ? '尚未核对这些条件是否足以证明人物原意图的结果'
        : '尚无能核对该结果的具体条件' },
  }])) as NonNullable<ModelPlanOutput['completion']>;
  let nativeOperation = worldResolution?.nativeOperation ? structuredClone(worldResolution.nativeOperation) : undefined;
  if (nativeOperation && protocol.actorAttempt?.mode === 'observe') nativeOperation.perceptionOnly = true;
  if (nativeOperation?.kind === 'move' && plan.completion) {
    const target = nativeOperation.target;
    const distances = [plan.completion.step, plan.completion.goal]
      .filter((check) => check.meaningReview?.sufficiency === 'sufficient').flatMap((check) => check.conditions)
      .flatMap((condition) => (condition.kind === 'near-target' || condition.kind === 'reached-target')
        && JSON.stringify(condition.target) === JSON.stringify(target) ? [condition.maxDistance] : []);
    if (distances.length) nativeOperation = { ...nativeOperation,
      withinDistance: Math.min(nativeOperation.withinDistance ?? Infinity, ...distances) };
  }
  const sourceEventIds = [...new Set(intention.evidenceMemoryHandles.flatMap((handle) =>
    protocol.handles.memories.find((memory) => memory.handle === handle)?.sourceFactIds ?? []))];
  const mentalAct: MentalAct = {
    version: 'mental-act-v2',
    kind: plan.disposition === 'continue' ? 'continue'
      : plan.disposition === 'pause' || plan.disposition === 'abandon' ? 'reconsider'
        : plan.disposition === 'stay' ? 'wait' : nativeOperation?.kind === 'speech' ? 'talk' : 'pursue',
    utterance: intention.utterance, delivery: intention.delivery,
    speechIntent: intention.speechIntent, goal: intention.goal,
    ...(intention.nextAttempt ? { nextAttempt: intention.nextAttempt } : {}),
    ...(intention.attempt ? { attempt: structuredClone(intention.attempt) } : {}),
    orientation: intention.orientation, horizon: intention.horizon,
    strategy: plan.currentStep?.description ?? plan.steps[0], assumptions: [], sourceEventIds,
    ...(intention.relationshipAppraisal ? { relationshipAppraisal: structuredClone(intention.relationshipAppraisal) } : {}),
    ...(plan.feedback ? { planFeedback: { correction: plan.feedback.correction,
      adjustment: plan.feedback.adjustment, sourceEventIds: plan.feedback.sourceEventIds } } : {}),
    plan: {
      version: 'mental-plan-translation-v1', steps: [...plan.steps], disposition: plan.disposition,
      ...(plan.completion ? { completion: structuredClone(plan.completion) } : {}),
      ...(plan.currentStep ? { currentStep: {
        kind: plan.currentStep.kind,
        description: plan.currentStep.description,
        targets: plan.currentStep.targetHandles.flatMap((handle) => {
          const target = worldRefForHandle(protocol.handles, handle, context.person.id);
          return target ? [target] : [];
        }),
        ...(plan.currentStep.expectedResult ? { expectedResult: plan.currentStep.expectedResult } : {}),
        ...(worldResolution?.targetDerivations?.length ? { derivedTargets: worldResolution.targetDerivations.flatMap((entry) => {
          const target = worldRefForHandle(protocol.handles, entry.handle, context.person.id);
          const source = worldRefForHandle(protocol.handles, entry.sourceHandle, context.person.id);
          return target && source ? [{ target, source, relation: entry.relation }] : [];
        }) } : {}),
      } } : {}),
      ...(plan.resumeIntentHandle ? { resumeIntentHandle: plan.resumeIntentHandle } : {}),
      ...(plan.abandonIntentHandle ? { abandonIntentHandle: plan.abandonIntentHandle } : {}),
    },
  };
  const reason = mentalAct.strategy;
  // Declaring an ongoing purpose must survive an unexecutable/stationary
  // step. Reuse the existing agenda persistence path without adding a task,
  // a civilization milestone or a model-invented success.
  const characterAgendaUpdate = intention.horizon === 'ongoing' && protocol.characterAgendaProposal
    && !context.continuingPlan && !plan.resumeIntentHandle && !plan.abandonIntentHandle
    ? concernUpdateForMentalAct({ kind: 'create' }, undefined, intention.evidenceMemoryHandles, mentalAct, protocol.handles)
    : undefined;
  if (plan.resumeIntentHandle) {
    const intent = protocol.handles.suspendedIntents.find((item) => item.handle === plan.resumeIntentHandle);
    return intent ? { kind: 'resume', intentId: intent.intentId, reason, mentalAct } : null;
  }
  if (plan.disposition === 'pause' && context.activeIntent) return {
    kind: 'suspend', intentId: context.activeIntent.id, reason, mentalAct,
  };
  if (plan.disposition === 'abandon') {
    const id = plan.abandonIntentHandle
      ? protocol.handles.suspendedIntents.find((item) => item.handle === plan.abandonIntentHandle)?.intentId
      : context.activeIntent?.id;
    if (id) return { kind: 'abandon', intentId: id, reason, mentalAct };
  }
  let probe = worldResolution?.probe;
  if (probe?.kind === 'world-interaction' && plan.completion) {
    probe = structuredClone(probe);
    probe.adjudication.effects = probe.adjudication.effects.map((effect) => {
      if (effect.kind !== 'move-self') return effect;
      const distances = [plan.completion!.step, plan.completion!.goal]
        .filter((check) => check.meaningReview?.sufficiency === 'sufficient').flatMap((check) => check.conditions)
        .flatMap((condition) => (condition.kind === 'near-target' || condition.kind === 'reached-target')
          && JSON.stringify(condition.target) === JSON.stringify(effect.target) ? [condition.maxDistance] : []);
      return distances.length ? { ...effect, withinDistance: Math.min(effect.withinDistance ?? Infinity, ...distances) } : effect;
    });
  }
  return { kind: 'idle', reason, mentalAct,
    ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    ...(plan.currentStep && nativeOperation ? { nativeOperation } : {}),
    ...(plan.currentStep && probe ? { executionProbe: probe } : {}),
  };
}

export function normalizeContinuingPlanModelOutput(
  context: DecisionRequestContext,
  planInput: unknown,
  protocol: DecisionModelRequestProtocol,
  worldResolution?: WorldAdjudicationResolution,
): Decision | null {
  const frozen = context.continuingPlan?.mentalAct;
  if (!frozen) return null;
  const decision = normalizeMindPlanModelOutput(context, {
    ...frozen, relationshipAppraisal: undefined, evidenceMemoryHandles: [],
  }, planInput, protocol, worldResolution);
  if (!decision?.mentalAct) return decision;
  if (decision.mentalAct.kind === 'talk') return null;
  if (decision.kind === 'resume' && !context.suspendedIntents.some((intent) => intent.id === decision.intentId
    && intent.requiresNewSpeech === false && intent.planSourceDecisionEventId === context.continuingPlan?.sourceDecisionEventId)) return null;
  return { ...decision, mentalAct: { ...decision.mentalAct,
    utterance: frozen.utterance, delivery: frozen.delivery, goal: frozen.goal,
    assumptions: [...frozen.assumptions], sourceEventIds: [...frozen.sourceEventIds],
  } };
}

interface DecisionResult {
  decision: Decision | null;
  usage: TokenUsage;
  providerRequests: number;
  /** Infrastructure diagnosis, never a character belief or chosen inactivity. */
  failure?: string;
}

/** A broken translation cannot erase a valid personal choice or unsay its words. */
function uncompiledMindDecision(
  context: DecisionRequestContext,
  intention: MindIntentionOutput,
  protocol: DecisionModelRequestProtocol,
  failure: string,
): Decision {
  const sourceEventIds = [...new Set(intention.evidenceMemoryHandles.flatMap((handle) =>
    protocol.handles.memories.find((memory) => memory.handle === handle)?.sourceFactIds ?? []))];
  const original = context.continuingPlan?.mentalAct;
  const mentalAct: MentalAct = original ? {
    ...structuredClone(original), plan: structuredClone(context.continuingPlan!.plan),
  } : {
    version: 'mental-act-v2', kind: 'pursue',
    utterance: intention.utterance, delivery: intention.delivery, speechIntent: intention.speechIntent,
    goal: intention.goal, ...(intention.nextAttempt ? { nextAttempt: intention.nextAttempt } : {}),
    ...(intention.attempt ? { attempt: structuredClone(intention.attempt) } : {}),
    orientation: intention.orientation, horizon: intention.horizon,
    strategy: intention.nextAttempt ?? intention.goal, assumptions: [], sourceEventIds,
    ...(intention.relationshipAppraisal ? { relationshipAppraisal: structuredClone(intention.relationshipAppraisal) } : {}),
    // This is the author's outline, not an invented body action or an accepted
    // WorldPlan. A later compiler can start from the same source without Mind.
    plan: { version: 'mental-plan-translation-v1', disposition: 'uncompiled',
      steps: [intention.nextAttempt ?? intention.goal] },
  };
  const characterAgendaUpdate = !context.continuingPlan && intention.horizon === 'ongoing'
    && protocol.characterAgendaProposal
    ? concernUpdateForMentalAct({ kind: 'create' }, undefined, intention.evidenceMemoryHandles, mentalAct, protocol.handles)
    : undefined;
  return { kind: 'idle', reason: '本人选择已保留，当前尝试尚未编译', mentalAct,
    compilationFailure: { code: 'invalid-operation', message: failure, fields: ['world-plan'] },
    ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
  };
}

interface MindResult extends MindDeltaChoice {
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
  context: DecisionRequestContext,
  protocol: DecisionModelRequestProtocol,
  endpoint: ResolvedModelEndpoint,
): Promise<MindResult> {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
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
    const selectedAttempt = record(record(parsed)?.attempt);
    if (!selectedAttempt || !['creative', 'speak', 'continue', 'wait'].includes(String(selectedAttempt.kind))) {
      mindCorrection = { invalidContent: completion.content,
        problem: '本轮Mind必须显式给attempt：creative加身体活动description，speak加想表达的description，continue保持安排或wait停下；不填写nativeOperation或引擎参数' };
      continue;
    }
    const choice = sanitizeMindDelta(parsed, context, protocol, (detail) => { problem = detail; });
    if (choice) return { ...choice, usage, providerRequests,
      ...(choice.decision?.kind === 'idle' && choice.decision.compilationFailure
        ? { failure: choice.decision.compilationFailure.message } : {}),
    };
    mindCorrection = { invalidContent: completion.content, problem };
  }
  return { usage, providerRequests, ...(mindCorrection ? { failure: mindCorrection.problem } : {}) };
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
  let selectedIntention: MindIntentionOutput | undefined;
  let selectedSpeech: MindDeltaChoice['speech'];
  let selectedSpeechResult: DecisionResult | undefined;
  let retainedGoal: MindDeltaChoice['retainedGoal'];
  const finish = (decision: Decision, failure?: string): DecisionResult => {
    const combined: { decision: Decision; failure?: string } = selectedSpeech && selectedSpeechResult
      ? attachIndependentSpeech(decision, selectedSpeech, selectedSpeechResult) : { decision };
    const problem = [...new Set([failure, combined.failure].filter((value): value is string => Boolean(value)))].join('；');
    return { decision: combined.decision, usage, providerRequests, ...(problem ? { failure: problem } : {}) };
  };
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
    : await decideMind(context, protocol, endpoint);
  usage = mind.usage;
  providerRequests = mind.providerRequests;
  if (mind.speech) {
    selectedSpeech = mind.speech;
    selectedSpeechResult = await resolveWorldSpeech(endpoint, protocol, mind.speech);
    usage = addUsage(usage, selectedSpeechResult.usage);
    providerRequests += selectedSpeechResult.providerRequests;
  }
  if (mind.decision) return finish(mind.decision, mind.failure);
  if (!mind.intention) return { decision: null, usage, providerRequests, failure: mind.failure ?? 'Mind 未返回可解析的本人意图' };
  selectedIntention = mind.intention;
  retainedGoal = mind.retainedGoal;
  let correction: { invalidContent: string; problem: string } | undefined;
  if (!continuationOnly) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      providerRequests += 1;
      const completion = await requestWorldAttempt(endpoint, protocol, mind.intention, correction, mind.speech);
      usage = addUsage(usage, completion.usage);
      let raw: unknown;
      try { raw = parseJson(completion.content); } catch { raw = undefined; }
      let problem = '当前尝试需要一个可绑定的操作、speechHandoff:true或明确的未编译原因';
      const parts = worldAttemptParts(raw);
      const decision = parts && normalizeWorldAttemptModelOutput(context, mind.intention, parts.body, protocol,
        (detail) => { problem = detail; });
      if (decision) {
        let compiled = preserveAttemptAuthorship(decision, mind.retainedGoal);
        let failure = decision.kind === 'idle' ? decision.compilationFailure?.message : undefined;
        const selectedWords = compiled.declaration?.utterance ?? compiled.mentalAct?.utterance;
        if (parts.speechHandoff && !mind.speech && !selectedWords?.trim()) {
          // Hand off the exact actor sentence, not another World-authored
          // paraphrase. Speech and a compiled physical prefix are independent.
          const spoken = await resolveWorldSpeech(endpoint, protocol, { description: mind.intention.nextAttempt! });
          usage = addUsage(usage, spoken.usage); providerRequests += spoken.providerRequests;
          const declaration = spoken.decision?.declaration;
          if (declaration) compiled = compiled.mentalAct
            ? { ...compiled, mentalAct: { ...compiled.mentalAct, ...declaration,
              sourceEventIds: [...new Set([...compiled.mentalAct.sourceEventIds, ...declaration.sourceEventIds])],
            } }
            : { ...compiled, declaration };
          if (spoken.failure) {
            failure = [failure, spoken.failure].filter(Boolean).join('；');
            // Attaching a generic compilationFailure would suppress an open
            // physical probe. Keep that valid body request and report the
            // independent speech failure through provider metadata instead.
            if (compiled.kind === 'idle' && !compiled.nativeOperation && !compiled.executionProbe && !compiled.compilationFailure
              && spoken.decision?.kind === 'idle' && spoken.decision.compilationFailure) {
              compiled = { ...compiled, compilationFailure: spoken.decision.compilationFailure };
            }
          }
        }
        return finish(compiled, failure);
      }
      correction = { invalidContent: completion.content, problem };
    }
    const failure = correction?.problem ?? '当前尝试尚未编译';
    const incomplete = normalizeWorldAttemptModelOutput(context, mind.intention, { uncompiled: { reason: failure } }, protocol)!;
    return finish(preserveAttemptAuthorship(incomplete, mind.retainedGoal), failure);
  }
  // Existing stored plans retain their own explicit continuation path. New
  // creative choices above no longer create plans for this path to advance.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    providerRequests += 1;
    const completion = await requestWorldPlan(endpoint, protocol, mind.intention, correction, mind.retainedGoal);
    usage = addUsage(usage, completion.usage);
    let raw: Record<string, unknown> | null;
    try { raw = record(parseJson(completion.content)); }
    catch { raw = null; }
    if (!raw || Object.keys(raw).some((key) => key !== 'plan' && key !== 'resolution')) {
      correction = { invalidContent: completion.content, problem: '需要 {plan,resolution?} JSON 对象，不能返回旧的独立Plan或World格式' };
      continue;
    }
    const plan = sanitizeModelPlan(raw.plan, protocol, mind.intention.goal, context);
    if (!plan) {
      correction = { invalidContent: completion.content, problem: 'plan缺少合法的完整计划、控制状态或当前步骤' };
      continue;
    }
    if (plan.currentStep && plan.currentStep.kind !== 'physical') {
      correction = { invalidContent: completion.content, problem: 'WorldPlan只安排本人当前身体步骤；原话已独立提交，不再排成speech工作' };
      continue;
    }
    let resolution: WorldAdjudicationResolution | undefined;
    if (plan.currentStep) {
      let problem = '当前步骤需要对应的resolution，以原生操作或开放effects表达实际尝试';
      resolution = sanitizePlanAgentWorldVerdict(raw.resolution, plan.currentStep, protocol, (detail) => { problem = detail; });
      if (!resolution) { correction = { invalidContent: completion.content, problem }; continue; }
    } else if (raw.resolution !== undefined) {
      correction = { invalidContent: completion.content, problem: '没有新的currentStep时只返回plan，不附加未选择的resolution操作' };
      continue;
    }
    const decision = continuationOnly
      ? normalizeContinuingPlanModelOutput(context, plan, protocol, resolution)
      : normalizeMindPlanModelOutput(context, mind.intention, plan, protocol, resolution);
    if (decision) return { decision: continuationOnly ? decision : preserveAttemptAuthorship(decision, mind.retainedGoal), usage, providerRequests };
    correction = { invalidContent: completion.content, problem: 'plan与resolution未形成可执行且归属本人的同一步' };
  }
  const failure = correction?.problem ?? 'WorldPlan尚未形成可执行步骤';
  const incomplete = uncompiledMindDecision(context, mind.intention, protocol, failure);
  return { decision: continuationOnly ? incomplete : preserveAttemptAuthorship(incomplete, mind.retainedGoal), usage, providerRequests, failure };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (selectedIntention) return finish(continuationOnly
      ? uncompiledMindDecision(context, selectedIntention, protocol, failure)
      : preserveAttemptAuthorship(normalizeWorldAttemptModelOutput(context, selectedIntention,
        { uncompiled: { reason: failure } }, protocol)!, retainedGoal), failure);
    if (selectedSpeech) return finish(speechChoiceDecision(selectedSpeech, protocol, undefined, failure), failure);
    return { decision: null, usage, providerRequests, failure };
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
  // Local Ollama inference shares one resident model; avoid queued requests
  // spending their timeout waiting behind another person's full context.
  const concurrency = endpoint.protocol === 'ollama-chat' ? 1 : 3;
  await Promise.all(Array.from({ length: Math.min(concurrency, contexts.length) }, async () => {
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
