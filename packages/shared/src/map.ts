/**
 * The location map (1.x, D237): what the server checks and the web draws agree on these.
 *
 * - A **room** is a place on a floor (or at the top of the tree) with a rectangle, a kind and a
 *   floor surface. Floors are places of the built-in `floor` kind.
 * - A **node** is a place or a thing shown in a room with a model from MAP_MODELS, a position,
 *   a quarter turn and, for something standing on a counter or shelf, the node it sits on.
 * - Layout is stored in whole centimetres (`map_nodes`); the web draws in metres.
 *
 * Footprints (`w` × `d`, metres, before a turn) and heights are the shrunk models' measured
 * bounds, or the drawn model's size. `top` is the height something can stand on; `holds` says it
 * is storage with contents. `glb` names a Poly Haven model (CC0) the web ships, `rotFix` turns it
 * to face +z, `simple` names the drawn stand-in used when detailed models are off.
 */

export const MAP_ROOM_KINDS = ['room', 'balcony', 'terrace', 'garden'] as const;
export type MapRoomKind = (typeof MAP_ROOM_KINDS)[number];

export const MAP_SURFACES = ['wood', 'tile', 'concrete', 'deck', 'grass'] as const;
export type MapSurface = (typeof MAP_SURFACES)[number];

/** A room kind's floor until someone picks another. */
export const ROOM_KIND_SURFACE: Readonly<Record<MapRoomKind, MapSurface>> = {
  room: 'wood',
  balcony: 'deck',
  terrace: 'concrete',
  garden: 'grass',
};

export const MAP_TURNS = [0, 90, 180, 270] as const;
export type MapTurn = (typeof MAP_TURNS)[number];

export type MapModelKind = 'furniture' | 'storage' | 'thing';

export type MapModel = Readonly<{
  w: number;
  d: number;
  h?: number;
  kind: MapModelKind;
  top?: number;
  holds?: boolean;
  small?: boolean;
  glb?: string;
  rotFix?: number;
  simple?: string;
}>;

