import {
  type DecisionRequestContext,
} from '../src/game/eland/application/model-decision/decision-context';
import {
  buildDecisionProbeHandleMap,
  type DecisionProbeHandleMap,
} from '../src/game/eland/application/model-decision/capability-handles';
import {
  buildMentalActRequestContext,
  type MentalActRequestContext,
} from '../src/game/eland/application/model-decision/mental-act-context';
import { validateActionOptionSemantics } from '../src/game/eland/domain/action-option-semantics';
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
  buildMentalActBatchJsonSchema,
  buildMentalActJsonSchema,
} from './model-decision-json-schema';
import {
  CHARACTER_AGENDA_EXTENSION_V2,
  DECISION_SYSTEM_PROMPT_V2,
} from './agent-prompt-templates';

const MAX_AGENTS = 12;

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseJson(content: string): unknown {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
}

function decisionTimeout(endpoint: ResolvedModelEndpoint): number {
  const configured = Number(loadServerEnvValue('MODEL_DECISION_TIMEOUT_MS') || Math.min(endpoint.timeoutMs, 12_000));
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(30_000, configured)) : 12_000;
}

function decisionMaxOutputTokens(): number {
  const configured = Number(loadServerEnvValue('MODEL_DECISION_MAX_OUTPUT_TOKENS') || 600);
  return Number.isFinite(configured) ? Math.max(128, Math.min(2_000, Math.floor(configured))) : 600;
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
  handles: DecisionProbeHandleMap;
  characterAgendaProposal: boolean;
}

