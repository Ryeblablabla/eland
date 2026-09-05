import type { BatchDecider } from '../src/game/eland/simulation';
import { createServerLlmDecider } from './backend-decider';
import { hasExplicitModelRoute, modelEndpointStatus, readEvolutionMode } from './model-config';

/** Infrastructure chooses a decision provider; the simulation owns each month. */
export interface EvolutionDecisionRuntime {
  provider: 'local' | 'model';
  model: string;
  decider?: BatchDecider;
}

export function resolveEvolutionDecisionRuntime(): EvolutionDecisionRuntime {
  if (readEvolutionMode() === 'local') return { provider: 'local', model: 'rule-planner-v1' };
  const endpoint = hasExplicitModelRoute('decision') ? modelEndpointStatus('decision') : null;
  if (!endpoint?.configured || !endpoint.endpointId || !endpoint.model) {
    throw new Error(`模型演化无法开始：${endpoint?.issue ?? '尚未配置人物决策模型'}。`);
  }
  return {
    provider: 'model',
    model: endpoint.model,
    decider: createServerLlmDecider(endpoint.endpointId),
  };
}