export const MAP_MODELS = {
  sofa: { w: 1.81, d: 0.82, h: 0.71, kind: 'furniture', glb: 'sofa_02', simple: 'sofa' },
  armchair: { w: 0.82, d: 0.99, h: 1.02, kind: 'furniture', glb: 'modern_arm_chair_01' },
  coffee_table: {
    w: 1.2,
    d: 0.6,
    h: 0.39,
    kind: 'furniture',
    top: 0.39,
    glb: 'modern_coffee_table_01',
    rotFix: 90,
    simple: 'coffee_table',
  },
  // The Poly Haven cabinet is 241 KB shrunk, over the 150 KB a model may weigh: drawn instead.
  tv_stand: { w: 2.44, d: 0.52, h: 0.68, kind: 'furniture', top: 0.68, holds: true },
  cube_shelf: {
    w: 1.08,
    d: 0.37,
    h: 1.56,
    kind: 'storage',
    holds: true,
    glb: 'wooden_display_shelves_01',
    rotFix: -90,
  },
  // The fiddle-leaf fig's model is 221 KB shrunk: drawn as a plant instead.
  tall_plant: { w: 0.59, d: 0.63, h: 1.34, kind: 'thing', simple: 'plant' },
  plant: { w: 0.7, d: 0.66, h: 0.84, kind: 'thing', glb: 'potted_plant_02', simple: 'plant' },
  succulent: { w: 0.17, d: 0.18, h: 0.27, kind: 'thing', small: true, glb: 'potted_plant_04' },
  dining_chair: {
    w: 0.43,
    d: 0.58,
    h: 0.97,
    kind: 'furniture',
    glb: 'dining_chair_02',
    simple: 'dchair',
  },
  drawers: { w: 1.14, d: 0.49, h: 1.88, kind: 'storage', holds: true, glb: 'drawer_cabinet' },
  bedside: {
    w: 0.55,
    d: 0.45,
    h: 0.55,
    kind: 'furniture',
    top: 0.55,
    holds: true,
    glb: 'side_table_01',
  },
  metal_shelf: {
    w: 0.59,
    d: 0.5,
    h: 2.14,
    kind: 'storage',
    holds: true,
    glb: 'steel_frame_shelves_02',
    simple: 'shelf_unit',
  },
  tool_cart: {
    w: 1.27,
    d: 0.75,
    h: 0.97,
    kind: 'storage',
    top: 0.96,
    holds: true,
    glb: 'tool_cart',
  },
  drill: {
    w: 0.18,
    d: 0.06,
    h: 0.19,
    kind: 'thing',
    small: true,
    glb: 'Drill_01',
    simple: 'drill',
  },
  cardboard: {
    w: 0.39,
    d: 0.52,
    h: 0.34,
    kind: 'storage',
    top: 0.34,
    holds: true,
    small: true,
    glb: 'cardboard_box_01',
    simple: 'box',
  },
  crate: {
    w: 0.51,
    d: 0.41,
    h: 0.25,
    kind: 'storage',
    holds: true,
    small: true,
    glb: 'plastic_crate_02',
  },
  basket: {
    w: 0.35,
    d: 0.25,
    h: 0.2,
    kind: 'storage',
    holds: true,
    small: true,
    glb: 'wicker_basket_02',
  },
  outdoor_set: {
    w: 1.72,
    d: 0.74,
    h: 0.86,
    kind: 'furniture',
    glb: 'outdoor_table_chair_set_01',
    rotFix: 90,
  },
  monobloc: { w: 0.64, d: 0.63, h: 0.88, kind: 'furniture', glb: 'plastic_monobloc_chair_01' },
  planter: { w: 0.91, d: 0.41, h: 0.43, kind: 'thing', glb: 'planter_box_01' },
  planter_long: { w: 1.25, d: 0.47, h: 0.45, kind: 'thing', glb: 'planter_box_02' },
  ac_unit: { w: 1.8, d: 0.37, h: 0.93, kind: 'thing', glb: 'exterior_aircon_unit' },
  watering_can: {
    w: 0.45,
    d: 0.19,
    h: 0.2,
    kind: 'thing',
    small: true,
    glb: 'watering_can_metal_01',
    rotFix: 90,
  },
  // Drawn: modern appliances and pieces the free library doesn't have.
  tv: { w: 1.24, d: 0.26, kind: 'thing' },
  bookshelf: { w: 1.2, d: 0.35, kind: 'storage', holds: true },
  lamp: { w: 0.4, d: 0.4, kind: 'thing' },
  counter: { w: 1.8, d: 0.62, kind: 'furniture', top: 0.92, holds: true },
  sink: { w: 1.2, d: 0.62, kind: 'furniture', top: 0.92, holds: true },
  fridge: { w: 0.7, d: 0.7, kind: 'thing' },
  coffee_machine: { w: 0.3, d: 0.36, kind: 'thing' },
  microwave: { w: 0.5, d: 0.38, kind: 'thing' },
  dining: { w: 1.6, d: 0.9, kind: 'furniture', top: 0.75 },
  bed: { w: 1.7, d: 2.15, kind: 'furniture' },
  wardrobe: { w: 1.5, d: 0.6, kind: 'storage', holds: true },
  table_lamp: { w: 0.3, d: 0.3, kind: 'thing', small: true },
  desk: { w: 1.4, d: 0.7, kind: 'furniture', top: 0.74, holds: true },
  monitor: { w: 0.62, d: 0.22, kind: 'thing' },
  laptop: { w: 0.31, d: 0.22, kind: 'thing', small: true },
  // Everyday electronics, drawn at their real sizes (#130).
  pc_tower: { w: 0.2, d: 0.43, h: 0.45, kind: 'thing', small: true },
  keyboard: { w: 0.44, d: 0.14, h: 0.03, kind: 'thing', small: true },
  mouse: { w: 0.065, d: 0.115, h: 0.04, kind: 'thing', small: true },
  webcam: { w: 0.1, d: 0.06, h: 0.08, kind: 'thing', small: true },
  camera: { w: 0.13, d: 0.1, h: 0.1, kind: 'thing', small: true },
  speaker: { w: 0.16, d: 0.22, h: 0.27, kind: 'thing', small: true },
  floor_speaker: { w: 0.2, d: 0.28, h: 1.0, kind: 'thing' },
  smart_speaker: { w: 0.1, d: 0.1, h: 0.15, kind: 'thing', small: true },
  soundbar: { w: 0.9, d: 0.1, h: 0.07, kind: 'thing', small: true },
  headphones: { w: 0.18, d: 0.09, h: 0.2, kind: 'thing', small: true },
  router: { w: 0.24, d: 0.15, h: 0.2, kind: 'thing', small: true },
  printer: { w: 0.43, d: 0.36, h: 0.2, kind: 'thing', small: true },
  console: { w: 0.3, d: 0.26, h: 0.07, kind: 'thing', small: true },
  controller: { w: 0.16, d: 0.1, h: 0.05, kind: 'thing', small: true },
  phone: { w: 0.075, d: 0.155, h: 0.01, kind: 'thing', small: true },
  tablet: { w: 0.25, d: 0.18, h: 0.01, kind: 'thing', small: true },
  power_strip: { w: 0.3, d: 0.06, h: 0.04, kind: 'thing', small: true },
  external_drive: { w: 0.08, d: 0.12, h: 0.02, kind: 'thing', small: true },
  /** A small gadget with no model of its own (a hub, a thermostat, a charger): D249. */
  device: { w: 0.2, d: 0.14, h: 0.1, kind: 'thing', small: true },
  chair: { w: 0.66, d: 0.66, kind: 'furniture' },
  cabinet: { w: 0.47, d: 0.62, kind: 'storage', holds: true },
  box: { w: 0.6, d: 0.4, kind: 'storage', holds: true, small: true, top: 0.34 },
  washer: { w: 0.6, d: 0.6, kind: 'thing' },
  workbench: { w: 1.8, d: 0.7, kind: 'furniture', top: 0.92, holds: true },
  tool_wall: { w: 1.6, d: 0.12, kind: 'storage', holds: true },
  car: { w: 1.78, d: 4.6, kind: 'thing' },
  bike: { w: 0.6, d: 1.75, kind: 'thing' },
  water_tank: { w: 1.1, d: 1.1, kind: 'thing' },
  dish: { w: 0.9, d: 0.9, kind: 'thing' },
  stairs: { w: 1.0, d: 2.8, kind: 'furniture' },
  stairwell: { w: 1.0, d: 2.8, kind: 'furniture' },
  /** A zone of a room with nothing to draw but its floor (a corner, an area). */
  zone: { w: 1.2, d: 1.2, h: 0.02, kind: 'storage', holds: true },
  /** Anything else: a small plain block. */
  item: { w: 0.4, d: 0.3, h: 0.3, kind: 'thing', small: true },
} as const satisfies Record<string, MapModel>;

