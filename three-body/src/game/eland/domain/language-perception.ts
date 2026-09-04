import { Material, materialDefinition, type MaterialId } from './material';
import type { StandingPosition, VoxelWorld } from '../world/grid';
import {
  cellX,
  cellY,
  voxelAt,
  voxelWorldRevision,
  WORLD_CELL_COUNT,
} from '../world/grid';
import { seededFraction } from '../world/generator';

export const LANGUAGE_PERCEPTION_VERSION = 'language-perception-v1' as const;
export const LANGUAGE_BROADCAST_VERSION = 'language-broadcast-v2' as const;

export interface LanguageReception {
  version: typeof LANGUAGE_PERCEPTION_VERSION;
  listenerId: string;
  distance: number;
  /** Minimum accumulated material cost from source head voxel to listener. */
  propagationCost: number;
  /** Cost above the same geometric path through open air. */
  obstructionCost: number;
  intelligibility: number;
  detected: boolean;
  decoded: boolean;
}

/**
 * One source string propagated through space. The signal carries no addressee
 * and no authoritative semantic object; each listener may later interpret
 * only the noisy text that reached them.
 */
export interface LanguageBroadcast {
  version: typeof LANGUAGE_BROADCAST_VERSION;
  sourceEventId: string;
  text: string;
  receptions: LanguageReception[];
  perceivedByPersonIds: string[];
  decodedByPersonIds: string[];
}

export interface ListenerLanguageInterpretation {
  version: 'listener-language-interpretation-v1';
  listenerId: string;
  sourceRepresentationId: string;
  kind: string;
}

export function languageInterpretationsFromDiff(
  diff: Readonly<Record<string, unknown>>,
): ListenerLanguageInterpretation[] {
  if (!Array.isArray(diff.listenerInterpretations)) return [];
  return diff.listenerInterpretations.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const interpretation = value as Partial<ListenerLanguageInterpretation>;
    return interpretation.version === 'listener-language-interpretation-v1'
      && typeof interpretation.listenerId === 'string'
      && typeof interpretation.sourceRepresentationId === 'string'
      && typeof interpretation.kind === 'string'
      ? [interpretation as ListenerLanguageInterpretation]
      : [];
  });
}

export function languageInterpreterIds(
  diff: Readonly<Record<string, unknown>>,
  sourceRepresentationId?: string,
): string[] {
  return languageInterpretationsFromDiff(diff)
    .filter((interpretation) => !sourceRepresentationId
      || interpretation.sourceRepresentationId === sourceRepresentationId)
    .map((interpretation) => interpretation.listenerId);
}

export function languageBroadcastFromDiff(
  diff: Readonly<Record<string, unknown>>,
): LanguageBroadcast | undefined {
  const value = diff.languageBroadcast;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const broadcast = value as Partial<LanguageBroadcast>;
  return broadcast.version === LANGUAGE_BROADCAST_VERSION
    && typeof broadcast.sourceEventId === 'string'
    && typeof broadcast.text === 'string'
    && Array.isArray(broadcast.receptions)
    && Array.isArray(broadcast.perceivedByPersonIds)
    && Array.isArray(broadcast.decodedByPersonIds)
    ? broadcast as LanguageBroadcast
    : undefined;
}

export function languageReceptionFor(
  broadcast: LanguageBroadcast | undefined,
  personId: string,
): LanguageReception | undefined {
  return broadcast?.receptions.find((reception) => reception.listenerId === personId);
}

/** The source sees its own line exactly; every other person gets only their signal. */
export function perceivedLanguageText(input: {
  broadcast: LanguageBroadcast;
  observerId: string;
  speakerId: string;
  seed: number;
}): string {
  if (input.observerId === input.speakerId) return input.broadcast.text;
  const reception = languageReceptionFor(input.broadcast, input.observerId);
  return reception
    ? confusePerceivedLanguage(input.broadcast.text, reception, input.seed, input.broadcast.sourceEventId)
    : '';
}

function clampOpenProbability(value: number): number {
  return Math.min(1 - 1e-6, Math.max(1e-6, value));
}

