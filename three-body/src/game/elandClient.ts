/** 演化会话后端的前端客户端（/api/eland/*） */
import type {
  AgentConversationTurn,
  AgentConversationView,
  AgentHistoryView,
  AgentMemoryView,
  CivilizationIndexHistoryPoint,
  CosmosSnapshot,
  ElandSaveSummary,
  GameFrame,
  NarrativeEntryView,
  SkySample,
} from './societyContract';
import type { ModelProvider } from './llm';
import type { CivilizationRequiem } from './civilizationRequiem';
import { applyStepPayload, type ElandStepPayload } from './eland/society-patch';
import type {
  BeginEmbodimentRequest,
  EmbodimentReleaseResponse,
  EmbodimentStepRequest,
  EmbodimentStepResponse,
  EmbodimentView,
  ReleaseEmbodimentRequest,
} from './embodimentContract';

export type Frame = GameFrame;

export class ElandSessionMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElandSessionMissingError';
  }
}

export class ElandBackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElandBackendUnavailableError';
  }
}

export class ElandRequestConflictError extends Error {
  readonly status: number;
  readonly embodiment?: EmbodimentView;

  constructor(status: number, message: string, embodiment?: EmbodimentView) {
    super(message);
    this.name = 'ElandRequestConflictError';
    this.status = status;
    this.embodiment = embodiment;
  }
}

/**
 * Local month advancement is normally much faster than this. The generous
 * ceiling still releases a wedged request so the existing UI retry loop can
 * safely try again on a later tick.
 */
export const DEFAULT_ELAND_REQUEST_TIMEOUT_MS = 30_000;

export interface ElandRequestOptions {
  /** Override the request ceiling for a slower host or a focused test. */
  timeoutMs?: number;
  /** Cancels this caller's wait without changing the server-side retry policy. */
  signal?: AbortSignal;
}

export class ElandRequestTimeoutError extends ElandBackendUnavailableError {
  readonly route: string;
  readonly timeoutMs: number;

  constructor(route: string, timeoutMs: number) {
    super(`演化请求 ${route} 超过 ${timeoutMs} 毫秒未响应`);
    this.name = 'ElandRequestTimeoutError';
    this.route = route;
    this.timeoutMs = timeoutMs;
  }
}

