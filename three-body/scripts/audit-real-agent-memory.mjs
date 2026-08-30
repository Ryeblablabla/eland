import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maximumMonths = Math.max(1, Math.min(60, Number.parseInt(process.argv[2] ?? '8', 10) || 8));
const seed = Math.max(1, Number.parseInt(process.argv[3] ?? '20260830', 10) || 20260830);
const speechTarget = Math.max(0, Math.min(100, Number.parseInt(process.env.AUDIT_SPEECH_TARGET ?? '0', 10) || 0));
const outputPath = path.resolve(
  projectRoot,
  process.argv[4] ?? `data/experiments/real-agent-memory-audit-s${seed}-m${maximumMonths}.json`,
);
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-real-agent-memory-'));
const bundlePath = path.join(temporaryDirectory, 'eland-session.mjs');

function skyAt(month) {
  return {
    fromTime: Math.max(0, month - 1),
    toTime: month,
    fluxMean: 1,
    fluxMin: 1,
    fluxMax: 1,
    nearestStarDistance: 1,
    fate: 'stable',
  };
}

function namedSpeech(frame) {
  const names = new Map(frame.society.agents.map((agent) => [agent.id, agent.name]));
  return (frame.speechLines ?? []).map((line) => ({
    month: frame.elapsedMonths,
    id: line.id,
    sourceEventId: line.sourceEventId,
    sourceFactIds: line.sourceFactIds,
    speakerId: line.speakerId,
    speaker: names.get(line.speakerId) ?? line.speakerId,
    listenerIds: line.audienceIds,
    listeners: line.audienceNames ?? line.audienceIds.map((id) => names.get(id) ?? id),
    replyToSpeechLineId: line.replyToSpeechLineId,
    text: line.text,
    speechAct: line.speechAct,
    source: line.source,
    endpointId: line.endpointId,
    model: line.model,
  }));
}

try {
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    path.join(projectRoot, 'server/elandSession.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'ignore' });

  const { ElandSession } = await import(`${pathToFileURL(bundlePath).href}?audit=${Date.now()}`);
  const runId = `real-agent-memory-audit-s${seed}-m${maximumMonths}`;
  const session = new ElandSession(runId, skyAt(0));
  const initial = session.begin(1, seed, skyAt(0));
  const speech = [];
  const monthSummaries = [];
  let elapsedMonths = 0;

  for (let month = 1; month <= maximumMonths; month += 1) {
    process.stderr.write(`真实模型审阅：推进第 ${month}/${maximumMonths} 月\n`);
    const frame = await session.step({ skySample: skyAt(month) });
    if (!frame) throw new Error(`第 ${month} 月没有生成权威帧`);
    elapsedMonths = frame.elapsedMonths;
    const lines = namedSpeech(frame);
    speech.push(...lines);
    monthSummaries.push({
      month,
      entries: frame.entries.map((entry) => entry.text),
      speechLineIds: lines.map((line) => line.id),
    });
    if (speechTarget > 0 && speech.length >= speechTarget) break;
  }

  const snapshot = session.recoverySnapshot();
  if (!snapshot) throw new Error('审阅结束后没有可读取的权威状态');
  const state = snapshot.latestState;
  const living = state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0);
  const memories = living.map((person) => ({
    personId: person.id,
    personName: person.name,
    memory: session.agentMemory(person.id, elapsedMonths, 24),
    agenda: person.characterAgenda?.items ?? [],
  }));
  const characters = living.map((person) => ({
    personId: person.id,
    personName: person.name,
    description: person.profile.description,
    personality: person.personality,
    relations: person.relations,
  }));
  const factsById = new Map(state.world.past.map((event) => [event.id, event]));
  const enrichedSpeech = speech.map((line) => ({
    ...line,
    evidence: line.sourceFactIds.map((sourceFactId) => {
      const event = factsById.get(sourceFactId);
      return event ? {
        id: event.id,
        month: event.atMonth,
        kind: event.kind,
        result: typeof event.result === 'string' ? event.result : undefined,
      } : { id: sourceFactId, missing: true };
    }),
  }));
  const ledgers = state.decisionBudget.ledgers.filter((ledger) => ledger.atMonth >= 1 && ledger.atMonth <= elapsedMonths);
  const totals = ledgers.reduce((sum, ledger) => ({
    modelContexts: sum.modelContexts + ledger.modelContexts,
    providerRequests: sum.providerRequests + (ledger.providerRequests ?? 0),
    inputTokens: sum.inputTokens + ledger.inputTokens,
    outputTokens: sum.outputTokens + ledger.outputTokens,
    chargedTokens: sum.chargedTokens + ledger.chargedTokens,
  }), { modelContexts: 0, providerRequests: 0, inputTokens: 0, outputTokens: 0, chargedTokens: 0 });
  const report = {
    kind: 'real-agent-memory-audit-v1',
    runId,
    seed,
    months: elapsedMonths,
    maximumMonths,
    speechTarget,
    generatedAt: new Date().toISOString(),
    totals,
    ledgers,
    speech: enrichedSpeech,
    conversationEpisodes: state.memoryStore?.conversations ?? [],
    memories,
    characters,
    monthSummaries,
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, ...totals, speechLines: speech.length, livingAgents: living.length })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
