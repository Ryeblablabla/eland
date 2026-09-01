import type { PrimitiveAction } from '../action';
import { materialHas } from '../material';
import type { SimulationState } from '../model';
import { isAlive, type PersonState } from '../person';
import { broadcastLanguage } from '../language-perception';
import { addInventory } from './inventory';

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
  _atMonth: number,
  eventId: string,
) {
  const languageBroadcast = broadcastLanguage({
    seed: state.seed,
    sourceFactId: eventId,
    speakerId: person.id,
    mode: 'talk',
    text: action.speakerMeaning.kind === 'claim'
      ? action.speakerMeaning.summary
      : action.speakerMeaning.kind,
    speakerPosition: person.position,
    listeners: state.people.filter(isAlive).map((listener) => ({
      id: listener.id,
      position: listener.position,
    })),
  });
  return {
    status: 'completed' as const,
    result: `${person.name}把一句话说出了声`,
    diff: {
      languageBroadcast,
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
