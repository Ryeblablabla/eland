import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const seeds = [31, 185, 20260816];
const months = 12;
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-factor-forest-sanity-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const outputPath = path.resolve('data/experiments/candidate-decision-factor-forest-v1.json');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { createInitialState, stepSimulation } = await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
  const runs = [];
  for (const seed of seeds) {
    let state = createInitialState(seed, { endpoint: { kind: 'months', value: months }, chaosIntensity: 0 });
    while (state.clock.elapsedMonths < months && state.civilization.status === 'running') state = stepSimulation(state);
    const actions = state.world.past.filter((event) => event.kind === 'action');
    const decisions = state.world.past.filter((event) => event.kind === 'decision');
    const invalidInventories = state.people.flatMap((person) => person.inventory.filter((stack) => stack.quantity < 0));
    runs.push({
      seed,
      elapsedMonths: state.clock.elapsedMonths,
      status: state.civilization.status,
      living: state.people.filter((person) => person.diedAtMonth === undefined).length,
      deaths: state.people.filter((person) => person.diedAtMonth !== undefined).length,
      actions: actions.length,
      idleDecisions: decisions.filter((event) => event.decision.kind === 'idle').length,
      completedProjects: state.projects.filter((project) => project.status === 'completed').length,
      blockedProjects: state.projects.filter((project) => project.status === 'blocked').length,
      protectiveInterruptions: decisions.filter((event) => event.decision.kind === 'revise'
        && ['survival-reflex', 'dependent-care', 'shelter-maintenance'].includes(event.decision.interruptionKind)).length,
      sourceFreeExploreIntents: state.intents.filter((intent) => intent.summary === '走向尚未熟悉的地表'
        && !(intent.sourceFactIds?.length)).length,
      invalidInventoryStacks: invalidInventories.length,
    });
  }
  const report = {
    experiment: 'candidate-decision-factor-forest-v1',
    kind: 'candidate-only-sanity',
    hypothesis: '只读候选编译、逐刻度年龄门禁、可解释因子投票和保护性子中断不会破坏三种子一年短窗的基本因果不变量。',
    seeds,
    months,
    limitations: [
      '没有同工作树旧实现的可执行基线，因此本报告不能支持效果优于旧规则的 A/B 结论。',
      '12 个月只覆盖短期因果与运行健全性，不代表三年、十年或更长文明分布。',
    ],
    runs,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
