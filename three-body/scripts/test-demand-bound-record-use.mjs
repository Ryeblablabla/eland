import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-record-use-test-'));
const bundlePath = path.join(temporaryDirectory, 'record-use.mjs');

try {
  const testEntry = `
    export {
      createInitialState,
      executeActiveIntent,
      resolveInterruptedIntentReturn,
      RulePlanner,
      startInterruptIntent,
      stepSimulation,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext, visibleCellsFor } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { planLocallyForTick } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/tick-planner.ts'))};
    export {
      buildDemandBoundRecordUseOptions,
      recompileRecordUseNextAction,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/record-use-options.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-proposals.ts'))};
    export {
      executePrimitiveAction,
      goalSatisfied,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export {
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { followUpSemanticallyMatches } from ${JSON.stringify(path.resolve('src/game/eland/domain/intent-follow-up.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export { findStandingPath, surfaceStandingPosition } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
    export { buildEvolutionFactsReport } from ${JSON.stringify(path.resolve('server/evolution-artifacts.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=demand-bound-record-use-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    RulePlanner,
    appendCommittedEvents,
    buildDecisionContext,
    buildDemandBoundRecordUseOptions,
    buildEvolutionFactsReport,
    createInitialState,
    deriveProjectProposals,
    executeActiveIntent,
    executePrimitiveAction,
    findStandingPath,
    followUpSemanticallyMatches,
    goalSatisfied,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    planLocallyForTick,
    recompileRecordUseNextAction,
    resolveInterruptedIntentReturn,
    startInterruptIntent,
    stepSimulation,
    surfaceStandingPosition,
    visibleCellsFor,
  } = simulation;

  const makeFixture = ({ publicAtReader = true } = {}) => {
    const state = createInitialState(821, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    const reader = state.people[0];
    const author = state.people[1];
    reader.bornAtMonth = -20 * 12;
    author.bornAtMonth = -20 * 12;
    author.position = structuredClone(reader.position);
    appendCommittedEvents(state, [
      {
        id: 'made-stone-tool', kind: 'environment', atMonth: 11, orderInMonth: 0,
        cellId: reader.position.cellId, change: 'resource', who: reader.id,
        result: '专项夹具：真实石制工具来源', diff: { materialId: Material.StoneTool },
      },
      {
        id: 'gathered-wood', kind: 'environment', atMonth: 11, orderInMonth: 1,
        cellId: reader.position.cellId, change: 'resource', who: reader.id,
        result: '专项夹具：真实木材来源', diff: { materialId: Material.Wood },
      },
      {
        id: 'record-prepare-visible-wood', kind: 'environment', atMonth: 11, orderInMonth: 2,
        cellId: reader.position.cellId, change: 'resource', who: reader.id,
        result: '专项夹具：真实备料木材来源', diff: { materialId: Material.Wood },
      },
    ]);
    reader.inventory = [
      { id: 'reader-stone-tool', materialId: Material.StoneTool, quantity: 1, sourceEventIds: ['made-stone-tool'] },
      { id: 'reader-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['gathered-wood'] },
    ];
    author.inventory = [];
    const spearRule = inventoryCombinationForOutput(Material.Spear);
    assert.ok(spearRule);
    const techniqueId = inventoryCombinationTechniqueId(spearRule);
    const codebookId = `codebook:fixture:${techniqueId}`;
    reader.knowledge = [{
      id: codebookId, kind: 'codebook', summary: '能辨认这组刻痕', confidence: 60,
      learnedAtMonth: 10, sourceEventIds: ['codebook-teaching'],
    }];
    author.knowledge = [{
      id: techniqueId, kind: 'technique', summary: '石制工具与木材可结合成长矛', confidence: 80,
      learnedAtMonth: 7, sourceEventIds: ['author-experiment'],
    }];
    const record = {
      id: 'record-demand-fixture', authorId: author.id, knowledgeId: techniqueId,
      codebookId, kind: 'technique', summary: '石制工具与木材可结合成长矛',
      version: 1, createdAtMonth: 8, sourceEventIds: ['record-writing'],
    };
    state.records = [record];
    const project = {
      id: 'project-record-use-fixture', kind: 'production', need: 'hunting-safety',
      desiredFunction: 'safer-hunting', summary: '降低下一次捕猎受伤风险',
      ownerId: reader.id, beneficiaryIds: [reader.id], triggerFactIds: ['failed-hunt'],
      pressure: 74, createdAtMonth: 9, reviewAtMonth: 24, status: 'active',
      lastProgressAtMonth: 12, missingMaterialIds: [], materialDemands: [], reservations: [],
      contributorIds: [reader.id], actionEventIds: [], failureEventIds: ['failed-hunt'],
      completionEventIds: [], progressEvidence: [], searchCampaigns: [], logisticsEpisodes: [],
    };
    state.projects = [project];
    const parent = {
      id: 'parent-record-project-intent', ownerId: reader.id, summary: project.summary,
      domain: 'strategic', goal: { kind: 'project-completed', projectId: project.id },
      nextAction: { kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: reader.id, stackId: 'reader-stone-tool' },
        { kind: 'inventory-stack', personId: reader.id, stackId: 'reader-wood' },
      ] },
      status: 'active', createdAtMonth: 9, lastProgressAtMonth: 12, progress: 0.3,
      sourceDecisionEventId: 'project-decision', projectId: project.id,
      sourceFactIds: ['failed-hunt'], actionEventIds: [], replanCount: 0,
    };
    state.intents = [parent];
    reader.activeIntentId = parent.id;
    const publicDrop = {
      id: 'public-record-drop', materialId: Material.WoodTablet,
      cellId: reader.position.cellId, z: reader.position.z, quantity: 1,
      createdAtMonth: 8, sourceEventIds: ['record-writing', 'record-publication'],
      sourceLineageKeys: ['inventory:author:published-carrier'], recordPayloadId: record.id,
    };
    state.world.drops = publicAtReader ? [publicDrop] : [];
    return { state, reader, author, record, project, parent, publicDrop, techniqueId, codebookId };
  };

  const startRecordUseChild = (fixture, option, atMonth = 13) => {
    const context = {
      state: fixture.state,
      person: fixture.reader,
      visibleCells: visibleCellsFor(fixture.reader),
      visiblePeople: [fixture.author],
      visibleDrops: fixture.state.world.drops.filter((drop) => drop.quantity > 0),
      visibleAnimals: [],
      options: [option],
      followUpOptions: [],
      activeIntent: fixture.parent,
    };
    const decision = new RulePlanner().decideAt(context, { atMonth, planningTick: 2 });
    assert.equal(decision.kind, 'revise');
    assert.equal(decision.mode, 'interrupt');
    assert.equal(decision.interruptionKind, 'record-use');
    const child = startInterruptIntent(
      fixture.state, fixture.reader, context, option.id, `record-use-decision-${atMonth}`, atMonth, 'record-use',
    );
    assert.ok(child);
    return child;
  };

  const appendIntentAction = (fixture, atMonth, actionTick) => {
    const nextOrderInMonth = fixture.state.world.past
      .filter((event) => event.atMonth === atMonth)
      .reduce((highest, event) => Math.max(highest, event.orderInMonth), -1) + 1;
    const fact = executeActiveIntent(
      fixture.state, fixture.reader, atMonth, nextOrderInMonth, actionTick,
    );
    assert.ok(fact && fact.kind === 'action');
    appendCommittedEvents(fixture.state, [fact]);
    return fact;
  };

  const reportFor = (state, runId) => buildEvolutionFactsReport(state, {
    schemaVersion: 2,
    runId,
    provider: 'local',
    model: 'local-rules',
    status: 'completed',
    startedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    fromMonth: 0,
    requestedEndMonth: state.clock.elapsedMonths,
    reachedMonth: state.clock.elapsedMonths,
    checkpoints: [],
    turningPoints: [],
  });

  const durableRecordProposalsFor = (state, author) => {
    const visibleCells = visibleCellsFor(author);
    const visible = new Set(visibleCells);
    return deriveProjectProposals(
      state,
      author,
      visibleCells,
      state.world.drops.filter((drop) => drop.quantity > 0 && visible.has(drop.cellId)),
      state.people.filter((person) => person.id !== author.id
        && person.diedAtMonth === undefined
        && visible.has(person.position.cellId)),
    ).filter((candidate) => candidate.desiredFunction === 'durable-record');
  };

  const makeRequestBoundRecordFixture = () => {
    const state = createInitialState(822, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.past = [];
    state.world.historyCursor = { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null };
    state.projects = [];
    state.intents = [];
    state.records = [];
    const author = state.people[0];
    const requester = state.people[1];
    for (const person of state.people.slice(2)) person.diedAtMonth = 0;
    for (const person of [author, requester]) {
      person.diedAtMonth = undefined;
      person.bornAtMonth = -20 * 12;
      person.conditions = [];
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.inventory = [];
      person.knowledge = [];
      delete person.activeIntentId;
    }
    requester.position = structuredClone(author.position);
    const millRule = inventoryCombinationForOutput(Material.Mill);
    const spearRule = inventoryCombinationForOutput(Material.Spear);
    assert.ok(millRule && spearRule);
    const techniqueId = inventoryCombinationTechniqueId(millRule);
    const priorTechniqueId = inventoryCombinationTechniqueId(spearRule);
    author.knowledge = [{
      id: techniqueId, kind: 'technique', summary: '石与木板能做成磨坊', confidence: 80,
      learnedAtMonth: 8, sourceEventIds: ['author-mill-trial-a', 'author-mill-trial-b'],
    }];
    state.records.push({
      id: 'prior-unrelated-author-record', authorId: author.id, knowledgeId: priorTechniqueId,
      codebookId: 'codebook:prior-unrelated', kind: 'technique', summary: '先前写下的另一项技术',
      version: 1, createdAtMonth: 7, sourceEventIds: ['prior-record-write'],
    });
    const projectId = 'project-async-record-request';
    const source = state.world.mechanicalPower.sources[0];
    assert.ok(source);
    const project = {
      id: projectId, kind: 'production', need: 'mechanical-power-capability',
      desiredFunction: 'water-powered-crop-processing', summary: '为固定磨坊补齐未知部件',
      ownerId: requester.id, beneficiaryIds: [requester.id], triggerFactIds: ['requester-water-work'],
      pressure: 70, createdAtMonth: 10, reviewAtMonth: 30, status: 'active',
      lastProgressAtMonth: 12, missingMaterialIds: [], materialDemands: [], reservations: [],
      contributorIds: [requester.id], actionEventIds: [], failureEventIds: [],
      completionEventIds: [], progressEvidence: [], searchCampaigns: [], logisticsEpisodes: [],
      site: { cellId: requester.position.cellId, z: requester.position.z },
      mechanicalPowerPlan: {
        version: 'mechanical-power-plan-v1', projectId, sourceSegmentId: source.id,
        wheelPosition: { ...source.from }, shaftPositions: [], loadPosition: { ...source.to },
        sourceKeys: [...source.sourceKeys],
      },
    };
    state.projects.push(project);
    const requestFact = executePrimitiveAction(state, requester, {
      kind: 'communicate',
      content: {
        id: 'request-async-mill-knowledge', kind: 'request', summary: '谁知道怎样做出磨坊部件？',
        projectKnowledgeRequest: {
          version: 'project-knowledge-request-v1', projectId, requesterId: requester.id,
          outputMaterialId: Material.Mill, expiresAtMonth: 25,
        },
      },
      audience: [author.id], channel: 'voice',
    }, 13, 0, { cause: 'intent', actionTick: 1 });
    assert.equal(requestFact.status, 'completed');
    appendCommittedEvents(state, [requestFact]);
    project.actionEventIds.push(requestFact.id);
    project.lastProgressAtMonth = 13;
    state.clock.elapsedMonths = 13;
    return { state, author, requester, project, requestFact, techniqueId };
  };

  const runAlreadyReviewedSchedulingFixture = ({ publishRecord, requestResponse = false }) => {
    const fixture = makeFixture({ publicAtReader: false });
    const requester = fixture.state.people[2];
    assert.ok(requester);
    fixture.state.people = requestResponse
      ? [fixture.reader, fixture.author, requester]
      : [fixture.reader, fixture.author];
    fixture.project.pressure = 10;
    fixture.parent.stateGoalUntilMonth = 12;
    if (requestResponse) {
      requester.bornAtMonth = -20 * 12;
      requester.position = structuredClone(fixture.reader.position);
      const readerToRequester = fixture.reader.relations.find((relation) => relation.personId === requester.id);
      assert.ok(readerToRequester);
      Object.assign(readerToRequester, { trust: 0, bond: 0, sourceEventIds: [] });
      const requestId = 'same-month-company-request';
      const requestIntent = {
        id: 'intent-same-month-company-request', ownerId: requester.id,
        summary: '向记录读者提出需要本人回应的陪伴请求', domain: 'social',
        goal: { kind: 'representation-made', representationId: requestId },
        nextAction: {
          kind: 'communicate',
          content: {
            id: requestId, kind: 'request', summary: '请陪我一起面对眼前处境',
            proposal: {
              kind: 'assist', requesterId: requester.id, helperId: fixture.reader.id,
              need: 'company', expiresAtMonth: 17,
            },
          },
          audience: [fixture.reader.id], channel: 'voice',
        },
        status: 'active', createdAtMonth: 12, lastProgressAtMonth: 12, progress: 0,
        sourceDecisionEventId: 'decision-same-month-company-request',
        sourceFactIds: [], actionEventIds: [], replanCount: 0,
      };
      fixture.state.intents.push(requestIntent);
      requester.activeIntentId = requestIntent.id;
    }
    if (publishRecord) {
      const carrierStackId = 'author-private-record-to-publish';
      fixture.author.inventory = [{
        id: carrierStackId, materialId: Material.WoodTablet, quantity: 1,
        recordPayloadId: fixture.record.id, sourceEventIds: ['record-writing'],
      }];
      const publicationIntent = {
        id: 'intent-publish-record-during-reviewed-month', ownerId: fixture.author.id,
        summary: '把本人写成的记录放到公共地面', domain: 'strategic',
        goal: { kind: 'representation-made', representationId: 'publication-complete-after-transfer' },
        nextAction: {
          kind: 'transfer', materialId: Material.WoodTablet, quantity: 1,
          from: { kind: 'person', personId: fixture.author.id },
          to: { kind: 'ground', cellId: fixture.reader.position.cellId, z: fixture.reader.position.z },
          stackId: carrierStackId,
        },
        status: 'active', createdAtMonth: 12, lastProgressAtMonth: 12, progress: 0,
        sourceDecisionEventId: 'decision-publish-record-during-reviewed-month',
        sourceFactIds: ['record-writing'], actionEventIds: [], replanCount: 0,
      };
      fixture.state.intents.push(publicationIntent);
      fixture.author.activeIntentId = publicationIntent.id;
    }

    const localPlanner = new RulePlanner();
    const readerPlanningCalls = [];
    const decideForReader = (context, moment) => {
      const recordOption = context.options.find((option) => option.recordUseBasis);
      const decision = recordOption
        ? {
            kind: 'revise', intentId: context.activeIntent.id, optionId: recordOption.id,
            mode: 'interrupt', interruptionKind: 'record-use',
            reason: '专项验证：已完成月初复核后出现真实公共记录',
          }
        : localPlanner.decideAt(context, moment);
      readerPlanningCalls.push({
        planningTick: moment.planningTick,
        hasRecordOption: Boolean(recordOption),
        decision: structuredClone(decision),
      });
      return decision;
    };
    const planner = {
      decide(context) {
        if (context.person.id !== fixture.reader.id) return { kind: 'idle', reason: '不干扰 record-use 调度专项' };
        return decideForReader(context, { atMonth: 13, planningTick: 1 });
      },
      decideAt(context, moment) {
        if (context.person.id !== fixture.reader.id) return { kind: 'idle', reason: '不干扰 record-use 调度专项' };
        return decideForReader(context, moment);
      },
    };
    const result = stepSimulation(fixture.state, planner);
    return { fixture, result, readerPlanningCalls };
  };

  {
    const fixture = makeRequestBoundRecordFixture();
    assert.equal(durableRecordProposalsFor(fixture.state, fixture.author)
      .some((candidate) => candidate.targetKnowledgeId === fixture.techniqueId), false,
    'a request that can be answered by direct speech now must not be diverted into a record project');

    const remotePosition = visibleCellsFor(fixture.author)
      .flatMap((candidateCellId) => {
        const standing = surfaceStandingPosition(fixture.state.world.grid, candidateCellId);
        if (!standing) return [];
        const route = findStandingPath(fixture.state.world.grid, fixture.author.position, standing);
        return route.length > 3 ? [{ standing, route }] : [];
      })
      .sort((left, right) => right.route.length - left.route.length)[0]?.standing;
    assert.ok(remotePosition);
    fixture.requester.position = structuredClone(remotePosition);
    const [asyncRecord] = durableRecordProposalsFor(fixture.state, fixture.author)
      .filter((candidate) => candidate.targetKnowledgeId === fixture.techniqueId);
    assert.ok(asyncRecord,
      'a personally heard request that remains open after separation should create an asynchronous record project');
    assert.deepEqual(asyncRecord.site, fixture.project.site,
      'the physical publication site must be the requester project site, not the author current position');
    assert.ok(asyncRecord.beneficiaryIds.includes(fixture.requester.id));
    assert.ok(asyncRecord.beneficiaryIds.includes(fixture.author.id));
    assert.ok(asyncRecord.triggerFactIds.includes(fixture.requestFact.id),
      'the proposal must retain the exact heard request action as causal evidence');
    assert.ok(asyncRecord.pressureBasis.sourceFactIds.includes(fixture.requestFact.id));
    assert.ok(asyncRecord.pressureBasis.reasonKeys.includes('heard-open-project-knowledge-request'));
    assert.ok(asyncRecord.pressure >= 64,
      'a still-open explicit project request should be actionable without waiting for old-age continuity pressure');

    const ungroundedState = structuredClone(fixture.state);
    const ungroundedProject = ungroundedState.projects.find((project) => project.id === fixture.project.id);
    assert.ok(ungroundedProject?.knowledgeRequests?.[0]);
    ungroundedProject.knowledgeRequests[0].requestEventId = 'forged-unheard-request';
    assert.equal(durableRecordProposalsFor(
      ungroundedState,
      ungroundedState.people.find((person) => person.id === fixture.author.id),
    ).some((candidate) => candidate.targetKnowledgeId === fixture.techniqueId), false,
    'a request basis without its completed heard communication fact cannot motivate publication');

    fixture.state.records.push({
      id: 'already-authored-request-knowledge', authorId: fixture.author.id,
      knowledgeId: fixture.techniqueId, codebookId: 'codebook:already-authored-request-knowledge',
      kind: 'technique', summary: '已经写过同一项磨坊知识', version: 1,
      createdAtMonth: 13, sourceEventIds: ['already-authored-request-knowledge-write'],
    });
    assert.equal(durableRecordProposalsFor(fixture.state, fixture.author)
      .some((candidate) => candidate.targetKnowledgeId === fixture.techniqueId), false,
    'the same author and knowledge pair remains deduplicated');
  }

  {
    const fixture = makeRequestBoundRecordFixture();
    fixture.state.projects = [];
    fixture.state.world.past = [];
    fixture.state.world.historyCursor = { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null };
    fixture.author.bornAtMonth = -61 * 12;
    const cappedFallback = durableRecordProposalsFor(fixture.state, fixture.author)
      .find((candidate) => candidate.targetKnowledgeId === fixture.techniqueId);
    assert.equal(cappedFallback, undefined,
      'ordinary age/memory continuity should stop after one representative work instead of dumping every technique');

    fixture.state.records = [];
    const [fallback] = durableRecordProposalsFor(fixture.state, fixture.author)
      .filter((candidate) => candidate.targetKnowledgeId === fixture.techniqueId);
    assert.ok(fallback,
      'a person without any authored record should still be able to leave one age/memory fallback work');
    assert.deepEqual(fallback.beneficiaryIds, [fixture.author.id]);
    assert.deepEqual(fallback.site, {
      cellId: fixture.author.position.cellId,
      z: fixture.author.position.z,
    });
  }

  {
    const { fixture, result, readerPlanningCalls } = runAlreadyReviewedSchedulingFixture({ publishRecord: false });
    assert.equal(readerPlanningCalls[0]?.decision.interruptionKind, 'life-review',
      'the deterministic month must begin with one real life review of the active project');
    assert.ok(result.agreements.some((agreement) => agreement.proposerId === fixture.reader.id
      && agreement.proposal.kind === 'companion'),
      'that first review must create a same-month proposal before the parent project resumes');
    assert.equal(readerPlanningCalls.some((call) => call.hasRecordOption), false,
      'without any perceived written carrier, later obligation or terminal reviews must not fabricate record use');
    assert.equal(result.lastStep.filter((event) => event.kind === 'decision'
      && event.who === fixture.reader.id
      && event.decision.lifeReview).length, 1,
      'a same-month proposal must not manufacture a second life-review decision');
  }

  {
    const { fixture, result, readerPlanningCalls } = runAlreadyReviewedSchedulingFixture({ publishRecord: true });
    assert.equal(readerPlanningCalls[0]?.hasRecordOption, false,
      'the month-opening life review must not see a carrier that has not been published yet');
    assert.equal(readerPlanningCalls.filter((call) => call.hasRecordOption).length, 1,
      'a matching carrier published after the first review must trigger exactly one fresh record-use review');
    assert.ok(result.lastStep.some((event) => event.kind === 'decision'
      && event.who === fixture.reader.id
      && event.decision.interruptionKind === 'record-use'),
      'the fresh public record must still interrupt back into a return-bound record-use child');
  }

  {
    const { readerPlanningCalls } = runAlreadyReviewedSchedulingFixture({
      publishRecord: false,
      requestResponse: true,
    });
    assert.equal(readerPlanningCalls[1]?.decision.interruptionKind, 'required-response',
      'an addressed same-month proposal alone must wake an already reviewed person for its required response');
    assert.equal(readerPlanningCalls[1]?.hasRecordOption, false,
      'proposal-only scheduling must not depend on or fabricate a record-use option');
  }

  {
    const { fixture, result, readerPlanningCalls } = runAlreadyReviewedSchedulingFixture({
      publishRecord: true,
      requestResponse: true,
    });
    assert.ok(result.lastStep.some((event) => event.kind === 'action'
      && event.who === fixture.author.id
      && event.diff.recordPayloadId === fixture.record.id
      && event.action.kind === 'transfer'
      && event.action.to.kind === 'ground'),
      'the priority fixture must really publish the matching record during the same month');
    assert.equal(readerPlanningCalls[1]?.decision.interruptionKind, 'required-response',
      'when a same-month required proposal and public record coexist, the required response must win');
  }

  {
    const fixture = makeFixture();
    const sharedAction = {
      id: 'shared-project-action', kind: 'action', actionTick: 1, atMonth: 11, orderInMonth: 0,
      cellId: fixture.reader.position.cellId, who: fixture.author.id, cause: 'intent',
      action: { kind: 'move', toCellId: fixture.reader.position.cellId, toZ: fixture.reader.position.z },
      fromCellId: fixture.reader.position.cellId, toCellId: fixture.reader.position.cellId,
      fromZ: fixture.reader.position.z, toZ: fixture.reader.position.z,
      pathSegment: [fixture.reader.position.cellId], status: 'completed',
      result: '双方在共同项目中完成了一项真实行动', diff: {},
    };
    appendCommittedEvents(fixture.state, [sharedAction]);
    fixture.project.actionEventIds.push(sharedAction.id);
    fixture.project.contributorIds.push(fixture.author.id);
    const context = buildDecisionContext(fixture.state, fixture.reader, 13);
    const use = context.options.find((option) => option.id.startsWith('use-demand-record:'));
    assert.equal(use?.recordUseBasis?.version, 'record-use-basis-v3',
      'the normal decision context must pass only its visibility-filtered public drops into record use');
    assert.equal(use?.recordUseBasis?.carrierSource.kind, 'ground');
    const opening = context.options.find((option) => option.id.startsWith('conversation:shared-work:'));
    assert.ok(opening, 'shared project evidence should expose the reachable grounded-conversation regression');
    assert.equal(followUpSemanticallyMatches(opening, use), true,
      'the conversation and record use deliberately share a project action source');
    assert.equal(context.followUpOptions.some((option) => option.id === use.id), false,
      'record use remains a primary option and must never become a generic conversation follow-up');
    const recordOnlyContext = { ...context, options: [use] };
    const decision = new RulePlanner().decideAt(recordOnlyContext, { atMonth: 13, planningTick: 2 });
    assert.equal(decision.kind, 'revise');
    assert.equal(decision.mode, 'interrupt');
    assert.equal(decision.interruptionKind, 'record-use');
    const child = startInterruptIntent(
      fixture.state, fixture.reader, recordOnlyContext, use.id,
      'record-use-not-conversation-follow-up', 13, 'record-use',
    );
    assert.equal(child?.returnToIntentId, fixture.parent.id,
      'choosing the primary record option must suspend and return to the exact parent project');
    assert.equal(fixture.parent.status, 'suspended');
  }

  {
    const fixture = makeFixture();
    delete fixture.parent.projectId;
    fixture.parent.goal = { kind: 'body-at-least', field: 'health', value: 100 };
    fixture.parent.stateGoalUntilMonth = 20;
    let reviewedContext;
    planLocallyForTick(
      fixture.state,
      fixture.reader,
      13,
      2,
      [],
      {
        decide(context) {
          reviewedContext = context;
          return { kind: 'idle', reason: '只验证记录预检' };
        },
      },
      new Set([fixture.reader.id]),
    );
    assert.ok(reviewedContext?.options.some((option) => option.recordUseBasis?.version === 'record-use-basis-v3'),
      'a perceived carrier must wake record-use preflight for a generic non-project intent when an owned project has the exact gap');
  }

  {
    const fixture = makeFixture();
    const projectBeforePreview = structuredClone(fixture.project);
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]);
    assert.ok(use, 'a visible public record should serve the reader\'s own active project deficit');
    assert.equal(use.recordUseBasis?.version, 'record-use-basis-v3');
    assert.deepEqual(use.recordUseBasis?.carrierSource, {
      kind: 'ground', dropId: fixture.publicDrop.id,
      cellId: fixture.publicDrop.cellId, z: fixture.publicDrop.z,
    });
    assert.equal(use.recordUseBasis?.acquisitionRequired, true);
    assert.equal(use.recordUseStage, 'acquire');
    assert.equal(use.nextAction.kind, 'transfer');
    assert.deepEqual(fixture.project, projectBeforePreview, 'preview compilation must not mutate the project');

    const child = startRecordUseChild(fixture, use);
    assert.equal(child.returnToIntentId, fixture.parent.id);
    assert.equal(fixture.parent.status, 'suspended');

    const acquireFact = appendIntentAction(fixture, 13, 2);
    assert.equal(acquireFact.status, 'completed');
    assert.equal(acquireFact.action.kind, 'transfer');
    assert.equal(acquireFact.diff.recordUseStage, 'acquire');
    assert.equal(acquireFact.diff.recordUseCarrierSourceId, fixture.publicDrop.id);
    assert.ok(fixture.reader.inventory.some((stack) => stack.recordPayloadId === fixture.record.id));

    const readFact = appendIntentAction(fixture, 13, 3);
    assert.equal(readFact.status, 'completed');
    assert.equal(readFact.action.kind, 'attend');
    assert.equal(readFact.diff.recordUseStage, 'read');
    assert.equal(readFact.diff.understood, true);
    const tentative = fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId);
    assert.ok(tentative?.sourceEventIds.includes(fixture.record.id));
    assert.ok(tentative.confidence <= 54, 'reading alone must remain tentative');
    const confidenceAfterRead = tentative.confidence;

    const experimentFact = appendIntentAction(fixture, 13, 4);
    assert.equal(experimentFact.status, 'completed');
    assert.equal(experimentFact.action.kind, 'act');
    assert.equal(experimentFact.diff.recordUseStage, 'experiment');
    assert.equal(experimentFact.diff.outputMaterialId, Material.Spear);
    assert.equal(
      fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId)?.confidence,
      confidenceAfterRead + 18,
      'real experiment raises the tentative technique by exactly 18',
    );
    assert.equal(fixture.project.status, 'completed');
    assert.ok(fixture.project.progressEvidence.some((evidence) => evidence.eventId === experimentFact.id));
    resolveInterruptedIntentReturn(fixture.state, fixture.reader, 13);
    assert.equal(child.status, 'completed');
    assert.equal(child.returnOutcome, 'parent-completed');

    const report = reportFor(fixture.state, 'record-use-complete');
    assert.equal(report.recordUseAcquisitions, 1);
    assert.equal(report.recordUseReads, 1);
    assert.equal(report.recordUseExperiments, 1);
    assert.equal(report.completeRecordUseChains, 1);
    assert.equal(report.recordUseProjectProgresses, 1);
    for (const key of [
      'recordUseActionsMissingBasisKey',
      'recordUseUnresolvedProjects',
      'recordUseReaderMismatches',
      'recordUseTechniqueMismatches',
      'recordUseAcquisitionSourceMismatches',
      'recordUseReadsWithoutAcquisition',
      'recordUseExperimentsWithoutRead',
      'recordUseProjectMismatches',
      'recordUseUnresolvedActionEvents',
      'recordUseAuthorMismatches',
      'recordUsePayloadMismatches',
      'recordUseCodebookMismatches',
      'recordUseReadUnderstandingViolations',
      'recordUseReadReliabilityViolations',
      'recordUseExperimentOutputMismatches',
      'recordUseExperimentConfidenceMismatches',
    ]) assert.equal(report[key], 0, `${key} should remain zero for a complete physical chain`);

    const invalidChains = [
      {
        label: 'read-understanding', stage: 'read', violation: 'recordUseReadUnderstandingViolations',
        mutate: (event) => { event.diff.understood = false; },
      },
      {
        label: 'read-reliability', stage: 'read', violation: 'recordUseReadReliabilityViolations',
        mutate: (event) => { event.diff.recordUseKnowledgeConfidenceAfter = 55; },
      },
      {
        label: 'experiment-output', stage: 'experiment', violation: 'recordUseExperimentOutputMismatches',
        mutate: (event) => { event.diff.outputMaterialId = Material.Wood; },
      },
      {
        label: 'experiment-confidence', stage: 'experiment', violation: 'recordUseExperimentConfidenceMismatches',
        mutate: (event) => {
          event.diff.recordUseKnowledgeConfidenceAfter = event.diff.recordUseKnowledgeConfidenceBefore + 17;
        },
      },
      {
        label: 'common-reader', stage: 'experiment', violation: 'recordUseReaderMismatches',
        mutate: (event) => { event.diff.recordUseReaderId = fixture.author.id; },
      },
    ];
    for (const invalidCase of invalidChains) {
      const invalidState = structuredClone(fixture.state);
      const invalidEvent = invalidState.world.past.find((event) => event.kind === 'action'
        && event.diff.recordUseStage === invalidCase.stage);
      assert.ok(invalidEvent);
      invalidCase.mutate(invalidEvent);
      const invalidReport = reportFor(invalidState, `record-use-invalid-${invalidCase.label}`);
      assert.equal(invalidReport.recordUseReads, 1, 'raw stage counts remain observable when a guard fails');
      assert.equal(invalidReport.recordUseExperiments, 1, 'raw experiment counts remain observable when a guard fails');
      assert.equal(invalidReport[invalidCase.violation], 1);
      assert.equal(invalidReport.completeRecordUseChains, 0,
        `${invalidCase.label} must not be admitted into a complete record-use chain`);
    }
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    const candidates = visibleCellsFor(fixture.reader).flatMap((candidateCellId) => {
      if (candidateCellId === fixture.reader.position.cellId) return [];
      const standing = surfaceStandingPosition(fixture.state.world.grid, candidateCellId);
      if (!standing) return [];
      const route = findStandingPath(fixture.state.world.grid, fixture.reader.position, standing);
      return route.length > 1 ? [{ standing, route }] : [];
    }).sort((left, right) => left.route.length - right.route.length);
    assert.ok(candidates[0]);
    fixture.publicDrop.cellId = candidates[0].standing.cellId;
    fixture.publicDrop.z = candidates[0].standing.z;
    fixture.state.world.drops = [fixture.publicDrop];
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]);
    assert.equal(use.nextAction.kind, 'move');
    startRecordUseChild(fixture, use);
    const moveFact = appendIntentAction(fixture, 13, 2);
    assert.equal(moveFact.action.kind, 'move');
    assert.equal(moveFact.diff.recordUseStage, undefined, 'travel toward a record is not acquisition');
    const report = reportFor(fixture.state, 'record-use-move-only');
    assert.equal(report.recordUseAcquisitions, 0);
    assert.equal(report.recordUseActionsMissingBasisKey, 0, 'unstaged travel is excluded from stage metrics');
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    fixture.reader.inventory.push({
      id: 'reader-record-carrier', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['reader-owned-record'],
    });
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    assert.equal(use.recordUseBasis?.version, 'record-use-basis-v3');
    assert.equal(use.recordUseBasis?.carrierSource.kind, 'inventory');
    assert.equal(use.recordUseBasis?.acquisitionRequired, false);
    assert.equal(use.recordUseStage, 'read');
    assert.equal(use.nextAction.kind, 'attend', 'an owned carrier skips acquisition');
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    fixture.author.inventory.push({
      id: 'author-private-record', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['author-private'],
    });
    fixture.author.activeIntentId = 'author-private-intent';
    fixture.state.intents.push({
      ...structuredClone(fixture.parent), id: 'author-private-intent', ownerId: fixture.author.id,
      projectId: undefined, goal: { kind: 'knowledge', factId: fixture.techniqueId, minConfidence: 55 },
    });
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []).length, 0,
      'another person\'s inventory, knowledge and active intent are private and cannot create an option');
  }

  {
    const fixture = makeFixture();
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []).length, 0,
      'a real but caller-invisible public drop cannot create an option');
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    fixture.reader.knowledge = [];
    fixture.reader.inventory.push({
      id: 'unbound-record-carrier', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['unbound-record-carrier-source'],
    });
    const unboundRead = executePrimitiveAction(fixture.state, fixture.reader, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: fixture.reader.id, stackId: 'unbound-record-carrier' },
    }, 13, 0, { cause: 'intent', actionTick: 1 });
    assert.equal(unboundRead.diff.understood, false);
    assert.equal(fixture.reader.knowledge.some((fact) => fact.id === fixture.codebookId), false,
      'ordinary attention outside a validated record-use child must not self-decode a foreign codebook');
  }

  {
    const fixture = makeFixture();
    fixture.reader.knowledge = [];
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]);
    assert.ok(use,
      'an exact executable project deficit may begin a physical read even before the reader has the author codebook');
    assert.deepEqual(use.recordUseBasis?.codebookSourceEventIds, [],
      'the basis must not fabricate pre-existing codebook evidence');
    const child = startRecordUseChild(fixture, use);
    assert.ok(child);
    appendIntentAction(fixture, 13, 2);
    const readFact = appendIntentAction(fixture, 13, 3);
    assert.equal(readFact.diff.recordUseStage, 'read');
    assert.equal(readFact.diff.understood, true);
    const selfDecodedCodebook = fixture.reader.knowledge.find((fact) => fact.id === fixture.codebookId);
    assert.equal(selfDecodedCodebook?.kind, 'codebook');
    assert.ok(selfDecodedCodebook.confidence >= 55 && selfDecodedCodebook.confidence <= 60,
      'explicit attention to the physical notation should create a bounded self-decoded codebook');
    const tentative = fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId);
    assert.equal(tentative?.confidence, 46,
      'self-decoding the record creates only tentative technique knowledge');
    const experimentFact = appendIntentAction(fixture, 13, 4);
    assert.equal(experimentFact.diff.recordUseStage, 'experiment');
    assert.equal(experimentFact.diff.outputMaterialId, Material.Spear);
    assert.equal(fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId)?.confidence, 64,
      'only the existing real act raises the recorded technique by exactly 18');
  }

  {
    const fixture = makeFixture();
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.materialId !== Material.Wood);
    const woodDrop = {
      id: 'record-prepare-wood', materialId: Material.Wood,
      cellId: fixture.reader.position.cellId, z: fixture.reader.position.z, quantity: 1,
      createdAtMonth: 12, sourceEventIds: ['record-prepare-visible-wood'],
      sourceLineageKeys: ['voxel:record-prepare-visible-wood'],
    };
    fixture.state.world.drops.push(woodDrop);
    const [use] = buildDemandBoundRecordUseOptions(
      fixture.state,
      fixture.reader,
      [fixture.publicDrop, woodDrop],
    );
    assert.ok(use,
      'an exact project knowledge gap may start before every experiment input is held');
    assert.equal(use.recordUseBasis?.version, 'record-use-basis-v3');
    assert.equal('experimentAction' in use.recordUseBasis, false,
      'v3 must not freeze concrete experiment stack ids before preparation');

    delete fixture.parent.projectId;
    fixture.parent.goal = { kind: 'body-at-least', field: 'health', value: 100 };
    fixture.parent.stateGoalUntilMonth = 20;
    const child = startRecordUseChild(fixture, use);
    assert.equal(child.returnToIntentId, fixture.parent.id,
      'a generic resumable non-project intent may be interrupted by an owned active project record');

    appendIntentAction(fixture, 13, 2);
    const readFact = appendIntentAction(fixture, 13, 3);
    assert.equal(readFact.diff.recordUseStage, 'read');
    assert.equal(child.recordUseStage, 'prepare-experiment');
    const prepareFact = appendIntentAction(fixture, 13, 4);
    assert.equal(prepareFact.action.kind, 'transfer');
    assert.equal(prepareFact.action.from.kind, 'ground');
    assert.equal(prepareFact.action.dropId, woodDrop.id);
    assert.equal(prepareFact.diff.recordUsePreparation, true);
    assert.equal(prepareFact.diff.recordUseStage, undefined,
      'ordinary project logistics is preparation, not a completed experiment');
    const experimentFact = appendIntentAction(fixture, 13, 5);
    assert.equal(experimentFact.action.kind, 'act');
    assert.equal(experimentFact.diff.recordUseStage, 'experiment');
    assert.equal(experimentFact.diff.outputMaterialId, Material.Spear);
  }

  {
    const fixture = makeFixture();
    fixture.reader.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: '已经可靠掌握', confidence: 55,
      learnedAtMonth: 11, sourceEventIds: ['own-experiment'],
    });
    const [replication] = buildDemandBoundRecordUseOptions(
      fixture.state,
      fixture.reader,
      [fixture.publicDrop],
    );
    assert.equal(replication?.recordUseBasis?.version, 'record-use-basis-v3');
    assert.equal(replication.recordUseBasis.purpose, 'replicate');
    assert.equal(replication.goal.kind, 'record-replication-receipt',
      'reliable knowledge must use a source-bound receipt instead of an already-satisfied knowledge goal');
    const swappedState = structuredClone(fixture.state);
    swappedState.world.drops = [];
    const swappedReader = swappedState.people.find((person) => person.id === fixture.reader.id);
    assert.ok(swappedReader);
    swappedReader.inventory.push({
      id: 'replacement-replication-carrier', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['replacement-replication-publication'],
    });
    const [swappedCarrierReplication] = buildDemandBoundRecordUseOptions(swappedState, swappedReader, []);
    assert.equal(swappedCarrierReplication?.recordUseBasis?.basisKey, replication.recordUseBasis.basisKey,
      'changing only the physical carrier must not mint a fresh replication basis');
    assert.deepEqual(swappedCarrierReplication?.goal, replication.goal);

    const noProjectState = structuredClone(fixture.state);
    noProjectState.projects[0].status = 'blocked';
    const noProjectReader = noProjectState.people.find((person) => person.id === fixture.reader.id);
    assert.ok(noProjectReader);
    assert.equal(buildDemandBoundRecordUseOptions(
      noProjectState,
      noProjectReader,
      noProjectState.world.drops,
    ).length, 0, 'reliable knowledge alone cannot create replication without an owned active project');
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    fixture.reader.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: '可靠的本人制矛经验', confidence: 70,
      learnedAtMonth: 11, sourceEventIds: ['cooldown-own-experiment'],
    });
    fixture.reader.inventory.push({
      id: 'cooldown-record-carrier-a', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['cooldown-carrier-a'],
    });
    const [replication] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    assert.ok(replication);
    const child = startRecordUseChild(fixture, replication);
    const read = appendIntentAction(fixture, 13, 2);
    assert.equal(read.diff.recordUseKnowledgeConfidenceAfter, 70);
    fixture.project.need = 'reserve-security';
    fixture.project.desiredFunction = 'reserve-storage';
    assert.equal(executeActiveIntent(fixture.state, fixture.reader, 13, 1, 3), null);
    assert.equal(child.status, 'blocked');
    fixture.project.need = 'hunting-safety';
    fixture.project.desiredFunction = 'safer-hunting';
    const renewedProject = {
      ...structuredClone(fixture.project),
      id: 'project-record-use-renewed-after-failure',
      createdAtMonth: 14,
      status: 'active',
      lastProgressAtMonth: 13,
      actionEventIds: [], failureEventIds: ['failed-hunt'], completionEventIds: [],
      progressEvidence: [],
    };
    fixture.project.status = 'blocked';
    fixture.state.projects.push(renewedProject);
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.recordPayloadId !== fixture.record.id);
    fixture.reader.inventory.push({
      id: 'cooldown-record-carrier-b', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['cooldown-carrier-b'],
    });
    for (let elapsedMonths = 13; elapsedMonths <= 18; elapsedMonths += 1) {
      fixture.state.clock.elapsedMonths = elapsedMonths;
      assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []).length, 0,
        `the same semantic basis stays cold ${elapsedMonths - 12} month(s) after failure even when carrier and project id change`);
    }
    fixture.state.clock.elapsedMonths = 19;
    const [reopened] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    assert.equal(reopened?.recordUseBasis?.basisKey, replication.recordUseBasis.basisKey,
      'real elapsed cooldown may reopen the same cross-project stable basis only after month 6');
    assert.equal(reopened?.recordUseBasis?.projectId, renewedProject.id);
  }

  {
    const fixture = makeFixture();
    fixture.reader.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: '可靠的本人制矛经验', confidence: 70,
      learnedAtMonth: 11, sourceEventIds: ['wrong-output-own-experiment'],
    });
    const [replication] = buildDemandBoundRecordUseOptions(
      fixture.state,
      fixture.reader,
      [fixture.publicDrop],
    );
    assert.equal(replication.goal.kind, 'record-replication-receipt');
    const forgedId = 'e-13-action-forged-replication-0';
    const forgedWrongOutput = {
      id: forgedId, kind: 'action', actionTick: 1, atMonth: 13, orderInMonth: 0,
      cellId: fixture.reader.position.cellId, who: fixture.reader.id, cause: 'intent',
      action: structuredClone(fixture.parent.nextAction),
      fromCellId: fixture.reader.position.cellId, toCellId: fixture.reader.position.cellId,
      fromZ: fixture.reader.position.z, toZ: fixture.reader.position.z, pathSegment: [fixture.reader.position.cellId],
      status: 'completed', result: '伪造的错误产物',
      diff: {
        techniqueId: fixture.techniqueId,
        outputMaterialId: Material.Wood,
        sourceEventId: forgedId,
        recordUseBasisKey: replication.recordUseBasis.basisKey,
        recordUseStage: 'replicate', recordUsePurpose: 'replicate',
        recordUseReplicationReceipt: true,
        recordUseProjectId: fixture.project.id,
        recordUseRecordId: fixture.record.id,
        recordUseRecordVersion: fixture.record.version,
        recordUseKnowledgeId: fixture.techniqueId,
        recordUseTechniqueId: fixture.techniqueId,
        recordUseRuleSignature: fixture.techniqueId,
        recordUseReaderId: fixture.reader.id,
        recordUseExpectedOutputMaterialId: Material.Spear,
        recordUseInputSourceEventIds: ['made-stone-tool', 'gathered-wood'],
      },
    };
    fixture.project.actionEventIds.push(forgedId);
    appendCommittedEvents(fixture.state, [forgedWrongOutput]);
    assert.equal(goalSatisfied(fixture.state, fixture.reader, replication.goal), false,
      'a completed action with the wrong physical output cannot satisfy the receipt goal');
    forgedWrongOutput.diff.outputMaterialId = Material.Spear;
    assert.equal(goalSatisfied(fixture.state, fixture.reader, replication.goal), false,
      'a correct output from an action with no matching v3 replicate intent cannot forge a receipt');
    forgedWrongOutput.status = 'blocked';
    assert.equal(goalSatisfied(fixture.state, fixture.reader, replication.goal), false,
      'a blocked action cannot satisfy the receipt goal even if its claimed output matches');
  }

  {
    const fixture = makeFixture();
    fixture.record.authorId = fixture.reader.id;
    assert.equal(buildDemandBoundRecordUseOptions(
      fixture.state,
      fixture.reader,
      [fixture.publicDrop],
    ).length, 0, 'a record author cannot use their own carrier as outsider transmission');
  }

  {
    const fixture = makeFixture();
    const millRule = inventoryCombinationForOutput(Material.Mill);
    assert.ok(millRule);
    const wrongTechniqueId = inventoryCombinationTechniqueId(millRule);
    fixture.record.knowledgeId = wrongTechniqueId;
    fixture.record.summary = '不对应当前狩猎项目缺口的磨坊记录';
    assert.equal(buildDemandBoundRecordUseOptions(
      fixture.state,
      fixture.reader,
      [fixture.publicDrop],
    ).length, 0, 'a readable but project-irrelevant technique record must not trigger');
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    fixture.reader.inventory.push({
      id: 'gap-change-record-carrier', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['gap-change-carrier'],
    });
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    const child = startRecordUseChild(fixture, use);
    const readFact = appendIntentAction(fixture, 13, 2);
    assert.equal(readFact.diff.recordUseStage, 'read');
    fixture.project.need = 'food-reserve';
    fixture.project.desiredFunction = 'reserve-storage';
    assert.equal(recompileRecordUseNextAction(fixture.state, fixture.reader, child), null,
      'when the owned project gap changes, the old record episode terminates instead of pursuing a stale recipe');
  }

  {
    const fixture = makeFixture();
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]);
    const child = startRecordUseChild(fixture, use);
    fixture.state.world.drops = [{
      ...structuredClone(fixture.publicDrop), id: 'replacement-record-drop',
      sourceEventIds: ['replacement-publication'],
    }];
    assert.equal(recompileRecordUseNextAction(fixture.state, fixture.reader, child), null,
      'a frozen missing drop cannot silently switch to another carrier with the same payload');
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    fixture.reader.inventory.push({
      id: 'legacy-composite-record', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['legacy-composite-carrier'],
    });
    const [v3Option] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    const { carrierSource: _carrierSource, acquisitionRequired: _acquisitionRequired, ...sharedBasis } = v3Option.recordUseBasis;
    const openingAction = {
      kind: 'communicate',
      content: { id: 'legacy-composite-opening', kind: 'claim', summary: '先谈共同劳动，再处理记录' },
      audience: [fixture.author.id], channel: 'voice',
    };
    const openingFact = executePrimitiveAction(
      fixture.state, fixture.reader, openingAction, 13, 0,
      { intentId: 'legacy-composite-intent', cause: 'intent', actionTick: 1 },
    );
    assert.equal(openingFact.status, 'completed');
    appendCommittedEvents(fixture.state, [openingFact]);
    const legacyComposite = {
      ...structuredClone(fixture.parent),
      id: 'legacy-composite-intent', projectId: undefined,
      openingAction, openingActionCompleted: true,
      recordUseBasis: {
        ...sharedBasis,
        version: 'record-use-basis-v1',
        experimentAction: structuredClone(fixture.parent.nextAction),
      },
      recordUseStage: 'read-experiment', actionEventIds: [openingFact.id],
    };
    fixture.parent.status = 'suspended';
    fixture.parent.suspendedByIntentId = legacyComposite.id;
    fixture.state.intents.push(legacyComposite);
    fixture.reader.activeIntentId = legacyComposite.id;
    const report = reportFor(fixture.state, 'legacy-composite-opening');
    assert.equal(report.recordUseShares, 0);
    assert.equal(report.recordUseReads, 0);
    assert.equal(report.recordUseExperiments, 0);
    assert.equal(report.recordUseActionsMissingBasisKey, 0,
      'a legacy composite conversation opening is not a record action and must be skipped by the audit');
  }

  {
    const fixture = makeFixture({ publicAtReader: false });
    fixture.reader.inventory.push({
      id: 'legacy-reader-record', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['legacy-share'],
    });
    const [v3Option] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    const { carrierSource: _carrierSource, acquisitionRequired: _acquisitionRequired, ...sharedBasis } = v3Option.recordUseBasis;
    const legacyIntent = {
      ...structuredClone(fixture.parent), id: 'legacy-record-reader', projectId: undefined,
      recordUseBasis: {
        ...sharedBasis,
        version: 'record-use-basis-v1',
        experimentAction: structuredClone(fixture.parent.nextAction),
      },
      recordUseStage: 'read-experiment',
    };
    assert.equal(recompileRecordUseNextAction(fixture.state, fixture.reader, legacyIntent)?.kind, 'attend',
      'persisted v1 read-experiment intents still restore');
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.id !== 'legacy-reader-record');

    fixture.author.inventory.push({
      id: 'legacy-author-record', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['legacy-author'],
    });
    const legacyShare = {
      ...structuredClone(legacyIntent), ownerId: fixture.author.id, recordUseStage: 'share',
      id: 'legacy-record-share',
      goal: { kind: 'record-held', recordId: fixture.record.id, personId: fixture.reader.id },
      nextAction: {
        kind: 'transfer', materialId: Material.WoodTablet, quantity: 1,
        from: { kind: 'person', personId: fixture.author.id },
        to: { kind: 'person', personId: fixture.reader.id }, stackId: 'legacy-author-record',
      },
    };
    assert.equal(recompileRecordUseNextAction(fixture.state, fixture.author, legacyShare)?.kind, 'transfer',
      'persisted v1 share intents remain executable even though new planning no longer creates them');
    fixture.state.intents.push(legacyShare);
    fixture.author.activeIntentId = legacyShare.id;
    const shareFact = executeActiveIntent(fixture.state, fixture.author, 13, 0, 1);
    assert.equal(shareFact?.kind, 'action');
    appendCommittedEvents(fixture.state, [shareFact]);
    assert.equal(reportFor(fixture.state, 'legacy-record-share').recordUseShares, 1,
      'the report keeps counting legacy v1 share actions');
  }

  {
    const fixture = makeFixture();
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]);
    const child = startRecordUseChild(fixture, use);
    const teaching = executePrimitiveAction(fixture.state, fixture.author, {
      kind: 'communicate',
      content: {
        id: `teach:${fixture.author.id}:${fixture.reader.id}:${fixture.techniqueId}`,
        kind: 'claim', factId: fixture.techniqueId, summary: fixture.record.summary,
      },
      audience: [fixture.reader.id], channel: 'voice',
    }, 13, 0, { cause: 'intent', actionTick: 2 });
    appendCommittedEvents(fixture.state, [teaching]);
    assert.equal(fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId)?.confidence, 60);
    assert.equal(executeActiveIntent(fixture.state, fixture.reader, 13, 1, 3), null,
      'reliable direct teaching terminates the record-use child without a fake record action');
    resolveInterruptedIntentReturn(fixture.state, fixture.reader, 13);
    assert.equal(child.status, 'completed');
    assert.equal(child.returnOutcome, 'resumed');
    assert.equal(fixture.reader.activeIntentId, fixture.parent.id);
    assert.equal(reportFor(fixture.state, 'record-use-direct-teach').completeRecordUseChains, 0,
      'direct teaching must not masquerade as acquire-read-experiment completion');
  }

  process.stdout.write('demand-bound record-use tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
