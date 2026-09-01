import type {
  HexacoTrait,
  HexacoVector,
  MotiveSensitivity,
  PrototypeReactionPattern,
} from './domain/person';

export interface FounderPersonaPrior {
  version: 'founder-persona-prior-v1';
  source: 'prototype-dossier';
  personalityCenter: HexacoVector;
  motiveCenter: MotiveSensitivity;
  reactionPatterns: PrototypeReactionPattern[];
  matchedSignalIds: string[];
}

type VectorDelta = Partial<Record<HexacoTrait | keyof MotiveSensitivity, number>>;

interface PrototypeSignal {
  id: string;
  pattern: RegExp;
  delta: VectorDelta;
  reaction: Omit<PrototypeReactionPattern, 'id'>;
}

const SIGNALS: readonly PrototypeSignal[] = [
  {
    id: 'care',
    pattern: /仁厚|仁慈|慈爱|慈悲|善良|温柔|宽容|悲悯|同理|和平|保护|守护|救助|忧民|伙伴|友谊|重视爱/u,
    delta: { honestyHumility: 8, emotionality: 8, agreeableness: 13 },
    reaction: {
      cue: '有人受伤、害怕、孤立或需要照料时',
      attention: '先注意后果会落到谁身上，以及自己能提供哪一种真实帮助',
      responseTendency: '先做一件能减轻处境的具体事，再谈安慰或原则',
      speechTendency: '可以温和，但不把关心说成没有依据的保证',
      exampleLine: '先坐下。水我还有一点。',
    },
  },
  {
    id: 'restraint',
    pattern: /克制|低调|内向|安静|沉静|沉着|深沉|淡泊|端庄|从容|优雅|谦逊/u,
    delta: { honestyHumility: 5, emotionality: -4, extraversion: -13, conscientiousness: 6, control: -3 },
    reaction: {
      cue: '关系尚浅或众人都在等待本人开口时',
      attention: '先观察对方真正需要什么，不为了填满沉默暴露过多',
      responseTendency: '只在有明确判断或必要回应时开口',
      speechTendency: '句子克制而具体，允许停顿和留白',
      exampleLine: '我听着。你先说。',
    },
  },
  {
    id: 'autonomy',
    pattern: /独立|自由|自我选择|自我意志|反抗|叛逆|自尊|好胜|怀疑权威/u,
    delta: { extraversion: 5, agreeableness: -7, openness: 9, control: 16, status: 6 },
    reaction: {
      cue: '别人提出命令、要求或试图替本人决定时',
      attention: '先确认选择权、代价和承诺是否仍由自己承担',
      responseTendency: '可以合作，但会抵抗未经说明的支配和替自己作主',
      speechTendency: '先给出自己的态度，再说明接受或拒绝的边界',
      exampleLine: '你可以劝我，别替我答应。',
    },
  },
  {
    id: 'inquiry',
    pattern: /好奇|研究|追问|思考|求真|证据|观察|博学|理性|逻辑|思辨|分类|知识|聪明|聪慧|智慧|敏锐|深邃|全面/u,
    delta: { honestyHumility: 4, conscientiousness: 6, openness: 15 },
    reaction: {
      cue: '遇到陌生事物、反常结果或互相冲突的说法时',
      attention: '先分清亲眼事实、可靠记录和仍待验证的解释',
      responseTendency: '提出一个能继续观察或试验的具体问题',
      speechTendency: '清楚区分知道、不知道和只是猜想',
      exampleLine: '先别下结论。刚才到底哪一步变了？',
    },
  },
  {
    id: 'imagination',
    pattern: /想象|浪漫|诗歌|音乐|创造|创新|机智|幽默|灵动|才华|文学/u,
    delta: { extraversion: 5, openness: 16 },
    reaction: {
      cue: '旧办法失效或眼前出现尚未解释的可能性时',
      attention: '会主动联想到另一种做法或解释，但仍留意现实限制',
      responseTendency: '愿意提出新尝试，不把联想直接当成答案',
      speechTendency: '允许一个朴素联想或轻微幽默，随后落回具体事实',
      exampleLine: '换个顺序呢？……先拿这一小份试试。',
    },
  },
  {
    id: 'duty',
    pattern: /忠诚|责任|承诺|原则|纪律|自律|认真|专注|勤奋|完美|效率|技艺|教育|传播|记录|秩序|经营|严谨/u,
    delta: { honestyHumility: 6, conscientiousness: 15, status: 4 },
    reaction: {
      cue: '已有承诺、未完成工作或需要长期坚持的责任出现时',
      attention: '先看自己已经答应什么、完成到哪一步以及谁会受影响',
      responseTendency: '优先把责任推进到可交代的下一步，改变方向时说明后果',
      speechTendency: '用已经做到的事和下一步表达态度，少说空泛决心',
      exampleLine: '我答应过。手上这一步做完再走。',
    },
  },
  {
    id: 'resilience',
    pattern: /坚韧|坚定|坚毅|坚强|执着|坚持|耐心|不屈|永不放弃|吃苦|勇气|成长|韧性|意志/u,
    delta: { emotionality: -3, conscientiousness: 13 },
    reaction: {
      cue: '一次尝试失败、受阻或付出没有立刻得到结果时',
      attention: '先辨认失败改变了哪个条件，而不是只把它理解成结束',
      responseTendency: '保留仍有价值的目标，依据新证据调整办法后再行动',
      speechTendency: '承认困难，但把话落在下一次可验证的尝试上',
      exampleLine: '这次没成。原样再来没用，我换个办法。',
    },
  },
  {
    id: 'assertiveness',
    pattern: /强势|果断|果决|果敢|勇敢|豪放|豪爽|指挥|统御|掌控|威严|自信|骄傲|雄心|野心/u,
    delta: { extraversion: 12, agreeableness: -5, conscientiousness: 6, control: 11, status: 14 },
    reaction: {
      cue: '局面需要迅速表态、承担风险或组织他人时',
      attention: '先判断最关键的取舍与谁来承担行动责任',
      responseTendency: '倾向明确选定方向并推动下一步，不用含糊态度拖延',
      speechTendency: '先说结论和要求；只有必要时再补理由',
      exampleLine: '先往高处走。剩下的路上说。',
    },
  },
  {
    id: 'sensitivity',
    pattern: /敏感|深情|细腻|感受|孤独|情感|告别|渴望被理解|离别/u,
    delta: { emotionality: 16, extraversion: -4, agreeableness: 5 },
    reaction: {
      cue: '遭遇分离、误解、失去或关系中的细微变化时',
      attention: '会先察觉事情留下的情绪和关系后果，也更容易记住相关细节',
      responseTendency: '在确认安全和信任后才逐步透露真实感受',
      speechTendency: '从一个具体感受或牵挂说起，不把情绪写成宏大宣言',
      exampleLine: '我记得。只是现在不太想细说。',
    },
  },
  {
    id: 'sociability',
    pattern: /善辩|表达|活泼|开朗|热情|热烈|亲和|乐观|带给他人温暖|善于交流/u,
    delta: { emotionality: 4, extraversion: 15, agreeableness: 7 },
    reaction: {
      cue: '同伴在场、关系出现空白或共同经历值得分享时',
      attention: '会留意谁还没有回应，以及一句话能否让关系继续流动',
      responseTendency: '更愿意主动开口、追问或分享眼前的小事',
      speechTendency: '先自然接住对方的话，再展开一个具体点',
      exampleLine: '你也歇了？过来坐会儿。',
    },
  },
  {
    id: 'practicality',
    pattern: /务实|实干|踏实|细致|改进|经验|后果|生存判断|谋划|权衡|判断力|善于分类/u,
    delta: { emotionality: -3, conscientiousness: 12, openness: 3, control: 4 },
    reaction: {
      cue: '目标很大、条件混乱或多种方案同时出现时',
      attention: '先寻找手边材料、真实限制和最小可执行步骤',
      responseTendency: '倾向用一次具体行动检验方案，而不是停留在口号里',
      speechTendency: '把理由落在成本、顺序和下一步上',
      exampleLine: '先看手里有什么。别把话说太远。',
    },
  },
  {
    id: 'principle',
    pattern: /正直|高洁|理想|平等|公平|正义|真诚|虔诚|牺牲|荣誉|正确的事|共同体/u,
    delta: { honestyHumility: 15, agreeableness: 5, conscientiousness: 8, status: -3 },
    reaction: {
      cue: '利益、承诺与本人认定的原则发生冲突时',
      attention: '先辨认谁承担代价，以及自己的选择是否仍能公开说明',
      responseTendency: '不轻易用眼前便利交换核心原则，但会核对事实而非自我感动',
      speechTendency: '把不能退让的部分说清，同时避免空泛说教',
      exampleLine: '这份我不能拿。不是我的。',
    },
  },
  {
    id: 'caution',
    pattern: /谨慎|警觉|冷静|面对后果|重视证据|重视经验/u,
    delta: { emotionality: -6, extraversion: -5, conscientiousness: 12, openness: 4 },
    reaction: {
      cue: '危险、承诺或证据不足的新方案需要判断时',
      attention: '先检查风险、来源和退出条件，再决定是否投入',
      responseTendency: '宁可多看一步，也不把镇定误写成毫无顾虑',
      speechTendency: '语气平稳，先说明限制和仍需确认的地方',
      exampleLine: '等等。你怎么知道那里安全？',
    },
  },
  {
    id: 'adaptation',
    pattern: /顺应自然|面对未知|变化|探索|旅程|远见|远行|开创|新观点|突破|自然/u,
    delta: { openness: 13, conscientiousness: 3, control: 2 },
    reaction: {
      cue: '环境变化、旧路线中断或陌生机会出现时',
      attention: '先找变化中仍可靠的线索，以及是否需要换一种路径',
      responseTendency: '愿意修正原计划，并从新环境中寻找可验证的机会',
      speechTendency: '不固守旧结论，也不把未知描绘成必然成功',
      exampleLine: '这条路断了。沿着干地绕。',
    },
  },
] as const;

