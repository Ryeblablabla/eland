import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

export type EmbodimentMoveDirection = 'north' | 'south' | 'east' | 'west';

export interface EmbodimentCameraAnchor {
  x: number;
  y: number;
  z: number;
}

interface EmbodimentCameraControllerOptions {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  onPointerLockChange?: (locked: boolean) => void;
  onSettled?: () => void;
}

const FIRST_PERSON_FOV = 63;
const MOVE_DURATION_MS = 420;
const DRAG_RADIANS_PER_PIXEL = 0.002;
const UP = new THREE.Vector3(0, 1, 0);

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Presentation-only first-person camera controller.
 *
 * It never advances an actor or resolves collision. New anchors are supplied by
 * an authoritative society projection after the server has accepted a tick.
 */
export class EmbodimentCameraController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly pointerControls: PointerLockControls;
  private readonly overviewPosition = new THREE.Vector3();
  private readonly overviewQuaternion = new THREE.Quaternion();
  private readonly moveFrom = new THREE.Vector3();
  private readonly moveTo = new THREE.Vector3();
  private readonly lookDirection = new THREE.Vector3();
  private readonly movementDirection = new THREE.Vector3();
  private readonly movementRight = new THREE.Vector3();
  private readonly lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly dragPointer = { id: -1, x: 0, y: 0 };

  private active = false;
  private moving = false;
  private moveStartedAt = 0;
  private overviewFov = 31;
  private onPointerLockChange?: (locked: boolean) => void;
  private onSettled?: () => void;

  constructor(options: EmbodimentCameraControllerOptions) {
    this.camera = options.camera;
    this.canvas = options.canvas;
    this.onPointerLockChange = options.onPointerLockChange;
    this.onSettled = options.onSettled;
    this.pointerControls = new PointerLockControls(this.camera, this.canvas);
    this.pointerControls.enabled = false;
    this.pointerControls.pointerSpeed = 0.75;
    this.pointerControls.minPolarAngle = THREE.MathUtils.degToRad(18);
    this.pointerControls.maxPolarAngle = THREE.MathUtils.degToRad(162);
    this.pointerControls.addEventListener('lock', this.handlePointerLock);
    this.pointerControls.addEventListener('unlock', this.handlePointerUnlock);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
  }

  setCallbacks(callbacks: {
    onPointerLockChange?: (locked: boolean) => void;
    onSettled?: () => void;
  }): void {
    this.onPointerLockChange = callbacks.onPointerLockChange;
    this.onSettled = callbacks.onSettled;
  }

  isActive(): boolean {
    return this.active;
  }

  isPointerLocked(): boolean {
    return this.pointerControls.isLocked;
  }

  isInterpolating(): boolean {
    return this.moving;
  }

  enter(anchor: EmbodimentCameraAnchor): void {
    if (!this.active) {
      this.overviewPosition.copy(this.camera.position);
      this.overviewQuaternion.copy(this.camera.quaternion);
      this.overviewFov = this.camera.fov;
    }
    this.active = true;
    this.pointerControls.enabled = true;
    this.moving = false;
    this.camera.fov = FIRST_PERSON_FOV;
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();

    // Preserve the useful horizontal bearing of the overview camera, but begin
    // at eye level instead of carrying its downward miniature-view pitch over.
    this.camera.getWorldDirection(this.lookDirection);
    this.lookDirection.y = 0;
    if (this.lookDirection.lengthSq() < 1e-6) this.lookDirection.set(0, 0, -1);
    this.lookDirection.normalize();
    this.camera.position.set(anchor.x, anchor.y, anchor.z);
    this.camera.lookAt(this.camera.position.clone().add(this.lookDirection));
    this.camera.updateMatrixWorld();
    this.onSettled?.();
  }

  setAnchor(anchor: EmbodimentCameraAnchor, animate = true): void {
    if (!this.active) return;
    this.moveTo.set(anchor.x, anchor.y, anchor.z);
    if (this.moveTo.distanceToSquared(this.camera.position) < 1e-8) {
      this.camera.position.copy(this.moveTo);
      this.moving = false;
      this.onSettled?.();
      return;
    }
    this.moveFrom.copy(this.camera.position);
    this.moveStartedAt = performance.now();
    this.moving = animate && !prefersReducedMotion();
    if (!this.moving) {
      this.camera.position.copy(this.moveTo);
      this.camera.updateMatrixWorld();
      this.onSettled?.();
    }
  }

  update(now: number): void {
    if (!this.active || !this.moving) return;
    const progress = THREE.MathUtils.clamp((now - this.moveStartedAt) / MOVE_DURATION_MS, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    this.camera.position.lerpVectors(this.moveFrom, this.moveTo, eased);
    if (progress < 1) return;
    this.camera.position.copy(this.moveTo);
    this.moving = false;
    this.onSettled?.();
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.moving = false;
    this.dragPointer.id = -1;
    this.pointerControls.enabled = false;
    if (this.pointerControls.isLocked) this.pointerControls.unlock();
    this.camera.position.copy(this.overviewPosition);
    this.camera.quaternion.copy(this.overviewQuaternion);
    this.camera.fov = this.overviewFov;
    this.camera.updateProjectionMatrix();
  }

  directionForKey(code: 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD'): EmbodimentMoveDirection {
    this.camera.getWorldDirection(this.movementDirection);
    this.movementDirection.y = 0;
    if (this.movementDirection.lengthSq() < 1e-6) this.movementDirection.set(0, 0, -1);
    this.movementDirection.normalize();
    this.movementRight.crossVectors(this.movementDirection, UP).normalize();
    if (code === 'KeyS') this.movementDirection.multiplyScalar(-1);
    else if (code === 'KeyA') this.movementDirection.copy(this.movementRight).multiplyScalar(-1);
    else if (code === 'KeyD') this.movementDirection.copy(this.movementRight);

    if (Math.abs(this.movementDirection.x) > Math.abs(this.movementDirection.z)) {
      return this.movementDirection.x >= 0 ? 'east' : 'west';
    }
    return this.movementDirection.z >= 0 ? 'south' : 'north';
  }

  requestPointerLock(): void {
    if (!this.active || this.pointerControls.isLocked) return;
    if (typeof this.canvas.requestPointerLock !== 'function') return;
    try {
      this.pointerControls.lock();
    } catch {
      // Drag-look remains available when the browser rejects Pointer Lock.
    }
  }

  dispose(): void {
    this.leave();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.pointerControls.removeEventListener('lock', this.handlePointerLock);
    this.pointerControls.removeEventListener('unlock', this.handlePointerUnlock);
    this.pointerControls.dispose();
  }

  private readonly handlePointerLock = () => {
    this.onPointerLockChange?.(true);
  };

  private readonly handlePointerUnlock = () => {
    this.onPointerLockChange?.(false);
  };

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (!this.active || event.button !== 0) return;
    if (event.pointerType === 'mouse' && typeof this.canvas.requestPointerLock === 'function') {
      this.requestPointerLock();
      return;
    }
    this.dragPointer.id = event.pointerId;
    this.dragPointer.x = event.clientX;
    this.dragPointer.y = event.clientY;
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.active || this.dragPointer.id !== event.pointerId) return;
    const movementX = event.clientX - this.dragPointer.x;
    const movementY = event.clientY - this.dragPointer.y;
    this.dragPointer.x = event.clientX;
    this.dragPointer.y = event.clientY;
    this.lookEuler.setFromQuaternion(this.camera.quaternion);
    this.lookEuler.y -= movementX * DRAG_RADIANS_PER_PIXEL;
    this.lookEuler.x = THREE.MathUtils.clamp(
      this.lookEuler.x - movementY * DRAG_RADIANS_PER_PIXEL,
      THREE.MathUtils.degToRad(-72),
      THREE.MathUtils.degToRad(72),
    );
    this.camera.quaternion.setFromEuler(this.lookEuler);
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (this.dragPointer.id !== event.pointerId) return;
    this.dragPointer.id = -1;
    this.canvas.releasePointerCapture?.(event.pointerId);
  };
}
