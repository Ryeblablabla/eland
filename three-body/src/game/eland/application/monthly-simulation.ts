import { CHARACTER_PROFILES, type CharacterProfile } from "../character-profiles";
import {
  createBiologicalSex,
  createFounderAgeMonths,
  createLifespanMonths,
  deterministicFraction,
} from "../population";
import {
  WORLD_CELL_COUNT,
  cellsInRadius,
  cellX,
  cellY,
  copyWorld,
  findPath,
  hydrateWorld,
  isCellId,
  isPassable,
  movementCost,
  nearestCell,
  neighbors4,
} from "../world/grid";
import { generatePixelWorld, seededFraction } from "../world/generator";
import { MONTHS_PER_YEAR } from "../domain/calendar";
import { availableModelContexts, availableModelTokens, rollingDecisionUsage } from "../domain/decision-budget";
import { SHELTER_BLUEPRINT, evaluateStructure } from "../domain/structure-policy";
import type {
  Affordance, AgentDecider, AgentId, AgentPlan, AgentState, BatchDecider,
  ClimateKind, Decision, DecisionContext, DecisionFact, DecisionMonthLedger,
  EmergentRegion, EnvironmentEventInput, EnvironmentFact,
  EpochKind, EvolutionReport, MaslowNeedLevel, MaslowPersonality,
  MatterState, MatterTrait, MilestoneObservation, NeedLayer, PlanDecision,
  PlanProgressFact, PracticeObservation, SimulationConfig, SimulationState, SpatialTarget,
  StructureComponent, StructureState, TokenUsage, WorldEvent,
} from "../domain/model";

export * from "../domain/model";

const NEED_LABELS: Record<MaslowNeedLevel, string> = {
  physiological: "生理需求",
  safety: "安全需求",
  belonging: "归属与爱",
  esteem: "尊重需求",
  selfActualization: "自我实现",
};

const PERSONALITY_WORDS: Record<MaslowNeedLevel, string[]> = {
  physiological: ["食物", "水", "身体", "健康", "休息", "生存", "劳作", "务实"],
  safety: ["安全", "稳定", "秩序", "谨慎", "克制", "保存", "周到"],
  belonging: ["同伴", "群体", "亲近", "家庭", "互助", "分享", "照料", "陪伴"],
  esteem: ["认可", "尊重", "责任", "带领", "组织", "贡献", "果断"],
  selfActualization: ["好奇", "创造", "探索", "理解", "观察", "推理", "记录", "表达"],
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function copyState(input: SimulationState): SimulationState {
  const copy = structuredClone(input);
  copy.world.grid = copyWorld(input.world.grid);
  return copy;
}

function inferPersonality(description: string): MaslowPersonality {
  const levels = Object.keys(NEED_LABELS) as MaslowNeedLevel[];
  const layers = levels.map((level) => {
    const evidence = PERSONALITY_WORDS[level].filter((word) => description.includes(word));
    return { level, label: NEED_LABELS[level], baselineWeight: clamp(28 + evidence.length * 9, 28, 82), evidence };
  });
  const dominant = [...layers].sort((a, b) => b.baselineWeight - a.baselineWeight)[0];
  return {
    dominantLevel: dominant.level,
    summary: `${dominant.label}是长期人格底色，迫切的低层缺口仍可改变当月选择。`,
    layers,
  };
}

function chooseProfiles(seed: number, civilizationNo: number, characterIds?: string[]): CharacterProfile[] {
  if (characterIds?.length) {
    const wanted = new Set(characterIds);
    const chosen = CHARACTER_PROFILES.filter((profile) => wanted.has(profile.id));
    if (chosen.length) return chosen.slice(0, 10);
  }
  return [...CHARACTER_PROFILES]
    .sort((a, b) => deterministicFraction(seed + civilizationNo * 991, `profile:${a.id}`) - deterministicFraction(seed + civilizationNo * 991, `profile:${b.id}`))
    .slice(0, 5 + Math.floor(deterministicFraction(seed, `population:${civilizationNo}`) * 4));
}

export function createDefaultSimulationConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    civilizationNo: Math.max(1, Math.round(overrides.civilizationNo ?? 1)),
    climateBias: overrides.climateBias === "cold" || overrides.climateBias === "hot" ? overrides.climateBias : "balanced",
    chaosIntensity: clamp(Math.round(overrides.chaosIntensity ?? 0), 0, 10),
    endpoint: {
      kind: overrides.endpoint?.kind === "milestones" ? "milestones" : "months",
      value: Math.max(1, Math.round(overrides.endpoint?.value ?? 1200)),
    },
    ...(overrides.characterIds?.length ? { characterIds: [...new Set(overrides.characterIds)].slice(0, 10) } : {}),
  };
}

function baseMatter(
  id: string,
  kind: string,
  name: string,
  holder: MatterState["holder"],
  quantity: number,
  unitMass: number,
  composition: Record<string, number>,
  traits: MatterTrait[],
): MatterState {
  return { id, kind, name, holder, quantity, unitMass, composition, traits, sourceEventIds: [] };
}

function initialAgent(seed: number, profile: CharacterProfile, spawnCell: number, allProfiles: CharacterProfile[]): AgentState {
  const personality = inferPersonality(profile.description);
  const founderAgeMonths = createFounderAgeMonths(seed, profile.id);
  const abilities = {
    move: 48 + Math.floor(deterministicFraction(seed, `move:${profile.id}`) * 35),
    interact: 45 + Math.floor(deterministicFraction(seed, `interact:${profile.id}`) * 35),
    craft: 40 + Math.floor(deterministicFraction(seed, `craft:${profile.id}`) * 42),
    build: 42 + Math.floor(deterministicFraction(seed, `build:${profile.id}`) * 40),
    observe: 42 + Math.floor(deterministicFraction(seed, `observe:${profile.id}`) * 40),
    reason: 42 + Math.floor(deterministicFraction(seed, `reason:${profile.id}`) * 40),
  };
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    profile: { description: profile.description, personality },
    position: { cellId: spawnCell, previousCellId: spawnCell, lastPath: [spawnCell] },
    suspendedPlanIds: [],
    mind: {
      needs: { focus: "观察眼前并维持身体", intensity: 30, dominantLevel: "physiological", layers: [] },
      cognition: {
        perception: "我只知道眼前所见",
        choice: "先观察周围",
        interpretation: "世界刚刚开始",
        knownCells: [spawnCell],
        rememberedTargets: [],
        memory: [],
      },
    },
    limbs: { actionText: "观察周围", abilities },
    relations: allProfiles.filter((other) => other.id !== profile.id).map((other) => ({
      agentId: other.id,
      strength: 18 + Math.floor(deterministicFraction(seed, `relation:${profile.id}:${other.id}`) * 24),
      word: "尚在形成",
      sourceEventIds: [],
    })),
    lineage: { generation: 0 },
    standing: { respect: 40, correctPredictions: 0, failedPredictions: 0, careTrust: 0 },
    body: {
      state: "active",
      hydration: 82,
      nutrition: 78,
      health: 92,
      fatigue: 18,
      temperature: 50,
      ageMonths: founderAgeMonths,
      sex: createBiologicalSex(seed, profile.id),
      lifespanMonths: createLifespanMonths(seed, profile.id, founderAgeMonths),
    },
  };
}

