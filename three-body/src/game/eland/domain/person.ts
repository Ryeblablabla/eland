import type { BiologicalSex } from '../population';
import type { MaterialId } from './material';

export type PersonId = string;
export type ConditionKind = 'cold' | 'heat' | 'wound' | 'illness' | 'pregnancy' | 'restrained';

export interface ConditionInstance {
  id: string;
  kind: ConditionKind;
  stage: 1 | 2 | 3;
  sinceMonth: number;
  sourceEventIds: string[];
  otherPersonId?: PersonId;
  dueAtMonth?: number;
  materialStackId?: string;
}

export interface ItemStack {
  id: string;
  materialId: MaterialId;
  quantity: number;
  sourceEventIds: string[];
}

export interface KnownFact {
  id: string;
  kind: 'observation' | 'technique' | 'claim';
  summary: string;
  confidence: number;
  learnedAtMonth: number;
  sourceEventIds: string[];
}

export interface DirectedRelation {
  personId: PersonId;
  trust: number;
  bond: number;
  fear: number;
  sourceEventIds: string[];
}

export interface PersonState {
  id: PersonId;
  name: string;
  color: string;
  profile: { description: string };
  bornAtMonth: number;
  lifespanMonths: number;
  diedAtMonth?: number;
  sex: BiologicalSex;
  geneticParents: PersonId[];
  generation: number;
  position: { cellId: number; previousCellId: number; lastPath: number[] };
  body: { health: number; hydration: number; nutrition: number };
  baselineCapacities: {
    locomotion: number;
    manipulation: number;
    perception: number;
    communication: number;
    cognition: number;
  };
  driveBias: { affiliation: number; autonomy: number; recognition: number; inquiryCreation: number };
  conditions: ConditionInstance[];
  inventory: ItemStack[];
  knowledge: KnownFact[];
  relations: DirectedRelation[];
  activeIntentId?: string;
  currentActionText: string;
  lastDecisionText: string;
}

export function isAlive(person: PersonState): boolean {
  return person.diedAtMonth === undefined && person.body.health > 0;
}

export function ageMonths(person: PersonState, elapsedMonths: number): number {
  return Math.max(0, elapsedMonths - person.bornAtMonth);
}

export function inventoryQuantity(person: PersonState, materialId: MaterialId): number {
  return person.inventory.reduce((sum, stack) => sum + (stack.materialId === materialId ? stack.quantity : 0), 0);
}

