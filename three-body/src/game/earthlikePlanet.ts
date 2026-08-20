import * as THREE from 'three';
import { makePlanetTextureSet, type PlanetTextureSet } from '@/game/proceduralTextures';

export interface EarthlikePlanetVisual {
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  cloudShadow: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  clouds: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  atmosphere: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  atmosphereMaterial: THREE.ShaderMaterial;
  textures: PlanetTextureSet;
}

/** 创建共享的类地行星表现组；这里只读取纹理，不承载任何文明或世界事实。 */
export function createEarthlikePlanet(seed: number): EarthlikePlanetVisual {
  const textures = makePlanetTextureSet(seed);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(1, 72, 48),
    new THREE.MeshPhysicalMaterial({
      map: textures.day,
      roughness: 1,
      roughnessMap: textures.roughness,
      normalMap: textures.normal,
      normalScale: new THREE.Vector2(0.28, 0.28),
      metalness: 0,
      clearcoat: 0.38,
      clearcoatMap: textures.water,
      clearcoatRoughness: 0.24,
      // 只给背光面一个极弱的深蓝散射底，不再把整张昼面作为自发光贴图。
      emissive: new THREE.Color('#07131d'),
      emissiveIntensity: 0.1,
      transparent: true,
    }),
  );

  // 复用云层 alpha，在贴近地表的壳上形成廉价、稳定的云影。
  const cloudShadow = new THREE.Mesh(
    new THREE.SphereGeometry(1.008, 64, 40),
    new THREE.MeshBasicMaterial({
      map: textures.clouds,
      color: new THREE.Color('#071018'),
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      toneMapped: false,
    }),
  );

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.026, 64, 40),
    new THREE.MeshBasicMaterial({
      map: textures.clouds,
      color: new THREE.Color('#dce8ed'),
      transparent: true,
      opacity: 0.82,
      alphaTest: 0.008,
      depthWrite: false,
    }),
  );

  // 生产级大气的轻量近似：Rayleigh 蓝光、晨昏暖色带和少量 Mie 前向散射。
  // 完整散射只跟随主导恒星，另外两颗恒星仍通过 PBR 灯光照亮地表与云层。
  const atmosphereMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uRayleighColor: { value: new THREE.Color('#63b7f2') },
      uSunsetColor: { value: new THREE.Color('#ffad72') },
      uSunColor: { value: new THREE.Color('#fff5dc') },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uIntensity: { value: 0.84 },
    },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      void main() {
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uRayleighColor;
      uniform vec3 uSunsetColor;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uIntensity;
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      void main() {
        vec3 normalW = normalize(vNormalW);
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        vec3 sunDir = normalize(uSunDir);
        float normalView = clamp(dot(normalW, viewDir), 0.0, 1.0);
        float normalSun = dot(normalW, sunDir);
        float horizon = pow(1.0 - normalView, 3.25);
        float daylight = smoothstep(-0.22, 0.18, normalSun);
        float sunsetBand = exp(-abs(normalSun) * 9.0) * smoothstep(0.08, 0.72, horizon);
        float mie = pow(max(dot(viewDir, sunDir), 0.0), 8.0) * horizon * daylight;
        vec3 rayleigh = uRayleighColor * mix(vec3(1.0), uSunColor, 0.18);
        vec3 color = rayleigh * (0.48 + daylight * 0.52)
          + uSunsetColor * sunsetBand * 0.72
          + uSunColor * mie * 0.24;
        float alpha = horizon * (0.1 + daylight * 0.7 + sunsetBand * 0.32) * uIntensity;
        gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.92));
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.075, 72, 48),
    atmosphereMaterial,
  );

  for (const mesh of [core, cloudShadow, clouds, atmosphere]) mesh.rotation.x = 0.15;
  core.renderOrder = 4;
  cloudShadow.renderOrder = 5;
  clouds.renderOrder = 6;
  atmosphere.renderOrder = 7;

  return { core, cloudShadow, clouds, atmosphere, atmosphereMaterial, textures };
}

export function disposeEarthlikePlanet(visual: EarthlikePlanetVisual): void {
  for (const texture of Object.values(visual.textures)) texture.dispose();
  for (const mesh of [visual.core, visual.cloudShadow, visual.clouds, visual.atmosphere]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}