export function createInitialState(seed = 17, inputConfig: Partial<SimulationConfig> = {}): SimulationState {
  const config = createDefaultSimulationConfig(inputConfig);
  const generated = generatePixelWorld(seed);
  const profiles = chooseProfiles(seed, config.civilizationNo, config.characterIds);
  const agents = profiles.map((profile, index) => initialAgent(seed + config.civilizationNo * 997, profile, generated.spawnCells[index] ?? generated.spawnCells[0], profiles));
  const matter: MatterState[] = generated.resources.map((resource) => baseMatter(
    resource.id,
    resource.kind,
    resource.name,
    { kind: "cell", cellId: resource.cellId },
    resource.quantity,
    resource.unitMass,
    resource.composition,
    resource.traits as MatterTrait[],
  ));
  for (const agent of agents) {
    matter.push(baseMatter(`ration-${agent.id}`, "berries", "随身野果", { kind: "agent", agentId: agent.id }, 2, 0.2, { biomass: 1 }, ["raw", "edible", "botanical"]));
  }
  const state: SimulationState = {
    schemaVersion: 11,
    seed,
    branchId: `root-${seed}-${config.civilizationNo}`,
    clock: { unit: "month", elapsedMonths: 0, monthsPerYear: MONTHS_PER_YEAR },
    world: { grid: generated.world, matter, structures: [], components: [], past: [] },
    agents,
    plans: [],
    civilization: {
      number: config.civilizationNo,
      status: "running",
      stage: "自然群体",
      epoch: "stable",
      climate: { kind: "temperate", severity: 1, sinceMonth: 0 },
      conditions: config,
      integrity: 100,
    },
    decisionBudget: { credits: 0, tokensPerContext: 8_000, ledgers: [] },
    derived: { practices: [], institutions: [], milestones: [], regions: [] },
    lastStep: [],
  };
  refreshNeeds(state);
  return state;
}

function carried(state: SimulationState, agentId: AgentId): MatterState[] {
  return state.world.matter.filter((matter) => matter.quantity > 0 && matter.holder.kind === "agent" && matter.holder.agentId === agentId);
}

function visibleRadius(agent: AgentState): number {
  return 5 + Math.floor(agent.limbs.abilities.observe / 18);
}

function visibleCellsFor(_state: SimulationState, agent: AgentState): number[] {
  return cellsInRadius(agent.position.cellId, visibleRadius(agent));
}

function refreshKnownWorld(state: SimulationState, agent: AgentState, visibleCells: number[]): void {
  agent.mind.cognition.knownCells = [...new Set([...agent.mind.cognition.knownCells, ...visibleCells])].slice(-900);
  for (const matter of state.world.matter) {
    if (matter.holder.kind !== "cell" || !visibleCells.includes(matter.holder.cellId) || matter.quantity <= 0) continue;
    const previous = agent.mind.cognition.rememberedTargets.find((target) => target.kind === "matter" && target.id === matter.id);
    if (previous) {
      previous.cellId = matter.holder.cellId;
      previous.lastSeenAtMonth = state.clock.elapsedMonths;
    } else {
      agent.mind.cognition.rememberedTargets.push({
        kind: "matter",
        id: matter.id,
        cellId: matter.holder.cellId,
        sourceEventIds: matter.sourceEventIds.slice(-4),
        lastSeenAtMonth: state.clock.elapsedMonths,
      });
    }
  }
  agent.mind.cognition.rememberedTargets = agent.mind.cognition.rememberedTargets.slice(-80);
}

function structureAtInterior(state: SimulationState, targetCellId: number): StructureState | undefined {
  return state.world.structures.find((structure) => structure.interiorCells.includes(targetCellId) && structure.effects.accessible);
}

function buildAffordances(state: SimulationState, agent: AgentState): Affordance[] {
  const visibleCells = visibleCellsFor(state, agent);
  refreshKnownWorld(state, agent, visibleCells);
  const visibleMatter = state.world.matter.filter((matter) => matter.holder.kind === "cell" && visibleCells.includes(matter.holder.cellId) && matter.quantity > 0);
  const held = carried(state, agent.id);
  const affordances: Affordance[] = [];

  for (const matter of visibleMatter) {
    if (matter.traits.includes("edible")) affordances.push({
      id: `gather:${matter.id}`,
      planMode: "gather",
      target: { kind: "matter", matterId: matter.id, cellId: matter.holder.kind === "cell" ? matter.holder.cellId : agent.position.cellId },
      requiredRange: 0,
      visibleReason: `看见可以采集的${matter.name}`,
      estimatedDurationBand: matter.holder.kind === "cell" && matter.holder.cellId === agent.position.cellId ? "one-month" : "several-months",
      sourceFactIds: matter.sourceEventIds,
    });
    if (matter.kind === "wood") affordances.push({
      id: `gather:${matter.id}`,
      planMode: "gather",
      target: { kind: "matter", matterId: matter.id, cellId: matter.holder.kind === "cell" ? matter.holder.cellId : agent.position.cellId },
      requiredRange: 0,
      visibleReason: "看见可以搬运和连接的木材",
      estimatedDurationBand: "several-months",
      sourceFactIds: matter.sourceEventIds,
    });
  }

  for (const id of visibleCells) {
    if (state.world.grid.cells.waterDepth[id] >= 40) affordances.push({
      id: `water:${id}`,
      planMode: "travel",
      target: { kind: "cell", cellId: id },
      requiredRange: 1,
      visibleReason: "看见可以接近的地表水",
      estimatedDurationBand: id === agent.position.cellId ? "one-month" : "several-months",
      sourceFactIds: [],
    });
  }

  const heldFood = held.find((matter) => matter.traits.includes("edible"));
  if (heldFood) affordances.push({
    id: `eat:${heldFood.id}`,
    planMode: "recover",
    target: { kind: "matter", matterId: heldFood.id, cellId: agent.position.cellId },
    requiredRange: 0,
    visibleReason: `携带着${heldFood.name}`,
    estimatedDurationBand: "one-month",
    sourceFactIds: heldFood.sourceEventIds,
  });

  const heldWood = held.reduce((sum, matter) => sum + (matter.kind === "wood" ? matter.quantity : 0), 0);
  if (heldWood > 0) {
    const unfinished = state.world.structures
      .filter((structure) => !structure.effects.accessible && structure.occupiedCells.some((id) => visibleCells.includes(id)))
      .sort((a, b) => (a.occupiedCells[0] ?? 0) - (b.occupiedCells[0] ?? 0))[0];
    const nearbyBuilders = state.agents
      .filter((other) => other.body.state !== "dead" && visibleCells.includes(other.position.cellId))
      .filter((other) => carried(state, other.id).some((matter) => matter.kind === "wood" && matter.quantity > 0))
      .map((other) => other.id)
      .sort();
    const mayOpenConstruction = Boolean(unfinished) || nearbyBuilders[0] === agent.id;
    const buildCell = unfinished?.occupiedCells[0]
      ?? nearestCell(agent.position.cellId, [agent.position.cellId, ...neighbors4(agent.position.cellId)].filter((id) => isPassable(state.world.grid, id)))
      ?? agent.position.cellId;
    if (mayOpenConstruction) affordances.push({
      id: `build:${buildCell}`,
      planMode: "build",
      target: unfinished
        ? { kind: "structure", structureId: unfinished.id, cellId: buildCell }
        : { kind: "cell", cellId: buildCell },
      requiredRange: 0,
      visibleReason: unfinished
        ? `携带 ${heldWood} 份木材，可以继续未完成的遮蔽结构`
        : `携带 ${heldWood} 份木材，可以连接成遮蔽结构`,
      estimatedDurationBand: "long",
      sourceFactIds: held.flatMap((matter) => matter.sourceEventIds),
    });
  }

  const shelter = structureAtInterior(state, agent.position.cellId);
  affordances.push({
    id: `rest:${agent.position.cellId}`,
    planMode: "recover",
    target: shelter
      ? { kind: "structure", structureId: shelter.id, cellId: agent.position.cellId }
      : { kind: "cell", cellId: agent.position.cellId },
    requiredRange: 0,
    visibleReason: shelter ? `${shelter.name ?? "这座结构"}内部可以休息` : "可以在当前地面暂时休息",
    estimatedDurationBand: "one-month",
    sourceFactIds: shelter?.sourceEventIds ?? [],
  });

  return [...new Map(affordances.map((affordance) => [affordance.id, affordance])).values()];
}

