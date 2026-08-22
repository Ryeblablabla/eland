import * as THREE from 'three';
import { mulberry32 } from '@/game/proceduralTextures';

function makeMeteorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;

  const outerTail = context.createLinearGradient(12, 0, 488, 0);
  outerTail.addColorStop(0, 'rgba(120,174,255,0)');
  outerTail.addColorStop(0.48, 'rgba(145,193,255,0.08)');
  outerTail.addColorStop(0.82, 'rgba(199,225,255,0.42)');
  outerTail.addColorStop(0.93, 'rgba(255,255,255,0.96)');
  outerTail.addColorStop(1, 'rgba(255,255,255,0)');
  context.strokeStyle = outerTail;
  context.lineCap = 'round';
  context.lineWidth = 15;
  context.beginPath();
  context.moveTo(12, 32);
  context.lineTo(488, 32);
  context.stroke();

  const innerTail = context.createLinearGradient(60, 0, 490, 0);
  innerTail.addColorStop(0, 'rgba(205,229,255,0)');
  innerTail.addColorStop(0.72, 'rgba(222,239,255,0.22)');
  innerTail.addColorStop(0.94, 'rgba(255,255,255,1)');
  innerTail.addColorStop(1, 'rgba(255,255,255,0)');
  context.strokeStyle = innerTail;
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(60, 32);
  context.lineTo(490, 32);
  context.stroke();

  const head = context.createRadialGradient(466, 32, 0, 466, 32, 22);
  head.addColorStop(0, 'rgba(255,255,255,1)');
  head.addColorStop(0.18, 'rgba(228,243,255,0.92)');
  head.addColorStop(1, 'rgba(150,202,255,0)');
  context.fillStyle = head;
  context.fillRect(444, 10, 44, 44);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'eland-human-meteor';
  return texture;
}

function makeCometTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d')!;

  const dustTail = context.createLinearGradient(8, 0, 472, 0);
  dustTail.addColorStop(0, 'rgba(102,145,211,0)');
  dustTail.addColorStop(0.52, 'rgba(126,169,229,0.08)');
  dustTail.addColorStop(0.84, 'rgba(178,212,255,0.28)');
  dustTail.addColorStop(1, 'rgba(230,245,255,0.74)');
  context.fillStyle = dustTail;
  context.beginPath();
  context.moveTo(8, 64);
  context.bezierCurveTo(162, 49, 326, 35, 469, 54);
  context.bezierCurveTo(322, 78, 150, 83, 8, 64);
  context.fill();

  const ionTail = context.createLinearGradient(42, 0, 476, 0);
  ionTail.addColorStop(0, 'rgba(105,172,255,0)');
  ionTail.addColorStop(0.68, 'rgba(137,194,255,0.13)');
  ionTail.addColorStop(0.96, 'rgba(213,239,255,0.68)');
  ionTail.addColorStop(1, 'rgba(235,248,255,0)');
  context.strokeStyle = ionTail;
  context.lineCap = 'round';
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(42, 65);
  context.bezierCurveTo(192, 59, 350, 57, 475, 61);
  context.stroke();

  const coma = context.createRadialGradient(468, 60, 0, 468, 60, 37);
  coma.addColorStop(0, 'rgba(255,255,255,1)');
  coma.addColorStop(0.12, 'rgba(231,246,255,0.96)');
  coma.addColorStop(0.42, 'rgba(143,202,255,0.34)');
  coma.addColorStop(1, 'rgba(90,153,231,0)');
  context.fillStyle = coma;
  context.fillRect(431, 23, 74, 74);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'eland-distant-comet';
  return texture;
}

export interface HumanMeteorLayer {
  object: THREE.Object3D;
  update(deltaSeconds: number, camera: THREE.PerspectiveCamera, skyVisibility: number): void;
  dispose(): void;
}

/**
 * 人间大气中的短暂流星。序列由世界种子稳定生成，只读取天空可见度；
 * 它不写回人物认知、自然状态或文明事件。
 */
