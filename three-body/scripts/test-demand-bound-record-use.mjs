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
    export {
      buildDemandBoundRecordUseOptions,
      recompileRecordUseNextAction,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/record-use-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export {
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { followUpSemanticallyMatches } from ${JSON.stringify(path.resolve('src/game/eland/domain/intent-follow-up.ts'))};
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
    buildDecisionContext,
    buildDemandBoundRecordUseOptions,
    buildEvolutionFactsReport,
    createInitialState,
    executeActiveIntent,
    executePrimitiveAction,
    findStandingPath,
    followUpSemanticallyMatches,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
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
    const fact = executeActiveIntent(
      fixture.state, fixture.reader, atMonth, fixture.state.world.past.length, actionTick,
    );
    assert.ok(fact && fact.kind === 'action');
    fixture.state.world.past.push(fact);
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
    const { fixture, result, readerPlanningCalls } = runAlreadyReviewedSchedulingFixture({ publishRecord: false });
    assert.equal(readerPlanningCalls[0]?.decision.interruptionKind, 'life-review',
      'the deterministic month must begin with one real life review of the active project');
    assert.ok(result.agreements.some((agreement) => agreement.proposerId === fixture.reader.id
      && agreement.proposal.kind === 'companion'),
      'that first review must create a same-month proposal before the parent project resumes');
    assert.equal(readerPlanningCalls.length, 1,
      'without any perceived written carrier, an already reviewed person must not enter a second planning review');
    assert.equal(result.lastStep.filter((event) => event.kind === 'decision'
      && event.who === fixture.reader.id
      && event.decision.lifeReview).length, 1,
      'a same-month proposal must not manufacture a second life-review decision');
  }

  {
    const { fixture, result, readerPlanningCalls } = runAlreadyReviewedSchedulingFixture({ publishRecord: true });
    assert.deepEqual(readerPlanningCalls.map((call) => call.hasRecordOption), [false, true],
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
    fixture.state.world.past.push(sharedAction);
    fixture.project.actionEventIds.push(sharedAction.id);
    fixture.project.contributorIds.push(fixture.author.id);
    const context = buildDecisionContext(fixture.state, fixture.reader, 13);
    const use = context.options.find((option) => option.id.startsWith('use-demand-record:'));
    assert.equal(use?.recordUseBasis?.version, 'record-use-basis-v2',
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
    const projectBeforePreview = structuredClone(fixture.project);
    const [use] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]);
    assert.ok(use, 'a visible public record should serve the reader\'s own active project deficit');
    assert.equal(use.recordUseBasis?.version, 'record-use-basis-v2');
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
    assert.equal(use.recordUseBasis?.version, 'record-use-basis-v2');
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
    const fixture = makeFixture();
    fixture.reader.knowledge = [];
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]).length, 0,
      'a record without the reader\'s reliable codebook is ineligible');
  }

  {
    const fixture = makeFixture();
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.materialId !== Material.Wood);
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]).length, 0,
      'a record cannot become eligible before every real experiment input is held');
  }

  {
    const fixture = makeFixture();
    fixture.reader.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: '已经可靠掌握', confidence: 55,
      learnedAtMonth: 11, sourceEventIds: ['own-experiment'],
    });
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.publicDrop]).length, 0,
      'already reliable knowledge has no record-use deficit');
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
    const [v2Option] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    const { carrierSource: _carrierSource, acquisitionRequired: _acquisitionRequired, ...sharedBasis } = v2Option.recordUseBasis;
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
    fixture.state.world.past.push(openingFact);
    const legacyComposite = {
      ...structuredClone(fixture.parent),
      id: 'legacy-composite-intent', projectId: undefined,
      openingAction, openingActionCompleted: true,
      recordUseBasis: { ...sharedBasis, version: 'record-use-basis-v1' },
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
    const [v2Option] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    const { carrierSource: _carrierSource, acquisitionRequired: _acquisitionRequired, ...sharedBasis } = v2Option.recordUseBasis;
    const legacyIntent = {
      ...structuredClone(fixture.parent), id: 'legacy-record-reader', projectId: undefined,
      recordUseBasis: { ...sharedBasis, version: 'record-use-basis-v1' },
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
    fixture.state.world.past.push(shareFact);
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
    fixture.state.world.past.push(teaching);
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
