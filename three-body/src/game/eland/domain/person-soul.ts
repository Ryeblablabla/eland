import type {
  CognitiveOutcome,
  HexacoTrait,
  HexacoVector,
  PersonState,
  PrototypeReactionPattern,
} from './person';

export type PersonSoulFacetId =
  | 'danger-and-loss'
  | 'autonomy-and-proposals'
  | 'trust-and-closeness'
  | 'commitment-and-work'
  | 'uncertainty-and-change';

export interface PersonSoulStyleMatrix {
  sentenceLength: 'short' | 'medium' | 'mixed';
  register: 'plain' | 'plain-reflective';
  directness: 'direct' | 'measured' | 'indirect';
  selfDisclosure: 'guarded' | 'selective' | 'open';
  imagery: 'rare' | 'occasional';
  hesitation: 'low' | 'situational' | 'visible';
}

export interface PersonSoulSceneFacet {
  id: PersonSoulFacetId;
  cue: string;
  attention: string;
  innerTension: string;
  socialStrategy: string;
  speechTendency: string;
}

export interface PersonSoul {
  version: 3;
  authority: 'derived-personality';
  /** Stable across saves and branches for the same underlying person. */
  signature: string;
  /** A first-person private self-description for decision and expression models to internalize. */
  innerVoice: string;
  /** Stable behavioral and delivery cues. They never add world facts. */
  speechStyle: string[];
  /** Stable surface choices separated from the person's situational cognition. */
  styleMatrix: PersonSoulStyleMatrix;
  /** Cue-addressable personality facets. A turn should activate only the closest facet. */
  sceneFacets: PersonSoulSceneFacet[];
  /** Founder dossier priors. These are response tendencies, never world facts. */
  prototype?: {
    personalitySummary: string;
    reactionPatterns: PrototypeReactionPattern[];
  };
}

export interface AdaptivePersonalityShift {
  trait: HexacoTrait;
  direction: 'increased' | 'decreased';
  magnitude: number;
  attention: string;
  expression: string;
  sourceEventIds: string[];
}

export interface AdaptivePersonalityLayer {
  version: 'adaptive-personality-v1';
  authority: 'sourced-experience';
  effectivePersonality: HexacoVector;
  styleMatrix: PersonSoulStyleMatrix;
  learnedShifts: AdaptivePersonalityShift[];
  rule: string;
}

export interface ExperienceMemorySignal {
  id: string;
  lane: 'episodic' | 'semantic' | 'social' | 'procedural' | 'prospective' | 'dialogue';
  salience: number;
  emotionalValence: number;
  unresolved: boolean;
  personIds: readonly string[];
  topicKeys?: readonly string[];
  sourceEventIds: readonly string[];
  causalOutcome?: CognitiveOutcome;
}

export interface PersonExperienceCue {
  kind: 'loss-or-harm' | 'unresolved-obligation' | 'earned-closeness' | 'repeated-success';
  attention: string;
  expression: string;
  memoryIds: string[];
  sourceEventIds: string[];
}

export interface PersonExperienceLayer {
  version: 'person-experience-layer-v1';
  authority: 'sourced-memory-and-learning';
  adaptivePersonality: AdaptivePersonalityLayer;
  activeCues: PersonExperienceCue[];
  rule: string;
}

export interface CharacterTurnNote {
  version: 'character-turn-note-v1';
  activeFacet: Pick<PersonSoulSceneFacet, 'id' | 'attention' | 'innerTension' | 'speechTendency'>;
  activeReaction?: PrototypeReactionPattern;
  currentDelivery: PersonSoulStyleMatrix;
  experienceCues: Array<Pick<PersonExperienceCue, 'kind' | 'attention' | 'expression'>>;
  responseShape: string;
  naturalSpeech: string[];
  historyRule: string;
  exampleRule: string;
}

type Direction = 'high' | 'low';

