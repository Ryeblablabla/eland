import * as THREE from 'three';
import { GALAXY_TILT_RADIANS, GALAXY_YAW_RADIANS } from '@/game/proceduralGalaxy';
import { mulberry32 } from '@/game/proceduralTextures';

type DistantSkyKind = 'open-cluster' | 'globular-cluster' | 'spiral-galaxy' | 'elliptical-galaxy' | 'irregular-galaxy';
type DistantSkyMode = 'universe' | 'surface';

interface DistantSkyDefinition {
  kind: DistantSkyKind;
  longitude: number;
  latitude: number;
  angularSize: number;
  aspect: number;
  rotation: number;
  seed: number;
  universeOpacity: number;
  surfaceOpacity?: number;
}

interface DistantSkyLayerOptions {
  mode: DistantSkyMode;
  radius: number;
  renderOrder: number;
}

export interface DistantSkyLayer {
  group: THREE.Group;
  setVisibility(visibility: number): void;
  dispose(): void;
}

// 固定目录保证两个场景看到同一片远空；只有带 surfaceOpacity 的天体能在人间出现。
const DISTANT_SKY_CATALOG: readonly DistantSkyDefinition[] = [
  { kind: 'open-cluster', longitude: -176, latitude: 14, angularSize: 0.46, aspect: 1.14, rotation: -0.31, seed: 1039, universeOpacity: 0.46 },
  { kind: 'open-cluster', longitude: -152, latitude: -5, angularSize: 0.78, aspect: 1.08, rotation: 0.18, seed: 1103, universeOpacity: 0.76, surfaceOpacity: 0.24 },
  { kind: 'open-cluster', longitude: -128, latitude: -17, angularSize: 0.54, aspect: 1.24, rotation: 0.63, seed: 1171, universeOpacity: 0.50, surfaceOpacity: 0.14 },
  { kind: 'open-cluster', longitude: -108, latitude: 7, angularSize: 0.62, aspect: 1.18, rotation: -0.42, seed: 1231, universeOpacity: 0.60 },
  { kind: 'open-cluster', longitude: -84, latitude: 18, angularSize: 0.48, aspect: 1.10, rotation: 0.27, seed: 1327, universeOpacity: 0.48 },
  { kind: 'open-cluster', longitude: -64, latitude: -3, angularSize: 1.18, aspect: 1.04, rotation: 0.74, seed: 1427, universeOpacity: 0.88, surfaceOpacity: 0.22 },
  { kind: 'open-cluster', longitude: -18, latitude: 5, angularSize: 0.70, aspect: 1.22, rotation: -0.16, seed: 1601, universeOpacity: 0.58 },
  { kind: 'open-cluster', longitude: 12, latitude: -19, angularSize: 0.66, aspect: 1.17, rotation: -0.48, seed: 1747, universeOpacity: 0.54, surfaceOpacity: 0.16 },
  { kind: 'open-cluster', longitude: 31, latitude: -7, angularSize: 0.74, aspect: 1.12, rotation: 0.52, seed: 1877, universeOpacity: 0.62 },
  { kind: 'open-cluster', longitude: 58, latitude: 15, angularSize: 0.44, aspect: 1.28, rotation: 0.89, seed: 1951, universeOpacity: 0.44 },
  { kind: 'open-cluster', longitude: 78, latitude: 4, angularSize: 0.58, aspect: 1.16, rotation: -0.66, seed: 2017, universeOpacity: 0.56 },
  { kind: 'open-cluster', longitude: 106, latitude: -10, angularSize: 0.72, aspect: 1.09, rotation: 0.38, seed: 2089, universeOpacity: 0.58, surfaceOpacity: 0.13 },
  { kind: 'open-cluster', longitude: 151, latitude: 10, angularSize: 0.52, aspect: 1.21, rotation: -0.77, seed: 2161, universeOpacity: 0.48 },
  { kind: 'open-cluster', longitude: 176, latitude: -22, angularSize: 0.42, aspect: 1.13, rotation: 0.12, seed: 2213, universeOpacity: 0.42 },
  { kind: 'globular-cluster', longitude: -34, latitude: 24, angularSize: 0.54, aspect: 1, rotation: 0, seed: 2293, universeOpacity: 0.80, surfaceOpacity: 0.20 },
  { kind: 'globular-cluster', longitude: -139, latitude: 36, angularSize: 0.40, aspect: 1, rotation: 0, seed: 2371, universeOpacity: 0.58 },
  { kind: 'globular-cluster', longitude: 86, latitude: -35, angularSize: 0.44, aspect: 1, rotation: 0, seed: 2441, universeOpacity: 0.60, surfaceOpacity: 0.12 },
  { kind: 'globular-cluster', longitude: 122, latitude: -29, angularSize: 0.48, aspect: 1, rotation: 0, seed: 2539, universeOpacity: 0.64 },
  { kind: 'spiral-galaxy', longitude: -55, latitude: 10, angularSize: 3.1, aspect: 2.25, rotation: 0.34, seed: 2801, universeOpacity: 0.72, surfaceOpacity: 0.18 },
  { kind: 'spiral-galaxy', longitude: 108, latitude: 31, angularSize: 2.0, aspect: 2.08, rotation: -0.49, seed: 2897, universeOpacity: 0.42, surfaceOpacity: 0.10 },
  { kind: 'elliptical-galaxy', longitude: -94, latitude: -39, angularSize: 1.35, aspect: 1.72, rotation: -0.58, seed: 3011, universeOpacity: 0.34 },
  { kind: 'elliptical-galaxy', longitude: 14, latitude: -46, angularSize: 1.04, aspect: 1.58, rotation: 0.22, seed: 3163, universeOpacity: 0.25 },
  { kind: 'irregular-galaxy', longitude: 42, latitude: 51, angularSize: 1.12, aspect: 1.34, rotation: 0.82, seed: 3253, universeOpacity: 0.30 },
  { kind: 'irregular-galaxy', longitude: -146, latitude: 47, angularSize: 0.92, aspect: 1.42, rotation: -0.36, seed: 3343, universeOpacity: 0.24 },
];

