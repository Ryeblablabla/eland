import { isDeepStrictEqual } from 'node:util';

import {
  captureSimulationObservationState,
  deferredSimulationObservationProjection,
  type ObservationProjectionMode,
  type ObservationProjector,
  stepOwnedSimulationWithObservationProjector,
  type SimulationObservationSnapshot,
  type SimulationObservationState,
} from '../src/game/eland/infrastructure-api';
import type { SimulationState } from '../src/game/eland/domain/model';
import { LAST_MATERIALIZED_OBSERVER_BASIS_FIELD } from './bounded-gameplay-shell';

export const BOUNDED_NONPROJECTION_MONTH_CONTROLLER_VERSION =
  'bounded-nonprojection-month-controller-v1' as const;

/**
 * A full/development projection call means this month crossed a boundary that
 * the incomplete bounded observer sidecars cannot yet materialize. The normal
 * monthly structures mirror request is explicitly deferred, preserving the
 * last materialized observer shell while physical facts advance separately.
 */
export class BoundedNonProjectionMonthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedNonProjectionMonthRejectedError';
  }
}

/**
 * A non-annual fact month requested the one deferred full projection that only
 * extinction can trigger before a months endpoint. The ordinary controller
 * still refuses to stage its mutated private state; the store may reopen the
 * unchanged authority root and run the closed terminal probe instead.
 */
export class BoundedNonProjectionTerminalBoundaryRequiredError
  extends BoundedNonProjectionMonthRejectedError {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedNonProjectionTerminalBoundaryRequiredError';
  }
}

const boundedNonMaterializingProjector: ObservationProjector = Object.freeze({
  project(
    _snapshot: SimulationObservationSnapshot,
    mode: ObservationProjectionMode,
  ) {
    if (mode === 'structures-only') {
      return deferredSimulationObservationProjection(
        'bounded 非投影月保持上次已物化 observer shell',
      );
    }
    if (mode === 'full') {
      throw new BoundedNonProjectionTerminalBoundaryRequiredError(
        'bounded 非投影单月触发 full 观察边界，需要从同源权威状态执行 terminal probe',
      );
    }
    throw new BoundedNonProjectionMonthRejectedError(
      `bounded 非投影单月意外触发 ${mode} 观察投影`,
    );
  },
});

interface ObserverOwnedSnapshot {
  observations: SimulationObservationState;
  lastMaterializedObserverBasis: unknown;
}

function observerOwnedSnapshot(state: SimulationState): ObserverOwnedSnapshot {
  return structuredClone({
    observations: captureSimulationObservationState(state),
    lastMaterializedObserverBasis: (state as unknown as Record<string, unknown>)[
      LAST_MATERIALIZED_OBSERVER_BASIS_FIELD
    ],
  });
}

function assertEligibleNonProjectionMonth(state: SimulationState): number {
  if (state.civilization.status !== 'running') {
    throw new BoundedNonProjectionMonthRejectedError(
      'bounded 非投影单月只接受仍在运行的文明',
    );
  }
  const endpoint = state.civilization.conditions.endpoint;
  if (endpoint.kind === 'milestones') {
    throw new BoundedNonProjectionMonthRejectedError(
      'bounded 非投影单月拒绝 milestones endpoint：该配置每月都需要完整观察投影',
    );
  }
  const nextMonth = state.clock.elapsedMonths + 1;
  if (!Number.isSafeInteger(nextMonth) || nextMonth <= 0) {
    throw new BoundedNonProjectionMonthRejectedError('bounded 非投影单月的下一月份无效');
  }
  if (nextMonth % 12 === 0) {
    throw new BoundedNonProjectionMonthRejectedError(
      `bounded 非投影单月拒绝第 ${nextMonth} 月年度观察边界`,
    );
  }
  if (nextMonth >= endpoint.value) {
    throw new BoundedNonProjectionMonthRejectedError(
      `bounded 非投影单月拒绝第 ${nextMonth} 月到达 months endpoint ${endpoint.value}`,
    );
  }
  return nextMonth;
}

/**
 * Store-internal one-month rule step. It deliberately bypasses state lifecycle
 * restore/adopt because those paths invoke a full observer projection. The
 * caller must keep ownership of `state` and discard it on every thrown error.
 */
export function stepOwnedBoundedNonProjectionMonth(state: SimulationState): SimulationState {
  const sourceMonth = state.clock.elapsedMonths;
  const expectedNextMonth = assertEligibleNonProjectionMonth(state);
  const observerBefore = observerOwnedSnapshot(state);
  const stepped = stepOwnedSimulationWithObservationProjector(
    boundedNonMaterializingProjector,
    state,
  );

  if (stepped !== state) {
    throw new Error('bounded 非投影单月规则推进意外替换了 store-owned state 对象');
  }
  if (stepped.clock.elapsedMonths !== expectedNextMonth
    || stepped.clock.elapsedMonths !== sourceMonth + 1) {
    throw new Error('bounded 非投影单月没有恰好推进一个月');
  }
  if (stepped.civilization.status !== 'running') {
    throw new BoundedNonProjectionMonthRejectedError(
      'bounded 非投影单月结束后文明不再运行，拒绝 staging',
    );
  }
  const observerAfter = observerOwnedSnapshot(stepped);
  if (!isDeepStrictEqual(observerBefore, observerAfter)) {
    throw new BoundedNonProjectionMonthRejectedError(
      'bounded 非投影单月改写了 observer-owned hot shell/basis',
    );
  }
  return stepped;
}
