/**
 * STUB scan module (wave 2 replaces this). The exported initScan signature is
 * the contract wave 2 must keep. Until then, scan() reports that the module is
 * not built — the user can press `d` to drive the identical pipeline via DEMO.
 */
import type { InitScan } from './types';

export const initScan: InitScan = (ctx) => ({
  async scan() {
    const id = -1;
    ctx.bus.emit('scan:error', {
      id, stage: 'capture',
      message: 'scan module not built yet — press d',
    });
  },
});
