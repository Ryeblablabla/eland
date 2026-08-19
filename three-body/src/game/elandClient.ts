/** 演化会话后端的前端客户端（/api/eland/*） */
import type {
  AgentConversationTurn,
  AgentConversationView,
  AgentHistoryView,
  CosmosSnapshot,
  ElandSaveSummary,
  GameFrame,
  NarrativeEntryView,
  SkySample,
} from './societyContract';
import type { ModelProvider } from './llm';
import { applyStepPayload, type ElandStepPayload } from './eland/society-patch';

export type Frame = GameFrame;

export class ElandSessionMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElandSessionMissingError';
  }
}

export class ElandBackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElandBackendUnavailableError';
  }
}

const PAGE_LEASE_ID = `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let civilizationCreationSequence = 0;
const latestFrames = new Map<string, Frame | null>();

export function createCivilizationCreationId(): string {
  civilizationCreationSequence += 1;
  return `${PAGE_LEASE_ID}:civilization:${Date.now().toString(36)}:${civilizationCreationSequence.toString(36)}`;
}

function randomRunId(): string {
  return `threebody-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 为一次全新文明生成独立种子；保留该值即可精确重放同一开局。 */
export function createWorldSeed(): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0] || 1;
}

/** 同一标签页刷新时复用 runId，让 begin 原地替换旧会话，避免刷新泄漏。 */
export function getElandRunId(): string {
  if (typeof window === 'undefined') return randomRunId();
  const storageKey = 'threebody:eland:run-id';
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const runId = randomRunId();
    window.sessionStorage.setItem(storageKey, runId);
    return runId;
  } catch {
    return randomRunId();
  }
}

async function post<T>(route: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/eland/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ElandBackendUnavailableError('演化后端暂时不可用');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { error?: string };
    const message = detail.error ?? `${route} 返回 ${res.status}`;
    if (res.status === 404) throw new ElandSessionMissingError(message);
    if (res.status >= 500) throw new ElandBackendUnavailableError(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function get<T>(route: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/eland/${route}`, { cache: 'no-store' });
  } catch {
    throw new ElandBackendUnavailableError('演化后端暂时不可用');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { error?: string };
    const message = detail.error ?? `${route} 返回 ${res.status}`;
    if (res.status === 404) throw new ElandSessionMissingError(message);
    if (res.status >= 500) throw new ElandBackendUnavailableError(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const elandClient = {
  begin: async (
    runId: string,
    creationId: string,
    skySample: SkySample,
    characterIds?: string[],
    worldSeed = createWorldSeed(),
    cosmosSnapshot?: CosmosSnapshot,
  ) => {
    const frame = await post<Frame>('begin', {
      runId,
      leaseId: PAGE_LEASE_ID,
      creationId,
      worldSeed,
      skySample,
      ...(cosmosSnapshot ? { cosmosSnapshot } : {}),
      ...(characterIds && characterIds.length > 0 ? { characterIds } : {}),
    });
    latestFrames.set(runId, frame);
    return frame;
  },
  step: async (runId: string, skySample: SkySample, cosmosSnapshot?: CosmosSnapshot) => {
    const payload = await post<ElandStepPayload>('step', {
      runId,
      skySample,
      ...(cosmosSnapshot ? { cosmosSnapshot } : {}),
    });
    let frame = applyStepPayload(latestFrames.get(runId) ?? null, payload);
    if (payload.kind === 'patch' && !frame) {
      const refreshed = await get<{
        playing: boolean;
        model: 'local' | ModelProvider;
        frame: Frame | null;
        history: NarrativeEntryView[];
      }>(`state?runId=${encodeURIComponent(runId)}`);
      frame = refreshed.frame;
    }
    latestFrames.set(runId, frame);
    return frame;
  },
  state: async (runId: string) => {
    const result = await get<{
      playing: boolean;
      model: 'local' | ModelProvider;
      frame: Frame | null;
      history: NarrativeEntryView[];
    }>(`state?runId=${encodeURIComponent(runId)}`);
    latestFrames.set(runId, result.frame);
    return result;
  },
  history: (runId: string) => get<{
    civilizationId: number;
    history: { month: number; label: string; summary: string }[];
    branches: { id: string; parentBranchId?: string; forkAtMonth: number; headAtMonth: number; active: boolean }[];
  }>(`history?runId=${encodeURIComponent(runId)}`),
  frameAt: (runId: string, month: number) => get<Frame | null>(`frame?runId=${encodeURIComponent(runId)}&month=${month}`),
  agentHistory: (runId: string, agentId: string, month: number, limit = 80) => get<AgentHistoryView | null>(
    `agent-history?runId=${encodeURIComponent(runId)}&agentId=${encodeURIComponent(agentId)}&month=${month}&limit=${limit}`,
  ),
  agentConversation: (runId: string, agentId: string) => get<AgentConversationView>(
    `agent-conversation?runId=${encodeURIComponent(runId)}&agentId=${encodeURIComponent(agentId)}`,
  ),
  sendAgentConversation: (input: {
    runId: string;
    agentId: string;
    message: string;
    requestKind: 'conversation' | 'suggestion';
    clientMessageId: string;
    observedBranchId: string;
  }) => post<{ conversation: AgentConversationView; turn: AgentConversationTurn }>('agent-conversation', input),
  seek: async (runId: string, month: number) => {
    const frame = await post<Frame | null>('seek', { runId, month });
    latestFrames.set(runId, frame);
    return frame;
  },
  saves: (runId: string) => get<{ saves: ElandSaveSummary[] }>(`saves?runId=${encodeURIComponent(runId)}`),
  save: (runId: string, label?: string) => post<{ save: ElandSaveSummary }>('save', {
    runId,
    leaseId: PAGE_LEASE_ID,
    ...(label?.trim() ? { label: label.trim() } : {}),
  }),
  loadSave: async (runId: string, saveId: string) => {
    const loaded = await post<{
      save: ElandSaveSummary;
      frame: Frame;
      history: NarrativeEntryView[];
    }>('load', { runId, leaseId: PAGE_LEASE_ID, saveId });
    latestFrames.set(runId, loaded.frame);
    return loaded;
  },
  checkpoint: (runId: string) => {
    const body = JSON.stringify({ runId, leaseId: PAGE_LEASE_ID });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.('/api/eland/checkpoint', body)) {
      return Promise.resolve();
    }
    return fetch('/api/eland/checkpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).then(() => undefined).catch(() => undefined);
  },
  end: (runId: string) => {
    latestFrames.delete(runId);
    const body = JSON.stringify({ runId, leaseId: PAGE_LEASE_ID });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.('/api/eland/end', body)) {
      return Promise.resolve();
    }
    return fetch('/api/eland/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).then(() => undefined).catch(() => undefined);
  },
};
