/**
 * The demo's words (D241), in English and Arabic: the shipped map's own strings and their
 * translations from apps/web/src/locales/{en,ar}/messages.po, so the demo reads like the app. A
 * few the app has no use for (the sample note, Reset) are the demo's own. The other docs
 * languages show the English demo, as they show the English pages.
 */
import type { MapModelKey, MapRoomKind, MapSurface, ShapeGroup } from '@kept/shared';

export type Lang = 'en' | 'ar';
/** English, then Arabic. */
export type Two = readonly [string, string];

export const MODEL_NAMES: Record<MapModelKey, Two> = {
  sofa: ['Sofa', 'أريكة'],
  armchair: ['Armchair', 'كرسي بذراعين'],
  coffee_table: ['Coffee table', 'طاولة قهوة'],
  tv_stand: ['TV stand', 'حامل تلفاز'],
  cube_shelf: ['Cube shelf', 'رف مكعبات'],
  tall_plant: ['Tall plant', 'نبتة طويلة'],
  plant: ['Plant', 'نبتة'],
  succulent: ['Succulent', 'نبتة عصارية'],
  dining_chair: ['Dining chair', 'كرسي سفرة'],
  drawers: ['Chest of drawers', 'خزانة أدراج'],
  bedside: ['Bedside table', 'طاولة جانب السرير'],
  metal_shelf: ['Metal shelf', 'رف معدني'],
  tool_cart: ['Tool cart', 'عربة أدوات'],
  drill: ['Drill', 'مثقاب'],
  cardboard: ['Moving box', 'صندوق نقل'],
  crate: ['Crate', 'صندوق بلاستيكي'],
  basket: ['Basket', 'سلة'],
  outdoor_set: ['Bistro set', 'طقم طاولة وكراسي'],
  monobloc: ['Plastic chair', 'كرسي بلاستيكي'],
  planter: ['Planter', 'حوض زرع'],
  planter_long: ['Long planter', 'حوض زرع طويل'],
  ac_unit: ['AC outdoor unit', 'وحدة مكيف خارجية'],
  watering_can: ['Watering can', 'مرشة ري'],
  tv: ['TV', 'تلفاز'],
  bookshelf: ['Bookshelf', 'مكتبة كتب'],
  lamp: ['Floor lamp', 'مصباح أرضي'],
  counter: ['Kitchen counter', 'سطح مطبخ'],
  sink: ['Sink counter', 'سطح بحوض'],
  fridge: ['Fridge', 'ثلاجة'],
  coffee_machine: ['Coffee machine', 'آلة قهوة'],
  microwave: ['Microwave', 'ميكروويف'],
  dining: ['Dining table', 'طاولة سفرة'],
  bed: ['Bed', 'سرير'],
  wardrobe: ['Wardrobe', 'خزانة ملابس'],
  table_lamp: ['Table lamp', 'مصباح طاولة'],
  desk: ['Desk', 'مكتب'],
  monitor: ['Monitor', 'شاشة'],
  laptop: ['Laptop', 'حاسوب محمول'],
  pc_tower: ['Desktop PC', 'كمبيوتر مكتبي'],
  keyboard: ['Keyboard', 'لوحة مفاتيح'],
  mouse: ['Mouse', 'فأرة'],
  webcam: ['Webcam', 'كاميرا ويب'],
  camera: ['Camera', 'كاميرا'],
  speaker: ['Desk speaker', 'سماعة مكتبية'],
  floor_speaker: ['Tall speaker', 'سماعة أرضية'],
  smart_speaker: ['Smart speaker', 'سماعة ذكية'],
  soundbar: ['Soundbar', 'ساوند بار'],
  headphones: ['Headphones', 'سماعات رأس'],
  router: ['Router', 'راوتر'],
  printer: ['Printer', 'طابعة'],
  console: ['Game console', 'جهاز ألعاب'],
  controller: ['Game controller', 'يد تحكم'],
  phone: ['Phone', 'هاتف'],
  tablet: ['Tablet', 'جهاز لوحي'],
  power_strip: ['Power strip', 'مشترك كهرباء'],
  external_drive: ['External drive', 'هارد خارجي'],
  device: ['Small device', 'جهاز صغير'],
  chair: ['Desk chair', 'كرسي مكتب'],
  cabinet: ['Filing cabinet', 'خزانة ملفات'],
  box: ['Storage box', 'صندوق تخزين'],
  washer: ['Washing machine', 'غسالة'],
  workbench: ['Workbench', 'طاولة عمل'],
  tool_wall: ['Tool wall', 'جدار الأدوات'],
  car: ['Car', 'سيارة'],
  bike: ['Bike', 'دراجة'],
  water_tank: ['Water tank', 'خزان مياه'],
  dish: ['Satellite dish', 'طبق استقبال'],
  stairs: ['Stairs', 'درج'],
  stairwell: ['Stairwell', 'بئر الدرج'],
  zone: ['Area', 'منطقة'],
  item: ['Small thing', 'شيء صغير'],
};

