/**
 * Immutable identity of the authority head that a month request is based on.
 * Keeping this separate from React makes stale-result rejection easy to test.
 */
export interface MonthAuthorityHead {
  runId: string;
  authorityRevision: string;
  civilizationId: number;
  branchId: string;
  elapsedMonths: number;
}

export interface MonthPlaybackTicket {
  sessionGeneration: number;
  base: MonthAuthorityHead;
  visibleSinceMs: number;
  playbackDurationMs: number;
}

export type MonthPrefetchVerdict =
  | 'accepted'
  | 'stale-generation'
  | 'stale-visible-head'
  | 'unacknowledged-sky'
  | 'unexpected-next-head';

export function sameMonthAuthorityHead(
  left: MonthAuthorityHead | null | undefined,
  right: MonthAuthorityHead | null | undefined,
): boolean {
  return Boolean(left && right
    && left.runId === right.runId
    && left.authorityRevision === right.authorityRevision
    && left.civilizationId === right.civilizationId
    && left.branchId === right.branchId
    && left.elapsedMonths === right.elapsedMonths);
}

export function createMonthPlaybackTicket(
  sessionGeneration: number,
  base: MonthAuthorityHead,
  visibleSinceMs: number,
  playbackDurationMs: number,
): MonthPlaybackTicket {
  return {
    sessionGeneration,
    base: { ...base },
    visibleSinceMs,
    playbackDurationMs: Math.max(0, playbackDurationMs),
  };
}

/**
 * A prefetched frame is usable only as the direct successor of the frame that
 * is still visible. The sky acknowledgement is part of that contract: without
 * it, the server may merely be returning a recovery head for another request.
 */
export function inspectPrefetchedMonth(
  ticket: MonthPlaybackTicket,
  currentSessionGeneration: number,
  currentVisibleHead: MonthAuthorityHead | null | undefined,
  nextHead: MonthAuthorityHead | null | undefined,
  skySampleAcknowledged: boolean,
): MonthPrefetchVerdict {
  if (ticket.sessionGeneration !== currentSessionGeneration) return 'stale-generation';
  if (!sameMonthAuthorityHead(ticket.base, currentVisibleHead)) return 'stale-visible-head';
  if (!skySampleAcknowledged) return 'unacknowledged-sky';
  if (!nextHead
    || nextHead.runId !== ticket.base.runId
    || nextHead.authorityRevision !== ticket.base.authorityRevision
    || nextHead.civilizationId !== ticket.base.civilizationId
    || nextHead.branchId !== ticket.base.branchId
    || nextHead.elapsedMonths !== ticket.base.elapsedMonths + 1) {
    return 'unexpected-next-head';
  }
  return 'accepted';
}

/** Fast responses wait for the visible month's playback; slow ones have no extra delay. */
export function prefetchedMonthDelayMs(ticket: MonthPlaybackTicket, arrivedAtMs: number): number {
  return Math.max(0, ticket.visibleSinceMs + ticket.playbackDurationMs - arrivedAtMs);
}

/** Readable wall-clock budget for one projected utterance at 1x speed. */
export function speechTurnDurationMs(text: string): number {
  const visibleCharacters = text.trim().length;
  return Math.min(4_000, Math.max(1_200, 900 + visibleCharacters * 45));
}

export function speechPlaybackBaseDurationMs(
  baseDurationMs: number,
  speechTexts: readonly string[],
): number {
  const spokenDuration = speechTexts
    .filter((text) => text.trim().length > 0)
    .reduce((total, text) => total + speechTurnDurationMs(text), 0);
  return Math.max(baseDurationMs, spokenDuration);
}

export function resolveMonthPlaybackDurationMs(
  baseDurationMs: number,
  speed: number,
  minimumDurationMs: number,
  speechTexts: readonly string[] = [],
  minimumWallClockBudgetMs = 0,
): number {
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.max(
    minimumDurationMs,
    minimumWallClockBudgetMs,
    speechPlaybackBaseDurationMs(baseDurationMs, speechTexts) / safeSpeed,
  );
}

/**
 * Model latency is noisy. Rise immediately when a request overruns the
 * current visual budget, then decay slowly after faster responses so one good
 * month cannot reintroduce stop-start playback on the next ordinary spike.
 */
export function nextModelPlaybackBudgetMs(
  currentBudgetMs: number,
  observedRequestMs: number,
  minimumBudgetMs = 4_000,
  maximumBudgetMs = 20_000,
): number {
  const boundedMinimum = Math.max(0, minimumBudgetMs);
  const boundedMaximum = Math.max(boundedMinimum, maximumBudgetMs);
  const current = Math.min(boundedMaximum, Math.max(boundedMinimum, currentBudgetMs));
  if (!Number.isFinite(observedRequestMs) || observedRequestMs < 0) return current;
  const target = Math.min(
    boundedMaximum,
    Math.max(boundedMinimum, observedRequestMs * 1.15 + 250),
  );
  return Math.round(target >= current ? target : current * 0.8 + target * 0.2);
}
