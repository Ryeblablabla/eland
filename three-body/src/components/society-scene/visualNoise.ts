import * as THREE from 'three';

export function visualSpatialHash(seed: number, x: number, z: number, salt: number): number {
  let value = (
    Math.imul(Math.trunc(seed) + salt, 0x45d9f3b)
    ^ Math.imul(x, 0x27d4eb2d)
    ^ Math.imul(z, 0x165667b1)
  ) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

export function visualSmoothNoise(seed: number, x: number, z: number, scale: number, salt: number): number {
  const gridX = Math.floor(x / scale);
  const gridZ = Math.floor(z / scale);
  const localX = x / scale - gridX;
  const localZ = z / scale - gridZ;
  const smoothX = localX * localX * (3 - 2 * localX);
  const smoothZ = localZ * localZ * (3 - 2 * localZ);
  const top = THREE.MathUtils.lerp(
    visualSpatialHash(seed, gridX, gridZ, salt),
    visualSpatialHash(seed, gridX + 1, gridZ, salt),
    smoothX,
  );
  const bottom = THREE.MathUtils.lerp(
    visualSpatialHash(seed, gridX, gridZ + 1, salt),
    visualSpatialHash(seed, gridX + 1, gridZ + 1, salt),
    smoothX,
  );
  return THREE.MathUtils.lerp(top, bottom, smoothZ);
}
