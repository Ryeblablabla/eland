import type { PrimitiveAction } from '../action';
import { materialHas } from '../material';
import type { SimulationState } from '../model';
import { isAlive, type PersonState } from '../person';
import { broadcastLanguage, type LanguageBroadcast } from '../language-perception';
import { addInventory } from './inventory';
import { personById, projectById } from '../state-index';

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

/**
 * Talk is only a physical vocal act. It does not create knowledge, agreement,
 * relationship, consent, addressee, or an authoritative meaning in a hearer.
 */
export function executeTalk(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'talk' }>,
  atMonth: number,
  eventId: string,
  sourceBroadcast?: LanguageBroadcast,
) {
  const languageBroadcast = sourceBroadcast ?? broadcastLanguage({
    seed: state.seed,
    sourceFactId: eventId,
    speakerId: person.id,
    intensity: action.delivery === 'whisper' ? 0.35 : action.delivery === 'call' ? 1.8 : 1,
    text: action.speakerMeaning.summary ?? action.speakerMeaning.kind,
    world: state.world.grid,
    speakerPosition: person.position,
    listeners: state.people.filter(isAlive).map((listener) => ({
      id: listener.id,
      position: listener.position,
    })),
  });
  const understoodPeople = languageBroadcast.decodedByPersonIds.flatMap((personId) => {
    const listener = personById(state, personId);
    return listener && isAlive(listener) ? [listener] : [];
  });
  const meaning = action.speakerMeaning;
  const interpretationDiff: Record<string, unknown> = {};

  if (meaning.kind === 'claim' && meaning.factId) {
    const source = person.knowledge.find((knowledge) => knowledge.id === meaning.factId);
    if (source) {
      for (const listener of understoodPeople) {
        const existing = listener.knowledge.find((knowledge) => knowledge.id === source.id);
        const learnedConfidence = Math.max(55, Math.min(90, Math.round(source.confidence * 0.82)));
        if (existing) {
          existing.confidence = Math.max(existing.confidence, learnedConfidence);
          existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...source.sourceEventIds, eventId])].slice(-24);
        } else listener.knowledge.push({
          ...structuredClone(source),
          confidence: learnedConfidence,
          learnedAtMonth: atMonth,
          sourceEventIds: [...new Set([...source.sourceEventIds, eventId])].slice(-24),
        });
      }
      interpretationDiff.assertedFactSourceEventIds = [...source.sourceEventIds];
      interpretationDiff.interpretedFactId = source.id;
      interpretationDiff.interpretedByPersonIds = understoodPeople.map((listener) => listener.id);
    }
  }

  if (meaning.kind === 'prediction' && !state.eraPredictions.some((prediction) => prediction.id === meaning.id)) {
    state.eraPredictions.push({
      id: meaning.id,
      predictorId: person.id,
      perceivedByPersonIds: understoodPeople.map((listener) => listener.id),
      madeAtMonth: atMonth,
      targetEpoch: meaning.prediction.targetEpoch,
      predictedStartMonth: meaning.prediction.predictedStartMonth,
      toleranceMonths: meaning.prediction.toleranceMonths,
      expiresAtMonth: meaning.prediction.expiresAtMonth,
      status: 'pending',
      sourceEventIds: [eventId],
    });
    interpretationDiff.predictionId = meaning.id;
  }

  if (meaning.kind === 'request') {
    const understoodIds = understoodPeople.map((listener) => listener.id);
    if (meaning.techniqueDemonstration) {
      const request = meaning.techniqueDemonstration;
      const project = projectById(state, request.projectId);
      if (project?.status === 'active' && request.requesterId === person.id && understoodIds.length) {
        project.techniqueDemonstrationRequests ??= [];
        project.techniqueDemonstrationRequests.push({
          version: 'project-technique-demonstration-request-v1',
          requestEventId: eventId,
          projectId: project.id,
          requesterId: person.id,
          teacherIds: understoodIds,
          desiredFunction: request.desiredFunction,
          expiresAtMonth: request.expiresAtMonth,
          atMonth,
        });
        interpretationDiff.techniqueDemonstrationRequest = true;
      }
    }
    if (meaning.projectMaterialContribution) {
      const request = meaning.projectMaterialContribution;
      const project = projectById(state, request.projectId);
      if (project?.status === 'active' && request.requesterId === person.id && understoodIds.length) {
        project.materialContributionRequests ??= [];
        project.materialContributionRequests.push({
          version: 'project-material-contribution-request-v1',
          requestEventId: eventId,
          projectId: project.id,
          requesterId: person.id,
          contributorIds: understoodIds,
          materialId: request.materialId,
          requestedQuantity: request.quantity,
          site: structuredClone(request.site),
          expiresAtMonth: request.expiresAtMonth,
          atMonth,
        });
        interpretationDiff.projectMaterialContributionRequest = true;
      }
    }
    if (meaning.projectKnowledgeRequest) {
      const request = meaning.projectKnowledgeRequest;
      const project = projectById(state, request.projectId);
      if (project?.status === 'active' && request.requesterId === person.id && understoodIds.length) {
        project.knowledgeRequests ??= [];
        project.knowledgeRequests.push({
          version: 'project-knowledge-request-v1',
          requestEventId: eventId,
          projectId: project.id,
          requesterId: person.id,
          listenerIds: understoodIds,
          outputMaterialId: request.outputMaterialId,
          expiresAtMonth: request.expiresAtMonth,
          atMonth,
        });
        interpretationDiff.projectKnowledgeRequest = true;
      }
    }
  }

  if (meaning.kind === 'claim' && meaning.projectKnowledgeResponse) {
    const response = meaning.projectKnowledgeResponse;
    const project = projectById(state, response.projectId);
    const request = project?.knowledgeRequests?.find((candidate) => candidate.requestEventId === response.requestEventId);
    const requesterUnderstood = languageBroadcast.decodedByPersonIds.includes(response.requesterId);
    if (project && request && requesterUnderstood && meaning.factId) {
      request.responseEventId = eventId;
      request.responderId = person.id;
      request.techniqueId = meaning.factId;
      interpretationDiff.projectKnowledgeResponse = true;
      interpretationDiff.projectKnowledgeProjectId = project.id;
      interpretationDiff.projectKnowledgeRequestEventId = request.requestEventId;
      interpretationDiff.projectKnowledgeOutputMaterialId = request.outputMaterialId;
      interpretationDiff.projectKnowledgeTechniqueId = meaning.factId;
    }
  }

  if (meaning.kind === 'claim' && meaning.conversation && understoodPeople.length) {
    interpretationDiff.groundedConversationBasisKey = meaning.conversation.basisKey;
  }
  return {
    status: 'completed' as const,
    result: `${person.name}把一句话说出了声`,
    diff: {
      languageBroadcast,
      ...(languageBroadcast.sourceEventId !== eventId
        ? { languageSourceEventId: languageBroadcast.sourceEventId }
        : {}),
      listenerInterpretations: understoodPeople.map((listener) => ({
        version: 'listener-language-interpretation-v1' as const,
        listenerId: listener.id,
        sourceRepresentationId: meaning.id,
        kind: meaning.kind,
      })),
      ...interpretationDiff,
    },
  };
}

