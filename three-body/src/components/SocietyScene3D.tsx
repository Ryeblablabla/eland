import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import type { ActionVisualView, EraKey, IntentView, SocietyAgent, SocietyState } from '@/game/societyContract';
import { Material } from '@/game/eland/domain/material';
import { cellColor, cellCoordinates, interpolatePath } from '@/game/pixelworld';
import { makeStarSurfaceTexture } from '@/game/proceduralTextures';
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
 * 立体沙盘：演化页的 2.5D/3D 视图。
 * - 地形：每格一根体素柱（InstancedMesh），高度 = world.elevation，颜色 = cellColor
 * - 水面：独立半透明体素层 + 1/8 格像素流纹，方向来自真实水格邻接
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
  sky?: HumanSkySnapshot;
  selectedAgentId?: string | null; // 旧页面编译兼容；沉浸式场景不启用点选 UI
  onSelectAgent?: (id: string | null) => void;
  selectedObject?: SocietySceneSelection;
  onSelectObject?: (selection: SocietySceneSelection) => void;
  onZoomOutRequest?: () => void; // 滚轮持续缩小越过上限 → 请求升起返回宇宙
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
  visualKey: string;
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

  group.add(upright, dehydrated, sprite);
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
    spriteKey: '', visualKey: figureVisualKey(agent),
  };
}

