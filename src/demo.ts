/**
 * Fully-offline DEMO_MODE replay. Reads /canned/manifest.json (a JSON ARRAY of
 * {label, cutout, glb, standeeMs, meshMs}) and replays each entry by emitting
 * the IDENTICAL scan:* events the live path would — so every downstream module
 * (showcase, hud) is exercised with no network or fal key. FROZEN after wave 1.
 */
import type { RIContext } from './types';
import { allocId } from './worldcore';

interface CannedEntry {
  label: string; cutout: string; glb: string; standeeMs: number; meshMs: number;
}

export function initDemo(ctx: RIContext): { replayNext: () => Promise<void> } {
  let entries: CannedEntry[] = [];
  let cursor = 0;
  let loaded = false;

  async function ensure(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const res = await fetch('/canned/manifest.json');
      const json = await res.json();
      if (Array.isArray(json)) entries = json as CannedEntry[];
    } catch (e) {
      console.warn('[demo] manifest.json load failed:', e);
    }
  }

  async function replayNext(): Promise<void> {
    await ensure();
    if (!entries.length) {
      ctx.bus.emit('hud:toast', { message: 'no canned items' });
      return;
    }
    const entry = entries[cursor % entries.length];
    cursor++;
    const id = allocId();

    ctx.bus.emit('scan:start', { id });
    ctx.bus.emit('hud:toast', { message: `importing "${entry.label}"…` });

    setTimeout(() => {
      ctx.bus.emit('scan:cutout', { id, url: entry.cutout, ms: entry.standeeMs });
      ctx.bus.emit('hud:latency', { id, standeeMs: entry.standeeMs });
    }, entry.standeeMs);

    setTimeout(() => {
      ctx.bus.emit('scan:mesh', { id, url: entry.glb, ms: entry.meshMs });
      ctx.bus.emit('hud:latency', { id, meshMs: entry.meshMs });
    }, entry.meshMs);
  }

  return { replayNext };
}
