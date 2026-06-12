/**
 * The import ceremony — the signature visual beat. A scanned object materializes as
 * a flat cutout standee on a glowing, spotlit, slowly-rotating pedestal during an
 * import period the audience can orbit-inspect, then INFLATES into the true 3D mesh
 * with a particle burst and drops live into the physics room.
 *
 * One import is "on the pedestal" at a time; concurrent scan:start events queue
 * (FIFO) with their latest cutout/mesh/error payloads buffered and replayed on
 * dequeue. Every terminal path frees the pedestal, releases camera focus, and
 * dequeues the next import.
 *
 * TIME SOURCE: a single update tick driven by rAF (guarded) with a setTimeout(16)
 * fallback; all holds/animations compare Date.now() timestamps so vitest fake timers
 * drive the whole machine. WorldApi exposes no per-frame hook, so this tick is ours
 * (see loop-notes CONTRACT DRIFT).
 */
import * as THREE from 'three';
import type { InitShowcase, RIContext, ShowcaseApi, SpawnedObject } from './types';
import { spawnStandee, spawnMeshFromUrl } from './spawn';
import { makeBurst, makeDust, makeRing, makeSpotCone, easeOutElastic, type Burst, type Dust, type Ring } from './fx';

/** The import period — the standee/mesh holds on the pedestal at least this long. */
export const MIN_SHOWCASE_MS = 3200;
/** An active import with no cutout/mesh/error within this long is treated as both-fail. */
export const WATCHDOG_MS = 90_000;