function activePlan(state: SimulationState, agent: AgentState): AgentPlan | undefined {
  return agent.activePlanId ? state.plans.find((plan) => plan.id === agent.activePlanId && plan.status === "active") : undefined;
}

function contextFor(state: SimulationState, agent: AgentState): DecisionContext {
  const visibleCells = visibleCellsFor(state, agent);
  const visibleSet = new Set(visibleCells);
  return {
    state: copyState(state),
    agent: structuredClone(agent),
    visibleCells,
    visibleAgents: state.agents.filter((other) => other.id !== agent.id && other.body.state !== "dead" && visibleSet.has(other.position.cellId)).map((other) => structuredClone(other)),
    visibleMatter: state.world.matter.filter((matter) => matter.holder.kind === "cell" && visibleSet.has(matter.holder.cellId) && matter.quantity > 0).map((matter) => structuredClone(matter)),
    affordances: structuredClone(buildAffordances(state, agent)),
    activePlan: structuredClone(activePlan(state, agent)),
  };
}

export function buildDecisionContexts(state: SimulationState): DecisionContext[] {
  return state.agents.filter((agent) => agent.body.state !== "dead").map((agent) => contextFor(state, agent));
}

function chooseAffordance(context: DecisionContext): Affordance | undefined {
  const { agent, affordances } = context;
  const heldWood = carried(context.state, agent.id).reduce((sum, matter) => sum + (matter.kind === "wood" ? matter.quantity : 0), 0);
  const water = affordances.filter((item) => item.id.startsWith("water:")).sort((a, b) => {
    const distance = (cellId: number) => Math.abs(cellX(cellId) - cellX(agent.position.cellId)) + Math.abs(cellY(cellId) - cellY(agent.position.cellId));
    return distance(a.target.cellId) - distance(b.target.cellId) || a.target.cellId - b.target.cellId;
  })[0];
  const edible = affordances.find((item) => item.id.startsWith("eat:"));
  const gatherFood = affordances.find((item) => item.id.startsWith("gather:") && context.visibleMatter.some((matter) => matter.id === (item.target.kind === "matter" ? item.target.matterId : "") && matter.traits.includes("edible")));
  const gatherWood = affordances.find((item) => {
    if (!item.id.startsWith("gather:") || item.target.kind !== "matter") return false;
    const matterId = item.target.matterId;
    return context.visibleMatter.some((matter) => matter.id === matterId && matter.kind === "wood");
  });
  const build = affordances.find((item) => item.id.startsWith("build:"));
  const rest = affordances.find((item) => item.id.startsWith("rest:"));
  if (agent.body.hydration < 60 && water) return water;
  if (agent.body.nutrition < 68 && edible) return edible;
  if (agent.body.nutrition < 72 && gatherFood) return gatherFood;
  if (agent.body.fatigue > 72 && rest) return rest;
  if (heldWood >= 2 && build) return build;
  if (gatherWood) return gatherWood;
  return gatherFood ?? water ?? rest;
}

export class MockDecider implements AgentDecider {
  decide(context: DecisionContext): Decision {
    if (context.activePlan && context.activePlan.status === "active") {
      if (context.agent.body.hydration < 35 && context.activePlan.mode !== "travel") {
        const water = context.affordances.find((item) => item.id.startsWith("water:"));
        if (water) return { kind: "revise", planId: context.activePlan.id, affordanceId: water.id, reason: "身体缺水已经压过原计划" };
      }
      return { kind: "continue", planId: context.activePlan.id, reason: "眼前计划仍能推进" };
    }
    const chosen = chooseAffordance(context);
    if (chosen) return { kind: "start", affordanceId: chosen.id, reason: chosen.visibleReason };
    const direction = (["n", "e", "s", "w"] as const)[Math.floor(seededFraction(context.state.seed, `explore:${context.state.branchId}:${context.state.clock.elapsedMonths}:${context.agent.id}`) * 4)];
    return { kind: "start", exploration: { direction, distanceBand: "near" }, reason: "眼前没有已知手段，向未知处探索" };
  }
}

function decisionProbability(state: SimulationState, agent: AgentState): { probability: number; reasons: string[] } {
  const plan = activePlan(state, agent);
  const reasons: string[] = [];
  let probability = 0.015;
  if (!plan) { probability += 0.72; reasons.push("当前没有活动计划"); }
  if (plan?.status === "blocked") { probability += 0.55; reasons.push("计划受阻"); }
  if (plan && state.clock.elapsedMonths - plan.lastProgressAtMonth >= 2) { probability += 0.35; reasons.push("计划连续没有进展"); }
  if (agent.body.hydration < 45) { probability += 0.65; reasons.push("身体严重缺水"); }
  if (agent.body.nutrition < 45) { probability += 0.55; reasons.push("身体严重缺粮"); }
  if (agent.body.health < 55) { probability += 0.45; reasons.push("健康明显下降"); }
  if (agent.body.fatigue > 82) { probability += 0.4; reasons.push("疲劳难以继续"); }
  if (plan && plan.status === "active" && state.clock.elapsedMonths === plan.lastProgressAtMonth) probability -= 0.01;
  return { probability: clamp(probability, 0.01, 1), reasons: reasons.length ? reasons : ["当月重新考虑的微小可能"] };
}