/** Writing is a material action. Reading and interpretation happen later. */
export function executeInscribe(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'inscribe' }>,
  atMonth: number,
  eventId: string,
) {
  const stack = person.inventory.find((candidate) => (
    candidate.id === action.carrierStackId && candidate.quantity > 0
  ));
  if (!stack || !materialHas(stack.materialId, 'recordable') || stack.recordPayloadId) {
    return { status: 'blocked' as const, result: '没有可写且尚未承载内容的记录材料', diff: {} };
  }
  const knowledgeId = action.inscriptionMeaning.factId;
  const knowledge = knowledgeId
    ? person.knowledge.find((fact) => fact.id === knowledgeId)
    : undefined;
  if (!knowledge) {
    return { status: 'blocked' as const, result: '本人并不知道要刻写的内容', diff: {} };
  }
  if (knowledge.kind === 'codebook') {
    return { status: 'blocked' as const, result: '编码约定不能作为自己的记录内容再次刻写', diff: {} };
  }
  const priorVersion = state.records
    .filter((record) => record.knowledgeId === knowledge.id && record.authorId === person.id)
    .reduce((maximum, record) => Math.max(maximum, record.version), 0);
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
  } else {
    person.knowledge.push({
      id: codebookId,
      kind: 'codebook',
      summary: `这组刻痕表示“${knowledge.summary}”`,
      confidence: 100,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId, payload.id],
    });
  }
  let carrier = stack;
  if (stack.quantity > 1) {
    stack.quantity -= 1;
    carrier = addInventory(
      person,
      stack.materialId,
      1,
      [eventId],
      `stack-${person.id}-${stack.materialId}-${atMonth}-record-${state.records.length}`,
      payload.id,
    );
  } else {
    stack.recordPayloadId = payload.id;
    stack.sourceEventIds = [...new Set([...stack.sourceEventIds, eventId])].slice(-24);
  }
  return {
    status: 'completed' as const,
    result: `${person.name}把一段刻痕留在木制记录板上`,
    diff: {
      recordPayloadId: payload.id,
      carrierStackId: carrier.id,
      knowledgeId: knowledge.id,
      version: payload.version,
    },
  };
}
