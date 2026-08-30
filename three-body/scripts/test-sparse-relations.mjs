import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-sparse-relations-test-'));
const bundlePath = path.join(temporaryDirectory, 'sparse-relations.mjs');

try {
  const entry = `
    export { createInitialState, buildDecisionContexts } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { advanceBodies } from ${JSON.stringify(path.resolve('src/game/eland/domain/monthly-processes.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { applyRelationEvidence, compactCanonicalRelations, invalidateRelationIndex, relationTo } from ${JSON.stringify(path.resolve('src/game/eland/domain/relation.ts'))};
    export { buildRelationshipCausalBasis, hasCultivatedCompanionRelationship, hasSourcedReproductiveRelationship } from ${JSON.stringify(path.resolve('src/game/eland/domain/relationship-evidence.ts'))};
    export { buildDecisionRequestContext } from ${JSON.stringify(path.resolve('src/game/eland/application/model-decision/index.ts'))};
    export { toSocietyState } from ${JSON.stringify(path.resolve('src/game/eland/adapter.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=sparse-relations-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    advanceBodies,
    applyRelationEvidence,
    buildDecisionContexts,
    buildDecisionRequestContext,
    buildRelationshipCausalBasis,
    compactCanonicalRelations,
    createInitialState,
    executePrimitiveAction,
    hasCultivatedCompanionRelationship,
    hasSourcedReproductiveRelationship,
    invalidateRelationIndex,
    relationTo,
    toSocietyState,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const emptyRelation = (personId) => ({
    personId, trust: 0, bond: 0, fear: 0, sourceEventIds: [],
  });
  const relationSnapshot = (person, otherId) => {
    const relation = relationTo(person, otherId);
    return relation
      ? { trust: relation.trust, bond: relation.bond, fear: relation.fear, sourceEventIds: [...relation.sourceEventIds] }
      : { trust: 0, bond: 0, fear: 0, sourceEventIds: [] };
  };
  const createPair = (seed, dense) => {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    const actor = state.people[0];
    const other = state.people[1];
    assert.ok(actor && other, 'fixture requires two founders');
    state.people = [actor, other];
    actor.sex = 'female';
    other.sex = 'male';
    for (const person of state.people) {
      person.bornAtMonth = -24 * 12;
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.conditions = [];
      person.position = structuredClone(actor.position);
      delete person.activeIntentId;
    }
    actor.relations = dense ? [emptyRelation(other.id)] : [];
    other.relations = dense ? [emptyRelation(actor.id)] : [];
    return { state, actor, other };
  };

  // The runtime index follows authoritative append-only writes and replacement
  // arrays without becoming part of serialized state.
  {
    const indexedPerson = {
      id: 'indexed-person',
      geneticParents: ['parent'],
      relations: [emptyRelation('removed'), emptyRelation('parent')],
    };
    assert.equal(relationTo(indexedPerson, 'removed')?.personId, 'removed');
    applyRelationEvidence(indexedPerson, 'appended', 'e-appended', { trust: 4, bond: 2 });
    assert.deepEqual(relationSnapshot(indexedPerson, 'appended'), {
      trust: 4, bond: 2, fear: 0, sourceEventIds: ['e-appended'],
    }, 'append after a cached lookup must become visible immediately');
    indexedPerson.relations.splice(0, 1);
    invalidateRelationIndex(indexedPerson);
    assert.equal(relationTo(indexedPerson, 'removed'), undefined, 'splice truncation must invalidate stale index entries');
    assert.equal(relationTo(indexedPerson, 'appended')?.trust, 4, 'splice must preserve the surviving indexed suffix');
    applyRelationEvidence(indexedPerson, 'stable-tail', 'e-stable-tail', {});
    indexedPerson.relations.splice(1, 1, { personId: 'splice-replacement', trust: 1, bond: 0, fear: 0, sourceEventIds: [] });
    invalidateRelationIndex(indexedPerson);
    assert.equal(relationTo(indexedPerson, 'appended'), undefined, 'same-length splice must not retain the replaced cached object');
    assert.equal(relationTo(indexedPerson, 'splice-replacement')?.trust, 1, 'same-length splice replacement must be indexed after invalidation');

    indexedPerson.relations.push(
      emptyRelation('discard-default'),
      emptyRelation('child'),
      { personId: 'sourced-zero', trust: 0, bond: 0, fear: 0, sourceEventIds: ['e-seen'] },
      { personId: 'nonzero', trust: 0, bond: 8, fear: 0, sourceEventIds: [] },
      { ...emptyRelation('unknown-extension'), legacyAuditTag: 'preserve-me' },
    );
    const beforeCompaction = structuredClone(indexedPerson.relations);
    const compacted = compactCanonicalRelations(indexedPerson, ['child']);
    assert.deepEqual(indexedPerson.relations, beforeCompaction, 'canonical compaction must be pure');
    assert.equal(compacted.some((relation) => relation.personId === 'discard-default'), false);
    assert.ok(compacted.some((relation) => relation.personId === 'parent'), 'zero-valued kin must remain canonical');
    assert.ok(compacted.some((relation) => relation.personId === 'child'), 'parent-to-child kin supplied by the caller must remain canonical');
    assert.ok(compacted.some((relation) => relation.personId === 'sourced-zero'), 'sourced audit edges must remain canonical');
    assert.ok(compacted.some((relation) => relation.personId === 'nonzero'), 'nonzero edges must remain canonical');
    assert.equal(compacted.find((relation) => relation.personId === 'unknown-extension')?.legacyAuditTag, 'preserve-me', 'unknown enumerable schema extensions must fail closed and survive compaction');
    indexedPerson.relations = compacted;
    assert.equal(relationTo(indexedPerson, 'discard-default'), undefined, 'replacement by compacted array must not return stale entries');
    assert.equal(relationTo(indexedPerson, 'nonzero')?.bond, 8);

    const priorLength = indexedPerson.relations.length;
    applyRelationEvidence(indexedPerson, 'no-evidence', '', {});
    assert.equal(indexedPerson.relations.length, priorLength, 'all-zero evidence without a source must not materialize an edge');
    const nonzeroBeforeUnsourcedWrite = structuredClone(relationTo(indexedPerson, 'nonzero'));
    assert.throws(
      () => applyRelationEvidence(indexedPerson, 'nonzero', '', { trust: 9, bond: -3, fear: 4 }),
      /non-empty event id/,
      'an unsourced nonzero delta must fail closed before mutating an existing edge',
    );
    assert.throws(
      () => applyRelationEvidence(indexedPerson, 'unsourced-first-write', '', { trust: 9 }),
      /non-empty event id/,
      'an unsourced nonzero delta must fail closed before creating a missing edge',
    );
    assert.deepEqual(relationTo(indexedPerson, 'nonzero'), nonzeroBeforeUnsourcedWrite);
    assert.equal(relationTo(indexedPerson, 'unsourced-first-write'), undefined);
    applyRelationEvidence(indexedPerson, 'first-evidence', 'e-first', { fear: 5 });
    assert.deepEqual(relationSnapshot(indexedPerson, 'first-evidence'), {
      trust: 0, bond: 0, fear: 5, sourceEventIds: ['e-first'],
    }, 'the first witnessed update must create and update a missing edge');

    const duplicatePerson = {
      geneticParents: [],
      relations: [
        { personId: 'duplicate', trust: 2, bond: 0, fear: 0, sourceEventIds: [] },
        { personId: 'duplicate', trust: 9, bond: 0, fear: 0, sourceEventIds: [] },
      ],
    };
    assert.equal(relationTo(duplicatePerson, 'duplicate')?.trust, 2, 'duplicate ids preserve Array.find first-wins semantics');
    duplicatePerson.relations.reverse();
    invalidateRelationIndex(duplicatePerson);
    assert.equal(relationTo(duplicatePerson, 'duplicate')?.trust, 9, 'duplicate reorder plus explicit invalidation must refresh first-wins semantics');

    const staleWritePerson = {
      geneticParents: [],
      relations: [emptyRelation('old-id'), emptyRelation('stable-id')],
    };
    assert.equal(relationTo(staleWritePerson, 'old-id')?.personId, 'old-id');
    staleWritePerson.relations[0] = emptyRelation('rewritten-id');
    applyRelationEvidence(staleWritePerson, 'rewritten-id', 'e-rewritten', { bond: 3 });
    assert.equal(staleWritePerson.relations.filter((relation) => relation.personId === 'rewritten-id').length, 1, 'defensive write fallback must not append a duplicate after an unannounced rewrite');
    assert.equal(relationTo(staleWritePerson, 'rewritten-id')?.bond, 3);
  }

  // A no-source legacy zero edge and an absent sparse edge expose identical
  // relationship values, reproduction gates, social choices, and model input.
  {
    const dense = createPair(20260825, true);
    const sparse = createPair(20260825, false);
    const denseContext = buildDecisionContexts(dense.state).find((context) => context.person.id === dense.actor.id);
    const sparseContext = buildDecisionContexts(sparse.state).find((context) => context.person.id === sparse.actor.id);
    assert.ok(denseContext && sparseContext);
    const denseRequest = buildDecisionRequestContext(denseContext);
    const sparseRequest = buildDecisionRequestContext(sparseContext);
    assert.deepEqual(
      denseRequest.visiblePeople.map(({ id, trust, bond, fear }) => ({ id, trust, bond, fear })),
      sparseRequest.visiblePeople.map(({ id, trust, bond, fear }) => ({ id, trust, bond, fear })),
      'missing and legacy zero relations must expose identical trust/bond/fear values',
    );
    assert.deepEqual(denseRequest, sparseRequest, 'missing relations must preserve the complete authoritative decision input');
    assert.deepEqual(denseRequest.options, sparseRequest.options, 'missing relations must not alter social choices or appraisal inputs');
    const projectedRelationshipFrame = ({ state, actor }) => {
      const projected = toSocietyState(state).agents.find((agent) => agent.id === actor.id);
      return {
        respect: projected?.respect,
        belonging: projected?.needs.find((need) => need.level === 'belonging')?.intensity,
        relations: projected?.relations,
      };
    };
    assert.deepEqual(projectedRelationshipFrame(dense), projectedRelationshipFrame(sparse), 'UI belonging, respect, and relation lists must ignore legacy zero edges');
    assert.deepEqual(projectedRelationshipFrame(sparse).relations, [], 'a missing or zero-only edge must not appear in the UI relationship list');
    const denseBasis = buildRelationshipCausalBasis(dense.state, dense.actor, dense.other, 'reproduce');
    const sparseBasis = buildRelationshipCausalBasis(sparse.state, sparse.actor, sparse.other, 'reproduce');
    assert.deepEqual(denseBasis, sparseBasis);
    assert.equal(hasSourcedReproductiveRelationship(dense.state, dense.actor, dense.other, denseBasis), false);
    assert.equal(hasSourcedReproductiveRelationship(sparse.state, sparse.actor, sparse.other, sparseBasis), false);
    assert.equal(hasCultivatedCompanionRelationship(dense.state, dense.actor, dense.other), false);
    assert.equal(hasCultivatedCompanionRelationship(sparse.state, sparse.actor, sparse.other), false);
  }

  const compareFirstInteraction = (seed, prepare, actionFor, observerFor, expectedFor) => {
    const dense = createPair(seed, true);
    const sparse = createPair(seed, false);
    prepare(dense);
    prepare(sparse);
    const denseFact = executePrimitiveAction(
      dense.state, dense.actor, actionFor(dense), 1, 0, { cause: 'intent', actionTick: 1 },
    );
    const sparseFact = executePrimitiveAction(
      sparse.state, sparse.actor, actionFor(sparse), 1, 0, { cause: 'intent', actionTick: 1 },
    );
    assert.deepEqual(sparseFact, denseFact, 'first sparse interaction must preserve the dense legacy action result');
    const denseObserver = observerFor(dense);
    const sparseObserver = observerFor(sparse);
    assert.deepEqual(
      relationSnapshot(sparseObserver, sparseObserver.id === sparse.actor.id ? sparse.other.id : sparse.actor.id),
      relationSnapshot(denseObserver, denseObserver.id === dense.actor.id ? dense.other.id : dense.actor.id),
    );
    assert.deepEqual(
      relationSnapshot(sparseObserver, sparseObserver.id === sparse.actor.id ? sparse.other.id : sparse.actor.id),
      expectedFor(sparse),
      'first sparse interaction must materialize the same sourced relation update',
    );
  };

  // The three former guarded writers must all create their first real edge.
  compareFirstInteraction(
    20260826,
    ({ other }) => {
      other.inventory = [{ id: 'owned-food', materialId: Material.Food, quantity: 1, sourceEventIds: ['e-owned-food'] }];
    },
    ({ actor, other }) => ({
      kind: 'transfer', materialId: Material.Food, quantity: 1,
      from: { kind: 'person', personId: other.id },
      to: { kind: 'person', personId: actor.id },
      stackId: 'owned-food',
    }),
    ({ other }) => other,
    ({ actor }) => ({ trust: 0, bond: 0, fear: 3, sourceEventIds: [`e-1-action-${actor.id}-0`] }),
  );
  compareFirstInteraction(
    20260827,
    ({ actor }) => {
      actor.inventory = [{ id: 'gift-food', materialId: Material.Food, quantity: 1, sourceEventIds: ['e-gift-food'] }];
    },
    ({ actor, other }) => ({
      kind: 'transfer', materialId: Material.Food, quantity: 1,
      from: { kind: 'person', personId: actor.id },
      to: { kind: 'person', personId: other.id },
      stackId: 'gift-food',
    }),
    ({ other }) => other,
    ({ actor }) => ({ trust: 3, bond: 2, fear: 0, sourceEventIds: [`e-1-action-${actor.id}-0`] }),
  );
  compareFirstInteraction(
    20260828,
    ({ actor, other }) => {
      actor.inventory = [{ id: 'care-fiber', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['e-care-fiber'] }];
      other.conditions = [{ id: 'wound-first-care', kind: 'wound', stage: 2, sinceMonth: 0, sourceEventIds: ['e-wound'] }];
    },
    ({ actor, other }) => ({
      kind: 'act', operation: 'combine',
      targets: [
        { kind: 'inventory-stack', personId: actor.id, stackId: 'care-fiber' },
        { kind: 'person', personId: other.id },
      ],
    }),
    ({ other }) => other,
    ({ actor }) => ({ trust: 7, bond: 5, fear: 0, sourceEventIds: [`e-1-action-${actor.id}-0`] }),
  );

  // Unavailable genetic parent ids remain genealogical data only. They must
  // not create a psychological relation without a living parent entity at the
  // birth event.
  for (const unavailableKind of ['unknown', 'dead']) {
    const state = createInitialState(unavailableKind === 'unknown' ? 20260830 : 20260831, {
      endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0,
    });
    const mother = state.people.find((person) => person.sex === 'female') ?? state.people[0];
    const father = state.people.find((person) => person.sex === 'male' && person.id !== mother.id) ?? state.people[1];
    assert.ok(mother && father);
    mother.sex = 'female';
    father.sex = 'male';
    mother.bornAtMonth = -24 * 12;
    father.bornAtMonth = -24 * 12;
    mother.body = { health: 100, hydration: 100, nutrition: 100 };
    father.body = { health: 100, hydration: 100, nutrition: 100 };
    mother.traits = [];
    father.traits = [];
    mother.relations = [];
    father.relations = [];
    mother.conditions = [];
    father.conditions = [];
    father.position = structuredClone(mother.position);
    const unavailableParentId = unavailableKind === 'unknown' ? 'unknown-parent' : father.id;
    if (unavailableKind === 'unknown') state.people = [mother];
    else {
      father.diedAtMonth = 0;
      state.people = [mother, father];
    }
    mother.conditions.push({
      id: `pregnancy-${unavailableKind}`, kind: 'pregnancy', stage: 3, sinceMonth: 0,
      dueAtMonth: 1, otherPersonId: unavailableParentId, sourceEventIds: ['e-conception'],
    });
    state.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
    const facts = advanceBodies(state, 1);
    const birthFact = facts.find((event) => event.diff.bornPersonId);
    const child = birthFact ? state.people.find((person) => person.id === birthFact.diff.bornPersonId) : undefined;
    assert.ok(birthFact && child);
    assert.ok(child.geneticParents.includes(unavailableParentId), 'legacy genealogical parent id remains unchanged');
    assert.equal(relationTo(child, unavailableParentId), undefined, 'unknown or dead parent must not gain a child-to-parent psychological edge');
    if (unavailableKind === 'dead') assert.equal(relationTo(father, child.id), undefined, 'dead parent must not gain a reverse birth edge');
    assert.ok((relationTo(child, mother.id)?.bond ?? 0) >= 12, 'the living birth parent keeps sourced kinship');
  }

  // One birth among 1,000 historical people must not allocate a legacy zero
  // relation to every person. The fixture deliberately avoids allocating the
  // old P^2 matrix so the memory assertion tests the sparse production path.
  {
    const state = createInitialState(20260829, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    const mother = state.people.find((person) => person.sex === 'female') ?? state.people[0];
    const father = state.people.find((person) => person.sex === 'male' && person.id !== mother.id) ?? state.people[1];
    assert.ok(mother && father);
    mother.sex = 'female';
    father.sex = 'male';
    mother.bornAtMonth = -24 * 12;
    father.bornAtMonth = -24 * 12;
    mother.body = { health: 100, hydration: 100, nutrition: 100 };
    father.body = { health: 100, hydration: 100, nutrition: 100 };
    mother.traits = [];
    father.traits = [];
    mother.relations = [];
    father.relations = [];
    mother.conditions = [{
      id: 'synthetic-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: 0,
      dueAtMonth: 1, otherPersonId: father.id, sourceEventIds: ['e-conception'],
    }];
    father.conditions = [];
    father.position = structuredClone(mother.position);
    delete mother.diedAtMonth;
    delete father.diedAtMonth;
    const historicalTemplate = state.people.find((person) => person.id !== mother.id && person.id !== father.id) ?? father;
    const historicalPeople = Array.from({ length: 998 }, (_, index) => ({
      ...historicalTemplate,
      id: `historical-${index}`,
      name: `历史人物${index}`,
      diedAtMonth: 0,
      conditions: [],
      relations: [],
    }));
    state.people = [mother, father, ...historicalPeople];
    state.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
    const birthFacts = advanceBodies(state, 1);
    const birthFact = birthFacts.find((event) => event.diff.bornPersonId);
    const child = birthFact ? state.people.find((person) => person.id === birthFact.diff.bornPersonId) : undefined;
    assert.ok(birthFact && child, 'the 1,000-person fixture must produce one real newborn');
    assert.deepEqual([...new Set(child.relations.map((relation) => relation.personId))].sort(), [father.id, mother.id].sort());
    assert.ok(child.relations.every((relation) => relation.sourceEventIds.includes(birthFact.id)));
    assert.ok(historicalPeople.every((person) => person.relations.length === 0), 'historical strangers must not gain reverse zero edges');
    const redundantZeroEdges = state.people.flatMap((person) => person.relations)
      .filter((relation) => relation.trust === 0 && relation.bond === 0 && relation.fear === 0 && relation.sourceEventIds.length === 0)
      .length;
    const storedRelationEdges = state.people.reduce((total, person) => total + person.relations.length, 0);
    const legacyDenseEdgeCount = 1_000 * 999;
    assert.equal(redundantZeroEdges, 0);
    assert.ok(storedRelationEdges < legacyDenseEdgeCount / 100, 'stored relation edges must remain far below the legacy quadratic matrix');
    const memoryUsage = process.memoryUsage();
    assert.ok(memoryUsage.rss < 256 * 1024 * 1024, `sparse 1,000-person fixture exceeded 256 MiB RSS: ${memoryUsage.rss}`);
    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      historicalPersonCount: historicalPeople.length,
      storedRelationEdges,
      redundantZeroEdges,
      rssBytes: memoryUsage.rss,
    })}\n`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
