import type { GroundedConversationRef, PrimitiveAction } from '../action';
import { Material, materialHas } from '../material';
import {
  ageMonths,
  inventoryQuantity,
  isAlive,
  MIN_TEACHING_AGE_MONTHS,
  type PersonState,
} from '../person';
import type { SimulationState } from '../model';
import type { ProjectState } from '../project';
import {
  hasRecentGroundedConversationResponseForListener,
  hasRememberedGroundedConversationOpeningBasis,
  liveSocialEvidenceForPersonSource,
  planningOverlayEvents,
  worldEventById,
} from '../event-index';
import {
  livePersonSocialSourceEventIds,
  liveSocialEvidenceDescriptorFromWorldEvent,
  type LiveSocialEvidenceDescriptor,
} from '../live-social-evidence';
import { agreementsForPerson } from '../agreement';
import {
  techniqueOutputMaterialId,
} from '../technique-demonstration';
import { inspectProjectMaterialContributionRequest } from '../project-material-request';
import {
  inspectProjectKnowledgeRequest,
  pendingProjectKnowledgeOutput,
  personReliablyKnowsOutput,
  registerProjectKnowledgeRequestListeners,
} from '../project-knowledge-request';
import { MAX_ERA_PREDICTION_HORIZON_MONTHS } from '../era-prediction';
import { learnOfDeath } from '../mortuary';
import { applyRelationEvidence, relationTo } from '../relation';
import { rememberMaterialPlace } from '../spatial-knowledge';
import { projectById } from '../state-index';
import { projectIsLedBy } from '../project-leadership';
import { maternalFirstTeachingConfidence } from '../trait';
import { positionsWithinVoiceRange } from '../social-space';
import { cellsInRadius } from '../../world/grid';
import { conversationEpisodeById } from '../agent-memory';
import { clamp, nearbyFacilityMaterial, sameIds } from './execution-helpers';
import { addInventory } from './inventory';
import { parsedMineralObservation } from './material-observations';

function projectSupportsMaterialContribution(
  project: Pick<ProjectState, 'need' | 'desiredFunction'>,
): boolean {
  return project.need === 'alloy-capability'
    || project.need === 'iron-capability'
    || project.need === 'mechanical-power-capability'
    || project.need === 'equipment-reliability'
    || (project.need === 'coordination-capacity' && project.desiredFunction === 'civic-coordination');
}

type GroundedConversationValidation =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'valid';
      conversation: GroundedConversationRef;
      trustDelta: number;
      bondDelta: number;
    };

