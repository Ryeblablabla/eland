import type * as THREE from 'three';

export type SocietyCaptureVector = readonly [number, number, number];

/** Presentation-only camera pose, in the renderer's existing world coordinates. */
export interface SocietyCaptureCameraPose {
  position: SocietyCaptureVector;
  target: SocietyCaptureVector;
  fov?: number;
}

export interface SocietyCaptureApi {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  /** Call with increasing presentation timestamps to advance the official visual layers. */
  renderAt(timeMs: number): void;
  setCamera(pose: SocietyCaptureCameraPose): void;
  /** Sets the start of the current authoritative month's recorded path playback. */
  setPlaybackStart(timeMs: number): void;
  getAgentPosition(agentId: string): SocietyCaptureVector | null;
  /** Reads the containing element's native dimensions. */
  resize(): void;
}

/** Opt-in at scene mount; absent in ordinary play. No method mutates SocietyState. */
export interface SocietyCaptureOptions {
  /** Defaults to true: no requestAnimationFrame loop or visibility pause. */
  manual?: boolean;
  /** Defaults to one, giving exactly the containing element's native resolution. */
  pixelRatio?: number;
  /** Defaults to true for a sharp source render. */
  disableTiltShift?: boolean;
  hideNameLabels?: boolean;
  hideSpeech?: boolean;
  onReady(api: SocietyCaptureApi | null): void;
}
