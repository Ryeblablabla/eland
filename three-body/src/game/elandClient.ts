/** 演化会话后端的前端客户端（/api/eland/*） */
import type { AgentHistoryView, GameFrame, SkySample } from './societyContract';
import { DEFAULT_MODEL_PROVIDER, type ModelProvider } from './llm';

export type Frame = GameFrame;

async function post<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/eland/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route} 返回 ${res.status}`);
  return res.json() as Promise<T>;
}

async function get<T>(route: string): Promise<T> {
  const res = await fetch(`/api/eland/${route}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${route} 返回 ${res.status}`);
  return res.json() as Promise<T>;
}

export const elandClient = {
  begin: (runId: string, civilizationId: number, skySample: SkySample, model: ModelProvider = DEFAULT_MODEL_PROVIDER, characterIds?: string[]) =>
    post<Frame>('begin', { runId, civilizationId, skySample, model, ...(characterIds && characterIds.length > 0 ? { characterIds } : {}) }),
  setModel: (runId: string, model: ModelProvider) => post<{ model: ModelProvider }>('model', { runId, model }),
  step: (runId: string, skySample: SkySample, fast = false) => post<Frame | null>('step', { runId, skySample, ...(fast ? { fast: true } : {}) }),
  state: (runId: string) => get<{ playing: boolean; fast: boolean; model: ModelProvider; frame: Frame | null }>(`state?runId=${encodeURIComponent(runId)}`),
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
};