function exploreTarget(state: SimulationState, agent: AgentState, exploration: NonNullable<Extract<PlanDecision, { kind: "start" }>["exploration"]>): number {
  const distance = exploration.distanceBand === "far" ? 14 : 8;
  const delta = exploration.direction === "n" ? -state.world.grid.width * distance
    : exploration.direction === "s" ? state.world.grid.width * distance
      : exploration.direction === "e" ? distance : -distance;
  let candidate = clamp(agent.position.cellId + delta, 0, WORLD_CELL_COUNT - 1);
  if (!isPassable(state.world.grid, candidate)) {
    candidate = nearestCell(candidate, cellsInRadius(candidate, 5).filter((id) => isPassable(state.world.grid, id))) ?? agent.position.cellId;
  }
  return candidate;
}

function createPlan(state: SimulationState, agent: AgentState, decision: Extract<Decision, { kind: "start" | "revise" }>, decisionEventId: string, affordances: Affordance[]): AgentPlan | null {
  const affordance = "affordanceId" in decision && decision.affordanceId ? affordances.find((item) => item.id === decision.affordanceId) : undefined;
  const target: SpatialTarget = affordance?.target ?? ("exploration" in decision && decision.exploration
    ? { kind: "cell", cellId: exploreTarget(state, agent, decision.exploration) }
    : { kind: "cell", cellId: agent.position.cellId });
  const mode = affordance?.planMode ?? "explore";
  const id = `plan-${state.clock.elapsedMonths + 1}-${agent.id}-${state.plans.length}`;
  const existingStructure = target.kind === "structure"
    ? state.world.structures.find((structure) => structure.id === target.structureId)
    : undefined;
  const availableMatter = target.kind === "matter"
    ? state.world.matter.find((matter) => matter.id === target.matterId)
    : undefined;
  const workRemaining = mode === "gather"
    ? Math.min(2, availableMatter?.quantity ?? 1)
    : mode === "build"
      ? Math.max(1, SHELTER_BLUEPRINT.length - (existingStructure?.componentIds.length ?? 0))
      : 1;
  const plan: AgentPlan = {
    id,
    ownerId: agent.id,
    objective: affordance?.visibleReason ?? "探索未知地表",
    mode,
    target,
    status: "active",
    createdAtMonth: state.clock.elapsedMonths + 1,
    lastProgressAtMonth: state.clock.elapsedMonths,
    progress: 0,
    workRemaining,
    requestedQuantity: mode === "gather" ? workRemaining : undefined,
    acquiredQuantity: mode === "gather" ? 0 : undefined,
    path: [],
    pathCursor: 0,
    sourceDecisionEventId: decisionEventId,
    progressEventIds: [],
  };
  if (existingStructure) plan.structureId = existingStructure.id;
  return plan;
}

function applyDecision(
  state: SimulationState,
  agent: AgentState,
  context: DecisionContext,
  decision: Decision,
  usedModel: boolean,
  order: number,
): DecisionFact {
  const atMonth = state.clock.elapsedMonths + 1;
  const id = `d-${atMonth}-${agent.id}`;
  let planId: string | undefined;
  let result = `${agent.name}决定暂时观察`;
  const current = activePlan(state, agent);
  if (decision.kind === "start" || decision.kind === "revise") {
    if (current) current.status = "abandoned";
    const plan = createPlan(state, agent, decision, id, context.affordances);
    if (plan) {
      state.plans.push(plan);
      agent.activePlanId = plan.id;
      planId = plan.id;
      result = `${agent.name}决定${plan.objective}`;
    }
  } else if (decision.kind === "continue" && current?.id === decision.planId) {
    planId = current.id;
    result = `${agent.name}决定继续：${current.objective}`;
  } else if (decision.kind === "suspend" && current?.id === decision.planId) {
    current.status = "suspended";
    agent.suspendedPlanIds = [...new Set([...agent.suspendedPlanIds, current.id])];
    delete agent.activePlanId;
    planId = current.id;
    result = `${agent.name}暂时挂起：${current.objective}`;
  } else if (decision.kind === "resume") {
    const plan = state.plans.find((item) => item.id === decision.planId && item.ownerId === agent.id && item.status === "suspended");
    if (plan) {
      plan.status = "active";
      agent.activePlanId = plan.id;
      agent.suspendedPlanIds = agent.suspendedPlanIds.filter((idValue) => idValue !== plan.id);
      planId = plan.id;
      result = `${agent.name}重新开始：${plan.objective}`;
    }
  } else if (decision.kind === "abandon" && current?.id === decision.planId) {
    current.status = "abandoned";
    delete agent.activePlanId;
    planId = current.id;
    result = `${agent.name}放弃：${current.objective}`;
  }
  agent.mind.cognition.choice = decision.reason;
  agent.limbs.actionText = result.replace(`${agent.name}`, "");
  return { id, kind: "decision", atMonth, orderInMonth: order, who: agent.id, cellId: agent.position.cellId, decision, planId, usedModel, result };
}

function monthlyBudget(agent: AgentState): number {
  const health = 0.35 + agent.body.health / 150;
  const hydration = 0.35 + agent.body.hydration / 150;
  const nutrition = 0.4 + agent.body.nutrition / 170;
  const fatigue = 1 - agent.body.fatigue / 150;
  return Math.max(3, Math.floor((4 + agent.limbs.abilities.move / 7) * health * hydration * nutrition * fatigue));
}

function targetCell(plan: AgentPlan): number {
  return plan.target.cellId;
}

function advanceAlongPath(state: SimulationState, agent: AgentState, plan: AgentPlan, budget: number): { spent: number; pathSegment: number[]; reached: boolean } {
  const target = targetCell(plan);
  const goal = isPassable(state.world.grid, target)
    ? target
    : nearestCell(agent.position.cellId, neighbors4(target).filter((id) => isPassable(state.world.grid, id))) ?? target;
  if (!plan.path.length || plan.path[plan.pathCursor] !== agent.position.cellId || plan.path.at(-1) !== goal) {
    plan.path = findPath(state.world.grid, agent.position.cellId, goal);
    plan.pathCursor = 0;
  }
  if (!plan.path.length) return { spent: 0, pathSegment: [agent.position.cellId], reached: false };
  const segment = [agent.position.cellId];
  let spent = 0;
  while (plan.pathCursor + 1 < plan.path.length) {
    const next = plan.path[plan.pathCursor + 1];
    const cost = movementCost(state.world.grid, agent.position.cellId, next);
    // 月是很长的尺度；健康仍允许行动的人至少能跨过一个相邻可通行格。
    if (spent > 0 && spent + cost > budget) break;
    agent.position.previousCellId = agent.position.cellId;
    agent.position.cellId = next;
    agent.position.lastPath = [...segment, next];
    state.world.grid.traces.traffic[next] = Math.min(65535, state.world.grid.traces.traffic[next] + 1);
    plan.pathCursor += 1;
    spent += cost;
    segment.push(next);
  }
  return { spent, pathSegment: segment, reached: agent.position.cellId === goal };
}

function removeMatter(state: SimulationState, matter: MatterState, quantity: number): MatterState {
  const taken = structuredClone(matter);
  taken.quantity = Math.min(quantity, matter.quantity);
  matter.quantity -= taken.quantity;
  state.world.matter = state.world.matter.filter((item) => item.quantity > 0);
  return taken;
}

