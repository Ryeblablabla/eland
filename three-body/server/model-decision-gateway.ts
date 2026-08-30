import {
  type CharacterAgendaSummary,
  type DecisionRequestContext,
} from '../src/game/eland/application/model-decision/decision-context';
import {
  buildCharacterAgendaProbeCandidates,
  buildDecisionProbeHandleMap,
  type DecisionProbeHandleMap,
} from '../src/game/eland/application/model-decision/capability-handles';
import {
  buildCompactDecisionRequestContext,
  type CompactDecisionRequestContext,
} from '../src/game/eland/application/model-decision/compact-context';
import { validateActionOptionSemantics } from '../src/game/eland/domain/action-option-semantics';
import type {
  CharacterAgendaProbe,
  CharacterAgendaProposal,
  CharacterAgendaUpdate,
} from '../src/game/eland/domain/character-agenda';
import type { Decision, MemoryConsolidationUpdate, TokenUsage } from '../src/game/eland/simulation';
import { loadServerEnvValue } from './env';
import { ModelRequestError, requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ResolvedModelEndpoint } from './model-config';
import {
  CHARACTER_AGENDA_EXTENSION_V2,
  DECISION_SYSTEM_PROMPT_V2,
  MEMORY_CONSOLIDATION_EXTENSION_V2,
} from './agent-prompt-templates';

type PublicDecisionRequestContext = Omit<DecisionRequestContext, 'person' | 'options' | 'followUpOptions'> & {
  person: Omit<DecisionRequestContext['person'], 'characterAgenda' | 'memories'> & {
    characterAgenda: Array<Omit<CharacterAgendaSummary, 'id' | 'basisKey' | 'projectIds'>>;
    memories: Array<Omit<DecisionRequestContext['person']['memories'][number], 'id' | 'sourceEventIds'> & { handle?: string }>;
  };
  options: Array<
    Omit<DecisionRequestContext['options'][number], 'characterAgendaItemId' | 'projectId' | 'openConversationGrounding'>
    & { groundingFacts?: Array<{ handle: string; kind: string; summary: string }> }
  >;
  followUpOptions: Array<Omit<DecisionRequestContext['followUpOptions'][number], 'matchesOptionIds'>>;
};

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

function usesCompactDecisionContext(): boolean {
  return loadServerEnvValue('MODEL_DECISION_CONTEXT_MODE').trim().toLowerCase() !== 'full';
}

function usesCharacterAgendaProposal(): boolean {
  const configured = loadServerEnvValue('MODEL_CHARACTER_AGENDA_MODE').trim().toLowerCase();
  return configured !== 'off' && configured !== 'disabled' && configured !== 'none';
}

export function buildDecisionSystemPrompt(characterAgendaProposal = usesCharacterAgendaProposal()): string {
  return [
    DECISION_SYSTEM_PROMPT_V2,
    ...(characterAgendaProposal ? [CHARACTER_AGENDA_EXTENSION_V2] : []),
    MEMORY_CONSOLIDATION_EXTENSION_V2,
  ].join('\n');
}

export interface DecisionModelRequestProtocol {
  requestContext: (PublicDecisionRequestContext | CompactDecisionRequestContext) & {
    agendaProbeCandidates?: ReturnType<typeof buildCharacterAgendaProbeCandidates>;
  };
  handles: DecisionProbeHandleMap;
  compact: boolean;
  characterAgendaProposal: boolean;
  memoryConsolidation: boolean;
}

function withoutOpenConversationSourceIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutOpenConversationSourceIds) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'basisKey'
      && key !== 'sourceFactIds'
      && key !== 'sourceEventIds'
      && key !== 'openGroundingCompiled')
    .map(([key, item]) => [key, withoutOpenConversationSourceIds(item)])) as T;
}

function isModelVisibleDecisionOption(
  option: DecisionRequestContext['options'][number],
): boolean {
  return !(option.semantics.conversation?.turn === 'opening'
    && option.semantics.conversation.topic !== 'open');
}

