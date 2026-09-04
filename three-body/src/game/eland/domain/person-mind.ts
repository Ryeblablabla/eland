import {
  retrieveAgentMemories,
  type RecalledMemory,
} from './agent-memory';
import { MATERIAL_PALETTE, materialDefinition } from './material';
import type { Intent } from './action';
import type { CharacterAgendaItem } from './character-agenda';
import type { MentalAct } from './mental-act';
import type { SimulationState } from './model';
import type { PersonState } from './person';

export const PERSON_MIND_MARKDOWN_VERSION = 'person-mind-markdown-v3' as const;

export interface ConcernView {
  id: string;
  aim: string;
  theme: string;
  importance: number;
  status: CharacterAgendaItem['status'];
  sourceEventIds: string[];
  realityFeedback?: string;
}

/** One compiled, transient AST for a person's single persisted Markdown mind. */
export interface PersonMindView {
  markdown: string;
  episodes: RecalledMemory[];
  beliefs: RecalledMemory[];
  related: RecalledMemory[];
  concerns: ConcernView[];
  deliberations: Array<MentalAct & { atMonth: number }>;
}

type PersonMindState = Pick<SimulationState, 'memoryStore' | 'people' | 'clock' | 'world' | 'projects' | 'intents'>;

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

function metadata(kind: 'memory' | 'related-memory' | 'concern' | 'deliberation', value: unknown): string {
  return `<!-- eland-${kind} ${JSON.stringify(value)} -->`;
}

function memorySection(
  title: string,
  memories: readonly RecalledMemory[],
  offset: number,
  metadataKind: 'memory' | 'related-memory' = 'memory',
): string[] {
  if (!memories.length) return [`# ${title}`, '', '_无_', ''];
  return [
    `# ${title}`,
    '',
    ...memories.flatMap((memory, index) => [
      `- [m${offset + index + 1}] ${line(memory.gist)}`,
      metadata(metadataKind, memory),
    ]),
    '',
  ];
}

function sharesMemoryBasis(left: RecalledMemory, right: RecalledMemory): boolean {
  if (left.id === right.id || left.gist === right.gist) return true;
  if (left.causalBasisKey && left.causalBasisKey === right.causalBasisKey) return true;
  const rightSources = new Set(right.sourceEventIds);
  return left.sourceEventIds.some((sourceEventId) => rightSources.has(sourceEventId));
}

interface ConcernMemoryFocus {
  personIds: string[];
  topicKeys: string[];
  sourceEventIds: string[];
  textTerms: string[];
}

function unique(values: readonly string[], maximum: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, maximum);
}

