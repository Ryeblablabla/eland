import type { ActionFact, EnvironmentFact, SimulationState, WorldEvent } from '../model';
import type { PersonState } from '../person';
import { ageMonths } from '../person';
import {
  sharedActivityTickThreshold,
  youthfulSharedActivityTrustBonus,
} from '../personality';
import { applyRelationEvidence, relationshipPairKey } from '../relation';
import {
  companionLivingAnchor,
  companionSharesLivingArea,
  positionWithinLivingArea,
  REQUIRED_SHARED_LIVING_MONTHS,
  SHARED_LIVING_RELATION_EVIDENCE_INTERVAL_MONTHS,
} from '../shared-living';
import { livingPeople } from '../state-index';

function adverseRelationshipPair(event: WorldEvent): string | undefined {
  if (event.kind !== 'action') return undefined;
  if (event.action.kind === 'act'
    && event.action.operation === 'exert'
    && event.status === 'completed'
    && typeof event.diff.victimId === 'string') {
    return relationshipPairKey(event.who, event.diff.victimId);
  }
  if (event.action.kind === 'act'
    && event.action.operation === 'combine'
    && event.status === 'completed'
    && typeof event.diff.restrainedPersonId === 'string'
    && typeof event.diff.conditionId === 'string') {
    return relationshipPairKey(event.who, event.diff.restrainedPersonId);
  }
  if (event.action.kind === 'transfer'
    && event.diff.authorized === false
    && event.action.from.kind === 'person') {
    return relationshipPairKey(event.who, event.action.from.personId);
  }
  return undefined;
}

