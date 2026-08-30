import * as THREE from 'three';
import type { EraKey, SocietyState } from '@/game/societyContract';
import { visualSpatialHash } from './visualNoise';

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
export function makeCloudNoiseTexture(seed: number): THREE.DataTexture {
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

export const CLOUD_WEATHER: Record<SocietyWeatherKind, {
  opacity: number;
  presence: number;
  shadowOpacity: number;
  shadowThreshold: number;
  speed: number;
  light: string;
  shade: string;
}> = {
  clear:   { opacity: 0, presence: 0, shadowOpacity: 0, shadowThreshold: 0.68, speed: 0.48, light: '#f7f9fb', shade: '#7f8c9a' },
  rain:    { opacity: 0.46, presence: 0.72, shadowOpacity: 0.30, shadowThreshold: 0.52, speed: 1.15, light: '#aebac2', shade: '#46535e' },
  storm:   { opacity: 0.58, presence: 1, shadowOpacity: 0.46, shadowThreshold: 0.44, speed: 2.30, light: '#7f8b94', shade: '#2d3943' },
  drought: { opacity: 0, presence: 0, shadowOpacity: 0, shadowThreshold: 0.78, speed: 0.90, light: '#e0d0b2', shade: '#8b755b' },
  snow:    { opacity: 0.52, presence: 0.82, shadowOpacity: 0.26, shadowThreshold: 0.51, speed: 0.75, light: '#eef2f4', shade: '#87949f' },
  fog:     { opacity: 0, presence: 0, shadowOpacity: 0, shadowThreshold: 0.70, speed: 0.28, light: '#ccd2d2', shade: '#858f92' },
};

/** 有真实厚度的软边云团材质；几何轮廓负责体积，噪声只用于内部明暗而不裁出硬边。
 *  照明跟随真实天光方向与阳光色：傍晚低角度染色，三日临空时云底烧成橙红。 */
export function makeCloudVolumeMaterial(noiseMap: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uNoiseMap: { value: noiseMap },
      uOffset: { value: new THREE.Vector2() },
      uOpacity: { value: 0 },
      uDaylight: { value: 1 },
      uLightColor: { value: new THREE.Color(CLOUD_WEATHER.clear.light) },
      uShadeColor: { value: new THREE.Color(CLOUD_WEATHER.clear.shade) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color('#fff1d6') },
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
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
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

        // 照明以真实天光方向为主：朝日面亮、背日面沉；太阳低垂时亮色染成阳光色。
        float sunFacing = clamp(dot(normalize(vCloudNormal), normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
        float topLight = clamp(vCloudNormal.y * 0.5 + 0.5, 0.0, 1.0);
        float lightMix = clamp(0.22 + uDaylight * 0.30 + sunFacing * 0.30 + topLight * 0.10 + detail * 0.12, 0.0, 1.0);
        vec3 litColor = mix(uLightColor, uSunColor, 0.42);
        vec3 color = mix(uShadeColor, litColor, lightMix);
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

export function makeHumanSkyGlowTexture(): THREE.CanvasTexture {
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
export const ERA_LIGHT: Record<EraKey, {
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
export const ERA_SKY: Record<EraKey, {
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

export const DAYLIGHT_CYCLE_SECONDS = 120;
// 90% 的追随约需 2.7 秒；纪元、雾和日照目标统一通过这层阻尼落到画面。
export const LIGHT_DAMPING = 0.86;
const DAYLIGHT_KEYFRAMES: readonly DaylightKeyframe[] = [
  { at: 0.00, position: new THREE.Vector3(-62, 28, 24), color: new THREE.Color('#ffbd7d'), direct: 0.68, ambient: 0.94, exposure: 0.96 },
  { at: 0.32, position: new THREE.Vector3(-10, 82, 28), color: new THREE.Color('#fff4dc'), direct: 1.04, ambient: 1.04, exposure: 1.02 },
  { at: 0.62, position: new THREE.Vector3(38, 54, 34), color: new THREE.Color('#ffd19a'), direct: 0.90, ambient: 1.00, exposure: 1.00 },
  { at: 0.82, position: new THREE.Vector3(64, 21, 18), color: new THREE.Color('#ff8758'), direct: 0.50, ambient: 0.91, exposure: 0.94 },
  // 黄昏后从地图背面低位回到清晨，保持循环连续，同时不把演示层做成完整昼夜系统。
  { at: 0.92, position: new THREE.Vector3(4, 15, -58), color: new THREE.Color('#9fabc9'), direct: 0.34, ambient: 0.86, exposure: 0.91 },
  { at: 1.00, position: new THREE.Vector3(-62, 28, 24), color: new THREE.Color('#ffbd7d'), direct: 0.68, ambient: 0.94, exposure: 0.96 },
];

export function isChaoticLightEra(era: EraKey): boolean {
  return era === 'chaotic' || era === 'chaotic-heat' || era === 'chaotic-cold';
}

export function sampleDaylight(
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
