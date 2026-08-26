import {
  liveAgreementHistoryLeaseKey,
  registerRetainedColdWorldEventFacts,
  type RetainedColdWorldEventFact,
} from '../src/game/eland/domain/event-index';
import type { SimulationState } from '../src/game/eland/domain/model';
import {
  HISTORY_RETENTION_REQUIREMENTS,
  assertHistoryRetentionProjectionMatchesShell,
  historyRetentionRequirementBlocks,
  historyRetentionRequirementPinsResolvedEvents,
  type HistoryRetentionProjectionResult,
} from './history-retention-projection';
import type { RunStatePinnedEvent } from './run-state-codec';

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function assertRetentionDemandSemantics(projection: HistoryRetentionProjectionResult): void {
  const groups = new Map<string, HistoryRetentionProjectionResult['demandGroups'][number]>();
  for (const group of projection.demandGroups) {
    if (groups.has(group.groupKey)
      || !HISTORY_RETENTION_REQUIREMENTS.includes(group.requirement)
      || !group.leaseKeys.length
      || group.leaseKeys.some((leaseKey) => typeof leaseKey !== 'string' || leaseKey.length === 0)) {
      throw new Error(`retention projection demand group ${group.groupKey} 非法`);
    }
    const eventIds = new Set(group.eventIds);
    const resolved = new Set(group.resolvedEventIds);
    const unresolved = new Set(group.unresolvedEventIds);
    if (eventIds.size !== group.eventIds.length
      || resolved.size !== group.resolvedEventIds.length
      || unresolved.size !== group.unresolvedEventIds.length
      || [...resolved].some((eventId) => unresolved.has(eventId) || !eventIds.has(eventId))
      || [...unresolved].some((eventId) => !eventIds.has(eventId))
      || resolved.size + unresolved.size !== eventIds.size) {
      throw new Error(`retention projection demand group ${group.groupKey} 的事件分组不一致`);
    }
    const satisfied = group.requirement === 'any' ? resolved.size > 0 : unresolved.size === 0;
    const blocking = historyRetentionRequirementBlocks(group.requirement) && !satisfied;
    if (group.satisfied !== satisfied || group.blocking !== blocking) {
      throw new Error(`retention projection demand group ${group.groupKey} 的满足语义不一致`);
    }
    groups.set(group.groupKey, group);
  }

  const unresolvedKeys = new Set<string>();
  for (const demand of projection.unresolvedDemands) {
    const group = groups.get(demand.groupKey);
    const key = `${demand.groupKey}\0${demand.eventId}`;
    if (!group
      || unresolvedKeys.has(key)
      || !group.unresolvedEventIds.includes(demand.eventId)
      || demand.requirement !== group.requirement
      || demand.blocking !== group.blocking
      || !sameStringSet(demand.leaseKeys, group.leaseKeys)) {
      throw new Error(`retention projection unresolved demand ${demand.groupKey}/${demand.eventId} 不一致`);
    }
    unresolvedKeys.add(key);
  }
  for (const group of groups.values()) {
    for (const eventId of group.unresolvedEventIds) {
      if (!unresolvedKeys.has(`${group.groupKey}\0${eventId}`)) {
        throw new Error(`retention projection 缺少 unresolved demand ${group.groupKey}/${eventId}`);
      }
    }
  }
}

function assertRetentionGroupPins(projection: HistoryRetentionProjectionResult): void {
  const pinsByEventId = new Map<string, HistoryRetentionProjectionResult['pins']>();
  for (const pin of projection.pins) {
    const pins = pinsByEventId.get(pin.eventId) ?? [];
    pins.push(pin);
    pinsByEventId.set(pin.eventId, pins);
  }
  for (const group of projection.demandGroups) {
    if (!historyRetentionRequirementPinsResolvedEvents(group.requirement)) continue;
    const pinnedResolvedIds = group.resolvedEventIds.filter((eventId) => (
      pinsByEventId.get(eventId)?.some((pin) => group.leaseKeys.every((leaseKey) => pin.leaseKeys.includes(leaseKey)))
    ));
    const complete = group.requirement === 'any'
      ? group.resolvedEventIds.length === 0 || pinnedResolvedIds.length > 0
      : pinnedResolvedIds.length === group.resolvedEventIds.length;
    if (!complete) throw new Error(`retention projection demand group ${group.groupKey} 缺少对应 lease pin`);
  }
}

/**
 * V1 checkpoints before the agreement split stored core and supporting
 * provenance in one `all` group. Admit that exact legacy shape only when the
 * current live agreement's proposal/response are both resolved; all other
 * blockers remain fail-closed. The next successor is published in split form.
 */
