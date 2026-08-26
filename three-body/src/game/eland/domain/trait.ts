import { deterministicFraction } from '../population';
import {
  exertionRules,
  exertionTechniqueId,
  exertionTechniqueSummary,
  exposureRules,
  exposureTechniqueId,
  exposureTechniqueSummary,
  inventoryCombinationRules,
  inventoryCombinationSummary,
  inventoryCombinationTechniqueId,
} from './interaction-rules';
import type { KnownFact, PersonState } from './person';
import type { SimulationState } from './model';
import {
  separationRules,
  separationTechniqueId,
  separationTechniqueSummary,
} from './separation-rules';

export const MAX_INHERITED_PERSON_TRAITS = 3;
export const MAX_SPONTANEOUS_PERSON_TRAITS = 1;
export const MAX_PERSON_TRAITS = MAX_INHERITED_PERSON_TRAITS + MAX_SPONTANEOUS_PERSON_TRAITS;

export const TRAIT_IDS = [
  'demi-immortal',
  'prophet',
  'artificer',
  'wayfarer',
  'insightful',
  'iron-boned',
  'retentive',
  'cold-born',
  'heat-born',
  'matrilineal',
  'succubus',
  'twin-bearer',
  'gluttonous',
] as const;

export type PersonTraitId = typeof TRAIT_IDS[number];

export interface PersonTraitDefinition {
  id: PersonTraitId;
  name: string;
  description: string;
  inheritanceChance: number;
  spontaneousChance?: number;
  spontaneousSex?: PersonState['sex'];
}

export interface PersonTraitState {
  id: PersonTraitId;
  origin: 'founder' | 'inherited' | 'spontaneous';
  inheritedFromPersonIds: string[];
  sourceEventIds: string[];
  inheritanceChance?: number;
  inheritanceSample?: number;
  spontaneousChance?: number;
  spontaneousSample?: number;
}

export interface TraitInheritanceAttempt {
  traitId: PersonTraitId;
  inheritedFromPersonIds: string[];
  chance: number;
  sample: number;
  succeeded: boolean;
  excludedReason?: 'three-trait-limit' | 'opposed-lineage';
}

export interface TraitInheritanceResult {
  traits: PersonTraitState[];
  attempts: TraitInheritanceAttempt[];
  matrilinealBirth: boolean;
}

export interface TraitSpontaneousAttempt {
  traitId: PersonTraitId;
  chance: number;
  sample: number;
  eligible: boolean;
  succeeded: boolean;
  excludedReason?: 'sex-ineligible' | 'one-spontaneous-trait-limit';
}

export interface TraitSpontaneousResult {
  traits: PersonTraitState[];
  attempts: TraitSpontaneousAttempt[];
}

export interface TraitBirthResult extends TraitInheritanceResult {
  spontaneousAttempts: TraitSpontaneousAttempt[];
}

