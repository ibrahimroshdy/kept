/**
 * Renders every map shape once (D249), the way the map draws it: its Poly Haven model where it
 * has one, else Kept's drawn model, on a transparent background at the map's isometric angle.
 * scripts/render-map-thumbs.mjs opens this page in headless Chromium and packs the result into
 * src/map/thumbs/shapes.webp. Dev only; never part of the app.
 */
import { MAP_MODEL_KEYS, type MapModelKey, mapModel } from '@kept/shared';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { block, drawnModels, materials } from '../../src/map/engine/draw';
import { loadModel, readyModel } from '../../src/map/engine/models';

declare global {
  interface Window {
    thumbs?: Record<string, string>;
    thumbsError?: string;
  }
}

const SIZE = Number(new URLSearchParams(location.search).get('size') ?? '256');
const canvas = document.createElement('canvas');
canvas.width = SIZE;
canvas.height = SIZE;
document.body.append(canvas);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE, false);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xffffff, 0xb9ad98, 0.6));
const sun = new THREE.DirectionalLight(0xfff4e6, 2.1);
sun.position.set(16, 40, 24);
scene.add(sun);

const F = materials();
const BUILD = drawnModels(F);
/** The map's default view: from the front right, above. */
const VIEW = new THREE.Vector3(1, 1.05, 1.3).normalize();

async function modelOf(key: MapModelKey): Promise<THREE.Group> {
  const m = mapModel(key);
  const g = new THREE.Group();
  if (m.glb) {
    await loadModel(key);
    const real = readyModel(key);
    if (real) {
      const c = real.clone(true);
      c.position.set(m.w / 2, 0, m.d / 2);
      g.add(c);
      return g;
    }
  }
  const name = m.glb ? m.simple : BUILD[key] ? key : m.simple;
  const build = name ? BUILD[name] : undefined;
  if (build) build(g, m.w, m.d);
  else block(g, key, F);
  return g;
}

function shoot(g: THREE.Group): string {
  scene.add(g);
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 0.5;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, radius * 8 + 10);
  cam.position.copy(centre).addScaledVector(VIEW, radius * 4 + 2);
  cam.lookAt(centre);
  cam.updateMatrixWorld(true);
  // Fit the box's corners in view, square, with a small margin.
  const inv = cam.matrixWorldInverse;
  let half = 0;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).applyMatrix4(inv);
        half = Math.max(half, Math.abs(p.x), Math.abs(p.y));
      }
  half *= 1.06;
  cam.left = -half;
  cam.right = half;
  cam.top = half;
  cam.bottom = -half;
  cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  const url = canvas.toDataURL('image/png');
  scene.remove(g);
  return url;
}

(async () => {
  try {
    const out: Record<string, string> = {};
    for (const key of MAP_MODEL_KEYS) out[key] = shoot(await modelOf(key));
    window.thumbs = out;
  } catch (e) {
    window.thumbsError = String(e);
  }
})();
