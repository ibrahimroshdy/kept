/**
 * What the location map draws without downloading anything (1.x, D237; ported from the approved
 * spike): floor surfaces and fabric and wood grain painted on a canvas, the materials, and the
 * drawn models (appliances and pieces the free library doesn't have, and the stand-ins used when
 * detailed models are off). Sizes are metres; a model is built in a group with its corner at the
 * origin, width along x and depth along z.
 */
import type { MapModelKey, MapSurface } from '@kept/shared';
import { mapModel } from '@kept/shared';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ---- Surfaces drawn in the browser: no downloads ----------------------------------------------

let seed = 1;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
type Rgb = readonly [number, number, number];
const rgba = ([r, g, b]: Rgb, a = 1, k = 1) =>
  `rgba(${Math.round(Math.min(255, r * k))},${Math.round(Math.min(255, g * k))},${Math.round(Math.min(255, b * k))},${a})`;

function tex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  seed = 4242 + size;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (g) draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function grain(
  g: CanvasRenderingContext2D,
  base: Rgb,
  x0: number,
  y0: number,
  w: number,
  h: number,
  vertical: boolean,
  n: number,
) {
  for (let i = 0; i < n; i++) {
    const p = rnd();
    const ph = rnd() * 6;
    const amp = 0.6 + rnd() * 2.4;
    g.strokeStyle = rgba(base, 0.05 + rnd() * 0.13, 0.55);
    g.lineWidth = 0.5 + rnd() * 1.5;
    g.beginPath();
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const along = vertical ? y0 + t * h : x0 + t * w;
      const across = (vertical ? x0 + p * w : y0 + p * h) + Math.sin(t * 5 + ph) * amp;
      const [x, y] = vertical ? [across, along] : [along, across];
      if (t) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
  }
}

const woodTex = (base: Rgb) =>
  tex(256, (g, s) => {
    g.fillStyle = rgba(base);
    g.fillRect(0, 0, s, s);
    grain(g, base, 0, 0, s, s, true, 110);
  });

const fabricTex = (base: Rgb) =>
  tex(128, (g, s) => {
    g.fillStyle = rgba(base);
    g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) {
      g.fillStyle = rgba(base, 0.3 * rnd(), y % 4 ? 0.86 : 1.1);
      g.fillRect(0, y, s, 1);
    }
    for (let x = 0; x < s; x += 2) {
      g.fillStyle = rgba(base, 0.2 * rnd(), 0.84);
      g.fillRect(x, 0, 1, s);
    }
  });

type Floor = { m: number; rough: number; draw: (g: CanvasRenderingContext2D, s: number) => void };

const FLOORS: Record<MapSurface, Floor> = {
  wood: {
    m: 2.4,
    rough: 0.55,
    draw: (g, s) => {
      const base: Rgb = [198, 160, 114];
      const pw = s / 12;
      for (let c = 0; c < 12; c++) {
        let y = -rnd() * s * 0.6;
        while (y < s) {
          const len = s * (0.3 + rnd() * 0.35);
          const k = 0.84 + rnd() * 0.26;
          const col: Rgb = [base[0] * k, base[1] * k, base[2] * k];
          g.fillStyle = rgba(col);
          g.fillRect(c * pw, y, pw, len);
          grain(g, col, c * pw, y, pw, len, true, 7);
          g.fillStyle = 'rgba(70,45,20,.35)';
          g.fillRect(c * pw, y, pw, 1.5);
          y += len;
        }
        g.fillStyle = 'rgba(70,45,20,.3)';
        g.fillRect(c * pw, 0, 1.2, s);
      }
    },
  },
  tile: {
    m: 1.2,
    rough: 0.3,
    draw: (g, s) => {
      g.fillStyle = '#b6afa3';
      g.fillRect(0, 0, s, s);
      const n = 4;
      const t = s / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          g.fillStyle = rgba([234, 230, 222], 1, 0.94 + rnd() * 0.08);
          g.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
          for (let q = 0; q < 70; q++) {
            g.fillStyle = rgba([150, 140, 128], 0.07);
            g.fillRect(
              i * t + 3 + rnd() * (t - 10),
              j * t + 3 + rnd() * (t - 10),
              2 + rnd() * 7,
              2 + rnd() * 7,
            );
          }
        }
      }
    },
  },
  concrete: {
    m: 3,
    rough: 0.92,
    draw: (g, s) => {
      g.fillStyle = '#aaa69f';
      g.fillRect(0, 0, s, s);
      for (let q = 0; q < 9000; q++) {
        g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.07)' : 'rgba(40,40,40,.08)';
        g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 3, 1 + rnd() * 3);
      }
      g.fillStyle = 'rgba(60,60,60,.22)';
      g.fillRect(0, 0, s, 1.5);
      g.fillRect(0, 0, 1.5, s);
    },
  },
  deck: {
    m: 1.4,
    rough: 0.8,
    draw: (g, s) => {
      const n = 10;
      const h = s / n;
      g.fillStyle = '#3a2a1c';
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < n; i++) {
        const k = 0.85 + rnd() * 0.25;
        const col: Rgb = [152 * k, 106 * k, 72 * k];
        g.fillStyle = rgba(col);
        g.fillRect(0, i * h + 1.5, s, h - 3);
        grain(g, col, 0, i * h + 1.5, s, h - 3, false, 5);
      }
    },
  },
  grass: {
    m: 2,
    rough: 1,
    draw: (g, s) => {
      g.fillStyle = '#6f8f4e';
      g.fillRect(0, 0, s, s);
      for (let q = 0; q < 7000; q++) {
        g.fillStyle = rgba(rnd() > 0.5 ? [128, 168, 84] : [70, 100, 50], 0.35);
        g.fillRect(rnd() * s, rnd() * s, 1, 2 + rnd() * 3);
      }
    },
  },
};