export function buildDecisionModelRequestProtocol(
  context: DecisionRequestContext,
  options: { characterAgendaProposal?: boolean } = {},
): DecisionModelRequestProtocol {
  const characterAgendaProposal = options.characterAgendaProposal ?? usesCharacterAgendaProposal();
  const handles = buildDecisionProbeHandleMap(context);
  return {
    requestContext: buildMentalActRequestContext(context, handles),
    handles,
    characterAgendaProposal,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  const thoughtLine = text(raw.thoughtLine, 180);
  if (!thoughtLine) return undefined;
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
  return {
    version: 'mental-act-v1',
    kind,
    thoughtLine,
    goal,
    strategy,
    assumptions,
    ...(expectedObservation ? { expectedObservation } : {}),
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
    theme: mentalAct.kind === 'investigate' ? 'inquiry' : 'personal',
    importance: boundedNumber(raw.importance, mentalAct.kind === 'investigate' ? 62 : 58, 0, 100),
    horizonMonths: boundedNumber(raw.horizonMonths, 12, 6, 240),
    sourceMemoryHandles,
    approach: {
      summary: mentalAct.strategy,
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
  const requestedStep = Object.prototype.hasOwnProperty.call(raw, 'firstStepHandle');
  const requestedContinuation = Object.prototype.hasOwnProperty.call(raw, 'continuationHandle');
  const stepHandle = text(raw.firstStepHandle, 24);
  const continuationHandle = text(raw.continuationHandle, 24);
  const exposedSteps = new Set(protocol.requestContext.availableSteps.map((step) => step.handle));
  const exposedContinuations = new Set(protocol.requestContext.continuations.map((step) => step.handle));
  if ((requestedStep && !exposedSteps.has(stepHandle))
    || (requestedContinuation && !exposedContinuations.has(continuationHandle))) return null;
  const optionIndex = /^o([1-9]\d*)$/u.exec(stepHandle);
  const continuationIndex = /^f([1-9]\d*)$/u.exec(continuationHandle);
  const optionId = optionIndex ? context.options[Number(optionIndex[1]) - 1]?.id : undefined;
  const followUpOptionId = continuationIndex
    ? context.followUpOptions[Number(continuationIndex[1]) - 1]?.id
    : undefined;
  if (requestedStep && !optionId) return null;
  if (requestedContinuation && !followUpOptionId) return null;
  if (optionId) raw.optionId = optionId;
  else delete raw.optionId;
  if (followUpOptionId) raw.followUpOptionId = followUpOptionId;
  else delete raw.followUpOptionId;
  const selectedOptionId = text(raw.optionId, 100);
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
    } else if (!selectedOption && (mentalAct.kind === 'pursue' || mentalAct.kind === 'investigate')) {
      const proposal = sanitizeCharacterAgendaProposal({
        aim: mentalAct.goal,
        theme: mentalAct.kind === 'investigate' ? 'inquiry' : 'personal',
        importance: mentalAct.kind === 'investigate' ? 62 : 58,
        horizonMonths: 12,
        sourceMemoryHandles: raw.evidenceMemoryHandles,
        approach: {
          summary: mentalAct.strategy,
          ...(raw.experiment ? { probe: raw.experiment } : {}),
        },
      }, protocol.handles);
      if (proposal) raw.characterAgendaUpdate = { kind: 'create', proposal } satisfies CharacterAgendaUpdate;
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

async function requestModelDecision(
  endpoint: ResolvedModelEndpoint,
  context: DecisionRequestContext,
  protocol: DecisionModelRequestProtocol,
  correction?: { invalidContent: string; problem: string },
  conciseRetry = false,
): Promise<{ content: string; usage: TokenUsage }> {
  const { requestContext } = protocol;
  const messages: ModelMessage[] = [
    { role: 'system', content: buildDecisionSystemPrompt(protocol.characterAgendaProposal) },
    { role: 'user', content: JSON.stringify(requestContext) },
  ];
  const noteMessage = characterNoteMessage(characterNoteFromRequestContext(requestContext), 'next-decision');
  if (noteMessage) messages.push(noteMessage);
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    {
      role: 'user',
      content: [
        `上一个 mental act 协议无效：${correction.problem}。请只修正 JSON/句柄，不要把它理解成人物在世界中试错失败。`,
        `可用 firstStepHandle：${requestContext.availableSteps.map((step) => step.handle).join('、') || '无'}`,
        `可用 continuationHandle：${requestContext.continuations.map((step) => step.handle).join('、') || '无'}`,
      ].join('\n'),
    },
  );
  if (conciseRetry) messages.push({
    role: 'user',
    content: '上一轮只返回了内部推理，没有最终 JSON。不要展开长推理；直接输出一个 Mental Act JSON。',
  });
  const response = await requestModelText(endpoint, {
    messages,
    temperature: endpoint.temperature ?? (protocol.characterAgendaProposal ? 0.65 : 1),
    maxOutputTokens: decisionMaxOutputTokens(),
    jsonObject: true,
    jsonSchema: buildMentalActJsonSchema(protocol),
    timeoutMs: decisionTimeout(endpoint),
  });
  return { content: response.text, usage: response.usage };
}

function normalizeDecision(context: DecisionRequestContext, input: unknown): Decision | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const mentalAct = record(raw.mentalAct) as unknown as MentalAct | null;
  if (!mentalAct
    || mentalAct.version !== 'mental-act-v1'
    || !MENTAL_ACT_KINDS.has(mentalAct.kind)
    || !text(mentalAct.thoughtLine, 180)) return null;
  const reason = text(raw.reason) || mentalAct.strategy;
  const optionId = text(raw.optionId, 100);
  const followUpOptionId = text(raw.followUpOptionId, 100);
  const utterance = text(raw.utterance, 180);
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
  if (openConversation && (!utterance || !groundingSourceFactIds)) return null;
  if (!openConversation && Object.prototype.hasOwnProperty.call(raw, 'groundingSourceFactIds')) return null;
  const requiredOptions = context.options.filter((item) => item.semantics.obligation === 'required-response');
  const fulfillmentOptions = context.options.filter((item) => item.semantics.obligation === 'commitment-action');
  const optionAllowed = Boolean(option)
    && (!requiredOptions.length || requiredOptions.some((item) => item.id === optionId))
    && (requiredOptions.length > 0 || !fulfillmentOptions.length || fulfillmentOptions.some((item) => item.id === optionId));
  const validFollowUp = context.followUpOptions.some((item) => item.id === followUpOptionId);
  if (option?.requiresFollowUp && !validFollowUp) return null;
  if ((mentalAct.kind === 'continue' || mentalAct.kind === 'wait') && option) return null;
  const communication = option?.communicationKind !== undefined;
  if (mentalAct.kind === 'talk' && (!option || !communication)) return null;
  const activeIntentId = context.activeIntent?.id;
  if (!option) {
    if (requiredOptions.length || fulfillmentOptions.length || mentalAct.kind === 'talk') return null;
    return {
      kind: 'idle',
      reason,
      mentalAct,
      ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    };
  }
  if (!optionAllowed) return null;
  if (!activeIntentId) {
    return {
      kind: 'start',
      optionId,
      ...(option?.requiresFollowUp ? { followUpOptionId } : {}),
      reason,
      ...(utterance ? { utterance } : {}),
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
    ...(option.requiresFollowUp ? { followUpOptionId } : {}),
    reason,
    ...(utterance ? { utterance } : {}),
    ...(openConversation ? { groundingSourceFactIds } : {}),
    ...(characterAgendaProposal ? { characterAgendaProposal } : {}),
    ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    ...(communication ? {
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

interface DecisionResult {
  decision: Decision | null;
  usage: TokenUsage;
  providerRequests: number;
}

async function decideOne(context: DecisionRequestContext, endpoint: ResolvedModelEndpoint): Promise<DecisionResult> {
  const protocol = buildDecisionModelRequestProtocol(context);
  let correction: { invalidContent: string; problem: string } | undefined;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  let conciseRetry = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let completion: Awaited<ReturnType<typeof requestModelDecision>>;
    try {
      providerRequests += 1;
      completion = await requestModelDecision(endpoint, context, protocol, correction, conciseRetry);
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
      throw error;
    }
    usage = {
      inputTokens: usage.inputTokens + completion.usage.inputTokens,
      outputTokens: usage.outputTokens + completion.usage.outputTokens,
      ...((usage.cacheHitInputTokens !== undefined || completion.usage.cacheHitInputTokens !== undefined)
        ? { cacheHitInputTokens: (usage.cacheHitInputTokens ?? 0) + (completion.usage.cacheHitInputTokens ?? 0) }
        : {}),
      ...((usage.cacheMissInputTokens !== undefined || completion.usage.cacheMissInputTokens !== undefined)
        ? { cacheMissInputTokens: (usage.cacheMissInputTokens ?? 0) + (completion.usage.cacheMissInputTokens ?? 0) }
        : {}),
    };
    let parsed: unknown;
    try {
      parsed = parseJson(completion.content);
    } catch {
      correction = { invalidContent: completion.content, problem: '不是 JSON 对象' };
      continue;
    }
    const decision = normalizeDecisionModelOutput(context, parsed, protocol);
    if (decision) return { decision, usage, providerRequests };
    if (loadServerEnvValue('MODEL_DECISION_DEBUG') === '1') {
      console.warn(`模型端点 ${endpoint.id} 的决策未通过结构校验：${completion.content.slice(0, 500)}`);
    }
    correction = { invalidContent: completion.content, problem: 'Mental Act 缺少合法类型、引用了不存在的当前步骤/记忆句柄，或必须回应时没有选择当前步骤' };
  }
  return { decision: null, usage, providerRequests };
}

function decisionBatchMaxOutputTokens(agentCount: number): number {
  return Math.max(512, Math.min(12_000, decisionMaxOutputTokens() * Math.max(1, agentCount)));
}

/**
 * One provider request for the whole selected month. Handles remain scoped by
 * `agentHandle`; every returned decision is still expanded and validated
 * against exactly one private context before it can reach application code.
 */
async function decideBatch(
  contexts: DecisionRequestContext[],
  endpoint: ResolvedModelEndpoint,
): Promise<DecisionResult[]> {
  const protocols = contexts.map((context) => buildDecisionModelRequestProtocol(context));
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  let correction = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    providerRequests += 1;
    const response = await requestModelText(endpoint, {
      messages: [
        {
          role: 'system',
          content: [
            buildDecisionSystemPrompt(protocols.some((protocol) => protocol.characterAgendaProposal)),
            '这是同一个月内多个彼此独立的人物意识。agentHandle 只用于把输出送回对应人物，不是人物知道的名字。',
            '不得把一个 agent context 的私有记忆、知识、关系、步骤或句柄带进另一个 agent 的 mentalAct。',
            '严格输出一个 JSON：{"decisions":[{"agentHandle":"a1","decision":{单人 Mental Act 对象}}, ...]}。每个输入 agentHandle 必须且只能出现一次；可用 decision:null 表示不作模型决定。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            schemaVersion: 'monthly-agent-decisions-v1',
            agents: protocols.map((protocol, index) => ({
              agentHandle: `a${index + 1}`,
              context: protocol.requestContext,
            })),
          }),
        },
        {
          role: 'user',
          content: JSON.stringify({
            protocol: 'eland-character-note-v1',
            appliesTo: 'next-agent-decisions',
            notes: protocols.flatMap((protocol, index) => {
              const characterNote = characterNoteFromRequestContext(protocol.requestContext);
              return characterNote ? [{ agentHandle: `a${index + 1}`, characterNote }] : [];
            }),
            instruction: '每个 mental act 只使用同 agentHandle 的临场角色注记；示例不是事实，也不要照抄。',
          }),
        },
        ...(correction ? [{ role: 'user' as const, content: correction }] : []),
      ],
      temperature: endpoint.temperature ?? 0.65,
      maxOutputTokens: decisionBatchMaxOutputTokens(contexts.length),
      jsonObject: true,
      jsonSchema: buildMentalActBatchJsonSchema(protocols),
      timeoutMs: decisionTimeout(endpoint),
    });
    usage = {
      inputTokens: usage.inputTokens + response.usage.inputTokens,
      outputTokens: usage.outputTokens + response.usage.outputTokens,
      ...((usage.cacheHitInputTokens !== undefined || response.usage.cacheHitInputTokens !== undefined)
        ? { cacheHitInputTokens: (usage.cacheHitInputTokens ?? 0) + (response.usage.cacheHitInputTokens ?? 0) }
        : {}),
      ...((usage.cacheMissInputTokens !== undefined || response.usage.cacheMissInputTokens !== undefined)
        ? { cacheMissInputTokens: (usage.cacheMissInputTokens ?? 0) + (response.usage.cacheMissInputTokens ?? 0) }
        : {}),
    };
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = record(parseJson(response.text));
    } catch {
      parsed = null;
    }
    const rawDecisions = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
    const byHandle = new Map<string, unknown>();
    let duplicate = false;
    for (const item of rawDecisions) {
      const row = record(item);
      const handle = text(row?.agentHandle, 24);
      if (!row || !/^a[1-9]\d*$/u.test(handle) || byHandle.has(handle)) {
        duplicate = true;
        continue;
      }
      byHandle.set(handle, row.decision);
    }
    const decisions = contexts.map((context, index) => {
      const raw = byHandle.get(`a${index + 1}`);
      return raw === null ? null : normalizeDecisionModelOutput(
        context,
        raw,
        protocols[index],
      );
    });
    if (!duplicate && byHandle.size === contexts.length && decisions.some(Boolean)) {
      return decisions.map((decision, index) => ({
        decision,
        usage: index === 0 ? usage : { inputTokens: 0, outputTokens: 0 },
        providerRequests: index === 0 ? providerRequests : 0,
      }));
    }
    correction = '上一批输出缺少人物、重复了 agentHandle，或 Mental Act 使用了别人的句柄。请只修正协议并重新输出完整 decisions 数组；这不是人物在世界里的失败。';
  }
  return contexts.map((_, index) => ({
    decision: null,
    usage: index === 0 ? usage : { inputTokens: 0, outputTokens: 0 },
    providerRequests: index === 0 ? providerRequests : 0,
  }));
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

export async function handleDecide(payload: unknown, requestedEndpoint?: string): Promise<{ status: number; body: unknown }> {
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
    ? [await decideOne(contexts[0], endpoint)]
    : await decideBatch(contexts, endpoint);
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
      usage,
      providerRequests,
    },
  };
}
