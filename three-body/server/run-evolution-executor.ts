import { createSimulationFromOwnedState } from '../src/game/eland/application/simulation/controller';
import type { SimulationState } from '../src/game/eland/simulation';
import {
  buildEvolutionFactsReport,
  checkpointFor,
  evolvePath,
  type EvolutionPath,
} from './evolution-artifacts';
import { logPerf, perfElapsed, perfNow } from './perf';
import { loadServerEnvValue } from './env';
import type { SqliteRunStore } from './sqlite-run-store';

const RULE_PLANNER_MODEL = 'rule-planner-v1';
const DEFAULT_LONG_EVOLUTION_CHECKPOINT_MONTHS = 12;

export function longEvolutionCheckpointMonths(): number {
  const configured = Number(loadServerEnvValue('ELAND_LONG_EVOLUTION_CHECKPOINT_MONTHS'));
  return Number.isInteger(configured) && configured >= 1 && configured <= 1_200
    ? configured
    : DEFAULT_LONG_EVOLUTION_CHECKPOINT_MONTHS;
}

export async function completeLongEvolution(
  store: SqliteRunStore,
  id: string,
  state: SimulationState,
  previous: EvolutionPath,
  requestedEndMonth: number,
): Promise<EvolutionPath> {
  const running = evolvePath(state, {
    runId: id,
    provider: 'local',
    model: previous.model,
    fromMonth: previous.fromMonth,
    requestedEndMonth,
    previous,
    checkpoint: checkpointFor(state, {
      inputTokens: previous.checkpoints.at(-1)?.inputTokens ?? 0,
      outputTokens: previous.checkpoints.at(-1)?.outputTokens ?? 0,
    }, previous.checkpoints.at(-1)),
    status: 'running',
  });
  const report = buildEvolutionFactsReport(state, running);
  await store.saveEvolutionReport(id, report);
  const completed = evolvePath(state, {
    runId: id,
    provider: 'local',
    model: running.model,
    fromMonth: running.fromMonth,
    requestedEndMonth,
    previous: running,
    status: 'completed',
  });
  await store.saveEvolutionPath(id, completed);
  return completed;
}

/**
 * Executes one authoritative run inside the process that owns `store`.
 * The HTTP backend calls this through a Worker so CPU work, projections, and
 * synchronous SQLite encoding cannot block request handling.
 */
export async function executeLongEvolution(
  store: SqliteRunStore,
  id: string,
  requestedEndMonth: number,
  initialPath: EvolutionPath,
): Promise<void> {
  const current = await store.load(id);
  const controller = createSimulationFromOwnedState(current.state);
  let persisted = controller.ownedState();
  let path = initialPath;
  const inputTokens = path.checkpoints.at(-1)?.inputTokens ?? 0;
  const outputTokens = path.checkpoints.at(-1)?.outputTokens ?? 0;
  const checkpointMonths = longEvolutionCheckpointMonths();
  try {
    while (persisted.clock.elapsedMonths < requestedEndMonth && persisted.civilization.status === 'running') {
      const batchMonths = Math.min(checkpointMonths, requestedEndMonth - persisted.clock.elapsedMonths);
      const previousMonth = persisted.clock.elapsedMonths;
      const batchStartedAt = perfNow();
      const simulationStartedAt = perfNow();
      const state = controller.stepOwned(batchMonths);
      const simulationMs = perfElapsed(simulationStartedAt);
      if (state.clock.elapsedMonths <= previousMonth && state.civilization.status === 'running') {
        throw new Error(`演化未向前推进：仍在第 ${state.clock.elapsedMonths} 月`);
      }
      persisted = state;
      const persistenceStartedAt = perfNow();
      await store.save(id, persisted, undefined, { historyMode: 'append' });
      path = evolvePath(persisted, {
        runId: id,
        provider: 'local',
        model: RULE_PLANNER_MODEL,
        fromMonth: initialPath.fromMonth,
        requestedEndMonth,
        previous: path,
        checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }, path.checkpoints.at(-1)),
        status: 'running',
      });
      await store.saveEvolutionPath(id, path);
      logPerf('long-evolution-batch', {
        runId: id,
        throughMonth: persisted.clock.elapsedMonths,
        batchMonths,
        checkpointMonths,
        people: persisted.people.length,
        totalEvents: persisted.world.past.length,
        simulationMs,
        persistenceMs: perfElapsed(persistenceStartedAt),
        totalMs: perfElapsed(batchStartedAt),
      });
    }
    await completeLongEvolution(store, id, persisted, path, requestedEndMonth);
  } catch (error) {
    await store.save(id, persisted, undefined, { historyMode: 'append' });
    path = evolvePath(persisted, {
      runId: id,
      provider: 'local',
      model: path.model,
      fromMonth: initialPath.fromMonth,
      requestedEndMonth,
      previous: path,
      checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }, path.checkpoints.at(-1)),
      status: 'failed',
      failure: error instanceof Error ? error.message : String(error),
    });
    await store.saveEvolutionPath(id, path);
  }
}
