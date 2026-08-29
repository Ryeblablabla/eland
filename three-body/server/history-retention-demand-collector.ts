import type { SimulationState } from '../src/game/eland/domain/model';
import { Material, materialHas } from '../src/game/eland/domain/material';
import {
  inventoryCombinationForOutput,
  inventoryCombinationTechniqueId,
} from '../src/game/eland/domain/interaction-rules';
import {
  canonicalMeasurementSourceEventIds,
  type MeasurementStackReceipt,
} from '../src/game/eland/domain/measurement';
import { personalMassCalibrationLeaseKey } from '../src/game/eland/domain/actions/measurement-actions';
import {
  MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
  validatedMechanicalPowerReliabilityCycleReceipts,
  type MechanicalPowerReliabilityCycleReceipt,
} from '../src/game/eland/domain/mechanical-power';
import {
  ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX,
  ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
  ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
  ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
  activeElectricalMaintenanceProjectLeaseKey,
  activeElectricalMaintenanceReplacementLeaseKey,
  currentElectricalNetworkFaultLeaseKey,
  currentElectricalNetworkRepairLeaseKey,
  electricalPowerFaultObservationFactId,
  livingPersonElectricalComponentTechniqueLeaseKey,
  livingPersonElectricalFaultObservationLeaseKey,
  livingPersonElectricalLoadTechniqueKnowledgeLeaseKey,
  livingPersonElectricalMechanicalServiceLeaseKey,
  livingPersonElectricalOperationKnowledgeLeaseKey,
  sameElectricalPosition,
} from '../src/game/eland/domain/electrical-power';
import {
  MAX_COORDINATION_PRACTICES,
  MAX_PRACTICE_EPISODES,
  MAX_SOCIAL_BELIEF_RECEIPTS,
  MAX_SOCIAL_BELIEF_SOURCES,
  MAX_SOCIAL_COOPERATION_BELIEFS,
} from '../src/game/eland/domain/social-learning';
import {
  MAX_LIVE_INTENT_ACTION_EVENT_IDS,
  groundedConversationOpeningsForListener,
  hasRecentGroundedConversationResponseForListener,
  liveAgreementHistoryLeaseKey,
  liveIntentHistoryLeaseKey,
  liveSocialEvidenceForPersonSources,
  waterAssistanceEvidenceLeaseKey,
  waterAssistanceFulfillmentMembershipGroupKey,
} from '../src/game/eland/domain/event-index';
import type { AssistanceProposal } from '../src/game/eland/domain/agreement';
import {
  livePersonSocialEvidenceGroupKey,
  livePersonSocialEvidenceLeaseKey,
  livePersonSocialSourceEventIds,
  livePersonSocialStrictEvidenceGroupKey,
  livePersonSocialStrictEvidenceLeaseKey,
  measurementUncertaintyRawSourceEventIds,
  selectLivePersonSocialStrictEvidenceEventIds,
} from '../src/game/eland/domain/live-social-evidence';
import { rememberedProjectPressureSourceEventIds } from '../src/game/eland/domain/project-pressure-evidence';
import { latestSharedProjectBetween } from '../src/game/eland/domain/project-participant-index';
import {
  MODERN_RECORD_EXPERIMENT_LEASE_KEY,
  firstIndependentRecordReuseFact,
  modernElectricalOperationLeaseKey,
  modernCompletedMeasurementReceiptLeaseKey,
} from '../src/game/eland/domain/era-progression';
import {
  FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
  FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY,
  FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY,
  FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY,
  FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
  CALIBRATION_SOURCE_GROUP_SUFFIX,
  HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS,
  HISTORY_RETENTION_MAX_ACTIVE_WATER_ASSISTANCE_AGREEMENTS,
  HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS,
  HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON,
  HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS,
  HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_ELECTRICAL_MAINTENANCE_PROJECT_EVENT_IDS,
  HISTORY_RETENTION_MAX_ELECTRICAL_NETWORKS,
  HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS,
  HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVE_INTENT_SUPPORTING_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS,
  HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON,
  HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL,
  HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS,
  HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON,
  HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL,
  HISTORY_RETENTION_MAX_WATER_ASSISTANCE_FULFILLMENT_EVENT_IDS,
  HISTORY_RETENTION_RECENT_TERMINAL_FAILURE_WINDOW_MONTHS,
  LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX,
  RECENT_PRODUCTION_WINDOW_LEASE,
  groundedConversationResponseSourceLeaseKey,
  recentPersonalProductionWindowGroupKey,
  recentTerminalFailureActionLeaseKey,
  socialLearningSourceLeaseKey,
  type HistoryRetentionRequirement,
  type HistoryRetentionSeal,
} from './history-retention-contract';

/** Pure, server-only collection of bounded history demand from one final shell. */

export interface DirectDemandGroup {
  groupKey: string;
  requirement: HistoryRetentionRequirement;
  leaseKeys: Set<string>;
  eventIds: Set<string>;
}

export interface CalibrationSelector {
  leaseKey: string;
  personId: string;
  instrument: MeasurementStackReceipt;
}

export interface WaterAssistanceSelector {
  agreementId: string;
  proposal: AssistanceProposal;
  helperLeaseKey: string;
  requesterLeaseKey: string;
  membershipGroupKey: string;
  fulfillmentEventIds: Set<string>;
}

export interface ReproductionFactDemand {
  intentId: string;
  ownerId: string;
  createdAtMonth: number;
  femaleId: string | null;
  agreementId: string | null;
  acceptedAtMonth: number | null;
  dueAtMonth: number | null;
  lastAttemptAtMonth: number | null;
  attemptEventIds: Set<string>;
  resolvedAttemptEventIds: Set<string>;
  attemptMonths: Set<number>;
  resolvedAttemptMonthsByEventId: Map<string, number>;
}

let historyRetentionDemandCollectionCount = 0;
let historyRetentionIntentFullTraversalCount = 0;
let historyRetentionIntentSnapshotClassificationCount = 0;
let historyRetentionIntentReferenceCollectionCount = 0;

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`);
}

export function requiredEventId(value: string, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${context} 含空 source event ID`);
  return value;
}

function addDemandGroup(
  groups: Map<string, DirectDemandGroup>,
  demandedIds: Set<string>,
  input: {
    groupKey: string;
    requirement: HistoryRetentionRequirement;
    leaseKey: string;
    eventIds: readonly string[];
    includeEmpty?: boolean;
  },
): void {
  if (input.eventIds.length === 0 && !input.includeEmpty) return;
  let group = groups.get(input.groupKey);
  if (!group) {
    group = { groupKey: input.groupKey, requirement: input.requirement, leaseKeys: new Set(), eventIds: new Set() };
    groups.set(input.groupKey, group);
  } else if (group.requirement !== input.requirement) {
    throw new Error(`retention demand group ${input.groupKey} requirement 冲突`);
  }
  group.leaseKeys.add(input.leaseKey);
  for (const value of input.eventIds) {
    const eventId = requiredEventId(value, input.groupKey);
    group.eventIds.add(eventId);
    demandedIds.add(eventId);
  }
}

