import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-life-review-test-'));
const bundlePath = path.join(temporaryDirectory, 'life-review.mjs');

try {
  const testEntry = `
    export { createInitialState, previewGroundedLifeReviewOpportunity } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { groundedLifeReviewOpportunity, RulePlanner } from ${JSON.stringify(path.resolve('src/game/eland/application/rule-planner.ts'))};
    export { buildRelationshipCausalBasis, canOfferRelationshipProposal } from ${JSON.stringify(path.resolve('src/game/eland/domain/relationship-evidence.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelWorldRevision } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=grounded-life-review-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    RulePlanner,
    buildRelationshipCausalBasis,
    canOfferRelationshipProposal,
    cellX,
    cellY,
    createInitialState,
    groundedLifeReviewOpportunity,
    neighbors4,
    previewGroundedLifeReviewOpportunity,
    setVoxel,
    voxelWorldRevision,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(710, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 120;
  const [actor, partner] = state.people;
  assert.ok(actor && partner, 'fixture requires two people');
  actor.sex = 'male';
  partner.sex = 'female';
  actor.body = { health: 100, hydration: 100, nutrition: 100 };
  partner.body = { health: 100, hydration: 100, nutrition: 100 };
  actor.personality.baseline.emotionality = 90;
  actor.personality.baseline.extraversion = 90;
  actor.personality.baseline.conscientiousness = 10;
  const female = actor.sex === 'female' ? actor : partner;
  const male = actor.sex === 'male' ? actor : partner;
  female.bornAtMonth = state.clock.elapsedMonths - 40 * 12;
  male.bornAtMonth = state.clock.elapsedMonths - 35 * 12;
  const relation = actor.relations.find((candidate) => candidate.personId === partner.id);
  const reciprocalRelation = partner.relations.find((candidate) => candidate.personId === actor.id);
  assert.ok(relation, 'fixture requires a directed relation');
  assert.ok(reciprocalRelation, 'fixture requires a reciprocal relation');
  Object.assign(relation, { trust: 90, bond: 90, sourceEventIds: ['relationship-evidence'] });
  Object.assign(reciprocalRelation, { trust: 90, bond: 90 });
  partner.position = structuredClone(actor.position);
  actor.inventory = [
    { id: 'life-review-ready-food', materialId: Material.Food, quantity: 8, sourceEventIds: ['relationship-evidence'] },
    { id: 'life-review-ready-water', materialId: Material.Water, quantity: 4, sourceEventIds: ['relationship-evidence'] },
  ];
  state.world.past.push({
    id: 'relationship-evidence', kind: 'action', actionTick: 1, atMonth: 118, orderInMonth: 0,
    cellId: actor.position.cellId, who: actor.id, cause: 'intent',
    action: { kind: 'attend', target: { kind: 'person', personId: partner.id } },
    fromCellId: actor.position.cellId, toCellId: actor.position.cellId,
    fromZ: actor.position.z, toZ: actor.position.z, pathSegment: [actor.position.cellId],
    status: 'completed', result: '共同经历形成新的关系证据', diff: {},
  });

  const project = {
    id: 'project-life-review-fixture', kind: 'production', need: 'food-preparation', desiredFunction: 'prepared-food',
    summary: '继续加工食物', ownerId: actor.id, beneficiaryIds: [actor.id], triggerFactIds: ['project-pressure-evidence'],
    pressure: 55, createdAtMonth: 100, reviewAtMonth: 130, status: 'active', lastProgressAtMonth: 120,
    missingMaterialIds: [], reservations: [], contributorIds: [actor.id], actionEventIds: ['project-progress-evidence'],
    failureEventIds: [], completionEventIds: [], logisticsEpisodes: [],
  };
  state.projects = [project];
  const activeIntent = {
    id: 'intent-life-review-fixture', ownerId: actor.id, summary: project.summary, domain: 'strategic',
    goal: { kind: 'project-completed', projectId: project.id }, nextAction: { kind: 'attend', target: { kind: 'person', personId: actor.id } },
    status: 'active', createdAtMonth: 100, lastProgressAtMonth: 120, progress: 0.5,
    sourceDecisionEventId: 'project-decision', projectId: project.id, sourceFactIds: [...project.triggerFactIds], actionEventIds: [], replanCount: 0,
  };
  state.intents = [activeIntent];
  actor.activeIntentId = activeIntent.id;

  const projectOption = {
    id: `project:${project.id}:continue`, summary: project.summary, reason: '项目仍有真实下一步',
    goal: { kind: 'project-completed', projectId: project.id }, nextAction: { kind: 'attend', target: { kind: 'person', personId: actor.id } },
    target: { kind: 'person', personId: actor.id }, estimatedDuration: 'long', estimatedMonths: 10,
    sourceFactIds: [...project.triggerFactIds], domain: 'strategic', projectId: project.id, projectPressure: project.pressure,
  };
  const offerId = `offer-reproduce:${state.clock.elapsedMonths}:${actor.id}:${partner.id}`;
  const relationshipBasis = buildRelationshipCausalBasis(state, actor, partner, 'reproduce');
  const lifeOption = {
    id: offerId, summary: `向${partner.name}提出共同生殖`, reason: '双方可见且身体条件允许',
    goal: { kind: 'representation-made', representationId: offerId },
    nextAction: { kind: 'communicate', content: { id: offerId, kind: 'offer', summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce', proposerId: actor.id, partnerId: partner.id, expiresAtMonth: 124, basis: relationshipBasis } }, audience: [partner.id], channel: 'voice' },
    target: { kind: 'person', personId: partner.id }, estimatedDuration: 'one-month', estimatedMonths: 1,
    sourceFactIds: relationshipBasis.sourceFactIds, domain: 'social', requiresFollowUp: false,
    relationshipBasis,
  };
  state.derived.structures = [];
  const shelterCenter = actor.position.cellId;
  const shelterZ = actor.position.z;
  const adjacent = neighbors4(shelterCenter);
  const spareCell = adjacent[1] ?? adjacent[0];
  const spareNeighbors = neighbors4(spareCell);
  const shelterCells = [...new Set([shelterCenter, ...adjacent, spareCell, ...spareNeighbors])];
  for (const cell of shelterCells) {
    setVoxel(state.world.grid, cellX(cell), cellY(cell), shelterZ - 1, Material.PackedSoil);
    setVoxel(state.world.grid, cellX(cell), cellY(cell), shelterZ, Material.Air);
    setVoxel(state.world.grid, cellX(cell), cellY(cell), shelterZ + 1, Material.Air);
    setVoxel(state.world.grid, cellX(cell), cellY(cell), shelterZ + 2, Material.Air);
  }
  setVoxel(state.world.grid, cellX(shelterCenter), cellY(shelterCenter), shelterZ + 2, Material.Stone);
  setVoxel(state.world.grid, cellX(spareCell), cellY(spareCell), shelterZ + 2, Material.Stone);
  const spareWalls = spareNeighbors.filter((cell) => cell !== shelterCenter);
  for (const wallCell of spareWalls) {
    setVoxel(state.world.grid, cellX(wallCell), cellY(wallCell), shelterZ, Material.Stone);
  }
  state.derived.structures.push({
    id: 'life-review-family-ready-shelter',
    materialIds: [Material.Stone],
    occupiedCells: [shelterCenter, spareCell, ...spareWalls],
    interiorPositions: [{ cellId: shelterCenter, z: shelterZ }, { cellId: spareCell, z: shelterZ }],
    complete: true,
    capacity: 2,
    sourceEventIds: ['relationship-evidence'],
  });
  state.world.physicalStructureIndex = {
    calculatedAtMonth: state.clock.elapsedMonths,
    voxelRevision: voxelWorldRevision(state.world.grid),
    constructionEventCount: state.world.physicalStructureIndex.constructionEventCount,
    structures: structuredClone(state.derived.structures),
  };
  const context = {
    state, person: actor, visibleCells: [actor.position.cellId, spareCell], visiblePeople: [partner], visibleDrops: [], visibleAnimals: [],
    options: [projectOption, lifeOption], followUpOptions: [projectOption], activeIntent,
  };

  const before = structuredClone(state);
  const opportunity = groundedLifeReviewOpportunity(context);
  assert.ok(opportunity, 'age, relationship and isolation pressure should expose one grounded life review');
  assert.equal(opportunity.option.id, lifeOption.id);
  assert.ok(opportunity.lifePressure >= opportunity.projectPressure + 10, 'life pressure must cross the explicit project margin');
  const decision = new RulePlanner().decideAt(context, { atMonth: 121, planningTick: 1 });
  assert.equal(decision.kind, 'revise');
  assert.equal(decision.optionId, lifeOption.id);
  assert.equal(decision.mode, 'interrupt');
  assert.equal(decision.interruptionKind, 'life-review');
  assert.equal(decision.followUpOptionId, undefined, '结构化生活提议本身就是完整行动，不能拼接无关项目动作');
  assert.match(decision.reason, /生活复核：/);
  assert.equal(decision.lifeReview?.version, 'causal-edge-v2');
  assert.equal(decision.lifeReview?.targetPersonId, partner.id);
  assert.ok(decision.lifeReview?.sourceFactIds.includes('relationship-evidence'));
  assert.equal(decision.lifeReview?.relationshipBasis?.basisKey, relationshipBasis.basisKey);
  assert.deepEqual(state, before, 'observing and ranking a life review must not mutate simulation facts');

  const reviewedThisMonth = structuredClone(context);
  reviewedThisMonth.state.world.past.push({
    id: 'life-review-decision-this-month', kind: 'decision', atMonth: 121, orderInMonth: 1,
    cellId: reviewedThisMonth.person.position.cellId, who: reviewedThisMonth.person.id,
    decision: structuredClone(decision), intentId: reviewedThisMonth.activeIntent.id,
    usedModel: false, domain: 'social', result: '本月已经完成一次有事实来源的生活复核',
  });
  assert.equal(groundedLifeReviewOpportunity(reviewedThisMonth), null,
    'one explicit life review decision must consume the optional review opportunity for that person-month');

  const seenBasis = structuredClone(context);
  seenBasis.activeIntent.lifeReview = structuredClone(decision.lifeReview);
  seenBasis.state.intents[0].lifeReview = structuredClone(decision.lifeReview);
  assert.equal(groundedLifeReviewOpportunity(seenBasis), null, 'the same causal basis must not trigger twice');
  const changedRelation = seenBasis.person.relations.find((candidate) => candidate.personId === partner.id);
  changedRelation.sourceEventIds.push('new-relationship-evidence');
  seenBasis.state.world.past.push({
    id: 'new-relationship-evidence', kind: 'action', actionTick: 1, atMonth: 120, orderInMonth: 1,
    cellId: seenBasis.person.position.cellId, who: partner.id, cause: 'intent',
    action: { kind: 'attend', target: { kind: 'person', personId: seenBasis.person.id } },
    fromCellId: seenBasis.person.position.cellId, toCellId: seenBasis.person.position.cellId,
    fromZ: seenBasis.person.position.z, toZ: seenBasis.person.position.z,
    pathSegment: [seenBasis.person.position.cellId], status: 'completed', result: '新的共同经历', diff: {},
  });
  const changedBasis = buildRelationshipCausalBasis(seenBasis.state, seenBasis.person, seenBasis.state.people.find((person) => person.id === partner.id), 'reproduce');
  const changedLifeOption = seenBasis.options.find((option) => option.id === lifeOption.id);
  changedLifeOption.relationshipBasis = changedBasis;
  changedLifeOption.sourceFactIds = changedBasis.sourceFactIds;
  changedLifeOption.nextAction.content.proposal.basis = changedBasis;
  assert.ok(groundedLifeReviewOpportunity(seenBasis), 'new relationship evidence may create a new review edge');

  const rejectedState = structuredClone(state);
  const rejectedActor = rejectedState.people.find((person) => person.id === actor.id);
  const rejectedPartner = rejectedState.people.find((person) => person.id === partner.id);
  const rejectedBasis = buildRelationshipCausalBasis(rejectedState, rejectedActor, rejectedPartner, 'reproduce');
  rejectedState.agreements.push({
    id: 'rejected-relationship-offer',
    proposal: { kind: 'reproduce', proposerId: rejectedActor.id, partnerId: rejectedPartner.id, expiresAtMonth: 124, basis: rejectedBasis },
    proposerId: rejectedActor.id, responderId: rejectedPartner.id, partyIds: [rejectedActor.id, rejectedPartner.id],
    requiredResponderIds: [rejectedPartner.id], acceptedByPersonIds: [rejectedActor.id], rejectedByPersonIds: [rejectedPartner.id],
    status: 'rejected', proposedAtMonth: 120, acceptByMonth: 124, resolvedAtMonth: 121,
    proposalEventId: 'rejected-proposal-event', responseEventId: 'rejected-response-event',
    fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0, sourceEventIds: [],
  });
  rejectedState.clock.elapsedMonths = 125;
  const unchangedAfterTime = buildRelationshipCausalBasis(rejectedState, rejectedActor, rejectedPartner, 'reproduce', 125);
  assert.equal(canOfferRelationshipProposal(rejectedState, rejectedActor, rejectedPartner, unchangedAfterTime), false,
    'elapsed months alone must not reopen a rejected relationship proposal');

  rejectedActor.cognition ??= { version: 'causal-bdi-v1', outcomeBeliefs: [], goalOutcomeBeliefs: [], needResolutionEpisodes: [] };
  rejectedActor.cognition.needResolutionEpisodes ??= [];
  rejectedActor.cognition.needResolutionEpisodes.push({
    version: 'need-resolution-episode-v1', id: 'need-resolution:rejected-project:actor',
    projectId: 'rejected-project', projectNeed: 'reserve-security', desiredFunction: 'settled-cultivation',
    basisKey: 'need-resolution:reserve-security:settled-cultivation', observedAtMonth: 125,
    observationKind: 'completion-action', triggerFactIds: ['project-trigger'], outcomeEventIds: ['project-outcome'],
    sourceFactIds: ['project-trigger', 'project-outcome'],
  });
  const afterProjectCompletion = buildRelationshipCausalBasis(rejectedState, rejectedActor, rejectedPartner, 'reproduce', 125);
  assert.equal(canOfferRelationshipProposal(rejectedState, rejectedActor, rejectedPartner, afterProjectCompletion), false,
    '项目完成可以缓解项目需要，但不能单独重开已经被拒绝的关系配对');

  const talkEventId = 'ordinary-talk-after-rejection';
  rejectedState.world.past.push({
    id: talkEventId, kind: 'action', actionTick: 1, atMonth: 126, orderInMonth: 0,
    cellId: rejectedActor.position.cellId, who: rejectedActor.id, cause: 'intent',
    action: { kind: 'communicate', content: { id: talkEventId, kind: 'claim', summary: '普通交谈' }, audience: [rejectedPartner.id], channel: 'voice' },
    fromCellId: rejectedActor.position.cellId, toCellId: rejectedActor.position.cellId,
    fromZ: rejectedActor.position.z, toZ: rejectedActor.position.z, pathSegment: [rejectedActor.position.cellId],
    status: 'completed', result: '完成普通交谈', diff: {},
  });
  rejectedActor.relations.find((candidate) => candidate.personId === rejectedPartner.id).sourceEventIds.push(talkEventId);
  const afterTalk = buildRelationshipCausalBasis(rejectedState, rejectedActor, rejectedPartner, 'reproduce', 126);
  assert.equal(afterTalk.basisKey, unchangedAfterTime.basisKey, 'ordinary communication must not become qualifying relationship evidence');
  assert.equal(canOfferRelationshipProposal(rejectedState, rejectedActor, rejectedPartner, afterTalk), false);

  const ageBandState = structuredClone(rejectedState);
  const ageBandActor = ageBandState.people.find((person) => person.id === rejectedActor.id);
  const ageBandPartner = ageBandState.people.find((person) => person.id === rejectedPartner.id);
  ageBandState.clock.elapsedMonths = 132;
  const crossedAgeBand = buildRelationshipCausalBasis(ageBandState, ageBandActor, ageBandPartner, 'reproduce', 132);
  assert.equal(canOfferRelationshipProposal(ageBandState, ageBandActor, ageBandPartner, crossedAgeBand), true,
    'crossing a real reproductive age band may reopen appraisal without pretending that the relationship itself changed');
  ageBandState.agreements.push({
    ...structuredClone(ageBandState.agreements.at(-1)), id: 'age-band-offer',
    proposal: { kind: 'reproduce', proposerId: ageBandActor.id, partnerId: ageBandPartner.id, expiresAtMonth: 136, basis: crossedAgeBand },
    status: 'rejected', proposedAtMonth: 132, acceptByMonth: 136, resolvedAtMonth: 132,
    proposalEventId: 'age-band-proposal-event', responseEventId: 'age-band-response-event',
  });
  const sameNewBand = buildRelationshipCausalBasis(ageBandState, ageBandActor, ageBandPartner, 'reproduce', 133);
  assert.equal(canOfferRelationshipProposal(ageBandState, ageBandActor, ageBandPartner, sameNewBand), false,
    'remaining in the same reproductive age band must not create another edge');

  const sharedExperienceId = 'shared-experience-after-rejection';
  rejectedState.world.past.push({
    id: sharedExperienceId, kind: 'action', actionTick: 1, atMonth: 127, orderInMonth: 0,
    cellId: rejectedActor.position.cellId, who: rejectedActor.id, cause: 'intent',
    action: { kind: 'attend', target: { kind: 'person', personId: rejectedPartner.id } },
    fromCellId: rejectedActor.position.cellId, toCellId: rejectedActor.position.cellId,
    fromZ: rejectedActor.position.z, toZ: rejectedActor.position.z, pathSegment: [rejectedActor.position.cellId],
    status: 'completed', result: '共同经历了新的事情', diff: {},
  });
  rejectedActor.relations.find((candidate) => candidate.personId === rejectedPartner.id).sourceEventIds.push(sharedExperienceId);
  const afterSharedExperience = buildRelationshipCausalBasis(rejectedState, rejectedActor, rejectedPartner, 'reproduce', 127);
  assert.equal(canOfferRelationshipProposal(rejectedState, rejectedActor, rejectedPartner, afterSharedExperience), false,
    'new generic coactivity must not reopen a rejected reproduction proposal');

  const addDirectExchange = (month) => {
    const basisKey = `grounded-conversation-v1|topic=care|speaker=${rejectedActor.id}|listener=${rejectedPartner.id}|sources=relationship-evidence`;
    const openingId = `renewed-intimacy-${month}-opening`;
    const responseId = `renewed-intimacy-${month}-response`;
    const actionFact = (id, orderInMonth, who, action) => ({
      id, kind: 'action', actionTick: 1, atMonth: month, orderInMonth,
      cellId: rejectedActor.position.cellId, who, cause: 'intent', action,
      fromCellId: rejectedActor.position.cellId, toCellId: rejectedActor.position.cellId,
      fromZ: rejectedActor.position.z, toZ: rejectedActor.position.z,
      pathSegment: [rejectedActor.position.cellId], status: 'completed', result: '新的直接生活交流',
      diff: { groundedConversationBasisKey: basisKey },
    });
    rejectedState.world.past.push(
      actionFact(openingId, 0, rejectedActor.id, {
        kind: 'communicate', content: { id: openingId, kind: 'claim', summary: '问问照护近况', conversation: {
          version: 'grounded-conversation-v1', basisKey, topic: 'care', turn: 'opening',
          speakerId: rejectedActor.id, listenerId: rejectedPartner.id, sourceFactIds: ['relationship-evidence'],
        } }, audience: [rejectedPartner.id], channel: 'voice',
      }),
      actionFact(responseId, 1, rejectedPartner.id, {
        kind: 'communicate', content: { id: responseId, kind: 'claim', summary: '回应照护近况', conversation: {
          version: 'grounded-conversation-v1', basisKey, topic: 'care', turn: 'response',
          speakerId: rejectedPartner.id, listenerId: rejectedActor.id, sourceFactIds: ['relationship-evidence'],
          referenceEventId: openingId, stance: 'supportive',
        } }, audience: [rejectedActor.id], channel: 'voice',
      }),
    );
    const directed = rejectedActor.relations.find((candidate) => candidate.personId === rejectedPartner.id);
    directed.sourceEventIds.push(openingId, responseId);
  };
  addDirectExchange(128);
  addDirectExchange(129);
  rejectedState.clock.elapsedMonths = 129;
  const afterRenewedIntimacy = buildRelationshipCausalBasis(rejectedState, rejectedActor, rejectedPartner, 'reproduce', 129);
  assert.equal(canOfferRelationshipProposal(rejectedState, rejectedActor, rejectedPartner, afterRenewedIntimacy), true,
    'rejected reproduction proposal may reopen once after new direct interpersonal evidence');

  const inFlightState = structuredClone(state);
  const inFlightActor = inFlightState.people.find((person) => person.id === actor.id);
  const inFlightPartner = inFlightState.people.find((person) => person.id === partner.id);
  const inFlightBasis = buildRelationshipCausalBasis(inFlightState, inFlightActor, inFlightPartner, 'reproduce');
  inFlightState.intents = [{ ...structuredClone(activeIntent), id: 'in-flight-relationship-intent', ownerId: inFlightActor.id,
    status: 'active', relationshipBasis: inFlightBasis }];
  assert.equal(canOfferRelationshipProposal(inFlightState, inFlightActor, inFlightPartner, inFlightBasis), false,
    'an active or suspended intent must block a duplicate proposal with the same subject');

  const beforePreview = structuredClone(state);
  previewGroundedLifeReviewOpportunity(state, actor);
  assert.deepEqual(state, beforePreview, 'compiling a preview must not lock routes or otherwise mutate authoritative state');

  const noConcreteOption = { ...context, options: [projectOption] };
  assert.equal(groundedLifeReviewOpportunity(noConcreteOption), null, 'pressure without a concrete life option must never trigger');

  const urgent = structuredClone(context);
  urgent.person.body.health = 20;
  urgent.state.people.find((person) => person.id === urgent.person.id).body.health = 20;
  assert.equal(groundedLifeReviewOpportunity(urgent), null, 'survival danger must suppress optional life review');

  const highPressure = structuredClone(context);
  highPressure.state.projects[0].pressure = 140;
  highPressure.options[0].projectPressure = 140;
  assert.equal(groundedLifeReviewOpportunity(highPressure), null, 'a more urgent local project must retain focus');

  const recentlyConnected = structuredClone(context);
  const recentActor = recentlyConnected.person;
  const recentPartner = recentlyConnected.state.people.find((person) => person.id === partner.id);
  const recentFemale = recentActor.sex === 'female' ? recentActor : recentPartner;
  recentFemale.bornAtMonth = state.clock.elapsedMonths - 25 * 12;
  const recentRelation = recentActor.relations.find((candidate) => candidate.personId === partner.id);
  Object.assign(recentRelation, { trust: 0, bond: 0 });
  recentActor.personality.baseline.emotionality = 45;
  recentActor.personality.baseline.extraversion = 45;
  recentlyConnected.state.world.past = [{
    id: 'recent-positive-contact', kind: 'action', actionTick: 1, atMonth: 119, orderInMonth: 0, cellId: recentActor.position.cellId,
    who: partner.id, cause: 'intent', action: { kind: 'communicate', content: { id: 'recent-talk', kind: 'claim', summary: '近况' }, audience: [recentActor.id], channel: 'voice' },
    fromCellId: recentActor.position.cellId, toCellId: recentActor.position.cellId, fromZ: recentActor.position.z, toZ: recentActor.position.z,
    pathSegment: [recentActor.position.cellId], status: 'completed', result: '完成交流', diff: {},
  }];
  assert.equal(groundedLifeReviewOpportunity(recentlyConnected), null, 'elapsed time and a generic contact must not create an isolation score');

  process.stdout.write('grounded life review tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
