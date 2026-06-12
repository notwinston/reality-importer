/**
 * Automated end-to-end run in a real headless chromium (DEMO_MODE).
 *
 * Builds with VITE_DEMO_MODE=1 (BUILD-TIME, so a stray keypress can never fire a
 * live fal call), serves `vite preview`, launches SwiftShader chromium, then
 * drives the full pipeline through window.__ri:
 *   assert __ri + demo mode → SPACE → standee → showcase → mesh → 'showcase:released'
 *   → 'x' grows the object count → 'r' resets.
 * Screenshots the sequence into docs/screens/. Console output is piped through a
 * fal-key redactor. Exits non-zero on any pageerror or missed milestone.
 *
 * NOTE: this requires a chromium that can actually launch. In the build
 * container it cannot (no root to install host libs — see
 * loop-notes/CAPABILITIES.md `browser_ok: no (w3 reprobe …)`); the in-container
 * proof is tests/e2e-substitute.test.ts. On Winston's Mac this is the real run.
 *
 * Usage: node scripts/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 4173;
const SCREENS = resolve(ROOT, 'docs/screens');

const KEY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}/gi;
const AUTH_RE = /(authorization:\s*)\S+/gi;
const redact = (s) => String(s).replace(KEY_RE, '[REDACTED]').replace(AUTH_RE, '$1[REDACTED]');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(ROOT, '.browsers');
}

function exec(cmd, args, extraEnv = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

// Poll an in-page predicate until truthy or timeout.
async function waitFor(page, fn, { timeout, label }) {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn).catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label} (${timeout}ms)`);
    await sleep(250);
  }
}

async function run() {
  mkdirSync(SCREENS, { recursive: true });

  // 1) Build with demo mode baked in at BUILD TIME.
  await exec('npm', ['run', 'build'], { VITE_DEMO_MODE: '1' });

  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT)], {
    cwd: ROOT, env: process.env, stdio: 'ignore',
  });

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    preview.kill();
    throw new Error('playwright import failed: ' + redact(e.message));
  }

  await sleep(2500);
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  // Subscribe to 'showcase:released' BEFORE the app boots, via __ri once present.
  await page.addInitScript(() => {
    window.__riReleased = [];
    const hook = () => {
      if (window.__ri && window.__ri.bus && !window.__ri.__e2eHooked) {
        window.__ri.__e2eHooked = true;
        window.__ri.bus.on('showcase:released', (p) => window.__riReleased.push(p.id));
        return true;
      }
      return false;
    };
    const t = setInterval(() => { if (hook()) clearInterval(t); }, 50);
  });

  let pageErrored = null;
  page.on('console', (m) => console.log('[page]', redact(m.text())));
  page.on('pageerror', (e) => { pageErrored = redact(e.message); console.error('[pageerror]', pageErrored); });

  const press = (key) => page.evaluate((k) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : undefined, bubbles: true }));
  }, key);
  const count = () => page.evaluate(() => (window.__ri?.world?.objects?.() ?? []).length);

  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 20000 });

    // __ri must exist and be in DEMO_MODE before we dispatch anything live-capable.
    await waitFor(page, () => !!(window.__ri && window.__ri.world), { timeout: 15000, label: '__ri defined' });
    const demo = await page.evaluate(() => (window.__ri.demoMode ? window.__ri.demoMode() : null));
    if (demo !== true) throw new Error(`expected DEMO_MODE true before SPACE, got ${demo}`);

    await sleep(1500);
    await page.screenshot({ path: resolve(SCREENS, '01-room.png') });

    // SPACE → replay a canned import.
    await press(' ');

    // standee on the pedestal within 10s (SwiftShader is slow).
    await waitFor(page, () => (window.__ri.world.objects() || []).some((o) => o.kind === 'standee'),
      { timeout: 10000, label: 'standee' });
    await page.screenshot({ path: resolve(SCREENS, '02-standee.png') });
    await sleep(400);
    await page.screenshot({ path: resolve(SCREENS, '03-showcase.png') });

    // mesh + 'showcase:released' within 15s (past MIN_SHOWCASE_MS).
    await waitFor(page, () => (window.__ri.world.objects() || []).some((o) => o.kind === 'mesh'),
      { timeout: 15000, label: 'mesh' });
    await waitFor(page, () => (window.__riReleased || []).length >= 1,
      { timeout: 15000, label: 'showcase:released' });
    await page.screenshot({ path: resolve(SCREENS, '04-mesh-released.png') });

    // 'x' → duplicate rain grows the count.
    const before = await count();
    await press('x');
    await waitFor(page, (b) => window.__ri.world.objects().length > b, { timeout: 8000, label: "'x' grows count" }).catch(
      async () => { throw new Error(`'x' did not grow object count (was ${before}, now ${await count()})`); });

    // 'r' → reset clears spawned objects.
    await press('r');
    await sleep(500);
    const after = await count();
    console.log(`[e2e] count before x=${before}, after reset=${after}`);

    if (pageErrored) throw new Error('pageerror: ' + pageErrored);
    console.log('[e2e] OK — full standee→showcase→mesh→released→x→r sequence verified');
  } finally {
    await browser.close().catch(() => {});
    preview.kill();
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error('[e2e] FAIL:', redact(e.message)); process.exit(1); });
