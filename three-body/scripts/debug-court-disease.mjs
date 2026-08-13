import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-debug-"));
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
  const controller = createSimulation({ seed, config: { civilizationNo: 1, startingPoint: "origin", chaosIntensity: 0, climateBias: "balanced", endpoint: { kind: "ticks", value: 80 } } });
  let state = controller.getState();
  console.log("开局人物:", state.agents.map((a) => `${a.name}(${a.body.sex === "female" ? "女" : "男"},${a.body.ageYears}岁,健康${Math.round(a.body.health)})`).join(" "));

  const bondActions = [];
  const actionModes = {};
  while (state.civilization.status === "running" && state.tick < 80) {
    state = controller.step();
    for (const event of state.lastStep) {
      if (event.kind !== "action") continue;
      const mode = event.action.type === "interact" ? event.action.intent?.mode ?? "?" : "move";
      actionModes[mode] = (actionModes[mode] ?? 0) + 1;
      if (mode === "bond") {
        bondActions.push({ year: state.tick, who: event.who, gesture: event.action.intent?.gesture, target: event.diff?.partnerId, ok: event.succeeded, conceived: event.diff?.conceived });
      }
    }
  }

  console.log("\n=== bond 行动（court/care/comfort/intimate）===");
  console.log(bondActions.length ? bondActions.map((b) => `y${b.year} ${b.who} -> ${b.target} [${b.gesture}] ${b.ok ? "成功" : "失败"}${b.conceived ? " 受孕!" : ""}`).join("\n") : "（全年无）");

  console.log("\n=== 行动模式分布 ===");
  console.log(JSON.stringify(actionModes));

  console.log("\n=== 终局人物状态 ===");
  for (const a of state.agents) {
    const rel = [...a.relations].sort((x, y) => y.strength - x.strength)[0];
    console.log(`${a.name} 女?${a.body.sex === "female"} 年龄${a.body.ageYears} 状态${a.body.state} 健康${Math.round(a.body.health)} 营养${Math.round(a.body.nutrition)} 病程:${a.body.illness ? `${a.body.illness.course}/严重度${a.body.illness.severity}` : "无"} 最强关系:${rel ? `${rel.agentId}=${Math.round(rel.strength)}` : "无"}`);
  }
  const illnessEvents = state.world.time.past.filter((e) => e.kind === "environment" && e.change === "illness" && e.diff?.onset);
  const courses = illnessEvents.reduce((acc, e) => { acc[e.diff.illnessCourse ?? "?"] = (acc[e.diff.illnessCourse ?? "?"] ?? 0) + 1; return acc; }, {});
  console.log("\n发病次数:", illnessEvents.length, "病程分布:", JSON.stringify(courses));
  console.log("终局年份:", state.tick, "结局:", state.civilization.outcome?.kind ?? "running", "里程碑:", state.derived.milestones.map((m) => m.id).join(","));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
