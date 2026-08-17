import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hypothesisSourcePath = path.resolve('src/game/eland/application/project-hypotheses.ts');
const projectOptionsPath = path.resolve('src/game/eland/application/project-options.ts');
const hypothesisSource = readFileSync(hypothesisSourcePath, 'utf8');
const projectOptionsSource = readFileSync(projectOptionsPath, 'utf8');

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `project-options must retain ${name} for the v25 static guard`);
  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${name} must have a readable body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} must have a balanced body`);
}

assert.ok(
  !hypothesisSource.includes('interaction-rules'),
  'grounded operation roles must not import the authoritative interaction rule table',
);
assert.ok(
  !/\b(?:inventoryCombinationRules|inventoryCombinationFor|inventoryCombinationForOutput|exertionRuleFor|exposureRuleFor)\b/.test(hypothesisSource),
  'grounded operation roles must not query authoritative interaction outcomes indirectly',
);
assert.ok(
  !/\bMaterial\.(?:Stone|Wood|Fiber|Fire)\b/.test(hypothesisSource),
  'grounded operation roles must not hard-code the successful Stone/Wood/Fiber/Fire chain',
);

const unknownFoodCompilerSource = namedFunctionSource(projectOptionsSource, 'foodPreparationStep');
const unknownRecordCompilerSource = namedFunctionSource(projectOptionsSource, 'durableRecordStep');

assert.ok(
  !/const\s+stoneTool\s*=\s*person\.inventory\.find\([\s\S]{0,240}?Material\.StoneTool[\s\S]{0,240}?if\s*\(\s*!stoneTool\s*\)\s*\{[\s\S]{0,500}?hypothesisStep\(/.test(unknownFoodCompilerSource),
  'unknown prepared-food compilation must not gate its operation question on a held StoneTool',
);
assert.ok(
  !/const\s+tool\s*=\s*person\.inventory\.find\([\s\S]{0,240}?Material\.StoneTool[\s\S]{0,240}?if\s*\(\s*!tool\s*\)\s*\{[\s\S]{0,500}?hypothesisStep\(/.test(unknownRecordCompilerSource),
  'unknown durable-record compilation must not gate its operation question on a held StoneTool',
);
assert.ok(
  !/const\s+knownIgnition\s*=\s*reliableExertionKnowledge\([\s\S]{0,220}?Material\.Fiber[\s\S]{0,120}?\);\s*if\s*\(\s*!knownIgnition\s*\)\s*\{[\s\S]{0,500}?questionKind:\s*'seek-local-heat'/.test(unknownFoodCompilerSource),
  'unknown prepared-food compilation must not use the exact Fiber technique as the blind exert-stage switch',
);
assert.ok(
  !/const\s+knownCarving\s*=\s*reliableExertionKnowledge\([\s\S]{0,220}?Material\.Wood[\s\S]{0,120}?\);\s*if\s*\(\s*!knownCarving\s*\)\s*\{[\s\S]{0,500}?questionKind:\s*'shape-portable-surface'/.test(unknownRecordCompilerSource),
  'unknown durable-record compilation must not use the exact Wood technique as the blind exert-stage switch',
);

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-grounded-operation-role-test-'));
const bundlePath = path.join(temporaryDirectory, 'grounded-operation-roles.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { exertionRuleFor, exposureRuleFor } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { voxelNoResponseFactId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-knowledge.ts'))};
    export { Material, materialDefinition } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
    export * as projectHypotheses from ${JSON.stringify(hypothesisSourcePath)};
    export * as projectOptions from ${JSON.stringify(projectOptionsPath)};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=grounded-operation-role-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    cellX,
    cellY,
    createInitialState,
    executePrimitiveAction,
    exertionRuleFor,
    exposureRuleFor,
    materialDefinition,
    neighbors4,
    projectHypotheses,
    projectOptions,
    setVoxel,
    voxelAt,
    voxelNoResponseFactId,
  } = simulation;

  function requiredExport(namespace, name, moduleName) {
    const value = namespace[name];
    assert.equal(typeof value, 'function', `${moduleName} must export ${name} for the v25 directed test`);
    return value;
  }

  const api = {
    refreshCampaign(
      state,
      actor,
      project,
      request = { operation: 'combine-inventory' },
      atMonth = state.clock.elapsedMonths + 1,
      visibleDrops = [],
    ) {
      return requiredExport(
        projectHypotheses,
        'refreshProjectHypothesisCampaign',
        'project-hypotheses',
      )(state.seed, atMonth, actor, project, visibleDrops, request);
    },
    nextCandidate(
      state,
      actor,
      project,
      request = { operation: 'combine-inventory' },
      atMonth = state.clock.elapsedMonths + 1,
      visibleDrops = [],
    ) {
      return requiredExport(
        projectHypotheses,
        'nextProjectHypothesisCandidate',
        'project-hypotheses',
      )(state.seed, atMonth, actor, project, visibleDrops, request);
    },
    recompile(state, actor, project) {
      return requiredExport(
        projectOptions,
        'recompileProjectNextAction',
        'project-options',
      )(state, actor, project.id);
    },
    record(state, project, fact) {
      return requiredExport(
        projectOptions,
        'recordProjectAction',
        'project-options',
      )(state, project.id, fact);
    },
  };

  const QUESTION_KINDS = [
    'connect-manipulator-shapes',
    'connect-flexible-layers',
    'seek-local-heat',
    'shape-portable-surface',
    'transform-subject-with-observed-heat',
  ];

  const canonicalPair = (materialIds) => [...materialIds].sort((left, right) => left - right);
  const samePair = (left, right) => {
    const canonicalLeft = canonicalPair(left);
    const canonicalRight = canonicalPair(right);
    return canonicalLeft[0] === canonicalRight[0] && canonicalLeft[1] === canonicalRight[1];
  };

  function makeProject(actor, id, desiredFunction = 'durable-record') {
    return {
      id,
      kind: 'inquiry',
      need: desiredFunction === 'prepared-food'
        ? 'food-preparation'
        : desiredFunction === 'insulation'
          ? 'thermal-safety'
          : desiredFunction === 'safer-hunting'
            ? 'hunting-safety'
            : 'knowledge-preservation',
      desiredFunction,
      summary: '用眼前实体回应一个真实的局部困境',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [`local-grounded-role-pressure:${id}`],
      pressure: 72,
      createdAtMonth: 1,
      reviewAtMonth: 100,
      status: 'active',
      lastProgressAtMonth: 1,
      missingMaterialIds: [],
      materialDemands: [],
      reservations: [],
      contributorIds: [actor.id],
      actionEventIds: [],
      failureEventIds: [],
      completionEventIds: [],
      progressEvidence: [],
      searchCampaigns: [],
      logisticsEpisodes: [],
    };
  }

  function setHeldMaterials(actor, entries) {
    actor.inventory = entries.map(([materialId, quantity], index) => ({
      id: `held-${actor.id}-${materialId}-${index}`,
      materialId,
      quantity,
      sourceEventIds: [`observed-${actor.id}-${materialId}-${index}`],
    }));
  }

  function makeFixture(seed, id, desiredFunction, entries) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    state.world.drops = [];
    const actor = state.people[0];
    actor.knowledge = [];
    setHeldMaterials(actor, entries);
    const project = makeProject(actor, id, desiredFunction);
    state.projects = [project];
    return { state, actor, project, orderInMonth: 0 };
  }

  function prepareAdjacentVoxel(fixture, materialId) {
    const { state, actor } = fixture;
    const occupied = new Set(state.people
      .filter((person) => person.id !== actor.id)
      .map((person) => person.position.cellId));
    const neighbors = neighbors4(actor.position.cellId);
    const targetCell = neighbors.find((cellId) => !occupied.has(cellId)) ?? neighbors[0];
    assert.notEqual(targetCell, undefined, 'fixture needs one adjacent cell');
    for (const person of state.people.filter((candidate) => candidate.id !== actor.id
      && candidate.position.cellId === targetCell)) {
      person.position.cellId = actor.position.cellId;
      person.position.z = actor.position.z;
    }
    const position = { x: cellX(targetCell), y: cellY(targetCell), z: actor.position.z };
    setVoxel(state.world.grid, position.x, position.y, position.z - 1, Material.Stone);
    setVoxel(state.world.grid, position.x, position.y, position.z, materialId);
    return position;
  }

  function requestFor(
    operation,
    questionKind,
    targetMaterialId,
    position,
    targetSourceFactIds = [],
    subjectSourceKeys = [],
  ) {
    return {
      operation,
      questionKind,
      ...(subjectSourceKeys.length ? { subjectSourceKeys } : {}),
      ...(targetMaterialId === undefined ? {} : {
        targetMaterialId,
        targetSourceFactIds,
        targetSourceKeys: [`voxel:${position.x}:${position.y}:${position.z}:${targetMaterialId}`],
      }),
    };
  }

  function assertUnknownCandidate(candidate) {
    for (const forbidden of [
      'outputMaterialId',
      'expectedOutputMaterialId',
      'expectedOutput',
      'ruleId',
      'techniqueId',
    ]) {
      assert.equal(Object.hasOwn(candidate, forbidden), false, `unknown candidate must not contain ${forbidden}`);
    }
  }

  function assertCandidateRoleBasis(candidate, operation, questionKind) {
    assert.equal(candidate.operation, operation);
    assert.equal(candidate.questionKind, questionKind);
    assert.ok(Number.isFinite(candidate.roleScore), `${candidate.key} must have a finite roleScore`);
    assert.ok(Array.isArray(candidate.roleReasonKeys),
      `${candidate.key} must retain a replayable roleReasonKeys field, including an empty basis for a poor candidate`);
    assert.equal(new Set(candidate.roleReasonKeys).size, candidate.roleReasonKeys.length,
      `${candidate.key} role reasons must be deduplicated`);
    assert.ok(candidate.roleReasonKeys.every((key) => typeof key === 'string' && key.length > 0));
    assert.ok(Array.isArray(candidate.sourceKeys) && candidate.sourceKeys.length > 0,
      `${candidate.key} must retain tangible source keys`);
    assert.ok(candidate.sourceKeys.some((key) => key.startsWith('inventory:')),
      `${candidate.key} must be grounded in a held entity`);
    if (operation === 'exert-air') {
      assert.ok(Number.isFinite(candidate.toolRoleScore), `${candidate.key} must score its tool role`);
      assert.ok(Number.isFinite(candidate.inputRoleScore), `${candidate.key} must score its input role`);
      assert.ok(candidate.toolSourceKey?.startsWith('inventory:'),
        `${candidate.key} must bind its tool role to one exact held entity`);
      assert.ok(typeof candidate.inputSourceKey === 'string' && candidate.inputSourceKey.length > 0,
        `${candidate.key} must bind its input role to one exact tangible entity`);
      assert.ok(candidate.sourceKeys.includes(candidate.toolSourceKey));
      assert.ok(candidate.sourceKeys.includes(candidate.inputSourceKey));
      assert.ok(candidate.sourceKeys.some((key) => key.startsWith('voxel:')),
        `${candidate.key} must retain its adjacent target voxel`);
      if (questionKind === 'shape-portable-surface') {
        assert.equal(candidate.surfaceRoleMaterialId, candidate.inputMaterialId);
        assert.equal(candidate.surfaceRoleScore, candidate.inputRoleScore);
      }
    }
    if (operation === 'expose-local') {
      assert.ok(Number.isFinite(candidate.inputRoleScore), `${candidate.key} must score its subject role`);
      assert.ok(typeof candidate.inputSourceKey === 'string' && candidate.inputSourceKey.length > 0,
        `${candidate.key} must bind its subject role to one exact tangible entity`);
      assert.ok(candidate.sourceKeys.includes(candidate.inputSourceKey));
      assert.ok(candidate.sourceKeys.some((key) => key.startsWith('voxel:')),
        `${candidate.key} must retain its observed target voxel`);
    }
    for (const optionalScore of ['toolRoleScore', 'inputRoleScore', 'surfaceRoleScore']) {
      if (Object.hasOwn(candidate, optionalScore)) {
        assert.ok(Number.isFinite(candidate[optionalScore]), `${candidate.key} ${optionalScore} must be finite`);
      }
    }
    assertUnknownCandidate(candidate);
  }

  function candidateFor(campaign, predicate, message) {
    const candidate = campaign.candidates.find(predicate);
    assert.ok(candidate, message);
    return candidate;
  }

  function inventorySourceKey(actor, stack) {
    return `inventory:${actor.id}:${typeof stack === 'string' ? stack : stack.id}`;
  }

  function stackIdForInventorySourceKey(actor, sourceKey) {
    const prefix = `inventory:${actor.id}:`;
    assert.ok(sourceKey?.startsWith(prefix), `${sourceKey} must be an inventory source for ${actor.id}`);
    return sourceKey.slice(prefix.length);
  }

  function candidateRoleSnapshot(candidate) {
    return structuredClone({
      roleScore: candidate.roleScore,
      toolRoleScore: candidate.toolRoleScore,
      inputRoleScore: candidate.inputRoleScore,
      surfaceRoleScore: candidate.surfaceRoleScore,
      roleReasonKeys: candidate.roleReasonKeys,
      observableScore: candidate.observableScore,
      reasonKeys: candidate.reasonKeys,
      sourceFactIds: candidate.sourceFactIds,
    });
  }

  function candidateAttemptBasis(value) {
    return structuredClone({
      operation: value.operation,
      questionKind: value.questionKind,
      materialIds: value.materialIds,
      toolMaterialId: value.toolMaterialId,
      inputMaterialId: value.inputMaterialId,
      targetMaterialId: value.targetMaterialId,
      toolSourceKey: value.toolSourceKey,
      inputSourceKey: value.inputSourceKey,
      toolRoleMaterialId: value.toolRoleMaterialId,
      inputRoleMaterialId: value.inputRoleMaterialId,
      surfaceRoleMaterialId: value.surfaceRoleMaterialId,
      roleScore: value.roleScore,
      toolRoleScore: value.toolRoleScore,
      inputRoleScore: value.inputRoleScore,
      surfaceRoleScore: value.surfaceRoleScore,
      roleReasonKeys: value.roleReasonKeys,
      sourceFactIds: value.sourceFactIds,
      sourceKeys: value.sourceKeys,
    });
  }

  function assertAttemptPreservesRoleBasis(campaign, candidate, fact) {
    const attempt = campaign.attempts.find((item) => item.eventId === fact.id);
    assert.ok(attempt, `event ${fact.id} must be recorded as a hypothesis attempt`);
    assert.equal(attempt.questionKind, candidate.questionKind);
    assert.equal(attempt.roleScore, candidate.roleScore);
    assert.equal(attempt.toolRoleScore, candidate.toolRoleScore);
    assert.equal(attempt.inputRoleScore, candidate.inputRoleScore);
    assert.equal(attempt.surfaceRoleScore, candidate.surfaceRoleScore);
    assert.equal(attempt.toolSourceKey, candidate.toolSourceKey);
    assert.equal(attempt.inputSourceKey, candidate.inputSourceKey);
    assert.equal(attempt.surfaceRoleMaterialId, candidate.surfaceRoleMaterialId);
    assert.deepEqual(attempt.roleReasonKeys, candidate.roleReasonKeys);
    assert.deepEqual(attempt.sourceFactIds, candidate.sourceFactIds);
    assert.deepEqual(attempt.sourceKeys, candidate.sourceKeys);
    assert.equal(fact.diff.projectHypothesisQuestionKind, candidate.questionKind);
    assert.equal(fact.diff.projectHypothesisRoleScore, candidate.roleScore);
    assert.equal(fact.diff.projectHypothesisToolRoleScore, candidate.toolRoleScore);
    assert.equal(fact.diff.projectHypothesisInputRoleScore, candidate.inputRoleScore);
    assert.equal(fact.diff.projectHypothesisSurfaceRoleScore, candidate.surfaceRoleScore);
    assert.equal(fact.diff.projectHypothesisToolSourceKey, candidate.toolSourceKey);
    assert.equal(fact.diff.projectHypothesisInputSourceKey, candidate.inputSourceKey);
    assert.equal(fact.diff.projectHypothesisSurfaceRoleMaterialId, candidate.surfaceRoleMaterialId);
    assert.deepEqual(fact.diff.projectHypothesisRoleReasonKeys, candidate.roleReasonKeys);
    assert.deepEqual(fact.diff.projectHypothesisSourceFactIds, candidate.sourceFactIds);
    assert.deepEqual(fact.diff.projectHypothesisSourceKeys, candidate.sourceKeys);
    return attempt;
  }

  function executeAndRecord(fixture, action, expectedStatus) {
    const orderInMonth = fixture.orderInMonth;
    fixture.orderInMonth += 1;
    const fact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      action,
      7,
      orderInMonth,
      { cause: 'intent', actionTick: orderInMonth + 1 },
    );
    assert.equal(fact.status, expectedStatus);
    fixture.state.world.past.push(fact);
    api.record(fixture.state, fixture.project, fact);
    return fact;
  }

  function activateAndCombine(fixture, campaign, candidate, expectedStatus = 'completed') {
    campaign.activeCandidateKey = candidate.key;
    const action = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(action?.kind, 'act');
    assert.equal(action?.operation, 'combine');
    assert.deepEqual(
      canonicalPair(action.targets.map((target) => fixture.actor.inventory.find((stack) => stack.id === target.stackId)?.materialId)),
      canonicalPair(candidate.materialIds),
    );
    return executeAndRecord(fixture, action, expectedStatus);
  }

  function verifyLatestResponse(fixture, sourceEventId) {
    const action = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(action?.kind, 'attend', `response ${sourceEventId} must be attended before another unknown stage`);
    assert.equal(action?.verification?.sourceEventId, sourceEventId);
    const fact = executeAndRecord(fixture, action, 'completed');
    assert.equal(fact.diff.verifiedSourceEventId, sourceEventId);
    return fact;
  }

  function makeVerifiedPortableHardResponse(seed, id, desiredFunction, entries) {
    const fixture = makeFixture(seed, id, desiredFunction, entries);
    if (desiredFunction === 'durable-record') {
      fixture.project.targetKnowledgeId = `claim:preserve-grounded-role-experience:${id}`;
      fixture.actor.knowledge.push({
        id: fixture.project.targetKnowledgeId,
        kind: 'claim',
        summary: '这段有来源的经验值得保存',
        confidence: 72,
        learnedAtMonth: 5,
        sourceEventIds: ['grounded-role-experience-source'],
      });
    }
    const airPosition = prepareAdjacentVoxel(fixture, Material.Air);
    const combineRequest = requestFor(
      'combine-inventory',
      'connect-manipulator-shapes',
    );
    const campaign = api.refreshCampaign(fixture.state, fixture.actor, fixture.project, combineRequest);
    const candidate = candidateFor(
      campaign,
      (item) => item.operation === 'combine-inventory'
        && item.questionKind === 'connect-manipulator-shapes'
        && samePair(item.materialIds, [Material.Stone, Material.Wood]),
      'the held Stone and Wood must permit a grounded manipulator-shape candidate',
    );
    assertCandidateRoleBasis(candidate, 'combine-inventory', 'connect-manipulator-shapes');
    const combineFact = activateAndCombine(fixture, campaign, candidate);
    assert.equal(combineFact.diff.outputMaterialId, Material.StoneTool);
    assertAttemptPreservesRoleBasis(campaign, candidate, combineFact);
    const outputStack = fixture.actor.inventory.find((stack) => stack.id === combineFact.diff.outputStackId);
    assert.ok(outputStack && outputStack.materialId === Material.StoneTool
      && outputStack.sourceEventIds.includes(combineFact.id));
    const verifyFact = verifyLatestResponse(fixture, combineFact.id);
    const responseAttempt = campaign.attempts.find((attempt) => attempt.eventId === combineFact.id);
    assert.equal(responseAttempt?.verifiedEventId, verifyFact.id);
    return { ...fixture, campaign, airPosition, combineFact, verifyFact, outputStack };
  }

  {
    const specifications = [
      {
        seed: 2401,
        id: 'role-basis-manipulator',
        desiredFunction: 'safer-hunting',
        operation: 'combine-inventory',
        questionKind: 'connect-manipulator-shapes',
        entries: [[Material.Stone, 2], [Material.Wood, 2], [Material.Fiber, 2], [Material.Hide, 1]],
      },
      {
        seed: 2402,
        id: 'role-basis-layers',
        desiredFunction: 'insulation',
        operation: 'combine-inventory',
        questionKind: 'connect-flexible-layers',
        entries: [[Material.Stone, 1], [Material.Wood, 1], [Material.Fiber, 2], [Material.Leaves, 2]],
      },
      {
        seed: 2403,
        id: 'role-basis-heat',
        desiredFunction: 'prepared-food',
        operation: 'exert-air',
        questionKind: 'seek-local-heat',
        targetMaterialId: Material.Air,
        entries: [[Material.StoneTool, 1], [Material.Stone, 1], [Material.Fiber, 1], [Material.Leaves, 1]],
      },
      {
        seed: 2404,
        id: 'role-basis-surface',
        desiredFunction: 'durable-record',
        operation: 'exert-air',
        questionKind: 'shape-portable-surface',
        targetMaterialId: Material.Air,
        entries: [[Material.StoneTool, 1], [Material.Stone, 1], [Material.Wood, 1], [Material.Fiber, 1]],
      },
      {
        seed: 2405,
        id: 'role-basis-observed-heat',
        desiredFunction: 'prepared-food',
        operation: 'expose-local',
        questionKind: 'transform-subject-with-observed-heat',
        targetMaterialId: Material.Fire,
        entries: [[Material.RawMeat, 1], [Material.Food, 1], [Material.Wood, 1]],
      },
    ];
    const coveredQuestions = new Set();
    for (const specification of specifications) {
      const fixture = makeFixture(
        specification.seed,
        specification.id,
        specification.desiredFunction,
        specification.entries,
      );
      const position = specification.targetMaterialId === undefined
        ? undefined
        : prepareAdjacentVoxel(fixture, specification.targetMaterialId);
      const request = requestFor(
        specification.operation,
        specification.questionKind,
        specification.targetMaterialId,
        position,
      );
      const campaign = api.refreshCampaign(fixture.state, fixture.actor, fixture.project, request);
      const candidates = campaign.candidates.filter((candidate) => candidate.operation === specification.operation
        && candidate.questionKind === specification.questionKind);
      assert.ok(candidates.length > 0, `${specification.questionKind} must produce at least one grounded candidate`);
      for (const candidate of candidates) {
        assertCandidateRoleBasis(candidate, specification.operation, specification.questionKind);
        coveredQuestions.add(candidate.questionKind);
      }
    }
    assert.deepEqual([...coveredQuestions].sort(), [...QUESTION_KINDS].sort(),
      'all five grounded operation questions must expose complete role basis');
  }

  {
    const fixture = makeVerifiedPortableHardResponse(
      2410,
      'prepared-food-role-chain',
      'prepared-food',
      [
        [Material.Stone, 2],
        [Material.Wood, 1],
        [Material.Fiber, 2],
        [Material.Leaves, 1],
        [Material.RawMeat, 1],
        [Material.Hide, 1],
      ],
    );
    const heatRequest = requestFor(
      'exert-air',
      'seek-local-heat',
      Material.Air,
      fixture.airPosition,
    );
    api.refreshCampaign(fixture.state, fixture.actor, fixture.project, heatRequest);
    const heatCandidates = fixture.campaign.candidates.filter((candidate) => candidate.operation === 'exert-air'
      && candidate.questionKind === 'seek-local-heat');
    assert.ok(heatCandidates.length > 0);
    for (const candidate of heatCandidates) assertCandidateRoleBasis(candidate, 'exert-air', 'seek-local-heat');

    const verifiedAsTool = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Stone,
      'the verified portable hard response must remain available as an exert tool',
    );
    const verifiedAsInput = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.Stone
        && candidate.inputMaterialId === Material.StoneTool,
      'the same verified response must also be judged, fallibly, in the input role',
    );
    assert.ok(verifiedAsTool.toolRoleScore > verifiedAsInput.inputRoleScore,
      'a verified portable hard response must score higher as an exert tool than as an input');
    assert.ok(verifiedAsTool.sourceFactIds.includes(fixture.combineFact.id),
      'tool-role basis must retain the response entity provenance');
    assert.ok(verifiedAsTool.sourceFactIds.includes(fixture.verifyFact.id),
      'tool-role basis must retain the exact verification event');

    const fiberCandidate = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Fiber,
      'seek-local-heat must consider a held fiber input',
    );
    const plantCandidate = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Leaves,
      'seek-local-heat must consider a held light plant input',
    );
    const wrongGroundedCandidate = verifiedAsTool;
    assert.ok(fiberCandidate.inputRoleScore > wrongGroundedCandidate.inputRoleScore);
    assert.ok(plantCandidate.inputRoleScore > wrongGroundedCandidate.inputRoleScore);
    assert.ok(fiberCandidate.roleScore > wrongGroundedCandidate.roleScore);
    assert.ok(plantCandidate.roleScore > wrongGroundedCandidate.roleScore,
      'seek-local-heat must favor soft, light, fiber or plant inputs over a hard heavy input');
    assert.equal(
      exertionRuleFor(
        wrongGroundedCandidate.toolMaterialId,
        wrongGroundedCandidate.inputMaterialId,
        wrongGroundedCandidate.targetMaterialId,
      ),
      undefined,
      'the rule oracle is used only by the test to prove a wrong candidate remains',
    );
    assert.ok(wrongGroundedCandidate.sourceKeys.some((key) => key.startsWith('inventory:'))
      && wrongGroundedCandidate.sourceKeys.some((key) => key.startsWith('voxel:')),
    'the wrong candidate must still be grounded in held entities and a real adjacent voxel');

    fixture.campaign.activeCandidateKey = fiberCandidate.key;
    const exertAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(exertAction?.kind, 'act');
    assert.equal(exertAction?.operation, 'exert');
    const exertTarget = exertAction.targets.find((target) => target.kind === 'voxel');
    assert.ok(exertTarget, 'the exert attempt must target one real adjacent voxel');
    assert.equal(voxelAt(
      fixture.state.world.grid,
      exertTarget.position.x,
      exertTarget.position.y,
      exertTarget.position.z,
    ), Material.Air, 'candidate generation must not create the requested heat response');
    const exertFact = executeAndRecord(fixture, exertAction, 'completed');
    assert.equal(exertFact.diff.outputMaterialId, Material.Fire);
    assertAttemptPreservesRoleBasis(fixture.campaign, fiberCandidate, exertFact);
    assert.equal(voxelAt(
      fixture.state.world.grid,
      exertTarget.position.x,
      exertTarget.position.y,
      exertTarget.position.z,
    ), Material.Fire, 'only the authoritative executor may create the real heat source');
    const verifyFireFact = verifyLatestResponse(fixture, exertFact.id);

    const exposeRequest = requestFor(
      'expose-local',
      'transform-subject-with-observed-heat',
      Material.Fire,
      exertTarget.position,
      [exertFact.id, verifyFireFact.id],
    );
    api.refreshCampaign(fixture.state, fixture.actor, fixture.project, exposeRequest);
    const exposeCandidate = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'expose-local'
        && candidate.questionKind === 'transform-subject-with-observed-heat'
        && candidate.inputMaterialId === Material.RawMeat
        && candidate.targetMaterialId === Material.Fire,
      'the real observed heat and held food subject must permit a grounded exposure candidate',
    );
    assertCandidateRoleBasis(exposeCandidate, 'expose-local', 'transform-subject-with-observed-heat');
    assertUnknownCandidate(exposeCandidate);
    fixture.campaign.activeCandidateKey = exposeCandidate.key;
    const exposeAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(exposeAction?.kind, 'act');
    assert.equal(exposeAction?.operation, 'expose');
    const exposeFact = executeAndRecord(fixture, exposeAction, 'completed');
    assert.equal(exposeFact.diff.outputMaterialId, Material.CookedFood);
    assertAttemptPreservesRoleBasis(fixture.campaign, exposeCandidate, exposeFact);
    assert.ok(fixture.actor.inventory.some((stack) => stack.id === exposeFact.diff.outputStackId
      && stack.materialId === Material.CookedFood
      && stack.sourceEventIds.includes(exposeFact.id)),
    'the complete v23 food response chain must remain executable');
  }

  {
    const fixture = makeVerifiedPortableHardResponse(
      2411,
      'durable-record-role-chain',
      'durable-record',
      [[Material.Stone, 2], [Material.Wood, 2], [Material.Fiber, 1]],
    );
    const surfaceRequest = requestFor(
      'exert-air',
      'shape-portable-surface',
      Material.Air,
      fixture.airPosition,
    );
    api.refreshCampaign(fixture.state, fixture.actor, fixture.project, surfaceRequest);
    const surfaceCandidate = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'shape-portable-surface'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Wood,
      'shape-portable-surface must consider the held portable medium solid',
    );
    const heavyHardCandidate = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'shape-portable-surface'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Stone,
      'shape-portable-surface must retain a grounded but poor heavy-hard surface judgment',
    );
    const softCandidate = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'shape-portable-surface'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Fiber,
      'shape-portable-surface must compare the portable solid with a non-solid soft input',
    );
    const surfaceDefinition = materialDefinition(surfaceCandidate.inputMaterialId);
    assert.ok(surfaceDefinition.tags.includes('solid'));
    assert.ok(surfaceDefinition.mass <= 1.5);
    assert.ok(surfaceDefinition.hardness >= 2 && surfaceDefinition.hardness <= 6);
    assert.ok(surfaceCandidate.inputRoleScore > heavyHardCandidate.inputRoleScore);
    assert.ok(surfaceCandidate.inputRoleScore > softCandidate.inputRoleScore,
      'shape-portable-surface must favor a portable, medium-hard solid surface');
    assert.ok(surfaceCandidate.roleScore > heavyHardCandidate.roleScore);
    assert.ok(surfaceCandidate.roleScore > softCandidate.roleScore);
    assertCandidateRoleBasis(surfaceCandidate, 'exert-air', 'shape-portable-surface');
    assertUnknownCandidate(surfaceCandidate);

    fixture.campaign.activeCandidateKey = surfaceCandidate.key;
    const carveAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(carveAction?.kind, 'act');
    assert.equal(carveAction?.operation, 'exert');
    const carveFact = executeAndRecord(fixture, carveAction, 'completed');
    assert.equal(carveFact.diff.outputMaterialId, Material.WoodTablet);
    assertAttemptPreservesRoleBasis(fixture.campaign, surfaceCandidate, carveFact);
    verifyLatestResponse(fixture, carveFact.id);
    const writeAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(writeAction?.kind, 'communicate');
    assert.equal(writeAction?.channel, 'record');
    const writeFact = executeAndRecord(fixture, writeAction, 'completed');
    assert.ok(fixture.state.records.some((record) => record.sourceEventIds.includes(writeFact.id)
      && record.knowledgeId === fixture.project.targetKnowledgeId),
    'the complete v23 durable-record response chain must remain executable');
  }

  {
    const state = createInitialState(2420, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    state.world.drops = [];
    const experienced = state.people[0];
    const unexposed = state.people[1];
    experienced.knowledge = [];
    unexposed.knowledge = [];
    const entries = [
      [Material.StoneTool, 1],
      [Material.Fiber, 1],
      [Material.Hide, 1],
      [Material.RawMeat, 1],
    ];
    setHeldMaterials(experienced, entries);
    setHeldMaterials(unexposed, entries);
    const noResponseEventIds = [
      'experienced-role-no-response-hide-a',
      'experienced-role-no-response-hide-b',
      'experienced-role-no-response-meat-a',
      'experienced-role-no-response-meat-b',
    ];
    experienced.knowledge.push(
      {
        id: voxelNoResponseFactId('exert', Material.Hide, Material.Air, Material.StoneTool),
        kind: 'observation',
        summary: '这个方向已经反复没有物质响应',
        confidence: 64,
        learnedAtMonth: 5,
        sourceEventIds: noResponseEventIds.slice(0, 2),
      },
      {
        id: voxelNoResponseFactId('exert', Material.RawMeat, Material.Air, Material.StoneTool),
        kind: 'observation',
        summary: '同一工具角色在另一输入上也反复没有物质响应',
        confidence: 64,
        learnedAtMonth: 5,
        sourceEventIds: noResponseEventIds.slice(2),
      },
    );
    const experiencedProject = makeProject(experienced, 'personal-role-evidence-experienced', 'prepared-food');
    const unexposedProject = makeProject(unexposed, 'personal-role-evidence-unexposed', 'prepared-food');
    state.projects = [experiencedProject, unexposedProject];
    const experiencedPosition = prepareAdjacentVoxel({ state, actor: experienced }, Material.Air);
    const unexposedPosition = prepareAdjacentVoxel({ state, actor: unexposed }, Material.Air);
    const experiencedCampaign = api.refreshCampaign(
      state,
      experienced,
      experiencedProject,
      requestFor('exert-air', 'seek-local-heat', Material.Air, experiencedPosition),
    );
    const unexposedCampaign = api.refreshCampaign(
      state,
      unexposed,
      unexposedProject,
      requestFor('exert-air', 'seek-local-heat', Material.Air, unexposedPosition),
    );
    const experiencedCandidate = candidateFor(
      experiencedCampaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Fiber,
      'experienced person must still form a new grounded candidate after role-specific failures',
    );
    const unexposedCandidate = candidateFor(
      unexposedCampaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Fiber,
      'another person with the same tangible materials must form the comparable candidate',
    );
    assert.ok(experiencedCandidate.toolRoleScore < unexposedCandidate.toolRoleScore,
      'repeated no-response in the same tool direction must lower only that person\'s tool-role score');
    assert.equal(experiencedCandidate.inputRoleScore, unexposedCandidate.inputRoleScore,
      'tool-role failure evidence must not leak into an unseen input role');
    assert.ok(experiencedCandidate.roleScore < unexposedCandidate.roleScore);
    assert.ok(noResponseEventIds.every((eventId) => experiencedCandidate.sourceFactIds.includes(eventId)),
      'personal role downweighting must retain its exact no-response provenance');
    assert.ok(noResponseEventIds.every((eventId) => !unexposedCandidate.sourceFactIds.includes(eventId)),
      'one person must not inherit another person\'s role evidence');
  }

  function assertInvalidKnowledgeIgnored({
    make,
    requestForFixture,
    candidatePredicate,
    invalidFacts,
    message,
  }) {
    const baseline = make();
    const baselineRequest = requestForFixture(baseline);
    const baselineCampaign = api.refreshCampaign(
      baseline.state,
      baseline.actor,
      baseline.project,
      baselineRequest,
    );
    const baselineCandidate = candidateFor(baselineCampaign, candidatePredicate, `${message} baseline candidate`);

    const tainted = make();
    const invalidSourceIds = invalidFacts.map((fact, index) => `invalid-v25-knowledge-${index}-${fact.id}`);
    tainted.actor.knowledge.push(...invalidFacts.map((fact, index) => ({
      id: fact.id,
      kind: fact.kind,
      summary: '这条格式损坏的个人事实不能进入角色判断',
      confidence: 88,
      learnedAtMonth: 5,
      sourceEventIds: [invalidSourceIds[index]],
    })));
    const taintedRequest = requestForFixture(tainted);
    const taintedCampaign = api.refreshCampaign(
      tainted.state,
      tainted.actor,
      tainted.project,
      taintedRequest,
    );
    const taintedCandidate = candidateFor(taintedCampaign, candidatePredicate, `${message} tainted candidate`);
    assert.deepEqual(
      candidateRoleSnapshot(taintedCandidate),
      candidateRoleSnapshot(baselineCandidate),
      `${message}: malformed, incomplete, overlong and unknown-ID facts must be role-score neutral`,
    );
    assert.ok(invalidSourceIds.every((eventId) => !taintedCandidate.sourceFactIds.includes(eventId)),
      `${message}: rejected facts must not leak into the candidate provenance`);
    const selected = api.nextCandidate(
      tainted.state,
      tainted.actor,
      tainted.project,
      taintedRequest,
    );
    assert.equal(selected?.key, taintedCandidate.key,
      `${message}: an invalid technique must not suppress the unknown candidate as reliable exact knowledge`);
  }

  {
    const unknownMaterialId = 999_999;
    const exertPrefix = `technique:exert:${Material.StoneTool}:${Material.Fiber}:${Material.Air}`;
    const exertNoResponsePrefix = `observation:no-response:exert:${Material.StoneTool}:${Material.Fiber}`;
    assertInvalidKnowledgeIgnored({
      make() {
        const fixture = makeFixture(
          2501,
          'strict-exert-knowledge-id',
          'prepared-food',
          [[Material.StoneTool, 1], [Material.Fiber, 1]],
        );
        fixture.testPosition = prepareAdjacentVoxel(fixture, Material.Air);
        return fixture;
      },
      requestForFixture: (fixture) => requestFor(
        'exert-air',
        'seek-local-heat',
        Material.Air,
        fixture.testPosition,
      ),
      candidatePredicate: (candidate) => candidate.operation === 'exert-air'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Fiber
        && candidate.targetMaterialId === Material.Air,
      invalidFacts: [
        { kind: 'technique', id: exertPrefix },
        { kind: 'technique', id: `${exertPrefix}:${Material.Fire}:extra` },
        { kind: 'technique', id: `${exertPrefix}:not-a-material` },
        { kind: 'technique', id: `${exertPrefix}:${unknownMaterialId}` },
        { kind: 'observation', id: exertNoResponsePrefix },
        { kind: 'observation', id: `${exertNoResponsePrefix}:${Material.Air}:extra` },
        { kind: 'observation', id: `${exertNoResponsePrefix}:not-a-material` },
        { kind: 'observation', id: `${exertNoResponsePrefix}:${unknownMaterialId}` },
      ],
      message: 'exert knowledge parser',
    });
  }

  {
    const unknownMaterialId = 999_999;
    const exposePrefix = `technique:expose:${Material.RawMeat}:${Material.Fire}`;
    const exposeNoResponsePrefix = `observation:no-response:expose:${Material.RawMeat}`;
    assertInvalidKnowledgeIgnored({
      make() {
        const fixture = makeFixture(
          2502,
          'strict-expose-knowledge-id',
          'prepared-food',
          [[Material.RawMeat, 1]],
        );
        fixture.testPosition = prepareAdjacentVoxel(fixture, Material.Fire);
        return fixture;
      },
      requestForFixture: (fixture) => requestFor(
        'expose-local',
        'transform-subject-with-observed-heat',
        Material.Fire,
        fixture.testPosition,
      ),
      candidatePredicate: (candidate) => candidate.operation === 'expose-local'
        && candidate.inputMaterialId === Material.RawMeat
        && candidate.targetMaterialId === Material.Fire,
      invalidFacts: [
        { kind: 'technique', id: exposePrefix },
        { kind: 'technique', id: `${exposePrefix}:${Material.CookedFood}:extra` },
        { kind: 'technique', id: `${exposePrefix}:not-a-material` },
        { kind: 'technique', id: `${exposePrefix}:${unknownMaterialId}` },
        { kind: 'observation', id: exposeNoResponsePrefix },
        { kind: 'observation', id: `${exposeNoResponsePrefix}:${Material.Fire}:extra` },
        { kind: 'observation', id: `${exposeNoResponsePrefix}:not-a-material` },
        { kind: 'observation', id: `${exposeNoResponsePrefix}:${unknownMaterialId}` },
      ],
      message: 'expose knowledge parser',
    });
  }

  {
    const unknownMaterialId = 999_999;
    const inputs = `${Material.Stone}x1+${Material.Wood}x1`;
    assertInvalidKnowledgeIgnored({
      make: () => makeFixture(
        2503,
        'strict-combine-knowledge-id',
        'safer-hunting',
        [[Material.Stone, 1], [Material.Wood, 1]],
      ),
      requestForFixture: () => requestFor('combine-inventory', 'connect-manipulator-shapes'),
      candidatePredicate: (candidate) => candidate.operation === 'combine-inventory'
        && samePair(candidate.materialIds, [Material.Stone, Material.Wood]),
      invalidFacts: [
        { kind: 'technique', id: `technique:combine-inventory:${inputs}` },
        { kind: 'technique', id: `technique:combine-inventory:${inputs}:${Material.StoneTool}:extra` },
        { kind: 'technique', id: `technique:combine-inventory:${inputs}:not-a-material` },
        { kind: 'technique', id: `technique:combine-inventory:${inputs}:${unknownMaterialId}` },
        { kind: 'technique', id: `technique:combine-inventory:${Material.Wood}x1+${Material.Stone}x1:${Material.StoneTool}` },
        { kind: 'technique', id: `technique:combine-inventory:${Material.Stone}x2+${Material.Wood}x1:${Material.StoneTool}` },
        { kind: 'observation', id: `observation:no-response:combine-inventory:${Material.Stone}` },
        { kind: 'observation', id: `observation:no-response:combine-inventory:${Material.Stone}+${Material.Wood}:extra` },
        { kind: 'observation', id: `observation:no-response:combine-inventory:${Material.Stone}+${unknownMaterialId}` },
      ],
      message: 'combine knowledge parser',
    });
  }

  {
    const fixture = makeVerifiedPortableHardResponse(
      2510,
      'exact-response-entity-binding',
      'prepared-food',
      [
        [Material.Stone, 2],
        [Material.Wood, 1],
        [Material.Fiber, 1],
        [Material.RawMeat, 1],
      ],
    );
    const replacementStack = {
      id: 'replacement-stone-tool-stack',
      materialId: Material.StoneTool,
      quantity: 1,
      sourceEventIds: ['replacement-stone-tool-source'],
    };
    fixture.actor.inventory.unshift(replacementStack);
    const request = requestFor(
      'exert-air',
      'seek-local-heat',
      Material.Air,
      fixture.airPosition,
    );
    api.refreshCampaign(fixture.state, fixture.actor, fixture.project, request);
    const exactSourceKey = inventorySourceKey(fixture.actor, fixture.outputStack);
    const replacementSourceKey = inventorySourceKey(fixture.actor, replacementStack);
    const exactAsTool = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Fiber,
      'the exact verified response entity must be available as an exert tool',
    );
    assert.equal(exactAsTool.toolSourceKey, exactSourceKey);
    assert.ok(exactAsTool.roleReasonKeys.includes('exact-verified-response-as-tool'));
    assert.ok(exactAsTool.sourceFactIds.includes(fixture.combineFact.id));
    assert.ok(exactAsTool.sourceFactIds.includes(fixture.verifyFact.id));
    fixture.campaign.activeCandidateKey = exactAsTool.key;
    const exactToolAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(exactToolAction?.kind, 'act');
    assert.equal(exactToolAction?.operation, 'exert');
    assert.equal(exactToolAction.toolStackId, fixture.outputStack.id,
      'an exact verified tool candidate must execute with its responseRef stack, not an earlier same-material replacement');

    const exactAsInput = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.Stone
        && candidate.inputMaterialId === Material.StoneTool,
      'the exact verified response entity must also retain its input-role source binding',
    );
    assert.equal(exactAsInput.inputSourceKey, exactSourceKey);
    assert.ok(exactAsInput.roleReasonKeys.includes('exact-verified-response-as-input'));
    fixture.campaign.activeCandidateKey = exactAsInput.key;
    const exactInputAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(exactInputAction?.kind, 'act');
    assert.equal(exactInputAction?.operation, 'exert');
    const exactInputRef = exactInputAction.targets.find((target) => target.kind === 'inventory-stack');
    assert.equal(exactInputRef?.stackId, fixture.outputStack.id,
      'an exact verified input candidate must execute with its responseRef stack, not a same-material replacement');

    const exactToolRoleScore = exactAsTool.roleScore;
    fixture.actor.inventory = fixture.actor.inventory.filter((stack) => stack.id !== fixture.outputStack.id);
    delete fixture.campaign.activeCandidateKey;
    api.refreshCampaign(fixture.state, fixture.actor, fixture.project, request, 8);
    const replacementAsTool = candidateFor(
      fixture.campaign,
      (candidate) => candidate.operation === 'exert-air'
        && candidate.questionKind === 'seek-local-heat'
        && candidate.toolMaterialId === Material.StoneTool
        && candidate.inputMaterialId === Material.Fiber,
      'a same-material replacement remains an observable but unverified tool candidate',
    );
    assert.equal(replacementAsTool.toolSourceKey, replacementSourceKey);
    assert.ok(!replacementAsTool.roleReasonKeys.includes('exact-verified-response-as-tool'));
    assert.ok(replacementAsTool.roleScore < exactToolRoleScore,
      'the verified response reward must disappear when only a same-material replacement remains');
    assert.ok(!replacementAsTool.sourceFactIds.includes(fixture.combineFact.id)
      && !replacementAsTool.sourceFactIds.includes(fixture.verifyFact.id),
    'the replacement candidate must not inherit the exact response or verification provenance');
    fixture.campaign.activeCandidateKey = replacementAsTool.key;
    const replacementAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(replacementAction?.kind, 'act');
    assert.equal(replacementAction?.operation, 'exert');
    assert.equal(replacementAction.toolStackId, replacementStack.id);
  }

  {
    const fixture = makeFixture(
      2520,
      'attempt-basis-freeze-after-no-response',
      'prepared-food',
      [[Material.StoneTool, 1], [Material.Hide, 1], [Material.RawMeat, 1]],
    );
    const position = prepareAdjacentVoxel(fixture, Material.Air);
    const request = requestFor('exert-air', 'seek-local-heat', Material.Air, position);
    const campaign = api.refreshCampaign(fixture.state, fixture.actor, fixture.project, request);
    const candidate = candidateFor(
      campaign,
      (item) => item.operation === 'exert-air'
        && item.toolMaterialId === Material.StoneTool
        && item.inputMaterialId === Material.Hide,
      'the freeze fixture needs one grounded no-response candidate',
    );
    const frozenBasis = candidateAttemptBasis(candidate);
    campaign.activeCandidateKey = candidate.key;
    const action = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(action?.kind, 'act');
    assert.equal(action?.operation, 'exert');
    const fact = executeAndRecord(fixture, action, 'blocked');
    const noResponseId = voxelNoResponseFactId('exert', Material.Hide, Material.Air, Material.StoneTool);
    assert.ok(fixture.actor.knowledge.some((knowledge) => knowledge.id === noResponseId
      && knowledge.sourceEventIds.includes(fact.id)),
    'the attempted actor must gain the exact no-response before campaign refresh');
    const attempt = campaign.attempts.find((item) => item.eventId === fact.id);
    assert.ok(attempt);
    assert.deepEqual(candidateAttemptBasis(attempt), frozenBasis,
      'the attempt must snapshot the candidate question, scores, reasons and exact entity source keys');
    api.refreshCampaign(fixture.state, fixture.actor, fixture.project, request, 8);
    const refreshedAttemptedCandidate = candidateFor(
      campaign,
      (item) => item.key === candidate.key,
      'refresh must retain the attempted candidate for replay',
    );
    assert.deepEqual(candidateAttemptBasis(refreshedAttemptedCandidate), frozenBasis,
      'new no-response knowledge must not rewrite the already attempted candidate basis');
    assert.deepEqual(candidateAttemptBasis(attempt), frozenBasis,
      'refresh must not mutate the recorded attempt basis');
  }

  {
    const fixture = makeFixture(
      2530,
      'food-exert-without-stone-tool',
      'prepared-food',
      [[Material.Stone, 1], [Material.Fiber, 1], [Material.RawMeat, 1]],
    );
    prepareAdjacentVoxel(fixture, Material.Air);
    assert.equal(fixture.actor.inventory.some((stack) => stack.materialId === Material.StoneTool), false);
    const action = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(action?.kind, 'act');
    assert.equal(action?.operation, 'exert',
      'unknown food compilation must open seek-local-heat from observable hard/input roles without StoneTool');
    const campaign = fixture.project.hypothesisCampaign;
    const candidate = campaign?.candidates.find((item) => item.key === campaign.activeCandidateKey);
    assert.ok(candidate);
    assert.equal(candidate.questionKind, 'seek-local-heat');
    assert.equal(action.toolStackId, stackIdForInventorySourceKey(fixture.actor, candidate.toolSourceKey));
    const inputRef = action.targets.find((target) => target.kind === 'inventory-stack');
    assert.equal(inputRef?.stackId, stackIdForInventorySourceKey(fixture.actor, candidate.inputSourceKey));
    assert.equal(
      exertionRuleFor(candidate.toolMaterialId, candidate.inputMaterialId, candidate.targetMaterialId),
      undefined,
      'the no-StoneTool fixture must prove that an unknown question can legally lead to no response',
    );
  }

  {
    const fixture = makeFixture(
      2531,
      'record-exert-without-stone-tool',
      'durable-record',
      [[Material.Bone, 1], [Material.Wood, 1]],
    );
    fixture.project.targetKnowledgeId = 'claim:record-without-stone-tool';
    fixture.actor.knowledge.push({
      id: fixture.project.targetKnowledgeId,
      kind: 'claim',
      summary: '这段可靠经验需要实体保存',
      confidence: 72,
      learnedAtMonth: 5,
      sourceEventIds: ['record-without-stone-tool-source'],
    });
    prepareAdjacentVoxel(fixture, Material.Air);
    assert.equal(fixture.actor.inventory.some((stack) => stack.materialId === Material.StoneTool), false);
    const action = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(action?.kind, 'act');
    assert.equal(action?.operation, 'exert',
      'unknown record compilation must open shape-portable-surface from observable hard/surface roles without StoneTool');
    const campaign = fixture.project.hypothesisCampaign;
    const candidate = campaign?.candidates.find((item) => item.key === campaign.activeCandidateKey);
    assert.ok(candidate);
    assert.equal(candidate.questionKind, 'shape-portable-surface');
    assert.equal(candidate.surfaceRoleMaterialId, candidate.inputMaterialId);
    assert.equal(action.toolStackId, stackIdForInventorySourceKey(fixture.actor, candidate.toolSourceKey));
    const inputRef = action.targets.find((target) => target.kind === 'inventory-stack');
    assert.equal(inputRef?.stackId, stackIdForInventorySourceKey(fixture.actor, candidate.inputSourceKey));
    assert.equal(
      exertionRuleFor(candidate.toolMaterialId, candidate.inputMaterialId, candidate.targetMaterialId),
      undefined,
      'the no-StoneTool record fixture must remain an unknown, possibly failing exert attempt',
    );
  }

  {
    const fixture = makeFixture(
      2540,
      'observable-score-authoritative-response-decoy',
      'prepared-food',
      [[Material.Food, 1], [Material.CookedFood, 1]],
    );
    const position = prepareAdjacentVoxel(fixture, Material.Fire);
    const subjectSourceKeys = fixture.actor.inventory.map((stack) => inventorySourceKey(fixture.actor, stack));
    const campaign = api.refreshCampaign(
      fixture.state,
      fixture.actor,
      fixture.project,
      requestFor(
        'expose-local',
        'transform-subject-with-observed-heat',
        Material.Fire,
        position,
        [],
        subjectSourceKeys,
      ),
    );
    const responsive = candidateFor(
      campaign,
      (candidate) => candidate.operation === 'expose-local' && candidate.inputMaterialId === Material.Food,
      'the metamorphic fixture needs the authoritative responsive subject',
    );
    const decoy = candidateFor(
      campaign,
      (candidate) => candidate.operation === 'expose-local' && candidate.inputMaterialId === Material.CookedFood,
      'the metamorphic fixture needs the same-observable no-response decoy',
    );
    assert.ok(exposureRuleFor(Material.Food, Material.Fire));
    assert.equal(exposureRuleFor(Material.CookedFood, Material.Fire), undefined);
    assert.equal(materialDefinition(Material.Food).phase, materialDefinition(Material.CookedFood).phase);
    assert.equal(materialDefinition(Material.Food).hardness, materialDefinition(Material.CookedFood).hardness);
    assert.equal(materialDefinition(Material.Food).mass, materialDefinition(Material.CookedFood).mass);
    assert.equal(responsive.observableScore, decoy.observableScore,
      'authoritative response availability must not change unknown-candidate observableScore; seededRank is intentionally ignored');
    assert.equal(responsive.roleScore, decoy.roleScore);
    assert.deepEqual(responsive.roleReasonKeys, decoy.roleReasonKeys);
  }

  function deterministicRoleSnapshot() {
    const fixture = makeFixture(
      2430,
      'deterministic-role-replay',
      'prepared-food',
      [[Material.StoneTool, 1], [Material.Stone, 1], [Material.Fiber, 1], [Material.Leaves, 1]],
    );
    const position = prepareAdjacentVoxel(fixture, Material.Air);
    const campaign = api.refreshCampaign(
      fixture.state,
      fixture.actor,
      fixture.project,
      requestFor('exert-air', 'seek-local-heat', Material.Air, position),
    );
    return structuredClone(campaign.candidates.filter((candidate) => candidate.operation === 'exert-air'
      && candidate.questionKind === 'seek-local-heat'));
  }

  {
    const first = deterministicRoleSnapshot();
    const second = deterministicRoleSnapshot();
    assert.ok(first.length > 1, 'determinism fixture must contain a real ranked choice');
    assert.deepEqual(second, first,
      'the same seed, local entities, question and personal evidence must replay exactly');
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first,
      'question kinds, role scores, role reasons and source basis must survive JSON persistence');
  }

  process.stdout.write('grounded operation role tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
