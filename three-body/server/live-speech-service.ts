import { ageMonths } from '../src/game/eland/domain/person';
import { effectivePersonality } from '../src/game/eland/domain/personality';
import { buildPersonSoul } from '../src/game/eland/domain/person-soul';
import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';
import type { SpeechLineView } from '../src/game/societyContract';
import type { SpeechLineDraft } from '../src/game/eland/projection/live-speech';
import { loadServerEnvValue } from './env';
import { requestModelText, type ModelMessage } from './model-client';
import { resolveModelEndpoint, type ResolvedModelEndpoint } from './model-config';

type ActionEvent = Extract<WorldEvent, { kind: 'action' }>;

interface SpeechRequestItem {
  sourceEventId: string;
  speaker: {
    name: string;
    description: string;
    ageMonths: number;
    sex: SimulationState['people'][number]['sex'];
    communicationCapacity: number;
    body: SimulationState['people'][number]['body'];
    conditions: SimulationState['people'][number]['conditions'];
    personality: ReturnType<typeof effectivePersonality>;
    motiveSensitivity: SimulationState['people'][number]['motiveSensitivity'];
    soul: ReturnType<typeof buildPersonSoul>;
  };
  listeners: Array<{ name: string; trust: number; bond: number; fear: number }>;
  situation: {
    elapsedMonths: number;
    epoch: SimulationState['civilization']['epoch'];
    climate: SimulationState['civilization']['climate'];
    weather: SimulationState['civilization']['weather'];
  };
  communication: {
    speechAct: SpeechLineDraft['speechAct'];
  };
  sourcedExperiences: string[];
  recentMemories: Array<{ kind: string; summary: string }>;
  knownFacts: Array<{ id: string; summary: string; confidence: number }>;
}

export interface LiveSpeechResult {
  lines: SpeechLineView[];
  generationErrors: string[];
}

const SPEECH_BATCH_SIZE = 6;
const SPEECH_BATCH_CONCURRENCY = 3;
const SYSTEM_PROMPT = [
  '你为规则优先的物质世界中已经真实发生的口头沟通写台词。',
  '规则只决定说话者、听者、沟通类型、事实、提议与立场，不提供可显示原话。你要依据 communication.speechAct 自主决定完整表达，但绝不能改变结构化内容。',
  '不要把规划摘要或字段值当成对白模板照抄；要依照人物 Soul、当下关系与处境组织自然语言。',
  '人格、身体处境、彼此关系、近期记忆和亲历事实只影响语气与用词。不得补充输入中没有的新事实、行动、承诺、知识、关系或情绪。',
  'speaker.description 只是档案原型与外貌线索，不证明当前身份、技能、知识或历史；与结构化 personality 或 soul 冲突时以后两者为准。',
  'personality 是 0 到 100 的 HEXACO 有效人格：高外向可更主动，高情绪性可更敏感，高宜人性可更温和，高尽责可更明确，高开放可更好奇，高诚实谦逊应少夸耀；低值表现为相反倾向，但不要机械套模板。',
  'speaker.soul 是同一人物由长期人格确定性投影出的表达锚。把 innerVoice 和 speechStyle 内化为稳定口吻，不要复述 Soul、人格标签或数值，也不要让它改变 speechAct。',
  '年龄和表达能力仍限制实际句式；孩子或沟通能力有限的人要更短、更具体，不能照抄 Soul 里的成年书面语言。',
  '每句使用说话者第一人称，像当面自然说出的话，通常 12 到 90 个汉字。不要写旁白、舞台说明、引号、ID、坐标、系统术语或现代游戏评论。',
  'claim 必须忠实表达 speechAct 的 subject、details 与有源经历；若 details.factId 存在，只能表达 knownFacts 中同 id 的事实。request/offer 必须保留请求或提议；accept/reject 必须保持原立场；revoke/withdraw 必须清楚表达撤回或退出。',
  '严格输出一个 JSON 对象，不输出解释，格式为：{"lines":[{"sourceEventId":"输入中的原值","text":"实际台词"}]}。每个输入必须恰好返回一次。',
].join('\n');

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

