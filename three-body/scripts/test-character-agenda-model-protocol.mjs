import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-character-agenda-model-protocol-'));
const bundlePath = path.join(temporaryDirectory, 'model-decision-gateway.mjs');
const previousAgendaMode = process.env.MODEL_CHARACTER_AGENDA_MODE;
const previousDecisionContextMode = process.env.MODEL_DECISION_CONTEXT_MODE;

const semantics = {
  version: 'action-option-semantics-v1',
  obligation: 'optional',
  planningChannel: 'ordinary',
  purpose: 'inquiry',
  minimumLifeStage: 'adult',
  needKinds: ['inquiry'],
};

const agenda = Array.from({ length: 5 }, (_, index) => ({
  id: `agenda-real-${index + 1}`,
  basisKey: `agenda-basis-real-${index + 1}`,
  projectIds: [],
  aim: `长期关切 ${index + 1}`,
  theme: '探索',
  importance: 80 - index,
  horizonMonths: 18,
  targetAtMonth: 30,
  status: 'active',
  lastReviewedAtMonth: 12,
  approaches: [{
    summary: '先做一个小试验',
    disposition: 'bounded-experiment',
    evaluationCount: 0,
  }],
}));

const context = {
  person: {
    id: 'real-person-self',
    name: '甲',
    description: '谨慎但好奇的人',
    ageMonths: 240,
    sex: 'female',
    body: { health: 90, hydration: 80, nutrition: 80 },
    conditions: [],
    capacities: { locomotion: 50, manipulation: 50, perception: 50, communication: 50, cognition: 50 },
    traits: [],
    personality: { honestyHumility: 50, emotionality: 50, extraversion: 50, agreeableness: 50, conscientiousness: 50, openness: 70 },
    motiveSensitivity: { control: 50, status: 50 },
    soul: {
      signature: 'soul-test',
      innerVoice: '我想先看清变化。',
      styleMatrix: {},
      sceneFacets: [{
        id: 'uncertainty-and-change', cue: '未知', attention: '看证据', innerTension: '保持怀疑',
        socialStrategy: '说清边界', speechTendency: '简短说明',
      }],
    },
    currentChoice: '',
    currentAction: '',
    position: { cellId: 1, z: 1 },
    inventory: [
      { stackId: 'real-stack-leaf', name: '叶片', properties: ['solid', 'sheet'], perception: {}, quantity: 2 },
      { stackId: 'real-stack-fiber', name: '纤维', properties: ['solid', 'strand'], perception: {}, quantity: 2 },
    ],
    knowledge: [],
    knownPlaces: [],
    memories: [{
      id: 'agent-memory:real-person-self:failure-1', lane: 'episodic',
      gist: '连续比较门边石面都没弄清变化原因', precision: 'specific',
      confidence: 82, salience: 84, emotionalValence: -0.5, personIds: [], topicKeys: ['stone-change'],
      sourceEventIds: ['fact-memory-stone-1'], unresolved: true,
      firstExperiencedAtMonth: 10, lastExperiencedAtMonth: 12, lastRecalledAtMonth: 12,
    }],
    cognition: { architecture: 'causal-bdi-v1', needs: [], outcomeBeliefs: [], optionAppraisals: [] },
    characterAgenda: agenda,
    kinship: { parents: [], children: [], siblings: [] },
  },
  clock: { elapsedMonths: 12 },
  climate: { kind: 'temperate', severity: 1, sinceMonth: 0 },
  epoch: 'stable',
  weather: { kind: 'clear', intensity: 1, sinceMonth: 0 },
  activePressures: [],
  suspendedIntents: [],
  agreements: [],
  collectives: [],
  permissions: [],
  options: [{
    id: 'real-option-observe',
    characterAgendaItemId: 'agenda-real-1',
    summary: '观察门边的变化',
    reason: '眼前有可比较的现象',
    target: { kind: 'voxel', position: { x: 3, y: 4, z: 1 } },
    requiresFollowUp: false,
    semantics,
  }],
  followUpOptions: [],
  visiblePeople: [{
    id: 'real-person-other', name: '乙', ageMonths: 220, sex: 'male', health: 80, hydration: 70,
    nutrition: 70, conditions: [], cellId: 1, z: 1, trust: 4, bond: 2, fear: 0,
  }],
  visibleDrops: [{
    id: 'real-drop-1', name: '树枝', properties: ['solid'], perception: {}, quantity: 1, cellId: 1, z: 1,
  }],
  visibleAnimals: [{ id: 'real-animal-1', speciesId: 'hare', cellId: 1, z: 1, health: 80, hunger: 20 }],
  visibleContainers: [{
    id: 'real-container-1', position: { x: 2, y: 2, z: 1 }, capacity: 10, usedCapacity: 1, contents: [],
  }],
  visibleVoxels: [{ position: { x: 3, y: 4, z: 1 }, name: '石面', properties: ['solid', 'rigid'] }],
};

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/model-decision-gateway.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const {
    buildDecisionModelRequestProtocol,
    buildDecisionSystemPrompt,
    normalizeDecisionModelOutput,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  process.env.MODEL_CHARACTER_AGENDA_MODE = 'off';
  assert.doesNotMatch(buildDecisionSystemPrompt(), /characterAgendaUpdate/u,
    'gate off must not advertise the proposal protocol');
  process.env.MODEL_CHARACTER_AGENDA_MODE = 'proposal-v1';
  assert.match(buildDecisionSystemPrompt(), /characterAgendaUpdate/u,
    'gate on must advertise the proposal protocol');
  assert.match(buildDecisionSystemPrompt(), /start\/revise\/idle \u5bf9\u8c61\u7684\u53ef\u9009\u9876\u5c42\u5b57\u6bb5/u,
    'the normal decision envelope must explicitly allow an agenda update at top level');
  assert.match(buildDecisionSystemPrompt(), /"kind":"idle"[^\n]+"characterAgendaUpdate"/u,
    'the protocol must show a complete legal idle plus agenda JSON object, not a detached fragment');
  assert.match(buildDecisionSystemPrompt(), /\u4ee5\u540e\u4ecd\u4f1a\u5f71\u54cd\u4ed6\u9009\u62e9\u7684\u5173\u5207/u,
    'the model must distinguish a persistent concern from a one-off action before creating an agenda');
  assert.doesNotMatch(buildDecisionSystemPrompt(), /\u683c\u5f0f\u53ea\u80fd\u662f\u4ee5\u4e0b\u4e4b\u4e00/u,
    'the base envelope must not contradict its enabled optional top-level protocol');

  delete process.env.MODEL_CHARACTER_AGENDA_MODE;
  delete process.env.MODEL_DECISION_CONTEXT_MODE;
  const defaultProtocol = buildDecisionModelRequestProtocol(context);
  assert.equal(defaultProtocol.characterAgendaProposal, true,
    'long-term subjective updates must be a normal model capability by default');
  assert.equal(defaultProtocol.compact, true,
    'normal model evolution must use compact request-local context by default');
  process.env.MODEL_CHARACTER_AGENDA_MODE = 'proposal-v1';

  const off = buildDecisionModelRequestProtocol(context, { compact: false, characterAgendaProposal: false });
  assert.equal(off.requestContext.agendaProbeCandidates, undefined,
    'gate off must not add proposal candidates to the existing decision request');
  assert.equal(off.requestContext.options[0].characterAgendaItemId, undefined,
    'the full legacy request must not expose server-owned agenda linkage');
  const offDecision = normalizeDecisionModelOutput(context, {
    kind: 'start', optionId: 'real-option-observe', reason: '合法选择',
    characterAgendaProposal: { aim: '伪附加', theme: '伪附加', approach: { summary: '伪附加' } },
  }, off);
  assert.deepEqual(offDecision, { kind: 'start', optionId: 'real-option-observe', reason: '合法选择' },
    'gate off must ignore a proposal without disturbing the legal option decision');

  const full = buildDecisionModelRequestProtocol(context, { compact: false, characterAgendaProposal: true });
  assert.equal(full.compact, true, 'proposal mode must always use the request-scoped compact capability envelope');
  assert.equal(full.requestContext.commitments.characterAgenda.length, 4,
    'proposal context must bound existing agenda summaries');
  assert.deepEqual(full.requestContext.commitments.characterAgenda.map((item) => item.handle), ['g1', 'g2', 'g3', 'g4']);
  assert.equal(full.requestContext.options[0].agendaHandle, 'g1',
    'a compact option must expose the same request handle when local rules link it to an agenda');
  assert.doesNotMatch(JSON.stringify(full.requestContext.commitments.characterAgenda), /agenda-real|agenda-basis-real/u,
    'stable agenda identity must be replaced by request-scoped handles');
  assert.deepEqual(full.requestContext.agendaProbeCandidates.held.map((item) => item.handle), ['h1', 'h2']);
  assert.deepEqual(full.requestContext.agendaProbeCandidates.voxels.map((item) => item.handle), ['v1']);
  assert.doesNotMatch(JSON.stringify(full.requestContext.agendaProbeCandidates.voxels), /"position"|"x"|"y"|"z"/u,
    'the model must choose a visible voxel by request handle rather than authoritative coordinates');

  const compact = buildDecisionModelRequestProtocol(context, { compact: true, characterAgendaProposal: true });
  assert.equal(compact.requestContext.commitments.characterAgenda.length, 4,
    'compact context must bound existing agenda summaries');
  const compactPrivateView = JSON.stringify({
    inventory: compact.requestContext.person.inventory,
    visible: compact.requestContext.visible,
  });
  for (const realId of [
    'real-stack-leaf', 'real-stack-fiber', 'real-person-other', 'real-drop-1', 'real-animal-1', 'real-container-1',
  ]) assert.doesNotMatch(compactPrivateView, new RegExp(realId), 'compact inventory/visibility must not leak real ids');
  assert.match(compactPrivateView, /"handle":"h1"/u);
  assert.match(compactPrivateView, /"handle":"d1"/u);

  const capabilityContext = structuredClone(context);
  capabilityContext.options = Array.from({ length: 10 }, (_, index) => ({
    ...structuredClone(context.options[0]),
    id: `capability-option-${index + 1}`,
    summary: `能力包候选 ${index + 1}`,
    reason: `能力包候选理由 ${index + 1}`,
    requiresFollowUp: index === 0,
    characterAgendaItemId: index === 0 ? 'agenda-real-1' : undefined,
  }));
  capabilityContext.followUpOptions = Array.from({ length: 8 }, (_, index) => ({
    id: `capability-follow-up-${index + 1}`,
    summary: `后续候选 ${index + 1}`,
    reason: `后续候选理由 ${index + 1}`,
    semantics: structuredClone(semantics),
    matchesOptionIds: [capabilityContext.options[0].id],
  }));
  capabilityContext.person.cognition.optionAppraisals = [];
  const capabilityProtocol = buildDecisionModelRequestProtocol(capabilityContext, {
    compact: true, characterAgendaProposal: false,
  });
  const exposedOptions = new Set(capabilityProtocol.requestContext.options.map((item) => item.id));
  const hiddenOptionIndex = capabilityContext.options.findIndex((_, index) => !exposedOptions.has(`o${index + 1}`));
  assert.notEqual(hiddenOptionIndex, -1, 'fixture must produce a compact option gap');
  const hiddenOptionHandle = `o${hiddenOptionIndex + 1}`;
  const hiddenOptionId = capabilityContext.options[hiddenOptionIndex].id;
  assert.equal(normalizeDecisionModelOutput(capabilityContext, {
    kind: 'start', optionId: hiddenOptionId, reason: '绕过能力包',
  }, capabilityProtocol), null, 'compact must reject a hidden raw option id');
  assert.equal(normalizeDecisionModelOutput(capabilityContext, {
    kind: 'start', optionId: hiddenOptionHandle, reason: '猜测缺口句柄',
  }, capabilityProtocol), null, 'compact must reject an unexposed oN gap');

  assert.ok(exposedOptions.has('o1'), 'agenda-linked follow-up parent must stay exposed');
  const exposedFollowUps = new Set(capabilityProtocol.requestContext.followUpOptions.map((item) => item.id));
  const hiddenFollowUpIndex = capabilityContext.followUpOptions.findIndex((_, index) => !exposedFollowUps.has(`f${index + 1}`));
  assert.notEqual(hiddenFollowUpIndex, -1, 'fixture must produce a compact follow-up gap');
  const hiddenFollowUpHandle = `f${hiddenFollowUpIndex + 1}`;
  const hiddenFollowUpId = capabilityContext.followUpOptions[hiddenFollowUpIndex].id;
  assert.equal(normalizeDecisionModelOutput(capabilityContext, {
    kind: 'start', optionId: 'o1', followUpOptionId: hiddenFollowUpId, reason: '绕过后续能力包',
  }, capabilityProtocol), null, 'compact must reject a hidden raw follow-up id');
  assert.equal(normalizeDecisionModelOutput(capabilityContext, {
    kind: 'start', optionId: 'o1', followUpOptionId: hiddenFollowUpHandle, reason: '猜测后续缺口句柄',
  }, capabilityProtocol), null, 'compact must reject an unexposed fN gap');

  const rawProposal = {
    aim: '让寒冷月份的住处更安全',
    theme: '照护与庇护',
    importance: 84,
    horizonMonths: 18,
    basisKey: 'forged-basis',
    disposition: 'executable-now',
    sourceFactIds: ['forged-fact'],
    materialId: 999,
    output: 'forged-output',
    knowledge: 'forged-knowledge',
    observer: 'forged-observer',
    approach: {
      summary: '先比较手边两种物体合在一起后的变化',
      disposition: 'executable-now',
      sourceFactIds: ['forged-approach-fact'],
      recipe: 'forged-recipe',
      probe: { kind: 'combine', stackHandles: ['h1', 'h2'], output: 'forged-output' },
    },
  };
  const accepted = normalizeDecisionModelOutput(context, {
    kind: 'start', optionId: 'o1', reason: '先做小规模比较', characterAgendaProposal: rawProposal,
  }, compact);
  assert.equal(accepted.kind, 'start');
  assert.equal(accepted.optionId, 'real-option-observe',
    'existing compact option handles must still expand to authoritative ids');
  assert.deepEqual(accepted.characterAgendaProposal.approach.probe, {
    kind: 'combine', ownStackIds: ['real-stack-leaf', 'real-stack-fiber'],
  }, 'valid request-scoped handles must expand only inside the server-owned proposal');
  const sanitizedJson = JSON.stringify(accepted.characterAgendaProposal);
  for (const forbidden of [
    'forged-basis', 'forged-fact', 'forged-approach-fact', 'forged-recipe', 'forged-output',
    'forged-knowledge', 'forged-observer', 'materialId',
  ]) assert.doesNotMatch(sanitizedJson, new RegExp(forbidden), `forbidden field/value must not survive: ${forbidden}`);
  assert.equal(accepted.characterAgendaProposal.approach.disposition, 'bounded-experiment',
    'the model-supplied disposition must be replaced by a gateway-owned provisional classification');

  const selectedActionApproach = normalizeDecisionModelOutput(context, {
    kind: 'start', optionId: 'o1', reason: '先从眼前可行的一步开始',
    characterAgendaProposal: {
      aim: '逐月弄清门边变化的规律', theme: '探索', importance: 74, horizonMonths: 12,
      approach: { summary: '先执行眼前已经合法的观察' },
    },
  }, compact);
  assert.equal(selectedActionApproach.characterAgendaProposal.approach.disposition, 'executable-now',
    'omitting probe must explicitly mark the selected legal action as the current approach');

  const continuingAgenda = normalizeDecisionModelOutput(context, {
    kind: 'start', optionId: 'o1', reason: '给既有长期关切换一个眼前可行的方法',
    characterAgendaProposal: {
      agendaHandle: 'g1', aim: '继续长期关切 1', theme: '探索', importance: 76, horizonMonths: 18,
      approach: { summary: '先执行眼前已经合法的观察' },
    },
  }, compact);
  assert.equal(continuingAgenda.characterAgendaProposal.basisKey, 'agenda-basis-real-1',
    'a valid request handle must map back to the existing agenda identity');
  const staleAgendaHandle = normalizeDecisionModelOutput(context, {
    kind: 'start', optionId: 'o1', reason: '引用了过期的长期关切',
    characterAgendaProposal: {
      agendaHandle: 'g999', aim: '不应新建', theme: '探索', importance: 76, horizonMonths: 18,
      approach: { summary: '先执行眼前已经合法的观察' },
    },
  }, compact);
  assert.equal(staleAgendaHandle.characterAgendaProposal, undefined,
    'an unknown agenda handle must not silently create a duplicate concern');

  const unknownHandle = normalizeDecisionModelOutput(context, {
    kind: 'start', optionId: 'o1', reason: '目标仍可保留',
    characterAgendaProposal: {
      aim: '让寒冷月份的住处更安全', theme: '照护与庇护', importance: 80, horizonMonths: 18,
      approach: {
        summary: '试着组合手边物体',
        probe: { kind: 'combine', stackHandles: ['h1', 'h999'] },
      },
    },
  }, compact);
  assert.equal(unknownHandle.optionId, 'real-option-observe',
    'an unknown/stale probe handle must not invalidate the legal option decision');
  assert.equal(unknownHandle.characterAgendaProposal.approach.probe, undefined,
    'an unknown/stale probe handle must be dropped');
  assert.equal(unknownHandle.characterAgendaProposal.approach.disposition, 'missing-affordance');

  const activeContext = {
    ...context,
    activeIntent: {
      id: 'intent-current', summary: '继续既有安排', domain: 'strategic', status: 'active',
      createdAtMonth: 10, progress: 0.2, sourceFactIds: [],
    },
  };
  const activeProtocol = buildDecisionModelRequestProtocol(activeContext, {
    compact: true, characterAgendaProposal: true,
  });
  const repairedEnvelope = normalizeDecisionModelOutput(activeContext, {
    kind: 'start', optionId: 'o1', reason: '改做眼前合法的一步',
    characterAgendaProposal: {
      aim: '逐月弄清门边变化的规律', theme: '探索', importance: 74, horizonMonths: 12,
      approach: { summary: '先执行眼前已经合法的观察' },
    },
  }, activeProtocol);
  assert.equal(repairedEnvelope.kind, 'revise');
  assert.equal(repairedEnvelope.intentId, 'intent-current',
    'start/revise envelope errors may be repaired from authoritative active-Intent state');
  const illegalOption = normalizeDecisionModelOutput(activeContext, {
    kind: 'start', optionId: 'o999', reason: '不存在的候选',
  }, activeProtocol);
  assert.equal(illegalOption, null, 'repair must never infer or accept an illegal option handle');

  const idleContext = { ...context, options: [] };
  const idleProtocol = buildDecisionModelRequestProtocol(idleContext, { compact: false, characterAgendaProposal: true });
  const idle = normalizeDecisionModelOutput(idleContext, {
    kind: 'idle', reason: '暂不调整', characterAgendaProposal: rawProposal,
  }, idleProtocol);
  assert.deepEqual(idle, { kind: 'idle', reason: '暂不调整' },
    'legacy option-bound proposals remain ignored on idle');

  const autonomousAim = normalizeDecisionModelOutput(idleContext, {
    kind: 'idle',
    reason: '眼前没有能直接开始的做法',
    characterAgendaUpdate: {
      kind: 'create',
      aim: '弄明白门边石面在雨前为什么会变暗',
      theme: '观察与预备',
      importance: 73,
      horizonMonths: 18,
      sourceMemoryHandles: ['m1'],
      approach: { summary: '暂时还没有足够具体的观察办法' },
    },
  }, idleProtocol);
  assert.equal(autonomousAim.kind, 'idle');
  assert.equal(autonomousAim.characterAgendaUpdate.kind, 'create');
  assert.equal(autonomousAim.characterAgendaUpdate.proposal.aim, '弄明白门边石面在雨前为什么会变暗',
    'a person may retain a free long-term aim even when no executable option exists');
  assert.deepEqual(autonomousAim.characterAgendaUpdate.proposal.sourceFactIds, ['fact-memory-stone-1'],
    'a request-scoped memory handle must bind the durable concern to its real source fact');

  const reviseWithoutAction = normalizeDecisionModelOutput(idleContext, {
    kind: 'idle', reason: '新观察让我换个办法',
    characterAgendaUpdate: {
      kind: 'revise', agendaHandle: 'g1', aim: '继续长期关切 1', theme: '探索',
      importance: 78, horizonMonths: 24,
      approach: { summary: '先等下一次相同变化再比较' },
    },
  }, idleProtocol);
  assert.equal(reviseWithoutAction.characterAgendaUpdate.proposal.basisKey, 'agenda-basis-real-1',
    'revision resolves only a current request-scoped agenda handle');
  const pause = normalizeDecisionModelOutput(idleContext, {
    kind: 'idle', reason: '先把这件事放一放',
    characterAgendaUpdate: { kind: 'pause', agendaHandle: 'g1', reason: '眼下没有条件继续' },
  }, idleProtocol);
  assert.deepEqual(pause.characterAgendaUpdate, {
    kind: 'pause', basisKey: 'agenda-basis-real-1', reason: '眼下没有条件继续',
  });
  const stalePause = normalizeDecisionModelOutput(idleContext, {
    kind: 'idle', reason: '引用过期',
    characterAgendaUpdate: { kind: 'abandon', agendaHandle: 'g999', reason: '不再继续' },
  }, idleProtocol);
  assert.equal(stalePause.characterAgendaUpdate, undefined,
    'a stale agenda handle cannot pause or abandon any durable concern');

  const openSemantics = {
    version: 'action-option-semantics-v1', obligation: 'optional', planningChannel: 'ordinary',
    purpose: 'conversation', minimumLifeStage: 'adult', needKinds: ['belonging'],
    conversation: { turn: 'opening', topic: 'open' },
    socialContext: {
      cooperationKind: 'conversation', phase: 'opening', counterpartIds: ['real-person-other'],
      conversationTopic: 'open',
    },
  };
  const openOption = (id, listenerId, sourceFactId) => ({
    id, summary: '进行开放交谈', reason: '对方就在身边', requiresFollowUp: false,
    target: { kind: 'person', personId: listenerId }, communicationKind: 'claim',
    semantics: {
      ...openSemantics,
      socialContext: { ...openSemantics.socialContext, counterpartIds: [listenerId] },
    },
    openConversationGrounding: {
      version: 'open-conversation-grounding-v1', listenerId,
      fallbackSourceFactIds: [sourceFactId],
      facts: [{ kind: 'relationship', sourceFactId, summary: '双方已有相识来源' }],
    },
  });
  const openContext = structuredClone(context);
  openContext.person.memories = [{
    id: 'agent-memory:real-person-self:open-a', lane: 'dialogue', gist: '记得乙前些天总在河边停留',
    precision: 'specific', confidence: 90, salience: 90, emotionalValence: 0.2,
    unresolved: true, firstExperiencedAtMonth: 11, lastExperiencedAtMonth: 11,
    lastRecalledAtMonth: 11, personIds: ['real-person-other'], topicKeys: ['river'],
    sourceEventIds: ['real-memory-source-a'],
  }];
  openContext.person.knowledge = [{
    id: 'knowledge-open-a', kind: 'observation', summary: '河水最近变得浑浊', confidence: 85,
    learnedAtMonth: 11, sourceEventIds: ['real-knowledge-source-a'],
  }];
  openContext.options = [
    openOption('open-a', 'real-person-other', 'real-source-a'),
    openOption('open-b', 'real-person-third', 'real-source-b'),
    structuredClone(context.options[0]),
  ];
  openContext.options[0].openConversationGrounding.facts = [
    ...Array.from({ length: 6 }, (_, index) => ({
      kind: 'memory', sourceFactId: `real-memory-source-${index + 1}`, summary: '记得乙前些天总在河边停留',
      memoryKind: 'dialogue',
    })),
    {
      kind: 'knowledge', sourceFactId: 'real-knowledge-source-a', summary: '河水最近变得浑浊',
      knowledgeId: 'knowledge-open-a',
    },
    { kind: 'relationship', sourceFactId: 'real-source-a', summary: '双方已有相识来源' },
  ];
  openContext.person.cognition.optionAppraisals = [];
  const openProtocol = buildDecisionModelRequestProtocol(openContext, {
    compact: true, characterAgendaProposal: false,
  });
  const { openConversationGrounding: _legacyGrounding, ...legacyOpening } = openOption(
    'legacy-everyday-opening', 'real-person-other', 'legacy-source',
  );
  legacyOpening.semantics = {
    ...structuredClone(openSemantics),
    conversation: { turn: 'opening', topic: 'everyday' },
    socialContext: {
      ...structuredClone(openSemantics.socialContext),
      counterpartIds: ['real-person-other'],
      conversationTopic: 'everyday',
    },
  };
  const fullVisibilityContext = structuredClone(openContext);
  fullVisibilityContext.options = [legacyOpening, ...openContext.options];
  const fullVisibilityProtocol = buildDecisionModelRequestProtocol(fullVisibilityContext, {
    compact: false, characterAgendaProposal: false,
  });
  assert.equal(fullVisibilityProtocol.requestContext.options.some((option) => (
    option.id === legacyOpening.id
  )), false, 'full model requests must hide legacy preselected opening menus too');
  assert.equal(normalizeDecisionModelOutput(fullVisibilityContext, {
    kind: 'start', optionId: legacyOpening.id, reason: '猜中隐藏的旧话题菜单',
  }, fullVisibilityProtocol), null,
  'a legacy opening hidden from the full request capability envelope must fail closed');
  const openA = openProtocol.requestContext.options.find((option) => option.id === 'o1');
  const openB = openProtocol.requestContext.options.find((option) => option.id === 'o2');
  assert.deepEqual(new Set(openA.groundingFacts.map((fact) => fact.kind)), new Set(['memory', 'knowledge', 'relationship']),
    'bounded grounding handles must retain kind diversity instead of letting memories fill every slot');
  assert.doesNotMatch(JSON.stringify(openProtocol.requestContext.options), /real-(?:source|memory-source|knowledge-source)-/u,
    'open grounding must expose request handles rather than authoritative source ids');
  const openGrounded = normalizeDecisionModelOutput(openContext, {
    kind: 'start', optionId: 'o1', reason: '想问问对方最近在想什么',
    utterance: '你这两天总盯着河边看，是在担心什么吗？',
    groundingFactHandles: [openA.groundingFacts[0].handle, openA.groundingFacts[0].handle],
  }, openProtocol);
  assert.deepEqual(openGrounded.groundingSourceFactIds, ['real-memory-source-1'],
    'gateway must deduplicate and expand only the selected open option grounding handles');
  const subjectiveOnlyOpen = normalizeDecisionModelOutput(openContext, {
    kind: 'start', optionId: 'o1', reason: '只问当下感受',
    utterance: '你现在想一个人待会儿，还是愿意跟我说说？', groundingFactHandles: [],
  }, openProtocol);
  assert.deepEqual(subjectiveOnlyOpen.groundingSourceFactIds, [],
    'zero handles must remain an explicit empty selection so application can use the server-owned encounter anchor');
  const crossListenerGrounding = normalizeDecisionModelOutput(openContext, {
    kind: 'start', optionId: 'o1', reason: '伪造跨听者来源', utterance: '我想跟你谈谈。',
    groundingFactHandles: [openB.groundingFacts[0].handle],
  }, openProtocol);
  assert.equal(crossListenerGrounding, null,
    'a grounding handle belonging to another open/listener must fail closed');
  assert.equal(normalizeDecisionModelOutput(openContext, {
    kind: 'start', optionId: 'o1', reason: '缺少真实话语', groundingFactHandles: [],
  }, openProtocol), null, 'open conversation without an actual utterance must fail closed');
  assert.equal(normalizeDecisionModelOutput(openContext, {
    kind: 'start', optionId: 'o3', reason: '非对话夹带来源', groundingFactHandles: [openA.groundingFacts[0].handle],
  }, openProtocol), null, 'non-open options may not carry open grounding handles');

  console.log('character agenda model protocol test passed');
} finally {
  if (previousAgendaMode === undefined) delete process.env.MODEL_CHARACTER_AGENDA_MODE;
  else process.env.MODEL_CHARACTER_AGENDA_MODE = previousAgendaMode;
  if (previousDecisionContextMode === undefined) delete process.env.MODEL_DECISION_CONTEXT_MODE;
  else process.env.MODEL_DECISION_CONTEXT_MODE = previousDecisionContextMode;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
