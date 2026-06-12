/**
 * The room: an expensive-looking dark stage with an emissive grid floor, bloom,
 * orbit camera, and a Rapier physics world. Owns WorldApi and is FROZEN after
 * wave 1 — wave-2 modules drive the scene only through the returned API.
 *
 * Renderer-free bookkeeping (collider math, registry, dup caps) lives in
 * src/worldcore.ts so it stays unit-testable; this file wires it to WebGL +
 * Rapier and runs the render loop.
 *
 * Confirmed three@0.184 addon import paths (examples/jsm/...).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';

import type {
  WorldApi, SpawnedObject, ColliderSpec, AddBodyOpts,
} from './types';
import {
  ObjectRegistry, allocId, gatherWorldVertices, planCollider, planDuplication,
  boundingHalfExtents, DUP_TOTAL_CAP,
} from './worldcore';
import { makeGridTexture, easeInOut, lerp } from './worldfx';

const FIXED_DT = 1 / 60;
const ROOM_HALF = 8;

type Body = {
  rb: RAPIER.RigidBody;
  kinematic: boolean;
  quatDriven: boolean;
  destroy: () => void;
};

interface Tween {
  from: THREE.Vector3; to: THREE.Vector3; t: number; ms: number;
  onDone?: () => void;
}

/** Construct and start the room. Resolves once Rapier WASM is ready. */
export async function initWorld(canvas: HTMLCanvasElement): Promise<WorldApi> {
  await RAPIER.init();

  // ── Renderer ──────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // ── Scene + fog ───────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  const bg = new THREE.Color('#0a0a12');
  scene.background = bg;
  scene.fog = new THREE.FogExp2(0x0a0a12, 0.045);

  // ── Camera ────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(3.2, 2.4, 4.4);

  // ── Lights ────────────────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0x6688ff, 0x080812, 0.5));
  const key = new THREE.DirectionalLight(0xbfdcff, 1.5);
  key.position.set(4, 7, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 30;
  (key.shadow.camera as THREE.OrthographicCamera).left = -10;
  (key.shadow.camera as THREE.OrthographicCamera).right = 10;
  (key.shadow.camera as THREE.OrthographicCamera).top = 10;
  (key.shadow.camera as THREE.OrthographicCamera).bottom = -10;
  scene.add(key);
  const rimCyan = new THREE.PointLight(0x33e6ff, 6, 18); rimCyan.position.set(-5, 3, -4);
  const rimMag = new THREE.PointLight(0xff3ce0, 5, 18); rimMag.position.set(5, 2.5, -5);
  scene.add(rimCyan, rimMag);

  // ── Floor ─────────────────────────────────────────────────────────────
  const floorMat = new THREE.MeshStandardMaterial({
    map: makeGridTexture(),
    emissive: new THREE.Color(0x0a3a66), emissiveIntensity: 0.6,
    metalness: 0.2, roughness: 0.5,
  });
  if (floorMat.map) floorMat.emissiveMap = floorMat.map;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // ── Postprocessing ────────────────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  let bloom: UnrealBloomPass | null = null;
  const BLOOM_BASE = 0.6;
  try {
    bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), BLOOM_BASE, 0.4, 0.85);
    composer.addPass(bloom);
  } catch (e) {
    console.warn('[world] bloom unavailable, shipping without it:', e);
  }

  // ── Controls ──────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;
  controls.minDistance = 2;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.49; // stay above the floor
  controls.target.set(0, 0.6, 0);

  // ── Physics world ─────────────────────────────────────────────────────
  const GRAV = -9.81;
  const physics = new RAPIER.World({ x: 0, y: GRAV, z: 0 });
  // Static floor.
  physics.createCollider(
    RAPIER.ColliderDesc.cuboid(ROOM_HALF, 0.1, ROOM_HALF).setTranslation(0, -0.1, 0),
  );
  // Four invisible walls.
  for (const [x, z, sx, sz] of [
    [ROOM_HALF, 0, 0.1, ROOM_HALF], [-ROOM_HALF, 0, 0.1, ROOM_HALF],
    [0, ROOM_HALF, ROOM_HALF, 0.1], [0, -ROOM_HALF, ROOM_HALF, 0.1],
  ] as const) {
    physics.createCollider(RAPIER.ColliderDesc.cuboid(sx, 4, sz).setTranslation(x, 4, z));
  }

  const reg = new ObjectRegistry();

  // ── Body construction ─────────────────────────────────────────────────
  function makeBody(root: THREE.Object3D, collider: ColliderSpec, opts: AddBodyOpts = {}): SpawnedObject {
    const kinematic = !!opts.kinematic;
    const pos = opts.position ?? root.position.clone();
    const rbDesc = (kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(pos.x, pos.y, pos.z);
    const rb = physics.createRigidBody(rbDesc);

    let cDesc: RAPIER.ColliderDesc | null = null;
    if (collider.type === 'box') {
      cDesc = RAPIER.ColliderDesc.cuboid(collider.size[0] / 2, collider.size[1] / 2, collider.size[2] / 2);
    } else {
      try {
        const plan = planCollider(gatherWorldVertices(root));
        cDesc = plan.kind === 'hull'
          ? RAPIER.ColliderDesc.convexHull(plan.points)
          : RAPIER.ColliderDesc.cuboid(...plan.half);
      } catch (e) {
        console.warn('[world] hull build failed, cuboid fallback:', e);
      }
      if (!cDesc) {
        const half = boundingHalfExtents(gatherWorldVertices(root));
        cDesc = RAPIER.ColliderDesc.cuboid(...half);
      }
    }
    cDesc.setRestitution(0.25).setFriction(0.8);
    physics.createCollider(cDesc, rb);

    if (!kinematic) {
      if (opts.velocity) rb.setLinvel(opts.velocity, true);
      if (opts.angularVelocity) rb.setAngvel(opts.angularVelocity, true);
    }

    root.position.copy(pos);
    scene.add(root);
    const obj: SpawnedObject = { id: allocId(), kind: opts.kind ?? 'mesh', root };
    reg.add(obj, {
      rb, kinematic, quatDriven: false,
      destroy: () => { try { physics.removeRigidBody(rb); } catch { /* gone */ } scene.remove(root); },
    } as Body);
    return obj;
  }

  function bodyOf(id: number): Body | undefined {
    return reg.get(id)?.body as Body | undefined;
  }

  // ── Test prop (always available, even without the canned glb) ───────────
  function spawnTestObject(): SpawnedObject {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.28, 0),
      new THREE.MeshStandardMaterial({ color: 0x335577, emissive: 0x1188cc, emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.3 }),
    );
    mesh.castShadow = true;
    const root = new THREE.Group(); root.add(mesh);
    root.position.set(0, 2, 0);
    return makeBody(root, { type: 'box', size: [0.56, 0.56, 0.56] }, { kind: 'test' });
  }

  // ── Camera focus + bloom pulse tweens ───────────────────────────────────
  let camTween: Tween | null = null;
  let savedAutoRotate = controls.autoRotateSpeed;
  let bloomPulseEnd = 0, bloomPulseDur = 0;

  function focusCamera(target: THREE.Vector3, ms: number): void {
    camTween = { from: controls.target.clone(), to: target.clone(), t: 0, ms: Math.max(1, ms) };
    savedAutoRotate = 0.3;
    controls.autoRotateSpeed = 0;
  }
  function releaseCameraFocus(): void {
    controls.autoRotateSpeed = savedAutoRotate || 0.3;
    controls.autoRotate = true;
  }
  function pulseBloom(ms: number): void {
    if (!bloom) { console.warn('[world] pulseBloom no-op (no bloom pass)'); return; }
    bloomPulseDur = Math.max(1, ms);
    // mark start via a frame counter instead of Date — use accumulated clock.
    bloomPulseEnd = clock + bloomPulseDur / 1000;
  }

  // ── Gravity flip ─────────────────────────────────────────────────────
  let gravityEnd = 0;
  function flipGravity(ms: number): void {
    physics.gravity = { x: 0, y: -GRAV, z: 0 };
    gravityEnd = clock + Math.max(1, ms) / 1000;
  }

  // ── Duplicate rain ───────────────────────────────────────────────────
  function duplicateLast(count: number): void {
    const src = reg.lastNonTest();
    if (!src) return;
    const { make, removeOldest } = planDuplication(reg.size(), count, 10, DUP_TOTAL_CAP);
    // Drop oldest non-test objects to stay under the cap.
    let dropped = 0;
    for (const id of reg.ids()) {
      if (dropped >= removeOldest) break;
      const e = reg.get(id);
      if (e && e.obj.kind !== 'test') { reg.remove(id); dropped++; }
    }
    for (let i = 0; i < make; i++) {
      const clone = src.root.clone(true);
      const jitter = new THREE.Vector3((Math.sin(i * 12.9) * 0.6), 2 + i * 0.15, Math.cos(i * 7.3) * 0.6);
      clone.position.copy(src.root.position).add(jitter);
      makeBody(clone, { type: 'box', size: [0.5, 0.5, 0.5] }, {
        kind: src.kind, position: clone.position,
        angularVelocity: new THREE.Vector3(Math.sin(i) * 3, Math.cos(i) * 3, 2),
      });
    }
  }

  function reset(): void {
    for (const o of reg.objects()) reg.remove(o.id);
    spawnTestObject();
  }

  // ── Pointer drag (kinematic-follow grab) ────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let grabbed: { id: number; depth: number; plane: THREE.Plane } | null = null;
  let lastPointer: THREE.Vector3[] = [];

  function pointerToNdc(e: PointerEvent): void {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  }
  renderer.domElement.addEventListener('pointerdown', (e) => {
    pointerToNdc(e);
    raycaster.setFromCamera(ndc, camera);
    const roots = reg.objects().map((o) => o.root);
    const hits = raycaster.intersectObjects(roots, true);
    if (!hits.length) return;
    let hitRoot = hits[0].object as THREE.Object3D;
    while (hitRoot.parent && !roots.includes(hitRoot)) hitRoot = hitRoot.parent;
    const found = reg.objects().find((o) => o.root === hitRoot);
    if (!found) return;
    const depth = camera.position.distanceTo(hits[0].point);
    const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hits[0].point);
    grabbed = { id: found.id, depth, plane };
    lastPointer = [hits[0].point.clone()];
    setKinematic(found.id, true);
    controls.enabled = false;
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!grabbed) return;
    pointerToNdc(e);
    raycaster.setFromCamera(ndc, camera);
    const pt = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(grabbed.plane, pt)) {
      moveKinematic(grabbed.id, pt);
      lastPointer.push(pt.clone());
      if (lastPointer.length > 4) lastPointer.shift();
    }
  });
  function endGrab(): void {
    if (!grabbed) return;
    const id = grabbed.id;
    setKinematic(id, false);
    if (lastPointer.length >= 2) {
      const v = lastPointer[lastPointer.length - 1].clone().sub(lastPointer[0]).multiplyScalar(8);
      applyVelocity(id, v);
    }
    grabbed = null; lastPointer = []; controls.enabled = true;
  }
  renderer.domElement.addEventListener('pointerup', endGrab);
  renderer.domElement.addEventListener('pointerleave', endGrab);

  // ── Kinematic + velocity helpers ────────────────────────────────────────
  function setKinematic(id: number, on: boolean): void {
    const b = bodyOf(id);
    if (!b) return;
    b.rb.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
    b.kinematic = on;
    if (!on) b.quatDriven = false;
  }
  function moveKinematic(id: number, pos: THREE.Vector3, quat?: THREE.Quaternion): void {
    const b = bodyOf(id);
    if (!b) return;
    b.rb.setNextKinematicTranslation(pos);
    if (quat) { b.rb.setNextKinematicRotation(quat); b.quatDriven = true; }
  }
  function applyVelocity(id: number, v: THREE.Vector3, angular?: THREE.Vector3): void {
    const b = bodyOf(id);
    if (!b || b.kinematic) return;
    b.rb.setLinvel(v, true);
    if (angular) b.rb.setAngvel(angular, true);
  }

  // ── Boot: try the canned glb, always have a test prop ───────────────────
  spawnTestObject();
  try {
    const loader = new GLTFLoader();
    loader.load('/canned/test.glb', (gltf) => {
      const root = gltf.scene;
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const s = 0.5 / (Math.max(size.x, size.y, size.z) || 1);
      root.scale.setScalar(s);
      const c = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
      root.position.sub(c);
      const holder = new THREE.Group(); holder.add(root); holder.position.set(0.8, 2, 0);
      holder.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
      makeBody(holder, { type: 'hull' }, { kind: 'test', position: holder.position });
    }, undefined, (e) => console.warn('[world] canned test.glb not loaded (expected pre-Unit5):', e));
  } catch (e) {
    console.warn('[world] glb boot skipped:', e);
  }

  // ── Render loop ──────────────────────────────────────────────────────
  let clock = 0;
  let acc = 0;
  let prev = performance.now();
  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now; clock += dt; acc += dt;
    while (acc >= FIXED_DT) { physics.step(); acc -= FIXED_DT; }

    // Sync meshes from bodies.
    for (const o of reg.objects()) {
      const b = bodyOf(o.id);
      if (!b) continue;
      const t = b.rb.translation();
      o.root.position.set(t.x, t.y, t.z);
      if (!(b.kinematic && !b.quatDriven)) {
        const r = b.rb.rotation();
        o.root.quaternion.set(r.x, r.y, r.z, r.w);
      }
    }

    // Gravity restore.
    if (gravityEnd && clock >= gravityEnd) { physics.gravity = { x: 0, y: GRAV, z: 0 }; gravityEnd = 0; }

    // Camera focus tween.
    if (camTween) {
      camTween.t += (dt * 1000) / camTween.ms;
      const e = easeInOut(camTween.t);
      controls.target.lerpVectors(camTween.from, camTween.to, e);
      if (camTween.t >= 1) { camTween.onDone?.(); camTween = null; }
    }

    // Bloom pulse.
    if (bloom) {
      if (bloomPulseEnd && clock < bloomPulseEnd) {
        const k = 1 - (bloomPulseEnd - clock) / (bloomPulseDur / 1000);
        const tri = Math.sin(Math.min(1, Math.max(0, k)) * Math.PI); // 0->1->0
        bloom.strength = lerp(BLOOM_BASE, BLOOM_BASE * 2, tri);
      } else if (bloomPulseEnd) {
        bloom.strength = BLOOM_BASE; bloomPulseEnd = 0;
      }
    }

    controls.update();
    composer.render();
  }
  requestAnimationFrame(frame);

  // ── Resize ───────────────────────────────────────────────────────────
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    bloom?.setSize(innerWidth, innerHeight);
  });

  // ── WorldApi ────────────────────────────────────────────────────────
  return {
    scene, camera, renderer, controls, rapierWorld: physics,
    webcamVideo: null,
    addBody: makeBody,
    removeObject: (id) => reg.remove(id),
    objects: () => reg.objects(),
    nearestObject: (point, maxDist) => reg.nearestObject(point, maxDist),
    setKinematic, moveKinematic, applyVelocity,
    duplicateLast, reset, flipGravity,
    focusCamera, releaseCameraFocus, pulseBloom,
  };
}