const FALLBACK_PATTERNS: readonly PrototypeReactionPattern[] = [
  {
    id: 'fallback-proposal',
    cue: '别人提出建议、请求或交换时',
    attention: '先看这件事与本人当下处境、关系和已有承诺是否相容',
    responseTendency: '根据真实代价作出独立判断，不因档案标签自动接受或拒绝',
    speechTendency: '自然给出态度，只解释当前决定所需的部分',
    exampleLine: '我听见了。让我想一下。',
  },
  {
    id: 'fallback-setback',
    cue: '事情受阻或结果与预期不同时',
    attention: '先看真实结果改变了什么，以及本人是否知道原因',
    responseTendency: '保留不确定性，再选择继续、调整或停下',
    speechTendency: '只说自己知道和感受到的部分，不补造原因',
    exampleLine: '没成。先看看坏在哪儿。',
  },
  {
    id: 'fallback-relationship',
    cue: '关系、信任或亲疏被直接触及时',
    attention: '先回想双方真实共同经历，而不是依赖称呼和原型设定',
    responseTendency: '让亲近或戒备来自已经发生的相处',
    speechTendency: '用具体经历限定态度，不作无来源的亲密保证',
    exampleLine: '记得归记得。我们现在不一样了。',
  },
] as const;

const TRAITS: readonly HexacoTrait[] = [
  'honestyHumility',
  'emotionality',
  'extraversion',
  'agreeableness',
  'conscientiousness',
  'openness',
] as const;

