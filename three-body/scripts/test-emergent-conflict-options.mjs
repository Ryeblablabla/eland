import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-emergent-conflict-'));

try {
  const simulationPath = path.join(temporaryDirectory, 'simulation.mjs');
  const plannerPath = path.join(temporaryDirectory, 'rule-planner.mjs');
  const executorPath = path.join(temporaryDirectory, 'action-executor.mjs');
  const bundle = (entry, output) => execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });
  bundle('src/game/eland/simulation.ts', simulationPath);
  bundle('src/game/eland/application/rule-planner.ts', plannerPath);
  bundle('src/game/eland/domain/action-executor.ts', executorPath);
  const simulation = await import(`${pathToFileURL(simulationPath).href}?test=${Date.now()}`);
  const planner = await import(`${pathToFileURL(plannerPath).href}?test=${Date.now()}`);
  const executor = await import(`${pathToFileURL(executorPath).href}?test=${Date.now()}`);

  const state = simulation.createInitialState(44_102, {
    endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 12;
  const actor = state.people[0];
  const other = state.people[1];
  other.position = { ...actor.position };
  actor.body = { health: 95, hydration: 95, nutrition: 95 };
  const relation = actor.relations.find((candidate) => candidate.personId === other.id);
  assert(relation);
  relation.trust = 100;
  relation.bond = 100;
  relation.fear = 0;
  other.inventory.push({
    id: 'conflict-target-stack', materialId: simulation.Material.Wood, quantity: 1,
    sourceEventIds: [state.world.past[0].id],
  });

  const context = simulation.buildDecisionContexts(state, 12)
    .find((candidate) => candidate.person.id === actor.id);
  assert(context);
  const attack = context.options.find((option) => option.id === `exert-person:${other.id}:12`);
  const taking = context.options.find((option) => option.id === `take-without-permission:${other.id}:conflict-target-stack`);
  assert.equal(attack?.semantics.purpose, 'conflict',
    'physical conflict must be an available affordance without a fear/trust threshold');
  assert.equal(taking?.nextAction.kind, 'transfer',
    'unauthorized taking must remain physically expressible even when the actor is well fed');

  const conservativeFallback = planner.withoutModelOwnedVoluntarySocialOptions(context);
  assert.equal(conservativeFallback.options.some((option) => option.id === attack.id), false,
    'model infrastructure fallback must not invent a voluntary attack');
  assert.equal(conservativeFallback.options.some((option) => option.id === taking.id), false,
    'model infrastructure fallback must not invent voluntary theft');

  actor.baselineCapacities.manipulation = 100;
  actor.baselineCapacities.locomotion = 100;
  other.baselineCapacities.perception = 1;
  other.baselineCapacities.manipulation = 1;
  const theft = executor.executePrimitiveAction(state, actor, taking.nextAction, 12, 99, {
    cause: 'intent', actionTick: 1,
  });
  assert.equal(theft.status, 'completed',
    'a healthy owner may contest an unauthorized taking, but must not make theft physically impossible by hard gate');
  assert.equal(theft.diff.unauthorizedTaking, true);
  assert.ok(theft.diff.takingContest,
    'contested theft should retain the embodied actor/owner contest rather than a hidden moral permission score');

  process.stdout.write('emergent conflict option tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
