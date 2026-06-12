# Wave-2 handoff

The foundation is frozen. The three parallel wave-2 loops (scan / showcase /
hands) run in separate containers SHARING this filesystem. **Do not install
dependencies and do not edit frozen files** (see `loop-notes/frozen.sha256`).

## What you own

| Loop | File(s) | Replace the stub, keep the exported signature |
|------|---------|-----------------------------------------------|
| scan | `src/scan.ts` | `export const initScan: InitScan` → real fal.ai capture→cutout→mesh, emitting `scan:start`/`scan:cutout`/`scan:mesh`/`scan:error` with the same payloads the DEMO path emits. |
| showcase | `src/showcase.ts` (+ may extend `src/spawn.ts` choreography) | `export const initShowcase: InitShowcase`. Add pedestal + spotlight + slow rotation (`world.moveKinematic(id, pos, quat)`), the inflate, `world.focusCamera`, `world.pulseBloom`. The wave-1 stub already runs the pipeline (standee → mesh). |
| hands | `src/hands.ts` | `export const initHands: InitHands` → MediaPipe HandLandmarker (model `public/models/hand_landmarker.task`, wasm `public/wasm/`), pinch→`world.nearestObject`+`setKinematic`/`moveKinematic`, release→`applyVelocity`. |

## Hard rules

- The webcam `<video>` is CSS-mirrored (`scaleX(-1)`); convert MediaPipe x → `1-x`.
- Everything flows through `ctx.bus` (typed, `src/types.ts`) and `ctx.world` (WorldApi).
- A throwing initializer is caught in `main.ts` — but keep modules non-fatal.
- Never print/commit the fal key. `.env` is gitignored; presence checks only.

## Environment facts

See `loop-notes/CAPABILITIES.md` for confirmed three import paths, the Rapier
init pattern, the wasm copy path, and the `browser_ok` probe result.
