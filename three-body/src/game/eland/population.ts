/**
 * 人口生命周期规则。
 *
 * 姓名只负责显示；生理性别、寿命和后代特征均由文明种子与人物 id
 * 独立生成，避免把历史人物姓名当成性别规则。
 */

export type BiologicalSex = 'female' | 'male';

export interface PregnancyState {
  fatherId: string;
  conceivedTick: number;
  dueTick: number;
  conceptionEventId?: string;
  barrierId?: string;
  supportEventIds?: string[];
  supportAgentIds?: string[];
}

export interface LineageState {
  generation: number;
  motherId?: string;
  fatherId?: string;
}

export interface SocialStanding {
  respect: number;
  correctPredictions: number;
  failedPredictions: number;
  careTrust?: number;
}

export const ADULT_WORK_AGE = 12;
export const ELDER_AGE = 60;
export const TRUSTED_PREDICTOR_RESPECT = 65;

function hashKey(seed: number, key: string): number {
  let value = (Math.trunc(seed) ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return value >>> 0;
}

export function deterministicFraction(seed: number, key: string): number {
  return hashKey(seed, key) / 0x100000000;
}

export function createBiologicalSex(seed: number, agentId: string): BiologicalSex {
  return deterministicFraction(seed, `sex:${agentId}`) < 0.5 ? 'female' : 'male';
}

const NEWBORN_SURNAMES = [
  '安', '白', '蔡', '曹', '陈', '程', '崔', '戴', '丁', '杜', '方', '冯', '高', '顾', '韩', '何',
  '贺', '胡', '黄', '江', '蒋', '孔', '林', '刘', '陆', '罗', '孟', '莫', '潘', '秦', '任', '沈',
  '宋', '苏', '孙', '唐', '陶', '田', '汪', '王', '魏', '吴', '夏', '萧', '谢', '徐', '许', '杨',
  '叶', '袁', '张', '赵', '郑', '周', '朱',
] as const;

const NEWBORN_GIVEN_NAMES = [
  '安宁', '白榆', '朝雨', '承光', '春和', '初晴', '川柏', '丹枫', '冬青', '方舟', '归云', '海若',
  '含章', '和光', '怀川', '嘉禾', '景明', '静川', '兰舟', '乐川', '临风', '明澈', '明溪', '南星',
  '宁远', '青禾', '青岚', '清和', '清越', '秋实', '若谷', '山月', '时雨', '疏桐', '望舒', '闻溪',
  '星野', '修竹', '言蹊', '砚秋', '遥川', '一川', '以宁', '亦安', '映川', '知白', '知夏', '知行',
  '知遥', '知遇', '子衿', '子墨', '云帆', '云舒', '长风', '昭野',
] as const;

/**
 * 为自然出生者生成可回放的随机姓名。相同文明种子和人物 id 始终得到
 * 相同结果；发生重名时换一组组合，不把出生年份或数组下标暴露给玩家。
 */
export function createNewbornName(seed: number, agentId: string, existingNames: Iterable<string> = []): string {
  const used = new Set(existingNames);
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const surnameIndex = Math.floor(deterministicFraction(seed, `newborn-surname:${agentId}:${attempt}`) * NEWBORN_SURNAMES.length);
    const givenIndex = Math.floor(deterministicFraction(seed, `newborn-given:${agentId}:${attempt}`) * NEWBORN_GIVEN_NAMES.length);
    const candidate = `${NEWBORN_SURNAMES[surnameIndex]}${NEWBORN_GIVEN_NAMES[givenIndex]}`;
    if (!used.has(candidate)) return candidate;
  }
  // 组合池远大于单局人口上限；这里只为损坏或人工构造的超大存档兜底。
  return `未名者${used.size + 1}`;
}

/** 文明开局先民的年龄，包含 0 和 20 岁。自然出生者始终为 0 岁。 */
export function createFounderAge(seed: number, agentId: string): number {
  return Math.floor(deterministicFraction(seed, `founder-age:${agentId}`) * 21);
}

/** 个体寿命均匀分布在 60～100 岁，期望值约 80 岁。 */
export function createLifespan(seed: number, agentId: string, currentAge = 0): number {
  const sampled = 60 + Math.floor(deterministicFraction(seed, `lifespan:${agentId}`) * 41);
  return Math.min(100, Math.max(sampled, Math.ceil(currentAge) + 3));
}

export function isFertileAge(sex: BiologicalSex, ageYears: number): boolean {
  return sex === 'female'
    ? ageYears >= 20 && ageYears <= 42
    : ageYears >= 20 && ageYears <= 55;
}

export function predictionRespect(current: number, confirmed: boolean): number {
  return Math.max(0, Math.min(100, current + (confirmed ? 18 : -22)));
}
