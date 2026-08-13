export type ModelProvider = 'kimi';
export const DEFAULT_MODEL_PROVIDER: ModelProvider = 'kimi';

export const MODEL_OPTIONS: ReadonlyArray<{
  id: ModelProvider;
  label: string;
  model: string;
  description: string;
}> = [
  {
    id: 'kimi',
    label: 'Kimi',
    model: 'kimi-for-coding',
    description: '更强的长上下文推理',
  },
];

export function normalizeModelProvider(value: unknown): ModelProvider {
  void value;
  return DEFAULT_MODEL_PROVIDER;
}

export function modelLabel(provider: ModelProvider): string {
  return MODEL_OPTIONS.find((option) => option.id === provider)?.label ?? 'Kimi';
}
