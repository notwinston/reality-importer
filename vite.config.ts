import { defineConfig } from 'vite';

// Reality Importer dev/build config. The demo runs entirely client-side; the
// only server concern is that we want it reachable on the LAN for a projector.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  // Rapier ships a .wasm that must not be inlined; keep it as an asset.
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
