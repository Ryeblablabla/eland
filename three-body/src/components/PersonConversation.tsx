import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import { elandClient } from '@/game/elandClient';
import type {
  AgentConversationInfluenceStatus,
  AgentConversationRequestKind,
  AgentConversationView,
  SocietyAgent,
} from '@/game/societyContract';

interface Props {
  agent: SocietyAgent;
  observedBranchId: string;
  observedMonth: number;
  onShowHistory: () => void;
  runId: string;
}

interface PendingConversationMessage {
  clientMessageId: string;
  error?: string;
  message: string;
  requestKind: AgentConversationRequestKind;
  requestedAtMonth: number;
  status: 'sending' | 'failed';
}

interface CachedConversation {
  conversation: AgentConversationView;
  version: number;
}

const INFLUENCE_LABELS: Record<AgentConversationInfluenceStatus, string> = {
  none: '只是一段对话',
  queued: '已经定下下一步',
  deferred: '先处理眼前的事',
  applied: '已经定为当前打算',
  completed: '已经做成了',
  blocked: '条件变化，没有发生',
  stale: '原来的决定没有继续',
  pending: '旧版建议尚未处理',
  considered: '旧版建议只被想过',
  failed: '旧版建议没有形成选择',
};

function choiceStatusHeading(
  name: string,
  status: AgentConversationInfluenceStatus,
  outcomeMonth?: number,
  outcomeSummary?: string,
  hasActionEvents = false,
): string {
  if (status === 'applied') {
    const label = hasActionEvents ? '已经开始' : '已经定下';
    return `${label}${outcomeMonth !== undefined ? ` · ${monthLabel(outcomeMonth)}` : ''}`;
  }
  if (status === 'completed') return `已经做成${outcomeMonth !== undefined ? ` · ${monthLabel(outcomeMonth)}` : ''}`;
  if (status === 'deferred') return '先处理眼前的事';
  if (status === 'blocked') return '没有发生';
  if (status === 'stale') return outcomeSummary ?? '原来的决定没有继续';
  return `${name}定下的下一步`;
}

const draftsByIdentity = new Map<string, string>();
const pendingByIdentity = new Map<string, PendingConversationMessage>();
const latestConversationByIdentity = new Map<string, CachedConversation>();
const sessionSubscribers = new Map<string, Set<() => void>>();
let cachedConversationVersion = 0;
let fallbackMessageSequence = 0;

function conversationIdentity(runId: string, branchId: string, agentId: string): string {
  return JSON.stringify([runId, branchId, agentId]);
}

function publishSession(identity: string): void {
  sessionSubscribers.get(identity)?.forEach((subscriber) => subscriber());
}

function cacheConversation(identity: string, conversation: AgentConversationView): CachedConversation {
  const existing = latestConversationByIdentity.get(identity);
  if (
    existing
    && (
      existing.conversation.turns.length > conversation.turns.length
      || (
        existing.conversation.turns.length === conversation.turns.length
        && existing.conversation.throughMonth > conversation.throughMonth
      )
    )
  ) return existing;
  cachedConversationVersion += 1;
  const cached = { conversation, version: cachedConversationVersion };
  latestConversationByIdentity.set(identity, cached);
  return cached;
}

function subscribeToSession(identity: string, subscriber: () => void): () => void {
  const subscribers = sessionSubscribers.get(identity) ?? new Set<() => void>();
  subscribers.add(subscriber);
  sessionSubscribers.set(identity, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) sessionSubscribers.delete(identity);
  };
}

function createClientMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  fallbackMessageSequence += 1;
  return `interaction-${Date.now().toString(36)}-${fallbackMessageSequence.toString(36)}`;
}

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第${Math.floor((month - 1) / 12) + 1}年 · ${((month - 1) % 12) + 1}月`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function PersonConversation({ agent, observedBranchId, observedMonth, onShowHistory, runId }: Props) {
  const identity = conversationIdentity(runId, observedBranchId, agent.id);
  const initialCache = latestConversationByIdentity.get(identity);
  const [conversation, setConversation] = useState<AgentConversationView | null>(
    initialCache?.conversation ?? null,
  );
  const [loading, setLoading] = useState(!initialCache);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState(() => draftsByIdentity.get(identity) ?? '');
  const [pendingMessage, setPendingMessage] = useState<PendingConversationMessage | null>(
    pendingByIdentity.get(identity) ?? null,
  );
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const activeIdentityRef = useRef(identity);
  const appliedConversationVersionRef = useRef(initialCache?.version ?? 0);
  const loadSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isComposingRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const followOnNextRenderRef = useRef(true);

  const commitConversation = (next: AgentConversationView) => {
    setConversation(next);
  };

  const resizeComposer = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`;
    if (isNearBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  };

  const scrollToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
  };

  useEffect(() => {
    activeIdentityRef.current = identity;
    return subscribeToSession(identity, () => {
      if (activeIdentityRef.current !== identity) return;
      setPendingMessage(pendingByIdentity.get(identity) ?? null);
      const latest = latestConversationByIdentity.get(identity);
      if (!latest || latest.version <= appliedConversationVersionRef.current) return;
      appliedConversationVersionRef.current = latest.version;
      mutationSequenceRef.current += 1;
      commitConversation(latest.conversation);
      setLoading(false);
      setLoadError('');
    });
  }, [identity]);

  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    const mutationSequence = mutationSequenceRef.current;

    void elandClient.agentConversation(runId, agent.id).then((next) => {
      if (
        identity !== activeIdentityRef.current
        || sequence !== loadSequenceRef.current
        || mutationSequence !== mutationSequenceRef.current
      ) return;
      if (next.agentId !== agent.id || next.branchId !== observedBranchId) {
        setLoading(false);
        setLoadError('时间线已经变化，请重新打开人物对话');
        return;
      }
      const cached = cacheConversation(identity, next);
      const pending = pendingByIdentity.get(identity);
      if (
        pending
        && cached.conversation.turns.some((turn) => turn.clientMessageId === pending.clientMessageId)
      ) {
        pendingByIdentity.delete(identity);
      }
      appliedConversationVersionRef.current = cached.version;
      commitConversation(cached.conversation);
      setLoading(false);
      setLoadError('');
      publishSession(identity);
    }).catch((error) => {
      if (identity !== activeIdentityRef.current || sequence !== loadSequenceRef.current) return;
      setLoading(false);
      setLoadError(errorMessage(error, '人物对话读取失败'));
    });
  }, [agent.id, identity, observedBranchId, observedMonth, refreshSequence, runId]);

  useEffect(() => {
    const frame = requestAnimationFrame(resizeComposer);
    return () => cancelAnimationFrame(frame);
  }, [identity, message]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      if (followOnNextRenderRef.current || isNearBottomRef.current) {
        followOnNextRenderRef.current = false;
        scrollToLatest();
        return;
      }
      setShowJumpToLatest(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [conversation?.turns.length, identity, loading, pendingMessage?.clientMessageId, pendingMessage?.status]);

  const currentConversation = conversation?.agentId === agent.id
    && conversation.branchId === observedBranchId
    ? conversation
    : null;
  const configured = Boolean(currentConversation?.model.configured);
  const isArchive = agent.state === 'dead';
  const sending = pendingMessage?.status === 'sending';

  useEffect(() => {
    if ((!loading && !configured) || isArchive) return;
    const frame = requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      const selectedConversationTab = activeElement instanceof HTMLElement
        && activeElement.getAttribute('role') === 'tab'
        && activeElement.getAttribute('aria-selected') === 'true';
      if (
        activeElement === document.body
        || selectedConversationTab
        || Boolean(activeElement && sectionRef.current?.contains(activeElement))
      ) {
        textareaRef.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [configured, identity, isArchive, loading]);

  const submitMessage = (
    normalized: string,
    clientMessageId: string,
    requestKind: AgentConversationRequestKind,
  ) => {
    const existingPending = pendingByIdentity.get(identity);
    if (
      existingPending?.status === 'sending'
      || (existingPending && existingPending.clientMessageId !== clientMessageId)
      || !configured
      || isArchive
    ) return;
    const requestIdentity = identity;
    const requestRunId = runId;
    const requestAgentId = agent.id;
    const requestBranchId = observedBranchId;
    pendingByIdentity.set(requestIdentity, {
      clientMessageId,
      message: normalized,
      requestKind,
      requestedAtMonth: existingPending?.requestedAtMonth ?? observedMonth,
      status: 'sending',
    });
    publishSession(requestIdentity);
    followOnNextRenderRef.current = true;
    loadSequenceRef.current += 1;

    void elandClient.sendAgentConversation({
      runId: requestRunId,
      agentId: requestAgentId,
      message: normalized,
      requestKind,
      clientMessageId,
      observedBranchId: requestBranchId,
    }).then((result) => {
      const currentPending = pendingByIdentity.get(requestIdentity);
      const ownsPending = currentPending?.clientMessageId === clientMessageId;
      if (
        result.conversation.agentId !== requestAgentId
        || result.conversation.branchId !== requestBranchId
      ) {
        if (ownsPending) {
          pendingByIdentity.set(requestIdentity, {
            clientMessageId,
            error: '时间线已变化，请重新发送',
            message: normalized,
            requestKind,
            requestedAtMonth: currentPending.requestedAtMonth,
            status: 'failed',
          });
          publishSession(requestIdentity);
        }
        return;
      }
      cacheConversation(requestIdentity, result.conversation);
      if (ownsPending) pendingByIdentity.delete(requestIdentity);
      publishSession(requestIdentity);
    }).catch((error) => {
      const pending = pendingByIdentity.get(requestIdentity);
      if (!pending || pending.clientMessageId !== clientMessageId) return;
      pendingByIdentity.set(requestIdentity, {
        ...pending,
        error: errorMessage(error, '模型没有完成这次人物对话'),
        status: 'failed',
      });
      publishSession(requestIdentity);
    });
  };

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = message.trim();
    if (!normalized || pendingByIdentity.has(identity) || loading || !configured || isArchive) return;
    draftsByIdentity.delete(identity);
    setMessage('');
    submitMessage(normalized, createClientMessageId(), 'conversation');
    requestAnimationFrame(() => {
      resizeComposer();
      textareaRef.current?.focus({ preventScroll: true });
    });
  };

  const retryPendingMessage = () => {
    if (!pendingMessage || pendingMessage.status !== 'failed') return;
    submitMessage(pendingMessage.message, pendingMessage.clientMessageId, pendingMessage.requestKind);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  };

  const discardPendingMessage = () => {
    const pending = pendingByIdentity.get(identity);
    if (!pending || pending.status === 'sending') return;
    pendingByIdentity.delete(identity);
    publishSession(identity);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  };

  const onComposerChange = (value: string) => {
    if (value) draftsByIdentity.set(identity, value);
    else draftsByIdentity.delete(identity);
    setMessage(value);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || isComposingRef.current
      || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229
    ) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  const onMessagesScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 72;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setShowJumpToLatest(false);
  };

  return (
    <section ref={sectionRef} aria-label={`与${agent.name}对话`} className="person-conversation">
      {currentConversation && (
        <div className="person-conversation__status" title={`分支 ${currentConversation.branchId}`}>
          {isArchive ? '对话档案' : '当前时间线'} · {monthLabel(currentConversation.throughMonth)}
        </div>
      )}

      <div className="person-conversation__messages-shell">
        <div
          ref={listRef}
          aria-busy={loading || sending}
          aria-live="polite"
          className="person-conversation__messages"
          onScroll={onMessagesScroll}
          role="log"
        >
          {loading && !currentConversation ? (
            <div className="person-conversation__empty">
              <LoaderCircle aria-hidden="true" className="person-conversation__spinner" size={22} strokeWidth={1.5} />
              <p>正在读取对话…</p>
            </div>
          ) : loadError && !currentConversation ? (
            <div className="person-conversation__empty person-conversation__empty--error" role="alert">
              <p>{loadError}</p>
              <button
                onClick={() => {
                  setLoadError('');
                  setLoading(true);
                  setRefreshSequence((value) => value + 1);
                }}
                type="button"
              >
                重新读取
              </button>
            </div>
          ) : currentConversation?.turns.length ? (
            currentConversation.turns.map((turn) => (
              <article className="person-conversation-turn" key={turn.id}>
                <div className="person-conversation-turn__user">
                  <p>{turn.userMessage}</p>
                  <div className="person-conversation-turn__user-meta">
                    <time>{monthLabel(turn.requestedAtMonth)}</time>
                  </div>
                </div>
                <div className="person-conversation-turn__agent">
                  <div className="person-conversation-turn__speaker">
                    <span>{agent.name}</span>
                  </div>
                  <p>{turn.agentReply}</p>
                  {turn.choice ? (
                    <div className={`person-conversation-turn__choice person-conversation-turn__choice--${turn.influenceStatus}`}>
                      <span>{choiceStatusHeading(
                        agent.name,
                        turn.influenceStatus,
                        turn.influenceOutcome?.atMonth,
                        turn.influenceOutcome?.summary,
                        Boolean(turn.influenceOutcome?.actionEventIds?.length),
                      )}</span>
                      <strong>{turn.choice.summary}</strong>
                      {turn.influenceStatus === 'queued' && (
                        <small>{agent.name}准备按眼前的情况开始。</small>
                      )}
                      {turn.influenceOutcome?.detail && (
                        <small>{turn.influenceOutcome.detail}</small>
                      )}
                      {Boolean(turn.influenceOutcome?.actionEventIds?.length) && (
                        <button className="person-conversation-turn__choice-link" onClick={onShowHistory} type="button">
                          查看行动
                        </button>
                      )}
                    </div>
                  ) : turn.guidance ? (
                    <blockquote>
                      <span>{agent.name}把你的话理解为</span>
                      {turn.guidance}
                    </blockquote>
                  ) : turn.stance === 'consider' || turn.stance === 'decline' ? (
                    <div className="person-conversation-turn__reason">
                      <span>{turn.stance === 'decline' ? `${agent.name}的决定` : `${agent.name}还没定下来`}</span>
                      <strong>{turn.stance === 'decline' ? '暂时不这样做' : '这次没有定成下一步'}</strong>
                      {turn.reason && <small>{turn.reason}</small>}
                    </div>
                  ) : null}
                  {!turn.choice && turn.influenceStatus !== 'none' && (
                    <div className="person-conversation-turn__meta">
                      <span className={`person-conversation-turn__influence person-conversation-turn__influence--${turn.influenceStatus}`}>
                        {INFLUENCE_LABELS[turn.influenceStatus]}
                      </span>
                    </div>
                  )}
                </div>
              </article>
            ))
          ) : !pendingMessage && (
            <div className="person-conversation__empty">
              <p>{isArchive ? '没有留下对话。' : '还没有对话。'}</p>
            </div>
          )}

          {pendingMessage && (
            <article className={`person-conversation-turn person-conversation-turn--optimistic person-conversation-turn--${pendingMessage.status}`}>
              <div className="person-conversation-turn__user">
                <p>{pendingMessage.message}</p>
                <div className="person-conversation-turn__user-meta">
                  <time>{monthLabel(pendingMessage.requestedAtMonth)}</time>
                </div>
              </div>
              {pendingMessage.status === 'sending' ? (
                <div className="person-conversation__waiting" role="status">
                  <LoaderCircle aria-hidden="true" className="person-conversation__spinner" size={16} strokeWidth={1.6} />
                  正在等待{agent.name}回应…
                </div>
              ) : (
                <div className="person-conversation__pending-error" role="alert">
                  <span>{pendingMessage.error}</span>
                  {!isArchive && (
                    <div className="person-conversation__pending-actions">
                      <button onClick={discardPendingMessage} type="button">放弃</button>
                      <button onClick={retryPendingMessage} type="button">重试回应</button>
                    </div>
                  )}
                </div>
              )}
            </article>
          )}

          {loadError && currentConversation && (
            <p className="person-conversation__inline-error" role="status">同步失败：{loadError}</p>
          )}
        </div>

        {showJumpToLatest && (
          <button className="person-conversation__jump-latest" onClick={scrollToLatest} type="button">
            回到最新
          </button>
        )}
      </div>

      {isArchive ? (
        <div className="person-conversation__archive" role="status">
          人物已故 · 对话仅供回看
        </div>
      ) : (
        <form ref={formRef} className="person-conversation__composer" onSubmit={send}>
          {!configured && !loading && currentConversation && (
            <div className="person-conversation__model-error" role="alert">
              <strong>人物对话模型不可用</strong>
              <span>{currentConversation.model.issue ?? 'interaction 路由没有可用的模型端点。'}</span>
            </div>
          )}
          <div className="person-conversation__input">
            <textarea
              ref={textareaRef}
              aria-label={`对${agent.name}说`}
              disabled={!loading && !configured}
              maxLength={4000}
              onChange={(event) => onComposerChange(event.target.value)}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onKeyDown={onComposerKeyDown}
              placeholder={loading || configured ? `对${agent.name}说…` : '配置 interaction 模型后可以对话'}
              rows={2}
              value={message}
            />
            <button
              aria-busy={sending}
              aria-label={sending ? '正在等待回应' : '发送消息'}
              disabled={!message.trim() || loading || Boolean(pendingMessage) || !configured}
              title="发送（Enter；Shift + Enter 换行）"
              type="submit"
            >
              {sending
                ? <LoaderCircle aria-hidden="true" className="person-conversation__spinner" size={18} strokeWidth={1.8} />
                : <ArrowUp aria-hidden="true" size={18} strokeWidth={1.8} />}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
