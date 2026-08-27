import { Material, materialDefinition } from '../../domain/material';
import type { DropState, SimulationState } from '../../domain/model';
import type { ActionFact } from '../../domain/model';
import { canPersonPlanToCollectProjectMaterialDrop } from '../../domain/project-material-request';
import {
  bestProductionToolStack,
  isCompletedPersonalProductionLaborEvent,
  isProductionToolMaterial,
  productionToolRank,
  recentPersonalProductionLaborEvents,
} from '../../domain/production-tool';
import { sameLocation, type ItemStack, type PersonState } from '../../domain/person';
import type { ProjectCapabilityReplicationBasis, ProjectState } from '../../domain/project';
import {
  compareWorldEventsInCanonicalOrder,
  worldEventById,
} from '../../domain/event-index';
import { findStandingPath } from '../../world/grid';
import { hasOpenExchangeOfferBetween } from '../../domain/social-facts';

export const PROJECT_CAPABILITY_REPLICATION_BASIS_VERSION = 'project-capability-replication-basis-v1' as const;
export const MAX_VISIBLE_CAPABILITY_EXEMPLARS = 2;
export const MAX_CAPABILITY_REPLICATION_SOURCE_FACTS = 1;

export interface CapabilityReplicationView {
  visibleCells: number[];
  visibleDrops: DropState[];
  visiblePeople: PersonState[];
}

interface VisibleCapabilityExemplar {
  kind: 'visible-holder' | 'visible-drop';
  outputMaterialId: number;
  holderId?: string;
  stackId?: string;
  dropId?: string;
  directlyCollectible: boolean;
}

export interface ProductionToolUpgradeTradeCandidate {
  person: PersonState;
  own: ItemStack;
  their: ItemStack;
}

