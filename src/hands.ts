/**
 * Reality Importer — bare-hand pinch-grab (wave 2).
 *
 * The presenter pinches a 3D object out of the air and throws it. Hands are an
 * ENHANCEMENT layered on top of mouse interaction (owned by world.ts): every
 * failure path here must leave the render loop and mouse grabbing alive. The
 * detector never blocks frames (it drops them), and any error auto-disables
 * tracking gracefully rather than throwing into the animation loop.
 *
 * Split into two halves:
 *   Unit 1 — pure, exported, fully unit-tested math (pinch / smoothing / mirror /
 *            ray / velocity / pick). No DOM, no MediaPipe.
 *   Unit 2 — the tracking runtime: lazy MediaPipe init, a guarded per-frame tick,
 *            a 2D landmark overlay over the (mirrored) webcam preview, and an
 *            in-scene glow sprite at the pinch point.
 *
 * The webcam <video> is CSS-mirrored (scaleX(-1), selfie view): MediaPipe x is
 * un-mirrored, so we map x -> 1-x on the NORMALIZED landmark BEFORE NDC so the
 * overlay and the grab ray line up with what the audience actually sees.
 */
import * as THREE from 'three';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { HandLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { InitHands, HandsApi, RIContext, SpawnedObject } from './types';

// ── Tuning constants (named; the user fine-tunes these at the venue) ─────────
export const PINCH_ENGAGE = 0.055; // pinch distance below which a pinch starts
export const PINCH_RELEASE = 0.075; // distance above which an active pinch ends
export const SMOOTH_N = 5; // rolling-mean window for the pinch midpoint
export const TRAIL_N = 4; // recent samples averaged for throw velocity
export const PICK_RADIUS = 0.6; // ray->object grab radius (generous on purpose)

// MediaPipe hand-landmark indices.
const THUMB_TIP = 4;
const INDEX_TIP = 8;

/** Minimal 2D point in normalized webcam space. */
export interface Pt2 {
  x: number;
  y: number;
}
/** A normalized 3D landmark (subset of MediaPipe's NormalizedLandmark). */
export interface Lm {
  x: number;
  y: number;
  z: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit 1 — pure math core
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized 3D distance between the thumb tip (4) and index tip (8). */
export function pinchDistance(lm: ReadonlyArray<Lm>): number {
  const a = lm[THUMB_TIP];
  const b = lm[INDEX_TIP];
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Hysteresis gate: engage when d < PINCH_ENGAGE, stay engaged until d exceeds
 * PINCH_RELEASE. The dead band between the two thresholds stops a hovering pinch
 * from flickering grab/release frame to frame.
 */
export function isPinching(d: number, wasPinching: boolean): boolean {
  if (wasPinching) return d <= PINCH_RELEASE;
  return d < PINCH_ENGAGE;
}

/**
 * Rolling-mean smoothing. Pushes `next` into `buffer`, trims it to the last `n`
 * samples (mutating it), and returns the mean point. Converges onto a held point
 * and lags a moving one — exactly what we want for a steady reticle.
 */
export function smoothPoint(buffer: Pt2[], next: Pt2, n = SMOOTH_N): Pt2 {
  buffer.push({ x: next.x, y: next.y });
  while (buffer.length > n) buffer.shift();
  let sx = 0;
  let sy = 0;
  for (const p of buffer) {
    sx += p.x;
    sy += p.y;
  }
  const k = buffer.length || 1;
  return { x: sx / k, y: sy / k };
}

/** Mirror a normalized point/landmark across x (selfie view): x -> 1 - x. */
export function mirrorX<T extends Pt2>(p: T): T {
  return { ...p, x: 1 - p.x };
}

/** Build a world-space pick ray from NDC coords [-1..1] through the camera. */
export function screenToRay(ndcX: number, ndcY: number, camera: THREE.Camera): THREE.Ray {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  return rc.ray.clone();
}

/** A timestamped world-space position along the grab trail. */
export interface TrailSample {
  p: THREE.Vector3;
  t: number;
}

/**
 * Mean world-velocity (units/sec) over the last `n` trail samples — the throw.
 * Averages per-segment (Δp / Δt) so an uneven frame cadence doesn't bias it.
 */
export function velocityFromTrail(trail: ReadonlyArray<TrailSample>, n = TRAIL_N): THREE.Vector3 {
  const out = new THREE.Vector3();
  if (trail.length < 2) return out;
  const recent = trail.slice(-Math.max(2, n));
  let count = 0;
  for (let i = 1; i < recent.length; i++) {
    const dt = (recent[i].t - recent[i - 1].t) / 1000;
    if (dt <= 0) continue;
    out.add(recent[i].p.clone().sub(recent[i - 1].p).divideScalar(dt));
    count++;
  }
  return count ? out.divideScalar(count) : out;
}

/**
 * Nearest spawned object whose center lies within `maxRadius` of the ray, else
 * null. Deliberately charitable: grabbing should feel forgiving, not pixel-exact.
 */
export function pickAlongRay(
  objects: ReadonlyArray<SpawnedObject>,
  ray: THREE.Ray,
  maxRadius = PICK_RADIUS,
): SpawnedObject | null {
  let best: SpawnedObject | null = null;
  let bestD = Infinity;
  const c = new THREE.Vector3();
  for (const o of objects) {
    o.root.getWorldPosition(c);
    const d = ray.distanceToPoint(c);
    if (d <= maxRadius && d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit 2 — tracking runtime
// ─────────────────────────────────────────────────────────────────────────────

/** Just enough of the MediaPipe detector for us to drive + to mock. */
interface Landmarker {
  detectForVideo(video: unknown, timestampMs: number): HandLandmarkerResult;
}

/** Test seams — never used in production (all default to the real paths). */
export interface HandsDeps {
  /** Inject a detector factory instead of the real MediaPipe init (tests only). */
  landmarkerFactory?: () => Promise<Landmarker>;
  /** Create the 2D landmark overlay canvas. Disabled in (DOM-less) tests. */
  overlay?: boolean;
  /** Create the in-scene glow sprite. Disabled in tests. */
  glow?: boolean;
  /** Start the rAF loop on enable. Disabled in tests so frames are stepped by hand. */
  autoLoop?: boolean;
}

/** Extra hooks the runtime exposes for tests (superset of HandsApi). */
export interface HandsRuntime extends HandsApi {
  /** Run a single detector frame synchronously (test driver). */
  __step(): void;
  /** Currently-gripped object id, or null. */
  __grip(): number | null;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

const requestFrame = (cb: (t: number) => void): unknown =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : setTimeout(() => cb(nowMs()), 16);

const cancelFrame = (id: unknown): void => {
  if (id == null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id as number);
  else clearTimeout(id as ReturnType<typeof setTimeout>);
};

/**
 * Implementation taking optional test seams. `initHands` (the frozen InitHands
 * signature) is a thin one-arg wrapper over this so production keeps the exact
 * contract while tests can inject a detector / disable DOM seams.
 */
export function createHands(ctx: RIContext, deps: HandsDeps = {}): HandsRuntime {
  const wantOverlay = deps.overlay !== false;
  const wantGlow = deps.glow !== false;
  const autoLoop = deps.autoLoop !== false;

  let detector: Landmarker | null = null;
  let initFailed = false;
  let warned = false;

  let running = false;
  let rafId: unknown = null;
  let busy = false;
  let errorCount = 0;

  let pinchState = false;
  let grip: { id: number; depth: number } | null = null;
  const smoothBuf: Pt2[] = [];
  let trail: TrailSample[] = [];

  let overlay: HTMLCanvasElement | null = null;
  let glow: THREE.Sprite | null = null;

  // ── init ───────────────────────────────────────────────────────────────────
  async function ensureInit(): Promise<boolean> {
    if (detector) return true;
    if (initFailed) return false;
    try {
      if (deps.landmarkerFactory) {
        detector = await deps.landmarkerFactory();
      } else {
        const fileset = await FilesetResolver.forVisionTasks('/wasm');
        detector = (await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: '/models/hand_landmarker.task' },
          runningMode: 'VIDEO',
          numHands: 1,
        })) as unknown as Landmarker;
      }
      return true;
    } catch (err) {
      if (!warned) {
        console.warn('[hands] hand tracking unavailable:', err);
        warned = true;
      }
      ctx.bus.emit('hud:toast', { message: 'hand tracking unavailable — mouse works' });
      initFailed = true;
      detector = null;
      return false;
    }
  }

  // ── visual feedback (DOM/scene; all created dynamically, no frozen edits) ────
  function createOverlay(): void {
    if (overlay || typeof document === 'undefined') return;
    const cv = document.createElement('canvas');
    cv.id = 'hands-overlay';
    cv.style.position = 'absolute';
    cv.style.pointerEvents = 'none';
    cv.style.zIndex = '6';
    const host = document.getElementById('webcam');
    const parent = host?.parentElement ?? document.body;
    if (host) {
      cv.style.left = `${host.offsetLeft}px`;
      cv.style.top = `${host.offsetTop}px`;
      cv.width = host.clientWidth || 320;
      cv.height = host.clientHeight || 240;
    } else {
      cv.width = 320;
      cv.height = 240;
    }
    parent.appendChild(cv);
    overlay = cv;
  }

  function removeOverlay(): void {
    overlay?.parentElement?.removeChild(overlay);
    overlay = null;
  }

  /** Draw faint landmark dots + the thumb→index line, mirrored to match preview. */
  function drawOverlay(lm: ReadonlyArray<Lm>): void {
    if (!overlay) return;
    const g = overlay.getContext('2d');
    if (!g) return;
    const W = overlay.width;
    const H = overlay.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(120,220,255,0.55)';
    for (const p of lm) {
      const x = (1 - p.x) * W; // mirror x to align with selfie preview
      const y = p.y * H;
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
    const t = lm[THUMB_TIP];
    const i = lm[INDEX_TIP];
    if (t && i) {
      g.strokeStyle = 'rgba(160,255,210,0.8)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo((1 - t.x) * W, t.y * H);
      g.lineTo((1 - i.x) * W, i.y * H);
      g.stroke();
    }
  }

  function createGlow(): void {
    if (glow || typeof document === 'undefined') return;
    const tex = makeGlowTexture();
    const mat = new THREE.SpriteMaterial({
      map: tex ?? undefined,
      color: 0x8fe6ff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(0.35);
    sprite.visible = false;
    ctx.world.scene.add(sprite);
    glow = sprite;
  }

  function makeGlowTexture(): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 64;
    const g = cv.getContext('2d');
    if (!g) return null;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(160,230,255,0.7)');
    grad.addColorStop(1, 'rgba(160,230,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  function updateGlow(point: THREE.Vector3, gripping: boolean): void {
    if (!glow) return;
    glow.visible = true;
    glow.position.copy(point);
    glow.scale.setScalar(gripping ? 0.22 : 0.4); // brighter+smaller while gripping
    (glow.material as THREE.SpriteMaterial).opacity = gripping ? 1 : 0.6;
  }

  function hideGlow(): void {
    if (glow) glow.visible = false;
  }

  function removeGlow(): void {
    if (glow) {
      ctx.world.scene.remove(glow);
      glow.material.dispose();
      glow = null;
    }
  }

  // ── grab lifecycle ───────────────────────────────────────────────────────
  function startGrip(ray: THREE.Ray): void {
    const pick = pickAlongRay(ctx.world.objects(), ray, PICK_RADIUS);
    if (!pick) return;
    const center = new THREE.Vector3();
    pick.root.getWorldPosition(center);
    const depth = center.sub(ray.origin).dot(ray.direction);
    grip = { id: pick.id, depth: depth > 0 ? depth : 1 };
    trail = [];
    ctx.world.setKinematic(grip.id, true);
    ctx.bus.emit('world:grab', { id: grip.id });
  }

  function moveGrip(ray: THREE.Ray): void {
    if (!grip) return;
    const target = ray.at(grip.depth, new THREE.Vector3());
    ctx.world.moveKinematic(grip.id, target);
    trail.push({ p: target.clone(), t: nowMs() });
    if (trail.length > 12) trail.shift();
  }

  function endGrip(): void {
    if (!grip) return;
    const id = grip.id;
    const v = velocityFromTrail(trail, TRAIL_N);
    ctx.world.setKinematic(id, false);
    ctx.world.applyVelocity(id, v); // the THROW
    ctx.bus.emit('world:release', { id });
    grip = null;
    trail = [];
  }

  /** Hand vanished / disabled mid-grip: let the object drop, no throw. */
  function releaseGrip(): void {
    if (!grip) return;
    const id = grip.id;
    ctx.world.setKinematic(id, false);
    ctx.bus.emit('world:release', { id });
    grip = null;
    trail = [];
  }

  // ── per-frame ───────────────────────────────────────────────────────────
  function handleResult(res: HandLandmarkerResult | null | undefined): void {
    const hands = res?.landmarks;
    if (!hands || hands.length === 0) {
      pinchState = false;
      releaseGrip();
      if (overlay) {
        const g = overlay.getContext('2d');
        g?.clearRect(0, 0, overlay.width, overlay.height);
      }
      hideGlow();
      return;
    }
    const lm = hands[0] as ReadonlyArray<NormalizedLandmark>;
    const d = pinchDistance(lm);
    const pinching = isPinching(d, pinchState);
    pinchState = pinching;

    const thumb = lm[THUMB_TIP];
    const index = lm[INDEX_TIP];
    const rawMid: Pt2 = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    const mid = mirrorX(rawMid); // mirror BEFORE NDC
    const sm = smoothPoint(smoothBuf, mid, SMOOTH_N);

    const ndcX = sm.x * 2 - 1;
    const ndcY = -(sm.y * 2 - 1);
    const ray = screenToRay(ndcX, ndcY, ctx.world.camera);

    ctx.bus.emit('hands:pinch', { x: sm.x, y: sm.y, grabbing: pinching });
    drawOverlay(lm);
    updateGlow(ray.at(grip ? grip.depth : 2, new THREE.Vector3()), pinching);

    if (pinching && !grip) startGrip(ray);
    else if (pinching && grip) moveGrip(ray);
    else if (!pinching && grip) endGrip();
  }

  function step(): void {
    if (!running && autoLoop) return;
    if (!detector) return;
    const video = ctx.world.webcamVideo;
    if (!video || (video as HTMLVideoElement).readyState < 2) return;
    if (busy) return; // drop frames, never queue
    busy = true;
    try {
      const res = detector.detectForVideo(video, nowMs());
      handleResult(res);
      errorCount = 0;
    } catch (err) {
      errorCount++;
      console.error('[hands] detect frame failed:', err);
      if (errorCount >= 3) autoDisable('hand tracking error — mouse still works');
    } finally {
      busy = false;
    }
  }

  function loop(): void {
    step();
    if (running) rafId = requestFrame(loop);
  }

  function startLoop(): void {
    if (running || !autoLoop) return;
    running = true;
    rafId = requestFrame(loop);
  }

  function stopLoop(): void {
    running = false;
    cancelFrame(rafId);
    rafId = null;
  }

  /** Common teardown for an explicit disable OR a self-disable on repeated error. */
  function teardown(): void {
    stopLoop();
    pinchState = false;
    releaseGrip();
    removeOverlay();
    hideGlow();
    smoothBuf.length = 0;
  }

  function autoDisable(message: string): void {
    if (!api.enabled) return;
    api.enabled = false;
    errorCount = 0;
    teardown();
    ctx.bus.emit('hands:state', { enabled: false });
    ctx.bus.emit('hud:toast', { message });
  }

  // ── public surface ────────────────────────────────────────────────────────
  const api: HandsRuntime = {
    enabled: false,
    async toggle(): Promise<void> {
      if (!api.enabled) {
        const ok = await ensureInit();
        if (!ok) {
          api.enabled = false; // init failed: stay off, toast already shown
          return;
        }
        api.enabled = true;
        if (wantOverlay) createOverlay();
        if (wantGlow) createGlow();
        ctx.bus.emit('hands:state', { enabled: true });
        startLoop();
      } else {
        api.enabled = false;
        teardown();
        removeGlow();
        ctx.bus.emit('hands:state', { enabled: false });
      }
    },
    __step: step,
    __grip: () => (grip ? grip.id : null),
  };
  return api;
}

/** Frozen module initializer — production entry point (mouse-safe wrapper). */
export const initHands: InitHands = (ctx: RIContext): HandsApi => createHands(ctx);
