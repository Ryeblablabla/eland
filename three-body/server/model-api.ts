import { HttpError } from './http-error';
import { handleDecide } from './model-decision-gateway';
import {
  EVOLUTION_MODES,
  MODEL_PURPOSES,
  readModelSettings,
  updateModelSettings,
  type EvolutionMode,
  type ModelPurpose,
} from './model-config';

export interface ModelApiResponse {
  status: number;
  body: unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function modelRoutes(value: unknown): Record<ModelPurpose, string> {
  const input = asObject(value);
  return Object.fromEntries(MODEL_PURPOSES.map((purpose) => {
    const endpointId = input[purpose] ?? (purpose === 'naming' ? input.decision : undefined);
    if (typeof endpointId !== 'string' || !endpointId.trim()) {
      throw new HttpError(400, `routes.${purpose} 必须是模型端点 ID`);
    }
    return [purpose, endpointId.trim()];
  })) as Record<ModelPurpose, string>;
}

function modelUseMode(value: unknown, field: 'evolutionMode' | 'summaryMode'): EvolutionMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !EVOLUTION_MODES.includes(value as EvolutionMode)) {
    throw new HttpError(400, `${field} 必须是 local 或 model`);
  }
  return value as EvolutionMode;
}

export async function handleModelApi(
  method: string | undefined,
  pathname: string,
  bodyValue: unknown,
): Promise<ModelApiResponse> {
  if (method === 'POST' && pathname === '/api/decide') {
    const payload = bodyValue as { endpoint?: unknown; model?: unknown };
    const requestedEndpoint = typeof payload.endpoint === 'string'
      ? payload.endpoint
      : typeof payload.model === 'string'
        ? payload.model
        : undefined;
    return handleDecide(payload, requestedEndpoint);
  }

  if (method === 'GET' && pathname === '/api/model-settings') {
    return { status: 200, body: readModelSettings() };
  }

  if (method === 'PUT' && pathname === '/api/model-settings') {
    const body = asObject(bodyValue);
    try {
      return {
        status: 200,
        body: updateModelSettings(
          modelRoutes(body.routes),
          modelUseMode(body.evolutionMode, 'evolutionMode'),
          modelUseMode(body.summaryMode, 'summaryMode'),
        ),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  throw new HttpError(404, '接口不存在');
}
