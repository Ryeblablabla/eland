import {
  type DecisionRequestContext,
} from '../src/game/eland/application/model-decision/decision-context';
import {
  buildDecisionProbeHandleMap,
  type DecisionProbeHandleMap,
} from '../src/game/eland/application/model-decision/capability-handles';
import {
  buildMindIntentionRequestContext,
  buildMentalActRequestContext,
  type MindIntentionDraft,
  type MindIntentionOrientation,
  type MindIntentionRequestContext,
  type MentalActRequestContext,
} from '../src/game/eland/application/model-decision/mental-act-context';
import { validateActionOptionSemantics } from '../src/game/eland/domain/action-option-semantics';
import { Material, MATERIAL_PALETTE, materialHas } from '../src/game/eland/domain/material';
import type {
  WorldAdjudicatedInteraction,
  WorldInteractionEffect,
  WorldRef,
} from '../src/game/eland/domain/action';
import { spokenTextSupportsMeaning } from '../src/game/eland/domain/spoken-meaning';
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
  const configured = Number(loadServerEnvValue('MODEL_DECISION_MAX_OUTPUT_TOKENS') || 600);
  return Number.isFinite(configured) ? Math.max(128, Math.min(2_000, Math.floor(configured))) : 600;
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
  orientation: MindIntentionOrientation;
  horizon: 'momentary' | 'ongoing';
  evidenceMemoryHandles: string[];
  relationshipAppraisal?: NonNullable<MentalAct['relationshipAppraisal']>;
}

interface ModelPlanOutput {
  steps: string[];
  disposition?: 'act' | 'continue' | 'pause' | 'abandon' | 'stay';
  firstStepHandle?: string;
  continuationHandle?: string;
  resumeIntentHandle?: string;
  abandonIntentHandle?: string;
  groundingFactHandles?: string[];
  experiment?: Record<string, unknown>;
  worldAction?: ModelWorldAction;
  feedback?: ModelPlanFeedback;
}

