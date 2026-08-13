import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-move-"));
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

  const controller = createSimulation({ seed: 1, config: { civilizationNo: 1, startingPoint: "origin", chaosIntensity: 0, climateBias: "balanced", endpoint: { kind: "ticks", value: 30 } } });
  let state = controller.getState();
  const lincoln = state.agents[0];
  console.log(`${lincoln.name} 初始: move=${lincoln.limbs.abilities.move} interact=${lincoln.limbs.abilities.interact} @${lincoln.locationId}`);
  while (state.civilization.status === "running" && state.tick < 30) {
    state = controller.step();
    const now = state.agents.find((a) => a.id === lincoln.id);
    if (state.tick <= 6) console.log(`  第${state.tick}年后: move=${now.limbs.abilities.move} interact=${now.limbs.abilities.interact} 年龄=${now.body.ageYears} 状态=${now.body.state} 伤=${JSON.stringify(now.body.injury ?? null)}`);
  }
  const moves = state.world.time.past.filter((e) => e.kind === "action" && e.who === lincoln.id && e.action.type === "move");
  console.log(`\n移动事件 ${moves.length} 次:`);
  for (const m of moves.slice(0, 15)) console.log(`  y${m.tick} -> ${m.action.to} ${m.succeeded ? "成功" : "失败"} | ${m.result}`);
  const final = state.agents.find((a) => a.id === lincoln.id);
  console.log(`\n终局: move=${final.limbs.abilities.move} @${final.locationId} 状态=${final.body.state} 伤病=${JSON.stringify(final.body.injury ?? null)}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