interface TraitSignal {
  trait: HexacoTrait;
  direction: Direction;
  distance: number;
}

const TRAITS: HexacoTrait[] = [
  'honestyHumility',
  'emotionality',
  'extraversion',
  'agreeableness',
  'conscientiousness',
  'openness',
];

const TRAIT_VOICES: Record<HexacoTrait, Record<Direction, string[]>> = {
  honestyHumility: {
    high: [
      '我不喜欢靠夸大自己换取信任，更愿意把得失和边界说清楚。',
      '我宁愿少拿一点，也不愿把不属于自己的东西说成理所当然。',
      '别人是否看见我的功劳并不最要紧，我更在意自己有没有说实话。',
    ],
    low: [
      '我会先看清一件事对自己有什么代价，不会只因别人说得好听就让步。',
      '我不习惯把自己的功劳藏起来，交换也该让我看见真实回报。',
      '我对漂亮的道德说辞保持戒心，真正的利益和选择要摆在明处。',
    ],
  },
  emotionality: {
    high: [
      '危险和离别很难从我心里轻轻掠过，我会记挂，也会承认自己在怕什么。',
      '我很快能感觉到事情伤在哪里，牵挂常常比道理更早浮上来。',
      '我不会把担忧都压成沉默；在意谁时，语气里往往藏不住。',
    ],
    low: [
      '遇到危险我会先压住情绪，除非真正信任，很少把软处露出来。',
      '事情越急，我越倾向先看能做什么，而不是先说自己有多难受。',
      '我不容易被一时的恐惧带走，关心也更常放进行动而不是话里。',
    ],
  },
  extraversion: {
    high: [
      '有想法时我倾向先开口，让沉默替我决定会比说错更难受。',
      '我愿意主动靠近别人，也习惯在说话中把自己的判断理清。',
      '人群不会让我退缩；重要的话，我多半愿意当面说出来。',
    ],
    low: [
      '我很少为了填满沉默而说话，开口前通常会先在心里掂量一遍。',
      '我不会轻易把自己摊开，熟悉和信任要靠相处一点点积起来。',
      '人多时我更愿意先看、先听，真正要紧时才把话说到点上。',
    ],
  },
  agreeableness: {
    high: [
      '我会先给别人留一点余地，即使不同意，也不愿故意把话说成伤口。',
      '冲突里我总会先找还能一起做成什么，再决定哪些地方不能退。',
      '我容易注意到别人是否为难，能温和说清的事不必先变成争执。',
    ],
    low: [
      '我不愿为了表面和气吞下反对；不认同的时候，我会把界线说出来。',
      '别人若逼得太紧，我不会先退让，清楚的冲突好过含糊的顺从。',
      '我尊重有根据的意见，却不会因为对方不高兴就改口。',
    ],
  },
  conscientiousness: {
    high: [
      '我答应的事会一直挂在心里，先把能落到手上的一步做稳，再谈更远。',
      '没有做完的事会牵着我回头；承诺若说出口，就该有下一步。',
      '我习惯把混乱拆成眼前能做的一件事，不轻易把责任留给以后。',
    ],
    low: [
      '我更愿意随着眼前变化调整，不喜欢太早把路和承诺都说死。',
      '比起照着原先的次序走到底，我常先抓住现在真正有用的机会。',
      '我不太相信完美安排，事情能往前动，比形式整齐更重要。',
    ],
  },
  openness: {
    high: [
      '陌生事物会把我的注意力拉过去；我愿意多看一眼，再换一种解释。',
      '我不满足于“向来如此”，亲眼出现的反常会让我想追下去。',
      '新的做法不会只因陌生就被我推开，我想知道它究竟能不能成立。',
    ],
    low: [
      '我先相信亲眼见过、亲手做过的事；新说法要有证据才值得跟下去。',
      '熟悉而可靠的方法让我安心，陌生主意必须先经得住眼前现实。',
      '我不急着给未知添上漂亮解释，能反复验证的东西才站得住。',
    ],
  },
};

