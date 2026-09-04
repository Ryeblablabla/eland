import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import type {
  EraKey,
  SocietyState,
  SpeechLineView,
} from '@/game/societyContract';
import type { EmbodimentOptionView, EmbodimentTargetView } from '@/game/embodimentContract';
import { cellColor, cellCoordinates } from '@/game/pixelworld';
import {
  shorelinePatches,
  surfaceTransitionKind,
  surfaceTransitionPatches,
  type ShorelineNeighbors,
  type SurfaceTransitionDirection,
  type SurfaceTransitionKind,
  type SurfaceTransitionNeighbors,
} from '@/game/surfaceTransitions';
import {
  featureDepth,
  featureUnderlayMaterialId,
  WORLD_CELL_HEIGHT,
} from '@/game/voxelKits';
import type { EmbodimentMoveDirection } from './society-scene/EmbodimentCameraController';
import {
  createCameraRuntime,
  type SocietyCameraMode,
} from './society-scene/cameraRuntime';
import { createDecorLayer } from './society-scene/decorLayer';
import {
  createEnvironmentRuntime,
  type HumanSkySnapshot,
} from './society-scene/environmentRuntime';
import {
  createFigureLayer,
} from './society-scene/figureLayer';
import { speechLinesInPlaybackOrder } from './society-scene/speechPlayback';
import { createAmbientAudio } from './society-scene/ambientAudio';
import { weatherSwayStrength, weatherWetness } from '@/game/voxel-assets/decor-primitives';
import {
  sameSelectionVisuals,
  sameTerrainVisuals,
} from './society-scene/visualInvalidation';
import { visualSmoothNoise, visualSpatialHash } from './society-scene/visualNoise';

export type { HumanSkySnapshot } from './society-scene/environmentRuntime';
export type { SocietyCameraMode } from './society-scene/cameraRuntime';

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

interface Props {
  society: SocietyState;
  era: EraKey;
  speaker: string | null;
  /** Wall-clock time reserved for one authoritative month's visual playback. */
  monthPlaybackDurationMs?: number;
  speechLines?: readonly SpeechLineView[];
  sky?: HumanSkySnapshot;
  selectedAgentId?: string | null; // 旧页面编译兼容；沉浸式场景不启用点选 UI
  onSelectAgent?: (id: string | null) => void;
  selectedObject?: SocietySceneSelection;
  onSelectObject?: (selection: SocietySceneSelection) => void;
  onZoomOutRequest?: () => void; // 滚轮、键盘或双指持续缩小越过阈值 → 请求升起返回宇宙
  cameraMode?: SocietyCameraMode;
  embodimentTargets?: readonly EmbodimentTargetView[];
  previewEmbodimentOption?: EmbodimentOptionView | null;
  onEmbodimentMove?: (direction: EmbodimentMoveDirection) => void;
  onEmbodimentMoveHoldChange?: (direction: EmbodimentMoveDirection | null) => void;
  onEmbodimentTargetChange?: (target: EmbodimentTargetView | null) => void;
  onEmbodimentPointerLockChange?: (locked: boolean) => void;
  onEmbodimentCameraSettled?: () => void;
}

export type SocietySceneSelection =
  | { kind: 'agent'; id: string }
  | { kind: 'structure'; id: string }
  | null;

const CELL_H = WORLD_CELL_HEIGHT; // 每层体素的视觉高度（世界单位）
const DEFAULT_MONTH_PLAYBACK_MS = 3_000;
const TERRAIN_APRON_CELLS = 72; // 权威网格之外的纯视觉缓冲；不参与规则、寻路或选择
// Highest current human perception projection is eight cells; the half-cell
// margin accounts for the eye-to-proxy vertical offset at that boundary.
const EMBODIMENT_INTERACTION_DISTANCE = 8.5;

function embodimentTargetKey(target: EmbodimentTargetView): string {
  if (target.kind === 'person') return `person:${target.personId}`;
  if (target.kind === 'structure') return `structure:${target.structureId}`;
  if (target.kind === 'standing-position') return `standing:${target.cellId}:${target.z}`;
  if (target.kind === 'voxel') return `voxel:${target.cellId}:${target.z}`;
  if (target.kind === 'drop') return `drop:${target.dropId}`;
  if (target.kind === 'container') return `container:${target.containerId}`;
  if (target.kind === 'animal') return `animal:${target.animalId}`;
  return `remains:${target.remainsId}`;
}

