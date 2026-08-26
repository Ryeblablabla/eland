import { CHARACTERS } from '../data/characters';

type PersonPortraitSource = {
  id: string;
  sex: 'female' | 'male';
  generation: number;
  /** Optional only for old/lightweight fixtures; authoritative people always provide it. */
  geneticParents?: readonly string[];
};

type PortraitAgeStage = {
  key: 'infant' | 'toddler' | 'child' | 'adolescent' | 'adult' | 'elder';
  label: string;
  head: number;
  shoulder: number;
  marker: number;
};

type DescendantAppearance = {
  skin: number;
  hair: number;
  cloth: number;
  hairStyle: 'crop' | 'tuft' | 'long' | 'side-swept';
  headShape: 'standard' | 'wide' | 'tall';
};

const PORTRAIT_BY_CHARACTER_ID = new Map(
  CHARACTERS.flatMap((character) => character.portrait ? [[character.id, character.portrait] as const] : []),
);

const SKIN_PALETTES = [0xf1c9a5, 0xd9aa7a, 0xb77b55, 0x7a4e38] as const;
const HAIR_PALETTES = [0x211b18, 0x3d2b22, 0x65452f, 0x8a6848] as const;
const CLOTH_PALETTES = [0x3f6380, 0x925a67, 0x55735d, 0x986d42, 0x6f5a86, 0x4f7876] as const;
const HAIR_STYLES = ['crop', 'tuft', 'long', 'side-swept'] as const;
const HEAD_SHAPES = ['standard', 'wide', 'tall'] as const;

const AGE_STAGES: readonly PortraitAgeStage[] = [
  { key: 'infant', label: '婴儿', head: 1.22, shoulder: 0.68, marker: 1 },
  { key: 'toddler', label: '幼儿', head: 1.14, shoulder: 0.78, marker: 2 },
  { key: 'child', label: '儿童', head: 1.08, shoulder: 0.88, marker: 3 },
  { key: 'adolescent', label: '青少年', head: 1.02, shoulder: 0.96, marker: 4 },
  { key: 'adult', label: '成年', head: 1, shoulder: 1, marker: 5 },
  { key: 'elder', label: '老年', head: 0.98, shoulder: 0.96, marker: 6 },
];

const GENERATED_PORTRAIT_CACHE = new Map<string, string>();
const GENERATED_PORTRAIT_CACHE_LIMIT = 2048;

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function portraitAgeStage(ageInMonths: number): PortraitAgeStage {
  const age = Math.max(0, Math.floor(ageInMonths));
  if (age < 12) return AGE_STAGES[0];
  if (age < 5 * 12) return AGE_STAGES[1];
  if (age < 12 * 12) return AGE_STAGES[2];
  if (age < 18 * 12) return AGE_STAGES[3];
  if (age < 60 * 12) return AGE_STAGES[4];
  return AGE_STAGES[5];
}

function appearanceForDescendant(person: PersonPortraitSource): DescendantAppearance {
  const identityHash = stableHash(`portrait-identity:${person.id}`);
  const parents = [...(person.geneticParents ?? [])].sort();
  const lineageHash = parents.length
    ? stableHash(`portrait-lineage:${parents.join('|')}`)
    : identityHash;
  return {
    skin: SKIN_PALETTES[lineageHash % SKIN_PALETTES.length],
    hair: HAIR_PALETTES[(lineageHash >>> 4) % HAIR_PALETTES.length],
    cloth: CLOTH_PALETTES[(identityHash >>> 6) % CLOTH_PALETTES.length],
    hairStyle: HAIR_STYLES[(identityHash >>> 10) % HAIR_STYLES.length],
    headShape: HEAD_SHAPES[(identityHash >>> 14) % HEAD_SHAPES.length],
  };
}

