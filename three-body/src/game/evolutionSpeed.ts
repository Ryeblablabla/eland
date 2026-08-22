export const EVOLUTION_SPEED_MIN = 0.5;
export const EVOLUTION_SPEED_MAX = 10;
export const EVOLUTION_SPEED_STEP = 0.5;
export const DEFAULT_EVOLUTION_SPEED = 1;

export type EvolutionSpeed = number;

export function normalizeEvolutionSpeed(value: number): EvolutionSpeed {
  if (!Number.isFinite(value)) return DEFAULT_EVOLUTION_SPEED;
  const stepped = Math.round(value / EVOLUTION_SPEED_STEP) * EVOLUTION_SPEED_STEP;
  return Math.min(EVOLUTION_SPEED_MAX, Math.max(EVOLUTION_SPEED_MIN, stepped));
}
