import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createSimulation,
  type SimulationState,
} from "../src/game/eland/simulation";

export interface RunSummary {
  schemaVersion: 1;
  id: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  elapsedMonths: number;
  civilizationNo: number;
  status: SimulationState["civilization"]["status"];
  livingAgents: number;
  agentCount: number;
  eventCount: number;
  milestoneCount: number;
}

export interface PersistedRun {
  meta: RunSummary;
  state: SimulationState;
}

export class RunNotFoundError extends Error {}
export class RunAlreadyExistsError extends Error {}

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function normalizeId(value?: string): string {
  if (!value) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `run-${stamp}-${randomUUID().slice(0, 8)}`;
  }
  if (!RUN_ID_PATTERN.test(value)) throw new Error("运行 id 仅支持 1-64 位字母、数字、下划线或连字符");
  return value;
}

function summaryFor(
  id: string,
  state: SimulationState,
  previous?: RunSummary,
  label?: string,
): RunSummary {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    ...(label?.trim() ? { label: label.trim().slice(0, 100) } : previous?.label ? { label: previous.label } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    revision: previous ? previous.revision + 1 : 1,
    elapsedMonths: state.clock.elapsedMonths,
    civilizationNo: state.civilization.number,
    status: state.civilization.status,
    livingAgents: state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0).length,
    agentCount: state.people.length,
    eventCount: state.world.past.length,
    milestoneCount: state.derived.milestones.length,
  };
}

function migrated(input: SimulationState): SimulationState {
  return createSimulation({ state: input }).getState();
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export class FileRunStore {
  constructor(private readonly rootDir: string) {}

  dataDirectory(): string {
    return this.rootDir;
  }

  private runDir(id: string): string {
    return path.join(this.rootDir, normalizeId(id));
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async list(): Promise<RunSummary[]> {
    await this.ensureRoot();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const metas = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        return JSON.parse(await readFile(path.join(this.rootDir, entry.name, "meta.json"), "utf8")) as RunSummary;
      } catch {
        return null;
      }
    }));
    return metas.filter((meta): meta is RunSummary => Boolean(meta)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<PersistedRun> {
    const dir = this.runDir(id);
    try {
      const [metaText, stateText] = await Promise.all([
        readFile(path.join(dir, "meta.json"), "utf8"),
        readFile(path.join(dir, "state.json"), "utf8"),
      ]);
      const meta = JSON.parse(metaText) as RunSummary;
      const state = migrated(JSON.parse(stateText) as SimulationState);
      return { meta, state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunNotFoundError(`运行 ${id} 不存在`);
      throw error;
    }
  }

  async create(input: { id?: string; label?: string; state: SimulationState }): Promise<PersistedRun> {
    await this.ensureRoot();
    const id = normalizeId(input.id);
    const dir = this.runDir(id);
    try {
      await mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RunAlreadyExistsError(`运行 ${id} 已存在`);
      throw error;
    }
    const state = migrated(input.state);
    const meta = summaryFor(id, state, undefined, input.label);
    await writeJsonAtomic(path.join(dir, "state.json"), state);
    await writeJsonAtomic(path.join(dir, "meta.json"), meta);
    return { meta, state };
  }

  async save(id: string, stateInput: SimulationState, label?: string): Promise<PersistedRun> {
    const current = await this.load(id);
    const state = migrated(stateInput);
    const meta = summaryFor(current.meta.id, state, current.meta, label);
    const dir = this.runDir(current.meta.id);
    await writeJsonAtomic(path.join(dir, "state.json"), state);
    await writeJsonAtomic(path.join(dir, "meta.json"), meta);
    return { meta, state };
  }
}
