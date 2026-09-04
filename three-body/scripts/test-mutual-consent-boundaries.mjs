import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-mutual-consent-'));
const bundlePath = path.join(temporaryDirectory, 'mutual-consent.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation-runtime.ts'))};
    export { buildSocialOptions } from ${JSON.stringify(path.resolve('src/game/eland/application/social-options.ts'))};
    export { activeReproductionAgreementBetween } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mutual-consent-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    activeReproductionAgreementBetween,
    buildSocialOptions,
    createInitialState,
    executePrimitiveAction,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const atMonth = 25 * 12;
  const state = createInitialState(20260904, {
    endpoint: { kind: 'months', value: atMonth + 12 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = atMonth;
  const [proposer, responder] = state.people;
  assert.ok(proposer && responder, 'fixture requires two people');
  proposer.position = { ...proposer.position, cellId: 1, previousCellId: 1, z: 1, previousZ: 1 };
  responder.position = { ...responder.position, cellId: 1, previousCellId: 1, z: 1, previousZ: 1 };

  const relation = responder.relations.find((candidate) => candidate.personId === proposer.id);
  assert.ok(relation, 'fixture requires a directed relation');
  relation.trust = -100;
  relation.bond = -100;
  relation.fear = 100;

  const companionId = `offer-companion:${atMonth}:${proposer.id}:${responder.id}`;
  const companionProposal = {
    kind: 'companion', proposerId: proposer.id, partnerId: responder.id,
    expiresAtMonth: atMonth + 4,
    sharedLivingAnchor: { version: 'shared-living-anchor-v1', cellId: 1, z: 1, radius: 2 },
  };
  const companionFact = {
    id: `e-${atMonth}-companion-offer`, kind: 'action', actionTick: 1,
    atMonth, orderInMonth: 0, cellId: 1, who: proposer.id, cause: 'intent',
    action: {
      kind: 'talk',
      speakerMeaning: { id: companionId, kind: 'offer', summary: '我们愿意结伴生活吗？', proposal: companionProposal },
    },
    fromCellId: 1, toCellId: 1, fromZ: 1, toZ: 1, pathSegment: [1],
    status: 'completed', result: '提出结伴', diff: {},
  };
  state.world.past.push(companionFact);
  state.agreements.push({
    id: companionId, proposal: companionProposal,
    proposerId: proposer.id, responderId: responder.id,
    partyIds: [proposer.id, responder.id], requiredResponderIds: [responder.id],
    acceptedByPersonIds: [proposer.id], rejectedByPersonIds: [], status: 'proposed',
    proposedAtMonth: atMonth, acceptByMonth: atMonth + 4,
    proposalEventId: companionFact.id, fulfillmentEventIds: [], fulfilledByPersonIds: [],
    coLocatedMonths: 0, sourceEventIds: [companionFact.id],
  });

  const responseOptions = buildSocialOptions(state, responder, [proposer], atMonth);
  assert.ok(responseOptions.some((option) => option.id === `accept-companion:${companionId}`),
    'negative trust/bond must not hide the responder-owned accept branch');
  assert.ok(responseOptions.some((option) => option.id === `reject-companion:${companionId}`),
    'the same proposal must expose the responder-owned reject branch');

  proposer.sex = 'male';
  responder.sex = 'female';
  proposer.bornAtMonth = atMonth - 26 * 12;
  responder.bornAtMonth = atMonth - 25 * 12;
  proposer.conditions = [];
  responder.conditions = [];
  proposer.body = { health: 100, hydration: 100, nutrition: 100 };
  responder.body = { health: 100, hydration: 100, nutrition: 100 };
  responder.traits = [{
    id: 'succubus', origin: 'spontaneous', inheritedFromPersonIds: [],
    sourceEventIds: ['fixture-succubus'],
  }];

  const unilateral = executePrimitiveAction(state, responder, {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: proposer.id }],
  }, atMonth, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(unilateral.status, 'blocked', 'a trait must not authorize use of another person\'s body');
  assert.equal(unilateral.diff.mutualConsent, false);

  const reproductionId = `offer-reproduce:${atMonth}:${proposer.id}:${responder.id}`;
  const reproductionAgreement = {
    id: reproductionId,
    proposal: {
      kind: 'reproduce', proposerId: proposer.id, partnerId: responder.id,
      expiresAtMonth: atMonth + 4,
    },
    proposerId: proposer.id, responderId: responder.id,
    partyIds: [proposer.id, responder.id], requiredResponderIds: [responder.id],
    acceptedByPersonIds: [proposer.id], rejectedByPersonIds: [], status: 'active',
    proposedAtMonth: atMonth, acceptByMonth: atMonth + 4,
    acceptedAtMonth: atMonth, dueAtMonth: atMonth + 3,
    proposalEventId: `e-${atMonth}-reproduction-offer`,
    fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0,
    sourceEventIds: [`e-${atMonth}-reproduction-offer`],
  };
  state.agreements.push(reproductionAgreement);
  assert.equal(activeReproductionAgreementBetween(
    state, proposer.id, responder.id, atMonth, reproductionId,
  ), undefined, 'an active label without both recorded acceptances is not consent');

  reproductionAgreement.acceptedByPersonIds.push(responder.id);
  assert.equal(activeReproductionAgreementBetween(
    state, proposer.id, responder.id, atMonth, reproductionId,
  )?.id, reproductionId);

  responder.body.health = 40;
  const bodilyBlocked = executePrimitiveAction(state, responder, {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: proposer.id }],
    authorizationRef: reproductionId,
  }, atMonth, 2, { cause: 'intent', actionTick: 3 });
  assert.equal(bodilyBlocked.status, 'blocked',
    'mutual consent permits an attempt but does not bypass age/body/biology boundaries');
  assert.equal(bodilyBlocked.diff.mutualConsent, true);

  responder.body.health = 100;
  const mutuallyAuthorized = executePrimitiveAction(state, responder, {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: proposer.id }],
    authorizationRef: reproductionId,
  }, atMonth, 3, { cause: 'intent', actionTick: 4 });
  assert.equal(mutuallyAuthorized.status, 'completed');
  assert.equal(mutuallyAuthorized.diff.mutualConsent, true);
  assert.equal(mutuallyAuthorized.diff.authorizationMode, 'agreement');

  process.stdout.write('mutual consent boundary tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
