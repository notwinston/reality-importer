/**
 * FROZEN CROSS-MODULE CONTRACTS.
 *
 * This file plus src/bus.ts is the integration spine that the three parallel
 * wave-2 loops (scan / showcase / hands) code against. NOBODY edits this file
 * until wave-3 integration. Enumerate generously — it is cheaper to ship an
 * unused event than to need one mid-wave when the file is frozen.
 *
 * Confirmed addon import path for three@0.184 + @types/three@0.184:
 *   three/examples/jsm/...   (also aliased as three/addons/... at runtime)
 */
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { World as RapierWorld } from '@dimforge/rapier3d-compat';
import type { Bus } from './bus';

/** A thing that exists in the room: a test prop, a flat standee, or a real mesh. */
export interface SpawnedObject {
  id: number;
  kind: 'test' | 'standee' | 'mesh';
  root: THREE.Object3D;
  label?: string;
}

/**
 * Event payload map. The first eight entries are the REQUIRED contract; the rest
 * are pre-declared conveniences so wave-2 modules never need to touch this file.
 */
export type RIEvents = {
  // ── required ────────────────────────────────────────────────────────────
  'scan:start': { id: number };
  'scan:cutout': { id: number; url: string; ms: number };
  'scan:mesh': { id: number; url: string; ms: number };
  'scan:error': { id: number; stage: 'cutout' | 'mesh' | 'capture'; message: string };
  'showcase:released': { id: number };
  'hud:toast': { message: string };
  /** Emitted once per landed pipeline call; only the relevant field is set. */
  'hud:latency': { id: number; standeeMs?: number; meshMs?: number };
  'mode:demo': { on: boolean };

  // ── pre-declared extras (generous; may go unused this wave) ──────────────
  /** Webcam frame grabbed, before any network call. */
  'scan:capture': { id: number };
  /** Showcase has taken ownership of an id and begun the import sequence. */
  'showcase:import': { id: number };
  /** Showcase placed the real mesh on the pedestal (inflate complete). */
  'showcase:placed': { id: number };
  /** Hands tracking turned on/off. */
  'hands:state': { enabled: boolean };
  /** Per-frame pinch in normalized [0..1] webcam space (mirrored). */
  'hands:pinch': { x: number; y: number; grabbing: boolean };
  /** A grab/release of a physical object by the hand or mouse. */
  'world:grab': { id: number };
  'world:release': { id: number };
  /** Duplicate-rain fired. */
  'world:duplicated': { count: number };
  /** Gravity flip toggled for `ms`. */
  'world:gravity': { ms: number };
  /** Room cleared / reset. */
  'world:reset': Record<string, never>;
};

/** Shorthand for the project-wide typed bus. */
export type RIBus = Bus<RIEvents>;

/** Collider description handed to WorldApi.addBody. */
export type ColliderSpec =
  | { type: 'hull' }
  | { type: 'box'; size: [number, number, number] };

/** Optional spawn parameters for WorldApi.addBody. */
export interface AddBodyOpts {
  kind?: SpawnedObject['kind'];
  position?: THREE.Vector3;
  velocity?: THREE.Vector3;
  angularVelocity?: THREE.Vector3;
  /** Spawn as a kinematic body (showcase pedestal, hand-held). */
  kinematic?: boolean;
}

/**
 * The 3D room + physics + camera + postprocessing surface. Owned by src/world.ts
 * and FROZEN after wave 1. All wave-2 modules drive the scene exclusively through
 * these methods.
 */
export interface WorldApi {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly rapierWorld: RapierWorld;
  /** The mirrored selfie <video>, or null when no camera was granted. */
  webcamVideo: HTMLVideoElement | null;

  /** Add a physics body wrapping `root`. Hull colliders decimate to <=1024 verts. */
  addBody(root: THREE.Object3D, collider: ColliderSpec, opts?: AddBodyOpts): SpawnedObject;
  removeObject(id: number): void;
  objects(): SpawnedObject[];
  /** Nearest spawned object to `point` within `maxDist`, else null (for grabbing). */
  nearestObject(point: THREE.Vector3, maxDist: number): SpawnedObject | null;

  setKinematic(id: number, on: boolean): void;
  /** Move a kinematic body. If `quat` is given the mesh rotation is driven too. */
  moveKinematic(id: number, pos: THREE.Vector3, quat?: THREE.Quaternion): void;
  applyVelocity(id: number, v: THREE.Vector3, angular?: THREE.Vector3): void;

  /** Clone the most recent non-test object `count` times (capped) — duplicate rain. */
  duplicateLast(count: number): void;
  reset(): void;
  /** Invert gravity for `ms`, then restore. */
  flipGravity(ms: number): void;

  /** Tween the orbit target onto `target` and ease autorotate off (import focus). */
  focusCamera(target: THREE.Vector3, ms: number): void;
  releaseCameraFocus(): void;
  /** Briefly ramp bloom strength ~2x and back (the materialize pop). */
  pulseBloom(ms: number): void;
}

/** Scan module surface — turns a webcam frame into scan:* events. */
export interface ScanApi {
  scan(): Promise<void>;
}

/** Showcase module surface — owns the pedestal import choreography. */
export interface ShowcaseApi {
  /** Idempotent per id. Showcase also self-subscribes to scan:* events. */
  beginImport(id: number): void;
}

/** Hands module surface — MediaPipe pinch-grab toggle. */
export interface HandsApi {
  enabled: boolean;
  toggle(): Promise<void>;
}

/** The context object threaded into every module initializer. */
export interface RIContext {
  bus: RIBus;
  world: WorldApi;
  demoMode(): boolean;
}

/** Module initializer signatures — the exact shape wave 2 must keep. */
export type InitScan = (ctx: RIContext) => ScanApi;
export type InitShowcase = (ctx: RIContext) => ShowcaseApi;
export type InitHands = (ctx: RIContext) => HandsApi;