function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function descendantPortraitSvg(appearance: DescendantAppearance, stage: PortraitAgeStage): string {
  const wide = appearance.headShape === 'wide';
  const tall = appearance.headShape === 'tall';
  const headWidth = 41 * stage.head * (wide ? 1.08 : tall ? 0.93 : 1);
  const headHeight = 48 * stage.head * (wide ? 0.95 : tall ? 1.08 : 1);
  const headX = 48 - headWidth / 2;
  const headY = 49 - headHeight / 2;
  const shoulderWidth = 72 * stage.shoulder;
  const shoulderX = 48 - shoulderWidth / 2;
  const eyeOffset = headWidth * 0.2;
  const eyeY = headY + headHeight * 0.48;
  const skin = cssHex(appearance.skin);
  const hair = stage.key === 'elder' ? '#b9bec4' : cssHex(appearance.hair);
  const cloth = cssHex(appearance.cloth);
  const ageTicks = Array.from(
    { length: stage.marker },
    (_, index) => `<rect x="${18 + index * 7}" y="101" width="4" height="2" rx="1" fill="#d3ad66"/>`,
  ).join('');
  const hairShape = stage.key === 'infant'
    ? `<path d="M${headX + 9} ${headY + 10} Q48 ${headY - 1} ${headX + headWidth - 9} ${headY + 10}" fill="none" stroke="${hair}" stroke-width="4" stroke-linecap="round"/>`
    : appearance.hairStyle === 'long'
      ? `<path d="M${headX + 2} ${headY + 18} Q48 ${headY - 9} ${headX + headWidth - 2} ${headY + 18} V${headY + headHeight - 2} H${headX + headWidth - 8} V${headY + 15} H${headX + 8} V${headY + headHeight - 2} H${headX + 2}Z" fill="${hair}"/>`
      : appearance.hairStyle === 'tuft'
        ? `<path d="M${headX + 4} ${headY + 17} Q48 ${headY - 8} ${headX + headWidth - 4} ${headY + 17} L${headX + headWidth - 7} ${headY + 9} L${headX + headWidth * 0.56} ${headY + 5} L${headX + headWidth * 0.47} ${headY - 3} L${headX + headWidth * 0.38} ${headY + 6} L${headX + 8} ${headY + 10}Z" fill="${hair}"/>`
        : appearance.hairStyle === 'side-swept'
          ? `<path d="M${headX + 3} ${headY + 19} Q${headX + headWidth * 0.42} ${headY - 9} ${headX + headWidth - 3} ${headY + 12} Q${headX + headWidth * 0.58} ${headY + 8} ${headX + headWidth * 0.36} ${headY + 23}Z" fill="${hair}"/>`
          : `<path d="M${headX + 3} ${headY + 18} Q48 ${headY - 7} ${headX + headWidth - 3} ${headY + 18} L${headX + headWidth - 5} ${headY + 9} L${headX + 7} ${headY + 9}Z" fill="${hair}"/>`;
  const body = stage.key === 'infant'
    ? `<path d="M31 70 Q48 61 65 70 L61 99 H35Z" fill="${cloth}"/><path d="M35 80 L61 92 M61 80 L35 92" stroke="#d6b77d" stroke-width="3" opacity=".72"/>`
    : `<path d="M${shoulderX} 101 Q${shoulderX + 3} 73 48 69 Q${shoulderX + shoulderWidth - 3} 73 ${shoulderX + shoulderWidth} 101Z" fill="${cloth}"/><path d="M34 73 Q48 81 62 73" fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-width="3"/>`;
  const ageLines = stage.key === 'elder'
    ? `<path d="M${48 - eyeOffset - 7} ${eyeY + 9}h10 M${48 + eyeOffset - 3} ${eyeY + 9}h10 M40 ${headY + headHeight - 8}q8 4 16 0" fill="none" stroke="#9b6f5d" stroke-width="1" opacity=".72"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 112" role="img" aria-label="${stage.label}头像">
    <rect width="96" height="112" rx="10" fill="#1b2228"/>
    <rect x="4" y="4" width="88" height="104" rx="8" fill="#263139" stroke="#69777f" stroke-width="1"/>
    ${body}
    <rect x="43" y="62" width="10" height="13" rx="4" fill="${skin}"/>
    <ellipse cx="${headX - 1}" cy="${headY + headHeight * 0.54}" rx="4" ry="7" fill="${skin}"/>
    <ellipse cx="${headX + headWidth + 1}" cy="${headY + headHeight * 0.54}" rx="4" ry="7" fill="${skin}"/>
    <rect x="${headX}" y="${headY}" width="${headWidth}" height="${headHeight}" rx="${Math.min(14, headWidth * 0.32)}" fill="${skin}"/>
    ${hairShape}
    <ellipse cx="${48 - eyeOffset}" cy="${eyeY}" rx="2.1" ry="2.4" fill="#201c19"/>
    <ellipse cx="${48 + eyeOffset}" cy="${eyeY}" rx="2.1" ry="2.4" fill="#201c19"/>
    <path d="M48 ${eyeY + 3}v7" stroke="#9b6f5d" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M42 ${headY + headHeight * 0.76} Q48 ${headY + headHeight * 0.81} 54 ${headY + headHeight * 0.76}" fill="none" stroke="#865b4d" stroke-width="1.7" stroke-linecap="round"/>
    ${ageLines}${ageTicks}
  </svg>`;
}

function cacheGeneratedPortrait(key: string, portrait: string): string {
  if (GENERATED_PORTRAIT_CACHE.size >= GENERATED_PORTRAIT_CACHE_LIMIT) {
    const oldestKey = GENERATED_PORTRAIT_CACHE.keys().next().value;
    if (oldestKey !== undefined) GENERATED_PORTRAIT_CACHE.delete(oldestKey);
  }
  GENERATED_PORTRAIT_CACHE.set(key, portrait);
  return portrait;
}

/**
 * 头像是只读装饰投影：初代沿用档案头像；后代由人物和亲缘 ID 重建固定外观，
 * 当前年龄只选择婴儿到老年的表现版本，不会写回人物状态或影响模拟规则。
 */
export function portraitForPerson(person: PersonPortraitSource, ageInMonths = 18 * 12): string | undefined {
  const archivePortrait = PORTRAIT_BY_CHARACTER_ID.get(person.id);
  if (person.generation === 0 && archivePortrait) return archivePortrait;

  const stage = portraitAgeStage(ageInMonths);
  const parents = [...(person.geneticParents ?? [])].sort();
  const cacheKey = JSON.stringify([person.id, parents, stage.key]);
  const cached = GENERATED_PORTRAIT_CACHE.get(cacheKey);
  if (cached) return cached;

  const svg = descendantPortraitSvg(appearanceForDescendant(person), stage);
  return cacheGeneratedPortrait(cacheKey, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}
