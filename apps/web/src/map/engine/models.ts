/**
 * The location map's real models (1.x, D237): Poly Haven's CC0 models, shrunk for phones and
 * shipped as .glb files under /assets/ with a long cache (models/NOTICE.txt). Each is fetched the
 * first time a floor in view needs it, then shared by every copy. Never precached.
 */
import { type MapModelKey, mapModel } from '@kept/shared';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Each model's URL, by its file name (`sofa_02`). */
const URLS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../models/*.glb', { query: '?url', import: 'default', eager: true }),
  ).map(([path, url]) => [path.replace(/^.*\/([^/]+)\.glb$/, '$1'), url]),
);

/** The models Kept ships (for the readout and tests). */
export const SHIPPED_MODELS = Object.keys(URLS);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
// Kept's CSP allows images from blob: but not fetch()es of them, which GLTFLoader's
// ImageBitmapLoader makes for a .glb's embedded textures: load them as <img> instead.
loader.register((parser) => {
  parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
  return { name: 'kept_texture_loader' };
});

export type ModelStats = { count: number; bytes: number; failed: number; loading: number };

const loads = new Map<string, Promise<void>>();
const ready = new Map<string, THREE.Group>();
const stats: ModelStats = { count: 0, bytes: 0, failed: 0, loading: 0 };

export const modelStats = (): ModelStats => ({ ...stats });

/** Centres the model on its footprint, standing on the floor, turned to face +z. */
function prepare(root: THREE.Object3D, rotFix: number): THREE.Group {
  const holder = new THREE.Group();
  root.rotation.y = THREE.MathUtils.degToRad(rotFix);
  holder.add(root);
  holder.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(holder);
  const c = b.getCenter(new THREE.Vector3());
  root.position.set(-c.x, -b.min.y, -c.z);
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return holder;
}

/** The ready model of a catalogue key, or undefined (none, not loaded yet, or failed). */
export function readyModel(key: MapModelKey): THREE.Group | undefined {
  const glb = mapModel(key).glb;
  return glb ? ready.get(glb) : undefined;
}

export const hasGlb = (key: MapModelKey): boolean => {
  const glb = mapModel(key).glb;
  return !!glb && glb in URLS;
};

/** Starts loading a catalogue key's model; resolves when it is ready (or failed). */
export function loadModel(key: MapModelKey): Promise<void> {
  const m = mapModel(key);
  const glb = m.glb;
  const url = glb ? URLS[glb] : undefined;
  if (!glb || !url) return Promise.resolve();
  let p = loads.get(glb);
  if (!p) {
    stats.loading++;
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${glb}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(async (buf) => {
        stats.bytes += buf.byteLength;
        stats.count++;
        const gltf = await loader.parseAsync(buf, '');
        ready.set(glb, prepare(gltf.scene, m.rotFix ?? 0));
      })
      .catch((e: unknown) => {
        stats.failed++;
        console.warn(e);
      })
      .finally(() => {
        stats.loading--;
      });
    loads.set(glb, p);
  }
  return p;
}

export const isLoading = (key: MapModelKey): boolean => {
  const glb = mapModel(key).glb;
  return !!glb && loads.has(glb) && !ready.has(glb);
};

export const wasRequested = (key: MapModelKey): boolean => {
  const glb = mapModel(key).glb;
  return !!glb && loads.has(glb);
};