export function createHumanMeteorLayer(scene: THREE.Scene, seed: number): HumanMeteorLayer {
  const texture = makeMeteorTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: '#dceeff',
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'human-meteor';
  sprite.visible = false;
  sprite.frustumCulled = false;
  sprite.renderOrder = 40;
  scene.add(sprite);

  const rng = mulberry32((Math.trunc(seed) ^ 0x7f4a7c15) >>> 0);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const direction = new THREE.Vector3();
  let elapsedSeconds = 0;
  let nextMeteorAt = 10 + rng() * 8;
  let activeSince = -1;
  let duration = 0.9;
  let startX = 0;
  let startY = 0;
  let endX = 0;
  let endY = 0;
  let meteorWidth = 25;
  let meteorHeight = 0.9;

  const beginMeteor = () => {
    const travelSign = rng() < 0.5 ? -1 : 1;
    const travel = 0.34 + rng() * 0.16;
    startX = -travelSign * (0.10 + rng() * 0.18);
    endX = startX + travelSign * travel;
    startY = 0.13 + rng() * 0.10;
    endY = startY - (0.045 + rng() * 0.055);
    duration = 0.72 + rng() * 0.34;
    meteorWidth = 22 + rng() * 10;
    meteorHeight = 0.72 + rng() * 0.34;
    material.rotation = Math.atan2(endY - startY, endX - startX);
    activeSince = elapsedSeconds;
    sprite.visible = true;
  };

  return {
    object: sprite,
    update(deltaSeconds, camera, skyVisibility) {
      elapsedSeconds += deltaSeconds;
      if (activeSince < 0 && elapsedSeconds >= nextMeteorAt && skyVisibility >= 0.24) beginMeteor();
      if (activeSince < 0) return;

      const progress = THREE.MathUtils.clamp((elapsedSeconds - activeSince) / duration, 0, 1);
      const eased = progress * progress * (3 - 2 * progress);
      const x = THREE.MathUtils.lerp(startX, endX, eased);
      const y = THREE.MathUtils.lerp(startY, endY, eased);
      camera.getWorldDirection(forward);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      direction.copy(forward)
        .addScaledVector(right, x)
        .addScaledVector(up, y)
        .normalize();
      sprite.position.copy(camera.position).addScaledVector(direction, 190);
      sprite.scale.set(meteorWidth, meteorHeight, 1);

      const fadeIn = THREE.MathUtils.smoothstep(progress, 0, 0.10);
      const fadeOut = 1 - THREE.MathUtils.smoothstep(progress, 0.36, 1);
      material.opacity = fadeIn * fadeOut * THREE.MathUtils.clamp(skyVisibility, 0, 1) * 0.82;

      if (progress >= 1) {
        sprite.visible = false;
        material.opacity = 0;
        activeSince = -1;
        nextMeteorAt = elapsedSeconds + 48 + rng() * 62;
      }
    },
    dispose() {
      sprite.removeFromParent();
      material.dispose();
      texture.dispose();
    },
  };
}

export interface DistantCometLayer {
  update(deltaSeconds: number, camera: THREE.PerspectiveCamera, cosmosTime: number, universeSeed: number): void;
  dispose(): void;
}

/**
 * 宇宙远景中的长周期彗星，只提供稳定的视觉尺度与缓慢位移。
 * 它位于三体系统之外，不参与本地引力、撞击或文明观察器。
 */
export function createDistantCometLayer(scene: THREE.Scene): DistantCometLayer {
  const texture = makeCometTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: '#d2e8ff',
    transparent: true,
    opacity: 0.52,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'distant-comet';
  sprite.frustumCulled = false;
  sprite.renderOrder = -7;
  scene.add(sprite);

  const direction = new THREE.Vector3();
  const nextDirection = new THREE.Vector3();
  const screen = new THREE.Vector3();
  const nextScreen = new THREE.Vector3();
  let elapsedSeconds = 0;
  let configuredSeed = Number.NaN;
  let phaseOffset = 0;
  let baseX = -0.24;
  let baseY = 0.24;
  let angularWidth = 108;

  const configure = (seed: number) => {
    const normalizedSeed = Math.trunc(seed) >>> 0;
    if (normalizedSeed === configuredSeed) return;
    configuredSeed = normalizedSeed;
    const rng = mulberry32((normalizedSeed ^ 0x9e3779b9) >>> 0);
    phaseOffset = rng() * Math.PI * 2;
    baseX = -0.26 + (rng() - 0.5) * 0.10;
    baseY = 0.22 + rng() * 0.07;
    angularWidth = 96 + rng() * 22;
  };

  const sampleDirection = (phase: number, target: THREE.Vector3) => target.set(
    baseX + Math.sin(phase) * 0.14,
    baseY + Math.sin(phase * 0.73 + 1.2) * 0.045,
    -1,
  ).normalize();

  return {
    update(deltaSeconds, camera, cosmosTime, universeSeed) {
      elapsedSeconds += deltaSeconds;
      configure(universeSeed);
      const phase = phaseOffset + cosmosTime * 0.012 + elapsedSeconds * 0.0035;
      sampleDirection(phase, direction);
      sampleDirection(phase + 0.002, nextDirection);
      sprite.position.copy(camera.position).addScaledVector(direction, 720);
      sprite.scale.set(angularWidth, angularWidth * 0.18, 1);

      screen.copy(sprite.position).project(camera);
      nextScreen.copy(camera.position).addScaledVector(nextDirection, 720).project(camera);
      material.rotation = Math.atan2(nextScreen.y - screen.y, nextScreen.x - screen.x);
      material.opacity = 0.48 + Math.sin(phase * 0.61) * 0.055;
    },
    dispose() {
      sprite.removeFromParent();
      material.dispose();
      texture.dispose();
    },
  };
}