function drawEllipticalGlow(
  context: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  radiusX: number,
  radiusY: number,
): void {
  context.save();
  context.translate(128, 128);
  context.scale(radiusX / radiusY, 1);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusY);
  gradient.addColorStop(0, `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`);
  gradient.addColorStop(0.34, `${color}${Math.round(alpha * 0.56 * 255).toString(16).padStart(2, '0')}`);
  gradient.addColorStop(1, `${color}00`);
  context.fillStyle = gradient;
  context.fillRect(-radiusY, -radiusY, radiusY * 2, radiusY * 2);
  context.restore();
}

function makeClusterTexture(definition: DistantSkyDefinition): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const rng = mulberry32(definition.seed);
  const globular = definition.kind === 'globular-cluster';

  drawEllipticalGlow(
    context,
    globular ? '#d9e2ff' : '#b9ccff',
    globular ? 0.22 : 0.16,
    globular ? 64 : 76,
    globular ? 64 : 62,
  );
  context.globalCompositeOperation = 'lighter';
  const count = globular ? 460 : 105;
  const colors = ['220,230,255', '255,239,212', '188,211,255'];
  for (let i = 0; i < count; i++) {
    const radial = Math.pow(rng(), globular ? 2.15 : 1.35);
    const angle = rng() * Math.PI * 2;
    const spread = globular ? 82 : 102;
    const x = 128 + Math.cos(angle) * radial * spread * (0.82 + rng() * 0.24);
    const y = 128 + Math.sin(angle) * radial * spread * (0.82 + rng() * 0.24);
    const size = globular ? 0.55 + rng() * 1.45 : 1.1 + rng() * 2.35;
    const alpha = globular ? 0.20 + (1 - radial) * 0.68 : 0.38 + rng() * 0.50;
    context.fillStyle = `rgba(${colors[Math.floor(rng() * colors.length)]},${alpha})`;
    context.beginPath();
    context.arc(x, y, size, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = `eland-${definition.kind}-${definition.seed}`;
  return texture;
}

function drawGalaxyParticles(
  context: CanvasRenderingContext2D,
  definition: DistantSkyDefinition,
  rng: () => number,
): void {
  context.save();
  context.translate(128, 128);
  context.globalCompositeOperation = 'lighter';

  if (definition.kind === 'spiral-galaxy') {
    for (let i = 0; i < 820; i++) {
      const radial = Math.sqrt(rng());
      const arm = i % 2;
      const angle = arm * Math.PI + radial * 5.8 + (rng() - 0.5) * (0.34 + radial * 0.50);
      const x = Math.cos(angle) * radial * 102;
      const y = Math.sin(angle) * radial * 38 + (rng() - 0.5) * 5;
      const warm = radial < 0.28 || rng() < 0.16;
      context.fillStyle = warm
        ? `rgba(255,218,171,${0.10 + rng() * 0.30})`
        : `rgba(157,190,255,${0.08 + rng() * 0.27})`;
      const size = 0.45 + rng() * 1.15;
      context.fillRect(x - size * 0.5, y - size * 0.5, size, size);
    }
  } else if (definition.kind === 'irregular-galaxy') {
    const clumps = [
      { x: -35, y: 8, sx: 42, sy: 25 },
      { x: 8, y: -12, sx: 48, sy: 32 },
      { x: 43, y: 14, sx: 30, sy: 21 },
    ];
    for (let i = 0; i < 420; i++) {
      const clump = clumps[Math.floor(rng() * clumps.length)];
      const angle = rng() * Math.PI * 2;
      const radial = Math.pow(rng(), 1.45);
      const x = clump.x + Math.cos(angle) * radial * clump.sx;
      const y = clump.y + Math.sin(angle) * radial * clump.sy;
      context.fillStyle = rng() < 0.26
        ? `rgba(255,209,158,${0.08 + rng() * 0.24})`
        : `rgba(143,183,242,${0.07 + rng() * 0.22})`;
      const size = 0.7 + rng() * 1.4;
      context.fillRect(x, y, size, size);
    }
  } else {
    for (let i = 0; i < 360; i++) {
      const angle = rng() * Math.PI * 2;
      const radial = Math.pow(rng(), 1.8);
      const x = Math.cos(angle) * radial * 92;
      const y = Math.sin(angle) * radial * 52;
      context.fillStyle = `rgba(255,226,188,${0.06 + (1 - radial) * 0.26})`;
      const size = 0.6 + rng() * 1.1;
      context.fillRect(x, y, size, size);
    }
  }
  context.restore();
}

function makeGalaxyTexture(definition: DistantSkyDefinition): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const rng = mulberry32(definition.seed);

  if (definition.kind === 'spiral-galaxy') {
    drawEllipticalGlow(context, '#a8c3ff', 0.38, 106, 42);
    drawEllipticalGlow(context, '#ffd7a1', 0.74, 34, 22);
  } else if (definition.kind === 'elliptical-galaxy') {
    drawEllipticalGlow(context, '#ffe0b6', 0.54, 100, 58);
    drawEllipticalGlow(context, '#fff0d2', 0.38, 35, 24);
  } else {
    drawEllipticalGlow(context, '#9dbcf0', 0.18, 88, 62);
  }
  drawGalaxyParticles(context, definition, rng);

  // 螺旋盘中心的一线冷暗尘埃保持低对比，避免远星系变成明亮徽标。
  if (definition.kind === 'spiral-galaxy') {
    context.save();
    context.translate(128, 128);
    context.rotate(0.05);
    context.strokeStyle = 'rgba(3,6,13,0.24)';
    context.lineWidth = 3.2;
    context.beginPath();
    context.moveTo(-78, 1);
    context.bezierCurveTo(-26, -6, 34, 7, 82, -2);
    context.stroke();
    context.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = `eland-${definition.kind}-${definition.seed}`;
  return texture;
}

function rotatePair(first: number, second: number, angle: number): [number, number] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [cosine * first - sine * second, sine * first + cosine * second];
}