function groundedConversationSourceMatches(
  state: SimulationState,
  person: PersonState,
  listener: PersonState,
  content: Extract<PrimitiveAction, { kind: 'communicate' }>['content'] & { kind: 'claim' },
  conversation: GroundedConversationRef,
): boolean {
  const sourceOwner = conversation.topic === 'care' ? listener : person;
  const ownerSourceIds = new Set(livePersonSocialSourceEventIds(sourceOwner));
  const sources = conversation.sourceFactIds.map((sourceId): LiveSocialEvidenceDescriptor | undefined => {
    if (ownerSourceIds.has(sourceId)) {
      return liveSocialEvidenceForPersonSource(state, sourceOwner, sourceId);
    }
    const event = worldEventById(state, sourceId);
    return event ? liveSocialEvidenceDescriptorFromWorldEvent(event) : undefined;
  });
  if (!sources.length || sources.some((source) => !source)) return false;
  if (conversation.topic === 'open') {
    if (!conversation.openGroundingCompiled || content.factId) return false;
    const personallyAvailable = new Set([
      ...person.memories.flatMap((memory) => memory.sourceEventIds),
      ...person.knowledge.flatMap((knowledge) => knowledge.sourceEventIds),
      ...(relationTo(person, listener.id)?.sourceEventIds ?? []),
    ]);
    return conversation.sourceFactIds.every((sourceId) => personallyAvailable.has(sourceId));
  }
  if (conversation.topic === 'everyday'
    || conversation.topic === 'reminiscence'
    || conversation.topic === 'playful') {
    const relationSources = new Set(relationTo(person, listener.id)?.sourceEventIds ?? []);
    return sources.every((source) => {
      if (!source || !relationSources.has(source.eventId)) return false;
      if (source.action) {
        return source.action.completed
          && source.action.actionKind !== 'communicate'
          && source.action.actorId === listener.id
          && source.action.supportRecipientIds.includes(person.id);
      }
      if (source.agreementFulfilled) return true;
      if (!source.environment
        || (source.environment.change !== 'founding' && source.environment.change !== 'relationship')) return false;
      const participants = new Set(source.environment.participantIds);
      return participants.has(person.id)
        && participants.has(listener.id)
        && !source.environment.excludedPairKeys.includes(
          [person.id, listener.id].sort().join('|'),
        );
    });
  }
  if (conversation.topic === 'care') {
    const conditionSources = new Set(listener.conditions.flatMap((condition) => condition.sourceEventIds));
    return conversation.sourceFactIds.every((sourceId) => conditionSources.has(sourceId));
  }
  if (conversation.topic === 'hardship') {
    const conditionSources = new Set(person.conditions.flatMap((condition) => condition.sourceEventIds));
    return conversation.sourceFactIds.every((sourceId) => conditionSources.has(sourceId));
  }
  if (conversation.topic === 'gratitude') return sources.every((source) => {
    if (!source?.action?.completed) return false;
    const directSupport = source.action.actorId === listener.id
      && source.action.supportRecipientIds.includes(person.id);
    const fulfilledSupport = agreementsForPerson(state, person.id).some((agreement) => (
      agreement.status === 'fulfilled'
      && agreement.partyIds.includes(listener.id)
      && agreement.fulfilledByPersonIds.includes(listener.id)
      && agreement.fulfillmentEventIds.includes(source!.eventId)
    ));
    return directSupport || fulfilledSupport;
  });
  if (conversation.topic === 'shared-work') return state.projects.some((project) => {
    const participantIds = new Set([project.ownerId, ...project.contributorIds]);
    const projectSources = new Set([...project.actionEventIds, ...project.completionEventIds]);
    return participantIds.has(person.id)
      && participantIds.has(listener.id)
      && conversation.sourceFactIds.every((sourceId) => projectSources.has(sourceId));
  });
  if (conversation.topic === 'failure') {
    const failureSources = new Set(person.memories
      .filter((memory) => memory.kind === 'failure')
      .flatMap((memory) => memory.sourceEventIds));
    return conversation.sourceFactIds.every((sourceId) => failureSources.has(sourceId));
  }
  if (conversation.topic === 'discovery') {
    const knowledge = content.factId ? person.knowledge.find((fact) => fact.id === content.factId) : undefined;
    return Boolean(knowledge
      && (knowledge.kind === 'observation' || knowledge.kind === 'claim')
      && knowledge.confidence >= 55
      && conversation.sourceFactIds.every((sourceId) => knowledge.sourceEventIds.includes(sourceId)));
  }
  if (conversation.topic === 'loss') {
    const knownDeathIds = new Set((person.bereavements ?? []).map((bereavement) => bereavement.deathEventId));
    return sources.every((source) => source?.environment?.change === 'death'
      && knownDeathIds.has(source.eventId));
  }
  return sources.every((source) => source?.environment?.change === 'body'
    && typeof source.environment.bornPersonId === 'string'
    && state.people.some((child) => child.id === source.environment!.bornPersonId
      && isAlive(child)
      && child.geneticParents.includes(person.id)
      && child.geneticParents.includes(listener.id)));
}

