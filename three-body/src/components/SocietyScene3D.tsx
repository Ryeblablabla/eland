import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import type {
  ActionVisualView,
  EraKey,
  IntentView,
  SocietyAgent,
  SocietyState,
  SpeechLineView,
} from '@/game/societyContract';
import { Material } from '@/game/eland/domain/material';
import { createDistantSkyLayer } from '@/game/distantSky';
import { PinchTransitionGesture } from '@/game/pinch-transition-gesture';
import { cellColor, cellCoordinates, interpolatePath } from '@/game/pixelworld';
import { bakeProceduralGalaxy } from '@/game/proceduralGalaxy';
import { makeStarSurfaceTexture, mulberry32 } from '@/game/proceduralTextures';
import {
  shorelinePatches,
  surfaceTransitionKind,
  surfaceTransitionPatches,
  type ShorelineNeighbors,
  type SurfaceTransitionDirection,
  type SurfaceTransitionKind,
  type SurfaceTransitionNeighbors,
} from '@/game/surfaceTransitions';
import { collectDecor, featureDepth, featureUnderlayMaterialId, type DecorBucket, type DecorInstance } from '@/game/voxelKits';
import { N_STARS, STAR_STYLES } from '@/lib/threebody';

/**
 * GTAO 内部用 overrideMaterial 重渲染场景取深度/法线，
 * 名牌/星点不是遮蔽体——渲染 AO 期间临时隐藏，避免黑斑。
 */
class ScopedGTAOPass extends GTAOPass {
  excluded: THREE.Object3D[] = [];
  resolutionScale = 0.5;

  override setSize(width: number, height: number): void {
    super.setSize(
      Math.max(1, Math.floor(width * this.resolutionScale)),
      Math.max(1, Math.floor(height * this.resolutionScale)),
    );
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const vis = this.excluded.map((o) => o.visible);
    for (const o of this.excluded) o.visible = false;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    this.excluded.forEach((o, i) => { o.visible = vis[i]; });
  }
}

/**
 * 轻量屏幕空间移轴：沿可调焦线保留清晰带，向画面上下两侧逐渐增加模糊。
 * 它只改变最终画面，不参与人物选择、世界状态或任何模拟规则。
 */
const AdaptiveTiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uFocusY: { value: 0.5 },
    uSlope: { value: 0 },
    uBand: { value: 0.16 },
    uFeather: { value: 0.18 },
    uMaxBlur: { value: 0 },
    uStrength: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uFocusY;
    uniform float uSlope;
    uniform float uBand;
    uniform float uFeather;
    uniform float uMaxBlur;
    uniform float uStrength;
    varying vec2 vUv;

    void main() {
      vec4 source = texture2D(tDiffuse, vUv);
      float focusLine = uFocusY + (vUv.x - 0.5) * uSlope;
      float focusDistance = abs(vUv.y - focusLine);
      float blurAmount = smoothstep(uBand, uBand + uFeather, focusDistance) * uStrength;
      if (blurAmount < 0.001 || uMaxBlur < 0.01) {
        gl_FragColor = source;
        return;
      }

      vec2 radius = vec2(uMaxBlur * blurAmount) / max(uResolution, vec2(1.0));
      vec3 color = source.rgb * 0.20;
      color += texture2D(tDiffuse, vUv + vec2( radius.x, 0.0)).rgb * 0.10;
      color += texture2D(tDiffuse, vUv + vec2(-radius.x, 0.0)).rgb * 0.10;
      color += texture2D(tDiffuse, vUv + vec2(0.0,  radius.y)).rgb * 0.10;
      color += texture2D(tDiffuse, vUv + vec2(0.0, -radius.y)).rgb * 0.10;
      color += texture2D(tDiffuse, vUv + vec2( radius.x,  radius.y) * 0.72).rgb * 0.10;
      color += texture2D(tDiffuse, vUv + vec2(-radius.x,  radius.y) * 0.72).rgb * 0.10;
      color += texture2D(tDiffuse, vUv + vec2( radius.x, -radius.y) * 0.72).rgb * 0.10;
      color += texture2D(tDiffuse, vUv + vec2(-radius.x, -radius.y) * 0.72).rgb * 0.10;
      gl_FragColor = vec4(color, source.a);
    }
  `,
};

/**
 * 立体沙盘：演化页的 2.5D/3D 视图。
 * - 地形：每格一根体素柱（InstancedMesh），高度 = world.elevation，颜色 = cellColor
 * - 水面：相连水格共享连续顶面，只有真实岸缘保留侧壁；1/8 格流纹使用世界坐标
 * - 人物：3D 像素小人（体素拼装），步行摆动 + 头顶名牌
 * - 相机：OrbitControls 拖拽旋转 / 滚轮缩放，固定目标避免构图漂移
 * 数据全部来自权威 SocietyState，只读不改。
 */

export interface HumanSkySnapshot {
  t: number;
  fluxRel: number;
  bodies: readonly number[]; // [三颗恒星 x/y, 行星 x/y]，与 SimStats.bodies 一致
}

interface Props {
  society: SocietyState;
  era: EraKey;
  speaker: string | null;
  speechLines?: readonly SpeechLineView[];
  sky?: HumanSkySnapshot;
  selectedAgentId?: string | null; // 旧页面编译兼容；沉浸式场景不启用点选 UI
  onSelectAgent?: (id: string | null) => void;
  selectedObject?: SocietySceneSelection;
  onSelectObject?: (selection: SocietySceneSelection) => void;
  onZoomOutRequest?: () => void; // 滚轮、键盘或双指持续缩小越过阈值 → 请求升起返回宇宙
}

export type SocietySceneSelection =
  | { kind: 'agent'; id: string }
  | { kind: 'structure'; id: string }
  | null;

const CELL_H = 0.3; // 每层体素的视觉高度（世界单位）
const RULE_TICKS = 15;
const MONTH_PLAYBACK_MS = 3_000; // 与 2D 地图一致的月度播放时长
const NAME_TAG_TARGET_GLYPH_PX = 10.5;
const NAME_TAG_MIN_WORLD_H = 0.55;
const NAME_TAG_MAX_WORLD_H = 3;
const FIGURE_SCALE = 0.5; // 比当前版本放大一倍；仍保留半格尺度以容纳同格编组
const MAX_VISIBLE_SPEAKERS = 3;
const SPEECH_FONT_PX = 32;
const SPEECH_TARGET_FONT_PX = 11.5;
const SPEECH_MAX_LINE_WIDTH_PX = 400;
const SPEECH_MAX_LINES = 3;
const SPEECH_COLLISION_GAP_PX = 8;
const TERRAIN_APRON_CELLS = 72; // 权威网格之外的纯视觉缓冲；不参与规则、寻路或选择
const SOCIETY_MAX_PIXEL_RATIO = 1.5;
const CAMERA_TARGET_INSET_X = 12;
const CAMERA_TARGET_INSET_Z = 10;

function visualSpatialHash(seed: number, x: number, z: number, salt: number): number {
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

function visualSmoothNoise(seed: number, x: number, z: number, scale: number, salt: number): number {
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

function tileableCloudNoise(seed: number, u: number, v: number, cells: number, salt: number): number {
  const x = u * cells;
  const z = v * cells;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const smoothX = tx * tx * (3 - 2 * tx);
  const smoothZ = tz * tz * (3 - 2 * tz);
  const wrappedHash = (ix: number, iz: number) => visualSpatialHash(
    seed,
    ((ix % cells) + cells) % cells,
    ((iz % cells) + cells) % cells,
    salt,
  );
  const top = THREE.MathUtils.lerp(wrappedHash(x0, z0), wrappedHash(x0 + 1, z0), smoothX);
  const bottom = THREE.MathUtils.lerp(wrappedHash(x0, z0 + 1), wrappedHash(x0 + 1, z0 + 1), smoothX);
  return THREE.MathUtils.lerp(top, bottom, smoothZ);
}

/** 世界种子决定的可平铺云密度；同一权威状态重进场景会得到同一片云系。 */
function makeCloudNoiseTexture(seed: number): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const octaves = [4, 8, 16, 32] as const;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let amplitude = 1;
      let total = 0;
      let weight = 0;
      octaves.forEach((cells, octave) => {
        total += tileableCloudNoise(seed, u, v, cells, 0x41c64e6d + octave * 977) * amplitude;
        weight += amplitude;
        amplitude *= 0.52;
      });
      const broad = tileableCloudNoise(seed, u, v, 3, 0x2d93f06b);
      const density = THREE.MathUtils.clamp((total / weight) * 0.78 + broad * 0.22, 0, 1);
      const value = Math.round(density * 255);
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

type SocietyWeatherKind = NonNullable<SocietyState['weather']>['kind'];

const CLOUD_WEATHER: Record<SocietyWeatherKind, {
  opacity: number;
  presence: number;
  shadowThreshold: number;
  speed: number;
  light: string;
  shade: string;
}> = {
  clear:   { opacity: 0, presence: 0, shadowThreshold: 0.68, speed: 0.48, light: '#f7f9fb', shade: '#7f8c9a' },
  rain:    { opacity: 0.46, presence: 0.72, shadowThreshold: 0.52, speed: 1.15, light: '#aebac2', shade: '#46535e' },
  storm:   { opacity: 0.58, presence: 1, shadowThreshold: 0.44, speed: 2.30, light: '#7f8b94', shade: '#2d3943' },
  drought: { opacity: 0, presence: 0, shadowThreshold: 0.78, speed: 0.90, light: '#e0d0b2', shade: '#8b755b' },
  snow:    { opacity: 0.52, presence: 0.82, shadowThreshold: 0.51, speed: 0.75, light: '#eef2f4', shade: '#87949f' },
  fog:     { opacity: 0, presence: 0, shadowThreshold: 0.70, speed: 0.28, light: '#ccd2d2', shade: '#858f92' },
};

/** 有真实厚度的软边云团材质；几何轮廓负责体积，噪声只用于内部明暗而不裁出硬边。 */
function makeCloudVolumeMaterial(noiseMap: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uNoiseMap: { value: noiseMap },
      uOffset: { value: new THREE.Vector2() },
      uOpacity: { value: 0 },
      uDaylight: { value: 1 },
      uLightColor: { value: new THREE.Color(CLOUD_WEATHER.clear.light) },
      uShadeColor: { value: new THREE.Color(CLOUD_WEATHER.clear.shade) },
    }]),
    vertexShader: /* glsl */`
      varying vec3 vCloudLocal;
      varying vec3 vCloudNormal;
      varying vec3 vViewNormal;
      #include <fog_pars_vertex>
      void main() {
        vCloudLocal = position;
        vCloudNormal = normal;
        vViewNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uNoiseMap;
      uniform vec2 uOffset;
      uniform float uOpacity;
      uniform float uDaylight;
      uniform vec3 uLightColor;
      uniform vec3 uShadeColor;
      varying vec3 vCloudLocal;
      varying vec3 vCloudNormal;
      varying vec3 vViewNormal;
      #include <common>
      #include <fog_pars_fragment>

      void main() {
        vec2 cloudUvA = vCloudLocal.xz * 0.22 + vec2(0.5) + uOffset;
        vec2 cloudUvB = vCloudLocal.xy * 0.31 + vec2(0.5) - uOffset * 0.37;
        float detailA = texture2D(uNoiseMap, cloudUvA).r;
        float detailB = texture2D(uNoiseMap, cloudUvB).r;
        float detail = detailA * 0.62 + detailB * 0.38;

        // 球体掠射角连续趋于透明，因此任何观察角度都不会出现矩形或硬切边。
        float facing = clamp(abs(vViewNormal.z), 0.0, 1.0);
        float edgeFade = smoothstep(0.035, 0.72, facing);
        float density = 0.70 + detail * 0.30;
        float alpha = uOpacity * edgeFade * density;
        if (alpha < 0.004) discard;

        float topLight = clamp(vCloudNormal.y * 0.5 + 0.5, 0.0, 1.0);
        float lightMix = clamp(0.24 + uDaylight * 0.38 + topLight * 0.22 + detail * 0.13, 0.0, 1.0);
        vec3 color = mix(uShadeColor, uLightColor, lightMix);
        color *= 0.94 + detail * 0.08;
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: true,
  });
}

type SpeechBubblePlacement = 'body-left' | 'center' | 'body-right';

function makeHumanSkyGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,0.94)');
  gradient.addColorStop(0.18, 'rgba(255,255,255,0.58)');
  gradient.addColorStop(0.48, 'rgba(255,255,255,0.16)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 纪元 → 基础渲染状态；日照循环只在演示层内调制这些参数。 */
const ERA_LIGHT: Record<EraKey, {
  sun: string; sunI: number; hemi: number; rim: number; env: number;
  exposure: number; fog: string;
}> = {
  stable:         { sun: '#fff1d6', sunI: 2.2, hemi: 0.92, rim: 0.38, env: 1.00, exposure: 1.15, fog: '#070d1c' },
  chaotic:        { sun: '#ffe9c9', sunI: 2.0, hemi: 0.85, rim: 0.36, env: 0.92, exposure: 1.12, fog: '#080b18' },
  'chaotic-heat': { sun: '#ffc890', sunI: 2.7, hemi: 0.92, rim: 0.30, env: 0.85, exposure: 1.22, fog: '#160b09' },
  'chaotic-cold': { sun: '#bcd4ff', sunI: 1.5, hemi: 0.82, rim: 0.52, env: 1.05, exposure: 1.12, fog: '#08101d' },
  burned:         { sun: '#ff9a5e', sunI: 3.0, hemi: 0.88, rim: 0.26, env: 0.78, exposure: 1.25, fog: '#1a0907' },
  frozen:         { sun: '#9fb8e8', sunI: 1.15, hemi: 0.78, rim: 0.58, env: 1.10, exposure: 1.08, fog: '#07101d' },
  extinct:        { sun: '#a394d8', sunI: 1.2, hemi: 0.72, rim: 0.48, env: 0.90, exposure: 1.05, fog: '#0b0918' },
};

/** 纪元只改变天空的色彩倾向；可见亮度继续由同一套日照循环平滑调制。 */
const ERA_SKY: Record<EraKey, {
  dayZenith: string; dayHorizon: string;
  nightZenith: string; nightHorizon: string;
  nadir: string; haze: string;
}> = {
  stable: {
    dayZenith: '#173f73', dayHorizon: '#416b97',
    nightZenith: '#04091a', nightHorizon: '#14213a', nadir: '#030611', haze: '#e6a56a',
  },
  chaotic: {
    dayZenith: '#263454', dayHorizon: '#555c72',
    nightZenith: '#050719', nightHorizon: '#1a1930', nadir: '#050510', haze: '#d99463',
  },
  'chaotic-heat': {
    dayZenith: '#4e2d23', dayHorizon: '#995238',
    nightZenith: '#160706', nightHorizon: '#3b180f', nadir: '#0b0404', haze: '#e77c4d',
  },
  'chaotic-cold': {
    dayZenith: '#244a70', dayHorizon: '#5c82a6',
    nightZenith: '#030a18', nightHorizon: '#14273d', nadir: '#030710', haze: '#8fb7e8',
  },
  burned: {
    dayZenith: '#51271c', dayHorizon: '#9f4a31',
    nightZenith: '#170604', nightHorizon: '#40130b', nadir: '#0b0303', haze: '#df7044',
  },
  frozen: {
    dayZenith: '#244462', dayHorizon: '#587a99',
    nightZenith: '#030918', nightHorizon: '#16283d', nadir: '#030710', haze: '#91b3dd',
  },
  extinct: {
    dayZenith: '#342d49', dayHorizon: '#605675',
    nightZenith: '#090617', nightHorizon: '#21192f', nadir: '#05040d', haze: '#9882bd',
  },
};

interface DaylightKeyframe {
  at: number;
  position: THREE.Vector3;
  color: THREE.Color;
  direct: number;
  ambient: number;
  exposure: number;
}

const DAYLIGHT_CYCLE_SECONDS = 120;
// 90% 的追随约需 2.7 秒；纪元、雾和日照目标统一通过这层阻尼落到画面。
const LIGHT_DAMPING = 0.86;
const DAYLIGHT_KEYFRAMES: readonly DaylightKeyframe[] = [
  { at: 0.00, position: new THREE.Vector3(-62, 28, 24), color: new THREE.Color('#ffbd7d'), direct: 0.68, ambient: 0.94, exposure: 0.96 },
  { at: 0.32, position: new THREE.Vector3(-10, 82, 28), color: new THREE.Color('#fff4dc'), direct: 1.04, ambient: 1.04, exposure: 1.02 },
  { at: 0.62, position: new THREE.Vector3(38, 54, 34), color: new THREE.Color('#ffd19a'), direct: 0.90, ambient: 1.00, exposure: 1.00 },
  { at: 0.82, position: new THREE.Vector3(64, 21, 18), color: new THREE.Color('#ff8758'), direct: 0.50, ambient: 0.91, exposure: 0.94 },
  // 黄昏后从地图背面低位回到清晨，保持循环连续，同时不把演示层做成完整昼夜系统。
  { at: 0.92, position: new THREE.Vector3(4, 15, -58), color: new THREE.Color('#9fabc9'), direct: 0.34, ambient: 0.86, exposure: 0.91 },
  { at: 1.00, position: new THREE.Vector3(-62, 28, 24), color: new THREE.Color('#ffbd7d'), direct: 0.68, ambient: 0.94, exposure: 0.96 },
];

function isChaoticLightEra(era: EraKey): boolean {
  return era === 'chaotic' || era === 'chaotic-heat' || era === 'chaotic-cold';
}

function sampleDaylight(
  phase: number,
  position: THREE.Vector3,
  color: THREE.Color,
): { direct: number; ambient: number; exposure: number } {
  let rightIndex = 1;
  while (rightIndex < DAYLIGHT_KEYFRAMES.length - 1 && phase > DAYLIGHT_KEYFRAMES[rightIndex].at) rightIndex += 1;
  const left = DAYLIGHT_KEYFRAMES[rightIndex - 1];
  const right = DAYLIGHT_KEYFRAMES[rightIndex];
  const interval = Math.max(0.0001, right.at - left.at);
  const linear = THREE.MathUtils.clamp((phase - left.at) / interval, 0, 1);
  const eased = linear * linear * (3 - 2 * linear);
  position.copy(left.position).lerp(right.position, eased);
  color.copy(left.color).lerp(right.color, eased);
  return {
    direct: THREE.MathUtils.lerp(left.direct, right.direct, eased),
    ambient: THREE.MathUtils.lerp(left.ambient, right.ambient, eased),
    exposure: THREE.MathUtils.lerp(left.exposure, right.exposure, eased),
  };
}

/** id → 稳定的衣色色相 */
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (((h % 360) + 360) % 360) / 360;
}

// ---------------------------------------------------------------------------
// 名牌贴图（文本 sprite，模块级缓存共享）
// ---------------------------------------------------------------------------

const nameTextureCache = new Map<string, THREE.CanvasTexture>();

function nameTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  const hit = nameTextureCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '600 30px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  nameTextureCache.set(key, tex);
  return tex;
}

interface SpeechBubbleTexture {
  texture: THREE.CanvasTexture;
  aspect: number;
  pixelWidth: number;
  pixelHeight: number;
  anchorX: number;
}

/** 每位人物只保留本帧最后一句，再取最近三位说话者，避免场景被气泡铺满。 */
function latestSpeechBySpeaker(lines: readonly SpeechLineView[]): SpeechLineView[] {
  const result: SpeechLineView[] = [];
  const speakers = new Set<string>();
  for (let index = lines.length - 1; index >= 0 && result.length < MAX_VISIBLE_SPEAKERS; index -= 1) {
    const line = lines[index];
    const source = (line as SpeechLineView & { source?: string }).source;
    if (source !== 'decision-model' && source !== 'speech-model') continue;
    if (!line.text.trim() || speakers.has(line.speakerId)) continue;
    speakers.add(line.speakerId);
    result.push(line);
  }
  return result.reverse();
}