function boundedCanonicalEventIds(
  values: readonly string[] | undefined,
  context: string,
): string[] {
  if (!Array.isArray(values)
    || values.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
    throw new Error(`${context} 超出有界续接上限 ${HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS}`);
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedCanonicalEventIdsAtMost(
  values: readonly string[] | undefined,
  context: string,
  maximum: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new Error(`${context} 超出有界续接上限 ${maximum}`);
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedCompletedProjectSourceEventIds(
  values: readonly string[] | undefined,
  context: string,
): string[] {
  if (!Array.isArray(values)
    || values.length > HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS) {
    throw new Error(
      `${context} 超出已完成项目有界来源上限`
      + ` ${HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS}`,
    );
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedElectricalFactEventIds(
  values: readonly string[] | undefined,
  context: string,
  maximum = ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new Error(`${context} 超出电力事实来源上限 ${maximum}`);
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedLivePersonSocialEventIds(
  person: SimulationState['people'][number],
): string[] {
  return livePersonSocialSourceEventIds(person);
}

function boundedLiveProjectPressureSourceEventIds(
  livingPeople: readonly SimulationState['people'][number][],
): string[] {
  const values = livingPeople.flatMap(rememberedProjectPressureSourceEventIds);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'living person project-pressure remembered sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS) {
    throw new Error(
      'living person project-pressure source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureFamilyStoredFoodSourceEventIds(state: SimulationState): string[] {
  const values = (state.containers ?? []).flatMap((container) => [
    ...container.sourceEventIds,
    ...container.inventory
      .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'))
      .flatMap((stack) => stack.sourceEventIds),
  ]);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future family-readiness stored-food sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS) {
    throw new Error(
      'future family-readiness stored-food source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureSocialRepetitionSourceEventIds(
  state: SimulationState,
  livingPeople: readonly SimulationState['people'][number][],
): string[] {
  const rememberedEventIds = new Set(livingPeople.flatMap((person) => (
    person.memories.flatMap((memory) => memory.sourceEventIds)
  )));
  const values = (state.agreements ?? [])
    .filter((agreement) => rememberedEventIds.has(agreement.proposalEventId))
    .flatMap((agreement) => agreement.sourceEventIds ?? []);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future social-repetition agreement outcome sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS) {
    throw new Error(
      'future social-repetition source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureCognitiveAppraisalSourceEventIds(
  livingPeople: readonly SimulationState['people'][number][],
): string[] {
  const values = livingPeople.flatMap((person) => [
    ...(person.cognition?.outcomeBeliefs ?? []).flatMap((belief) => belief.sourceEventIds),
    ...(person.cognition?.goalOutcomeBeliefs ?? []).flatMap((belief) => belief.sourceEventIds),
    ...(person.cognition?.needResolutionEpisodes ?? []).flatMap((episode) => episode.sourceFactIds),
    ...(person.personality?.changes ?? []).slice(-6).flatMap((change) => change.sourceEventIds),
    ...(person.traits ?? []).flatMap((trait) => trait.sourceEventIds),
  ]);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future cognitive-appraisal living sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS) {
    throw new Error(
      'future cognitive-appraisal source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedSocialLearningSourceEventIds(
  person: SimulationState['people'][number],
): string[] {
  const socialLearning = person.cognition?.socialLearning;
  if (!socialLearning) return [];
  if (socialLearning.version !== 'social-learning-v1'
    || !Array.isArray(socialLearning.beliefs)
    || socialLearning.beliefs.length > MAX_SOCIAL_COOPERATION_BELIEFS
    || !Array.isArray(socialLearning.coordinationPractices)
    || socialLearning.coordinationPractices.length > MAX_COORDINATION_PRACTICES) {
    throw new Error(`person ${person.id} social learning state 无效`);
  }
  const values: string[] = [];
  for (const belief of socialLearning.beliefs) {
    if (!Array.isArray(belief.sourceEventIds)
      || belief.sourceEventIds.length > MAX_SOCIAL_BELIEF_SOURCES
      || !Array.isArray(belief.receipts)
      || belief.receipts.length > MAX_SOCIAL_BELIEF_RECEIPTS) {
      throw new Error(`person ${person.id} social learning belief sources 无效或超界`);
    }
    values.push(...belief.sourceEventIds);
    for (const receipt of belief.receipts) {
      if (!Array.isArray(receipt.sourceEventIds)
        || receipt.sourceEventIds.length > MAX_SOCIAL_BELIEF_SOURCES) {
        throw new Error(`person ${person.id} social learning receipt sources 无效或超界`);
      }
      values.push(...receipt.sourceEventIds);
    }
  }
  for (const practice of socialLearning.coordinationPractices) {
    if (!Array.isArray(practice.sourceFactIds)
      || practice.sourceFactIds.length > MAX_SOCIAL_BELIEF_SOURCES
      || !Array.isArray(practice.successes)
      || practice.successes.length > MAX_PRACTICE_EPISODES
      || !Array.isArray(practice.recentCounterEvidence)
      || practice.recentCounterEvidence.length > MAX_PRACTICE_EPISODES) {
      throw new Error(`person ${person.id} coordination practice sources 无效或超界`);
    }
    values.push(...practice.sourceFactIds);
    for (const episode of [...practice.successes, ...practice.recentCounterEvidence]) {
      if (!Array.isArray(episode.sourceEventIds)
        || episode.sourceEventIds.length > MAX_SOCIAL_BELIEF_SOURCES) {
        throw new Error(`person ${person.id} coordination practice episode sources 无效或超界`);
      }
      values.push(...episode.sourceEventIds);
    }
  }
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    `person ${person.id} social learning sources`,
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON) {
    throw new Error(
      `person ${person.id} social learning source IDs 超出有界上限 `
      + HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON,
    );
  }
  return eventIds;
}

interface GroundedResponseSourceDemand {
  responderId: string;
  openingEventId: string;
  eventIds: string[];
}

interface RecentTerminalFailureActionDemand {
  ownerId: string;
  eventIds: string[];
}

type HistoryRetentionIntent = SimulationState['intents'][number];

interface HistoryRetentionIntentDemandSources {
  groundedResponseIntents: readonly HistoryRetentionIntent[];
  recentTerminalFailureIntents: readonly HistoryRetentionIntent[];
  liveIntents: readonly HistoryRetentionIntent[];
  reproductionIntents: readonly HistoryRetentionIntent[];
}

function groundedResponseSourceDemands(
  state: SimulationState,
  livingPeople: readonly SimulationState['people'][number][],
  intents: readonly HistoryRetentionIntent[],
): GroundedResponseSourceDemand[] {
  const livingPersonIds = new Set(livingPeople.map((person) => person.id));
  const byLeaseKey = new Map<string, {
    responderId: string;
    openingEventId: string;
    eventIds: Set<string>;
  }>();
  const add = (
    responderId: string,
    openingEventId: string,
    sourceFactIds: readonly string[],
  ) => {
    if (!livingPersonIds.has(responderId)) return;
    const leaseKey = groundedConversationResponseSourceLeaseKey(responderId, openingEventId);
    const existing = byLeaseKey.get(leaseKey) ?? {
      responderId,
      openingEventId,
      eventIds: new Set<string>(),
    };
    for (const eventId of boundedCanonicalEventIds(
      [openingEventId, ...sourceFactIds],
      `grounded response ${responderId}/${openingEventId} sources`,
    )) existing.eventIds.add(eventId);
    byLeaseKey.set(leaseKey, existing);
    if (byLeaseKey.size > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS) {
      throw new Error(
        'grounded response source groups 超出有界续接上限 '
        + HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS,
      );
    }
  };

  for (const listener of livingPeople) {
    for (const opening of groundedConversationOpeningsForListener(state, listener.id)) {
      if (hasRecentGroundedConversationResponseForListener(state, listener.id, opening.id)
        || opening.action.kind !== 'communicate'
        || opening.action.content.kind !== 'claim'
        || !opening.action.audience.includes(listener.id)) continue;
      const conversation = opening.action.content.conversation;
      if (conversation?.turn !== 'opening' || conversation.listenerId !== listener.id) continue;
      add(listener.id, opening.id, conversation.sourceFactIds);
    }
  }

  for (const intent of intents) {
    if (!livingPersonIds.has(intent.ownerId)
      || (intent.status !== 'active' && intent.status !== 'suspended')) continue;
    for (const action of [intent.nextAction, intent.completionAction]) {
      if (action?.kind !== 'communicate' || action.content.kind !== 'claim') continue;
      const conversation = action.content.conversation;
      if (conversation?.turn !== 'response'
        || conversation.speakerId !== intent.ownerId
        || !conversation.referenceEventId) continue;
      add(intent.ownerId, conversation.referenceEventId, conversation.sourceFactIds);
    }
  }

  const uniqueEventIds = new Set<string>();
  const demands = [...byLeaseKey.values()]
    .map((demand) => {
      const eventIds = [...demand.eventIds].sort();
      if (eventIds.length > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS) {
        throw new Error(
          `grounded response ${demand.responderId}/${demand.openingEventId}`
          + ` sources 超出有界续接上限 ${HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS}`,
        );
      }
      eventIds.forEach((eventId) => uniqueEventIds.add(eventId));
      return { ...demand, eventIds };
    })
    .sort((left, right) => left.responderId.localeCompare(right.responderId)
      || left.openingEventId.localeCompare(right.openingEventId));
  if (uniqueEventIds.size > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS) {
    throw new Error(
      'grounded response unique source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS,
    );
  }
  return demands;
}

function recentTerminalFailureActionDemands(
  state: SimulationState,
  livingPeople: readonly SimulationState['people'][number][],
  intents: readonly HistoryRetentionIntent[],
): RecentTerminalFailureActionDemand[] {
  const livingPersonIds = new Set(livingPeople.map((person) => person.id));
  const eventIdsByOwnerId = new Map<string, Set<string>>();
  for (const intent of intents) {
    if (!livingPersonIds.has(intent.ownerId)
      || (intent.status !== 'blocked' && intent.status !== 'failed')
      || !intent.goalOutcome) continue;
    const age = state.clock.elapsedMonths - intent.goalOutcome.resolvedAtMonth;
    if (!Number.isSafeInteger(age)
      || age < 0
      || age > HISTORY_RETENTION_RECENT_TERMINAL_FAILURE_WINDOW_MONTHS) continue;
    if (!Array.isArray(intent.actionEventIds)
      || intent.actionEventIds.length > MAX_LIVE_INTENT_ACTION_EVENT_IDS) {
      throw new Error(
        `recent terminal failure intent ${intent.id} actionEventIds 超出有界上限`
        + ` ${MAX_LIVE_INTENT_ACTION_EVENT_IDS}`,
      );
    }
    if (!Array.isArray(intent.goalOutcome.sourceEventIds)
      || intent.goalOutcome.sourceEventIds.length > MAX_LIVE_INTENT_ACTION_EVENT_IDS) {
      throw new Error(
        `recent terminal failure intent ${intent.id} outcome sources 超出有界上限`
        + ` ${MAX_LIVE_INTENT_ACTION_EVENT_IDS}`,
      );
    }
    const outcomeEventIds = new Set(intent.goalOutcome.sourceEventIds.map((eventId) => (
      requiredEventId(eventId, `recent terminal failure intent ${intent.id} outcome sources`)
    )));
    const ownerEventIds = eventIdsByOwnerId.get(intent.ownerId) ?? new Set<string>();
    for (const eventId of intent.actionEventIds) {
      const requiredId = requiredEventId(
        eventId,
        `recent terminal failure intent ${intent.id} action events`,
      );
      if (outcomeEventIds.has(requiredId)) ownerEventIds.add(requiredId);
    }
    if (ownerEventIds.size > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON) {
      throw new Error(
        `recent terminal failure owner ${intent.ownerId} action facts 超出有界上限`
        + ` ${HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON}`,
      );
    }
    if (ownerEventIds.size > 0) eventIdsByOwnerId.set(intent.ownerId, ownerEventIds);
  }
  const demands = [...eventIdsByOwnerId]
    .map(([ownerId, eventIds]) => ({ ownerId, eventIds: [...eventIds].sort() }))
    .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  const totalEventIdCount = demands.reduce((sum, demand) => sum + demand.eventIds.length, 0);
  if (demands.length > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS
    || totalEventIdCount > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL) {
    throw new Error(
      'recent terminal failure action leases 超出有界上限 '
      + `${HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS} people/`
      + `${HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL} total events`,
    );
  }
  return demands;
}

function boundedFutureActiveProjectLogisticsSourceEventIds(
  state: SimulationState,
): string[] {
  const values = state.projects
    .filter((project) => project.status === 'active' && project.activeLogisticsEpisodeId)
    .flatMap((project) => {
      const episode = (project.logisticsEpisodes ?? []).find((candidate) => (
        candidate.id === project.activeLogisticsEpisodeId && candidate.status === 'active'
      ));
      return episode?.sourceEventIds ?? [];
    });
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future active-project logistics sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS) {
    throw new Error(
      'future active-project logistics source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureMaterialAffordanceSourceEventIds(state: SimulationState): string[] {
  const values = [
    ...(state.world.drops ?? [])
      .filter((drop) => drop.quantity > 0)
      .flatMap((drop) => drop.sourceEventIds),
    ...(state.containers ?? []).flatMap((container) => [
      ...container.sourceEventIds,
      ...container.inventory
        .filter((stack) => stack.quantity > 0)
        .flatMap((stack) => stack.sourceEventIds),
    ]),
    ...(state.world.physicalStructureIndex?.structures ?? [])
      .filter((structure) => structure.complete)
      .flatMap((structure) => structure.sourceEventIds),
  ];
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future material-affordance current entity sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS) {
    throw new Error(
      'future material-affordance source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function addActiveProjectAnchorDemand(
  groups: Map<string, DirectDemandGroup>,
  demandedIds: Set<string>,
  project: SimulationState['projects'][number],
  suffix: string,
  values: readonly string[] | undefined,
): void {
  const eventIds = boundedCanonicalEventIds(values ?? [], `active project ${project.id} ${suffix}`);
  addDemandGroup(groups, demandedIds, {
    groupKey: `active-project:${project.id}:${suffix}`,
    requirement: 'all',
    leaseKey: `active-project:${project.id}:${suffix}`,
    eventIds,
  });
}

function isLiving(person: SimulationState['people'][number]): boolean {
  return person.diedAtMonth === undefined && person.body.health > 0;
}

function isMechanicalProject(project: SimulationState['projects'][number]): boolean {
  return project.status === 'active' && (project.desiredFunction === 'water-powered-crop-processing'
    || project.desiredFunction === 'restore-water-powered-crop-processing'
    || project.desiredFunction === 'durable-power-transmission');
}

function isMeasurementProject(project: SimulationState['projects'][number]): boolean {
  return project.status === 'active'
    && project.desiredFunction === 'comparable-mass-measurement';
}

function completedMeasurementWitnessProject(
  state: SimulationState,
): SimulationState['projects'][number] | undefined {
  return state.projects
    .filter((project) => project.status === 'completed'
      && project.desiredFunction === 'comparable-mass-measurement'
      && project.measurementUncertaintyBasis?.version === 'measurement-uncertainty-basis-v1'
      && project.completionEventIds.length > 0)
    .sort((left, right) => (right.completedAtMonth ?? -1) - (left.completedAtMonth ?? -1)
      || right.id.localeCompare(left.id))[0];
}

export function completedLiveProjectCompletionLeaseKey(projectId: string): string {
  return `gameplay:completed-live-project:${encodeURIComponent(projectId)}:completion-events`;
}

export function livingSharedProjectActionLeaseKey(
  firstPersonId: string,
  secondPersonId: string,
  projectId: string,
): string {
  const [first, second] = firstPersonId <= secondPersonId
    ? [firstPersonId, secondPersonId]
    : [secondPersonId, firstPersonId];
  return [
    'gameplay:living-shared-project',
    encodeURIComponent(first),
    encodeURIComponent(second),
    encodeURIComponent(projectId),
    'action-events',
  ].join(':');
}

interface LivingPersonPair { firstPersonId: string; secondPersonId: string }

function livingSharedProjectPairs(
  state: SimulationState,
  livingPersonIds: ReadonlySet<string>,
): LivingPersonPair[] {
  const pairs = new Map<string, LivingPersonPair>();
  for (const project of state.projects) {
    if (project.actionEventIds.length + project.completionEventIds.length === 0) continue;
    const participants = [...new Set([project.ownerId, ...project.contributorIds])]
      .filter((personId) => livingPersonIds.has(personId))
      .sort();
    for (let firstIndex = 0; firstIndex < participants.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < participants.length; secondIndex += 1) {
        const pair: LivingPersonPair = {
          firstPersonId: participants[firstIndex]!,
          secondPersonId: participants[secondIndex]!,
        };
        const key = JSON.stringify([pair.firstPersonId, pair.secondPersonId]);
        pairs.set(key, pair);
        if (pairs.size > HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS) {
          throw new Error(
            `retention living shared-project selectors 超出`
            + ` ${HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS} 人物对上限`,
          );
        }
      }
    }
  }
  return [...pairs.values()].sort((left, right) => (
    left.firstPersonId.localeCompare(right.firstPersonId)
    || left.secondPersonId.localeCompare(right.secondPersonId)
  ));
}

function reliabilityReceiptEventIds(receipt: MechanicalPowerReliabilityCycleReceipt): string[] {
  return [
    receipt.faultEventId,
    ...receipt.faultSourceEventIds,
    receipt.shaftInstallationEventId,
    ...receipt.shaftInstallationSourceEventIds,
    ...(receipt.shaftRepairEventId ? [receipt.shaftRepairEventId] : []),
    ...receipt.shaftRepairSourceEventIds,
    ...receipt.loadedOperationEventIds,
  ];
}

export function pendingEraPredictionWakeLeaseKey(predictionId: string): string {
  return `gameplay:pending-era-prediction:${predictionId}:disputed-wake`;
}

export function livingChildBirthLeaseKey(childId: string): string {
  return `gameplay:living-child:${childId}:birth`;
}

export function reproductionAttemptLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:attempt`;
}

export function reproductionConceptionLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:conception`;
}

function isReproductionIntent(intent: SimulationState['intents'][number]): boolean {
  return intent.status === 'active' && (
    (intent.goal.kind === 'condition' && intent.goal.condition === 'pregnancy' && intent.goal.present)
    || [intent.nextAction, intent.completionAction].some((action) => action?.kind === 'act'
      && action.operation === 'reproduce')
  );
}

function classifyHistoryRetentionIntents(
  intents: readonly HistoryRetentionIntent[],
): HistoryRetentionIntentDemandSources {
  historyRetentionIntentFullTraversalCount += 1;
  historyRetentionIntentSnapshotClassificationCount += 1;
  const liveIntents: HistoryRetentionIntent[] = [];
  const recentTerminalFailureIntents: HistoryRetentionIntent[] = [];
  const reproductionIntents: HistoryRetentionIntent[] = [];
  for (const intent of intents) {
    if (intent.status === 'active' || intent.status === 'suspended') liveIntents.push(intent);
    if (intent.status === 'blocked' || intent.status === 'failed') {
      recentTerminalFailureIntents.push(intent);
    }
    if (isReproductionIntent(intent)) reproductionIntents.push(intent);
  }
  return {
    groundedResponseIntents: liveIntents,
    recentTerminalFailureIntents,
    liveIntents,
    reproductionIntents,
  };
}

function referenceHistoryRetentionIntentFilter(
  intents: readonly HistoryRetentionIntent[],
  predicate: (intent: HistoryRetentionIntent) => boolean,
): HistoryRetentionIntent[] {
  historyRetentionIntentFullTraversalCount += 1;
  return intents.filter(predicate);
}

/** Test oracle matching the four independent pre-snapshot whole-array scans. */
function collectReferenceHistoryRetentionIntentDemandSources(
  intents: readonly HistoryRetentionIntent[],
): HistoryRetentionIntentDemandSources {
  historyRetentionIntentReferenceCollectionCount += 1;
  return {
    groundedResponseIntents: referenceHistoryRetentionIntentFilter(intents, () => true),
    recentTerminalFailureIntents: referenceHistoryRetentionIntentFilter(intents, () => true),
    liveIntents: referenceHistoryRetentionIntentFilter(intents, () => true),
    reproductionIntents: referenceHistoryRetentionIntentFilter(intents, isReproductionIntent),
  };
}

function boundedReproductionAttemptEventIds(
  intent: SimulationState['intents'][number],
  agreement: SimulationState['agreements'][number] | undefined,
): {
  agreementId: string | null;
  acceptedAtMonth: number | null;
  dueAtMonth: number | null;
  lastAttemptAtMonth: number | null;
  attemptEventIds: Set<string>;
} {
  if (!agreement) return {
    agreementId: null,
    acceptedAtMonth: null,
    dueAtMonth: null,
    lastAttemptAtMonth: null,
    attemptEventIds: new Set(),
  };
  if (agreement.proposal.kind !== 'reproduce') {
    throw new Error(`reproduction intent ${intent.id} 引用了非生殖 agreement ${agreement.id}`);
  }
  const raw = agreement.reproductionAttemptEventIds ?? [];
  if (!Array.isArray(raw)
    || raw.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) {
    throw new Error(`reproduction agreement ${agreement.id} 的 attempt event IDs 无效`);
  }
  const allAttemptEventIds = new Set(raw);
  if (allAttemptEventIds.size !== raw.length) {
    throw new Error(`reproduction agreement ${agreement.id} 的 attempt event IDs 重复`);
  }
  if (allAttemptEventIds.size > HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS) {
    throw new Error(
      `reproduction agreement ${agreement.id} 超出 ${HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS} 个月 consent window`,
    );
  }
  const existingAtIntentStart = intent.reproductionAttemptEventIdsAtStart ?? [];
  if (!Array.isArray(existingAtIntentStart)
    || existingAtIntentStart.length > raw.length
    || existingAtIntentStart.some((eventId, index) => (
      typeof eventId !== 'string' || eventId.length === 0 || raw[index] !== eventId
    ))) {
    throw new Error(`reproduction intent ${intent.id} 的 agreement attempt 基线无效`);
  }
  // An agreement can remain active after one party's unsuccessful attempt and
  // expose a fresh intent to the other party later in the same consent window.
  // Attempts that predate that binding are agreement history, not evidence
  // produced by the new intent's lifecycle.
  const attemptEventIds = new Set(raw.slice(existingAtIntentStart.length));

  const hasAcceptedWindow = agreement.acceptedAtMonth !== undefined || agreement.dueAtMonth !== undefined;
  if (raw.length > 0 || hasAcceptedWindow || agreement.status === 'active' || agreement.status === 'fulfilled') {
    if (!Number.isSafeInteger(agreement.acceptedAtMonth)
      || !Number.isSafeInteger(agreement.dueAtMonth)
      || Number(agreement.dueAtMonth) - Number(agreement.acceptedAtMonth) + 1
        !== HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS) {
      throw new Error(`reproduction agreement ${agreement.id} 缺少有效的固定 consent window`);
    }
  }
  if (raw.length > 0) {
    if (!Number.isSafeInteger(agreement.lastReproductionAttemptAtMonth)
      || Number(agreement.lastReproductionAttemptAtMonth) < Number(agreement.acceptedAtMonth)
      || Number(agreement.lastReproductionAttemptAtMonth) > Number(agreement.dueAtMonth)) {
      throw new Error(`reproduction agreement ${agreement.id} 缺少窗口内最后尝试月份`);
    }
  } else if (agreement.lastReproductionAttemptAtMonth !== undefined) {
    throw new Error(`reproduction agreement ${agreement.id} 有最后尝试月份但没有 attempt event ID`);
  }
  return {
    agreementId: agreement.id,
    acceptedAtMonth: agreement.acceptedAtMonth ?? null,
    dueAtMonth: agreement.dueAtMonth ?? null,
    lastAttemptAtMonth: attemptEventIds.size > 0
      ? agreement.lastReproductionAttemptAtMonth ?? null
      : null,
    attemptEventIds,
  };
}

export function collectHistoryRetentionDemand(
  state: SimulationState,
  readShellSeal: () => HistoryRetentionSeal,
  intentCollectionMode: 'snapshot' | 'reference' = 'snapshot',
) {
  historyRetentionDemandCollectionCount += 1;
  const directDemandEventIds = new Set<string>();
  const demandGroupsByKey = new Map<string, DirectDemandGroup>();
  const livingPeople = state.people.filter(isLiving);
  if (livingPeople.length > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS) {
    throw new Error(`retention living gameplay selectors 超出 ${HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS} 人上限`);
  }
  const peopleById = new Map<string, SimulationState['people'][number]>();
  for (const person of state.people) peopleById.set(person.id, person);
  const intents = state.intents ?? [];
  const intentDemandSources = intentCollectionMode === 'reference'
    ? collectReferenceHistoryRetentionIntentDemandSources(intents)
    : classifyHistoryRetentionIntents(intents);
  const millLaborPersonIds = new Set(livingPeople.map((person) => person.id));
  const pendingEraPredictionIds = new Set<string>();
  const livingChildIds = new Set(livingPeople
    .filter((person) => (person.geneticParents?.length ?? 0) > 0)
    .map((person) => person.id));
  const reproductionFactsByIntentId = new Map<string, ReproductionFactDemand>();
  const calibrationSelectorsByPersonId = new Map<string, CalibrationSelector[]>();
  const waterAssistanceSelectorsByEventId = new Map<string, WaterAssistanceSelector[]>();
  let activeWaterAssistanceAgreementCount = 0;
  const productionWindowMonth = state.clock.elapsedMonths;
  const completedMeasurementProject = completedMeasurementWitnessProject(state);
  const independentRecordWitness = firstIndependentRecordReuseFact(state);
  assertNonNegativeSafeInteger(productionWindowMonth, 'retention production window month');
  const target = readShellSeal();
  if (target.tailEventId !== null) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: recentPersonalProductionWindowGroupKey(productionWindowMonth),
    requirement: 'all',
    leaseKey: RECENT_PRODUCTION_WINDOW_LEASE,
    eventIds: [target.tailEventId],
  });
  const liveProjectPressureSourceEventIds = boundedLiveProjectPressureSourceEventIds(livingPeople);
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
    eventIds: liveProjectPressureSourceEventIds,
    includeEmpty: true,
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY,
    requirement: 'audit-only',
    leaseKey: FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY,
    eventIds: boundedFutureFamilyStoredFoodSourceEventIds(state),
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
    eventIds: boundedFutureSocialRepetitionSourceEventIds(state, livingPeople),
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY,
    eventIds: boundedFutureCognitiveAppraisalSourceEventIds(livingPeople),
  });
  if (independentRecordWitness?.diff.recordUseReplicationReceipt === true) {
    const inputSourceEventIds = independentRecordWitness.diff.recordUseInputSourceEventIds;
    if (!Array.isArray(inputSourceEventIds)
      || inputSourceEventIds.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) {
      throw new Error(`现代记录复制见证 ${independentRecordWitness.id} 缺少精确输入来源`);
    }
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${MODERN_RECORD_EXPERIMENT_LEASE_KEY}:replication-input-sources`,
      requirement: 'all',
      leaseKey: MODERN_RECORD_EXPERIMENT_LEASE_KEY,
      eventIds: inputSourceEventIds,
    });
  }
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
    eventIds: boundedFutureActiveProjectLogisticsSourceEventIds(state),
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY,
    requirement: 'audit-only',
    leaseKey: FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY,
    eventIds: boundedFutureMaterialAffordanceSourceEventIds(state),
  });
  for (const response of groundedResponseSourceDemands(
    state,
    livingPeople,
    intentDemandSources.groundedResponseIntents,
  )) {
    const leaseKey = groundedConversationResponseSourceLeaseKey(
      response.responderId,
      response.openingEventId,
    );
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: response.eventIds,
    });
  }
  for (const failure of recentTerminalFailureActionDemands(
    state,
    livingPeople,
    intentDemandSources.recentTerminalFailureIntents,
  )) {
    const leaseKey = recentTerminalFailureActionLeaseKey(failure.ownerId);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: failure.eventIds,
    });
  }

  let calibrationInstrumentCount = 0;
  let calibrationReferenceStackCount = 0;
  let socialLearningEventIdMembershipCount = 0;
  for (const person of livingPeople) {
    const selectors: CalibrationSelector[] = [];
    const seenStackIds = new Set<string>();
    for (const stack of person.inventory.filter((candidate) => candidate.quantity > 0
      && !candidate.recordPayloadId
      && materialHas(candidate.materialId, 'instrument'))) {
      if (seenStackIds.has(stack.id)) throw new Error(`person ${person.id} 含重复 instrument stack ${stack.id}`);
      seenStackIds.add(stack.id);
      if (selectors.length >= HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON
        || calibrationInstrumentCount >= HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS) {
        throw new Error('retention current calibration instrument selectors 超出有界上限');
      }
      const sourceEventIds = canonicalMeasurementSourceEventIds(stack.sourceEventIds);
      if (sourceEventIds.length === 0
        || sourceEventIds.length > HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS
        || sourceEventIds.length !== stack.sourceEventIds.length) {
        throw new Error(`instrument stack ${person.id}/${stack.id} 的 source event IDs 无效或超界`);
      }
      const leaseKey = personalMassCalibrationLeaseKey(person.id, stack.id);
      const instrument: MeasurementStackReceipt = {
        personId: person.id,
        stackId: stack.id,
        materialId: stack.materialId,
        quantity: 1,
        heldQuantity: stack.quantity,
        sourceEventIds,
      };
      selectors.push({ leaseKey, personId: person.id, instrument });
      calibrationInstrumentCount += 1;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${leaseKey}${CALIBRATION_SOURCE_GROUP_SUFFIX}`,
        requirement: 'all',
        leaseKey,
        eventIds: sourceEventIds,
      });
    }
    if (selectors.length) calibrationSelectorsByPersonId.set(person.id, selectors);
    const references = person.inventory.filter((candidate) => candidate.quantity > 0
      && !candidate.recordPayloadId
      && materialHas(candidate.materialId, 'mass-reference'));
    if (references.length > HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON) {
      throw new Error(`person ${person.id} current mass-reference stacks 超出有界上限`);
    }
    for (const stack of references) {
      calibrationReferenceStackCount += 1;
      if (calibrationReferenceStackCount > HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS) {
        throw new Error('retention current mass-reference stack selectors 超出有界上限');
      }
      const sourceEventIds = canonicalMeasurementSourceEventIds(stack.sourceEventIds);
      if (sourceEventIds.length === 0
        || sourceEventIds.length > HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS
        || sourceEventIds.length !== stack.sourceEventIds.length) {
        throw new Error(`mass-reference stack ${person.id}/${stack.id} 的 source event IDs 无效或超界`);
      }
      const base = `gameplay:current-mass-reference:${encodeURIComponent(person.id)}:${encodeURIComponent(stack.id)}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:sources`, requirement: 'all', leaseKey: base, eventIds: sourceEventIds,
      });
    }
    const socialSourceEventIds = boundedLivePersonSocialEventIds(person);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: livePersonSocialEvidenceGroupKey(person.id),
      requirement: 'index-only',
      leaseKey: livePersonSocialEvidenceLeaseKey(person.id),
      eventIds: socialSourceEventIds,
    });
    const rememberedSourceEventIds = [...new Set(person.memories
      .flatMap((memory) => memory.sourceEventIds))];
    const rememberedDescriptors = liveSocialEvidenceForPersonSources(
      state,
      person,
      rememberedSourceEventIds,
    );
    const electricalStrictEventIds = selectLivePersonSocialStrictEvidenceEventIds(
      person.id,
      rememberedDescriptors,
    )['electrical-remote-work'];
    const measurementCandidateEventIds = measurementUncertaintyRawSourceEventIds(person);
    const measurementStrictEventIds = selectLivePersonSocialStrictEvidenceEventIds(
      person.id,
      [],
      measurementCandidateEventIds,
    )['measurement-uncertainty'];
    for (const [kind, eventIds] of [
      ['electrical-remote-work', electricalStrictEventIds],
      ['measurement-uncertainty', measurementStrictEventIds],
    ] as const) {
      const leaseKey = livePersonSocialStrictEvidenceLeaseKey(person.id, kind);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: livePersonSocialStrictEvidenceGroupKey(person.id, kind),
        requirement: 'all',
        leaseKey,
        eventIds,
      });
    }
    const socialLearningSourceEventIds = boundedSocialLearningSourceEventIds(person);
    socialLearningEventIdMembershipCount += socialLearningSourceEventIds.length;
    if (socialLearningEventIdMembershipCount
      > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL) {
      throw new Error(
        'living social learning source memberships 超出有界总上限 '
        + HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL,
      );
    }
    const socialLearningLeaseKey = socialLearningSourceLeaseKey(person.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: socialLearningLeaseKey,
      requirement: 'all',
      leaseKey: socialLearningLeaseKey,
      eventIds: socialLearningSourceEventIds,
    });
  }
  const waterObservationIds = new Set((state.world.mechanicalPower?.sources ?? [])
    .map((source) => `observation:water-current:${source.id}`));
  const currentFaultObservationIds = new Set((state.world.mechanicalPower?.networks ?? [])
    .flatMap((network) => network.fault
      ? [`observation:mechanical-power-fault:${network.id}:${network.fault.faultEventId}`] : []));

  for (const network of state.world.mechanicalPower?.networks ?? []) {
    const receipts = validatedMechanicalPowerReliabilityCycleReceipts(network);
    if (network.reliabilityCycleReceipts !== undefined && !receipts) {
      throw new Error(`mechanical network ${network.id} 的 reliability cycle receipts 无效`);
    }
    for (const receipt of receipts ?? []) {
      const base = `mechanical-network:${network.id}:reliability-cycle:${receipt.faultEventId}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:evidence`,
        requirement: 'all',
        leaseKey: `${base}:evidence`,
        eventIds: reliabilityReceiptEventIds(receipt),
      });
      const operator = peopleById.get(receipt.operatorId);
      if (!operator || !isLiving(operator)) continue;
      const diagnosisId = `observation:mechanical-power-fault:${network.id}:${receipt.faultEventId}`;
      const diagnosis = operator.knowledge.find((fact) => fact.id === diagnosisId
        && fact.kind === 'observation'
        && fact.confidence >= 55);
      if (diagnosis) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:diagnosis:${operator.id}`,
        requirement: 'all',
        leaseKey: `${base}:diagnosis:${operator.id}`,
        eventIds: diagnosis.sourceEventIds,
      });
    }
  }

  for (const agreement of state.agreements ?? []) {
    if (agreement.status !== 'active' && agreement.status !== 'proposed') continue;
    const leaseKey = liveAgreementHistoryLeaseKey(agreement.id);
    const coreEventIds = boundedCanonicalEventIds([
      agreement.proposalEventId,
      ...(agreement.responseEventId ? [agreement.responseEventId] : []),
    ], `live agreement ${agreement.id} core anchors`);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: coreEventIds,
    });
    const coreEventIdSet = new Set(coreEventIds);
    const waterFulfillmentEventIdSet = new Set<string>();
    if (agreement.status === 'active'
      && agreement.proposal.kind === 'assist'
      && agreement.proposal.need === 'water') {
      activeWaterAssistanceAgreementCount += 1;
      if (activeWaterAssistanceAgreementCount
        > HISTORY_RETENTION_MAX_ACTIVE_WATER_ASSISTANCE_AGREEMENTS) {
        throw new Error(
          'retention active water assistance agreements 超出有界上限 '
          + HISTORY_RETENTION_MAX_ACTIVE_WATER_ASSISTANCE_AGREEMENTS,
        );
      }
      const proposal = agreement.proposal;
      if (!agreement.partyIds.includes(proposal.requesterId)
        || !agreement.partyIds.includes(proposal.helperId)) {
        throw new Error(`water assistance agreement ${agreement.id} 参与者与 proposal 不一致`);
      }
      const fulfillmentEventIds = boundedCanonicalEventIdsAtMost(
        agreement.fulfillmentEventIds,
        `water assistance agreement ${agreement.id} fulfillment membership`,
        HISTORY_RETENTION_MAX_WATER_ASSISTANCE_FULFILLMENT_EVENT_IDS,
      );
      for (const eventId of fulfillmentEventIds) waterFulfillmentEventIdSet.add(eventId);
      const helperLeaseKey = waterAssistanceEvidenceLeaseKey(
        agreement.id,
        proposal.requesterId,
        proposal.helperId,
        'helper',
      );
      const requesterLeaseKey = waterAssistanceEvidenceLeaseKey(
        agreement.id,
        proposal.requesterId,
        proposal.helperId,
        'requester',
      );
      const membershipGroupKey = waterAssistanceFulfillmentMembershipGroupKey(
        agreement.id,
        proposal.requesterId,
        proposal.helperId,
      );
      for (const typedLeaseKey of [helperLeaseKey, requesterLeaseKey]) {
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: membershipGroupKey,
          requirement: 'index-only',
          leaseKey: typedLeaseKey,
          eventIds: fulfillmentEventIds,
          includeEmpty: true,
        });
      }
      const selector: WaterAssistanceSelector = {
        agreementId: agreement.id,
        proposal,
        helperLeaseKey,
        requesterLeaseKey,
        membershipGroupKey,
        fulfillmentEventIds: waterFulfillmentEventIdSet,
      };
      for (const eventId of fulfillmentEventIds) {
        const selectors = waterAssistanceSelectorsByEventId.get(eventId) ?? [];
        selectors.push(selector);
        waterAssistanceSelectorsByEventId.set(eventId, selectors);
      }
    }
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${leaseKey}:supporting-sources`,
      requirement: 'audit-only',
      leaseKey,
      eventIds: boundedCanonicalEventIds(
        agreement.sourceEventIds ?? [],
        `live agreement ${agreement.id} supporting sources`,
      ).filter((eventId) => !coreEventIdSet.has(eventId)
        && !waterFulfillmentEventIdSet.has(eventId)),
    });
  }

  for (const intent of intentDemandSources.liveIntents) {
    if (intent.status !== 'active' && intent.status !== 'suspended') continue;
    if (!Array.isArray(intent.actionEventIds)
      || intent.actionEventIds.length > MAX_LIVE_INTENT_ACTION_EVENT_IDS) {
      throw new Error(
        `live intent ${intent.id} actionEventIds 超出有界续接上限`
        + ` ${MAX_LIVE_INTENT_ACTION_EVENT_IDS}`,
      );
    }
    const leaseKey = liveIntentHistoryLeaseKey(intent.id);
    const coreEventIds = boundedCanonicalEventIdsAtMost([
      intent.sourceDecisionEventId,
      ...intent.actionEventIds,
    ], `live intent ${intent.id} core anchors`, HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS);
    const coreEventIdSet = new Set(coreEventIds);
    const supportingEventIds = boundedCanonicalEventIdsAtMost(
      intent.sourceFactIds ?? [],
      `live intent ${intent.id} supporting sources`,
      HISTORY_RETENTION_MAX_LIVE_INTENT_SUPPORTING_SOURCE_EVENT_IDS,
    ).filter((eventId) => !coreEventIdSet.has(eventId));
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: coreEventIds,
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${leaseKey}${LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX}`,
      requirement: 'audit-only',
      leaseKey,
      eventIds: supportingEventIds,
    });
  }

  for (const project of state.projects.filter((candidate) => candidate.status === 'active')) {
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'triggers', project.triggerFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'actions', project.actionEventIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'completions', project.completionEventIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'pressure-basis', project.pressureBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'inquiry-basis', project.inquiryOpportunityBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'mechanical-reliability-basis', project.mechanicalReliabilityBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'measurement-uncertainty-basis', project.measurementUncertaintyBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'remote-work-power-basis', project.remoteWorkPowerBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'electrical-maintenance-basis', project.electricalPowerMaintenanceBasis?.sourceFactIds);
  }

  const livingPersonIds = new Set(livingPeople.map((person) => person.id));
  const completedLiveProjects = state.projects.filter((project) => (
    project.status === 'completed'
    && (livingPersonIds.has(project.ownerId)
      || project.beneficiaryIds.some((personId) => livingPersonIds.has(personId))
      || project.contributorIds.some((personId) => livingPersonIds.has(personId)))
  ));
  if (completedLiveProjects.length > HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS) {
    throw new Error(
      `retention completed projects touching living people 超出`
      + ` ${HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS} 项上限`,
    );
  }
  const completedProjectIds = new Set<string>();
  const completionEventIdsByProject = new Map<SimulationState['projects'][number], string[]>();
  for (const project of completedLiveProjects) {
    if (completedProjectIds.has(project.id)) {
      throw new Error(`retention completed live project ID 重复：${project.id}`);
    }
    completedProjectIds.add(project.id);
    const eventIds = boundedCompletedProjectSourceEventIds(
      project.completionEventIds,
      `completed project ${project.id} completion events`,
    );
    completionEventIdsByProject.set(project, eventIds);
    // The newest strict measurement receipt already has an exact all-of group
    // below. Reuse that source lease instead of duplicating every event into a
    // second group; generic worldEventById still resolves its retained pins.
    if (project === completedMeasurementProject) continue;
    const leaseKey = completedLiveProjectCompletionLeaseKey(project.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds,
    });
  }

  // `latestSharedProjectBetween` is the gameplay authority for project
  // insertion ordering. Only when its exact result is completed do we add this
  // completed-project bridge; active projects are already covered above. The
  // conversation reader resolves, sorts, and takes the last four from the full
  // action+completion ID union. Retaining the exact bounded action membership,
  // together with the completion all-of group, preserves that result without
  // guessing which unresolved IDs might exist in cold history.
  for (const pair of livingSharedProjectPairs(state, livingPersonIds)) {
    const project = latestSharedProjectBetween(
      state,
      pair.firstPersonId,
      pair.secondPersonId,
    );
    if (!project || project.status !== 'completed') continue;
    const completionIds = new Set(completionEventIdsByProject.get(project)
      ?? boundedCompletedProjectSourceEventIds(
        project.completionEventIds,
        `completed shared project ${project.id} completion events`,
      ));
    const actionEventIds = boundedCompletedProjectSourceEventIds(
      project.actionEventIds,
      `completed shared project ${project.id} action events`,
    ).filter((eventId) => !completionIds.has(eventId));
    const leaseKey = livingSharedProjectActionLeaseKey(
      pair.firstPersonId,
      pair.secondPersonId,
      project.id,
    );
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: actionEventIds,
    });
  }

  for (const prediction of (state.eraPredictions ?? []).filter((candidate) => candidate.status === 'pending')) {
    if (prediction.sourceEventIds.length === 0) {
      throw new Error(`pending era prediction ${prediction.id} 缺少可追溯来源事实`);
    }
    pendingEraPredictionIds.add(prediction.id);
    const base = `pending-era-prediction:${prediction.id}`;
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:source`, requirement: 'all',
      leaseKey: pendingEraPredictionWakeLeaseKey(prediction.id),
      eventIds: prediction.sourceEventIds,
    });
  }

  const agreementsById = new Map<string, SimulationState['agreements'][number]>();
  for (const agreement of state.agreements ?? []) {
    if (agreementsById.has(agreement.id)) {
      throw new Error(`reproduction retention shell 含重复 agreement ID ${agreement.id}`);
    }
    agreementsById.set(agreement.id, agreement);
  }
  for (const intent of intentDemandSources.reproductionIntents) {
    const agreement = intent.agreementId ? agreementsById.get(intent.agreementId) : undefined;
    if (intent.agreementId && !agreement) {
      throw new Error(`reproduction intent ${intent.id} 缺少 agreement ${intent.agreementId}`);
    }
    const attemptWindow = boundedReproductionAttemptEventIds(intent, agreement);
    const femaleId = intent.goal.kind === 'condition'
      && intent.goal.condition === 'pregnancy'
      && intent.goal.present
      ? intent.goal.personId
      : null;
    reproductionFactsByIntentId.set(intent.id, {
      intentId: intent.id,
      ownerId: intent.ownerId,
      createdAtMonth: intent.createdAtMonth,
      femaleId,
      ...attemptWindow,
      resolvedAttemptEventIds: new Set(),
      attemptMonths: new Set(),
      resolvedAttemptMonthsByEventId: new Map(),
    });
    const base = `active-reproduction-intent:${intent.id}`;
    // The exact shell already carries the agreement's attempt-ID set and the
    // selector fingerprint binds it. Pin only the originating decision plus
    // the latest matching attempt/conception bodies needed by reverse-find;
    // copying every historical attempt would reintroduce event-count growth.
    const anchorIds = [intent.sourceDecisionEventId];
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:facts`, requirement: 'all',
      leaseKey: reproductionAttemptLeaseKey(intent.id), eventIds: anchorIds,
    });
    if (femaleId) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:facts`, requirement: 'all',
      leaseKey: reproductionConceptionLeaseKey(intent.id), eventIds: anchorIds,
    });
  }

  for (const person of livingPeople) {
    for (const fact of person.knowledge) {
      if (fact.confidence < 55) continue;
      const mechanical = (fact.kind === 'technique' && fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID)
        || (fact.kind === 'observation' && (waterObservationIds.has(fact.id) || currentFaultObservationIds.has(fact.id)));
      if (!mechanical) continue;
      const groupKey = `mechanical-knowledge:${person.id}:${fact.id}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey, requirement: 'all', leaseKey: groupKey, eventIds: fact.sourceEventIds,
      });
    }
  }

  const electricalNetworks = state.world.electricalPower?.networks ?? [];
  if (electricalNetworks.length > HISTORY_RETENTION_MAX_ELECTRICAL_NETWORKS) {
    throw new Error(
      `retention electrical networks 超出 ${HISTORY_RETENTION_MAX_ELECTRICAL_NETWORKS} 项上限`,
    );
  }

  const currentElectricalFaultNetworkIdByKnowledgeId = new Map<string, string>();
  const electricalNetworkIds = new Set<string>();
  for (const network of electricalNetworks) {
    if (electricalNetworkIds.has(network.id)) {
      throw new Error(`retention electrical network ID 重复：${network.id}`);
    }
    electricalNetworkIds.add(network.id);

    const recentOperationEventIds = [...new Set(network.recentOperationEventIds ?? [])].slice(-2);
    if (recentOperationEventIds.length === 2) {
      const leaseKey = modernElectricalOperationLeaseKey(network.id);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: leaseKey,
        requirement: 'all',
        leaseKey,
        eventIds: boundedElectricalFactEventIds(
          recentOperationEventIds,
          `electrical network ${network.id} modern operation receipts`,
          2,
        ),
      });
    }

    if (network.fault) {
      const leaseKey = currentElectricalNetworkFaultLeaseKey(network.id);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: leaseKey,
        requirement: 'all',
        leaseKey,
        eventIds: boundedElectricalFactEventIds(
          [network.fault.faultEventId, ...network.fault.sourceEventIds],
          `electrical network ${network.id} current fault`,
          ELECTRICAL_POWER_SOURCE_EVENT_LIMIT + 1,
        ),
      });
      currentElectricalFaultNetworkIdByKnowledgeId.set(
        electricalPowerFaultObservationFactId(network.id, network.fault.faultEventId),
        network.id,
      );
    }

    // Useful service after restoration resolves exactly the first planned
    // conductor, matching the domain reader rather than retaining every old
    // repair ever performed on the network.
    const currentConductor = network.components.find((component) => component.role === 'conductor'
      && network.plan.conductorPositions.some((position) => sameElectricalPosition(
        component.position,
        position,
      )));
    if (currentConductor?.latestRepairEventId) {
      const leaseKey = currentElectricalNetworkRepairLeaseKey(network.id);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: leaseKey,
        requirement: 'all',
        leaseKey,
        eventIds: boundedElectricalFactEventIds(
          [
            currentConductor.latestRepairEventId,
            ...(currentConductor.latestRepairSourceEventIds ?? []).slice(
              -ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
            ),
          ],
          `electrical network ${network.id} current repair`,
          ELECTRICAL_POWER_SOURCE_EVENT_LIMIT + 1,
        ),
      });
    }
  }

  const conductorRule = inventoryCombinationForOutput(Material.CopperConductor);
  const conductorTechniqueId = conductorRule ? inventoryCombinationTechniqueId(conductorRule) : null;
  if (electricalNetworks.length > 0) {
    for (const person of livingPeople) {
      const operationKnowledge = person.knowledge.find((fact) => fact.kind === 'technique'
        && fact.id === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
        && fact.confidence >= 55);
      if (operationKnowledge) {
        const leaseKey = livingPersonElectricalOperationKnowledgeLeaseKey(person.id);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            operationKnowledge.sourceEventIds,
            `living electrical operator ${person.id} operation knowledge`,
          ),
        });
      }

      // The electrical source check resolves exactly the first reliable
      // mechanical-operation fact, matching the domain reader's `find`.
      const mechanicalServiceKnowledge = person.knowledge.find((fact) => fact.kind === 'technique'
        && fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
        && fact.confidence >= 55);
      if (mechanicalServiceKnowledge) {
        const leaseKey = livingPersonElectricalMechanicalServiceLeaseKey(person.id);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            mechanicalServiceKnowledge.sourceEventIds,
            `living electrical operator ${person.id} mechanical service knowledge`,
          ),
        });
      }

      // Maintenance compiles a conductor only from this person's own reliable
      // blind-response + verification sources. Mirror the reader's last-24
      // source window; the project or observer stage never creates this lease.
      const componentKnowledge = conductorTechniqueId
        ? person.knowledge.find((fact) => fact.kind === 'technique'
          && fact.id === conductorTechniqueId
          && fact.confidence >= 55)
        : undefined;
      if (componentKnowledge && conductorTechniqueId) {
        const leaseKey = livingPersonElectricalComponentTechniqueLeaseKey(
          person.id,
          conductorTechniqueId,
        );
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            componentKnowledge.sourceEventIds.slice(-ELECTRICAL_POWER_SOURCE_EVENT_LIMIT),
            `living electrical maintainer ${person.id} component technique ${conductorTechniqueId}`,
          ),
        });
      }

      const selectedFaultKnowledgeIds = new Set<string>();
      for (const fact of person.knowledge) {
        const networkId = currentElectricalFaultNetworkIdByKnowledgeId.get(fact.id);
        if (!networkId
          || selectedFaultKnowledgeIds.has(fact.id)
          || fact.kind !== 'observation'
          || fact.confidence < 55) continue;
        selectedFaultKnowledgeIds.add(fact.id);
        const leaseKey = livingPersonElectricalFaultObservationLeaseKey(person.id, networkId);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            fact.sourceEventIds.slice(-ELECTRICAL_POWER_RECENT_EVENT_LIMIT),
            `living electrical maintainer ${person.id} current fault observation ${fact.id}`,
            ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
          ),
        });
      }

      const seenLoadTechniqueIds = new Set<string>();
      for (const fact of person.knowledge.filter((candidate) => candidate.kind === 'technique'
        && candidate.id.startsWith(`${ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX}:`)
        && candidate.confidence >= 55)) {
        if (seenLoadTechniqueIds.has(fact.id)) {
          throw new Error(`living electrical operator ${person.id} 含重复 load technique ${fact.id}`);
        }
        seenLoadTechniqueIds.add(fact.id);
        const leaseKey = livingPersonElectricalLoadTechniqueKnowledgeLeaseKey(person.id, fact.id);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            fact.sourceEventIds,
            `living electrical operator ${person.id} load technique ${fact.id}`,
          ),
        });
      }
    }
  }

  for (const project of state.projects.filter((candidate) => candidate.status === 'active'
    && candidate.desiredFunction === 'restore-electrical-power-delivery')) {
    const basis = project.electricalPowerMaintenanceBasis;
    if (!basis
      || basis.version !== 'electrical-power-maintenance-basis-v1'
      || basis.sourceFactIds.length !== 2
      || basis.sourceFactIds[0] !== basis.faultEventId
      || basis.sourceFactIds[1] !== basis.diagnosisEventId) {
      throw new Error(`active electrical maintenance project ${project.id} 缺少可回放的故障诊断依据`);
    }
    const basisLeaseKey = activeElectricalMaintenanceProjectLeaseKey(project.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: basisLeaseKey,
      requirement: 'all',
      leaseKey: basisLeaseKey,
      eventIds: boundedElectricalFactEventIds(
        basis.sourceFactIds,
        `active electrical maintenance project ${project.id} basis`,
        2,
      ),
    });

    // The application reader intentionally sees only the newest 16 project
    // actions. Keep the same source-bound window (including any intervening
    // approach action) so manufacture -> verification -> repair remains exact.
    const replacementLeaseKey = activeElectricalMaintenanceReplacementLeaseKey(project.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: replacementLeaseKey,
      requirement: 'all',
      leaseKey: replacementLeaseKey,
      eventIds: boundedCanonicalEventIds(
        project.actionEventIds.slice(-HISTORY_RETENTION_MAX_ELECTRICAL_MAINTENANCE_PROJECT_EVENT_IDS),
        `active electrical maintenance project ${project.id} replacement actions`,
      ),
    });
  }

  for (const project of state.projects.filter(isMechanicalProject)) {
    const owner = peopleById.get(project.ownerId);
    if (!owner || !isLiving(owner)) continue;
    const base = `active-mechanical-project:${project.id}`;
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:triggers`, requirement: 'all', leaseKey: `${base}:trigger`, eventIds: project.triggerFactIds,
    });
    if (!Array.isArray(project.actionEventIds)
      || project.actionEventIds.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
      throw new Error(
        `active mechanical project ${project.id} actionEventIds 超出有界续接上限`
        + ` ${HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS}`,
      );
    }
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:actions`, requirement: 'all', leaseKey: `${base}:action`, eventIds: project.actionEventIds,
    });
    if ((project.desiredFunction === 'restore-water-powered-crop-processing'
      || project.desiredFunction === 'durable-power-transmission')
      && project.mechanicalPowerFaultEventId !== undefined) {
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:maintenance-fault`, requirement: 'all', leaseKey: `${base}:maintenance-fault`,
        eventIds: [project.mechanicalPowerFaultEventId],
      });
    }
    if (project.desiredFunction === 'durable-power-transmission') {
      const reliability = project.mechanicalReliabilityBasis;
      if (!reliability || reliability.version !== 'mechanical-reliability-basis-v1') {
        throw new Error(`active reliability project ${project.id} 缺少可续接的机械可靠性依据`);
      }
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:reliability-basis`,
        requirement: 'all',
        leaseKey: `${base}:reliability-basis`,
        eventIds: reliability.sourceFactIds,
      });
    }
    const reservedStackIds = new Set(project.reservations.map((reservation) => reservation.stackId));
    for (const stack of owner.inventory.filter((candidate) => reservedStackIds.has(candidate.id))) {
      const groupKey = `${base}:reservation:${stack.id}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey, requirement: 'audit-only', leaseKey: `${base}:reserved-inventory:${owner.id}:${stack.id}`,
        eventIds: stack.sourceEventIds,
      });
    }
  }

  for (const project of state.projects.filter(isMeasurementProject)) {
    const owner = peopleById.get(project.ownerId);
    if (!owner || !isLiving(owner)) continue;
    const basis = project.measurementUncertaintyBasis;
    if (!basis || basis.version !== 'measurement-uncertainty-basis-v1') {
      throw new Error(`active measurement project ${project.id} 缺少可续接的个人不确定性依据`);
    }
    if (!Array.isArray(project.actionEventIds)
      || project.actionEventIds.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
      throw new Error(
        `active measurement project ${project.id} actionEventIds 超出有界续接上限`
        + ` ${HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS}`,
      );
    }
    const base = `active-measurement-project:${project.id}`;
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:triggers`, requirement: 'all', leaseKey: `${base}:trigger`,
      eventIds: project.triggerFactIds,
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:uncertainty-basis`, requirement: 'all', leaseKey: `${base}:uncertainty-basis`,
      eventIds: basis.sourceFactIds,
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:actions`, requirement: 'all', leaseKey: `${base}:action`,
      eventIds: project.actionEventIds,
    });
    const basisStackIds = new Set(basis.samples.map((sample) => sample.stackId));
    for (const stack of owner.inventory.filter((candidate) => basisStackIds.has(candidate.id)
      || candidate.materialId === Material.BeamBalance
      || candidate.materialId === Material.StandardWeight)) {
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:entity:${stack.id}`,
        requirement: 'all',
        leaseKey: `${base}:entity:${owner.id}:${stack.id}`,
        eventIds: stack.sourceEventIds,
      });
    }
  }

  // One strict project completion already freezes the full manufacture ->
  // calibration -> measurement source chain. Retain the newest such proof as
  // a bounded society-level observer witness after its project leaves active
  // state; planning never reads this server-only lease.
  if (completedMeasurementProject) {
    const leaseKey = modernCompletedMeasurementReceiptLeaseKey(completedMeasurementProject.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey, requirement: 'all', leaseKey,
      eventIds: completedMeasurementProject.completionEventIds,
    });
  }

  for (const network of state.world.mechanicalPower?.networks ?? []) {
    const base = `mechanical-network:${network.id}`;
    if (network.fault) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:current-fault`, requirement: 'all', leaseKey: `${base}:current-fault`,
      eventIds: [network.fault.faultEventId, ...network.fault.sourceEventIds],
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:service-cycle-operations`,
      requirement: 'all',
      leaseKey: `${base}:service-cycle-operation`,
      eventIds: network.serviceCycleOperationEventIds ?? [],
    });
  }
  return {
    directDemandEventIds,
    demandGroupsByKey,
    millLaborPersonIds,
    pendingEraPredictionIds,
    livingChildIds,
    reproductionFactsByIntentId,
    calibrationSelectorsByPersonId,
    waterAssistanceSelectorsByEventId,
    productionWindowMonth,
  };
}