export function buildDecisionModelRequestProtocol(
  context: DecisionRequestContext,
  options: { compact?: boolean; characterAgendaProposal?: boolean } = {},
): DecisionModelRequestProtocol {
  const characterAgendaProposal = options.characterAgendaProposal ?? usesCharacterAgendaProposal();
  // Proposal mode must use the request-scoped capability envelope. The full
  // legacy context contains stable runtime ids intended only for option choice.
  const compact = characterAgendaProposal || (options.compact ?? usesCompactDecisionContext());
  const handles = buildDecisionProbeHandleMap(context);
  const base = compact
    ? buildCompactDecisionRequestContext(context, handles)
    : {
        ...context,
        person: {
          ...context.person,
          memories: context.person.memories.map(({ id, sourceEventIds: _sources, ...memory }) => ({
            ...memory,
            ...(handles.memories.find((candidate) => candidate.itemId === id)?.handle
              ? { handle: handles.memories.find((candidate) => candidate.itemId === id)!.handle }
              : {}),
          })),
          characterAgenda: (context.person.characterAgenda ?? []).slice(0, 4)
            .map(({ id, basisKey, projectIds, ...item }) => item),
        },
        options: context.options
          .filter(isModelVisibleDecisionOption)
          .map(({ characterAgendaItemId, projectId, openConversationGrounding, ...option }) => ({
            ...option,
            ...(openConversationGrounding && option.speechAct
              ? { speechAct: withoutOpenConversationSourceIds(option.speechAct) }
              : {}),
            ...(openConversationGrounding ? {
              groundingFacts: handles.groundingFacts
                .filter((fact) => fact.optionId === option.id)
                .map(({ handle, kind, summary }) => ({ handle, kind, summary })),
            } : {}),
          })),
        followUpOptions: context.followUpOptions.map(({ matchesOptionIds, ...option }) => option),
      };
  return {
    requestContext: characterAgendaProposal
      ? { ...base, agendaProbeCandidates: buildCharacterAgendaProbeCandidates(context, handles) }
      : base,
    handles,
    compact,
    characterAgendaProposal,
    memoryConsolidation: handles.memories.length > 0,
  };
}

