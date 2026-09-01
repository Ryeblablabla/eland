import { createBiologicalSex, createLifespanMonths, deterministicFraction } from '../population';
import { Material, materialHas } from './material';
import type { EnvironmentFact, Intent, SimulationState } from './model';
import type { ConditionInstance, PersonState } from './person';
import {
  HIBERNATION_RECOVERY_SAFE_RESERVE,
  ageMonths,
  hibernationPhase,
  isAlive,
  sameLocation,
} from './person';
import {
  createMotiveSensitivity,
  createPersonality,
  newbornInitialTrust,
} from './personality';
import { createCognitionState, recordIntentGoalOutcome } from './cognition';
import { createCharacterAgendaState } from './character-agenda';
import { inventoryQuantity } from './person';
import { addDrop } from './action-executor';
import { WORLD_CELL_COUNT, cellId, cellX, cellY, cellsInRadius, isStandingPosition, neighbors4, setVoxel, surfaceMaterial, surfaceStandingPosition, topZ, voxelAt } from '../world/grid';
import { seededFraction } from '../world/generator';
import { shelterGeometryAt, shelterHeatRelief } from './structure';
import { geneticKinshipRisk, inheritedGeneticLoad, KINSHIP_RISK_KNOWLEDGE_ID } from './kinship';
import { remember } from './memory';
import { createNewbornName } from '../naming';
import {
  applyTraitCapacityModifiers,
  applyTraitLifespanModifier,
  bindTraitSource,
  coldHarmMultiplier,
  grantProphetKnowledge,
  hasTrait,
  heatHarmMultiplier,
  heatHydrationMultiplier,
  injuryRecoveryMultiplier,
  injuryWorseningRiskMultiplier,
  nutritionMetabolicMultiplier,
  personTraitsAtBirth,
  traitDefinition,
  type TraitBirthResult,
} from './trait';
import { humanResourceCompetitionMultiplier } from './population-capacity';
import { intentById, intentsOwnedBy, livingPeople, personById, projectById } from './state-index';
import {
  advanceEraPredictions,
  initialEraSchedule,
  resolveClimate,
  resolveWeather,
} from './monthly/climate';
import { advanceSharedRelationshipExperience } from './monthly/relationship-experience';
import { advanceAnimals } from './monthly/wildlife';
import { applyRelationEvidence } from './relation';
import { findReachableWater } from './water-access';
import { createEmptyPersonMindMarkdown } from './person-mind';

