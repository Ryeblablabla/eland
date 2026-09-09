import { Material, type MeshStandardMaterial } from 'three';

/** Static shader settings; no textures, extra attributes, frame uniforms or geometry changes. */
export const DECOR_MATERIAL_FINISH_DISTANCE = { full: 14, faded: 52 } as const;

type FinishBucket = 'leaf' | 'wood' | 'organicDark' | 'thatch' | 'stone' | 'roofTile';
type CompileHook = MeshStandardMaterial['onBeforeCompile'];
type CacheKeyHook = MeshStandardMaterial['customProgramCacheKey'];

interface FinishInstallation {
  bucket: FinishBucket;
  beforeCompile: CompileHook;
  beforeCacheKey: CacheKeyHook;
  compile: CompileHook;
  cacheKey: CacheKeyHook;
}

const installed = new WeakMap<MeshStandardMaterial, FinishInstallation>();
const MARKER = '// eland-decor-material-finish-v1';

const FINISH_FRAGMENT: Record<FinishBucket, string> = {
  // Leaf clusters already contain deliberate voxel colors. Keep their surfaces quiet and matte.
  leaf: 'roughnessFactor = min(1.0, roughnessFactor + 0.045);',
  wood: /* glsl */`
    float finishGrain = elandFinishWave(finishP.x * 42.0 + finishP.z * 17.0 + finishP.y * 2.3 + finishSeed);
    diffuseColor.rgb *= 1.0 + finishGrain * finishFade * 0.060;
    roughnessFactor = clamp(roughnessFactor + (0.015 + finishGrain * 0.025) * finishFade, 0.04, 1.0);
  `,
  organicDark: /* glsl */`
    float finishGrain = elandFinishWave(finishP.x * 34.0 + finishP.z * 13.0 + finishP.y * 1.7 + finishSeed);
    diffuseColor.rgb *= 1.0 + finishGrain * finishFade * 0.030;
    roughnessFactor = clamp(roughnessFactor + (0.018 + finishGrain * 0.014) * finishFade, 0.04, 1.0);
  `,
  thatch: /* glsl */`
    float finishLayer = elandFinishWave(finishP.y * 27.0 + finishP.z * 7.0 + finishSeed);
    diffuseColor.rgb *= 1.0 + finishLayer * finishFade * 0.050;
    roughnessFactor = min(1.0, roughnessFactor + (0.022 - abs(finishLayer) * 0.015) * finishFade);
  `,
  stone: /* glsl */`
    float finishMottle = elandFinishWave(dot(finishP, vec3(16.0, 9.0, 11.0)) + finishSeed)
      * elandFinishWave(dot(finishP, vec3(-7.0, 13.0, 19.0)) - finishSeed * 0.63);
    diffuseColor.rgb *= 1.0 + finishMottle * finishFade * 0.030;
    roughnessFactor = clamp(roughnessFactor + finishMottle * finishFade * 0.032, 0.04, 1.0);
  `,
  roofTile: /* glsl */`
    float finishSurface = elandFinishWave(dot(finishP, vec3(11.0, 6.0, 17.0)) + finishSeed) * 0.6
      + elandFinishWave(finishP.y * 23.0 + finishSeed * 0.37) * 0.4;
    diffuseColor.rgb *= 1.0 + finishSurface * finishFade * 0.045;
    roughnessFactor = clamp(roughnessFactor + finishSurface * finishFade * 0.055, 0.04, 1.0);
  `,
};

const FINISH_PARS = /* glsl */`
  varying vec4 vElandFinishCoord;
  float elandFinishWave(float phase) {
    // Suppress frequencies approaching a few pixels per cycle before they can shimmer.
    float coverage = 1.0 - smoothstep(0.55, 2.2, fwidth(phase));
    return sin(phase) * coverage;
  }
`;

