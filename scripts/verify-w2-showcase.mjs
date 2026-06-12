#!/usr/bin/env node
/**
 * Verifier for wave-2 showcase. Six checks, one PASS/FAIL line each; process exits 0
 * iff ALL pass. Never weakened. Run from anywhere — it resolves ROOT itself.
 *
 *   (1) freeze ledger clean for types.ts/bus.ts (other frozen drift -> WARN, pass;
 *       a MISSING ledger -> WARN no-baseline, pass — wave 1 never emitted it and the
 *       user authorized skipping the freeze-ledger block).
 *   (2) tsc --noEmit with an owned-files filter (own-file error -> FAIL; only sibling
 *       errors -> WARN SIBLING-TSC, pass).
 *   (3) own vitest suite green AND >= 8 cases.
 *   (4) exports / wiring intact across fx/spawn/showcase.
 *   (5) own paths clean AND no frozen-surface path shows as modified (sibling-owned
 *       dirt elsewhere is expected and ignored).
 *   (6) a commit authored by THIS loop exists (git log --grep '^w2-showcase:').
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const trySh = (cmd, opts = {}) => {
  try { return { ok: true, out: sh(cmd, opts) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

const OWNED = [
  'src/spawn.ts', 'src/showcase.ts', 'src/fx.ts',
  'tests/showcase.test.ts', 'scripts/verify-w2-showcase.mjs',
  'loop-notes/w2-showcase.md',
];
const FROZEN = [
  'src/types.ts', 'src/bus.ts', 'src/main.ts', 'src/world.ts', 'src/hud.ts',
  'src/worldfx.ts', 'src/worldcore.ts', 'src/demo.ts',
  'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'index.html',
];

let allPass = true;
const line = (ok, label, extra = '') => {
  if (!ok) allPass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};
const warn = (label, extra = '') => console.log(`WARN  ${label}${extra ? '  — ' + extra : ''}`);

// ── (1) freeze ledger clean for types.ts/bus.ts ───────────────────────────────
(() => {
  const ledgerPath = resolve(ROOT, 'loop-notes/frozen.sha256');
  if (!existsSync(ledgerPath)) {
    warn('(1) freeze ledger', 'loop-notes/frozen.sha256 MISSING — no baseline (wave 1 never emitted it); treating as no-drift');
    line(true, '(1) freeze types.ts/bus.ts');
    return;
  }
  const ledger = readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const want = new Map();
  for (const row of ledger) {
    const m = row.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) want.set(m[2].replace(/^\.\//, ''), m[1].toLowerCase());
  }
  let criticalDrift = false;
  let otherDrift = false;
  for (const [file, hash] of want) {
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) { (/(types|bus)\.ts$/.test(file) ? (criticalDrift = true) : (otherDrift = true)); continue; }
    const cur = sh(`shasum -a 256 "${file}"`).trim().split(/\s+/)[0].toLowerCase();
    if (cur !== hash) { /(types|bus)\.ts$/.test(file) ? (criticalDrift = true) : (otherDrift = true); }
  }
  if (otherDrift) warn('(1) freeze', 'non-critical frozen drift detected (ignored per spec)');
  line(!criticalDrift, '(1) freeze types.ts/bus.ts', criticalDrift ? 'types.ts/bus.ts drifted from ledger' : '');
})();

// ── (2) tsc with owned-files filter ───────────────────────────────────────────
(() => {
  const r = trySh('npx tsc --noEmit');
  if (r.ok) { line(true, '(2) tsc --noEmit'); return; }
  const errLines = r.out.split('\n').filter((l) => /error TS\d+/.test(l));
  const ownErrors = errLines.filter((l) => OWNED.some((f) => l.includes(f.replace(/^.*\//, '')) && l.includes(f)));
  const ownByPath = errLines.filter((l) => OWNED.some((f) => l.startsWith(f) || l.includes(`${f}(`) || l.includes(`/${f}(`)));
  const owned = new Set([...ownErrors, ...ownByPath]);
  if (owned.size > 0) {
    line(false, '(2) tsc --noEmit', `own-file errors:\n${[...owned].slice(0, 8).join('\n')}`);
  } else {
    warn('(2) tsc SIBLING-TSC', `${errLines.length} error(s) only in non-owned files — ignored`);
    line(true, '(2) tsc --noEmit');
  }
})();

// ── (3) vitest green AND >= 8 cases ───────────────────────────────────────────
(() => {
  const src = readFileSync(resolve(ROOT, 'tests/showcase.test.ts'), 'utf8');
  const cases = (src.match(/\b(it|test)\s*\(/g) || []).length;
  const r = trySh('npx vitest run tests/showcase.test.ts --no-cache');
  const green = r.ok && /Test Files\s+\d+ passed/.test(r.out) && !/failed/.test(r.out.split('\n').find((l) => /Tests\s+\d+/.test(l)) || '');
  line(green && cases >= 8, '(3) vitest green & >=8 cases', `${cases} cases, ${green ? 'green' : 'NOT green'}`);
  if (!green) console.log(r.out.split('\n').slice(-12).join('\n'));
})();

// ── (4) exports / wiring intact ───────────────────────────────────────────────
(() => {
  const fx = readFileSync(resolve(ROOT, 'src/fx.ts'), 'utf8');
  const spawn = readFileSync(resolve(ROOT, 'src/spawn.ts'), 'utf8');
  const showcase = readFileSync(resolve(ROOT, 'src/showcase.ts'), 'utf8');

  const fxExports = (fx.match(/export\s+(?:function|const|interface|type|class)\s+\w+/g) || []).length;
  const checks = [
    [/export\s+function\s+initShowcase|export\s+const\s+initShowcase/.test(showcase), 'showcase exports initShowcase'],
    [/export\s+(?:async\s+)?function\s+spawnStandee/.test(spawn), 'spawn exports spawnStandee'],
    [/export\s+(?:async\s+)?function\s+spawnMeshFromUrl/.test(spawn), 'spawn exports spawnMeshFromUrl'],
    [fxExports >= 5, `fx has >=5 exports (${fxExports})`],
    [/export\s+const\s+MIN_SHOWCASE_MS\s*=\s*3[2-9]\d{2}\b/.test(showcase), 'MIN_SHOWCASE_MS in 3200..3999'],
    [/WATCHDOG_MS/.test(showcase), 'WATCHDOG_MS present'],
    [/AdditiveBlending/.test(fx), 'fx uses AdditiveBlending'],
    [/(makeBurst|makeRing)/.test(showcase), 'showcase wires makeBurst|makeRing'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, l]) => l);
  line(failed.length === 0, '(4) exports/wiring intact', failed.join('; '));
})();

// ── (5) own paths clean AND no frozen-surface modification ────────────────────
(() => {
  const ownDirt = sh(`git status --porcelain -- ${OWNED.map((f) => `"${f}"`).join(' ')}`).trim();
  const full = sh('git status --porcelain').trim().split('\n').filter(Boolean);
  const frozenDirt = full.filter((l) => {
    const path = l.slice(3).trim();
    return FROZEN.includes(path);
  });
  const ok = ownDirt === '' && frozenDirt.length === 0;
  line(ok, '(5) own paths committed & frozen untouched',
    [ownDirt ? `uncommitted owned:\n${ownDirt}` : '', frozenDirt.length ? `frozen modified:\n${frozenDirt.join('\n')}` : ''].filter(Boolean).join(' | '));
})();

// ── (6) committed by THIS loop ────────────────────────────────────────────────
(() => {
  const log = trySh(`git log --oneline --grep='^w2-showcase:'`);
  const head = (log.out || '').split('\n').filter(Boolean)[0] || '';
  line(head !== '', '(6) committed by this loop', head ? head : 'no w2-showcase: commit yet');
})();

console.log('');
console.log(allPass ? 'FINAL STATUS: PASS' : 'FINAL STATUS: FAIL');
process.exit(allPass ? 0 : 1);
