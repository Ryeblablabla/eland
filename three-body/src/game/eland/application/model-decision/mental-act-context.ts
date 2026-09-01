import {
  buildCompactDecisionRequestContext,
  type CompactDecisionRequestContext,
} from './compact-context';
import {
  buildCharacterAgendaProbeCandidates,
  type DecisionProbeHandleMap,
} from './capability-handles';
import type { DecisionRequestContext } from './decision-context';

export interface MentalActRequestContext {
  schemaVersion: 'mental-act-context-v1';
  person: Record<string, unknown>;
  situation: Record<string, unknown>;
  mind: {
    markdown: string;
    signals: unknown[];
  };
  current: Record<string, unknown>;
  recentDialogue: unknown[];
  visible: Record<string, unknown>;
  availableSteps: Array<Record<string, unknown> & { handle: string }>;
  continuations: Array<Record<string, unknown> & { handle: string }>;
  possibleExperiments: ReturnType<typeof buildCharacterAgendaProbeCandidates>;
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Remove compiler metadata and labels that are not valid request handles. */
function modelVisibleMindMarkdown(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^<!-- eland-(?:memory|concern|deliberation) .+ -->\n?/gmu, '')
    .replace(/^- \[m(\d+)\] /gmu, (_line, raw: string) => Number(raw) <= 6 ? `- [m${raw}] ` : '- ')
    .replace(/^- \[g(\d+)\] /gmu, (_line, raw: string) => Number(raw) <= 4 ? `- [g${raw}] ` : '- ')
    .replace(/^- \[d\d+\] /gmu, '- ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Compatibility projection from the existing persisted state into the new
 * agent contract. Legacy arrays remain a codec concern; the model sees one
 * mind and a set of merely current, fallible next-step affordances.
 */
export function buildMentalActRequestContext(
  context: DecisionRequestContext,
  handles: DecisionProbeHandleMap,
): MentalActRequestContext {
  const compact: CompactDecisionRequestContext = buildCompactDecisionRequestContext(context, handles);
  const person = object(compact.person);
  const commitments = object(compact.commitments);
  const cognition = object(compact.cognition);
  const {
    memories: _memories,
    knowledge: _knowledge,
    recentMentalActs: _recentMentalActs,
    mindMarkdown,
    ...identity
  } = person;
  const { characterAgenda: _characterAgenda, ...current } = commitments;
  return {
    schemaVersion: 'mental-act-context-v1',
    person: identity,
    situation: compact.situation,
    mind: {
      markdown: modelVisibleMindMarkdown(mindMarkdown),
      signals: rows(cognition.needs),
    },
    current,
    recentDialogue: compact.recentDialogue,
    visible: compact.visible,
    availableSteps: compact.options.map(({ id, reason: _reason, ...step }) => ({
      handle: id,
      ...step,
    })),
    continuations: compact.followUpOptions.map(({ id, reason: _reason, ...step }) => ({
      handle: id,
      ...step,
    })),
    possibleExperiments: buildCharacterAgendaProbeCandidates(context, handles),
  };
}
