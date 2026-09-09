import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-context-'));
const simulationBundle = path.join(temporaryDirectory, 'simulation.mjs');
const decisionContextBundle = path.join(temporaryDirectory, 'decision-context.mjs');
const gatewayBundle = path.join(temporaryDirectory, 'model-decision-gateway.mjs');
const schemaBundle = path.join(temporaryDirectory, 'model-decision-schema.mjs');
const semanticContextBundle = path.join(temporaryDirectory, 'semantic-context.mjs');
const modelReviewBundle = path.join(temporaryDirectory, 'model-review.mjs');
const intentExecutionBundle = path.join(temporaryDirectory, 'intent-execution.mjs');
const personMindBundle = path.join(temporaryDirectory, 'person-mind.mjs');
const spokenMeaningBundle = path.join(temporaryDirectory, 'spoken-meaning.mjs');
const speechIntentBundle = path.join(temporaryDirectory, 'speech-intent.mjs');
const capabilityHandlesBundle = path.join(temporaryDirectory, 'capability-handles.mjs');
const staticSceneBundle = path.join(temporaryDirectory, 'static-scene.mjs');
const esbuild = path.resolve('node_modules/.bin/esbuild');

function bundle(entry, outfile) {
  execFileSync(esbuild, [
    entry,
    '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`,
  ], { stdio: 'pipe' });
}

function collectKeys(value, result = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  Object.entries(value).forEach(([key, item]) => {
    result.add(key);
    collectKeys(item, result);
  });
  return result;
}

