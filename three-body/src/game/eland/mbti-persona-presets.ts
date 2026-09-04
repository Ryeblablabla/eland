import type { HexacoVector } from './domain/person';

/**
 * Fiction-writing presets inspired by the sixteen MBTI labels. They are
 * character seeds, not psychological diagnoses, abilities, memories, world
 * facts, or hard action rules.
 */
export type MbtiType =
  | 'ISTJ' | 'ISFJ' | 'INFJ' | 'INTJ'
  | 'ISTP' | 'ISFP' | 'INFP' | 'INTP'
  | 'ESTP' | 'ESFP' | 'ENFP' | 'ENTP'
  | 'ESTJ' | 'ESFJ' | 'ENFJ' | 'ENTJ';

/** Semantic fields intentionally mirror the useful parts of CharacterTurnNote. */
export interface MbtiPersonaPreset {
  type: MbtiType;
  name: string;
  summary: string;
  attention: string;
  innerTension: string;
  responseTendency: string;
  speechTendency: string;
  speechExamples: readonly {
    situation: string;
    utterance: string;
  }[];
}

export const MBTI_PERSONA_PRESETS: Readonly<Record<MbtiType, MbtiPersonaPreset>> = {
  ISTJ: {
    type: 'ISTJ',
    name: '可靠执行型',
    summary: '重视事实、秩序、责任与已经验证过的做法，倾向把承诺落实到可检查的结果。',
    attention: '先看已经发生的事实、现有责任、步骤是否完整，以及哪里偏离了原先约定。',
    innerTension: '希望稳定地完成事情，但现实变化可能要求放下熟悉做法并重新判断。',
    responseTendency: '先守住明确责任和可靠流程；出现具体反例时调整办法，而不是只因新奇改变方向。',
    speechTendency: '表达具体、克制、有顺序，常从事实、责任和下一步说起。',
    speechExamples: [
      { situation: '面对一个结果未知的新做法', utterance: '先把已经确定的条件列清楚。哪一步变了，我们就从哪一步查。' },
      { situation: '共同工作受阻', utterance: '原来的安排没完成。先补上缺的这一段，再决定要不要换办法。' },
    ],
  },
  ISFJ: {
    type: 'ISFJ',
    name: '细致照护型',
    summary: '留意他人的实际需要和共同生活中的细节，愿意用持续而低调的行动维护安全与信任。',
    attention: '先注意谁需要帮助、哪些日常安排可能中断，以及过去的照料和承诺是否仍然有效。',
    innerTension: '想维持和谐与稳定，却也需要承认自己的负担、边界和无法照顾所有人的现实。',
    responseTendency: '优先处理具体可见的照护与维持工作，拒绝时也会说明自己真正承担不起的部分。',
    speechTendency: '语气温和、具体、少夸张，常通过记得的小事表达关心。',
    speechExamples: [
      { situation: '看见同伴明显疲惫', utterance: '你先歇一会儿。我把手上这点做完，再来看看你缺什么。' },
      { situation: '共同工作受阻', utterance: '别急着怪谁。先看看每个人还剩多少力气，缺的那部分我们再分。' },
    ],
  },
  INFJ: {
    type: 'INFJ',
    name: '意义洞察型',
    summary: '关注事件背后的长期意义、人与人之间未说出的动机，以及选择是否符合内在原则。',
    attention: '先寻找零散事实之间的模式、他人处境中的深层矛盾，以及长期会把人带向哪里。',
    innerTension: '希望忠于完整而长远的价值，但眼前事实常常不够清楚，也未必允许理想方案。',
    responseTendency: '形成一个有长期意义的方向，同时用眼前事实检验自己的解释是否只是投射。',
    speechTendency: '表达含蓄而有方向感，先说观察到的矛盾，再说明自己真正关心的结果。',
    speechExamples: [
      { situation: '众人对陌生现象各执一词', utterance: '我们说的也许不是同一件事。先看看，哪种解释会让大家付出不同的代价。' },
      { situation: '共同工作受阻', utterance: '眼前这一步没成，但我更担心我们正在忘记最初为什么要做它。' },
    ],
  },
  INTJ: {
    type: 'INTJ',
    name: '长程构想型',
    summary: '倾向建立因果模型、寻找关键瓶颈并为长期结果组织路径，不轻易满足于表面解释。',
    attention: '先看系统怎样运转、哪个条件限制了后续发展，以及当前选择会造成什么长期结构。',
    innerTension: '想让计划保持连贯和可控，但有限信息与他人的自主选择会不断破坏完整模型。',
    responseTendency: '先确定真正值得解决的核心问题，再选择能够验证或推进整体判断的一步。',
    speechTendency: '语言简洁、抽象度较高，但会把结论落到关键条件和预期方向上。',
    speechExamples: [
      { situation: '面对多个可能方向', utterance: '先别同时追。找出那个会限制后面所有选择的条件。' },
      { situation: '共同工作受阻', utterance: '真正卡住我们的不是这一块材料，而是没有可靠的取得办法。' },
    ],
  },
  ISTP: {
    type: 'ISTP',
    name: '冷静实作型',
    summary: '重视直接观察、工具效果和现实约束，偏好亲手试验后再接受解释。',
    attention: '先看手边有什么、事物怎样受力或变化，以及哪个局部条件可以立即检验。',
    innerTension: '享受独立解决问题的自由，但复杂事务有时需要提前说明、合作和持续投入。',
    responseTendency: '少作空泛承诺，先用一个范围清楚的实际尝试取得反馈，再决定是否继续。',
    speechTendency: '短句、直接、少修饰，更愿意描述看见的变化和可操作的部分。',
    speechExamples: [
      { situation: '发现一种陌生材料', utterance: '给我一小块。我先试试它受力以后会怎样。' },
      { situation: '共同工作受阻', utterance: '别猜了。把坏的地方给我看。' },
    ],
  },
  ISFP: {
    type: 'ISFP',
    name: '温和体验型',
    summary: '重视当下真实感受、个人自由和选择对具体生命造成的影响，不喜欢强迫别人。',
    attention: '先感受眼前环境和人的状态，留意哪里让自己或他人不舒服，以及什么仍值得珍惜。',
    innerTension: '想忠于个人价值并避免伤害，却可能因为不愿冲突而推迟说出真实态度。',
    responseTendency: '选择一件符合内心判断且能在当下产生真实改善的事，不为抽象规则牺牲具体的人。',
    speechTendency: '自然、柔和、带具体感受，通常不长篇解释，也不替别人定义感受。',
    speechExamples: [
      { situation: '有人催促同伴接受安排', utterance: '他还没有答应。先让他自己看看，再说愿不愿意。' },
      { situation: '共同工作受阻', utterance: '这里让我觉得不太对。我想先停一下，看看是不是伤到了谁。' },
    ],
  },
  INFP: {
    type: 'INFP',
    name: '价值理想型',
    summary: '以内在价值和可能成为怎样的人衡量选择，关注被忽略者与尚未实现的可能。',
    attention: '先看一件事是否违背自己的核心信念、谁的声音没有被听见，以及还有没有更真诚的选择。',
    innerTension: '希望守住理想和个体独特性，但现实需要妥协、重复劳动和不完美的阶段结果。',
    responseTendency: '先确认目标是否真心认可，再寻找既不背离价值又能在现实中开始的方向。',
    speechTendency: '语气真诚、带个人立场和想象力；不确定时会保留余地，而不是假装笃定。',
    speechExamples: [
      { situation: '一个有效办法会让弱者承担代价', utterance: '如果只有最弱的人替我们付代价，那我不想把它叫作好办法。' },
      { situation: '共同工作受阻', utterance: '也许我们做不到原来想的全部，但我不想连真正重要的部分也一起放弃。' },
    ],
  },
  INTP: {
    type: 'INTP',
    name: '概念分析型',
    summary: '喜欢澄清定义、拆解因果和发现解释中的漏洞，对未经验证的一致意见保持怀疑。',
    attention: '先找前提是否成立、不同解释怎样区分，以及哪一个观察最能改变当前判断。',
    innerTension: '想在行动前把模型想清楚，但世界不会等待完整理论，过度分析也可能失去验证机会。',
    responseTendency: '提出一个边界清楚、能够排除部分解释的问题，再根据结果重组自己的理解。',
    speechTendency: '措辞精确、偏分析，常用追问和条件句，明确区分事实、推论与猜想。',
    speechExamples: [
      { situation: '相同尝试出现不同结果', utterance: '先区分一下：是材料不同，还是我们其实没有重复同一个步骤？' },
      { situation: '共同工作受阻', utterance: '如果原因真是人手不够，增加一个人应该会改变结果。可以先验证这一点。' },
    ],
  },
  ESTP: {
    type: 'ESTP',
    name: '临场行动型',
    summary: '敏锐捕捉眼前机会和风险，敢于快速试探环境，并根据即时反馈改变做法。',
    attention: '先看此刻哪里正在变化、什么机会稍纵即逝，以及谁能够立即影响局面。',
    innerTension: '快速行动能抢到先机，但也可能低估长期代价、承诺和不容易逆转的后果。',
    responseTendency: '在可承受风险内先做一次现实试探；一旦反馈改变，就迅速调整而不维护面子。',
    speechTendency: '直接、鲜活、反应快，常先表态或提议，再补充必要理由。',
    speechExamples: [
      { situation: '眼前出现短暂机会', utterance: '现在能试就现在试。先做小一点，情况不对马上退。' },
      { situation: '共同工作受阻', utterance: '这条路不通就换一条。站着争不会让东西自己过来。' },
    ],
  },
  ESFP: {
    type: 'ESFP',
    name: '热情体验型',
    summary: '关注当下的人、氛围和可以共同经历的事情，愿意用行动让生活变得具体而有活力。',
    attention: '先注意谁正在参与、谁被冷落、现场有什么可以改善，以及人们对变化的即时反应。',
    innerTension: '想回应当下并维持活力，但短期愉快未必能承担资源、责任和未来风险。',
    responseTendency: '优先选择能让自己和身边人真实参与的方向，同时在明显后果出现时及时收住。',
    speechTendency: '口语化、开放、带现场感，容易主动邀请别人，但不替对方承诺。',
    speechExamples: [
      { situation: '众人面对陌生环境沉默', utterance: '别都站着呀。那边有什么，我们一起过去看看？' },
      { situation: '共同工作受阻', utterance: '先喘口气。谁还想继续，我们换个轻一点的办法。' },
    ],
  },
  ENFP: {
    type: 'ENFP',
    name: '可能性探索型',
    summary: '容易发现人与事之间的新联系，受意义、自由和潜在可能驱动，愿意尝试不同方向。',
    attention: '先看眼前事实还能连接出哪些可能、谁具有尚未发挥的潜力，以及旧做法是否限制了选择。',
    innerTension: '新方向不断吸引注意，但真正形成能力需要持续、取舍并完成已经开始的事情。',
    responseTendency: '先形成一个自己真正在意的新可能，再选择能够证明它不是空想的现实起点。',
    speechTendency: '热情、联想丰富、愿意追问；会说出可能性，但避免把可能写成已经发生。',
    speechExamples: [
      { situation: '发现两个看似无关的现象', utterance: '等等，它们会不会其实有关？我想找一个最简单的办法试试看。' },
      { situation: '共同工作受阻', utterance: '这个方向不一定错，也许只是入口太窄。我们能不能换个起点？' },
    ],
  },
  ENTP: {
    type: 'ENTP',
    name: '假设辩证型',
    summary: '喜欢挑战默认前提、比较替代解释并通过争论或试验寻找更有力的方案。',
    attention: '先找主流判断中的漏洞、被忽略的替代路径，以及哪个反例能最快检验当前说法。',
    innerTension: '持续质疑能带来新发现，却也可能削弱承诺、忽视他人感受或永远不肯收敛。',
    responseTendency: '提出一个有区分力的替代假设并寻求验证；证据足够时愿意暂时选定方向。',
    speechTendency: '机敏、追问多、允许轻微调侃，通常会把不同方案并列后指出关键差别。',
    speechExamples: [
      { situation: '所有人迅速接受同一种解释', utterance: '大家都同意得这么快，反而值得查一下。什么结果会证明我们错了？' },
      { situation: '共同工作受阻', utterance: '也许不是做不到，只是我们一直把问题切在了错误的地方。' },
    ],
  },
  ESTJ: {
    type: 'ESTJ',
    name: '组织推进型',
    summary: '重视明确责任、资源安排和可衡量进展，习惯把混乱组织成能够执行的共同事务。',
    attention: '先看目标是否明确、谁负责什么、资源是否到位，以及哪些环节正在拖延结果。',
    innerTension: '效率和秩序有助于推进事情，但过早统一做法可能压过异议、关系和新的证据。',
    responseTendency: '先明确一个现实目标和责任边界，再推动形成可交代的进展；事实变化时重新安排。',
    speechTendency: '结论先行、措辞明确、偏行动导向，通常直接说明责任、标准和下一步。',
    speechExamples: [
      { situation: '多人行动缺少协调', utterance: '先定一件事。谁取材料，谁留在这里，做完以后回来说明结果。' },
      { situation: '共同工作受阻', utterance: '现在的问题有两个：材料没到，人也没有按约定回来。先处理前一个。' },
    ],
  },
  ESFJ: {
    type: 'ESFJ',
    name: '关系维系型',
    summary: '重视群体中的互相照应、可见贡献和共同习惯，倾向主动维护合作与归属。',
    attention: '先看大家是否被照顾、关系哪里出现空缺、共同安排是否公平，以及谁还没有回应。',
    innerTension: '希望获得认同并保持和谐，但真正的照顾有时需要拒绝、不赞同或指出责任缺口。',
    responseTendency: '优先修复具体关系或共同生活问题，同时确认帮助来自真实需要而不是讨好。',
    speechTendency: '亲切、明确、常提及具体的人和共同经历；分歧时也会尽量让关系能够继续。',
    speechExamples: [
      { situation: '讨论时有人一直没有说话', utterance: '你还没说自己的想法。要是不愿意也可以，我们先听清楚。' },
      { situation: '共同工作受阻', utterance: '不同意没关系，别让这件事把人也推开。我们把各自能做的说清楚。' },
    ],
  },
  ENFJ: {
    type: 'ENFJ',
    name: '群体引导型',
    summary: '关注人的动机、成长和共同方向，愿意组织沟通并让不同成员看见自己能够贡献什么。',
    attention: '先看每个人真正关心什么、群体缺少怎样的共同理解，以及谁需要被邀请进入行动。',
    innerTension: '希望支持并引导他人，却可能把自己的愿景误当成大家的愿望，越过他人的选择权。',
    responseTendency: '先形成一个能连接多人真实需要的方向，再通过询问和明确分工争取自愿合作。',
    speechTendency: '有感染力但重视回应，善于把个人处境连接到共同目标，同时会确认别人是否同意。',
    speechExamples: [
      { situation: '众人因目标不同发生争执', utterance: '先说说你们各自最怕失去什么。也许我们争的是办法，不是最终想守住的东西。' },
      { situation: '共同工作受阻', utterance: '这件事不能只靠一个人撑着。谁愿意继续，谁需要换一部分责任？' },
    ],
  },
  ENTJ: {
    type: 'ENTJ',
    name: '战略组织型',
    summary: '倾向迅速识别关键目标、资源杠杆和长期阻碍，并组织人力把方向变成结果。',
    attention: '先看什么最影响整体结果、资源和能力如何组合，以及哪个阻碍必须优先消除。',
    innerTension: '果断协调能够减少浪费，但强烈目标感可能忽视信息不足、关系代价和他人的自主性。',
    responseTendency: '先选定最值得投入的方向并说明理由，再组织能够验证和推进它的现实安排。',
    speechTendency: '自信、简洁、结构清楚，常先给方向和取舍；需要合作时会明确询问承担意愿。',
    speechExamples: [
      { situation: '多个问题同时出现', utterance: '先解决会让其他问题继续恶化的那个。剩下的按影响排序。' },
      { situation: '共同工作受阻', utterance: '目标不变，办法换掉。谁愿意负责新的尝试，现在说清楚。' },
    ],
  },
};

/**
 * Stable writing-type projection from a person's baseline temperament.
 * This is a deliberately small authoring heuristic, not a claim that HEXACO
 * and MBTI measure the same thing, and it never changes action legality.
 */
export function mbtiTypeForPersonality(personality: HexacoVector): MbtiType {
  const energy = personality.extraversion >= 50 ? 'E' : 'I';
  const perception = personality.openness >= 50 ? 'N' : 'S';
  const judgment = personality.agreeableness + personality.emotionality >= 100 ? 'F' : 'T';
  const lifestyle = personality.conscientiousness >= 50 ? 'J' : 'P';
  return `${energy}${perception}${judgment}${lifestyle}` as MbtiType;
}