/** One shared rule for ordinary adoption and for suppressing needless replication. */
export function productionToolUpgradeTradeCandidate(
  state: SimulationState,
  person: PersonState,
  people: PersonState[],
): ProductionToolUpgradeTradeCandidate | undefined {
  const currentRank = productionToolRank(bestProductionToolStack(person)?.materialId ?? Material.Air);
  const ownGoods = person.inventory.filter((stack) => {
    const material = materialDefinition(stack.materialId);
    return stack.quantity >= 2
      && !stack.recordPayloadId
      && material.phase !== 'gas'
      && material.mass > 0;
  }).sort((left, right) => left.materialId - right.materialId || left.id.localeCompare(right.id));
  return people
    .filter((other) => sameLocation(other, person)
      && !hasOpenExchangeOfferBetween(state, person.id, other.id))
    .flatMap((other) => {
      const holderHighestRank = other.inventory.reduce((highest, stack) => stack.quantity > 0
        ? Math.max(highest, productionToolRank(stack.materialId))
        : highest, 0);
      return other.inventory
        .filter((their) => their.quantity > 0 && productionToolRank(their.materialId) > currentRank)
        .filter((their) => {
          const retainedRank = other.inventory.reduce((highest, backup) => backup.id !== their.id && backup.quantity > 0
            ? Math.max(highest, productionToolRank(backup.materialId))
            : highest, 0);
          return their.quantity >= 2
            || retainedRank >= Math.max(holderHighestRank, productionToolRank(their.materialId));
        })
        .flatMap((their) => {
          const own = ownGoods.find((stack) => stack.materialId !== their.materialId);
          return own ? [{ person: other, own, their }] : [];
        });
    })
    .sort((left, right) => productionToolRank(right.their.materialId) - productionToolRank(left.their.materialId)
      || left.person.id.localeCompare(right.person.id)
      || left.their.id.localeCompare(right.their.id))[0];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function directlyCollectibleDrop(
  state: SimulationState,
  observer: PersonState,
  drop: DropState,
  atMonth: number,
): boolean {
  return canPersonPlanToCollectProjectMaterialDrop(state, observer.id, drop, atMonth)
    && findStandingPath(state.world.grid, observer.position, { cellId: drop.cellId, z: drop.z }).length > 0;
}

function visibleCapabilityExemplars(
  state: SimulationState,
  observer: PersonState,
  view: CapabilityReplicationView,
  atMonth: number,
): VisibleCapabilityExemplar[] {
  const holders = view.visiblePeople
    .filter((person) => person.id !== observer.id)
    .flatMap((holder) => {
      const seenMaterials = new Set<number>();
      return holder.inventory
        .filter((stack) => stack.quantity > 0 && isProductionToolMaterial(stack.materialId))
        .sort((left, right) => productionToolRank(right.materialId) - productionToolRank(left.materialId)
          || left.id.localeCompare(right.id))
        .flatMap((stack) => {
          if (seenMaterials.has(stack.materialId)) return [];
          seenMaterials.add(stack.materialId);
          return [{
            kind: 'visible-holder' as const,
            outputMaterialId: stack.materialId,
            holderId: holder.id,
            stackId: stack.id,
            directlyCollectible: false,
          }];
        });
    });
  const drops = view.visibleDrops.flatMap((drop) => {
    if (drop.quantity <= 0 || !isProductionToolMaterial(drop.materialId)) return [];
    return [{
      kind: 'visible-drop' as const,
      outputMaterialId: drop.materialId,
      dropId: drop.id,
      directlyCollectible: directlyCollectibleDrop(state, observer, drop, atMonth),
    }];
  });
  return [...holders, ...drops];
}

function capabilityReplicationBasisKey(
  basis: Omit<ProjectCapabilityReplicationBasis, 'version' | 'kind' | 'basisKey'>,
): string {
  const exemplarKey = basis.exemplar.kind === 'visible-holder'
    ? `holder:${basis.exemplar.holderId}:${basis.exemplar.stackId}`
    : `drop:${basis.exemplar.dropId}`;
  return [
    PROJECT_CAPABILITY_REPLICATION_BASIS_VERSION,
    `observer=${basis.observerId}`,
    `output=${basis.outputMaterialId}`,
    `baseline=${basis.baselineToolRank}`,
    `target=${basis.targetToolRank}`,
    `labor=${basis.recentLaborEventId}`,
    `exemplar=${exemplarKey}`,
    `holders=${basis.visibleHolderIds.join('.') || 'none'}`,
    `count=${basis.visibleExemplarCount}`,
  ].join('|');
}

export function capabilityReplicationBasisFor(
  state: SimulationState,
  observer: PersonState,
  view: CapabilityReplicationView,
  atMonth = state.clock.elapsedMonths + 1,
): ProjectCapabilityReplicationBasis | undefined {
  const recentLabor = recentPersonalProductionLaborEvents(state, observer.id, atMonth)[0];
  if (!recentLabor) return undefined;
  const baselineToolRank = productionToolRank(bestProductionToolStack(observer)?.materialId ?? Material.Air);
  const exemplars = visibleCapabilityExemplars(state, observer, view, atMonth)
    .filter((candidate) => productionToolRank(candidate.outputMaterialId) > baselineToolRank);
  const tradeCandidate = productionToolUpgradeTradeCandidate(state, observer, view.visiblePeople);
  const directlyAccessibleRank = exemplars.reduce((highest, candidate) => (
    candidate.directlyCollectible
      ? Math.max(highest, productionToolRank(candidate.outputMaterialId))
      : highest
  ), Math.max(baselineToolRank, productionToolRank(tradeCandidate?.their.materialId ?? Material.Air)));
  const groups = new Map<number, VisibleCapabilityExemplar[]>();
  for (const exemplar of exemplars) {
    const group = groups.get(exemplar.outputMaterialId) ?? [];
    group.push(exemplar);
    groups.set(exemplar.outputMaterialId, group);
  }
  const selected = [...groups]
    .filter(([outputMaterialId, group]) => group.length >= 1
      && group.length <= MAX_VISIBLE_CAPABILITY_EXEMPLARS
      && productionToolRank(outputMaterialId) > directlyAccessibleRank)
    .map(([outputMaterialId, group]) => ({
      outputMaterialId,
      group: [...group].sort((left, right) => Number(left.kind === 'visible-drop') - Number(right.kind === 'visible-drop')
        || (left.holderId ?? left.dropId ?? '').localeCompare(right.holderId ?? right.dropId ?? '')
        || (left.stackId ?? '').localeCompare(right.stackId ?? '')),
    }))
    .sort((left, right) => productionToolRank(right.outputMaterialId) - productionToolRank(left.outputMaterialId)
      || left.group.length - right.group.length
      || left.outputMaterialId - right.outputMaterialId)[0];
  if (!selected) return undefined;
  const exemplar = selected.group[0];
  const visibleHolderIds = uniqueSorted(selected.group.flatMap((candidate) => candidate.holderId ? [candidate.holderId] : []));
  const sourceFactIds = [recentLabor.id];
  if (sourceFactIds.length > MAX_CAPABILITY_REPLICATION_SOURCE_FACTS) return undefined;
  const base: Omit<ProjectCapabilityReplicationBasis, 'version' | 'kind' | 'basisKey'> = {
    observerId: observer.id,
    atMonth,
    outputMaterialId: selected.outputMaterialId,
    baselineToolRank,
    targetToolRank: productionToolRank(selected.outputMaterialId),
    recentLaborEventId: recentLabor.id,
    exemplar: exemplar.kind === 'visible-holder'
      ? {
          kind: 'visible-holder',
          holderId: exemplar.holderId!,
          stackId: exemplar.stackId!,
        }
      : {
          kind: 'visible-drop',
          dropId: exemplar.dropId!,
        },
    visibleHolderIds,
    visibleExemplarCount: selected.group.length,
    sourceFactIds,
  };
  return {
    version: PROJECT_CAPABILITY_REPLICATION_BASIS_VERSION,
    kind: 'production-tool',
    ...base,
    basisKey: capabilityReplicationBasisKey(base),
  };
}

export function validateCapabilityReplicationBasis(
  state: SimulationState,
  observer: PersonState,
  basis: ProjectCapabilityReplicationBasis,
  options: { view?: CapabilityReplicationView; requireCurrentExemplar?: boolean } = {},
): boolean {
  if (basis.version !== PROJECT_CAPABILITY_REPLICATION_BASIS_VERSION
    || basis.kind !== 'production-tool'
    || basis.observerId !== observer.id
    || !Number.isSafeInteger(basis.atMonth)
    || !Number.isSafeInteger(basis.outputMaterialId)
    || !isProductionToolMaterial(basis.outputMaterialId)
    || !Number.isSafeInteger(basis.baselineToolRank)
    || basis.baselineToolRank < 0
    || basis.targetToolRank !== productionToolRank(basis.outputMaterialId)
    || basis.targetToolRank <= basis.baselineToolRank
    || !Number.isSafeInteger(basis.visibleExemplarCount)
    || basis.visibleExemplarCount < 1
    || basis.visibleExemplarCount > MAX_VISIBLE_CAPABILITY_EXEMPLARS
    || basis.visibleHolderIds.length > MAX_VISIBLE_CAPABILITY_EXEMPLARS
    || basis.sourceFactIds.length !== MAX_CAPABILITY_REPLICATION_SOURCE_FACTS
    || uniqueSorted(basis.visibleHolderIds).join('|') !== basis.visibleHolderIds.join('|')
    || uniqueSorted(basis.sourceFactIds).join('|') !== basis.sourceFactIds.join('|')
    || basis.sourceFactIds[0] !== basis.recentLaborEventId) return false;
  const labor = worldEventById(state, basis.recentLaborEventId);
  if (!labor
    || !isCompletedPersonalProductionLaborEvent(labor, observer.id)
    || labor.atMonth > basis.atMonth
    || labor.atMonth < basis.atMonth - 12) return false;
  const base = {
    observerId: basis.observerId,
    atMonth: basis.atMonth,
    outputMaterialId: basis.outputMaterialId,
    baselineToolRank: basis.baselineToolRank,
    targetToolRank: basis.targetToolRank,
    recentLaborEventId: basis.recentLaborEventId,
    exemplar: basis.exemplar,
    visibleHolderIds: basis.visibleHolderIds,
    visibleExemplarCount: basis.visibleExemplarCount,
    sourceFactIds: basis.sourceFactIds,
  };
  if (basis.basisKey !== capabilityReplicationBasisKey(base)) return false;
  if (!options.requireCurrentExemplar) return true;
  if (!options.view
    || productionToolRank(bestProductionToolStack(observer)?.materialId ?? Material.Air) !== basis.baselineToolRank) return false;
  const current = capabilityReplicationBasisFor(state, observer, options.view, basis.atMonth);
  return current?.basisKey === basis.basisKey;
}

/** The exact post-opening fact through which the owner obtained this stack. */
export function capabilityReplicationAcquisitionFact(
  state: SimulationState,
  owner: PersonState,
  project: ProjectState,
  stack: ItemStack,
): ActionFact | undefined {
  const basis = project.capabilityReplicationBasis;
  if (!basis
    || project.ownerId !== owner.id
    || stack.quantity <= 0
    || stack.materialId !== basis.outputMaterialId) return undefined;
  return stack.sourceEventIds
    .map((eventId) => worldEventById(state, eventId))
    .filter((event): event is ActionFact => Boolean(event
      && event.kind === 'action'
      && event.status === 'completed'
      && event.atMonth >= project.createdAtMonth
      && ((event.who === owner.id
        && event.action.kind === 'act'
        && ['combine', 'exert', 'expose'].includes(event.action.operation)
        && Number(event.diff.outputMaterialId) === basis.outputMaterialId
        && event.diff.outputStackId === stack.id)
        || (event.action.kind === 'transfer'
          && Number(event.diff.materialId) === basis.outputMaterialId
          && event.action.to.kind === 'person'
          && event.action.to.personId === owner.id))))
    .sort(compareWorldEventsInCanonicalOrder)[0];
}
