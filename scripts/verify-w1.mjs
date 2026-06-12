/**
 * Wave-1 foundation verifier. Prints one PASS/FAIL line per condition and exits
 * 0 iff ALL pass. These conditions are the EXACT wave-1 contract — they are not
 * weakened, skipped, or reordered-to-skip.
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}';

let allPass = true;
function check(label, fn) {
  let ok = false, note = '';
  try { const r = fn(); ok = r === true || r === undefined; if (typeof r === 'string') { note = r; ok = false; } }
  catch (e) { ok = false; note = e.message?.split('\n')[0] || String(e); }
  if (!ok) allPass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${note ? '  — ' + note : ''}`);
}
function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}
function shOk(cmd) { try { sh(cmd); return true; } catch { return false; } }
function size(p) { try { return statSync(resolve(ROOT, p)).size; } catch { return 0; } }
function read(p) { return readFileSync(resolve(ROOT, p), 'utf8'); }

// (1) build
check('build (npm run build) exits 0', () => shOk('npm run build'));

// (2) tests
check('tests (npx vitest run) exits 0', () => shOk('npx vitest run'));

// (3) Unit-5 asset verify expression (incl hands_model marker escape)
check('assets present (glb>20KB, png, wasm, manifest array, hand model or marker)', () => {
  const glbOk = size('public/canned/test.glb') > 20000;
  const pngOk = size('public/canned/sample-photo.png') > 0;
  const wasmOk = shOk("ls public/wasm/ | grep -qi wasm");
  const manOk = (() => { const m = JSON.parse(read('public/canned/manifest.json')); return Array.isArray(m) && m.length > 0; })();
  const handOk = size('public/models/hand_landmarker.task') > 5000000
    || (existsSync(resolve(ROOT, 'loop-notes/CAPABILITIES.md')) && /hands_model: missing/.test(read('loop-notes/CAPABILITIES.md')));
  return glbOk && pngOk && wasmOk && manOk && handOk;
});

// (4) contract greps
check('contracts (7 WorldApi symbols, 3 init* exports, __ri)', () => {
  const types = read('src/types.ts');
  const syms = ['duplicateLast', 'flipGravity', 'pulseBloom', 'focusCamera', 'nearestObject', 'setKinematic', 'moveKinematic'];
  const symCount = syms.filter((s) => types.includes(s)).length;
  const inits = ['initScan', 'initShowcase', 'initHands'].every((n) =>
    shOk(`grep -rq 'export const ${n}\\|export function ${n}\\|export { ${n}' src`));
  const riOk = read('src/main.ts').includes('__ri');
  return symCount >= 7 && inits && riOk;
});

// (5) manifest array >=1
check('manifest is a JSON array with >=1 entry', () => {
  const m = JSON.parse(read('public/canned/manifest.json'));
  return Array.isArray(m) && m.length >= 1;
});

// (6) >=3 commits
check('git repo has >=3 commits', () => Number(sh('git rev-list --count HEAD').trim()) >= 3);

// (7) .env ignored
check('git check-ignore .env exits 0', () => shOk('git check-ignore .env'));

// (8) no fal key tracked AND history clean
check('no fal key in tracked files', () => {
  // git grep exits 1 when no match (good); 0 means a key is tracked (bad).
  const tracked = shOk(`git grep -IilE '${KEY_RE}'`); // true => match found => BAD
  return tracked === false;
});
check('no fal key anywhere in git history', () => {
  const found = shOk(`git log --all -p | grep -qiE '${KEY_RE}'`); // true => found => BAD
  return found === false;
});

// (9) browser_ok line
check('CAPABILITIES.md has a browser_ok line', () =>
  shOk("grep -qE '^browser_ok: (yes|no)' loop-notes/CAPABILITIES.md"));

// (10) >=4 test cases
check('tests/world.test.ts has >=4 test cases', () => {
  const t = read('tests/world.test.ts');
  return (t.match(/\b(it|test)\(/g) || []).length >= 4;
});

console.log(allPass ? '\nALL CONDITIONS PASS' : '\nSOME CONDITIONS FAILED');
process.exit(allPass ? 0 : 1);
