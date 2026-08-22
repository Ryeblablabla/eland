export const CIVILIZATION_POEM_STYLES = [
  {
    id: 'classic-refrain',
    name: '四言重章',
    lineage: '《诗经》',
    description: '短句、复沓与清晰事实，适合历史较短、事件集中的文明。',
    prompt: '参考《诗经》的四言节奏与重章复沓，以少量真实事实形成可记忆的短章；不得套用原句或堆砌典故。',
  },
  {
    id: 'pastoral-chronicle',
    name: '田园纪事',
    lineage: '陶渊明',
    description: '落到材料、劳动与共同生活，适合生产和定居事实丰富的文明。',
    prompt: '参考陶渊明田园诗平淡准确的观察，以材料、劳动和共同生活的真实细节推进；不虚构季节、景物或生活事实。',
  },
  {
    id: 'historical-long-song',
    name: '诗史长歌',
    lineage: '杜甫',
    description: '按时间与因果记录人物处境，适合漫长、密集或灾难性的文明史。',
    prompt: '参考杜甫叙事诗的编年、因果与普通人视角，先写真实事件再形成情感；不得仿写名句或添加战争、饥荒等无来源事实。',
  },
  {
    id: 'homeric-catalogue',
    name: '古代名录史诗',
    lineage: '荷马史诗',
    description: '用名字、行动链和代际次序形成史诗，适合人物与迁徙丰富的文明。',
    prompt: '参考荷马史诗的长句、名录、重复称谓与行动链，只列举 facts 中存在的人物和事件；不得引入神祇、战争、船队或英雄事迹。',
  },
  {
    id: 'rubai-quatrain',
    name: '鲁拜短章',
    lineage: '奥马尔·海亚姆',
    description: '以四行短章追问时间与有限生命，适合短暂或突然结束的文明。',
    prompt: '参考波斯鲁拜四行诗的凝练结构，用时间、星辰与有限生命形成追问；分成若干四行诗节，不采用任何现成译文。',
  },
  {
    id: 'free-verse-catalogue',
    name: '自由诗名录',
    lineage: '沃尔特·惠特曼',
    description: '以自由长句列举人物、技艺与里程碑，适合成熟而内容丰盛的文明。',
    prompt: '参考惠特曼自由诗的长句、并列、呼唤和个体名录，让每个结果连接到真实人物与行动；控制篇幅，不写空泛赞歌。',
  },
] as const;

export type CivilizationPoemStyleId = typeof CIVILIZATION_POEM_STYLES[number]['id'];
export type CivilizationEndingKind = 'destroyed' | 'boundary' | 'milestones' | 'concluded';

export interface CivilizationRequiemLine {
  text: string;
}

export interface CivilizationRequiem {
  schemaVersion: 4;
  id: string;
  civilizationId: number;
  branchId: string;
  endedAtMonth: number;
  endingKind: CivilizationEndingKind;
  styleId: CivilizationPoemStyleId;
  styleName: string;
  title: string;
  summary: string;
  lines: CivilizationRequiemLine[];
  source: 'model' | 'local-fallback';
  sourceEventIds: string[];
  generatedAt: string;
  model?: { endpointId: string; protocol: string; name: string };
}

export function isCivilizationPoemStyleId(value: unknown): value is CivilizationPoemStyleId {
  return CIVILIZATION_POEM_STYLES.some((style) => style.id === value);
}

export function civilizationPoemStyle(id: CivilizationPoemStyleId) {
  return CIVILIZATION_POEM_STYLES.find((style) => style.id === id) ?? CIVILIZATION_POEM_STYLES[0];
}

export function civilizationRequiemKey(input: {
  civilizationId: number;
  branchId: string;
  endedAtMonth: number;
}): string {
  return `requiem-v4:${input.civilizationId}:${input.branchId}:${input.endedAtMonth}`;
}