const floorTex = new Map<MapSurface, THREE.Texture>();
export const floorMats = new Map<string, THREE.MeshStandardMaterial>();

/** A room's floor, its texture repeated to the room's size, shared by rooms of one size. */
export function floorMaterial(r: { surface: MapSurface; w: number; d: number }) {
  const kind = FLOORS[r.surface] ? r.surface : 'wood';
  const key = `${kind}|${r.w}|${r.d}`;
  let mat = floorMats.get(key);
  if (!mat) {
    const f = FLOORS[kind];
    let base = floorTex.get(kind);
    if (!base) {
      base = tex(kind === 'deck' || kind === 'grass' ? 256 : 512, f.draw);
      floorTex.set(kind, base);
    }
    const t = base.clone();
    t.repeat.set(r.w / f.m, r.d / f.m);
    t.needsUpdate = true;
    mat = new THREE.MeshStandardMaterial({ map: t, roughness: f.rough });
    floorMats.set(key, mat);
  }
  return mat;
}

// ---- Materials ------------------------------------------------------------------------------

const MAT = new Map<string, THREE.MeshStandardMaterial>();
const mat = (key: string, o: THREE.MeshStandardMaterialParameters) => {
  let m = MAT.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial(o);
    MAT.set(key, m);
  }
  return m;
};

export type Materials = ReturnType<typeof materials>;

export function materials() {
  const wood = (rgb: Rgb, r = 0.55) => ({ map: woodTex(rgb), roughness: r });
  const cloth = (rgb: Rgb) => ({ map: fabricTex(rgb), roughness: 1 });
  return {
    fabric: mat('fabric', cloth([127, 140, 154])),
    fabricDark: mat('fabricDark', cloth([96, 107, 120])),
    cushion: mat('cushion', cloth([140, 153, 167])),
    linen: mat('linen', cloth([237, 230, 216])),
    duvet: mat('duvet', cloth([204, 212, 221])),
    pillow: mat('pillow', cloth([247, 244, 238])),
    headboard: mat('headboard', cloth([120, 104, 92])),
    oak: mat('oak', wood([197, 156, 100])),
    oakDark: mat('oakDark', wood([152, 112, 70])),
    walnut: mat('walnut', wood([112, 80, 52], 0.5)),
    butcher: mat('butcher', wood([186, 137, 80], 0.6)),
    laminate: mat('laminate', { color: 0xf4f2ec, roughness: 0.35 }),
    stone: mat('stone', { color: 0xd9d6d0, roughness: 0.35 }),
    steel: mat('steel', { color: 0xc7cacd, roughness: 0.32, metalness: 0.85 }),
    chrome: mat('chrome', { color: 0xe6e8ea, roughness: 0.15, metalness: 1 }),
    black: mat('black', { color: 0x222224, roughness: 0.45 }),
    blackGloss: mat('blackGloss', { color: 0x141416, roughness: 0.18, metalness: 0.2 }),
    screen: mat('screen', { color: 0x0e1622, roughness: 0.08, metalness: 0.6 }),
    glass: mat('glass', { color: 0xbfd6e2, roughness: 0.05, transparent: true, opacity: 0.35 }),
    white: mat('white', { color: 0xf6f5f1, roughness: 0.4 }),
    appliance: mat('appliance', { color: 0xe9e9e6, roughness: 0.3, metalness: 0.1 }),
    ceramic: mat('ceramic', { color: 0xefeae1, roughness: 0.3 }),
    terracotta: mat('terracotta', { color: 0xb0643f, roughness: 0.75 }),
    soil: mat('soil', { color: 0x4a3726, roughness: 1 }),
    leaf: mat('leaf', { color: 0x4e7f46, roughness: 0.7 }),
    leaf2: mat('leaf2', { color: 0x6b9a55, roughness: 0.7 }),
    carton: mat('carton', { color: 0xc4a06e, roughness: 0.9 }),
    tape: mat('tape', { color: 0xe9a52f, roughness: 0.6 }),
    label: mat('label', { color: 0xffffff, roughness: 0.6 }),
    brass: mat('brass', { color: 0xc9a65a, roughness: 0.3, metalness: 0.8 }),
    rubber: mat('rubber', { color: 0x1e1e20, roughness: 0.9 }),
    carPaint: mat('carPaint', { color: 0x3e5f80, roughness: 0.22, metalness: 0.55 }),
    red: mat('red', { color: 0xa63a30, roughness: 0.4 }),
    redLight: mat('redLight', { color: 0xc2382f, roughness: 0.2, emissive: 0x4a0b06 }),
    headlight: mat('headlight', { color: 0xf7f3e3, roughness: 0.1, emissive: 0x333022 }),
    pegboard: mat('pegboard', { color: 0xc9b08a, roughness: 0.8 }),
    green: mat('green', { color: 0x2f7a54, roughness: 0.4 }),
    booksA: mat('booksA', { color: 0x8c4a3a, roughness: 0.8 }),
    booksB: mat('booksB', { color: 0x3d5a73, roughness: 0.8 }),
    booksC: mat('booksC', { color: 0x6b7f4e, roughness: 0.8 }),
    booksD: mat('booksD', { color: 0xd3b45e, roughness: 0.8 }),
    booksE: mat('booksE', { color: 0x5e4b6b, roughness: 0.8 }),
    booksF: mat('booksF', { color: 0xe2dbcb, roughness: 0.8 }),
    mesh: mat('mesh', { color: 0x2c2d30, roughness: 0.9 }),
    tank: mat('tank', { color: 0xd9cba8, roughness: 0.6 }),
    parapet: mat('parapet', { color: 0xe3dccf, roughness: 0.9 }),
    void: mat('void', { color: 0x2a2723, roughness: 1 }),
  };
}

