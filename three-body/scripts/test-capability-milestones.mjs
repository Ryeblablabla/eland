import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-capability-milestones-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const observerBundlePath = path.join(temporaryDirectory, 'capability-milestones.mjs');

const normalizeFixtureLanguage = (rawAction, rawDiff = {}) => {
  const { interpreters: actionInterpreters = [], ...actionWithoutInterpreters } = rawAction;
  const { interpreters: diffInterpreters = [], ...diffWithoutInterpreters } = rawDiff;
  if (actionWithoutInterpreters.kind === 'talk' && 'carrierStackId' in actionWithoutInterpreters) {
    const { carrierStackId, speakerMeaning } = actionWithoutInterpreters;
    return {
      action: { kind: 'inscribe', carrierStackId, inscriptionMeaning: speakerMeaning },
      diff: diffWithoutInterpreters,
    };
  }
  if (actionWithoutInterpreters.kind !== 'talk') {
    return { action: actionWithoutInterpreters, diff: diffWithoutInterpreters };
  }
  const interpreterIds = [...new Set([...actionInterpreters, ...diffInterpreters])];
  return {
    action: actionWithoutInterpreters,
    diff: {
      ...diffWithoutInterpreters,
      listenerInterpretations: interpreterIds.map((listenerId) => ({
        version: 'listener-language-interpretation-v1',
        listenerId,
        sourceRepresentationId: actionWithoutInterpreters.speakerMeaning.id,
        kind: actionWithoutInterpreters.speakerMeaning.kind,
      })),
    },
  };
};

