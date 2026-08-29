import * as THREE from 'three';
import type { EraKey, SocietyState } from '@/game/societyContract';
import { ERA_LIGHT } from './environmentVisuals';

export interface WeatherSurfaceUniforms {
  rain: { value: number };
  sunGlint: { value: number };
}

export interface WeatherFogTargets {
  color: THREE.Color;
  near: number;
  far: number;
}

interface WeatherRuntimeOptions {
  scene: THREE.Scene;
  world: SocietyState['world'];
  sunlight: THREE.DirectionalLight;
  initialEra: EraKey;
  aoExcluded: THREE.Object3D[];
  readFrame: () => { society: SocietyState; era: EraKey };
}

export interface WeatherRuntime {
  readonly fog: WeatherFogTargets;
  attach(uniforms: WeatherSurfaceUniforms): void;
  update(now: number, deltaSeconds: number): void;
  dispose(): void;
}

export function createWeatherRuntime({
  scene,
  world: world0,
  sunlight: sun,
  initialEra,
  aoExcluded,
  readFrame,
}: WeatherRuntimeOptions): WeatherRuntime {
  const fog: WeatherFogTargets = {
    color: new THREE.Color(ERA_LIGHT[initialEra].fog),
    near: 175,
    far: 460,
  };
  let updateProjection = (_now: number, _deltaSeconds: number) => {};
  let disposeProjection = () => {};
  const removeAoExcluded = (object: THREE.Object3D) => {
    const index = aoExcluded.indexOf(object);
    if (index >= 0) aoExcluded.splice(index, 1);
  };
  const attach = (uniforms: WeatherSurfaceUniforms) => {
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
    updateProjection = (now: number, deltaSeconds: number) => {
      const frame = readFrame();
      const weather = frame.society.weather ?? { kind: 'clear' as const, intensity: 0, sinceMonth: 0 };
      const strength = THREE.MathUtils.clamp(weather.intensity, 1, 10);
      rain.visible = weather.kind === 'rain' || weather.kind === 'storm';
      snow.visible = weather.kind === 'snow';
      dust.visible = weather.kind === 'drought';
      uniforms.rain.value = rain.visible ? Math.min(1, 0.35 + strength * 0.09) : 0;
      // 日光碎金强度：跟随真实日照，阴雨/雪/雾天自动减弱，夜间归零。
      uniforms.sunGlint.value = THREE.MathUtils.clamp(sun.intensity / 1.9, 0, 1)
        * (weather.kind === 'clear' || weather.kind === 'drought' ? 1
          : weather.kind === 'snow' || weather.kind === 'fog' ? 0.35 : 0.55);

      const eraFog = ERA_LIGHT[frame.era].fog;
      fog.color.set(weather.kind === 'fog' ? '#aab5b5'
        : weather.kind === 'rain' || weather.kind === 'storm' ? '#34495d'
          : weather.kind === 'snow' ? '#9cabb8'
            : weather.kind === 'drought' ? '#806d50' : eraFog);
      if (weather.kind === 'fog') { fog.near = 36; fog.far = 115 + (10 - strength) * 7; }
      else if (weather.kind === 'storm') { fog.near = 65; fog.far = 185 + (10 - strength) * 6; }
      else if (weather.kind === 'rain' || weather.kind === 'snow') { fog.near = 90; fog.far = 245; }
      else if (weather.kind === 'drought') { fog.near = 115; fog.far = 330; }
      else { fog.near = 175; fog.far = 460; }

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
    disposeProjection = () => {
        removeAoExcluded(rain);
        removeAoExcluded(snow);
        removeAoExcluded(dust);
        rain.removeFromParent();
        snow.removeFromParent();
        dust.removeFromParent();
        rainGeo.dispose();
        snowGeo.dispose();
        dustGeo.dispose();
        (rain.material as THREE.Material).dispose();
        (snow.material as THREE.Material).dispose();
        (dust.material as THREE.Material).dispose();
    };
  };

  return {
    fog,
    attach,
    update: (now, deltaSeconds) => updateProjection(now, deltaSeconds),
    dispose: () => disposeProjection(),
  };
}
