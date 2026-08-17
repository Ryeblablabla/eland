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
    export { createInitialState, RulePlanner, startInterruptIntent } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDemandBoundRecordUseOptions, recompileRecordUseNextAction } from ${JSON.stringify(path.resolve('src/game/eland/application/record-use-options.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction, goalSatisfied } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=demand-bound-record-use-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    RulePlanner,
    buildDemandBoundRecordUseOptions,
    createInitialState,
    executePrimitiveAction,
    goalSatisfied,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    recordProjectAction,
    recompileRecordUseNextAction,
    startInterruptIntent,
  } = simulation;

  const makeFixture = () => {
    const state = createInitialState(821, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    const reader = state.people[0];
    const author = state.people[1];
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
    const record = {
      id: 'record-demand-fixture', authorId: author.id, knowledgeId: techniqueId,
      codebookId, kind: 'technique', summary: '石制工具与木材可结合成长矛',
      version: 1, createdAtMonth: 8, sourceEventIds: ['record-writing'],
    };
    state.records = [record];
    author.inventory.push({
      id: 'author-record-carrier', materialId: Material.WoodTablet, quantity: 1,
      recordPayloadId: record.id, sourceEventIds: ['record-writing'],
    });
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
    return { state, reader, author, record, project, parent, techniqueId, codebookId };
  };

  {
    const fixture = makeFixture();
    const projectBeforePreview = structuredClone(fixture.project);
    const shareOptions = buildDemandBoundRecordUseOptions(fixture.state, fixture.author, [fixture.reader]);
    const share = shareOptions.find((option) => option.id.startsWith('share-demand-record:'));
    assert.ok(share, 'a physically held matching record should be shared for a real local project deficit');
    assert.equal(share.recordUseBasis?.projectId, fixture.project.id);
    assert.equal(share.recordUseBasis?.readerId, fixture.reader.id);
    assert.equal(share.recordUseBasis?.techniqueId, fixture.techniqueId);
    assert.deepEqual(fixture.project, projectBeforePreview, 'preview compilation must not mutate the authoritative project');

    const shareFact = executePrimitiveAction(
      fixture.state, fixture.author, share.nextAction, 13, 0,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(shareFact.status, 'completed');
    assert.equal(goalSatisfied(fixture.state, fixture.author, share.goal), true);

    const useOptions = buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.author]);
    const use = useOptions.find((option) => option.id.startsWith('use-demand-record:'));
    assert.ok(use, 'the reader should get a read-and-reproduce option only after receiving the carrier');
    assert.equal(use.goal.kind, 'knowledge');
    assert.equal(use.goal.minConfidence, 55);

    const context = {
      state: fixture.state, person: fixture.reader,
      visibleCells: [fixture.reader.position.cellId], visiblePeople: [fixture.author],
      visibleDrops: [], visibleAnimals: [], options: [use], followUpOptions: [],
      activeIntent: fixture.parent,
    };
    const decision = new RulePlanner().decideAt(context, { atMonth: 13, planningTick: 2 });
    assert.equal(decision.kind, 'revise');
    assert.equal(decision.mode, 'interrupt');
    assert.equal(decision.interruptionKind, 'record-use');
    const child = startInterruptIntent(
      fixture.state, fixture.reader, context, use.id, 'record-use-decision', 13, 'record-use',
    );
    assert.ok(child);
    assert.equal(child.returnToIntentId, fixture.parent.id);
    assert.equal(child.recordUseBasis?.basisKey, use.recordUseBasis?.basisKey);
    assert.equal(fixture.parent.status, 'suspended');

    const readAction = recompileRecordUseNextAction(fixture.state, fixture.reader, child);
    assert.equal(readAction?.kind, 'attend');
    child.nextAction = readAction;
    const readFact = executePrimitiveAction(
      fixture.state, fixture.reader, readAction, 13, 1,
      { cause: 'intent', intentId: child.id, actionTick: 2 },
    );
    assert.equal(readFact.status, 'completed');
    assert.equal(readFact.diff.understood, true);
    const tentative = fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId);
    assert.ok(tentative);
    assert.ok(tentative.sourceEventIds.includes(fixture.record.id));
    assert.ok(tentative.confidence <= 54, 'reading alone must remain below the reliable threshold');

    const experimentAction = recompileRecordUseNextAction(fixture.state, fixture.reader, child);
    assert.equal(experimentAction?.kind, 'act');
    const experimentFact = executePrimitiveAction(
      fixture.state, fixture.reader, experimentAction, 13, 2,
      { cause: 'intent', intentId: child.id, actionTick: 3 },
    );
    assert.equal(experimentFact.status, 'completed');
    assert.equal(experimentFact.diff.outputMaterialId, Material.Spear);
    assert.ok((fixture.reader.knowledge.find((fact) => fact.id === fixture.techniqueId)?.confidence ?? 0) >= 55);
    recordProjectAction(fixture.state, fixture.project.id, experimentFact);
    assert.equal(fixture.project.status, 'completed', 'the same real experiment must advance/complete the anchored project');
    assert.ok(fixture.project.progressEvidence.some((evidence) => evidence.eventId === experimentFact.id));
  }

  {
    const fixture = makeFixture();
    fixture.reader.knowledge = [];
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.author, [fixture.reader]).length, 0,
      'a matching payload without a shared reliable codebook is ineligible');
  }

  {
    const fixture = makeFixture();
    fixture.reader.inventory = fixture.reader.inventory.filter((stack) => stack.materialId !== Material.Wood);
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.author, [fixture.reader]).length, 0,
      'a record cannot become eligible before every real experiment input is held');
  }

  {
    const fixture = makeFixture();
    fixture.record.knowledgeId = 'technique:unrelated';
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.author, [fixture.reader]).length, 0,
      'summary similarity cannot join an unrelated knowledge id to the project action');
  }

  {
    const fixture = makeFixture();
    fixture.record.authorId = fixture.reader.id;
    fixture.reader.inventory.push(...fixture.author.inventory.splice(0));
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.reader, [fixture.author]).length, 0,
      'the author reading their own payload is not an independent record-use chain');
  }

  {
    const fixture = makeFixture();
    fixture.reader.knowledge.push({
      id: fixture.techniqueId, kind: 'technique', summary: '已经可靠掌握', confidence: 55,
      learnedAtMonth: 11, sourceEventIds: ['own-experiment'],
    });
    assert.equal(buildDemandBoundRecordUseOptions(fixture.state, fixture.author, [fixture.reader]).length, 0,
      'a reader who already has reliable technique knowledge has no record-use deficit');
  }

  process.stdout.write('demand-bound record-use tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