/** Personality turns 3..5 nearby action ticks into replayable relationship evidence. */
export function advanceSharedRelationshipExperience(
  state: SimulationState,
  currentMonthEvents: readonly WorldEvent[],
  atMonth: number,
): EnvironmentFact[] {
  const orderOffset = currentMonthEvents.length;
  const adversePairs = new Set(currentMonthEvents.flatMap((fact) => {
    const pair = adverseRelationshipPair(fact);
    return pair ? [pair] : [];
  }));
  const peopleById = new Map(livingPeople(state).map((person) => [person.id, person]));
  const sharedLivingAreaByPair = new Map(state.agreements
    .filter((agreement) => agreement.status === 'active' && agreement.proposal.kind === 'companion')
    .flatMap((agreement) => {
      const anchor = companionLivingAnchor(state, agreement);
      return anchor ? [[relationshipPairKey(agreement.partyIds[0]!, agreement.partyIds[1]!), anchor] as const] : [];
    }));
  const actionsByTick = new Map<number, ActionFact[]>();
  for (const fact of currentMonthEvents) {
    if (fact.kind !== 'action'
      || (fact.status !== 'completed' && fact.status !== 'progressed')
      || fact.action.kind === 'talk'
      || !peopleById.has(fact.who)) continue;
    const actions = actionsByTick.get(fact.actionTick) ?? [];
    actions.push(fact);
    actionsByTick.set(fact.actionTick, actions);
  }
  const pairActivity = new Map<string, {
    first: PersonState;
    second: PersonState;
    ticks: Set<number>;
    sourceEventIds: Set<string>;
    cellId: number;
  }>();
  for (const actions of actionsByTick.values()) {
    const actorActions = [...new Map(actions.map((fact) => [fact.who, fact])).values()]
      .sort((left, right) => left.who.localeCompare(right.who));
    for (let left = 0; left < actorActions.length; left += 1) {
      for (let right = left + 1; right < actorActions.length; right += 1) {
        const leftAction = actorActions[left];
        const rightAction = actorActions[right];
        const first = peopleById.get(leftAction.who);
        const second = peopleById.get(rightAction.who);
        if (!first || !second) continue;
        const pairKey = relationshipPairKey(first.id, second.id);
        const exactPlace = leftAction.toCellId === rightAction.toCellId && leftAction.toZ === rightAction.toZ;
        const livingAnchor = sharedLivingAreaByPair.get(pairKey);
        const sharedLivingPlace = Boolean(livingAnchor
          && positionWithinLivingArea({ cellId: leftAction.toCellId, z: leftAction.toZ }, livingAnchor)
          && positionWithinLivingArea({ cellId: rightAction.toCellId, z: rightAction.toZ }, livingAnchor));
        if (!exactPlace && !sharedLivingPlace) continue;
        const activity = pairActivity.get(pairKey) ?? {
          first,
          second,
          ticks: new Set<number>(),
          sourceEventIds: new Set<string>(),
          cellId: leftAction.toCellId,
        };
        activity.ticks.add(leftAction.actionTick);
        activity.sourceEventIds.add(leftAction.id);
        activity.sourceEventIds.add(rightAction.id);
        pairActivity.set(pairKey, activity);
      }
    }
  }
  const facts: EnvironmentFact[] = [];
  for (const [pairKey, activity] of [...pairActivity.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (adversePairs.has(pairKey)) continue;
    const qualifyingTicks = [...activity.ticks].sort((left, right) => left - right);
    const participants = [activity.first, activity.second].sort((left, right) => left.id.localeCompare(right.id));
    const relationshipDeltas = participants.map((observer) => {
      const other = participants.find((person) => person.id !== observer.id)!;
      const tickThreshold = sharedActivityTickThreshold(observer);
      const baseDelta = Math.floor(qualifyingTicks.length / tickThreshold);
      const youthTrustBonus = baseDelta > 0
        ? youthfulSharedActivityTrustBonus(ageMonths(observer, atMonth))
        : 0;
      return {
        observerId: observer.id,
        otherPersonId: other.id,
        tickThreshold,
        baseDelta,
        youthTrustBonus,
        trustDelta: baseDelta + youthTrustBonus,
        bondDelta: baseDelta,
      };
    });
    if (relationshipDeltas.every((delta) => delta.baseDelta <= 0)) continue;
    const mutualTrustDelta = Math.min(...relationshipDeltas.map((delta) => delta.trustDelta));
    const mutualBondDelta = Math.min(...relationshipDeltas.map((delta) => delta.bondDelta));
    const fact: EnvironmentFact = {
      id: `e-${atMonth}-environment-relationship-${orderOffset + facts.length}`,
      kind: 'environment',
      atMonth,
      orderInMonth: orderOffset + facts.length,
      cellId: activity.cellId,
      change: 'relationship',
      result: `${participants.map((person) => person.name).join('、')}本月共同活动 ${qualifyingTicks.length} 个规划刻度，按各自性格与年龄形成可追溯的共同经历`,
      diff: {
        process: 'shared-action-ticks',
        participantIds: participants.map((person) => person.id),
        qualifyingTicks,
        sharedActionTicks: qualifyingTicks.length,
        sourceEventIds: [...activity.sourceEventIds].sort(),
        relationshipDeltas,
        trustDelta: mutualTrustDelta,
        bondDelta: mutualBondDelta,
      },
    };
    for (const delta of relationshipDeltas) {
      if (delta.baseDelta <= 0) continue;
      const observer = participants.find((person) => person.id === delta.observerId)!;
      applyRelationEvidence(observer, delta.otherPersonId, fact.id, {
        trust: delta.trustDelta,
        bond: delta.bondDelta,
      }, { atMonth, kinds: ['substantive', 'shared-life'] });
    }
    facts.push(fact);
  }
  const establishedCompanions = state.agreements
    .filter((agreement) => agreement.status === 'active'
      && agreement.proposal.kind === 'companion'
      && agreement.companionEstablishedAtMonth !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const agreement of establishedCompanions) {
    const pairKey = relationshipPairKey(agreement.partyIds[0]!, agreement.partyIds[1]!);
    if (adversePairs.has(pairKey) || !companionSharesLivingArea(state, agreement)) continue;
    const lastCredited = Math.max(
      REQUIRED_SHARED_LIVING_MONTHS,
      agreement.lastCompanionRelationshipAtCoLocatedMonth ?? REQUIRED_SHARED_LIVING_MONTHS,
    );
    const uncreditedMonths = Math.max(0, agreement.coLocatedMonths - lastCredited);
    const relationshipDelta = Math.floor(uncreditedMonths / SHARED_LIVING_RELATION_EVIDENCE_INTERVAL_MONTHS);
    if (relationshipDelta <= 0) continue;
    const participants = agreement.partyIds
      .map((personId) => peopleById.get(personId))
      .filter((person): person is PersonState => Boolean(person))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (participants.length !== 2) continue;
    const creditedThrough = lastCredited + relationshipDelta * SHARED_LIVING_RELATION_EVIDENCE_INTERVAL_MONTHS;
    const sourceEventIds = [...agreement.sourceEventIds].slice(-24);
    const fact: EnvironmentFact = {
      id: `e-${atMonth}-environment-relationship-${orderOffset + facts.length}`,
      kind: 'environment',
      atMonth,
      orderInMonth: orderOffset + facts.length,
      cellId: companionLivingAnchor(state, agreement)?.cellId ?? participants[0].position.cellId,
      change: 'relationship',
      result: `${participants.map((person) => person.name).join('、')}继续履行共同生活约定，累计 ${agreement.coLocatedMonths} 个真实共同生活月`,
      diff: {
        process: 'persistent-shared-living',
        agreementId: agreement.id,
        participantIds: participants.map((person) => person.id),
        sharedLivingMonths: agreement.coLocatedMonths,
        creditedThroughSharedLivingMonth: creditedThrough,
        sourceEventIds,
        trustDelta: relationshipDelta,
        bondDelta: relationshipDelta,
      },
    };
    agreement.lastCompanionRelationshipAtCoLocatedMonth = creditedThrough;
    agreement.sourceEventIds = [...new Set([...agreement.sourceEventIds, fact.id])];
    applyRelationEvidence(
      participants[0], participants[1].id, fact.id,
      { trust: relationshipDelta, bond: relationshipDelta },
      { atMonth, kinds: ['substantive', 'shared-life'] },
    );
    applyRelationEvidence(
      participants[1], participants[0].id, fact.id,
      { trust: relationshipDelta, bond: relationshipDelta },
      { atMonth, kinds: ['substantive', 'shared-life'] },
    );
    facts.push(fact);
  }
  return facts;
}
