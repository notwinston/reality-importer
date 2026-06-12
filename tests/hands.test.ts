/**
 * Tests for src/hands.ts — TESTS ARE SPEC.
 *
 * Unit 1: pure math (hysteresis, smoothing, mirror, ray, velocityFromTrail,
 * pickAlongRay). Unit 3: the mocked tracking runtime (grab→move→throw, graceful
 * release, init rejection, disable mid-grip). Runs in vitest's node environment,
 * so the runtime tests disable the overlay/glow DOM seams and step frames by hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  pinchDistance,
  isPinching,
  smoothPoint,
  mirrorX,
  screenToRay,
  velocityFromTrail,
  pickAlongRay,
  createHands,
  initHands,
  PINCH_ENGAGE,
  PINCH_RELEASE,
  type Lm,
} from '../src/hands';
import type { SpawnedObject } from '../src/types';

// ── MediaPipe mock (scripted detector) ───────────────────────────────────────
const h = vi.hoisted(() => ({
  queue: [] as Array<{ landmarks: Lm[][] }>,
  fail: false,
}));
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  HandLandmarker: {
    createFromOptions: async () => {
      if (h.fail) throw new Error('model load failed');
      return { detectForVideo: () => h.queue.shift() ?? { landmarks: [] } };
    },
  },
}));

beforeEach(() => {
  h.queue = [];
  h.fail = false;
});

// A 21-landmark hand whose thumb(4)/index(8) tips sit at the given x's (same y).
function hand(thumbX: number, indexX: number, y = 0.5): Lm[] {
  const lm: Lm[] = Array.from({ length: 21 }, () => ({ x: 0.5, y, z: 0 }));
  lm[4] = { x: thumbX, y, z: 0 };
  lm[8] = { x: indexX, y, z: 0 };
  return lm;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit 1 — pure math
// ─────────────────────────────────────────────────────────────────────────────
describe('pure math core', () => {
  it('pinchDistance is the 3D tip-to-tip distance', () => {
    const lm = hand(0.5, 0.5);
    expect(pinchDistance(lm)).toBeCloseTo(0, 6);
    expect(pinchDistance(hand(0.4, 0.6))).toBeCloseTo(0.2, 6);
  });

  it('isPinching hysteresis engages below 0.055 and releases above 0.075', () => {
    expect(PINCH_ENGAGE).toBe(0.055);
    expect(PINCH_RELEASE).toBe(0.075);
    // engage boundary
    expect(isPinching(0.054, false)).toBe(true);
    expect(isPinching(0.06, false)).toBe(false); // in the dead band, not yet engaged
    // release boundary (already pinching)
    expect(isPinching(0.07, true)).toBe(true); // dead band keeps the grip
    expect(isPinching(0.076, true)).toBe(false);
  });

  it('smoothPoint converges onto a held point', () => {
    const buf: { x: number; y: number }[] = [];
    expect(smoothPoint(buf, { x: 1, y: 1 })).toEqual({ x: 1, y: 1 }); // first sample = itself
    let r = { x: 0, y: 0 };
    for (let i = 0; i < 8; i++) r = smoothPoint(buf, { x: 1, y: 1 });
    expect(r.x).toBeCloseTo(1, 6);
    expect(r.y).toBeCloseTo(1, 6);
    expect(buf.length).toBeLessThanOrEqual(5); // window trimmed
  });

  it('mirror maps x -> 1 - x and preserves the other coords', () => {
    expect(mirrorX({ x: 0.3, y: 0.7 })).toEqual({ x: 0.7, y: 0.7 });
    expect(mirrorX({ x: 0.1, y: 0.2, z: 0.9 })).toEqual({ x: 0.9, y: 0.2, z: 0.9 });
  });

  it('screenToRay returns a THREE.Ray pointing into the scene', () => {
    const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    cam.position.set(0, 0, 5);
    cam.updateMatrixWorld();
    const ray = screenToRay(0, 0, cam);
    expect(ray).toBeInstanceOf(THREE.Ray);
    expect(ray.direction.z).toBeLessThan(0); // looking down -z toward origin
  });

  it('velocityFromTrail recovers a known constant velocity', () => {
    const trail = [
      { p: new THREE.Vector3(0, 0, 0), t: 0 },
      { p: new THREE.Vector3(1, 0, 0), t: 100 },
      { p: new THREE.Vector3(2, 0, 0), t: 200 },
    ];
    const v = velocityFromTrail(trail); // 1 unit / 0.1s = 10 u/s
    expect(v.x).toBeCloseTo(10, 6);
    expect(v.y).toBeCloseTo(0, 6);
    expect(velocityFromTrail([trail[0]]).length()).toBe(0); // <2 samples = no throw
  });

  it('pickAlongRay returns the nearest object within radius, else null', () => {
    const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    cam.position.set(0, 0, 5);
    cam.updateMatrixWorld();
    const ray = screenToRay(0, 0, cam); // through the origin
    const near = obj(1, 0, 0, 0);
    const far = obj(2, 5, 0, 0);
    expect(pickAlongRay([far, near], ray, 0.6)?.id).toBe(1);
    expect(pickAlongRay([far], ray, 0.6)).toBeNull(); // none within radius
  });
});

function obj(id: number, x: number, y: number, z: number): SpawnedObject {
  const root = new THREE.Object3D();
  root.position.set(x, y, z);
  return { id, kind: 'mesh', root } as SpawnedObject;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit 3 — mocked tracking runtime
// ─────────────────────────────────────────────────────────────────────────────
function makeCtx() {
  const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  cam.position.set(0, 0, 5);
  cam.updateMatrixWorld();
  const world = {
    scene: new THREE.Scene(),
    camera: cam,
    webcamVideo: { readyState: 4 } as unknown as HTMLVideoElement,
    objects: () => [obj(7, 0, 0, 0)],
    setKinematic: vi.fn(),
    moveKinematic: vi.fn(),
    applyVelocity: vi.fn(),
  };
  const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const ctx = { bus, world, demoMode: () => false } as any;
  return { ctx, world, bus };
}

const TEST_DEPS = { overlay: false, glow: false, autoLoop: false } as const;

describe('tracking runtime (mocked MediaPipe)', () => {
  it('approach → pinch → move → release grabs, moves, and throws (applyVelocity)', async () => {
    const { ctx, world } = makeCtx();
    const api = createHands(ctx, { ...TEST_DEPS }) as any;
    await api.toggle();
    expect(api.enabled).toBe(true);

    // open hand over the object — no grab yet
    h.queue.push({ landmarks: [hand(0.4, 0.6)] });
    // pinch closes at midpoint 0.5 — grab
    h.queue.push({ landmarks: [hand(0.49, 0.51)] });
    // pinch drags toward higher x (mirrored -> ray moves -x) — moves
    h.queue.push({ landmarks: [hand(0.54, 0.56)] });
    h.queue.push({ landmarks: [hand(0.59, 0.61)] });
    h.queue.push({ landmarks: [hand(0.64, 0.66)] });
    // open hand — release + throw
    h.queue.push({ landmarks: [hand(0.4, 0.8)] });

    for (let i = 0; i < 6; i++) api.__step();

    expect(world.setKinematic).toHaveBeenCalledWith(7, true);
    expect(world.setKinematic).toHaveBeenLastCalledWith(7, false);
    expect(world.moveKinematic.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(world.applyVelocity).toHaveBeenCalledTimes(1);
    const v = world.applyVelocity.mock.calls[0][1] as THREE.Vector3;
    expect(Number.isFinite(v.x)).toBe(true);
    expect(v.x).toBeLessThan(0); // raw x increased -> mirrored ray swept -x -> throw -x
    expect(api.__grip()).toBeNull();
  });

  it('no hand mid-grip triggers a graceful release (setKinematic false, no throw)', async () => {
    const { ctx, world } = makeCtx();
    const api = createHands(ctx, { ...TEST_DEPS }) as any;
    await api.toggle();
    h.queue.push({ landmarks: [hand(0.49, 0.51)] }); // grab
    h.queue.push({ landmarks: [] }); // hand vanishes
    api.__step();
    expect(api.__grip()).toBe(7);
    api.__step();
    expect(world.setKinematic).toHaveBeenLastCalledWith(7, false);
    expect(world.applyVelocity).not.toHaveBeenCalled(); // dropped, not thrown
    expect(api.__grip()).toBeNull();
  });

  it('init rejection resolves toggle, stays disabled, warns exactly once', async () => {
    const { ctx, bus } = makeCtx();
    h.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = createHands(ctx, { autoLoop: false }) as any; // real init path (no factory)
    await api.toggle();
    expect(api.enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith('hud:toast', {
      message: 'hand tracking unavailable — mouse works',
    });
    await api.toggle(); // second attempt: still off, no second warn (initFailed sticky)
    expect(api.enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('disabling mid-grip releases the grip (setKinematic false)', async () => {
    const { ctx, world, bus } = makeCtx();
    const api = createHands(ctx, { ...TEST_DEPS }) as any;
    await api.toggle();
    h.queue.push({ landmarks: [hand(0.49, 0.51)] }); // grab
    api.__step();
    expect(api.__grip()).toBe(7);
    await api.toggle(); // disable
    expect(api.enabled).toBe(false);
    expect(world.setKinematic).toHaveBeenLastCalledWith(7, false);
    expect(bus.emit).toHaveBeenCalledWith('hands:state', { enabled: false });
  });
});
