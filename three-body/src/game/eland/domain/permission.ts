import type { PrimitiveAction } from './action';
import { agreementById } from './agreement';
import { activeMembership } from './collective';
import type { ActionFact, PermissionFact, SimulationState } from './model';
import type { MaterialId } from './material';
import { materialHas } from './material';
import type { PersonId, PersonState } from './person';
import { inventoryQuantity, isAlive } from './person';
import { personById } from './state-index';
import { languageInterpreterIds } from './language-perception';

export type ResourcePermissionStatus = 'active' | 'revoked' | 'expired' | 'ended';

/** Shared physical reserve target used by cognition and permission allocation. */
export const PERSONAL_RESERVE_UNITS = 4;

export interface ResourcePermission {
  id: string;
  collectiveId: string;
  grantorId: PersonId;
  granteeId: PersonId;
  materialId: MaterialId;
  maxQuantityPerTransfer: number;
  validFromMonth: number;
  validUntilMonth: number;
  status: ResourcePermissionStatus;
  proposalAgreementId: string;
  sourceEventIds: string[];
  useEventIds: string[];
  endedAtMonth?: number;
}

interface PermissionIndex {
  indexedLength: number;
  lastIndexedPermission?: ResourcePermission;
  byId: Map<string, ResourcePermission>;
  byPersonId: Map<PersonId, ResourcePermission[]>;
}

const permissionIndexes = new WeakMap<SimulationState['permissions'], PermissionIndex>();

function permissionIndex(state: SimulationState): PermissionIndex {
  const permissions = state.permissions;
  let index = permissionIndexes.get(permissions);
  if (!index
    || index.indexedLength > permissions.length
    || (index.indexedLength > 0 && permissions[index.indexedLength - 1] !== index.lastIndexedPermission)) {
    index = { indexedLength: 0, byId: new Map(), byPersonId: new Map() };
    permissionIndexes.set(permissions, index);
  }
  for (let offset = index.indexedLength; offset < permissions.length; offset += 1) {
    const permission = permissions[offset];
    if (!index.byId.has(permission.id)) index.byId.set(permission.id, permission);
    for (const personId of new Set([permission.grantorId, permission.granteeId])) {
      const personal = index.byPersonId.get(personId) ?? [];
      personal.push(permission);
      index.byPersonId.set(personId, personal);
    }
  }
  index.indexedLength = permissions.length;
  index.lastIndexedPermission = permissions.at(-1);
  return index;
}

export function permissionById(state: SimulationState, id: string): ResourcePermission | undefined {
  return permissionIndex(state).byId.get(id);
}

export function activePermissionsFor(state: SimulationState, personId: PersonId): ResourcePermission[] {
  return (permissionIndex(state).byPersonId.get(personId) ?? []).filter((permission) => permission.status === 'active'
    && state.clock.elapsedMonths <= permission.validUntilMonth
    && (permission.grantorId === personId || permission.granteeId === personId));
}

function taggedInventoryQuantity(person: PersonState, tag: 'edible' | 'drinkable'): number {
  return person.inventory.reduce((sum, stack) => (
    stack.quantity > 0 && materialHas(stack.materialId, tag) ? sum + stack.quantity : sum
  ), 0);
}

function activeProjectRequiredQuantity(
  state: SimulationState,
  ownerId: PersonId,
  materialId: MaterialId,
): number {
  return state.projects
    .filter((project) => project.status === 'active' && project.ownerId === ownerId)
    .flatMap((project) => project.materialDemands ?? [])
    .filter((demand) => demand.materialId === materialId && demand.outstandingQuantity > 0)
    .reduce((sum, demand) => sum + demand.requiredQuantity, 0);
}

/**
 * Infer whether taking one unit improves a sourced deficit without creating an
 * equal deficit for the grantor.  This is a motive calculation, not permission
 * legality and not a per-person or per-seed behavior script.
 */
