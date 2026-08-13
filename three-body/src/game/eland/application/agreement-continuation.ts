import type { FactPredicate, PrimitiveAction, WorldRef } from '../domain/action';
import { agreementById } from '../domain/agreement';
import { Material, materialHas } from '../domain/material';
import type { SimulationState } from '../domain/model';
import type { PersonId, PersonState } from '../domain/person';
import { cellsInRadius, findPath, isPassable, neighbors4, surfaceMaterial, topPosition } from '../world/grid';

export interface AgreementContinuation {
  agreementId: string;
  personId: PersonId;
  summary: string;
  goal: FactPredicate;
  nextAction: PrimitiveAction;
  target?: WorldRef;
  sourceFactIds: string[];
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

export function canAcceptAssist(state: SimulationState, helper: PersonState, need: 'water' | 'food' | 'shelter' | 'company'): boolean {
  if (need === 'water') return Boolean(reachableWaterBank(state, helper));
  if (need === 'food') return helper.inventory.some((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  if (need === 'company') return true;
  return false;
}

export function compileAgreementContinuations(state: SimulationState, agreementId: string): AgreementContinuation[] {
  const agreement = agreementById(state, agreementId);
  if (!agreement || agreement.status !== 'active') return [];
  const sourceFactIds = [...agreement.sourceEventIds];
  if (agreement.proposal.kind === 'assist') {
    const proposal = agreement.proposal;
    const helper = state.people.find((person) => person.id === proposal.helperId);
    const requester = state.people.find((person) => person.id === proposal.requesterId);
    if (!helper || !requester) return [];
    if (proposal.need === 'food') {
      const stack = helper.inventory.find((item) => item.quantity > 0 && materialHas(item.materialId, 'edible'));
      if (!stack) return [];
      return [{
        agreementId: agreement.id,
        personId: helper.id,
        summary: `履行对${requester.name}的食物帮助承诺`,
        goal: { kind: 'inventory-at-least', materialId: stack.materialId, quantity: requester.inventory.filter((item) => item.materialId === stack.materialId).reduce((sum, item) => sum + item.quantity, 0) + 1, personId: requester.id },
        nextAction: helper.position.cellId === requester.position.cellId
          ? { kind: 'transfer', materialId: stack.materialId, quantity: 1, from: { kind: 'person', personId: helper.id }, to: { kind: 'person', personId: requester.id }, stackId: stack.id, authorizationRef: agreement.id }
          : { kind: 'move', toCellId: requester.position.cellId },
        target: { kind: 'person', personId: requester.id },
        sourceFactIds,
      }];
    }
    if (proposal.need === 'water') {
      const water = reachableWaterBank(state, helper);
      if (!water) return [];
      const representationId = `show-water:${agreement.id}:${helper.id}`;
      const helperAtWater = helper.position.cellId === water.bankCell;
      const requesterAtWater = requester.position.cellId === water.bankCell;
      const continuations: AgreementContinuation[] = [{
        agreementId: agreement.id,
        personId: helper.id,
        summary: `履行承诺，带${requester.name}前往并确认水源`,
        goal: { kind: 'representation-made', representationId },
        nextAction: helperAtWater
          ? requesterAtWater
            ? { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: '水就在这里，可以饮用' }, audience: [requester.id], channel: 'voice' }
            : { kind: 'attend', target: { kind: 'voxel', position: topPosition(state.world.grid, water.waterCell) } }
          : { kind: 'move', toCellId: water.bankCell },
        target: { kind: 'person', personId: requester.id },
        sourceFactIds,
      }];
      if (requester.position.cellId !== water.bankCell && findPath(state.world.grid, requester.position.cellId, water.bankCell).length) continuations.push({
        agreementId: agreement.id,
        personId: requester.id,
        summary: `沿${helper.name}确认的路线去水边`,
        goal: { kind: 'at-cell', cellId: water.bankCell },
        nextAction: { kind: 'move', toCellId: water.bankCell },
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
      const person = state.people.find((candidate) => candidate.id === personId);
      const receiverId = personId === proposal.offererId ? proposal.partnerId : proposal.offererId;
      const receiver = state.people.find((candidate) => candidate.id === receiverId);
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
        nextAction: person.position.cellId === receiver.position.cellId
          ? { kind: 'transfer' as const, materialId, quantity, from: { kind: 'person' as const, personId }, to: { kind: 'person' as const, personId: receiver.id }, stackId: stack.id, authorizationRef: agreement.id }
          : { kind: 'move' as const, toCellId: receiver.position.cellId },
        target: { kind: 'person' as const, personId: receiver.id },
        sourceFactIds,
      }];
    });
  }
  if (agreement.proposal.kind === 'reproduce') {
    const responder = state.people.find((person) => person.id === agreement.responderId);
    const proposer = state.people.find((person) => person.id === agreement.proposerId);
    if (!responder || !proposer) return [];
    const female = responder.sex === 'female' ? responder : proposer.sex === 'female' ? proposer : undefined;
    return [{
      agreementId: agreement.id,
      personId: responder.id,
      summary: `履行与${proposer.name}共同接受的生殖尝试`,
      goal: female ? { kind: 'condition', personId: female.id, condition: 'pregnancy', present: true } : { kind: 'near-person', personId: proposer.id },
      nextAction: responder.position.cellId === proposer.position.cellId
        ? { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: proposer.id }] }
        : { kind: 'move', toCellId: proposer.position.cellId },
      target: { kind: 'person', personId: proposer.id },
      sourceFactIds,
    }];
  }
  return [];
}
