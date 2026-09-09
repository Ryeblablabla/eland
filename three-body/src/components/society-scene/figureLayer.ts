import * as THREE from 'three';
import type { SocietyAgent, SocietyState, SpeechLineView } from '@/game/societyContract';
import { Material } from '@/game/eland/domain/material';
import { interpolatePath } from '@/game/pixelworld';
import { featureDepth, FUNCTIONAL_MODEL_KEYS } from '@/game/voxel-assets/surface-decoration';
import {
  FIGURE_SCALE,
  FIGURE_HIP_HEIGHT,
  FIGURE_HEAD_TOP,
  SPEECH_FONT_PX,
  buildFigure,
  disposeFigure,
  figureActionOf,
  figureActionView,
  figureAgeOf,
  figureVisualKey,
  hueOf,
  nameTexture,
  setSpeechBubbleTexture,
  speechBubbleAnchorX,
  type FigureParts,
  type SpeechBubblePlacement,
} from './figureVisuals';
import { activeSpeechLineAtProgress } from './speechPlayback';

const RULE_TICKS = 15;
const MONTH_PLAYBACK_MS = 3_000;
const NAME_TAG_TARGET_GLYPH_PX = 10.5;
const NAME_TAG_MIN_WORLD_H = 0.55;
const NAME_TAG_MAX_WORLD_H = 3;
const SPEECH_TARGET_FONT_PX = 11.5;
const SPEECH_COLLISION_GAP_PX = 8;

type FigureSelection =
  | { kind: 'agent'; id: string }
  | { kind: 'structure'; id: string }
  | null;

export interface FigureLayerFrame {
  society: SocietyState;
  embodiedAgentId: string | null;
  speechLines: readonly SpeechLineView[];
  speaker: string | null;
  selectedAgentId?: string | null;
  selectedObject?: FigureSelection;
  animationStartedAt: number;
  hideNameLabels?: boolean;
  hideSpeech?: boolean;
}

interface FigureLayerOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  aoExcluded: THREE.Object3D[];
  cellHeight: number;
  readViewport: () => { width: number; height: number };
  readFrame: () => FigureLayerFrame;
}

export interface FigureLayer {
  sync(now: number): void;
  layoutSpeechBubbles(): void;
  intersect(raycaster: THREE.Raycaster): THREE.Intersection | undefined;
  visiblePickProxy(agentId: string): THREE.Object3D | undefined;
  writeWorldPosition(agentId: string, target: THREE.Vector3): boolean;
  writeSpeechFocus(target: THREE.Vector3): boolean;
  dispose(): void;
}

/** 一格内的稳定局部槽位；人物按 id 排序后取槽位，避免都压在格心。 */
export function sharedCellOffset(index: number, count: number): { x: number; z: number } {
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
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const spacing = Math.min(0.17, 0.82 / Math.max(1, columns - 1, rows - 1));
  return {
    x: (index % columns - (columns - 1) / 2) * spacing,
    z: (Math.floor(index / columns) - (rows - 1) / 2) * spacing,
  };
}

/** Match interpolatePath's compressed movement segments, keeping feet above voxel steps. */
export function figurePathStandingHeight(
  path: readonly number[],
  width: number,
  progress: number,
  destinationZ: number,
  groundHeightAt: (cellId: number) => number,
  cellOffset: { x: number; z: number } = { x: 0, z: 0 },
): number {
  const movingPath = path.filter((id, index) => index === 0 || id !== path[index - 1]);
  if (movingPath.length < 2 || progress >= 1) return destinationZ;
  const offset = THREE.MathUtils.clamp(progress, 0, 1) * (movingPath.length - 1);
  const index = Math.min(movingPath.length - 2, Math.floor(offset));
  const local = offset - index;
  const fromId = movingPath[index], toId = movingPath[index + 1];
  const from = groundHeightAt(fromId), to = groundHeightAt(toId);
  // Preserve the authoritative final landing, including a person on an upper floor.
  const landingOffset = destinationZ - groundHeightAt(movingPath[movingPath.length - 1]);
  const dx = toId % width - fromId % width;
  const dz = Math.floor(toId / width) - Math.floor(fromId / width);
  const segmentLength = Math.hypot(dx, dz);
  const crossing = 0.5 - (dx * cellOffset.x + dz * cellOffset.z) / Math.max(1, segmentLength ** 2);
  const footClearance = 0.19 / Math.max(1, segmentLength);
  // Rise before the leading foot reaches the upper cell; descend only after the
  // trailing foot clears it. A linear height blend would cut straight into the riser.
  const edge = THREE.MathUtils.clamp(crossing + (to > from ? -footClearance : footClearance), 0.04, 0.96);
  const start = to > from ? Math.max(0, edge - 0.2) : edge;
  const end = to > from ? edge : Math.min(1, edge + 0.2);
  const blend = THREE.MathUtils.smoothstep(local, start, end);
  return from + (to - from) * blend + landingOffset;
}

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

