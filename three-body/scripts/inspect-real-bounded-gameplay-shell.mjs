import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [dataDirectoryInput, runId, hotEventLimitInput = '4096', referenceNeedleInput] = process.argv.slice(2);
if (!dataDirectoryInput || !runId) {
  throw new Error(
    '用法: NODE_OPTIONS=--max-old-space-size=512 node '
      + 'scripts/inspect-real-bounded-gameplay-shell.mjs <data-dir> <run-id> [hot-limit]',
  );
}

const heapCapMatches = [...String(process.env.NODE_OPTIONS ?? '').matchAll(
  /(?:^|\s)--max-old-space-size(?:=|\s+)(\d+)(?=\s|$)/gu,
)];
if (heapCapMatches.length !== 1 || Number(heapCapMatches[0][1]) !== 512) {
  throw new Error('该只读诊断必须且只能以 NODE_OPTIONS=--max-old-space-size=512 运行');
}

const hotEventLimit = Number(hotEventLimitInput);
if (!Number.isSafeInteger(hotEventLimit) || hotEventLimit < 0) {
  throw new Error('hot-limit 必须是非负安全整数');
}

const workspace = path.resolve(import.meta.dirname, '..');
const dataDirectory = path.resolve(dataDirectoryInput);
const databaseFile = path.join(dataDirectory, 'eland.sqlite3');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-real-gameplay-shell-'));
const codecBundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const startedAt = performance.now();
let database;