function concernMemoryFocus(
  state: PersonMindState,
  person: PersonState,
  concerns: readonly CharacterAgendaItem[],
  activeIntent: Intent | undefined,
): ConcernMemoryFocus | null {
  if (!concerns.length && !activeIntent) return null;
  const projectIds = new Set([
    ...concerns.flatMap((concern) => concern.projectIds),
    ...(activeIntent?.projectId ? [activeIntent.projectId] : []),
  ]);
  const projects = state.projects.filter((project) => projectIds.has(project.id));
  const focusText = [
    ...concerns.flatMap((concern) => [
      concern.aim,
      concern.theme,
      ...concern.approaches.map((approach) => approach.summary),
    ]),
    ...projects.map((project) => project.summary),
    ...(activeIntent ? [activeIntent.summary] : []),
  ].join('\n');
  const personIds = new Set<string>();
  for (const candidate of state.people) {
    if (candidate.id !== person.id && focusText.includes(candidate.name)) personIds.add(candidate.id);
  }
  for (const project of projects) {
    [project.ownerId, ...project.beneficiaryIds]
      .filter((personId) => personId !== person.id)
      .forEach((personId) => personIds.add(personId));
  }
  for (const concern of concerns) {
    for (const approach of concern.approaches) {
      if (approach.probe?.kind === 'observe' && approach.probe.target.kind === 'person'
        && approach.probe.target.personId !== person.id) personIds.add(approach.probe.target.personId);
    }
  }
  const activeGoalPersonId = activeIntent && 'personId' in activeIntent.goal
    ? activeIntent.goal.personId
    : undefined;
  if (activeGoalPersonId && activeGoalPersonId !== person.id) personIds.add(activeGoalPersonId);
  const materialIds = new Set<number>();
  for (const material of MATERIAL_PALETTE) {
    if (focusText.includes(material.name)) materialIds.add(material.id);
  }
  for (const project of projects) {
    project.missingMaterialIds.forEach((materialId) => materialIds.add(materialId));
    project.materialDemands?.forEach((demand) => materialIds.add(demand.materialId));
    project.reservations.forEach((reservation) => materialIds.add(reservation.materialId));
    project.inquiryOpportunityBasis?.materialIds.forEach((materialId) => materialIds.add(materialId));
  }
  const sourceEventIds = unique([
    ...concerns.flatMap((concern) => [
      ...concern.sourceFactIds,
      ...concern.approaches.flatMap((approach) => [
        ...approach.sourceFactIds,
        ...approach.evaluations.flatMap((evaluation) => [
          ...evaluation.basisFactIds,
          ...evaluation.evidenceFactIds,
        ]),
      ]),
    ]),
    ...projects.flatMap((project) => [
      ...project.triggerFactIds,
      ...project.actionEventIds,
      ...project.failureEventIds,
      ...project.completionEventIds,
      ...(project.progressEvidence ?? []).map((evidence) => evidence.eventId),
      ...(project.materialDemands ?? []).flatMap((demand) => demand.sourceFactIds),
    ]),
    ...(activeIntent ? [
      activeIntent.sourceDecisionEventId,
      ...(activeIntent.sourceFactIds ?? []),
      ...activeIntent.actionEventIds,
    ] : []),
  ], 128);
  const materialNames = [...materialIds].map((materialId) => materialDefinition(materialId).name);
  const namedPeople = [...personIds].flatMap((personId) => {
    const candidate = state.people.find((other) => other.id === personId);
    return candidate ? [candidate.name] : [];
  });
  const topicKeys = unique([
    ...[...materialIds].flatMap((materialId) => [
      `knowledge-id:material:${materialId}`,
      `place:material:${materialId}`,
    ]),
    ...projects.flatMap((project) => project.targetKnowledgeId
      ? [`knowledge-id:${project.targetKnowledgeId}`]
      : []),
    ...projects.flatMap((project) => [
      `project:${project.id}`,
      `need:${project.need}`,
      `function:${project.desiredFunction}`,
    ]),
  ], 32);
  const textTerms = unique([
    ...materialNames,
    ...namedPeople,
    ...projects.map((project) => project.summary),
    ...concerns.flatMap((concern) => [concern.aim, ...concern.approaches.map((approach) => approach.summary)]),
    ...(activeIntent ? [activeIntent.summary] : []),
  ], 24);
  return personIds.size || topicKeys.length || sourceEventIds.length || textTerms.length
    ? { personIds: [...personIds], topicKeys, sourceEventIds, textTerms }
    : null;
}

function compactMemoryLayer(memories: readonly RecalledMemory[], limit: number): RecalledMemory[] {
  const selected: RecalledMemory[] = [];
  for (const memory of memories) {
    if (selected.some((candidate) => sharesMemoryBasis(candidate, memory))) continue;
    selected.push(memory);
    if (selected.length >= limit) break;
  }
  return selected;
}