const PAGE_LEASE_ID = `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let civilizationCreationSequence = 0;
let stepRequestSequence = 0;
let embodimentRequestSequence = 0;
const latestFrames = new Map<string, Frame | null>();
const authorityEpochs = new Map<string, number>();

interface PendingStepRequest {
  stepId: string;
  authorityEpoch: number;
  expectedAuthorityRevision: string;
  expectedElapsedMonths: number;
  expectedBranchId: string;
  expectedCivilizationId: number;
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
}

const pendingSteps = new Map<string, PendingStepRequest>();

function authorityEpoch(runId: string): number {
  return authorityEpochs.get(runId) ?? 0;
}

function beginAuthoritySwitch(runId: string): number {
  const next = authorityEpoch(runId) + 1;
  authorityEpochs.set(runId, next);
  pendingSteps.delete(runId);
  return next;
}

export interface ElandStepResult {
  frame: Frame | null;
  stepId: string;
  expectedElapsedMonths: number;
  /** True only when the returned authority head committed this request's sky interval. */
  skySampleAcknowledged: boolean;
  /** Present only when a rejected patch baseline forced a full authoritative reload. */
  authoritativeHistory?: NarrativeEntryView[];
  /** Server-side total for authoritativeHistory; the returned entries are only the recent window. */
  authoritativeHistoryTotalCount?: number;
  /** Present with authoritativeHistory so observer charts recover the same branch timeline. */
  authoritativeCivilizationIndexHistory?: CivilizationIndexHistoryPoint[];
}

export interface ElandObserverResult {
  frame: Frame | null;
  runner: {
    status: 'paused' | 'waiting' | 'stepping';
    activeObservers: number;
    leaseTtlMs: number;
  };
  authoritativeHistory?: NarrativeEntryView[];
  authoritativeHistoryTotalCount?: number;
  authoritativeCivilizationIndexHistory?: CivilizationIndexHistoryPoint[];
}

export function createCivilizationCreationId(): string {
  civilizationCreationSequence += 1;
  return `${PAGE_LEASE_ID}:civilization:${Date.now().toString(36)}:${civilizationCreationSequence.toString(36)}`;
}

function createEmbodimentRequestId(kind: 'embodiment' | 'command' | 'release'): string {
  embodimentRequestSequence += 1;
  return `${PAGE_LEASE_ID}:${kind}:${Date.now().toString(36)}:${embodimentRequestSequence.toString(36)}`;
}

export function createEmbodimentId(): string {
  return createEmbodimentRequestId('embodiment');
}

export function createEmbodimentCommandId(): string {
  return createEmbodimentRequestId('command');
}

export function createEmbodimentReleaseId(): string {
  return createEmbodimentRequestId('release');
}

function createStepId(): string {
  stepRequestSequence += 1;
  return `${PAGE_LEASE_ID}:step:${Date.now().toString(36)}:${stepRequestSequence.toString(36)}`;
}

function sameSkySample(left: SkySample, right: SkySample): boolean {
  return left.fromTime === right.fromTime
    && left.toTime === right.toTime
    && left.fluxMean === right.fluxMean
    && left.fluxMin === right.fluxMin
    && left.fluxMax === right.fluxMax
    && left.nearestStarDistance === right.nearestStarDistance
    && left.fate === right.fate;
}

function pendingStepFor(
  runId: string,
  skySample: SkySample,
  cosmosSnapshot?: CosmosSnapshot,
): PendingStepRequest {
  const latest = latestFrames.get(runId) ?? null;
  if (!latest?.authorityRevision) {
    throw new ElandSessionMissingError('推进月份前必须先读取完整权威帧');
  }
  const currentAuthorityEpoch = authorityEpoch(runId);
  const existing = pendingSteps.get(runId);
  const stillBasedOnCurrentFrame = existing
    && existing.authorityEpoch === currentAuthorityEpoch
    && existing.expectedAuthorityRevision === latest.authorityRevision
    && existing.expectedElapsedMonths === (latest?.elapsedMonths ?? 0)
    && existing.expectedBranchId === latest.branchId
    && existing.expectedCivilizationId === latest.civilizationId;
  if (existing && stillBasedOnCurrentFrame) return existing;
  if (existing) pendingSteps.delete(runId);
  const request: PendingStepRequest = {
    stepId: createStepId(),
    authorityEpoch: currentAuthorityEpoch,
    expectedElapsedMonths: latest?.elapsedMonths ?? 0,
    expectedAuthorityRevision: latest.authorityRevision,
    expectedBranchId: latest.branchId,
    expectedCivilizationId: latest.civilizationId,
    skySample: { ...skySample },
    ...(cosmosSnapshot ? { cosmosSnapshot: structuredClone(cosmosSnapshot) } : {}),
  };
  pendingSteps.set(runId, request);
  return request;
}

function reconcilePendingStep(runId: string, frame: Frame | null): void {
  const pending = pendingSteps.get(runId);
  if (!pending || !frame) return;
  if (frame.authorityRevision !== pending.expectedAuthorityRevision
    || frame.elapsedMonths !== pending.expectedElapsedMonths
    || (pending.expectedBranchId !== undefined && frame.branchId !== pending.expectedBranchId)
    || (pending.expectedCivilizationId !== undefined && frame.civilizationId !== pending.expectedCivilizationId)) {
    pendingSteps.delete(runId);
  }
}

function randomRunId(): string {
  return `threebody-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 为一次全新文明生成独立种子；保留该值即可精确重放同一开局。 */
export function createWorldSeed(): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0] || 1;
}