export type MapModelKey = keyof typeof MAP_MODELS;
export const MAP_MODEL_KEYS = Object.keys(MAP_MODELS) as MapModelKey[];

export const isMapModel = (key: unknown): key is MapModelKey =>
  typeof key === 'string' && Object.hasOwn(MAP_MODELS, key);

/** A model's numbers, widened (the catalogue is `as const`). */
export const mapModel = (key: MapModelKey): MapModel => MAP_MODELS[key] as MapModel;

/** Models that lead up or down a floor: their card offers the floors next to theirs. */
export const STAIR_MODELS: ReadonlySet<MapModelKey> = new Set(['stairs', 'stairwell']);

/** Limits of one arrangement (PUT /api/v1/locations/:id/layout). */
export const MAP_LIMITS = {
  rooms: 400,
  nodes: 3000,
  /** Positions, in centimetres from the floor's corner: up to a kilometre. */
  maxCoord: 100_000,
  /** A room's side, in centimetres. */
  minRoom: 100,
  maxRoom: 10_000,
} as const;

/** A footprint (metres) after a quarter turn. */
export function footprintOf(key: MapModelKey, rot: number): { w: number; d: number } {
  const m = mapModel(key);
  return rot % 180 ? { w: m.d, d: m.w } : { w: m.w, d: m.d };
}

export type MapRect = { x: number; z: number; w: number; d: number };

/** Whether two rectangles overlap (touching edges don't). */
export function rectsOverlap(a: MapRect, b: MapRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.d && a.z + a.d > b.z;
}

/** The first pair of rectangles in `rects` that overlap, by index, or null. */
export function firstOverlap(rects: readonly MapRect[]): [number, number] | null {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a && b && rectsOverlap(a, b)) return [i, j];
    }
  }
  return null;
}

/** A model something small can stand on (a counter, a desk, a shelf top, a box). */
export const canHost = (key: MapModelKey): boolean => mapModel(key).top !== undefined;

/** Only things and small storage go on top of something (the spike's rule). */
export const canStandOn = (key: MapModelKey): boolean => {
  const m = mapModel(key);
  return m.kind === 'thing' || m.small === true;
};

