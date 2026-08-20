import type { SimulationState } from '../../domain/model';

export function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function copyState(input: SimulationState): SimulationState {
  // structuredClone 已经会复制 Uint16Array；过去再调用 copyWorld 会把整张
  // 84×52×12 体素图重复复制一次，每次 getState/step 都产生无意义的额外分配。
  return structuredClone(input);
}
