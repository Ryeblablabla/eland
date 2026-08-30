import type { SpeechLineView } from '@/game/societyContract';
import { speechTurnDurationMs } from '@/game/eland/month-playback-buffer';

/**
 * The server persists speech in turn order. Planning tick is the authoritative
 * position inside the month; insertion order breaks ties between an opening
 * and a response generated for the same tick.
 */
export function speechLinesInPlaybackOrder(
  lines: readonly SpeechLineView[],
): SpeechLineView[] {
  return lines
    .map((line, sourceIndex) => ({ line, sourceIndex }))
    .filter(({ line }) => (
      (line.source === 'decision-model' || line.source === 'speech-model')
      && line.text.trim().length > 0
    ))
    .sort((left, right) => (
      left.line.planningTick - right.line.planningTick
      || left.sourceIndex - right.sourceIndex
    ))
    .map(({ line }) => line);
}

/**
 * A month is a timeline, not a wall of the last few speakers. Give every
 * persisted model line one contiguous turn and hand the bubble to the next
 * line as playback advances. Fast-forward intentionally shortens those turns;
 * it never changes which people are allowed to appear.
 */
export function activeSpeechLineAtProgress(
  lines: readonly SpeechLineView[],
  progress: number,
): SpeechLineView | undefined {
  const ordered = speechLinesInPlaybackOrder(lines);
  if (ordered.length === 0) return undefined;
  const normalized = Number.isFinite(progress)
    ? Math.min(1, Math.max(0, progress))
    : 0;
  if (normalized >= 1) return ordered.at(-1);
  const durations = ordered.map((line) => speechTurnDurationMs(line.text));
  const totalDuration = durations.reduce((total, duration) => total + duration, 0);
  const cursor = normalized * totalDuration;
  let elapsed = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    elapsed += durations[index];
    if (cursor < elapsed) return ordered[index];
  }
  return ordered.at(-1);
}