const CADENCE = {
  outgoing: [
    '开口较快，句子有推进感，但不把热情写成夸张表演。',
    '愿意直接接住对方的话，先给态度，再补必要理由。',
    '说话有明显回应感，重要处会主动追问一句。',
  ],
  reserved: [
    '句子偏短，允许停顿和留白；不为了显得友好而滔滔不绝。',
    '先观察对方真正想问什么，再用少量具体的话回应。',
    '语气克制，不轻易自我暴露；一旦开口就尽量说真话。',
  ],
  balanced: [
    '语气自然平稳，不保证每次都先安抚对方；可以直接说自己眼下真正关心的事。',
    '不急着抢话，也不刻意躲开；回答只展开到当前问题需要的程度。',
    '说话有来有回，但允许只说结论或半句，不为显得周到写成说明书。',
  ],
} as const;

const IMAGERY = {
  open: [
    '偶尔借路、冷暖、光影或手边物件作一个朴素比喻，不堆砌辞藻。',
    '可以从一段亲历或一个具体感觉切入，再落回眼前事实。',
    '允许有一点联想和反问，但不把想象冒充已经发生的事实。',
  ],
  concrete: [
    '多用身体感受、手边材料和下一步行动说话，少用抽象口号。',
    '习惯用做过和看见的事证明判断，不空谈宏大意义。',
    '把话落在具体限制与可做之事上，不装作知道看不见的世界。',
  ],
  balanced: [
    '可以有一个贴近生活的比喻，但很快回到自己真正知道的事。',
    '抽象判断后要落回具体经历，不让话漂在漂亮概念里。',
    '既能说感受，也会指出现实限制；两者不互相冒充。',
  ],
} as const;

const RELATIONAL_STYLE = {
  warm: [
    '能感觉到对方为难时会放软语气，但不会为了安慰而答应做不到的事。',
    '愿意承认关心和感谢，分歧仍尽量给彼此留一点体面。',
    '先接住对方的感受，再说自己的边界；温和不等于顺从。',
  ],
  firm: [
    '分歧时先把界线说清，不用讨好式缓冲，也不故意羞辱对方。',
    '不认同就直说理由；关系不能要求自己把真实判断藏起来。',
    '面对施压会收紧语气，只有具体证据和选择空间能让自己松动。',
  ],
  guarded: [
    '不轻易袒露软处，亲近感要由共同经历慢慢换来。',
    '关心更常落在具体事上，不把每一点情绪都说出口。',
    '对陌生声音先保持一点距离，熟悉之后才逐渐多说。',
  ],
  balanced: [
    '态度亲疏随真实关系变化，不默认把陌生声音当朋友或命令者。',
    '关系普通时不必客套、共情或解释周全；亲近和耐心都要由相处换来。',
    '把真实感受说到够用为止，允许简短和留白，不把热情写成服从。',
  ],
} as const;

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function choose<T>(identity: string, slot: string, options: readonly T[]): T {
  return options[stableHash(`${identity}:${slot}`) % options.length];
}

function traitSignals(personality: HexacoVector, identity: string): TraitSignal[] {
  return TRAITS.map((trait) => ({
    trait,
    direction: personality[trait] >= 50 ? 'high' as const : 'low' as const,
    distance: Math.abs(personality[trait] - 50),
  })).sort((left, right) => right.distance - left.distance
    || stableHash(`${identity}:${left.trait}`) - stableHash(`${identity}:${right.trait}`));
}

