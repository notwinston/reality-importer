/**
 * Scan pipeline (wave 2). Turns a webcam still into scan:* bus events by firing
 * TWO fal.ai calls concurrently: a background-removal cutout (flat standee) and
 * a single-image 3D reconstruction (the real mesh). The module knows nothing
 * about the rest of the app — it only reads ctx.world.webcamVideo and emits the
 * frozen events in src/types.ts. DEMO_MODE drives the identical events from
 * elsewhere, so there is no demo/live branching here.
 */
import { fal } from '@fal-ai/client';
import type { InitScan } from './types';

/**
 * 3D reconstruction endpoint. Single image in, GLB out.
 *   alternative, same image-in/GLB-out contract — one-line switch:
 *   // 'fal-ai/sam-3/3d-objects'  (output at data.model_glb.url instead of data.model_mesh.url)
 */
const MESH_MODEL = 'fal-ai/triposr';
/** Background-removal / transparent-PNG cutout endpoint (output at data.image.url). */
const CUTOUT_MODEL = 'fal-ai/birefnet/v2';
/**
 * The mesh call routinely takes longer than the cutout. After this long we emit a
 * reassuring "still reconstructing…" scan:error WITHOUT cancelling the request, so
 * the showcase can keep the standee on the pedestal; a late mesh still resolves
 * normally and emits scan:mesh.
 */
const MESH_TIMEOUT_MS = 20_000;

/** Longest edge (px) of the captured still before JPEG encoding. */
const CAPTURE_LONG_EDGE = 1024;
const CAPTURE_QUALITY = 0.85;

/**
 * Test-only override for the fal key. vite inlines/loads VITE_FAL_KEY into
 * import.meta.env and vi.stubEnv cannot override it, so tests inject the key
 * (including the empty-key case) through here instead of touching the real .env.
 * null = use the real build-time key. Never read or logged in production paths.
 */
let keyOverride: string | null = null;
export function __setFalKeyForTest(k: string | null): void {
  keyOverride = k;
}

/** Read the build-time fal key lazily (or the injected test override). */
function getFalKey(): string {
  if (keyOverride !== null) return keyOverride.trim();
  try {
    return ((import.meta as ImportMeta).env?.VITE_FAL_KEY ?? '').trim();
  } catch {
    return '';
  }
}

/** Monotonic-ish clock; fake-timer friendly (vitest fakes Date). */
function now(): number {
  return Date.now();
}

function errMsg(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  try {
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Create a drawable canvas. Browser uses <canvas>; tests stub globalThis.document. */
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('no canvas available for capture');
}

/**
 * Draw the current webcam frame to an offscreen canvas, downscaled to a 1024px
 * long edge, and return a JPEG data URI. Throws (caught by scan) when the video
 * is missing or not yet producing frames.
 */
function captureFrame(video: HTMLVideoElement | null): string {
  if (!video) throw new Error('no webcam — camera not granted (press d for DEMO_MODE)');
  const vw = video.videoWidth ?? 0;
  const vh = video.videoHeight ?? 0;
  const ready = (video.readyState ?? 0) >= 2; // >= HAVE_CURRENT_DATA
  if (!ready || vw === 0 || vh === 0) throw new Error('webcam not ready yet');

  const longEdge = Math.max(vw, vh);
  const scale = longEdge > CAPTURE_LONG_EDGE ? CAPTURE_LONG_EDGE / longEdge : 1;
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d canvas context');
  g.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', CAPTURE_QUALITY);
}

/** Pull a GLB url out of either the triposr (model_mesh) or sam-3 (model_glb) shape. */
function meshUrlOf(data: unknown): string | undefined {
  const d = data as { model_mesh?: { url?: string }; model_glb?: { url?: string } } | undefined;
  return d?.model_mesh?.url ?? d?.model_glb?.url;
}

function cutoutUrlOf(data: unknown): string | undefined {
  const d = data as { image?: { url?: string } } | undefined;
  return d?.image?.url;
}

export const initScan: InitScan = (ctx) => {
  let lastId = 0;

  async function scan(): Promise<void> {
    const id = ++lastId;

    const key = getFalKey();
    if (!key) {
      ctx.bus.emit('scan:error', {
        id,
        stage: 'capture',
        message: 'no FAL key — press d for DEMO_MODE',
      });
      return;
    }

    let imageUri: string;
    try {
      imageUri = captureFrame(ctx.world.webcamVideo);
    } catch (err) {
      ctx.bus.emit('scan:error', { id, stage: 'capture', message: errMsg(err) });
      return;
    }

    fal.config({ credentials: key });
    ctx.bus.emit('scan:start', { id });

    // ── cutout: transparent-PNG standee ────────────────────────────────────
    const cutout = (async () => {
      const t0 = now();
      try {
        const res = await fal.subscribe(CUTOUT_MODEL, {
          input: { image_url: imageUri, output_format: 'png' },
        });
        const url = cutoutUrlOf((res as { data?: unknown }).data);
        if (!url) throw new Error('cutout: no image url in response');
        const ms = Math.round(now() - t0);
        ctx.bus.emit('scan:cutout', { id, url, ms });
        ctx.bus.emit('hud:latency', { id, standeeMs: ms });
      } catch (err) {
        ctx.bus.emit('scan:error', { id, stage: 'cutout', message: errMsg(err) });
      }
    })();

    // ── mesh: true 3D reconstruction, with a non-cancelling watchdog timer ──
    const mesh = (async () => {
      const t0 = now();
      let timedOut = false;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        timedOut = true;
        ctx.bus.emit('scan:error', {
          id,
          stage: 'mesh',
          message: 'still reconstructing…',
        });
      }, MESH_TIMEOUT_MS);
      try {
        const res = await fal.subscribe(MESH_MODEL, {
          input: { image_url: imageUri, do_remove_background: true, output_format: 'glb' },
        });
        const url = meshUrlOf((res as { data?: unknown }).data);
        if (!url) throw new Error('mesh: no model url in response');
        const ms = Math.round(now() - t0);
        // late resolution (after the watchdog fired) still emits the normal mesh event
        ctx.bus.emit('scan:mesh', { id, url, ms });
        ctx.bus.emit('hud:latency', { id, meshMs: ms });
      } catch (err) {
        // a watchdog that already fired owns the timeout message; don't double-report
        if (!timedOut) {
          ctx.bus.emit('scan:error', { id, stage: 'mesh', message: errMsg(err) });
        }
      } finally {
        clearTimeout(timer);
      }
    })();

    await Promise.all([cutout, mesh]);
  }

  return { scan };
};
