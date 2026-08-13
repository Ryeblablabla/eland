/** 人口领域的确定性基础值；所有时间均直接使用月。 */

export type BiologicalSex = 'female' | 'male';

function hashKey(seed: number, key: string): number {
  let value = (Math.trunc(seed) ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return value >>> 0;
}

export function deterministicFraction(seed: number, key: string): number {
  return hashKey(seed, key) / 0x100000000;
}

export function createBiologicalSex(seed: number, agentId: string): BiologicalSex {
  return deterministicFraction(seed, `sex:${agentId}`) < 0.5 ? 'female' : 'male';
}

/** 开局先民为 10～30 岁，权威值直接以月返回。 */
export function createFounderAgeMonths(seed: number, agentId: string): number {
  return (10 + Math.floor(deterministicFraction(seed, `founder-age:${agentId}`) * 21)) * 12;
}

/** 寿命为 60～100 岁，权威值直接以月返回。 */
export function createLifespanMonths(seed: number, agentId: string, currentAgeMonths = 0): number {
  const sampledMonths = (60 + Math.floor(deterministicFraction(seed, `lifespan:${agentId}`) * 41)) * 12;
  return Math.min(100 * 12, Math.max(sampledMonths, currentAgeMonths + 36));
}
