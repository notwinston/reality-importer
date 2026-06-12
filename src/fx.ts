/**
 * Visual FX primitives for the import ceremony — everything additive/emissive so
 * the world's UnrealBloom pass sells it on a projector. Pure easing helpers plus
 * four scene-graph builders (burst, dust, ring, spot cone). No WebGL context is
 * needed to *construct* any of these, so they are safe to build in a node test.
 *
 * three@0.184 (examples/jsm addon paths). Points + AdditiveBlending, depthWrite off.
 */
import * as THREE from 'three';

// ── Easing ──────────────────────────────────────────────────────────────────

/** Elastic overshoot settling to 1 — the inflate pop. easeOutElastic(0)=0,(1)=1. */
export function easeOutElastic(t: number): number {
  const c4 = (2 * Math.PI) / 3;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

/** Back overshoot — crosses above 1 before settling. easeOutBack(1)=1. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Smooth symmetric ease. easeInOutCubic(0)=0, (1)=1. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ── Particle / mesh builders ─────────────────────────────────────────────────

export interface Burst {
  object3d: THREE.Points;
  update(dt: number): void;
  done: boolean;
}

export interface Dust {
  object3d: THREE.Points;
  update(dt: number): void;
}

export interface Ring {
  object3d: THREE.Mesh;
  pulse(t: number): void;
}

/**
 * A radial particle burst — additive points flung outward from `origin`, each with
 * its own velocity + lifetime. `done` flips true once every particle has expired.
 */
export function makeBurst(origin: THREE.Vector3, color: THREE.ColorRepresentation = 0x66f0ff, count = 60): Burst {
  const positions = new Float32Array(count * 3);
  const velocities: THREE.Vector3[] = [];
  const lifetimes = new Float32Array(count);
  const ages = new Float32Array(count);
  const maxLife = 1.1;

  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = origin.x;
    positions[i * 3 + 1] = origin.y;
    positions[i * 3 + 2] = origin.z;
    // Random direction on a biased-upward sphere.
    const theta = (i * 2.399963) % (Math.PI * 2); // golden-angle spread, deterministic
    const phi = Math.acos(1 - 2 * ((i + 0.5) / count));
    const speed = 1.6 + (i % 7) * 0.18;
    velocities.push(new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * speed,
      Math.abs(Math.cos(phi)) * speed * 0.9 + 0.6,
      Math.sin(phi) * Math.sin(theta) * speed,
    ));
    lifetimes[i] = maxLife * (0.6 + ((i % 5) * 0.1));
    ages[i] = 0;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color, size: 0.09, sizeAttenuation: true,
    transparent: true, opacity: 1, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const object3d = new THREE.Points(geo, mat);
  object3d.frustumCulled = false;

  const burst: Burst = {
    object3d,
    done: false,
    update(dt: number) {
      if (burst.done) return;
      const attr = geo.getAttribute('position') as THREE.BufferAttribute;
      let alive = 0;
      let maxRemaining = 0;
      for (let i = 0; i < count; i++) {
        ages[i] += dt;
        const rem = lifetimes[i] - ages[i];
        if (rem <= 0) continue;
        alive++;
        maxRemaining = Math.max(maxRemaining, rem);
        const v = velocities[i];
        v.y -= 2.2 * dt; // gravity drag
        positions[i * 3 + 0] += v.x * dt;
        positions[i * 3 + 1] += v.y * dt;
        positions[i * 3 + 2] += v.z * dt;
      }
      attr.needsUpdate = true;
      mat.opacity = Math.max(0, Math.min(1, maxRemaining / maxLife));
      if (alive === 0) burst.done = true;
    },
  };
  return burst;
}

/**
 * A slow-drifting field of glowy points around the pedestal (radius ring).
 * Returned object exposes update(dt) to keep them wandering.
 */
export function makeDust(radius: number, count = 150): Dust {
  const positions = new Float32Array(count * 3);
  const drift: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = radius * (0.4 + ((i % 9) / 9) * 0.9);
    positions[i * 3 + 0] = Math.cos(a) * r;
    positions[i * 3 + 1] = 0.05 + ((i % 11) / 11) * 1.4;
    positions[i * 3 + 2] = Math.sin(a) * r;
    drift.push(new THREE.Vector3(
      Math.sin(i * 1.3) * 0.04,
      0.05 + (i % 3) * 0.02,
      Math.cos(i * 0.7) * 0.04,
    ));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x55ddff, size: 0.035, sizeAttenuation: true,
    transparent: true, opacity: 0.7, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const object3d = new THREE.Points(geo, mat);
  object3d.frustumCulled = false;

  return {
    object3d,
    update(dt: number) {
      const attr = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < count; i++) {
        const d = drift[i];
        let y = positions[i * 3 + 1] + d.y * dt;
        if (y > 1.6) y = 0.05; // recycle upward drift
        positions[i * 3 + 0] += d.x * dt;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] += d.z * dt;
      }
      attr.needsUpdate = true;
    },
  };
}

/** An emissive cyan torus laid flat on the floor, pulsing via pulse(t). */
export function makeRing(radius: number): Ring {
  const geo = new THREE.TorusGeometry(radius, radius * 0.06, 16, 96);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0a2a33,
    emissive: new THREE.Color(0x33e6ff),
    emissiveIntensity: 1.4,
    transparent: true, opacity: 0.9, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const object3d = new THREE.Mesh(geo, mat);
  object3d.rotation.x = -Math.PI / 2;
  object3d.position.y = 0.02;

  return {
    object3d,
    pulse(t: number) {
      const s = 1 + 0.06 * Math.sin(t * 3.2);
      object3d.scale.set(s, s, 1);
      mat.emissiveIntensity = 1.1 + 0.7 * (0.5 + 0.5 * Math.sin(t * 3.2));
    },
  };
}

/**
 * An additive, transparent, depthWrite-off spotlight cone (apex up). Cheap volumetric
 * fake that reads as a beam under bloom.
 */
export function makeSpotCone(height: number): THREE.Mesh {
  const geo = new THREE.ConeGeometry(height * 0.5, height, 32, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x9fe8ff,
    transparent: true, opacity: 0.12, depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const cone = new THREE.Mesh(geo, mat);
  // Apex at top, wide base near the floor: cone default apex is +y; flip so it opens down.
  cone.rotation.x = Math.PI;
  cone.position.y = height / 2;
  return cone;
}
