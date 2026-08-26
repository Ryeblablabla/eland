import {
  CIVILIZATION_POEM_STYLES,
  civilizationPoemStyle,
  civilizationRequiemKey,
  isCivilizationPoemStyleId,
  type CivilizationPoemStyleId,
  type CivilizationRequiem,
  type CivilizationRequiemLine,
} from '../src/game/civilizationRequiem';
import type { SimulationState } from '../src/game/eland/simulation';
import { livingPeople } from '../src/game/eland/domain/state-index';
import type { NarrativeEntryView } from '../src/game/societyContract';
import { requestModelText } from './model-client';
import { resolveModelEndpoint } from './model-config';

export interface CivilizationRequiemFacts {
  civilizationId: number;
  branchId: string;
  endedAtMonth: number;
  endingKind: NonNullable<SimulationState['civilization']['outcome']>['kind'];
  cause: string;
  authoritativeSummary: string;
  stage: string;
  livingPeople: number;
  totalPeople: number;
  names: string[];
  milestones: string[];
  chronicle: Array<{ month: number; text: string; sourceEventIds: string[] }>;
}

interface ModelStanza { lines?: unknown }

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, max) : '';
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('终章模型输出不是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function sourceEventIds(facts: CivilizationRequiemFacts): string[] {
  return [...new Set(facts.chronicle.flatMap((entry) => entry.sourceEventIds))].slice(-160);
}

function originalLocalLines(facts: CivilizationRequiemFacts, styleId: CivilizationPoemStyleId): CivilizationRequiemLine[] {
  const duration = facts.endedAtMonth > 0 ? `${facts.endedAtMonth}个月` : '最初的一个月';
  const names = facts.names.length ? facts.names.slice(0, 4).join('、') : '最初的来者';
  const achievement = facts.milestones.at(-1) ?? facts.stage;
  const populationLine = facts.livingPeople > 0
    ? `落幕时，仍有${facts.livingPeople}个人活在这段历史的最后一月。`
    : '落幕时，这个文明已没有仍然活着的人。';
  const core: CivilizationRequiemLine[] = [
    `我看见第${facts.civilizationId}号文明，在星辰的误差里开始它的第一个月。`,
    `他们叫作${names}；名字不曾替他们挡住寒热，却让相遇有了称呼。`,
    `他们把${duration}交给一次次真正发生过的选择。`,
    '一些行动完成了，一些行动停在条件改变的地方。',
    `他们抵达过“${achievement}”，又从那里继续看向尚未抵达之处。`,
    '已经发生的事实、选择与名字，都不再需要被美化。',
    facts.authoritativeSummary,
    populationLine,
    '三颗太阳仍按自己的法则远近，既不赞许，也不挽留。',
    '但他们曾把不可预测的天空，变成可以共同谈论的一天。',
    '这不是胜利，也不是失败的判词。',
    '这是事实经过时间以后，仍然留下的温度。',
    `第${facts.civilizationId}号文明，至此停止生长。`,
    '它没有从已经发生过的宇宙里消失。',
    '让星光越过他们最后的月份。',
    '让后来者从头开始，而不必假装这里从未有人来过。',
  ].map((text) => ({ text }));

  if (styleId === 'classic-refrain') return core.map((line, index) => ({
    ...line,
    text: index % 4 === 0 ? `星有其行。${line.text}` : line.text,
  }));
  if (styleId === 'pastoral-chronicle') return core.map((line, index) => ({
    ...line,
    text: index % 5 === 2 ? `回看日常，${line.text}` : line.text,
  }));
  if (styleId === 'historical-long-song') return core.map((line, index) => ({
    ...line,
    text: index % 5 === 1 ? `照实记下：${line.text}` : line.text,
  }));
  if (styleId === 'homeric-catalogue') return core.map((line, index) => ({
    ...line,
    text: index % 4 === 3 ? `请记住：${line.text}` : line.text,
  }));
  if (styleId === 'rubai-quatrain') return core.map((line, index) => ({
    ...line,
    text: index % 4 === 0 ? `若问时间，${line.text}` : line.text,
  }));
  return core;
}