export function sanitizeMemoryConsolidation(
  input: unknown,
  handles: DecisionProbeHandleMap,
): MemoryConsolidationUpdate | undefined {
  const raw = record(input);
  const sourceHandles = Array.isArray(raw?.sourceHandles)
    ? [...new Set(raw.sourceHandles.map((value) => text(value, 24)).filter(Boolean))].slice(0, 6)
    : [];
  if (!raw || sourceHandles.length === 0) return undefined;
  const sourceItemIds = sourceHandles.map((handle) => handles.memories.find((item) => item.handle === handle)?.itemId);
  if (sourceItemIds.some((itemId) => !itemId)) return undefined;
  const gist = text(raw.gist, 260);
  if (!gist) return undefined;
  const topicKeys = Array.isArray(raw.topicKeys)
    ? [...new Set(raw.topicKeys.map((value) => text(value, 60)).filter(Boolean))].slice(0, 4)
    : [];
  return {
    sourceItemIds: sourceItemIds as string[],
    gist,
    topicKeys,
    unresolved: raw.unresolved === true,
    emotionalValence: typeof raw.emotionalValence === 'number' && Number.isFinite(raw.emotionalValence)
      ? Math.max(-1, Math.min(1, raw.emotionalValence))
      : 0,
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

export function expandDecisionModelOutput(
  context: DecisionRequestContext,
  input: unknown,
  protocol: Pick<DecisionModelRequestProtocol, 'requestContext' | 'handles' | 'compact' | 'characterAgendaProposal' | 'memoryConsolidation'>,
): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = { ...(input as Record<string, unknown>) };
  const requestedOption = Object.prototype.hasOwnProperty.call(raw, 'optionId');
  const requestedFollowUp = Object.prototype.hasOwnProperty.call(raw, 'followUpOptionId');
  const optionHandle = text(raw.optionId, 100);
  const followUpHandle = text(raw.followUpOptionId, 100);
  const exposedOptionIds = new Set(protocol.requestContext.options.map((option) => option.id));
  const exposedFollowUpIds = new Set(protocol.requestContext.followUpOptions.map((option) => option.id));
  if ((requestedOption && !exposedOptionIds.has(optionHandle))
    || (requestedFollowUp && !exposedFollowUpIds.has(followUpHandle))) return null;
  if (protocol.compact) {
    const rawKind = text(raw.kind, 100);
    if (requestedOption
      && rawKind !== 'start'
      && rawKind !== 'revise'
      && rawKind !== 'idle'
      && rawKind !== optionHandle) return null;
    const optionIndex = /^o([1-9]\d*)$/u.exec(optionHandle);
    const followUpIndex = /^f([1-9]\d*)$/u.exec(followUpHandle);
    const expandedOptionId = optionIndex
      ? context.options[Number(optionIndex[1]) - 1]?.id
      : undefined;
    const expandedFollowUpId = followUpIndex
      ? context.followUpOptions[Number(followUpIndex[1]) - 1]?.id
      : undefined;
    if (requestedOption && !expandedOptionId) return null;
    if (requestedFollowUp && !expandedFollowUpId) return null;
    if (expandedOptionId) {
      raw.optionId = expandedOptionId;
      if (raw.kind === optionHandle) raw.kind = expandedOptionId;
    }
    if (expandedFollowUpId) raw.followUpOptionId = expandedFollowUpId;
  }
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
  if (protocol.characterAgendaProposal) {
    const update = sanitizeCharacterAgendaUpdate(raw.characterAgendaUpdate, protocol.handles);
    if (update) raw.characterAgendaUpdate = update;
    else delete raw.characterAgendaUpdate;
    const proposal = sanitizeCharacterAgendaProposal(raw.characterAgendaProposal, protocol.handles);
    if (proposal) raw.characterAgendaProposal = proposal;
    else delete raw.characterAgendaProposal;
  } else {
    delete raw.characterAgendaUpdate;
    delete raw.characterAgendaProposal;
  }
  if (protocol.memoryConsolidation) {
    const consolidation = sanitizeMemoryConsolidation(raw.memoryConsolidation, protocol.handles);
    if (consolidation) raw.memoryConsolidation = consolidation;
    else delete raw.memoryConsolidation;
  } else delete raw.memoryConsolidation;
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
  if (correction) messages.push(
    { role: 'assistant', content: correction.invalidContent },
    {
      role: 'user',
      content: [
        `上一个决策无效：${correction.problem}。请重新输出合法 JSON。`,
        `合法 optionId 只有：${requestContext.options.map((option) => option.id).join('、') || '无'}`,
        `合法 followUpOptionId 只有：${requestContext.followUpOptions.map((option) => option.id).join('、') || '无'}`,
        ...(context.activeIntent ? [`当前 intentId 是：${context.activeIntent.id}`] : []),
      ].join('\n'),
    },
  );
  if (conciseRetry) messages.push({
    role: 'user',
    content: '上一轮只返回了内部推理，没有最终 JSON。不要展开长推理；直接比较合法选项并在 300 字以内输出一个最终 JSON 对象。',
  });
  const response = await requestModelText(endpoint, {
    messages,
    temperature: endpoint.temperature ?? (protocol.characterAgendaProposal ? 0.65 : 1),
    maxOutputTokens: decisionMaxOutputTokens(),
    jsonObject: true,
    timeoutMs: decisionTimeout(endpoint),
  });
  return { content: response.text, usage: response.usage };
}

function normalizeDecision(context: DecisionRequestContext, input: unknown): Decision | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const rawKind = text(raw.kind, 100);
  const reason = text(raw.reason) || '根据眼前处境重新安排';
  const optionId = text(raw.optionId, 100);
  const followUpOptionId = text(raw.followUpOptionId, 100);
  const intentId = text(raw.intentId, 100);
  const utterance = text(raw.utterance, 180);
  const characterAgendaProposal = record(raw.characterAgendaProposal)
    ? raw.characterAgendaProposal as unknown as CharacterAgendaProposal
    : undefined;
  const characterAgendaUpdate = record(raw.characterAgendaUpdate)
    ? raw.characterAgendaUpdate as unknown as CharacterAgendaUpdate
    : undefined;
  const memoryConsolidation = record(raw.memoryConsolidation)
    ? raw.memoryConsolidation as unknown as MemoryConsolidationUpdate
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
  // 选择仍可在缺少 utterance 时成立；真正执行说话时，台词旁车会单独
  // 请求表达模型。不要把用于解释选择的 reason 冒充人物实际说的话。
  const actualUtterance = utterance;
  const activeIntentId = context.activeIntent?.id;
  // 部分本地模型会把被选中的 optionId 放进 kind。只有它与当前合法
  // optionId 完全相等时才做无歧义归一化，不能由任意自然语言推断行动。
  const selectedLegalOption = optionAllowed && (
    rawKind === 'start'
    || rawKind === 'revise'
    || rawKind === optionId
  );
  // start/revise is only the envelope around a legal option choice. Whether
  // that choice starts the first Intent or revises the active one is an
  // authoritative local fact, so repair this common model shape error without
  // spending another request. The option handle itself is never inferred.
  const kind = selectedLegalOption
    ? activeIntentId ? 'revise' : 'start'
    : rawKind;
  const normalizedIntentId = kind === 'revise' && !intentId ? activeIntentId : intentId;
  if (kind === 'start' && !activeIntentId && optionAllowed) {
    return {
      kind,
      optionId,
      ...(option?.requiresFollowUp ? { followUpOptionId } : {}),
      reason,
      ...(actualUtterance ? { utterance: actualUtterance } : {}),
      ...(openConversation ? { groundingSourceFactIds } : {}),
      ...(characterAgendaProposal ? { characterAgendaProposal } : {}),
      ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
      ...(memoryConsolidation ? { memoryConsolidation } : {}),
    };
  }
  if (kind === 'revise' && normalizedIntentId === activeIntentId && optionAllowed && activeIntentId) {
    return {
      kind,
      intentId: activeIntentId,
      optionId,
      ...(option?.requiresFollowUp ? { followUpOptionId } : {}),
      reason,
      ...(actualUtterance ? { utterance: actualUtterance } : {}),
      ...(openConversation ? { groundingSourceFactIds } : {}),
      ...(characterAgendaProposal ? { characterAgendaProposal } : {}),
      ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
      ...(memoryConsolidation ? { memoryConsolidation } : {}),
    };
  }
  if (kind === 'idle' && !requiredOptions.length && !fulfillmentOptions.length) return {
    kind,
    reason,
    ...(characterAgendaUpdate ? { characterAgendaUpdate } : {}),
    ...(memoryConsolidation ? { memoryConsolidation } : {}),
  };
  return null;
}

