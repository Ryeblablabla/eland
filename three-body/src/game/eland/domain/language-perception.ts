import type { StandingPosition } from '../world/grid';
import { cellX, cellY } from '../world/grid';
import { seededFraction } from '../world/generator';

export const LANGUAGE_PERCEPTION_VERSION = 'language-perception-v1' as const;
export const LANGUAGE_BROADCAST_VERSION = 'language-broadcast-v1' as const;

export interface LanguageReception {
  version: typeof LANGUAGE_PERCEPTION_VERSION;
  listenerId: string;
  distance: number;
  intelligibility: number;
  detected: boolean;
  understood: boolean;
}

/**
 * One source string propagated through space. The signal carries no addressee
 * and no authoritative semantic object; each listener may later interpret
 * only the noisy text that reached them.
 */
export interface LanguageBroadcast {
  version: typeof LANGUAGE_BROADCAST_VERSION;
  mode: 'talk' | 'transparent-thought';
  text: string;
  receptions: LanguageReception[];
  perceivedByPersonIds: string[];
  understoodByPersonIds: string[];
}

export function languageBroadcastFromDiff(
  diff: Readonly<Record<string, unknown>>,
): LanguageBroadcast | undefined {
  const value = diff.languageBroadcast;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const broadcast = value as Partial<LanguageBroadcast>;
  return broadcast.version === LANGUAGE_BROADCAST_VERSION
    && (broadcast.mode === 'talk' || broadcast.mode === 'transparent-thought')
    && typeof broadcast.text === 'string'
    && Array.isArray(broadcast.receptions)
    && Array.isArray(broadcast.perceivedByPersonIds)
    && Array.isArray(broadcast.understoodByPersonIds)
    ? broadcast as LanguageBroadcast
    : undefined;
}

export function languageReceptionFor(
  broadcast: LanguageBroadcast | undefined,
  personId: string,
): LanguageReception | undefined {
  return broadcast?.receptions.find((reception) => reception.listenerId === personId);
}

/** The source sees its own line exactly; every other person gets only their signal. */
export function perceivedLanguageText(input: {
  broadcast: LanguageBroadcast;
  observerId: string;
  speakerId: string;
  seed: number;
  sourceFactId: string;
}): string {
  if (input.observerId === input.speakerId) return input.broadcast.text;
  const reception = languageReceptionFor(input.broadcast, input.observerId);
  return reception
    ? confusePerceivedLanguage(input.broadcast.text, reception, input.seed, input.sourceFactId)
    : '';
}

function clampOpenProbability(value: number): number {
  return Math.min(1 - 1e-6, Math.max(1e-6, value));
}

function logit(value: number): number {
  const bounded = clampOpenProbability(value);
  return Math.log(bounded / (1 - bounded));
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/** Continuous spatial distance; vertical separation attenuates voice more strongly. */
export function auditoryDistance(first: StandingPosition, second: StandingPosition): number {
  const dx = cellX(first.cellId) - cellX(second.cellId);
  const dy = cellY(first.cellId) - cellY(second.cellId);
  const dz = (first.z - second.z) * 1.5;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Expected clarity is never exactly zero or one at a finite distance. A
 * replay-stable listener-specific perturbation prevents distance bands from
 * producing identical hearing for everybody standing on the same ring.
 */
export function languageIntelligibility(
  seed: number,
  talkFactId: string,
  speakerId: string,
  listenerId: string,
  distance: number,
): number {
  const expected = logistic((3 - Math.max(0, distance)) / 1.2);
  const listenerNoise = (seededFraction(
    seed,
    `voice:${talkFactId}:${speakerId}:${listenerId}:clarity`,
  ) - 0.5) * 1.4;
  return clampOpenProbability(logistic(logit(expected) + listenerNoise));
}

export function sampleLanguageReception(input: {
  seed: number;
  talkFactId: string;
  speakerId: string;
  listenerId: string;
  speakerPosition: StandingPosition;
  listenerPosition: StandingPosition;
}): LanguageReception {
  const distance = auditoryDistance(input.speakerPosition, input.listenerPosition);
  const intelligibility = languageIntelligibility(
    input.seed,
    input.talkFactId,
    input.speakerId,
    input.listenerId,
    distance,
  );
  const understood = seededFraction(
    input.seed,
    `voice:${input.talkFactId}:${input.speakerId}:${input.listenerId}:understood`,
  ) < intelligibility;
  const detected = understood || seededFraction(
    input.seed,
    `voice:${input.talkFactId}:${input.speakerId}:${input.listenerId}:detected`,
  ) < Math.sqrt(intelligibility);
  return {
    version: LANGUAGE_PERCEPTION_VERSION,
    listenerId: input.listenerId,
    distance: Math.round(distance * 100) / 100,
    intelligibility: Math.round(intelligibility * 10_000) / 10_000,
    detected,
    understood,
  };
}

/**
 * Produce exactly what one listener remembers hearing. The acoustic layer may
 * omit fragments but never invent replacement words; semantic mistakes belong
 * to the listener's later interpretation.
 */
export function confusePerceivedLanguage(
  utterance: string,
  reception: Pick<LanguageReception, 'listenerId' | 'intelligibility' | 'detected'>,
  seed: number,
  talkFactId: string,
): string {
  const text = utterance.trim().replace(/\s+/gu, ' ');
  if (!text || !reception.detected) return '';
  const characters = Array.from(text);
  const audibleIndexes = characters.flatMap((character, index) => (
    character.trim() ? [index] : []
  ));
  if (!audibleIndexes.length) return '';
  const kept = new Set(audibleIndexes.filter((index) => seededFraction(
    seed,
    `voice:${talkFactId}:${reception.listenerId}:fragment:${index}`,
  ) < reception.intelligibility));
  if (!kept.size) {
    const fallback = Math.floor(seededFraction(
      seed,
      `voice:${talkFactId}:${reception.listenerId}:fallback-fragment`,
    ) * audibleIndexes.length);
    kept.add(audibleIndexes[Math.min(audibleIndexes.length - 1, fallback)]!);
  }
  let result = '';
  let obscured = false;
  characters.forEach((character, index) => {
    if (!character.trim()) {
      if (!obscured && result && !result.endsWith(' ')) result += ' ';
      return;
    }
    if (kept.has(index)) {
      result += character;
      obscured = false;
      return;
    }
    if (!obscured) result += '…';
    obscured = true;
  });
  return result.trim().replace(/\s*…\s*/gu, '…').replace(/…{2,}/gu, '…');
}

export function broadcastLanguage(input: {
  seed: number;
  sourceFactId: string;
  speakerId: string;
  mode: LanguageBroadcast['mode'];
  text: string;
  speakerPosition: StandingPosition;
  listeners: ReadonlyArray<{ id: string; position: StandingPosition }>;
}): LanguageBroadcast {
  const receptions = input.listeners
    .filter((listener) => listener.id !== input.speakerId)
    .map((listener) => sampleLanguageReception({
      seed: input.seed,
      talkFactId: `${input.mode}:${input.sourceFactId}`,
      speakerId: input.speakerId,
      listenerId: listener.id,
      speakerPosition: input.speakerPosition,
      listenerPosition: listener.position,
    }));
  return {
    version: LANGUAGE_BROADCAST_VERSION,
    mode: input.mode,
    text: input.text.trim().replace(/\s+/gu, ' '),
    receptions,
    perceivedByPersonIds: receptions.filter((reception) => reception.detected).map((reception) => reception.listenerId),
    understoodByPersonIds: receptions.filter((reception) => reception.understood).map((reception) => reception.listenerId),
  };
}