/** 把银河坐标变回生成 Shader 使用前的世界方向，使星团落在程序化银河盘附近。 */
function skyDirection(longitudeDegrees: number, latitudeDegrees: number): THREE.Vector3 {
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const cosLatitude = Math.cos(latitude);
  const direction = new THREE.Vector3(
    cosLatitude * Math.cos(longitude),
    Math.sin(latitude),
    cosLatitude * Math.sin(longitude),
  );
  [direction.x, direction.z] = rotatePair(direction.x, direction.z, GALAXY_YAW_RADIANS);
  [direction.y, direction.z] = rotatePair(direction.y, direction.z, GALAXY_TILT_RADIANS);
  return direction.normalize();
}

export function createDistantSkyLayer(options: DistantSkyLayerOptions): DistantSkyLayer {
  const group = new THREE.Group();
  group.name = `eland-distant-sky-${options.mode}`;
  const records: Array<{ material: THREE.SpriteMaterial; texture: THREE.CanvasTexture; baseOpacity: number }> = [];
  const layerOpacityScale = options.mode === 'universe' ? 0.68 : 0.70;

  DISTANT_SKY_CATALOG.forEach((definition) => {
    const catalogOpacity = options.mode === 'universe' ? definition.universeOpacity : definition.surfaceOpacity;
    if (catalogOpacity === undefined) return;
    const baseOpacity = catalogOpacity * layerOpacityScale;
    const cluster = definition.kind === 'open-cluster' || definition.kind === 'globular-cluster';
    const texture = cluster ? makeClusterTexture(definition) : makeGalaxyTexture(definition);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: options.mode === 'universe' ? baseOpacity : 0,
      blending: cluster ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      rotation: definition.rotation,
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = definition.kind;
    sprite.position.copy(skyDirection(definition.longitude, definition.latitude)).multiplyScalar(options.radius);
    // 宇宙镜头视场较宽，真实角尺度会退化成不可辨认的小点；适度放大远景读形。
    // 人间镜头视场较窄，维持接近目录中的角尺度，避免晴夜出现巨幅星系贴纸。
    const angularScale = options.mode === 'universe' ? 2.65 : 1.30;
    const width = 2 * options.radius
      * Math.tan(THREE.MathUtils.degToRad(definition.angularSize * angularScale) * 0.5);
    sprite.scale.set(width, width / definition.aspect, 1);
    sprite.renderOrder = options.renderOrder;
    sprite.frustumCulled = false;
    group.add(sprite);
    records.push({ material, texture, baseOpacity });
  });

  return {
    group,
    setVisibility(visibility) {
      const safeVisibility = THREE.MathUtils.clamp(visibility, 0, 1);
      records.forEach(({ material, baseOpacity }) => {
        material.opacity = baseOpacity * safeVisibility;
      });
    },
    dispose() {
      group.removeFromParent();
      records.forEach(({ material, texture }) => {
        material.dispose();
        texture.dispose();
      });
      group.clear();
    },
  };
}
