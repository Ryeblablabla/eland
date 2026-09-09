import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-native-speech-'));
try {
  const bundle = path.join(temporary, 'speech.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=native-speech-test.ts',
    `--outfile=${bundle}`, '--log-level=error',
  ], { input: `export { createInitialState } from './src/game/eland/simulation';
    export { compileMindSpeechIntent, speechIntentAllowsOption } from './src/game/eland/application/model-decision/speech-intent';
    export { compileNativeSpeechOperation } from './src/game/eland/application/native-speech';
    export { executePrimitiveAction, goalSatisfied } from './src/game/eland/domain/action-executor';
    export { advanceAgreementLifecycle, agreementsForPerson } from './src/game/eland/domain/agreement';
    export { compileAgreementContinuations } from './src/game/eland/application/agreement-continuation';
    export { Material } from './src/game/eland/domain/material';
    export { cellId, setVoxel } from './src/game/eland/world/grid';`, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [actor, other, third] = state.people;
  for (let x = 10; x <= 13; x += 1) for (let y = 10; y <= 13; y += 1) {
    for (let z = 0; z < state.world.grid.levels; z += 1) api.setVoxel(state.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
  }
  state.people.forEach((person) => { person.position = { ...person.position, cellId: api.cellId(11, 11), z: 1 }; person.conditions = []; });
  const context = (person) => ({ state, person, visibleCells: [person.position.cellId], visiblePeople: state.people.filter((candidate) => candidate.id !== person.id), visibleDrops: [], visibleAnimals: [], options: [], followUpOptions: [], decisionMonth: 1, planningTick: 1 });
  const handles = { actorId: actor.id, held: [], visible: [{ handle: 'p1', kind: 'person', personId: other.id }], voxels: [], agendas: [], suspendedIntents: [], memories: [], groundingFacts: [], speechReferences: [] };
  const mind = (speechIntent, utterance) => ({ speechIntent, utterance, delivery: 'call', sourceEventIds: [] });
  const offerSpeech = api.compileMindSpeechIntent({ kind: 'proposal', proposalKind: 'exchange', counterpartHandles: ['p1'], commitment: '用两份木材交换三份石料', terms: { expiresAtMonth: 4, offererMaterialKey: 'wood', offererQuantity: 2, partnerMaterialKey: 'stone', partnerQuantity: 3 } }, handles);
  assert.equal(offerSpeech.proposal.offererId, actor.id);
  assert.equal(offerSpeech.proposal.partnerId, other.id);
  assert.equal(offerSpeech.proposal.offererQuantity, 2);
  assert.equal(offerSpeech.proposal.partnerQuantity, 3);
  const renumberedHandles = { ...handles, visible: [{ handle: 'p1', kind: 'person', personId: third.id }] };
  const frozenAgain = api.compileMindSpeechIntent(offerSpeech, renumberedHandles, true);
  assert.deepEqual(frozenAgain.proposal, offerSpeech.proposal, 'bound terms keep exact parties when request handles change');
  const offerMind = mind(frozenAgain, '我愿意拿两份木材，换你的三份石料，你愿意吗？');
  const offer = api.compileNativeSpeechOperation(context(actor), offerMind, 'native:offer');
  assert(offer.ok, JSON.stringify(offer));
  assert.equal(offer.option.nextAction.kind, 'talk');
  assert.equal(offer.option.summary, `发言：${offerMind.utterance}`, 'a completed speech episode cannot masquerade as completed physical work');
  assert.equal(offer.option.nextAction.speakerMeaning.summary, offerMind.utterance, 'the action label never changes the actual words');
  assert.deepEqual(offer.option.nextAction.speakerMeaning.proposal, offerSpeech.proposal);
  const proposed = api.executePrimitiveAction(state, actor, offer.option.nextAction, 1, 1, { cause: 'intent', actionTick: 1 });
  state.world.past.push(proposed);
  const agreement = state.agreements.find((candidate) => candidate.id === offer.option.nextAction.speakerMeaning.id);
  assert(agreement, proposed.result);
  assert.equal(agreement.status, 'proposed');
  assert.deepEqual(agreement.acceptedByPersonIds, [actor.id], 'the author cannot manufacture the counterpart\'s consent');

  const replyHandles = { ...handles, actorId: other.id, visible: [{ handle: 'p1', kind: 'person', personId: actor.id }], speechReferences: [{ handle: 'agreement1', kind: 'agreement', id: agreement.id }] };
  const reply = api.compileMindSpeechIntent({ kind: 'accept', referenceHandle: 'agreement1' }, replyHandles);
  const acceptance = api.compileNativeSpeechOperation(context(other), mind(reply, '我同意这个交换。'), 'native:accept');
  assert(acceptance.ok);
  assert.equal(acceptance.option.nextAction.speakerMeaning.referenceId, agreement.id);
  const accepted = api.executePrimitiveAction(state, other, acceptance.option.nextAction, 1, 2, { cause: 'intent', actionTick: 2 });
  state.world.past.push(accepted);
  assert.equal(agreement.status, 'active', JSON.stringify({ accepted, agreement }));
  assert(agreement.acceptedByPersonIds.includes(other.id));
  const repeated = api.compileNativeSpeechOperation(context(other), mind(reply, '我同意这个交换。'), 'native:repeat');
  assert(repeated.ok && repeated.feedback, 'already-settled consent is not silently emitted again');
  assert.equal(repeated.option.nextAction.speakerMeaning.kind, 'claim');

  const missingSpeech = api.compileMindSpeechIntent({ kind: 'proposal', proposalKind: 'assist', counterpartHandles: ['p1'], commitment: '帮我扶住这根柱子' }, handles);
  const missing = api.compileNativeSpeechOperation(context(actor), mind(missingSpeech, '你能帮我扶住这根柱子吗？我会把绳子扎紧。'), 'native:missing');
  assert(missing.ok && missing.feedback);
  assert(missing.feedback.fields.includes('need'));
  assert.equal(missing.option.nextAction.speakerMeaning.kind, 'claim');
  assert.equal(missing.option.nextAction.speakerMeaning.proposal, undefined, 'a work request must not become the menu\'s default company agreement');
  const before = state.agreements.length;
  api.executePrimitiveAction(state, actor, missing.option.nextAction, 1, 3, { cause: 'intent', actionTick: 3 });
  assert.equal(state.agreements.length, before);
  assert(!api.speechIntentAllowsOption(missingSpeech, { communicationMeaning: { kind: 'request', proposal: { kind: 'assist', requesterId: actor.id, helperId: other.id, need: 'company', expiresAtMonth: 5 } }, semantics: { socialContext: { counterpartIds: [other.id] } } }), 'old menu route cannot add missing terms either');

  actor.knowledge.push({ id: 'knowledge:method', kind: 'claim', summary: '木条扎紧后不容易散开', confidence: 48, learnedAtMonth: 1, sourceEventIds: [proposed.id] });
  const knowledge = api.compileNativeSpeechOperation(context(actor), mind({ kind: 'share-knowledge', referenceId: 'knowledge:method' }, '我试过把木条扎紧，它们不容易散开。'), 'native:knowledge');
  const shared = api.executePrimitiveAction(state, actor, knowledge.option.nextAction, 1, 4, { cause: 'intent', actionTick: 4 });
  assert.equal(shared.action.kind, 'talk', 'knowledge sharing remains a top-level language action');
  assert.equal(shared.diff.offeredKnowledge.id, 'knowledge:method');
  assert(other.knowledge.some((fact) => fact.sourceEventIds.includes(shared.id) && fact.kind === 'claim'), 'listener hears a claim rather than receiving verified knowledge');

  const forecastSpeech = api.compileMindSpeechIntent({ kind: 'prediction', terms: { targetEpoch: 'chaotic', predictedStartMonth: 8, toleranceMonths: 2, expiresAtMonth: 10 } }, handles);
  const forecast = api.compileNativeSpeechOperation(context(actor), mind(forecastSpeech, '我估计第八个月左右会进入乱纪元。'), 'native:prediction');
  api.executePrimitiveAction(state, actor, forecast.option.nextAction, 1, 5, { cause: 'intent', actionTick: 5 });
  assert(state.eraPredictions.some((prediction) => prediction.id === 'native:prediction:representation' && prediction.predictedStartMonth === 8));

  const companionSpeech = api.compileMindSpeechIntent({ kind: 'proposal', proposalKind: 'companion', counterpartHandles: ['p1'], commitment: '在河边共同生活', terms: { expiresAtMonth: 5, anchorHandle: 'v1', anchorRadius: 2 } }, { ...handles, voxels: [{ handle: 'v1', position: { x: 12, y: 12, z: 1 } }] });
  const companion = api.compileNativeSpeechOperation(context(actor), mind(companionSpeech, '我想和你在河边住下来。'), 'native:companion');
  api.executePrimitiveAction(state, actor, companion.option.nextAction, 1, 6, { cause: 'intent', actionTick: 6 });
  const companionship = state.agreements.find((candidate) => candidate.id === 'native:companion:representation');
  assert.deepEqual(companionship.proposal.sharedLivingAnchor, companionSpeech.proposal.sharedLivingAnchor, 'the agreement preserves the place actually proposed');

  const continuedContext = { ...context(actor), continuingPlan: { sourceDecisionEventId: 'decision:origin' }, currentMonthEvents: [{ ...shared, diff: { ...shared.diff, languageSourceEventId: 'decision:origin' } }] };
  assert.equal(api.compileNativeSpeechOperation(continuedContext, offerMind, 'native:duplicate-wave').ok, false, 'one frozen language wave cannot become repeated speech actions');
  // A joint invitation is a temporary shared matter, not companionship or a collective.
  function jointFixture({ distant = false, expiresAtMonth } = {}) {
    const jointState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
    const [firstInvitee, secondInvitee, proposer] = jointState.people;
    for (let x = 10; x <= 13; x += 1) for (let y = 10; y <= 13; y += 1) {
      for (let z = 0; z < jointState.world.grid.levels; z += 1) api.setVoxel(jointState.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
    }
    jointState.people.forEach((person) => { person.position = { ...person.position, cellId: api.cellId(11, 11), z: 1 }; person.conditions = []; });
    if (distant) secondInvitee.position.cellId = api.cellId(80, 80);
    const jointContext = (person) => ({ state: jointState, person, visibleCells: [person.position.cellId],
      visiblePeople: jointState.people.filter((candidate) => candidate.id !== person.id), visibleDrops: [], visibleAnimals: [], options: [], followUpOptions: [], decisionMonth: 1 });
    let sequence = 1;
    const say = (person, speech, words) => {
      const compiled = api.compileNativeSpeechOperation(jointContext(person), mind(speech, words), `joint:speech:${sequence}`);
      assert(compiled.ok, JSON.stringify(compiled));
      const event = api.executePrimitiveAction(jointState, person, compiled.option.nextAction, 1, sequence, { cause: 'intent', actionTick: sequence++ });
      jointState.world.past.push(event);
      return { compiled, event };
    };
    const invitation = { kind: 'joint-action', proposerId: proposer.id, inviteeIds: [firstInvitee.id, secondInvitee.id],
      summary: `${firstInvitee.name}和${secondInvitee.name}，我们一起摆弄这些黏土和石头，看看能做成什么。`,
      ...(expiresAtMonth !== undefined ? { expiresAtMonth } : {}) };
    const inventories = structuredClone(jointState.people.map((person) => person.inventory));
    const offered = say(proposer, { kind: 'proposal', proposalKind: 'joint-action', counterpartIds: invitation.inviteeIds,
      commitment: invitation.summary, proposal: invitation }, invitation.summary);
    const contract = jointState.agreements.find((candidate) => candidate.id === offered.event.action.speakerMeaning.id);
    assert(contract, offered.event.result);
    assert.equal(contract.status, 'proposed');
    assert.equal(contract.proposal.kind, 'joint-action');
    assert.equal(contract.acceptByMonth, expiresAtMonth);
    assert.equal(contract.dueAtMonth, undefined);
    assert.deepEqual(contract.acceptedByPersonIds, [proposer.id]);
    assert.deepEqual(jointState.people.map((person) => person.inventory), inventories, 'an invitation cannot transfer resources');
    assert.equal(jointState.collectives.length, 0);
    assert.equal(jointState.intents.length, 0);
    return { jointState, firstInvitee, secondInvitee, proposer, say, contract, jointContext };
  }
  const responseChecks = jointFixture();
  const responseRecorded = (person, response) => api.goalSatisfied(responseChecks.jointState, responseChecks.proposer, {
    kind: 'agreement-response-recorded', agreementId: responseChecks.contract.id, personId: person.id, response,
  });
  const agreementIs = (status) => api.goalSatisfied(responseChecks.jointState, responseChecks.proposer, {
    kind: 'agreement-status', agreementId: responseChecks.contract.id, status,
  });
  const beforeReadingResponses = structuredClone(responseChecks.contract);
  assert(agreementIs('proposed'));
  assert.equal(responseRecorded(responseChecks.firstInvitee, 'accepted'), false);
  assert.equal(responseRecorded(responseChecks.secondInvitee, 'rejected'), false);
  assert.deepEqual(responseChecks.contract, beforeReadingResponses, 'completion predicates only read facts and cannot create a response');
  const firstResponse = responseChecks.say(responseChecks.firstInvitee,
    { kind: 'accept', referenceId: responseChecks.contract.id }, '我愿意参加这次尝试。');
  assert.equal(firstResponse.event.status, 'completed');
  assert(responseRecorded(responseChecks.firstInvitee, 'accepted'));
  assert.equal(responseRecorded(responseChecks.secondInvitee, 'accepted'), false);
  assert(agreementIs('proposed'));
  assert.equal(agreementIs('active'), false, 'one actual acceptance cannot stand in for the other participant\'s decision');
  const secondResponse = responseChecks.say(responseChecks.secondInvitee,
    { kind: 'reject', referenceId: responseChecks.contract.id }, '我不参加这次尝试。');
  assert.equal(secondResponse.event.status, 'completed');
  assert(responseRecorded(responseChecks.secondInvitee, 'rejected'));
  assert(responseRecorded(responseChecks.firstInvitee, 'accepted'), 'the actual earlier acceptance remains historical evidence');
  assert(agreementIs('rejected'));
  assert.equal(agreementIs('active'), false);
  assert.equal(api.goalSatisfied(responseChecks.jointState, responseChecks.proposer,
    { kind: 'agreement-status', agreementId: 'not-an-agreement', status: 'active' }), false);
  assert.equal(api.goalSatisfied(responseChecks.jointState, responseChecks.proposer,
    { kind: 'agreement-response-recorded', agreementId: 'not-an-agreement', personId: responseChecks.firstInvitee.id, response: 'accepted' }), false);

  const joint = jointFixture();
  const initialMove = api.executePrimitiveAction(joint.jointState, joint.proposer, {
    kind: 'move', toCellId: api.cellId(12, 11), toZ: 1,
  }, 1, 20, { cause: 'intent', actionTick: 20 });
  assert.equal(initialMove.status, 'completed', 'pending invitations do not block independent physical work');
  assert.equal(joint.contract.status, 'proposed');
  joint.say(joint.firstInvitee, { kind: 'reject', referenceId: joint.contract.id }, '我先处理自己的事情，这次不参加。');
  assert.equal(joint.contract.status, 'proposed', 'one refusal does not erase the independent response of another invitee');
  assert.deepEqual(joint.contract.rejectedByPersonIds, [joint.firstInvitee.id]);
  joint.say(joint.secondInvitee, { kind: 'accept', referenceId: joint.contract.id }, '我愿意一起试试看。');
  assert.equal(joint.contract.status, 'rejected');
  assert(joint.contract.acceptedByPersonIds.includes(joint.secondInvitee.id));
  assert.equal(joint.jointState.collectives.length, 0);

  const acceptedJoint = jointFixture();
  for (const invitee of [acceptedJoint.firstInvitee, acceptedJoint.secondInvitee]) {
    acceptedJoint.say(invitee, { kind: 'accept', referenceId: acceptedJoint.contract.id }, '我愿意一起动手试试。');
  }
  assert.equal(acceptedJoint.contract.status, 'active');
  assert.equal(acceptedJoint.contract.dueAtMonth, undefined, 'there is no invented four- or six-month fulfillment window');
  assert.deepEqual(api.compileAgreementContinuations(acceptedJoint.jointState, acceptedJoint.contract.id, 1), [], 'assent does not assign any character an action');
  api.advanceAgreementLifecycle(acceptedJoint.jointState, 120);
  assert.equal(acceptedJoint.contract.status, 'active', 'time alone neither fulfills nor breaches an undated joint matter');
  assert.equal(acceptedJoint.contract.fulfillmentEventIds.length, 0);
  acceptedJoint.say(acceptedJoint.firstInvitee, { kind: 'end-agreement', referenceId: acceptedJoint.contract.id }, '我现在退出这次共同尝试。');
  assert.equal(acceptedJoint.contract.status, 'cancelled', 'an accepted member can explicitly end this particular joint commitment');
  assert.equal(acceptedJoint.contract.acceptedByPersonIds.length, 3, 'the historical individual assents remain recorded');
  assert(api.goalSatisfied(acceptedJoint.jointState, acceptedJoint.proposer, { kind: 'agreement-response-recorded',
    agreementId: acceptedJoint.contract.id, personId: acceptedJoint.firstInvitee.id, response: 'accepted' }));
  assert.equal(api.goalSatisfied(acceptedJoint.jointState, acceptedJoint.proposer, { kind: 'agreement-status',
    agreementId: acceptedJoint.contract.id, status: 'active' }), false, 'an old acceptance is not current active authorization after cancellation');

  const pendingJoint = jointFixture();
  pendingJoint.say(pendingJoint.proposer, { kind: 'end-agreement', referenceId: pendingJoint.contract.id }, '先撤回刚才的邀请。');
  assert.equal(pendingJoint.contract.status, 'cancelled', 'the proposer can withdraw an unanswered invitation');

  const partlyHeard = jointFixture({ distant: true });
  assert(api.agreementsForPerson(partlyHeard.jointState, partlyHeard.firstInvitee.id).some((agreement) => agreement.id === partlyHeard.contract.id));
  assert(!api.agreementsForPerson(partlyHeard.jointState, partlyHeard.secondInvitee.id).some((agreement) => agreement.id === partlyHeard.contract.id), 'naming a distant person does not give them knowledge of an invitation');
  partlyHeard.say(partlyHeard.firstInvitee, { kind: 'accept', referenceId: partlyHeard.contract.id }, '我愿意一起做。');
  assert(partlyHeard.contract.acceptedByPersonIds.includes(partlyHeard.firstInvitee.id));
  assert.equal(partlyHeard.contract.status, 'proposed');
  console.log('native speech: explicit terms, independent consent, sourced knowledge, prediction, missing-term fallback and one language wave verified');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
