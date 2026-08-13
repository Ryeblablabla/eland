import { createBiologicalSex, createLifespanMonths, deterministicFraction } from '../population';
import { Material, materialHas } from './material';
import type { EnvironmentFact, SimulationState } from './model';
import type { ConditionInstance, PersonState } from './person';
import { isAlive } from './person';
import { addDrop } from './action-executor';
import { WORLD_CELL_COUNT, cellX, cellY, cellsInRadius, neighbors4, setVoxel, surfaceMaterial, topZ } from '../world/grid';
import { seededFraction } from '../world/generator';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function event(state: SimulationState, atMonth: number, events: EnvironmentFact[], change: EnvironmentFact['change'], result: string, diff: Record<string, unknown>, person?: PersonState): EnvironmentFact {
  void state;
  const fact: EnvironmentFact = {
    id: `e-${atMonth}-environment-${change}-${events.length}`,
    kind: 'environment', atMonth, orderInMonth: events.length,
    cellId: person?.position.cellId ?? 0,
    change, ...(person ? { who: person.id } : {}), result, diff,
  };
  events.push(fact);
  return fact;
}

export function resolveClimate(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const external = state.civilization.externalClimate;
  let epoch = external?.epoch ?? 'stable';
  let kind = external?.kind ?? 'temperate';
  let severity = external?.severity ?? 1;
  if (!external) {
    const chaos = state.civilization.conditions.chaosIntensity / 10;
    const sample = seededFraction(state.seed, `climate:${Math.floor((atMonth - 1) / 3)}`);
    epoch = sample < chaos * 0.45 ? 'chaotic' : 'stable';
    const coldBias = state.civilization.conditions.climateBias === 'cold' ? 0.2 : 0;
    const heatBias = state.civilization.conditions.climateBias === 'hot' ? 0.2 : 0;
    const coldThreshold = 0.12 + coldBias + chaos * 0.12;
    const heatThreshold = 0.88 - heatBias - chaos * 0.12;
    kind = sample < coldThreshold ? 'cold' : sample > heatThreshold ? 'heat' : 'temperate';
    if (kind === 'heat' && epoch === 'chaotic' && sample > 0.97) kind = 'fire';
    severity = kind === 'temperate' ? 1 : 1 + Math.floor(seededFraction(state.seed, `climate-severity:${atMonth}`) * 3);
  }
  const changed = state.civilization.climate.kind !== kind || state.civilization.climate.severity !== severity || state.civilization.epoch !== epoch;
  state.civilization.epoch = epoch;
  state.civilization.climate = { kind, severity, sinceMonth: changed ? atMonth : state.civilization.climate.sinceMonth };
  if (changed || atMonth === 1) event(state, atMonth, events, 'climate', `本月地表处于${kind === 'temperate' ? '温和' : kind === 'cold' ? '寒冷' : kind === 'heat' ? '炎热' : '烈火'}环境`, { epoch, kind, severity });
  return events;
}

