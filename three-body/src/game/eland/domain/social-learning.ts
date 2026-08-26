import type { SocialProposal } from './action';
import type { Agreement } from './agreement';
import { ensureCognitionState } from './cognition';
import { worldEventById } from './event-index';
import type { SimulationState, WorldEvent } from './model';
import { isAlive, type PersonId, type PersonState } from './person';
import type { ProjectKind, ProjectState } from './project';
import { personById } from './state-index';

export const SOCIAL_LEARNING_VERSION = 'social-learning-v1' as const;

export const MAX_SOCIAL_COOPERATION_BELIEFS = 24;
export const MAX_SOCIAL_BELIEF_RECEIPTS = 8;
export const MAX_SOCIAL_BELIEF_SOURCES = 24;
export const MAX_COORDINATION_PRACTICES = 8;
export const MAX_PRACTICE_EPISODES = 8;
const SOCIAL_PRIOR = 1;
/** Six years without confirming evidence halves experience above the weak prior. */
const SOCIAL_EVIDENCE_HALF_LIFE_MONTHS = 72;

export type CooperationContext =
  | 'assist-water'
  | 'assist-food'
  | 'assist-shelter'
  | 'assist-company'
  | 'exchange'
  | 'shared-living'
  | 'collective-formation'
  | 'collective-membership'
  | 'collective-permission'
  | 'governance-decision-rule'
  | 'governance-mandate'
  | 'joint-project-production'
  | 'joint-project-construction'
  | 'joint-project-inquiry'
  | 'mandate-resource-coordination';

export type SocialLearningDimension = 'response' | 'willingness' | 'reliability';
export type SocialEvidenceResult = 'positive' | 'negative';
export type SocialLearningReceiptKind =
  | 'proposal-response'
  | 'proposal-no-response'
  | 'agreement-fulfillment'
  | 'agreement-breach'
  | 'joint-project-progress'
  | 'mandate-coordination-closure';

export interface SocialBetaDimension {
  /** Weak Beta(1,1) prior plus time-discounted direct evidence. */
  alpha: number;
  beta: number;
  positiveObservations: number;
  negativeObservations: number;
  lastUpdatedAtMonth: number;
}

export interface SocialLearningReceipt {
  version: 'social-learning-receipt-v1';
  id: string;
  kind: SocialLearningReceiptKind;
  atMonth: number;
  response?: SocialEvidenceResult;
  willingness?: SocialEvidenceResult;
  reliability?: SocialEvidenceResult;
  sourceEventIds: string[];
}

export interface SocialCooperationBelief {
  version: 'social-cooperation-belief-v1';
  basisKey: string;
  targetPersonId: PersonId;
  context: CooperationContext;
  response: SocialBetaDimension;
  willingness: SocialBetaDimension;
  reliability: SocialBetaDimension;
  receipts: SocialLearningReceipt[];
  sourceEventIds: string[];
  lastUpdatedAtMonth: number;
}

export interface CoordinationPracticeSuccessBasis {
  atMonth: number;
  receiptIds: string[];
  sourceEventIds: string[];
}

export interface CoordinationPracticeCounterEvidence {
  atMonth: number;
  receiptId: string;
  sourceEventIds: string[];
}

/**
 * Person-local evidence that one pair repeatedly coordinated in the same typed
 * context. It can support a later proposal, but grants no rule, role or power.
 */
export interface CoordinationPracticeBasis {
  version: 'coordination-practice-basis-v1';
  basisKey: string;
  observerId: PersonId;
  targetPersonId: PersonId;
  participantIds: [PersonId, PersonId];
  context: CooperationContext;
  formedAtMonth: number;
  lastUpdatedAtMonth: number;
  support: 'supported' | 'contested';
  successes: CoordinationPracticeSuccessBasis[];
  recentCounterEvidence: CoordinationPracticeCounterEvidence[];
  sourceFactIds: string[];
}

export interface SocialLearningState {
  version: 'social-learning-v1';
  /** The first new social consequence observed after this schema existed. */
  startedAtMonth: number;
  beliefs: SocialCooperationBelief[];
  coordinationPractices: CoordinationPracticeBasis[];
}

