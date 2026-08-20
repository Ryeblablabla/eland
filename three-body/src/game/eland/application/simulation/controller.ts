import { addDrop } from '../../domain/action-executor';
import { Material, materialDefinition } from '../../domain/material';
import type {
  BatchDecider,
  ClimateKind,
  EnvironmentEventInput,
  EnvironmentFact,
  EpochKind,
  SimulationConfig,
  SimulationState,
} from '../../domain/model';
import { cellX, cellY, isCellId } from '../../world/grid';
import { createInitialState, restoreSimulationState } from './state-lifecycle';
import { clamp, copyState } from './state-utils';
import { stepOwnedSimulation, stepSimulationAsync } from './tick-executor';

export interface SimulationController {
  getState(): SimulationState;
  step(count?: number): SimulationState;
  /** Trusted session path: advances and returns the owned state without a second full-history clone. */
  stepOwned(count?: number): SimulationState;
  stepAsync(batch: BatchDecider, count?: number): Promise<SimulationState>;
  stepAsyncOwned(batch: BatchDecider, count?: number): Promise<SimulationState>;
  reset(): SimulationState;
  restore(saved: SimulationState): void;
  setExternalClimate(epoch: EpochKind, kind: ClimateKind, severity: number): void;
  injectEvent(input: EnvironmentEventInput): SimulationState;
}

export function createSimulation(options: { seed?: number; config?: Partial<SimulationConfig>; state?: SimulationState } = {}): SimulationController {
  let state = options.state ? restoreSimulationState(options.state) : createInitialState(options.seed, options.config);
  return {
    getState: () => copyState(state),
    step(count = 1) {
      for (let index = 0; index < count; index += 1) state = stepOwnedSimulation(state);
      return copyState(state);
    },
    stepOwned(count = 1) {
      for (let index = 0; index < count; index += 1) state = stepOwnedSimulation(state);
      return state;
    },
    async stepAsync(batch, count = 1) {
      for (let index = 0; index < count; index += 1) state = await stepSimulationAsync(state, batch);
      return copyState(state);
    },
    async stepAsyncOwned(batch, count = 1) {
      for (let index = 0; index < count; index += 1) state = await stepSimulationAsync(state, batch);
      return state;
    },
    reset() {
      state = createInitialState(options.seed ?? state.seed, state.civilization.conditions);
      return copyState(state);
    },
    restore(saved) {
      state = restoreSimulationState(saved);
    },
    setExternalClimate(epoch, kind, severity) {
      state.civilization.externalClimate = { epoch, kind, severity: clamp(severity, 1, 10) };
    },
    injectEvent(input) {
      if (!isCellId(input.cellId)) throw new Error('环境事件 cellId 无效');
      const atMonth = state.clock.elapsedMonths;
      const event: EnvironmentFact = {
        id: `e-${atMonth}-injected-${state.world.past.length}`,
        kind: 'environment', atMonth, orderInMonth: 0, planningTick: 0, orderInTick: 0, cellId: input.cellId,
        change: input.kind,
        result: input.description ?? `格子 ${input.cellId} 的环境发生变化`,
        diff: { severity: input.severity ?? 0, resource: input.resource ?? '', delta: input.delta ?? 0 },
      };
      if (input.kind === 'resource' && (input.delta ?? 0) > 0) {
        const normalized = input.resource?.toLowerCase();
        const materialId = normalized?.includes('wood') || normalized?.includes('木') ? Material.Wood
          : normalized?.includes('seed') || normalized?.includes('种') ? Material.Seed
            : normalized?.includes('stone') || normalized?.includes('石') ? Material.Stone : Material.Food;
        addDrop(state, materialId, Math.round(input.delta ?? 1), input.cellId, atMonth, [event.id], 'injected');
        event.result = `格 ${cellX(input.cellId)}, ${cellY(input.cellId)} 出现${materialDefinition(materialId).name}`;
      }
      state.world.past.push(event);
      state.lastStep = [event];
      return copyState(state);
    },
  };
}
