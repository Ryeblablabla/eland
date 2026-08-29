import * as THREE from 'three';
import type { EraKey, SocietyState } from '@/game/societyContract';
import { collectDecor, type DecorBucket, type DecorInstance } from '@/game/voxelKits';
import { sameDecorVisuals } from './visualInvalidation';

const SETTLEMENT_ERA_TRANSITION_MS = 1_000;

type DecorRenderLayer = 'stable' | 'settlement-era';
type DecorMaterialSet = Record<string, THREE.MeshStandardMaterial>;

interface DecorBatch {
  mesh: THREE.InstancedMesh;
  bucket: DecorBucket;
  layer: DecorRenderLayer;
  capacity: number;
  keys: Array<string | null>;
  instances: Array<DecorInstance | null>;
  signatures: Array<string | null>;
  slotByKey: Map<string, number>;
}

export interface DecorLayerFrame {
  society: SocietyState;
  animationStartedAt: number;
}

interface DecorLayerOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sunlight: THREE.DirectionalLight;
  fireLights: readonly THREE.PointLight[];
  boxGeometry: THREE.BufferGeometry;
  cellHeight: number;
  monthPlaybackMs: number;
  readFrame: () => DecorLayerFrame;
}

export interface DecorLayer {
  sync(society: SocietyState, era: EraKey): void;
  animate(now: number): void;
  updateTransition(now: number): void;
  dispose(): void;
}

/**
 * 权威状态的纯视觉装饰运行层。collectDecor 仍是唯一事实到装饰实例的投影；
 * 本层只负责实例批次、跨时代淡入淡出和逐帧表现动画。
 */