export interface RecordSocialLearningEvidenceInput {
  receiptId: string;
  kind: SocialLearningReceiptKind;
  atMonth: number;
  sourceEventIds: string[];
  response?: SocialEvidenceResult;
  willingness?: SocialEvidenceResult;
  reliability?: SocialEvidenceResult;
}

function uniqueSources(sourceEventIds: readonly string[]): string[] {
  return [...new Set(sourceEventIds.filter((eventId) => typeof eventId === 'string' && eventId.length > 0))];
}

function beliefKey(targetPersonId: PersonId, context: CooperationContext): string {
  return `${SOCIAL_LEARNING_VERSION}|target=${encodeURIComponent(targetPersonId)}|context=${context}`;
}

function practiceKey(observerId: PersonId, targetPersonId: PersonId, context: CooperationContext): string {
  return `coordination-practice-v1|observer=${encodeURIComponent(observerId)}|target=${encodeURIComponent(targetPersonId)}|context=${context}`;
}

function freshDimension(atMonth: number): SocialBetaDimension {
  return {
    alpha: SOCIAL_PRIOR,
    beta: SOCIAL_PRIOR,
    positiveObservations: 0,
    negativeObservations: 0,
    lastUpdatedAtMonth: atMonth,
  };
}

function freshBelief(
  targetPersonId: PersonId,
  context: CooperationContext,
  atMonth: number,
): SocialCooperationBelief {
  return {
    version: 'social-cooperation-belief-v1',
    basisKey: beliefKey(targetPersonId, context),
    targetPersonId,
    context,
    response: freshDimension(atMonth),
    willingness: freshDimension(atMonth),
    reliability: freshDimension(atMonth),
    receipts: [],
    sourceEventIds: [],
    lastUpdatedAtMonth: atMonth,
  };
}

function createSocialLearningState(atMonth: number): SocialLearningState {
  return {
    version: SOCIAL_LEARNING_VERSION,
    startedAtMonth: atMonth,
    beliefs: [],
    coordinationPractices: [],
  };
}

function ensureSocialLearningState(person: PersonState, atMonth: number): SocialLearningState {
  const cognition = ensureCognitionState(person);
  if (cognition.socialLearning?.version !== SOCIAL_LEARNING_VERSION) {
    cognition.socialLearning = createSocialLearningState(atMonth);
  }
  cognition.socialLearning.beliefs ??= [];
  cognition.socialLearning.coordinationPractices ??= [];
  return cognition.socialLearning;
}

/** Missing legacy state is an empty prior; this read never mutates or replays history. */
export function socialLearningStateOf(person: PersonState): SocialLearningState | undefined {
  const state = person.cognition?.socialLearning;
  return state?.version === SOCIAL_LEARNING_VERSION ? state : undefined;
}

export function socialCooperationBeliefFor(
  person: PersonState,
  targetPersonId: PersonId,
  context: CooperationContext,
): SocialCooperationBelief | undefined {
  return socialLearningStateOf(person)?.beliefs.find((belief) => (
    belief.targetPersonId === targetPersonId && belief.context === context
  ));
}

export function coordinationPracticeBasisFor(
  person: PersonState,
  targetPersonId: PersonId,
  context: CooperationContext,
): CoordinationPracticeBasis | undefined {
  return socialLearningStateOf(person)?.coordinationPractices.find((practice) => (
    practice.targetPersonId === targetPersonId && practice.context === context
  ));
}

function decayFactor(elapsedMonths: number): number {
  return 2 ** (-Math.max(0, elapsedMonths) / SOCIAL_EVIDENCE_HALF_LIFE_MONTHS);
}

function decayedDimension(dimension: SocialBetaDimension, atMonth: number): { alpha: number; beta: number } {
  const retention = decayFactor(atMonth - dimension.lastUpdatedAtMonth);
  return {
    alpha: SOCIAL_PRIOR + (dimension.alpha - SOCIAL_PRIOR) * retention,
    beta: SOCIAL_PRIOR + (dimension.beta - SOCIAL_PRIOR) * retention,
  };
}

export function socialDimensionExpectation(
  belief: SocialCooperationBelief | undefined,
  dimension: SocialLearningDimension,
  atMonth: number,
): number {
  if (!belief) return 0.5;
  const decayed = decayedDimension(belief[dimension], atMonth);
  return decayed.alpha / Math.max(0.0001, decayed.alpha + decayed.beta);
}

