import type { PersonId, PersonState } from '../../domain/person';
import {
  MAX_COORDINATION_PRACTICES,
  MAX_PRACTICE_EPISODES,
  MAX_SOCIAL_BELIEF_RECEIPTS,
  MAX_SOCIAL_BELIEF_SOURCES,
  MAX_SOCIAL_COOPERATION_BELIEFS,
  SOCIAL_LEARNING_VERSION,
  type CooperationContext,
  type CoordinationPracticeBasis,
  type SocialBetaDimension,
  type SocialCooperationBelief,
  type SocialEvidenceResult,
  type SocialLearningReceipt,
  type SocialLearningReceiptKind,
  type SocialLearningState,
} from '../../domain/social-learning';

const MAX_SOCIAL_IDENTIFIER_LENGTH = 4_096;

const COOPERATION_CONTEXTS = new Set<CooperationContext>([
  'assist-water',
  'assist-food',
  'assist-shelter',
  'assist-company',
  'exchange',
  'shared-living',
  'collective-formation',
  'collective-membership',
  'collective-permission',
  'governance-decision-rule',
  'governance-mandate',
  'joint-project-production',
  'joint-project-construction',
  'joint-project-inquiry',
  'mandate-resource-coordination',
]);

const RECEIPT_KINDS = new Set<SocialLearningReceiptKind>([
  'proposal-response',
  'proposal-no-response',
  'agreement-fulfillment',
  'agreement-breach',
  'joint-project-progress',
  'mandate-coordination-closure',
]);

const EVIDENCE_RESULTS = new Set<SocialEvidenceResult>(['positive', 'negative']);

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} 字段集合无效`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_SOCIAL_IDENTIFIER_LENGTH) {
    throw new Error(`${label} 必须是有界非空 ID`);
  }
  return value;
}

function month(value: unknown, currentMonth: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > currentMonth) {
    throw new Error(`${label} 必须是当前月份内的非负安全整数`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负安全整数`);
  }
  return Number(value);
}

function positiveFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} 必须是有限正数`);
  }
  return value;
}

function uniqueIdentifiers(
  value: unknown,
  maximum: number,
  label: string,
  options: { nonEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)
    || value.length > maximum
    || (options.nonEmpty && value.length === 0)) {
    throw new Error(`${label} 必须是上限 ${maximum} 的${options.nonEmpty ? '非空' : ''} ID 数组`);
  }
  const result = value.map((candidate, index) => identifier(candidate, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} 不得含重复 ID`);
  return result;
}

function cooperationContext(value: unknown, label: string): CooperationContext {
  if (typeof value !== 'string' || !COOPERATION_CONTEXTS.has(value as CooperationContext)) {
    throw new Error(`${label} 无效`);
  }
  return value as CooperationContext;
}

function betaDimension(
  value: unknown,
  currentMonth: number,
  label: string,
): SocialBetaDimension {
  record(value, label);
  exactKeys(value, [
    'alpha',
    'beta',
    'positiveObservations',
    'negativeObservations',
    'lastUpdatedAtMonth',
  ], label);
  return {
    alpha: positiveFinite(value.alpha, `${label}.alpha`),
    beta: positiveFinite(value.beta, `${label}.beta`),
    positiveObservations: nonNegativeInteger(
      value.positiveObservations,
      `${label}.positiveObservations`,
    ),
    negativeObservations: nonNegativeInteger(
      value.negativeObservations,
      `${label}.negativeObservations`,
    ),
    lastUpdatedAtMonth: month(value.lastUpdatedAtMonth, currentMonth, `${label}.lastUpdatedAtMonth`),
  };
}

function evidenceResult(value: unknown, label: string): SocialEvidenceResult | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !EVIDENCE_RESULTS.has(value as SocialEvidenceResult)) {
    throw new Error(`${label} 无效`);
  }
  return value as SocialEvidenceResult;
}

