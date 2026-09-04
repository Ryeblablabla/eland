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
  assert.ok(mindRequest.origin.initialIntention,
    'the founding orientation should give the person a broad initial intention');
  assert.match(mindRequest.personalityPreset.type, /^[IE][NS][FT][JP]$/u,
    'every person should receive one derived MBTI writing type');
  assert.equal('speechExamples' in mindRequest.personalityPreset, false,
    'content-bearing example lines must not seed a shared topic into every character voice');
  assert.ok(mindRequest.personalityPreset.speechTendency,
    'the Mind preset should retain abstract voice guidance without lexical imitation bait');
  const founderIntentions = simulation.buildDecisionContexts(state, 1).map((founderContext) => {
    const founderRequest = decisionContext.buildDecisionRequestContext(founderContext);
    return gateway.buildDecisionModelRequestProtocol(founderRequest, {
      characterAgendaProposal: false,
    }).mindContext.origin?.initialIntention;
  }).filter(Boolean);
  assert.ok(new Set(founderIntentions).size > 1,
    'founder initial intentions should vary with their character attention, not form one shared task');
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
  const unrelatedPhysicalStep = request.availableSteps.find((step) => (
    step.purpose !== '与人交谈'
      && step.purpose !== '协调共同事务'
      && step.purpose !== '照顾他人'
      && step.purpose !== '处理生育关系'
  ));
  assert(unrelatedPhysicalStep, 'the intention-alignment test requires one non-social executable step');
  const rejectedSubstitution = gateway.normalizeMindPlanModelOutput(
    projected,
    {
      utterance: '我想先听清楚眼前的人是否愿意和我继续交谈。', delivery: 'normal',
      goal: '听见对方自己的回答', orientation: 'social', horizon: 'ongoing',
    },
    { steps: ['先去做一件当前合法但与交谈无关的事'], disposition: 'act', firstStepHandle: unrelatedPhysicalStep.handle },
    protocol,
  );
  assert.equal(rejectedSubstitution?.kind, 'idle',
    'Plan must preserve the Mind intention as no action instead of substituting an unrelated legal step');
  assert.match(rejectedSubstitution?.mentalAct.strategy ?? '', /不采取行动.*保留/u);
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
  const physicalTemplate = projected.options.find((option) => !option.communicationKind);
  assert(physicalTemplate, 'fine-grained intention alignment requires one physical option template');
  const {
    communicationKind: _communicationKind,
    communicationMeaning: _communicationMeaning,
    speechAct: _speechAct,
    expressesFactId: _expressesFactId,
    openConversationGrounding: _openConversationGrounding,
    ...physicalOnlyTemplate
  } = physicalTemplate;
  const dismantleContext = {
    ...projected,
    options: [{
      ...physicalOnlyTemplate,
      id: 'test:dismantle-plank',
      summary: '徒手从现有位置拆下木板，原位置会变空，可取回木板',
      semantics: { ...physicalOnlyTemplate.semantics, obligation: 'optional', purpose: 'resource' },
    }],
  };
  const dismantleProtocol = gateway.buildDecisionModelRequestProtocol(dismantleContext, {
    characterAgendaProposal: false,
  });
  const rejectedDismantle = gateway.normalizeMindPlanModelOutput(
    dismantleContext,
    {
      utterance: '把现有木板铺在草皮上，继续搭成挡雨的架子。', delivery: 'normal',
      goal: '继续搭建遮雨结构', orientation: 'construction', horizon: 'momentary',
    },
    { steps: ['铺设木板'], disposition: 'act', firstStepHandle: 'o1' },
    dismantleProtocol,
  );
  assert.equal(rejectedDismantle?.kind, 'idle',
    'placing a plank must not execute as dismantling that plank merely because both mention the same material');
  const shelterVerificationContext = {
    ...projected,
    options: [{
      ...physicalOnlyTemplate,
      id: 'test:verify-shelter-technique',
      summary: '复查项目试验“搭建时可把木材加工并安装为木板”',
      projectId: 'test-shelter-project',
      executionProjectFunction: 'weather-shelter',
      semantics: { ...physicalOnlyTemplate.semantics, obligation: 'optional', purpose: 'inquiry' },
    }],
  };
  const shelterVerificationProtocol = gateway.buildDecisionModelRequestProtocol(shelterVerificationContext, {
    characterAgendaProposal: false,
  });
  const rejectedProjectScopeSwap = gateway.normalizeMindPlanModelOutput(
    shelterVerificationContext,
    {
      utterance: '我想把石头和湿土铺平，看看地面能否站稳。', delivery: 'normal',
      goal: '验证石土铺设效果', orientation: 'inquiry', horizon: 'momentary',
    },
    { steps: ['检查石土地面'], disposition: 'act', firstStepHandle: 'o1' },
    shelterVerificationProtocol,
  );
  assert.equal(rejectedProjectScopeSwap?.kind, 'idle',
    'a project verification step must still match the actual project scope named by Mind');
  const harvestContext = {
    ...projected,
    options: [{
      ...physicalOnlyTemplate,
      id: 'test:harvest-wood',
      summary: '从树木取得木材（对象：树叶）',
      semantics: { ...physicalOnlyTemplate.semantics, obligation: 'optional', purpose: 'resource' },
    }],
  };
  const harvestProtocol = gateway.buildDecisionModelRequestProtocol(harvestContext, {
    characterAgendaProposal: false,
  });
  const rejectedHarvest = gateway.normalizeMindPlanModelOutput(
    harvestContext,
    {
      utterance: '把手中剩下的纤维编成能挡雨的架子。', delivery: 'normal',
      goal: '用已有纤维完成遮雨结构', orientation: 'construction', horizon: 'momentary',
    },
    { steps: ['编好已有纤维'], disposition: 'act', firstStepHandle: 'o1' },
    harvestProtocol,
  );
  assert.equal(rejectedHarvest?.kind, 'idle',
    'using an already held material must not silently turn into harvesting a different material');
  const inquiryEntry = request.availableSteps.find((step) => step.purpose === '观察或验证问题' && step.target?.name);
  assert(inquiryEntry, 'observation alignment requires one targeted inquiry entry');
  const rejectedObservationSwap = gateway.normalizeMindPlanModelOutput(
    projected,
    {
      utterance: '我只想确认风向是否稳定。', delivery: 'normal',
      goal: '确认风向是否稳定', orientation: 'inquiry', horizon: 'momentary',
    },
    { steps: ['改看一个无关对象'], disposition: 'act', firstStepHandle: inquiryEntry.handle },
    protocol,
  );
  assert.equal(rejectedObservationSwap?.kind, 'idle',
    'a targeted inquiry must not observe an unrelated visible object');
  assert.equal(spokenMeaning.spokenTextSupportsMeaning(
    '我们应该把木材变成能够遮雨的东西。',
    { id: 'prediction', kind: 'prediction', summary: '第 16 月前后将进入乱纪元', prediction: { targetEpoch: 'chaotic', predictedStartMonth: 16, toleranceMonths: 2, expiresAtMonth: 20 } },
  ), false, 'an unrelated utterance must not silently create a typed prediction');
  assert.equal(spokenMeaning.spokenTextSupportsMeaning(
    '搭建时可以把木材加工并安装为木板。',
    { id: 'teaching', kind: 'claim', summary: '搭建时可把木材加工并安装为木板', factId: 'technique:test' },
  ), true, 'a spoken explanation should still be able to carry matching knowledge');

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
  const wrongNamedResourceContext = {
    ...fullInventoryProjected,
    options: [{
      ...physicalOnlyTemplate,
      id: 'test:collect-tin-instead-of-charcoal',
      summary: '取得锡矿石',
      semantics: { ...physicalOnlyTemplate.semantics, obligation: 'optional', purpose: 'resource' },
    }],
  };
  const wrongNamedResourceProtocol = gateway.buildDecisionModelRequestProtocol(wrongNamedResourceContext, {
    characterAgendaProposal: false,
  });
  const rejectedNamedResourceSwap = gateway.normalizeMindPlanModelOutput(
    wrongNamedResourceContext,
    {
      utterance: '我需要找到木炭来做下一次尝试。', delivery: 'normal',
      goal: '取得木炭', orientation: 'acquisition', horizon: 'momentary',
    },
    { steps: ['取得另一种矿石'], disposition: 'act', firstStepHandle: 'o1' },
    wrongNamedResourceProtocol,
  );
  assert.equal(rejectedNamedResourceSwap?.kind, 'idle',
    'an acquisition plan must not replace an explicitly named material with a different resource');
  const rejectedDuplicateAcquisition = gateway.normalizeMindPlanModelOutput(
    wrongNamedResourceContext,
    {
      utterance: '手里已有锡矿石，我想先看它能不能参与下一次尝试。', delivery: 'normal',
      goal: '使用已有锡矿石', orientation: 'construction', horizon: 'momentary',
    },
    { steps: ['再次取得锡矿石'], disposition: 'act', firstStepHandle: 'o1' },
    wrongNamedResourceProtocol,
  );
  assert.equal(rejectedDuplicateAcquisition?.kind, 'idle',
    'using an already held material must not silently become another acquisition unless Mind says more is needed');
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
  const rejectedExperimentMaterialSwap = gateway.normalizeMindPlanModelOutput(
    fullInventoryProjected,
    {
      utterance: '我只想看看木炭和锡矿接触会怎样。', delivery: 'normal',
      goal: '验证木炭与锡矿的接触结果', orientation: 'inquiry', horizon: 'momentary',
    },
    {
      steps: ['改拿眼前另外两件东西试验'],
      disposition: 'act',
      experiment: { kind: 'combine', stackHandles: ['h1', 'h2'] },
    },
    fullInventoryProtocol,
  );
  assert.equal(rejectedExperimentMaterialSwap?.executionProbe, undefined,
    'Plan must not replace a material explicitly named by Mind with different held entities');
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
  const visiblePersonForAgency = fullInventoryProtocol.requestContext.visible.nearbyObjects
    .find((item) => item.kind === '人物');
  if (visiblePersonForAgency) {
    const agencyAction = {
      description: `询问${visiblePersonForAgency.name}是否同意`,
      targetHandles: [visiblePersonForAgency.ref],
      expectedResult: '听见对方自己的回答',
    };
    assert.equal(gateway.sanitizePlanAgentWorldVerdict({
      status: 'completed',
      result: `${visiblePersonForAgency.name}点头同意并走了过来`,
      effects: [{ kind: 'knowledge', summary: '对方表示同意' }],
    }, agencyAction, fullInventoryProtocol), undefined,
    'a world verdict must not author another person\'s voluntary answer or movement');
  }
  const plantingProjected = {
    ...fullInventoryProjected,
    person: {
      ...fullInventoryProjected.person,
      inventory: fullInventoryProjected.person.inventory.map((stack, index) => (
        index === 0 ? { ...stack, name: '种子' } : stack
      )),
    },
  };
  const plantingProtocol = gateway.buildDecisionModelRequestProtocol(plantingProjected, {
    characterAgendaProposal: false,
  });
  const plantingSurface = plantingProtocol.requestContext.visible.surfaces[0];
  assert(plantingSurface, 'planting materialization test requires one visible surface');
  const plantingAction = {
    description: '把手里的种子播进眼前土壤',
    targetHandles: ['h1', plantingSurface.ref],
    expectedResult: '种子进入土壤并成为可继续生长的幼苗',
  };
  assert.equal(gateway.sanitizePlanAgentWorldVerdict({
    status: 'completed', result: '种子已经埋入土壤',
    effects: [
      { kind: 'consume', targetHandle: 'h1', quantity: 1 },
      {
        kind: 'world-state', targetHandle: plantingSurface.ref,
        stateKey: 'planted-seed', stateValue: '已埋入一颗种子', summary: '土中埋有种子',
      },
    ],
  }, plantingAction, plantingProtocol), undefined,
  'planting must not stop at an open-text seed fact that monthly crop growth cannot read');
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
    'characterNote', 'experience', 'ageMonths', 'cellId', 'z',
    'properties', 'experiencedOutcomes', 'semantics', 'possibleExperiments',
  ]) {
    assert.equal(keys.has(forbidden), false, `model request must not expose local appraisal field ${forbidden}`);
  }
  console.log('model decision context tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