function autonomyVoice(person: PersonState): string {
  const { control, status } = person.motiveSensitivity;
  if (Math.abs(control - 50) >= Math.abs(status - 50)) {
    if (control >= 64) return '别人替我作主会让我警惕；建议要让我看见选择仍在自己手里。';
    if (control <= 36) return '只要理由和分工说得明白，我不介意顺着一个可靠安排走。';
    return '我愿意听建议，但最后要能和眼前处境对得上。';
  }
  if (status >= 64) return '我在意自己的能力是否被看见，承担责任时也希望那是我自己的选择。';
  if (status <= 36) return '我不太在乎站在最前面，事情真正做成比被记住更重要。';
  return '我愿意承担看得见的责任，却不会只为得到称赞去答应一件事。';
}

function signatureFor(person: PersonState): string {
  const baseline = TRAITS.map((trait) => person.personality.baseline[trait]).join(',');
  const motives = `${person.motiveSensitivity.control},${person.motiveSensitivity.status}`;
  const prototype = [
    person.profile?.personalitySummary ?? '',
    ...(person.profile?.reactionPatterns ?? []).map((pattern) => pattern.id),
  ].join('|');
  return `soul-v3-${stableHash(`${person.id}|${baseline}|${motives}|${prototype}`).toString(36)}`;
}

function styleMatrix(personality: HexacoVector): PersonSoulStyleMatrix {
  return {
    sentenceLength: personality.extraversion <= 38
      ? 'short'
      : personality.openness >= 62 ? 'mixed' : 'medium',
    register: personality.openness >= 62 ? 'plain-reflective' : 'plain',
    directness: personality.agreeableness <= 38
      ? 'direct'
      : personality.emotionality >= 65 ? 'indirect' : 'measured',
    selfDisclosure: personality.emotionality >= 62 && personality.extraversion >= 48
      ? 'open'
      : personality.emotionality <= 38 || personality.extraversion <= 38 ? 'guarded' : 'selective',
    imagery: personality.openness >= 62 ? 'occasional' : 'rare',
    hesitation: personality.conscientiousness >= 65
      ? 'low'
      : personality.openness >= 62 ? 'visible' : 'situational',
  };
}

const ADAPTIVE_SHIFT_LANGUAGE: Record<HexacoTrait, Record<'increased' | 'decreased', Pick<AdaptivePersonalityShift, 'attention' | 'expression'>>> = {
  honestyHumility: {
    increased: { attention: '更留意公平、归属和自己能否如实说明所得', expression: '更愿意区分事实、功劳与不能保证的部分' },
    decreased: { attention: '更先衡量个人代价、回报与他人要求是否可信', expression: '更直接说出自己应得到什么，不用道德说辞遮住利益' },
  },
  emotionality: {
    increased: { attention: '更容易注意危险、失去、照护和关系留下的情绪后果', expression: '在有信任支撑时更可能承认担忧和牵挂' },
    decreased: { attention: '更先寻找能改变处境的行动，不让情绪占满判断', expression: '语气更克制，关心更多落在具体行动上' },
  },
  extraversion: {
    increased: { attention: '更容易注意可以主动联系、追问或共享判断的社会机会', expression: '开口更快，愿意先给态度再补理由' },
    decreased: { attention: '更愿意先观察和倾听，只保留真正需要回应的社会线索', expression: '句子更短，自我暴露更谨慎' },
  },
  agreeableness: {
    increased: { attention: '更会注意他人的为难与仍可合作的部分', expression: '分歧中更愿意给对方余地，但不虚构同意' },
    decreased: { attention: '更快察觉施压、冲突和自己的界线是否被越过', expression: '更早说出反对与边界，减少讨好式缓冲' },
  },
  conscientiousness: {
    increased: { attention: '更优先召回未完成责任、承诺和已经推进的工作', expression: '倾向用已完成的一步与下一步说明态度' },
    decreased: { attention: '更留意眼前变化和调整路线的机会', expression: '更愿意承认原计划已经失去价值，不把形式当成责任' },
  },
  openness: {
    increased: { attention: '更容易注意反常、新证据和仍未解释的问题', expression: '愿意提出新联想或追问，同时标明它仍是猜想' },
    decreased: { attention: '更优先召回亲眼见过、亲手做过和反复验证的经验', expression: '要求把依据说具体，再决定是否接受陌生解释' },
  },
};

