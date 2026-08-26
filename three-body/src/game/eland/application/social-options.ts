import type { ActionOption } from '../domain/action';
import type { SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { inventoryQuantity, sameLocation } from '../domain/person';
import { materialDefinition, materialHas } from '../domain/material';
import {
  acceptedAssistFor,
  acceptedCompanionBetween,
  hasOpenAssistRequestBetween,
  hasOpenCollectiveOfferBetween,
  hasOpenCompanionOfferBetween,
  hasOpenMembershipOfferFor,
  openAssistRequestFor,
  openCollectiveOfferFor,
  openCompanionOfferFor,
  openDecisionRuleOfferFor,
  openMandateOfferFor,
  openMembershipOfferFor,
  openPermissionOfferFor,
} from '../domain/social-facts';
import { cellX, cellY, cellsInRadius, findStandingPath } from '../world/grid';
import { RULE_ACTION_TICKS_PER_MONTH } from '../domain/calendar';
import { canAcceptAssist, compileAgreementContinuations } from './agreement-continuation';
import { activeCollectivesFor, activeMemberIds } from '../domain/collective';
import { activeMandatesFor } from '../domain/governance';
import { activePermissionsFor } from '../domain/permission';
import { findReachableWater } from '../domain/water-access';
import {
  buildRelationshipCausalBasis,
  canOfferRelationshipProposal,
  hasCultivatedCompanionRelationship,
} from '../domain/relationship-evidence';
import { buildGroundedConversationOptions } from './conversation-options';
import { personalityScore } from '../domain/personality';
import {
  livePersonSocialEvidenceLeaseKey,
  worldEventByIdWithRetainedLease,
} from '../domain/event-index';
import { agreementById, agreementsForPerson } from '../domain/agreement';
import { intentsOwnedBy, personById } from '../domain/state-index';
import {
  companionReturnRequired,
  companionLivingAnchor,
  personWithinLivingArea,
  sharedLivingReturnTarget,
  SHARED_LIVING_RADIUS,
} from '../domain/shared-living';
import {
  conversationalRendezvous,
  peopleWithinVoiceRange,
  positionsWithinVoiceRange,
} from '../domain/social-space';
import { relationTo } from '../domain/relation';

function groundedRelationSourceIds(state: SimulationState, person: PersonState, otherId: string): string[] {
  return (relationTo(person, otherId)?.sourceEventIds ?? [])
    .filter((eventId) => worldEventByIdWithRetainedLease(
      state,
      eventId,
      livePersonSocialEvidenceLeaseKey(person.id),
    ));
}

function reachableWater(state: SimulationState, person: PersonState) {
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return findReachableWater(state, person, cellsInRadius(person.position.cellId, radius));
}

function latestCollectiveAttemptMonth(state: SimulationState, firstId: string, secondId: string): number {
  return agreementsForPerson(state, firstId)
    .filter((agreement) => agreement.proposal.kind === 'collective'
      && agreement.partyIds.includes(firstId)
      && agreement.partyIds.includes(secondId))
    .reduce((latest, agreement) => Math.max(latest, agreement.proposedAtMonth), Number.NEGATIVE_INFINITY);
}

function completedAfter(project: SimulationState['projects'][number], month: number): boolean {
  return (project.completedAtMonth ?? project.lastProgressAtMonth ?? project.createdAtMonth) > month;
}

function companyAssistInFlightBetween(state: SimulationState, firstId: string, secondId: string): boolean {
  return agreementsForPerson(state, firstId).some((agreement) => (agreement.status === 'proposed' || agreement.status === 'active')
    && agreement.proposal.kind === 'assist'
    && agreement.proposal.need === 'company'
    && agreement.partyIds.includes(firstId)
    && agreement.partyIds.includes(secondId));
}

const COMPANY_REQUEST_REOFFER_MONTHS = 6;
const LOCAL_SOCIAL_ATTENTION_LIMIT = 3;

/**
 * A person can only appraise a few local relationships in one month, but the
 * bounded window must not make state insertion order a lifelong social fate.
 * The person-specific phase also keeps a whole settlement from focusing on
 * the same three people at once.
 */
function localSocialAttention(
  person: PersonState,
  localPeople: PersonState[],
  atMonth: number,
): PersonState[] {
  if (!localPeople.length) return [];
  const ordered = [...localPeople].sort((left, right) => left.id.localeCompare(right.id));
  const identityPhase = [...person.id].reduce((total, character) => total + character.charCodeAt(0), 0);
  const start = (identityPhase + atMonth) % ordered.length;
  return Array.from(
    { length: Math.min(LOCAL_SOCIAL_ATTENTION_LIMIT, ordered.length) },
    (_, index) => ordered[(start + index) % ordered.length]!,
  );
}

function canRequestCompanyWithCurrentBasis(
  state: SimulationState,
  requesterId: string,
  helperId: string,
  relationshipSourceFactIds: string[],
  atMonth: number,
): boolean {
  const previous = [...agreementsForPerson(state, requesterId)].reverse().find((agreement) => agreement.proposal.kind === 'assist'
    && agreement.proposal.need === 'company'
    && agreement.proposal.requesterId === requesterId
    && agreement.proposal.helperId === helperId);
  if (!previous) return true;
  if (previous.status === 'proposed' || previous.status === 'active') return false;
  const resolvedAtMonth = previous.resolvedAtMonth ?? previous.proposedAtMonth;
  if (atMonth - resolvedAtMonth < COMPANY_REQUEST_REOFFER_MONTHS) return false;
  return relationshipSourceFactIds.some((eventId) => {
    const event = worldEventByIdWithRetainedLease(
      state,
      eventId,
      livePersonSocialEvidenceLeaseKey(requesterId),
    );
    return Boolean(event && event.atMonth > previous.proposedAtMonth);
  });
}

function assistAlreadyPerformedBy(
  state: SimulationState,
  agreementId: string,
  helperId: string,
): boolean {
  const agreement = agreementById(state, agreementId);
  return Boolean(agreement
    && agreement.proposal.kind === 'assist'
    && (agreement.status === 'fulfilled' || agreement.fulfilledByPersonIds.includes(helperId)));
}

function responseOption(state: SimulationState, person: PersonState, referenceId: string, other: PersonState, accept: boolean, kind: 'assist' | 'companion' | 'collective' | 'permission' | 'decision-rule' | 'mandate'): ActionOption {
  const representationId = `${accept ? 'accept' : 'reject'}:${referenceId}:${person.id}`;
  const response = { kind: 'communicate' as const, content: accept
    ? { id: representationId, kind: 'accept' as const, referenceId }
    : { id: representationId, kind: 'reject' as const, referenceId }, audience: [other.id], channel: 'voice' as const };
  const together = positionsWithinVoiceRange(person.position, other.position);
  const rendezvous = conversationalRendezvous(state, person, other);
  const target = rendezvous?.position ?? other.position;
  const distance = Math.max(0, (rendezvous?.path.length ?? 1) - 1);
  return {
    id: `${accept ? 'accept' : 'reject'}-${kind}:${referenceId}`,
    summary: `${accept ? '接受' : '拒绝'}${other.name}的${kind === 'assist' ? '求助' : kind === 'companion' ? '结伴提议' : kind === 'collective' ? '共同体提议' : kind === 'permission' ? '物质取用许可' : kind === 'decision-rule' ? '共同决策规则' : '临时协调授权提议'}`,
    reason: '对方刚刚提出了一项需要回应的社会请求',
    goal: { kind: 'representation-made', representationId },
    nextAction: together ? response : { kind: 'move', toCellId: target.cellId, toZ: target.z },
    ...(!together ? { completionAction: response } : {}),
    target: { kind: 'person', personId: other.id },
    estimatedDuration: together ? 'one-month' : 'several-months',
    estimatedMonths: together ? 1 : Math.max(1, Math.ceil(distance / 15)),
    risks: [], domain: 'social', sourceFactIds: [],
  };
}

function membershipResponseOption(state: SimulationState, person: PersonState, referenceId: string, accept: boolean): ActionOption | null {
  const agreement = agreementById(state, referenceId);
  if (agreement?.status !== 'proposed' || agreement.proposal.kind !== 'membership') return null;
  const proposal = agreement.proposal;
  const proposer = personById(state, agreement.proposerId);
  if (!proposer) return null;
  const candidate = personById(state, proposal.candidateId);
  const representationId = `${accept ? 'accept' : 'reject'}:${referenceId}:${person.id}`;
  const joining = proposal.candidateId === person.id;
  const summary = joining
    ? `${accept ? '接受' : '拒绝'}加入“${state.collectives.find((collective) => collective.id === proposal.collectiveId)?.purposeSummary ?? '这个共同体'}”`
    : `${accept ? '同意' : '反对'}${candidate?.name ?? '候选人'}加入共同体`;
  const together = positionsWithinVoiceRange(person.position, proposer.position);
  const rendezvous = conversationalRendezvous(state, person, proposer);
  const target = rendezvous?.position ?? proposer.position;
  return {
    id: `${accept ? 'accept' : 'reject'}-membership:${referenceId}`,
    summary,
    reason: '共同体成员扩张需要候选人与所有现有成员分别作出有来源的回应',
    goal: { kind: 'representation-made', representationId },
    nextAction: together ? {
      kind: 'communicate',
      content: accept
        ? { id: representationId, kind: 'accept', referenceId, summary }
        : { id: representationId, kind: 'reject', referenceId, summary },
      audience: [proposer.id],
      channel: 'voice',
    } : { kind: 'move', toCellId: target.cellId, toZ: target.z },
    ...(!together ? {
      completionAction: {
        kind: 'communicate' as const,
        content: accept
          ? { id: representationId, kind: 'accept' as const, referenceId, summary }
          : { id: representationId, kind: 'reject' as const, referenceId, summary },
        audience: [proposer.id], channel: 'voice' as const,
      },
    } : {}),
    target: { kind: 'person', personId: proposer.id },
    estimatedDuration: together ? 'one-month' : 'several-months',
    estimatedMonths: together ? 1 : Math.max(1, Math.ceil(((rendezvous?.path.length ?? 1) - 1) / RULE_ACTION_TICKS_PER_MONTH)), risks: [], domain: 'social',
    sourceFactIds: [...agreement.sourceEventIds],
  };
}

export function buildSocialOptions(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  atMonth = state.clock.elapsedMonths,
): ActionOption[] {
  const options: ActionOption[] = [];
  const localPeople = visiblePeople.filter((other) => sameLocation(other, person));
  const conversationalPeople = peopleWithinVoiceRange(person, visiblePeople);
  options.push(...buildGroundedConversationOptions(state, person, visiblePeople, atMonth));
  const personCollectives = activeCollectivesFor(state, person.id);
  const recentJointProject = [...state.projects].reverse().find((project) => {
    const corePartnerId = project.contributorIds.find((personId) => personId !== project.ownerId);
    if (!corePartnerId) return false;
    const coreIds = [project.ownerId, corePartnerId];
    return project.status === 'completed'
      && project.site
      && project.completedAtMonth !== undefined
      && atMonth - project.completedAtMonth <= 12
      && coreIds.includes(person.id)
      && coreIds.some((personId) => personId !== person.id
        && personById(state, personId)?.diedAtMonth === undefined)
      && !coreIds.some((personId) => personId !== person.id
        && visiblePeople.some((candidate) => candidate.id === personId));
  });
  if (!personCollectives.length && recentJointProject?.site) {
    const site = recentJointProject.site;
    const alreadyThere = person.position.cellId === site.cellId && person.position.z === site.z;
    options.push({
      id: `rejoin-project-site:${recentJointProject.id}`,
      summary: alreadyThere
        ? `在共同完成“${recentJointProject.summary}”的地点停留，等待协作者重逢`
        : `回到共同完成“${recentJointProject.summary}”的地点寻找协作者`,
      reason: '不知道协作者现在身在何处，但本人记得共同劳动发生的地点；回到这个共享地点可能再次相遇',
      goal: { kind: 'at-cell', cellId: site.cellId },
      nextAction: { kind: 'move', toCellId: site.cellId, toZ: site.z },
      estimatedDuration: 'long',
      estimatedMonths: 6,
      completionPolicy: { kind: 'maintain-state', durationMonths: 6 },
      risks: [], domain: 'strategic', sourceFactIds: [...recentJointProject.completionEventIds],
    });
  }
  const requestedWaterAssist = [...agreementsForPerson(state, person.id)].reverse().find((agreement) => agreement.status === 'active'
    && agreement.proposal.kind === 'assist'
    && agreement.proposal.need === 'water'
    && agreement.proposal.requesterId === person.id);
  if (requestedWaterAssist?.proposal.kind === 'assist') {
    const proposal = requestedWaterAssist.proposal;
    const helper = personById(state, proposal.helperId);
    const helperRoute = helper && [...intentsOwnedBy(state, helper.id)].reverse().find((intent) => intent.ownerId === helper.id
      && intent.goal.kind === 'at-cell'
      && (intent.sourceFactIds ?? []).some((eventId) => requestedWaterAssist.sourceEventIds.includes(eventId)));
    if (helper && helperRoute?.goal.kind === 'at-cell' && person.position.cellId !== helperRoute.goal.cellId) {
      const path = findStandingPath(state.world.grid, person.position, { cellId: helperRoute.goal.cellId });
      if (path.length) options.push({
        id: `join-water-assist:${requestedWaterAssist.id}`,
        summary: `沿${helper.name}找到的路线去水边`,
        reason: '对方已经接受求助并开始前往一处可达水源',
        goal: { kind: 'at-cell', cellId: helperRoute.goal.cellId },
        nextAction: { kind: 'move', toCellId: helperRoute.goal.cellId },
        target: { kind: 'person', personId: helper.id },
        estimatedDuration: path.length <= RULE_ACTION_TICKS_PER_MONTH ? 'one-month' : 'several-months',
        estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / RULE_ACTION_TICKS_PER_MONTH)),
        risks: [], domain: 'social', sourceFactIds: [...requestedWaterAssist.sourceEventIds],
      });
    }
  }
  const acceptedAssist = acceptedAssistFor(state, person.id, atMonth);
  if (acceptedAssist) {
    const requester = personById(state, acceptedAssist.proposal.requesterId);
    const agreementId = acceptedAssist.request.action.kind === 'communicate'
      ? acceptedAssist.request.action.content.id
      : undefined;
    const alreadyHelped = agreementId
      ? assistAlreadyPerformedBy(state, agreementId, person.id)
      : false;
    if (requester && !alreadyHelped) {
      const food = person.inventory.find((stack) => materialHas(stack.materialId, 'edible') && stack.quantity > 0);
      const water = acceptedAssist.proposal.need === 'water' ? reachableWater(state, person) : null;
      const companyContinuation = acceptedAssist.proposal.need === 'company' && agreementId
        ? compileAgreementContinuations(state, agreementId, atMonth)
          .find((continuation) => continuation.personId === person.id)
        : undefined;
      if (companyContinuation) options.push({
        id: `fulfill-assist:${agreementId}`,
        summary: companyContinuation.summary,
        reason: '自己已经明确接受陪伴请求，且双方仍在同一地点，可以用真实共同在场履行承诺',
        goal: companyContinuation.goal,
        nextAction: companyContinuation.nextAction,
        ...(companyContinuation.target ? { target: companyContinuation.target } : {}),
        estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...companyContinuation.sourceFactIds],
      });
      else if (acceptedAssist.proposal.need === 'food' && food && sameLocation(requester, person)) options.push({
        id: `fulfill-assist:${acceptedAssist.request.id}`,
        summary: `履行承诺，把食物交给${requester.name}`,
        reason: '自己已经在对话中接受对方的求助',
        goal: { kind: 'inventory-at-least', materialId: food.materialId, quantity: inventoryQuantity(requester, food.materialId) + 1, personId: requester.id },
        nextAction: { kind: 'transfer', materialId: food.materialId, quantity: 1, from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: requester.id }, stackId: food.id, authorizationRef: acceptedAssist.request.action.kind === 'communicate' ? acceptedAssist.request.action.content.id : undefined },
        target: { kind: 'person', personId: requester.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [acceptedAssist.request.id, acceptedAssist.acceptance.id],
      });
      else if (acceptedAssist.proposal.need !== 'company' && !sameLocation(requester, person)) options.push({
        id: `meet-to-assist:${acceptedAssist.request.id}`,
        summary: `去与${requester.name}会合以履行帮助承诺`, reason: '已经接受求助，必须先回到对方身边',
        goal: { kind: 'near-person', personId: requester.id }, nextAction: { kind: 'move', toCellId: requester.position.cellId, toZ: requester.position.z },
        target: { kind: 'person', personId: requester.id }, estimatedDuration: 'several-months', estimatedMonths: 2,
        risks: [], domain: 'social', sourceFactIds: [acceptedAssist.request.id, acceptedAssist.acceptance.id],
      });
      else if (water) {
        const alreadyAtWater = water.bankPosition.cellId === person.position.cellId && water.bankPosition.z === person.position.z;
        const representationId = `show-water:${acceptedAssist.request.id}:${person.id}`;
        options.push({
          id: `fulfill-assist:${acceptedAssist.request.id}`,
          summary: alreadyAtWater ? `向${requester.name}指出身边的水` : `带${requester.name}去附近水边`,
          reason: '已经接受寻找水的求助，附近存在可达水源',
          goal: alreadyAtWater ? { kind: 'representation-made', representationId } : { kind: 'at-cell', cellId: water.bankPosition.cellId },
          nextAction: alreadyAtWater
            ? { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: '水就在我们身边，可以在这里饮用' }, audience: [requester.id], channel: 'voice' }
            : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z },
          target: { kind: 'person', personId: requester.id },
          estimatedDuration: water.pathLength <= RULE_ACTION_TICKS_PER_MONTH ? 'one-month' : 'several-months',
          estimatedMonths: Math.max(1, Math.ceil((water.pathLength - 1) / RULE_ACTION_TICKS_PER_MONTH)),
          risks: [], domain: 'social', sourceFactIds: [acceptedAssist.request.id, acceptedAssist.acceptance.id],
        });
      } else if (acceptedAssist.proposal.need !== 'company') {
        const representationId = `fulfill-assist:${acceptedAssist.request.id}:${person.id}`;
        options.push({
          id: representationId,
          summary: `回应${requester.name}并共同判断下一步`, reason: '已经接受求助，但当前没有可直接交付的物质',
          goal: { kind: 'representation-made', representationId },
          nextAction: { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: acceptedAssist.proposal.need === 'water' ? '我会和你一起寻找附近的水' : '我会陪你一起设法解决眼前困难' }, audience: [requester.id], channel: 'voice' },
          target: { kind: 'person', personId: requester.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
          risks: [], domain: 'social', sourceFactIds: [acceptedAssist.request.id, acceptedAssist.acceptance.id],
        });
      }
    }
  }

  for (const companionship of agreementsForPerson(state, person.id).filter((agreement) => agreement.status === 'active'
    && agreement.proposal.kind === 'companion'
    && agreement.partyIds.includes(person.id))) {
    const partnerId = companionship.partyIds.find((candidate) => candidate !== person.id);
    const partner = partnerId ? personById(state, partnerId) : undefined;
    if (partner && positionsWithinVoiceRange(person.position, partner.position)) {
      const representationId = `withdraw-companion:${atMonth}:${companionship.id}:${person.id}`;
      options.push({
        id: representationId,
        summary: `向${partner.name}明确结束共同生活关系`,
        reason: '共同生活关系持续有效但不剥夺任何一方退出的能力；退出必须由本人当面表达',
        goal: { kind: 'representation-made', representationId },
        nextAction: {
          kind: 'communicate',
          content: { id: representationId, kind: 'revoke-agreement', referenceId: companionship.id, summary: '我决定结束我们的共同生活关系' },
          audience: [partner.id], channel: 'voice',
        },
        target: { kind: 'person', personId: partner.id },
        estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...companionship.sourceEventIds],
      });
    }
    const anchor = companionLivingAnchor(state, companionship);
    if (!anchor || personWithinLivingArea(person, anchor) || !companionReturnRequired(companionship, atMonth)) continue;
    const target = sharedLivingReturnTarget(state, companionship, person);
    if (!target) continue;
    const path = findStandingPath(state.world.grid, person.position, target);
    options.push({
      id: `return-shared-living:${companionship.id}:${person.id}`,
      summary: '回到双方约定的共同生活地点',
      reason: companionship.companionEstablishedAtMonth !== undefined
        ? '已建立的共同生活承诺到达维护时点，需要回到协议中的固定地点，而不是追踪对方的实时位置'
        : '结伴约定已用完时间余量，需要回到协议中的固定地点履行共同生活，而不是追踪对方的实时位置',
      goal: { kind: 'at-cell', cellId: target.cellId },
      nextAction: { kind: 'move', toCellId: target.cellId, toZ: target.z },
      target: { kind: 'voxel', position: { x: cellX(target.cellId), y: cellY(target.cellId), z: target.z } },
      estimatedDuration: 'several-months',
      estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / RULE_ACTION_TICKS_PER_MONTH)),
      risks: [], domain: 'social', sourceFactIds: [...companionship.sourceEventIds],
    });
  }
  const incomingAssist = openAssistRequestFor(state, person.id);
  if (incomingAssist) {
    const requester = personById(state, incomingAssist.fact.who);
    if (requester) {
      const proposal = incomingAssist.content.proposal;
      const locallyPerceived = proposal?.kind !== 'assist'
        || proposal.need !== 'company'
        || visiblePeople.some((other) => other.id === requester.id);
      if (proposal?.kind === 'assist' && locallyPerceived) {
        if (canAcceptAssist(state, person, requester, proposal.need)) options.push({
          ...responseOption(state, person, incomingAssist.content.id, requester, true, 'assist'),
          sourceFactIds: [incomingAssist.fact.id],
        });
        options.push({
          ...responseOption(state, person, incomingAssist.content.id, requester, false, 'assist'),
          sourceFactIds: [incomingAssist.fact.id],
        });
      }
    }
  }
  const incomingCompanion = openCompanionOfferFor(state, person.id);
  if (incomingCompanion) {
    const proposer = personById(state, incomingCompanion.fact.who);
    if (proposer) {
      const responseBasis = buildRelationshipCausalBasis(state, person, proposer, 'companion', atMonth);
      if (hasCultivatedCompanionRelationship(state, person, proposer, responseBasis)) {
        options.push(responseOption(state, person, incomingCompanion.content.id, proposer, true, 'companion'));
      }
      options.push(responseOption(state, person, incomingCompanion.content.id, proposer, false, 'companion'));
    }
  }
  const incomingCollective = openCollectiveOfferFor(state, person.id);
  if (incomingCollective) {
    const proposer = personById(state, incomingCollective.fact.who);
    const proposal = incomingCollective.content.proposal;
    if (proposer && proposal?.kind === 'collective') {
      const canFormInitialCollective = activeCollectivesFor(state, person.id).length === 0
        && activeCollectivesFor(state, proposer.id).length === 0;
      if (canFormInitialCollective) options.push({ ...responseOption(state, person, incomingCollective.content.id, proposer, true, 'collective'), sourceFactIds: [incomingCollective.fact.id] });
      options.push({ ...responseOption(state, person, incomingCollective.content.id, proposer, false, 'collective'), sourceFactIds: [incomingCollective.fact.id] });
    }
  }
  const incomingPermission = openPermissionOfferFor(state, person.id);
  if (incomingPermission) {
    const grantor = personById(state, incomingPermission.fact.who);
    const proposal = incomingPermission.content.proposal;
    if (grantor && proposal?.kind === 'permission') {
      options.push({ ...responseOption(state, person, incomingPermission.content.id, grantor, true, 'permission'), sourceFactIds: [incomingPermission.fact.id] });
      options.push({ ...responseOption(state, person, incomingPermission.content.id, grantor, false, 'permission'), sourceFactIds: [incomingPermission.fact.id] });
    }
  }
  const incomingMembership = openMembershipOfferFor(state, person.id);
  if (incomingMembership) {
    const accept = membershipResponseOption(state, person, incomingMembership.content.id, true);
    const reject = membershipResponseOption(state, person, incomingMembership.content.id, false);
    if (accept) options.push(accept);
    if (reject) options.push(reject);
  }
  const incomingDecisionRule = openDecisionRuleOfferFor(state, person.id);
  if (incomingDecisionRule) {
    const proposer = personById(state, incomingDecisionRule.fact.who);
    if (proposer) {
      options.push(responseOption(state, person, incomingDecisionRule.content.id, proposer, true, 'decision-rule'));
      options.push(responseOption(state, person, incomingDecisionRule.content.id, proposer, false, 'decision-rule'));
    }
  }
  const incomingMandate = openMandateOfferFor(state, person.id);
  if (incomingMandate) {
    const proposer = personById(state, incomingMandate.fact.who);
    if (proposer) {
      options.push(responseOption(state, person, incomingMandate.content.id, proposer, true, 'mandate'));
      options.push(responseOption(state, person, incomingMandate.content.id, proposer, false, 'mandate'));
    }
  }

  const visibleJointPartner = visiblePeople.find((other) => {
    if (sameLocation(person, other)) return false;
    if (personCollectives.some((collective) => collective.status === 'active')
      || activeCollectivesFor(state, other.id).some((collective) => collective.status === 'active')) return false;
    if ((relationTo(person, other.id)?.trust ?? 0) < 6) return false;
    if (hasOpenCollectiveOfferBetween(state, person.id, other.id)
      || hasOpenCollectiveOfferBetween(state, other.id, person.id)) return false;
    const lastAttempt = latestCollectiveAttemptMonth(state, person.id, other.id);
    return state.projects.some((project) => project.status === 'completed'
      && project.ownerId === person.id
      && project.contributorIds.find((personId) => personId !== project.ownerId) === other.id
      && project.completionEventIds.length > 0
      && completedAfter(project, lastAttempt));
  });
  if (visibleJointPartner) {
    const lastAttempt = latestCollectiveAttemptMonth(state, person.id, visibleJointPartner.id);
    const sharedProject = [...state.projects].reverse().find((project) => project.status === 'completed'
      && project.ownerId === person.id
      && project.contributorIds.find((personId) => personId !== project.ownerId) === visibleJointPartner.id
      && project.completionEventIds.length > 0
      && completedAfter(project, lastAttempt))!;
    const representationId = `offer-collective:${atMonth}:${person.id}:${visibleJointPartner.id}`;
    const purposeSummary = `继续协作完成${sharedProject.kind === 'construction' ? '共同住所与环境改造' : '共同生产目标'}`;
    const offer = {
      kind: 'communicate' as const,
      content: {
        id: representationId,
        kind: 'offer' as const,
        summary: `我们已经一起完成过“${sharedProject.summary}”，愿不愿意以后继续${purposeSummary}？`,
        proposal: {
          kind: 'collective' as const,
          proposerId: person.id,
          partnerId: visibleJointPartner.id,
          purposeSummary,
          expiresAtMonth: atMonth + 6,
        },
      },
      audience: [visibleJointPartner.id], channel: 'voice' as const,
    };
    const path = findStandingPath(state.world.grid, person.position, visibleJointPartner.position);
    if (path.length) options.push({
      id: representationId,
      summary: `去找${visibleJointPartner.name}，提议延续已经成功的项目合作`,
      reason: '共同项目已经完成并留下双方贡献证据，这项合作记忆仍值得转化为持续成员关系',
      goal: { kind: 'representation-made', representationId },
      nextAction: { kind: 'move', toCellId: visibleJointPartner.position.cellId, toZ: visibleJointPartner.position.z },
      completionAction: offer,
      target: { kind: 'person', personId: visibleJointPartner.id },
      estimatedDuration: 'several-months',
      estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / RULE_ACTION_TICKS_PER_MONTH)),
      risks: [], domain: 'social', sourceFactIds: [...sharedProject.completionEventIds],
    });
  }

  for (const collective of personCollectives) {
    const memberIds = new Set(activeMemberIds(state, collective));
    const localMember = conversationalPeople.find((other) => memberIds.has(other.id));
    const relations = activeMemberIds(state, collective)
      .filter((id) => id !== person.id)
      .map((id) => relationTo(person, id));
    const membershipUnderStrain = relations.some((relation) => (relation?.trust ?? 0) <= -8 || (relation?.fear ?? 0) >= 55);
    if (localMember && membershipUnderStrain) {
      const representationId = `withdraw:${atMonth}:${collective.id}:${person.id}`;
      options.push({
        id: `withdraw-collective:${collective.id}`,
        summary: `向${localMember.name}声明退出共同体`,
        reason: '共同体内部的低信任或恐惧已经超过继续维持成员关系的收益',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'withdraw', collectiveId: collective.id, summary: '我不再作为这个共同体的成员继续行动' }, audience: [localMember.id], channel: 'voice' },
        target: { kind: 'person', personId: localMember.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...collective.sourceEventIds, ...(relationTo(person, localMember.id)?.sourceEventIds ?? [])],
      });
    }
    if (localMember) {
      const ownShareable = person.inventory.find((stack) => stack.quantity >= 2
        && !state.permissions.some((permission) => permission.status === 'active'
          && permission.collectiveId === collective.id
          && permission.grantorId === person.id
          && permission.granteeId === localMember.id
          && permission.materialId === stack.materialId)
        && !agreementsForPerson(state, person.id).some((agreement) => agreement.status === 'proposed'
          && agreement.proposal.kind === 'permission'
          && agreement.proposal.grantorId === person.id
          && agreement.proposal.granteeId === localMember.id
          && agreement.proposal.materialId === stack.materialId));
      if (ownShareable) {
        const representationId = `offer-permission:${atMonth}:${collective.id}:${person.id}:${localMember.id}:${ownShareable.materialId}`;
        options.push({
          id: representationId,
          summary: `允许${localMember.name}在需要时取用自己的${materialDefinition(ownShareable.materialId).name}`,
          reason: '彼此已有持续成员身份，可以明确协商具体物质的取用边界',
          goal: { kind: 'representation-made', representationId },
          nextAction: {
            kind: 'communicate',
            content: { id: representationId, kind: 'offer', summary: `你可以在需要时每次取用我的一份${materialDefinition(ownShareable.materialId).name}`, proposal: {
              kind: 'permission', proposerId: person.id, partnerId: localMember.id,
              collectiveId: collective.id, grantorId: person.id, granteeId: localMember.id,
              materialId: ownShareable.materialId, maxQuantityPerTransfer: 1,
              validUntilMonth: atMonth + 24, expiresAtMonth: atMonth + 6,
            } },
            audience: [localMember.id], channel: 'voice',
          },
          target: { kind: 'person', personId: localMember.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
          risks: [], domain: 'social', sourceFactIds: [...collective.sourceEventIds, ...ownShareable.sourceEventIds],
        });
      }
    }
    const allMembersHere = activeMemberIds(state, collective).every((id) => {
      const member = personById(state, id);
      return Boolean(member && positionsWithinVoiceRange(member.position, person.position));
    });
    const activeMembers = activeMemberIds(state, collective)
      .flatMap((id) => personById(state, id) ?? []);
    const requiredMemberApprovals = activeMembers.map((member) => member.id).filter((id) => id !== person.id);
    const initiativeMember = [...activeMembers].sort((a, b) =>
      (b.motiveSensitivity.status + personalityScore(b, 'extraversion') * 0.35 + b.baselineCapacities.cognition)
        - (a.motiveSensitivity.status + personalityScore(a, 'extraversion') * 0.35 + a.baselineCapacities.cognition)
      || a.id.localeCompare(b.id))[0];
    const pendingDecisionRule = agreementsForPerson(state, person.id).some((agreement) => agreement.status === 'proposed'
      && agreement.proposal.kind === 'decision-rule'
      && agreement.proposal.collectiveId === collective.id);
    if (allMembersHere
      && initiativeMember?.id === person.id
      && !collective.decisionRules.some((rule) => rule.status === 'active')
      && !pendingDecisionRule) {
      const groupMaterials = new Map<number, number>();
      for (const member of activeMembers) for (const stack of member.inventory) {
        if (stack.quantity > 0) groupMaterials.set(stack.materialId, (groupMaterials.get(stack.materialId) ?? 0) + stack.quantity);
      }
      const coordinationCandidate = [...groupMaterials]
        .filter(([materialId, total]) => {
          const quantities = activeMembers.map((member) => inventoryQuantity(member, materialId));
          const unequalAccess = Math.max(...quantities) >= 2 && Math.min(...quantities) === 0;
          const immediateNeed = materialHas(materialId, 'edible')
            && activeMembers.some((member) => member.body.nutrition < 68);
          const projectNeed = state.projects.some((project) => project.status === 'active'
            && project.missingMaterialIds.includes(materialId)
            && project.beneficiaryIds.some((personId) => memberIds.has(personId)));
          return total >= 2 && unequalAccess && (immediateNeed || projectNeed);
        })
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (coordinationCandidate) {
        const [materialId] = coordinationCandidate;
        const representationId = `offer-decision-rule:${atMonth}:${collective.id}:${person.id}:${materialId}`;
        options.push({
          id: representationId,
          summary: `提议以全体同意选择${materialDefinition(materialId).name}的临时协调者`,
          reason: '共同体成员对同一种必需物的持有明显不均，且已经出现身体或项目需求；需要先共同接受如何选择临时协调者',
          goal: { kind: 'representation-made', representationId },
          nextAction: {
            kind: 'communicate',
            content: { id: representationId, kind: 'offer', summary: `以后由谁临时协调${materialDefinition(materialId).name}，必须每位成员都明确同意`, proposal: {
              kind: 'decision-rule', proposerId: person.id, partnerId: requiredMemberApprovals[0]!,
              collectiveId: collective.id, requiredApproverIds: requiredMemberApprovals,
              method: 'unanimous', scope: 'coordinate-material', materialId,
              mandateDurationMonths: 12, expiresAtMonth: atMonth + 6,
            } },
            audience: requiredMemberApprovals, channel: 'voice',
          },
          estimatedDuration: 'one-month', estimatedMonths: 1,
          risks: ['任何一名成员拒绝都会使规则提议终止'], domain: 'social', sourceFactIds: [...collective.sourceEventIds],
        });
      }
    }
    const rule = collective.decisionRules.find((candidate) => candidate.status === 'active');
    const activeMandate = collective.mandates.find((candidate) => candidate.status === 'active' && candidate.decisionRuleId === rule?.id);
    const pendingMandate = agreementsForPerson(state, person.id).some((agreement) => agreement.status === 'proposed'
      && agreement.proposal.kind === 'mandate'
      && agreement.proposal.collectiveId === collective.id);
    const lastMandate = [...collective.mandates]
      .filter((candidate) => candidate.decisionRuleId === rule?.id)
      .sort((a, b) => (b.endedAtMonth ?? b.validUntilMonth) - (a.endedAtMonth ?? a.validUntilMonth))[0];
    const renewalReady = !lastMandate
      || atMonth - (lastMandate.endedAtMonth ?? lastMandate.validUntilMonth) >= 24;
    if (allMembersHere
      && initiativeMember?.id === person.id
      && rule
      && !activeMandate
      && !pendingMandate
      && renewalReady) {
      const holder = [...activeMembers].sort((a, b) => inventoryQuantity(b, rule.materialId) - inventoryQuantity(a, rule.materialId)
        || (personalityScore(b, 'agreeableness') + personalityScore(b, 'conscientiousness') + b.baselineCapacities.communication)
          - (personalityScore(a, 'agreeableness') + personalityScore(a, 'conscientiousness') + a.baselineCapacities.communication)
        || a.id.localeCompare(b.id))[0];
      if (holder) {
        const representationId = `offer-mandate:${atMonth}:${collective.id}:${person.id}:${holder.id}:${rule.id}`;
        options.push({
          id: representationId,
          summary: `提议由${holder.name}限期协调${materialDefinition(rule.materialId).name}`,
          reason: '成员已经共同接受选择规则，现在可以分别判断由谁承担有限职责',
          goal: { kind: 'representation-made', representationId },
          nextAction: {
            kind: 'communicate',
            content: { id: representationId, kind: 'offer', summary: `我提议由${holder.name}在未来${rule.mandateDurationMonths}个月协调${materialDefinition(rule.materialId).name}`, proposal: {
              kind: 'mandate', proposerId: person.id, partnerId: requiredMemberApprovals[0]!,
              collectiveId: collective.id, decisionRuleId: rule.id, holderId: holder.id,
              requiredApproverIds: requiredMemberApprovals, expiresAtMonth: atMonth + 6,
            } },
            audience: requiredMemberApprovals, channel: 'voice',
          },
          target: { kind: 'person', personId: holder.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
          risks: ['授权有期限，且协调者不能强取任何成员的私人背包'], domain: 'social', sourceFactIds: [...rule.sourceEventIds],
        });
      }
    }
    const candidate = allMembersHere ? conversationalPeople.find((other) => {
      if (memberIds.has(other.id) || hasOpenMembershipOfferFor(state, collective.id, other.id)) return false;
      const relation = relationTo(person, other.id);
      const fulfilledTogether = agreementsForPerson(state, person.id).some((agreement) => agreement.status === 'fulfilled'
        && agreement.partyIds.includes(person.id)
        && agreement.partyIds.includes(other.id)
        && (agreement.proposal.kind === 'assist' || agreement.proposal.kind === 'exchange' || agreement.proposal.kind === 'companion'));
      return fulfilledTogether && (relation?.trust ?? 0) >= 6;
    }) : undefined;
    if (candidate) {
      const requiredApproverIds = [...new Set([...activeMemberIds(state, collective).filter((id) => id !== person.id), candidate.id])];
      const representationId = `offer-membership:${atMonth}:${collective.id}:${person.id}:${candidate.id}`;
      options.push({
        id: representationId,
        summary: `邀请${candidate.name}加入已有共同体`,
        reason: '候选人与发起者已有真实合作；候选人和每位现有成员都在场，可以分别表达同意或反对',
        goal: { kind: 'representation-made', representationId },
        nextAction: {
          kind: 'communicate',
          content: { id: representationId, kind: 'offer', summary: `我提议让${candidate.name}加入我们的共同体`, proposal: {
            kind: 'membership', proposerId: person.id, partnerId: candidate.id,
            collectiveId: collective.id, candidateId: candidate.id, requiredApproverIds,
            expiresAtMonth: atMonth + 6,
          } },
          audience: requiredApproverIds,
          channel: 'voice',
        },
        target: { kind: 'person', personId: candidate.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: ['任一现有成员或候选人拒绝，提议都会终止'], domain: 'social', sourceFactIds: [...collective.sourceEventIds],
      });
    }
  }

  for (const mandate of activeMandatesFor(state, person.id)
    .filter((candidate) => atMonth >= candidate.validFromMonth && atMonth <= candidate.validUntilMonth)) {
    const holder = personById(state, mandate.holderId);
    if (!holder) continue;
    if (person.id !== holder.id
      && sameLocation(person, holder)
      && mandate.contributionEventIds.length === 0) {
      const stack = person.inventory.find((item) => item.materialId === mandate.materialId && item.quantity >= 2);
      if (stack) options.push({
        id: `contribute-mandate:${mandate.id}:${stack.id}`,
        summary: `按共同授权自愿交给${holder.name}一份${materialDefinition(mandate.materialId).name}`,
        reason: '共同体已一致授权协调者，但私人持有物仍需本人逐次选择是否交付',
        goal: { kind: 'inventory-at-least', materialId: mandate.materialId, quantity: inventoryQuantity(holder, mandate.materialId) + 1, personId: holder.id },
        nextAction: { kind: 'transfer', materialId: mandate.materialId, quantity: 1, from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: holder.id }, stackId: stack.id, authorizationRef: mandate.id },
        target: { kind: 'person', personId: holder.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...mandate.sourceEventIds],
      });
    }
    if (person.id === holder.id && mandate.distributionEventIds.length < mandate.contributionEventIds.length) {
      const recipient = localPeople
        .filter((other) => activeCollectivesFor(state, other.id).some((collective) => collective.id === mandate.collectiveId))
        .sort((a, b) => Math.min(a.body.hydration, a.body.nutrition) - Math.min(b.body.hydration, b.body.nutrition) || a.id.localeCompare(b.id))[0];
      const stack = person.inventory.find((item) => item.materialId === mandate.materialId && item.quantity > 0);
      if (recipient && stack) options.push({
        id: `distribute-mandate:${mandate.id}:${stack.id}:${recipient.id}`,
        summary: `以协调者身份交给${recipient.name}一份${materialDefinition(mandate.materialId).name}`,
        reason: '本人持有共同体一致授予的有限协调职责，但每次分配仍须由本人行动',
        goal: { kind: 'inventory-at-least', materialId: mandate.materialId, quantity: inventoryQuantity(recipient, mandate.materialId) + 1, personId: recipient.id },
        nextAction: { kind: 'transfer', materialId: mandate.materialId, quantity: 1, from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: recipient.id }, stackId: stack.id, authorizationRef: mandate.id },
        target: { kind: 'person', personId: recipient.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...mandate.sourceEventIds],
      });
    }
  }

  for (const permission of activePermissionsFor(state, person.id)
    .filter((candidate) => atMonth >= candidate.validFromMonth && atMonth <= candidate.validUntilMonth)) {
    const grantor = personById(state, permission.grantorId);
    const grantee = personById(state, permission.granteeId);
    if (person.id === permission.granteeId && grantor && sameLocation(grantor, person)) {
      const stack = grantor.inventory.find((item) => item.materialId === permission.materialId && item.quantity > 0);
      if (stack) options.push({
        id: `use-permission:${permission.id}:${stack.id}`,
        summary: `依据许可从${grantor.name}处取用${materialDefinition(permission.materialId).name}`,
        reason: '授权人、被授权人、物质、单次数量与有效期都有可追溯许可',
        goal: { kind: 'inventory-at-least', materialId: permission.materialId, quantity: inventoryQuantity(person, permission.materialId) + 1 },
        nextAction: { kind: 'transfer', materialId: permission.materialId, quantity: 1, from: { kind: 'person', personId: grantor.id }, to: { kind: 'person', personId: person.id }, stackId: stack.id, authorizationRef: permission.id },
        target: { kind: 'person', personId: grantor.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...permission.sourceEventIds],
      });
    }
    if (person.id === permission.grantorId && grantee && positionsWithinVoiceRange(grantee.position, person.position)) {
      const representationId = `revoke-permission:${atMonth}:${permission.id}`;
      options.push({
        id: representationId,
        summary: `向${grantee.name}撤回${materialDefinition(permission.materialId).name}取用许可`,
        reason: '持有者对未来取用授权保留明确撤回能力',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'revoke', permissionId: permission.id, summary: `我撤回你对我的${materialDefinition(permission.materialId).name}的取用许可` }, audience: [grantee.id], channel: 'voice' },
        target: { kind: 'person', personId: grantee.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...permission.sourceEventIds],
      });
    }
  }

  for (const agreement of agreementsForPerson(state, person.id).filter((candidate) => candidate.status === 'active'
    && candidate.proposal.kind === 'assist'
    && candidate.proposal.need === 'company'
    && candidate.partyIds.includes(person.id))) {
    const otherId = agreement.partyIds.find((candidate) => candidate !== person.id);
    const other = otherId ? personById(state, otherId) : undefined;
    const relation = other ? relationTo(person, other.id) : undefined;
    const adverseRelationship = Boolean(relation?.sourceEventIds.length
      && relation.fear > Math.max(relation.trust, relation.bond));
    const severeBodyState = Math.min(person.body.health, person.body.hydration, person.body.nutrition) < 35;
    const acuteConditionSources = person.conditions
      .filter((condition) => condition.stage >= 3)
      .flatMap((condition) => condition.sourceEventIds);
    if (!other || !positionsWithinVoiceRange(person.position, other.position) || (!adverseRelationship && !severeBodyState && !acuteConditionSources.length)) continue;
    const representationId = `withdraw-company-assist:${atMonth}:${agreement.id}:${person.id}`;
    options.push({
      id: representationId,
      summary: `向${other.name}明确撤回这次陪伴约定`,
      reason: adverseRelationship
        ? '协议生效后出现了有来源的关系危险，本人可以明确退出'
        : '本人正经历严重身体状态，可以明确撤回尚未履行的陪伴承诺',
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: { id: representationId, kind: 'revoke-agreement', referenceId: agreement.id, summary: '我现在无法继续这次陪伴约定' },
        audience: [other.id], channel: 'voice',
      },
      target: { kind: 'person', personId: other.id },
      estimatedDuration: 'one-month', estimatedMonths: 1,
      risks: [], domain: 'social',
      sourceFactIds: [...new Set([
        ...agreement.sourceEventIds,
        ...(adverseRelationship ? relation?.sourceEventIds ?? [] : []),
        ...acuteConditionSources,
      ])],
    });
  }

  for (const other of localSocialAttention(person, conversationalPeople, atMonth)) {
    const relation = relationTo(person, other.id);
    const relationshipSourceFactIds = groundedRelationSourceIds(state, person, other.id);
    const companionBasis = buildRelationshipCausalBasis(state, person, other, 'companion', atMonth);
    const need: 'water' | 'food' | null = person.body.hydration < 45 ? 'water' : person.body.nutrition < 45 ? 'food' : null;
    if (need && !hasOpenAssistRequestBetween(state, person.id, other.id)) {
      const representationId = `request-assist:${atMonth}:${person.id}:${other.id}:${need}`;
      options.push({
        id: representationId,
        summary: `向${other.name}请求${need === 'water' ? '协助寻找水' : '食物帮助'}`,
        reason: '自己的生存储备下降，而身边存在可以沟通的人',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'request', summary: need === 'water' ? '请帮助我找到水' : '请帮助我取得食物', proposal: { kind: 'assist', requesterId: person.id, helperId: other.id, need, expiresAtMonth: atMonth + 4 } }, audience: [other.id], channel: 'voice' },
        target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social', sourceFactIds: [],
      });
    }
    const locallyApproachable = Math.max(0, relation?.trust ?? 0) + Math.max(0, relation?.bond ?? 0)
      >= Math.max(0, relation?.fear ?? 0);
    if (locallyApproachable
      && !hasCultivatedCompanionRelationship(state, person, other, companionBasis)
      && !companyAssistInFlightBetween(state, person.id, other.id)
      && canRequestCompanyWithCurrentBasis(state, person.id, other.id, relationshipSourceFactIds, atMonth)
      && !acceptedCompanionBetween(state, person.id, other.id, atMonth)) {
      const representationId = `request-assist:${atMonth}:${person.id}:${other.id}:company`;
      options.push({
        id: `request-company:${atMonth}:${person.id}:${other.id}`,
        summary: `请求${other.name}在这里陪伴自己一段时间`,
        reason: relationshipSourceFactIds.length
          ? '双方此刻同地，且本人记得彼此真实发生过的关系经历；可以请求而不能预设对方同意'
          : '双方此刻同地且可以直接沟通；这是一次低风险接近请求，不声称彼此已经建立关系',
        goal: { kind: 'representation-made', representationId },
        nextAction: {
          kind: 'communicate',
          content: {
            id: representationId,
            kind: 'request',
            summary: '愿不愿意留在这里陪我一段时间？',
            proposal: { kind: 'assist', requesterId: person.id, helperId: other.id, need: 'company', expiresAtMonth: atMonth + 4 },
          },
          audience: [other.id], channel: 'voice',
        },
        target: { kind: 'person', personId: other.id },
        estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: ['对方可以拒绝或在关系恶化时撤回'], domain: 'social',
        sourceFactIds: [...relationshipSourceFactIds],
      });
    }
    if (!hasOpenCompanionOfferBetween(state, person.id, other.id)
      && !acceptedCompanionBetween(state, person.id, other.id, atMonth)
      && canOfferRelationshipProposal(state, person, other, companionBasis)) {
      const representationId = `offer-companion:${atMonth}:${person.id}:${other.id}`;
      options.push({
        id: representationId,
        summary: `邀请${other.name}结伴行动`,
        reason: '彼此的信任与羁绊已达到结伴门槛，结伴可能降低长期风险',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'offer', summary: '希望以这里为稳定生活地点，各自行动但持续共同生活', proposal: { kind: 'companion', proposerId: person.id, partnerId: other.id, expiresAtMonth: atMonth + 6, basis: companionBasis, sharedLivingAnchor: { version: 'shared-living-anchor-v1', cellId: person.position.cellId, z: person.position.z, radius: SHARED_LIVING_RADIUS } } }, audience: [other.id], channel: 'voice' },
        target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social', sourceFactIds: companionBasis.sourceFactIds,
        relationshipBasis: companionBasis,
      });
    }
    const lastCollectiveAttempt = latestCollectiveAttemptMonth(state, person.id, other.id);
    const sharedFulfillment = [...agreementsForPerson(state, person.id)].reverse().find((agreement) => agreement.status === 'fulfilled'
      && agreement.partyIds.includes(person.id)
      && agreement.partyIds.includes(other.id)
      && (agreement.proposal.kind === 'assist' || agreement.proposal.kind === 'exchange' || agreement.proposal.kind === 'companion')
      && (agreement.resolvedAtMonth ?? agreement.proposedAtMonth) > lastCollectiveAttempt);
    const sharedJointProject = [...state.projects].reverse().find((project) => project.status === 'completed'
      && project.ownerId === person.id
      && project.contributorIds.find((personId) => personId !== project.ownerId) === other.id
      && project.completionEventIds.length > 0
      && completedAfter(project, lastCollectiveAttempt));
    if (!personCollectives.some((collective) => collective.status === 'active')
      && !activeCollectivesFor(state, other.id).some((collective) => collective.status === 'active')
      && (sharedFulfillment || sharedJointProject)
      && (relation?.trust ?? 0) >= 6
      && !hasOpenCollectiveOfferBetween(state, person.id, other.id)
      && !hasOpenCollectiveOfferBetween(state, other.id, person.id)) {
      const representationId = `offer-collective:${atMonth}:${person.id}:${other.id}`;
      const purposeSummary = sharedJointProject
        ? `继续协作完成${sharedJointProject.kind === 'construction' ? '共同住所与环境改造' : '共同生产目标'}`
        : sharedFulfillment?.proposal.kind === 'exchange'
          ? '持续交换物质并互相履约'
          : sharedFulfillment?.proposal.kind === 'companion'
            ? '长期结伴并共同生活'
            : '持续互助并共同应对生存压力';
      const sourceFactIds = sharedJointProject?.completionEventIds ?? sharedFulfillment?.sourceEventIds ?? [];
      options.push({
        id: representationId,
        summary: `邀请${other.name}把已经发生的合作延续为共同体`,
        reason: sharedJointProject
          ? '双方已经在同一项目中留下实质贡献与完成证据，可以自愿把协作延续为成员关系'
          : '双方已有真实履约与信任来源，可以自愿形成跨协议持续的成员关系',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'offer', summary: `我们已经一起做成过事情，愿不愿意以后继续${purposeSummary}？`, proposal: { kind: 'collective', proposerId: person.id, partnerId: other.id, purposeSummary, expiresAtMonth: atMonth + 6 } }, audience: [other.id], channel: 'voice' },
        target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...sourceFactIds],
      });
    }
  }

  return options;
}
