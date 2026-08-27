import {
  compareWorldEventsInCanonicalOrder,
  liveAgreementHistoryLeaseKey,
  liveIntentHistoryLeaseKey,
  parseWaterAssistanceEvidenceLeaseKey,
  registerProjectPressureEvidenceDescriptors,
  registerRetainedColdWorldEventFacts,
  waterAssistanceEvidenceLeaseKey,
  waterAssistanceFulfillmentMembershipGroupKey,
  type RetainedColdWorldEventFact,
} from '../src/game/eland/domain/event-index';
import {
  isHelperWaterAssistanceEvidence,
  isRequesterWaterAssistanceEvidence,
} from '../src/game/eland/domain/agreement';
import type { SimulationState } from '../src/game/eland/domain/model';
import {
  LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  projectPressureEvidenceDescriptorFromWorldEvent,
  type RetainedProjectPressureEvidenceDescriptor,
} from '../src/game/eland/domain/project-pressure-evidence';
import {
  FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
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

function projectPressureSourceGroup(projection: HistoryRetentionProjectionResult) {
  const groups = projection.demandGroups.filter((group) => (
    group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
  ));
  if (groups.length > 1) throw new Error('retention projection project-pressure broad group 重复');
  return groups[0];
}

/** Cold broad descriptors missing from already-decoded exact bundle pins. */
export function projectPressureColdMaterializationOrdinals(
  state: SimulationState,
  projection: HistoryRetentionProjectionResult,
  alreadyDecoded: readonly RunStatePinnedEvent[],
  reusableDescriptors: readonly RetainedProjectPressureEvidenceDescriptor[] = [],
  hotStartIndexOverride?: number,
): number[] {
  const cursor = state.world.historyCursor;
  if (!cursor || cursor.version !== 1) {
    throw new Error('计算 project-pressure descriptor 物化范围时缺少 history cursor');
  }
  const group = projectPressureSourceGroup(projection);
  if (!group) return [];
  const matches = new Map(
    projection.continuationBasis.directMatches.map((match) => [match.eventId, match]),
  );
  const available = new Map(alreadyDecoded.map((item) => [item.absoluteIndex, item.event.id]));
  for (const item of reusableDescriptors) {
    available.set(item.absoluteIndex, item.descriptor.eventId);
  }
  const hotStartIndex = hotStartIndexOverride ?? cursor.hotStartIndex;
  if (!Number.isSafeInteger(hotStartIndex)
    || hotStartIndex < cursor.hotStartIndex
    || hotStartIndex > cursor.eventCount) {
    throw new Error('project-pressure descriptor 目标 hotStartIndex 无效');
  }
  return group.resolvedEventIds.flatMap((eventId) => {
    const match = matches.get(eventId);
    if (!match || match.eventId !== eventId) {
      throw new Error(`project-pressure resolved source ${eventId} 缺少 direct match`);
    }
    if (match.absoluteIndex >= hotStartIndex) return [];
    return available.get(match.absoluteIndex) === eventId ? [] : [match.absoluteIndex];
  }).sort((left, right) => left - right);
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
 * V1 checkpoints before the intent split likewise combined executable core
 * anchors with audit provenance. Admit only a supporting-source promotion:
 * the decision and every executed action must already be resolved, while each
 * unresolved member must be explicitly named by this live intent's facts.
 */
function isLegacyIntentSupportingSourceOnlyBlocker(
  state: SimulationState,
  group: HistoryRetentionProjectionResult['demandGroups'][number],
): boolean {
  if (group.requirement !== 'all' || group.unresolvedEventIds.length === 0) return false;
  const intent = (state.intents ?? []).find((candidate) => (
    (candidate.status === 'active' || candidate.status === 'suspended')
      && liveIntentHistoryLeaseKey(candidate.id) === group.groupKey
  ));
  if (!intent || !Array.isArray(intent.actionEventIds)) return false;
  const coreEventIds = [intent.sourceDecisionEventId, ...intent.actionEventIds];
  const core = new Set(coreEventIds);
  const supporting = new Set((intent.sourceFactIds ?? [])
    .filter((eventId) => !core.has(eventId)));
  const resolved = new Set(group.resolvedEventIds);
  return coreEventIds.every((eventId) => resolved.has(eventId))
    && group.unresolvedEventIds.every((eventId) => supporting.has(eventId));
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
  decodedProjectPressureSources: readonly RunStatePinnedEvent[] = [],
  reusableProjectPressureDescriptors: readonly RetainedProjectPressureEvidenceDescriptor[] = [],
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
    && !isLegacyAgreementSupportingSourceOnlyBlocker(state, group)
    && !isLegacyIntentSupportingSourceOnlyBlocker(state, group));
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
    const gameplayLeaseKeys = pin.leaseKeys.filter(
      (leaseKey) => leaseKey !== LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
        && leaseKey !== FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
        && parseWaterAssistanceEvidenceLeaseKey(leaseKey) === null,
    );
    if (gameplayLeaseKeys.length > 0) retained.push({
      absoluteIndex: pin.absoluteIndex,
      eventId: pin.eventId,
      event: decoded.event,
      leaseKeys: gameplayLeaseKeys,
    });
  }
  for (const absoluteIndex of decodedByOrdinal.keys()) {
    if (!expectedColdOrdinals.has(absoluteIndex)) {
      throw new Error(`bounded decoder 返回 projection 未请求的冷 pin ${absoluteIndex}`);
    }
  }

  const directByEventId = new Map(
    projection.continuationBasis.directMatches.map((match) => [match.eventId, match]),
  );
  const pinByOrdinal = new Map(projection.pins.map((pin) => [pin.absoluteIndex, pin]));
  const retainedByOrdinal = new Map(retained.map((fact) => [fact.absoluteIndex, fact]));
  for (const agreement of state.agreements ?? []) {
    if (agreement.status !== 'active'
      || agreement.proposal.kind !== 'assist'
      || agreement.proposal.need !== 'water') continue;
    const proposal = agreement.proposal;
    const membershipGroupKey = waterAssistanceFulfillmentMembershipGroupKey(
      agreement.id,
      proposal.requesterId,
      proposal.helperId,
    );
    const typedMembership = projection.demandGroups.find((group) => (
      group.groupKey === membershipGroupKey
    ));
    const legacyCoreKey = liveAgreementHistoryLeaseKey(agreement.id);
    const projectedMembership = new Set(typedMembership
      ? typedMembership.eventIds
      : projection.demandGroups
        .filter((group) => group.groupKey === legacyCoreKey
          || group.groupKey === `${legacyCoreKey}:supporting-sources`)
        .flatMap((group) => group.eventIds));
    let latestHelper: { event: NonNullable<RunStatePinnedEvent['event']>; absoluteIndex: number } | undefined;
    let latestRequester: { event: NonNullable<RunStatePinnedEvent['event']>; absoluteIndex: number } | undefined;
    for (const eventId of new Set(agreement.fulfillmentEventIds)) {
      if (!projectedMembership.has(eventId)) continue;
      const match = directByEventId.get(eventId);
      if (!match || pinByOrdinal.get(match.absoluteIndex)?.eventId !== eventId) continue;
      const event = match.absoluteIndex >= cursor.hotStartIndex
        ? state.world.past[match.absoluteIndex - cursor.hotStartIndex]
        : decodedByOrdinal.get(match.absoluteIndex)?.event;
      if (!event || event.id !== eventId || event.kind !== 'action') continue;
      if (isHelperWaterAssistanceEvidence(state, proposal, event)
        && (!latestHelper
          || compareWorldEventsInCanonicalOrder(latestHelper.event, event) < 0)) {
        latestHelper = { event, absoluteIndex: match.absoluteIndex };
      }
      if (isRequesterWaterAssistanceEvidence(proposal, event)
        && (!latestRequester
          || compareWorldEventsInCanonicalOrder(latestRequester.event, event) < 0)) {
        latestRequester = { event, absoluteIndex: match.absoluteIndex };
      }
    }
    for (const [role, selected] of [
      ['helper', latestHelper],
      ['requester', latestRequester],
    ] as const) {
      if (!selected || selected.absoluteIndex >= cursor.hotStartIndex) continue;
      const leaseKey = waterAssistanceEvidenceLeaseKey(
        agreement.id,
        proposal.requesterId,
        proposal.helperId,
        role,
      );
      const current = retainedByOrdinal.get(selected.absoluteIndex);
      if (current) {
        if (current.eventId !== selected.event.id) {
          throw new Error(`water assistance anchor ordinal ${selected.absoluteIndex} 身份冲突`);
        }
        retainedByOrdinal.set(selected.absoluteIndex, {
          ...current,
          leaseKeys: [...new Set([...current.leaseKeys, leaseKey])].sort(),
        });
      } else {
        retainedByOrdinal.set(selected.absoluteIndex, {
          absoluteIndex: selected.absoluteIndex,
          eventId: selected.event.id,
          event: selected.event,
          leaseKeys: [leaseKey],
        });
      }
    }
  }
  const retainedWithWaterAnchors = [...retainedByOrdinal.values()]
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  registerRetainedColdWorldEventFacts(state, retainedWithWaterAnchors);

  const expectedProjectPressureOrdinals = projectPressureColdMaterializationOrdinals(
    state,
    projection,
    decodedColdPins,
    reusableProjectPressureDescriptors,
  );
  const expectedProjectPressureOrdinalSet = new Set(expectedProjectPressureOrdinals);
  const projectPressureByOrdinal = new Map<number, RunStatePinnedEvent>();
  for (const decoded of decodedProjectPressureSources) {
    if (!expectedProjectPressureOrdinalSet.has(decoded.absoluteIndex)
      || projectPressureByOrdinal.has(decoded.absoluteIndex)) {
      throw new Error(`project-pressure descriptor 返回未请求或重复 ordinal ${decoded.absoluteIndex}`);
    }
    projectPressureByOrdinal.set(decoded.absoluteIndex, decoded);
  }
  if (projectPressureByOrdinal.size !== expectedProjectPressureOrdinals.length) {
    throw new Error('project-pressure descriptor 冷事实物化不完整');
  }

  const group = projectPressureSourceGroup(projection);
  const directById = new Map(
    projection.continuationBasis.directMatches.map((match) => [match.eventId, match]),
  );
  const reusableByOrdinal = new Map<number, RetainedProjectPressureEvidenceDescriptor>();
  for (const item of reusableProjectPressureDescriptors) {
    if (reusableByOrdinal.has(item.absoluteIndex)) {
      throw new Error(`project-pressure reusable descriptor ordinal ${item.absoluteIndex} 重复`);
    }
    reusableByOrdinal.set(item.absoluteIndex, item);
  }
  const descriptorFacts = (group?.resolvedEventIds ?? []).map((eventId) => {
    const match = directById.get(eventId);
    if (!match) throw new Error(`project-pressure source ${eventId} 缺少 ordinal`);
    const event = match.absoluteIndex >= cursor.hotStartIndex
      ? state.world.past[match.absoluteIndex - cursor.hotStartIndex]
      : decodedByOrdinal.get(match.absoluteIndex)?.event
        ?? projectPressureByOrdinal.get(match.absoluteIndex)?.event;
    const reusable = reusableByOrdinal.get(match.absoluteIndex);
    if (event && event.id !== eventId) {
      throw new Error(`project-pressure source ${match.absoluteIndex}/${eventId} 物化身份不一致`);
    }
    if (!event && reusable?.descriptor.eventId !== eventId) {
      throw new Error(`project-pressure source ${match.absoluteIndex}/${eventId} 缺少已验证 descriptor`);
    }
    return Object.freeze({
      absoluteIndex: match.absoluteIndex,
      descriptor: event
        ? projectPressureEvidenceDescriptorFromWorldEvent(event)
        : reusable!.descriptor,
    });
  });
  registerProjectPressureEvidenceDescriptors(state, descriptorFacts);
  return retainedWithWaterAnchors;
}