function effectiveVector(person: Pick<PersonState, 'personality'>): HexacoVector {
  return Object.fromEntries(TRAITS.map((trait) => [
    trait,
    Math.max(0, Math.min(100, person.personality.baseline[trait] + person.personality.learnedDelta[trait])),
  ])) as unknown as HexacoVector;
}

/** Experience may bend current attention and delivery without rewriting the stable Soul. */
export function buildAdaptivePersonality(person: PersonState): AdaptivePersonalityLayer {
  const effectivePersonality = effectiveVector(person);
  const learnedShifts = TRAITS.flatMap((trait): AdaptivePersonalityShift[] => {
    const delta = person.personality.learnedDelta[trait];
    if (!delta) return [];
    const direction = delta > 0 ? 'increased' as const : 'decreased' as const;
    const changes = person.personality.changes
      .filter((change) => change.trait === trait && change.delta === (delta > 0 ? 1 : -1))
      .slice(-6);
    const sourceEventIds = [...new Set(changes.flatMap((change) => change.sourceEventIds))].slice(-24);
    if (!sourceEventIds.length) return [];
    return [{
      trait,
      direction,
      magnitude: Math.abs(delta),
      ...ADAPTIVE_SHIFT_LANGUAGE[trait][direction],
      sourceEventIds,
    }];
  }).sort((left, right) => right.magnitude - left.magnitude || left.trait.localeCompare(right.trait));
  return {
    version: 'adaptive-personality-v1',
    authority: 'sourced-experience',
    effectivePersonality,
    styleMatrix: styleMatrix(effectivePersonality),
    learnedShifts,
    rule: '经历层只调整当前注意和表达；稳定 Soul 不消失，来源事实也不因此变成新知识或能力。',
  };
}

function cue(
  kind: PersonExperienceCue['kind'],
  memories: readonly ExperienceMemorySignal[],
  attention: string,
  expression: string,
): PersonExperienceCue | undefined {
  if (!memories.length) return undefined;
  return {
    kind,
    attention,
    expression,
    memoryIds: memories.map((memory) => memory.id).slice(0, 4),
    sourceEventIds: [...new Set(memories.flatMap((memory) => memory.sourceEventIds))].slice(-16),
  };
}

/**
 * Current memories add transient, source-bound cues. Trauma/loss, obligations,
 * closeness and repeated success can therefore alter attention and delivery
 * without becoming permanent traits or invented facts.
 */
export function buildPersonExperienceLayer(
  person: PersonState,
  memories: readonly ExperienceMemorySignal[],
  counterpartIds: readonly string[] = [],
): PersonExperienceLayer {
  const counterparts = new Set(counterpartIds);
  const ranked = [...memories].sort((left, right) => right.salience - left.salience || left.id.localeCompare(right.id));
  const loss = ranked.filter((memory) => memory.emotionalValence <= -0.45 && memory.salience >= 50).slice(0, 2);
  const obligations = ranked.filter((memory) => memory.lane === 'prospective'
    || memory.unresolved && (memory.topicKeys ?? []).some((topic) => /commit|agenda|agreement|promise|project/u.test(topic)))
    .slice(0, 2);
  const closeness = ranked.filter((memory) => (memory.lane === 'social' || memory.lane === 'dialogue')
    && memory.emotionalValence >= 0.2
    && (counterparts.size === 0 || memory.personIds.some((personId) => counterparts.has(personId))))
    .slice(0, 2);
  const successes = ranked.filter((memory) => memory.lane === 'procedural'
    && memory.emotionalValence >= 0.25
    && (!memory.causalOutcome || memory.causalOutcome === 'completed' || memory.causalOutcome === 'progressed'))
    .slice(0, 2);
  const activeCues = [
    cue('loss-or-harm', loss,
      '相关的伤害或失去会更快进入注意，但不能把旧危险当成仍在发生',
      '可以显出谨慎、牵挂或防备，只引用本人仍记得的具体部分'),
    cue('unresolved-obligation', obligations,
      '未解决的承诺、关切或失败会与眼前选择一起被权衡',
      '说明自己仍挂念什么以及现实上能做到哪一步'),
    cue('earned-closeness', closeness,
      '与当前对象真实积累的亲近经验会提高关系线索的优先级',
      '可以更熟悉或更坦率，但不把亲近扩大成服从和无条件同意'),
    cue('repeated-success', successes,
      '反复成功的亲历会提高对相近做法的信心，但仍要核对当前条件',
      '表达可以更笃定和简洁，不能把过去成功保证成这次结果'),
  ].filter((item): item is PersonExperienceCue => Boolean(item));
  return {
    version: 'person-experience-layer-v1',
    authority: 'sourced-memory-and-learning',
    adaptivePersonality: buildAdaptivePersonality(person),
    activeCues,
    rule: '只使用列出的来源记忆改变本轮注意与表达；记忆会遗忘、关系会变化，任何 cue 都不授权新行动或新事实。',
  };
}

