import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { deserialize } from "node:v8";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-sqlite-run-store-test-"));
const storeBundlePath = path.join(temporaryDirectory, "sqlite-run-store.mjs");
const simulationBundlePath = path.join(temporaryDirectory, "simulation.mjs");
const dataDirectory = path.join(temporaryDirectory, "runs");

try {
  execFileSync(path.resolve("node_modules/.bin/esbuild"), [
    "server/sqlite-run-store.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${storeBundlePath}`,
  ], { stdio: "pipe" });
  execFileSync(path.resolve("node_modules/.bin/esbuild"), [
    "src/game/eland/simulation.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${simulationBundlePath}`,
  ], { stdio: "pipe" });

  const {
    ELAND_DATABASE_FILENAME,
    SqliteRunStore,
    RunAlreadyExistsError,
    RunNotFoundError,
  } = await import(`${pathToFileURL(storeBundlePath).href}?test=${Date.now()}`);
  const { createInitialState } = await import(
    `${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`
  );

  const state = createInitialState(1907, { endpoint: { kind: "months", value: 12 } });
  const store = new SqliteRunStore(dataDirectory);
  const databaseFile = path.join(dataDirectory, ELAND_DATABASE_FILENAME);
  assert.equal(Number(store.database.prepare("PRAGMA busy_timeout").get().timeout), 5_000);
  assert.equal(store.dataDirectory(), dataDirectory);
  assert.equal(existsSync(databaseFile), true);

  await assert.rejects(
    store.load("missing"),
    (error) => error instanceof RunNotFoundError && error.message === "运行 missing 不存在",
  );
  await assert.rejects(
    store.save("missing", state),
    (error) => error instanceof RunNotFoundError && error.message === "运行 missing 不存在",
  );
  assert.equal(await store.loadEvolutionPath("missing"), null);

  const created = await store.create({ id: "sqlite-roundtrip", label: " before ", state });
  assert.equal(created.meta.revision, 1);
  assert.equal(created.meta.label, "before");
  assert.equal(created.meta.elapsedMonths, 0);
  await assert.rejects(
    store.create({ id: "sqlite-roundtrip", state }),
    (error) => error instanceof RunAlreadyExistsError && error.message === "运行 sqlite-roundtrip 已存在",
  );

  assert.deepEqual((await store.list()).map((meta) => meta.id), ["sqlite-roundtrip"]);

  const unchanged = await store.save("sqlite-roundtrip", created.state);
  assert.equal(unchanged.meta.revision, 2);
  assert.equal(unchanged.meta.label, "before");

  const stateAtMonthTwelve = structuredClone(unchanged.state);
  stateAtMonthTwelve.clock.elapsedMonths = 12;
  const saved = await store.save("sqlite-roundtrip", stateAtMonthTwelve, "after");
  assert.equal(saved.meta.revision, 3);
  assert.equal(saved.meta.createdAt, created.meta.createdAt);
  assert.equal(saved.meta.label, "after");
  assert.equal(saved.meta.elapsedMonths, 12);
  assert.equal((await store.load("sqlite-roundtrip")).state.clock.elapsedMonths, 12);

  const evolution = {
    schemaVersion: 2,
    runId: "sqlite-roundtrip",
    provider: "local",
    model: "rule-planner-v1",
    status: "completed",
    startedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:01.000Z",
    fromMonth: 0,
    requestedEndMonth: 12,
    reachedMonth: 12,
    checkpoints: [],
    turningPoints: [],
  };
  const report = { schemaVersion: 4, runId: "sqlite-roundtrip", throughMonth: 12, title: "facts" };
  const enhancements = {
    schemaVersion: 1,
    runId: "sqlite-roundtrip",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:01.000Z",
    lastScannedAt: "2026-08-20T00:00:01.000Z",
    lastScannedBranchId: "main",
    lastScannedRevision: 3,
    tasks: [],
  };

  await store.saveEvolutionPath("sqlite-roundtrip", evolution);
  await store.saveEvolutionPath("sqlite-roundtrip", evolution);
  await store.saveEvolutionReport("sqlite-roundtrip", report);
  await store.saveNarrativeEnhancements("sqlite-roundtrip", enhancements);
  assert.deepEqual(await store.loadEvolutionPath("sqlite-roundtrip"), evolution);
  assert.deepEqual(await store.loadEvolutionReport("sqlite-roundtrip"), report);
  assert.deepEqual(await store.loadNarrativeEnhancements("sqlite-roundtrip"), enhancements);

  const chunkCount = () => Number(
    store.database.prepare("SELECT COUNT(*) AS count FROM chunks").get().count,
  );
  const runStateChunkCount = Number(store.database.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE codec LIKE 'eland-run-%'
  `).get().count);
  assert.equal(chunkCount(), runStateChunkCount + 3);
  const firstEvolutionReplacement = {
    ...evolution,
    updatedAt: "2026-08-20T00:00:02.000Z",
    turningPoints: [{ month: 12, summary: "replacement" }],
  };
  await store.saveEvolutionPath("sqlite-roundtrip", firstEvolutionReplacement);
  assert.equal(chunkCount(), runStateChunkCount + 3, "覆盖 artifact 应以新 chunk 替换孤立旧 chunk");

  const sharedArtifact = { marker: "shared-artifact" };
  await store.saveEvolutionPath("sqlite-roundtrip", sharedArtifact);
  await store.saveEvolutionReport("sqlite-roundtrip", sharedArtifact);
  assert.equal(chunkCount(), runStateChunkCount + 2, "两个 artifact 应共享同一个内容块");
  const sharedHash = String(store.database.prepare(`
    SELECT chunk_hash FROM artifacts
    WHERE run_id = ? AND kind = 'evolution-report'
  `).get("sqlite-roundtrip").chunk_hash);

  const finalEvolution = { ...evolution, updatedAt: "2026-08-20T00:00:03.000Z" };
  await store.saveEvolutionPath("sqlite-roundtrip", finalEvolution);
  assert.equal(chunkCount(), runStateChunkCount + 3);
  assert.equal(
    Number(store.database.prepare("SELECT COUNT(*) AS count FROM chunks WHERE hash = ?").get(sharedHash).count),
    1,
    "仍被另一个 artifact 引用的共享 chunk 不得删除",
  );
  const finalReport = { ...report, title: "final facts" };
  await store.saveEvolutionReport("sqlite-roundtrip", finalReport);
  assert.equal(chunkCount(), runStateChunkCount + 3);
  assert.equal(
    Number(store.database.prepare("SELECT COUNT(*) AS count FROM chunks WHERE hash = ?").get(sharedHash).count),
    0,
    "最后一个引用被替换后应删除孤立 chunk",
  );

  const currentStateHashForSharing = String(store.database.prepare(`
    SELECT state_hash FROM runs WHERE id = ?
  `).get("sqlite-roundtrip").state_hash);
  await store.saveEvolutionPath("sqlite-roundtrip", saved.state);
  assert.equal(chunkCount(), runStateChunkCount + 3, "artifact 替换不应改变可达块总量");
  await store.saveEvolutionPath("sqlite-roundtrip", finalEvolution);
  assert.equal(chunkCount(), runStateChunkCount + 3);
  assert.equal(
    Number(store.database.prepare("SELECT COUNT(*) AS count FROM chunks WHERE hash = ?")
      .get(currentStateHashForSharing).count),
    1,
    "仍被运行与检查点引用的共享状态 chunk 不得删除",
  );
  assert.deepEqual(await store.loadEvolutionPath("sqlite-roundtrip"), finalEvolution);
  assert.deepEqual(await store.loadEvolutionReport("sqlite-roundtrip"), finalReport);
  await assert.rejects(
    store.saveEvolutionPath("missing", evolution),
    (error) => error instanceof RunNotFoundError && error.message === "运行 missing 不存在",
  );

  const integrityDatabase = new DatabaseSync(databaseFile);
  const currentStateChunk = integrityDatabase.prepare(`
    SELECT chunks.hash, chunks.codec, chunks.raw_size, chunks.data
    FROM runs JOIN chunks ON chunks.hash = runs.state_hash
    WHERE runs.id = ?
  `).get("sqlite-roundtrip");
  const currentStateHash = String(currentStateChunk.hash);
  const currentRawSize = Number(currentStateChunk.raw_size);
  integrityDatabase.prepare("UPDATE chunks SET raw_size = ? WHERE hash = ?")
    .run(currentRawSize + 1, currentStateHash);
  await assert.rejects(store.load("sqlite-roundtrip"), /运行状态根 .*长度与记录不一致/);
  integrityDatabase.prepare("UPDATE chunks SET raw_size = ? WHERE hash = ?")
    .run(currentRawSize, currentStateHash);

  const fakeHash = "f".repeat(64);
  integrityDatabase.prepare(`
    INSERT INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)
  `).run(fakeHash, currentStateChunk.codec, currentRawSize, currentStateChunk.data);
  integrityDatabase.prepare("UPDATE runs SET state_hash = ? WHERE id = ?")
    .run(fakeHash, "sqlite-roundtrip");
  await assert.rejects(store.load("sqlite-roundtrip"), /SHA-256 校验失败/);
  integrityDatabase.prepare("UPDATE runs SET state_hash = ? WHERE id = ?")
    .run(currentStateHash, "sqlite-roundtrip");
  integrityDatabase.prepare("DELETE FROM chunks WHERE hash = ?").run(fakeHash);

  const currentRoot = deserialize(currentStateChunk.data);
  assert.equal(currentRoot.schemaVersion, 3, "新运行状态根必须使用当前稳定的 schema 3 事件哈希与 shell 分段");
  const currentShellHash = String(currentRoot.shellHash);
  const currentShellCodec = String(integrityDatabase.prepare("SELECT codec FROM chunks WHERE hash = ?")
    .get(currentShellHash).codec);
  integrityDatabase.prepare("UPDATE chunks SET codec = ? WHERE hash = ?")
    .run("collision-codec", currentShellHash);
  await assert.rejects(
    store.save("sqlite-roundtrip", saved.state),
    /命中已有哈希，但编码、长度或内容不一致/,
  );
  integrityDatabase.prepare("UPDATE chunks SET codec = ? WHERE hash = ?")
    .run(currentShellCodec, currentShellHash);
  integrityDatabase.close();

  store.close();

  const reopened = new SqliteRunStore(dataDirectory);
  const reopenedRun = await reopened.load("sqlite-roundtrip");
  assert.equal(reopenedRun.meta.revision, 3);
  assert.equal(reopenedRun.state.clock.elapsedMonths, 12);
  assert.deepEqual(await reopened.loadEvolutionPath("sqlite-roundtrip"), finalEvolution);
  assert.deepEqual((await reopened.list()).map((meta) => meta.id), ["sqlite-roundtrip"]);
  reopened.close();

  const inspection = new DatabaseSync(databaseFile, { readOnly: true });
  const journalMode = inspection.prepare("PRAGMA journal_mode").get();
  assert.equal(journalMode.journal_mode, "wal");
  assert.equal(Number(inspection.prepare("PRAGMA user_version").get().user_version), 3);
  assert.deepEqual(
    inspection.prepare("PRAGMA table_info(runs)").all().map((column) => column.name),
    [
      "id", "state_hash", "schema_version", "label", "created_at", "updated_at",
      "revision", "elapsed_months", "civilization_no", "status", "living_agents",
      "agent_count", "event_count", "milestone_count",
    ],
  );

  const checkpoints = inspection.prepare(`
    SELECT revision, month, state_hash
    FROM run_checkpoints
    WHERE run_id = ?
    ORDER BY revision
  `).all("sqlite-roundtrip").map((row) => ({
    revision: Number(row.revision),
    month: Number(row.month),
    stateHash: String(row.state_hash),
  }));
  assert.deepEqual(checkpoints.map(({ revision, month }) => ({ revision, month })), [
    { revision: 1, month: 0 },
    { revision: 2, month: 0 },
    { revision: 3, month: 12 },
  ]);
  assert.equal(checkpoints[0].stateHash, checkpoints[1].stateHash, "相同状态应复用同一个内容块");
  assert.notEqual(checkpoints[1].stateHash, checkpoints[2].stateHash);

  const counts = {
    chunks: Number(inspection.prepare("SELECT COUNT(*) AS count FROM chunks").get().count),
    artifacts: Number(inspection.prepare("SELECT COUNT(*) AS count FROM artifacts").get().count),
  };
  assert.deepEqual(counts, { chunks: runStateChunkCount + 3, artifacts: 3 });
  inspection.close();

  console.log("sqlite run store persistence tests passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
