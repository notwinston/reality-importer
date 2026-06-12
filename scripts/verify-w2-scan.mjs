#!/usr/bin/env node
/**
 * w2-scan verifier. Implements the 8 checks from the loop spec, one PASS/FAIL
 * line each; exits 0 iff every check passes. Run from anywhere — it cds to ROOT.
 *
 * Owned files (the only ones whose tsc errors are MY failure):
 *   src/scan.ts, tests/scan.test.ts, scripts/smoke-fal.mjs, scripts/verify-w2-scan.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const OWNED_TS = ['src/scan.ts', 'tests/scan.test.ts'];
let allPass = true;
const line = (ok, n, msg, warn = false) => {
  if (!ok && !warn) allPass = false;
  const tag = warn ? 'WARN' : ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  [${n}] ${msg}`);
};
/** Run a shell command; return {code, out}. Never throws. */
const run = (cmd) => {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// ── (1) frozen ledger clean for types.ts + bus.ts ──────────────────────────
{
  if (!existsSync('loop-notes/frozen.sha256')) {
    line(true, 1, 'frozen ledger missing — freeze-check skipped (wave-1 omission; user override)', true);
  } else {
    const r = run('sha256sum -c loop-notes/frozen.sha256');
    const bad = r.out
      .split('\n')
      .filter((l) => /:\s*FAILED/i.test(l))
      .map((l) => l.split(':')[0].trim());
    const criticalDrift = bad.filter((f) => /src\/(types|bus)\.ts$/.test(f));
    if (criticalDrift.length) {
      line(false, 1, `FREEZE BROKEN on critical contract: ${criticalDrift.join(', ')}`);
    } else if (bad.length) {
      line(true, 1, `FREEZE-BROKEN (non-critical) on ${bad.join(', ')} — wave 3 reconciles`, true);
    } else {
      line(true, 1, 'frozen ledger clean (types.ts + bus.ts verified)');
    }
  }
}

// ── (2) tsc with owned-files filter ────────────────────────────────────────
{
  const r = run('npx tsc --noEmit');
  if (r.code === 0) {
    line(true, 2, 'tsc --noEmit clean');
  } else {
    const errFiles = [
      ...new Set(
        r.out
          .split('\n')
          .map((l) => l.match(/^([^\s(]+\.tsx?)\(\d+,\d+\):/))
          .filter(Boolean)
          .map((m) => m[1].replace(/^\.\//, '')),
      ),
    ];
    const ownedErrs = errFiles.filter((f) => OWNED_TS.includes(f));
    if (ownedErrs.length) {
      line(false, 2, `tsc errors in owned files: ${ownedErrs.join(', ')}`);
    } else {
      line(true, 2, `SIBLING-TSC only (${errFiles.join(', ') || 'unknown'}) — not my failure`, true);
    }
  }
}

// ── (3) own vitest green AND >=5 cases ─────────────────────────────────────
{
  const r = run('npx vitest run tests/scan.test.ts --no-cache');
  const cases = (read('tests/scan.test.ts').match(/\b(it|test)\(/g) || []).length;
  line(r.code === 0 && cases >= 5, 3, `vitest exit ${r.code}, ${cases} test cases (need >=5)`);
}

// ── (4) exports + model constants + no CDN imports + no key logging ─────────
{
  const src = read('src/scan.ts');
  const hasInit = /export\s+(function|const)\s+initScan/.test(src);
  const hasMesh = /MESH_MODEL\s*=/.test(src) && /CUTOUT_MODEL\s*=/.test(src);
  const cdnCount = (src.match(/https?:\/\/cdn|jsdelivr|unpkg/g) || []).length;
  const keyLog = /console\.(log|info)\([^)]*[Kk]ey/.test(src);
  const ok = hasInit && hasMesh && cdnCount === 0 && !keyLog;
  line(
    ok,
    4,
    `initScan=${hasInit} modelConsts=${hasMesh} cdnImports=${cdnCount} keyLogging=${keyLog}`,
  );
}

// ── (5) manifest parses as JSON array >=1 entry ────────────────────────────
{
  let ok = false;
  let detail = 'unreadable';
  try {
    const m = JSON.parse(read('public/canned/manifest.json'));
    ok = Array.isArray(m) && m.length >= 1;
    detail = `array=${Array.isArray(m)} entries=${Array.isArray(m) ? m.length : 'n/a'}`;
  } catch (e) {
    detail = `parse error: ${e.message}`;
  }
  line(ok, 5, `manifest.json ${detail}`);
}

// ── (6) smoke: ARM A (real assets) OR ARM B (auth/credit SMOKE-BLOCKED) ─────
{
  const glbMagic = () => {
    try {
      return readFileSync('public/canned/real-01.glb').slice(0, 4).toString('latin1') === 'glTF';
    } catch {
      return false;
    }
  };
  const size = (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  let armA = false;
  if (existsSync('.verify/w2-scan/smoke.json')) {
    try {
      const s = JSON.parse(read('.verify/w2-scan/smoke.json'));
      armA =
        typeof s.cutoutMs === 'number' &&
        typeof s.meshMs === 'number' &&
        glbMagic() &&
        size('public/canned/real-01-cutout.png') > 1024 &&
        /smoke-duck/.test(read('public/canned/manifest.json'));
    } catch {
      armA = false;
    }
  }
  let armB = false;
  if (existsSync('.verify/w2-scan/smoke-error.txt')) {
    const err = read('.verify/w2-scan/smoke-error.txt');
    armB =
      /401|403|unauthorized|forbidden|credit|balance|insufficient|payment|exhausted/i.test(err) &&
      /SMOKE-BLOCKED:/.test(read('loop-notes/w2-scan.md'));
  }
  line(armA || armB, 6, `smoke ARM A=${armA} | ARM B(auth/credit blocked)=${armB}`);
}

// ── (7) own work committed ─────────────────────────────────────────────────
{
  const r = run("git log --oneline --grep='^w2-scan:'");
  line(r.code === 0 && r.out.trim().length > 0, 7, `w2-scan commit present=${r.out.trim().length > 0}`);
}

// ── (8) own paths clean (sibling dirt elsewhere ignored) ───────────────────
{
  const paths =
    'src/scan.ts tests/scan.test.ts scripts/smoke-fal.mjs scripts/verify-w2-scan.mjs public/canned loop-notes/w2-scan.md';
  const r = run(`git status --porcelain -- ${paths}`);
  line(r.out.trim().length === 0, 8, `owned paths clean=${r.out.trim().length === 0}${r.out.trim() ? ` (${r.out.trim().replace(/\n/g, '; ')})` : ''}`);
}

console.log(allPass ? '\nw2-scan: ALL CHECKS PASS' : '\nw2-scan: FAILURES PRESENT');
process.exit(allPass ? 0 : 1);