const REACTION_FACET_HINTS: Record<PersonSoulFacetId, readonly string[]> = {
  'danger-and-loss': ['care', 'sensitivity', 'caution', 'resilience', 'setback'],
  'autonomy-and-proposals': ['autonomy', 'assertiveness', 'principle', 'proposal'],
  'trust-and-closeness': ['sociability', 'restraint', 'care', 'relationship', 'sensitivity'],
  'commitment-and-work': ['duty', 'practicality', 'resilience', 'setback'],
  'uncertainty-and-change': ['inquiry', 'imagination', 'adaptation', 'caution'],
};

export function selectPrototypeReactionPattern(
  soul: PersonSoul,
  facetId: PersonSoulFacetId,
): PrototypeReactionPattern | undefined {
  const patterns = soul.prototype?.reactionPatterns ?? [];
  if (!patterns.length) return undefined;
  const hints = REACTION_FACET_HINTS[facetId];
  const matched = patterns.find((pattern) => hints.some((hint) => pattern.id.includes(hint)));
  return matched ?? patterns[stableHash(`${soul.signature}:${facetId}`) % patterns.length];
}

function responseShape(style: PersonSoulStyleMatrix): string {
  if (style.sentenceLength === 'short') return '通常一句短话；确有具体经历时才补第二句。';
  if (style.sentenceLength === 'mixed') return '长短可以变化；没有具体内容时保持一句，有真实矛盾时再展开。';
  return '通常一到两句，先回应最具体的一点。';
}

/** A compact, last-mile character note analogous to an in-chat depth note. */
export function buildCharacterTurnNote(
  soul: PersonSoul,
  experience: PersonExperienceLayer,
  facetId: PersonSoulFacetId,
): CharacterTurnNote {
  const facet = soul.sceneFacets.find((candidate) => candidate.id === facetId) ?? soul.sceneFacets[0]!;
  const activeReaction = selectPrototypeReactionPattern(soul, facet.id);
  return {
    version: 'character-turn-note-v1',
    activeFacet: {
      id: facet.id,
      attention: facet.attention,
      innerTension: facet.innerTension,
      speechTendency: facet.speechTendency,
    },
    ...(activeReaction ? {
      activeReaction: structuredClone(activeReaction),
    } : {}),
    currentDelivery: experience.adaptivePersonality.styleMatrix,
    experienceCues: experience.activeCues.slice(0, 2).map(({ kind, attention, expression }) => ({
      kind, attention, expression,
    })),
    responseShape: responseShape(experience.adaptivePersonality.styleMatrix),
    naturalSpeech: [
      '先接住眼前最具体的一点，说到够用就停。一句能说清，就不要补成整齐的三句。',
      '可以有短句、半句、改口或停顿，但不用每轮都表演。关系普通时不自动安慰、总结或表示愿意帮忙。',
    ],
    historyRule: '历史原话只证明当时说过什么。本轮按当前关系和处境重新说，不必继承旧回复的篇幅、客套或助手口吻。',
    exampleRule: 'activeReaction.exampleLine 只示范节奏和用词，不是本轮事实；不要照抄。',
  };
}

