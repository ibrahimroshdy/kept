/**
 * The location map's 3D engine (1.x, D237): the approved spike's imperative three.js scene,
 * ported to a class the map's React component owns. React draws the controls, the card and the
 * lists; this draws the scene, its labels and the hover tip, and handles the pointer.
 *
 * - An isometric orthographic camera (or a plan view from above), rendered only when something
 *   changes, so a map left open costs nothing.
 * - One floor in view at a time, or all of them stacked (no shadows then). A floor's rooms and
 *   things are built the first time it is shown, and its real models load then.
 * - Everything on a floor is drawn as one BatchedMesh per material; the selected or hovered
 *   thing (and whatever stands on it) shows its own body instead, so it can glow or move. Focus
 *   on a room fades everything else through the batches' faded copies.
 * - Arrange: drag things (onto counters, desks, shelves and boxes), drag a room's amber corner
 *   to resize it, draw a room on empty ground, turn a thing. Changes go into the plan; the
 *   React side saves the session.
 */
import { canStandOn, mapModel } from '@kept/shared';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MapAttentionKind } from '@/api/map/types';
import { declutter, LABEL_PRIORITY, type Rect } from '../declutter';
import {
  childrenOn,
  clampIn,
  fp,
  hostAt,
  type Item,
  moveBy,
  overlapsRoom,
  type Plan,
  type Room,
  rehome,
  roomAt,
  snap,
  standingOn,
  turn,
} from '../layout';
import {
  block,
  cy,
  drawnModels,
  floorMaterial,
  floorMats,
  type Materials,
  materials,
  rb,
  rgeo,
} from './draw';
import { hasGlb, loadModel, modelStats, readyModel, wasRequested } from './models';

export type Sel = { type: 'room' | 'item'; id: string };
export type Tool = 'move' | 'room';
export type Quality = 'detailed' | 'simple';

export type EngineState = {
  levelKey: string;
  allFloors: boolean;
  focused: string | null;
  selected: Sel | null;
  planView: boolean;
  arranging: boolean;
  tool: Tool;
};

export type EngineStats = {
  fps: number | null;
  worst: number | null;
  calls: number;
  triangles: number;
  models: number;
  bytes: number;
  loading: number;
  failed: number;
  firstDraw: number | null;
};

/** What the engine asks the page for: words, counts and flags. */
export type EngineInfo = {
  countIn: (it: Item) => number | null;
  flags: (id: string) => MapAttentionKind[];
  /** The first few things inside, for the plan view's labels. */
  preview: (it: Item) => { name: string; quantity: number }[];
  /** How many things are directly inside (for "+N more"). */
  insideCount: (it: Item) => number;
  text: {
    onIt: (name: string) => string;
    more: (n: number) => string;
    inside: (n: number) => string;
    openFloor: string;
    changeFloor: string;
  };
};

export type EngineEvents = {
  /** The state changed through the map itself (a tap, a drill, a floor). */
  onState: (s: EngineState) => void;
  /** The plan changed while arranging. */
  onChange: () => void;
  /** A room was drawn on empty ground (metres, on this floor). */
  onDrawRoom: (rect: { x: number; z: number; w: number; d: number }, levelKey: string) => void;
  /** The arrange hint to show (`overlap` while a drawn room would overlap). */
  onHint: (hint: Tool | 'overlap') => void;
  onStats?: (s: EngineStats) => void;
};

type Pick = { type: 'room' | 'item' | 'handle'; id: string };
type Slot = { bm: THREE.BatchedMesh; id: number; fade: boolean };
type Batches = { list: THREE.BatchedMesh[]; slots: Map<string, Slot[]> };

const GAP = 5.4;
const ELEV = Math.atan(1 / Math.SQRT2);
const T0 = performance.now();

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const dark = () => {
  const theme = document.documentElement.dataset.theme;
  return (
    theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  );
};
const same = (a: Sel | null, b: Sel | null) => !!a && !!b && a.type === b.type && a.id === b.id;
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The pin colours: Kept's danger, info and warn, as the chips and dots use them. */
const PIN_VAR: Record<MapAttentionKind, string> = {
  low: '--danger',
  lent: '--info',
  due: '--warn',
};