function mergeCarried(state: SimulationState, agentId: AgentId, portion: MatterState, eventId: string): void {
  const existing = state.world.matter.find((matter) =>
    matter.holder.kind === "agent" &&
    matter.holder.agentId === agentId &&
    matter.kind === portion.kind &&
    matter.traits.join("|") === portion.traits.join("|"));
  if (existing) {
    existing.quantity += portion.quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...portion.sourceEventIds, eventId])];
  } else {
    state.world.matter.push({
      ...portion,
      id: `${portion.kind}-${agentId}-${eventId}`,
      holder: { kind: "agent", agentId },
      sourceEventIds: [...new Set([...portion.sourceEventIds, eventId])],
    });
  }
}

function componentCell(baseCell: number, dx: number, dy: number, width: number): number {
  const x = clamp(cellX(baseCell) + dx, 0, width - 1);
  const y = clamp(cellY(baseCell) + dy, 0, 51);
  return y * width + x;
}

function recomputeStructure(state: SimulationState, structure: StructureState): void {
  const components = state.world.components.filter((component) => component.structureId === structure.id && component.integrity > 0);
  const evaluation = evaluateStructure(components);
  structure.componentIds = components.map((component) => component.id);
  structure.occupiedCells = evaluation.occupiedCells;
  structure.interiorCells = evaluation.interiorCells;
  structure.effects = evaluation.effects;
}

function placeNextComponent(state: SimulationState, agent: AgentState, plan: AgentPlan, eventId: string): { worked: boolean; message: string } {
  const existing = plan.structureId ? state.world.structures.find((structure) => structure.id === plan.structureId) : undefined;
  const structure: StructureState = existing ?? {
    id: `structure-${plan.id}`,
    name: "未命名遮蔽结构",
    builderIds: [agent.id],
    componentIds: [],
    occupiedCells: [],
    interiorCells: [],
    effects: { structuralStability: 0, weatherProtection: 0, thermalInsulation: 0, enclosure: 0, capacity: 0, accessible: false },
    useEventIds: [],
    sourceEventIds: [plan.sourceDecisionEventId],
  };
  if (!existing) {
    state.world.structures.push(structure);
    plan.structureId = structure.id;
  }
  const sequenceIndex = state.world.components.filter((component) => component.structureId === structure.id).length;
  if (sequenceIndex >= SHELTER_BLUEPRINT.length) return { worked: false, message: "结构已经完成" };
  const wood = carried(state, agent.id).find((matter) => matter.kind === "wood" && matter.quantity > 0);
  if (!wood) return { worked: false, message: "缺少继续施工的木材" };
  const spec = SHELTER_BLUEPRINT[sequenceIndex];
  const cellId = componentCell(targetCell(plan), spec.dx, spec.dy, state.world.grid.width);
  if (!isPassable(state.world.grid, cellId)) return { worked: false, message: "目标格无法放置构件" };
  const portion = removeMatter(state, wood, 1);
  const component: StructureComponent = {
    id: `component-${eventId}-${sequenceIndex}`,
    structureId: structure.id,
    kind: spec.kind,
    cellId,
    materialKinds: Object.keys(portion.composition),
    integrity: 100,
    sourceEventIds: [...portion.sourceEventIds, eventId],
  };
  state.world.components.push(component);
  structure.sourceEventIds.push(eventId);
  structure.builderIds = [...new Set([...structure.builderIds, agent.id])];
  recomputeStructure(state, structure);
  return { worked: true, message: `放置了${spec.kind}构件` };
}

function executePlan(state: SimulationState, agent: AgentState, plan: AgentPlan, order: number): PlanProgressFact {
  const atMonth = state.clock.elapsedMonths + 1;
  const id = `p-${atMonth}-${agent.id}`;
  const fromCellId = agent.position.cellId;
  const before = plan.progress;
  let result = "";
  let status: PlanProgressFact["status"] = "progressed";
  let pathSegment = [fromCellId];
  let acquiredKind = "";
  let acquiredTraits: MatterTrait[] = [];
  const budget = monthlyBudget(agent);
  const movement = advanceAlongPath(state, agent, plan, budget);
  pathSegment = movement.pathSegment;
  let interactionWorked = false;

  if (!movement.reached) {
    if (movement.spent === 0) {
      status = "blocked";
      plan.blockedReason = "没有可通行路径或当月预算不足";
      result = `${agent.name}前往目标的计划受阻`;
    } else {
      plan.progress = clamp(plan.progress + 2);
      plan.lastProgressAtMonth = atMonth;
      result = `${agent.name}沿真实地表向目标移动了 ${pathSegment.length - 1} 格`;
    }
  } else if (plan.mode === "gather" && plan.target.kind === "matter") {
    const matterId = plan.target.matterId;
    const matter = state.world.matter.find((item) => item.id === matterId && item.holder.kind === "cell" && item.holder.cellId === agent.position.cellId);
    if (!matter) {
      status = "blocked";
      plan.blockedReason = "记忆中的资源已经不存在";
      result = `${agent.name}抵达后发现目标资源已经不存在`;
    } else {
      const portion = removeMatter(state, matter, 1);
      acquiredKind = portion.kind;
      acquiredTraits = portion.traits;
      mergeCarried(state, agent.id, portion, id);
      state.world.grid.traces.gathering[agent.position.cellId] = Math.min(65535, state.world.grid.traces.gathering[agent.position.cellId] + 1);
      plan.acquiredQuantity = (plan.acquiredQuantity ?? 0) + portion.quantity;
      plan.workRemaining = Math.max(0, plan.workRemaining - portion.quantity);
      plan.progress = clamp(((plan.acquiredQuantity ?? 0) / Math.max(1, plan.requestedQuantity ?? 1)) * 100);
      plan.lastProgressAtMonth = atMonth;
      interactionWorked = true;
      result = `${agent.name}在第 ${atMonth} 月取得一份${portion.name}`;
    }
  } else if (plan.mode === "travel" && plan.target.kind === "cell" && state.world.grid.cells.waterDepth[plan.target.cellId] >= 40) {
    const adjacent = agent.position.cellId === plan.target.cellId || neighbors4(agent.position.cellId).includes(plan.target.cellId);
    if (adjacent) {
      agent.body.hydration = clamp(agent.body.hydration + 55);
      plan.workRemaining = 0;
      plan.progress = 100;
      plan.lastProgressAtMonth = atMonth;
      interactionWorked = true;
      result = `${agent.name}抵达水边并补充了身体水分`;
    }
  } else if (plan.mode === "recover") {
    if (plan.target.kind === "matter") {
      const matterId = plan.target.matterId;
      const food = carried(state, agent.id).find((matter) => matter.id === matterId && matter.traits.includes("edible"));
      if (food) {
        removeMatter(state, food, 1);
        agent.body.nutrition = clamp(agent.body.nutrition + 40);
        interactionWorked = true;
        result = `${agent.name}吃了一份${food.name}`;
      } else result = `${agent.name}没有找到原本携带的食物`;
    } else {
      const shelter = structureAtInterior(state, agent.position.cellId);
      const protectedRest = Boolean(shelter && shelter.effects.weatherProtection >= 58);
      agent.body.fatigue = clamp(agent.body.fatigue - (protectedRest ? 45 : 28));
      agent.body.health = clamp(agent.body.health + (protectedRest ? 4 : 1));
      state.world.grid.traces.rest[agent.position.cellId] = Math.min(65535, state.world.grid.traces.rest[agent.position.cellId] + 1);
      if (shelter) shelter.useEventIds.push(id);
      interactionWorked = true;
      result = `${agent.name}${protectedRest ? `在${shelter?.name ?? "结构"}内部` : "就地"}休息了一个月`;
    }
    plan.workRemaining = 0;
    plan.progress = 100;
    plan.lastProgressAtMonth = atMonth;
  } else if (plan.mode === "build") {
    const built = placeNextComponent(state, agent, plan, id);
    if (built.worked) {
      plan.workRemaining = Math.max(0, plan.workRemaining - 1);
      const builtCount = SHELTER_BLUEPRINT.length - plan.workRemaining;
      plan.progress = clamp(builtCount / SHELTER_BLUEPRINT.length * 100);
      plan.lastProgressAtMonth = atMonth;
      interactionWorked = true;
      result = `${agent.name}${built.message}，结构进度达到 ${Math.round(plan.progress)}%`;
    } else {
      status = "blocked";
      plan.blockedReason = built.message;
      result = `${agent.name}的建造计划受阻：${built.message}`;
    }
  } else if (plan.mode === "explore" || plan.mode === "travel" || plan.mode === "carry") {
    plan.workRemaining = 0;
    plan.progress = 100;
    plan.lastProgressAtMonth = atMonth;
    interactionWorked = true;
    result = `${agent.name}抵达了此前未知的格子`;
  }

  const complete = interactionWorked && plan.workRemaining <= 0;
  if (complete) {
    status = "completed";
    plan.status = "completed";
    plan.progress = 100;
    delete agent.activePlanId;
  } else if (status === "blocked") {
    plan.status = "blocked";
  }
  plan.progressEventIds.push(id);
  agent.position.lastPath = pathSegment;
  agent.limbs.actionText = result.replace(`${agent.name}`, "");
  agent.body.fatigue = clamp(agent.body.fatigue + Math.max(1, Math.round(movement.spent / 3)) + (interactionWorked ? 4 : 0));
  return {
    id,
    kind: "plan-progress",
    atMonth,
    orderInMonth: order,
    who: agent.id,
    cellId: agent.position.cellId,
    planId: plan.id,
    fromCellId,
    toCellId: agent.position.cellId,
    pathSegment,
    status,
    progressBefore: before,
    progressAfter: plan.progress,
    result,
    diff: {
      movementCost: movement.spent,
      interactionWorked,
      structureId: plan.structureId ?? "",
      acquiredQuantity: plan.acquiredQuantity ?? 0,
      acquiredKind,
      acquiredTraits,
    },
  };
}

