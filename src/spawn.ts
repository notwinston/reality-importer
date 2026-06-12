/**
 * Object spawners shared by showcase + demo. The exported signatures are the
 * contract wave 2 must keep:
 *   spawnStandee(ctx, id, url)    -> textured double-sided plane placeholder
 *   spawnMeshFromUrl(ctx, id, url)-> real GLB mesh on a hull collider
 * Both are minimal-but-working so the pipeline runs end-to-end in wave 1.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RIContext, SpawnedObject } from './types';

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

/** A flat, double-sided textured standee (~0.5m tall) with a thin box collider. */
export async function spawnStandee(ctx: RIContext, _id: number, url: string): Promise<SpawnedObject> {
  const tex = await texLoader.loadAsync(url).catch(() => null);
  const ar = tex && tex.image ? (tex.image.width / tex.image.height) || 0.7 : 0.7;
  const h = 0.6, w = h * ar;
  const mat = new THREE.MeshStandardMaterial({
    map: tex ?? undefined, color: tex ? 0xffffff : 0x4488cc,
    transparent: true, side: THREE.DoubleSide,
    emissive: 0x113355, emissiveIntensity: 0.4,
  });
  if (tex) { tex.colorSpace = THREE.SRGBColorSpace; mat.emissiveMap = tex; }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.castShadow = true;
  const root = new THREE.Group(); root.add(mesh);
  root.position.set(0, h / 2 + 0.05, 0);
  return ctx.world.addBody(root, { type: 'box', size: [w, h, 0.04] }, { kind: 'standee', position: root.position });
}

/** Load a GLB, normalize it to ~0.5m, add a hull collider, drop it from ~2m. */
export async function spawnMeshFromUrl(ctx: RIContext, _id: number, url: string): Promise<SpawnedObject> {
  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const s = 0.5 / (Math.max(size.x, size.y, size.z) || 1);
  model.scale.setScalar(s);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
  model.position.sub(center);
  model.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
  const root = new THREE.Group(); root.add(model);
  root.position.set(0, 2, 0);
  return ctx.world.addBody(root, { type: 'hull' }, { kind: 'mesh', position: root.position });
}
