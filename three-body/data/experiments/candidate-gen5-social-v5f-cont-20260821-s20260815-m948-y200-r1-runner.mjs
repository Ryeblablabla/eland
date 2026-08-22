import {
  claimEvolutionThrough,
  waitForEvolution,
} from '/Users/wangyu.rye/.codex/skills/iterate-emergent-civilization/scripts/run_matrix.mjs';

const baseUrl = 'http://127.0.0.1:3237';
const plan = {
  runId: 'candidate-gen5-social-v5f-cont-20260821-s20260815-m948-y200-r1',
  months: 2400,
};
const expected = {
  label: 'candidate-gen5-social-v5f-cont-20260821 seed=20260815 from=948 through=2400',
  seed: 20260815,
  civilizationNo: 1,
  chaosIntensity: 0,
  climateBias: 'balanced',
  endpoint: { kind: 'months', value: 2400 },
  fromMonth: 948,
};

const startedAt = new Date().toISOString();
const initialEvolution = await claimEvolutionThrough(baseUrl, plan, expected);
process.stdout.write(`${JSON.stringify({ event: 'claimed', at: startedAt, plan, expected, evolution: initialEvolution })}\n`);

let lastReachedMonth = null;
const evolution = await waitForEvolution({
  baseUrl,
  plan,
  expected,
  pollMs: 2_000,
  initialEvolution,
  onProgress(current) {
    if (current?.reachedMonth === lastReachedMonth) return;
    lastReachedMonth = current?.reachedMonth ?? null;
    process.stdout.write(`${JSON.stringify({
      event: 'progress',
      at: new Date().toISOString(),
      status: current?.status,
      fromMonth: current?.fromMonth,
      reachedMonth: current?.reachedMonth,
      requestedEndMonth: current?.requestedEndMonth,
      checkpoints: current?.checkpoints?.length,
    })}\n`);
  },
});

process.stdout.write(`${JSON.stringify({ event: 'completed', at: new Date().toISOString(), evolution })}\n`);