function validateGroundedConversation(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'communicate' }>,
  reached: PersonState[],
  atMonth: number,
): GroundedConversationValidation {
  if (action.content.kind !== 'claim' || !action.content.conversation) return { kind: 'none' };
  const conversation = action.content.conversation;
  const listener = reached.find((candidate) => candidate.id === conversation.listenerId);
  if (conversation.version !== 'grounded-conversation-v1'
    || conversation.speakerId !== person.id
    || action.audience.length !== 1
    || action.audience[0] !== conversation.listenerId
    || !listener
    || conversation.sourceFactIds.length === 0) {
    return { kind: 'blocked', reason: '生活对话的说话者、听者或事实来源不匹配' };
  }
  const episode = conversation.episodeId
    ? conversationEpisodeById(state, conversation.episodeId)
    : undefined;
  if (conversation.episodeId && (!episode
    || ![episode.initiatorId, episode.listenerId].includes(person.id)
    || ![episode.initiatorId, episode.listenerId].includes(listener.id)
    || (conversation.turn === 'opening' && episode.status !== 'reserved')
    || (conversation.turn === 'response'
      && (episode.status !== 'response-reserved'
        || (episode.nextSpeakerId ?? episode.listenerId) !== person.id
        || atMonth > episode.replyByMonth)))) {
    return { kind: 'blocked', reason: '这轮对话没有有效的参与者占用、轮次或回应期限' };
  }
  if (conversation.turn === 'opening') {
    if (conversation.referenceEventId || conversation.stance) {
      return { kind: 'blocked', reason: '生活对话开场不能伪装成回应' };
    }
    const duplicate = hasRememberedGroundedConversationOpeningBasis(
      state,
      conversation.basisKey,
      person.id,
      listener.id,
    );
    if (duplicate || !groundedConversationSourceMatches(state, person, listener, action.content, conversation)) {
      return { kind: 'blocked', reason: duplicate ? '同一段生活经历已经谈过' : '生活对话没有可解析且属于双方的真实来源' };
    }
    const lowStakesTopic = ['open', 'everyday', 'reminiscence', 'playful'].includes(conversation.topic);
    const warmTopic = ['care', 'gratitude', 'shared-work', 'family', 'loss'].includes(conversation.topic);
    return {
      kind: 'valid',
      conversation,
      trustDelta: warmTopic ? 1 : 0,
      bondDelta: lowStakesTopic ? 0 : conversation.topic === 'discovery' ? 1 : 2,
    };
  }
  const referenceId = conversation.referenceEventId;
  const previousTurn = referenceId ? worldEventById(state, referenceId) : undefined;
  const previousConversation = previousTurn?.kind === 'action'
    && previousTurn.status === 'completed'
    && previousTurn.action.kind === 'communicate'
    && previousTurn.action.content.kind === 'claim'
    ? previousTurn.action.content.conversation
    : undefined;
  const duplicateResponse = Boolean(referenceId && hasRecentGroundedConversationResponseForListener(
    state,
    person.id,
    referenceId,
  ));
  if (!previousConversation
    || previousConversation.speakerId !== listener.id
    || previousConversation.listenerId !== person.id
    || previousConversation.topic !== conversation.topic
    || previousConversation.basisKey !== conversation.basisKey
    || (conversation.episodeId && previousConversation.episodeId !== conversation.episodeId)
    || !sameIds(previousConversation.sourceFactIds, conversation.sourceFactIds)
    || duplicateResponse) {
    return { kind: 'blocked', reason: duplicateResponse ? '这段生活对话已经回应过' : '回应没有引用人员与来源一致的生活对话开场' };
  }
  // An omitted stance is neutral. The conversation planner must not smuggle a
  // supportive attitude (and therefore relationship growth) into a response
  // merely because the listener chose to speak. Only an explicit, validated
  // supportive stance may carry that consequence.
  const supportive = conversation.stance === 'supportive';
  const lowStakesTopic = ['open', 'everyday', 'reminiscence', 'playful'].includes(conversation.topic);
  return {
    kind: 'valid',
    conversation,
    trustDelta: supportive && !lowStakesTopic ? 1 : 0,
    bondDelta: supportive && !lowStakesTopic ? 2 : 0,
  };
}


