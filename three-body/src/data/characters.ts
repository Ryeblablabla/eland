export type CharacterCategory = '中国历史' | '世界历史' | '神话人物';

export interface CharacterProfile {
  id: string;
  name: string;
  category: CharacterCategory;
  era: string;
  appearance: string;
  traits: string;
  portrait: string | null;
}

/**
 * 人类文明人物档案：用于三体游戏中的人物原型选择与资料面板。
 * 画像统一为 public/portraits 下的 3:4 史诗厚涂头像。
 */
export const CHARACTERS: CharacterProfile[] = [
  { id: 'kongzi', name: '孔子', category: '中国历史', era: '春秋', appearance: '长须，宽袍，神情温和庄重。', traits: '仁厚、克制、重视教育。', portrait: '/portraits/kongzi.png' },
  { id: 'laozi', name: '老子', category: '中国历史', era: '春秋', appearance: '白须，道袍朴素，目光沉静。', traits: '淡泊、深邃、顺应自然。', portrait: '/portraits/laozi.png' },
  { id: 'mozi', name: '墨子', category: '中国历史', era: '战国', appearance: '粗布短衣，面容朴实，目光坚定。', traits: '务实、平等、坚韧。', portrait: '/portraits/mozi.png' },
  { id: 'mengzi', name: '孟子', category: '中国历史', era: '战国', appearance: '儒生长袍，神情严肃，姿态端正。', traits: '正直、善辩、坚持原则。', portrait: '/portraits/mengzi.png' },
  { id: 'sun-wu', name: '孙武', category: '中国历史', era: '春秋', appearance: '轻甲军服，身姿挺拔，手持竹简。', traits: '冷静、谨慎、善于谋划。', portrait: '/portraits/sun-wu.png' },
  { id: 'zhugeliang', name: '诸葛亮', category: '中国历史', era: '三国', appearance: '羽扇纶巾，长袍，神情从容。', traits: '智慧、忠诚、责任感强。', portrait: '/portraits/zhugeliang.png' },
  { id: 'quyuan', name: '屈原', category: '中国历史', era: '战国', appearance: '长袍佩剑，长发，神情忧郁。', traits: '高洁、执着、富有理想。', portrait: '/portraits/quyuan.png' },
  { id: 'sima-qian', name: '司马迁', category: '中国历史', era: '西汉', appearance: '文士长袍，手持竹简，神色坚忍。', traits: '坚忍、求真、重视记录。', portrait: '/portraits/sima-qian.png' },
  { id: 'xuanzang', name: '唐玄奘', category: '中国历史', era: '唐代', appearance: '僧袍，背着行囊，手持锡杖。', traits: '坚定、虔诚、能吃苦。', portrait: '/portraits/xuanzang.png' },
  { id: 'libai', name: '李白', category: '中国历史', era: '唐代', appearance: '飘逸长发，宽袖长袍，腰挂酒壶。', traits: '豪放、浪漫、热爱自由。', portrait: '/portraits/libai.png' },
  { id: 'dufu', name: '杜甫', category: '中国历史', era: '唐代', appearance: '朴素长衫，面容沉静，眉眼忧思。', traits: '仁厚、忧民、坚韧。', portrait: '/portraits/dufu.png' },
  { id: 'wang-xizhi', name: '王羲之', category: '中国历史', era: '东晋', appearance: '文士长袍，手持毛笔，气质儒雅。', traits: '专注、从容、追求完美。', portrait: '/portraits/wang-xizhi.png' },
  { id: 'caoxueqin', name: '曹雪芹', category: '中国历史', era: '清代', appearance: '清瘦，穿文士长袍，眼神敏感。', traits: '敏感、深情、善于观察人性。', portrait: '/portraits/caoxueqin.png' },
  { id: 'zhangheng', name: '张衡', category: '中国历史', era: '东汉', appearance: '古代官服，身边有浑天仪或星图。', traits: '博学、理性、喜欢研究。', portrait: '/portraits/zhangheng.png' },
  { id: 'cailun', name: '蔡伦', category: '中国历史', era: '东汉', appearance: '朴素官服，手持纸张与造纸工具。', traits: '实干、细致、善于改进。', portrait: '/portraits/cailun.png' },
  { id: 'bisheng', name: '毕昇', category: '中国历史', era: '北宋', appearance: '工匠服，手持活字模板，袖口带墨迹。', traits: '创新、耐心、重视效率。', portrait: '/portraits/bisheng.png' },
  { id: 'huatuo', name: '华佗', category: '中国历史', era: '东汉', appearance: '布衣，背着药箱，手持草药。', traits: '仁慈、冷静、细致。', portrait: '/portraits/huatuo.png' },
  { id: 'li-qingzhao', name: '李清照', category: '中国历史', era: '宋代', appearance: '素雅长裙，手持诗稿，神情清醒。', traits: '聪慧、细腻、坚强。', portrait: '/portraits/li-qingzhao.png' },
  { id: 'qinshihuang', name: '秦始皇', category: '中国历史', era: '秦代', appearance: '黑色冕服，冠冕与长剑，神情威严。', traits: '雄心勃勃、果断、重视秩序。', portrait: '/portraits/qinshihuang.png' },
  { id: 'wuzetian', name: '武则天', category: '中国历史', era: '唐代', appearance: '华贵宫装，发髻高挽，眼神锐利。', traits: '强势、果断、善于权衡。', portrait: '/portraits/wuzetian.png' },
  { id: 'genghiskhan', name: '成吉思汗', category: '中国历史', era: '元代', appearance: '草原骑装、皮靴、弓箭，面容坚毅。', traits: '果敢、纪律严明、重视人才。', portrait: '/portraits/genghiskhan.png' },
  { id: 'socrates', name: '苏格拉底', category: '世界历史', era: '古希腊', appearance: '简朴长袍，赤脚，面容粗犷。', traits: '喜欢追问、诚实、坚持思考。', portrait: '/portraits/socrates.png' },
  { id: 'plato', name: '柏拉图', category: '世界历史', era: '古希腊', appearance: '希腊长袍，短须，神情沉思。', traits: '理想主义、重视秩序、善于思辨。', portrait: '/portraits/plato.png' },
  { id: 'aristotle', name: '亚里士多德', category: '世界历史', era: '古希腊', appearance: '长袍，短须，手持卷轴。', traits: '理性、博学、善于分类。', portrait: '/portraits/aristotle.png' },
  { id: 'hippocrates', name: '希波克拉底', category: '世界历史', era: '古希腊', appearance: '白色长袍，手持医书，神情温和。', traits: '严谨、仁慈、重视经验。', portrait: '/portraits/hippocrates.png' },
  { id: 'archimedes', name: '阿基米德', category: '世界历史', era: '古希腊', appearance: '古希腊长袍，手持几何图与圆规。', traits: '专注、聪明、富有创造力。', portrait: '/portraits/archimedes.png' },
  { id: 'leonardo', name: '达·芬奇', category: '世界历史', era: '文艺复兴', appearance: '长发长须，穿工作围裙，手持画笔。', traits: '好奇、全面、想象力丰富。', portrait: '/portraits/leonardo.png' },
  { id: 'michelangelo', name: '米开朗琪罗', category: '世界历史', era: '文艺复兴', appearance: '粗壮体格，工作服上带有石粉。', traits: '固执、热情、追求完美。', portrait: '/portraits/michelangelo.png' },
  { id: 'copernicus', name: '哥白尼', category: '世界历史', era: '文艺复兴', appearance: '深色长袍，手持星图与模型。', traits: '独立、冷静、敢于提出新观点。', portrait: '/portraits/copernicus.png' },
  { id: 'galileo', name: '伽利略', category: '世界历史', era: '近代', appearance: '胡须，深色长袍，身边有望远镜。', traits: '怀疑权威、勇于坚持、重视证据。', portrait: '/portraits/galileo.png' },
  { id: 'newton', name: '牛顿', category: '世界历史', era: '近代', appearance: '长发或假发，深色外套，手持手稿。', traits: '深沉、专注、严谨。', portrait: '/portraits/newton.png' },
  { id: 'shakespeare', name: '莎士比亚', category: '世界历史', era: '文艺复兴', appearance: '文艺复兴服装，短须，手持剧本。', traits: '机智、敏锐、想象力强。', portrait: '/portraits/shakespeare.png' },
  { id: 'mozart', name: '莫扎特', category: '世界历史', era: '古典主义', appearance: '假发与华丽礼服，神情灵动。', traits: '活泼、灵巧、才华横溢。', portrait: '/portraits/mozart.png' },
  { id: 'beethoven', name: '贝多芬', category: '世界历史', era: '古典主义', appearance: '蓬乱头发，深色外套，神情坚毅。', traits: '坚强、激情、意志顽强。', portrait: '/portraits/beethoven.png' },
  { id: 'darwin', name: '达尔文', category: '世界历史', era: '近代', appearance: '白胡子，维多利亚式西装，手持标本笔记。', traits: '耐心、理性、重视证据。', portrait: '/portraits/darwin.png' },
  { id: 'pasteur', name: '巴斯德', category: '世界历史', era: '近代', appearance: '实验服，手持试管，神情专注。', traits: '严谨、勤奋、富有责任感。', portrait: '/portraits/pasteur.png' },
  { id: 'marie-curie', name: '居里夫人', category: '世界历史', era: '近代', appearance: '深色长裙或实验服，头发束起。', traits: '坚韧、低调、专注。', portrait: '/portraits/marie-curie.png' },
  { id: 'einstein', name: '爱因斯坦', category: '世界历史', era: '现代', appearance: '蓬松白发，宽松西装，神情温和。', traits: '幽默、自由、想象力丰富。', portrait: '/portraits/einstein.png' },
  { id: 'tesla', name: '尼古拉·特斯拉', category: '世界历史', era: '近代', appearance: '高个，深色西装，面容瘦削。', traits: '专注、理想主义、富有创造力。', portrait: '/portraits/tesla.png' },
  { id: 'turing', name: '艾伦·图灵', category: '世界历史', era: '现代', appearance: '戴眼镜，穿毛衣或朴素西装。', traits: '逻辑严密、内向、执着。', portrait: '/portraits/turing.png' },
  { id: 'ada-lovelace', name: '阿达·洛夫莱斯', category: '世界历史', era: '近代', appearance: '十九世纪长裙，手持数学笔记本。', traits: '理性、想象力强、勇于创新。', portrait: '/portraits/ada-lovelace.png' },
  { id: 'gutenberg', name: '古腾堡', category: '世界历史', era: '文艺复兴', appearance: '工匠服，手边有木制印刷机与铅字。', traits: '务实、创新、重视传播。', portrait: '/portraits/gutenberg.png' },
  { id: 'armstrong', name: '尼尔·阿姆斯特朗', category: '世界历史', era: '现代', appearance: '宇航服，头盔夹在手臂下，神情冷静。', traits: '冷静、勇敢、探索欲强。', portrait: '/portraits/armstrong.png' },
  { id: 'caesar', name: '凯撒', category: '世界历史', era: '古罗马', appearance: '罗马铠甲与红色披风，佩戴月桂冠。', traits: '果断、善于谋略、自信。', portrait: '/portraits/caesar.png' },
  { id: 'augustus', name: '奥古斯都', category: '世界历史', era: '古罗马', appearance: '整洁的罗马长袍，神情克制冷静。', traits: '耐心、克制、擅长经营秩序。', portrait: '/portraits/augustus.png' },
  { id: 'washington', name: '乔治·华盛顿', category: '世界历史', era: '近代', appearance: '军装或正式礼服，白发，姿态端正。', traits: '沉着、自律、重视责任。', portrait: '/portraits/washington.png' },
  { id: 'napoleon', name: '拿破仑', category: '世界历史', era: '近代', appearance: '军装与双角帽，身材不高但气势强。', traits: '野心强、果断、善于指挥。', portrait: '/portraits/napoleon.png' },
  { id: 'lincoln', name: '亚伯拉罕·林肯', category: '世界历史', era: '近代', appearance: '高个，黑色西装，高礼帽与络腮胡。', traits: '深思、宽容、坚定。', portrait: '/portraits/lincoln.png' },
  { id: 'marx', name: '卡尔·马克思', category: '世界历史', era: '近代', appearance: '浓密胡须，深色外套，手持书稿。', traits: '批判性强、执着、关注公平。', portrait: '/portraits/marx.png' },
  { id: 'pangu', name: '盘古', category: '神话人物', era: '中国神话', appearance: '巨人身躯，披兽皮或粗布，手持巨斧。', traits: '开创、坚韧、牺牲精神强。', portrait: '/portraits/pangu.png' },
  { id: 'nuwa', name: '女娲', category: '神话人物', era: '中国神话', appearance: '彩衣，带有蛇身或龙鳞意象，手持五彩石。', traits: '慈爱、智慧、守护众生。', portrait: '/portraits/nuwa.png' },
  { id: 'houyi', name: '后羿', category: '神话人物', era: '中国神话', appearance: '壮实身躯，古代猎装，背负长弓。', traits: '勇敢、果断、责任感强。', portrait: '/portraits/houyi.png' },
  { id: 'change', name: '嫦娥', category: '神话人物', era: '中国神话', appearance: '白衣长裙，发带与月光环绕，气质清冷。', traits: '孤独、优雅、渴望自由。', portrait: '/portraits/change.png' },
  { id: 'jingwei', name: '精卫', category: '神话人物', era: '中国神话', appearance: '少女形象，带鸟羽装饰，手持小石。', traits: '执着、不屈、永不放弃。', portrait: '/portraits/jingwei.png' },
  { id: 'nezha', name: '哪吒', category: '神话人物', era: '中国神话', appearance: '少年形象，乾坤圈、混天绫与风火轮。', traits: '叛逆、勇敢、正义感强。', portrait: '/portraits/nezha.png' },
  { id: 'sunwukong', name: '孙悟空', category: '神话人物', era: '中国神话', appearance: '金甲、金箍，手持金箍棒，目光机敏。', traits: '机敏、自由、反抗精神强。', portrait: '/portraits/sunwukong.png' },
  { id: 'prometheus', name: '普罗米修斯', category: '神话人物', era: '希腊神话', appearance: '古希腊长袍，手捧燃烧的火种。', traits: '牺牲、智慧、反抗权威。', portrait: '/portraits/prometheus.png' },
  { id: 'athena', name: '雅典娜', category: '神话人物', era: '希腊神话', appearance: '战甲、长矛与盾牌，头戴羽饰头盔。', traits: '理性、冷静、善于谋略。', portrait: '/portraits/athena.png' },
  { id: 'thor', name: '托尔', category: '神话人物', era: '北欧神话', appearance: '金发、战甲，手持雷神之锤。', traits: '豪爽、勇敢、重视荣誉。', portrait: '/portraits/thor.png' },
];

export const CHARACTER_CATEGORIES: CharacterCategory[] = ['中国历史', '世界历史', '神话人物'];

/** 归一化姓名：去掉间隔号与空白，用于跨档案匹配（达·芬奇 ≈ 达芬奇） */
export function normalizeCharacterName(name: string): string {
  return name.replace(/[·\s]/g, '');
}

/** 姓名宽松匹配：完全相等，或一方是另一方的子串（特斯拉 ≈ 尼古拉·特斯拉） */
export function charactersMatch(a: string, b: string): boolean {
  const na = normalizeCharacterName(a);
  const nb = normalizeCharacterName(b);
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= 2 && longer.includes(shorter);
}

/** 按档案 id 或姓名查找人物档案（引擎 agent 的 id 即档案 id） */
export function findArchiveCharacter(needle: { id?: string; name?: string }): CharacterProfile | undefined {
  if (needle.id) {
    const byId = CHARACTERS.find((c) => c.id === needle.id);
    if (byId) return byId;
  }
  if (needle.name) return CHARACTERS.find((c) => charactersMatch(c.name, needle.name!));
  return undefined;
}