function refreshNeeds(state: SimulationState): void {
  for (const agent of state.agents) {
    const physiological = clamp((100 - agent.body.hydration) * 0.65 + (100 - agent.body.nutrition) * 0.5 + agent.body.fatigue * 0.3);
    const hasShelter = Boolean(structureAtInterior(state, agent.position.cellId));
    const safety = clamp((100 - agent.body.health) * 0.7 + (hasShelter ? 5 : 35) + (state.civilization.epoch === "chaotic" ? 28 : 0));
    const companions = state.agents.filter((other) => other.id !== agent.id && other.body.state !== "dead" && other.position.cellId === agent.position.cellId).length;
    const belonging = clamp(45 - companions * 10);
    const personality = agent.profile.personality;
    const layer = (level: MaslowNeedLevel, situational: number): NeedLayer => ({
      level,
      label: NEED_LABELS[level],
      intensity: clamp(situational + ((personality.layers.find((item) => item.level === level)?.baselineWeight ?? 28) - 28) * 0.25),
      activeNeeds: [{ kind: level, label: NEED_LABELS[level], intensity: situational, reason: "身体、环境与经历共同形成当月强度" }],
    });
    const layers = [
      layer("physiological", physiological),
      layer("safety", safety),
      layer("belonging", belonging),
      layer("esteem", 26),
      layer("selfActualization", 24),
    ];
    const urgent = layers.find((item) => item.level === "physiological" && item.intensity >= 62)
      ?? layers.find((item) => item.level === "safety" && item.intensity >= 62)
      ?? [...layers].sort((a, b) => b.intensity - a.intensity)[0];
    agent.mind.needs = { focus: urgent.label, intensity: urgent.intensity, dominantLevel: urgent.level, layers };
  }
}

function advanceEnvironment(state: SimulationState): EnvironmentFact[] {
  const atMonth = state.clock.elapsedMonths + 1;
  const climate = state.civilization.externalClimate ?? {
    epoch: seededFraction(state.seed, `epoch:${atMonth}`) < state.civilization.conditions.chaosIntensity / 20 ? "chaotic" : "stable",
    kind: "temperate" as ClimateKind,
    severity: 1,
  };
  state.civilization.epoch = climate.epoch;
  state.civilization.climate = { kind: climate.kind, severity: climate.severity, sinceMonth: atMonth };
  const facts: EnvironmentFact[] = [{
    id: `e-${atMonth}-climate`,
    kind: "environment",
    atMonth,
    orderInMonth: 0,
    cellId: 0,
    change: "climate",
    result: `第 ${atMonth} 月处于${climate.epoch === "stable" ? "恒纪元" : "乱纪元"}，地表为${climate.kind}`,
    diff: { ...climate },
  }];

  for (const agent of state.agents) {
    if (agent.body.state === "dead") continue;
    agent.body.ageMonths += 1;
    agent.body.hydration = clamp(agent.body.hydration - (climate.kind === "heat" || climate.kind === "fire" ? 5 : 2));
    agent.body.nutrition = clamp(agent.body.nutrition - 2);
    agent.body.fatigue = clamp(agent.body.fatigue + 2);
    if (agent.body.hydration <= 8) {
      agent.body.state = "dehydrated";
      agent.body.health = clamp(agent.body.health - 8);
    } else if (agent.body.state === "dehydrated" && agent.body.hydration >= 35) {
      agent.body.state = "active";
    }
    if (agent.body.nutrition <= 5) agent.body.health = clamp(agent.body.health - 7);
    if (climate.kind === "fire") agent.body.health = clamp(agent.body.health - climate.severity * 0.8);
    if (agent.body.health <= 0 || agent.body.ageMonths >= agent.body.lifespanMonths) {
      agent.body.state = "dead";
      const plan = activePlan(state, agent);
      if (plan) plan.status = "failed";
      delete agent.activePlanId;
      facts.push({
        id: `e-${atMonth}-death-${agent.id}`,
        kind: "environment",
        atMonth,
        orderInMonth: facts.length,
        cellId: agent.position.cellId,
        change: "death",
        result: `${agent.name}在第 ${atMonth} 月死亡`,
        diff: { agentId: agent.id, ageMonths: agent.body.ageMonths },
      });
    }
  }
  return facts;
}