export function advanceWorldProcesses(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const changes: Array<{ cellId: number; from: number; to: number; process: string }> = [];
  const climate = state.civilization.climate;
  const pending: Array<{ cell: number; to: number; process: string }> = [];
  for (let cell = 0; cell < WORLD_CELL_COUNT; cell += 1) {
    const surface = surfaceMaterial(state.world.grid, cell);
    const sample = seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`);
    if (surface === Material.CropSprout) {
      const rate = climate.kind === 'temperate' ? 0.2 : climate.kind === 'cold' ? 0.055 : 0.1;
      if (sample < rate) pending.push({ cell, to: Material.CropMature, process: 'plant-growth' });
    } else if (surface === Material.Shrub && sample < (climate.kind === 'temperate' ? 0.025 : 0.008)) {
      pending.push({ cell, to: Material.BerryBush, process: 'berry-growth' });
    } else if (surface === Material.Water && climate.kind === 'cold' && sample < Math.min(0.3, climate.severity * 0.08)) {
      pending.push({ cell, to: Material.Ice, process: 'freeze' });
    } else if (surface === Material.Ice && climate.kind !== 'cold' && sample < 0.35) {
      pending.push({ cell, to: Material.Water, process: 'thaw' });
    } else if (surface === Material.WetSoil && (climate.kind === 'heat' || climate.kind === 'fire') && sample < climate.severity * 0.045) {
      pending.push({ cell, to: Material.Soil, process: 'drying' });
    } else if (surface === Material.ExhaustedSoil && neighbors4(cell).some((neighbor) => surfaceMaterial(state.world.grid, neighbor) === Material.Water) && sample < 0.045) {
      pending.push({ cell, to: Material.WetSoil, process: 'soil-recovery' });
    } else if (surface === Material.Fire && sample < 0.28) {
      pending.push({ cell, to: Material.Ash, process: 'burn-out' });
      for (const neighbor of neighbors4(cell)) {
        const nearby = surfaceMaterial(state.world.grid, neighbor);
        if (materialHas(nearby, 'flammable') && seededFraction(state.seed, `fire-spread:${atMonth}:${cell}:${neighbor}`) < climate.severity * 0.12) {
          pending.push({ cell: neighbor, to: Material.Fire, process: 'fire-spread' });
        }
      }
    }
  }
  for (const change of pending.slice(0, 160)) {
    const from = surfaceMaterial(state.world.grid, change.cell);
    if (from === change.to) continue;
    setVoxel(state.world.grid, cellX(change.cell), cellY(change.cell), topZ(state.world.grid, change.cell), change.to);
    changes.push({ cellId: change.cell, from, to: change.to, process: change.process });
  }
  if (changes.length) event(state, atMonth, events, 'material', `${changes.length} 个格子的物质因自然过程发生变化`, { changes });

  const occupiedFoodCells = new Set(state.world.drops.filter((drop) => drop.materialId === Material.Food && drop.quantity > 0).map((drop) => drop.cellId));
  for (let cell = 0; cell < WORLD_CELL_COUNT; cell += 1) {
    if (surfaceMaterial(state.world.grid, cell) !== Material.BerryBush || occupiedFoodCells.has(cell)) continue;
    if (seededFraction(state.seed, `berry-drop:${atMonth}:${cell}`) < 0.035) addDrop(state, Material.Food, 2, cell, atMonth, [], 'berry-regrowth');
  }
  return events;
}

function nearbyPlanks(state: SimulationState, person: PersonState): number {
  return cellsInRadius(person.position.cellId, 2).filter((cell) => surfaceMaterial(state.world.grid, cell) === Material.Plank).length;
}

function condition(state: SimulationState, person: PersonState, kind: ConditionInstance['kind']): ConditionInstance | undefined {
  void state;
  return person.conditions.find((item) => item.kind === kind);
}

function upsertExposureCondition(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  kind: 'cold' | 'heat',
  load: number,
  protectedHere: boolean,
  events: EnvironmentFact[],
): void {
  const current = condition(state, person, kind);
  if (load > 0 && !current) {
    const probability = Math.min(0.9, 0.18 + load * 0.18);
    const sample = seededFraction(state.seed, `condition-enter:${atMonth}:${person.id}:${kind}`);
    if (sample < probability) {
      const created: ConditionInstance = { id: `condition-${kind}-${person.id}-${atMonth}`, kind, stage: Math.min(3, Math.max(1, Math.ceil(load))) as 1 | 2 | 3, sinceMonth: atMonth, sourceEventIds: [] };
      person.conditions.push(created);
      const fact = event(state, atMonth, events, 'condition', `${person.name}进入${kind === 'cold' ? '寒冷' : '炎热'}状态`, { condition: kind, stage: created.stage }, person);
      created.sourceEventIds.push(fact.id);
    }
  } else if (current && load > current.stage + 0.6) {
    current.stage = Math.min(3, current.stage + 1) as 1 | 2 | 3;
    const fact = event(state, atMonth, events, 'condition', `${person.name}的${kind === 'cold' ? '寒冷' : '炎热'}加重`, { condition: kind, stage: current.stage }, person);
    current.sourceEventIds.push(fact.id);
  } else if (current && (load <= 0 || protectedHere)) {
    const probability = protectedHere ? 0.7 : 0.35;
    if (seededFraction(state.seed, `condition-exit:${atMonth}:${person.id}:${kind}`) < probability) {
      person.conditions = person.conditions.filter((item) => item.id !== current.id);
      event(state, atMonth, events, 'condition', `${person.name}退出${kind === 'cold' ? '寒冷' : '炎热'}状态`, { condition: kind, exited: true }, person);
    }
  }
}

function recoverInjuries(state: SimulationState, person: PersonState, atMonth: number, sheltered: boolean, events: EnvironmentFact[]): void {
  for (const current of [...person.conditions]) {
    if (current.kind !== 'wound' && current.kind !== 'illness') continue;
    const nourished = person.body.nutrition >= 55 && person.body.hydration >= 55;
    const recovery = 0.08 + (nourished ? 0.17 : 0) + (sheltered ? 0.12 : 0);
    if (seededFraction(state.seed, `condition-recover:${atMonth}:${person.id}:${current.id}`) < recovery) {
      if (current.stage > 1) current.stage = (current.stage - 1) as 1 | 2;
      else person.conditions = person.conditions.filter((item) => item.id !== current.id);
      event(state, atMonth, events, 'condition', `${person.name}的${current.kind === 'wound' ? '伤口' : '疾病'}有所恢复`, { condition: current.kind, stage: current.stage }, person);
    }
  }
  const wound = condition(state, person, 'wound');
  if (wound && !condition(state, person, 'illness')) {
    const infectionRisk = 0.018 * wound.stage * (person.body.nutrition < 35 ? 2 : 1);
    if (seededFraction(state.seed, `wound-infection:${atMonth}:${person.id}`) < infectionRisk) {
      const illness: ConditionInstance = { id: `condition-illness-${person.id}-${atMonth}`, kind: 'illness', stage: 1, sinceMonth: atMonth, sourceEventIds: [...wound.sourceEventIds] };
      person.conditions.push(illness);
      const fact = event(state, atMonth, events, 'condition', `${person.name}的伤口引发疾病`, { condition: 'illness', stage: 1 }, person);
      illness.sourceEventIds.push(fact.id);
    }
  }
}

function newborn(state: SimulationState, mother: PersonState, fatherId: string, atMonth: number): PersonState {
  const id = `born-${atMonth}-${mother.id}-${state.people.length}`;
  const father = state.people.find((person) => person.id === fatherId);
  const average = (field: keyof PersonState['baselineCapacities']) => Math.round((mother.baselineCapacities[field] + (father?.baselineCapacities[field] ?? mother.baselineCapacities[field])) / 2);
  return {
    id,
    name: `新生儿 ${state.people.filter((person) => person.generation > 0).length + 1}`,
    color: mother.color,
    profile: { description: `${mother.name}与${father?.name ?? '未知者'}的后代` },
    bornAtMonth: atMonth,
    lifespanMonths: createLifespanMonths(state.seed, id),
    sex: createBiologicalSex(state.seed, id),
    geneticParents: [mother.id, fatherId],
    generation: Math.max(mother.generation, father?.generation ?? 0) + 1,
    position: { cellId: mother.position.cellId, previousCellId: mother.position.cellId, lastPath: [mother.position.cellId] },
    body: { health: 72, hydration: 74, nutrition: 76 },
    baselineCapacities: {
      locomotion: average('locomotion'), manipulation: average('manipulation'), perception: average('perception'),
      communication: average('communication'), cognition: average('cognition'),
    },
    driveBias: {
      affiliation: 50 + Math.floor(deterministicFraction(state.seed, `${id}:affiliation`) * 35),
      autonomy: 35 + Math.floor(deterministicFraction(state.seed, `${id}:autonomy`) * 45),
      recognition: 35 + Math.floor(deterministicFraction(state.seed, `${id}:recognition`) * 45),
      inquiryCreation: 35 + Math.floor(deterministicFraction(state.seed, `${id}:inquiry`) * 50),
    },
    conditions: [], inventory: [], knowledge: [], memories: [],
    relations: state.people.filter(isAlive).map((person) => ({ personId: person.id, trust: person.id === mother.id || person.id === fatherId ? 65 : 20, bond: person.id === mother.id || person.id === fatherId ? 78 : 18, fear: 0, sourceEventIds: [] })),
    currentActionText: '依赖身边人的照护', lastDecisionText: '尚不能独立决策',
  };
}

function advancePregnancies(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const pregnancy = condition(state, person, 'pregnancy');
  if (!pregnancy?.dueAtMonth) return;
  const remaining = pregnancy.dueAtMonth - atMonth;
  pregnancy.stage = remaining <= 2 ? 3 : remaining <= 5 ? 2 : 1;
  if (person.body.health < 18 || person.body.nutrition < 10) {
    if (seededFraction(state.seed, `pregnancy-loss:${atMonth}:${person.id}`) < 0.28) {
      person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
      event(state, atMonth, events, 'condition', `${person.name}的妊娠过程因身体恶化而中止`, { pregnancyEnded: true }, person);
    }
    return;
  }
  if (atMonth < pregnancy.dueAtMonth) return;
  const child = newborn(state, person, pregnancy.otherPersonId ?? 'unknown', atMonth);
  state.people.push(child);
  person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
  const fact = event(state, atMonth, events, 'body', `${person.name}生下了${child.name}`, { bornPersonId: child.id, parents: child.geneticParents, generation: child.generation }, person);
  child.relations.forEach((relation) => { relation.sourceEventIds = [fact.id]; });
  for (const existing of state.people) {
    if (existing.id === child.id || existing.relations.some((relation) => relation.personId === child.id)) continue;
    const closeKin = child.geneticParents.includes(existing.id);
    existing.relations.push({ personId: child.id, trust: closeKin ? 62 : 20, bond: closeKin ? 78 : 18, fear: 0, sourceEventIds: [fact.id] });
  }
}

function die(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  person.diedAtMonth = atMonth;
  person.body.health = 0;
  for (const stack of person.inventory) addDrop(state, stack.materialId, stack.quantity, person.position.cellId, atMonth, [], `${person.id}-death`);
  person.inventory = [];
  const intent = state.intents.find((candidate) => candidate.id === person.activeIntentId);
  if (intent) intent.status = 'failed';
  delete person.activeIntentId;
  event(state, atMonth, events, 'death', `${person.name}在第 ${atMonth} 月死亡，私有背包遗留在原地`, { personId: person.id, ageMonths: atMonth - person.bornAtMonth }, person);
}

export function advanceBodies(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const peopleAtStart = [...state.people];
  for (const person of peopleAtStart) {
    if (person.diedAtMonth !== undefined) continue;
    if (person.body.health <= 0) {
      die(state, person, atMonth, events);
      continue;
    }
    const planks = nearbyPlanks(state, person);
    const sheltered = planks >= 3;
    const climate = state.civilization.climate;
    const coldLoad = climate.kind === 'cold' ? Math.max(0, climate.severity - (sheltered ? 1.4 : 0)) : 0;
    const heatLoad = climate.kind === 'heat' || climate.kind === 'fire' ? Math.max(0, climate.severity - (sheltered ? 0.7 : 0)) : 0;
    upsertExposureCondition(state, person, atMonth, 'cold', coldLoad, sheltered && climate.kind !== 'cold', events);
    upsertExposureCondition(state, person, atMonth, 'heat', heatLoad, sheltered && climate.kind === 'temperate', events);

    const cold = condition(state, person, 'cold')?.stage ?? 0;
    const heat = condition(state, person, 'heat')?.stage ?? 0;
    const wound = condition(state, person, 'wound')?.stage ?? 0;
    const illness = condition(state, person, 'illness')?.stage ?? 0;
    const pregnancy = condition(state, person, 'pregnancy')?.stage ?? 0;
    const hydrationCost = 1.35 * (heat ? [1, 1.3, 1.7, 2.2][heat] : 1) + illness * 0.35 + pregnancy * 0.22;
    const nutritionCost = 1.25 * (cold ? [1, 1.25, 1.5, 1.8][cold] : 1) + illness * 0.38 + pregnancy * 0.28;
    person.body.hydration = clamp(person.body.hydration - hydrationCost);
    person.body.nutrition = clamp(person.body.nutrition - nutritionCost);
    let healthDelta = 0;
    if (person.body.hydration < 10) healthDelta -= 7;
    else if (person.body.hydration < 25) healthDelta -= 2;
    if (person.body.nutrition < 10) healthDelta -= 6;
    else if (person.body.nutrition < 25) healthDelta -= 2;
    if (cold >= 3) healthDelta -= 2;
    if (heat >= 3) healthDelta -= 3;
    healthDelta -= Math.max(0, wound - 1) * 1.5 + Math.max(0, illness - 1) * 1.5;
    if (person.body.hydration >= 65 && person.body.nutrition >= 65 && (sheltered || climate.kind === 'temperate') && !wound && !illness) healthDelta += 1.4;
    person.body.health = clamp(person.body.health + healthDelta);
    recoverInjuries(state, person, atMonth, sheltered, events);
    advancePregnancies(state, person, atMonth, events);
    if (person.body.health <= 0 || atMonth - person.bornAtMonth >= person.lifespanMonths) die(state, person, atMonth, events);
    else if (Math.abs(healthDelta) >= 2 || person.body.hydration < 25 || person.body.nutrition < 25) {
      event(state, atMonth, events, 'body', `${person.name}的身体储备发生显著变化`, { health: person.body.health, hydration: person.body.hydration, nutrition: person.body.nutrition, healthDelta }, person);
    }
  }
  return events;
}
