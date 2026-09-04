import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-mutual-reproduction-semantics-'));
const bundlePath = path.join(temporaryDirectory, 'mutual-reproduction-semantics.mjs');

try {
  const entry = `
    export { createInitialState, buildDecisionContextForPerson } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { actionOptionSemantics, validateActionOptionSemantics } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-option-semantics.ts'))};
    export { buildCognitiveFrame } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/option-appraisal.ts'))};
    export { traitDefinition } from ${JSON.stringify(path.resolve('src/game/eland/domain/trait.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mutual-reproduction-semantics-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    actionOptionSemantics,
    buildCognitiveFrame,
    buildDecisionContextForPerson,
    createInitialState,
    traitDefinition,
    validateActionOptionSemantics,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const authorizedOption = {
    id: 'fixture-reproduce', summary: '进行已同意的生殖尝试', reason: '双方已明确同意',
    goal: { kind: 'condition', personId: 'female', condition: 'pregnancy', present: true },
    nextAction: {
      kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: 'male' }],
      authorizationRef: 'agreement:reproduce',
    },
    target: { kind: 'person', personId: 'male' }, estimatedDuration: 'one-month',
    estimatedMonths: 1, risks: [], domain: 'social', sourceFactIds: ['agreement:reproduce'],
  };
  assert.equal(actionOptionSemantics(authorizedOption).reproduction?.mode, 'mutual');
  assert.throws(() => actionOptionSemantics({
    ...authorizedOption,
    nextAction: { ...authorizedOption.nextAction, authorizationRef: undefined },
  }), /mutual agreement reference/,
  'an executable option cannot reinterpret a missing agreement as a trait-owned mode');
  assert.throws(() => validateActionOptionSemantics({
    version: 'action-option-semantics-v1',
    obligation: 'commitment-action', planningChannel: 'edge', purpose: 'reproduction',
    minimumLifeStage: 'adult', needKinds: ['generativity'],
    reproduction: { direction: 'proceed', phase: 'attempt', mode: 'unilateral-trait' },
    socialContext: {
      cooperationKind: 'reproduction', phase: 'fulfillment', counterpartIds: ['male'],
      referenceId: 'agreement:reproduce',
    },
    edgeTrigger: 'commitment-action',
  }), /Invalid reproduction mode/,
  'the obsolete unilateral-trait semantic is no longer accepted at the boundary');

  const atMonth = 25 * 12;
  const cognitionSnapshot = (withSuccubus) => {
    const state = createInitialState(20260904, {
      endpoint: { kind: 'months', value: atMonth + 12 }, chaosIntensity: 0,
    });
    state.clock.elapsedMonths = atMonth;
    const [female, male] = state.people;
    assert.ok(female && male, 'fixture requires two people');
    state.people = [female, male];
    female.sex = 'female';
    male.sex = 'male';
    female.bornAtMonth = atMonth - 25 * 12;
    male.bornAtMonth = atMonth - 26 * 12;
    female.position = { ...female.position, cellId: 1, previousCellId: 1, z: 1, previousZ: 1 };
    male.position = { ...male.position, cellId: 1, previousCellId: 1, z: 1, previousZ: 1 };
    female.conditions = [];
    male.conditions = [];
    female.body = { health: 90, hydration: 90, nutrition: 90 };
    male.body = { health: 90, hydration: 90, nutrition: 90 };
    female.traits = withSuccubus ? [{
      id: 'succubus', origin: 'spontaneous', inheritedFromPersonIds: [],
      sourceEventIds: ['fixture-succubus'],
    }] : [];
    male.traits = [];
    const agreementId = `agreement:reproduce:${female.id}:${male.id}`;
    state.agreements = [{
      id: agreementId,
      proposal: { kind: 'reproduce', proposerId: male.id, partnerId: female.id, expiresAtMonth: atMonth + 4 },
      proposerId: male.id, responderId: female.id,
      partyIds: [male.id, female.id], requiredResponderIds: [female.id],
      acceptedByPersonIds: [male.id, female.id], rejectedByPersonIds: [], status: 'active',
      proposedAtMonth: atMonth, acceptByMonth: atMonth + 4,
      acceptedAtMonth: atMonth, dueAtMonth: atMonth + 3,
      proposalEventId: 'fixture-reproduction-proposal', responseEventId: 'fixture-reproduction-acceptance',
      fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0,
      sourceEventIds: ['fixture-reproduction-proposal', 'fixture-reproduction-acceptance'],
    }];

    const context = buildDecisionContextForPerson(state, female, atMonth);
    const attempt = context.options.find((option) => option.id.startsWith(`reproduce:${agreementId}:`));
    assert.ok(attempt, 'an active mutual agreement should expose its attempt option');
    const frame = buildCognitiveFrame(context, [attempt], { atMonth, planningTick: 1 });
    const need = frame.needs.find((candidate) => candidate.kind === 'generativity');
    const appraisal = frame.appraisals[0];
    assert.ok(need && appraisal, 'mutual reproduction should be represented in cognition');
    return {
      urgency: need.urgency,
      readinessGate: appraisal.readinessGate,
      needReasons: need.reasons,
      appraisalReasons: appraisal.reasons,
      semanticMode: actionOptionSemantics(attempt).reproduction?.mode,
    };
  };

  const ordinary = cognitionSnapshot(false);
  const succubus = cognitionSnapshot(true);
  assert.equal(succubus.semanticMode, 'mutual');
  assert.equal(succubus.urgency, ordinary.urgency,
    'a postpartum physiology trait must not manufacture extra reproductive urgency');
  assert.equal(succubus.readinessGate, ordinary.readinessGate,
    'the same trait must not bypass family-readiness appraisal');
  assert.doesNotMatch(JSON.stringify(succubus), /单方|unilateral|魅魔/u,
    'planner-facing reproductive cognition must not contain trait-owned consent language');

  const succubusDescription = traitDefinition('succubus').description;
  assert.match(succubusDescription, /只改变持有者本人的产后生理过程/u);
  assert.match(succubusDescription, /不构成任何人的生殖同意或协议/u);

  process.stdout.write('mutual reproduction semantic tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