export function executeCommunicate(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'communicate' }>, atMonth: number, eventId: string) {
  const coordinationFacilityMaterialId = nearbyFacilityMaterial(
    state,
    person,
    [Material.CouncilHearth, Material.CivicHall, Material.KeepCore],
    3,
  );
  if (action.channel === 'record') {
    const stack = action.carrierStackId ? person.inventory.find((candidate) => candidate.id === action.carrierStackId && candidate.quantity > 0) : undefined;
    if (!stack || !materialHas(stack.materialId, 'recordable') || stack.recordPayloadId) return { status: 'blocked' as const, result: '没有可写且尚未承载内容的记录材料', diff: {} };
    if (action.content.kind !== 'claim' || !action.content.factId) return { status: 'blocked' as const, result: '当前只能把有来源的知识陈述写入记录', diff: {} };
    const knowledgeId = action.content.factId;
    const knowledge = person.knowledge.find((fact) => fact.id === knowledgeId);
    if (!knowledge) return { status: 'blocked' as const, result: '本人并不知道要记录的内容', diff: {} };
    if (knowledge.kind === 'codebook') return { status: 'blocked' as const, result: '编码约定不能作为自己的记录内容再次刻写', diff: {} };
    const priorVersion = state.records.filter((record) => record.knowledgeId === knowledge.id && record.authorId === person.id).reduce((max, record) => Math.max(max, record.version), 0);
    const codebookId = `codebook:record:${person.id}:${knowledge.id}`;
    const payload = {
      id: `record:${atMonth}:${person.id}:${state.records.length}`,
      authorId: person.id,
      knowledgeId: knowledge.id,
      codebookId,
      kind: knowledge.kind,
      summary: knowledge.summary,
      version: priorVersion + 1,
      createdAtMonth: atMonth,
      sourceEventIds: [...new Set([...knowledge.sourceEventIds, eventId])],
    };
    state.records.push(payload);
    const knownCodebook = person.knowledge.find((fact) => fact.id === codebookId);
    if (knownCodebook) {
      knownCodebook.confidence = clamp(knownCodebook.confidence + 16);
      knownCodebook.sourceEventIds = [...new Set([...knownCodebook.sourceEventIds, eventId, payload.id])].slice(-24);
    } else person.knowledge.push({
      id: codebookId,
      kind: 'codebook',
      summary: `这组刻痕表示“${knowledge.summary}”`,
      confidence: 100,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId, payload.id],
    });
    let carrier = stack;
    if (stack.quantity > 1) {
      stack.quantity -= 1;
      carrier = addInventory(person, stack.materialId, 1, [eventId], `stack-${person.id}-${stack.materialId}-${atMonth}-record-${state.records.length}`, payload.id);
    } else {
      stack.recordPayloadId = payload.id;
      stack.sourceEventIds = [...new Set([...stack.sourceEventIds, eventId])].slice(-24);
    }
    return { status: 'completed' as const, result: `${person.name}把“${knowledge.summary}”刻写到木制记录板`, diff: { recordPayloadId: payload.id, carrierStackId: carrier.id, knowledgeId: knowledge.id, version: payload.version } };
  }
  const content = action.content;
  if (content.kind === 'prediction') {
    const horizon = content.prediction.predictedStartMonth - atMonth;
    if (horizon < 1
      || horizon > MAX_ERA_PREDICTION_HORIZON_MONTHS
      || content.prediction.expiresAtMonth !== content.prediction.predictedStartMonth + content.prediction.toleranceMonths) {
      return {
        status: 'blocked' as const,
        result: '纪元预言只能指向未来六个月内的可验证时间窗',
        diff: { predictionHorizonMonths: horizon },
      };
    }
  }
  if (content.kind === 'request' && content.techniqueDemonstration) {
    const request = content.techniqueDemonstration;
    const projectCandidate = projectById(state, request.projectId);
    const project = projectCandidate?.status === 'active'
      && projectCandidate.kind === 'inquiry'
      && projectCandidate.ownerId === person.id
      && projectCandidate.desiredFunction === request.desiredFunction
      ? projectCandidate
      : undefined;
    const repeated = planningOverlayEvents(state).some((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.who === person.id
      && event.action.kind === 'communicate'
      && event.action.content.kind === 'request'
      && event.action.content.techniqueDemonstration?.projectId === request.projectId
      && event.action.audience.some((listenerId) => action.audience.includes(listenerId)))
      || Boolean(project?.techniqueDemonstrationRequests?.some((basis) => (
        basis.requesterId === person.id
          && basis.teacherIds.some((listenerId) => action.audience.includes(listenerId))
      )));
    if (!project || request.requesterId !== person.id || request.expiresAtMonth < atMonth || repeated) {
      return { status: 'blocked' as const, result: '技术示范请求没有绑定本人当前项目，或已向同一人提出过', diff: {} };
    }
  }
  if (content.kind === 'request' && content.projectKnowledgeRequest) {
    const request = content.projectKnowledgeRequest;
    const projectCandidate = projectById(state, request.projectId);
    const project = projectCandidate?.status === 'active'
      && projectIsLedBy(projectCandidate, person.id)
      && pendingProjectKnowledgeOutput(state, projectCandidate) === request.outputMaterialId
      ? projectCandidate
      : undefined;
    const repeated = Boolean(project?.knowledgeRequests?.some((basis) => (
      basis.outputMaterialId === request.outputMaterialId
    )));
    if (!project
      || request.version !== 'project-knowledge-request-v1'
      || request.requesterId !== person.id
      || request.expiresAtMonth < atMonth
      || request.expiresAtMonth > atMonth + 12
      || pendingProjectKnowledgeOutput(state, project) !== request.outputMaterialId
      || personReliablyKnowsOutput(person, request.outputMaterialId)
      || repeated) {
      return { status: 'blocked' as const, result: '项目知识请求没有绑定本人当前的未知产物，已过期或已经提出过', diff: {} };
    }
  }
  if (content.kind === 'request' && content.projectMaterialContribution) {
    const request = content.projectMaterialContribution;
    const projectCandidate = projectById(state, request.projectId);
    const project = projectCandidate?.status === 'active'
      && projectIsLedBy(projectCandidate, person.id)
      && projectSupportsMaterialContribution(projectCandidate)
      && Boolean(projectCandidate.site)
      ? projectCandidate
      : undefined;
    const demand = project?.materialDemands?.find((candidate) => candidate.materialId === request.materialId
      && candidate.outstandingQuantity > 0);
    const repeated = Boolean(project && demand && project.materialContributionRequests?.some((basis) => (
      basis.materialId === request.materialId
        && inspectProjectMaterialContributionRequest(
          state,
          project,
          basis,
          atMonth,
          demand,
        ).status === 'open'
    )));
    if (!project
      || !demand
      || request.version !== 'project-material-contribution-request-v1'
      || request.requesterId !== person.id
      || request.quantity <= 0
      || request.quantity > demand.outstandingQuantity
      || request.site.cellId !== project.site?.cellId
      || request.site.z !== project.site?.z
      || request.expiresAtMonth < atMonth
      || repeated) {
      return { status: 'blocked' as const, result: '材料贡献请求没有绑定当前项目缺口、固定工地，或已经提出过', diff: {} };
    }
  }
  const predictionRange = content.kind === 'prediction'
    ? new Set(cellsInRadius(person.position.cellId, 4))
    : null;
  const techniqueRequestRange = content.kind === 'request'
    && content.techniqueDemonstration
    && action.channel === 'gesture'
    ? new Set(cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25)))
    : null;
  const materialRequestRange = content.kind === 'request'
    && content.projectMaterialContribution
    && action.channel === 'gesture'
    ? new Set(cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25)))
    : null;
  const projectKnowledgeRequestRange = content.kind === 'request'
    && content.projectKnowledgeRequest
    && action.channel === 'gesture'
    ? new Set(cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25)))
    : null;
  const coordinationRange = coordinationFacilityMaterialId ? new Set(cellsInRadius(person.position.cellId, 2)) : null;
  const reached = state.people.filter((candidate) => action.audience.includes(candidate.id)
    && (predictionRange
      ? predictionRange.has(candidate.position.cellId)
      : techniqueRequestRange
        ? techniqueRequestRange.has(candidate.position.cellId) && Math.abs(candidate.position.z - person.position.z) <= 2
      : materialRequestRange
        ? materialRequestRange.has(candidate.position.cellId) && Math.abs(candidate.position.z - person.position.z) <= 2
        : projectKnowledgeRequestRange
          ? projectKnowledgeRequestRange.has(candidate.position.cellId) && Math.abs(candidate.position.z - person.position.z) <= 2
        : coordinationRange
          ? coordinationRange.has(candidate.position.cellId) && Math.abs(candidate.position.z - person.position.z) <= 2
          : positionsWithinVoiceRange(candidate.position, person.position)));
  if (!reached.length) return { status: 'blocked' as const, result: '受众不在当前沟通范围', diff: {} };
  const groundedConversation = validateGroundedConversation(state, person, action, reached, atMonth);
  if (groundedConversation.kind === 'blocked') {
    return { status: 'blocked' as const, result: groundedConversation.reason, diff: { groundedConversationBlocked: true } };
  }
  const explicitTeaching = content.kind === 'claim'
    && Boolean(content.factId)
    && content.id.startsWith('teach:');
  const teachingKnowledge = explicitTeaching
    ? person.knowledge.find((fact) => fact.id === content.factId)
    : undefined;
  if (explicitTeaching
    && (!teachingKnowledge
      || (teachingKnowledge.kind !== 'technique' && teachingKnowledge.kind !== 'codebook')
      || teachingKnowledge.confidence < 55)) {
    return { status: 'blocked' as const, result: '本人尚未可靠掌握这项知识，不能作为教导传授', diff: {} };
  }
  if (explicitTeaching && reached.some((listener) => ageMonths(listener, atMonth) < MIN_TEACHING_AGE_MONTHS)) {
    return { status: 'blocked' as const, result: '受教者尚未达到能够可靠学习技术的年龄', diff: {} };
  }
  const projectKnowledgeResponse = content.kind === 'claim' ? content.projectKnowledgeResponse : undefined;
  let responseBasis: NonNullable<ProjectState['knowledgeRequests']>[number] | undefined;
  if (projectKnowledgeResponse) {
    const project = projectById(state, projectKnowledgeResponse.projectId);
    const basis = project?.knowledgeRequests?.find((candidate) => (
      candidate.requestEventId === projectKnowledgeResponse.requestEventId
    ));
    const requesterReached = reached.some((listener) => listener.id === projectKnowledgeResponse.requesterId);
    if (!explicitTeaching
      || !teachingKnowledge
      || teachingKnowledge.kind !== 'technique'
      || projectKnowledgeResponse.version !== 'project-knowledge-response-v1'
      || !project
      || !basis
      || basis.requesterId !== projectKnowledgeResponse.requesterId
      || basis.outputMaterialId !== projectKnowledgeResponse.outputMaterialId
      || !basis.listenerIds.includes(person.id)
      || inspectProjectKnowledgeRequest(state, project, basis, atMonth) !== 'open'
      || techniqueOutputMaterialId(teachingKnowledge.id) !== basis.outputMaterialId
      || !requesterReached) {
      return { status: 'blocked' as const, result: '项目知识回应没有绑定仍有效的请求、受众或匹配的可靠技术', diff: {} };
    }
    responseBasis = basis;
  }
  if (content.kind === 'request' && content.techniqueDemonstration) {
    const request = content.techniqueDemonstration;
    const project = projectById(state, request.projectId);
    if (project) {
      project.techniqueDemonstrationRequests ??= [];
      project.techniqueDemonstrationRequests.push({
        version: 'project-technique-demonstration-request-v1',
        requestEventId: eventId,
        projectId: project.id,
        requesterId: person.id,
        teacherIds: reached.map((listener) => listener.id),
        desiredFunction: request.desiredFunction,
        expiresAtMonth: request.expiresAtMonth,
        atMonth,
      });
    }
  }
  if (content.kind === 'request' && content.projectKnowledgeRequest) {
    const request = content.projectKnowledgeRequest;
    const project = projectById(state, request.projectId);
    if (project) {
      project.knowledgeRequests ??= [];
      const requestBasis: NonNullable<ProjectState['knowledgeRequests']>[number] = {
        version: 'project-knowledge-request-v1',
        requestEventId: eventId,
        projectId: project.id,
        requesterId: person.id,
        listenerIds: reached.map((listener) => listener.id),
        outputMaterialId: request.outputMaterialId,
        expiresAtMonth: request.expiresAtMonth,
        atMonth,
      };
      project.knowledgeRequests.push(requestBasis);
      registerProjectKnowledgeRequestListeners(state, project, requestBasis);
    }
  }
  if (content.kind === 'request' && content.projectMaterialContribution) {
    const request = content.projectMaterialContribution;
    const project = projectById(state, request.projectId);
    if (project) {
      project.materialContributionRequests ??= [];
      project.materialContributionRequests.push({
        version: 'project-material-contribution-request-v1',
        requestEventId: eventId,
        projectId: project.id,
        requesterId: person.id,
        contributorIds: reached
          .filter((listener) => inventoryQuantity(listener, request.materialId) > 0)
          .map((listener) => listener.id),
        materialId: request.materialId,
        requestedQuantity: request.quantity,
        site: { ...request.site },
        expiresAtMonth: request.expiresAtMonth,
        atMonth,
      });
    }
  }
  if (content.kind === 'prediction') {
    if (state.eraPredictions.some((prediction) => prediction.id === content.id)) {
      return { status: 'completed' as const, result: '这项纪元预言已经留下可验证记录', diff: { predictionId: content.id, duplicate: true } };
    }
    state.eraPredictions.push({
      id: content.id,
      predictorId: person.id,
      audienceIds: reached.map((listener) => listener.id),
      madeAtMonth: atMonth,
      targetEpoch: content.prediction.targetEpoch,
      predictedStartMonth: content.prediction.predictedStartMonth,
      toleranceMonths: content.prediction.toleranceMonths,
      expiresAtMonth: content.prediction.expiresAtMonth,
      status: 'pending',
      sourceEventIds: [eventId],
    });
    const forecastKnowledge = person.knowledge.find((fact) => fact.id === 'technique:era-forecast');
    if (forecastKnowledge) {
      forecastKnowledge.sourceEventIds = [...new Set([...forecastKnowledge.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: 'technique:era-forecast',
      kind: 'technique',
      summary: '综合天象、气温与纪元节律预测下一次纪元变化',
      confidence: clamp(26 + (person.baselineCapacities.cognition + person.baselineCapacities.perception) / 6),
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
  }
  const taughtAudienceIds: string[] = [];
  const teachingConfidenceByAudience: Record<string, number> = {};
  if (content.kind === 'claim' && content.factId) {
    const speakerKnowledge = person.knowledge.find((fact) => fact.id === content.factId);
    if (speakerKnowledge) {
      for (const listener of reached) {
        const reliableTeachingConfidence = explicitTeaching
          ? Math.max(
              coordinationFacilityMaterialId ? 66 : 60,
              maternalFirstTeachingConfidence(state, person, listener),
            )
          : 0;
        const known = listener.knowledge.find((fact) => fact.id === content.factId);
        if (known) {
          const nextConfidence = known.confidence + 6;
          known.confidence = explicitTeaching
            ? Math.max(reliableTeachingConfidence, known.confidence)
            : speakerKnowledge.kind === 'technique' || speakerKnowledge.kind === 'codebook'
              ? Math.min(54, nextConfidence)
              : clamp(nextConfidence);
          known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
        } else listener.knowledge.push({
          id: content.factId,
          kind: speakerKnowledge.kind,
          summary: speakerKnowledge.summary,
          confidence: explicitTeaching
            ? reliableTeachingConfidence
            : speakerKnowledge.kind === 'technique' || speakerKnowledge.kind === 'codebook'
              ? 46
              : 36,
          learnedAtMonth: atMonth,
          sourceEventIds: [eventId],
        });
        const mineralObservation = parsedMineralObservation(content.factId);
        if (mineralObservation && person.knownPlaces.some((place) => place.materialId === mineralObservation.materialId
          && place.position.x === mineralObservation.position.x
          && place.position.y === mineralObservation.position.y
          && place.position.z === mineralObservation.position.z)) {
          rememberMaterialPlace(
            listener,
            mineralObservation.materialId,
            mineralObservation.position,
            atMonth,
            eventId,
          );
        }
        if (explicitTeaching) {
          taughtAudienceIds.push(listener.id);
          teachingConfidenceByAudience[listener.id] = reliableTeachingConfidence;
          if (reliableTeachingConfidence === 72) {
            listener.maternalTeachingSourceEventIds = [...new Set([
              ...(listener.maternalTeachingSourceEventIds ?? []),
              eventId,
            ])];
          }
        }
      }
    }
  }
  if (responseBasis && teachingKnowledge) {
    responseBasis.responseEventId = eventId;
    responseBasis.responderId = person.id;
    responseBasis.techniqueId = teachingKnowledge.id;
  }
  for (const listener of reached) {
    // Grounded dialogue changes relationships through its actual turn; teaching only transfers knowledge.
    const familiarity = groundedConversation.kind === 'valid'
      ? groundedConversation.bondDelta
      : explicitTeaching || action.content.kind === 'reject' || action.content.kind === 'withdraw' || action.content.kind === 'revoke' || action.content.kind === 'revoke-agreement'
        ? 0
        : 1;
    const trust = groundedConversation.kind === 'valid' ? groundedConversation.trustDelta : 0;
    if (familiarity !== 0 || trust !== 0) {
      applyRelationEvidence(listener, person.id, eventId, { bond: familiarity, trust });
      applyRelationEvidence(person, listener.id, eventId, { bond: familiarity, trust });
    }
  }
  const deathNewsPersonIds: string[] = [];
  if (groundedConversation.kind === 'valid'
    && groundedConversation.conversation.topic === 'loss'
    && groundedConversation.conversation.turn === 'opening') {
    const deathSource = groundedConversation.conversation.sourceFactIds
      .map((sourceId) => liveSocialEvidenceForPersonSource(state, person, sourceId))
      .find((source) => source?.environment?.change === 'death');
    const remains = deathSource
      ? (state.world.remains ?? []).find((candidate) => candidate.deathEventId === deathSource.eventId)
      : undefined;
    if (remains) {
      for (const listener of reached) {
        if (learnOfDeath(state, listener, remains, atMonth, 'told', eventId)) deathNewsPersonIds.push(listener.id);
      }
    }
  }
  const assertedKnowledge = content.kind === 'claim' && content.factId ? person.knowledge.find((fact) => fact.id === content.factId) : undefined;
  return {
    status: 'completed' as const,
    result: `${person.name}向${reached.map((item) => item.name).join('、')}表达：${'summary' in action.content ? action.content.summary : action.content.kind}`,
    diff: {
      audience: reached.map((item) => item.id),
      content: action.content,
      ...(assertedKnowledge ? { assertedFactId: assertedKnowledge.id, assertedFactSourceEventIds: assertedKnowledge.sourceEventIds } : {}),
      ...(explicitTeaching && teachingKnowledge ? {
        explicitTeaching: true,
        teachingFactId: teachingKnowledge.id,
        teachingKnowledgeKind: teachingKnowledge.kind,
        teachingTeacherConfidence: teachingKnowledge.confidence,
        taughtAudienceIds,
        teachingReliableConfidence: Math.max(0, ...Object.values(teachingConfidenceByAudience)),
        teachingConfidenceByAudience,
      } : {}),
      ...(responseBasis && teachingKnowledge ? {
        projectKnowledgeResponse: true,
        projectKnowledgeProjectId: responseBasis.projectId,
        projectKnowledgeRequestEventId: responseBasis.requestEventId,
        projectKnowledgeOutputMaterialId: responseBasis.outputMaterialId,
        projectKnowledgeResponderId: person.id,
        projectKnowledgeTechniqueId: teachingKnowledge.id,
      } : {}),
      ...(coordinationFacilityMaterialId ? {
        facilityMaterialId: coordinationFacilityMaterialId,
        coordinationAudienceCapacity: reached.length,
      } : {}),
      ...(groundedConversation.kind === 'valid' ? {
        groundedConversationBasisKey: groundedConversation.conversation.basisKey,
        groundedConversationTopic: groundedConversation.conversation.topic,
        groundedConversationTurn: groundedConversation.conversation.turn,
        groundedConversationSourceFactIds: groundedConversation.conversation.sourceFactIds,
        groundedConversationReferenceEventId: groundedConversation.conversation.referenceEventId,
        groundedConversationStance: groundedConversation.conversation.stance,
        relationTrustDelta: groundedConversation.trustDelta,
        relationBondDelta: groundedConversation.bondDelta,
      } : {}),
      ...(deathNewsPersonIds.length ? {
        deathNewsPersonIds,
        deathNewsSourceEventIds: groundedConversation.kind === 'valid'
          ? groundedConversation.conversation.sourceFactIds
          : [],
      } : {}),
    },
  };
}