function speechLinesForCanvas(
  context: CanvasRenderingContext2D,
  text: string,
): string[] {
  const glyphs = Array.from(text.trim().replace(/\s+/gu, ' '));
  const lines: string[] = [];
  let current = '';
  let truncated = false;
  for (const glyph of glyphs) {
    const candidate = `${current}${glyph}`;
    if (!current || context.measureText(candidate).width <= SPEECH_MAX_LINE_WIDTH_PX) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = glyph;
    if (lines.length >= SPEECH_MAX_LINES) {
      truncated = true;
      break;
    }
  }
  if (!truncated && current && lines.length < SPEECH_MAX_LINES) lines.push(current);
  if (truncated && lines.length) {
    let last = lines[lines.length - 1];
    while (last && context.measureText(`${last}…`).width > SPEECH_MAX_LINE_WIDTH_PX) {
      last = Array.from(last).slice(0, -1).join('');
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.length ? lines : ['……'];
}

function speechBubbleAnchorX(width: number, placement: SpeechBubblePlacement): number {
  if (placement === 'center') return 0.5;
  const edgeInset = Math.max(18, Math.min(28, width * 0.1));
  return placement === 'body-left' ? 1 - edgeInset / width : edgeInset / width;
}

function speechBubbleTexture(text: string, placement: SpeechBubblePlacement): SpeechBubbleTexture {
  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d')!;
  measure.font = `400 ${SPEECH_FONT_PX}px ui-sans-serif, system-ui, "PingFang SC", sans-serif`;
  const lines = speechLinesForCanvas(measure, text);
  const paddingX = 22;
  const paddingTop = 17;
  const paddingBottom = 15;
  const lineHeight = 39;
  const tailHeight = 12;
  const contentWidth = Math.max(...lines.map((line) => measure.measureText(line).width));
  const width = Math.ceil(Math.max(164, Math.min(SPEECH_MAX_LINE_WIDTH_PX, contentWidth) + paddingX * 2));
  const bodyHeight = paddingTop + paddingBottom + lines.length * lineHeight;
  const height = bodyHeight + tailHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  const radius = 16;
  const anchorX = speechBubbleAnchorX(width, placement);
  const tailX = anchorX * width;
  context.beginPath();
  context.moveTo(radius, 1);
  context.lineTo(width - radius, 1);
  context.quadraticCurveTo(width - 1, 1, width - 1, radius);
  context.lineTo(width - 1, bodyHeight - radius);
  context.quadraticCurveTo(width - 1, bodyHeight - 1, width - radius, bodyHeight - 1);
  context.lineTo(tailX + 9, bodyHeight - 1);
  context.lineTo(tailX, height - 2);
  context.lineTo(tailX - 9, bodyHeight - 1);
  context.lineTo(radius, bodyHeight - 1);
  context.quadraticCurveTo(1, bodyHeight - 1, 1, bodyHeight - radius);
  context.lineTo(1, radius);
  context.quadraticCurveTo(1, 1, radius, 1);
  context.closePath();
  context.fillStyle = 'rgba(9, 15, 23, 0.72)';
  context.fill();
  context.strokeStyle = 'rgba(226, 232, 240, 0.22)';
  context.lineWidth = 1.25;
  context.stroke();
  context.font = `400 ${SPEECH_FONT_PX}px ui-sans-serif, system-ui, "PingFang SC", sans-serif`;
  context.fillStyle = 'rgba(241, 245, 249, 0.88)';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  lines.forEach((line, index) => {
    context.fillText(line, width / 2, paddingTop + lineHeight * (index + 0.5));
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { texture, aspect: width / height, pixelWidth: width, pixelHeight: height, anchorX };
}

// ---------------------------------------------------------------------------
// 3D 像素小人
// ---------------------------------------------------------------------------

type FigureAction = 'idle' | 'walk' | 'gather' | 'attack' | 'carry' | 'ingest'
  | 'craft' | 'work' | 'tend-fire' | 'attend' | 'communicate' | 'care' | 'reproduce';
type FigureAge = 'child' | 'adult' | 'elder';

interface FigureParts {
  group: THREE.Group;
  upright: THREE.Group;
  upperBody: THREE.Group;
  dehydrated: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  spear: THREE.Group;
  handTool: THREE.Group;
  toolHead: THREE.Mesh;
  heldLoad: THREE.Group;
  heldLoadFill: THREE.Mesh;
  tablet: THREE.Group;
  heldFood: THREE.Mesh;
  outerwear: THREE.Mesh;
  bandage: THREE.Mesh;
  belly: THREE.Mesh;
  sprite: THREE.Sprite;
  spriteKey: string;
  speechBubble: THREE.Sprite;
  speechKey: string;
  speechTexture: THREE.CanvasTexture | null;
  speechAspect: number;
  speechPixelWidth: number;
  speechPixelHeight: number;
  speechPlacement: SpeechBubblePlacement;
  visualKey: string;
}

function setSpeechBubbleTexture(
  figure: FigureParts,
  text: string,
  placement: SpeechBubblePlacement,
): void {
  figure.speechTexture?.dispose();
  const bubble = speechBubbleTexture(text, placement);
  figure.speechTexture = bubble.texture;
  figure.speechAspect = bubble.aspect;
  figure.speechPixelWidth = bubble.pixelWidth;
  figure.speechPixelHeight = bubble.pixelHeight;
  figure.speechPlacement = placement;
  figure.speechBubble.center.x = bubble.anchorX;
  figure.speechBubble.material.map = bubble.texture;
  figure.speechBubble.material.needsUpdate = true;
}

function figureAgeOf(agent: SocietyAgent): FigureAge {
  if (agent.body.ageMonths < 12 * 12) return 'child';
  if (agent.conditions.some((condition) => condition.kind === 'aging')
    || agent.body.ageMonths >= agent.lifespanMonths * 0.66) return 'elder';
  return 'adult';
}

function figureVisualKey(agent: SocietyAgent): string {
  return `${agent.sex}|${figureAgeOf(agent)}`;
}

/** 一格内的稳定局部槽位；人物按 id 排序后取槽位，避免都压在格心。 */
function sharedCellOffset(index: number, count: number): { x: number; z: number } {
  if (count <= 1) return { x: 0, z: 0 };
  if (count === 2) return { x: index ? 0.18 : -0.18, z: 0 };
  if (count === 3) {
    const slots = [{ x: 0, z: -0.21 }, { x: -0.19, z: 0.13 }, { x: 0.19, z: 0.13 }];
    return slots[index];
  }
  if (count === 4) {
    const slots = [
      { x: -0.18, z: -0.18 }, { x: 0.18, z: -0.18 },
      { x: -0.18, z: 0.18 }, { x: 0.18, z: 0.18 },
    ];
    return slots[index];
  }
  if (count <= 6) {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return { x: Math.cos(angle) * 0.29, z: Math.sin(angle) * 0.29 };
  }
  // 大群体改用格内规则阵列；0.82 格的安全区会随人数自动收紧。
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const spacing = Math.min(0.17, 0.82 / Math.max(1, columns - 1, rows - 1));
  return {
    x: (index % columns - (columns - 1) / 2) * spacing,
    z: (Math.floor(index / columns) - (rows - 1) / 2) * spacing,
  };
}

function figureActionView(agent: SocietyAgent, intent: IntentView | undefined): ActionVisualView | undefined {
  return agent.visualAction ?? intent;
}

function figureActionOf(agent: SocietyAgent, intent: IntentView | undefined, moving: boolean): FigureAction {
  if (moving) return 'walk';
  const view = figureActionView(agent, intent);
  if (!view) return 'idle';
  if (view.actionKind === 'move') return 'walk';
  if (view.actionKind === 'transfer') return 'carry';
  if (view.actionKind === 'attend') return 'attend';
  if (view.actionKind === 'communicate') return view.channel === 'record' ? 'attend' : 'communicate';
  if (view.operation === 'ingest') return 'ingest';
  if (view.operation === 'hunt') return 'attack';
  if (view.operation === 'separate') return view.toolMaterialId !== undefined ? 'work' : 'gather';
  if (view.operation === 'exert') return view.targetKind === 'person' ? 'attack' : 'work';
  if (view.operation === 'combine') return view.targetKind === 'person' ? 'care' : 'craft';
  if (view.operation === 'expose') return 'tend-fire';
  if (view.operation === 'rehydrate' || view.operation === 'dehydrate') return 'care';
  if (view.operation === 'inter') {
    if (view.mortuaryPhase === 'lift') return 'carry';
    if (view.mortuaryPhase === 'prepare-grave' || view.mortuaryPhase === 'cover-grave' || view.mortuaryPhase === 'mark') return 'work';
    return 'attend';
  }
  if (view.operation === 'reproduce') return 'reproduce';
  return 'idle';
}

function buildFigure(agent: SocietyAgent): FigureParts {
  const group = new THREE.Group();
  group.userData.agentId = agent.id;
  group.scale.setScalar(FIGURE_SCALE);
  const hue = hueOf(agent.id);
  const age = figureAgeOf(agent);
  const ageScale = age === 'child' ? 0.72 : age === 'elder' ? 0.9 : 1;
  const clothLightness = agent.sex === 'female' ? 0.55 : 0.48;
  const cloth = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.42, clothLightness) });
  const pants = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.4, 0.32) });
  const skin = new THREE.MeshLambertMaterial({ color: '#e8c39e' });
  const hair = new THREE.MeshLambertMaterial({ color: age === 'elder' ? '#b8bec5' : '#2c2420' });
  const wood = new THREE.MeshLambertMaterial({ color: '#755235' });
  const stone = new THREE.MeshLambertMaterial({ color: '#a9afb5' });
  const drySkin = new THREE.MeshLambertMaterial({ color: '#9b7657' });
  const dryBand = new THREE.MeshLambertMaterial({ color: '#6f8fa8' });
  const leather = new THREE.MeshLambertMaterial({ color: '#6f4c35' });
  const linen = new THREE.MeshLambertMaterial({ color: '#d8ccb6' });
  const loadMat = new THREE.MeshLambertMaterial({ color: '#a98055' });

  const upright = new THREE.Group();
  upright.scale.setScalar(ageScale);
  const upperBody = new THREE.Group();
  upperBody.position.y = 0.3;

  // 腿：pivot 在胯部（几何体先下移半高）
  const legGeo = new THREE.BoxGeometry(0.11, 0.3, 0.11);
  legGeo.translate(0, -0.15, 0);
  const legL = new THREE.Mesh(legGeo, pants);
  legL.position.set(-0.075, 0.3, 0);
  const legR = new THREE.Mesh(legGeo, pants);
  legR.position.set(0.075, 0.3, 0);
  // 躯干：女性使用稍窄躯干与披衣，儿童靠头身比、老人靠前倾与灰发区分。
  const torsoWidth = agent.sex === 'female' ? 0.29 : 0.34;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth, 0.34, 0.18), cloth);
  torso.position.y = 0.17;
  const shoulderBand = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth + 0.03, 0.055, 0.19), cloth);
  shoulderBand.position.y = 0.31;
  const outerwear = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth + 0.055, 0.37, 0.205), leather);
  outerwear.position.y = 0.16;
  outerwear.visible = false;
  const bandage = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth + 0.075, 0.075, 0.225), linen);
  bandage.position.y = 0.18;
  bandage.rotation.z = -0.18;
  bandage.visible = false;
  const belly = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth * 0.75, 0.19, 0.16), cloth);
  belly.position.set(0, 0.08, 0.15);
  belly.visible = false;
  // 手臂：pivot 在肩
  const armGeo = new THREE.BoxGeometry(0.08, 0.3, 0.08);
  armGeo.translate(0, -0.14, 0);
  const armL = new THREE.Mesh(armGeo, cloth);
  armL.position.set(-torsoWidth / 2 - 0.07, 0.3, 0);
  const armR = new THREE.Mesh(armGeo, cloth);
  armR.position.set(torsoWidth / 2 + 0.07, 0.3, 0);
  // 头 + 发顶
  const headScale = age === 'child' ? 1.12 : 1;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.24 * headScale, 0.24 * headScale, 0.24 * headScale), skin);
  head.position.y = 0.51;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.26 * headScale, 0.07, 0.26 * headScale), hair);
  cap.position.y = 0.645;
  upperBody.add(torso, shoulderBand, outerwear, bandage, belly, armL, armR, head, cap);
  // 仅改变发型轮廓，不凭空增加权威装备；稳定 id 让人物在年月切换后仍可辨认。
  if (Math.floor(hue * 12) % 3 === 0 && age !== 'elder') {
    const hairTuft = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.1), hair);
    hairTuft.position.set(-0.055, 0.72, -0.025);
    hairTuft.rotation.z = -0.24;
    upperBody.add(hairTuft);
  }
  if (agent.sex === 'female') {
    const backHair = new THREE.Mesh(new THREE.BoxGeometry(0.25 * headScale, 0.23, 0.07), hair);
    backHair.position.set(0, 0.49, -0.135);
    const sideHairL = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.2, 0.22), hair);
    sideHairL.position.set(-0.145 * headScale, 0.49, -0.015);
    const sideHairR = sideHairL.clone();
    sideHairR.position.x *= -1;
    upperBody.add(backHair, sideHairL, sideHairR);
  }
  if (age === 'elder') {
    const cane = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.57, 0.035), wood);
    cane.position.set(torsoWidth / 2 + 0.14, 0.285, 0.12);
    const caneGrip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.035, 0.035), wood);
    caneGrip.position.set(torsoWidth / 2 + 0.09, 0.57, 0.12);
    upright.add(cane, caneGrip);
  }

  const spear = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.78, 0.035), wood);
  shaft.position.y = -0.43;
  const spearTip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.09), stone);
  spearTip.position.y = -0.86;
  spear.add(shaft, spearTip);
  spear.visible = false;
  armR.add(spear);

  const handTool = new THREE.Group();
  const toolHandle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.52, 0.04), wood);
  toolHandle.position.y = -0.35;
  const toolHead = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.11, 0.1), stone);
  toolHead.position.set(0.06, -0.62, 0);
  toolHead.rotation.z = 0.28;
  handTool.add(toolHandle, toolHead);
  handTool.visible = false;
  armR.add(handTool);

  const tablet = new THREE.Group();
  const tabletBoard = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.055), wood);
  tabletBoard.position.set(0, -0.33, 0.1);
  tablet.add(tabletBoard);
  for (const y of [-0.26, -0.34, -0.42]) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.015, 0.062), hair);
    line.position.set(0, y, 0.1);
    tablet.add(line);
  }
  tablet.visible = false;
  armL.add(tablet);

  const heldFood = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.13, 0.14), loadMat);
  heldFood.position.set(0, -0.34, 0.08);
  heldFood.visible = false;
  armR.add(heldFood);

  const heldLoad = new THREE.Group();
  const parcel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.24), linen);
  const heldLoadFill = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.09, 0.18), loadMat);
  heldLoadFill.position.y = 0.14;
  const bindingX = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.26), wood);
  const bindingZ = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.05), wood);
  heldLoad.add(parcel, heldLoadFill, bindingX, bindingZ);
  heldLoad.position.set(0, 0.44, 0.33);
  heldLoad.visible = false;
  upright.add(legL, legR, upperBody, heldLoad);

  // 脱水 / 脱水冬眠：收束成干燥卷，不再只是人物换色。
  const dehydrated = new THREE.Group();
  dehydrated.scale.setScalar(ageScale);
  const dryBody = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.13, 0.72), drySkin);
  dryBody.position.set(0, 0.09, 0);
  dehydrated.add(dryBody);
  for (const z of [-0.22, 0, 0.22]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.025, 0.055), dryBand);
    band.position.set(0, 0.16, z);
    dehydrated.add(band);
  }
  const dryHead = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.17, 0.18), skin);
  dryHead.position.set(0, 0.12, 0.43);
  const dryHair = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.19), hair);
  dryHair.position.set(0, 0.22, 0.43);
  dehydrated.add(dryHead, dryHair);

  // 名牌
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: nameTexture(agent.name, '#e2e8f0'),
      transparent: true,
      alphaTest: 0.04,
      depthTest: true,
      depthWrite: false,
    }),
  );
  // 每帧按相机距离更新；这里只提供创建后的安全初值。
  sprite.scale.set(3.2, 0.8, 1);
  sprite.position.y = 1.18;
  sprite.renderOrder = 5;

  const speechBubble = new THREE.Sprite(
    new THREE.SpriteMaterial({
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.02,
      depthTest: false,
      depthWrite: false,
    }),
  );
  speechBubble.visible = false;
  speechBubble.renderOrder = 30;

  group.add(upright, dehydrated, sprite, speechBubble);
  // 身体部件投阴影；名牌不参与阴影与 AO。
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
  // 视觉体素很小，增加不参与渲染的点选体积，让鼠标无需精确落在手脚上。
  const pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  pickMaterial.colorWrite = false;
  const pickProxy = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.1, 1.35), pickMaterial);
  pickProxy.position.y = 0.72;
  pickProxy.castShadow = false;
  pickProxy.userData.agentId = agent.id;
  group.add(pickProxy);
  return {
    group, upright, upperBody, dehydrated, legL, legR, armL, armR,
    spear, handTool, toolHead, heldLoad, heldLoadFill, tablet, heldFood, outerwear, bandage, belly, sprite,
    spriteKey: '', speechBubble, speechKey: '', speechTexture: null, speechAspect: 1,
    speechPixelWidth: 1, speechPixelHeight: 1, speechPlacement: 'center',
    visualKey: figureVisualKey(agent),
  };
}

/** 卸载一个人物（名牌贴图在模块缓存中共享，不随个体销毁） */
function disposeFigure(f: FigureParts): void {
  f.speechTexture?.dispose();
  f.speechTexture = null;
  f.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | undefined;
    if (mat) mat.dispose();
  });
}