function applyDimensionEvidence(
  dimension: SocialBetaDimension,
  result: SocialEvidenceResult,
  atMonth: number,
): void {
  const decayed = decayedDimension(dimension, atMonth);
  dimension.alpha = decayed.alpha + (result === 'positive' ? 1 : 0);
  dimension.beta = decayed.beta + (result === 'negative' ? 1 : 0);
  if (result === 'positive') dimension.positiveObservations += 1;
  else dimension.negativeObservations += 1;
  dimension.lastUpdatedAtMonth = Math.max(dimension.lastUpdatedAtMonth, atMonth);
}

function mergePracticeSuccess(
  successes: CoordinationPracticeSuccessBasis[],
  receipt: SocialLearningReceipt,
): CoordinationPracticeSuccessBasis[] {
  const existing = successes.find((success) => success.atMonth === receipt.atMonth);
  if (existing) {
    existing.receiptIds = [...new Set([...existing.receiptIds, receipt.id])];
    existing.sourceEventIds = uniqueSources([...existing.sourceEventIds, ...receipt.sourceEventIds]);
  } else {
    successes.push({
      atMonth: receipt.atMonth,
      receiptIds: [receipt.id],
      sourceEventIds: [...receipt.sourceEventIds],
    });
  }
  return successes
    .sort((left, right) => left.atMonth - right.atMonth || left.receiptIds[0].localeCompare(right.receiptIds[0]))
    .slice(-MAX_PRACTICE_EPISODES);
}

function refreshPracticeSupport(practice: CoordinationPracticeBasis): void {
  const latestSuccess = practice.successes.at(-1)?.atMonth ?? Number.NEGATIVE_INFINITY;
  const latestCounter = practice.recentCounterEvidence.at(-1)?.atMonth ?? Number.NEGATIVE_INFINITY;
  practice.support = latestCounter >= latestSuccess ? 'contested' : 'supported';
  practice.sourceFactIds = uniqueSources([
    ...practice.successes.flatMap((success) => success.sourceEventIds),
    ...practice.recentCounterEvidence.flatMap((counter) => counter.sourceEventIds),
  ]).slice(-MAX_SOCIAL_BELIEF_SOURCES);
}

function updateCoordinationPractice(
  person: PersonState,
  state: SocialLearningState,
  belief: SocialCooperationBelief,
  receipt: SocialLearningReceipt,
): void {
  if (!receipt.reliability) return;
  const key = practiceKey(person.id, belief.targetPersonId, belief.context);
  let practice = state.coordinationPractices.find((candidate) => candidate.basisKey === key);
  if (receipt.reliability === 'negative') {
    if (!practice) return;
    if (!practice.recentCounterEvidence.some((counter) => counter.receiptId === receipt.id)) {
      practice.recentCounterEvidence.push({
        atMonth: receipt.atMonth,
        receiptId: receipt.id,
        sourceEventIds: [...receipt.sourceEventIds],
      });
      practice.recentCounterEvidence = practice.recentCounterEvidence
        .sort((left, right) => left.atMonth - right.atMonth || left.receiptId.localeCompare(right.receiptId))
        .slice(-MAX_PRACTICE_EPISODES);
    }
  } else if (practice) {
    practice.successes = mergePracticeSuccess(practice.successes, receipt);
  } else {
    const positiveReceipts = belief.receipts
      .filter((candidate) => candidate.reliability === 'positive')
      .sort((left, right) => left.atMonth - right.atMonth || left.id.localeCompare(right.id));
    const distinctMonths = new Set(positiveReceipts.map((candidate) => candidate.atMonth));
    if (distinctMonths.size < 2) return;
    const successes: CoordinationPracticeSuccessBasis[] = [];
    for (const successReceipt of positiveReceipts) mergePracticeSuccess(successes, successReceipt);
    const formedAtMonth = successes[1]?.atMonth;
    if (formedAtMonth === undefined) return;
    practice = {
      version: 'coordination-practice-basis-v1',
      basisKey: key,
      observerId: person.id,
      targetPersonId: belief.targetPersonId,
      participantIds: [person.id, belief.targetPersonId],
      context: belief.context,
      formedAtMonth,
      lastUpdatedAtMonth: receipt.atMonth,
      support: 'supported',
      successes,
      recentCounterEvidence: [],
      sourceFactIds: [],
    };
    state.coordinationPractices.push(practice);
  }
  if (!practice) return;
  practice.lastUpdatedAtMonth = Math.max(practice.lastUpdatedAtMonth, receipt.atMonth);
  refreshPracticeSupport(practice);
  state.coordinationPractices = state.coordinationPractices
    .sort((left, right) => right.lastUpdatedAtMonth - left.lastUpdatedAtMonth
      || left.basisKey.localeCompare(right.basisKey))
    .slice(0, MAX_COORDINATION_PRACTICES);
}

