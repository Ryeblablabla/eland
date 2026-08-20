export type PinchTransitionDirection = 'zoom-in' | 'zoom-out';

export interface PinchTransitionUpdate {
  active: boolean;
  progress: number;
  progressRatio: number;
  triggered: boolean;
}

interface PointerPosition {
  x: number;
  y: number;
}

/**
 * A deliberate scene transition needs about a 45% two-finger scale change.
 * Progress is accumulated in log scale so the threshold behaves the same on
 * small and large canvases, while small reversals naturally unwind progress.
 */
export const PINCH_TRANSITION_SCALE = 1.45;
export const PINCH_TRANSITION_THRESHOLD = Math.log(PINCH_TRANSITION_SCALE);

export class PinchTransitionGesture {
  private readonly pointers = new Map<number, PointerPosition>();
  private readonly suppressedTapPointers = new Set<number>();
  private previousDistance: number | null = null;
  private accumulatedProgress = 0;
  private triggered = false;
  private blockedUntilRelease = false;
  private readonly direction: PinchTransitionDirection;
  private readonly threshold: number;

  constructor(
    direction: PinchTransitionDirection,
    threshold = PINCH_TRANSITION_THRESHOLD,
  ) {
    if (!(threshold > 0)) throw new Error('pinch transition threshold must be positive');
    this.direction = direction;
    this.threshold = threshold;
  }

  pointerDown(pointerId: number, x: number, y: number): PinchTransitionUpdate {
    this.pointers.set(pointerId, { x, y });
    if (this.pointers.size === 2 && !this.blockedUntilRelease) {
      for (const id of this.pointers.keys()) this.suppressedTapPointers.add(id);
      this.previousDistance = this.distanceBetweenPointers();
      this.accumulatedProgress = 0;
    } else if (this.pointers.size > 2) {
      for (const id of this.pointers.keys()) this.suppressedTapPointers.add(id);
      this.blockedUntilRelease = true;
      this.previousDistance = null;
      this.accumulatedProgress = 0;
    }
    return this.snapshot(false);
  }

  pointerMove(pointerId: number, x: number, y: number): PinchTransitionUpdate {
    if (!this.pointers.has(pointerId)) return this.snapshot(false);
    this.pointers.set(pointerId, { x, y });
    if (this.blockedUntilRelease || this.pointers.size !== 2 || this.triggered) {
      return this.snapshot(false);
    }

    const distance = this.distanceBetweenPointers();
    const previousDistance = this.previousDistance;
    this.previousDistance = distance;
    if (previousDistance === null || previousDistance <= 0 || distance <= 0) {
      return this.snapshot(false);
    }

    const scaleDelta = Math.log(distance / previousDistance);
    const directedDelta = this.direction === 'zoom-in' ? scaleDelta : -scaleDelta;
    this.accumulatedProgress = Math.max(0, this.accumulatedProgress + directedDelta);
    if (this.accumulatedProgress < this.threshold) return this.snapshot(false);

    this.triggered = true;
    return this.snapshot(true);
  }

  pointerUp(pointerId: number): PinchTransitionUpdate {
    this.pointers.delete(pointerId);
    this.previousDistance = null;
    this.accumulatedProgress = 0;
    if (this.pointers.size === 0) {
      this.triggered = false;
      this.blockedUntilRelease = false;
    }
    return this.snapshot(false);
  }

  pointerCancel(pointerId: number): PinchTransitionUpdate {
    if (this.pointers.size > 1) {
      for (const id of this.pointers.keys()) this.suppressedTapPointers.add(id);
    }
    this.blockedUntilRelease = this.pointers.size > 1;
    return this.pointerUp(pointerId);
  }

  consumeTapSuppression(pointerId: number): boolean {
    const suppressed = this.suppressedTapPointers.has(pointerId);
    this.suppressedTapPointers.delete(pointerId);
    return suppressed;
  }

  private distanceBetweenPointers(): number {
    const [left, right] = [...this.pointers.values()];
    return left && right ? Math.hypot(right.x - left.x, right.y - left.y) : 0;
  }

  private snapshot(triggered: boolean): PinchTransitionUpdate {
    return {
      active: this.pointers.size === 2 && !this.blockedUntilRelease,
      progress: this.accumulatedProgress,
      progressRatio: Math.min(1, this.accumulatedProgress / this.threshold),
      triggered,
    };
  }
}