/** The shape picker's groups (D249). */
export const GROUP_NAMES: Record<ShapeGroup, Two> = {
  furniture: ['Furniture', 'أثاث'],
  storage: ['Storage', 'تخزين'],
  electronics: ['Electronics', 'إلكترونيات'],
  kitchen: ['Kitchen and laundry', 'المطبخ والغسيل'],
  tools: ['Tools', 'العدة'],
  outdoor: ['Plants and outdoor', 'نباتات وخارج المنزل'],
  vehicles: ['Vehicles', 'السيارات'],
  building: ['Stairs and areas', 'سلالم ومناطق'],
  other: ['Other', 'أخرى'],
};

export const ROOM_KIND_NAMES: Record<MapRoomKind, Two> = {
  room: ['Room', 'غرفة'],
  balcony: ['Balcony', 'شرفة'],
  terrace: ['Terrace', 'تراس'],
  garden: ['Garden', 'حديقة'],
};

export const SURFACE_NAMES: Record<MapSurface, Two> = {
  wood: ['Wood', 'خشب'],
  tile: ['Tiles', 'بلاط'],
  concrete: ['Concrete', 'خرسانة'],
  deck: ['Deck', 'ألواح خشبية'],
  grass: ['Grass', 'عشب'],
};

type Words = {
  sample: string;
  reset: string;
  install: string;
  mapOf: (name: string) => string;
  where: string;
  view: string;
  threeD: string;
  plan: string;
  arrange: string;
  done: string;
  pins: string;
  pin: Record<'low' | 'lent' | 'due', { long: string; short: string }>;
  arrangeTool: string;
  move: string;
  drawRoom: string;
  addFloor: string;
  cancel: string;
  hints: Record<'move' | 'room' | 'overlap', string>;
  floor: string;
  allFloors: string;
  all: string;
  zoomIn: string;
  zoomOut: string;
  turnLeft: string;
  turnRight: string;
  home: string;
  detailed: string;
  glError: string;
  placesHere: string;
  noFloor: string;
  roomN: (n: string) => string;
  floorN: (n: string) => string;
  engine: {
    onIt: (name: string) => string;
    more: (n: number) => string;
    inside: (n: number) => string;
    openFloor: string;
    changeFloor: string;
  };
  close: string;
  open: string;
  whatsHere: (n: string) => string;
  insideN: (n: string) => string;
  details: string;
  less: string;
  turn: string;
  takeOff: string;
  upTo: (name: string) => string;
  downTo: (name: string) => string;
  size: (w: string, d: string) => string;
  things: (n: number, f: string) => string;
  thingsInside: (n: number, f: string) => string;
  onHost: (name: string) => string;
  within: Record<'low' | 'lent' | 'due', (n: string) => string>;
  low: (remaining: string, min: string) => string;
  lentTo: (who: string) => string;
  lentBack: (who: string, back: string) => string;
  someone: string;
  dueOn: (what: string, when: string) => string;
  overdue: (what: string, when: string) => string;
  dueWord: string;
  facts: { quantity: string; brand: string; model: string; serial: string; condition: string };
  noPhoto: string;
  labelThing: string;
  labelPlace: string;
  onIt: string;
  findInside: (name: string) => string;
  findInsideLabel: string;
  nothingMatches: string;
  nothingYet: string;
  kind: string;
  surface: string;
  shape: string;
  /** D249: the card's shape line and the shape picker. */
  shapeLine: (shape: string, from: 'type' | 'name' | 'guess' | undefined) => string;
  change: string;
  pickShape: string;
  shapeFor: (name: string) => string;
  findShape: string;
  findShapeHint: string;
  shapes: string;
  suggested: string;
  noShape: (query: string) => string;
  putOnMap: string;
  findThingIn: (name: string) => string;
  findThingLabel: string;
  everythingOnMap: string;
};

