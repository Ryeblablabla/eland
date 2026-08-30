import type { WorldEvent } from '../../src/game/eland/simulation';
import type { NarrativeEntryView, SpeechLineView } from '../../src/game/societyContract';
import {
  projectSpeechHistoryEntry,
  verifiedSpeechLinesBySourceEventId,
} from '../../src/game/eland/projection/speech-history';

export type ChronicleEventLookup = Pick<ReadonlyMap<string, WorldEvent>, 'get'>;

interface WeatherObservation {
  eventId: string;
  atMonth: number;
  orderInMonth: number;
  previousKind?: string;
  kind?: string;
  intensity?: number;
}

interface WeatherEpisode {
  id: string;
  startedAtMonth: number;
  lastAtMonth: number;
  firstText: string;
  observations: WeatherObservation[];
  importance: number;
  sourceEventIds: string[];
  sourceEventIdSet: Set<string>;
}

interface ChronicleRecord {
  entry: NarrativeEntryView;
  category: 'weather' | 'project' | 'harm' | 'other';
  firstMonth: number;
  lastMonth: number;
  sequence: number;
}

/**
 * Branch-local, rebuildable observer cache. It is deliberately kept outside
 * SimulationState: history grouping must never become a fact agents can read.
 */
export interface ChronicleProjectionState {
  throughMonth: number;
  nextSequence: number;
  records: Map<string, ChronicleRecord>;
  recordIdBySourceEventId: Map<string, string>;
  speechLinesBySourceEventId: Map<string, SpeechLineView>;
  ambiguousSpeechSourceEventIds: Set<string>;
  activeWeather: WeatherEpisode | null;
}

const WEATHER_EPISODE_GAP_MONTHS = 6;