// ---- Shapes ---------------------------------------------------------------------------------

const geoCache = new Map<string, THREE.BufferGeometry>();
export function rgeo(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const k = `${w}|${h}|${d}|${r}`;
  let g = geoCache.get(k);
  if (!g) {
    g =
      r >= 0.008
        ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) / 2 - 0.0005))
        : new THREE.BoxGeometry(w, h, d);
    geoCache.set(k, g);
  }
  return g;
}

type Mat = THREE.Material;
export function rb(
  g: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  m: Mat,
  r = 0.02,
) {
  const o = new THREE.Mesh(rgeo(w, h, d, r), m);
  o.position.set(x, y, z);
  g.add(o);
  return o;
}
export function cy(
  g: THREE.Object3D,
  r1: number,
  r2: number,
  h: number,
  x: number,
  y: number,
  z: number,
  m: Mat,
  rx = 0,
  rz = 0,
  seg = 20,
  open = false,
) {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg, 1, open), m);
  o.position.set(x, y, z);
  o.rotation.x = rx;
  o.rotation.z = rz;
  g.add(o);
  return o;
}
function sp(
  g: THREE.Object3D,
  r: number,
  x: number,
  y: number,
  z: number,
  m: Mat,
  sx = 1,
  sy = 1,
  sz = 1,
) {
  const o = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  g.add(o);
  return o;
}
function tor(
  g: THREE.Object3D,
  r: number,
  t: number,
  x: number,
  y: number,
  z: number,
  m: Mat,
  ry = 0,
) {
  const o = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 28), m);
  o.position.set(x, y, z);
  o.rotation.y = ry;
  g.add(o);
  return o;
}
function legs4(
  g: THREE.Object3D,
  w: number,
  d: number,
  h: number,
  inset: number,
  m: Mat,
  r = 0.025,
  top = 0,
  ox = 0,
  oz = 0,
  taper = 0.8,
) {
  for (const [x, z] of [
    [inset, inset],
    [w - inset, inset],
    [inset, d - inset],
    [w - inset, d - inset],
  ] as const) {
    cy(g, r, r * taper, h, ox + x, top + h / 2, oz + z, m, 0, 0, 10);
  }
}
function slab(
  g: THREE.Object3D,
  len: number,
  t: number,
  w: number,
  x: number,
  y: number,
  z: number,
  m: Mat,
  tilt: number,
) {
  const o = rb(g, w, t, len, x, y, z, m, 0.004);
  o.rotation.x = tilt;
  return o;
}

// ---- Drawn models ---------------------------------------------------------------------------

type Build = (g: THREE.Group, w: number, d: number) => void;

