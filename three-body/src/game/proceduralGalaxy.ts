import * as THREE from 'three';

export interface ProceduralGalaxyOptions {
  resolution?: number;
  seed?: number;
}

export const GALAXY_TILT_RADIANS = 0.48;
export const GALAXY_YAW_RADIANS = -0.70;

const GALAXY_VERTEX_SHADER = `
  varying vec3 vGalaxyDirection;

  void main() {
    vGalaxyDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GALAXY_FRAGMENT_SHADER = `
  precision highp float;

  varying vec3 vGalaxyDirection;
  uniform float uSeed;

  mat2 rotate2d(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, -s, s, c);
  }

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33 + uSeed * 0.001);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 cell = floor(p);
    vec3 local = fract(p);
    local = local * local * (3.0 - 2.0 * local);

    return mix(
      mix(
        mix(hash31(cell + vec3(0.0, 0.0, 0.0)), hash31(cell + vec3(1.0, 0.0, 0.0)), local.x),
        mix(hash31(cell + vec3(0.0, 1.0, 0.0)), hash31(cell + vec3(1.0, 1.0, 0.0)), local.x),
        local.y
      ),
      mix(
        mix(hash31(cell + vec3(0.0, 0.0, 1.0)), hash31(cell + vec3(1.0, 0.0, 1.0)), local.x),
        mix(hash31(cell + vec3(0.0, 1.0, 1.0)), hash31(cell + vec3(1.0, 1.0, 1.0)), local.x),
        local.y
      ),
      local.z
    );
  }

  float fbm3(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 4; octave++) {
      value += noise3(p) * amplitude;
      p = p * 2.03 + vec3(1.7, 9.2, 2.8);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec3 direction = normalize(vGalaxyDirection);
    direction.yz = rotate2d(${GALAXY_TILT_RADIANS.toFixed(2)}) * direction.yz;
    direction.xz = rotate2d(${GALAXY_YAW_RADIANS.toFixed(2)}) * direction.xz;

    float coarse = fbm3(direction * 3.2);
    float warp = (coarse - 0.5) * 0.16;
    float latitude = abs(asin(clamp(direction.y, -1.0, 1.0)) + warp);
    float band = exp(-pow(latitude / 0.23, 1.6));

    float detail = fbm3(direction * 14.0 + coarse * 2.4);
    float dustNoise = fbm3(direction * 32.0 + vec3(9.0));
    float dust = exp(-pow(latitude / 0.045, 2.0))
      * smoothstep(0.25, 0.85, dustNoise);

    vec3 centerDirection = normalize(vec3(1.0, 0.05, 0.15));
    float bulge = pow(max(dot(direction, centerDirection), 0.0), 5.0)
      * exp(-pow(latitude / 0.32, 2.0));

    vec3 deepSpace = vec3(0.0025, 0.0045, 0.0120);
    vec3 coolColor = vec3(0.10, 0.17, 0.34);
    vec3 warmColor = vec3(0.58, 0.30, 0.12);
    vec3 galaxyColor = mix(
      coolColor,
      warmColor,
      clamp(bulge * 1.7 + detail * 0.25, 0.0, 1.0)
    );

    vec3 galaxy = galaxyColor * band * (0.08 + detail * 0.36);
    galaxy += warmColor * bulge * 0.22;
    galaxy *= 1.0 - dust * 0.82;

    // Cubemap 只烘焙一次；轻微抖动用于压低深色渐变在低精度显示器上的色带。
    float dither = (hash31(direction * 4096.0) - 0.5) / 255.0;
    gl_FragColor = vec4(max(deepSpace + galaxy + dither, 0.0), 1.0);
  }
`;

/**
 * 将确定性的三维银河噪声一次性烘焙成 Cubemap。运行时场景只承担一次纹理采样，
 * 不会在每个画面像素上反复执行多层 fBm。
 */
export function bakeProceduralGalaxy(
  renderer: THREE.WebGLRenderer,
  options: ProceduralGalaxyOptions = {},
): THREE.WebGLCubeRenderTarget {
  const resolution = options.resolution ?? 512;
  const seed = options.seed ?? 731.0;
  const bakeScene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(5, 48, 24);
  const material = new THREE.ShaderMaterial({
    uniforms: { uSeed: { value: seed } },
    vertexShader: GALAXY_VERTEX_SHADER,
    fragmentShader: GALAXY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sphere = new THREE.Mesh(geometry, material);
  sphere.frustumCulled = false;
  bakeScene.add(sphere);

  const target = new THREE.WebGLCubeRenderTarget(resolution, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
  });
  target.texture.name = 'eland-procedural-galaxy';

  const cubeCamera = new THREE.CubeCamera(0.1, 10, target);
  cubeCamera.update(renderer, bakeScene);

  geometry.dispose();
  material.dispose();
  return target;
}
