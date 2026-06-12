# Reality Importer

Point a webcam at any real object, press **SPACE**, and ~3 seconds later it
exists as a true textured 3D mesh inside a flashy physics room — standee
placeholder first, then it "inflates" into the real mesh on a showcase pedestal.
Bare-hand pinch-grab, duplicate rain, gravity flips, and a fully-offline
DEMO_MODE.

## Run

```bash
npm install      # already done in wave 1; wave 2 must NOT re-install
npm run dev      # http://localhost:5173  (LAN-reachable for a projector)
npm run build    # tsc --noEmit && vite build
npm test         # vitest
```

## Keys

`SPACE` scan (or replay next canned item in DEMO) · `X` duplicate rain ·
`G` flip gravity · `H` toggle hands · `D` toggle DEMO/LIVE · `R` reset.

DEMO_MODE defaults on when `VITE_FAL_KEY` is empty, or force with `VITE_DEMO_MODE=1`.
Copy `.env.example` → `.env` and paste your fal.ai key (never commit `.env`).

## Architecture (wave-1 foundation — frozen)

- `src/types.ts` + `src/bus.ts` — frozen cross-module contracts (event bus + WorldApi).
- `src/world.ts` — the room: WebGL + bloom + Rapier physics + camera.
- `src/worldcore.ts` — renderer-free collider/registry math (unit-tested).
- `src/hud.ts`, `src/main.ts`, `src/demo.ts` — HUD, boot wiring, offline replay.
- `src/scan.ts`, `src/spawn.ts`, `src/showcase.ts`, `src/hands.ts` — wave-2 fills these in.

See `docs/WAVE2_HANDOFF.md` and `loop-notes/CAPABILITIES.md` for the wave-2 contract.