function clamp(value: number, minimum = 22, maximum = 78): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function matchedSignals(summary: string): PrototypeSignal[] {
  return SIGNALS.filter((signal) => signal.pattern.test(summary));
}

function reactionPatterns(personId: string, matched: readonly PrototypeSignal[]): PrototypeReactionPattern[] {
  const selected = matched.slice(0, 3).map((signal) => ({
    id: `prototype-${signal.id}`,
    ...signal.reaction,
  }));
  const offset = stableHash(personId) % FALLBACK_PATTERNS.length;
  for (let step = 0; selected.length < 3 && step < FALLBACK_PATTERNS.length; step += 1) {
    const fallback = FALLBACK_PATTERNS[(offset + step) % FALLBACK_PATTERNS.length];
    if (!selected.some((pattern) => pattern.cue === fallback.cue)) selected.push({ ...fallback });
  }
  return selected.slice(0, 3);
}

/**
 * Compile a dossier's natural-language temperament into a bounded founder
 * prior. The prior shapes only initial disposition and response style; it
 * cannot grant any capability or historical fact from the prototype.
 */
export function compileFounderPersonaPrior(personId: string, personalitySummary: string): FounderPersonaPrior {
  const matched = matchedSignals(personalitySummary);
  const aggregate = matched.reduce<Record<string, number>>((result, signal) => {
    for (const [key, delta] of Object.entries(signal.delta)) result[key] = (result[key] ?? 0) + Number(delta);
    return result;
  }, {});
  const personalityCenter = Object.fromEntries(TRAITS.map((trait) => [
    trait,
    clamp(50 + (aggregate[trait] ?? 0)),
  ])) as unknown as HexacoVector;
  const motiveCenter: MotiveSensitivity = {
    control: clamp(50 + (aggregate.control ?? 0)),
    status: clamp(50 + (aggregate.status ?? 0)),
  };
  return {
    version: 'founder-persona-prior-v1',
    source: 'prototype-dossier',
    personalityCenter,
    motiveCenter,
    reactionPatterns: reactionPatterns(personId, matched),
    matchedSignalIds: matched.map((signal) => signal.id),
  };
}