try {
  bundle('src/game/eland/simulation.ts', simulationBundle);
  bundle('src/game/eland/application/model-decision/decision-context.ts', decisionContextBundle);
  bundle('server/model-decision-gateway.ts', gatewayBundle);
  bundle('server/model-decision-json-schema.ts', schemaBundle);
  bundle('src/game/eland/application/model-decision/mental-act-context.ts', semanticContextBundle);
  bundle('src/game/eland/application/simulation/model-review.ts', modelReviewBundle);
  bundle('src/game/eland/application/simulation/intent-execution.ts', intentExecutionBundle);
  bundle('src/game/eland/domain/person-mind.ts', personMindBundle);
  bundle('src/game/eland/domain/spoken-meaning.ts', spokenMeaningBundle);
  bundle('src/game/eland/application/model-decision/speech-intent.ts', speechIntentBundle);
  bundle('src/game/eland/application/model-decision/capability-handles.ts', capabilityHandlesBundle);
  execFileSync(esbuild, ['--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=static-scene-test.ts', `--outfile=${staticSceneBundle}`],
    { stdio: 'pipe', input: `export { recordVisibleStaticPlaceDiscoveries } from './src/game/eland/application/static-scene-awareness';
      export { executePlanningTick } from './src/game/eland/application/simulation/month-execution';` });

  const simulation = await import(`${pathToFileURL(simulationBundle).href}?test=${Date.now()}`);
  const decisionContext = await import(`${pathToFileURL(decisionContextBundle).href}?test=${Date.now()}`);
  const gateway = await import(`${pathToFileURL(gatewayBundle).href}?test=${Date.now()}`);
  const schemas = await import(`${pathToFileURL(schemaBundle).href}?test=${Date.now()}`);
  const semanticContext = await import(`${pathToFileURL(semanticContextBundle).href}?test=${Date.now()}`);
  const modelReview = await import(`${pathToFileURL(modelReviewBundle).href}?test=${Date.now()}`);
  const intentExecution = await import(`${pathToFileURL(intentExecutionBundle).href}?test=${Date.now()}`);
  const personMind = await import(`${pathToFileURL(personMindBundle).href}?test=${Date.now()}`);
  const spokenMeaning = await import(`${pathToFileURL(spokenMeaningBundle).href}?test=${Date.now()}`);
  const speechIntent = await import(`${pathToFileURL(speechIntentBundle).href}?test=${Date.now()}`);
  const capabilityHandles = await import(pathToFileURL(capabilityHandlesBundle).href);
  const staticScene = await import(pathToFileURL(staticSceneBundle).href);
  {
    const initialScene = simulation.createInitialState(31, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
    const observer = initialScene.people.find((person) => person.id === 'jingwei');
    const atFruit = (position) => position.x === 27 && position.y === 26 && position.z === 5;
    const beforeContext = simulation.buildDecisionContexts(initialScene, 1).find((context) => context.person.id === observer.id);
    const beforeRequest = decisionContext.buildDecisionRequestContext(beforeContext);
    assert(beforeRequest.visibleVoxels.some((surface) => atFruit(surface.position) && surface.name === '结果灌木'));
    assert.equal(observer.knownPlaces.length, 0, 'reading a visible model context must not mutate spatial memory');
    const preparedScene = simulation.preparePlayerEmbodimentMonth({ state: initialScene, controlledPersonId: observer.id,
      modelOwned: true, climate: { epoch: 'stable', kind: 'temperate', severity: 0 } });
    const execution = preparedScene.execution;
    const staged = execution.prepared.state;
    const stagedObserver = staged.people.find((person) => person.id === observer.id);
    const rememberedFruit = stagedObserver.knownPlaces.find((place) => atFruit(place.position));
    assert(rememberedFruit, 'the actual initial perception must become a sourced personal place at the month boundary');
    const discovery = execution.prepared.events.find((event) => event.id === rememberedFruit.sourceEventIds[0]);
    assert.equal(discovery.who, observer.id);
    assert.equal(discovery.planningTick, 0);
    assert.equal(discovery.atMonth, 1);
    assert(discovery.diff.observations.some((surface) => atFruit(surface.position) && surface.name === '结果灌木'));
    const personalDiscoveries = execution.prepared.events.filter((event) => event.kind === 'environment'
      && event.who === observer.id && event.diff.staticPlaceObservation);
    assert(personalDiscoveries.length > 1);
    assert(personalDiscoveries.every((event) => event.diff.observations.length === 1),
      'distinct places have independent source facts so existing memory compaction cannot collapse them as one experience');
    assert.equal(stagedObserver.knowledge.length, observer.knowledge.length, 'seeing a location grants no technique or learned physical rule');
    assert.equal(stagedObserver.knownPlaces.some((place) => place.position.x === 27 && place.position.y === 26 && place.position.z === 4), false,
      'the material hidden below the displayed fruit surface is not observed');
    const unseenOther = simulation.buildDecisionContexts(staged, 1).find((context) => context.person.id !== observer.id
      && !decisionContext.buildDecisionRequestContext(context).visibleVoxels.some((surface) => atFruit(surface.position)));
    assert(unseenOther);
    assert.equal(unseenOther.person.knownPlaces.some((place) => atFruit(place.position)), false, 'another person does not inherit this sighting');
    assert.deepEqual(staticScene.recordVisibleStaticPlaceDiscoveries(staged, 1, 1, execution.prepared.events), [],
      'the unchanged displayed surfaces do not create another discovery');
    const moved = staticScene.executePlanningTick(execution, () => ({ kind: 'direct-action',
      action: { kind: 'move', toCellId: 19 + 26 * staged.world.grid.width, toZ: 5 } }));
    assert(moved.controlApplied);
    assert.equal(stagedObserver.position.cellId, 19 + 26 * staged.world.grid.width);
    const afterContext = simulation.buildDecisionContexts(staged, 1).find((context) => context.person.id === observer.id);
    const afterRequest = decisionContext.buildDecisionRequestContext({ ...afterContext, currentMonthEvents: execution.prepared.events });
    assert.equal(afterRequest.visibleVoxels.some((surface) => atFruit(surface.position)), false, 'the old fruit location is now outside actual sight');
    assert(stagedObserver.knownPlaces.some((place) => atFruit(place.position) && place.lastConfirmedAtMonth === 1
      && place.sourceEventIds.includes(discovery.id)));
    const rememberedProtocol = gateway.buildDecisionModelRequestProtocol(afterRequest);
    const rememberedHandle = rememberedProtocol.handles.voxels.find((voxel) => atFruit(voxel.position));
    assert(rememberedHandle, 'the observer can address a remembered location without declaring its current contents');
    const rememberedSurface = rememberedProtocol.mindContext.visible.surfaces.find((surface) => surface.ref === rememberedHandle.handle);
    assert.equal(rememberedSurface.name, '本人可指认的位置');
    assert.equal(rememberedSurface.perceivedAs, '');
    const recalledPlaces = Object.values(rememberedProtocol.mindContext.mind).flat()
      .filter((entry) => entry.includes('记得在位置'));
    assert(recalledPlaces.length > 1, 'independent observed places remain available to the existing bounded memory projection');
    assert(recalledPlaces.every((entry) => /位置（\d+, \d+, \d+）.*最后在第1月确认.*仍需亲自确认/.test(entry)),
      'a selected place memory carries its coordinates, observation time, and need to recheck');
    assert.equal(observer.knownPlaces.length, 0, 'all observations and movement stay on the staged copy');
  }
  const state = simulation.createInitialState(9_732, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  assert.equal(state.people.length, 3, 'a new civilization should begin with exactly three founders');
  const founder = state.people[0];
  const visibleAnimal = state.world.animals[0];
  assert(founder && visibleAnimal, 'visible-animal model context regression requires a founder and animal');
  visibleAnimal.position = { ...founder.position };
  state.world.animalBonds = [{
    animalId: visibleAnimal.id,
    personId: founder.id,
    trust: 50,
    contacts: 4,
    lastContactAtMonth: 0,
    sourceEventIds: ['animal-bond-test'],
  }];
  const context = simulation.buildDecisionContexts(state, 1)[0];
  assert(context, 'model context test requires a living person');
  const projected = decisionContext.buildDecisionRequestContext(context);
  const unestablishedProjectIds = new Set([...context.options, ...context.followUpOptions]
    .flatMap((option) => option.projectProposal && !state.projects.some((project) => project.id === option.projectProposal.id)
      ? [option.projectProposal.id] : []));
  assert(unestablishedProjectIds.size > 0, 'the founding context must exercise actual rule-planner project proposals');
  assert.equal(projected.knownProjects.some((project) => unestablishedProjectIds.has(project.id)), false);
  assert.equal(projected.nativeOperations.some(({ request }) => unestablishedProjectIds.has(request.projectId)
    || unestablishedProjectIds.has(request.references?.projectId)
    || request.goal?.kind === 'project-completed' && unestablishedProjectIds.has(request.goal.projectId)), false,
  'unselected templates and their default project goals must not become known native methods');
  const unestablishedOptionIds = new Set([...context.options, ...context.followUpOptions]
    .filter((option) => unestablishedProjectIds.has(option.projectProposal?.id)).map((option) => option.id));
  assert.equal([...projected.options, ...projected.followUpOptions].some((option) => unestablishedOptionIds.has(option.id)), false);
  assert.deepEqual(projected.visibleDrops.map((drop) => drop.id), context.visibleDrops.map((drop) => drop.id),
    'removing unselected project templates must not remove real visible materials');
  const establishedState = simulation.createInitialState(17, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const establishingContext = simulation.buildDecisionContexts(establishedState, 1)[0];
  const selectedProject = establishingContext.options.find((option) => option.projectProposal);
  assert(selectedProject);
  const establishingEvents = [];
  intentExecution.commitDecision(establishedState, establishingContext.person, establishingContext,
    { kind: 'start', optionId: selectedProject.id, reason: '本人明确选定这一项目' }, false, 1, establishingEvents, 1);
  const establishedContext = simulation.buildDecisionContexts(establishedState, 1)
    .find((candidate) => candidate.person.id === establishingContext.person.id);
  const establishedProjection = decisionContext.buildDecisionRequestContext(establishedContext);
  assert(establishedProjection.knownProjects.some((project) => project.id === selectedProject.projectProposal.id),
    'a project actually established by a person remains available for continuation');
  assert.equal(projected.visibleAnimals.find((animal) => animal.id === visibleAnimal.id)?.bondTrust, 50,
    'the decision projection should carry person-specific animal trust without exposing authoritative state');
  projected.options = projected.options.map((option) => ({
    ...option,
    experiencedOutcomes: {
      similarAction: {
        attempts: 3, completed: 1, progressed: 1, blocked: 1, failed: 0, lastUpdatedAtMonth: 0,
      },
      intendedGoal: {
        attempts: 2, achieved: 1, attemptedUnmet: 1, lastUpdatedAtMonth: 0,
      },
    },
  }));

  const protocol = gateway.buildDecisionModelRequestProtocol(projected, {
    characterAgendaProposal: false,
  });
  const identityContext = structuredClone(projected);
  identityContext.options = []; identityContext.followUpOptions = []; identityContext.nativeOperations = [];
  for (const field of ['visibleDrops', 'visiblePeople', 'visibleAnimals', 'visibleContainers', 'visibleWorks', 'visibleRemains']) {
    identityContext[field] = [1, 2].map((number) => ({ id: `${field}-${number}`, cellId: number,
      position: { x: number, y: 2, z: 1 } }));
  }
  identityContext.person.inventory = [1, 2].map((number) => ({ stackId: `own-stack-${number}` }));
  identityContext.visiblePossessions = [1, 2].map((number) => ({ personId: 'other-holder', stackId: `other-stack-${number}` }));
  identityContext.visibleVoxels = [1, 2].map((x) => ({ position: { x, y: 2, z: 1 } }));
  const indexWorldHandles = (map) => new Map([
    ...map.held.map((item) => [JSON.stringify({ kind: 'inventory-stack', personId: map.actorId, stackId: item.stackId }), item.handle]),
    ...map.visible.map(({ handle, ...target }) => [JSON.stringify(target), handle]),
    ...map.voxels.map(({ handle, position }) => [JSON.stringify({ kind: 'voxel', position }), handle]),
  ]);
  const originalHandles = capabilityHandles.buildDecisionProbeHandleMap(identityContext);
  const originalIdentities = indexWorldHandles(originalHandles);
  const reorderedIdentity = JSON.parse(JSON.stringify(identityContext));
  for (const field of ['visibleDrops', 'visiblePeople', 'visibleAnimals', 'visibleContainers', 'visibleWorks', 'visibleRemains']) {
    reorderedIdentity[field].reverse().forEach((item) => { item.cellId += 100; item.position.x += 10; });
    reorderedIdentity[field].unshift({ id: `${field}-new`, cellId: 3, position: { x: 3, y: 2, z: 1 } });
  }
  reorderedIdentity.person.inventory.reverse().unshift({ stackId: 'new-own-stack' });
  reorderedIdentity.visiblePossessions.reverse().unshift({ personId: 'new-holder', stackId: 'new-other-stack' });
  reorderedIdentity.visibleVoxels.reverse().unshift({ position: { x: 3, y: 2, z: 1 } });
  const reorderedHandles = capabilityHandles.buildDecisionProbeHandleMap(reorderedIdentity);
  const reorderedIdentities = indexWorldHandles(reorderedHandles);
  for (const [identity, handle] of originalIdentities) {
    assert.equal(reorderedIdentities.get(identity), handle, `position/order/new objects cannot rename ${identity}`);
    assert(handle.length <= 24, 'stable object names fit the existing protocol without truncation');
  }
  assert.deepEqual(indexWorldHandles(capabilityHandles.buildDecisionProbeHandleMap(JSON.parse(JSON.stringify(identityContext)))),
    originalIdentities, 'rebuilding from serialized state needs no process-local handle allocation');
  const vanished = identityContext.visibleDrops[0].id;
  const vanishedHandle = originalHandles.visible.find((item) => item.kind === 'drop' && item.dropId === vanished).handle;
  reorderedIdentity.visibleDrops = reorderedIdentity.visibleDrops.filter((item) => item.id !== vanished);
  const withoutVanished = capabilityHandles.buildDecisionProbeHandleMap(reorderedIdentity);
  assert(!withoutVanished.visible.some((item) => item.handle === vanishedHandle), 'a vanished object reference cannot silently address its replacement');
  const observingInventory = { ...identityContext, person: { ...identityContext.person, id: 'another-observer', inventory: [] },
    visiblePossessions: [{ personId: identityContext.person.id, stackId: 'own-stack-1' }] };
  assert.equal(capabilityHandles.buildDecisionProbeHandleMap(observingInventory).visible.find((item) => item.kind === 'inventory-stack').handle,
    originalHandles.held[0].handle, 'the same actual possession has one reference regardless of observer ownership');
  const request = protocol.requestContext;
  const mindRequest = protocol.mindContext;
  assert.equal(request.schemaVersion, 'mental-act-context-v5');
  assert.equal(mindRequest.schemaVersion, 'mind-intention-context-v7');
  for (const reason of ['heard-language', 'experienced-outcome']) {
    const reconsideration = { reason, sourceEventIds: [`new-input:${reason}`] };
    const reconsidered = decisionContext.buildDecisionRequestContext({ ...context, reconsideration });
    const reconsideredMind = gateway.buildDecisionModelRequestProtocol(reconsidered).mindContext;
    assert.equal(reconsideredMind.current.reconsideration.reason, reason,
      'Mind must know which actual input caused this opportunity to reconsider');
    assert.deepEqual(reconsideredMind.current.reconsideration.sourceEventIds, reconsideration.sourceEventIds,
      'the reconsideration source must survive projection without becoming a requested reply');
  }
  const observation = {
    id: 'context-observed-grass', kind: 'action', atMonth: 1, actionTick: 2,
    who: context.person.id, cause: 'intent', status: 'completed',
    action: { kind: 'attend', target: { kind: 'voxel', position: { x: 20, y: 21, z: 4 } } },
    fromCellId: context.person.position.cellId, toCellId: context.person.position.cellId,
    fromZ: context.person.position.z, toZ: context.person.position.z,
    pathSegment: [], result: '观察并辨认了草', diff: {},
  };
  const afterObservation = decisionContext.buildDecisionRequestContext({
    ...context, currentMonthEvents: [observation],
    continuingPlan: {
      sourceIntentId: 'context-social-intent', sourceDecisionEventId: 'context-original-decision',
      mentalAct: {
        version: 'mental-act-v2', kind: 'talk', utterance: '我想听听你的意见。', delivery: 'normal',
        goal: '与对方商量共同生活', orientation: 'social', horizon: 'ongoing', strategy: '询问对方',
        assumptions: [], sourceEventIds: [],
      },
      plan: { version: 'mental-plan-translation-v1', disposition: 'act', steps: ['询问对方的意见'] },
      outcomeReceipts: [{
        version: 'intent-outcome-receipt-v1', atMonth: 1, actionEventId: observation.id,
        execution: 'performed', goalProgress: 'achieved', evidence: 'novel', sourceEventIds: [observation.id],
        planAssessment: { step: 'unverified', goal: 'unverified', satisfiedConditionIds: [], changedConditionIds: [] },
      }],
    },
  });
  const recentAction = gateway.buildDecisionModelRequestProtocol(afterObservation)
    .requestContext.current.planContinuation.recentActions[0];
  assert.deepEqual(recentAction, {
    atMonth: 1, operation: 'attend', target: observation.action.target, actualResult: observation.result,
    localGoalProgress: 'achieved', overallGoalAssessment: 'unverified',
  }, 'a completed local material observation must not be presented as progress on the larger social goal');
  const visibleOwner = protocol.handles.visible.find((item) => item.kind === 'person');
  const meaningReview = { sufficiency: 'insufficient', reason: '持物与位置不能单独证明原目标已经实现' };
  const reviewedCompletion = {
    step: { description: '确认当前准备情况', conditions: [], meaningReview: { sufficiency: 'unverified', reason: '尚无步骤判据' } },
    goal: { description: '原先尚未完成的目标', meaningReview, conditions: [
      { kind: 'fact', predicate: { kind: 'inventory-at-least', personId: visibleOwner.personId, materialId: context.person.inventory[0].materialId, quantity: 2 } },
      { kind: 'fact', predicate: { kind: 'knowledge', factId: 'review-known-fact', minConfidence: 40 } },
      { kind: 'fact', predicate: { kind: 'sheltered' } },
      { kind: 'near-target', target: { kind: 'person', personId: 'unseen-review-person' }, maxDistance: 1 },
    ] },
  };
  const reviewedRequest = decisionContext.buildDecisionRequestContext({ ...context, activeIntent: {
    id: 'reviewed-active-work', ownerId: context.person.id, summary: '继续原目标', domain: 'strategic',
    goal: { kind: 'knowledge', factId: 'review-known-fact' }, nextAction: observation.action,
    status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0, sourceFactIds: [], actionEventIds: [], replanCount: 0,
    plan: { version: 'mental-plan-translation-v1', disposition: 'act', steps: ['继续准备'], completion: reviewedCompletion },
  } });
  reviewedRequest.person.knowledge.push({ id: 'review-known-fact', kind: 'observation', summary: '本人已知的观察', confidence: 40 });
  reviewedRequest.activeIntent.recentOutcomes = [{
    atMonth: 1, execution: 'performed', goalProgress: 'achieved', evidence: 'none',
    operation: 'attend', actualResult: '看见地面木材有十一份，尚未施力', overallGoalAssessment: 'satisfied',
  }];
  const reviewedProtocol = gateway.buildDecisionModelRequestProtocol(reviewedRequest);
  const projectedCheck = reviewedProtocol.requestContext.current.recentCompletionReviews[0].completion.goal;
  assert.deepEqual(projectedCheck.meaningReview, meaningReview, 'independent review must survive active-work projection');
  assert.equal(projectedCheck.conditions[0].ownerHandle, visibleOwner.handle, 'inventory ownership must not silently become self');
  assert.equal(projectedCheck.conditions[1].ownerHandle, 'self');
  assert(projectedCheck.conditions[1].knowledgeHandle, 'known fact identity must remain interpretable');
  assert.equal(projectedCheck.conditions[2].ownerHandle, 'self', 'sheltered concerns the actual actor position');
  assert.equal(projectedCheck.conditions[3].targetHandle, undefined);
  assert(projectedCheck.conditions[3].targetHandleVisibility, 'a lost reference must be marked unknown, not rebound');
  assert.equal(reviewedProtocol.mindContext.current.recentCompletionReviews, undefined,
    'compiler sufficiency judgments must not become the actor\'s perceived experience');
  assert.deepEqual(reviewedProtocol.mindContext.current.recentOutcomes, [{
    when: '第 1 月', execution: 'performed', operation: 'attend', actualResult: '看见地面木材有十一份，尚未施力',
  }], 'Mind receives the real observation without treating a model-certified goal as a world fact');
  assert.equal(reviewedProtocol.requestContext.current.activeWork.recentOutcomes[0].overallGoalAssessment, 'satisfied',
    'the original review remains available to Plan for audit and correction');
  const invitedPeople = protocol.handles.visible.filter((item) => item.kind === 'person').slice(0, 2);
  const jointInput = { kind: 'proposal', proposalKind: 'joint-action', counterpartHandles: invitedPeople.map((person) => person.handle),
    commitment: '十分钟内建好一座城，并长期共同生活' };
  const jointUtterance = '我们一起去水边看看。';
  const jointSpeech = speechIntent.compileMindSpeechIntent(jointInput, protocol.handles, false, context.person.id, jointUtterance);
  assert.deepEqual(jointSpeech.proposal, { kind: 'joint-action', proposerId: context.person.id,
    inviteeIds: invitedPeople.map((person) => person.personId), summary: jointUtterance });
  assert.equal(jointSpeech.proposal.expiresAtMonth, undefined, 'unspoken ten-minute metadata must not become an invented deadline');
  assert.equal(speechIntent.compileMindSpeechIntent(jointInput, protocol.handles).proposal, undefined,
    'a direct call without an utterance cannot invent a proposal summary from commitment');
  const directJoint = speechIntent.compileMindSpeechIntent({ ...jointInput, terms: { summary: '一起检查现有材料' } }, protocol.handles);
  assert.equal(directJoint.proposal.summary, '一起检查现有材料');
  assert.deepEqual(speechIntent.compileMindSpeechIntent(jointSpeech, protocol.handles, true).proposal, jointSpeech.proposal);
  const jointRequest = { ...projected, agreements: [{
    id: 'joint-no-deadline', kind: 'joint-action', status: 'proposed', proposal: jointSpeech.proposal,
    proposer: { id: context.person.id, name: context.person.name },
    parties: [context.person, ...context.visiblePeople].filter((person, index, all) => all.findIndex((other) => other.id === person.id) === index)
      .map((person) => ({ id: person.id, name: person.name })),
    partyIds: [context.person.id, ...jointSpeech.proposal.inviteeIds], requiredResponderIds: jointSpeech.proposal.inviteeIds,
    acceptedByPersonIds: [context.person.id], rejectedByPersonIds: [], fulfilledByPersonIds: [],
    proposedAtMonth: 1, proposalEventId: 'joint-source', sourceFacts: [], pendingResponderNames: ['同伴'],
  }] };
  const jointProtocol = gateway.buildDecisionModelRequestProtocol(jointRequest);
  const jointView = jointProtocol.mindContext.current.agreements[0];
  assert.deepEqual({ replyBy: jointView.replyBy, participantCount: jointView.participantCount,
    acceptedCount: jointView.acceptedCount, rejectedCount: jointView.rejectedCount,
    electorate: jointView.electorate, support: jointView.support, opposition: jointView.opposition,
    due: jointView.due, ownState: jointView.ownState }, {
    replyBy: undefined, participantCount: jointRequest.agreements[0].partyIds.length,
    acceptedCount: 1, rejectedCount: 0, electorate: undefined, support: undefined, opposition: undefined,
    due: undefined, ownState: '本人已明确接受本次邀请',
  }, 'an undated temporary invitation shows individual responses, not an election or an assigned duty');
  assert.match(jointView.consequence, /未指定回应期限，不会因时间流逝自动过期.*没有默认履约期限或自动违约.*接受或一次动作不会自动标记事项完成/);
  const jointReference = jointProtocol.mindContext.speechReferences.find((reference) => reference.kind === 'agreement');
  assert.equal(jointReference.replyDeadline, '未指定');
  assert.equal(jointReference.acceptByMonth, undefined);
  const linkedDeclaration = gateway.buildDecisionModelRequestProtocol({ ...jointRequest,
    agreements: [{ ...jointRequest.agreements[0], sourceFacts: [{ eventId: 'joint-source',
      languageSourceEventId: 'joint-decision-wave', atMonth: 1,
      speaker: { id: context.person.id, name: context.person.name }, utterance: '一起查看材料', perception: 'self-authored' }] }],
    recentDialogue: [
      { month: 1, planningTick: 1, speaker: context.person.name, sourceEventId: 'joint-decision-wave', text: '一起查看材料' },
      { month: 1, planningTick: 2, speaker: context.person.name, sourceEventId: 'another-wave', text: '一起查看材料' },
    ],
  });
  assert.deepEqual(linkedDeclaration.mindContext.recentDialogue[0].declarationReferences, [jointReference.ref]);
  assert.equal(linkedDeclaration.mindContext.recentDialogue[1].declarationReferences, undefined,
    'identical wording from a different wave cannot inherit another declaration');
  const canonicalAuthor = context.visiblePeople[0];
  const manyAgreements = Array.from({ length: 34 }, (_, index) => {
    const utterance = `这是第${index}次邀请：我们一起整理木材。`;
    const sourceEventId = `canonical-invitation-source-${index}`;
    return { ...jointRequest.agreements[0], id: `canonical-invitation-${index}`,
      status: index < 29 ? 'proposed' : 'expired',
      proposer: { id: canonicalAuthor.id, name: canonicalAuthor.name },
      proposal: { ...jointSpeech.proposal, proposerId: canonicalAuthor.id, summary: utterance },
      acceptedByPersonIds: [canonicalAuthor.id], proposalEventId: sourceEventId,
      sourceFacts: [{ eventId: sourceEventId, atMonth: 1, speaker: { id: canonicalAuthor.id, name: canonicalAuthor.name },
        utterance: index % 2 ? utterance.replace('木材', '木…') : utterance, perception: 'heard' }],
    };
  });
  const factsBeforeProjection = JSON.stringify(manyAgreements);
  const canonicalProtocol = gateway.buildDecisionModelRequestProtocol({ ...projected, agreements: manyAgreements });
  const canonicalReferences = canonicalProtocol.mindContext.speechReferences.filter((reference) => reference.kind === 'agreement');
  assert.equal(canonicalReferences.length, 34, 'every real matter keeps its own response reference, including expired matters');
  assert.equal(canonicalProtocol.mindContext.current.agreements.length, 34);
  for (const [index, reference] of canonicalReferences.entries()) {
    const original = manyAgreements[index];
    const personal = canonicalProtocol.mindContext.current.agreements.find((item) => item.ref === reference.ref);
    assert(personal, 'each current status resolves to exactly one canonical matter');
    assert.equal(personal.proposal, undefined);
    assert.equal(personal.sourceFacts, undefined);
    assert.deepEqual(reference.sourceFacts, original.sourceFacts, 'the personally heard evidence is retained verbatim');
    assert.equal(reference.proposal.summarySourceEventId, index % 2 ? undefined : original.proposalEventId);
    assert.equal(reference.proposal.summary, index % 2 ? original.proposal.summary : undefined,
      'only exact matching text is replaced with a source reference; damaged hearing is not filled in');
    assert.equal(reference.acceptedBySelf, false);
    assert.equal(reference.state, index < 29 ? '等待回应' : '已经过期');
  }
  assert.equal(JSON.stringify(manyAgreements), factsBeforeProjection, 'projection never mutates the authoritative proposal or source');
  const proposalState = structuredClone(state);
  const [recipient, proposer, outsider] = proposalState.people;
  const proposalEvents = [];
  proposalState.agreements = Array.from({ length: 8 }, (_, index) => {
    const id = `pending-proposal-${index}`;
    const sourceEventId = `heard-proposal-${index}`;
    const proposal = index === 7 ? {
      kind: 'companion', proposerId: proposer.id, partnerId: recipient.id, expiresAtMonth: 6,
      basis: { sourceFactIds: ['private-author-reflection'] },
    } : {
      kind: 'assist', requesterId: proposer.id, helperId: recipient.id, need: 'water', expiresAtMonth: 6,
    };
    const utterance = `这是我提出的第${index}项具体事项，等待你自己的决定。`;
    proposalEvents.push({
      ...observation, id: sourceEventId, who: proposer.id,
      action: { kind: 'talk', speakerMeaning: { id, kind: 'request', summary: utterance, proposal } },
      result: '把提议说出了声',
      diff: { languageBroadcast: {
        version: 'language-broadcast-v2', sourceEventId, text: utterance,
        receptions: [{ listenerId: recipient.id, intelligibility: 1, detected: true, decoded: true }],
        perceivedByPersonIds: [recipient.id], decodedByPersonIds: [recipient.id],
      } },
    });
    return {
      id, proposal, proposerId: proposer.id, responderId: recipient.id,
      partyIds: [proposer.id, recipient.id], requiredResponderIds: [recipient.id],
      acceptedByPersonIds: [proposer.id], rejectedByPersonIds: [], status: 'proposed',
      proposedAtMonth: 1, acceptByMonth: 6, proposalEventId: sourceEventId,
      fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0, sourceEventIds: [sourceEventId],
    };
  });
  proposalState.agreements.push({
    ...proposalState.agreements[0], id: 'other-peoples-proposal',
    partyIds: [proposer.id, outsider.id], requiredResponderIds: [outsider.id], responderId: outsider.id,
  });
  const proposalContext = simulation.buildDecisionContexts(proposalState, 1)
    .find((candidate) => candidate.person.id === recipient.id);
  const proposalRequest = decisionContext.buildDecisionRequestContext({ ...proposalContext, currentMonthEvents: proposalEvents });
  const proposalMind = gateway.buildDecisionModelRequestProtocol(proposalRequest).mindContext;
  const references = proposalMind.speechReferences.filter((reference) => reference.kind === 'agreement');
  assert.equal(references.length, 8, 'all current agreements must retain both a response handle and their concrete terms');
  assert.equal(proposalMind.current.agreements.length, 8, 'compact current context must not hide the fourth pending agreement');
  for (const reference of references) {
    const source = proposalEvents.find((event) => event.id === reference.proposalEventId);
    assert.deepEqual(reference.proposer, { id: proposer.id, name: proposer.name });
    assert.deepEqual(reference.parties.map((party) => party.name), [proposer.name, recipient.name]);
    assert.equal(reference.proposal.expiresAtMonth, 6);
    assert.equal(reference.sourceFacts[0].utterance, source.diff.languageBroadcast.text);
    assert.equal(reference.sourceFacts[0].perception, 'heard');
    assert.equal(reference.acceptedBySelf, false, 'showing proposal content must not manufacture agreement');
    const currentAgreement = proposalMind.current.agreements.find((agreement) => agreement.ref === reference.ref);
    assert.equal(currentAgreement.proposal, undefined, 'the current personal status links to one canonical matter');
    assert.equal(currentAgreement.sourceFacts, undefined, 'the same source utterance is not expanded twice');
  }
  assert.equal(JSON.stringify(proposalMind).includes('private-author-reflection'), false,
    'the recipient must not inherit the proposer\'s private relationship basis');
  assert.equal(proposalRequest.agreements.some((agreement) => agreement.id === 'other-peoples-proposal'), false,
    'unrelated parties\' agreements must not become the person\'s private context');
  const possessionState = structuredClone(state);
  const [viewer, nearbyOwner, distantOwner] = possessionState.people;
  nearbyOwner.position = { ...viewer.position };
  distantOwner.position = { ...viewer.position, cellId: viewer.position.cellId + 3 };
  nearbyOwner.inventory = Array.from({ length: 3 }, (_, index) => ({
    ...viewer.inventory[0], id: `nearby-possession-${index + 1}`, quantity: 10 + index,
    recordPayloadId: 'unread-private-record',
  }));
  distantOwner.inventory = [{ ...viewer.inventory[0], id: 'hidden-distant-possession', quantity: 99 }];
  const possessionContext = simulation.buildDecisionContexts(possessionState, 1)
    .find((candidate) => candidate.person.id === viewer.id);
  const possessionRequest = decisionContext.buildDecisionRequestContext(possessionContext);
  assert.equal(possessionRequest.visiblePossessions.length, 3,
    'all three close, physically perceptible carried objects must remain addressable');
  assert.equal(possessionRequest.visiblePossessions.some((item) => item.personId === distantOwner.id), false,
    'seeing a distant person must not reveal their inventory');
  const knownDelivery = { project: '已知的蓄水工程', requester: viewer.name, active: true, requestEventId: 'heard-delivery-request' };
  possessionRequest.visibleDrops[0].knownDelivery = knownDelivery;
  const possessionProtocol = gateway.buildDecisionModelRequestProtocol(possessionRequest);
  const thirdPossession = possessionProtocol.handles.visible.find((item) => item.kind === 'inventory-stack'
    && item.stackId === 'nearby-possession-3');
  assert(thirdPossession, 'the third carried object must have its own stable-owner handle');
  const perceivedPossession = possessionProtocol.mindContext.visible.nearbyObjects.find((item) => item.ref === thirdPossession.handle);
  assert.equal(perceivedPossession.owner.name, nearbyOwner.name);
  assert.equal(perceivedPossession.quantity, 12);
  assert.deepEqual(possessionProtocol.mindContext.visible.materialQuantity, decisionContext.MATERIAL_QUANTITY_SEMANTICS,
    'the same quantity interpretation applies to visible foreign stacks without exposing more inventory');
  assert.equal(JSON.stringify(possessionProtocol.mindContext).includes('unread-private-record'), false,
    'perceiving the carried object does not reveal its record payload');
  assert.deepEqual(possessionProtocol.mindContext.visible.nearbyObjects.find((item) => item.knownDelivery)?.knownDelivery,
    knownDelivery, 'personally known delivery context must survive projection as a social fact');
  const transferAction = { description: '尝试把眼前对方持有的一份物品移到自己手中', targetHandles: [thirdPossession.handle, 'self'] };
  const transferResolution = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '尝试转移物品，实际数量与对方反应由执行器结算',
    effects: [{ kind: 'transfer', targetHandle: thirdPossession.handle, destinationHandle: 'self', quantity: 9 }],
  }, transferAction, possessionProtocol);
  assert.deepEqual(transferResolution.probe.adjudication.effects, [{
    kind: 'transfer', target: { kind: 'inventory-stack', personId: nearbyOwner.id, stackId: 'nearby-possession-3' },
    destination: { kind: 'person', personId: viewer.id }, quantity: 9,
  }], 'open transfer must preserve the exact foreign source, destination and requested quantity');
  assert.equal(gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '直接消耗对方持物',
    effects: [{ kind: 'consume', targetHandle: thirdPossession.handle, quantity: 1 }],
  }, transferAction, possessionProtocol), undefined, 'consume cannot bypass a real transfer of another person\'s possessions');
  const transferEffects = schemas.buildWorldResolutionJsonSchema(possessionProtocol, transferAction).schema.oneOf.find((variant) => variant.properties.effects).properties.effects.items.oneOf;
  assert(transferEffects.find((effect) => effect.properties.kind.enum.includes('transfer'))
    .properties.targetHandle.enum.includes(thirdPossession.handle));
  assert.equal(transferEffects.some((effect) => effect.properties.kind.enum.includes('consume')
    && effect.properties.targetHandle.enum.includes(thirdPossession.handle)), false);
  assert.equal('experiment' in schemas.buildModelPlanJsonSchema(possessionProtocol).schema.properties, false,
    'semantic Plan no longer chooses a second experiment entrance');
  assert.ok(mindRequest.origin, 'a founder should receive one founding orientation on the first decision');
  assert.ok(mindRequest.origin.background.some((line) => line.includes('共同开始生活')),
    'the founding background should explain the shared arrival without prescribing an action');
  assert.equal('initialIntention' in mindRequest.origin, false,
    'the first intention belongs to Mind and must not be authored by a personality regex');
  assert.equal(mindRequest.origin.background.some((line) => /随身|物资/.test(line)), false,
    'current possessions must not be rewritten as the founder\'s original inventory');
  assert.equal(mindRequest.person.position.x, mindRequest.person.position.cellId % state.world.grid.width);
  assert.equal(mindRequest.person.position.y, Math.floor(mindRequest.person.position.cellId / state.world.grid.width));
  const experienceState = simulation.createInitialState(9732, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const [receiver, giver, stranger] = experienceState.people;
  const receivedStack = { ...giver.inventory[0], id: 'received-context-stack', quantity: 1 };
  receiver.inventory = [receivedStack];
  const transferEvent = (id, who, to, order, diff) => ({
    ...observation, id, who, atMonth: 1, orderInMonth: order, actionTick: order,
    action: { kind: 'transfer', from: { kind: 'person', personId: giver.id },
      to: { kind: 'person', personId: to }, materialId: receivedStack.materialId, quantity: 1, stackId: giver.inventory[0].id },
    status: 'completed', result: '一份物资实际改变了持有者', diff,
  });
  const resistedEvent = { ...transferEvent('experience-resisted', receiver.id, receiver.id, 20,
    { attempted: true, resistedBy: giver.id, witnessedBy: [receiver.id, giver.id] }),
    status: 'blocked', result: '对方实际阻止了取物' };
  const receivedEvent = transferEvent('experience-received', giver.id, receiver.id, 21,
    { quantity: 1, witnessedBy: [receiver.id, giver.id] });
  const unknownEvent = transferEvent('experience-hearsay-only', giver.id, stranger.id, 22,
    { quantity: 1, witnessedBy: [giver.id, stranger.id] });
  const witnessedEvent = transferEvent('experience-witnessed', giver.id, stranger.id, 23,
    { quantity: 1, witnessedBy: [giver.id, receiver.id, stranger.id] });
  const experienceEvents = [witnessedEvent, unknownEvent, receivedEvent, resistedEvent];
  receiver.memories = [witnessedEvent, unknownEvent, receivedEvent].map((event) => ({
    id: `memory:${event.id}`, kind: 'episode', importance: 70, createdAtMonth: 1, lastRecalledAtMonth: 1,
    personIds: [giver.id], sourceEventIds: [event.id],
    summary: event === receivedEvent ? '本人已经实际收到一份物资' : '已知这件事的简短经过',
  }));
  const experienceContext = simulation.buildDecisionContexts(experienceState, 1).find((entry) => entry.person.id === receiver.id);
  const experienceRequest = decisionContext.buildDecisionRequestContext({ ...experienceContext,
    planningTick: 24, currentMonthEvents: experienceEvents });
  const experienceProtocol = gateway.buildDecisionModelRequestProtocol(experienceRequest);
  const recentExperiences = experienceProtocol.mindContext.current.recentExperiences;
  assert.deepEqual(recentExperiences.map((entry) => entry.sourceEventId),
    [resistedEvent.id, receivedEvent.id, witnessedEvent.id],
    'real personal events are ordered by action order, not memory salience; hearsay does not become witnessing');
  assert.equal(recentExperiences[0].execution, 'attempted', 'real resistance is not an unstarted operation');
  assert.equal(recentExperiences[1].perspective, '本人收到');
  assert.equal(recentExperiences[1].actualResult, '本人已经实际收到一份物资');
  assert.equal(recentExperiences[1].actionTick, 21);
  assert.equal(recentExperiences[2].perspective, '本人目击');
  assert.equal(experienceProtocol.mindContext.visible.heldPossessions[0].quantity, 1);
  const strangerContext = simulation.buildDecisionContexts(experienceState, 1).find((entry) => entry.person.id === stranger.id);
  assert.equal(decisionContext.buildDecisionRequestContext({ ...strangerContext, planningTick: 24,
    currentMonthEvents: experienceEvents }).recentExperiences.some((entry) => entry.sourceEventId === receivedEvent.id), false,
    'another person does not receive the unseen transfer receipt');
  const experienceWorld = semanticContext.buildWorldAttemptRequestContext(experienceProtocol.requestContext,
    { goal: '处理自己已有物资', nextAttempt: '整理手中物资', utterance: '', delivery: 'normal' });
  assert.deepEqual(experienceWorld.current.recentActions, recentExperiences,
    'World and Mind share the same known results rather than disagreeing about whether a receipt occurred');
  const handedOut = { ...transferEvent('experience-handed-out', receiver.id, giver.id, 24, {}),
    action: { kind: 'transfer', from: { kind: 'person', personId: receiver.id },
      to: { kind: 'person', personId: giver.id }, materialId: receivedStack.materialId, quantity: 8 },
    diff: { quantity: 1, materialId: receivedStack.materialId,
      from: { kind: 'person', personId: receiver.id }, to: { kind: 'person', personId: giver.id } } };
  const ownTransferReceipt = decisionContext.buildDecisionRequestContext({ ...experienceContext,
    planningTick: 25, currentMonthEvents: [handedOut] }).recentExperiences.find((entry) => entry.sourceEventId === handedOut.id);
  assert(ownTransferReceipt.actualResult.includes(`× 1，从${receiver.name}的持物转移到${giver.name}的持物`),
    'one actually given portion must not read like a receipt of eight requested portions or an unspecified possession change');
  const unperformedTransfer = { ...handedOut, id: 'experience-transfer-not-started', status: 'blocked',
    result: '本次取物尚未开始', diff: {} };
  assert.equal(decisionContext.buildDecisionRequestContext({ ...experienceContext,
    planningTick: 25, currentMonthEvents: [unperformedTransfer] }).recentExperiences
      .find((entry) => entry.sourceEventId === unperformedTransfer.id).actualResult, unperformedTransfer.result,
    'a requested transfer is never narrated as a physical possession change');
  assert.match(mindRequest.personalityPreset.type, /^[IE][NS][FT][JP]$/u,
    'every person should receive one derived MBTI writing type');
  assert.equal('speechExamples' in mindRequest.personalityPreset, false,
    'content-bearing example lines must not seed a shared topic into every character voice');
  assert.ok(mindRequest.personalityPreset.speechTendency,
    'the Mind preset should retain abstract voice guidance without lexical imitation bait');
  for (const field of ['attention', 'responseTendency']) assert.equal(field in mindRequest.personalityPreset, false,
    'personality must not prescribe an action ordering through model-facing fields');
  const hungryPersona = structuredClone(projected);
  hungryPersona.person.body = { health: 92, hydration: 82, nutrition: 24 };
  hungryPersona.person.conditions = [];
  hungryPersona.person.capacities.cognition = 49;
  hungryPersona.person.capacities.communication = 44;
  hungryPersona.activePressures = [];
  const personaCapacities = structuredClone(hungryPersona.person.capacities);
  const personaWithOptions = (purpose) => gateway.buildDecisionModelRequestProtocol({ ...hungryPersona,
    options: hungryPersona.options.slice(0, 1).map((option) => ({ ...option,
      semantics: { ...option.semantics, purpose, needKinds: [purpose] } })),
  }, { characterAgendaProposal: false });
  const inquiryPersona = personaWithOptions('inquiry');
  const carePersona = personaWithOptions('care');
  assert.deepEqual(inquiryPersona.mindContext.person.character, carePersona.mindContext.person.character,
    'changing local action candidates cannot select a different personality reaction for the model');
  assert(inquiryPersona.mindContext.person.character.includes(hungryPersona.person.soul.innerVoice),
    'the stable personal self-description remains intact');
  assert(inquiryPersona.mindContext.personalityPreset.speechTendency);
  assert(inquiryPersona.mindContext.person.capabilities.every((text) => !text.startsWith('思考') && !text.startsWith('交流')),
    'random baseline cognition or communication values must not ask the model to roleplay weak reasoning');
  assert.match(inquiryPersona.mindContext.person.physicalState, /严重饥饿/);
  assert.equal(inquiryPersona.mindContext.person.lifeStage, mindRequest.person.lifeStage);
  assert.deepEqual(inquiryPersona.mindContext.situation.urgentPressures, [],
    'an empty extra-pressure list cannot assert that a severely hungry person has no urgent needs');
  assert.deepEqual(hungryPersona.person.capacities, personaCapacities, 'presentation does not raise any baseline capacity');
  const conciseWorld = semanticContext.buildWorldAttemptRequestContext(inquiryPersona.requestContext, {
    goal: '处理眼前材料', nextAttempt: '查看眼前的真实材料', utterance: '', delivery: 'normal',
  });
  assert.deepEqual(conciseWorld.actor.capabilities, inquiryPersona.mindContext.person.capabilities);
  assert.match(conciseWorld.actor.physicalState, /严重饥饿/);
  const founderTypes = simulation.buildDecisionContexts(state, 1).map((founderContext) => {
    const founderRequest = decisionContext.buildDecisionRequestContext(founderContext);
    return gateway.buildDecisionModelRequestProtocol(founderRequest, {
      characterAgendaProposal: false,
    }).mindContext.personalityPreset.type;
  });
  assert.ok(new Set(founderTypes).size > 1,
    'the same civilization should not receive one shared writing preset');
  const laterContext = simulation.buildDecisionContexts(state, 2)[0];
  const laterRequest = decisionContext.buildDecisionRequestContext(laterContext);
  assert.equal(gateway.buildDecisionModelRequestProtocol(laterRequest, {
    characterAgendaProposal: false,
  }).mindContext.origin, undefined, 'the founding orientation must not be injected after the first month');
  assert.deepEqual(Object.keys(request.mind), [
    'activeConcerns', 'recentEvidence', 'learnedConclusions', 'relatedRecall',
  ], 'mind should expose unresolved concerns, grounded evidence, learned conclusions, and focused recall');
  const feedbackPerson = state.people[0];
  feedbackPerson.characterAgenda = {
    version: 'character-agenda-v1',
    items: [
      {
        id: 'agenda-missing', basisKey: 'agenda-missing', aim: '弄清湿土能承受多少重量', theme: 'inquiry',
        importance: 70, horizonMonths: 12, targetAtMonth: 12, origin: 'model-proposal', status: 'incubating',
        createdAtMonth: 1, lastReviewedAtMonth: 1, sourceFactIds: ['fact-rain'], intentIds: [], projectIds: [],
        approaches: [{
          id: 'approach-missing', basisKey: 'approach-missing', summary: '蹲下摸泥并测试承重',
          disposition: 'missing-affordance', createdAtMonth: 1, lastConsideredAtMonth: 1,
          sourceFactIds: ['fact-rain'], attemptIntentIds: [], evaluations: [],
        }],
      },
      {
        id: 'agenda-refuted', basisKey: 'agenda-refuted', aim: '让两种食物结合产生变化', theme: 'inquiry',
        importance: 60, horizonMonths: 12, targetAtMonth: 12, origin: 'model-proposal', status: 'blocked',
        createdAtMonth: 1, lastReviewedAtMonth: 2, sourceFactIds: ['fact-food'], intentIds: [], projectIds: [],
        approaches: [{
          id: 'approach-refuted', basisKey: 'approach-refuted', summary: '把两种食物直接结合',
          disposition: 'contradicted-approach', createdAtMonth: 1, lastConsideredAtMonth: 2,
          sourceFactIds: ['fact-food'], attemptIntentIds: ['intent-food'], latestOutcome: 'refuted',
          evaluations: [{
            ordinal: 1, atMonth: 2, outcome: 'refuted', basisFactIds: ['fact-food'],
            evidenceFactIds: ['action-food'], note: '没有观察到物质变化',
          }],
        }],
      },
    ],
  };
  assert(state.memoryStore, 'focused recall test requires the initialized agent memory store');
  feedbackPerson.memories.push({
    id: 'recent-completed-work', kind: 'episode', summary: '亲手捡起了眼前的一份木材', importance: 38,
    createdAtMonth: 2, lastRecalledAtMonth: 2, personIds: [], sourceEventIds: ['recent-completed-work-event'],
  });
  state.memoryStore.items.push({
    id: 'agent-memory:focused-wet-soil', ownerId: feedbackPerson.id, lane: 'episodic',
    gist: '曾亲自检查湿土并留下了一条与当前承重疑问有关的观察', precision: 'general',
    confidence: 45, salience: 20, emotionalValence: 0, personIds: [], topicKeys: [],
    sourceEventIds: ['fact-rain'], sourceMemoryIds: [], unresolved: false,
    firstExperiencedAtMonth: 0, lastExperiencedAtMonth: 0, lastRecalledAtMonth: 0,
  });
  for (let index = 0; index < 8; index += 1) {
    state.memoryStore.items.push({
      id: `agent-memory:recent-distractor-${index}`, ownerId: feedbackPerson.id, lane: 'episodic',
      gist: `近期但与当前关切无关的观察 ${index}`, precision: 'specific',
      confidence: 90, salience: 90, emotionalValence: 0, personIds: [], topicKeys: [],
      sourceEventIds: [`fact-distractor-${index}`], sourceMemoryIds: [], unresolved: false,
      firstExperiencedAtMonth: 1, lastExperiencedAtMonth: 1, lastRecalledAtMonth: 1,
    });
  }
  const feedbackMarkdown = personMind.projectPersonMindMarkdown(state, feedbackPerson, 2);
  const feedbackProtocol = gateway.buildDecisionModelRequestProtocol({
    ...projected,
    person: { ...projected.person, mindMarkdown: feedbackMarkdown },
  }, { characterAgendaProposal: false });
  assert.ok(feedbackProtocol.mindContext.mind.activeConcerns.some((concern) => (
    concern.includes('状态：暂无可执行办法')
  )), 'Mind should receive a concise state for a concern without an executable approach');
  assert.ok(feedbackProtocol.mindContext.mind.activeConcerns.some((concern) => (
    concern.includes('状态：办法已否定')
  )), 'Mind should receive a concise state for a refuted approach');
  assert.ok(feedbackProtocol.mindContext.mind.relatedRecall.some((memory) => (
    memory.includes('与当前承重疑问有关的观察')
  )), 'a low-ranked long-term memory should be recalled separately when its source grounds the current concern');
  assert.ok(feedbackProtocol.mindContext.mind.recentEvidence.some((memory) => (
    memory.includes('亲手捡起了眼前的一份木材')
  )), 'a recent successful action should remain available as short-term lived evidence');
  assert.ok(feedbackProtocol.mindContext.mind.relatedRecall.length <= 4,
    'focused recall must not grow beyond its independent four-memory budget');
  const agedConcernRequest = decisionContext.buildDecisionRequestContext({ ...context, decisionMonth: 14 });
  const agedConcernProtocol = gateway.buildDecisionModelRequestProtocol(agedConcernRequest);
  const agedConcern = agedConcernProtocol.mindContext.current.concernHistory
    .find((concern) => concern.aim === '让两种食物结合产生变化');
  assert.equal(agedConcern.elapsedMonths, 13,
    'an old concern must retain its actual elapsed calendar time across model decisions');
  assert.equal(agedConcern.recentFeedback[0].note, '没有观察到物质变化',
    'the recent real feedback must accompany the old question instead of being lost in compact projection');
  assert.equal('approaches' in agedConcern, false, 'actual feedback survives without turning an old plan into a new action menu');
  const visiblePositions = agedConcernProtocol.requestContext.visible.surfaces;
  assert(visiblePositions.length >= agedConcernRequest.visibleVoxels.length,
    'different visible locations of the same material must not be deduplicated into one remote target');
  assert(visiblePositions.every((surface) => Number.isInteger(surface.position.cellId)
    && Number.isFinite(surface.relativePosition.horizontalDistance)),
  'Plan must see factual positions and relative distances for the visible surfaces it can name');

  const achievementState = simulation.createInitialState(9_732, {
    endpoint: { kind: 'months', value: 200 }, chaosIntensity: 0,
  });
  achievementState.clock.elapsedMonths = 200;
  const achievementPerson = achievementState.people[0];
  achievementPerson.cognition.needResolutionEpisodes = [
    {
      version: 'need-resolution-episode-v1', id: 'need-resolution:old-workshop',
      projectId: 'old-workshop', projectNeed: 'high-heat-capability', desiredFunction: 'high-heat-processing',
      basisKey: 'need-resolution:high-heat-capability:high-heat-processing', observedAtMonth: 40,
      observationKind: 'completion-action', triggerFactIds: [],
      outcomeEventIds: Array.from({ length: 16 }, (_, index) => `old-workshop-event-${index}`),
      sourceFactIds: Array.from({ length: 16 }, (_, index) => `old-workshop-event-${index}`),
    },
    {
      version: 'need-resolution-episode-v1', id: 'need-resolution:new-shelter',
      projectId: 'new-shelter', projectNeed: 'shelter-capacity', desiredFunction: 'weather-shelter',
      basisKey: 'need-resolution:shelter-capacity:weather-shelter', observedAtMonth: 120,
      observationKind: 'completion-action', triggerFactIds: [],
      outcomeEventIds: ['new-shelter-event'], sourceFactIds: ['new-shelter-event'],
    },
  ];
  achievementState.projects.push(
    {
      id: 'old-workshop', status: 'completed', summary: '建立一处能稳定高温加工的工地',
      ownerId: achievementPerson.id, contributorIds: [achievementPerson.id], beneficiaryIds: [achievementPerson.id],
    },
    {
      id: 'new-shelter', status: 'completed', summary: '为自己建成一处能进入并遮蔽天气的住所',
      ownerId: achievementPerson.id, contributorIds: [achievementPerson.id], beneficiaryIds: [achievementPerson.id],
    },
  );
  achievementPerson.memories.push({
    id: 'recent-shelter-primitive', kind: 'episode', summary: '加工并安装了最后一份住所材料',
    importance: 38, createdAtMonth: 120, lastRecalledAtMonth: 120,
    personIds: [], sourceEventIds: ['new-shelter-event'],
  });
  const achievementMarkdown = personMind.projectPersonMindMarkdown(
    achievementState,
    achievementPerson,
    achievementState.clock.elapsedMonths,
  );
  const achievementMind = personMind.compilePersonMindMarkdown(achievementMarkdown);
  assert.match(achievementMarkdown, /记得自己曾完成过：为自己建成一处能进入并遮蔽天气的住所/u,
    'a completed project should become a consolidated autobiographical conclusion instead of disappearing with its primitive actions');
  assert.ok(achievementMind.beliefs.some((memory) => (
    memory.topicKeys.includes('experience:need-resolution')
      && memory.sourceEventIds.includes('new-shelter-event')
  )), 'the recalled accomplishment must remain bound to the real project completion evidence');
  assert.equal('cognition' in request, false, 'the request must not carry a local cognition appraisal section');
  assert.ok(request.nativeOperations.length > 0, 'the World brief must retain native capability descriptors');
  assert.ok(request.availableSteps.every((step) => step.pastExperience?.some((line) => line.includes('亲历 3 次'))), 'steps should carry semantic outcome summaries');
  assert.ok(request.actionSpace.operations.length > 0, 'the request should describe executable operation meanings');
  assert.ok(Array.isArray(request.actionSpace.heldObjects), 'held objects should appear only in the semantic action space');
  assert.ok(Array.isArray(request.visible.nearbyObjects), 'nearby objects should appear in the semantic visible section');
  const quantitySemantics = decisionContext.MATERIAL_QUANTITY_SEMANTICS;
  const quantityPlan = semanticContext.buildModelPlanRequestContext(request, {
    utterance: '我先处理眼前的物料。', delivery: 'normal', goal: '处理物料',
  });
  assert.deepEqual([projected.materialQuantity, request.visible.materialQuantity,
    mindRequest.visible.materialQuantity, quantityPlan.visible.materialQuantity], Array(4).fill(quantitySemantics),
    'raw, World-facing, Mind and Plan views share one portion-count and per-portion property meaning');
  assert.match(quantitySemantics.transfer, /不是人物携带上限.*可明确选择其他份数/,
    'an example operation quantity must not become a carrying limit');
  assert.ok(request.visible.nearbyObjects.some((item) => (
    item.kind === '动物' && item.disposition === '对你放松，不再躲避'
  )), 'a visible bonded animal should compile into the model brief without reading missing authoritative state');
  assert.equal('nearbyObjects' in request.actionSpace, false, 'nearby objects must not be duplicated in actionSpace');
  assert.equal('inventory' in request.person, false, 'inventory must not be duplicated under person');
  assert.equal('possibleExperiments' in request, false, 'the old duplicate experiment projection should be removed');
  assert.equal('availableSteps' in mindRequest, false, 'Mind must not receive locally prepared action choices');
  assert.equal('continuations' in mindRequest, false, 'Mind must not receive execution continuations');
  for (const field of ['actionSpace', 'nativeOperations', 'nativeReferences', 'knownMethods', 'knownProjects', 'actionPossibilities']) {
    assert.equal(field in mindRequest, false, 'fresh Mind receives actual surroundings, not engine parameter menus');
  }
  assert(request.actionSpace.operations.some((operation) => operation.kind === 'assemble'),
    'the World-facing context still has the complete implemented assembly interface');
  assert.deepEqual(mindRequest.visible.heldPossessions, request.visible.heldPossessions);
  assert.deepEqual(mindRequest.speechReferences, request.speechReferences,
    'removing physical menus does not remove known speech meanings or social choices');
  const activeContext = {
    ...context,
    activeIntent: {
      id: 'intent-test', ownerId: context.person.id, summary: '完成眼前住所', domain: 'strategic',
      goal: { kind: 'project-completed', projectId: 'project-test' },
      nextAction: { kind: 'move', toCellId: context.person.position.cellId, toZ: context.person.position.z },
      status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0.64,
      sourceFactIds: [], actionEventIds: [], replanCount: 0,
    },
  };
  const activeRequest = decisionContext.buildDecisionRequestContext(activeContext);
  const activeProtocol = gateway.buildDecisionModelRequestProtocol(activeRequest, {
    characterAgendaProposal: false,
  });
  assert.deepEqual(activeProtocol.mindContext.current.bodyActivity,
    { hasCurrentWork: true, description: '完成眼前住所' });
  assert.equal('authoredPlan' in activeProtocol.mindContext.current, false,
    'fresh Mind does not receive the executor plan as an activity menu');
  assert.equal('activeWork' in activeProtocol.mindContext.current, false,
    'Mind must not receive executor progress or next-step state');
  assert.equal('activeProject' in activeProtocol.mindContext.current, false,
    'Mind must not receive project execution details');
  assert.ok(activeProtocol.requestContext.current.activeWork,
    'Plan must retain the current execution context');
  const nativeExample = request.nativeOperations.find((descriptor) => descriptor.request.kind === 'observe' && descriptor.request.targetHandle);
  assert(nativeExample, 'the semantic adapter test requires one grounded observation capability');
  const semanticStep = { kind: 'physical', description: nativeExample.summary, targetHandles: [nativeExample.request.targetHandle] };
  const nativeResolution = gateway.sanitizePlanAgentWorldVerdict({ nativeOperation: nativeExample.request }, semanticStep, protocol);
  assert(nativeResolution?.nativeOperation, 'the native descriptor must resolve to real domain arguments');
  const knownEntityHandles = new Set(['self', ...protocol.handles.visible.map((item) => item.handle),
    ...protocol.handles.held.map((item) => item.handle), ...protocol.handles.voxels.map((item) => item.handle)]);
  for (const descriptor of request.nativeOperations) {
    const parameters = descriptor.methodParameters ?? descriptor.request;
    const targets = [...new Set(Object.values(parameters).flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value) => typeof value === 'string' && knownEntityHandles.has(value)))];
    const compiled = gateway.sanitizePlanAgentWorldVerdict({ nativeOperation: descriptor.request },
      { description: descriptor.summary, targetHandles: targets.length ? targets : ['self'] }, protocol);
    assert(compiled?.nativeOperation, `a real native capability must survive its semantic projection: ${JSON.stringify(descriptor.request)}`);
  }
  const semanticPlanContext = semanticContext.buildModelPlanRequestContext(request, {
    utterance: '我想亲自看看眼前的东西。', delivery: 'normal', goal: '了解眼前对象',
  });
  for (const menu of ['availableSteps', 'continuations', 'nativeOperations']) assert.equal(menu in semanticPlanContext, false,
    'Plan receives capability meanings, not another numbered operation menu');
  assert.deepEqual(semanticPlanContext.person.position, request.person.position);
  assert.deepEqual(semanticPlanContext.situation, request.situation);
  assert.deepEqual(semanticPlanContext.knownMethods, request.knownMethods);
  assert.deepEqual(semanticPlanContext.speechReferences, request.speechReferences);
  const stagedDecision = gateway.normalizeMindPlanModelOutput(projected, {
    utterance: '我想亲自看看眼前的东西。', delivery: 'normal', goal: '了解眼前对象', orientation: 'inquiry', horizon: 'momentary',
  }, { steps: [nativeExample.summary], disposition: 'act', currentStep: semanticStep }, protocol, nativeResolution);
  assert.equal(stagedDecision?.nativeOperation?.kind, 'observe');
  assert.equal(stagedDecision.mentalAct.goal, '了解眼前对象');
  assert.equal(stagedDecision.mentalAct.nextAttempt, undefined, 'older direct intentions remain valid without inventing an actor choice');
  assert.equal(stagedDecision.mentalAct.attempt, undefined, 'older direct fixtures do not acquire an invented attempt mode');
  assert.equal(stagedDecision.mentalAct.strategy, semanticStep.description);
  const crossCategoryPlan = gateway.normalizeMindPlanModelOutput(projected, {
    utterance: 'I want to make something for the people here.', delivery: 'normal',
    goal: 'Create something useful together', orientation: 'social', horizon: 'ongoing',
  }, { steps: ['Inspect what I need before discussing the design'], disposition: 'act', currentStep: semanticStep }, protocol, nativeResolution);
  assert.equal(crossCategoryPlan?.nativeOperation?.kind, 'observe',
    'intermediate work must not be vetoed by direction categories or Chinese word overlap');
  const ordinaryStatement = {
    utterance: '我先把这里的木料摆正，再看看顶上还缺哪一块。', delivery: 'normal',
    goal: '把眼前的施工继续做下去', orientation: 'construction', horizon: 'ongoing', speechIntent: { kind: 'expression' },
  };
  assert.equal(gateway.normalizeMindPlanModelOutput(projected, ordinaryStatement, {
    steps: ['移动'], disposition: 'act', firstStepHandle: 'o1',
  }, protocol), null, 'the semantic Plan must reject a numeric menu selection instead of executing unrelated consent');
  const companionPartner = protocol.handles.visible.find((item) => item.kind === 'person');
  const companionSpeech = {
    kind: 'proposal', proposalKind: 'companion', commitment: '我愿意和你开始共同生活，想听你的决定。',
    counterpartHandles: [companionPartner.handle], terms: { expiresAtMonth: 6 },
  };
  const actualCompanion = gateway.normalizeMindPlanModelOutput(projected, {
    ...ordinaryStatement, utterance: 'I want to share my life with you. What do you think?', speechIntent: companionSpeech,
  }, { steps: ['提出本人愿意共同生活的想法'], disposition: 'act',
    currentStep: { kind: 'speech', description: '说出本次共同生活提议', targetHandles: [companionPartner.handle] } }, protocol,
  { nativeOperation: { kind: 'speech' }, feedback: '' });
  assert.equal(actualCompanion?.nativeOperation?.kind, 'speech', 'explicit social speech remains a native capability');
  assert.equal(actualCompanion.mentalAct.speechIntent.proposal.kind, 'companion');
  assert.deepEqual(actualCompanion.mentalAct.speechIntent.counterpartIds, [companionPartner.personId]);
  const takingVerdict = { nativeOperation: { kind: 'transfer', sourceHandle: companionPartner.handle,
    destinationHandle: 'self', materialKey: 'food', quantity: 1 } };
  const askingStep = { kind: 'speech', description: '请求对方展示食物', targetHandles: [companionPartner.handle] };
  assert.equal(gateway.sanitizePlanAgentWorldVerdict(takingVerdict, askingStep, protocol), undefined,
    'World cannot replace a person-selected request with that person taking the other\'s possessions');
  assert(gateway.sanitizePlanAgentWorldVerdict(takingVerdict,
    { ...askingStep, kind: 'physical', description: '自行伸手拿取对方的食物' }, protocol)?.nativeOperation,
  'explicitly choosing physical taking still reaches the native executor and its real resistance outcome');
  const agendaProtocol = gateway.buildDecisionModelRequestProtocol(projected, {
    characterAgendaProposal: true,
  });
  const preservedOngoingGoal = gateway.normalizeMindPlanModelOutput(
    projected,
    {
      utterance: '我想先听清楚眼前的人是否愿意和我继续交谈。', delivery: 'normal',
      goal: '听见对方自己的回答', orientation: 'social', horizon: 'ongoing',
    },
    { steps: ['眼前没有能真正听到回答的行动，先保留这个问题'], disposition: 'stay' },
    agendaProtocol,
  );
  assert.equal(preservedOngoingGoal?.kind, 'idle');
  assert.equal(preservedOngoingGoal?.characterAgendaUpdate?.kind, 'create',
    'an ongoing Mind goal should remain in the character agenda even when no matching action exists');
  const compilationState = simulation.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const compilationContext = simulation.buildDecisionContexts(compilationState, 1)[0];
  const compilationRequest = decisionContext.buildDecisionRequestContext(compilationContext);
  const compilationProtocol = gateway.buildDecisionModelRequestProtocol(compilationRequest, { characterAgendaProposal: true });
  const compilationMind = { utterance: '我想逐步弄清自己的身体变化。', delivery: 'normal',
    goal: '逐步弄清自己的身体变化', orientation: 'inquiry', horizon: 'ongoing' };
  const compilationPlan = { steps: ['查看自己的身体'], disposition: 'act',
    currentStep: { kind: 'physical', description: '查看自己的身体', targetHandles: ['self'] } };
  const unresolved = gateway.normalizeMindPlanModelOutput(compilationRequest, compilationMind, compilationPlan,
    compilationProtocol, { nativeOperation: { kind: 'observe', target: { kind: 'person', personId: compilationContext.person.id },
      references: { recordId: 'missing-record' } }, feedback: '' });
  const compilationFact = intentExecution.applyDecision(compilationState, compilationContext.person,
    compilationContext, unresolved, true, 1, 0, 1);
  compilationState.world.past.push(compilationFact);
  assert.equal(compilationFact.executionCompilation.status, 'unresolved');
  const correctedContext = simulation.buildDecisionContexts(compilationState, 1)[0];
  const correctedRequest = decisionContext.buildDecisionRequestContext({ ...correctedContext, currentMonthEvents: [compilationFact] });
  const correctedProtocol = gateway.buildDecisionModelRequestProtocol(correctedRequest, { characterAgendaProposal: true });
  assert.equal(correctedRequest.recentCompilationFeedback.filter((entry) => entry.eventId === compilationFact.id).length, 1,
    'a diagnostic appears once even when its source is present in persisted and current-month events');
  assert(!correctedContext.person.memories.some((memory) => memory.id.startsWith('memory:native-compilation')),
    'technical diagnostics are not autobiographical episodes');
  assert.equal(correctedProtocol.mindContext.current.compilationFeedback, undefined);
  assert(correctedProtocol.mindContext.current.pendingStep, 'Mind can know its chosen step has not started without receiving API diagnostics');
  const correctedResolution = { nativeOperation: { kind: 'observe', target: { kind: 'person', personId: correctedContext.person.id } }, feedback: '' };
  const duplicateTargetsPlan = { ...compilationPlan,
    currentStep: { ...compilationPlan.currentStep, targetHandles: ['self', 'self'] } };
  const duplicateTargetsDecision = gateway.normalizeMindPlanModelOutput(correctedRequest, compilationMind,
    duplicateTargetsPlan, correctedProtocol, correctedResolution);
  assert.equal(duplicateTargetsDecision?.nativeOperation.kind, 'observe');
  assert.equal(duplicateTargetsDecision.mentalAct.plan.currentStep.targets.length, 1);
  assert.deepEqual(duplicateTargetsPlan.currentStep.targetHandles, ['self', 'self'], 'raw model output stays auditable');
  assert.equal(gateway.normalizeMindPlanModelOutput(correctedRequest, compilationMind,
    { ...duplicateTargetsPlan, currentStep: { ...duplicateTargetsPlan.currentStep, targetHandles: ['self', 'missing-person'] } },
    correctedProtocol, correctedResolution), null, 'an unknown person cannot be silently removed or invented');
  const correctedMind = { ...compilationMind, goal: '比较今天和往后的身体变化' };
  const correctedDecision = gateway.normalizeMindPlanModelOutput(correctedRequest, correctedMind,
    { ...compilationPlan, feedback: { correction: '刚才没有找到可读记录', adjustment: '先直接查看自己的身体',
      sourceCompilationEventIds: [compilationFact.id] } }, correctedProtocol, correctedResolution);
  assert(correctedDecision?.mentalAct.planFeedback?.sourceEventIds.includes(compilationFact.id),
    'Plan can directly cite a real compilation failure without manufacturing personal memories or physical ActionFacts');
  const weakFeedback = gateway.normalizeMindPlanModelOutput(correctedRequest, compilationMind,
    { ...compilationPlan, feedback: { correction: '错误的附带引用', adjustment: '仍查看身体',
      sourceMemoryHandles: ['missing-memory'] } }, correctedProtocol, correctedResolution);
  assert.equal(weakFeedback?.nativeOperation.kind, 'observe', 'invalid optional feedback cannot erase an executable step');
  assert.equal(weakFeedback.mentalAct.planFeedback, undefined, 'unfounded feedback is not stored as evidence');
  const correctedFact = intentExecution.applyDecision(compilationState, correctedContext.person,
    correctedContext, correctedDecision, true, 1, 1, 2);
  assert.equal(correctedFact.executionCompilation.status, 'compiled');
  assert(!correctedContext.person.knowledge.some((fact) => fact.id === `plan-feedback:${correctedFact.id}`),
    'a proposed translation correction is not automatically learned world knowledge');
  assert(correctedContext.person.characterAgenda.items.some((item) => item.aim === correctedMind.goal),
    'an ongoing purpose survives native-operation conversion into a real started intent');
  const weakGoalPlan = { ...compilationPlan, completion: {
    step: { description: '查看身体', conditions: [] },
    goal: { description: '站在当前位置就算完成了', conditions: [{ kind: 'near-target', targetHandle: 'self', maxDistance: 0 }],
      meaningReview: { sufficiency: 'sufficient', reason: 'Plan不能为自己的判据认证' } },
  } };
  const uncheckedGoal = gateway.normalizeMindPlanModelOutput(correctedRequest, correctedMind,
    weakGoalPlan, correctedProtocol, correctedResolution);
  assert.equal(uncheckedGoal.mentalAct.plan.completion.goal.meaningReview.sufficiency, 'unverified',
    'missing World review keeps model-authored criteria unknown, even when Plan tries to certify them');
  assert.equal(uncheckedGoal.mentalAct.plan.completion.goal.description, correctedMind.goal,
    'a new Plan proposes criteria for the frozen Mind goal and cannot replace its description');
  assert.equal(weakGoalPlan.completion.goal.description, '站在当前位置就算完成了',
    'the raw provider proposal remains intact for audit');
  const insufficientWorld = gateway.sanitizePlanAgentWorldVerdict({
    nativeOperation: { kind: 'observe', targetHandle: 'self' },
    completionReview: { goal: { sufficiency: 'insufficient', reason: '本人所在位置不证明已经比较了身体变化' } },
  }, compilationPlan.currentStep, correctedProtocol);
  const independentlyReviewed = gateway.normalizeMindPlanModelOutput(correctedRequest, correctedMind,
    weakGoalPlan, correctedProtocol, insufficientWorld);
  assert.equal(independentlyReviewed.nativeOperation.kind, 'observe', 'an inadequate success criterion cannot block the actual attempt');
  assert.equal(independentlyReviewed.mentalAct.plan.completion.goal.meaningReview.sufficiency, 'insufficient');
  assert.equal(independentlyReviewed.mentalAct.goal, correctedMind.goal);
  assert.deepEqual(independentlyReviewed.mentalAct.plan.completion.goal.conditions,
    uncheckedGoal.mentalAct.plan.completion.goal.conditions, 'binding the original aim adds or changes no success conditions');
  const buildingState = simulation.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const buildingContext = simulation.buildDecisionContexts(buildingState, 1)[0];
  const buildingRequest = decisionContext.buildDecisionRequestContext(buildingContext);
  const buildingProtocol = gateway.buildDecisionModelRequestProtocol(buildingRequest, { characterAgendaProposal: false });
  const woodSource = buildingContext.visibleDrops.find((drop) => drop.materialId === 13);
  const woodDrop = buildingRequest.visibleDrops.find((drop) => drop.id === woodSource.id);
  const woodHandle = buildingProtocol.handles.visible.find((ref) => ref.kind === 'drop' && ref.dropId === woodDrop.id).handle;
  const woodPosition = buildingProtocol.handles.voxels.find((ref) => ref.position.x === woodDrop.cellId % buildingState.world.grid.width
    && ref.position.y === Math.floor(woodDrop.cellId / buildingState.world.grid.width)
    && [woodDrop.z, woodDrop.z - 1].includes(ref.position.z));
  assert(woodPosition, 'the real nearby material must have a public location or support surface');
  const focusedBuildingProtocol = { ...buildingProtocol, actorAttempt: {
    mode: 'act', targetHandles: [woodHandle], hasExplicitFocus: true, unavailableTargetCount: 0,
  } };
  const preparedPlacement = gateway.sanitizePlanAgentWorldVerdict({
    nativeOperation: { kind: 'walk-to', targetHandle: woodPosition.handle },
  }, { kind: 'physical', description: '先到本次明确选定的可见准备落点', targetHandles: [woodPosition.handle] }, focusedBuildingProtocol);
  assert.equal(preparedPlacement?.nativeOperation?.target.kind, 'voxel',
    'a valid actor-derived position explicitly selected by WorldStep is still an explicit movement target');
  const selectedHeld = buildingProtocol.handles.held[0].handle;
  const heldFocusProtocol = { ...buildingProtocol, actorAttempt: {
    mode: 'act', targetHandles: [selectedHeld], hasExplicitFocus: true, unavailableTargetCount: 0,
  } };
  assert.equal(gateway.sanitizePlanAgentWorldVerdict({ nativeOperation: { kind: 'observe', targetHandle: woodHandle } },
    { kind: 'physical', description: '偷换成另一份地面物', targetHandles: [woodHandle] }, heldFocusProtocol), undefined);
  assert.equal(gateway.sanitizePlanAgentWorldVerdict({ nativeOperation: { kind: 'observe', targetHandle: woodHandle } },
    { kind: 'physical', description: '仍点名本人持物', targetHandles: [selectedHeld] }, heldFocusProtocol), undefined,
    'an unrelated resolution reference cannot bypass the step or actor focus');
  const buildingStep = { kind: 'physical', description: '用这份木材做一个木垫块', targetHandles: [woodHandle] };
  const buildResolution = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '把一份真实木材做成一个垫块', effects: [
      { kind: 'consume', targetHandle: woodHandle, quantity: 1 },
      { kind: 'assemble', targetHandle: woodPosition.handle, arrangement: 'support', summary: '亲手放置的木垫块' },
    ],
  }, buildingStep, buildingProtocol);
  assert(buildResolution?.probe, 'a material-only Plan can ground assembly at its already-public position');
  assert(buildResolution.targetDerivations.some((entry) => entry.handle === woodPosition.handle));
  const buildingDecision = gateway.normalizeMindPlanModelOutput(buildingRequest, {
    utterance: '我把这一份木材放成一个垫块。', delivery: 'normal', goal: '做出一个木垫块',
    orientation: 'construction', horizon: 'momentary', speechIntent: { kind: 'expression' },
  }, { steps: ['用木材放置垫块'], disposition: 'act', currentStep: buildingStep }, buildingProtocol, buildResolution);
  const buildFact = intentExecution.applyDecision(buildingState, buildingContext.person, buildingContext,
    buildingDecision, true, 1, 0, 1);
  buildingState.world.past.push(buildFact);
  const buildEvents = [buildFact];
  for (let tick = 1; tick <= 4 && !buildingState.world.works?.length; tick++) {
    const action = intentExecution.executeActiveIntent(buildingState, buildingContext.person, 1, tick, tick, buildEvents);
    if (action) { buildEvents.push(action); buildingState.world.past.push(action); }
  }
  assert.equal(buildingState.world.works?.length, 1, JSON.stringify(buildEvents.map((event) => event.result)));
  assert.equal(buildingState.world.drops.find((drop) => drop.id === woodDrop.id).quantity, woodDrop.quantity - 1,
    'the derived position enables real assembly, without granting extra input materials');
  const buildingVisibleItem = buildingProtocol.handles.visible.find((ref) => ref.kind === 'inventory-stack');
  const buildingVisibleOwner = buildingProtocol.handles.visible.find((ref) => ref.kind === 'person' && ref.personId === buildingVisibleItem.personId);
  assert.equal(gateway.sanitizePlanAgentWorldVerdict({ nativeOperation: { kind: 'observe', targetHandle: buildingVisibleItem.handle } },
    { kind: 'physical', description: '看清对方可见的持物', targetHandles: [buildingVisibleOwner.handle] }, buildingProtocol)?.nativeOperation?.target.stackId,
  buildingVisibleItem.stackId, 'the gateway and native parser use the same public possession closure');
  const ballotMeaning = { id: 'ballot', kind: 'accept', referenceId: 'leader-vote' };
  assert.deepEqual(spokenMeaning.withSpokenUtterance('我投阿山一票。', ballotMeaning), {
    ...ballotMeaning, summary: '我投阿山一票。',
  }, 'a model-interpreted vote preserves its semantics without needing scripted agreement keywords');
  const teachingMeaning = {
    id: 'teaching', kind: 'claim', summary: '加工并安装木板', factId: 'technique:test',
  };
  assert.equal(spokenMeaning.withSpokenUtterance('Let me show you how I fitted these planks.', teachingMeaning).factId,
    'technique:test', 'speaker meaning must survive translation and ordinary paraphrase');

  const extendedInventory = Array.from({ length: 10 }, (_, index) => ({
    ...projected.person.inventory[index % projected.person.inventory.length],
    stackId: `full-inventory-stack-${index + 1}`,
    name: index === 8 ? '锡矿石' : index === 9 ? '木炭' : `普通物品${index + 1}`,
  }));
  extendedInventory[1] = { ...extendedInventory[0], stackId: extendedInventory[1].stackId,
    quantity: extendedInventory[0].quantity + 3 };
  const fullInventoryProjected = {
    ...projected,
    person: { ...projected.person, inventory: extendedInventory },
  };
  const fullInventoryProtocol = gateway.buildDecisionModelRequestProtocol(fullInventoryProjected, {
    characterAgendaProposal: false,
  });
  const firstHeldHandle = fullInventoryProtocol.handles.held.find((item) => item.stackId === 'full-inventory-stack-1').handle;
  const ninthHeldHandle = fullInventoryProtocol.handles.held.find((item) => item.stackId === 'full-inventory-stack-9').handle;
  const tenthHeldHandle = fullInventoryProtocol.handles.held.find((item) => item.stackId === 'full-inventory-stack-10').handle;
  assert.equal(fullInventoryProtocol.requestContext.actionSpace.heldObjects.length, 10,
    'every held entity must remain selectable instead of truncating the inventory at six or eight items');
  assert.ok(fullInventoryProtocol.mindContext.visible.heldPossessions.some((item) => item.name === '木炭'),
    'Mind must receive every actual held stack');
  assert.deepEqual(fullInventoryProtocol.mindContext.visible.heldPossessions,
    fullInventoryProtocol.requestContext.actionSpace.heldObjects,
    'Mind and Plan must refer to the same real held stacks with unchanged quantities and perceived attributes');
  const matchingPossessions = fullInventoryProtocol.mindContext.visible.heldPossessions
    .filter((item) => item.name === extendedInventory[0].name);
  assert.deepEqual(matchingPossessions.map((item) => ({ ref: item.ref, quantity: item.quantity })),
    extendedInventory.slice(0, 2).map((stack) => ({
      ref: fullInventoryProtocol.handles.held.find((item) => item.stackId === stack.stackId).handle,
      quantity: stack.quantity,
    })), 'equal names and appearances must not merge two distinct stacks or their quantities');
  assert.notEqual(matchingPossessions[0].ref, matchingPossessions[1].ref);
  const directExperiment = gateway.normalizeMindPlanModelOutput(
    fullInventoryProjected,
    {
      utterance: '锡矿和木炭都在手里，我就拿这两样试一次。',
      delivery: 'normal',
      goal: '看看锡矿和木炭接触后是否发生变化',
      orientation: 'inquiry',
      horizon: 'momentary',
    },
    {
      steps: ['把自己指定的锡矿石和木炭结合并观察'],
      disposition: 'act',
      currentStep: { kind: 'physical', description: '把指定的锡矿和木炭结合', targetHandles: [ninthHeldHandle, tenthHeldHandle] },
    },
    fullInventoryProtocol,
    gateway.sanitizePlanAgentWorldVerdict({ nativeOperation: { kind: 'act', operation: 'combine', targetHandles: [ninthHeldHandle, tenthHeldHandle] } },
      { description: '结合两份材料', targetHandles: [ninthHeldHandle, tenthHeldHandle] }, fullInventoryProtocol),
  );
  assert.equal(directExperiment?.kind, 'idle');
  assert.deepEqual(directExperiment?.nativeOperation, {
    kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: fullInventoryProjected.person.id, stackId: 'full-inventory-stack-9' },
      { kind: 'inventory-stack', personId: fullInventoryProjected.person.id, stackId: 'full-inventory-stack-10' },
    ],
  }, 'a semantic operation preserves the exact late-inventory entities');
  const visibleSurface = fullInventoryProtocol.requestContext.visible.surfaces[0];
  assert(visibleSurface, 'the movement probe test requires one visible surface');
  const movement = gateway.normalizeMindPlanModelOutput(
    fullInventoryProjected,
    {
      utterance: '我想离开这些材料，沿着眼前的地表走走。',
      delivery: 'normal',
      goal: '漫游并看看别处会出现什么',
      orientation: 'exploration',
      horizon: 'momentary',
    },
    {
      steps: ['走向自己看得见的位置，不预设那里存在产物或人物'],
      disposition: 'act',
      currentStep: { kind: 'physical', description: '走向自己看得见的位置', targetHandles: [visibleSurface.ref] },
    },
    fullInventoryProtocol,
    gateway.sanitizePlanAgentWorldVerdict({ nativeOperation: { kind: 'move', targetHandle: visibleSurface.ref } },
      { description: '走近位置', targetHandles: [visibleSurface.ref] }, fullInventoryProtocol),
  );
  assert.equal(movement?.nativeOperation?.kind, 'move',
    'a character must be able to choose visible movement without wrapping it in a production project');

  const targetMoveAction = { kind: 'physical', description: '走近眼前的位置', targetHandles: [visibleSurface.ref] };
  const targetMoveResolution = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '正在走近目标', effects: [{ kind: 'move-self', targetHandle: visibleSurface.ref, withinDistance: 2 }],
    completionReview: {
      step: { sufficiency: 'sufficient', reason: '到达一格内足以证明这一步的到达要求' },
      goal: { sufficiency: 'sufficient', reason: '实际到访一次正是本人这次的目标' },
    },
  }, targetMoveAction, fullInventoryProtocol);
  const exactArrival = gateway.normalizeMindPlanModelOutput(fullInventoryProjected, {
    ...ordinaryStatement, goal: '实际抵达一次眼前的位置',
  }, {
    steps: ['走到目标一格之内'], disposition: 'act', currentStep: targetMoveAction,
    completion: {
      step: { description: '抵达一步范围', conditions: [{ kind: 'reached-target', targetHandle: visibleSurface.ref, maxDistance: 1 }] },
      goal: { description: '已经到访该地', conditions: [{ kind: 'reached-target', targetHandle: visibleSurface.ref, maxDistance: 1 }] },
    },
  }, fullInventoryProtocol, targetMoveResolution);
  assert.equal(exactArrival?.executionProbe?.adjudication.effects[0].withinDistance, 1,
    'the executed movement must honor the stricter same-target completion distance');
  const physicalLayout = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '把木料组成两个实际相邻体素',
    effects: [{ kind: 'assemble', targetHandle: visibleSurface.ref, arrangement: 'support', summary: '自己命名的构件',
      layout: [{ offset: { x: 0, y: 0, z: 0 }, materialKey: 'wood' }, { offset: { x: 0, y: 0, z: 1 }, materialKey: 'wood' }] }],
  }, { description: '排布木料', targetHandles: [visibleSurface.ref] }, fullInventoryProtocol);
  assert.equal(physicalLayout?.probe?.adjudication.effects[0].layout?.version, 'work-layout-v1');
  assert.equal(physicalLayout?.probe?.adjudication.effects[0].layout?.voxels.length, 2,
    'model layout must survive as physical occupancy for the executor to settle');
  const worldAction = {
    kind: 'physical',
    description: '用指甲在自己手里的锡矿石表面划出一道浅痕，并亲手确认痕迹是否留下',
    targetHandles: [ninthHeldHandle],
    expectedResult: '锡矿石表面留下一道之后还能看见的浅痕',
  };
  const worldVerdict = {
    status: 'completed',
    result: '指甲没有改变锡矿石的形状，但表面留下了一道之后还能辨认的浅痕',
    effects: [
      { kind: 'knowledge', summary: '指甲无法改变锡矿石形状，但能在表面留下浅痕' },
      {
        kind: 'world-state', targetHandle: ninthHeldHandle, stateKey: 'surface-condition',
        stateValue: '有一道浅划痕', summary: '这块锡矿石表面留有一道浅划痕',
      },
    ],
  };
  const worldResolution = gateway.sanitizePlanAgentWorldVerdict(
    worldVerdict,
    worldAction,
    fullInventoryProtocol,
  );
  assert(worldResolution?.probe && worldResolution.probe.kind === 'world-interaction',
    'the Plan Agent must be able to adjudicate an unknown interaction without mapping it to a fixed verb');
  assert.deepEqual(worldResolution.probe.adjudication.targets, [{
    kind: 'inventory-stack',
    personId: fullInventoryProjected.person.id,
    stackId: 'full-inventory-stack-9',
  }], 'Plan Agent refs must resolve to the exact object selected by the character');
  const worldDecision = gateway.normalizeMindPlanModelOutput(
    fullInventoryProjected,
    {
      utterance: '我想在锡矿石表面划一道痕，看看它会不会留下来。',
      delivery: 'normal',
      goal: '确认手里的锡矿石表面能否留下可辨认的浅痕',
      orientation: 'inquiry',
      horizon: 'momentary',
    },
    { steps: ['平码并轻推确认'], disposition: 'act', currentStep: worldAction },
    fullInventoryProtocol,
    worldResolution,
  );
  assert.equal(worldDecision?.executionProbe?.kind, 'world-interaction',
    'an accepted Plan Agent verdict must enter the ordinary execution probe path');
  assert.deepEqual(worldDecision?.mentalAct?.plan?.steps, ['平码并轻推确认'],
    'the complete Plan translation must survive normalization instead of disappearing after its first action');
  assert.equal('verdict' in (worldDecision?.mentalAct?.plan?.currentStep ?? {}), false,
    'persisted character plans must contain expectations, never world-authored outcomes');
  assert.equal(modelReview.validateModelDecision(context, worldDecision)?.executionProbe?.kind, 'world-interaction',
    'the pre-commit model review must not strip an accepted Plan Agent action before Execution sees it');
  const selfAdjudicatedWorldDecision = gateway.normalizeMindPlanModelOutput(
    fullInventoryProjected,
    {
      utterance: '我想在锡矿石表面划一道痕，看看它会不会留下来。',
      delivery: 'normal', goal: '确认手里的锡矿石表面能否留下可辨认的浅痕',
      orientation: 'inquiry', horizon: 'momentary',
    },
    {
      steps: ['用指甲做一次局部划痕测试'], disposition: 'act',
      currentStep: worldAction, verdict: worldVerdict,
    },
    fullInventoryProtocol,
  );
  assert.equal(selfAdjudicatedWorldDecision?.executionProbe, undefined,
    'the character Plan must not be allowed to author or smuggle in its own world result');
  assert.equal(gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed',
    result: '锡矿石表面留下了一道浅痕',
    effects: [{ kind: 'world-state', summary: '锡矿石表面有一道浅痕' }],
  }, worldAction, fullInventoryProtocol), undefined,
  'open world state must bind an exact target and stable property instead of remaining unscoped prose');
  const auxiliaryMaterial = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed',
    result: '尝试使用本人另一份持物作为辅料',
    effects: [{ kind: 'consume', targetHandle: firstHeldHandle, quantity: 1 }],
  }, worldAction, fullInventoryProtocol);
  assert.equal(auxiliaryMaterial?.probe.adjudication.effects[0].target.stackId, 'full-inventory-stack-1',
    'World may explicitly choose another real actor-held input without a repeated Plan listing');
  assert(auxiliaryMaterial.targetDerivations.some((edge) => edge.handle === firstHeldHandle
    && edge.sourceHandle === 'self' && edge.relation === 'actor-possession'));
  const blockedWithoutFeedback = gateway.sanitizePlanAgentWorldVerdict({
    status: 'blocked', result: '徒手无法让坚硬石块弯曲', effects: [],
  }, worldAction, fullInventoryProtocol);
  assert.equal(blockedWithoutFeedback, undefined,
    'a failed or blocked unknown action must not discard the correction that the person needs');
  const blockedWithFeedback = gateway.sanitizePlanAgentWorldVerdict({
    status: 'blocked',
    result: '徒手无法让坚硬石块弯曲',
    feedback: {
      correction: '手的力量不足以让这种坚硬物体弯曲',
      adjustment: '若仍需改变形状，应寻找能施加更大力量的工具或换用较软材料',
    },
  }, worldAction, fullInventoryProtocol);
  assert.match(blockedWithFeedback?.probe?.adjudication.feedback?.adjustment ?? '', /工具|较软材料/u,
    'the Plan Agent must carry a concrete next adjustment into the executable failure fact');
  const visibleDropForRelocation = fullInventoryProtocol.requestContext.visible.nearbyObjects
    .find((item) => item.kind === '地面物品');
  assert(visibleDropForRelocation, 'relocation test requires one visible ground object');
  const relocateAction = {
    description: `把${visibleDropForRelocation.name}搬到眼前另一处地表`,
    targetHandles: [visibleDropForRelocation.ref, visibleSurface.ref],
    expectedResult: '该物件真实出现在指定地表旁',
  };
  const relocateResolution = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed',
    result: `把${visibleDropForRelocation.name}搬到了指定地表旁`,
    effects: [{
      kind: 'relocate', targetHandle: visibleDropForRelocation.ref,
      destinationHandle: visibleSurface.ref, quantity: 1,
    }],
  }, relocateAction, fullInventoryProtocol);
  assert.equal(relocateResolution?.probe?.adjudication.effects[0]?.kind, 'relocate',
    'moving an existing object must compile to a conserving relocation effect');
  const plantingProtocol = fullInventoryProtocol;
  const plantingSurface = visibleSurface;
  const plantingAction = {
    description: '把手里的种子播进眼前土壤',
    targetHandles: [firstHeldHandle, plantingSurface.ref],
    expectedResult: '种子进入土壤并成为可继续生长的幼苗',
  };
  const unnamedAssembly = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '搭成了一个叫作风声琴的小棚，放在了身旁',
    effects: [
      { kind: 'consume', targetHandle: firstHeldHandle, quantity: 1 },
      { kind: 'assemble', targetHandle: visibleSurface.ref, arrangement: 'lash', summary: '风声琴' },
    ],
  }, { description: '把材料连接成风声琴', targetHandles: [firstHeldHandle, visibleSurface.ref] }, fullInventoryProtocol);
  assert.equal(unnamedAssembly?.probe?.adjudication.effects[1]?.kind, 'assemble',
    'an independently adjudicated new facility must not require a catalog name, Chinese construction keyword or extra relocation effect');
  const materializedPlanting = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '种子已经播入土壤，形成了作物幼苗',
    effects: [
      { kind: 'consume', targetHandle: firstHeldHandle, quantity: 1 },
      { kind: 'replace-voxel', targetHandle: plantingSurface.ref, materialKey: 'crop_sprout' },
    ],
  }, plantingAction, plantingProtocol);
  assert.equal(materializedPlanting?.probe?.adjudication.effects[1]?.kind, 'replace-voxel',
    'planting must materialize a crop voxel so ordinary monthly growth owns later evolution');

  const relationshipState = simulation.createInitialState(27_104, {
    endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0,
  });
  relationshipState.clock.elapsedMonths = 2;
  const relationshipObserver = relationshipState.people[0];
  const relationshipOther = relationshipState.people[1];
  relationshipOther.position = { ...relationshipObserver.position };
  const relationshipSource = {
    id: 'relationship-appraisal-source', kind: 'environment', atMonth: 2, orderInMonth: 0,
    cellId: relationshipObserver.position.cellId, change: 'relationship',
    result: `${relationshipOther.name}在共同劳动时留下帮助${relationshipObserver.name}`,
    diff: { participantIds: [relationshipObserver.id, relationshipOther.id], sourceEventIds: [] },
  };
  relationshipState.world.past.push(relationshipSource);
  relationshipObserver.memories.unshift({
    id: 'relationship-appraisal-memory', kind: 'relationship',
    summary: relationshipSource.result, importance: 72, createdAtMonth: 2, lastRecalledAtMonth: 2,
    personIds: [relationshipOther.id], sourceEventIds: [relationshipSource.id],
  });
  relationshipState.memoryStore.items.unshift({
    id: 'agent-memory:relationship-appraisal', ownerId: relationshipObserver.id, lane: 'social',
    gist: relationshipSource.result, precision: 'specific', confidence: 80, salience: 80,
    emotionalValence: 0.35, personIds: [relationshipOther.id], topicKeys: ['relationship'],
    sourceEventIds: [relationshipSource.id], sourceMemoryIds: ['relationship-appraisal-memory'],
    unresolved: true, firstExperiencedAtMonth: 2, lastExperiencedAtMonth: 2, lastRecalledAtMonth: 2,
  });
  const relationshipContext = simulation.buildDecisionContexts(relationshipState, 2)
    .find((candidate) => candidate.person.id === relationshipObserver.id);
  assert(relationshipContext, 'relationship appraisal test requires an observer decision context');
  const relationshipProjected = decisionContext.buildDecisionRequestContext(relationshipContext);
  const relationshipProtocol = gateway.buildDecisionModelRequestProtocol(relationshipProjected, {
    characterAgendaProposal: false,
  });
  const relationshipPersonHandle = relationshipProtocol.handles.visible.find((item) => (
    item.kind === 'person' && item.personId === relationshipOther.id
  ))?.handle;
  const relationshipMemoryHandle = relationshipProtocol.handles.memories.find((item) => (
    item.itemId === 'agent-memory:relationship-appraisal'
  ))?.handle;
  assert(relationshipPersonHandle,
    'Mind must receive a request-scoped handle for the visible person');
  assert(relationshipMemoryHandle,
    'Mind must receive a request-scoped handle for the sourced shared memory');
  const appraisalDecision = gateway.normalizeMindPlanModelOutput(
    relationshipProjected,
    {
      utterance: '她那次留下帮我，我感激，可也想知道下次她会不会仍然这样。',
      delivery: 'normal', goal: '弄清我是否愿意继续信任她',
      orientation: 'social', horizon: 'ongoing',
      relationshipAppraisal: {
        otherPersonHandle: relationshipPersonHandle,
        sourceMemoryHandles: [relationshipMemoryHandle],
        meanings: ['gratitude', 'uncertainty'],
        interpretation: '她在我需要时留下帮了我，但一次经历还不足以让我确定以后。',
        unresolvedExpectation: '下次困难时她会不会留下？',
        desiredResponse: '再与她做一件具体的事。',
      },
    },
    { steps: ['先保留这个未解的判断'], disposition: 'stay' },
    relationshipProtocol,
  );
  assert.deepEqual(appraisalDecision?.mentalAct?.relationshipAppraisal?.meanings,
    ['gratitude', 'uncertainty'],
    'Mind-authored relationship meaning must survive without becoming a numeric score');
  const ungroundedAppraisalIntention = gateway.normalizeMindPlanModelOutput(
    relationshipProjected,
    {
      utterance: '我想把手头的问题想清楚。', delivery: 'normal',
      goal: '想清楚手头的问题', orientation: 'inquiry', horizon: 'momentary',
      relationshipAppraisal: { otherPersonHandle: 'not-visible', meanings: ['invented-feeling'] },
    },
    { steps: ['短暂思考'], disposition: 'stay' },
    relationshipProtocol,
  );
  assert.equal(ungroundedAppraisalIntention?.mentalAct?.goal, '想清楚手头的问题',
    'an invalid optional appraisal must not discard a valid Mind intention');
  assert.equal(ungroundedAppraisalIntention?.mentalAct?.relationshipAppraisal, undefined,
    'a dropped appraisal must not install a relationship without real sources');
  const ungroundedStagedAppraisal = gateway.normalizeDecisionModelOutput(
    relationshipProjected,
    {
      kind: 'wait', utterance: '我在这里歇一会。', delivery: 'normal',
      goal: '歇一会', strategy: '暂时停留', assumptions: [],
      relationshipAppraisal: { otherPersonId: relationshipOther.id, sourceEventIds: ['invented-fact'] },
    },
    relationshipProtocol,
  );
  assert.equal(ungroundedStagedAppraisal?.mentalAct?.goal, '歇一会',
    'the later MentalAct adapter must also isolate invalid optional relationship data');
  assert.equal(ungroundedStagedAppraisal?.mentalAct?.relationshipAppraisal, undefined);
  intentExecution.applyDecision(
    relationshipState, relationshipObserver, relationshipContext, appraisalDecision, true, 2, 1, 1,
  );
  const storedRelationshipEpisode = relationshipObserver.relationshipEpisodes?.at(-1);
  assert.equal(storedRelationshipEpisode?.otherPersonId, relationshipOther.id);
  assert.deepEqual(storedRelationshipEpisode?.sourceFactIds, [relationshipSource.id]);
  assert.equal(relationshipOther.relationshipEpisodes?.length ?? 0, 0,
    'one observer appraisal must never install a reciprocal feeling on the other person');
  const appraisedContext = simulation.buildDecisionContexts(relationshipState, 2)
    .find((candidate) => candidate.person.id === relationshipObserver.id);
  const appraisedRequest = decisionContext.buildDecisionRequestContext(appraisedContext);
  // Deliberately contradictory scores must not replace the observer's own
  // sourced, uncertain interpretation with fear, intimacy or trust.
  appraisedRequest.visiblePeople = appraisedRequest.visiblePeople.map((person) => ({ ...person,
    trust: 100, bond: 100, fear: 100 }));
  const appraisedProtocol = gateway.buildDecisionModelRequestProtocol(appraisedRequest);
  const appraisedPerson = appraisedProtocol.mindContext.visible.nearbyObjects.find((person) => person.name === relationshipOther.name);
  assert.equal(appraisedPerson.relation.interpretation, storedRelationshipEpisode.appraisal.interpretation);
  assert.equal(appraisedPerson.relation.sourceCount, 1);
  assert.match(appraisedPerson.relation.perspective, /本人.*不代表对方/);
  const unappraisedRequest = structuredClone(appraisedRequest);
  unappraisedRequest.person.relationshipEpisodes = [];
  const unappraisedPerson = gateway.buildDecisionModelRequestProtocol(unappraisedRequest)
    .mindContext.visible.nearbyObjects.find((person) => person.name === relationshipOther.name);
  assert.equal('relation' in unappraisedPerson, false,
    'without an authored interpretation, numeric scores must not invent a relationship feeling');

  const compilerTrial = {
    ...projected.options[0],
    id: 'project:test-open-inquiry:hypothesis-wood+stone',
    projectId: 'test-open-inquiry',
    summary: '试验编译器预选的木材与石头',
    semantics: { ...projected.options[0].semantics, obligation: 'optional' },
  };
  const inquiryProtocol = gateway.buildDecisionModelRequestProtocol({
    ...projected,
    options: [...projected.options, compilerTrial],
  }, { characterAgendaProposal: false });
  assert.ok(!inquiryProtocol.requestContext.availableSteps.some((step) => (
    step.action === compilerTrial.summary
  )), 'compiler-selected unknown material pairs must not impersonate a character-authored action');

  const stayDecision = gateway.normalizeMindPlanModelOutput(
    projected,
    { utterance: '我现在不想拿生产填满这段时间。', delivery: 'normal', goal: '留在这里看看周围', orientation: 'rest', horizon: 'momentary' },
    { steps: ['停留并观察'], disposition: 'stay' },
    protocol,
  );
  assert.equal(stayDecision?.kind, 'idle', 'stay without active work must remain a real no-action choice');
  const planFeedbackRequest = {
    ...projected,
    person: {
      ...projected.person,
      memories: [{
        id: 'failed-action-memory', lane: 'episodic', gist: '刚才的办法没有产生预期结果',
        precision: 'specific', confidence: 90, salience: 80, emotionalValence: -0.3,
        personIds: [], topicKeys: ['failure'], sourceEventIds: ['failed-action-event'], unresolved: true,
        firstExperiencedAtMonth: 1, lastExperiencedAtMonth: 1, lastRecalledAtMonth: 1,
        causalOutcome: 'failed',
      }],
    },
  };
  const planFeedbackProtocol = gateway.buildDecisionModelRequestProtocol(planFeedbackRequest, {
    characterAgendaProposal: false,
  });
  const feedbackMemoryHandle = planFeedbackProtocol.handles.memories.find((memory) => memory.sourceFactIds.length)?.handle;
  assert(feedbackMemoryHandle, 'plan feedback test requires one source-bound remembered event');
  const correctiveStay = gateway.normalizeMindPlanModelOutput(
    planFeedbackRequest,
    {
      utterance: '刚才那条路走不通，我先改正自己的判断。', delivery: 'normal',
      goal: '修正刚才失败所依据的认识', orientation: 'rest', horizon: 'momentary',
    },
    {
      steps: ['承认失败暴露的条件不成立'], disposition: 'stay',
      feedback: {
        sourceMemoryHandles: [feedbackMemoryHandle],
        correction: '先前假定的条件没有在真实尝试中出现',
        adjustment: '下次只采用失败事实仍支持的对象和步骤',
      },
    },
    planFeedbackProtocol,
  );
  assert.ok(correctiveStay?.mentalAct?.planFeedback?.sourceEventIds.length,
    'a Plan Agent correction must retain the failure sources that can write it back into mind');
  const pauseDecision = gateway.normalizeMindPlanModelOutput(
    activeRequest,
    { utterance: '这件事先放一放。', delivery: 'normal', goal: '暂时离开当前工作', orientation: 'rest', horizon: 'momentary' },
    { steps: ['搁置当前工作'], disposition: 'pause' },
    activeProtocol,
  );
  assert.equal(pauseDecision?.kind, 'suspend');
  assert.equal(pauseDecision?.intentId, 'intent-test');
  assert.equal(modelReview.validateModelDecision(activeContext, pauseDecision)?.kind, 'suspend',
    'the authoritative model review must preserve a character-authored pause');
  const abandonDecision = gateway.normalizeMindPlanModelOutput(
    activeRequest,
    { utterance: '我不再继续这件事。', delivery: 'normal', goal: '放弃当前工作', orientation: 'rest', horizon: 'momentary' },
    { steps: ['放弃当前工作'], disposition: 'abandon' },
    activeProtocol,
  );
  assert.equal(abandonDecision?.kind, 'abandon');
  assert.equal(abandonDecision?.intentId, 'intent-test');
  assert.equal(modelReview.validateModelDecision(activeContext, abandonDecision)?.kind, 'abandon',
    'the authoritative model review must preserve a character-authored abandonment');

  const keys = collectKeys(mindRequest);
  for (const forbidden of [
    'signals', 'optionAppraisals', 'addressedNeeds',
    'motivation', 'aspiration', 'urgency', 'expectedSuccess', 'uncertainty',
    'socialRepetition', 'score', 'personality', 'motiveSensitivity',
    'characterNote', 'experience', 'ageMonths',
    'properties', 'experiencedOutcomes', 'semantics', 'possibleExperiments',
  ]) {
    assert.equal(keys.has(forbidden), false, `model request must not expose local appraisal field ${forbidden}`);
  }
  console.log('model decision context tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