const WEATHER_NAMES: Record<string, string> = {
  clear: '晴朗',
  rain: '降雨',
  storm: '风暴',
  drought: '干旱',
  snow: '降雪',
  fog: '浓雾',
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function weatherName(value: string | undefined): string {
  return value ? WEATHER_NAMES[value] ?? value : '未知天气';
}

function naturalList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]}和${values[1]}`;
  return `${values.slice(0, -1).join('、')}和${values.at(-1)}`;
}

function sourceEvents(entry: NarrativeEntryView, events: ChronicleEventLookup): WorldEvent[] {
  return entry.sourceEventIds.flatMap((eventId) => {
    const event = events.get(eventId);
    return event ? [event] : [];
  });
}

function weatherObservations(
  entry: NarrativeEntryView,
  events: ChronicleEventLookup,
): WeatherObservation[] {
  return sourceEvents(entry, events).flatMap((event): WeatherObservation[] => {
    if (event.kind !== 'environment' || event.change !== 'weather') return [];
    return [{
      eventId: event.id,
      atMonth: event.atMonth,
      orderInMonth: event.orderInMonth,
      ...(typeof event.diff.previousKind === 'string'
        ? { previousKind: event.diff.previousKind }
        : {}),
      ...(typeof event.diff.kind === 'string' ? { kind: event.diff.kind } : {}),
      ...(finiteNumber(event.diff.intensity) !== undefined
        ? { intensity: finiteNumber(event.diff.intensity) }
        : {}),
    }];
  }).sort((left, right) => left.atMonth - right.atMonth || left.orderInMonth - right.orderInMonth);
}

function categoryFor(
  entry: NarrativeEntryView,
  events: ChronicleEventLookup,
): ChronicleRecord['category'] {
  if (entry.id.startsWith('narrative:project:')) return 'project';
  const sources = sourceEvents(entry, events);
  if (sources.some((event) => event.kind === 'environment' && event.change === 'weather')) return 'weather';
  if (sources.some((event) => event.kind === 'environment'
    && (event.change === 'animal' || event.change === 'condition' || event.change === 'death'))) return 'harm';
  return 'other';
}

function weatherSequence(observations: WeatherObservation[]): string[] {
  const sequence: string[] = [];
  for (const observation of observations) {
    if (!sequence.length && observation.previousKind) sequence.push(observation.previousKind);
    if (observation.kind && sequence.at(-1) !== observation.kind) sequence.push(observation.kind);
  }
  return sequence;
}

function renderWeatherEpisode(episode: WeatherEpisode): NarrativeEntryView {
  const sequence = weatherSequence(episode.observations);
  const names = sequence.map(weatherName);
  const lastKind = sequence.at(-1);
  let text = episode.firstText;
  if (names.length === 2) {
    text = `天气由${names[0]}转为${names[1]}。`;
  } else if (names.length > 2) {
    if (names.length > 6) {
      const finalName = names.at(-1)!;
      const distinct = unique(names.slice(0, -1).filter((name) => name !== finalName));
      text = lastKind === 'clear'
        ? `地表天气在${naturalList(distinct)}之间反复变化，最后恢复晴朗。`
        : `地表天气在${naturalList(distinct)}之间反复变化，最后转为${finalName}。`;
    } else if (lastKind === 'clear') {
      const preceding = names[0] === '晴朗' ? names.slice(1, -1) : names.slice(0, -1);
      text = `地表经历${naturalList(preceding)}，随后恢复晴朗。`;
    } else {
      text = `地表天气先后经历${naturalList(names)}。`;
    }
  }
  const peakIntensity = episode.observations.reduce<number | undefined>((peak, observation) => (
    observation.intensity === undefined
      ? peak
      : peak === undefined ? observation.intensity : Math.max(peak, observation.intensity)
  ), undefined);
  const period = episode.startedAtMonth === episode.lastAtMonth
    ? `第 ${episode.startedAtMonth} 月`
    : `第 ${episode.startedAtMonth} 至 ${episode.lastAtMonth} 月`;
  const severe = episode.observations.some((observation) => (
    observation.kind === 'storm'
      || observation.kind === 'drought'
      || observation.kind === 'snow'
      || (observation.intensity ?? 0) >= 2
  ));
  return {
    id: episode.id,
    month: episode.lastAtMonth,
    text,
    detail: `${period}形成这一段天气过程${peakIntensity === undefined ? '' : `，最高强度为 ${peakIntensity}`}。`,
    tone: severe ? 'bad' : lastKind === 'clear' ? 'good' : 'plain',
    kind: 'epoch',
    importance: episode.importance,
    sourceEventIds: [...episode.sourceEventIds],
    actorIds: [],
  };
}

function deleteRecord(state: ChronicleProjectionState, recordId: string): ChronicleRecord | undefined {
  const existing = state.records.get(recordId);
  if (!existing) return undefined;
  state.records.delete(recordId);
  for (const sourceEventId of existing.entry.sourceEventIds) {
    if (state.recordIdBySourceEventId.get(sourceEventId) === recordId) {
      state.recordIdBySourceEventId.delete(sourceEventId);
    }
  }
  return existing;
}

function upsertRecord(
  state: ChronicleProjectionState,
  entry: NarrativeEntryView,
  category: ChronicleRecord['category'],
  firstMonth = entry.month,
  preferredSequence?: number,
): void {
  const existing = state.records.get(entry.id);
  const sequence = existing?.sequence ?? preferredSequence ?? state.nextSequence++;
  state.records.set(entry.id, {
    entry,
    category,
    firstMonth: Math.min(existing?.firstMonth ?? firstMonth, firstMonth),
    lastMonth: entry.month,
    sequence,
  });
  for (const sourceEventId of entry.sourceEventIds) {
    state.recordIdBySourceEventId.set(sourceEventId, entry.id);
  }
}

function projectEntryOverSources(
  state: ChronicleProjectionState,
  entry: NarrativeEntryView,
  category: ChronicleRecord['category'],
  events: ChronicleEventLookup,
): NarrativeEntryView {
  if (category !== 'project' && !sourceEvents(entry, events).some((event) => (
    event.kind === 'environment' && event.change === 'death'
  ))) return entry;

  const absorbedIds = unique(entry.sourceEventIds.flatMap((sourceEventId) => {
    const recordId = state.recordIdBySourceEventId.get(sourceEventId);
    return recordId && recordId !== entry.id ? [recordId] : [];
  }));
  if (!absorbedIds.length) return entry;
  const entrySourceIds = new Set(entry.sourceEventIds);
  const absorbed = absorbedIds.flatMap((recordId) => {
    const record = state.records.get(recordId);
    if (!record) return [];
    // Never let one overlapping project/death source swallow unrelated facts
    // from a mixed summary. Only a complete causal subset can be replaced.
    if (!record.entry.sourceEventIds.every((eventId) => entrySourceIds.has(eventId))) return [];
    if (category === 'project' && record.category !== 'other') return [];
    if (category === 'harm' && record.category !== 'harm') return [];
    return [record];
  });
  if (!absorbed.length) return entry;
  const earliest = absorbed.reduce((first, record) => (
    record.sequence < first.sequence ? record : first
  ));
  for (const record of absorbed) deleteRecord(state, record.entry.id);
  return {
    ...entry,
    importance: Math.max(entry.importance, ...absorbed.map((record) => record.entry.importance)),
    sourceEventIds: unique([...absorbed.flatMap((record) => record.entry.sourceEventIds), ...entry.sourceEventIds]),
    actorIds: unique([...absorbed.flatMap((record) => record.entry.actorIds), ...entry.actorIds]),
    // Keep the semantic entry id for projects. Causal death entries retain the
    // first harm id so a live client can replace the earlier attack in place.
    id: category === 'harm' ? earliest.entry.id : entry.id,
  };
}

export function createChronicleProjectionState(): ChronicleProjectionState {
  return {
    throughMonth: -1,
    nextSequence: 0,
    records: new Map(),
    recordIdBySourceEventId: new Map(),
    speechLinesBySourceEventId: new Map(),
    ambiguousSpeechSourceEventIds: new Set(),
    activeWeather: null,
  };
}

function indexSpeechLines(
  state: ChronicleProjectionState,
  speechLines: readonly SpeechLineView[],
  events: ChronicleEventLookup,
): void {
  const verified = verifiedSpeechLinesBySourceEventId(speechLines, events);
  for (const [sourceEventId, line] of verified) {
    if (state.ambiguousSpeechSourceEventIds.has(sourceEventId)) continue;
    const existing = state.speechLinesBySourceEventId.get(sourceEventId);
    if (!existing) {
      state.speechLinesBySourceEventId.set(sourceEventId, line);
      continue;
    }
    if (existing.id === line.id && existing.text.trim() === line.text.trim()) continue;
    state.speechLinesBySourceEventId.delete(sourceEventId);
    state.ambiguousSpeechSourceEventIds.add(sourceEventId);
  }
}

/**
 * Mutates one branch-local projection in place. Work is proportional to the
 * entries and newly referenced events in this month, not the complete past.
 */
export function advanceChronicleProjection(
  state: ChronicleProjectionState,
  throughMonth: number,
  entries: NarrativeEntryView[],
  events: ChronicleEventLookup,
  speechLines: readonly SpeechLineView[] = [],
): NarrativeEntryView[] {
  if (throughMonth < state.throughMonth) {
    throw new Error('文明纪事投影不能逆向推进');
  }
  if (state.activeWeather
    && throughMonth - state.activeWeather.lastAtMonth > WEATHER_EPISODE_GAP_MONTHS) {
    state.activeWeather = null;
  }
  indexSpeechLines(state, speechLines, events);
  const emitted: NarrativeEntryView[] = [];
  const emittedWeatherIds = new Set<string>();
  for (const rawEntry of entries) {
    const entry = projectSpeechHistoryEntry(
      rawEntry,
      state.speechLinesBySourceEventId,
      events,
    );
    const category = categoryFor(entry, events);
    const observations = category === 'weather' ? weatherObservations(entry, events) : [];
    if (observations.length) {
      for (const observation of observations) {
        const active = state.activeWeather;
        if (!active || observation.atMonth - active.lastAtMonth > WEATHER_EPISODE_GAP_MONTHS) {
          state.activeWeather = {
            id: `chronicle:weather:${observation.eventId}`,
            startedAtMonth: observation.atMonth,
            lastAtMonth: observation.atMonth,
            firstText: entry.text,
            observations: [],
            importance: entry.importance,
            sourceEventIds: [],
            sourceEventIdSet: new Set(),
          };
        }
        const episode = state.activeWeather!;
        if (episode.sourceEventIdSet.has(observation.eventId)) continue;
        episode.observations.push(observation);
        episode.sourceEventIds.push(observation.eventId);
        episode.sourceEventIdSet.add(observation.eventId);
        episode.lastAtMonth = Math.max(episode.lastAtMonth, observation.atMonth);
        episode.importance = Math.max(episode.importance, entry.importance);
      }
      const episode = state.activeWeather!;
      const projected = renderWeatherEpisode(episode);
      upsertRecord(state, projected, 'weather', episode.startedAtMonth);
      if (!emittedWeatherIds.has(projected.id)) {
        emittedWeatherIds.add(projected.id);
        emitted.push(projected);
      } else {
        emitted[emitted.findIndex((candidate) => candidate.id === projected.id)] = projected;
      }
      continue;
    }

    const sources = sourceEvents(entry, events);
    if (entry.tone === 'era'
      || entry.id.startsWith('narrative:civilization:')
      || sources.some((event) => event.kind === 'environment' && event.change === 'climate')) {
      state.activeWeather = null;
    }
    const projected = projectEntryOverSources(state, entry, category, events);
    const absorbedSequence = projected.id !== entry.id
      ? state.records.get(projected.id)?.sequence
      : undefined;
    upsertRecord(state, projected, category, projected.month, absorbedSequence);
    emitted.push(projected);
  }
  state.throughMonth = throughMonth;
  return emitted;
}

export function chronicleProjectionEntries(state: ChronicleProjectionState): NarrativeEntryView[] {
  return [...state.records.values()]
    .sort((left, right) => left.entry.month - right.entry.month || left.sequence - right.sequence)
    .map((record) => record.entry);
}

export function rebuildChronicleProjection(
  frames: Array<{
    elapsedMonths?: number;
    entries: NarrativeEntryView[];
    speechLines?: SpeechLineView[];
  }>,
  events: ChronicleEventLookup,
): ChronicleProjectionState {
  const state = createChronicleProjectionState();
  for (const frame of frames) {
    const throughMonth = frame.elapsedMonths
      ?? frame.entries.reduce((latest, entry) => Math.max(latest, entry.month), state.throughMonth);
    advanceChronicleProjection(state, throughMonth, frame.entries, events, frame.speechLines ?? []);
  }
  return state;
}

export function pruneChronicleProjection(
  state: ChronicleProjectionState,
  earliestMonth: number,
): void {
  for (const [recordId, record] of state.records.entries()) {
    if (record.lastMonth < earliestMonth) deleteRecord(state, recordId);
  }
  if (state.activeWeather && state.activeWeather.lastAtMonth < earliestMonth) {
    state.activeWeather = null;
  }
  for (const [sourceEventId, line] of state.speechLinesBySourceEventId) {
    if (line.month < earliestMonth) state.speechLinesBySourceEventId.delete(sourceEventId);
  }
}