export default function SocietyScene3D({
  society,
  era,
  speaker,
  monthPlaybackDurationMs = DEFAULT_MONTH_PLAYBACK_MS,
  speechLines,
  sky,
  selectedAgentId,
  onSelectAgent,
  selectedObject,
  onSelectObject,
  onZoomOutRequest,
  cameraMode = { kind: 'overview' },
  embodimentTargets = [],
  previewEmbodimentOption,
  onEmbodimentMove,
  onEmbodimentMoveHoldChange,
  onEmbodimentTargetChange,
  onEmbodimentPointerLockChange,
  onEmbodimentCameraSettled,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({
    society,
    era,
    speaker,
    monthPlaybackDurationMs,
    speechLines: speechLines ?? [],
    sky,
    selectedAgentId,
    onSelectAgent,
    selectedObject,
    onSelectObject,
    onZoomOutRequest,
    cameraMode,
    embodimentTargets,
    previewEmbodimentOption,
    onEmbodimentMove,
    onEmbodimentMoveHoldChange,
    onEmbodimentTargetChange,
    onEmbodimentPointerLockChange,
    onEmbodimentCameraSettled,
  });
  useEffect(() => {
    propsRef.current = {
      society,
      era,
      speaker,
      monthPlaybackDurationMs,
      speechLines: speechLines ?? [],
      sky,
      selectedAgentId,
      onSelectAgent,
      selectedObject,
      onSelectObject,
      onZoomOutRequest,
      cameraMode,
      embodimentTargets,
      previewEmbodimentOption,
      onEmbodimentMove,
      onEmbodimentMoveHoldChange,
      onEmbodimentTargetChange,
      onEmbodimentPointerLockChange,
      onEmbodimentCameraSettled,
    };
  });

  const animStart = useRef(0); // 挂载后由 effect 置为当前时间（渲染期不调非纯函数）
  useEffect(() => { animStart.current = performance.now(); }, [society]);

  // FigureLayer still consumes the original 3s animation clock. Scale only
  // its presentation timestamp so every visual layer follows the duration
  // chosen by the authoritative month buffer without rebuilding the scene.
  const playbackAnimationStartedAt = () => {
    const now = performance.now();
    const duration = Math.max(1, propsRef.current.monthPlaybackDurationMs);
    const elapsed = Math.max(0, now - animStart.current);
    return now - elapsed * DEFAULT_MONTH_PLAYBACK_MS / duration;
  };

  // 供主循环外调用的场景 API
  const terrainApiRef = useRef<((s: SocietyState) => void) | null>(null);
  const lightApiRef = useRef<((e: EraKey) => void) | null>(null);
  const eraDipApiRef = useRef<((now: number) => void) | null>(null);
  const decorApiRef = useRef<((s: SocietyState, e: EraKey) => void) | null>(null);
  const skyApiRef = useRef<((snapshot?: HumanSkySnapshot) => void) | null>(null);
  const selectionApiRef = useRef<((s: SocietyState) => void) | null>(null);
  const cameraModeApiRef = useRef<((s: SocietyState, mode: SocietyCameraMode) => void) | null>(null);
  const embodimentTargetsApiRef = useRef<((
    s: SocietyState,
    targets: readonly EmbodimentTargetView[],
    preview?: EmbodimentOptionView | null,
  ) => void) | null>(null);

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
    const cameraRuntime = createCameraRuntime({
      canvas,
      world: world0,
      cellHeight: CELL_H,
      readViewport: () => ({ width: mount.clientWidth, height: mount.clientHeight }),
      readFrame: () => {
        const current = propsRef.current;
        return {
          cameraMode: current.cameraMode,
          onZoomOutRequest: current.onZoomOutRequest,
          onEmbodimentMove: current.onEmbodimentMove,
          onEmbodimentMoveHoldChange: current.onEmbodimentMoveHoldChange,
          onEmbodimentTargetChange: current.onEmbodimentTargetChange,
          onEmbodimentPointerLockChange: current.onEmbodimentPointerLockChange,
          onEmbodimentCameraSettled: current.onEmbodimentCameraSettled,
        };
      },
    });
    const { camera } = cameraRuntime;
    cameraModeApiRef.current = cameraRuntime.setMode;

    // 非遮蔽体注册表：GTAO 计算期间临时隐藏（见 ScopedGTAOPass）
    const aoExcluded: THREE.Object3D[] = [];
    const environmentRuntime = createEnvironmentRuntime({
      scene,
      renderer,
      camera,
      world: world0,
      initialEra: propsRef.current.era,
      initialSky: propsRef.current.sky,
      terrainApronCells: TERRAIN_APRON_CELLS,
      aoExcluded,
      readFrame: () => ({
        society: propsRef.current.society,
        era: propsRef.current.era,
      }),
    });
    lightApiRef.current = environmentRuntime.setEra;
    eraDipApiRef.current = cameraRuntime.pulseEraDip;
    skyApiRef.current = environmentRuntime.setSky;
    // 调试探针（与 ThreeBodyCanvas 的 __tbPlanet 同款）：只读，供无头验证与 e2e。
    const dbgSociety = ((window as unknown as { __tbSociety?: Record<string, unknown> }).__tbSociety ??= {});
    const sun = environmentRuntime.sunlight;
    const fireLights = environmentRuntime.fireLights;

    // ---- 地形体素柱（InstancedMesh，逐实例颜色；PBR 材质）----
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const land = new THREE.InstancedMesh(
      boxGeo,
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.02 }),
      COUNT,
    );
    // 侧面分层：顶面保留权威地表色，侧面沉入更深的土层色并按体素层高（0.3）微条带。
    // 法线判别、无额外几何与 draw call；实例颜色仍全部来自 cellColor。
    const landStrataMat = land.material as THREE.MeshStandardMaterial;
    landStrataMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vStrataNy;\nvarying float vStrataY;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vStrataNy = normal.y;
          vec4 strataWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          strataWorld = instanceMatrix * strataWorld;
          #endif
          vStrataY = (modelMatrix * strataWorld).y;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vStrataNy;\nvarying float vStrataY;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float strataSide = 1.0 - smoothstep(0.55, 0.75, abs(vStrataNy));
          float strataBand = 0.93 + 0.07 * step(0.5, fract(vStrataY * 3.333));
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.66, 0.57, 0.48) * strataBand, strataSide);`);
    };
    landStrataMat.customProgramCacheKey = () => 'terrain-strata-v1';
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
    // 地表颗粒微风：实例原点哈希相位做水平微位移，幅度随权威天气强度；与树冠摆动同向。
    const groundSwayUniforms = { uTime: { value: 0 }, uWind: { value: 0.2 } };
    const groundSwayMat = groundDetail.material as THREE.MeshStandardMaterial;
    groundSwayMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = groundSwayUniforms.uTime;
      shader.uniforms.uWind = groundSwayUniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
          vec4 swayOrigin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float swayPhase = swayOrigin.x * 1.83 + swayOrigin.z * 2.37;
          transformed.x += sin(uTime * (1.6 + uWind * 2.4) + swayPhase) * uWind * 0.02;
          transformed.z += cos(uTime * (1.3 + uWind * 2.0) + swayPhase * 1.21) * uWind * 0.016;
          #endif`);
    };
    groundSwayMat.customProgramCacheKey = () => 'ground-sway-v1';
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

    const waterFlowUniforms = { uTime: { value: 0 }, uRain: { value: 0 }, uSunGlint: { value: 0 } };
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
          uniform float uSunGlint;
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
            // 高频碎波：近景读出细密涌动，远观融为整体流向。
            float ripple = 0.5 + 0.5 * sin(along * 13.4 - time * 3.05 + sin(across * 9.2) * 1.35);
            float flow = smoothstep(0.34, 0.92, mainBand) * (0.66 + crossBand * 0.26 + ripple * 0.14);
            vec3 flowColor = mix(vec3(0.13, 0.37, 0.43), vec3(0.33, 0.6, 0.64), flow);
            // 波峰线提亮：近白色只落在主波峰上，强化"正在流动"的读感。
            float crest = smoothstep(0.82, 0.985, mainBand * (0.72 + crossBand * 0.28));
            flowColor = mix(flowColor, vec3(0.66, 0.82, 0.84), crest * 0.42);
            // 日光碎金：波峰镜面闪烁，夜间与阴雨自动退场。
            float glint = smoothstep(0.93, 1.0, mainBand * ripple) * uSunGlint;
            flowColor += vec3(1.0, 0.93, 0.78) * glint * 0.85;
            // 没有相邻水格的一侧是真实河岸。流纹在岸边两微格内退去，
            // 避免透明高光盖到湿土/湿沙的岸缘台阶上。
            float bankDistance = 1.0;
            if (vFlowNeighbors.x < 0.5) bankDistance = min(bankDistance, vFlowLocal.y);
            if (vFlowNeighbors.y < 0.5) bankDistance = min(bankDistance, 1.0 - vFlowLocal.x);
            if (vFlowNeighbors.z < 0.5) bankDistance = min(bankDistance, 1.0 - vFlowLocal.y);
            if (vFlowNeighbors.w < 0.5) bankDistance = min(bankDistance, vFlowLocal.x);
            float bankFade = smoothstep(0.2, 0.36, bankDistance);
            // 岸缘泡沫：紧贴岸线内侧一圈缓慢脉动的白沫。
            float foamRing = smoothstep(0.16, 0.27, bankDistance) * (1.0 - smoothstep(0.3, 0.46, bankDistance));
            float foam = foamRing * (0.5 + 0.3 * sin(time * 1.1 + along * 8.6) * sin(across * 10.4 - time * 0.7));
            flowColor = mix(flowColor, vec3(0.8, 0.88, 0.88), clamp(foam, 0.0, 1.0) * 0.55);
            float alpha = (0.02 + flow * (0.105 + uRain * 0.03) + crest * 0.03 + glint * 0.1) * bankFade
              + foam * 0.085;
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

    // 天气粒子保持在水面之后加入场景；环境层只借用两项水面表现 uniform。
    environmentRuntime.attachWeatherProjection({
      rain: waterFlowUniforms.uRain,
      sunGlint: waterFlowUniforms.uSunGlint,
    });
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
    const col = new THREE.Color();
    const structureSelectionGroup = new THREE.Group();
    structureSelectionGroup.name = 'structure-selection-proxies';
    scene.add(structureSelectionGroup);

    // 化身准星只命中服务端投影过的目标。体素/掉落物目标用不可见代理表达，
    // 代理仅用于呈现选择，不参与规则合法性、碰撞或世界修改。
    const embodimentTargetGroup = new THREE.Group();
    embodimentTargetGroup.name = 'embodiment-target-proxies';
    scene.add(embodimentTargetGroup);
    aoExcluded.push(structureSelectionGroup, embodimentTargetGroup);
    const embodimentTargetGeometry = new THREE.BoxGeometry(1, 1, 1);
    const embodimentTargetMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    embodimentTargetMaterial.colorWrite = false;
    const embodimentTargetByKey = new Map<string, EmbodimentTargetView>();
    const embodimentPersonTargetById = new Map<string, EmbodimentTargetView>();
    const embodimentStructureTargetById = new Map<string, EmbodimentTargetView>();
    const embodimentProxyByKey = new Map<string, THREE.Mesh>();
    const embodimentPreviewMaterial = new THREE.MeshBasicMaterial({
      color: '#6fd2a1',
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    const embodimentPreview = new THREE.Mesh(
      new THREE.BoxGeometry(0.94, CELL_H * 0.94, 0.94),
      embodimentPreviewMaterial,
    );
    embodimentPreview.name = 'embodiment-build-preview';
    embodimentPreview.visible = false;
    embodimentPreview.renderOrder = 40;
    scene.add(embodimentPreview);
    aoExcluded.push(embodimentPreview);

    embodimentTargetsApiRef.current = (s, targets, preview) => {
      embodimentTargetByKey.clear();
      embodimentPersonTargetById.clear();
      embodimentStructureTargetById.clear();
      const visibleProxyKeys = new Set<string>();
      for (const target of targets) {
        const key = embodimentTargetKey(target);
        if (embodimentTargetByKey.has(key)) continue;
        embodimentTargetByKey.set(key, target);
        if (target.kind === 'person') {
          embodimentPersonTargetById.set(target.personId, target);
          continue;
        }
        if (target.kind === 'structure') {
          embodimentStructureTargetById.set(target.structureId, target);
          continue;
        }
        if (target.kind === 'standing-position') continue;
        visibleProxyKeys.add(key);
        const x = target.cellId % s.world.width;
        const y = Math.floor(target.cellId / s.world.width);
        let proxy = embodimentProxyByKey.get(key);
        if (!proxy) {
          proxy = new THREE.Mesh(embodimentTargetGeometry, embodimentTargetMaterial);
          proxy.userData.embodimentTargetKey = key;
          embodimentProxyByKey.set(key, proxy);
          embodimentTargetGroup.add(proxy);
        }
        proxy.position.set(
          x - s.world.width / 2 + 0.5,
          target.z * CELL_H + CELL_H * 0.5,
          y - s.world.height / 2 + 0.5,
        );
        if (target.kind === 'voxel') proxy.scale.set(0.94, CELL_H * 0.94, 0.94);
        else proxy.scale.set(0.62, 0.52, 0.62);
      }
      for (const [key, proxy] of embodimentProxyByKey) {
        if (visibleProxyKeys.has(key)) continue;
        embodimentTargetGroup.remove(proxy);
        embodimentProxyByKey.delete(key);
      }

      const previewTarget = preview?.category === 'build' && preview.target?.kind === 'voxel'
        ? preview.target
        : null;
      embodimentPreview.visible = Boolean(previewTarget);
      if (previewTarget) {
        const x = previewTarget.cellId % s.world.width;
        const y = Math.floor(previewTarget.cellId / s.world.width);
        embodimentPreview.position.set(
          x - s.world.width / 2 + 0.5,
          previewTarget.z * CELL_H + CELL_H * 0.5,
          y - s.world.height / 2 + 0.5,
        );
        const materialId = previewTarget.materialId ?? preview?.materialCost?.[0]?.materialId;
        const materialColor = materialId === undefined ? undefined : s.world.palette[materialId]?.color;
        if (materialColor) {
          embodimentPreviewMaterial.color.setRGB(
            materialColor[0] / 255,
            materialColor[1] / 255,
            materialColor[2] / 255,
            THREE.SRGBColorSpace,
          );
        } else {
          embodimentPreviewMaterial.color.set('#6fd2a1');
        }
      }
    };

    const structureSelectionMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    structureSelectionMaterial.colorWrite = false;
    const structureSelectionById = new Map<string, { mesh: THREE.Mesh; signature: string }>();
    let renderedSelectionSociety: SocietyState | null = null;

    selectionApiRef.current = (s) => {
      if (renderedSelectionSociety && sameSelectionVisuals(renderedSelectionSociety, s)) {
        renderedSelectionSociety = s;
        return;
      }
      renderedSelectionSociety = s;
      const w = s.world;
      const visibleStructureIds = new Set<string>();
      for (const structure of s.structures) {
        if (structure.occupiedCells.length === 0) continue;
        visibleStructureIds.add(structure.id);
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
        const signature = `${minX}:${maxX}:${minZ}:${maxZ}:${height}`;
        let entry = structureSelectionById.get(structure.id);
        if (!entry) {
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(maxX - minX + 1, height, maxZ - minZ + 1),
            structureSelectionMaterial,
          );
          mesh.userData.structureId = structure.id;
          entry = { mesh, signature };
          structureSelectionById.set(structure.id, entry);
          structureSelectionGroup.add(mesh);
        } else if (entry.signature !== signature) {
          entry.mesh.geometry.dispose();
          entry.mesh.geometry = new THREE.BoxGeometry(maxX - minX + 1, height, maxZ - minZ + 1);
          entry.signature = signature;
        }
        const proxy = entry.mesh;
        proxy.position.set(
          (minX + maxX) / 2 - w.width / 2 + 0.5,
          height / 2,
          (minZ + maxZ) / 2 - w.height / 2 + 0.5,
        );
      }
      for (const [structureId, entry] of structureSelectionById) {
        if (visibleStructureIds.has(structureId)) continue;
        structureSelectionGroup.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        structureSelectionById.delete(structureId);
      }
    };

    let renderedTerrainSociety: SocietyState | null = null;
    terrainApiRef.current = (s) => {
      if (renderedTerrainSociety && sameTerrainVisuals(renderedTerrainSociety, s)) {
        renderedTerrainSociety = s;
        return;
      }
      renderedTerrainSociety = s;
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

    // ---- 装饰层：权威装饰实例批次 / 时代淡入淡出 / 动物与火焰动画 ----
    const decorLayer = createDecorLayer({
      scene,
      camera,
      sunlight: sun,
      fireLights,
      boxGeometry: boxGeo,
      cellHeight: CELL_H,
      monthPlaybackMs: DEFAULT_MONTH_PLAYBACK_MS,
      readFrame: () => ({
        society: propsRef.current.society,
        animationStartedAt: playbackAnimationStartedAt(),
      }),
    });
    decorApiRef.current = decorLayer.sync;

    // 环境音景：程序化风/雨/火声，跟随权威天气、纪元与近处火光；不写入任何状态。
    // 浏览器自动播放策略要求首次用户手势后才允许出声。
    const ambientAudio = createAmbientAudio();
    const resumeAmbientAudio = () => ambientAudio.resume();
    canvas.addEventListener('pointerdown', resumeAmbientAudio);
    window.addEventListener('keydown', resumeAmbientAudio);

    // ---- 人物：按需创建 / 更新 / 回收 ----
    const figureLayer = createFigureLayer({
      scene,
      camera,
      aoExcluded,
      cellHeight: CELL_H,
      readViewport: () => ({ width: mount.clientWidth, height: mount.clientHeight }),
      readFrame: () => {
        const current = propsRef.current;
        return {
          society: current.society,
          embodiedAgentId: current.cameraMode.kind === 'embodiment'
            ? current.cameraMode.agentId
            : null,
          speechLines: current.speechLines,
          speaker: current.speaker,
          selectedAgentId: current.selectedAgentId,
          selectedObject: current.selectedObject,
          animationStartedAt: playbackAnimationStartedAt(),
        };
      },
    });

    // ---- 点选人物 / 权威结构；拖拽镜头不会触发选择，点击空白收起信息 ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let selectionPointerDown: { x: number; y: number } | null = null;
    // 人物聚焦近景：点击人物镜头平滑降镜；点空白、Esc 或拖拽镜头解除。
    let focusAgentId: string | null = null;
    const focusScratch = new THREE.Vector3();
    const probeScratch = new THREE.Vector3();
    let probeAgentsAt = 0;
    const emitSelection = (selection: SocietySceneSelection) => {
      const p = propsRef.current;
      focusAgentId = selection?.kind === 'agent' ? selection.id : null;
      if (!focusAgentId) cameraRuntime.setOverviewFocus(null);
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
      if (propsRef.current.cameraMode.kind === 'embodiment') {
        selectionPointerDown = null;
        return;
      }
      selectionPointerDown = { x: event.clientX, y: event.clientY };
    };
    const onSelectionPointerUp = (event: PointerEvent) => {
      if (propsRef.current.cameraMode.kind === 'embodiment') {
        selectionPointerDown = null;
        return;
      }
      if (event.pointerType === 'touch' && cameraRuntime.consumeSelectionTapSuppression(event.pointerId)) {
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
      const figureHit = figureLayer.intersect(raycaster);
      if (figureHit) {
        emitSelection(selectionFromHit(figureHit.object));
        return;
      }
      const structureHits = raycaster.intersectObjects(structureSelectionGroup.children, true);
      emitSelection(structureHits.length ? selectionFromHit(structureHits[0].object) : null);
    };

    const reticlePointer = new THREE.Vector2(0, 0);
    const embodimentRaycaster = new THREE.Raycaster();
    embodimentRaycaster.far = EMBODIMENT_INTERACTION_DISTANCE;
    let emittedEmbodimentTargetFingerprint = '';
    const emitEmbodimentTarget = (target: EmbodimentTargetView | null) => {
      const fingerprint = target ? JSON.stringify(target) : '';
      if (fingerprint === emittedEmbodimentTargetFingerprint) return;
      emittedEmbodimentTargetFingerprint = fingerprint;
      propsRef.current.onEmbodimentTargetChange?.(target);
    };
    const targetFromEmbodimentHit = (object: THREE.Object3D): EmbodimentTargetView | null => {
      let current: THREE.Object3D | null = object;
      while (current && current !== scene) {
        const targetKey = current.userData.embodimentTargetKey;
        if (typeof targetKey === 'string') return embodimentTargetByKey.get(targetKey) ?? null;
        const agentId = current.userData.agentId;
        if (typeof agentId === 'string') return embodimentPersonTargetById.get(agentId) ?? null;
        const structureId = current.userData.structureId;
        if (typeof structureId === 'string') return embodimentStructureTargetById.get(structureId) ?? null;
        current = current.parent;
      }
      return null;
    };
    const reticleCandidates: THREE.Object3D[] = [];
    let nextReticleUpdateAt = 0;
    let lastReticleHitAt = Number.NEGATIVE_INFINITY;
    const updateEmbodimentReticle = (now: number) => {
      if (!cameraRuntime.isEmbodimentActive()) {
        nextReticleUpdateAt = 0;
        lastReticleHitAt = Number.NEGATIVE_INFINITY;
        emitEmbodimentTarget(null);
        return;
      }
      if (now < nextReticleUpdateAt) return;
      nextReticleUpdateAt = now + 1_000 / 30;
      reticleCandidates.length = 0;
      for (const [agentId] of embodimentPersonTargetById) {
        const pickProxy = figureLayer.visiblePickProxy(agentId);
        if (pickProxy) reticleCandidates.push(pickProxy);
      }
      for (const child of structureSelectionGroup.children) {
        if (typeof child.userData.structureId === 'string'
          && embodimentStructureTargetById.has(child.userData.structureId)) reticleCandidates.push(child);
      }
      reticleCandidates.push(...embodimentTargetGroup.children);
      if (!reticleCandidates.length) {
        lastReticleHitAt = Number.NEGATIVE_INFINITY;
        emitEmbodimentTarget(null);
        return;
      }
      camera.updateMatrixWorld();
      for (const candidate of reticleCandidates) candidate.updateWorldMatrix(true, false);
      embodimentRaycaster.setFromCamera(reticlePointer, camera);
      const hits = embodimentRaycaster.intersectObjects(reticleCandidates, false);
      for (const hit of hits) {
        const target = targetFromEmbodimentHit(hit.object);
        if (target) {
          lastReticleHitAt = now;
          emitEmbodimentTarget(target);
          return;
        }
      }
      // A short grace period prevents action prompts flickering while the
      // crosshair passes over voxel edges or a walking figure's thin limbs.
      if (now - lastReticleHitAt >= 110) emitEmbodimentTarget(null);
    };

    cameraRuntime.attachInput({
      onSelectionGestureCancel: () => { selectionPointerDown = null; },
    });
    cameraRuntime.setOverviewInteractionListener((active) => {
      // 用户拖拽/缩放镜头时解除人物聚焦，把控制权完整交还。
      if (active && focusAgentId) {
        focusAgentId = null;
        cameraRuntime.setOverviewFocus(null);
      }
    });
    const onEscapeKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || propsRef.current.cameraMode.kind === 'embodiment') return;
      if (focusAgentId) emitSelection(null);
    };
    window.addEventListener('keydown', onEscapeKey);
    canvas.addEventListener('pointerdown', onSelectionPointerDown);
    canvas.addEventListener('pointerup', onSelectionPointerUp);

    // ---- 后处理管线：Render → 轻量 GTAO → 自适应移轴 → ACES 输出 → FXAA ----
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera)); // 先渲染 beauty（GTAO 在 readBuffer 上合成 AO）
    const gtaoPass = new ScopedGTAOPass(scene, camera, 1, 1);
    gtaoPass.updateGtaoMaterial({
      radius: 0.18, // 覆盖约 1.5 个微体素棱，让贴地接触处真正暗下来
      distanceExponent: 1,
      thickness: 0.12,
      scale: 1,
      samples: 12,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
    gtaoPass.blendIntensity = 0.7;
    gtaoPass.excluded = aoExcluded;
    composer.addPass(gtaoPass);
    const tiltShiftPass = new ShaderPass(AdaptiveTiltShiftShader);
    composer.addPass(tiltShiftPass);
    composer.addPass(new OutputPass());
    const fxaaPass = new ShaderPass(FXAAShader);
    composer.addPass(fxaaPass);

    // 交互时优先保证镜头跟手；松手后恢复环境遮蔽和景深表现。
    cameraRuntime.setOverviewInteractionListener((active, embodimentActive) => {
      gtaoPass.enabled = !active && !embodimentActive;
      tiltShiftPass.enabled = !active && !embodimentActive;
    });

    const tiltFocusWorld = new THREE.Vector3();
    const tiltFocusProjected = new THREE.Vector3();
    let tiltFocusY = 0.5;
    let tiltStrength = 0;
    let tiltBand = 0.2;
    let tiltBlurCssPixels = 0;
    const updateTiltShift = (deltaSeconds: number, entryT: number) => {
      const selection = propsRef.current.selectedObject;
      let hasSubject = false;

      if (selection?.kind === 'agent') {
        if (figureLayer.writeWorldPosition(selection.id, tiltFocusWorld)) {
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
      if (!hasSubject) hasSubject = figureLayer.writeSpeechFocus(tiltFocusWorld);

      if (!hasSubject) cameraRuntime.copyOverviewTarget(tiltFocusWorld);
      camera.updateMatrixWorld();
      tiltFocusProjected.copy(tiltFocusWorld).project(camera);
      const desiredFocusY = THREE.MathUtils.clamp(tiltFocusProjected.y * 0.5 + 0.5, 0.18, 0.82);
      tiltFocusY = THREE.MathUtils.damp(tiltFocusY, desiredFocusY, 8, deltaSeconds);

      const distanceRatio = cameraRuntime.overviewDistanceRatio();
      const overviewMix = THREE.MathUtils.smoothstep(distanceRatio, 0.18, 1.05);
      const transitionVisibility = cameraRuntime.isZoomOutTransitionRequested()
        ? 0
        : THREE.MathUtils.smoothstep(entryT, 0.5, 1);
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
      const maxPixelRatio = cameraRuntime.pixelRatioCap();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
      renderer.setSize(wpx, hpx, false);
      cameraRuntime.resizeCamera(wpx, hpx);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(wpx, hpx); // 内部会把 GTAO 等 Pass 按 pixelRatio 换算
      const pr = renderer.getPixelRatio();
      tiltShiftPass.uniforms.uResolution.value.set(wpx * pr, hpx * pr);
      fxaaPass.material.uniforms.resolution.value.set(1 / (wpx * pr), 1 / (hpx * pr));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();
    let resizedForEmbodiment = cameraRuntime.isEmbodimentActive();

    // ---- 主循环 ----
    let raf = 0;
    let previousFrameAt = performance.now();
    let terrainWetness = 0;
    const tick = () => {
      raf = 0;
      if (document.hidden) return;
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const deltaSeconds = Math.min(0.05, Math.max(0, (now - previousFrameAt) / 1_000));
      previousFrameAt = now;
      figureLayer.sync(now);
      decorLayer.animate(now);
      // 环境音景跟随权威天气、纪元与近处火光（火光池本月刚重绑过）。
      const audioProps = propsRef.current;
      ambientAudio.update({
        weatherKind: audioProps.society.weather?.kind ?? 'clear',
        weatherIntensity: audioProps.society.weather?.intensity ?? 0,
        eraChaotic: audioProps.era !== 'stable',
        fireLevel: decorLayer.fireGlowLevel(),
      });
      waterFlowUniforms.uTime.value = now * 0.001;
      environmentRuntime.updateBeforeCamera(now, deltaSeconds);
      waterMat.roughness = 0.21 + 0.01 * Math.sin(now * 0.0016);
      waterMat.clearcoat = 0.42 + 0.025 * Math.sin(now * 0.0019 + 0.8);
      // 水面昼夜响应：夜里退成映星光的暗镜面，不再是霓虹河。
      const waterDaylight = THREE.MathUtils.clamp(sun.intensity / 1.9, 0, 1);
      waterMat.emissiveIntensity = 0.02 + 0.14 * waterDaylight;
      waterSideMat.opacity = 0.58 + 0.18 * waterDaylight;
      // 地表颗粒微风相位推进：风暴 > 雨 > 旱 > 雪 > 晴，乱纪元另加成。
      groundSwayUniforms.uTime.value = now * 0.001;
      groundSwayUniforms.uWind.value = weatherSwayStrength(audioProps.society.weather)
        + (audioProps.era !== 'stable' ? 0.12 : 0);
      // 地形湿润：雨/风暴时地表变深变润，与装饰层材质同源同步。
      terrainWetness += (weatherWetness(audioProps.society.weather) - terrainWetness)
        * (1 - Math.exp(-2.2 * deltaSeconds));
      landStrataMat.roughness = 0.92 * (1 - terrainWetness * 0.38);
      landStrataMat.envMapIntensity = 1 + terrainWetness * 0.55;
      decorLayer.updateTransition(now);
      const embodimentActive = cameraRuntime.isEmbodimentActive();
      if (resizedForEmbodiment !== embodimentActive) {
        resizedForEmbodiment = embodimentActive;
        resize();
      }
      // 人物聚焦：跟随人物当前世界坐标持续降镜；人物离开画面（死亡/安葬）自动解除。
      if (focusAgentId) {
        if (figureLayer.writeWorldPosition(focusAgentId, focusScratch)) {
          cameraRuntime.setOverviewFocus(focusScratch);
        } else {
          focusAgentId = null;
          cameraRuntime.setOverviewFocus(null);
        }
      }
      dbgSociety.focusAgentId = focusAgentId;
      dbgSociety.cameraDistance = camera.position.distanceTo(cameraRuntime.copyOverviewTarget(probeScratch));
      // 每 400ms 暴露一个可点击人物点的屏幕坐标（与 __tbPlanet 同款的 e2e/无头验证钩子）。
      if (now - probeAgentsAt > 400) {
        probeAgentsAt = now;
        const agent = propsRef.current.society.agents.find((a) => a.bodyDisposition !== 'interred');
        if (agent && figureLayer.writeWorldPosition(agent.id, probeScratch)) {
          probeScratch.project(camera);
          dbgSociety.agentScreenPoint = probeScratch.z < 1 ? {
            x: (probeScratch.x * 0.5 + 0.5) * window.innerWidth,
            y: (-probeScratch.y * 0.5 + 0.5) * window.innerHeight,
          } : null;
        } else {
          dbgSociety.agentScreenPoint = null;
        }
      }
      const cameraFrame = cameraRuntime.update(now, deltaSeconds);
      if (cameraFrame.embodimentActive) {
        gtaoPass.enabled = false;
        tiltShiftPass.enabled = false;
      } else {
        gtaoPass.enabled = !cameraFrame.overviewControlsActive;
        tiltShiftPass.enabled = !cameraFrame.overviewControlsActive;
        updateTiltShift(deltaSeconds, cameraFrame.entryProgress);
        // 近景/聚焦时 GTAO 升采样：接触阴影更细腻；远景保持半分辨率。
        const gtaoScale = focusAgentId || cameraRuntime.overviewDistanceRatio() < 0.35 ? 0.75 : 0.5;
        if (gtaoPass.resolutionScale !== gtaoScale) {
          gtaoPass.resolutionScale = gtaoScale;
          resize();
        }
      }
      updateEmbodimentReticle(now);
      figureLayer.layoutSpeechBubbles();
      environmentRuntime.updateAfterCamera(deltaSeconds);
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
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onSelectionPointerDown);
      canvas.removeEventListener('pointerup', onSelectionPointerUp);
      canvas.removeEventListener('pointerdown', resumeAmbientAudio);
      window.removeEventListener('keydown', resumeAmbientAudio);
      window.removeEventListener('keydown', onEscapeKey);
      ambientAudio.dispose();
      cameraRuntime.dispose();
      terrainApiRef.current = null;
      lightApiRef.current = null;
      decorApiRef.current = null;
      skyApiRef.current = null;
      selectionApiRef.current = null;
      cameraModeApiRef.current = null;
      embodimentTargetsApiRef.current = null;
      decorLayer.dispose();
      figureLayer.dispose();
      for (const entry of structureSelectionById.values()) entry.mesh.geometry.dispose();
      structureSelectionById.clear();
      structureSelectionGroup.clear();
      structureSelectionMaterial.dispose();
      embodimentProxyByKey.clear();
      embodimentTargetGroup.clear();
      embodimentTargetGeometry.dispose();
      embodimentTargetMaterial.dispose();
      environmentRuntime.dispose();
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
  const previousEraRef = useRef(era);
  useEffect(() => {
    lightApiRef.current?.(era);
    // 纪元真实切换：除天空/地面光色变外，镜头做一次短暂下压抬视野，让"三日凌空"可被看见。
    if (previousEraRef.current !== era) {
      previousEraRef.current = era;
      eraDipApiRef.current?.(performance.now());
    }
  }, [era]);
  useEffect(() => { decorApiRef.current?.(society, era); }, [society, era]);
  useEffect(() => { skyApiRef.current?.(sky); }, [sky]);
  useEffect(() => { selectionApiRef.current?.(society); }, [society]);
  useEffect(() => { cameraModeApiRef.current?.(society, cameraMode); }, [cameraMode, society]);
  useEffect(() => {
    embodimentTargetsApiRef.current?.(society, embodimentTargets, previewEmbodimentOption);
  }, [embodimentTargets, previewEmbodimentOption, society]);

  return (
    <div ref={mountRef} className="absolute inset-0 z-[5] overflow-hidden bg-[#0b1016]">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label={cameraMode.kind === 'embodiment'
          ? '人物化身视角：点击捕获视角，WASD 请求移动，Escape 释放鼠标'
          : '人间场景：点击人物或结构查看信息，WASD 移动镜头，方向键或双指上下缩放'}
        className={`absolute inset-0 h-full w-full ${cameraMode.kind === 'embodiment' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
        style={{ touchAction: 'none' }}
      />
      <div className="sr-only" aria-atomic="true" aria-live="polite" aria-relevant="additions text">
        {speechLinesInPlaybackOrder(speechLines ?? []).map((line) => (
          <span className="block" key={line.id}>
            {line.speakerName}
            说：{line.text}
            {line.perceivedByPersonNames.length ? `；${line.perceivedByPersonNames.join('、')}感知到了` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