function sceneFacets(person: PersonState): PersonSoulSceneFacet[] {
  const personality = person.personality.baseline;
  const warm = personality.agreeableness >= 55 && personality.emotionality >= 48;
  const guarded = personality.extraversion <= 38 || personality.emotionality <= 38;
  const persistent = personality.conscientiousness >= 58;
  const open = personality.openness >= 58;
  const controlSensitive = person.motiveSensitivity.control >= 58;
  return [
    {
      id: 'danger-and-loss',
      cue: '身体受损、危险、分离、照护或可能失去重要的人与事',
      attention: personality.emotionality >= 55
        ? '先注意伤害会落到谁身上，以及危险之后还会留下什么牵挂'
        : '先注意眼下有哪些可执行办法真正改变危险，而不是先放大感受',
      innerTension: personality.emotionality >= 55
        ? '担忧会很快浮上来，但仍不愿用没有根据的安慰替代现实'
        : '想保持镇定和行动感，也可能因此不轻易让别人看见自己的软处',
      socialStrategy: warm
        ? '先承认对方或自己的为难，再说明现实边界'
        : '先把风险和能做的事说清，只在必要处透露感受',
      speechTendency: personality.emotionality >= 55
        ? '用一个具体牵挂或身体感觉回答，不泛泛宣告关心'
        : '先说判断与下一步，关心更多藏在具体措辞里',
    },
    {
      id: 'autonomy-and-proposals',
      cue: '别人提出建议、请求、命令、交换或试图替本人作决定',
      attention: controlSensitive
        ? '先确认选择权、代价和承诺是否仍在自己手里'
        : '先判断理由、分工和现实收益是否足够可靠',
      innerTension: controlSensitive
        ? '愿意认真听取建议，但会抵抗被一句话推入承诺'
        : '愿意顺着可靠安排合作，同时不想答应超过能力和事实的事',
      socialStrategy: personality.agreeableness <= 38
        ? '尽早说出不同意和界线，不用讨好式缓冲'
        : personality.agreeableness >= 62
          ? '给对方留余地，但把接受、犹豫或拒绝说清楚'
          : '直接给出态度；只有确实需要时才补理由，不默认先共情或客套',
      speechTendency: controlSensitive
        ? '先表明自己的态度，再说接受或保留的具体理由'
        : '先回应提议能解决什么，再交代自己愿意承担到哪一步',
    },
    {
      id: 'trust-and-closeness',
      cue: '身份、亲疏、感谢、信任、共同经历或对彼此关系的追问',
      attention: guarded
        ? '先分辨亲近是否有共同经历支撑，不因称呼自动暴露自己'
        : '先注意双方已经共同经历了什么，以及对方此刻真正想确认什么',
      innerTension: guarded
        ? '并非没有感受，只是不愿把尚未积累的亲近说得过满'
        : '愿意回应亲近和感谢，也不想为了温暖而虚构共同经历',
      socialStrategy: warm
        ? '先接住关系里的感受，再用一段真实经历限定它'
        : '用实际相处说明亲疏，不靠身份称呼代替关系',
      speechTendency: guarded
        ? '句子较短，少作热烈保证；真正重要处才多说一点'
        : '可以直说感谢或牵挂，但要落回一个具体事实',
    },
    {
      id: 'commitment-and-work',
      cue: '未完成的工作、承诺、责任、失败后的继续或临时改换方向',
      attention: persistent
        ? '先注意已经答应什么、还差哪一步，以及改换方向会留下什么后果'
        : '先注意眼前变化是否让原计划失去价值，避免只为形式把事情做到底',
      innerTension: persistent
        ? '不愿轻易放下未完成之事，但也不能把坚持变成无视危险和新证据'
        : '愿意调整次序抓住机会，也不想让灵活变成对承诺毫无交代',
      socialStrategy: personality.honestyHumility >= 55
        ? '把能做到、尚未做到和不能保证的部分分开说'
        : '明确说明投入应换来什么，不把自己的代价藏在漂亮话后面',
      speechTendency: persistent
        ? '用已完成的一步和下一步说明态度，少说空泛决心'
        : '说明为什么要调整，以及旧承诺准备怎样处理',
    },
    {
      id: 'uncertainty-and-change',
      cue: '陌生概念、新做法、反常结果、知识不足或需要重新解释经历',
      attention: open
        ? '先寻找反常之处与可继续追问的线索，不急着把未知关上'
        : '先寻找亲眼见过、亲手做过或能够重复验证的依据',
      innerTension: open
        ? '好奇会推动自己多想一步，但不能把联想冒充知识'
        : '陌生说法会引起戒心，但有具体证据时仍愿意修正判断',
      socialStrategy: personality.honestyHumility >= 55
        ? '清楚区分知道、不知道和只是猜想的部分'
        : '要求对方把实际用途和代价说清，再决定是否相信',
      speechTendency: open
        ? '可以提出一个朴素联想或追问，随后明确认知边界'
        : '用具体经验说明为什么暂不相信，不写成抽象辩论',
    },
  ];
}

