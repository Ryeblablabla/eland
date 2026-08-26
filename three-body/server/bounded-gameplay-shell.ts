import { isDeepStrictEqual } from 'node:util';

import type { Intent, SimulationState } from '../src/game/eland/domain/model';
import { isAlive, type PersonState } from '../src/game/eland/domain/person';
import type { ProjectState } from '../src/game/eland/domain/project';
import {
  assertCanonicalBoundedObserverHotShell,
  assertLastMaterializedObserverBasis,
  materializeBoundedObserverHotShell,
  type LastMaterializedObserverBasis,
  type ObserverHotShellSource,
} from './bounded-observer-hot-shell';
import type {
  VerifiedRunStateShellArraySegmentPosition,
  VerifiedRunStateShellFieldPosition,
  VerifiedRunStateShellValuePosition,
  VerifiedSchema3RunStateShellReceipt,
  VerifiedSchema3RunStateShellVisitor,
} from './run-state-codec';

export const BOUNDED_GAMEPLAY_SHELL_PROFILE = 'bounded-gameplay-shell-v1' as const;
export const LAST_MATERIALIZED_OBSERVER_BASIS_FIELD =
  'lastMaterializedObserverBasis' as const;

type PersistedBoundedGameplayState = SimulationState & {
  [LAST_MATERIALIZED_OBSERVER_BASIS_FIELD]: LastMaterializedObserverBasis;
};

export interface BoundedGameplayShellAuthority extends ObserverHotShellSource {
  readonly lastMaterializedMilestoneCount: number;
}

export interface BoundedGameplayShellResult {
  readonly state: PersistedBoundedGameplayState;
  readonly sourceArrayLengths: Readonly<Record<string, number>>;
  readonly retainedArrayLengths: Readonly<Record<string, number>>;
}

export interface BoundedGameplayShellAccumulator {
  readonly visitor: Readonly<VerifiedSchema3RunStateShellVisitor>;
  finish(
    receipt: Readonly<VerifiedSchema3RunStateShellReceipt>,
  ): BoundedGameplayShellResult;
}

/**
 * Run-summary projection that distinguishes an exact observer snapshot from a
 * canonical gameplay continuation shell. An empty compact milestone array is
 * never interpreted as evidence that no milestone was materialized.
 */
export function materializedObserverMilestoneCount(state: SimulationState): number {
  const basis = (state as unknown as Record<string, unknown>)[
    LAST_MATERIALIZED_OBSERVER_BASIS_FIELD
  ];
  if (basis === undefined) return state.derived.milestones.length;
  assertCanonicalBoundedObserverHotShell({
    civilization: state.civilization,
    derived: state.derived,
    lastMaterializedObserverBasis: basis,
  });
  assertLastMaterializedObserverBasis(basis);
  return basis.milestoneCount;
}

