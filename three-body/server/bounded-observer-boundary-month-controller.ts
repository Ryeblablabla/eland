import { isDeepStrictEqual } from 'node:util';

import { stepOwnedSimulation } from '../src/game/eland/application/simulation/tick-executor';
import type { ObservationProjector } from '../src/game/eland/application/simulation/observation-projector';
import type { SimulationState } from '../src/game/eland/domain/model';
import { isAlive } from '../src/game/eland/domain/person';
import { LAST_MATERIALIZED_OBSERVER_BASIS_FIELD } from './bounded-gameplay-shell';

export const BOUNDED_OBSERVER_BOUNDARY_MONTH_CONTROLLER_VERSION =
  'bounded-observer-boundary-month-controller-v1' as const;

export type BoundedObserverBoundaryKind =
  | 'annual'
  | 'extinction'
  | 'months-endpoint';

export interface BoundedObserverBoundaryMonthReceipt {
  readonly sourceMonth: number;
  readonly targetMonth: number;
  readonly kind: BoundedObserverBoundaryKind;
  readonly projectCallCount: number;
}

export interface BoundedObserverBoundaryMonthResult {
  /** The same store-owned object supplied to the controller, mutated in place. */
  readonly state: SimulationState;
  /** A fact-month receipt only. It is not a publication or continuation receipt. */
  readonly receipt: Readonly<BoundedObserverBoundaryMonthReceipt>;
}

export class BoundedObserverBoundaryMonthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedObserverBoundaryMonthRejectedError';
  }
}

interface ObserverOwnedSnapshot {
  civilizationIndex: SimulationState['civilization']['civilizationIndex'];
  stage: SimulationState['civilization']['stage'];
  development: SimulationState['civilization']['development'];
  derivedWithoutStructures: Omit<SimulationState['derived'], 'structures'>;
  hasLastMaterializedObserverBasis: boolean;
  lastMaterializedObserverBasis: unknown;
}

function observerOwnedSnapshot(state: SimulationState): ObserverOwnedSnapshot {
  const { structures: _structures, ...derivedWithoutStructures } = state.derived;
  const stateRecord = state as unknown as Record<string, unknown>;
  return structuredClone({
    civilizationIndex: state.civilization.civilizationIndex,
    stage: state.civilization.stage,
    development: state.civilization.development,
    derivedWithoutStructures,
    hasLastMaterializedObserverBasis: Object.prototype.hasOwnProperty.call(
      stateRecord,
      LAST_MATERIALIZED_OBSERVER_BASIS_FIELD,
    ),
    lastMaterializedObserverBasis: stateRecord[LAST_MATERIALIZED_OBSERVER_BASIS_FIELD],
  });
}

function assertObserverOwnedUnchanged(
  expected: ObserverOwnedSnapshot,
  state: SimulationState,
  phase: string,
): void {
  if (!isDeepStrictEqual(expected, observerOwnedSnapshot(state))) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      `bounded 观察边界月在${phase}改写了 observer-owned hot shell/basis`,
    );
  }
}

interface EligibleBoundary {
  sourceMonth: number;
  targetMonth: number;
  reachesAnnualBoundary: boolean;
  reachesMonthsEndpoint: boolean;
  nonAnnualExtinctionProbe: boolean;
}

function eligibleBoundary(
  state: SimulationState,
  mode: 'scheduled' | 'nonannual-extinction-probe',
): EligibleBoundary {
  if (state.civilization.status !== 'running') {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月只接受仍在运行的文明',
    );
  }
  const endpoint = state.civilization.conditions.endpoint;
  if (endpoint.kind === 'milestones') {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月拒绝 milestones endpoint：该配置需要逐月完整观察投影',
    );
  }
  if (!state.people.some(isAlive)) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月 source 必须仍有活人，不能延后既有灭绝',
    );
  }
  const sourceMonth = state.clock.elapsedMonths;
  if (sourceMonth >= endpoint.value) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      `bounded 观察边界月 source ${sourceMonth} 已到达 months endpoint ${endpoint.value}`,
    );
  }
  const targetMonth = sourceMonth + 1;
  if (!Number.isSafeInteger(targetMonth) || targetMonth <= 0) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月的下一月份无效',
    );
  }
  const reachesAnnualBoundary = targetMonth % 12 === 0;
  const reachesMonthsEndpoint = targetMonth === endpoint.value;
  if (mode === 'scheduled' && !reachesAnnualBoundary && !reachesMonthsEndpoint) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      `第 ${targetMonth} 月既非年度边界，也未到达 months endpoint ${endpoint.value}`,
    );
  }
  if (mode === 'nonannual-extinction-probe'
    && (reachesAnnualBoundary || reachesMonthsEndpoint)) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      `第 ${targetMonth} 月是已知观察边界，不能冒充非年度 extinction probe`,
    );
  }
  return {
    sourceMonth,
    targetMonth,
    reachesAnnualBoundary,
    reachesMonthsEndpoint,
    nonAnnualExtinctionProbe: mode === 'nonannual-extinction-probe',
  };
}