export function inferPermissionUseBasis(
  state: SimulationState,
  permission: ResourcePermission,
  grantee: PersonState,
  grantor: PersonState,
) {
  if (permission.status !== 'active'
    || permission.granteeId !== grantee.id
    || permission.grantorId !== grantor.id) return undefined;
  const materialId = permission.materialId;
  const receiverMaterialQuantity = inventoryQuantity(grantee, materialId);
  const grantorMaterialQuantity = inventoryQuantity(grantor, materialId);
  const grantorProjectReserve = activeProjectRequiredQuantity(state, grantor.id, materialId);
  const projectDemand = state.projects
    .filter((project) => project.status === 'active' && project.ownerId === grantee.id)
    .flatMap((project) => (project.materialDemands ?? [])
      .filter((demand) => demand.materialId === materialId
        && demand.outstandingQuantity > 0
        && receiverMaterialQuantity < demand.requiredQuantity)
      .map((demand) => ({ project, demand })))
    .sort((left, right) => right.project.pressure - left.project.pressure
      || left.project.createdAtMonth - right.project.createdAtMonth
      || left.project.id.localeCompare(right.project.id))[0];
  const resourceTag = materialHas(materialId, 'edible')
    ? 'edible' as const
    : materialHas(materialId, 'drinkable')
      ? 'drinkable' as const
      : undefined;
  const grantorResourceQuantity = resourceTag
    ? taggedInventoryQuantity(grantor, resourceTag)
    : grantorMaterialQuantity;
  const grantorReserve = Math.max(
    grantorProjectReserve,
    resourceTag ? PERSONAL_RESERVE_UNITS : 0,
  );
  if (projectDemand && grantorMaterialQuantity > grantorReserve) {
    const { project, demand } = projectDemand;
    const sourceFactIds = [...new Set([
      ...permission.sourceEventIds,
      ...project.triggerFactIds,
      ...demand.sourceFactIds,
    ])].slice(-24);
    return {
      version: 'permission-use-basis-v1' as const,
      permissionId: permission.id,
      kind: 'project-demand' as const,
      materialId,
      requiredQuantity: demand.requiredQuantity,
      receiverQuantity: receiverMaterialQuantity,
      grantorQuantity: grantorMaterialQuantity,
      projectId: project.id,
      projectDemandBranchKey: demand.branchKey,
      sourceFactIds,
      basisKey: [
        'permission-use-basis-v1',
        `permission=${permission.id}`,
        'kind=project-demand',
        `project=${project.id}`,
        `branch=${demand.branchKey}`,
        `material=${materialId}`,
        `required=${demand.requiredQuantity}`,
        `receiver=${receiverMaterialQuantity}`,
        `grantor=${grantorMaterialQuantity}`,
      ].join('|'),
    };
  }
  if (!resourceTag) return undefined;
  const receiverResourceQuantity = taggedInventoryQuantity(grantee, resourceTag);
  if (receiverResourceQuantity >= PERSONAL_RESERVE_UNITS
    || grantorResourceQuantity <= PERSONAL_RESERVE_UNITS) return undefined;
  const sourceFactIds = [...new Set([
    ...permission.sourceEventIds,
    ...grantee.inventory.flatMap((stack) => materialHas(stack.materialId, resourceTag) ? stack.sourceEventIds : []),
    ...grantor.inventory.flatMap((stack) => materialHas(stack.materialId, resourceTag) ? stack.sourceEventIds : []),
  ])].slice(-24);
  return {
    version: 'permission-use-basis-v1' as const,
    permissionId: permission.id,
    kind: 'personal-reserve' as const,
    materialId,
    requiredQuantity: PERSONAL_RESERVE_UNITS,
    receiverQuantity: receiverResourceQuantity,
    grantorQuantity: grantorResourceQuantity,
    sourceFactIds,
    basisKey: [
      'permission-use-basis-v1',
      `permission=${permission.id}`,
      'kind=personal-reserve',
      `resource=${resourceTag}`,
      `material=${materialId}`,
      `required=${PERSONAL_RESERVE_UNITS}`,
      `receiver=${receiverResourceQuantity}`,
      `grantor=${grantorResourceQuantity}`,
    ].join('|'),
  };
}

export function permissionUseBasisIsCurrent(
  state: SimulationState,
  permission: ResourcePermission | undefined,
  action: Extract<PrimitiveAction, { kind: 'transfer' }>,
): boolean {
  const basis = action.permissionUseBasis;
  if (!permission || !basis || basis.permissionId !== permission.id) return false;
  const grantee = personById(state, permission.granteeId);
  const grantor = personById(state, permission.grantorId);
  if (!grantee || !grantor) return false;
  const current = inferPermissionUseBasis(state, permission, grantee, grantor);
  return Boolean(current
    && current.basisKey === basis.basisKey
    && current.kind === basis.kind
    && current.materialId === basis.materialId
    && current.requiredQuantity === basis.requiredQuantity);
}

export function permissionAuthorizesTransfer(
  permission: ResourcePermission | undefined,
  actorId: PersonId,
  action: Extract<PrimitiveAction, { kind: 'transfer' }>,
  atMonth: number,
  actualQuantity = action.quantity,
): boolean {
  return Boolean(permission
    && permission.status === 'active'
    && atMonth >= permission.validFromMonth
    && atMonth <= permission.validUntilMonth
    && actorId === permission.granteeId
    && action.from.kind === 'person'
    && action.from.personId === permission.grantorId
    && action.to.kind === 'person'
    && action.to.personId === permission.granteeId
    && action.materialId === permission.materialId
    && action.permissionUseBasis?.permissionId === permission.id
    && actualQuantity > 0
    && actualQuantity <= permission.maxQuantityPerTransfer);
}

