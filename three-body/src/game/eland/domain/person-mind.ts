import {
  retrieveAgentMemories,
  type RecalledMemory,
} from './agent-memory';
import type { CharacterAgendaItem } from './character-agenda';
import type { MentalAct } from './mental-act';
import type { SimulationState } from './model';
import type { PersonState } from './person';

export const PERSON_MIND_MARKDOWN_VERSION = 'person-mind-markdown-v1' as const;

export interface ConcernView {
  id: string;
  aim: string;
  theme: string;
  importance: number;
  status: CharacterAgendaItem['status'];
  sourceEventIds: string[];
}

/** One compiled, transient AST for a person's single persisted Markdown mind. */
export interface PersonMindView {
  markdown: string;
  episodes: RecalledMemory[];
  beliefs: RecalledMemory[];
  concerns: ConcernView[];
  deliberations: Array<MentalAct & { atMonth: number }>;
}

type PersonMindState = Pick<SimulationState, 'memoryStore' | 'people' | 'clock' | 'world'>;

const CONCERN_STATUS_PRIORITY: Record<CharacterAgendaItem['status'], number> = {
  active: 0,
  incubating: 1,
  blocked: 2,
  suspended: 3,
  fulfilled: 4,
  abandoned: 5,
};

function line(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().replaceAll('-->', '→');
}

function metadata(kind: 'memory' | 'concern' | 'deliberation', value: unknown): string {
  return `<!-- eland-${kind} ${JSON.stringify(value)} -->`;
}

function memorySection(title: string, memories: readonly RecalledMemory[], offset: number): string[] {
  if (!memories.length) return [`# ${title}`, '', '_无_', ''];
  return [
    `# ${title}`,
    '',
    ...memories.flatMap((memory, index) => [
      `- [m${offset + index + 1}] ${line(memory.gist)}`,
      metadata('memory', memory),
    ]),
    '',
  ];
}

function renderPersonMindMarkdown(input: {
  person: PersonState;
  atMonth: number;
  episodes: RecalledMemory[];
  beliefs: RecalledMemory[];
  concerns: ConcernView[];
  deliberations: Array<MentalAct & { atMonth: number }>;
}): string {
  const concernLines = input.concerns.length
    ? input.concerns.flatMap((concern, index) => [
        `- [g${index + 1}] ${line(concern.aim)}`,
        metadata('concern', concern),
      ])
    : ['_无_'];
  const deliberationLines = input.deliberations.length
    ? input.deliberations.flatMap((act, index) => [
        `- [d${index + 1}] ${line(act.goal)} — ${line(act.strategy)}`,
        metadata('deliberation', act),
      ])
    : ['_无_'];
  return [
    '---',
    `version: ${PERSON_MIND_MARKDOWN_VERSION}`,
    `person: ${input.person.id}`,
    `through_month: ${input.atMonth}`,
    '---',
    '',
    '# 当前关切',
    '',
    ...concernLines,
    '',
    ...memorySection('经历', input.episodes, 0),
    ...memorySection('信念', input.beliefs, input.episodes.length),
    '# 最近思考',
    '',
    ...deliberationLines,
    '',
  ].join('\n');
}

function parseMetadata<T>(markdown: string, kind: string): T[] {
  const pattern = new RegExp(`<!-- eland-${kind} (.+) -->`, 'gu');
  return [...markdown.matchAll(pattern)].flatMap((match) => {
    try {
      return [JSON.parse(match[1]) as T];
    } catch {
      return [];
    }
  });
}

export function compilePersonMindMarkdown(markdown: string): PersonMindView {
  const memories = parseMetadata<RecalledMemory>(markdown, 'memory');
  return {
    markdown,
    episodes: memories.filter((memory) => memory.lane === 'episodic' || memory.lane === 'dialogue'),
    beliefs: memories.filter((memory) => memory.lane === 'semantic'
      || memory.lane === 'social'
      || memory.lane === 'procedural'),
    concerns: parseMetadata<ConcernView>(markdown, 'concern'),
    deliberations: parseMetadata<MentalAct & { atMonth: number }>(markdown, 'deliberation'),
  };
}

export function createEmptyPersonMindMarkdown(personId: string, atMonth: number): string {
  return [
    '---',
    `version: ${PERSON_MIND_MARKDOWN_VERSION}`,
    `person: ${personId}`,
    `through_month: ${atMonth}`,
    '---',
    '',
    '# 当前关切', '', '_无_', '',
    '# 经历', '', '_无_', '',
    '# 信念', '', '_无_', '',
    '# 最近思考', '', '_无_', '',
  ].join('\n');
}

/** Pure projection used by the writer and read-only historical adapters. */
export function projectPersonMindMarkdown(
  state: PersonMindState,
  person: PersonState,
  atMonth: number,
): string {
  const recalled = retrieveAgentMemories(state, person, {
    atMonth,
    unresolved: true,
    laneLimits: {
      episodic: 8,
      dialogue: 6,
      semantic: 8,
      social: 6,
      procedural: 8,
      prospective: 0,
    },
    limit: 24,
    tokenBudget: 3_000,
  });
  const episodes = recalled.filter((memory) => memory.lane === 'episodic' || memory.lane === 'dialogue');
  const beliefs = recalled.filter((memory) => memory.lane === 'semantic'
    || memory.lane === 'social'
    || memory.lane === 'procedural');
  const concerns = (person.characterAgenda?.items ?? [])
    .filter((item) => item.status !== 'fulfilled' && item.status !== 'abandoned')
    .sort((left, right) => CONCERN_STATUS_PRIORITY[left.status] - CONCERN_STATUS_PRIORITY[right.status]
      || right.importance - left.importance
      || right.lastReviewedAtMonth - left.lastReviewedAtMonth
      || left.id.localeCompare(right.id))
    .map((item): ConcernView => ({
      id: item.id,
      aim: item.aim,
      theme: item.theme,
      importance: item.importance,
      status: item.status,
      sourceEventIds: [...item.sourceFactIds],
    }));
  const deliberations = [...state.world.past]
    .reverse()
    .flatMap((event) => event.kind === 'decision'
      && event.who === person.id
      && 'mentalAct' in event.decision
      && event.decision.mentalAct
      ? [{ ...structuredClone(event.decision.mentalAct), atMonth: event.atMonth }]
      : [])
    .slice(0, 4);
  return renderPersonMindMarkdown({
    person,
    atMonth,
    episodes,
    beliefs,
    concerns,
    deliberations,
  });
}

/** Deterministic local writer; models never edit the Markdown directly. */
export function refreshPersonMindMarkdown(
  state: PersonMindState,
  person: PersonState,
  atMonth: number,
): string {
  person.mindMarkdown = projectPersonMindMarkdown(state, person, atMonth);
  return person.mindMarkdown;
}

export function buildPersonMindView(
  state: PersonMindState,
  person: PersonState,
  atMonth: number,
): PersonMindView {
  return compilePersonMindMarkdown(refreshPersonMindMarkdown(state, person, atMonth));
}
