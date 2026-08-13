import { CHARACTERS, type CharacterProfile as ArchiveCharacter } from "../../data/characters";

export interface CharacterProfile {
  id: string;
  name: string;
  color: string;
  ageYears: number;
  description: string;
}

// ---------------------------------------------------------------------------
// 引擎抽人池 = 59 人档案库（src/data/characters.ts）。
// 档案描述由特质 + 外貌生成，供开局时推导马斯洛五层人格；
// 颜色与初始年龄由档案 id 哈希确定性给出。
// ---------------------------------------------------------------------------

function archiveHash(key: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  return value >>> 0;
}

function archiveToProfile(entry: ArchiveCharacter): CharacterProfile {
  const hash = archiveHash(entry.id);
  return {
    id: entry.id,
    name: entry.name,
    color: `hsl(${hash % 360}, ${24 + ((hash >>> 4) % 12)}%, ${36 + ((hash >>> 9) % 12)}%)`,
    ageYears: 10 + (hash % 21), // 先民初始年龄 10~30 岁，年轻时开局避免过早凋零
    description: `${entry.traits} ${entry.appearance}`,
  };
}

/**
 * 引擎抽人池（59 位）：档案只写自然语言描述；马斯洛五层人格由模拟器在开局时
 * 从 description 推导。引擎每局按种子随机抽取 5~10 位入局，或由开局配置指定 characterIds。
 */
export const CHARACTER_PROFILES: CharacterProfile[] = CHARACTERS.map(archiveToProfile);
