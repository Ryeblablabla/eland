import type { RepresentationInput } from '../domain/action';
import type { SpeechActView } from '../../societyContract';

function subjectOf(content: RepresentationInput, hasDetails: boolean): string | undefined {
  if (hasDetails || !('summary' in content)) return undefined;
  const subject = content.summary?.trim().replace(/\s+/gu, ' ').slice(0, 220);
  return subject || undefined;
}

/**
 * Keep the rule-authorized meaning as data. Natural-language summaries are used
 * only when an older representation has no structured fields of its own; they
 * are never treated as displayable dialogue.
 */
export function speechActFromRepresentation(content: RepresentationInput): SpeechActView {
  const { id: _id, kind, ...raw } = content;
  const { summary: _summary, ...structured } = raw as typeof raw & { summary?: string };
  const details = Object.fromEntries(
    Object.entries(structured).filter(([, value]) => value !== undefined),
  );
  const hasDetails = Object.keys(details).length > 0;
  const subject = subjectOf(content, hasDetails);
  return {
    version: 'speech-act-v1',
    kind,
    ...(subject ? { subject } : {}),
    ...(hasDetails ? { details } : {}),
  };
}
