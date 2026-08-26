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
// Horizontal steps should feel immediate while height changes keep enough
// weight to read as stepping up/down instead of riding a linear lift.
const HORIZONTAL_SMOOTH_TIME_SECONDS = 0.095;
const VERTICAL_SMOOTH_TIME_SECONDS = 0.14;
const MAX_HORIZONTAL_SPEED = 8.5;
const MAX_VERTICAL_SPEED = 5.5;
const HORIZONTAL_SETTLE_DISTANCE = 0.004;
const VERTICAL_SETTLE_DISTANCE = 0.003;
const HORIZONTAL_SETTLE_SPEED = 0.075;
const VERTICAL_SETTLE_SPEED = 0.06;
const DRAG_RADIANS_PER_PIXEL = 0.002;
const UP = new THREE.Vector3(0, 1, 0);

export interface SmoothDampStep {
  value: number;
  velocity: number;
}

/**
 * Advances one critically damped axis with the analytic spring solution.
 *
 * The exponential solution makes the response depend on elapsed time rather
 * than frame count. The travel and velocity caps keep delayed/corrective
 * anchors finite, while the crossing guard prevents spring overshoot.
 */
export function smoothDampAxis(
  current: number,
  target: number,
  velocity: number,
  deltaSeconds: number,
  smoothTimeSeconds: number,
  maxSpeed: number,
): SmoothDampStep {
  if (deltaSeconds <= 0) {
    return { value: current, velocity };
  }
  if (current === target) return { value: target, velocity: 0 };

  const smoothTime = Math.max(0.001, smoothTimeSeconds);
  const omega = 2 / smoothTime;
  const offset = current - target;
  const spring = velocity + omega * offset;
  const decay = Math.exp(-omega * deltaSeconds);
  let nextValue = target + (offset + spring * deltaSeconds) * decay;
  let nextVelocity = (velocity - omega * spring * deltaSeconds) * decay;

  const speedLimit = Math.max(0, maxSpeed);
  const maxTravel = speedLimit * deltaSeconds;
  const travel = nextValue - current;
  if (Math.abs(travel) > maxTravel) {
    nextValue = current + Math.sign(travel) * maxTravel;
    nextVelocity = Math.sign(travel) * speedLimit;
  } else {
    nextVelocity = THREE.MathUtils.clamp(nextVelocity, -speedLimit, speedLimit);
  }

  const remainingBefore = target - current;
  const remainingAfter = target - nextValue;
  if (remainingBefore !== 0 && remainingBefore * remainingAfter <= 0) {
    return { value: target, velocity: 0 };
  }
  return { value: nextValue, velocity: nextVelocity };
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
  private readonly moveTo = new THREE.Vector3();
  private readonly moveVelocity = new THREE.Vector3();
  private readonly lookDirection = new THREE.Vector3();
  private readonly movementDirection = new THREE.Vector3();
  private readonly movementRight = new THREE.Vector3();
  private readonly lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly dragPointer = { id: -1, x: 0, y: 0 };
  private readonly reducedMotionQuery = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  private active = false;
  private moving = false;
  private lastMoveUpdatedAt: number | null = null;
  private settledNotified = true;
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
    this.moveTo.set(anchor.x, anchor.y, anchor.z);
    this.resetMotion();
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
    this.settledNotified = false;
    this.notifySettled();
  }

  setAnchor(anchor: EmbodimentCameraAnchor, animate = true): void {
    if (!this.active) return;
    const reducedMotion = this.reducedMotionQuery?.matches ?? false;
    const isCurrentTarget = Math.abs(this.moveTo.x - anchor.x) < 1e-4
      && Math.abs(this.moveTo.y - anchor.y) < 1e-4
      && Math.abs(this.moveTo.z - anchor.z) < 1e-4;
    if (isCurrentTarget) {
      // A speculative anchor and its later authoritative confirmation often
      // resolve to the same place. Preserve the in-flight motion instead of
      // restarting it and making a successful step feel twice as long.
      if (this.moving && (!animate || reducedMotion)) {
        this.camera.position.copy(this.moveTo);
        this.resetMotion();
        this.camera.updateMatrixWorld();
        this.notifySettled();
      }
      return;
    }

    this.moveTo.set(anchor.x, anchor.y, anchor.z);
    this.settledNotified = false;
    if (this.moveTo.distanceToSquared(this.camera.position) < 1e-8) {
      this.camera.position.copy(this.moveTo);
      this.resetMotion();
      this.camera.updateMatrixWorld();
      this.notifySettled();
      return;
    }

    if (!animate || reducedMotion) {
      this.camera.position.copy(this.moveTo);
      this.resetMotion();
      this.camera.updateMatrixWorld();
      this.notifySettled();
      return;
    }

    // A new target changes only the spring destination. Keeping both the
    // current position and velocity lets held movement flow through adjacent
    // authoritative cells and lets a correction bend the same motion back.
    if (!this.moving) this.lastMoveUpdatedAt = performance.now();
    this.moving = true;
  }

  update(now: number): void {
    if (!this.active || !this.moving) return;
    if (this.reducedMotionQuery?.matches) {
      this.camera.position.copy(this.moveTo);
      this.resetMotion();
      this.camera.updateMatrixWorld();
      this.notifySettled();
      return;
    }

    if (this.lastMoveUpdatedAt === null || now <= this.lastMoveUpdatedAt) {
      this.lastMoveUpdatedAt = now;
      return;
    }
    const deltaSeconds = (now - this.lastMoveUpdatedAt) / 1_000;
    this.lastMoveUpdatedAt = now;

    const x = smoothDampAxis(
      this.camera.position.x,
      this.moveTo.x,
      this.moveVelocity.x,
      deltaSeconds,
      HORIZONTAL_SMOOTH_TIME_SECONDS,
      Number.POSITIVE_INFINITY,
    );
    const z = smoothDampAxis(
      this.camera.position.z,
      this.moveTo.z,
      this.moveVelocity.z,
      deltaSeconds,
      HORIZONTAL_SMOOTH_TIME_SECONDS,
      Number.POSITIVE_INFINITY,
    );
    const y = smoothDampAxis(
      this.camera.position.y,
      this.moveTo.y,
      this.moveVelocity.y,
      deltaSeconds,
      VERTICAL_SMOOTH_TIME_SECONDS,
      MAX_VERTICAL_SPEED,
    );

    let horizontalX = x.value - this.camera.position.x;
    let horizontalZ = z.value - this.camera.position.z;
    const horizontalTravel = Math.hypot(horizontalX, horizontalZ);
    const maxHorizontalTravel = MAX_HORIZONTAL_SPEED * deltaSeconds;
    if (horizontalTravel > maxHorizontalTravel) {
      const travelScale = maxHorizontalTravel / horizontalTravel;
      horizontalX *= travelScale;
      horizontalZ *= travelScale;
      this.moveVelocity.set(
        horizontalX / deltaSeconds,
        y.velocity,
        horizontalZ / deltaSeconds,
      );
    } else {
      let horizontalVelocityX = x.velocity;
      let horizontalVelocityZ = z.velocity;
      const horizontalSpeed = Math.hypot(horizontalVelocityX, horizontalVelocityZ);
      if (horizontalSpeed > MAX_HORIZONTAL_SPEED) {
        const velocityScale = MAX_HORIZONTAL_SPEED / horizontalSpeed;
        horizontalVelocityX *= velocityScale;
        horizontalVelocityZ *= velocityScale;
      }
      this.moveVelocity.set(horizontalVelocityX, y.velocity, horizontalVelocityZ);
    }
    this.camera.position.set(
      this.camera.position.x + horizontalX,
      y.value,
      this.camera.position.z + horizontalZ,
    );
    this.camera.updateMatrixWorld();

    const horizontalRemaining = Math.hypot(
      this.moveTo.x - this.camera.position.x,
      this.moveTo.z - this.camera.position.z,
    );
    const horizontalSpeed = Math.hypot(this.moveVelocity.x, this.moveVelocity.z);
    if (horizontalRemaining > HORIZONTAL_SETTLE_DISTANCE
      || Math.abs(this.moveTo.y - this.camera.position.y) > VERTICAL_SETTLE_DISTANCE
      || horizontalSpeed > HORIZONTAL_SETTLE_SPEED
      || Math.abs(this.moveVelocity.y) > VERTICAL_SETTLE_SPEED) return;

    this.camera.position.copy(this.moveTo);
    this.resetMotion();
    this.camera.updateMatrixWorld();
    this.notifySettled();
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.resetMotion();
    this.settledNotified = true;
    this.dragPointer.id = -1;
    this.pointerControls.enabled = false;
    if (this.pointerControls.isLocked) this.pointerControls.unlock();
    this.camera.position.copy(this.overviewPosition);
    this.camera.quaternion.copy(this.overviewQuaternion);
    this.camera.fov = this.overviewFov;
    this.camera.updateProjectionMatrix();
  }

  private resetMotion(): void {
    this.moving = false;
    this.lastMoveUpdatedAt = null;
    this.moveVelocity.set(0, 0, 0);
  }

  private notifySettled(): void {
    if (this.settledNotified) return;
    this.settledNotified = true;
    this.onSettled?.();
  }

  directionForKey(
    code: 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD',
    previousDirection?: EmbodimentMoveDirection,
  ): EmbodimentMoveDirection {
    this.camera.getWorldDirection(this.movementDirection);
    this.movementDirection.y = 0;
    if (this.movementDirection.lengthSq() < 1e-6) this.movementDirection.set(0, 0, -1);
    this.movementDirection.normalize();
    this.movementRight.crossVectors(this.movementDirection, UP).normalize();
    if (code === 'KeyS') this.movementDirection.multiplyScalar(-1);
    else if (code === 'KeyA') this.movementDirection.copy(this.movementRight).multiplyScalar(-1);
    else if (code === 'KeyD') this.movementDirection.copy(this.movementRight);

    const nextDirection: EmbodimentMoveDirection = Math.abs(this.movementDirection.x) > Math.abs(this.movementDirection.z)
      ? this.movementDirection.x >= 0 ? 'east' : 'west'
      : this.movementDirection.z >= 0 ? 'south' : 'north';
    if (!previousDirection || previousDirection === nextDirection) return nextDirection;

    const previousDot = previousDirection === 'east' ? this.movementDirection.x
      : previousDirection === 'west' ? -this.movementDirection.x
        : previousDirection === 'south' ? this.movementDirection.z
          : -this.movementDirection.z;
    // Cardinal snapping normally changes at 45 degrees. Retain the previous
    // sector until 53 degrees so tiny mouse motion cannot alternate queued
    // authority steps around a diagonal boundary.
    return previousDot >= Math.cos(THREE.MathUtils.degToRad(53))
      ? previousDirection
      : nextDirection;
  }

  requestPointerLock(): void {
    if (!this.active || this.pointerControls.isLocked) return;
    if (typeof this.canvas.requestPointerLock !== 'function') return;
    try {
      const requested = this.canvas.requestPointerLock();
      if (requested && typeof requested.catch === 'function') void requested.catch(() => undefined);
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
    if (this.dragPointer.id >= 0 && this.canvas.hasPointerCapture?.(this.dragPointer.id)) {
      this.canvas.releasePointerCapture(this.dragPointer.id);
    }
    this.dragPointer.id = -1;
    this.onPointerLockChange?.(true);
  };

  private readonly handlePointerUnlock = () => {
    this.onPointerLockChange?.(false);
  };

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (!this.active || event.button !== 0) return;
    this.dragPointer.id = event.pointerId;
    this.dragPointer.x = event.clientX;
    this.dragPointer.y = event.clientY;
    this.canvas.setPointerCapture?.(event.pointerId);
    if (event.pointerType === 'mouse' && typeof this.canvas.requestPointerLock === 'function') {
      this.requestPointerLock();
      return;
    }
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
