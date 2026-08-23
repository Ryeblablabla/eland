import { randomInt } from 'node:crypto';
import {
  AgentConversationConflictError,
  EmbodimentCommandRejectedError,
  EmbodimentConflictError,
  type ElandSession,
  ElandSessionBusyError,
  ElandSessionCapacityError,
  ElandStepConflictError,
  elandSessions,
} from './elandSession';
import { ElandSaveNotFoundError } from './sqlite-eland-store';
import { ModelRequestError } from './model-client';
import type { CosmosSnapshot, EraKey, GameFrame, SkySample } from '../src/game/societyContract';
import { createStepPayload } from '../src/game/eland/society-patch';

const INITIAL_HISTORY_LIMIT = 240;
const INITIAL_CIVILIZATION_INDEX_HISTORY_LIMIT = 2_400;
const LIVE_SESSION_PERSIST_INTERVAL_MONTHS = 12;
type AnnualPersistenceAttempt = { key: string; status: 'pending' | 'succeeded' | 'failed' };
const annualPersistenceAttempts = new WeakMap<object, AnnualPersistenceAttempt>();

function initialReadProjection(session: Pick<ElandSession, 'chronicle' | 'civilizationIndexHistory'>) {
  const history = session.chronicle();
  const civilizationIndexHistory = session.civilizationIndexHistory();
  return {
    history: history.slice(-INITIAL_HISTORY_LIMIT),
    historyTotalCount: history.length,
    civilizationIndexHistory: civilizationIndexHistory.slice(-INITIAL_CIVILIZATION_INDEX_HISTORY_LIMIT),
  };
}

function isNewlyCommittedMonth(previous: GameFrame | null, current: GameFrame | null): current is GameFrame {
  return Boolean(previous
    && current
    && current.runId === previous.runId
    && current.authorityRevision === previous.authorityRevision
    && current.civilizationId === previous.civilizationId
    && current.branchId === previous.branchId
    && current.elapsedMonths === previous.elapsedMonths + 1);
}

function annualPersistenceKey(frame: GameFrame): string {
  return `${frame.authorityRevision}\u0000${frame.civilizationId}\u0000${frame.branchId}\u0000${frame.elapsedMonths}`;
}

function claimAnnualPersistence(session: object, frame: GameFrame, newlyCommitted: boolean): boolean {
  const key = annualPersistenceKey(frame);
  const attempt = annualPersistenceAttempts.get(session);
  if (attempt?.key === key) {
    if (attempt.status !== 'failed') return false;
    annualPersistenceAttempts.set(session, { key, status: 'pending' });
    return true;
  }
  if (!newlyCommitted) return false;
  annualPersistenceAttempts.set(session, { key, status: 'pending' });
  return true;
}

function settleAnnualPersistence(session: object, frame: GameFrame, succeeded: boolean): void {
  const key = `${frame.authorityRevision}\u0000${frame.civilizationId}\u0000${frame.branchId}\u0000${frame.elapsedMonths}`;
  const attempt = annualPersistenceAttempts.get(session);
  if (attempt?.key === key) {
    annualPersistenceAttempts.set(session, { key, status: succeeded ? 'succeeded' : 'failed' });
  }
}

export interface ElandApiResponse {
  status: number;
  body: unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function era(value: unknown): EraKey {
  return value === 'chaotic' || value === 'chaotic-heat' || value === 'chaotic-cold' || value === 'burned' || value === 'frozen' || value === 'extinct'
    ? value
    : 'stable';
}

function skySample(value: unknown): SkySample {
  const input = asObject(value);
  const toTime = finite(input.toTime, 0);
  const fluxMean = Math.max(0, finite(input.fluxMean, 1));
  return {
    fromTime: finite(input.fromTime, toTime),
    toTime,
    fluxMean,
    fluxMin: Math.max(0, finite(input.fluxMin, fluxMean)),
    fluxMax: Math.max(0, finite(input.fluxMax, fluxMean)),
    nearestStarDistance: Math.max(0, finite(input.nearestStarDistance, 1)),
    fate: era(input.fate),
  };
}

function cosmosSnapshot(value: unknown): CosmosSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  const input = asObject(value);
  const state = Array.isArray(input.state) ? input.state.map(Number) : [];
  const masses = Array.isArray(input.masses) ? input.masses.map(Number) : [];
  if (input.schemaVersion !== 1
    || typeof input.presetKey !== 'string'
    || state.length !== 16
    || masses.length !== 4
    || !state.every(Number.isFinite)
    || !masses.every(Number.isFinite)
    || !Number.isInteger(input.randomState)
    || !Number.isInteger(input.respawnSequence)) return undefined;
  const pendingCollapse = input.pendingCollapse === 'burned'
    || input.pendingCollapse === 'frozen'
    || input.pendingCollapse === 'extinct'
    ? input.pendingCollapse
    : null;
  return {
    schemaVersion: 1,
    presetKey: input.presetKey,
    state,
    masses,
    randomState: Number(input.randomState) >>> 0,
    respawnSequence: Math.max(0, Math.floor(Number(input.respawnSequence))),
    t: finite(input.t, 0),
    viewR: Math.max(0.1, finite(input.viewR, 2.2)),
    civilizations: Math.max(1, Math.floor(finite(input.civilizations, 1))),
    extinct: input.extinct === true,
    pendingCollapse,
    fluxBase: Math.max(1e-9, finite(input.fluxBase, 1)),
    planetR: Math.max(1e-9, finite(input.planetR, 0.1)),
  };
}

