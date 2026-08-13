import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-postfix-"));
const bundlePath = path.join(temporaryDirectory, "simulation.mjs");

try {
  execFileSync(path.resolve("node_modules/.bin/esbuild"), [
    "src/game/eland/simulation.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
  ], { stdio: "pipe" });
  const mod = await import(`${pathToFileURL(bundlePath).href}?x=${Date.now()}`);

  // 场景 A：默认乱纪元审计（与修改前同一入口）
  const chaotic = mod.auditOriginReachability();
  console.log("=== A. 默认乱纪元审计（chaosIntensity 3, 70 年）===");
  console.log(JSON.stringify({ reached: chaotic.reachedCount, target: chaotic.targetCount, missing: chaotic.missingIds, outcome: chaotic.scenarios[0].outcome?.kind ?? "running", years: chaotic.scenarios[0].simulatedYears }, null, 1));

  // 场景 B：温和恒纪元 3 种子 × 200 年（与修改前相同设置）
  const mild = mod.auditOriginReachability([1, 2, 3].map((seed) => ({
    name: `温和恒纪元 seed=${seed}`,
    seed,
    config: { civilizationNo: 1, chaosIntensity: 0, climateBias: "balanced" },
    maximumYears: 200,
  })));
  console.log("=== B. 温和恒纪元审计（3 种子 × 200 年）===");
  console.log(JSON.stringify({ reached: mild.reachedCount, target: mild.targetCount, missing: mild.missingIds, scenarios: mild.scenarios.map((s) => ({ seed: s.seed, years: s.simulatedYears, outcome: s.outcome?.kind ?? "running", reached: s.reachedIds.length })) }, null, 1));

  // 场景 C：人口细节探查（出生、人口峰值、寿命）
  console.log("=== C. 人口与世代细节 ===");
  for (const seed of [1, 2, 3]) {
    const controller = mod.createSimulation({ seed, config: { civilizationNo: 1, startingPoint: "origin", chaosIntensity: 0, climateBias: "balanced", endpoint: { kind: "ticks", value: 200 } } });
    let state = controller.getState();
    let peak = 0;
    while (state.civilization.status === "running" && state.tick < 200) {
      state = controller.step();
      peak = Math.max(peak, state.agents.filter((a) => a.body.state !== "dead").length);
    }
    const births = state.world.time.past.filter((e) => e.kind === "environment" && e.change === "birth");
    const deaths = state.world.time.past.filter((e) => e.kind === "environment" && e.diff?.bodyState === "dead");
    const causeCount = {};
    for (const d of deaths) causeCount[d.diff.cause ?? "unknown"] = (causeCount[d.diff.cause ?? "unknown"] ?? 0) + 1;
    console.log(JSON.stringify({
      seed,
      years: state.tick,
      status: state.civilization.status,
      outcome: state.civilization.outcome?.kind ?? "running",
      stage: state.civilization.stage,
      living: state.agents.filter((a) => a.body.state !== "dead").length,
      totalAgents: state.agents.length,
      births: births.length,
      generations: [...new Set(state.agents.map((a) => a.lineage?.generation ?? 0))].sort(),
      peakLiving: peak,
      deathCauses: causeCount,
      milestoneCount: state.derived.milestones.length,
      milestones: state.derived.milestones.map((m) => m.id),
    }, null, 1));
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
