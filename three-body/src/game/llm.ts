/** 服务端 endpoint id；具体协议、域名与模型由后端配置解析。 */
export type ModelProvider = string;
export const DEFAULT_MODEL_PROVIDER: ModelProvider = 'default';

export const MODEL_OPTIONS: ReadonlyArray<{
  id: ModelProvider;
  label: string;
  model: string;
  description: string;
}> = [
  {
    id: DEFAULT_MODEL_PROVIDER,
    label: '服务端配置模型',
    model: 'server-routed',
    description: '由用途路由选择协议、域名与模型',
  },
];

export function normalizeModelProvider(value: unknown): ModelProvider {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_MODEL_PROVIDER;
}

export function modelLabel(provider: ModelProvider): string {
  return MODEL_OPTIONS.find((option) => option.id === provider)?.label ?? provider;
}
