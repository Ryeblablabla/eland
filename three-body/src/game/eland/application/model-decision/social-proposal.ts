import type { RepresentationInput, SocialProposal } from '../../domain/action';
import { MATERIAL_PALETTE } from '../../domain/material';
import type { ProjectFunction, RecurringProjectDutySubject } from '../../domain/project';
import type { DecisionProbeHandleMap } from './capability-handles';
import { cellId } from '../../world/grid';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const PROJECT_FUNCTIONS: readonly ProjectFunction[] = [
  'insulation', 'safer-hunting', 'healing', 'prepared-food', 'weather-shelter', 'durable-record',
  'efficient-production', 'workshop-production', 'reserve-storage', 'reliable-water', 'settled-cultivation',
  'crop-processing', 'community-coordination', 'high-heat-processing', 'brick-firing', 'copper-charge',
  'copper-smelting', 'tin-charge', 'tin-smelting', 'bronze-alloying', 'bronze-tooling', 'bronze-workshop',
  'civic-coordination', 'iron-workshop', 'iron-charge', 'iron-reduction', 'iron-working', 'iron-tooling',
  'fortified-coordination', 'water-powered-crop-processing', 'restore-water-powered-crop-processing',
  'durable-power-transmission', 'remote-work-power-delivery', 'restore-electrical-power-delivery', 'comparable-mass-measurement',
];

