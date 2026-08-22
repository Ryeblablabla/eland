import type { EnvironmentFact, SimulationState, WorldEvent } from '../domain/model';
import { isAlive } from '../domain/person';

/**
 * Commits the player's explicit stop as an authoritative civilization outcome.
 * It ends observation without inventing deaths or changing any person's body.
 * The caller owns `state`; this use case mutates that owned state atomically.
 */
export function concludeOwnedCivilization(state: SimulationState): WorldEvent[] {
  if (state.civilization.status === 'ended') return state.lastStep;
  const atMonth = state.clock.elapsedMonths;
  const living = state.people.filter(isAlive);
  const event: EnvironmentFact = {
    id: `civilization-${state.civilization.number}-concluded-${state.branchId}-${atMonth}`,
    kind: 'environment',
    atMonth,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: state.lastStep.length,
    cellId: living[0]?.position.cellId ?? state.people[0]?.position.cellId ?? 0,
    change: 'condition',
    result: `观察者在第 ${atMonth} 月结束了第 ${state.civilization.number} 号文明的演化`,
    diff: {
      civilizationEnd: true,
      outcomeKind: 'concluded',
      livingPeople: living.length,
    },
  };
  state.civilization.status = 'ended';
  state.civilization.outcome = {
    kind: 'concluded',
    cause: '观察者主动结算',
    atMonth,
    summary: `观察者在第 ${atMonth} 月结束了这次演化；当时仍有 ${living.length} 人存活，所有已发生的历史被原样保留。`,
  };
  state.world.past.push(event);
  state.lastStep = [event];
  return state.lastStep;
}