export const PERSON_TRAITS: readonly PersonTraitDefinition[] = [
  { id: 'demi-immortal', name: '半仙', description: '寿命增加 50%，女性婚育年龄上限延长 50%。', inheritanceChance: 0.12 },
  { id: 'prophet', name: '先知', description: '出生时可靠掌握规则库中全部现有配方，但仍受材料、地点与合法行动约束。', inheritanceChance: 0.12 },
  { id: 'artificer', name: '天工', description: '操作 +18、认知 +6、移动 -8。', inheritanceChance: 0.25 },
  { id: 'wayfarer', name: '行者', description: '移动 +18、移动代谢消耗降低 15%、操作 -8。', inheritanceChance: 0.35 },
  { id: 'insightful', name: '洞察', description: '感知 +18、认知 +6、沟通 -6。', inheritanceChance: 0.25 },
  { id: 'iron-boned', name: '铁骨', description: '伤病恶化概率降低 30%，自然恢复概率提高 20%。', inheritanceChance: 0.35 },
  { id: 'retentive', name: '灵记', description: '个人记忆容量与留存时长提高 50%，不会凭空获得知识。', inheritanceChance: 0.25 },
  { id: 'cold-born', name: '寒裔', description: '寒冷伤害降低 40%，炎热造成的额外水分消耗提高 20%。', inheritanceChance: 0.35 },
  { id: 'heat-born', name: '炎裔', description: '炎热伤害及其额外水分消耗降低 35%，寒冷伤害提高 20%。', inheritanceChance: 0.35 },
  { id: 'matrilineal', name: '母脉', description: '激活母姓与母系命名，强化母系遗传、亲子羁绊及母亲首次技术教导。', inheritanceChance: 0.5 },
  { id: 'succubus', name: '魅魔', description: '成年女性可凭单方同意与同地成年男性尝试生育，不受关系、协议、身体储备和家庭准备度门槛限制，分娩后没有产后恢复期。', inheritanceChance: 0, spontaneousChance: 0.03, spontaneousSex: 'female' },
  { id: 'twin-bearer', name: '双生', description: '本人参与形成的妊娠必定诞下双胞胎，但妊娠中止风险提高。', inheritanceChance: 0, spontaneousChance: 0.03 },
  { id: 'gluttonous', name: '饕餮', description: '五项基础能力各提高 20，但每月营养消耗提高 50%。', inheritanceChance: 0, spontaneousChance: 0.03 },
] as const;

const TRAIT_BY_ID = new Map(PERSON_TRAITS.map((trait) => [trait.id, trait]));

export const FIXED_FOUNDER_TRAITS: Readonly<Record<string, readonly PersonTraitId[]>> = {
  laozi: ['demi-immortal'],
  pangu: ['demi-immortal', 'iron-boned'],
  nuwa: ['demi-immortal', 'prophet', 'matrilineal'],
  zhugeliang: ['prophet', 'insightful'],
  athena: ['prophet', 'insightful'],
  prometheus: ['prophet', 'heat-born'],
  leonardo: ['artificer', 'insightful'],
  mozi: ['artificer', 'iron-boned'],
  archimedes: ['artificer'],
  cailun: ['artificer'],
  bisheng: ['artificer', 'retentive'],
  xuanzang: ['wayfarer', 'iron-boned'],
  armstrong: ['wayfarer', 'insightful'],
  darwin: ['wayfarer', 'retentive'],
  'sima-qian': ['retentive'],
  heidi: ['cold-born'],
  change: ['cold-born'],
  nausicaa: ['heat-born', 'insightful'],
  tesla: ['prophet', 'artificer'],
  wuzetian: ['matrilineal'],
  cangtianying: ['prophet', 'cold-born', 'matrilineal'],
  zhaotianli: ['heat-born', 'iron-boned', 'matrilineal'],
  zhentianyuan: ['demi-immortal', 'insightful', 'retentive'],
  potianfeng: ['prophet', 'artificer', 'wayfarer'],
};

export function traitDefinition(id: PersonTraitId): PersonTraitDefinition {
  const definition = TRAIT_BY_ID.get(id);
  if (!definition) throw new Error(`未知特质：${id}`);
  return definition;
}

export function traitStatesOf(person: Pick<PersonState, 'traits'>): PersonTraitState[] {
  return normalizePersonTraits(person.traits ?? []);
}

export function hasTrait(person: Pick<PersonState, 'traits'>, id: PersonTraitId): boolean {
  return (person.traits ?? []).some((trait) => trait.id === id);
}

