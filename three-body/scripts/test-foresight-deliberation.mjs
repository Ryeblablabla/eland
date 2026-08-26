import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-foresight-deliberation-'));
const bundlePath = path.join(temporaryDirectory, 'foresight-deliberation.mjs');

try {
  const entry = `export { compareBoundedForesight } from ${JSON.stringify(path.resolve(
    'src/game/eland/application/cognition/foresight-deliberation.ts',
  ))};`;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=foresight-deliberation-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { compareBoundedForesight } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const semantics = (purpose, needKinds = []) => ({
    version: 'action-option-semantics-v1',
    obligation: 'optional',
    planningChannel: 'ordinary',
    purpose,
    minimumLifeStage: 'adolescent',
    needKinds,
  });
  const option = (id, { projectId, purpose = 'other', needKinds = [], operation = 'attend' } = {}) => ({
    id,
    summary: id,
    reason: 'fixture',
    goal: projectId ? { kind: 'project-completed', projectId } : { kind: 'knowledge', factId: `fact:${id}` },
    nextAction: operation === 'attend'
      ? { kind: 'attend', target: { kind: 'inventory-stack', personId: 'person', stackId: `stack:${id}` } }
      : { kind: 'act', operation, targets: [] },
    ...(projectId ? { projectId } : {}),
    estimatedDuration: 'one-month',
    sourceFactIds: [`source:${id}`],
    semantics: semantics(purpose, needKinds),
  });
  const appraisal = (actionOption, values = {}) => ({
    option: actionOption,
    basisKey: `basis:${actionOption.id}`,
    needAlignments: values.needAlignments ?? [],
    addressedNeeds: [],
    needActivation: values.needActivation ?? 0.35,
    generativityUrgency: 0,
    expectedSuccess: values.expectedSuccess ?? 0.5,
    uncertainty: values.uncertainty ?? 0.5,
    expectedEffort: values.expectedEffort ?? 0.18,
    expectedHarm: values.expectedHarm ?? 0,
    personalityGate: 1,
    memoryGate: 1,
    feasibilityGate: 1,
    relationshipGate: 1,
    readinessGate: 1,
    repetitionGate: 1,
    ethicalGate: 1,
    continuityGate: 1,
    motivation: values.motivation ?? 0.12,
    aspiration: values.aspiration ?? 0.1,
    causalScore: 2,
    factors: [],
    reasons: [],
    sourceFactIds: [`source:${actionOption.id}`],
  });
  const campaign = {
    version: 'project-hypothesis-campaign-v2',
    id: 'campaign:p',
    projectId: 'p',
    actorId: 'person',
    openedAt: 1,
    budget: 7,
    noResponseBudget: 4,
    responseBudget: 3,
    observedMaterialIds: [],
    sourceFactIds: ['campaign-source'],
    sourceKeys: ['inventory:stack:a', 'inventory:stack:b'],
    candidates: [{
      key: 'candidate:opaque',
      operation: 'combine-inventory',
      questionKind: 'connect-manipulator-shapes',
      materialIds: [1, 2],
      roleScore: 0,
      roleReasonKeys: [],
      observableScore: 0,
      seededRank: 0,
      reasonKeys: [],
      sourceFactIds: ['candidate-source'],
      sourceKeys: ['inventory:stack:a', 'inventory:stack:b'],
    }],
    attempts: [{
      candidateKey: 'old:no-response',
      operation: 'combine-inventory',
      questionKind: 'connect-manipulator-shapes',
      materialIds: [3, 4],
      roleScore: 0,
      roleReasonKeys: [],
      eventId: 'attempt:no-response',
      atMonth: 2,
      ordinal: 1,
      candidateRank: 1,
      outcome: 'no-response',
      outputMaterialId: 987654321,
      sourceFactIds: ['attempt:no-response'],
      sourceKeys: ['inventory:old:a', 'inventory:old:b'],
    }],
    status: 'active',
    activeCandidateKey: 'candidate:opaque',
  };
  const context = {
    state: {
      seed: 20260827,
      branchId: 'foresight-fixture',
      projects: [{ id: 'p', ownerId: 'person', hypothesisCampaign: campaign }],
    },
    person: { id: 'person' },
    options: [], followUpOptions: [], visibleCells: [], visiblePeople: [], visibleDrops: [], visibleAnimals: [],
  };
  const inquiry = appraisal(option('opaque-inquiry-handle', {
    projectId: 'p', purpose: 'project', needKinds: ['commitment', 'capability'], operation: 'combine',
  }), { motivation: 0.129, expectedSuccess: 0.2, uncertainty: 0.9, expectedEffort: 0.35 });
  const practical = appraisal(option('opaque-practical-handle'), {
    motivation: 0.13, expectedSuccess: 0.9, uncertainty: 0.2, expectedEffort: 0.08,
  });
  const others = [0, 1, 2, 3].map((index) => appraisal(option(`opaque-other-${index}`), {
    motivation: 0.08 - index * 0.01, expectedSuccess: 0.5, uncertainty: 0.5,
  }));
  const frame = {
    architecture: 'causal-bdi-v1', planningMonth: 3, planningTick: 1, needs: [],
    appraisals: [inquiry, practical, ...others],
  };
  const forward = compareBoundedForesight(context, frame);
  const reversed = compareBoundedForesight(context, { ...frame, appraisals: [...frame.appraisals].reverse() });
  assert.deepEqual(reversed, forward, 'candidate insertion order must not affect bounded comparison');
  assert.ok(forward.audit.rootCount <= 4);
  assert.ok(forward.audit.maxDepth <= 3);
  assert.ok(forward.audit.expandedNodes <= 24);
  assert.equal(JSON.stringify(forward).includes('987654321'), false,
    'a future branch must not expose the authoritative output of an earlier response record');
  assert.equal(forward.changedSelection, true, 'bounded continuation can change a genuinely close choice');
  assert.equal(forward.baseSelectedOptionId, practical.option.id);
  assert.equal(forward.adjustedSelectedOptionId, inquiry.option.id);

  const alone = compareBoundedForesight(context, { ...frame, appraisals: [inquiry] });
  assert.equal(alone.options[0].valueOfInformation, 0, 'without a second choice information has no value');

  const acute = appraisal(option('opaque-acute', { purpose: 'homeostasis', needKinds: ['homeostasis'] }), {
    motivation: 0.125,
    expectedSuccess: 0.8,
    uncertainty: 0.2,
    needAlignments: [{ kind: 'homeostasis', strength: 1, reason: 'thirst' }],
  });
  const crisisFrame = {
    ...frame,
    needs: [{ key: 'acute:thirst', kind: 'homeostasis', urgency: 0.9, reasons: [], sourceFactIds: [] }],
    appraisals: [inquiry, acute],
  };
  const crisis = compareBoundedForesight(context, crisisFrame);
  const inquiryDuringCrisis = crisis.options.find((item) => item.optionId === inquiry.option.id);
  assert.ok(inquiryDuringCrisis && inquiryDuringCrisis.adjustment <= 0,
    'unrelated imagined future value cannot rise during an acute survival crisis');

  process.stdout.write('foresight deliberation integration tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
