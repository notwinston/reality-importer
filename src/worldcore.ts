/**
 * Renderer-free core of the room: collider math, vertex decimation, the object
 * registry, duplicate-rain capping, and nearest-object lookup.
 *
 * This module imports ONLY three's math/geometry types (no WebGL renderer, no
 * Rapier WASM), so the same logic that runs in the browser is covered by node
 * vitest in tests/world.test.ts. world.ts composes these helpers with the live
 * renderer and physics world. FROZEN after wave 1.
 */
import * as THREE from 'three';
import type { SpawnedObject } from './types';

/** Maximum vertices fed to a convex-hull collider (Rapier perf guard). */
export const MAX_HULL_VERTS = 1024;
/** Per-call and global caps for duplicate rain. */
export const DUP_PER_CALL = 10;
export const DUP_TOTAL_CAP = 60;

/**
 * Collect merged WORLD-SPACE vertex positions from every Mesh under `root`.
 * Returns a flat [x,y,z,x,y,z,...] Float32Array (Rapier's expected layout).
 */
export function gatherWorldVertices(root: THREE.Object3D): Float32Array {
  const out: number[] = [];
  const v = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const geom = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!geom || !geom.attributes || !geom.attributes.position) return;
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

/**
 * Decimate a flat [x,y,z,...] vertex buffer down to at most `max` POINTS
 * (i.e. `max*3` floats) by uniform stride sampling. Returns the input
 * unchanged when already small enough.
 */
export function decimateVertices(flat: Float32Array, max = MAX_HULL_VERTS): Float32Array {
  const count = Math.floor(flat.length / 3);
  if (count <= max) return flat;
  const stride = Math.ceil(count / max);
  const out: number[] = [];
  for (let i = 0; i < count && out.length / 3 < max; i += stride) {
    out.push(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]);
  }
  return new Float32Array(out);
}

/** Resolved collider plan: a hull point cloud, or a box fallback. */
export type ColliderPlan =
  | { kind: 'hull'; points: Float32Array }
  | { kind: 'box'; half: [number, number, number] };

/**
 * Decide the collider for an object's world vertices. Degenerate geometry
 * (fewer than 4 points, or a bounding box with a near-zero dimension — i.e. a
 * flat/collinear cloud a convex hull can't be built from) falls back to a
 * cuboid derived from the bounding box. Otherwise a decimated hull is used.
 */
export function planCollider(flat: Float32Array, minDim = 1e-4): ColliderPlan {
  const count = Math.floor(flat.length / 3);
  const box = boundingHalfExtents(flat);
  const degenerate =
    count < 4 || box[0] < minDim || box[1] < minDim || box[2] < minDim;
  if (degenerate) return { kind: 'box', half: box };
  return { kind: 'hull', points: decimateVertices(flat) };
}

/** Half-extents (>=minimum) of the bounding box of a flat vertex buffer. */
export function boundingHalfExtents(flat: Float32Array, floor = 0.02): [number, number, number] {
  const count = Math.floor(flat.length / 3);
  if (count === 0) return [floor, floor, floor];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = flat[i * 3], y = flat[i * 3 + 1], z = flat[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return [
    Math.max((maxX - minX) / 2, floor),
    Math.max((maxY - minY) / 2, floor),
    Math.max((maxZ - minZ) / 2, floor),
  ];
}

/** Clamp a duplicate-rain request to the per-call and global caps. */
export function planDuplication(
  currentTotal: number,
  requested: number,
  perCall = DUP_PER_CALL,
  maxTotal = DUP_TOTAL_CAP,
): { make: number; removeOldest: number } {
  const make = Math.max(0, Math.min(requested, perCall));
  const projected = currentTotal + make;
  const removeOldest = Math.max(0, projected - maxTotal);
  return { make, removeOldest };
}

/** A physics body handle — kept generic so this file never imports Rapier. */
export interface BodyHandle {
  /** Remove the body from the physics world. */
  destroy?: () => void;
  [k: string]: unknown;
}

interface Entry {
  obj: SpawnedObject;
  body?: BodyHandle;
}

/**
 * Insertion-ordered registry of spawned objects. Pure data structure: world.ts
 * supplies the bodies, but the bookkeeping (order, nearest, last-non-test) is
 * here so it is unit-testable without a renderer.
 */
export class ObjectRegistry {
  private readonly entries = new Map<number, Entry>();
  private readonly order: number[] = [];

  add(obj: SpawnedObject, body?: BodyHandle): SpawnedObject {
    this.entries.set(obj.id, { obj, body });
    this.order.push(obj.id);
    return obj;
  }

  remove(id: number): BodyHandle | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    this.entries.delete(id);
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    e.body?.destroy?.();
    return e.body;
  }

  get(id: number): Entry | undefined {
    return this.entries.get(id);
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  size(): number {
    return this.entries.size;
  }

  objects(): SpawnedObject[] {
    return this.order
      .map((id) => this.entries.get(id)?.obj)
      .filter((o): o is SpawnedObject => !!o);
  }

  /** Ids in insertion order (oldest first) — used to drop oldest on overflow. */
  ids(): number[] {
    return [...this.order];
  }

  /** The most recently added object whose kind is not 'test', else null. */
  lastNonTest(): SpawnedObject | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const e = this.entries.get(this.order[i]);
      if (e && e.obj.kind !== 'test') return e.obj;
    }
    return null;
  }

  /** Nearest object to `point` within `maxDist` (by root position), else null. */
  nearestObject(point: THREE.Vector3, maxDist: number): SpawnedObject | null {
    let best: SpawnedObject | null = null;
    let bestD = maxDist;
    for (const id of this.order) {
      const e = this.entries.get(id);
      if (!e) continue;
      const d = e.obj.root.position.distanceTo(point);
      if (d <= bestD) {
        bestD = d;
        best = e.obj;
      }
    }
    return best;
  }
}

let nextId = 1;
/** Monotonic spawn id allocator (shared across modules through WorldApi). */
export function allocId(): number {
  return nextId++;
}
