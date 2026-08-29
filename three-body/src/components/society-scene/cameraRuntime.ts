import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SocietyState } from '@/game/societyContract';
import { PinchTransitionGesture } from '@/game/pinch-transition-gesture';
import {
  EmbodimentCameraController,
  type EmbodimentMoveDirection,
} from './EmbodimentCameraController';
import { sharedCellOffset } from './figureLayer';
import { figureAgeOf } from './figureVisuals';

const SOCIETY_MAX_PIXEL_RATIO = 1.5;
const EMBODIMENT_MAX_PIXEL_RATIO = 1.15;
const CAMERA_TARGET_INSET_X = 12;
const CAMERA_TARGET_INSET_Z = 10;
const EMBODIMENT_EYE_HEIGHT = 0.44;

export type SocietyCameraMode =
  | { kind: 'overview' }
  | {
      kind: 'embodiment';
      agentId: string;
      /**
       * Presentation-only camera anchor used while an already-legal movement
       * command is awaiting authority. It never moves the projected person or
       * participates in target raycasts / option legality.
       */
      presentationPosition?: { cellId: number; z: number };
    };

interface CameraFrame {
  cameraMode: SocietyCameraMode;
  onZoomOutRequest?: () => void;
  onEmbodimentMove?: (direction: EmbodimentMoveDirection) => void;
  onEmbodimentMoveHoldChange?: (direction: EmbodimentMoveDirection | null) => void;
  onEmbodimentTargetChange?: (target: null) => void;
  onEmbodimentPointerLockChange?: (locked: boolean) => void;
  onEmbodimentCameraSettled?: () => void;
}

interface CreateCameraRuntimeOptions {
  canvas: HTMLCanvasElement;
  world: SocietyState['world'];
  cellHeight: number;
  readViewport: () => { width: number; height: number };
  readFrame: () => CameraFrame;
}

interface AttachCameraInputOptions {
  onSelectionGestureCancel: () => void;
}

export interface CameraRuntimeFrameState {
  embodimentActive: boolean;
  entryProgress: number;
  overviewControlsActive: boolean;
}

export interface CameraRuntime {
  camera: THREE.PerspectiveCamera;
  cameraForward: THREE.Vector3;
  cameraRight: THREE.Vector3;
  cameraUp: THREE.Vector3;
  setMode: (society: SocietyState, mode: SocietyCameraMode) => void;
  attachInput: (options: AttachCameraInputOptions) => void;
  setOverviewInteractionListener: (
    listener: (active: boolean, embodimentActive: boolean) => void,
  ) => void;
  consumeSelectionTapSuppression: (pointerId: number) => boolean;
  isEmbodimentActive: () => boolean;
  pixelRatioCap: () => number;
  resizeCamera: (width: number, height: number) => void;
  copyOverviewTarget: (target: THREE.Vector3) => THREE.Vector3;
  overviewDistanceRatio: () => number;
  isZoomOutTransitionRequested: () => boolean;
  update: (now: number, deltaSeconds: number) => CameraRuntimeFrameState;
  dispose: () => void;
}

type EmbodimentMovementKey = 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD';

const EMBODIMENT_MOVEMENT_KEYS = new Set<EmbodimentMovementKey>([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
]);
const HANDLED_OVERVIEW_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown']);