export function speechLineMatchesAct(
  line: Pick<SpeechLineDraft, 'communicationKind' | 'audienceNames'>,
  candidate: string,
): boolean {
  if (cleanText(candidate).length < 2) return false;
  if (!stancePreserved(line.communicationKind, candidate)) return false;
  if (line.communicationKind === 'accept' || line.communicationKind === 'reject'
    || line.communicationKind === 'revoke-agreement' || line.communicationKind === 'revoke'
    || line.communicationKind === 'withdraw') return true;
  if (line.communicationKind === 'request' && !/(?:请|帮|能不能|能否|可不可以|希望|需要)/u.test(candidate)) return false;
  if (line.communicationKind === 'offer' && !/(?:愿意|可以|提议|希望|一起|给你|让你)/u.test(candidate)) return false;
  return true;
}

function eventBefore(source: WorldEvent | undefined, speech: ActionEvent): boolean {
  if (!source) return false;
  return source.atMonth < speech.atMonth
    || source.atMonth === speech.atMonth && source.orderInMonth < speech.orderInMonth;
}

export function buildSpeechRequestItem(
  state: SimulationState,
  events: WorldEvent[],
  line: SpeechLineDraft,
): SpeechRequestItem | null {
  const event = events.find((candidate): candidate is ActionEvent => candidate.kind === 'action' && candidate.id === line.sourceEventId);
  if (!event || event.action.kind !== 'communicate') return null;
  const speaker = state.people.find((person) => person.id === line.speakerId);
  if (!speaker) return null;
  const authorizedFactId = typeof line.speechAct.details?.factId === 'string'
    ? line.speechAct.details.factId
    : undefined;
  const eventById = new Map(state.world.past.map((candidate) => [candidate.id, candidate]));
  const listeners = line.audienceIds.flatMap((listenerId) => {
    const listener = state.people.find((person) => person.id === listenerId);
    if (!listener) return [];
    const relation = speaker.relations.find((candidate) => candidate.personId === listenerId);
    return [{
      name: listener.name,
      trust: relation?.trust ?? 0,
      bond: relation?.bond ?? 0,
      fear: relation?.fear ?? 0,
    }];
  });
  const sourcedExperiences = line.sourceFactIds
    .map((sourceId) => eventById.get(sourceId))
    .filter((source): source is WorldEvent => source !== undefined
      && source.kind !== 'decision'
      && source.kind !== 'decision-opportunity'
      && eventBefore(source, event))
    .sort((a, b) => a.atMonth - b.atMonth || a.orderInMonth - b.orderInMonth)
    .slice(-6)
    .map((source) => source.result.slice(0, 180));
  const recentMemories = [...speaker.memories]
    .filter((memory) => !memory.sourceEventIds.includes(event.id))
    .filter((memory) => memory.sourceEventIds.length === 0
      || memory.sourceEventIds.some((sourceId) => eventBefore(eventById.get(sourceId), event)))
    .sort((a, b) => b.importance - a.importance || b.createdAtMonth - a.createdAtMonth)
    .slice(0, 6)
    .map((memory) => ({ kind: memory.kind, summary: memory.summary.slice(0, 180) }));

  return {
    sourceEventId: line.sourceEventId,
    speaker: {
      name: speaker.name,
      description: speaker.profile.description.slice(0, 200),
      ageMonths: ageMonths(speaker, state.clock.elapsedMonths),
      sex: speaker.sex,
      communicationCapacity: speaker.baselineCapacities.communication,
      body: speaker.body,
      conditions: speaker.conditions,
      personality: effectivePersonality(speaker),
      motiveSensitivity: speaker.motiveSensitivity,
      soul: buildPersonSoul(speaker),
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
    },
    sourcedExperiences,
    recentMemories,
    knownFacts: [...speaker.knowledge]
      .filter((fact) => fact.learnedAtMonth < event.atMonth
        || fact.learnedAtMonth === event.atMonth
          && fact.sourceEventIds.length > 0
          && fact.sourceEventIds.some((sourceId) => eventBefore(eventById.get(sourceId), event)))
      .sort((a, b) => Number(b.id === authorizedFactId) - Number(a.id === authorizedFactId)
        || b.confidence - a.confidence)
      .slice(0, 5)
      .map((fact) => ({ id: fact.id, summary: fact.summary.slice(0, 160), confidence: fact.confidence })),
  };
}