interface ModelWorldAction {
  description: string;
  targetHandles: string[];
  expectedResult?: string;
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
    handle: step.handle,
    action: readableAgentAction(step),
    priority: step.priority,
    purpose: step.purpose,
    target: record(step.target)?.name,
  }));
  return {
    schemaVersion: 'agent-plan-context-v1',
    intention: {
      utterance: intention.utterance,
      delivery: intention.delivery,
      goal: intention.goal,
      orientation: intention.orientation,
      horizon: intention.horizon,
    },
    mind: context.mind,
    current: context.current,
    recentDialogue: context.recentDialogue,
    visible: context.visible,
    availableSteps,
    actionSpace: context.actionSpace,
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
): MindIntentionOutput | undefined {
  const raw = record(input);
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
  if (!raw || !utterance || !goal || !delivery || !orientation || !horizon) return undefined;
  const evidenceMemoryHandles = Array.isArray(raw.evidenceMemoryHandles)
    ? [...new Set(raw.evidenceMemoryHandles.map((value) => text(value, 24)).filter(Boolean))]
      .filter((handle) => handles.memories.some((memory) => memory.handle === handle))
      .slice(0, 4)
    : [];
  const relationshipAppraisal = sanitizeMindRelationshipAppraisal(raw.relationshipAppraisal, handles);
  if (raw.relationshipAppraisal !== undefined && raw.relationshipAppraisal !== null && !relationshipAppraisal) {
    return undefined;
  }
  return {
    utterance,
    delivery,
    goal,
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
  return {
    version: 'mental-plan-translation-v1',
    steps,
    disposition,
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

const PURPOSES_BY_ORIENTATION: Record<MindIntentionOrientation, ReadonlySet<string>> = {
  social: new Set(['conversation', 'social-coordination', 'care', 'conflict', 'reproduction']),
  inquiry: new Set(['inquiry', 'conversation', 'movement']),
  survival: new Set(['homeostasis', 'safety', 'care', 'conflict', 'resource', 'project', 'spatial-comfort', 'movement', 'conversation']),
  construction: new Set(['project', 'production', 'resource', 'movement', 'conversation']),
  acquisition: new Set(['resource', 'movement', 'conversation']),
  exploration: new Set(['movement', 'inquiry', 'resource']),
  rest: new Set(),
};

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

function normalizedSemanticText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/木头|木料/gu, '木材')
    .replace(/藤蔓|绳索/gu, '纤维')
    .replace(/石头|石块|石子/gu, '石')
    .replace(/庇护所|窝头|小窝|顶棚|屋顶/gu, '住所')
    .replace(/遮风挡雨|挡风|遮雨|挡雨/gu, '遮蔽')
    .replace(/搭建|构建|建成|造出|盖成/gu, '建造')
    .replace(/[\s，。；：、？！“”‘’"'（）()《》〈〉—…·,.!?:;-]/gu, '');
}

function semanticBigrams(value: string): Set<string> {
  const characters = [...normalizedSemanticText(value)];
  if (characters.length < 2) return new Set(characters);
  return new Set(characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`));
}

function semanticOverlap(left: string, right: string): number {
  const leftGrams = semanticBigrams(left);
  const rightGrams = semanticBigrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let shared = 0;
  for (const gram of rightGrams) if (leftGrams.has(gram)) shared += 1;
  return shared / Math.min(leftGrams.size, rightGrams.size);
}

function selectableObjectNames(protocol: DecisionModelRequestProtocol): string[] {
  const visible = record(protocol.requestContext.visible);
  const objects = [
    ...protocol.requestContext.actionSpace.heldObjects,
    ...((visible?.surfaces as Array<Record<string, unknown>> | undefined) ?? []),
    ...((visible?.nearbyObjects as Array<Record<string, unknown>> | undefined) ?? []),
  ];
  return [...new Set(objects.map((item) => text(item.name, 80)).filter(Boolean))];
}

function physicalOptionSupportsIntention(
  option: DecisionRequestContext['options'][number],
  intention: MindIntentionOutput,
  protocol: DecisionModelRequestProtocol,
  selectedTargetName?: string,
): boolean {
  const intentionText = `${intention.goal}；${intention.utterance}`;
  const optionText = option.summary;
  if (/拆下|拆除|原位置会变空|取回/u.test(optionText)
    && !/拆下|拆除|拆开|取回|移除|拿下|拔下|撤掉/u.test(intentionText)) return false;
  if (option.executionProjectFunction === 'weather-shelter'
    && !/住所|庇护|遮蔽|挡风|遮雨|挡雨|屋顶|顶棚|窝/u.test(intention.utterance)) return false;

  const purpose = option.semantics.purpose;
  if (purpose === 'resource') {
    const requestsAcquisition = /找|寻找|取得|获取|拿到|捡|采集|收集|搬来|搬回|带回|缺少|还缺|需要.{0,8}(?:材料|资源|木材|纤维|石|食物|水)/u.test(intentionText);
    const genericResource = /材料|资源|东西/u.test(intentionText);
    const normalizedIntention = normalizedSemanticText(intentionText);
    const normalizedOption = normalizedSemanticText(optionText);
    const mentionedObjects = selectableObjectNames(protocol)
      .filter((name) => normalizedIntention.includes(normalizedSemanticText(name)));
    if (mentionedObjects.length) {
      const selectedNames = mentionedObjects.filter((name) => normalizedOption.includes(normalizedSemanticText(name)));
      if (!selectedNames.length) return false;
      const treatsNamedMaterialAsAlreadyHeld = /手里|手中|现有|已有|拿着|持有/u.test(intentionText);
      return !treatsNamedMaterialAsAlreadyHeld || requestsAcquisition;
    }
    return requestsAcquisition || genericResource || semanticOverlap(intentionText, optionText) >= 0.08;
  }
  if (purpose === 'movement') {
    return /走|前往|过去|回到|离开|靠近|漫游|探索|寻找同伴|换个地方/u.test(intentionText);
  }
  if (purpose === 'inquiry') {
    if (!/看|观察|确认|验证|弄清|比较|检查|试|能不能|是否|怎样|为什么/u.test(intentionText)) return false;
    if (!selectedTargetName) return true;
    const normalizedIntention = normalizedSemanticText(intentionText);
    const normalizedTarget = normalizedSemanticText(selectedTargetName);
    const mentionedObjects = selectableObjectNames(protocol)
      .filter((name) => normalizedIntention.includes(normalizedSemanticText(name)));
    if (mentionedObjects.length) {
      return mentionedObjects.some((name) => normalizedSemanticText(name) === normalizedTarget);
    }
    return normalizedIntention.includes(normalizedTarget)
      || /周围|环境|陌生|某个|任何|眼前有什么|观察四周|看看四周/u.test(intentionText);
  }
  if (purpose === 'project') {
    return /建造|搭|盖|修|完成|推进|安装|围|铺|夯|架|庇护|住所|项目/u.test(normalizedSemanticText(intentionText))
      || semanticOverlap(intentionText, optionText) >= 0.08;
  }
  if (purpose === 'production') {
    return /加工|制作|处理|组合|结合|编|烧|冶|炼|压|分离|制造/u.test(intentionText)
      && semanticOverlap(intentionText, optionText) >= 0.06;
  }
  if (purpose === 'conversation' || purpose === 'social-coordination') {
    return /说|问|告诉|交谈|聊|回应|商量|请求|提议|听|愿不愿|能否/u.test(intentionText);
  }
  if (purpose === 'conflict') {
    return /攻击|打|伤害|施力|推|抢|强取|偷|盗|约束|捆|绑|制服|抵抗|冲突|复仇|威胁/u.test(intentionText);
  }
  return true;
}

function experimentSupportsIntention(
  protocol: DecisionModelRequestProtocol,
  intention: MindIntentionOutput,
  experiment: Record<string, unknown>,
): boolean {
  const kind = text(experiment.kind, 24);
  if (kind === 'move') return true;
  const handles = [
    experiment.targetHandle,
    experiment.inputHandle,
    experiment.toolHandle,
    ...(Array.isArray(experiment.stackHandles) ? experiment.stackHandles : []),
  ].map((value) => text(value, 24)).filter(Boolean);
  const selectableObjects = [
    ...protocol.requestContext.actionSpace.heldObjects,
    ...((record(protocol.requestContext.visible)?.surfaces as Array<Record<string, unknown>> | undefined) ?? []),
    ...((record(protocol.requestContext.visible)?.nearbyObjects as Array<Record<string, unknown>> | undefined) ?? []),
  ];
  const nameByHandle = new Map(selectableObjects.flatMap((item) => {
    const handle = text(item.ref, 24);
    const name = text(item.name, 80);
    return handle && name ? [[handle, name] as const] : [];
  }));
  const allNames = [...new Set(nameByHandle.values())];
  const intentionText = normalizedSemanticText(`${intention.goal}；${intention.utterance}`);
  const mentionedNames = allNames.filter((name) => intentionText.includes(normalizedSemanticText(name)));
  if (!mentionedNames.length) return true;
  const selectedNames = handles.map((handle) => nameByHandle.get(handle)).filter((name): name is string => Boolean(name));
  return mentionedNames.some((name) => selectedNames.includes(name));
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
  return { kind: 'container', containerId: visible.containerId };
}

function sanitizeWorldAction(input: unknown, protocol: DecisionModelRequestProtocol): ModelWorldAction | undefined {
  const raw = record(input);
  const description = text(raw?.description, 240);
  const expectedResult = text(raw?.expectedResult, 180);
  if (!raw || !description || !Array.isArray(raw.targetHandles) || raw.targetHandles.length > 8) return undefined;
  const targetHandles = raw.targetHandles.map((value) => text(value, 24));
  if (targetHandles.some((handle) => !handle) || new Set(targetHandles).size !== targetHandles.length) return undefined;
  const exposed = new Set(exposedWorldTargets(protocol).map((item) => text(item.ref, 24)));
  if (targetHandles.some((handle) => !exposed.has(handle) || !worldRefForHandle(protocol.handles, handle))) return undefined;
  return {
    description,
    targetHandles,
    ...(expectedResult ? { expectedResult } : {}),
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

function worldActionSupportsIntention(
  protocol: DecisionModelRequestProtocol,
  intention: MindIntentionOutput,
  worldAction: ModelWorldAction,
): boolean {
  const rows = exposedWorldTargets(protocol);
  const names = new Map(rows.flatMap((item) => {
    const handle = text(item.ref, 24);
    const name = text(item.name, 80);
    return handle && name ? [[handle, name] as const] : [];
  }));
  const intentionText = normalizedSemanticText(`${intention.goal}；${intention.utterance}`);
  const actionText = normalizedSemanticText(worldAction.description);
  const matchedNames = [...new Set(names.values())]
    .map((name) => ({ name, normalized: normalizedSemanticText(name) }))
    .filter(({ normalized }) => normalized && actionText.includes(normalized));
  // Prefer the most specific visible name. “锡矿石” contains the generic
  // name “石”; mentioning the former must not look like an unselected second
  // object merely because both names are present in the scene.
  const actionNamedObjects = matchedNames
    .filter((candidate) => !matchedNames.some((other) => (
      other.normalized.length > candidate.normalized.length
        && other.normalized.includes(candidate.normalized)
    )))
    .map((candidate) => candidate.name);
  const selectedNames = worldAction.targetHandles
    .map((handle) => names.get(handle))
    .filter((name): name is string => Boolean(name));
  if (actionNamedObjects.some((name) => !selectedNames.includes(name))) return false;
  return actionNamedObjects.length > 0
    || selectedNames.some((name) => intentionText.includes(normalizedSemanticText(name)))
    || semanticOverlap(`${intention.goal}；${intention.utterance}`, worldAction.description) >= 0.06;
}

function planSupportsIntention(
  context: DecisionRequestContext,
  intention: MindIntentionOutput,
  plan: ModelPlanOutput,
  protocol: DecisionModelRequestProtocol,
): boolean {
  if (plan.disposition !== 'act') {
    if (plan.disposition === 'abandon' && plan.abandonIntentHandle) {
      const abandoned = selectedSuspendedIntentForHandle(context, plan.abandonIntentHandle, protocol);
      return !plan.firstStepHandle && !plan.resumeIntentHandle && !plan.experiment && !plan.worldAction
        && Boolean(abandoned)
        && semanticOverlap(
          `${intention.goal}；${intention.utterance}`,
          `${abandoned?.summary ?? ''}；${abandoned?.plan?.steps.join('；') ?? ''}`,
        ) >= 0.04;
    }
    return !plan.firstStepHandle && !plan.resumeIntentHandle && !plan.abandonIntentHandle
      && !plan.experiment && !plan.worldAction;
  }
  if (plan.worldAction) return worldActionSupportsIntention(protocol, intention, plan.worldAction);
  if (intention.orientation === 'rest') return false;
  const suspendedIntent = selectedSuspendedIntentForHandle(context, plan.resumeIntentHandle, protocol);
  if (suspendedIntent) {
    return semanticOverlap(
      `${intention.goal}；${intention.utterance}`,
      `${suspendedIntent.summary}；${suspendedIntent.plan?.steps.join('；') ?? ''}`,
    ) >= 0.04;
  }
  const option = selectedOptionForPlan(context, plan);
  if (option) {
    if (!PURPOSES_BY_ORIENTATION[intention.orientation].has(option.semantics.purpose)) return false;
    const selectedStep = protocol.requestContext.availableSteps.find((step) => step.handle === plan.firstStepHandle);
    const selectedTargetName = text(record(selectedStep?.target)?.name, 80);
    return !option.communicationMeaning
      ? physicalOptionSupportsIntention(option, intention, protocol, selectedTargetName)
      : spokenTextSupportsMeaning(intention.utterance, option.communicationMeaning)
        && physicalOptionSupportsIntention(option, intention, protocol, selectedTargetName);
  }
  const probeKind = text(plan.experiment?.kind, 24);
  if (!probeKind) return false;
  if (!experimentSupportsIntention(protocol, intention, plan.experiment!)) return false;
  if (intention.orientation === 'inquiry') return true;
  if (intention.orientation === 'construction') return ['observe', 'combine', 'expose', 'exert'].includes(probeKind);
  if (intention.orientation === 'exploration') return probeKind === 'observe' || probeKind === 'move';
  if (intention.orientation === 'survival') return probeKind === 'observe' || probeKind === 'move';
  return false;
}

function sanitizeModelPlan(
  input: unknown,
  protocol: DecisionModelRequestProtocol,
  readableAction = false,
): ModelPlanOutput | undefined {
  const raw = record(input);
  if (!raw || !Array.isArray(raw.steps)) return undefined;
  const steps = raw.steps.map((value) => text(value, 240)).filter(Boolean);
  if (!steps.length || steps.length !== raw.steps.length) return undefined;
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
  const effectiveFirstStepHandle = adjudicatedWorldAction ? '' : firstStepHandle;
  const effectiveExperiment = adjudicatedWorldAction ? undefined : validExperiment;
  const actionCount = Number(Boolean(effectiveFirstStepHandle))
    + Number(Boolean(resumeIntentHandle))
    + Number(Boolean(effectiveExperiment))
    + Number(Boolean(adjudicatedWorldAction));
  const hasAction = actionCount === 1;
  if (actionCount > 1) return undefined;
  if (resumeIntentHandle && continuationHandle) return undefined;
  if (abandonIntentHandle && (hasAction || continuationHandle || disposition !== 'abandon')) return undefined;
  if (disposition === 'act' && !hasAction) return undefined;
  if (disposition && disposition !== 'act' && hasAction) return undefined;
  return {
    steps,
    ...(disposition ? { disposition } : {}),
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
  const kind = resumedIntent || plan?.disposition === 'continue'
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
  const strategy = selectedStep
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
    goal: intention.goal,
    orientation: intention.orientation,
    horizon: intention.horizon,
    strategy,
    assumptions: [],
    ...(plan ? {
      plan: {
        version: 'mental-plan-translation-v1',
        steps: [...plan.steps],
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
  if (raw.relationshipAppraisal !== undefined && raw.relationshipAppraisal !== null && !relationshipAppraisal) {
    return undefined;
  }
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
  const continuationIndex = /^f([1-9]\d*)$/u.exec(continuationHandle);
  const optionId = optionIndex ? context.options[Number(optionIndex[1]) - 1]?.id : undefined;
  const followUpOptionId = continuationIndex
    ? context.followUpOptions[Number(continuationIndex[1]) - 1]?.id
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
        `firstStepHandle 必须引用以下稳定 handle 之一：${(context.availableSteps as Array<{ handle: string }>).map((step) => step.handle).join('、') || '无'}`,
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
    jsonSchema: buildWorldResolutionJsonSchema(protocol),
    timeoutMs: decisionTimeout(endpoint),
  });
  return { content: response.text, usage: response.usage };
}

async function resolveWorldAction(
  endpoint: ResolvedModelEndpoint,
  protocol: DecisionModelRequestProtocol,
  worldAction: ModelWorldAction | undefined,
): Promise<{ resolution?: WorldAdjudicationResolution; usage: TokenUsage; providerRequests: number }> {
  if (!worldAction) return {
    usage: { inputTokens: 0, outputTokens: 0 },
    providerRequests: 0,
  };
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  let correction: { invalidContent: string; problem: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    providerRequests += 1;
    const response = await requestWorldResolution(endpoint, protocol, worldAction, correction);
    usage = addUsage(usage, response.usage);
    let parsed: unknown;
    try {
      parsed = parseJson(response.content);
    } catch {
      correction = { invalidContent: response.content, problem: '不是 JSON 对象' };
      continue;
    }
    const resolution = sanitizePlanAgentWorldVerdict(parsed, worldAction, protocol);
    if (resolution) return { resolution, usage, providerRequests };
    correction = {
      invalidContent: response.content,
      problem: '结果缺少合法的来源、对象绑定或可执行世界变化',
    };
  }
  return { usage, providerRequests };
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function sameWorldRef(left: WorldRef, right: WorldRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function planAgentAuthorsAnotherPerson(
  protocol: DecisionModelRequestProtocol,
  worldAction: ModelWorldAction,
  result: string,
): boolean {
  const combined = `${worldAction.description}；${result}`;
  const visible = record(protocol.requestContext.visible);
  const otherNames = ((visible?.nearbyObjects as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((person) => text(person.kind, 24) === '人物')
    .map((person) => text(person.name, 80))
    .filter(Boolean);
  const voluntaryAction = /回答|回应|说出|告诉|表示|补充|提出|决定|同意|拒绝|点头|摇头|愿意|走来|过来|拿起|捡起|敲击|刮削|整理|协作|帮助/u;
  if (otherNames.some((name) => combined.includes(name) && voluntaryAction.test(combined))) return true;
  const targetsAnotherPerson = worldAction.targetHandles.some((handle) => {
    const visible = protocol.handles.visible.find((item) => item.handle === handle);
    return visible?.kind === 'person' && visible.personId !== protocol.requestContext.person.id;
  });
  return targetsAnotherPerson
    && /两人|双方|他们|对方/u.test(combined)
    && /回答|回应|同意|拒绝|点头|愿意|交流|交谈|商量|走来|过来/u.test(combined);
}

function completedWorldResultNeedsFeedback(worldAction: ModelWorldAction, result: string): boolean {
  return Boolean(worldAction.expectedResult)
    && /未能|没能|没有(?:成功|形成|达到|出现|做成)|无法|失败|未达/u.test(result);
}

function containsPlanProtocolLeak(value: string): boolean {
  return /(?:^|[^a-z0-9])(?:h|d|v|p|a|c)\d+\b|句柄|availableActions|worldAction|targetHandles|stateKey|stateValue|replace-voxel|move-self|\beffects\b|\bexpose\b/u.test(value);
}

function completedWorldEffectsMatchClaim(
  protocol: DecisionModelRequestProtocol,
  worldAction: ModelWorldAction,
  result: string,
  effects: readonly WorldInteractionEffect[],
): boolean {
  const combined = `${worldAction.description}；${result}`;
  const exposed = new Map(exposedWorldTargets(protocol).map((item) => [text(item.ref, 24), item]));
  const actorId = text(protocol.requestContext.person.id, 120);
  const refsForNamedTarget = (pattern: RegExp): WorldRef[] => worldAction.targetHandles.flatMap((handle) => {
    const name = text(exposed.get(handle)?.name, 80);
    const ref = worldRefForHandle(protocol.handles, handle, actorId);
    return name && pattern.test(name) && ref ? [ref] : [];
  });
  const seedRefs = refsForNamedTarget(/种子/u);
  if (seedRefs.length && /播种|播入|种进|种下|埋入|埋下/u.test(combined)) {
    const consumedSeed = effects.some((effect) => effect.kind === 'consume'
      && seedRefs.some((seed) => sameWorldRef(seed, effect.target)));
    const plantedSprout = effects.some((effect) => effect.kind === 'replace-voxel'
      && effect.materialId === Material.CropSprout);
    if (!consumedSeed || !plantedSprout) return false;
  }
  if (/走向|走到|走近|抵达|来到|靠近/u.test(worldAction.description)
    && !effects.some((effect) => effect.kind === 'move-self')) return false;
  // 声称"搭/垒/捆/架/棚/组装"且真实消耗了材料时，材料必须被绑成持久实体
  // （assemble/modify-structure）或落成真实体素（replace-voxel）；只用
  // world-state 或只搬动材料的"结构"对世界不存在，必须重述为真实成型。
  const consumedMaterials = effects.some((effect) => effect.kind === 'consume');
  if (consumedMaterials && /搭|垒|捆|架|棚|组装|拼接|捏成|塑成/u.test(combined)
    && !effects.some((effect) => effect.kind === 'assemble'
      || effect.kind === 'modify-structure'
      || effect.kind === 'replace-voxel')) return false;
  if (/饮用|饮水|喝水|喝下|喝了/u.test(combined)) {
    const replenishedHydration = effects.some((effect) => effect.kind === 'body'
      && effect.field === 'hydration' && effect.delta > 0);
    const waterRefs = refsForNamedTarget(/水/u);
    const destroyedWaterVoxel = effects.some((effect) => effect.kind === 'consume'
      && effect.target.kind === 'voxel'
      && waterRefs.some((water) => sameWorldRef(water, effect.target)));
    if (!replenishedHydration || destroyedWaterVoxel) return false;
  }
  if (/制成|做成|削成|打磨成/u.test(result) && /工具/u.test(result)) {
    const madeTool = effects.some((effect) => effect.kind === 'produce'
      && materialHas(effect.materialId, 'tool'));
    if (!madeTool) return false;
  }
  if (/搬.{0,16}(?:到|至)|移到|移动到|移动至|放(?:到|在)|摆到|堆到/u.test(result)
    && !effects.some((effect) => effect.kind === 'relocate')) return false;
  if (/翻松|拍实|压实|整理出.{0,8}土垄|形成.{0,8}土垄/u.test(result)
    && !effects.some((effect) => effect.kind === 'replace-voxel')) return false;
  if (/建成|搭成|砌成|形成.{0,8}(?:墙|棚|屋顶|结构)|改变.{0,8}(?:空间|遮蔽)/u.test(result)) {
    const materializedConstruction = effects.some((effect) => effect.kind === 'replace-voxel'
      && materialHas(effect.materialId, 'building'));
    if (!materializedConstruction) return false;
  }
  return true;
}

/** Converts an independent world-semantics verdict into server-owned refs and a bounded mutation IR. */
export function sanitizePlanAgentWorldVerdict(
  input: unknown,
  worldActionInput: unknown,
  protocol: DecisionModelRequestProtocol,
): WorldAdjudicationResolution | undefined {
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
  if (!worldAction || !raw || !status || !result || !rawEffects || rawEffects.length > 8) return undefined;
  if (status === 'blocked' && rawEffects.length) return undefined;
  const feedbackRaw = record(raw.feedback);
  const feedbackCorrection = text(feedbackRaw?.correction, 240);
  const feedbackAdjustment = text(feedbackRaw?.adjustment, 240);
  const protocolFacingProse = [
    worldAction.description,
    worldAction.expectedResult ?? '',
    result,
    feedbackCorrection,
    feedbackAdjustment,
    ...rawEffects.flatMap((effect) => {
      const parsed = record(effect);
      return [text(parsed?.summary, 240), text(parsed?.stateValue, 160)];
    }),
  ].join('；');
  if (containsPlanProtocolLeak(protocolFacingProse)) return undefined;
  if (status !== 'completed' && (!feedbackCorrection || !feedbackAdjustment)) return undefined;
  if (status === 'completed' && completedWorldResultNeedsFeedback(worldAction, result)
    && (!feedbackCorrection || !feedbackAdjustment)) return undefined;
  if (planAgentAuthorsAnotherPerson(protocol, worldAction, result)) return undefined;
  const actorId = text(protocol.requestContext.person.id, 120);
  const requestedHandles = new Set(worldAction.targetHandles);
  const targets = worldAction.targetHandles.map((handle) => worldRefForHandle(protocol.handles, handle, actorId));
  if (targets.some((target) => !target)) return undefined;
  const materialByKey = new Map(MATERIAL_PALETTE.map((material) => [material.key, material]));
  const effects: WorldInteractionEffect[] = [];
  for (const value of rawEffects) {
    const effect = record(value);
    const kind = text(effect?.kind, 32);
    if (!effect) return undefined;
    if (kind === 'knowledge') {
      const summary = text(effect.summary, 240);
      if (!summary) return undefined;
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
      if (!summary || !target || !stateKey || !stateValue) return undefined;
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
        || !['inventory-stack', 'drop', 'voxel'].includes(target.kind)) return undefined;
      effects.push({ kind, target, quantity });
      continue;
    }
    if (kind === 'produce') {
      const material = materialByKey.get(text(effect.materialKey, 80));
      const quantity = boundedInteger(effect.quantity, 1, 8);
      const destination = effect.destination === 'inventory' || effect.destination === 'ground'
        ? effect.destination
        : undefined;
      if (!material || material.id === 0 || quantity === undefined || !destination) return undefined;
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
        || destination?.kind !== 'voxel' || quantity === undefined) return undefined;
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
      if (!target || target.kind !== 'voxel') return undefined;
      if (kind === 'move-self') effects.push({ kind, target });
      else {
        const material = materialByKey.get(text(effect.materialKey, 80));
        if (!material || material.id === 0) return undefined;
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
      if (!target || target.kind !== 'voxel') return undefined;
      if (kind === 'assemble' && (!arrangement || !summary)) return undefined;
      effects.push({
        kind,
        target,
        ...(arrangement ? { arrangement } : {}),
        ...(summary ? { summary } : {}),
      } as WorldInteractionEffect);
      continue;
    }
    if (kind === 'bond-animal') {
      const targetHandle = text(effect.targetHandle, 24);
      const target = requestedHandles.has(targetHandle)
        ? worldRefForHandle(protocol.handles, targetHandle, actorId)
        : undefined;
      const summary = text(effect.summary, 160);
      if (!target || target.kind !== 'animal' || !summary) return undefined;
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
      if ((targetHandle !== 'self' && target?.kind !== 'person') || !field || delta === undefined) return undefined;
      effects.push({ kind, ...(target?.kind === 'person' ? { target } : {}), field, delta });
      continue;
    }
    return undefined;
  }
  // A semantic resolver may describe a transformation, but it cannot summon
  // authoritative material.  Every produced lot must consume a named input in
  // the same local action; known recipe executors remain the richer path.
  if (effects.some((effect) => effect.kind === 'produce')
    && !effects.some((effect) => effect.kind === 'consume')) return undefined;
  const hasPersistentEffect = effects.some((effect) => (
    effect.kind === 'world-state'
      || effect.kind === 'replace-voxel'
      || effect.kind === 'produce'
      || effect.kind === 'consume'
      || effect.kind === 'relocate'
      || effect.kind === 'assemble'
      || effect.kind === 'modify-structure'
  ));
  if (status === 'completed' && !hasPersistentEffect
    && /形成|留下|变得|搭成|建成|压实|摆成|固定|放置|堆叠/u.test(result)) return undefined;
  if (status === 'completed' && !completedWorldEffectsMatchClaim(protocol, worldAction, result, effects)) {
    return undefined;
  }
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
      ...(option?.requiresFollowUp ? { followUpOptionId } : {}),
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
    ...(option.requiresFollowUp ? { followUpOptionId } : {}),
    reason,
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
  const plan = sanitizeModelPlan(planInput, protocol);
  if (!plan) return null;
  const planAligned = planSupportsIntention(context, intention, plan, protocol);
  const effectiveWorldResolution = planAligned ? worldResolution : undefined;
  const alignedPlan = planAligned
    ? plan
    : {
        steps: [`当前没有与“${intention.goal}”直接一致的执行入口，先保留这个意图`],
        disposition: 'stay' as const,
      };
  const executionPlan = alignedPlan.worldAction && !effectiveWorldResolution?.probe
    ? {
        steps: [effectiveWorldResolution?.feedback || 'Plan Agent 没有返回可执行裁决，当前未知交互没有发生'],
        disposition: 'stay' as const,
      }
    : alignedPlan;
  const decision = normalizeDecisionModelOutput(
    context,
    stagedDecisionOutput(
      intention,
      executionPlan,
      protocol,
      context,
      alignedPlan.worldAction && !effectiveWorldResolution?.probe ? effectiveWorldResolution?.feedback : undefined,
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

interface DecisionResult {
  decision: Decision | null;
  usage: TokenUsage;
  providerRequests: number;
}

interface MindResult {
  intention?: MindIntentionOutput;
  usage: TokenUsage;
  providerRequests: number;
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
      throw error;
    }
    usage = addUsage(usage, completion.usage);
    let parsed: unknown;
    try {
      parsed = parseJson(completion.content);
    } catch {
      mindCorrection = { invalidContent: completion.content, problem: '不是 JSON 对象' };
      continue;
    }
    intention = sanitizeMindIntention(parsed, protocol.handles);
    if (intention) break;
    mindCorrection = { invalidContent: completion.content, problem: '缺少合法意图、原话或本人记忆句柄' };
  }
  return { intention, usage, providerRequests };
}

async function decideOne(context: DecisionRequestContext, endpoint: ResolvedModelEndpoint): Promise<DecisionResult> {
  const protocol = buildDecisionModelRequestProtocol(context);
  const mind = await decideMind(protocol, endpoint);
  let usage = mind.usage;
  let providerRequests = mind.providerRequests;
  if (!mind.intention) return { decision: null, usage, providerRequests };
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
    const plan = sanitizeModelPlan(parsed, protocol);
    if (!plan) {
      correction = { invalidContent: completion.content, problem: '缺少合法的简短计划或行动引用' };
      continue;
    }
    if (!planSupportsIntention(context, mind.intention, plan, protocol)) {
      correction = {
        invalidContent: completion.content,
        problem: '所选具体行动没有推进冻结的 intention，或替换了 intention 明确指定的材料。若固定入口能表达原意，请用对应 ref；否则用 worldAction 原样提交具体未知交互，或真实选择 stay',
      };
      continue;
    }
    const world = await resolveWorldAction(endpoint, protocol, plan.worldAction);
    usage = addUsage(usage, world.usage);
    providerRequests += world.providerRequests;
    if (plan.worldAction && !world.resolution) {
      return { decision: null, usage, providerRequests };
    }
    const decision = normalizeMindPlanModelOutput(
      context,
      mind.intention,
      plan,
      protocol,
      world.resolution,
    );
    if (decision) {
      return {
        decision,
        usage,
        providerRequests,
      };
    }
    correction = { invalidContent: completion.content, problem: '所选行动不能由当前世界执行' };
  }
  if (loadServerEnvValue('MODEL_DECISION_DEBUG') === '1') {
    console.warn(`模型端点 ${endpoint.id} 的 Mind → Plan 没有通过 Execution 接口校验`);
  }
  return {
    decision: null,
    usage,
    providerRequests,
  };
}

/** Mind and Plan Agent requests are both person-isolated; one malformed plan cannot erase another person's turn. */
async function decideBatch(
  contexts: DecisionRequestContext[],
  endpoint: ResolvedModelEndpoint,
): Promise<DecisionResult[]> {
  const protocols = contexts.map((context) => buildDecisionModelRequestProtocol(context));
  const mindResults: MindResult[] = [];
  for (const protocol of protocols) {
    mindResults.push(await decideMind(protocol, endpoint));
  }
  const intentions = mindResults.map((result) => result.intention);
  let planUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let planProviderRequests = 0;
  const plans: Array<ModelPlanOutput | undefined> = Array.from({ length: contexts.length });
  const worldResolutions: Array<WorldAdjudicationResolution | undefined> = Array.from({ length: contexts.length });
  for (let index = 0; index < contexts.length; index += 1) {
    const intention = intentions[index];
    if (!intention) continue;
    let correction: { invalidContent: string; problem: string } | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await requestModelPlan(endpoint, protocols[index], intention, correction);
      planUsage = addUsage(planUsage, response.usage);
      planProviderRequests += 1;
      let parsed: unknown;
      try {
        parsed = parseJson(response.content);
      } catch {
        correction = { invalidContent: response.content, problem: '不是 JSON 对象' };
        continue;
      }
      const candidate = sanitizeModelPlan(parsed, protocols[index]);
      if (candidate && planSupportsIntention(contexts[index], intention, candidate, protocols[index])) {
        const world = await resolveWorldAction(endpoint, protocols[index], candidate.worldAction);
        planUsage = addUsage(planUsage, world.usage);
        planProviderRequests += world.providerRequests;
        if (candidate.worldAction && !world.resolution) break;
        if (loadServerEnvValue('MODEL_DECISION_DEBUG') === '1') {
          console.warn(`Plan Agent 接受 a${index + 1}: ${JSON.stringify(candidate).slice(0, 3_000)}`);
        }
        plans[index] = candidate;
        worldResolutions[index] = world.resolution;
        break;
      }
      if (loadServerEnvValue('MODEL_DECISION_DEBUG') === '1') {
        console.warn(`Plan Agent 输出未通过 ${candidate ? '意图一致性' : '协议'} a${index + 1}: ${response.content.slice(0, 3_000)}`);
      }
      correction = {
        invalidContent: response.content,
        problem: candidate
          ? '所选具体行动没有推进冻结的 intention，或替换了 intention 明确指定的材料'
          : 'Plan、worldAction 或失败 feedback 不符合协议',
      };
    }
  }
  const decisions = contexts.map((context, index) => {
    const intention = intentions[index];
    if (!intention || !plans[index]) return null;
    return normalizeMindPlanModelOutput(context, intention, plans[index], protocols[index], worldResolutions[index]);
  });
  const mindUsage = mindResults.reduce(
    (sum, result) => addUsage(sum, result.usage),
    { inputTokens: 0, outputTokens: 0 } as TokenUsage,
  );
  const usage = addUsage(mindUsage, planUsage);
  const providerRequests = mindResults.reduce((sum, result) => sum + result.providerRequests, 0)
    + planProviderRequests;
  return decisions.map((decision, index) => ({
    decision,
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
