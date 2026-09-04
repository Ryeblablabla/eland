import type { RepresentationInput } from './action';

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s，。；：、？！“”‘’"'（）()《》〈〉—…·,.!?:;-]/gu, '');
}

function grams(value: string): Set<string> {
  const characters = [...normalizedText(value)];
  if (characters.length < 2) return new Set(characters);
  return new Set(characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`));
}

function summaryOverlap(text: string, summary: string | undefined): number {
  if (!summary?.trim()) return 0;
  const spoken = grams(text);
  const expected = grams(summary);
  if (!spoken.size || !expected.size) return 0;
  let shared = 0;
  for (const gram of expected) if (spoken.has(gram)) shared += 1;
  return shared / Math.min(spoken.size, expected.size);
}

function carriesWorldEffect(meaning: RepresentationInput): boolean {
  if (meaning.kind !== 'claim') return true;
  return Boolean(meaning.factId || meaning.projectKnowledgeResponse);
}

/**
 * Structured communication may change knowledge, agreements, permissions or
 * predictions only when the actual broadcast expresses that meaning. Ordinary
 * conversation remains free-form and is never subjected to this check.
 */
export function spokenTextSupportsMeaning(text: string, meaning: RepresentationInput): boolean {
  if (!carriesWorldEffect(meaning)) return true;
  const overlap = summaryOverlap(text, meaning.summary);
  if (meaning.kind === 'claim') return overlap >= 0.3;
  if (meaning.kind === 'prediction') {
    return /预言|预测|纪元|第\s*\d+\s*月|将会|将进入/u.test(text) && overlap >= 0.16;
  }
  if (meaning.kind === 'request') {
    return /请|请求|能否|能不能|可不可以|希望.*帮|需要.*帮/u.test(text) && overlap >= 0.14;
  }
  if (meaning.kind === 'offer') {
    return /我愿意|我可以|我来|提议|愿不愿|要不要|我们可以/u.test(text) && overlap >= 0.14;
  }
  if (meaning.kind === 'accept') return /同意|接受|愿意|答应|可以|好[，。！]?我/u.test(text);
  if (meaning.kind === 'reject') return /不同意|拒绝|不愿意|不能答应|不接受/u.test(text);
  return /撤回|取消|不再|结束|退出/u.test(text) && overlap >= 0.12;
}