export function createDecorLayer({
  scene,
  camera,
  sunlight,
  fireLights,
  boxGeometry,
  cellHeight,
  monthPlaybackMs,
  readFrame,
}: DecorLayerOptions): DecorLayer {
  // 素材来自 voxelKits.ts（与 knowledge-base 素材页同源），按材质桶 InstancedMesh 合批。
  // 颜色仍走实例色；材质桶只承载真实表面响应。Record<string> 让素材库可渐进新增语义桶。
  const decorMaterials: DecorMaterialSet = {
    leaf: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.92 }),
    wood: new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, envMapIntensity: 0.74 }),
    groundMark: new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.28 }),
    stone: new THREE.MeshStandardMaterial({ roughness: 0.87, metalness: 0.025, envMapIntensity: 0.86 }),
    plaster: new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.54 }),
    glowWarm: new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xff7a24, emissiveIntensity: 1.2,
      roughness: 0.48, metalness: 0, envMapIntensity: 0.35,
    }),
    glowRed: new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xe62f18, emissiveIntensity: 1.35,
      roughness: 0.48, metalness: 0, envMapIntensity: 0.35,
    }),
    accent: new THREE.MeshPhysicalMaterial({
      roughness: 0.5, metalness: 0.03, clearcoat: 0.22, clearcoatRoughness: 0.52, envMapIntensity: 0.9,
    }),
    // `dark` 只承担金属/深色硬质件；有机暗部由素材层的 organicDark 单独承载。
    dark: new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.9, envMapIntensity: 1.25 }),
    organicDark: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.62 }),
    thatch: new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.52 }),
    roofTile: new THREE.MeshPhysicalMaterial({
      roughness: 0.74, metalness: 0.02, clearcoat: 0.1, clearcoatRoughness: 0.7, envMapIntensity: 0.82,
    }),
  };

  const cloneDecorMaterials = (opacity = 1, fading = false): DecorMaterialSet => Object.fromEntries(
    Object.entries(decorMaterials).map(([key, source]) => {
      const material = source.clone();
      material.opacity = opacity;
      material.transparent = fading;
      material.depthWrite = !fading;
      material.needsUpdate = true;
      return [key, material];
    }),
  );
  const setDecorMaterialOpacity = (materials: DecorMaterialSet, opacity: number, fading: boolean) => {
    for (const material of Object.values(materials)) {
      const nextTransparent = fading;
      const nextDepthWrite = !fading;
      if (material.transparent !== nextTransparent || material.depthWrite !== nextDepthWrite) {
        material.transparent = nextTransparent;
        material.depthWrite = nextDepthWrite;
        material.needsUpdate = true;
      }
      material.opacity = opacity;
    }
  };

  const decorGroup = new THREE.Group();
  const decorBatches = new Map<string, DecorBatch>();
  let settlementDecorMaterials = cloneDecorMaterials();
  let renderedDevelopmentStage: string | undefined;
  let settlementEraTransition: {
    startedAt: number;
    outgoingGroup: THREE.Group;
    outgoingMaterials: DecorMaterialSet;
  } | null = null;
  let animatedDecorBatches: Array<{
    mesh: THREE.InstancedMesh;
    instances: Array<{ index: number; instance: DecorInstance }>;
  }> = [];
  scene.add(decorGroup);

  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  const decorAxisY = new THREE.Vector3(0, 1, 0);

  const decorBatchKey = (bucket: DecorBucket, layer: DecorRenderLayer): string => `${layer}:${bucket}`;
  const disposeOutgoingSettlementDecor = (group: THREE.Group, materials: DecorMaterialSet) => {
    scene.remove(group);
    for (const child of [...group.children]) (child as THREE.InstancedMesh).dispose();
    for (const material of Object.values(materials)) material.dispose();
  };
  const finishSettlementEraTransition = () => {
    if (!settlementEraTransition) return;
    setDecorMaterialOpacity(settlementDecorMaterials, 1, false);
    disposeOutgoingSettlementDecor(
      settlementEraTransition.outgoingGroup,
      settlementEraTransition.outgoingMaterials,
    );
    settlementEraTransition = null;
  };
  const beginSettlementEraTransition = (startedAt: number) => {
    finishSettlementEraTransition();
    const outgoingGroup = new THREE.Group();
    const outgoingMaterials = settlementDecorMaterials;
    setDecorMaterialOpacity(outgoingMaterials, 1, true);
    for (const [key, batch] of [...decorBatches]) {
      if (batch.layer !== 'settlement-era') continue;
      decorGroup.remove(batch.mesh);
      outgoingGroup.add(batch.mesh);
      decorBatches.delete(key);
    }
    scene.add(outgoingGroup);
    settlementDecorMaterials = cloneDecorMaterials(0, true);
    settlementEraTransition = { startedAt, outgoingGroup, outgoingMaterials };
  };
  const finishTransitionFrame = (now: number) => {
    if (!settlementEraTransition) return;
    const progress = THREE.MathUtils.clamp(
      (now - settlementEraTransition.startedAt) / SETTLEMENT_ERA_TRANSITION_MS,
      0,
      1,
    );
    const eased = progress * progress * (3 - 2 * progress);
    setDecorMaterialOpacity(settlementEraTransition.outgoingMaterials, 1 - eased, true);
    setDecorMaterialOpacity(settlementDecorMaterials, eased, true);
    if (progress >= 1) finishSettlementEraTransition();
  };

  const decorInstanceBaseKey = (instance: DecorInstance): string => {
    const entityAnchored = instance.entityId !== undefined;
    const anchorX = instance.entityX ?? instance.x;
    const anchorY = instance.entityY ?? instance.y;
    const anchorZ = instance.entityZ ?? instance.z;
    return [
      entityAnchored ? `entity:${instance.entityId}` : 'static',
      instance.b,
      instance.part ?? '',
      entityAnchored ? instance.x - anchorX : instance.x,
      entityAnchored ? instance.y - anchorY : instance.y,
      entityAnchored ? instance.z - anchorZ : instance.z,
      instance.sx,
      instance.sy,
      instance.sz,
    ].join('|');
  };
  const keyedDecorInstances = (instances: DecorInstance[]) => {
    const occurrences = new Map<string, number>();
    return instances.map((instance) => {
      const base = decorInstanceBaseKey(instance);
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      return { key: `${base}|${occurrence}`, instance };
    });
  };
  const decorInstanceSignature = (instance: DecorInstance): string => [
    instance.x, instance.y, instance.z,
    instance.sx, instance.sy, instance.sz,
    instance.ry ?? '', instance.c,
    instance.entityId ?? '',
    instance.entityX ?? '', instance.entityY ?? '', instance.entityZ ?? '',
    instance.entityRotation ?? '', instance.part ?? '', instance.animation ?? '',
    instance.visualLayer ?? '',
  ].join('|');
  const decorCapacityFor = (required: number): number => {
    let capacity = 16;
    while (capacity < required) capacity *= 2;
    return capacity;
  };
  const createDecorBatch = (bucket: DecorBucket, layer: DecorRenderLayer, capacity: number): DecorBatch => {
    const materials = layer === 'settlement-era' ? settlementDecorMaterials : decorMaterials;
    const material = materials[bucket] ?? materials.plaster;
    const mesh = new THREE.InstancedMesh(boxGeometry, material, capacity);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // 叶簇保留 AO 接触层次，但不再让数百个微体素互相投出致黑阴影。
    mesh.castShadow = bucket !== 'leaf' && bucket !== 'groundMark' && bucket !== 'glowWarm' && bucket !== 'glowRed';
    mesh.receiveShadow = true;
    decorGroup.add(mesh);
    return {
      mesh,
      bucket,
      layer,
      capacity,
      keys: new Array<string | null>(capacity).fill(null),
      instances: new Array<DecorInstance | null>(capacity).fill(null),
      signatures: new Array<string | null>(capacity).fill(null),
      slotByKey: new Map<string, number>(),
    };
  };
  const ensureDecorBatch = (bucket: DecorBucket, layer: DecorRenderLayer, required: number): DecorBatch => {
    const key = decorBatchKey(bucket, layer);
    const current = decorBatches.get(key);
    if (current && current.capacity >= required) return current;
    const replacement = createDecorBatch(bucket, layer, decorCapacityFor(required));
    if (current) {
      decorGroup.remove(current.mesh);
      current.mesh.dispose();
    }
    decorBatches.set(key, replacement);
    return replacement;
  };
  const writeDecorInstance = (
    mesh: THREE.InstancedMesh,
    index: number,
    instance: DecorInstance,
    bucket: DecorBucket,
  ) => {
    const instanceRotation = instance.ry === undefined
      ? rotation.identity()
      : rotation.setFromAxisAngle(decorAxisY, instance.ry);
    matrix.compose(
      position.set(instance.x, instance.y, instance.z),
      instanceRotation,
      scale.set(instance.sx, instance.sy, instance.sz),
    );
    mesh.setMatrixAt(index, matrix);
    color.setHex(instance.c);
    if (bucket === 'leaf' || bucket === 'wood') {
      // 连续空间波形让同一树冠形成成片明暗，而不是每个微体素独立闪烁。
      const cluster = (
        Math.sin(instance.x * 2.13 + instance.z * 1.37 + instance.y * 0.71)
        + Math.sin(instance.x * 0.83 - instance.z * 1.91 + instance.y * 1.17)
      ) * 0.25;
      color.multiplyScalar(1 + cluster * (bucket === 'leaf' ? 0.12 : 0.055));
    }
    mesh.setColorAt(index, color);
  };

  let renderedDecorSociety: SocietyState | null = null;
  let renderedDecorEra: EraKey | null = null;
  const sync = (society: SocietyState, era: EraKey) => {
    if (renderedDecorSociety && renderedDecorEra
      && sameDecorVisuals(renderedDecorSociety, renderedDecorEra, society, era)) {
      renderedDecorSociety = society;
      renderedDecorEra = era;
      return;
    }
    renderedDecorSociety = society;
    renderedDecorEra = era;
    const nextDevelopmentStage = society.observations.civilizationIndex?.stage ?? '原始部落';
    if (renderedDevelopmentStage !== undefined && renderedDevelopmentStage !== nextDevelopmentStage)
      beginSettlementEraTransition(performance.now());
    renderedDevelopmentStage = nextDevelopmentStage;
    const instances = collectDecor(society, era);
    animatedDecorBatches = [];
    const byBatch = new Map<string, {
      bucket: DecorBucket;
      layer: DecorRenderLayer;
      instances: DecorInstance[];
    }>();
    for (const instance of instances) {
      const layer: DecorRenderLayer = instance.visualLayer ?? 'stable';
      const key = decorBatchKey(instance.b, layer);
      const batch = byBatch.get(key);
      if (batch) batch.instances.push(instance);
      else byBatch.set(key, { bucket: instance.b, layer, instances: [instance] });
    }
    const activeBatchKeys = new Set<string>([...decorBatches.keys(), ...byBatch.keys()]);
    for (const batchKey of activeBatchKeys) {
      const definition = byBatch.get(batchKey);
      const current = decorBatches.get(batchKey);
      const bucket = definition?.bucket ?? current?.bucket;
      const layer = definition?.layer ?? current?.layer;
      if (!bucket || !layer) continue;
      const list = definition?.instances ?? [];
      const batch = list.length > 0
        ? ensureDecorBatch(bucket, layer, list.length)
        : current;
      if (!batch) continue;

      const keyed = keyedDecorInstances(list);
      const nextByKey = new Map(keyed.map((entry) => [entry.key, entry.instance]));
      let matrixMin = Number.POSITIVE_INFINITY;
      let matrixMax = -1;
      let colorMin = Number.POSITIVE_INFINITY;
      let colorMax = -1;
      const markMatrixChanged = (index: number) => {
        matrixMin = Math.min(matrixMin, index);
        matrixMax = Math.max(matrixMax, index);
      };
      const markColorChanged = (index: number) => {
        colorMin = Math.min(colorMin, index);
        colorMax = Math.max(colorMax, index);
      };

      for (const [key, slot] of [...batch.slotByKey]) {
        if (nextByKey.has(key)) continue;
        batch.slotByKey.delete(key);
        batch.keys[slot] = null;
        batch.instances[slot] = null;
        batch.signatures[slot] = null;
        matrix.makeScale(0, 0, 0);
        batch.mesh.setMatrixAt(slot, matrix);
        markMatrixChanged(slot);
      }

      const freeSlots: number[] = [];
      for (let slot = 0; slot < batch.capacity; slot++) {
        if (batch.keys[slot] === null) freeSlots.push(slot);
      }
      let freeSlotIndex = 0;
      for (const { key, instance } of keyed) {
        let slot = batch.slotByKey.get(key);
        if (slot === undefined) {
          slot = freeSlots[freeSlotIndex++];
          batch.slotByKey.set(key, slot);
          batch.keys[slot] = key;
        }
        const signature = decorInstanceSignature(instance);
        batch.instances[slot] = instance;
        if (batch.signatures[slot] === signature) continue;
        batch.signatures[slot] = signature;
        writeDecorInstance(batch.mesh, slot, instance, bucket);
        markMatrixChanged(slot);
        markColorChanged(slot);
      }

      let highWater = batch.capacity - 1;
      while (highWater >= 0 && batch.keys[highWater] === null) highWater--;
      batch.mesh.count = highWater + 1;
      if (matrixMax >= matrixMin) {
        batch.mesh.instanceMatrix.clearUpdateRanges();
        batch.mesh.instanceMatrix.addUpdateRange(matrixMin * 16, (matrixMax - matrixMin + 1) * 16);
        batch.mesh.instanceMatrix.needsUpdate = true;
      }
      if (batch.mesh.instanceColor && colorMax >= colorMin) {
        batch.mesh.instanceColor.clearUpdateRanges();
        batch.mesh.instanceColor.addUpdateRange(colorMin * 3, (colorMax - colorMin + 1) * 3);
        batch.mesh.instanceColor.needsUpdate = true;
      }

      const animatedInstances = batch.instances.flatMap((instance, index) => (
        instance && (instance.entityId || instance.animation) ? [{ index, instance }] : []
      ));
      if (animatedInstances.length > 0) animatedDecorBatches.push({ mesh: batch.mesh, instances: animatedInstances });
    }
  };

  const animalAxisY = new THREE.Vector3(0, 1, 0);
  const facilityAxisX = new THREE.Vector3(1, 0, 0);
  const facilityAxisZ = new THREE.Vector3(0, 0, 1);
  const animalRollX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const animalPhaseCache = new Map<string, number>();
  const animalIdleYawCache = new Map<string, number>();
  const animalSeed = (id: string): number => {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
    return (hash >>> 0) / 0x100000000;
  };

  // 火光池逐帧重绑：强度随昼夜（夜间为主、白天熄灭），闪烁相位与火舌动画同源。
  const updateFireLights = (now: number, fireSites: Map<string, { x: number; y: number; z: number }>) => {
    const nightFactor = THREE.MathUtils.clamp(1 - sunlight.intensity / 1.4, 0, 1);
    const sites = [...fireSites.values()].map((site) => {
      const dx = site.x - camera.position.x;
      const dz = site.z - camera.position.z;
      return { ...site, d2: dx * dx + dz * dz };
    }).sort((left, right) => left.d2 - right.d2);
    fireLights.forEach((light, index) => {
      const site = sites[index];
      if (!site || nightFactor <= 0.02) {
        light.visible = false;
        light.intensity = 0;
        return;
      }
      const seed = site.x * 7.31 + site.y * 11.17 + site.z * 5.83;
      const wave = Math.sin(now * 0.009 + seed) + Math.sin(now * 0.015 - seed * 1.7);
      light.visible = true;
      light.position.set(site.x, site.y + 0.38, site.z);
      light.intensity = nightFactor * 2.6 * (0.85 + wave * 0.08);
    });
  };

  // 动物和火焰仍与其他装饰共享 InstancedMesh 合批；带 entityId / animation 的构件逐帧更新矩阵。
  const animate = (now: number) => {
    // 逐帧收集权威火焰装饰的锚点（同一格内的焰心/余烬合并为一个灯位），供火光池使用。
    const fireSites = new Map<string, { x: number; y: number; z: number }>();
    if (!animatedDecorBatches.length) {
      updateFireLights(now, fireSites);
      return;
    }
    const frame = readFrame();
    const world = frame.society.world;
    const animals = new Map(frame.society.animals.map((animal) => [animal.id, animal]));
    const motion = Math.min(1, (now - frame.animationStartedAt) / monthPlaybackMs);

    for (const { mesh, instances } of animatedDecorBatches) {
      let touched = false;
      instances.forEach(({ index, instance }) => {
        if (instance.animation === 'wind') {
          const intensity = Math.max(1, frame.society.weather?.intensity ?? 1);
          const seed = instance.x * 1.83 + instance.z * 2.37 + instance.y * 0.71;
          const sway = Math.sin(now * 0.0028 * (1 + intensity * 0.05) + seed) * Math.min(0.055, 0.012 + intensity * 0.004);
          const heightFactor = THREE.MathUtils.clamp(instance.y * 0.035, 0.2, 1);
          rotation.setFromEuler(new THREE.Euler(sway * heightFactor, 0, sway * 0.7 * heightFactor));
          matrix.compose(
            position.set(
              instance.x + sway * heightFactor * 0.5,
              instance.y,
              instance.z + sway * heightFactor * 0.25,
            ),
            rotation,
            scale.set(instance.sx, instance.sy, instance.sz),
          );
          mesh.setMatrixAt(index, matrix);
          touched = true;
          return;
        }
        if (instance.animation === 'fire') {
          const seed = instance.x * 7.31 + instance.y * 11.17 + instance.z * 5.83;
          const waveA = Math.sin(now * 0.009 + seed);
          const waveB = Math.sin(now * 0.015 - seed * 1.7);
          if (instance.part !== 'fire-spark') {
            const siteKey = `${Math.round(instance.x)}:${Math.round(instance.z)}`;
            const previous = fireSites.get(siteKey);
            if (!previous || instance.y > previous.y) {
              fireSites.set(siteKey, { x: instance.x, y: instance.y, z: instance.z });
            }
          }
          const isSpark = instance.part === 'fire-spark';
          const isEmber = instance.part === 'fire-ember';
          if (isSpark) {
            const rise = ((now * 0.00042 + seed * 0.13) % 1 + 1) % 1;
            const sparkScale = Math.max(0.08, 1 - rise * 0.86);
            matrix.compose(
              position.set(
                instance.x + waveA * 0.025,
                instance.y + rise * 0.24,
                instance.z + waveB * 0.018,
              ),
              rotation.identity(),
              scale.set(
                instance.sx * sparkScale,
                instance.sy * sparkScale,
                instance.sz * sparkScale,
              ),
            );
          } else if (isEmber) {
            const pulse = 0.9 + (waveA + waveB) * 0.06;
            matrix.compose(
              position.set(instance.x, instance.y, instance.z),
              rotation.identity(),
              scale.set(instance.sx * pulse, instance.sy, instance.sz * pulse),
            );
          } else {
            const tipFactor = instance.part === 'fire-tip' ? 1.65 : instance.part === 'fire-mid' ? 1.15 : 0.72;
            const stretch = 1 + waveA * 0.12 + waveB * 0.07;
            const width = 1 - waveA * 0.055;
            matrix.compose(
              position.set(
                instance.x + waveB * 0.018 * tipFactor,
                instance.y + (stretch - 1) * instance.sy * 0.34,
                instance.z + waveA * 0.012 * tipFactor,
              ),
              rotation.identity(),
              scale.set(instance.sx * width, instance.sy * stretch, instance.sz * (2 - width)),
            );
          }
          mesh.setMatrixAt(index, matrix);
          touched = true;
          return;
        }
        if (instance.animation === 'facility-smoke') {
          const seed = instance.x * 5.31 + instance.z * 7.17 + instance.y * 3.83;
          const wave = Math.sin(now * 0.0026 + seed);
          const drift = Math.sin(now * 0.0017 - seed * 1.3);
          const pulse = 0.9 + wave * 0.08;
          matrix.compose(
            position.set(instance.x + drift * 0.035, instance.y + wave * 0.025, instance.z + wave * 0.02),
            rotation.identity(),
            scale.set(instance.sx * pulse, instance.sy * (1.04 + wave * 0.08), instance.sz * pulse),
          );
          mesh.setMatrixAt(index, matrix);
          touched = true;
          return;
        }
        if (instance.animation === 'facility-lift') {
          const lift = (Math.sin(now * 0.0034 + instance.x * 2.1 + instance.z * 1.7) + 1) * 0.055;
          matrix.compose(
            position.set(instance.x, instance.y + lift, instance.z),
            rotation.identity(),
            scale.set(instance.sx, instance.sy, instance.sz),
          );
          mesh.setMatrixAt(index, matrix);
          touched = true;
          return;
        }
        if (instance.animation === 'wheel-spin') {
          const angle = now * 0.0021;
          const originX = instance.entityX ?? instance.x;
          const originY = (instance.entityY ?? instance.y) + 0.5;
          const originZ = instance.entityZ ?? instance.z;
          let localX = instance.x - originX;
          let localY = instance.y - originY;
          let localZ = instance.z - originZ;
          const alongZ = (instance.entityRotation ?? 0) % 2 === 1;
          if (alongZ) {
            const rotatedX = localX * Math.cos(angle) - localY * Math.sin(angle);
            localY = localX * Math.sin(angle) + localY * Math.cos(angle);
            localX = rotatedX;
            rotation.setFromAxisAngle(facilityAxisZ, angle);
          } else {
            const rotatedY = localY * Math.cos(angle) - localZ * Math.sin(angle);
            localZ = localY * Math.sin(angle) + localZ * Math.cos(angle);
            localY = rotatedY;
            rotation.setFromAxisAngle(facilityAxisX, angle);
          }
          matrix.compose(
            position.set(originX + localX, originY + localY, originZ + localZ),
            rotation,
            scale.set(instance.sx, instance.sy, instance.sz),
          );
          mesh.setMatrixAt(index, matrix);
          touched = true;
          return;
        }
        if (instance.animation === 'mill-turn') {
          const angle = now * 0.0018;
          const originX = instance.entityX ?? instance.x;
          const originZ = instance.entityZ ?? instance.z;
          const localX = instance.x - originX;
          const localZ = instance.z - originZ;
          const rotatedX = localX * Math.cos(angle) + localZ * Math.sin(angle);
          const rotatedZ = -localX * Math.sin(angle) + localZ * Math.cos(angle);
          matrix.compose(
            position.set(originX + rotatedX, instance.y, originZ + rotatedZ),
            rotation.setFromAxisAngle(animalAxisY, angle),
            scale.set(instance.sx, instance.sy, instance.sz),
          );
          mesh.setMatrixAt(index, matrix);
          touched = true;
          return;
        }
        if (!instance.entityId) return;
        const animal = animals.get(instance.entityId);
        if (!animal) return;

        const currentX = animal.cellId % world.width;
        const currentZ = Math.floor(animal.cellId / world.width);
        const previousX = animal.previousCellId % world.width;
        const previousZ = Math.floor(animal.previousCellId / world.width);
        const dx = currentX - previousX;
        const dz = currentZ - previousZ;
        const moved = dx !== 0 || dz !== 0 || animal.z !== animal.previousZ;
        const originX = THREE.MathUtils.lerp(previousX, currentX, motion) - world.width / 2 + 0.5;
        const originY = THREE.MathUtils.lerp(animal.previousZ, animal.z, motion) * cellHeight;
        const originZ = THREE.MathUtils.lerp(previousZ, currentZ, motion) - world.height / 2 + 0.5;

        let seed = animalPhaseCache.get(animal.id);
        if (seed === undefined) {
          seed = animalSeed(animal.id) * Math.PI * 2;
          animalPhaseCache.set(animal.id, seed);
          animalIdleYawCache.set(animal.id, Math.floor(animalSeed(`${animal.id}:yaw`) * 4) * -Math.PI / 2);
        }
        const yaw = moved ? -Math.atan2(dz, dx) : (animalIdleYawCache.get(animal.id) ?? 0);
        const activity = animal.activity ?? (moved ? 'walk' : 'idle');
        const activitySpeed = activity === 'flee' ? 1.55 : activity === 'chase' ? 1.42
          : activity === 'attack' ? 1.35 : activity === 'injured' ? 0.58 : 1;
        const phase = now * 0.012 * activitySpeed + seed;
        const walking = moved && motion < 1 && activity !== 'dead';

        let localX = instance.x - (instance.entityX ?? instance.x);
        const localY = instance.y - (instance.entityY ?? instance.y);
        let localZ = instance.z - (instance.entityZ ?? instance.z);
        let partOffsetY = 0;
        if (walking && instance.part?.startsWith('leg-')) {
          const legIndex = Number(instance.part.slice(4)) || 0;
          if (animal.speciesId === 'rabbit') {
            const rabbitStride = Math.sin(phase);
            localX += rabbitStride * (legIndex < 2 ? -0.02 : 0.02);
            partOffsetY += Math.max(0, rabbitStride) * 0.012;
          } else {
            const legPhase = phase + (legIndex % 2 ? Math.PI : 0);
            localX += Math.sin(legPhase) * 0.014;
            partOffsetY += Math.max(0, Math.sin(legPhase)) * 0.009;
          }
        } else if (instance.part === 'head') {
          if (activity === 'graze' || activity === 'feed') {
            partOffsetY -= animal.speciesId === 'deer' ? 0.11 : 0.045;
            localX += animal.speciesId === 'deer' ? 0.025 : 0.012;
          } else partOffsetY += Math.sin(now * 0.0028 + seed) * 0.002;
        } else if (instance.part === 'tail') {
          localZ += Math.sin(
            now * (activity === 'attack' || activity === 'chase' || activity === 'flee' ? 0.012 : 0.006) + seed,
          ) * 0.006;
        }
        if (activity === 'attack') localX += Math.max(0, Math.sin(phase)) * 0.025;
        if (activity === 'injured' && instance.part === 'leg-0') partOffsetY += 0.012;
        const bob = walking
          ? Math.abs(Math.sin(phase)) * (animal.speciesId === 'rabbit' ? 0.022 : 0.007)
          : activity === 'birth' ? Math.abs(Math.sin(now * 0.005 + seed)) * 0.012
            : Math.sin(now * 0.0022 + seed) * 0.001;
        const dead = activity === 'dead';
        if (dead) {
          const rolledY = localZ + 0.09;
          localZ = -localY;
          partOffsetY = rolledY - localY;
        }
        const cos = Math.cos(yaw), sin = Math.sin(yaw);
        const rotatedX = localX * cos + localZ * sin;
        const rotatedZ = -localX * sin + localZ * cos;
        rotation.setFromAxisAngle(animalAxisY, yaw);
        if (dead) rotation.multiply(animalRollX);
        matrix.compose(
          position.set(originX + rotatedX, originY + localY + bob + partOffsetY, originZ + rotatedZ),
          rotation,
          scale.set(instance.sx, instance.sy, instance.sz),
        );
        mesh.setMatrixAt(index, matrix);
        touched = true;
      });
      if (touched) mesh.instanceMatrix.needsUpdate = true;
    }
    updateFireLights(now, fireSites);
  };

  const updateTransition = (now: number) => {
    const warmGlow = 1.2 + 0.18 * Math.sin(now * 0.011) + 0.1 * Math.sin(now * 0.027 + 1.4);
    const redGlow = 1.35 + 0.2 * Math.sin(now * 0.014 + 1) + 0.08 * Math.sin(now * 0.031);
    const materialSets = new Set<DecorMaterialSet>([
      decorMaterials,
      settlementDecorMaterials,
      ...(settlementEraTransition ? [settlementEraTransition.outgoingMaterials] : []),
    ]);
    for (const materials of materialSets) {
      materials.glowWarm.emissiveIntensity = warmGlow;
      materials.glowRed.emissiveIntensity = redGlow;
    }
    finishTransitionFrame(now);
  };

  const dispose = () => {
    animatedDecorBatches = [];
    if (settlementEraTransition) {
      disposeOutgoingSettlementDecor(
        settlementEraTransition.outgoingGroup,
        settlementEraTransition.outgoingMaterials,
      );
      settlementEraTransition = null;
    }
    for (const child of [...decorGroup.children]) (child as THREE.InstancedMesh).dispose();
  };

  return { sync, animate, updateTransition, dispose };
}