/** Arabic plural forms (zero, one, two, few, many, other), as the app's catalogue writes them. */
function arPlural(n: number, f: string, forms: [string, string, string, string, string, string]) {
  const rule = new Intl.PluralRules('ar').select(n);
  const i = ['zero', 'one', 'two', 'few', 'many', 'other'].indexOf(rule);
  return (forms[i < 0 ? 5 : i] ?? '').replace('#', f);
}

export const WORDS: Record<Lang, Words> = {
  en: {
    sample: 'A sample home, in your browser. Nothing you change is saved or sent anywhere.',
    reset: 'Reset',
    install: 'Install Kept',
    mapOf: (name) => `Map of ${name}`,
    where: 'Where you are on the map',
    view: 'View',
    threeD: '3D',
    plan: 'Plan',
    arrange: 'Arrange',
    done: 'Done',
    pins: 'Pins',
    pin: {
      low: { long: 'Low stock', short: 'Low' },
      lent: { long: 'Lent out', short: 'Lent' },
      due: { long: 'Due soon', short: 'Due' },
    },
    arrangeTool: 'Arrange tool',
    move: 'Move',
    drawRoom: 'Draw a room',
    addFloor: 'Add a floor',
    cancel: 'Cancel',
    hints: {
      move: 'Drag anything to move it. Drop small things on a counter, desk, shelf or box. Drag a room’s amber corner to resize it.',
      room: 'Drag on empty ground to draw a new room on this floor.',
      overlap: 'Rooms can’t overlap. Draw on empty ground.',
    },
    floor: 'Floor',
    allFloors: 'All floors',
    all: 'All',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    turnLeft: 'Turn left',
    turnRight: 'Turn right',
    home: 'Show the whole floor',
    detailed: 'Detailed models',
    glError: 'This browser can’t draw the map.',
    placesHere: 'Places on this level',
    noFloor: 'Not on a floor',
    roomN: (n) => `Room ${n}`,
    floorN: (n) => `Floor ${n}`,
    engine: {
      onIt: (name) => `on it: ${name}`,
      more: (n) => `+${n} more`,
      inside: (n) => `${n} inside`,
      openFloor: 'click to open',
      changeFloor: 'click to change floor',
    },
    close: 'Close',
    open: 'Open',
    whatsHere: (n) => `What’s here · ${n}`,
    insideN: (n) => `Inside · ${n}`,
    details: 'Details',
    less: 'Less',
    turn: 'Turn',
    takeOff: 'Take off the map',
    upTo: (name) => `Up to ${name}`,
    downTo: (name) => `Down to ${name}`,
    size: (w, d) => `${w} × ${d} m`,
    things: (n, f) => (n === 1 ? `${f} thing` : `${f} things`),
    thingsInside: (n, f) => (n === 1 ? `${f} thing inside` : `${f} things inside`),
    onHost: (name) => `on ${name}`,
    within: {
      low: (n) => `${n} running low inside`,
      lent: (n) => `${n} lent out inside`,
      due: (n) => `${n} due inside`,
    },
    low: (remaining, min) => `${remaining} left, keep at least ${min}`,
    lentTo: (who) => `Lent to ${who}`,
    lentBack: (who, back) => `Lent to ${who}, back by ${back}`,
    someone: 'someone',
    dueOn: (what, when) => `${what}: due ${when}`,
    overdue: (what, when) => `${what}: overdue since ${when}`,
    dueWord: 'Due',
    facts: {
      quantity: 'Quantity',
      brand: 'Brand',
      model: 'Model',
      serial: 'Serial',
      condition: 'Condition',
    },
    noPhoto: 'No photo yet',
    labelThing: 'Label of this thing',
    labelPlace: 'Label of this place',
    onIt: 'On it',
    findInside: (name) => `Find inside ${name}`,
    findInsideLabel: 'Find inside',
    nothingMatches: 'Nothing matches.',
    nothingYet: 'Nothing in it yet.',
    kind: 'Kind',
    surface: 'Floor',
    shape: 'Shape',
    shapeLine: (shape, from) =>
      from === 'type'
        ? `Shape: ${shape}, from its type`
        : from === 'name'
          ? `Shape: ${shape}, from its name`
          : from === 'guess'
            ? `Shape: ${shape}, a guess`
            : `Shape: ${shape}`,
    change: 'Change',
    pickShape: 'Pick a shape',
    shapeFor: (name) => `Shape for ${name}`,
    findShape: 'Find a shape',
    findShapeHint: 'Find a shape: TV, shelf, box…',
    shapes: 'Shapes',
    suggested: 'Suggested',
    noShape: (q) =>
      `No shape matches “${q}”. Try Small thing or Small device, and give it a name that says what it is.`,
    putOnMap: 'Put on the map',
    findThingIn: (name) => `Find a thing in ${name}`,
    findThingLabel: 'Find a thing to put on the map',
    everythingOnMap: 'Everything here is on the map.',
  },
  ar: {
    sample: 'منزل تجريبي في متصفحك. لا يُحفظ أي شيء تغيّره ولا يُرسل إلى أي مكان.',
    reset: 'إعادة تعيين',
    install: 'ثبّت Kept',
    mapOf: (name) => `خريطة ${name}`,
    where: 'مكانك على الخريطة',
    view: 'العرض',
    threeD: 'ثلاثي الأبعاد',
    plan: 'مخطط',
    arrange: 'ترتيب',
    done: 'تم',
    pins: 'الدبابيس',
    pin: {
      low: { long: 'مخزون منخفض', short: 'منخفض' },
      lent: { long: 'مُعار', short: 'مُعار' },
      due: { long: 'يحين قريبًا', short: 'مستحق' },
    },
    arrangeTool: 'أداة الترتيب',
    move: 'نقل',
    drawRoom: 'ارسم غرفة',
    addFloor: 'أضف طابقًا',
    cancel: 'إلغاء',
    hints: {
      move: 'اسحب أي شيء لنقله. ضع الأشياء الصغيرة على سطح أو مكتب أو رف أو صندوق. اسحب الزاوية الكهرمانية للغرفة لتغيير حجمها.',
      room: 'اسحب على أرض فارغة لرسم غرفة جديدة في هذا الطابق.',
      overlap: 'لا يمكن أن تتداخل الغرف. ارسم على أرض فارغة.',
    },
    floor: 'الطابق',
    allFloors: 'كل الطوابق',
    all: 'الكل',
    zoomIn: 'تكبير',
    zoomOut: 'تصغير',
    turnLeft: 'تدوير لليسار',
    turnRight: 'تدوير لليمين',
    home: 'اعرض الطابق كاملًا',
    detailed: 'نماذج مفصّلة',
    glError: 'لا يستطيع هذا المتصفح رسم الخريطة.',
    placesHere: 'الأماكن في هذا الطابق',
    noFloor: 'ليست على طابق',
    roomN: (n) => `غرفة ${n}`,
    floorN: (n) => `الطابق ${n}`,
    engine: {
      onIt: (name) => `عليه: ${name}`,
      more: (n) => `+${n} أخرى`,
      inside: (n) => `${n} بداخله`,
      openFloor: 'انقر للفتح',
      changeFloor: 'انقر لتغيير الطابق',
    },
    close: 'إغلاق',
    open: 'افتح',
    whatsHere: (n) => `ما هنا · ${n}`,
    insideN: (n) => `بداخله · ${n}`,
    details: 'التفاصيل',
    less: 'أقل',
    turn: 'تدوير',
    takeOff: 'إزالة من الخريطة',
    upTo: (name) => `صعودًا إلى ${name}`,
    downTo: (name) => `نزولًا إلى ${name}`,
    size: (w, d) => `${w} × ${d} م`,
    things: (n, f) =>
      arPlural(n, f, ['لا أشياء', 'شيء واحد', 'شيئان', '# أشياء', '# شيئًا', '# شيء']),
    thingsInside: (n, f) =>
      arPlural(n, f, [
        'لا أشياء بداخله',
        'شيء واحد بداخله',
        'شيئان بداخله',
        '# أشياء بداخله',
        '# شيئًا بداخله',
        '# شيء بداخله',
      ]),
    onHost: (name) => `على ${name}`,
    within: {
      low: (n) => `${n} على وشك النفاد بداخله`,
      lent: (n) => `${n} مُعار من داخله`,
      due: (n) => `${n} مستحق بداخله`,
    },
    low: (remaining, min) => `بقي ${remaining}، والحد الأدنى ${min}`,
    lentTo: (who) => `مُعار إلى ${who}`,
    lentBack: (who, back) => `مُعار إلى ${who}، يعود بحلول ${back}`,
    someone: 'شخص ما',
    dueOn: (what, when) => `${what}: مستحق في ${when}`,
    overdue: (what, when) => `${what}: متأخر منذ ${when}`,
    dueWord: 'مستحق',
    facts: {
      quantity: 'الكمية',
      brand: 'العلامة التجارية',
      model: 'الطراز',
      serial: 'الرقم التسلسلي',
      condition: 'الحالة',
    },
    noPhoto: 'لا صورة بعد',
    labelThing: 'ملصق هذا الشيء',
    labelPlace: 'ملصق هذا المكان',
    onIt: 'عليه',
    findInside: (name) => `ابحث داخل ${name}`,
    findInsideLabel: 'ابحث بالداخل',
    nothingMatches: 'لا شيء يطابق.',
    nothingYet: 'لا شيء فيه بعد.',
    kind: 'النوع',
    surface: 'الأرضية',
    shape: 'الشكل',
    shapeLine: (shape, from) =>
      from === 'type'
        ? `الشكل: ${shape}، من نوعه`
        : from === 'name'
          ? `الشكل: ${shape}، من اسمه`
          : from === 'guess'
            ? `الشكل: ${shape}، تخمين`
            : `الشكل: ${shape}`,
    change: 'تغيير',
    pickShape: 'اختر شكلًا',
    shapeFor: (name) => `شكل ${name}`,
    findShape: 'ابحث عن شكل',
    findShapeHint: 'ابحث عن شكل: تلفاز، رف، صندوق…',
    shapes: 'الأشكال',
    suggested: 'مقترح',
    noShape: (q) =>
      `لا يوجد شكل يطابق «${q}». جرّب «شيء صغير» أو «جهاز صغير»، وأعطه اسمًا يقول ما هو.`,
    putOnMap: 'ضع على الخريطة',
    findThingIn: (name) => `ابحث عن شيء في ${name}`,
    findThingLabel: 'ابحث عن شيء لوضعه على الخريطة',
    everythingOnMap: 'كل ما هنا على الخريطة.',
  },
};

/** Numbers and dates as the app writes them (apps/web/src/lib/format.ts): Eastern digits in Arabic. */
export function formatter(lang: Lang) {
  const tag = lang === 'ar' ? 'ar-u-nu-arab' : 'en';
  const nf = new Intl.NumberFormat(tag);
  const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' });
  return {
    num: (n: number) => nf.format(n),
    day: (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number);
      return day.format(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)).replace(/ /g, ' ');
    },
  };
}