/**
 * The only mutation primitive for social posteriors. Callers must supply a
 * replayable consequence source; option ids, cooldowns and observer metrics are
 * deliberately insufficient.
 */
export function recordSocialLearningEvidence(
  person: PersonState,
  targetPersonId: PersonId,
  context: CooperationContext,
  input: RecordSocialLearningEvidenceInput,
): SocialCooperationBelief | undefined {
  const sourceEventIds = uniqueSources(input.sourceEventIds);
  if (sourceEventIds.length > MAX_SOCIAL_BELIEF_SOURCES) {
    throw new Error(
      `social learning receipt ${input.receiptId} sourceEventIds 超出上限 `
      + MAX_SOCIAL_BELIEF_SOURCES,
    );
  }
  const hasEvidence = input.response !== undefined
    || input.willingness !== undefined
    || input.reliability !== undefined;
  if (targetPersonId === person.id
    || !Number.isSafeInteger(input.atMonth)
    || input.atMonth < 0
    || input.receiptId.length === 0
    || sourceEventIds.length === 0
    || !hasEvidence) return undefined;
  const state = ensureSocialLearningState(person, input.atMonth);
  let belief = state.beliefs.find((candidate) => (
    candidate.targetPersonId === targetPersonId && candidate.context === context
  ));
  if (!belief) {
    belief = freshBelief(targetPersonId, context, input.atMonth);
    state.beliefs.push(belief);
  }
  if (belief.receipts.some((receipt) => receipt.id === input.receiptId)) return belief;
  const receipt: SocialLearningReceipt = {
    version: 'social-learning-receipt-v1',
    id: input.receiptId,
    kind: input.kind,
    atMonth: input.atMonth,
    ...(input.response ? { response: input.response } : {}),
    ...(input.willingness ? { willingness: input.willingness } : {}),
    ...(input.reliability ? { reliability: input.reliability } : {}),
    sourceEventIds,
  };
  if (receipt.response) applyDimensionEvidence(belief.response, receipt.response, receipt.atMonth);
  if (receipt.willingness) applyDimensionEvidence(belief.willingness, receipt.willingness, receipt.atMonth);
  if (receipt.reliability) applyDimensionEvidence(belief.reliability, receipt.reliability, receipt.atMonth);
  belief.receipts = [...belief.receipts, receipt]
    .sort((left, right) => left.atMonth - right.atMonth || left.id.localeCompare(right.id))
    .slice(-MAX_SOCIAL_BELIEF_RECEIPTS);
  belief.sourceEventIds = uniqueSources([...belief.sourceEventIds, ...sourceEventIds])
    .slice(-MAX_SOCIAL_BELIEF_SOURCES);
  belief.lastUpdatedAtMonth = Math.max(belief.lastUpdatedAtMonth, receipt.atMonth);
  updateCoordinationPractice(person, state, belief, receipt);
  state.beliefs = state.beliefs
    .sort((left, right) => right.lastUpdatedAtMonth - left.lastUpdatedAtMonth
      || right.receipts.length - left.receipts.length
      || left.basisKey.localeCompare(right.basisKey))
    .slice(0, MAX_SOCIAL_COOPERATION_BELIEFS);
  return belief;
}