function finishVertex(bucket: FinishBucket): string {
  const followsGrain = bucket === 'wood' || bucket === 'organicDark';
  return /* glsl */`
    vec3 finishSize = vec3(1.0);
    #ifdef USE_INSTANCING
      finishSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    #endif
    vec3 finishCoord = transformed * finishSize;
    ${followsGrain ? /* glsl */`
      // Elongated timber follows its longest box axis. Cubic voxels keep their original Y axis.
      if (finishSize.x > finishSize.y && finishSize.x >= finishSize.z) finishCoord = finishCoord.yxz;
      else if (finishSize.z > finishSize.y && finishSize.z > finishSize.x) finishCoord = finishCoord.xzy;
    ` : ''}
    vElandFinishCoord = vec4(finishCoord, 0.0);
    #ifdef USE_INSTANCING_COLOR
      // Existing instance colors provide a stable phase; moving transforms never reseed it.
      vElandFinishCoord.w = dot(instanceColor, vec3(17.13, 31.71, 47.91));
    #endif
  `;
}

/**
 * Install once after any existing material hooks, before the first render.
 * Reapply to each material.clone(): Three's Material.copy does not copy shader callbacks.
 * Standard/Physical WebGL materials retain their palette, opacity, normals and wetness uniform;
 * this finish only modulates diffuse brightness and the computed roughness factor.
 */
export function installDecorMaterialFinish(material: MeshStandardMaterial, bucket: string): void {
  if (!Object.prototype.hasOwnProperty.call(FINISH_FRAGMENT, bucket)) return;
  const finishBucket = bucket as FinishBucket;
  const previous = installed.get(material);
  if (previous?.bucket === finishBucket
    && material.onBeforeCompile === previous.compile && material.customProgramCacheKey === previous.cacheKey) return;

  const beforeCompile = previous && material.onBeforeCompile === previous.compile
    ? previous.beforeCompile : material.onBeforeCompile;
  const beforeCacheKey = previous && material.customProgramCacheKey === previous.cacheKey
    ? previous.beforeCacheKey : material.customProgramCacheKey;
  const hasPattern = finishBucket !== 'leaf';
  const compile: CompileHook = function (this: MeshStandardMaterial, shader, renderer) {
    beforeCompile.call(this, shader, renderer);
    if (shader.fragmentShader.includes(MARKER)) return;
    // Preserve any prior hook's material customization, injecting after roughness has been read.
    const materialAnchor = '#include <metalnessmap_fragment>';
    if (!shader.fragmentShader.includes(materialAnchor)) return;
    if (hasPattern) {
      if (!shader.vertexShader.includes('#include <project_vertex>')
        || !shader.vertexShader.includes('#include <common>')
        || !shader.fragmentShader.includes('#include <common>')) return;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vElandFinishCoord;')
        .replace('#include <project_vertex>', `#include <project_vertex>\n{\n${finishVertex(finishBucket)}\n}`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FINISH_PARS}`);
    }
    const { full, faded } = DECOR_MATERIAL_FINISH_DISTANCE;
    const setup = hasPattern ? /* glsl */`
      vec3 finishP = vElandFinishCoord.xyz;
      float finishSeed = vElandFinishCoord.w;
      float finishFade = 1.0 - smoothstep(${(full * full).toFixed(1)}, ${(faded * faded).toFixed(1)}, dot(vViewPosition, vViewPosition));
    ` : '';
    shader.fragmentShader = shader.fragmentShader.replace(materialAnchor,
      `${MARKER}\n{\n${setup}\n${FINISH_FRAGMENT[finishBucket]}\n}\n${materialAnchor}`);
  };
  const cacheKey: CacheKeyHook = function (this: MeshStandardMaterial) {
    // The default key reads this.onBeforeCompile, so preserve the original hook explicitly.
    const inherited = beforeCacheKey === Material.prototype.customProgramCacheKey
      ? beforeCompile.toString() : beforeCacheKey.call(this);
    return `${inherited}|eland-decor-finish-v1:${finishBucket}`;
  };
  material.onBeforeCompile = compile;
  material.customProgramCacheKey = cacheKey;
  installed.set(material, { bucket: finishBucket, beforeCompile, beforeCacheKey, compile, cacheKey });
  material.needsUpdate = true;
}
