/**
 * Tiny typed event bus — the integration spine of Reality Importer.
 *
 * Every module (scan / showcase / hands / hud / main) communicates only through
 * this bus and the WorldApi. The event payload shapes live in `RIEvents`
 * (src/types.ts) and are FROZEN for waves 2 and 3 — nobody edits this file or
 * the event map until wave 3 integration.
 *
 * Implemented as a Map of listener Sets. `on` returns an unsubscribe thunk for
 * ergonomics. A throwing listener is isolated so one bad handler can never take
 * down the dispatch loop (critical for a live demo).
 */
export class Bus<Events extends Record<string, unknown> = Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as (payload: never) => void);
    return () => this.off(type, fn);
  }

  off<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): void {
    this.listeners.get(type)?.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    // Snapshot so a handler may unsubscribe itself (or others) mid-dispatch.
    for (const fn of [...set]) {
      try {
        (fn as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error('[bus] listener for', String(type), 'threw:', err);
      }
    }
  }

  /** Test/utility helper: drop every listener (used by world.reset paths if needed). */
  clear(): void {
    this.listeners.clear();
  }
}
