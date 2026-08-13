import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-trace-"));
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

  const seed = Number(process.argv[2] ?? 1);
  const controller = createSimulation({ seed, config: { civilizationNo: 1, startingPoint: "origin", chaosIntensity: 0, climateBias: "balanced", endpoint: { kind: "ticks", value: 60 } } });
  let state = controller.getState();
  const focusIds = state.agents.slice(0, 3).map((a) => a.id);
  const nameOf = (id) => state.agents.find((a) => a.id === id)?.name ?? id;

  while (state.civilization.status === "running" && state.tick < 60) {
    state = controller.step();
    const grainAt = {};
    for (const m of state.world.matter) if (m.traits.includes("edible") && m.holder.kind === "space") grainAt[m.holder.id] = (grainAt[m.holder.id] ?? 0) + m.quantity;
    console.log(`\n— 第${state.tick}年 — 可食库存: ${JSON.stringify(grainAt)}`);
    for (const id of focusIds) {
      const a = state.agents.find((x) => x.id === id);
      if (!a || a.body.state === "dead") { console.log(`  ${nameOf(id)}: 已死亡`); continue; }
      const act = a.limbs.action;
      const actText = act ? (act.type === "move" ? `移动→${act.to}` : act.content) : "（无行动）";
      const heldFood = state.world.matter.filter((m) => m.holder.kind === "agent" && m.holder.id === id && m.traits.includes("edible")).reduce((s, m) => s + m.quantity, 0);
      console.log(`  ${a.name} @${a.locationId} 营养${Math.round(a.body.nutrition)} 水分${Math.round(a.body.hydration)} 健康${Math.round(a.body.health)} 疲劳${Math.round(a.body.fatigue)} 病${a.body.illness ? a.body.illness.severity : "-"} 持粮${heldFood} | ${actText}`);
    }
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
