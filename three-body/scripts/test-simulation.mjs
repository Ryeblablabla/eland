import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-simulation-test-"));
const bundlePath = path.join(temporaryDirectory, "simulation.mjs");

try {
  execFileSync(path.resolve("node_modules/.bin/esbuild"), [
    "src/game/eland/simulation.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
  ], { stdio: "pipe" });
  const { createSimulation } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const run = (seed, years = 40) => {
    const controller = createSimulation({ seed, config: { startingPoint: "origin", climateBias: "balanced", chaosIntensity: 0, endpoint: { kind: "ticks", value: 60 } } });
    const initialState = controller.getState();
    let state = initialState;
    let shelterYear = null;
    const actions = [];
    for (let year = 0; year < years && state.civilization.status === "running"; year += 1) {
      state = controller.step();
      for (const event of state.lastStep) if (event.kind === "action") actions.push(event);
      if (shelterYear === null && state.world.matter.some((matter) => matter.traits.includes("shelter") && matter.construction?.complete)) shelterYear = state.tick;
    }
    return { initialState, state, shelterYear, actions };
  };

  const runs = Array.from({ length: 30 }, (_, index) => run(index + 1));
  assert.ok(runs.every(({ initialState }) => initialState.agents.filter((agent) => agent.body.ageYears >= 12).length >= 2), "每个原初开局至少应有两名可劳动先民");
  assert.ok(runs.every(({ shelterYear }) => shelterYear !== null && shelterYear <= 30), "30 个基准种子都应在 30 年内完成首座住所");
  assert.ok(runs.filter(({ shelterYear }) => shelterYear <= 15).length >= 18, "至少 60% 的基准种子应在 15 年内完成首座住所");
  assert.equal(runs.flatMap(({ actions }) => actions).filter((event) => event.action.type === "interact" && event.action.intent?.mode === "assemble" && !event.succeeded).length, 0, "住所建设不应选择无法施工的地面");
  assert.ok(runs.every(({ state }) => state.world.matter.filter((matter) => matter.construction?.purpose === "shelter" && !matter.construction.complete).length <= 1), "聚落不应把首座遮蔽结构材料分散到多个工地");
  assert.ok(runs.flatMap(({ actions }) => actions).filter((event) => event.action.type === "interact" && event.action.intent?.mode === "bond" && event.action.intent.gesture === "care").length <= 90, "日常照看不应重新挤占大量年度关键行动");

  // 名字和主观用途不能赋予客观遮蔽能力：一个叫“房屋”的敞开平台仍不是 shelter。
  let falseHouseActorId = "";
  const falseHouseDecider = {
    decide({ state, agent }) {
      const material = state.world.matter.find((matter) => matter.id === "false-house-material" && matter.holder.kind === "agent" && matter.holder.id === agent.id && matter.quantity > 0);
      if (agent.id === falseHouseActorId && material) return {
        action: {
          type: "interact",
          with: { kind: "space", id: agent.locationId },
          content: "把材料接成敞开平台并称它为房屋",
          intent: { mode: "assemble", inputIds: [material.id], siteId: agent.locationId, desiredKind: "house", desiredName: "自称房屋的敞开平台", purpose: "platform", arrangement: { support: 70, cover: 5, boundary: 5, opening: 95 } },
        },
        needLevel: "safety",
        needFocus: "检验结构",
        perception: "材料就在手边",
        choice: "连接材料",
      };
      return { action: { type: "interact", with: { kind: "space", id: agent.locationId }, content: "就地休息", intent: { mode: "rest", siteId: agent.locationId } }, needLevel: "physiological", needFocus: "休息", perception: "没有紧迫工作", choice: "休息" };
    },
  };
  const falseHouseController = createSimulation({ seed: 91, config: { startingPoint: "origin", climateBias: "balanced", chaosIntensity: 0, endpoint: { kind: "ticks", value: 20 } }, decider: falseHouseDecider });
  const falseHouseState = falseHouseController.getState();
  const falseHouseActor = falseHouseState.agents[0];
  falseHouseActorId = falseHouseActor.id;
  falseHouseActor.locationId = "square";
  falseHouseActor.limbs.abilities.build = 100;
  falseHouseState.world.matter.push({ id: "false-house-material", kind: "beam", name: "测试梁材", holder: { kind: "agent", id: falseHouseActor.id }, quantity: 4, unitMass: 1, composition: { wood: 1 }, traits: ["rigid", "building"] });
  falseHouseController.restore(falseHouseState);
  let afterFalseHouse = falseHouseState;
  for (let year = 0; year < 4; year += 1) afterFalseHouse = falseHouseController.step();
  const namedHouse = afterFalseHouse.world.matter.find((matter) => matter.name === "自称房屋的敞开平台");
  assert.ok(namedHouse?.construction?.complete, "反例结构应完成，确保测试的是否决客观属性而不是建设失败");
  assert.equal(namedHouse.traits.includes("shelter"), false, "结构名字含房屋也不能绕过物理效果获得 shelter");

  const careScenarioController = createSimulation({ seed: 17, config: { startingPoint: "origin", climateBias: "balanced", chaosIntensity: 0, endpoint: { kind: "ticks", value: 60 } } });
  const careScenario = careScenarioController.getState();
  const caregiver = careScenario.agents.find((agent) => agent.body.ageYears >= 12);
  const child = careScenario.agents.find((agent) => agent.id !== caregiver?.id);
  assert.ok(caregiver && child, "照料回归场景需要两个人物");
  caregiver.locationId = "homes";
  caregiver.body.homeLocationId = "homes";
  child.locationId = "homes";
  child.lineage = { generation: 1, motherId: caregiver.id };
  child.body.ageYears = 4;
  child.body.health = 50;
  child.body.nutrition = 45;
  child.body.hydration = 42;
  child.body.fatigue = 82;
  caregiver.relations.find((relation) => relation.agentId === child.id).strength = 80;
  careScenarioController.restore(careScenario);
  const afterCare = careScenarioController.step();
  assert.ok(afterCare.lastStep.some((event) => {
    if (event.kind !== "action" || event.who !== caregiver.id || event.action.type !== "interact") return false;
    const intent = event.action.intent;
    return intent?.mode === "bond" && intent.gesture === "care" && intent.toAgentId === child.id ||
      intent?.mode === "inspect-body" && intent.targetAgentId === child.id ||
      intent?.mode === "treat" && intent.toAgentId === child.id ||
      intent?.mode === "apply-material" && intent.targetAgentId === child.id;
  }), "身体明显虚弱的幼儿仍应触发检查、照料或处置");

  const legacy = runs[0].initialState;
  legacy.schemaVersion = 9;
  legacy.agents[0].limbs.abilities.move = 52;
  const migrated = createSimulation({ state: legacy }).getState();
  assert.equal(migrated.schemaVersion, 10, "旧存档应迁移到最新模式");
  assert.ok(migrated.agents[0].limbs.abilities.move >= 60, "旧存档人物应获得可用的基础移动能力");

  const years = runs.map(({ shelterYear }) => shelterYear);
  const mean = years.reduce((sum, year) => sum + year, 0) / years.length;
  console.log(`simulation tests passed: 30/30 shelters, mean ${mean.toFixed(1)} years, ${years.filter((year) => year <= 15).length}/30 by year 15`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