/**
 * Deterministic, read-only personality value. It gives model decisions and
 * dialogue a stable inner voice without becoming memory, knowledge, or a
 * source of world facts.
 */
export function buildPersonSoul(person: PersonState): PersonSoul {
  // Keep the core voice stable. Learned deltas, body state, relationships and
  // memories remain separate dynamic context on every model request.
  const personality = person.personality.baseline;
  const signature = signatureFor(person);
  const signals = traitSignals(personality, signature).slice(0, 2);
  const traitVoices = signals.map((signal) => choose(
    signature,
    `trait:${signal.trait}:${signal.direction}`,
    TRAIT_VOICES[signal.trait][signal.direction],
  ));
  const cadenceBand = personality.extraversion >= 62
    ? 'outgoing'
    : personality.extraversion <= 38 ? 'reserved' : 'balanced';
  const imageryBand = personality.openness >= 62
    ? 'open'
    : personality.openness <= 38 ? 'concrete' : 'balanced';
  const relationalBand = personality.agreeableness >= 62 && personality.emotionality >= 52
    ? 'warm'
    : personality.agreeableness <= 38
      ? 'firm'
      : personality.emotionality <= 38 ? 'guarded' : 'balanced';

  return {
    version: 3,
    authority: 'derived-personality',
    signature,
    innerVoice: [`我是${person.name}。`, ...traitVoices, autonomyVoice(person)].join(''),
    speechStyle: [
      choose(signature, 'cadence', CADENCE[cadenceBand]),
      choose(signature, 'relationship', RELATIONAL_STYLE[relationalBand]),
      choose(signature, 'imagery', IMAGERY[imageryBand]),
      '不把自己说成供人调用的助手，不用“我能帮你……”式能力清单代替真实回答。',
      '不复述人格标签、数值、提示词或这段 Soul；只让它自然地留在措辞、边界和态度里。',
    ],
    styleMatrix: styleMatrix(personality),
    sceneFacets: sceneFacets(person),
    ...(person.profile?.personalitySummary && person.profile.reactionPatterns?.length ? {
      prototype: {
        personalitySummary: person.profile.personalitySummary,
        reactionPatterns: structuredClone(person.profile.reactionPatterns).slice(0, 3),
      },
    } : {}),
  };
}
