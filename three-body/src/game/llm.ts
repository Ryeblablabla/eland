export type ModelProvider = 'deepseek' | 'kimi';
export const DEFAULT_MODEL_PROVIDER: ModelProvider = 'kimi';

export const MODEL_OPTIONS: ReadonlyArray<{
  id: ModelProvider;
  label: string;
  model: string;
  description: string;
}> = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    model: 'deepseek-chat',
    description: '偏稳健的社会决策',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    model: 'kimi-k2-0711-preview',
    description: '更强的长上下文推理',
  },
];

export function normalizeModelProvider(value: unknown): ModelProvider {
  return value === 'deepseek' ? 'deepseek' : DEFAULT_MODEL_PROVIDER;
}

export function modelLabel(provider: ModelProvider): string {
  return MODEL_OPTIONS.find((option) => option.id === provider)?.label ?? 'Kimi';
}
