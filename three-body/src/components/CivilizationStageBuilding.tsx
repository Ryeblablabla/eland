import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  civilizationStagePreview,
  type DecorBucket,
  type DecorInstance,
} from '@/game/voxelKits';

interface Props {
  stage: string;
}

const CAST_SHADOW = new Set<DecorBucket>([
  'leaf', 'wood', 'organicDark', 'stone', 'plaster', 'thatch', 'roofTile', 'accent', 'dark',
]);

function stageMaterials(): Record<DecorBucket, THREE.MeshStandardMaterial> {
  return {
    leaf: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }),
    wood: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }),
    organicDark: new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }),
    groundMark: new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }),
    stone: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 }),
    plaster: new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }),
    thatch: new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }),
    roofTile: new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.02 }),
    accent: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }),
    dark: new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.9 }),
    glowWarm: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xff7a24,
      emissiveIntensity: 1.25,
      roughness: 0.5,
    }),
    glowRed: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xe62f18,
      emissiveIntensity: 1.4,
      roughness: 0.5,
    }),
  };
}

function addInstanceMesh(
  parent: THREE.Group,
  geometry: THREE.BoxGeometry,
  material: THREE.Material,
  instances: DecorInstance[],
  bucket: DecorBucket,
): void {
  const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  instances.forEach((instance, index) => {
    position.set(instance.x, instance.y, instance.z);
    rotation.setFromAxisAngle(up, instance.ry ?? 0);
    scale.set(instance.sx, instance.sy, instance.sz);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, new THREE.Color(instance.c));
  });
  mesh.castShadow = CAST_SHADOW.has(bucket);
  mesh.receiveShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  parent.add(mesh);
}

function addStudioEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 0, 128);
  gradient.addColorStop(0, '#3a4356');
  gradient.addColorStop(0.5, '#232a36');
  gradient.addColorStop(1, '#12151b');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(texture);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose();
  texture.dispose();
  return environment;
}

export function CivilizationStageBuilding({ stage }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => civilizationStagePreview(stage), [stage]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const environment = addStudioEnvironment(scene, renderer);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 120);
    const monument = new THREE.Group();
    scene.add(monument);

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const materials = stageMaterials();
    for (const bucket of Object.keys(materials) as DecorBucket[]) {
      const instances = preview.instances.filter((instance) => instance.b === bucket);
      if (instances.length) addInstanceMesh(monument, geometry, materials[bucket], instances, bucket);
    }

    const bounds = new THREE.Box3().setFromObject(monument);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    monument.position.set(-center.x, -bounds.min.y, -center.z);
    monument.rotation.y = -0.55;
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const target = new THREE.Vector3(0, size.y * 0.42, 0);

    const sun = new THREE.DirectionalLight(0xfff0dc, 2.8);
    sun.position.set(radius * 4, radius * 6.2, radius * 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.5;
    const shadowExtent = radius * 1.55;
    sun.shadow.camera.left = -shadowExtent;
    sun.shadow.camera.right = shadowExtent;
    sun.shadow.camera.top = shadowExtent;
    sun.shadow.camera.bottom = -shadowExtent;
    sun.shadow.camera.near = radius * 0.5;
    sun.shadow.camera.far = radius * 12;
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.copy(target);
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0xbfd2ec, 0x4a4438, 0.5));
    const rim = new THREE.DirectionalLight(0x9fb8e8, 0.6);
    rim.position.set(-radius * 3.6, radius * 2.4, -radius * 4);
    scene.add(rim);

    const shadowGround = new THREE.Mesh(
      new THREE.PlaneGeometry(radius * 7, radius * 7),
      new THREE.ShadowMaterial({ opacity: 0.28 }),
    );
    shadowGround.rotation.x = -Math.PI / 2;
    shadowGround.position.y = -0.012;
    shadowGround.receiveShadow = true;
    scene.add(shadowGround);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
      const fitFov = Math.min(verticalFov, horizontalFov);
      const distance = radius / Math.sin(fitFov / 2) * 1.08;
      camera.position.set(distance * 0.64, distance * 0.54, distance * 0.64);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    let frame = 0;
    let previousTime = performance.now();
    const animate = (time: number) => {
      if (!reducedMotion) monument.rotation.y += Math.min(40, time - previousTime) * 0.00018;
      previousTime = time;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      monument.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) object.dispose();
      });
      geometry.dispose();
      Object.values(materials).forEach((material) => material.dispose());
      shadowGround.geometry.dispose();
      (shadowGround.material as THREE.Material).dispose();
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [preview]);

  return (
    <div
      aria-label={`当前文明阶段代表建筑：${preview.label}，旋转展示`}
      className="civilization-index__building"
      ref={hostRef}
      role="img"
    />
  );
}
