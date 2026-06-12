#!/usr/bin/env node
/**
 * LIVE fal.ai smoke test — spends real money (~$0.08/run). Sends the canned
 * sample photo through the SAME two endpoints scan.ts uses, downloads the real
 * outputs into public/canned/, and records timings. On any failure it writes a
 * REDACTED error to .verify/w2-scan/smoke-error.txt (the fal key never leaves
 * this process in cleartext).
 *
 * Endpoints + field names confirmed from the fal.ai API docs:
 *   cutout: fal-ai/birefnet/v2   in:image_url            out:data.image.url
 *   mesh:   fal-ai/triposr       in:image_url,do_remove_background  out:data.model_mesh.url
 */
import { fal } from '@fal-ai/client';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(ROOT, '.env') });

const CUTOUT_MODEL = 'fal-ai/birefnet/v2';
const MESH_MODEL = 'fal-ai/triposr';
const PER_CALL_TIMEOUT_MS = 180_000;

const VERIFY_DIR = resolve(ROOT, '.verify/w2-scan');
const CANNED = resolve(ROOT, 'public/canned');
mkdirSync(VERIFY_DIR, { recursive: true });

const KEY = (process.env.FAL_KEY || process.env.VITE_FAL_KEY || '').trim();

/** Redact the key and any authorization values from arbitrary text. */
function redact(text) {
  let out = String(text);
  if (KEY) out = out.split(KEY).join('[REDACTED]');
  // also redact "Authorization: ..." / "authorization":"..." style values
  out = out.replace(/([Aa]uthorization"?\s*[:=]\s*"?)[^"\s,}]+/g, '$1[REDACTED]');
  return out;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function download(url, dest) {
  const res = await withTimeout(fetch(url), 60_000, `download ${dest}`);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${dest}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  if (!KEY) throw new Error('no FAL_KEY/VITE_FAL_KEY in .env — cannot run smoke');
  console.log(`key: present (${KEY.length} chars)`);

  const photo = readFileSync(resolve(CANNED, 'sample-photo.png'));
  const dataUri = `data:image/png;base64,${photo.toString('base64')}`;
  console.log(`input: sample-photo.png (${photo.length} bytes) as data URI`);

  fal.config({ credentials: KEY });

  // ── cutout ───────────────────────────────────────────────────────────────
  const c0 = Date.now();
  const cutRes = await withTimeout(
    fal.subscribe(CUTOUT_MODEL, { input: { image_url: dataUri, output_format: 'png' } }),
    PER_CALL_TIMEOUT_MS,
    'cutout',
  );
  const cutoutMs = Date.now() - c0;
  const cutoutUrl = cutRes?.data?.image?.url;
  if (!cutoutUrl) throw new Error(`cutout: no data.image.url in response: ${JSON.stringify(cutRes?.data)}`);
  const cutoutUrlHost = new URL(cutoutUrl).host;
  console.log(`cutout: ${cutoutMs}ms  host=${cutoutUrlHost}`);

  // ── mesh ─────────────────────────────────────────────────────────────────
  const m0 = Date.now();
  const meshRes = await withTimeout(
    fal.subscribe(MESH_MODEL, {
      input: { image_url: dataUri, do_remove_background: true, output_format: 'glb' },
    }),
    PER_CALL_TIMEOUT_MS,
    'mesh',
  );
  const meshMs = Date.now() - m0;
  const meshUrl = meshRes?.data?.model_mesh?.url ?? meshRes?.data?.model_glb?.url;
  if (!meshUrl) throw new Error(`mesh: no model url in response: ${JSON.stringify(meshRes?.data)}`);
  const meshUrlHost = new URL(meshUrl).host;
  console.log(`mesh: ${meshMs}ms  host=${meshUrlHost}`);

  // ── download real assets ───────────────────────────────────────────────────
  const cutBytes = await download(cutoutUrl, resolve(CANNED, 'real-01-cutout.png'));
  const glbBytes = await download(meshUrl, resolve(CANNED, 'real-01.glb'));
  console.log(`downloaded: cutout=${cutBytes}B glb=${glbBytes}B`);
  if (cutBytes <= 1024) throw new Error(`cutout png too small (${cutBytes}B)`);
  if (glbBytes <= 20480) throw new Error(`glb too small (${glbBytes}B)`);
  const magic = readFileSync(resolve(CANNED, 'real-01.glb')).slice(0, 4).toString('latin1');
  if (magic !== 'glTF') throw new Error(`glb magic bytes are "${magic}", expected glTF`);

  // ── manifest RMW (stays a JSON array, existing entries kept) ───────────────
  const manifestPath = resolve(CANNED, 'manifest.json');
  let manifest = [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(parsed)) manifest = parsed;
  } catch {
    manifest = [];
  }
  manifest = manifest.filter((e) => e && e.label !== 'smoke-duck');
  manifest.push({
    label: 'smoke-duck',
    cutout: '/canned/real-01-cutout.png',
    glb: '/canned/real-01.glb',
    standeeMs: cutoutMs,
    meshMs,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // ── verify artifact ────────────────────────────────────────────────────────
  writeFileSync(
    resolve(VERIFY_DIR, 'smoke.json'),
    JSON.stringify(
      { cutoutMs, meshMs, cutoutUrlHost, meshUrlHost, endpoint: { cutout: CUTOUT_MODEL, mesh: MESH_MODEL }, at: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );
  console.log('SMOKE OK — real assets written to public/canned/, smoke.json recorded');
}

main().catch((err) => {
  // ONLY this handler writes smoke-error.txt; redact before persisting.
  const raw = err?.stack || err?.message || String(err);
  const redacted = redact(raw);
  if (KEY && redacted.includes(KEY)) {
    // last-resort scrub; never persist the key
    writeFileSync(resolve(VERIFY_DIR, 'smoke-error.txt'), '[error withheld: key leak guard tripped]\n');
  } else {
    writeFileSync(resolve(VERIFY_DIR, 'smoke-error.txt'), redacted + '\n');
  }
  console.error('SMOKE FAILED:', redact(err?.message || String(err)));
  process.exit(1);
});
