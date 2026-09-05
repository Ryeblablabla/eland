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
const modelReviewBundle = path.join(temporaryDirectory, 'model-review.mjs');
const intentExecutionBundle = path.join(temporaryDirectory, 'intent-execution.mjs');
const personMindBundle = path.join(temporaryDirectory, 'person-mind.mjs');
const spokenMeaningBundle = path.join(temporaryDirectory, 'spoken-meaning.mjs');
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
  bundle('src/game/eland/application/simulation/model-review.ts', modelReviewBundle);
  bundle('src/game/eland/application/simulation/intent-execution.ts', intentExecutionBundle);
  bundle('src/game/eland/domain/person-mind.ts', personMindBundle);
  bundle('src/game/eland/domain/spoken-meaning.ts', spokenMeaningBundle);

  const simulation = await import(`${pathToFileURL(simulationBundle).href}?test=${Date.now()}`);
  const decisionContext = await import(`${pathToFileURL(decisionContextBundle).href}?test=${Date.now()}`);
  const gateway = await import(`${pathToFileURL(gatewayBundle).href}?test=${Date.now()}`);
  const modelReview = await import(`${pathToFileURL(modelReviewBundle).href}?test=${Date.now()}`);
  const intentExecution = await import(`${pathToFileURL(intentExecutionBundle).href}?test=${Date.now()}`);
  const personMind = await import(`${pathToFileURL(personMindBundle).href}?test=${Date.now()}`);
  const spokenMeaning = await import(`${pathToFileURL(spokenMeaningBundle).href}?test=${Date.now()}`);
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
  const request = protocol.requestContext;
  const mindRequest = protocol.mindContext;
  assert.equal(request.schemaVersion, 'mental-act-context-v5');
  assert.equal(mindRequest.schemaVersion, 'mind-intention-context-v5');
  assert.ok(mindRequest.origin, 'a founder should receive one founding orientation on the first decision');
  assert.ok(mindRequest.origin.background.some((line) => line.includes('共同开始生活')),
    'the founding background should explain the shared arrival without prescribing an action');
  assert.equal('initialIntention' in mindRequest.origin, false,
    'the first intention belongs to Mind and must not be authored by a personality regex');
  assert.match(mindRequest.personalityPreset.type, /^[IE][NS][FT][JP]$/u,
    'every person should receive one derived MBTI writing type');
  assert.equal('speechExamples' in mindRequest.personalityPreset, false,
    'content-bearing example lines must not seed a shared topic into every character voice');
  assert.ok(mindRequest.personalityPreset.speechTendency,
    'the Mind preset should retain abstract voice guidance without lexical imitation bait');
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
  assert.equal(agedConcern.approaches[0].recentFeedback[0].note, '没有观察到物质变化',
    'the recent real feedback must accompany the old question instead of being lost in compact projection');
  const visiblePositions = agedConcernProtocol.requestContext.visible.surfaces;
  assert.equal(visiblePositions.length, agedConcernRequest.visibleVoxels.length,
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
  assert.ok(request.availableSteps.length > 0, 'the internal Plan brief must still receive legal current steps');
  assert.ok(request.availableSteps.every((step) => step.pastExperience?.some((line) => line.includes('亲历 3 次'))), 'steps should carry semantic outcome summaries');
  assert.ok(request.actionSpace.operations.length > 0, 'the request should describe executable operation meanings');
  assert.ok(Array.isArray(request.actionSpace.heldObjects), 'held objects should appear only in the semantic action space');
  assert.ok(Array.isArray(request.visible.nearbyObjects), 'nearby objects should appear in the semantic visible section');
  assert.ok(request.visible.nearbyObjects.some((item) => (
    item.kind === '动物' && item.disposition === '对你放松，不再躲避'
  )), 'a visible bonded animal should compile into the model brief without reading missing authoritative state');
  assert.equal('nearbyObjects' in request.actionSpace, false, 'nearby objects must not be duplicated in actionSpace');
  assert.equal('inventory' in request.person, false, 'inventory must not be duplicated under person');
  assert.equal('possibleExperiments' in request, false, 'the old duplicate experiment projection should be removed');
  assert.equal('availableSteps' in mindRequest, false, 'Mind must not receive locally prepared action choices');
  assert.equal('continuations' in mindRequest, false, 'Mind must not receive execution continuations');
  assert.equal('actionSpace' in mindRequest, false, 'Mind must not plan physical actions');
  assert.ok(mindRequest.actionPossibilities.availableNow.length > 0,
    'Mind should receive a coarse map of action kinds that can currently reach Execution');
  assert.ok(mindRequest.actionPossibilities.availableNow.some((item) => item.kind === 'observe'),
    'the coarse map should let Mind know that grounded observation is currently possible');
  assert.equal(/\b(?:o|h|v|d|p)\d+\b/u.test(JSON.stringify(mindRequest.actionPossibilities)), false,
    'the Mind affordance map must not expose exact Plan handles or become a hidden option menu');
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
  assert.equal(activeProtocol.mindContext.current.ongoingCommitment, '完成眼前住所');
  assert.equal('activeWork' in activeProtocol.mindContext.current, false,
    'Mind must not receive executor progress or next-step state');
  assert.equal('activeProject' in activeProtocol.mindContext.current, false,
    'Mind must not receive project execution details');
  assert.ok(activeProtocol.requestContext.current.activeWork,
    'Plan must retain the current execution context');
  const executionEntry = request.availableSteps.find((step) => step.purpose === '取得资源' && !step.requiresContinuation)
    ?? request.availableSteps.find((step) => step.purpose === '观察或验证问题' && !step.requiresContinuation)
    ?? request.availableSteps.find((step) => !step.communicationKind && !step.requiresContinuation);
  assert(executionEntry, 'the staged adapter test requires one ordinary execution entry');
  const stagedDecision = gateway.normalizeMindPlanModelOutput(
    projected,
    {
      utterance: `我决定${executionEntry.action}。`,
      delivery: 'normal',
      goal: executionEntry.action,
      orientation: executionEntry.purpose === '取得资源' ? 'acquisition'
        : executionEntry.purpose === '观察或验证问题' ? 'inquiry'
          : executionEntry.purpose === '与人交谈' ? 'social'
            : executionEntry.purpose === '推进项目' || executionEntry.purpose === '进行生产' ? 'construction'
              : 'survival',
      horizon: 'momentary',
    },
    {
      steps: ['先从当前能够落地的入口开始'],
      disposition: 'act',
      firstStepHandle: executionEntry.handle,
    },
    protocol,
  );
  assert(stagedDecision && (stagedDecision.kind === 'start' || stagedDecision.kind === 'revise'));
  assert.equal(stagedDecision.mentalAct.goal, executionEntry.action);
  assert.equal(stagedDecision.mentalAct.strategy, executionEntry.action,
    'the persisted strategy must name the concrete selected action instead of conflicting plan prose');
  const crossCategoryPlan = gateway.normalizeMindPlanModelOutput(
    projected,
    {
      utterance: 'I want to make something for the people here.', delivery: 'normal',
      goal: 'Create something useful together', orientation: 'social', horizon: 'ongoing',
    },
    { steps: ['Obtain what I need before discussing the design'], disposition: 'act', firstStepHandle: executionEntry.handle },
    protocol,
  );
  assert.equal(crossCategoryPlan?.kind, 'start',
    'model-authored intermediate work must not be vetoed by direction categories or Chinese word overlap');
  const companionOptionIndex = projected.options.findIndex((option) => option.communicationMeaning?.proposal?.kind === 'companion');
  assert(companionOptionIndex >= 0, 'founders must retain an executable companion proposal as a choice');
  const companionOption = projected.options[companionOptionIndex];
  const companionHandle = `o${companionOptionIndex + 1}`;
  const ordinaryStatement = {
    utterance: '我先把这里的木料摆正，再看看顶上还缺哪一块。', delivery: 'normal',
    goal: '把眼前的施工继续做下去', orientation: 'construction', horizon: 'ongoing', speechIntent: { kind: 'expression' },
  };
  const mistakenCompanion = gateway.normalizeMindPlanModelOutput(projected, ordinaryStatement, {
    steps: ['说清自己接下来的施工打算'], disposition: 'act', firstStepHandle: companionHandle,
  }, protocol);
  assert.equal(mistakenCompanion?.kind, 'idle', 'ordinary construction expression must not become a companion contract');
  assert.equal(mistakenCompanion.mentalAct.utterance, ordinaryStatement.utterance,
    'correcting Plan semantic escalation must preserve the exact independent Mind expression');
  const physicalAfterStatement = gateway.normalizeMindPlanModelOutput(projected, ordinaryStatement, {
    steps: ['说清自己的打算', '继续实际操作'], disposition: 'act', firstStepHandle: companionHandle,
    continuationHandle: executionEntry.handle,
  }, protocol);
  assert.equal(physicalAfterStatement?.optionId, projected.options[Number(executionEntry.handle.slice(1)) - 1].id,
    'a physical continuation remains executable after a mistaken social menu entry is removed');
  const companionPartnerIds = companionOption.semantics.socialContext.counterpartIds;
  const companionSpeech = {
    kind: 'proposal', proposalKind: 'companion', commitment: '我愿意和你开始共同生活，想听你的决定。',
    counterpartHandles: companionPartnerIds.map((id) => protocol.handles.visible.find((item) => item.kind === 'person' && item.personId === id).handle),
  };
  const actualCompanion = gateway.normalizeMindPlanModelOutput(projected, {
    ...ordinaryStatement, utterance: 'I want to share my life with you. What do you think?', speechIntent: companionSpeech,
  }, { steps: ['提出本人愿意共同生活的想法'], disposition: 'act', firstStepHandle: companionHandle }, protocol);
  assert.equal(actualCompanion?.optionId, companionOption.id,
    'a model-authored proposal must remain executable without Chinese keywords or utterance overlap gates');
  assert.equal(actualCompanion.mentalAct.speechIntent.kind, 'proposal');
  assert.deepEqual(actualCompanion.mentalAct.speechIntent.counterpartIds, companionPartnerIds);
  const lateCompanionContext = { ...projected, options: [
    ...Array.from({ length: 20 }, (_, index) => ({ ...projected.options[Number(executionEntry.handle.slice(1)) - 1], id: `ordinary-${index}` })),
    companionOption,
  ] };
  const lateCompanionProtocol = gateway.buildDecisionModelRequestProtocol(lateCompanionContext, { characterAgendaProposal: false });
  assert(lateCompanionProtocol.requestContext.availableSteps.some((step) => step.handle === 'o21'),
    'compression must preserve a real companion choice beyond eight ordinary choices');
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
  const fullInventoryProjected = {
    ...projected,
    person: { ...projected.person, inventory: extendedInventory },
  };
  const fullInventoryProtocol = gateway.buildDecisionModelRequestProtocol(fullInventoryProjected, {
    characterAgendaProposal: false,
  });
  assert.equal(fullInventoryProtocol.requestContext.actionSpace.heldObjects.length, 10,
    'every held entity must remain selectable instead of truncating the inventory at six or eight items');
  assert.ok(fullInventoryProtocol.mindContext.visible.heldPossessions.some((item) => item.name === '木炭'),
    'Mind must receive a complete identity-free possession overview');
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
      experiment: { kind: 'combine', stackHandles: ['h9', 'h10'] },
    },
    fullInventoryProtocol,
  );
  assert.equal(directExperiment?.kind, 'idle');
  assert.deepEqual(directExperiment?.executionProbe, {
    kind: 'combine', ownStackIds: ['full-inventory-stack-9', 'full-inventory-stack-10'],
  }, 'a direct model experiment must preserve the exact late-inventory entities it selected');
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
      experiment: { kind: 'move', targetHandle: visibleSurface.ref },
    },
    fullInventoryProtocol,
  );
  assert.equal(movement?.executionProbe?.kind, 'move',
    'a character must be able to choose visible movement without wrapping it in a production project');

  const targetMoveAction = { description: '走近眼前的位置', targetHandles: [visibleSurface.ref] };
  const targetMoveResolution = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '正在走近目标', effects: [{ kind: 'move-self', targetHandle: visibleSurface.ref, withinDistance: 2 }],
  }, targetMoveAction, fullInventoryProtocol);
  const exactArrival = gateway.normalizeMindPlanModelOutput(fullInventoryProjected, {
    ...ordinaryStatement, goal: '实际抵达一次眼前的位置',
  }, {
    steps: ['走到目标一格之内'], disposition: 'act', worldAction: targetMoveAction,
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
    description: '用指甲在自己手里的锡矿石表面划出一道浅痕，并亲手确认痕迹是否留下',
    targetHandles: ['h9'],
    expectedResult: '锡矿石表面留下一道之后还能看见的浅痕',
  };
  const worldVerdict = {
    status: 'completed',
    result: '指甲没有改变锡矿石的形状，但表面留下了一道之后还能辨认的浅痕',
    effects: [
      { kind: 'knowledge', summary: '指甲无法改变锡矿石形状，但能在表面留下浅痕' },
      {
        kind: 'world-state', targetHandle: 'h9', stateKey: 'surface-condition',
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
    { steps: ['平码并轻推确认'], disposition: 'act', feedback: null, experiment: null, worldAction },
    fullInventoryProtocol,
    worldResolution,
  );
  assert.equal(worldDecision?.executionProbe?.kind, 'world-interaction',
    'an accepted Plan Agent verdict must enter the ordinary execution probe path');
  assert.deepEqual(worldDecision?.mentalAct?.plan?.steps, ['平码并轻推确认'],
    'the complete Plan translation must survive normalization instead of disappearing after its first action');
  assert.equal('verdict' in (worldDecision?.mentalAct?.plan?.worldAction ?? {}), false,
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
      worldAction, verdict: worldVerdict,
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
  assert.equal(gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed',
    result: '换用了另一件东西',
    effects: [{ kind: 'consume', targetHandle: 'h1', quantity: 1 }],
  }, worldAction, fullInventoryProtocol), undefined,
  'the Plan Agent must not mutate an object that the character did not select');
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
    targetHandles: ['h1', plantingSurface.ref],
    expectedResult: '种子进入土壤并成为可继续生长的幼苗',
  };
  const unnamedAssembly = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '搭成了一个叫作风声琴的小棚，放在了身旁',
    effects: [
      { kind: 'consume', targetHandle: 'h1', quantity: 1 },
      { kind: 'assemble', targetHandle: visibleSurface.ref, arrangement: 'lash', summary: '风声琴' },
    ],
  }, { description: '把材料连接成风声琴', targetHandles: ['h1', visibleSurface.ref] }, fullInventoryProtocol);
  assert.equal(unnamedAssembly?.probe?.adjudication.effects[1]?.kind, 'assemble',
    'an independently adjudicated new facility must not require a catalog name, Chinese construction keyword or extra relocation effect');
  const materializedPlanting = gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '种子已经播入土壤，形成了作物幼苗',
    effects: [
      { kind: 'consume', targetHandle: 'h1', quantity: 1 },
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