export function normalizeDecisionModelOutput(
  context: DecisionRequestContext,
  input: unknown,
  protocol: Pick<DecisionModelRequestProtocol, 'requestContext' | 'handles' | 'compact' | 'characterAgendaProposal' | 'memoryConsolidation'>,
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
    correction = { invalidContent: completion.content, problem: '没有选择当前意图允许的合法 optionId，必须回应时选择了 idle，或对话缺少合法 followUpOptionId' };
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
            '不得把一个 agent context 的私有记忆、知识、关系、选项或句柄带进另一个 agent 的 decision。每个 decision 只能使用自己 context 内的句柄。',
            '严格输出一个 JSON：{"decisions":[{"agentHandle":"a1","decision":{单人决策对象}}, ...]}。每个输入 agentHandle 必须且只能出现一次；可用 decision:null 表示不作模型决定。',
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
        ...(correction ? [{ role: 'user' as const, content: correction }] : []),
      ],
      temperature: endpoint.temperature ?? 0.65,
      maxOutputTokens: decisionBatchMaxOutputTokens(contexts.length),
      jsonObject: true,
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
    correction = '上一批输出缺少人物、重复了 agentHandle，或 decision 没有通过各自合法选项校验。请重新输出完整 decisions 数组；不要解释，不要交换人物信息。';
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
