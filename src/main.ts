/**
 * Application boot — runs ONCE and is FROZEN after wave 1. Wires the room, the
 * webcam, and the three modules (scan / showcase / hands) over a shared bus +
 * WorldApi, binds the demo keymap, and exposes window.__ri for tooling.
 *
 * A throwing module must never take down the app: each initializer is wrapped
 * in try/catch so a half-built wave-2 module just warns + toasts.
 */
import { Bus } from './bus';
import type { RIBus, RIContext, RIEvents, ScanApi, ShowcaseApi, HandsApi } from './types';
import { initWorld } from './world';
import { initHud } from './hud';
import { initDemo } from './demo';
import { initScan } from './scan';
import { initShowcase } from './showcase';
import { initHands } from './hands';

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const bus: RIBus = new Bus<RIEvents>();

  const world = await initWorld(canvas);

  // ── Demo-mode resolution ──────────────────────────────────────────────
  const key = (import.meta.env.VITE_FAL_KEY ?? '').trim();
  const forced = import.meta.env.VITE_DEMO_MODE === '1';
  let demo = forced || key.length === 0;

  const ctx: RIContext = { bus, world, demoMode: () => demo };

  // HUD first so module toasts are visible.
  try { initHud(ctx); } catch (e) { console.warn('[main] hud failed', e); }

  // ── Webcam ────────────────────────────────────────────────────────────
  const video = document.getElementById('webcam') as HTMLVideoElement | null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    if (video) { video.srcObject = stream; world.webcamVideo = video; }
  } catch {
    bus.emit('hud:toast', { message: 'no camera — DEMO_MODE only' });
    demo = true;
    bus.emit('mode:demo', { on: true });
  }

  // ── Modules (each isolated) ───────────────────────────────────────────
  let scan: ScanApi | null = null;
  let showcase: ShowcaseApi | null = null;
  let hands: HandsApi | null = null;
  try { scan = initScan(ctx); } catch (e) { console.warn('[main] scan failed', e); bus.emit('hud:toast', { message: 'scan init failed' }); }
  try { showcase = initShowcase(ctx); } catch (e) { console.warn('[main] showcase failed', e); bus.emit('hud:toast', { message: 'showcase init failed' }); }
  try { hands = initHands(ctx); } catch (e) { console.warn('[main] hands failed', e); bus.emit('hud:toast', { message: 'hands init failed' }); }
  void showcase; // self-subscribes to the bus; kept for the contract + window.__ri.

  // ── Demo replay ───────────────────────────────────────────────────────
  const { replayNext } = initDemo(ctx);
  function demoReplayNext(): void { void replayNext(); }
  if (demo) bus.emit('mode:demo', { on: true });

  // ── Keymap ────────────────────────────────────────────────────────────
  addEventListener('keydown', (e) => {
    switch (e.key.toLowerCase()) {
      case ' ': case 'spacebar':
        e.preventDefault();
        if (demo) demoReplayNext(); else void scan?.scan();
        break;
      case 'x': world.duplicateLast(10); break;
      case 'g': world.flipGravity(2000); break;
      case 'h': void hands?.toggle(); break;
      case 'r': world.reset(); break;
      case 'd':
        demo = !demo;
        bus.emit('mode:demo', { on: demo });
        bus.emit('hud:toast', { message: demo ? 'DEMO_MODE on' : 'LIVE mode on' });
        break;
    }
  });
  // Some browsers report the space key as 'Spacebar' / ' ' — handle the code too.
  addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); } }, { passive: false });

  // ── Tooling handle ────────────────────────────────────────────────────
  (window as unknown as { __ri: unknown }).__ri = { bus, world, version: 1, demoMode: () => demo };
}

boot().catch((e) => {
  console.error('[main] fatal boot error', e);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = 'boot failed: ' + (e as Error).message;
});
