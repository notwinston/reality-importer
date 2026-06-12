/**
 * Visual helpers for the room: the emissive grid floor texture and a couple of
 * easing functions. Pulled out of world.ts to keep that file under budget.
 * Renderer-light (only canvas + three texture); FROZEN after wave 1.
 */
import * as THREE from 'three';

/** Smoothstep-ish ease for camera/bloom tweens. */
export function easeInOut(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Build a glowing cyan radial grid on an offscreen canvas and return it as a
 * repeating three texture. Falls back to a plain dark texture if 2D canvas is
 * unavailable (never throws — a live demo must always boot).
 */
export function makeGridTexture(size = 1024): THREE.Texture {
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');

    // Deep base.
    ctx.fillStyle = '#070710';
    ctx.fillRect(0, 0, size, size);

    // Radial glow toward the center.
    const glow = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    glow.addColorStop(0, 'rgba(40, 130, 200, 0.55)');
    glow.addColorStop(0.5, 'rgba(20, 60, 120, 0.18)');
    glow.addColorStop(1, 'rgba(8, 8, 18, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Grid lines.
    const cells = 16;
    const step = size / cells;
    ctx.lineWidth = 2;
    for (let i = 0; i <= cells; i++) {
      const p = i * step;
      const a = 0.10 + 0.22 * (1 - Math.abs(i / cells - 0.5) * 2);
      ctx.strokeStyle = `rgba(90, 210, 255, ${a})`;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    tex.anisotropy = 4;
    return tex;
  } catch {
    const tex = new THREE.DataTexture(new Uint8Array([10, 10, 20, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }
}
