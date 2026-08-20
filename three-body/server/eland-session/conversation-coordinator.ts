import { createHash } from 'node:crypto';

import type { SimulationState } from '../../src/game/eland/simulation';
import { worldEventById } from '../../src/game/eland/domain/event-index';
import type { PlayerInteractionChoiceFailure } from '../../src/game/eland/application/player-interaction-choice';
import type {
  AgentInteractionRequestKind,
  AgentInteractionStance,
} from '../agent-interaction-gateway';
import type { BranchTimeline } from './timeline';

export type AgentConversationInfluenceStatus =
  | 'none'
  | 'queued'
  | 'deferred'
  | 'applied'
  | 'completed'
  | 'blocked'
  | 'stale'
  /** Legacy statuses retained so recent recoverable sessions remain readable. */
  | 'pending'
  | 'considered'
  | 'failed';

export interface AgentConversationTurn {
  id: string;
  clientMessageId: string;
  agentId: string;
  branchId: string;
  requestedAtMonth: number;
  completedAtMonth: number;
  userMessage: string;
  agentReply: string;
  requestKind: AgentInteractionRequestKind;
  stance: AgentInteractionStance;
  guidance?: string;
  reason?: string;
  grounding?: 'supported' | 'unknown' | 'opinion';
  evidenceIds?: string[];
  /** The legal direction extracted from this reply; it is not yet an action fact. */
  choice?: {
    optionId: string;
    followUpOptionId?: string;
    summary: string;
    choiceKey: string;
    reason: string;
  };
  influenceStatus: AgentConversationInfluenceStatus;
  /** Local, replayable result of trying to attach the choice to the action chain. */
  influenceOutcome?: {
    atMonth: number;
    summary: string;
    detail?: string;
    decisionEventId?: string;
    intentId?: string;
    actionEventIds?: string[];
  };
  model: { endpointId: string; protocol: string; model: string };
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentConversationView {
  agentId: string;
  branchId: string;
  throughMonth: number;
  model: { configured: boolean; endpointId?: string; model?: string; issue?: string };
  turns: AgentConversationTurn[];
}

export class AgentConversationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConversationConflictError';
  }
}

export function conversationFingerprint(input: {
  agentId: string;
  branchId: string;
  message: string;
  requestKind: AgentInteractionRequestKind;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.branchId, input.agentId, input.requestKind, input.message]))
    .digest('hex');
}

export function conversationRequestKey(agentId: string, clientMessageId: string): string {
  return JSON.stringify([agentId, clientMessageId]);
}

export function normalizeConversationTurn(turn: AgentConversationTurn): AgentConversationTurn {
  const normalized = { ...turn } as AgentConversationTurn & { mode?: unknown };
  delete normalized.mode;
  return {
    ...normalized,
    requestKind: normalized.requestKind === 'suggestion' ? 'suggestion' : 'conversation',
  };
}

export function conversationChoiceBlockedDetail(
  failure: PlayerInteractionChoiceFailure,
  summary: string,
): string {
  if (failure === 'emergency-first') return `我得先让身体脱离眼前的危险。“${summary}”还留着。`;
  if (failure === 'required-response-first') return `眼前有人正等我答复，我得先处理那件事。“${summary}”还留着。`;
  if (failure === 'fulfillment-first') return `我得先履行已经答应的事。“${summary}”还留着。`;
  if (failure === 'choice-ambiguous') return `眼前出现了几种都像“${summary}”的做法，我不能替过去的自己随便挑一个。`;
  if (failure === 'follow-up-unavailable') return `“${summary}”已经找不到可以接下去的做法。`;
  return `对话结束前，眼前的条件已经变了，“${summary}”不再是可行的下一步。`;
}

export function projectConversationTurnOutcome(
  turn: AgentConversationTurn,
  state: SimulationState,
): AgentConversationTurn {
  if (turn.influenceStatus !== 'applied' || !turn.influenceOutcome?.intentId) return turn;
  const intent = state.intents.find((candidate) => candidate.id === turn.influenceOutcome?.intentId);
  if (!intent) {
    return {
      ...turn,
      influenceStatus: 'stale',
      influenceOutcome: {
        atMonth: state.clock.elapsedMonths,
        summary: '原来的行动结果不在当前时间线',
        detail: '这条时间线里找不到当时形成的打算，因此不会把另一条时间线的结果算在这里。',
      },
    };
  }
  const actionEvents = intent.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
  const lastAction = actionEvents.at(-1);
  const choiceSummary = turn.choice?.summary ?? intent.summary;
  const outcome = {
    ...turn.influenceOutcome,
    atMonth: lastAction?.atMonth ?? intent.lastProgressAtMonth,
    ...(lastAction ? { detail: lastAction.result } : {}),
    ...(actionEvents.length ? { actionEventIds: actionEvents.map((event) => event.id) } : {}),
  };
  if (intent.status === 'completed') {
    return {
      ...turn,
      influenceStatus: 'completed',
      influenceOutcome: { ...outcome, summary: `已经做成“${choiceSummary}”` },
    };
  }
  if (intent.status === 'blocked' || intent.status === 'failed' || intent.status === 'abandoned') {
    return {
      ...turn,
      influenceStatus: 'blocked',
      influenceOutcome: {
        ...outcome,
        summary: `后来没能做成“${choiceSummary}”`,
        detail: intent.blockedReason ?? lastAction?.result ?? '这个打算后来停下了。',
      },
    };
  }
  if (intent.status === 'suspended') {
    return {
      ...turn,
      influenceStatus: 'deferred',
      influenceOutcome: {
        ...outcome,
        summary: '眼前有更急的事打断了原来的决定',
        detail: `${lastAction?.result ?? '原来的方向已经开始'}；这个打算还保留着。`,
      },
    };
  }
  return { ...turn, influenceOutcome: outcome };
}

export function localConversationTurns(timeline: BranchTimeline): AgentConversationTurn[] {
  return timeline.conversationTurns ??= [];
}

export function inheritedConversationTurns(
  branches: Map<string, BranchTimeline>,
  timeline: BranchTimeline,
): AgentConversationTurn[] {
  const local = localConversationTurns(timeline);
  if (!timeline.parentBranchId) return local;
  const parent = branches.get(timeline.parentBranchId);
  if (!parent) return local;
  const inherited = inheritedConversationTurns(branches, parent)
    .filter((turn) => turn.completedAtMonth <= timeline.forkAtMonth)
    .map((turn) => turn.influenceStatus === 'pending'
      || turn.influenceStatus === 'queued'
      || turn.influenceStatus === 'deferred'
      || (turn.influenceOutcome?.atMonth ?? -1) > timeline.forkAtMonth
      ? {
          ...turn,
          influenceStatus: 'stale' as const,
          influenceOutcome: {
            atMonth: timeline.forkAtMonth,
            summary: '原来的决定或结果留在了另一条时间线',
            detail: '你回到了更早的时间点，这次尚未发生的决定或结果没有被带进新的时间线。',
          },
        }
      : turn);
  return [...inherited, ...local];
}
