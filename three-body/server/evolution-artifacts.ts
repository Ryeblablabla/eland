import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';

export interface EvolutionCheckpoint {
  month: number;
  eventCount: number;
  livingPeople: number;
  totalPeople: number;
  stage: string;
  integrity: number;
  milestoneIds: string[];
  modelDecisions: number;
  inputTokens: number;
  outputTokens: number;
}

export interface EvolutionTurningPoint {
  id: string;
  month: number;
  kind: 'milestone' | 'birth' | 'death';
  title: string;
  summary: string;
  evidenceEventIds: string[];
  personIds: string[];
}

export interface EvolutionPath {
  schemaVersion: 1;
  runId: string;
  provider: 'kimi';
  model: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  fromMonth: number;
  requestedEndMonth: number;
  reachedMonth: number;
  checkpoints: EvolutionCheckpoint[];
  turningPoints: EvolutionTurningPoint[];
  failure?: string;
}

export interface EvolutionReport {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  throughMonth: number;
  status: SimulationState['civilization']['status'];
  outcome: SimulationState['civilization']['outcome'] | null;
  initialPopulation: number;
  finalPopulation: number;
  births: number;
  deaths: number;
  completedActions: number;
  kimiDecisions: number;
  inputTokens: number;
  outputTokens: number;
  milestones: Array<{ id: string; label: string; note: string; evidenceEventIds: string[] }>;
  turningPoints: EvolutionTurningPoint[];
  checkpoints: EvolutionCheckpoint[];
}

function eventById(state: SimulationState): Map<string, WorldEvent> {
  return new Map(state.world.past.map((event) => [event.id, event]));
}

function personIdsFrom(event: WorldEvent | undefined): string[] {
  if (!event) return [];
  if ('who' in event && event.who) return [event.who];
  return [];
}

function turningPoints(state: SimulationState): EvolutionTurningPoint[] {
  const events = eventById(state);
  const points: EvolutionTurningPoint[] = state.derived.milestones.map((milestone) => {
    const evidence = milestone.evidenceEventIds.map((id) => events.get(id)).filter(Boolean) as WorldEvent[];
    return {
      id: `milestone:${milestone.id}`,
      month: Math.min(...evidence.map((event) => event.atMonth), state.clock.elapsedMonths),
      kind: 'milestone',
      title: milestone.label,
      summary: milestone.note,
      evidenceEventIds: milestone.evidenceEventIds,
      personIds: [...new Set(evidence.flatMap(personIdsFrom))],
    };
  });
  for (const event of state.world.past) {
    if (event.kind !== 'environment') continue;
    const bornPersonId = typeof event.diff.bornPersonId === 'string' ? event.diff.bornPersonId : undefined;
    if (bornPersonId) points.push({
      id: `birth:${event.id}`, month: event.atMonth, kind: 'birth', title: '新生命诞生', summary: event.result,
      evidenceEventIds: [event.id], personIds: [bornPersonId, ...personIdsFrom(event)],
    });
    if (event.change === 'death') points.push({
      id: `death:${event.id}`, month: event.atMonth, kind: 'death', title: '生命终止', summary: event.result,
      evidenceEventIds: [event.id], personIds: personIdsFrom(event),
    });
  }
  return points.sort((a, b) => a.month - b.month || a.id.localeCompare(b.id));
}

export function checkpointFor(
  state: SimulationState,
  usage: { inputTokens: number; outputTokens: number },
): EvolutionCheckpoint {
  const through = state.clock.elapsedMonths;
  return {
    month: through,
    eventCount: state.world.past.length,
    livingPeople: state.people.filter((person) => person.bornAtMonth <= through && (person.diedAtMonth === undefined || person.diedAtMonth > through)).length,
    totalPeople: state.people.length,
    stage: state.civilization.stage,
    integrity: state.civilization.integrity,
    milestoneIds: state.derived.milestones.map((milestone) => milestone.id),
    modelDecisions: state.world.past.filter((event) => event.kind === 'decision' && event.usedModel).length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

export function evolvePath(
  state: SimulationState,
  input: { runId: string; model: string; fromMonth: number; requestedEndMonth: number; previous?: EvolutionPath; checkpoint?: EvolutionCheckpoint; status: EvolutionPath['status']; failure?: string },
): EvolutionPath {
  const now = new Date().toISOString();
  const checkpoints = [...(input.previous?.checkpoints ?? [])];
  if (input.checkpoint) {
    const index = checkpoints.findIndex((item) => item.month === input.checkpoint?.month);
    if (index >= 0) checkpoints[index] = input.checkpoint;
    else checkpoints.push(input.checkpoint);
  }
  checkpoints.sort((a, b) => a.month - b.month);
  return {
    schemaVersion: 1,
    runId: input.runId,
    provider: 'kimi',
    model: input.model,
    status: input.status,
    startedAt: input.previous?.startedAt ?? now,
    updatedAt: now,
    fromMonth: input.previous?.fromMonth ?? input.fromMonth,
    requestedEndMonth: input.requestedEndMonth,
    reachedMonth: state.clock.elapsedMonths,
    checkpoints,
    turningPoints: turningPoints(state),
    ...(input.failure ? { failure: input.failure } : {}),
  };
}

export function buildEvolutionFactsReport(state: SimulationState, path: EvolutionPath): EvolutionReport {
  const births = state.world.past.filter((event) => event.kind === 'environment' && typeof event.diff.bornPersonId === 'string').length;
  const deaths = state.world.past.filter((event) => event.kind === 'environment' && event.change === 'death').length;
  const lastCheckpoint = path.checkpoints.at(-1);
  return {
    schemaVersion: 1,
    runId: path.runId,
    generatedAt: new Date().toISOString(),
    throughMonth: state.clock.elapsedMonths,
    status: state.civilization.status,
    outcome: state.civilization.outcome ?? null,
    initialPopulation: state.people.filter((person) => person.bornAtMonth <= path.fromMonth && (person.diedAtMonth === undefined || person.diedAtMonth > path.fromMonth)).length,
    finalPopulation: state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0).length,
    births,
    deaths,
    completedActions: state.world.past.filter((event) => event.kind === 'action' && event.status === 'completed').length,
    kimiDecisions: state.world.past.filter((event) => event.kind === 'decision' && event.usedModel).length,
    inputTokens: lastCheckpoint?.inputTokens ?? 0,
    outputTokens: lastCheckpoint?.outputTokens ?? 0,
    milestones: state.derived.milestones.map(({ id, label, note, evidenceEventIds }) => ({ id, label, note, evidenceEventIds })),
    turningPoints: path.turningPoints,
    checkpoints: path.checkpoints,
  };
}
