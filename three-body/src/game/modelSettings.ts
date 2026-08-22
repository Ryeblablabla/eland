export type ModelPurpose = 'decision' | 'interaction' | 'narrative' | 'naming' | 'strategy';
export type EvolutionMode = 'local' | 'model';
export type ModelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'ollama-chat';
export type ModelAuth = 'bearer' | 'x-api-key' | 'none';
export type StructuredOutputMode = 'prompt' | 'native-json';
export type ModelThinking = boolean | 'low' | 'medium' | 'high' | 'max';

export interface ModelSettingsEndpoint {
  id: string;
  protocol: ModelProtocol;
  url: string;
  model: string;
  auth: ModelAuth;
  configured: boolean;
  hasApiKey: boolean;
  verified: boolean;
  verifiedAt?: string;
  timeoutMs: number;
  temperature?: number;
  structuredOutput: StructuredOutputMode;
  thinking?: ModelThinking;
  headerNames: string[];
  issue?: string;
}

export interface ModelEndpointDraft {
  id: string;
  originalId?: string;
  protocol: ModelProtocol;
  url: string;
  model: string;
  auth: ModelAuth;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  temperature?: number;
  structuredOutput?: StructuredOutputMode;
  thinking?: ModelThinking;
}

export interface ModelEndpointTestResult {
  token: string;
  testedAt: string;
  latencyMs: number;
  model: string;
  preview: string;
}

export interface ModelSettingsSnapshot {
  source: 'config-file' | 'legacy-kimi';
  editable: boolean;
  evolutionMode: EvolutionMode;
  summaryMode: EvolutionMode;
  configFile?: string;
  purposes: ModelPurpose[];
  endpoints: ModelSettingsEndpoint[];
  routes: Record<ModelPurpose, string>;
}

async function requestModelSettings(init?: RequestInit): Promise<ModelSettingsSnapshot> {
  const response = await fetch('/api/model-settings', { cache: 'no-store', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `模型设置接口返回 ${response.status}`);
  }
  return response.json() as Promise<ModelSettingsSnapshot>;
}

async function requestEndpoint<T>(pathname: string, init: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `模型端点接口返回 ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const modelSettingsClient = {
  read: () => requestModelSettings(),
  update: (
    routes: Record<ModelPurpose, string>,
    evolutionMode: EvolutionMode,
    summaryMode: EvolutionMode,
  ) => requestModelSettings({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routes, evolutionMode, summaryMode }),
  }),
  testEndpoint: (draft: ModelEndpointDraft) => requestEndpoint<ModelEndpointTestResult>(
    '/api/model-settings/endpoints/test',
    { method: 'POST', body: JSON.stringify(draft) },
  ),
  saveEndpoint: (token: string) => requestEndpoint<ModelSettingsSnapshot>(
    '/api/model-settings/endpoints',
    { method: 'PUT', body: JSON.stringify({ token }) },
  ),
  deleteEndpoint: (id: string) => requestEndpoint<ModelSettingsSnapshot>(
    '/api/model-settings/endpoints',
    { method: 'DELETE', body: JSON.stringify({ id }) },
  ),
};