function membersStillShareCollective(state: SimulationState, collectiveId: string, grantorId: PersonId, granteeId: PersonId): boolean {
  const collective = state.collectives.find((candidate) => candidate.id === collectiveId && candidate.status === 'active');
  return Boolean(collective && activeMembership(collective, grantorId) && activeMembership(collective, granteeId));
}

/** Accepted speech creates permission; later transfer events exercise it. */
export function recordPermissionAction(state: SimulationState, fact: ActionFact): void {
  if (fact.status !== 'completed') return;
  const action = fact.action;
  if (action.kind === 'talk' && action.speakerMeaning.kind === 'accept') {
    const agreement = agreementById(state, action.speakerMeaning.referenceId);
    if (!agreement || agreement.status !== 'active' || agreement.proposal.kind !== 'permission') return;
    const proposal = agreement.proposal;
    if (fact.who !== proposal.granteeId
      || !membersStillShareCollective(state, proposal.collectiveId, proposal.grantorId, proposal.granteeId)) return;
    const id = `permission:${agreement.id}`;
    if (!permissionById(state, id)) state.permissions.push({
      id,
      collectiveId: proposal.collectiveId,
      grantorId: proposal.grantorId,
      granteeId: proposal.granteeId,
      materialId: proposal.materialId,
      maxQuantityPerTransfer: proposal.maxQuantityPerTransfer,
      validFromMonth: fact.atMonth,
      validUntilMonth: proposal.validUntilMonth,
      status: 'active',
      proposalAgreementId: agreement.id,
      sourceEventIds: [...new Set([...agreement.sourceEventIds, fact.id])],
      useEventIds: [],
    });
    agreement.status = 'fulfilled';
    agreement.resolvedAtMonth = fact.atMonth;
    agreement.fulfillmentEventIds = [...new Set([...agreement.fulfillmentEventIds, fact.id])];
    agreement.fulfilledByPersonIds = [...agreement.partyIds];
    return;
  }
  if (action.kind === 'talk' && action.speakerMeaning.kind === 'revoke') {
    const permission = permissionById(state, action.speakerMeaning.permissionId);
    if (!permission
      || permission.status !== 'active'
      || permission.grantorId !== fact.who
      || !languageInterpreterIds(fact.diff, action.speakerMeaning.id).includes(permission.granteeId)) return;
    permission.status = 'revoked';
    permission.endedAtMonth = fact.atMonth;
    permission.sourceEventIds = [...new Set([...permission.sourceEventIds, fact.id])];
    return;
  }
  if (action.kind !== 'transfer' || !action.authorizationRef) return;
  const permission = permissionById(state, action.authorizationRef);
  if (!permission
    || fact.diff.permissionAuthorized !== true
    || !permissionAuthorizesTransfer(permission, fact.who, action, fact.atMonth, Number(fact.diff.quantity))) return;
  permission.useEventIds = [...new Set([...permission.useEventIds, fact.id])];
  permission.sourceEventIds = [...new Set([...permission.sourceEventIds, fact.id])];
}

export function advancePermissionLifecycle(state: SimulationState, atMonth: number, orderOffset = 0): PermissionFact[] {
  const events: PermissionFact[] = [];
  for (const permission of state.permissions.filter((candidate) => candidate.status === 'active')) {
    const partiesAlive = [permission.grantorId, permission.granteeId].every((id) => {
      const person = personById(state, id);
      return Boolean(person && isAlive(person));
    });
    const expired = atMonth > permission.validUntilMonth;
    const membershipEnded = !membersStillShareCollective(state, permission.collectiveId, permission.grantorId, permission.granteeId);
    if (!expired && partiesAlive && !membershipEnded) continue;
    permission.status = expired ? 'expired' : 'ended';
    permission.endedAtMonth = atMonth;
    const event: PermissionFact = {
      id: `e-${atMonth}-permission-${permission.status}-${permission.id}`,
      kind: 'permission', atMonth, orderInMonth: orderOffset + events.length, cellId: 0,
      permissionId: permission.id,
      change: permission.status,
      partyIds: [permission.grantorId, permission.granteeId],
      result: expired ? '一项物质取用许可已到期' : '共同体成员关系或当事人生存状态已使许可终止',
    };
    permission.sourceEventIds = [...new Set([...permission.sourceEventIds, event.id])];
    events.push(event);
  }
  return events;
}