const REQUIRED_STATE_FIELDS = new Set([
  'schemaVersion',
  'seed',
  'branchId',
  'clock',
  'people',
  'intents',
  'agreements',
  'records',
  'collectives',
  'permissions',
  'containers',
  'eraPredictions',
  'projects',
  'civilization',
  'decisionBudget',
  'derived',
  'lastStep',
]);
const OPTIONAL_STATE_FIELDS = new Set([
  'identityCounters',
  LAST_MATERIALIZED_OBSERVER_BASIS_FIELD,
]);
const REQUIRED_WORLD_FIELDS = new Set([
  'grid',
  'drops',
  'animals',
  'remains',
  'memorials',
  'traffic',
  'mechanicalPower',
]);
const OPTIONAL_WORLD_FIELDS = new Set([
  'historyCursor',
  'electricalPower',
  'physicalStructureIndex',
]);
const POWER_ANCHOR_FUNCTIONS = new Set([
  'water-powered-crop-processing',
  'restore-water-powered-crop-processing',
  'durable-power-transmission',
  'remote-work-power-delivery',
  'restore-electrical-power-delivery',
]);

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`bounded gameplay shell ${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function collectStrings(value: unknown, output: Set<string>): void {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      output.add(current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) stack.push(...current);
    else stack.push(...Object.values(current as Record<string, unknown>));
  }
}

function collectNamedReferences(
  value: unknown,
  projectIds: Set<string>,
  agreementIds: Set<string>,
): void {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (key === 'projectId' && typeof child === 'string') projectIds.add(child);
      if (key === 'agreementId' && typeof child === 'string') agreementIds.add(child);
      if (child && typeof child === 'object') stack.push(child);
    }
  }
}

function terminalIntentTouchesLivingMemory(
  intent: Record<string, unknown>,
  livingMemoryFactIds: ReadonlySet<string>,
): boolean {
  if (livingMemoryFactIds.has(String(intent.sourceDecisionEventId ?? ''))) return true;
  const candidateIds = [
    ...stringArray(intent.actionEventIds),
    ...stringArray(intent.sourceFactIds),
    ...stringArray(recordOf(intent.goalOutcome ?? {}, 'intent.goalOutcome').sourceEventIds),
  ];
  return candidateIds.some((id) => livingMemoryFactIds.has(id));
}

function retainIntent(
  value: unknown,
  livingPersonIds: ReadonlySet<string>,
  activeIntentIds: ReadonlySet<string>,
  livingMemoryFactIds: ReadonlySet<string>,
): value is Intent {
  const intent = recordOf(value, 'intent');
  const status = String(intent.status ?? '');
  if (status === 'active' || status === 'suspended') return true;
  if (activeIntentIds.has(String(intent.id ?? ''))) return true;
  if (livingPersonIds.has(String(intent.ownerId ?? ''))) return true;
  if (typeof intent.returnToIntentId === 'string' && intent.returnOutcome === undefined) return true;
  return terminalIntentTouchesLivingMemory(intent, livingMemoryFactIds);
}

function retainAgreement(
  value: unknown,
  livingPersonIds: ReadonlySet<string>,
  referencedAgreementIds: ReadonlySet<string>,
): boolean {
  const agreement = recordOf(value, 'agreement');
  const status = String(agreement.status ?? '');
  const proposal = recordOf(agreement.proposal, 'agreement.proposal');
  if (status === 'proposed' || status === 'active') return true;
  if (status === 'fulfilled' && proposal.kind === 'companion') return true;
  if (Array.isArray(agreement.responseDeadlineSuspensions)
    && agreement.responseDeadlineSuspensions.length > 0) return true;
  if (referencedAgreementIds.has(String(agreement.id ?? ''))) return true;
  return stringArray(agreement.partyIds).some((personId) => livingPersonIds.has(personId));
}

function terminalProjectNeedsSynchronization(project: Record<string, unknown>): boolean {
  if (typeof project.activeLogisticsEpisodeId === 'string') return true;
  const searchCampaigns = Array.isArray(project.searchCampaigns)
    ? project.searchCampaigns.map((value) => recordOf(value, 'project.searchCampaign'))
    : [];
  if (searchCampaigns.some((campaign) => campaign.status === 'active')) return true;
  const hypothesis = project.hypothesisCampaign === undefined
    ? undefined
    : recordOf(project.hypothesisCampaign, 'project.hypothesisCampaign');
  if (hypothesis?.status === 'active') return true;
  return project.status === 'blocked'
    && project.terminalInquiryOpportunityBasis === undefined
    && ((Array.isArray(hypothesis?.attempts) && hypothesis.attempts.length > 0)
      || searchCampaigns.some((campaign) => campaign.status === 'exhausted'));
}

function completedProjectHasActiveWork(project: ProjectState): boolean {
  return typeof project.activeLogisticsEpisodeId === 'string'
    || (project.logisticsEpisodes ?? []).some((episode) => episode.status === 'active')
    || (project.searchCampaigns ?? []).some((campaign) => campaign.status === 'active')
    || project.hypothesisCampaign?.status === 'active';
}

function compactCompletedProjectSearchCampaigns(
  project: ProjectState,
): ProjectState['searchCampaigns'] {
  return project.searchCampaigns?.map((campaign) => ({
    id: campaign.id,
    projectId: campaign.projectId,
    ownerId: campaign.ownerId,
    actorId: campaign.actorId,
    materialIds: [...campaign.materialIds],
    ...(campaign.planKnowledgeId ? { planKnowledgeId: campaign.planKnowledgeId } : {}),
    basisKey: campaign.basisKey,
    ...(campaign.inheritedTargetKeys
      ? { inheritedTargetKeys: [...campaign.inheritedTargetKeys] }
      : {}),
    ...(campaign.inheritedCampaignIds
      ? { inheritedCampaignIds: [...campaign.inheritedCampaignIds] }
      : {}),
    attemptedTargetKeys: [...campaign.attemptedTargetKeys],
    status: campaign.status,
  })) as ProjectState['searchCampaigns'];
}

function compactCompletedProjectHypothesisCampaign(
  project: ProjectState,
): ProjectState['hypothesisCampaign'] {
  const campaign = project.hypothesisCampaign;
  if (!campaign) return undefined;
  return {
    version: campaign.version,
    id: campaign.id,
    projectId: campaign.projectId,
    actorId: campaign.actorId,
    openedAt: campaign.openedAt,
    budget: campaign.budget,
    ...(campaign.noResponseBudget !== undefined
      ? { noResponseBudget: campaign.noResponseBudget }
      : {}),
    ...(campaign.responseBudget !== undefined
      ? { responseBudget: campaign.responseBudget }
      : {}),
    observedMaterialIds: [],
    sourceFactIds: [],
    sourceKeys: [],
    candidates: [],
    attempts: campaign.attempts
      .filter((attempt) => attempt.outcome === 'response'
        && typeof attempt.verifiedEventId === 'string')
      .map((attempt) => structuredClone(attempt)),
    status: campaign.status,
    ...(campaign.endedAt !== undefined ? { endedAt: campaign.endedAt } : {}),
    ...(campaign.endingReason ? { endingReason: campaign.endingReason } : {}),
  };
}

/**
 * Completed projects stay in their authoritative order and keep the contracts
 * that later gameplay still reads. Month-local planning scratch and already
 * closed request/logistics payloads do not need to remain resident forever.
 *
 * A terminal project carrying active work is internally contradictory. Keep
 * that exact object intact so continuation can synchronize it instead of
 * silently turning an active campaign into a closed archive.
 */
export function compactCompletedProjectForGameplayShell(
  project: ProjectState,
): ProjectState {
  if (project.status !== 'completed' || completedProjectHasActiveWork(project)) return project;

  const compact = { ...project } as ProjectState;
  compact.missingMaterialIds = [];
  compact.reservations = [];
  delete compact.materialDemands;
  delete compact.progressEvidence;
  delete compact.techniqueDemonstrationRequests;
  delete compact.materialContributionRequests;
  delete compact.knowledgeRequests;
  delete compact.pressureHistory;
  delete compact.logisticsEpisodes;
  delete compact.activeLogisticsEpisodeId;
  delete compact.initialLogisticsEpisode;
  delete compact.initialSearchCampaign;
  delete compact.initialMaterialDemands;
  delete compact.initialHypothesisCampaign;

  const searchCampaigns = compactCompletedProjectSearchCampaigns(project);
  if (searchCampaigns) compact.searchCampaigns = searchCampaigns;
  else delete compact.searchCampaigns;
  const hypothesisCampaign = compactCompletedProjectHypothesisCampaign(project);
  if (hypothesisCampaign) compact.hypothesisCampaign = hypothesisCampaign;
  else delete compact.hypothesisCampaign;
  return compact;
}

function retainProject(
  value: unknown,
  livingPersonIds: ReadonlySet<string>,
  referencedProjectIds: ReadonlySet<string>,
): value is ProjectState {
  const project = recordOf(value, 'project');
  if (project.status === 'active' || project.status === 'completed') return true;
  if (terminalProjectNeedsSynchronization(project)) return true;
  if (referencedProjectIds.has(String(project.id ?? ''))) return true;
  if (POWER_ANCHOR_FUNCTIONS.has(String(project.desiredFunction ?? ''))) return true;
  return [
    String(project.ownerId ?? ''),
    ...stringArray(project.beneficiaryIds),
    ...stringArray(project.contributorIds),
  ].some((personId) => livingPersonIds.has(personId));
}

function checkAllowedField(position: Readonly<VerifiedRunStateShellFieldPosition>): void {
  const required = position.scope === 'state' ? REQUIRED_STATE_FIELDS : REQUIRED_WORLD_FIELDS;
  const optional = position.scope === 'state' ? OPTIONAL_STATE_FIELDS : OPTIONAL_WORLD_FIELDS;
  if (!required.has(position.fieldName) && !optional.has(position.fieldName)) {
    throw new Error(
      `bounded gameplay shell 不接受未知 ${position.scope} 字段 ${position.fieldName}`,
    );
  }
  if (position.scope === 'state'
    && position.fieldName === 'derived'
    && position.kind !== 'value') {
    throw new Error('bounded gameplay shell 要求 state.derived 是 opaque value');
  }
}

/**
 * Fold one exact schema-3 manifest into a continuation-only gameplay shell.
 * Output remains staged until the codec supplies its final branded receipt.
 */
export function createBoundedGameplayShellAccumulator(
  authority: Readonly<BoundedGameplayShellAuthority>,
): BoundedGameplayShellAccumulator {
  const stateFields: Record<string, unknown> = {};
  const worldFields: Record<string, unknown> = {};
  const fieldKinds = new Map<string, 'value' | 'array'>();
  const sourceArrayLengths: Record<string, number> = {};
  const retainedArrayLengths: Record<string, number> = {};
  const livingPersonIds = new Set<string>();
  const activeIntentIds = new Set<string>();
  const livingMemoryFactIds = new Set<string>();
  const referencedProjectIds = new Set<string>();
  const referencedAgreementIds = new Set<string>();
  let finished = false;

  const scopedKey = (scope: 'state' | 'world', name: string) => `${scope}.${name}`;
  const targetFor = (scope: 'state' | 'world') => scope === 'state' ? stateFields : worldFields;

  const visitField = (position: Readonly<VerifiedRunStateShellFieldPosition>): void => {
    if (finished) throw new Error('bounded gameplay shell accumulator 已完成');
    checkAllowedField(position);
    const key = scopedKey(position.scope, position.fieldName);
    if (fieldKinds.has(key)) throw new Error(`bounded gameplay shell 字段 ${key} 重复`);
    fieldKinds.set(key, position.kind);
    if (position.kind === 'array') {
      sourceArrayLengths[key] = position.fieldLength;
      retainedArrayLengths[key] = 0;
      targetFor(position.scope)[position.fieldName] = [];
      if (position.scope === 'state' && position.fieldName === 'intents') {
        const peopleLength = sourceArrayLengths['state.people'];
        if (peopleLength === undefined
          || retainedArrayLengths['state.people'] !== peopleLength) {
          throw new Error('bounded gameplay shell 必须先完整流式读取 people 再筛选 intents');
        }
      }
    }
  };

  const visitValue = (
    value: unknown,
    position: Readonly<VerifiedRunStateShellValuePosition>,
  ): void => {
    if (finished) throw new Error('bounded gameplay shell accumulator 已完成');
    const key = scopedKey(position.scope, position.fieldName);
    if (fieldKinds.get(key) !== 'value') {
      throw new Error(`bounded gameplay shell value ${key} 没有匹配的 manifest boundary`);
    }
    if (Object.prototype.hasOwnProperty.call(targetFor(position.scope), position.fieldName)) {
      throw new Error(`bounded gameplay shell value ${key} 重复`);
    }
    targetFor(position.scope)[position.fieldName] = value;
  };

  const visitArraySegment = (
    items: readonly unknown[],
    position: Readonly<VerifiedRunStateShellArraySegmentPosition>,
  ): void => {
    if (finished) throw new Error('bounded gameplay shell accumulator 已完成');
    const key = scopedKey(position.scope, position.fieldName);
    if (fieldKinds.get(key) !== 'array') {
      throw new Error(`bounded gameplay shell array ${key} 没有匹配的 manifest boundary`);
    }
    const target = targetFor(position.scope)[position.fieldName];
    if (!Array.isArray(target)) throw new Error(`bounded gameplay shell array ${key} 未初始化`);

    for (const item of items) {
      let retain = true;
      if (position.scope === 'state' && position.fieldName === 'people') {
        const person = item as PersonState;
        if (isAlive(person)) {
          livingPersonIds.add(person.id);
          if (person.activeIntentId) activeIntentIds.add(person.activeIntentId);
          collectStrings(person.memories, livingMemoryFactIds);
        }
      } else if (position.scope === 'state' && position.fieldName === 'intents') {
        retain = retainIntent(
          item,
          livingPersonIds,
          activeIntentIds,
          livingMemoryFactIds,
        );
        if (retain) collectNamedReferences(item, referencedProjectIds, referencedAgreementIds);
      } else if (position.scope === 'state' && position.fieldName === 'agreements') {
        retain = retainAgreement(item, livingPersonIds, referencedAgreementIds);
      } else if (position.scope === 'state' && position.fieldName === 'projects') {
        retain = retainProject(item, livingPersonIds, referencedProjectIds);
      }
      if (retain) {
        target.push(position.scope === 'state' && position.fieldName === 'projects'
          ? compactCompletedProjectForGameplayShell(item as ProjectState)
          : item);
      }
    }
    retainedArrayLengths[key] = target.length;
  };

  const finish = (
    receipt: Readonly<VerifiedSchema3RunStateShellReceipt>,
  ): BoundedGameplayShellResult => {
    if (finished) throw new Error('bounded gameplay shell accumulator 只能完成一次');
    finished = true;
    if (receipt.rootHash !== authority.stateHash
      || receipt.opaqueObserverValueFieldCount !== 1) {
      throw new Error('bounded gameplay shell receipt 与 authority/opaque profile 不一致');
    }
    for (const fieldName of REQUIRED_STATE_FIELDS) {
      if (!fieldKinds.has(`state.${fieldName}`)) {
        throw new Error(`bounded gameplay shell 缺少 state.${fieldName}`);
      }
    }
    for (const fieldName of REQUIRED_WORLD_FIELDS) {
      if (!fieldKinds.has(`world.${fieldName}`)) {
        throw new Error(`bounded gameplay shell 缺少 world.${fieldName}`);
      }
    }
    if (stateFields.schemaVersion !== 17) {
      throw new Error('bounded gameplay shell 只接受 SimulationState schemaVersion 17');
    }
    const clock = recordOf(stateFields.clock, 'clock');
    if (clock.elapsedMonths !== authority.month) {
      throw new Error('bounded gameplay shell clock 与 store authority 月份不一致');
    }

    const sourceIntentLength = sourceArrayLengths['state.intents'];
    if (!Number.isSafeInteger(sourceIntentLength) || sourceIntentLength < 0) {
      throw new Error('bounded gameplay shell intents 原始长度无效');
    }
    const existingCounters = stateFields.identityCounters === undefined
      ? undefined
      : recordOf(stateFields.identityCounters, 'identityCounters');
    const existingIntentOrdinal = existingCounters?.intentOrdinal;
    if (existingIntentOrdinal !== undefined
      && (!Number.isSafeInteger(existingIntentOrdinal) || Number(existingIntentOrdinal) < 0)) {
      throw new Error('bounded gameplay shell identityCounters.intentOrdinal 无效');
    }
    stateFields.identityCounters = {
      intentOrdinal: Math.max(sourceIntentLength, Number(existingIntentOrdinal ?? 0)),
    };

    const exactCivilization = stateFields.civilization as SimulationState['civilization'];
    const existingBasis = stateFields[LAST_MATERIALIZED_OBSERVER_BASIS_FIELD];
    let observerSource: ObserverHotShellSource = {
      stateHash: authority.stateHash,
      revision: authority.revision,
      month: authority.month,
    };
    if (existingBasis !== undefined) {
      assertLastMaterializedObserverBasis(existingBasis);
      if (existingBasis.milestoneCount !== authority.lastMaterializedMilestoneCount) {
        throw new Error('bounded gameplay shell milestone count 与既有 observer basis 不一致');
      }
      observerSource = existingBasis.source;
    }
    const observer = materializeBoundedObserverHotShell({
      civilization: exactCivilization,
      source: observerSource,
      lastMaterializedMilestoneCount: authority.lastMaterializedMilestoneCount,
      ...(existingBasis === undefined
        ? {}
        : { lastMaterializedObserverBasis: existingBasis }),
    });
    assertCanonicalBoundedObserverHotShell(observer);
    if (existingBasis !== undefined
      && !isDeepStrictEqual(existingBasis, observer.lastMaterializedObserverBasis)) {
      throw new Error('bounded gameplay shell 改写了既有 last-materialized observer basis');
    }
    stateFields.civilization = observer.civilization;
    stateFields.derived = observer.derived;
    stateFields[LAST_MATERIALIZED_OBSERVER_BASIS_FIELD] =
      observer.lastMaterializedObserverBasis;

    const state = {
      ...stateFields,
      world: {
        ...worldFields,
        past: [],
      },
    } as unknown as PersistedBoundedGameplayState;
    return Object.freeze({
      state,
      sourceArrayLengths: Object.freeze({ ...sourceArrayLengths }),
      retainedArrayLengths: Object.freeze({ ...retainedArrayLengths }),
    });
  };

  return Object.freeze({
    visitor: Object.freeze({ visitField, visitValue, visitArraySegment }),
    finish,
  });
}