export function normalizeSpeechResponse(
  input: unknown,
  requestedLines: SpeechLineDraft[],
): Map<string, string> {
  if (!input || typeof input !== 'object') return new Map();
  const rawLines = (input as { lines?: unknown }).lines;
  if (!Array.isArray(rawLines)) return new Map();
  const requested = new Map(requestedLines.map((line) => [line.sourceEventId, line]));
  const result = new Map<string, string>();
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceEventId = cleanText((raw as Record<string, unknown>).sourceEventId);
    const text = cleanText((raw as Record<string, unknown>).text);
    const line = requested.get(sourceEventId);
    if (!line || result.has(sourceEventId) || !speechLineMatchesAct(line, text)) continue;
    result.set(sourceEventId, text);
  }
  return result;
}

async function realizeBatch(
  endpoint: ResolvedModelEndpoint,
  items: SpeechRequestItem[],
  lines: SpeechLineDraft[],
  timeoutMs: number,
): Promise<SpeechLineView[]> {
  const messages: ModelMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
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
  return lines.flatMap((line): SpeechLineView[] => {
    const text = normalized.get(line.sourceEventId);
    if (!text) return [];
    const { modelText: _modelText, ...base } = line;
    return [{
      ...base,
      text,
      source: 'speech-model',
      endpointId: response.endpointId,
      model: response.model,
    }];
  });
}

function retainedDecisionLine(line: SpeechLineDraft): SpeechLineView | null {
  const text = cleanText(line.modelText);
  if (!text || !speechLineMatchesAct(line, text)) return null;
  const { modelText: _modelText, ...base } = line;
  return { ...base, text, source: 'decision-model' };
}

/** Keep only already validated model utterances when no speech endpoint is active. */
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
): Promise<LiveSpeechResult> {
  const retained = new Map(retainDecisionSpeechLines(sourceLines).map((line) => [line.sourceEventId, line]));
  const candidates = sourceLines.filter((line) => !retained.has(line.sourceEventId));
  if (!candidates.length) return { lines: [...retained.values()], generationErrors: [] };
  const endpoint = resolveModelEndpoint('decision', endpointId);
  const indexed = candidates.flatMap((line) => {
    const item = buildSpeechRequestItem(state, events, line);
    return item ? [{ line, item }] : [];
  });
  const batches: Array<typeof indexed> = [];
  for (let index = 0; index < indexed.length; index += SPEECH_BATCH_SIZE) {
    batches.push(indexed.slice(index, index + SPEECH_BATCH_SIZE));
  }

  const realized = new Map<string, SpeechLineView>();
  const generationErrors: string[] = [];
  const deadline = Date.now() + speechTotalTimeout();
  for (let index = 0; index < batches.length; index += SPEECH_BATCH_CONCURRENCY) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) {
      generationErrors.push('即时台词总等待时间已到，其余沟通不显示文字气泡');
      break;
    }
    await Promise.all(batches.slice(index, index + SPEECH_BATCH_CONCURRENCY).map(async (batch) => {
      try {
        const lines = await realizeBatch(endpoint, batch.map(({ item }) => item), batch.map(({ line }) => line), remainingMs);
        for (const line of lines) realized.set(line.sourceEventId, line);
      } catch (error) {
        generationErrors.push(error instanceof Error ? error.message : String(error));
      }
    }));
  }
  return {
    lines: sourceLines.flatMap((line) => {
      const visible = retained.get(line.sourceEventId) ?? realized.get(line.sourceEventId);
      return visible ? [visible] : [];
    }),
    generationErrors,
  };
}
