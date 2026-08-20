import type { BiologicalSex } from './population';

export type NamingTradition = 'eastern' | 'western';

export interface NamingIdentity {
  familyName: string;
  namingTradition: NamingTradition;
}

export interface NamedParent {
  name: string;
  familyName?: string;
  namingTradition?: NamingTradition;
}

export interface AcceptedNewbornName extends NamingIdentity {
  givenName: string;
  name: string;
}

const EASTERN_COMPOUND_SURNAMES = [
  '孛儿只斤', '木之本', '欧阳', '司马', '上官', '诸葛', '夏侯', '东方', '皇甫', '尉迟',
  '公孙', '慕容', '长孙', '宇文', '司徒', '端木', '月野', '灰原', '毛利', '春野',
  '日向', '灶门', '荻野', '绫波',
] as const;

const EASTERN_GIVEN_NAMES: Record<BiologicalSex, readonly string[]> = {
  male: [
    '子安', '景行', '云舟', '亦辰', '修远', '明哲', '承宇', '怀瑾',
    '知远', '嘉树', '凌川', '泽言', '远山', '清越', '玄同', '允和',
    '庭轩', '少衡', '伯言', '松年', '星野', '弘毅', '昭明', '正则',
    '长风', '景曜', '守一', '元晖', '安澜', '云起', '朝宗', '叙白',
  ],
  female: [
    '若兰', '清禾', '婉宁', '知夏', '昭月', '静姝', '云舒', '灵犀',
    '令仪', '含章', '采薇', '疏影', '望舒', '知微', '南星', '嘉宁',
    '明昭', '芷若', '星遥', '瑾瑜', '若水', '思齐', '安歌', '朝云',
    '映雪', '书昀', '玉衡', '兰因', '和光', '青梧', '月白', '清晏',
  ],
};

const WESTERN_GIVEN_NAMES: Record<BiologicalSex, readonly string[]> = {
  male: [
    '亚瑟', '威廉', '亚历山大', '朱利安', '西奥多', '费利克斯', '奥利弗', '卢卡斯',
    '亨利', '塞缪尔', '维克多', '埃利奥特', '莱昂', '加布里埃尔', '阿德里安', '诺亚',
    '本杰明', '丹尼尔', '马库斯', '尼古拉斯', '西蒙', '托马斯', '埃德蒙', '安东尼',
    '乔纳森', '路易斯', '罗兰', '伊萨克', '塞巴斯蒂安', '马丁', '奥斯卡', '乔治',
  ],
  female: [
    '索菲娅', '埃莉诺', '克拉拉', '奥罗拉', '阿米莉亚', '露西', '伊莎贝尔', '塞西莉亚',
    '艾丽丝', '维多利亚', '朱莉娅', '艾琳', '玛格丽特', '娜塔莉', '奥黛丽', '艾玛',
    '莉迪亚', '海伦娜', '黛安娜', '伊芙琳', '薇拉', '西尔维娅', '劳拉', '艾达',
    '玛蒂尔达', '罗莎琳德', '露易丝', '安娜', '凯瑟琳', '贝娅特丽丝', '弗洛拉', '格蕾丝',
  ],
};

function fraction(seed: number, key: string): number {
  let value = (Math.trunc(seed) ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

export function inferFamilyName(name: string, namingTradition: NamingTradition): string {
  const normalized = name.trim();
  if (!normalized) return '无名';
  if (namingTradition === 'western') {
    const parts = normalized.split(/[·\s]+/).filter(Boolean);
    return parts.at(-1) ?? normalized;
  }
  return EASTERN_COMPOUND_SURNAMES.find((surname) => normalized.startsWith(surname)) ?? Array.from(normalized)[0] ?? '无名';
}

export function inferNamingIdentity(parent: NamedParent): NamingIdentity {
  const namingTradition = parent.namingTradition ?? (parent.name.includes('·') ? 'western' : 'eastern');
  return {
    namingTradition,
    familyName: parent.familyName?.trim() || inferFamilyName(parent.name, namingTradition),
  };
}

/** 同一世界种子下可回放的随机姓名；东西方都继承父姓，仅姓名顺序不同。 */
export function createNewbornName(
  seed: number,
  childId: string,
  sex: BiologicalSex,
  father: NamedParent,
  existingNames: Iterable<string> = [],
): NamingIdentity & { name: string } {
  const identity = inferNamingIdentity(father);
  const pool = identity.namingTradition === 'eastern' ? EASTERN_GIVEN_NAMES[sex] : WESTERN_GIVEN_NAMES[sex];
  const occupied = new Set(existingNames);
  const start = Math.floor(fraction(seed, `newborn-name:${childId}`) * pool.length);
  let name = '';
  for (let offset = 0; offset < pool.length; offset += 1) {
    const givenName = pool[(start + offset) % pool.length];
    const candidate = identity.namingTradition === 'eastern'
      ? `${identity.familyName}${givenName}`
      : `${givenName}·${identity.familyName}`;
    if (!occupied.has(candidate)) {
      name = candidate;
      break;
    }
  }
  if (!name) {
    const givenName = pool[start];
    name = identity.namingTradition === 'eastern'
      ? `${identity.familyName}${givenName}`
      : `${givenName}·${identity.familyName}`;
  }
  return { ...identity, name };
}

const INVALID_GIVEN_NAMES = new Set(['无名', '未知', '孩子', '婴儿', '宝宝', '后代']);

/**
 * Validate a model-proposed given name without letting the model choose the
 * inherited family name, ordering convention, or uniqueness rule.
 */
export function acceptProposedNewbornGivenName(
  proposedGivenName: string,
  identity: NamingIdentity,
  existingNames: Iterable<string> = [],
): AcceptedNewbornName | null {
  const givenName = proposedGivenName.normalize('NFKC').trim();
  const maximumLength = identity.namingTradition === 'eastern' ? 3 : 8;
  const characters = Array.from(givenName);
  if (!characters.length || characters.length > maximumLength) return null;
  if (!/^\p{Script=Han}+$/u.test(givenName) || INVALID_GIVEN_NAMES.has(givenName)) return null;
  if (identity.namingTradition === 'eastern' && givenName.startsWith(identity.familyName)) return null;
  const name = identity.namingTradition === 'eastern'
    ? `${identity.familyName}${givenName}`
    : `${givenName}·${identity.familyName}`;
  if (new Set(existingNames).has(name)) return null;
  return { ...identity, givenName, name };
}
