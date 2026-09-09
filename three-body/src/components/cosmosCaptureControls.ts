import type * as THREE from 'three';
import type { CosmosSnapshot } from '@/game/societyContract';

export type CosmosCaptureVector = readonly [number, number, number];

export interface CosmosCaptureCameraPose {
  position: CosmosCaptureVector;
  target: CosmosCaptureVector;
  fov?: number;
}

export interface ThreeBodyCaptureApi {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  /** Increasing presentation time; physics advances through the original RK4 engine. */
  renderAt(timeMs: number): void;
  setCamera(pose: CosmosCaptureCameraPose): void;
  /** Enables the existing planet materialization/focus presentation. */
  focusPlanet(active?: boolean): void;
  getSnapshot(): CosmosSnapshot | null;
  getPlanet(): { position: CosmosCaptureVector; radius: number; viewRadius: number } | null;
  resize(): void;
}

export interface ThreeBodyCaptureOptions {
  /** Defaults to true. */
  manual?: boolean;
  /** Defaults to one: native containing element resolution. */
  pixelRatio?: number;
  onReady(api: ThreeBodyCaptureApi | null): void;
}

export interface AtmosphereCaptureApi {
  readonly renderer: THREE.WebGLRenderer;
  readonly durationMs: number;
  /** Milliseconds since this transition began, from zero to durationMs. */
  renderAt(elapsedMs: number): void;
  resize(): void;
}

export interface AtmosphereCaptureOptions {
  /** Defaults to true. */
  manual?: boolean;
  pixelRatio?: number;
  onReady(api: AtmosphereCaptureApi | null): void;
}
