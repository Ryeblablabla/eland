import { buildPersonSoul } from '../src/game/eland/domain/person-soul';
import type { EnvironmentFact, SimulationState, WorldEvent } from '../src/game/eland/simulation';
import {
  acceptProposedNewbornGivenName,
  type NamingIdentity,
  type NamingTradition,
} from '../src/game/eland/naming';
import { loadServerEnvValue } from './env';
import { requestModelText } from './model-client';
import { resolveModelEndpoint, type ResolvedModelEndpoint } from './model-config';

export interface NewbornNamingContext {
  childId: string;
  fallbackName: string;
  sex: 'female' | 'male';
  familyName: string;
  namingTradition: NamingTradition;
  parents: Array<{
    id: string;
    name: string;
    role: 'mother' | 'father' | 'parent';
    innerVoice: string;
    namingAttention: string;
    namingTension: string;
    recentMemories: Array<{ summary: string; sourceEventIds: string[] }>;
  }>;
  circumstances: {
    atMonth: number;
    epoch: SimulationState['civilization']['epoch'];
    climate: SimulationState['civilization']['climate'];
    weather: SimulationState['civilization']['weather'];
  };
}

export interface NewbornNameProposal {
  childId: string;
  givenName: string;
  reason: string;
}

export interface NewbornNamingMetadata {
  endpointId: string;
  protocol: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface NewbornNamingResult {
  renamed: Array<{ childId: string; fallbackName: string; name: string; reason: string }>;
  rejectedChildIds: string[];
  generationErrors: string[];
}

const SYSTEM_PROMPT = [
  '你为规则模拟世界里本月刚出生的孩子提出名字。你只能使用输入里的父母、亲历、气候和命名传统，不得补造家族历史、预言、身份、能力或世界事实。',
  '名字应像父母在眼前处境中会选的名字：可以含蓄回应真实牵挂或经历，但不要把灾难、人格标签或抽象理念直接拼成口号。',
  '只提出 givenName，不得包含姓氏、间隔点、空格、头衔、数字或标点。eastern 使用 1 至 3 个汉字；western 使用 1 至 8 个汉字的中文音译名。',
  '不要照抄父母全名、知名人物或虚构角色姓名。每个 childId 只能出现一次。',
  '严格输出一个 JSON 对象，不输出解释：{"names":[{"childId":"输入中的 childId","givenName":"名字","reason":"不超过四十字的命名缘由"}]}',
].join('\n');

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function parseJson(content: string): unknown {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
}

function namingTimeout(endpoint: ResolvedModelEndpoint): number {
  const configured = Number(loadServerEnvValue('MODEL_NAMING_TIMEOUT_MS') || Math.min(endpoint.timeoutMs, 12_000));
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(30_000, configured)) : 12_000;
}

function namingMaxOutputTokens(): number {
  const configured = Number(loadServerEnvValue('MODEL_NAMING_MAX_OUTPUT_TOKENS') || 480);
  return Number.isFinite(configured) ? Math.max(128, Math.min(1_200, Math.floor(configured))) : 480;
}

function isBirthFact(event: WorldEvent): event is EnvironmentFact {
  return event.kind === 'environment'
    && event.change === 'body'
    && typeof event.diff.bornPersonId === 'string';
}

function namingIdentity(event: EnvironmentFact): NamingIdentity | null {
  const familyName = text(event.diff.familyName, 24);
  const namingTradition = event.diff.namingTradition;
  if (!familyName || namingTradition !== 'eastern' && namingTradition !== 'western') return null;
  return { familyName, namingTradition };
}

export function buildNewbornNamingContexts(
  state: SimulationState,
  events: readonly WorldEvent[],
): NewbornNamingContext[] {
  return events.filter(isBirthFact).flatMap((event) => {
    if (event.diff.namingSource === 'validated-model-proposal-v1') return [];
    const childId = event.diff.bornPersonId as string;
    const child = state.people.find((person) => person.id === childId);
    const identity = namingIdentity(event);
    if (!child || !identity || child.bornAtMonth !== event.atMonth) return [];
    const parentIds = Array.isArray(event.diff.parents)
      ? event.diff.parents.filter((id): id is string => typeof id === 'string')
      : child.geneticParents;
    const parents = parentIds.flatMap((parentId, index) => {
      const parent = state.people.find((person) => person.id === parentId);
      if (!parent) return [];
      const soul = buildPersonSoul(parent);
      const namingFacet = soul.sceneFacets.find((facet) => facet.id === 'trust-and-closeness')!;
      return [{
        id: parent.id,
        name: parent.name,
        role: parent.id === event.who ? 'mother' as const : index === 1 ? 'father' as const : 'parent' as const,
        innerVoice: soul.innerVoice,
        namingAttention: namingFacet.attention,
        namingTension: namingFacet.innerTension,
        recentMemories: [...parent.memories]
          .filter((memory) => memory.createdAtMonth >= event.atMonth - 24)
          .sort((left, right) => right.importance - left.importance || right.createdAtMonth - left.createdAtMonth)
          .slice(0, 4)
          .map((memory) => ({ summary: memory.summary, sourceEventIds: [...memory.sourceEventIds] })),
      }];
    });
    return [{
      childId,
      fallbackName: child.name,
      sex: child.sex,
      ...identity,
      parents,
      circumstances: {
        atMonth: event.atMonth,
        epoch: state.civilization.epoch,
        climate: state.civilization.climate,
        weather: state.civilization.weather,
      },
    }];
  });
}