/** 同一标签页刷新时复用 runId，让 begin 原地替换旧会话，避免刷新泄漏。 */
export function getElandRunId(): string {
  if (typeof window === 'undefined') return randomRunId();
  const storageKey = 'threebody:eland:run-id';
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const runId = randomRunId();
    window.sessionStorage.setItem(storageKey, runId);
    return runId;
  } catch {
    return randomRunId();
  }
}

interface RequestAbortScope {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

function createRequestAbortScope(route: string, options: ElandRequestOptions = {}): RequestAbortScope {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ELAND_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${route} 的 timeoutMs 必须是正数`);
  }
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

async function requestJson<T>(
  route: string,
  init: RequestInit,
  options: ElandRequestOptions = {},
): Promise<T> {
  const abortScope = createRequestAbortScope(route, options);
  let res: Response | undefined;
  try {
    res = await fetch(`/api/eland/${route}`, { ...init, signal: abortScope.signal });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({})) as { error?: string; embodiment?: EmbodimentView };
      const message = detail.error ?? `${route} 返回 ${res.status}`;
      if (res.status === 404) throw new ElandSessionMissingError(message);
      if (res.status >= 500) throw new ElandBackendUnavailableError(message);
      throw new ElandRequestConflictError(res.status, message, detail.embodiment);
    }
    return await res.json() as T;
  } catch (error) {
    if (abortScope.timedOut()) throw new ElandRequestTimeoutError(route, options.timeoutMs ?? DEFAULT_ELAND_REQUEST_TIMEOUT_MS);
    if (options.signal?.aborted) throw new ElandBackendUnavailableError(`演化请求 ${route} 已取消`);
    if (error instanceof ElandSessionMissingError || error instanceof ElandBackendUnavailableError) throw error;
    if (!res) throw new ElandBackendUnavailableError('演化后端暂时不可用');
    throw error;
  } finally {
    abortScope.dispose();
  }
}

async function post<T>(
  route: string,
  body: unknown,
  options?: ElandRequestOptions,
  keepalive = false,
): Promise<T> {
  return requestJson<T>(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(keepalive ? { keepalive: true } : {}),
  }, options);
}

async function get<T>(route: string, options?: ElandRequestOptions): Promise<T> {
  return requestJson<T>(route, { cache: 'no-store' }, options);
}

async function stepWithRecovery(
  runId: string,
  skySample: SkySample,
  cosmosSnapshot?: CosmosSnapshot,
  requestOptions?: ElandRequestOptions,
): Promise<ElandStepResult> {
  const request = pendingStepFor(runId, skySample, cosmosSnapshot);
  try {
    const payload = await post<ElandStepPayload>('step', {
      runId,
      stepId: request.stepId,
      ...(request.expectedAuthorityRevision
        ? { expectedAuthorityRevision: request.expectedAuthorityRevision }
        : {}),
      ...(request.expectedCivilizationId !== undefined
        ? { expectedCivilizationId: request.expectedCivilizationId }
        : {}),
      ...(request.expectedBranchId ? { expectedBranchId: request.expectedBranchId } : {}),
      expectedElapsedMonths: request.expectedElapsedMonths,
      skySample: request.skySample,
      ...(request.cosmosSnapshot ? { cosmosSnapshot: request.cosmosSnapshot } : {}),
    }, requestOptions);
    if (authorityEpoch(runId) !== request.authorityEpoch) {
      return {
        frame: latestFrames.get(runId) ?? null,
        stepId: request.stepId,
        expectedElapsedMonths: request.expectedElapsedMonths,
        skySampleAcknowledged: false,
      };
    }
    const previous = latestFrames.get(runId) ?? null;
    let frame = applyStepPayload(previous, payload);
    let authoritativeHistory: NarrativeEntryView[] | undefined;
    let authoritativeHistoryTotalCount: number | undefined;
    let authoritativeCivilizationIndexHistory: CivilizationIndexHistoryPoint[] | undefined;
    if (payload.kind === 'patch' && !frame) {
      const refreshed = await get<{
        playing: boolean;
        model: 'local' | ModelProvider;
        frame: Frame | null;
        history: NarrativeEntryView[];
        historyTotalCount?: number;
        civilizationIndexHistory: CivilizationIndexHistoryPoint[];
      }>(`state?runId=${encodeURIComponent(runId)}`, requestOptions);
      if (authorityEpoch(runId) !== request.authorityEpoch) {
        return {
          frame: latestFrames.get(runId) ?? null,
          stepId: request.stepId,
          expectedElapsedMonths: request.expectedElapsedMonths,
          skySampleAcknowledged: false,
        };
      }
      frame = refreshed.frame;
      authoritativeHistory = refreshed.history;
      authoritativeHistoryTotalCount = refreshed.historyTotalCount ?? refreshed.history.length;
      authoritativeCivilizationIndexHistory = refreshed.civilizationIndexHistory;
    }
    // A delayed duplicate must never move a newer local authority head back.
    if (frame && previous
      && frame.runId === previous.runId
      && frame.authorityRevision === previous.authorityRevision
      && frame.branchId === previous.branchId
      && frame.elapsedMonths < previous.elapsedMonths) {
      frame = previous;
    }
    if (frame && frame.authorityRevision !== request.expectedAuthorityRevision) {
      beginAuthoritySwitch(runId);
      latestFrames.set(runId, frame);
      return {
        frame,
        stepId: request.stepId,
        expectedElapsedMonths: request.expectedElapsedMonths,
        skySampleAcknowledged: false,
        ...(authoritativeHistory ? { authoritativeHistory } : {}),
        ...(authoritativeHistoryTotalCount !== undefined ? { authoritativeHistoryTotalCount } : {}),
        ...(authoritativeCivilizationIndexHistory
          ? { authoritativeCivilizationIndexHistory }
          : {}),
      };
    }
    latestFrames.set(runId, frame);
    if (pendingSteps.get(runId) === request) pendingSteps.delete(runId);
    const skySampleAcknowledged = Boolean(frame
      && frame.authorityRevision === request.expectedAuthorityRevision
      && frame.elapsedMonths === request.expectedElapsedMonths + 1
      && sameSkySample(frame.skySample, request.skySample));
    return {
      frame,
      stepId: request.stepId,
      expectedElapsedMonths: request.expectedElapsedMonths,
      skySampleAcknowledged,
      ...(authoritativeHistory ? { authoritativeHistory } : {}),
      ...(authoritativeHistoryTotalCount !== undefined ? { authoritativeHistoryTotalCount } : {}),
      ...(authoritativeCivilizationIndexHistory
        ? { authoritativeCivilizationIndexHistory }
        : {}),
    };
  } catch (error) {
    // Network failure, timeout, server restart, or missing in-memory hydration
    // all leave the commit result uncertain. Keep the exact request for retry.
    if (!(error instanceof ElandBackendUnavailableError)
      && !(error instanceof ElandSessionMissingError)
      && pendingSteps.get(runId) === request) {
      pendingSteps.delete(runId);
    }
    throw error;
  }
}

export const elandClient = {
  begin: async (
    runId: string,
    creationId: string,
    skySample: SkySample,
    characterIds?: string[],
    worldSeed = createWorldSeed(),
    cosmosSnapshot?: CosmosSnapshot,
    requestOptions?: ElandRequestOptions,
  ) => {
    const requestAuthorityEpoch = beginAuthoritySwitch(runId);
    const frame = await post<Frame>('begin', {
      runId,
      leaseId: PAGE_LEASE_ID,
      creationId,
      worldSeed,
      skySample,
      ...(cosmosSnapshot ? { cosmosSnapshot } : {}),
      ...(characterIds && characterIds.length > 0 ? { characterIds } : {}),
    }, requestOptions);
    if (authorityEpoch(runId) === requestAuthorityEpoch) latestFrames.set(runId, frame);
    return frame;
  },
  step: async (
    runId: string,
    skySample: SkySample,
    cosmosSnapshot?: CosmosSnapshot,
    requestOptions?: ElandRequestOptions,
  ) => (
    await stepWithRecovery(runId, skySample, cosmosSnapshot, requestOptions)
  ).frame,
  stepWithRecovery,
  state: async (runId: string, requestOptions?: ElandRequestOptions) => {
    const requestAuthorityEpoch = authorityEpoch(runId);
    const previous = latestFrames.get(runId) ?? null;
    const result = await get<{
      playing: boolean;
      model: 'local' | ModelProvider;
      frame: Frame | null;
      history: NarrativeEntryView[];
      historyTotalCount?: number;
      civilizationIndexHistory: CivilizationIndexHistoryPoint[];
      embodiment: EmbodimentView | null;
    }>(`state?runId=${encodeURIComponent(runId)}`, requestOptions);
    if (authorityEpoch(runId) === requestAuthorityEpoch) {
      if (previous && (!result.frame
        || previous.authorityRevision !== result.frame.authorityRevision)) {
        beginAuthoritySwitch(runId);
      }
      latestFrames.set(runId, result.frame);
      reconcilePendingStep(runId, result.frame);
    }
    return {
      ...result,
      historyTotalCount: result.historyTotalCount ?? result.history.length,
    };
  },
  observe: async (
    runId: string,
    active: boolean,
    playbackIntervalMs: number,
    requestOptions?: ElandRequestOptions,
  ): Promise<ElandObserverResult> => {
    const requestAuthorityEpoch = authorityEpoch(runId);
    const previous = latestFrames.get(runId) ?? null;
    const result = await post<{
      runner: ElandObserverResult['runner'];
      payload: ElandStepPayload | null;
      history?: NarrativeEntryView[];
      historyTotalCount?: number;
      civilizationIndexHistory?: CivilizationIndexHistoryPoint[];
    }>('observe', {
      runId,
      observerId: PAGE_LEASE_ID,
      active,
      playbackIntervalMs,
      ...(previous ? {
        knownAuthorityRevision: previous.authorityRevision,
        knownCivilizationId: previous.civilizationId,
        knownBranchId: previous.branchId,
        knownElapsedMonths: previous.elapsedMonths,
      } : {}),
    }, requestOptions);
    if (authorityEpoch(runId) !== requestAuthorityEpoch) {
      return { frame: latestFrames.get(runId) ?? null, runner: result.runner };
    }
    let frame = result.payload ? applyStepPayload(previous, result.payload) : previous;
    let history = result.history;
    let historyTotalCount = result.historyTotalCount;
    let civilizationIndexHistory = result.civilizationIndexHistory;
    if (result.payload && !frame) {
      const refreshed = await get<{
        playing: boolean;
        model: 'local' | ModelProvider;
        frame: Frame | null;
        history: NarrativeEntryView[];
        historyTotalCount?: number;
        civilizationIndexHistory: CivilizationIndexHistoryPoint[];
      }>(`state?runId=${encodeURIComponent(runId)}`, requestOptions);
      frame = refreshed.frame;
      history = refreshed.history;
      historyTotalCount = refreshed.historyTotalCount ?? refreshed.history.length;
      civilizationIndexHistory = refreshed.civilizationIndexHistory;
    }
    if (authorityEpoch(runId) !== requestAuthorityEpoch) {
      return { frame: latestFrames.get(runId) ?? null, runner: result.runner };
    }
    if (frame && previous && frame.authorityRevision !== previous.authorityRevision) {
      beginAuthoritySwitch(runId);
    }
    latestFrames.set(runId, frame);
    reconcilePendingStep(runId, frame);
    return {
      frame,
      runner: result.runner,
      ...(history ? { authoritativeHistory: history } : {}),
      ...(historyTotalCount !== undefined ? { authoritativeHistoryTotalCount: historyTotalCount } : {}),
      ...(civilizationIndexHistory
        ? { authoritativeCivilizationIndexHistory: civilizationIndexHistory }
        : {}),
    };
  },
  releaseObserver: (runId: string, playbackIntervalMs: number) => {
    const previous = latestFrames.get(runId) ?? null;
    const body = JSON.stringify({
      runId,
      observerId: PAGE_LEASE_ID,
      active: false,
      playbackIntervalMs,
      ...(previous ? {
        knownAuthorityRevision: previous.authorityRevision,
        knownCivilizationId: previous.civilizationId,
        knownBranchId: previous.branchId,
        knownElapsedMonths: previous.elapsedMonths,
      } : {}),
    });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.('/api/eland/observe', body)) {
      return Promise.resolve();
    }
    return post<{ runner: ElandObserverResult['runner']; payload: ElandStepPayload | null }>(
      'observe',
      JSON.parse(body),
      undefined,
      true,
    ).then(() => undefined).catch(() => undefined);
  },
  embodimentState: (runId: string, requestOptions?: ElandRequestOptions) => get<{
    embodiment: EmbodimentView | null;
  }>(`embodiment-state?runId=${encodeURIComponent(runId)}`, requestOptions),
  beginEmbodiment: (
    input: BeginEmbodimentRequest,
    requestOptions?: ElandRequestOptions,
  ) => post<{ embodiment: EmbodimentView }>('embodiment-begin', input, requestOptions),
  stepEmbodiment: async (
    input: EmbodimentStepRequest,
    requestOptions?: ElandRequestOptions,
  ) => {
    const result = await post<EmbodimentStepResponse>('embodiment-step', input, requestOptions);
    if ('committedFrame' in result) {
      latestFrames.set(input.runId, result.committedFrame);
      pendingSteps.delete(input.runId);
    }
    return result;
  },
  releaseEmbodiment: async (
    input: ReleaseEmbodimentRequest,
    requestOptions?: ElandRequestOptions,
  ) => {
    const result = await post<EmbodimentReleaseResponse>('embodiment-release', input, requestOptions);
    latestFrames.set(input.runId, result.committedFrame);
    pendingSteps.delete(input.runId);
    return result;
  },
  history: (runId: string, requestOptions?: ElandRequestOptions) => get<{
    civilizationId: number;
    history: { month: number; label: string; summary: string }[];
    branches: { id: string; parentBranchId?: string; forkAtMonth: number; headAtMonth: number; active: boolean }[];
  }>(`history?runId=${encodeURIComponent(runId)}`, requestOptions),
  frameAt: (runId: string, month: number, requestOptions?: ElandRequestOptions) => get<Frame | null>(
    `frame?runId=${encodeURIComponent(runId)}&month=${month}`,
    requestOptions,
  ),
  agentHistory: (
    runId: string,
    agentId: string,
    month: number,
    limit = 80,
    requestOptions?: ElandRequestOptions,
  ) => get<AgentHistoryView | null>(
    `agent-history?runId=${encodeURIComponent(runId)}&agentId=${encodeURIComponent(agentId)}&month=${month}&limit=${limit}`,
    requestOptions,
  ),
  agentMemory: (
    runId: string,
    agentId: string,
    month: number,
    limit = 24,
    requestOptions?: ElandRequestOptions,
  ) => get<AgentMemoryView | null>(
    `agent-memory?runId=${encodeURIComponent(runId)}&agentId=${encodeURIComponent(agentId)}&month=${month}&limit=${limit}`,
    requestOptions,
  ),
  agentConversation: (runId: string, agentId: string, requestOptions?: ElandRequestOptions) => get<AgentConversationView>(
    `agent-conversation?runId=${encodeURIComponent(runId)}&agentId=${encodeURIComponent(agentId)}`,
    requestOptions,
  ),
  sendAgentConversation: (input: {
    runId: string;
    agentId: string;
    message: string;
    requestKind: 'conversation' | 'suggestion';
    clientMessageId: string;
    observedBranchId: string;
  }, requestOptions?: ElandRequestOptions) => post<{ conversation: AgentConversationView; turn: AgentConversationTurn }>(
    'agent-conversation',
    input,
    requestOptions,
  ),
  seek: async (runId: string, month: number, requestOptions?: ElandRequestOptions) => {
    const requestAuthorityEpoch = beginAuthoritySwitch(runId);
    const frame = await post<Frame | null>('seek', { runId, month }, requestOptions);
    if (authorityEpoch(runId) === requestAuthorityEpoch) latestFrames.set(runId, frame);
    return frame;
  },
  saves: (runId: string, requestOptions?: ElandRequestOptions) => get<{ saves: ElandSaveSummary[] }>(
    `saves?runId=${encodeURIComponent(runId)}`,
    requestOptions,
  ),
  save: (runId: string, label?: string, requestOptions?: ElandRequestOptions) => post<{ save: ElandSaveSummary }>('save', {
    runId,
    leaseId: PAGE_LEASE_ID,
    ...(label?.trim() ? { label: label.trim() } : {}),
  }, requestOptions),
  loadSave: async (runId: string, saveId: string, requestOptions?: ElandRequestOptions) => {
    const requestAuthorityEpoch = beginAuthoritySwitch(runId);
    const loaded = await post<{
      save: ElandSaveSummary;
      frame: Frame;
      history: NarrativeEntryView[];
      historyTotalCount?: number;
      civilizationIndexHistory: CivilizationIndexHistoryPoint[];
    }>('load', { runId, leaseId: PAGE_LEASE_ID, saveId }, requestOptions);
    if (authorityEpoch(runId) === requestAuthorityEpoch) latestFrames.set(runId, loaded.frame);
    return {
      ...loaded,
      historyTotalCount: loaded.historyTotalCount ?? loaded.history.length,
    };
  },
  settleCivilization: async (runId: string, requestOptions?: ElandRequestOptions) => {
    const latest = latestFrames.get(runId);
    if (!latest) throw new ElandSessionMissingError('结算文明前必须先读取权威状态');
    const { frame } = await post<{ frame: Frame }>('settle-civilization', {
      runId,
      leaseId: PAGE_LEASE_ID,
      expectedCivilizationId: latest.civilizationId,
      expectedBranchId: latest.branchId,
      expectedElapsedMonths: latest.elapsedMonths,
    }, requestOptions);
    latestFrames.set(runId, frame);
    pendingSteps.delete(runId);
    return frame;
  },
  civilizationRequiem: (
    runId: string,
    input: {
      civilizationId: number;
      branchId: string;
      endedAtMonth: number;
    },
    requestOptions?: ElandRequestOptions,
  ) => post<{ requiem: CivilizationRequiem }>('civilization-requiem', {
    runId,
    leaseId: PAGE_LEASE_ID,
    expectedCivilizationId: input.civilizationId,
    expectedBranchId: input.branchId,
    expectedEndedAtMonth: input.endedAtMonth,
  }, requestOptions).then(({ requiem }) => requiem),
  checkpoint: (runId: string, requestOptions?: ElandRequestOptions) => {
    const body = JSON.stringify({ runId, leaseId: PAGE_LEASE_ID });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.('/api/eland/checkpoint', body)) {
      return Promise.resolve();
    }
    return post<{ persisted: boolean }>('checkpoint', { runId, leaseId: PAGE_LEASE_ID }, requestOptions, true)
      .then(() => undefined)
      .catch(() => undefined);
  },
  end: (runId: string, requestOptions?: ElandRequestOptions) => {
    beginAuthoritySwitch(runId);
    latestFrames.delete(runId);
    const body = JSON.stringify({ runId, leaseId: PAGE_LEASE_ID });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.('/api/eland/end', body)) {
      return Promise.resolve();
    }
    return post<{ ended: boolean; activeSessions: number }>('end', { runId, leaseId: PAGE_LEASE_ID }, requestOptions, true)
      .then(() => undefined)
      .catch(() => undefined);
  },
};