export function createLocalCivilizationRequiem(
  facts: CivilizationRequiemFacts,
  styleId: CivilizationPoemStyleId,
): CivilizationRequiem {
  const style = civilizationPoemStyle(styleId);
  return {
    schemaVersion: 4,
    id: civilizationRequiemKey({
      civilizationId: facts.civilizationId,
      branchId: facts.branchId,
      endedAtMonth: facts.endedAtMonth,
    }),
    civilizationId: facts.civilizationId,
    branchId: facts.branchId,
    endedAtMonth: facts.endedAtMonth,
    endingKind: facts.endingKind,
    styleId,
    styleName: style.name,
    title: `写给第 ${facts.civilizationId} 号文明`,
    summary: facts.authoritativeSummary,
    lines: originalLocalLines(facts, styleId),
    source: 'local-fallback',
    sourceEventIds: sourceEventIds(facts),
    generatedAt: new Date().toISOString(),
  };
}

function modelLines(value: unknown): CivilizationRequiemLine[] {
  if (!Array.isArray(value)) return [];
  const lines: CivilizationRequiemLine[] = [];
  value.slice(0, 12).forEach((rawStanza) => {
    const stanza = rawStanza && typeof rawStanza === 'object' ? rawStanza as ModelStanza : {};
    if (!Array.isArray(stanza.lines)) return;
    stanza.lines.slice(0, 4).forEach((rawLine) => {
      const text = cleanText(rawLine, 96);
      if (text) lines.push({ text });
    });
  });
  return lines.slice(0, 36);
}

export function validateCivilizationRequiemGrounding(
  visible: string,
  facts: CivilizationRequiemFacts,
): void {
  if (/\b(?:sourceFacts|atMonth|endingKind|authoritativeSummary)\b/iu.test(visible)) {
    throw new Error('终章模型泄漏了内部字段');
  }
  const sourceCorpus = [
    facts.authoritativeSummary,
    facts.cause,
    facts.stage,
    ...facts.names,
    ...facts.milestones,
    ...facts.chronicle.map((entry) => entry.text),
  ].join('\n');
  const systemWord = ['二进制', '光标', 'JSON', '变量', '坐标', '压缩文件', '历史文件', '结算清单']
    .find((word) => visible.includes(word));
  if (systemWord) throw new Error(`终章模型使用了系统词：${systemWord}`);
  const concreteTerms = [
    '休眠舱', '墓碑', '碑文', '铁门', '石磨', '木板', '钉子', '氧分子', '告别仪式',
    '火把', '帆船', '城墙', '农田', '神庙', '车轮', '青铜', '书页', '钟声',
  ];
  const inventedTerm = concreteTerms.find((term) => visible.includes(term) && !sourceCorpus.includes(term));
  if (inventedTerm) throw new Error(`终章模型增加了无来源事物：${inventedTerm}`);
}

export function requiemFactsFromState(
  state: SimulationState,
  chronicle: NarrativeEntryView[],
): CivilizationRequiemFacts {
  const outcome = state.civilization.outcome;
  if (state.civilization.status !== 'ended' || !outcome) throw new Error('当前文明尚未结算');
  const relevantChronicle = chronicle.slice(-48);
  return {
    civilizationId: state.civilization.number,
    branchId: state.branchId,
    endedAtMonth: outcome.atMonth,
    endingKind: outcome.kind,
    cause: outcome.cause,
    authoritativeSummary: outcome.summary,
    stage: state.civilization.stage,
    livingPeople: livingPeople(state).length,
    totalPeople: state.people.length,
    names: state.people.map((person) => person.name).filter(Boolean).slice(0, 12),
    milestones: state.derived.milestones.slice(-12).map((milestone) => milestone.label),
    chronicle: relevantChronicle.map((entry) => ({
      month: entry.month,
      text: entry.text,
      sourceEventIds: entry.sourceEventIds,
    })),
  };
}