function deriveObservations(state: SimulationState): SimulationState["derived"] {
  const progress = state.world.past.filter((event): event is PlanProgressFact => event.kind === "plan-progress");
  const gatherings = progress.filter((event) => Number(event.diff.acquiredQuantity) > 0);
  const movements = progress.filter((event) => event.pathSegment.length > 1);
  const rests = progress.filter((event) => state.world.structures.some((structure) => structure.useEventIds.includes(event.id)));
  const completedShelters = state.world.structures.filter((structure) => structure.effects.accessible && structure.effects.weatherProtection >= 58);
  const milestones: MilestoneObservation[] = [];
  if (gatherings.some((event) => Array.isArray(event.diff.acquiredTraits) && event.diff.acquiredTraits.includes("edible"))) milestones.push({
    id: "11",
    label: "采集食物",
    evidenceEventIds: gatherings.map((event) => event.id),
    note: "人物在具体格子取得可食物质。",
  });
  for (const structure of completedShelters) {
    const useFacts = rests.filter((event) => structure.useEventIds.includes(event.id));
    if (new Set(useFacts.map((event) => event.atMonth)).size >= 2) milestones.push({
      id: "20",
      label: "建造住所",
      evidenceEventIds: [...structure.sourceEventIds, ...useFacts.map((event) => event.id)],
      note: "多格构件产生客观防护，人物在不同月份实际进入休息。",
    });
  }
  const trailCells = Array.from(state.world.grid.traces.traffic.entries()).filter(([, count]) => count >= 5).map(([id]) => id);
  if (trailCells.length >= 4) milestones.push({
    id: "42",
    label: "开辟道路",
    evidenceEventIds: movements.filter((event) => event.pathSegment.some((id) => trailCells.includes(id))).map((event) => event.id),
    note: "连续格子的重复真实通行形成小径。",
  });
  const practices: PracticeObservation[] = [
    gatherings.length ? { key: "gather", label: "反复采集", count: gatherings.length, agentIds: [...new Set(gatherings.map((event) => event.who))], eventIds: gatherings.map((event) => event.id), stability: clamp(gatherings.length * 8) } : null,
    movements.length ? { key: "travel", label: "跨格迁行", count: movements.length, agentIds: [...new Set(movements.map((event) => event.who))], eventIds: movements.map((event) => event.id), stability: clamp(movements.length * 5) } : null,
  ].filter((item): item is PracticeObservation => Boolean(item));
  const regions: EmergentRegion[] = [];
  const waterCells = Array.from(state.world.grid.cells.waterDepth.entries()).filter(([, depth]) => depth >= 40).map(([id]) => id);
  if (waterCells.length) regions.push({ id: "natural-water", kind: "natural", cells: waterCells, confidence: 1, evidenceEventIds: [], firstObservedMonth: 0, lastObservedMonth: state.clock.elapsedMonths, label: "水域" });
  if (trailCells.length) regions.push({ id: "travel-trail", kind: "trail", cells: trailCells, confidence: clamp(trailCells.length / 20), evidenceEventIds: movements.map((event) => event.id), firstObservedMonth: movements[0]?.atMonth ?? 0, lastObservedMonth: state.clock.elapsedMonths, label: "反复通行带" });
  for (const structure of completedShelters) {
    if (structure.useEventIds.length >= 2) regions.push({
      id: `residential-${structure.id}`,
      kind: "residential",
      cells: structure.occupiedCells,
      confidence: clamp(structure.useEventIds.length / 6),
      evidenceEventIds: [...structure.sourceEventIds, ...structure.useEventIds],
      firstObservedMonth: state.world.past.find((event) => structure.sourceEventIds.includes(event.id))?.atMonth ?? 0,
      lastObservedMonth: state.clock.elapsedMonths,
      label: "居住活动区",
    });
  }
  return { practices, institutions: [], milestones, regions };
}

function finishMonth(state: SimulationState, events: WorldEvent[]): SimulationState {
  state.clock.elapsedMonths += 1;
  state.world.past.push(...events);
  state.lastStep = events;
  refreshNeeds(state);
  state.derived = deriveObservations(state);
  if (state.agents.every((agent) => agent.body.state === "dead")) {
    state.civilization.status = "ended";
    state.civilization.outcome = { kind: "destroyed", cause: "全员死亡", atMonth: state.clock.elapsedMonths, summary: "文明没有留下仍在世的人。" };
  } else if (state.civilization.conditions.endpoint.kind === "months" && state.clock.elapsedMonths >= state.civilization.conditions.endpoint.value) {
    state.civilization.status = "ended";
    state.civilization.outcome = { kind: "boundary", cause: "达到模拟月数", atMonth: state.clock.elapsedMonths, summary: `文明演化至第 ${state.clock.elapsedMonths} 月。` };
  }
  return state;
}

function currentRollingLedgers(state: SimulationState): DecisionMonthLedger[] {
  return rollingDecisionUsage(state.decisionBudget.ledgers, state.clock.elapsedMonths);
}

function allowedModelContexts(state: SimulationState, livingAgents: number): number {
  return availableModelContexts(currentRollingLedgers(state), livingAgents);
}

function allowedModelTokens(state: SimulationState, livingAgents: number): number {
  return availableModelTokens(currentRollingLedgers(state), livingAgents, state.decisionBudget.tokensPerContext);
}

function prepareMonth(input: SimulationState): {
  state: SimulationState;
  events: WorldEvent[];
  contexts: DecisionContext[];
  candidates: DecisionContext[];
} {
  const state = copyState(input);
  if (state.civilization.status === "ended") return { state, events: [], contexts: [], candidates: [] };
  const events: WorldEvent[] = advanceEnvironment(state);
  refreshNeeds(state);
  const contexts = buildDecisionContexts(state);
  const candidates: DecisionContext[] = [];
  for (const context of contexts) {
    const { probability, reasons } = decisionProbability(state, context.agent);
    const sample = seededFraction(state.seed, `decision:${state.branchId}:${state.clock.elapsedMonths + 1}:${context.agent.id}`);
    const triggered = sample < probability;
    events.push({
      id: `o-${state.clock.elapsedMonths + 1}-${context.agent.id}`,
      kind: "decision-opportunity",
      atMonth: state.clock.elapsedMonths + 1,
      orderInMonth: events.length,
      who: context.agent.id,
      cellId: context.agent.position.cellId,
      probability,
      sample,
      triggered,
      reasons,
      result: triggered ? `${context.agent.name}在本月重新考虑下一步` : `${context.agent.name}本月延续既有安排`,
    });
    if (triggered) candidates.push(context);
  }
  return { state, events, contexts, candidates };
}

