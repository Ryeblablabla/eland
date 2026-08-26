import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-hypothesis-metrics-inputs-'));
const bundlePath = path.join(temporaryDirectory, 'hypothesis-metrics.mjs');

try {
  const entry = `
    export { hypothesisMetrics } from ${JSON.stringify(path.resolve('server/evolution-artifacts/hypothesis-metrics.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=hypothesis-metrics-exact-inventory-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const { hypothesisMetrics } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const actorId = 'measurement-auditor';

  function inquiryFixture({ projectId, campaignId, eventId, questionKind, materialIds, inventoryMaterialIds }) {
    const candidateKey = inventoryMaterialIds.length === 2
      ? [...inventoryMaterialIds].sort((left, right) => left - right).join('+')
      : `combine-inventory:${[...inventoryMaterialIds].sort((left, right) => left - right).join('+')}`;
    const sourceKeys = [`inventory:${actorId}:${projectId}:primary`, `inventory:${actorId}:${projectId}:secondary`];
    const roleBasis = {
      questionKind,
      roleScore: 6,
      toolRoleScore: 3,
      inputRoleScore: 3,
      toolSourceKey: sourceKeys[0],
      inputSourceKey: sourceKeys[1],
      toolRoleMaterialId: materialIds[0],
      inputRoleMaterialId: materialIds[1],
      roleReasonKeys: ['locally-observed-measurement-shape'],
      sourceKeys,
    };
    const candidate = {
      key: candidateKey,
      operation: 'combine-inventory',
      materialIds,
      inventoryMaterialIds,
      ...roleBasis,
      observableScore: 6,
      seededRank: 1,
      reasonKeys: ['grounded-operation-question'],
      sourceFactIds: [`pressure:${projectId}`],
    };
    const attempt = {
      candidateKey,
      operation: 'combine-inventory',
      materialIds,
      inventoryMaterialIds,
      ...roleBasis,
      eventId,
      atMonth: 1,
      ordinal: 1,
      candidateRank: 1,
      outcome: 'no-response',
      sourceFactIds: [`pressure:${projectId}`],
    };
    const project = {
      id: projectId,
      actionEventIds: [eventId],
      hypothesisCampaign: {
        id: campaignId,
        version: 'project-hypothesis-campaign-v2',
        projectId,
        actorId,
        status: 'active',
        budget: 2,
        noResponseBudget: 1,
        responseBudget: 1,
        candidates: [candidate],
        attempts: [attempt],
        sourceKeys,
      },
    };
    const event = {
      id: eventId,
      kind: 'action',
      atMonth: 1,
      who: actorId,
      action: { kind: 'act', operation: 'combine', targets: [] },
      status: 'blocked',
      diff: {
        inputMaterialIds: inventoryMaterialIds,
        projectHypothesisCampaignId: campaignId,
        projectHypothesisProjectId: projectId,
        projectHypothesisActorId: actorId,
        projectHypothesisCandidateKey: candidateKey,
        projectHypothesisOperation: 'combine-inventory',
        projectHypothesisMaterialIds: materialIds,
        projectHypothesisInventoryMaterialIds: inventoryMaterialIds,
        projectHypothesisQuestionKind: questionKind,
        projectHypothesisRoleScore: roleBasis.roleScore,
        projectHypothesisToolRoleScore: roleBasis.toolRoleScore,
        projectHypothesisInputRoleScore: roleBasis.inputRoleScore,
        projectHypothesisToolSourceKey: roleBasis.toolSourceKey,
        projectHypothesisInputSourceKey: roleBasis.inputSourceKey,
        projectHypothesisToolRoleMaterialId: roleBasis.toolRoleMaterialId,
        projectHypothesisInputRoleMaterialId: roleBasis.inputRoleMaterialId,
        projectHypothesisRoleReasonKeys: roleBasis.roleReasonKeys,
        projectHypothesisAttemptOrdinal: 1,
        projectHypothesisBudget: 2,
        projectHypothesisNoResponseBudget: 1,
        projectHypothesisResponseBudget: 1,
        projectHypothesisOutcome: 'no-response',
        projectHypothesisSourceKeys: sourceKeys,
        projectHypothesisHadReliableKnowledge: false,
      },
    };
    return { project, event };
  }

  const balanced = inquiryFixture({
    projectId: 'balanced-suspension-project',
    campaignId: 'balanced-suspension-campaign',
    eventId: 'balanced-suspension-attempt',
    questionKind: 'assemble-balanced-suspension',
    materialIds: [10, 20],
    inventoryMaterialIds: [10, 10, 20],
  });
  const reference = inquiryFixture({
    projectId: 'repeatable-reference-project',
    campaignId: 'repeatable-reference-campaign',
    eventId: 'repeatable-reference-attempt',
    questionKind: 'shape-repeatable-reference',
    materialIds: [30, 40],
    inventoryMaterialIds: [30, 40],
  });
  const rotor = inquiryFixture({
    projectId: 'flow-driven-rotor-project',
    campaignId: 'flow-driven-rotor-campaign',
    eventId: 'flow-driven-rotor-attempt',
    questionKind: 'assemble-flow-driven-rotor',
    materialIds: [41, 42],
    inventoryMaterialIds: [41, 42],
  });
  const connector = inquiryFixture({
    projectId: 'rigid-rotating-connector-project',
    campaignId: 'rigid-rotating-connector-campaign',
    eventId: 'rigid-rotating-connector-attempt',
    questionKind: 'shape-rigid-rotating-connector',
    materialIds: [43, 44],
    inventoryMaterialIds: [43, 44],
  });
  const state = {
    people: [{ id: actorId }],
    projects: [balanced.project, reference.project, rotor.project, connector.project],
    world: { past: [balanced.event, reference.event, rotor.event, connector.event] },
  };

  const report = hypothesisMetrics(state);
  assert.equal(report.hypothesisAssembleBalancedSuspensionCandidates, 1);
  assert.equal(report.hypothesisAssembleBalancedSuspensionAttempts, 1);
  assert.equal(report.hypothesisAssembleBalancedSuspensionNoResponses, 1);
  assert.equal(report.hypothesisShapeRepeatableReferenceCandidates, 1);
  assert.equal(report.hypothesisShapeRepeatableReferenceAttempts, 1);
  assert.equal(report.hypothesisShapeRepeatableReferenceNoResponses, 1);
  assert.equal(report.hypothesisAssembleFlowDrivenRotorCandidates, 1);
  assert.equal(report.hypothesisAssembleFlowDrivenRotorAttempts, 1);
  assert.equal(report.hypothesisAssembleFlowDrivenRotorNoResponses, 1);
  assert.equal(report.hypothesisShapeRigidRotatingConnectorCandidates, 1);
  assert.equal(report.hypothesisShapeRigidRotatingConnectorAttempts, 1);
  assert.equal(report.hypothesisShapeRigidRotatingConnectorNoResponses, 1);
  assert.equal(report.hypothesisCandidatesMissingQuestionKind, 0);
  assert.equal(report.hypothesisAttemptsMissingQuestionKind, 0);
  assert.equal(report.hypothesisQuestionOperationMismatches, 0);
  assert.equal(report.hypothesisActionDiffSignatureMismatches, 0,
    'exact two- and three-slot signatures must agree across candidate, attempt, projected diff, and actual inputs');
  assert.equal(report.hypothesisUniqueSignatures, 4,
    'the three-slot candidate must remain distinct from its coarse two-material compatibility pair');

  const staleProjectedInputs = structuredClone(state);
  staleProjectedInputs.world.past[0].diff.projectHypothesisInventoryMaterialIds = [10, 20];
  assert.equal(hypothesisMetrics(staleProjectedInputs).hypothesisActionDiffSignatureMismatches, 1,
    'the audit must detect a projected two-slot signature that drops one real input slot');

  const legacyProjectId = 'legacy-two-slot-project';
  const legacyCampaignId = 'legacy-two-slot-campaign';
  const legacyEventId = 'legacy-two-slot-attempt';
  const legacyKey = '50+60';
  const legacySourceKeys = ['legacy-source'];
  const legacyState = {
    people: [{ id: actorId }],
    projects: [{
      id: legacyProjectId,
      actionEventIds: [legacyEventId],
      hypothesisCampaign: {
        id: legacyCampaignId,
        version: 'project-hypothesis-campaign-v1',
        projectId: legacyProjectId,
        actorId,
        status: 'active',
        budget: 2,
        candidates: [{
          key: legacyKey,
          materialIds: [50, 60],
          sourceKeys: legacySourceKeys,
          sourceFactIds: [],
          reasonKeys: [],
        }],
        attempts: [{
          candidateKey: legacyKey,
          materialIds: [50, 60],
          eventId: legacyEventId,
          atMonth: 1,
          ordinal: 1,
          outcome: 'no-response',
          sourceKeys: legacySourceKeys,
          sourceFactIds: [],
        }],
        sourceKeys: legacySourceKeys,
      },
    }],
    world: { past: [{
      id: legacyEventId,
      kind: 'action',
      atMonth: 1,
      who: actorId,
      action: { kind: 'act', operation: 'combine', targets: [] },
      status: 'blocked',
      diff: {
        inputMaterialIds: [50, 60],
        projectHypothesisCampaignId: legacyCampaignId,
        projectHypothesisProjectId: legacyProjectId,
        projectHypothesisActorId: actorId,
        projectHypothesisCandidateKey: legacyKey,
        projectHypothesisMaterialIds: [50, 60],
        projectHypothesisAttemptOrdinal: 1,
        projectHypothesisBudget: 2,
        projectHypothesisOutcome: 'no-response',
        projectHypothesisSourceKeys: legacySourceKeys,
        projectHypothesisHadReliableKnowledge: false,
      },
    }] },
  };
  const legacyReport = hypothesisMetrics(legacyState);
  assert.equal(legacyReport.hypothesisOperationMismatches, 0);
  assert.equal(legacyReport.hypothesisActionDiffSignatureMismatches, 0,
    'legacy two-slot records without exact inventory fields must retain their old signature');

  console.log('hypothesis metrics exact inventory tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