export class MapEngine {
  plan: Plan;
  private readonly info: EngineInfo;
  private readonly events: EngineEvents;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly labelsEl: HTMLElement;
  private readonly tip: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xb9ad98, 0.6);
  private readonly sun = new THREE.DirectionalLight(0xfff4e6, 2.1);
  private readonly groundMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  private readonly wallMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  private readonly skirtMat = new THREE.MeshStandardMaterial({ roughness: 0.5 });
  private readonly gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 });
  private readonly handleMat = new THREE.MeshStandardMaterial({ emissiveIntensity: 0.35 });
  private readonly pinMats = new Map<MapAttentionKind, THREE.MeshStandardMaterial>();
  private readonly F: Materials;
  private readonly BUILD: ReturnType<typeof drawnModels>;
  private readonly world = new THREE.Group();

  private readonly levelGroups = new Map<string, THREE.Group>();
  private readonly roomGroups = new Map<string, THREE.Group>();
  private readonly itemGroups = new Map<string, THREE.Group>();
  private readonly handles = new Map<string, THREE.Mesh>();
  private pinMeshes: THREE.Group[] = [];
  private readonly drawn = new Map<string, THREE.Group>();
  private readonly floorBatches = new Map<string, Batches>();
  private readonly flat = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  private readonly built = new Set<string>();
  private readonly glowMats = new Map<THREE.Material, THREE.Material>();
  private readonly hoverMats = new Map<THREE.Material, THREE.Material>();
  private readonly fadeMats = new Map<THREE.Material, THREE.Material>();

  private s: EngineState;
  private hovered: Sel | null = null;
  private quality: Quality;
  private shadows = true;
  private shown: Record<MapAttentionKind, boolean> = { low: true, lent: true, due: true };
  private readonly view = {
    target: new THREE.Vector3(8, 0, 5),
    az: Math.PI / 4,
    zoom: 1,
    span: 24,
  };

  private pending = false;
  private firstDraw: number | null = null;
  private frames: number[] = [];
  private worst = 0;
  private busy = 0;
  private last = 0;
  private tw: {
    from: { target: THREE.Vector3; zoom: number; az: number };
    to: { target?: THREE.Vector3; zoom?: number; az?: number };
    start: number;
    dur: number;
  } | null = null;

  private readonly pool: (HTMLDivElement & { _html?: string })[] = [];
  private hoverAt: [number, number] | null = null;
  private hoverPending = false;
  private readonly pts = new Map<number, { x: number; y: number }>();
  private gesture: {
    start: number;
    moved: number;
    sx: number;
    sy: number;
    prev: ReturnType<MapEngine['snapshot']>;
  } | null = null;
  private lastTap = { t: 0, key: '' };
  private drag:
    | { type: 'item'; id: string; off: THREE.Vector3 }
    | { type: 'resize'; id: string }
    | { type: 'draw'; from: THREE.Vector3; rect?: { x: number; z: number; w: number; d: number } }
    | null = null;
  private preview: THREE.Mesh | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly cleanup: (() => void)[] = [];
  private disposed = false;

  constructor(opts: {
    stage: HTMLElement;
    canvas: HTMLCanvasElement;
    labels: HTMLElement;
    tip: HTMLElement;
    plan: Plan;
    info: EngineInfo;
    events: EngineEvents;
    quality: Quality;
    levelKey: string;
  }) {
    this.stage = opts.stage;
    this.canvas = opts.canvas;
    this.labelsEl = opts.labels;
    this.tip = opts.tip;
    this.plan = opts.plan;
    this.info = opts.info;
    this.events = opts.events;
    this.quality = opts.quality;
    this.s = {
      levelKey: opts.levelKey,
      allFloors: false,
      focused: null,
      selected: null,
      planView: false,
      arranging: false,
      tool: 'move',
    };

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.55;
    this.F = materials();
    this.BUILD = drawnModels(this.F);

    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
    this.scene.add(this.hemi, sun, sun.target);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.21;
    ground.receiveShadow = true;
    this.scene.add(ground, this.world);

    this.listen();
    this.rebuild();
    this.resize();
    this.fitLevel(false);
  }

  // ---- State ---------------------------------------------------------------------------------

  get state(): EngineState {
    return { ...this.s };
  }

  private emit() {
    this.events.onState(this.state);
  }

  private levelIndex = (key: string) => this.plan.levels.findIndex((l) => l.key === key);
  private roomOf = (id: string | null | undefined) => this.plan.rooms.find((r) => r.id === id);
  private itemOf = (id: string | null | undefined) => this.plan.items.find((i) => i.id === id);
  private itemLevel = (it: Item | undefined) => this.roomOf(it?.roomId)?.levelKey;
  private levelY = (key: string) => (this.s.allFloors ? this.levelIndex(key) * GAP : 0);
  private outdoors = (r: Room) => r.kind !== 'room';
  private roomIdOf = (sel: Pick | Sel | null | undefined) =>
    sel?.type === 'room' ? sel.id : sel?.type === 'item' ? this.itemOf(sel.id)?.roomId : undefined;
  private baseY(it: Item): number {
    const seen = new Set<string>();
    let y = 0;
    let host = it.on ? this.itemOf(it.on) : undefined;
    while (host && !seen.has(host.id)) {
      seen.add(host.id);
      y += mapModel(host.model).top ?? 0;
      host = host.on ? this.itemOf(host.on) : undefined;
    }
    return y;
  }

  // ---- Lifecycle -----------------------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    for (const off of this.cleanup) off();
    for (const b of this.floorBatches.values()) for (const bm of b.list) bm.dispose();
    this.renderer.dispose();
    this.labelsEl.replaceChildren();
  }

  /** A new plan from the server (after a save, an undo or a reload): rebuild everything. */
  setPlan(plan: Plan): void {
    this.plan = plan;
    if (!plan.levels.some((l) => l.key === this.s.levelKey)) {
      this.s.levelKey = plan.levels[0]?.key ?? this.s.levelKey;
    }
    if (this.s.selected && !this.groupOfId(this.s.selected)) this.s.selected = null;
    if (this.s.focused && !this.roomOf(this.s.focused)) this.s.focused = null;
    this.rebuild();
    this.emit();
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.rebuild();
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.renderer.shadowMap.enabled = on && !this.s.planView;
    this.sun.castShadow = on && !this.s.allFloors;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
    });
    this.worst = 0;
    this.request();
  }

  setPins(shown: Record<MapAttentionKind, boolean>): void {
    this.shown = { ...shown };
    this.applyPins();
  }

  /** The theme changed: walls, floors, ground and pins follow. */
  applyColours = (): void => {
    const d = dark();
    this.wallMat.color.setHex(d ? 0x34312c : 0xede9e0);
    this.skirtMat.color.setHex(d ? 0x2a2824 : 0xffffff);
    for (const m of floorMats.values()) m.color.setHex(d ? 0x8a8378 : 0xffffff);
    this.groundMat.color.set(css('--paper') || (d ? '#151412' : '#F2F1EC'));
    this.scene.background = new THREE.Color(css('--paper') || (d ? '#151412' : '#F2F1EC'));
    this.gridMat.color.setHex(d ? 0x8e887c : 0x8c7f66);
    const amber = css('--amber') || '#F0B03A';
    this.handleMat.color.set(amber);
    this.handleMat.emissive.set(amber);
    this.hemi.groundColor.setHex(d ? 0x3a352c : 0xb9ad98);
    for (const k of ['low', 'lent', 'due'] as const)
      this.pinMat(k).color.set(css(PIN_VAR[k]) || '#888');
    this.request();
  };

  private pinMat(k: MapAttentionKind) {
    let m = this.pinMats.get(k);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ roughness: 0.4 });
      this.pinMats.set(k, m);
    }
    return m;
  }

  // ---- Building ------------------------------------------------------------------------------

  /** One mesh per material: dozens of drawn parts become a handful of draw calls. */
  private mergeByMaterial(group: THREE.Object3D, pick: Pick | null): THREE.Group {
    group.updateMatrixWorld(true);
    const inv = group.matrixWorld.clone().invert();
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    group.traverse((o) => {
      if (!isMesh(o)) return;
      let g = o.geometry
        .clone()
        .applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      if (g.index) g = g.toNonIndexed();
      for (const k of Object.keys(g.attributes))
        if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      const m = o.material as THREE.Material;
      byMat.set(m, [...(byMat.get(m) ?? []), g]);
    });
    const out = new THREE.Group();
    out.position.copy(group.position);
    for (const [m, list] of byMat) {
      const merged = mergeGeometries(list);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, m);
      mesh.castShadow = !m.transparent;
      mesh.receiveShadow = true;
      mesh.userData.pick = pick;
      out.add(mesh);
    }
    return out;
  }

  private buildRoom(r: Room): void {
    this.roomGroups.get(r.id)?.removeFromParent();
    const F = this.F;
    const g = new THREE.Group();
    g.position.set(r.x, 0, r.z);
    g.userData = { type: 'room', id: r.id };
    const pick: Pick = { type: 'room', id: r.id };
    const floor = new THREE.Mesh(rgeo(r.w, 0.2, r.d, 0.02), floorMaterial(r));
    floor.position.set(r.w / 2, -0.1, r.d / 2);
    floor.receiveShadow = true;
    floor.userData.pick = pick;
    g.add(floor);
    const edge = new THREE.Group();
    if (!this.outdoors(r)) {
      const wall = (w: number, h: number, d: number, x: number, z: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.wallMat);
        m.position.set(x, h / 2, z);
        edge.add(m);
      };
      wall(r.w, 1.3, 0.1, r.w / 2, 0.05);
      wall(0.1, 1.3, r.d, 0.05, r.d / 2);
      const sk = (w: number, d: number, x: number, z: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), this.skirtMat);
        m.position.set(x, 0.04, z);
        edge.add(m);
      };
      sk(r.w - 0.1, 0.02, r.w / 2 + 0.05, 0.11);
      sk(0.02, r.d - 0.1, 0.11, r.d / 2 + 0.05);
    } else if (r.kind === 'balcony') {
      for (const [x0, z0, x1, z1] of [
        [0, r.d, r.w, r.d],
        [0, 0, 0, r.d],
        [r.w, 0, r.w, r.d],
      ] as const) {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(1, Math.round(len / 0.6));
        for (let i = 0; i <= n; i++)
          cy(
            edge,
            0.018,
            0.018,
            1.0,
            x0 + ((x1 - x0) * i) / n,
            0.5,
            z0 + ((z1 - z0) * i) / n,
            F.steel,
            0,
            0,
            8,
          );
        if (x0 !== x1) {
          rb(edge, len, 0.05, 0.06, (x0 + x1) / 2, 1.02, z0, F.walnut, 0.01);
          rb(edge, len, 0.8, 0.012, (x0 + x1) / 2, 0.5, z0, F.glass, 0);
        } else {
          rb(edge, 0.06, 0.05, len, x0, 1.02, (z0 + z1) / 2, F.walnut, 0.01);
          rb(edge, 0.012, 0.8, len, x0, 0.5, (z0 + z1) / 2, F.glass, 0);
        }
      }
    } else if (r.kind === 'terrace') {
      // The two far sides stand full height; the near two are cut low so the roof stays visible,
      // like the rooms' missing front walls.
      const t = 0.16;
      for (const [w, d, x, z, h] of [
        [r.w, t, r.w / 2, t / 2, 0.75],
        [t, r.d, t / 2, r.d / 2, 0.75],
        [r.w, t, r.w / 2, r.d - t / 2, 0.3],
        [t, r.d, r.w - t / 2, r.d / 2, 0.3],
      ] as const) {
        rb(edge, w, h, d, x, h / 2, z, F.parapet, 0);
        rb(edge, w + 0.04, 0.05, d + 0.04, x, h + 0.025, z, F.stone, 0.01);
      }
    }
    if (edge.children.length) g.add(this.mergeByMaterial(edge, pick));
    const pts: number[] = [];
    for (let x = 0; x <= r.w; x++) pts.push(x, 0.004, 0, x, 0.004, r.d);
    for (let z = 0; z <= r.d; z++) pts.push(0, 0.004, z, r.w, 0.004, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(geo, this.gridMat);
    grid.userData.grid = true;
    grid.visible = this.s.arranging || this.s.planView;
    g.add(grid);
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), this.handleMat);
    h.position.set(r.w, 0.22, r.d);
    h.visible = this.s.arranging;
    h.userData.pick = { type: 'handle', id: r.id } satisfies Pick;
    g.add(h);
    this.handles.set(r.id, h);
    this.levelGroups.get(r.levelKey)?.add(g);
    this.roomGroups.set(r.id, g);
  }

  private buildItem(it: Item): void {
    const old = this.itemGroups.get(it.id);
    if (old) {
      old.removeFromParent();
      this.pinMeshes = this.pinMeshes.filter((p) => p.userData.item !== it.id);
    }
    const m = mapModel(it.model);
    const r = this.roomOf(it.roomId);
    if (!r) return;
    const pick: Pick = { type: 'item', id: it.id };
    const wrap = new THREE.Group();
    wrap.userData = { type: 'item', id: it.id };
    const parts = new THREE.Group();
    parts.position.set(-m.w / 2, 0, -m.d / 2);
    let body: THREE.Group;
    const real = this.quality === 'detailed' ? readyModel(it.model) : undefined;
    if (real) {
      body = new THREE.Group();
      body.position.copy(parts.position);
      const c = real.clone(true);
      c.position.set(m.w / 2, 0, m.d / 2);
      body.add(c);
      c.traverse((o) => {
        if (isMesh(o)) o.userData.pick = pick;
      });
    } else {
      let d = this.drawn.get(it.model);
      if (!d) {
        const key = m.glb ? m.simple : it.model;
        const build = key ? this.BUILD[key] : undefined;
        if (build) build(parts, m.w, m.d);
        else block(parts, it.model, this.F);
        d = this.mergeByMaterial(parts, null);
        this.drawn.set(it.model, d);
      }
      body = d.clone(true);
      body.traverse((o) => {
        if (isMesh(o)) o.userData = { pick };
      });
    }
    body.updateMatrixWorld(true);
    const top = new THREE.Box3().setFromObject(body).max.y;
    wrap.userData.top = top;
    wrap.userData.body = body;
    wrap.add(body);
    const flags = this.info.flags(it.id);
    flags.forEach((kind, i) => {
      const pin = new THREE.Group();
      const mt = this.pinMat(kind);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), mt);
      head.position.y = 0.36;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.28, 8), mt);
      stem.position.y = 0.14;
      pin.add(head, stem);
      pin.position.set(i * 0.26 - (flags.length - 1) * 0.13, top + 0.04, 0);
      pin.userData = { pinKind: kind, item: it.id };
      wrap.add(pin);
      this.pinMeshes.push(pin);
    });
    this.levelGroups.get(r.levelKey)?.add(wrap);
    this.itemGroups.set(it.id, wrap);
    this.placeItem(it);
    this.paint({ type: 'item', id: it.id });
    this.applyPin(it);
  }

  private placeItem(it: Item | undefined): void {
    if (!it) return;
    const g = this.itemGroups.get(it.id);
    const r = this.roomOf(it.roomId);
    if (!g || !r) return;
    const f = fp(it);
    g.position.set(r.x + it.x + f.w / 2, this.baseY(it), r.z + it.z + f.d / 2);
    g.rotation.y = -(it.rot * Math.PI) / 180;
  }

  private bodyOf = (it: Item) =>
    this.itemGroups.get(it.id)?.userData.body as THREE.Group | undefined;
  private topOf = (it: Item) =>
    (this.itemGroups.get(it.id)?.userData.top as number | undefined) ?? 1;

  // ---- Floor batches: everything on a floor drawn as one batch per material ------------------
  // Each part keeps its own slot, so selecting, hovering or focusing only flips visibility. A
  // selected or hovered thing (and whatever stands on it) shows its own body instead.

  /** Plain float position/normal/uv, so every part of a material fits one batch. */
  private flatGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
    const hit = this.flat.get(g);
    if (hit) return hit;
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const a = g.getAttribute(name);
      if (!a) continue;
      const arr = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++)
        for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.getComponent(i, k);
      out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
    }
    const pos = out.getAttribute('position');
    if (!out.getAttribute('uv') && pos)
      out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    if (g.index) out.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.index.array), 1));
    this.flat.set(g, out);
    return out;
  }

  private batchFloor(lvl: string): void {
    const old = this.floorBatches.get(lvl);
    if (old) {
      for (const bm of old.list) {
        bm.removeFromParent();
        bm.dispose();
      }
    }
    this.floorBatches.delete(lvl);
    const lg = this.levelGroups.get(lvl);
    if (!lg) return;
    lg.updateMatrixWorld(true);
    const invL = lg.matrixWorld.clone().invert();
    const byMat = new Map<
      string,
      {
        mat: THREE.Material;
        geos: Set<THREE.BufferGeometry>;
        parts: { it: Item; geo: THREE.BufferGeometry; m: THREE.Matrix4 }[];
      }
    >();
    for (const it of this.plan.items) {
      if (this.itemLevel(it) !== lvl || !this.itemGroups.has(it.id)) continue;
      this.bodyOf(it)?.traverse((o) => {
        if (!isMesh(o)) return;
        const mat = this.baseOf(o);
        const key = `${mat.uuid}|${o.geometry.index ? 'i' : 'n'}`;
        let e = byMat.get(key);
        if (!e) {
          e = { mat, geos: new Set(), parts: [] };
          byMat.set(key, e);
        }
        e.geos.add(o.geometry);
        e.parts.push({
          it,
          geo: o.geometry,
          m: new THREE.Matrix4().multiplyMatrices(invL, o.matrixWorld),
        });
      });
    }
    const list: THREE.BatchedMesh[] = [];
    const slots = new Map<string, Slot[]>();
    for (const e of byMat.values()) {
      let vtx = 0;
      let idx = 0;
      for (const g of e.geos) {
        vtx += g.attributes.position?.count ?? 0;
        idx += g.index ? g.index.count : 0;
      }
      for (const isFade of [false, true]) {
        const bm = new THREE.BatchedMesh(
          e.parts.length,
          vtx,
          idx || vtx,
          isFade ? this.fade(e.mat) : e.mat,
        );
        const gid = new Map<THREE.BufferGeometry, number>();
        for (const g of e.geos) gid.set(g, bm.addGeometry(this.flatGeo(g)));
        for (const p of e.parts) {
          const id = bm.addInstance(gid.get(p.geo) ?? 0);
          bm.setMatrixAt(id, p.m);
          const list2 = slots.get(p.it.id) ?? [];
          list2.push({ bm, id, fade: isFade });
          slots.set(p.it.id, list2);
        }
        bm.castShadow = !isFade && !e.mat.transparent;
        bm.receiveShadow = true;
        bm.sortObjects = !!(e.mat.transparent || isFade);
        lg.add(bm);
        list.push(bm);
      }
    }
    this.floorBatches.set(lvl, { list, slots });
    this.showBatches();
  }

  private soloIds(): Set<string> {
    const ids = new Set<string>();
    for (const sel of [this.s.selected, this.hovered]) {
      if (sel?.type !== 'item') continue;
      ids.add(sel.id);
      for (const d of standingOn(this.plan.items, sel.id)) ids.add(d);
    }
    return ids;
  }

  /** Which copy shows: the thing's own body (solo), its faded batch slot, or its normal one. */
  private showBatches(): void {
    const solo = this.soloIds();
    for (const { slots } of this.floorBatches.values()) {
      for (const [id, list] of slots) {
        const it = this.itemOf(id);
        if (!it) continue;
        const own = solo.has(id);
        const faded = !!this.s.focused && it.roomId !== this.s.focused;
        for (const s of list) s.bm.setVisibleAt(s.id, !own && s.fade === faded);
        const body = this.bodyOf(it);
        if (body) body.visible = own;
      }
    }
    this.request();
  }

  private buildFloor(key: string): void {
    if (this.built.has(key)) return;
    this.built.add(key);
    for (const it of this.plan.items) if (this.itemLevel(it) === key) this.buildItem(it);
    this.batchFloor(key);
  }

  private rebuild(): void {
    this.world.clear();
    this.levelGroups.clear();
    this.roomGroups.clear();
    this.itemGroups.clear();
    this.handles.clear();
    for (const b of this.floorBatches.values()) for (const bm of b.list) bm.dispose();
    this.floorBatches.clear();
    this.pinMeshes = [];
    for (const l of this.plan.levels) {
      const g = new THREE.Group();
      this.world.add(g);
      this.levelGroups.set(l.key, g);
    }
    for (const r of this.plan.rooms) this.buildRoom(r);
    this.built.clear();
    this.applyLevels();
    this.applyColours();
    this.applyFocus();
  }

  // ---- Real models: fetched only for the floors in view ----------------------------------------

  private ensureModels(): void {
    if (this.quality !== 'detailed') return;
    const inView = new Set(
      this.s.allFloors ? this.plan.levels.map((l) => l.key) : [this.s.levelKey],
    );
    for (const it of this.plan.items) {
      if (!hasGlb(it.model) || wasRequested(it.model)) continue;
      const lvl = this.itemLevel(it);
      if (!lvl || !inView.has(lvl)) continue;
      const glb = mapModel(it.model).glb;
      void loadModel(it.model).then(() => {
        if (this.disposed || !readyModel(it.model)) return;
        const touched = new Set<string>();
        for (const t of this.plan.items) {
          const tl = this.itemLevel(t);
          if (mapModel(t.model).glb !== glb || !tl || !this.built.has(tl)) continue;
          this.buildItem(t);
          for (const c of standingOn(this.plan.items, t.id)) this.placeItem(this.itemOf(c));
          touched.add(tl);
        }
        for (const lvl2 of touched) this.batchFloor(lvl2);
        this.request();
      });
      this.request();
    }
  }

  // ---- Floors --------------------------------------------------------------------------------

  private applyLevels(): void {
    for (const l of this.plan.levels) {
      const g = this.levelGroups.get(l.key);
      if (!g) continue;
      g.visible = this.s.allFloors || l.key === this.s.levelKey;
      g.position.y = this.levelY(l.key);
      if (g.visible) this.buildFloor(l.key);
    }
    // Shadows across stacked floors only confuse, and double the work.
    this.sun.castShadow = this.shadows && !this.s.allFloors;
    this.ensureModels();
    this.request();
  }

  setLevel(key: string, fit = true): void {
    if (this.levelIndex(key) < 0) return;
    const changed = this.s.allFloors || key !== this.s.levelKey;
    this.s.allFloors = false;
    this.s.levelKey = key;
    this.s.focused = null;
    const sel = this.s.selected;
    if (sel) {
      const lvl =
        sel.type === 'item' ? this.itemLevel(this.itemOf(sel.id)) : this.roomOf(sel.id)?.levelKey;
      if (lvl !== key) this.select(null, false);
    }
    this.applyLevels();
    this.applyFocus();
    if (fit && changed) this.fitLevel(false);
    this.emit();
  }

  showAll(): void {
    if (this.s.arranging) this.setArranging(false);
    if (this.s.planView) this.setPlanView(false, false);
    this.select(null, false);
    this.s.allFloors = true;
    this.s.focused = null;
    this.applyLevels();
    this.applyFocus();
    this.fitAll(false);
    this.emit();
  }

  // ---- Camera --------------------------------------------------------------------------------

  private placeCamera(): void {
    const { view, camera, sun } = this;
    const r = 160;
    if (this.s.planView) {
      camera.up.set(0, 0, -1);
      camera.position.set(view.target.x, view.target.y + 150, view.target.z + 0.001);
    } else {
      camera.up.set(0, 1, 0);
      camera.position.set(
        view.target.x + r * Math.cos(ELEV) * Math.sin(view.az),
        view.target.y + r * Math.sin(ELEV),
        view.target.z + r * Math.cos(ELEV) * Math.cos(view.az),
      );
    }
    camera.lookAt(view.target);
    const w = this.stage.clientWidth || 1;
    const h = this.stage.clientHeight || 1;
    const half = view.span / 2 / view.zoom;
    const aspect = w / h;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
    sun.position.set(view.target.x + 16, view.target.y + 40, view.target.z + 24);
    sun.target.position.copy(view.target);
    const s = Math.max(16, half * aspect * 1.5);
    // logical-css-ignore: the shadow camera's frustum, not layout
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 180 }); // logical-css-ignore
    sun.shadow.camera.updateProjectionMatrix();
  }

  private boundsOfRooms(list: readonly Room[]): THREE.Box3 {
    const b = new THREE.Box3();
    for (const r of list) {
      const y = this.levelY(r.levelKey);
      b.expandByPoint(new THREE.Vector3(r.x, y, r.z));
      b.expandByPoint(new THREE.Vector3(r.x + r.w, y + 2, r.z + r.d));
    }
    if (b.isEmpty()) b.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 2, 4));
    return b;
  }

  private fitTo(b: THREE.Box3, animate = true): void {
    const c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3());
    const w = this.stage.clientWidth || 1;
    const full = this.stage.clientHeight || 1;
    // Frame it in the part of the map the top bar and the bottom controls leave clear.
    const { top, bottom } = this.reserved();
    const h = Math.max(80, full - top - bottom);
    const ext = this.s.planView
      ? { x: s.x, y: s.z }
      : {
          x: (s.x + s.z) * Math.SQRT1_2,
          y: (s.x + s.z) * Math.SQRT1_2 * Math.sin(ELEV) + s.y * Math.cos(ELEV),
        };
    const zoom = Math.max(
      0.2,
      Math.min(
        10,
        (this.view.span * (w / full)) / (ext.x * 1.08),
        (this.view.span * (h / full)) / (ext.y * 1.1),
      ),
    );
    // Centre it in that part: the camera looks at a point the difference above the middle.
    const units = ((this.view.span / zoom) * ((top - bottom) / 2)) / full;
    const away = this.s.planView
      ? new THREE.Vector3(0, 0, -units)
      : new THREE.Vector3(-Math.sin(this.view.az), 0, -Math.cos(this.view.az)).multiplyScalar(
          units / Math.sin(ELEV),
        );
    const target = new THREE.Vector3(c.x, this.s.allFloors ? c.y - 1 : 0, c.z).add(away);
    this.tween({ target, zoom }, animate);
  }

  fitLevel = (animate = true): void =>
    this.fitTo(
      this.boundsOfRooms(this.plan.rooms.filter((r) => r.levelKey === this.s.levelKey)),
      animate,
    );

  fitAll = (animate = true): void => {
    if (this.s.allFloors) this.fitTo(this.boundsOfRooms(this.plan.rooms), animate);
    else this.fitLevel(animate);
  };

  zoomBy(f: number): void {
    this.tween({ zoom: Math.max(0.2, Math.min(10, this.view.zoom * f)) });
  }

  turnBy(quarters: number): void {
    this.tween({ az: this.view.az + (quarters * Math.PI) / 2 });
  }

  /** Home: out of a room, else the whole floor. */
  home(): void {
    if (this.s.focused) this.up();
    else this.fitAll();
  }

  // ---- Render on demand, and measure it --------------------------------------------------------

  request = (): void => {
    if (this.pending || this.disposed) return;
    this.pending = true;
    requestAnimationFrame(this.frame);
  };

  private frame = (now: number): void => {
    this.pending = false;
    if (this.disposed) return;
    this.stepTween(now);
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
    if (this.firstDraw === null) this.firstDraw = performance.now() - T0;
    if (this.last && now - this.last < 250) {
      this.frames.push(now);
      this.worst = Math.max(this.worst, now - this.last);
    }
    this.last = now;
    this.frames = this.frames.filter((t) => now - t < 1000);
    this.placeLabels();
    if (this.events.onStats) {
      const i = this.renderer.info.render;
      const ms = modelStats();
      this.events.onStats({
        fps: this.frames.length > 1 ? this.frames.length : null,
        worst: this.worst || null,
        calls: i.calls,
        triangles: i.triangles,
        models: ms.count,
        bytes: ms.bytes,
        loading: ms.loading,
        failed: ms.failed,
        firstDraw: this.firstDraw,
      });
    }
    if (this.busy > 0 || this.tw) this.request();
  };

  private tween(to: { target?: THREE.Vector3; zoom?: number; az?: number }, animate = true): void {
    if (!animate || reducedMotion()) {
      if (to.target) this.view.target.copy(to.target);
      if (to.zoom) this.view.zoom = to.zoom;
      if (to.az !== undefined) this.view.az = to.az;
      this.request();
      return;
    }
    this.tw = {
      from: { target: this.view.target.clone(), zoom: this.view.zoom, az: this.view.az },
      to,
      start: performance.now(),
      dur: 420,
    };
    this.request();
  }

  private stepTween(now: number): void {
    const tw = this.tw;
    if (!tw) return;
    let k = Math.min(1, (now - tw.start) / tw.dur);
    k = 1 - (1 - k) ** 3;
    if (tw.to.target) this.view.target.lerpVectors(tw.from.target, tw.to.target, k);
    if (tw.to.zoom) this.view.zoom = tw.from.zoom + (tw.to.zoom - tw.from.zoom) * k;
    if (tw.to.az !== undefined) this.view.az = tw.from.az + (tw.to.az - tw.from.az) * k;
    if (k >= 1) this.tw = null;
  }

  // ---- Labels --------------------------------------------------------------------------------

  private placeLabels(): void {
    const want: {
      html: string;
      at: THREE.Vector3;
      cls: string;
      center?: boolean;
      priority: number;
    }[] = [];
    const focusIds = new Set(
      [this.s.selected, this.hovered].filter((x) => x?.type === 'item').map((x) => x?.id),
    );
    const { planView, focused, allFloors, levelKey } = this.s;
    if (allFloors) {
      for (const l of this.plan.levels) {
        const rs = this.plan.rooms.filter((r) => r.levelKey === l.key);
        if (!rs.length) continue;
        const minX = Math.min(...rs.map((r) => r.x));
        const maxZ = Math.max(...rs.map((r) => r.z + r.d));
        want.push({
          html: esc(l.name),
          at: new THREE.Vector3(minX - 0.4, this.levelY(l.key) + 0.4, maxZ + 0.4),
          cls: 'map-label level',
          priority: LABEL_PRIORITY.level,
        });
      }
    } else {
      for (const r of this.plan.rooms) {
        if (r.levelKey !== levelKey || (focused && focused !== r.id)) continue;
        want.push({
          html: esc(r.name),
          at: new THREE.Vector3(
            r.x + r.w / 2,
            planView ? 0 : this.outdoors(r) ? 1.1 : 1.45,
            r.z + (planView ? 0.3 : 0.1),
          ),
          cls: 'map-label',
          priority: LABEL_PRIORITY.room,
        });
      }
      const close = this.view.zoom > 1.8 || !!focused;
      if (focused || planView) {
        for (const it of this.plan.items) {
          if (this.itemLevel(it) !== levelKey || (focused && it.roomId !== focused)) continue;
          const n = this.info.countIn(it);
          if (!planView && n === null) continue;
          if (planView && it.on) continue;
          const g = this.itemGroups.get(it.id);
          if (!g) continue;
          let html: string;
          if (planView) {
            const onIt = childrenOn(this.plan.items, it.id).map((c) => c.name);
            html = `<b>${esc(it.name)}</b>${n !== null ? ` · ${n}` : ''}`;
            if (close && onIt.length)
              html += `\n${esc(onIt.map((x) => this.info.text.onIt(x)).join('\n'))}`;
            const first = close ? this.info.preview(it) : [];
            if (first.length) {
              const rest = this.info.insideCount(it) - first.length;
              html += `\n${esc(first.map((c) => `${c.name}${c.quantity > 1 ? ` ×${c.quantity}` : ''}`).join('\n'))}${rest > 0 ? `\n${esc(this.info.text.more(rest))}` : ''}`;
            }
          } else html = `${n}`;
          want.push({
            html,
            at: new THREE.Vector3(
              g.position.x,
              planView ? 0 : this.topOf(it) + g.position.y,
              g.position.z,
            ),
            cls: planView ? 'map-label small' : 'map-label count',
            center: planView,
            priority: focusIds.has(it.id) ? LABEL_PRIORITY.focus : LABEL_PRIORITY.contents,
          });
        }
      }
    }
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    // Place and measure every label, then keep those that fit (declutter.ts): nothing is cut off
    // and no text is written over other text or the map's controls.
    const placed = want.map((l, i) => {
      let el = this.pool[i];
      if (!el) {
        el = document.createElement('div');
        this.labelsEl.append(el);
        this.pool[i] = el;
      }
      const v = l.at.clone().project(this.camera);
      el.className = l.cls;
      if (el._html !== l.html) {
        el.innerHTML = l.html;
        el._html = l.html;
      }
      el.hidden = false;
      const bw = el.offsetWidth;
      const bh = el.offsetHeight;
      // Never cut off at the edge: slide it in instead.
      const x = Math.min(Math.max(((v.x + 1) / 2) * w, bw / 2 + 6), w - bw / 2 - 6);
      const y = ((1 - v.y) / 2) * h;
      const top = l.center ? y - bh / 2 : y - bh;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${l.center ? '-50%' : '-100%'})`;
      return {
        el,
        off: Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05,
        box: { x: x - bw / 2, y: top, w: bw, h: bh, priority: l.priority },
      };
    });
    const shown = declutter(
      placed.map((p) => p.box),
      { w, h },
      this.obstacles(),
    );
    placed.forEach((p, i) => {
      p.el.hidden = p.off || !shown[i];
    });
    for (let i = want.length; i < this.pool.length; i++) {
      const el = this.pool[i];
      if (el) el.hidden = true;
    }
  }

  /** The controls drawn over the map (marked `data-map-obstacle`), in the map's pixels. */
  private obstacles(): Rect[] {
    const s = this.stage.getBoundingClientRect();
    const out: Rect[] = [];
    for (const el of this.stage.querySelectorAll<HTMLElement>('[data-map-obstacle]')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height)
        out.push({ x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height });
    }
    return out;
  }

  /** The map's top and bottom pixels taken by its controls, which a fit leaves clear. */
  private reserved(): { top: number; bottom: number } {
    const s = this.stage.getBoundingClientRect();
    let top = 0;
    let bottom = 0;
    for (const el of this.stage.querySelectorAll<HTMLElement>('[data-map-reserve]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (el.dataset.mapReserve === 'top') top = Math.max(top, r.bottom - s.top);
      else if (r.top - s.top > s.height / 2) bottom = Math.max(bottom, s.bottom - r.top);
    }
    return { top: top + 8, bottom: bottom + 8 };
  }

  // ---- Selection, hover and focus: one painter decides each mesh's look ------------------------

  private baseOf(m: THREE.Mesh): THREE.Material {
    if (!m.userData.base) m.userData.base = m.material;
    return m.userData.base as THREE.Material;
  }

  private tinted(cache: Map<THREE.Material, THREE.Material>, src: THREE.Material, k: number) {
    let g = cache.get(src);
    if (!g) {
      const c = src.clone() as THREE.MeshStandardMaterial;
      if (c.emissive) {
        c.emissive = new THREE.Color(css('--amber') || '#F0B03A');
        c.emissiveIntensity = k;
      }
      g = c;
      cache.set(src, g);
    }
    return g;
  }

  private fade(src: THREE.Material): THREE.Material {
    let f = this.fadeMats.get(src);
    if (!f) {
      f = src.clone();
      f.transparent = true;
      f.opacity = 0.12;
      f.depthWrite = false;
      this.fadeMats.set(src, f);
    }
    return f;
  }

  private groupOfId(sel: Sel): THREE.Group | undefined {
    return sel.type === 'room' ? this.roomGroups.get(sel.id) : this.itemGroups.get(sel.id);
  }

  private paint(sel: Sel | null): void {
    if (!sel) return;
    const isSel = same(sel, this.s.selected);
    const isHov = same(sel, this.hovered) && sel.type === 'item';
    this.groupOfId(sel)?.traverse((o) => {
      if (!isMesh(o)) return;
      const pick = o.userData.pick as Pick | undefined;
      if (o.parent?.userData.pinKind || pick?.type === 'handle') return;
      if (sel.type === 'room' && pick?.type !== 'room') return;
      const dim = !!this.s.focused && this.roomIdOf(pick) !== this.s.focused;
      const b = this.baseOf(o);
      o.material = isSel
        ? this.tinted(this.glowMats, b, 0.35)
        : isHov
          ? this.tinted(this.hoverMats, b, 0.14)
          : dim
            ? this.fade(b)
            : b;
    });
  }

  /** Selects a room or thing (null clears), as a tap does. */
  select(sel: Sel | null, emit = true): void {
    const prev = this.s.selected;
    this.s.selected = sel && this.groupOfId(sel) ? sel : null;
    this.paint(prev);
    this.paint(this.s.selected);
    this.showBatches();
    this.request();
    if (emit) this.emit();
  }

  private applyFocus(): void {
    for (const id of this.roomGroups.keys()) this.paint({ type: 'room', id });
    for (const id of this.itemGroups.keys()) this.paint({ type: 'item', id });
    this.showBatches();
    this.applyPins();
  }

  /** Into a room: the camera moves to it and everything else fades. */
  drill(roomId: string): void {
    const r = this.roomOf(roomId);
    if (!r) return;
    if (this.s.allFloors || r.levelKey !== this.s.levelKey) this.setLevel(r.levelKey, false);
    this.s.focused = roomId;
    this.applyFocus();
    this.fitTo(this.boundsOfRooms([r]));
    this.emit();
  }

  /** Out of the room, back to the floor. */
  up(): void {
    this.s.focused = null;
    this.applyFocus();
    this.fitLevel();
    this.emit();
  }

  private applyPin(it: Item): void {
    for (const p of this.pinMeshes) {
      if (p.userData.item !== it.id) continue;
      const kind = p.userData.pinKind as MapAttentionKind;
      p.visible = this.shown[kind] && (!this.s.focused || it.roomId === this.s.focused);
    }
  }

  private applyPins(): void {
    for (const p of this.pinMeshes) {
      const it = this.itemOf(p.userData.item as string);
      const kind = p.userData.pinKind as MapAttentionKind;
      p.visible = !!it && this.shown[kind] && (!this.s.focused || it.roomId === this.s.focused);
    }
    this.request();
  }

  // ---- Hover (mouse only): name, short ID and what's inside, without a click -------------------

  private doHover = (): void => {
    this.hoverPending = false;
    if (!this.hoverAt) return;
    const [x, y] = this.hoverAt;
    const p = this.pick(x, y);
    let sel: Sel | null = null;
    let html = '';
    if (this.s.allFloors) {
      const lvl =
        p && (p.type === 'room' ? this.roomOf(p.id)?.levelKey : this.itemLevel(this.itemOf(p.id)));
      const level = this.plan.levels.find((l) => l.key === lvl);
      if (level) html = `<b>${esc(level.name)}</b> · ${esc(this.info.text.openFloor)}`;
    } else if (p?.type === 'item') {
      const it = this.itemOf(p.id);
      if (it) {
        const n = this.info.countIn(it);
        sel = { type: 'item', id: it.id };
        const code = it.shortCode ? ` <small>${esc(printed(it.shortCode))}</small>` : '';
        const stairs = it.model === 'stairs' || it.model === 'stairwell';
        html = `<b>${esc(it.name)}</b>${code}${n !== null ? `<br>${esc(this.info.text.inside(n))}` : ''}${stairs ? `<br>${esc(this.info.text.changeFloor)}` : ''}`;
      }
    } else if (p?.type === 'room') {
      const r = this.roomOf(p.id);
      if (r) html = `<b>${esc(r.name)}</b>`;
    }
    this.setHover(sel);
    this.tip.hidden = !html;
    if (html) {
      this.tip.innerHTML = html;
      const rc = this.stage.getBoundingClientRect();
      this.tip.style.transform = `translate(${x - rc.left + 14}px, ${y - rc.top + 14}px)`;
    }
    this.canvas.style.cursor = p && p.type !== 'room' ? 'pointer' : '';
  };

  private setHover(sel: Sel | null): void {
    if (same(sel, this.hovered) || (!sel && !this.hovered)) return;
    const prev = this.hovered;
    this.hovered = sel;
    this.paint(prev);
    this.paint(this.hovered);
    this.showBatches();
    if (!sel && !this.hoverAt) this.tip.hidden = true;
    this.request();
  }

  // ---- Arranging ------------------------------------------------------------------------------

  setArranging(on: boolean): void {
    if (on && this.s.allFloors) this.setLevel(this.s.levelKey);
    this.s.arranging = on;
    for (const h of this.handles.values()) h.visible = on;
    for (const g of this.roomGroups.values()) {
      for (const c of g.children) if (c.userData.grid) c.visible = on || this.s.planView;
    }
    this.setTool('move');
    this.request();
    this.emit();
  }

  setTool(t: Tool): void {
    this.s.tool = t;
    this.events.onHint(t);
    this.emit();
  }

  /** A quarter turn of a thing, carrying what stands on it. */
  turnItem(id: string): void {
    const it = this.itemOf(id);
    if (!it) return;
    turn(this.plan.items, this.plan.rooms, it);
    this.changed();
    this.select({ type: 'item', id }, false);
  }

  /** The plan changed under the engine (a room's kind, a model, a thing added or removed). */
  changed(): void {
    this.rebuild();
    this.events.onChange();
  }

  private ndc(x: number, y: number): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  private groundAt(x: number, y: number): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc(x, y), this.camera);
    return this.ray.ray.intersectPlane(this.plane, new THREE.Vector3());
  }

  private pick(x: number, y: number): Pick | null {
    this.ray.setFromCamera(this.ndc(x, y), this.camera);
    // Batched things hide their own bodies, but the bodies still answer the ray.
    const objs: THREE.Object3D[] = [];
    for (const g of this.levelGroups.values()) {
      if (!g.visible) continue;
      g.traverse((o) => {
        const pick = o.userData.pick as Pick | undefined;
        if (isMesh(o) && pick && (o.visible || pick.type === 'item')) objs.push(o);
      });
    }
    for (const h of this.ray.intersectObjects(objs, false)) {
      const p = h.object.userData.pick as Pick;
      if (p.type === 'handle' && !this.s.arranging) continue;
      if (this.s.focused && p.type !== 'handle' && this.roomIdOf(p) !== this.s.focused) continue;
      return p;
    }
    return null;
  }

  private snapshot() {
    const a = [...this.pts.values()];
    const [p, q] = a;
    if (p && q) {
      return {
        n: 2,
        d: Math.hypot(q.x - p.x, q.y - p.y),
        ang: Math.atan2(q.y - p.y, q.x - p.x),
        mx: (p.x + q.x) / 2,
        my: (p.y + q.y) / 2,
      };
    }
    return { n: 1, d: 0, ang: 0, mx: p?.x ?? 0, my: p?.y ?? 0 };
  }

  private listen(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn, opts));
    };
    const c = this.canvas;
    on(c, 'pointermove', (e) => {
      if (e.pointerType !== 'mouse' || this.pts.size) return;
      this.hoverAt = [e.clientX, e.clientY];
      if (!this.hoverPending) {
        this.hoverPending = true;
        requestAnimationFrame(this.doHover);
      }
    });
    on(c, 'pointerleave', () => {
      this.hoverAt = null;
      this.setHover(null);
      this.tip.hidden = true;
    });
    on(c, 'pointerdown', (e) => this.down(e));
    on(c, 'pointermove', (e) => this.move(e));
    on(c, 'pointerup', (e) => this.end(e));
    on(c, 'pointercancel', (e) => this.end(e));
    on(
      c,
      'wheel',
      (e) => {
        e.preventDefault();
        this.view.zoom = Math.max(0.2, Math.min(10, this.view.zoom * Math.exp(-e.deltaY * 0.0015)));
        this.request();
      },
      { passive: false },
    );
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.stage);
    this.cleanup.push(() => ro.disconnect());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', this.applyColours);
    this.cleanup.push(() => mq.removeEventListener('change', this.applyColours));
    const mo = new MutationObserver(this.applyColours);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.cleanup.push(() => mo.disconnect());
  }

  private resize(): void {
    this.renderer.setSize(this.stage.clientWidth, this.stage.clientHeight, false);
    this.request();
  }

  private down(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone can't be captured; the gesture still works.
    }
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.tw = null;
    this.busy++;
    this.tip.hidden = true;
    this.plane.constant = -this.view.target.y;
    this.gesture = {
      start: performance.now(),
      moved: 0,
      sx: e.clientX,
      sy: e.clientY,
      prev: this.snapshot(),
    };
    if (this.pts.size > 1) {
      this.drag = null;
      this.preview?.removeFromParent();
      this.preview = null;
      return;
    }
    this.drag = null;
    if (!this.s.arranging) return;
    this.plane.constant = 0;
    const g = this.groundAt(e.clientX, e.clientY);
    if (!g) return;
    if (this.s.tool === 'room') {
      this.drag = { type: 'draw', from: g };
      return;
    }
    const p = this.pick(e.clientX, e.clientY);
    if (p?.type === 'handle') this.drag = { type: 'resize', id: p.id };
    else if (p?.type === 'item') {
      const grp = this.itemGroups.get(p.id);
      if (grp)
        this.drag = {
          type: 'item',
          id: p.id,
          off: new THREE.Vector3(grp.position.x - g.x, 0, grp.position.z - g.z),
        };
    }
  }

  private move(e: PointerEvent): void {
    if (!this.pts.has(e.pointerId) || !this.gesture) return;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.gesture.moved = Math.max(
      this.gesture.moved,
      Math.hypot(e.clientX - this.gesture.sx, e.clientY - this.gesture.sy),
    );
    if (this.drag && this.pts.size === 1) {
      this.dragTo(e.clientX, e.clientY);
      return;
    }
    const now = this.snapshot();
    const prev = this.gesture.prev;
    if (now.n === prev.n) {
      const a = this.groundAt(prev.mx, prev.my);
      const b = this.groundAt(now.mx, now.my);
      if (a && b) this.view.target.add(a.sub(b));
      if (now.n === 2 && prev.d > 0) {
        this.view.zoom = Math.max(0.2, Math.min(10, (this.view.zoom * now.d) / prev.d));
        if (!this.s.planView) this.view.az -= now.ang - prev.ang;
      }
    }
    this.gesture.prev = now;
    this.request();
  }

  private dragTo(x: number, y: number): void {
    const g = this.groundAt(x, y);
    const drag = this.drag;
    if (!g || !drag || !this.gesture) return;
    if (drag.type === 'item') {
      if (this.gesture.moved < 6) return;
      const it = this.itemOf(drag.id);
      if (!it) return;
      const f = fp(it);
      const c = g.clone().add(drag.off);
      const home = this.roomOf(it.roomId);
      const room = roomAt(this.plan.rooms, this.s.levelKey, c) ?? home;
      if (!room || !home) return;
      // Into another room: saving the session moves it there in Kept too (map-view.tsx).
      if (room.id !== it.roomId) rehome(this.plan.items, it, home, room);
      const host = hostAt(this.plan, this.s.levelKey, c, it);
      moveBy(
        this.plan.items,
        it,
        snap(c.x - room.x - f.w / 2, 0.1) - it.x,
        snap(c.z - room.z - f.d / 2, 0.1) - it.z,
      );
      it.on = host && host.roomId === it.roomId && canStandOn(it.model) ? host.id : null;
      if (!it.on) {
        const bx = it.x;
        const bz = it.z;
        clampIn(it, room);
        for (const id of standingOn(this.plan.items, it.id)) {
          const t = this.itemOf(id);
          if (t) {
            t.x += it.x - bx;
            t.z += it.z - bz;
          }
        }
      }
      for (const t of [it, ...standingOn(this.plan.items, it.id).map((id) => this.itemOf(id))])
        this.placeItem(t);
      if (this.s.selected?.id !== it.id) this.select({ type: 'item', id: it.id });
    } else if (drag.type === 'resize') {
      const r = this.roomOf(drag.id);
      if (!r) return;
      const w = Math.max(2, Math.round(g.x - r.x));
      const d = Math.max(2, Math.round(g.z - r.z));
      for (const [cw, cd] of [
        [w, d],
        [w, r.d],
        [r.w, d],
      ] as const) {
        if (!overlapsRoom(this.plan.rooms, { x: r.x, z: r.z, w: cw, d: cd }, r.id, r.levelKey)) {
          r.w = cw;
          r.d = cd;
          break;
        }
      }
      for (const it of this.plan.items.filter((i) => i.roomId === r.id && !i.on)) {
        const bx = it.x;
        const bz = it.z;
        clampIn(it, r);
        for (const id of standingOn(this.plan.items, it.id)) {
          const t = this.itemOf(id);
          if (t) {
            t.x += it.x - bx;
            t.z += it.z - bz;
          }
        }
      }
      this.buildRoom(r);
      for (const i of this.plan.items.filter((x) => x.roomId === r.id)) this.placeItem(i);
      this.paint({ type: 'room', id: r.id });
      this.batchFloor(r.levelKey);
      this.events.onChange();
    } else if (drag.type === 'draw') {
      const a = drag.from;
      const x0 = Math.floor(Math.min(a.x, g.x));
      const z0 = Math.floor(Math.min(a.z, g.z));
      const x1 = Math.ceil(Math.max(a.x, g.x));
      const z1 = Math.ceil(Math.max(a.z, g.z));
      drag.rect = { x: x0, z: z0, w: Math.max(1, x1 - x0), d: Math.max(1, z1 - z0) };
      if (!this.preview) {
        this.preview = new THREE.Mesh(
          new THREE.BoxGeometry(1, 0.2, 1),
          new THREE.MeshStandardMaterial({
            color: css('--amber') || '#F0B03A',
            transparent: true,
            opacity: 0.45,
          }),
        );
        this.scene.add(this.preview);
      }
      this.preview.scale.set(drag.rect.w, 1, drag.rect.d);
      this.preview.position.set(drag.rect.x + drag.rect.w / 2, -0.1, drag.rect.z + drag.rect.d / 2);
      const bad = overlapsRoom(this.plan.rooms, drag.rect, null, this.s.levelKey);
      (this.preview.material as THREE.MeshStandardMaterial).color.set(
        css(bad ? '--danger' : '--amber') || '#F0B03A',
      );
      this.events.onHint(bad ? 'overlap' : 'room');
    }
    this.request();
  }

  private end(e: PointerEvent): void {
    if (!this.pts.has(e.pointerId) || !this.gesture) return;
    this.pts.delete(e.pointerId);
    this.busy = Math.max(0, this.busy - 1);
    const gesture = this.gesture;
    if (this.drag && !this.pts.size) {
      const d = this.drag;
      this.drag = null;
      if (d.type === 'draw') {
        this.preview?.removeFromParent();
        this.preview = null;
        this.events.onHint(this.s.tool);
        if (
          d.rect &&
          d.rect.w >= 2 &&
          d.rect.d >= 2 &&
          !overlapsRoom(this.plan.rooms, d.rect, null, this.s.levelKey)
        ) {
          this.events.onDrawRoom(d.rect, this.s.levelKey);
        }
        this.request();
        return;
      }
      if (d.type === 'resize' || (d.type === 'item' && gesture.moved >= 6)) {
        const keep = this.s.selected;
        this.rebuild();
        if (keep) this.select(keep, false);
        this.events.onChange();
        this.request();
        return;
      }
    }
    if (this.pts.size) {
      gesture.prev = this.snapshot();
      return;
    }
    if (performance.now() - gesture.start < 350 && gesture.moved < 8) {
      const p = this.pick(e.clientX, e.clientY);
      if (this.s.allFloors) {
        const lvl =
          p &&
          (p.type === 'room' ? this.roomOf(p.id)?.levelKey : this.itemLevel(this.itemOf(p.id)));
        if (lvl) this.setLevel(lvl);
        return;
      }
      const sel: Sel | null = p && p.type !== 'handle' ? { type: p.type, id: p.id } : null;
      const key = sel ? `${sel.type}:${sel.id}` : '';
      const now = performance.now();
      if (sel && key === this.lastTap.key && now - this.lastTap.t < 320) {
        const rid = this.roomIdOf(sel);
        if (rid && this.s.focused !== rid) this.drill(rid);
      } else if (!same(sel, this.s.selected)) this.select(sel);
      this.lastTap = { t: now, key };
    }
    this.request();
  }

  setPlanView(on: boolean, fit = true): void {
    if (on && this.s.allFloors) {
      this.s.allFloors = false;
      this.applyLevels();
      this.applyFocus();
    }
    this.s.planView = on;
    for (const g of this.roomGroups.values()) {
      for (const c of g.children) if (c.userData.grid) c.visible = on || this.s.arranging;
    }
    this.renderer.shadowMap.enabled = !on && this.shadows;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
    });
    this.emit();
    if (!fit) return;
    const f = this.roomOf(this.s.focused);
    if (f) this.fitTo(this.boundsOfRooms([f]), false);
    else this.fitAll(false);
  }

  /** The room a newly drawn or added room should be selected as, once the plan has it. */
  selectRoom(id: string): void {
    this.select({ type: 'room', id });
  }
}

/** A short ID as printed on a label: `K7D‑2QX`. */
export const printed = (c: string) => `${c.slice(0, 3)}‑${c.slice(3)}`;
