export type CharacterCategory = '中国历史' | '世界历史' | '神话人物' | '虚构人物';

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
  { id: 'cai-wenji', name: '蔡文姬', category: '中国历史', era: '东汉', appearance: '深色发髻与汉代长袍，手持琵琶与竹简。', traits: '坚韧、敏感、才华横溢，珍视诗歌与音乐。', portrait: '/portraits/cai-wenji.png' },
  { id: 'wang-zhaojun', name: '王昭君', category: '中国历史', era: '西汉', appearance: '汉代长裙与边塞披帛，手持琵琶，神情沉静。', traits: '端庄、坚毅、胸怀远见，能够承受远行与离别。', portrait: '/portraits/wang-zhaojun.png' },
  { id: 'shangguan-waner', name: '上官婉儿', category: '中国历史', era: '唐代', appearance: '早唐宫装，手持笔与诏书，发髻端整。', traits: '敏锐、聪慧、善于表达，具有政治判断力。', portrait: '/portraits/shangguan-waner.png' },
  { id: 'yang-guifei', name: '杨贵妃', category: '中国历史', era: '唐代', appearance: '盛唐华服，佩戴花饰，身旁有牡丹与琵琶。', traits: '温柔、优雅、感受细腻，亲近音乐与诗歌。', portrait: '/portraits/yang-guifei.png' },
  { id: 'liu-rushi', name: '柳如是', category: '中国历史', era: '明末清初', appearance: '文人装束，手持折扇与书法笔，神情独立。', traits: '独立、聪慧、刚烈，重视文学与自我选择。', portrait: '/portraits/liu-rushi.png' },
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
  { id: 'joan-of-arc', name: '圣女贞德', category: '世界历史', era: '中世纪', appearance: '短发，身着磨损的钢甲、蓝灰色罩袍，身旁有简朴的白色旗帜。', traits: '勇敢、虔诚、坚定而谦逊，愿意承担守护共同体的责任。', portrait: '/portraits/joan-of-arc.png' },
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
  { id: 'medusa', name: '美杜莎', category: '神话人物', era: '希腊神话', appearance: '蛇发、古希腊衣饰，带有青铜盾与石化目光的意象。', traits: '坚强、悲悯、拥有令人敬畏的力量。', portrait: '/portraits/medusa.png' },
  { id: 'aphrodite', name: '阿佛洛狄忒', category: '神话人物', era: '希腊神话', appearance: '古希腊长裙与金色长发，带有鸽子与贝壳的意象。', traits: '温柔、从容、重视爱与和谐。', portrait: '/portraits/aphrodite.png' },
  { id: 'pandora', name: '潘多拉', category: '神话人物', era: '希腊神话', appearance: '古希腊织袍，手边有一只封闭的陶制容器。', traits: '好奇、谨慎、善于面对后果。', portrait: '/portraits/pandora.png' },
  { id: 'artemis', name: '阿尔忒弥斯', category: '神话人物', era: '希腊神话', appearance: '银蓝猎装与月牙饰物，身旁有弓与森林的意象。', traits: '独立、警觉、亲近自然。', portrait: '/portraits/artemis.png' },
  { id: 'persephone', name: '珀耳塞福涅', category: '神话人物', era: '希腊神话', appearance: '深紫与象牙色长袍，带有石榴与白花的意象。', traits: '沉静、坚韧、兼具温柔与威严。', portrait: '/portraits/persephone.png' },
  { id: 'freyja', name: '芙蕾雅', category: '神话人物', era: '北欧神话', appearance: '金发与北欧披风，佩戴琥珀饰物，带有猎鹰羽毛的意象。', traits: '热烈、坚强、富有魔法与生命力。', portrait: '/portraits/freyja.png' },
  { id: 'bai-suzhen', name: '白素贞', category: '神话人物', era: '中国传说', appearance: '白衣青纹长裙，佩戴白蛇玉饰，手持草药。', traits: '慈悲、聪慧、重视承诺与救助。', portrait: '/portraits/bai-suzhen.png' },
  { id: 'zhinu', name: '织女', category: '神话人物', era: '中国神话', appearance: '蓝银色汉风长裙，带有星辰与织线纹样，手持银梭。', traits: '温柔、专注、重视技艺与情感。', portrait: '/portraits/zhinu.png' },
  { id: 'artoria-pendragon', name: '阿尔托莉雅·潘德拉贡', category: '虚构人物', era: '亚瑟王传说改编', appearance: '金发蓝眼，身着蓝银王者铠甲与披风，佩戴王冠般的发饰。', traits: '克制、正直、责任感强，具有守护王国的决心。', portrait: '/portraits/artoria-pendragon.png' },
  { id: 'zhaotianli', name: '照天离', category: '虚构人物', era: '原创世界', appearance: '赤红高马尾，身着黑白红相间的凤凰战甲，带有橙金色能量纹路。', traits: '自信、果决、骄傲而坚韧。', portrait: '/portraits/zhaotianli.png' },
  { id: 'zhentianyuan', name: '镇天渊', category: '虚构人物', era: '原创世界', appearance: '淡金长发，佩戴黑金角冠，身着黑金仪式战装，带有神秘符文。', traits: '威严、沉静、掌控力强，善于守护与统御。', portrait: '/portraits/zhentianyuan.png' },
  { id: 'potianfeng', name: '破天锋', category: '虚构人物', era: '原创世界', appearance: '白发狐耳，身着白蓝金边长袍，掌中燃起一簇蓝色灵焰。', traits: '灵动、聪慧、亲和而勇敢。', portrait: '/portraits/potianfeng.png' },
  { id: 'cangtianying', name: '苍天影', category: '虚构人物', era: '原创世界', appearance: '银白长发带浅青发梢，佩戴紫黑角冠，身着深紫靛蓝法袍。', traits: '神秘、冷静、优雅，拥有强烈的自我意志。', portrait: '/portraits/cangtianying.png' },
  { id: 'usagi-tsukino', name: '月野兔', category: '虚构人物', era: '现代动漫', appearance: '金色双丸子长发，身着白蓝红配色的守护者制服，带有月亮饰物。', traits: '善良、乐观、重视伙伴与守护。', portrait: '/portraits/usagi-tsukino.png' },
  { id: 'ai-haibara', name: '灰原哀', category: '虚构人物', era: '现代动漫', appearance: '短棕发，身着深色高领外套与简洁便装，手持资料夹。', traits: '冷静、聪慧、谨慎，内心重视信任与同伴。', portrait: '/portraits/ai-haibara.png' },
  { id: 'ran-mouri', name: '毛利兰', category: '虚构人物', era: '现代动漫', appearance: '长棕发，身着校服风格的蓝色外套，姿态利落坚定。', traits: '温柔、勇敢、坚韧，具有保护他人的行动力。', portrait: '/portraits/ran-mouri.png' },
  { id: 'sakura-kinomoto', name: '木之本樱', category: '虚构人物', era: '现代动漫', appearance: '棕色短发与发饰，身着带羽翼与星星元素的魔法服，手持魔法杖。', traits: '开朗、勇敢、富有同理心，善于面对未知。', portrait: '/portraits/sakura-kinomoto.png' },
  { id: 'sakura-haruno', name: '春野樱', category: '虚构人物', era: '现代动漫', appearance: '粉色短发，身着红色战斗服与护腕，额前有象征专注的印记。', traits: '果断、勤奋、意志坚强，擅长在压力下成长。', portrait: '/portraits/sakura-haruno.png' },
  { id: 'hinata-hyuga', name: '日向雏田', category: '虚构人物', era: '现代动漫', appearance: '深蓝长发，身着浅色忍者服与护腕，目光温和坚定。', traits: '谦逊、专一、勇于突破自我。', portrait: '/portraits/hinata-hyuga.png' },
  { id: 'nami', name: '娜美', category: '虚构人物', era: '现代动漫', appearance: '橙色长发，身着轻便航海服，手持航海图与天候法杖。', traits: '聪明、果断、重视伙伴，拥有很强的生存判断力。', portrait: '/portraits/nami.png' },
  { id: 'nezuko-kamado', name: '灶门祢豆子', category: '虚构人物', era: '现代动漫', appearance: '黑发渐变橙色发梢，身着和风短褂与竹筒，带有柔和的火焰意象。', traits: '温柔、坚韧、保护欲强，能够克制力量守护家人。', portrait: '/portraits/nezuko-kamado.png' },
  { id: 'chihiro-ogino', name: '荻野千寻', category: '虚构人物', era: '现代动画', appearance: '棕色短发，身着朴素工作服，手持一盏暖光提灯。', traits: '善良、坚毅、在陌生环境中逐渐找到勇气。', portrait: '/portraits/chihiro-ogino.png' },
  { id: 'nausicaa', name: '娜乌西卡', category: '虚构人物', era: '未来动画', appearance: '浅棕短发，身着蓝色飞行服与护具，带有风与青绿色植物的意象。', traits: '勇敢、宽容、珍视自然与和平。', portrait: '/portraits/nausicaa.png' },
  { id: 'sophie-hatter', name: '苏菲·哈特', category: '虚构人物', era: '现代动画', appearance: '灰褐长发，身着朴素的深蓝长裙与围裙，手持帽匠工具。', traits: '踏实、温柔、富有韧性，能够在变化中认识自己。', portrait: '/portraits/sophie-hatter.png' },
  { id: 'san', name: '桑', category: '虚构人物', era: '现代动画', appearance: '深色长发，身着白色与赤色的森林战装，佩戴兽牙与面具意象。', traits: '敏锐、勇敢、忠于自然与自己的信念。', portrait: '/portraits/san.png' },
  { id: 'violet-evergarden', name: '薇尔莉特·伊芙加登', category: '虚构人物', era: '现代动画', appearance: '金色长发，身着蓝色制服与白色手套，带有精致的机械义手与胸针。', traits: '克制、认真、通过文字理解情感与告别。', portrait: '/portraits/violet-evergarden.png' },
  { id: 'rei-ayanami', name: '绫波丽', category: '虚构人物', era: '现代动漫', appearance: '浅蓝短发与红色眼眸，身着白色驾驶服，周围带有冷蓝色光晕。', traits: '安静、敏感、逐渐建立自我意志。', portrait: '/portraits/rei-ayanami.png' },
  { id: 'asuka-langley', name: '明日香·兰格雷', category: '虚构人物', era: '现代动漫', appearance: '橙红长发与红色眼眸，身着红黑驾驶服，带有锐利的科技光线。', traits: '好胜、聪明、外表强势而内心渴望被理解。', portrait: '/portraits/asuka-langley.png' },
  { id: 'hermione-granger', name: '赫敏·格兰杰', category: '虚构人物', era: '现代小说', appearance: '棕色蓬松长发，身着深红金边学院长袍，手持魔杖与打开的书本。', traits: '聪慧、勤奋、勇于坚持正确的事。', portrait: '/portraits/hermione-granger.png' },
  { id: 'jane-eyre', name: '简·爱', category: '虚构人物', era: '维多利亚时代小说', appearance: '深色维多利亚式长裙，手持书本与烛台，神情平静坚定。', traits: '独立、自尊、重视真诚与精神平等。', portrait: '/portraits/jane-eyre.png' },
  { id: 'elizabeth-bennet', name: '伊丽莎白·班纳特', category: '虚构人物', era: '摄政时代小说', appearance: '绿色与象牙色摄政时代长裙，手持书本，姿态轻盈自信。', traits: '机敏、独立、善于观察并坚持自我判断。', portrait: '/portraits/elizabeth-bennet.png' },
  { id: 'anne-shirley', name: '安妮·雪莉', category: '虚构人物', era: '现代小说', appearance: '赤红长发与发辫，身着绿色乡村裙装，手持书本，周围有野花。', traits: '想象力丰富、热情、重视友谊与成长。', portrait: '/portraits/anne-shirley.png' },
  { id: 'heidi', name: '海蒂', category: '虚构人物', era: '现代小说', appearance: '深色双辫，身着朴素乡村裙装与红色披肩，带有高山草坡的意象。', traits: '纯真、乐观、亲近自然，能够带给他人温暖。', portrait: '/portraits/heidi.png' },
  { id: 'dorothy-gale', name: '多萝西·盖尔', category: '虚构人物', era: '现代小说', appearance: '棕色双辫，身着蓝白格纹裙与红色鞋子，手持书本。', traits: '勇敢、善良、重视伙伴并愿意踏上旅程。', portrait: '/portraits/dorothy-gale.png' },
  { id: 'matilda-wormwood', name: '玛蒂尔达·沃姆伍德', category: '虚构人物', era: '现代小说', appearance: '深棕短发，身着蓝色连衣裙，面前有打开的书本与暖色书页光。', traits: '聪明、好奇、独立，善于用知识解决问题。', portrait: '/portraits/matilda-wormwood.png' },
  { id: 'alice', name: '爱丽丝', category: '虚构人物', era: '现代小说', appearance: '金色短发，身着蓝色连衣裙与白色领饰，佩戴黑色蝴蝶结，手持打开的书本与小钥匙。', traits: '好奇、机敏、想象力丰富，愿意探索未知世界。', portrait: '/portraits/alice.png' },
];

export const CHARACTER_CATEGORIES: CharacterCategory[] = ['中国历史', '世界历史', '神话人物', '虚构人物'];

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
