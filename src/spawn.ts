/**
 * Object spawners shared by showcase + demo. The exported signatures are the
 * FROZEN contract wave 2 must keep:
 *   spawnStandee(ctx, id, url)     -> alpha-trimmed double-sided cutout plane
 *   spawnMeshFromUrl(ctx, id, url) -> real GLB mesh on a hull collider
 *
 * spawnStandee loads the transparent PNG, trims fully-transparent margins via an
 * offscreen alpha scan, builds a double-sided alphaTest plane at the trimmed
 * aspect (<=0.5m), adds a thin box collider, and plays a short easeOutBack pop-in
 * plus a subtle idle wobble. Both spawners reject cleanly on load failure.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RIContext, SpawnedObject } from './types';
import { easeOutBack } from './fx';

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

const MAX_DIM = 0.5;        // longest standee edge, metres
const STANDEE_ALPHATEST = 0.05;

/** Result of trimming transparent margins off a loaded image. */
interface Trimmed {
  texture: THREE.Texture;
  aspect: number; // width / height of the trimmed region
}

/**
 * Crop fully-transparent rows/cols (>=98% transparent) off the image and return a
 * texture of just the visible region plus its aspect. Falls back to the untrimmed
 * texture when no canvas is available (headless / no DOM).
 */
function trimTransparentMargins(tex: THREE.Texture): Trimmed {
  const img = tex.image as (HTMLImageElement | ImageBitmap | undefined);
  const iw = (img as { width?: number })?.width ?? 0;
  const ih = (img as { height?: number })?.height ?? 0;

  const hasCanvas =
    (typeof document !== 'undefined' && typeof document.createElement === 'function') ||
    typeof OffscreenCanvas !== 'undefined';

  if (!img || !iw || !ih || !hasCanvas) {
    return { texture: tex, aspect: iw && ih ? iw / ih : 0.7 };
  }

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(iw, ih);
  } else {
    const c = document.createElement('canvas');
    c.width = iw; c.height = ih; canvas = c;
  }
  const g = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!g) return { texture: tex, aspect: iw / ih };

  g.drawImage(img as CanvasImageSource, 0, 0);
  let data: Uint8ClampedArray;
  try {
    data = g.getImageData(0, 0, iw, ih).data;
  } catch {
    return { texture: tex, aspect: iw / ih }; // tainted / unreadable
  }

  // Per-row / per-col opaque-pixel counts; crop margins that are >=98% transparent.
  const rowOpaque = new Array<number>(ih).fill(0);
  const colOpaque = new Array<number>(iw).fill(0);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      if (data[(y * iw + x) * 4 + 3] > 12) { rowOpaque[y]++; colOpaque[x]++; }
    }
  }
  const rowThresh = iw * 0.02;
  const colThresh = ih * 0.02;
  let top = 0; while (top < ih && rowOpaque[top] <= rowThresh) top++;
  let bottom = ih - 1; while (bottom > top && rowOpaque[bottom] <= rowThresh) bottom--;
  let left = 0; while (left < iw && colOpaque[left] <= colThresh) left++;
  let right = iw - 1; while (right > left && colOpaque[right] <= colThresh) right--;

  const cw = Math.max(1, right - left + 1);
  const ch = Math.max(1, bottom - top + 1);
  if (cw === iw && ch === ih) return { texture: tex, aspect: iw / ih };

  let out: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') out = new OffscreenCanvas(cw, ch);
  else { const c = document.createElement('canvas'); c.width = cw; c.height = ch; out = c; }
  const og = out.getContext('2d') as CanvasRenderingContext2D | null;
  if (!og) return { texture: tex, aspect: iw / ih };
  og.drawImage(canvas as CanvasImageSource, left, top, cw, ch, 0, 0, cw, ch);

  const trimmed = new THREE.CanvasTexture(out as unknown as HTMLCanvasElement);
  trimmed.colorSpace = THREE.SRGBColorSpace;
  return { texture: trimmed, aspect: cw / ch };
}

/**
 * A flat, double-sided alpha-tested standee (longest edge ~0.5m) with a thin box
 * collider. The returned object's root is a Group; the textured plane is a child so
 * the pedestal driver can move the root (physics) while the pop-in/wobble animate
 * the child locally.
 */
export async function spawnStandee(ctx: RIContext, _id: number, url: string): Promise<SpawnedObject> {
  const tex = await texLoader.loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  const { texture, aspect } = trimTransparentMargins(tex);

  // Fit longest edge to MAX_DIM.
  let h = MAX_DIM, w = MAX_DIM * aspect;
  if (w > MAX_DIM) { w = MAX_DIM; h = MAX_DIM / aspect; }

  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    alphaTest: STANDEE_ALPHATEST,
    side: THREE.DoubleSide,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0.35,
    metalness: 0,
    roughness: 1,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  plane.castShadow = true;

  const root = new THREE.Group();
  root.add(plane);
  root.position.set(0, h / 2 + 0.05, 0);

  const obj = ctx.world.addBody(
    root,
    { type: 'box', size: [w, h, 0.02] },
    { kind: 'standee', position: root.position },
  );

  // Pop-in (easeOutBack ~250ms) + subtle idle wobble (<=5deg), animated on the
  // child plane so the kinematic root transform (driven by the showcase) is untouched.
  animateStandee(plane);

  return obj;
}

/** Self-contained, fake-timer-safe local animator for the standee child mesh. */
function animateStandee(plane: THREE.Object3D): void {
  const POP_MS = 250;
  const WOBBLE = (5 * Math.PI) / 180; // <=5 degrees
  const start = Date.now();
  const raf = typeof requestAnimationFrame !== 'undefined'
    ? (cb: () => void) => requestAnimationFrame(() => cb())
    : (cb: () => void) => { setTimeout(cb, 16); };
  plane.scale.setScalar(0.01);
  function step(): void {
    const elapsed = Date.now() - start;
    if (elapsed < POP_MS) {
      const s = Math.max(0.01, easeOutBack(elapsed / POP_MS));
      plane.scale.setScalar(s);
      raf(step);
    } else {
      plane.scale.setScalar(1);
      // Idle wobble forever (cheap; child-local rotation).
      const t = (Date.now() - start) / 1000;
      plane.rotation.z = Math.sin(t * 1.4) * WOBBLE;
      raf(step);
    }
  }
  raf(step);
}

/** Load a GLB, normalize it to ~0.5m, add a hull collider, cast shadows. */
export async function spawnMeshFromUrl(ctx: RIContext, _id: number, url: string): Promise<SpawnedObject> {
  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const s = MAX_DIM / (Math.max(size.x, size.y, size.z) || 1);
  model.scale.setScalar(s);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
  model.position.sub(center);
  model.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
  const root = new THREE.Group();
  root.add(model);
  root.position.set(0, 0.6, 0);
  return ctx.world.addBody(root, { type: 'hull' }, { kind: 'mesh', position: root.position });
}
