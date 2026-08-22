import type { FactPredicate, PrimitiveAction, WorldRef } from '../domain/action';
import { agreementById, reproductionAttemptedBetweenInMonth } from '../domain/agreement';
import { materialHas } from '../domain/material';
import type { SimulationState } from '../domain/model';
import { sameLocation, type PersonId, type PersonState } from '../domain/person';
import { personById } from '../domain/state-index';
import { findReachableWater } from '../domain/water-access';
import { cellsInRadius, findStandingPath } from '../world/grid';

export interface AgreementContinuation {
  agreementId: string;
  personId: PersonId;
  summary: string;
  goal: FactPredicate;
  nextAction: PrimitiveAction;
  target?: WorldRef;
  sourceFactIds: string[];
}

function reachableWater(state: SimulationState, person: PersonState) {
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return findReachableWater(state, person, cellsInRadius(person.position.cellId, radius));
}

export function canAcceptAssist(state: SimulationState, helper: PersonState, requester: PersonState, need: 'water' | 'food' | 'shelter' | 'company'): boolean {
  if (need === 'water') return requester.body.hydration < 45 && Boolean(reachableWater(state, helper));
  if (need === 'food') return requester.body.nutrition < 45 && helper.inventory.some((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  if (need === 'company') return true;
  return false;
}

export function compileAgreementContinuations(
  state: SimulationState,
  agreementId: string,
  atMonth = state.clock.elapsedMonths,
): AgreementContinuation[] {
  const agreement = agreementById(state, agreementId);
  if (!agreement
    || agreement.status !== 'active'
    || (agreement.acceptedAtMonth ?? Number.POSITIVE_INFINITY) > atMonth
    || (agreement.dueAtMonth ?? Number.NEGATIVE_INFINITY) < atMonth) return [];
  const sourceFactIds = [...agreement.sourceEventIds];
  if (agreement.proposal.kind === 'assist') {
    const proposal = agreement.proposal;
    const helper = personById(state, proposal.helperId);
    const requester = personById(state, proposal.requesterId);
    if (!helper || !requester) return [];
    if (proposal.need === 'company') {
      if (!sameLocation(helper, requester)) return [];
      return [{
        agreementId: agreement.id,
        personId: helper.id,
        summary: `履行承诺，留在这里陪伴${requester.name}`,
        goal: { kind: 'agreement-fulfilled', agreementId: agreement.id },
        nextAction: { kind: 'attend', target: { kind: 'person', personId: requester.id } },
        target: { kind: 'person', personId: requester.id },
        sourceFactIds,
      }];
    }
    if (proposal.need === 'food') {
      const stack = helper.inventory.find((item) => item.quantity > 0 && materialHas(item.materialId, 'edible'));
      if (!stack) return [];
      return [{
        agreementId: agreement.id,
        personId: helper.id,
        summary: `履行对${requester.name}的食物帮助承诺`,
        goal: { kind: 'inventory-at-least', materialId: stack.materialId, quantity: requester.inventory.filter((item) => item.materialId === stack.materialId).reduce((sum, item) => sum + item.quantity, 0) + 1, personId: requester.id },
        nextAction: sameLocation(helper, requester)
          ? { kind: 'transfer', materialId: stack.materialId, quantity: 1, from: { kind: 'person', personId: helper.id }, to: { kind: 'person', personId: requester.id }, stackId: stack.id, authorizationRef: agreement.id }
          : { kind: 'move', toCellId: requester.position.cellId, toZ: requester.position.z },
        target: { kind: 'person', personId: requester.id },
        sourceFactIds,
      }];
    }
    if (proposal.need === 'water') {
      const water = reachableWater(state, helper);
      if (!water) return [];
      const representationId = `show-water:${agreement.id}:${helper.id}`;
      const helperAtWater = helper.position.cellId === water.bankPosition.cellId && helper.position.z === water.bankPosition.z;
      const requesterAtWater = requester.position.cellId === water.bankPosition.cellId && requester.position.z === water.bankPosition.z;
      const continuations: AgreementContinuation[] = [{
        agreementId: agreement.id,
        personId: helper.id,
        summary: `履行承诺，带${requester.name}前往并确认水源`,
        goal: { kind: 'representation-made', representationId },
        nextAction: helperAtWater
          ? requesterAtWater
            ? { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: '水就在这里，可以饮用' }, audience: [requester.id], channel: 'voice' }
            : { kind: 'attend', target: { kind: 'voxel', position: water.waterPosition } }
          : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z },
        target: { kind: 'person', personId: requester.id },
        sourceFactIds,
      }];
      if (findStandingPath(state.world.grid, requester.position, water.bankPosition).length) continuations.push({
        agreementId: agreement.id,
        personId: requester.id,
        summary: `沿${helper.name}确认的路线去水边并实际饮水`,
        goal: { kind: 'body-at-least', field: 'hydration', value: Math.min(100, Math.max(60, requester.body.hydration + 35)) },
        nextAction: requesterAtWater
          ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
          : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z },
        target: { kind: 'person', personId: helper.id },
        sourceFactIds,
      });
      return continuations;
    }
    return [];
  }
  if (agreement.proposal.kind === 'exchange') {
    const proposal = agreement.proposal;
    return agreement.partyIds.flatMap((personId) => {
      if (agreement.fulfilledByPersonIds.includes(personId)) return [];
      const person = personById(state, personId);
      const receiverId = personId === proposal.offererId ? proposal.partnerId : proposal.offererId;
      const receiver = personById(state, receiverId);
      const materialId = personId === proposal.offererId ? proposal.offererMaterialId : proposal.partnerMaterialId;
      const quantity = personId === proposal.offererId ? proposal.offererQuantity : proposal.partnerQuantity;
      const stack = person?.inventory.find((item) => item.materialId === materialId && item.quantity >= quantity);
      if (!person || !receiver || !stack) return [];
      const receiverQuantity = receiver.inventory.filter((item) => item.materialId === materialId).reduce((sum, item) => sum + item.quantity, 0);
      return [{
        agreementId: agreement.id,
        personId,
        summary: `履行已接受的物质交换`,
        goal: { kind: 'inventory-at-least' as const, materialId, quantity: receiverQuantity + quantity, personId: receiver.id },
        nextAction: sameLocation(person, receiver)
          ? { kind: 'transfer' as const, materialId, quantity, from: { kind: 'person' as const, personId }, to: { kind: 'person' as const, personId: receiver.id }, stackId: stack.id, authorizationRef: agreement.id }
          : { kind: 'move' as const, toCellId: receiver.position.cellId, toZ: receiver.position.z },
        target: { kind: 'person' as const, personId: receiver.id },
        sourceFactIds,
      }];
    });
  }
  if (agreement.proposal.kind === 'reproduce') {
    const responder = personById(state, agreement.responderId);
    const proposer = personById(state, agreement.proposerId);
    if (!responder || !proposer) return [];
    if (reproductionAttemptedBetweenInMonth(state, responder.id, proposer.id, atMonth)) return [];
    const female = responder.sex === 'female' ? responder : proposer.sex === 'female' ? proposer : undefined;
    return [{
      agreementId: agreement.id,
      personId: responder.id,
      summary: `履行与${proposer.name}共同接受的生殖尝试`,
      goal: female ? { kind: 'condition', personId: female.id, condition: 'pregnancy', present: true } : { kind: 'near-person', personId: proposer.id },
      nextAction: sameLocation(responder, proposer)
        ? { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: proposer.id }], authorizationRef: agreement.id }
        : { kind: 'move', toCellId: proposer.position.cellId, toZ: proposer.position.z },
      target: { kind: 'person', personId: proposer.id },
      sourceFactIds,
    }];
  }
  return [];
}
