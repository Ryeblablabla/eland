import { ageMonths } from '../src/game/eland/domain/person';
import { effectivePersonality } from '../src/game/eland/domain/personality';
import { buildPersonSoul } from '../src/game/eland/domain/person-soul';
import type { SimulationState, TokenUsage, WorldEvent } from '../src/game/eland/simulation';
import type {
  DialogueDisposition,
  DialogueMove,
  SpeechLineView,
} from '../src/game/societyContract';
import type { SpeechLineDraft } from '../src/game/eland/projection/live-speech';
import { verifiedSpeechLinesBySourceEventId } from '../src/game/eland/projection/speech-history';
import { loadServerEnvValue } from './env';
import { requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ResolvedModelEndpoint } from './model-config';
import { communicationProfile, selectContextualMemories } from './persona-context';
import { SPEECH_SYSTEM_PROMPT_V2 } from './agent-prompt-templates';

type ActionEvent = Extract<WorldEvent, { kind: 'action' }>;

interface SpeechRequestItem {
  sourceEventId: string;
  speaker: {
    name: string;
    ageMonths: number;
    sex: SimulationState['people'][number]['sex'];
    communicationCapacity: number;
    communication: ReturnType<typeof communicationProfile>;
    body: SimulationState['people'][number]['body'];
    conditions: SimulationState['people'][number]['conditions'];
    personality: ReturnType<typeof effectivePersonality>;
    motiveSensitivity: SimulationState['people'][number]['motiveSensitivity'];
    soul: ReturnType<typeof buildPersonSoul>;
    activity: {
      currentAction: string;
      activeIntent?: { summary: string; progress: number };
      activeAgenda?: {
        aim: string;
        theme: string;
        status: string;
        currentApproach?: string;
      };
    };
  };
  listeners: Array<{
    name: string;
    trust: number;
    bond: number;
    fear: number;
    currentAction: string;
    sameCell: boolean;
  }>;
  situation: {
    elapsedMonths: number;
    epoch: SimulationState['civilization']['epoch'];
    climate: SimulationState['civilization']['climate'];
    weather: SimulationState['civilization']['weather'];
  };
  communication: {
    speechAct: SpeechLineDraft['speechAct'];
    relationalFrame: RelationalSpeechFrame;
    /** Earlier model draft, never a rule summary; model may keep or rewrite it. */
    proposedText?: string;
    replyTo?: {
      speechLineId: string;
      sourceEventId: string;
      speakerName: string;
      text: string;
      pronouns: {
        previousFirstPerson: string;
        previousSecondPerson: string;
      };
      dialogueMove?: DialogueMove;
      disposition?: DialogueDisposition;
    };
  };
  sourcedExperiences: string[];
  recentMemories: Array<{ kind: string; summary: string; participants: string[] }>;
  knownFacts: Array<{ id: string; summary: string; confidence: number }>;
}

export interface LiveSpeechResult {
  lines: SpeechLineView[];
  generationErrors: string[];
  usage: TokenUsage;
  providerRequests: number;
}

