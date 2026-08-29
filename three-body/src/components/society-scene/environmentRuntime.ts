import * as THREE from 'three';
import type { EraKey, SocietyState } from '@/game/societyContract';
import { createDistantSkyLayer } from '@/game/distantSky';
import { bakeProceduralGalaxy } from '@/game/proceduralGalaxy';
import { makeStarSurfaceTexture, mulberry32 } from '@/game/proceduralTextures';
import { createHumanMeteorLayer } from '@/game/skyPhenomena';
import { N_STARS, STAR_STYLES } from '@/lib/threebody';
import {
  CLOUD_WEATHER,
  DAYLIGHT_CYCLE_SECONDS,
  ERA_LIGHT,
  ERA_SKY,
  LIGHT_DAMPING,
  isChaoticLightEra,
  makeCloudNoiseTexture,
  makeCloudVolumeMaterial,
  makeHumanSkyGlowTexture,
  sampleDaylight,
} from './environmentVisuals';
import { visualSpatialHash } from './visualNoise';
import {
  createWeatherRuntime,
  type WeatherSurfaceUniforms,
} from './weatherRuntime';

export interface HumanSkySnapshot {
  t: number;
  fluxRel: number;
  bodies: readonly number[]; // [三颗恒星 x/y, 行星 x/y]，与 SimStats.bodies 一致
}

interface EnvironmentRuntimeOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  cameraForward: THREE.Vector3;
  cameraRight: THREE.Vector3;
  cameraUp: THREE.Vector3;
  world: SocietyState['world'];
  initialEra: EraKey;
  initialSky?: HumanSkySnapshot;
  terrainApronCells: number;
  aoExcluded: THREE.Object3D[];
  readFrame: () => { society: SocietyState; era: EraKey };
}

export interface EnvironmentRuntime {
  readonly sunlight: THREE.DirectionalLight;
  readonly fireLights: readonly THREE.PointLight[];
  setEra(era: EraKey): void;
  setSky(snapshot?: HumanSkySnapshot): void;
  attachWeatherProjection(uniforms: WeatherSurfaceUniforms): void;
  updateBeforeCamera(now: number, deltaSeconds: number): void;
  updateAfterCamera(deltaSeconds: number): void;
  dispose(): void;
}

