export type ModelPurpose = 'decision' | 'interaction' | 'narrative' | 'naming' | 'strategy';
export type EvolutionMode = 'local' | 'model';

export interface ModelSettingsEndpoint {
  id: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'ollama-chat';
  url: string;
  model: string;
  configured: boolean;
  issue?: string;
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
};