function learnedConclusionLayer(memories: readonly RecalledMemory[]): RecalledMemory[] {
  const useful = memories.filter((memory) => memory.lane !== 'procedural'
    || (!memory.causalBasisKey?.includes('|move|') && !memory.gist.includes('移动到目标位置')));
  const selected: RecalledMemory[] = [];
  const take = (memory: RecalledMemory | undefined): void => {
    if (!memory || selected.some((candidate) => sharesMemoryBasis(candidate, memory))) return;
    selected.push(memory);
  };
  const family = (memory: RecalledMemory): string => {
    if (memory.topicKeys.includes('experience:need-resolution')) return 'resolved-need';
    if (memory.lane === 'semantic' && memory.topicKeys.includes('knowledge:technique')) return 'technique';
    if (memory.lane === 'semantic' && memory.id.includes('observation:no-response:')) return 'no-response';
    return memory.lane;
  };
  const familyOrder: string[] = [];
  const byFamily = new Map<string, RecalledMemory[]>();
  for (const memory of useful) {
    const key = family(memory);
    if (!byFamily.has(key)) {
      byFamily.set(key, []);
      familyOrder.push(key);
    }
    byFamily.get(key)!.push(memory);
  }
  while (selected.length < 8) {
    const before = selected.length;
    for (const key of familyOrder) {
      const bucket = byFamily.get(key)!;
      while (bucket.length && selected.length < 8) {
        const candidate = bucket.shift()!;
        const count = selected.length;
        take(candidate);
        if (selected.length > count) break;
      }
    }
    if (selected.length === before) break;
  }
  return selected.slice(0, 8);
}

function usefulFocusedMemory(memory: RecalledMemory): boolean {
  return !memory.causalBasisKey?.includes('|move|')
    && !memory.gist.includes('移动到目标位置');
}

function concernRealityFeedback(item: CharacterAgendaItem): string | undefined {
  const approach = item.approaches.find((candidate) => candidate.id === item.activeApproachId)
    ?? [...item.approaches].sort((left, right) => (
      right.lastConsideredAtMonth - left.lastConsideredAtMonth
        || right.createdAtMonth - left.createdAtMonth
  ))[0];
  if (!approach) return undefined;
  if (approach.latestOutcome === 'refuted') {
    return '状态：办法已否定';
  }
  if (approach.disposition === 'missing-affordance') {
    return '状态：暂无可执行办法';
  }
  if (approach.latestOutcome === 'blocked') {
    return '状态：上次执行受阻';
  }
  if (approach.disposition === 'waiting-for-evidence' || approach.latestOutcome === 'parked') {
    return '状态：等待新证据';
  }
  return undefined;
}