export function normalizeNewbornNameProposals(
  input: unknown,
  contexts: readonly NewbornNamingContext[],
): NewbornNameProposal[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const names = (input as Record<string, unknown>).names;
  if (!Array.isArray(names)) return [];
  const allowedIds = new Set(contexts.map((context) => context.childId));
  const seen = new Set<string>();
  return names.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const raw = value as Record<string, unknown>;
    const childId = text(raw.childId, 160);
    const givenName = text(raw.givenName, 24);
    const reason = text(raw.reason, 80);
    if (!allowedIds.has(childId) || seen.has(childId) || !givenName || !reason) return [];
    seen.add(childId);
    return [{ childId, givenName, reason }];
  });
}

export function applyNewbornNameProposals(
  state: SimulationState,
  events: readonly WorldEvent[],
  proposals: readonly NewbornNameProposal[],
  metadata: NewbornNamingMetadata,
): Pick<NewbornNamingResult, 'renamed' | 'rejectedChildIds'> {
  const proposalsByChild = new Map(proposals.map((proposal) => [proposal.childId, proposal]));
  const renamed: NewbornNamingResult['renamed'] = [];
  const rejectedChildIds: string[] = [];
  for (const event of events.filter(isBirthFact)) {
    const childId = event.diff.bornPersonId as string;
    const proposal = proposalsByChild.get(childId);
    if (!proposal || event.diff.namingSource === 'validated-model-proposal-v1') continue;
    const child = state.people.find((person) => person.id === childId);
    const identity = namingIdentity(event);
    if (!child || !identity || child.bornAtMonth !== event.atMonth) {
      rejectedChildIds.push(childId);
      continue;
    }
    const fallbackName = child.name;
    const accepted = acceptProposedNewbornGivenName(
      proposal.givenName,
      identity,
      state.people.filter((person) => person.id !== child.id).map((person) => person.name),
    );
    if (!accepted) {
      rejectedChildIds.push(childId);
      continue;
    }
    child.name = accepted.name;
    for (const currentEvent of events) {
      if (currentEvent.result.includes(fallbackName)) {
        currentEvent.result = currentEvent.result.replaceAll(fallbackName, accepted.name);
      }
    }
    for (const person of state.people) {
      for (const memory of person.memories) {
        if (memory.sourceEventIds.includes(event.id) && memory.summary.includes(fallbackName)) {
          memory.summary = memory.summary.replaceAll(fallbackName, accepted.name);
        }
      }
    }
    event.diff = {
      ...event.diff,
      bornPersonName: accepted.name,
      fallbackPersonName: fallbackName,
      namingSource: 'validated-model-proposal-v1',
      namingProposalGivenName: accepted.givenName,
      namingProposalReason: proposal.reason,
      namingEndpointId: metadata.endpointId,
      namingProtocol: metadata.protocol,
      namingModel: metadata.model,
      namingInputTokens: metadata.inputTokens,
      namingOutputTokens: metadata.outputTokens,
    };
    renamed.push({ childId, fallbackName, name: accepted.name, reason: proposal.reason });
  }
  return { renamed, rejectedChildIds };
}

export async function realizeNewbornNames(
  state: SimulationState,
  events: readonly WorldEvent[],
  requestedEndpoint?: string,
): Promise<NewbornNamingResult> {
  const contexts = buildNewbornNamingContexts(state, events);
  if (!contexts.length) return { renamed: [], rejectedChildIds: [], generationErrors: [] };
  let endpoint: ResolvedModelEndpoint;
  try {
    endpoint = resolveModelEndpoint('naming', requestedEndpoint);
  } catch (error) {
    return { renamed: [], rejectedChildIds: [], generationErrors: [error instanceof Error ? error.message : String(error)] };
  }
  try {
    const response = await requestModelText(endpoint, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ namingRequests: contexts }) },
      ],
      temperature: endpoint.temperature ?? 0.9,
      maxOutputTokens: namingMaxOutputTokens(),
      jsonObject: true,
      timeoutMs: namingTimeout(endpoint),
    });
    const proposals = normalizeNewbornNameProposals(parseJson(response.text), contexts);
    if (!proposals.length) {
      return { renamed: [], rejectedChildIds: contexts.map((context) => context.childId), generationErrors: ['模型没有返回合法的后代姓名候选'] };
    }
    const applied = applyNewbornNameProposals(state, events, proposals, {
      endpointId: response.endpointId,
      protocol: response.protocol,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    const proposedChildIds = new Set(proposals.map((proposal) => proposal.childId));
    const missingChildIds = contexts
      .filter((context) => !proposedChildIds.has(context.childId))
      .map((context) => context.childId);
    return {
      ...applied,
      rejectedChildIds: [...new Set([...applied.rejectedChildIds, ...missingChildIds])],
      generationErrors: [],
    };
  } catch (error) {
    return {
      renamed: [],
      rejectedChildIds: [],
      generationErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
