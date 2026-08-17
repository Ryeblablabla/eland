/** 演化会话后端的前端客户端（/api/eland/*） */
import type { AgentHistoryView, GameFrame, SkySample } from './societyContract';
import type { ModelProvider } from './llm';

export type Frame = GameFrame;

export class ElandSessionMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElandSessionMissingError';
  }
}

const PAGE_LEASE_ID = `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
  const res = await fetch(`/api/eland/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { error?: string };
    const message = detail.error ?? `${route} 返回 ${res.status}`;
    if (res.status === 404) throw new ElandSessionMissingError(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function get<T>(route: string): Promise<T> {
  const res = await fetch(`/api/eland/${route}`, { cache: 'no-store' });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { error?: string };
    const message = detail.error ?? `${route} 返回 ${res.status}`;
    if (res.status === 404) throw new ElandSessionMissingError(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const elandClient = {
  begin: (runId: string, civilizationId: number, skySample: SkySample, characterIds?: string[], worldSeed = createWorldSeed()) =>
    post<Frame>('begin', {
      runId,
      leaseId: PAGE_LEASE_ID,
      civilizationId,
      worldSeed,
      skySample,
      ...(characterIds && characterIds.length > 0 ? { characterIds } : {}),
    }),
  step: (runId: string, skySample: SkySample) => post<Frame | null>('step', { runId, skySample }),
  state: (runId: string) => get<{ playing: boolean; model: 'local' | ModelProvider; frame: Frame | null }>(`state?runId=${encodeURIComponent(runId)}`),
  history: (runId: string) => get<{
    civilizationId: number;
    history: { month: number; label: string; summary: string }[];
    branches: { id: string; parentBranchId?: string; forkAtMonth: number; headAtMonth: number; active: boolean }[];
  }>(`history?runId=${encodeURIComponent(runId)}`),
  frameAt: (runId: string, month: number) => get<Frame | null>(`frame?runId=${encodeURIComponent(runId)}&month=${month}`),
  agentHistory: (runId: string, agentId: string, month: number, limit = 80) => get<AgentHistoryView | null>(
    `agent-history?runId=${encodeURIComponent(runId)}&agentId=${encodeURIComponent(agentId)}&month=${month}&limit=${limit}`,
  ),
  seek: (runId: string, month: number) => post<Frame | null>('seek', { runId, month }),
  end: (runId: string) => {
    const body = JSON.stringify({ runId, leaseId: PAGE_LEASE_ID });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.('/api/eland/end', body)) {
      return Promise.resolve();
    }
    return fetch('/api/eland/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).then(() => undefined);
  },
};
