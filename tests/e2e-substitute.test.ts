/**
 * SUBSTITUTE end-to-end harness — stands in for the headless-browser run
 * (scripts/e2e.mjs) when chromium cannot launch in the build container
 * (see loop-notes/CAPABILITIES.md `browser_ok: no (w3 reprobe …)` and
 * .verify/w3/browser-probe.log). Winston's Mac is the real visual verification.
 *
 * This drives the SAME standee → showcase → mesh → 'showcase:released' event
 * sequence the browser e2e asserts, but on the REAL Bus with a mocked
 * world/renderer (no WebGL, no GLTF, no fal). It exercises the live integration
 * spine end to end: DEMO_MODE replay → scan:* events → showcase pedestal
 * ceremony → standee spawn → mesh inflate/swap → release after MIN_SHOWCASE_MS.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Bus } from '../src/bus';
import type { RIContext, RIEvents, SpawnedObject, WorldApi } from '../src/types';
import { initShowcase, MIN_SHOWCASE_MS } from '../src/showcase';
import { initDemo } from '../src/demo';

// Mock spawn so no GLTF/texture/WebGL work happens; standee + mesh resolve to
// plain SpawnedObjects with the canonical kinds.
vi.mock('../src/spawn', () => ({
  spawnStandee: vi.fn(),
  spawnMeshFromUrl: vi.fn(),
}));
import { spawnStandee, spawnMeshFromUrl } from '../src/spawn';
const mockStandee = spawnStandee as unknown as Mock;
const mockMesh = spawnMeshFromUrl as unknown as Mock;

function makeObj(id: number, kind: SpawnedObject['kind']): SpawnedObject {
  return {
    id, kind,
    root: { scale: { setScalar: vi.fn() }, position: {}, quaternion: {} } as unknown as SpawnedObject['root'],
  };
}

function makeWorld() {
  return {
    scene: { add: vi.fn(), remove: vi.fn() },
    camera: {}, renderer: {}, controls: {}, rapierWorld: {},
    webcamVideo: null,
    addBody: vi.fn(), removeObject: vi.fn(), objects: vi.fn(() => []),
    nearestObject: vi.fn(() => null),
    setKinematic: vi.fn(), moveKinematic: vi.fn(), applyVelocity: vi.fn(),
    duplicateLast: vi.fn(), reset: vi.fn(), flipGravity: vi.fn(),
    focusCamera: vi.fn(), releaseCameraFocus: vi.fn(), pulseBloom: vi.fn(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('e2e-substitute — full DEMO_MODE event flow on the real bus', () => {
  let bus: Bus<RIEvents>;
  let world: ReturnType<typeof makeWorld>;
  let ctx: RIContext;
  let trace: string[];
  let released: number[];
  let startedId: number | null;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStandee.mockReset();
    mockMesh.mockReset();
    bus = new Bus<RIEvents>();
    world = makeWorld();
    ctx = { bus, world: world as unknown as WorldApi, demoMode: () => true };
    trace = [];
    released = [];
    // Record the canonical sequence the browser e2e watches for.
    bus.on('scan:start', () => trace.push('scan:start'));
    bus.on('scan:cutout', () => trace.push('scan:cutout'));
    bus.on('scan:mesh', () => trace.push('scan:mesh'));
    bus.on('showcase:released', ({ id }) => { trace.push('showcase:released'); released.push(id); });
    startedId = null;
    bus.on('scan:start', ({ id }) => { startedId = id; });
  });

  afterEach(() => { vi.useRealTimers(); });

  it('SPACE in DEMO_MODE → standee → showcase → mesh → released (the e2e sequence)', async () => {
    // Stub fetch so initDemo loads a one-entry manifest (the canned "duck"),
    // mirroring public/canned/manifest.json without any network.
    const manifest = [{ label: 'duck', cutout: '/canned/sample-photo.png', glb: '/canned/test.glb', standeeMs: 1400, meshMs: 3200 }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => manifest })) as unknown as typeof fetch);

    mockStandee.mockResolvedValue(makeObj(1001, 'standee'));
    mockMesh.mockResolvedValue(makeObj(2001, 'mesh'));

    initShowcase(ctx);                 // pedestal state machine subscribes to scan:*
    const { replayNext } = initDemo(ctx);

    // ── "press SPACE" in DEMO_MODE ──────────────────────────────────────
    await replayNext();                // emits scan:start now, schedules cutout/mesh
    await flush();
    expect(trace).toContain('scan:start');
    expect((world.focusCamera as Mock)).toHaveBeenCalledTimes(1);

    // standee arrives at standeeMs → spawnStandee + kinematic pedestal
    await vi.advanceTimersByTimeAsync(1400);
    await flush();
    expect(mockStandee).toHaveBeenCalledTimes(1);
    expect((world.setKinematic as Mock)).toHaveBeenCalledWith(1001, true);
    expect(trace).toContain('scan:cutout');

    // mesh arrives at meshMs → swap standee out, inflate the real mesh
    await vi.advanceTimersByTimeAsync(1800);   // total 3200ms
    await flush();
    expect(mockMesh).toHaveBeenCalledTimes(1);
    expect((world.removeObject as Mock)).toHaveBeenCalledWith(1001);
    expect((world.pulseBloom as Mock)).toHaveBeenCalled();
    expect(trace).toContain('scan:mesh');

    // before MIN_SHOWCASE_MS elapses past placement: still on the pedestal
    expect(released).toEqual([]);

    // past the import period: release fires exactly once
    await vi.advanceTimersByTimeAsync(MIN_SHOWCASE_MS + 500);
    await flush();
    expect((world.setKinematic as Mock)).toHaveBeenCalledWith(2001, false);
    expect(startedId).not.toBeNull();
    expect(released).toEqual([startedId]);

    // Canonical ordered sequence, de-duplicated.
    const ordered = trace.filter((t, i) => trace.indexOf(t) === i);
    expect(ordered).toEqual(['scan:start', 'scan:cutout', 'scan:mesh', 'showcase:released']);
  });
});