function receipt(
  value: unknown,
  currentMonth: number,
  label: string,
): SocialLearningReceipt {
  record(value, label);
  const optionalKeys = ['response', 'willingness', 'reliability']
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  exactKeys(value, [
    'version',
    'id',
    'kind',
    'atMonth',
    'sourceEventIds',
    ...optionalKeys,
  ], label);
  if (value.version !== 'social-learning-receipt-v1') throw new Error(`${label}.version 无效`);
  if (typeof value.kind !== 'string'
    || !RECEIPT_KINDS.has(value.kind as SocialLearningReceiptKind)) {
    throw new Error(`${label}.kind 无效`);
  }
  const response = evidenceResult(value.response, `${label}.response`);
  const willingness = evidenceResult(value.willingness, `${label}.willingness`);
  const reliability = evidenceResult(value.reliability, `${label}.reliability`);
  if (!response && !willingness && !reliability) throw new Error(`${label} 缺少证据维度`);
  return {
    version: 'social-learning-receipt-v1',
    id: identifier(value.id, `${label}.id`),
    kind: value.kind as SocialLearningReceiptKind,
    atMonth: month(value.atMonth, currentMonth, `${label}.atMonth`),
    ...(response ? { response } : {}),
    ...(willingness ? { willingness } : {}),
    ...(reliability ? { reliability } : {}),
    sourceEventIds: uniqueIdentifiers(
      value.sourceEventIds,
      MAX_SOCIAL_BELIEF_SOURCES,
      `${label}.sourceEventIds`,
      { nonEmpty: true },
    ),
  };
}

function beliefBasisKey(targetPersonId: PersonId, context: CooperationContext): string {
  return `${SOCIAL_LEARNING_VERSION}|target=${encodeURIComponent(targetPersonId)}|context=${context}`;
}

function socialBelief(
  value: unknown,
  currentMonth: number,
  personIds: ReadonlySet<PersonId>,
  observerId: PersonId,
  label: string,
): SocialCooperationBelief {
  record(value, label);
  exactKeys(value, [
    'version',
    'basisKey',
    'targetPersonId',
    'context',
    'response',
    'willingness',
    'reliability',
    'receipts',
    'sourceEventIds',
    'lastUpdatedAtMonth',
  ], label);
  if (value.version !== 'social-cooperation-belief-v1') throw new Error(`${label}.version 无效`);
  const targetPersonId = identifier(value.targetPersonId, `${label}.targetPersonId`);
  if (targetPersonId === observerId || !personIds.has(targetPersonId)) {
    throw new Error(`${label}.targetPersonId 不属于另一位已知人物`);
  }
  const context = cooperationContext(value.context, `${label}.context`);
  const expectedBasisKey = beliefBasisKey(targetPersonId, context);
  if (value.basisKey !== expectedBasisKey) throw new Error(`${label}.basisKey 与人物/情境不一致`);
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_SOCIAL_BELIEF_RECEIPTS) {
    throw new Error(`${label}.receipts 超出上限 ${MAX_SOCIAL_BELIEF_RECEIPTS}`);
  }
  const receipts = value.receipts.map((candidate, index) => receipt(
    candidate,
    currentMonth,
    `${label}.receipts[${index}]`,
  ));
  if (new Set(receipts.map((candidate) => candidate.id)).size !== receipts.length) {
    throw new Error(`${label}.receipts 含重复 receipt ID`);
  }
  return {
    version: 'social-cooperation-belief-v1',
    basisKey: expectedBasisKey,
    targetPersonId,
    context,
    response: betaDimension(value.response, currentMonth, `${label}.response`),
    willingness: betaDimension(value.willingness, currentMonth, `${label}.willingness`),
    reliability: betaDimension(value.reliability, currentMonth, `${label}.reliability`),
    receipts,
    sourceEventIds: uniqueIdentifiers(
      value.sourceEventIds,
      MAX_SOCIAL_BELIEF_SOURCES,
      `${label}.sourceEventIds`,
      { nonEmpty: true },
    ),
    lastUpdatedAtMonth: month(value.lastUpdatedAtMonth, currentMonth, `${label}.lastUpdatedAtMonth`),
  };
}