export function normalizePersonTraits(traits: readonly PersonTraitState[]): PersonTraitState[] {
  const unique = new Map<PersonTraitId, PersonTraitState>();
  for (const trait of traits) {
    if (!TRAIT_BY_ID.has(trait.id) || unique.has(trait.id)) continue;
    unique.set(trait.id, {
      ...trait,
      inheritedFromPersonIds: [...new Set(trait.inheritedFromPersonIds ?? [])],
      sourceEventIds: [...new Set(trait.sourceEventIds ?? [])],
    });
  }
  if (unique.has('cold-born') && unique.has('heat-born')) {
    const coldSample = unique.get('cold-born')?.inheritanceSample ?? 0;
    const heatSample = unique.get('heat-born')?.inheritanceSample ?? 1;
    unique.delete(coldSample <= heatSample ? 'heat-born' : 'cold-born');
  }
  const normalized = [...unique.values()];
  const inherited = normalized.filter((trait) => trait.origin !== 'spontaneous').slice(0, MAX_INHERITED_PERSON_TRAITS);
  const spontaneous = normalized.filter((trait) => trait.origin === 'spontaneous').slice(0, MAX_SPONTANEOUS_PERSON_TRAITS);
  return [...inherited, ...spontaneous];
}

export function founderTraitsFor(personId: string, sourceEventId: string): PersonTraitState[] {
  return (FIXED_FOUNDER_TRAITS[personId] ?? []).slice(0, MAX_INHERITED_PERSON_TRAITS).map((id) => ({
    id,
    origin: 'founder',
    inheritedFromPersonIds: [],
    sourceEventIds: [sourceEventId],
  }));
}

function inheritedChance(
  definition: PersonTraitDefinition,
  motherHas: boolean,
  fatherHas: boolean,
  matrilinealBirth: boolean,
): number {
  if (definition.id === 'matrilineal') return motherHas ? 0.75 : fatherHas ? 0.5 : 0;
  const maternal = motherHas
    ? Math.min(0.9, definition.inheritanceChance * (matrilinealBirth ? 1.5 : 1))
    : 0;
  const paternal = fatherHas ? definition.inheritanceChance : 0;
  return 1 - (1 - maternal) * (1 - paternal);
}

export function inheritPersonTraits(
  seed: number,
  childId: string,
  mother: Pick<PersonState, 'id' | 'traits'>,
  father?: Pick<PersonState, 'id' | 'traits'>,
): TraitInheritanceResult {
  const matrilinealBirth = hasTrait(mother, 'matrilineal') || Boolean(father && hasTrait(father, 'matrilineal'));
  const attempts = PERSON_TRAITS.flatMap((definition): TraitInheritanceAttempt[] => {
    if (definition.inheritanceChance <= 0) return [];
    const motherHas = hasTrait(mother, definition.id);
    const fatherHas = Boolean(father && hasTrait(father, definition.id));
    if (!motherHas && !fatherHas) return [];
    const chance = inheritedChance(definition, motherHas, fatherHas, matrilinealBirth);
    const sample = deterministicFraction(seed, `trait-inheritance:${childId}:${definition.id}`);
    return [{
      traitId: definition.id,
      inheritedFromPersonIds: [
        ...(motherHas ? [mother.id] : []),
        ...(fatherHas && father ? [father.id] : []),
      ],
      chance,
      sample,
      succeeded: sample < chance,
    }];
  });
  const successes = attempts.filter((attempt) => attempt.succeeded);
  const cold = successes.find((attempt) => attempt.traitId === 'cold-born');
  const heat = successes.find((attempt) => attempt.traitId === 'heat-born');
  if (cold && heat) {
    const excluded = cold.sample <= heat.sample ? heat : cold;
    excluded.succeeded = false;
    excluded.excludedReason = 'opposed-lineage';
  }
  const selected = attempts
    .filter((attempt) => attempt.succeeded)
    .sort((left, right) => left.sample - right.sample || left.traitId.localeCompare(right.traitId))
    .slice(0, MAX_INHERITED_PERSON_TRAITS);
  const selectedIds = new Set(selected.map((attempt) => attempt.traitId));
  for (const attempt of attempts) {
    if (attempt.succeeded && !selectedIds.has(attempt.traitId)) {
      attempt.succeeded = false;
      attempt.excludedReason = 'three-trait-limit';
    }
  }
  return {
    matrilinealBirth,
    attempts,
    traits: selected.map((attempt) => ({
      id: attempt.traitId,
      origin: 'inherited',
      inheritedFromPersonIds: attempt.inheritedFromPersonIds,
      sourceEventIds: [],
      inheritanceChance: attempt.chance,
      inheritanceSample: attempt.sample,
    })),
  };
}

