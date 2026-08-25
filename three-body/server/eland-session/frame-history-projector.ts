import type { SimulationState, WorldEvent } from '../../src/game/eland/simulation';
import { calendarDate } from '../../src/game/eland/domain/calendar';
import {
  monthSpeaker,
  projectPlayerNarrative,
  toSocietyState,
  type WorldEventLookup,
} from '../../src/game/eland/adapter';
import type {
  CivilizationIndexHistoryPoint,
  CosmosSnapshot,
  GameFrame,
  NarrativeEntryView,
  SkySample,
  SpeechLineView,
} from '../../src/game/societyContract';
import type { StoredFrame } from './timeline';
import {
  chronicleProjectionEntries,
  rebuildChronicleProjection,
  type ChronicleProjectionState,
} from './chronicle-projection';

export type FrameEntry = NarrativeEntryView;

export function entriesFor(
  state: SimulationState,
  events: WorldEvent[],
  eventsById?: WorldEventLookup,
): FrameEntry[] {
  return projectPlayerNarrative(state, events, 4, eventsById);
}

export function foundingEventsFor(state: SimulationState): WorldEvent[] {
  return state.world.past.filter((event) => (
    event.kind === 'environment'
      && event.change === 'founding'
      && event.atMonth === 0
  ));
}

function endingEntryFor(state: SimulationState, events: WorldEvent[]): FrameEntry | null {
  const outcome = state.civilization.outcome;
  if (state.civilization.status !== 'ended' || !outcome) return null;
  const deathEvents = outcome.kind === 'destroyed'
    ? events.filter((event): event is Extract<WorldEvent, { kind: 'environment' }> => (
      event.kind === 'environment' && event.change === 'death'
    ))
    : [];
  const conclusionEvents = outcome.kind === 'concluded'
    ? events.filter((event): event is Extract<WorldEvent, { kind: 'environment' }> => (
      event.kind === 'environment'
        && event.change === 'condition'
        && event.diff.civilizationEnd === true
    ))
    : [];
  const actorIds = [...new Set(deathEvents.flatMap((event) => (
    event.who ? [event.who] : typeof event.diff.personId === 'string' ? [event.diff.personId] : []
  )))];
  const text = outcome.kind === 'destroyed'
    ? `文明毁灭于${outcome.cause}。`
    : outcome.kind === 'boundary'
      ? `文明演化至第 ${outcome.atMonth} 月，观察结束。`
      : outcome.kind === 'milestones'
        ? '文明达到观察目标，演化结束。'
        : `第 ${state.civilization.number} 号文明由观察者结算。`;
  return {
    id: `narrative:civilization:${state.civilization.number}:${outcome.kind}:${outcome.atMonth}`,
    month: outcome.atMonth,
    text,
    detail: outcome.summary,
    tone: outcome.kind === 'destroyed' ? 'bad' : 'era',
    kind: 'epoch',
    importance: 200,
    sourceEventIds: [...deathEvents, ...conclusionEvents].map((event) => event.id),
    actorIds,
  };
}

export function withCivilizationEntries(
  state: SimulationState,
  events: WorldEvent[],
  entries: FrameEntry[],
): FrameEntry[] {
  const ending = endingEntryFor(state, events);
  if (!ending) return entries;
  const deathEventIds = new Set(ending.sourceEventIds);
  return [
    ...entries.filter((entry) => !(
      entry.id === ending.id
        || (entry.sourceEventIds.length > 0
          && entry.sourceEventIds.some((eventId) => deathEventIds.has(eventId)))
    )),
    ending,
  ];
}

export function projectFrame(input: {
  runId: string;
  authorityRevision: string;
  civilizationId: number;
  state: SimulationState;
  events: WorldEvent[];
  entries: FrameEntry[];
  speechLines: SpeechLineView[];
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
}): GameFrame {
  const date = calendarDate(input.state.clock.elapsedMonths);
  const society = toSocietyState(input.state);
  return {
    runId: input.runId,
    authorityRevision: input.authorityRevision,
    branchId: input.state.branchId,
    civilizationId: input.civilizationId,
    elapsedMonths: input.state.clock.elapsedMonths,
    calendar: { year: date.year, month: date.month, label: date.label },
    universeTime: input.skySample.toTime,
    skySample: input.skySample,
    ...(input.cosmosSnapshot ? { cosmosSnapshot: input.cosmosSnapshot } : {}),
    society,
    civilizationEnd: input.state.civilization.status === 'ended' && input.state.civilization.outcome
      ? {
          kind: input.state.civilization.outcome.kind,
          cause: input.state.civilization.outcome.cause,
          summary: input.state.civilization.outcome.summary,
        }
      : null,
    entries: withCivilizationEntries(input.state, input.events, input.entries),
    ...(input.speechLines.length ? { speechLines: input.speechLines } : {}),
    speaker: input.speechLines.at(-1)?.speakerName ?? monthSpeaker(input.state, input.events),
  };
}