export function createEnvironmentRuntime({
  scene,
  renderer,
  camera,
  cameraForward,
  cameraRight,
  cameraUp,
  world: world0,
  initialEra,
  initialSky,
  terrainApronCells: TERRAIN_APRON_CELLS,
  aoExcluded,
  readFrame,
}: EnvironmentRuntimeOptions): EnvironmentRuntime {
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

    // 银河噪声只在挂载时烘焙一次；天空球每帧只采样 Cubemap。
    const galaxyTarget = bakeProceduralGalaxy(renderer);

    // ---- 天空球：天顶、银河、地平线和三颗可见恒星附近的散射均可连续调色 ----
    const skyStarDirections = Array.from({ length: N_STARS }, () => new THREE.Vector3(0, 1, 0));
    const skyStarColors = STAR_STYLES.map((style) => new THREE.Color(style.glow));
    const skyStarStrengths = new Float32Array(N_STARS);
    const skyAtmosphereUniforms = {
      uZenithColor: { value: new THREE.Color(ERA_SKY[initialEra].nightZenith) },
      uHorizonColor: { value: new THREE.Color(ERA_SKY[initialEra].nightHorizon) },
      uNadirColor: { value: new THREE.Color(ERA_SKY[initialEra].nadir) },
      uHazeColor: { value: new THREE.Color(ERA_SKY[initialEra].haze) },
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
    const humanMeteors = createHumanMeteorLayer(scene, world0.generator.seed);
    aoExcluded.push(humanMeteors.object);

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

    const setSky = (snapshot?: HumanSkySnapshot) => {
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
    setSky(initialSky);

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
    let activeLightEra = initialEra;
    let lightingElapsedSeconds = 0;
    const sunlightTargetPosition = new THREE.Vector3();
    const daylightTone = new THREE.Color();
    const sunlightTargetColor = new THREE.Color();
    const eraSunColor = new THREE.Color();
    const chaosTone = new THREE.Color();
    const skyZenithTarget = new THREE.Color(ERA_SKY[activeLightEra].nightZenith);
    const skyHorizonTarget = new THREE.Color(ERA_SKY[activeLightEra].nightHorizon);
    const skyNadirTarget = new THREE.Color(ERA_SKY[activeLightEra].nadir);
    const skyHazeTarget = new THREE.Color(ERA_SKY[activeLightEra].haze);
    const skyColorScratch = new THREE.Color();
    let skyDaylightStrength = 0;
    let skyStarVisibility = 0;

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

    // ---- 火光点光源池：只照亮权威火焰事实映射出的装饰实例，不写回任何状态 ----
    // 灯位由装饰运行层按 'fire' 动画实例逐帧重绑；超过池容量时取离相机最近者。
    const FIRE_LIGHT_POOL_SIZE = 8;
    const fireLights: THREE.PointLight[] = [];
    for (let index = 0; index < FIRE_LIGHT_POOL_SIZE; index += 1) {
      const light = new THREE.PointLight('#ffa54d', 0, 7.5, 2);
      light.castShadow = false;
      light.visible = false;
      scene.add(light);
      fireLights.push(light);
    }

    const weatherRuntime = createWeatherRuntime({
      scene,
      world: world0,
      sunlight: sun,
      initialEra,
      aoExcluded,
      readFrame,
    });

    // ---- 稳定世界种子驱动的双层云；下层进入太阳深度图，形成随风移动的真实云影 ----
    const cloudNoiseTexture = makeCloudNoiseTexture(world0.generator.seed);
    const cloudShadowTexture = cloudNoiseTexture.clone();
    cloudShadowTexture.repeat.set(1, 1);
    cloudShadowTexture.offset.set(0, 0);
    cloudShadowTexture.needsUpdate = true;
    const cloudShadowMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      alphaMap: cloudShadowTexture,
      alphaTest: 0.50,
      side: THREE.DoubleSide,
    });
    const cloudShadowUniforms = {
      threshold: { value: CLOUD_WEATHER.clear.shadowThreshold },
      presence: { value: 0 },
      opacity: { value: 0 },
    };
    cloudShadowMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uCloudThreshold = cloudShadowUniforms.threshold;
      shader.uniforms.uCloudPresence = cloudShadowUniforms.presence;
      shader.uniforms.uCloudShadowOpacity = cloudShadowUniforms.opacity;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          `uniform float uCloudThreshold;
uniform float uCloudPresence;
uniform float uCloudShadowOpacity;
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
  float densityMask = smoothstep(uCloudThreshold - 0.11, uCloudThreshold + 0.09, cloudDensity);
  float shadowCoverage = clamp(
    uCloudPresence * uCloudShadowOpacity * radialFade * densityMask,
    0.0,
    1.0
  );
  float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  diffuseColor.a *= step(dither, shadowCoverage);
#endif`,
        );
    };
    cloudShadowMaterial.customProgramCacheKey = () => 'cloud-shadow-dithered-opacity-v6';
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
    const cloudFieldHalfX = world0.width * 0.5 + TERRAIN_APRON_CELLS + 24;
    const cloudFieldHalfZ = world0.height * 0.5 + TERRAIN_APRON_CELLS + 24;
    const cloudBoundaryFadeWidth = 24;
    const cloudCellSize = 6;
    const cloudWindDirection = new THREE.Vector2(1, 0.34).normalize();
    const cloudClusters = Array.from({ length: 14 }, (_, index) => {
      const angleJitter = (visualSpatialHash(world0.generator.seed, index, 3, 0x1b873593) - 0.5) * 0.22;
      const angle = index / 14 * Math.PI * 2 + angleJitter;
      const radialScale = 0.52 + visualSpatialHash(world0.generator.seed, index, 7, 0x85ebca6b) * 0.26;
      const baseY = 19 + visualSpatialHash(world0.generator.seed, index, 11, 0xc2b2ae35) * 7;
      const material = makeCloudVolumeMaterial(cloudNoiseTexture);
      const cluster = new THREE.Group();
      const clusterShadowCasters: THREE.Mesh[] = [];
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
        clusterShadowCasters.push(shadowCaster);
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
      cluster.userData.cloudShadowCasters = clusterShadowCasters;
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
    let cloudShadowOpacity = CLOUD_WEATHER.clear.shadowOpacity;
    let cloudShadowThreshold = CLOUD_WEATHER.clear.shadowThreshold;
    let cloudSpeed = CLOUD_WEATHER.clear.speed;
    const cloudLightTarget = new THREE.Color(CLOUD_WEATHER.clear.light);
    const cloudShadeTarget = new THREE.Color(CLOUD_WEATHER.clear.shade);

    const setEra = (eraKey: EraKey) => {
      activeLightEra = eraKey;
    };

    const updateLighting = (deltaSeconds: number) => {
      lightingElapsedSeconds += deltaSeconds;
      const phase = (lightingElapsedSeconds % DAYLIGHT_CYCLE_SECONDS) / DAYLIGHT_CYCLE_SECONDS;
      const daylight = sampleDaylight(phase, sunlightTargetPosition, daylightTone);
      const eraLight = ERA_LIGHT[activeLightEra];
      const chaotic = isChaoticLightEra(activeLightEra);
      const weather = readFrame().society.weather ?? { kind: 'clear' as const, intensity: 0, sinceMonth: 0 };
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
      fog.color.lerp(weatherRuntime.fog.color, blend);
      fog.near = THREE.MathUtils.damp(fog.near, weatherRuntime.fog.near, LIGHT_DAMPING, deltaSeconds);
      fog.far = THREE.MathUtils.damp(fog.far, weatherRuntime.fog.far, LIGHT_DAMPING, deltaSeconds);
      renderer.setClearColor(fog.color);
    };

    const updateClouds = (deltaSeconds: number) => {
      const weather = readFrame().society.weather ?? { kind: 'clear' as const, intensity: 0, sinceMonth: 0 };
      const profile = CLOUD_WEATHER[weather.kind];
      const severity = THREE.MathUtils.clamp((weather.intensity - 1) / 9, 0, 1);
      const targetOpacity = THREE.MathUtils.clamp(profile.opacity + severity * 0.06, 0, 1);
      const targetPresence = profile.presence * THREE.MathUtils.lerp(0.72, 1, severity);
      const targetShadowOpacity = THREE.MathUtils.clamp(profile.shadowOpacity + severity * 0.06, 0, 0.56);
      const targetShadowThreshold = profile.shadowThreshold - (weather.kind === 'clear' || weather.kind === 'drought' ? 0 : severity * 0.045);

      // 生成和消散都保留数秒过渡，但晴天、旱天与雾天最终会彻底无云。
      cloudOpacity = THREE.MathUtils.damp(cloudOpacity, targetOpacity, 0.46, deltaSeconds);
      cloudPresence = THREE.MathUtils.damp(cloudPresence, targetPresence, 0.38, deltaSeconds);
      cloudShadowOpacity = THREE.MathUtils.damp(cloudShadowOpacity, targetShadowOpacity, 0.46, deltaSeconds);
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
      cloudShadowUniforms.opacity.value = cloudShadowOpacity;

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
        const boundaryDistance = Math.min(
          cloudFieldHalfX - Math.abs(cluster.position.x),
          cloudFieldHalfZ - Math.abs(cluster.position.z),
        );
        const boundaryFade = THREE.MathUtils.smoothstep(boundaryDistance, 0, cloudBoundaryFadeWidth);
        material.uniforms.uOpacity.value = cloudOpacity
          * activationFade
          * boundaryFade
          * nightVisibility
          * 0.72;
        const shadowCasters = cluster.userData.cloudShadowCasters as THREE.Mesh[];
        shadowCasters.forEach((caster) => { caster.visible = boundaryFade > 0.08; });
        cluster.visible = activationFade > 0.006 && cloudOpacity > 0.006 && boundaryFade > 0.002;
      });
    };

    const removeAoExcluded = (object: THREE.Object3D) => {
      const index = aoExcluded.indexOf(object);
      if (index >= 0) aoExcluded.splice(index, 1);
    };
    const attachWeatherProjection = (uniforms: WeatherSurfaceUniforms) => {
      weatherRuntime.attach(uniforms);
    };

    const updateBeforeCamera = (now: number, deltaSeconds: number) => {
      weatherRuntime.update(now, deltaSeconds);
      updateLighting(deltaSeconds);
      updateClouds(deltaSeconds);
      humanMeteors.update(deltaSeconds, camera, skyStarVisibility);
    };

    const updateAfterCamera = (deltaSeconds: number) => {
      // 天体距离视为无限远：平移镜头时只移动观察点，不让星野产生近景视差。
      skyStars.position.copy(camera.position);
      camera.getWorldDirection(liveCameraDirection);
      skyAtmosphereUniforms.uVerticalBias.value = -liveCameraDirection.y;
      updateHumanSky(deltaSeconds);
    };

    const disposeRenderable = (object: THREE.Mesh | THREE.Points) => {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
      object.removeFromParent();
    };
    const dispose = () => {
      weatherRuntime.dispose();

      scene.environment = null;
      scene.background = null;
      skyGlowTexture.dispose();
      skySurfaceTextures.forEach((texture) => texture.dispose());
      cloudNoiseTexture.dispose();
      cloudShadowTexture.dispose();
      cloudShadowMaterial.dispose();
      skyTexture?.dispose();
      environmentTarget?.dispose();
      humanMeteors.dispose();
      distantSky.dispose();
      galaxyTarget.dispose();

      removeAoExcluded(skyBackdrop);
      removeAoExcluded(humanMeteors.object);
      removeAoExcluded(cloudGroup);
      skySuns.forEach(({ core, glow }) => {
        removeAoExcluded(core);
        removeAoExcluded(glow);
        disposeRenderable(core);
        (glow.material as THREE.Material).dispose();
        glow.removeFromParent();
      });
      for (const child of [...skyBackdrop.children]) {
        if (child === distantSky.group) continue;
        disposeRenderable(child as THREE.Mesh | THREE.Points);
      }
      skyBackdrop.removeFromParent();
      for (const cluster of cloudClusters) {
        (cluster.userData.cloudMaterial as THREE.Material).dispose();
      }
      cloudBlobGeometry.dispose();
      cloudShadowGeometry.dispose();
      cloudShadowSurfaceMaterial.dispose();
      cloudGroup.removeFromParent();
      hemi.removeFromParent();
      sun.removeFromParent();
      sunScatter.removeFromParent();
      rim.removeFromParent();
      fireLights.forEach((light) => light.removeFromParent());
    };

    return {
      sunlight: sun,
      fireLights,
      setEra,
      setSky,
      attachWeatherProjection,
      updateBeforeCamera,
      updateAfterCamera,
      dispose,
    };
}
