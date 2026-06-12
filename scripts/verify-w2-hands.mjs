#!/usr/bin/env node
/**
 * verify-w2-hands.mjs — the binding gate for the w2-hands loop.
 *
 * Exit 0 iff ALL checks pass; never weakened. Checks:
 *   (1) frozen contracts (types.ts/bus.ts) unchanged vs the freeze ledger;
 *   (2) tsc clean for OWNED files (sibling-only errors -> SIBLING-TSC warn);
 *   (3) own vitest green AND >=10 cases AND the named cases are present;
 *   (4) Unit-2 grep set holds (verbatim local paths, no CDN, readyState, overlay
 *       canvas) AND initHands + >=6 pure exports present;
 *   (4b) hand model + wasm on disk (waived only if CAPABILITIES says missing);
 *   (5) owned paths clean in git AND no frozen path modified;
 *   (6) a w2-hands: commit exists.
 *
 * Freeze-ledger note: wave 1 never wrote loop-notes/frozen.sha256 (its Unit 7 is
 * still todo). With the loop's BLOCK explicitly skipped by the user, this script
 * falls back to the local baseline snapshot under .verify/w2-hands/ taken at the
 * start of the build — types.ts/bus.ts are still drift-checked, just against that
 * baseline instead of the (absent) canonical ledger.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const FROZEN = ['src/types.ts', 'src/bus.ts'];
const OWNED = [
  'src/hands.ts',
  'tests/hands.test.ts',
  'scripts/verify-w2-hands.mjs',
  'loop-notes/w2-hands.md',
];

let ok = true;
const fail = (m) => {
  console.error('FAIL ' + m);
  ok = false;
};
const pass = (m) => console.log('PASS ' + m);
const warn = (m) => console.log('WARN ' + m);
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── (1) frozen contracts clean ──────────────────────────────────────────────
function parseLedger(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m) map[m[2].replace(/^\.\//, '')] = m[1];
  }
  return map;
}
const canonical = 'loop-notes/frozen.sha256';
const baseline = '.verify/w2-hands/frozen-baseline.sha256';
let ledgerPath = existsSync(canonical) ? canonical : existsSync(baseline) ? baseline : null;
if (!ledgerPath) {
  fail('(1) no freeze ledger (canonical or local baseline) to check types.ts/bus.ts against');
} else {
  const led = parseLedger(readFileSync(ledgerPath, 'utf8'));
  let clean = true;
  for (const f of FROZEN) {
    if (!led[f]) {
      fail(`(1) ${f} absent from ledger ${ledgerPath}`);
      clean = false;
    } else if (led[f] !== sha(f)) {
      fail(`(1) FROZEN DRIFT: ${f} changed vs ${ledgerPath}`);
      clean = false;
    }
  }
  if (clean) pass(`(1) frozen contracts clean vs ${ledgerPath}${ledgerPath === baseline ? ' (canonical ledger absent — local baseline)' : ''}`);
}

// ── (2) tsc clean for owned files ────────────────────────────────────────────
let tscOut = '';
try {
  sh('npx tsc --noEmit');
  pass('(2) tsc clean');
} catch (e) {
  tscOut = (e.stdout || '') + (e.stderr || '');
  const ownedErr = tscOut
    .split('\n')
    .filter((l) => /^(src\/hands\.ts|tests\/hands\.test\.ts)\(/.test(l));
  if (ownedErr.length) {
    fail('(2) tsc errors in owned files:\n' + ownedErr.join('\n'));
  } else {
    warn('(2) SIBLING-TSC: tsc errors only outside owned files — PASS-for-you');
  }
}

// ── (3) vitest green + >=10 cases + named cases ──────────────────────────────
const testSrc = readFileSync('tests/hands.test.ts', 'utf8');
const caseCount = (testSrc.match(/\b(it|test)\(/g) || []).length;
if (caseCount < 10) fail(`(3) only ${caseCount} test cases (<10)`);
else pass(`(3) ${caseCount} test cases`);

const namedCases = ['hysteresis', 'mirror', 'velocityFromTrail', 'pickAlongRay', 'init', 'release'];
for (const n of namedCases) {
  if (!testSrc.includes(n)) fail(`(3) named test case missing: ${n}`);
}

try {
  sh('npx vitest run tests/hands.test.ts --no-cache');
  pass('(3) vitest green');
} catch (e) {
  fail('(3) vitest failed:\n' + ((e.stdout || '') + (e.stderr || '')).split('\n').slice(-25).join('\n'));
}

// ── (4) Unit-2 grep set + initHands + >=6 pure exports ───────────────────────
const handsSrc = readFileSync('src/hands.ts', 'utf8');
const greps = [
  ["modelAssetPath: '/models/hand_landmarker.task'", true],
  ["forVisionTasks('/wasm')", true],
  ['readyState', true],
  ["createElement('canvas')", true],
];
for (const [needle, want] of greps) {
  if (handsSrc.includes(needle) !== want) fail(`(4) grep ${want ? 'missing' : 'forbidden'}: ${needle}`);
}
if (/https?:\/\/cdn|jsdelivr|unpkg|storage\.googleapis/.test(handsSrc)) {
  fail('(4) forbidden CDN/remote URL present in src/hands.ts');
}
if (!/\binitHands\b/.test(handsSrc)) fail('(4) initHands export missing');
const pureExports = [
  'pinchDistance',
  'isPinching',
  'smoothPoint',
  'mirrorX',
  'screenToRay',
  'velocityFromTrail',
  'pickAlongRay',
];
const presentPure = pureExports.filter((n) => new RegExp(`export function ${n}\\b`).test(handsSrc));
if (presentPure.length < 6) fail(`(4) only ${presentPure.length} pure exports (<6)`);
else pass(`(4) Unit-2 greps + initHands + ${presentPure.length} pure exports`);

// ── (4b) assets present (or DEGRADED waiver) ─────────────────────────────────
const capsMissing =
  existsSync('loop-notes/CAPABILITIES.md') &&
  /hands_model:\s*missing/i.test(readFileSync('loop-notes/CAPABILITIES.md', 'utf8'));
const modelOk = existsSync('public/models/hand_landmarker.task') && readFileSync('public/models/hand_landmarker.task').length > 0;
let wasmOk = false;
try {
  wasmOk = sh('ls public/wasm').toLowerCase().includes('wasm');
} catch {
  wasmOk = false;
}
if (modelOk && wasmOk) pass('(4b) hand model + wasm present');
else if (capsMissing) console.log('SKIP (4b) DEGRADED-BY-W1: CAPABILITIES says hands_model missing');
else fail('(4b) hand model / wasm assets missing and no DEGRADED waiver');

// ── (5) owned paths clean + no frozen modified ───────────────────────────────
const status = sh('git status --porcelain -- ' + OWNED.join(' ')).trim();
if (status) fail('(5) owned paths dirty:\n' + status);
else pass('(5) owned paths clean');
const frozenStatus = sh('git status --porcelain -- ' + FROZEN.join(' ')).trim();
if (frozenStatus) fail('(5) FROZEN path modified:\n' + frozenStatus);

// ── (6) committed ────────────────────────────────────────────────────────────
const lastCommit = sh("git log --oneline --grep='^w2-hands:' | head -1").trim();
if (!lastCommit) fail('(6) no w2-hands: commit found');
else pass('(6) committed: ' + lastCommit);

console.log(ok ? '\nw2-hands VERIFIER: PASS' : '\nw2-hands VERIFIER: FAIL');
process.exit(ok ? 0 : 1);
