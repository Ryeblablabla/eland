import { CHARACTERS } from '../data/characters';
import { CHARACTER_PROFILES } from './eland/character-profiles';

type PersonPortraitSource = {
  id: string;
  sex: 'female' | 'male';
  generation: number;
};

const PORTRAIT_BY_CHARACTER_ID = new Map(
  CHARACTERS.flatMap((character) => character.portrait ? [[character.id, character.portrait] as const] : []),
);

const PORTRAIT_POOLS: Record<PersonPortraitSource['sex'], string[]> = {
  female: CHARACTER_PROFILES.flatMap((profile) => {
    const portrait = PORTRAIT_BY_CHARACTER_ID.get(profile.id);
    return profile.sex === 'female' && portrait ? [portrait] : [];
  }),
  male: CHARACTER_PROFILES.flatMap((profile) => {
    const portrait = PORTRAIT_BY_CHARACTER_ID.get(profile.id);
    return profile.sex === 'male' && portrait ? [portrait] : [];
  }),
};

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 头像仅是可重建的装饰投影：初代沿用自身档案头像，后代按人物 ID
 * 从真实性别对应的头像池中稳定抽取。它不会写回人物状态或影响规则结果。
 */
export function portraitForPerson(person: PersonPortraitSource): string | undefined {
  const archivePortrait = PORTRAIT_BY_CHARACTER_ID.get(person.id);
  if (person.generation === 0 && archivePortrait) return archivePortrait;

  const pool = PORTRAIT_POOLS[person.sex];
  if (!pool.length) return archivePortrait;
  return pool[stableHash(`portrait:${person.sex}:${person.id}`) % pool.length];
}
