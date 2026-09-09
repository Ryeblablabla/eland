import type { DecorInstance } from '@/game/voxel-assets/decor-primitives';

/** Offsets from the existing block and a uniform multiplier of its original dimensions. */
export interface DecorAmbientMotion {
  x: number;
  y: number;
  z: number;
  scale: number;
}

/** All blocks belonging to one tree share its existing ground origin. */
export interface DecorWindAnchor {
  x: number;
  y: number;
  z: number;
}

export const DECOR_AMBIENT_FADE_START = 18;
export const DECOR_AMBIENT_CUTOFF = 35;
export const DECOR_SMOKE_CYCLE_MS = 6_200;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smoothstep = (start: number, end: number, value: number): number => {
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
};
const fraction = (value: number): number => value - Math.floor(value);

function reset(result: DecorAmbientMotion): void {
  result.x = 0;
  result.y = 0;
  result.z = 0;
  result.scale = 1;
}

function distanceWeight(distance: number): number {
  return 1 - smoothstep(DECOR_AMBIENT_FADE_START, DECOR_AMBIENT_CUTOFF, distance);
}

/**
 * Recycles only a supplied, already-existing smoke block. Near the camera it
 * grows while rising, then shrinks away before returning to its starting point.
 * Both position and scale meet smoothly at the cycle boundary. Distant blocks
 * retain their original size and location; no particles or geometry are created.
 * windStrength is the caller's once-per-frame weatherSwayStrength(actualWeather).
 */
export function sampleDecorSmoke(
  result: DecorAmbientMotion,
  instance: Readonly<Pick<DecorInstance, 'x' | 'y' | 'z'>>,
  nowMs: number,
  windStrength: number,
  distance: number,
): void {
  reset(result);
  if (distance >= DECOR_AMBIENT_CUTOFF) return;
  const weight = distanceWeight(distance);
  const strength = clamp01(windStrength);
  const phase = fraction(nowMs / DECOR_SMOKE_CYCLE_MS
    + instance.x * 0.37 + instance.y * 1.71 + instance.z * 0.23);
  const birth = smoothstep(0, 0.15, phase);
  const death = 1 - smoothstep(0.68, 0.9, phase);
  // During the last tenth of the cycle the near puff has zero scale, so its
  // smooth return cannot reveal a falling block or a discontinuous restart.
  const returnToOrigin = 1 - smoothstep(0.9, 1, phase);
  const rise = smoothstep(0, 0.9, phase) * returnToOrigin;
  const puffScale = birth * death * (0.72 + phase * 0.65);
  const drift = 0.76 + Math.sin(nowMs * 0.00019 + instance.x * 0.08 + instance.z * 0.06) * 0.24;
  result.x = rise * (0.015 + strength * 0.085) * drift * weight;
  result.y = rise * (0.24 + strength * 0.06) * weight;
  result.z = rise * (0.008 + strength * 0.038) * drift * weight;
  result.scale = 1 + (puffScale - 1) * weight;
}

/**
 * A common low-frequency wind passes through a tree as one coherent bend.
 * The phase depends only on its shared origin, never individual leaf positions.
 * Sample once per tree, then multiply the resulting offset by each block's
 * height above this anchor (clamped to 0..2.2). Blocks keep their original axis
 * alignment and dimensions, and the whole tree shares one distance fade.
 */
export function sampleDecorWind(
  result: DecorAmbientMotion,
  anchor: Readonly<DecorWindAnchor>,
  nowMs: number,
  windStrength: number,
  distance: number,
): void {
  reset(result);
  if (distance >= DECOR_AMBIENT_CUTOFF || windStrength <= 0) return;
  const weight = distanceWeight(distance);
  const strength = clamp01(windStrength);
  const time = nowMs * 0.001;
  const phase = anchor.x * 0.13 + anchor.z * 0.09;
  // Unequal slow frequencies avoid the former uniform metronome-like rocking.
  const gust = Math.sin(time * 0.43 + phase) * 0.58
    + Math.sin(time * 0.17 - phase * 0.4) * 0.27
    + Math.sin(time * 0.89 + phase * 0.7) * 0.15;
  const bend = strength * (0.009 + strength * 0.024) * weight;
  result.x = gust * bend;
  result.z = (gust * 0.43 + Math.sin(time * 0.23 + phase) * 0.14) * bend;
}