function logit(value: number): number {
  const bounded = clampOpenProbability(value);
  return Math.log(bounded / (1 - bounded));
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/** Continuous spatial distance; vertical separation attenuates voice more strongly. */
export function auditoryDistance(first: StandingPosition, second: StandingPosition): number {
  const dx = cellX(first.cellId) - cellX(second.cellId);
  const dy = cellY(first.cellId) - cellY(second.cellId);
  const dz = (first.z - second.z) * 1.5;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Domain material acoustics. Every material receives a deterministic cost from
 * its actual physical definition; foliage scatters, liquids damp, and dense
 * building solids resist much more than open air.
 */
export function materialLanguageResistance(materialId: MaterialId): number {
  const material = materialDefinition(materialId);
  if (materialId === Material.Air) return 0.72;
  const materialIdentity = material.id * 0.001;
  if (material.phase === 'gas') return 0.9 + material.mass * 0.08 + materialIdentity;
  if (materialId === Material.Leaves) return 2.8 + materialIdentity;
  if (material.tags.includes('plant')) return 2.2 + material.mass * 0.9 + materialIdentity;
  if (material.phase === 'liquid') return 4.4 + material.mass * 0.7 + materialIdentity;
  const density = material.mass * 0.7 + material.hardness * 0.65;
  const insulation = material.tags.includes('insulating') ? 4.5 : 0;
  const building = material.tags.includes('building') ? 2.2 : 0;
  const metal = material.tags.includes('metal') ? 2.8 : 0;
  return 4.2 + density + insulation + building + metal + materialIdentity;
}

interface AcousticHeapNode { voxel: number; cost: number }

interface LanguagePathCache {
  revision: number;
  costsByRouteKey: Map<string, Map<number, number>>;
}

const languagePathCaches = new WeakMap<VoxelWorld, LanguagePathCache>();
const MAX_LANGUAGE_PATH_CACHE_ENTRIES = 256;

class AcousticMinHeap {
  private readonly values: AcousticHeapNode[] = [];

  get size(): number { return this.values.length; }

  push(node: AcousticHeapNode): void {
    let index = this.values.length;
    this.values.push(node);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.cost <= node.cost) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = node;
  }

  pop(): AcousticHeapNode | undefined {
    const first = this.values[0];
    const tail = this.values.pop();
    if (!first || !tail || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right]!.cost < this.values[left]!.cost
        ? right
        : left;
      if (this.values[child]!.cost >= tail.cost) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = tail;
    return first;
  }
}

function headVoxel(world: VoxelWorld, position: StandingPosition): number {
  const z = Math.max(0, Math.min(world.levels - 1, position.z + 1));
  return z * WORLD_CELL_COUNT + position.cellId;
}

function acousticNeighbors(world: VoxelWorld, voxel: number): Array<{ voxel: number; vertical: boolean }> {
  const z = Math.floor(voxel / WORLD_CELL_COUNT);
  const cell = voxel % WORLD_CELL_COUNT;
  const x = cellX(cell);
  const y = cellY(cell);
  const result: Array<{ voxel: number; vertical: boolean }> = [];
  if (x > 0) result.push({ voxel: voxel - 1, vertical: false });
  if (x + 1 < world.width) result.push({ voxel: voxel + 1, vertical: false });
  if (y > 0) result.push({ voxel: voxel - world.width, vertical: false });
  if (y + 1 < world.depth) result.push({ voxel: voxel + world.width, vertical: false });
  if (z > 0) result.push({ voxel: voxel - WORLD_CELL_COUNT, vertical: true });
  if (z + 1 < world.levels) result.push({ voxel: voxel + WORLD_CELL_COUNT, vertical: true });
  return result;
}

function voxelMaterial(world: VoxelWorld, voxel: number): MaterialId {
  const z = Math.floor(voxel / WORLD_CELL_COUNT);
  const cell = voxel % WORLD_CELL_COUNT;
  return voxelAt(world, cellX(cell), cellY(cell), z);
}

/** One Dijkstra wave computes the exact lowest-cost material route to all listeners. */
export function minimumLanguagePathCosts(
  world: VoxelWorld,
  source: StandingPosition,
  listeners: ReadonlyArray<{ id: string; position: StandingPosition }>,
): Map<string, number> {
  const sourceVoxel = headVoxel(world, source);
  const listenerIdsByVoxel = new Map<number, string[]>();
  for (const listener of listeners) {
    const voxel = headVoxel(world, listener.position);
    listenerIdsByVoxel.set(voxel, [...(listenerIdsByVoxel.get(voxel) ?? []), listener.id]);
  }
  if (!listenerIdsByVoxel.size) return new Map();
  const revision = voxelWorldRevision(world);
  let cache = languagePathCaches.get(world);
  if (!cache || cache.revision !== revision) {
    cache = { revision, costsByRouteKey: new Map() };
    languagePathCaches.set(world, cache);
  }
  const routeKey = `${sourceVoxel}|${[...listenerIdsByVoxel.keys()].sort((left, right) => left - right).join(',')}`;
  const cachedCosts = cache.costsByRouteKey.get(routeKey);
  if (cachedCosts) {
    const cachedResult = new Map<string, number>();
    for (const [voxel, listenerIds] of listenerIdsByVoxel) {
      const cost = cachedCosts.get(voxel);
      if (cost === undefined) continue;
      for (const listenerId of listenerIds) cachedResult.set(listenerId, cost);
    }
    return cachedResult;
  }
  const unresolved = new Set(listeners.map((listener) => listener.id));
  const result = new Map<string, number>();
  const costsByTargetVoxel = new Map<number, number>();
  const costs = new Float64Array(world.voxels.length);
  costs.fill(Number.POSITIVE_INFINITY);
  costs[sourceVoxel] = 0;
  const heap = new AcousticMinHeap();
  heap.push({ voxel: sourceVoxel, cost: 0 });
  while (heap.size && unresolved.size) {
    const current = heap.pop()!;
    if (current.cost !== costs[current.voxel]) continue;
    for (const listenerId of listenerIdsByVoxel.get(current.voxel) ?? []) {
      if (!unresolved.delete(listenerId)) continue;
      result.set(listenerId, current.cost);
      costsByTargetVoxel.set(current.voxel, current.cost);
    }
    const currentResistance = materialLanguageResistance(voxelMaterial(world, current.voxel));
    for (const neighbor of acousticNeighbors(world, current.voxel)) {
      const nextResistance = materialLanguageResistance(voxelMaterial(world, neighbor.voxel));
      const stepCost = ((currentResistance + nextResistance) / 2) * (neighbor.vertical ? 1.18 : 1);
      const nextCost = current.cost + stepCost;
      if (nextCost >= costs[neighbor.voxel]!) continue;
      costs[neighbor.voxel] = nextCost;
      heap.push({ voxel: neighbor.voxel, cost: nextCost });
    }
  }
  if (cache.costsByRouteKey.size >= MAX_LANGUAGE_PATH_CACHE_ENTRIES) {
    const oldest = cache.costsByRouteKey.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.costsByRouteKey.delete(oldest);
  }
  cache.costsByRouteKey.set(routeKey, costsByTargetVoxel);
  return result;
}

/**
 * Expected clarity is never exactly zero or one at a finite distance. A
 * replay-stable listener-specific perturbation prevents distance bands from
 * producing identical hearing for everybody standing on the same ring.
 */
export function languageIntelligibility(
  seed: number,
  talkFactId: string,
  speakerId: string,
  listenerId: string,
  propagationCost: number,
  intensity = 1,
): number {
  const reach = 8 + Math.log2(Math.max(0.15, Math.min(2.5, intensity))) * 4;
  const expected = logistic((reach - Math.max(0, propagationCost)) / 2.2);
  const listenerNoise = (seededFraction(
    seed,
    `voice:${talkFactId}:${speakerId}:${listenerId}:clarity`,
  ) - 0.5) * 1.4;
  return clampOpenProbability(logistic(logit(expected) + listenerNoise));
}

export function sampleLanguageReception(input: {
  seed: number;
  talkFactId: string;
  speakerId: string;
  listenerId: string;
  speakerPosition: StandingPosition;
  listenerPosition: StandingPosition;
  propagationCost?: number;
  intensity?: number;
}): LanguageReception {
  const distance = auditoryDistance(input.speakerPosition, input.listenerPosition);
  const propagationCost = input.propagationCost ?? distance * materialLanguageResistance(Material.Air);
  const intelligibility = languageIntelligibility(
    input.seed,
    input.talkFactId,
    input.speakerId,
    input.listenerId,
    propagationCost,
    input.intensity,
  );
  const decoded = seededFraction(
    input.seed,
    `voice:${input.talkFactId}:${input.speakerId}:${input.listenerId}:understood`,
  ) < intelligibility;
  const detected = decoded || seededFraction(
    input.seed,
    `voice:${input.talkFactId}:${input.speakerId}:${input.listenerId}:detected`,
  ) < Math.sqrt(intelligibility);
  return {
    version: LANGUAGE_PERCEPTION_VERSION,
    listenerId: input.listenerId,
    distance: Math.round(distance * 100) / 100,
    propagationCost: Math.round(propagationCost * 100) / 100,
    obstructionCost: Math.round(Math.max(
      0,
      propagationCost - distance * materialLanguageResistance(Material.Air),
    ) * 100) / 100,
    intelligibility: Math.round(intelligibility * 10_000) / 10_000,
    detected,
    decoded,
  };
}

/**
 * Produce exactly what one listener remembers hearing. The acoustic layer may
 * omit fragments but never invent replacement words; semantic mistakes belong
 * to the listener's later interpretation.
 */
export function confusePerceivedLanguage(
  utterance: string,
  reception: Pick<LanguageReception, 'listenerId' | 'intelligibility' | 'detected'>,
  seed: number,
  talkFactId: string,
): string {
  const text = utterance.trim().replace(/\s+/gu, ' ');
  if (!text || !reception.detected) return '';
  const characters = Array.from(text);
  const audibleIndexes = characters.flatMap((character, index) => (
    character.trim() ? [index] : []
  ));
  if (!audibleIndexes.length) return '';
  const kept = new Set(audibleIndexes.filter((index) => seededFraction(
    seed,
    `voice:${talkFactId}:${reception.listenerId}:fragment:${index}`,
  ) < reception.intelligibility));
  if (!kept.size) {
    const fallback = Math.floor(seededFraction(
      seed,
      `voice:${talkFactId}:${reception.listenerId}:fallback-fragment`,
    ) * audibleIndexes.length);
    kept.add(audibleIndexes[Math.min(audibleIndexes.length - 1, fallback)]!);
  }
  let result = '';
  let obscured = false;
  characters.forEach((character, index) => {
    if (!character.trim()) {
      if (!obscured && result && !result.endsWith(' ')) result += ' ';
      return;
    }
    if (kept.has(index)) {
      result += character;
      obscured = false;
      return;
    }
    if (!obscured) result += '…';
    obscured = true;
  });
  return result.trim().replace(/\s*…\s*/gu, '…').replace(/…{2,}/gu, '…');
}

export function broadcastLanguage(input: {
  seed: number;
  sourceFactId: string;
  speakerId: string;
  text: string;
  world: VoxelWorld;
  /** 1 = ordinary emission; below 1 whispers, above 1 calls. */
  intensity?: number;
  speakerPosition: StandingPosition;
  listeners: ReadonlyArray<{ id: string; position: StandingPosition }>;
}): LanguageBroadcast {
  const listeners = input.listeners.filter((listener) => listener.id !== input.speakerId);
  const pathCosts = minimumLanguagePathCosts(input.world, input.speakerPosition, listeners);
  const receptions = listeners
    .map((listener) => sampleLanguageReception({
      seed: input.seed,
      talkFactId: input.sourceFactId,
      speakerId: input.speakerId,
      listenerId: listener.id,
      speakerPosition: input.speakerPosition,
      listenerPosition: listener.position,
      propagationCost: pathCosts.get(listener.id),
      intensity: input.intensity,
    }));
  return {
    version: LANGUAGE_BROADCAST_VERSION,
    sourceEventId: input.sourceFactId,
    text: input.text.trim().replace(/\s+/gu, ' '),
    receptions,
    perceivedByPersonIds: receptions.filter((reception) => reception.detected).map((reception) => reception.listenerId),
    decodedByPersonIds: receptions.filter((reception) => reception.decoded).map((reception) => reception.listenerId),
  };
}
