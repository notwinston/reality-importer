/**
 * STUB showcase module (wave 2 adds the pedestal/spotlight choreography). The
 * exported initShowcase signature is frozen. The PIPELINE already works here:
 * it subscribes to scan:cutout / scan:mesh and spawns the standee then replaces
 * it with the real mesh — so wave-1 is visibly end-to-end without a pedestal.
 */
import type { InitShowcase, SpawnedObject } from './types';
import { spawnStandee, spawnMeshFromUrl } from './spawn';

export const initShowcase: InitShowcase = (ctx) => {
  // Per-id standee bookkeeping so the mesh can replace its placeholder.
  const standees = new Map<number, SpawnedObject>();
  const started = new Set<number>();

  function begin(id: number): void {
    if (started.has(id)) return; // idempotent per id
    started.add(id);
  }

  ctx.bus.on('scan:cutout', async ({ id, url }) => {
    begin(id);
    try {
      const s = await spawnStandee(ctx, id, url);
      standees.set(id, s);
    } catch (e) {
      ctx.bus.emit('hud:toast', { message: 'standee failed' });
      console.warn('[showcase] standee error', e);
    }
  });

  ctx.bus.on('scan:mesh', async ({ id, url }) => {
    begin(id);
    try {
      const mesh = await spawnMeshFromUrl(ctx, id, url);
      const prev = standees.get(id);
      if (prev) { ctx.world.removeObject(prev.id); standees.delete(id); }
      ctx.world.pulseBloom(800);
      ctx.bus.emit('showcase:placed', { id });
      void mesh;
    } catch (e) {
      ctx.bus.emit('hud:toast', { message: 'mesh load failed' });
      console.warn('[showcase] mesh error', e);
    }
  });

  return {
    beginImport: begin,
  };
};