function byteMemoryUsage() {
  return Object.fromEntries(
    Object.entries(process.memoryUsage()).map(([name, bytes]) => [name, Number(bytes)]),
  );
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function countsBy(values, keyFor) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function referencePaths(root, needle, limit = 32) {
  if (!needle) return [];
  const matches = [];
  const seen = new WeakSet();
  const pending = [{ value: root, path: 'state' }];
  while (pending.length > 0 && matches.length < limit) {
    const current = pending.pop();
    if (current.value === needle) {
      matches.push(current.path);
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    for (const [key, value] of Object.entries(current.value)) {
      if ((current.path === 'state.world' && key === 'past')
        || (current.path === 'state.world' && key === 'grid')) continue;
      pending.push({ value, path: `${current.path}.${key}` });
    }
  }
  return matches;
}

function referenceOwners(state, needle) {
  if (!needle) return {};
  return {
    people: state.people.flatMap((person) => {
      const paths = referencePaths(person, needle, 16);
      return paths.length === 0 ? [] : [{
        id: person.id,
        diedAtMonth: person.diedAtMonth ?? null,
        health: person.body?.health ?? null,
        matchingKnowledge: person.knowledge.filter((fact) => fact.sourceEventIds.includes(needle))
          .map((fact) => ({ id: fact.id, kind: fact.kind, confidence: fact.confidence })),
        paths,
      }];
    }),
    projects: state.projects.flatMap((project) => {
      const paths = referencePaths(project, needle, 16);
      return paths.length === 0 ? [] : [{
        id: project.id,
        status: project.status,
        ownerId: project.ownerId,
        desiredFunction: project.desiredFunction,
        triggerFactIds: project.triggerFactIds,
        pressureBasis: project.pressureBasis ?? null,
        actionEventCount: project.actionEventIds.length,
        paths,
      }];
    }),
    intents: state.intents.flatMap((intent) => {
      const paths = referencePaths(intent, needle, 16);
      return paths.length === 0 ? [] : [{
        id: intent.id,
        status: intent.status,
        actorId: intent.actorId,
        sourceFactIds: intent.sourceFactIds,
        actionEventCount: intent.actionEventIds.length,
        paths,
      }];
    }),
  };
}

function livingRememberedSourceStats(state) {
  return state.people.flatMap((person) => {
    if (person.diedAtMonth !== undefined || Number(person.body?.health ?? 0) <= 0) return [];
    const categories = {
      memories: person.memories.flatMap((item) => item.sourceEventIds),
      conditions: person.conditions.flatMap((item) => item.sourceEventIds),
      knowledge: person.knowledge.flatMap((item) => item.sourceEventIds),
      inventory: person.inventory.flatMap((item) => item.sourceEventIds),
    };
    return [{
      personId: person.id,
      ...Object.fromEntries(Object.entries(categories).map(([key, ids]) => [key, new Set(ids).size])),
      union: new Set(Object.values(categories).flat()).size,
    }];
  });
}

try {
  database = new DatabaseSync(databaseFile, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 5000');

  const run = database.prepare(`
    SELECT id, state_hash, revision, elapsed_months, event_count,
           milestone_count, status, living_agents, agent_count
    FROM runs
    WHERE id = ?
  `).get(runId);
  assert.ok(run, `运行不存在: ${runId}`);

  const checkpoint = database.prepare(`
    SELECT run_id, revision, month, state_hash
    FROM run_checkpoints
    WHERE run_id = ? AND revision = ? AND state_hash = ?
  `).get(runId, run.revision, run.state_hash);
  assert.ok(checkpoint, '当前 run row 缺少 exact revision/state checkpoint');
  assert.equal(Number(checkpoint.month), Number(run.elapsed_months), 'checkpoint 月份与 run row 不一致');

  const selectChunk = database.prepare(`
    SELECT hash, codec, raw_size, data
    FROM chunks
    WHERE hash = ?
  `);
  let chunkReadCount = 0;
  let chunkReadBytes = 0;
  const uniqueChunkHashes = new Set();
  let uniqueChunkBytes = 0;
  const readChunk = (hash) => {
    const row = selectChunk.get(hash);
    assert.ok(row, `缺少数据库 chunk ${hash}`);
    const data = row.data;
    assert.ok(data instanceof Uint8Array, `数据库 chunk ${hash} 不是二进制内容`);
    chunkReadCount += 1;
    chunkReadBytes += data.byteLength;
    if (!uniqueChunkHashes.has(String(row.hash))) {
      uniqueChunkHashes.add(String(row.hash));
      uniqueChunkBytes += data.byteLength;
    }
    return {
      hash: String(row.hash),
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data,
    };
  };

  const rootChunk = readChunk(String(run.state_hash));
  const bundleStartedAt = performance.now();
  const diagnosticEntry = [
    `export { decodeSegmentedRunStateGameplayBounded } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { observeModernCivilizationEvidence } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/era-progression.ts'))};`,
  ].join('\n');
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--loader=ts',
    '--sourcefile=real-bounded-gameplay-diagnostic.ts',
    `--outfile=${codecBundlePath}`,
  ], {
    cwd: workspace,
    env: process.env,
    input: diagnosticEntry,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const bundleElapsedMs = performance.now() - bundleStartedAt;
  const codec = await import(`${pathToFileURL(codecBundlePath).href}?v=${Date.now()}`);

  const decodeStartedAt = performance.now();
  const decoded = await codec.decodeSegmentedRunStateGameplayBounded(
    rootChunk,
    readChunk,
    {
      hotEventLimit,
      observerAuthority: {
        stateHash: String(run.state_hash),
        revision: Number(run.revision),
        month: Number(run.elapsed_months),
        lastMaterializedMilestoneCount: Number(run.milestone_count),
      },
    },
  );
  const decodeElapsedMs = performance.now() - decodeStartedAt;
  const state = decoded.state;
  const modernEvidence = codec.observeModernCivilizationEvidence(state);
  const relevantLastStepFacts = state.lastStep.flatMap((event) => {
    if (event.kind !== 'action') return [];
    const relevant = event.diff.recordUseStage !== undefined
      || event.diff.electricalPowerOperation === true
      || event.diff.electricalPowerFault === true
      || event.diff.electricalPowerRepair === true
      || event.diff.calibrationEventId !== undefined
      || event.diff.measurementEventId !== undefined;
    if (!relevant) return [];
    return [{
      id: event.id,
      atMonth: event.atMonth,
      orderInMonth: event.orderInMonth,
      who: event.who,
      status: event.status,
      actionKind: event.action.kind,
      ...(event.action.kind === 'act' ? { operation: event.action.operation } : {}),
      ...(event.diff.recordUseStage !== undefined
        ? { recordUseStage: event.diff.recordUseStage }
        : {}),
      ...(event.diff.electricalPowerOperation === true
        ? { electricalPowerOperation: true }
        : {}),
      ...(event.diff.electricalPowerDelivered === true
        ? { electricalPowerDelivered: true }
        : {}),
      ...(event.diff.calibrationEventId !== undefined
        ? { calibrationEventId: event.diff.calibrationEventId }
        : {}),
      ...(event.diff.measurementEventId !== undefined
        ? { measurementEventId: event.diff.measurementEventId }
        : {}),
      ...(event.diff.outputMaterialId !== undefined
        ? { outputMaterialId: event.diff.outputMaterialId }
        : {}),
    }];
  });
  const livingPeople = state.people.filter(
    (person) => person.diedAtMonth === undefined && Number(person.body?.health ?? 0) > 0,
  ).length;
  const capabilityProjectFunctions = new Set([
    'water-powered-crop-processing',
    'restore-water-powered-crop-processing',
    'remote-work-power-delivery',
    'restore-electrical-power-delivery',
    'comparable-mass-measurement',
    'durable-record',
  ]);
  const capabilityProjects = state.projects.filter((project) => (
    capabilityProjectFunctions.has(project.desiredFunction)
  )).map((project) => ({
    id: project.id,
    ownerId: project.ownerId,
    desiredFunction: project.desiredFunction,
    status: project.status,
    proposedAt: project.proposedAt,
    createdAtMonth: project.createdAtMonth,
    lastProgressAtMonth: project.lastProgressAtMonth,
    blockedAtMonth: project.blockedAtMonth ?? null,
    blockedReason: project.blockedReason ?? null,
    missingMaterialIds: project.missingMaterialIds,
    materialDemands: project.materialDemands ?? [],
    actionEventCount: project.actionEventIds.length,
    completionEventCount: project.completionEventIds.length,
    ...(project.hypothesisCampaign ? {
      hypothesis: {
        status: project.hypothesisCampaign.status,
        attempts: project.hypothesisCampaign.attempts.length,
        endingReason: project.hypothesisCampaign.endingReason ?? null,
        questionCounts: countsBy(
          project.hypothesisCampaign.candidates,
          (candidate) => candidate.questionKind,
        ),
        recentAttempts: project.hypothesisCampaign.attempts.slice(-8).map((attempt) => ({
          candidateKey: attempt.candidateKey,
          questionKind: attempt.questionKind,
          outcome: attempt.outcome,
          outputMaterialId: attempt.outputMaterialId ?? null,
        })),
      },
    } : {}),
    ...(project.mechanicalPowerNetworkId ? { mechanicalPowerNetworkId: project.mechanicalPowerNetworkId } : {}),
    ...(project.electricalPowerPlanKey ? { electricalPowerPlanKey: project.electricalPowerPlanKey } : {}),
  }));

  console.log(JSON.stringify({
    ok: true,
    source: {
      dataDirectory,
      databaseFile,
      runId: String(run.id),
      stateHash: String(run.state_hash),
      revision: Number(run.revision),
      month: Number(run.elapsed_months),
      status: String(run.status),
      eventCount: Number(run.event_count),
      milestoneCount: Number(run.milestone_count),
      livingAgents: Number(run.living_agents),
      agentCount: Number(run.agent_count),
      rootSchemaVersion: decoded.metadata.schemaVersion,
      hotEventLimit,
    },
    sourceArrayLengths: decoded.gameplayShell.sourceArrayLengths,
    retainedArrayLengths: decoded.gameplayShell.retainedArrayLengths,
    stateCounts: {
      people: state.people.length,
      livingPeople,
      deadPeople: state.people.length - livingPeople,
      intents: state.intents.length,
      agreements: state.agreements.length,
      records: state.records.length,
      collectives: state.collectives.length,
      permissions: state.permissions.length,
      containers: state.containers.length,
      eraPredictions: state.eraPredictions.length,
      projects: state.projects.length,
      hotEvents: state.world.past.length,
      coldPinnedEvents: decoded.pinnedEvents.length,
      drops: arrayLength(state.world.drops),
      animals: arrayLength(state.world.animals),
      remains: arrayLength(state.world.remains),
      memorials: arrayLength(state.world.memorials),
      traffic: arrayLength(state.world.traffic),
      mechanicalPowerNetworks: arrayLength(state.world.mechanicalPower?.networks),
      electricalPowerNetworks: arrayLength(state.world.electricalPower?.networks),
    },
    capabilityProgress: {
      projectCountsByFunction: countsBy(capabilityProjects, (project) => project.desiredFunction),
      projectCountsByFunctionAndStatus: countsBy(
        capabilityProjects,
        (project) => `${project.desiredFunction}:${project.status}`,
      ),
      recordUseIntentStages: countsBy(
        state.intents.filter((intent) => intent.recordUseStage),
        (intent) => intent.recordUseStage,
      ),
      projects: capabilityProjects,
    },
    observerBasis: state.lastMaterializedObserverBasis,
    modernEvidence,
    relevantLastStepFacts,
    livingRememberedSourceStats: livingRememberedSourceStats(state),
    ...(referenceNeedleInput
      ? {
        referenceSearch: {
          needle: referenceNeedleInput,
          paths: referencePaths(state, referenceNeedleInput),
          owners: referenceOwners(state, referenceNeedleInput),
        },
      }
      : {}),
    chunkReads: {
      count: chunkReadCount,
      bytes: chunkReadBytes,
      uniqueCount: uniqueChunkHashes.size,
      uniqueBytes: uniqueChunkBytes,
    },
    timing: {
      bundleElapsedMs,
      decodeElapsedMs,
      wallElapsedMs: performance.now() - startedAt,
    },
    memory: {
      processBytes: byteMemoryUsage(),
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
    },
  }, null, 2));
} finally {
  database?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
