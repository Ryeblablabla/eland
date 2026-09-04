import type { PersonId } from './person';

/**
 * 人物与野生动物之间的绑定轨。
 *
 * 与 Works 同一设计哲学：模型只提议真实接触（喂食、安抚、梳理），
 * 绑定的有无与深浅由规则按"实际做了什么"推导——喂食比徒手有效，
 * 伤害清零，长期不接触自然淡化。绑定不是状态标签，而是一条持续证据轨。
 */

export interface AnimalBondState {
  animalId: string;
  personId: PersonId;
  /** 0..100；达到驯熟阈值后该动物不再把此人当作威胁或猎物。 */
  trust: number;
  /** 有记录的正面接触次数。 */
  contacts: number;
  lastContactAtMonth: number;
  sourceEventIds: string[];
}

export const ANIMAL_BOND_TAME_TRUST = 45;
const MAX_BOND_TRUST = 100;
const MAX_BONDS_PER_PERSON = 8;
const MAX_BOND_SOURCE_EVENTS = 12;

export function animalBond(
  world: { animalBonds?: AnimalBondState[] },
  animalId: string,
  personId: PersonId,
): AnimalBondState | undefined {
  return world.animalBonds?.find((bond) => bond.animalId === animalId && bond.personId === personId);
}

export function animalBondTrust(
  world: { animalBonds?: AnimalBondState[] },
  animalId: string,
  personId: PersonId,
): number {
  return animalBond(world, animalId, personId)?.trust ?? 0;
}

/** 达到驯熟的动物不再逃避或攻击这个人。 */
export function animalIsTameToward(
  world: { animalBonds?: AnimalBondState[] },
  animalId: string,
  personId: PersonId,
): boolean {
  return animalBondTrust(world, animalId, personId) >= ANIMAL_BOND_TAME_TRUST;
}

/**
 * 记录一次真实接触并推导演化后的信任。delta 由执行器按真实行为成分
 * （徒手安抚 / 真实喂食 / 已造成的伤害）计算，不接受模型自报。
 */
export function applyAnimalBondContact(
  world: { animalBonds?: AnimalBondState[] },
  input: {
    animalId: string;
    personId: PersonId;
    trustDelta: number;
    atMonth: number;
    sourceEventId: string;
  },
): AnimalBondState {
  world.animalBonds ??= [];
  const existing = animalBond(world, input.animalId, input.personId);
  const trust = Math.max(0, Math.min(MAX_BOND_TRUST, (existing?.trust ?? 0) + input.trustDelta));
  const next: AnimalBondState = {
    animalId: input.animalId,
    personId: input.personId,
    trust,
    contacts: (existing?.contacts ?? 0) + (input.trustDelta > 0 ? 1 : 0),
    lastContactAtMonth: input.atMonth,
    sourceEventIds: [...(existing?.sourceEventIds ?? []), input.sourceEventId].slice(-MAX_BOND_SOURCE_EVENTS),
  };
  world.animalBonds = world.animalBonds.filter((bond) => !(
    bond.animalId === input.animalId && bond.personId === input.personId
  ));
  world.animalBonds.push(next);
  const overflow = world.animalBonds.filter((bond) => bond.personId === input.personId)
    .sort((a, b) => a.lastContactAtMonth - b.lastContactAtMonth || a.trust - b.trust)
    .slice(0, Math.max(0, world.animalBonds.filter((bond) => bond.personId === input.personId).length - MAX_BONDS_PER_PERSON));
  if (overflow.length) {
    const drop = new Set(overflow.map((bond) => `${bond.animalId}:${bond.personId}`));
    world.animalBonds = world.animalBonds.filter((bond) => !drop.has(`${bond.animalId}:${bond.personId}`));
  }
  return next;
}

/** 清空某个人对某只动物的信任（真实伤害发生时调用）。 */
export function resetAnimalBond(
  world: { animalBonds?: AnimalBondState[] },
  animalId: string,
  personId: PersonId,
): void {
  if (!world.animalBonds?.length) return;
  world.animalBonds = world.animalBonds.filter((bond) => !(
    bond.animalId === animalId && bond.personId === personId
  ));
}

/** 月度淡化：超过六个月没有真实接触的信任每月自然回落。 */
export function advanceAnimalBondsMonth(
  world: { animalBonds?: AnimalBondState[] },
  atMonth: number,
): void {
  if (!world.animalBonds?.length) return;
  world.animalBonds = world.animalBonds.flatMap((bond) => {
    if (atMonth - bond.lastContactAtMonth < 6) return [bond];
    const trust = Math.max(0, bond.trust - 1.5);
    return trust > 0 ? [{ ...bond, trust }] : [];
  });
}
