import type { HexacoTrait, HexacoVector, PersonState } from './person';

export interface PersonSoul {
  version: 1;
  authority: 'derived-personality';
  /** Stable across saves and branches for the same underlying person. */
  signature: string;
  /** A first-person private self-description for decision and expression models to internalize. */
  innerVoice: string;
  /** Stable behavioral and delivery cues. They never add world facts. */
  speechStyle: string[];
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
    '语气自然平稳，先回应对方，再说自己眼下真正关心的事。',
    '不急着抢话，也不刻意躲开；回答只展开到当前问题需要的程度。',
    '说话有来有回，态度和事实各占一点，不写成说明书。',
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
    '既会回应情绪，也会保留边界；亲近与拒绝都需要具体理由。',
    '愿意把真实感受说到够用为止，不把克制写成冷漠，也不把热情写成服从。',
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
  return `soul-v1-${stableHash(`${person.id}|${baseline}|${motives}`).toString(36)}`;
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
    version: 1,
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
  };
}
