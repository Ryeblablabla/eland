import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-record-prepare-test-'));
const bundlePath = path.join(temporaryDirectory, 'record-prepare.mjs');

try {
  const testEntry = `
    export {
      createInitialState,
      executeActiveIntent,
      RulePlanner,
      startInterruptIntent,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { visibleCellsFor } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { planLocallyForTick } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/tick-planner.ts'))};
    export {
      buildDemandBoundRecordUseOptions,
      recompileRecordUseNextAction,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/record-use-options.ts'))};
    export { previewOwnedProjectStep, synchronizeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export {
      exposureRuleFor,
      exposureTechniqueId,
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { goalSatisfied } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { isIndependentRecordReplicationReceiptFact } from ${JSON.stringify(path.resolve('src/game/eland/domain/era-progression.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export { cellX, cellY, setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=record-use-prepare-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    RulePlanner,
    appendCommittedEvents,
    buildDemandBoundRecordUseOptions,
    cellX,
    cellY,
    createInitialState,
    executeActiveIntent,
    exposureRuleFor,
    exposureTechniqueId,
    goalSatisfied,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    isIndependentRecordReplicationReceiptFact,
    planLocallyForTick,
    previewOwnedProjectStep,
    recompileRecordUseNextAction,
    setVoxel,
    startInterruptIntent,
    synchronizeProject,
    visibleCellsFor,
  } = simulation;

  const makeFixture = ({ groundCarrier = true, includeWood = false } = {}) => {
    const state = createInitialState(824, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.past = [];
    state.world.historyCursor = { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null };
    state.projects = [];
    state.intents = [];
    state.records = [];
    const reader = state.people[0];
    const author = state.people[1];
    for (const person of state.people.slice(2)) person.diedAtMonth = 0;
    for (const person of [reader, author]) {
      person.diedAtMonth = undefined;
      person.bornAtMonth = -20 * 12;
      person.conditions = [];
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.inventory = [];
      person.knowledge = [];
      delete person.activeIntentId;
    }
    author.position = structuredClone(reader.position);
    appendCommittedEvents(state, [
      {
        id: 'prepare-stone-tool-source', kind: 'environment', atMonth: 11, orderInMonth: 0,
        cellId: reader.position.cellId, change: 'resource', who: reader.id,
        result: '专项夹具：真实石制工具来源', diff: { materialId: Material.StoneTool },
      },
      {
        id: 'prepare-owned-wood-source', kind: 'environment', atMonth: 11, orderInMonth: 1,
        cellId: reader.position.cellId, change: 'resource', who: reader.id,
        result: '专项夹具：真实自有木材来源', diff: { materialId: Material.Wood },
      },
      {
        id: 'prepare-visible-wood', kind: 'environment', atMonth: 11, orderInMonth: 2,
        cellId: reader.position.cellId, change: 'resource', who: reader.id,
        result: '专项夹具：真实可见木材来源', diff: { materialId: Material.Wood },
      },
    ]);
    reader.inventory.push({
      id: 'prepare-stone-tool', materialId: Material.StoneTool, quantity: 1,
      sourceEventIds: ['prepare-stone-tool-source'],
    });
    if (includeWood) reader.inventory.push({
      id: 'prepare-owned-wood', materialId: Material.Wood, quantity: 1,
      sourceEventIds: ['prepare-owned-wood-source'],
    });
    const spearRule = inventoryCombinationForOutput(Material.Spear);
    assert.ok(spearRule);
    const techniqueId = inventoryCombinationTechniqueId(spearRule);
    const codebookId = `codebook:prepare:${techniqueId}`;
    reader.knowledge.push({
      id: codebookId, kind: 'codebook', summary: '能辨认这组刻痕', confidence: 60,
      learnedAtMonth: 10, sourceEventIds: ['prepare-codebook-source'],
    });
    author.knowledge.push({
      id: techniqueId, kind: 'technique', summary: '石制工具与木材可结合成长矛', confidence: 80,
      learnedAtMonth: 7, sourceEventIds: ['prepare-author-trial'],
    });
    const record = {
      id: 'record-prepare-fixture', authorId: author.id, knowledgeId: techniqueId,
      codebookId, kind: 'technique', summary: '石制工具与木材可结合成长矛',
      version: 1, createdAtMonth: 8, sourceEventIds: ['prepare-record-writing'],
    };
    state.records.push(record);
    const project = {
      id: 'project-record-prepare', kind: 'production', need: 'hunting-safety',
      desiredFunction: 'safer-hunting', summary: '为下一次捕猎准备更安全的工具',
      ownerId: reader.id, beneficiaryIds: [reader.id], triggerFactIds: ['prepare-failed-hunt'],
      pressure: 74, createdAtMonth: 9, reviewAtMonth: 24, status: 'active',
      lastProgressAtMonth: 12, missingMaterialIds: [], materialDemands: [], reservations: [],
      contributorIds: [reader.id], actionEventIds: [], failureEventIds: ['prepare-failed-hunt'],
      completionEventIds: [], progressEvidence: [], searchCampaigns: [], logisticsEpisodes: [],
    };
    state.projects.push(project);
    const parent = {
      id: 'generic-non-project-parent', ownerId: reader.id, summary: '维持当前身体状态',
      domain: 'strategic', goal: { kind: 'body-at-least', field: 'health', value: 100 },
      nextAction: { kind: 'attend', target: { kind: 'person', personId: reader.id } },
      status: 'active', createdAtMonth: 9, lastProgressAtMonth: 12, progress: 0.3,
      plannedDurationMonths: 12, stateGoalUntilMonth: 20,
      sourceDecisionEventId: 'generic-parent-decision', sourceFactIds: [], actionEventIds: [], replanCount: 0,
    };
    state.intents.push(parent);
    reader.activeIntentId = parent.id;
    const carrier = {
      id: 'prepare-record-drop', materialId: Material.WoodTablet,
      cellId: reader.position.cellId, z: reader.position.z, quantity: 1,
      createdAtMonth: 8, sourceEventIds: ['prepare-record-writing', 'prepare-record-publication'],
      sourceLineageKeys: ['inventory:prepare-author-carrier'], recordPayloadId: record.id,
    };
    const woodDrop = {
      id: 'prepare-wood-drop', materialId: Material.Wood,
      cellId: reader.position.cellId, z: reader.position.z, quantity: 1,
      createdAtMonth: 12, sourceEventIds: ['prepare-visible-wood'],
      sourceLineageKeys: ['voxel:prepare-visible-wood'],
    };
    if (groundCarrier) state.world.drops = [carrier, ...(includeWood ? [] : [woodDrop])];
    else {
      state.world.drops = includeWood ? [] : [woodDrop];
      reader.inventory.push({
        id: 'prepare-owned-carrier', materialId: Material.WoodTablet, quantity: 1,
        recordPayloadId: record.id, sourceEventIds: ['prepare-owned-carrier-source'],
      });
    }
    return { state, reader, author, record, project, parent, carrier, woodDrop, techniqueId };
  };

  const visibleDrops = (fixture) => fixture.state.world.drops.filter((drop) => drop.quantity > 0);
  const appendAction = (fixture, actionTick) => {
    const nextOrderInMonth = fixture.state.world.past
      .filter((event) => event.atMonth === 13)
      .reduce((highest, event) => Math.max(highest, event.orderInMonth), -1) + 1;
    const fact = executeActiveIntent(
      fixture.state,
      fixture.reader,
      13,
      nextOrderInMonth,
      actionTick,
    );
    assert.ok(fact?.kind === 'action');
    appendCommittedEvents(fixture.state, [fact]);
    return fact;
  };

  const appendLeadershipPair = (state, project, predecessorId, successorId, prefix, atMonth) => {
    assert.ok(project.site);
    const deathEventId = `${prefix}-death`;
    const vacancyTransitionId = `${prefix}-vacancy`;
    const contributionEventId = `${prefix}-contribution`;
    const successionEventId = `${prefix}-succession-action`;
    project.leadershipTransitions ??= [];
    project.leadershipTransitions.push(
      {
        version: 'project-leadership-v1',
        id: vacancyTransitionId,
        kind: 'vacancy',
        projectId: project.id,
        predecessorId,
        deathEventId,
        atMonth,
        orderInMonth: 0,
        planningTick: 0,
        orderInTick: 0,
        expiresAtMonth: atMonth + 120,
        sourceEventIds: [deathEventId],
      },
      {
        version: 'project-leadership-v1',
        id: `${prefix}-succession`,
        kind: 'succession',
        projectId: project.id,
        predecessorId,
        successorId,
        vacancyTransitionId,
        deathEventId,
        contributionEventId,
        successionEventId,
        site: { ...project.site },
        atMonth,
        orderInMonth: 1,
        planningTick: 0,
        orderInTick: 0,
        sourceEventIds: [deathEventId, contributionEventId, successionEventId],
      },
    );
    state.projects = [...state.projects];
  };

  {
    const fixture = makeFixture();
    const previewReader = structuredClone(fixture.reader);
    previewReader.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: 'record preview', confidence: 55,
      learnedAtMonth: 13, sourceEventIds: [fixture.record.id],
    });
    const directStep = previewOwnedProjectStep(
      fixture.state,
      previewReader,
      fixture.project.id,
    );
    assert.equal(directStep?.planKnowledgeId, fixture.techniqueId,
      `record preview must expose the exact plan knowledge id: ${JSON.stringify(directStep)}`);
    let reviewedContext;
    planLocallyForTick(
      fixture.state,
      fixture.reader,
      13,
      2,
      [],
      { decide(context) { reviewedContext = context; return { kind: 'idle', reason: 'preview only' }; } },
      new Set([fixture.reader.id]),
    );
    const option = reviewedContext?.options.find((candidate) => candidate.recordUseBasis);
    assert.equal(option?.recordUseBasis?.version, 'record-use-basis-v3');
    assert.equal(option.recordUseStage, 'acquire');
    assert.equal('experimentAction' in option.recordUseBasis, false);

    const context = {
      ...reviewedContext,
      options: [option],
      followUpOptions: [],
      activeIntent: fixture.parent,
    };
    const decision = new RulePlanner().decideAt(context, { atMonth: 13, planningTick: 2 });
    assert.equal(decision.kind, 'revise');
    assert.equal(decision.mode, 'interrupt');
    assert.equal(decision.interruptionKind, 'record-use');
    const child = startInterruptIntent(
      fixture.state, fixture.reader, context, option.id,
      'record-prepare-interrupt', 13, 'record-use',
    );
    assert.ok(child);
    assert.equal(child.returnToIntentId, fixture.parent.id);
    assert.equal(child.projectId, undefined);
    delete child.recordUseBasis.purpose;
    delete child.recordUseBasis.recordVersion;
    delete child.recordUseBasis.projectRenewalBasisKey;
    delete child.recordUseBasis.inputWitnesses;

    const acquire = appendAction(fixture, 2);
    assert.equal(acquire.diff.recordUseStage, 'acquire');
    const read = appendAction(fixture, 3);
    assert.equal(read.diff.recordUseStage, 'read');
    assert.ok(fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId)?.confidence <= 54);
    assert.equal(child.recordUseStage, 'prepare-experiment');
    const prepare = appendAction(fixture, 4);
    assert.equal(prepare.action.kind, 'transfer');
    assert.equal(prepare.action.dropId, fixture.woodDrop.id);
    assert.equal(prepare.diff.recordUsePreparation, true);
    assert.equal(prepare.diff.recordUseStage, undefined);
    assert.equal(child.recordUseStage, 'experiment');
    const experiment = appendAction(fixture, 5);
    assert.equal(experiment.diff.recordUseStage, 'experiment');
    assert.equal(experiment.diff.outputMaterialId, Material.Spear);
    assert.ok(fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId)?.confidence >= 55);
    assert.equal(child.status, 'completed');
    assert.equal(child.recordUseBasis.purpose, undefined,
      'persisted v3 bases without replication fields keep the legacy low-confidence learn path');
  }

  {
    const fixture = makeFixture();
    fixture.reader.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: '本人此前已经可靠掌握制矛', confidence: 70,
      learnedAtMonth: 11, sourceEventIds: ['prepare-reader-own-trial'],
    });
    const [option] = buildDemandBoundRecordUseOptions(
      fixture.state,
      fixture.reader,
      visibleDrops(fixture),
    );
    assert.equal(option?.recordUseBasis?.version, 'record-use-basis-v3');
    assert.equal(option.recordUseBasis.purpose, 'replicate');
    assert.equal(option.goal.kind, 'record-replication-receipt');
    assert.equal(option.recordUseStage, 'acquire');
    const context = {
      state: fixture.state,
      person: fixture.reader,
      visibleCells: visibleCellsFor(fixture.reader),
      visiblePeople: [fixture.author],
      visibleDrops: visibleDrops(fixture),
      visibleAnimals: [],
      options: [option], followUpOptions: [], activeIntent: fixture.parent,
    };
    const child = startInterruptIntent(
      fixture.state, fixture.reader, context, option.id,
      'record-replication-interrupt', 13, 'record-use',
    );
    assert.ok(child);
    const acquire = appendAction(fixture, 2);
    assert.equal(acquire.diff.recordUseStage, 'acquire');
    const read = appendAction(fixture, 3);
    assert.equal(read.diff.recordUseStage, 'read');
    assert.equal(read.diff.recordUsePurpose, 'replicate');
    assert.equal(read.diff.recordUseKnowledgeConfidenceBefore, 70);
    assert.equal(read.diff.recordUseKnowledgeConfidenceAfter, 70,
      'reading an outsider record must not lower reliable personal knowledge');
    const prepare = appendAction(fixture, 4);
    assert.equal(prepare.action.kind, 'transfer');
    assert.equal(prepare.diff.recordUsePreparation, true);
    assert.equal(prepare.diff.recordUseReplicationReceipt, undefined,
      'ordinary logistics is not a replication receipt');
    const replicate = appendAction(fixture, 5);
    assert.equal(replicate.action.kind, 'act');
    assert.equal(replicate.diff.recordUseStage, 'replicate');
    assert.equal(replicate.diff.recordUsePurpose, 'replicate');
    assert.equal(replicate.diff.recordUseReplicationReceipt, true);
    assert.equal(replicate.diff.outputMaterialId, Material.Spear);
    assert.deepEqual(replicate.diff.recordUseInputSourceEventIds,
      ['e-13-action-ran-mouri-2', 'prepare-stone-tool-source', 'prepare-visible-wood']);
    assert.deepEqual(replicate.diff.recordUseInputWitnesses.map((witness) => ({
      role: witness.role,
      materialId: witness.materialId,
      quantity: witness.quantity,
      sourceEventIds: witness.sourceEventIds,
    })), [
      {
        role: 'input', materialId: Material.StoneTool, quantity: 1,
        sourceEventIds: ['prepare-stone-tool-source'],
      },
      {
        role: 'input', materialId: Material.Wood, quantity: 1,
        sourceEventIds: ['e-13-action-ran-mouri-2', 'prepare-visible-wood'],
      },
    ], 'the receipt freezes each actually consumed stack, material, quantity, and lineage');
    assert.equal(child.status, 'completed');
    assert.equal(child.goalOutcome?.kind, 'achieved');
    assert.deepEqual(child.goalOutcome?.sourceEventIds, [replicate.id]);
    assert.equal(fixture.reader.inventory.some((stack) => stack.id === 'prepare-stone-tool'), false,
      'the physical replication consumes its real tool/input stack');
    assert.equal(fixture.reader.inventory.some((stack) => stack.materialId === Material.Wood), false,
      'the acquired preparation input is physically consumed');
    const output = fixture.reader.inventory.find((stack) => stack.materialId === Material.Spear);
    assert.ok(output?.sourceEventIds.includes(replicate.id),
      'the exact output keeps the authoritative replication action in its lineage');
    assert.equal(goalSatisfied(fixture.state, fixture.reader, child.goal), true,
      'the real completed action with exact input lineage satisfies the receipt');

    const originalBasis = structuredClone(child.recordUseBasis);
    const originalDiff = structuredClone(replicate.diff);
    const setLineage = (sourceIdsForWitness) => {
      child.recordUseBasis.inputWitnesses = child.recordUseBasis.inputWitnesses.map((witness) => {
        const sourceEventIds = sourceIdsForWitness(witness);
        return { ...witness, sourceEventIds, genesisEntity: undefined };
      });
      child.recordUseBasis.inputSourceEventIds = [...new Set(
        child.recordUseBasis.inputWitnesses.flatMap((witness) => witness.sourceEventIds),
      )].sort();
      child.recordUseBasis.sourceFactIds = [...new Set([
        ...child.recordUseBasis.sourceFactIds,
        ...child.recordUseBasis.inputSourceEventIds,
      ])].sort();
      replicate.diff.recordUseInputWitnesses = structuredClone(child.recordUseBasis.inputWitnesses);
      replicate.diff.recordUseInputSourceEventIds = [...child.recordUseBasis.inputSourceEventIds];
    };
    setLineage(() => []);
    assert.equal(goalSatisfied(fixture.state, fixture.reader, child.goal), false,
      'empty input lineage cannot be relabelled as a receipt without a canonical genesis entity witness');
    setLineage((witness) => [`fake-${witness.materialId}-source`]);
    assert.equal(goalSatisfied(fixture.state, fixture.reader, child.goal), false,
      'unresolved fabricated input lineage cannot satisfy the receipt');
    appendCommittedEvents(fixture.state, [
      {
        id: 'future-stone-tool-source', kind: 'environment', atMonth: 14, orderInMonth: 0,
        cellId: fixture.reader.position.cellId, change: 'resource', who: fixture.reader.id,
        result: '专项反证：未来石制工具来源', diff: { materialId: Material.StoneTool },
      },
      {
        id: 'future-wood-source', kind: 'environment', atMonth: 14, orderInMonth: 1,
        cellId: fixture.reader.position.cellId, change: 'resource', who: fixture.reader.id,
        result: '专项反证：未来木材来源', diff: { materialId: Material.Wood },
      },
    ]);
    setLineage((witness) => [witness.materialId === Material.StoneTool
      ? 'future-stone-tool-source'
      : 'future-wood-source']);
    assert.equal(goalSatisfied(fixture.state, fixture.reader, child.goal), false,
      'a real material event after the claimed action cannot be its input lineage');
    child.recordUseBasis = originalBasis;
    replicate.diff = originalDiff;
    assert.equal(goalSatisfied(fixture.state, fixture.reader, child.goal), true);

    synchronizeProject(fixture.state, fixture.project, 13);
    assert.equal(fixture.project.status, 'completed');
    const renewedProject = {
      ...structuredClone(fixture.project),
      id: 'project-record-prepare-renewed',
      createdAtMonth: 18,
      status: 'active',
      lastProgressAtMonth: 18,
      actionEventIds: [],
      failureEventIds: ['prepare-failed-hunt'],
      completionEventIds: [],
      progressEvidence: [],
    };
    delete renewedProject.completedAtMonth;
    fixture.state.projects.push(renewedProject);
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.materialId !== Material.Spear);
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.recordPayloadId !== fixture.record.id);
    fixture.reader.inventory.push({
      id: 'post-success-replacement-carrier', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: fixture.record.id, sourceEventIds: ['post-success-replacement-publication'],
    });
    assert.equal(buildDemandBoundRecordUseOptions(
      fixture.state,
      fixture.reader,
      visibleDrops(fixture),
    ).length, 0,
    'one successful semantic receipt permanently suppresses a carrier- and project-id-swapped duplicate basis');
  }

  {
    const fixture = makeFixture();
    const founder = fixture.author;
    const firstSuccessor = fixture.reader;
    const secondSuccessor = fixture.state.people[2];
    assert.ok(secondSuccessor);
    secondSuccessor.diedAtMonth = undefined;
    secondSuccessor.bornAtMonth = -20 * 12;
    secondSuccessor.conditions = [];
    secondSuccessor.body = { health: 100, hydration: 100, nutrition: 100 };
    secondSuccessor.position = structuredClone(firstSuccessor.position);
    secondSuccessor.inventory = [];
    secondSuccessor.knowledge = [];
    delete secondSuccessor.activeIntentId;

    fixture.project.ownerId = founder.id;
    fixture.project.site = {
      cellId: firstSuccessor.position.cellId,
      z: firstSuccessor.position.z,
    };
    fixture.project.beneficiaryIds = [founder.id, firstSuccessor.id, secondSuccessor.id];
    fixture.project.contributorIds = [firstSuccessor.id, secondSuccessor.id];
    appendLeadershipPair(
      fixture.state, fixture.project, founder.id, firstSuccessor.id,
      'record-founder', 10,
    );
    founder.diedAtMonth = 10;
    founder.body.health = 0;
    firstSuccessor.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: '本人此前已经可靠掌握制矛', confidence: 70,
      learnedAtMonth: 11, sourceEventIds: ['record-first-successor-own-trial'],
    });

    assert.equal(buildDemandBoundRecordUseOptions(
      fixture.state, founder, visibleDrops(fixture),
    ).length, 0, 'immutable founder ownership cannot retain current record-use authority after succession');
    assert.equal(buildDemandBoundRecordUseOptions(
      fixture.state, secondSuccessor, visibleDrops(fixture),
    ).length, 0, 'a living contributor who is not the current lead cannot form a record-use option');

    const [option] = buildDemandBoundRecordUseOptions(
      fixture.state, firstSuccessor, visibleDrops(fixture),
    );
    assert.equal(option?.recordUseBasis?.purpose, 'replicate');
    assert.equal(option.recordUseBasis.projectOwnerId, founder.id,
      'the record basis preserves immutable founder ownership while authority follows the lead');
    const context = {
      state: fixture.state,
      person: firstSuccessor,
      visibleCells: visibleCellsFor(firstSuccessor),
      visiblePeople: [],
      visibleDrops: visibleDrops(fixture),
      visibleAnimals: [],
      options: [option], followUpOptions: [], activeIntent: fixture.parent,
    };
    const child = startInterruptIntent(
      fixture.state, firstSuccessor, context, option.id,
      'record-first-successor-replication', 13, 'record-use',
    );
    assert.ok(child);
    assert.equal(recompileRecordUseNextAction(fixture.state, firstSuccessor, child)?.kind, 'transfer',
      'the current successor can recompile the same physical record chain');
    appendAction(fixture, 2);
    appendAction(fixture, 3);
    appendAction(fixture, 4);
    const receipt = appendAction(fixture, 5);
    assert.equal(receipt.diff.recordUseReplicationReceipt, true);
    assert.equal(goalSatisfied(fixture.state, firstSuccessor, child.goal), true);
    assert.equal(isIndependentRecordReplicationReceiptFact(fixture.state, receipt), true);

    // The receipt remains valid even if its portable output is no longer held;
    // this also keeps the unfinished public project eligible for another real
    // leadership transition instead of turning observer replay into authority.
    firstSuccessor.inventory = firstSuccessor.inventory.filter((stack) => stack.materialId !== Material.Spear);
    appendLeadershipPair(
      fixture.state, fixture.project, firstSuccessor.id, secondSuccessor.id,
      'record-first-successor', 14,
    );
    firstSuccessor.diedAtMonth = 14;
    firstSuccessor.body.health = 0;
    fixture.state.clock.elapsedMonths = 14;

    assert.equal(goalSatisfied(fixture.state, firstSuccessor, child.goal), true,
      'a later succession cannot invalidate the first successor historical receipt');
    assert.equal(isIndependentRecordReplicationReceiptFact(fixture.state, receipt), true,
      'the modern observer replays event-time leadership instead of current leadership');

    secondSuccessor.knowledge = structuredClone(firstSuccessor.knowledge);
    secondSuccessor.inventory = [
      {
        id: 'record-second-successor-stone-tool', materialId: Material.StoneTool, quantity: 1,
        sourceEventIds: ['prepare-stone-tool-source'],
      },
      {
        id: 'record-second-successor-wood', materialId: Material.Wood, quantity: 1,
        sourceEventIds: ['prepare-owned-wood-source'],
      },
      {
        id: 'record-second-successor-carrier', materialId: Material.WoodTablet, quantity: 1,
        recordPayloadId: fixture.record.id, sourceEventIds: ['prepare-record-publication'],
      },
    ];
    const [secondOption] = buildDemandBoundRecordUseOptions(fixture.state, secondSuccessor, []);
    assert.equal(secondOption?.recordUseBasis?.purpose, 'replicate',
      'after the second succession only the second current lead receives a new candidate');
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, firstSuccessor, []).length, 0);
    assert.equal(fixture.project.ownerId, founder.id, 'both successions leave founder ownership immutable');
  }

  {
    const fixture = makeFixture({ groundCarrier: false, includeWood: true });
    const cookRule = exposureRuleFor(Material.Food, Material.Fire);
    assert.ok(cookRule);
    const cookTechniqueId = exposureTechniqueId(cookRule);
    fixture.project.kind = 'inquiry';
    fixture.project.need = 'food-preparation';
    fixture.project.desiredFunction = 'prepared-food';
    fixture.project.summary = '把先民口粮在真实火源上制成熟食';
    fixture.record.knowledgeId = cookTechniqueId;
    fixture.record.summary = '食物暴露于火可制成熟食';
    fixture.reader.knowledge.push({
      id: cookTechniqueId, kind: 'technique', summary: fixture.record.summary, confidence: 70,
      learnedAtMonth: 11, sourceEventIds: [fixture.record.id, 'prepare-reader-cook-trial'],
    });
    fixture.author.knowledge = [{
      id: cookTechniqueId, kind: 'technique', summary: fixture.record.summary, confidence: 80,
      learnedAtMonth: 8, sourceEventIds: ['prepare-author-cook-trial'],
    }];
    fixture.reader.inventory = [
      {
        id: `stack-${fixture.reader.id}-ration`, materialId: Material.Food,
        quantity: 2, sourceEventIds: [],
      },
      {
        id: 'prepare-founder-cook-record', materialId: Material.WoodTablet, quantity: 1,
        recordPayloadId: fixture.record.id, sourceEventIds: ['prepare-owned-carrier-source'],
      },
    ];
    fixture.state.world.drops = [];
    setVoxel(
      fixture.state.world.grid,
      cellX(fixture.reader.position.cellId),
      cellY(fixture.reader.position.cellId),
      fixture.reader.position.z,
      Material.Fire,
    );
    const [option] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, []);
    assert.equal(option?.recordUseBasis?.purpose, 'replicate');
    assert.equal(option.recordUseStage, 'replicate');
    const context = {
      state: fixture.state,
      person: fixture.reader,
      visibleCells: visibleCellsFor(fixture.reader),
      visiblePeople: [fixture.author],
      visibleDrops: [], visibleAnimals: [],
      options: [option], followUpOptions: [], activeIntent: fixture.parent,
    };
    const child = startInterruptIntent(
      fixture.state, fixture.reader, context, option.id,
      'record-founder-ration-replication', 13, 'record-use',
    );
    assert.ok(child);
    const replicate = appendAction(fixture, 2);
    assert.equal(replicate.diff.recordUseReplicationReceipt, true);
    assert.equal(replicate.diff.outputMaterialId, Material.CookedFood);
    assert.deepEqual(replicate.diff.recordUseInputSourceEventIds, []);
    assert.deepEqual(replicate.diff.recordUseInputWitnesses, [{
      version: 'record-use-input-witness-v1',
      role: 'input',
      personId: fixture.reader.id,
      stackId: `stack-${fixture.reader.id}-ration`,
      materialId: Material.Food,
      quantity: 1,
      sourceEventIds: [],
      genesisEntity: {
        kind: 'founder-ration',
        personId: fixture.reader.id,
        stackId: `stack-${fixture.reader.id}-ration`,
        materialId: Material.Food,
      },
    }], 'the only accepted empty lineage is an explicit canonical founder-ration entity witness');
    assert.equal(child.goalOutcome?.kind, 'achieved');
  }

  {
    const fixture = makeFixture({ groundCarrier: false, includeWood: true });
    fixture.record.authorId = fixture.reader.id;
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, visibleDrops(fixture)).length, 0);
    fixture.record.authorId = fixture.author.id;
    const millRule = inventoryCombinationForOutput(Material.Mill);
    assert.ok(millRule);
    fixture.record.knowledgeId = inventoryCombinationTechniqueId(millRule);
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, visibleDrops(fixture)).length, 0);
  }

  {
    const fixture = makeFixture({ groundCarrier: false, includeWood: true });
    const [option] = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, visibleDrops(fixture));
    assert.ok(option);
    const context = {
      state: fixture.state,
      person: fixture.reader,
      visibleCells: visibleCellsFor(fixture.reader),
      visiblePeople: [fixture.author],
      visibleDrops: visibleDrops(fixture),
      visibleAnimals: [],
      options: [option], followUpOptions: [], activeIntent: fixture.parent,
    };
    const child = startInterruptIntent(
      fixture.state, fixture.reader, context, option.id,
      'record-gap-change-interrupt', 13, 'record-use',
    );
    assert.ok(child);
    const read = appendAction(fixture, 2);
    assert.equal(read.diff.recordUseStage, 'read');
    fixture.project.need = 'food-reserve';
    fixture.project.desiredFunction = 'reserve-storage';
    assert.equal(recompileRecordUseNextAction(fixture.state, fixture.reader, child), null);

    fixture.project.need = 'hunting-safety';
    fixture.project.desiredFunction = 'safer-hunting';
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.recordPayloadId !== fixture.record.id);
    assert.equal(recompileRecordUseNextAction(fixture.state, fixture.reader, child), null);
  }

  process.stdout.write('record-use prepare episode tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
