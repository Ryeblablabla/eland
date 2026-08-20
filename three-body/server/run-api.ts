import {
  createDefaultSimulationConfig,
  createSimulation,
  type SimulationConfig,
  type SimulationState,
} from '../src/game/eland/simulation';
import { HttpError } from './http-error';
import { modelEndpointStatus } from './model-config';
import type { NarrativeEnhancementService } from './narrative-enhancement-service';
import {
  NARRATIVE_ENHANCEMENT_KINDS,
  narrativeEnhancementCounts,
  type NarrativeEnhancementKind,
} from './narrative-enhancements';
import type { PersistedRun } from './run-persistence';
import type { RunEvolutionService } from './run-evolution-service';
import type { SqliteRunStore } from './sqlite-run-store';

export interface RunApiResponse {
  status: number;
  body: unknown;
}

export type ReadRunApiBody = () => Promise<unknown>;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function stateFrom(value: unknown): SimulationState {
  const object = asObject(value);
  const candidate = object.state ?? object.finalState ?? (object.run as Record<string, unknown> | undefined)?.state ?? value;
  if (!candidate
    || typeof candidate !== 'object'
    || !Array.isArray((candidate as SimulationState).people)
    || !(candidate as SimulationState).world) {
    throw new HttpError(400, '没有找到可导入的 SimulationState');
  }
  try {
    return createSimulation({ state: candidate as SimulationState }).getState();
  } catch (error) {
    throw new HttpError(400, `状态导入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function responseRun(run: PersistedRun, includeState = true): unknown {
  return includeState ? run : { meta: run.meta };
}

function narrativeKinds(value: unknown): NarrativeEnhancementKind[] {
  if (value === undefined) return [...NARRATIVE_ENHANCEMENT_KINDS];
  if (!Array.isArray(value)) throw new HttpError(400, 'kinds 必须是 dialogue、memory、history 的数组');
  const allowed = new Set<string>(NARRATIVE_ENHANCEMENT_KINDS);
  const kinds = [...new Set(value.filter((kind): kind is NarrativeEnhancementKind => typeof kind === 'string' && allowed.has(kind)))];
  if (!kinds.length || kinds.length !== value.length) throw new HttpError(400, 'kinds 只能包含 dialogue、memory、history');
  return kinds;
}

function enhancementTaskLimit(value: unknown): number {
  const number = Number(value ?? 6);
  if (!Number.isInteger(number) || number < 0 || number > 24) {
    throw new HttpError(400, 'maxTasks 必须是 0-24 的整数');
  }
  return number;
}

/** HTTP adapter for persisted runs. It does not own simulation or storage policy. */
export class RunApi {
  constructor(
    private readonly store: SqliteRunStore,
    private readonly evolution: RunEvolutionService,
    private readonly narrativeEnhancements: NarrativeEnhancementService,
  ) {}

  async handle(method: string | undefined, url: URL, readBody: ReadRunApiBody): Promise<RunApiResponse> {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'runs') throw new HttpError(404, '接口不存在');

    if (method === 'GET' && parts.length === 2) {
      return { status: 200, body: { runs: await this.store.list() } };
    }

    if (method === 'POST' && parts.length === 2) {
      return { status: 201, body: responseRun(await this.createRun(await readBody(), false)) };
    }

    if (method === 'POST' && parts[2] === 'import' && parts.length === 3) {
      return { status: 201, body: responseRun(await this.createRun(await readBody(), true)) };
    }

    const id = decodeURIComponent(parts[2] ?? '');
    if (!id) throw new HttpError(404, '接口不存在');

    if (method === 'GET' && parts.length === 3) {
      return { status: 200, body: await this.store.load(id) };
    }

    if (method === 'GET' && parts[3] === 'state' && parts.length === 4) {
      return { status: 200, body: (await this.store.load(id)).state };
    }

    if (method === 'PUT' && parts[3] === 'state' && parts.length === 4) {
      const importedState = stateFrom(await readBody());
      const saved = await this.evolution.serializeRun(
        id,
        () => this.store.save(id, importedState, undefined, { historyMode: 'replace' }),
      );
      return { status: 200, body: saved };
    }

    if (method === 'POST' && parts[3] === 'evolve' && parts.length === 4) {
      return { status: 202, body: await this.evolution.evolve(id, await readBody()) };
    }

    if (method === 'GET' && parts[3] === 'evolution' && parts.length === 4) {
      const evolution = await this.store.loadEvolutionPath(id);
      if (!evolution) throw new HttpError(404, `运行 ${id} 尚无演化路径`);
      return { status: 200, body: evolution };
    }

    if (method === 'GET' && parts[3] === 'report' && parts.length === 4) {
      const report = await this.store.loadEvolutionReport(id);
      if (!report) throw new HttpError(404, `运行 ${id} 尚无演化报告`);
      return { status: 200, body: report };
    }

    if (method === 'GET' && parts[3] === 'enhancements' && parts.length === 4) {
      const artifact = await this.narrativeEnhancements.load(id);
      if (!artifact) throw new HttpError(404, `运行 ${id} 尚无叙事增强旁车`);
      const modelEndpoint = modelEndpointStatus('narrative');
      return {
        status: 200,
        body: {
          artifact,
          counts: narrativeEnhancementCounts(artifact),
          processing: this.narrativeEnhancements.isProcessing(id),
          providerConfigured: modelEndpoint.configured,
          modelEndpoint,
          authoritativeStateChanged: false,
        },
      };
    }

    if (method === 'POST' && parts[3] === 'enhancements' && parts.length === 4) {
      const body = asObject(await readBody());
      const result = await this.narrativeEnhancements.trigger(id, {
        kinds: narrativeKinds(body.kinds),
        maxNewTasks: enhancementTaskLimit(body.maxTasks),
        retryFailed: body.retryFailed === true,
        dispatch: body.dispatch !== false,
      });
      return { status: 202, body: { ...result, authoritativeStateChanged: false } };
    }

    throw new HttpError(404, '接口不存在');
  }

  private async createRun(bodyValue: unknown, imported: boolean): Promise<PersistedRun> {
    const body = asObject(bodyValue);
    let state: SimulationState;
    if (imported || body.state || body.finalState || body.run) {
      state = stateFrom(body);
    } else {
      const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : 17;
      const config = createDefaultSimulationConfig((body.config ?? {}) as Partial<SimulationConfig>);
      state = createSimulation({ seed, config }).getState();
    }
    return this.store.create({
      id: typeof body.id === 'string' ? body.id : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      state,
    });
  }
}
