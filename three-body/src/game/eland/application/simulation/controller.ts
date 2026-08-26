import { addDrop } from '../../domain/action-executor';
import {
  appendCommittedEvents,
  assertCommittedHistoryAppendable,
  historyEventCount,
} from '../../domain/history';
import { Material, materialDefinition } from '../../domain/material';
import type {
  BatchDecider,
  ClimateKind,
  EnvironmentEventInput,
  EnvironmentFact,
  EpochKind,
  SimulationConfig,
  SimulationState,
  TerminalCatastropheKind,
} from '../../domain/model';
import { cellX, cellY, isCellId } from '../../world/grid';
import { adoptSimulationState, createInitialState, restoreSimulationState } from './state-lifecycle';
import type { ObservationProjector } from './observation-projector';
import { clamp, copyState } from './state-utils';
import { stepOwnedSimulation, stepOwnedSimulationAsync } from './tick-executor';

export interface ExternalClimateInput {
  epoch: EpochKind;
  kind: ClimateKind;
  severity: number;
  terminalCatastrophe?: TerminalCatastropheKind;
}

export interface SimulationController {
  getState(): SimulationState;
  /** Trusted infrastructure view. Never mutate it outside the controller. */
  ownedState(): SimulationState;
  step(count?: number): SimulationState;
  /** Trusted session path: advances and returns the owned state without a second full-history clone. */
  stepOwned(count?: number): SimulationState;
  stepAsync(batch: BatchDecider, count?: number): Promise<SimulationState>;
  stepAsyncOwned(batch: BatchDecider, count?: number): Promise<SimulationState>;
  /** Applies climate only to the isolated async working copy. */
  stepAsyncOwnedWithClimate(batch: BatchDecider, climate: ExternalClimateInput, count?: number): Promise<SimulationState>;
  reset(): SimulationState;
  restore(saved: SimulationState): void;
  /** Trusted ownership transfer; unlike restore(), this does not clone saved. */
  adoptOwnedState(saved: SimulationState): SimulationState;
  setExternalClimate(
    epoch: EpochKind,
    kind: ClimateKind,
    severity: number,
    terminalCatastrophe?: TerminalCatastropheKind,
  ): void;
  injectEvent(input: EnvironmentEventInput): SimulationState;
}

export type SimulationOptions = { seed?: number; config?: Partial<SimulationConfig>; state?: SimulationState };

function applyExternalClimate(state: SimulationState, climate: ExternalClimateInput): void {
  state.civilization.externalClimate = {
    epoch: climate.epoch,
    kind: climate.kind,
    severity: clamp(climate.severity, 1, 10),
    ...(climate.terminalCatastrophe ? { terminalCatastrophe: climate.terminalCatastrophe } : {}),
  };
}

function createSimulationController(
  observationProjector: ObservationProjector,
  state: SimulationState,
  options: SimulationOptions,
): SimulationController {
  const stepAsyncTransaction = async (
    batch: BatchDecider,
    count: number,
    climate?: ExternalClimateInput,
  ): Promise<SimulationState> => {
    if (count <= 0) return state;
    // Keep the committed state readable while the model is pending. Only this
    // working copy may receive next-month climate or partial month mutations.
    let working = copyState(state);
    if (climate) applyExternalClimate(working, climate);
    for (let index = 0; index < count; index += 1) {
      working = await stepOwnedSimulationAsync(observationProjector, working, batch);
    }
    state = working;
    return state;
  };

  return {
    getState: () => copyState(state),
    ownedState: () => state,
    step(count = 1) {
      for (let index = 0; index < count; index += 1) state = stepOwnedSimulation(observationProjector, state);
      return copyState(state);
    },
    stepOwned(count = 1) {
      for (let index = 0; index < count; index += 1) state = stepOwnedSimulation(observationProjector, state);
      return state;
    },
    async stepAsync(batch, count = 1) {
      await stepAsyncTransaction(batch, count);
      return copyState(state);
    },
    stepAsyncOwned: (batch, count = 1) => stepAsyncTransaction(batch, count),
    stepAsyncOwnedWithClimate: (batch, climate, count = 1) => stepAsyncTransaction(batch, count, climate),
    reset() {
      state = createInitialState(observationProjector, options.seed ?? state.seed, state.civilization.conditions);
      return copyState(state);
    },
    restore(saved) {
      state = restoreSimulationState(observationProjector, saved);
    },
    adoptOwnedState(saved) {
      state = adoptSimulationState(observationProjector, saved);
      return state;
    },
    setExternalClimate(epoch, kind, severity, terminalCatastrophe) {
      applyExternalClimate(state, { epoch, kind, severity, terminalCatastrophe });
    },
    injectEvent(input) {
      if (!isCellId(input.cellId)) throw new Error('环境事件 cellId 无效');
      assertCommittedHistoryAppendable(state);
      const atMonth = state.clock.elapsedMonths;
      const event: EnvironmentFact = {
        id: `e-${atMonth}-injected-${historyEventCount(state)}`,
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
      appendCommittedEvents(state, [event]);
      state.lastStep = [event];
      return copyState(state);
    },
  };
}

export function createSimulation(
  observationProjector: ObservationProjector,
  options: SimulationOptions = {},
): SimulationController {
  const state = options.state
    ? restoreSimulationState(observationProjector, options.state)
    : createInitialState(observationProjector, options.seed, options.config);
  return createSimulationController(observationProjector, state, options);
}

/** Trusted restore path: ownership of `state` moves into the controller. */
export function createSimulationFromOwnedState(
  observationProjector: ObservationProjector,
  state: SimulationState,
): SimulationController {
  return createSimulationController(
    observationProjector,
    adoptSimulationState(observationProjector, state),
    {},
  );
}