function executePrepared(
  prepared: ReturnType<typeof prepareMonth>,
  decisions: Map<AgentId, { decision: Decision; usedModel: boolean }>,
  usage: TokenUsage,
  attemptedModelContexts = 0,
): SimulationState {
  const { state, events, contexts, candidates } = prepared;
  if (state.civilization.status === "ended") return state;
  const fallback = new MockDecider();
  for (const candidate of candidates) {
    const liveAgent = state.agents.find((agent) => agent.id === candidate.agent.id);
    if (!liveAgent || liveAgent.body.state === "dead") continue;
    const picked = decisions.get(liveAgent.id) ?? { decision: fallback.decide(contextFor(state, liveAgent)), usedModel: false };
    events.push(applyDecision(state, liveAgent, contextFor(state, liveAgent), picked.decision, picked.usedModel, events.length));
  }
  const order = state.agents
    .filter((agent) => agent.body.state !== "dead" && activePlan(state, agent))
    .sort((a, b) => seededFraction(state.seed, `order:${state.branchId}:${state.clock.elapsedMonths + 1}:${a.id}`) - seededFraction(state.seed, `order:${state.branchId}:${state.clock.elapsedMonths + 1}:${b.id}`) || a.id.localeCompare(b.id));
  for (const agent of order) {
    const plan = activePlan(state, agent);
    if (plan) events.push(executePlan(state, agent, plan, events.length));
  }
  const modelContexts = attemptedModelContexts;
  const chargedTokens = modelContexts
    ? Math.max(usage.inputTokens + usage.outputTokens, modelContexts * state.decisionBudget.tokensPerContext)
    : 0;
  state.decisionBudget.ledgers = [...currentRollingLedgers(state), {
    atMonth: state.clock.elapsedMonths + 1,
    livingAgents: contexts.length,
    candidates: candidates.length,
    modelContexts,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    chargedTokens,
  }].slice(-24);
  state.decisionBudget.credits = clamp(state.decisionBudget.credits + contexts.length / 12 - modelContexts, 0, Math.max(1, contexts.length));
  return finishMonth(state, events);
}

export function stepSimulation(input: SimulationState, decider: AgentDecider = new MockDecider()): SimulationState {
  const prepared = prepareMonth(input);
  const decisions = new Map<AgentId, { decision: Decision; usedModel: boolean }>();
  for (const context of prepared.candidates) decisions.set(context.agent.id, { decision: decider.decide(context), usedModel: false });
  return executePrepared(prepared, decisions, { inputTokens: 0, outputTokens: 0 }, 0);
}

export async function stepSimulationAsync(input: SimulationState, batch: BatchDecider, fallback: AgentDecider = new MockDecider()): Promise<SimulationState> {
  const prepared = prepareMonth(input);
  const living = prepared.contexts.length;
  const maxContexts = Math.min(
    prepared.candidates.length,
    Math.floor(prepared.state.decisionBudget.credits + living / 12),
    allowedModelContexts(prepared.state, living),
    Math.floor(allowedModelTokens(prepared.state, living) / prepared.state.decisionBudget.tokensPerContext),
  );
  const ranked = [...prepared.candidates].sort((a, b) =>
    b.agent.mind.needs.intensity - a.agent.mind.needs.intensity ||
    a.agent.id.localeCompare(b.agent.id));
  const modelContexts = ranked.slice(0, maxContexts);
  let modelDecisions: (Decision | null)[] = [];
  try {
    modelDecisions = modelContexts.length ? await batch.decideAll(modelContexts) : [];
  } catch {
    modelDecisions = [];
  }
  const decisions = new Map<AgentId, { decision: Decision; usedModel: boolean }>();
  prepared.candidates.forEach((context) => decisions.set(context.agent.id, { decision: fallback.decide(context), usedModel: false }));
  modelContexts.forEach((context, index) => {
    const decision = modelDecisions[index];
    if (decision) decisions.set(context.agent.id, { decision, usedModel: true });
  });
  return executePrepared(
    prepared,
    decisions,
    batch.takeUsage?.() ?? { inputTokens: 0, outputTokens: 0 },
    modelContexts.length,
  );
}

export function migrateSimulationState(input: SimulationState): SimulationState {
  if (Number((input as { schemaVersion?: number }).schemaVersion) !== 11) throw new Error("schemaVersion 10 及更早存档不支持继续演化；请建立新的像素世界文明");
  const state = structuredClone(input);
  state.world.grid = hydrateWorld(input.world.grid);
  return state;
}

export interface SimulationController {
  getState(): SimulationState;
  step(count?: number): SimulationState;
  stepAsync(batch: BatchDecider, count?: number): Promise<SimulationState>;
  reset(): SimulationState;
  restore(saved: SimulationState): SimulationState;
  setExternalClimate(epoch: EpochKind, kind: ClimateKind, severity: number): SimulationState;
  injectEvent(input: EnvironmentEventInput): SimulationState;
}

export function createSimulation(options: { seed?: number; decider?: AgentDecider; config?: Partial<SimulationConfig>; state?: SimulationState } = {}): SimulationController {
  let state = options.state ? migrateSimulationState(options.state) : createInitialState(options.seed, options.config);
  return {
    getState: () => copyState(state),
    step(count = 1) {
      for (let index = 0; index < count; index += 1) state = stepSimulation(state, options.decider);
      return copyState(state);
    },
    async stepAsync(batch, count = 1) {
      for (let index = 0; index < count; index += 1) state = await stepSimulationAsync(state, batch, options.decider);
      return copyState(state);
    },
    reset() {
      state = createInitialState(options.seed ?? state.seed, state.civilization.conditions);
      return copyState(state);
    },
    restore(saved) {
      state = migrateSimulationState(saved);
      return copyState(state);
    },
    setExternalClimate(epoch, kind, severity) {
      state.civilization.externalClimate = { epoch, kind, severity: clamp(severity, 1, 10) };
      return copyState(state);
    },
    injectEvent(input) {
      if (!isCellId(input.cellId)) throw new Error("环境事件 cellId 无效");
      const atMonth = state.clock.elapsedMonths;
      const event: EnvironmentFact = {
        id: `e-${atMonth}-injected-${state.world.past.length}`,
        kind: "environment",
        atMonth,
        orderInMonth: 0,
        cellId: input.cellId,
        change: input.kind,
        result: input.description ?? `格子 ${input.cellId} 的环境发生变化`,
        diff: { severity: input.severity ?? 0, resource: input.resource ?? "", delta: input.delta ?? 0 },
      };
      state.world.past.push(event);
      state.lastStep = [event];
      return copyState(state);
    },
  };
}

export function resetSimulation(seed = 17, config: Partial<SimulationConfig> = {}): SimulationState {
  return createInitialState(seed, config);
}

export function buildEvolutionReport(finalState: SimulationState, checkpoints: SimulationState[] = []): EvolutionReport {
  return {
    schemaVersion: 11,
    exportedAt: new Date().toISOString(),
    civilization: structuredClone(finalState.civilization),
    finalState: copyState(finalState),
    checkpoints: checkpoints.map(copyState),
    review: { milestones: structuredClone(finalState.derived.milestones), eventCount: finalState.world.past.length },
  };
}
