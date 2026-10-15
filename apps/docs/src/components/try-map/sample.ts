/**
 * The sample home of the "Try the map" demo (D241): the approved spike's house (three floors,
 * thirteen rooms, what stands in them and what is inside), as the map's read answers it
 * (`MapView`, apps/web/src/api/map/types.ts), with every room and thing arranged. The shipped
 * map's own code turns it into a plan (layout.ts `planOf`) and draws it.
 *
 * Names are in English and Arabic; brands and model names stay as they are written. Dates are
 * days from today, so what is due stays due. Nothing here is anyone's real home.
 */
import {
  ALPHABET,
  type MapModelKey,
  type MapRoomKind,
  type MapSurface,
  mToCm,
  ROOM_KIND_SURFACE,
} from '@kept/shared';
import type {
  MapAttention,
  MapNodeView,
  MapRoomView,
  MapThingView,
  MapView,
} from '../../../../web/src/api/map/types';
import { type Lang, MODEL_NAMES, type Two } from './strings';

/** What a thing's Details show: the facts Kept would read from the thing. */
export type Facts = {
  brand?: string;
  model?: string;
  serial?: string;
  condition?: string;
  quantity?: number;
};

export type Sample = { view: MapView; facts: Map<string, Facts>; location: string };

type Due = { title: Two; days: number };
type Lent = { who: Two; days: number };
type Content = {
  name: Two;
  qty?: number;
  brand?: string;
  /** Keep at least this many: below it, the thing is low. */
  min?: number;
  lent?: Lent;
  due?: Due;
};
type Extra = {
  name?: Two;
  brand?: string;
  model?: string;
  serial?: string;
  cond?: Two;
  contents?: Content[];
  due?: Due;
  lent?: Lent;
};

const LIKE_NEW: Two = ['Like new', 'كالجديد'];
const GOOD: Two = ['Good', 'جيدة'];

/** A stable short ID from a seed (the spike's hash), in Kept's own alphabet. */
function codeFor(seed: string): string {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let out = '';
  for (let i = 0; i < 6; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out += ALPHABET[(h >>> 7) & 31];
  }
  return out;
}

/** Things that are places in Kept (shelves, cupboards, counters): drawn because they are there. */
const PLACES = new Set<MapModelKey>([
  'tv_stand',
  'bookshelf',
  'counter',
  'sink',
  'wardrobe',
  'desk',
  'cabinet',
  'cube_shelf',
  'metal_shelf',
  'workbench',
  'tool_wall',
  'tool_cart',
  'bedside',
  'drawers',
]);
/** Containers (things that hold things): drawn because they are there too. */
const CONTAINERS = new Set<MapModelKey>(['box', 'cardboard', 'crate', 'basket']);

const C = (name: Two, qty = 1, extra: Omit<Content, 'name' | 'qty'> = {}): Content => ({
  name,
  qty,
  ...extra,
});