/** 卸载一个人物（名牌贴图在模块缓存中共享，不随个体销毁） */
function disposeFigure(f: FigureParts): void {
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
  sky,
  selectedAgentId,
  onSelectAgent,
  selectedObject,
  onSelectObject,
  onZoomOutRequest,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({
    society,
    era,
    speaker,
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
    renderer.shadowMap.type = THREE.PCFShadowMap;       // WebGLRenderer 支持的 PCF 阴影，避免弃用回退警告
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

    // 程序化天空与环境贴图同源：画面可见渐变，同时为 PBR 材质提供反射源。
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
      scene.background = skyTexture;
      scene.backgroundIntensity = 0.82;
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
    controls.maxPolarAngle = THREE.MathUtils.degToRad(62); // 最低仍有 28° 俯角，不落到地平线
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
      // 完整包围盒 fit 视觉上仍会留下过多天空；收紧到 83%，允许最近的极少边角
      // 越出画面，以换取 16:9 首屏约 78% 宽、60%+ 高的沉浸式占比。
      return Math.max(78, required * 0.83);
    };
    const updateCameraFit = (width: number, height: number) => {
      const previousFit = cameraFitDistance;
      const previousDistance = camera.position.distanceTo(cameraTarget);
      const currentDirection = camera.position.clone().sub(cameraTarget).normalize();
      cameraFitDistance = fittedDistanceFor(width, height);
      cameraFinal.copy(cameraTarget).addScaledVector(cameraDirection, cameraFitDistance);
      cameraEntry.copy(cameraTarget).addScaledVector(cameraDirection, cameraFitDistance * 1.65);
      // 近景需要能看清单个人物与建筑细节；极角限制仍保证相机不会钻入地面。
      controls.minDistance = Math.max(7, cameraFitDistance * 0.055);
      if (controls.maxDistance < 600) controls.maxDistance = Math.max(225, cameraFitDistance * 1.65);
      if (controls.enabled && previousFit > 0) {
        const minZoomRatio = controls.minDistance / cameraFitDistance;
        const zoomRatio = THREE.MathUtils.clamp(previousDistance / previousFit, minZoomRatio, 1.65);
        camera.position.copy(cameraTarget).addScaledVector(currentDirection, cameraFitDistance * zoomRatio);
        controls.update();
      }
    };

    // ---- 星野背景（星球悬浮其中）----
    let skyStars: THREE.Points | null = null;
    {
      const N = 700;
      const pos = new Float32Array(N * 3);
      const col3 = new Float32Array(N * 3);
      const cCool = new THREE.Color('#cdd8ff');
      const cWarm = new THREE.Color('#ffe9c9');
      for (let i = 0; i < N; i++) {
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const r = 140 + Math.random() * 150;
        const s = Math.sqrt(1 - u * u);
        pos[i * 3] = r * s * Math.cos(th);
        pos[i * 3 + 1] = r * u * 0.72 + 10;
        pos[i * 3 + 2] = r * s * Math.sin(th);
        const base = Math.random() < 0.85 ? cCool : cWarm;
        const a = 0.2 + Math.random() * 0.55;
        col3[i * 3] = base.r * a;
        col3[i * 3 + 1] = base.g * a;
        col3[i * 3 + 2] = base.b * a;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col3, 3));
      const stars = new THREE.Points(
        g,
        new THREE.PointsMaterial({
          size: 1.25,
          sizeAttenuation: false,
          vertexColors: true,
          transparent: true,
          opacity: 0.78,
          depthWrite: false,
          fog: false,
          toneMapped: false,
        }),
      );
      skyStars = stars;
      scene.add(stars);
      aoExcluded.push(stars);
    }

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
        skySuns.forEach((star) => {
          star.enabled = false;
          star.core.visible = star.glow.visible = false;
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
    sun.intensity = initialEraLight.sunI * initialDaylight.direct;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const shadowExtent = Math.max(world0.width, world0.height) / 2 + 8;
    sun.shadow.camera.left = -shadowExtent;
    sun.shadow.camera.right = shadowExtent;
    sun.shadow.camera.top = shadowExtent;
    sun.shadow.camera.bottom = -shadowExtent;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 220;
    sun.shadow.bias = -0.00008;
    sun.shadow.normalBias = 0.032;
    scene.add(sun);
    const rim = new THREE.DirectionalLight('#9fb8e8', 0.62);
    rim.position.set(44, 34, 50); // 镜头侧冷填光只抬暗面，不与主光争夺形体
    scene.add(rim);
    lightApiRef.current = (eraKey) => {
      activeLightEra = eraKey;
    };

    const updateLighting = (deltaSeconds: number) => {
      lightingElapsedSeconds += deltaSeconds;
      const phase = (lightingElapsedSeconds % DAYLIGHT_CYCLE_SECONDS) / DAYLIGHT_CYCLE_SECONDS;
      const daylight = sampleDaylight(phase, sunlightTargetPosition, daylightTone);
      const eraLight = ERA_LIGHT[activeLightEra];
      const chaotic = isChaoticLightEra(activeLightEra);
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

      const blend = 1 - Math.exp(-LIGHT_DAMPING * deltaSeconds);
      sun.position.lerp(sunlightTargetPosition, blend);
      sun.color.lerp(sunlightTargetColor, blend);
      sun.intensity = THREE.MathUtils.damp(sun.intensity, eraLight.sunI * directMultiplier, LIGHT_DAMPING, deltaSeconds);
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
      const fog = scene.fog as THREE.Fog;
      fog.color.lerp(fogTargetColor, blend);
      fog.near = THREE.MathUtils.damp(fog.near, fogTargetNear, LIGHT_DAMPING, deltaSeconds);
      fog.far = THREE.MathUtils.damp(fog.far, fogTargetFar, LIGHT_DAMPING, deltaSeconds);
      renderer.setClearColor(fog.color);
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
    // 水体积仍严格来自权威液体体素；上层演出用 1/8 格量化的低对比流纹。
    // 像素边界保留体素感，整片材质共享相位保持连续；只读水格邻接，不写回水事实。
    const waterMat = new THREE.MeshPhysicalMaterial({
      color: '#ffffff', roughness: 0.21, metalness: 0,
      transmission: 0.58, ior: 1.33, thickness: 0.45, specularIntensity: 1.15,
      attenuationColor: '#58b7c8', attenuationDistance: 3.2,
      clearcoat: 0.42, clearcoatRoughness: 0.24,
      emissive: '#092b3b', emissiveIntensity: 0.22,
    });
    const water = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), waterMat, COUNT);
    water.count = 0;
    water.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    water.receiveShadow = false; // 树冠阴影不再把窄河压成纯黑沟槽
    scene.add(water);
    aoExcluded.push(water); // 透射水不是实体遮蔽体，避免 GTAO 给每格水面压出黑缝
    const waterFlowUniforms = { uTime: { value: 0 }, uRain: { value: 0 } };
    const waterFlowOffsets = new Float32Array(COUNT);
    const waterFlowGeo = new THREE.PlaneGeometry(1.02, 1.02);
    waterFlowGeo.rotateX(-Math.PI / 2);
    const waterFlowOffsetAttribute = new THREE.InstancedBufferAttribute(waterFlowOffsets, 1);
    waterFlowGeo.setAttribute('aFlowOffset', waterFlowOffsetAttribute);
    const waterFlow = new THREE.InstancedMesh(
      waterFlowGeo,
      new THREE.ShaderMaterial({
        uniforms: waterFlowUniforms,
        vertexShader: `
          attribute float aFlowOffset;
          varying vec2 vFlowCoord;
          varying float vFlowOffset;

          void main() {
            vFlowCoord = vec2(position.x, position.z + aFlowOffset);
            vFlowOffset = aFlowOffset;
            vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uRain;
          varying vec2 vFlowCoord;
          varying float vFlowOffset;

          void main() {
            // 先把取样位置锁进 1/8 格，再让色阶连续传播：轮廓是体素的，运动不再硬跳。
            vec2 voxel = floor(vFlowCoord * 8.0) / 8.0;
            float time = uTime * (1.0 + uRain * 0.28);
            float mainBand = 0.5 + 0.5 * sin(
              voxel.y * 4.2 - time * 1.45 + sin(voxel.x * 4.8 + vFlowOffset * 0.17) * 0.42
            );
            float crossBand = 0.5 + 0.5 * sin(
              voxel.y * 7.6 - time * 2.05 + voxel.x * 2.1
            );
            float flow = smoothstep(0.38, 0.94, mainBand) * (0.72 + crossBand * 0.28);
            vec3 flowColor = mix(vec3(0.10, 0.37, 0.45), vec3(0.34, 0.66, 0.70), flow);
            float alpha = 0.018 + flow * (0.075 + uRain * 0.018);
            gl_FragColor = vec4(flowColor, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      COUNT,
    );
    waterFlow.count = 0;
    waterFlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
      for (let cellId = 0; cellId < COUNT; cellId++) {
        const stack = w.columns[cellId];
        let depth = 0;
        while (depth < stack.length && w.palette[stack[depth]]?.tags.includes('liquid')) depth++;
        liquidDepthByCell[cellId] = depth;
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
      let wi = 0;
      let sti = 0;
      for (let cellId = 0; cellId < COUNT; cellId++) {
        const { x, y } = cellCoordinates(cellId, w.width);
        const wx = x - w.width / 2 + 0.5;
        const wz = y - w.height / 2 + 0.5;
        const stack = w.columns[cellId];
        const liquidDepth = liquidDepthByCell[cellId];
        const solidLevels = stack.length - liquidDepth;
        const solidH = solidLevels * CELL_H;
        const waterH = liquidDepth * CELL_H;
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
            // 水格的不透明柱只到真实河床；顶色取水下首个固体，不再把水画进 land 柱。
            const bed = w.palette[stack[liquidDepth]];
            const bedColor = bed?.color ?? [90, 80, 70];
            const visibleH = Math.max(0.0001, solidH);
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
        if (liquidDepth > 0) {
          const material = w.palette[stack[0]];
          // 几何厚度严格来自连续液体层；顶面 = (elevation + 1) * CELL_H，无额外凸起。
          // 略微重叠相邻水格，消除透射盒体之间的发丝缝；颜色同时编码水深和岸缘。
          m4.compose(v.set(wx, solidH + waterH / 2, wz), q.identity(), sc.set(1.018, waterH, 1.018));
          water.setMatrixAt(wi, m4);
          const waterColor = material?.color ?? [28, 91, 126];
          let liquidNeighbors = 0;
          if (x > 0 && liquidDepthByCell[cellId - 1] > 0) liquidNeighbors++;
          if (x + 1 < w.width && liquidDepthByCell[cellId + 1] > 0) liquidNeighbors++;
          if (y > 0 && liquidDepthByCell[cellId - w.width] > 0) liquidNeighbors++;
          if (y + 1 < w.height && liquidDepthByCell[cellId + w.width] > 0) liquidNeighbors++;
          const depthT = THREE.MathUtils.clamp((liquidDepth - 1) / 3, 0, 1);
          const shoreT = 1 - liquidNeighbors / 4;
          const targetShallow = [65, 150, 170] as const;
          const targetDeep = [24, 84, 126] as const;
          const targetChannel = (channel: number) => THREE.MathUtils.lerp(targetShallow[channel], targetDeep[channel], depthT);
          const waterMix = 0.62 + shoreT * 0.18;
          const visibleChannel = (channel: number) => Math.min(255,
            THREE.MathUtils.lerp(waterColor[channel], targetChannel(channel), waterMix) + shoreT * (channel === 0 ? 12 : 22));
          water.setColorAt(wi, col.setRGB(
            visibleChannel(0) / 255, visibleChannel(1) / 255, visibleChannel(2) / 255, THREE.SRGBColorSpace,
          ));
          const [dirX, dirZ] = flowDirection(x, y);
          const flowAngle = Math.atan2(dirX, dirZ);
          m4.compose(
            v.set(wx, solidH + waterH + 0.012, wz),
            q.setFromAxisAngle(decorAxisY, flowAngle),
            sc.set(1, 1, 1),
          );
          waterFlow.setMatrixAt(wi, m4);
          // 纵向格坐标让整条河共享动画相位；少量横向偏移只避免转弯处完全镜像。
          waterFlowOffsetAttribute.setX(wi, y + x * 0.125);
          wi++;
        }
      }

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
            && Math.abs(detailTop[cellId] - (w.elevation[neighborId] + 1) * CELL_H) <= 0.02;
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
      groundDetail.count = gdi;
      water.count = wi;
      waterFlow.count = wi;
      strata.count = sti;
      land.instanceMatrix.needsUpdate = true;
      if (land.instanceColor) land.instanceColor.needsUpdate = true;
      water.instanceMatrix.needsUpdate = true;
      if (water.instanceColor) water.instanceColor.needsUpdate = true;
      waterFlow.instanceMatrix.needsUpdate = true;
      waterFlowOffsetAttribute.needsUpdate = true;
      strata.instanceMatrix.needsUpdate = true;
      if (strata.instanceColor) strata.instanceColor.needsUpdate = true;
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
    let animatedDecorBatches: Array<{ mesh: THREE.InstancedMesh; instances: DecorInstance[] }> = [];
    scene.add(decorGroup);
    decorApiRef.current = (s, era) => {
      const instances = collectDecor(s, era);
      animatedDecorBatches = [];
      for (const child of [...decorGroup.children]) {
        (child as THREE.InstancedMesh).dispose();   // 只释放实例缓冲，共享几何体不动
        decorGroup.remove(child);
      }
      const byBucket = new Map<DecorBucket, DecorInstance[]>();
      for (const inst of instances) {
        const list = byBucket.get(inst.b);
        if (list) list.push(inst); else byBucket.set(inst.b, [inst]);
      }
      for (const [bucket, list] of byBucket) {
        const material = DECOR_MATS[bucket] ?? DECOR_MATS.plaster;
        const mesh = new THREE.InstancedMesh(boxGeo, material, list.length);
        list.forEach((inst, i) => {
          const rotation = inst.ry === undefined
            ? q.identity()
            : q.setFromAxisAngle(decorAxisY, inst.ry);
          m4.compose(v.set(inst.x, inst.y, inst.z), rotation, sc.set(inst.sx, inst.sy, inst.sz));
          mesh.setMatrixAt(i, m4);
          col.setHex(inst.c);
          if (bucket === 'leaf' || bucket === 'wood') {
            // 连续空间波形让同一树冠形成成片明暗，而不是每个微体素独立闪烁。
            const cluster = (
              Math.sin(inst.x * 2.13 + inst.z * 1.37 + inst.y * 0.71)
              + Math.sin(inst.x * 0.83 - inst.z * 1.91 + inst.y * 1.17)
            ) * 0.25;
            col.multiplyScalar(1 + cluster * (bucket === 'leaf' ? 0.12 : 0.055));
          }
          mesh.setColorAt(i, col);
        });
        // 叶簇保留 AO 接触层次，但不再让数百个微体素互相投出致黑阴影。
        mesh.castShadow = bucket !== 'leaf' && bucket !== 'groundMark' && bucket !== 'glowWarm' && bucket !== 'glowRed';
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (list.some((inst) => inst.entityId || inst.animation)) {
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          animatedDecorBatches.push({ mesh, instances: list });
        }
        decorGroup.add(mesh);
      }
    };

    // 动物和火焰仍与其他装饰共享 InstancedMesh 合批；带 entityId / animation 的构件逐帧更新矩阵。
    // 这样无需为每个动态素材创建独立 Mesh，也能获得动物步态与火舌、火星循环。
    const animalAxisY = new THREE.Vector3(0, 1, 0);
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
        instances.forEach((inst, index) => {
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
      const excludedIndex = aoExcluded.indexOf(figure.sprite);
      if (excludedIndex >= 0) aoExcluded.splice(excludedIndex, 1);
      disposeFigure(figure);
    };
    const syncAgents = (now: number) => {
      const p = propsRef.current;
      const w = p.society.world;
      const agents = p.society.agents;
      const motion = Math.min(1, (now - animStart.current) / MONTH_PLAYBACK_MS);
      const activeIntentByOwner = new Map(p.society.intents
        .filter((intent) => intent.status === 'active')
        .map((intent) => [intent.ownerId, intent]));
      const agentsByCell = new Map<number, SocietyAgent[]>();
      for (const agent of agents) {
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
          aoExcluded.push(f.sprite); // 名牌不参与 AO
        }
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
        else if (!dead && actionView?.targetPersonId) {
          const target = agents.find((candidate) => candidate.id === actionView.targetPersonId);
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

    // ---- 点选人物 / 权威结构；拖拽镜头不会触发选择，点击空白收起信息 ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
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
    canvas.addEventListener('pointerdown', onSelectionPointerDown);
    canvas.addEventListener('pointerup', onSelectionPointerUp);

    // ---- 滚轮 / 键盘缩放持续越过上限 → 请求升起返回宇宙 ----
    let zoomOutAcc = 0;
    let zoomOutAsked = false;
    const accumulateZoomOut = (deltaY: number) => {
      if (zoomOutAsked || !propsRef.current.onZoomOutRequest) return;
      if (deltaY > 0 && camera.position.distanceTo(controls.target) >= controls.maxDistance - 0.6) {
        zoomOutAcc += deltaY;
        if (zoomOutAcc > 300) {
          zoomOutAsked = true;
          controls.maxDistance = Math.max(600, controls.maxDistance * 1.8); // 过场期间允许继续升高
          propsRef.current.onZoomOutRequest();
        }
      } else {
        zoomOutAcc = 0;
      }
    };
    const onWheelOut = (ev: WheelEvent) => { accumulateZoomOut(ev.deltaY); };
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
          const halfX = world0.width * 0.5;
          const halfZ = world0.height * 0.5;
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

    // ---- 后处理管线：Render → 轻量 GTAO → ACES 输出 → FXAA ----
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
    composer.addPass(new OutputPass());
    const fxaaPass = new ShaderPass(FXAAShader);
    composer.addPass(fxaaPass);

    // ---- 尺寸自适应 ----
    const resize = () => {
      const wpx = mount.clientWidth;
      const hpx = mount.clientHeight;
      if (wpx <= 0 || hpx <= 0) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(wpx, hpx, false);
      camera.aspect = wpx / hpx;
      // 选择完整画幅下方 7% 的视窗，相当于把地表主体稳定上提 7%，且不改变旋转中心。
      camera.setViewOffset(wpx, hpx, 0, hpx * 0.07, wpx, hpx);
      updateCameraFit(wpx, hpx);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(wpx, hpx); // 内部会把 GTAO 等 Pass 按 pixelRatio 换算
      const pr = renderer.getPixelRatio();
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
      // 天体距离视为无限远：平移镜头时只移动观察点，不让星野产生近景视差。
      if (skyStars) skyStars.position.copy(camera.position);
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
      canvas.removeEventListener('pointerdown', onSelectionPointerDown);
      canvas.removeEventListener('pointerup', onSelectionPointerUp);
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
      skyTexture?.dispose();
      environmentTarget?.dispose();
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
        aria-label="人间场景：点击人物或结构查看信息，WASD 移动镜头，方向键上下缩放"
        className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      />
    </div>
  );
}