/** These are the author's explicit terms, never terms selected from an action menu. */
export function compileMindProposalTerms(
  input: unknown,
  kind: SocialProposal['kind'],
  counterpartIds: readonly string[],
  handles: DecisionProbeHandleMap,
  actorId: string,
  bound = false,
): { proposal?: SocialProposal; problems: string[] } {
  const terms = object(input);
  const problems: string[] = [];
  const problem = (field: string) => { if (!problems.includes(field)) problems.push(field); };
  const integer = (field: string, min = 1): number => {
    const value = terms[field];
    if (!Number.isSafeInteger(value) || Number(value) < min) problem(field);
    return Number(value);
  };
  const text = (field: string): string => {
    const value = string(terms[field]);
    if (!value) problem(field);
    return value;
  };
  const person = (field: string): string => {
    const value = string(terms[bound ? field.replace(/Handle$/, 'Id') : field]);
    if (value === 'self' || bound && value === actorId) return actorId;
    if (bound) { if (!value) problem(field); return value; }
    const resolved = handles.visible.find((item) => item.kind === 'person' && (bound ? item.personId === value : item.handle === value));
    if (resolved?.kind !== 'person') { problem(field); return ''; }
    return resolved.personId;
  };
  const reference = (field: string, referenceKind: string): string => {
    const value = string(terms[bound ? field.replace(/Handle$/, 'Id') : field]);
    if (bound) { if (!value) problem(field); return value; }
    const ref = handles.speechReferences?.find((item) => item.kind === referenceKind && (bound ? item.id === value : item.handle === value));
    if (!ref) problem(field);
    return ref?.id ?? '';
  };
  const material = (field: string): number => {
    const value = terms[bound ? field.replace(/Key$/, 'Id') : field];
    const definition = MATERIAL_PALETTE.find((entry) => bound ? entry.id === value : entry.key === value);
    if (!definition || definition.id === 0) problem(field);
    return definition?.id ?? 0;
  };
  const approvers = (): string[] => {
    const values = terms[bound ? 'requiredApproverIds' : 'requiredApproverHandles'];
    if (!Array.isArray(values) || !values.length) { problem('requiredApproverHandles'); return []; }
    const ids = values.map((value) => {
      if (value === 'self' || bound && value === actorId) return actorId;
      if (bound && typeof value === 'string' && value.trim()) return value;
      const ref = handles.visible.find((item) => item.kind === 'person' && (bound ? item.personId === value : item.handle === value));
      if (ref?.kind !== 'person') { problem('requiredApproverHandles'); return ''; }
      return ref.personId;
    });
    if (new Set(ids).size !== ids.length) problem('requiredApproverHandles');
    if (ids.some((id) => id !== actorId && !counterpartIds.includes(id))) problem('counterpartHandles');
    return ids.filter(Boolean);
  };
  if (!actorId) problem('actorId');
  if (!counterpartIds.length || counterpartIds.includes(actorId)) problem('counterpartHandles');
  if (!['joint-action', 'membership', 'decision-rule', 'mandate'].includes(kind) && counterpartIds.length !== 1) problem('counterpartHandles');
  if (kind === 'joint-action') {
    const summary = text('summary');
    const expiresAtMonth = terms.expiresAtMonth == null ? undefined : integer('expiresAtMonth', 0);
    if (bound) {
      if (terms.proposerId !== actorId) problem('proposal.author');
      if (terms.kind !== kind) problem('proposal.kind');
      if (!Array.isArray(terms.inviteeIds) || terms.inviteeIds.length !== counterpartIds.length
        || !counterpartIds.every((id) => (terms.inviteeIds as unknown[]).includes(id))) problem('proposal.invitees');
    }
    return problems.length ? { problems } : { proposal: {
      kind, proposerId: actorId, inviteeIds: [...new Set(counterpartIds)], summary,
      ...(expiresAtMonth !== undefined ? { expiresAtMonth } : {}),
    }, problems };
  }
  if (bound) {
    const author = kind === 'assist' ? terms.requesterId : kind === 'exchange' ? terms.offererId : terms.proposerId;
    const partner = kind === 'assist' ? terms.helperId : terms.partnerId;
    if (author !== actorId) problem('proposal.author');
    if (partner !== counterpartIds[0]) problem('proposal.counterpart');
    if (terms.kind !== kind) problem('proposal.kind');
  }
  const expiresAtMonth = integer('expiresAtMonth', 0);
  const pair = { proposerId: actorId, partnerId: counterpartIds[0] ?? '', expiresAtMonth };
  let proposal: SocialProposal | undefined;
  if (kind === 'reproduce') proposal = { kind, ...pair };
  if (kind === 'assist') {
    const need = string(terms.need);
    if (!['water', 'food', 'shelter', 'company'].includes(need)) problem('need');
    proposal = { kind, requesterId: actorId, helperId: pair.partnerId, expiresAtMonth, need: need as 'water' | 'food' | 'shelter' | 'company' };
  }
  if (kind === 'companion') {
    proposal = { kind, ...pair };
    if (bound && terms.sharedLivingAnchor !== undefined) {
      const anchor = object(terms.sharedLivingAnchor);
      if (anchor.version !== 'shared-living-anchor-v1' || !Number.isInteger(anchor.cellId)
        || !Number.isInteger(anchor.z) || !Number.isFinite(anchor.radius) || Number(anchor.radius) < 0) problem('sharedLivingAnchor');
      else proposal.sharedLivingAnchor = { version: 'shared-living-anchor-v1', cellId: Number(anchor.cellId), z: Number(anchor.z), radius: Number(anchor.radius) };
    } else if (terms.anchorHandle !== undefined || terms.anchorRadius !== undefined) {
      const voxel = handles.voxels.find((item) => item.handle === terms.anchorHandle);
      if (!voxel) problem('anchorHandle');
      if (!Number.isFinite(terms.anchorRadius) || Number(terms.anchorRadius) < 0) problem('anchorRadius');
      if (voxel) proposal.sharedLivingAnchor = { version: 'shared-living-anchor-v1',
        cellId: cellId(voxel.position.x, voxel.position.y), z: voxel.position.z, radius: Number(terms.anchorRadius) };
    }
  }
  if (kind === 'collective') proposal = { kind, ...pair, purposeSummary: text('purposeSummary') };
  if (kind === 'exchange') proposal = { kind, offererId: actorId, partnerId: pair.partnerId, expiresAtMonth,
    offererMaterialId: material('offererMaterialKey'), offererQuantity: integer('offererQuantity'),
    partnerMaterialId: material('partnerMaterialKey'), partnerQuantity: integer('partnerQuantity') };
  if (kind === 'membership') proposal = { kind, ...pair, collectiveId: reference('collectiveHandle', 'collective'),
    candidateId: person('candidateHandle'), requiredApproverIds: approvers() };
  if (kind === 'permission') {
    if (bound && (terms.grantorId !== actorId || terms.granteeId !== pair.partnerId)) problem('permission.parties');
    proposal = { kind, ...pair, collectiveId: reference('collectiveHandle', 'collective'),
      grantorId: actorId, granteeId: pair.partnerId, materialId: material('materialKey'),
      maxQuantityPerTransfer: integer('maxQuantityPerTransfer'), validUntilMonth: integer('validUntilMonth', 0) };
  }
  if (kind === 'mandate') proposal = { kind, ...pair, collectiveId: reference('collectiveHandle', 'collective'),
    decisionRuleId: reference('decisionRuleHandle', 'decision-rule'), holderId: person('holderHandle'), requiredApproverIds: approvers(),
    ...((bound ? terms.projectId : terms.projectHandle) !== undefined ? { projectId: reference('projectHandle', 'project') } : {}) };
  if (kind === 'decision-rule') {
    const method = string(terms.method);
    if (!['unanimous', 'majority-vote'].includes(method)) problem('method');
    const common = { kind, ...pair, collectiveId: reference('collectiveHandle', 'collective'), requiredApproverIds: approvers(),
      method: method as 'unanimous' | 'majority-vote', mandateDurationMonths: integer('mandateDurationMonths') };
    if (terms.scope === 'coordinate-material') proposal = { ...common, scope: terms.scope, materialId: material('materialKey') };
    else if (terms.scope === 'assign-recurring-duty') {
      const duty = object(terms.projectDuty);
      if (!['production', 'construction', 'inquiry'].includes(string(duty.projectKind))) problem('projectDuty.projectKind');
      if (!PROJECT_FUNCTIONS.includes(duty.desiredFunction as ProjectFunction)) problem('projectDuty.desiredFunction');
      if (!['material-contribution', 'knowledge-contribution', 'logistics-advance', 'action-progress'].includes(string(duty.progressKind))) problem('projectDuty.progressKind');
      proposal = { ...common, scope: terms.scope, projectDuty: { version: 'recurring-project-duty-subject-v1',
        projectKind: duty.projectKind, desiredFunction: duty.desiredFunction, progressKind: duty.progressKind } as RecurringProjectDutySubject };
    } else problem('scope');
  }
  return problems.length ? { problems } : { proposal, problems };
}

export function compileMindPredictionTerms(input: unknown): {
  prediction?: Extract<RepresentationInput, { kind: 'prediction' }>['prediction']; problems: string[];
} {
  const terms = object(input);
  const problems = ['predictedStartMonth', 'toleranceMonths', 'expiresAtMonth'].filter((key) => !Number.isSafeInteger(terms[key]) || Number(terms[key]) < 0);
  if (terms.targetEpoch !== 'stable' && terms.targetEpoch !== 'chaotic') problems.push('targetEpoch');
  if (problems.length) return { problems };
  return { prediction: { targetEpoch: terms.targetEpoch as 'stable' | 'chaotic',
    predictedStartMonth: Number(terms.predictedStartMonth), toleranceMonths: Number(terms.toleranceMonths), expiresAtMonth: Number(terms.expiresAtMonth) }, problems };
}