export function sampleHome(lang: Lang, today: Date = new Date()): Sample {
  const pick = (two: Two) => (lang === 'ar' ? two[1] : two[0]);
  const dayOf = (days: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const levels = [
    { id: 'L0', name: pick(['Ground floor', 'أرضي']) },
    { id: 'L1', name: pick(['First floor', 'الطابق 1']) },
    { id: 'L2', name: pick(['Roof', 'سطح']) },
  ];

  const rooms: MapRoomView[] = [];
  const R = (
    id: string,
    levelId: string,
    name: Two,
    x: number,
    z: number,
    w: number,
    d: number,
    kind: MapRoomKind = 'room',
    surface: MapSurface = ROOM_KIND_SURFACE[kind],
  ) => {
    rooms.push({
      id,
      name: pick(name),
      shortCode: codeFor(`room:${id}`),
      levelId,
      kindKey: 'room',
      layout: { x: mToCm(x), z: mToCm(z), w: mToCm(w), d: mToCm(d), kind, surface },
    });
  };
  R('r1', 'L0', ['Living room', 'غرفة المعيشة'], 0, 0, 6, 5);
  R('r2', 'L0', ['Kitchen', 'المطبخ'], 7, 0, 5, 4, 'room', 'tile');
  R('r3', 'L0', ['Office', 'المكتب'], 13, 0, 4, 4);
  R('r4', 'L0', ['Garden', 'الحديقة'], 0, 6, 5, 5, 'garden');
  R('r5', 'L0', ['Laundry', 'غرفة الغسيل'], 6, 6, 3, 3, 'room', 'tile');
  R('r6', 'L0', ['Garage', 'المرآب'], 10, 5, 7, 6, 'room', 'concrete');
  R('r7', 'L1', ['Bedroom', 'غرفة النوم'], 0, 0, 4, 5);
  R('r8', 'L1', ['Balcony', 'الشرفة'], 0, 5, 4, 2, 'balcony');
  R('r9', 'L1', ['Landing', 'بسطة الدرج'], 4, 0, 2, 4);
  R('r10', 'L1', ['Guest room', 'غرفة الضيوف'], 6, 0, 5, 4);
  R('r11', 'L1', ['Storage room', 'غرفة التخزين'], 12, 0, 4, 4, 'room', 'concrete');
  R('r12', 'L2', ['Roof terrace', 'تراس السطح'], 0, 0, 9, 7, 'terrace');
  R('r13', 'L2', ['Roof room', 'غرفة السطح'], 10, 0, 3, 3, 'room', 'concrete');

  const nodes: MapNodeView[] = [];
  const things: MapThingView[] = [];
  const attention: MapAttention[] = [];
  const facts = new Map<string, Facts>();
  let n = 0;

  const due = (subjectId: string, d: Due) =>
    attention.push({
      subjectId,
      kind: 'due',
      title: pick(d.title),
      sourceType: 'schedule',
      state: d.days < 0 ? 'overdue' : 'due',
      dueOn: dayOf(d.days),
      person: null,
      quantity: null,
      min: null,
    });
  const lent = (subjectId: string, l: Lent) =>
    attention.push({
      subjectId,
      kind: 'lent',
      title: null,
      sourceType: null,
      state: null,
      dueOn: dayOf(l.days),
      person: pick(l.who),
      quantity: null,
      min: null,
    });

  type Node = { id: string; roomId: string; x: number; z: number };
  const add = (
    roomId: string,
    model: MapModelKey,
    x: number,
    z: number,
    rot = 0,
    extra: Extra = {},
    hostId: string | null = null,
  ): Node => {
    const id = `n${++n}`;
    const name = extra.name ? pick(extra.name) : pick(MODEL_NAMES[model]);
    const place = PLACES.has(model);
    const container = CONTAINERS.has(model);
    const shortCode = codeFor(`${roomId}:${extra.name?.[0] ?? model}:${model}:${x}:${z}`);
    nodes.push({
      id,
      subject: place ? 'place' : 'thing',
      name,
      shortCode,
      roomId,
      parentId: roomId,
      kindKey: place ? 'shelf' : null,
      typeKey: null,
      isContainer: container,
      quantity: 1,
      layout: { x: mToCm(x), z: mToCm(z), rot, model, hostId },
    });
    if (!place)
      things.push({
        id,
        name,
        shortCode,
        quantity: 1,
        parentId: roomId,
        typeKey: null,
        typeName: null,
        isContainer: container,
      });
    facts.set(id, {
      ...(extra.brand ? { brand: extra.brand } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.serial ? { serial: extra.serial } : {}),
      ...(extra.cond ? { condition: pick(extra.cond) } : {}),
    });
    if (extra.due) due(id, extra.due);
    if (extra.lent) lent(id, extra.lent);
    (extra.contents ?? []).forEach((c, i) => {
      const cid = `${id}c${i + 1}`;
      const qty = c.qty ?? 1;
      things.push({
        id: cid,
        name: pick(c.name),
        shortCode: codeFor(`${shortCode}:${i}:${c.name[0]}`),
        quantity: qty,
        parentId: id,
        typeKey: null,
        typeName: null,
        isContainer: false,
      });
      facts.set(cid, { quantity: qty, ...(c.brand ? { brand: c.brand } : {}) });
      if (c.min !== undefined && qty < c.min) {
        attention.push({
          subjectId: cid,
          kind: 'low',
          title: null,
          sourceType: null,
          state: null,
          dueOn: null,
          person: null,
          quantity: qty,
          min: c.min,
        });
      }
      if (c.lent) lent(cid, c.lent);
      if (c.due) due(cid, c.due);
    });
    return { id, roomId, x, z };
  };
  /** Something standing on `host`, `dx`/`dz` metres from the host's corner. */
  const on = (host: Node, model: MapModelKey, dx: number, dz: number, extra: Extra = {}) =>
    add(host.roomId, model, host.x + dx, host.z + dz, 0, extra, host.id);

  // ---- Ground floor · Living room ------------------------------------------------------------
  const stand = add('r1', 'tv_stand', 1.6, 0.15, 0, {
    brand: 'Home Centre',
    contents: [
      C(['PS5 controller', 'يد تحكم PS5'], 2, { brand: 'Sony' }),
      C(['HDMI cable 2 m', 'كابل HDMI ‏2 م'], 3),
      C(['Apple TV remote', 'ريموت Apple TV'], 1, { brand: 'Apple' }),
      C(['Soundbar remote', 'ريموت مكبر الصوت']),
      C(['Blu-ray: Dune', 'بلو راي: Dune']),
      C(['AA batteries', 'بطاريات AA'], 4, { min: 6 }),
    ],
  });
  on(stand, 'tv', 0.6, 0.12, {
    name: ['Samsung TV', 'تلفاز Samsung'],
    brand: 'Samsung',
    model: 'QA55Q60C, 55″',
    serial: 'Q60C-0X55-7731',
    cond: LIKE_NEW,
    due: { title: ['Register the warranty', 'تسجيل الضمان'], days: 13 },
  });
  add('r1', 'sofa', 1.9, 3.7, 180, { brand: 'Chesterfield', model: 'Leather 2-seat', cond: GOOD });
  const table = add('r1', 'coffee_table', 2.2, 2.6, 0, { brand: 'IKEA', model: 'Lisabo' });
  on(table, 'succulent', 0.15, 0.2, { name: ['Haworthia', 'هاوورثيا'] });
  add('r1', 'armchair', 0.2, 2.0, 270, { brand: 'Kave Home' });
  add('r1', 'bookshelf', 4.5, 0.15, 0, {
    brand: 'IKEA',
    model: 'Billy',
    contents: [
      C(['The Pragmatic Programmer', 'The Pragmatic Programmer']),
      C(['Atomic Habits', 'العادات الذرية']),
      C(['Dune', 'كثيب']),
      C(['Children of Dune', 'أطفال الكثيب']),
      C(['Sapiens', 'العاقل']),
      C(['Thinking, Fast and Slow', 'التفكير السريع والبطيء']),
      C(['Cairo Trilogy', 'الثلاثية'], 3, { brand: 'Naguib Mahfouz' }),
      C(['Photo album 2019', 'ألبوم صور 2019']),
      C(['Photo album 2022', 'ألبوم صور 2022']),
      C(['National Geographic', 'ناشيونال جيوغرافيك'], 12),
    ],
  });
  add('r1', 'tall_plant', 0.2, 0.2, 0, {
    due: { title: ['Water the plant', 'سقي النبتة'], days: 1 },
  });
  add('r1', 'lamp', 5.4, 4.4, 0, { brand: 'IKEA', model: 'Hektar' });
  add('r1', 'box', 0.3, 4.4, 0, {
    name: ['Games box', 'صندوق الألعاب'],
    contents: [
      C(['Catan', 'كاتان'], 1, { lent: { who: ['Bruce', 'بروس'], days: 5 } }),
      C(['Monopoly', 'مونوبولي']),
      C(['Uno', 'أونو']),
      C(['Chess set', 'طقم شطرنج']),
      C(['Jenga', 'جينغا']),
      C(['Playing cards', 'ورق لعب'], 2),
    ],
  });
  add('r1', 'stairs', 4.9, 1.0, 0, { name: ['Stairs up', 'الدرج للأعلى'] });

  // ---- Kitchen -------------------------------------------------------------------------------
  const counter = add('r2', 'counter', 0.15, 0.12, 0, {
    name: ['Counter by the window', 'السطح عند النافذة'],
    contents: [
      C(['Knife set', 'طقم سكاكين'], 1, { brand: 'Zwilling' }),
      C(['Cutting board', 'لوح تقطيع'], 3),
      C(['Blender', 'خلاط'], 1, { brand: 'Moulinex' }),
      C(['Toaster', 'محمصة خبز'], 1, { brand: 'Philips' }),
      C(['Electric kettle', 'غلاية كهربائية'], 1, { brand: 'Tefal' }),
      C(['Spice jars', 'برطمانات بهارات'], 12),
    ],
  });
  add('r2', 'sink', 2.0, 0.12, 0, {
    contents: [
      C(['Dish soap', 'سائل جلي'], 1, { min: 2 }),
      C(['Sponges', 'إسفنج'], 6),
      C(['Bin bags (rolls)', 'أكياس قمامة (لفّات)'], 2),
      C(['Kitchen spray', 'بخاخ تنظيف المطبخ'], 2),
    ],
  });
  on(counter, 'coffee_machine', 0.3, 0.1, {
    name: ['Espresso machine', 'آلة إسبريسو'],
    brand: "De'Longhi",
    model: 'Dedica EC685',
    serial: 'EC685-2403-118',
    due: { title: ['Descale', 'إزالة الترسبات'], days: 6 },
  });
  on(counter, 'microwave', 1.05, 0.15, { brand: 'Sharp', model: 'R-20A' });
  add('r2', 'fridge', 4.1, 0.12, 0, {
    brand: 'LG',
    model: 'GN-B392PLGB',
    serial: 'LG392-118-0457',
    due: { title: ['Change the water filter', 'تغيير فلتر الماء'], days: 19 },
  });
  add('r2', 'dining', 1.8, 2.2, 0, { brand: 'Home Centre' });
  for (const [x, z, r] of [
    [2.05, 1.7, 0],
    [2.92, 1.7, 0],
    [2.05, 3.0, 180],
    [2.92, 3.0, 180],
  ] as const) {
    add('r2', 'dining_chair', x, z, r, { brand: 'Home Centre' });
  }
  add('r2', 'wardrobe', 0.15, 1.5, 270, {
    name: ['Pantry', 'خزانة المؤن'],
    contents: [
      C(['Rice 5 kg', 'أرز 5 كغ'], 2),
      C(['Pasta', 'مكرونة'], 6),
      C(['Olive oil 1 L', 'زيت زيتون 1 لتر'], 2),
      C(['Coffee beans 1 kg', 'بن 1 كغ'], 1, { min: 2 }),
      C(['Lentils', 'عدس'], 3),
      C(['Sugar 1 kg', 'سكر 1 كغ'], 2),
      C(['Tea boxes', 'علب شاي'], 3),
    ],
  });

  // ---- Office --------------------------------------------------------------------------------
  const desk = add('r3', 'desk', 1.4, 0.15, 0, {
    brand: 'Flexispot',
    model: 'E7',
    contents: [
      C(['Notebooks', 'دفاتر'], 4),
      C(['Pens', 'أقلام'], 12),
      C(['Stapler', 'دبّاسة']),
      C(['USB-C charger 65 W', 'شاحن USB-C ‏65 واط'], 2, { brand: 'Anker' }),
      C(['Passport folder', 'ملف جوازات السفر']),
    ],
  });
  on(desk, 'monitor', 0.4, 0.08, {
    name: ['Dell monitor', 'شاشة Dell'],
    brand: 'Dell',
    model: 'U2723QE, 27″',
    serial: 'CN-0U27-23QE',
  });
  on(desk, 'laptop', 1.0, 0.35, {
    name: ['MacBook Air', 'MacBook Air'],
    brand: 'Apple',
    model: 'M3, 15″',
    serial: 'FVFG2M3LQ6L4',
    cond: LIKE_NEW,
  });
  add('r3', 'chair', 1.75, 1.0, 0, { brand: 'Herman Miller', model: 'Sayl' });
  add('r3', 'cabinet', 0.15, 0.15, 0, {
    contents: [
      C(['Car papers', 'أوراق السيارة']),
      C(['Apartment lease', 'عقد إيجار الشقة'], 1, {
        due: { title: ['Renew the lease', 'تجديد عقد الإيجار'], days: 15 },
      }),
      C(['Tax return 2025', 'الإقرار الضريبي 2025']),
      C(['Warranty cards', 'بطاقات ضمان'], 14),
      C(['Bank statements', 'كشوف حساب بنكية']),
    ],
  });
  add('r3', 'cube_shelf', 0.15, 1.2, 270, {
    contents: [
      C(['Printer paper (reams)', 'ورق طابعة (رزم)'], 3),
      C(['Ink cartridges', 'خراطيش حبر'], 1, { min: 2 }),
      C(['Label tape', 'شريط ملصقات'], 3, { brand: 'Brother' }),
      C(['External drive 2 TB', 'قرص خارجي 2 تيرابايت'], 1, { brand: 'Samsung' }),
    ],
  });
  add('r3', 'box', 3.2, 3.45, 0, {
    name: ['Cable box', 'صندوق الكابلات'],
    contents: [
      C(['HDMI cable', 'كابل HDMI'], 4),
      C(['USB-C cable', 'كابل USB-C'], 6),
      C(['Ethernet cable', 'كابل إيثرنت'], 3),
      C(['Travel adapter', 'محوّل سفر'], 2, { lent: { who: ['Louis', 'لويس'], days: 10 } }),
    ],
  });

  // ---- Garden --------------------------------------------------------------------------------
  add('r4', 'planter_long', 0.3, 0.2, 0, {
    name: ['Herb planter', 'حوض الأعشاب'],
    due: { title: ['Water the basil', 'سقي الريحان'], days: 0 },
  });
  add('r4', 'planter', 2.1, 0.2, 0, { name: ['Tomato planter', 'حوض الطماطم'] });
  add('r4', 'plant', 4.0, 3.9, 0, { name: ['Olive tree', 'شجرة زيتون'] });
  add('r4', 'monobloc', 2.4, 2.4, 0);
  add('r4', 'watering_can', 4.2, 0.3, 0);

  // ---- Laundry -------------------------------------------------------------------------------
  add('r5', 'washer', 0.2, 0.15, 0, {
    brand: 'Samsung',
    model: 'WW90T, 9 kg',
    due: { title: ['Clean the filter', 'تنظيف الفلتر'], days: 4 },
  });
  add('r5', 'metal_shelf', 1.0, 0.15, 0, {
    name: ['Laundry shelf', 'رف الغسيل'],
    contents: [
      C(['Detergent', 'مسحوق غسيل'], 1, { min: 2 }),
      C(['Softener', 'منعّم أقمشة'], 2),
      C(['Stain remover', 'مزيل بقع']),
      C(['Laundry bag', 'كيس غسيل'], 3),
    ],
  });
  add('r5', 'basket', 1.8, 0.2, 0, {
    name: ['Peg basket', 'سلة المشابك'],
    contents: [C(['Clothes pegs', 'مشابك غسيل'], 40)],
  });
  add('r5', 'box', 2.1, 2.3, 0, {
    name: ['Iron and board', 'المكواة وطاولتها'],
    contents: [
      C(['Steam iron', 'مكواة بخار'], 1, { brand: 'Philips' }),
      C(['Ironing board', 'طاولة كيّ']),
    ],
  });

  // ---- Garage --------------------------------------------------------------------------------
  add('r6', 'car', 0.6, 0.9, 0, {
    name: ['Toyota Corolla', 'تويوتا كورولا'],
    brand: 'Toyota',
    model: 'Corolla 1.6, 2019',
    due: { title: ['60,000 km service', 'صيانة 60,000 كم'], days: 14 },
  });
  add('r6', 'bike', 3.0, 1.4, 0, { brand: 'Trinx', model: 'M136, 27.5″' });
  const bench = add('r6', 'workbench', 4.6, 0.3, 0, {
    contents: [
      C(['Screw assortment', 'تشكيلة براغي']),
      C(['Wood glue', 'غراء خشب']),
      C(['Sandpaper pack', 'عبوة ورق صنفرة']),
      C(['Measuring tape', 'شريط قياس'], 2, { brand: 'Stanley' }),
      C(['Safety glasses', 'نظارات واقية']),
    ],
  });
  on(bench, 'drill', 0.6, 0.3, {
    name: ['Bosch drill', 'مثقاب Bosch'],
    brand: 'Bosch',
    model: 'GSR 12V-15',
    lent: { who: ['Bruce', 'بروس'], days: 2 },
  });
  add('r6', 'tool_wall', 4.7, 0.12, 0, {
    contents: [
      C(['Claw hammer', 'مطرقة']),
      C(['Screwdriver set', 'طقم مفكات'], 1, { brand: 'Wera' }),
      C(['Adjustable wrench', 'مفتاح إنجليزي']),
      C(['Hand saw', 'منشار يدوي']),
      C(['Pliers', 'كمّاشة'], 2),
      C(['Spirit level', 'ميزان ماء']),
      C(['Allen keys set', 'طقم مفاتيح ألن']),
    ],
  });
  add('r6', 'tool_cart', 5.5, 2.0, 0, {
    contents: [
      C(['Socket set', 'طقم لقم'], 1, { brand: 'Bosch' }),
      C(['Tyre gauge', 'مقياس ضغط الإطارات']),
      C(['Jump leads', 'كابلات اشتراك']),
      C(['Car wax', 'شمع السيارة'], 1, { min: 2 }),
      C(['Microfibre cloths', 'مناشف مايكروفايبر'], 6),
    ],
  });
  add('r6', 'metal_shelf', 5.6, 5.4, 180, {
    name: ['Garage shelf', 'رف المرآب'],
    contents: [
      C(['Engine oil 4 L', 'زيت محرك 4 لتر'], 1, { min: 2 }),
      C(['Coolant', 'سائل تبريد']),
      C(['Spare bulbs', 'لمبات احتياطية'], 4),
      C(['Bike pump', 'منفاخ دراجة']),
    ],
  });
  add('r6', 'crate', 4.9, 5.45, 0, {
    name: ['Camping crate', 'صندوق التخييم'],
    contents: [
      C(['Tent', 'خيمة'], 1, { brand: 'Coleman' }),
      C(['Sleeping bag', 'كيس نوم'], 2),
      C(['Camping stove', 'موقد تخييم']),
      C(['Head torch', 'كشاف رأس'], 2),
    ],
  });
  add('r6', 'box', 2.6, 5.4, 0, {
    name: ['Paint box', 'صندوق الدهان'],
    contents: [
      C(['Wall paint, white', 'دهان حوائط أبيض'], 1, { min: 2 }),
      C(['Brushes', 'فُرش'], 4),
      C(['Roller', 'رولة دهان']),
      C(['Masking tape', 'شريط لاصق ورقي'], 3),
    ],
  });
  add('r6', 'box', 3.3, 5.4, 0, {
    name: ['Holiday box', 'صندوق الزينة'],
    contents: [
      C(['String lights', 'أضواء زينة'], 3),
      C(['Lanterns', 'فوانيس'], 4),
      C(['Banners', 'لافتات'], 2),
    ],
  });

  // ---- First floor · Bedroom -----------------------------------------------------------------
  add('r7', 'bed', 1.15, 0.15, 0, { brand: 'IKEA', model: 'Malm, 160 cm' });
  const bedside = add('r7', 'bedside', 0.55, 0.15, 0, {
    contents: [
      C(['Kindle', 'Kindle'], 1, { brand: 'Amazon' }),
      C(['Reading glasses', 'نظارة قراءة']),
      C(['Phone charger', 'شاحن هاتف']),
      C(['Hand cream', 'كريم يدين']),
    ],
  });
  on(bedside, 'table_lamp', 0.12, 0.07);
  add('r7', 'bedside', 2.9, 0.15, 0, {
    contents: [C(['Notebook', 'دفتر']), C(['Earplugs', 'سدادات أذن'], 6)],
  });
  add('r7', 'wardrobe', 2.3, 4.3, 180, {
    brand: 'IKEA',
    model: 'Pax',
    contents: [
      C(['Winter jacket', 'جاكيت شتوي'], 3),
      C(['Suit', 'بدلة'], 2),
      C(['Bed linen set', 'طقم مفارش سرير'], 4),
      C(['Shoes (pairs)', 'أحذية (أزواج)'], 8),
      C(['Small suitcase', 'حقيبة سفر صغيرة'], 1, { brand: 'Samsonite' }),
    ],
  });
  add('r7', 'drawers', 0.12, 2.6, 270, {
    contents: [
      C(['T-shirts', 'تيشيرتات'], 14),
      C(['Socks (pairs)', 'جوارب (أزواج)'], 20),
      C(['Gym kit', 'ملابس رياضة'], 3),
      C(['Watch box', 'علبة ساعات'], 1, { brand: 'Casio' }),
    ],
  });
  add('r7', 'basket', 0.8, 4.5, 0, {
    name: ['Laundry basket', 'سلة الغسيل'],
    contents: [C(['Towels', 'مناشف'], 3)],
  });
  add('r7', 'plant', 3.1, 2.4, 0, { name: ['Snake plant', 'نبتة الثعبان'] });

  // ---- Balcony -------------------------------------------------------------------------------
  add('r8', 'monobloc', 0.4, 0.4, 0);
  add('r8', 'monobloc', 1.2, 0.4, 0);
  add('r8', 'planter', 2.9, 1.4, 0, {
    name: ['Jasmine planter', 'حوض الياسمين'],
    due: { title: ['Feed the jasmine', 'تسميد الياسمين'], days: 10 },
  });

  // ---- Landing -------------------------------------------------------------------------------
  add('r9', 'stairwell', 0.9, 1.0, 0, { name: ['Stairs', 'الدرج'] });

  // ---- Guest room ----------------------------------------------------------------------------
  add('r10', 'bed', 1.6, 0.15, 0, {
    name: ['Guest bed', 'سرير الضيوف'],
    brand: 'IKEA',
    model: 'Malm, 160 cm',
  });
  add('r10', 'bedside', 1.0, 0.15, 0, {
    contents: [
      C(['Spare keys', 'مفاتيح احتياطية'], 2),
      C(['Guest wifi card', 'بطاقة واي فاي للضيوف']),
    ],
  });
  add('r10', 'wardrobe', 3.4, 3.3, 180, {
    name: ['Guest wardrobe', 'خزانة الضيوف'],
    contents: [
      C(['Spare duvet', 'لحاف احتياطي']),
      C(['Winter blanket', 'بطانية شتوية'], 2),
      C(['Pillows', 'وسائد'], 4),
    ],
  });
  add('r10', 'armchair', 0.2, 2.8, 0, { brand: 'Kave Home' });

  // ---- Storage room --------------------------------------------------------------------------
  add('r11', 'metal_shelf', 0.15, 0.15, 0, {
    name: ['Shelf A', 'الرف أ'],
    contents: [
      C(['Light bulbs E27', 'لمبات E27'], 6),
      C(['Batteries AA', 'بطاريات AA'], 8, { min: 12 }),
      C(['Extension lead', 'وصلة كهرباء'], 3),
      C(['First-aid kit', 'حقيبة إسعافات أولية']),
    ],
  });
  add('r11', 'metal_shelf', 0.85, 0.15, 0, {
    name: ['Shelf B', 'الرف ب'],
    contents: [
      C(['Toilet paper (packs)', 'مناديل حمّام (عبوات)'], 2, { min: 3 }),
      C(['Kitchen roll', 'مناديل مطبخ'], 4),
      C(['Cleaning spray', 'بخاخ تنظيف'], 3),
    ],
  });
  add('r11', 'metal_shelf', 1.55, 0.15, 0, {
    name: ['Shelf C', 'الرف ج'],
    contents: [
      C(['Suitcase, large', 'حقيبة سفر كبيرة'], 1, { brand: 'Samsonite' }),
      C(['Travel pillow', 'وسادة سفر'], 2),
      C(['Luggage scale', 'ميزان حقائب']),
    ],
  });
  const moving = add('r11', 'cardboard', 0.4, 2.6, 0, {
    name: ['Moving box 1', 'صندوق النقل 1'],
    contents: [
      C(['Old phones', 'هواتف قديمة'], 3),
      C(['Chargers', 'شواحن'], 7),
      C(['Manuals', 'كتيبات تعليمات'], 11),
    ],
  });
  on(moving, 'cardboard', 0, 0, {
    name: ['Moving box 2', 'صندوق النقل 2'],
    contents: [C(['Winter scarves', 'أوشحة شتوية'], 5), C(['Gloves (pairs)', 'قفازات (أزواج)'], 3)],
  });
  add('r11', 'cardboard', 1.0, 2.6, 0, {
    name: ['Moving box 3', 'صندوق النقل 3'],
    contents: [C(['Baby clothes', 'ملابس أطفال'], 18), C(['Toys', 'ألعاب'], 9)],
  });
  add('r11', 'crate', 2.6, 0.2, 0, {
    name: ['Tools crate', 'صندوق العدة'],
    contents: [
      C(['Spare tiles', 'بلاط احتياطي'], 12),
      C(['Grout', 'روبة']),
      C(['Silicone gun', 'مسدس سيليكون']),
    ],
  });

  // ---- Roof ----------------------------------------------------------------------------------
  add('r12', 'water_tank', 0.3, 0.3, 0, {
    name: ['Water tank 1', 'خزان المياه 1'],
    model: '1,000 L',
    due: { title: ['Clean the tank', 'تنظيف الخزان'], days: 17 },
  });
  add('r12', 'water_tank', 1.6, 0.3, 0, {
    name: ['Water tank 2', 'خزان المياه 2'],
    model: '1,000 L',
  });
  add('r12', 'ac_unit', 3.2, 0.15, 0, {
    name: ['AC unit, living room', 'وحدة تكييف غرفة المعيشة'],
    brand: 'Carrier',
    model: 'Optimax 2.25 HP',
    due: { title: ['Clean the filters', 'تنظيف الفلاتر'], days: 15 },
  });
  add('r12', 'ac_unit', 5.3, 0.15, 0, {
    name: ['AC unit, bedroom', 'وحدة تكييف غرفة النوم'],
    brand: 'Sharp',
    model: 'AH-A12 1.5 HP',
  });
  add('r12', 'dish', 7.8, 0.3, 0, { model: '90 cm' });
  add('r12', 'outdoor_set', 4.0, 3.8, 0);
  add('r12', 'monobloc', 3.3, 5.2, 0);
  add('r12', 'monobloc', 6.1, 5.2, 0);
  add('r12', 'planter_long', 0.3, 6.3, 0, { name: ['Mint planter', 'حوض النعناع'] });
  add('r12', 'tall_plant', 8.2, 6.2, 0, { name: ['Bougainvillea', 'جهنمية'] });
  add('r12', 'watering_can', 2.0, 6.4, 0);
  add('r13', 'metal_shelf', 0.15, 0.15, 0, {
    name: ['Roof shelf', 'رف السطح'],
    contents: [
      C(['Spare tap washers', 'جلب حنفيات احتياطية'], 10),
      C(['PVC pipe glue', 'غراء مواسير PVC']),
      C(['Tank float valve', 'عوّامة الخزان']),
      C(['Rope 20 m', 'حبل 20 م']),
    ],
  });
  add('r13', 'crate', 1.0, 0.2, 0, {
    name: ['Plant crate', 'صندوق الزراعة'],
    contents: [
      C(['Potting soil 20 L', 'تربة زراعة 20 لتر'], 1, { min: 2 }),
      C(['Plant food', 'سماد نباتات']),
      C(['Secateurs', 'مقص تقليم'], 1, { brand: 'Fiskars' }),
    ],
  });
  add('r13', 'cardboard', 1.0, 1.6, 0, {
    name: ['Old fans box', 'صندوق المراوح القديمة'],
    contents: [C(['Desk fan', 'مروحة مكتب'], 2), C(['Fan remote', 'ريموت المروحة'])],
  });

  return {
    view: {
      locationId: 'sample',
      canArrange: true,
      version: null,
      levels,
      rooms,
      nodes,
      things,
      more: 0,
      attention,
    },
    facts,
    location: pick(['Sample home', 'منزل تجريبي']),
  };
}
