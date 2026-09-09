import * as THREE from 'three';
import type { SocietyState } from '@/game/societyContract';
import { featureDepth, FUNCTIONAL_MODEL_KEYS } from '@/game/voxel-assets/surface-decoration';

export const CONTACT_GROUNDING_CAPACITY = 256;
export const CONTACT_GROUNDING_CUTOFF = 34;
const FADE_START = 18;
const GROUND_BIAS = 0.005;
const RESELECT_MS = 150;

interface ContactCandidate {
  cellId: number;
  x: number;
  y: number;
  z: number;
  size: number;
  strength: number;
  kind: 'housing' | 'tree' | 'supply';
  distanceSquared: number;
}

export interface ContactGroundingStats {
  candidates: number;
  instances: number;
  housing: number;
  trees: number;
  supplies: number;
  skippedSupplies: number;
}

export interface ContactGrounding {
  object: THREE.InstancedMesh;
  sync(society: SocietyState): void;
  update(now: number): void;
  stats(): Readonly<ContactGroundingStats>;
  dispose(): void;
}

function makeContactTexture(): THREE.DataTexture {
  const side = 32;
  const pixels = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    // Chebyshev distance makes a soft square footprint, never a dark circular disk.
    const edge = Math.max(Math.abs((x + 0.5) / side * 2 - 1), Math.abs((y + 0.5) / side * 2 - 1));
    const t = THREE.MathUtils.clamp((edge - 0.12) / 0.83, 0, 1);
    const alpha = (1 - t * t * (3 - 2 * t)) * 0.65;
    const index = (y * side + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
    pixels[index + 3] = Math.round(alpha * 255);
  }
  const texture = new THREE.DataTexture(pixels, side, side, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** A single, non-pickable batch beneath objects already present in the read model. */
export function createContactGrounding(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  cellHeight: number,
): ContactGrounding {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const strengths = new THREE.InstancedBufferAttribute(new Float32Array(CONTACT_GROUNDING_CAPACITY), 1);
  strengths.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('contactStrength', strengths);
  const texture = makeContactTexture();
  const material = new THREE.MeshBasicMaterial({
    color: 0x32382d,
    map: texture,
    transparent: true,
    opacity: 0.18,
    alphaTest: 0.003,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float contactStrength;
varying float vContactStrength;
varying float vContactDistance;
${shader.vertexShader}`.replace('#include <project_vertex>', `#include <project_vertex>
vContactStrength = contactStrength;
vContactDistance = length(mvPosition.xyz);`);
    shader.fragmentShader = `varying float vContactStrength;
varying float vContactDistance;
${shader.fragmentShader}`.replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
diffuseColor.a *= vContactStrength * (1.0 - smoothstep(${FADE_START.toFixed(1)}, ${CONTACT_GROUNDING_CUTOFF.toFixed(1)}, vContactDistance));`);
  };
  material.customProgramCacheKey = () => 'eland-contact-grounding-v1';
  const object = new THREE.InstancedMesh(geometry, material, CONTACT_GROUNDING_CAPACITY);
  object.name = 'static-contact-grounding';
  object.count = 0;
  object.visible = false;
  object.castShadow = false;
  object.receiveShadow = false;
  object.frustumCulled = false; // Selection already bounds the batch to the camera's local area.
  object.raycast = () => {};
  object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(object);

  const counters: ContactGroundingStats = { candidates: 0, instances: 0, housing: 0, trees: 0, supplies: 0, skippedSupplies: 0 };
  const candidates: ContactCandidate[] = [];
  const nearby: ContactCandidate[] = [];
  const selected: ContactCandidate[] = [];
  const cameraPosition = new THREE.Vector3();
  const selectedFrom = new THREE.Vector3(Infinity, Infinity, Infinity);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  let worldRef: SocietyState['world'] | null = null;
  let structuresRef: SocietyState['structures'] | null = null;
  let dropsRef: SocietyState['drops'] | null = null;
  let containersRef: SocietyState['containers'] | null = null;
  let dirty = true;
  let lastSelectionAt = -Infinity;

  const sync = (society: SocietyState): void => {
    const world = society.world;
    if (world === worldRef && society.structures === structuresRef
      && society.drops === dropsRef && society.containers === containersRef) return;
    worldRef = world;
    structuresRef = society.structures;
    dropsRef = society.drops;
    containersRef = society.containers;
    candidates.length = 0;
    counters.skippedSupplies = 0;
    const count = world.width * world.height;
    const constructionCells = new Set<number>();
    const completeFloors = new Map<number, number>();
    const housingCells = new Set<number>();
    for (const structure of society.structures) {
      if (structure.workId) continue;
      const functional = (structure.materialIds ?? []).some((id) => FUNCTIONAL_MODEL_KEYS.has(world.palette[id]?.key ?? ''));
      if (!functional) for (const id of structure.occupiedCells) constructionCells.add(id);
      if (!structure.complete || !structure.interiorPositions.length) continue;
      // Match the renderer's lowest known interior floor for each occupied cell.
      const fallback = Math.min(...structure.interiorPositions.map((p) => p.z));
      const perCell = new Map<number, number>();
      for (const p of structure.interiorPositions) perCell.set(p.cellId, Math.min(perCell.get(p.cellId) ?? Infinity, p.z));
      for (const id of structure.occupiedCells) {
        const z = perCell.get(id) ?? fallback;
        if (id < 0 || id >= count || z <= 0 || z >= world.levels) continue;
        completeFloors.set(id, Math.min(completeFloors.get(id) ?? Infinity, z));
        if (!functional) housingCells.add(id);
      }
    }
    const groundHeight = (id: number): number | undefined => {
      if (id < 0 || id >= count) return undefined;
      const floor = completeFloors.get(id);
      if (floor !== undefined) return floor;
      const column = world.columns[id];
      if (!column?.length) return undefined;
      // Compressed air gaps do not locate an unknown floor. Leave those objects to AO.
      if (column.length !== world.elevation[id] + 1) return undefined;
      const depth = featureDepth(world, id, constructionCells);
      const support = world.palette[column[depth]];
      if (!support || (!support.tags.includes('ground') && support.key !== 'plank' && support.key !== 'ice'
        && !(support.tags.includes('plant') && support.key !== 'wood' && support.key !== 'leaves'))) return undefined;
      return world.elevation[id] - depth + 1;
    };
    const byCell = new Map<number, ContactCandidate>();
    const add = (id: number, height: number, size: number, strength: number, kind: ContactCandidate['kind']): void => {
      if (byCell.has(id)) return; // A house/tree/combined pile receives at most one footprint per cell.
      byCell.set(id, {
        cellId: id, x: id % world.width - world.width / 2 + 0.5,
        y: height * cellHeight + GROUND_BIAS,
        z: Math.floor(id / world.width) - world.height / 2 + 0.5,
        size, strength, kind, distanceSquared: 0,
      });
    };
    for (const id of housingCells) add(id, completeFloors.get(id)!, 0.96, 1, 'housing');
    for (let id = 0; id < count; id++) {
      const column = world.columns[id];
      if (world.palette[column?.[0]]?.key !== 'leaves' || world.palette[column?.[1]]?.key !== 'wood') continue;
      const height = groundHeight(id);
      if (height !== undefined) add(id, height, 0.58, 0.82, 'tree');
    }
    const supplies = new Map<number, number>();
    const addSupply = (id: number, z: number, quantity: number): void => {
      const height = groundHeight(id);
      if (height === undefined || Math.abs(z - height) > 0.001) {
        counters.skippedSupplies++;
        return;
      }
      supplies.set(id, (supplies.get(id) ?? 0) + Math.max(0, quantity));
    };
    for (const drop of society.drops) if (drop.quantity > 0) addSupply(drop.cellId, drop.z, drop.quantity);
    for (const container of society.containers) {
      if (container.workId) continue; // Contained matter belongs to existing Work voxels, not a ground pile.
      if (world.palette[container.materialId]?.key === 'granary') continue; // The renderer uses the facility model, not a pile here.
      addSupply(container.cellId, container.z, Math.max(1, container.usedCapacity));
    }
    for (const [id, quantity] of supplies) add(id, groundHeight(id)!, Math.min(0.86, 0.62 + Math.sqrt(quantity) * 0.025), 0.72, 'supply');
    candidates.push(...byCell.values());
    counters.candidates = candidates.length;
    counters.housing = counters.trees = counters.supplies = 0;
    for (const candidate of candidates) {
      if (candidate.kind === 'housing') counters.housing++;
      else if (candidate.kind === 'tree') counters.trees++;
      else counters.supplies++;
    }
    dirty = true;
  };

  const update = (now: number): void => {
    camera.getWorldPosition(cameraPosition);
    const movement = cameraPosition.distanceToSquared(selectedFrom);
    if (!dirty && movement < 0.35 ** 2) return;
    if (!dirty && now - lastSelectionAt < RESELECT_MS && movement < 1) return;
    lastSelectionAt = now;
    selectedFrom.copy(cameraPosition);
    nearby.length = 0;
    for (const candidate of candidates) {
      const dx = candidate.x - cameraPosition.x, dy = candidate.y - cameraPosition.y, dz = candidate.z - cameraPosition.z;
      candidate.distanceSquared = dx * dx + dy * dy + dz * dz;
      if (candidate.distanceSquared < CONTACT_GROUNDING_CUTOFF ** 2) nearby.push(candidate);
    }
    nearby.sort((a, b) => a.distanceSquared - b.distanceSquared || a.cellId - b.cellId);
    if (nearby.length > CONTACT_GROUNDING_CAPACITY) nearby.length = CONTACT_GROUNDING_CAPACITY;
    // Keep slots stable while only their camera-distance order changes.
    nearby.sort((a, b) => a.cellId - b.cellId);
    const changed = dirty || nearby.length !== selected.length || nearby.some((candidate, index) => candidate !== selected[index]);
    dirty = false;
    if (!changed) return;
    selected.length = 0;
    for (let i = 0; i < nearby.length; i++) {
      const candidate = nearby[i];
      selected.push(candidate);
      matrix.compose(position.set(candidate.x, candidate.y, candidate.z), rotation, scale.set(candidate.size, 1, candidate.size));
      object.setMatrixAt(i, matrix);
      strengths.setX(i, candidate.strength);
    }
    object.count = nearby.length;
    object.visible = nearby.length > 0;
    object.instanceMatrix.needsUpdate = true;
    strengths.needsUpdate = true;
    counters.instances = nearby.length;
  };

  const dispose = (): void => {
    scene.remove(object);
    object.dispose();
    geometry.dispose();
    material.dispose();
    texture.dispose();
    candidates.length = nearby.length = selected.length = 0;
    worldRef = structuresRef = dropsRef = containersRef = null;
  };

  return { object, sync, update, stats: () => counters, dispose };
}
