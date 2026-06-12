/**
 * Unit tests for the renderer-free room core (src/worldcore.ts). These run in
 * node under vitest — no WebGL, no Rapier WASM — and cover the four mandatory
 * topics: hull decimation <=1024, cuboid fallback on degenerate geometry,
 * duplicate-rain capping, and registry add/remove/nearestObject math.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  decimateVertices,
  planCollider,
  planDuplication,
  ObjectRegistry,
  allocId,
  MAX_HULL_VERTS,
  DUP_PER_CALL,
  DUP_TOTAL_CAP,
} from '../src/worldcore';
import type { SpawnedObject } from '../src/types';

function obj(kind: SpawnedObject['kind'], pos: [number, number, number]): SpawnedObject {
  const root = new THREE.Object3D();
  root.position.set(...pos);
  return { id: allocId(), kind, root };
}

describe('decimateVertices', () => {
  it('decimates a large vertex cloud to at most MAX_HULL_VERTS points', () => {
    const n = 5000;
    const flat = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) flat[i] = i;
    const out = decimateVertices(flat);
    expect(out.length / 3).toBeLessThanOrEqual(MAX_HULL_VERTS);
    expect(out.length % 3).toBe(0);
  });

  it('leaves a small cloud unchanged', () => {
    const flat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(decimateVertices(flat)).toBe(flat);
  });
});

describe('planCollider', () => {
  it('builds a hull for a healthy 3D cloud', () => {
    // A unit cube's 8 corners — clearly non-degenerate.
    const flat = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
      1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1,
    ]);
    const plan = planCollider(flat);
    expect(plan.kind).toBe('hull');
  });

  it('falls back to a cuboid on degenerate (flat/too-few) geometry', () => {
    // All points share z=0 AND y=0 -> a near-zero-thickness, collinear cloud.
    const flat = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const plan = planCollider(flat);
    expect(plan.kind).toBe('box');
    if (plan.kind === 'box') {
      expect(plan.half.length).toBe(3);
      expect(plan.half.every((h) => h > 0)).toBe(true);
    }
  });
});

describe('planDuplication caps', () => {
  it('clamps a single call to DUP_PER_CALL', () => {
    const { make, removeOldest } = planDuplication(0, 100);
    expect(make).toBe(DUP_PER_CALL);
    expect(removeOldest).toBe(0);
  });

  it('drops oldest to respect the global DUP_TOTAL_CAP', () => {
    const { make, removeOldest } = planDuplication(DUP_TOTAL_CAP - 2, 10);
    expect(make).toBe(DUP_PER_CALL);
    expect(removeOldest).toBe(make - 2); // would overflow by (make-2)
    expect(DUP_TOTAL_CAP - 2 + make - removeOldest).toBe(DUP_TOTAL_CAP);
  });
});

describe('ObjectRegistry', () => {
  it('adds, removes, and lists objects in insertion order', () => {
    const reg = new ObjectRegistry();
    const a = reg.add(obj('test', [0, 0, 0]));
    const b = reg.add(obj('mesh', [1, 0, 0]));
    expect(reg.size()).toBe(2);
    expect(reg.objects().map((o) => o.id)).toEqual([a.id, b.id]);
    reg.remove(a.id);
    expect(reg.has(a.id)).toBe(false);
    expect(reg.objects().map((o) => o.id)).toEqual([b.id]);
  });

  it('lastNonTest skips test props', () => {
    const reg = new ObjectRegistry();
    reg.add(obj('mesh', [0, 0, 0]));
    const last = reg.add(obj('standee', [5, 0, 0]));
    reg.add(obj('test', [9, 0, 0]));
    expect(reg.lastNonTest()?.id).toBe(last.id);
  });

  it('nearestObject returns the closest within maxDist and null beyond it', () => {
    const reg = new ObjectRegistry();
    const near = reg.add(obj('mesh', [1, 0, 0]));
    reg.add(obj('mesh', [10, 0, 0]));
    const hit = reg.nearestObject(new THREE.Vector3(0, 0, 0), 2);
    expect(hit?.id).toBe(near.id);
    expect(reg.nearestObject(new THREE.Vector3(0, 0, 0), 0.5)).toBeNull();
  });
});

describe('allocId', () => {
  it('is monotonic', () => {
    expect(allocId()).toBeLessThan(allocId());
  });
});
