import * as THREE from 'three';
import type { ActionVisualView, IntentView, SocietyAgent } from '@/game/societyContract';
import { Material } from '@/game/eland/domain/material';

export const FIGURE_SCALE = 0.5; // 保持原游戏的半格人物尺度，与真实一格住房及同格编组协调。
export const FIGURE_HIP_HEIGHT = 0.34;
export const FIGURE_HEAD_TOP = 1.2;
export const SPEECH_FONT_PX = 32;

const SPEECH_MAX_LINE_WIDTH_PX = 400;

export type SpeechBubblePlacement = 'body-left' | 'center' | 'body-right';

/** id → 稳定的衣色色相 */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (((h % 360) + 360) % 360) / 360;
}

// ---------------------------------------------------------------------------
// 名牌贴图（文本 sprite，模块级缓存共享）
// ---------------------------------------------------------------------------

const nameTextureCache = new Map<string, THREE.CanvasTexture>();

export function nameTexture(text: string, color: string): THREE.CanvasTexture {
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

function speechLinesForCanvas(
  context: CanvasRenderingContext2D,
  text: string,
): string[] {
  const glyphs = Array.from(text.trim().replace(/\s+/gu, ' '));
  const lines: string[] = [];
  let current = '';
  for (const glyph of glyphs) {
    const candidate = `${current}${glyph}`;
    if (!current || context.measureText(candidate).width <= SPEECH_MAX_LINE_WIDTH_PX) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = glyph;
  }
  if (current) lines.push(current);
  return lines.length ? lines : ['……'];
}

export function speechBubbleAnchorX(width: number, placement: SpeechBubblePlacement): number {
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
// 3D 体素人物
// ---------------------------------------------------------------------------

export type FigureAction = 'idle' | 'walk' | 'gather' | 'harvest' | 'attack' | 'carry' | 'ingest'
  | 'craft' | 'work' | 'tend-fire' | 'attend' | 'talk' | 'care' | 'reproduce';
export type FigureAge = 'child' | 'adult' | 'elder';

export interface FigureParts {
  group: THREE.Group;
  pickProxy: THREE.Mesh;
  upright: THREE.Group;
  upperBody: THREE.Group;
  head: THREE.Group;
  dehydrated: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  footL: THREE.Mesh;
  footR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  spear: THREE.Group;
  handTool: THREE.Group;
  toolHead: THREE.Mesh;
  heldLoad: THREE.Group;
  heldLoadFill: THREE.Mesh;
  balance: THREE.Group;
  balanceBeam: THREE.Group;
  balanceLoad: THREE.Mesh;
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

export function setSpeechBubbleTexture(
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

export function figureAgeOf(agent: SocietyAgent): FigureAge {
  if (agent.body.ageMonths < 12 * 12) return 'child';
  if (agent.conditions.some((condition) => condition.kind === 'aging')
    || agent.body.ageMonths >= agent.lifespanMonths * 0.66) return 'elder';
  return 'adult';
}

export function figureVisualKey(agent: SocietyAgent): string {
  return `${agent.sex}|${figureAgeOf(agent)}`;
}

export function figureActionView(agent: SocietyAgent, intent: IntentView | undefined): ActionVisualView | undefined {
  return agent.visualAction ?? intent;
}

export function figureActionOf(agent: SocietyAgent, intent: IntentView | undefined, moving: boolean): FigureAction {
  if (moving) return 'walk';
  const view = figureActionView(agent, intent);
  if (!view) return 'idle';
  if (view.actionKind === 'move') return 'walk';
  if (view.actionKind === 'transfer') return 'carry';
  if (view.actionKind === 'attend') return 'attend';
  if (view.actionKind === 'world-interact') return 'work';
  if (view.actionKind === 'inscribe') return 'attend';
  if (view.actionKind === 'talk') return 'talk';
  if (view.operation === 'ingest') return 'ingest';
  if (view.operation === 'hunt') return 'attack';
  if (view.operation === 'separate') {
    const sourceMaterialId = view.sourceMaterialId ?? view.materialId;
    if (sourceMaterialId === Material.BerryBush) return 'gather';
    if (sourceMaterialId === Material.CropMature) return 'harvest';
    return view.toolMaterialId !== undefined ? 'work' : 'gather';
  }
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

export function buildFigure(agent: SocietyAgent): FigureParts {
  const group = new THREE.Group();
  group.userData.agentId = agent.id;
  group.scale.setScalar(FIGURE_SCALE);
  const hue = hueOf(agent.id);
  const age = figureAgeOf(agent);
  const ageScale = age === 'child' ? 0.72 : age === 'elder' ? 0.9 : 1;
  // Natural dyes keep a family of warm linen, madder, indigo and moss silhouettes.
  // Identity is stable across replay; these colors do not imply profession or rank.
  const dyes = ['#c3ab7b', '#a3583f', '#596f7f', '#6f7956', '#c49a52', '#867466'];
  const clothColor = new THREE.Color(dyes[Math.floor(hue * dyes.length) % dyes.length]);
  const matte = (color: THREE.ColorRepresentation, roughness = 0.92) => new THREE.MeshStandardMaterial({
    color, roughness, metalness: 0, flatShading: true,
  });
  const cloth = matte(clothColor);
  const pants = matte(clothColor.clone().multiplyScalar(0.53));
  const skin = matte('#dcb28a', 0.8);
  const hair = matte(age === 'elder' ? '#b5b0a0' : ['#302823', '#514034', '#3b3029'][Math.floor(hue * 17) % 3]);
  const wood = matte('#725036');
  const stone = matte('#959b9a', 0.76);
  const drySkin = matte('#9b7657');
  const dryBand = matte('#899280');
  const leather = matte('#71513a');
  const linen = matte('#d8ccb0');
  const loadMat = matte('#a98055');

  const upright = new THREE.Group();
  upright.scale.setScalar(ageScale);
  const upperBody = new THREE.Group();
  upperBody.position.y = FIGURE_HIP_HEIGHT;

  const legGeo = new THREE.BoxGeometry(0.13, 0.295, 0.135);
  legGeo.translate(0, -0.1475, 0);
  const legL = new THREE.Mesh(legGeo, pants);
  legL.position.set(-0.09, FIGURE_HIP_HEIGHT, 0);
  const legR = new THREE.Mesh(legGeo, pants);
  legR.position.set(0.09, FIGURE_HIP_HEIGHT, 0);
  const shoeGeo = new THREE.BoxGeometry(0.155, 0.09, 0.24);
  const footL = new THREE.Mesh(shoeGeo, leather);
  const footR = new THREE.Mesh(shoeGeo, leather);
  // The sole is exactly at zero in the rest pose; animation counter-rotates the shoes.
  footL.position.set(0, -FIGURE_HIP_HEIGHT + 0.045, 0.04);
  footR.position.copy(footL.position);
  legL.add(footL);
  legR.add(footR);

  const torsoWidth = agent.sex === 'female' ? 0.33 : 0.37;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth, 0.39, 0.245), cloth);
  torso.position.y = 0.19;
  const shoulderBand = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth + 0.035, 0.085, 0.25), cloth);
  shoulderBand.position.y = 0.335;
  const belt = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth + 0.012, 0.038, 0.25), pants);
  belt.position.y = 0.07;
  const collar = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.22), linen);
  collar.position.set(0, 0.386, 0.015);
  const outerwear = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth + 0.055, 0.415, 0.275), leather);
  outerwear.position.y = 0.18;
  outerwear.visible = false;
  const bandage = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth + 0.075, 0.075, 0.295), linen);
  bandage.position.y = 0.18;
  bandage.rotation.z = -0.18;
  bandage.visible = false;
  const belly = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth * 0.8, 0.225, 0.2), cloth);
  belly.position.set(0, 0.1, 0.16);
  belly.visible = false;

  const armGeo = new THREE.BoxGeometry(0.11, 0.285, 0.125);
  armGeo.translate(0, -0.125, 0);
  const armL = new THREE.Mesh(armGeo, cloth);
  armL.position.set(-torsoWidth / 2 - 0.063, 0.345, 0);
  const armR = new THREE.Mesh(armGeo, cloth);
  armR.position.set(torsoWidth / 2 + 0.063, 0.345, 0);
  const handGeo = new THREE.BoxGeometry(0.12, 0.12, 0.14);
  const handL = new THREE.Mesh(handGeo, skin);
  const handR = new THREE.Mesh(handGeo, skin);
  handL.position.set(0, -0.3, 0.014);
  handR.position.copy(handL.position);
  armL.add(handL);
  armR.add(handR);

  const headScale = age === 'child' ? 1.1 : 1;
  const head = new THREE.Group();
  head.position.y = 0.445;
  head.scale.setScalar(headScale);
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.285, 0.285, 0.28), skin);
  face.position.y = 0.13;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.292), hair);
  cap.position.set(0, 0.269, -0.006);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.064, 0.054), skin);
  nose.position.set(0, 0.117, 0.15);
  head.add(face, cap, nose);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.023, 0.025, 0.01), hair);
    eye.position.set(side * 0.067, 0.158, 0.14);
    head.add(eye);
  }
  upperBody.add(torso, shoulderBand, belt, collar, outerwear, bandage, belly, armL, armR, head);
  if (Math.floor(hue * 12) % 3 === 0 && age !== 'elder') {
    const hairTuft = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.13), hair);
    hairTuft.position.set(-0.055, 0.334, -0.025);
    hairTuft.rotation.z = -0.24;
    head.add(hairTuft);
  }
  if (agent.sex === 'female') {
    const backHair = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.26, 0.085), hair);
    backHair.position.set(0, 0.11, -0.145);
    const sideHairL = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.22, 0.22), hair);
    sideHairL.position.set(-0.148, 0.115, -0.025);
    const sideHairR = sideHairL.clone();
    sideHairR.position.x *= -1;
    head.add(backHair, sideHairL, sideHairR);
  }
  if (age === 'elder') {
    const cane = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.65, 0.045), wood);
    cane.position.set(torsoWidth / 2 + 0.15, 0.325, 0.14);
    const caneGrip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.045), wood);
    caneGrip.position.set(torsoWidth / 2 + 0.1, 0.65, 0.14);
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
  const parcel = new THREE.Mesh(new THREE.BoxGeometry(0.39, 0.26, 0.28), linen);
  const heldLoadFill = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.09, 0.18), loadMat);
  heldLoadFill.position.y = 0.14;
  const bindingX = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.285, 0.295), wood);
  const bindingZ = new THREE.Mesh(new THREE.BoxGeometry(0.405, 0.285, 0.038), wood);
  heldLoad.add(parcel, heldLoadFill, bindingX, bindingZ);
  heldLoad.position.set(0, 0.46, 0.34);
  heldLoad.visible = false;

  // 等臂秤只在已提交称量事实中显示；右盘实体颜色来自本次真实称量对象。
  const balance = new THREE.Group();
  balance.position.set(0, 0.52, 0.42);
  const balanceStem = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.27, 0.045), wood);
  balanceStem.position.y = 0.08;
  const balanceGrip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.045, 0.055), wood);
  balanceGrip.position.y = -0.045;
  const balanceBeam = new THREE.Group();
  balanceBeam.position.y = 0.22;
  const beamBar = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.04, 0.05), wood);
  const beamPointer = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.15, 0.035), stone);
  beamPointer.position.y = -0.075;
  balanceBeam.add(beamBar, beamPointer);
  for (const side of [-1, 1]) {
    const cord = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.19, 0.025), linen);
    cord.position.set(side * 0.255, -0.11, 0);
    const pan = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 0.18), stone);
    pan.position.set(side * 0.255, -0.215, 0);
    balanceBeam.add(cord, pan);
  }
  const balanceLoad = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.095, 0.105), loadMat);
  balanceLoad.position.set(0.255, -0.275, 0);
  balanceBeam.add(balanceLoad);
  balance.add(balanceStem, balanceGrip, balanceBeam);
  balance.visible = false;
  upright.add(legL, legR, upperBody, heldLoad, balance);

  // 脱水 / 脱水冬眠：收束成干燥卷，不再只是人物换色。
  const dehydrated = new THREE.Group();
  dehydrated.scale.setScalar(ageScale);
  const dryBody = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 0.76), drySkin);
  dryBody.position.set(0, 0.09, 0);
  dehydrated.add(dryBody);
  for (const z of [-0.22, 0, 0.22]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.025, 0.055), dryBand);
    band.position.set(0, 0.16, z);
    dehydrated.add(band);
  }
  const dryHead = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.19, 0.21), skin);
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
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
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
    group, pickProxy, upright, upperBody, head, dehydrated, legL, legR, footL, footR, armL, armR,
    spear, handTool, toolHead, heldLoad, heldLoadFill, balance, balanceBeam, balanceLoad,
    tablet, heldFood, outerwear, bandage, belly, sprite,
    spriteKey: '', speechBubble, speechKey: '', speechTexture: null, speechAspect: 1,
    speechPixelWidth: 1, speechPixelHeight: 1, speechPlacement: 'center',
    visualKey: figureVisualKey(agent),
  };
}

/** 卸载一个人物（名牌贴图在模块缓存中共享，不随个体销毁） */
export function disposeFigure(f: FigureParts): void {
  f.speechTexture?.dispose();
  f.speechTexture = null;
  f.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | undefined;
    if (mat) mat.dispose();
  });
}
