#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { openSqliteRunReader, PROJECT_DIRECTORY } from './sqlite-run-reader.mjs';

function usage() {
  process.stderr.write(`Audit terminal descendant reproduction options and their causal-BDI appraisal.

Usage:
  node scripts/audit-reproduction-frontier.mjs --prefix RUN_PREFIX [--out OUTPUT.json]
  node scripts/audit-reproduction-frontier.mjs --run-id RUN_ID[,RUN_ID...] [--out OUTPUT.json]
`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    const value = argv[index + 1];
    if (!argument.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    index += 1;
    if (argument === '--prefix') parsed.prefix = value;
    else if (argument === '--run-id') parsed.runIds = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (argument === '--out') parsed.outputPath = path.resolve(value);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (Boolean(parsed.prefix) === Boolean(parsed.runIds?.length)) {
    throw new Error('Provide exactly one of --prefix or --run-id');
  }
  return parsed;
}

async function openAuditModule() {
  const directory = await mkdtemp(path.join(tmpdir(), 'eland-reproduction-frontier-'));
  const bundlePath = path.join(directory, 'frontier.mjs');
  try {
    await build({
      stdin: {
        contents: `
          export { buildDecisionContextForPerson } from './src/game/eland/application/simulation/tick-planner.ts';
          export { rankCognitiveOptions } from './src/game/eland/application/cognition/bdi-deliberation.ts';
          export { deriveNeedAgenda } from './src/game/eland/application/cognition/need-agenda.ts';
          export { lifePlanningStage } from './src/game/eland/domain/life-stage.ts';
          export { isAlive } from './src/game/eland/domain/person.ts';
        `,
        resolveDir: PROJECT_DIRECTORY,
        sourcefile: 'audit-reproduction-frontier-entry.ts',
        loader: 'ts',
      },
      outfile: bundlePath,
      absWorkingDir: PROJECT_DIRECTORY,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      logLevel: 'silent',
    });
    const module = await import(`${pathToFileURL(bundlePath).href}?audit=${Date.now()}`);
    return { module, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function optionProjection(appraisal) {
  return {
    optionId: appraisal.option.id,
    targetPersonId: appraisal.option.target?.kind === 'person'
      ? appraisal.option.target.personId
      : null,
    motivation: appraisal.motivation,
    aspiration: appraisal.aspiration,
    crossesThreshold: appraisal.motivation >= appraisal.aspiration,
    generativityUrgency: appraisal.generativityUrgency,
    needActivation: appraisal.needActivation,
    relationshipGate: appraisal.relationshipGate,
    readinessGate: appraisal.readinessGate,
    repetitionGate: appraisal.repetitionGate,
    familyReadiness: appraisal.familyReadiness ? {
      readiness: appraisal.familyReadiness.readiness,
      food: appraisal.familyReadiness.food,
      water: appraisal.familyReadiness.water,
      shelter: appraisal.familyReadiness.shelter,
      careCapacity: appraisal.familyReadiness.careCapacity,
      climateSafety: appraisal.familyReadiness.climateSafety,
      sourceFactCount: appraisal.familyReadiness.sourceFactIds.length,
    } : null,
    reasons: appraisal.reasons,
    sourceFactCount: appraisal.sourceFactIds.length,
    sourceFactIds: appraisal.sourceFactIds.slice(-24),
  };
}

function countBy(items, keyOf) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    throw error;
  }
  if (args.help) {
    usage();
    return;
  }
  const [reader, audit] = await Promise.all([openSqliteRunReader(), openAuditModule()]);
  try {
    const metadata = await reader.store.list();
    const runIds = args.prefix
      ? metadata.filter((meta) => meta.id.startsWith(args.prefix)).map((meta) => meta.id).sort()
      : args.runIds;
    const runs = [];
    for (const runId of runIds) {
      const persisted = await reader.store.load(runId);
      const { state } = persisted;
      const atMonth = state.clock.elapsedMonths + 1;
      const descendants = [];
      for (const person of state.people.filter((candidate) => candidate.generation > 0 && audit.module.isAlive(candidate))) {
        const stage = audit.module.lifePlanningStage(person, atMonth);
        if (stage !== 'adult') continue;
        const context = audit.module.buildDecisionContextForPerson(state, person, atMonth);
        const ranked = audit.module.rankCognitiveOptions(context, context.options, { atMonth, planningTick: 1 });
        const reproduction = ranked.filter((appraisal) => /^(offer-reproduce|accept-reproduce|reject-reproduce|reproduce|withdraw-reproduce):/.test(appraisal.option.id));
        const agenda = audit.module.deriveNeedAgenda(context, atMonth);
        const ownedIntents = state.intents.filter((intent) => intent.ownerId === person.id);
        const partyAgreements = state.agreements.filter((agreement) => agreement.partyIds.includes(person.id));
        const activeCompanions = partyAgreements.filter((agreement) => agreement.status === 'active'
          && agreement.proposal.kind === 'companion');
        descendants.push({
          personId: person.id,
          name: person.name,
          generation: person.generation,
          sex: person.sex,
          ageMonths: atMonth - person.bornAtMonth,
          bodyMinimum: Math.min(person.body.health, person.body.hydration, person.body.nutrition),
          position: person.position,
          optionCount: context.options.length,
          needAgenda: agenda.map((need) => ({ kind: need.kind, urgency: need.urgency })),
          selectedIntentCount: ownedIntents.length,
          selectedIntentDomains: countBy(ownedIntents, (intent) => `${intent.domain}:${intent.status}`),
          selectedReproductionIntents: ownedIntents.filter((intent) => /reproduc|下一代|生育/.test(JSON.stringify(intent))).length,
          selectedCompanionIntents: ownedIntents.filter((intent) => /companion|结伴|共同生活/.test(JSON.stringify(intent))).length,
          selectedCompanyAssistIntents: ownedIntents.filter((intent) => /request-assist:.*:company|陪伴自己一段时间/.test(JSON.stringify(intent))).length,
          agreementCount: partyAgreements.length,
          agreementOutcomes: countBy(partyAgreements, (agreement) => `${agreement.proposal.kind}:${agreement.status}`),
          activeCompanionCount: activeCompanions.length,
          establishedCompanionCount: activeCompanions.filter((agreement) => agreement.companionEstablishedAtMonth !== undefined).length,
          reproductionOptions: reproduction.map(optionProjection),
          topOptions: ranked.slice(0, 5).map((appraisal) => ({
            optionId: appraisal.option.id,
            motivation: appraisal.motivation,
            aspiration: appraisal.aspiration,
          })),
          activeIntent: context.activeIntent ? {
            id: context.activeIntent.id,
            summary: context.activeIntent.summary,
            status: context.activeIntent.status,
            projectId: context.activeIntent.projectId ?? null,
          } : null,
        });
      }
      runs.push({
        runId,
        seed: state.seed,
        elapsedMonths: state.clock.elapsedMonths,
        maxGeneration: state.people.reduce((maximum, person) => Math.max(maximum, person.generation ?? 0), 0),
        descendants,
      });
    }
    const output = `${JSON.stringify({ schemaVersion: 2, runs }, null, 2)}\n`;
    if (args.outputPath) await writeFile(args.outputPath, output, 'utf8');
    else process.stdout.write(output);
  } finally {
    await Promise.all([reader.close(), audit.close()]);
  }
}

await main();
