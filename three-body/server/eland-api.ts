import { randomInt } from 'node:crypto';
import { ElandSessionCapacityError, elandSessions } from './elandSession';
import type { EraKey, SkySample } from '../src/game/societyContract';

export interface ElandApiResponse {
  status: number;
  body: unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function era(value: unknown): EraKey {
  return value === 'chaotic' || value === 'chaotic-heat' || value === 'chaotic-cold' || value === 'burned' || value === 'frozen' || value === 'extinct'
    ? value
    : 'stable';
}

function skySample(value: unknown): SkySample {
  const input = asObject(value);
  const toTime = finite(input.toTime, 0);
  const fluxMean = Math.max(0, finite(input.fluxMean, 1));
  return {
    fromTime: finite(input.fromTime, toTime),
    toTime,
    fluxMean,
    fluxMin: Math.max(0, finite(input.fluxMin, fluxMean)),
    fluxMax: Math.max(0, finite(input.fluxMax, fluxMean)),
    nearestStarDistance: Math.max(0, finite(input.nearestStarDistance, 1)),
    fate: era(input.fate),
  };
}

export async function handleElandApi(method: string | undefined, url: URL, bodyValue: unknown): Promise<ElandApiResponse> {
  const route = url.pathname.replace(/^\/api\/eland\/?|^\/+|\/+$/g, '');
  const body = asObject(bodyValue);
  const runId = String(body.runId ?? url.searchParams.get('runId') ?? '').trim();
  const leaseId = String(body.leaseId ?? '').trim();
  if (!runId) return { status: 400, body: { error: '缺少 runId' } };

  if (route === 'end' && method === 'POST') {
    return { status: 200, body: { ended: elandSessions.end(runId, leaseId), activeSessions: elandSessions.size() } };
  }

  if (route === 'begin' && method === 'POST') {
    const civilizationId = Math.max(1, Math.floor(finite(body.civilizationId, 1)));
    const worldSeed = body.worldSeed === undefined
      ? randomInt(1, 0x1_0000_0000)
      : Math.min(0xffff_ffff, Math.max(1, Math.floor(finite(body.worldSeed, randomInt(1, 0x1_0000_0000)))));
    const characterIds = Array.isArray(body.characterIds) ? body.characterIds.filter((id): id is string => typeof id === 'string') : undefined;
    try {
      return {
        status: 200,
        body: elandSessions.begin(runId, civilizationId, worldSeed, skySample(body.skySample), characterIds, leaseId),
      };
    } catch (error) {
      if (error instanceof ElandSessionCapacityError) {
        return { status: 429, body: { error: error.message, maxSessions: error.maxSessions } };
      }
      throw error;
    }
  }

  const session = elandSessions.get(runId, route === 'step' && method === 'POST' ? 'step' : 'read');
  if (!session) return { status: 404, body: { error: `运行 ${runId} 不存在` } };
  if (route === 'step' && method === 'POST') return { status: 200, body: await session.step({ skySample: skySample(body.skySample) }) };
  if (route === 'state' && method === 'GET') return { status: 200, body: { playing: false, model: session.model(), frame: session.latest() } };
  if (route === 'history' && method === 'GET') return { status: 200, body: { civilizationId: session.latest()?.civilizationId ?? 0, history: session.historyList(), branches: session.branchList() } };
  if (route === 'frame' && method === 'GET') return { status: 200, body: session.frameAt(finite(url.searchParams.get('month'), 0)) };
  if (route === 'agent-history' && method === 'GET') {
    const agentId = String(url.searchParams.get('agentId') ?? '').trim();
    if (!agentId) return { status: 400, body: { error: '缺少 agentId' } };
    const month = Math.max(0, Math.floor(finite(url.searchParams.get('month'), session.latest()?.elapsedMonths ?? 0)));
    const limit = Math.max(1, Math.floor(finite(url.searchParams.get('limit'), 80)));
    return { status: 200, body: session.agentHistory(agentId, month, limit) };
  }
  if (route === 'seek' && method === 'POST') return { status: 200, body: session.seek(finite(body.month, 0)) };
  return { status: 404, body: { error: `未知路由 ${route}` } };
}