function chooseLocalPoemStyle(facts: CivilizationRequiemFacts): CivilizationPoemStyleId {
  if (facts.endingKind === 'destroyed') return 'historical-long-song';
  if (facts.endingKind === 'milestones') return 'free-verse-catalogue';
  if (facts.endingKind === 'boundary') return 'rubai-quatrain';
  if (facts.endedAtMonth < 24) return 'classic-refrain';
  if (facts.names.length >= 10 || facts.milestones.length >= 8) return 'homeric-catalogue';
  return 'pastoral-chronicle';
}

/** Generate a projection-only original poem; model failure always returns a deterministic local requiem. */
export async function generateCivilizationRequiem(
  facts: CivilizationRequiemFacts,
): Promise<CivilizationRequiem> {
  const fallback = createLocalCivilizationRequiem(facts, chooseLocalPoemStyle(facts));
  try {
    const endpoint = resolveModelEndpoint('narrative');
    const response = await requestModelText(endpoint, {
      temperature: 1,
      maxOutputTokens: 1_600,
      jsonObject: true,
      timeoutMs: Math.min(endpoint.timeoutMs, 45_000),
      messages: [
        {
          role: 'system',
          content: [
            '你为规则优先的文明模拟写一首原创终章诗。facts 是唯一已发生的权威事实。',
            '诗只允许用星辰、光影、时间、声音作为无事实含义的比喻。任何具体人物、动作、材料、工具、建筑、身体状态、技术、自然现象或仪式，都必须在 facts 中明确出现。',
            '不得用否定句偷渡未发生的场景，例如 facts 没有墓碑时也不能写“没有墓碑”。不得出现文件、光标、二进制、变量、坐标、JSON 等系统词。',
            `从以下候选中选择最适合这段真实历史的一种诗风：${JSON.stringify(CIVILIZATION_POEM_STYLES.map((style) => ({ id: style.id, name: style.name, guidance: style.prompt })))}`,
            '诗风由你根据文明时长、结局和历史内容决定。只参考候选传统的高层特征；不得引用、改写或仿制任何诗人的现成诗句。',
            'summary 用朴素中文概括文明一生，不超过 180 字。诗写 6–10 节、合计 16–32 行；全诗是一个连续的单声部，不要写成对话或两个声音。',
            '避免“岁月长河、璀璨篇章、历史见证、命运交响”等套话。不要评价文明指数，不要把月份写成年份。',
            '严格输出 JSON：{"styleId":"候选诗风id","title":"不超过30字","summary":"不超过180字","stanzas":[{"lines":["每行不超过96字"]}]}。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            facts: {
              civilizationId: facts.civilizationId,
              endedAtMonth: facts.endedAtMonth,
              endingKind: facts.endingKind,
              cause: facts.cause,
              authoritativeSummary: facts.authoritativeSummary,
              stage: facts.stage,
              livingPeople: facts.livingPeople,
              totalPeople: facts.totalPeople,
              names: facts.names,
              milestones: facts.milestones,
              chronicle: facts.chronicle.map(({ month, text }) => ({ month, text })),
            },
          }),
        },
      ],
    });
    const parsed = parseJsonObject(response.text);
    const lines = modelLines(parsed.stanzas);
    const title = cleanText(parsed.title, 30);
    const summary = cleanText(parsed.summary, 180);
    if (!isCivilizationPoemStyleId(parsed.styleId)) throw new Error('终章模型没有选择合法诗风');
    if (!title || !summary || lines.length < 12) throw new Error('终章模型返回的诗歌不完整');
    const visible = `${title}\n${summary}\n${lines.map((line) => line.text).join('\n')}`;
    validateCivilizationRequiemGrounding(visible, facts);
    const selectedBase = createLocalCivilizationRequiem(facts, parsed.styleId);
    return {
      ...selectedBase,
      title,
      summary,
      lines,
      source: 'model',
      model: { endpointId: response.endpointId, protocol: response.protocol, name: response.model },
    };
  } catch (error) {
    console.warn(`文明终章改用本地诗：${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}