export type HistoryRetentionCollectedDemand = ReturnType<typeof collectHistoryRetentionDemand>;

/** Test/benchmark observability only; never serialized into authority. */
export function resetHistoryRetentionDemandCollectionCountForTests(): void {
  historyRetentionDemandCollectionCount = 0;
}

/** Test/benchmark observability only; never serialized into authority. */
export function historyRetentionDemandCollectionStatsForTests(): Readonly<{
  collections: number;
}> {
  return Object.freeze({ collections: historyRetentionDemandCollectionCount });
}

/** Test/benchmark observability only; counters never enter authoritative state. */
export function resetHistoryRetentionIntentTraversalStatsForTests(): void {
  historyRetentionIntentFullTraversalCount = 0;
  historyRetentionIntentSnapshotClassificationCount = 0;
  historyRetentionIntentReferenceCollectionCount = 0;
}

/** Test/benchmark observability only; counters never enter authoritative state. */
export function historyRetentionIntentTraversalStatsForTests(): Readonly<{
  fullTraversals: number;
  snapshotClassifications: number;
  referenceCollections: number;
}> {
  return Object.freeze({
    fullTraversals: historyRetentionIntentFullTraversalCount,
    snapshotClassifications: historyRetentionIntentSnapshotClassificationCount,
    referenceCollections: historyRetentionIntentReferenceCollectionCount,
  });
}
