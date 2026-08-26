import type { SimulationState, WorldEvent, WorldHistoryCursorV1 } from './model';
import {
  hasPlanningEventOverlay,
  invalidateHotEventIndexAfterCommittedHistoryTrim,
} from './event-index';

export interface PersistedCommittedHistorySeal {
  readonly eventCount: number;
  readonly tailEventId: string | null;
}

export interface CommittedHistoryView {
  /** Absolute ordinal of `events[0]` in the authoritative ledger. */
  hotStartIndex: number;
  /** Number of committed events represented by the hot array prefix. */
  hotEventCount: number;
  /** Absolute number of committed events, including future cold history. */
  eventCount: number;
  /**
   * Backing array. Planning may temporarily append an uncommitted overlay, so
   * consumers must only read indices below `hotEventCount`.
   */
  events: readonly WorldEvent[];
  atAbsoluteIndex(index: number): WorldEvent | undefined;
}

function cursorFromFullHistory(events: readonly WorldEvent[]): WorldHistoryCursorV1 {
  return {
    version: 1,
    eventCount: events.length,
    hotStartIndex: 0,
    tailEventId: events.at(-1)?.id ?? null,
  };
}

function assertHistoryCursor(
  cursor: WorldHistoryCursorV1,
  events: readonly WorldEvent[],
): number {
  if (cursor.version !== 1
    || !Number.isSafeInteger(cursor.eventCount)
    || cursor.eventCount < 0
    || !Number.isSafeInteger(cursor.hotStartIndex)
    || cursor.hotStartIndex < 0
    || cursor.hotStartIndex > cursor.eventCount
    || (cursor.eventCount === 0 ? cursor.tailEventId !== null : typeof cursor.tailEventId !== 'string')) {
    throw new Error('运行历史 cursor 内容无效');
  }
  const hotEventCount = cursor.eventCount - cursor.hotStartIndex;
  if (events.length < hotEventCount) {
    throw new Error('运行历史热窗口缺少已提交事件');
  }
  if (hotEventCount > 0 && events[hotEventCount - 1]?.id !== cursor.tailEventId) {
    throw new Error('运行历史热窗口末事件与 cursor 不一致');
  }
  return hotEventCount;
}

/** Trusted schema-17 migration boundary. The supplied history must be full. */
export function initializeHistoryCursorFromFullHistory(
  state: SimulationState,
): WorldHistoryCursorV1 {
  state.world.historyCursor ??= cursorFromFullHistory(state.world.past);
  const cursor = state.world.historyCursor;
  const hotEventCount = assertHistoryCursor(cursor, state.world.past);
  if (cursor.hotStartIndex !== 0
    || hotEventCount !== state.world.past.length
    || cursor.eventCount !== state.world.past.length) {
    throw new Error('可迁移 schema-17 状态必须携带完整已提交历史');
  }
  return cursor;
}

function requiredHistoryCursor(state: SimulationState): WorldHistoryCursorV1 {
  const cursor = state.world.historyCursor;
  if (!cursor) {
    throw new Error('运行状态缺少 history cursor；旧状态必须先经可信恢复边界迁移');
  }
  assertHistoryCursor(cursor, state.world.past);
  return cursor;
}

export function historyEventCount(state: SimulationState): number {
  return requiredHistoryCursor(state).eventCount;
}

/**
 * Return a zero-copy committed view. Any temporary planning suffix in the same
 * array is excluded by `hotEventCount` and is not part of the absolute cursor.
 */
export function committedHistoryView(state: SimulationState): CommittedHistoryView {
  const cursor = requiredHistoryCursor(state);
  const hotEventCount = assertHistoryCursor(cursor, state.world.past);
  const events = state.world.past;
  return {
    hotStartIndex: cursor.hotStartIndex,
    hotEventCount,
    eventCount: cursor.eventCount,
    events,
    atAbsoluteIndex(index: number): WorldEvent | undefined {
      const offset = index - cursor.hotStartIndex;
      return offset >= 0 && offset < hotEventCount ? events[offset] : undefined;
    },
  };
}

/** Fail before a use case mutates any other authoritative field. */
export function assertCommittedHistoryAppendable(
  state: SimulationState,
): WorldHistoryCursorV1 {
  const cursor = requiredHistoryCursor(state);
  const hotEventCount = assertHistoryCursor(cursor, state.world.past);
  if (state.world.past.length !== hotEventCount) {
    throw new Error('当前 world.past 含未提交 planning overlay，不能追加权威历史');
  }
  return cursor;
}

/**
 * The only authoritative event-ledger append. It rejects a planning overlay or
 * stale/truncated hot array before mutating either the array or the cursor.
 */
export function appendCommittedEvents(
  state: SimulationState,
  events: readonly WorldEvent[],
): WorldHistoryCursorV1 {
  const cursor = assertCommittedHistoryAppendable(state);
  const nextEventCount = cursor.eventCount + events.length;
  if (!Number.isSafeInteger(nextEventCount)) throw new Error('运行历史事件数超出安全整数范围');
  if (events.length === 0) return cursor;
  state.world.past.push(...events);
  cursor.eventCount = nextEventCount;
  cursor.tailEventId = events.at(-1)!.id;
  return cursor;
}

/**
 * Drop an already persisted committed prefix while preserving the authoritative
 * hot-array identity. The caller must invoke this only after its exact state
 * root/history CAS has committed successfully; this domain helper neither
 * performs nor guesses persistence.
 *
 * Selective cold evidence is process-local infrastructure keyed by the same
 * array identity. It is intentionally left untouched: lease ownership and cold
 * pin expiry remain responsibilities of the verified adoption/retention layer.
 * In particular, this helper neither proves a CAS token, provisions leases for
 * facts becoming newly cold, nor reconciles `lastStep`; the future production
 * wrapper must close those authority seams before calling it.
 */
export function trimCommittedHistoryAfterPersistedCursor(
  state: SimulationState,
  persistedSeal: PersistedCommittedHistorySeal,
  hotEventLimit: number,
): WorldHistoryCursorV1 {
  if (!Number.isSafeInteger(hotEventLimit) || hotEventLimit < 0) {
    throw new Error('运行历史 hotEventLimit 必须是非负安全整数');
  }
  if (!persistedSeal
    || !Number.isSafeInteger(persistedSeal.eventCount)
    || persistedSeal.eventCount < 0
    || (persistedSeal.eventCount === 0
      ? persistedSeal.tailEventId !== null
      : typeof persistedSeal.tailEventId !== 'string')) {
    throw new Error('已持久化运行历史 seal 内容无效');
  }
  if (hasPlanningEventOverlay(state)) {
    throw new Error('当前存在 planning overlay，不能裁剪已提交历史');
  }
  const cursor = assertCommittedHistoryAppendable(state);
  if (persistedSeal.eventCount !== cursor.eventCount
    || persistedSeal.tailEventId !== cursor.tailEventId) {
    throw new Error('已持久化运行历史 seal 与当前 committed cursor 不一致');
  }

  const hotEventCount = cursor.eventCount - cursor.hotStartIndex;
  const retainedEventCount = Math.min(hotEventLimit, hotEventCount);
  const removedEventCount = hotEventCount - retainedEventCount;
  if (removedEventCount === 0) return cursor;
  state.world.past.splice(0, removedEventCount);
  cursor.hotStartIndex += removedEventCount;
  invalidateHotEventIndexAfterCommittedHistoryTrim(state);
  return cursor;
}
