/**
 * The HUD: object count, LIVE/DEMO mode badge, latency line, and an auto-clearing
 * toast. Reads everything from the bus — never touches the splash overlay (that
 * is owned by index.html + style.css). FROZEN after wave 1.
 */
import type { RIContext } from './types';

export function initHud(ctx: RIContext): void {
  const el = document.getElementById('hud');
  if (!el) return;
  const webcam = document.getElementById('webcam');

  let standeeMs: number | null = null;
  let meshMs: number | null = null;
  let toastMsg = '';
  let toastTimer = 0;
  let inFlight = 0;

  el.innerHTML = `
    <div>OBJECTS <b id="hud-count">0</b></div>
    <div>MODE <span id="hud-mode" class="badge live">LIVE</span></div>
    <div id="hud-lat">standee –.–s · mesh –.–s</div>
    <div class="toast" id="hud-toast"></div>`;
  const $count = el.querySelector('#hud-count') as HTMLElement;
  const $mode = el.querySelector('#hud-mode') as HTMLElement;
  const $lat = el.querySelector('#hud-lat') as HTMLElement;
  const $toast = el.querySelector('#hud-toast') as HTMLElement;

  function setMode(demo: boolean): void {
    $mode.textContent = demo ? 'DEMO' : 'LIVE';
    $mode.className = 'badge ' + (demo ? 'demo' : 'live');
  }
  setMode(ctx.demoMode());

  function fmt(ms: number | null): string {
    return ms == null ? '–.–' : (ms / 1000).toFixed(1);
  }
  function renderLat(): void {
    $lat.textContent = `standee ${fmt(standeeMs)}s · mesh ${fmt(meshMs)}s`;
  }

  // Object count: poll lightly (world has no change event; cheap enough).
  setInterval(() => { $count.textContent = String(ctx.world.objects().length); }, 250);

  ctx.bus.on('mode:demo', ({ on }) => setMode(on));
  ctx.bus.on('hud:latency', ({ standeeMs: s, meshMs: m }) => {
    if (s != null) standeeMs = s;
    if (m != null) meshMs = m;
    renderLat();
  });
  ctx.bus.on('hud:toast', ({ message }) => {
    toastMsg = message;
    $toast.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { if ($toast.textContent === toastMsg) $toast.textContent = ''; }, 3000);
  });

  // Scanning pulse on the webcam preview while any scan is in flight.
  const startPulse = (): void => { inFlight++; webcam?.classList.add('scanning'); };
  const stopPulse = (): void => { inFlight = Math.max(0, inFlight - 1); if (!inFlight) webcam?.classList.remove('scanning'); };
  ctx.bus.on('scan:start', startPulse);
  ctx.bus.on('scan:mesh', stopPulse);
  ctx.bus.on('scan:error', stopPulse);
}
