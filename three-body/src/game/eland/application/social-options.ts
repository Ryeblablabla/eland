import type { ActionOption } from '../domain/action';
import type { SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { inventoryQuantity } from '../domain/person';
import { materialHas } from '../domain/material';
import {
  acceptedAssistFor,
  acceptedCompanionBetween,
  hasOpenAssistRequestBetween,
  hasOpenCompanionOfferBetween,
  openAssistRequestFor,
  openCompanionOfferFor,
} from '../domain/social-facts';
import { findPath } from '../world/grid';
import { RULE_ACTION_TICKS_PER_MONTH } from '../domain/calendar';

function relationTo(person: PersonState, otherId: string) {
  return person.relations.find((relation) => relation.personId === otherId);
}

function responseOption(person: PersonState, referenceId: string, other: PersonState, accept: boolean, kind: 'assist' | 'companion'): ActionOption {
  const representationId = `${accept ? 'accept' : 'reject'}:${referenceId}:${person.id}`;
  return {
    id: `${accept ? 'accept' : 'reject'}-${kind}:${referenceId}`,
    summary: `${accept ? '接受' : '拒绝'}${other.name}的${kind === 'assist' ? '求助' : '结伴提议'}`,
    reason: '对方刚刚提出了一项需要回应的社会请求',
    goal: { kind: 'representation-made', representationId },
    nextAction: { kind: 'communicate', content: accept
      ? { id: representationId, kind: 'accept', referenceId }
      : { id: representationId, kind: 'reject', referenceId }, audience: [other.id], channel: 'voice' },
    target: { kind: 'person', personId: other.id },
    estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social', sourceFactIds: [],
  };
}

export function buildSocialOptions(state: SimulationState, person: PersonState, visiblePeople: PersonState[]): ActionOption[] {
  const options: ActionOption[] = [];
  const localPeople = visiblePeople.filter((other) => other.position.cellId === person.position.cellId);
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
      else {
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
    if (requester?.position.cellId === person.position.cellId) {
      options.push(responseOption(person, incomingAssist.content.id, requester, true, 'assist'));
      options.push(responseOption(person, incomingAssist.content.id, requester, false, 'assist'));
    }
  }
  const incomingCompanion = openCompanionOfferFor(state, person.id);
  if (incomingCompanion) {
    const proposer = state.people.find((other) => other.id === incomingCompanion.fact.who);
    if (proposer?.position.cellId === person.position.cellId) {
      options.push(responseOption(person, incomingCompanion.content.id, proposer, true, 'companion'));
      options.push(responseOption(person, incomingCompanion.content.id, proposer, false, 'companion'));
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
