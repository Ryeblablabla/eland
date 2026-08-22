#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { deserialize } from 'node:v8';
import { brotliDecompressSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log(`Audit authoritative ELAND run generations.

Usage:
  node scripts/audit-run-generations.mjs --prefix RUN_PREFIX [--database PATH]
  node scripts/audit-run-generations.mjs --run-id RUN_ID[,RUN_ID...] [--database PATH]
`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === '--prefix') parsed.prefix = value;
    else if (argument === '--run-id') parsed.runIds = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (argument === '--database') parsed.database = value;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (Boolean(parsed.prefix) === Boolean(parsed.runIds?.length)) {
    throw new Error('Provide exactly one of --prefix or --run-id');
  }
  return parsed;
}

function countByGeneration(people, predicate = () => true) {
  const counts = new Map();
  for (const person of people.filter(predicate)) {
    const generation = Number.isInteger(person.generation) ? person.generation : 0;
    counts.set(generation, (counts.get(generation) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left - right));
}

function livingAtEnd(person) {
  return typeof person.diedAtMonth !== 'number';
}

function summarizeRun(database, row, readChunk) {
  const rootChunk = readChunk.get(row.state_hash);
  if (!rootChunk || rootChunk.codec !== 'eland-run-state-root-v1') {
    throw new Error(`Run ${row.id} has no supported state root`);
  }
  const root = deserialize(Buffer.from(rootChunk.data));
  const shellChunk = readChunk.get(root.shellHash);
  if (!shellChunk || shellChunk.codec !== 'eland-run-state-shell-v1') {
    throw new Error(`Run ${row.id} has no supported state shell`);
  }
  const shell = deserialize(brotliDecompressSync(Buffer.from(shellChunk.data)));
  const people = Array.isArray(shell.people) ? shell.people : [];
  const maxGeneration = people.reduce((maximum, person) => Math.max(
    maximum,
    Number.isInteger(person.generation) ? person.generation : 0,
  ), 0);
  const generationThreeOrLater = people
    .filter((person) => Number.isInteger(person.generation) && person.generation >= 3)
    .sort((left, right) => left.bornAtMonth - right.bornAtMonth || left.id.localeCompare(right.id))
    .map((person) => ({
      id: person.id,
      name: person.name,
      generation: person.generation,
      bornAtMonth: person.bornAtMonth,
      diedAtMonth: person.diedAtMonth ?? null,
      geneticParents: [...(person.geneticParents ?? [])],
    }));
  const earliestBirthByGeneration = {};
  for (const person of people) {
    if (!Number.isInteger(person.generation) || person.generation <= 0) continue;
    const key = String(person.generation);
    const current = earliestBirthByGeneration[key];
    if (!current || person.bornAtMonth < current.atMonth) {
      earliestBirthByGeneration[key] = {
        atMonth: person.bornAtMonth,
        personId: person.id,
        name: person.name,
        geneticParents: [...(person.geneticParents ?? [])],
      };
    }
  }
  return {
    runId: row.id,
    elapsedMonths: row.elapsed_months,
    status: row.status,
    people: people.length,
    living: people.filter(livingAtEnd).length,
    maxGeneration,
    peopleByGeneration: countByGeneration(people),
    livingByGeneration: countByGeneration(people, livingAtEnd),
    earliestBirthByGeneration,
    generationThreeOrLater,
  };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
if (args.help) {
  usage();
  process.exit(0);
}

const databaseFile = path.resolve(args.database ?? path.join(process.cwd(), 'data', 'eland.sqlite3'));
const database = new DatabaseSync(databaseFile, { readOnly: true });
const readChunk = database.prepare('SELECT codec, data FROM chunks WHERE hash = ?');
const rows = args.prefix
  ? database.prepare(`
      SELECT id, state_hash, elapsed_months, status
      FROM runs
      WHERE id LIKE ?
      ORDER BY id
    `).all(`${args.prefix}%`)
  : args.runIds.flatMap((runId) => database.prepare(`
      SELECT id, state_hash, elapsed_months, status
      FROM runs
      WHERE id = ?
    `).all(runId));

const runs = rows.map((row) => summarizeRun(database, row, readChunk));
const generationThreeRuns = runs.filter((run) => run.maxGeneration >= 3).map((run) => run.runId);
console.log(JSON.stringify({
  databaseFile,
  runCount: runs.length,
  generationThreeRunCount: generationThreeRuns.length,
  generationThreeRuns,
  runs,
}, null, 2));

database.close();