export function spontaneousPersonTraits(
  seed: number,
  childId: string,
  sex: PersonState['sex'],
): TraitSpontaneousResult {
  const attempts = PERSON_TRAITS.flatMap((definition): TraitSpontaneousAttempt[] => {
    if (!definition.spontaneousChance) return [];
    const eligible = !definition.spontaneousSex || definition.spontaneousSex === sex;
    const sample = deterministicFraction(seed, `trait-spontaneous:${childId}:${definition.id}`);
    return [{
      traitId: definition.id,
      chance: eligible ? definition.spontaneousChance : 0,
      sample,
      eligible,
      succeeded: eligible && sample < definition.spontaneousChance,
      ...(!eligible ? { excludedReason: 'sex-ineligible' as const } : {}),
    }];
  });
  const selected = attempts
    .filter((attempt) => attempt.succeeded)
    .sort((left, right) => left.sample / left.chance - right.sample / right.chance || left.traitId.localeCompare(right.traitId))
    .slice(0, MAX_SPONTANEOUS_PERSON_TRAITS);
  const selectedIds = new Set(selected.map((attempt) => attempt.traitId));
  for (const attempt of attempts) {
    if (attempt.succeeded && !selectedIds.has(attempt.traitId)) {
      attempt.succeeded = false;
      attempt.excludedReason = 'one-spontaneous-trait-limit';
    }
  }
  return {
    attempts,
    traits: selected.map((attempt) => ({
      id: attempt.traitId,
      origin: 'spontaneous',
      inheritedFromPersonIds: [],
      sourceEventIds: [],
      spontaneousChance: attempt.chance,
      spontaneousSample: attempt.sample,
    })),
  };
}

export function personTraitsAtBirth(
  seed: number,
  childId: string,
  sex: PersonState['sex'],
  mother: Pick<PersonState, 'id' | 'traits'>,
  father?: Pick<PersonState, 'id' | 'traits'>,
): TraitBirthResult {
  const inherited = inheritPersonTraits(seed, childId, mother, father);
  const spontaneous = spontaneousPersonTraits(seed, childId, sex);
  return {
    ...inherited,
    traits: normalizePersonTraits([...inherited.traits, ...spontaneous.traits]),
    spontaneousAttempts: spontaneous.attempts,
  };
}

export function applyTraitCapacityModifiers(
  capacities: PersonState['baselineCapacities'],
  traits: readonly PersonTraitState[],
): PersonState['baselineCapacities'] {
  const ids = new Set(traits.map((trait) => trait.id));
  const adjusted = { ...capacities };
  if (ids.has('artificer')) {
    adjusted.manipulation += 18;
    adjusted.cognition += 6;
    adjusted.locomotion -= 8;
  }
  if (ids.has('wayfarer')) {
    adjusted.locomotion += 18;
    adjusted.manipulation -= 8;
  }
  if (ids.has('insightful')) {
    adjusted.perception += 18;
    adjusted.cognition += 6;
    adjusted.communication -= 6;
  }
  if (ids.has('gluttonous')) {
    for (const key of Object.keys(adjusted) as Array<keyof typeof adjusted>) adjusted[key] += 20;
  }
  for (const key of Object.keys(adjusted) as Array<keyof typeof adjusted>) {
    adjusted[key] = Math.max(0, Math.min(100, adjusted[key]));
  }
  return adjusted;
}

export function applyTraitLifespanModifier(lifespanMonths: number, traits: readonly PersonTraitState[]): number {
  return traits.some((trait) => trait.id === 'demi-immortal') ? Math.round(lifespanMonths * 1.5) : lifespanMonths;
}

export function reproductiveUpperAgeMonths(person: Pick<PersonState, 'traits'>): number {
  return (hasTrait(person, 'demi-immortal') ? 45 * 1.5 : 45) * 12;
}

