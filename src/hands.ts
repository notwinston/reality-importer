/**
 * STUB hands module (wave 2 wires MediaPipe pinch-grab). The exported initHands
 * signature is frozen. Toggling just toasts that the module is not built yet.
 */
import type { InitHands } from './types';

export const initHands: InitHands = (ctx) => {
  const api = {
    enabled: false,
    async toggle() {
      ctx.bus.emit('hud:toast', { message: 'hands module not built yet' });
    },
  };
  return api;
};
