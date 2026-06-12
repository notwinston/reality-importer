// @vitest-environment node
//
// Unit tests for the scan pipeline. ZERO real network: @fal-ai/client is mocked.
// We avoid jsdom entirely — the webcam <video> and the capture <canvas> are
// injected as plain stubs (ctx.world.webcamVideo + a stubbed globalThis.document).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bus } from '../src/bus';
import type { RIEvents } from '../src/types';

// fal is mocked at the module boundary; the factory may not close over outer vars.
vi.mock('@fal-ai/client', () => ({
  fal: { config: vi.fn(), subscribe: vi.fn() },
}));
import { fal } from '@fal-ai/client';
import { initScan, __setFalKeyForTest } from '../src/scan';

const MESH_TIMEOUT_MS = 20_000; // mirror of the constant in src/scan.ts

const subscribe = vi.mocked(fal.subscribe);

type Rec = { type: keyof RIEvents; payload: RIEvents[keyof RIEvents] };

/** Fresh ctx with a real Bus and an ordered recording of every scan/hud event. */
function makeCtx(videoOverride?: unknown) {
  const bus = new Bus<RIEvents>();
  const events: Rec[] = [];
  const track = <K extends keyof RIEvents>(type: K) =>
    bus.on(type, (payload) => events.push({ type, payload }));
  track('scan:start');
  track('scan:cutout');
  track('scan:mesh');
  track('scan:error');
  track('hud:latency');

  const video =
    videoOverride !== undefined
      ? videoOverride
      : { readyState: 4, videoWidth: 1280, videoHeight: 720 };
  const world = { webcamVideo: video } as unknown as { webcamVideo: HTMLVideoElement | null };
  const ctx = { bus, world, demoMode: () => false } as never;
  return { ctx, events };
}

const of = (events: Rec[], type: keyof RIEvents) => events.filter((e) => e.type === type);

const CUTOUT_OK = { data: { image: { url: 'https://cdn.fal.run/cut.png' } }, requestId: 'c1' };
const MESH_OK = { data: { model_mesh: { url: 'https://cdn.fal.run/mesh.glb' } }, requestId: 'm1' };

beforeEach(() => {
  vi.useFakeTimers();
  subscribe.mockReset();
  vi.mocked(fal.config).mockReset();
  __setFalKeyForTest('id:secret-test-key'); // deterministic; never the real .env key
  // Inject a fake canvas so captureFrame works without jsdom.
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => 'data:image/jpeg;base64,AAAA',
  };
  vi.stubGlobal('document', { createElement: () => fakeCanvas });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  __setFalKeyForTest(null);
  vi.unstubAllGlobals();
});

describe('scan pipeline', () => {
  it('(a) happy path: start→cutout+mesh with numeric ms, and NO leaked late timer error', async () => {
    subscribe.mockImplementation((endpoint: string) =>
      Promise.resolve(endpoint === 'fal-ai/triposr' ? MESH_OK : CUTOUT_OK) as never,
    );
    const { ctx, events } = makeCtx();
    const api = initScan(ctx);

    await api.scan();

    expect(events[0].type).toBe('scan:start');
    const cutout = of(events, 'scan:cutout')[0].payload as RIEvents['scan:cutout'];
    const mesh = of(events, 'scan:mesh')[0].payload as RIEvents['scan:mesh'];
    expect(cutout.url).toContain('cut.png');
    expect(mesh.url).toContain('mesh.glb');
    expect(typeof cutout.ms).toBe('number');
    expect(typeof mesh.ms).toBe('number');
    // hud:latency emitted for both legs
    expect(of(events, 'hud:latency').length).toBe(2);

    // leaked-timer guard: the watchdog must have been cleared on resolution
    vi.advanceTimersByTime(MESH_TIMEOUT_MS + 5_000);
    expect(of(events, 'scan:error').length).toBe(0);
  });

  it('(b) cutout rejects but mesh resolves: one cutout error + mesh still emitted', async () => {
    subscribe.mockImplementation((endpoint: string) =>
      endpoint === 'fal-ai/triposr'
        ? (Promise.resolve(MESH_OK) as never)
        : (Promise.reject(new Error('cutout boom')) as never),
    );
    const { ctx, events } = makeCtx();
    const api = initScan(ctx);

    await api.scan();

    const errs = of(events, 'scan:error');
    expect(errs.length).toBe(1);
    expect((errs[0].payload as RIEvents['scan:error']).stage).toBe('cutout');
    expect(of(events, 'scan:mesh').length).toBe(1);
  });

  it('(c) mesh slower than the timer: "still reconstructing…" then a late scan:mesh', async () => {
    let resolveMesh!: (v: unknown) => void;
    const meshLater = new Promise((r) => {
      resolveMesh = r;
    });
    subscribe.mockImplementation((endpoint: string) =>
      endpoint === 'fal-ai/triposr' ? (meshLater as never) : (Promise.resolve(CUTOUT_OK) as never),
    );
    const { ctx, events } = makeCtx();
    const api = initScan(ctx);

    const scanP = api.scan();
    // let the synchronous body + cutout microtask settle and the watchdog arm
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(MESH_TIMEOUT_MS);
    const timeoutErr = of(events, 'scan:error').map(
      (e) => e.payload as RIEvents['scan:error'],
    );
    expect(timeoutErr.some((p) => p.stage === 'mesh' && /reconstructing/.test(p.message))).toBe(true);

    // the request was NOT cancelled — a late resolution still yields scan:mesh
    resolveMesh(MESH_OK);
    await scanP;
    expect(of(events, 'scan:mesh').length).toBe(1);
  });

  it('(d) empty key: single capture error, no fal calls', async () => {
    __setFalKeyForTest('');
    const { ctx, events } = makeCtx();
    const api = initScan(ctx);

    await api.scan();

    const errs = of(events, 'scan:error');
    expect(errs.length).toBe(1);
    expect((errs[0].payload as RIEvents['scan:error']).stage).toBe('capture');
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('(e) two concurrent scans get distinct ids', async () => {
    subscribe.mockImplementation((endpoint: string) =>
      Promise.resolve(endpoint === 'fal-ai/triposr' ? MESH_OK : CUTOUT_OK) as never,
    );
    const { ctx, events } = makeCtx();
    const api = initScan(ctx);

    await Promise.all([api.scan(), api.scan()]);

    const starts = of(events, 'scan:start').map((e) => (e.payload as RIEvents['scan:start']).id);
    expect(starts.length).toBe(2);
    expect(new Set(starts).size).toBe(2);
  });

  it('(f) webcam not ready: capture error, no fal calls', async () => {
    const { ctx, events } = makeCtx({ readyState: 0, videoWidth: 0, videoHeight: 0 });
    const api = initScan(ctx);

    await api.scan();

    const errs = of(events, 'scan:error');
    expect(errs.length).toBe(1);
    expect((errs[0].payload as RIEvents['scan:error']).stage).toBe('capture');
    expect(subscribe).not.toHaveBeenCalled();
  });
});
