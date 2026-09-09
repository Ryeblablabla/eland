import './RecordedDialogue.css';

export type RecordedDialogueKey = 'teaching' | 'future';

export interface RecordedDialogueProps {
  record: RecordedDialogueKey;
  /** Seconds from the beginning of this dialogue shot; deterministic when seeking. */
  time: number;
}

interface DialogueRecord {
  agentId: string;
  name: string;
  sourceId: string;
  requestedAtMonth: number;
  completedAtMonth: number;
  question: string;
  fullReply: string;
  /** Every member is an unchanged, contiguous passage of fullReply, in order. */
  replyExcerpts: readonly string[];
  finalHoldSeconds: number;
}

/**
 * Exact persisted dialogue from civilization 16, branch root-1166699014-16.
 * Source: output/promo-v2/data/dialogue-records.json.
 * Both records have influenceStatus="none": these are conversations, not
 * commands accepted by a model. This component never submits an interaction.
 */
export const RECORDED_DIALOGUES: Record<RecordedDialogueKey, DialogueRecord> = {
  teaching: {
    agentId: 'born-16-cai-wenji-7',
    name: '孙疏影',
    sourceId: 'agent-conversation:17733b22f3fd81100b65ffe2',
    requestedAtMonth: 527,
    completedAtMonth: 528,
    question: '可是你的年纪已经很大了 早点教导其他人',
    fullReply: '年纪大确实是个坎儿，教人这事儿比我自己干还难。我手里这点铜和锡，离成器还远着呢，更别提去教别人造青铜了。不过既然你提了，或许可以换个方向？比如先看看南边那陶窑能不能借个火，或者把地上的黏土捡回来试试烧制？这些活儿虽然简单，但能让人明白些门道。',
    replyExcerpts: [
      '年纪大确实是个坎儿，教人这事儿比我自己干还难。',
      '比如先看看南边那陶窑能不能借个火，或者把地上的黏土捡回来试试烧制？',
    ],
    finalHoldSeconds: 5,
  },
  future: {
    agentId: 'born-193-cai-wenji-12',
    name: '后若水',
    sourceId: 'agent-conversation:e1b82e2580376b44dd7073bb',
    requestedAtMonth: 785,
    completedAtMonth: 786,
    question: '你们的文明。。。还能延续吗',
    fullReply: '能延续，但得靠我们自己一步步去争取。现在大家聚在一起，有蔡文姬、后羿还有后凌川，他们愿意跟着我走，这就是希望。不过文明这东西，光靠感情不够，还得看能不能找到足够的食物和水，能不能把日子过得下去。如果哪天大家散了，或者资源没了，那就算再亲密也没用。所以比起问‘还能不能’，我更关心‘现在该做什么’，比如怎么让大家吃饱，怎么让种子发芽。',
    replyExcerpts: ['能延续，但得靠我们自己一步步去争取。'],
    finalHoldSeconds: 4,
  },
};

const QUESTION_START = 0.45;
const QUESTION_CHARACTERS_PER_SECOND = 10;
const REPLY_CHARACTERS_PER_SECOND = 12;
const REPLY_DELAY = 0.8;

function replyText(record: DialogueRecord): string {
  // The ellipsis visibly marks the omitted middle of the original response.
  return record.replyExcerpts.join('\n……\n');
}

export function recordedDialogueTiming(key: RecordedDialogueKey) {
  const record = RECORDED_DIALOGUES[key];
  const questionCompleteAt = QUESTION_START
    + Array.from(record.question).length / QUESTION_CHARACTERS_PER_SECOND;
  const replyStartsAt = questionCompleteAt + REPLY_DELAY;
  const replyCompleteAt = replyStartsAt
    + Array.from(replyText(record)).length / REPLY_CHARACTERS_PER_SECOND;
  return {
    questionStartsAt: QUESTION_START,
    questionCompleteAt,
    replyStartsAt,
    replyCompleteAt,
    recommendedSeconds: Math.ceil(replyCompleteAt + record.finalHoldSeconds),
  };
}

function monthLabel(month: number): string {
  return `第 ${Math.floor((month - 1) / 12) + 1} 年 · ${((month - 1) % 12) + 1} 月`;
}

function prefix(text: string, elapsed: number, rate: number): string {
  return Array.from(text).slice(0, Math.max(0, Math.floor(elapsed * rate))).join('');
}

function opacityAt(time: number, startsAt: number, duration = 0.35): number {
  const progress = Math.min(1, Math.max(0, (time - startsAt) / duration));
  return progress * progress * (3 - 2 * progress);
}

function RecordedText({ full, visible, className }: {
  full: string;
  visible: string;
  className: string;
}) {
  return (
    <p className={`recorded-dialogue__text ${className}`}>
      <span className="recorded-dialogue__layout-text" aria-hidden="true">{full}</span>
      <span className="recorded-dialogue__visible-text">{visible}</span>
    </p>
  );
}

/** Read-only filming overlay. All reveal motion depends only on the time prop. */
export default function RecordedDialogue({ record: key, time }: RecordedDialogueProps) {
  const record = RECORDED_DIALOGUES[key];
  const timing = recordedDialogueTiming(key);
  const localTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  const reply = replyText(record);
  const opacity = opacityAt(localTime, 0);
  const replyOpacity = opacityAt(localTime, timing.replyStartsAt - 0.2);

  return (
    <aside
      className={`recorded-dialogue recorded-dialogue--${key}`}
      aria-label={`${record.name}的真实对话回放，回复节选`}
      data-source-id={record.sourceId}
      data-agent-id={record.agentId}
      data-influence-status="none"
      style={{ opacity, transform: `translateY(calc(-50% + ${(1 - opacity) * 18}px))` }}
    >
      <div className="recorded-dialogue__eyebrow">
        <span className="recorded-dialogue__replay-mark" aria-hidden="true">↺</span>
        <span>真实对话回放 · 第16号文明</span>
      </div>

      <div className="recorded-dialogue__question">
        <div className="recorded-dialogue__question-meta">
          <span>你</span>
          <time>{monthLabel(record.requestedAtMonth)}</time>
        </div>
        <RecordedText
          className="recorded-dialogue__question-text"
          full={record.question}
          visible={prefix(record.question, localTime - QUESTION_START, QUESTION_CHARACTERS_PER_SECOND)}
        />
      </div>

      <div className="recorded-dialogue__answer" style={{ opacity: replyOpacity }}>
        <div className="recorded-dialogue__speaker">
          <h2>{record.name}</h2>
          <time>{monthLabel(record.completedAtMonth)}</time>
        </div>
        <RecordedText
          className="recorded-dialogue__answer-text"
          full={reply}
          visible={prefix(reply, localTime - timing.replyStartsAt, REPLY_CHARACTERS_PER_SECOND)}
        />
        <p className="recorded-dialogue__excerpt-note">回复节选</p>
      </div>
    </aside>
  );
}