function isEmbodimentMovementKey(code: string): code is EmbodimentMovementKey {
  return EMBODIMENT_MOVEMENT_KEYS.has(code as EmbodimentMovementKey);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function createCameraRuntime({
  canvas,
  world,
  cellHeight,
  readViewport,
  readFrame,
}: CreateCameraRuntimeOptions): CameraRuntime {
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
  camera.position.copy(cameraEntry);
  const mountedAt = performance.now();

  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minPolarAngle = THREE.MathUtils.degToRad(38);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(78);
  controls.minDistance = 7;
  controls.maxDistance = 245;
  controls.target.copy(cameraTarget);

  const embodimentCamera = new EmbodimentCameraController({
    camera,
    canvas,
    onPointerLockChange: (locked) => readFrame().onEmbodimentPointerLockChange?.(locked),
    onSettled: () => readFrame().onEmbodimentCameraSettled?.(),
  });
  let embodiedAgentId: string | null = null;
  const lastEmbodimentAnchor = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);

  const actorCameraAnchor = (
    society: SocietyState,
    agentId: string,
    presentationPosition?: { cellId: number; z: number },
  ) => {
    const actor = society.agents.find((agent) => agent.id === agentId);
    if (!actor || actor.state === 'dead') return null;
    const cellId = presentationPosition?.cellId ?? actor.cellId;
    const standingZ = presentationPosition?.z ?? actor.z;
    const occupants = society.agents
      .filter((agent) => (agent.id === actor.id ? cellId : agent.cellId) === cellId
        && agent.bodyDisposition !== 'interred')
      .sort((left, right) => left.id.localeCompare(right.id));
    const occupantIndex = occupants.findIndex((agent) => agent.id === actor.id);
    const offset = occupantIndex >= 0
      ? sharedCellOffset(occupantIndex, occupants.length)
      : { x: 0, z: 0 };
    const age = figureAgeOf(actor);
    const ageScale = age === 'child' ? 0.72 : age === 'elder' ? 0.9 : 1;
    return {
      x: cellId % society.world.width - society.world.width / 2 + 0.5 + offset.x,
      y: standingZ * cellHeight + EMBODIMENT_EYE_HEIGHT * ageScale,
      z: Math.floor(cellId / society.world.width) - society.world.height / 2 + 0.5 + offset.z,
    };
  };

  const setMode = (society: SocietyState, mode: SocietyCameraMode) => {
    embodimentCamera.setCallbacks({
      onPointerLockChange: (locked) => readFrame().onEmbodimentPointerLockChange?.(locked),
      onSettled: () => readFrame().onEmbodimentCameraSettled?.(),
    });
    if (mode.kind === 'embodiment') {
      const anchor = actorCameraAnchor(society, mode.agentId, mode.presentationPosition);
      if (!anchor) return;
      controls.enabled = false;
      if (embodiedAgentId !== mode.agentId || !embodimentCamera.isActive()) {
        embodiedAgentId = mode.agentId;
        lastEmbodimentAnchor.set(anchor.x, anchor.y, anchor.z);
        embodimentCamera.enter(anchor);
      } else if (lastEmbodimentAnchor.distanceToSquared(anchor) > 1e-8) {
        lastEmbodimentAnchor.set(anchor.x, anchor.y, anchor.z);
        embodimentCamera.setAnchor(anchor, true);
      }
      return;
    }
    if (!embodimentCamera.isActive()) return;
    embodiedAgentId = null;
    lastEmbodimentAnchor.set(Number.NaN, Number.NaN, Number.NaN);
    embodimentCamera.leave();
    const { width, height } = readViewport();
    if (width > 0 && height > 0) {
      camera.setViewOffset(width, height, 0, height * 0.07, width, height);
      camera.updateProjectionMatrix();
    }
    controls.enabled = true;
    controls.update();
    readFrame().onEmbodimentTargetChange?.(null);
  };

  // Fit uses the authoritative world's actual bounds. Resizes retain the
  // user's zoom ratio and view direction instead of resetting the camera.
  let cameraFitDistance = 150;
  const fittedDistanceFor = (width: number, height: number): number => {
    const aspect = Math.max(0.45, width / Math.max(1, height));
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * aspect;
    const halfX = world.width * 0.5 + 0.75;
    const halfZ = world.height * 0.5 + 0.75;
    const minY = -1.5;
    const maxY = world.levels * cellHeight + 2.5;
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
    return Math.max(46, required * 0.44);
  };
  const updateCameraFit = (width: number, height: number) => {
    const previousFit = cameraFitDistance;
    const previousDistance = camera.position.distanceTo(cameraTarget);
    const currentDirection = camera.position.clone().sub(cameraTarget).normalize();
    cameraFitDistance = fittedDistanceFor(width, height);
    cameraFinal.copy(cameraTarget).addScaledVector(cameraDirection, cameraFitDistance);
    cameraEntry.copy(cameraTarget).addScaledVector(cameraDirection, cameraFitDistance * 1.32);
    controls.minDistance = Math.max(7, cameraFitDistance * 0.055);
    if (controls.maxDistance < 600) controls.maxDistance = Math.max(88, cameraFitDistance * 1.5);
    if (controls.enabled && previousFit > 0) {
      const minZoomRatio = controls.minDistance / cameraFitDistance;
      const maxZoomRatio = controls.maxDistance / cameraFitDistance;
      const zoomRatio = THREE.MathUtils.clamp(previousDistance / previousFit, minZoomRatio, maxZoomRatio);
      camera.position.copy(cameraTarget).addScaledVector(currentDirection, cameraFitDistance * zoomRatio);
      controls.update();
    }
  };

  const risePinch = new PinchTransitionGesture('zoom-out');
  let zoomOutAcc = 0;
  let zoomOutAsked = false;
  const requestZoomOut = () => {
    const frame = readFrame();
    if (frame.cameraMode.kind === 'embodiment') return;
    if (zoomOutAsked || !frame.onZoomOutRequest) return;
    zoomOutAsked = true;
    controls.maxDistance = Math.max(600, controls.maxDistance * 1.8);
    frame.onZoomOutRequest();
  };
  const accumulateZoomOut = (deltaY: number) => {
    const frame = readFrame();
    if (frame.cameraMode.kind === 'embodiment') return;
    if (zoomOutAsked || !frame.onZoomOutRequest) return;
    if (deltaY > 0 && camera.position.distanceTo(controls.target) >= controls.maxDistance - 0.6) {
      zoomOutAcc += deltaY;
      if (zoomOutAcc > 300) requestZoomOut();
    } else {
      zoomOutAcc = 0;
    }
  };

  const pressedKeys = new Set<string>();
  const embodimentPressedKeys = new Set<EmbodimentMovementKey>();
  let emittedEmbodimentHoldDirection: EmbodimentMoveDirection | null = null;
  let emittedEmbodimentHoldCode: EmbodimentMovementKey | null = null;
  const emitEmbodimentHoldDirection = (
    direction: EmbodimentMoveDirection | null,
    requestStep: boolean,
    code: EmbodimentMovementKey | null,
  ) => {
    if (direction === emittedEmbodimentHoldDirection && code === emittedEmbodimentHoldCode) return;
    const directionChanged = direction !== emittedEmbodimentHoldDirection;
    emittedEmbodimentHoldDirection = direction;
    emittedEmbodimentHoldCode = code;
    const frame = readFrame();
    if (directionChanged) frame.onEmbodimentMoveHoldChange?.(direction);
    if (requestStep && direction && directionChanged) frame.onEmbodimentMove?.(direction);
  };

  const cameraMove = new THREE.Vector3();
  const viewForward = new THREE.Vector3();
  const viewRight = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();
  const updateKeyboardCamera = (deltaSeconds: number) => {
    if (embodimentCamera.isActive()) {
      pressedKeys.clear();
      return;
    }
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
        const halfX = Math.max(1, world.width * 0.5 - CAMERA_TARGET_INSET_X);
        const halfZ = Math.max(1, world.height * 0.5 - CAMERA_TARGET_INSET_Z);
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

  let inputAttached = false;
  let onSelectionGestureCancel = () => {};
  let overviewControlsActive = false;
  let onOverviewInteractionChange = (_active: boolean, _embodimentActive: boolean) => {};
  const onWheelOut = (event: WheelEvent) => { accumulateZoomOut(event.deltaY); };
  const onRisePinchPointerDown = (event: PointerEvent) => {
    if (readFrame().cameraMode.kind === 'embodiment' || event.pointerType !== 'touch') return;
    risePinch.pointerDown(event.pointerId, event.clientX, event.clientY);
  };
  const onRisePinchPointerMove = (event: PointerEvent) => {
    if (readFrame().cameraMode.kind === 'embodiment' || event.pointerType !== 'touch') return;
    const update = risePinch.pointerMove(event.pointerId, event.clientX, event.clientY);
    if (update.triggered) requestZoomOut();
  };
  const onRisePinchPointerUp = (event: PointerEvent) => {
    if (event.pointerType === 'touch') risePinch.pointerUp(event.pointerId);
  };
  const onRisePinchPointerCancel = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    risePinch.pointerCancel(event.pointerId);
    risePinch.consumeTapSuppression(event.pointerId);
    onSelectionGestureCancel();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const frame = readFrame();
    if (frame.cameraMode.kind === 'embodiment') {
      if (!isEmbodimentMovementKey(event.code)
        || event.repeat || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
      event.preventDefault();
      const code = event.code;
      embodimentPressedKeys.delete(code);
      embodimentPressedKeys.add(code);
      const direction = embodimentCamera.directionForKey(
        code,
        emittedEmbodimentHoldCode === code ? emittedEmbodimentHoldDirection ?? undefined : undefined,
      );
      frame.onEmbodimentMove?.(direction);
      emitEmbodimentHoldDirection(direction, false, code);
      return;
    }
    if (!HANDLED_OVERVIEW_KEYS.has(event.code)
      || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
    event.preventDefault();
    pressedKeys.add(event.code);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (isEmbodimentMovementKey(event.code)) {
      embodimentPressedKeys.delete(event.code);
      const remainingCode = [...embodimentPressedKeys].at(-1);
      emitEmbodimentHoldDirection(remainingCode
        ? embodimentCamera.directionForKey(
          remainingCode,
          emittedEmbodimentHoldCode === remainingCode
            ? emittedEmbodimentHoldDirection ?? undefined
            : undefined,
        )
        : null, false, remainingCode ?? null);
    }
    pressedKeys.delete(event.code);
    if (event.code === 'ArrowDown' && !zoomOutAsked) zoomOutAcc = 0;
  };
  const clearPressedKeys = () => {
    pressedKeys.clear();
    embodimentPressedKeys.clear();
    emitEmbodimentHoldDirection(null, false, null);
    if (!zoomOutAsked) zoomOutAcc = 0;
  };
  const onControlsStart = () => {
    overviewControlsActive = true;
    onOverviewInteractionChange(true, embodimentCamera.isActive());
  };
  const onControlsEnd = () => {
    overviewControlsActive = false;
    onOverviewInteractionChange(false, embodimentCamera.isActive());
  };
  controls.addEventListener('start', onControlsStart);
  controls.addEventListener('end', onControlsEnd);

  const attachInput = (options: AttachCameraInputOptions) => {
    onSelectionGestureCancel = options.onSelectionGestureCancel;
    if (inputAttached) return;
    inputAttached = true;
    canvas.addEventListener('pointerdown', onRisePinchPointerDown);
    canvas.addEventListener('pointermove', onRisePinchPointerMove);
    canvas.addEventListener('pointerup', onRisePinchPointerUp);
    canvas.addEventListener('pointercancel', onRisePinchPointerCancel);
    canvas.addEventListener('wheel', onWheelOut, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearPressedKeys);
  };

  const resizeCamera = (width: number, height: number) => {
    camera.aspect = width / height;
    if (embodimentCamera.isActive()) {
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    } else {
      camera.setViewOffset(width, height, 0, height * 0.07, width, height);
      updateCameraFit(width, height);
    }
  };

  const frameState: CameraRuntimeFrameState = {
    embodimentActive: false,
    entryProgress: 0,
    overviewControlsActive: false,
  };
  const update = (now: number, deltaSeconds: number): CameraRuntimeFrameState => {
    const entryT = Math.min(1, (now - mountedAt) / 1100);
    const entryE = 1 - Math.pow(1 - entryT, 3);
    const embodimentActive = embodimentCamera.isActive();
    if (embodimentActive) {
      controls.enabled = false;
      embodimentCamera.update(now);
      const heldCode = [...embodimentPressedKeys].at(-1);
      if (heldCode) emitEmbodimentHoldDirection(
        embodimentCamera.directionForKey(
          heldCode,
          emittedEmbodimentHoldCode === heldCode
            ? emittedEmbodimentHoldDirection ?? undefined
            : undefined,
        ),
        true,
        heldCode,
      );
    } else {
      if (embodimentPressedKeys.size) {
        embodimentPressedKeys.clear();
        emitEmbodimentHoldDirection(null, false, null);
      }
      if (entryT < 1) {
        camera.position.lerpVectors(cameraEntry, cameraFinal, entryE);
        camera.lookAt(cameraTarget);
      } else if (!controls.enabled) {
        camera.position.copy(cameraFinal);
        camera.lookAt(cameraTarget);
        controls.enabled = true;
        controls.saveState();
      }
      updateKeyboardCamera(deltaSeconds);
      controls.update();
    }
    frameState.embodimentActive = embodimentActive;
    frameState.entryProgress = entryT;
    frameState.overviewControlsActive = overviewControlsActive;
    return frameState;
  };

  const dispose = () => {
    if (inputAttached) {
      canvas.removeEventListener('pointerdown', onRisePinchPointerDown);
      canvas.removeEventListener('pointermove', onRisePinchPointerMove);
      canvas.removeEventListener('pointerup', onRisePinchPointerUp);
      canvas.removeEventListener('pointercancel', onRisePinchPointerCancel);
      canvas.removeEventListener('wheel', onWheelOut);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearPressedKeys);
      inputAttached = false;
    }
    controls.removeEventListener('start', onControlsStart);
    controls.removeEventListener('end', onControlsEnd);
    controls.dispose();
    embodimentCamera.dispose();
  };

  return {
    camera,
    cameraForward,
    cameraRight,
    cameraUp,
    setMode,
    attachInput,
    setOverviewInteractionListener: (listener) => { onOverviewInteractionChange = listener; },
    consumeSelectionTapSuppression: (pointerId) => risePinch.consumeTapSuppression(pointerId),
    isEmbodimentActive: () => embodimentCamera.isActive(),
    pixelRatioCap: () => embodimentCamera.isActive()
      ? EMBODIMENT_MAX_PIXEL_RATIO
      : SOCIETY_MAX_PIXEL_RATIO,
    resizeCamera,
    copyOverviewTarget: (target) => target.copy(controls.target),
    overviewDistanceRatio: () => camera.position.distanceTo(controls.target) / Math.max(1, cameraFitDistance),
    isZoomOutTransitionRequested: () => zoomOutAsked,
    update,
    dispose,
  };
}