const SPEECH_BATCH_SIZE = 6;
const SPEECH_BATCH_CONCURRENCY = 3;
function parseJson(content: string): unknown {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^(?:["'“”‘’]+)|(?:["'“”‘’]+)$/gu, '')
    .replace(/\s+/gu, ' ')
    .slice(0, 120)
    .trim();
}

function speechTimeout(endpoint: ResolvedModelEndpoint): number {
  const configured = Number(loadServerEnvValue('MODEL_SPEECH_TIMEOUT_MS') || Math.min(endpoint.timeoutMs, 12_000));
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(30_000, configured)) : 12_000;
}

function speechMaxOutputTokens(lineCount: number): number {
  const configured = Number(loadServerEnvValue('MODEL_SPEECH_MAX_OUTPUT_TOKENS') || Math.max(320, lineCount * 180));
  return Number.isFinite(configured) ? Math.max(128, Math.min(2_000, Math.floor(configured))) : 720;
}

function speechTotalTimeout(): number {
  const configured = Number(loadServerEnvValue('MODEL_SPEECH_TOTAL_TIMEOUT_MS') || 24_000);
  return Number.isFinite(configured) ? Math.max(2_000, Math.min(45_000, configured)) : 24_000;
}

function stancePreserved(kind: SpeechLineView['communicationKind'], text: string): boolean {
  const rejects = /(?:不打算答应|不能答应|没法答应|不愿意?答应|不接受|不同意|不愿意?|不能|不行|不成|拒绝|做不到|别再|免了|还是不了)/u.test(text);
  const affirmativeText = text.replace(/(?:不打算答应|不能答应|没法答应|不愿意?答应|不接受|不同意|不愿意?|不能|不行|不成|拒绝|做不到|别再|免了|还是不了)/gu, '');
  const accepts = /(?:接受|同意|愿意|答应|可以|好啊|好吧|没问题|就这么办|照你说的|依你|成[，。！？\s])/u.test(`${affirmativeText} `);
  if (kind === 'accept') return accepts && !rejects;
  if (kind === 'reject') return rejects && !accepts;
  if (kind === 'revoke-agreement' || kind === 'revoke' || kind === 'withdraw') {
    return /(?:撤|收回|退出|离开|不再|取消|终止)/u.test(text);
  }
  return true;
}

const POLITE_REQUEST = /(?:请|帮|能不能|能否|可不可以|希望|需要)/u;
const DIRECT_REQUEST = /(?:^(?:(?:你|我们|咱们)?(?:先|快|马上|现在|别|不要|停|走|来|去|过来|跟上|继续|动手|等等|一起)|把.+)|(?:给我|拿来|递来|递过来|送来|送过来|搬来|搬过来|交出来|放这(?:里)?|留给我)(?:[，。！？\s]|$))/u;

const CHINESE_DIGIT = new Map<string, number>([
  ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
  ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
]);
const CHINESE_UNIT = new Map<string, number>([['十', 10], ['百', 100], ['千', 1_000]]);
const MONTH_NUMBER = '[0-9]+|[零〇一二两三四五六七八九十百千万]+';

function parseChineseInteger(value: string): number | undefined {
  if (!value || !/^[零〇一二两三四五六七八九十百千万]+$/u.test(value)) return undefined;
  if (!/[十百千万]/u.test(value)) {
    const decimal = [...value].map((character) => CHINESE_DIGIT.get(character));
    if (decimal.some((digit) => digit === undefined)) return undefined;
    return Number(decimal.join(''));
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of value) {
    const numeric = CHINESE_DIGIT.get(character);
    if (numeric !== undefined) {
      digit = numeric;
      continue;
    }
    if (character === '万') {
      total += (section + digit) * 10_000;
      section = 0;
      digit = 0;
      continue;
    }
    const unit = CHINESE_UNIT.get(character);
    if (!unit) return undefined;
    section += (digit || 1) * unit;
    digit = 0;
  }
  return total + section + digit;
}

function parseMonthNumber(value: string): number | undefined {
  const normalized = value.replace(/[０-９]/gu, (character) => String(character.codePointAt(0)! - 0xfee0));
  if (/^[0-9]+$/u.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return parseChineseInteger(normalized);
}

function mentionedPredictionMonths(text: string, spokenAtMonth: number): number[] {
  const months: number[] = [];
  const absolute = new RegExp(`第\\s*(${MONTH_NUMBER})\\s*(?:个)?月`, 'gu');
  for (const match of text.matchAll(absolute)) {
    const month = parseMonthNumber(match[1]!);
    if (month !== undefined) months.push(month);
  }
  const relativeAfter = new RegExp(`(?:再过|还有|还要)\\s*(${MONTH_NUMBER})\\s*个?月`, 'gu');
  for (const match of text.matchAll(relativeAfter)) {
    const offset = parseMonthNumber(match[1]!);
    if (offset !== undefined) months.push(spokenAtMonth + offset);
  }
  const relativeSuffix = new RegExp(`(${MONTH_NUMBER})\\s*个?月(?:后|以后)`, 'gu');
  for (const match of text.matchAll(relativeSuffix)) {
    const offset = parseMonthNumber(match[1]!);
    if (offset !== undefined) months.push(spokenAtMonth + offset);
  }
  return [...new Set(months)];
}

function predictionEpochAliases(targetEpoch: unknown): string[] {
  if (targetEpoch === 'chaotic') return ['乱纪元', '混乱纪元', '混乱时代'];
  if (targetEpoch === 'stable') return ['恒纪元', '稳定纪元', '稳定时代'];
  return [];
}

function explicitlyNegatesEpoch(text: string, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?:不会|不可能|未必|并非|不是|没有)(?:[^，。；！？]{0,5})${escaped}`, 'u').test(text)
      || new RegExp(`${escaped}(?:[^，。；！？]{0,5})(?:不会|不可能|未必|并非|不是|不来|不到)`, 'u').test(text);
  });
}

function predictionMeaningPreserved(
  line: Pick<SpeechLineDraft, 'month' | 'speechAct'>,
  candidate: string,
): boolean {
  const rawPrediction = line.speechAct.details?.prediction;
  if (!rawPrediction || typeof rawPrediction !== 'object' || Array.isArray(rawPrediction)) return false;
  const prediction = rawPrediction as Record<string, unknown>;
  const predictedStartMonth = Number(prediction.predictedStartMonth);
  const aliases = predictionEpochAliases(prediction.targetEpoch);
  if (!Number.isSafeInteger(predictedStartMonth) || predictedStartMonth < 0 || !aliases.length) return false;
  const clauses = candidate
    .replace(/[０-９]/gu, (character) => String(character.codePointAt(0)! - 0xfee0))
    .split(/[，,。；;！？!?]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index]!;
    if (!aliases.some((alias) => clause.includes(alias)) || explicitlyNegatesEpoch(clause, aliases)) continue;
    const localMonths = mentionedPredictionMonths(clause, line.month);
    if (localMonths.length) {
      if (localMonths.includes(predictedStartMonth)) return true;
      continue;
    }
    // Natural speech often puts the time and the epoch on the two sides of a
    // pause ("第八月前后，乱纪元会来"). The adjacent clause is accepted only
    // when the epoch clause does not assert a competing month of its own.
    const adjacent = [clauses[index - 1], clauses[index + 1]].filter(
      (value): value is string => Boolean(value),
    );
    if (adjacent.some((value) => mentionedPredictionMonths(value, line.month).includes(predictedStartMonth))) {
      return true;
    }
  }
  return false;
}

export function speechLineMatchesAct(
  line: Pick<SpeechLineDraft, 'communicationKind' | 'audienceNames' | 'month' | 'speechAct'>,
  candidate: string,
): boolean {
  if (cleanText(candidate).length < 2) return false;
  if (line.communicationKind !== line.speechAct.kind) return false;
  if (!stancePreserved(line.communicationKind, candidate)) return false;
  if (line.communicationKind === 'prediction') return predictionMeaningPreserved(line, candidate);
  if (line.communicationKind === 'accept' || line.communicationKind === 'reject'
    || line.communicationKind === 'revoke-agreement' || line.communicationKind === 'revoke'
    || line.communicationKind === 'withdraw') return true;
  if (line.communicationKind === 'request' && !POLITE_REQUEST.test(candidate) && !DIRECT_REQUEST.test(candidate)) return false;
  if (line.communicationKind === 'offer' && !/(?:愿意|可以|提议|希望|一起|给你|让你)/u.test(candidate)) return false;
  return true;
}

function eventBefore(source: WorldEvent | undefined, speech: ActionEvent): boolean {
  if (!source) return false;
  return source.atMonth < speech.atMonth
    || source.atMonth === speech.atMonth && source.orderInMonth < speech.orderInMonth;
}

export type RelationalSpeechTone = 'neutral' | 'warm' | 'familiar' | 'guarded' | 'blunt' | 'confrontational';

export interface RelationalSpeechFrame {
  version: 'relational-speech-frame-v1';
  tone: RelationalSpeechTone;
  intensity: 'low' | 'medium' | 'high';
  reasonBudget: 'optional' | 'one-brief-reason' | 'situational';
  hostilityAllowed: boolean;
  drivers: string[];
  frictionEvidence: Array<{
    sourceEventId: string;
    kind: 'harm' | 'breach' | 'coercion' | 'repeated-pressure';
    summary: string;
  }>;
  instruction: string;
}

type RelationFrictionEvidence = RelationalSpeechFrame['frictionEvidence'][number];

function frictionFromRelationSource(
  source: WorldEvent | undefined,
  speech: ActionEvent,
  speakerId: string,
  listenerId: string,
): RelationFrictionEvidence | null {
  if (!source || !eventBefore(source, speech)) return null;
  if (source.kind === 'agreement' && source.change === 'breached'
    && source.partyIds.includes(speakerId) && source.partyIds.includes(listenerId)) {
    return { sourceEventId: source.id, kind: 'breach', summary: source.result.slice(0, 160) };
  }
  if (source.kind !== 'action' || source.who !== listenerId) return null;
  if (source.diff.victimId === speakerId) {
    return { sourceEventId: source.id, kind: 'harm', summary: source.result.slice(0, 160) };
  }
  if (source.diff.restrainedPersonId === speakerId
    || source.diff.resistedBy === speakerId && source.diff.authorized === false) {
    return { sourceEventId: source.id, kind: 'coercion', summary: source.result.slice(0, 160) };
  }
  return null;
}

function repeatedPressureEvidence(
  state: SimulationState,
  speech: ActionEvent,
  speakerId: string,
  listenerId: string,
): RelationFrictionEvidence[] {
  const recentIncoming = state.world.past.filter((candidate): candidate is ActionEvent => (
    candidate.kind === 'action'
      && eventBefore(candidate, speech)
      && candidate.atMonth >= speech.atMonth - 12
      && candidate.status === 'completed'
      && candidate.who === listenerId
      && candidate.action.kind === 'communicate'
      && candidate.action.channel === 'voice'
      && candidate.action.audience.includes(speakerId)
      && (candidate.action.content.kind === 'request' || candidate.action.content.kind === 'offer')
  ));
  if (recentIncoming.length < 2) return [];
  const incomingIds = new Set(recentIncoming.map((candidate) => candidate.action.kind === 'communicate'
    ? candidate.action.content.id
    : ''));
  const rejected = state.world.past.some((candidate) => (
    candidate.kind === 'action'
      && eventBefore(candidate, speech)
      && candidate.atMonth >= speech.atMonth - 12
      && candidate.status === 'completed'
      && candidate.who === speakerId
      && candidate.action.kind === 'communicate'
      && candidate.action.channel === 'voice'
      && candidate.action.audience.includes(listenerId)
      && candidate.action.content.kind === 'reject'
      && incomingIds.has(candidate.action.content.referenceId)
  ));
  if (!rejected) return [];
  return recentIncoming.slice(-2).map((candidate) => ({
    sourceEventId: candidate.id,
    kind: 'repeated-pressure' as const,
    summary: candidate.result.slice(0, 160),
  }));
}

const TONE_INSTRUCTION: Record<RelationalSpeechTone, string> = {
  neutral: '像普通人当面说话，直接或委婉都可以；说到够用即可，不主动添加客套、警告或冲突。',
  warm: '自然照顾对方感受，可给一个与眼前事实有关的简短理由；温和不等于郑重客套。',
  familiar: '可以省略寒暄，使用熟人间的短句或轻微调侃；保持自然，不要每句都刻意表现熟络。',
  guarded: '保持一点距离，少透露自己；优先简短作答，只有话题确有疑点时才反问或表示保留。',
  blunt: '先给结论或直接要求，可以省略理由；语气清楚即可，不自动添加“别”、训斥或不耐烦。',
  confrontational: '可以基于 frictionEvidence 质问或表达不满；只说有证据的冲突，不扩大成无来源的羞辱或威胁。',
};

export function deriveRelationalSpeechFrame(
  state: SimulationState,
  speech: ActionEvent,
  speaker: SimulationState['people'][number],
  listenerIds: readonly string[],
): RelationalSpeechFrame {
  const personality = effectivePersonality(speaker);
  const eventById = new Map(state.world.past.map((candidate) => [candidate.id, candidate]));
  const relations = listenerIds.map((listenerId) => ({
    listenerId,
    relation: speaker.relations.find((candidate) => candidate.personId === listenerId),
  }));
  const frictionEvidence = relations.flatMap(({ listenerId, relation }) => {
    const sourced = (relation?.sourceEventIds ?? []).flatMap((sourceId) => {
      const evidence = frictionFromRelationSource(eventById.get(sourceId), speech, speaker.id, listenerId);
      return evidence ? [evidence] : [];
    });
    return [...sourced, ...repeatedPressureEvidence(state, speech, speaker.id, listenerId)];
  }).filter((evidence, index, all) => all.findIndex((candidate) => candidate.sourceEventId === evidence.sourceEventId) === index)
    .slice(-4);
  const trustValues = relations.map(({ relation }) => relation?.trust ?? 0);
  const bondValues = relations.map(({ relation }) => relation?.bond ?? 0);
  const fearValues = relations.map(({ relation }) => relation?.fear ?? 0);
  const minimumTrust = trustValues.length ? Math.min(...trustValues) : 0;
  const minimumBond = bondValues.length ? Math.min(...bondValues) : 0;
  const maximumFear = fearValues.length ? Math.max(...fearValues) : 0;
  const bodyPressure = Math.min(speaker.body.health, speaker.body.hydration, speaker.body.nutrition);
  const acutePressure = bodyPressure < 35 || speaker.conditions.some((condition) => condition.stage >= 2);
  const lowAgreeableness = personality.agreeableness <= 38;
  const controlSensitive = speaker.motiveSensitivity.control >= 64;
  const allFamiliar = listenerIds.length > 0 && minimumTrust >= 50 && minimumBond >= 65 && maximumFear < 30;
  const hasFrictionEvidence = frictionEvidence.length > 0;
  const communicationKind = speech.action.kind === 'communicate' ? speech.action.content.kind : undefined;
  const conversationTopic = speech.action.kind === 'communicate' && speech.action.content.kind === 'claim'
    ? speech.action.content.conversation?.topic
    : undefined;
  const boundaryAct = communicationKind === 'request'
    || communicationKind === 'reject'
    || communicationKind === 'revoke'
    || communicationKind === 'revoke-agreement'
    || communicationKind === 'withdraw';
  const careLike = conversationTopic === 'care'
    || conversationTopic === 'gratitude'
    || conversationTopic === 'family';
  const sustainedPressure = frictionEvidence.some((evidence) => evidence.kind === 'repeated-pressure');

  let tone: RelationalSpeechTone;
  if (hasFrictionEvidence && (boundaryAct || sustainedPressure || minimumTrust <= 35 || maximumFear >= 40)) {
    tone = 'confrontational';
  } else if (allFamiliar) {
    tone = 'familiar';
  } else if (careLike && personality.agreeableness >= 50 && minimumTrust >= 45) {
    tone = 'warm';
  } else if (boundaryAct && (lowAgreeableness || controlSensitive || acutePressure)) {
    tone = 'blunt';
  } else if (minimumTrust < 35 || maximumFear >= 40
    || personality.extraversion <= 30 && minimumTrust < 50) {
    tone = 'guarded';
  } else if (personality.agreeableness >= 65 && minimumTrust >= 50) {
    tone = 'warm';
  } else {
    tone = 'neutral';
  }

  const drivers = [
    ...(lowAgreeableness ? ['low-agreeableness'] : []),
    ...(controlSensitive ? ['control-sensitive'] : []),
    ...(acutePressure ? ['acute-body-pressure'] : []),
    ...(minimumTrust < 35 ? ['low-trust'] : []),
    ...(minimumBond >= 65 ? ['high-bond'] : []),
    ...(maximumFear >= 40 ? ['fear'] : []),
    ...(boundaryAct ? ['boundary-act'] : []),
    ...(careLike ? ['care-like-topic'] : []),
    ...(frictionEvidence.some((evidence) => evidence.kind !== 'repeated-pressure') ? ['sourced-conflict'] : []),
    ...(frictionEvidence.some((evidence) => evidence.kind === 'repeated-pressure') ? ['repeated-pressure'] : []),
  ];
  const reasonBudget = tone === 'warm'
    ? 'one-brief-reason'
    : tone === 'confrontational' ? 'situational' : 'optional';
  const intensity = tone === 'confrontational'
    ? frictionEvidence.some((evidence) => evidence.kind === 'harm' || evidence.kind === 'coercion')
      ? 'high'
      : 'medium'
    : 'low';
  const hostilityAllowed = tone === 'confrontational';
  return {
    version: 'relational-speech-frame-v1',
    tone,
    intensity,
    reasonBudget,
    hostilityAllowed,
    drivers,
    frictionEvidence,
    instruction: TONE_INSTRUCTION[tone],
  };
}

function activeSpeechContext(
  state: SimulationState,
  speaker: SimulationState['people'][number],
): SpeechRequestItem['speaker']['activity'] {
  const activeIntent = (speaker.activeIntentId
    ? state.intents.find((intent) => intent.id === speaker.activeIntentId && intent.ownerId === speaker.id)
    : undefined)
    ?? state.intents.find((intent) => intent.ownerId === speaker.id && intent.status === 'active');
  const agendaItems = speaker.characterAgenda?.items ?? [];
  const activeAgenda = (activeIntent?.characterAgendaItemId
    ? agendaItems.find((item) => item.id === activeIntent.characterAgendaItemId)
    : undefined)
    ?? agendaItems
      .filter((item) => item.status === 'active' || item.status === 'incubating' || item.status === 'suspended')
      .sort((a, b) => b.importance - a.importance || b.lastReviewedAtMonth - a.lastReviewedAtMonth)[0];
  const activeApproach = activeAgenda?.approaches.find((approach) => (
    approach.id === activeIntent?.characterAgendaApproachId
      || approach.id === activeAgenda.activeApproachId
  ));
  return {
    currentAction: speaker.currentActionText?.trim().replace(/\s+/gu, ' ').slice(0, 160) || '此刻停留在原地',
    ...(activeIntent ? {
      activeIntent: {
        summary: activeIntent.summary.trim().replace(/\s+/gu, ' ').slice(0, 180),
        progress: Math.max(0, Math.min(100, Math.round(activeIntent.progress ?? 0))),
      },
    } : {}),
    ...(activeAgenda ? {
      activeAgenda: {
        aim: activeAgenda.aim.trim().replace(/\s+/gu, ' ').slice(0, 180),
        theme: activeAgenda.theme.trim().replace(/\s+/gu, ' ').slice(0, 80),
        status: activeAgenda.status,
        ...(activeApproach ? {
          currentApproach: activeApproach.summary.trim().replace(/\s+/gu, ' ').slice(0, 180),
        } : {}),
      },
    } : {}),
  };
}

/**
 * Resolve only a verified, earlier model utterance addressed between the same
 * participants. A rule summary is never accepted as a substitute parent.
 */
export function replySpeechLineFor(
  state: SimulationState,
  event: ActionEvent,
  line: SpeechLineDraft,
  availableSpeechLines: readonly SpeechLineView[],
): SpeechLineView | undefined {
  if (!line.replyToSourceEventId) return undefined;
  const eventsById = new Map(state.world.past.map((candidate) => [candidate.id, candidate]));
  const parentEvent = eventsById.get(line.replyToSourceEventId);
  if (!parentEvent || !eventBefore(parentEvent, event)) return undefined;
  const parent = verifiedSpeechLinesBySourceEventId(availableSpeechLines, eventsById)
    .get(line.replyToSourceEventId);
  if (!parent
    || !parent.audienceIds.includes(line.speakerId)
    || !line.audienceIds.includes(parent.speakerId)) return undefined;
  return parent;
}

export function buildSpeechRequestItem(
  state: SimulationState,
  events: WorldEvent[],
  line: SpeechLineDraft,
  availableSpeechLines: readonly SpeechLineView[] = [],
): SpeechRequestItem | null {
  const event = events.find((candidate): candidate is ActionEvent => candidate.kind === 'action' && candidate.id === line.sourceEventId);
  if (!event || event.action.kind !== 'communicate') return null;
  const speaker = state.people.find((person) => person.id === line.speakerId);
  if (!speaker) return null;
  const replyTo = replySpeechLineFor(state, event, line, availableSpeechLines);
  if (line.requiresParentSpeech && !replyTo) return null;
  const authorizedFactId = typeof line.speechAct.details?.factId === 'string'
    ? line.speechAct.details.factId
    : undefined;
  const eventById = new Map(state.world.past.map((candidate) => [candidate.id, candidate]));
  const explicitFact = authorizedFactId
    ? speaker.knowledge.find((fact) => fact.id === authorizedFactId)
    : undefined;
  const contextualSourceIds = new Set([
    ...line.sourceFactIds,
    ...(replyTo ? [replyTo.sourceEventId, ...replyTo.sourceFactIds] : []),
  ]);
  const contextualMemorySourceIds = new Set([
    ...contextualSourceIds,
    ...(explicitFact?.sourceEventIds ?? []),
  ]);
  const listeners = line.audienceIds.flatMap((listenerId) => {
    const listener = state.people.find((person) => person.id === listenerId);
    if (!listener) return [];
    const relation = speaker.relations.find((candidate) => candidate.personId === listenerId);
    return [{
      name: listener.name,
      trust: relation?.trust ?? 0,
      bond: relation?.bond ?? 0,
      fear: relation?.fear ?? 0,
      currentAction: listener.currentActionText?.trim().replace(/\s+/gu, ' ').slice(0, 120) || '此刻停留在附近',
      sameCell: listener.position?.cellId === speaker.position?.cellId,
    }];
  });
  const sourcedExperiences = line.sourceFactIds
    .map((sourceId) => eventById.get(sourceId))
    .filter((source): source is WorldEvent => source !== undefined
      && source.kind !== 'decision'
      && source.kind !== 'decision-opportunity'
      && eventBefore(source, event))
    .sort((a, b) => a.atMonth - b.atMonth || a.orderInMonth - b.orderInMonth)
    .slice(-4)
    .map((source) => source.result.slice(0, 180));
  const eligibleMemories = [...speaker.memories]
    .filter((memory) => !memory.sourceEventIds.includes(event.id))
    .filter((memory) => memory.sourceEventIds.length > 0
      && memory.sourceEventIds.some((sourceId) => eventBefore(eventById.get(sourceId), event)))
    .filter((memory) => memory.sourceEventIds.some((sourceId) => contextualMemorySourceIds.has(sourceId)))
    .sort((a, b) => b.importance - a.importance || b.createdAtMonth - a.createdAtMonth);
  const speechCue = JSON.stringify(line.speechAct);
  const recentMemories = selectContextualMemories(eligibleMemories, {
    query: speechCue,
    participantIds: line.audienceIds,
    maximum: 4,
  }).map((memory) => ({
    kind: memory.kind,
    summary: memory.summary.slice(0, 180),
    participants: memory.personIds.flatMap((personId) => {
      const participant = state.people.find((person) => person.id === personId);
      return participant ? [participant.name] : [];
    }),
  }));

  return {
    sourceEventId: line.sourceEventId,
    speaker: {
      name: speaker.name,
      ageMonths: ageMonths(speaker, state.clock.elapsedMonths),
      sex: speaker.sex,
      communicationCapacity: speaker.baselineCapacities.communication,
      communication: communicationProfile(
        speaker.baselineCapacities.communication,
        ageMonths(speaker, state.clock.elapsedMonths),
      ),
      body: speaker.body,
      conditions: speaker.conditions,
      personality: effectivePersonality(speaker),
      motiveSensitivity: speaker.motiveSensitivity,
      soul: buildPersonSoul(speaker),
      activity: activeSpeechContext(state, speaker),
    },
    listeners,
    situation: {
      elapsedMonths: state.clock.elapsedMonths,
      epoch: state.civilization.epoch,
      climate: state.civilization.climate,
      weather: state.civilization.weather,
    },
    communication: {
      speechAct: line.speechAct,
      relationalFrame: deriveRelationalSpeechFrame(state, event, speaker, line.audienceIds),
      ...(!line.requiresParentSpeech && cleanText(line.modelText)
        ? { proposedText: cleanText(line.modelText) }
        : {}),
      ...(replyTo ? {
        replyTo: {
          speechLineId: replyTo.id,
          sourceEventId: replyTo.sourceEventId,
          speakerName: replyTo.speakerName,
          text: replyTo.text,
          pronouns: {
            previousFirstPerson: replyTo.speakerName,
            previousSecondPerson: speaker.name,
          },
          ...(replyTo.dialogueMove ? { dialogueMove: replyTo.dialogueMove } : {}),
          ...(replyTo.disposition ? { disposition: replyTo.disposition } : {}),
        },
      } : {}),
    },
    sourcedExperiences,
    recentMemories,
    knownFacts: [...speaker.knowledge]
      .filter((fact) => fact.sourceEventIds.length > 0
        && fact.sourceEventIds.some((sourceId) => eventBefore(eventById.get(sourceId), event))
        && fact.learnedAtMonth <= event.atMonth)
      .filter((fact) => fact.id === authorizedFactId
        || fact.sourceEventIds.some((sourceId) => contextualSourceIds.has(sourceId)))
      .sort((a, b) => Number(b.id === authorizedFactId) - Number(a.id === authorizedFactId)
        || b.confidence - a.confidence)
      .slice(0, 4)
      .map((fact) => ({ id: fact.id, summary: fact.summary.slice(0, 160), confidence: fact.confidence })),
  };
}

const DIALOGUE_MOVES = new Set<DialogueMove>([
  'add-detail', 'correct', 'question', 'tease', 'challenge',
  'reveal', 'deflect', 'acknowledge', 'close',
]);
const DIALOGUE_DISPOSITIONS = new Set<DialogueDisposition>(['continue', 'close', 'rupture']);

export interface NormalizedSpeechRealization {
  text: string;
  dialogueMove: DialogueMove;
  disposition: DialogueDisposition;
}

export function normalizeSpeechResponse(
  input: unknown,
  requestedLines: SpeechLineDraft[],
): Map<string, NormalizedSpeechRealization> {
  if (!input || typeof input !== 'object') return new Map();
  const rawLines = (input as { lines?: unknown }).lines;
  if (!Array.isArray(rawLines)) return new Map();
  const requested = new Map(requestedLines.map((line) => [line.sourceEventId, line]));
  const result = new Map<string, NormalizedSpeechRealization>();
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceEventId = cleanText((raw as Record<string, unknown>).sourceEventId);
    const text = cleanText((raw as Record<string, unknown>).text);
    const dialogueMove = cleanText((raw as Record<string, unknown>).dialogueMove) as DialogueMove;
    const disposition = cleanText((raw as Record<string, unknown>).disposition) as DialogueDisposition;
    const line = requested.get(sourceEventId);
    if (!line
      || result.has(sourceEventId)
      || !DIALOGUE_MOVES.has(dialogueMove)
      || !DIALOGUE_DISPOSITIONS.has(disposition)
      || !speechLineMatchesAct(line, text)) continue;
    result.set(sourceEventId, { text, dialogueMove, disposition });
  }
  return result;
}

async function realizeBatch(
  endpoint: ResolvedModelEndpoint,
  items: SpeechRequestItem[],
  lines: SpeechLineDraft[],
  timeoutMs: number,
): Promise<{ lines: SpeechLineView[]; usage: TokenUsage }> {
  const messages: ModelMessage[] = [
    { role: 'system', content: SPEECH_SYSTEM_PROMPT_V2 },
    { role: 'user', content: JSON.stringify({ lines: items }) },
  ];
  const response = await requestModelText(endpoint, {
    messages,
    temperature: endpoint.temperature ?? 0.8,
    maxOutputTokens: speechMaxOutputTokens(items.length),
    jsonObject: true,
    timeoutMs: Math.min(speechTimeout(endpoint), timeoutMs),
  });
  const normalized = normalizeSpeechResponse(parseJson(response.text), lines);
  const itemBySourceEventId = new Map(items.map((item) => [item.sourceEventId, item]));
  const realizedLines = lines.flatMap((line): SpeechLineView[] => {
    const realization = normalized.get(line.sourceEventId);
    if (!realization) return [];
    const requestItem = itemBySourceEventId.get(line.sourceEventId);
    const {
      modelText: _modelText,
      replyToSourceEventId: _replyToSourceEventId,
      requiresParentSpeech: _requiresParentSpeech,
      ...base
    } = line;
    return [{
      ...base,
      text: realization.text,
      dialogueMove: realization.dialogueMove,
      disposition: realization.disposition,
      ...(requestItem?.communication.replyTo
        ? { replyToSpeechLineId: requestItem.communication.replyTo.speechLineId }
        : {}),
      source: 'speech-model',
      endpointId: response.endpointId,
      model: response.model,
    }];
  });
  return { lines: realizedLines, usage: response.usage };
}

function retainedDecisionLine(line: SpeechLineDraft): SpeechLineView | null {
  // A decision-time utterance was generated without the preceding visible
  // model line. Reusing it as a reply would recreate the orphan-response bug.
  if (line.requiresParentSpeech || line.replyToSourceEventId) return null;
  const conversation = line.speechAct.details?.conversation;
  if (conversation
    && typeof conversation === 'object'
    && !Array.isArray(conversation)
    && (conversation as Record<string, unknown>).topic === 'open'
    && (conversation as Record<string, unknown>).turn === 'opening') return null;
  const text = cleanText(line.modelText);
  if (!text || !speechLineMatchesAct(line, text)) return null;
  const {
    modelText: _modelText,
    replyToSourceEventId: _replyToSourceEventId,
    requiresParentSpeech: _requiresParentSpeech,
    dialogueMove,
    disposition,
    ...base
  } = line;
  return {
    ...base,
    text,
    ...(dialogueMove && DIALOGUE_MOVES.has(dialogueMove) ? { dialogueMove } : {}),
    ...(disposition && DIALOGUE_DISPOSITIONS.has(disposition) ? { disposition } : {}),
    source: 'decision-model',
  };
}

/**
 * A validated decision-time utterance is already the person's chosen wording;
 * observer-only dialogue metadata is optional and does not justify a second
 * model call. Exact-parent replies remain excluded until the visible parent
 * line can be supplied to the expression sidecar.
 */
export function retainDecisionSpeechLines(lines: SpeechLineDraft[]): SpeechLineView[] {
  return lines.flatMap((line) => {
    const retained = retainedDecisionLine(line);
    return retained ? [retained] : [];
  });
}

/**
 * Give every completed spoken event one model-expression opportunity. Existing
 * valid decision-model utterances are reused. Failed or invalid generations
 * simply produce no visible text bubble; the authoritative ActionFact remains.
 */
export async function realizeLiveSpeechLines(
  state: SimulationState,
  events: WorldEvent[],
  sourceLines: SpeechLineDraft[],
  endpointId?: string,
  priorSpeechLines: readonly SpeechLineView[] = [],
): Promise<LiveSpeechResult> {
  // Decision-time text is a proposed thought. The expression pass sees the
  // actual relationship, prior visible line and voice profile, so it owns all
  // player-visible wording when a model endpoint exists.
  const retained = new Map<string, SpeechLineView>();
  const pending = new Map(sourceLines
    .filter((line) => !retained.has(line.sourceEventId))
    .map((line) => [line.sourceEventId, line]));
  if (!pending.size) return {
    lines: [...retained.values()], generationErrors: [],
    usage: { inputTokens: 0, outputTokens: 0 }, providerRequests: 0,
  };
  const endpoint = resolveModelEndpoint('decision', endpointId);
  const realized = new Map<string, SpeechLineView>();
  const generationErrors: string[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let providerRequests = 0;
  const deadline = Date.now() + speechTotalTimeout();

  const eventsById = new Map(state.world.past.map((event) => [event.id, event]));
  const knownSpeech = verifiedSpeechLinesBySourceEventId(priorSpeechLines, eventsById);
  for (const line of retained.values()) knownSpeech.set(line.sourceEventId, line);

  // Generate dependency-free turns first. A response becomes eligible only
  // after its exact parent line has survived model generation and validation.
  while (pending.size > 0) {
    const eligible = [...pending.values()].filter((line) => (
      !line.requiresParentSpeech
        || Boolean(line.replyToSourceEventId && knownSpeech.has(line.replyToSourceEventId))
    ));
    if (!eligible.length) break;
    for (const line of eligible) pending.delete(line.sourceEventId);

    const availableSpeech = [...knownSpeech.values()];
    const indexed = eligible.flatMap((line) => {
      const item = buildSpeechRequestItem(state, events, line, availableSpeech);
      return item ? [{ line, item }] : [];
    });
    const batches: Array<typeof indexed> = [];
    for (let index = 0; index < indexed.length; index += SPEECH_BATCH_SIZE) {
      batches.push(indexed.slice(index, index + SPEECH_BATCH_SIZE));
    }

    for (let index = 0; index < batches.length; index += SPEECH_BATCH_CONCURRENCY) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) {
        generationErrors.push('即时台词总等待时间已到，其余沟通不显示文字气泡');
        pending.clear();
        break;
      }
      await Promise.all(batches.slice(index, index + SPEECH_BATCH_CONCURRENCY).map(async (batch) => {
        try {
          providerRequests += 1;
          const realizedBatch = await realizeBatch(
            endpoint,
            batch.map(({ item }) => item),
            batch.map(({ line }) => line),
            remainingMs,
          );
          usage = {
            inputTokens: usage.inputTokens + realizedBatch.usage.inputTokens,
            outputTokens: usage.outputTokens + realizedBatch.usage.outputTokens,
            ...((usage.cacheHitInputTokens !== undefined || realizedBatch.usage.cacheHitInputTokens !== undefined)
              ? { cacheHitInputTokens: (usage.cacheHitInputTokens ?? 0) + (realizedBatch.usage.cacheHitInputTokens ?? 0) }
              : {}),
            ...((usage.cacheMissInputTokens !== undefined || realizedBatch.usage.cacheMissInputTokens !== undefined)
              ? { cacheMissInputTokens: (usage.cacheMissInputTokens ?? 0) + (realizedBatch.usage.cacheMissInputTokens ?? 0) }
              : {}),
          };
          for (const line of realizedBatch.lines) realized.set(line.sourceEventId, line);
        } catch (error) {
          generationErrors.push(error instanceof Error ? error.message : String(error));
        }
      }));
    }
    for (const line of realized.values()) knownSpeech.set(line.sourceEventId, line);
  }
  return {
    lines: sourceLines.flatMap((line) => {
      const visible = retained.get(line.sourceEventId) ?? realized.get(line.sourceEventId);
      return visible ? [visible] : [];
    }),
    generationErrors,
    usage,
    providerRequests,
  };
}