export default function SocietyScene3D({
  society,
  era,
  speaker,
  speechLines,
  sky,
  selectedAgentId,
  onSelectAgent,
  selectedObject,
  onSelectObject,
  onZoomOutRequest,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const visibleSpeechLines = useMemo(
    () => latestSpeechBySpeaker(speechLines ?? []),
    [speechLines],
  );
  const speechBySpeaker = useMemo(
    () => new Map(visibleSpeechLines.map((line) => [line.speakerId, line])),
    [visibleSpeechLines],
  );
  const propsRef = useRef({
    society,
    era,
    speaker,
    speechBySpeaker,
    sky,
    selectedAgentId,
    onSelectAgent,
    selectedObject,
    onSelectObject,
    onZoomOutRequest,
  });
  useEffect(() => {
    propsRef.current = {
      society,
      era,
      speaker,
      speechBySpeaker,
      sky,
      selectedAgentId,
      onSelectAgent,
      selectedObject,
      onSelectObject,
      onZoomOutRequest,
    };
  });

  const animStart = useRef(0); // 挂载后由 effect 置为当前时间（渲染期不调非纯函数）
  useEffect(() => { animStart.current = performance.now(); }, [society]);

  // 供主循环外调用的场景 API
  const terrainApiRef = useRef<((s: SocietyState) => void) | null>(null);
  const lightApiRef = useRef<((e: EraKey) => void) | null>(null);
  const decorApiRef = useRef<((s: SocietyState, e: EraKey) => void) | null>(null);
  const skyApiRef = useRef<((snapshot?: HumanSkySnapshot) => void) | null>(null);
  const selectionApiRef = useRef<((s: SocietyState) => void) | null>(null);

  // ---- 主场景（挂载一次）----
  useEffect(() => {
    const mount = mountRef.current!;
    const canvas = canvasRef.current!;
    const world0 = propsRef.current.society.world;
    const COUNT = world0.width * world0.height;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setClearColor('#040610'); // 深空底色：星球浮在宇宙中
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; // 电影级色调映射（由 OutputPass 应用）
    renderer.toneMappingExposure = 1.06;
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog('#070d1c', 175, 460);
    const cameraTarget = new THREE.Vector3(0, 1.5, 0);
    const cameraElevation = THREE.MathUtils.degToRad(34);
    const cameraDirection = new THREE.Vector3(
      Math.cos(cameraElevation) / Math.SQRT2,
      Math.sin(cameraElevation),
      Math.cos(cameraElevation) / Math.SQRT2,
    );
    const cameraRight = new THREE.Vector3(1 / Math.SQRT2, 0, -1 / Math.SQRT2);
    const cameraForward = cameraDirection.clone().negate();
    const cameraUp = new THREE.Vector3().crossVectors(cameraRight, cameraForward).normalize();
    const cameraFinal = cameraTarget.clone().addScaledVector(cameraDirection, 150);
    const cameraEntry = cameraTarget.clone().addScaledVector(cameraDirection, 250);
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 1_200);
    camera.position.copy(cameraEntry); // 沿最终 45° 对角视线从太空入场
    const mountedAt = performance.now();

    // 环境贴图只为 PBR 材质提供稳定反射源；可见天空由下方天空球单独渲染，
    // 避免为了渐变动画每帧重建昂贵的 PMREM。
    let environmentTarget: THREE.WebGLRenderTarget | null = null;
    let skyTexture: THREE.CanvasTexture | null = null;
    {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 256;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 0, c.height);
      grad.addColorStop(0, '#344a70');
      grad.addColorStop(0.42, '#172849');
      grad.addColorStop(0.72, '#0d1730');
      grad.addColorStop(1, '#070b17');
      g.fillStyle = grad;
      g.fillRect(0, 0, c.width, c.height);
      const envTex = new THREE.CanvasTexture(c);
      envTex.mapping = THREE.EquirectangularReflectionMapping;
      envTex.colorSpace = THREE.SRGBColorSpace;
      skyTexture = envTex;
      const pmrem = new THREE.PMREMGenerator(renderer);
      environmentTarget = pmrem.fromEquirectangular(envTex);
      scene.environment = environmentTarget.texture;
      scene.environmentIntensity = 1;
      pmrem.dispose();
    }

    // 非遮蔽体注册表：GTAO 计算期间临时隐藏（见 ScopedGTAOPass）
    const aoExcluded: THREE.Object3D[] = [];

    const controls = new OrbitControls(camera, canvas);
    controls.enabled = false; // 入场动画期间锁定，结束后开放
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minPolarAngle = THREE.MathUtils.degToRad(38); // 最高约 52° 俯视，避免翻到纯顶视
    controls.maxPolarAngle = THREE.MathUtils.degToRad(78); // 最低约 12° 俯角，可抬高视线观察天空
    controls.minDistance = 7;
    controls.maxDistance = 245;
    controls.target.copy(cameraTarget);

    // 以实际世界包围盒求透视相机所需距离。横向使用 viewport aspect，纵向额外
    // 预留树冠/建筑高度；resize 时保留用户当前的缩放比例和旋转方位。
    let cameraFitDistance = 150;
    const fittedDistanceFor = (width: number, height: number): number => {
      const aspect = Math.max(0.45, width / Math.max(1, height));
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
      const tanH = tanV * aspect;
      const halfX = world0.width * 0.5 + 0.75;
      const halfZ = world0.height * 0.5 + 0.75;
      const minY = -1.5;
      const maxY = world0.levels * CELL_H + 2.5;
      const relative = new THREE.Vector3();
      let required = 0;
      for (const x of [-halfX, halfX]) {
        for (const y of [minY, maxY]) {
          for (const z of [-halfZ, halfZ]) {
            relative.set(x, y, z).sub(cameraTarget);
            const towardCamera = relative.dot(cameraDirection);
            const horizontal = Math.abs(relative.dot(cameraRight));
            const vertical = Math.abs(relative.dot(cameraUp));
            required = Math.max(
              required,
              towardCamera + horizontal / (tanH * 0.93),
              towardCamera + vertical / (tanV * 0.92),
            );
          }
        }
      }
      // 入场不再展示完整沙盘轮廓：核心聚落填满画面，外围山脉只作为远景框景。
      // 极少边角允许越出屏幕，继续缩远时再逐步展示更大的地理轮廓。
      return Math.max(46, required * 0.44);
    };
    const updateCameraFit = (width: number, height: number) => {
      const previousFit = cameraFitDistance;
      const previousDistance = camera.position.distanceTo(cameraTarget);
      const currentDirection = camera.position.clone().sub(cameraTarget).normalize();
      cameraFitDistance = fittedDistanceFor(width, height);
      cameraFinal.copy(cameraTarget).addScaledVector(cameraDirection, cameraFitDistance);
      cameraEntry.copy(cameraTarget).addScaledVector(cameraDirection, cameraFitDistance * 1.32);
      // 近景需要能看清单个人物与建筑细节；极角限制仍保证相机不会钻入地面。
      controls.minDistance = Math.max(7, cameraFitDistance * 0.055);
      // 正常人间视角在装饰缓冲带耗尽前停住；继续缩小则进入返回宇宙的过场。
      if (controls.maxDistance < 600) controls.maxDistance = Math.max(88, cameraFitDistance * 1.5);
      if (controls.enabled && previousFit > 0) {
        const minZoomRatio = controls.minDistance / cameraFitDistance;
        const maxZoomRatio = controls.maxDistance / cameraFitDistance;
        const zoomRatio = THREE.MathUtils.clamp(previousDistance / previousFit, minZoomRatio, maxZoomRatio);
        camera.position.copy(cameraTarget).addScaledVector(currentDirection, cameraFitDistance * zoomRatio);
        controls.update();
      }
    };

    // 银河噪声只在挂载时烘焙一次；天空球每帧只采样 Cubemap。
    const galaxyTarget = bakeProceduralGalaxy(renderer);

    // ---- 天空球：天顶、银河、地平线和三颗可见恒星附近的散射均可连续调色 ----
    const skyStarDirections = Array.from({ length: N_STARS }, () => new THREE.Vector3(0, 1, 0));
    const skyStarColors = STAR_STYLES.map((style) => new THREE.Color(style.glow));
    const skyStarStrengths = new Float32Array(N_STARS);
    const skyAtmosphereUniforms = {
      uZenithColor: { value: new THREE.Color(ERA_SKY[propsRef.current.era].nightZenith) },
      uHorizonColor: { value: new THREE.Color(ERA_SKY[propsRef.current.era].nightHorizon) },
      uNadirColor: { value: new THREE.Color(ERA_SKY[propsRef.current.era].nadir) },
      uHazeColor: { value: new THREE.Color(ERA_SKY[propsRef.current.era].haze) },
      uHazeStrength: { value: 0.12 },
      // 沙盘相机始终俯视；把构图中心映射到地平线附近，保留可见的天顶—地平线层次。
      uVerticalBias: { value: -cameraForward.y },
      uStarDirections: { value: skyStarDirections },
      uStarColors: { value: skyStarColors },
      uStarStrengths: { value: skyStarStrengths },
      uGalaxyMap: { value: galaxyTarget.texture },
      uGalaxyVisibility: { value: 0 },
      uGalaxyRotation: { value: 0 },
    };
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(700, 48, 28),
      new THREE.ShaderMaterial({
        uniforms: skyAtmosphereUniforms,
        vertexShader: `
          varying vec3 vSkyDirection;

          void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vSkyDirection = normalize(worldPosition.xyz - cameraPosition);
            vec4 clipPosition = projectionMatrix * viewMatrix * worldPosition;
            clipPosition.z = clipPosition.w;
            gl_Position = clipPosition;
          }
        `,
        fragmentShader: `
          uniform vec3 uZenithColor;
          uniform vec3 uHorizonColor;
          uniform vec3 uNadirColor;
          uniform vec3 uHazeColor;
          uniform float uHazeStrength;
          uniform float uVerticalBias;
          uniform vec3 uStarDirections[3];
          uniform vec3 uStarColors[3];
          uniform float uStarStrengths[3];
          uniform samplerCube uGalaxyMap;
          uniform float uGalaxyVisibility;
          uniform float uGalaxyRotation;
          varying vec3 vSkyDirection;

          void main() {
            vec3 direction = normalize(vSkyDirection);
            float altitude = clamp(direction.y + uVerticalBias, -1.0, 1.0);
            float upper = pow(smoothstep(0.0, 0.84, max(0.0, altitude)), 0.72);
            float lower = smoothstep(0.0, 0.62, max(0.0, -altitude));
            float horizonBand = pow(max(0.0, 1.0 - abs(altitude)), 3.4);
            vec3 color = mix(uHorizonColor, uZenithColor, upper);
            color = mix(color, uNadirColor, lower);
            color = mix(color, uHazeColor, horizonBand * uHazeStrength * 0.22);

            // 沙盘相机始终俯视，因此用校正后的视高度重建天空方向；银河随观察者
            // 自转缓慢横移，并在地平线附近受到大气消光。
            float galaxyCos = cos(uGalaxyRotation);
            float galaxySin = sin(uGalaxyRotation);
            vec3 galaxyDirection = normalize(vec3(direction.x, altitude, direction.z));
            galaxyDirection.xz = mat2(
              galaxyCos, -galaxySin,
              galaxySin, galaxyCos
            ) * galaxyDirection.xz;
            vec3 galaxy = textureCube(uGalaxyMap, galaxyDirection).rgb;
            float atmosphericClarity = smoothstep(0.015, 0.34, max(0.0, altitude));
            color += galaxy * uGalaxyVisibility * atmosphericClarity;

            for (int i = 0; i < 3; i++) {
              float alignment = max(0.0, dot(direction, normalize(uStarDirections[i])));
              float broadScatter = pow(alignment, 28.0);
              float nearScatter = pow(alignment, 220.0);
              color += uStarColors[i]
                * (broadScatter * 0.055 + nearScatter * 0.12)
                * uStarStrengths[i];
            }
            gl_FragColor = vec4(color, 1.0);
          }
        `,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    skyDome.renderOrder = -100;
    const distantSky = createDistantSkyLayer({ mode: 'surface', radius: 625, renderOrder: -95 });

    // ---- 稳定星野：准均匀球面分布 + 三层尺寸/亮度，避免少量随机点像坏点 ----
    const skyBackdrop = new THREE.Group();
    const liveCameraDirection = new THREE.Vector3();
    const skyStarMaterials: Array<{ material: THREE.PointsMaterial; baseOpacity: number }> = [];
    skyBackdrop.add(skyDome, distantSky.group);
    const starLayerDefinitions = [
      { count: 1_800, size: 0.82, opacity: 0.30, warmChance: 0.10, seed: 0x7e1a4d31 },
      { count: 420, size: 1.22, opacity: 0.54, warmChance: 0.16, seed: 0x51c0b8a7 },
      { count: 72, size: 1.85, opacity: 0.78, warmChance: 0.24, seed: 0x2d93f06b },
    ] as const;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    starLayerDefinitions.forEach((definition, layerIndex) => {
      const rng = mulberry32(definition.seed);
      const pos = new Float32Array(definition.count * 3);
      const col3 = new Float32Array(definition.count * 3);
      const cool = new THREE.Color('#cdd8ff');
      const warm = new THREE.Color('#ffe2bd');
      for (let i = 0; i < definition.count; i++) {
        const y = 1 - ((i + 0.5) / definition.count) * 2;
        const radial = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = i * goldenAngle + layerIndex * 1.37 + (rng() - 0.5) * 0.24;
        const radius = 470 + rng() * 120;
        pos[i * 3] = radius * radial * Math.cos(theta);
        pos[i * 3 + 1] = radius * y;
        pos[i * 3 + 2] = radius * radial * Math.sin(theta);
        const base = rng() < definition.warmChance ? warm : cool;
        const brightness = 0.48 + Math.pow(rng(), 1.8) * 0.52;
        col3[i * 3] = base.r * brightness;
        col3[i * 3 + 1] = base.g * brightness;
        col3[i * 3 + 2] = base.b * brightness;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(col3, 3));
      const material = new THREE.PointsMaterial({
        size: definition.size,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      const layer = new THREE.Points(geometry, material);
      layer.frustumCulled = false;
      layer.renderOrder = -90 + layerIndex;
      skyBackdrop.add(layer);
      skyStarMaterials.push({ material, baseOpacity: definition.opacity });
    });
    const skyStars = skyBackdrop;
    scene.add(skyBackdrop);
    aoExcluded.push(skyBackdrop);

    // ---- 人间天穹：把当前三体系统的相对方位投影成可辨认的恒星圆面 ----
    const skyGlowTexture = makeHumanSkyGlowTexture();
    const skySurfaceTextures: THREE.CanvasTexture[] = [];
    const skySpinRates = [0.014, -0.011, 0.021];
    const skySuns: Array<{
      core: THREE.Mesh;
      glow: THREE.Sprite;
      angle: number;
      targetAngle: number;
      apparentScale: number;
      targetScale: number;
      glowOpacity: number;
      targetGlowOpacity: number;
      horizonOpacity: number;
      enabled: boolean;
    }> = [];
    for (let i = 0; i < N_STARS; i++) {
      const surface = makeStarSurfaceTexture(STAR_STYLES[i].core, STAR_STYLES[i].glow, 3100 + i * 131);
      skySurfaceTextures.push(surface);
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(2.15, 32, 24),
        new THREE.MeshBasicMaterial({
          map: surface,
          color: '#e8e8e8',
          transparent: true,
          opacity: 0,
          depthTest: true,
          depthWrite: false,
          fog: false,
          toneMapped: false,
        }),
      );
      core.renderOrder = 42;
      core.visible = false;
      core.rotation.x = 0.18 + i * 0.23;
      core.rotation.z = -0.12 + i * 0.17;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: skyGlowTexture,
        color: STAR_STYLES[i].glow,
        transparent: true,
        opacity: 0.48,
        blending: THREE.AdditiveBlending,
        depthTest: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }));
      glow.renderOrder = 41;
      glow.visible = false;
      scene.add(glow);
      scene.add(core);
      aoExcluded.push(glow, core);
      skySuns.push({
        core,
        glow,
        angle: 0,
        targetAngle: 0,
        apparentScale: 1,
        targetScale: 1,
        glowOpacity: 0.48,
        targetGlowOpacity: 0.48,
        horizonOpacity: 0,
        enabled: false,
      });
    }

    // 世界空间中的天穹基底：平移时会跟随观察点，旋转视角时不会跟随相机转动。
    const skyForward = cameraForward.clone();
    const skyRight = cameraRight.clone();
    const skyUp = cameraUp.clone();
    const skyDirection = new THREE.Vector3();
    let skyObserverPhase = 0;
    let skyElapsedSeconds = 0;
    let skyInitialized = false;

    skyApiRef.current = (snapshot) => {
      if (!snapshot || snapshot.bodies.length < 8) {
        skySuns.forEach((star, index) => {
          star.enabled = false;
          star.core.visible = star.glow.visible = false;
          skyStarStrengths[index] = 0;
        });
        return;
      }

      const planetX = snapshot.bodies[6];
      const planetY = snapshot.bodies[7];
      const stars = Array.from({ length: N_STARS }, (_, index) => {
        const dx = snapshot.bodies[index * 2] - planetX;
        const dy = snapshot.bodies[index * 2 + 1] - planetY;
        return { index, angle: Math.atan2(dy, dx), distance: Math.max(0.001, Math.hypot(dx, dy)) };
      });
      const nearest = stars.reduce((best, current) => current.distance < best.distance ? current : best);
      const fluxGlow = THREE.MathUtils.clamp(0.44 + Math.log2(Math.max(0.15, snapshot.fluxRel)) * 0.035, 0.34, 0.62);
      if (!skyInitialized) {
        // 初次进入落在昼半球；随后由人间自转连续推进，不在每次 React 更新时重置太阳位置。
        skyObserverPhase = nearest.angle - Math.PI / 3 + Math.sin(snapshot.t * 0.09) * 0.08;
        skyElapsedSeconds = 0;
        skyInitialized = true;
      }
      stars.forEach((star) => {
        const skySun = skySuns[star.index];
        const nextScale = THREE.MathUtils.clamp(Math.sqrt(nearest.distance / star.distance), 0.68, 1.18)
          * (star.index === 2 ? 0.78 : 1);
        if (!skySun.enabled) {
          skySun.angle = star.angle;
          skySun.targetAngle = star.angle;
          skySun.apparentScale = nextScale;
          skySun.targetScale = nextScale;
          skySun.glowOpacity = fluxGlow;
          skySun.targetGlowOpacity = fluxGlow;
        } else {
          // 新物理快照只更新目标值；渲染帧负责走最短圆弧追上，避免月度上报造成瞬移。
          skySun.targetAngle = star.angle;
          skySun.targetScale = nextScale;
          skySun.targetGlowOpacity = fluxGlow;
        }
        skySun.enabled = true;
      });
    };
    skyApiRef.current(propsRef.current.sky);

    const updateHumanSky = (deltaSeconds: number) => {
      if (!skyInitialized) return;
      // 只累计实际渲染过的帧时间；页面隐藏时 RAF 停止，回来后不会追赶后台时间而跳位。
      skyElapsedSeconds += deltaSeconds;
      // 恒速自转承载主要运动，极轻的长周期岁差打破完全匀速、匀弧的机械感。
      const observerPhase = skyObserverPhase
        + skyElapsedSeconds * 0.01
        + Math.sin(skyElapsedSeconds * 0.0065) * 0.022;
      skyAtmosphereUniforms.uGalaxyRotation.value = observerPhase * 0.72;
      distantSky.group.rotation.y = observerPhase * 0.72;
      skySuns.forEach((star, index) => {
        if (!star.enabled) return;
        const angleBlend = 1 - Math.exp(-deltaSeconds * 2.4);
        const shortestAngle = Math.atan2(
          Math.sin(star.targetAngle - star.angle),
          Math.cos(star.targetAngle - star.angle),
        );
        star.angle += shortestAngle * angleBlend;
        star.apparentScale = THREE.MathUtils.damp(star.apparentScale, star.targetScale, 3.2, deltaSeconds);
        star.glowOpacity = THREE.MathUtils.damp(star.glowOpacity, star.targetGlowOpacity, 3.2, deltaSeconds);
        const localAngle = star.angle - observerPhase;
        const altitude = Math.sin(localAngle);
        const targetHorizonOpacity = THREE.MathUtils.smoothstep(altitude, -0.045, 0.11);
        star.horizonOpacity = THREE.MathUtils.damp(star.horizonOpacity, targetHorizonOpacity, 5.5, deltaSeconds);
        const visible = star.horizonOpacity > 0.002;
        star.core.visible = star.glow.visible = visible;

        const horizontal = Math.cos(localAngle);
        // 三体引擎是二维轨道；微小纬度偏移只用于避免方向近乎重合时三个圆面完全叠在一起。
        const declination = (index - 1) * 0.025;
        skyDirection.copy(skyForward)
          .addScaledVector(skyRight, horizontal * 0.16 + declination)
          // 沙盘相机始终俯视，实际可见天空只在地图上沿；把昼弧落入这条窄天空带。
          .addScaledVector(skyUp, 0.13 + altitude * 0.12)
          .normalize();
        skyStarDirections[index].copy(skyDirection);
        skyStarStrengths[index] = star.horizonOpacity
          * star.glowOpacity
          * star.apparentScale
          * (0.34 + skyDaylightStrength * 0.66);
        star.core.position.copy(camera.position).addScaledVector(skyDirection, 180);
        star.glow.position.copy(star.core.position);
        star.core.scale.setScalar(star.apparentScale);
        (star.core.material as THREE.MeshBasicMaterial).opacity = star.horizonOpacity;

        const slowPulse = 1
          + Math.sin(skyElapsedSeconds * 0.72 + index * 2.1) * 0.035
          + Math.sin(skyElapsedSeconds * 1.83 + index * 1.3) * 0.014;
        star.glow.scale.setScalar(16 * star.apparentScale * slowPulse);
        (star.glow.material as THREE.SpriteMaterial).opacity = star.glowOpacity
          * (0.97 + Math.sin(skyElapsedSeconds * 0.91 + index * 2.35) * 0.045)
          * star.horizonOpacity;
        star.core.rotation.y += skySpinRates[index] * deltaSeconds;
        star.core.rotation.x += Math.sin(skyElapsedSeconds * 0.31 + index) * deltaSeconds * 0.0015;
      });
    };

    // ---- 光照：独立的人间日照循环 + 纪元调制，不从天穹恒星位置推导 ----
    let activeLightEra = propsRef.current.era;
    let lightingElapsedSeconds = 0;
    const sunlightTargetPosition = new THREE.Vector3();
    const daylightTone = new THREE.Color();
    const sunlightTargetColor = new THREE.Color();
    const eraSunColor = new THREE.Color();
    const chaosTone = new THREE.Color();
    const fogTargetColor = new THREE.Color(ERA_LIGHT[activeLightEra].fog);
    const skyZenithTarget = new THREE.Color(ERA_SKY[activeLightEra].nightZenith);
    const skyHorizonTarget = new THREE.Color(ERA_SKY[activeLightEra].nightHorizon);
    const skyNadirTarget = new THREE.Color(ERA_SKY[activeLightEra].nadir);
    const skyHazeTarget = new THREE.Color(ERA_SKY[activeLightEra].haze);
    const skyColorScratch = new THREE.Color();
    let skyDaylightStrength = 0;
    let skyStarVisibility = 0;
    let fogTargetNear = 175;
    let fogTargetFar = 460;

    const hemi = new THREE.HemisphereLight('#d5e3f3', '#66705d', 0.92);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1d6', 1.15);
    const initialDaylight = sampleDaylight(0, sunlightTargetPosition, daylightTone);
    const initialEraLight = ERA_LIGHT[activeLightEra];
    sunlightTargetColor.set(initialEraLight.sun).lerp(daylightTone, 0.56);
    sun.position.copy(sunlightTargetPosition);
    sun.color.copy(sunlightTargetColor);
    sun.intensity = initialEraLight.sunI * initialDaylight.direct * 0.82;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const shadowExtent = Math.max(world0.width, world0.height) / 2 + 8;
    sun.shadow.camera.left = -shadowExtent;
    sun.shadow.camera.right = shadowExtent;
    sun.shadow.camera.top = shadowExtent;
    sun.shadow.camera.bottom = -shadowExtent;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.00008;
    sun.shadow.normalBias = 0.032;
    sun.shadow.radius = 3.2;
    scene.add(sun);
    // 少量无阴影直射光模拟天空与地表的多次散射，避免体素背光面和云影落成纯黑。
    const sunScatter = new THREE.DirectionalLight(sun.color, initialEraLight.sunI * initialDaylight.direct * 0.18);
    sunScatter.position.copy(sun.position);
    scene.add(sunScatter);
    const rim = new THREE.DirectionalLight('#9fb8e8', 0.62);
    rim.position.set(44, 34, 50); // 镜头侧冷填光只抬暗面，不与主光争夺形体
    scene.add(rim);

    // ---- 稳定世界种子驱动的双层云；下层进入太阳深度图，形成随风移动的真实云影 ----
    const cloudNoiseTexture = makeCloudNoiseTexture(world0.generator.seed);
    const cloudShadowTexture = cloudNoiseTexture.clone();
    cloudShadowTexture.repeat.set(1, 1);
    cloudShadowTexture.offset.set(0, 0);
    cloudShadowTexture.needsUpdate = true;
    const cloudShadowMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      alphaMap: cloudShadowTexture,
      alphaTest: 0.20,
      side: THREE.DoubleSide,
    });
    const cloudShadowUniforms = {
      threshold: { value: CLOUD_WEATHER.clear.shadowThreshold },
      presence: { value: 0 },
    };
    cloudShadowMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uCloudThreshold = cloudShadowUniforms.threshold;
      shader.uniforms.uCloudPresence = cloudShadowUniforms.presence;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          `uniform float uCloudThreshold;
uniform float uCloudPresence;
void main() {`,
        )
        .replace(
          '#include <alphamap_fragment>',
          `#ifdef USE_ALPHAMAP
  vec2 centeredUv = vAlphaMapUv * 2.0 - 1.0;
  float radialFade = 1.0 - smoothstep(0.30, 0.94, length(centeredUv));
  float cloudA = texture2D(alphaMap, vAlphaMapUv).g;
  float cloudB = texture2D(alphaMap, vAlphaMapUv * 0.72 + vec2(0.14, 0.18)).g;
  float cloudDensity = cloudA * 0.68 + cloudB * 0.32;
  diffuseColor.a *= uCloudPresence * radialFade
    * smoothstep(uCloudThreshold - 0.11, uCloudThreshold + 0.09, cloudDensity);
#endif`,
        );
    };
    cloudShadowMaterial.customProgramCacheKey = () => 'cloud-shadow-local-caster-v5';
    const cloudShadowGeometry = new THREE.CircleGeometry(1, 24);
    const cloudShadowSurfaceMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // 可见云由多个椭球体组成真实空间云团：近景因位于世界外缘而不遮住聚落，
    // 拉远或升空后可从下方、侧面和上方观察；移动始终是同一世界风向的直线平移。
    const cloudVisualGroup = new THREE.Group();
    const cloudBlobGeometry = new THREE.SphereGeometry(1, 16, 10);
    const cloudFieldHalfX = world0.width * 0.5 + 66;
    const cloudFieldHalfZ = world0.height * 0.5 + 60;
    const cloudCellSize = 6;
    const cloudWindDirection = new THREE.Vector2(1, 0.34).normalize();
    const cloudClusters = Array.from({ length: 14 }, (_, index) => {
      const angleJitter = (visualSpatialHash(world0.generator.seed, index, 3, 0x1b873593) - 0.5) * 0.22;
      const angle = index / 14 * Math.PI * 2 + angleJitter;
      const radialScale = 0.52 + visualSpatialHash(world0.generator.seed, index, 7, 0x85ebca6b) * 0.26;
      const baseY = 19 + visualSpatialHash(world0.generator.seed, index, 11, 0xc2b2ae35) * 7;
      const material = makeCloudVolumeMaterial(cloudNoiseTexture);
      const cluster = new THREE.Group();
      const blobCount = 4 + Math.floor(visualSpatialHash(world0.generator.seed, index, 13, 0x27d4eb2f) * 3);
      for (let blobIndex = 0; blobIndex < blobCount; blobIndex += 1) {
        const blob = new THREE.Mesh(cloudBlobGeometry, material);
        const horizontal = (visualSpatialHash(world0.generator.seed, index, blobIndex, 0x165667b1) - 0.5) * 9;
        const depth = (visualSpatialHash(world0.generator.seed, blobIndex, index, 0x9e3779b9) - 0.5) * 6;
        const lift = (visualSpatialHash(world0.generator.seed, index + blobIndex, 17, 0x7f4a7c15) - 0.5) * 2.8;
        blob.position.set(horizontal, lift, depth);
        blob.scale.set(
          4.2 + visualSpatialHash(world0.generator.seed, index, blobIndex, 0x72e4a19b) * 3.1,
          1.45 + visualSpatialHash(world0.generator.seed, blobIndex, index, 0x18c6d2f1) * 1.15,
          3.1 + visualSpatialHash(world0.generator.seed, index + 5, blobIndex, 0x3e7a91d5) * 2.3,
        );
        blob.castShadow = false;
        blob.receiveShadow = false;
        blob.renderOrder = -18 + index * 0.001 + blobIndex * 0.0001;
        cluster.add(blob);

        // 每个云泡对应一个椭圆投影，重叠后形成不规则云影；几何本身不再含矩形轮廓。
        const shadowCaster = new THREE.Mesh(cloudShadowGeometry, cloudShadowSurfaceMaterial);
        shadowCaster.rotation.x = -Math.PI / 2;
        shadowCaster.position.set(horizontal, -1.1, depth);
        shadowCaster.scale.set(blob.scale.x * 0.78, blob.scale.z * 0.78, 1);
        shadowCaster.castShadow = true;
        shadowCaster.receiveShadow = false;
        shadowCaster.customDepthMaterial = cloudShadowMaterial;
        cluster.add(shadowCaster);
      }
      cluster.position.set(
        Math.round(Math.cos(angle) * cloudFieldHalfX * radialScale / cloudCellSize) * cloudCellSize,
        baseY,
        Math.round(Math.sin(angle) * cloudFieldHalfZ * radialScale / cloudCellSize) * cloudCellSize,
      );
      cluster.userData.cloudBaseY = baseY;
      cluster.userData.cloudPhase = visualSpatialHash(world0.generator.seed, index, 19, 0x27d4eb2d) * Math.PI * 2;
      cluster.userData.cloudDrift = 0.78 + visualSpatialHash(world0.generator.seed, index, 23, 0x6bc2a483) * 0.46;
      cluster.userData.cloudActivation = 0.14 + visualSpatialHash(world0.generator.seed, index, 29, 0x5f356495) * 0.66;
      cluster.userData.cloudMaterial = material;
      cloudVisualGroup.add(cluster);
      return cluster;
    });
    const cloudGroup = new THREE.Group();
    cloudGroup.add(cloudVisualGroup);
    scene.add(cloudGroup);
    aoExcluded.push(cloudGroup);

    const cloudOffset = new THREE.Vector2(
      visualSpatialHash(world0.generator.seed, 11, 17, 0x72e4a19b),
      visualSpatialHash(world0.generator.seed, 23, 5, 0x18c6d2f1),
    );
    let cloudMorphPhase = visualSpatialHash(world0.generator.seed, 3, 19, 0x27d4eb2d) * Math.PI * 2;
    let cloudOpacity = CLOUD_WEATHER.clear.opacity;
    let cloudPresence = CLOUD_WEATHER.clear.presence;
    let cloudShadowThreshold = CLOUD_WEATHER.clear.shadowThreshold;
    let cloudSpeed = CLOUD_WEATHER.clear.speed;
    const cloudLightTarget = new THREE.Color(CLOUD_WEATHER.clear.light);
    const cloudShadeTarget = new THREE.Color(CLOUD_WEATHER.clear.shade);

    lightApiRef.current = (eraKey) => {
      activeLightEra = eraKey;
    };

    const updateLighting = (deltaSeconds: number) => {
      lightingElapsedSeconds += deltaSeconds;
      const phase = (lightingElapsedSeconds % DAYLIGHT_CYCLE_SECONDS) / DAYLIGHT_CYCLE_SECONDS;
      const daylight = sampleDaylight(phase, sunlightTargetPosition, daylightTone);
      const eraLight = ERA_LIGHT[activeLightEra];
      const chaotic = isChaoticLightEra(activeLightEra);
      const weather = propsRef.current.society.weather ?? { kind: 'clear' as const, intensity: 0, sinceMonth: 0 };
      const weatherStrength = THREE.MathUtils.clamp(weather.intensity / 10, 0, 1);
      let directMultiplier = daylight.direct;
      let ambientMultiplier = daylight.ambient;
      let exposureMultiplier = daylight.exposure;

      eraSunColor.set(eraLight.sun);
      sunlightTargetColor.copy(eraSunColor).lerp(daylightTone, chaotic ? 0.38 : 0.56);

      if (chaotic) {
        // 多个非整数周期叠加出不可预测但连续的乱纪元光变；不读取恒星位置，也不制造领域事实。
        const chaosA = Math.sin(lightingElapsedSeconds * 0.41 + Math.sin(lightingElapsedSeconds * 0.13) * 1.8);
        const chaosB = Math.sin(lightingElapsedSeconds * 0.73 + 1.4);
        const thermalShift = Math.sin(lightingElapsedSeconds * 0.19 - 0.7);
        sunlightTargetPosition.x += chaosA * 44 + chaosB * 16;
        sunlightTargetPosition.y = THREE.MathUtils.clamp(
          sunlightTargetPosition.y + chaosA * 18 - chaosB * 10,
          12,
          96,
        );
        sunlightTargetPosition.z += chaosB * 42 - chaosA * 12;
        directMultiplier *= THREE.MathUtils.clamp(0.94 + chaosA * 0.46 + chaosB * 0.24, 0.34, 1.64);
        ambientMultiplier *= THREE.MathUtils.clamp(0.88 - chaosA * 0.16 + chaosB * 0.08, 0.68, 1.12);
        exposureMultiplier *= THREE.MathUtils.clamp(0.96 + chaosA * 0.10 + chaosB * 0.05, 0.82, 1.12);

        if (activeLightEra === 'chaotic-heat') chaosTone.set('#ff8a48');
        else if (activeLightEra === 'chaotic-cold') chaosTone.set('#91b7ff');
        else chaosTone.set(thermalShift >= 0 ? '#ff9a56' : '#91b9ff');
        sunlightTargetColor.lerp(chaosTone, 0.28 + Math.abs(thermalShift) * 0.30);
      }

      // 阴雨、雪与雾减少直射但保留大气散射；云影负责局部明暗，不伪造天气事实。
      const overcast = weather.kind === 'storm' ? 0.38 + weatherStrength * 0.30
        : weather.kind === 'rain' ? 0.20 + weatherStrength * 0.22
          : weather.kind === 'snow' ? 0.24 + weatherStrength * 0.20
            : weather.kind === 'fog' ? 0.32 + weatherStrength * 0.24 : 0;
      directMultiplier *= 1 - overcast;
      ambientMultiplier *= 1 - overcast * 0.10;
      exposureMultiplier *= 1 - overcast * 0.06;

      const blend = 1 - Math.exp(-LIGHT_DAMPING * deltaSeconds);
      sun.position.lerp(sunlightTargetPosition, blend);
      sun.color.lerp(sunlightTargetColor, blend);
      sunScatter.position.copy(sun.position);
      sunScatter.color.copy(sun.color);
      const targetDirectIntensity = eraLight.sunI * directMultiplier;
      sun.intensity = THREE.MathUtils.damp(sun.intensity, targetDirectIntensity * 0.82, LIGHT_DAMPING, deltaSeconds);
      sunScatter.intensity = THREE.MathUtils.damp(sunScatter.intensity, targetDirectIntensity * 0.18, LIGHT_DAMPING, deltaSeconds);
      hemi.intensity = THREE.MathUtils.damp(hemi.intensity, eraLight.hemi * ambientMultiplier, LIGHT_DAMPING, deltaSeconds);
      rim.intensity = THREE.MathUtils.damp(rim.intensity, eraLight.rim * ambientMultiplier, LIGHT_DAMPING, deltaSeconds);
      scene.environmentIntensity = THREE.MathUtils.damp(
        scene.environmentIntensity,
        eraLight.env * ambientMultiplier,
        LIGHT_DAMPING,
        deltaSeconds,
      );
      renderer.toneMappingExposure = THREE.MathUtils.damp(
        renderer.toneMappingExposure,
        eraLight.exposure * exposureMultiplier,
        LIGHT_DAMPING,
        deltaSeconds,
      );

      // 可见天空与日照、纪元和天气共享目标状态；这只改变表现层，不反向影响模拟。
      const skyPalette = ERA_SKY[activeLightEra];
      const daylightStrength = THREE.MathUtils.smoothstep(directMultiplier, 0.30, 0.94);
      skyZenithTarget.set(skyPalette.nightZenith)
        .lerp(skyColorScratch.set(skyPalette.dayZenith), daylightStrength);
      skyHorizonTarget.set(skyPalette.nightHorizon)
        .lerp(skyColorScratch.set(skyPalette.dayHorizon), daylightStrength);
      skyNadirTarget.set(skyPalette.nadir);
      skyHazeTarget.set(skyPalette.haze);
      let hazeStrength = THREE.MathUtils.lerp(0.08, 0.34, daylightStrength);
      let starWeatherVisibility = 1;

      if (weather.kind === 'fog') {
        const veil = 0.48 + weatherStrength * 0.30;
        skyZenithTarget.lerp(skyColorScratch.set('#758188'), veil * 0.72);
        skyHorizonTarget.lerp(skyColorScratch.set('#aab5b5'), veil);
        skyNadirTarget.lerp(skyColorScratch.set('#5f696c'), veil * 0.64);
        hazeStrength = 0.88;
        starWeatherVisibility = 0.03;
      } else if (weather.kind === 'storm') {
        skyZenithTarget.lerp(skyColorScratch.set('#172431'), 0.54 + weatherStrength * 0.24);
        skyHorizonTarget.lerp(skyColorScratch.set('#3d5362'), 0.48 + weatherStrength * 0.24);
        hazeStrength = 0.62;
        starWeatherVisibility = 0.10;
      } else if (weather.kind === 'rain') {
        skyZenithTarget.lerp(skyColorScratch.set('#263747'), 0.38 + weatherStrength * 0.22);
        skyHorizonTarget.lerp(skyColorScratch.set('#526574'), 0.34 + weatherStrength * 0.20);
        hazeStrength = 0.58;
        starWeatherVisibility = 0.24;
      } else if (weather.kind === 'snow') {
        skyZenithTarget.lerp(skyColorScratch.set('#677887'), 0.32 + weatherStrength * 0.22);
        skyHorizonTarget.lerp(skyColorScratch.set('#abb8c1'), 0.42 + weatherStrength * 0.22);
        hazeStrength = 0.66;
        starWeatherVisibility = 0.16;
      } else if (weather.kind === 'drought') {
        skyZenithTarget.lerp(skyColorScratch.set('#62503b'), 0.20 + weatherStrength * 0.20);
        skyHorizonTarget.lerp(skyColorScratch.set('#9f8059'), 0.32 + weatherStrength * 0.24);
        hazeStrength = 0.62;
        starWeatherVisibility = 0.56;
      }

      skyDaylightStrength = THREE.MathUtils.damp(
        skyDaylightStrength,
        daylightStrength,
        LIGHT_DAMPING,
        deltaSeconds,
      );
      const starVisibilityTarget = Math.pow(1 - daylightStrength, 1.65) * starWeatherVisibility;
      skyStarVisibility = THREE.MathUtils.damp(
        skyStarVisibility,
        starVisibilityTarget,
        LIGHT_DAMPING,
        deltaSeconds,
      );
      skyAtmosphereUniforms.uGalaxyVisibility.value = THREE.MathUtils.damp(
        skyAtmosphereUniforms.uGalaxyVisibility.value,
        starVisibilityTarget * 0.72,
        LIGHT_DAMPING,
        deltaSeconds,
      );
      distantSky.setVisibility(starVisibilityTarget);
      skyAtmosphereUniforms.uZenithColor.value.lerp(skyZenithTarget, blend);
      skyAtmosphereUniforms.uHorizonColor.value.lerp(skyHorizonTarget, blend);
      skyAtmosphereUniforms.uNadirColor.value.lerp(skyNadirTarget, blend);
      skyAtmosphereUniforms.uHazeColor.value.lerp(skyHazeTarget, blend);
      skyAtmosphereUniforms.uHazeStrength.value = THREE.MathUtils.damp(
        skyAtmosphereUniforms.uHazeStrength.value,
        hazeStrength,
        LIGHT_DAMPING,
        deltaSeconds,
      );
      skyStarMaterials.forEach(({ material, baseOpacity }) => {
        material.opacity = baseOpacity * skyStarVisibility;
      });

      const fog = scene.fog as THREE.Fog;
      fog.color.lerp(fogTargetColor, blend);
      fog.near = THREE.MathUtils.damp(fog.near, fogTargetNear, LIGHT_DAMPING, deltaSeconds);
      fog.far = THREE.MathUtils.damp(fog.far, fogTargetFar, LIGHT_DAMPING, deltaSeconds);
      renderer.setClearColor(fog.color);
    };

    const updateClouds = (deltaSeconds: number) => {
      const weather = propsRef.current.society.weather ?? { kind: 'clear' as const, intensity: 0, sinceMonth: 0 };
      const profile = CLOUD_WEATHER[weather.kind];
      const severity = THREE.MathUtils.clamp((weather.intensity - 1) / 9, 0, 1);
      const targetOpacity = THREE.MathUtils.clamp(profile.opacity + severity * 0.06, 0, 1);
      const targetPresence = profile.presence * THREE.MathUtils.lerp(0.72, 1, severity);
      const targetShadowThreshold = profile.shadowThreshold - (weather.kind === 'clear' || weather.kind === 'drought' ? 0 : severity * 0.045);

      // 生成和消散都保留数秒过渡，但晴天、旱天与雾天最终会彻底无云。
      cloudOpacity = THREE.MathUtils.damp(cloudOpacity, targetOpacity, 0.46, deltaSeconds);
      cloudPresence = THREE.MathUtils.damp(cloudPresence, targetPresence, 0.38, deltaSeconds);
      cloudShadowThreshold = THREE.MathUtils.damp(cloudShadowThreshold, targetShadowThreshold, 0.46, deltaSeconds);
      cloudSpeed = THREE.MathUtils.damp(cloudSpeed, profile.speed, 0.72, deltaSeconds);
      cloudLightTarget.set(profile.light);
      cloudShadeTarget.set(profile.shade);

      cloudMorphPhase += deltaSeconds * (0.18 + cloudSpeed * 0.075);
      const shadowWindX = deltaSeconds * cloudSpeed * 0.0016;
      const shadowWindY = deltaSeconds * cloudSpeed * 0.00052;
      cloudOffset.x = (cloudOffset.x + shadowWindX) % 1;
      cloudOffset.y = (cloudOffset.y + shadowWindY) % 1;
      cloudNoiseTexture.offset.copy(cloudOffset);
      cloudShadowUniforms.threshold.value = cloudShadowThreshold;
      cloudShadowUniforms.presence.value = cloudPresence;

      const nightVisibility = THREE.MathUtils.lerp(0.52, 1, skyDaylightStrength);
      const colorBlend = 1 - Math.exp(-0.9 * deltaSeconds);
      cloudClusters.forEach((cluster, index) => {
        const material = cluster.userData.cloudMaterial as THREE.ShaderMaterial;
        const layerOffset = material.uniforms.uOffset.value as THREE.Vector2;
        layerOffset.set(
          (cloudOffset.x * (0.82 + index * 0.07) + index * 0.19) % 1,
          (cloudOffset.y * (1.08 - index * 0.06) + index * 0.23) % 1,
        );
        const activation = cluster.userData.cloudActivation as number;
        const activationFade = THREE.MathUtils.smoothstep(cloudPresence, activation - 0.16, activation + 0.08);
        material.uniforms.uOpacity.value = cloudOpacity * activationFade * nightVisibility * 0.72;
        material.uniforms.uDaylight.value = skyDaylightStrength;
        (material.uniforms.uLightColor.value as THREE.Color).lerp(cloudLightTarget, colorBlend);
        (material.uniforms.uShadeColor.value as THREE.Color).lerp(cloudShadeTarget, colorBlend);

        // Minecraft 式世界云场：统一高度层、固定世界朝向、按 ticks 沿风向平移并在边界循环。
        const drift = cluster.userData.cloudDrift as number;
        const travel = deltaSeconds * (0.72 + cloudSpeed * 0.62) * drift;
        cluster.position.x += cloudWindDirection.x * travel;
        cluster.position.z += cloudWindDirection.y * travel;
        if (cluster.position.x > cloudFieldHalfX) cluster.position.x -= cloudFieldHalfX * 2;
        if (cluster.position.x < -cloudFieldHalfX) cluster.position.x += cloudFieldHalfX * 2;
        if (cluster.position.z > cloudFieldHalfZ) cluster.position.z -= cloudFieldHalfZ * 2;
        if (cluster.position.z < -cloudFieldHalfZ) cluster.position.z += cloudFieldHalfZ * 2;
        cluster.position.y = (cluster.userData.cloudBaseY as number)
          + Math.sin(cloudMorphPhase * 0.36 + (cluster.userData.cloudPhase as number)) * 0.18;
        cluster.visible = activationFade > 0.006 && cloudOpacity > 0.006;
      });
    };

    // ---- 地形体素柱（InstancedMesh，逐实例颜色；PBR 材质）----
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const land = new THREE.InstancedMesh(
      boxGeo,
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.02 }),
      COUNT,
    );
    land.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    land.castShadow = land.receiveShadow = true;
    scene.add(land);
    // 权威网格之外只延续地形轮廓与颜色。外圈先抬升成环形山脉，再沉入雾色；
    // 它不进入任何领域状态、交互射线、寻路或资源判断。
    const apronSideWidth = world0.width + TERRAIN_APRON_CELLS * 2;
    const apronSideHeight = world0.height + TERRAIN_APRON_CELLS * 2;
    const APRON_CAP = apronSideWidth * apronSideHeight - COUNT;
    const apronGeo = new THREE.BoxGeometry(1, 1, 1);
    const apronFadeAttribute = new THREE.InstancedBufferAttribute(new Float32Array(APRON_CAP), 1);
    apronGeo.setAttribute('apronFade', apronFadeAttribute);
    const apronMat = new THREE.MeshStandardMaterial({
      color: '#ffffff', roughness: 0.96, metalness: 0, dithering: true,
    });
    apronMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float apronFade;\nvarying float vApronFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvApronFade = apronFade;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vApronFade;')
        .replace(
          '#include <colorspace_fragment>',
          '#include <colorspace_fragment>\n#ifdef USE_FOG\ngl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(0.48, 1.0, vApronFade));\n#endif',
        );
    };
    apronMat.customProgramCacheKey = () => 'terrain-apron-mountains-v2';
    const terrainApron = new THREE.InstancedMesh(apronGeo, apronMat, APRON_CAP);
    terrainApron.count = 0;
    terrainApron.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    terrainApron.castShadow = false;
    terrainApron.receiveShadow = true;
    scene.add(terrainApron);
    aoExcluded.push(terrainApron);
    // 远景植被只在山脚和缓坡形成轮廓，不复用可采集树木实体，避免被误认为
    // 权威资源。两层树冠保持现有微体素语言，同时把额外绘制稳定在三个批次内。
    const APRON_VEGETATION_CAP = Math.ceil(APRON_CAP * 0.24);
    const apronTrunks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.94, metalness: 0 }),
      APRON_VEGETATION_CAP,
    );
    const apronCanopies = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, metalness: 0 }),
      APRON_VEGETATION_CAP * 2,
    );
    for (const mesh of [apronTrunks, apronCanopies]) {
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
    // 地表内部仍用 1/4 格低对比颗粒；草土、沙地、耕地与湿润岸线改用 1/8 格八邻域过渡。
    // 单一 InstancedMesh 保留合批，不为每格创建独立纹理或材质。
    const GROUND_DETAIL_CAP = COUNT * 28;
    const groundDetailGeo = new THREE.PlaneGeometry(1, 1);
    groundDetailGeo.rotateX(-Math.PI / 2);
    const groundDetail = new THREE.InstancedMesh(
      groundDetailGeo,
      new THREE.MeshStandardMaterial({
        color: '#ffffff', roughness: 0.96, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }),
      GROUND_DETAIL_CAP,
    );
    groundDetail.count = 0;
    groundDetail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groundDetail.castShadow = false;
    groundDetail.receiveShadow = true;
    groundDetail.renderOrder = 2;
    scene.add(groundDetail);
    aoExcluded.push(groundDetail);
    // 水体积仍严格来自权威液体体素；表现层把所有顶面合进一个网格，只在真实岸缘
    // 生成侧壁。这样不再渲染相邻透明盒的内部侧面，也不会出现逐格叠色形成的棋盘缝。
    const waterMat = new THREE.MeshPhysicalMaterial({
      color: '#347f91', roughness: 0.24, metalness: 0,
      transmission: 0.34, ior: 1.33, thickness: 0.28, specularIntensity: 1.02,
      attenuationColor: '#5aa4af', attenuationDistance: 4.8,
      clearcoat: 0.34, clearcoatRoughness: 0.3,
      emissive: '#0b2d38', emissiveIntensity: 0.16,
    });
    const waterSurface = new THREE.Mesh(new THREE.BufferGeometry(), waterMat);
    waterSurface.receiveShadow = false; // 树冠阴影不再把窄河压成纯黑沟槽
    waterSurface.renderOrder = 1;
    scene.add(waterSurface);
    aoExcluded.push(waterSurface); // 透射水不是实体遮蔽体，避免 GTAO 给水面压出暗边
    const waterSideMat = new THREE.MeshStandardMaterial({
      color: '#245f70', roughness: 0.42, metalness: 0,
      transparent: true, opacity: 0.76, side: THREE.DoubleSide,
    });
    const waterSides = new THREE.Mesh(new THREE.BufferGeometry(), waterSideMat);
    waterSides.receiveShadow = false;
    waterSides.renderOrder = 1;
    scene.add(waterSides);
    aoExcluded.push(waterSides);

    // 湿土/湿沙以 1/8 格微体素跨入水格边缘，打散整格直角；它只覆盖水面的一小段，
    // 不改变该格在权威世界中仍然是 Water 的事实。
    const SHORE_LIP_CAP = COUNT * 16;
    const shoreLip = new THREE.InstancedMesh(
      boxGeo,
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.98, metalness: 0 }),
      SHORE_LIP_CAP,
    );
    shoreLip.count = 0;
    shoreLip.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shoreLip.castShadow = false;
    shoreLip.receiveShadow = true;
    shoreLip.renderOrder = 4;
    scene.add(shoreLip);
    aoExcluded.push(shoreLip);

    const waterFlowUniforms = { uTime: { value: 0 }, uRain: { value: 0 } };
    const waterFlow = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: waterFlowUniforms,
        vertexShader: `
          attribute vec2 aFlowDirection;
          attribute vec2 aFlowLocal;
          attribute vec4 aFlowNeighbors;
          varying vec2 vFlowCoord;
          varying vec2 vFlowDirection;
          varying vec2 vFlowLocal;
          varying vec4 vFlowNeighbors;

          void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vFlowCoord = worldPosition.xz;
            vFlowDirection = normalize(aFlowDirection);
            vFlowLocal = aFlowLocal;
            vFlowNeighbors = aFlowNeighbors;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uRain;
          varying vec2 vFlowCoord;
          varying vec2 vFlowDirection;
          varying vec2 vFlowLocal;
          varying vec4 vFlowNeighbors;

          void main() {
            // 世界坐标保证相邻格共用相位；局部流向只旋转波纹，不会重置纹理原点。
            vec2 voxel = floor(vFlowCoord * 8.0) / 8.0;
            vec2 direction = normalize(vFlowDirection);
            vec2 acrossDirection = vec2(-direction.y, direction.x);
            float along = dot(voxel, direction);
            float across = dot(voxel, acrossDirection);
            float time = uTime * (1.0 + uRain * 0.28);
            float mainBand = 0.5 + 0.5 * sin(
              along * 4.2 - time * 1.45 + sin(across * 4.8) * 0.42
            );
            float crossBand = 0.5 + 0.5 * sin(
              along * 7.6 - time * 2.05 + across * 2.1
            );
            float flow = smoothstep(0.38, 0.94, mainBand) * (0.72 + crossBand * 0.28);
            vec3 flowColor = mix(vec3(0.12, 0.36, 0.42), vec3(0.31, 0.58, 0.62), flow);
            // 没有相邻水格的一侧是真实河岸。流纹在岸边两微格内退去，
            // 避免透明高光盖到湿土/湿沙的岸缘台阶上。
            float bankDistance = 1.0;
            if (vFlowNeighbors.x < 0.5) bankDistance = min(bankDistance, vFlowLocal.y);
            if (vFlowNeighbors.y < 0.5) bankDistance = min(bankDistance, 1.0 - vFlowLocal.x);
            if (vFlowNeighbors.z < 0.5) bankDistance = min(bankDistance, 1.0 - vFlowLocal.y);
            if (vFlowNeighbors.w < 0.5) bankDistance = min(bankDistance, vFlowLocal.x);
            float bankFade = smoothstep(0.22, 0.38, bankDistance);
            float alpha = (0.012 + flow * (0.058 + uRain * 0.014)) * bankFade;
            gl_FragColor = vec4(flowColor, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    waterFlow.position.y = 0.012;
    waterFlow.castShadow = waterFlow.receiveShadow = false;
    waterFlow.renderOrder = 3;
    scene.add(waterFlow);
    aoExcluded.push(waterFlow);

    // ---- 权威天气的动态投影：雨/雪/扬尘粒子与雾距离，不改写世界状态 ----
    const weatherHash = (index: number, salt: number): number => {
      const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
      return value - Math.floor(value);
    };
    const WEATHER_HEIGHT = 18;
    const RAIN_COUNT = 900;
    const rainPositions = new Float32Array(RAIN_COUNT * 2 * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (weatherHash(i, 1) - 0.5) * world0.width;
      const y = 1.5 + weatherHash(i, 2) * WEATHER_HEIGHT;
      const z = (weatherHash(i, 3) - 0.5) * world0.height;
      const offset = i * 6;
      rainPositions[offset] = x; rainPositions[offset + 1] = y; rainPositions[offset + 2] = z;
      rainPositions[offset + 3] = x + 0.07; rainPositions[offset + 4] = y - 0.55; rainPositions[offset + 5] = z + 0.03;
    }
    const rainGeo = new THREE.BufferGeometry();
    const rainAttribute = new THREE.BufferAttribute(rainPositions, 3);
    rainAttribute.setUsage(THREE.DynamicDrawUsage);
    rainGeo.setAttribute('position', rainAttribute);
    const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
      color: '#b8d8ec', transparent: true, opacity: 0.42, depthWrite: false, fog: true,
    }));
    rain.visible = false;
    rain.renderOrder = 12;
    scene.add(rain);
    aoExcluded.push(rain);

    const SNOW_COUNT = 650;
    const snowPositions = new Float32Array(SNOW_COUNT * 3);
    for (let i = 0; i < SNOW_COUNT; i++) {
      snowPositions[i * 3] = (weatherHash(i, 4) - 0.5) * world0.width;
      snowPositions[i * 3 + 1] = 1 + weatherHash(i, 5) * WEATHER_HEIGHT;
      snowPositions[i * 3 + 2] = (weatherHash(i, 6) - 0.5) * world0.height;
    }
    const snowGeo = new THREE.BufferGeometry();
    const snowAttribute = new THREE.BufferAttribute(snowPositions, 3);
    snowAttribute.setUsage(THREE.DynamicDrawUsage);
    snowGeo.setAttribute('position', snowAttribute);
    const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
      color: '#f3f7fb', size: 2.1, sizeAttenuation: false, transparent: true, opacity: 0.72,
      depthWrite: false, fog: true,
    }));
    snow.visible = false;
    snow.renderOrder = 12;
    scene.add(snow);
    aoExcluded.push(snow);

    const DUST_COUNT = 320;
    const dustPositions = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i++) {
      dustPositions[i * 3] = (weatherHash(i, 7) - 0.5) * world0.width;
      dustPositions[i * 3 + 1] = 0.2 + weatherHash(i, 8) * 4.2;
      dustPositions[i * 3 + 2] = (weatherHash(i, 9) - 0.5) * world0.height;
    }
    const dustGeo = new THREE.BufferGeometry();
    const dustAttribute = new THREE.BufferAttribute(dustPositions, 3);
    dustAttribute.setUsage(THREE.DynamicDrawUsage);
    dustGeo.setAttribute('position', dustAttribute);
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      color: '#c8aa75', size: 1.45, sizeAttenuation: false, transparent: true, opacity: 0.34,
      depthWrite: false, fog: true,
    }));
    dust.visible = false;
    dust.renderOrder = 11;
    scene.add(dust);
    aoExcluded.push(dust);

    const wrapWeatherAxis = (value: number, half: number): number => {
      if (value < -half) return half;
      if (value > half) return -half;
      return value;
    };
    const updateWeather = (now: number, deltaSeconds: number) => {
      const p = propsRef.current;
      const weather = p.society.weather ?? { kind: 'clear' as const, intensity: 0, sinceMonth: 0 };
      const strength = THREE.MathUtils.clamp(weather.intensity, 1, 10);
      rain.visible = weather.kind === 'rain' || weather.kind === 'storm';
      snow.visible = weather.kind === 'snow';
      dust.visible = weather.kind === 'drought';
      waterFlowUniforms.uRain.value = rain.visible ? Math.min(1, 0.35 + strength * 0.09) : 0;

      const eraFog = ERA_LIGHT[p.era].fog;
      fogTargetColor.set(weather.kind === 'fog' ? '#aab5b5'
        : weather.kind === 'rain' || weather.kind === 'storm' ? '#34495d'
          : weather.kind === 'snow' ? '#9cabb8'
            : weather.kind === 'drought' ? '#806d50' : eraFog);
      if (weather.kind === 'fog') { fogTargetNear = 36; fogTargetFar = 115 + (10 - strength) * 7; }
      else if (weather.kind === 'storm') { fogTargetNear = 65; fogTargetFar = 185 + (10 - strength) * 6; }
      else if (weather.kind === 'rain' || weather.kind === 'snow') { fogTargetNear = 90; fogTargetFar = 245; }
      else if (weather.kind === 'drought') { fogTargetNear = 115; fogTargetFar = 330; }
      else { fogTargetNear = 175; fogTargetFar = 460; }

      if (rain.visible) {
        const speed = 10 + strength * 1.1;
        const wind = weather.kind === 'storm' ? 2.4 + strength * 0.28 : 0.55;
        for (let i = 0; i < RAIN_COUNT; i++) {
          const offset = i * 6;
          let x = rainPositions[offset] + wind * deltaSeconds;
          let y = rainPositions[offset + 1] - speed * deltaSeconds;
          let z = rainPositions[offset + 2] + wind * 0.38 * deltaSeconds;
          if (y < 0) y += WEATHER_HEIGHT;
          x = wrapWeatherAxis(x, world0.width / 2);
          z = wrapWeatherAxis(z, world0.height / 2);
          rainPositions[offset] = x; rainPositions[offset + 1] = y; rainPositions[offset + 2] = z;
          rainPositions[offset + 3] = x + wind * 0.045; rainPositions[offset + 4] = y - 0.55; rainPositions[offset + 5] = z + wind * 0.018;
        }
        rainAttribute.needsUpdate = true;
      }
      if (snow.visible) {
        for (let i = 0; i < SNOW_COUNT; i++) {
          const offset = i * 3;
          snowPositions[offset] = wrapWeatherAxis(
            snowPositions[offset] + Math.sin(now * 0.0012 + i * 1.73) * deltaSeconds * (0.35 + strength * 0.04),
            world0.width / 2,
          );
          snowPositions[offset + 1] -= deltaSeconds * (0.65 + strength * 0.08);
          if (snowPositions[offset + 1] < 0) snowPositions[offset + 1] += WEATHER_HEIGHT;
        }
        snowAttribute.needsUpdate = true;
      }
      if (dust.visible) {
        for (let i = 0; i < DUST_COUNT; i++) {
          const offset = i * 3;
          dustPositions[offset] = wrapWeatherAxis(dustPositions[offset] + deltaSeconds * (0.5 + strength * 0.12), world0.width / 2);
          dustPositions[offset + 1] += Math.sin(now * 0.0015 + i) * deltaSeconds * 0.08;
          dustPositions[offset + 2] = wrapWeatherAxis(dustPositions[offset + 2] + deltaSeconds * 0.18, world0.height / 2);
        }
        dustAttribute.needsUpdate = true;
      }
    };
    // 掉落物、建筑与动物统一由装饰层渲染，不保留旧占位网格。

    // ---- 立方体星球化 ----
    // 边界柱的地层剖面：逐层堆叠真实物质色（columns 数据），替代单一色柱
    const perimeter = 2 * (world0.width + world0.height);
    const STRATA_CAP = perimeter * 12; // levels 上限 12
    const strata = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, metalness: 0.02 }),
      STRATA_CAP,
    );
    strata.count = 0;
    strata.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    strata.castShadow = strata.receiveShadow = true;
    scene.add(strata);
    // 星球底壳：暗色岩座
    const underside = new THREE.Mesh(
      new THREE.BoxGeometry(world0.width, 1.4, world0.height),
      new THREE.MeshStandardMaterial({ color: '#221d1a', roughness: 0.95, metalness: 0 }),
    );
    underside.position.set(0, -0.76, 0);
    underside.receiveShadow = true;
    scene.add(underside);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const decorAxisY = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const structureSelectionGroup = new THREE.Group();
    structureSelectionGroup.name = 'structure-selection-proxies';
    scene.add(structureSelectionGroup);

    const clearStructureSelection = () => {
      for (const child of [...structureSelectionGroup.children]) {
        structureSelectionGroup.remove(child);
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    };

    selectionApiRef.current = (s) => {
      clearStructureSelection();
      const w = s.world;
      for (const structure of s.structures) {
        if (structure.occupiedCells.length === 0) continue;
        const xs = structure.occupiedCells.map((cellId) => cellId % w.width);
        const zs = structure.occupiedCells.map((cellId) => Math.floor(cellId / w.width));
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minZ = Math.min(...zs);
        const maxZ = Math.max(...zs);
        const topLayer = Math.max(
          ...structure.occupiedCells.map((cellId) => w.columns[cellId]?.length ?? (w.elevation[cellId] + 1)),
          ...structure.interiorPositions.map((position) => position.z + 1),
          2,
        );
        const height = Math.max(1.4, topLayer * CELL_H + 0.8);
        const material = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthTest: false,
          depthWrite: false,
        });
        material.colorWrite = false;
        const proxy = new THREE.Mesh(
          new THREE.BoxGeometry(maxX - minX + 1, height, maxZ - minZ + 1),
          material,
        );
        proxy.position.set(
          (minX + maxX) / 2 - w.width / 2 + 0.5,
          height / 2,
          (minZ + maxZ) / 2 - w.height / 2 + 0.5,
        );
        proxy.userData.structureId = structure.id;
        structureSelectionGroup.add(proxy);
      }
    };

    terrainApiRef.current = (s) => {
      const w = s.world;
      const structureCells = new Set(s.structures.flatMap((structure) => structure.occupiedCells));
      const liquidDepthByCell = new Uint8Array(COUNT);
      const liquidStartByCell = new Uint8Array(COUNT);
      const liquidTopByCell = new Float32Array(COUNT);
      const liquidBaseByCell = new Float32Array(COUNT);
      for (let cellId = 0; cellId < COUNT; cellId++) {
        const stack = w.columns[cellId];
        const topMaterial = w.palette[stack[0]];
        let start = topMaterial?.tags.includes('liquid') ? 0 : topMaterial?.key === 'water_wheel' ? 1 : stack.length;
        while (start < stack.length && !w.palette[stack[start]]?.tags.includes('liquid')) start++;
        let depth = 0;
        while (start + depth < stack.length && w.palette[stack[start + depth]]?.tags.includes('liquid')) depth++;
        liquidStartByCell[cellId] = depth > 0 ? start : 0;
        liquidDepthByCell[cellId] = depth;
        if (depth > 0) {
          const liquidHeight = depth * CELL_H;
          const columnHeight = (w.elevation[cellId] + 1) * CELL_H;
          const displayFeatureDepth = start > 0 ? featureDepth(w, cellId, structureCells) : 0;
          const liquidTop = Math.max(liquidHeight, columnHeight - displayFeatureDepth * CELL_H);
          liquidTopByCell[cellId] = liquidTop;
          liquidBaseByCell[cellId] = Math.max(0, liquidTop - liquidHeight);
        }
      }
      const hasLiquid = (x: number, y: number): boolean => x >= 0 && x < w.width
        && y >= 0 && y < w.height
        && liquidDepthByCell[y * w.width + x] > 0;
      const flowDirection = (x: number, y: number): readonly [number, number] => {
        // 初始河流贯穿南北：优先沿 +Z 继续；横向短步只在河道真实转弯处出现。
        // 对未来非河流液体，这仍只依赖局部连通拓扑，并给孤立水格稳定的南向表演。
        if (hasLiquid(x, y + 1)) return [0, 1];
        if (hasLiquid(x + 1, y) && hasLiquid(x + 1, y + 1)) return [1, 0];
        if (hasLiquid(x - 1, y) && hasLiquid(x - 1, y + 1)) return [-1, 0];
        if (hasLiquid(x, y - 1)) return [0, 1];
        if (hasLiquid(x + 1, y) && !hasLiquid(x - 1, y)) return [1, 0];
        if (hasLiquid(x - 1, y) && !hasLiquid(x + 1, y)) return [-1, 0];
        return [0, 1];
      };
      // 完整结构的装饰房会替代其权威建造体素的视觉表现。室内站立位置的 z
      // 是双脚所在空气层，因此 z * CELL_H 正好是承重地面的顶面；把整片占地
      // 截回这个高度，避免屋顶/墙体的 topZ 被 land 拉成从地底升起的实心基座。
      // 未完成结构由 featureDepth 裁回原地面，再由装饰层绘制施工阶段模型。
      const completeStructureBaseByCell = new Map<number, number>();
      for (const structure of s.structures) {
        if (!structure.complete || structure.interiorPositions.length === 0) continue;
        const structureBaseZ = Math.min(...structure.interiorPositions.map((position) => position.z));
        const baseByInteriorCell = new Map<number, number>();
        for (const position of structure.interiorPositions) {
          const current = baseByInteriorCell.get(position.cellId);
          if (current === undefined || position.z < current) baseByInteriorCell.set(position.cellId, position.z);
        }
        for (const cellId of structure.occupiedCells) {
          const baseZ = baseByInteriorCell.get(cellId) ?? structureBaseZ;
          const current = completeStructureBaseByCell.get(cellId);
          if (current === undefined || baseZ < current) completeStructureBaseByCell.set(cellId, baseZ);
        }
      }
      const apronStoneColor = w.palette.find((material) => material.key === 'stone')?.color ?? [108, 106, 100];
      let aproni = 0;
      let apronTrunki = 0;
      let apronCanopyi = 0;
      for (let apronY = -TERRAIN_APRON_CELLS; apronY < w.height + TERRAIN_APRON_CELLS; apronY++) {
        for (let apronX = -TERRAIN_APRON_CELLS; apronX < w.width + TERRAIN_APRON_CELLS; apronX++) {
          if (apronX >= 0 && apronX < w.width && apronY >= 0 && apronY < w.height) continue;

          const outsideX = apronX < 0 ? -apronX : apronX >= w.width ? apronX - w.width + 1 : 0;
          const outsideY = apronY < 0 ? -apronY : apronY >= w.height ? apronY - w.height + 1 : 0;
          // 到矩形权威边界的欧氏距离让四个角自然变圆，避免再出现同心矩形轮廓。
          const edgeDistance = Math.hypot(outsideX, outsideY);
          const fade = THREE.MathUtils.clamp(
            (edgeDistance - 1) / Math.max(1, TERRAIN_APRON_CELLS - 1),
            0,
            1,
          );
          const ring = Math.max(1, Math.ceil(edgeDistance));
          const jitterSpan = Math.min(6, Math.max(1, Math.floor(ring * 0.42)));
          const jitterX = Math.round((visualSpatialHash(w.generator.seed, apronX, apronY, 11) - 0.5) * jitterSpan * 2);
          const jitterY = Math.round((visualSpatialHash(w.generator.seed, apronX, apronY, 17) - 0.5) * jitterSpan * 2);
          const sourceX = THREE.MathUtils.clamp(
            apronY < 0 || apronY >= w.height ? apronX + jitterX : apronX,
            0,
            w.width - 1,
          );
          const sourceY = THREE.MathUtils.clamp(
            apronX < 0 || apronX >= w.width ? apronY + jitterY : apronY,
            0,
            w.height - 1,
          );
          const sourceId = sourceY * w.width + sourceX;
          const macroNoise = visualSmoothNoise(w.generator.seed, apronX, apronY, 12, 101);
          const mediumNoise = visualSmoothNoise(w.generator.seed, apronX, apronY, 5, 109);
          const detailNoise = visualSmoothNoise(w.generator.seed, apronX, apronY, 2, 127);
          const ridgeNoise = macroNoise * 0.52 + mediumNoise * 0.33 + detailNoise * 0.15;
          // 山地随离开权威边界而逐渐增多，但只在噪声脊线上抬升；这会形成断续
          // 山链和山口，而不是沿固定距离生成一圈矩形等高线。
          const ridgedMacro = 1 - Math.abs(macroNoise * 2 - 1);
          const chainField = ridgedMacro * 0.5 + mediumNoise * 0.34 + detailNoise * 0.16;
          const outwardGrowth = THREE.MathUtils.smoothstep(fade, 0.04, 0.64);
          const chainMask = THREE.MathUtils.smoothstep(chainField + fade * 0.1, 0.52, 0.72);
          const sourceFeatureDepth = featureDepth(w, sourceId, structureCells);
          const sourceHeight = Math.max(
            CELL_H,
            (w.elevation[sourceId] + 1 - sourceFeatureDepth) * CELL_H,
          );
          const sourceMaterial = w.palette[w.surface[sourceId]];
          const sourceIsLiquid = Boolean(sourceMaterial?.tags.includes('liquid'));
          // 河流从权威边界向外只形成低谷，不被装饰山体凭空截断。
          const valleyFactor = sourceIsLiquid ? 0.08 : 1;
          const mountainRise = Math.round(
            outwardGrowth * chainMask * valleyFactor * (0.35 + Math.pow(ridgeNoise, 1.25) * 4.4) / CELL_H,
          ) * CELL_H;
          const outerFalloff = 1 - THREE.MathUtils.smoothstep(fade, 0.88, 1);
          const displayHeight = Math.max(0.025, sourceHeight * outerFalloff + mountainRise);
          m4.compose(
            v.set(
              apronX - w.width / 2 + 0.5,
              displayHeight / 2,
              apronY - w.height / 2 + 0.5,
            ),
            q.identity(),
            sc.set(1, displayHeight, 1),
          );
          terrainApron.setMatrixAt(aproni, m4);
          let apronColor = cellColor(w, sourceId);
          const underlayMaterialId = featureUnderlayMaterialId(w, sourceId, structureCells);
          if (underlayMaterialId !== undefined) {
            const underlay = w.palette[underlayMaterialId];
            if (underlay) apronColor = { r: underlay.color[0], g: underlay.color[1], b: underlay.color[2] };
          }
          const rockAmount = THREE.MathUtils.clamp(
            THREE.MathUtils.smoothstep(mountainRise, 0.65, 3.4) * (0.52 + ridgeNoise * 0.36),
            0,
            0.68,
          );
          const tone = 0.94 + detailNoise * 0.09 - fade * 0.05;
          terrainApron.setColorAt(aproni, col.setRGB(
            Math.min(255, THREE.MathUtils.lerp(apronColor.r, apronStoneColor[0], rockAmount) * tone) / 255,
            Math.min(255, THREE.MathUtils.lerp(apronColor.g, apronStoneColor[1], rockAmount) * tone) / 255,
            Math.min(255, THREE.MathUtils.lerp(apronColor.b, apronStoneColor[2], rockAmount) * tone) / 255,
            THREE.SRGBColorSpace,
          ));
          apronFadeAttribute.setX(aproni, fade);
          aproni++;

          const forestNoise = visualSmoothNoise(w.generator.seed, apronX, apronY, 9, 211);
          const vegetationBand = 1 - THREE.MathUtils.smoothstep(fade, 0.5, 0.82);
          const slopeSuitability = 1 - THREE.MathUtils.smoothstep(mountainRise, 1.4, 3.1);
          const clusterDensity = THREE.MathUtils.smoothstep(forestNoise, 0.42, 0.72);
          const sandPenalty = sourceMaterial?.key === 'sand' ? 0.12 : 1;
          const vegetationChance = 0.38 * vegetationBand * slopeSuitability * clusterDensity * sandPenalty;
          if (!sourceIsLiquid
            && apronTrunki < APRON_VEGETATION_CAP
            && apronCanopyi + 1 < APRON_VEGETATION_CAP * 2
            && visualSpatialHash(w.generator.seed, apronX, apronY, 223) < vegetationChance) {
            const treeScale = 0.72 + visualSpatialHash(w.generator.seed, apronX, apronY, 227) * 0.66;
            const treeX = apronX - w.width / 2 + 0.5
              + (visualSpatialHash(w.generator.seed, apronX, apronY, 229) - 0.5) * 0.44;
            const treeZ = apronY - w.height / 2 + 0.5
              + (visualSpatialHash(w.generator.seed, apronX, apronY, 233) - 0.5) * 0.44;
            const trunkHeight = 0.56 * treeScale;
            m4.compose(
              v.set(treeX, displayHeight + trunkHeight / 2, treeZ),
              q.identity(),
              sc.set(0.14 * treeScale, trunkHeight, 0.14 * treeScale),
            );
            apronTrunks.setMatrixAt(apronTrunki, m4);
            const barkTone = 0.82 + visualSpatialHash(w.generator.seed, apronX, apronY, 239) * 0.18;
            apronTrunks.setColorAt(apronTrunki, col.setRGB(
              70 / 255 * barkTone,
              52 / 255 * barkTone,
              34 / 255 * barkTone,
              THREE.SRGBColorSpace,
            ));
            apronTrunki++;

            const leafTone = 0.82 + visualSpatialHash(w.generator.seed, apronX, apronY, 241) * 0.22;
            m4.compose(
              v.set(treeX, displayHeight + trunkHeight + 0.23 * treeScale, treeZ),
              q.identity(),
              sc.set(0.72 * treeScale, 0.5 * treeScale, 0.72 * treeScale),
            );
            apronCanopies.setMatrixAt(apronCanopyi, m4);
            apronCanopies.setColorAt(apronCanopyi, col.setRGB(
              25 / 255 * leafTone,
              84 / 255 * leafTone,
              48 / 255 * leafTone,
              THREE.SRGBColorSpace,
            ));
            apronCanopyi++;
            m4.compose(
              v.set(treeX, displayHeight + trunkHeight + 0.62 * treeScale, treeZ),
              q.identity(),
              sc.set(0.46 * treeScale, 0.54 * treeScale, 0.46 * treeScale),
            );
            apronCanopies.setMatrixAt(apronCanopyi, m4);
            apronCanopies.setColorAt(apronCanopyi, col.setRGB(
              31 / 255 * leafTone,
              102 / 255 * leafTone,
              56 / 255 * leafTone,
              THREE.SRGBColorSpace,
            ));
            apronCanopyi++;
          }
        }
      }
      terrainApron.count = aproni;
      terrainApron.computeBoundingSphere();
      apronTrunks.count = apronTrunki;
      apronCanopies.count = apronCanopyi;
      apronTrunks.computeBoundingSphere();
      apronCanopies.computeBoundingSphere();
      let sti = 0;
      for (let cellId = 0; cellId < COUNT; cellId++) {
        const { x, y } = cellCoordinates(cellId, w.width);
        const wx = x - w.width / 2 + 0.5;
        const wz = y - w.height / 2 + 0.5;
        const stack = w.columns[cellId];
        const liquidDepth = liquidDepthByCell[cellId];
        const liquidStart = liquidStartByCell[cellId];
        const h = (w.elevation[cellId] + 1) * CELL_H;
        const completeStructureBaseZ = completeStructureBaseByCell.get(cellId);
        const isBoundary = x === 0 || x === w.width - 1 || y === 0 || y === w.height - 1;
        if (completeStructureBaseZ !== undefined && liquidDepth === 0) {
          const baseZ = Math.max(1, Math.floor(completeStructureBaseZ));
          const baseH = baseZ * CELL_H;
          m4.compose(v.set(wx, baseH / 2, wz), q.identity(), sc.set(1, baseH, 1));
          land.setMatrixAt(cellId, m4);

          // columns 是自顶向下、跳过 Air 的非空气材料。底部 baseZ 项对应站立层
          // 以下的紧实地层；优先取其中第一个非 building 材质，避免把墙/地板色
          // 继续投到裁平后的地面。若旧存档只有建筑/石层，则退回窗口顶材质。
          const baseMaterials = stack.slice(Math.max(0, stack.length - baseZ));
          const groundMaterialId = baseMaterials.find((materialId) =>
            !w.palette[materialId]?.tags.includes('building'))
            ?? baseMaterials.find((materialId) => w.palette[materialId]?.tags.includes('ground'))
            ?? baseMaterials[0];
          const groundColor = w.palette[groundMaterialId]?.color ?? [90, 80, 70];
          const shade = Math.max(-12, Math.min(12, (baseZ - 1 - 5) * 2));
          const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value + shade))) / 255;
          land.setColorAt(cellId, col.setRGB(
            channel(groundColor[0]), channel(groundColor[1]), channel(groundColor[2]), THREE.SRGBColorSpace,
          ));
        } else if (isBoundary) {
          // 边界柱收进地层网格；顶部液体留给独立水网格，避免出现不透明蓝色截面。
          m4.compose(v.set(wx, 0, wz), q.identity(), sc.set(0.0001, 0.0001, 0.0001));
          land.setMatrixAt(cellId, m4);
          land.setColorAt(cellId, col.setRGB(0, 0, 0));
          for (let k = liquidDepth; k < stack.length && sti < STRATA_CAP; k++) {
            const yc = (stack.length - k - 0.5) * CELL_H;
            m4.compose(v.set(wx, yc, wz), q, sc.set(1, CELL_H, 1));
            strata.setMatrixAt(sti, m4);
            if (k === 0 && liquidDepth === 0) {
              const cc = cellColor(w, cellId); // 顶层与内部格同色
              col.setRGB(cc.r / 255, cc.g / 255, cc.b / 255, THREE.SRGBColorSpace);
            } else {
              const mat = w.palette[stack[k]];
              const mc = mat?.color ?? [90, 80, 70];
              col.setRGB(mc[0] / 255, mc[1] / 255, mc[2] / 255, THREE.SRGBColorSpace);
            }
            strata.setColorAt(sti, col);
            sti++;
          }
        } else {
          if (liquidDepth > 0) {
            // 功能设施可以位于水体素上方；水面高度扣除其视觉替身深度，仍保留真实河流。
            const waterBaseH = liquidBaseByCell[cellId];
            const bed = w.palette[stack[liquidStart + liquidDepth]];
            const bedColor = bed?.color ?? [90, 80, 70];
            const visibleH = Math.max(0.0001, waterBaseH);
            m4.compose(v.set(wx, visibleH / 2, wz), q.identity(), sc.set(1, visibleH, 1));
            land.setMatrixAt(cellId, m4);
            land.setColorAt(cellId, col.setRGB(
              bedColor[0] / 255, bedColor[1] / 255, bedColor[2] / 255, THREE.SRGBColorSpace,
            ));
          } else {
            // 树木等堆叠特征会缩短地形柱；灌木/作物/道路只替换顶面外观，
            // 未完成结构则裁回地面并交给施工印章渲染。
            const fd = featureDepth(w, cellId, structureCells);
            const underlayMaterialId = featureUnderlayMaterialId(w, cellId, structureCells);
            const hEff = fd > 0 ? Math.max(CELL_H, h - fd * CELL_H) : h;
            m4.compose(v.set(wx, hEff / 2, wz), q.identity(), sc.set(1, hEff, 1));
            land.setMatrixAt(cellId, m4);
            let c = cellColor(w, cellId);
            if (underlayMaterialId !== undefined) {
              // 柱顶显示特征物下方的真实地皮颜色（树长草上、麦田长土壤上）
              const under = w.palette[underlayMaterialId];
              if (under) {
                const shade = Math.max(-12, Math.min(12, (w.elevation[cellId] - fd - 5) * 2));
                const cc = (n: number) => Math.max(0, Math.min(255, Math.round(n + shade)));
                c = { r: cc(under.color[0]), g: cc(under.color[1]), b: cc(under.color[2]) };
              }
            }
            land.setColorAt(cellId, col.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace));
          }
        }
      }

      // 所有水格的顶面进入同一个 BufferGeometry；同高相邻格只共享平面，不再有
      // 透明内部侧面。只有水域外缘或水位真实落差处才补一面垂直水壁。
      const topPositions: number[] = [];
      const topIndices: number[] = [];
      const topFlowDirections: number[] = [];
      const topFlowLocal: number[] = [];
      const topFlowNeighbors: number[] = [];
      const sidePositions: number[] = [];
      const sideIndices: number[] = [];
      const appendTop = (
        minX: number,
        maxX: number,
        top: number,
        minZ: number,
        maxZ: number,
        direction: readonly [number, number],
        neighbors: readonly [number, number, number, number],
      ) => {
        const base = topPositions.length / 3;
        topPositions.push(
          minX, top, minZ,
          maxX, top, minZ,
          maxX, top, maxZ,
          minX, top, maxZ,
        );
        topIndices.push(base, base + 2, base + 1, base, base + 3, base + 2);
        topFlowLocal.push(0, 0, 1, 0, 1, 1, 0, 1);
        for (let vertex = 0; vertex < 4; vertex += 1) {
          topFlowDirections.push(direction[0], direction[1]);
          topFlowNeighbors.push(neighbors[0], neighbors[1], neighbors[2], neighbors[3]);
        }
      };
      const appendSide = (
        firstX: number,
        firstZ: number,
        secondX: number,
        secondZ: number,
        bottom: number,
        top: number,
      ) => {
        if (top - bottom <= 0.001) return;
        const base = sidePositions.length / 3;
        sidePositions.push(
          firstX, bottom, firstZ,
          secondX, bottom, secondZ,
          secondX, top, secondZ,
          firstX, top, firstZ,
        );
        sideIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      };
      const waterEdges = [
        { dx: 0, dy: -1, edge: (wx: number, wz: number) => [wx - 0.5, wz - 0.5, wx + 0.5, wz - 0.5] as const },
        { dx: 1, dy: 0, edge: (wx: number, wz: number) => [wx + 0.5, wz - 0.5, wx + 0.5, wz + 0.5] as const },
        { dx: 0, dy: 1, edge: (wx: number, wz: number) => [wx + 0.5, wz + 0.5, wx - 0.5, wz + 0.5] as const },
        { dx: -1, dy: 0, edge: (wx: number, wz: number) => [wx - 0.5, wz + 0.5, wx - 0.5, wz - 0.5] as const },
      ];
      for (let cellId = 0; cellId < COUNT; cellId += 1) {
        if (liquidDepthByCell[cellId] === 0) continue;
        const { x, y } = cellCoordinates(cellId, w.width);
        const wx = x - w.width / 2 + 0.5;
        const wz = y - w.height / 2 + 0.5;
        const top = liquidTopByCell[cellId];
        const base = liquidBaseByCell[cellId];
        appendTop(
          wx - 0.5,
          wx + 0.5,
          top,
          wz - 0.5,
          wz + 0.5,
          flowDirection(x, y),
          [
            Number(hasLiquid(x, y - 1)),
            Number(hasLiquid(x + 1, y)),
            Number(hasLiquid(x, y + 1)),
            Number(hasLiquid(x - 1, y)),
          ],
        );
        for (const { dx, dy, edge } of waterEdges) {
          const nx = x + dx;
          const ny = y + dy;
          const neighborId = nx >= 0 && nx < w.width && ny >= 0 && ny < w.height
            ? ny * w.width + nx
            : -1;
          const neighborTop = neighborId >= 0 && liquidDepthByCell[neighborId] > 0
            ? liquidTopByCell[neighborId]
            : Number.NEGATIVE_INFINITY;
          if (neighborTop >= top - 0.001) continue;
          const bottom = neighborId >= 0 && liquidDepthByCell[neighborId] > 0
            ? Math.max(base, neighborTop)
            : base;
          const [firstX, firstZ, secondX, secondZ] = edge(wx, wz);
          appendSide(firstX, firstZ, secondX, secondZ, bottom, top);
        }
      }
      const nextWaterTopGeometry = new THREE.BufferGeometry();
      nextWaterTopGeometry.setAttribute('position', new THREE.Float32BufferAttribute(topPositions, 3));
      nextWaterTopGeometry.setAttribute('aFlowDirection', new THREE.Float32BufferAttribute(topFlowDirections, 2));
      nextWaterTopGeometry.setAttribute('aFlowLocal', new THREE.Float32BufferAttribute(topFlowLocal, 2));
      nextWaterTopGeometry.setAttribute('aFlowNeighbors', new THREE.Float32BufferAttribute(topFlowNeighbors, 4));
      nextWaterTopGeometry.setIndex(topIndices);
      nextWaterTopGeometry.computeVertexNormals();
      nextWaterTopGeometry.computeBoundingSphere();
      const previousWaterSurfaceGeometry = waterSurface.geometry;
      const previousWaterFlowGeometry = waterFlow.geometry;
      waterSurface.geometry = nextWaterTopGeometry;
      waterFlow.geometry = nextWaterTopGeometry;
      previousWaterSurfaceGeometry.dispose();
      if (previousWaterFlowGeometry !== previousWaterSurfaceGeometry) previousWaterFlowGeometry.dispose();

      const nextWaterSideGeometry = new THREE.BufferGeometry();
      nextWaterSideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sidePositions, 3));
      nextWaterSideGeometry.setIndex(sideIndices);
      nextWaterSideGeometry.computeVertexNormals();
      nextWaterSideGeometry.computeBoundingSphere();
      waterSides.geometry.dispose();
      waterSides.geometry = nextWaterSideGeometry;

      // 普通陆地内部铺少量 1/4 格色片，材质边界则铺 1/8 格微体素。
      // 硬轮廓和地块归属不变，过渡只发生在格内。
      const detailTop = new Float32Array(COUNT);
      const detailR = new Uint8Array(COUNT);
      const detailG = new Uint8Array(COUNT);
      const detailB = new Uint8Array(COUNT);
      const transitionR = new Uint8Array(COUNT);
      const transitionG = new Uint8Array(COUNT);
      const transitionB = new Uint8Array(COUNT);
      const detailKind: Array<SurfaceTransitionKind | undefined> = new Array(COUNT);
      const detailVisible = new Uint8Array(COUNT);
      const cultivatedSoilColor = w.palette.find((material) => material.key === 'soil')?.color ?? [105, 78, 53];
      for (let cellId = 0; cellId < COUNT; cellId++) {
        if (liquidDepthByCell[cellId] > 0 || completeStructureBaseByCell.has(cellId)) continue;
        const surfaceKey = w.palette[w.surface[cellId]]?.key;
        if (surfaceKey === 'packed_soil') continue;
        const { x, y } = cellCoordinates(cellId, w.width);
        if (x === 0 || x === w.width - 1 || y === 0 || y === w.height - 1) continue;
        const fd = featureDepth(w, cellId, structureCells);
        const h = (w.elevation[cellId] + 1) * CELL_H;
        detailTop[cellId] = fd > 0 ? Math.max(CELL_H, h - fd * CELL_H) : h;
        let c = cellColor(w, cellId);
        const underlayMaterialId = featureUnderlayMaterialId(w, cellId, structureCells);
        if (underlayMaterialId !== undefined) {
          const under = w.palette[underlayMaterialId];
          if (under) {
            const shade = Math.max(-12, Math.min(12, (w.elevation[cellId] - fd - 5) * 2));
            const cc = (n: number) => Math.max(0, Math.min(255, Math.round(n + shade)));
            c = { r: cc(under.color[0]), g: cc(under.color[1]), b: cc(under.color[2]) };
          }
        }
        detailR[cellId] = c.r;
        detailG[cellId] = c.g;
        detailB[cellId] = c.b;
        const kind = surfaceTransitionKind(surfaceKey);
        detailKind[cellId] = kind;
        if (kind === 'cultivated') {
          // 作物是替换式地表；边界用中性土色表达田畦，不凭空宣称沃土或湿土。
          const shade = Math.max(-12, Math.min(12, (w.elevation[cellId] - fd - 5) * 2));
          const cc = (n: number) => Math.max(0, Math.min(255, Math.round(n + shade)));
          transitionR[cellId] = cc(cultivatedSoilColor[0]);
          transitionG[cellId] = cc(cultivatedSoilColor[1]);
          transitionB[cellId] = cc(cultivatedSoilColor[2]);
        } else {
          transitionR[cellId] = c.r;
          transitionG[cellId] = c.g;
          transitionB[cellId] = c.b;
        }
        detailVisible[cellId] = 1;
      }

      const terrainHash = (cellId: number, salt: number): number => {
        let value = (cellId ^ Math.imul(w.generator.seed + salt, 0x45d9f3b)) >>> 0;
        value ^= value >>> 16; value = Math.imul(value, 0x7feb352d) >>> 0;
        value = (value ^ (value >>> 15)) >>> 0;
        return value / 0x100000000;
      };
      let gdi = 0;
      const addGroundPatch = (cellId: number, dx: number, dz: number, size: number, rgb: readonly number[]) => {
        if (gdi >= GROUND_DETAIL_CAP) return;
        const { x, y } = cellCoordinates(cellId, w.width);
        m4.compose(
          v.set(x - w.width / 2 + 0.5 + dx, detailTop[cellId] + 0.004, y - w.height / 2 + 0.5 + dz),
          q.identity(), sc.set(size, 1, size),
        );
        groundDetail.setMatrixAt(gdi, m4);
        groundDetail.setColorAt(gdi, col.setRGB(
          rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace,
        ));
        gdi++;
      };
      const mixedTransitionColor = (from: number, to: number, amount: number): [number, number, number] => [
        THREE.MathUtils.lerp(transitionR[from], transitionR[to], amount),
        THREE.MathUtils.lerp(transitionG[from], transitionG[to], amount),
        THREE.MathUtils.lerp(transitionB[from], transitionB[to], amount),
      ];
      const wetBankTargets: Record<SurfaceTransitionKind, readonly [number, number, number]> = {
        grass: [61, 86, 51],
        soil: [82, 70, 57],
        'wet-soil': [74, 72, 63],
        'rich-soil': [71, 66, 54],
        'exhausted-soil': [95, 77, 59],
        cultivated: [83, 70, 54],
        sand: [124, 108, 76],
      };
      const wetBankColor = (
        cellId: number,
        kind: SurfaceTransitionKind,
        amount: number,
      ): [number, number, number] => {
        const target = wetBankTargets[kind];
        return [
          THREE.MathUtils.lerp(transitionR[cellId], target[0], amount),
          THREE.MathUtils.lerp(transitionG[cellId], target[1], amount),
          THREE.MathUtils.lerp(transitionB[cellId], target[2], amount),
        ];
      };

      // 内部纹理与材质边界分开处理：边界附近不再叠加随机色斑，避免棕绿交界变成噪点。
      const detailBoundary = new Uint8Array(COUNT);
      for (let cellId = 0; cellId < COUNT; cellId++) {
        if (!detailVisible[cellId]) continue;
        const { x, y } = cellCoordinates(cellId, w.width);
        for (const neighborId of [cellId - 1, cellId + 1, cellId - w.width, cellId + w.width]) {
          if (neighborId < 0 || neighborId >= COUNT || !detailVisible[neighborId]) {
            detailBoundary[cellId] = 1;
            break;
          }
          const { x: nx, y: ny } = cellCoordinates(neighborId, w.width);
          if (Math.abs(x - nx) + Math.abs(y - ny) !== 1
            || Math.abs(detailTop[cellId] - detailTop[neighborId]) > 0.02) {
            detailBoundary[cellId] = 1;
            break;
          }
          const delta = Math.abs(detailR[cellId] - detailR[neighborId])
            + Math.abs(detailG[cellId] - detailG[neighborId])
            + Math.abs(detailB[cellId] - detailB[neighborId]);
          if (detailKind[cellId] !== detailKind[neighborId] || delta >= 22) {
            detailBoundary[cellId] = 1;
            break;
          }
        }
      }

      const microOffset = (index: number) => -0.375 + index * 0.25;
      const coarseWidth = Math.ceil(w.width / 4);
      for (let cellId = 0; cellId < COUNT; cellId++) {
        if (!detailVisible[cellId]) continue;
        // 只在连续大色块内部生成纹理。4x4 区域共享密度倾向，形成稀疏小簇而不是均匀撒点。
        const { x, y } = cellCoordinates(cellId, w.width);
        const coarseId = Math.floor(x / 4) + Math.floor(y / 4) * coarseWidth;
        if (!detailBoundary[cellId]
          && terrainHash(coarseId, 17) > 0.28
          && terrainHash(cellId, 24) > 0.30) {
          const px = Math.floor(terrainHash(cellId, 18) * 4);
          const pz = Math.floor(terrainHash(cellId, 19) * 4);
          const horizontalStep = terrainHash(cellId, 20) > 0.5
            ? (px < 3 ? 1 : -1)
            : (px > 0 ? -1 : 1);
          const verticalStep = terrainHash(cellId, 21) > 0.5
            ? (pz < 3 ? 1 : -1)
            : (pz > 0 ? -1 : 1);
          const clusterSize = 2 + Math.floor(terrainHash(cellId, 22) * 3);
          const clusterCells = [
            [px, pz],
            [px + horizontalStep, pz],
            [px, pz + verticalStep],
            [px + horizontalStep, pz + verticalStep],
          ] as const;
          const tone = 0.97 + terrainHash(cellId, 23) * 0.06;
          const clusterColor = [
            Math.min(255, detailR[cellId] * tone),
            Math.min(255, detailG[cellId] * tone),
            Math.min(255, detailB[cellId] * tone),
          ];
          for (let patch = 0; patch < clusterSize; patch++) {
            const [patchX, patchZ] = clusterCells[patch];
            addGroundPatch(cellId, microOffset(patchX), microOffset(patchZ), 0.245, clusterColor);
          }
        }
      }

      // 四向邻居决定真实地表/水岸边界；对角邻居只调节拐角，不会隔角串成新地块。
      const transitionOffsets = {
        north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0],
        northEast: [1, -1], southEast: [1, 1], southWest: [-1, 1], northWest: [-1, -1],
      } as const;
      const cardinalOffsets: Record<SurfaceTransitionDirection, readonly [number, number]> = {
        north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0],
      };
      const microOffset8 = (index: number) => -0.4375 + index * 0.125;
      for (let cellId = 0; cellId < COUNT; cellId++) {
        const kind = detailKind[cellId];
        if (!detailVisible[cellId] || kind === undefined) continue;
        const { x, y } = cellCoordinates(cellId, w.width);
        const neighbors: SurfaceTransitionNeighbors = {};
        const shorelineNeighbors: ShorelineNeighbors = {};
        for (const [direction, [dx, dy]] of Object.entries(transitionOffsets) as Array<
          [keyof SurfaceTransitionNeighbors, readonly [number, number]]
        >) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
          const neighborId = ny * w.width + nx;
          const sameLevelWater = liquidDepthByCell[neighborId] > 0
            && Math.abs(detailTop[cellId] - liquidTopByCell[neighborId]) <= 0.02;
          shorelineNeighbors[direction] = sameLevelWater;
          const neighborKind = detailKind[neighborId];
          if (!detailVisible[neighborId] || neighborKind === undefined) continue;
          if (Math.abs(detailTop[cellId] - detailTop[neighborId]) > 0.02) continue;
          neighbors[direction] = neighborKind;
        }
        const transitionSeed = Math.floor(terrainHash(cellId, 31) * 0xffffffff) >>> 0;
        const shore = shorelinePatches(shorelineNeighbors, transitionSeed ^ 0x51f15e5d);
        const shoreMicroIds = new Set(shore.map((patch) => patch.microZ * 8 + patch.microX));
        for (const patch of surfaceTransitionPatches(kind, neighbors, transitionSeed)) {
          if (shoreMicroIds.has(patch.microZ * 8 + patch.microX)) continue;
          const [dx, dy] = cardinalOffsets[patch.source];
          const neighborId = (y + dy) * w.width + x + dx;
          const amount = patch.depth === 0 ? 0.48 : 0.26;
          addGroundPatch(
            cellId,
            microOffset8(patch.microX),
            microOffset8(patch.microZ),
            0.126,
            mixedTransitionColor(cellId, neighborId, amount),
          );
        }
        for (const patch of shore) {
          const amount = patch.depth === 0 ? 0.72 : 0.42;
          addGroundPatch(
            cellId,
            microOffset8(patch.microX),
            microOffset8(patch.microZ),
            0.126,
            wetBankColor(cellId, kind, amount),
          );
        }
      }

      // 反向复用同一套 1/8 格岸线掩码：陆地格内保留湿润带，水格边缘再覆盖一层
      // 极薄湿土/湿沙微体素，使岸线轮廓跨出整格直角，但不修改水格拓扑。
      let shorei = 0;
      for (let cellId = 0; cellId < COUNT && shorei < SHORE_LIP_CAP; cellId += 1) {
        if (liquidDepthByCell[cellId] === 0) continue;
        const { x, y } = cellCoordinates(cellId, w.width);
        const bankNeighbors: ShorelineNeighbors = {};
        for (const [direction, [dx, dy]] of Object.entries(transitionOffsets) as Array<
          [keyof ShorelineNeighbors, readonly [number, number]]
        >) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
          const neighborId = ny * w.width + nx;
          bankNeighbors[direction] = Boolean(
            detailVisible[neighborId]
            && detailKind[neighborId] !== undefined
            && Math.abs(detailTop[neighborId] - liquidTopByCell[cellId]) <= 0.02,
          );
        }
        const transitionSeed = Math.floor(terrainHash(cellId, 41) * 0xffffffff) >>> 0;
        for (const patch of shorelinePatches(bankNeighbors, transitionSeed ^ 0x51f15e5d)) {
          if (shorei >= SHORE_LIP_CAP) break;
          const [dx, dy] = cardinalOffsets[patch.source];
          const bankId = (y + dy) * w.width + x + dx;
          const bankKind = detailKind[bankId];
          if (bankKind === undefined) continue;
          const amount = patch.depth === 0 ? 0.78 : 0.52;
          m4.compose(
            v.set(
              x - w.width / 2 + 0.5 + microOffset8(patch.microX),
              liquidTopByCell[cellId] + 0.007,
              y - w.height / 2 + 0.5 + microOffset8(patch.microZ),
            ),
            q.identity(),
            sc.set(0.126, 0.014, 0.126),
          );
          shoreLip.setMatrixAt(shorei, m4);
          const bankColor = wetBankColor(bankId, bankKind, amount);
          shoreLip.setColorAt(shorei, col.setRGB(
            bankColor[0] / 255, bankColor[1] / 255, bankColor[2] / 255, THREE.SRGBColorSpace,
          ));
          shorei += 1;
        }
      }
      groundDetail.count = gdi;
      shoreLip.count = shorei;
      strata.count = sti;
      land.instanceMatrix.needsUpdate = true;
      if (land.instanceColor) land.instanceColor.needsUpdate = true;
      shoreLip.instanceMatrix.needsUpdate = true;
      if (shoreLip.instanceColor) shoreLip.instanceColor.needsUpdate = true;
      strata.instanceMatrix.needsUpdate = true;
      if (strata.instanceColor) strata.instanceColor.needsUpdate = true;
      terrainApron.instanceMatrix.needsUpdate = true;
      if (terrainApron.instanceColor) terrainApron.instanceColor.needsUpdate = true;
      apronFadeAttribute.needsUpdate = true;
      apronTrunks.instanceMatrix.needsUpdate = true;
      if (apronTrunks.instanceColor) apronTrunks.instanceColor.needsUpdate = true;
      apronCanopies.instanceMatrix.needsUpdate = true;
      if (apronCanopies.instanceColor) apronCanopies.instanceColor.needsUpdate = true;
      groundDetail.instanceMatrix.needsUpdate = true;
      if (groundDetail.instanceColor) groundDetail.instanceColor.needsUpdate = true;

    };

    // ---- 装饰层：微缩体素素材（树/作物/道路贴花/物资堆/建筑印章/动物/纪元状态）----
    // 素材来自 voxelKits.ts（与 knowledge-base 素材页同源），按材质桶 InstancedMesh 合批
    // 颜色仍走实例色；材质桶只承载真实表面响应。Record<string> 让素材库可渐进新增语义桶。
    const DECOR_MATS: Record<string, THREE.MeshStandardMaterial> = {
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
    const decorGroup = new THREE.Group();
    interface DecorBatch {
      mesh: THREE.InstancedMesh;
      capacity: number;
      keys: Array<string | null>;
      instances: Array<DecorInstance | null>;
      signatures: Array<string | null>;
      slotByKey: Map<string, number>;
    }
    const decorBatches = new Map<DecorBucket, DecorBatch>();
    let animatedDecorBatches: Array<{
      mesh: THREE.InstancedMesh;
      instances: Array<{ index: number; instance: DecorInstance }>;
    }> = [];
    scene.add(decorGroup);

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
    ].join('|');
    const decorCapacityFor = (required: number): number => {
      let capacity = 16;
      while (capacity < required) capacity *= 2;
      return capacity;
    };
    const createDecorBatch = (bucket: DecorBucket, capacity: number): DecorBatch => {
      const material = DECOR_MATS[bucket] ?? DECOR_MATS.plaster;
      const mesh = new THREE.InstancedMesh(boxGeo, material, capacity);
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
        capacity,
        keys: new Array<string | null>(capacity).fill(null),
        instances: new Array<DecorInstance | null>(capacity).fill(null),
        signatures: new Array<string | null>(capacity).fill(null),
        slotByKey: new Map<string, number>(),
      };
    };
    const ensureDecorBatch = (bucket: DecorBucket, required: number): DecorBatch => {
      const current = decorBatches.get(bucket);
      if (current && current.capacity >= required) return current;
      const replacement = createDecorBatch(bucket, decorCapacityFor(required));
      if (current) {
        decorGroup.remove(current.mesh);
        current.mesh.dispose();
      }
      decorBatches.set(bucket, replacement);
      return replacement;
    };
    const writeDecorInstance = (mesh: THREE.InstancedMesh, index: number, instance: DecorInstance, bucket: DecorBucket) => {
      const rotation = instance.ry === undefined
        ? q.identity()
        : q.setFromAxisAngle(decorAxisY, instance.ry);
      m4.compose(v.set(instance.x, instance.y, instance.z), rotation, sc.set(instance.sx, instance.sy, instance.sz));
      mesh.setMatrixAt(index, m4);
      col.setHex(instance.c);
      if (bucket === 'leaf' || bucket === 'wood') {
        // 连续空间波形让同一树冠形成成片明暗，而不是每个微体素独立闪烁。
        const cluster = (
          Math.sin(instance.x * 2.13 + instance.z * 1.37 + instance.y * 0.71)
          + Math.sin(instance.x * 0.83 - instance.z * 1.91 + instance.y * 1.17)
        ) * 0.25;
        col.multiplyScalar(1 + cluster * (bucket === 'leaf' ? 0.12 : 0.055));
      }
      mesh.setColorAt(index, col);
    };

    decorApiRef.current = (s, era) => {
      const instances = collectDecor(s, era);
      animatedDecorBatches = [];
      const byBucket = new Map<DecorBucket, DecorInstance[]>();
      for (const inst of instances) {
        const list = byBucket.get(inst.b);
        if (list) list.push(inst); else byBucket.set(inst.b, [inst]);
      }
      const activeBuckets = new Set<DecorBucket>([...decorBatches.keys(), ...byBucket.keys()]);
      for (const bucket of activeBuckets) {
        const list = byBucket.get(bucket) ?? [];
        const batch = list.length > 0
          ? ensureDecorBatch(bucket, list.length)
          : decorBatches.get(bucket);
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
          m4.makeScale(0, 0, 0);
          batch.mesh.setMatrixAt(slot, m4);
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

    // 动物和火焰仍与其他装饰共享 InstancedMesh 合批；带 entityId / animation 的构件逐帧更新矩阵。
    // 这样无需为每个动态素材创建独立 Mesh，也能获得动物步态与火舌、火星循环。
    const animalAxisY = new THREE.Vector3(0, 1, 0);
    const facilityAxisX = new THREE.Vector3(1, 0, 0);
    const facilityAxisZ = new THREE.Vector3(0, 0, 1);
    const animalRollX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const animalPhaseCache = new Map<string, number>();
    const animalIdleYawCache = new Map<string, number>();
    const animalSeed = (id: string): number => {
      let hash = 2166136261;
      for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
      return (hash >>> 0) / 0x100000000;
    };
    const syncAnimatedDecor = (now: number) => {
      if (!animatedDecorBatches.length) return;
      const p = propsRef.current;
      const w = p.society.world;
      const animals = new Map(p.society.animals.map((animal) => [animal.id, animal]));
      const motion = Math.min(1, (now - animStart.current) / MONTH_PLAYBACK_MS);

      for (const { mesh, instances } of animatedDecorBatches) {
        let touched = false;
        instances.forEach(({ index, instance: inst }) => {
          if (inst.animation === 'wind') {
            const intensity = Math.max(1, p.society.weather?.intensity ?? 1);
            const seed = inst.x * 1.83 + inst.z * 2.37 + inst.y * 0.71;
            const sway = Math.sin(now * 0.0028 * (1 + intensity * 0.05) + seed) * Math.min(0.055, 0.012 + intensity * 0.004);
            const heightFactor = THREE.MathUtils.clamp(inst.y * 0.035, 0.2, 1);
            q.setFromEuler(new THREE.Euler(sway * heightFactor, 0, sway * 0.7 * heightFactor));
            m4.compose(
              v.set(inst.x + sway * heightFactor * 0.5, inst.y, inst.z + sway * heightFactor * 0.25),
              q,
              sc.set(inst.sx, inst.sy, inst.sz),
            );
            mesh.setMatrixAt(index, m4);
            touched = true;
            return;
          }
          if (inst.animation === 'fire') {
            const seed = inst.x * 7.31 + inst.y * 11.17 + inst.z * 5.83;
            const waveA = Math.sin(now * 0.009 + seed);
            const waveB = Math.sin(now * 0.015 - seed * 1.7);
            const isSpark = inst.part === 'fire-spark';
            const isEmber = inst.part === 'fire-ember';
            if (isSpark) {
              const rise = ((now * 0.00042 + seed * 0.13) % 1 + 1) % 1;
              const sparkScale = Math.max(0.08, 1 - rise * 0.86);
              m4.compose(
                v.set(inst.x + waveA * 0.025, inst.y + rise * 0.24, inst.z + waveB * 0.018),
                q.identity(),
                sc.set(inst.sx * sparkScale, inst.sy * sparkScale, inst.sz * sparkScale),
              );
            } else if (isEmber) {
              const pulse = 0.9 + (waveA + waveB) * 0.06;
              m4.compose(v.set(inst.x, inst.y, inst.z), q.identity(), sc.set(inst.sx * pulse, inst.sy, inst.sz * pulse));
            } else {
              const tipFactor = inst.part === 'fire-tip' ? 1.65 : inst.part === 'fire-mid' ? 1.15 : 0.72;
              const stretch = 1 + waveA * 0.12 + waveB * 0.07;
              const width = 1 - waveA * 0.055;
              m4.compose(
                v.set(inst.x + waveB * 0.018 * tipFactor, inst.y + (stretch - 1) * inst.sy * 0.34, inst.z + waveA * 0.012 * tipFactor),
                q.identity(),
                sc.set(inst.sx * width, inst.sy * stretch, inst.sz * (2 - width)),
              );
            }
            mesh.setMatrixAt(index, m4);
            touched = true;
            return;
          }
          if (inst.animation === 'facility-smoke') {
            const seed = inst.x * 5.31 + inst.z * 7.17 + inst.y * 3.83;
            const wave = Math.sin(now * 0.0026 + seed);
            const drift = Math.sin(now * 0.0017 - seed * 1.3);
            const pulse = 0.9 + wave * 0.08;
            m4.compose(
              v.set(inst.x + drift * 0.035, inst.y + wave * 0.025, inst.z + wave * 0.02),
              q.identity(),
              sc.set(inst.sx * pulse, inst.sy * (1.04 + wave * 0.08), inst.sz * pulse),
            );
            mesh.setMatrixAt(index, m4);
            touched = true;
            return;
          }
          if (inst.animation === 'facility-lift') {
            const lift = (Math.sin(now * 0.0034 + inst.x * 2.1 + inst.z * 1.7) + 1) * 0.055;
            m4.compose(
              v.set(inst.x, inst.y + lift, inst.z),
              q.identity(),
              sc.set(inst.sx, inst.sy, inst.sz),
            );
            mesh.setMatrixAt(index, m4);
            touched = true;
            return;
          }
          if (inst.animation === 'wheel-spin') {
            const angle = now * 0.0021;
            const originX = inst.entityX ?? inst.x;
            const originY = (inst.entityY ?? inst.y) + 0.5;
            const originZ = inst.entityZ ?? inst.z;
            let localX = inst.x - originX;
            let localY = inst.y - originY;
            let localZ = inst.z - originZ;
            const alongZ = (inst.entityRotation ?? 0) % 2 === 1;
            if (alongZ) {
              const rotatedX = localX * Math.cos(angle) - localY * Math.sin(angle);
              localY = localX * Math.sin(angle) + localY * Math.cos(angle);
              localX = rotatedX;
              q.setFromAxisAngle(facilityAxisZ, angle);
            } else {
              const rotatedY = localY * Math.cos(angle) - localZ * Math.sin(angle);
              localZ = localY * Math.sin(angle) + localZ * Math.cos(angle);
              localY = rotatedY;
              q.setFromAxisAngle(facilityAxisX, angle);
            }
            m4.compose(
              v.set(originX + localX, originY + localY, originZ + localZ),
              q,
              sc.set(inst.sx, inst.sy, inst.sz),
            );
            mesh.setMatrixAt(index, m4);
            touched = true;
            return;
          }
          if (inst.animation === 'mill-turn') {
            const angle = now * 0.0018;
            const originX = inst.entityX ?? inst.x;
            const originZ = inst.entityZ ?? inst.z;
            const localX = inst.x - originX;
            const localZ = inst.z - originZ;
            const rotatedX = localX * Math.cos(angle) + localZ * Math.sin(angle);
            const rotatedZ = -localX * Math.sin(angle) + localZ * Math.cos(angle);
            m4.compose(
              v.set(originX + rotatedX, inst.y, originZ + rotatedZ),
              q.setFromAxisAngle(animalAxisY, angle),
              sc.set(inst.sx, inst.sy, inst.sz),
            );
            mesh.setMatrixAt(index, m4);
            touched = true;
            return;
          }
          if (!inst.entityId) return;
          const animal = animals.get(inst.entityId);
          if (!animal) return;

          const currentX = animal.cellId % w.width;
          const currentZ = Math.floor(animal.cellId / w.width);
          const previousX = animal.previousCellId % w.width;
          const previousZ = Math.floor(animal.previousCellId / w.width);
          const dx = currentX - previousX;
          const dz = currentZ - previousZ;
          const moved = dx !== 0 || dz !== 0 || animal.z !== animal.previousZ;
          const originX = THREE.MathUtils.lerp(previousX, currentX, motion) - w.width / 2 + 0.5;
          const originY = THREE.MathUtils.lerp(animal.previousZ, animal.z, motion) * CELL_H;
          const originZ = THREE.MathUtils.lerp(previousZ, currentZ, motion) - w.height / 2 + 0.5;

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

          let localX = inst.x - (inst.entityX ?? inst.x);
          const localY = inst.y - (inst.entityY ?? inst.y);
          let localZ = inst.z - (inst.entityZ ?? inst.z);
          let partOffsetY = 0;
          if (walking && inst.part?.startsWith('leg-')) {
            const legIndex = Number(inst.part.slice(4)) || 0;
            const legPhase = phase + (legIndex % 2 ? Math.PI : 0);
            localX += Math.sin(legPhase) * 0.014;
            partOffsetY += Math.max(0, Math.sin(legPhase)) * 0.009;
          } else if (inst.part === 'head') {
            if (activity === 'graze' || activity === 'feed') {
              partOffsetY -= animal.speciesId === 'deer' ? 0.11 : 0.045;
              localX += animal.speciesId === 'deer' ? 0.025 : 0.012;
            } else partOffsetY += Math.sin(now * 0.0028 + seed) * 0.002;
          } else if (inst.part === 'tail') {
            localZ += Math.sin(now * (activity === 'attack' || activity === 'chase' || activity === 'flee' ? 0.012 : 0.006) + seed) * 0.006;
          }
          if (activity === 'attack') localX += Math.max(0, Math.sin(phase)) * 0.025;
          if (activity === 'injured' && inst.part === 'leg-0') partOffsetY += 0.012;
          const bob = walking
            ? Math.abs(Math.sin(phase)) * 0.007
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
          q.setFromAxisAngle(animalAxisY, yaw);
          if (dead) q.multiply(animalRollX);
          m4.compose(
            v.set(originX + rotatedX, originY + localY + bob + partOffsetY, originZ + rotatedZ),
            q,
            sc.set(inst.sx, inst.sy, inst.sz),
          );
          mesh.setMatrixAt(index, m4);
          touched = true;
        });
        if (touched) mesh.instanceMatrix.needsUpdate = true;
      }
    };

    // ---- 人物：按需创建 / 更新 / 回收 ----
    const figures = new Map<string, FigureParts>();
    const removeFigure = (figure: FigureParts) => {
      scene.remove(figure.group);
      for (const excluded of [figure.sprite, figure.speechBubble]) {
        const excludedIndex = aoExcluded.indexOf(excluded);
        if (excludedIndex >= 0) aoExcluded.splice(excludedIndex, 1);
      }
      disposeFigure(figure);
    };
    const syncAgents = (now: number) => {
      const p = propsRef.current;
      const w = p.society.world;
      const agents = p.society.agents;
      const speechBySpeaker = p.speechBySpeaker;
      const motion = Math.min(1, (now - animStart.current) / MONTH_PLAYBACK_MS);
      const activeIntentByOwner = new Map(p.society.intents
        .filter((intent) => intent.status === 'active')
        .map((intent) => [intent.ownerId, intent]));
      const agentsByCell = new Map<number, SocietyAgent[]>();
      for (const agent of agents) {
        if (agent.bodyDisposition === 'interred') continue;
        const occupants = agentsByCell.get(agent.cellId);
        if (occupants) occupants.push(agent);
        else agentsByCell.set(agent.cellId, [agent]);
      }
      const cellOffsetByAgent = new Map<string, { x: number; z: number }>();
      for (const occupants of agentsByCell.values()) {
        occupants.sort((left, right) => left.id.localeCompare(right.id));
        occupants.forEach((agent, index) => {
          cellOffsetByAgent.set(agent.id, sharedCellOffset(index, occupants.length));
        });
      }
      type IncomingInteraction = {
        actorId: string;
        kind: 'handoff' | 'care' | 'listen' | 'companion';
        sourceOrderInMonth: number;
      };
      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      const incomingInteractionByAgent = new Map<string, IncomingInteraction>();
      for (const actor of agents) {
        const view = actor.visualAction;
        if (!view?.sourceEventId || !view.targetPersonId || view.targetPersonId === actor.id) continue;
        const target = agentsById.get(view.targetPersonId);
        if (!target || target.state === 'dead') continue;
        const distance = Math.abs(actor.cellId % w.width - target.cellId % w.width)
          + Math.abs(Math.floor(actor.cellId / w.width) - Math.floor(target.cellId / w.width));
        if (distance > 1) continue;
        const kind: IncomingInteraction['kind'] | undefined = view.actionKind === 'transfer'
          ? 'handoff'
          : view.actionKind === 'communicate'
            ? 'listen'
            : view.operation === 'combine' || view.operation === 'rehydrate' || view.operation === 'dehydrate'
              ? 'care'
              : view.operation === 'reproduce' ? 'companion' : undefined;
        if (!kind) continue;
        const order = view.sourceOrderInMonth ?? 0;
        if ((target.visualAction?.sourceOrderInMonth ?? -1) > order) continue;
        const current = incomingInteractionByAgent.get(target.id);
        if (!current || current.sourceOrderInMonth <= order) {
          incomingInteractionByAgent.set(target.id, { actorId: actor.id, kind, sourceOrderInMonth: order });
        }
      }
      for (const agent of agents) {
        let f = figures.get(agent.id);
        const visualKey = figureVisualKey(agent);
        if (f && f.visualKey !== visualKey) {
          removeFigure(f);
          figures.delete(agent.id);
          f = undefined;
        }
        if (!f) {
          f = buildFigure(agent);
          scene.add(f.group);
          figures.set(agent.id, f);
          aoExcluded.push(f.sprite, f.speechBubble); // 名牌和台词气泡都不参与 AO
        }
        f.group.visible = agent.bodyDisposition !== 'interred';
        if (!f.group.visible) continue;
        const path = agent.tickPath.length === RULE_TICKS + 1 ? agent.tickPath : agent.lastPath.length ? agent.lastPath : [agent.cellId];
        const point = interpolatePath(path, w.width, motion);
        const prev = interpolatePath(path, w.width, Math.max(0, motion - 0.08));
        const dx = point.x - prev.x;
        const dz = point.y - prev.y;
        const moving = Math.hypot(dx, dz) > 1e-4;
        const dead = agent.state === 'dead';
        const sleeping = agent.state === 'dehydrated' || agent.state === 'hibernating';
        const activeIntent = activeIntentByOwner.get(agent.id);
        const actionView = figureActionView(agent, activeIntent);
        const incomingInteraction = incomingInteractionByAgent.get(agent.id);
        const action = figureActionOf(agent, activeIntent, moving);
        const phase = hueOf(agent.id) * Math.PI * 2;
        const cycle = now * 0.012 + phase;
        const bob = action === 'walk' && !dead && !sleeping ? Math.abs(Math.sin(cycle)) * 0.013 : 0;
        const offset = cellOffsetByAgent.get(agent.id) ?? { x: 0, z: 0 };
        f.group.position.set(
          point.x - w.width / 2 + 0.5 + offset.x,
          agent.z * CELL_H + (dead ? 0.025 : bob),
          point.y - w.height / 2 + 0.5 + offset.z,
        );
        if (moving && !dead) f.group.rotation.y = Math.atan2(dx, dz);
        else if (!dead && (agent.visualAction?.targetPersonId || incomingInteraction?.actorId || actionView?.targetPersonId)) {
          const facingPersonId = agent.visualAction?.targetPersonId ?? incomingInteraction?.actorId ?? actionView?.targetPersonId;
          const target = agentsById.get(facingPersonId!);
          if (target) {
            const targetOffset = cellOffsetByAgent.get(target.id) ?? { x: 0, z: 0 };
            const tx = target.cellId % w.width - w.width / 2 + 0.5 + targetOffset.x;
            const tz = Math.floor(target.cellId / w.width) - w.height / 2 + 0.5 + targetOffset.z;
            f.group.rotation.y = Math.atan2(tx - f.group.position.x, tz - f.group.position.z);
          }
        }
        f.group.rotation.x = dead ? -Math.PI * 0.45 : 0; // 死亡倒地
        f.upright.visible = !sleeping;
        f.dehydrated.visible = sleeping;
        // Canvas 中 30px 字体只占 64px 贴图高度的 30/64；先反算出约 10.5px
        // 正文字高对应的 Sprite 高度，再限制近、远景的世界尺寸。
        const labelDepth = Math.max(1, camera.position.distanceTo(f.group.position));
        const worldUnitsPerPixel = 2 * labelDepth * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
          / Math.max(1, mount.clientHeight);
        const labelHeight = THREE.MathUtils.clamp(
          NAME_TAG_TARGET_GLYPH_PX * (64 / 30) * worldUnitsPerPixel,
          NAME_TAG_MIN_WORLD_H,
          NAME_TAG_MAX_WORLD_H,
        );
        f.sprite.scale.set(labelHeight * 4, labelHeight, 1);
        // 随缩放同步抬高中心，保证真正有字的区域始终落在头顶，而非覆盖人物。
        f.sprite.position.y = (sleeping ? 0.52 : 1.04) + labelHeight * 0.25;

        const speechLine = speechBySpeaker.get(agent.id);
        const speechKey = speechLine ? `${speechLine.id}|${speechLine.text}` : '';
        if (speechKey !== f.speechKey) {
          if (speechLine) {
            setSpeechBubbleTexture(f, speechLine.text, 'center');
            f.speechBubble.center.y = 0;
          } else {
            f.speechTexture?.dispose();
            f.speechTexture = null;
            f.speechBubble.material.map = null;
            f.speechBubble.material.needsUpdate = true;
            f.speechBubble.center.set(0.5, 0);
            f.speechPlacement = 'center';
          }
          f.speechBubble.visible = Boolean(speechLine);
          f.speechKey = speechKey;
        }
        if (speechLine) {
          const bubbleWorldHeight = THREE.MathUtils.clamp(
            SPEECH_TARGET_FONT_PX * (f.speechPixelHeight / SPEECH_FONT_PX) * worldUnitsPerPixel,
            0.35,
            11,
          );
          const bubbleLocalHeight = bubbleWorldHeight / FIGURE_SCALE;
          f.speechBubble.scale.set(bubbleLocalHeight * f.speechAspect, bubbleLocalHeight, 1);
          f.speechBubble.position.y = (sleeping ? 0.52 : 1.04) + labelHeight * 0.84;
        }

        // 每帧先回到站立基准，再叠加权威状态对应的动作姿态。
        f.upperBody.position.y = 0.3;
        f.upperBody.rotation.set(0, 0, 0);
        f.legL.rotation.set(0, 0, 0);
        f.legR.rotation.set(0, 0, 0);
        f.armL.rotation.set(0, 0, 0);
        f.armR.rotation.set(0, 0, 0);
        f.spear.visible = false;
        f.handTool.visible = false;
        f.heldLoad.visible = false;
        f.heldLoad.position.z = 0.33;
        f.tablet.visible = false;
        f.heldFood.visible = false;
        const toolKey = actionView?.toolMaterialId !== undefined ? w.palette[actionView.toolMaterialId]?.key : undefined;
        const materialKey = actionView?.materialId !== undefined ? w.palette[actionView.materialId]?.key : undefined;
        const toolColor = actionView?.toolMaterialId !== undefined ? w.palette[actionView.toolMaterialId]?.color : undefined;
        const carriedColor = actionView?.materialId !== undefined ? w.palette[actionView.materialId]?.color : undefined;
        if (toolColor) (f.toolHead.material as THREE.MeshLambertMaterial).color.setRGB(
          toolColor[0] / 255, toolColor[1] / 255, toolColor[2] / 255, THREE.SRGBColorSpace,
        );
        if (carriedColor) {
          for (const mesh of [f.heldLoadFill, f.heldFood]) (mesh.material as THREE.MeshLambertMaterial).color.setRGB(
            carriedColor[0] / 255, carriedColor[1] / 255, carriedColor[2] / 255, THREE.SRGBColorSpace,
          );
        }
        const clothing = agent.inventory.find((stack) => stack.materialId === Material.LeatherClothing)
          ?? agent.inventory.find((stack) => stack.materialId === Material.Clothing);
        f.outerwear.visible = Boolean(clothing);
        if (clothing) {
          const color = w.palette[clothing.materialId]?.color;
          if (color) (f.outerwear.material as THREE.MeshLambertMaterial).color.setRGB(
            color[0] / 255, color[1] / 255, color[2] / 255, THREE.SRGBColorSpace,
          );
        }
        f.bandage.visible = agent.conditions.some((condition) => condition.kind === 'wound');
        f.belly.visible = agent.conditions.some((condition) => condition.kind === 'pregnancy');
        if (!dead && !sleeping) {
          if (action === 'walk') {
            const swing = Math.sin(cycle) * 0.55;
            f.legL.rotation.x = swing;
            f.legR.rotation.x = -swing;
            f.armL.rotation.x = -swing * 0.7;
            f.armR.rotation.x = swing * 0.7;
          } else if (action === 'gather') {
            const reach = 0.92 + Math.sin(cycle * 0.8) * 0.12;
            f.upperBody.position.y = 0.25;
            f.upperBody.rotation.x = 0.32;
            f.legL.rotation.x = 0.22;
            f.legR.rotation.x = -0.18;
            f.armL.rotation.x = -reach;
            f.armR.rotation.x = -reach;
          } else if (action === 'attack') {
            const thrust = Math.sin(cycle * 1.2) * 0.16;
            f.upperBody.rotation.y = thrust * 0.35;
            f.legL.rotation.x = 0.22;
            f.legR.rotation.x = -0.22;
            f.armL.rotation.x = -1.02 - thrust;
            f.armR.rotation.x = -1.18 - thrust;
            f.spear.visible = toolKey === 'spear';
            f.handTool.visible = toolKey === 'stone_tool' || toolKey === 'bone_tool';
          } else if (action === 'carry') {
            f.armL.rotation.x = -0.98;
            f.armR.rotation.x = -0.98;
            f.heldLoad.position.y = 0.44 + Math.sin(cycle) * 0.015;
            if (agent.visualAction?.sourceEventId && agent.visualAction.targetPersonId) {
              const target = agentsById.get(agent.visualAction.targetPersonId);
              if (target) {
                const targetOffset = cellOffsetByAgent.get(target.id) ?? { x: 0, z: 0 };
                const tx = target.cellId % w.width - w.width / 2 + 0.5 + targetOffset.x;
                const tz = Math.floor(target.cellId / w.width) - w.height / 2 + 0.5 + targetOffset.z;
                const distance = Math.hypot(tx - f.group.position.x, tz - f.group.position.z);
                f.heldLoad.position.z = THREE.MathUtils.clamp(distance / (FIGURE_SCALE * 2), 0.36, 0.9);
              }
            }
            f.heldLoad.visible = true;
          } else if (action === 'ingest') {
            const sip = 0.08 + Math.abs(Math.sin(cycle * 0.65)) * 0.14;
            f.armR.rotation.x = -1.65 + sip;
            f.armR.rotation.z = -0.18;
            f.armL.rotation.x = -1.18;
            f.heldFood.visible = true;
          } else if (action === 'work') {
            const strike = 0.45 + (Math.sin(cycle * 0.8) + 1) * 0.65;
            f.upperBody.rotation.x = 0.16;
            f.legL.rotation.x = 0.2;
            f.legR.rotation.x = -0.16;
            f.armL.rotation.x = -0.7;
            f.armR.rotation.x = -strike;
            f.handTool.visible = toolKey === 'stone_tool' || toolKey === 'bone_tool';
          } else if (action === 'craft') {
            const work = 0.92 + Math.sin(cycle * 0.7) * 0.22;
            f.upperBody.position.y = 0.24;
            f.upperBody.rotation.x = 0.38;
            f.legL.rotation.x = 0.34;
            f.legR.rotation.x = -0.28;
            f.armL.rotation.x = -work;
            f.armR.rotation.x = -work * 1.08;
            f.handTool.visible = toolKey === 'stone_tool' || toolKey === 'bone_tool';
          } else if (action === 'tend-fire') {
            f.upperBody.position.y = 0.25;
            f.upperBody.rotation.x = 0.32;
            f.armL.rotation.x = -1.02 + Math.sin(cycle * 0.55) * 0.08;
            f.armR.rotation.x = -1.12 - Math.sin(cycle * 0.55) * 0.08;
            f.legL.rotation.x = 0.28;
            f.legR.rotation.x = -0.2;
          } else if (action === 'attend') {
            const hasTablet = toolKey === 'wood_tablet' || materialKey === 'wood_tablet'
              || actionView?.channel === 'record';
            f.tablet.visible = hasTablet;
            f.armL.rotation.x = hasTablet ? -1.05 : -0.22;
            f.armR.rotation.x = hasTablet ? -0.72 : -1.48;
            f.armR.rotation.z = hasTablet ? 0.08 : -0.42;
            f.upperBody.rotation.x = hasTablet ? 0.12 : -0.03;
          } else if (action === 'communicate') {
            const gesture = Math.sin(cycle * 0.52);
            f.armL.rotation.x = -0.45 - gesture * 0.32;
            f.armL.rotation.z = 0.42;
            f.armR.rotation.x = -0.72 + gesture * 0.28;
            f.armR.rotation.z = -0.36;
          } else if (action === 'care') {
            f.upperBody.rotation.x = 0.28;
            f.armL.rotation.x = -1.08 + Math.sin(cycle * 0.45) * 0.08;
            f.armR.rotation.x = -1.08 - Math.sin(cycle * 0.45) * 0.08;
            f.heldFood.visible = materialKey === 'herbal_medicine' || materialKey === 'water' || materialKey === 'ice';
          } else if (action === 'reproduce') {
            f.armL.rotation.x = -0.52;
            f.armL.rotation.z = 0.3;
            f.armR.rotation.x = -0.52;
            f.armR.rotation.z = -0.3;
            f.upperBody.position.y = 0.3 + Math.sin(cycle * 0.32) * 0.008;
          } else if (agent.conditions.some((condition) => condition.kind === 'cold')) {
            f.upperBody.rotation.x = 0.18;
            f.armL.rotation.x = -0.88;
            f.armL.rotation.z = -0.42;
            f.armR.rotation.x = -0.88;
            f.armR.rotation.z = 0.42;
          } else if (agent.conditions.some((condition) => condition.kind === 'heat' || condition.kind === 'illness')) {
            f.upperBody.position.y = 0.26;
            f.upperBody.rotation.x = 0.22;
            f.armL.rotation.x = -0.25;
            f.armR.rotation.x = -0.18;
          }
          // 接收方姿态只来自同月已提交、且没有被自己更晚动作覆盖的互动事实。
          if (incomingInteraction?.kind === 'handoff') {
            f.upperBody.rotation.x = 0.08;
            f.armL.rotation.x = -1.08;
            f.armR.rotation.x = -1.08;
            f.armL.rotation.z = 0.16;
            f.armR.rotation.z = -0.16;
          } else if (incomingInteraction?.kind === 'care') {
            f.upperBody.position.y = 0.27;
            f.upperBody.rotation.x = 0.18;
            f.armL.rotation.x = -0.38;
            f.armR.rotation.x = -0.34;
          } else if (incomingInteraction?.kind === 'listen') {
            f.upperBody.rotation.y = Math.sin(cycle * 0.28) * 0.035;
            f.armL.rotation.x = -0.18;
            f.armR.rotation.x = -0.28;
          } else if (incomingInteraction?.kind === 'companion') {
            f.armL.rotation.x = -0.48;
            f.armL.rotation.z = 0.24;
            f.armR.rotation.x = -0.48;
            f.armR.rotation.z = -0.24;
          }
        }
        const selected = p.selectedAgentId === agent.id
          || (p.selectedObject?.kind === 'agent' && p.selectedObject.id === agent.id);
        const highlighted = agent.name === p.speaker || selected;
        const key = `${agent.name}|${highlighted}|${selected}`;
        if (key !== f.spriteKey) {
          f.sprite.material.map = nameTexture(agent.name, selected ? '#ffffff' : highlighted ? '#fde68a' : '#e2e8f0');
          // 常态名牌服从场景遮挡；仅当前说话者允许穿透，避免整片树林上漂满文字。
          f.sprite.material.depthTest = !highlighted;
          f.sprite.material.opacity = highlighted ? 1 : 0.9;
          f.sprite.renderOrder = highlighted ? 20 : 5;
          f.spriteKey = key;
        }
      }
      for (const [id, f] of figures) {
        if (!agents.some((a) => a.id === id)) {
          removeFigure(f);
          figures.delete(id);
        }
      }
    };

    interface SpeechLayoutRect {
      left: number;
      right: number;
      top: number;
      bottom: number;
    }
    interface SpeechLayoutItem {
      figure: FigureParts;
      text: string;
      anchorX: number;
      anchorY: number;
      width: number;
      height: number;
    }
    interface SpeechLayoutCandidate {
      placement: SpeechBubblePlacement;
      lane: number;
      lift: number;
      rect: SpeechLayoutRect;
      cost: number;
    }
    const speechAnchorWorld = new THREE.Vector3();
    const speechAnchorView = new THREE.Vector3();
    const speechProjected = new THREE.Vector3();
    const speechWorldScale = new THREE.Vector3();
    const overlapArea = (left: SpeechLayoutRect, right: SpeechLayoutRect): number => Math.max(
      0,
      Math.min(left.right, right.right) - Math.max(left.left, right.left),
    ) * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const layoutSpeechBubbles = () => {
      const viewportWidth = mount.clientWidth;
      const viewportHeight = mount.clientHeight;
      if (viewportWidth <= 0 || viewportHeight <= 0) return;
      camera.updateMatrixWorld();
      const items: SpeechLayoutItem[] = [];
      for (const line of propsRef.current.speechBySpeaker.values()) {
        const figure = figures.get(line.speakerId);
        if (!figure?.speechBubble.visible) continue;
        figure.group.updateWorldMatrix(true, false);
        figure.speechBubble.getWorldPosition(speechAnchorWorld);
        speechProjected.copy(speechAnchorWorld).project(camera);
        if (speechProjected.z < -1 || speechProjected.z > 1) continue;
        speechAnchorView.copy(speechAnchorWorld).applyMatrix4(camera.matrixWorldInverse);
        const depth = Math.max(0.01, -speechAnchorView.z);
        const worldUnitsPerPixel = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
          / viewportHeight;
        figure.speechBubble.getWorldScale(speechWorldScale);
        items.push({
          figure,
          text: line.text,
          anchorX: (speechProjected.x + 1) * 0.5 * viewportWidth,
          anchorY: (1 - speechProjected.y) * 0.5 * viewportHeight,
          width: speechWorldScale.x / worldUnitsPerPixel,
          height: speechWorldScale.y / worldUnitsPerPixel,
        });
      }
      if (!items.length) return;

      const laneStep = Math.max(...items.map((item) => item.height)) + SPEECH_COLLISION_GAP_PX;
      const meanAnchorX = items.reduce((sum, item) => sum + item.anchorX, 0) / items.length;
      const candidates = items.map((item): SpeechLayoutCandidate[] => {
        const outwardFirst: SpeechBubblePlacement = item.anchorX <= meanAnchorX ? 'body-left' : 'body-right';
        const placements: SpeechBubblePlacement[] = ['center', outwardFirst,
          outwardFirst === 'body-left' ? 'body-right' : 'body-left'];
        return Array.from({ length: items.length }, (_, lane) => placements.map((placement) => {
          const anchorRatio = speechBubbleAnchorX(item.figure.speechPixelWidth, placement);
          const lift = lane * laneStep;
          const left = item.anchorX - anchorRatio * item.width;
          const bottom = item.anchorY - lift;
          const rect = { left, right: left + item.width, top: bottom - item.height, bottom };
          const overflow = Math.max(0, 10 - rect.left)
            + Math.max(0, rect.right - viewportWidth + 10)
            + Math.max(0, 10 - rect.top)
            + Math.max(0, rect.bottom - viewportHeight + 10);
          const pointsAway = placement === outwardFirst;
          return {
            placement,
            lane,
            lift,
            rect,
            cost: lane * 140 + (placement === 'center' ? 0 : pointsAway ? 14 : 42) + overflow * 1_000,
          };
        })).flat();
      });

      let bestCost = Number.POSITIVE_INFINITY;
      let best: SpeechLayoutCandidate[] = [];
      const chosen: SpeechLayoutCandidate[] = [];
      const search = (index: number, cost: number) => {
        if (cost >= bestCost) return;
        if (index >= candidates.length) {
          bestCost = cost;
          best = [...chosen];
          return;
        }
        for (const candidate of candidates[index]) {
          const collisionCost = chosen.reduce(
            (sum, placed) => sum + overlapArea(candidate.rect, placed.rect) * 10_000,
            0,
          );
          chosen.push(candidate);
          search(index + 1, cost + candidate.cost + collisionCost);
          chosen.pop();
        }
      };
      search(0, 0);

      items.forEach((item, index) => {
        const placement = best[index] ?? candidates[index][0];
        if (placement.placement !== item.figure.speechPlacement) {
          setSpeechBubbleTexture(item.figure, item.text, placement.placement);
        }
        const anchorRatio = speechBubbleAnchorX(item.figure.speechPixelWidth, placement.placement);
        item.figure.speechBubble.center.set(anchorRatio, -placement.lift / Math.max(1, item.height));
      });
    };

    // ---- 点选人物 / 权威结构；拖拽镜头不会触发选择，点击空白收起信息 ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const risePinch = new PinchTransitionGesture('zoom-out');
    let selectionPointerDown: { x: number; y: number } | null = null;
    const emitSelection = (selection: SocietySceneSelection) => {
      const p = propsRef.current;
      p.onSelectObject?.(selection);
      p.onSelectAgent?.(selection?.kind === 'agent' ? selection.id : null);
    };
    const selectionFromHit = (object: THREE.Object3D): SocietySceneSelection => {
      let current: THREE.Object3D | null = object;
      while (current && current !== scene) {
        if (typeof current.userData.agentId === 'string') return { kind: 'agent', id: current.userData.agentId };
        if (typeof current.userData.structureId === 'string') return { kind: 'structure', id: current.userData.structureId };
        current = current.parent;
      }
      return null;
    };
    const onSelectionPointerDown = (event: PointerEvent) => {
      selectionPointerDown = { x: event.clientX, y: event.clientY };
    };
    const onSelectionPointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch' && risePinch.consumeTapSuppression(event.pointerId)) {
        selectionPointerDown = null;
        return;
      }
      if (!selectionPointerDown
        || Math.hypot(event.clientX - selectionPointerDown.x, event.clientY - selectionPointerDown.y) >= 5) {
        selectionPointerDown = null;
        return;
      }
      selectionPointerDown = null;
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const figureHits = raycaster.intersectObjects([...figures.values()].map((figure) => figure.group), true);
      if (figureHits.length) {
        emitSelection(selectionFromHit(figureHits[0].object));
        return;
      }
      const structureHits = raycaster.intersectObjects(structureSelectionGroup.children, true);
      emitSelection(structureHits.length ? selectionFromHit(structureHits[0].object) : null);
    };

    // ---- 滚轮 / 键盘 / 双指缩放持续越过阈值 → 请求升起返回宇宙 ----
    let zoomOutAcc = 0;
    let zoomOutAsked = false;
    const requestZoomOut = () => {
      if (zoomOutAsked || !propsRef.current.onZoomOutRequest) return;
      zoomOutAsked = true;
      controls.maxDistance = Math.max(600, controls.maxDistance * 1.8); // 过场期间允许继续升高
      propsRef.current.onZoomOutRequest();
    };
    const accumulateZoomOut = (deltaY: number) => {
      if (zoomOutAsked || !propsRef.current.onZoomOutRequest) return;
      if (deltaY > 0 && camera.position.distanceTo(controls.target) >= controls.maxDistance - 0.6) {
        zoomOutAcc += deltaY;
        if (zoomOutAcc > 300) requestZoomOut();
      } else {
        zoomOutAcc = 0;
      }
    };
    const onWheelOut = (ev: WheelEvent) => { accumulateZoomOut(ev.deltaY); };
    const onRisePinchPointerDown = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      risePinch.pointerDown(ev.pointerId, ev.clientX, ev.clientY);
    };
    const onRisePinchPointerMove = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      const update = risePinch.pointerMove(ev.pointerId, ev.clientX, ev.clientY);
      if (update.triggered) requestZoomOut();
    };
    const onRisePinchPointerUp = (ev: PointerEvent) => {
      if (ev.pointerType === 'touch') risePinch.pointerUp(ev.pointerId);
    };
    const onRisePinchPointerCancel = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return;
      risePinch.pointerCancel(ev.pointerId);
      risePinch.consumeTapSuppression(ev.pointerId);
      selectionPointerDown = null;
    };
    canvas.addEventListener('pointerdown', onRisePinchPointerDown);
    canvas.addEventListener('pointermove', onRisePinchPointerMove);
    canvas.addEventListener('pointerup', onRisePinchPointerUp);
    canvas.addEventListener('pointercancel', onRisePinchPointerCancel);
    canvas.addEventListener('pointerdown', onSelectionPointerDown);
    canvas.addEventListener('pointerup', onSelectionPointerUp);
    canvas.addEventListener('wheel', onWheelOut, { passive: true });

    // ---- 键盘镜头：WASD 沿当前视角平移，↑↓ 复用滚轮的距离语义 ----
    const pressedKeys = new Set<string>();
    const cameraMove = new THREE.Vector3();
    const viewForward = new THREE.Vector3();
    const viewRight = new THREE.Vector3();
    const cameraOffset = new THREE.Vector3();
    const handledKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown']);
    const isEditableTarget = (target: EventTarget | null) => target instanceof HTMLElement
      && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!handledKeys.has(ev.code) || ev.metaKey || ev.ctrlKey || ev.altKey || isEditableTarget(ev.target)) return;
      ev.preventDefault();
      pressedKeys.add(ev.code);
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      pressedKeys.delete(ev.code);
      if (ev.code === 'ArrowDown' && !zoomOutAsked) zoomOutAcc = 0;
    };
    const clearPressedKeys = () => {
      pressedKeys.clear();
      if (!zoomOutAsked) zoomOutAcc = 0;
    };
    const updateKeyboardCamera = (deltaSeconds: number) => {
      if (!controls.enabled || pressedKeys.size === 0) return;

      const forwardAxis = Number(pressedKeys.has('KeyW')) - Number(pressedKeys.has('KeyS'));
      const rightAxis = Number(pressedKeys.has('KeyD')) - Number(pressedKeys.has('KeyA'));
      if (forwardAxis !== 0 || rightAxis !== 0) {
        viewForward.subVectors(controls.target, camera.position);
        viewForward.y = 0;
        if (viewForward.lengthSq() < 1e-6) camera.getWorldDirection(viewForward).setY(0);
        viewForward.normalize();
        viewRight.crossVectors(viewForward, camera.up).normalize();
        cameraMove.set(0, 0, 0)
          .addScaledVector(viewForward, forwardAxis)
          .addScaledVector(viewRight, rightAxis);
        if (cameraMove.lengthSq() > 0) {
          const distance = camera.position.distanceTo(controls.target);
          const speed = THREE.MathUtils.clamp(distance * 0.28, 7, 36);
          cameraMove.normalize().multiplyScalar(speed * deltaSeconds);
          const halfX = Math.max(1, world0.width * 0.5 - CAMERA_TARGET_INSET_X);
          const halfZ = Math.max(1, world0.height * 0.5 - CAMERA_TARGET_INSET_Z);
          const nextX = THREE.MathUtils.clamp(cameraTarget.x + cameraMove.x, -halfX, halfX);
          const nextZ = THREE.MathUtils.clamp(cameraTarget.z + cameraMove.z, -halfZ, halfZ);
          cameraMove.set(nextX - cameraTarget.x, 0, nextZ - cameraTarget.z);
          cameraTarget.add(cameraMove);
          controls.target.add(cameraMove);
          camera.position.add(cameraMove);
        }
      }

      const zoomAxis = Number(pressedKeys.has('ArrowDown')) - Number(pressedKeys.has('ArrowUp'));
      if (zoomAxis !== 0) {
        cameraOffset.subVectors(camera.position, controls.target);
        const distance = cameraOffset.length();
        const nextDistance = THREE.MathUtils.clamp(
          distance * Math.exp(zoomAxis * 1.1 * deltaSeconds),
          controls.minDistance,
          controls.maxDistance,
        );
        if (distance > 1e-6) camera.position.copy(controls.target).addScaledVector(cameraOffset.normalize(), nextDistance);
        if (zoomAxis > 0) accumulateZoomOut(520 * deltaSeconds);
        else if (!zoomOutAsked) zoomOutAcc = 0;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearPressedKeys);

    // ---- 后处理管线：Render → 轻量 GTAO → 自适应移轴 → ACES 输出 → FXAA ----
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera)); // 先渲染 beauty（GTAO 在 readBuffer 上合成 AO）
    const gtaoPass = new ScopedGTAOPass(scene, camera, 1, 1);
    gtaoPass.updateGtaoMaterial({
      radius: 0.08,
      distanceExponent: 1,
      thickness: 0.12,
      scale: 1,
      samples: 12,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
    gtaoPass.blendIntensity = 0.52;
    gtaoPass.excluded = aoExcluded;
    composer.addPass(gtaoPass);
    const tiltShiftPass = new ShaderPass(AdaptiveTiltShiftShader);
    composer.addPass(tiltShiftPass);
    composer.addPass(new OutputPass());
    const fxaaPass = new ShaderPass(FXAAShader);
    composer.addPass(fxaaPass);

    // 交互时优先保证镜头跟手；松手后恢复环境遮蔽和景深表现。
    const onControlsStart = () => {
      gtaoPass.enabled = false;
      tiltShiftPass.enabled = false;
    };
    const onControlsEnd = () => {
      gtaoPass.enabled = true;
      tiltShiftPass.enabled = true;
    };
    controls.addEventListener('start', onControlsStart);
    controls.addEventListener('end', onControlsEnd);

    const tiltFocusWorld = new THREE.Vector3();
    const tiltCandidateWorld = new THREE.Vector3();
    const tiltFocusProjected = new THREE.Vector3();
    let tiltFocusY = 0.5;
    let tiltStrength = 0;
    let tiltBand = 0.2;
    let tiltBlurCssPixels = 0;
    const updateTiltShift = (deltaSeconds: number, entryT: number) => {
      const selection = propsRef.current.selectedObject;
      let hasSubject = false;

      if (selection?.kind === 'agent') {
        const figure = figures.get(selection.id);
        if (figure) {
          figure.group.updateWorldMatrix(true, false);
          figure.group.getWorldPosition(tiltFocusWorld);
          tiltFocusWorld.y += 0.8;
          hasSubject = true;
        }
      } else if (selection?.kind === 'structure') {
        const proxy = structureSelectionGroup.children.find(
          (child) => child.userData.structureId === selection.id,
        );
        if (proxy) {
          proxy.updateWorldMatrix(true, false);
          proxy.getWorldPosition(tiltFocusWorld);
          hasSubject = true;
        }
      }

      // 没有显式选择时让清晰带照顾正在发生的对话；多个说话者取平均位置。
      if (!hasSubject) {
        let speakerCount = 0;
        tiltFocusWorld.set(0, 0, 0);
        for (const speakerId of propsRef.current.speechBySpeaker.keys()) {
          const figure = figures.get(speakerId);
          if (!figure?.speechBubble.visible) continue;
          figure.group.updateWorldMatrix(true, false);
          figure.group.getWorldPosition(tiltCandidateWorld);
          tiltCandidateWorld.y += 0.9;
          tiltFocusWorld.add(tiltCandidateWorld);
          speakerCount++;
        }
        if (speakerCount > 0) {
          tiltFocusWorld.multiplyScalar(1 / speakerCount);
          hasSubject = true;
        }
      }

      if (!hasSubject) tiltFocusWorld.copy(controls.target);
      camera.updateMatrixWorld();
      tiltFocusProjected.copy(tiltFocusWorld).project(camera);
      const desiredFocusY = THREE.MathUtils.clamp(tiltFocusProjected.y * 0.5 + 0.5, 0.18, 0.82);
      tiltFocusY = THREE.MathUtils.damp(tiltFocusY, desiredFocusY, 8, deltaSeconds);

      const distanceRatio = camera.position.distanceTo(controls.target) / Math.max(1, cameraFitDistance);
      const overviewMix = THREE.MathUtils.smoothstep(distanceRatio, 0.18, 1.05);
      const transitionVisibility = zoomOutAsked ? 0 : THREE.MathUtils.smoothstep(entryT, 0.5, 1);
      const desiredStrength = (0.12 + overviewMix * 0.88) * transitionVisibility;
      const desiredBand = THREE.MathUtils.lerp(0.24, hasSubject ? 0.155 : 0.135, overviewMix);
      const desiredBlurCssPixels = THREE.MathUtils.lerp(0.8, hasSubject ? 4.5 : 5.5, overviewMix);
      tiltStrength = THREE.MathUtils.damp(tiltStrength, desiredStrength, 6, deltaSeconds);
      tiltBand = THREE.MathUtils.damp(tiltBand, desiredBand, 7, deltaSeconds);
      tiltBlurCssPixels = THREE.MathUtils.damp(tiltBlurCssPixels, desiredBlurCssPixels, 7, deltaSeconds);

      tiltShiftPass.uniforms.uFocusY.value = tiltFocusY;
      tiltShiftPass.uniforms.uBand.value = tiltBand;
      tiltShiftPass.uniforms.uStrength.value = tiltStrength;
      tiltShiftPass.uniforms.uMaxBlur.value = tiltBlurCssPixels * renderer.getPixelRatio();
    };

    // ---- 尺寸自适应 ----
    const resize = () => {
      const wpx = mount.clientWidth;
      const hpx = mount.clientHeight;
      if (wpx <= 0 || hpx <= 0) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, SOCIETY_MAX_PIXEL_RATIO));
      renderer.setSize(wpx, hpx, false);
      camera.aspect = wpx / hpx;
      // 选择完整画幅下方 7% 的视窗，相当于把地表主体稳定上提 7%，且不改变旋转中心。
      camera.setViewOffset(wpx, hpx, 0, hpx * 0.07, wpx, hpx);
      updateCameraFit(wpx, hpx);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(wpx, hpx); // 内部会把 GTAO 等 Pass 按 pixelRatio 换算
      const pr = renderer.getPixelRatio();
      tiltShiftPass.uniforms.uResolution.value.set(wpx * pr, hpx * pr);
      fxaaPass.material.uniforms.resolution.value.set(1 / (wpx * pr), 1 / (hpx * pr));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // ---- 主循环 ----
    let raf = 0;
    let previousFrameAt = performance.now();
    const tick = () => {
      raf = 0;
      if (document.hidden) return;
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const deltaSeconds = Math.min(0.05, Math.max(0, (now - previousFrameAt) / 1_000));
      previousFrameAt = now;
      syncAgents(now);
      syncAnimatedDecor(now);
      waterFlowUniforms.uTime.value = now * 0.001;
      updateWeather(now, deltaSeconds);
      updateLighting(deltaSeconds);
      updateClouds(deltaSeconds);
      waterMat.roughness = 0.21 + 0.01 * Math.sin(now * 0.0016);
      waterMat.clearcoat = 0.42 + 0.025 * Math.sin(now * 0.0019 + 0.8);
      DECOR_MATS.glowWarm.emissiveIntensity = 1.2 + 0.18 * Math.sin(now * 0.011) + 0.1 * Math.sin(now * 0.027 + 1.4);
      DECOR_MATS.glowRed.emissiveIntensity = 1.35 + 0.2 * Math.sin(now * 0.014 + 1) + 0.08 * Math.sin(now * 0.031);
      // 入场：从太空高位丝滑下降（easeOutCubic），结束后开放相机控制
      const entryT = Math.min(1, (now - mountedAt) / 1100);
      const entryE = 1 - Math.pow(1 - entryT, 3);
      if (entryT < 1) {
        camera.position.lerpVectors(cameraEntry, cameraFinal, entryE);
        camera.lookAt(cameraTarget);
      } else if (!controls.enabled) {
        camera.position.copy(cameraFinal);
        camera.lookAt(cameraTarget);
        controls.enabled = true;
        controls.saveState(); // “复位视角”落到入场后的机位
      }
      updateKeyboardCamera(deltaSeconds);
      controls.update();
      updateTiltShift(deltaSeconds, entryT);
      layoutSpeechBubbles();
      // 天体距离视为无限远：平移镜头时只移动观察点，不让星野产生近景视差。
      if (skyStars) {
        skyStars.position.copy(camera.position);
        camera.getWorldDirection(liveCameraDirection);
        skyAtmosphereUniforms.uVerticalBias.value = -liveCameraDirection.y;
      }
      updateHumanSky(deltaSeconds);
      composer.render();
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        previousFrameAt = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearPressedKeys);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheelOut);
      canvas.removeEventListener('pointerdown', onRisePinchPointerDown);
      canvas.removeEventListener('pointermove', onRisePinchPointerMove);
      canvas.removeEventListener('pointerup', onRisePinchPointerUp);
      canvas.removeEventListener('pointercancel', onRisePinchPointerCancel);
      canvas.removeEventListener('pointerdown', onSelectionPointerDown);
      canvas.removeEventListener('pointerup', onSelectionPointerUp);
      controls.removeEventListener('start', onControlsStart);
      controls.removeEventListener('end', onControlsEnd);
      controls.dispose();
      terrainApiRef.current = null;
      lightApiRef.current = null;
      decorApiRef.current = null;
      skyApiRef.current = null;
      selectionApiRef.current = null;
      animatedDecorBatches = [];
      for (const f of figures.values()) disposeFigure(f);
      figures.clear();
      for (const child of [...decorGroup.children]) (child as THREE.InstancedMesh).dispose(); // 释放装饰层实例缓冲
      scene.environment = null;
      scene.background = null;
      skyGlowTexture.dispose();
      skySurfaceTextures.forEach((texture) => texture.dispose());
      cloudNoiseTexture.dispose();
      cloudShadowTexture.dispose();
      cloudShadowMaterial.dispose();
      skyTexture?.dispose();
      environmentTarget?.dispose();
      distantSky.dispose();
      galaxyTarget.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | undefined;
        if (mat) mat.dispose(); // 贴图在模块缓存中共享，不在此处销毁
      });
      composer.dispose();
      renderer.dispose();
    };
  }, []);

  // ---- 地形/实体随月度状态重建；光照随纪元；装饰层随状态+纪元 ----
  useEffect(() => { terrainApiRef.current?.(society); }, [society]);
  useEffect(() => { lightApiRef.current?.(era); }, [era]);
  useEffect(() => { decorApiRef.current?.(society, era); }, [society, era]);
  useEffect(() => { skyApiRef.current?.(sky); }, [sky]);
  useEffect(() => { selectionApiRef.current?.(society); }, [society]);

  return (
    <div ref={mountRef} className="absolute inset-0 z-[5] overflow-hidden bg-[#0b1016]">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="人间场景：点击人物或结构查看信息，WASD 移动镜头，方向键或双指上下缩放"
        className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      />
      <div className="sr-only" aria-atomic="true" aria-live="polite" aria-relevant="additions text">
        {visibleSpeechLines.map((line) => (
          <span className="block" key={line.id}>
            {line.speakerName}
            {line.audienceNames.length ? `对${line.audienceNames.join('、')}` : ''}
            说：{line.text}
          </span>
        ))}
      </div>
    </div>
  );
}