export async function handleElandApi(method: string | undefined, url: URL, bodyValue: unknown): Promise<ElandApiResponse> {
  const route = url.pathname.replace(/^\/api\/eland\/?|^\/+|\/+$/g, '');
  const body = asObject(bodyValue);
  const runId = String(body.runId ?? url.searchParams.get('runId') ?? '').trim();
  const leaseId = String(body.leaseId ?? '').trim();
  if (!runId) return { status: 400, body: { error: '缺少 runId' } };

  if (route === 'end' && method === 'POST') {
    try {
      return { status: 200, body: { ended: elandSessions.end(runId, leaseId), activeSessions: elandSessions.size() } };
    } catch (error) {
      if (error instanceof ElandSessionBusyError) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }

  if (route === 'begin' && method === 'POST') {
    const creationId = String(body.creationId ?? '').trim();
    if (!creationId || creationId.length > 160) return { status: 400, body: { error: '新文明创建标识无效' } };
    const worldSeed = body.worldSeed === undefined
      ? randomInt(1, 0x1_0000_0000)
      : Math.min(0xffff_ffff, Math.max(1, Math.floor(finite(body.worldSeed, randomInt(1, 0x1_0000_0000)))));
    const characterIds = Array.isArray(body.characterIds) ? body.characterIds.filter((id): id is string => typeof id === 'string') : undefined;
    const sky = skySample(body.skySample);
    const cosmos = cosmosSnapshot(body.cosmosSnapshot);
    if (body.cosmosSnapshot !== undefined && !cosmos) return { status: 400, body: { error: '宇宙快照无效' } };
    if (cosmos && cosmos.t !== sky.toTime) return { status: 400, body: { error: '宇宙快照与天象时刻不一致' } };
    try {
      return {
        status: 200,
        body: elandSessions.begin(runId, creationId, worldSeed, sky, characterIds, leaseId, cosmos),
      };
    } catch (error) {
      if (error instanceof ElandSessionCapacityError) {
        return { status: 429, body: { error: error.message, maxSessions: error.maxSessions } };
      }
      if (error instanceof ElandSessionBusyError) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }

  if (route === 'saves' && method === 'GET') {
    return { status: 200, body: { saves: elandSessions.listSaves() } };
  }

  if (route === 'load' && method === 'POST') {
    const saveId = String(body.saveId ?? '').trim();
    if (!saveId) return { status: 400, body: { error: '缺少 saveId' } };
    try {
      const loaded = elandSessions.loadSave(runId, saveId, leaseId);
      return {
        status: 200,
        body: {
          save: loaded.meta,
          frame: loaded.frame,
          ...initialReadProjection(loaded.session),
        },
      };
    } catch (error) {
      if (error instanceof ElandSaveNotFoundError) return { status: 404, body: { error: error.message } };
      if (error instanceof ElandSessionCapacityError) {
        return { status: 429, body: { error: error.message, maxSessions: error.maxSessions } };
      }
      if (error instanceof ElandSessionBusyError) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }

  const session = elandSessions.get(
    runId,
    method === 'POST' && (route === 'step'
      || route === 'embodiment-begin'
      || route === 'embodiment-step'
      || route === 'embodiment-release')
      ? 'step'
      : 'read',
  );
  if (!session) return { status: 404, body: { error: `运行 ${runId} 不存在` } };
  if (route === 'embodiment-state' && method === 'GET') {
    return { status: 200, body: { embodiment: session.embodimentView() } };
  }
  if (route === 'embodiment-begin' && method === 'POST') {
    const sky = skySample(body.skySample);
    const cosmos = cosmosSnapshot(body.cosmosSnapshot);
    if (body.cosmosSnapshot !== undefined && !cosmos) {
      return { status: 400, body: { error: '宇宙快照无效' } };
    }
    try {
      const embodiment = session.beginEmbodiment({
        runId,
        embodimentId: String(body.embodimentId ?? ''),
        agentId: String(body.agentId ?? ''),
        expectedAuthorityRevision: String(body.expectedAuthorityRevision ?? ''),
        expectedCivilizationId: Number(body.expectedCivilizationId),
        expectedBranchId: String(body.expectedBranchId ?? ''),
        expectedElapsedMonths: Number(body.expectedElapsedMonths),
        skySample: sky,
        ...(cosmos ? { cosmosSnapshot: cosmos } : {}),
      });
      const persistence = elandSessions.persistIfCurrent(runId, session);
      if (!persistence.current) return { status: 409, body: { error: '进入化身时会话已被替换' } };
      if (!persistence.persisted) return { status: 503, body: { error: '化身月份暂时无法持久化，请使用同一请求重试' } };
      return { status: 200, body: { embodiment } };
    } catch (error) {
      if (error instanceof EmbodimentConflictError || error instanceof ElandSessionBusyError) {
        return { status: 409, body: { error: error.message, embodiment: session.embodimentView() } };
      }
      throw error;
    }
  }
  if (route === 'embodiment-step' && method === 'POST') {
    try {
      const result = await session.stepEmbodiment({
        runId,
        embodimentId: String(body.embodimentId ?? ''),
        commandId: String(body.commandId ?? ''),
        expectedRevision: Number(body.expectedRevision),
        expectedTick: Number(body.expectedTick),
        command: asObject(body.command).kind === 'wait'
          ? { kind: 'wait' }
          : {
              kind: 'choose-option',
              optionId: String(asObject(body.command).optionId ?? ''),
              choiceKey: String(asObject(body.command).choiceKey ?? ''),
              ...(typeof asObject(body.command).followUpOptionId === 'string'
                ? { followUpOptionId: String(asObject(body.command).followUpOptionId) }
                : {}),
            },
      });
      const persistence = elandSessions.persistIfCurrent(runId, session);
      if (!persistence.current) return { status: 409, body: { error: '化身行动完成时会话已被替换' } };
      if (!persistence.persisted) return { status: 503, body: { error: '化身行动暂时无法持久化，请使用同一 commandId 重试' } };
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof EmbodimentCommandRejectedError) {
        return { status: 422, body: { error: error.message, failure: error.failure, embodiment: session.embodimentView() } };
      }
      if (error instanceof EmbodimentConflictError) {
        return { status: 409, body: { error: error.message, embodiment: session.embodimentView() } };
      }
      throw error;
    }
  }
  if (route === 'embodiment-release' && method === 'POST') {
    try {
      const result = await session.releaseEmbodiment({
        runId,
        embodimentId: String(body.embodimentId ?? ''),
        releaseId: String(body.releaseId ?? ''),
        expectedRevision: Number(body.expectedRevision),
      });
      const persistence = elandSessions.persistIfCurrent(runId, session);
      if (!persistence.current) return { status: 409, body: { error: '交还自主时会话已被替换' } };
      if (!persistence.persisted) return { status: 503, body: { error: '交还结果暂时无法持久化，请使用同一 releaseId 重试' } };
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof EmbodimentConflictError) {
        return { status: 409, body: { error: error.message, embodiment: session.embodimentView() } };
      }
      throw error;
    }
  }
  if (route === 'settle-civilization' && method === 'POST') {
    const latest = session.latest();
    if (!latest) return { status: 409, body: { error: '当前文明还没有可结算的权威状态' } };
    if (body.expectedCivilizationId !== latest.civilizationId
      || body.expectedBranchId !== latest.branchId
      || body.expectedElapsedMonths !== latest.elapsedMonths) {
      return { status: 409, body: { error: '文明已经推进或切换，请按当前状态重新确认结算' } };
    }
    try {
      const frame = session.settleCivilization();
      const persistence = elandSessions.persistIfCurrent(runId, session);
      if (!persistence.current) return { status: 409, body: { error: '结算完成时会话已经被替换，请重新读取当前文明' } };
      return { status: 200, body: { frame } };
    } catch (error) {
      if (error instanceof ElandSessionBusyError) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }
  if (route === 'civilization-requiem' && method === 'POST') {
    const latest = session.latest();
    if (!latest?.civilizationEnd) return { status: 409, body: { error: '当前文明尚未结算' } };
    if (body.expectedCivilizationId !== latest.civilizationId
      || body.expectedBranchId !== latest.branchId
      || body.expectedEndedAtMonth !== latest.elapsedMonths) {
      return { status: 409, body: { error: '终章所依据的文明结局已经变化' } };
    }
    const requiem = await session.civilizationRequiem();
    const persistence = elandSessions.persistIfCurrent(runId, session);
    if (!persistence.current) return { status: 409, body: { error: '终章生成时会话已经被替换，请重新读取当前文明' } };
    return { status: 200, body: { requiem } };
  }
  if (route === 'save' && method === 'POST') {
    try {
      const saved = elandSessions.save(runId, typeof body.label === 'string' ? body.label : undefined);
      return saved
        ? { status: 201, body: { save: saved } }
        : { status: 409, body: { error: '当前文明还没有可保存的权威状态' } };
    } catch (error) {
      if (error instanceof ElandSessionBusyError) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }
  if (route === 'step' && method === 'POST') {
    const sky = skySample(body.skySample);
    const cosmos = cosmosSnapshot(body.cosmosSnapshot);
    const stepId = typeof body.stepId === 'string' ? body.stepId.trim() : undefined;
    const expectedAuthorityRevision = typeof body.expectedAuthorityRevision === 'string'
      ? body.expectedAuthorityRevision.trim()
      : undefined;
    const expectedCivilizationId = body.expectedCivilizationId;
    const expectedBranchId = typeof body.expectedBranchId === 'string' ? body.expectedBranchId.trim() : undefined;
    const expectedElapsedMonths = body.expectedElapsedMonths;
    if (body.stepId !== undefined
      && (typeof body.stepId !== 'string' || !stepId || stepId.length > 160)) {
      return { status: 400, body: { error: 'stepId 无效' } };
    }
    if (body.expectedAuthorityRevision !== undefined
      && (typeof body.expectedAuthorityRevision !== 'string'
        || !expectedAuthorityRevision
        || expectedAuthorityRevision.length > 160)) {
      return { status: 400, body: { error: 'expectedAuthorityRevision 无效' } };
    }
    if (expectedElapsedMonths !== undefined
      && (typeof expectedElapsedMonths !== 'number'
        || !Number.isInteger(expectedElapsedMonths)
        || expectedElapsedMonths < 0)) {
      return { status: 400, body: { error: 'expectedElapsedMonths 必须是非负整数' } };
    }
    if (expectedCivilizationId !== undefined
      && (typeof expectedCivilizationId !== 'number'
        || !Number.isInteger(expectedCivilizationId)
        || expectedCivilizationId < 1)) {
      return { status: 400, body: { error: 'expectedCivilizationId 必须是正整数' } };
    }
    if (body.expectedBranchId !== undefined
      && (typeof body.expectedBranchId !== 'string'
        || !expectedBranchId
        || expectedBranchId.length > 320)) {
      return { status: 400, body: { error: 'expectedBranchId 无效' } };
    }
    if (stepId && (expectedAuthorityRevision === undefined
      || expectedCivilizationId === undefined
      || expectedBranchId === undefined
      || expectedElapsedMonths === undefined)) {
      return { status: 400, body: { error: '带 stepId 的请求必须提供完整权威身份' } };
    }
    if (body.cosmosSnapshot !== undefined && !cosmos) return { status: 400, body: { error: '宇宙快照无效' } };
    if (cosmos && cosmos.t !== sky.toTime) return { status: 400, body: { error: '宇宙快照与天象时刻不一致' } };
    const previous = session.latest();
    try {
      const frame = await session.step({
        skySample: sky,
        cosmosSnapshot: cosmos,
        ...(stepId ? { stepId } : {}),
        ...(expectedAuthorityRevision ? { expectedAuthorityRevision } : {}),
        ...(expectedCivilizationId !== undefined ? { expectedCivilizationId } : {}),
        ...(expectedBranchId ? { expectedBranchId } : {}),
        ...(expectedElapsedMonths !== undefined ? { expectedElapsedMonths } : {}),
      });
      const newlyCommitted = isNewlyCommittedMonth(previous, frame);
      if (frame
        && frame.elapsedMonths % LIVE_SESSION_PERSIST_INTERVAL_MONTHS === 0
        && claimAnnualPersistence(session, frame, newlyCommitted)) {
        try {
          const persistence = elandSessions.persistIfCurrent(runId, session);
          const succeeded = persistence.current && persistence.persisted;
          settleAnnualPersistence(session, frame, succeeded);
          if (!persistence.current) {
            console.warn(`运行 ${runId} 的第 ${frame.elapsedMonths} 月已提交，但年度实时会话持久化时会话已被替换`);
          } else if (!persistence.persisted) {
            console.warn(`运行 ${runId} 的第 ${frame.elapsedMonths} 月已提交，但年度实时会话没有生成可持久化快照`);
          }
        } catch (error) {
          settleAnnualPersistence(session, frame, false);
          console.warn(`运行 ${runId} 的第 ${frame.elapsedMonths} 月已提交，但年度实时会话持久化失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { status: 200, body: createStepPayload(previous, frame) };
    } catch (error) {
      if (error instanceof ElandStepConflictError) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }
  if (route === 'checkpoint' && method === 'POST') return { status: 200, body: { persisted: elandSessions.persist(runId) } };
  if (route === 'state' && method === 'GET') {
    return {
      status: 200,
      body: {
        playing: false,
        model: session.model(),
        frame: session.latest(),
        embodiment: session.embodimentView(),
        ...initialReadProjection(session),
      },
    };
  }
  if (route === 'history' && method === 'GET') return { status: 200, body: { civilizationId: session.latest()?.civilizationId ?? 0, history: session.historyList(), branches: session.branchList() } };
  if (route === 'frame' && method === 'GET') return { status: 200, body: session.frameAt(finite(url.searchParams.get('month'), 0)) };
  if (route === 'agent-history' && method === 'GET') {
    const agentId = String(url.searchParams.get('agentId') ?? '').trim();
    if (!agentId) return { status: 400, body: { error: '缺少 agentId' } };
    const month = Math.max(0, Math.floor(finite(url.searchParams.get('month'), session.latest()?.elapsedMonths ?? 0)));
    const limit = Math.max(1, Math.floor(finite(url.searchParams.get('limit'), 80)));
    return { status: 200, body: session.agentHistory(agentId, month, limit) };
  }
  if (route === 'agent-conversation' && method === 'GET') {
    const agentId = String(url.searchParams.get('agentId') ?? '').trim();
    if (!agentId) return { status: 400, body: { error: '缺少 agentId' } };
    const conversation = session.agentConversation(agentId);
    return conversation
      ? { status: 200, body: conversation }
      : { status: 404, body: { error: '当前分支中没有这个人物' } };
  }
  if (route === 'agent-conversation' && method === 'POST') {
    const agentId = String(body.agentId ?? '').trim();
    const message = String(body.message ?? '').trim();
    const clientMessageId = String(body.clientMessageId ?? '').trim();
    const observedBranchId = String(body.observedBranchId ?? '').trim();
    const requestKind = body.requestKind === 'suggestion' ? 'suggestion' : 'conversation';
    if (!agentId) return { status: 400, body: { error: '缺少 agentId' } };
    if (!message || message.length > 4_000) return { status: 400, body: { error: '人物对话消息必须为 1–4000 个字符' } };
    if (!clientMessageId || clientMessageId.length > 160) return { status: 400, body: { error: 'clientMessageId 无效' } };
    try {
      const result = await session.converseWithAgent({
        agentId,
        message,
        requestKind,
        clientMessageId,
        ...(observedBranchId ? { observedBranchId } : {}),
      });
      const persistence = elandSessions.persistIfCurrent(runId, session);
      if (!persistence.current) {
        throw new AgentConversationConflictError('人物对话完成时会话已经被替换，请重新读取当前文明');
      }
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof AgentConversationConflictError) return { status: 409, body: { error: error.message } };
      if (error instanceof ModelRequestError) {
        const status = error.code === 'timeout' ? 504 : error.code === 'missing-key' ? 503 : 502;
        return { status, body: { error: error.message, code: error.code } };
      }
      const messageText = error instanceof Error ? error.message : String(error);
      if (/模型配置|模型端点|API Key/u.test(messageText)) return { status: 503, body: { error: messageText } };
      throw error;
    }
  }
  if (route === 'seek' && method === 'POST') {
    try {
      return { status: 200, body: session.seek(finite(body.month, 0)) };
    } catch (error) {
      if (error instanceof ElandSessionBusyError) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }
  return { status: 404, body: { error: `未知路由 ${route}` } };
}
