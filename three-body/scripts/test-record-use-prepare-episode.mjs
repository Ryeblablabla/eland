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
    export { previewOwnedProjectStep } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export {
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=record-use-prepare-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    RulePlanner,
    buildDemandBoundRecordUseOptions,
    createInitialState,
    executeActiveIntent,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    planLocallyForTick,
    previewOwnedProjectStep,
    recompileRecordUseNextAction,
    startInterruptIntent,
    visibleCellsFor,
  } = simulation;

  const makeFixture = ({ groundCarrier = true, includeWood = false } = {}) => {
    const state = createInitialState(824, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.past = [];
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
    const fact = executeActiveIntent(
      fixture.state,
      fixture.reader,
      13,
      fixture.state.world.past.length,
      actionTick,
    );
    assert.ok(fact?.kind === 'action');
    fixture.state.world.past.push(fact);
    return fact;
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
