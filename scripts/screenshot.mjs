/**
 * Headless screenshot probe. Builds the app, serves `vite preview`, loads it in
 * a SwiftShader-backed chromium, screenshots the room, and asserts the canvas
 * actually rendered (>3% non-background pixels). Console output is piped through
 * a redactor so a fal key can never leak into logs/screens. Exits non-zero on a
 * page error. Best-effort: callers treat any failure as `browser_ok: no`.
 *
 * Usage: node scripts/screenshot.mjs [name]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const NAME = process.argv[2] || 'w1-room';
const PORT = 4173;

// fal key shape + Authorization header values -> [REDACTED]
const KEY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}/gi;
const AUTH_RE = /(authorization:\s*)\S+/gi;
const redact = (s) => String(s).replace(KEY_RE, '[REDACTED]').replace(AUTH_RE, '$1[REDACTED]');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(ROOT, '.browsers');
}

async function run() {
  mkdirSync(resolve(ROOT, 'docs/screens'), { recursive: true });

  // Build first (preview serves dist/).
  await exec('npm', ['run', 'build']);

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
  let pageErrored = null;
  page.on('console', (m) => console.log('[page]', redact(m.text())));
  page.on('pageerror', (e) => { pageErrored = redact(e.message); console.error('[pageerror]', pageErrored); });

  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 20000 });
    await sleep(4000);
    const out = resolve(ROOT, `docs/screens/${NAME}.png`);
    await page.screenshot({ path: out });

    // Assert >3% of pixels differ from the dark background.
    const ratio = await page.evaluate(() => {
      const c = document.getElementById('stage');
      if (!c) return 0;
      const g = c.getContext('webgl2') || c.getContext('webgl');
      if (!g) return 0;
      const w = 160, h = 90;
      // sample via a 2D scratch canvas drawing the webgl canvas
      const s = document.createElement('canvas'); s.width = w; s.height = h;
      const ctx = s.getContext('2d');
      ctx.drawImage(c, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 30) lit++;
      }
      return lit / (w * h);
    });
    console.log(`[probe] non-background ratio = ${(ratio * 100).toFixed(1)}%  -> ${out}`);
    if (pageErrored) throw new Error('pageerror: ' + pageErrored);
    if (ratio < 0.03) throw new Error(`render too dark (${(ratio * 100).toFixed(1)}% lit)`);
    console.log('[probe] OK');
  } finally {
    await browser.close().catch(() => {});
    preview.kill();
  }
}

function exec(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

run().then(() => process.exit(0)).catch((e) => { console.error('[probe] FAIL:', redact(e.message)); process.exit(1); });