function isLegacyAgreementSupportingSourceOnlyBlocker(
  state: SimulationState,
  group: HistoryRetentionProjectionResult['demandGroups'][number],
): boolean {
  if (group.requirement !== 'all' || group.unresolvedEventIds.length === 0) return false;
  const agreement = (state.agreements ?? []).find((candidate) => (
    (candidate.status === 'active' || candidate.status === 'proposed')
      && liveAgreementHistoryLeaseKey(candidate.id) === group.groupKey
  ));
  if (!agreement) return false;
  const coreEventIds = [
    agreement.proposalEventId,
    ...(agreement.responseEventId ? [agreement.responseEventId] : []),
  ];
  const resolved = new Set(group.resolvedEventIds);
  const core = new Set(coreEventIds);
  return coreEventIds.every((eventId) => resolved.has(eventId))
    && group.unresolvedEventIds.every((eventId) => !core.has(eventId));
}

/**
 * Join a sealed retention projection to facts returned by the bounded decoder,
 * then install only the cold subset in the process-local domain lookup. Hot
 * leases are verified in place and continue through ordinary hot indexes.
 */
export function installVerifiedHistoryRetentionEvidence(
  state: SimulationState,
  expectedStateHash: string,
  projection: HistoryRetentionProjectionResult,
  decodedColdPins: readonly RunStatePinnedEvent[],
): readonly RetainedColdWorldEventFact[] {
  const cursor = state.world.historyCursor;
  if (!cursor || cursor.version !== 1) throw new Error('安装 retention evidence 时缺少 history cursor');
  if (!/^[a-f0-9]{64}$/u.test(expectedStateHash)
    || projection.schemaVersion !== 1
    || projection.authority?.stateHash !== expectedStateHash
    || projection.target.eventCount !== cursor.eventCount
    || projection.target.tailEventId !== cursor.tailEventId) {
    throw new Error('retention projection authority/seal 与 bounded state 不一致');
  }
  assertHistoryRetentionProjectionMatchesShell(state, projection);
  assertRetentionDemandSemantics(projection);
  assertRetentionGroupPins(projection);
  const blocking = projection.demandGroups.filter((group) => group.blocking
    && !isLegacyAgreementSupportingSourceOnlyBlocker(state, group));
  if (blocking.length) {
    throw new Error(`retention projection 仍有 ${blocking.length} 个阻断证据组`);
  }
  if (state.world.past.length !== cursor.eventCount - cursor.hotStartIndex) {
    throw new Error('安装 retention evidence 时 world.past 不是完整热窗口');
  }

  const decodedByOrdinal = new Map<number, RunStatePinnedEvent>();
  for (const decoded of decodedColdPins) {
    if (decodedByOrdinal.has(decoded.absoluteIndex)) {
      throw new Error(`bounded decoder 返回重复 pin 绝对序号 ${decoded.absoluteIndex}`);
    }
    decodedByOrdinal.set(decoded.absoluteIndex, decoded);
  }

  const expectedColdOrdinals = new Set<number>();
  const seenProjectionOrdinals = new Set<number>();
  const retained: RetainedColdWorldEventFact[] = [];
  for (const pin of projection.pins) {
    if (!Number.isSafeInteger(pin.absoluteIndex)
      || pin.absoluteIndex < 0
      || pin.absoluteIndex >= cursor.eventCount
      || typeof pin.eventId !== 'string'
      || pin.eventId.length === 0
      || !pin.leaseKeys.length
      || pin.leaseKeys.some((leaseKey) => typeof leaseKey !== 'string' || leaseKey.length === 0)
      || seenProjectionOrdinals.has(pin.absoluteIndex)) {
      throw new Error('retention projection 含非法 pin');
    }
    seenProjectionOrdinals.add(pin.absoluteIndex);
    if (pin.absoluteIndex >= cursor.hotStartIndex) {
      const hot = state.world.past[pin.absoluteIndex - cursor.hotStartIndex];
      if (hot?.id !== pin.eventId) {
        throw new Error(`retention hot pin ${pin.absoluteIndex}/${pin.eventId} 与热窗口不一致`);
      }
      continue;
    }
    expectedColdOrdinals.add(pin.absoluteIndex);
    const decoded = decodedByOrdinal.get(pin.absoluteIndex);
    if (!decoded || decoded.event.id !== pin.eventId) {
      throw new Error(`retention cold pin ${pin.absoluteIndex}/${pin.eventId} 未被准确解码`);
    }
    retained.push({
      absoluteIndex: pin.absoluteIndex,
      eventId: pin.eventId,
      event: decoded.event,
      leaseKeys: pin.leaseKeys,
    });
  }
  for (const absoluteIndex of decodedByOrdinal.keys()) {
    if (!expectedColdOrdinals.has(absoluteIndex)) {
      throw new Error(`bounded decoder 返回 projection 未请求的冷 pin ${absoluteIndex}`);
    }
  }
  registerRetainedColdWorldEventFacts(state, retained);
  return retained;
}