function practiceBasisKey(
  observerId: PersonId,
  targetPersonId: PersonId,
  context: CooperationContext,
): string {
  return `coordination-practice-v1|observer=${encodeURIComponent(observerId)}`
    + `|target=${encodeURIComponent(targetPersonId)}|context=${context}`;
}

function coordinationPractice(
  value: unknown,
  currentMonth: number,
  personIds: ReadonlySet<PersonId>,
  observerId: PersonId,
  label: string,
): CoordinationPracticeBasis {
  record(value, label);
  exactKeys(value, [
    'version',
    'basisKey',
    'observerId',
    'targetPersonId',
    'participantIds',
    'context',
    'formedAtMonth',
    'lastUpdatedAtMonth',
    'support',
    'successes',
    'recentCounterEvidence',
    'sourceFactIds',
  ], label);
  if (value.version !== 'coordination-practice-basis-v1') throw new Error(`${label}.version 无效`);
  if (value.observerId !== observerId) throw new Error(`${label}.observerId 与持有人不一致`);
  const targetPersonId = identifier(value.targetPersonId, `${label}.targetPersonId`);
  if (targetPersonId === observerId || !personIds.has(targetPersonId)) {
    throw new Error(`${label}.targetPersonId 不属于另一位已知人物`);
  }
  const context = cooperationContext(value.context, `${label}.context`);
  const expectedBasisKey = practiceBasisKey(observerId, targetPersonId, context);
  if (value.basisKey !== expectedBasisKey) throw new Error(`${label}.basisKey 与人物/情境不一致`);
  if (!Array.isArray(value.participantIds)
    || value.participantIds.length !== 2
    || value.participantIds[0] !== observerId
    || value.participantIds[1] !== targetPersonId) {
    throw new Error(`${label}.participantIds 与有向实践不一致`);
  }
  if (!Array.isArray(value.successes)
    || value.successes.length < 2
    || value.successes.length > MAX_PRACTICE_EPISODES) {
    throw new Error(`${label}.successes 必须含 2..${MAX_PRACTICE_EPISODES} 个情境成功`);
  }
  const successes = value.successes.map((candidate, index) => {
    const itemLabel = `${label}.successes[${index}]`;
    record(candidate, itemLabel);
    exactKeys(candidate, ['atMonth', 'receiptIds', 'sourceEventIds'], itemLabel);
    return {
      atMonth: month(candidate.atMonth, currentMonth, `${itemLabel}.atMonth`),
      receiptIds: uniqueIdentifiers(
        candidate.receiptIds,
        MAX_SOCIAL_BELIEF_RECEIPTS,
        `${itemLabel}.receiptIds`,
        { nonEmpty: true },
      ),
      sourceEventIds: uniqueIdentifiers(
        candidate.sourceEventIds,
        MAX_SOCIAL_BELIEF_SOURCES,
        `${itemLabel}.sourceEventIds`,
        { nonEmpty: true },
      ),
    };
  });
  if (new Set(successes.map((candidate) => candidate.atMonth)).size !== successes.length) {
    throw new Error(`${label}.successes 必须来自不同月份`);
  }
  if (!Array.isArray(value.recentCounterEvidence)
    || value.recentCounterEvidence.length > MAX_PRACTICE_EPISODES) {
    throw new Error(`${label}.recentCounterEvidence 超出上限 ${MAX_PRACTICE_EPISODES}`);
  }
  const recentCounterEvidence = value.recentCounterEvidence.map((candidate, index) => {
    const itemLabel = `${label}.recentCounterEvidence[${index}]`;
    record(candidate, itemLabel);
    exactKeys(candidate, ['atMonth', 'receiptId', 'sourceEventIds'], itemLabel);
    return {
      atMonth: month(candidate.atMonth, currentMonth, `${itemLabel}.atMonth`),
      receiptId: identifier(candidate.receiptId, `${itemLabel}.receiptId`),
      sourceEventIds: uniqueIdentifiers(
        candidate.sourceEventIds,
        MAX_SOCIAL_BELIEF_SOURCES,
        `${itemLabel}.sourceEventIds`,
        { nonEmpty: true },
      ),
    };
  });
  if (new Set(recentCounterEvidence.map((candidate) => candidate.receiptId)).size
    !== recentCounterEvidence.length) {
    throw new Error(`${label}.recentCounterEvidence 含重复 receipt ID`);
  }
  const formedAtMonth = month(value.formedAtMonth, currentMonth, `${label}.formedAtMonth`);
  const lastUpdatedAtMonth = month(
    value.lastUpdatedAtMonth,
    currentMonth,
    `${label}.lastUpdatedAtMonth`,
  );
  if (formedAtMonth > lastUpdatedAtMonth) throw new Error(`${label} 的 formedAtMonth 晚于更新月份`);
  if (value.support !== 'supported' && value.support !== 'contested') {
    throw new Error(`${label}.support 无效`);
  }
  return {
    version: 'coordination-practice-basis-v1',
    basisKey: expectedBasisKey,
    observerId,
    targetPersonId,
    participantIds: [observerId, targetPersonId],
    context,
    formedAtMonth,
    lastUpdatedAtMonth,
    support: value.support,
    successes,
    recentCounterEvidence,
    sourceFactIds: uniqueIdentifiers(
      value.sourceFactIds,
      MAX_SOCIAL_BELIEF_SOURCES,
      `${label}.sourceFactIds`,
      { nonEmpty: true },
    ),
  };
}

