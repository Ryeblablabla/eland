import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-character-agenda-'));
const bundlePath = path.join(temporaryDirectory, 'character-agenda.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/character-agenda.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });

  const agenda = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const proposal = (suffix, disposition = 'bounded-experiment', sourceFactIds = [`pressure-${suffix}`]) => ({
    basisKey: `lasting-aim-${suffix}`,
    aim: `长期解决关切 ${suffix}`,
    theme: 'survival-and-discovery',
    importance: 76,
    horizonMonths: 48,
    sourceFactIds,
    approach: {
      basisKey: `approach-${suffix}`,
      summary: `尝试办法 ${suffix}`,
      disposition,
      sourceFactIds,
      probe: {
        kind: 'combine',
        ownStackIds: [`stack-${suffix}-a`, `stack-${suffix}-b`],
      },
    },
  });

  const empty = agenda.createCharacterAgendaState();
  const created = agenda.upsertCharacterAgenda(empty, proposal('a'), 3, 'model-proposal');
  assert.equal(created.accepted, true);
  assert.equal(created.outcome, 'created');
  assert.equal(empty.items.length, 0, 'upsert must not mutate its input');
  assert.equal(created.item.status, 'active');
  assert.equal(created.item.approaches.length, 1);
  assert.deepEqual(created.approach.probe.ownStackIds, ['stack-a-a', 'stack-a-b']);

  const paused = agenda.transitionCharacterAgenda(
    created.state,
    created.item.basisKey,
    'pause',
    4,
    ['decision-pause-a'],
  );
  assert.equal(paused.accepted, true);
  assert.equal(paused.outcome, 'paused');
  assert.equal(paused.item.status, 'suspended');
  assert.equal(created.item.status, 'active', 'a subjective transition must not mutate its input state');
  const abandoned = agenda.transitionCharacterAgenda(
    paused.state,
    paused.item.basisKey,
    'abandon',
    5,
    ['decision-abandon-a'],
  );
  assert.equal(abandoned.outcome, 'abandoned');
  assert.equal(abandoned.item.status, 'abandoned');
  assert.equal(agenda.transitionCharacterAgenda(
    abandoned.state,
    abandoned.item.basisKey,
    'pause',
    6,
    ['decision-late-pause-a'],
  ).outcome, 'transition-noop', 'an abandoned concern cannot be silently revived by pausing it');

  const duplicate = agenda.upsertCharacterAgenda(created.state, proposal('a'), 30, 'model-proposal');
  assert.equal(duplicate.outcome, 'duplicate-without-new-evidence');
  assert.equal(duplicate.item.lastReviewedAtMonth, created.item.lastReviewedAtMonth,
    'a rejected duplicate must not refresh the agenda review clock');
  assert.equal(duplicate.item.targetAtMonth, created.item.targetAtMonth,
    'a rejected duplicate must not keep an agenda alive merely by rephrasing time');

  const ungrounded = agenda.upsertCharacterAgenda(empty, {
    ...proposal('ungrounded'),
    sourceFactIds: [],
    approach: { ...proposal('ungrounded').approach, sourceFactIds: [] },
  }, 3, 'model-proposal');
  assert.equal(ungrounded.outcome, 'ungrounded-proposal');

  const incubating = agenda.upsertCharacterAgenda(
    created.state,
    proposal('incubating', 'missing-affordance'),
    4,
    'local-deliberation',
  );
  assert.equal(incubating.item.status, 'incubating');

  const bound = agenda.bindCharacterAgendaIntent(
    created.state,
    created.item.id,
    created.approach.id,
    'intent-a-1',
    'project-a',
  );
  assert.equal(bound.accepted, true);
  assert.deepEqual(bound.item.intentIds, ['intent-a-1']);
  assert.deepEqual(bound.item.projectIds, ['project-a']);
  assert.deepEqual(bound.approach.attemptIntentIds, ['intent-a-1']);
  assert.equal(bound.item.activeIntentId, 'intent-a-1');

  const firstResult = agenda.reconcileCharacterAgendaApproach(
    bound.state,
    bound.item.id,
    bound.approach.id,
    'blocked',
    ['action-result-a-1'],
    5,
  );
  assert.equal(firstResult.accepted, true);
  assert.equal(firstResult.item.aim, proposal('a').aim, 'the durable aim survives a failed means');
  assert.equal(firstResult.item.activeIntentId, undefined);
  assert.equal(firstResult.approach.latestOutcome, 'blocked');
  assert.equal(firstResult.approach.disposition, 'waiting-for-evidence');
  assert.equal(agenda.canReconsiderCharacterAgendaApproach(firstResult.approach), false);

  const blindRetry = agenda.reconcileCharacterAgendaApproach(
    firstResult.state,
    firstResult.item.id,
    firstResult.approach.id,
    'blocked',
    ['action-result-a-2'],
    12,
  );
  assert.equal(blindRetry.outcome, 'blind-retry-suppressed', 'time and a repeated result cannot unlock a retry');
  assert.equal(blindRetry.approach.evaluations.length, 1);

  const revised = agenda.upsertCharacterAgenda(
    firstResult.state,
    proposal('a', 'observation-needed', ['pressure-a', 'new-local-observation']),
    13,
    'model-proposal',
  );
  assert.equal(revised.outcome, 'updated');
  assert.equal(agenda.canReconsiderCharacterAgendaApproach(revised.approach), true);
  const supported = agenda.reconcileCharacterAgendaApproach(
    revised.state,
    revised.item.id,
    revised.approach.id,
    'supported',
    ['action-result-a-3'],
    14,
  );
  assert.equal(supported.accepted, true);
  assert.equal(supported.approach.evaluations.length, 2);
  assert.equal(supported.item.status, 'active');
  assert.equal(supported.approach.disposition, 'executable-now');

  const replayed = agenda.hydrateCharacterAgendaState(JSON.parse(JSON.stringify(supported.state)), 14);
  assert.deepEqual(replayed, supported.state, 'schema-v17 JSON hydration must be stable');
  assert.deepEqual(agenda.hydrateCharacterAgendaState(undefined), empty, 'legacy saves start with no invented agenda');

  let bounded = agenda.createCharacterAgendaState();
  for (let index = 0; index < agenda.MAX_CHARACTER_AGENDA_ITEMS; index += 1) {
    const result = agenda.upsertCharacterAgenda(bounded, proposal(`cap-${index}`), index, 'local-deliberation');
    assert.equal(result.accepted, true);
    bounded = result.state;
  }
  const overCapacity = agenda.upsertCharacterAgenda(bounded, proposal('cap-overflow'), 20, 'local-deliberation');
  assert.equal(overCapacity.outcome, 'capacity-full');
  assert.equal(overCapacity.state.items.length, agenda.MAX_CHARACTER_AGENDA_ITEMS);
  const withSuspended = structuredClone(bounded);
  withSuspended.items[0].status = 'suspended';
  const replacesSuspended = agenda.upsertCharacterAgenda(withSuspended, proposal('cap-replacement'), 21, 'model-proposal');
  assert.equal(replacesSuspended.accepted, true);
  assert.equal(replacesSuspended.evictedItemId, withSuspended.items[0].id,
    'an expired parked concern must free capacity for a genuinely new concern');

  process.stdout.write('character agenda domain tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
