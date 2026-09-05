import type { RepresentationInput } from './action';

/**
 * Plan supplies the speaker's intended meaning. The actual utterance remains
 * the person's frozen words; lexical similarity cannot approve or erase a
 * social act. Hearing, interpretation, and any response are separate events.
 */
export function withSpokenUtterance(text: string, meaning: RepresentationInput): RepresentationInput {
  return { ...meaning, summary: text };
}