/** Words in a name that pick a model (lower case, whole words or word starts). First match wins. */
const NAME_MODELS: readonly (readonly [RegExp, MapModelKey])[] = [
  [/\b(stair|stairs|staircase)\b/, 'stairs'],
  [/\b(tv|television)\b/, 'tv'],
  [/\b(sofa|couch|settee)\b/, 'sofa'],
  [/\barm ?chair\b/, 'armchair'],
  [/\bcoffee table\b/, 'coffee_table'],
  [/\b(tv stand|tv unit|sideboard|media unit)\b/, 'tv_stand'],
  [/\b(bookshelf|bookcase)\b/, 'bookshelf'],
  [/\b(cube shelf|display shelf)\b/, 'cube_shelf'],
  [/\b(shelf|shelves|shelving|rack)\b/, 'metal_shelf'],
  [/\b(wardrobe|closet|pantry|cupboard)\b/, 'wardrobe'],
  [/\b(drawers|dresser|chest)\b/, 'drawers'],
  [/\b(bedside|nightstand|night stand)\b/, 'bedside'],
  [/\bbed\b/, 'bed'],
  [/\b(desk)\b/, 'desk'],
  [/\b(workbench|work bench)\b/, 'workbench'],
  [/\b(tool wall|pegboard)\b/, 'tool_wall'],
  [/\btool (cart|trolley|chest)\b/, 'tool_cart'],
  [/\b(filing cabinet|cabinet)\b/, 'cabinet'],
  [/\b(sink)\b/, 'sink'],
  [/\b(counter|worktop|kitchen unit)\b/, 'counter'],
  [/\b(fridge|refrigerator|freezer)\b/, 'fridge'],
  [/\b(washing machine|washer|dryer)\b/, 'washer'],
  [/\b(microwave|oven)\b/, 'microwave'],
  [/\b(coffee machine|espresso|coffee maker)\b/, 'coffee_machine'],
  [/\b(dining table|table)\b/, 'dining'],
  [/\b(desk chair|office chair)\b/, 'chair'],
  [/\b(plastic chair|garden chair)\b/, 'monobloc'],
  [/\bchair\b/, 'dining_chair'],
  [/\b(monitor|screen|display)\b/, 'monitor'],
  [/\b(laptop|macbook|notebook computer)\b/, 'laptop'],
  [/\b(table lamp|desk lamp|bedside lamp)\b/, 'table_lamp'],
  [/\blamp\b/, 'lamp'],
  [/\b(drill|driver)\b/, 'drill'],
  [/\b(bike|bicycle)\b/, 'bike'],
  [/\b(car|van|truck|suv)\b/, 'car'],
  [/\b(water tank|tank)\b/, 'water_tank'],
  [/\b(satellite|dish)\b/, 'dish'],
  [/\b(ac|air ?con|air conditioner|condenser)\b/, 'ac_unit'],
  [/\bplanter\b/, 'planter'],
  [/\b(succulent|cactus)\b/, 'succulent'],
  [/\b(tree|fig|palm)\b/, 'tall_plant'],
  [/\bplant\b/, 'plant'],
  [/\bwatering can\b/, 'watering_can'],
  [/\b(crate|bin|tub)\b/, 'crate'],
  [/\bbasket\b/, 'basket'],
  [/\b(moving box|carton|cardboard)\b/, 'cardboard'],
  [/\bbox\b/, 'box'],
];

/** A built-in type's model when the name says nothing. */
const TYPE_MODELS: Readonly<Record<string, MapModelKey>> = {
  car: 'car',
  vehicle: 'car',
  motorbike: 'bike',
  bicycle: 'bike',
  tv_display: 'tv',
  computer: 'laptop',
  large_appliance: 'fridge',
  small_appliance: 'microwave',
  power_tool: 'drill',
  tool: 'tool_cart',
  box_bin: 'box',
  safe: 'cabinet',
  furniture: 'cabinet',
  generator: 'ac_unit',
};

/** A place kind's model when the name says nothing. */
const KIND_MODELS: Readonly<Record<string, MapModelKey>> = {
  closet: 'wardrobe',
  zone: 'zone',
  room: 'zone',
};

export type GuessInput = {
  name: string | null;
  subject: 'place' | 'thing';
  /** A place's kind key. */
  kindKey?: string | null;
  /** A thing's built-in type key (its own or its type's ancestor's). */
  typeKey?: string | null;
  isContainer?: boolean;
};

/**
 * The model a place or thing gets until someone picks one: from words in its name, then its
 * type or place kind, then storage for places and containers, a box for anything else.
 */
export function guessModel(input: GuessInput): MapModelKey {
  const name = (input.name ?? '').toLowerCase();
  for (const [re, key] of NAME_MODELS) if (re.test(name)) return key;
  if (input.subject === 'thing' && input.typeKey && TYPE_MODELS[input.typeKey]) {
    return TYPE_MODELS[input.typeKey] as MapModelKey;
  }
  if (input.subject === 'place') return KIND_MODELS[input.kindKey ?? ''] ?? 'metal_shelf';
  return input.isContainer ? 'box' : 'item';
}

/**
 * A floor's button: the first number in its name, in the digits it was written in ("Floor 2" →
 * "2", "الطابق ٢" → "٢"), else the first letter of its first word ("Ground floor" → "G",
 * "Roof" → "R"), else its position from the ground. An Arabic word's article ال is skipped:
 * nearly every Arabic floor name starts with it, so every button would read ا ("الطابق الأرضي"
 * → "ط", "السطح" → "س").
 */
export function levelShort(name: string | null, index: number): string {
  const n = (name ?? '').trim();
  const digits = /\p{Nd}+/u.exec(n);
  if (digits) return [...digits[0]].slice(0, 3).join('');
  const word = /\p{L}+/u.exec(n)?.[0] ?? '';
  const letter = word.length > 2 && word.startsWith('ال') ? word[2] : word[0];
  return letter ? letter.toLocaleUpperCase() : String(index);
}

/** Centimetres → metres, and back (layout is stored in whole centimetres). */
export const cmToM = (cm: number): number => cm / 100;
export const mToCm = (m: number): number => Math.round(m * 100);
