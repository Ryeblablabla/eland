import type {
  DecisionAuthorityState,
  SimulationState,
  WorldEvent,
  WorldHistoryCursorV1,
} from './model';

export interface CommittedHistoryView {
  /** Always zero on the full-state runtime path. */
  hotStartIndex: number;
  /** Number of committed events represented by the array prefix. */
  hotEventCount: number;
  /** Absolute number of committed events. */
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
    || cursor.hotStartIndex !== 0
    || (cursor.eventCount === 0 ? cursor.tailEventId !== null : typeof cursor.tailEventId !== 'string')) {
    throw new Error('运行历史 cursor 内容无效');
  }
  const hotEventCount = cursor.eventCount;
  if (events.length < hotEventCount) {
    throw new Error('运行历史缺少已提交事件');
  }
  if (hotEventCount > 0 && events[hotEventCount - 1]?.id !== cursor.tailEventId) {
    throw new Error('运行历史末事件与 cursor 不一致');
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

function requiredHistoryCursor(
  state: Pick<DecisionAuthorityState, 'world'>,
): WorldHistoryCursorV1 {
  const cursor = state.world.historyCursor;
  if (!cursor) {
    throw new Error('运行状态缺少 history cursor；旧状态必须先经可信恢复边界迁移');
  }
  assertHistoryCursor(cursor, state.world.past);
  return cursor;
}

export function historyEventCount(
  state: Pick<DecisionAuthorityState, 'world'>,
): number {
  return requiredHistoryCursor(state).eventCount;
}

/**
 * Return a zero-copy committed view. Any temporary planning suffix in the same
 * array is excluded by `hotEventCount` and is not part of the cursor.
 */
export function committedHistoryView(
  state: Pick<DecisionAuthorityState, 'world'>,
): CommittedHistoryView {
  const cursor = requiredHistoryCursor(state);
  const hotEventCount = assertHistoryCursor(cursor, state.world.past);
  const events = state.world.past;
  return {
    hotStartIndex: cursor.hotStartIndex,
    hotEventCount,
    eventCount: cursor.eventCount,
    events,
    atAbsoluteIndex(index: number): WorldEvent | undefined {
      return index >= 0 && index < hotEventCount ? events[index] : undefined;
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
 * stale array before mutating either the array or the cursor.
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