interface IncomingInteraction {
  actorId: string;
  kind: 'handoff' | 'care' | 'listen' | 'companion';
  sourceOrderInMonth: number;
}

const overlapArea = (left: SpeechLayoutRect, right: SpeechLayoutRect): number => Math.max(
  0,
  Math.min(left.right, right.right) - Math.max(left.left, right.left),
) * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));

export function createFigureLayer({
  scene,
  camera,
  aoExcluded,
  cellHeight,
  readViewport,
  readFrame,
}: FigureLayerOptions): FigureLayer {
  const figures = new Map<string, FigureParts>();
  const speechAnchorWorld = new THREE.Vector3();
  const speechAnchorView = new THREE.Vector3();
  const speechProjected = new THREE.Vector3();
  const speechWorldScale = new THREE.Vector3();
  const speechFocusCandidate = new THREE.Vector3();
  const activeSpeechBySpeaker = new Map<string, SpeechLineView>();
  const constructionCells = new Set<number>();
  const interiorFloors = new Map<number, number[]>();
  let terrainWorld: SocietyState['world'] | null = null;
  let terrainStructures: SocietyState['structures'] | null = null;

  const syncTerrainMetadata = (world: SocietyState['world'], structures: SocietyState['structures']) => {
    // One authoritative frame is replayed many times. Geometry/structure updates
    // arrive with new references, while camera and animation frames reuse them.
    if (world === terrainWorld && structures === terrainStructures) return;
    constructionCells.clear();
    interiorFloors.clear();
    for (const structure of structures) {
      if (!(structure.materialIds ?? []).some((id) => FUNCTIONAL_MODEL_KEYS.has(world.palette[id]?.key ?? ''))) {
        for (const id of structure.occupiedCells) constructionCells.add(id);
      }
      if (!structure.complete) continue;
      for (const position of structure.interiorPositions) {
        const floors = interiorFloors.get(position.cellId);
        if (floors) floors.push(position.z);
        else interiorFloors.set(position.cellId, [position.z]);
      }
    }
    terrainWorld = world;
    terrainStructures = structures;
  };

  const removeFigure = (figure: FigureParts) => {
    scene.remove(figure.group);
    for (const excluded of [figure.sprite, figure.speechBubble]) {
      const excludedIndex = aoExcluded.indexOf(excluded);
      if (excludedIndex >= 0) aoExcluded.splice(excludedIndex, 1);
    }
    disposeFigure(figure);
  };

  const sync = (now: number) => {
    const frame = readFrame();
    const w = frame.society.world;
    const agents = frame.society.agents;
    syncTerrainMetadata(w, frame.society.structures);
    const embodiedAgent = frame.embodiedAgentId;
    const motion = Math.min(1, (now - frame.animationStartedAt) / MONTH_PLAYBACK_MS);
    activeSpeechBySpeaker.clear();
    const activeSpeechLine = activeSpeechLineAtProgress(frame.speechLines, motion);
    if (activeSpeechLine) activeSpeechBySpeaker.set(activeSpeechLine.speakerId, activeSpeechLine);
    const activeIntentByOwner = new Map(frame.society.intents
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
        : view.actionKind === 'talk'
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
      let figure = figures.get(agent.id);
      const visualKey = figureVisualKey(agent);
      if (figure && figure.visualKey !== visualKey) {
        removeFigure(figure);
        figures.delete(agent.id);
        figure = undefined;
      }
      if (!figure) {
        figure = buildFigure(agent);
        scene.add(figure.group);
        figures.set(agent.id, figure);
        aoExcluded.push(figure.sprite, figure.speechBubble);
      }
      const f = figure;
      f.group.visible = agent.bodyDisposition !== 'interred' && agent.id !== embodiedAgent;
      f.sprite.visible = embodiedAgent === null && !frame.hideNameLabels;
      if (!f.group.visible) continue;
      const path = agent.tickPath.length === RULE_TICKS + 1
        ? agent.tickPath
        : agent.lastPath.length ? agent.lastPath : [agent.cellId];
      const point = embodiedAgent
        ? { x: agent.cellId % w.width, y: Math.floor(agent.cellId / w.width) }
        : interpolatePath(path, w.width, motion);
      const prev = embodiedAgent
        ? point
        : interpolatePath(path, w.width, Math.max(0, motion - 0.08));
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
      const cycle = now * 0.009 + phase;
      const offset = cellOffsetByAgent.get(agent.id) ?? { x: 0, z: 0 };
      const standingHeight = embodiedAgent ? agent.z : figurePathStandingHeight(
        path, w.width, motion, agent.z,
        (id) => {
          const floors = interiorFloors.get(id);
          if (floors?.length) return floors.reduce((nearest, floor) => (
            Math.abs(floor - agent.z) < Math.abs(nearest - agent.z) ? floor : nearest
          ));
          return w.elevation[id] - featureDepth(w, id, constructionCells) + 1;
        },
        offset,
      );
      f.group.position.set(
        point.x - w.width / 2 + 0.5 + offset.x,
        standingHeight * cellHeight + (dead ? 0.025 : 0),
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
      f.group.rotation.x = dead ? -Math.PI * 0.45 : 0;
      f.upright.visible = !sleeping;
      f.dehydrated.visible = sleeping;
      const viewportHeight = readViewport().height;
      const labelDepth = Math.max(1, camera.position.distanceTo(f.group.position));
      const worldUnitsPerPixel = 2 * labelDepth * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
        / Math.max(1, viewportHeight);
      const labelHeight = THREE.MathUtils.clamp(
        NAME_TAG_TARGET_GLYPH_PX * (64 / 30) * worldUnitsPerPixel,
        NAME_TAG_MIN_WORLD_H,
        NAME_TAG_MAX_WORLD_H,
      );
      f.sprite.scale.set(labelHeight * 4, labelHeight, 1);
      f.sprite.position.y = (sleeping ? 0.52 : FIGURE_HEAD_TOP) + labelHeight * 0.25;

      const speechLine = activeSpeechBySpeaker.get(agent.id);
      const speechKey = speechLine ? `${speechLine.id}|${speechLine.text}` : '';
      if (speechKey !== f.speechKey) {
        if (speechLine) {
          setSpeechBubbleTexture(
            f,
            speechLine.text,
            'center',
          );
          f.speechBubble.center.y = 0;
        } else {
          f.speechTexture?.dispose();
          f.speechTexture = null;
          f.speechBubble.material.map = null;
          f.speechBubble.material.needsUpdate = true;
          f.speechBubble.center.set(0.5, 0);
          f.speechPlacement = 'center';
        }
        f.speechKey = speechKey;
      }
      f.speechBubble.visible = Boolean(speechLine) && embodiedAgent === null && !frame.hideSpeech;
      if (speechLine) {
        const bubbleWorldHeight = THREE.MathUtils.clamp(
          SPEECH_TARGET_FONT_PX * (f.speechPixelHeight / SPEECH_FONT_PX) * worldUnitsPerPixel,
          0.35,
          11,
        );
        const bubbleLocalHeight = bubbleWorldHeight / FIGURE_SCALE;
        f.speechBubble.scale.set(bubbleLocalHeight * f.speechAspect, bubbleLocalHeight, 1);
        f.speechBubble.position.y = (sleeping ? 0.52 : FIGURE_HEAD_TOP) + labelHeight * 0.84;
      }

      f.upperBody.position.set(0, FIGURE_HIP_HEIGHT, 0);
      f.upperBody.rotation.set(0, 0, 0);
      f.head.rotation.set(0, 0, 0);
      f.legL.rotation.set(0, 0, 0);
      f.legR.rotation.set(0, 0, 0);
      f.armL.rotation.set(0, 0, 0);
      f.armR.rotation.set(0, 0, 0);
      f.spear.visible = false;
      f.handTool.visible = false;
      f.heldLoad.visible = false;
      f.heldLoad.position.set(0, 0.46, 0.34);
      f.heldLoad.rotation.set(0, 0, 0);
      f.balance.visible = false;
      f.balanceBeam.rotation.z = 0;
      f.tablet.visible = false;
      f.heldFood.visible = false;
      const toolKey = actionView?.toolMaterialId !== undefined ? w.palette[actionView.toolMaterialId]?.key : undefined;
      const materialKey = actionView?.materialId !== undefined ? w.palette[actionView.materialId]?.key : undefined;
      const toolColor = actionView?.toolMaterialId !== undefined ? w.palette[actionView.toolMaterialId]?.color : undefined;
      const carriedColor = actionView?.materialId !== undefined ? w.palette[actionView.materialId]?.color : undefined;
      if (toolColor) (f.toolHead.material as THREE.MeshStandardMaterial).color.setRGB(
        toolColor[0] / 255, toolColor[1] / 255, toolColor[2] / 255, THREE.SRGBColorSpace,
      );
      if (carriedColor) {
        for (const mesh of [f.heldLoadFill, f.heldFood]) (mesh.material as THREE.MeshStandardMaterial).color.setRGB(
          carriedColor[0] / 255, carriedColor[1] / 255, carriedColor[2] / 255, THREE.SRGBColorSpace,
        );
        (f.balanceLoad.material as THREE.MeshStandardMaterial).color.setRGB(
          carriedColor[0] / 255, carriedColor[1] / 255, carriedColor[2] / 255, THREE.SRGBColorSpace,
        );
      }
      const clothing = agent.inventory.find((stack) => stack.materialId === Material.LeatherClothing)
        ?? agent.inventory.find((stack) => stack.materialId === Material.Clothing);
      f.outerwear.visible = Boolean(clothing);
      if (clothing) {
        const color = w.palette[clothing.materialId]?.color;
        if (color) (f.outerwear.material as THREE.MeshStandardMaterial).color.setRGB(
          color[0] / 255, color[1] / 255, color[2] / 255, THREE.SRGBColorSpace,
        );
      }
      f.bandage.visible = agent.conditions.some((condition) => condition.kind === 'wound');
      f.belly.visible = agent.conditions.some((condition) => condition.kind === 'pregnancy');
      if (!dead && !sleeping) {
        if (action === 'walk') {
          const swing = Math.sin(cycle) * 0.46;
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.012 + Math.abs(Math.sin(cycle * 2)) * 0.012;
          f.upperBody.rotation.x = 0.075;
          f.upperBody.rotation.y = Math.sin(cycle) * 0.06;
          f.upperBody.rotation.z = Math.cos(cycle) * 0.025;
          f.legL.rotation.x = swing;
          f.legR.rotation.x = -swing;
          f.armL.rotation.x = -swing * 0.7;
          f.armR.rotation.x = swing * 0.7;
          // A transfer remains visible during its authoritative travel path.
          if (actionView?.actionKind === 'transfer' || actionView?.mortuaryPhase === 'lift') {
            f.heldLoad.visible = true;
            f.upperBody.rotation.x = 0.19;
            f.armL.rotation.x = -1.08;
            f.armR.rotation.x = -1.08;
            f.armL.rotation.z = 0.13;
            f.armR.rotation.z = -0.13;
            f.heldLoad.position.y = 0.45 + Math.abs(Math.sin(cycle * 2)) * 0.012;
          }
        } else if (action === 'gather') {
          const reach = 0.92 + Math.sin(cycle * 0.8) * 0.12;
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.045;
          f.upperBody.rotation.x = 0.32;
          f.legL.rotation.x = 0.22;
          f.legR.rotation.x = -0.18;
          f.armL.rotation.x = -reach;
          f.armR.rotation.x = -reach;
        } else if (action === 'harvest') {
          const sweep = Math.sin(cycle * 0.72);
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.035;
          f.upperBody.rotation.x = 0.28;
          f.upperBody.rotation.y = sweep * 0.16;
          f.legL.rotation.x = 0.24;
          f.legR.rotation.x = -0.2;
          f.armL.rotation.x = -0.78 - sweep * 0.18;
          f.armR.rotation.x = -1.08 + sweep * 0.34;
          f.handTool.visible = actionView?.toolMaterialId !== undefined;
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
          const effort = Math.sin(cycle * 0.52);
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.018 + effort * 0.004;
          f.upperBody.rotation.x = 0.22 + effort * 0.016;
          f.upperBody.rotation.z = effort * 0.018;
          f.legL.rotation.x = 0.12;
          f.legR.rotation.x = -0.14;
          f.armL.rotation.x = -1.08;
          f.armR.rotation.x = -1.08;
          f.armL.rotation.z = 0.13;
          f.armR.rotation.z = -0.13;
          f.heldLoad.position.y = 0.46 + effort * 0.008;
          f.heldLoad.rotation.x = -0.08;
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
          const labor = Math.sin(cycle * 0.8);
          const strike = 0.48 + (labor + 1) * 0.72;
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.022 - (1 - labor) * 0.009;
          f.upperBody.rotation.x = 0.18 + (1 - labor) * 0.11;
          f.upperBody.rotation.y = labor * 0.12;
          f.legL.rotation.x = 0.2;
          f.legR.rotation.x = -0.16;
          f.armL.rotation.x = -0.7;
          f.armR.rotation.x = -strike;
          f.handTool.visible = toolKey === 'stone_tool' || toolKey === 'bone_tool';
        } else if (action === 'craft') {
          const work = 0.92 + Math.sin(cycle * 0.7) * 0.22;
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.055;
          f.upperBody.rotation.x = 0.34 + Math.sin(cycle * 0.7) * 0.045;
          f.upperBody.rotation.y = Math.sin(cycle * 0.7) * 0.08;
          f.legL.rotation.x = 0.34;
          f.legR.rotation.x = -0.28;
          f.armL.rotation.x = -work;
          f.armR.rotation.x = -work * 1.08;
          f.handTool.visible = toolKey === 'stone_tool' || toolKey === 'bone_tool';
        } else if (action === 'tend-fire') {
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.045;
          f.upperBody.rotation.x = 0.32;
          f.armL.rotation.x = -1.02 + Math.sin(cycle * 0.55) * 0.08;
          f.armR.rotation.x = -1.12 - Math.sin(cycle * 0.55) * 0.08;
          f.legL.rotation.x = 0.28;
          f.legR.rotation.x = -0.2;
        } else if (action === 'attend') {
          const hasBalance = Boolean(agent.visualAction?.sourceEventId
            && actionView?.measurementMode
            && toolKey === 'beam_balance');
          const hasTablet = !hasBalance && (toolKey === 'wood_tablet' || materialKey === 'wood_tablet'
            || actionView?.actionKind === 'inscribe');
          f.balance.visible = hasBalance;
          if (hasBalance) f.balanceBeam.rotation.z = Math.sin(cycle * 0.45) * 0.045;
          f.tablet.visible = hasTablet;
          f.armL.rotation.x = hasBalance ? -1.18 : hasTablet ? -1.05 : -0.22;
          f.armR.rotation.x = hasBalance ? -1.18 : hasTablet ? -0.72 : -1.48;
          f.armR.rotation.z = hasTablet ? 0.08 : -0.42;
          f.upperBody.rotation.x = hasBalance ? 0.08 : hasTablet ? 0.12 : -0.03;
        } else if (action === 'talk') {
          const gesture = Math.sin(cycle * 0.52);
          f.armL.rotation.x = -0.45 - gesture * 0.32;
          f.armL.rotation.z = 0.42;
          f.armR.rotation.x = -0.72 + gesture * 0.28;
          f.armR.rotation.z = -0.36;
          f.upperBody.rotation.y = gesture * 0.06;
          f.head.rotation.y = -gesture * 0.08;
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
          f.upperBody.position.y = FIGURE_HIP_HEIGHT + Math.sin(cycle * 0.32) * 0.008;
        } else if (agent.conditions.some((condition) => condition.kind === 'cold')) {
          f.upperBody.rotation.x = 0.18;
          f.armL.rotation.x = -0.88;
          f.armL.rotation.z = -0.42;
          f.armR.rotation.x = -0.88;
          f.armR.rotation.z = 0.42;
        } else if (agent.conditions.some((condition) => condition.kind === 'heat' || condition.kind === 'illness')) {
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.035;
          f.upperBody.rotation.x = 0.22;
          f.armL.rotation.x = -0.25;
          f.armR.rotation.x = -0.18;
        } else {
          // Idle is still a real living state. Keep motion inside the occupied
          // cell so presentation never invents authoritative travel.
          const breath = Math.sin(cycle * 0.22);
          const glance = Math.sin(cycle * 0.09 + phase);
          f.upperBody.position.y = FIGURE_HIP_HEIGHT + breath * 0.008;
          f.upperBody.rotation.y = glance * 0.055;
          f.upperBody.rotation.x = 0.045 + breath * 0.012;
          f.upperBody.rotation.z = Math.sin(cycle * 0.13 + phase) * 0.02;
          f.head.rotation.y = glance * 0.12;
          f.armL.rotation.z = 0.06;
          f.armR.rotation.z = -0.07;
          f.armL.rotation.x = -0.08 + breath * 0.025;
          f.armR.rotation.x = -0.1 - breath * 0.025;
        }
        if (incomingInteraction?.kind === 'handoff') {
          f.upperBody.rotation.x = 0.08;
          f.armL.rotation.x = -1.08;
          f.armR.rotation.x = -1.08;
          f.armL.rotation.z = 0.16;
          f.armR.rotation.z = -0.16;
        } else if (incomingInteraction?.kind === 'care') {
          f.upperBody.position.y = FIGURE_HIP_HEIGHT - 0.025;
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
      // Neck motion keeps the gaze readable while shoulders take the load.
      if (!dead && !sleeping) {
        if (figureAgeOf(agent) === 'elder') f.upperBody.rotation.x += 0.11;
        f.head.rotation.x = -f.upperBody.rotation.x * 0.38 + Math.sin(cycle * 0.22) * 0.012;
      }
      // Shoes remain horizontal and the support sole touches the actual surface.
      // Movement belongs to the limbs, never to a floating figure root.
      for (const [leg, foot, side] of [[f.legL, f.footL, 1], [f.legR, f.footR, -1]] as const) {
        const angle = leg.rotation.x;
        const lift = action === 'walk' && !dead && !sleeping
          ? Math.max(0, Math.cos(cycle) * side) * 0.055 : 0;
        foot.rotation.x = -angle;
        leg.position.y = (FIGURE_HIP_HEIGHT - 0.045) * Math.cos(angle)
          + 0.04 * Math.sin(angle) + 0.045 + lift;
      }
      const selected = frame.selectedAgentId === agent.id
        || (frame.selectedObject?.kind === 'agent' && frame.selectedObject.id === agent.id);
      const highlighted = agent.name === frame.speaker || selected;
      const key = `${agent.name}|${highlighted}|${selected}`;
      if (key !== f.spriteKey) {
        f.sprite.material.map = nameTexture(agent.name, selected ? '#ffffff' : highlighted ? '#fde68a' : '#e2e8f0');
        f.sprite.material.depthTest = !highlighted;
        f.sprite.material.opacity = highlighted ? 1 : 0.9;
        f.sprite.renderOrder = highlighted ? 20 : 5;
        f.spriteKey = key;
      }
    }
    for (const [id, figure] of figures) {
      if (!agents.some((agent) => agent.id === id)) {
        removeFigure(figure);
        figures.delete(id);
      }
    }
  };

  const layoutSpeechBubbles = () => {
    const { width: viewportWidth, height: viewportHeight } = readViewport();
    if (viewportWidth <= 0 || viewportHeight <= 0) return;
    camera.updateMatrixWorld();
    const items: SpeechLayoutItem[] = [];
    for (const line of activeSpeechBySpeaker.values()) {
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
      const placements: SpeechBubblePlacement[] = [
        'center',
        outwardFirst,
        outwardFirst === 'body-left' ? 'body-right' : 'body-left',
      ];
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

  const intersect = (raycaster: THREE.Raycaster) => raycaster.intersectObjects(
    [...figures.values()].map((figure) => figure.group),
    true,
  )[0];

  const visiblePickProxy = (agentId: string) => {
    const figure = figures.get(agentId);
    return figure?.group.visible ? figure.pickProxy : undefined;
  };

  const writeWorldPosition = (agentId: string, target: THREE.Vector3) => {
    const figure = figures.get(agentId);
    if (!figure) return false;
    figure.group.updateWorldMatrix(true, false);
    figure.group.getWorldPosition(target);
    return true;
  };

  const writeSpeechFocus = (target: THREE.Vector3) => {
    let speakerCount = 0;
    target.set(0, 0, 0);
    for (const speakerId of activeSpeechBySpeaker.keys()) {
      const figure = figures.get(speakerId);
      if (!figure?.speechBubble.visible) continue;
      figure.group.updateWorldMatrix(true, false);
      figure.group.getWorldPosition(speechFocusCandidate);
      speechFocusCandidate.y += 0.9;
      target.add(speechFocusCandidate);
      speakerCount += 1;
    }
    if (speakerCount === 0) return false;
    target.multiplyScalar(1 / speakerCount);
    return true;
  };

  const dispose = () => {
    for (const figure of figures.values()) removeFigure(figure);
    figures.clear();
    constructionCells.clear();
    interiorFloors.clear();
    terrainWorld = null;
    terrainStructures = null;
  };

  return {
    sync,
    layoutSpeechBubbles,
    intersect,
    visiblePickProxy,
    writeWorldPosition,
    writeSpeechFocus,
    dispose,
  };
}
