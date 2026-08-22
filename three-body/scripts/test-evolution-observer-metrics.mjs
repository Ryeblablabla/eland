import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-observer-metrics-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const artifactsBundlePath = path.join(temporaryDirectory, 'evolution-artifacts.mjs');

try {
  for (const [entryPoint, outputPath] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['server/evolution-artifacts.ts', artifactsBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entryPoint, '--bundle', '--platform=node', '--format=esm', `--outfile=${outputPath}`,
    ], { stdio: 'pipe' });
  }

  const { createInitialState } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { buildEvolutionFactsReport } = await import(`${pathToFileURL(artifactsBundlePath).href}?test=${Date.now()}`);
  const state = createInitialState(91, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const [firstPerson, secondPerson] = state.people;
  assert.ok(firstPerson && secondPerson, 'fixture requires two people');
  state.clock.elapsedMonths = 2;
  state.intents = [
    { id: 'intent-project-a', ownerId: firstPerson.id, projectId: 'project-a' },
    { id: 'intent-project-b', ownerId: secondPerson.id, projectId: 'project-b' },
    { id: 'intent-plain-b', ownerId: secondPerson.id },
  ];

  let orderInMonth = 0;
  const actionFact = ({ id, atMonth, who, intentId, action, status = 'completed', diff = {} }) => ({
    id,
    kind: 'action',
    actionTick: 1,
    atMonth,
    orderInMonth: orderInMonth++,
    cellId: 0,
    who,
    intentId,
    cause: 'intent',
    action,
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [0],
    status,
    result: id,
    diff,
  });
  const communicate = (content) => ({ kind: 'communicate', content, audience: [], channel: 'voice' });
  const reproduce = { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: firstPerson.id }] };
  state.world.past = [
    actionFact({ id: 'project-a-1', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a', action: { kind: 'attend', target: { kind: 'person', personId: secondPerson.id } } }),
    actionFact({ id: 'project-a-2', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a', action: { kind: 'move', toCellId: 1 }, status: 'blocked' }),
    actionFact({
      id: 'reproduction-offer', atMonth: 1, who: secondPerson.id, intentId: 'intent-project-b',
      action: communicate({ id: 'offer-reproduce-1', kind: 'offer', proposal: { kind: 'reproduce' } }),
    }),
    actionFact({
      id: 'reproduction-acceptance', atMonth: 1, who: secondPerson.id, intentId: 'intent-project-b',
      action: communicate({ id: 'accept-reproduce-1', kind: 'accept', referenceId: 'offer-reproduce-1' }),
    }),
    actionFact({
      id: 'blocked-reproduction-offer', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a', status: 'blocked',
      action: communicate({ id: 'offer-reproduce-blocked', kind: 'offer', proposal: { kind: 'reproduce' } }),
    }),
    actionFact({
      id: 'non-reproduction-offer', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a',
      action: communicate({ id: 'offer-companion-1', kind: 'offer', proposal: { kind: 'companion' } }),
    }),
    actionFact({
      id: 'unknown-acceptance', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b',
      action: communicate({ id: 'accept-unknown', kind: 'accept', referenceId: 'unknown-offer' }),
    }),
    actionFact({ id: 'reproduction-no-conception', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b', action: reproduce, diff: { conceived: false } }),
    actionFact({ id: 'reproduction-blocked', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b', action: reproduce, status: 'blocked', diff: { consent: false } }),
    actionFact({ id: 'reproduction-conception', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b', action: reproduce, diff: { conceived: true } }),
  ];

  const pathFixture = {
    schemaVersion: 2,
    runId: 'observer-metrics-fixture',
    provider: 'local',
    model: 'rules',
    status: 'completed',
    startedAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    fromMonth: 0,
    requestedEndMonth: 2,
    reachedMonth: 2,
    checkpoints: [],
    turningPoints: [],
  };
  const report = buildEvolutionFactsReport(state, pathFixture);
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.actionPersonMonths, 3, 'multiple actions by one person in one month must count once');
  assert.equal(report.projectActionPersonMonths, 2, 'only person-months linked through an intent projectId count');
  assert.equal(report.projectActionMonthShare, 66.67);
  assert.equal(report.reproductionOffers, 1, 'only completed reproduction offer facts count');
  assert.equal(report.reproductionAcceptances, 1, 'acceptance must reference a completed reproduction offer fact');
  assert.equal(report.reproductionAttempts, 2,
    'only completed reproduce primitives count as attempts; legality-blocked facts occur before probability sampling');
  assert.equal(report.reproductionConceptions, 1, 'conception requires diff.conceived === true');

  const stateWithoutIntents = structuredClone(state);
  delete stateWithoutIntents.intents;
  const reportWithoutIntents = buildEvolutionFactsReport(stateWithoutIntents, pathFixture);
  assert.equal(reportWithoutIntents.actionPersonMonths, 3);
  assert.equal(reportWithoutIntents.projectActionPersonMonths, 0);
  assert.equal(reportWithoutIntents.projectActionMonthShare, 0);

  const stateWithoutIntentIds = structuredClone(state);
  for (const event of stateWithoutIntentIds.world.past) delete event.intentId;
  const reportWithoutIntentIds = buildEvolutionFactsReport(stateWithoutIntentIds, pathFixture);
  assert.equal(reportWithoutIntentIds.actionPersonMonths, 0);
  assert.equal(reportWithoutIntentIds.projectActionPersonMonths, 0);
  assert.equal(reportWithoutIntentIds.projectActionMonthShare, null);

  {
    const searchState = createInitialState(92, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
    const owner = searchState.people[0];
    searchState.clock.elapsedMonths = 12;
    searchState.projects = [];
    searchState.world.past = [];
    const desiredFunction = 'high-heat-processing';
    const opportunityBasis = (atMonth) => ({
      version: 'project-inquiry-opportunity-basis-v1', actorId: owner.id, desiredFunction, atMonth,
      materialIds: [], techniqueIds: [], targetSourceKeys: [], verifiedResponseEventIds: [],
      opportunityKeys: [], opportunitySources: [], sourceFactIds: [], sourceKeys: [],
      basisKey: `${owner.id}:${desiredFunction}:`, inheritedProjectIds: [], renewalKeys: [],
    });
    const searchCampaign = (projectId, openedAt, status, planKnowledgeId) => ({
      id: `search:${projectId}`, projectId, ownerId: owner.id, actorId: owner.id,
      materialIds: [39],
      ...(planKnowledgeId ? { planKnowledgeId } : {}),
      basisKey: `project-search-campaign-v1|project=${projectId}|actor=${owner.id}|materials=39|plan=${planKnowledgeId ?? 'none'}`,
      openedAt, anchor: { cellId: owner.position.cellId, z: owner.position.z },
      cellIds: [owner.position.cellId], inheritedTargetKeys: [], inheritedCampaignIds: [],
      attemptedTargetKeys: [`${owner.position.cellId}:${owner.position.z}`], sourceFactIds: [],
      status, ...(status === 'exhausted' ? { closedAt: openedAt + 1 } : {}),
    });
    const sourceEpisode = (projectId, createdAt, x) => ({
      id: `source:${projectId}:${x}`, kind: 'source', actorId: owner.id, materialIds: [39],
      target: { cellId: owner.position.cellId, z: owner.position.z },
      sourceRef: { kind: 'voxel-source', position: { x, y: 0, z: 0 }, sourceMaterialId: 39 },
      sourceEventIds: [], createdAt, status: 'active', actionEventIds: [],
    });
    const project = ({ id, createdAtMonth, status = 'active', planKnowledgeId, search, sources = [] }) => ({
      id, kind: 'construction', need: 'high-heat-capability', desiredFunction,
      summary: id, ownerId: owner.id, beneficiaryIds: [owner.id], triggerFactIds: [], pressure: 60,
      createdAtMonth, reviewAtMonth: createdAtMonth + 6,
      site: { cellId: owner.position.cellId, z: owner.position.z },
      ...(planKnowledgeId ? { planKnowledgeId } : {}),
      inquiryOpportunityBasis: opportunityBasis(createdAtMonth), status,
      lastProgressAtMonth: createdAtMonth,
      ...(status === 'blocked' ? {
        blockedAtMonth: createdAtMonth + 1, blockedReason: '有限局部搜索已经耗尽',
      } : {}),
      missingMaterialIds: [39], materialDemands: [], reservations: [], contributorIds: [owner.id],
      actionEventIds: [], failureEventIds: [], completionEventIds: [], progressEvidence: [],
      searchCampaigns: search ? [search] : [], logisticsEpisodes: sources,
    });

    const priorId = 'search-only-blocked';
    const oldPlanTechniqueId = 'technique:combine:3:4:58';
    owner.knowledge.push({
      id: oldPlanTechniqueId, kind: 'technique', summary: '旧陶窑方案', confidence: 70,
      learnedAtMonth: 1, sourceEventIds: [],
    });
    const prior = project({
      id: priorId, createdAtMonth: 1, status: 'blocked',
      search: searchCampaign(priorId, 1, 'exhausted'),
      sources: [sourceEpisode(priorId, 1, 4)],
    });
    delete prior.inquiryOpportunityBasis;
    prior.terminalInquiryOpportunityBasis = {
      ...opportunityBasis(2),
      materialIds: [39], techniqueIds: [oldPlanTechniqueId],
      opportunityKeys: ['material:39', `knowledge:${oldPlanTechniqueId}`],
      opportunitySources: [
        {
          opportunityKey: 'material:39', kind: 'material', materialId: 39,
          sourceKeys: [`inventory:${owner.id}:old-tin`, 'voxel:4:0:0:39'], sourceFactIds: [],
        },
        {
          opportunityKey: `knowledge:${oldPlanTechniqueId}`, kind: 'knowledge',
          sourceKeys: [`knowledge:${oldPlanTechniqueId}`], sourceFactIds: [],
        },
      ],
    };
    searchState.projects.push(prior);
    const duplicateId = 'same-search-reopen';
    searchState.projects.push(project({
      id: duplicateId, createdAtMonth: 3,
      search: searchCampaign(duplicateId, 3, 'active'),
    }));
    const validPlanTechniqueId = 'technique:combine:1:2:58';
    const unrelatedPlanTechniqueId = 'technique:combine:1:2:1';
    const tentativePlanTechniqueId = 'technique:combine:5:6:58';
    owner.knowledge.push(
      { id: validPlanTechniqueId, kind: 'technique', summary: '新的陶窑方案', confidence: 70, learnedAtMonth: 4, sourceEventIds: [] },
      { id: unrelatedPlanTechniqueId, kind: 'technique', summary: '与陶窑无关的石料方案', confidence: 70, learnedAtMonth: 4, sourceEventIds: [] },
      { id: tentativePlanTechniqueId, kind: 'technique', summary: '尚未可靠的陶窑猜想', confidence: 40, learnedAtMonth: 4, sourceEventIds: [] },
    );
    const planId = 'new-plan-reopen';
    const planRenewal = project({
      id: planId, createdAtMonth: 4, planKnowledgeId: validPlanTechniqueId,
      search: searchCampaign(planId, 4, 'active', validPlanTechniqueId),
    });
    planRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(4), techniqueIds: [validPlanTechniqueId],
      opportunityKeys: [`knowledge:${validPlanTechniqueId}`],
      opportunitySources: [{
        opportunityKey: `knowledge:${validPlanTechniqueId}`, kind: 'knowledge',
        sourceKeys: [`knowledge:${validPlanTechniqueId}`], sourceFactIds: [],
      }],
    };
    searchState.projects.push(planRenewal);
    const unrelatedPlanId = 'unrelated-plan-reopen';
    const unrelatedPlan = project({
      id: unrelatedPlanId, createdAtMonth: 4, planKnowledgeId: unrelatedPlanTechniqueId,
      search: searchCampaign(unrelatedPlanId, 4, 'active', unrelatedPlanTechniqueId),
    });
    unrelatedPlan.inquiryOpportunityBasis = {
      ...opportunityBasis(4), techniqueIds: [unrelatedPlanTechniqueId],
      opportunityKeys: [`knowledge:${unrelatedPlanTechniqueId}`],
      opportunitySources: [{
        opportunityKey: `knowledge:${unrelatedPlanTechniqueId}`, kind: 'knowledge',
        sourceKeys: [`knowledge:${unrelatedPlanTechniqueId}`], sourceFactIds: [],
      }],
    };
    searchState.projects.push(unrelatedPlan);
    const tentativePlanId = 'tentative-plan-reopen';
    const tentativePlan = project({
      id: tentativePlanId, createdAtMonth: 4, planKnowledgeId: tentativePlanTechniqueId,
      search: searchCampaign(tentativePlanId, 4, 'active', tentativePlanTechniqueId),
    });
    tentativePlan.inquiryOpportunityBasis = {
      ...opportunityBasis(4), techniqueIds: [tentativePlanTechniqueId],
      opportunityKeys: [`knowledge:${tentativePlanTechniqueId}`],
      opportunitySources: [{
        opportunityKey: `knowledge:${tentativePlanTechniqueId}`, kind: 'knowledge',
        sourceKeys: [`knowledge:${tentativePlanTechniqueId}`], sourceFactIds: [],
      }],
    };
    searchState.projects.push(tentativePlan);
    const changedMaterialId = 'changed-material-search-reopen';
    const changedMaterialSearch = searchCampaign(changedMaterialId, 4, 'active');
    changedMaterialSearch.materialIds = [37];
    changedMaterialSearch.basisKey = `test-search|materials=37|plan=none`;
    searchState.projects.push(project({
      id: changedMaterialId, createdAtMonth: 4, search: changedMaterialSearch,
    }));
    searchState.projects.push(project({
      id: 'new-exact-source-reopen', createdAtMonth: 5,
      sources: [sourceEpisode('new-exact-source-reopen', 5, 5)],
    }));
    searchState.projects.push(project({
      id: 'stale-exact-source-reopen', createdAtMonth: 6,
      sources: [sourceEpisode('stale-exact-source-reopen', 6, 4)],
    }));
    const exactCurrentSourceKey = `inventory:${owner.id}:new-observed-tin`;
    const exactSourceRenewalKey = `search-source:39:${exactCurrentSourceKey}`;
    const attributedRenewal = project({ id: 'attributed-search-source-renewal', createdAtMonth: 7 });
    attributedRenewal.kind = 'production';
    attributedRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(7),
      opportunityKeys: [exactSourceRenewalKey],
      opportunitySources: [{
        opportunityKey: exactSourceRenewalKey, kind: 'material', materialId: 39,
        sourceKeys: [exactCurrentSourceKey, `inventory:${searchState.people[1].id}:old-holder`, 'voxel:5:0:0:39'],
        sourceFactIds: [],
      }],
      inheritedProjectIds: [priorId], renewalKeys: [exactSourceRenewalKey],
    };
    searchState.projects.push(attributedRenewal);
    const bogusRenewal = project({ id: 'bogus-construction-renewal', createdAtMonth: 8 });
    bogusRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(8), opportunityKeys: ['search-source:39:drop:missing'],
      inheritedProjectIds: [priorId], renewalKeys: ['search-source:39:drop:missing'],
    };
    searchState.projects.push(bogusRenewal);
    const staleMaterialRenewal = project({ id: 'stale-material-renewal', createdAtMonth: 8 });
    staleMaterialRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(8), materialIds: [39], opportunityKeys: ['material:39'],
      opportunitySources: [{
        opportunityKey: 'material:39', kind: 'material', materialId: 39,
        sourceKeys: [`inventory:${owner.id}:old-tin`, 'voxel:4:0:0:39'], sourceFactIds: [],
      }],
      inheritedProjectIds: [priorId], renewalKeys: ['material:39'],
    };
    searchState.projects.push(staleMaterialRenewal);
    const staleKnowledgeRenewal = project({ id: 'stale-knowledge-renewal', createdAtMonth: 8 });
    staleKnowledgeRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(8), techniqueIds: [oldPlanTechniqueId],
      opportunityKeys: [`knowledge:${oldPlanTechniqueId}`],
      opportunitySources: [{
        opportunityKey: `knowledge:${oldPlanTechniqueId}`, kind: 'knowledge',
        sourceKeys: [`knowledge:${oldPlanTechniqueId}`], sourceFactIds: [],
      }],
      inheritedProjectIds: [priorId], renewalKeys: [`knowledge:${oldPlanTechniqueId}`],
    };
    searchState.projects.push(staleKnowledgeRenewal);
    const renamedOldSourceKey = `inventory:${owner.id}:renamed-old-tin`;
    const staleExactRenewalKey = `search-source:39:${renamedOldSourceKey}`;
    const staleExactRenewal = project({ id: 'stale-exact-renewal', createdAtMonth: 8 });
    staleExactRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(8), materialIds: [39], opportunityKeys: [staleExactRenewalKey],
      opportunitySources: [{
        opportunityKey: staleExactRenewalKey, kind: 'material', materialId: 39,
        sourceKeys: [renamedOldSourceKey, `inventory:${owner.id}:old-tin`, 'voxel:4:0:0:39'],
        sourceFactIds: [],
      }],
      inheritedProjectIds: [priorId], renewalKeys: [staleExactRenewalKey],
    };
    searchState.projects.push(staleExactRenewal);

    const hypothesisOnlyPrior = project({ id: 'hypothesis-only-construction', createdAtMonth: 9, status: 'blocked' });
    hypothesisOnlyPrior.desiredFunction = 'iron-workshop';
    hypothesisOnlyPrior.inquiryOpportunityBasis.desiredFunction = 'iron-workshop';
    hypothesisOnlyPrior.hypothesisCampaign = { attempts: [{ outcome: 'no-response' }] };
    hypothesisOnlyPrior.terminalInquiryOpportunityBasis = {
      ...hypothesisOnlyPrior.inquiryOpportunityBasis,
      atMonth: 10,
    };
    delete hypothesisOnlyPrior.inquiryOpportunityBasis;
    searchState.projects.push(hypothesisOnlyPrior);
    const hypothesisOnlyRetry = project({ id: 'hypothesis-only-construction-retry', createdAtMonth: 11 });
    hypothesisOnlyRetry.desiredFunction = 'iron-workshop';
    hypothesisOnlyRetry.inquiryOpportunityBasis.desiredFunction = 'iron-workshop';
    searchState.projects.push(hypothesisOnlyRetry);

    const constructionPlanTechniqueId = 'technique:combine:7:8:62';
    owner.knowledge.push({
      id: constructionPlanTechniqueId, kind: 'technique', summary: '新的铁匠铺方案', confidence: 70,
      learnedAtMonth: 11, sourceEventIds: [],
    });
    const constructionPlanRenewal = project({
      id: 'construction-reliable-plan-renewal', createdAtMonth: 11,
      planKnowledgeId: constructionPlanTechniqueId,
    });
    constructionPlanRenewal.desiredFunction = 'iron-workshop';
    constructionPlanRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(11), desiredFunction: 'iron-workshop',
      techniqueIds: [constructionPlanTechniqueId],
      opportunityKeys: [`knowledge:${constructionPlanTechniqueId}`],
      opportunitySources: [{
        opportunityKey: `knowledge:${constructionPlanTechniqueId}`, kind: 'knowledge',
        sourceKeys: [`knowledge:${constructionPlanTechniqueId}`], sourceFactIds: [],
      }],
      inheritedProjectIds: [hypothesisOnlyPrior.id],
      renewalKeys: [`knowledge:${constructionPlanTechniqueId}`],
    };
    searchState.projects.push(constructionPlanRenewal);

    const constructionSourceKey = `inventory:${owner.id}:new-iron-source`;
    const constructionSourceRenewal = project({
      id: 'construction-source-bound-renewal', createdAtMonth: 11,
    });
    constructionSourceRenewal.desiredFunction = 'iron-workshop';
    constructionSourceRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(11), desiredFunction: 'iron-workshop', materialIds: [37],
      opportunityKeys: ['material:37'],
      opportunitySources: [{
        opportunityKey: 'material:37', kind: 'material', materialId: 37,
        sourceKeys: [constructionSourceKey], sourceFactIds: [],
      }],
      inheritedProjectIds: [hypothesisOnlyPrior.id], renewalKeys: ['material:37'],
    };
    const constructionCandidateKey = 'construction-source-bound-candidate';
    const constructionAttemptEventId = 'construction-source-bound-attempt';
    constructionSourceRenewal.hypothesisCampaign = {
      actorId: owner.id,
      candidates: [{
        key: constructionCandidateKey,
        reasonKeys: ['cross-project-renewal-opportunity'],
        materialIds: [37, 37], sourceKeys: [constructionSourceKey], sourceFactIds: [],
      }],
      attempts: [{
        candidateKey: constructionCandidateKey, eventId: constructionAttemptEventId,
        operation: 'combine-inventory', outcome: 'no-response',
        materialIds: [37, 37], sourceKeys: [constructionSourceKey], sourceFactIds: [],
      }],
    };
    searchState.world.past.push(actionFact({
      id: constructionAttemptEventId, atMonth: 11, who: owner.id,
      action: { kind: 'act', operation: 'combine', targets: [] },
      diff: {
        projectHypothesisReasonKeys: ['cross-project-renewal-opportunity'],
        projectHypothesisMaterialIds: [37, 37],
        projectHypothesisSourceKeys: [constructionSourceKey],
        projectHypothesisSourceFactIds: [],
      },
    }));
    searchState.projects.push(constructionSourceRenewal);

    const searchReport = buildEvolutionFactsReport(searchState, {
      ...pathFixture, runId: 'search-reopen-observer-fixture', requestedEndMonth: 12, reachedMonth: 12,
    });
    assert.equal(searchReport.inquiryOpportunityFailedProjects, 2,
      'search-only and construction hypothesis failures must both enter terminal-basis coverage');
    assert.equal(searchReport.inquiryOpportunityTerminalBasisProjects, 2);
    assert.equal(searchReport.inquiryOpportunityTerminalBasisCoverage, 100);
    assert.equal(searchReport.inquiryOpportunityReopenWithoutRenewalViolations, 12,
      'unbound plan/source evidence, same search, construction retry, changed material, unrelated or tentative plan, stale source, bogus key, and structurally valid but old renewals must fail');
    assert.equal(searchReport.inquiryOpportunityRenewalCommitmentProjectCoverage, 85.71,
      'source commitment remains structural; semantic oldness is independently exposed by reopen violations');
    assert.equal(searchReport.inquiryOpportunityRenewalCommitmentActorMismatches, 0,
      'an old holder in source lineage must not be treated as the current source actor');
    assert.equal(searchReport.inquiryOpportunityUnresolvedSources, 1);
    assert.equal(searchReport.inquiryOpportunityRenewalHypothesisProjects, 0,
      'the established production/inquiry renewal-hypothesis denominator must remain explicit');
    assert.equal(searchReport.inquiryOpportunityConstructionRenewalHypothesisProjects, 1);
    assert.equal(searchReport.inquiryOpportunityConstructionRenewalHypothesisCandidateCoverage, 100);
    assert.equal(searchReport.inquiryOpportunityConstructionRenewalHypothesisAttemptProjects, 1);
    assert.equal(searchReport.inquiryOpportunityConstructionRenewalHypothesisFirstAttemptCoverage, 100);
    assert.equal(searchReport.inquiryOpportunityConstructionRenewalFirstCandidateExactSourceCoverage, 100);
    assert.equal(searchReport.inquiryOpportunityConstructionRenewalFirstAttemptExactSourceCoverage, 100);
    assert.equal(searchReport.inquiryOpportunityConstructionRenewalFallbackBeforeCommitmentViolations, 0);
    assert.equal(searchReport.inquiryOpportunityConstructionMaterialOnlyCommitmentAttributionViolations, 0);

    const lineageOnlyCommitmentState = structuredClone(searchState);
    const lineageOnlyRenewal = lineageOnlyCommitmentState.projects
      .find((candidate) => candidate.id === attributedRenewal.id);
    assert.ok(lineageOnlyRenewal);
    const oldLineageSourceKey = `inventory:${searchState.people[1].id}:old-holder`;
    const lineageOnlyAttemptEventId = 'lineage-only-search-source-attempt';
    lineageOnlyRenewal.hypothesisCampaign = {
      actorId: owner.id,
      candidates: [{
        key: 'lineage-only-search-source-candidate',
        reasonKeys: ['cross-project-renewal-opportunity'],
        materialIds: [39, 39], sourceKeys: [oldLineageSourceKey], sourceFactIds: [],
      }],
      attempts: [{
        candidateKey: 'lineage-only-search-source-candidate', eventId: lineageOnlyAttemptEventId,
        operation: 'combine-inventory', outcome: 'no-response',
        materialIds: [39, 39], sourceKeys: [oldLineageSourceKey], sourceFactIds: [],
      }],
    };
    lineageOnlyCommitmentState.world.past.push(actionFact({
      id: lineageOnlyAttemptEventId, atMonth: 7, who: owner.id,
      action: { kind: 'act', operation: 'combine', targets: [] },
      diff: {
        projectHypothesisReasonKeys: ['cross-project-renewal-opportunity'],
        projectHypothesisMaterialIds: [39, 39],
        projectHypothesisSourceKeys: [oldLineageSourceKey],
        projectHypothesisSourceFactIds: [],
      },
    }));
    const lineageOnlyCommitmentReport = buildEvolutionFactsReport(lineageOnlyCommitmentState, {
      ...pathFixture, runId: 'search-source-lineage-only-commitment-fixture',
      requestedEndMonth: 12, reachedMonth: 12,
    });
    assert.equal(lineageOnlyCommitmentReport.inquiryOpportunityRenewalFirstCandidateExactSourceCoverage, 0,
      'a search-source candidate must use the encoded current source, not an old lineage key');
    assert.equal(lineageOnlyCommitmentReport.inquiryOpportunityRenewalFirstAttemptExactSourceCoverage, 0);
    assert.equal(lineageOnlyCommitmentReport.inquiryOpportunityRenewalFallbackBeforeCommitmentViolations, 1);

    const legacySourceFactState = structuredClone(searchState);
    const legacySourceFactId = 'legacy-exhausted-search-source-fact';
    legacySourceFactState.world.past.push(actionFact({
      id: legacySourceFactId, atMonth: 1, who: owner.id,
      action: { kind: 'attend', target: { kind: 'self' } },
      diff: {},
    }));
    const legacyPrior = legacySourceFactState.projects.find((candidate) => candidate.id === priorId);
    assert.ok(legacyPrior);
    legacyPrior.searchCampaigns[0].sourceFactIds = [legacySourceFactId];
    legacyPrior.terminalInquiryOpportunityBasis.sourceFactIds = [legacySourceFactId];
    const legacyCurrentSourceKey = `inventory:${owner.id}:renamed-legacy-source`;
    const legacyRenewalKey = `search-source:39:${legacyCurrentSourceKey}`;
    const legacySameFactRenewal = project({ id: 'legacy-same-fact-renewal', createdAtMonth: 12 });
    legacySameFactRenewal.kind = 'production';
    legacySameFactRenewal.inquiryOpportunityBasis = {
      ...opportunityBasis(12), materialIds: [39], opportunityKeys: [legacyRenewalKey],
      opportunitySources: [{
        opportunityKey: legacyRenewalKey, kind: 'material', materialId: 39,
        sourceKeys: [legacyCurrentSourceKey], sourceFactIds: [legacySourceFactId],
      }],
      sourceFactIds: [legacySourceFactId], inheritedProjectIds: [priorId],
      renewalKeys: [legacyRenewalKey],
    };
    legacySourceFactState.projects.push(legacySameFactRenewal);
    const legacySourceFactReport = buildEvolutionFactsReport(legacySourceFactState, {
      ...pathFixture, runId: 'legacy-search-source-fact-fixture',
      requestedEndMonth: 12, reachedMonth: 12,
    });
    assert.equal(
      legacySourceFactReport.inquiryOpportunityReopenWithoutRenewalViolations,
      searchReport.inquiryOpportunityReopenWithoutRenewalViolations + 1,
      'an exhausted campaign source fact must keep the same renamed source from counting as renewal',
    );

    const mismatchedLineageState = structuredClone(searchState);
    const mismatchedRenewal = mismatchedLineageState.projects
      .find((candidate) => candidate.id === attributedRenewal.id);
    assert.ok(mismatchedRenewal);
    mismatchedRenewal.inquiryOpportunityBasis.opportunitySources[0].sourceKeys = [
      `inventory:${owner.id}:different-tin`,
      exactCurrentSourceKey,
    ];
    const mismatchedLineageReport = buildEvolutionFactsReport(mismatchedLineageState, {
      ...pathFixture, runId: 'search-source-lineage-mismatch-fixture', requestedEndMonth: 12, reachedMonth: 12,
    });
    assert.equal(mismatchedLineageReport.inquiryOpportunityRenewalCommitmentProjectCoverage, 71.43,
      'encoded exact source must be the current first source; appearance only in lineage cannot satisfy renewal');
    assert.equal(mismatchedLineageReport.inquiryOpportunityUnresolvedSources, 3,
      'bogus construction plus malformed source and its uncovered renewal key must remain auditable');
  }

  process.stdout.write('evolution observer metric tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