export function movementMetabolicMultiplier(person: Pick<PersonState, 'traits'>): number {
  return hasTrait(person, 'wayfarer') ? 0.85 : 1;
}

export function nutritionMetabolicMultiplier(person: Pick<PersonState, 'traits'>): number {
  return hasTrait(person, 'gluttonous') ? 1.5 : 1;
}

export function injuryWorseningRiskMultiplier(person: Pick<PersonState, 'traits'>): number {
  return hasTrait(person, 'iron-boned') ? 0.7 : 1;
}

export function injuryRecoveryMultiplier(person: Pick<PersonState, 'traits'>): number {
  return hasTrait(person, 'iron-boned') ? 1.2 : 1;
}

export function memoryCapacityMultiplier(person: Pick<PersonState, 'traits'>): number {
  return hasTrait(person, 'retentive') ? 1.5 : 1;
}

export function memoryDurationMultiplier(person: Pick<PersonState, 'traits'>): number {
  return hasTrait(person, 'retentive') ? 1.5 : 1;
}

export function coldHarmMultiplier(person: Pick<PersonState, 'traits'>): number {
  if (hasTrait(person, 'cold-born')) return 0.6;
  if (hasTrait(person, 'heat-born')) return 1.2;
  return 1;
}

export function heatHarmMultiplier(person: Pick<PersonState, 'traits'>): number {
  return hasTrait(person, 'heat-born') ? 0.65 : 1;
}

export function heatHydrationMultiplier(person: Pick<PersonState, 'traits'>): number {
  if (hasTrait(person, 'heat-born')) return 0.65;
  if (hasTrait(person, 'cold-born')) return 1.2;
  return 1;
}

export function prophetRecipeKnowledge(atMonth: number, sourceEventId: string): KnownFact[] {
  if (!sourceEventId) return [];
  return [
    ...inventoryCombinationRules().map((rule) => ({
      id: inventoryCombinationTechniqueId(rule),
      summary: inventoryCombinationSummary(rule),
    })),
    ...exertionRules().map((rule) => ({ id: exertionTechniqueId(rule), summary: exertionTechniqueSummary(rule) })),
    ...exposureRules().map((rule) => ({ id: exposureTechniqueId(rule), summary: exposureTechniqueSummary(rule) })),
    ...separationRules().map((rule) => ({ id: separationTechniqueId(rule), summary: separationTechniqueSummary(rule) })),
  ].map(({ id, summary }) => ({
    id,
    kind: 'technique' as const,
    summary,
    confidence: 100,
    learnedAtMonth: atMonth,
    sourceEventIds: [sourceEventId],
  }));
}

export function grantProphetKnowledge(person: PersonState, atMonth: number, sourceEventId: string): void {
  if (!hasTrait(person, 'prophet')) return;
  for (const recipe of prophetRecipeKnowledge(atMonth, sourceEventId)) {
    const known = person.knowledge.find((fact) => fact.id === recipe.id);
    if (known) {
      known.confidence = Math.max(known.confidence, recipe.confidence);
      known.sourceEventIds = [...new Set([...known.sourceEventIds, sourceEventId])].slice(-24);
    } else person.knowledge.push(recipe);
  }
}

export function bindTraitSource(person: PersonState, sourceEventId: string): void {
  for (const trait of person.traits ?? []) {
    trait.sourceEventIds = [...new Set([...trait.sourceEventIds, sourceEventId])];
  }
}

export function maternalFirstTeachingConfidence(
  state: SimulationState,
  mother: PersonState,
  child: PersonState,
): number {
  const matrilinealBirth = hasTrait(child, 'matrilineal') || state.people.some((parent) => (
    child.geneticParents.includes(parent.id) && hasTrait(parent, 'matrilineal')
  ));
  if (!matrilinealBirth || mother.sex !== 'female' || !child.geneticParents.includes(mother.id)) return 60;
  if ((child.maternalTeachingSourceEventIds ?? []).length > 0) return 60;
  return 72;
}
