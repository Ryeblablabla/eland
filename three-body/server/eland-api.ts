import { elandSessions } from './elandSession';
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
  if (!runId) return { status: 400, body: { error: '缺少 runId' } };

  if (route === 'begin' && method === 'POST') {
    const characterIds = Array.isArray(body.characterIds) ? body.characterIds.filter((id): id is string => typeof id === 'string') : undefined;
    return {
      status: 200,
      body: elandSessions.begin(runId, Math.max(1, Math.floor(finite(body.civilizationId, 1))), skySample(body.skySample), body.model, characterIds),
    };
  }

  const session = elandSessions.get(runId);
  if (!session) return { status: 404, body: { error: `运行 ${runId} 不存在` } };
  if (route === 'model' && method === 'POST') return { status: 200, body: { model: session.setModel(body.model) } };
  if (route === 'step' && method === 'POST') return { status: 200, body: await session.step({ skySample: skySample(body.skySample), fast: body.fast === true }) };
  if (route === 'state' && method === 'GET') return { status: 200, body: { playing: false, fast: false, model: session.model(), frame: session.latest() } };
  if (route === 'history' && method === 'GET') return { status: 200, body: { civilizationId: session.latest()?.civilizationId ?? 0, history: session.historyList() } };
  if (route === 'frame' && method === 'GET') return { status: 200, body: session.frameAt(finite(url.searchParams.get('year'), 0)) };
  if (route === 'seek' && method === 'POST') return { status: 200, body: session.seek(finite(body.year, 0)) };
  return { status: 404, body: { error: `未知路由 ${route}` } };
}
