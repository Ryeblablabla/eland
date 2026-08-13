import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-death-"));
const bundlePath = path.join(temporaryDirectory, "simulation.mjs");

try {
  execFileSync(path.resolve("node_modules/.bin/esbuild"), [
    "src/game/eland/simulation.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
  ], { stdio: "pipe" });
  const { createSimulation } = await import(`${pathToFileURL(bundlePath).href}?x=${Date.now()}`);

  for (const seed of [1, 2, 3]) {
    const controller = createSimulation({ seed, config: { civilizationNo: 1, startingPoint: "origin", chaosIntensity: 0, climateBias: "balanced", endpoint: { kind: "ticks", value: 300 } } });
    let state = controller.getState();
    const deaths = [];
    const seenDead = new Set();
    while (state.civilization.status === "running" && state.tick < 300) {
      state = controller.step();
      for (const agent of state.agents) {
        if (agent.body.state === "dead" && !seenDead.has(agent.id)) {
          seenDead.add(agent.id);
          deaths.push({ year: state.tick, name: agent.name, age: agent.body.ageYears });
        }
      }
    }
    const envDeaths = state.world.time.past.filter((e) => e.kind === "environment" && e.diff?.bodyState === "dead").map((e) => ({ year: e.tick, result: e.result, cause: e.diff?.cause ?? e.change }));
    console.log(JSON.stringify({
      seed,
      finalYear: state.tick,
      status: state.civilization.status,
      outcome: state.civilization.outcome ?? null,
      stage: state.civilization.stage,
      living: state.agents.filter((a) => a.body.state !== "dead").length,
      totalAgents: state.agents.length,
      milestones: state.derived.milestones.map((m) => m.id),
      deathCauses: envDeaths.slice(0, 20),
    }, null, 1));
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