export function storeFrame(frame: GameFrame): StoredFrame {
  const { society, ...storedFrameBase } = frame;
  const observedIndex = society.observations.civilizationIndex;
  return {
    ...storedFrameBase,
    ...(observedIndex ? {
      civilizationIndex: {
        formulaVersion: observedIndex.formulaVersion,
        total: observedIndex.total,
        calculatedAtMonth: observedIndex.calculatedAtMonth,
        stage: observedIndex.stage,
      },
    } : {}),
  };
}

function refreshStoredDeathEntries(
  entries: FrameEntry[],
  state: SimulationState,
  eventsById: WorldEventLookup,
): FrameEntry[] {
  const refreshed = new Map<string, FrameEntry>();
  return entries.map((entry) => {
    const narrativeDeathId = entry.id.startsWith('narrative:') ? entry.id.slice('narrative:'.length) : undefined;
    const soleSourceId = entry.sourceEventIds.length === 1 ? entry.sourceEventIds[0] : undefined;
    const event = (narrativeDeathId ? eventsById.get(narrativeDeathId) : undefined)
      ?? (soleSourceId ? eventsById.get(soleSourceId) : undefined);
    if (event?.kind !== 'environment' || event.change !== 'death') return entry;
    const death = event;
    const cached = refreshed.get(death.id);
    if (cached) return cached;
    const projection = entriesFor(state, [death], eventsById)
      .find((candidate) => candidate.id === `narrative:${death.id}`);
    if (!projection) return entry;
    refreshed.set(death.id, projection);
    return projection;
  });
}

export function finalizeChronicleEntries(
  projectedEntries: FrameEntry[],
  state: SimulationState | null,
  suppliedEventsById?: WorldEventLookup,
): FrameEntry[] {
  if (!state) return projectedEntries;
  const eventsById = suppliedEventsById
    ?? new Map(state.world.past.map((event) => [event.id, event]));
  // Stored frames keep their original presentation, but simple one-death rule
  // entries can be safely refreshed to expose causal evidence added later.
  // Mixed model summaries remain untouched because their identity/source set is
  // not an exact death entry.
  const entries = refreshStoredDeathEntries(projectedEntries, state, eventsById);
  const hasFounding = entries.some((entry) => entry.sourceEventIds.some((eventId) => {
    const event = eventsById.get(eventId);
    return event?.kind === 'environment' && event.change === 'founding';
  }));
  const foundingEntries = hasFounding ? [] : entriesFor(state, foundingEventsFor(state), eventsById);
  const withFounding = foundingEntries.some((founding) => (
    !entries.some((entry) => entry.sourceEventIds.some((eventId) => founding.sourceEventIds.includes(eventId)))
  )) ? [...foundingEntries, ...entries] : entries;
  return withCivilizationEntries(state, state.lastStep, withFounding);
}

export function projectChronicleFromProjection(
  projection: ChronicleProjectionState,
  state: SimulationState | null,
  eventsById?: WorldEventLookup,
): FrameEntry[] {
  return finalizeChronicleEntries(chronicleProjectionEntries(projection), state, eventsById);
}

export function projectChronicle(frames: StoredFrame[], state: SimulationState | null): FrameEntry[] {
  if (!state) {
    const latestById = new Map<string, FrameEntry>();
    for (const entry of frames.flatMap((frame) => frame.entries)) latestById.set(entry.id, entry);
    return [...latestById.values()].sort((left, right) => left.month - right.month);
  }
  const eventsById = new Map(state.world.past.map((event) => [event.id, event]));
  const projection = rebuildChronicleProjection(frames, eventsById);
  return projectChronicleFromProjection(projection, state, eventsById);
}

export function projectCivilizationIndexHistory(
  frames: StoredFrame[],
  current: CivilizationIndexHistoryPoint | null | undefined,
): CivilizationIndexHistoryPoint[] {
  const points = frames
    .map((frame) => frame.civilizationIndex)
    .filter((point): point is CivilizationIndexHistoryPoint => Boolean(point));
  if (current && points.at(-1)?.calculatedAtMonth !== current.calculatedAtMonth) {
    points.push({
      formulaVersion: current.formulaVersion,
      total: current.total,
      calculatedAtMonth: current.calculatedAtMonth,
      stage: current.stage,
    });
  }
  return points;
}