function classifyCompletedBoundary(
  state: SimulationState,
  boundary: EligibleBoundary,
): BoundedObserverBoundaryKind {
  const hasLivingPerson = state.people.some(isAlive);
  if (!hasLivingPerson) {
    if (state.civilization.status !== 'ended'
      || state.civilization.outcome?.kind !== 'destroyed'
      || state.civilization.outcome.atMonth !== boundary.targetMonth) {
      throw new BoundedObserverBoundaryMonthRejectedError(
        'bounded 观察边界月已无人存活，但规则月末没有自然产生毁灭结局',
      );
    }
    return 'extinction';
  }
  if (boundary.reachesMonthsEndpoint) {
    if (state.civilization.status !== 'ended'
      || state.civilization.outcome?.kind !== 'boundary'
      || state.civilization.outcome.atMonth !== boundary.targetMonth) {
      throw new BoundedObserverBoundaryMonthRejectedError(
        'bounded 观察边界月到达 months endpoint，但规则月末没有自然产生边界结局',
      );
    }
    return 'months-endpoint';
  }
  if (boundary.nonAnnualExtinctionProbe) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 非年度 terminal probe 重演后文明仍在运行，拒绝 publication',
    );
  }
  if (!boundary.reachesAnnualBoundary || state.civilization.status !== 'running') {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月的年度分类与规则月末状态不一致',
    );
  }
  if (state.civilization.outcome !== undefined) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月的 running annual 状态不得保留 terminal outcome',
    );
  }
  return 'annual';
}

/**
 * Advances one private boundary fact month (root A in the two-root protocol).
 * The injected observation port is deliberately deferred: it records the one
 * required full-projection boundary without running any observer. The result
 * remains private until a separate observer materializer builds a publishable
 * root; this controller never claims publication or continuation readiness.
 *
 * The caller owns `state` exclusively and must discard it on every error.
 */
function stepOwnedBoundaryMonth(
  state: SimulationState,
  mode: 'scheduled' | 'nonannual-extinction-probe',
): BoundedObserverBoundaryMonthResult {
  const boundary = eligibleBoundary(state, mode);
  const observerBefore = observerOwnedSnapshot(state);
  const exactDerivedBefore = structuredClone(state.derived);
  let projectCallCount = 0;

  const recordingProjector: ObservationProjector = Object.freeze({
    project(projectedState: SimulationState, mode: 'development-only' | 'full'): void {
      projectCallCount += 1;
      if (projectCallCount !== 1) {
        throw new BoundedObserverBoundaryMonthRejectedError(
          'bounded 观察边界月触发了多次观察投影',
        );
      }
      if (mode !== 'full') {
        throw new BoundedObserverBoundaryMonthRejectedError(
          `bounded 观察边界月意外触发 ${mode} 观察投影`,
        );
      }
      if (projectedState !== state) {
        throw new BoundedObserverBoundaryMonthRejectedError(
          'bounded 观察边界月向 projector 传入了替换后的 state 对象',
        );
      }
      assertObserverOwnedUnchanged(observerBefore, projectedState, 'projector 回调前');
      // Intentionally deferred. A later materializer observes private fact root A.
      assertObserverOwnedUnchanged(observerBefore, projectedState, 'projector 回调后');
    },
  });

  const stepped = stepOwnedSimulation(recordingProjector, state);
  if (stepped !== state) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月规则推进意外替换了 store-owned state 对象',
    );
  }
  if (stepped.clock.elapsedMonths !== boundary.targetMonth
    || stepped.clock.elapsedMonths !== boundary.sourceMonth + 1) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      'bounded 观察边界月没有恰好推进一个月',
    );
  }
  assertObserverOwnedUnchanged(observerBefore, stepped, '规则月末结束后');
  // Month commit refreshes the compatibility `derived.structures` mirror from
  // the authoritative physical index before invoking the deferred full
  // projector. In the bounded profile that mirror is observer-owned. Restore
  // the exact pre-step observer snapshot before root A is staged, while the
  // month's physical facts remain authoritative in `world.physicalStructureIndex`.
  // This keeps both a legacy materialized observer and a canonical bounded hot
  // shell valid inputs without allowing the compatibility mirror to become a
  // planner-facing fact or to make root A non-canonical by accident.
  stepped.derived = exactDerivedBefore;
  const kind = classifyCompletedBoundary(stepped, boundary);
  if (projectCallCount !== 1) {
    throw new BoundedObserverBoundaryMonthRejectedError(
      `bounded 观察边界月需要恰好一次 full 投影调用，实际为 ${projectCallCount} 次`,
    );
  }
  return {
    state: stepped,
    receipt: Object.freeze({
      sourceMonth: boundary.sourceMonth,
      targetMonth: boundary.targetMonth,
      kind,
      projectCallCount,
    }),
  };
}

export function stepOwnedBoundedObserverBoundaryMonth(
  state: SimulationState,
): BoundedObserverBoundaryMonthResult {
  return stepOwnedBoundaryMonth(state, 'scheduled');
}

/**
 * Replays one otherwise ordinary source month solely to prove a natural
 * extinction boundary. A still-running replay, annual month, endpoint month or
 * milestone configuration fails closed and never yields a staging receipt.
 */
export function stepOwnedBoundedTerminalMonth(
  state: SimulationState,
): BoundedObserverBoundaryMonthResult {
  return stepOwnedBoundaryMonth(state, 'nonannual-extinction-probe');
}
