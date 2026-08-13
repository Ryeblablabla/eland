import type { ActionOption } from '../domain/action';
import type { SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { inventoryQuantity } from '../domain/person';
import { Material, materialDefinition, materialHas } from '../domain/material';
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
  openMembershipOfferFor,
  openPermissionOfferFor,
} from '../domain/social-facts';
import { cellsInRadius, findPath, isPassable, neighbors4, surfaceMaterial } from '../world/grid';
import { RULE_ACTION_TICKS_PER_MONTH } from '../domain/calendar';
import { canAcceptAssist } from './agreement-continuation';
import { activeCollectivesFor, activeMemberIds } from '../domain/collective';
import { activePermissionsFor } from '../domain/permission';

function relationTo(person: PersonState, otherId: string) {
  return person.relations.find((relation) => relation.personId === otherId);
}

function reachableWaterBank(state: SimulationState, person: PersonState): { waterCell: number; bankCell: number; pathLength: number } | null {
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  const candidates = cellsInRadius(person.position.cellId, radius).flatMap((waterCell) => {
    if (surfaceMaterial(state.world.grid, waterCell) !== Material.Water) return [];
    return neighbors4(waterCell).flatMap((bankCell) => {
      if (!isPassable(state.world.grid, bankCell)) return [];
      const path = findPath(state.world.grid, person.position.cellId, bankCell);
      return path.length ? [{ waterCell, bankCell, pathLength: path.length }] : [];
    });
  });
  return candidates.sort((a, b) => a.pathLength - b.pathLength || a.waterCell - b.waterCell)[0] ?? null;
}

function responseOption(state: SimulationState, person: PersonState, referenceId: string, other: PersonState, accept: boolean, kind: 'assist' | 'companion' | 'collective' | 'permission'): ActionOption {
  const representationId = `${accept ? 'accept' : 'reject'}:${referenceId}:${person.id}`;
  const response = { kind: 'communicate' as const, content: accept
    ? { id: representationId, kind: 'accept' as const, referenceId }
    : { id: representationId, kind: 'reject' as const, referenceId }, audience: [other.id], channel: 'voice' as const };
  const together = person.position.cellId === other.position.cellId;
  const distance = Math.max(0, findPath(state.world.grid, person.position.cellId, other.position.cellId).length - 1);
  return {
    id: `${accept ? 'accept' : 'reject'}-${kind}:${referenceId}`,
    summary: `${accept ? '接受' : '拒绝'}${other.name}的${kind === 'assist' ? '求助' : kind === 'companion' ? '结伴提议' : kind === 'collective' ? '共同体提议' : '物质取用许可'}`,
    reason: '对方刚刚提出了一项需要回应的社会请求',
    goal: { kind: 'representation-made', representationId },
    nextAction: together ? response : { kind: 'move', toCellId: other.position.cellId },
    ...(!together ? { completionAction: response } : {}),
    target: { kind: 'person', personId: other.id },
    estimatedDuration: together ? 'one-month' : 'several-months',
    estimatedMonths: together ? 1 : Math.max(1, Math.ceil(distance / 15)),
    risks: [], domain: 'social', sourceFactIds: [],
  };
}

function membershipResponseOption(state: SimulationState, person: PersonState, referenceId: string, accept: boolean): ActionOption | null {
  const agreement = state.agreements.find((candidate) => candidate.id === referenceId && candidate.status === 'proposed' && candidate.proposal.kind === 'membership');
  if (!agreement || agreement.proposal.kind !== 'membership') return null;
  const proposal = agreement.proposal;
  const proposer = state.people.find((candidate) => candidate.id === agreement.proposerId);
  if (!proposer) return null;
  const candidate = state.people.find((other) => other.id === proposal.candidateId);
  const representationId = `${accept ? 'accept' : 'reject'}:${referenceId}:${person.id}`;
  const joining = proposal.candidateId === person.id;
  const summary = joining
    ? `${accept ? '接受' : '拒绝'}加入“${state.collectives.find((collective) => collective.id === proposal.collectiveId)?.purposeSummary ?? '这个共同体'}”`
    : `${accept ? '同意' : '反对'}${candidate?.name ?? '候选人'}加入共同体`;
  return {
    id: `${accept ? 'accept' : 'reject'}-membership:${referenceId}`,
    summary,
    reason: '共同体成员扩张需要候选人与所有现有成员分别作出有来源的回应',
    goal: { kind: 'representation-made', representationId },
    nextAction: person.position.cellId === proposer.position.cellId ? {
      kind: 'communicate',
      content: accept
        ? { id: representationId, kind: 'accept', referenceId, summary }
        : { id: representationId, kind: 'reject', referenceId, summary },
      audience: [proposer.id],
      channel: 'voice',
    } : { kind: 'move', toCellId: proposer.position.cellId },
    ...(person.position.cellId !== proposer.position.cellId ? {
      completionAction: {
        kind: 'communicate' as const,
        content: accept
          ? { id: representationId, kind: 'accept' as const, referenceId, summary }
          : { id: representationId, kind: 'reject' as const, referenceId, summary },
        audience: [proposer.id], channel: 'voice' as const,
      },
    } : {}),
    target: { kind: 'person', personId: proposer.id },
    estimatedDuration: person.position.cellId === proposer.position.cellId ? 'one-month' : 'several-months',
    estimatedMonths: person.position.cellId === proposer.position.cellId ? 1 : 2, risks: [], domain: 'social',
    sourceFactIds: [...agreement.sourceEventIds],
  };
}