export {
  advanceEraPredictions,
  initialEraSchedule,
  resolveClimate,
  resolveWeather,
  advanceSharedRelationshipExperience,
  advanceAnimals,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

const HIBERNATION_HYDRATION_COST = 0.35;
const HIBERNATION_NUTRITION_COST = 0.3;
const HIBERNATION_HEALTH_COST = 0.25;

function hasImmediateHibernationHydrationRecovery(
  state: SimulationState,
  person: PersonState,
): boolean {
  if (person.body.hydration >= HIBERNATION_RECOVERY_SAFE_RESERVE) return true;
  if (person.inventory.some((stack) => stack.quantity > 0
    && materialHas(stack.materialId, 'drinkable'))) return true;
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return Boolean(findReachableWater(
    state,
    person,
    cellsInRadius(person.position.cellId, radius),
  ));
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

/**
 * A real three-sun collapse is not survivable weather. It resolves before the
 * first planning tick so shelters, hibernation, traits, or queued actions
 * cannot turn a terminal astronomical event into an ordinary heat episode.
 */
export function resolveTerminalCatastrophe(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
): boolean {
  if (state.civilization.externalClimate?.terminalCatastrophe !== 'triple-sun-vaporization') return false;
  const catastropheFact: EnvironmentFact = {
    id: `e-${atMonth}-environment-triple-sun-vaporization`,
    kind: 'environment',
    atMonth,
    orderInMonth: events.length,
    planningTick: 1,
    orderInTick: 0,
    cellId: 0,
    change: 'climate',
    result: '三日凌空，地表在第一个规划刻度内进入足以汽化全部人类的辐射与烈焰',
    diff: {
      terminalCatastrophe: 'triple-sun-vaporization',
      vaporization: true,
      bypassesShelter: true,
      bypassesHibernation: true,
      bypassesTraits: true,
    },
  };
  events.push(catastropheFact);
  for (const person of livingPeople(state)) {
    die(state, person, atMonth, events, 'triple-sun-vaporization', {
      sourceEventIds: [catastropheFact.id],
      vaporized: true,
    });
  }
  return true;
}

export function advanceWorldProcesses(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const changes: Array<{ cellId: number; from: number; to: number; process: string }> = [];
  const climate = state.civilization.climate;
  const weather = state.civilization.weather;
  const pending: Array<{ cell: number; to: number; process: string }> = [];
  const riverPositionsByCell = new Map<number, Array<{ x: number; y: number; z: number }>>();
  for (const position of state.world.mechanicalPower?.sources.flatMap((segment) => segment.requiredWaterVoxels) ?? []) {
    const key = cellId(position.x, position.y);
    const positions = riverPositionsByCell.get(key) ?? [];
    if (!positions.some((candidate) => candidate.z === position.z)) positions.push(position);
    riverPositionsByCell.set(key, positions);
  }
  const riverCellHasWater = (cell: number): boolean => (riverPositionsByCell.get(cell) ?? [])
    .some((position) => voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Water);
  const riverRechargeRate = weather.kind === 'rain'
    ? weather.intensity * 0.012
    : weather.kind === 'storm'
      ? weather.intensity * 0.008
      : 0;
  for (let cell = 0; cell < WORLD_CELL_COUNT; cell += 1) {
    const surface = surfaceMaterial(state.world.grid, cell);
    if (surface === Material.CropSprout) {
      const sample = seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`);
      const weatherGrowth = weather.kind === 'rain' ? 1.35 : weather.kind === 'drought' ? 0.28 : weather.kind === 'storm' ? 0.75 : 1;
      const rate = (climate.kind === 'temperate' ? 0.2 : climate.kind === 'cold' ? 0.055 : 0.1) * weatherGrowth;
      if (sample < rate) pending.push({ cell, to: Material.CropMature, process: 'plant-growth' });
      else if (weather.kind === 'drought' && sample < 0.035 * weather.intensity) pending.push({ cell, to: Material.ExhaustedSoil, process: 'crop-drought-loss' });
    } else if (surface === Material.Shrub
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < (climate.kind === 'temperate' ? 0.025 : 0.008)) {
      pending.push({ cell, to: Material.BerryBush, process: 'berry-growth' });
    } else if (surface === Material.BerryBush
      && weather.kind === 'drought'
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < weather.intensity * 0.025) {
      pending.push({ cell, to: Material.Shrub, process: 'berry-drought-loss' });
    } else if (surface === Material.Water
      && (climate.kind === 'cold' || weather.kind === 'snow')
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < Math.min(0.42, climate.severity * 0.08 + weather.intensity * 0.025)) {
      pending.push({ cell, to: Material.Ice, process: 'freeze' });
    } else if (surface === Material.Water
      && weather.kind === 'drought'
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < weather.intensity * 0.004) {
      pending.push({ cell, to: Material.Sand, process: 'evaporation' });
    } else if (surface === Material.Ice
      && climate.kind !== 'cold'
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < 0.35) {
      pending.push({ cell, to: Material.Water, process: 'thaw' });
    } else if (surface === Material.Sand
      && riverRechargeRate > 0
      && riverPositionsByCell.has(cell)
      && neighbors4(cell).some(riverCellHasWater)
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < riverRechargeRate) {
      pending.push({ cell, to: Material.Water, process: 'river-recharge' });
    } else if (surface === Material.WetSoil
      && (climate.kind === 'heat' || climate.kind === 'fire')
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < climate.severity * 0.045) {
      pending.push({ cell, to: Material.Soil, process: 'drying' });
    } else if (surface === Material.ExhaustedSoil
      && neighbors4(cell).some((neighbor) => surfaceMaterial(state.world.grid, neighbor) === Material.Water)
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < 0.045) {
      pending.push({ cell, to: Material.WetSoil, process: 'soil-recovery' });
    } else if (surface === Material.Fire) {
      const sample = seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`);
      if (sample < 0.28 || weather.kind === 'rain' || weather.kind === 'storm' || weather.kind === 'snow') {
        pending.push({ cell, to: Material.Ash, process: 'burn-out' });
        for (const neighbor of neighbors4(cell)) {
          const nearby = surfaceMaterial(state.world.grid, neighbor);
          if (materialHas(nearby, 'flammable') && seededFraction(state.seed, `fire-spread:${atMonth}:${cell}:${neighbor}`) < climate.severity * 0.12) {
            pending.push({ cell: neighbor, to: Material.Fire, process: 'fire-spread' });
          }
        }
      }
    } else if ((surface === Material.Soil || surface === Material.ExhaustedSoil)
      && weather.kind === 'rain'
      && seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`) < weather.intensity * 0.022) {
      pending.push({ cell, to: Material.WetSoil, process: 'rain-soak' });
    }
  }
  for (const change of pending.slice(0, 160)) {
    const from = surfaceMaterial(state.world.grid, change.cell);
    if (from === change.to) continue;
    setVoxel(state.world.grid, cellX(change.cell), cellY(change.cell), topZ(state.world.grid, change.cell), change.to);
    changes.push({ cellId: change.cell, from, to: change.to, process: change.process });
  }
  if (changes.length) event(state, atMonth, events, 'material', `${changes.length} 个格子的物质因自然过程发生变化`, { changes });
  const naturallyChangedCells = new Set(changes.map((change) => change.cellId));
  for (const person of livingPeople(state)) {
    if (!naturallyChangedCells.has(person.position.cellId)
      || isStandingPosition(state.world.grid, person.position)) continue;
    const from = { cellId: person.position.cellId, z: person.position.z };
    const destination = cellsInRadius(from.cellId, 2)
      .flatMap((candidateCellId) => {
        const position = surfaceStandingPosition(state.world.grid, candidateCellId);
        return position ? [position] : [];
      })
      .sort((left, right) => (
        Math.abs(cellX(left.cellId) - cellX(from.cellId))
          + Math.abs(cellY(left.cellId) - cellY(from.cellId))
          + Math.abs(left.z - from.z) * 0.5
      ) - (
        Math.abs(cellX(right.cellId) - cellX(from.cellId))
          + Math.abs(cellY(right.cellId) - cellY(from.cellId))
          + Math.abs(right.z - from.z) * 0.5
      ) || left.cellId - right.cellId || left.z - right.z)[0];
    if (!destination) continue;
    person.position.cellId = destination.cellId;
    person.position.z = destination.z;
    person.position.lastPath = [from.cellId, destination.cellId];
    person.position.tickPath = [destination.cellId];
    event(
      state,
      atMonth,
      events,
      'material',
      `${person.name}脚下的自然支撑发生变化，身体移到附近可站立位置`,
      {
        process: 'natural-support-displacement',
        fromCellId: from.cellId,
        fromZ: from.z,
        toCellId: destination.cellId,
        toZ: destination.z,
        sourceCellChanges: changes.filter((change) => change.cellId === from.cellId),
      },
      person,
    );
  }
  const destroyedContainers = state.containers.filter((container) => {
    const materialId = voxelAt(state.world.grid, container.position.x, container.position.y, container.position.z);
    return materialId !== Material.Container && materialId !== Material.Granary;
  });
  for (const container of destroyedContainers) {
    const origin = container.position.x + container.position.y * state.world.grid.width;
    const spillPosition = [origin, ...neighbors4(origin)]
      .flatMap((cell) => {
        const position = surfaceStandingPosition(state.world.grid, cell);
        return position ? [position] : [];
      })[0];
    if (spillPosition) for (const stack of container.inventory) {
      addDrop(state, stack.materialId, stack.quantity, spillPosition.cellId, atMonth, [...container.sourceEventIds, ...stack.sourceEventIds], 'destroyed-container', stack.recordPayloadId, spillPosition.z);
    }
  }
  if (destroyedContainers.length) state.containers = state.containers.filter((container) => !destroyedContainers.includes(container));
  advanceAnimals(state, atMonth, events);
  return events;
}

function nearbyFires(state: SimulationState, person: PersonState): number {
  let count = 0;
  for (const cell of cellsInRadius(person.position.cellId, 2)) {
    for (let z = Math.max(0, person.position.z - 2); z <= Math.min(state.world.grid.levels - 1, person.position.z + 2); z += 1) {
      if (voxelAt(state.world.grid, cellX(cell), cellY(cell), z) === Material.Fire) count += 1;
    }
  }
  return count;
}

function condition(state: SimulationState, person: PersonState, kind: ConditionInstance['kind']): ConditionInstance | undefined {
  void state;
  return person.conditions.find((item) => item.kind === kind);
}

function learnFromInheritedOutcome(observer: PersonState, child: PersonState, atMonth: number, sourceEventId: string, kind: 'birth' | 'illness'): void {
  if (ageMonths(observer, atMonth) < 12 * 12) return;
  remember(observer, {
    id: `memory:inherited-outcome:${sourceEventId}:${observer.id}`,
    kind: 'episode',
    summary: kind === 'birth'
      ? `${child.name}的亲代关系很近，出生时的体质与能力低于双亲的平均状态`
      : `${child.name}在有较高遗传负荷时出现了反复疾病`,
    importance: kind === 'birth' ? 76 : 88,
    createdAtMonth: atMonth,
    lastRecalledAtMonth: atMonth,
    personIds: [child.id, ...child.geneticParents],
    sourceEventIds: [sourceEventId],
  });
  const known = observer.knowledge.find((fact) => fact.id === KINSHIP_RISK_KNOWLEDGE_ID);
  const confidence = kind === 'birth' ? 42 : 48;
  if (known) {
    known.confidence = clamp(known.confidence + (kind === 'birth' ? 16 : 20));
    known.sourceEventIds = [...new Set([...known.sourceEventIds, sourceEventId])].slice(-24);
  } else observer.knowledge.push({
    id: KINSHIP_RISK_KNOWLEDGE_ID,
    kind: 'claim',
    summary: '亲缘很近的双方繁衍时，后代更容易体弱、能力下降或反复生病',
    confidence,
    learnedAtMonth: atMonth,
    sourceEventIds: [sourceEventId],
  });
}

function advanceInheritedSusceptibility(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const load = person.geneticLoad ?? 0;
  if (load < 0.15 || condition(state, person, 'illness')) return;
  const risk = load * 0.012 * injuryWorseningRiskMultiplier(person);
  if (seededFraction(state.seed, `inherited-illness:${atMonth}:${person.id}`) >= risk) return;
  const illness: ConditionInstance = {
    id: `condition-illness-inherited-${person.id}-${atMonth}`,
    kind: 'illness',
    stage: load >= 0.72 ? 2 : 1,
    sinceMonth: atMonth,
    sourceEventIds: [],
  };
  person.conditions.push(illness);
  const fact = event(state, atMonth, events, 'condition', `${person.name}因遗传易感性出现疾病`, {
    condition: 'illness', stage: illness.stage, inheritedSusceptibility: true, geneticLoad: load, risk,
  }, person);
  illness.sourceEventIds.push(fact.id);
  for (const observer of livingPeople(state).filter((candidate) =>
    sameLocation(candidate, person)
    && (candidate.id === person.id || candidate.geneticParents.includes(person.id) || person.geneticParents.includes(candidate.id) || candidate.relations.some((relation) => relation.personId === person.id && relation.bond >= 10)))) {
    learnFromInheritedOutcome(observer, person, atMonth, fact.id, 'illness');
  }
}

function upsertExposureCondition(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  kind: 'cold' | 'heat',
  load: number,
  protectedHere: boolean,
  protectedByFire: boolean,
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
      event(state, atMonth, events, 'condition', `${person.name}退出${kind === 'cold' ? '寒冷' : '炎热'}状态`, { condition: kind, exited: true, ...(protectedByFire ? { protectedByFire: true } : {}) }, person);
    }
  }
}

function clearOppositeExposure(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  activeKind: 'cold' | 'heat',
  events: EnvironmentFact[],
): void {
  const oppositeKind = activeKind === 'cold' ? 'heat' : 'cold';
  const opposite = condition(state, person, oppositeKind);
  if (!opposite) return;
  person.conditions = person.conditions.filter((item) => item.id !== opposite.id);
  event(state, atMonth, events, 'condition', `${person.name}的${oppositeKind === 'cold' ? '寒冷' : '炎热'}状态因相反热负荷而退出`, {
    condition: oppositeKind,
    exited: true,
    counteredBy: activeKind,
  }, person);
}

function recoverInjuries(state: SimulationState, person: PersonState, atMonth: number, sheltered: boolean, events: EnvironmentFact[]): void {
  for (const current of [...person.conditions]) {
    if (current.kind !== 'wound' && current.kind !== 'illness') continue;
    const nourished = person.body.nutrition >= 55 && person.body.hydration >= 55;
    const recovery = Math.min(1, (0.08 + (nourished ? 0.17 : 0) + (sheltered ? 0.12 : 0)) * injuryRecoveryMultiplier(person));
    if (seededFraction(state.seed, `condition-recover:${atMonth}:${person.id}:${current.id}`) < recovery) {
      if (current.stage > 1) current.stage = (current.stage - 1) as 1 | 2;
      else person.conditions = person.conditions.filter((item) => item.id !== current.id);
      event(state, atMonth, events, 'condition', `${person.name}的${current.kind === 'wound' ? '伤口' : '疾病'}有所恢复`, { condition: current.kind, stage: current.stage }, person);
    }
  }
  const wound = condition(state, person, 'wound');
  if (wound && !condition(state, person, 'illness')) {
    const infectionRisk = 0.018 * wound.stage * (person.body.nutrition < 35 ? 2 : 1) * injuryWorseningRiskMultiplier(person);
    if (seededFraction(state.seed, `wound-infection:${atMonth}:${person.id}`) < infectionRisk) {
      const illness: ConditionInstance = { id: `condition-illness-${person.id}-${atMonth}`, kind: 'illness', stage: 1, sinceMonth: atMonth, sourceEventIds: [...wound.sourceEventIds] };
      person.conditions.push(illness);
      const fact = event(state, atMonth, events, 'condition', `${person.name}的伤口引发疾病`, { condition: 'illness', stage: 1 }, person);
      illness.sourceEventIds.push(fact.id);
    }
  }
}

function advanceAging(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const age = atMonth - person.bornAtMonth;
  const baseline = Math.max(1, person.lifespanMonths);
  const ratio = age / baseline;
  const current = condition(state, person, 'aging');
  const targetStage = ratio >= 0.94 ? 3 : ratio >= 0.82 ? 2 : ratio >= 0.66 ? 1 : 0;
  if (!current && targetStage > 0) {
    const pressure = Math.max(0, ratio - 0.66);
    const probability = Math.min(0.35, 0.012 + pressure * 0.22);
    if (seededFraction(state.seed, `aging-enter:${atMonth}:${person.id}`) < probability) {
      const created: ConditionInstance = { id: `condition-aging-${person.id}-${atMonth}`, kind: 'aging', stage: 1, sinceMonth: atMonth, sourceEventIds: [] };
      person.conditions.push(created);
      const fact = event(state, atMonth, events, 'condition', `${person.name}进入衰老第一阶段`, { condition: 'aging', stage: 1, ageMonths: age }, person);
      created.sourceEventIds.push(fact.id);
    }
    return;
  }
  if (!current || targetStage <= current.stage) return;
  const pressure = Math.max(0, ratio - (current.stage === 1 ? 0.82 : 0.94));
  const probability = Math.min(0.45, 0.018 + pressure * 0.28);
  if (seededFraction(state.seed, `aging-progress:${atMonth}:${person.id}:${current.stage}`) >= probability) return;
  current.stage = (current.stage + 1) as 2 | 3;
  const fact = event(state, atMonth, events, 'condition', `${person.name}的衰老进入第 ${current.stage} 阶段`, { condition: 'aging', stage: current.stage, ageMonths: age }, person);
  current.sourceEventIds.push(fact.id);
}

function newborn(state: SimulationState, mother: PersonState, fatherId: string, atMonth: number): { child: PersonState; inheritance: TraitBirthResult } {
  const id = `born-${atMonth}-${mother.id}-${state.people.length}`;
  const father = personById(state, fatherId);
  const sex = createBiologicalSex(state.seed, id);
  const inheritance = personTraitsAtBirth(state.seed, id, sex, mother, father);
  const namingSource = inheritance.matrilinealBirth ? mother : father ?? mother;
  const naming = createNewbornName(state.seed, id, sex, namingSource, state.people.map((person) => person.name));
  const geneticLoad = inheritedGeneticLoad(state, mother, father);
  const average = (field: keyof PersonState['baselineCapacities']) => Math.round((mother.baselineCapacities[field] + (father?.baselineCapacities[field] ?? mother.baselineCapacities[field])) / 2);
  const inheritedCapacity = (field: keyof PersonState['baselineCapacities']) => Math.max(20, average(field) - Math.round(geneticLoad * (5 + deterministicFraction(state.seed, `${id}:genetic:${field}`) * 7)));
  const baselineLifespan = createLifespanMonths(state.seed, id);
  const capacities = applyTraitCapacityModifiers({
    locomotion: inheritedCapacity('locomotion'), manipulation: inheritedCapacity('manipulation'), perception: inheritedCapacity('perception'),
    communication: inheritedCapacity('communication'), cognition: inheritedCapacity('cognition'),
  }, inheritance.traits);
  const child: PersonState = {
    id,
    name: naming.name,
    color: mother.color,
    profile: { description: `${mother.name}与${father?.name ?? '未知者'}的后代` },
    bornAtMonth: atMonth,
    lifespanMonths: applyTraitLifespanModifier(Math.max(36 * 12, Math.round(baselineLifespan * (1 - geneticLoad * 0.18))), inheritance.traits),
    sex,
    familyName: naming.familyName,
    namingTradition: naming.namingTradition,
    geneticParents: [mother.id, fatherId],
    generation: Math.max(mother.generation, father?.generation ?? 0) + 1,
    geneticLoad,
    traits: inheritance.traits,
    position: {
      cellId: mother.position.cellId,
      z: mother.position.z,
      previousCellId: mother.position.cellId,
      previousZ: mother.position.z,
      lastPath: [mother.position.cellId],
      tickPath: [mother.position.cellId],
    },
    body: { health: Math.max(48, 72 - Math.round(geneticLoad * 11)), hydration: 74, nutrition: 76 },
    baselineCapacities: capacities,
    personality: createPersonality(
      state.seed,
      id,
      [mother.personality, ...(father ? [father.personality] : [])],
    ),
    motiveSensitivity: createMotiveSensitivity(state.seed, id),
    cognition: createCognitionState(),
    characterAgenda: createCharacterAgendaState(),
    conditions: [], inventory: [], knowledge: [], knownPlaces: [], memories: [],
    mindMarkdown: createEmptyPersonMindMarkdown(id, atMonth),
    bereavements: [],
    relations: [],
    currentActionText: '依赖身边人的照护', lastDecisionText: '尚不能独立决策',
  };
  return { child, inheritance };
}

export function pregnancyLossChance(person: Pick<PersonState, 'body'>, twinPregnancy: boolean): number {
  const severeBodyDeterioration = person.body.health < 18 || person.body.nutrition < 10;
  if (!severeBodyDeterioration && !twinPregnancy) return 0;
  return Math.min(0.75, (severeBodyDeterioration ? 0.28 : 0) * (twinPregnancy ? 1.5 : 1) + (twinPregnancy ? 0.015 : 0));
}

function recordNewborn(
  state: SimulationState,
  person: PersonState,
  father: PersonState | undefined,
  child: PersonState,
  inheritance: TraitBirthResult,
  atMonth: number,
  events: EnvironmentFact[],
  birth: {
    count: number;
    index: number;
    multipleBirthId?: string;
    twinTraitPersonIds: string[];
    recoveryMonths: number;
    recoveryUntilMonth?: number;
    postpartumSkippedByTrait: boolean;
  },
): EnvironmentFact {
  const parentalKinshipRisk = father ? geneticKinshipRisk(state, person, father) : 0;
  state.people.push(child);
  const multipleLabel = birth.count > 1 ? `（双胞胎第 ${birth.index} 个）` : '';
  const recoveryResult = birth.postpartumSkippedByTrait ? '，魅魔特质使其无需产后恢复' : '，进入产后恢复期';
  const fact = event(state, atMonth, events, 'body', `${person.name}生下了${child.name}${multipleLabel}${recoveryResult}`, {
    bornPersonId: child.id,
    bornPersonName: child.name,
    sex: child.sex,
    familyName: child.familyName,
    namingTradition: child.namingTradition,
    parents: child.geneticParents,
    generation: child.generation,
    parentalKinshipRisk,
    geneticLoad: child.geneticLoad,
    inheritedHealth: child.body.health,
    inheritedCapacities: child.baselineCapacities,
    matrilinealBirth: inheritance.matrilinealBirth,
    namingParentId: inheritance.matrilinealBirth ? person.id : father?.id ?? person.id,
    inheritedTraits: child.traits?.filter((trait) => trait.origin === 'inherited').map((trait) => ({
      id: trait.id,
      name: traitDefinition(trait.id).name,
      inheritedFromPersonIds: trait.inheritedFromPersonIds,
      chance: trait.inheritanceChance,
      sample: trait.inheritanceSample,
    })) ?? [],
    spontaneousTraits: child.traits?.filter((trait) => trait.origin === 'spontaneous').map((trait) => ({
      id: trait.id,
      name: traitDefinition(trait.id).name,
      chance: trait.spontaneousChance,
      sample: trait.spontaneousSample,
    })) ?? [],
    traitInheritanceAttempts: inheritance.attempts,
    traitSpontaneousAttempts: inheritance.spontaneousAttempts,
    twinBirth: birth.count > 1,
    twinTraitPersonIds: birth.twinTraitPersonIds,
    ...(birth.multipleBirthId ? {
      multipleBirthId: birth.multipleBirthId,
      multipleBirthIndex: birth.index,
      multipleBirthCount: birth.count,
    } : {}),
    postpartumRecoveryMonths: birth.recoveryMonths,
    ...(birth.recoveryUntilMonth !== undefined ? { postpartumRecoveryUntilMonth: birth.recoveryUntilMonth } : {}),
    postpartumSkippedByTrait: birth.postpartumSkippedByTrait,
  }, person);
  bindTraitSource(child, fact.id);
  grantProphetKnowledge(child, atMonth, fact.id);
  if (child.geneticLoad >= 0.3) {
    for (const parent of state.people.filter((candidate) => child.geneticParents.includes(candidate.id) && sameLocation(candidate, child))) {
      learnFromInheritedOutcome(parent, child, atMonth, fact.id, 'birth');
    }
  }
  const locallyPerceivedPersonIds = livingPeople(state)
    .filter((candidate) => candidate.id !== child.id && sameLocation(candidate, child))
    .map((candidate) => candidate.id)
    .sort();
  const initialTrust = newbornInitialTrust(child);
  for (const personId of locallyPerceivedPersonIds) {
    applyRelationEvidence(child, personId, fact.id, { trust: initialTrust });
  }
  fact.diff.initialSocialTrust = initialTrust;
  fact.diff.initialSocialTrustPersonIds = locallyPerceivedPersonIds;
  const livingBirthParents = livingPeople(state).filter((candidate) => candidate.id !== child.id
    && child.geneticParents.includes(candidate.id));
  for (const parent of livingBirthParents) {
    applyRelationEvidence(child, parent.id, fact.id, {
      bond: inheritance.matrilinealBirth && parent.id === person.id ? 18 : 12,
    });
  }
  for (const parent of livingBirthParents) {
    applyRelationEvidence(parent, child.id, fact.id, {
      bond: inheritance.matrilinealBirth && parent.id === person.id ? 18 : 12,
    });
  }
  return fact;
}

function advancePregnancies(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const pregnancy = condition(state, person, 'pregnancy');
  if (!pregnancy?.dueAtMonth) return;
  const remaining = pregnancy.dueAtMonth - atMonth;
  pregnancy.stage = remaining <= 2 ? 3 : remaining <= 5 ? 2 : 1;
  const father = pregnancy.otherPersonId ? personById(state, pregnancy.otherPersonId) : undefined;
  const twinTraitPersonIds = [person, ...(father ? [father] : [])]
    .filter((candidate) => hasTrait(candidate, 'twin-bearer'))
    .map((candidate) => candidate.id);
  const twinPregnancy = twinTraitPersonIds.length > 0;
  const lossChance = pregnancyLossChance(person, twinPregnancy);
  if (lossChance > 0) {
    const lossSample = seededFraction(state.seed, `pregnancy-loss:${atMonth}:${person.id}`);
    if (lossSample < lossChance) {
      person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
      event(state, atMonth, events, 'condition', `${person.name}的妊娠过程${twinPregnancy ? '因双生负担与身体风险' : '因身体恶化'}而中止`, {
        pregnancyEnded: true,
        lossChance,
        lossSample,
        twinPregnancy,
        twinTraitPersonIds,
      }, person);
    }
  }
  if (person.body.health < 18 || person.body.nutrition < 10 || !person.conditions.includes(pregnancy)) {
    return;
  }
  if (atMonth < pregnancy.dueAtMonth) return;
  person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
  const postpartumSkippedByTrait = hasTrait(person, 'succubus');
  const minimumReserve = Math.min(person.body.health, person.body.hydration, person.body.nutrition);
  const recoveryMonths = postpartumSkippedByTrait ? 0 : minimumReserve >= 70 ? 9 : minimumReserve >= 50 ? 12 : 15;
  const recoveryUntilMonth = postpartumSkippedByTrait ? undefined : atMonth + recoveryMonths;
  const birthCount = twinPregnancy ? 2 : 1;
  const multipleBirthId = twinPregnancy ? `multiple-birth:${pregnancy.id}:${atMonth}` : undefined;
  const birthFacts: EnvironmentFact[] = [];
  const bornChildren: PersonState[] = [];
  for (let index = 1; index <= birthCount; index += 1) {
    const { child, inheritance } = newborn(state, person, pregnancy.otherPersonId ?? 'unknown', atMonth);
    bornChildren.push(child);
    birthFacts.push(recordNewborn(state, person, father, child, inheritance, atMonth, events, {
      count: birthCount,
      index,
      multipleBirthId,
      twinTraitPersonIds,
      recoveryMonths,
      recoveryUntilMonth,
      postpartumSkippedByTrait,
    }));
  }
  if (!postpartumSkippedByTrait) {
    person.conditions.push({
      id: `condition-postpartum-recovery-${person.id}-${atMonth}`,
      kind: 'postpartum-recovery',
      stage: 3,
      sinceMonth: atMonth,
      endsAtMonth: recoveryUntilMonth,
      sourceEventIds: birthFacts.map((fact) => fact.id),
      otherPersonId: bornChildren[0]?.id,
    });
  }
}

function advancePostpartumRecovery(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const recovery = condition(state, person, 'postpartum-recovery');
  if (!recovery) return;
  const endsAtMonth = recovery.endsAtMonth ?? recovery.sinceMonth + 12;
  if (atMonth >= endsAtMonth) {
    person.conditions = person.conditions.filter((item) => item.id !== recovery.id);
    event(state, atMonth, events, 'condition', `${person.name}结束了产后恢复期`, {
      postpartumRecoveryEnded: true,
      postpartumConditionId: recovery.id,
    }, person);
    return;
  }
  const progress = (atMonth - recovery.sinceMonth) / Math.max(1, endsAtMonth - recovery.sinceMonth);
  recovery.stage = progress < 1 / 3 ? 3 : progress < 2 / 3 ? 2 : 1;
}

type DeathCause = 'body-failure' | 'aging-terminal' | 'triple-sun-vaporization';

function die(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  events: EnvironmentFact[],
  cause: DeathCause,
  options: { sourceEventIds?: string[]; vaporized?: boolean } = {},
): void {
  const healthBeforeDeath = person.body.health;
  person.diedAtMonth = atMonth;
  person.body.health = 0;
  const deathEventId = `e-${atMonth}-environment-death-${events.length}`;
  state.world.remains ??= [];
  const destroyedInventory = options.vaporized
    ? person.inventory.map((stack) => ({
        stackId: stack.id,
        materialId: stack.materialId,
        quantity: stack.quantity,
        ...(stack.recordPayloadId ? { recordPayloadId: stack.recordPayloadId } : {}),
      }))
    : [];
  const estateInventory: Array<{
    sourceStackId: string;
    dropId: string;
    materialId: number;
    quantity: number;
    estateOfPersonId: string;
  }> = [];
  if (options.vaporized) {
    state.world.remains = state.world.remains.filter((remains) => remains.carriedByPersonId !== person.id);
  } else {
    for (const carried of state.world.remains.filter((remains) => remains.carriedByPersonId === person.id)) {
      carried.status = 'exposed';
      carried.position = { cellId: person.position.cellId, z: person.position.z };
      delete carried.carriedByPersonId;
    }
    for (const stack of person.inventory) {
      const estateDrop = addDrop(
        state,
        stack.materialId,
        stack.quantity,
        person.position.cellId,
        atMonth,
        [...new Set([...stack.sourceEventIds, deathEventId])],
        `${person.id}-death`,
        stack.recordPayloadId,
        person.position.z,
        [`inventory:${person.id}:${stack.id}`, ...(stack.sourceLineageKeys ?? [])],
        person.id,
      );
      estateInventory.push({
        sourceStackId: stack.id,
        dropId: estateDrop.id,
        materialId: stack.materialId,
        quantity: stack.quantity,
        estateOfPersonId: person.id,
      });
    }
  }
  person.inventory = [];
  if (!options.vaporized && !state.world.remains.some((remains) => remains.personId === person.id)) state.world.remains.push({
    id: `remains:${person.id}`,
    personId: person.id,
    position: { cellId: person.position.cellId, z: person.position.z },
    status: 'exposed',
    createdAtMonth: atMonth,
    deathEventId,
    sourceEventIds: [deathEventId],
  });
  const dyingDuringHibernation = person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation');
  const hibernationFailedIntentIds: string[] = [];
  const intent = person.activeIntentId ? intentById(state, person.activeIntentId) : undefined;
  const justRestoredAncestorIds = new Set<string>();
  let returnToIntentId = intent?.lastHibernationResumedAtMonth === atMonth ? intent.returnToIntentId : undefined;
  while (returnToIntentId && !justRestoredAncestorIds.has(returnToIntentId)) {
    const ancestor = intentById(state, returnToIntentId);
    if (!ancestor
      || ancestor.ownerId !== person.id
      || ancestor.status !== 'suspended'
      || ancestor.lastHibernationResumedAtMonth !== atMonth) break;
    justRestoredAncestorIds.add(ancestor.id);
    returnToIntentId = ancestor.returnToIntentId;
  }
  const dyingImmediatelyAfterHibernationRestore = justRestoredAncestorIds.size > 0;
  if (intent) {
    intent.status = 'failed';
    intent.blockedReason = options.vaporized
      ? '人物在三日凌空中汽化，无法继续原意图'
      : '人物已经死亡，无法继续原意图';
    recordIntentGoalOutcome(
      state,
      intent,
      intent.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set([...intent.actionEventIds, deathEventId])],
    );
    if (intent.returnToIntentId) {
      intent.returnOutcome = 'parent-unavailable';
      intent.returnResolvedAtMonth = atMonth;
    }
    if (dyingDuringHibernation || dyingImmediatelyAfterHibernationRestore) {
      hibernationFailedIntentIds.push(intent.id);
    }
  }
  for (const suspended of intentsOwnedBy(state, person.id).filter((candidate) => candidate.ownerId === person.id
    && candidate.status === 'suspended')) {
    const hibernationRelated = dyingDuringHibernation
      || Boolean(suspended.suspendedForHibernationConditionId)
      || justRestoredAncestorIds.has(suspended.id);
    suspended.status = 'failed';
    suspended.blockedReason = options.vaporized
      ? '人物在三日凌空中汽化，无法继续暂停意图'
      : hibernationRelated
      ? '人物在休眠 episode 完成恢复前已经死亡'
      : '人物已经死亡，无法继续暂停意图';
    recordIntentGoalOutcome(
      state,
      suspended,
      suspended.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set([...suspended.actionEventIds, deathEventId])],
    );
    if (suspended.returnToIntentId) {
      suspended.returnOutcome = 'parent-unavailable';
      suspended.returnResolvedAtMonth = atMonth;
    }
    delete suspended.suspendedForHibernationConditionId;
    delete suspended.suspendedAtMonth;
    delete suspended.suspendedByIntentId;
    if (hibernationRelated) hibernationFailedIntentIds.push(suspended.id);
  }
  delete person.activeIntentId;
  const causalConditions = person.conditions.flatMap((current) => current.sourceEventIds);
  const sourceEventIds = [...new Set([...causalConditions, ...(options.sourceEventIds ?? [])])].slice(-24);
  const deathFact = event(state, atMonth, events, 'death', options.vaporized
    ? `${person.name}在三日凌空中于第 ${atMonth} 月瞬间汽化，没有留下遗体或遗物`
    : `${person.name}在第 ${atMonth} 月死亡，遗体和私有背包留在原地`, {
    personId: person.id,
    ageMonths: atMonth - person.bornAtMonth,
    cause,
    healthBeforeDeath,
    sourceEventIds,
    ...(!options.vaporized && estateInventory.length ? { estateInventory } : {}),
    ...(options.vaporized ? {
      vaporized: true,
      remainsCreated: false,
      destroyedInventory,
    } : {}),
    ...(hibernationFailedIntentIds.length
      ? { hibernationFailedIntentIds: [...new Set(hibernationFailedIntentIds)] }
      : {}),
  }, person);
  if (options.vaporized) deathFact.planningTick = 1;
  if (deathFact.id !== deathEventId) throw new Error('死亡事实与遗体来源事件顺序不一致');
}

function maintainHibernationIntentSuspension(
  state: SimulationState,
  person: PersonState,
  hibernationConditionId: string,
  atMonth: number,
): { intentId?: string; intentChainIds: string[]; newlySuspended: boolean } {
  const alreadySuspended = intentsOwnedBy(state, person.id).filter((intent) => intent.ownerId === person.id
    && intent.status === 'suspended'
    && intent.suspendedForHibernationConditionId === hibernationConditionId);
  if (alreadySuspended.length) {
    const leaf = alreadySuspended.find((intent) => !intent.suspendedByIntentId)
      ?? alreadySuspended[alreadySuspended.length - 1];
    if (leaf) leaf.suspendedAtMonth = atMonth;
    return {
      intentId: leaf?.id,
      intentChainIds: alreadySuspended.map((intent) => intent.id),
      newlySuspended: false,
    };
  }
  const activeCandidate = person.activeIntentId ? intentById(state, person.activeIntentId) : undefined;
  const active = activeCandidate?.ownerId === person.id && activeCandidate.status === 'active'
    ? activeCandidate
    : undefined;
  if (!active) return { intentChainIds: [], newlySuspended: false };
  active.status = 'suspended';
  const chain = [];
  let current: typeof active | undefined = active;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    current.suspendedForHibernationConditionId = hibernationConditionId;
    if (current.id === active.id) current.suspendedAtMonth = atMonth;
    chain.push(current);
    const parent: Intent | undefined = current.returnToIntentId
      ? intentById(state, current.returnToIntentId)
      : undefined;
    current = parent?.ownerId === person.id && parent.status === 'suspended' ? parent : undefined;
  }
  delete person.activeIntentId;
  return { intentId: active.id, intentChainIds: chain.map((intent) => intent.id), newlySuspended: true };
}

function restoreHibernationSuspendedIntent(
  state: SimulationState,
  person: PersonState,
  hibernationConditionId: string,
  atMonth: number,
): { intentId?: string; status?: string } {
  const suspendedChain = intentsOwnedBy(state, person.id).filter((candidate) => candidate.ownerId === person.id
    && candidate.status === 'suspended'
    && candidate.suspendedForHibernationConditionId === hibernationConditionId);
  const intent = suspendedChain.find((candidate) => !candidate.suspendedByIntentId)
    ?? suspendedChain[suspendedChain.length - 1];
  if (!intent) return {};
  for (const suspended of suspendedChain) {
    delete suspended.suspendedForHibernationConditionId;
    suspended.lastResumedAtMonth = atMonth;
    suspended.lastHibernationResumedAtMonth = atMonth;
    if (suspended.id === intent.id) delete suspended.suspendedAtMonth;
  }
  const project = intent.projectId ? projectById(state, intent.projectId) : undefined;
  if (!isAlive(person)) {
    intent.status = 'failed';
    intent.blockedReason = '人物在休眠恢复完成前已经死亡';
    recordIntentGoalOutcome(
      state,
      intent,
      intent.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set(intent.actionEventIds.length ? intent.actionEventIds : [intent.sourceDecisionEventId])],
    );
  } else if (project?.status === 'completed') {
    intent.status = 'completed';
    intent.progress = 1;
    recordIntentGoalOutcome(
      state,
      intent,
      'achieved',
      atMonth,
      [...new Set(project.completionEventIds.length ? project.completionEventIds : [intent.sourceDecisionEventId])],
    );
  } else if (project?.status === 'blocked') {
    intent.status = 'blocked';
    intent.blockedReason = project.blockedReason ?? '休眠期间项目已经阻塞';
    const sources = [...new Set([...intent.actionEventIds, ...project.failureEventIds])];
    recordIntentGoalOutcome(
      state,
      intent,
      sources.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      sources.length ? sources : [intent.sourceDecisionEventId],
    );
  } else if (project?.status === 'abandoned') {
    intent.status = 'abandoned';
    intent.blockedReason = project.blockedReason ?? '休眠期间项目已经放弃';
    recordIntentGoalOutcome(
      state,
      intent,
      intent.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set(intent.actionEventIds.length ? intent.actionEventIds : [intent.sourceDecisionEventId])],
    );
  } else if (intent.projectId && !project) {
    intent.status = 'abandoned';
    intent.blockedReason = '休眠期间项目已经不存在';
    recordIntentGoalOutcome(
      state,
      intent,
      'not-evaluated',
      atMonth,
      [intent.sourceDecisionEventId],
    );
  } else {
    intent.status = 'active';
    intent.lastResumedAtMonth = atMonth;
    person.activeIntentId = intent.id;
  }
  return { intentId: intent.id, status: intent.status };
}

/**
 * Advance the phase of an existing hibernation episode before anyone acts.
 * Legacy episodes have no phase field and therefore enter here as dormant.
 * Physical recovery remains action-owned; this transition never adds reserves.
 */
export function advanceHibernationRecoveryPhases(
  state: SimulationState,
  atMonth: number,
): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  for (const person of livingPeople(state)) {
    const episode = person.conditions.find((current) => current.kind === 'dehydrated-hibernation');
    if (!episode) continue;
    const suspension = maintainHibernationIntentSuspension(state, person, episode.id, atMonth);
    const phase = hibernationPhase(episode);
    const triggerPrediction = episode.triggerPredictionId
      ? state.eraPredictions.find((prediction) => prediction.id === episode.triggerPredictionId)
      : undefined;
    const predictionInvalidated = Boolean(triggerPrediction
      && (triggerPrediction.status !== 'pending' || atMonth > triggerPrediction.expiresAtMonth));
    const bodyEmergency = person.body.health < 35
      || person.body.hydration < 28
      || person.body.nutrition < 28;
    let result: string | undefined;
    let diff: Record<string, unknown> | undefined;
    if (state.civilization.epoch === 'chaotic' && phase === 'recovering') {
      const completedRecoverySourceEventIds = [...new Set(episode.recoverySourceEventIds ?? [])];
      episode.hibernationPhase = 'dormant';
      delete episode.recoveryStartedAtMonth;
      delete episode.recoverySourceEventIds;
      result = `${person.name}在新乱纪元中沿用原有脱水休眠 episode，再次转入低代谢休眠`;
      diff = {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        phaseFrom: 'recovering',
        phaseTo: 'dormant',
        continuedEpisode: true,
        originalSinceMonth: episode.sinceMonth,
        stage: episode.stage,
        recoverySourceEventIds: completedRecoverySourceEventIds,
        entryHydrationCost: 0,
        ...(suspension.intentId ? { suspendedIntentId: suspension.intentId } : {}),
        ...(suspension.intentChainIds.length > 1 ? { suspendedIntentChainIds: suspension.intentChainIds } : {}),
      };
    } else if (state.civilization.epoch === 'stable'
      && phase === 'dormant'
      && (episode.sinceMonth < state.civilization.era.sinceMonth
        || predictionInvalidated
        || bodyEmergency)
      // Waking restores ordinary metabolism but does not conjure water. A
      // severely dehydrated sleeper may wake only when it can immediately
      // drink carried liquid or reach a currently perceived water access.
      // Otherwise it stays dormant while a visible helper can still form a
      // source-backed rescue project; a stable era alone is not hydration.
      && hasImmediateHibernationHydrationRecovery(state, person)) {
      episode.hibernationPhase = 'recovering';
      episode.recoveryStartedAtMonth = atMonth;
      episode.recoverySourceEventIds = [];
      const recoveryBasis = episode.sinceMonth < state.civilization.era.sinceMonth
        ? 'new-stable-era'
        : predictionInvalidated
          ? 'prediction-invalidated'
          : 'body-emergency';
      result = recoveryBasis === 'prediction-invalidated'
        ? `${person.name}因支撑休眠的预言已经失效，从低代谢休眠转入受限恢复`
        : recoveryBasis === 'body-emergency'
          ? `${person.name}因身体储备已经危及继续休眠，在恒纪元中转入受限恢复`
          : `${person.name}在恒纪元中从低代谢休眠转入受限恢复`;
      diff = {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        phaseFrom: 'dormant',
        phaseTo: 'recovering',
        originalSinceMonth: episode.sinceMonth,
        stage: episode.stage,
        reserveIncrease: 0,
        recoveryBasis,
        ...(triggerPrediction ? {
          hibernationPredictionId: triggerPrediction.id,
          predictionStatus: triggerPrediction.status,
          predictionExpiresAtMonth: triggerPrediction.expiresAtMonth,
        } : {}),
        ...(suspension.intentId ? { suspendedIntentId: suspension.intentId } : {}),
        ...(suspension.intentChainIds.length > 1 ? { suspendedIntentChainIds: suspension.intentChainIds } : {}),
      };
    } else if (state.civilization.epoch === 'stable' && phase === 'recovering') {
      const minimumReserve = Math.min(person.body.health, person.body.hydration, person.body.nutrition);
      const recoverySourceEventIds = [...new Set(episode.recoverySourceEventIds ?? [])];
      if (minimumReserve >= HIBERNATION_RECOVERY_SAFE_RESERVE && recoverySourceEventIds.length > 0) {
        person.conditions = person.conditions.filter((current) => current.id !== episode.id);
        const restoration = restoreHibernationSuspendedIntent(state, person, episode.id, atMonth);
        result = `${person.name}依靠真实补水与进食恢复到安全储备，结束脱水休眠 episode`;
        diff = {
          condition: 'dehydrated-hibernation',
          hibernationConditionId: episode.id,
          exited: true,
          phaseFrom: 'recovering',
          minimumReserve,
          safeReserve: HIBERNATION_RECOVERY_SAFE_RESERVE,
          recoveryStartedAtMonth: episode.recoveryStartedAtMonth,
          recoverySourceEventIds,
          ...(restoration.intentId ? {
            restoredIntentId: restoration.intentId,
            restoredIntentStatus: restoration.status,
          } : {}),
        };
      }
    }
    if (!result && suspension.newlySuspended && suspension.intentId) {
      result = `${person.name}在脱水休眠 episode 中暂停当前意图，等待同一 episode 完成恢复`;
      diff = {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        hibernationPhase: phase,
        hibernationIntentSuspended: true,
        suspendedIntentId: suspension.intentId,
        ...(suspension.intentChainIds.length > 1 ? { suspendedIntentChainIds: suspension.intentChainIds } : {}),
      };
    }
    if (!result || !diff) continue;
    const fact: EnvironmentFact = {
      id: `e-${atMonth}-environment-hibernation-phase-${person.id}-${events.length}`,
      kind: 'environment',
      atMonth,
      orderInMonth: events.length,
      cellId: person.position.cellId,
      change: 'condition',
      who: person.id,
      result,
      diff,
    };
    events.push(fact);
  }
  return events;
}

/**
 * Capture hibernation entered during one of this month's planning ticks. This
 * runs after body/death settlement so a person who died this month cannot
 * leave a newly suspended orphan intent behind.
 */
export function synchronizeHibernationIntentSuspensions(
  state: SimulationState,
  atMonth: number,
): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  for (const person of livingPeople(state)) {
    const episode = person.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
    if (!episode) continue;
    const suspension = maintainHibernationIntentSuspension(state, person, episode.id, atMonth);
    if (!suspension.newlySuspended || !suspension.intentId) continue;
    events.push({
      id: `e-${atMonth}-environment-hibernation-suspension-${person.id}`,
      kind: 'environment',
      atMonth,
      orderInMonth: events.length,
      cellId: person.position.cellId,
      change: 'condition',
      who: person.id,
      result: `${person.name}在本月进入脱水休眠后暂停当前意图`,
      diff: {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        hibernationPhase: hibernationPhase(episode),
        hibernationIntentSuspended: true,
        suspendedIntentId: suspension.intentId,
        ...(suspension.intentChainIds.length > 1
          ? { suspendedIntentChainIds: suspension.intentChainIds }
          : {}),
      },
    });
  }
  return events;
}

export function advanceBodies(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  // A primitive action can reduce health to zero after the month's opening
  // living-person index was built. Such a person is correctly excluded from
  // further actions, but must still enter this settlement pass exactly once
  // so death, remains, estate and intent outcomes become authoritative facts.
  const peopleAtStart = state.people.filter((person) => person.diedAtMonth === undefined);
  const resourceCompetition = humanResourceCompetitionMultiplier(
    peopleAtStart.filter(isAlive).length,
  );
  for (const person of peopleAtStart) {
    if (person.diedAtMonth !== undefined) continue;
    if (person.body.health <= 0) {
      die(state, person, atMonth, events, 'body-failure');
      continue;
    }
    const bodyBefore = { ...person.body };
    advanceInheritedSusceptibility(state, person, atMonth, events);
    const hibernationCondition = person.conditions.find((current) => current.kind === 'dehydrated-hibernation');
    const hibernating = Boolean(hibernationCondition && hibernationPhase(hibernationCondition) === 'dormant');
    const shelter = shelterGeometryAt(state.world.grid, person.position);
    const sheltered = Boolean(shelter);
    const fires = nearbyFires(state, person);
    const fireProtected = fires > 0;
    const clothed = inventoryQuantity(person, Material.Clothing) > 0 || inventoryQuantity(person, Material.LeatherClothing) > 0;
    const climate = state.civilization.climate;
    const weather = state.civilization.weather;
    const shelterColdRelief = (shelter?.weatherProtection ?? 0) / 72 + (shelter?.thermalInsulation ?? 0) / 180;
    const heatReliefFromShelter = shelterHeatRelief(shelter);
    const weatherCold = weather.kind === 'snow' ? weather.intensity * 0.45 : weather.kind === 'storm' && climate.kind === 'cold' ? weather.intensity * 0.18 : 0;
    const weatherHeat = weather.kind === 'drought' ? weather.intensity * 0.38 : 0;
    const hibernationRelief = hibernating ? 0.08 : 1;
    const coldTraitMultiplier = coldHarmMultiplier(person);
    const heatTraitMultiplier = heatHarmMultiplier(person);
    const coldLoad = climate.kind === 'cold'
      ? Math.max(0, climate.severity + weatherCold - shelterColdRelief - (fireProtected ? 2.2 : 0) - (clothed ? 0.9 : 0)) * hibernationRelief * coldTraitMultiplier
      : 0;
    const heatLoad = climate.kind === 'heat' || climate.kind === 'fire'
      ? Math.max(0, climate.severity + weatherHeat - heatReliefFromShelter + (fireProtected ? 0.6 : 0) + (clothed ? 0.25 : 0)) * hibernationRelief * heatTraitMultiplier
      : 0;
    if (coldLoad > 0) clearOppositeExposure(state, person, atMonth, 'cold', events);
    else if (heatLoad > 0) clearOppositeExposure(state, person, atMonth, 'heat', events);
    upsertExposureCondition(state, person, atMonth, 'cold', coldLoad, coldLoad <= 0 && (sheltered || fireProtected), fireProtected, events);
    upsertExposureCondition(state, person, atMonth, 'heat', heatLoad, heatLoad <= 0 && sheltered, false, events);

    const coldCondition = condition(state, person, 'cold')?.stage ?? 0;
    const cold = fireProtected ? Math.max(0, coldCondition - 2) : coldCondition;
    const heat = condition(state, person, 'heat')?.stage ?? 0;
    const wound = condition(state, person, 'wound')?.stage ?? 0;
    const illness = condition(state, person, 'illness')?.stage ?? 0;
    const pregnancy = condition(state, person, 'pregnancy')?.stage ?? 0;
    advancePostpartumRecovery(state, person, atMonth, events);
    const postpartum = condition(state, person, 'postpartum-recovery')?.stage ?? 0;
    advanceAging(state, person, atMonth, events);
    const aging = condition(state, person, 'aging')?.stage ?? 0;
    const heatHydrationExtra = (heat ? 1.35 * ([1, 1.3, 1.7, 2.2][heat] - 1) : 0)
      + (weather.kind === 'drought' ? weather.intensity * 0.18 : 0);
    const coldNutritionExtra = cold ? 1.25 * ([1, 1.25, 1.5, 1.8][cold] - 1) * coldTraitMultiplier : 0;
    const hydrationCost = (hibernating
      ? HIBERNATION_HYDRATION_COST
      : 1.35 + heatHydrationExtra * heatHydrationMultiplier(person) + illness * 0.35 + pregnancy * 0.22 + postpartum * 0.12) * resourceCompetition;
    const nutritionCost = (hibernating
      ? HIBERNATION_NUTRITION_COST
      : 1.25 + coldNutritionExtra + illness * 0.38 + pregnancy * 0.28 + postpartum * 0.18)
      * resourceCompetition
      * nutritionMetabolicMultiplier(person);
    person.body.hydration = clamp(person.body.hydration - hydrationCost);
    person.body.nutrition = clamp(person.body.nutrition - nutritionCost);
    let healthDelta = 0;
    let favorableRecoveryApplied = false;
    if (hibernating) {
      healthDelta -= HIBERNATION_HEALTH_COST;
      if (state.civilization.epoch === 'chaotic' && climate.severity >= 8) healthDelta -= 0.15;
    } else {
      if (person.body.hydration < 10) healthDelta -= 7;
      else if (person.body.hydration < 25) healthDelta -= 2;
      if (person.body.nutrition < 10) healthDelta -= 6;
      else if (person.body.nutrition < 25) healthDelta -= 2;
      if (cold >= 3) healthDelta -= 2 * coldTraitMultiplier;
      if (heat >= 3) healthDelta -= 3 * heatTraitMultiplier;
      healthDelta -= Math.max(0, wound - 1) * 1.5 + Math.max(0, illness - 1) * 1.5;
      if (aging >= 2 && (person.body.hydration < 45 || person.body.nutrition < 45)) healthDelta -= aging === 3 ? 1.5 : 0.5;
      if (person.body.hydration >= 65 && person.body.nutrition >= 65 && (sheltered || fireProtected || climate.kind === 'temperate') && !wound && !illness) {
        favorableRecoveryApplied = true;
        healthDelta += 1.4 * (aging === 1 ? 0.9 : aging === 2 ? 0.65 : aging === 3 ? 0.3 : 1);
      }
    }
    person.body.health = clamp(person.body.health + healthDelta);
    if (hibernationCondition) {
      const hibernationMonths = Math.max(1, atMonth - hibernationCondition.sinceMonth + 1);
      const minimumReserve = Math.min(person.body.health, person.body.hydration, person.body.nutrition);
      const nextStage = hibernationMonths >= 18 || minimumReserve < 30
        ? 3
        : hibernationMonths >= 6 || minimumReserve < 45
          ? 2
          : 1;
      if (nextStage > hibernationCondition.stage) {
        hibernationCondition.stage = nextStage;
        const deterioration = event(state, atMonth, events, 'condition', `${person.name}的长期脱水休眠开始明显消耗身体机能`, {
          condition: 'dehydrated-hibernation',
          hibernationConditionId: hibernationCondition.id,
          hibernationMonths,
          stage: nextStage,
          health: person.body.health,
          hydration: person.body.hydration,
          nutrition: person.body.nutrition,
        }, person);
        hibernationCondition.sourceEventIds = [...new Set([...hibernationCondition.sourceEventIds, deterioration.id])].slice(-24);
      }
      const suspendedIntents = intentsOwnedBy(state, person.id).filter((intent) => intent.ownerId === person.id
        && intent.status === 'suspended'
        && intent.suspendedForHibernationConditionId === hibernationCondition.id);
      const suspendedIntent = suspendedIntents.find((intent) => !intent.suspendedByIntentId)
        ?? suspendedIntents[suspendedIntents.length - 1];
      event(state, atMonth, events, 'body', `${person.name}结算了脱水休眠 episode 的本月身体代价`, {
        hibernationMonthlySettlement: true,
        hibernationConditionId: hibernationCondition.id,
        hibernationPhase: hibernationPhase(hibernationCondition),
        monthlyCostApplied: true,
        metabolicProfile: hibernating ? 'dormant' : 'awake-recovery',
        hydrationCost,
        nutritionCost,
        healthDelta,
        bodyBefore,
        bodyAfter: { ...person.body },
        ...(suspendedIntent ? { suspendedIntentId: suspendedIntent.id } : {}),
      }, person);
    }
    if (!hibernating) recoverInjuries(state, person, atMonth, sheltered || fireProtected, events);
    advancePregnancies(state, person, atMonth, events);
    const ageRatio = (atMonth - person.bornAtMonth) / Math.max(1, person.lifespanMonths);
    const terminalRisk = aging === 3
      ? Math.min(0.42, Math.max(0, ageRatio - 1) * 0.035 + Math.max(0, 45 - person.body.health) * 0.002 + illness * 0.012 + wound * 0.008)
      : 0;
    const terminal = terminalRisk > 0 && seededFraction(state.seed, `aging-terminal:${atMonth}:${person.id}`) < terminalRisk;
    if (person.body.health <= 0 || terminal) die(state, person, atMonth, events, terminal ? 'aging-terminal' : 'body-failure');
    else if (Math.abs(healthDelta) >= 2 || person.body.hydration < 25 || person.body.nutrition < 25) {
      const bodyAfter = { ...person.body };
      const bodyCauseCodes = [
        ...(person.body.hydration < 25 ? ['dehydration'] : []),
        ...(person.body.nutrition < 25 ? ['malnutrition'] : []),
        ...(heat >= 2 ? ['heat-exposure'] : []),
        ...(weather.kind === 'drought' && weather.intensity > 0 ? ['drought'] : []),
        ...(cold > 0 ? ['cold-exposure'] : []),
        ...(illness > 0 ? ['illness'] : []),
        ...(wound > 1 ? ['wound'] : []),
        ...(hibernating ? ['dehydrated-hibernation'] : []),
        ...(aging >= 2 && (person.body.hydration < 45 || person.body.nutrition < 45) ? ['aging'] : []),
        ...(pregnancy > 0 ? ['pregnancy'] : []),
        ...(postpartum > 0 ? ['postpartum-recovery'] : []),
        ...(resourceCompetition > 1 ? ['resource-competition'] : []),
        ...(favorableRecoveryApplied ? ['favorable-recovery'] : []),
      ];
      event(state, atMonth, events, 'body', `${person.name}的身体储备发生显著变化`, {
        health: bodyAfter.health,
        hydration: bodyAfter.hydration,
        nutrition: bodyAfter.nutrition,
        healthDelta,
        hydrationDelta: bodyAfter.hydration - bodyBefore.hydration,
        nutritionDelta: bodyAfter.nutrition - bodyBefore.nutrition,
        bodyBefore,
        bodyAfter,
        bodyCauseCodes,
      }, person);
    }
  }
  return events;
}
