import type { SimulationState, WorldEvent } from '../../src/game/eland/simulation';
import { calendarDate } from '../../src/game/eland/domain/calendar';
import {
  monthSpeaker,
  projectPlayerNarrative,
  toSocietyState,
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

export type FrameEntry = NarrativeEntryView;

export function entriesFor(state: SimulationState, events: WorldEvent[]): FrameEntry[] {
  return projectPlayerNarrative(state, events, 4);
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
          && entry.sourceEventIds.every((eventId) => deathEventIds.has(eventId)))
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

export function projectChronicle(frames: StoredFrame[], state: SimulationState | null): FrameEntry[] {
  const entries = frames.flatMap((frame) => frame.entries);
  if (!state) return entries;
  const foundingEntries = entriesFor(state, foundingEventsFor(state));
  const withFounding = foundingEntries.some((founding) => (
    !entries.some((entry) => entry.sourceEventIds.some((eventId) => founding.sourceEventIds.includes(eventId)))
  )) ? [...foundingEntries, ...entries] : entries;
  return withCivilizationEntries(state, state.lastStep, withFounding);
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
