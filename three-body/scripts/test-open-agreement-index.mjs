import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-open-agreement-index-'));
const bundlePath = path.join(temporaryDirectory, 'open-agreement-index.mjs');

try {
  const entry = `
    export {
      openAgreementCandidatesForPerson,
      recordAgreementAction,
      withLinearOpenAgreementLookupsForDiagnostics,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export {
      buildDecisionContextForPerson,
      hasPendingAgreementWork,
      planLocallyForTick,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/tick-planner.ts'))};
    export { RulePlanner } from ${JSON.stringify(path.resolve('src/game/eland/application/rule-planner.ts'))};
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=open-agreement-index-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const terminalCount = 2_000;
  const openCount = 30;
  const planningTicks = 15;

  function agreement({
    id,
    proposerId,
    responderId,
    status = 'rejected',
    kind = 'assist',
    need = 'shelter',
  }) {
    const proposal = kind === 'companion'
      ? { kind, proposerId, partnerId: responderId, expiresAtMonth: 120 }
      : { kind: 'assist', requesterId: proposerId, helperId: responderId, need, expiresAtMonth: 120 };
    return {
      id,
      proposal,
      proposerId,
      responderId,
      partyIds: [proposerId, responderId],
      requiredResponderIds: [responderId],
      acceptedByPersonIds: status === 'proposed' ? [proposerId] : [proposerId, responderId],
      rejectedByPersonIds: status === 'rejected' ? [responderId] : [],
      status,
      proposedAtMonth: 1,
      acceptByMonth: 120,
      ...(status === 'active' ? { acceptedAtMonth: 1, dueAtMonth: 120 } : {}),
      ...(['rejected', 'fulfilled', 'expired', 'breached', 'cancelled'].includes(status)
        ? { resolvedAtMonth: 1 }
        : {}),
      proposalEventId: `${id}:proposal`,
      ...(status !== 'proposed' ? { responseEventId: `${id}:response` } : {}),
      fulfillmentEventIds: [],
      fulfilledByPersonIds: [],
      coLocatedMonths: 0,
      sourceEventIds: [`${id}:proposal`],
    };
  }

  function decisionState(seed, instrumentStatusReads = false) {
    const state = api.createInitialState(seed, {
      characterIds: ['laozi', 'qinshihuang'],
      endpoint: { kind: 'months', value: 24 },
      chaosIntensity: 0,
    });
    state.clock.elapsedMonths = 1;
    state.people = state.people.slice(0, 2);
    const [proposer, responder] = state.people;
    for (const person of state.people) {
      person.bornAtMonth = -360;
      delete person.diedAtMonth;
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.conditions = [];
      person.position = structuredClone(proposer.position);
      delete person.activeIntentId;
    }
    state.intents = [];
    state.projects = [];
    state.agreements = [
      ...Array.from({ length: terminalCount }, (_, index) => agreement({
        id: `terminal:${index}`,
        proposerId: proposer.id,
        responderId: responder.id,
      })),
      ...Array.from({ length: openCount - 1 }, (_, index) => agreement({
        id: `open-active:${index}`,
        proposerId: proposer.id,
        responderId: responder.id,
        status: 'active',
      })),
    ];
    const reads = { count: 0 };
    if (instrumentStatusReads) for (const item of state.agreements) {
      let status = item.status;
      Object.defineProperty(item, 'status', {
        configurable: true,
        enumerable: true,
        get() {
          reads.count += 1;
          return status;
        },
        set(next) {
          status = next;
        },
      });
    }
    return { state, proposer, responder, reads };
  }

  const metricRun = (linear) => {
    const fixture = decisionState(linear ? 20260901 : 20260902, true);
    fixture.state.agreements.push(agreement({
      id: 'open-proposed:metric',
      proposerId: fixture.proposer.id,
      responderId: fixture.responder.id,
      status: 'proposed',
    }));
    const evaluate = () => Array.from({ length: planningTicks }, () => (
      api.hasPendingAgreementWork(fixture.state, fixture.responder, undefined, 1)
    ));
    const pending = linear
      ? api.withLinearOpenAgreementLookupsForDiagnostics(fixture.state, evaluate)
      : evaluate();
    return { pending, reads: fixture.reads.count };
  };

  const linearMetric = metricRun(true);
  const indexedMetric = metricRun(false);
  assert.deepEqual(indexedMetric.pending, linearMetric.pending,
    'indexed and direct participant scans must agree on every planning tick');
  assert.ok(indexedMetric.pending.every(Boolean), 'the final unresolved proposal must remain visible');
  assert.ok(indexedMetric.reads < linearMetric.reads * 0.15,
    `open-candidate index must remove at least 85% of mutable agreement predicate visits: ${indexedMetric.reads}/${linearMetric.reads}`);

  const expiredProposalFixture = decisionState(20260904, false);
  expiredProposalFixture.state.agreements = [agreement({
    id: 'expired-but-unsynchronized',
    proposerId: expiredProposalFixture.proposer.id,
    responderId: expiredProposalFixture.responder.id,
    status: 'proposed',
  })];
  expiredProposalFixture.state.agreements[0].acceptByMonth = 0;
  const indexedExpiredPending = api.hasPendingAgreementWork(
    expiredProposalFixture.state,
    expiredProposalFixture.responder,
    undefined,
    1,
  );
  const linearExpiredPending = api.withLinearOpenAgreementLookupsForDiagnostics(
    expiredProposalFixture.state,
    () => api.hasPendingAgreementWork(
      expiredProposalFixture.state,
      expiredProposalFixture.responder,
      undefined,
      1,
    ),
  );
  assert.equal(indexedExpiredPending, true,
    'an expired proposed agreement remains pending until authoritative lifecycle synchronization changes its status');
  assert.equal(indexedExpiredPending, linearExpiredPending,
    'indexed lookup must preserve the old unsynchronized expired-proposal cadence semantics');

  const mutationState = { agreements: [] };
  const actorId = 'person:actor';
  const partnerId = 'person:partner';
  const accepted = agreement({ id: 'accepted', proposerId: partnerId, responderId: actorId, status: 'proposed' });
  const rejected = agreement({ id: 'rejected-later', proposerId: partnerId, responderId: actorId, status: 'proposed' });
  const fulfilled = agreement({ id: 'fulfilled-later', proposerId: partnerId, responderId: actorId, status: 'active' });
  const legacyCompanion = agreement({
    id: 'legacy-companion', proposerId: partnerId, responderId: actorId, status: 'fulfilled', kind: 'companion',
  });
  mutationState.agreements = [accepted, rejected, fulfilled, legacyCompanion];
  const candidateIds = () => api.openAgreementCandidatesForPerson(mutationState, actorId).map((item) => item.id);
  assert.deepEqual(candidateIds(), ['accepted', 'rejected-later', 'fulfilled-later', 'legacy-companion'],
    'initial candidates retain authoritative insertion order');
  accepted.status = 'active';
  assert.ok(candidateIds().includes(accepted.id), 'accept transition remains open in the same object');
  rejected.status = 'rejected';
  fulfilled.status = 'fulfilled';
  assert.deepEqual(candidateIds(), ['accepted', 'legacy-companion'],
    'reject and non-companion fulfill transitions are removed lazily');
  legacyCompanion.status = 'active';
  assert.ok(candidateIds().includes(legacyCompanion.id),
    'fulfilled legacy companion survives until lifecycle reactivates it');

  const appended = agreement({ id: 'same-tick-append', proposerId: partnerId, responderId: actorId, status: 'proposed' });
  mutationState.agreements.push(appended);
  assert.deepEqual(candidateIds(), ['accepted', 'legacy-companion', 'same-tick-append'],
    'same-tick append is indexed without rebuilding the authoritative prefix');
  appended.status = 'rejected';
  assert.deepEqual(candidateIds(), ['accepted', 'legacy-companion'], 'same-tick rejection is visible immediately');

  const replacement = agreement({ id: 'replacement-array', proposerId: partnerId, responderId: actorId, status: 'proposed' });
  mutationState.agreements = [replacement];
  assert.deepEqual(candidateIds(), ['replacement-array'], 'whole-array replacement gets an identity-scoped index');
  const truncatedTail = agreement({ id: 'truncated-tail', proposerId: partnerId, responderId: actorId, status: 'active' });
  mutationState.agreements.push(truncatedTail);
  assert.deepEqual(candidateIds(), ['replacement-array', 'truncated-tail']);
  mutationState.agreements.length = 1;
  assert.deepEqual(candidateIds(), ['replacement-array'], 'same-array shortening rebuilds instead of retaining stale refs');
  const oldTail = agreement({ id: 'old-tail', proposerId: partnerId, responderId: actorId, status: 'active' });
  mutationState.agreements.push(oldTail);
  assert.deepEqual(candidateIds(), ['replacement-array', 'old-tail']);
  const newTail = agreement({ id: 'new-tail', proposerId: partnerId, responderId: actorId, status: 'proposed' });
  mutationState.agreements[1] = newTail;
  assert.deepEqual(candidateIds(), ['replacement-array', 'new-tail'],
    'same-length old-tail replacement fails safe to a rebuild');

  const planningFixture = (seed) => {
    const fixture = decisionState(seed, false);
    const proposalId = 'planner-company-request';
    const proposalFact = {
      id: `${proposalId}:fact`,
      kind: 'action',
      actionTick: 1,
      atMonth: 1,
      orderInMonth: 1,
      planningTick: 1,
      orderInTick: 0,
      cellId: fixture.proposer.position.cellId,
      who: fixture.proposer.id,
      cause: 'intent',
      action: {
        kind: 'communicate',
        content: {
          id: proposalId,
          kind: 'request',
          summary: '希望获得陪伴',
          proposal: {
            kind: 'assist',
            requesterId: fixture.proposer.id,
            helperId: fixture.responder.id,
            need: 'company',
            expiresAtMonth: 6,
          },
        },
        audience: [fixture.responder.id],
        channel: 'voice',
      },
      fromCellId: fixture.proposer.position.cellId,
      toCellId: fixture.proposer.position.cellId,
      fromZ: fixture.proposer.position.z,
      toZ: fixture.proposer.position.z,
      pathSegment: [fixture.proposer.position.cellId],
      status: 'completed',
      result: '提出陪伴请求',
      diff: {},
    };
    api.appendCommittedEvents(fixture.state, [proposalFact]);
    api.recordAgreementAction(fixture.state, proposalFact);
    return fixture;
  };

  const runPlanner = (linear) => {
    const fixture = planningFixture(20260903);
    const planner = new api.RulePlanner();
    const reviewedPeople = new Set();
    const cadence = { ordinaryDeliberationCounts: new Map(), ordinaryReplanPermits: new Set() };
    const events = [];
    const optionsByTick = [];
    const work = () => {
      for (let planningTick = 1; planningTick <= planningTicks; planningTick += 1) {
        const context = api.buildDecisionContextForPerson(fixture.state, fixture.responder, 1);
        optionsByTick.push(context.options);
        api.planLocallyForTick(
          fixture.state,
          fixture.responder,
          1,
          planningTick,
          events,
          planner,
          reviewedPeople,
          cadence,
        );
      }
    };
    if (linear) api.withLinearOpenAgreementLookupsForDiagnostics(fixture.state, work);
    else work();
    return { state: fixture.state, events, optionsByTick };
  };

  const linearPlanning = runPlanner(true);
  const indexedPlanning = runPlanner(false);
  assert.deepEqual(indexedPlanning.optionsByTick, linearPlanning.optionsByTick,
    '15-tick option streams must be byte-identical');
  assert.deepEqual(indexedPlanning.events, linearPlanning.events,
    '15-tick decision events must be byte-identical');
  assert.deepEqual(indexedPlanning.state, linearPlanning.state,
    '15-tick authoritative final state must be byte-identical');

  const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const stateHash = stableHash(indexedPlanning.state);
  const eventHash = stableHash(indexedPlanning.events);
  console.log(JSON.stringify({
    result: 'passed',
    terminalCount,
    openCount,
    planningTicks,
    linearPredicateVisits: linearMetric.reads,
    indexedPredicateVisits: indexedMetric.reads,
    predicateVisitReduction: 1 - indexedMetric.reads / linearMetric.reads,
    decisionEvents: indexedPlanning.events.length,
    stateHash,
    eventHash,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