/** The drawn models by name (MAP_MODELS' own key, or a `simple` stand-in's). */
export function drawnModels(F: Materials): Record<string, Build> {
  const BUILD: Record<string, Build> = {
    sofa(g, w, d) {
      legs4(g, w, d, 0.1, 0.08, F.black, 0.02);
      rb(g, w, 0.2, d, w / 2, 0.2, d / 2, F.fabricDark, 0.04);
      rb(g, 0.18, 0.42, d, 0.09, 0.42, d / 2, F.fabric, 0.07);
      rb(g, 0.18, 0.42, d, w - 0.09, 0.42, d / 2, F.fabric, 0.07);
      const sw = (w - 0.36) / 3;
      for (let i = 0; i < 3; i++) {
        rb(
          g,
          sw - 0.02,
          0.15,
          d - 0.24,
          0.18 + sw * (i + 0.5),
          0.375,
          d / 2 + 0.1,
          F.cushion,
          0.06,
        );
        const b = rb(g, sw - 0.03, 0.42, 0.2, 0.18 + sw * (i + 0.5), 0.6, 0.16, F.cushion, 0.08);
        b.rotation.x = -0.12;
      }
      rb(g, w - 0.04, 0.5, 0.14, w / 2, 0.55, 0.07, F.fabricDark, 0.05);
    },
    coffee_table(g, w, d) {
      rb(g, w, 0.035, d, w / 2, 0.37, d / 2, F.walnut, 0.015);
      legs4(g, w, d, 0.35, 0.07, F.walnut, 0.022, 0, 0, 0, 0.7);
    },
    tv_stand(g, w, d) {
      rb(g, w, 0.52, d, w / 2, 0.42, d / 2, F.walnut, 0.02);
      for (let i = 0; i < 4; i++)
        rb(g, w / 4 - 0.03, 0.46, 0.015, w / 8 + (i * w) / 4, 0.42, d + 0.005, F.oakDark, 0.01);
      legs4(g, w, d, 0.16, 0.07, F.black, 0.015);
    },
    dchair(g, w, d) {
      rb(g, w, 0.05, d * 0.8, w / 2, 0.46, d * 0.55, F.fabricDark, 0.02);
      legs4(g, w, d * 0.8, 0.44, 0.04, F.walnut, 0.016, 0, 0, d * 0.15);
      rb(g, w - 0.02, 0.5, 0.05, w / 2, 0.73, d * 0.17, F.fabricDark, 0.02);
    },
    shelf_unit(g, w, d) {
      for (const [x, z] of [
        [0.02, 0.02],
        [w - 0.02, 0.02],
        [0.02, d - 0.02],
        [w - 0.02, d - 0.02],
      ] as const)
        rb(g, 0.03, 2.1, 0.03, x, 1.05, z, F.black, 0.006);
      for (let s = 0; s < 5; s++) rb(g, w, 0.025, d, w / 2, 0.1 + s * 0.48, d / 2, F.oak, 0.004);
    },
    drill(g, w, d) {
      rb(g, 0.05, 0.11, 0.05, w / 2, 0.06, d / 2, F.black, 0.015);
      rb(g, 0.18, 0.07, 0.05, w / 2, 0.15, d / 2, F.green, 0.02);
    },
    tv(g, w, d) {
      rb(g, w, 0.72, 0.035, w / 2, 0.47, d / 2, F.blackGloss, 0.008);
      rb(g, w - 0.03, 0.69, 0.004, w / 2, 0.475, d / 2 + 0.018, F.screen, 0.002);
      rb(g, 0.36, 0.012, 0.2, w / 2, 0.006, d / 2, F.steel, 0.004);
      rb(g, 0.04, 0.1, 0.03, w / 2, 0.06, d / 2 - 0.02, F.steel, 0.008);
    },
    bookshelf(g, w, d) {
      const h = 2.0;
      const t = 0.025;
      rb(g, t, h, d, t / 2, h / 2, d / 2, F.oak, 0.006);
      rb(g, t, h, d, w - t / 2, h / 2, d / 2, F.oak, 0.006);
      rb(g, w, h, 0.01, w / 2, h / 2, 0.005, F.oakDark, 0);
      const books = [F.booksA, F.booksB, F.booksC, F.booksD, F.booksE, F.booksF];
      const book = (i: number) => books[i % 6] ?? F.booksA;
      for (let s = 0; s < 6; s++) {
        const y = 0.05 + (s * (h - 0.08)) / 5;
        rb(g, w - t * 2, t, d - 0.01, w / 2, y, d / 2, F.oak, 0.004);
        if (s === 5) continue;
        let x = t + 0.02;
        let i = s * 5;
        while (x < w - 0.12) {
          const bw = 0.025 + ((i * 7) % 5) * 0.008;
          const bh = 0.2 + ((i * 3) % 4) * 0.025;
          rb(g, bw, bh, d - 0.07, x + bw / 2, y + t / 2 + bh / 2, d / 2 + 0.02, book(i), 0.004);
          x += bw + 0.003;
          i++;
          if ((i * 11) % 13 === 0) {
            x += 0.04;
            const lean = rb(
              g,
              0.03,
              bh,
              d - 0.07,
              x,
              y + t / 2 + bh / 2 - 0.01,
              d / 2 + 0.02,
              book(i + 2),
              0.004,
            );
            lean.rotation.z = 0.25;
            x += 0.1;
          }
        }
      }
    },
    plant(g, w, d) {
      cy(g, 0.16, 0.12, 0.3, w / 2, 0.15, d / 2, F.terracotta);
      cy(g, 0.15, 0.15, 0.01, w / 2, 0.29, d / 2, F.soil);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const r = 0.09 + (i % 3) * 0.04;
        const l = sp(
          g,
          0.07,
          w / 2 + Math.cos(a) * r,
          0.5 + (i % 4) * 0.12,
          d / 2 + Math.sin(a) * r,
          i % 2 ? F.leaf : F.leaf2,
          1,
          3.2,
          0.5,
        );
        l.rotation.set(Math.cos(a) * 0.5, -a, Math.sin(a) * 0.5);
      }
    },
    lamp(g, w, d) {
      cy(g, 0.15, 0.16, 0.025, w / 2, 0.012, d / 2, F.black, 0, 0, 28);
      cy(g, 0.012, 0.012, 1.45, w / 2, 0.75, d / 2, F.chrome);
      cy(g, 0.17, 0.2, 0.3, w / 2, 1.5, d / 2, F.linen, 0, 0, 28, true);
    },
    counter(g, w, d) {
      rb(g, w, 0.08, d - 0.06, w / 2, 0.04, d / 2 - 0.03, F.black, 0.005);
      rb(g, w, 0.78, d - 0.04, w / 2, 0.47, d / 2 - 0.02, F.laminate, 0.01);
      const n = Math.max(2, Math.round(w / 0.6));
      for (let i = 0; i < n; i++) {
        const cw = w / n;
        rb(g, cw - 0.006, 0.74, 0.018, cw * (i + 0.5), 0.47, d - 0.04, F.white, 0.006);
        rb(g, 0.16, 0.012, 0.02, cw * (i + 0.5), 0.8, d - 0.02, F.steel, 0.005);
      }
      rb(g, w, 0.04, d, w / 2, 0.9, d / 2, F.stone, 0.008);
    },
    sink(g, w, d) {
      BUILD.counter?.(g, w, d);
      rb(g, 0.55, 0.012, 0.4, w / 2, 0.92, d / 2, F.steel, 0.02);
      rb(g, 0.5, 0.01, 0.35, w / 2, 0.915, d / 2, F.black, 0.02);
      cy(g, 0.015, 0.015, 0.28, w / 2, 1.06, 0.1, F.chrome);
      const s = tor(g, 0.08, 0.012, w / 2, 1.2, 0.18, F.chrome);
      s.rotation.set(0, Math.PI / 2, 0);
    },
    fridge(g, w, d) {
      rb(g, w, 1.86, d - 0.04, w / 2, 0.93, d / 2 - 0.02, F.appliance, 0.03);
      rb(g, w - 0.01, 0.006, 0.02, w / 2, 1.24, d - 0.03, F.steel, 0.002);
      rb(g, 0.025, 0.5, 0.04, w - 0.08, 1.52, d, F.chrome, 0.01);
      rb(g, 0.025, 0.6, 0.04, w - 0.08, 0.86, d, F.chrome, 0.01);
      rb(g, 0.12, 0.05, 0.005, w / 2, 1.6, d - 0.035, F.screen, 0.003);
    },
    coffee_machine(g, w, d) {
      rb(g, w, 0.33, d - 0.06, w / 2, 0.165, d / 2 - 0.03, F.black, 0.03);
      rb(g, w - 0.02, 0.2, 0.01, w / 2, 0.22, d - 0.055, F.steel, 0.006);
      rb(g, w - 0.08, 0.2, 0.1, w / 2, 0.39, 0.06, F.glass, 0.02);
      cy(g, 0.035, 0.035, 0.05, w / 2, 0.2, d - 0.03, F.chrome);
      rb(g, w - 0.04, 0.02, 0.12, w / 2, 0.02, d - 0.05, F.chrome, 0.006);
      cy(g, 0.03, 0.026, 0.06, w / 2, 0.06, d - 0.05, F.ceramic);
    },
    microwave(g, w, d) {
      rb(g, w, 0.29, d, w / 2, 0.145, d / 2, F.steel, 0.02);
      rb(g, w * 0.7, 0.23, 0.01, w * 0.37, 0.15, d + 0.003, F.blackGloss, 0.008);
      rb(g, w * 0.2, 0.23, 0.01, w * 0.86, 0.15, d + 0.003, F.black, 0.006);
    },
    dining(g, w, d) {
      rb(g, w, 0.04, d, w / 2, 0.735, d / 2, F.oak, 0.015);
      legs4(g, w, d, 0.715, 0.08, F.oak, 0.03, 0, 0, 0, 0.75);
    },
    bed(g, w, d) {
      rb(g, w, 0.22, d, w / 2, 0.2, d / 2, F.walnut, 0.02);
      legs4(g, w, d, 0.1, 0.06, F.walnut, 0.025);
      rb(g, w + 0.04, 1.0, 0.1, w / 2, 0.55, 0.05, F.headboard, 0.05);
      for (let i = 0; i < 4; i++)
        rb(g, 0.012, 0.8, 0.012, (w * (i + 1)) / 5, 0.6, 0.105, F.fabricDark, 0.004);
      rb(g, w - 0.06, 0.22, d - 0.1, w / 2, 0.42, d / 2 + 0.03, F.linen, 0.07);
      rb(g, w * 0.4, 0.13, 0.42, w * 0.28, 0.58, 0.32, F.pillow, 0.06);
      rb(g, w * 0.4, 0.13, 0.42, w * 0.72, 0.58, 0.32, F.pillow, 0.06);
      rb(g, w + 0.02, 0.1, d * 0.62, w / 2, 0.56, d * 0.66, F.duvet, 0.05);
      rb(g, w + 0.03, 0.04, 0.32, w / 2, 0.62, d * 0.38, F.duvet, 0.02);
      rb(g, w + 0.04, 0.03, 0.4, w / 2, 0.62, d * 0.86, F.fabricDark, 0.015);
    },
    wardrobe(g, w, d) {
      rb(g, w, 0.08, d - 0.04, w / 2, 0.04, d / 2, F.oakDark, 0.005);
      rb(g, w, 2.0, d, w / 2, 1.08, d / 2, F.oak, 0.015);
      for (const x of [w / 4, (3 * w) / 4])
        rb(g, w / 2 - 0.008, 1.94, 0.012, x, 1.08, d + 0.004, F.oak, 0.006);
      rb(g, 0.015, 0.45, 0.03, w / 2 - 0.05, 1.1, d + 0.02, F.brass, 0.006);
      rb(g, 0.015, 0.45, 0.03, w / 2 + 0.05, 1.1, d + 0.02, F.brass, 0.006);
    },
    table_lamp(g, w, d) {
      sp(g, 0.09, w / 2, 0.1, d / 2, F.ceramic, 1, 1.15, 1);
      cy(g, 0.008, 0.008, 0.12, w / 2, 0.24, d / 2, F.brass);
      cy(g, 0.1, 0.14, 0.17, w / 2, 0.36, d / 2, F.linen, 0, 0, 24, true);
    },
    desk(g, w, d) {
      rb(g, w, 0.03, d, w / 2, 0.725, d / 2, F.oak, 0.01);
      for (const x of [0.05, w - 0.05]) {
        rb(g, 0.04, 0.7, 0.04, x, 0.35, 0.06, F.black, 0.008);
        rb(g, 0.04, 0.7, 0.04, x, 0.35, d - 0.06, F.black, 0.008);
        rb(g, 0.04, 0.04, d - 0.08, x, 0.02, d / 2, F.black, 0.008);
      }
      rb(g, w - 0.1, 0.04, 0.02, w / 2, 0.68, 0.06, F.black, 0.006);
    },
    monitor(g, w, d) {
      rb(g, w, 0.37, 0.02, w / 2, 0.36, d / 2 + 0.03, F.black, 0.008);
      rb(g, w - 0.02, 0.35, 0.003, w / 2, 0.365, d / 2 + 0.041, F.screen, 0.002);
      rb(g, 0.06, 0.24, 0.03, w / 2, 0.15, d / 2 - 0.02, F.steel, 0.01);
      rb(g, 0.24, 0.012, 0.16, w / 2, 0.006, d / 2, F.steel, 0.006);
    },
    laptop(g, w, d) {
      rb(g, w, 0.012, d, w / 2, 0.006, d / 2, F.steel, 0.006);
      const lid = rb(g, w, 0.008, d, w / 2, 0.11, 0.02, F.steel, 0.004);
      lid.rotation.x = -1.28;
    },
    /** A small gadget (D249): a dark rounded body, a lens and a status light on its front. */
    device(g, w, d) {
      rb(g, w, 0.085, d, w / 2, 0.0425, d / 2, F.black, 0.025);
      rb(g, w - 0.03, 0.006, d - 0.03, w / 2, 0.088, d / 2, F.blackGloss, 0.003);
      cy(g, 0.022, 0.022, 0.012, w / 2, 0.045, d + 0.003, F.screen, Math.PI / 2, 0, 20);
      sp(g, 0.006, w - 0.035, 0.065, d + 0.002, F.green);
    },
    chair(g, w, d) {
      const cx = w / 2;
      const cz = d / 2;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const arm = rb(
          g,
          0.3,
          0.03,
          0.04,
          cx + Math.cos(a) * 0.15,
          0.06,
          cz + Math.sin(a) * 0.15,
          F.black,
          0.01,
        );
        arm.rotation.y = -a;
        sp(g, 0.028, cx + Math.cos(a) * 0.29, 0.028, cz + Math.sin(a) * 0.29, F.black);
      }
      cy(g, 0.025, 0.025, 0.36, cx, 0.26, cz, F.chrome);
      rb(g, 0.5, 0.08, 0.48, cx, 0.47, cz + 0.02, F.black, 0.04);
      const back = rb(g, 0.46, 0.55, 0.05, cx, 0.82, cz - 0.21, F.mesh, 0.05);
      back.rotation.x = -0.12;
      for (const x of [cx - 0.26, cx + 0.26]) {
        rb(g, 0.04, 0.2, 0.04, x, 0.6, cz, F.black, 0.01);
        rb(g, 0.06, 0.03, 0.26, x, 0.71, cz, F.black, 0.012);
      }
    },
    cabinet(g, w, d) {
      rb(g, w, 1.32, d, w / 2, 0.66, d / 2, F.steel, 0.012);
      for (let i = 0; i < 4; i++) {
        rb(g, w - 0.03, 0.3, 0.01, w / 2, 0.17 + i * 0.32, d + 0.004, F.steel, 0.006);
        rb(g, 0.12, 0.02, 0.025, w / 2, 0.25 + i * 0.32, d + 0.018, F.chrome, 0.006);
        rb(g, 0.07, 0.03, 0.003, w / 2, 0.21 + i * 0.32, d + 0.01, F.label, 0.001);
      }
    },
    box(g, w, d) {
      rb(g, w, 0.34, d, w / 2, 0.17, d / 2, F.carton, 0.01);
      rb(g, w + 0.004, 0.005, 0.07, w / 2, 0.34, d / 2, F.tape, 0.001);
      rb(g, 0.14, 0.035, 0.004, w / 2, 0.24, d + 0.002, F.tape, 0.002);
    },
    washer(g, w, d) {
      rb(g, w, 0.85, d, w / 2, 0.425, d / 2, F.appliance, 0.03);
      tor(g, 0.19, 0.025, w / 2, 0.42, d + 0.01, F.chrome);
      cy(g, 0.17, 0.17, 0.02, w / 2, 0.42, d + 0.005, F.glass, Math.PI / 2, 0, 28);
      rb(g, 0.2, 0.08, 0.01, 0.15, 0.76, d + 0.004, F.white, 0.008);
      cy(g, 0.035, 0.035, 0.03, w - 0.12, 0.76, d + 0.01, F.chrome, Math.PI / 2);
    },
    workbench(g, w, d) {
      rb(g, w, 0.06, d, w / 2, 0.89, d / 2, F.butcher, 0.01);
      for (const x of [0.06, w - 0.06])
        for (const z of [0.06, d - 0.06]) rb(g, 0.05, 0.86, 0.05, x, 0.43, z, F.steel, 0.006);
      rb(g, w - 0.12, 0.02, d - 0.12, w / 2, 0.22, d / 2, F.steel, 0.004);
    },
    tool_wall(g, w) {
      rb(g, w, 0.9, 0.02, w / 2, 1.5, 0.01, F.pegboard, 0.004);
      rb(g, 0.03, 0.3, 0.03, 0.15, 1.5, 0.05, F.butcher, 0.008);
      rb(g, 0.12, 0.04, 0.04, 0.15, 1.66, 0.05, F.steel, 0.008);
      rb(g, 0.025, 0.28, 0.01, 0.45, 1.5, 0.04, F.chrome, 0.004);
      rb(g, 0.16, 0.36, 0.006, 0.75, 1.42, 0.035, F.steel, 0.002);
      rb(g, 0.1, 0.1, 0.03, 0.75, 1.64, 0.04, F.red, 0.02);
      const pens = [F.red, F.green, F.black];
      for (let i = 0; i < 5; i++) {
        cy(g, 0.012, 0.012, 0.12, 0.95 + i * 0.05, 1.68, 0.05, pens[i % 3] ?? F.red);
        cy(g, 0.004, 0.004, 0.12, 0.95 + i * 0.05, 1.56, 0.05, F.chrome);
      }
      const a = rb(g, 0.02, 0.22, 0.015, 1.36, 1.5, 0.04, F.red, 0.006);
      a.rotation.z = 0.12;
      const b = rb(g, 0.02, 0.22, 0.015, 1.4, 1.5, 0.04, F.red, 0.006);
      b.rotation.z = -0.12;
    },
    car(g, w, d) {
      rb(g, w, 0.55, d, w / 2, 0.5, d / 2, F.carPaint, 0.18);
      rb(g, w - 0.14, 0.48, d * 0.46, w / 2, 0.92, d * 0.5, F.carPaint, 0.16);
      rb(g, w - 0.12, 0.4, d * 0.44, w / 2, 0.92, d * 0.5, F.glass, 0.14);
      for (const [x, z] of [
        [0.04, 0.78],
        [w - 0.04, 0.78],
        [0.04, d - 0.82],
        [w - 0.04, d - 0.82],
      ] as const) {
        cy(g, 0.32, 0.32, 0.22, x, 0.32, z, F.rubber, 0, Math.PI / 2, 24);
        cy(g, 0.19, 0.19, 0.225, x, 0.32, z, F.steel, 0, Math.PI / 2, 16);
      }
      for (const x of [0.32, w - 0.32]) {
        rb(g, 0.34, 0.08, 0.03, x, 0.62, d + 0.005, F.headlight, 0.03);
        rb(g, 0.36, 0.07, 0.03, x, 0.66, -0.005, F.redLight, 0.03);
      }
      rb(g, 0.7, 0.14, 0.02, w / 2, 0.44, d + 0.008, F.black, 0.02);
    },
    bike(g, w, d) {
      for (const z of [0.36, d - 0.36]) {
        tor(g, 0.34, 0.022, w / 2, 0.36, z, F.rubber, Math.PI / 2);
        tor(g, 0.3, 0.008, w / 2, 0.36, z, F.chrome, Math.PI / 2);
      }
      const tube = (z1: number, y1: number, z2: number, y2: number, m: Mat = F.red, r = 0.018) =>
        cy(
          g,
          r,
          r,
          Math.hypot(z2 - z1, y2 - y1),
          w / 2,
          (y1 + y2) / 2,
          (z1 + z2) / 2,
          m,
          Math.atan2(z2 - z1, y2 - y1),
          0,
          8,
        );
      tube(0.36, 0.36, 0.78, 0.4);
      tube(0.78, 0.4, 0.66, 0.8);
      tube(0.66, 0.8, d - 0.48, 0.78);
      tube(0.78, 0.4, d - 0.5, 0.74);
      tube(d - 0.36, 0.36, d - 0.5, 0.86, F.chrome, 0.015);
      rb(g, 0.11, 0.04, 0.24, w / 2, 0.86, 0.62, F.black, 0.02);
      rb(g, 0.5, 0.025, 0.025, w / 2, 0.92, d - 0.52, F.black, 0.01);
    },
    water_tank(g, w, d) {
      const cx = w / 2;
      const cz = d / 2;
      for (const [x, z] of [
        [0.15, 0.15],
        [w - 0.15, 0.15],
        [0.15, d - 0.15],
        [w - 0.15, d - 0.15],
      ] as const)
        rb(g, 0.05, 0.35, 0.05, x, 0.175, z, F.steel, 0.006);
      rb(g, w - 0.1, 0.04, d - 0.1, cx, 0.37, cz, F.steel, 0.006);
      cy(g, 0.5, 0.5, 1.0, cx, 0.89, cz, F.tank, 0, 0, 32);
      sp(g, 0.5, cx, 1.39, cz, F.tank, 1, 0.22, 1);
      for (const y of [0.55, 0.8, 1.05, 1.28]) {
        const ring = tor(g, 0.505, 0.012, cx, y, cz, F.tank, 0);
        ring.rotation.x = Math.PI / 2;
      }
      cy(g, 0.18, 0.18, 0.08, cx, 1.5, cz, F.tank, 0, 0, 24);
      cy(g, 0.025, 0.025, 0.5, cx + 0.42, 0.45, cz, F.steel);
      cy(g, 0.025, 0.025, 0.4, cx + 0.3, 0.6, cz, F.steel, 0, Math.PI / 2);
    },
    dish(g, w, d) {
      const cx = w / 2;
      const cz = d / 2;
      rb(g, 0.3, 0.06, 0.3, cx, 0.03, cz, F.steel, 0.01);
      cy(g, 0.025, 0.025, 0.9, cx, 0.48, cz, F.steel);
      const bowl = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 24, 10, 0, Math.PI * 2, 0, 0.62),
        F.white,
      );
      bowl.scale.set(1, 0.45, 1);
      bowl.rotation.x = Math.PI / 2 + 0.55;
      bowl.position.set(cx, 1.0, cz - 0.05);
      g.add(bowl);
      const arm = cy(g, 0.012, 0.012, 0.5, cx, 0.95, cz + 0.2, F.steel);
      arm.rotation.x = -0.9;
      rb(g, 0.06, 0.06, 0.09, cx, 0.82, cz + 0.4, F.black, 0.01);
    },
    stairs(g, w, d) {
      const n = 10;
      const rise = 0.17;
      const run = (d - 0.1) / n;
      const tilt = Math.atan2(n * rise, n * run);
      const len = Math.hypot(n * rise, n * run);
      for (let i = 0; i < n; i++) {
        rb(
          g,
          w - 0.1,
          0.04,
          run + 0.02,
          w / 2,
          rise * (i + 1) - 0.02,
          d - run * (i + 0.5),
          F.oak,
          0.008,
        );
        rb(g, w - 0.1, rise, 0.015, w / 2, rise * (i + 0.5), d - run * i, F.white, 0);
      }
      slab(g, len, 0.24, 0.05, 0.03, (n * rise) / 2 - 0.05, d - (n * run) / 2, F.white, tilt);
      slab(g, len, 0.24, 0.05, w - 0.03, (n * rise) / 2 - 0.05, d - (n * run) / 2, F.white, tilt);
      slab(g, len, 0.04, 0.04, w - 0.02, (n * rise) / 2 + 0.9, d - (n * run) / 2, F.walnut, tilt);
      for (let i = 0; i <= n; i += 2)
        cy(g, 0.01, 0.01, 0.9, w - 0.02, rise * i + 0.45, d - run * i, F.steel, 0, 0, 6);
    },
    stairwell(g, w, d) {
      rb(g, w, 0.02, d, w / 2, 0.006, d / 2, F.void, 0);
      for (let i = 1; i <= 3; i++)
        rb(g, w - 0.1, 0.04, 0.27, w / 2, 0.03, 0.2 + i * 0.28, F.oak, 0.006);
      for (const x of [0, w]) {
        rb(g, 0.012, 0.9, d, x, 0.47, d / 2, F.glass, 0);
        rb(g, 0.04, 0.04, d, x, 0.94, d / 2, F.walnut, 0.01);
      }
      rb(g, w, 0.9, 0.012, w / 2, 0.47, d, F.glass, 0);
      rb(g, w, 0.04, 0.04, w / 2, 0.94, d, F.walnut, 0.01);
    },
    zone(g, w, d) {
      rb(g, w, 0.02, d, w / 2, 0.01, d / 2, F.fabric, 0.004);
    },
  };
  return BUILD;
}

/** A plain block for a model with no drawing of its own. */
export function block(g: THREE.Group, key: MapModelKey, F: Materials): void {
  const m = mapModel(key);
  const h = m.h ?? 0.6;
  rb(
    g,
    m.w,
    h,
    m.d,
    m.w / 2,
    h / 2,
    m.d / 2,
    m.kind === 'storage' ? F.oak : m.kind === 'furniture' ? F.fabric : F.white,
    Math.min(0.05, h / 4),
  );
}