/**
 * Validate and copy the optional person-local social posterior at a state
 * ownership boundary. Missing legacy data remains an empty prior; history is
 * never replayed to invent reputation or coordination practices.
 */
export function cloneValidatedSocialLearningState(
  person: PersonState,
  people: readonly PersonState[],
  currentMonth: number,
): SocialLearningState | undefined {
  const value: unknown = person.cognition?.socialLearning;
  if (value === undefined) return undefined;
  record(value, `person ${person.id} cognition.socialLearning`);
  const label = `person ${person.id} cognition.socialLearning`;
  exactKeys(value, ['version', 'startedAtMonth', 'beliefs', 'coordinationPractices'], label);
  if (value.version !== SOCIAL_LEARNING_VERSION) throw new Error(`${label}.version 无效`);
  if (!Number.isSafeInteger(currentMonth) || currentMonth < 0) {
    throw new Error('social learning hydration 当前月份无效');
  }
  const personIds = new Set(people.map((candidate) => candidate.id));
  if (!Array.isArray(value.beliefs) || value.beliefs.length > MAX_SOCIAL_COOPERATION_BELIEFS) {
    throw new Error(`${label}.beliefs 超出上限 ${MAX_SOCIAL_COOPERATION_BELIEFS}`);
  }
  const beliefs = value.beliefs.map((candidate, index) => socialBelief(
    candidate,
    currentMonth,
    personIds,
    person.id,
    `${label}.beliefs[${index}]`,
  ));
  if (new Set(beliefs.map((belief) => belief.basisKey)).size !== beliefs.length) {
    throw new Error(`${label}.beliefs 含重复人物/情境`);
  }
  if (!Array.isArray(value.coordinationPractices)
    || value.coordinationPractices.length > MAX_COORDINATION_PRACTICES) {
    throw new Error(`${label}.coordinationPractices 超出上限 ${MAX_COORDINATION_PRACTICES}`);
  }
  const coordinationPractices = value.coordinationPractices.map((candidate, index) => (
    coordinationPractice(
      candidate,
      currentMonth,
      personIds,
      person.id,
      `${label}.coordinationPractices[${index}]`,
    )
  ));
  if (new Set(coordinationPractices.map((practice) => practice.basisKey)).size
    !== coordinationPractices.length) {
    throw new Error(`${label}.coordinationPractices 含重复人物/情境`);
  }
  return {
    version: SOCIAL_LEARNING_VERSION,
    startedAtMonth: month(value.startedAtMonth, currentMonth, `${label}.startedAtMonth`),
    beliefs,
    coordinationPractices,
  };
}