try {
  for (const [entryPoint, outputPath] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/projection/capability-milestones.ts', observerBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entryPoint, '--bundle', '--platform=node', '--format=esm', `--outfile=${outputPath}`,
    ], { stdio: 'pipe' });
  }

  const { createInitialState } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const {
    CAPABILITY_MILESTONE_DEFINITIONS,
    observeCapabilityMilestones,
  } = await import(`${pathToFileURL(observerBundlePath).href}?test=${Date.now()}`);

  const definitions = CAPABILITY_MILESTONE_DEFINITIONS;
  const strict = definitions.filter((definition) => definition.support === 'strict');
  const guarded = definitions.filter((definition) => definition.support === 'guarded');
  const mapDefinitions = definitions.filter((definition) => definition.catalogKind === 'map');
  const worldSpecific = definitions.filter((definition) => definition.catalogKind === 'world-specific');
  assert.ok(definitions.length >= 120, 'audited catalog must expose at least 120 definitions');
  assert.equal(new Set(definitions.map((definition) => definition.id)).size, definitions.length, 'definition IDs must be unique');
  assert.ok(new Set(mapDefinitions.map((definition) => definition.capabilityId)).size >= 100, 'catalog must cover at least one hundred distinct map coordinates');
  assert.ok(strict.length > 0 && guarded.length > 0 && worldSpecific.length > 0);
  assert.ok(definitions.every((definition) => definition.causalConditions.length >= 2), 'every definition needs a multi-part causal test');
  assert.ok(definitions.every((definition) => definition.definitionVersion === 'capability-causal-v2'));
  assert.ok(definitions.every((definition) => definition.stageCriteria.minEpisodes >= 1
    && definition.stageCriteria.minDistinctMonths >= 1
    && definition.stageCriteria.minDistinctActors >= 0
    && definition.stageCriteria.minEvidenceEvents >= 1
    && definition.stageCriteria.evidenceEpisodeLimit >= definition.stageCriteria.minEpisodes));
  assert.ok(strict.filter((definition) => definition.phase === 'stable').every((definition) =>
    definition.stageCriteria.minEpisodes >= 2
      || definition.stageCriteria.minDistinctMonths >= 2
      || definition.stageCriteria.minDistinctActors >= 2
      || definition.stageCriteria.minEvidenceEvents >= 2), 'stable definitions must reject a single event');

  const capabilityMapText = readFileSync(path.resolve('../docs/human-society-capability-map-1000.md'), 'utf8');
  const mapLabels = new Map([...capabilityMapText.matchAll(/^- (\d+)\. (.+)$/gm)]
    .map((match) => [Number(match[1]), match[2].trim()]));
  assert.ok(mapDefinitions.every((definition) => definition.capabilityId !== undefined
    && definition.mapLabel === mapLabels.get(definition.capabilityId)
    && definition.label === definition.mapLabel), 'every map definition must preserve the exact source map label');
  assert.ok(worldSpecific.every((definition) => definition.capabilityId === undefined && definition.mapLabel === undefined), 'world-specific definitions must not occupy map coordinates');
  assert.ok(definitions.filter((definition) => definition.capabilityId !== undefined
    && definition.capabilityId >= 801 && definition.capabilityId <= 809)
    .every((definition) => definition.support === 'guarded'), 'three-body prediction and era facts must not occupy data/computing coordinates 801-809');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 802)?.mapLabel, '设计算法处理重复任务');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 881)?.mapLabel, '识别无法依靠自身维生者');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 168)?.support, 'guarded', 'care actions do not prove responsibility allocation');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 165)?.support, 'guarded', 'a birth fact does not prove that people confirmed or disputed parentage');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 322)?.support, 'guarded', 'generic harvesting does not prove cutting, grinding or drilling');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 119)?.support, 'guarded', 'ordinary care plus a later death does not prove end-of-life care');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 354)?.support, 'guarded', 'repeated gathering does not prove managed forestry');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 184)?.detector, 'membership-belonging', 'candidate-driven belonging needs its own detector');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 488)?.detector, 'membership-admission', 'community admission remains distinct from candidate-driven belonging');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 384)?.support, 'guarded', 'local project logistics do not prove route planning');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 392)?.support, 'guarded', 'local project logistics do not prove a cross-regional supply chain');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 337)?.support, 'guarded', 'generic technique verification does not prove product quality inspection');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 903)?.support, 'guarded', 'a breach fact alone does not prove that trust actually declined');
  assert.notEqual(mapDefinitions.find((definition) => definition.capabilityId === 59)?.detector,
    mapDefinitions.find((definition) => definition.capabilityId === 222)?.detector, 'hypothesis testing and trial-based skill mastery need distinct evidence selectors');
  assert.ok(mapDefinitions.find((definition) => definition.capabilityId === 405)?.stageCriteria.minEpisodes
    > mapDefinitions.find((definition) => definition.capabilityId === 22)?.stageCriteria.minEpisodes,
  'team workflow must require more repeated episodes than one coordinated action');
  for (const detector of ['theft-attempt', 'theft-success', 'violence', 'lethal-violence', 'restraint', 'release-restraint', 'breach', 'collective-collapse', 'collective-recovery', 'project-breakdown', 'project-recovery']) {
    assert.ok(strict.some((definition) => definition.detector === detector), `${detector} must remain a strict negative or reversal detector`);
  }

  const state = createInitialState(661, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const [actor, victim, witness] = state.people;
  state.clock.elapsedMonths = 6;
  state.derived.structures = [];
  let orderInMonth = 0;
  const actionFact = ({
    id, atMonth, who, status = 'completed', action: rawAction, diff: rawDiff, intentId,
    fromCellId = 0, toCellId = fromCellId, pathSegment = [fromCellId],
  }) => {
    const { action, diff } = normalizeFixtureLanguage(rawAction, rawDiff);
    return {
      id,
      kind: 'action',
      atMonth,
      orderInMonth: orderInMonth++,
      planningTick: 1,
      orderInTick: orderInMonth,
      actionTick: 1,
      cellId: toCellId,
      who,
      ...(intentId ? { intentId } : {}),
      cause: 'intent',
      action,
      fromCellId,
      toCellId,
      fromZ: 1,
      toZ: 1,
      pathSegment,
      status,
      result: id,
      diff,
    };
  };
  const transfer = (from, to) => ({ kind: 'transfer', materialId: 21, quantity: 1, from, to });
  const exert = (personId) => ({ kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId }] });

  const theftAttempt = actionFact({
    id: 'theft-attempt', atMonth: 1, who: actor.id, status: 'blocked',
    action: transfer({ kind: 'person', personId: victim.id }, { kind: 'person', personId: actor.id }),
    diff: { authorized: false, attempted: true, resistedBy: victim.id, witnessedBy: [victim.id, witness.id] },
  });
  const containerTransfer = actionFact({
    id: 'container-transfer', atMonth: 1, who: actor.id,
    action: transfer({ kind: 'container', containerId: 'container:test' }, { kind: 'person', personId: actor.id }),
    diff: { authorized: true, quantity: 1, from: { kind: 'container', containerId: 'container:test' }, to: { kind: 'person', personId: actor.id } },
  });
  const theftSuccess = actionFact({
    id: 'theft-success', atMonth: 2, who: actor.id,
    action: transfer({ kind: 'person', personId: victim.id }, { kind: 'person', personId: actor.id }),
    diff: { authorized: false, quantity: 1, materialId: 21, from: { kind: 'person', personId: victim.id }, to: { kind: 'person', personId: actor.id }, witnessedBy: [witness.id] },
  });
  const nonlethalAttack = actionFact({
    id: 'attack-nonlethal', atMonth: 3, who: actor.id,
    action: exert(victim.id), diff: { victimId: victim.id, damage: 5, health: 60, witnessedBy: [witness.id] },
  });
  const lethalAttack = actionFact({
    id: 'attack-lethal', atMonth: 4, who: actor.id,
    action: exert(victim.id), diff: { victimId: victim.id, damage: 8, health: 0, witnessedBy: [witness.id] },
  });
  const breachProposal = actionFact({
    id: 'breach-proposal', atMonth: 1, who: actor.id,
    action: {
      kind: 'talk', interpreters: [victim.id],
      speakerMeaning: {
        id: 'agreement:breached', kind: 'request', summary: 'fixture request',
        proposal: { kind: 'assist', requesterId: actor.id, helperId: victim.id, need: 'food', expiresAtMonth: 4 },
      },
    },
    diff: { interpreters: [victim.id] },
  });
  const breachAcceptance = actionFact({
    id: 'breach-acceptance', atMonth: 2, who: victim.id,
    action: {
      kind: 'talk', interpreters: [actor.id],
      speakerMeaning: { id: 'accept-breached', kind: 'accept', referenceId: 'agreement:breached' },
    },
    diff: { interpreters: [actor.id] },
  });
  const ordinaryDeath = {
    id: 'death-ordinary', kind: 'environment', change: 'death', atMonth: 4, orderInMonth: orderInMonth++, cellId: 0,
    who: witness.id, result: 'ordinary death fixture',
    diff: { personId: witness.id, cause: 'aging-terminal', sourceEventIds: [] },
  };
  const violenceDeath = {
    id: 'death-violence', kind: 'environment', change: 'death', atMonth: 5, orderInMonth: orderInMonth++, cellId: 0,
    who: victim.id, result: 'violence death fixture',
    diff: { personId: victim.id, cause: 'body-failure', sourceEventIds: [lethalAttack.id] },
  };
  const rejectedAgreementFact = {
    id: 'agreement-rejected', kind: 'agreement', change: 'rejected', agreementId: 'agreement:rejected',
    partyIds: [actor.id, victim.id], atMonth: 2, orderInMonth: orderInMonth++, cellId: 0, result: 'rejected fixture',
  };
  const expiredAgreementFact = {
    id: 'agreement-expired', kind: 'agreement', change: 'expired', agreementId: 'agreement:expired',
    partyIds: [actor.id, victim.id], atMonth: 3, orderInMonth: orderInMonth++, cellId: 0, result: 'expired fixture',
  };
  const breachedAgreementFact = {
    id: 'agreement-breached', kind: 'agreement', change: 'breached', agreementId: 'agreement:breached',
    partyIds: [actor.id, victim.id], atMonth: 6, orderInMonth: orderInMonth++, cellId: 0, result: 'breached fixture',
  };

  state.world.past = [
    theftAttempt, containerTransfer, theftSuccess, nonlethalAttack, lethalAttack, breachProposal, breachAcceptance,
    ordinaryDeath, violenceDeath, rejectedAgreementFact, expiredAgreementFact, breachedAgreementFact,
  ];
  const agreement = (id, status, sourceEventIds, acceptedAtMonth) => ({
    id,
    proposal: { kind: 'assist', requesterId: actor.id, helperId: victim.id, need: 'food', expiresAtMonth: 4 },
    proposerId: actor.id,
    responderId: victim.id,
    partyIds: [actor.id, victim.id],
    requiredResponderIds: [victim.id],
    acceptedByPersonIds: acceptedAtMonth === undefined ? [actor.id] : [actor.id, victim.id],
    rejectedByPersonIds: status === 'rejected' ? [victim.id] : [],
    status,
    proposedAtMonth: 1,
    acceptByMonth: 2,
    ...(acceptedAtMonth === undefined ? {} : { acceptedAtMonth }),
    resolvedAtMonth: 6,
    proposalEventId: sourceEventIds[0],
    fulfillmentEventIds: [],
    fulfilledByPersonIds: [],
    coLocatedMonths: 0,
    sourceEventIds,
  });
  state.agreements = [
    agreement('agreement:rejected', 'rejected', [rejectedAgreementFact.id]),
    agreement('agreement:expired', 'expired', [expiredAgreementFact.id], 1),
    agreement('agreement:breached', 'breached', [breachProposal.id, containerTransfer.id, breachAcceptance.id, breachedAgreementFact.id], 1),
  ];

  const before = JSON.stringify(state);
  const observed = observeCapabilityMilestones(state);
  assert.equal(JSON.stringify(state), before, 'observer must not mutate authoritative state');
  assert.ok(observed.every((milestone) => milestone.evidenceEventIds.every((id) => state.world.past.some((event) => event.id === id))), 'all emitted evidence IDs must resolve');
  assert.ok(observed.every((milestone) => milestone.definitionVersion === 'capability-causal-v2'));
  assert.ok(observed.every((milestone) => milestone.catalogKind === 'world-specific'
    ? milestone.capabilityId === undefined && milestone.mapLabel === undefined
    : milestone.catalogKind === 'map' && milestone.mapLabel === milestone.label && Number.isInteger(milestone.capabilityId)),
  'observations must retain their exact catalog namespace and source-map label');
  assert.ok(observed.every((milestone) => milestone.occurrenceCount >= 1
    && milestone.occurrenceCount <= milestone.evidenceEventIds.length), 'occurrenceCount must describe only retained replayable episodes');
  assert.ok(!observed.some((milestone) => guarded.some((definition) => definition.id === milestone.id)), 'guarded definitions can never emit achieved results');

  const strictWorldDefinition = (detector) => {
    const definition = worldSpecific.find((candidate) => candidate.support === 'strict' && candidate.detector === detector);
    assert.ok(definition, `missing strict world-specific detector: ${detector}`);
    return definition;
  };

  const theftResponse = observed.find((milestone) => milestone.capabilityId === 641 && milestone.phase === 'response');
  const theftHarm = observed.find((milestone) => milestone.id === strictWorldDefinition('theft-success').id);
  assert.deepEqual(theftResponse?.evidenceEventIds, [theftAttempt.id], 'resisted attempt must not be upgraded to successful theft');
  assert.deepEqual(theftHarm?.evidenceEventIds, [theftSuccess.id], 'only completed unauthorized person-to-person transfer is successful theft');
  assert.ok(!theftHarm?.evidenceEventIds.includes(containerTransfer.id), 'ownerless container access is not theft');

  const violence = observed.find((milestone) => milestone.id === strictWorldDefinition('violence').id);
  const lethalViolence = observed.find((milestone) => milestone.id === strictWorldDefinition('lethal-violence').id);
  assert.ok(violence?.evidenceEventIds.includes(nonlethalAttack.id));
  assert.deepEqual(lethalViolence?.evidenceEventIds, [lethalAttack.id, violenceDeath.id], 'lethal violence requires death to cite an attack against the same victim');
  assert.ok(!lethalViolence?.evidenceEventIds.includes(ordinaryDeath.id), 'ordinary death is never homicide or lethal violence');
  assert.ok(!lethalViolence?.label.includes('谋杀'), 'observer must not infer intent or legal murder');
  assert.ok(!observed.some((milestone) => milestone.capabilityId === 931), 'violence occurrence alone does not prove that people investigated it');

  const breach = observed.find((milestone) => milestone.id === strictWorldDefinition('breach').id);
  assert.deepEqual(breach?.evidenceEventIds, [breachProposal.id, breachAcceptance.id, breachedAgreementFact.id], 'breach requires proposal, acceptance and explicit breached outcome');
  assert.ok(!breach?.evidenceEventIds.includes(containerTransfer.id), 'unrelated agreement source history is not breach evidence');
  assert.ok(!breach?.evidenceEventIds.includes(rejectedAgreementFact.id));
  assert.ok(!breach?.evidenceEventIds.includes(expiredAgreementFact.id));
  assert.ok(!observed.some((milestone) => milestone.capabilityId === 903), 'breach occurrence alone does not prove lost trust');

  const roadState = createInitialState(664, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const roadAction = (id, cells) => actionFact({
    id, atMonth: 1, who: roadState.people[0].id,
    action: { kind: 'act', operation: 'exert', targets: [{ kind: 'voxel', cellId: cells[0], z: 0 }] },
    diff: { materialChanges: cells.map((cellId) => ({ cellId, to: 15 })) },
  });
  const disconnectedRoad = roadAction('road-disconnected', [0, 2, 4, 6]);
  roadState.world.past = [disconnectedRoad];
  assert.ok(!observeCapabilityMilestones(roadState).some((milestone) => milestone.capabilityId === 42), 'four disconnected packed-soil cells are not a road');
  const connectedRoad = roadAction('road-connected', [0, 1, 2, 3]);
  roadState.world.past = [connectedRoad];
  assert.deepEqual(observeCapabilityMilestones(roadState).find((milestone) => milestone.capabilityId === 42)?.evidenceEventIds,
    [connectedRoad.id], 'a connected four-cell packed-soil strip is road evidence');

  const famineState = createInitialState(665, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const hungerFact = (id, atMonth, personId) => ({
    id, kind: 'environment', change: 'body', atMonth, orderInMonth: orderInMonth++, cellId: 0,
    who: personId, result: 'nutrition injury fixture', diff: { nutrition: 5, personId },
  });
  const firstHunger = hungerFact('hunger-first', 1, famineState.people[0].id);
  famineState.world.past = [firstHunger];
  assert.ok(!observeCapabilityMilestones(famineState).some((milestone) => milestone.capabilityId === 36), 'one hungry person is not a population famine');
  const secondHunger = hungerFact('hunger-second', 2, famineState.people[1].id);
  famineState.world.past.push(secondHunger);
  assert.deepEqual(observeCapabilityMilestones(famineState).find((milestone) => milestone.capabilityId === 36)?.evidenceEventIds,
    [firstHunger.id, secondHunger.id], 'multi-person nutrition injury in one short window is famine evidence');

  const lossState = createInitialState(666, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const lostHolder = lossState.people[0];
  const techniqueSource = actionFact({
    id: 'technique-source', atMonth: 1, who: lostHolder.id,
    action: { kind: 'act', operation: 'combine', targets: [] }, diff: { outputMaterialId: 24 },
  });
  lostHolder.knowledge.push({
    id: 'technique:fixture-loss', kind: 'technique', summary: 'fixture technique', confidence: 60,
    learnedAtMonth: 1, sourceEventIds: [techniqueSource.id],
  });
  lostHolder.body.health = 0;
  lostHolder.diedAtMonth = 2;
  const holderDeath = {
    id: 'technique-holder-death', kind: 'environment', change: 'death', atMonth: 2,
    orderInMonth: orderInMonth++, cellId: 0, who: lostHolder.id, result: 'holder died',
    diff: { personId: lostHolder.id, cause: 'body-failure', sourceEventIds: [] },
  };
  lossState.world.past = [techniqueSource, holderDeath];
  const techniqueLoss = observeCapabilityMilestones(lossState).find((milestone) => milestone.capabilityId === 949);
  assert.deepEqual(techniqueLoss?.evidenceEventIds, [techniqueSource.id, holderDeath.id], 'technique loss must include acquisition and last-holder death evidence');
  assert.equal(techniqueLoss?.observedAtMonth, 2);

  const recordState = createInitialState(661, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const [recordAuthor, recordCarrier, recordReader] = recordState.people;
  const recordPayloadId = 'record:test-shared-payload';
  const recordWrite = actionFact({
    id: 'record-write', atMonth: 1, who: recordAuthor.id,
    action: {
      kind: 'talk', interpreters: [], carrierStackId: 'record-stack',
      speakerMeaning: { id: 'record-content', kind: 'claim', summary: 'record fixture', factId: 'knowledge:record-fixture' },
    },
    diff: { recordPayloadId, carrierStackId: 'record-stack', knowledgeId: 'knowledge:record-fixture', version: 1 },
  });
  const recordTransfer = actionFact({
    id: 'record-transfer', atMonth: 2, who: recordCarrier.id,
    action: {
      kind: 'transfer', materialId: 27, quantity: 1,
      from: { kind: 'person', personId: recordCarrier.id },
      to: { kind: 'person', personId: recordReader.id },
    },
    diff: {
      materialId: 27, quantity: 1, authorized: true, recordPayloadId,
      from: { kind: 'person', personId: recordCarrier.id },
      to: { kind: 'person', personId: recordReader.id },
    },
  });
  const recordRead = actionFact({
    id: 'record-read', atMonth: 3, who: recordReader.id,
    action: { kind: 'attend', target: { kind: 'inventory-stack', personId: recordReader.id, stackId: 'record-stack' } },
    diff: { recordPayloadId, learnedFactId: 'knowledge:record-fixture', understood: true },
  });
  recordState.records = [{
    id: recordPayloadId,
    authorId: recordAuthor.id,
    knowledgeId: 'knowledge:record-fixture',
    codebookId: 'codebook:record-fixture',
    kind: 'claim',
    summary: 'record fixture',
    version: 1,
    createdAtMonth: 1,
    sourceEventIds: [recordWrite.id],
  }];
  recordReader.inventory.push({
    id: 'record-stack', materialId: 27, quantity: 1,
    sourceEventIds: [recordWrite.id, recordTransfer.id], recordPayloadId,
  });
  const sharedRecordDefinitionIds = new Set(definitions
    .filter((definition) => definition.support === 'strict' && definition.detector === 'shared-record')
    .map((definition) => definition.id));
  assert.ok(sharedRecordDefinitionIds.size > 0, 'catalog must include a strict shared-record definition');

  recordState.world.past = [recordWrite, recordTransfer];
  const transferOnly = observeCapabilityMilestones(recordState)
    .filter((milestone) => sharedRecordDefinitionIds.has(milestone.id));
  assert.deepEqual(transferOnly, [], 'carrying or transferring a record does not prove that another person understood it');

  recordState.world.past.push(recordRead);
  const sharedRecords = observeCapabilityMilestones(recordState)
    .filter((milestone) => sharedRecordDefinitionIds.has(milestone.id));
  assert.equal(sharedRecords.length, sharedRecordDefinitionIds.size, 'a write followed by another person understanding the payload is shared-record evidence');
  assert.ok(sharedRecords.every((milestone) => milestone.evidenceEventIds.includes(recordWrite.id)));
  assert.ok(sharedRecords.every((milestone) => milestone.evidenceEventIds.includes(recordRead.id)));
  assert.ok(sharedRecords.every((milestone) => !milestone.evidenceEventIds.includes(recordTransfer.id)), 'record transfer must not be cited as semantic shared-record evidence');
  assert.ok(sharedRecords.every((milestone) => milestone.phase === 'stable' && milestone.occurrenceCount === 1), 'one aggregate shared-record episode must contain both semantic actions');

  const preservationState = createInitialState(667, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const preservationAuthor = preservationState.people[0];
  const preservedPayloadId = 'record:preserved-payload';
  const preservationWrite = actionFact({
    id: 'preservation-write', atMonth: 1, who: preservationAuthor.id,
    action: {
      kind: 'talk', interpreters: [], carrierStackId: 'preserved-stack',
      speakerMeaning: { id: 'preserved-content', kind: 'claim', summary: 'preservation fixture', factId: 'knowledge:preserved' },
    },
    diff: { recordPayloadId: preservedPayloadId, carrierStackId: 'preserved-stack', knowledgeId: 'knowledge:preserved', version: 1 },
  });
  preservationState.records = [{
    id: preservedPayloadId, authorId: preservationAuthor.id, knowledgeId: 'knowledge:preserved',
    codebookId: 'codebook:preserved', kind: 'claim', summary: 'preservation fixture', version: 1,
    createdAtMonth: 1, sourceEventIds: [preservationWrite.id],
  }];
  preservationAuthor.inventory.push({
    id: 'preserved-stack', materialId: 27, quantity: 1,
    sourceEventIds: [preservationWrite.id], recordPayloadId: preservedPayloadId,
  });
  preservationState.world.past = [preservationWrite];
  preservationState.clock.elapsedMonths = 12;
  assert.ok(!observeCapabilityMilestones(preservationState).some((milestone) => milestone.capabilityId === 248),
    'a newly written carrier cannot immediately prove long-term preservation');
  preservationState.clock.elapsedMonths = 13;
  const physicalRecord = observeCapabilityMilestones(preservationState).find((milestone) => milestone.capabilityId === 248);
  assert.deepEqual(physicalRecord?.evidenceEventIds, [preservationWrite.id], 'a carrier still present after twelve full months is preservation evidence');
  assert.equal(physicalRecord?.observedAtMonth, 13, 'preservation is observed when the retention interval is crossed, not when writing occurred');
  preservationAuthor.inventory = preservationAuthor.inventory.filter((stack) => stack.recordPayloadId !== preservedPayloadId);
  assert.ok(!observeCapabilityMilestones(preservationState).some((milestone) => milestone.capabilityId === 248),
    'elapsed time without a surviving physical carrier is not preservation');

  const careState = createInitialState(662, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const [parent, child] = careState.people;
  child.bornAtMonth = 0;
  child.geneticParents = [parent.id];
  careState.clock.elapsedMonths = 3;
  const firstFeeding = actionFact({
    id: 'feeding-first', atMonth: 1, who: parent.id,
    action: transfer({ kind: 'person', personId: parent.id }, { kind: 'person', personId: child.id }),
    diff: { authorized: true, materialId: 21, quantity: 1 },
  });
  const secondFeeding = actionFact({
    id: 'feeding-second', atMonth: 2, who: parent.id,
    action: transfer({ kind: 'person', personId: parent.id }, { kind: 'person', personId: child.id }),
    diff: { authorized: true, materialId: 21, quantity: 1 },
  });
  const raisingDefinition = mapDefinitions.find((definition) => definition.capabilityId === 3);
  const feedingDefinition = mapDefinitions.find((definition) => definition.capabilityId === 131);
  assert.equal(raisingDefinition?.phase, 'stable');
  assert.equal(feedingDefinition?.phase, 'practice');

  careState.world.past = [firstFeeding];
  const singleCare = observeCapabilityMilestones(careState);
  assert.ok(!singleCare.some((milestone) => milestone.id === raisingDefinition.id), 'one feeding event is not stable child raising');
  assert.deepEqual(singleCare.find((milestone) => milestone.id === feedingDefinition.id)?.evidenceEventIds, [firstFeeding.id], 'one feeding event is feeding practice');

  careState.world.past.push(secondFeeding);
  const repeatedCare = observeCapabilityMilestones(careState);
  const stableRaising = repeatedCare.find((milestone) => milestone.id === raisingDefinition.id);
  const feedingPractice = repeatedCare.find((milestone) => milestone.id === feedingDefinition.id);
  assert.deepEqual(stableRaising?.evidenceEventIds, [firstFeeding.id, secondFeeding.id], 'cross-month care satisfies stable child raising');
  assert.equal(stableRaising?.occurrenceCount, 2);
  assert.deepEqual(feedingPractice?.evidenceEventIds, [firstFeeding.id], 'practice evidence is capped independently from stable evidence');
  assert.equal(mapDefinitions.find((definition) => definition.capabilityId === 168)?.support, 'guarded');

  const endOfLifeState = createInitialState(668, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const [carer, ordinaryPatient] = endOfLifeState.people;
  const ordinaryCare = actionFact({
    id: 'ordinary-care-before-death', atMonth: 4, who: carer.id,
    action: { kind: 'act', operation: 'expose', targets: [{ kind: 'person', personId: ordinaryPatient.id }] },
    diff: { caredPersonId: ordinaryPatient.id, careMaterialId: 34, health: 35 },
  });
  const laterOrdinaryDeath = {
    id: 'ordinary-patient-death', kind: 'environment', change: 'death', atMonth: 10,
    orderInMonth: orderInMonth++, cellId: 0, who: ordinaryPatient.id, result: 'ordinary patient later died',
    diff: { personId: ordinaryPatient.id, cause: 'body-failure', sourceEventIds: [] },
  };
  endOfLifeState.clock.elapsedMonths = 10;
  endOfLifeState.world.past = [ordinaryCare, laterOrdinaryDeath];
  const ordinaryCareObserved = observeCapabilityMilestones(endOfLifeState);
  assert.deepEqual(ordinaryCareObserved.find((milestone) => milestone.capabilityId === 6)?.evidenceEventIds, [ordinaryCare.id],
    'ordinary care remains observable as care');
  assert.ok(!ordinaryCareObserved.some((milestone) => milestone.capabilityId === 119),
    'a later death cannot retrospectively turn ordinary treatment into end-of-life care');

  const migrationState = createInitialState(669, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const migrant = migrationState.people[0];
  const moveFact = ({ id, atMonth, intentId, fromCellId, toCellId, pathSegment }) => actionFact({
    id, atMonth, who: migrant.id, intentId, fromCellId, toCellId, pathSegment,
    action: { kind: 'move', toCellId, toZ: 1 }, diff: { moved: true },
  });
  const migrationStart = moveFact({
    id: 'migration-start', atMonth: 1, intentId: 'intent:migration', fromCellId: 0, toCellId: 4,
    pathSegment: [0, 1, 2, 3, 4],
  });
  const migrationContinue = moveFact({
    id: 'migration-continue', atMonth: 1, intentId: 'intent:migration', fromCellId: 4, toCellId: 8,
    pathSegment: [4, 5, 6, 7, 8],
  });
  const migrationThreshold = moveFact({
    id: 'migration-threshold', atMonth: 2, intentId: 'intent:migration', fromCellId: 8, toCellId: 12,
    pathSegment: [8, 9, 10, 11, 12],
  });
  const migrationResidence = actionFact({
    id: 'migration-residence', atMonth: 3, who: migrant.id, fromCellId: 12, toCellId: 12, pathSegment: [12],
    action: { kind: 'attend', target: { kind: 'voxel', position: { x: 12, y: 0, z: 0 } } },
    diff: { observed: true },
  });
  migrationState.clock.elapsedMonths = 3;
  migrationState.world.past = [migrationStart, migrationContinue, migrationThreshold];
  assert.ok(!observeCapabilityMilestones(migrationState).some((milestone) => milestone.capabilityId === 14),
    'crossing the distance threshold without post-migration residence is not migration');
  migrationState.world.past.push(migrationResidence);
  const migration = observeCapabilityMilestones(migrationState).find((milestone) => milestone.capabilityId === 14);
  assert.deepEqual(migration?.evidenceEventIds,
    [migrationStart.id, migrationContinue.id, migrationThreshold.id, migrationResidence.id],
    'one sustained movement episode plus later residence is migration evidence');
  assert.ok(migration?.evidenceEventIds.includes(migrationThreshold.id), 'migration evidence must retain the move that crosses the threshold');

  const mixedIntentState = createInitialState(670, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const mixedIntentMoves = [
    { ...migrationStart, id: 'mixed-intent-start', intentId: 'intent:mixed-a' },
    { ...migrationContinue, id: 'mixed-intent-continue', intentId: 'intent:mixed-b' },
    { ...migrationThreshold, id: 'mixed-intent-threshold', intentId: 'intent:mixed-c' },
    { ...migrationResidence, id: 'mixed-intent-residence' },
  ];
  mixedIntentState.world.past = mixedIntentMoves;
  assert.ok(!observeCapabilityMilestones(mixedIntentState).some((milestone) => milestone.capabilityId === 14),
    'moves from unrelated intents cannot be accumulated into one migration episode');

  const gappedMigrationState = createInitialState(671, { endpoint: { kind: 'months', value: 18 }, chaosIntensity: 0 });
  gappedMigrationState.world.past = [
    { ...migrationStart, id: 'gapped-migration-start', atMonth: 1 },
    { ...migrationContinue, id: 'gapped-migration-continue', atMonth: 5 },
    { ...migrationThreshold, id: 'gapped-migration-threshold', atMonth: 9 },
    { ...migrationResidence, id: 'gapped-migration-residence', atMonth: 10 },
  ];
  assert.ok(!observeCapabilityMilestones(gappedMigrationState).some((milestone) => milestone.capabilityId === 14),
    'widely separated moves from one old intent cannot be accumulated across all history');

  const membershipFixture = (seed, candidateRequested, membershipStatus = 'active') => {
    const membershipState = createInitialState(seed, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
    const [member, approver, candidate] = membershipState.people;
    const collectiveId = `collective:membership-${seed}`;
    const admissionId = `agreement:admission-${seed}`;
    const requiredApproverIds = [approver.id, candidate.id];
    const candidateRequest = actionFact({
      id: `membership-request-${seed}`, atMonth: 1, who: candidate.id,
      action: {
        kind: 'talk', interpreters: [member.id],
        speakerMeaning: {
          id: `candidate-request-${seed}`, kind: 'request', summary: 'I want to belong',
          proposal: {
            kind: 'membership', proposerId: candidate.id, partnerId: member.id,
            collectiveId, candidateId: candidate.id, requiredApproverIds: [member.id], expiresAtMonth: 4,
          },
        },
      },
      diff: { interpreters: [member.id] },
    });
    const admissionOffer = actionFact({
      id: `membership-offer-${seed}`, atMonth: 2, who: member.id,
      action: {
        kind: 'talk', interpreters: requiredApproverIds,
        speakerMeaning: {
          id: admissionId, kind: 'offer', summary: 'welcome the candidate',
          proposal: {
            kind: 'membership', proposerId: member.id, partnerId: candidate.id,
            collectiveId, candidateId: candidate.id, requiredApproverIds, expiresAtMonth: 6,
          },
        },
      },
      diff: { interpreters: requiredApproverIds },
    });
    const candidateAcceptance = actionFact({
      id: `membership-candidate-accept-${seed}`, atMonth: 2, who: candidate.id,
      action: {
        kind: 'talk', interpreters: [member.id],
        speakerMeaning: { id: `candidate-accept-${seed}`, kind: 'accept', referenceId: admissionId },
      },
      diff: { interpreters: [member.id] },
    });
    const memberAcceptance = actionFact({
      id: `membership-member-accept-${seed}`, atMonth: 3, who: approver.id,
      action: {
        kind: 'talk', interpreters: [member.id],
        speakerMeaning: { id: `member-accept-${seed}`, kind: 'accept', referenceId: admissionId },
      },
      diff: { interpreters: [member.id] },
    });
    const sourceEventIds = [
      ...(candidateRequested ? [candidateRequest.id] : []),
      admissionOffer.id, candidateAcceptance.id, memberAcceptance.id,
    ];
    membershipState.clock.elapsedMonths = 3;
    membershipState.world.past = [
      ...(candidateRequested ? [candidateRequest] : []),
      admissionOffer, candidateAcceptance, memberAcceptance,
    ];
    membershipState.agreements = [{
      id: admissionId,
      proposal: admissionOffer.action.speakerMeaning.proposal,
      proposerId: member.id,
      responderId: candidate.id,
      partyIds: [member.id, ...requiredApproverIds],
      requiredResponderIds: requiredApproverIds,
      acceptedByPersonIds: [member.id, ...requiredApproverIds],
      rejectedByPersonIds: [],
      status: 'fulfilled',
      proposedAtMonth: 2,
      acceptByMonth: 6,
      acceptedAtMonth: 3,
      dueAtMonth: 4,
      resolvedAtMonth: 3,
      proposalEventId: admissionOffer.id,
      responseEventId: memberAcceptance.id,
      fulfillmentEventIds: [memberAcceptance.id],
      fulfilledByPersonIds: [member.id, ...requiredApproverIds],
      coLocatedMonths: 0,
      sourceEventIds,
    }];
    membershipState.collectives = [{
      id: collectiveId,
      purposeSummary: 'membership fixture',
      status: 'active',
      foundedAtMonth: 0,
      formationAgreementId: `formation:${seed}`,
      memberships: [
        { id: `membership:${member.id}`, collectiveId, personId: member.id, status: 'active', joinedAtMonth: 0, sourceEventIds: [] },
        { id: `membership:${approver.id}`, collectiveId, personId: approver.id, status: 'active', joinedAtMonth: 0, sourceEventIds: [] },
        {
          id: `membership:${candidate.id}`, collectiveId, personId: candidate.id, status: membershipStatus,
          joinedAtMonth: 3, ...(membershipStatus === 'active' ? {} : { endedAtMonth: 3 }), sourceEventIds,
        },
      ],
      decisionRules: [],
      mandates: [],
      sourceEventIds,
    }];
    return { membershipState, candidateRequest, admissionOffer, candidateAcceptance, memberAcceptance };
  };

  const requestedMembership = membershipFixture(672, true);
  const requestedMembershipObserved = observeCapabilityMilestones(requestedMembership.membershipState);
  const belonging = requestedMembershipObserved.find((milestone) => milestone.capabilityId === 184);
  assert.deepEqual(belonging?.evidenceEventIds, [
    requestedMembership.candidateRequest.id,
    requestedMembership.admissionOffer.id,
    requestedMembership.candidateAcceptance.id,
    requestedMembership.memberAcceptance.id,
  ], 'candidate request plus accepted active membership is belonging evidence');
  assert.ok(!requestedMembershipObserved.some((milestone) => milestone.capabilityId === 488),
    'one candidate-driven membership episode must not also count as community admission');

  const invitedMembership = membershipFixture(673, false);
  const invitedMembershipObserved = observeCapabilityMilestones(invitedMembership.membershipState);
  assert.ok(!invitedMembershipObserved.some((milestone) => milestone.capabilityId === 184),
    'accepting an unsolicited invitation does not prove the candidate sought belonging');
  assert.deepEqual(invitedMembershipObserved.find((milestone) => milestone.capabilityId === 488)?.evidenceEventIds, [
    invitedMembership.admissionOffer.id,
    invitedMembership.candidateAcceptance.id,
    invitedMembership.memberAcceptance.id,
  ], 'member invitation plus unanimous acceptance remains community-admission evidence');

  const endedMembership = membershipFixture(674, true, 'withdrawn');
  const endedMembershipObserved = observeCapabilityMilestones(endedMembership.membershipState);
  assert.ok(!endedMembershipObserved.some((milestone) => milestone.capabilityId === 184 || milestone.capabilityId === 488),
    'a non-active membership cannot satisfy either active admission detector');

  const forestState = createInitialState(675, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const forestWorker = forestState.people[0];
  const firstHarvest = actionFact({
    id: 'forest-harvest-first', atMonth: 1, who: forestWorker.id,
    action: { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', cellId: 20, z: 0 }] },
    diff: { sourceMaterialId: 13, outputMaterialId: 13 },
  });
  const secondHarvest = actionFact({
    id: 'forest-harvest-second', atMonth: 2, who: forestWorker.id,
    action: { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', cellId: 21, z: 0 }] },
    diff: { sourceMaterialId: 13, outputMaterialId: 13 },
  });
  forestState.world.past = [firstHarvest, secondHarvest];
  assert.ok(!observeCapabilityMilestones(forestState).some((milestone) => milestone.capabilityId === 354),
    'two harvests without quota, rotation or regeneration-rule evidence are not forest management');

  const environmentState = createInitialState(663, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const weatherChange = {
    id: 'weather-change', kind: 'environment', change: 'weather', atMonth: 1,
    orderInMonth: orderInMonth++, cellId: 0, result: 'rain began', diff: { kind: 'rain', intensity: 2 },
  };
  environmentState.world.past = [weatherChange];
  const environmentObserved = observeCapabilityMilestones(environmentState);
  const naturalObservationDefinition = mapDefinitions.find((definition) => definition.capabilityId === 58);
  const weatherDefinition = strictWorldDefinition('weather');
  assert.ok(environmentObserved.some((milestone) => milestone.id === weatherDefinition.id
    && milestone.label.includes('发生')), 'natural weather may remain a pure world-complexity event');
  assert.ok(!environmentObserved.some((milestone) => milestone.id === naturalObservationDefinition.id), 'weather changing by itself is not a human observation');
  assert.ok(!environmentObserved.some((milestone) => milestone.capabilityId === 841), 'a hazard existing does not prove that a person identified it');

  process.stdout.write('capability milestone tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