const PEDESTAL_TOP = new THREE.Vector3(0, 0.6, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const ROT_SPEED = 0.5; // rad/s
const INFLATE_MS = 300;

function nowMs(): number {
  return Date.now();
}

interface PedestalFx {
  ring: Ring;
  cone: THREE.Mesh;
  dust: Dust;
  light: THREE.PointLight;
  bursts: Burst[];
}

interface Active {
  id: number;
  startMs: number;
  watchdogStartMs: number;
  pedestalPlacedAtMs: number | null;
  rotation: number;
  standee?: SpawnedObject;
  mesh?: SpawnedObject;
  meshArrived: boolean;
  cutoutFailed: boolean;
  meshFailed: boolean;
  captureFailed: boolean;
  inflate?: { obj: SpawnedObject; startMs: number };
  resolved: boolean;
  releaseObj: SpawnedObject | null;
  minHoldRequired: boolean;
  released: boolean;
  fx: PedestalFx;
}

interface Buffered {
  cutoutUrl?: string;
  meshUrl?: string;
  cutoutFailed?: boolean;
  meshFailed?: boolean;
  captureFailed?: boolean;
}

interface ShowcaseOpts {
  watchdogMs?: number;
}

export const initShowcase: InitShowcase = (ctx) => createShowcase(ctx);

/** Injectable factory (watchdog override) used by the contract export and by tests. */
export function createShowcase(ctx: RIContext, opts: ShowcaseOpts = {}): ShowcaseApi {
  const watchdogMs = opts.watchdogMs ?? WATCHDOG_MS;

  let active: Active | null = null;
  const queue: number[] = [];
  const buffers = new Map<number, Buffered>();
  const done = new Set<number>();

  // ── tick scheduling ──────────────────────────────────────────────────────
  let ticking = false;
  let lastTick: number | null = null;
  const liveBursts: Burst[] = []; // detached bursts still animating after release

  const scheduleTick: (cb: () => void) => void =
    typeof requestAnimationFrame !== 'undefined'
      ? (cb) => { requestAnimationFrame(() => cb()); }
      : (cb) => { setTimeout(cb, 16); };

  function startTick(): void {
    if (ticking) return;
    ticking = true;
    lastTick = null;
    scheduleTick(tick);
  }

  function tick(): void {
    if (!ticking) return;
    const t = nowMs();
    const dt = lastTick == null ? 0 : Math.max(0, (t - lastTick) / 1000);
    lastTick = t;

    const a = active;
    if (a && !a.released) {
      // Watchdog: nothing arrived in time -> force a failure resolution.
      if (!a.resolved && (t - a.watchdogStartMs) >= watchdogMs) {
        if (a.standee) a.meshFailed = true; else a.captureFailed = true;
        maybeResolve(a);
      }

      // Inflate animation (mesh 0.05 -> 1 with elastic overshoot).
      if (a.inflate) {
        const p = Math.min(1, (t - a.inflate.startMs) / INFLATE_MS);
        const scale = 0.05 + (1 - 0.05) * easeOutElastic(p);
        setScale(a.inflate.obj, scale);
        if (p >= 1) { setScale(a.inflate.obj, 1); a.inflate = undefined; }
      }

      // Slow rotation of whatever sits on the pedestal.
      const rotObj = a.mesh ?? a.standee;
      if (rotObj) {
        a.rotation += ROT_SPEED * dt;
        placeOnPedestal(rotObj, a.rotation);
      }

      // Pedestal fx.
      a.fx.ring.pulse(t / 1000);
      a.fx.dust.update(dt);
      for (const b of a.fx.bursts) b.update(dt);

      // Release once resolved, min hold satisfied, and the inflate has finished.
      if (a.resolved && !a.inflate) {
        const holdOk = !a.minHoldRequired ||
          (a.pedestalPlacedAtMs != null && (t - a.pedestalPlacedAtMs) >= MIN_SHOWCASE_MS);
        if (holdOk) doRelease(a);
      }
    }

    // Detached bursts (post-release) keep animating until done.
    for (let i = liveBursts.length - 1; i >= 0; i--) {
      liveBursts[i].update(dt);
      if (liveBursts[i].done) liveBursts.splice(i, 1);
    }

    if (active || liveBursts.length) scheduleTick(tick);
    else ticking = false;
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function setScale(obj: SpawnedObject, s: number): void {
    obj.root.scale.setScalar(s);
  }

  function placeOnPedestal(obj: SpawnedObject, rot: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, rot);
    ctx.world.moveKinematic(obj.id, PEDESTAL_TOP.clone(), q);
  }

  function buffer(id: number): Buffered {
    let b = buffers.get(id);
    if (!b) { b = {}; buffers.set(id, b); }
    return b;
  }

  // ── pedestal lifecycle ───────────────────────────────────────────────────
  function assembleFx(): PedestalFx {
    const ring = makeRing(0.55);
    const cone = makeSpotCone(2.2);
    const dust = makeDust(0.6, 150);
    const light = new THREE.PointLight(0x9fe8ff, 6, 6, 2);
    light.position.set(0, 1.8, 0);
    const scene = ctx.world.scene;
    scene.add(ring.object3d);
    scene.add(cone);
    scene.add(dust.object3d);
    scene.add(light);
    return { ring, cone, dust, light, bursts: [] };
  }

  function dismissFx(fx: PedestalFx): void {
    const scene = ctx.world.scene;
    scene.remove(fx.ring.object3d);
    scene.remove(fx.cone);
    scene.remove(fx.dust.object3d);
    scene.remove(fx.light);
    for (const b of fx.bursts) {
      // Let any still-animating burst finish detached.
      if (!b.done) liveBursts.push(b);
      else scene.remove(b.object3d);
    }
    fx.bursts = [];
  }

  function makeActive(id: number): void {
    const t = nowMs();
    active = {
      id, startMs: t, watchdogStartMs: t, pedestalPlacedAtMs: null, rotation: 0,
      meshArrived: false, cutoutFailed: false, meshFailed: false, captureFailed: false,
      resolved: false, releaseObj: null, minHoldRequired: false, released: false,
      fx: assembleFx(),
    };
    ctx.world.focusCamera(PEDESTAL_TOP.clone(), 800);
    ctx.bus.emit('showcase:import', { id });
    startTick();
    void replayBuffered(id);
  }

  function begin(id: number): void {
    if (done.has(id)) return;
    if (active && active.id === id) return;
    if (queue.includes(id)) return;
    if (!active) makeActive(id);
    else queue.push(id);
  }

  function dequeue(): void {
    const next = queue.shift();
    if (next !== undefined) makeActive(next);
  }

  // ── per-active handlers ────────────────────────────────────────────────────
  async function handleActiveCutout(id: number, url: string): Promise<void> {
    const a = active;
    if (!a || a.id !== id) return;
    if (a.standee || a.meshArrived) return; // dup / superseded
    let s: SpawnedObject;
    try {
      s = await spawnStandee(ctx, id, url);
    } catch {
      a.cutoutFailed = true;
      maybeResolve(a);
      return;
    }
    if (active !== a || a.meshArrived) { safeRemove(s); return; }
    a.standee = s;
    ctx.world.setKinematic(s.id, true);
    if (a.pedestalPlacedAtMs == null) a.pedestalPlacedAtMs = nowMs();
    placeOnPedestal(s, a.rotation);
    ctx.bus.emit('hud:toast', { message: 'reconstructing 3D…' });
    maybeResolve(a); // in case a hard mesh error already arrived
  }

  async function handleActiveMesh(id: number, url: string): Promise<void> {
    const a = active;
    if (!a || a.id !== id) return;
    if (a.meshArrived) return; // duplicate scan:mesh ignored
    a.meshArrived = true;
    a.meshFailed = false; // a real mesh supersedes any soft "still reconstructing" error
    let m: SpawnedObject;
    try {
      m = await spawnMeshFromUrl(ctx, id, url);
    } catch {
      a.meshFailed = true;
      maybeResolve(a);
      return;
    }
    if (active !== a || a.released) { safeRemove(m); return; }
    a.mesh = m;
    ctx.world.setKinematic(m.id, true);
    if (a.pedestalPlacedAtMs == null) a.pedestalPlacedAtMs = nowMs();
    placeOnPedestal(m, a.rotation);
    setScale(m, 0.05);
    a.inflate = { obj: m, startMs: nowMs() };

    // Remove the standee placeholder; the mesh takes its place.
    if (a.standee) { safeRemove(a.standee); a.standee = undefined; }

    // Burst + bloom pop.
    const burst = makeBurst(PEDESTAL_TOP.clone(), 0x9fe8ff, 60);
    ctx.world.scene.add(burst.object3d);
    a.fx.bursts.push(burst);
    ctx.world.pulseBloom(400);
    ctx.bus.emit('showcase:placed', { id });

    // Success: the mesh is the thing we release dynamic after the min hold.
    a.resolved = true;
    a.releaseObj = m;
    a.minHoldRequired = true;
  }

  function handleActiveError(id: number, stage: 'cutout' | 'mesh' | 'capture', message: string): void {
    const a = active;
    if (!a || a.id !== id) return;
    if (stage === 'cutout') {
      a.cutoutFailed = true;
    } else if (stage === 'capture') {
      a.captureFailed = true;
    } else {
      // SOFT mesh signal from scan.ts ("still reconstructing…") is NOT a failure —
      // keep the standee and wait; the watchdog catches a truly-dead mesh.
      if (/still reconstructing/i.test(message)) {
        ctx.bus.emit('hud:toast', { message: 'still reconstructing…' });
        return;
      }
      a.meshFailed = true;
    }
    maybeResolve(a);
  }

  /** Decide whether a failure combination terminally resolves the active import. */
  function maybeResolve(a: Active): void {
    if (a.resolved) return;
    if (a.meshFailed && a.standee) {
      // Mesh died but the standee made it — the paper cutout IS the import.
      a.resolved = true;
      a.releaseObj = a.standee;
      a.minHoldRequired = true;
      ctx.bus.emit('hud:toast', { message: '3D failed — paper mode' });
    } else if (a.captureFailed || (a.meshFailed && a.cutoutFailed)) {
      // Nothing materialized: dismiss the empty pedestal.
      a.resolved = true;
      a.releaseObj = null;
      a.minHoldRequired = false;
      ctx.bus.emit('hud:toast', { message: 'import failed' });
    }
  }

  function doRelease(a: Active): void {
    a.released = true;
    if (a.releaseObj) {
      const obj = a.releaseObj;
      ctx.world.setKinematic(obj.id, false);
      // Small upward + spin send-off so it tumbles believably into the room.
      ctx.world.applyVelocity(
        obj.id,
        new THREE.Vector3((a.id % 3) * 0.1 - 0.1, 1.6, 0.2),
        new THREE.Vector3(0.4, ROT_SPEED * 4, 0.2),
      );
      ctx.bus.emit('showcase:released', { id: a.id });
    }
    ctx.world.releaseCameraFocus();
    dismissFx(a.fx);
    done.add(a.id);
    buffers.delete(a.id);
    active = null;
    dequeue();
  }

  function safeRemove(o: SpawnedObject): void {
    try { ctx.world.removeObject(o.id); } catch { /* already gone */ }
  }

  async function replayBuffered(id: number): Promise<void> {
    const b = buffers.get(id);
    if (!b) return;
    if (b.cutoutFailed) handleActiveError(id, 'cutout', 'buffered cutout error');
    if (b.captureFailed) handleActiveError(id, 'capture', 'buffered capture error');
    if (b.cutoutUrl) await handleActiveCutout(id, b.cutoutUrl);
    if (b.meshUrl) await handleActiveMesh(id, b.meshUrl);
    if (b.meshFailed) handleActiveError(id, 'mesh', 'buffered mesh error');
  }

  // ── bus wiring ─────────────────────────────────────────────────────────────
  ctx.bus.on('scan:start', ({ id }) => begin(id));

  ctx.bus.on('scan:cutout', ({ id, url }) => {
    buffer(id).cutoutUrl = url;
    if (active && active.id === id) void handleActiveCutout(id, url);
    else begin(id);
  });

  ctx.bus.on('scan:mesh', ({ id, url }) => {
    buffer(id).meshUrl = url;
    if (active && active.id === id) void handleActiveMesh(id, url);
    else begin(id);
  });

  ctx.bus.on('scan:error', ({ id, stage, message }) => {
    // Errors never assemble a pedestal (capture errors precede scan:start).
    if (stage === 'cutout') buffer(id).cutoutFailed = true;
    else if (stage === 'mesh') buffer(id).meshFailed = true;
    else buffer(id).captureFailed = true;
    if (active && active.id === id) handleActiveError(id, stage, message);
  });

  return {
    /** Idempotent per id; also reachable via the scan:start subscription above. */
    beginImport: (id: number) => begin(id),
  };
}