export function buildSocialOptions(state: SimulationState, person: PersonState, visiblePeople: PersonState[]): ActionOption[] {
  const options: ActionOption[] = [];
  const localPeople = visiblePeople.filter((other) => other.position.cellId === person.position.cellId);
  const personCollectives = activeCollectivesFor(state, person.id);
  const requestedWaterAssist = [...state.agreements].reverse().find((agreement) => agreement.status === 'active'
    && agreement.proposal.kind === 'assist'
    && agreement.proposal.need === 'water'
    && agreement.proposal.requesterId === person.id);
  if (requestedWaterAssist?.proposal.kind === 'assist') {
    const proposal = requestedWaterAssist.proposal;
    const helper = state.people.find((other) => other.id === proposal.helperId);
    const helperRoute = [...state.intents].reverse().find((intent) => intent.ownerId === helper?.id
      && intent.goal.kind === 'at-cell'
      && (intent.sourceFactIds ?? []).some((eventId) => requestedWaterAssist.sourceEventIds.includes(eventId)));
    if (helper && helperRoute?.goal.kind === 'at-cell' && person.position.cellId !== helperRoute.goal.cellId) {
      const path = findPath(state.world.grid, person.position.cellId, helperRoute.goal.cellId);
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
  const acceptedAssist = acceptedAssistFor(state, person.id, state.clock.elapsedMonths);
  if (acceptedAssist) {
    const requester = state.people.find((other) => other.id === acceptedAssist.proposal.requesterId);
    const alreadyHelped = state.world.past.some((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.atMonth >= acceptedAssist.acceptance.atMonth
      && event.who === person.id
      && event.action.kind === 'transfer'
      && event.action.to.kind === 'person'
      && event.action.to.personId === requester?.id);
    if (requester && !alreadyHelped) {
      const food = person.inventory.find((stack) => materialHas(stack.materialId, 'edible') && stack.quantity > 0);
      const water = acceptedAssist.proposal.need === 'water' ? reachableWaterBank(state, person) : null;
      if (acceptedAssist.proposal.need === 'food' && food && requester.position.cellId === person.position.cellId) options.push({
        id: `fulfill-assist:${acceptedAssist.request.id}`,
        summary: `履行承诺，把食物交给${requester.name}`,
        reason: '自己已经在对话中接受对方的求助',
        goal: { kind: 'inventory-at-least', materialId: food.materialId, quantity: inventoryQuantity(requester, food.materialId) + 1, personId: requester.id },
        nextAction: { kind: 'transfer', materialId: food.materialId, quantity: 1, from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: requester.id }, stackId: food.id, authorizationRef: acceptedAssist.request.action.kind === 'communicate' ? acceptedAssist.request.action.content.id : undefined },
        target: { kind: 'person', personId: requester.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [acceptedAssist.request.id, acceptedAssist.acceptance.id],
      });
      else if (requester.position.cellId !== person.position.cellId) options.push({
        id: `meet-to-assist:${acceptedAssist.request.id}`,
        summary: `去与${requester.name}会合以履行帮助承诺`, reason: '已经接受求助，必须先回到对方身边',
        goal: { kind: 'near-person', personId: requester.id }, nextAction: { kind: 'move', toCellId: requester.position.cellId },
        target: { kind: 'person', personId: requester.id }, estimatedDuration: 'several-months', estimatedMonths: 2,
        risks: [], domain: 'social', sourceFactIds: [acceptedAssist.request.id, acceptedAssist.acceptance.id],
      });
      else if (water) {
        const alreadyAtWater = water.bankCell === person.position.cellId;
        const representationId = `show-water:${acceptedAssist.request.id}:${person.id}`;
        options.push({
          id: `fulfill-assist:${acceptedAssist.request.id}`,
          summary: alreadyAtWater ? `向${requester.name}指出身边的水` : `带${requester.name}去附近水边`,
          reason: '已经接受寻找水的求助，附近存在可达水源',
          goal: alreadyAtWater ? { kind: 'representation-made', representationId } : { kind: 'at-cell', cellId: water.bankCell },
          nextAction: alreadyAtWater
            ? { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: '水就在我们身边，可以在这里饮用' }, audience: [requester.id], channel: 'voice' }
            : { kind: 'move', toCellId: water.bankCell },
          target: { kind: 'person', personId: requester.id },
          estimatedDuration: water.pathLength <= RULE_ACTION_TICKS_PER_MONTH ? 'one-month' : 'several-months',
          estimatedMonths: Math.max(1, Math.ceil((water.pathLength - 1) / RULE_ACTION_TICKS_PER_MONTH)),
          risks: [], domain: 'social', sourceFactIds: [acceptedAssist.request.id, acceptedAssist.acceptance.id],
        });
      } else {
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

  for (const other of visiblePeople) {
    const companionship = acceptedCompanionBetween(state, person.id, other.id, state.clock.elapsedMonths);
    if (!companionship || other.position.cellId === person.position.cellId) continue;
    const path = findPath(state.world.grid, person.position.cellId, other.position.cellId);
    if (!path.length) continue;
    options.push({
      id: `rejoin-companion:${other.id}:${companionship.offer.id}`,
      summary: `重新与同伴${other.name}会合`, reason: '双方已通过对话形成结伴承诺，但现在彼此分离',
      goal: { kind: 'near-person', personId: other.id }, nextAction: { kind: 'move', toCellId: other.position.cellId },
      target: { kind: 'person', personId: other.id }, estimatedDuration: 'several-months',
      estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / RULE_ACTION_TICKS_PER_MONTH)),
      risks: [], domain: 'social', sourceFactIds: [companionship.offer.id, companionship.acceptance.id],
    });
  }
  const incomingAssist = openAssistRequestFor(state, person.id);
  if (incomingAssist) {
    const requester = state.people.find((other) => other.id === incomingAssist.fact.who);
    if (requester) {
      const proposal = incomingAssist.content.proposal;
      if (proposal?.kind === 'assist' && canAcceptAssist(state, person, requester, proposal.need)) options.push(responseOption(state, person, incomingAssist.content.id, requester, true, 'assist'));
      options.push(responseOption(state, person, incomingAssist.content.id, requester, false, 'assist'));
    }
  }
  const incomingCompanion = openCompanionOfferFor(state, person.id);
  if (incomingCompanion) {
    const proposer = state.people.find((other) => other.id === incomingCompanion.fact.who);
    if (proposer) {
      options.push(responseOption(state, person, incomingCompanion.content.id, proposer, true, 'companion'));
      options.push(responseOption(state, person, incomingCompanion.content.id, proposer, false, 'companion'));
    }
  }
  const incomingCollective = openCollectiveOfferFor(state, person.id);
  if (incomingCollective) {
    const proposer = state.people.find((other) => other.id === incomingCollective.fact.who);
    const proposal = incomingCollective.content.proposal;
    if (proposer && proposal?.kind === 'collective') {
      options.push({ ...responseOption(state, person, incomingCollective.content.id, proposer, true, 'collective'), sourceFactIds: [incomingCollective.fact.id] });
      options.push({ ...responseOption(state, person, incomingCollective.content.id, proposer, false, 'collective'), sourceFactIds: [incomingCollective.fact.id] });
    }
  }
  const incomingPermission = openPermissionOfferFor(state, person.id);
  if (incomingPermission) {
    const grantor = state.people.find((other) => other.id === incomingPermission.fact.who);
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

  for (const collective of personCollectives) {
    const memberIds = new Set(activeMemberIds(state, collective));
    const visibleMember = visiblePeople.find((other) => memberIds.has(other.id) && other.position.cellId !== person.position.cellId);
    if (visibleMember) {
      const path = findPath(state.world.grid, person.position.cellId, visibleMember.position.cellId);
      if (path.length) options.push({
        id: `rejoin-collective:${collective.id}:${visibleMember.id}`,
        summary: `重新与共同体成员${visibleMember.name}会合`,
        reason: `双方仍属于以“${collective.purposeSummary}”为目的的持续共同体`,
        goal: { kind: 'near-person', personId: visibleMember.id }, nextAction: { kind: 'move', toCellId: visibleMember.position.cellId },
        target: { kind: 'person', personId: visibleMember.id }, estimatedDuration: 'several-months',
        estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / RULE_ACTION_TICKS_PER_MONTH)),
        risks: [], domain: 'social', sourceFactIds: [...collective.sourceEventIds],
      });
    }
    const localMember = localPeople.find((other) => memberIds.has(other.id));
    const relations = activeMemberIds(state, collective)
      .filter((id) => id !== person.id)
      .map((id) => relationTo(person, id));
    const membershipUnderStrain = relations.some((relation) => (relation?.trust ?? 0) <= -8 || (relation?.fear ?? 0) >= 55);
    if (localMember && membershipUnderStrain) {
      const representationId = `withdraw:${state.clock.elapsedMonths}:${collective.id}:${person.id}`;
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
        && !state.agreements.some((agreement) => agreement.status === 'proposed'
          && agreement.proposal.kind === 'permission'
          && agreement.proposal.grantorId === person.id
          && agreement.proposal.granteeId === localMember.id
          && agreement.proposal.materialId === stack.materialId));
      if (ownShareable) {
        const representationId = `offer-permission:${state.clock.elapsedMonths}:${collective.id}:${person.id}:${localMember.id}:${ownShareable.materialId}`;
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
              validUntilMonth: state.clock.elapsedMonths + 24, expiresAtMonth: state.clock.elapsedMonths + 6,
            } },
            audience: [localMember.id], channel: 'voice',
          },
          target: { kind: 'person', personId: localMember.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
          risks: [], domain: 'social', sourceFactIds: [...collective.sourceEventIds, ...ownShareable.sourceEventIds],
        });
      }
    }
    const allMembersHere = activeMemberIds(state, collective).every((id) => state.people.find((candidate) => candidate.id === id)?.position.cellId === person.position.cellId);
    const candidate = allMembersHere ? localPeople.find((other) => {
      if (memberIds.has(other.id) || hasOpenMembershipOfferFor(state, collective.id, other.id)) return false;
      const relation = relationTo(person, other.id);
      const fulfilledTogether = state.agreements.some((agreement) => agreement.status === 'fulfilled'
        && agreement.partyIds.includes(person.id)
        && agreement.partyIds.includes(other.id)
        && (agreement.proposal.kind === 'assist' || agreement.proposal.kind === 'exchange' || agreement.proposal.kind === 'companion'));
      return fulfilledTogether && (relation?.trust ?? 0) >= 6;
    }) : undefined;
    if (candidate) {
      const requiredApproverIds = [...new Set([...activeMemberIds(state, collective).filter((id) => id !== person.id), candidate.id])];
      const representationId = `offer-membership:${state.clock.elapsedMonths}:${collective.id}:${person.id}:${candidate.id}`;
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
            expiresAtMonth: state.clock.elapsedMonths + 6,
          } },
          audience: requiredApproverIds,
          channel: 'voice',
        },
        target: { kind: 'person', personId: candidate.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: ['任一现有成员或候选人拒绝，提议都会终止'], domain: 'social', sourceFactIds: [...collective.sourceEventIds],
      });
    }
  }

  for (const permission of activePermissionsFor(state, person.id)) {
    const grantor = state.people.find((other) => other.id === permission.grantorId);
    const grantee = state.people.find((other) => other.id === permission.granteeId);
    if (person.id === permission.granteeId && grantor?.position.cellId === person.position.cellId) {
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
    if (person.id === permission.grantorId && grantee?.position.cellId === person.position.cellId) {
      const representationId = `revoke-permission:${state.clock.elapsedMonths}:${permission.id}`;
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

  for (const other of localPeople.slice(0, 3)) {
    const relation = relationTo(person, other.id);
    const need: 'water' | 'food' | null = person.body.hydration < 45 ? 'water' : person.body.nutrition < 45 ? 'food' : null;
    if (need && !hasOpenAssistRequestBetween(state, person.id, other.id)) {
      const representationId = `request-assist:${state.clock.elapsedMonths}:${person.id}:${other.id}:${need}`;
      options.push({
        id: representationId,
        summary: `向${other.name}请求${need === 'water' ? '协助寻找水' : '食物帮助'}`,
        reason: '自己的生存储备下降，而身边存在可以沟通的人',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'request', summary: need === 'water' ? '请帮助我找到水' : '请帮助我取得食物', proposal: { kind: 'assist', requesterId: person.id, helperId: other.id, need, expiresAtMonth: state.clock.elapsedMonths + 4 } }, audience: [other.id], channel: 'voice' },
        target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social', sourceFactIds: [],
      });
    }
    if ((relation?.trust ?? 0) >= 6
      && (relation?.bond ?? 0) >= 6
      && !hasOpenCompanionOfferBetween(state, person.id, other.id)
      && !acceptedCompanionBetween(state, person.id, other.id, state.clock.elapsedMonths)) {
      const representationId = `offer-companion:${state.clock.elapsedMonths}:${person.id}:${other.id}`;
      options.push({
        id: representationId,
        summary: `邀请${other.name}结伴行动`,
        reason: '彼此已经建立最低程度的信任，结伴可能降低长期风险',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'offer', summary: '希望今后一段时间结伴行动', proposal: { kind: 'companion', proposerId: person.id, partnerId: other.id, expiresAtMonth: state.clock.elapsedMonths + 6 } }, audience: [other.id], channel: 'voice' },
        target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social', sourceFactIds: relation?.sourceEventIds ?? [],
      });
    }
    const sharedFulfillment = [...state.agreements].reverse().find((agreement) => agreement.status === 'fulfilled'
      && agreement.partyIds.includes(person.id)
      && agreement.partyIds.includes(other.id)
      && (agreement.proposal.kind === 'assist' || agreement.proposal.kind === 'exchange' || agreement.proposal.kind === 'companion'));
    if (!personCollectives.some((collective) => collective.status === 'active')
      && !activeCollectivesFor(state, other.id).some((collective) => collective.status === 'active')
      && sharedFulfillment
      && (relation?.trust ?? 0) >= 6
      && !hasOpenCollectiveOfferBetween(state, person.id, other.id)
      && !hasOpenCollectiveOfferBetween(state, other.id, person.id)) {
      const representationId = `offer-collective:${state.clock.elapsedMonths}:${person.id}:${other.id}`;
      const purposeSummary = sharedFulfillment.proposal.kind === 'exchange'
        ? '持续交换物质并互相履约'
        : sharedFulfillment.proposal.kind === 'companion'
          ? '长期结伴并共同生活'
          : '持续互助并共同应对生存压力';
      options.push({
        id: representationId,
        summary: `邀请${other.name}把已经发生的合作延续为共同体`,
        reason: '双方已有真实履约与信任来源，可以自愿形成跨协议持续的成员关系',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'offer', summary: `我们已经一起做成过事情，愿不愿意以后继续${purposeSummary}？`, proposal: { kind: 'collective', proposerId: person.id, partnerId: other.id, purposeSummary, expiresAtMonth: state.clock.elapsedMonths + 6 } }, audience: [other.id], channel: 'voice' },
        target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
        risks: [], domain: 'social', sourceFactIds: [...sharedFulfillment.sourceEventIds],
      });
    }
    const representationId = `talk:${state.clock.elapsedMonths}:${person.id}:${other.id}`;
    options.push({
      id: representationId,
      summary: `与${other.name}交流眼前处境`, reason: '近身人物可以交换观察并调整彼此接下来的意图',
      goal: { kind: 'representation-made', representationId },
      nextAction: { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: '谈论眼前处境' }, audience: [other.id], channel: 'voice' },
      target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social', sourceFactIds: [],
    });
  }

  if (!localPeople.length) {
    for (const other of visiblePeople.slice(0, 2)) {
      const path = findPath(state.world.grid, person.position.cellId, other.position.cellId);
      if (!path.length) continue;
      options.push({
        id: `meet:${other.id}`,
        summary: `去与${other.name}会合`, reason: '看见另一个人，接近后才能沟通、求助或共同做事',
        goal: { kind: 'near-person', personId: other.id }, nextAction: { kind: 'move', toCellId: other.position.cellId },
        target: { kind: 'person', personId: other.id }, estimatedDuration: path.length <= 4 ? 'one-month' : 'several-months',
        estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / RULE_ACTION_TICKS_PER_MONTH)),
        risks: [], domain: 'social', sourceFactIds: relationTo(person, other.id)?.sourceEventIds ?? [],
      });
    }
  }
  return options;
}