function renderPersonMindMarkdown(input: {
  person: PersonState;
  atMonth: number;
  episodes: RecalledMemory[];
  beliefs: RecalledMemory[];
  related: RecalledMemory[];
  concerns: ConcernView[];
}): string {
  const concernLines = input.concerns.length
    ? input.concerns.flatMap((concern, index) => [
        `- [g${index + 1}] ${line(concern.aim)}${concern.realityFeedback ? `；${line(concern.realityFeedback)}` : ''}`,
        metadata('concern', concern),
      ])
    : ['_无_'];
  return [
    '---',
    `version: ${PERSON_MIND_MARKDOWN_VERSION}`,
    `person: ${input.person.id}`,
    `through_month: ${input.atMonth}`,
    '---',
    '',
    '# 当前未决',
    '',
    ...concernLines,
    '',
    ...memorySection('近期证据', input.episodes, 0),
    ...memorySection('已学结论', input.beliefs, input.episodes.length),
    ...memorySection(
      '当前相关回忆',
      input.related,
      input.episodes.length + input.beliefs.length,
      'related-memory',
    ),
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
  const related = parseMetadata<RecalledMemory>(markdown, 'related-memory');
  return {
    markdown,
    episodes: memories.filter((memory) => memory.lane === 'episodic'),
    beliefs: memories.filter((memory) => memory.lane === 'semantic'
      || memory.lane === 'social'
      || memory.lane === 'procedural'),
    related,
    concerns: parseMetadata<ConcernView>(markdown, 'concern'),
    // MentalAct history remains replayable in DecisionFacts for audit, but it
    // is deliberately not recalled as evidence for the next MentalAct.
    deliberations: [],
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
    '# 当前未决', '', '_无_', '',
    '# 近期证据', '', '_无_', '',
    '# 已学结论', '', '_无_', '',
    '# 当前相关回忆', '', '_无_', '',
  ].join('\n');
}

/** Pure projection used by the writer and read-only historical adapters. */
export function projectPersonMindMarkdown(
  state: PersonMindState,
  person: PersonState,
  atMonth: number,
): string {
  const activeConcerns = (person.characterAgenda?.items ?? [])
    .filter((item) => item.status !== 'fulfilled' && item.status !== 'abandoned')
    .sort((left, right) => CONCERN_STATUS_PRIORITY[left.status] - CONCERN_STATUS_PRIORITY[right.status]
      || right.importance - left.importance
      || right.lastReviewedAtMonth - left.lastReviewedAtMonth
      || left.id.localeCompare(right.id))
    .slice(0, 3);
  const activeIntent = person.activeIntentId
    ? state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active')
    : undefined;
  const evidenceCandidates = retrieveAgentMemories(state, person, {
    atMonth,
    lanes: ['episodic'],
    laneLimits: { episodic: 16 },
    limit: 16,
    tokenBudget: 2_000,
  });
  const techniqueCandidates = retrieveAgentMemories(state, person, {
    atMonth,
    topicKeys: ['knowledge:technique'],
    lanes: ['semantic'],
    laneLimits: { semantic: 12 },
    limit: 12,
    tokenBudget: 1_400,
  });
  const resolvedNeedCandidates = retrieveAgentMemories(state, person, {
    atMonth,
    topicKeys: ['experience:need-resolution'],
    requireFocusMatch: true,
    lanes: ['semantic'],
    laneLimits: { semantic: 12 },
    limit: 12,
    tokenBudget: 1_400,
  }).sort((left, right) => right.lastExperiencedAtMonth - left.lastExperiencedAtMonth
    || right.salience - left.salience
    || left.id.localeCompare(right.id));
  const learnedCandidates = retrieveAgentMemories(state, person, {
    atMonth,
    lanes: ['semantic', 'social', 'procedural'],
    laneLimits: { semantic: 24, social: 8, procedural: 12 },
    limit: 48,
    tokenBudget: 4_000,
  });
  const episodes = compactMemoryLayer([...evidenceCandidates]
    .sort((left, right) => right.lastExperiencedAtMonth - left.lastExperiencedAtMonth
      || right.salience - left.salience
      || left.id.localeCompare(right.id)), 6);
  const beliefs = learnedConclusionLayer([
    ...techniqueCandidates,
    ...resolvedNeedCandidates,
    ...learnedCandidates,
  ]
    .filter((memory) => memory.topicKeys.includes('experience:need-resolution')
      || !episodes.some((episode) => sharesMemoryBasis(episode, memory))));
  const focus = concernMemoryFocus(state, person, activeConcerns, activeIntent);
  const related = focus ? compactMemoryLayer(retrieveAgentMemories(state, person, {
    atMonth,
    lanes: ['episodic', 'semantic', 'social', 'procedural'],
    laneLimits: { episodic: 4, semantic: 4, social: 4, procedural: 4 },
    personIds: focus.personIds,
    topicKeys: focus.topicKeys,
    sourceEventIds: focus.sourceEventIds,
    textTerms: focus.textTerms,
    requireFocusMatch: true,
    limit: 24,
    tokenBudget: 2_400,
  }).filter((memory) => usefulFocusedMemory(memory)
    && ![...episodes, ...beliefs].some((selected) => sharesMemoryBasis(selected, memory))), 4) : [];
  const concerns = activeConcerns
    .map((item): ConcernView => {
      const realityFeedback = concernRealityFeedback(item);
      return {
        id: item.id,
        aim: item.aim,
        theme: item.theme,
        importance: item.importance,
        status: item.status,
        sourceEventIds: [...item.sourceFactIds],
        ...(realityFeedback ? { realityFeedback } : {}),
      };
    });
  return renderPersonMindMarkdown({
    person,
    atMonth,
    episodes,
    beliefs,
    related,
    concerns,
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
