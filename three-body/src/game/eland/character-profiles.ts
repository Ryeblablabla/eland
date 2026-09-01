import { CHARACTERS, type CharacterProfile as ArchiveCharacter } from "../../data/characters";
import type { BiologicalSex } from './population';
import { inferFamilyName, type NamingTradition } from './naming';
import { compileFounderPersonaPrior, type FounderPersonaPrior } from './founder-persona';
import type { PrototypeReactionPattern } from './domain/person';

export interface CharacterProfile {
  id: string;
  name: string;
  sex: BiologicalSex;
  namingTradition: NamingTradition;
  familyName: string;
  color: string;
  description: string;
  personalitySummary: string;
  personalityPrior: FounderPersonaPrior['personalityCenter'];
  motivePrior: FounderPersonaPrior['motiveCenter'];
  reactionPatterns: PrototypeReactionPattern[];
}

// ---------------------------------------------------------------------------
// 引擎抽人池 = 101 人档案库（src/data/characters.ts）。
// 档案性格摘要编译为有界创世人格先验与反应范式；外貌仍只用于展示。
// 颜色由档案 id 哈希确定性给出；权威年龄由人口领域直接以月生成。
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

/** 档案库中未列出的现有角色均为男性；这张表记录女性角色的真实性别。 */
const FEMALE_CHARACTER_IDS = new Set([
  'li-qingzhao', 'wuzetian', 'cai-wenji', 'wang-zhaojun', 'shangguan-waner', 'yang-guifei', 'liu-rushi',
  'marie-curie', 'ada-lovelace', 'joan-of-arc',
  'nuwa', 'change', 'jingwei', 'athena', 'medusa', 'aphrodite', 'pandora', 'artemis', 'persephone', 'freyja', 'bai-suzhen', 'zhinu',
  'artoria-pendragon', 'zhaotianli', 'zhentianyuan', 'potianfeng', 'cangtianying', 'usagi-tsukino', 'ai-haibara', 'ran-mouri',
  'sakura-kinomoto', 'sakura-haruno', 'hinata-hyuga', 'nami', 'nezuko-kamado', 'chihiro-ogino', 'nausicaa', 'sophie-hatter',
  'san', 'violet-evergarden', 'rei-ayanami', 'asuka-langley', 'hermione-granger', 'jane-eyre', 'elizabeth-bennet', 'anne-shirley',
  'heidi', 'dorothy-gale', 'matilda-wormwood', 'alice',
]);

const EASTERN_FICTION_IDS = new Set([
  'zhaotianli', 'zhentianyuan', 'potianfeng', 'cangtianying', 'usagi-tsukino', 'ai-haibara', 'ran-mouri',
  'sakura-kinomoto', 'sakura-haruno', 'hinata-hyuga', 'nami', 'nezuko-kamado', 'chihiro-ogino', 'nausicaa', 'san', 'rei-ayanami',
]);

const FAMILY_NAME_OVERRIDES: Record<string, string> = {
  laozi: '李',
  xuanzang: '陈',
  qinshihuang: '嬴',
  genghiskhan: '孛儿只斤',
  michelangelo: '博那罗蒂',
  augustus: '屋大维',
  napoleon: '波拿巴',
  pangu: '盘',
  nezha: '李',
  'usagi-tsukino': '月野',
  'ai-haibara': '灰原',
  'ran-mouri': '毛利',
  'sakura-kinomoto': '木之本',
  'sakura-haruno': '春野',
  'hinata-hyuga': '日向',
  'nezuko-kamado': '灶门',
  'chihiro-ogino': '荻野',
  'rei-ayanami': '绫波',
  'asuka-langley': '兰格雷',
};

function namingTraditionFor(entry: ArchiveCharacter): NamingTradition {
  if (entry.category === '中国历史' || entry.era === '中国神话' || entry.era === '中国传说' || EASTERN_FICTION_IDS.has(entry.id)) return 'eastern';
  return 'western';
}

function archiveToProfile(entry: ArchiveCharacter): CharacterProfile {
  const hash = archiveHash(entry.id);
  const namingTradition = namingTraditionFor(entry);
  const persona = compileFounderPersonaPrior(entry.id, entry.traits);
  return {
    id: entry.id,
    name: entry.name,
    sex: FEMALE_CHARACTER_IDS.has(entry.id) ? 'female' : 'male',
    namingTradition,
    familyName: FAMILY_NAME_OVERRIDES[entry.id] ?? inferFamilyName(entry.name, namingTradition),
    color: `hsl(${hash % 360}, ${24 + ((hash >>> 4) % 12)}%, ${36 + ((hash >>> 9) % 12)}%)`,
    description: `${entry.traits} ${entry.appearance}`,
    personalitySummary: entry.traits,
    personalityPrior: persona.personalityCenter,
    motivePrior: persona.motiveCenter,
    reactionPatterns: persona.reactionPatterns,
  };
}

/**
 * 引擎抽人池（101 位）：档案自然语言只编译创世 temperament / motive prior，
 * 不授予能力或经历。身体缺口、状态、关系与局部事实仍产生动态动机；后代只走
 * 父母人格继承和自身经历。每局按种子抽取 5–12 位，或显式指定至多 12 位。
 */
export const CHARACTER_PROFILES: CharacterProfile[] = CHARACTERS.map(archiveToProfile);