/** Reproduction is intentionally outside cooperation reputation. */
export function proposalCooperationContext(proposal: SocialProposal): CooperationContext | null {
  switch (proposal.kind) {
    case 'reproduce': return null;
    case 'assist': return `assist-${proposal.need}`;
    case 'exchange': return 'exchange';
    case 'companion': return 'shared-living';
    case 'collective': return 'collective-formation';
    case 'membership': return 'collective-membership';
    case 'permission': return 'collective-permission';
    case 'decision-rule': return 'governance-decision-rule';
    case 'mandate': return 'governance-mandate';
  }
}

function livingPerson(state: SimulationState, personId: PersonId): PersonState | undefined {
  const person = personById(state, personId);
  return person && isAlive(person) ? person : undefined;
}

export function recordAgreementResponseSocialLearning(
  state: SimulationState,
  agreement: Agreement,
  responderId: PersonId,
  response: 'accepted' | 'rejected',
  atMonth: number,
  sourceEventIds: string[],
): void {
  const context = proposalCooperationContext(agreement.proposal);
  const observer = livingPerson(state, agreement.proposerId);
  if (!context || !observer || responderId === observer.id) return;
  recordSocialLearningEvidence(observer, responderId, context, {
    receiptId: `agreement-response:${agreement.id}:${responderId}`,
    kind: 'proposal-response',
    atMonth,
    sourceEventIds,
    response: 'positive',
    willingness: response === 'accepted' ? 'positive' : 'negative',
  });
}

export function recordAgreementNoResponseSocialLearning(
  state: SimulationState,
  agreement: Agreement,
  responderId: PersonId,
  atMonth: number,
  sourceEventIds: string[],
): void {
  const context = proposalCooperationContext(agreement.proposal);
  const observer = livingPerson(state, agreement.proposerId);
  if (!context || !observer || responderId === observer.id) return;
  recordSocialLearningEvidence(observer, responderId, context, {
    receiptId: `agreement-no-response:${agreement.id}:${responderId}`,
    kind: 'proposal-no-response',
    atMonth,
    sourceEventIds,
    response: 'negative',
  });
}

function recordPairReliability(
  state: SimulationState,
  observerId: PersonId,
  targetPersonId: PersonId,
  context: CooperationContext,
  input: Omit<RecordSocialLearningEvidenceInput, 'reliability'> & { reliability: SocialEvidenceResult },
): void {
  const observer = livingPerson(state, observerId);
  if (!observer || observerId === targetPersonId) return;
  recordSocialLearningEvidence(observer, targetPersonId, context, input);
}

export function recordAgreementFulfillmentSocialLearning(
  state: SimulationState,
  agreement: Agreement,
  atMonth: number,
  sourceEventIds: string[],
): void {
  const context = proposalCooperationContext(agreement.proposal);
  if (!context) return;
  if (agreement.proposal.kind === 'assist') {
    recordPairReliability(state, agreement.proposal.requesterId, agreement.proposal.helperId, context, {
      receiptId: `agreement-fulfillment:${agreement.id}:${agreement.proposal.requesterId}:${agreement.proposal.helperId}`,
      kind: 'agreement-fulfillment',
      atMonth,
      sourceEventIds,
      reliability: 'positive',
    });
    return;
  }
  if (agreement.proposal.kind !== 'exchange' && agreement.proposal.kind !== 'companion') return;
  for (const observerId of agreement.partyIds) for (const targetPersonId of agreement.partyIds) {
    if (observerId === targetPersonId) continue;
    recordPairReliability(state, observerId, targetPersonId, context, {
      receiptId: `agreement-fulfillment:${agreement.id}:${observerId}:${targetPersonId}`,
      kind: 'agreement-fulfillment',
      atMonth,
      sourceEventIds,
      reliability: 'positive',
    });
  }
}

