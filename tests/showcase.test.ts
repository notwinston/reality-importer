/**
 * Showcase ceremony tests — node env, fake timers. The pedestal state machine is
 * driven entirely by Date.now() comparisons inside a setTimeout/rAF tick, so
 * vi.advanceTimersByTimeAsync drives every hold/animation deterministically.
 *
 * spawn.ts is mocked so no GLTF/texture loading happens; fx.ts runs for real
 * (its primitives need no WebGL context to construct), which also exercises the
 * easing + makeBurst lifecycle (case h).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Bus } from '../src/bus';
import type { RIContext, RIEvents, SpawnedObject, WorldApi } from '../src/types';
import { initShowcase, MIN_SHOWCASE_MS } from '../src/showcase';
import { easeOutElastic, easeOutBack, easeInOutCubic, makeBurst } from '../src/fx';

vi.mock('../src/spawn', () => ({
  spawnStandee: vi.fn(),
  spawnMeshFromUrl: vi.fn(),
}));
import { spawnStandee, spawnMeshFromUrl } from '../src/spawn';

const mockStandee = spawnStandee as unknown as Mock;
const mockMesh = spawnMeshFromUrl as unknown as Mock;

function makeObj(id: number, kind: SpawnedObject['kind'] = 'mesh'): SpawnedObject {
  return {
    id, kind,
    root: { scale: { setScalar: vi.fn() }, position: {}, quaternion: {} } as unknown as SpawnedObject['root'],
  };
}

let bus: Bus<RIEvents>;
let world: Record<string, Mock | unknown>;
let ctx: RIContext;
let released: number[];

function makeWorld() {
  return {
    scene: { add: vi.fn(), remove: vi.fn() },
    camera: {}, renderer: {}, controls: {}, rapierWorld: {},
    webcamVideo: null,
    addBody: vi.fn(),
    removeObject: vi.fn(),
    objects: vi.fn(() => []),
    nearestObject: vi.fn(() => null),
    setKinematic: vi.fn(),
    moveKinematic: vi.fn(),
    applyVelocity: vi.fn(),
    duplicateLast: vi.fn(),
    reset: vi.fn(),
    flipGravity: vi.fn(),
    focusCamera: vi.fn(),
    releaseCameraFocus: vi.fn(),
    pulseBloom: vi.fn(),
  };
}

/** Flush pending microtasks (spawn await chains) without advancing the fake clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockStandee.mockReset();
  mockMesh.mockReset();
  bus = new Bus<RIEvents>();
  world = makeWorld();
  ctx = { bus, world: world as unknown as WorldApi, demoMode: () => true };
  released = [];
  bus.on('showcase:released', ({ id }) => released.push(id));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('import ceremony', () => {
  it('(a) start -> cutout -> mesh: focus, standee, swap, release only after MIN', async () => {
    mockStandee.mockResolvedValue(makeObj(101, 'standee'));
    mockMesh.mockResolvedValue(makeObj(202, 'mesh'));
    initShowcase(ctx);

    bus.emit('scan:start', { id: 1 });
    await flush();
    expect((world.focusCamera as Mock)).toHaveBeenCalledTimes(1);

    bus.emit('scan:cutout', { id: 1, url: 'c', ms: 10 });
    await flush();
    expect(mockStandee).toHaveBeenCalledTimes(1);
    expect((world.setKinematic as Mock)).toHaveBeenCalledWith(101, true);

    bus.emit('scan:mesh', { id: 1, url: 'm', ms: 10 });
    await flush();
    expect(mockMesh).toHaveBeenCalledTimes(1);
    expect((world.removeObject as Mock)).toHaveBeenCalledWith(101); // standee swapped out
    expect((world.pulseBloom as Mock)).toHaveBeenCalled();

    // Well before the import period elapses: still on the pedestal, NOT released.
    await vi.advanceTimersByTimeAsync(1000);
    expect(released).toEqual([]);
    expect((world.setKinematic as Mock)).not.toHaveBeenCalledWith(202, false);

    // Past MIN_SHOWCASE_MS: released dynamic.
    await vi.advanceTimersByTimeAsync(MIN_SHOWCASE_MS);
    expect((world.setKinematic as Mock)).toHaveBeenCalledWith(202, false);
    expect(released).toEqual([1]);
  });

  it('(b) hard mesh failure releases the standee (paper-cutout mode) after MIN', async () => {
    mockStandee.mockResolvedValue(makeObj(111, 'standee'));
    initShowcase(ctx);

    bus.emit('scan:start', { id: 2 });
    await flush();
    bus.emit('scan:cutout', { id: 2, url: 'c', ms: 10 });
    await flush();
    expect((world.setKinematic as Mock)).toHaveBeenCalledWith(111, true);

    bus.emit('scan:error', { id: 2, stage: 'mesh', message: 'mesh: bad glb' });
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    expect(released).toEqual([]);

    await vi.advanceTimersByTimeAsync(MIN_SHOWCASE_MS);
    expect((world.setKinematic as Mock)).toHaveBeenCalledWith(111, false);
    expect(released).toContain(2);
    expect(mockMesh).not.toHaveBeenCalled();
  });

  it('(c) cutout failure + mesh ok: mesh alone ceremonies and releases', async () => {
    mockMesh.mockResolvedValue(makeObj(303, 'mesh'));
    initShowcase(ctx);

    bus.emit('scan:start', { id: 3 });
    await flush();
    bus.emit('scan:error', { id: 3, stage: 'cutout', message: 'cutout boom' });
    await flush();
    expect(mockStandee).not.toHaveBeenCalled();

    bus.emit('scan:mesh', { id: 3, url: 'm', ms: 10 });
    await flush();
    expect(mockMesh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_SHOWCASE_MS + 1000);
    expect((world.setKinematic as Mock)).toHaveBeenCalledWith(303, false);
    expect(released).toContain(3);
  });

  it('(d) both fail: dismiss without spawning, free camera, no object released', async () => {
    initShowcase(ctx);

    bus.emit('scan:start', { id: 4 });
    await flush();
    bus.emit('scan:error', { id: 4, stage: 'cutout', message: 'c' });
    await flush();
    bus.emit('scan:error', { id: 4, stage: 'mesh', message: 'm: hard fail' });
    await flush();

    expect(mockStandee).not.toHaveBeenCalled();
    expect(mockMesh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect((world.releaseCameraFocus as Mock)).toHaveBeenCalled();
    expect(released).toEqual([]); // nothing materialized -> nothing released
  });

  it('(e) a second scan:start queues — no second focusCamera until the first releases', async () => {
    mockStandee.mockResolvedValue(makeObj(120, 'standee'));
    mockMesh.mockResolvedValue(makeObj(220, 'mesh'));
    initShowcase(ctx);

    bus.emit('scan:start', { id: 5 });
    await flush();
    bus.emit('scan:start', { id: 6 });
    await flush();
    expect((world.focusCamera as Mock)).toHaveBeenCalledTimes(1);

    bus.emit('scan:cutout', { id: 5, url: 'c', ms: 10 });
    await flush();
    bus.emit('scan:mesh', { id: 5, url: 'm', ms: 10 });
    await flush();

    await vi.advanceTimersByTimeAsync(MIN_SHOWCASE_MS + 500);
    // First import released -> second dequeued -> a fresh focusCamera fires.
    expect((world.focusCamera as Mock)).toHaveBeenCalledTimes(2);
    expect(released).toContain(5);
  });

  it('(f) duplicate scan:mesh is ignored (mesh spawned once)', async () => {
    mockStandee.mockResolvedValue(makeObj(130, 'standee'));
    mockMesh.mockResolvedValue(makeObj(230, 'mesh'));
    initShowcase(ctx);

    bus.emit('scan:start', { id: 7 });
    await flush();
    bus.emit('scan:cutout', { id: 7, url: 'c', ms: 10 });
    await flush();
    bus.emit('scan:mesh', { id: 7, url: 'm', ms: 10 });
    await flush();
    bus.emit('scan:mesh', { id: 7, url: 'm2', ms: 10 });
    await flush();

    expect(mockMesh).toHaveBeenCalledTimes(1);
  });

  it('(g) buffered replay: a queued id whose cutout arrived while waiting ceremonies on dequeue', async () => {
    mockStandee.mockResolvedValue(makeObj(150, 'standee'));
    mockMesh.mockResolvedValue(makeObj(250, 'mesh'));
    initShowcase(ctx);

    // Import 8 takes the pedestal (mesh-only ceremony).
    bus.emit('scan:start', { id: 8 });
    await flush();
    // Import 9 queues; its cutout arrives while 8 is still showcasing -> buffered.
    bus.emit('scan:start', { id: 9 });
    await flush();
    bus.emit('scan:cutout', { id: 9, url: 'c9', ms: 10 });
    await flush();
    expect(mockStandee).not.toHaveBeenCalled(); // buffered, not yet spawned

    // Finish 8 so 9 dequeues and replays its buffered cutout.
    bus.emit('scan:mesh', { id: 8, url: 'm8', ms: 10 });
    await flush();
    await vi.advanceTimersByTimeAsync(MIN_SHOWCASE_MS + 500);

    expect(released).toContain(8);
    expect(mockStandee).toHaveBeenCalledWith(expect.anything(), 9, 'c9');
  });

  it('(h) easing correctness + makeBurst lifecycle', () => {
    expect(Math.abs(easeOutElastic(1) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(easeOutBack(1) - 1)).toBeLessThan(1e-6);
    let overshoots = false;
    for (let t = 0.01; t < 1; t += 0.01) {
      if (easeOutBack(t) > 1) { overshoots = true; break; }
    }
    expect(overshoots).toBe(true);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);

    const origin = { x: 0, y: 0, z: 0 } as unknown as Parameters<typeof makeBurst>[0];
    const burst = makeBurst(origin, 0x66f0ff, 10);
    expect(burst.done).toBe(false);
    for (let i = 0; i < 300; i++) burst.update(0.05); // 15s >> max lifetime
    expect(burst.done).toBe(true);
  });
});