export function recordAgreementBreachSocialLearning(
  state: SimulationState,
  agreement: Agreement,
  atMonth: number,
  sourceEventIds: string[],
): void {
  const context = proposalCooperationContext(agreement.proposal);
  if (!context) return;
  if (agreement.proposal.kind === 'assist') {
    recordPairReliability(state, agreement.proposal.requesterId, agreement.proposal.helperId, context, {
      receiptId: `agreement-breach:${agreement.id}:${agreement.proposal.requesterId}:${agreement.proposal.helperId}`,
      kind: 'agreement-breach',
      atMonth,
      sourceEventIds,
      reliability: 'negative',
    });
    return;
  }
  const debtorIds = agreement.proposal.kind === 'exchange'
    ? agreement.partyIds.filter((personId) => !agreement.fulfilledByPersonIds.includes(personId))
    : agreement.partyIds;
  for (const observerId of agreement.partyIds) for (const targetPersonId of debtorIds) {
    if (observerId === targetPersonId) continue;
    recordPairReliability(state, observerId, targetPersonId, context, {
      receiptId: `agreement-breach:${agreement.id}:${observerId}:${targetPersonId}`,
      kind: 'agreement-breach',
      atMonth,
      sourceEventIds,
      reliability: 'negative',
    });
  }
}

function projectCooperationContext(kind: ProjectKind): CooperationContext {
  if (kind === 'production') return 'joint-project-production';
  if (kind === 'construction') return 'joint-project-construction';
  return 'joint-project-inquiry';
}

function compareAuthoritativeEventOrder(left: WorldEvent, right: WorldEvent): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.id.localeCompare(right.id);
}

/**
 * A completed joint project counts only contributors named by real progress
 * evidence. The completion is one success episode, regardless of tick volume.
 */
export function recordJointProjectSocialLearning(
  state: SimulationState,
  project: Pick<ProjectState, 'id' | 'kind' | 'contributorIds' | 'progressEvidence' | 'completionEventIds'>,
  atMonth: number,
): void {
  const participants = [...new Set(project.contributorIds)];
  if (participants.length < 2) return;
  const latestProgressEventByActor = new Map<PersonId, WorldEvent>();
  for (const evidence of project.progressEvidence ?? []) {
    if (!participants.includes(evidence.actorId)) continue;
    const event = worldEventById(state, evidence.eventId);
    if (event?.kind !== 'action'
      || event.who !== evidence.actorId
      || event.atMonth !== evidence.atMonth
      || (event.status !== 'progressed' && event.status !== 'completed')) continue;
    const latest = latestProgressEventByActor.get(evidence.actorId);
    if (!latest || compareAuthoritativeEventOrder(latest, event) < 0) {
      latestProgressEventByActor.set(evidence.actorId, event);
    }
  }
  let completionEvent: WorldEvent | undefined;
  for (const eventId of uniqueSources(project.completionEventIds)) {
    const event = worldEventById(state, eventId);
    if (event && (!completionEvent || compareAuthoritativeEventOrder(completionEvent, event) < 0)) {
      completionEvent = event;
    }
  }
  const context = projectCooperationContext(project.kind);
  for (const [targetPersonId, progressEvent] of latestProgressEventByActor) {
    for (const observerId of participants) {
      if (observerId === targetPersonId) continue;
      const sourceEventIds = uniqueSources([
        progressEvent,
        ...(completionEvent ? [completionEvent] : []),
      ].sort(compareAuthoritativeEventOrder).map((event) => event.id));
      recordPairReliability(state, observerId, targetPersonId, context, {
        receiptId: `joint-project:${project.id}:${observerId}:${targetPersonId}`,
        kind: 'joint-project-progress',
        atMonth,
        sourceEventIds,
        reliability: 'positive',
      });
    }
  }
}

export function recordMandateCoordinationClosureSocialLearning(
  state: SimulationState,
  holderId: PersonId,
  contributorIds: PersonId[],
  recipientIds: PersonId[],
  closureId: string,
  atMonth: number,
  sourceEventIds: string[],
): void {
  for (const contributorId of [...new Set(contributorIds)]) {
    recordPairReliability(state, holderId, contributorId, 'mandate-resource-coordination', {
      receiptId: `mandate-closure:${closureId}:${holderId}:${contributorId}`,
      kind: 'mandate-coordination-closure',
      atMonth,
      sourceEventIds,
      reliability: 'positive',
    });
  }
  for (const recipientId of [...new Set(recipientIds)]) {
    recordPairReliability(state, recipientId, holderId, 'mandate-resource-coordination', {
      receiptId: `mandate-closure:${closureId}:${recipientId}:${holderId}`,
      kind: 'mandate-coordination-closure',
      atMonth,
      sourceEventIds,
      reliability: 'positive',
    });
  }
}
